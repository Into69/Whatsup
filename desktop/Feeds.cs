using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace WhatsUp;

/**
 * Close approaches between objects in orbit, from CelesTrak's SOCRATES: the next week's predicted
 * conjunctions, sorted closest first. The whole list is about 22 MB, so it is only fetched when the
 * user asks for it (and at most every MaxAgeMs); what the page gets is cut down to the closest
 * approaches overall and those involving satellites it shows or the user has starred.
 */
sealed partial class ConjunctionFeed(DownloadTracker tracker)
{
    const string Tag = "ConjunctionFeed";
    const string Key = "socrates";
    const string Url = "https://celestrak.org/SOCRATES/sort-minRange.csv";
    /** SOCRATES is recomputed a few times a day. */
    const long MaxAgeMs = 12 * 60 * 60 * 1000L;
    /** Approaches just past still show, so the user can step back to them. */
    const long PastMs = 60 * 60 * 1000L;
    const int MaxAny = 100;
    const int MaxShown = 400;

    [GeneratedRegex(@"\s*\[[^\]]*]\s*$")]
    private static partial Regex StatusMark();

    readonly string file = Path.Combine(App.CacheDir, "feeds", "socrates.csv");
    readonly object gate = new();

    /**
     * The page's close approaches as JSON: { updatedAt, rows: [[id1, name1, id2, name2, tca (ms),
     * range (km), relative speed (km/s), probability]] }, closest first; null if there is no copy
     * and the download fails. Blocking: call off the UI thread. One at a time, so two requests
     * can't download into the same file at once.
     */
    public byte[]? Load(HashSet<int> shown, HashSet<int> starred)
    {
        lock (gate)
        {
            if (!Http.Offline && (!File.Exists(file) || App.Now() - App.LastModified(file) > MaxAgeMs))
            {
                try
                {
                    tracker.DownloadTo(Url, file, Key, "SOCRATES close approaches");
                }
                catch (Exception e)
                {
                    App.Warn(Tag, $"Download failed; cached: {File.Exists(file)}", e);
                }
            }
            if (!File.Exists(file)) return null;
            try
            {
                return Encoding.UTF8.GetBytes(Select(shown, starred).ToJsonString());
            }
            catch (Exception e)
            {
                App.Warn(Tag, $"Reading {file} failed", e);
                return null;
            }
        }
    }

    JsonObject Select(HashSet<int> shown, HashSet<int> starred)
    {
        var rows = new JsonArray();
        int anyKept = 0, shownKept = 0;
        var since = App.Now() - PastMs;
        using var lines = File.ReadLines(file).GetEnumerator();
        if (lines.MoveNext())
        {
            var header = Csv.Split(lines.Current);
            int Column(string name) => header.IndexOf(name) is var i && i >= 0 ? i : throw new InvalidDataException($"No {name} column");
            int id1 = Column("NORAD_CAT_ID_1"), name1 = Column("OBJECT_NAME_1"), id2 = Column("NORAD_CAT_ID_2"),
                name2 = Column("OBJECT_NAME_2"), tca = Column("TCA"), range = Column("TCA_RANGE"),
                speed = Column("TCA_RELATIVE_SPEED"), probability = Column("MAX_PROB");
            while (lines.MoveNext())
            {
                var line = lines.Current;
                if (string.IsNullOrWhiteSpace(line)) continue;
                var fields = Csv.Split(line);
                if (fields.Count < header.Count) continue;
                if (!int.TryParse(fields[id1], out var a) || !int.TryParse(fields[id2], out var b)) continue;
                if (ParseTca(fields[tca]) is not { } at || at < since) continue;
                // The list is closest first, so the first rows of each kind are the ones to keep.
                bool keep;
                if (starred.Contains(a) || starred.Contains(b)) keep = true;
                else if ((shown.Contains(a) || shown.Contains(b)) && shownKept < MaxShown) { shownKept++; keep = true; }
                else if (anyKept < MaxAny) { anyKept++; keep = true; }
                else keep = false;
                if (!keep) continue;
                rows.Add(new JsonArray(a, CleanName(fields[name1]), b, CleanName(fields[name2]), at,
                    Number(fields[range]), Number(fields[speed]), Number(fields[probability])));
            }
        }
        return new JsonObject { ["updatedAt"] = App.LastModified(file), ["rows"] = rows };
    }

    static double Number(string text) =>
        double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n : 0.0;

    /** "2026-11-07 04:17:16.388", in UTC. */
    static long? ParseTca(string text) =>
        DateTime.TryParse(text.Trim().Replace(' ', 'T'), CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var at)
            ? new DateTimeOffset(at, TimeSpan.Zero).ToUnixTimeMilliseconds()
            : null;

    /** SOCRATES marks names with an operational status, e.g. "STARLINK-4429 [+]". */
    static string CleanName(string name) => StatusMark().Replace(name, "").Trim();
}

/**
 * Upcoming launches worldwide, from The Space Devs' Launch Library 2. Its free tier allows 15
 * requests an hour, so a copy is kept for MaxAgeMs and the old one used if a fetch fails.
 */
sealed class LaunchFeed
{
    const string Tag = "LaunchFeed";
    const string Url = "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=30&mode=normal";
    const long MaxAgeMs = 60 * 60 * 1000L;

    readonly string file = Path.Combine(App.CacheDir, "feeds", "launches.json");
    readonly object gate = new();

    /**
     * The page's launch list as JSON: { updatedAt, launches: [{ name, net (ms), status, statusName,
     * provider, rocket, mission, orbit, pad, location, lat, lon }] }, or null with no copy and no
     * connection. Blocking: call off the UI thread.
     */
    public byte[]? Load()
    {
        lock (gate)
        {
            if (!Http.Offline && (!File.Exists(file) || App.Now() - App.LastModified(file) > MaxAgeMs))
            {
                try
                {
                    Download();
                }
                catch (Exception e)
                {
                    App.Warn(Tag, $"Download failed; cached: {File.Exists(file)}", e);
                }
            }
            if (!File.Exists(file)) return null;
            try
            {
                return Encoding.UTF8.GetBytes(Compact(JsonNode.Parse(File.ReadAllText(file))!.AsObject()).ToJsonString());
            }
            catch (Exception e)
            {
                App.Warn(Tag, $"Reading {file} failed", e);
                return null;
            }
        }
    }

    void Download()
    {
        var text = Http.GetText(Url);
        JsonNode.Parse(text); // Check it is whole before replacing the copy.
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, text);
    }

    JsonObject Compact(JsonObject response)
    {
        var launches = new JsonArray();
        foreach (var node in response["results"] as JsonArray ?? [])
        {
            if (node is not JsonObject launch) continue;
            if (!DateTimeOffset.TryParse(Json.Text(launch, "net"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var net)) continue;
            if (launch["pad"] is not JsonObject pad) continue;
            var mission = launch["mission"] as JsonObject;
            var status = launch["status"] as JsonObject;
            launches.Add(new JsonObject
            {
                ["name"] = Json.Text(launch, "name"),
                ["net"] = net.ToUnixTimeMilliseconds(),
                ["status"] = Json.Text(status, "abbrev"),
                ["statusName"] = Json.Text(status, "name"),
                ["provider"] = Json.Text(launch["launch_service_provider"] as JsonObject, "name"),
                ["rocket"] = Json.Text((launch["rocket"] as JsonObject)?["configuration"] as JsonObject, "full_name"),
                ["mission"] = Json.Text(mission, "description"),
                ["orbit"] = Json.Text(mission?["orbit"] as JsonObject, "abbrev"),
                ["pad"] = Json.Text(pad, "name"),
                ["location"] = Json.Text(pad["location"] as JsonObject, "name"),
                // A pad still to be decided has no coordinates: null, so the launch is listed
                // without a marker rather than failing the whole list.
                ["lat"] = Json.Number(pad, "latitude"),
                ["lon"] = Json.Number(pad, "longitude"),
            });
        }
        return new JsonObject { ["updatedAt"] = App.LastModified(file), ["launches"] = launches };
    }
}

/** org.json's optString and optDouble, for System.Text.Json's nodes. */
static class Json
{
    /** The value as text ("" when missing or null), as optString. */
    public static string Text(JsonObject? o, string key) => o?[key] switch
    {
        null => "",
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        var other => other.ToJsonString(),
    };

    /** The value as a number, from a number or numeric text; null when missing or not a number, as optDouble's NaN. */
    public static double? Number(JsonObject? o, string key) => o?[key] is JsonValue v
        ? v.TryGetValue<double>(out var d) ? d
        : v.TryGetValue<string>(out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var p) ? p
        : null
        : null;

    public static byte[] Bytes(JsonNode node) => Encoding.UTF8.GetBytes(node.ToJsonString());

    public static JsonObject Parse(byte[] bytes) =>
        JsonNode.Parse(bytes) as JsonObject ?? throw new InvalidDataException("Not a JSON object");
}
