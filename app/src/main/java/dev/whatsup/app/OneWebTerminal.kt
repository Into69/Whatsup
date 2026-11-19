package dev.whatsup.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * The user's own OneWeb terminal, read over its local API: Hughes HL1120 terminals answer plain JSON
 * at http://192.168.100.1/api/... with no login (see github.com/nickvsnetworking/Hughes_OneWeb_Monitor,
 * which this follows for the fields known). Which satellite it is on and its signal (SINR), the
 * satellites it may hand over to, its pointing score and availability; for oneweb.js (sky view: the
 * satellite in use ringed, and a signal map built from where the satellites were) and the settings
 * check.
 *
 * Only some fields are known; the rest of each answer is kept as it is ("raw"), for the settings'
 * Copy details, and searched for anything that looks like where the antenna points (azimuth and
 * elevation). Intellian and Kymeta terminals have no such API that is known.
 *
 * The fast endpoints are kept STATUS_KEEP_MS, the slow ones SLOW_KEEP_MS. Blocking: call off the
 * main thread.
 */
class OneWebTerminal {
    private var address = ""
    private val kept = HashMap<String, Pair<Long, Any>>()

    /** The terminal's state at `address`, as JSON for the page; `raw` adds every answer as it came. */
    @Synchronized
    fun load(address: String, raw: Boolean = false): ByteArray {
        if (address != this.address) {
            this.address = address
            kept.clear()
        }
        val now = System.currentTimeMillis()
        val out = JSONObject().put("at", now)
        val base = try {
            baseUrl(address)
        } catch (e: IOException) {
            return out.put("error", e.message).toString().toByteArray()
        }
        val answers = JSONObject()
        val errors = JSONObject()
        for ((endpoint, keepMs) in FAST.map { it to STATUS_KEEP_MS } + SLOW.map { it to SLOW_KEEP_MS }) {
            val cached = kept[endpoint]?.takeIf { now - it.first < keepMs }?.second
            val answer = cached ?: try {
                JSONObject(Http.getBytes("$base/api/$endpoint", readTimeoutMs = TIMEOUT_MS, connectTimeoutMs = TIMEOUT_MS, allowLocalHttp = true)
                    .toString(Charsets.UTF_8))
            } catch (e: Exception) {
                ERROR_PREFIX + describe(e)
            }
            kept[endpoint] = now to answer
            if (answer is JSONObject) answers.put(endpoint, answer) else errors.put(endpoint, (answer as String).removePrefix(ERROR_PREFIX))
            // Nothing at all from the first: not a terminal, or not there; don't wait on the rest.
            if (endpoint == FAST.first() && answer !is JSONObject) {
                val why = errors.getString(endpoint)
                return out.put("error", if (why == NO_SUCH_PAGE || why == NOT_JSON) "not a OneWeb terminal ($why)" else why).toString().toByteArray()
            }
        }
        out.put("terminal", summarise(answers))
        if (errors.length() > 0) out.put("errors", errors)
        if (raw) out.put("raw", answers)
        return out.toString().toByteArray()
    }

    companion object {
        const val DEFAULT_ADDRESS = "192.168.100.1"
        private const val TIMEOUT_MS = 4_000
        private const val STATUS_KEEP_MS = 4_000L
        private const val SLOW_KEEP_MS = 60_000L
        private const val ERROR_PREFIX = "error:"
        private const val NO_SUCH_PAGE = "no such page"
        private const val NOT_JSON = "not JSON"

        /** Asked every few seconds: the satellite in use and the signal. The first is the one that must answer. */
        val FAST = listOf("antenna/antennatuneinfo", "modem/satellites_in_view", "modem/lte_signal_info", "antenna/trackingstatus")
        /** Asked once a minute: faults, availability, what the terminal is. */
        val SLOW = listOf("diagnostics/active_faults", "antenna/antennainfo", "system/status", "system/deviceinfo", "system/swinfo")

        /** The base URL from what the user typed: a host, host:port or http://host:port; local only. */
        fun baseUrl(address: String): String {
            val typed = address.trim().ifEmpty { DEFAULT_ADDRESS }.trimEnd('/')
            val url = if ("://" in typed) typed else "http://$typed"
            val parsed = try {
                java.net.URL(url)
            } catch (e: java.net.MalformedURLException) {
                throw IOException("Not an address: $typed")
            }
            if (!Http.isLocalHost(parsed.host)) throw IOException("Not on this network: ${parsed.host}")
            return "${parsed.protocol}://${parsed.host}" + if (parsed.port > 0) ":${parsed.port}" else ""
        }

        private fun describe(e: Exception): String = when (e) {
            is java.net.SocketTimeoutException -> "no answer"
            is java.net.ConnectException, is java.net.NoRouteToHostException -> "can't connect"
            is java.net.UnknownHostException -> "unknown address"
            is Http.StatusException -> if (e.code == 404) NO_SUCH_PAGE else "HTTP ${e.code}"
            is org.json.JSONException -> NOT_JSON
            else -> e.message ?: e.javaClass.simpleName
        }

        /** A number, from a number or a numeric string; null otherwise. */
        private fun number(value: Any?): Double? = when (value) {
            is Number -> value.toDouble()
            is String -> value.trim().toDoubleOrNull()
            else -> null
        }?.takeIf { it.isFinite() }

        /**
         * What the page and the check need, from the answers by endpoint: { satellite, trackId, sinr,
         * pointingScore, candidates, signal: { sinrDb, rssiDbm, rsrp }, availability, pointing: { az,
         * el, from } }, each only if the terminal gave it.
         */
        fun summarise(answers: JSONObject): JSONObject {
            val out = JSONObject()
            answers.optJSONObject("antenna/antennatuneinfo")?.let { tune ->
                tune.optJSONObject("pointing_info")?.let { p ->
                    number(p.opt("satellite"))?.let { out.put("satellite", it.toLong()) }
                    number(p.opt("track_id"))?.let { out.put("trackId", it.toLong()) }
                    number(p.opt("current_sinr"))?.let { out.put("sinr", it) }
                }
                number(tune.optJSONObject("calibration_info")?.opt("pointing_score"))?.let { out.put("pointingScore", it) }
            }
            answers.optJSONObject("modem/satellites_in_view")?.let { view ->
                // A list, or (as seen) a list written out as a string.
                val list = when (val c = view.opt("candidate_satellites")) {
                    is JSONArray -> c
                    is String -> runCatching { JSONArray(c) }.getOrNull()
                    else -> null
                }
                if (list != null) out.put("candidates", JSONArray((0 until list.length()).mapNotNull { number(list.opt(it))?.toLong() }))
            }
            answers.optJSONObject("modem/lte_signal_info")?.let { s ->
                val signal = JSONObject()
                number(s.opt("sinr_dB"))?.let { signal.put("sinrDb", it) }
                number(s.opt("rssi_dBm"))?.let { signal.put("rssiDbm", it) }
                number(s.opt("rsrp_dBW/m^2"))?.let { signal.put("rsrp", it) }
                if (signal.length() > 0) out.put("signal", signal)
            }
            answers.optJSONObject("diagnostics/active_faults")?.let { f ->
                number(f.opt("availability_percent"))?.let { out.put("availability", it) }
            }
            // Where the antenna points, if any answer says so in fields named for it.
            for (endpoint in listOf("antenna/trackingstatus", "antenna/antennatuneinfo", "antenna/antennainfo")) {
                answers.optJSONObject(endpoint)?.let { findPointing(it, endpoint) }?.let {
                    out.put("pointing", it)
                    return out
                }
            }
            return out
        }

        private val AZIMUTH = Regex("(^|_)(azimuth|az)(_|$)|azimuth", RegexOption.IGNORE_CASE)
        private val ELEVATION = Regex("(^|_)(elevation|el)(_|$)|elevation", RegexOption.IGNORE_CASE)

        /** The first object holding both an azimuth and an elevation (in range), searched depth first. */
        fun findPointing(json: JSONObject, path: String): JSONObject? {
            var az: Double? = null
            var el: Double? = null
            for (key in json.keys()) {
                val value = number(json.opt(key)) ?: continue
                if (az == null && AZIMUTH.containsMatchIn(key) && value in -360.0..360.0) az = value
                else if (el == null && ELEVATION.containsMatchIn(key) && value in -90.0..90.0) el = value
            }
            if (az != null && el != null) return JSONObject().put("az", (az + 360) % 360).put("el", el).put("from", path)
            for (key in json.keys()) {
                json.optJSONObject(key)?.let { child -> findPointing(child, "$path.$key")?.let { return it } }
            }
            return null
        }
    }
}
