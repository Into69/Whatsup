package dev.whatsup.app

import android.content.Context
import android.graphics.BitmapFactory
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.tan

/**
 * The skyline around a place, for sky view and the in-view list (skyline.js): for each azimuth, how
 * far above the horizontal the hills and mountains reach, and how far away that ridge is.
 *
 * From Terrain Tiles (Mapzen's terrarium encoding, on AWS Open Data): elevation as colour in map
 * tiles, finer near the user and coarser further out, where a pixel is a smaller angle anyway. The
 * tiles are kept on disk, so a place seen once works offline; a skyline needs about 1–2 MB of them.
 * Blocking: call off the main thread.
 */
class Skyline(context: Context) {
    private val dir = File(context.cacheDir, "terrain")
    /** Decoded tiles, elevations in metres, by zoom, x and y packed in a Long; the most recently used kept. */
    private val tiles = object : LinkedHashMap<Long, ShortArray>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, ShortArray>) = size > MAX_TILES_IN_MEMORY
    }
    /** Tiles that couldn't be had this time, not asked for again until the next skyline. */
    private val missing = HashSet<Long>()
    private var last: Pair<String, ByteArray>? = null

    /**
     * { lat, lon, groundM, step (degrees of azimuth), angles: [degrees above the horizontal, per step
     * from north], distancesKm: [to that ridge] }, or { error } if the terrain round here can't be had.
     */
    @Synchronized
    fun load(lat: Double, lon: Double): ByteArray {
        val key = "%.4f,%.4f".format(java.util.Locale.ROOT, lat, lon)
        last?.takeIf { it.first == key }?.let { return it.second }
        return try {
            missing.clear()
            fetchAround(lat, lon)
            val json = compute(lat, lon, ::elevation)?.toString()?.toByteArray() ?: AircraftFeed.error("unavailable")
            json.also { last = key to it }
        } catch (e: Exception) {
            Log.w(TAG, "No skyline at $key", e)
            AircraftFeed.error(if (Http.offline) "offline" else "unavailable")
        }
    }

    /** Gets the tiles a skyline here needs onto disk, several at once; those already there are kept. */
    private fun fetchAround(lat: Double, lon: Double) {
        val wanted = BANDS.flatMap { band ->
            val degreesLat = band.maxKm / 111.0
            val degreesLon = band.maxKm / (111.0 * max(cos(lat * PI / 180), 0.05))
            val (x0, y1) = tileOf(lat - degreesLat, lon - degreesLon, band.zoom)
            val (x1, y0) = tileOf(lat + degreesLat, lon + degreesLon, band.zoom)
            val n = 1 shl band.zoom
            (y0..y1).filter { it in 0 until n }.flatMap { y -> (x0..x1).map { x -> Triple(band.zoom, Math.floorMod(x, n), y) } }
        }.filterNot { (z, x, y) -> file(z, x, y).exists() }
        if (wanted.isEmpty() || Http.offline) return
        val pool = Executors.newFixedThreadPool(PARALLEL_FETCHES)
        try {
            wanted.map { (z, x, y) ->
                pool.submit {
                    try {
                        val bytes = Http.getBytes("$TILES/$z/$x/$y.png", readTimeoutMs = 20_000)
                        val file = file(z, x, y)
                        file.parentFile?.mkdirs()
                        // Written whole, then renamed, so a half-written tile is never read.
                        val part = File(file.path + ".part")
                        part.writeBytes(bytes)
                        part.renameTo(file)
                    } catch (e: Exception) {
                        Log.w(TAG, "No terrain tile $z/$x/$y", e)
                    }
                }
            }.forEach { it.get() }
        } finally {
            pool.shutdown()
        }
    }

    /** Ground elevation in metres (the sea's surface at sea) at a place, from tiles fine enough for `distanceM` off. */
    private fun elevation(lat: Double, lon: Double, distanceM: Double): Double? =
        sample(lat, lon, BANDS.first { distanceM <= it.maxKm * 1000 || it === BANDS.last() }.zoom, ::tile)

    private fun tile(z: Int, x: Int, y: Int): ShortArray? {
        // A number, not a string: this is asked hundreds of thousands of times a skyline.
        val key = (z.toLong() shl 48) or (x.toLong() shl 24) or y.toLong()
        tiles[key]?.let { return it }
        if (key in missing) return null
        val bitmap = file(z, x, y).takeIf { it.exists() }?.readBytes()?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        if (bitmap == null || bitmap.width != TILE_SIZE || bitmap.height != TILE_SIZE) {
            missing += key
            return null
        }
        val pixels = IntArray(TILE_SIZE * TILE_SIZE)
        bitmap.getPixels(pixels, 0, TILE_SIZE, 0, 0, TILE_SIZE, TILE_SIZE)
        bitmap.recycle()
        val heights = terrarium(pixels)
        tiles[key] = heights
        return heights
    }

    private fun file(z: Int, x: Int, y: Int) = File(dir, "$z/$x/$y.png")

    companion object {
        private const val TAG = "Skyline"
        private const val TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
        private const val TILE_SIZE = 256
        private const val PARALLEL_FETCHES = 6
        private const val MAX_TILES_IN_MEMORY = 80

        /** Which zoom of tiles out to how far: about 30, 120 and 500 m a pixel at mid latitudes. */
        private class Band(val zoom: Int, val maxKm: Double)
        private val BANDS = listOf(Band(12, 8.0), Band(10, 40.0), Band(8, MAX_KM))

        const val MAX_KM = 150.0
        /** Azimuth step of the profile, degrees. */
        const val STEP_DEGREES = 0.5
        /** The eye, above the ground. */
        const val EYE_HEIGHT_M = 1.7
        private const val EARTH_RADIUS_M = 6_371_000.0
        /** How much light bends round the Earth, as a share of its curvature (the usual 0.13). */
        private const val REFRACTION = 0.13
        private const val FIRST_STEP_M = 20.0
        /** Steps grow with the distance, as a share of it: the angle a step spans stays about the same. */
        private const val STEP_SHARE = 0.012

        /**
         * The skyline at (lat, lon), with `elevation(lat, lon, distanceM)` giving the ground's height
         * there in metres, or null where unknown: for each azimuth step, the highest angle any
         * ground out to MAX_KM reaches above the horizontal (curvature and refraction allowed for).
         * Null if the ground here is unknown.
         */
        internal fun compute(lat: Double, lon: Double, elevation: (Double, Double, Double) -> Double?): JSONObject? {
            val ground = elevation(lat, lon, 0.0) ?: return null
            val eye = ground + EYE_HEIGHT_M
            val phi = lat * PI / 180
            val lambda = lon * PI / 180
            val steps = (360 / STEP_DEGREES).toInt()
            val angles = JSONArray()
            val distances = JSONArray()
            for (i in 0 until steps) {
                val bearing = i * STEP_DEGREES * PI / 180
                var best = -90.0
                var bestM = 0.0
                var d = FIRST_STEP_M
                while (d <= MAX_KM * 1000) {
                    val delta = d / EARTH_RADIUS_M
                    val lat2 = asin(sin(phi) * cos(delta) + cos(phi) * sin(delta) * cos(bearing))
                    val lon2 = lambda + atan2(sin(bearing) * sin(delta) * cos(phi), cos(delta) - sin(phi) * sin(lat2))
                    val h = elevation(lat2 * 180 / PI, lon2 * 180 / PI, d)
                    if (h != null) {
                        // The ground's drop below the eye's horizontal with distance, less refraction.
                        val drop = d * d * (1 - REFRACTION) / (2 * EARTH_RADIUS_M)
                        val angle = atan((h - eye - drop) / d) * 180 / PI
                        if (angle > best) {
                            best = angle
                            bestM = d
                        }
                    }
                    d += max(FIRST_STEP_M, d * STEP_SHARE)
                }
                angles.put(Math.round(best * 100) / 100.0)
                distances.put(Math.round(bestM / 100) / 10.0)
            }
            return JSONObject()
                .put("lat", lat)
                .put("lon", lon)
                .put("groundM", Math.round(ground))
                .put("step", STEP_DEGREES)
                .put("angles", angles)
                .put("distancesKm", distances)
        }

        /** Elevations in whole metres from a terrarium tile's ARGB pixels: (red * 256 + green + blue / 256) - 32768. */
        internal fun terrarium(pixels: IntArray) = ShortArray(pixels.size) { i ->
            val p = pixels[i]
            ((p shr 16 and 0xff) * 256 + (p shr 8 and 0xff) - 32768).coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }

        /**
         * The ground's height at a place from `zoom`'s tiles (`tile(z, x, y)`, null if it can't be
         * had), bilinear between the pixels round it; the sea's surface, not its floor, at sea.
         */
        internal fun sample(lat: Double, lon: Double, zoom: Int, tile: (Int, Int, Int) -> ShortArray?): Double? {
            val (px, py) = pixelOf(lat, lon, zoom)
            // Pixel centres are at half pixels.
            val fx = px - 0.5
            val fy = py - 0.5
            val x0 = floor(fx).toInt()
            val y0 = floor(fy).toInt()
            val tx = Math.floorDiv(x0, TILE_SIZE)
            val ty = Math.floorDiv(y0, TILE_SIZE)
            val heights = tile(zoom, Math.floorMod(tx, 1 shl zoom), ty) ?: return null
            // Within the tile: at its edges, the edge pixel stands in for the next tile's.
            val at = { x: Int, y: Int ->
                val ix = (x - tx * TILE_SIZE).coerceIn(0, TILE_SIZE - 1)
                val iy = (y - ty * TILE_SIZE).coerceIn(0, TILE_SIZE - 1)
                heights[iy * TILE_SIZE + ix].toDouble()
            }
            val ax = fx - x0
            val ay = fy - y0
            val top = at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax
            val bottom = at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax
            return max(0.0, top * (1 - ay) + bottom * ay)
        }

        /** Web Mercator pixel (fractional, whole-world) of a place at `zoom`. */
        private fun pixelOf(lat: Double, lon: Double, zoom: Int): Pair<Double, Double> {
            val size = TILE_SIZE * 2.0.pow(zoom)
            val phi = min(max(lat, -85.05), 85.05) * PI / 180
            return (lon + 180) / 360 * size to (1 - ln(tan(phi) + 1 / cos(phi)) / PI) / 2 * size
        }

        internal fun tileOf(lat: Double, lon: Double, zoom: Int): Pair<Int, Int> {
            val (px, py) = pixelOf(lat, lon, zoom)
            return floor(px / TILE_SIZE).toInt() to floor(py / TILE_SIZE).toInt()
        }
    }
}
