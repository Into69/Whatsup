using System.Globalization;
using System.Text.Json.Nodes;

namespace WhatsUp;

/** Parts of the globe's drawing the user can turn off. Key is the name globe.setLayers() takes. */
sealed record DisplayLayer(string Key, string Title, bool ShownByDefault = true)
{
    public static readonly IReadOnlyList<DisplayLayer> Entries =
    [
        new("favouritesOnly", "layer_favourites_only", ShownByDefault: false),
        new("orbits", "layer_orbits"),
        new("groundTracks", "layer_ground_tracks"),
        new("altitudeLines", "layer_altitude_lines"),
        new("footprints", "layer_footprints"),
        new("planes", "layer_planes", ShownByDefault: false),
        new("geoBelt", "layer_geo_belt"),
        new("launches", "layer_launches"),
        new("myLocation", "layer_my_location"),
        new("dayNight", "layer_day_night"),
        new("stars", "layer_stars"),
        new("constellations", "layer_constellations", ShownByDefault: false),
        new("skyline", "layer_skyline"),
        new("trueScale", "layer_true_scale", ShownByDefault: false),
    ];
}

/**
 * How the settings page sorts the satellite groups into cards. Separate from SatelliteGroup's own
 * order, which decides which group a satellite in several belongs to.
 */
sealed record SatelliteCategory(string Key, string Title, IReadOnlyList<SatelliteGroup> Groups)
{
    public static readonly IReadOnlyList<SatelliteCategory> Entries =
    [
        new("crewed", "category_crewed", [SatelliteGroup.Iss, SatelliteGroup.Stations]),
        new("broadband", "category_broadband",
            [SatelliteGroup.Starlink, SatelliteGroup.OneWeb, SatelliteGroup.AmazonLeo, SatelliteGroup.Qianfan, SatelliteGroup.Guowang]),
        new("communications", "category_communications",
            [SatelliteGroup.Iridium, SatelliteGroup.Globalstar, SatelliteGroup.Orbcomm, SatelliteGroup.OtherComm, SatelliteGroup.XComm]),
        new("earth", "category_earth", [SatelliteGroup.Weather, SatelliteGroup.Planet, SatelliteGroup.Spire]),
        new("navigation", "category_navigation", [SatelliteGroup.Gnss]),
        new("radio", "category_radio", [SatelliteGroup.Amateur, SatelliteGroup.Satnogs]),
        new("orbits", "category_orbits", [SatelliteGroup.Geo, SatelliteGroup.Heo, SatelliteGroup.Meo, SatelliteGroup.Leo]),
        new("tracking", "category_tracking", [SatelliteGroup.Recent, SatelliteGroup.Gpz, SatelliteGroup.Debris]),
    ];

    static SatelliteCategory()
    {
        // Every group needs a card, once, or it could never be switched on or off.
        var grouped = Entries.SelectMany(c => c.Groups).ToList();
        if (grouped.Count != SatelliteGroup.Entries.Count || grouped.Except(SatelliteGroup.Entries).Any())
        {
            throw new InvalidOperationException("Each SatelliteGroup must be in exactly one SatelliteCategory");
        }
    }
}

/**
 * The user's choices, in settings.json beside the cache; the keys are the Android app's
 * SharedPreferences ones. Shared by the window and the settings page, from any thread.
 */
sealed class Settings
{
    const string KeyTileSet = "tileSet";
    const string KeyGroupPrefix = "showGroup.";
    const string KeyLayerPrefix = "showLayer.";
    const string KeyPassAlerts = "passAlerts";
    const string KeyFavouriteAlerts = "favouriteAlerts";
    const string KeyFavourites = "favourites";
    const string KeyButtonsHidden = "buttonsHidden";
    const string KeyNightVision = "nightVision";
    const string KeyOfflineMode = "offlineMode";
    const string KeyAircraft = "showAircraft";
    const string KeyAircraftRadius = "aircraftRadiusNm";
    const string KeyAircraftReceiver = "aircraftReceiver";
    const string KeyManualLat = "manualLat";
    const string KeyManualLon = "manualLon";
    const string KeyManualLabel = "manualLabel";
    const string KeyManualSource = "manualSource";
    const string KeyUseManualLocation = "useManualLocation";
    const string KeyWindow = "window";
    /** Where sky view last looked, as dragged with the mouse. */
    const string KeySkyLook = "skyLook";
    const string KeyCheckUpdates = "checkUpdates";
    const string KeyLastUpdateCheck = "lastUpdateCheck";

    readonly string file = Path.Combine(App.DataDir, "settings.json");
    readonly object gate = new();
    readonly JsonObject prefs;

    public Settings()
    {
        try
        {
            prefs = File.Exists(file) ? JsonNode.Parse(File.ReadAllText(file)) as JsonObject ?? [] : [];
        }
        catch (Exception e)
        {
            App.Warn("Settings", "Unreadable settings, starting afresh", e);
            prefs = [];
        }
        Http.Offline = OfflineMode;
    }

    bool GetBool(string key, bool fallback)
    {
        lock (gate) return prefs[key] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;
    }

    string? GetString(string key)
    {
        lock (gate) return prefs[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    }

    int GetInt(string key, int fallback)
    {
        lock (gate) return prefs[key] is JsonValue v && v.TryGetValue<int>(out var i) ? i : fallback;
    }

    long GetLong(string key, long fallback)
    {
        lock (gate) return prefs[key] is JsonValue v && v.TryGetValue<long>(out var l) ? l : fallback;
    }

    void Put(string key, JsonNode? value)
    {
        lock (gate)
        {
            if (value == null) prefs.Remove(key); else prefs[key] = value;
            try
            {
                Directory.CreateDirectory(App.DataDir);
                var part = file + ".part";
                File.WriteAllText(part, prefs.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
                File.Move(part, file, overwrite: true);
            }
            catch (IOException e)
            {
                App.Warn("Settings", "Couldn't save settings", e);
            }
        }
    }

    public TileSet TileSet
    {
        get => TileSets.ById(GetString(KeyTileSet));
        set => Put(KeyTileSet, value.Id);
    }

    public bool IsShown(SatelliteGroup group) => GetBool(KeyGroupPrefix + group.Key, group.ShownByDefault);

    public void SetShown(SatelliteGroup group, bool shown) => Put(KeyGroupPrefix + group.Key, shown);

    public List<SatelliteGroup> ShownGroups => SatelliteGroup.Entries.Where(IsShown).ToList();

    public bool IsShown(DisplayLayer layer) => GetBool(KeyLayerPrefix + layer.Key, layer.ShownByDefault);

    public void SetShown(DisplayLayer layer, bool shown) => Put(KeyLayerPrefix + layer.Key, shown);

    /** Notify of visible ISS passes; see PassAlerts. */
    public bool PassAlerts
    {
        get => GetBool(KeyPassAlerts, false);
        set => Put(KeyPassAlerts, value);
    }

    /** Notify of every pass of a starred satellite; see PassAlerts. */
    public bool FavouriteAlerts
    {
        get => GetBool(KeyFavouriteAlerts, false);
        set => Put(KeyFavouriteAlerts, value);
    }

    /** Catalogue numbers of the satellites the user has starred. */
    public HashSet<int> Favourites
    {
        get => (GetString(KeyFavourites) ?? "").Split(',').Select(s => int.TryParse(s, out var n) ? n : 0).Where(n => n > 0).ToHashSet();
        set => Put(KeyFavourites, string.Join(",", value));
    }

    /** A location the user set by hand; used instead of the system's while UseManualLocation. */
    public Place? ManualLocation
    {
        get
        {
            if (!double.TryParse(GetString(KeyManualLat), NumberStyles.Float, CultureInfo.InvariantCulture, out var lat)) return null;
            if (!double.TryParse(GetString(KeyManualLon), NumberStyles.Float, CultureInfo.InvariantCulture, out var lon)) return null;
            // Android saves the source as its enum's name: COORDINATES, MGRS or ADDRESS.
            var source = Enum.TryParse<Place.Sources>(GetString(KeyManualSource), ignoreCase: true, out var s) ? s : Place.Sources.Coordinates;
            return new Place(new LatLon(lat, lon), GetString(KeyManualLabel) ?? "", source);
        }
        set
        {
            Put(KeyManualLat, value?.Position.Lat.ToString(CultureInfo.InvariantCulture));
            Put(KeyManualLon, value?.Position.Lon.ToString(CultureInfo.InvariantCulture));
            Put(KeyManualLabel, value?.Label);
            Put(KeyManualSource, value?.Source.ToString().ToUpperInvariant());
        }
    }

    public bool UseManualLocation
    {
        get => GetBool(KeyUseManualLocation, false);
        set => Put(KeyUseManualLocation, value);
    }

    /** The manual location when it is turned on, else null (use the system's). */
    public Place? ActiveManualLocation => UseManualLocation ? ManualLocation : null;

    /**
     * Use only what is saved on this computer: no downloads (orbital data, catalogue, launches,
     * close approaches, addresses).
     */
    public bool OfflineMode
    {
        get => GetBool(KeyOfflineMode, false);
        set
        {
            Put(KeyOfflineMode, value);
            Http.Offline = value;
        }
    }

    /** Red night mode, for keeping the eyes dark-adapted outside. */
    public bool NightVision
    {
        get => GetBool(KeyNightVision, false);
        set => Put(KeyNightVision, value);
    }

    /** Whether the map's column of buttons is folded away under its toggle. */
    public bool ButtonsHidden
    {
        get => GetBool(KeyButtonsHidden, false);
        set => Put(KeyButtonsHidden, value);
    }

    /** Live aircraft from ADS-B (AircraftFeed), shown as a layer of their own. */
    public bool AircraftShown
    {
        get => GetBool(KeyAircraft, false);
        set => Put(KeyAircraft, value);
    }

    /** How far around the location to show aircraft, in nautical miles. */
    public int AircraftRadiusNm
    {
        get => GetInt(KeyAircraftRadius, AircraftFeed.DefaultRadiusNm);
        set => Put(KeyAircraftRadius, value);
    }

    /** The address of the user's own ADS-B receiver's aircraft.json, or "" to use the public networks. */
    public string AircraftReceiver
    {
        get => GetString(KeyAircraftReceiver) ?? "";
        set => Put(KeyAircraftReceiver, value.Trim());
    }

    /** The window's last place and size, "x,y,width,height,maximised". */
    public string? Window
    {
        get => GetString(KeyWindow);
        set => Put(KeyWindow, value);
    }

    /** Sky view's last direction, "azimuth,elevation,field of view", as desktop.js keeps it. */
    public string? SkyLook
    {
        get => GetString(KeySkyLook);
        set => Put(KeySkyLook, value);
    }

    /** Look for a newer WhatsUp on GitHub once a day, and offer it (Updates). */
    public bool CheckUpdates
    {
        get => GetBool(KeyCheckUpdates, true);
        set => Put(KeyCheckUpdates, value);
    }

    /** When Updates last looked, in milliseconds since 1970 (0 for never). */
    public long LastUpdateCheck
    {
        get => GetLong(KeyLastUpdateCheck, 0);
        set => Put(KeyLastUpdateCheck, value);
    }

    /** The shape globe.setLayers() takes: each layer's key to whether it is shown. */
    public JsonObject LayersJson()
    {
        var json = new JsonObject();
        foreach (var layer in DisplayLayer.Entries) json[layer.Key] = IsShown(layer);
        json["aircraft"] = AircraftShown;
        return json;
    }
}
