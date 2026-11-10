#if DEBUG
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using static WhatsUp.Native;

namespace WhatsUp;

/**
 * Debug builds only, and only with WHATSUP_TEST_PORT set: a line-based JSON socket on 127.0.0.1 for
 * driving the app in tests, as Edge's DevTools port does for the Windows one. Each line is
 * {"page": "globe" or "settings", "run": "<function body, may await>"}, answered with
 * {"value": ...} or {"error": "..."}; or {"page": ..., "shot": "/path.png"}, answered {"value": true}.
 */
static partial class TestHook
{
    static MainWindow? window;
    static readonly ConcurrentDictionary<int, TaskCompletionSource<JsonNode?>> pending = new();
    static int next;

    public static void Start(MainWindow mainWindow)
    {
        if (!int.TryParse(Environment.GetEnvironmentVariable("WHATSUP_TEST_PORT"), out var port)) return;
        window = mainWindow;
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        _ = Task.Run(async () =>
        {
            while (true) _ = Serve(await listener.AcceptTcpClientAsync());
        });
    }

    static async Task Serve(TcpClient client)
    {
        using (client)
        {
            var stream = client.GetStream();
            var reader = new StreamReader(stream);
            while (await reader.ReadLineAsync() is { } line)
            {
                JsonObject reply;
                try
                {
                    reply = new JsonObject { ["value"] = await Handle(JsonNode.Parse(line)!.AsObject()) };
                }
                catch (Exception e)
                {
                    reply = new JsonObject { ["error"] = e.Message };
                }
                await stream.WriteAsync(Encoding.UTF8.GetBytes(reply.ToJsonString() + "\n"));
            }
        }
    }

    static Task<JsonNode?> Handle(JsonObject request)
    {
        var id = Interlocked.Increment(ref next);
        var done = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = done;
        var settings = (string?)request["page"] == "settings";
        Dispatcher.Post(() => Begin(id, settings ? window!.SettingsView : window!.Globe, request));
        return done.Task;
    }

    static unsafe void Begin(int id, IntPtr view, JsonObject request)
    {
        if (view == 0)
        {
            Finish(id, null, "No such page open");
        }
        else if (request["shot"] is { } shot)
        {
            shots[id] = (string)shot!;
            webkit_web_view_get_snapshot(view, 0, 0, 0, &OnSnapshot, id);
        }
        else
        {
            webkit_web_view_call_async_javascript_function(view, (string)request["run"]!, -1, 0, 0, 0, 0, &OnRun, id);
        }
    }

    static readonly ConcurrentDictionary<int, string> shots = new();

    static void Finish(int id, JsonNode? value, string? error)
    {
        if (!pending.TryRemove(id, out var done)) return;
        if (error != null) done.SetException(new Exception(error));
        else done.SetResult(value);
    }

    static string ErrorText(IntPtr error)
    {
        // GError: domain, code, then the message.
        var text = Text(Marshal.ReadIntPtr(error, 8));
        g_error_free(error);
        return text;
    }

    [UnmanagedCallersOnly]
    static void OnRun(IntPtr view, IntPtr result, IntPtr data)
    {
        var value = webkit_web_view_call_async_javascript_function_finish(view, result, out var error);
        if (value == 0)
        {
            Finish((int)data, null, ErrorText(error));
            return;
        }
        var json = jsc_value_to_json(value, 0);
        var text = json == 0 ? "null" : Text(json);
        if (json != 0) g_free(json);
        g_object_unref(value);
        Finish((int)data, JsonNode.Parse(text), null);
    }

    [UnmanagedCallersOnly]
    static void OnSnapshot(IntPtr view, IntPtr result, IntPtr data)
    {
        var surface = webkit_web_view_get_snapshot_finish(view, result, out var error);
        shots.TryRemove((int)data, out var path);
        if (surface == 0)
        {
            Finish((int)data, null, ErrorText(error));
            return;
        }
        var status = cairo_surface_write_to_png(surface, path!);
        cairo_surface_destroy(surface);
        Finish((int)data, status == 0, status == 0 ? null : $"cairo status {status}");
    }

    [LibraryImport("webkit")]
    private static unsafe partial void webkit_web_view_call_async_javascript_function(IntPtr view, [MarshalAs(UnmanagedType.LPUTF8Str)] string body, nint length,
        IntPtr arguments, IntPtr world, IntPtr sourceUri, IntPtr cancellable, delegate* unmanaged<IntPtr, IntPtr, IntPtr, void> callback, IntPtr data);

    [LibraryImport("webkit")]
    private static partial IntPtr webkit_web_view_call_async_javascript_function_finish(IntPtr view, IntPtr result, out IntPtr error);

    [LibraryImport("webkit")]
    private static unsafe partial void webkit_web_view_get_snapshot(IntPtr view, int region, int options, IntPtr cancellable,
        delegate* unmanaged<IntPtr, IntPtr, IntPtr, void> callback, IntPtr data);

    [LibraryImport("webkit")]
    private static partial IntPtr webkit_web_view_get_snapshot_finish(IntPtr view, IntPtr result, out IntPtr error);

    [LibraryImport("libcairo.so.2", StringMarshalling = StringMarshalling.Utf8)]
    private static partial int cairo_surface_write_to_png(IntPtr surface, string file);

    [LibraryImport("libcairo.so.2")]
    private static partial void cairo_surface_destroy(IntPtr surface);

    [LibraryImport("libglib-2.0.so.0")]
    private static partial void g_error_free(IntPtr error);
}
#endif
