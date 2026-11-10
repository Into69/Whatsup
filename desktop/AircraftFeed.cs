using System.Globalization;
using System.Text.Json.Nodes;

namespace WhatsUp;

/**
 * Live aircraft around a point, from ADS-B, for the page's aircraft layer (aircraft.js): from the
 * user's own receiver if one is set (readsb, dump1090 or tar1090's aircraft.json), then the
 * volunteer networks adsb.lol and, as a fallback, adsb.fi. Both answer "everything within r nautical
 * miles of a point" (up to 250 NM), in readsb's format; the receiver's list is cut to the radius here.
 */
sealed class AircraftFeed
{
    const string Tag = "AircraftFeed";
    /** The public services' radius limit, and a sensible least. */
    public const int MinRadiusNm = 5;
    public const int MaxRadiusNm = 250;
    public const int DefaultRadiusNm = 50;
    /** adsb.fi allows one request a second; the page asks every 10 s. */
    const long MinIntervalMs = 5_000;
    const double EarthRadiusNm = 3440.065;
    static readonly HashSet<string> NotAircraft = ["TWR", "GND"];
    const string Receiver = "receiver";
    /** A receiver on the home network answers at once or not at all. */
    const int ReceiverTimeoutMs = 3_000;
    const long ReceiverRetryMs = 2 * 60_000;

    readonly object gate = new();
    string lastKey = "";
    long lastAt;
    byte[]? last;
    /** When the user's receiver last failed: it is skipped for ReceiverRetryMs after. */
    long receiverFailedAt;

    /**
     * The page's aircraft as JSON: { at, source, lat, lon, radiusNm, aircraft: [[hex, callsign,
     * registration, type, description, lat, lon, altitudeFt, onGround, groundSpeedKt, trackDeg,
     * verticalRateFpm, squawk, positionAt (ms)]] } (unknown values null); or { error } with none.
     * Blocking: call off the UI thread. A request within MinIntervalMs of the last gets the same
     * answer, so the public services are never asked more often than they allow.
     */
    public byte[] Load(double lat, double lon, int radiusNm, string receiverUrl)
    {
        lock (gate)
        {
            if (Http.Offline) return Error("offline");
            var radius = Math.Clamp(radiusNm, MinRadiusNm, MaxRadiusNm);
            // A few hundred metres of wander isn't a new place.
            var key = string.Format(CultureInfo.InvariantCulture, "{0:F2},{1:F2},{2},{3}", lat, lon, radius, receiverUrl);
            if (last != null && key == lastKey && App.Now() - lastAt < MinIntervalMs) return last;
            var now = App.Now();
            // Away from home the receiver can't be reached: after it fails, go straight to the public
            // networks for a while instead of waiting on it every time.
            var tryReceiver = !string.IsNullOrWhiteSpace(receiverUrl) && now - receiverFailedAt > ReceiverRetryMs;
            var point = string.Format(CultureInfo.InvariantCulture, "{0}/{1}", lat, lon);
            var sources = new List<(string Name, string Url)>();
            if (tryReceiver) sources.Add((Receiver, receiverUrl.Trim()));
            sources.Add(("adsb.lol", $"https://api.adsb.lol/v2/point/{point}/{radius}"));
            sources.Add(("adsb.fi", string.Format(CultureInfo.InvariantCulture,
                "https://opendata.adsb.fi/api/v2/lat/{0}/lon/{1}/dist/{2}", lat, lon, radius)));
            foreach (var (name, url) in sources)
            {
                try
                {
                    var local = name == Receiver;
                    var body = Http.GetBytes(
                        url,
                        readTimeoutMs: local ? ReceiverTimeoutMs : 15_000,
                        connectTimeoutMs: local ? ReceiverTimeoutMs : 15_000,
                        allowLocalHttp: local);
                    var fetchedAt = App.Now();
                    var json = Json.Bytes(Parse(Json.Parse(body), name, lat, lon, radius, fetchedAt));
                    if (local) receiverFailedAt = 0;
                    lastKey = key;
                    lastAt = fetchedAt;
                    last = json;
                    return json;
                }
                catch (Exception e)
                {
                    App.Warn(Tag, $"Aircraft from {name} failed", e);
                    if (name == Receiver) receiverFailedAt = App.Now();
                }
            }
            return Error("unavailable");
        }
    }

    /**
     * A service's or receiver's answer as the page's JSON (see Load), cut to the radius. Times are
     * on this computer's clock, from fetchedAt less each position's age: a receiver's own clock may
     * well be wrong. An answer with no aircraft list (an error, or the wrong file) is an error.
     */
    internal static JsonObject Parse(JsonObject response, string source, double lat, double lon, int radiusNm, long fetchedAt)
    {
        // adsb.lol gives "ac"; adsb.fi and receivers "aircraft".
        var list = response["ac"] as JsonArray ?? response["aircraft"] as JsonArray
            ?? throw new ArgumentException("No aircraft list");
        var rows = new JsonArray();
        foreach (var node in list)
        {
            if (node is not JsonObject a) continue;
            if (Json.Number(a, "lat") is not { } aLat || Json.Number(a, "lon") is not { } aLon) continue;
            // Not aircraft: category C is airport vehicles and obstacles; type TWR a ground station
            // (and adsb.fi marks vehicles GND).
            if (Json.Text(a, "category").StartsWith('C') || NotAircraft.Contains(Json.Text(a, "t"))) continue;
            if (DistanceNm(lat, lon, aLat, aLon) > radiusNm) continue;
            // Older dump1090 (-mutability) names: altitude, speed, vert_rate.
            var baro = a["alt_baro"] ?? a["altitude"];
            var onGround = baro is JsonValue g && g.TryGetValue<string>(out var s) && s == "ground";
            double? altitudeFt = onGround ? 0.0
                : baro is JsonValue b && b.TryGetValue<double>(out var feet) ? feet
                : Json.Number(a, "alt_geom");
            var track = new[] { "track", "true_heading", "mag_heading" }.Select(k => Json.Number(a, k)).FirstOrDefault(v => v != null);
            var rate = new[] { "baro_rate", "geom_rate", "vert_rate" }.Select(k => Json.Number(a, k)).FirstOrDefault(v => v != null);
            var seenS = Json.Number(a, "seen_pos") ?? Json.Number(a, "seen") ?? 0.0;
            rows.Add(new JsonArray(
                Json.Text(a, "hex"),
                Json.Text(a, "flight").Trim(),
                // adsb.fi gives placeholder "GND" for vehicles' registration and type.
                Text(a, "r"),
                Text(a, "t"),
                Text(a, "desc"),
                aLat,
                aLon,
                altitudeFt,
                onGround,
                Json.Number(a, "gs") ?? Json.Number(a, "speed"),
                track,
                rate,
                Text(a, "squawk"),
                fetchedAt - (long)(seenS * 1000)));
        }
        return new JsonObject
        {
            ["at"] = fetchedAt,
            ["source"] = source,
            ["lat"] = lat,
            ["lon"] = lon,
            ["radiusNm"] = radiusNm,
            ["aircraft"] = rows,
        };
    }

    static string? Text(JsonObject a, string key) => Json.Text(a, key).Trim() is var t && t.Length > 0 && t != "GND" ? t : null;

    /** A reply with no aircraft: "offline" (offline mode), "unavailable" or "waiting" (no location yet). */
    public static byte[] Error(string reason) => Json.Bytes(new JsonObject { ["error"] = reason });

    public static double DistanceNm(double lat1, double lon1, double lat2, double lon2)
    {
        double p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
        var h = Math.Pow(Math.Sin((p2 - p1) / 2), 2) + Math.Cos(p1) * Math.Cos(p2) * Math.Pow(Math.Sin((lon2 - lon1) * Math.PI / 180 / 2), 2);
        return 2 * EarthRadiusNm * Math.Asin(Math.Sqrt(Math.Min(h, 1)));
    }
}
