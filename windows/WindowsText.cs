namespace WhatsUp;

/** Strings.Platform on Windows: where its location and notifications differ from a phone's. */
static class WindowsText
{
    public static readonly Dictionary<string, string> Strings = new()
    {
        ["manual_location_off"] = "Using Windows' location (Wi-Fi, network or GPS)",
        ["location_denied"] = "Windows isn't sharing your location with desktop apps (Settings › Privacy & security › Location), " +
            "so the globe can't centre on you. You can set your location by hand in WhatsUp's settings.",
        ["pass_alerts_denied"] = "Notifications are turned off for WhatsUp in Windows' settings, so pass alerts can't be shown.",
        ["pass_alerts"] = "Visible ISS passes\nA Windows notification 5 minutes before the ISS crosses your sky while you can see it, " +
            "even with WhatsUp closed. Set for the next 3 days each time the app opens",
    };
}
