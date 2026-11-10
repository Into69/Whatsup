using Microsoft.Toolkit.Uwp.Notifications;
using Windows.UI.Notifications;

namespace WhatsUp;

/** Pass alerts as scheduled Windows notifications, which Windows shows at their time even with the app closed. */
sealed class WindowsAlerts : IAlertScheduler
{
    /** The scheduled notifications' group, so only this app's passes are cleared when rescheduling. */
    const string Group = "passes";

    public void Schedule(IReadOnlyList<PassAlert> alerts)
    {
        var notifier = ToastNotificationManagerCompat.CreateToastNotifier();
        foreach (var scheduled in notifier.GetScheduledToastNotifications())
        {
            if (scheduled.Group == Group) notifier.RemoveFromSchedule(scheduled);
        }
        foreach (var alert in alerts)
        {
            new ToastContentBuilder()
                .AddArgument("pass", alert.Index)
                .AddText(alert.Title)
                .AddText(alert.Text)
                .Schedule(DateTimeOffset.FromUnixTimeMilliseconds(alert.AtMs), toast =>
                {
                    toast.Tag = $"pass{alert.Index}";
                    toast.Group = Group;
                });
        }
    }

    public bool CanNotify() => ToastNotificationManagerCompat.CreateToastNotifier().Setting == NotificationSetting.Enabled;
}
