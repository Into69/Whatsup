package dev.whatsup.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.math.cos

class CoordinatesTest {
    /** Distance in metres between two nearby positions. */
    private fun metres(a: LatLon, b: LatLon): Double {
        val dLat = (a.lat - b.lat) * 111_320
        val dLon = (a.lon - b.lon) * 111_320 * cos(Math.toRadians(a.lat))
        return Math.hypot(dLat, dLon)
    }

    @Test
    fun utmAtTheOrigin() {
        // The equator at the Greenwich meridian: zone 31, 166,021.44 m east, on the equator.
        val utm = Coordinates.toUtm(LatLon(0.0, 0.0))
        assertEquals(31, utm.zone)
        assertEquals(166_021.44, utm.easting, 0.05)
        assertEquals(0.0, utm.northing, 0.05)
    }

    @Test
    fun mgrsAtTheOrigin() {
        assertEquals("31N AA 66021 00000", Coordinates.toMgrs(LatLon(0.0, 0.0)))
    }

    @Test
    fun utmMatchesProj() {
        // Expected values from PROJ (pyproj 3.7, +proj=utm +datum=WGS84).
        val cases = listOf(
            Triple(LatLon(38.8977, -77.0365), 18, 323_394.30 to 4_307_395.63), // the White House
            Triple(LatLon(53.5461, -113.4938), 12, 334_774.79 to 5_935_915.39), // Edmonton
            Triple(LatLon(-33.8568, 151.2153), 56, 334_900.57 to 6_252_288.75), // Sydney, south
            Triple(LatLon(60.3913, 5.3221), 32, 297_353.93 to 6_700_648.35), // Bergen, zone 32
        )
        for ((place, zone, expected) in cases) {
            val utm = Coordinates.toUtm(place)
            assertEquals("$place zone", zone, utm.zone)
            assertEquals("$place easting", expected.first, utm.easting, 0.02)
            assertEquals("$place northing", expected.second, utm.northing, 0.02)
        }
    }

    @Test
    fun mgrsOfTheWhiteHouse() {
        // From PROJ's UTM above: zone 18, column U (third of zone 18's set), row J.
        val whiteHouse = LatLon(38.8977, -77.0365)
        assertEquals("18S UJ 23394 07395", Coordinates.toMgrs(whiteHouse))
        val back = Coordinates.parseMgrs("18SUJ2339407395")
        assertNotNull(back)
        assertEquals(0.0, metres(whiteHouse, back!!), 2.0)
    }

    @Test
    fun mgrsRoundTripsAroundTheWorld() {
        val places = listOf(
            LatLon(53.5461, -113.4938), // Edmonton
            LatLon(-33.8568, 151.2153), // Sydney
            LatLon(-54.8019, -68.3030), // Ushuaia
            LatLon(64.1466, -21.9426), // Reykjavik
            LatLon(60.3913, 5.3221), // Bergen: zone 32 exception
            LatLon(78.2232, 15.6267), // Longyearbyen: Svalbard zones
            LatLon(0.5, 179.9),
            LatLon(-0.5, -179.9),
        )
        for (place in places) {
            val mgrs = Coordinates.toMgrs(place)!!
            val back = Coordinates.parseMgrs(mgrs, centre = false)!!
            assertEquals("$place via $mgrs", 0.0, metres(place, back), 1.5)
        }
    }

    @Test
    fun mgrsZones() {
        assertEquals(32, Coordinates.utmZone(60.3913, 5.3221))
        assertEquals(33, Coordinates.utmZone(78.2232, 15.6267))
        assertEquals(12, Coordinates.utmZone(53.5461, -113.4938))
    }

    @Test
    fun mgrsAtLowerPrecisionGivesTheSquaresMiddle() {
        val full = Coordinates.parseMgrs("12U VD 41533 41226")!!
        val km = Coordinates.parseMgrs("12U VD 41 41")!!
        // 1 km square: its middle is within about 700 m of any point in it.
        assertEquals(0.0, metres(full, km), 800.0)
        assertNotNull(Coordinates.parseMgrs("12uvd"))
    }

    @Test
    fun mgrsRejectsNonsense() {
        assertNull(Coordinates.parseMgrs("12U VD 4153 341"))
        assertNull(Coordinates.parseMgrs("Edmonton"))
        assertNull(Coordinates.parseMgrs("61U VD"))
        assertNull(Coordinates.parseMgrs("12I VD"))
    }

    @Test
    fun latLonFormats() {
        val expected = LatLon(53.555, -113.5)
        val inputs = listOf(
            "53.555, -113.5",
            "53.555 -113.5",
            "53.555N 113.5W",
            "N53.555 W113.5",
            "53°33'18\"N 113°30'W",
            "53 33 18 N 113 30 0 W",
            "53 33.3, -113 30",
            "113.5W 53.555N",
        )
        for (input in inputs) {
            val parsed = Coordinates.parseLatLon(input)
            assertNotNull(input, parsed)
            assertEquals(input, expected.lat, parsed!!.lat, 1e-6)
            assertEquals(input, expected.lon, parsed.lon, 1e-6)
        }
        assertEquals(-33.8568, Coordinates.parseLatLon("33.8568S, 151.2153E")!!.lat, 1e-9)
    }

    @Test
    fun latLonRejectsNonsense() {
        assertNull(Coordinates.parseLatLon("Edmonton, AB"))
        assertNull(Coordinates.parseLatLon("95, 10"))
        assertNull(Coordinates.parseLatLon("12U VD 4153 4122"))
        assertNull(Coordinates.parseLatLon("53.5"))
    }
}
