package dev.whatsup.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * One real map tile per tile set, for the map style cards in settings: zoom 2 over the North
 * Atlantic, eastern North America and western Europe. Kept on disk, so each is fetched once.
 */
object TilePreviews {
    private const val Z = 2
    private const val X = 1
    private const val Y = 1

    suspend fun load(context: Context, tileSet: TileSet): Bitmap? = withContext(Dispatchers.IO) {
        val file = File(File(context.cacheDir, "tile-previews"), "${tileSet.id}.img")
        try {
            if (!file.exists()) {
                if (Http.offline) return@withContext null
                val url = tileSet.urls.first()
                    .replace("{z}", "$Z").replace("{x}", "$X").replace("{y}", "$Y")
                val bytes = Http.getBytes(url, readTimeoutMs = 10_000)
                file.parentFile?.mkdirs()
                file.writeBytes(bytes)
            }
            BitmapFactory.decodeFile(file.path)
        } catch (e: Exception) {
            Log.w("TilePreviews", "No preview for ${tileSet.id}", e)
            null
        }
    }
}
