using System.IO.Compression;
using System.Text.Json.Nodes;
using WhatsUp;
using Xunit;

namespace WhatsUp.Tests;

static class Samples
{
    public static string Path(string name) => System.IO.Path.Combine(AppContext.BaseDirectory, "resources", name);

    public static JsonObject Json(string name) => JsonNode.Parse(File.ReadAllText(Path(name)))!.AsObject();
}

public class CoordinatesTest
{
    /** Distance in metres between two nearby positions. */
    static double Metres(LatLon a, LatLon b)
    {
        var dLat = (a.Lat - b.Lat) * 111_320;
        var dLon = (a.Lon - b.Lon) * 111_320 * Math.Cos(a.Lat * Math.PI / 180);
        return Math.Sqrt(dLat * dLat + dLon * dLon);
    }

    [Fact]
    public void UtmAtTheOrigin()
    {
        // The equator at the Greenwich meridian: zone 31, 166,021.44 m east, on the equator.
        var utm = Coordinates.ToUtm(new LatLon(0, 0));
        Assert.Equal(31, utm.Zone);
        Assert.Equal(166_021.44, utm.Easting, 0.05);
        Assert.Equal(0.0, utm.Northing, 0.05);
    }

    [Fact]
    public void MgrsAtTheOrigin() => Assert.Equal("31N AA 66021 00000", Coordinates.ToMgrs(new LatLon(0, 0)));

    [Theory]
    // Expected values from PROJ (pyproj 3.7, +proj=utm +datum=WGS84).
    [InlineData(38.8977, -77.0365, 18, 323_394.30, 4_307_395.63)] // the White House
    [InlineData(53.5461, -113.4938, 12, 334_774.79, 5_935_915.39)] // Edmonton
    [InlineData(-33.8568, 151.2153, 56, 334_900.57, 6_252_288.75)] // Sydney, south
    [InlineData(60.3913, 5.3221, 32, 297_353.93, 6_700_648.35)] // Bergen, zone 32
    public void UtmMatchesProj(double lat, double lon, int zone, double easting, double northing)
    {
        var utm = Coordinates.ToUtm(new LatLon(lat, lon));
        Assert.Equal(zone, utm.Zone);
        Assert.Equal(easting, utm.Easting, 0.02);
        Assert.Equal(northing, utm.Northing, 0.02);
    }

    [Fact]
    public void MgrsOfTheWhiteHouse()
    {
        var whiteHouse = new LatLon(38.8977, -77.0365);
        Assert.Equal("18S UJ 23394 07395", Coordinates.ToMgrs(whiteHouse));
        var back = Coordinates.ParseMgrs("18SUJ2339407395");
        Assert.NotNull(back);
        Assert.Equal(0.0, Metres(whiteHouse, back!.Value), 2.0);
    }

    [Theory]
    [InlineData(53.5461, -113.4938)] // Edmonton
    [InlineData(-33.8568, 151.2153)] // Sydney
    [InlineData(-54.8019, -68.3030)] // Ushuaia
    [InlineData(64.1466, -21.9426)] // Reykjavik
    [InlineData(60.3913, 5.3221)] // Bergen: zone 32 exception
    [InlineData(78.2232, 15.6267)] // Longyearbyen: Svalbard zones
    [InlineData(0.5, 179.9)]
    [InlineData(-0.5, -179.9)]
    public void MgrsRoundTripsAroundTheWorld(double lat, double lon)
    {
        var place = new LatLon(lat, lon);
        var mgrs = Coordinates.ToMgrs(place)!;
        var back = Coordinates.ParseMgrs(mgrs, centre: false)!.Value;
        Assert.Equal(0.0, Metres(place, back), 1.5);
    }

    [Fact]
    public void MgrsZones()
    {
        Assert.Equal(32, Coordinates.UtmZone(60.3913, 5.3221));
        Assert.Equal(33, Coordinates.UtmZone(78.2232, 15.6267));
        Assert.Equal(12, Coordinates.UtmZone(53.5461, -113.4938));
    }

    [Fact]
    public void MgrsAtLowerPrecisionGivesTheSquaresMiddle()
    {
        var full = Coordinates.ParseMgrs("12U VD 41533 41226")!.Value;
        var km = Coordinates.ParseMgrs("12U VD 41 41")!.Value;
        // 1 km square: its middle is within about 700 m of any point in it.
        Assert.Equal(0.0, Metres(full, km), 800.0);
        Assert.NotNull(Coordinates.ParseMgrs("12uvd"));
    }

    [Theory]
    [InlineData("12U VD 4153 341")]
    [InlineData("Edmonton")]
    [InlineData("61U VD")]
    [InlineData("12I VD")]
    public void MgrsRejectsNonsense(string text) => Assert.Null(Coordinates.ParseMgrs(text));

    [Theory]
    [InlineData("53.555, -113.5")]
    [InlineData("53.555 -113.5")]
    [InlineData("53.555N 113.5W")]
    [InlineData("N53.555 W113.5")]
    [InlineData("53°33'18\"N 113°30'W")]
    [InlineData("53 33 18 N 113 30 0 W")]
    [InlineData("53 33.3, -113 30")]
    [InlineData("113.5W 53.555N")]
    // A minus sign spaced off its number, and letters placed differently on each half.
    [InlineData("53.555 - 113.5")]
    [InlineData("53.555, - 113.5")]
    [InlineData("N53.555 113.5W")]
    [InlineData("53.555N W113.5")]
    [InlineData("N 53 33 18 W 113 30")]
    public void LatLonFormats(string input)
    {
        var parsed = Coordinates.ParseLatLon(input);
        Assert.NotNull(parsed);
        Assert.Equal(53.555, parsed!.Value.Lat, 1e-6);
        Assert.Equal(-113.5, parsed.Value.Lon, 1e-6);
    }

    [Fact]
    public void SouthAndEast() => Assert.Equal(-33.8568, Coordinates.ParseLatLon("33.8568S, 151.2153E")!.Value.Lat, 1e-9);

    [Theory]
    [InlineData("Edmonton, AB")]
    [InlineData("95, 10")]
    [InlineData("12U VD 4153 4122")]
    [InlineData("53.5")]
    // Two latitudes, or two longitudes, aren't a position.
    [InlineData("45N 60N")]
    [InlineData("45E, 60W")]
    [InlineData("53.5 N S 113.5")]
    public void LatLonRejectsNonsense(string text) => Assert.Null(Coordinates.ParseLatLon(text));
}

/** AircraftFeed.Parse against real answers from adsb.lol and adsb.fi around Heathrow (trimmed). */
public class AircraftFeedTest
{
    const double HeathrowLat = 51.47, HeathrowLon = -0.45;
    /** The computer's clock at the fetch: positions' times are this less their age, whatever the source's clock says. */
    const long FetchedAt = 1_800_000_000_000L;

    static Dictionary<string, JsonArray> Rows(JsonObject result) =>
        result["aircraft"]!.AsArray().Select(r => r!.AsArray()).ToDictionary(r => r[0]!.GetValue<string>());

    static double D(JsonArray row, int i) => row[i]!.GetValue<double>();

    [Fact]
    public void AdsbLol()
    {
        var result = AircraftFeed.Parse(Samples.Json("adsb-lol.json"), "adsb.lol", HeathrowLat, HeathrowLon, 25, FetchedAt);
        Assert.Equal(FetchedAt, result["at"]!.GetValue<long>());
        var rows = Rows(result);
        // The service vehicle (category C2) and the ground station (TWR) are left out.
        Assert.Equal(new[] { "4005bc", "40772d", "40772e", "440bbf", "400db2" }.Order(), rows.Keys.Order());
        var climbing = rows["40772d"];
        Assert.Equal("EZY83RJ", climbing[1]!.GetValue<string>());
        Assert.Equal("G-UZHX", climbing[2]!.GetValue<string>());
        Assert.Equal("A20N", climbing[3]!.GetValue<string>());
        Assert.Equal(14000.0, D(climbing, 7));
        Assert.False(climbing[8]!.GetValue<bool>());
        Assert.Equal(258.1, D(climbing, 9), 1e-9);
        Assert.Equal(358.22, D(climbing, 10), 1e-9);
        Assert.Equal(0.0, D(climbing, 11));
        // The position is seen_pos (0.326 s) older than the fetch.
        Assert.Equal(FetchedAt - 326, climbing[13]!.GetValue<long>());
        var parked = rows["4005bc"];
        Assert.True(parked[8]!.GetValue<bool>());
        Assert.Equal(0.0, D(parked, 7));
        // No track on the ground, so its true heading instead.
        Assert.Equal(0.0, D(parked, 10));
        // No description from adsb.lol: null, not missing.
        Assert.Null(parked[4]);
        Assert.Equal(14, parked.Count);
    }

    [Fact]
    public void AdsbFi()
    {
        var rows = Rows(AircraftFeed.Parse(Samples.Json("adsb-fi.json"), "adsb.fi", HeathrowLat, HeathrowLon, 25, FetchedAt));
        // GND and TWR are left out.
        Assert.Equal(new[] { "4076cc", "40772d", "40772e", "440bbf", "400db2" }.Order(), rows.Keys.Order());
        Assert.Equal(36500.0, D(rows["440bbf"], 7));
        Assert.Equal(2304.0, D(rows["440bbf"], 11));
    }

    [Fact]
    public void CutToTheRadius()
    {
        // Within 10 NM of Heathrow: the parked 777 and the 757 about 8 NM east; not the others, 18-25 NM out.
        var rows = Rows(AircraftFeed.Parse(Samples.Json("adsb-lol.json"), "adsb.lol", HeathrowLat, HeathrowLon, 10, FetchedAt));
        Assert.Equal(new[] { "4005bc", "440bbf" }.Order(), rows.Keys.Order());
    }

    [Fact]
    public void OlderDump1090()
    {
        // dump1090-mutability: altitude, speed and vert_rate; its "now" (here a clock 10 minutes slow) is ignored.
        var answer = JsonNode.Parse("""
            {"now": 1799999400.0, "aircraft": [
                {"hex": "c0ffee", "flight": "WJA123  ", "lat": 51.5, "lon": -0.4, "altitude": 35000, "speed": 450,
                 "track": 270, "vert_rate": -640, "seen_pos": 2.5, "squawk": "7700"},
                {"hex": "c0ffef", "lat": 51.48, "lon": -0.45, "altitude": "ground", "speed": 3}
            ]}
            """)!.AsObject();
        var rows = Rows(AircraftFeed.Parse(answer, "receiver", HeathrowLat, HeathrowLon, 25, FetchedAt));
        var flying = rows["c0ffee"];
        Assert.Equal(35000.0, D(flying, 7));
        Assert.Equal(450.0, D(flying, 9));
        Assert.Equal(-640.0, D(flying, 11));
        Assert.Equal("7700", flying[12]!.GetValue<string>());
        Assert.Equal(FetchedAt - 2500, flying[13]!.GetValue<long>());
        Assert.True(rows["c0ffef"][8]!.GetValue<bool>());
    }

    [Fact]
    public void NoAircraftListIsAnError() =>
        // e.g. tar1090's receiver.json given by mistake, or an error message: try the next source.
        Assert.Throws<ArgumentException>(() => AircraftFeed.Parse(
            JsonNode.Parse("""{"version": "readsb", "refresh": 1000}""")!.AsObject(), "receiver", HeathrowLat, HeathrowLon, 25, FetchedAt));

    [Theory]
    [InlineData("192.168.1.20", true)]
    [InlineData("10.0.0.5", true)]
    [InlineData("172.20.1.1", true)]
    [InlineData("127.0.0.1", true)]
    [InlineData("169.254.3.4", true)]
    [InlineData("raspberrypi", true)]
    [InlineData("pi.local", true)]
    [InlineData("adsb.lan", true)]
    [InlineData("feeder.home.arpa", true)]
    [InlineData("localhost", true)]
    [InlineData("8.8.8.8", false)]
    [InlineData("172.32.0.1", false)]
    [InlineData("192.169.1.1", false)]
    [InlineData("example.com", false)]
    [InlineData("adsb.lol", false)]
    [InlineData("1.2.3", false)]
    public void LocalHosts(string host, bool local) => Assert.Equal(local, Http.IsLocalHost(host));

    [Fact]
    public void Distance()
    {
        // One degree of latitude is 60 NM.
        Assert.Equal(60.0, AircraftFeed.DistanceNm(50, 0, 51, 0), 0.1);
        Assert.Equal(0.0, AircraftFeed.DistanceNm(51.47, -0.45, 51.47, -0.45), 1e-9);
    }
}

/** FlightInfo.LegPoints against a real adsb.lol trace (EZY81XM, five legs that day; thinned). */
public class FlightInfoTest
{
    static double D(JsonNode point, int i) => double.Parse(point.AsArray()[i]!.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture);

    [Fact]
    public void OnlyTheLegUnderWay()
    {
        var full = Samples.Json("trace-full.json");
        var points = FlightInfo.LegPoints([full]);
        var start = (long)(full["timestamp"]!.GetValue<double>() * 1000);
        // The last leg starts at Rome Fiumicino, climbing through 450 ft, and ends near London.
        var first = points[0];
        Assert.Equal(start + 53_493_930.0, D(first, 0), 1.0);
        Assert.Equal(41.799766, D(first, 1), 1e-6);
        Assert.Equal(12.233212, D(first, 2), 1e-6);
        Assert.Equal(450, D(first, 3));
        Assert.Equal(51.552786, D(points[^1], 1), 1e-6);
        Assert.Equal(21425, D(points[^1], 3));
        Assert.True(points.Zip(points.Skip(1)).All(p => D(p.First, 0) < D(p.Second, 0)));
    }

    [Fact]
    public void RecentCarriesOnFromFull()
    {
        var full = Samples.Json("trace-full.json");
        var start = full["timestamp"]!.GetValue<double>();
        // A recent trace overlapping the full one's end and going 30 s past it, on the ground at the end.
        var recent = JsonNode.Parse($$"""
            {"timestamp": {{(start + 61_500).ToString(System.Globalization.CultureInfo.InvariantCulture)}}, "trace": [
                [40.0, 51.55, -0.49, 21500, 300, 318, 0, -1500, null],
                [80.0, 51.60, -0.55, 21000, 300, 318, 0, -1500, null],
                [90.0, 51.61, -0.56, "ground", 0, 318, 0, 0, null]
            ]}
            """)!.AsObject();
        var points = FlightInfo.LegPoints([full, recent]);
        var fullOnly = FlightInfo.LegPoints([Samples.Json("trace-full.json")]);
        // The first recent point is before the full trace's last one (61,551.72 s), so it is skipped.
        Assert.Equal(fullOnly.Count + 2, points.Count);
        Assert.Equal(-1, D(points[^1], 3));
    }

    [Fact]
    public void ANewLegStartsAfresh()
    {
        var trace = JsonNode.Parse("""
            {"timestamp": 1000, "trace": [
                [0, 50.0, 0.0, 30000, 450, 90, 0, 0, null],
                [60, 50.1, 0.1, "ground", 0, 90, 0, 0, null],
                [600, 50.1, 0.1, 200, 140, 90, 2, 1500, null],
                [660, 50.2, 0.2, 2000, 200, 90, 0, 1500, null]
            ]}
            """)!.AsObject();
        var points = FlightInfo.LegPoints([trace]);
        Assert.Equal(2, points.Count);
        Assert.Equal(1_600_000.0, D(points[0], 0));
    }
}

/** Skyline.Compute against made-up terrain whose skyline is known, and sampling real tiles. */
public class SkylineTest
{
    static double MetresBetween(double lat1, double lon1, double lat2, double lon2)
    {
        var r = Math.PI / 180;
        var a = Math.Pow(Math.Sin((lat2 - lat1) * r / 2), 2) + Math.Cos(lat1 * r) * Math.Cos(lat2 * r) * Math.Pow(Math.Sin((lon2 - lon1) * r / 2), 2);
        return 2 * 6_371_000.0 * Math.Asin(Math.Sqrt(a));
    }

    [Fact]
    public void FlatGroundDipsJustBelowTheHorizontal()
    {
        var profile = Skyline.Compute(53.5, -113.5, (_, _, _) => 0.0)!;
        // An eye 1.7 m up sees the ground meet the sky sqrt(2h(1 - k)/R) below the horizontal.
        var dip = -Math.Sqrt(2 * Skyline.EyeHeightM * 0.87 / 6_371_000.0) * 180 / Math.PI;
        var angles = profile["angles"]!.AsArray();
        Assert.Equal((int)(360 / Skyline.StepDegrees), angles.Count);
        foreach (var angle in angles) Assert.Equal(dip, angle!.GetValue<double>(), 0.01);
    }

    [Fact]
    public void AHillToTheNorth()
    {
        // A 3,000 m hill 20 km across at its foot, 50 km due north; flat everywhere else.
        var peakLat = 53.5 + 50_000 / 111_195.0;
        var profile = Skyline.Compute(53.5, -113.5, (lat, lon, _) =>
            Math.Max(0.0, 3000 * (1 - MetresBetween(lat, lon, peakLat, -113.5) / 20_000)))!;
        var drop = 50_000.0 * 50_000.0 * 0.87 / (2 * 6_371_000.0);
        var expected = Math.Atan((3000 - Skyline.EyeHeightM - drop) / 50_000) * 180 / Math.PI;
        Assert.Equal(expected, profile["angles"]![0]!.GetValue<double>(), 0.1);
        Assert.Equal(50.0, profile["distancesKm"]![0]!.GetValue<double>(), 1.0);
        // Due south, nothing but the flat.
        var south = (int)(180 / Skyline.StepDegrees);
        Assert.Equal(0.0, profile["angles"]![south]!.GetValue<double>(), 0.05);
    }

    /**
     * Real terrarium tiles (zoom 12) in the test resources, as the ARGB pixels Android's
     * Bitmap.getPixels gives (big-endian ints, gzipped).
     */
    static short[]? RealTile(int z, int x, int y)
    {
        var path = Samples.Path($"terrarium-{z}-{x}-{y}.argb.gz");
        if (!File.Exists(path)) return null;
        using var input = new GZipStream(File.OpenRead(path), CompressionMode.Decompress);
        var bytes = new MemoryStream();
        input.CopyTo(bytes);
        var data = bytes.ToArray();
        var pixels = new int[256 * 256];
        for (var i = 0; i < pixels.Length; i++)
        {
            pixels[i] = (data[i * 4] << 24) | (data[i * 4 + 1] << 16) | (data[i * 4 + 2] << 8) | data[i * 4 + 3];
        }
        return Skyline.Terrarium(pixels);
    }

    [Fact]
    public void RealTerrain()
    {
        // Banff's town centre is 1,383 m up; Everest's summit, 8,849 m, a little lower in data this coarse.
        Assert.Equal(1383.0, Skyline.Sample(51.1784, -115.5708, 12, RealTile)!.Value, 30.0);
        Assert.Equal(8780.0, Skyline.Sample(27.9881, 86.9250, 12, RealTile)!.Value, 120.0);
        // A tile that isn't there.
        Assert.Null(Skyline.Sample(0.0, 0.0, 12, RealTile));
    }

    [Fact]
    public void NoGroundHereNoSkyline() => Assert.Null(Skyline.Compute(0.0, 0.0, (_, _, _) => null));

    /** The tile as downloaded, decoded here, gives the same pixels as Android's Bitmap did (the .argb.gz). */
    [Fact]
    public void DecodesTilesAsAndroidDoes()
    {
        var pixels = Skyline.Decode(Samples.Path("terrarium-12-733-1368.png"))!;
        using var input = new GZipStream(File.OpenRead(Samples.Path("terrarium-12-733-1368.argb.gz")), CompressionMode.Decompress);
        var bytes = new MemoryStream();
        input.CopyTo(bytes);
        var data = bytes.ToArray();
        for (var i = 0; i < pixels.Length; i++)
        {
            Assert.Equal((data[i * 4] << 24) | (data[i * 4 + 1] << 16) | (data[i * 4 + 2] << 8) | data[i * 4 + 3], pixels[i]);
        }
    }
}

public class UpdatesTest
{
    const string ReleaseJson = """
        {"tag_name":"v0.3","name":"WhatsUp 0.3","assets":[
          {"name":"WhatsUp.exe","size":26257107,"digest":"sha256:87510A4A","browser_download_url":"https://example.com/WhatsUp.exe"},
          {"name":"WhatsUp-linux-x64.tar.gz","size":8530074,"browser_download_url":"https://example.com/WhatsUp-linux-x64.tar.gz"}
        ]}
        """;

    [Fact]
    public void ParsesTheAsset()
    {
        var release = Updates.Parse(ReleaseJson, "WhatsUp.exe")!;
        Assert.Equal("0.3", release.Version);
        Assert.Equal("https://example.com/WhatsUp.exe", release.Url);
        Assert.Equal(26257107, release.SizeBytes);
        Assert.Equal("87510a4a", release.Sha256);
        Assert.Null(Updates.Parse(ReleaseJson, "WhatsUp-linux-x64.tar.gz")!.Sha256);
        Assert.Null(Updates.Parse(ReleaseJson, "whatsup.apk"));
    }

    [Theory]
    [InlineData("0.3", "0.2", true)]
    [InlineData("v0.10", "0.9", true)]
    [InlineData("1.0", "0.9.5", true)]
    [InlineData("0.2.1", "0.2", true)]
    [InlineData("0.2", "0.2", false)]
    [InlineData("0.2", "0.2.0", false)]
    [InlineData("0.1", "0.2", false)]
    public void ComparesVersionsByNumber(string version, string than, bool newer) => Assert.Equal(newer, Updates.IsNewer(version, than));
}

/** StarlinkDish's reading of the dish's answers, built here by hand as protobuf, and a call to a fake dish. */
public class StarlinkDishTest
{
    sealed class Message
    {
        readonly List<byte> bytes = [];
        void Raw(ulong v)
        {
            while (v >= 0x80) { bytes.Add((byte)((v & 0x7F) | 0x80)); v >>= 7; }
            bytes.Add((byte)v);
        }
        public Message Varint(int field, long v) { Raw((ulong)field << 3); Raw((ulong)v); return this; }
        public Message Float(int field, float f) { Raw(((ulong)field << 3) | 5); bytes.AddRange(BitConverter.GetBytes(f)); return this; }
        public Message Bytes(int field, byte[] b) { Raw(((ulong)field << 3) | 2); Raw((ulong)b.Length); bytes.AddRange(b); return this; }
        public Message String(int field, string s) => Bytes(field, System.Text.Encoding.UTF8.GetBytes(s));
        public Message Sub(int field, Message m) => Bytes(field, m.Build());
        public Message PackedFloats(int field, float[] values) => Bytes(field, values.SelectMany(BitConverter.GetBytes).ToArray());
        public byte[] Build() => [.. bytes];
    }

    static Message Diagnostics() => new Message()
        .String(3, "2025.08.01.mr12345")
        .Sub(5, new Message().Varint(10, 1).Varint(6, 1))
        .Sub(9, new Message().Float(1, 181.5f).Float(2, 64.25f).Float(3, 175f).Float(4, 66f));

    static Message Map()
    {
        var snr = Enumerable.Repeat(1f, 16).ToArray();
        snr[5] = 0;
        snr[6] = -1;
        return new Message().Varint(1, 4).Varint(2, 4).PackedFloats(3, snr).Float(4, 25).Float(5, 80).Varint(6, 1);
    }

    [Fact]
    public void EncodesRequests()
    {
        Assert.Equal([0x82, 0xF7, 0x02, 0x00], Proto.EmptyMessageField(6000));
        Assert.Equal([0xC2, 0x7D, 0x00], Proto.EmptyMessageField(2008));
    }

    [Fact]
    public void ReadsDiagnosticsAndTheMap()
    {
        var dish = StarlinkDish.ParseDiagnostics(new Message().Varint(1, 42).Sub(6001, Diagnostics()).Build());
        Assert.Equal("2025.08.01.mr12345", (string?)dish["software"]);
        Assert.True((bool)dish["alerts"]!["obstructed"]!);
        Assert.True((bool)dish["alerts"]!["mastNotNearVertical"]!);
        Assert.Equal(181.5, (double)dish["alignment"]!["boresight"]!["az"]!, 6);
        Assert.Equal(3.24, StarlinkDish.Separation(dish["alignment"]!["boresight"]!, dish["alignment"]!["desired"]!), 1);
        Assert.Throws<IOException>(() => StarlinkDish.ParseDiagnostics(new Message().Sub(6000, new Message().String(1, "router")).Build()));

        var map = StarlinkDish.ParseObstructionMap(new Message().Sub(2008, Map()).Build());
        Assert.Equal(80.0, (double)map["edgeThetaDeg"]!, 6);
        Assert.Equal("earth", (string?)map["frame"]);
        var (seen, obstructed) = StarlinkDish.MapStats(map);
        Assert.Equal(11.0 / 12, seen, 9);
        Assert.Equal(1.0 / 11, obstructed, 9);
        // An older map gives its edge as an elevation.
        var old = StarlinkDish.ParseObstructionMap(new Message().Sub(2008, new Message().Varint(1, 1).Varint(2, 1).Float(3, 1).Float(4, 20)).Build());
        Assert.Equal(70.0, (double)old["edgeThetaDeg"]!, 6);
    }

    [Fact]
    public void AddressesStayLocal()
    {
        Assert.Equal("http://192.168.100.1:9201", StarlinkDish.BaseUrl(""));
        Assert.Equal("http://192.168.1.50:9201", StarlinkDish.BaseUrl(" 192.168.1.50 "));
        Assert.Equal("http://dishy.lan:9300", StarlinkDish.BaseUrl("http://dishy.lan:9300/"));
        Assert.Throws<IOException>(() => StarlinkDish.BaseUrl("example.com"));
        var off = JsonNode.Parse(new StarlinkDish().Load("example.com"))!;
        Assert.Contains("Not on this network", (string)off["error"]!);
    }

    /** A fake dish on this machine answering gRPC-web as the real one does: a data frame, then trailers. */
    [Fact]
    public void TalksToADish()
    {
        var port = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Select(e => e.Port).DefaultIfEmpty(0).Max() % 20000 + 30000;
        using var listener = new System.Net.HttpListener();
        listener.Prefixes.Add($"http://localhost:{port}/");
        listener.Start();
        var requests = new List<string>();
        var server = Task.Run(async () =>
        {
            for (var i = 0; i < 2; i++)
            {
                var context = await listener.GetContextAsync();
                var body = new MemoryStream();
                await context.Request.InputStream.CopyToAsync(body);
                var request = body.ToArray();
                requests.Add($"{context.Request.HttpMethod} {context.Request.Url!.AbsolutePath} {context.Request.ContentType} {Convert.ToHexString(request)}");
                // The request after its 5-byte frame header: which field it asks for.
                var answer = request[5] == 0x82 ? new Message().Sub(6001, Diagnostics()) : new Message().Sub(2008, Map());
                var data = answer.Build();
                var trailers = System.Text.Encoding.ASCII.GetBytes("grpc-status:0\r\ngrpc-message:\r\n");
                var reply = new MemoryStream();
                foreach (var (flag, part) in new[] { ((byte)0, data), ((byte)0x80, trailers) })
                {
                    reply.WriteByte(flag);
                    reply.Write([(byte)(part.Length >> 24), (byte)(part.Length >> 16), (byte)(part.Length >> 8), (byte)part.Length]);
                    reply.Write(part);
                }
                context.Response.ContentType = "application/grpc-web+proto";
                await context.Response.OutputStream.WriteAsync(reply.ToArray());
                context.Response.Close();
            }
        });
        var json = JsonNode.Parse(new StarlinkDish().Load($"localhost:{port}"))!;
        server.Wait(5000);
        Assert.Null(json["error"]);
        Assert.Equal(64.25, (double)json["dish"]!["alignment"]!["boresight"]!["el"]!, 6);
        Assert.Equal(4, (int)json["map"]!["rows"]!);
        Assert.Equal("POST /SpaceX.API.Device.Device/Handle application/grpc-web+proto 000000000482F70200", requests[0]);
        Assert.Equal("POST /SpaceX.API.Device.Device/Handle application/grpc-web+proto 0000000003C27D00", requests[1]);
    }

    [Fact]
    public void SaysWhyNot()
    {
        // Nothing listening on this port: refused at once.
        var json = JsonNode.Parse(new StarlinkDish().Load("127.0.0.1:1"))!;
        Assert.Equal("can't connect", (string?)json["error"]);
    }
}

/** OneWebTerminal's reading of a Hughes terminal's answers, in the shapes the known exporter reads, and a fake terminal. */
public class OneWebTerminalTest
{
    static readonly Dictionary<string, string> Answers = new()
    {
        ["antenna/antennatuneinfo"] = """{"calibration_info": {"pointing_score": 87}, "pointing_info": {"current_sinr": "9.25", "satellite": 123, "track_id": "4"}}""",
        ["modem/satellites_in_view"] = """{"candidate_satellites": "[123, 456, \"789\"]"}""",
        ["modem/lte_signal_info"] = """{"rsrp_dBW/m^2": -120.5, "rssi_dBm": -71, "sinr_dB": 9.3}""",
        ["antenna/trackingstatus"] = """{"tracking_status": "TRACKING", "beam": {"commanded_azimuth_deg": -10.5, "commanded_elevation_deg": "62.0"}}""",
        ["diagnostics/active_faults"] = """{"availability_percent": "99.7", "current_recovery_action_index": 0}""",
    };

    [Fact]
    public void SummarisesTheKnownFields()
    {
        var answers = new JsonObject(Answers.Select(a => KeyValuePair.Create(a.Key, JsonNode.Parse(a.Value))));
        var t = OneWebTerminal.Summarise(answers);
        Assert.Equal(123, (long)t["satellite"]!);
        Assert.Equal(4, (long)t["trackId"]!);
        Assert.Equal(9.25, (double)t["sinr"]!, 9);
        Assert.Equal(87, (double)t["pointingScore"]!, 9);
        Assert.Equal([123L, 456L, 789L], t["candidates"]!.AsArray().Select(c => (long)c!));
        Assert.Equal(-71, (double)t["signal"]!["rssiDbm"]!, 9);
        Assert.Equal(99.7, (double)t["availability"]!, 9);
        Assert.Equal(349.5, (double)t["pointing"]!["az"]!, 9);
        Assert.Equal("antenna/trackingstatus.beam", (string?)t["pointing"]!["from"]);
        Assert.Null(OneWebTerminal.FindPointing(JsonNode.Parse("""{"label": 5, "maze": 7}""")!.AsObject(), "x"));
        Assert.False(OneWebTerminal.Summarise(JsonNode.Parse("""{"antenna/antennatuneinfo": {"pointing_info": {"satellite": ""}}}""")!.AsObject()).ContainsKey("satellite"));
    }

    [Fact]
    public void AddressesStayLocal()
    {
        Assert.Equal("http://192.168.100.1", OneWebTerminal.BaseUrl(""));
        Assert.Equal("http://192.168.1.9:8080", OneWebTerminal.BaseUrl("192.168.1.9:8080/"));
        Assert.Throws<IOException>(() => OneWebTerminal.BaseUrl("oneweb.net"));
    }

    /** A fake terminal on this machine: the known endpoints answer, the rest are missing (404). */
    [Fact]
    public void TalksToATerminal()
    {
        var port = 30000 + Environment.ProcessId % 20000;
        using var listener = new System.Net.HttpListener();
        listener.Prefixes.Add($"http://localhost:{port}/");
        listener.Start();
        var asked = new List<string>();
        var serving = true;
        var server = Task.Run(async () =>
        {
            while (serving)
            {
                System.Net.HttpListenerContext context;
                try { context = await listener.GetContextAsync(); } catch { return; }
                var path = context.Request.Url!.AbsolutePath;
                lock (asked) asked.Add(path);
                if (Answers.TryGetValue(path.Replace("/api/", ""), out var body))
                {
                    context.Response.ContentType = "application/json";
                    await context.Response.OutputStream.WriteAsync(System.Text.Encoding.UTF8.GetBytes(body));
                }
                else context.Response.StatusCode = 404;
                context.Response.Close();
            }
        });
        var terminal = new OneWebTerminal();
        var json = terminal.LoadJson($"localhost:{port}", raw: true);
        Assert.Null(json["error"]);
        Assert.Equal(123, (long)json["terminal"]!["satellite"]!);
        Assert.Equal("no such page", (string?)json["errors"]!["system/status"]);
        Assert.NotNull(json["raw"]!["antenna/trackingstatus"]);
        Assert.Contains("/api/antenna/antennatuneinfo", asked);
        // Asked again at once: from what it kept, without asking the terminal.
        var before = asked.Count;
        terminal.LoadJson($"localhost:{port}");
        Assert.Equal(before, asked.Count);
        serving = false;
        listener.Stop();
        // Nothing listening: the first endpoint fails and says why.
        Assert.Equal("can't connect", (string?)new OneWebTerminal().LoadJson("127.0.0.1:1")["error"]);
    }
}
