package dev.whatsup.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** AircraftFeed.parse against real answers from adsb.lol and adsb.fi around Heathrow (trimmed). */
class AircraftFeedTest {
    private val heathrowLat = 51.47
    private val heathrowLon = -0.45
    /** The phone's clock at the fetch: positions' times are this less their age, whatever the source's clock says. */
    private val fetchedAt = 1_800_000_000_000L

    private fun sample(name: String) =
        JSONObject(javaClass.classLoader!!.getResource(name)!!.readText())

    private fun rows(result: JSONObject): Map<String, JSONArray> {
        val list = result.getJSONArray("aircraft")
        return (0 until list.length()).map { list.getJSONArray(it) }.associateBy { it.getString(0) }
    }

    @Test
    fun adsbLol() {
        val result = AircraftFeed().parse(sample("adsb-lol.json"), "adsb.lol", heathrowLat, heathrowLon, 25, fetchedAt)
        assertEquals(fetchedAt, result.getLong("at"))
        val rows = rows(result)
        // The service vehicle (category C2) and the ground station (TWR) are left out.
        assertEquals(setOf("4005bc", "40772d", "40772e", "440bbf", "400db2"), rows.keys)
        val climbing = rows.getValue("40772d")
        assertEquals("EZY83RJ", climbing.getString(1))
        assertEquals("G-UZHX", climbing.getString(2))
        assertEquals("A20N", climbing.getString(3))
        assertEquals(14000.0, climbing.getDouble(7), 0.0)
        assertFalse(climbing.getBoolean(8))
        assertEquals(258.1, climbing.getDouble(9), 1e-9)
        assertEquals(358.22, climbing.getDouble(10), 1e-9)
        assertEquals(0.0, climbing.getDouble(11), 0.0)
        // The position is seen_pos (0.326 s) older than the fetch.
        assertEquals(fetchedAt - 326, climbing.getLong(13))
        val parked = rows.getValue("4005bc")
        assertTrue(parked.getBoolean(8))
        assertEquals(0.0, parked.getDouble(7), 0.0)
        // No track on the ground, so its true heading instead.
        assertEquals(0.0, parked.getDouble(10), 0.0)
        // No description from adsb.lol: null, not missing.
        assertTrue(parked.isNull(4))
    }

    @Test
    fun adsbFi() {
        val result = AircraftFeed().parse(sample("adsb-fi.json"), "adsb.fi", heathrowLat, heathrowLon, 25, fetchedAt)
        val rows = rows(result)
        // GND and TWR are left out.
        assertEquals(setOf("4076cc", "40772d", "40772e", "440bbf", "400db2"), rows.keys)
        assertEquals(36500.0, rows.getValue("440bbf").getDouble(7), 0.0)
        assertEquals(2304.0, rows.getValue("440bbf").getDouble(11), 0.0)
    }

    @Test
    fun cutToTheRadius() {
        // Within 10 NM of Heathrow: the parked 777 and the 757 about 8 NM east; not the others, 18-25 NM out.
        val rows = rows(AircraftFeed().parse(sample("adsb-lol.json"), "adsb.lol", heathrowLat, heathrowLon, 10, fetchedAt))
        assertEquals(setOf("4005bc", "440bbf"), rows.keys)
    }

    @Test
    fun olderDump1090() {
        // dump1090-mutability: altitude, speed and vert_rate; its "now" (here a clock 10 minutes slow) is ignored.
        val answer = JSONObject(
            """{"now": 1799999400.0, "aircraft": [
                {"hex": "c0ffee", "flight": "WJA123  ", "lat": 51.5, "lon": -0.4, "altitude": 35000, "speed": 450,
                 "track": 270, "vert_rate": -640, "seen_pos": 2.5, "squawk": "7700"},
                {"hex": "c0ffef", "lat": 51.48, "lon": -0.45, "altitude": "ground", "speed": 3}
            ]}""",
        )
        val rows = rows(AircraftFeed().parse(answer, "receiver", heathrowLat, heathrowLon, 25, fetchedAt))
        val flying = rows.getValue("c0ffee")
        assertEquals(35000.0, flying.getDouble(7), 0.0)
        assertEquals(450.0, flying.getDouble(9), 0.0)
        assertEquals(-640.0, flying.getDouble(11), 0.0)
        assertEquals("7700", flying.getString(12))
        assertEquals(fetchedAt - 2500, flying.getLong(13))
        assertTrue(rows.getValue("c0ffef").getBoolean(8))
    }

    @Test(expected = IllegalArgumentException::class)
    fun noAircraftListIsAnError() {
        // e.g. tar1090's receiver.json given by mistake, or an error message: try the next source.
        AircraftFeed().parse(JSONObject("""{"version": "readsb", "refresh": 1000}"""), "receiver", heathrowLat, heathrowLon, 25, fetchedAt)
    }

    @Test
    fun localHosts() {
        for (host in listOf("192.168.1.20", "10.0.0.5", "172.20.1.1", "127.0.0.1", "169.254.3.4", "raspberrypi", "pi.local", "adsb.lan", "feeder.home.arpa", "localhost")) {
            assertTrue(host, Http.isLocalHost(host))
        }
        for (host in listOf("8.8.8.8", "172.32.0.1", "192.169.1.1", "example.com", "adsb.lol", "1.2.3")) {
            assertFalse(host, Http.isLocalHost(host))
        }
    }

    @Test
    fun distance() {
        // One degree of latitude is 60 NM.
        assertEquals(60.0, AircraftFeed.distanceNm(50.0, 0.0, 51.0, 0.0), 0.1)
        assertEquals(0.0, AircraftFeed.distanceNm(51.47, -0.45, 51.47, -0.45), 1e-9)
    }
}
