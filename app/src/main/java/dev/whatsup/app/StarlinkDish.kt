package dev.whatsup.app

import java.util.Base64
import org.json.JSONObject
import java.io.IOException
import kotlin.math.roundToInt

/**
 * The user's own Starlink dish, read over its local API (gRPC-web, plain HTTP on port 9201 of
 * 192.168.100.1, as Starlink's own app uses it on the dish's network): where it points and where it
 * wants to point, its alerts (obstructed, motors stuck, ...), and its obstruction map, the sky as it
 * has seen it. For sky view (/data/starlink.json, polled by starlink.js) and the settings check.
 *
 * Two requests, encoded by hand (the messages are SpaceX.API.Device's, field numbers as in SpaceX's
 * published device.proto, github.com/SpaceExplorationTechnologies/enterprise-api, and the
 * community's copies for the obstruction map):
 * - get_diagnostics (Request field 6000), answered by dish_get_diagnostics (Response 6001);
 * - dish_get_obstruction_map (Request 2008), answered by dish_get_obstruction_map (Response 2008).
 *
 * The dish answers fast or not at all, so the timeouts are short. Answers are kept a few seconds
 * (the map, which changes slowly, longer), so sky view's polling doesn't hammer it. Blocking: call
 * off the main thread.
 */
class StarlinkDish {
    private var status: Pair<Long, JSONObject>? = null
    private var map: Pair<Long, JSONObject>? = null
    private var address = ""

    /** The dish's diagnostics and obstruction map at `address`, as JSON for the page. */
    @Synchronized
    fun load(address: String): ByteArray {
        if (address != this.address) {
            this.address = address
            status = null
            map = null
        }
        val now = System.currentTimeMillis()
        val out = JSONObject().put("at", now)
        val base = try {
            baseUrl(address)
        } catch (e: IOException) {
            return out.put("error", e.message).toString().toByteArray()
        }
        val diagnostics = status?.takeIf { now - it.first < STATUS_KEEP_MS }?.second ?: try {
            JSONObject().put("dish", diagnostics(base))
        } catch (e: Exception) {
            JSONObject().put("error", describe(e))
        }.also { status = now to it }
        diagnostics.keys().forEach { out.put(it, diagnostics.get(it)) }
        // No map without the dish; one that failed is tried again with the status.
        if (out.has("dish")) {
            val kept = map?.takeIf { now - it.first < (if (it.second.has("map")) MAP_KEEP_MS else STATUS_KEEP_MS) }?.second ?: try {
                JSONObject().put("map", obstructionMap(base))
            } catch (e: Exception) {
                JSONObject().put("mapError", describe(e))
            }.also { map = now to it }
            kept.keys().forEach { out.put(it, kept.get(it)) }
        }
        return out.toString().toByteArray()
    }

    companion object {
        const val DEFAULT_ADDRESS = "192.168.100.1"
        private const val PORT = 9201
        private const val PATH = "/SpaceX.API.Device.Device/Handle"
        private const val TIMEOUT_MS = 4_000
        private const val STATUS_KEEP_MS = 4_000L
        private const val MAP_KEEP_MS = 60_000L

        private const val REQUEST_GET_DIAGNOSTICS = 6000
        private const val RESPONSE_DISH_GET_DIAGNOSTICS = 6001
        private const val REQUEST_GET_OBSTRUCTION_MAP = 2008
        private const val RESPONSE_GET_OBSTRUCTION_MAP = 2008

        /** One byte per map cell: SNR 0 to 1 as 0 to 200; no data as 255. */
        private const val SNR_SCALE = 200
        private const val NO_DATA = 255

        /** The URL to post to, from what the user typed: a host, host:port or http://host:port; local only. */
        fun baseUrl(address: String): String {
            val typed = address.trim().ifEmpty { DEFAULT_ADDRESS }.trimEnd('/')
            val url = if ("://" in typed) typed else "http://$typed"
            val parsed = try {
                java.net.URL(url)
            } catch (e: java.net.MalformedURLException) {
                throw IOException("Not an address: $typed")
            }
            if (!Http.isLocalHost(parsed.host)) throw IOException("Not on this network: ${parsed.host}")
            val port = if (parsed.port > 0) parsed.port else PORT
            return "${parsed.protocol}://${parsed.host}:$port"
        }

        /** A cell under this SNR (0 to 1) counts as obstructed. */
        private const val OBSTRUCTED_SNR = 0.5

        /** Degrees between two { az, el } directions. */
        fun separation(a: JSONObject, b: JSONObject): Double {
            fun unit(d: JSONObject): DoubleArray {
                val az = Math.toRadians(d.getDouble("az"))
                val el = Math.toRadians(d.getDouble("el"))
                return doubleArrayOf(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el))
            }
            val u = unit(a)
            val v = unit(b)
            return Math.toDegrees(Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]).coerceIn(-1.0, 1.0)))
        }

        /**
         * Of the map's cells inside its circle (the sky it covers), the share the dish has seen, and of
         * those, the share obstructed.
         */
        fun mapStats(map: JSONObject): Pair<Double, Double> {
            val rows = map.getInt("rows")
            val cols = map.getInt("cols")
            val cells = Base64.getDecoder().decode(map.getString("snr"))
            var inside = 0
            var seen = 0
            var obstructed = 0
            for (r in 0 until rows) for (c in 0 until cols) {
                val x = (c + 0.5) / cols * 2 - 1
                val y = (r + 0.5) / rows * 2 - 1
                if (x * x + y * y > 1) continue
                inside++
                val value = cells[r * cols + c].toInt() and 0xFF
                if (value == NO_DATA) continue
                seen++
                if (value < OBSTRUCTED_SNR * SNR_SCALE) obstructed++
            }
            return (if (inside > 0) seen.toDouble() / inside else 0.0) to (if (seen > 0) obstructed.toDouble() / seen else 0.0)
        }

        private fun describe(e: Exception): String = when (e) {
            is java.net.SocketTimeoutException -> "no answer"
            is java.net.ConnectException, is java.net.NoRouteToHostException -> "can't connect"
            is java.net.UnknownHostException -> "unknown address"
            else -> e.message ?: e.javaClass.simpleName
        }

        /** The dish's id, versions, alerts and alignment. */
        fun diagnostics(base: String): JSONObject = parseDiagnostics(call(base, REQUEST_GET_DIAGNOSTICS))

        /** A Response's dish_get_diagnostics, as JSON. */
        fun parseDiagnostics(response: ByteArray): JSONObject {
            val body = Proto.field(response, RESPONSE_DISH_GET_DIAGNOSTICS)
                ?: throw IOException("Not a dish (no diagnostics in its answer)")
            val dish = JSONObject()
            Proto.forEach(body) { field, value ->
                when (field) {
                    1 -> dish.put("id", value.string())
                    2 -> dish.put("hardware", value.string())
                    3 -> dish.put("software", value.string())
                    5 -> dish.put("alerts", alerts(value.bytes()))
                    6 -> dish.put("disablement", value.long())
                    9 -> dish.put("alignment", alignment(value.bytes()))
                    10 -> dish.put("stowed", value.long() != 0L)
                }
            }
            return dish
        }

        private fun alerts(bytes: ByteArray): JSONObject {
            val names = mapOf(
                1 to "heating", 2 to "thermalThrottle", 3 to "thermalShutdown", 4 to "powerSupplyThermalThrottle",
                5 to "motorsStuck", 6 to "mastNotNearVertical", 7 to "slowEthernet", 8 to "softwareInstallPending",
                9 to "movingTooFast", 10 to "obstructed",
            )
            val alerts = JSONObject()
            Proto.forEach(bytes) { field, value -> names[field]?.let { if (value.long() != 0L) alerts.put(it, true) } }
            return alerts
        }

        /**
         * Where the dish's face points (boresight: azimuth from true north, elevation above the
         * horizon) and where Starlink wants it to.
         */
        private fun alignment(bytes: ByteArray): JSONObject {
            val values = DoubleArray(5) { Double.NaN }
            Proto.forEach(bytes) { field, value -> if (field in 1..4) values[field] = value.float().toDouble() }
            fun direction(az: Double, el: Double) = JSONObject().put("az", az).put("el", el)
            return JSONObject().apply {
                if (!values[1].isNaN() && !values[2].isNaN()) put("boresight", direction(values[1], values[2]))
                if (!values[3].isNaN() && !values[4].isNaN()) put("desired", direction(values[3], values[4]))
            }
        }

        /**
         * The obstruction map: rows by cols cells over the sky, zenith in the middle, north up and east
         * right, out to edgeThetaDeg from the zenith; each cell's SNR as a byte (SNR_SCALE, NO_DATA).
         */
        fun obstructionMap(base: String): JSONObject = parseObstructionMap(call(base, REQUEST_GET_OBSTRUCTION_MAP))

        /** A Response's dish_get_obstruction_map, as JSON. */
        fun parseObstructionMap(response: ByteArray): JSONObject {
            val body =Proto.field(response, RESPONSE_GET_OBSTRUCTION_MAP) ?: throw IOException("No obstruction map in the answer")
            var rows = 0L
            var cols = 0L
            var minElevation = Double.NaN
            var maxTheta = Double.NaN
            var frame = 0L
            val snr = ArrayList<Float>()
            Proto.forEach(body) { field, value ->
                when (field) {
                    1 -> rows = value.long()
                    2 -> cols = value.long()
                    3 -> if (value.wire == Proto.LENGTH) snr += value.packedFloats() else snr += value.float()
                    4 -> minElevation = value.float().toDouble()
                    5 -> maxTheta = value.float().toDouble()
                    6 -> frame = value.long()
                }
            }
            if (rows <= 0 || cols <= 0 || snr.size.toLong() != rows * cols) throw IOException("Unexpected obstruction map ($rows × $cols, ${snr.size} cells)")
            val edge = if (!maxTheta.isNaN() && maxTheta > 0) maxTheta else if (!minElevation.isNaN()) 90 - minElevation else 90.0
            val cells = ByteArray(snr.size) { i ->
                val s = snr[i]
                (if (s < 0 || s.isNaN()) NO_DATA else (s.coerceAtMost(1f) * SNR_SCALE).roundToInt()).toByte()
            }
            return JSONObject()
                .put("rows", rows)
                .put("cols", cols)
                .put("edgeThetaDeg", edge)
                .put("frame", when (frame) { 1L -> "earth"; 2L -> "dish"; else -> "unknown" })
                .put("snr", Base64.getEncoder().encodeToString(cells))
        }

        /** Posts a Request with just `requestField` (an empty message) and returns the Response's bytes. */
        private fun call(base: String, requestField: Int): ByteArray {
            val message = Proto.emptyMessageField(requestField)
            val frame = ByteArray(5 + message.size)
            frame[0] = 0
            for (i in 0 until 4) frame[1 + i] = (message.size ushr (8 * (3 - i))).toByte()
            message.copyInto(frame, 5)
            val (headers, body) = Http.postLocal(
                base + PATH,
                frame,
                mapOf("Content-Type" to "application/grpc-web+proto", "X-Grpc-Web" to "1", "Accept" to "application/grpc-web+proto"),
                TIMEOUT_MS,
            )
            // A failed call can come back with its status in the headers alone.
            headers["grpc-status"]?.firstOrNull()?.let { if (it != "0") throw IOException(grpcError(it, headers["grpc-message"]?.firstOrNull())) }
            var data: ByteArray? = null
            var at = 0
            while (at + 5 <= body.size) {
                val flag = body[at].toInt() and 0xFF
                val length = (0 until 4).fold(0) { n, i -> (n shl 8) or (body[at + 1 + i].toInt() and 0xFF) }
                if (at + 5 + length > body.size) break
                val content = body.copyOfRange(at + 5, at + 5 + length)
                if (flag and 0x80 != 0) {
                    val trailers = content.toString(Charsets.UTF_8).lines().associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':', "").trim() }
                    trailers["grpc-status"]?.let { if (it != "0") throw IOException(grpcError(it, trailers["grpc-message"])) }
                } else if (data == null) {
                    data = content
                }
                at += 5 + length
            }
            return data ?: throw IOException("Empty answer")
        }

        private fun grpcError(code: String, message: String?): String {
            val text = message?.let { java.net.URLDecoder.decode(it, "UTF-8") }.orEmpty()
            return when (code) {
                "7" -> "the dish refused (permission denied)"
                "12" -> "this dish doesn't support it"
                else -> "the dish said error $code"
            } + if (text.isNotEmpty()) ": $text" else ""
        }
    }
}

/** Just enough protobuf to read the dish's answers: fields by number, varints, floats, strings, messages. */
object Proto {
    const val VARINT = 0
    const val FIXED64 = 1
    const val LENGTH = 2
    const val FIXED32 = 5

    class Value(val wire: Int, private val number: Long, private val data: ByteArray?) {
        fun long(): Long = number
        fun float(): Float = if (wire == FIXED32) java.lang.Float.intBitsToFloat(number.toInt()) else number.toFloat()
        fun bytes(): ByteArray = data ?: ByteArray(0)
        fun string(): String = bytes().toString(Charsets.UTF_8)
        fun packedFloats(): List<Float> {
            val b = bytes()
            return List(b.size / 4) { i ->
                val bits = (0 until 4).fold(0) { n, k -> n or ((b[4 * i + k].toInt() and 0xFF) shl (8 * k)) }
                java.lang.Float.intBitsToFloat(bits)
            }
        }
    }

    /** Calls `action` with each field's number and value, in order. */
    fun forEach(bytes: ByteArray, action: (Int, Value) -> Unit) {
        var at = 0
        fun varint(): Long {
            var result = 0L
            var shift = 0
            while (true) {
                if (at >= bytes.size) throw IOException("Truncated answer")
                val b = bytes[at++].toInt() and 0xFF
                result = result or ((b and 0x7F).toLong() shl shift)
                if (b < 0x80) return result
                shift += 7
                if (shift > 63) throw IOException("Bad answer")
            }
        }
        fun fixed(n: Int): Long {
            if (at + n > bytes.size) throw IOException("Truncated answer")
            var value = 0L
            for (k in 0 until n) value = value or ((bytes[at + k].toLong() and 0xFF) shl (8 * k))
            at += n
            return value
        }
        while (at < bytes.size) {
            val key = varint()
            val field = (key ushr 3).toInt()
            val value = when (val wire = (key and 7).toInt()) {
                VARINT -> Value(wire, varint(), null)
                FIXED64 -> Value(wire, fixed(8), null)
                FIXED32 -> Value(wire, fixed(4), null)
                LENGTH -> {
                    val length = varint().toInt()
                    if (length < 0 || at + length > bytes.size) throw IOException("Truncated answer")
                    Value(wire, 0, bytes.copyOfRange(at, at + length)).also { at += length }
                }
                else -> throw IOException("Bad answer (wire type $wire)")
            }
            action(field, value)
        }
    }

    /** The bytes of message field `number`, if present. */
    fun field(bytes: ByteArray, number: Int): ByteArray? {
        var found: ByteArray? = null
        forEach(bytes) { field, value -> if (field == number && value.wire == LENGTH) found = value.bytes() }
        return found
    }

    /** A message holding only field `number`, itself an empty message. */
    fun emptyMessageField(number: Int): ByteArray {
        var key = (number.toLong() shl 3) or LENGTH.toLong()
        val out = java.io.ByteArrayOutputStream()
        while (key >= 0x80) {
            out.write(((key and 0x7F) or 0x80).toInt())
            key = key ushr 7
        }
        out.write(key.toInt())
        out.write(0)
        return out.toByteArray()
    }
}
