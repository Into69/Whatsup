package dev.whatsup.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** A download, as the progress panel shows it. [totalBytes] is -1 when the server doesn't say. */
data class Download(val file: String, val bytesRead: Long, val totalBytes: Long, val state: State) {
    /** Waiting or under way. */
    val active: Boolean get() = state == State.QUEUED || state == State.RUNNING

    enum class State {
        /** Due to be fetched, after the ones ahead of it. */
        QUEUED,
        RUNNING,
        DONE,
        /** The server had nothing newer than the cached copy. */
        NOT_UPDATED,
        /** The cached copy, if any, is used instead. */
        FAILED,
    }
}

/** Every download in progress or lately ended, for MainActivity's progress panel. */
class DownloadTracker {
    private val _downloads = MutableStateFlow<Map<String, Download>>(emptyMap())
    /** Downloads since the last [clearFinished], by key, in the order they started. */
    val downloads: StateFlow<Map<String, Download>> = _downloads

    /** Forgets downloads that have ended, once the progress panel has shown how they went. */
    fun clearFinished() = _downloads.update { all -> all.filterValues { it.active } }

    /** Adds the key to the queue, unless it is already there or under way. */
    fun queue(key: String, name: String) = _downloads.update { all ->
        if (all[key]?.active == true) all else all + (key to Download(name, 0, -1, Download.State.QUEUED))
    }

    /** Takes [key] off the queue if it is waiting there (every waiting key when null): it isn't needed after all. */
    fun unqueue(key: String? = null) = _downloads.update { all ->
        all.filterNot { (k, download) -> download.state == Download.State.QUEUED && (key == null || k == key) }
    }

    /** Updates the key's entry, keeping whatever isn't given. */
    fun report(
        key: String,
        name: String,
        bytesRead: Long? = null,
        totalBytes: Long? = null,
        state: Download.State = Download.State.RUNNING,
    ) = _downloads.update { all ->
        val previous = all[key] ?: Download(name, 0, -1, state)
        all + (key to previous.copy(
            bytesRead = bytesRead ?: previous.bytesRead,
            totalBytes = totalBytes ?: previous.totalBytes,
            state = state,
        ))
    }

    /**
     * Downloads [url] to [file] (through a temporary file, so a failed download leaves the old copy),
     * reporting progress under [key] as [name]. Blocking; call off the main thread.
     */
    fun downloadTo(url: String, file: File, key: String, name: String) {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("User-Agent", USER_AGENT)
        val partial = File(file.path + ".part")
        try {
            report(key, name, bytesRead = 0, totalBytes = -1)
            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) throw IOException("HTTP $code")
            val total = connection.contentLengthLong
            file.parentFile?.mkdirs()
            var read = 0L
            var lastReport = 0L
            connection.inputStream.use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        output.write(buffer, 0, n)
                        read += n
                        if (read - lastReport >= REPORT_EVERY_BYTES) {
                            lastReport = read
                            report(key, name, bytesRead = read, totalBytes = total)
                        }
                    }
                }
            }
            if (!partial.renameTo(file)) throw IOException("Couldn't replace $file")
            report(key, name, bytesRead = read, totalBytes = total, state = Download.State.DONE)
        } catch (e: Exception) {
            partial.delete()
            report(key, name, state = Download.State.FAILED)
            throw e
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        const val REPORT_EVERY_BYTES = 32 * 1024L
    }
}
