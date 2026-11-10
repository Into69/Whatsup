using System.Text.Json.Nodes;

namespace WhatsUp;

/**
 * The settings page's side here (web/settings.js builds the page, as SettingsActivity does on
 * Android): what it shows, from /data/settings.json, and the changes it sends back.
 */
static class SettingsPage
{
    /** Everything the page needs: the lists to build it from, and the current choices. */
    public static JsonObject State(Settings settings)
    {
        static JsonArray Array(IEnumerable<JsonNode> nodes) => new(nodes.ToArray());
        return new JsonObject
        {
            ["version"] = Http.Version,
            ["platform"] = OperatingSystem.IsWindows() ? "Windows" : "Linux",
            ["nightVision"] = settings.NightVision,
            ["location"] = new JsonObject
            {
                ["useManual"] = settings.UseManualLocation,
                ["source"] = DescribeLocationSource(settings),
                ["place"] = settings.ManualLocation is { } place ? DescribePlace(place) : null,
            },
            ["offlineMode"] = settings.OfflineMode,
            ["tileSet"] = settings.TileSet.Id,
            ["tileSets"] = Array(TileSets.All.Select(t => (JsonNode)new JsonObject
            {
                ["id"] = t.Id,
                ["name"] = t.Name,
                ["description"] = t.Description,
            })),
            ["categories"] = Array(SatelliteCategory.Entries.Select(c => (JsonNode)new JsonObject
            {
                ["key"] = c.Key,
                ["title"] = Strings.Get(c.Title),
                ["groups"] = Array(c.Groups.Select(g => (JsonNode)new JsonObject
                {
                    ["key"] = g.Key,
                    ["title"] = Strings.Get(g.Title),
                    ["color"] = $"#{g.Color:X6}",
                    ["shown"] = settings.IsShown(g),
                })),
            })),
            ["layers"] = Array(DisplayLayer.Entries.Select(l => (JsonNode)new JsonObject
            {
                ["key"] = l.Key,
                ["title"] = Strings.Get(l.Title),
                ["shown"] = settings.IsShown(l),
            })),
            ["aircraft"] = new JsonObject
            {
                ["shown"] = settings.AircraftShown,
                ["radiusNm"] = settings.AircraftRadiusNm,
                ["minNm"] = AircraftFeed.MinRadiusNm,
                ["maxNm"] = AircraftFeed.MaxRadiusNm,
                ["receiver"] = settings.AircraftReceiver,
            },
            ["passAlerts"] = settings.PassAlerts,
            ["favouriteAlerts"] = settings.FavouriteAlerts,
        };
    }

    /**
     * A change from the page: "group.<key>", "layer.<key>" or a setting's name, to value. Returns a
     * script for the page to run in answer, if any.
     */
    public static string? Set(Settings settings, string key, JsonNode? value)
    {
        bool On() => value is JsonValue v && v.TryGetValue<bool>(out var b) && b;
        string Text() => value is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
        if (key.StartsWith("group.", StringComparison.Ordinal))
        {
            if (SatelliteGroup.Entries.FirstOrDefault(g => g.Key == key[6..]) is { } group) settings.SetShown(group, On());
            return null;
        }
        if (key.StartsWith("layer.", StringComparison.Ordinal))
        {
            if (DisplayLayer.Entries.FirstOrDefault(l => l.Key == key[6..]) is { } layer) settings.SetShown(layer, On());
            return null;
        }
        switch (key)
        {
            case "useManualLocation":
                if (On() && settings.ManualLocation == null) return $"settingsPage.manualRefused({Quote(Strings.Get("manual_location_first"))})";
                settings.UseManualLocation = On();
                return $"settingsPage.locationSource({Quote(DescribeLocationSource(settings))})";
            case "offlineMode":
                settings.OfflineMode = On();
                break;
            case "tileSet":
                settings.TileSet = TileSets.ById(Text());
                break;
            case "aircraftShown":
                settings.AircraftShown = On();
                break;
            case "aircraftRadiusNm":
                if (value is JsonValue n && n.TryGetValue<int>(out var nm)) settings.AircraftRadiusNm = Math.Clamp(nm, AircraftFeed.MinRadiusNm, AircraftFeed.MaxRadiusNm);
                break;
            case "aircraftReceiver":
                settings.AircraftReceiver = Text();
                break;
            case "passAlerts":
            case "favouriteAlerts":
                if (key == "passAlerts") settings.PassAlerts = On(); else settings.FavouriteAlerts = On();
                // Turning an alert on when the system won't show the app's notifications: they go back off.
                if (On() && !PassAlerts.CanNotify())
                {
                    settings.PassAlerts = false;
                    settings.FavouriteAlerts = false;
                    return $"settingsPage.alertsRefused({Quote(Strings.Get("pass_alerts_denied"))})";
                }
                break;
        }
        return null;
    }

    /** Looks up what the user typed; the answer the page shows, and the place kept and turned on if found. */
    public static async Task<JsonObject> Find(Settings settings, string text)
    {
        var place = await Places.Find(text);
        if (place == null)
        {
            return new JsonObject
            {
                ["found"] = false,
                ["message"] = Strings.Get(settings.OfflineMode ? "manual_location_not_found_offline" : "manual_location_not_found", text.Trim()),
            };
        }
        settings.ManualLocation = place;
        settings.UseManualLocation = true;
        return new JsonObject
        {
            ["found"] = true,
            ["message"] = DescribePlace(place),
            ["source"] = DescribeLocationSource(settings),
        };
    }

    static string DescribeLocationSource(Settings settings)
    {
        if (settings.ActiveManualLocation is not { } place) return Strings.Get("manual_location_off");
        return Strings.Get("manual_location_on", place.Label.Length > 0 ? place.Label : place.Position.Format());
    }

    /** A found place in every form: its name, latitude and longitude, and MGRS. */
    static string DescribePlace(Place place)
    {
        var how = Strings.Get(place.Source switch
        {
            Place.Sources.Coordinates => "manual_location_from_coordinates",
            Place.Sources.Mgrs => "manual_location_from_mgrs",
            _ => "manual_location_from_address",
        });
        var lines = new List<string>
        {
            $"✓ {how}: {place.Label}",
            Strings.Get("manual_location_lat_lon", place.Position.Format()),
        };
        if (Coordinates.ToMgrs(place.Position) is { } mgrs) lines.Add(Strings.Get("manual_location_mgrs", mgrs));
        return string.Join("\n", lines);
    }

    static string Quote(string text) => System.Text.Json.JsonSerializer.Serialize(text);
}
