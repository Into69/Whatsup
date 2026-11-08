package dev.whatsup.app

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * More about one aircraft, fetched when the user selects it (aircraft.js), each part on its own
 * so the sheet fills in as they arrive:
 *  - its route, from the callsign (hexdb.io): a database of scheduled routes, so it can be out of
 *    date or wrong for a callsign that is reused; the page checks it against where the aircraft is
 *  - the airframe (hexdb.io): maker, model and registered owner
 *  - the track it has flown on this leg (adsb.lol's trace files, as its own map uses)
 * Each is kept a while, as the user may tap between aircraft. Blocking: call off the main thread.
 */
class FlightInfo {
    private class Entry(val at: Long, val json: ByteArray)

    private val cache = HashMap<String, Entry>()
    /** Airports by ICAO code; they don't move. */
    private val airports = HashMap<String, JSONObject>()

    /**
     * { airports: [{ icao, iata, name, region, country, lat, lon }] in order flown, updatedAt (ms)
     * when the database last saw the route }, or { error: "none" } if it doesn't know the callsign.
     */
    fun route(callsign: String): ByteArray = cached("route/$callsign", ROUTE_MAX_AGE_MS) {
        if (!CALLSIGN.matches(callsign)) return@cached none()
        val route = try {
            JSONObject(Http.getBytes("https://hexdb.io/api/v1/route/icao/$callsign", readTimeoutMs = 10_000).toString(Charsets.UTF_8))
        } catch (e: Http.StatusException) {
            if (e.code == 404) return@cached none()
            throw e
        }
        val codes = route.optString("route").split('-').filter { ICAO_AIRPORT.matches(it) }
        if (codes.size < 2) return@cached none()
        JSONObject()
            .put("airports", JSONArray(codes.map(::airport)))
            .put("updatedAt", route.optLong("updatetime") * 1000)
            .toString().toByteArray()
    }

    /** { manufacturer, model, typeCode, owner, registration }, or { error: "none" }. */
    fun airframe(hex: String): ByteArray = cached("airframe/$hex", AIRFRAME_MAX_AGE_MS) {
        if (!ICAO_HEX.matches(hex)) return@cached none()
        val record = try {
            JSONObject(Http.getBytes("https://hexdb.io/api/v1/aircraft/$hex", readTimeoutMs = 10_000).toString(Charsets.UTF_8))
        } catch (e: Http.StatusException) {
            if (e.code == 404) return@cached none()
            throw e
        }
        JSONObject()
            .put("manufacturer", record.optString("Manufacturer"))
            .put("model", record.optString("Type"))
            .put("typeCode", record.optString("ICAOTypeCode"))
            .put("owner", record.optString("RegisteredOwners"))
            .put("registration", record.optString("Registration"))
            .toString().toByteArray()
    }

    /**
     * The track flown on the current leg: { points: [[time (ms), lat, lon, altitude ft, or -1 on the
     * ground, or null]] }, oldest first, or { error: "none" } if adsb.lol has none today. Today's
     * full trace, updated every few minutes, and the recent one, for the last of it.
     */
    fun track(hex: String): ByteArray = cached("track/$hex", TRACK_MAX_AGE_MS) {
        if (!ICAO_HEX.matches(hex)) return@cached none()
        val base = "https://globe.adsb.lol/data/traces/${hex.takeLast(2)}"
        val traces = listOf("full", "recent").mapNotNull { kind ->
            try {
                JSONObject(Http.getBytes("$base/trace_${kind}_$hex.json", readTimeoutMs = 20_000).toString(Charsets.UTF_8))
            } catch (e: Exception) {
                // No full trace for one first seen in the last few minutes, and so on.
                Log.w(TAG, "No $kind trace for $hex", e)
                null
            }
        }
        val points = legPoints(traces)
        if (points.isEmpty()) none() else JSONObject().put("points", JSONArray(points)).toString().toByteArray()
    }

    /**
     * The points of the leg under way from tar1090 trace files (today's full trace, then the recent
     * one): [time (ms), lat, lon, altitude ft, or -1 on the ground, or null], oldest first.
     */
    internal fun legPoints(traces: List<JSONObject>): List<JSONArray> {
        val points = ArrayList<JSONArray>()
        for (trace in traces) {
            val start = (trace.optDouble("timestamp") * 1000).toLong()
            val rows = trace.optJSONArray("trace") ?: continue
            val after = points.lastOrNull()?.getLong(0) ?: Long.MIN_VALUE
            for (i in 0 until rows.length()) {
                val row = rows.optJSONArray(i) ?: continue
                if (row.optDouble(1).isNaN() || row.optDouble(2).isNaN()) continue
                val time = start + (row.optDouble(0) * 1000).toLong()
                if (time <= after) continue
                // flags & 2: the start of a new leg; only the one under way is wanted.
                if (row.optInt(6) and 2 != 0) points.clear()
                val altitude = row.opt(3)
                points.add(
                    JSONArray()
                        .put(time)
                        .put(row.optDouble(1))
                        .put(row.optDouble(2))
                        .put(if (altitude == "ground") -1 else (altitude as? Number) ?: JSONObject.NULL),
                )
            }
        }
        return points
    }

    private fun airport(icao: String): JSONObject = synchronized(airports) { airports[icao] } ?: run {
        val found = try {
            JSONObject(Http.getBytes("https://hexdb.io/api/v1/airport/icao/$icao", readTimeoutMs = 10_000).toString(Charsets.UTF_8))
        } catch (e: Exception) {
            Log.w(TAG, "No airport $icao", e)
            null
        }
        val airport = JSONObject()
            .put("icao", icao)
            .put("iata", found?.optString("iata").orEmpty())
            .put("name", found?.optString("airport").orEmpty())
            .put("region", found?.optString("region_name").orEmpty())
            .put("country", found?.optString("country_code").orEmpty())
            .put("lat", found?.optDouble("latitude")?.takeUnless { it.isNaN() } ?: JSONObject.NULL)
            .put("lon", found?.optDouble("longitude")?.takeUnless { it.isNaN() } ?: JSONObject.NULL)
        if (found != null) synchronized(airports) { airports[icao] = airport }
        airport
    }

    /** From the cache if younger than maxAgeMs; else `fetch`, kept; or { error } if it fails. */
    private fun cached(key: String, maxAgeMs: Long, fetch: () -> ByteArray): ByteArray {
        synchronized(cache) {
            cache[key]?.takeIf { System.currentTimeMillis() - it.at < maxAgeMs }?.let { return it.json }
        }
        if (Http.offline) return AircraftFeed.error("offline")
        return try {
            fetch().also { json -> synchronized(cache) { cache[key] = Entry(System.currentTimeMillis(), json) } }
        } catch (e: Exception) {
            Log.w(TAG, "$key failed", e)
            AircraftFeed.error("unavailable")
        }
    }

    private fun none() = AircraftFeed.error("none")

    private companion object {
        const val TAG = "FlightInfo"
        const val ROUTE_MAX_AGE_MS = 60 * 60_000L
        const val AIRFRAME_MAX_AGE_MS = 24 * 60 * 60_000L
        /** The page adds live positions itself after this, so a short life is enough. */
        const val TRACK_MAX_AGE_MS = 60_000L
        val CALLSIGN = Regex("[A-Z0-9]{2,8}")
        val ICAO_HEX = Regex("[0-9a-f]{6}")
        val ICAO_AIRPORT = Regex("[A-Z0-9]{4}")
    }
}
