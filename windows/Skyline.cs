using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace WhatsUp;

/**
 * The skyline around a place, for sky view and the in-view list (skyline.js): for each azimuth, how
 * far above the horizontal the hills and mountains reach, and how far away that ridge is.
 *
 * From Terrain Tiles (Mapzen's terrarium encoding, on AWS Open Data): elevation as colour in map
 * tiles, finer near the user and coarser further out, where a pixel is a smaller angle anyway. The
 * tiles are kept on disk, so a place seen once works offline; a skyline needs about 1–2 MB of them.
 * Blocking: call off the UI thread.
 */
sealed class Skyline
{
    const string Tag = "Skyline";
    const string Tiles = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
    const int TileSize = 256;
    const int ParallelFetches = 6;
    const int MaxTilesInMemory = 80;

    /** Which zoom of tiles out to how far: about 30, 120 and 500 m a pixel at mid latitudes. */
    sealed record Band(int Zoom, double MaxKm);
    static readonly Band[] Bands = [new(12, 8.0), new(10, 40.0), new(8, MaxKm)];

    public const double MaxKm = 150.0;
    /** Azimuth step of the profile, degrees. */
    public const double StepDegrees = 0.5;
    /** The eye, above the ground. */
    public const double EyeHeightM = 1.7;
    const double EarthRadiusM = 6_371_000.0;
    /** How much light bends round the Earth, as a share of its curvature (the usual 0.13). */
    const double Refraction = 0.13;
    const double FirstStepM = 20.0;
    /** Steps grow with the distance, as a share of it: the angle a step spans stays about the same. */
    const double StepShare = 0.012;

    readonly string dir = Path.Combine(App.CacheDir, "terrain");
    readonly object gate = new();
    /** Decoded tiles, elevations in metres, by zoom, x and y packed in a long; the most recently used kept. */
    readonly Dictionary<long, LinkedListNode<(long Key, short[] Heights)>> tiles = [];
    readonly LinkedList<(long Key, short[] Heights)> recent = new();
    /** Tiles that couldn't be had this time, not asked for again until the next skyline. */
    readonly HashSet<long> missing = [];
    (string Key, byte[] Json)? last;

    /**
     * { lat, lon, groundM, step (degrees of azimuth), angles: [degrees above the horizontal, per step
     * from north], distancesKm: [to that ridge] }, or { error } if the terrain round here can't be had.
     */
    public byte[] Load(double lat, double lon)
    {
        lock (gate)
        {
            var key = string.Format(CultureInfo.InvariantCulture, "{0:F4},{1:F4}", lat, lon);
            if (last is { } l && l.Key == key) return l.Json;
            try
            {
                missing.Clear();
                FetchAround(lat, lon);
                var json = Compute(lat, lon, Elevation) is { } profile ? Json.Bytes(profile) : AircraftFeed.Error("unavailable");
                last = (key, json);
                return json;
            }
            catch (Exception e)
            {
                App.Warn(Tag, $"No skyline at {key}", e);
                return AircraftFeed.Error(Http.Offline ? "offline" : "unavailable");
            }
        }
    }

    /** Gets the tiles a skyline here needs onto disk, several at once; those already there are kept. */
    void FetchAround(double lat, double lon)
    {
        var wanted = Bands.SelectMany(band =>
        {
            var degreesLat = band.MaxKm / 111.0;
            var degreesLon = band.MaxKm / (111.0 * Math.Max(Math.Cos(lat * Math.PI / 180), 0.05));
            var (x0, y1) = TileOf(lat - degreesLat, lon - degreesLon, band.Zoom);
            var (x1, y0) = TileOf(lat + degreesLat, lon + degreesLon, band.Zoom);
            var n = 1 << band.Zoom;
            return Enumerable.Range(y0, y1 - y0 + 1).Where(y => y >= 0 && y < n)
                .SelectMany(y => Enumerable.Range(x0, x1 - x0 + 1).Select(x => (z: band.Zoom, x: Mod(x, n), y)));
        }).Where(t => !File.Exists(FileOf(t.z, t.x, t.y))).ToList();
        if (wanted.Count == 0 || Http.Offline) return;
        Parallel.ForEach(wanted, new ParallelOptions { MaxDegreeOfParallelism = ParallelFetches }, t =>
        {
            try
            {
                var bytes = Http.GetBytes($"{Tiles}/{t.z}/{t.x}/{t.y}.png", readTimeoutMs: 20_000);
                var file = FileOf(t.z, t.x, t.y);
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                // Written whole, then renamed, so a half-written tile is never read.
                var part = file + ".part";
                File.WriteAllBytes(part, bytes);
                File.Move(part, file, overwrite: true);
            }
            catch (Exception e)
            {
                App.Warn(Tag, $"No terrain tile {t.z}/{t.x}/{t.y}", e);
            }
        });
    }

    /** Ground elevation in metres (the sea's surface at sea) at a place, from tiles fine enough for distanceM off. */
    double? Elevation(double lat, double lon, double distanceM) =>
        Sample(lat, lon, Bands.First(b => distanceM <= b.MaxKm * 1000 || b == Bands[^1]).Zoom, Tile);

    short[]? Tile(int z, int x, int y)
    {
        // A number, not a string: this is asked hundreds of thousands of times a skyline.
        var key = ((long)z << 48) | ((long)x << 24) | (long)y;
        if (tiles.TryGetValue(key, out var node))
        {
            recent.Remove(node);
            recent.AddFirst(node);
            return node.Value.Heights;
        }
        if (missing.Contains(key)) return null;
        var pixels = Decode(FileOf(z, x, y));
        if (pixels == null)
        {
            missing.Add(key);
            return null;
        }
        var heights = Terrarium(pixels);
        tiles[key] = recent.AddFirst((key, heights));
        if (recent.Count > MaxTilesInMemory)
        {
            tiles.Remove(recent.Last!.Value.Key);
            recent.RemoveLast();
        }
        return heights;
    }

    /** A tile's ARGB pixels, as Android's Bitmap.getPixels gives them; null if it isn't there or isn't a tile. */
    static int[]? Decode(string file)
    {
        if (!File.Exists(file)) return null;
        try
        {
            using var bitmap = new Bitmap(file);
            if (bitmap.Width != TileSize || bitmap.Height != TileSize) return null;
            var data = bitmap.LockBits(new Rectangle(0, 0, TileSize, TileSize), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var pixels = new int[TileSize * TileSize];
                for (var row = 0; row < TileSize; row++)
                {
                    Marshal.Copy(data.Scan0 + row * data.Stride, pixels, row * TileSize, TileSize);
                }
                return pixels;
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
        }
        catch (Exception e)
        {
            App.Warn(Tag, $"Bad terrain tile {file}", e);
            return null;
        }
    }

    string FileOf(int z, int x, int y) => Path.Combine(dir, $"{z}", $"{x}", $"{y}.png");

    static int Mod(int a, int n) => ((a % n) + n) % n;

    /**
     * The skyline at (lat, lon), with elevation(lat, lon, distanceM) giving the ground's height
     * there in metres, or null where unknown: for each azimuth step, the highest angle any
     * ground out to MaxKm reaches above the horizontal (curvature and refraction allowed for).
     * Null if the ground here is unknown.
     */
    internal static JsonObject? Compute(double lat, double lon, Func<double, double, double, double?> elevation)
    {
        if (elevation(lat, lon, 0.0) is not { } ground) return null;
        var eye = ground + EyeHeightM;
        var phi = lat * Math.PI / 180;
        var lambda = lon * Math.PI / 180;
        var steps = (int)(360 / StepDegrees);
        var angles = new JsonArray();
        var distances = new JsonArray();
        for (var i = 0; i < steps; i++)
        {
            var bearing = i * StepDegrees * Math.PI / 180;
            double best = -90.0, bestM = 0.0, d = FirstStepM;
            while (d <= MaxKm * 1000)
            {
                var delta = d / EarthRadiusM;
                var lat2 = Math.Asin(Math.Sin(phi) * Math.Cos(delta) + Math.Cos(phi) * Math.Sin(delta) * Math.Cos(bearing));
                var lon2 = lambda + Math.Atan2(Math.Sin(bearing) * Math.Sin(delta) * Math.Cos(phi), Math.Cos(delta) - Math.Sin(phi) * Math.Sin(lat2));
                if (elevation(lat2 * 180 / Math.PI, lon2 * 180 / Math.PI, d) is { } h)
                {
                    // The ground's drop below the eye's horizontal with distance, less refraction.
                    var drop = d * d * (1 - Refraction) / (2 * EarthRadiusM);
                    var angle = Math.Atan((h - eye - drop) / d) * 180 / Math.PI;
                    if (angle > best)
                    {
                        best = angle;
                        bestM = d;
                    }
                }
                d += Math.Max(FirstStepM, d * StepShare);
            }
            angles.Add(Math.Floor(best * 100 + 0.5) / 100.0);
            distances.Add(Math.Floor(bestM / 100 + 0.5) / 10.0);
        }
        return new JsonObject
        {
            ["lat"] = lat,
            ["lon"] = lon,
            ["groundM"] = (long)Math.Floor(ground + 0.5),
            ["step"] = StepDegrees,
            ["angles"] = angles,
            ["distancesKm"] = distances,
        };
    }

    /** Elevations in whole metres from a terrarium tile's ARGB pixels: (red * 256 + green + blue / 256) - 32768. */
    internal static short[] Terrarium(int[] pixels)
    {
        var heights = new short[pixels.Length];
        for (var i = 0; i < pixels.Length; i++)
        {
            var p = pixels[i];
            heights[i] = (short)Math.Clamp(((p >> 16) & 0xff) * 256 + ((p >> 8) & 0xff) - 32768, short.MinValue, short.MaxValue);
        }
        return heights;
    }

    /**
     * The ground's height at a place from zoom's tiles (tile(z, x, y), null if it can't be
     * had), bilinear between the pixels round it; the sea's surface, not its floor, at sea.
     */
    internal static double? Sample(double lat, double lon, int zoom, Func<int, int, int, short[]?> tile)
    {
        var (px, py) = PixelOf(lat, lon, zoom);
        // Pixel centres are at half pixels.
        var fx = px - 0.5;
        var fy = py - 0.5;
        var x0 = (int)Math.Floor(fx);
        var y0 = (int)Math.Floor(fy);
        var tx = (int)Math.Floor(x0 / (double)TileSize);
        var ty = (int)Math.Floor(y0 / (double)TileSize);
        if (tile(zoom, Mod(tx, 1 << zoom), ty) is not { } heights) return null;
        // Within the tile: at its edges, the edge pixel stands in for the next tile's.
        double At(int x, int y) =>
            heights[Math.Clamp(y - ty * TileSize, 0, TileSize - 1) * TileSize + Math.Clamp(x - tx * TileSize, 0, TileSize - 1)];
        var ax = fx - x0;
        var ay = fy - y0;
        var top = At(x0, y0) * (1 - ax) + At(x0 + 1, y0) * ax;
        var bottom = At(x0, y0 + 1) * (1 - ax) + At(x0 + 1, y0 + 1) * ax;
        return Math.Max(0.0, top * (1 - ay) + bottom * ay);
    }

    /** Web Mercator pixel (fractional, whole-world) of a place at zoom. */
    static (double X, double Y) PixelOf(double lat, double lon, int zoom)
    {
        var size = TileSize * Math.Pow(2, zoom);
        var phi = Math.Clamp(lat, -85.05, 85.05) * Math.PI / 180;
        return ((lon + 180) / 360 * size, (1 - Math.Log(Math.Tan(phi) + 1 / Math.Cos(phi)) / Math.PI) / 2 * size);
    }

    internal static (int X, int Y) TileOf(double lat, double lon, int zoom)
    {
        var (px, py) = PixelOf(lat, lon, zoom);
        return ((int)Math.Floor(px / TileSize), (int)Math.Floor(py / TileSize));
    }
}
