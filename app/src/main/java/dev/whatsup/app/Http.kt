package dev.whatsup.app

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

val USER_AGENT = "WhatsUp/${BuildConfig.VERSION_NAME} (Android)"

/**
 * GET requests as the app makes them all: with its own User-Agent (OpenStreetMap's tile policy and
 * CelesTrak ask clients to identify themselves), timeouts, and anything but 200 OK as an error.
 * Blocking: call off the main thread.
 */
object Http {
    private const val CONNECT_TIMEOUT_MS = 15_000
    /** How often, in bytes read, progress is reported. */
    const val REPORT_EVERY_BYTES = 32 * 1024L

    /**
     * Offline mode, set from Settings: every request fails at once with [OfflineException], so
     * nothing goes out and callers fall back on their saved copies.
     */
    @Volatile
    var offline = false

    class OfflineException : IOException("Offline mode is on")

    /** A response other than 200 OK, with its body, for callers that read the reason. */
    class StatusException(val code: Int, val body: String) : IOException("HTTP $code")

    /**
     * Streams `url`'s body into `out`, calling `onProgress(bytesRead, totalBytes)` as it arrives
     * (totalBytes is -1 when the server doesn't say), and returns the number of bytes read.
     */
    fun get(
        url: String,
        out: OutputStream,
        readTimeoutMs: Int = 30_000,
        connectTimeoutMs: Int = CONNECT_TIMEOUT_MS,
        allowLocalHttp: Boolean = false,
        onProgress: ((Long, Long) -> Unit)? = null,
    ): Long {
        if (offline) throw OfflineException()
        val address = URL(url)
        // The manifest allows cleartext for the user's own ADS-B receiver; this keeps it to that.
        if (address.protocol != "https" && !(allowLocalHttp && address.protocol == "http" && isLocalHost(address.host))) {
            throw IOException("Only HTTPS, or HTTP to this network, is allowed: $url")
        }
        val connection = address.openConnection() as HttpURLConnection
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.setRequestProperty("User-Agent", USER_AGENT)
        try {
            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) {
                val body = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                throw StatusException(code, body)
            }
            val total = connection.contentLengthLong
            onProgress?.invoke(0, total)
            var read = 0L
            var reported = 0L
            connection.inputStream.use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    read += n
                    if (onProgress != null && read - reported >= REPORT_EVERY_BYTES) {
                        reported = read
                        onProgress(read, total)
                    }
                }
            }
            onProgress?.invoke(read, total)
            return read
        } finally {
            connection.disconnect()
        }
    }

    /** `url`'s whole body. */
    fun getBytes(
        url: String,
        readTimeoutMs: Int = 30_000,
        connectTimeoutMs: Int = CONNECT_TIMEOUT_MS,
        allowLocalHttp: Boolean = false,
    ): ByteArray = ByteArrayOutputStream().also { get(url, it, readTimeoutMs, connectTimeoutMs, allowLocalHttp) }.toByteArray()

    /**
     * Whether `host` is on the local network: a private, link-local or loopback IPv4 address, a
     * one-word name ("raspberrypi") or a .local, .lan or .home.arpa name.
     */
    fun isLocalHost(host: String): Boolean {
        val name = host.lowercase().trimEnd('.')
        val octets = name.split('.').map { it.toIntOrNull() }
        if (octets.size == 4 && octets.all { it != null && it in 0..255 }) {
            val (a, b) = octets.map { it!! }
            return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b in 16..31) || (a == 169 && b == 254)
        }
        return name == "localhost" || '.' !in name ||
            listOf(".local", ".lan", ".home.arpa").any { name.endsWith(it) }
    }
}
