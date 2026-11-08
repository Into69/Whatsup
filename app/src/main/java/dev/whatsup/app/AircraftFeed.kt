package dev.whatsup.app

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Live aircraft around a point, from ADS-B, for the page's aircraft layer (aircraft.js): from the
 * user's own receiver if one is set (readsb, dump1090 or tar1090's aircraft.json), then the
 * volunteer networks adsb.lol and, as a fallback, adsb.fi. Both answer "everything within r nautical
 * miles of a point" (up to 250 NM), in readsb's format; the receiver's list is cut to the radius here.
 */
class AircraftFeed {
    private var lastKey = ""
    private var lastAt = 0L
    private var last: ByteArray? = null
    /** When the user's receiver last failed: it is skipped for RECEIVER_RETRY_MS after. */
    private var receiverFailedAt = 0L

    /**
     * The page's aircraft as JSON: { at, source, lat, lon, radiusNm, aircraft: [[hex, callsign,
     * registration, type, description, lat, lon, altitudeFt, onGround, groundSpeedKt, trackDeg,
     * verticalRateFpm, squawk, positionAt (ms)]] } (unknown values null); or { error } with none.
     * Blocking: call off the main thread. A request within MIN_INTERVAL_MS of the last gets the same
     * answer, so the public services are never asked more often than they allow.
     */
    @Synchronized
    fun load(lat: Double, lon: Double, radiusNm: Int, receiverUrl: String): ByteArray {
        if (Http.offline) return error("offline")
        val radius = radiusNm.coerceIn(MIN_RADIUS_NM, MAX_RADIUS_NM)
        // A few hundred metres of GPS wander isn't a new place.
        val key = "%.2f,%.2f,%d,%s".format(lat, lon, radius, receiverUrl)
        last?.let { if (key == lastKey && System.currentTimeMillis() - lastAt < MIN_INTERVAL_MS) return it }
        val now = System.currentTimeMillis()
        // Away from home the receiver can't be reached: after it fails, go straight to the public
        // networks for a while instead of waiting on it every time.
        val tryReceiver = receiverUrl.isNotBlank() && now - receiverFailedAt > RECEIVER_RETRY_MS
        val sources = buildList {
            if (tryReceiver) add(RECEIVER to receiverUrl.trim())
            add("adsb.lol" to "https://api.adsb.lol/v2/point/$lat/$lon/$radius")
            add("adsb.fi" to "https://opendata.adsb.fi/api/v2/lat/$lat/lon/$lon/dist/$radius")
        }
        for ((name, url) in sources) {
            try {
                val local = name == RECEIVER
                val body = Http.getBytes(
                    url,
                    readTimeoutMs = if (local) RECEIVER_TIMEOUT_MS else 15_000,
                    connectTimeoutMs = if (local) RECEIVER_TIMEOUT_MS else 15_000,
                    allowLocalHttp = local,
                )
                val fetchedAt = System.currentTimeMillis()
                val json = parse(JSONObject(body.toString(Charsets.UTF_8)), name, lat, lon, radius, fetchedAt).toString().toByteArray()
                if (local) receiverFailedAt = 0
                lastKey = key
                lastAt = fetchedAt
                last = json
                return json
            } catch (e: Exception) {
                Log.w(TAG, "Aircraft from $name failed", e)
                if (name == RECEIVER) receiverFailedAt = System.currentTimeMillis()
            }
        }
        return error("unavailable")
    }

    /**
     * A service's or receiver's answer as the page's JSON (see [load]), cut to the radius. Times are
     * on this phone's clock, from `fetchedAt` less each position's age: a receiver's own clock may
     * well be wrong. An answer with no aircraft list (an error, or the wrong file) is an error.
     */
    internal fun parse(
        response: JSONObject,
        source: String,
        lat: Double,
        lon: Double,
        radiusNm: Int,
        fetchedAt: Long,
    ): JSONObject {
        // adsb.lol gives "ac"; adsb.fi and receivers "aircraft".
        val list = response.optJSONArray("ac") ?: response.optJSONArray("aircraft")
            ?: throw IllegalArgumentException("No aircraft list: ${response.toString().take(200)}")
        val rows = JSONArray()
        for (i in 0 until list.length()) {
            val a = list.optJSONObject(i) ?: continue
            val aLat = a.optDouble("lat", Double.NaN)
            val aLon = a.optDouble("lon", Double.NaN)
            if (aLat.isNaN() || aLon.isNaN()) continue
            // Not aircraft: category C is airport vehicles and obstacles; type TWR a ground station
            // (and adsb.fi marks vehicles GND).
            if (a.optString("category").startsWith("C") || a.optString("t") in NOT_AIRCRAFT) continue
            if (distanceNm(lat, lon, aLat, aLon) > radiusNm) continue
            // Older dump1090 (-mutability) names: altitude, speed, vert_rate.
            val baro = a.opt("alt_baro") ?: a.opt("altitude")
            val onGround = baro == "ground"
            val altitudeFt = when {
                onGround -> 0.0
                baro is Number -> baro.toDouble()
                else -> a.optDouble("alt_geom", Double.NaN)
            }
            val track = listOf("track", "true_heading", "mag_heading").map { a.optDouble(it, Double.NaN) }.firstOrNull { !it.isNaN() } ?: Double.NaN
            val rate = listOf("baro_rate", "geom_rate", "vert_rate").map { a.optDouble(it, Double.NaN) }.firstOrNull { !it.isNaN() } ?: Double.NaN
            val seenS = a.optDouble("seen_pos", a.optDouble("seen", 0.0))
            rows.put(
                JSONArray()
                    .put(a.optString("hex"))
                    .put(a.optString("flight").trim())
                    // adsb.fi gives placeholder "GND" for vehicles' registration and type.
                    .put(text(a, "r"))
                    .put(text(a, "t"))
                    .put(text(a, "desc"))
                    .put(aLat)
                    .put(aLon)
                    .put(number(altitudeFt))
                    .put(onGround)
                    .put(number(a.optDouble("gs", a.optDouble("speed", Double.NaN))))
                    .put(number(track))
                    .put(number(rate))
                    .put(text(a, "squawk"))
                    .put(fetchedAt - (seenS * 1000).toLong()),
            )
        }
        return JSONObject()
            .put("at", fetchedAt)
            .put("source", source)
            .put("lat", lat)
            .put("lon", lon)
            .put("radiusNm", radiusNm)
            .put("aircraft", rows)
    }

    private fun text(a: JSONObject, key: String): Any =
        a.optString(key).trim().takeIf { it.isNotEmpty() && it != "GND" } ?: JSONObject.NULL

    private fun number(value: Double): Any = if (value.isNaN()) JSONObject.NULL else value

    companion object {
        private const val TAG = "AircraftFeed"
        /** The public services' radius limit, and a sensible least. */
        const val MIN_RADIUS_NM = 5
        const val MAX_RADIUS_NM = 250
        const val DEFAULT_RADIUS_NM = 50
        /** adsb.fi allows one request a second; the page asks every 10 s. */
        private const val MIN_INTERVAL_MS = 5_000L
        private const val EARTH_RADIUS_NM = 3440.065
        private val NOT_AIRCRAFT = setOf("TWR", "GND")
        private const val RECEIVER = "receiver"
        /** A receiver on the home network answers at once or not at all. */
        private const val RECEIVER_TIMEOUT_MS = 3_000
        private const val RECEIVER_RETRY_MS = 2 * 60_000L

        /** A reply with no aircraft: "offline" (offline mode), "unavailable" or "waiting" (no location yet). */
        fun error(reason: String): ByteArray = JSONObject().put("error", reason).toString().toByteArray()

        fun distanceNm(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
            val p1 = Math.toRadians(lat1)
            val p2 = Math.toRadians(lat2)
            val h = sin((p2 - p1) / 2).pow(2) + cos(p1) * cos(p2) * sin(Math.toRadians(lon2 - lon1) / 2).pow(2)
            return 2 * EARTH_RADIUS_NM * asin(sqrt(h.coerceAtMost(1.0)))
        }
    }
}
