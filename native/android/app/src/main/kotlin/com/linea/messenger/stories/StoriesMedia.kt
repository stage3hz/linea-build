package com.linea.messenger.stories

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.SurfaceTexture
import android.graphics.drawable.Drawable
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.LruCache
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import com.linea.messenger.channels.ChannelFiles
import com.linea.messenger.channels.ChannelImages
import com.linea.messenger.design.Theme
import com.linea.messenger.design.orbPair
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import java.io.File
import java.util.concurrent.Executors

// The pictures and videos of stories and posts. They are plain files of the server (not end-to-end encrypted, as
// in the reference), so they come through the app's loader of plain files (channels/ChannelsNet.kt:
// `ChannelImages` and `ChannelFiles`): downloaded as this session into the cache folder and decoded OFF the main
// thread straight at the size they are shown at. Nothing here decodes a picture on the main thread.

/** The small pictures of stories (where the iPhone app uses the system's symbols): lines in a box of 24 units,
 *  as `Symbols`. Used on the main thread only. */
object StoryIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val box = RectF()

  /** The names `Symbols` hands over to this file (a row of the settings shows one). */
  fun adds(name: String): Boolean = name == "posts.grid"

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). An unknown name draws nothing. */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.9f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "plus" -> { stroke.strokeWidth = 2.6f; canvas.drawLine(12f, 4.6f, 12f, 19.4f, stroke); canvas.drawLine(4.6f, 12f, 19.4f, 12f, stroke) }
      "cross" -> { stroke.strokeWidth = 2.2f; canvas.drawLine(6f, 6f, 18f, 18f, stroke); canvas.drawLine(18f, 6f, 6f, 18f, stroke) }
      "back" -> { stroke.strokeWidth = 2.3f; path.moveTo(14.6f, 4.8f); path.lineTo(7.8f, 12f); path.lineTo(14.6f, 19.2f); canvas.drawPath(path, stroke) }
      "arrow.up" -> {
        stroke.strokeWidth = 2.3f
        path.moveTo(12f, 19f); path.lineTo(12f, 5.4f); path.moveTo(6.4f, 10.8f); path.lineTo(12f, 5.2f); path.lineTo(17.6f, 10.8f)
        canvas.drawPath(path, stroke)
      }
      "play" -> { path.moveTo(7.2f, 4.4f); path.lineTo(20f, 12f); path.lineTo(7.2f, 19.6f); path.close(); canvas.drawPath(path, fill) }
      "eye" -> {
        path.moveTo(2.6f, 12f); path.cubicTo(5.4f, 7.2f, 8.6f, 5.4f, 12f, 5.4f); path.cubicTo(15.4f, 5.4f, 18.6f, 7.2f, 21.4f, 12f)
        path.cubicTo(18.6f, 16.8f, 15.4f, 18.6f, 12f, 18.6f); path.cubicTo(8.6f, 18.6f, 5.4f, 16.8f, 2.6f, 12f); path.close()
        canvas.drawPath(path, stroke)
        canvas.drawCircle(12f, 12f, 3f, stroke)
      }
      "clock" -> {
        canvas.drawCircle(12f, 12f, 8.6f, stroke)
        path.moveTo(12f, 7.2f); path.lineTo(12f, 12f); path.lineTo(15.4f, 14f)
        canvas.drawPath(path, stroke)
      }
      "lock" -> {
        canvas.drawRoundRect(5.4f, 10.6f, 18.6f, 20.4f, 2.6f, 2.6f, stroke)
        box.set(8.2f, 3.6f, 15.8f, 11.2f); canvas.drawArc(box, 180f, 180f, false, stroke)
        canvas.drawLine(8.2f, 7.4f, 8.2f, 10.6f, stroke); canvas.drawLine(15.8f, 7.4f, 15.8f, 10.6f, stroke)
      }
      "video.off" -> {
        canvas.drawRoundRect(3f, 7f, 15.4f, 17f, 2.4f, 2.4f, stroke)
        path.moveTo(15.4f, 10.6f); path.lineTo(21f, 7.8f); path.lineTo(21f, 16.2f); path.lineTo(15.4f, 13.4f)
        canvas.drawPath(path, stroke)
        canvas.drawLine(4f, 3.6f, 20f, 20.4f, stroke)
      }
      "posts.grid" -> for (x in floatArrayOf(4.4f, 13.4f)) for (y in floatArrayOf(4.4f, 13.4f)) canvas.drawRoundRect(x, y, x + 6.2f, y + 6.2f, 1.6f, 1.6f, stroke)
    }
    canvas.restore()
  }
}

/** One of `StoryIcons`, `size` dp across, in the middle of its place; `disc` — a round plate behind it (0: none).
 *  It dims under a finger. A button when it is given a click listener and a `contentDescription`. */
@SuppressLint("ViewConstructor")
class StoryIconView(context: Context, symbol: String, private val size: Float, color: Int, disc: Int = 0) : View(context) {
  private val d = resources.displayMetrics.density
  private val back = Paint(Paint.ANTI_ALIAS_FLAG)
  var symbol: String = symbol
    set(value) { if (field != value) { field = value; invalidate() } }
  var color: Int = color
    set(value) { if (field != value) { field = value; invalidate() } }
  var disc: Int = disc
    set(value) { if (field != value) { field = value; invalidate() } }
  /** A hairline around the plate (0: none). */
  var rim: Int = 0
    set(value) { if (field != value) { field = value; invalidate() } }

  override fun getAccessibilityClassName(): CharSequence = if (isClickable) "android.widget.Button" else "android.view.View"

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val radius = minOf(width, height) / 2f
    if (disc != 0) { back.style = Paint.Style.FILL; back.color = disc; canvas.drawCircle(width / 2f, height / 2f, radius, back) }
    if (rim != 0) { back.style = Paint.Style.STROKE; back.strokeWidth = 2f * d; back.color = rim; canvas.drawCircle(width / 2f, height / 2f, radius - d, back) }
    if (symbol.isEmpty()) return
    StoryIcons.draw(canvas, symbol, width / 2f, height / 2f, size * d, if (isPressed || !isEnabled) Theme.alpha(color, 0.5f) else color)
  }
}

/** The colours of the ring around an avatar: plain arithmetic, so it can be checked without a phone. */
object StoryRingColors {
  /** `color`: the person's colour, 0xRRGGBB. Lit — the light of the person's own colour (the same pair their
   *  avatar is lit with) around the colour itself; all watched — one quiet grey of the theme. */
  fun of(color: Int, fresh: Boolean, dark: Boolean): IntArray {
    if (!fresh) return (if (dark) 0x73ABBCD6 else 0x665C6E88).let { intArrayOf(it, it) }
    val pair = orbPair(color and 0xFFFFFF)
    return intArrayOf(pair.first, 0xFF000000.toInt() or (color and 0xFFFFFF), pair.second)
  }
}

/** The ring around an avatar: lit while there is something to watch, grey once everything was watched.
 *  A drawable, so that it can also be laid over a page around a picture that is already there. */
class StoryRingDrawable(private val density: Float) : Drawable() {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private var colors = StoryRingColors.of(0x5E7BFF, fresh = true, dark = true)
  private val box = RectF()

  /** `color`: the person's colour, 0xRRGGBB. `fresh`: something new to look at. */
  fun show(color: Int, fresh: Boolean) {
    colors = StoryRingColors.of(color, fresh, Theme.dark)
    invalidateSelf()
  }

  override fun draw(canvas: Canvas) {
    val area = bounds
    if (area.width() <= 0 || area.height() <= 0) return
    paint.strokeWidth = 3f * density
    // From the lower left corner to the upper right one.
    paint.shader = LinearGradient(area.left.toFloat(), area.bottom.toFloat(), area.right.toFloat(), area.top.toFloat(), colors, null, Shader.TileMode.CLAMP)
    box.set(area)
    box.inset(1.5f * density, 1.5f * density)
    canvas.drawOval(box, paint)
  }

  override fun setAlpha(alpha: Int) { paint.alpha = alpha }
  override fun setColorFilter(filter: ColorFilter?) { paint.colorFilter = filter }
  @Deprecated("The platform asks.") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

class StoryRingView(context: Context) : View(context) {
  private val ring = StoryRingDrawable(resources.displayMetrics.density)

  fun show(color: Int, fresh: Boolean) {
    ring.show(color, fresh)
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    ring.setBounds(0, 0, width, height)
    ring.draw(canvas)
  }
}

/** The first frames of videos, for the tiles of a profile. A frame is cut off the main thread from the video's
 *  file in the cache folder (downloaded when it is not there yet) and kept in memory under a limit. */
object StoryVideoFrames {
  /** Posted on the main thread when a frame has arrived (or failed): the file's id. */
  val ready = Live.Signal<String>()

  private val memory = object : LruCache<String, Bitmap>(24 * 1024 * 1024) { override fun sizeOf(key: String, value: Bitmap) = maxOf(1, value.byteCount) }
  private val loading = HashSet<String>()
  private val failedAt = HashMap<String, Long>()
  private val work = Executors.newFixedThreadPool(2) { run -> Thread(run, "invizent.story-frames").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 } }
  private val main = Handler(Looper.getMainLooper())
  /** For the debug build's samples: frames that are simply there. */
  private val samples = HashMap<String, Bitmap>()

  /** Where a video's file is kept. Waits on the calling (background) thread. */
  fun bring(server: Server, id: String): File? = ChannelFiles.bring(server, id, "video.mp4")

  /** The first frame of a video file, at most 640 px a side. Any thread but the main one. */
  fun frame(file: File, most: Int = 640): Bitmap? {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(file.absolutePath)
      if (Build.VERSION.SDK_INT >= 27) retriever.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, most, most)
      else retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
    } catch (_: Throwable) {
      null
    } finally {
      try { retriever.release() } catch (_: Throwable) {}
    }
  }

  /** Main thread only. Null while the frame is not here — `ready` is posted when it is. */
  fun image(id: String): Bitmap? {
    if (id.isEmpty()) return null
    samples[id]?.let { return it }
    memory.get(id)?.let { return it }
    if (loading.contains(id)) return null
    val failed = failedAt[id]
    if (failed != null && SystemClock.elapsedRealtime() - failed < 60_000) return null
    val server = ChannelImages.server ?: return null
    loading.add(id)
    work.execute {
      val made = bring(server, id)?.let { frame(it) }
      main.post {
        loading.remove(id)
        if (made != null) { memory.put(id, made); failedAt.remove(id) } else failedAt[id] = SystemClock.elapsedRealtime()
        ready.post(id)
      }
    }
    return null
  }

  fun putSample(image: Bitmap, id: String) { samples[id] = image }
}

/** Shows the picture of a post (or the first frame of its video). Asks the loaders and waits for their word;
 *  the picture is decoded before it gets here. */
class StoryPictureView(context: Context) : ImageView(context) {
  private var wantedId = ""
  private var wantedPixels = 0
  private var wantsFrame = false
  private var shown: Bitmap? = null
  /** The picture did not come (no connection, not a picture). */
  var gaveUp = false
    private set
  /** Called on the main thread when the picture is shown or has given up. */
  var onSettled: (() -> Unit)? = null
  private val arrived: (String) -> Unit = { id -> arrived(id) }

  val settled: Boolean get() = shown != null || gaveUp || wantedId.isEmpty()

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ChannelImages.ready.watch(arrived)
    StoryVideoFrames.ready.watch(arrived)
    // What came while the view was away.
    if (shown == null && wantedId.isNotEmpty() && !gaveUp && load()) onSettled?.invoke()
  }

  override fun onDetachedFromWindow() {
    ChannelImages.ready.unwatch(arrived)
    StoryVideoFrames.ready.unwatch(arrived)
    super.onDetachedFromWindow()
  }

  /** `pixels`: the longer side it is shown at, in pixels of the screen. */
  fun show(post: StoryPost?, pixels: Int) {
    val id = post?.mediaId ?: ""
    val ofVideo = post?.isVideo ?: false
    if (id == wantedId && pixels == wantedPixels && ofVideo == wantsFrame && shown != null) return
    wantedId = id
    wantedPixels = pixels
    wantsFrame = ofVideo
    gaveUp = false
    shown = null
    setImageBitmap(null)
    load()
  }

  private fun load(): Boolean {
    if (wantedId.isEmpty()) return false
    val found = (if (wantsFrame) StoryVideoFrames.image(wantedId) else ChannelImages.image(wantedId, wantedPixels)) ?: return false
    shown = found
    setImageBitmap(found)
    return true
  }

  private fun arrived(id: String) {
    if (id != wantedId || id.isEmpty() || shown != null) return
    if (!load()) gaveUp = true
    onSettled?.invoke()
  }
}

/** A video of a story or a post on the screen. The file is brought into the cache folder off the main thread and
 *  played from there, fitted whole into the view. */
class StoryVideoView(context: Context) : FrameLayout(context), TextureView.SurfaceTextureListener {
  private val texture = TextureView(context)
  private val main = Handler(Looper.getMainLooper())
  private var player: MediaPlayer? = null
  private var prepared = false
  private var surface: Surface? = null
  private var wantedId = ""
  private var wantsPlay = false
  /** The video could not be brought or played. */
  var gaveUp = false
    private set
  var onEnded: (() -> Unit)? = null
  /** Ready to play, or given up. */
  var onSettled: (() -> Unit)? = null

  init {
    texture.surfaceTextureListener = this
    addView(texture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  val ready: Boolean get() = prepared

  /** 0 … 1: how much of the video has played. */
  val played: Double
    get() {
      val player = player ?: return 0.0
      if (!prepared) return 0.0
      return try {
        val total = player.duration
        if (total <= 0) 0.0 else (player.currentPosition.toDouble() / total).coerceIn(0.0, 1.0)
      } catch (_: IllegalStateException) { 0.0 }
    }

  private fun forget() {
    prepared = false
    val old = player
    player = null
    try { old?.release() } catch (_: Throwable) {}
  }

  override fun onDetachedFromWindow() {
    forget()
    wantedId = ""
    super.onDetachedFromWindow()
  }

  /** Shows the video with this file id (empty: nothing). `loop`: a post's video starts over at its end. */
  fun show(id: String, loop: Boolean) {
    if (id == wantedId) return
    forget()
    wantedId = id
    gaveUp = false
    if (id.isEmpty()) return
    val server = ChannelImages.server
    if (server == null) {
      gaveUp = true
      onSettled?.invoke()
      return
    }
    bringing.execute {
      val file = StoryVideoFrames.bring(server, id)
      main.post {
        if (wantedId != id) return@post
        if (file == null) {
          gaveUp = true
          onSettled?.invoke()
        } else {
          begin(file, loop)
        }
      }
    }
  }

  private fun fail() {
    if (gaveUp) return
    gaveUp = true
    onSettled?.invoke()
  }

  private fun begin(file: File, loop: Boolean) {
    val made = MediaPlayer()
    player = made
    try {
      made.setDataSource(file.absolutePath)
      surface?.let { made.setSurface(it) }
      made.setOnPreparedListener {
        if (player !== made) return@setOnPreparedListener
        prepared = true
        fit()
        if (wantsPlay) try { made.start() } catch (_: IllegalStateException) {}
        onSettled?.invoke()
      }
      made.setOnVideoSizeChangedListener { _, _, _ -> if (player === made) fit() }
      made.setOnCompletionListener {
        if (player !== made) return@setOnCompletionListener
        if (loop) {
          try { made.seekTo(0); if (wantsPlay) made.start() } catch (_: IllegalStateException) {}
        } else {
          onEnded?.invoke()
        }
      }
      // A file that is not a video the system can play never starts: it says so here.
      made.setOnErrorListener { _, _, _ -> if (player === made) { prepared = false; fail() }; true }
      made.prepareAsync()
    } catch (_: Throwable) {
      forget()
      fail()
    }
  }

  /** The whole picture inside the view, its proportions kept. */
  private fun fit() {
    val player = player ?: return
    val wide = try { player.videoWidth } catch (_: IllegalStateException) { 0 }
    val tall = try { player.videoHeight } catch (_: IllegalStateException) { 0 }
    if (wide <= 0 || tall <= 0 || width <= 0 || height <= 0) return
    val scale = minOf(width.toFloat() / wide, height.toFloat() / tall)
    texture.setTransform(Matrix().apply { setScale(wide * scale / width, tall * scale / height, width / 2f, height / 2f) })
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    fit()
  }

  /** Plays or pauses (a pause keeps the place). */
  fun setPlaying(on: Boolean) {
    wantsPlay = on
    val player = player ?: return
    if (!prepared) return
    try { if (on) { if (!player.isPlaying) player.start() } else if (player.isPlaying) player.pause() } catch (_: IllegalStateException) {}
  }

  override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
    val made = Surface(texture)
    surface = made
    try { player?.setSurface(made) } catch (_: IllegalStateException) {}
  }

  override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = fit()

  override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
    try { player?.setSurface(null) } catch (_: IllegalStateException) {}
    surface?.release()
    surface = null
    return true
  }

  override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {}

  private companion object {
    val bringing = Executors.newFixedThreadPool(2) { run -> Thread(run, "invizent.story-video").apply { isDaemon = true } }
  }
}
