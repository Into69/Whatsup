using System.Net.Sockets;
using static WhatsUp.Native;

namespace WhatsUp;

static class Program
{
    static int Main()
    {
        // Into whatsup.log: a failed download or lookup is no reason to stop.
        AppDomain.CurrentDomain.UnhandledException += (_, e) => App.Warn("Unhandled", e.ExceptionObject.ToString() ?? "");
        TaskScheduler.UnobservedTaskException += (_, e) => App.Warn("Unhandled", e.Exception.ToString());
        Strings.Platform = LinuxText.Strings;
        PassAlerts.Scheduler = new SystemdAlerts();
        // After an update: the old version first ends.
        Updates.AfterRestart(Environment.GetCommandLineArgs());
        // One window: opening WhatsUp again brings the open one forward.
        if (Instance.TellOther()) return 0;
        WorkAroundWsl();
        g_set_prgname("whatsup");
        g_set_application_name("WhatsUp");
        if (!gtk_init_check(0, 0))
        {
            Console.Error.WriteLine("WhatsUp needs a graphical desktop (no display to open its window on).");
            return 1;
        }
        if (!Native.Load())
        {
            Fail("WhatsUp needs WebKitGTK (4.1 or 4.0), which isn't installed. On Debian and Ubuntu: " +
                "sudo apt install libwebkit2gtk-4.1-0. On Fedora: sudo dnf install webkit2gtk4.1. " +
                "On Arch: sudo pacman -S webkit2gtk-4.1. Then open WhatsUp again.");
            return 1;
        }
        LinuxIcon.Install();
        gtk_window_set_default_icon_from_file(LinuxIcon.File, 0);
        SynchronizationContext.SetSynchronizationContext(new Dispatcher());
        var window = new MainWindow();
        Instance.Listen(() => Dispatcher.Post(window.Present));
#if DEBUG
        TestHook.Start(window);
#endif
        gtk_main();
        return 0;
    }

    /**
     * WSL's GPU passthrough (Mesa's d3d12 driver) draws WebKit's WebGL blank: the globe stays black.
     * There, Mesa's software renderer, set before WebKit starts its processes (which read it).
     */
    static void WorkAroundWsl()
    {
        try
        {
            if (Environment.GetEnvironmentVariable("LIBGL_ALWAYS_SOFTWARE") != null) return;
            if (!File.ReadAllText("/proc/version").Contains("microsoft", StringComparison.OrdinalIgnoreCase)) return;
            setenv("LIBGL_ALWAYS_SOFTWARE", "1", 1);
        }
        catch (IOException) { }
    }

    [System.Runtime.InteropServices.DllImport("libc", CharSet = System.Runtime.InteropServices.CharSet.Ansi)]
    static extern int setenv(string name, string value, int overwrite);

    static void Fail(string message)
    {
        Console.Error.WriteLine(message);
        // GTK_MESSAGE_ERROR, GTK_BUTTONS_OK.
        var dialog = gtk_message_dialog_new(0, 0, 3, 1, message.Replace("%", "%%"));
        gtk_window_set_title(dialog, "WhatsUp");
        gtk_dialog_run(dialog);
    }
}

/** The one running WhatsUp: a Unix socket in its data folder, which a second one tells to come forward. */
static class Instance
{
    static readonly string path = Path.Combine(App.DataDir, "instance.sock");

    /** Whether another WhatsUp is running, now told to show itself. */
    public static bool TellOther()
    {
        try
        {
            using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            socket.Connect(new UnixDomainSocketEndPoint(path));
            socket.Send("show\n"u8);
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    public static void Listen(Action show)
    {
        try
        {
            Directory.CreateDirectory(App.DataDir);
            // Left by one that didn't close cleanly.
            File.Delete(path);
            var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            listener.Bind(new UnixDomainSocketEndPoint(path));
            listener.Listen();
            new Thread(() =>
            {
                while (true)
                {
                    using var other = listener.Accept();
                    show();
                }
            }) { IsBackground = true, Name = "Instance" }.Start();
        }
        catch (Exception e)
        {
            App.Warn("Instance", "Can't listen for another WhatsUp", e);
        }
    }
}

/** The app's icon, as a file: for the window, and for notifications, which want one by path. */
static class LinuxIcon
{
    public static readonly string File = Path.Combine(App.DataDir, "whatsup.png");

    public static void Install()
    {
        try
        {
            var icon = App.Resource("linux/whatsup.png")!;
            Directory.CreateDirectory(App.DataDir);
            if (!System.IO.File.Exists(File) || new FileInfo(File).Length != icon.Length) System.IO.File.WriteAllBytes(File, icon);
        }
        catch (IOException e)
        {
            App.Warn("LinuxIcon", "Couldn't write the icon", e);
        }
    }
}
