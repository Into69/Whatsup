using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace WhatsUp;

/**
 * A set of satellites from one or more CelesTrak queries, with its own switch in settings and its
 * own dot colour. Featured satellites always show their label, orbit and ground track; the rest are
 * dots that show those only when tapped.
 *
 * Order matters: a satellite in several groups (the ISS is also in "stations", GPS satellites also
 * fall in MEO) is shown once, as a member of the first shown group here that has it.
 */
sealed class SatelliteGroup
{
    public string Key { get; }
    /** Its switch in settings: the name of its string. */
    public string Title { get; }
    /** CelesTrak gp.php queries whose results together make the group. */
    public IReadOnlyList<string> Queries { get; }
    /** Dot colour, 0xRRGGBB. */
    public int Color { get; }
    /** Dot diameter in CSS pixels. */
    public double DotSize { get; }
    public bool Featured { get; }
    public bool ShownByDefault { get; }
    /** Hidden when zoomed far out, where thousands of low dots would only bury the globe. */
    public bool LowOrbit { get; }
    /** Keeps only the matching satellites of what Queries return. */
    public Func<OmmRow, bool>? Filter { get; }

    SatelliteGroup(string key, string title, string[] queries, int color, double dotSize = 3.5, bool featured = false,
        bool shownByDefault = false, bool lowOrbit = false, Func<OmmRow, bool>? filter = null)
    {
        Key = key; Title = title; Queries = queries; Color = color; DotSize = dotSize; Featured = featured;
        ShownByDefault = shownByDefault; LowOrbit = lowOrbit; Filter = filter;
    }

    const string Active = "GROUP=active";
    /** Mean altitude where low Earth orbit ends and medium Earth orbit begins. */
    const double LeoCeilingKm = 2000;
    /** Below geostationary (35,786 km), leaving the GEO group the satellites near it. */
    const double MeoCeilingKm = 35000;
    /** Orbits at least this eccentric are HEO, whatever their altitude. */
    const double HeoEccentricity = 0.25;

    /**
     * Low Earth orbit constellations with their own groups, and the name prefixes that pick out their
     * satellites from the active list. Each operator names every satellite the same way, so a prefix is
     * reliable; CelesTrak's own constellation groups would mean downloading the same satellites again.
     */
    static readonly string[] StarlinkNames = ["STARLINK"], OneWebNames = ["ONEWEB"],
        /** Amazon's constellation, still catalogued under its project name, Kuiper. */
        AmazonLeoNames = ["KUIPER"], QianfanNames = ["QIANFAN"],
        /** China's SatNet (Guowang), catalogued as "HULIANWANG" (internet), with its test satellites. */
        GuowangNames = ["HULIANWANG"],
        IridiumNames = ["IRIDIUM"], GlobalstarNames = ["GLOBALSTAR"], OrbcommNames = ["ORBCOMM"],
        PlanetNames = ["FLOCK", "SKYSAT", "PELICAN"], SpireNames = ["LEMUR"];
    static readonly string[] LeoConstellations = [.. StarlinkNames, .. OneWebNames, .. AmazonLeoNames, .. QianfanNames,
        .. GuowangNames, .. IridiumNames, .. GlobalstarNames, .. OrbcommNames, .. PlanetNames, .. SpireNames];

    static bool IsLeo(OmmRow it) => it.Eccentricity < HeoEccentricity && it.MeanAltitudeKm < LeoCeilingKm;

    static Func<OmmRow, bool> Named(string[] prefixes) => it => prefixes.Any(p => it.Name.StartsWith(p, StringComparison.Ordinal));

    public static readonly SatelliteGroup
        Iss = new("iss", "show_iss", ["CATNR=25544"], 0xFFD166, featured: true, shownByDefault: true),
        Stations = new("stations", "show_stations", ["GROUP=stations"], 0xFFFFFF, shownByDefault: true),
        Recent = new("recent", "show_recent", ["GROUP=last-30-days"], 0xFF8C42),
        Gnss = new("gnss", "show_gnss", ["GROUP=gnss"], 0x7CF29C, shownByDefault: true),
        Weather = new("weather", "show_weather", ["GROUP=weather"], 0x5FA8FF),
        Amateur = new("amateur", "show_amateur", ["GROUP=amateur"], 0xFFE066),
        Satnogs = new("satnogs", "show_satnogs", ["GROUP=satnogs"], 0xC0A0FF),
        XComm = new("x-comm", "show_x_comm", ["GROUP=x-comm"], 0xFF66E0),
        OtherComm = new("other-comm", "show_other_comm", ["GROUP=other-comm"], 0x9FB4C8),
        /** CelesTrak's "Active Geosynchronous" group. */
        Geo = new("geo", "show_geo", ["GROUP=geo"], 0x6EE7FF, shownByDefault: true),
        /** Everything in or near the GEO belt; after GEO, so this is the inactive satellites and debris there. */
        Gpz = new("gpz", "show_gpz", ["SPECIAL=gpz"], 0x8C7BFF),
        /**
         * Highly elliptical orbits. CelesTrak has no such group, nor MEO or LEO ones, so these three are
         * every active satellite (about 16,000) cut down by orbit shape and height.
         */
        Heo = new("heo", "show_heo", [Active], 0xFF7EB6, shownByDefault: true, filter: it => it.Eccentricity >= HeoEccentricity),
        Meo = new("meo", "show_meo", [Active], 0xC6F25A,
            filter: it => it.Eccentricity < HeoEccentricity && it.MeanAltitudeKm is >= LeoCeilingKm and <= MeoCeilingKm),
        Starlink = new("starlink", "show_starlink", [Active], 0xD0D8E8, dotSize: 2.0, lowOrbit: true, filter: Named(StarlinkNames)),
        OneWeb = new("oneweb", "show_oneweb", [Active], 0xF2A0FF, dotSize: 2.5, lowOrbit: true, filter: Named(OneWebNames)),
        AmazonLeo = new("amazon-leo", "show_amazon_leo", [Active], 0xFFB347, dotSize: 2.5, lowOrbit: true, filter: Named(AmazonLeoNames)),
        Qianfan = new("qianfan", "show_qianfan", [Active], 0x4DD0C8, dotSize: 2.5, lowOrbit: true, filter: Named(QianfanNames)),
        Guowang = new("guowang", "show_guowang", [Active], 0xE8706F, dotSize: 2.5, lowOrbit: true, filter: Named(GuowangNames)),
        Iridium = new("iridium", "show_iridium", [Active], 0x8FA8FF, dotSize: 2.5, lowOrbit: true, filter: Named(IridiumNames)),
        Globalstar = new("globalstar", "show_globalstar", [Active], 0xA6E3FF, dotSize: 2.5, lowOrbit: true, filter: Named(GlobalstarNames)),
        Orbcomm = new("orbcomm", "show_orbcomm", [Active], 0xC9A27E, dotSize: 2.5, lowOrbit: true, filter: Named(OrbcommNames)),
        Planet = new("planet", "show_planet", [Active], 0x9BE15D, dotSize: 2.5, lowOrbit: true, filter: Named(PlanetNames)),
        Spire = new("spire", "show_spire", [Active], 0xF7E07A, dotSize: 2.5, lowOrbit: true, filter: Named(SpireNames)),
        /** Whatever low Earth orbit satellites the constellation groups above don't take. */
        Leo = new("leo", "show_leo", [Active], 0x7F8A9E, dotSize: 2.0, lowOrbit: true,
            filter: it => IsLeo(it) && !Named(LeoConstellations)(it)),
        /** The three big debris clouds: the 2007 Chinese ASAT test, and the 2009 Iridium-Cosmos collision. */
        Debris = new("debris", "show_debris", ["GROUP=fengyun-1c-debris", "GROUP=iridium-33-debris", "GROUP=cosmos-2251-debris"],
            0xFF5A4E, dotSize: 2.0, lowOrbit: true);

    public static readonly IReadOnlyList<SatelliteGroup> Entries =
    [
        Iss, Stations, Recent, Gnss, Weather, Amateur, Satnogs, XComm, OtherComm, Geo, Gpz, Heo, Meo,
        Starlink, OneWeb, AmazonLeo, Qianfan, Guowang, Iridium, Globalstar, Orbcomm, Planet, Spire, Leo, Debris,
    ];

    /** How the page draws the group, with label for its legend; see satellites.js. */
    public JsonObject StyleJson(string label) => new()
    {
        ["color"] = $"#{Color:X6}",
        ["size"] = DotSize,
        ["featured"] = Featured,
        ["lowOrbit"] = LowOrbit,
        ["label"] = label,
    };
}

/**
 * One satellite's orbital elements in CelesTrak's OMM CSV form, which SGP4 (satellite.js's
 * json2satrec) propagates into positions. Unlike TLEs, OMM carries the full name (TLEs cut it at 24
 * characters) and the international designator.
 *
 * Values are in the order of the CSV header, Columns. Read once per download and shared by every
 * group cut from it: the active list's 16,000 rows feed over a dozen groups.
 */
sealed class OmmRow
{
    public IReadOnlyList<string> Columns { get; }
    public IReadOnlyList<string> Values { get; }
    public int NoradId { get; }
    /** CelesTrak's name, e.g. "STARLINK-1007". */
    public string Name { get; }
    public double Eccentricity { get; }
    /** Semi-major axis less the Earth's radius, from the mean motion (revolutions a day). */
    public double MeanAltitudeKm { get; }

    const double EarthMu = 398_600.4418;
    const double EarthRadiusKm = 6378.137;

    public OmmRow(IReadOnlyList<string> columns, IReadOnlyList<string> values)
    {
        Columns = columns;
        Values = values;
        string Field(string name)
        {
            for (var i = 0; i < columns.Count && i < values.Count; i++) if (columns[i] == name) return values[i];
            return "";
        }
        NoradId = int.TryParse(Field("NORAD_CAT_ID"), out var id) ? id : 0;
        Name = Field("OBJECT_NAME");
        Eccentricity = double.TryParse(Field("ECCENTRICITY"), NumberStyles.Float, CultureInfo.InvariantCulture, out var e) ? e : 0;
        MeanAltitudeKm = double.TryParse(Field("MEAN_MOTION"), NumberStyles.Float, CultureInfo.InvariantCulture, out var revolutionsPerDay)
            ? Math.Cbrt(EarthMu / Math.Pow(revolutionsPerDay * 2 * Math.PI / 86_400, 2)) - EarthRadiusKm
            : 0;
    }
}

/** A satellite's elements (row) as shown in one group. */
sealed class ElementSet(SatelliteGroup group, OmmRow row)
{
    public SatelliteGroup Group => group;
    public IReadOnlyList<string> Columns => row.Columns;
    public int NoradId => row.NoradId;

    /** One entry of the page's satellite list: the group key, then the row's values. */
    public JsonArray ToJson()
    {
        var array = new JsonArray(group.Key);
        foreach (var value in row.Values) array.Add(value);
        return array;
    }
}

/**
 * Fetches orbital elements from CelesTrak and caches each query's response on disk. CelesTrak asks
 * clients not to fetch the same data more than once every two hours, so a cached copy younger than
 * that is used as is, and an older one is still used when the network fails: SGP4 stays accurate to
 * a few km for days. Groups sharing a query (LEO, MEO and HEO all cut down the active list) share
 * one download.
 */
sealed partial class ElementSetRepository(DownloadTracker tracker)
{
    const string Tag = "ElementSetRepository";
    const long MaxAgeMs = 2 * 60 * 60 * 1000L;
    const string HeaderStart = "OBJECT_NAME,";
    const string NoData = "No GP data found";
    /** Start of CelesTrak's 403 message when a query is fetched again within two hours. */
    const string NotUpdated = "GP data has not updated";

    readonly string dir = Path.Combine(App.CacheDir, "elements");
    /** One Get at a time: groups sharing a query don't fetch it twice, and the memos below stay consistent. */
    readonly SemaphoreSlim mutex = new(1, 1);

    /**
     * Bumped each time a query's file is rewritten, so the memos below know when to parse again.
     * (The file's modification time won't do: a "not updated" answer touches it without changing it.)
     */
    readonly Dictionary<string, int> generations = [];

    /** A query's parsed CSV, kept until its file is rewritten; the active list is 16,000 rows. */
    sealed record Rows(int Generation, List<OmmRow> List);
    readonly Dictionary<string, Rows> rowsByQuery = [];

    /**
     * A group's satellites, kept while its queries' files are unchanged. Returning the same objects
     * lets MainForm see cheaply that nothing changed.
     */
    sealed record GroupSets(List<int> Generations, List<ElementSet> Sets);
    readonly Dictionary<SatelliteGroup, GroupSets> setsByGroup = [];

    /**
     * When the group's data was last fetched or confirmed current (the oldest of its queries), or 0 if
     * it never has been. Old data means the computer has been offline.
     */
    public long UpdatedAt(SatelliteGroup group) => group.Queries.Min(query => App.LastModified(FileFor(query)));

    [GeneratedRegex("[^A-Za-z0-9-]")]
    private static partial Regex Unsafe();

    string FileFor(string query) => Path.Combine(dir, Unsafe().Replace(query, "_") + ".csv");

    static string NameFor(string query) => query[(query.IndexOf('=') + 1)..] + ".csv";

    static bool IsStale(string file) => !File.Exists(file) || App.Now() - App.LastModified(file) >= MaxAgeMs;

    /** Whether to download the file again: when it is stale, unless in offline mode. */
    static bool IsDue(string file) => !Http.Offline && IsStale(file);

    /**
     * Puts the groups' files that are due a download in the progress panel's queue, so it can say
     * from the start how many there are. Get then takes them off one by one.
     */
    public void Queue(IEnumerable<SatelliteGroup> groups)
    {
        foreach (var query in groups.SelectMany(g => g.Queries).Distinct())
        {
            if (IsDue(FileFor(query))) tracker.Queue(query, NameFor(query));
        }
    }

    public async Task<List<ElementSet>> Get(SatelliteGroup group, CancellationToken cancel)
    {
        await mutex.WaitAsync(cancel);
        try
        {
            return await Task.Run(() =>
            {
                var files = group.Queries.ToDictionary(q => q, Fetch);
                var gens = group.Queries.Select(q => generations.GetValueOrDefault(q)).ToList();
                if (setsByGroup.TryGetValue(group, out var memo) && memo.Generations.SequenceEqual(gens)) return memo.Sets;
                var all = files.SelectMany(f => RowsOf(f.Key, f.Value).List.Select(row => (row, set: new ElementSet(group, row))));
                var sets = (group.Filter is { } filter ? all.Where(a => filter(a.row)) : all).Select(a => a.set).ToList();
                setsByGroup[group] = new GroupSets(gens, sets);
                return sets;
            }, CancellationToken.None);
        }
        finally
        {
            mutex.Release();
        }
    }

    /**
     * The query's file, downloaded again first if the cached one is too old; null if there is none.
     * A failed download leaves the old file, if any, in use.
     */
    string? Fetch(string query)
    {
        var name = NameFor(query);
        var file = FileFor(query);
        var cached = File.Exists(file);
        if (!IsDue(file))
        {
            // Queued, but another group's fetch has since brought it up to date, or offline mode
            // was turned on.
            tracker.Unqueue(query);
            return cached ? file : null;
        }
        try
        {
            var text = Download(query, name);
            if (text == null)
            {
                // CelesTrak has nothing newer than this computer's last download. With a cached copy,
                // that copy is current; without one (the cache was cleared since), there is nothing
                // to show until CelesTrak will send it again, which is a failure, not "up to date".
                if (!cached) throw new InvalidDataException("Refused as not updated, but nothing is cached");
                File.SetLastWriteTimeUtc(file, DateTime.UtcNow);
                tracker.Report(query, name, state: WhatsUp.Download.States.NotUpdated);
                return file;
            }
            // CelesTrak answers an empty group (e.g. no launches lately) with this instead of a CSV.
            if (!text.StartsWith(HeaderStart, StringComparison.Ordinal) && !text.Contains(NoData))
            {
                throw new InvalidDataException($"Not OMM CSV: {text[..Math.Min(200, text.Length)]}");
            }
            Directory.CreateDirectory(dir);
            File.WriteAllText(file, text);
            generations[query] = generations.GetValueOrDefault(query) + 1;
            tracker.Report(query, name, state: WhatsUp.Download.States.Done);
        }
        catch (Exception e)
        {
            App.Warn(Tag, $"Fetch of {query} failed; cached: {cached}", e);
            tracker.Report(query, name, state: WhatsUp.Download.States.Failed);
        }
        return File.Exists(file) ? file : null;
    }

    /** The query's file parsed, from rowsByQuery unless it has been rewritten since. */
    Rows RowsOf(string query, string? file)
    {
        var generation = generations.GetValueOrDefault(query);
        if (rowsByQuery.TryGetValue(query, out var memo) && memo.Generation == generation) return memo;
        var lines = file == null ? [] : File.ReadLines(file).Where(l => !string.IsNullOrWhiteSpace(l)).Select(Csv.Split).ToList();
        var columns = lines.FirstOrDefault() is { } header && header.FirstOrDefault() == "OBJECT_NAME" ? header : null;
        var parsed = new Rows(
            generation,
            columns == null
                ? []
                : lines.Skip(1).Where(l => l.Count == columns.Count).Select(l => new OmmRow(columns, l)).Where(r => r.NoradId > 0).ToList());
        rowsByQuery[query] = parsed;
        return parsed;
    }

    /**
     * The query's response, reporting progress to the tracker as it arrives, or null when CelesTrak
     * refuses because it has nothing newer than what this computer last fetched (its two-hour rule).
     */
    string? Download(string query, string name)
    {
        var output = new MemoryStream(64 * 1024);
        try
        {
            tracker.Report(query, name, bytesRead: 0, totalBytes: -1);
            Http.Get($"https://celestrak.org/NORAD/elements/gp.php?{query}&FORMAT=csv", output, readTimeoutMs: 60_000,
                onProgress: (read, total) => tracker.Report(query, name, read, total));
        }
        catch (Http.StatusException e) when (e.Code == 403 && e.Body.Contains(NotUpdated))
        {
            return null;
        }
        return Encoding.UTF8.GetString(output.ToArray());
    }
}

static class Csv
{
    /** Splits a CSV row, allowing quoted fields (a name with a comma in it). */
    public static List<string> Split(string line)
    {
        var fields = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (quoted && c == '"' && i + 1 < line.Length && line[i + 1] == '"') { field.Append('"'); i++; }
            else if (c == '"') quoted = !quoted;
            else if (c == ',' && !quoted) { fields.Add(field.ToString()); field.Clear(); }
            else if (c != '\r') field.Append(c);
        }
        fields.Add(field.ToString());
        return fields;
    }
}
