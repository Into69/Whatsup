using System.Globalization;
using System.Text.RegularExpressions;

namespace WhatsUp;

/** A position in degrees, WGS84. */
readonly record struct LatLon(double Lat, double Lon)
{
    /** "53.54610°N 113.49380°W". */
    public string Format() => string.Format(CultureInfo.InvariantCulture, "{0:F5}°{1} {2:F5}°{3}",
        Math.Abs(Lat), Lat >= 0 ? "N" : "S", Math.Abs(Lon), Lon >= 0 ? "E" : "W");
}

/**
 * Reading positions typed by the user, as latitude and longitude (decimal or degrees, minutes and
 * seconds) or MGRS, and writing them as MGRS. UTM and MGRS are on WGS84, with the Krüger series
 * (good to well under a metre), and MGRS uses the standard (AA) lettering.
 */
static partial class Coordinates
{
    // ---- Latitude and longitude ----

    [GeneratedRegex("[°º˚'’′\"”″]")] private static partial Regex Marks();
    [GeneratedRegex(@"^[0-9NSEW.,;+\-\s]+$")] private static partial Regex LatLonChars();
    [GeneratedRegex(@"[NSEW]|[+\-]?\s*[0-9.]+")] private static partial Regex Token();
    [GeneratedRegex(@"\s")] private static partial Regex Space();
    [GeneratedRegex("[,;]")] private static partial Regex Comma();
    [GeneratedRegex(@"^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$")] private static partial Regex Mgrs();

    /**
     * "53.55, -113.5", "53.55N 113.5W", "N53.55 W113.5", "53°33'18\"N 113°30'W", "53 33 18 N 113 30 0 W";
     * null if the text isn't a latitude and longitude.
     */
    public static LatLon? ParseLatLon(string text)
    {
        var cleaned = Marks().Replace(text.ToUpperInvariant(), " ").Trim();
        if (cleaned.Length == 0 || !LatLonChars().IsMatch(cleaned)) return null;
        if (SplitHalves(cleaned) is not var (firstText, secondText)) return null;
        if (ParseAngle(firstText) is not var (firstValue, firstLetter)) return null;
        if (ParseAngle(secondText) is not var (secondValue, secondLetter)) return null;
        // Both north/south, or both east/west: not a latitude and a longitude.
        static char Axis(char letter) => "NS".Contains(letter) ? 'y' : "EW".Contains(letter) ? 'x' : ' ';
        if (Axis(firstLetter) != ' ' && Axis(firstLetter) == Axis(secondLetter)) return null;
        // A hemisphere letter says which is which; otherwise latitude comes first.
        var (lat, lon) = "EW".Contains(firstLetter) && firstLetter != ' ' || "NS".Contains(secondLetter) && secondLetter != ' '
            ? (secondValue, firstValue)
            : (firstValue, secondValue);
        if (Math.Abs(lat) > 90 || Math.Abs(lon) > 180) return null;
        return new LatLon(lat, lon);
    }

    /** Numbers (a sign may be spaced off them: "- 113.5") and hemisphere letters. */
    static List<string> Tokens(string text) => Token().Matches(text).Select(m => Space().Replace(m.Value, "")).ToList();

    static bool IsLetter(string token) => token.Length == 1 && "NSEW".Contains(token[0]);

    /**
     * The text cut into its latitude and longitude parts: at a comma; else at a hemisphere letter
     * between the two sets of numbers, which belongs to the second when letters come first
     * ("N53 33 W113 30") and to the first when they come after ("53 33 N 113 30 W"); else half the
     * numbers each.
     */
    static (string, string)? SplitHalves(string text)
    {
        if (Comma().Match(text) is { Success: true } comma)
        {
            return (text[..comma.Index].Trim(), text[(comma.Index + comma.Length)..].Trim());
        }
        var tokens = Tokens(text);
        var numbers = Enumerable.Range(0, tokens.Count).Where(i => !IsLetter(tokens[i])).ToList();
        if (numbers.Count < 2) return null;
        var between = Enumerable.Range(0, tokens.Count).Where(i => IsLetter(tokens[i]) && i > numbers[0] && i < numbers[^1]).ToList();
        int cut;
        switch (between.Count)
        {
            case 0:
                if (numbers.Count % 2 != 0) return null;
                cut = numbers[numbers.Count / 2];
                break;
            case 1:
                cut = IsLetter(tokens[0]) ? between[0] : between[0] + 1;
                break;
            case 2:
                cut = between[1];
                break;
            default:
                return null;
        }
        return (string.Join(" ", tokens.Take(cut)), string.Join(" ", tokens.Skip(cut)));
    }

    /** "53 33 18 N" to (53.555, 'N'); a letter of ' ' when there is none. Degrees, minutes, seconds; S and W negative. */
    static (double, char)? ParseAngle(string text)
    {
        var tokens = Tokens(text);
        var letters = tokens.Where(IsLetter).ToList();
        if (letters.Count > 1) return null;
        var letter = letters.Count == 1 ? letters[0][0] : ' ';
        var numbers = new List<double>();
        foreach (var token in tokens.Where(t => !IsLetter(t)))
        {
            if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out var n)) return null;
            numbers.Add(n);
        }
        if (numbers.Count is 0 or > 3) return null;
        var negative = numbers[0] < 0 || text.Trim().StartsWith('-');
        var parts = numbers.Select((n, i) => i == 0 ? Math.Abs(n) : n).ToList();
        if (parts.Skip(1).Any(p => p is < 0 or >= 60)) return null;
        var degrees = parts[0] + (parts.Count > 1 ? parts[1] : 0) / 60 + (parts.Count > 2 ? parts[2] : 0) / 3600;
        if (negative || letter is 'S' or 'W') degrees = -degrees;
        return (degrees, letter);
    }

    // ---- UTM ----

    const double A = 6378137.0;
    const double F = 1 / 298.257223563;
    const double K0 = 0.9996;
    const double FalseEasting = 500_000.0;
    const double FalseNorthingSouth = 10_000_000.0;
    static readonly double N = F / (2 - F);
    static readonly double RectifyingRadius = A / (1 + N) * (1 + N * N / 4 + N * N * N * N / 64);
    static readonly double[] Alpha =
    [
        N / 2 - 2 * N * N / 3 + 5 * N * N * N / 16,
        13 * N * N / 48 - 3 * N * N * N / 5,
        61 * N * N * N / 240,
    ];
    static readonly double[] Beta =
    [
        N / 2 - 2 * N * N / 3 + 37 * N * N * N / 96,
        N * N / 48 + N * N * N / 15,
        17 * N * N * N / 480,
    ];
    static readonly double[] Delta =
    [
        2 * N - 2 * N * N / 3 - 2 * N * N * N,
        7 * N * N / 3 - 8 * N * N * N / 5,
        56 * N * N * N / 15,
    ];

    public readonly record struct Utm(int Zone, char Band, double Easting, double Northing);

    const string Bands = "CDEFGHJKLMNPQRSTUVWX";

    /** The UTM zone for a position, with the exceptions for south-west Norway and Svalbard. */
    public static int UtmZone(double lat, double lon)
    {
        var normalized = ((lon + 180) % 360 + 360) % 360 - 180;
        var zone = (int)Math.Floor((normalized + 180) / 6) + 1;
        if (zone > 60) zone = 60;
        if (lat is >= 56 and < 64 && normalized is >= 3 and < 12) zone = 32;
        if (lat is >= 72 and < 84)
        {
            zone = normalized switch
            {
                >= 0 and < 9 => 31,
                >= 9 and < 21 => 33,
                >= 21 and < 33 => 35,
                >= 33 and < 42 => 37,
                _ => zone,
            };
        }
        return zone;
    }

    static double CentralMeridian(int zone) => ((zone - 1) * 6.0 - 180 + 3) * Math.PI / 180;

    /** UTM for a position between 80°S and 84°N. */
    public static Utm ToUtm(LatLon position)
    {
        var zone = UtmZone(position.Lat, position.Lon);
        var band = Bands[Math.Clamp((int)((position.Lat + 80) / 8), 0, Bands.Length - 1)];
        var (easting, northing) = Project(position.Lat * Math.PI / 180, position.Lon * Math.PI / 180, zone);
        return new Utm(zone, band, easting, position.Lat < 0 ? northing + FalseNorthingSouth : northing);
    }

    /** Transverse Mercator easting and (northern) northing in metres. */
    static (double, double) Project(double phi, double lambda, int zone)
    {
        var dLambda = lambda - CentralMeridian(zone);
        var twoRootN = 2 * Math.Sqrt(N) / (1 + N);
        var t = Math.Sinh(Math.Atanh(Math.Sin(phi)) - twoRootN * Math.Atanh(twoRootN * Math.Sin(phi)));
        var xi = Math.Atan(t / Math.Cos(dLambda));
        var eta = Math.Atanh(Math.Sin(dLambda) / Math.Sqrt(1 + t * t));
        double e = eta, n = xi;
        for (var j = 1; j <= 3; j++)
        {
            e += Alpha[j - 1] * Math.Cos(2 * j * xi) * Math.Sinh(2 * j * eta);
            n += Alpha[j - 1] * Math.Sin(2 * j * xi) * Math.Cosh(2 * j * eta);
        }
        return (FalseEasting + K0 * RectifyingRadius * e, K0 * RectifyingRadius * n);
    }

    /** The position of a UTM coordinate; south when in the southern hemisphere. */
    public static LatLon FromUtm(int zone, bool south, double easting, double northing)
    {
        var xi = (northing - (south ? FalseNorthingSouth : 0.0)) / (K0 * RectifyingRadius);
        var eta = (easting - FalseEasting) / (K0 * RectifyingRadius);
        double xiP = xi, etaP = eta;
        for (var j = 1; j <= 3; j++)
        {
            xiP -= Beta[j - 1] * Math.Sin(2 * j * xi) * Math.Cosh(2 * j * eta);
            etaP -= Beta[j - 1] * Math.Cos(2 * j * xi) * Math.Sinh(2 * j * eta);
        }
        var chi = Math.Asin(Math.Sin(xiP) / Math.Cosh(etaP));
        var phi = chi;
        for (var j = 1; j <= 3; j++) phi += Delta[j - 1] * Math.Sin(2 * j * chi);
        var lambda = CentralMeridian(zone) + Math.Atan(Math.Sinh(etaP) / Math.Cos(xiP));
        return new LatLon(phi * 180 / Math.PI, (lambda * 180 / Math.PI + 540) % 360 - 180);
    }

    // ---- MGRS ----

    /** Column letters of the 100 km squares, by the zone's set (zone % 3: 1, 2, 0); I and O left out. */
    static readonly string[] ColumnLetters = ["STUVWXYZ", "ABCDEFGH", "JKLMNPQR"];
    const string RowLetters = "ABCDEFGHJKLMNPQRSTUV";
    /**
     * The least northing (m, as written in the zone's hemisphere) in each latitude band, to place a
     * 100 km row letter (which repeats every 2,000 km) in the right cycle.
     */
    static readonly Dictionary<char, double> BandMinNorthing = new()
    {
        ['C'] = 1_100_000, ['D'] = 2_000_000, ['E'] = 2_800_000, ['F'] = 3_700_000, ['G'] = 4_600_000,
        ['H'] = 5_500_000, ['J'] = 6_400_000, ['K'] = 7_300_000, ['L'] = 8_200_000, ['M'] = 9_100_000,
        ['N'] = 0, ['P'] = 800_000, ['Q'] = 1_700_000, ['R'] = 2_600_000, ['S'] = 3_500_000,
        ['T'] = 4_400_000, ['U'] = 5_300_000, ['V'] = 6_200_000, ['W'] = 7_000_000, ['X'] = 7_900_000,
    };

    static int Mod(int a, int n) => ((a % n) + n) % n;

    /** "12U VD 41533 41226" (to the metre); null outside 80°S to 84°N, where MGRS uses polar grids instead. */
    public static string? ToMgrs(LatLon position)
    {
        if (position.Lat < -80 || position.Lat >= 84) return null;
        var utm = ToUtm(position);
        var column = ColumnLetters[utm.Zone % 3][Math.Clamp((int)Math.Floor(utm.Easting / 100_000) - 1, 0, 7)];
        var rowOffset = utm.Zone % 2 == 0 ? 5 : 0;
        var row = RowLetters[Mod((int)Math.Floor(utm.Northing / 100_000) + rowOffset, 20)];
        var e = (int)Math.Floor(utm.Easting % 100_000);
        var n = (int)Math.Floor(utm.Northing % 100_000);
        return string.Format(CultureInfo.InvariantCulture, "{0}{1} {2}{3} {4:D5} {5:D5}", utm.Zone, utm.Band, column, row, e, n);
    }

    /**
     * "12UVD4153341226", "12U VD 4153 4122", "12U VD": the south-west corner of the square it names
     * (to its precision), or its middle when centre. Null if the text isn't MGRS.
     */
    public static LatLon? ParseMgrs(string text, bool centre = true)
    {
        var compact = Space().Replace(text.ToUpperInvariant(), "");
        var match = Mgrs().Match(compact);
        if (!match.Success) return null;
        var zone = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        var digits = match.Groups[5].Value;
        if (zone is < 1 or > 60 || digits.Length % 2 != 0 || digits.Length > 10) return null;
        var band = match.Groups[2].Value[0];
        var columnIndex = ColumnLetters[zone % 3].IndexOf(match.Groups[3].Value[0]);
        var rowIndex = RowLetters.IndexOf(match.Groups[4].Value[0]);
        if (columnIndex < 0 || rowIndex < 0) return null;
        var half = digits.Length / 2;
        var unit = half == 0 ? 100_000.0 : Math.Pow(10, 5 - half);
        var eDigits = half == 0 ? 0.0 : double.Parse(digits[..half], CultureInfo.InvariantCulture) * unit;
        var nDigits = half == 0 ? 0.0 : double.Parse(digits[half..], CultureInfo.InvariantCulture) * unit;
        var inside = centre ? unit / 2 : 0.0;
        var easting = (columnIndex + 1) * 100_000.0 + eDigits + inside;
        var rowOffset = zone % 2 == 0 ? 5 : 0;
        var northing = Mod(rowIndex - rowOffset, 20) * 100_000.0 + nDigits + inside;
        if (!BandMinNorthing.TryGetValue(band, out var least)) return null;
        while (northing < least) northing += 2_000_000.0;
        return FromUtm(zone, band < 'N', easting, northing);
    }
}
