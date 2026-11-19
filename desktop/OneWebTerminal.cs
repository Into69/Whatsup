using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace WhatsUp;

/**
 * The user's own OneWeb terminal, read over its local API: Hughes HL1120 terminals answer plain JSON
 * at http://192.168.100.1/api/... with no login. As the Android app's OneWebTerminal.kt, which says more.
 */
sealed partial class OneWebTerminal
{
    public const string DefaultAddress = "192.168.100.1";
    const int TimeoutMs = 4_000;
    const string NoSuchPage = "no such page", NotJson = "not JSON";
    const long StatusKeepMs = 4_000, SlowKeepMs = 60_000;

    /** Asked every few seconds: the satellite in use and the signal. The first is the one that must answer. */
    static readonly string[] Fast = ["antenna/antennatuneinfo", "modem/satellites_in_view", "modem/lte_signal_info", "antenna/trackingstatus"];
    /** Asked once a minute: faults, availability, what the terminal is. */
    static readonly string[] Slow = ["diagnostics/active_faults", "antenna/antennainfo", "system/status", "system/deviceinfo", "system/swinfo"];

    readonly object gate = new();
    readonly Dictionary<string, (long At, JsonNode? Answer, string? Error)> kept = [];
    string address = "";

    /** The terminal's state at `address`, as JSON for the page; `raw` adds every answer as it came. */
    public byte[] Load(string address, bool raw = false) => Json.Bytes(LoadJson(address, raw));

    public JsonObject LoadJson(string address, bool raw = false)
    {
        lock (gate)
        {
            if (address != this.address)
            {
                this.address = address;
                kept.Clear();
            }
            var now = App.Now();
            var output = new JsonObject { ["at"] = now };
            string url;
            try
            {
                url = BaseUrl(address);
            }
            catch (IOException e)
            {
                output["error"] = e.Message;
                return output;
            }
            var answers = new JsonObject();
            var errors = new JsonObject();
            foreach (var (endpoint, keepMs) in Fast.Select(e => (e, StatusKeepMs)).Concat(Slow.Select(e => (e, SlowKeepMs))))
            {
                if (!kept.TryGetValue(endpoint, out var answer) || now - answer.At >= keepMs)
                {
                    try
                    {
                        var bytes = Http.GetBytes($"{url}/api/{endpoint}", readTimeoutMs: TimeoutMs, connectTimeoutMs: TimeoutMs, allowLocalHttp: true);
                        answer = (now, JsonNode.Parse(bytes) as JsonObject ?? throw new System.Text.Json.JsonException(), null);
                    }
                    catch (Exception e) when (e is IOException or HttpRequestException or System.Text.Json.JsonException)
                    {
                        answer = (now, null, Describe(e));
                    }
                    kept[endpoint] = answer;
                }
                if (answer.Answer != null) answers[endpoint] = answer.Answer.DeepClone();
                else errors[endpoint] = answer.Error;
                // Nothing at all from the first: not a terminal, or not there; don't wait on the rest.
                if (endpoint == Fast[0] && answer.Answer == null)
                {
                    output["error"] = answer.Error is NoSuchPage or NotJson ? $"not a OneWeb terminal ({answer.Error})" : answer.Error;
                    return output;
                }
            }
            output["terminal"] = Summarise(answers);
            if (errors.Count > 0) output["errors"] = errors;
            if (raw) output["raw"] = answers;
            return output;
        }
    }

    /** The base URL from what the user typed: a host, host:port or http://host:port; local only. */
    public static string BaseUrl(string address)
    {
        var typed = address.Trim();
        if (typed.Length == 0) typed = DefaultAddress;
        typed = typed.TrimEnd('/');
        var text = typed.Contains("://") ? typed : $"http://{typed}";
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) throw new IOException($"Not an address: {typed}");
        if (!Http.IsLocalHost(uri.Host)) throw new IOException($"Not on this network: {uri.Host}");
        return uri.IsDefaultPort ? $"{uri.Scheme}://{uri.Host}" : $"{uri.Scheme}://{uri.Host}:{uri.Port}";
    }

    static string Describe(Exception e) => e switch
    {
        Http.StatusException { Code: 404 } => NoSuchPage,
        Http.StatusException s => $"HTTP {s.Code}",
        System.Text.Json.JsonException => NotJson,
        HttpRequestException { InnerException: System.Net.Sockets.SocketException } => "can't connect",
        IOException { InnerException: OperationCanceledException } => "no answer",
        _ when e.Message.StartsWith("Timed out", StringComparison.Ordinal) => "no answer",
        _ => e.Message,
    };

    /** A number, from a number or a numeric string; null otherwise. */
    static double? Number(JsonNode? node)
    {
        if (node is not JsonValue value) return null;
        double? n = value.TryGetValue<double>(out var d) ? d
            : value.TryGetValue<string>(out var s) && double.TryParse(s.Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var p) ? p
            : null;
        return n is { } x && double.IsFinite(x) ? x : null;
    }

    /** What the page and the check need, from the answers by endpoint: as OneWebTerminal.kt's summarise. */
    public static JsonObject Summarise(JsonObject answers)
    {
        var output = new JsonObject();
        if (answers["antenna/antennatuneinfo"] is JsonObject tune)
        {
            if (tune["pointing_info"] is JsonObject p)
            {
                if (Number(p["satellite"]) is { } satellite) output["satellite"] = (long)satellite;
                if (Number(p["track_id"]) is { } track) output["trackId"] = (long)track;
                if (Number(p["current_sinr"]) is { } sinr) output["sinr"] = sinr;
            }
            if (Number(tune["calibration_info"]?["pointing_score"]) is { } score) output["pointingScore"] = score;
        }
        if (answers["modem/satellites_in_view"] is JsonObject view)
        {
            // A list, or (as seen) a list written out as a string.
            var list = view["candidate_satellites"] switch
            {
                JsonArray a => a,
                JsonValue v when v.TryGetValue<string>(out var s) => TryParseArray(s),
                _ => null,
            };
            if (list != null) output["candidates"] = new JsonArray(list.Select(Number).Where(n => n != null).Select(n => (JsonNode)(long)n!.Value).ToArray());
        }
        if (answers["modem/lte_signal_info"] is JsonObject s1)
        {
            var signal = new JsonObject();
            if (Number(s1["sinr_dB"]) is { } a) signal["sinrDb"] = a;
            if (Number(s1["rssi_dBm"]) is { } b) signal["rssiDbm"] = b;
            if (Number(s1["rsrp_dBW/m^2"]) is { } c) signal["rsrp"] = c;
            if (signal.Count > 0) output["signal"] = signal;
        }
        if (Number(answers["diagnostics/active_faults"]?["availability_percent"]) is { } availability) output["availability"] = availability;
        // Where the antenna points, if any answer says so in fields named for it.
        foreach (var endpoint in new[] { "antenna/trackingstatus", "antenna/antennatuneinfo", "antenna/antennainfo" })
        {
            if (answers[endpoint] is JsonObject o && FindPointing(o, endpoint) is { } pointing)
            {
                output["pointing"] = pointing;
                break;
            }
        }
        return output;
    }

    static JsonArray? TryParseArray(string text)
    {
        try { return JsonNode.Parse(text) as JsonArray; }
        catch (System.Text.Json.JsonException) { return null; }
    }

    [GeneratedRegex("(^|_)(azimuth|az)(_|$)|azimuth", RegexOptions.IgnoreCase)]
    private static partial Regex Azimuth();

    [GeneratedRegex("(^|_)(elevation|el)(_|$)|elevation", RegexOptions.IgnoreCase)]
    private static partial Regex Elevation();

    /** The first object holding both an azimuth and an elevation (in range), searched depth first. */
    public static JsonObject? FindPointing(JsonObject json, string path)
    {
        double? az = null, el = null;
        foreach (var (key, node) in json)
        {
            if (Number(node) is not { } value) continue;
            if (az == null && Azimuth().IsMatch(key) && value is >= -360 and <= 360) az = value;
            else if (el == null && Elevation().IsMatch(key) && value is >= -90 and <= 90) el = value;
        }
        if (az != null && el != null) return new JsonObject { ["az"] = (az.Value + 360) % 360, ["el"] = el.Value, ["from"] = path };
        foreach (var (key, node) in json)
        {
            if (node is JsonObject child && FindPointing(child, $"{path}.{key}") is { } found) return found;
        }
        return null;
    }
}
