using System.Text.Json.Nodes;

namespace WhatsUp;

/** A raster tile source the globe can draw. Every one listed here needs no API key. */
sealed record TileSet(string Id, string Name, string Description, IReadOnlyList<string> Urls, string Attribution, int MaxZoom, int TileSize = 256)
{
    /** The shape globe.js's setTiles() takes. */
    public JsonObject ToJson() => new()
    {
        ["id"] = Id,
        ["tiles"] = new JsonArray(Urls.Select(u => (JsonNode)u).ToArray()),
        ["attribution"] = Attribution,
        ["maxzoom"] = MaxZoom,
        ["tileSize"] = TileSize,
    };
}

static class TileSets
{
    public static readonly IReadOnlyList<TileSet> All =
    [
        new("esri-imagery", "Satellite", "Esri World Imagery",
            ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            "Imagery &copy; Esri, Maxar, Earthstar Geographics", 19),
        new("osm", "OpenStreetMap", "Standard OSM street map",
            ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors", 19),
        new("opentopomap", "Topographic", "OpenTopoMap contours and relief",
            ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
            "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)", 17),
        new("esri-street", "Esri Streets", "Esri World Street Map",
            ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"],
            "&copy; Esri", 19),
        // Google's own tile servers, by the user's choice. Google's terms only allow its maps through
        // its paid Maps APIs, so these may be blocked at any time, and shouldn't ship in a published app.
        Google("google-hybrid", "Google Hybrid", "Google satellite imagery with roads and labels", "y",
            // Satellite imagery from Google's providers, under Google's roads and labels.
            attribution: "Imagery &copy; Google and its imagery providers, Map data &copy; Google"),
        Google("google-roads", "Google Roads", "Google road map", "m"),
        // Terrain has real detail to zoom 19; from 20 Google sends blank tiles, so 19's are enlarged instead.
        Google("google-terrain", "Google Terrain", "Google terrain and relief", "p", maxZoom: 19),
    ];

    public static TileSet Default => All[0];

    /** A Google map layer (lyrs=): its four servers mt0 to mt3 share the load. */
    static TileSet Google(string id, string name, string description, string layer,
        string attribution = "Map data &copy; Google", int maxZoom = 20) =>
        new(id, name, description, Enumerable.Range(0, 4).Select(i => $"https://mt{i}.google.com/vt/lyrs={layer}&x={{x}}&y={{y}}&z={{z}}").ToList(),
            attribution, maxZoom);

    /** A saved choice that is no longer offered falls back to the default. */
    public static TileSet ById(string? id) => All.FirstOrDefault(t => t.Id == id) ?? Default;

    /**
     * One real map tile per tile set, for the map style cards in settings: zoom 2 over the North
     * Atlantic, eastern North America and western Europe. Kept on disk, so each is fetched once.
     */
    public static byte[]? Preview(string id)
    {
        var tileSet = All.FirstOrDefault(t => t.Id == id);
        if (tileSet == null) return null;
        var file = Path.Combine(App.CacheDir, "tile-previews", $"{tileSet.Id}.img");
        try
        {
            if (!File.Exists(file))
            {
                if (Http.Offline) return null;
                var url = tileSet.Urls[0].Replace("{z}", "2").Replace("{x}", "1").Replace("{y}", "1");
                var bytes = Http.GetBytes(url, readTimeoutMs: 10_000);
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                File.WriteAllBytes(file, bytes);
            }
            return File.ReadAllBytes(file);
        }
        catch (Exception e)
        {
            App.Warn("TilePreviews", $"No preview for {id}", e);
            return null;
        }
    }
}
