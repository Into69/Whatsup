using Windows.Devices.Geolocation;

namespace WhatsUp;

/** A location fix: where, and how far off it may be in metres (0 when unknown). */
sealed record Fix(double Lat, double Lon, double AccuracyM);

/**
 * Windows' location (GPS where there is one, otherwise Wi-Fi and the network), as fixes while
 * started. Desktop apps only get it when "Let desktop apps access your location" is on in Windows'
 * privacy settings; when it isn't, onDenied says so and the user can set a location by hand.
 */
sealed class LocationTracker(Action<Fix> onFix, Action onDenied)
{
    Geolocator? locator;

    public async void Start()
    {
        if (locator != null) return;
        try
        {
            if (await Geolocator.RequestAccessAsync() != GeolocationAccessStatus.Allowed)
            {
                onDenied();
                return;
            }
            var started = new Geolocator { DesiredAccuracy = PositionAccuracy.High, ReportInterval = 30_000, MovementThreshold = 25 };
            locator = started;
            started.PositionChanged += (_, e) => { if (locator == started) Report(e.Position); };
            started.StatusChanged += (_, e) =>
            {
                if (locator == started && e.Status == PositionStatus.Disabled) onDenied();
            };
            // The first fix at once, from what Windows already knows if it is recent.
            var first = await started.GetGeopositionAsync(TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(20));
            if (locator == started) Report(first);
        }
        catch (Exception e)
        {
            App.Warn("LocationTracker", "No location", e);
            if (e is UnauthorizedAccessException) onDenied();
        }
    }

    public void Stop() => locator = null;

    void Report(Geoposition position)
    {
        var point = position.Coordinate.Point.Position;
        onFix(new Fix(point.Latitude, point.Longitude, position.Coordinate.Accuracy));
    }
}
