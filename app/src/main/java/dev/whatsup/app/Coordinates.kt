package dev.whatsup.app

import java.util.Locale
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan
import kotlin.math.atanh
import kotlin.math.cos
import kotlin.math.cosh
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.sinh
import kotlin.math.sqrt
import kotlin.math.tan

/** A position in degrees, WGS84. */
data class LatLon(val lat: Double, val lon: Double) {
    /** "53.54610°N 113.49380°W". */
    fun format(): String = String.format(
        Locale.US, "%.5f°%s %.5f°%s", abs(lat), if (lat >= 0) "N" else "S", abs(lon), if (lon >= 0) "E" else "W",
    )
}

/**
 * Reading positions typed by the user, as latitude and longitude (decimal or degrees, minutes and
 * seconds) or MGRS, and writing them as MGRS. UTM and MGRS are on WGS84, with the Krüger series
 * (good to well under a metre), and MGRS uses the standard (AA) lettering.
 */
object Coordinates {
    // ---- Latitude and longitude ----

    /**
     * "53.55, -113.5", "53.55N 113.5W", "N53.55 W113.5", "53°33'18\"N 113°30'W", "53 33 18 N 113 30 0 W";
     * null if the text isn't a latitude and longitude.
     */
    fun parseLatLon(text: String): LatLon? {
        val cleaned = text.uppercase(Locale.US)
            .replace(Regex("[°º˚'’′\"”″]"), " ")
            .trim()
        if (cleaned.isEmpty() || !cleaned.matches(Regex("[0-9NSEW.,;+\\-\\s]+"))) return null
        val halves = splitHalves(cleaned) ?: return null
        val first = parseAngle(halves.first) ?: return null
        val second = parseAngle(halves.second) ?: return null
        // A hemisphere letter says which is which; otherwise latitude comes first.
        val (lat, lon) = when {
            first.second in "EW" || second.second in "NS" -> second.first to first.first
            else -> first.first to second.first
        }
        if (abs(lat) > 90 || abs(lon) > 180) return null
        return LatLon(lat, lon)
    }

    /** The text cut into its latitude and longitude parts: at a comma, after a hemisphere letter, or by its numbers. */
    private fun splitHalves(text: String): Pair<String, String>? {
        Regex("[,;]").find(text)?.let { comma ->
            return text.substring(0, comma.range.first).trim() to text.substring(comma.range.last + 1).trim()
        }
        // A letter after the first set of numbers ends the first half ("53 33 N 113 30 W"); one before
        // the second set starts the second ("N53.5 W113.5").
        val tokens = Regex("[NSEW]|[+\\-]?[0-9.]+").findAll(text).map { it.value }.toList()
        val letters = tokens.withIndex().filter { it.value.length == 1 && it.value[0] in "NSEW" }
        if (letters.size == 2) {
            val firstLetter = letters[0].index
            val cut = if (firstLetter == 0) letters[1].index else firstLetter + 1
            return tokens.subList(0, cut).joinToString(" ") to tokens.subList(cut, tokens.size).joinToString(" ")
        }
        if (letters.isNotEmpty()) return null
        // No letters, no comma: two, four or six numbers, half each.
        if (tokens.size !in listOf(2, 4, 6)) return null
        val half = tokens.size / 2
        return tokens.subList(0, half).joinToString(" ") to tokens.subList(half, tokens.size).joinToString(" ")
    }

    /** "53 33 18 N" to (53.555, 'N'); a letter of ' ' when there is none. Degrees, minutes, seconds; S and W negative. */
    private fun parseAngle(text: String): Pair<Double, Char>? {
        val tokens = Regex("[NSEW]|[+\\-]?[0-9.]+").findAll(text).map { it.value }.toList()
        val letter = tokens.firstOrNull { it.length == 1 && it[0] in "NSEW" }?.get(0) ?: ' '
        val numbers = tokens.filter { !(it.length == 1 && it[0] in "NSEW") }.map { it.toDoubleOrNull() ?: return null }
        if (numbers.isEmpty() || numbers.size > 3) return null
        val negative = numbers[0] < 0 || text.trim().startsWith("-")
        val parts = numbers.mapIndexed { i, n -> if (i == 0) abs(n) else n }
        if (parts.drop(1).any { it < 0 || it >= 60 }) return null
        var degrees = parts[0] + parts.getOrElse(1) { 0.0 } / 60 + parts.getOrElse(2) { 0.0 } / 3600
        if (negative || letter == 'S' || letter == 'W') degrees = -degrees
        return degrees to letter
    }

    // ---- UTM ----

    private const val A = 6378137.0
    private const val F = 1 / 298.257223563
    private const val K0 = 0.9996
    private const val FALSE_EASTING = 500_000.0
    private const val FALSE_NORTHING_SOUTH = 10_000_000.0
    private val N = F / (2 - F)
    private val RECTIFYING_RADIUS = A / (1 + N) * (1 + N * N / 4 + N * N * N * N / 64)
    private val ALPHA = doubleArrayOf(
        N / 2 - 2 * N * N / 3 + 5 * N * N * N / 16,
        13 * N * N / 48 - 3 * N * N * N / 5,
        61 * N * N * N / 240,
    )
    private val BETA = doubleArrayOf(
        N / 2 - 2 * N * N / 3 + 37 * N * N * N / 96,
        N * N / 48 + N * N * N / 15,
        17 * N * N * N / 480,
    )
    private val DELTA = doubleArrayOf(
        2 * N - 2 * N * N / 3 - 2 * N * N * N,
        7 * N * N / 3 - 8 * N * N * N / 5,
        56 * N * N * N / 15,
    )

    data class Utm(val zone: Int, val band: Char, val easting: Double, val northing: Double)

    private const val BANDS = "CDEFGHJKLMNPQRSTUVWX"

    /** The UTM zone for a position, with the exceptions for south-west Norway and Svalbard. */
    fun utmZone(lat: Double, lon: Double): Int {
        val normalized = ((lon + 180) % 360 + 360) % 360 - 180
        var zone = floor((normalized + 180) / 6).toInt() + 1
        if (zone > 60) zone = 60
        if (lat >= 56 && lat < 64 && normalized >= 3 && normalized < 12) zone = 32
        if (lat >= 72 && lat < 84) {
            zone = when {
                normalized >= 0 && normalized < 9 -> 31
                normalized >= 9 && normalized < 21 -> 33
                normalized >= 21 && normalized < 33 -> 35
                normalized >= 33 && normalized < 42 -> 37
                else -> zone
            }
        }
        return zone
    }

    private fun centralMeridian(zone: Int) = Math.toRadians((zone - 1) * 6.0 - 180 + 3)

    /** UTM for a position between 80°S and 84°N. */
    fun toUtm(position: LatLon): Utm {
        val zone = utmZone(position.lat, position.lon)
        val band = BANDS[((position.lat + 80) / 8).toInt().coerceIn(0, BANDS.length - 1)]
        val (easting, northing) = project(Math.toRadians(position.lat), Math.toRadians(position.lon), zone)
        return Utm(zone, band, easting, if (position.lat < 0) northing + FALSE_NORTHING_SOUTH else northing)
    }

    /** Transverse Mercator easting and (northern) northing in metres. */
    private fun project(phi: Double, lambda: Double, zone: Int): Pair<Double, Double> {
        val dLambda = lambda - centralMeridian(zone)
        val twoRootN = 2 * sqrt(N) / (1 + N)
        val t = sinh(atanh(sin(phi)) - twoRootN * atanh(twoRootN * sin(phi)))
        val xi = atan(t / cos(dLambda))
        val eta = atanh(sin(dLambda) / sqrt(1 + t * t))
        var e = eta
        var n = xi
        for (j in 1..3) {
            e += ALPHA[j - 1] * cos(2 * j * xi) * sinh(2 * j * eta)
            n += ALPHA[j - 1] * sin(2 * j * xi) * cosh(2 * j * eta)
        }
        return FALSE_EASTING + K0 * RECTIFYING_RADIUS * e to K0 * RECTIFYING_RADIUS * n
    }

    /** The position of a UTM coordinate; `south` when in the southern hemisphere. */
    fun fromUtm(zone: Int, south: Boolean, easting: Double, northing: Double): LatLon {
        val xi = (northing - if (south) FALSE_NORTHING_SOUTH else 0.0) / (K0 * RECTIFYING_RADIUS)
        val eta = (easting - FALSE_EASTING) / (K0 * RECTIFYING_RADIUS)
        var xiP = xi
        var etaP = eta
        for (j in 1..3) {
            xiP -= BETA[j - 1] * sin(2 * j * xi) * cosh(2 * j * eta)
            etaP -= BETA[j - 1] * cos(2 * j * xi) * sinh(2 * j * eta)
        }
        val chi = asin(sin(xiP) / cosh(etaP))
        var phi = chi
        for (j in 1..3) phi += DELTA[j - 1] * sin(2 * j * chi)
        val lambda = centralMeridian(zone) + atan(sinh(etaP) / cos(xiP))
        return LatLon(Math.toDegrees(phi), (Math.toDegrees(lambda) + 540) % 360 - 180)
    }

    // ---- MGRS ----

    /** Column letters of the 100 km squares, by the zone's set (zone % 3: 1, 2, 0); I and O left out. */
    private val COLUMN_LETTERS = arrayOf("STUVWXYZ", "ABCDEFGH", "JKLMNPQR")
    private const val ROW_LETTERS = "ABCDEFGHJKLMNPQRSTUV"
    /**
     * The least northing (m, as written in the zone's hemisphere) in each latitude band, to place a
     * 100 km row letter (which repeats every 2,000 km) in the right cycle.
     */
    private val BAND_MIN_NORTHING = mapOf(
        'C' to 1_100_000.0, 'D' to 2_000_000.0, 'E' to 2_800_000.0, 'F' to 3_700_000.0, 'G' to 4_600_000.0,
        'H' to 5_500_000.0, 'J' to 6_400_000.0, 'K' to 7_300_000.0, 'L' to 8_200_000.0, 'M' to 9_100_000.0,
        'N' to 0.0, 'P' to 800_000.0, 'Q' to 1_700_000.0, 'R' to 2_600_000.0, 'S' to 3_500_000.0,
        'T' to 4_400_000.0, 'U' to 5_300_000.0, 'V' to 6_200_000.0, 'W' to 7_000_000.0, 'X' to 7_900_000.0,
    )

    /** "12U VD 41533 41226" (to the metre); null outside 80°S to 84°N, where MGRS uses polar grids instead. */
    fun toMgrs(position: LatLon): String? {
        if (position.lat < -80 || position.lat >= 84) return null
        val utm = toUtm(position)
        val column = COLUMN_LETTERS[utm.zone % 3][(floor(utm.easting / 100_000).toInt() - 1).coerceIn(0, 7)]
        val rowOffset = if (utm.zone % 2 == 0) 5 else 0
        val row = ROW_LETTERS[(floor(utm.northing / 100_000).toInt() + rowOffset).mod(20)]
        val e = floor(utm.easting % 100_000).toInt()
        val n = floor(utm.northing % 100_000).toInt()
        return String.format(Locale.US, "%d%c %c%c %05d %05d", utm.zone, utm.band, column, row, e, n)
    }

    /**
     * "12UVD4153341226", "12U VD 4153 4122", "12U VD": the south-west corner of the square it names
     * (to its precision), or its middle when `centre`. Null if the text isn't MGRS.
     */
    fun parseMgrs(text: String, centre: Boolean = true): LatLon? {
        val compact = text.uppercase(Locale.US).replace(Regex("\\s"), "")
        val match = Regex("^(\\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\\d*)$").matchEntire(compact) ?: return null
        val (zoneText, bandText, columnText, rowText, digits) = match.destructured
        val zone = zoneText.toInt()
        if (zone !in 1..60 || digits.length % 2 != 0 || digits.length > 10) return null
        val band = bandText[0]
        val columnIndex = COLUMN_LETTERS[zone % 3].indexOf(columnText[0])
        val rowIndex = ROW_LETTERS.indexOf(rowText[0])
        if (columnIndex < 0 || rowIndex < 0) return null
        val half = digits.length / 2
        val unit = if (half == 0) 100_000.0 else Math.pow(10.0, (5 - half).toDouble())
        val eDigits = if (half == 0) 0.0 else digits.substring(0, half).toDouble() * unit
        val nDigits = if (half == 0) 0.0 else digits.substring(half).toDouble() * unit
        val inside = if (centre) unit / 2 else 0.0
        val easting = (columnIndex + 1) * 100_000.0 + eDigits + inside
        val rowOffset = if (zone % 2 == 0) 5 else 0
        var northing = ((rowIndex - rowOffset).mod(20)) * 100_000.0 + nDigits + inside
        val least = BAND_MIN_NORTHING[band] ?: return null
        while (northing < least) northing += 2_000_000.0
        return fromUtm(zone, band < 'N', easting, northing)
    }
}
