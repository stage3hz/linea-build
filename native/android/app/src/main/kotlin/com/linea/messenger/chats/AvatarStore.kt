package com.linea.messenger.chats

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.View
import java.io.File
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Avatars of the chat list: memory cache, then a file in the app's cache folder, then one download over the
 *  platform's HTTPS stack (certificates are checked as usual) with the app's own request headers. A file that failed
 *  is not asked for again for a minute. All bookkeeping happens on the main thread. */
object AvatarStore {
  private const val SIDE = 180
  private const val RETRY_MS = 60_000L
  private val memory = object : LruCache<String, Bitmap>(24 * 1024 * 1024) { override fun sizeOf(key: String, value: Bitmap) = value.byteCount }
  private val pool = Executors.newFixedThreadPool(3)
  private val main = Handler(Looper.getMainLooper())
  private val loading = HashSet<String>()
  private val failedAt = HashMap<String, Long>()
  private val waiting = HashMap<String, ArrayList<WeakReference<View>>>()
  @Volatile var headers: Map<String, String> = emptyMap()

  fun get(context: Context, key: String, url: String, view: View): Bitmap? {
    memory.get(key)?.let { return it }
    val failed = failedAt[key]
    if (failed != null && System.currentTimeMillis() - failed < RETRY_MS) return null
    waiting.getOrPut(key) { ArrayList() }.add(WeakReference(view))
    if (!loading.add(key)) return null
    val folder = File(context.applicationContext.cacheDir, "linea-avatars")
    val file = File(folder, key.replace(Regex("[^A-Za-z0-9_-]"), "_"))
    val sent = headers
    pool.execute {
      var bitmap: Bitmap? = null
      try {
        if (!file.exists() || file.length() == 0L) download(url, sent, folder, file)
        bitmap = decode(file)
        if (bitmap == null) file.delete()
      } catch (_: Throwable) { try { file.delete() } catch (_: Throwable) { } }
      val result = bitmap
      main.post {
        loading.remove(key)
        if (result != null) { memory.put(key, result); failedAt.remove(key) } else failedAt[key] = System.currentTimeMillis()
        waiting.remove(key)?.forEach { it.get()?.invalidate() }
      }
    }
    return null
  }

  private fun download(address: String, sent: Map<String, String>, folder: File, file: File) {
    val url = URL(address)
    if (url.protocol != "https") throw IllegalArgumentException("scheme")
    val connection = url.openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 10_000; connection.readTimeout = 20_000; connection.instanceFollowRedirects = false
      for ((name, value) in sent) connection.setRequestProperty(name, value)
      if (connection.responseCode != 200) throw IllegalStateException("status " + connection.responseCode)
      folder.mkdirs()
      val part = File(folder, file.name + ".part")
      connection.inputStream.use { input -> part.outputStream().use { output -> input.copyTo(output) } }
      if (!part.renameTo(file)) { part.delete(); throw IllegalStateException("rename") }
    } finally { connection.disconnect() }
  }

  private fun decode(file: File): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= SIDE) sample *= 2
    return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
  }
}
