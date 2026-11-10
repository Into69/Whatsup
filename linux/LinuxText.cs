namespace WhatsUp;

/** Strings.Platform on Linux: where its location and notifications differ from a phone's. */
static class LinuxText
{
    public static readonly Dictionary<string, string> Strings = new()
    {
        ["manual_location_off"] = "Using this computer's location (GeoClue: Wi-Fi or GPS)",
        ["location_denied"] = "This computer isn't sharing its location (GeoClue is missing, or location services are off), " +
            "so the globe can't centre on you. You can set your location by hand in WhatsUp's settings.",
        ["pass_alerts_denied"] = "There is no notification service on this desktop, so pass alerts can't be shown.",
        ["pass_alerts"] = "Visible ISS passes\nA notification 5 minutes before the ISS crosses your sky while you can see it, " +
            "even with WhatsUp closed, until the computer restarts. Set for the next 3 days each time the app opens",
    };
}
