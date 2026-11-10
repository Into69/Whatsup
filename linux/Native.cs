using System.Reflection;
using System.Runtime.InteropServices;

namespace WhatsUp;

/**
 * The few GLib, GTK 3 and WebKitGTK calls the window needs, bound by hand: they come with every
 * desktop that has WebKitGTK, so nothing native ships in the app. WebKitGTK is 4.1 (libsoup 3),
 * else 4.0, from 2.36 on (for WebKitURISchemeResponse).
 */
static partial class Native
{
    const string GLib = "libglib-2.0.so.0";
    const string GObject = "libgobject-2.0.so.0";
    const string Gio = "libgio-2.0.so.0";
    const string Gtk = "libgtk-3.so.0";
    const string Gdk = "libgdk-3.so.0";
    const string WebKit = "webkit";
    const string JavaScriptCore = "javascriptcore";

    static readonly string[] WebKitNames = ["libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.0.so.37"];
    static readonly string[] JavaScriptCoreNames = ["libjavascriptcoregtk-4.1.so.0", "libjavascriptcoregtk-4.0.so.18"];

    /** Finds WebKitGTK; false if neither version is installed. */
    public static bool Load()
    {
        IntPtr webKit = 0, javaScriptCore = 0;
        for (var i = 0; i < WebKitNames.Length && webKit == 0; i++)
        {
            if (NativeLibrary.TryLoad(WebKitNames[i], out webKit)) NativeLibrary.TryLoad(JavaScriptCoreNames[i], out javaScriptCore);
        }
        if (webKit == 0 || javaScriptCore == 0) return false;
        NativeLibrary.SetDllImportResolver(Assembly.GetExecutingAssembly(), (name, _, _) => name switch
        {
            WebKit => webKit,
            JavaScriptCore => javaScriptCore,
            _ => 0,
        });
        return true;
    }

    // ---- GLib and GObject ----

    [LibraryImport(GLib, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void g_set_prgname(string name);

    [LibraryImport(GLib, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void g_set_application_name(string name);

    [LibraryImport(GLib)]
    public static unsafe partial uint g_idle_add(delegate* unmanaged<IntPtr, int> function, IntPtr data);

    [LibraryImport(GLib)]
    public static partial void g_free(IntPtr memory);

    [LibraryImport(GLib)]
    public static unsafe partial IntPtr g_bytes_new(byte* data, nuint size);

    [LibraryImport(GLib)]
    public static partial void g_bytes_unref(IntPtr bytes);

    [LibraryImport(GObject)]
    public static partial IntPtr g_object_ref(IntPtr instance);

    [LibraryImport(GObject)]
    public static partial void g_object_unref(IntPtr instance);

    [LibraryImport(GObject, StringMarshalling = StringMarshalling.Utf8)]
    public static partial ulong g_signal_connect_data(IntPtr instance, string signal, IntPtr handler, IntPtr data, IntPtr destroy, int flags);

    [LibraryImport(GObject)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool g_type_check_instance_is_a(IntPtr instance, nuint type);

    [LibraryImport(Gio)]
    public static partial IntPtr g_memory_input_stream_new_from_bytes(IntPtr bytes);

    // ---- GTK and GDK ----

    [LibraryImport(Gtk)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool gtk_init_check(IntPtr argc, IntPtr argv);

    [LibraryImport(Gtk)]
    public static partial void gtk_main();

    [LibraryImport(Gtk)]
    public static partial void gtk_main_quit();

    [LibraryImport(Gtk)]
    public static partial IntPtr gtk_window_new(int type);

    [LibraryImport(Gtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void gtk_window_set_title(IntPtr window, string title);

    [LibraryImport(Gtk, StringMarshalling = StringMarshalling.Utf8)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool gtk_window_set_default_icon_from_file(string file, IntPtr error);

    [LibraryImport(Gtk)]
    public static partial void gtk_window_set_default_size(IntPtr window, int width, int height);

    [LibraryImport(Gtk)]
    public static partial void gtk_window_get_size(IntPtr window, out int width, out int height);

    [LibraryImport(Gtk)]
    public static partial void gtk_window_maximize(IntPtr window);

    [LibraryImport(Gtk)]
    public static partial void gtk_window_fullscreen(IntPtr window);

    [LibraryImport(Gtk)]
    public static partial void gtk_window_unfullscreen(IntPtr window);

    [LibraryImport(Gtk)]
    public static partial void gtk_window_present(IntPtr window);

    [LibraryImport(Gtk)]
    public static partial void gtk_widget_set_size_request(IntPtr widget, int width, int height);

    [LibraryImport(Gtk)]
    public static partial void gtk_widget_show_all(IntPtr widget);

    [LibraryImport(Gtk)]
    public static partial void gtk_widget_grab_focus(IntPtr widget);

    [LibraryImport(Gtk)]
    public static partial void gtk_container_add(IntPtr container, IntPtr widget);

    [LibraryImport(Gtk)]
    public static partial IntPtr gtk_stack_new();

    [LibraryImport(Gtk)]
    public static partial void gtk_stack_set_visible_child(IntPtr stack, IntPtr child);

    /** A message box with an OK button: the text is a printf format, so % must come doubled. */
    [LibraryImport(Gtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial IntPtr gtk_message_dialog_new(IntPtr parent, int flags, int type, int buttons, string format);

    [LibraryImport(Gtk)]
    public static partial int gtk_dialog_run(IntPtr dialog);

    [LibraryImport(Gdk)]
    public static partial IntPtr gdk_display_get_default();

    [LibraryImport(Gdk)]
    public static partial IntPtr gdk_display_get_primary_monitor(IntPtr display);

    [LibraryImport(Gdk)]
    public static partial IntPtr gdk_display_get_monitor(IntPtr display, int index);

    [LibraryImport(Gdk)]
    public static partial void gdk_monitor_get_workarea(IntPtr monitor, out GdkRectangle area);

    [StructLayout(LayoutKind.Sequential)]
    public struct GdkRectangle
    {
        public int X, Y, Width, Height;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GdkRgba
    {
        public double Red, Green, Blue, Alpha;
    }

    /** GdkEventWindowState's new_window_state, after its type, window, send_event and changed_mask. */
    public const int WindowStateOffset = 24;
    public const int WindowStateIconified = 1 << 1;
    public const int WindowStateMaximized = 1 << 2;
    public const int WindowStateFullscreen = 1 << 4;

    // ---- WebKitGTK ----

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_web_context_get_default();

    [LibraryImport(WebKit, StringMarshalling = StringMarshalling.Utf8)]
    public static unsafe partial void webkit_web_context_register_uri_scheme(IntPtr context, string scheme,
        delegate* unmanaged<IntPtr, IntPtr, void> callback, IntPtr data, IntPtr destroy);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_web_context_get_security_manager(IntPtr context);

    [LibraryImport(WebKit, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void webkit_security_manager_register_uri_scheme_as_secure(IntPtr manager, string scheme);

    [LibraryImport(WebKit, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void webkit_security_manager_register_uri_scheme_as_cors_enabled(IntPtr manager, string scheme);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_user_content_manager_new();

    [LibraryImport(WebKit, StringMarshalling = StringMarshalling.Utf8)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool webkit_user_content_manager_register_script_message_handler(IntPtr manager, string name);

    [LibraryImport(WebKit)]
    public static partial void webkit_user_content_manager_add_script(IntPtr manager, IntPtr script);

    /** Into the top frame (1), at the document's start (0). */
    [LibraryImport(WebKit, StringMarshalling = StringMarshalling.Utf8)]
    public static partial IntPtr webkit_user_script_new(string source, int frames, int time, IntPtr allowList, IntPtr blockList);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_javascript_result_get_js_value(IntPtr result);

    [LibraryImport(JavaScriptCore)]
    public static partial IntPtr jsc_value_to_json(IntPtr value, uint indent);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_web_view_new_with_user_content_manager(IntPtr manager);

    [LibraryImport(WebKit, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void webkit_web_view_load_uri(IntPtr view, string uri);

    [LibraryImport(WebKit, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void webkit_web_view_run_javascript(IntPtr view, string script, IntPtr cancellable, IntPtr callback, IntPtr data);

    [LibraryImport(WebKit)]
    public static partial void webkit_web_view_set_background_color(IntPtr view, in GdkRgba color);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_web_view_get_settings(IntPtr view);

    [LibraryImport(WebKit)]
    public static partial void webkit_settings_set_enable_developer_extras(IntPtr settings, [MarshalAs(UnmanagedType.Bool)] bool on);

    [LibraryImport(WebKit)]
    public static partial void webkit_settings_set_enable_write_console_messages_to_stdout(IntPtr settings, [MarshalAs(UnmanagedType.Bool)] bool on);

    [LibraryImport(WebKit)]
    public static partial void webkit_settings_set_enable_back_forward_navigation_gestures(IntPtr settings, [MarshalAs(UnmanagedType.Bool)] bool on);

    [LibraryImport(WebKit)]
    public static partial void webkit_settings_set_hardware_acceleration_policy(IntPtr settings, int policy);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_uri_scheme_request_get_uri(IntPtr request);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_uri_scheme_response_new(IntPtr stream, long length);

    [LibraryImport(WebKit, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void webkit_uri_scheme_response_set_status(IntPtr response, uint status, string reason);

    [LibraryImport(WebKit, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void webkit_uri_scheme_response_set_content_type(IntPtr response, string contentType);

    [LibraryImport(WebKit)]
    public static partial void webkit_uri_scheme_request_finish_with_response(IntPtr request, IntPtr response);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_navigation_policy_decision_get_navigation_action(IntPtr decision);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_navigation_action_get_request(IntPtr action);

    [LibraryImport(WebKit)]
    public static partial IntPtr webkit_uri_request_get_uri(IntPtr request);

    [LibraryImport(WebKit)]
    public static partial void webkit_policy_decision_ignore(IntPtr decision);

    [LibraryImport(WebKit)]
    public static partial nuint webkit_geolocation_permission_request_get_type();

    [LibraryImport(WebKit)]
    public static partial void webkit_permission_request_allow(IntPtr request);

    [LibraryImport(WebKit)]
    public static partial void webkit_permission_request_deny(IntPtr request);

    /** A UTF-8 string GLib owns, as a .NET one. */
    public static string Text(IntPtr utf8) => Marshal.PtrToStringUTF8(utf8) ?? "";
}
