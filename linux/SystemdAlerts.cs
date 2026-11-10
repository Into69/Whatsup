using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace WhatsUp;

/**
 * Pass alerts as desktop notifications (org.freedesktop.Notifications, sent with gdbus, which comes
 * with GLib), each at its time from a transient systemd user timer, so they come even with the app
 * closed, until the computer restarts (transient timers aren't kept). Without a systemd user
 * session, they are timers in the app instead, and come only while it is open.
 */
sealed class SystemdAlerts : IAlertScheduler
{
    const string Tag = "SystemdAlerts";
    /** The timers' unit names: whatsup-pass0.timer and so on. */
    const string UnitPrefix = "whatsup-pass";

    readonly List<Timer> inAppTimers = [];

    public void Schedule(IReadOnlyList<PassAlert> alerts)
    {
        lock (inAppTimers)
        {
            foreach (var timer in inAppTimers) timer.Dispose();
            inAppTimers.Clear();
        }
        // Those set last time (and any of them failed, which systemd would otherwise keep).
        Run("systemctl", "--user", "stop", $"{UnitPrefix}*.timer");
        Run("systemctl", "--user", "reset-failed", $"{UnitPrefix}*");
        var bus = Environment.GetEnvironmentVariable("DBUS_SESSION_BUS_ADDRESS");
        var systemd = true;
        foreach (var alert in alerts)
        {
            var at = DateTimeOffset.FromUnixTimeMilliseconds(alert.AtMs).UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " UTC";
            List<string> arguments = ["--user", "--quiet", "--collect", $"--unit={UnitPrefix}{alert.Index}", $"--on-calendar={at}", "--timer-property=AccuracySec=1s"];
            if (!string.IsNullOrEmpty(bus)) arguments.Add($"--setenv=DBUS_SESSION_BUS_ADDRESS={bus}");
            // systemd expands % and $ in the command, so those are doubled.
            arguments.AddRange(NotifyCommand(alert.Title, alert.Text).Select(a => a.Replace("%", "%%").Replace("$", "$$")));
            if (systemd && Run(["systemd-run", .. arguments])) continue;
            // No systemd user session: while the app is open, then.
            if (systemd) App.Warn(Tag, "No systemd user session: alerts only while WhatsUp is open");
            systemd = false;
            var wait = TimeSpan.FromMilliseconds(Math.Max(0, alert.AtMs - App.Now()));
            lock (inAppTimers) inAppTimers.Add(new Timer(_ => Run(NotifyCommand(alert.Title, alert.Text)), null, wait, Timeout.InfiniteTimeSpan));
        }
    }

    /** Whether there is a notification service on the session bus. */
    public bool CanNotify() => Run("gdbus", "call", "--session", "--dest", "org.freedesktop.Notifications",
        "--object-path", "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.GetServerInformation");

    /** gdbus's command line for Notify: app name, replaces, icon, summary, body, actions, hints, timeout. */
    static string[] NotifyCommand(string title, string text) =>
    [
        "/usr/bin/env", "gdbus", "call", "--session", "--dest", "org.freedesktop.Notifications",
        "--object-path", "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.Notify",
        "WhatsUp", "0", Variant(LinuxIcon.File), Variant(title), Variant(text), "[]", "{}",
        // Not "-1", which gdbus would take for an option.
        "int32 -1",
    ];

    /** A string as GVariant text, which is how gdbus reads its arguments. */
    static string Variant(string text)
    {
        var quoted = new StringBuilder("\"");
        foreach (var c in text)
        {
            quoted.Append(c switch
            {
                '"' => "\\\"",
                '\\' => "\\\\",
                '\n' => "\\n",
                _ => c.ToString(),
            });
        }
        return quoted.Append('"').ToString();
    }

    /** Runs a command and waits for it; whether it succeeded. */
    static bool Run(params string[] command)
    {
        try
        {
            var start = new ProcessStartInfo(command[0], command[1..])
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var process = Process.Start(start)!;
            process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(10_000)) return false;
            if (process.ExitCode != 0 && error.Length > 0) App.Warn(Tag, $"{command[0]}: {error.Trim()}");
            return process.ExitCode == 0;
        }
        catch (Exception e)
        {
            App.Warn(Tag, $"Couldn't run {command[0]}", e);
            return false;
        }
    }
}
