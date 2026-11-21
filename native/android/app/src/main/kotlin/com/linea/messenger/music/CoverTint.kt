package com.linea.messenger.music

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import com.linea.messenger.core.Core
import com.linea.messenger.net.Server
import com.linea.messenger.shell.RootScreen
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The covers of tracks: fetched once over HTTPS (no cookies, no cache on disk) and kept in memory.
 *  Main thread only, but for the fetching itself. */
object MusicCovers {
  /** Told a track's id once its cover is here. */
  class Ready {
    private val listeners = LinkedHashSet<(String) -> Unit>()
    fun watch(listener: (String) -> Unit) { listeners.add(listener) }
    fun unwatch(listener: (String) -> Unit) { listeners.remove(listener) }
    fun fire(id: String) { for (listener in listeners.toList()) listener(id) }
  }

  val ready = Ready()
  private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
  }
  /** Covers drawn in code (the debug build's samples), by track id. */
  val drawn = HashMap<String, Bitmap>()
  private val busy = HashSet<String>()
  private val failed = HashSet<String>()
  private val main: Handler by lazy { Handler(Looper.getMainLooper()) }
  private val work by lazy { Executors.newFixedThreadPool(3) { run -> Thread(run, "invizent.music.cover").apply { isDaemon = true } } }
  /** The app's client and its rules (TLS only, the system's certificate checks, no cookie jar, no cache); a
   *  cover's address may hand over to another https address of the catalogue's storage — never to plain http. */
  private val client: OkHttpClient by lazy { Server.client.newBuilder().followRedirects(true).followSslRedirects(false).callTimeout(20, TimeUnit.SECONDS).build() }
  private const val limit = 8 * 1024 * 1024

  /** The cover when it is already here; otherwise null, and `ready` is fired with the track's id once it is. */
  fun image(track: MusicTrack): Bitmap? {
    drawn[track.id]?.let { return it }
    cache.get(track.id)?.let { return it }
    val address = track.artworkUrl ?: return null
    val id = track.id
    if (!address.startsWith("https://", ignoreCase = true) || id in busy || id in failed) return null
    val request = try { Request.Builder().url(address).get().build() } catch (_: IllegalArgumentException) { failed.add(id); return null }
    busy.add(id)
    work.execute {
      val picture = fetch(request)
      main.post {
        busy.remove(id)
        if (picture == null) failed.add(id) else { cache.put(id, picture); ready.fire(id) }
      }
    }
    return null
  }

  private fun fetch(request: Request): Bitmap? = try {
    client.newCall(request).execute().use { response ->
      if (response.code != 200 || !response.request.isHttps) return null
      val received = ByteArrayOutputStream()
      val input = response.body?.byteStream() ?: return null
      val chunk = ByteArray(32 * 1024)
      while (true) {
        val got = input.read(chunk)
        if (got < 0) break
        if (received.size() + got > limit) return null
        received.write(chunk, 0, got)
      }
      val bytes = received.toByteArray()
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
      var sample = 1
      while (max(bounds.outWidth, bounds.outHeight) / sample > 720) sample *= 2
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
  } catch (_: Throwable) { null }
}

/** The colours of the light under the bar while music plays: three colours taken from the track's cover, left
 *  to right. Ported from mobile/src/design/coverTint.ts (`glowOf`, and the cover read as three places across its
 *  width, as the reference's canvas path does) and design/avatarTint.ts (`vividTint`); iOS: Music/CoverTint.swift.
 *  A track without a cover, or a cover with no colour of its own (black and white), has none — the bar keeps its
 *  calm light. */
object CoverTint {
  private const val key = "linea.cover-tint.v1"
  private const val limit = 200
  private val color = Regex("^#[0-9a-fA-F]{6}$")
  /** Known answers by track id, oldest first: three `#rrggbb`, or an empty list for «no colour». */
  private val known = LinkedHashMap<String, List<String>>()
  private var prefs: SharedPreferences? = null

  /** Reads what was worked out before (once). */
  fun open(context: Context) {
    if (prefs != null) return
    val store = context.applicationContext.getSharedPreferences("linea.music", Context.MODE_PRIVATE)
    prefs = store
    for ((id, glow) in parse(store.getString(key, null))) if (!known.containsKey(id)) known[id] = glow
  }

  /** The remembered answers as they are kept (the reference's JSON: `{id: [three colours] | null}`). */
  fun parse(text: String?): Map<String, List<String>> {
    val stored = Core.map(Core.value(text) as? Map<*, *>) ?: return emptyMap()
    val out = LinkedHashMap<String, List<String>>()
    for ((id, value) in stored) {
      val glow = (value as? List<*>)?.mapNotNull { it as? String }
      out[id] = if (glow != null && glow.size == 3 && (value as List<*>).size == 3 && glow.all { color.matches(it) }) glow else emptyList()
    }
    return out
  }

  /** A colour as a light: its own hue, saturated enough to read as a colour, neither too dark nor washed
   *  out. No colour of its own gives "". */
  fun vivid(r: Int, g: Int, b: Int): String {
    val red = r / 255.0; val green = g / 255.0; val blue = b / 255.0
    val top = max(red, max(green, blue)); val low = min(red, min(green, blue)); val l = (top + low) / 2; val d = top - low
    if (d < 0.06) return ""
    val spread = 1 - abs(2 * l - 1)
    val sat = d / (if (spread == 0.0) 1.0 else spread)
    val hue = if (top == red) ((green - blue) / d + 6) % 6 * 60 else if (top == green) ((blue - red) / d + 2) * 60 else ((red - green) / d + 4) * 60
    val s = min(0.85, max(0.5, sat * 1.5)); val light = min(0.62, max(0.46, l))
    val a = s * min(light, 1 - light)
    fun part(n: Double): String {
      val k = (n + hue / 30) % 12
      val value = (255 * (light - a * max(-1.0, min(min(k - 3, 9 - k), 1.0)))).roundToInt()
      return String.format(Locale.ROOT, "%02x", value.coerceIn(0, 255))
    }
    return "#" + part(0.0) + part(8.0) + part(4.0)
  }

  /** Three cover colours as lights; a cover with no colour of its own gives null. */
  fun glowOf(colors: List<Triple<Int, Int, Int>>): List<String>? {
    val lights = colors.map { vivid(it.first, it.second, it.third) }
    if (lights.size != 3) return null
    val first = lights.firstOrNull { it.isNotEmpty() } ?: return null
    return lights.map { it.ifEmpty { first } }
  }

  /** The colour of a picture (`pixels`: 0xAARRGGBB, row after row) at three places from left to right: the
   *  average of each third of its width. */
  fun row(pixels: IntArray, width: Int, height: Int): List<Triple<Int, Int, Int>>? {
    if (width < 3 || height < 1 || pixels.size < width * height) return null
    return (0 until 3).map { band ->
      val from = width * band / 3; val to = width * (band + 1) / 3
      var r = 0L; var g = 0L; var b = 0L
      for (y in 0 until height) for (x in from until to) {
        val pixel = pixels[y * width + x]
        r += (pixel shr 16) and 255; g += (pixel shr 8) and 255; b += pixel and 255
      }
      val count = ((to - from) * height).toLong()
      Triple((r.toDouble() / count).roundToInt(), (g.toDouble() / count).roundToInt(), (b.toDouble() / count).roundToInt())
    }
  }

  private fun row(picture: Bitmap): List<Triple<Int, Int, Int>>? = try {
    // Small first (the cover may be several hundred points across), then the three averages.
    val small = if (picture.width > 48 || picture.height > 48) Bitmap.createScaledBitmap(picture, 48, 48, true) else picture
    val pixels = IntArray(small.width * small.height)
    small.getPixels(pixels, 0, small.width, 0, 0, small.width, small.height)
    row(pixels, small.width, small.height)
  } catch (_: Throwable) { null }

  private fun remember(id: String, glow: List<String>) {
    known.remove(id)
    known[id] = glow
    while (known.size > limit) known.remove(known.keys.first())
    val text = Core.text(known.mapValues { (_, value) -> value.takeIf { it.isNotEmpty() } }) ?: return
    prefs?.edit()?.putString(key, text)?.apply()
  }

  /** The cover's three colours, or null while unknown / when there is none. */
  fun glow(track: MusicTrack?): List<String>? {
    track ?: return null
    known[track.id]?.let { return it.takeIf { found -> found.isNotEmpty() } }
    if (MusicCovers.drawn[track.id] == null && track.artworkUrl?.startsWith("https://", ignoreCase = true) != true) return null
    val picture = MusicCovers.image(track) ?: return null
    val glow = row(picture)?.let { glowOf(it) }
    remember(track.id, glow ?: emptyList())
    return glow
  }
}

/** Keeps the shell's bar lit by the playing track's cover: calm silver while nothing plays or the cover gives no colour. */
object MusicGlow {
  private var root = WeakReference<RootScreen>(null)
  private var shown: List<String> = emptyList()
  private var watching = false

  fun attach(root: RootScreen) {
    this.root = WeakReference(root)
    // A new shell's bar starts calm.
    shown = emptyList()
    CoverTint.open(root.context)
    if (!watching) {
      watching = true
      MusicPlayer.shared.changed.watch { update() }
      MusicCovers.ready.watch { update() }
    }
    update()
  }

  private fun update() {
    val player = MusicPlayer.shared
    val current = player.current
    val colours = if (current != null && player.playing) CoverTint.glow(current) ?: emptyList() else emptyList()
    if (colours == shown) return
    shown = colours
    root.get()?.setBarGlow(colours)
  }
}
