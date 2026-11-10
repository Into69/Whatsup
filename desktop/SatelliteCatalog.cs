namespace WhatsUp;

/**
 * Looks satellites up in CelesTrak's satellite catalogue (SATCAT): owner, object type, launch date
 * and operational status. One small request per satellite, made when the user taps it, and kept for
 * a week since these details rarely change.
 */
sealed class SatelliteCatalog
{
    const string Tag = "SatelliteCatalog";
    const long MaxAgeMs = 7 * 24 * 60 * 60 * 1000L;
    readonly string dir = Path.Combine(App.CacheDir, "satcat");

    /**
     * The catalogue record as CelesTrak's JSON (an array of one object), or null if there is none and
     * nothing cached. Blocks on the network, so call it off the UI thread.
     */
    public byte[]? Lookup(int noradId)
    {
        var file = Path.Combine(dir, $"{noradId}.json");
        var cached = File.Exists(file) ? File.ReadAllBytes(file) : null;
        if (cached != null && App.Now() - App.LastModified(file) < MaxAgeMs) return cached;
        if (Http.Offline) return cached;
        try
        {
            var body = Http.GetBytes($"https://celestrak.org/satcat/records.php?CATNR={noradId}&FORMAT=json", readTimeoutMs: 15_000);
            if (body.Length == 0 || body[0] != '[') throw new InvalidDataException("Not JSON");
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(file, body);
            return body;
        }
        catch (Exception e)
        {
            App.Warn(Tag, $"SATCAT lookup of {noradId} failed; cached: {cached != null}", e);
            return cached;
        }
    }
}
