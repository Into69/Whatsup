package dev.whatsup.app

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** A WhatsUp on GitHub: its version, and this app's file in it (its address, size and SHA-256 if GitHub gives one). */
data class Release(val version: String, val url: String, val sizeBytes: Long, val sha256: String?)

/**
 * Newer versions of the app: the latest release on GitHub, whose tag is "v" and the version
 * (versionName), with the APK attached as whatsup.apk. MainActivity checks once a day, if the user
 * lets it (Settings.checkUpdates), and offers it on the globe (globe.showUpdate); SettingsActivity
 * checks when asked. Updating downloads the APK with the other downloads' progress panel and hands
 * it to the system's installer.
 */
object Updates {
    const val LATEST_URL = "https://api.github.com/repos/Into69/Whatsup/releases/latest"
    const val ASSET = "whatsup.apk"
    /** How often MainActivity looks by itself. */
    const val CHECK_EVERY_MS = 24 * 60 * 60 * 1000L
    /** The download's key in DownloadTracker. */
    const val DOWNLOAD_KEY = "app-update"

    /**
     * The update the user asked for in SettingsActivity, for MainActivity to download and install
     * on coming back (where the progress panel is).
     */
    @Volatile
    var requested: Release? = null

    /** The latest release with [asset] attached, from GitHub's release JSON; null if it has no such file. */
    fun parse(json: String, asset: String = ASSET): Release? {
        val release = JSONObject(json)
        val version = release.optString("tag_name").removePrefix("v").ifEmpty { return null }
        val assets = release.optJSONArray("assets") ?: return null
        for (i in 0 until assets.length()) {
            val file = assets.getJSONObject(i)
            if (file.optString("name") != asset) continue
            val digest = file.optString("digest")
            return Release(
                version,
                file.optString("browser_download_url").ifEmpty { return null },
                file.optLong("size", -1),
                if (digest.startsWith("sha256:")) digest.removePrefix("sha256:").lowercase() else null,
            )
        }
        return null
    }

    /** Whether [version] comes after [than]: "0.10" after "0.9", "1.0" after "0.9.5", "0.3" after "0.3-beta"... numerically, part by part. */
    fun isNewer(version: String, than: String): Boolean {
        val a = parts(version)
        val b = parts(than)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    private fun parts(version: String): List<Int> =
        version.trim().removePrefix("v").split('.').map { part -> part.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }

    /** The latest release, newer or not; null if it has no APK. Blocking; throws if GitHub can't be reached. */
    fun latest(): Release? = parse(String(Http.getBytes(LATEST_URL), Charsets.UTF_8))

    /** The latest release if it is newer than this app; else null. Blocking; throws if GitHub can't be reached. */
    fun newer(): Release? = latest()?.takeIf { isNewer(it.version, BuildConfig.VERSION_NAME) }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
