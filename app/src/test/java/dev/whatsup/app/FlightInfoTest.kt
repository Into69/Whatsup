package dev.whatsup.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** FlightInfo.legPoints against a real adsb.lol trace (EZY81XM, five legs that day; thinned). */
class FlightInfoTest {
    private fun sample(name: String) = JSONObject(javaClass.classLoader!!.getResource(name)!!.readText())

    @Test
    fun onlyTheLegUnderWay() {
        val full = sample("trace-full.json")
        val points = FlightInfo().legPoints(listOf(full))
        val base = (full.getDouble("timestamp") * 1000).toLong()
        // The last leg starts at Rome Fiumicino, climbing through 450 ft, and ends near London.
        val first = points.first()
        assertEquals((base + 53_493_930L).toDouble(), first.getLong(0).toDouble(), 1.0)
        assertEquals(41.799766, first.getDouble(1), 1e-6)
        assertEquals(12.233212, first.getDouble(2), 1e-6)
        assertEquals(450, first.getInt(3))
        assertEquals(51.552786, points.last().getDouble(1), 1e-6)
        assertEquals(21425, points.last().getInt(3))
        assertTrue(points.zipWithNext().all { (a, b) -> a.getLong(0) < b.getLong(0) })
    }

    @Test
    fun recentCarriesOnFromFull() {
        val full = sample("trace-full.json")
        val base = full.getDouble("timestamp")
        // A recent trace overlapping the full one's end and going 30 s past it, on the ground at the end.
        val recent = JSONObject(
            """{"timestamp": ${base + 61_500}, "trace": [
                [40.0, 51.55, -0.49, 21500, 300, 318, 0, -1500, null],
                [80.0, 51.60, -0.55, 21000, 300, 318, 0, -1500, null],
                [90.0, 51.61, -0.56, "ground", 0, 318, 0, 0, null]
            ]}""",
        )
        val points = FlightInfo().legPoints(listOf(full, recent))
        val fullOnly = FlightInfo().legPoints(listOf(full))
        // The first recent point is before the full trace's last one (61,551.72 s), so it is skipped.
        assertEquals(fullOnly.size + 2, points.size)
        assertEquals(-1, points.last().getInt(3))
    }

    @Test
    fun aNewLegStartsAfresh() {
        val trace = JSONObject(
            """{"timestamp": 1000, "trace": [
                [0, 50.0, 0.0, 30000, 450, 90, 0, 0, null],
                [60, 50.1, 0.1, "ground", 0, 90, 0, 0, null],
                [600, 50.1, 0.1, 200, 140, 90, 2, 1500, null],
                [660, 50.2, 0.2, 2000, 200, 90, 0, 1500, null]
            ]}""",
        )
        val points = FlightInfo().legPoints(listOf(trace))
        assertEquals(2, points.size)
        assertEquals(1_600_000L, points.first().getLong(0))
    }
}
