package dev.whatsup.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** OneWebTerminal's reading of a Hughes terminal's answers, in the shapes the known exporter reads. */
class OneWebTerminalTest {
    private val answers = JSONObject(
        """
        {
          "antenna/antennatuneinfo": {
            "calibration_info": {"pointing_score": 87},
            "pointing_info": {"current_sinr": "9.25", "satellite": 123, "track_id": "4"}
          },
          "modem/satellites_in_view": {"candidate_satellites": "[123, 456, \"789\"]"},
          "modem/lte_signal_info": {"rsrp_dBW/m^2": -120.5, "rssi_dBm": -71, "sinr_dB": 9.3},
          "diagnostics/active_faults": {"availability_percent": "99.7", "current_recovery_action_index": 0},
          "antenna/trackingstatus": {"tracking_status": "TRACKING", "beam": {"commanded_azimuth_deg": -10.5, "commanded_elevation_deg": "62.0"}}
        }
        """.trimIndent(),
    )

    @Test
    fun summarisesTheKnownFields() {
        val t = OneWebTerminal.summarise(answers)
        assertEquals(123L, t.getLong("satellite"))
        assertEquals(4L, t.getLong("trackId"))
        assertEquals(9.25, t.getDouble("sinr"), 1e-9)
        assertEquals(87.0, t.getDouble("pointingScore"), 1e-9)
        val candidates = t.getJSONArray("candidates")
        assertEquals(listOf(123L, 456L, 789L), (0 until candidates.length()).map { candidates.getLong(it) })
        assertEquals(-71.0, t.getJSONObject("signal").getDouble("rssiDbm"), 1e-9)
        assertEquals(99.7, t.getDouble("availability"), 1e-9)
    }

    @Test
    fun findsPointingWhereverItIs() {
        val pointing = OneWebTerminal.summarise(answers).getJSONObject("pointing")
        assertEquals(349.5, pointing.getDouble("az"), 1e-9)
        assertEquals(62.0, pointing.getDouble("el"), 1e-9)
        assertEquals("antenna/trackingstatus.beam", pointing.getString("from"))
        // Names that only contain the letters aren't taken for it.
        assertNull(OneWebTerminal.findPointing(JSONObject("""{"label": 5, "maze": 7}"""), "x"))
    }

    @Test
    fun missingAnswersLeaveFieldsOut() {
        val t = OneWebTerminal.summarise(JSONObject("""{"antenna/antennatuneinfo": {"pointing_info": {"satellite": ""}}}"""))
        assertFalse(t.has("satellite"))
        assertFalse(t.has("candidates"))
        assertFalse(t.has("pointing"))
    }

    @Test
    fun addressesStayLocal() {
        assertEquals("http://192.168.100.1", OneWebTerminal.baseUrl(""))
        assertEquals("http://192.168.1.9:8080", OneWebTerminal.baseUrl("192.168.1.9:8080/"))
        assertTrue(runCatching { OneWebTerminal.baseUrl("oneweb.net") }.isFailure)
    }
}
