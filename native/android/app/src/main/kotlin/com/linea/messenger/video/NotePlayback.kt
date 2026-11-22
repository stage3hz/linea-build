package com.linea.messenger.video

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.text.TextPaint
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import com.linea.messenger.attachments.AttachmentStore
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.chat.MsgListView
import com.linea.messenger.core.Core
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.Theme
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.net.Server
import com.linea.messenger.voice.MediaFetch
import com.linea.messenger.voice.MediaIcons
import com.linea.messenger.voice.MsgMediaState
import com.linea.messenger.voice.VoicePlayer
import java.io.File

/** The picture of a round video playing inside its row: the player's picture cut to a circle, the ring of a
 *  listen around it, a play mark while it is paused, and the pill at the lower left of its square (the length and
 *  the speaker-off mark while it loops silently, the seconds played while it is listened to). It takes no touches
 *  — a tap goes to the row under it. Reference: mobile/src/videonote/VideoNote.tsx (`VideoNoteBubble`), NoteRing.tsx. */
@SuppressLint("ViewConstructor")
class NotePlayerView(context: Context) : FrameLayout(context) {
  private val d = resources.displayMetrics.density
  val picture = TextureView(context)
  private val round = FrameLayout(context)
  private var progress = 0f
  private var paused = false
  private var videoWidth = 0
  private var videoHeight = 0
  private var pillWords = ""
  private var pillMuted = true
  /** VideoNote.tsx: while a listen is rewound — the picture dimmed by 0.28 black, the play mark, and the white
   *  14 dp knob on the ring. */
  private var scrubbing = false
  private var knobShown = 0f
  /** A rewind along the ring: "begin", "to", "end" with the share (0…0.985). */
  var onScrub: ((String, Float) -> Unit)? = null
  /** Rewinding is possible (the circle is open, being listened to). */
  var canScrub = false
  /** A tap on the ring band that did not become a rewind. */
  var onTap: (() -> Unit)? = null
  private var downX = 0f
  private var downY = 0f
  private var tracking = false
  private val marks = object : View(context) {
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
      val cx = width / 2f; val cy = height / 2f
      // NoteRing: r = (size − stroke) / 2, from 12 o'clock clockwise, invisible until something has played.
      if (progress > 0.001f) {
        stroke.color = Theme.accent
        stroke.strokeWidth = 3f * d
        val radius = maxOf(1f, (minOf(width, height) - 3f * d) / 2f)
        canvas.drawArc(cx - radius, cy - radius, cx + radius, cy + radius, -90f, 360f * progress, false, stroke)
      }
      if (scrubbing) {
        fill.color = 0x47000000
        canvas.drawCircle(cx, cy, minOf(width, height) / 2f, fill)
      }
      if (paused || scrubbing) {
        fill.color = 0x730A1423
        canvas.drawCircle(cx, cy, 26f * d, fill)
        IonIcon.draw(canvas, "play", cx, cy, 26f * d, 0xFFFFFFFF.toInt())
      }
      if (knobShown > 0f) {
        val radius = minOf(width, height) / 2f - 1.5f * d
        val angle = progress * 2 * Math.PI
        val kx = cx + radius * Math.sin(angle).toFloat(); val ky = cy - radius * Math.cos(angle).toFloat()
        fill.color = 0xFFFFFFFF.toInt()
        fill.alpha = (knobShown * 255).toInt()
        fill.setShadowLayer(3f * d, 0f, 1f * d, Theme.alpha(0xFF000000.toInt(), 0.3f * knobShown))
        canvas.drawCircle(kx, ky, 7f * d, fill)
        fill.clearShadowLayer()
        fill.alpha = 255
      }
    }
  }
  private val pill = object : View(context) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x6B000000 }
    private val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
    override fun onDraw(canvas: Canvas) {
      if (pillWords.isEmpty()) return
      text.textSize = (if (pillMuted) 11f else 12f) * d
      text.fontFeatureSettings = if (pillMuted) null else "tnum"
      val words = Math.ceil(text.measureText(pillWords).toDouble()).toFloat()
      val tall = Math.ceil((text.descent() - text.ascent()).toDouble()).toFloat() + 4f * d
      val wide = 7f * d + words + (if (pillMuted) 4f * d + 11f * d else 0f) + 7f * d
      val top = height - 6f * d - tall
      canvas.drawRoundRect(6f * d, top, 6f * d + wide, top + tall, 9f * d, 9f * d, fill)
      canvas.drawText(pillWords, 13f * d, top + tall / 2 - (text.ascent() + text.descent()) / 2, text)
      if (pillMuted) IonIcon.draw(canvas, "volume-mute", 13f * d + words + 4f * d + 5.5f * d, top + tall / 2, 11f * d, 0xFFFFFFFF.toInt())
    }
  }

  init {
    isClickable = false
    isFocusable = false
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    setWillNotDraw(true)
    round.clipToOutline = true
    round.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) = outline.setOval(0, 0, view.width, view.height)
    }
    round.setBackgroundColor(Theme.surface2)
    picture.isOpaque = false
    round.addView(picture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(round, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(marks, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(pill, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    round.invalidateOutline()
    fit()
  }

  /** The size of the picture the player shows (turned as the video says). */
  fun setVideoSize(width: Int, height: Int) {
    videoWidth = width; videoHeight = height
    fit()
  }

  /** The picture fills the circle and keeps its shape: what does not fit is cut at the sides. */
  private fun fit() {
    val matrix = Matrix()
    if (videoWidth > 0 && videoHeight > 0 && width > 0 && height > 0) {
      val scale = fill(videoWidth, videoHeight, width, height)
      matrix.setScale(scale.first, scale.second, width / 2f, height / 2f)
    }
    picture.setTransform(matrix)
  }

  /** The pill at the lower left: `muted` — the silent loop (11 dp with the speaker-off mark), else the seconds
   *  played (12 dp, tabular figures). Empty words hide it. */
  fun showPill(words: String, muted: Boolean) {
    if (words == pillWords && muted == pillMuted) return
    pillWords = words; pillMuted = muted
    pill.invalidate()
  }

  /** playback.ts `onScrubBand`: a rewind starts on the outer 56 dp of the ring (to 12 past it). */
  private fun onBand(x: Float, y: Float): Boolean {
    val distance = Math.hypot((x - width / 2f).toDouble(), (y - height / 2f).toDouble()).toFloat(); val radius = minOf(width, height) / 2f
    return distance >= radius - 56f * d && distance <= radius + 12f * d
  }

  /** playback.ts `scrubFraction`: the share clockwise from 12 o'clock; crossing 12 does not wrap. */
  private fun share(x: Float, y: Float, previous: Float?): Float {
    var value = (Math.atan2((x - width / 2f).toDouble(), -(y - height / 2f).toDouble()) / (2 * Math.PI)).toFloat()
    if (value < 0f) value += 1f
    if (previous != null) { if (previous > 0.75f && value < 0.25f) value = 1f else if (previous < 0.25f && value > 0.75f) value = 0f }
    return value.coerceIn(0f, 0.985f)
  }

  private fun knob(to: Float, duration: Long) {
    android.animation.ValueAnimator.ofFloat(knobShown, to).apply {
      this.duration = duration
      addUpdateListener { knobShown = it.animatedValue as Float; marks.invalidate() }
      start()
    }
  }

  // VideoNote.tsx: the rewind starts on the ring band after 8 dp of movement, so a tap still pauses (the row
  // under it gets the tap) and a drag from the middle still scrolls the list.
  override fun onInterceptTouchEvent(event: android.view.MotionEvent): Boolean = canScrub
  override fun onTouchEvent(event: android.view.MotionEvent): Boolean {
    if (!canScrub) return false
    when (event.actionMasked) {
      android.view.MotionEvent.ACTION_DOWN -> {
        if (!onBand(event.x, event.y)) return false
        downX = event.x; downY = event.y; tracking = true
        return true
      }
      android.view.MotionEvent.ACTION_MOVE -> {
        if (!tracking) return false
        if (!scrubbing) {
          if (Math.hypot((event.x - downX).toDouble(), (event.y - downY).toDouble()) <= 8f * d) return true
          scrubbing = true
          parent?.requestDisallowInterceptTouchEvent(true)
          progress = share(event.x, event.y, null)
          onScrub?.invoke("begin", progress)
          knob(1f, 120)
          marks.invalidate()
          return true
        }
        val next = share(event.x, event.y, progress)
        if (Math.abs(next - progress) >= 0.01f) onScrub?.invoke("to", next)
        progress = next
        marks.invalidate()
        return true
      }
      android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
        val was = scrubbing
        tracking = false
        if (!was) {
          // A tap on the ring: the row under it pauses or plays, as a tap anywhere on the circle.
          if (event.actionMasked == android.view.MotionEvent.ACTION_UP) onTap?.invoke()
          return true
        }
        scrubbing = false
        onScrub?.invoke("end", progress)
        knob(0f, 160)
        marks.invalidate()
        return true
      }
    }
    return tracking
  }

  /** Shows or hides the play mark without touching the ring. */
  fun showPause(value: Boolean) {
    if (paused == value) return
    paused = value
    marks.invalidate()
  }

  fun show(progress: Float, paused: Boolean) {
    if (scrubbing) return
    val next = progress.coerceIn(0f, 1f)
    if (next == this.progress && paused == this.paused) return
    this.progress = next
    this.paused = paused
    marks.invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    (parent as? View)?.invalidate()
  }

  override fun onDetachedFromWindow() {
    (parent as? View)?.invalidate()
    super.onDetachedFromWindow()
  }

  companion object {
    /** How a picture stretched over the whole view must be scaled about its middle to fill the view and keep
     *  its own shape (x, y). */
    fun fill(videoWidth: Int, videoHeight: Int, viewWidth: Int, viewHeight: Int): Pair<Float, Float> {
      val video = videoWidth.toFloat() / videoHeight; val view = viewWidth.toFloat() / viewHeight
      return if (video > view) Pair(video / view, 1f) else Pair(1f, view / video)
    }
  }
}

/** Round video messages of one chat, played in their rows.
 *
 *  Reference: mobile/src/videonote/VideoNote.tsx (`VideoNoteBubble`) and playback.ts: a circle on screen is
 *  brought by itself and loops without sound; a tap plays it from the start with sound, at the speed chosen for
 *  voice messages, with a ring of its progress; another tap pauses; when it ends it goes back to the silent
 *  loop. One circle sounds at a time, and a voice message goes quiet for it. Here one circle at a time is shown
 *  moving (the reference moves every circle on screen), and only circles of at most 8 MiB are brought unasked. */
class NotePlayback(
  private val context: Context,
  private val server: Server?,
  /** The view the circle is put into (the chat's list, or the frame of «Избранное»'s list). */
  private val list: FrameLayout,
  /** Where a row's circle stands in `list` while the row is on screen. */
  private val hostOf: (String) -> RectF?,
  /** The rows on screen. */
  private val keysOnScreen: () -> List<String>,
) : TextureView.SurfaceTextureListener {
  constructor(context: Context, server: Server?, list: MsgListView) : this(context, server, list, { key -> list.mediaHost(key) }, { list.visibleKeys() })

  /** A circle of this row was brought (or its copy dropped): the row is drawn again. */
  var onReadyChanged: ((String) -> Unit)? = null
  /** VideoNote.tsx: a circle listened to grows in place to min(404, the row's width) and gives the room back when
   *  the listen ends. The list makes the row's slot large (true) or small again (false); the circle itself is
   *  scaled meanwhile (200 ms, ease-out cubic), anchored at the lower corner on the message's side. */
  var onExpanded: ((String, Boolean) -> Unit)? = null
  /** Whether a row's circle stands at the right edge (own messages); it grows away from that edge. */
  var anchorsRight: ((String) -> Boolean)? = null
  /** The row whose slot is large now (empty: none). */
  var expandedKey = ""; private set
  private var smallScale = 1f
  private var resumeAfterScrub = false
  private val easeOutCubic = android.view.animation.PathInterpolator(0.215f, 0.61f, 0.355f, 1f)

  /** After the list has laid its rows out anew: `then` runs once, before the next frame is drawn. */
  private fun afterLayout(then: () -> Unit) {
    val observer = list.viewTreeObserver
    observer.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
      override fun onPreDraw(): Boolean {
        if (list.viewTreeObserver.isAlive) list.viewTreeObserver.removeOnPreDrawListener(this)
        then()
        return true
      }
    })
    list.invalidate()
  }

  /** The slot of `rowKey` becomes large, and the circle grows into it from its small size. */
  private fun grow(rowKey: String) {
    val small = hostOf(rowKey)?.width() ?: return
    if (expandedKey == rowKey || small <= 0f) return
    expandedKey = rowKey
    onExpanded?.invoke(rowKey, true)
    afterLayout {
      if (key != rowKey || expandedKey != rowKey) return@afterLayout
      val frame = hostOf(rowKey) ?: return@afterLayout
      smallScale = minOf(1f, small / frame.width())
      place(frame)
      if (smallScale >= 1f || !com.linea.messenger.effects.Motion.enabled) return@afterLayout
      val right = anchorsRight?.invoke(rowKey) ?: true
      screen.pivotX = if (right) frame.width() else 0f
      screen.pivotY = frame.height()
      screen.scaleX = smallScale; screen.scaleY = smallScale
      screen.animate().scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(easeOutCubic).start()
    }
  }

  /** The listen is over: the circle shrinks back, then the slot gives its room back. `animated` false: at once. */
  private fun shrink(animated: Boolean) {
    val was = expandedKey
    if (was.isEmpty()) return
    screen.canScrub = false
    val finish = {
      if (expandedKey == was) {
        expandedKey = ""
        screen.animate().cancel()
        screen.scaleX = 1f; screen.scaleY = 1f
        onExpanded?.invoke(was, false)
        if (key == was) afterLayout { if (key == was) hostOf(was)?.let { place(it) } }
      }
    }
    if (!animated || smallScale >= 1f || screen.parent == null || !com.linea.messenger.effects.Motion.enabled) { finish(); return }
    val right = anchorsRight?.invoke(was) ?: true
    screen.pivotX = if (right) screen.width.toFloat() else 0f
    screen.pivotY = screen.height.toFloat()
    screen.animate().scaleX(smallScale).scaleY(smallScale).setDuration(200).setInterpolator(easeOutCubic).withEndAction { finish() }.start()
  }

  /** A rewind along the ring (VideoNote.tsx `scrubBegin` / `scrubTo` / `scrubEnd`). */
  private fun scrub(phase: String, share: Float) {
    val player = player ?: return
    if (!sound) return
    val total = try { player.duration } catch (_: IllegalStateException) { 0 }
    if (total <= 0) return
    if (phase == "begin") {
      resumeAfterScrub = !pausedByTap
      try { player.pause() } catch (_: Exception) {}
    }
    try { player.seekTo((total * share).toLong(), MediaPlayer.SEEK_CLOSEST) } catch (_: Exception) {}
    if (phase == "end") {
      if (resumeAfterScrub) {
        try { player.start(); if (VoicePlayer.rate != 1f) player.playbackParams = player.playbackParams.setSpeed(VoicePlayer.rate) } catch (_: Exception) {}
      } else pausedByTap = true
      screen.show(share, !resumeAfterScrub)
    }
  }
  private val main = Handler(Looper.getMainLooper())
  private val files = LinkedHashMap<String, MediaFetch.Brought>()
  private val isNote = HashMap<String, Boolean>()
  private val failed = HashSet<String>()
  private var player: MediaPlayer? = null
  private var surface: Surface? = null
  /** The player that was already given the surface and told to get ready. */
  private var given: MediaPlayer? = null
  private val screen = NotePlayerView(context)
  private var key = ""
  private var sound = false
  private var pausedByTap = false
  private var fetch: MediaFetch? = null
  private var fetchKey = ""
  private var fetchForSound = false
  private var focus: AudioFocusRequest? = null
  private var ticking = false
  /** What the list must show while a circle is being brought after a tap (null: nothing). */
  var onState: ((MsgMediaState?) -> Unit)? = null
  var onProblem: ((String) -> Unit)? = null
  /** A circle is about to sound: the voice message goes quiet. */
  var onWillPlay: (() -> Unit)? = null
  /** True while a take is recorded or a voice message plays: no silent loop starts then. */
  var holdsSilence: (() -> Boolean)? = null

  init {
    screen.picture.surfaceTextureListener = this
    screen.onScrub = { phase, share -> scrub(phase, share) }
    screen.onTap = { val current = key; AttachmentStore.attachment(current)?.let { toggle(current, it) } }
  }

  private fun note(rowKey: String): Map<String, Any?>? {
    val attachment = AttachmentStore.attachment(rowKey) ?: return null
    isNote[rowKey]?.let { return if (it) attachment else null }
    val yes = FileCore.call("mediaKind", listOf(attachment - "preview")) as? String == "note"
    if (isNote.size > 2000) isNote.clear()
    isNote[rowKey] = yes
    return if (yes) attachment else null
  }

  private val ticker = object : Runnable {
    override fun run() {
      if (!ticking) return
      val player = player
      if (player != null && sound) {
        val total = try { player.duration } catch (_: IllegalStateException) { 0 }
        val position = try { player.currentPosition } catch (_: IllegalStateException) { 0 }
        screen.show(if (total > 0) position.toFloat() / total else 0f, pausedByTap)
        // VideoNote.tsx `playedSeconds`: whole seconds, never past the length.
        val played = (minOf(position, if (total > 0) total else position) / 1000).coerceAtLeast(0)
        screen.showPill(FileCore.call("voiceTime", listOf(played * 1000.0)) as? String ?: "0:00", muted = false)
      }
      main.postDelayed(this, 100)
    }
  }

  private fun tick(on: Boolean) {
    main.removeCallbacks(ticker)
    ticking = on
    if (on) main.postDelayed(ticker, 100)
  }

  private fun drop() {
    shrink(animated = false)
    tick(false)
    player?.let { old ->
      old.setOnCompletionListener(null)
      old.setOnPreparedListener(null)
      try { old.stop() } catch (_: Exception) {}
      try { old.release() } catch (_: Exception) {}
    }
    player = null
    given = null
    quietFocus()
    // A new surface for every circle: the last picture of the previous one is never shown under the next.
    (screen.parent as? ViewGroup)?.removeView(screen)
    screen.translationX = 0f
    screen.translationY = 0f
    if (key.isNotEmpty() && hostedKeys.remove(key)) onReadyChanged?.invoke(key)
    key = ""
    sound = false
    pausedByTap = false
  }

  /** Puts the circle over its row's picture. While the list moves, the view is only shifted: nothing is laid out again. */
  private fun place(frame: RectF) {
    val left = Math.round(frame.left); val top = Math.round(frame.top)
    val width = Math.round(frame.width()); val height = Math.round(frame.height())
    val params = screen.layoutParams as? FrameLayout.LayoutParams
    if (screen.parent !== list || params == null) {
      (screen.parent as? ViewGroup)?.removeView(screen)
      screen.translationX = 0f
      screen.translationY = 0f
      list.addView(screen, FrameLayout.LayoutParams(width, height).apply { leftMargin = left; topMargin = top })
    } else if (params.width != width || params.height != height) {
      params.width = width; params.height = height; params.leftMargin = left; params.topMargin = top
      screen.translationX = 0f
      screen.translationY = 0f
      screen.layoutParams = params
    } else {
      screen.translationX = (left - params.leftMargin).toFloat()
      screen.translationY = (top - params.topMargin).toFloat()
    }
  }

  /** Starts the circle of `rowKey` in its row: silently looping, or from the start with sound. */
  private fun start(rowKey: String, file: File, withSound: Boolean) {
    drop()
    val frame = hostOf(rowKey) ?: return
    val made = MediaPlayer()
    try {
      made.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
      made.setDataSource(file.absolutePath)
      made.setVolume(if (withSound) 1f else 0f, if (withSound) 1f else 0f)
      made.isLooping = !withSound
    } catch (_: Exception) {
      try { made.release() } catch (_: Exception) {}
      failed.add(rowKey)
      if (withSound) onProblem?.invoke("Не удалось воспроизвести видео.")
      return
    }
    player = made
    key = rowKey
    hostedKeys.add(rowKey)
    onReadyChanged?.invoke(rowKey)
    sound = withSound
    pausedByTap = false
    screen.show(0f, false)
    screen.canScrub = withSound
    // VideoNote.tsx: the seconds played while it is listened to, the length and the speaker-off mark while it loops.
    screen.showPill(if (withSound) "0:00" else length(AttachmentStore.attachment(rowKey)), muted = !withSound)
    place(frame)
    if (withSound) grow(rowKey)
    made.setOnVideoSizeChangedListener { _, width, height -> if (made === player) screen.setVideoSize(width, height) }
    made.setOnCompletionListener { if (made === player) reachedEnd() }
    made.setOnErrorListener { _, _, _ ->
      if (made === player) { failed.add(rowKey); drop() }
      true
    }
    made.setOnPreparedListener {
      if (made !== player) return@setOnPreparedListener
      screen.setVideoSize(made.videoWidth, made.videoHeight)
      try {
        made.start()
        if (sound && VoicePlayer.rate != 1f) made.playbackParams = made.playbackParams.setSpeed(VoicePlayer.rate)
      } catch (_: Exception) {}
    }
    if (withSound) {
      onWillPlay?.invoke()
      if (MusicPlayer.shared.current != null) MusicPlayer.shared.stop()
      takeFocus()
      tick(true)
    }
    // The picture needs the view's surface: the player is made ready as soon as there is one.
    surface?.let { ready(made, it) }
  }

  private fun ready(made: MediaPlayer, surface: Surface) {
    if (given === made) return
    given = made
    try {
      made.setSurface(surface)
      made.prepareAsync()
    } catch (_: Exception) {
      if (made === player) { failed.add(key); drop() }
    }
  }

  override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
    surface?.release()
    val made = Surface(texture)
    surface = made
    player?.let { ready(it, made) }
  }

  override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) {}
  override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {}

  override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
    surface?.release()
    surface = null
    // The view left the screen with the chat: the player has nothing to draw on (stopped a moment later — the
    // views are not rearranged while the window takes them apart).
    val was = player
    if (was != null) main.post { if (player === was) drop() }
    return true
  }

  /** A take is about to be recorded: nothing moves meanwhile. */
  fun rest() {
    drop()
  }

  private fun reachedEnd() {
    val player = player ?: return
    // After a listen: from the first frame again, without sound (a silent round repeats by itself).
    if (!sound) return
    sound = false
    pausedByTap = false
    tick(false)
    quietFocus()
    screen.show(0f, false)
    screen.showPill(length(AttachmentStore.attachment(key)), muted = true)
    shrink(animated = true)
    try {
      player.setVolume(0f, 0f)
      player.isLooping = true
      player.seekTo(0)
      player.start()
      player.playbackParams = player.playbackParams.setSpeed(1f)
    } catch (_: Exception) { drop() }
  }

  /** A tap on a circle. */
  fun toggle(rowKey: String, attachment: Map<String, Any?>) {
    val player = player
    if (rowKey == key && player != null) {
      if (!sound) {
        files[rowKey]?.let { start(rowKey, it.file, withSound = true) }
      } else if (pausedByTap) {
        onWillPlay?.invoke()
        pausedByTap = false
        takeFocus()
        try {
          player.start()
          if (VoicePlayer.rate != 1f) player.playbackParams = player.playbackParams.setSpeed(VoicePlayer.rate)
        } catch (_: Exception) {}
        screen.showPause(false)
      } else {
        pausedByTap = true
        try { player.pause() } catch (_: Exception) {}
        screen.showPause(true)
      }
      return
    }
    files[rowKey]?.let { return start(rowKey, it.file, withSound = true) }
    if (fetchKey == rowKey && fetch != null) {
      // VideoNote.tsx: a tap while it loads asks to play when ready; a second tap cancels the download.
      if (fetchForSound) {
        fetch?.cancel()
        fetch = null
        fetchKey = ""
        fetchForSound = false
        onState?.invoke(null)
      } else {
        fetchForSound = true
        publish(rowKey, 0)
      }
      return
    }
    failed.remove(rowKey)
    bring(rowKey, attachment, forSound = true)
  }

  private fun bring(rowKey: String, attachment: Map<String, Any?>, forSound: Boolean) {
    val server = server ?: return
    fetch?.cancel()
    val made = MediaFetch()
    fetch = made
    fetchKey = rowKey
    fetchForSound = forSound
    if (forSound) publish(rowKey, 0)
    made.start(context.applicationContext, server, attachment, progress = { part ->
      if (fetch === made && fetchForSound) publish(rowKey, (part * 100).toInt())
    }, done = { result ->
      if (fetch !== made) {
        result.getOrNull()?.folder?.deleteRecursively()
        return@start
      }
      val wanted = fetchForSound
      fetch = null
      fetchKey = ""
      onState?.invoke(null)
      val brought = result.getOrNull()
      if (brought == null) {
        failed.add(rowKey)
        if (wanted) onProblem?.invoke(FileCore.words(result))
        return@start
      }
      if (files.size >= 6) files.keys.firstOrNull { it != rowKey && it != key }?.let { old ->
        files.remove(old)?.folder?.deleteRecursively()
        readyKeys.remove(old)
        onReadyChanged?.invoke(old)
      }
      files[rowKey] = brought
      readyKeys.add(rowKey)
      onReadyChanged?.invoke(rowKey)
      if (wanted) start(rowKey, brought.file, withSound = true) else refresh()
    })
  }

  private fun publish(rowKey: String, percent: Int) {
    onState?.invoke(MsgMediaState(key = rowKey, loading = true, progress = percent / 100f, time = "$percent %"))
  }

  /** The rows moved: the playing circle follows its row (nothing else is decided here). */
  fun follow() {
    if (key.isEmpty()) return
    hostOf(key)?.let { place(it) }
  }

  /** The rows on screen changed or moved: the playing circle follows its row or stops when the row is gone,
   *  and a circle that came into view starts its silent loop. */
  fun refresh() {
    if (server == null) return
    if (key.isNotEmpty()) {
      val frame = hostOf(key)
      if (frame != null) {
        place(frame)
        return
      }
      drop()
    }
    if (fetchForSound && fetch != null) return
    if (holdsSilence?.invoke() == true || MusicPlayer.shared.current != null) return
    for (rowKey in keysOnScreen()) {
      val attachment = note(rowKey) ?: continue
      if (hostOf(rowKey) == null) continue
      files[rowKey]?.let { return start(rowKey, it.file, withSound = false) }
      if (fetch == null && !failed.contains(rowKey) && ((attachment["size"] as? Number)?.toLong() ?: Long.MAX_VALUE) <= unasked) {
        bring(rowKey, attachment, forSound = false)
        return
      }
    }
  }

  /** Something else is about to sound: a circle that is listened to goes quiet. */
  fun quiet() {
    // playback.ts `interrupt`: a voice message, music or another circle took the sound — the circle goes back to
    // its silent loop from the first frame and shrinks.
    if (player == null || !sound) return
    pausedByTap = false
    reachedEnd()
  }

  /** The chat is left: everything stops, the decrypted copies go. */
  fun left() {
    fetch?.cancel()
    fetch = null
    fetchKey = ""
    drop()
    onState?.invoke(null)
    for ((rowKey, file) in files) { file.folder.deleteRecursively(); readyKeys.remove(rowKey) }
    files.clear()
  }

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) main.post { quiet() }
  }

  private fun takeFocus() {
    if (focus != null) return
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
      .setOnAudioFocusChangeListener(focusListener, main).build()
    try { manager.requestAudioFocus(request); focus = request } catch (_: Exception) {}
  }

  private fun quietFocus() {
    val request = focus ?: return
    focus = null
    try { (context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.abandonAudioFocusRequest(request) } catch (_: Exception) {}
  }

  /** The length of a circle as its pill shows it at rest. */
  private fun length(attachment: Map<String, Any?>?): String {
    val ms = (Core.map(attachment?.get("media"))?.get("durationMs") as? Number)?.toDouble() ?: 0.0
    return FileCore.call("voiceTime", listOf(ms)) as? String ?: "0:00"
  }

  companion object {
    private const val unasked = 8L * 1024 * 1024
    /** Rows whose circle is brought and decrypted (any list): drawn without the download mark, with the
     *  speaker-off mark in their pill (VideoNote.tsx `ready`). Main thread only. */
    val readyKeys = HashSet<String>()
    /** Rows a player stands over right now: the row draws no resting marks under it. */
    val hostedKeys = HashSet<String>()
  }
}
