package dev.whatsup.app

import android.content.Context
import android.util.Log
import androidx.annotation.StringRes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import kotlin.math.PI
import kotlin.math.cbrt

private const val ACTIVE = "GROUP=active"
/** Mean altitude where low Earth orbit ends and medium Earth orbit begins. */
private const val LEO_CEILING_KM = 2000.0
/** Below geostationary (35,786 km), leaving the GEO group the satellites near it. */
private const val MEO_CEILING_KM = 35000.0
/** Orbits at least this eccentric are HEO, whatever their altitude. */
private const val HEO_ECCENTRICITY = 0.25

/**
 * Low Earth orbit constellations with their own groups, and the name prefixes that pick out their
 * satellites from the active list. Each operator names every satellite the same way, so a prefix is
 * reliable; CelesTrak's own constellation groups would mean downloading the same satellites again.
 */
private val STARLINK_NAMES = listOf("STARLINK")
private val ONEWEB_NAMES = listOf("ONEWEB")
/** Amazon's constellation, still catalogued under its project name, Kuiper. */
private val AMAZON_LEO_NAMES = listOf("KUIPER")
private val QIANFAN_NAMES = listOf("QIANFAN")
/** China's SatNet (Guowang), catalogued as "HULIANWANG" (internet), with its test satellites. */
private val GUOWANG_NAMES = listOf("HULIANWANG")
private val IRIDIUM_NAMES = listOf("IRIDIUM")
private val GLOBALSTAR_NAMES = listOf("GLOBALSTAR")
private val ORBCOMM_NAMES = listOf("ORBCOMM")
private val PLANET_NAMES = listOf("FLOCK", "SKYSAT", "PELICAN")
private val SPIRE_NAMES = listOf("LEMUR")
private val LEO_CONSTELLATIONS = listOf(
    STARLINK_NAMES, ONEWEB_NAMES, AMAZON_LEO_NAMES, QIANFAN_NAMES, GUOWANG_NAMES,
    IRIDIUM_NAMES, GLOBALSTAR_NAMES, ORBCOMM_NAMES, PLANET_NAMES, SPIRE_NAMES,
).flatten()

private fun ElementSet.isLeo() = eccentricity < HEO_ECCENTRICITY && meanAltitudeKm < LEO_CEILING_KM

private fun ElementSet.named(prefixes: List<String>) = prefixes.any { name.startsWith(it) }

/**
 * A set of satellites from one or more CelesTrak queries, with its own switch in settings and its
 * own dot colour. Featured satellites always show their label, orbit and ground track; the rest are
 * dots that show those only when tapped.
 *
 * Order matters: a satellite in several groups (the ISS is also in "stations", GPS satellites also
 * fall in MEO) is shown once, as a member of the first shown group here that has it.
 */
enum class SatelliteGroup(
    val key: String,
    /** Its switch in settings. */
    @StringRes val title: Int,
    /** CelesTrak gp.php queries whose results together make the group. */
    val queries: List<String>,
    /** Dot colour, 0xRRGGBB. */
    val color: Int,
    /** Dot diameter in CSS pixels. */
    val dotSize: Double = 3.5,
    val featured: Boolean = false,
    val shownByDefault: Boolean = false,
    /** Hidden when zoomed far out, where thousands of low dots would only bury the globe. */
    val lowOrbit: Boolean = false,
    /** Keeps only the matching satellites of what [queries] return. */
    val filter: ((ElementSet) -> Boolean)? = null,
) {
    ISS("iss", R.string.show_iss, listOf("CATNR=25544"), 0xFFD166, featured = true, shownByDefault = true),
    STATIONS("stations", R.string.show_stations, listOf("GROUP=stations"), 0xFFFFFF, shownByDefault = true),
    RECENT("recent", R.string.show_recent, listOf("GROUP=last-30-days"), 0xFF8C42),
    GNSS("gnss", R.string.show_gnss, listOf("GROUP=gnss"), 0x7CF29C, shownByDefault = true),
    WEATHER("weather", R.string.show_weather, listOf("GROUP=weather"), 0x5FA8FF),
    AMATEUR("amateur", R.string.show_amateur, listOf("GROUP=amateur"), 0xFFE066),
    SATNOGS("satnogs", R.string.show_satnogs, listOf("GROUP=satnogs"), 0xC0A0FF),
    X_COMM("x-comm", R.string.show_x_comm, listOf("GROUP=x-comm"), 0xFF66E0),
    OTHER_COMM("other-comm", R.string.show_other_comm, listOf("GROUP=other-comm"), 0x9FB4C8),
    /** CelesTrak's "Active Geosynchronous" group. */
    GEO("geo", R.string.show_geo, listOf("GROUP=geo"), 0x6EE7FF, shownByDefault = true),
    /** Everything in or near the GEO belt; after GEO, so this is the inactive satellites and debris there. */
    GPZ("gpz", R.string.show_gpz, listOf("SPECIAL=gpz"), 0x8C7BFF),
    /**
     * Highly elliptical orbits. CelesTrak has no such group, nor MEO or LEO ones, so these three are
     * every active satellite (about 16,000) cut down by orbit shape and height.
     */
    HEO(
        "heo", R.string.show_heo, listOf(ACTIVE), 0xFF7EB6,
        shownByDefault = true, filter = { it.eccentricity >= HEO_ECCENTRICITY },
    ),
    MEO(
        "meo", R.string.show_meo, listOf(ACTIVE), 0xC6F25A,
        filter = { it.eccentricity < HEO_ECCENTRICITY && it.meanAltitudeKm in LEO_CEILING_KM..MEO_CEILING_KM },
    ),
    STARLINK("starlink", R.string.show_starlink, listOf(ACTIVE), 0xD0D8E8, dotSize = 2.0, lowOrbit = true, filter = { it.named(STARLINK_NAMES) }),
    ONEWEB("oneweb", R.string.show_oneweb, listOf(ACTIVE), 0xF2A0FF, dotSize = 2.5, lowOrbit = true, filter = { it.named(ONEWEB_NAMES) }),
    AMAZON_LEO("amazon-leo", R.string.show_amazon_leo, listOf(ACTIVE), 0xFFB347, dotSize = 2.5, lowOrbit = true, filter = { it.named(AMAZON_LEO_NAMES) }),
    QIANFAN("qianfan", R.string.show_qianfan, listOf(ACTIVE), 0x4DD0C8, dotSize = 2.5, lowOrbit = true, filter = { it.named(QIANFAN_NAMES) }),
    GUOWANG("guowang", R.string.show_guowang, listOf(ACTIVE), 0xE8706F, dotSize = 2.5, lowOrbit = true, filter = { it.named(GUOWANG_NAMES) }),
    IRIDIUM("iridium", R.string.show_iridium, listOf(ACTIVE), 0x8FA8FF, dotSize = 2.5, lowOrbit = true, filter = { it.named(IRIDIUM_NAMES) }),
    GLOBALSTAR("globalstar", R.string.show_globalstar, listOf(ACTIVE), 0xA6E3FF, dotSize = 2.5, lowOrbit = true, filter = { it.named(GLOBALSTAR_NAMES) }),
    ORBCOMM("orbcomm", R.string.show_orbcomm, listOf(ACTIVE), 0xC9A27E, dotSize = 2.5, lowOrbit = true, filter = { it.named(ORBCOMM_NAMES) }),
    PLANET("planet", R.string.show_planet, listOf(ACTIVE), 0x9BE15D, dotSize = 2.5, lowOrbit = true, filter = { it.named(PLANET_NAMES) }),
    SPIRE("spire", R.string.show_spire, listOf(ACTIVE), 0xF7E07A, dotSize = 2.5, lowOrbit = true, filter = { it.named(SPIRE_NAMES) }),
    /** Whatever low Earth orbit satellites the constellation groups above don't take. */
    LEO(
        "leo", R.string.show_leo, listOf(ACTIVE), 0x7F8A9E, dotSize = 2.0, lowOrbit = true,
        filter = { it.isLeo() && !it.named(LEO_CONSTELLATIONS) },
    ),
    /** The three big debris clouds: the 2007 Chinese ASAT test, and the 2009 Iridium-Cosmos collision. */
    DEBRIS(
        "debris", R.string.show_debris,
        listOf("GROUP=fengyun-1c-debris", "GROUP=iridium-33-debris", "GROUP=cosmos-2251-debris"),
        0xFF5A4E, dotSize = 2.0, lowOrbit = true,
    ),
    ;

    /** How the page draws the group, with [label] for its legend; see satellites.js. */
    fun styleJson(label: String): JSONObject = JSONObject()
        .put("color", "#%06X".format(color))
        .put("size", dotSize)
        .put("featured", featured)
        .put("lowOrbit", lowOrbit)
        .put("label", label)
}

/**
 * One satellite's orbital elements in CelesTrak's OMM CSV form, which SGP4 (satellite.js's
 * json2satrec) propagates into positions. Unlike TLEs, OMM carries the full name (TLEs cut it at 24
 * characters) and the international designator.
 *
 * [values] are in the order of the CSV header, [columns]. Read once per download and shared by every
 * group cut from it: the active list's 16,000 rows feed over a dozen groups.
 */
class OmmRow(val columns: List<String>, val values: List<String>) {
    private fun field(name: String): String = values.getOrElse(columns.indexOf(name)) { "" }

    val noradId: Int = field("NORAD_CAT_ID").toIntOrNull() ?: 0

    /** CelesTrak's name, e.g. "STARLINK-1007". */
    val name: String = field("OBJECT_NAME")

    val eccentricity: Double = field("ECCENTRICITY").toDoubleOrNull() ?: 0.0

    /** Semi-major axis less the Earth's radius, from the mean motion (revolutions a day). */
    val meanAltitudeKm: Double = field("MEAN_MOTION").toDoubleOrNull()?.let { revolutionsPerDay ->
        val radiansPerSecond = revolutionsPerDay * 2 * PI / 86_400
        cbrt(EARTH_MU / (radiansPerSecond * radiansPerSecond)) - EARTH_RADIUS_KM
    } ?: 0.0

    private companion object {
        const val EARTH_MU = 398_600.4418
        const val EARTH_RADIUS_KM = 6378.137
    }
}

/** A satellite's elements ([row]) as shown in one [group]. */
class ElementSet(val group: SatelliteGroup, private val row: OmmRow) {
    val columns: List<String> get() = row.columns
    val noradId: Int get() = row.noradId
    val name: String get() = row.name
    val eccentricity: Double get() = row.eccentricity
    val meanAltitudeKm: Double get() = row.meanAltitudeKm

    /** One entry of the page's satellite list: the group key, then the row's values. */
    fun toJson(): JSONArray = JSONArray().put(group.key).apply { row.values.forEach { put(it) } }
}

/**
 * Fetches orbital elements from CelesTrak and caches each query's response on disk. CelesTrak asks
 * clients not to fetch the same data more than once every two hours, so a cached copy younger than
 * that is used as is, and an older one is still used when the network fails: SGP4 stays accurate to
 * a few km for days. Groups sharing a query (LEO, MEO and HEO all cut down the active list) share
 * one download.
 */
class ElementSetRepository(context: Context, private val tracker: DownloadTracker) {
    private val dir = File(context.cacheDir, "elements")
    /** One get() at a time: groups sharing a query don't fetch it twice, and the memos below stay consistent. */
    private val mutex = Mutex()

    /**
     * Bumped each time a query's file is rewritten, so the memos below know when to parse again.
     * (The file's modification time won't do: a "not updated" answer touches it without changing it.)
     */
    private val generations = HashMap<String, Int>()

    /** A query's parsed CSV, kept until its file is rewritten; the active list is 16,000 rows. */
    private class Rows(val generation: Int, val rows: List<OmmRow>)
    private val rowsByQuery = HashMap<String, Rows>()

    /**
     * A group's satellites, kept while its queries' files are unchanged. Returning the same objects
     * lets MainActivity see cheaply that nothing changed.
     */
    private class GroupSets(val generations: List<Int>, val sets: List<ElementSet>)
    private val setsByGroup = HashMap<SatelliteGroup, GroupSets>()

    init {
        // Before OMM CSV, the app cached TLEs here.
        File(context.cacheDir, "tle").deleteRecursively()
    }

    /**
     * When the group's data was last fetched or confirmed current (the oldest of its queries), or 0 if
     * it never has been. Old data means the phone has been offline.
     */
    fun updatedAt(group: SatelliteGroup): Long =
        group.queries.minOf { query -> fileFor(query).takeIf { it.exists() }?.lastModified() ?: 0L }

    private fun fileFor(query: String) = File(dir, query.replace(Regex("[^A-Za-z0-9-]"), "_") + ".csv")

    private fun nameFor(query: String) = query.substringAfter('=') + ".csv"

    private fun isStale(file: File) = !file.exists() || System.currentTimeMillis() - file.lastModified() >= MAX_AGE_MS

    /**
     * Puts the groups' files that are due a download in the progress panel's queue, so it can say
     * from the start how many there are. [get] then takes them off one by one.
     */
    fun queue(groups: List<SatelliteGroup>) {
        for (query in groups.flatMap { it.queries }.distinct()) {
            if (isStale(fileFor(query))) tracker.queue(query, nameFor(query))
        }
    }

    suspend fun get(group: SatelliteGroup): List<ElementSet> = withContext(Dispatchers.IO) {
        mutex.withLock {
            val files = group.queries.associateWith { fetch(it) }
            val generations = group.queries.map { generations[it] ?: 0 }
            setsByGroup[group]?.takeIf { it.generations == generations }?.let { return@withLock it.sets }
            val all = files.flatMap { (query, file) ->
                rows(query, file).rows.map { ElementSet(group, it) }
            }
            val sets = group.filter?.let { all.filter(it) } ?: all
            setsByGroup[group] = GroupSets(generations, sets)
            sets
        }
    }

    /**
     * The query's file, downloaded again first if the cached one is too old; null if there is none.
     * A failed download leaves the old file, if any, in use.
     */
    private fun fetch(query: String): File? {
        val name = nameFor(query)
        val file = fileFor(query)
        val cached = file.exists()
        if (cached && !isStale(file)) {
            // Queued, but another group's fetch has since brought it up to date.
            tracker.unqueue(query)
            return file
        }
        try {
            val text = download(query, name)
            if (text == null) {
                // CelesTrak has nothing newer than this device's last download. With a cached copy,
                // that copy is current; without one (the cache was cleared since), there is nothing
                // to show until CelesTrak will send it again, which is a failure, not "up to date".
                if (!cached) error("Refused as not updated, but nothing is cached")
                file.setLastModified(System.currentTimeMillis())
                report(query, name, state = Download.State.NOT_UPDATED)
                return file
            }
            // CelesTrak answers an empty group (e.g. no launches lately) with this instead of a CSV.
            if (!text.startsWith(HEADER_START) && !text.contains(NO_DATA)) error("Not OMM CSV: ${text.take(200)}")
            dir.mkdirs()
            file.writeText(text)
            generations[query] = (generations[query] ?: 0) + 1
            report(query, name, state = Download.State.DONE)
        } catch (e: Exception) {
            Log.w(TAG, "Fetch of $query failed; cached: $cached", e)
            report(query, name, state = Download.State.FAILED)
        }
        return file.takeIf { it.exists() }
    }

    /** The query's file parsed, from [rowsByQuery] unless it has been rewritten since. */
    private fun rows(query: String, file: File?): Rows {
        val generation = generations[query] ?: 0
        rowsByQuery[query]?.takeIf { it.generation == generation }?.let { return it }
        val lines = file?.readText()?.lineSequence()?.filter { it.isNotBlank() }?.map(::splitCsv)?.toList().orEmpty()
        val columns = lines.firstOrNull()?.takeIf { it.firstOrNull() == "OBJECT_NAME" }
        val parsed = Rows(
            generation,
            if (columns == null) emptyList()
            else lines.drop(1).filter { it.size == columns.size }.map { OmmRow(columns, it) }.filter { it.noradId > 0 },
        )
        rowsByQuery[query] = parsed
        return parsed
    }

    /**
     * The query's response, reporting progress to [downloads] as it arrives, or null when CelesTrak
     * refuses because it has nothing newer than what this device last fetched (its two-hour rule).
     */
    private fun download(query: String, name: String): String? {
        val out = ByteArrayOutputStream(64 * 1024)
        try {
            report(query, name, bytesRead = 0, totalBytes = -1)
            Http.get("https://celestrak.org/NORAD/elements/gp.php?$query&FORMAT=csv", out, readTimeoutMs = 60_000) { read, total ->
                report(query, name, bytesRead = read, totalBytes = total)
            }
        } catch (e: Http.StatusException) {
            if (e.code == HttpURLConnection.HTTP_FORBIDDEN && NOT_UPDATED in e.body) return null
            throw e
        }
        return out.toString(Charsets.UTF_8.name())
    }

    private fun report(
        query: String,
        name: String,
        bytesRead: Long? = null,
        totalBytes: Long? = null,
        state: Download.State = Download.State.RUNNING,
    ) = tracker.report(query, name, bytesRead, totalBytes, state)

    private companion object {
        const val TAG = "ElementSetRepository"
        const val MAX_AGE_MS = 2 * 60 * 60 * 1000L
        const val HEADER_START = "OBJECT_NAME,"
        const val NO_DATA = "No GP data found"
        /** Start of CelesTrak's 403 message when a query is fetched again within two hours. */
        const val NOT_UPDATED = "GP data has not updated"
    }
}

