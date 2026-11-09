using Microsoft.Toolkit.Uwp.Notifications;

namespace WhatsUp;

static class Program
{
    [STAThread]
    static void Main()
    {
        // One window: opening WhatsUp again (or clicking a pass alert) brings the open one forward.
        using var single = new Mutex(true, @"Local\WhatsUp.Windows", out var first);
        if (!first)
        {
            BringOthersForward();
            return;
        }
        ApplicationConfiguration.Initialize();
        // Into whatsup.log, not a dialog: a failed download or lookup is no reason to stop.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => App.Warn("Unhandled", e.Exception.ToString());
        AppDomain.CurrentDomain.UnhandledException += (_, e) => App.Warn("Unhandled", e.ExceptionObject.ToString() ?? "");
        var form = new MainForm();
        // A pass alert clicked while the app is open.
        ToastNotificationManagerCompat.OnActivated += _ =>
        {
            if (!form.IsHandleCreated) return;
            form.BeginInvoke(() =>
            {
                if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
                form.Activate();
            });
        };
        Application.Run(form);
    }

    static void BringOthersForward()
    {
        var me = System.Diagnostics.Process.GetCurrentProcess();
        foreach (var other in System.Diagnostics.Process.GetProcessesByName(me.ProcessName))
        {
            if (other.Id == me.Id || other.MainWindowHandle == IntPtr.Zero) continue;
            ShowWindow(other.MainWindowHandle, 9 /* SW_RESTORE */);
            SetForegroundWindow(other.MainWindowHandle);
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr window, int command);
}
