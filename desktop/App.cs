using System.Diagnostics;
using System.Reflection;

namespace WhatsUp;

/** Where the app keeps its files, and its log; the counterparts of Android's cacheDir and Log. */
static class App
{
    /**
     * settings.json, passes.json and the log, and the web view's own data: %LOCALAPPDATA%\WhatsUp on
     * Windows, ~/.local/share/whatsup (or $XDG_DATA_HOME's) on Linux.
     */
    public static readonly string DataDir = OperatingSystem.IsWindows()
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WhatsUp")
        : Path.Combine(Xdg("XDG_DATA_HOME", ".local/share"), "whatsup");

    /**
     * What Android keeps in cacheDir: downloads that can always be fetched again. In DataDir on
     * Windows, ~/.cache/whatsup (or $XDG_CACHE_HOME's) on Linux.
     */
    public static readonly string CacheDir = OperatingSystem.IsWindows()
        ? Path.Combine(DataDir, "cache")
        : Path.Combine(Xdg("XDG_CACHE_HOME", ".cache"), "whatsup");

    /** An XDG base directory: the variable's if it is set to an absolute path, else the default in the home folder. */
    static string Xdg(string variable, string fallback) =>
        Environment.GetEnvironmentVariable(variable) is { } dir && Path.IsPathRooted(dir)
            ? dir
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), fallback);

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

    /**
     * The embedded files' names with / between folders (MSBuild's RecursiveDir gives \), to their
     * real ones and the assembly holding them: this one (the page, see WhatsUp.Desktop.csproj), or
     * the shell's.
     */
    static readonly Dictionary<string, (Assembly Assembly, string Name)> resources =
        new[] { Assembly.GetExecutingAssembly(), Assembly.GetEntryAssembly() }.OfType<Assembly>().Distinct()
            .SelectMany(assembly => assembly.GetManifestResourceNames().Select(name => (assembly, name)))
            .ToDictionary(r => r.name.Replace('\\', '/'), r => (r.assembly, r.name));

    /** One of the embedded files, as "assets/maplibre/maplibre-gl.js", or null. */
    public static byte[]? Resource(string name)
    {
        if (!resources.TryGetValue(name, out var real)) return null;
        using var stream = real.Assembly.GetManifestResourceStream(real.Name);
        if (stream == null) return null;
        var bytes = new MemoryStream();
        stream.CopyTo(bytes);
        return bytes.ToArray();
    }
}
