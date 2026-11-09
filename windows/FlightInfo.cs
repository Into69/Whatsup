using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace WhatsUp;

/**
 * More about one aircraft, fetched when the user selects it (aircraft.js), each part on its own
 * so the sheet fills in as they arrive:
 *  - its route, from the callsign (hexdb.io): a database of scheduled routes, so it can be out of
 *    date or wrong for a callsign that is reused; the page checks it against where the aircraft is
 *  - the airframe (hexdb.io): maker, model and registered owner
 *  - the track it has flown on this leg (adsb.lol's trace files, as its own map uses)
 * Each is kept a while, as the user may click between aircraft. Blocking: call off the UI thread.
 */
sealed partial class FlightInfo
{
    const string Tag = "FlightInfo";
    const long RouteMaxAgeMs = 60 * 60_000;
    const long AirframeMaxAgeMs = 24 * 60 * 60_000;
    /** The page adds live positions itself after this, so a short life is enough. */
    const long TrackMaxAgeMs = 60_000;

    [GeneratedRegex("^[A-Z0-9]{2,8}$")] private static partial Regex Callsign();
    [GeneratedRegex("^[0-9a-f]{6}$")] private static partial Regex IcaoHex();
    [GeneratedRegex("^[A-Z0-9]{4}$")] private static partial Regex IcaoAirport();

    sealed record Entry(long At, byte[] Json);
    readonly Dictionary<string, Entry> cache = [];
    /** Airports by ICAO code; they don't move. */
    readonly Dictionary<string, JsonObject> airports = [];

    /** Missing (404) is "none", not a failure. */
    sealed class NoneException : Exception;

    static JsonObject Fetch(string url, int readTimeoutMs)
    {
        try
        {
            return Json.Parse(Http.GetBytes(url, readTimeoutMs));
        }
        catch (Http.StatusException e) when (e.Code == 404)
        {
            throw new NoneException();
        }
    }

    /**
     * { airports: [{ icao, iata, name, region, country, lat, lon }] in order flown, updatedAt (ms)
     * when the database last saw the route }, or { error: "none" } if it doesn't know the callsign.
     */
    public byte[] Route(string callsign) => Cached($"route/{callsign}", RouteMaxAgeMs, () =>
    {
        if (!Callsign().IsMatch(callsign)) return None();
        var route = Fetch($"https://hexdb.io/api/v1/route/icao/{callsign}", 10_000);
        var codes = Json.Text(route, "route").Split('-').Where(code => IcaoAirport().IsMatch(code)).ToList();
        if (codes.Count < 2) return None();
        return Json.Bytes(new JsonObject
        {
            ["airports"] = new JsonArray(codes.Select(c => (JsonNode)Airport(c).DeepClone()).ToArray()),
            ["updatedAt"] = (long)(Json.Number(route, "updatetime") ?? 0) * 1000,
        });
    });

    /** { manufacturer, model, typeCode, owner, registration }, or { error: "none" }. */
    public byte[] Airframe(string hex) => Cached($"airframe/{hex}", AirframeMaxAgeMs, () =>
    {
        if (!IcaoHex().IsMatch(hex)) return None();
        var record = Fetch($"https://hexdb.io/api/v1/aircraft/{hex}", 10_000);
        return Json.Bytes(new JsonObject
        {
            ["manufacturer"] = Json.Text(record, "Manufacturer"),
            ["model"] = Json.Text(record, "Type"),
            ["typeCode"] = Json.Text(record, "ICAOTypeCode"),
            ["owner"] = Json.Text(record, "RegisteredOwners"),
            ["registration"] = Json.Text(record, "Registration"),
        });
    });

    /**
     * The track flown on the current leg: { points: [[time (ms), lat, lon, altitude ft, or -1 on the
     * ground, or null]] }, oldest first, or { error: "none" } if adsb.lol has none today. Today's
     * full trace, updated every few minutes, and the recent one, for the last of it.
     */
    public byte[] Track(string hex) => Cached($"track/{hex}", TrackMaxAgeMs, () =>
    {
        if (!IcaoHex().IsMatch(hex)) return None();
        var basePath = $"https://globe.adsb.lol/data/traces/{hex[^2..]}";
        var traces = new List<JsonObject>();
        foreach (var kind in new[] { "full", "recent" })
        {
            try
            {
                traces.Add(Json.Parse(Http.GetBytes($"{basePath}/trace_{kind}_{hex}.json", readTimeoutMs: 20_000)));
            }
            catch (Exception e)
            {
                // No full trace for one first seen in the last few minutes, and so on.
                App.Warn(Tag, $"No {kind} trace for {hex}", e);
            }
        }
        var points = LegPoints(traces);
        return points.Count == 0 ? None() : Json.Bytes(new JsonObject { ["points"] = new JsonArray([.. points]) });
    });

    /**
     * The points of the leg under way from tar1090 trace files (today's full trace, then the recent
     * one): [time (ms), lat, lon, altitude ft, or -1 on the ground, or null], oldest first.
     */
    internal static List<JsonNode> LegPoints(List<JsonObject> traces)
    {
        var points = new List<(long Time, JsonArray Row)>();
        foreach (var trace in traces)
        {
            var start = (long)((Json.Number(trace, "timestamp") ?? 0) * 1000);
            if (trace["trace"] is not JsonArray rows) continue;
            var after = points.Count > 0 ? points[^1].Time : long.MinValue;
            foreach (var node in rows)
            {
                if (node is not JsonArray row || row.Count < 4) continue;
                if (At(row, 1) is not { } lat || At(row, 2) is not { } lon) continue;
                var time = start + (long)((At(row, 0) ?? 0) * 1000);
                if (time <= after) continue;
                // flags & 2: the start of a new leg; only the one under way is wanted.
                if (row.Count > 6 && ((int)(At(row, 6) ?? 0) & 2) != 0) points.Clear();
                var altitude = row[3] is JsonValue v && v.TryGetValue<string>(out var s) && s == "ground" ? -1 : At(row, 3);
                points.Add((time, new JsonArray(time, lat, lon, altitude)));
            }
        }
        return points.Select(p => (JsonNode)p.Row).ToList();
    }

    static double? At(JsonArray row, int i) => row[i] is JsonValue v && v.TryGetValue<double>(out var d) ? d : null;

    JsonObject Airport(string icao)
    {
        lock (airports)
        {
            if (airports.TryGetValue(icao, out var known)) return known;
        }
        JsonObject? found = null;
        try
        {
            found = Json.Parse(Http.GetBytes($"https://hexdb.io/api/v1/airport/icao/{icao}", readTimeoutMs: 10_000));
        }
        catch (Exception e)
        {
            App.Warn(Tag, $"No airport {icao}", e);
        }
        var airport = new JsonObject
        {
            ["icao"] = icao,
            ["iata"] = Json.Text(found, "iata"),
            ["name"] = Json.Text(found, "airport"),
            ["region"] = Json.Text(found, "region_name"),
            ["country"] = Json.Text(found, "country_code"),
            ["lat"] = Json.Number(found, "latitude"),
            ["lon"] = Json.Number(found, "longitude"),
        };
        if (found != null) lock (airports) airports[icao] = airport;
        return airport;
    }

    /** From the cache if younger than maxAgeMs; else fetch, kept; or { error } if it fails. */
    byte[] Cached(string key, long maxAgeMs, Func<byte[]> fetch)
    {
        lock (cache)
        {
            if (cache.TryGetValue(key, out var entry) && App.Now() - entry.At < maxAgeMs) return entry.Json;
        }
        if (Http.Offline) return AircraftFeed.Error("offline");
        try
        {
            byte[] json;
            try
            {
                json = fetch();
            }
            catch (NoneException)
            {
                json = None();
            }
            lock (cache) cache[key] = new Entry(App.Now(), json);
            return json;
        }
        catch (Exception e)
        {
            App.Warn(Tag, $"{key} failed", e);
            return AircraftFeed.Error("unavailable");
        }
    }

    static byte[] None() => AircraftFeed.Error("none");
}
