using System.Text.Json.Nodes;

namespace WhatsUp;

/** A location found from what the user typed: where it is, a name for it, and how it was read. */
sealed record Place(LatLon Position, string Label, Place.Sources Source)
{
    public enum Sources { Coordinates, Mgrs, Address }
}

/**
 * Turns what the user typed into a place: latitude and longitude, MGRS, or else an address looked up
 * with OpenStreetMap's Nominatim (Android uses the phone's Geocoder; Windows has none without a
 * key). It needs a connection, and its policy allows a request a second, which typing and pressing
 * Find never comes near.
 */
static class Places
{
    const string Tag = "Places";
    /** How long typed coordinates wait for a place name before going without one. */
    const int NameTimeoutMs = 3_000;
    const string Nominatim = "https://nominatim.openstreetmap.org";

    /** The place, or null if the text is neither coordinates nor an address Nominatim knows. */
    public static async Task<Place?> Find(string text)
    {
        var query = text.Trim();
        if (query.Length == 0) return null;
        // Typed coordinates need no network; a name for them is only a nicety, so not waited on long.
        async Task<string?> Named(LatLon position)
        {
            var name = NameFor(position);
            return await Task.WhenAny(name, Task.Delay(NameTimeoutMs)) == name ? name.Result : null;
        }
        if (Coordinates.ParseLatLon(query) is { } latLon) return new Place(latLon, await Named(latLon) ?? latLon.Format(), Place.Sources.Coordinates);
        if (Coordinates.ParseMgrs(query) is { } mgrs) return new Place(mgrs, await Named(mgrs) ?? mgrs.Format(), Place.Sources.Mgrs);
        var found = await LookUp($"{Nominatim}/search?format=jsonv2&limit=1&q={Uri.EscapeDataString(query)}");
        if (found is not JsonArray { Count: > 0 } results || results[0] is not JsonObject address) return null;
        if (Json.Number(address, "lat") is not { } lat || Json.Number(address, "lon") is not { } lon) return null;
        return new Place(new LatLon(lat, lon), Json.Text(address, "display_name"), Place.Sources.Address);
    }

    /** A short name for a position ("Edmonton, Alberta, Canada"), if Nominatim has one. */
    static async Task<string?> NameFor(LatLon position)
    {
        var url = FormattableString.Invariant($"{Nominatim}/reverse?format=jsonv2&zoom=10&lat={position.Lat}&lon={position.Lon}");
        if (await LookUp(url) is not JsonObject { } found || found["address"] is not JsonObject address) return null;
        var parts = new[]
        {
            new[] { "city", "town", "village", "hamlet", "municipality", "county" }.Select(k => Json.Text(address, k)).FirstOrDefault(s => s != ""),
            Json.Text(address, "state"),
            Json.Text(address, "country"),
        }.Where(s => !string.IsNullOrEmpty(s)).Distinct().ToList();
        return parts.Count == 0 ? null : string.Join(", ", parts);
    }

    /** A Nominatim request off the UI thread; null if offline, no answer or an error. */
    static Task<JsonNode?> LookUp(string url) => Task.Run(() =>
    {
        if (Http.Offline) return null;
        try
        {
            return JsonNode.Parse(Http.GetBytes(url, readTimeoutMs: 10_000));
        }
        catch (Exception e)
        {
            App.Warn(Tag, "Nominatim failed", e);
            return null;
        }
    });
}
