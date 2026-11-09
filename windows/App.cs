using System.Diagnostics;
using System.Reflection;

namespace WhatsUp;

/** Where the app keeps its files, and its log; the counterparts of Android's cacheDir and Log. */
static class App
{
    /** %LOCALAPPDATA%\WhatsUp: settings.json, the cache and WebView2's own data. */
    public static readonly string DataDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WhatsUp");

    /** What Android keeps in cacheDir: downloads that can always be fetched again. */
    public static readonly string CacheDir = Path.Combine(DataDir, "cache");

    static readonly object logLock = new();
    static readonly string logFile = Path.Combine(DataDir, "whatsup.log");

    /** A warning to the debugger and to whatsup.log, which is cut back when it grows past 1 MB. */
    public static void Warn(string tag, string message, Exception? e = null)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {tag}: {message}{(e == null ? "" : $" ({e.GetType().Name}: {e.Message})")}";
        Debug.WriteLine(line);
        lock (logLock)
        {
            try
            {
                Directory.CreateDirectory(DataDir);
                if (File.Exists(logFile) && new FileInfo(logFile).Length > 1_000_000) File.Delete(logFile);
                File.AppendAllText(logFile, line + Environment.NewLine);
            }
            catch (IOException) { }
        }
    }

    /** Milliseconds since 1970, as Java's System.currentTimeMillis(). */
    public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /** A file's modification time in milliseconds since 1970, as java.io.File.lastModified() (0 if it doesn't exist). */
    public static long LastModified(string path) =>
        File.Exists(path) ? new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds() : 0;

    /** The embedded files' names with / between folders (MSBuild's RecursiveDir gives \), to their real ones. */
    static readonly Dictionary<string, string> resources = Assembly.GetExecutingAssembly().GetManifestResourceNames()
        .ToDictionary(name => name.Replace('\\', '/'), name => name);

    /** One of the exe's embedded files (see the csproj), as "assets/maplibre/maplibre-gl.js", or null. */
    public static byte[]? Resource(string name)
    {
        if (!resources.TryGetValue(name, out var real)) return null;
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(real);
        if (stream == null) return null;
        var bytes = new MemoryStream();
        stream.CopyTo(bytes);
        return bytes.ToArray();
    }
}
