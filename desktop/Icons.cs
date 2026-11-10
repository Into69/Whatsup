using System.Globalization;
using System.Text;
using System.Xml.Linq;

namespace WhatsUp;

/**
 * The Android app's icons (res/drawable/ic_*.xml, vector drawables, embedded as they are) as SVG
 * for the page's buttons, so both apps draw the same ones. Vector drawables are SVG paths under
 * other names; only what the app's icons use is turned: paths, groups and their attributes.
 */
static class Icons
{
    static readonly XNamespace Android = "http://schemas.android.com/apk/res/android";

    /** ic_search and so on as an SVG document, or null if there is no such icon. */
    public static byte[]? Svg(string name)
    {
        if (App.Resource($"icons/{name}.xml") is not { } xml) return null;
        var vector = XDocument.Parse(Encoding.UTF8.GetString(xml)).Root!;
        var width = (string?)vector.Attribute(Android + "viewportWidth") ?? "24";
        var height = (string?)vector.Attribute(Android + "viewportHeight") ?? "24";
        var svg = new StringBuilder($"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {width} {height}\">");
        foreach (var child in vector.Elements()) Append(svg, child);
        svg.Append("</svg>");
        return Encoding.UTF8.GetBytes(svg.ToString());
    }

    static void Append(StringBuilder svg, XElement element)
    {
        string? A(string name) => (string?)element.Attribute(Android + name);
        if (element.Name.LocalName == "group")
        {
            var transform = new StringBuilder();
            if (A("translateX") != null || A("translateY") != null) transform.Append($"translate({A("translateX") ?? "0"} {A("translateY") ?? "0"}) ");
            if (A("rotation") is { } rotation) transform.Append($"rotate({rotation} {A("pivotX") ?? "0"} {A("pivotY") ?? "0"}) ");
            if (A("scaleX") != null || A("scaleY") != null) transform.Append($"scale({A("scaleX") ?? "1"} {A("scaleY") ?? "1"})");
            svg.Append($"<g transform=\"{transform.ToString().Trim()}\">");
            foreach (var child in element.Elements()) Append(svg, child);
            svg.Append("</g>");
            return;
        }
        if (element.Name.LocalName != "path") return;
        svg.Append($"<path d=\"{A("pathData")}\"");
        svg.Append($" fill=\"{Colour(A("fillColor")) ?? "none"}\"");
        if (A("fillType") == "evenOdd") svg.Append(" fill-rule=\"evenodd\"");
        if (Colour(A("strokeColor")) is { } stroke)
        {
            svg.Append($" stroke=\"{stroke}\" stroke-width=\"{A("strokeWidth") ?? "1"}\"");
            if (A("strokeLineCap") is { } cap) svg.Append($" stroke-linecap=\"{cap}\"");
            if (A("strokeLineJoin") is { } join) svg.Append($" stroke-linejoin=\"{join}\"");
        }
        svg.Append("/>");
    }

    /** #AARRGGBB or #RRGGBB (Android puts alpha first) as CSS; null for none or a theme reference. */
    static string? Colour(string? value)
    {
        if (value == null || !value.StartsWith('#')) return null;
        var hex = value[1..];
        if (hex.Length == 8)
        {
            var alpha = int.Parse(hex[..2], NumberStyles.HexNumber) / 255.0;
            return $"rgba({int.Parse(hex[2..4], NumberStyles.HexNumber)},{int.Parse(hex[4..6], NumberStyles.HexNumber)}," +
                $"{int.Parse(hex[6..8], NumberStyles.HexNumber)},{alpha.ToString("0.###", CultureInfo.InvariantCulture)})";
        }
        return value;
    }
}
