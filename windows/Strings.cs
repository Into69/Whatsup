using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace WhatsUp;

/**
 * The Android app's strings (res/values/strings.xml, embedded as it is), so both apps say the same
 * thing in the same words.
 */
static partial class Strings
{
    /** Where the phone's words don't fit a computer, or Windows works differently. */
    static readonly Dictionary<string, string> windows = new()
    {
        ["manual_location_off"] = "Using Windows' location (Wi-Fi, network or GPS)",
        ["location_denied"] = "Windows isn't sharing your location with desktop apps (Settings › Privacy & security › Location), " +
            "so the globe can't centre on you. You can set your location by hand in WhatsUp's settings.",
        ["offline_mode"] = "Offline mode\nUse only what is saved on this computer: no downloads of orbital data, launches, " +
            "close approaches, satellite details or addresses. Map tiles still load while there is a connection. Turn off to update",
        ["pass_alerts_denied"] = "Notifications are turned off for WhatsUp in Windows' settings, so pass alerts can't be shown.",
        ["pass_alerts"] = "Visible ISS passes\nA Windows notification 5 minutes before the ISS crosses your sky while you can see it, " +
            "even with WhatsUp closed. Set for the next 3 days each time the app opens",
        ["layer_true_scale"] = "True-scale Sun and Moon\nDraw them at their real size, however small, on the globe and in sky view",
    };

    // After the overrides above, which Load reads.
    static readonly Dictionary<string, string> all = Load();

    static Dictionary<string, string> Load()
    {
        var xml = XDocument.Parse(System.Text.Encoding.UTF8.GetString(App.Resource("strings.xml")!));
        var strings = xml.Root!.Elements("string").ToDictionary(e => (string)e.Attribute("name")!, e => Unescape(e.Value));
        foreach (var (name, text) in windows) strings[name] = text;
        // Android's Geocoder looks addresses up there; here it is Nominatim.
        strings["about_text"] += " Addresses: OpenStreetMap's Nominatim.";
        return strings;
    }

    /** Android's escapes in string resources: \' \" \n \\ and \@. */
    static string Unescape(string text) =>
        Escape().Replace(text, m => m.Groups[1].Value switch { "n" => "\n", "t" => "\t", var c => c });

    [GeneratedRegex(@"\\(.)")]
    private static partial Regex Escape();

    [GeneratedRegex(@"%(\d+)\$([sd])")]
    private static partial Regex Placeholder();

    /** The string named, as getString(R.string.name). */
    public static string Get(string name) => all.TryGetValue(name, out var text) ? text : name;

    /** The string with its %1$s and %2$d filled in, as getString(R.string.name, args). */
    public static string Get(string name, params object[] args) =>
        Placeholder().Replace(Get(name), m => int.Parse(m.Groups[1].Value) - 1 is var i && i < args.Length
            ? Convert.ToString(args[i], System.Globalization.CultureInfo.CurrentCulture) ?? ""
            : m.Value);

    /** Every string, for the settings page. */
    public static IReadOnlyDictionary<string, string> All => all;
}
