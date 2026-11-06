package dev.whatsup.app

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Looks satellites up in CelesTrak's satellite catalogue (SATCAT): owner, object type, launch date
 * and operational status. One small request per satellite, made when the user taps it, and kept for
 * a week since these details rarely change.
 */
class SatelliteCatalog(context: Context) {
    private val dir = File(context.cacheDir, "satcat")

    /**
     * The catalogue record as CelesTrak's JSON (an array of one object), or null if there is none and
     * nothing cached. Blocks on the network, so call it off the main thread; WebView path handlers
     * already are.
     */
    fun lookup(noradId: Int): ByteArray? {
        val file = File(dir, "$noradId.json")
        val cached = file.takeIf { it.exists() }?.readBytes()
        if (cached != null && System.currentTimeMillis() - file.lastModified() < MAX_AGE_MS) return cached
        return try {
            val connection = URL("https://celestrak.org/satcat/records.php?CATNR=$noradId&FORMAT=json")
                .openConnection() as HttpURLConnection
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.setRequestProperty("User-Agent", USER_AGENT)
            try {
                if (connection.responseCode != HttpURLConnection.HTTP_OK) error("HTTP ${connection.responseCode}")
                val body = connection.inputStream.use { it.readBytes() }
                if (body.firstOrNull() != '['.code.toByte()) error("Not JSON: ${String(body).take(200)}")
                dir.mkdirs()
                file.writeBytes(body)
                body
            } finally {
                connection.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "SATCAT lookup of $noradId failed; cached: ${cached != null}", e)
            cached
        }
    }

    private companion object {
        const val TAG = "SatelliteCatalog"
        const val MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000L
    }
}
