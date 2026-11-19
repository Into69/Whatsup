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
            ["checkUpdates"] = settings.CheckUpdates,
            ["starlink"] = new JsonObject
            {
                ["on"] = settings.StarlinkDish,
                ["address"] = settings.StarlinkAddress,
            },
            ["oneweb"] = new JsonObject
            {
                ["on"] = settings.OneWebTerminal,
                ["address"] = settings.OneWebAddress,
            },
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
            case "checkUpdates":
                settings.CheckUpdates = On();
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
            case "starlinkDish":
                settings.StarlinkDish = On();
                break;
            case "starlinkAddress":
                settings.StarlinkAddress = Text();
                break;
            case "onewebTerminal":
                settings.OneWebTerminal = On();
                break;
            case "onewebAddress":
                settings.OneWebAddress = Text();
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

    /**
     * Check now: whether GitHub has a newer version. The answer for the page is { text, update }:
     * what to say, and whether its button now updates; Release is the newer version, if any.
     */
    public static async Task<(Release? Release, JsonObject Answer)> CheckUpdate(Settings settings)
    {
        static JsonObject Answer(string text, bool update = false) => new() { ["text"] = text, ["update"] = update };
        if (settings.OfflineMode) return (null, Answer(Strings.Get("update_offline")));
        try
        {
            var latest = await Task.Run(Updates.Latest);
            settings.LastUpdateCheck = App.Now();
            if (latest == null || !Updates.IsNewer(latest.Version, Http.Version)) return (null, Answer(Strings.Get("update_current", Http.Version)));
            return (latest, Answer(Strings.Get("update_available", latest.Version) + "\n" + Strings.Get("update_available_detail", Http.Version), update: true));
        }
        catch (Exception e)
        {
            App.Warn("SettingsPage", "Checking for an update failed", e);
            return (null, Answer(Strings.Get("update_check_failed", e.Message)));
        }
    }

    /**
     * The Starlink card's Check: reads the dish and says what it found ({ text }): connected, where it
     * points and wants to, alerts, the map; or why not. Blocking: call off the UI thread.
     */
    public static JsonObject CheckStarlink(Settings settings)
    {
        var address = settings.StarlinkAddress;
        var json = JsonNode.Parse(new StarlinkDish().Load(address))!.AsObject();
        return new JsonObject { ["text"] = DescribeStarlink(address, json) };
    }

    static string DescribeStarlink(string address, JsonObject json)
    {
        var shown = address.Trim().Length > 0 ? address.Trim() : StarlinkDish.DefaultAddress;
        if (json["error"] is JsonValue error) return Strings.Get("starlink_unreachable", shown, (string)error!);
        var dish = json["dish"]!;
        var software = (string?)dish["software"];
        var lines = new List<string> { Strings.Get("starlink_connected", string.IsNullOrEmpty(software) ? "?" : software) };
        var boresight = dish["alignment"]?["boresight"];
        var desired = dish["alignment"]?["desired"];
        static string AzEl(JsonNode d) => $"Az {(double)d["az"]!:0.0}° El {(double)d["el"]!:0.0}°";
        if (boresight != null && desired != null)
        {
            var off = StarlinkDish.Separation(boresight, desired);
            lines.Add(Strings.Get("starlink_pointing", AzEl(boresight), AzEl(desired),
                off < 1 ? Strings.Get("starlink_aligned") : Strings.Get("starlink_off_by", $"{off:0.0}°")));
        }
        else
        {
            lines.Add(Strings.Get("starlink_no_alignment"));
        }
        if ((bool?)dish["stowed"] == true) lines.Add(Strings.Get("starlink_stowed"));
        var alerts = (dish["alerts"] as JsonObject)?.Select(a => Strings.Get($"starlink_alert_{a.Key}")).ToList() ?? [];
        if (alerts.Count > 0) lines.Add(Strings.Get("starlink_alerts", string.Join(", ", alerts)));
        if (json["map"] is { } map)
        {
            var (seen, obstructed) = StarlinkDish.MapStats(map);
            lines.Add(Strings.Get("starlink_map", $"{seen * 100:0}%", $"{obstructed * 100:0.0}%"));
        }
        else
        {
            var reason = (string?)json["mapError"];
            lines.Add(Strings.Get("starlink_no_map", string.IsNullOrEmpty(reason) ? "?" : reason));
        }
        return string.Join("\n", lines);
    }

    /**
     * The OneWeb card's Check: reads the terminal and says what it found ({ text, raw }: raw is every
     * answer as it came, for Copy details). Blocking: call off the UI thread.
     */
    public static JsonObject CheckOneWeb(Settings settings)
    {
        var address = settings.OneWebAddress;
        var json = new OneWebTerminal().LoadJson(address, raw: true);
        return new JsonObject { ["text"] = DescribeOneWeb(address, json), ["raw"] = json.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }) };
    }

    static string DescribeOneWeb(string address, JsonObject json)
    {
        var shown = address.Trim().Length > 0 ? address.Trim() : OneWebTerminal.DefaultAddress;
        if (json["error"] is JsonValue error) return Strings.Get("oneweb_unreachable", shown, (string)error!);
        var t = json["terminal"]!;
        var lines = new List<string> { Strings.Get("oneweb_connected") };
        if ((long?)t["satellite"] is > 0 and var satellite)
        {
            var sinr = t["sinr"] is { } s ? $"{(double)s:0.0} dB" : "?";
            lines.Add(Strings.Get("oneweb_satellite", satellite.ToString()!, t["trackId"]?.ToString() ?? "?", sinr));
        }
        else
        {
            lines.Add(Strings.Get("oneweb_no_satellite"));
        }
        if (t["pointingScore"] is { } score) lines.Add(Strings.Get("oneweb_pointing_score", $"{(double)score:0}"));
        // Besides the one in use, which the list includes.
        var next = (t["candidates"] as JsonArray)?.Select(c => (long)c!).Where(c => c != ((long?)t["satellite"] ?? 0)).ToList() ?? [];
        if (next.Count > 0) lines.Add(Strings.Get("oneweb_candidates", string.Join(", ", next)));
        if (t["availability"] is { } availability) lines.Add(Strings.Get("oneweb_availability", $"{(double)availability:0.0}%"));
        if (t["pointing"] is { } p) lines.Add(Strings.Get("oneweb_pointing", $"Az {(double)p["az"]!:0.0}° El {(double)p["el"]!:0.0}°"));
        // Grouped by why: "a, b (no such page)".
        if (json["errors"] is JsonObject errors)
        {
            lines.Add(Strings.Get("oneweb_partly", string.Join("; ", errors.GroupBy(e => (string?)e.Value).Select(g => $"{string.Join(", ", g.Select(e => e.Key))} ({g.Key})"))));
        }
        return string.Join("\n", lines);
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
