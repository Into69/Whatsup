using System.Diagnostics;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WhatsUp;

/**
 * The window: the globe page full size in a WebView2, and the settings page over it while open. What
 * happens around the pages is Host's (shared with Linux); this is the window, its web views and
 * Windows' location.
 */
sealed class MainForm : Form
{
    const string LogTag = "MainForm";
    const string Origin = "https://" + Host.HostName;

    readonly WindowsHost host;
    readonly LocationTracker tracker;
    readonly WebView2 globe = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(0x05, 0x07, 0x0d) };
    WebView2? settingsView;
    CoreWebView2Environment? environment;

    FormWindowState windowStateBeforeFullScreen = FormWindowState.Normal;
    bool fullScreen;

    public MainForm()
    {
        Text = "WhatsUp";
        Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
        BackColor = Color.FromArgb(0x05, 0x07, 0x0d);
        MinimumSize = new Size(480, 400);
        host = new WindowsHost(this);
        RestoreWindow();
        tracker = new LocationTracker(fix => BeginInvoke(() => host.Fixed(fix)), () => BeginInvoke(host.Denied));
        Controls.Add(globe);
        Resize += (_, _) => host.SetMinimised(WindowState == FormWindowState.Minimized);
        FormClosing += (_, _) => SaveWindow();
        Load += async (_, _) => await Start();
    }

    async Task Start()
    {
        try
        {
            environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(App.DataDir, "WebView2"));
            await globe.EnsureCoreWebView2Async(environment);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this, "WhatsUp needs Microsoft Edge WebView2, which comes with Windows 11. " +
                "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and open WhatsUp again.",
                "WhatsUp", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }
        var web = globe.CoreWebView2;
        Configure(web);
        // Stands in for the Android app's window.Android before the page's own scripts run.
        await web.AddScriptToExecuteOnDocumentCreatedAsync(Encoding.UTF8.GetString(App.Resource("desktop/bridge.js")!));
        web.WebMessageReceived += (_, e) => host.OnGlobeMessage(e.WebMessageAsJson);
        web.NavigationCompleted += (_, e) =>
        {
            if (e.IsSuccess) host.OnPageFinished();
        };
        web.Navigate($"{Origin}/assets/globe.html");
        host.Resume();
    }

    /** What both pages share: requests answered by Host, links out to the browser, no camera. */
    void Configure(CoreWebView2 web)
    {
        web.Settings.IsStatusBarEnabled = false;
        web.Settings.IsZoomControlEnabled = false;
        web.Settings.AreDefaultContextMenusEnabled = false;
        web.Settings.IsGeneralAutofillEnabled = false;
        web.Settings.IsPasswordAutosaveEnabled = false;
#if !DEBUG
        web.Settings.AreDevToolsEnabled = false;
        web.Settings.AreBrowserAcceleratorKeysEnabled = false;
#endif
        web.AddWebResourceRequestedFilter($"{Origin}/*", CoreWebView2WebResourceContext.All);
        web.WebResourceRequested += Serve;
        // Only the app's own pages load here; links (e.g. in the map credits) open in the browser.
        web.NavigationStarting += (_, e) =>
        {
            if (new Uri(e.Uri).Host == Host.HostName) return;
            e.Cancel = true;
            OpenInBrowser(e.Uri);
        };
        web.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenInBrowser(e.Uri);
        };
        // Sky view's camera is for a phone held up to the sky.
        web.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
    }

    static void OpenInBrowser(string url)
    {
        if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) return;
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception e)
        {
            App.Warn(LogTag, $"No browser to open {url}", e);
        }
    }

    /** Every request to the pages' origin; data/ may need the network, so off this thread. */
    void Serve(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var path = Uri.UnescapeDataString(new Uri(e.Request.Uri).AbsolutePath.TrimStart('/'));
        if (path.StartsWith("data/", StringComparison.Ordinal))
        {
            var deferral = e.GetDeferral();
            Task.Run(() =>
            {
                var data = host.Data(path);
                BeginInvoke(() =>
                {
                    e.Response = Response(data, Host.ContentType(path));
                    deferral.Complete();
                });
            });
            return;
        }
        e.Response = Response(Host.StaticFile(path), Host.ContentType(path));
    }

    CoreWebView2WebResourceResponse Response(byte[]? body, string contentType) => body == null
        ? environment!.CreateWebResourceResponse(null, 404, "Not Found", "")
        : environment!.CreateWebResourceResponse(new MemoryStream(body), 200, "OK",
            $"Content-Type: {contentType}\r\nCache-Control: no-store");

    void RunJs(string script)
    {
        if (globe.CoreWebView2 != null) _ = globe.CoreWebView2.ExecuteScriptAsync(script);
    }

    void RunSettingsJs(string script) => settingsView?.CoreWebView2?.ExecuteScriptAsync(script);

    async void ShowSettings()
    {
        if (settingsView == null)
        {
            var view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(0x12, 0x15, 0x1c), Visible = false };
            Controls.Add(view);
            settingsView = view;
            await view.EnsureCoreWebView2Async(environment);
            Configure(view.CoreWebView2);
            view.CoreWebView2.WebMessageReceived += (_, e) => host.OnSettingsMessage(e.WebMessageAsJson);
        }
        // A fresh page each time, from the settings as they are now.
        settingsView.CoreWebView2.Navigate($"{Origin}/desktop/settings.html");
        settingsView.Visible = true;
        settingsView.BringToFront();
        settingsView.Focus();
    }

    void HideSettings()
    {
        if (settingsView == null) return;
        settingsView.Visible = false;
        globe.Focus();
    }

    // ---- The window ----

    /** F11: the whole screen, for a desk or a projector at a star party. */
    void ToggleFullScreen()
    {
        fullScreen = !fullScreen;
        if (fullScreen)
        {
            windowStateBeforeFullScreen = WindowState;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Normal;
            WindowState = FormWindowState.Maximized;
        }
        else
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            WindowState = windowStateBeforeFullScreen;
        }
    }

    void RestoreWindow()
    {
        // At first, most of the screen, centred: in pixels, so as big on a high-DPI screen as any other.
        StartPosition = FormStartPosition.CenterScreen;
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        Size = new Size(area.Width * 3 / 4, area.Height * 4 / 5);
        var parts = host.Settings.Window?.Split(',').Select(p => int.TryParse(p, out var n) ? n : int.MinValue).ToArray();
        if (parts is not { Length: 5 } || parts.Any(p => p == int.MinValue)) return;
        var bounds = new Rectangle(parts[0], parts[1], parts[2], parts[3]);
        // Only where a screen still is: a monitor may have been unplugged since.
        if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(bounds)) || bounds.Width < 200 || bounds.Height < 200) return;
        StartPosition = FormStartPosition.Manual;
        Bounds = bounds;
        if (parts[4] == 1) WindowState = FormWindowState.Maximized;
    }

    void SaveWindow()
    {
        if (fullScreen) return;
        var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        host.Settings.Window = $"{bounds.X},{bounds.Y},{bounds.Width},{bounds.Height},{(WindowState == FormWindowState.Maximized ? 1 : 0)}";
    }

    /** Host, with the form as its window. */
    sealed class WindowsHost(MainForm form) : Host
    {
        public Settings Settings => settings;
        public void Fixed(Fix fix) => OnFix(fix);
        public void Denied() => OnLocationDenied();
        protected override void Post(Action action)
        {
            if (form.IsHandleCreated && !form.IsDisposed) form.BeginInvoke(action);
        }
        protected override void RunJs(string script) => form.RunJs(script);
        protected override void RunSettingsJs(string script) => form.RunSettingsJs(script);
        protected override void ShowSettingsView() => form.ShowSettings();
        protected override void HideSettingsView() => form.HideSettings();
        protected override void ToggleFullScreen() => form.ToggleFullScreen();
        protected override void StartLocation() => form.tracker.Start();
        protected override void StopLocation() => form.tracker.Stop();
        protected override void Quit() => form.Close();
    }
}
