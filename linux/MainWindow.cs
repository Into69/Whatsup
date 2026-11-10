using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using static WhatsUp.Native;

namespace WhatsUp;

/**
 * The window: the globe page full size in a WebKitGTK view, and the settings page over it while
 * open (a GtkStack of the two). What happens around the pages is Host's (shared with Windows); this
 * is the window, its web views, and the requests to the pages' origin, whatsup://whatsup.invalid,
 * answered as a registered URI scheme.
 */
sealed unsafe class MainWindow
{
    const string LogTag = "MainWindow";
    const string Scheme = "whatsup";
    const string Origin = Scheme + "://" + Host.HostName;
    /** Which page a signal is from: its user data. */
    const int GlobePage = 1, SettingsPage = 2;

    /** The one window, for the static callbacks GTK calls. */
    static MainWindow? current;

    readonly LinuxHost host;
    readonly IntPtr window;
    readonly IntPtr stack;
    readonly IntPtr globe;
    IntPtr settingsView;
    int windowState;
    /** The window's size when last neither maximised nor full screen, to open at next time. */
    int width, height;

    public MainWindow()
    {
        current = this;
        host = new LinuxHost(this);
        var context = webkit_web_context_get_default();
        webkit_web_context_register_uri_scheme(context, Scheme, &OnSchemeRequest, 0, 0);
        // Secure, so the pages can use what browsers keep to https (location, among others), and
        // CORS-enabled, so they can fetch from their own origin.
        var security = webkit_web_context_get_security_manager(context);
        webkit_security_manager_register_uri_scheme_as_secure(security, Scheme);
        webkit_security_manager_register_uri_scheme_as_cors_enabled(security, Scheme);

        window = gtk_window_new(0);
        gtk_window_set_title(window, "WhatsUp");
        gtk_widget_set_size_request(window, 480, 400);
        RestoreWindow();
        Connect(window, "delete-event", (delegate* unmanaged<IntPtr, IntPtr, IntPtr, int>)&OnDelete, 0);
        Connect(window, "window-state-event", (delegate* unmanaged<IntPtr, IntPtr, IntPtr, int>)&OnWindowState, 0);
        Connect(window, "configure-event", (delegate* unmanaged<IntPtr, IntPtr, IntPtr, int>)&OnConfigure, 0);
        stack = gtk_stack_new();
        gtk_container_add(window, stack);

        // Stands in for the Android app's window.Android before the page's own scripts run.
        globe = NewView(GlobePage, Encoding.UTF8.GetString(App.Resource("desktop/bridge.js")!), new GdkRgba { Red = 0x05 / 255.0, Green = 0x07 / 255.0, Blue = 0x0d / 255.0, Alpha = 1 });
        Connect(globe, "load-changed", (delegate* unmanaged<IntPtr, int, IntPtr, void>)&OnLoadChanged, GlobePage);
        gtk_container_add(stack, globe);
        gtk_widget_show_all(window);
        webkit_web_view_load_uri(globe, $"{Origin}/assets/globe.html");
        gtk_widget_grab_focus(globe);
        host.Resume();
    }

    /** A web view for one of the pages: requests answered by Host, links out to the browser, calls to Host. */
    static IntPtr NewView(int page, string? script, GdkRgba background)
    {
        var content = webkit_user_content_manager_new();
        webkit_user_content_manager_register_script_message_handler(content, "whatsup");
        Connect(content, "script-message-received::whatsup", (delegate* unmanaged<IntPtr, IntPtr, IntPtr, void>)&OnScriptMessage, page);
        if (script != null) webkit_user_content_manager_add_script(content, webkit_user_script_new(script, 1, 0, 0, 0));
        var view = webkit_web_view_new_with_user_content_manager(content);
        webkit_web_view_set_background_color(view, background);
        var settings = webkit_web_view_get_settings(view);
        webkit_settings_set_enable_back_forward_navigation_gestures(settings, false);
        // The pages' console in the terminal the app was started from, if any.
        webkit_settings_set_enable_write_console_messages_to_stdout(settings, true);
#if DEBUG
        webkit_settings_set_enable_developer_extras(settings, true);
#else
        Connect(view, "context-menu", (delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, int>)&OnContextMenu, page);
#endif
        Connect(view, "decide-policy", (delegate* unmanaged<IntPtr, IntPtr, int, IntPtr, int>)&OnDecidePolicy, page);
        Connect(view, "permission-request", (delegate* unmanaged<IntPtr, IntPtr, IntPtr, int>)&OnPermissionRequest, page);
        return view;
    }

    static void Connect(IntPtr instance, string signal, void* handler, IntPtr data) =>
        g_signal_connect_data(instance, signal, (IntPtr)handler, data, 0, 0);

    // ---- GTK's calls (on its thread; an exception thrown back into GTK would end the app) ----

    static void Safely(string what, Action action)
    {
        try
        {
            action();
        }
        catch (Exception e)
        {
            App.Warn(LogTag, $"{what} failed: {e}");
        }
    }

    [UnmanagedCallersOnly]
    static void OnSchemeRequest(IntPtr request, IntPtr data)
    {
        g_object_ref(request);
        Safely("Request", () =>
        {
            var uri = new Uri(Text(webkit_uri_scheme_request_get_uri(request)));
            var path = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/'));
            if (uri.Host != Host.HostName)
            {
                Respond(request, null, "");
            }
            else if (path.StartsWith("data/", StringComparison.Ordinal))
            {
                // May need the network, so off this thread.
                Task.Run(() =>
                {
                    var body = current!.host.Data(path);
                    Dispatcher.Post(() => Respond(request, body, Host.ContentType(path)));
                });
            }
            else
            {
                Respond(request, Host.StaticFile(path), Host.ContentType(path));
            }
        });
    }

    /** Answers a request with the body, or 404 if null; releases the request. */
    static void Respond(IntPtr request, byte[]? body, string contentType)
    {
        var bytes = body ?? [];
        IntPtr glibBytes;
        fixed (byte* start = bytes) glibBytes = g_bytes_new(start, (nuint)bytes.Length);
        var stream = g_memory_input_stream_new_from_bytes(glibBytes);
        g_bytes_unref(glibBytes);
        var response = webkit_uri_scheme_response_new(stream, bytes.Length);
        if (body == null) webkit_uri_scheme_response_set_status(response, 404, "Not Found");
        else webkit_uri_scheme_response_set_content_type(response, contentType);
        webkit_uri_scheme_request_finish_with_response(request, response);
        g_object_unref(response);
        g_object_unref(stream);
        g_object_unref(request);
    }

    [UnmanagedCallersOnly]
    static void OnScriptMessage(IntPtr content, IntPtr result, IntPtr page) => Safely("Message", () =>
    {
        var json = jsc_value_to_json(webkit_javascript_result_get_js_value(result), 0);
        var text = Text(json);
        g_free(json);
        if (page == GlobePage) current!.host.OnGlobeMessage(text);
        else current!.host.OnSettingsMessage(text);
    });

    [UnmanagedCallersOnly]
    static void OnLoadChanged(IntPtr view, int loadEvent, IntPtr page)
    {
        // WEBKIT_LOAD_FINISHED.
        if (loadEvent == 3) Safely("Load", current!.host.OnPageFinished);
    }

    /** Only the app's own pages load here; links (e.g. in the map credits) open in the browser. */
    [UnmanagedCallersOnly]
    static int OnDecidePolicy(IntPtr view, IntPtr decision, int type, IntPtr page)
    {
        // Navigations and new windows; responses are left to WebKit.
        if (type is not (0 or 1)) return 0;
        var uri = Text(webkit_uri_request_get_uri(webkit_navigation_action_get_request(webkit_navigation_policy_decision_get_navigation_action(decision))));
        if (type == 0 && uri.StartsWith(Origin + "/", StringComparison.Ordinal)) return 0;
        webkit_policy_decision_ignore(decision);
        OpenInBrowser(uri);
        return 1;
    }

    /** The globe's location (desktop.watchLocation) only: sky view's camera is for a phone held up to the sky. */
    [UnmanagedCallersOnly]
    static int OnPermissionRequest(IntPtr view, IntPtr request, IntPtr page)
    {
        if (page == GlobePage && g_type_check_instance_is_a(request, webkit_geolocation_permission_request_get_type())) webkit_permission_request_allow(request);
        else webkit_permission_request_deny(request);
        return 1;
    }

    [UnmanagedCallersOnly]
    static int OnContextMenu(IntPtr view, IntPtr menu, IntPtr gdkEvent, IntPtr hit, IntPtr page) => 1;

    [UnmanagedCallersOnly]
    static int OnDelete(IntPtr widget, IntPtr gdkEvent, IntPtr data)
    {
        Safely("Close", current!.SaveWindow);
        gtk_main_quit();
        return 0;
    }

    [UnmanagedCallersOnly]
    static int OnWindowState(IntPtr widget, IntPtr gdkEvent, IntPtr data)
    {
        var self = current!;
        self.windowState = Marshal.ReadInt32(gdkEvent, WindowStateOffset);
        self.host.SetMinimised((self.windowState & WindowStateIconified) != 0);
        return 0;
    }

    [UnmanagedCallersOnly]
    static int OnConfigure(IntPtr widget, IntPtr gdkEvent, IntPtr data)
    {
        var self = current!;
        if ((self.windowState & (WindowStateMaximized | WindowStateFullscreen)) == 0)
        {
            gtk_window_get_size(self.window, out self.width, out self.height);
        }
        return 0;
    }

    static void OpenInBrowser(string url)
    {
        if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) return;
        try
        {
            Process.Start(new ProcessStartInfo("xdg-open", [url]) { UseShellExecute = false })?.Dispose();
        }
        catch (Exception e)
        {
            App.Warn(LogTag, $"No browser to open {url}", e);
        }
    }

    // ---- Host's calls ----

    void RunJs(string script) => webkit_web_view_run_javascript(globe, script, 0, 0, 0);

    void RunSettingsJs(string script)
    {
        if (settingsView != 0) webkit_web_view_run_javascript(settingsView, script, 0, 0, 0);
    }

    void ShowSettings()
    {
        if (settingsView == 0)
        {
            settingsView = NewView(SettingsPage, null, new GdkRgba { Red = 0x12 / 255.0, Green = 0x15 / 255.0, Blue = 0x1c / 255.0, Alpha = 1 });
            gtk_container_add(stack, settingsView);
            gtk_widget_show_all(settingsView);
        }
        // A fresh page each time, from the settings as they are now.
        webkit_web_view_load_uri(settingsView, $"{Origin}/desktop/settings.html");
        gtk_stack_set_visible_child(stack, settingsView);
        gtk_widget_grab_focus(settingsView);
    }

    void HideSettings()
    {
        gtk_stack_set_visible_child(stack, globe);
        gtk_widget_grab_focus(globe);
    }

    /** F11: the whole screen, for a desk or a projector at a star party. */
    void ToggleFullScreen()
    {
        if ((windowState & WindowStateFullscreen) != 0) gtk_window_unfullscreen(window);
        else gtk_window_fullscreen(window);
    }

    /** Brings the window forward: WhatsUp opened again. */
    public void Present() => gtk_window_present(window);

    /**
     * At first, most of the screen; then the size it was left at, maximised if it was. Where is left
     * to the window manager (which Wayland insists on anyway).
     */
    void RestoreWindow()
    {
        var display = gdk_display_get_default();
        var monitor = gdk_display_get_primary_monitor(display);
        if (monitor == 0) monitor = gdk_display_get_monitor(display, 0);
        var area = new GdkRectangle { Width = 1280, Height = 800 };
        if (monitor != 0) gdk_monitor_get_workarea(monitor, out area);
        (width, height) = (area.Width * 3 / 4, area.Height * 4 / 5);
        var parts = host.Settings.Window?.Split(',').Select(p => int.TryParse(p, out var n) ? n : int.MinValue).ToArray();
        var restored = parts is { Length: 5 } && parts[2] >= 200 && parts[3] >= 200;
        if (restored) (width, height) = (Math.Min(parts![2], area.Width), Math.Min(parts[3], area.Height));
        gtk_window_set_default_size(window, width, height);
        if (restored && parts![4] == 1) gtk_window_maximize(window);
    }

    void SaveWindow() =>
        host.Settings.Window = $"0,0,{width},{height},{((windowState & WindowStateMaximized) != 0 ? 1 : 0)}";

#if DEBUG
    public IntPtr Globe => globe;
    public IntPtr SettingsView => settingsView;
#endif

    /** Host, with this as its window. */
    sealed class LinuxHost(MainWindow window) : Host
    {
        public Settings Settings => settings;
        protected override void Post(Action action) => Dispatcher.Post(action);
        protected override void RunJs(string script) => window.RunJs(script);
        protected override void RunSettingsJs(string script) => window.RunSettingsJs(script);
        protected override void ShowSettingsView() => window.ShowSettings();
        protected override void HideSettingsView() => window.HideSettings();
        protected override void ToggleFullScreen() => window.ToggleFullScreen();

        /** Through the page's own location (WebKitGTK asks GeoClue): fixes come back as calls ("fix"). */
        bool locating;
        protected override void StartLocation()
        {
            locating = true;
            if (IsPageReady) RunJs("desktop.watchLocation(true)");
        }

        protected override void StopLocation()
        {
            locating = false;
            if (IsPageReady) RunJs("desktop.watchLocation(false)");
        }

        protected override void PageReady()
        {
            if (locating) RunJs("desktop.watchLocation(true)");
        }
    }
}

/** GTK's main loop as the place to run things: Host's posts, and await's continuations (Program sets it as the SynchronizationContext). */
sealed unsafe class Dispatcher : SynchronizationContext
{
    static readonly ConcurrentQueue<Action> queue = new();
    static int scheduled;

    public static void Post(Action action)
    {
        queue.Enqueue(action);
        if (Interlocked.Exchange(ref scheduled, 1) == 0) Native.g_idle_add(&Drain, 0);
    }

    [UnmanagedCallersOnly]
    static int Drain(IntPtr data)
    {
        Volatile.Write(ref scheduled, 0);
        while (queue.TryDequeue(out var action))
        {
            try
            {
                action();
            }
            catch (Exception e)
            {
                App.Warn("Dispatcher", e.ToString());
            }
        }
        // G_SOURCE_REMOVE: Post adds it again when there is more.
        return 0;
    }

    public override void Post(SendOrPostCallback callback, object? state) => Post(() => callback(state));

    public override void Send(SendOrPostCallback callback, object? state) => throw new NotSupportedException();

    public override SynchronizationContext CreateCopy() => this;
}
