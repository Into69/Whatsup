using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace WhatsUp;

/**
 * The Android app's strings (res/values/strings.xml, embedded as it is), so both apps say the same
 * thing in the same words.
 */
static partial class Strings
{
    /** Where the phone's words don't fit a computer. */
    static readonly Dictionary<string, string> desktop = new()
    {
        ["offline_mode"] = "Offline mode\nUse only what is saved on this computer: no downloads of orbital data, launches, " +
            "close approaches, satellite details or addresses. Map tiles still load while there is a connection. Turn off to update",
        ["layer_true_scale"] = "True-scale Sun and Moon\nDraw them at their real size, however small, on the globe and in sky view",
    };

    /** Where the system works differently (its location and notifications): set by the shell before first use. */
    public static IReadOnlyDictionary<string, string> Platform { get; set; } = new Dictionary<string, string>();

    static Dictionary<string, string>? all;
    static Dictionary<string, string> Loaded => all ??= Load();

    static Dictionary<string, string> Load()
    {
        var xml = XDocument.Parse(System.Text.Encoding.UTF8.GetString(App.Resource("strings.xml")!));
        var strings = xml.Root!.Elements("string").ToDictionary(e => (string)e.Attribute("name")!, e => Unescape(e.Value));
        foreach (var (name, text) in desktop.Concat(Platform)) strings[name] = text;
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
    public static string Get(string name) => Loaded.TryGetValue(name, out var text) ? text : name;

    /** The string with its %1$s and %2$d filled in, as getString(R.string.name, args). */
    public static string Get(string name, params object[] args) =>
        Placeholder().Replace(Get(name), m => int.Parse(m.Groups[1].Value) - 1 is var i && i < args.Length
            ? Convert.ToString(args[i], System.Globalization.CultureInfo.CurrentCulture) ?? ""
            : m.Value);

    /** Every string, for the settings page. */
    public static IReadOnlyDictionary<string, string> All => Loaded;
}
