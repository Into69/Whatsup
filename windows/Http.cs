using System.Net;
using System.Reflection;

namespace WhatsUp;

/**
 * GET requests as the app makes them all: with its own User-Agent (OpenStreetMap's tile policy and
 * CelesTrak ask clients to identify themselves), timeouts, and anything but 200 OK as an error.
 * Blocking: call off the UI thread.
 */
static class Http
{
    public static readonly string Version =
        Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0";

    public static readonly string UserAgent = $"WhatsUp/{Version} (Windows)";

    const int ConnectTimeoutMs = 15_000;
    /** How often, in bytes read, progress is reported. */
    public const long ReportEveryBytes = 32 * 1024;

    /**
     * Offline mode, set from Settings: every request fails at once with OfflineException, so
     * nothing goes out and callers fall back on their saved copies.
     */
    static volatile bool offline;
    public static bool Offline { get => offline; set => offline = value; }

    public class OfflineException() : IOException("Offline mode is on");

    /** A response other than 200 OK, with its body, for callers that read the reason. */
    public class StatusException(int code, string body) : IOException($"HTTP {code}")
    {
        public int Code { get; } = code;
        public string Body { get; } = body;
    }

    static readonly HttpClient client = new(new SocketsHttpHandler
    {
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    })
    { Timeout = Timeout.InfiniteTimeSpan };

    /**
     * Streams `url`'s body into `output`, calling `onProgress(bytesRead, totalBytes)` as it arrives
     * (totalBytes is -1 when the server doesn't say), and returns the number of bytes read.
     */
    public static long Get(
        string url,
        Stream output,
        int readTimeoutMs = 30_000,
        int connectTimeoutMs = ConnectTimeoutMs,
        bool allowLocalHttp = false,
        Action<long, long>? onProgress = null)
    {
        if (Offline) throw new OfflineException();
        var address = new Uri(url);
        // Plain http only to the user's own ADS-B receiver on this network.
        if (address.Scheme != "https" && !(allowLocalHttp && address.Scheme == "http" && IsLocalHost(address.Host)))
        {
            throw new IOException($"Only HTTPS, or HTTP to this network, is allowed: {url}");
        }
        using var request = new HttpRequestMessage(HttpMethod.Get, address);
        request.Headers.UserAgent.ParseAdd(UserAgent);
        // Until the headers arrive, the connect and read timeouts together; then the read timeout between reads.
        using var timeout = new CancellationTokenSource(connectTimeoutMs + readTimeoutMs);
        HttpResponseMessage response;
        try
        {
            response = client.Send(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        }
        catch (OperationCanceledException e)
        {
            throw new IOException($"Timed out: {url}", e);
        }
        using (response)
        {
            if (response.StatusCode != HttpStatusCode.OK)
            {
                var body = "";
                try { body = new StreamReader(response.Content.ReadAsStream()).ReadToEnd(); } catch (Exception) { }
                throw new StatusException((int)response.StatusCode, body);
            }
            var total = response.Content.Headers.ContentLength ?? -1;
            onProgress?.Invoke(0, total);
            long read = 0, reported = 0;
            using var input = response.Content.ReadAsStream(timeout.Token);
            var buffer = new byte[64 * 1024];
            while (true)
            {
                timeout.CancelAfter(readTimeoutMs);
                int n;
                try
                {
                    n = input.ReadAsync(buffer, timeout.Token).AsTask().GetAwaiter().GetResult();
                }
                catch (OperationCanceledException e)
                {
                    throw new IOException($"Timed out: {url}", e);
                }
                if (n <= 0) break;
                output.Write(buffer, 0, n);
                read += n;
                if (onProgress != null && read - reported >= ReportEveryBytes)
                {
                    reported = read;
                    onProgress(read, total);
                }
            }
            onProgress?.Invoke(read, total);
            return read;
        }
    }

    /** `url`'s whole body. */
    public static byte[] GetBytes(
        string url,
        int readTimeoutMs = 30_000,
        int connectTimeoutMs = ConnectTimeoutMs,
        bool allowLocalHttp = false)
    {
        var output = new MemoryStream();
        Get(url, output, readTimeoutMs, connectTimeoutMs, allowLocalHttp);
        return output.ToArray();
    }

    public static string GetText(string url, int readTimeoutMs = 30_000) =>
        System.Text.Encoding.UTF8.GetString(GetBytes(url, readTimeoutMs));

    /**
     * Whether `host` is on the local network: a private, link-local or loopback IPv4 address, a
     * one-word name ("raspberrypi") or a .local, .lan or .home.arpa name.
     */
    public static bool IsLocalHost(string host)
    {
        var name = host.ToLowerInvariant().TrimEnd('.');
        var octets = name.Split('.').Select(p => int.TryParse(p, out var n) && n is >= 0 and <= 255 ? n : -1).ToArray();
        if (octets.Length == 4 && octets.All(o => o >= 0))
        {
            int a = octets[0], b = octets[1];
            return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b is >= 16 and <= 31) || (a == 169 && b == 254);
        }
        return name == "localhost" || !name.Contains('.') ||
            new[] { ".local", ".lan", ".home.arpa" }.Any(name.EndsWith);
    }
}
