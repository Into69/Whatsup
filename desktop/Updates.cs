using System.Diagnostics;
using System.Formats.Tar;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace WhatsUp;

/** A WhatsUp on GitHub: its version, and this system's file in it (its address, size and SHA-256 if GitHub gives one). */
sealed record Release(string Version, string Url, long SizeBytes, string? Sha256);

/**
 * Newer versions of the app: the latest release on GitHub, whose tag is "v" and the version (the
 * Android app's versionName, which this app's is), with WhatsUp.exe and WhatsUp-linux-x64.tar.gz
 * attached. Host looks once a day, if the user lets it (Settings.CheckUpdates), and offers it on the
 * globe (globe.showUpdate); the settings page looks when asked. Installing downloads it with the
 * other downloads' progress panel, checks it, puts it in place of the running program, and Restart
 * starts that.
 */
static class Updates
{
    public const string LatestUrl = "https://api.github.com/repos/Into69/Whatsup/releases/latest";
    /** How often Host looks by itself. */
    public const long CheckEveryMs = 24 * 60 * 60 * 1000L;
    /** The download's key in DownloadTracker. */
    public const string DownloadKey = "app-update";

    /** This system's file in a release. */
    public static string Asset => OperatingSystem.IsWindows() ? "WhatsUp.exe" : "WhatsUp-linux-x64.tar.gz";

    /** The running program, which an update replaces: WhatsUp.exe, or the whatsup binary wherever install.sh put it. */
    static string Program => Environment.ProcessPath ?? throw new InvalidOperationException("No program path");

    /** The latest release with asset attached, from GitHub's release JSON; null if it has no such file. */
    public static Release? Parse(string json, string asset)
    {
        if (JsonNode.Parse(json) is not JsonObject release) return null;
        var version = Json.Text(release, "tag_name");
        if (version.StartsWith('v')) version = version[1..];
        if (version.Length == 0) return null;
        foreach (var file in release["assets"] as JsonArray ?? [])
        {
            if (file is not JsonObject o || Json.Text(o, "name") != asset) continue;
            var url = Json.Text(o, "browser_download_url");
            if (url.Length == 0) return null;
            var digest = Json.Text(o, "digest");
            return new Release(
                version,
                url,
                (long)(Json.Number(o, "size") ?? -1),
                digest.StartsWith("sha256:", StringComparison.Ordinal) ? digest["sha256:".Length..].ToLowerInvariant() : null);
        }
        return null;
    }

    /** Whether version comes after than: "0.10" after "0.9", "1.0" after "0.9.5"... numerically, part by part. */
    public static bool IsNewer(string version, string than)
    {
        var a = Parts(version);
        var b = Parts(than);
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            var x = i < a.Length ? a[i] : 0;
            var y = i < b.Length ? b[i] : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    static int[] Parts(string version) =>
        version.Trim().TrimStart('v').Split('.')
            .Select(part => int.TryParse(new string(part.TakeWhile(char.IsAsciiDigit).ToArray()), out var n) ? n : 0)
            .ToArray();

    /** The latest release, newer or not; null if it has nothing for this system. Blocking; throws if GitHub can't be reached. */
    public static Release? Latest() => Parse(Http.GetText(LatestUrl), Asset);

    /** The latest release if it is newer than this app; else null. Blocking; throws if GitHub can't be reached. */
    public static Release? Newer() => Latest() is { } latest && IsNewer(latest.Version, Http.Version) ? latest : null;

    public static string Sha256(string file)
    {
        using var stream = File.OpenRead(file);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    /**
     * Downloads the release (its progress under DownloadKey in tracker), checks it against GitHub's
     * checksum, and puts it in place of the running program, for Restart to start. Blocking; throws,
     * leaving the running program where it was, if any of that fails.
     */
    public static void Install(Release release, DownloadTracker tracker)
    {
        var program = Program;
        var folder = Path.GetDirectoryName(program)!;
        // Staged beside the program, so it is moved into place on the same drive, and early proof
        // that the folder can be written to.
        var staged = program + ".update";
        try
        {
            File.WriteAllBytes(staged, []);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new IOException(Strings.Get("update_folder_locked", folder), e);
        }
        var download = OperatingSystem.IsWindows() ? staged : Path.Combine(App.CacheDir, "update", Asset);
        var name = OperatingSystem.IsWindows() ? $"WhatsUp-{release.Version}.exe" : $"WhatsUp-linux-x64-{release.Version}.tar.gz";
        try
        {
            tracker.DownloadTo(release.Url, download, DownloadKey, name, app: true);
            if (release.Sha256 != null && Sha256(download) != release.Sha256) throw new InvalidDataException(Strings.Get("update_corrupt"));
            if (!OperatingSystem.IsWindows()) Unpack(download, staged);
            Replace(program, staged);
        }
        finally
        {
            TryDelete(staged);
            if (download != staged) TryDelete(download);
        }
    }

    /** The program from the Linux package (whatsup/whatsup in the .tar.gz), as an executable file. */
    static void Unpack(string package, string file)
    {
        using var gzip = new GZipStream(File.OpenRead(package), CompressionMode.Decompress);
        using var tar = new TarReader(gzip);
        while (tar.GetNextEntry() is { } entry)
        {
            if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile)) continue;
            if (entry.Name.TrimStart('.', '/') != "whatsup/whatsup") continue;
            entry.ExtractToFile(file, overwrite: true);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                    UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            }
            return;
        }
        throw new InvalidDataException("The package has no whatsup/whatsup");
    }

    /**
     * The new program in place of the running one. Windows won't overwrite a running exe but will
     * rename it, so it steps aside as WhatsUp.exe.old (deleted by the next start, AfterRestart);
     * Linux replaces the file's name, and the running program keeps its old file until it ends.
     */
    static void Replace(string program, string staged)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.Move(staged, program, overwrite: true);
            return;
        }
        var old = program + ".old";
        TryDelete(old);
        File.Move(program, old);
        try
        {
            File.Move(staged, program);
        }
        catch
        {
            File.Move(old, program);
            throw;
        }
    }

    /** Starts the program (the new one, after Install), which waits for this one to end first (AfterRestart). */
    public static void Restart()
    {
        var start = new ProcessStartInfo(Program) { UseShellExecute = false, WorkingDirectory = Environment.CurrentDirectory };
        start.ArgumentList.Add("--after");
        start.ArgumentList.Add(Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Process.Start(start)?.Dispose();
    }

    /**
     * First thing in Main: if started by Restart, waits (up to 30 s) for the program before it to
     * end, so the one-window check doesn't find it still running; then clears up after an update.
     */
    public static void AfterRestart(string[] args)
    {
        var i = Array.IndexOf(args, "--after");
        if (i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var id))
        {
            try
            {
                using var before = Process.GetProcessById(id);
                before.WaitForExit(30_000);
            }
            catch (ArgumentException)
            {
                // Already gone.
            }
        }
        if (OperatingSystem.IsWindows() && Environment.ProcessPath is { } program) TryDelete(program + ".old");
    }

    static void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Next time.
        }
    }
}
