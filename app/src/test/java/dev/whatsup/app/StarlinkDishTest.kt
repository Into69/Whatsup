package dev.whatsup.app

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException

/** StarlinkDish's reading of the dish's answers, built here by hand as protobuf. */
class StarlinkDishTest {
    private class Message {
        val out = ByteArrayOutputStream()
        private fun varint(v: Long) {
            var x = v
            while (x >= 0x80) {
                out.write(((x and 0x7F) or 0x80).toInt())
                x = x ushr 7
            }
            out.write(x.toInt())
        }
        fun varint(field: Int, v: Long) = apply { varint(field.toLong() shl 3); varint(v) }
        fun float(field: Int, f: Float) = apply {
            varint((field.toLong() shl 3) or 5)
            val bits = java.lang.Float.floatToIntBits(f)
            for (k in 0 until 4) out.write((bits ushr (8 * k)) and 0xFF)
        }
        fun bytes(field: Int, b: ByteArray) = apply { varint((field.toLong() shl 3) or 2); varint(b.size.toLong()); out.write(b) }
        fun string(field: Int, s: String) = bytes(field, s.toByteArray())
        fun message(field: Int, m: Message) = bytes(field, m.out.toByteArray())
        fun packedFloats(field: Int, values: FloatArray) = bytes(field, Message().also { m ->
            values.forEach { f -> val bits = java.lang.Float.floatToIntBits(f); for (k in 0 until 4) m.out.write((bits ushr (8 * k)) and 0xFF) }
        }.out.toByteArray())
        fun build(): ByteArray = out.toByteArray()
    }

    @Test
    fun requestsAreEncoded() {
        // Request field 6000 (get_diagnostics), an empty message: key 6000 << 3 | 2 as a varint, then length 0.
        assertArrayEquals(byteArrayOf(0x82.toByte(), 0xF7.toByte(), 0x02, 0x00), Proto.emptyMessageField(6000))
        assertArrayEquals(byteArrayOf(0xC2.toByte(), 0x7D, 0x00), Proto.emptyMessageField(2008))
    }

    @Test
    fun readsDiagnostics() {
        val diagnostics = Message()
            .string(1, "ut01000000-00000000-00abcdef")
            .string(3, "2025.08.01.mr12345")
            .message(5, Message().varint(10, 1).varint(5, 0).varint(6, 1))
            .varint(6, 1)
            .message(9, Message().float(1, 181.5f).float(2, 64.25f).float(3, 175f).float(4, 66f))
            .varint(10, 0)
        // Other fields of the Response (its id, say) are skipped.
        val response = Message().varint(1, 42).message(6001, diagnostics).build()
        val dish = StarlinkDish.parseDiagnostics(response)
        assertEquals("2025.08.01.mr12345", dish.getString("software"))
        val alerts = dish.getJSONObject("alerts")
        assertTrue(alerts.getBoolean("obstructed"))
        assertTrue(alerts.getBoolean("mastNotNearVertical"))
        assertFalse(alerts.has("motorsStuck"))
        val alignment = dish.getJSONObject("alignment")
        assertEquals(181.5, alignment.getJSONObject("boresight").getDouble("az"), 1e-6)
        assertEquals(64.25, alignment.getJSONObject("boresight").getDouble("el"), 1e-6)
        assertEquals(66.0, alignment.getJSONObject("desired").getDouble("el"), 1e-6)
        assertFalse(dish.getBoolean("stowed"))
        // 6.5° of azimuth up at 65° is only about 2.7° across the sky; with 1.75° of elevation, 3.24°.
        assertEquals(3.24, StarlinkDish.separation(alignment.getJSONObject("boresight"), alignment.getJSONObject("desired")), 0.05)
    }

    @Test(expected = IOException::class)
    fun notADish() {
        StarlinkDish.parseDiagnostics(Message().message(6000, Message().string(1, "router")).build())
    }

    @Test
    fun readsTheObstructionMap() {
        // 4 x 4: the corners are outside the circle; one cell obstructed, one not seen.
        val snr = FloatArray(16) { 1f }
        snr[5] = 0f
        snr[6] = -1f
        val map = Message().varint(1, 4).varint(2, 4).packedFloats(3, snr).float(4, 25f).float(5, 80f).varint(6, 1)
        val json = StarlinkDish.parseObstructionMap(Message().message(2008, map).build())
        assertEquals(4, json.getInt("rows"))
        assertEquals(80.0, json.getDouble("edgeThetaDeg"), 1e-6)
        assertEquals("earth", json.getString("frame"))
        val cells = java.util.Base64.getDecoder().decode(json.getString("snr"))
        assertEquals(200, cells[0].toInt() and 0xFF)
        assertEquals(0, cells[5].toInt() and 0xFF)
        assertEquals(255, cells[6].toInt() and 0xFF)
        // Inside the circle: the middle 2 x 2 and the 8 edge-middles (12); seen 11, 1 obstructed.
        val (seen, obstructed) = StarlinkDish.mapStats(json)
        assertEquals(11.0 / 12, seen, 1e-9)
        assertEquals(1.0 / 11, obstructed, 1e-9)
    }

    @Test
    fun oldMapsGiveTheirEdgeAsAnElevation() {
        val map = Message().varint(1, 1).varint(2, 1).float(3, 1f).float(4, 20f)
        assertEquals(70.0, StarlinkDish.parseObstructionMap(Message().message(2008, map).build()).getDouble("edgeThetaDeg"), 1e-6)
    }

    @Test
    fun addressesStayLocal() {
        assertEquals("http://192.168.100.1:9201", StarlinkDish.baseUrl(""))
        assertEquals("http://192.168.1.50:9201", StarlinkDish.baseUrl(" 192.168.1.50 "))
        assertEquals("http://dishy.lan:9300", StarlinkDish.baseUrl("http://dishy.lan:9300/"))
        assertTrue(runCatching { StarlinkDish.baseUrl("example.com") }.isFailure)
        // Unreachable answers say so rather than throwing.
        val off = JSONObject(StarlinkDish().load("example.com").toString(Charsets.UTF_8))
        assertTrue(off.getString("error").contains("Not on this network"))
    }
}
