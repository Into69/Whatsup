using System.Net.Sockets;
using System.Text.Json.Nodes;

namespace WhatsUp;

/**
 * The user's own Starlink dish, read over its local API (gRPC-web, plain HTTP on port 9201 of
 * 192.168.100.1, as Starlink's own app uses it on the dish's network): where it points and where it
 * wants to point, its alerts (obstructed, motors stuck, ...), and its obstruction map, the sky as it
 * has seen it. For sky view (/data/starlink.json, polled by starlink.js) and the settings check. As
 * the Android app's StarlinkDish.kt, which says more.
 */
sealed class StarlinkDish
{
    public const string DefaultAddress = "192.168.100.1";
    const int Port = 9201;
    const string Path = "/SpaceX.API.Device.Device/Handle";
    const int TimeoutMs = 4_000;
    const long StatusKeepMs = 4_000, MapKeepMs = 60_000;

    const int RequestGetDiagnostics = 6000, ResponseDishGetDiagnostics = 6001;
    const int RequestGetObstructionMap = 2008, ResponseGetObstructionMap = 2008;

    /** One byte per map cell: SNR 0 to 1 as 0 to 200; no data as 255. */
    const int SnrScale = 200, NoData = 255;
    /** A cell under this SNR (0 to 1) counts as obstructed. */
    const double ObstructedSnr = 0.5;

    readonly object gate = new();
    (long At, JsonObject Answer)? status, map;
    string address = "";

    /** The dish's diagnostics and obstruction map at `address`, as JSON for the page. */
    public byte[] Load(string address)
    {
        lock (gate)
        {
            if (address != this.address)
            {
                this.address = address;
                status = map = null;
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
                return Json.Bytes(output);
            }
            if (status is not { } kept || now - kept.At >= StatusKeepMs)
            {
                JsonObject answer;
                try { answer = new JsonObject { ["dish"] = Diagnostics(url) }; }
                catch (Exception e) when (e is IOException or HttpRequestException or SocketException) { answer = new JsonObject { ["error"] = Describe(e) }; }
                status = kept = (now, answer);
            }
            foreach (var (key, value) in kept.Answer) output[key] = value?.DeepClone();
            if (output.ContainsKey("dish"))
            {
                if (map is not { } keptMap || now - keptMap.At >= (keptMap.Answer.ContainsKey("map") ? MapKeepMs : StatusKeepMs))
                {
                    JsonObject answer;
                    try { answer = new JsonObject { ["map"] = ObstructionMap(url) }; }
                    catch (Exception e) when (e is IOException or HttpRequestException or SocketException) { answer = new JsonObject { ["mapError"] = Describe(e) }; }
                    map = keptMap = (now, answer);
                }
                foreach (var (key, value) in keptMap.Answer) output[key] = value?.DeepClone();
            }
            return Json.Bytes(output);
        }
    }

    /** The URL to post to, from what the user typed: a host, host:port or http://host:port; local only. */
    public static string BaseUrl(string address)
    {
        var typed = address.Trim();
        if (typed.Length == 0) typed = DefaultAddress;
        typed = typed.TrimEnd('/');
        var text = typed.Contains("://") ? typed : $"http://{typed}";
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) throw new IOException($"Not an address: {typed}");
        if (!Http.IsLocalHost(uri.Host)) throw new IOException($"Not on this network: {uri.Host}");
        // Uri gives the scheme's port when none was typed.
        var port = text.IndexOf(':', text.IndexOf("://", StringComparison.Ordinal) + 3) >= 0 ? uri.Port : Port;
        return $"{uri.Scheme}://{uri.Host}:{port}";
    }

    static string Describe(Exception e) => e switch
    {
        IOException { InnerException: OperationCanceledException } => "no answer",
        HttpRequestException { InnerException: SocketException } or SocketException => "can't connect",
        _ when e.Message == "no answer" => "no answer",
        _ => e.Message,
    };

    public static JsonObject Diagnostics(string url) => ParseDiagnostics(Call(url, RequestGetDiagnostics));

    /** A Response's dish_get_diagnostics, as JSON. */
    public static JsonObject ParseDiagnostics(byte[] response)
    {
        var body = Proto.Field(response, ResponseDishGetDiagnostics) ?? throw new IOException("Not a dish (no diagnostics in its answer)");
        var dish = new JsonObject();
        Proto.ForEach(body, (field, value) =>
        {
            switch (field)
            {
                case 1: dish["id"] = value.String(); break;
                case 2: dish["hardware"] = value.String(); break;
                case 3: dish["software"] = value.String(); break;
                case 5: dish["alerts"] = Alerts(value.Bytes()); break;
                case 6: dish["disablement"] = value.Number; break;
                case 9: dish["alignment"] = Alignment(value.Bytes()); break;
                case 10: dish["stowed"] = value.Number != 0; break;
            }
        });
        return dish;
    }

    static readonly Dictionary<int, string> AlertNames = new()
    {
        [1] = "heating", [2] = "thermalThrottle", [3] = "thermalShutdown", [4] = "powerSupplyThermalThrottle",
        [5] = "motorsStuck", [6] = "mastNotNearVertical", [7] = "slowEthernet", [8] = "softwareInstallPending",
        [9] = "movingTooFast", [10] = "obstructed",
    };

    static JsonObject Alerts(byte[] bytes)
    {
        var alerts = new JsonObject();
        Proto.ForEach(bytes, (field, value) =>
        {
            if (AlertNames.TryGetValue(field, out var name) && value.Number != 0) alerts[name] = true;
        });
        return alerts;
    }

    /** Where the dish's face points (boresight: azimuth from true north, elevation above the horizon) and where Starlink wants it to. */
    static JsonObject Alignment(byte[] bytes)
    {
        var values = new double[5];
        Array.Fill(values, double.NaN);
        Proto.ForEach(bytes, (field, value) => { if (field is >= 1 and <= 4) values[field] = value.Float(); });
        var alignment = new JsonObject();
        if (!double.IsNaN(values[1]) && !double.IsNaN(values[2])) alignment["boresight"] = new JsonObject { ["az"] = values[1], ["el"] = values[2] };
        if (!double.IsNaN(values[3]) && !double.IsNaN(values[4])) alignment["desired"] = new JsonObject { ["az"] = values[3], ["el"] = values[4] };
        return alignment;
    }

    public static JsonObject ObstructionMap(string url) => ParseObstructionMap(Call(url, RequestGetObstructionMap));

    /** A Response's dish_get_obstruction_map, as JSON: see StarlinkDish.kt. */
    public static JsonObject ParseObstructionMap(byte[] response)
    {
        var body = Proto.Field(response, ResponseGetObstructionMap) ?? throw new IOException("No obstruction map in the answer");
        long rows = 0, cols = 0, frame = 0;
        double minElevation = double.NaN, maxTheta = double.NaN;
        var snr = new List<float>();
        Proto.ForEach(body, (field, value) =>
        {
            switch (field)
            {
                case 1: rows = value.Number; break;
                case 2: cols = value.Number; break;
                case 3: if (value.Wire == Proto.Length) snr.AddRange(value.PackedFloats()); else snr.Add(value.Float()); break;
                case 4: minElevation = value.Float(); break;
                case 5: maxTheta = value.Float(); break;
                case 6: frame = value.Number; break;
            }
        });
        if (rows <= 0 || cols <= 0 || snr.Count != rows * cols) throw new IOException($"Unexpected obstruction map ({rows} × {cols}, {snr.Count} cells)");
        var edge = !double.IsNaN(maxTheta) && maxTheta > 0 ? maxTheta : !double.IsNaN(minElevation) ? 90 - minElevation : 90.0;
        var cells = snr.Select(s => (byte)(s < 0 || float.IsNaN(s) ? NoData : (int)Math.Round(Math.Min(s, 1f) * SnrScale))).ToArray();
        return new JsonObject
        {
            ["rows"] = (int)rows,
            ["cols"] = (int)cols,
            ["edgeThetaDeg"] = edge,
            ["frame"] = frame switch { 1 => "earth", 2 => "dish", _ => "unknown" },
            ["snr"] = Convert.ToBase64String(cells),
        };
    }

    /** Degrees between two { az, el } directions. */
    public static double Separation(JsonNode a, JsonNode b)
    {
        static double[] Unit(JsonNode d)
        {
            double az = (double)d["az"]! * Math.PI / 180, el = (double)d["el"]! * Math.PI / 180;
            return [Math.Sin(az) * Math.Cos(el), Math.Cos(az) * Math.Cos(el), Math.Sin(el)];
        }
        var u = Unit(a);
        var v = Unit(b);
        return Math.Acos(Math.Clamp(u[0] * v[0] + u[1] * v[1] + u[2] * v[2], -1, 1)) * 180 / Math.PI;
    }

    /** Of the map's cells inside its circle, the share the dish has seen, and of those, the share obstructed. */
    public static (double Seen, double Obstructed) MapStats(JsonNode map)
    {
        int rows = (int)map["rows"]!, cols = (int)map["cols"]!;
        var cells = Convert.FromBase64String((string)map["snr"]!);
        int inside = 0, seen = 0, obstructed = 0;
        for (var r = 0; r < rows; r++)
        {
            for (var c = 0; c < cols; c++)
            {
                double x = (c + 0.5) / cols * 2 - 1, y = (r + 0.5) / rows * 2 - 1;
                if (x * x + y * y > 1) continue;
                inside++;
                var value = cells[r * cols + c];
                if (value == NoData) continue;
                seen++;
                if (value < ObstructedSnr * SnrScale) obstructed++;
            }
        }
        return (inside > 0 ? (double)seen / inside : 0, seen > 0 ? (double)obstructed / seen : 0);
    }

    /** Posts a Request with just `requestField` (an empty message) and returns the Response's bytes. */
    static byte[] Call(string url, int requestField)
    {
        var message = Proto.EmptyMessageField(requestField);
        var frame = new byte[5 + message.Length];
        for (var i = 0; i < 4; i++) frame[1 + i] = (byte)(message.Length >> (8 * (3 - i)));
        message.CopyTo(frame, 5);
        var (headers, body) = Http.PostLocal(url + Path, frame, new Dictionary<string, string>
        {
            ["Content-Type"] = "application/grpc-web+proto",
            ["X-Grpc-Web"] = "1",
            ["Accept"] = "application/grpc-web+proto",
        }, TimeoutMs);
        if (headers.TryGetValue("grpc-status", out var code) && code != "0") throw new IOException(GrpcError(code, headers.GetValueOrDefault("grpc-message")));
        byte[]? data = null;
        var at = 0;
        while (at + 5 <= body.Length)
        {
            var flag = body[at];
            var length = (body[at + 1] << 24) | (body[at + 2] << 16) | (body[at + 3] << 8) | body[at + 4];
            if (length < 0 || at + 5 + length > body.Length) break;
            var content = body[(at + 5)..(at + 5 + length)];
            if ((flag & 0x80) != 0)
            {
                var trailers = System.Text.Encoding.UTF8.GetString(content).Split('\n')
                    .Select(line => line.Split(':', 2))
                    .Where(parts => parts.Length == 2)
                    .ToDictionary(parts => parts[0].Trim().ToLowerInvariant(), parts => parts[1].Trim());
                if (trailers.TryGetValue("grpc-status", out var status) && status != "0") throw new IOException(GrpcError(status, trailers.GetValueOrDefault("grpc-message")));
            }
            else data ??= content;
            at += 5 + length;
        }
        return data ?? throw new IOException("Empty answer");
    }

    static string GrpcError(string code, string? message)
    {
        var text = message != null ? Uri.UnescapeDataString(message) : "";
        return code switch
        {
            "7" => "the dish refused (permission denied)",
            "12" => "this dish doesn't support it",
            _ => $"the dish said error {code}",
        } + (text.Length > 0 ? $": {text}" : "");
    }
}

/** Just enough protobuf to read the dish's answers: fields by number, varints, floats, strings, messages. */
static class Proto
{
    public const int Varint = 0, Fixed64 = 1, Length = 2, Fixed32 = 5;

    public readonly record struct Value(int Wire, long Number, byte[]? Data)
    {
        public float Float() => Wire == Fixed32 ? BitConverter.Int32BitsToSingle((int)Number) : Number;
        public byte[] Bytes() => Data ?? [];
        public string String() => System.Text.Encoding.UTF8.GetString(Bytes());
        public IEnumerable<float> PackedFloats()
        {
            var b = Bytes();
            for (var i = 0; i + 4 <= b.Length; i += 4) yield return BitConverter.ToSingle(b, i);
        }
    }

    /** Calls `action` with each field's number and value, in order. */
    public static void ForEach(byte[] bytes, Action<int, Value> action)
    {
        var at = 0;
        long ReadVarint()
        {
            long result = 0;
            for (var shift = 0; ; shift += 7)
            {
                if (at >= bytes.Length) throw new IOException("Truncated answer");
                if (shift > 63) throw new IOException("Bad answer");
                var b = bytes[at++];
                result |= (long)(b & 0x7F) << shift;
                if (b < 0x80) return result;
            }
        }
        long ReadFixed(int n)
        {
            if (at + n > bytes.Length) throw new IOException("Truncated answer");
            long value = 0;
            for (var k = 0; k < n; k++) value |= (long)bytes[at + k] << (8 * k);
            at += n;
            return value;
        }
        while (at < bytes.Length)
        {
            var key = ReadVarint();
            var field = (int)((ulong)key >> 3);
            var wire = (int)(key & 7);
            Value value;
            switch (wire)
            {
                case Varint: value = new Value(wire, ReadVarint(), null); break;
                case Fixed64: value = new Value(wire, ReadFixed(8), null); break;
                case Fixed32: value = new Value(wire, ReadFixed(4), null); break;
                case Length:
                    var length = (int)ReadVarint();
                    if (length < 0 || at + length > bytes.Length) throw new IOException("Truncated answer");
                    value = new Value(wire, 0, bytes[at..(at + length)]);
                    at += length;
                    break;
                default: throw new IOException($"Bad answer (wire type {wire})");
            }
            action(field, value);
        }
    }

    /** The bytes of message field `number`, if present. */
    public static byte[]? Field(byte[] bytes, int number)
    {
        byte[]? found = null;
        ForEach(bytes, (field, value) => { if (field == number && value.Wire == Length) found = value.Bytes(); });
        return found;
    }

    /** A message holding only field `number`, itself an empty message. */
    public static byte[] EmptyMessageField(int number)
    {
        var key = ((ulong)number << 3) | Length;
        var output = new List<byte>();
        while (key >= 0x80)
        {
            output.Add((byte)((key & 0x7F) | 0x80));
            key >>= 7;
        }
        output.Add((byte)key);
        output.Add(0);
        return [.. output];
    }
}
