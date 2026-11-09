using System.Text.Json.Nodes;
using Microsoft.Toolkit.Uwp.Notifications;
using Windows.UI.Notifications;

namespace WhatsUp;

/**
 * Notifications shortly before passes: visible ISS passes, and every pass of a starred satellite,
 * each kind turned on in settings. The page works out the passes (passes.js) and hands them all over
 * each time the app opens; they are kept here and the kinds turned on are scheduled as Windows
 * notifications, which Windows shows at their time even with the app closed. They only cover the
 * days the page predicted, so alerts stop if the app isn't opened for a few days.
 */
static class PassAlerts
{
    const string Tag = "PassAlerts";
    /** The scheduled notifications' group, so only this app's passes are cleared when rescheduling. */
    const string Group = "passes";
    /** More passes than this are dropped. */
    const int MaxAlarms = 40;
    const string KindIss = "iss";
    const string KindFavourite = "favourite";
    /** Alerts this close together for the same satellite are the same pass. */
    const long SamePassMs = 20 * 60 * 1000L;
    const long WarningMs = 5 * 60 * 1000L;

    static readonly string file = Path.Combine(App.DataDir, "passes.json");

    /** Keeps the passes (passes.js's alert list, as JSON) and schedules them if alerts are on. */
    public static void Update(Settings settings, string passesJson)
    {
        try
        {
            Directory.CreateDirectory(App.DataDir);
            File.WriteAllText(file, passesJson);
        }
        catch (IOException e)
        {
            App.Warn(Tag, "Couldn't keep the passes", e);
        }
        Reschedule(settings);
    }

    /** Schedules the kept passes when alerts are on, and clears them all when off. */
    public static void Reschedule(Settings settings)
    {
        try
        {
            var notifier = ToastNotificationManagerCompat.CreateToastNotifier();
            foreach (var scheduled in notifier.GetScheduledToastNotifications())
            {
                if (scheduled.Group == Group) notifier.RemoveFromSchedule(scheduled);
            }
            var kinds = new HashSet<string>();
            if (settings.PassAlerts) kinds.Add(KindIss);
            if (settings.FavouriteAlerts) kinds.Add(KindFavourite);
            if (kinds.Count == 0 || !File.Exists(file)) return;
            var now = App.Now();
            string KindOf(JsonObject pass) => Json.Text(pass, "kind") is var k && k != "" ? k : KindIss;
            long Rise(JsonObject pass) => (long)(Json.Number(pass, "rise") ?? 0);
            // Soonest first, so the alarms there are room for go to the nearest passes.
            var wanted = (JsonNode.Parse(File.ReadAllText(file)) as JsonArray ?? []).OfType<JsonObject>()
                .Where(p => kinds.Contains(KindOf(p)) && Rise(p) - WarningMs > now + 1000)
                .ToList();
            // A starred ISS has its passes twice; its visible ones already have an alert.
            var visibleIss = wanted.Where(p => KindOf(p) == KindIss).ToList();
            var passes = wanted
                .Where(pass => !(Json.Text(pass, "kind") == KindFavourite && visibleIss.Any(it =>
                    Json.Text(it, "name") == Json.Text(pass, "name") && Math.Abs(Rise(it) - Rise(pass)) < SamePassMs)))
                .OrderBy(Rise)
                .Take(MaxAlarms)
                .ToList();
            for (var i = 0; i < passes.Count; i++)
            {
                var pass = passes[i];
                var visible = KindOf(pass) != KindFavourite;
                var name = Json.Text(pass, "name");
                var peak = (int)(Json.Number(pass, "peakElevation") ?? 0);
                var tag = $"pass{i}";
                new ToastContentBuilder()
                    .AddArgument("pass", name)
                    .AddText(Strings.Get(visible ? "pass_alert_title" : "favourite_alert_title", name))
                    .AddText(Strings.Get(visible ? "pass_alert_text" : "favourite_alert_text",
                        Json.Text(pass, "riseDirection"), peak, Json.Text(pass, "setDirection")))
                    .Schedule(DateTimeOffset.FromUnixTimeMilliseconds(Rise(pass) - WarningMs), toast =>
                    {
                        toast.Tag = tag;
                        toast.Group = Group;
                    });
            }
        }
        catch (Exception e)
        {
            // Notifications turned off for the app, or no notification platform at all.
            App.Warn(Tag, "Couldn't schedule pass alerts", e);
        }
    }

    /** Whether Windows will show the app's notifications. */
    public static bool CanNotify()
    {
        try
        {
            return ToastNotificationManagerCompat.CreateToastNotifier().Setting == NotificationSetting.Enabled;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
