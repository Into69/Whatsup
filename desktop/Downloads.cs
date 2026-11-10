namespace WhatsUp;

/** A download, as the progress panel shows it. TotalBytes is -1 when the server doesn't say. */
record Download(string File, long BytesRead, long TotalBytes, Download.States State)
{
    /** Waiting or under way. */
    public bool Active => State is States.Queued or States.Running;

    public enum States
    {
        /** Due to be fetched, after the ones ahead of it. */
        Queued,
        Running,
        Done,
        /** The server had nothing newer than the cached copy. */
        NotUpdated,
        /** The cached copy, if any, is used instead. */
        Failed,
    }
}

/** Every download in progress or lately ended, for the progress panel (MainForm.ShowDownloads). */
class DownloadTracker
{
    readonly object gate = new();
    /** Downloads since the last ClearFinished, by key, in the order they started. */
    List<KeyValuePair<string, Download>> downloads = [];

    /** With the downloads after each change, on whichever thread made it. */
    public event Action<IReadOnlyList<Download>>? Changed;

    public IReadOnlyList<Download> Downloads
    {
        get { lock (gate) return downloads.Select(d => d.Value).ToList(); }
    }

    void Update(Func<List<KeyValuePair<string, Download>>, List<KeyValuePair<string, Download>>> change)
    {
        IReadOnlyList<Download> now;
        lock (gate)
        {
            downloads = change(downloads);
            now = downloads.Select(d => d.Value).ToList();
        }
        Changed?.Invoke(now);
    }

    static List<KeyValuePair<string, Download>> Put(List<KeyValuePair<string, Download>> all, string key, Download download)
    {
        var i = all.FindIndex(d => d.Key == key);
        var copy = new List<KeyValuePair<string, Download>>(all);
        if (i >= 0) copy[i] = new(key, download); else copy.Add(new(key, download));
        return copy;
    }

    /** Forgets downloads that have ended, once the progress panel has shown how they went. */
    public void ClearFinished() => Update(all => all.Where(d => d.Value.Active).ToList());

    /** Adds the key to the queue, unless it is already there or under way. */
    public void Queue(string key, string name) => Update(all =>
        all.Any(d => d.Key == key && d.Value.Active) ? all : Put(all, key, new Download(name, 0, -1, Download.States.Queued)));

    /** Takes key off the queue if it is waiting there (every waiting key when null): it isn't needed after all. */
    public void Unqueue(string? key = null) => Update(all =>
        all.Where(d => !(d.Value.State == Download.States.Queued && (key == null || d.Key == key))).ToList());

    /** Updates the key's entry, keeping whatever isn't given. */
    public void Report(string key, string name, long? bytesRead = null, long? totalBytes = null, Download.States state = Download.States.Running) =>
        Update(all =>
        {
            var previous = all.FirstOrDefault(d => d.Key == key).Value ?? new Download(name, 0, -1, state);
            return Put(all, key, previous with
            {
                BytesRead = bytesRead ?? previous.BytesRead,
                TotalBytes = totalBytes ?? previous.TotalBytes,
                State = state,
            });
        });

    /**
     * Downloads url to file (through a temporary file, so a failed download leaves the old copy),
     * reporting progress under key as name. Blocking; call off the UI thread.
     */
    public void DownloadTo(string url, string file, string key, string name)
    {
        var partial = file + ".part";
        try
        {
            Report(key, name, bytesRead: 0, totalBytes: -1);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            using (var output = File.Create(partial))
            {
                Http.Get(url, output, readTimeoutMs: 60_000, onProgress: (read, total) => Report(key, name, read, total));
            }
            File.Move(partial, file, overwrite: true);
            Report(key, name, state: Download.States.Done);
        }
        catch (Exception)
        {
            File.Delete(partial);
            Report(key, name, state: Download.States.Failed);
            throw;
        }
    }
}
