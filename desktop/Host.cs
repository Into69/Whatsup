using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WhatsUp;

/** A location fix: where, and how far off it may be in metres (0 when unknown). */
sealed record Fix(double Lat, double Lon, double AccuracyM);

/**
 * What MainActivity and SettingsActivity do around the page on Android, for a computer: the
 * requests the pages make (Serve and Data), the calls they make (OnGlobeMessage and
 * OnSettingsMessage), and what is pushed to them. The window and its web views are the shell's
 * (MainForm on Windows, MainWindow on Linux), which calls in here from its UI thread, and is called
 * back through the abstract members, from that thread too.
 */
abstract class Host
{
    const string LogTag = "Host";
    /** The pages' host name in their origin: never looked up, as every request to it is answered here. */
    public const string HostName = "whatsup.invalid";
    /** How long finished downloads stay on screen. */
    const int DownloadsLingerMs = 2500;
    /** Waiting downloads named in the queue line; the rest are counted. */
    const int QueueNamesShown = 3;

    protected readonly Settings settings = new();
    readonly DownloadTracker downloadTracker = new();
    readonly ElementSetRepository elementSets;
    readonly SatelliteCatalog catalog = new();
    readonly ConjunctionFeed conjunctions;
    readonly LaunchFeed launches = new();
    readonly AircraftFeed aircraftFeed = new();
    readonly FlightInfo flightInfo = new();
    readonly Skyline skyline = new();

    bool pageReady;
    /** Read by the /data/ handler (aircraft) off the UI thread too. */
    volatile Fix? lastLocation;
    volatile bool minimised;
    bool settingsShown;
    /** The location set by hand that lastLocation holds, or null while it is the system's. */
    Place? shownManualLocation;
    /** The globe flies to the first fix only; later fixes just move the marker. */
    bool centredOnFix;
    bool locationDeniedShown;
    string? shownTileSetId;
    string? shownLayers;
    /** The page's close approaches (/data/conjunctions.json), once the user has asked for them. */
    volatile byte[]? conjunctionData;
    List<ElementSet> shownElementSets = [];
    /** The satellite list the page fetches from /data/satellites.json (see globe.loadSatellites()); megabytes. */
    volatile byte[] satelliteData = [];
    /** The element sets satelliteData was built from, so an unchanged list isn't rebuilt or resent (that clears a selection). */
    List<ElementSet>? pushedElementSets;
    CancellationTokenSource? loadCancel;
    /** Bumped by each satellite push, so a slow, stale one can't land last. */
    int pushGeneration;

    /** Downloads changed since last shown: shown at most every 100 ms, as reports come every 32 kB. */
    volatile bool downloadsChanged;
    readonly Timer downloadsTimer;
    readonly Timer clearDownloads;

    protected Host()
    {
        elementSets = new ElementSetRepository(downloadTracker);
        conjunctions = new ConjunctionFeed(downloadTracker);
        downloadTracker.Changed += _ => downloadsChanged = true;
        downloadsTimer = new Timer(_ =>
        {
            if (!downloadsChanged) return;
            downloadsChanged = false;
            Post(() => ShowDownloads(downloadTracker.Downloads));
        }, null, 100, 100);
        clearDownloads = new Timer(_ => downloadTracker.ClearFinished());
    }

    // ---- The shell's ----

    /** Runs the action on the UI thread, later. From any thread. */
    protected abstract void Post(Action action);

    /** Runs a script in the globe page. */
    protected abstract void RunJs(string script);

    /** Runs a script in the settings page, if it is open. */
    protected abstract void RunSettingsJs(string script);

    /** Shows the settings page, freshly loaded from /desktop/settings.html, over the globe. */
    protected abstract void ShowSettingsView();

    /** Hides the settings page, back to the globe. */
    protected abstract void HideSettingsView();

    protected abstract void ToggleFullScreen();

    /** Starts the system's location: fixes to OnFix, and OnLocationDenied if it won't give one. */
    protected abstract void StartLocation();

    protected abstract void StopLocation();

    /** For a shell to call when the window is minimised or restored. */
    public void SetMinimised(bool value) => minimised = value;

    /** Whether the map is on screen: aircraft are only fetched then, never while minimised or in settings. */
    bool MapShown => !minimised && !settingsShown;

    /** A fix from the system's location. */
    protected void OnFix(Fix fix)
    {
        // A last fix can still arrive just after switching to a location set by hand.
        if (settings.ActiveManualLocation != null) return;
        lastLocation = fix;
        PushLocation();
        PushCompass();
    }

    /** The system won't say where the computer is. */
    protected void OnLocationDenied()
    {
        if (locationDeniedShown || settings.ActiveManualLocation != null) return;
        locationDeniedShown = true;
        Toast(Strings.Get("location_denied"));
    }

    // ---- Requests from the pages ----

    /**
     * Every request to the pages' origin, by its path without the leading /: the page and its
     * scripts (assets/, embedded), the desktop's own (desktop/), the Android icons as SVG (icons/),
     * and the strings. Null for data/, which the shell answers with Data, off the UI thread, and for
     * anything not found.
     */
    public static byte[]? StaticFile(string path)
    {
        if (path.StartsWith("assets/", StringComparison.Ordinal) || path.StartsWith("desktop/", StringComparison.Ordinal)) return App.Resource(path);
        if (path.StartsWith("icons/", StringComparison.Ordinal) && path.EndsWith(".svg", StringComparison.Ordinal)) return Icons.Svg(path[6..^4]);
        if (path == "strings.json") return Json.Bytes(new JsonObject(Strings.All.Select(s => KeyValuePair.Create(s.Key, (JsonNode?)s.Value))));
        return null;
    }

    public static string ContentType(string path) =>
        path.StartsWith("data/tile-preview/", StringComparison.Ordinal) ? "image/png"
        : path.StartsWith("data/", StringComparison.Ordinal) ? "application/json"
        : Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" => "application/json",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            _ => "text/plain; charset=utf-8",
        };

    /**
     * data/..., as MainActivity serves it, and the settings page's own; null if not found or failed.
     * May need the network, so off the UI thread.
     */
    public byte[]? Data(string path)
    {
        try
        {
            return DataOrThrow(path["data/".Length..]);
        }
        catch (Exception error)
        {
            App.Warn(LogTag, $"/{path} failed", error);
            return null;
        }
    }

    byte[]? DataOrThrow(string path) => path switch
    {
        "satellites.json" => satelliteData,
        "conjunctions.json" => conjunctionData,
        // From the saved copy unless it is an hour old.
        "launches.json" => launches.Load(),
        // A clicked satellite's catalogue record.
        _ when path.StartsWith("satcat/", StringComparison.Ordinal) =>
            int.TryParse(path["satcat/".Length..], out var id) ? catalog.Lookup(id) : null,
        // Live aircraft around the location (aircraft.js polls it).
        "aircraft.json" => AircraftData(),
        // A selected aircraft's route, airframe and track (flight/route/BAW83 and so on).
        _ when path.StartsWith("flight/", StringComparison.Ordinal) => FlightData(path["flight/".Length..]),
        // The terrain's skyline round a place (skyline/53.5461,-113.4938), for sky view.
        _ when path.StartsWith("skyline/", StringComparison.Ordinal) => SkylineData(path["skyline/".Length..]),
        _ when path.StartsWith("tile-preview/", StringComparison.Ordinal) => TileSets.Preview(path["tile-preview/".Length..]),
        "settings.json" => Json.Bytes(SettingsPage.State(settings)),
        _ => null,
    };

    /** The aircraft around the location, if the map is showing and there is a location; see AircraftFeed. */
    byte[] AircraftData()
    {
        var location = lastLocation;
        if (!MapShown || location == null || !settings.AircraftShown) return AircraftFeed.Error("waiting");
        return aircraftFeed.Load(location.Lat, location.Lon, settings.AircraftRadiusNm, settings.AircraftReceiver);
    }

    /** flight/<kind>/<key>: see FlightInfo. */
    byte[]? FlightData(string path)
    {
        var parts = path.Split('/', 2);
        if (parts.Length != 2) return null;
        return parts[0] switch
        {
            "route" => flightInfo.Route(parts[1]),
            "airframe" => flightInfo.Airframe(parts[1]),
            "track" => flightInfo.Track(parts[1]),
            _ => null,
        };
    }

    byte[]? SkylineData(string place)
    {
        var parts = place.Split(',');
        if (parts.Length != 2 ||
            !double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var lat) ||
            !double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var lon)) return null;
        if (lat is < -85 or > 85 || lon is < -180 or > 180) return null;
        return skyline.Load(lat, lon);
    }

    // ---- Calls from the globe page (window.Android in bridge.js, and desktop.js) ----

    public void OnGlobeMessage(string json)
    {
        if (JsonNode.Parse(json) is not JsonObject message) return;
        var args = message["args"] as JsonArray ?? [];
        string Text(int i) => args.Count > i && args[i] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
        bool Flag(int i) => args.Count > i && args[i] is JsonValue v && v.TryGetValue<bool>(out var b) && b;
        double Number(int i) => args.Count > i && args[i] is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0;
        switch (Json.Text(message, "call"))
        {
            // Passes from passes.js (visible ISS passes and starred satellites' passes).
            case "setPassAlerts":
                PassAlerts.Update(settings, Text(0));
                break;
            // The catalogue numbers of the starred satellites, as a JSON array.
            case "setFavourites":
                settings.Favourites = (JsonNode.Parse(Text(0)) as JsonArray ?? []).Select(n => n?.GetValue<int>() ?? 0).Where(n => n > 0).ToHashSet();
                break;
            // Fetches the close approaches (a large download, so only when asked) and tells the page
            // through globe.conjunctionsLoaded() whether /data/conjunctions.json now has them.
            case "loadConjunctions":
                LoadConjunctions();
                break;
            // The dish aligner's compass calibration: a mouse-pointed sky view has no compass to calibrate.
            case "setCompassOffset":
                break;
            // desktop.js's buttons and keys.
            case "openSettings":
                OpenSettings();
                break;
            case "recentre":
                if (lastLocation == null) Toast(Strings.Get("no_location_yet"));
                else RunJs("globe.closePanels(); globe.recentre()");
                break;
            case "toggleNight":
                settings.NightVision = !settings.NightVision;
                PushNight();
                break;
            case "setButtonsHidden":
                settings.ButtonsHidden = Flag(0);
                break;
            case "setSkyLook":
                settings.SkyLook = Text(0);
                break;
            case "fullScreen":
                ToggleFullScreen();
                break;
            // The page's own location (desktop.watchLocation), where the system's is had through the web view.
            case "fix":
                OnFix(new Fix(Number(0), Number(1), Number(2)));
                break;
            case "locationDenied":
                OnLocationDenied();
                break;
        }
    }

    async void LoadConjunctions()
    {
        var shown = shownElementSets.Select(s => s.NoradId).ToHashSet();
        var starred = settings.Favourites;
        var data = await Task.Run(() => conjunctions.Load(shown, starred));
        Post(() =>
        {
            conjunctionData = data;
            RunJs($"globe.conjunctionsLoaded({(data != null ? "true" : "false")})");
        });
    }

    // ---- To the globe page ----

    /** For the shell to call when the globe page has loaded. */
    public void OnPageFinished()
    {
        pageReady = true;
        // A (re)loaded page has none of what was sent to the last one: tiles, layers, satellites,
        // nor a view of the location to keep.
        pushedElementSets = null;
        shownTileSetId = null;
        shownLayers = null;
        centredOnFix = false;
        RunJs($"desktop.start({new JsonObject { ["buttonsHidden"] = settings.ButtonsHidden, ["skyLook"] = settings.SkyLook ?? "" }.ToJsonString()})");
        PushNight();
        PushTileSet();
        PushLayers();
        PushLocation();
        PushCompass();
        PushFavourites();
        PushSatellites();
        PageReady();
    }

    /** For a shell with more to send a newly loaded page. */
    protected virtual void PageReady() { }

    protected bool IsPageReady => pageReady;

    /**
     * MainActivity's onStart and onResume: on opening, and on coming back from settings, which may
     * have changed the location, map, satellite groups, layers or alerts.
     */
    public void Resume()
    {
        ApplyLocationSource();
        PushTileSet();
        PushLayers();
        PushNight();
        LoadSatellites();
        PassAlerts.Reschedule(settings);
    }

    /**
     * Uses the location set by hand in settings, if it is on, in place of the system's (whose
     * tracking stops); otherwise the system's. On a switch, the globe flies to the new one.
     */
    void ApplyLocationSource()
    {
        var manual = settings.ActiveManualLocation;
        if (manual != null)
        {
            StopLocation();
            if (manual == shownManualLocation) return;
            shownManualLocation = manual;
            lastLocation = new Fix(manual.Position.Lat, manual.Position.Lon, 0);
            centredOnFix = false;
            PushLocation();
            PushCompass();
            return;
        }
        if (shownManualLocation != null)
        {
            // Back to the system's: forget the hand-set place (the page too, so nothing goes on using
            // it), before tracking starts and its first fix flies the globe there.
            shownManualLocation = null;
            lastLocation = null;
            centredOnFix = false;
            if (pageReady) RunJs("globe.clearLocation()");
            PushCompass();
        }
        StartLocation();
    }

    void PushTileSet()
    {
        var tileSet = settings.TileSet;
        if (!pageReady || tileSet.Id == shownTileSetId) return;
        shownTileSetId = tileSet.Id;
        RunJs($"globe.setTiles({tileSet.ToJson().ToJsonString()})");
    }

    void PushLayers()
    {
        var json = settings.LayersJson().ToJsonString();
        if (!pageReady || json == shownLayers) return;
        shownLayers = json;
        RunJs($"globe.setLayers({json})");
    }

    void PushLocation()
    {
        if (lastLocation is not { } location || !pageReady) return;
        RunJs(FormattableString.Invariant(
            $"globe.setLocation({location.Lat}, {location.Lon}, {location.AccuracyM}, {(!centredOnFix ? "true" : "false")})"));
        centredOnFix = true;
    }

    /**
     * Sky view's heading correction: none, as it is pointed with the mouse at true azimuths, not with
     * a compass (MainActivity sends the magnetic declination and the user's calibration).
     */
    void PushCompass()
    {
        if (pageReady) RunJs($"globe.setCompass(0, 0, {(lastLocation != null ? "true" : "false")})");
    }

    void PushFavourites()
    {
        if (pageReady) RunJs($"globe.setFavourites({new JsonArray(settings.Favourites.Select(f => (JsonNode)f).ToArray()).ToJsonString()})");
    }

    /** Red night mode on or off as set, on both pages. */
    void PushNight()
    {
        var on = settings.NightVision ? "true" : "false";
        if (pageReady) RunJs($"desktop.setNight({on})");
        RunSettingsJs($"window.settingsPage?.setNight({on})");
    }

    /** ElementSetRepository refetches groups older than it allows; newer ones come from its cache. */
    async void LoadSatellites()
    {
        var groups = settings.ShownGroups;
        loadCancel?.Cancel();
        var cancel = new CancellationTokenSource();
        loadCancel = cancel;
        elementSets.Queue(groups);
        try
        {
            // ShownGroups keeps SatelliteGroup's order, so a satellite in several goes to the first.
            var all = new List<ElementSet>();
            foreach (var group in groups) all.AddRange(await elementSets.Get(group, cancel.Token));
            if (cancel.IsCancellationRequested) return;
            shownElementSets = all.DistinctBy(s => s.NoradId).ToList();
        }
        catch (OperationCanceledException)
        {
            return;
        }
        finally
        {
            // Done, or cancelled by a newer load (which clears the queue itself): nothing left
            // waiting, including any left by a load this one replaced.
            if (loadCancel == cancel) downloadTracker.Unqueue();
        }
        PushSatellites();
        // How old the data is: old means the computer has been offline (the saved copies are used).
        var updatedAt = groups.Select(elementSets.UpdatedAt).Where(t => t > 0).DefaultIfEmpty(0).Min();
        if (pageReady) RunJs($"globe.setDataAge({updatedAt})");
    }

    async void PushSatellites()
    {
        var sets = shownElementSets;
        if (!pageReady || (pushedElementSets != null && sets.SequenceEqual(pushedElementSets))) return;
        var generation = ++pushGeneration;
        var json = await Task.Run(() =>
        {
            var groups = new JsonObject();
            foreach (var group in SatelliteGroup.Entries) groups[group.Key] = group.StyleJson(Strings.Get(group.Title).Split('\n')[0]);
            var satellites = new JsonArray();
            foreach (var set in sets) satellites.Add(set.ToJson());
            return Json.Bytes(new JsonObject
            {
                ["groups"] = groups,
                // CelesTrak's OMM CSV columns, the same for every query; each satellite is its values.
                ["columns"] = new JsonArray((sets.FirstOrDefault()?.Columns ?? []).Select(c => (JsonNode)c).ToArray()),
                ["satellites"] = satellites,
            });
        });
        if (generation != pushGeneration) return;
        satelliteData = json;
        pushedElementSets = sets;
        RunJs("globe.loadSatellites()");
    }

    /** A message at the bottom of the window for a few seconds, as Android's Toast. */
    protected void Toast(string text)
    {
        if (pageReady) RunJs($"desktop.toast({JsonSerializer.Serialize(text)})");
    }

    /**
     * The downloads as a queue at the bottom of the window: how far through it is, the one under way
     * (or, at the end, the last), and what is waiting. It goes once all have finished and been seen.
     */
    void ShowDownloads(IReadOnlyList<Download> all)
    {
        clearDownloads.Change(Timeout.Infinite, Timeout.Infinite);
        if (!pageReady) return;
        if (all.Count == 0)
        {
            RunJs("desktop.showDownloads(null)");
            return;
        }
        var waiting = all.Where(d => d.State == Download.States.Queued).ToList();
        var finished = all.Count(d => !d.Active);
        var failed = all.Count(d => d.State == Download.States.Failed);
        var current = all.FirstOrDefault(d => d.State == Download.States.Running) ?? waiting.FirstOrDefault() ?? all[^1];
        var done = all.All(d => !d.Active);
        var summary = !done ? Strings.Get("downloads_running", Math.Min(finished + 1, all.Count), all.Count)
            : failed > 0 ? Strings.Get("downloads_failed", failed, all.Count)
            : Strings.Get("downloads_finished");
        var known = current.TotalBytes > 0;
        var status = current.State switch
        {
            Download.States.Queued => Strings.Get("download_queued"),
            Download.States.Running when known => Strings.Get("download_progress", FormatSize(current.BytesRead), FormatSize(current.TotalBytes)),
            Download.States.Running when current.BytesRead > 0 => FormatSize(current.BytesRead),
            Download.States.Running => Strings.Get("download_starting"),
            Download.States.Done => Strings.Get("download_done", FormatSize(current.BytesRead)),
            Download.States.NotUpdated => Strings.Get("download_not_updated"),
            _ => Strings.Get("download_failed"),
        };
        // 0 to 1, or -1 for under way at an unknown size.
        var progress = current.State switch
        {
            Download.States.Queued => 0.0,
            Download.States.Running => known ? (double)current.BytesRead / current.TotalBytes : -1,
            _ => 1.0,
        };
        var next = waiting.Where(d => !ReferenceEquals(d, current)).ToList();
        var names = string.Join(", ", next.Take(QueueNamesShown).Select(d => d.File));
        var queue = next.Count == 0 ? ""
            : next.Count > QueueNamesShown ? Strings.Get("downloads_next_more", names, next.Count - QueueNamesShown)
            : Strings.Get("downloads_next", names);
        RunJs($"desktop.showDownloads({new JsonObject { ["summary"] = summary, ["file"] = current.File, ["status"] = status, ["progress"] = progress, ["queue"] = queue }.ToJsonString()})");
        if (done) clearDownloads.Change(DownloadsLingerMs, Timeout.Infinite);
    }

    /** "1.2 MB", as Android's Formatter.formatShortFileSize (in thousands, not 1,024s). */
    static string FormatSize(long bytes)
    {
        string[] units = ["B", "kB", "MB", "GB"];
        double value = bytes;
        var unit = 0;
        while (value >= 1000 && unit < units.Length - 1)
        {
            value /= 1000;
            unit++;
        }
        return unit == 0 ? $"{bytes} B" : value.ToString(value < 10 ? "0.0" : "0", CultureInfo.CurrentCulture) + " " + units[unit];
    }

    // ---- Settings ----

    void OpenSettings()
    {
        settingsShown = true;
        ShowSettingsView();
    }

    void CloseSettings()
    {
        if (!settingsShown) return;
        settingsShown = false;
        HideSettingsView();
        Resume();
    }

    public async void OnSettingsMessage(string json)
    {
        if (JsonNode.Parse(json) is not JsonObject message) return;
        switch (Json.Text(message, "call"))
        {
            case "close":
                CloseSettings();
                break;
            case "set":
                var reply = SettingsPage.Set(settings, Json.Text(message, "key"), message["value"]);
                if (reply != null) RunSettingsJs(reply);
                break;
            case "findPlace":
                var text = Json.Text(message, "text");
                var answer = await SettingsPage.Find(settings, text);
                Post(() => RunSettingsJs($"settingsPage.placeFound({answer.ToJsonString()})"));
                break;
        }
    }
}
