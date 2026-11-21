package com.linea.messenger.avatars

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.SurfaceTexture
import android.graphics.drawable.Drawable
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.Surface
import android.view.TextureView
import com.linea.messenger.app.Messenger
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.net.Live
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Profile pictures at profile size (the chat list's store keeps 180 px, too small for a 116 dp avatar), animated GIF
 *  avatars and banners, and the files of video avatars and video banners (iOS Avatars/AvatarMedia.swift). Asked with
 *  the headers the chat list uses (`AvatarStore.headers`) over the platform's HTTPS (certificates checked as usual),
 *  kept in the cache folder, decoded off the main thread. Main thread only; `ready` is posted with the file's id
 *  when something asked for has arrived. */
object AvatarMedia {
  val ready = Live.Signal<String>()
  private val memory = object : LruCache<String, Any>(64 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Any) = (value as? Bitmap)?.byteCount ?: (4 * 1024 * 1024)
  }
  private val pool = Executors.newFixedThreadPool(2)
  private val main = Handler(Looper.getMainLooper())
  private val loading = HashSet<String>()
  private val failedAt = HashMap<String, Long>()
  private val videos = HashMap<String, File>()

  /** The address of a profile file (`GET /files/<id>`) on `base`; empty when either is empty. */
  fun address(base: String, id: String): String = if (base.isEmpty() || id.isEmpty()) "" else base + "/files/" + Messenger.pathPart(id)

  private fun folder(context: Context) = File(context.applicationContext.cacheDir, "invizent-profile-media")
  private fun file(context: Context, key: String, ending: String) = File(folder(context), key.replace(Regex("[^A-Za-z0-9_-]"), "_") + ending)

  private fun blocked(key: String): Boolean {
    if (loading.contains(key)) return true
    val at = failedAt[key] ?: return false
    return System.currentTimeMillis() - at < 60_000
  }

  /** A still picture at most `pixels` across; null while it is not here yet. */
  fun image(context: Context, id: String, base: String, pixels: Int): Bitmap? = media(context, id, base, pixels, animated = false) as? Bitmap

  /** A picture as a drawable: a GIF keeps moving when `animated` (Android 9 and later), else the still picture. */
  fun drawable(context: Context, id: String, base: String, pixels: Int, animated: Boolean): Any? = media(context, id, base, pixels, animated)

  private fun media(context: Context, id: String, base: String, pixels: Int, animated: Boolean): Any? {
    val address = address(base, id)
    if (address.isEmpty()) return null
    val key = "$id@$pixels${if (animated) "a" else ""}"
    memory.get(key)?.let { return it }
    if (blocked(key)) return null
    loading.add(key)
    val target = file(context, id, ".bin")
    val headers = AvatarStore.headers
    pool.execute {
      val made: Any? = try {
        fetch(address, headers, target)
        decode(target, pixels, animated)
      } catch (_: Throwable) { null }
      main.post {
        loading.remove(key)
        if (made != null) memory.put(key, made) else failedAt[key] = System.currentTimeMillis()
        ready.post(id)
      }
    }
    return null
  }

  /** The local file of a video (avatar or banner), downloaded once; null while it is not here yet. */
  fun video(context: Context, id: String, base: String): File? {
    videos[id]?.takeIf { it.exists() }?.let { return it }
    val address = address(base, id)
    if (address.isEmpty()) return null
    val key = "video:$id"
    val target = file(context, id, ".mp4")
    if (target.exists() && target.length() > 0) { videos[id] = target; return target }
    if (blocked(key)) return null
    loading.add(key)
    val headers = AvatarStore.headers
    pool.execute {
      val ok = try { fetch(address, headers, target); true } catch (_: Throwable) { false }
      main.post {
        loading.remove(key)
        if (ok) videos[id] = target else failedAt[key] = System.currentTimeMillis()
        ready.post(id)
      }
    }
    return null
  }

  private fun fetch(address: String, headers: Map<String, String>, file: File) {
    if (file.exists() && file.length() > 0) return
    val url = URL(address)
    if (url.protocol != "https") throw IllegalArgumentException("scheme")
    val connection = url.openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 15_000; connection.readTimeout = 30_000; connection.instanceFollowRedirects = false
      for ((name, value) in headers) connection.setRequestProperty(name, value)
      if (connection.responseCode != 200) throw IllegalStateException("status")
      file.parentFile?.mkdirs()
      val part = File(file.parentFile, file.name + ".part")
      connection.inputStream.use { input -> part.outputStream().use { output -> input.copyTo(output) } }
      if (part.length() == 0L || !part.renameTo(file)) { part.delete(); throw IllegalStateException("empty") }
    } finally { connection.disconnect() }
  }

  private fun decode(file: File, pixels: Int, animated: Boolean): Any? {
    if (animated && Build.VERSION.SDK_INT >= 28) {
      val drawable: Drawable? = try {
        ImageDecoder.decodeDrawable(ImageDecoder.createSource(file)) { decoder, info, _ ->
          val side = maxOf(info.size.width, info.size.height)
          if (side > pixels && side > 0) decoder.setTargetSampleSize(maxOf(1, side / pixels))
        }
      } catch (_: Throwable) { null }
      if (drawable is android.graphics.drawable.AnimatedImageDrawable) return drawable
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxOf(32, pixels)) sample *= 2
    return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
  }
}

/** A silent looping video (the video avatar, a video banner): played from a local file with the sound off, so it
 *  never takes the phone's audio from music (the reference plays them «mixWithOthers», muted). Cropped to fill. */
class LoopVideoView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener {
  private var player: MediaPlayer? = null
  private var surface: Surface? = null
  var file: File? = null
    private set
  /** With the sound (the photo viewer's video avatar). */
  var sound = false

  init {
    surfaceTextureListener = this
    isOpaque = false
  }

  /** Plays `next` in a loop (null stops and clears). */
  fun play(next: File?) {
    if (next == file) return
    file = next
    restart()
  }

  private fun restart() {
    player?.let { try { it.release() } catch (_: Throwable) {} }
    player = null
    val chosen = file ?: return
    val target = surface ?: return
    try {
      val made = MediaPlayer()
      made.setDataSource(chosen.path)
      made.setSurface(target)
      made.isLooping = true
      if (!sound) made.setVolume(0f, 0f)
      made.setOnVideoSizeChangedListener { _, w, h -> fit(w, h) }
      made.setOnPreparedListener { it.start() }
      made.setOnErrorListener { _, _, _ -> true }
      made.prepareAsync()
      player = made
    } catch (_: Throwable) { player = null }
  }

  private fun fit(videoW: Int, videoH: Int) {
    if (videoW <= 0 || videoH <= 0 || width <= 0 || height <= 0) return
    val scale = maxOf(width.toFloat() / videoW, height.toFloat() / videoH)
    val m = android.graphics.Matrix()
    m.setScale(videoW * scale / width, videoH * scale / height, width / 2f, height / 2f)
    setTransform(m)
  }

  fun pause() { try { player?.pause() } catch (_: Throwable) {} }
  fun resume() { try { player?.start() } catch (_: Throwable) {} }

  override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) { surface = Surface(texture); restart() }
  override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) { player?.let { fit(it.videoWidth, it.videoHeight) } }
  override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
    player?.let { try { it.release() } catch (_: Throwable) {} }
    player = null
    surface?.release(); surface = null
    return true
  }
  override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {}
}
