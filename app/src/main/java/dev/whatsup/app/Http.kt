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
        onProgress: ((Long, Long) -> Unit)? = null,
    ): Long {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = CONNECT_TIMEOUT_MS
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
    fun getBytes(url: String, readTimeoutMs: Int = 30_000): ByteArray =
        ByteArrayOutputStream().also { get(url, it, readTimeoutMs) }.toByteArray()
}
