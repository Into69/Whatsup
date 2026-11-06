package dev.whatsup.app

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDateTime
import java.time.ZoneOffset

/**
 * Close approaches between objects in orbit, from CelesTrak's SOCRATES: the next week's predicted
 * conjunctions, sorted closest first. The whole list is about 22 MB, so it is only fetched when the
 * user asks for it (and at most every [MAX_AGE_MS]); what the page gets is cut down to the closest
 * approaches overall and those involving satellites it shows or the user has starred.
 */
class ConjunctionFeed(context: Context, private val tracker: DownloadTracker) {
    private val file = File(File(context.cacheDir, "feeds"), "socrates.csv")

    /**
     * The page's close approaches as JSON: { updatedAt, rows: [[id1, name1, id2, name2, tca (ms),
     * range (km), relative speed (km/s), probability]] }, closest first; null if there is no copy
     * and the download fails. Blocking: call off the main thread.
     */
    fun load(shown: Set<Int>, starred: Set<Int>): ByteArray? {
        if (!file.exists() || System.currentTimeMillis() - file.lastModified() > MAX_AGE_MS) {
            try {
                tracker.downloadTo(URL, file, KEY, "SOCRATES close approaches")
            } catch (e: Exception) {
                Log.w(TAG, "Download failed; cached: ${file.exists()}", e)
            }
        }
        if (!file.exists()) return null
        return try {
            select(shown, starred).toString().toByteArray()
        } catch (e: Exception) {
            Log.w(TAG, "Reading $file failed", e)
            null
        }
    }

    private fun select(shown: Set<Int>, starred: Set<Int>): JSONObject {
        val rows = JSONArray()
        var anyKept = 0
        var shownKept = 0
        val since = System.currentTimeMillis() - PAST_MS
        file.bufferedReader().useLines { lines ->
            val iterator = lines.iterator()
            if (!iterator.hasNext()) return@useLines
            val header = splitCsv(iterator.next())
            val column = { name: String -> header.indexOf(name).also { check(it >= 0) { "No $name column" } } }
            val id1 = column("NORAD_CAT_ID_1")
            val name1 = column("OBJECT_NAME_1")
            val id2 = column("NORAD_CAT_ID_2")
            val name2 = column("OBJECT_NAME_2")
            val tca = column("TCA")
            val range = column("TCA_RANGE")
            val speed = column("TCA_RELATIVE_SPEED")
            val probability = column("MAX_PROB")
            for (line in iterator) {
                if (line.isBlank()) continue
                val fields = splitCsv(line)
                if (fields.size < header.size) continue
                val a = fields[id1].toIntOrNull() ?: continue
                val b = fields[id2].toIntOrNull() ?: continue
                val at = parseTca(fields[tca]) ?: continue
                if (at < since) continue
                // The list is closest first, so the first rows of each kind are the ones to keep.
                val keep = when {
                    a in starred || b in starred -> true
                    (a in shown || b in shown) && shownKept < MAX_SHOWN -> { shownKept++; true }
                    anyKept < MAX_ANY -> { anyKept++; true }
                    else -> false
                }
                if (!keep) continue
                rows.put(JSONArray()
                    .put(a).put(cleanName(fields[name1]))
                    .put(b).put(cleanName(fields[name2]))
                    .put(at)
                    .put(fields[range].toDoubleOrNull() ?: 0.0)
                    .put(fields[speed].toDoubleOrNull() ?: 0.0)
                    .put(fields[probability].toDoubleOrNull() ?: 0.0))
            }
        }
        return JSONObject().put("updatedAt", file.lastModified()).put("rows", rows)
    }

    /** "2026-11-07 04:17:16.388", in UTC. */
    private fun parseTca(text: String): Long? = try {
        LocalDateTime.parse(text.trim().replace(' ', 'T')).toInstant(ZoneOffset.UTC).toEpochMilli()
    } catch (e: Exception) {
        null
    }

    /** SOCRATES marks names with an operational status, e.g. "STARLINK-4429 [+]". */
    private fun cleanName(name: String) = name.replace(STATUS_MARK, "").trim()

    private companion object {
        const val TAG = "ConjunctionFeed"
        const val KEY = "socrates"
        const val URL = "https://celestrak.org/SOCRATES/sort-minRange.csv"
        /** SOCRATES is recomputed a few times a day. */
        const val MAX_AGE_MS = 12 * 60 * 60 * 1000L
        /** Approaches just past still show, so the user can step back to them. */
        const val PAST_MS = 60 * 60 * 1000L
        const val MAX_ANY = 100
        const val MAX_SHOWN = 400
        val STATUS_MARK = Regex("""\s*\[[^\]]*]\s*$""")
    }
}

/**
 * Upcoming launches worldwide, from The Space Devs' Launch Library 2. Its free tier allows 15
 * requests an hour, so a copy is kept for [MAX_AGE_MS] and the old one used if a fetch fails.
 */
class LaunchFeed(context: Context) {
    private val file = File(File(context.cacheDir, "feeds"), "launches.json")

    /**
     * The page's launch list as JSON: { updatedAt, launches: [{ name, net (ms), status, statusName,
     * provider, rocket, mission, orbit, pad, location, lat, lon }] }, or null with no copy and no
     * connection. Blocking: call off the main thread.
     */
    @Synchronized
    fun load(): ByteArray? {
        if (!file.exists() || System.currentTimeMillis() - file.lastModified() > MAX_AGE_MS) {
            try {
                download()
            } catch (e: Exception) {
                Log.w(TAG, "Download failed; cached: ${file.exists()}", e)
            }
        }
        if (!file.exists()) return null
        return try {
            compact(JSONObject(file.readText())).toString().toByteArray()
        } catch (e: Exception) {
            Log.w(TAG, "Reading $file failed", e)
            null
        }
    }

    private fun download() {
        val connection = URL(URL).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.setRequestProperty("User-Agent", USER_AGENT)
        try {
            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) error("HTTP $code")
            val text = connection.inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
            JSONObject(text) // Check it is whole before replacing the copy.
            file.parentFile?.mkdirs()
            file.writeText(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun compact(response: JSONObject): JSONObject {
        val launches = JSONArray()
        val results = response.optJSONArray("results") ?: JSONArray()
        for (i in 0 until results.length()) {
            val launch = results.getJSONObject(i)
            val net = try {
                java.time.Instant.parse(launch.getString("net")).toEpochMilli()
            } catch (e: Exception) {
                continue
            }
            val pad = launch.optJSONObject("pad") ?: continue
            val mission = launch.optJSONObject("mission")
            val status = launch.optJSONObject("status")
            launches.put(JSONObject()
                .put("name", launch.optString("name"))
                .put("net", net)
                .put("status", status?.optString("abbrev").orEmpty())
                .put("statusName", status?.optString("name").orEmpty())
                .put("provider", launch.optJSONObject("launch_service_provider")?.optString("name").orEmpty())
                .put("rocket", launch.optJSONObject("rocket")?.optJSONObject("configuration")?.optString("full_name").orEmpty())
                .put("mission", mission?.optString("description").orEmpty())
                .put("orbit", mission?.optJSONObject("orbit")?.optString("abbrev").orEmpty())
                .put("pad", pad.optString("name"))
                .put("location", pad.optJSONObject("location")?.optString("name").orEmpty())
                .put("lat", pad.optDouble("latitude"))
                .put("lon", pad.optDouble("longitude")))
        }
        return JSONObject().put("updatedAt", file.lastModified()).put("launches", launches)
    }

    private companion object {
        const val TAG = "LaunchFeed"
        const val URL = "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=30&mode=normal"
        const val MAX_AGE_MS = 60 * 60 * 1000L
    }
}

/** Splits a CSV row, allowing quoted fields (a name with a comma in it). */
fun splitCsv(line: String): List<String> {
    val fields = mutableListOf<String>()
    val field = StringBuilder()
    var quoted = false
    var i = 0
    while (i < line.length) {
        val c = line[i]
        when {
            quoted && c == '"' && line.getOrNull(i + 1) == '"' -> { field.append('"'); i++ }
            c == '"' -> quoted = !quoted
            c == ',' && !quoted -> { fields += field.toString(); field.clear() }
            c != '\r' -> field.append(c)
        }
        i++
    }
    fields += field.toString()
    return fields
}
