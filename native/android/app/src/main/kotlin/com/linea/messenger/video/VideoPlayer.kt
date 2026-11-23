package com.linea.messenger.video

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.app.Dialog
import android.app.PictureInPictureParams
import android.content.ClipData
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Rational
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.attachments.KitIcon
import com.linea.messenger.attachments.KitIcons
import com.linea.messenger.design.Theme
import com.linea.messenger.music.MusicPlayer
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.roundToInt

/** Media: the reference's playerModel.ts — the numbers and decisions of the player, ported as they are (as
 *  native/ios/Sources/Video/VideoPlayer.swift `PlayerModel`). Plain values, so they can be checked without a phone.
 *  Times in seconds, places as 0…1. */
object PlayerModel {
  const val hideMs = 3.0
  const val doubleTap = 0.3
  const val doubleTapSlop = 110f
  const val seekStep = 10.0
  const val seekBurst = 0.7
  const val hold = 0.5
  const val holdRate = 2f
  const val finePull = 70f
  const val fineFactor = 0.2f
  const val scrubSeek = 0.1
  val speeds = floatArrayOf(0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)
  const val tooltipMin = 0.18f
  const val tooltipMax = 0.82f

  /** «0:07», «12:40», «75:03». */
  fun clock(seconds: Double): String {
    val value = maxOf(0, if (seconds.isFinite()) seconds.toInt() else 0)
    return "${value / 60}:" + String.format(java.util.Locale.ROOT, "%02d", value % 60)
  }

  /** «Обычная» for 1, otherwise «1.5×». */
  fun speedLabel(speed: Float): String {
    if (speed == 1f) return "Обычная"
    val text = if (speed == speed.toInt().toFloat()) speed.toInt().toString() else speed.toString().trimEnd('0').trimEnd('.')
    return "$text×"
  }

  fun seekTarget(current: Double, duration: Double, delta: Double): Double {
    val length = if (duration.isFinite() && duration > 0) duration else 0.0
    return ((if (current.isFinite()) current else 0.0) + delta).coerceIn(0.0, length)
  }

  fun fraction(time: Double, duration: Double): Float = if (duration <= 0 || !time.isFinite()) 0f else (time / duration).coerceIn(0.0, 1.0).toFloat()

  data class TapState(val lastTime: Double = -1e12, val lastX: Float = 0f, val acc: Double = 0.0, val side: Int = 0, val accTime: Double = -1e12)

  fun burstActive(state: TapState, time: Double): Boolean = state.acc > 0 && time - state.accTime <= seekBurst

  /** The reference's `tapStep`: −1 / 1 seek now (the burst total in `acc`), 0 a possible single tap. */
  fun tapStep(state: TapState, x: Float, time: Double, width: Float): Pair<TapState, Int> {
    val side = if (x < width / 2) -1 else 1
    val continues = burstActive(state, time) && side == state.side
    val double = time - state.lastTime < doubleTap && abs(x - state.lastX) < doubleTapSlop
    if (continues || double) return TapState(time, x, (if (continues) state.acc else 0.0) + seekStep, side, time) to side
    return state.copy(lastTime = time, lastX = x) to 0
  }

  fun fractionAt(x: Float, width: Float): Float = if (width <= 0 || !x.isFinite()) 0f else (x / width).coerceIn(0f, 1f)

  fun scrubMove(position: Float, dx: Float, width: Float, fine: Boolean): Float =
    if (width <= 0 || !dx.isFinite()) position else (position + dx / width * (if (fine) fineFactor else 1f)).coerceIn(0f, 1f)

  fun tooltipCenter(position: Float, width: Float): Float = position.coerceIn(tooltipMin, tooltipMax) * width

  fun thumbTime(time: Double, duration: Double): Double {
    if (duration <= 0 || !time.isFinite()) return 0.0
    val step = maxOf(0.5, duration / 120)
    return (kotlin.math.floor(time / step + 0.5) * step).coerceIn(0.0, duration)
  }

  fun chevronOpacity(phase: Double, index: Int, forward: Boolean): Float {
    val order = (if (forward) index else 2 - index).toDouble()
    val local = (((phase - order * 0.2) % 1) + 1) % 1
    if (local < 0.3) return (0.25 + 0.75 * (local / 0.3)).toFloat()
    if (local < 0.7) return (1 - 0.75 * ((local - 0.3) / 0.4)).toFloat()
    return 0.25f
  }
}

/** Media: the reference's own full-screen video player (media/VideoPlayerView.tsx; native/ios/Sources/Video/
 *  VideoPlayer.swift): its controls over a bare picture. One tap shows or hides them (they hide by themselves while
 *  it plays); a double tap on a side seeks ±10 s and more taps gather «20 секунд», «30 секунд»; press and hold plays
 *  at 2×; the bar seeks precisely when the finger is pulled up; the gear opens its sheet — speed, «Заблокировать
 *  экран», «Картинка в картинке», «Сохранить для просмотра без сети», «Поделиться». The decrypted copy goes when it
 *  closes (a kept one stays). */
@SuppressLint("ViewConstructor")
class VideoPlayer(context: Context, private val file: File, private val folder: File?, private val attachment: Map<String, Any?>?) :
  Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen), TextureView.SurfaceTextureListener {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = (value * d).roundToInt()
  private val main = Handler(Looper.getMainLooper())
  private val player = MediaPlayer()
  private val surface = TextureView(context)
  private var prepared = false
  private var failed = false
  private var videoWidth = 0
  private var videoHeight = 0
  private var shown = true
  private var locked = false
  private var speed = 1f
  private var fill = false
  private var ended = false
  private var holding = false
  private var dragging = false
  private var fine = false
  private var sheetOpen = false
  private var settleUntil = 0L
  private var lastSeek = 0L
  private var taps = PlayerModel.TapState()
  private var position = 0f
  private var dragStartY = 0f
  private var dragLastX = 0f
  private var keepBusy = false
  /** The kept copy was removed while it played: deleted once the player is gone. */
  private var forgetKept = false
  private var inPip = false
  private var cleaned = false
  private val frames = LinkedHashMap<Double, Bitmap>()
  private var frameBusy = false
  private var frameWanted: Double? = null
  private var framesOff = false
  private var retriever: MediaMetadataRetriever? = null

  private val touchSurface = View(context)
  private val spinner = ProgressBar(context)
  private val errorLabel = TextView(context)
  private val controls = FrameLayout(context)
  private val closeButton = KitIcon(context, "chevron.down", 24f, Color.WHITE)
  private val pipButton = KitIcon(context, "pip", 21f, Color.WHITE)
  private val gearButton = KitIcon(context, "gear", 22f, Color.WHITE)
  private val playButton = KitIcon(context, "play", 34f, Color.WHITE)
  private val clockLabel = TextView(context)
  private val fillButton = KitIcon(context, "resize", 19f, Color.WHITE)
  private val bar = SeekBar()
  private val tooltip = LinearLayout(context)
  private val tooltipFrame = ImageView(context)
  private val tooltipTime = TextView(context)
  private val scrubHint = TextView(context)
  private val hairline = SeekLine()
  private val holdPill = TextView(context)
  private val noteBox = TextView(context)
  private val seekSide = SeekSide()
  private val sheetDim = View(context)
  private val sheet = LinearLayout(context)
  private val sheetRows = LinearLayout(context)

  private val activity: Activity? get() { var owner: Context? = context; while (owner is ContextWrapper && owner !is Activity) owner = owner.baseContext; return owner as? Activity }

  private val root = object : FrameLayout(context) {
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) { super.onLayout(changed, l, t, r, b); place(r - l, b - t) }
  }

  init {
    root.setBackgroundColor(Color.BLACK)
    root.clipChildren = true
    surface.surfaceTextureListener = this
    root.addView(surface, FrameLayout.LayoutParams(-1, -1))
    // The touch surface is a sheet of its own; the controls above it take their own touches.
    touchSurface.contentDescription = "Скрыть управление"
    touchSurface.setOnTouchListener { _, event -> touched(event); true }
    root.addView(touchSurface, FrameLayout.LayoutParams(-1, -1))
    root.addView(seekSide, FrameLayout.LayoutParams(-1, -1))
    seekSide.visibility = View.GONE
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.accent)
    root.addView(spinner, FrameLayout.LayoutParams(dp(48f), dp(48f), Gravity.CENTER))
    errorLabel.textSize = 14f; errorLabel.setTextColor(Theme.danger); errorLabel.gravity = Gravity.CENTER; errorLabel.visibility = View.GONE
    root.addView(errorLabel, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER).apply { leftMargin = dp(16f); rightMargin = dp(16f) })

    controls.setBackgroundColor(0x80000000.toInt())
    root.addView(controls, FrameLayout.LayoutParams(-1, -1))
    closeButton.contentDescription = "Закрыть просмотр"
    closeButton.setOnClickListener { dismiss() }
    pipButton.contentDescription = "Картинка в картинке"
    pipButton.setOnClickListener { startPip() }
    pipButton.visibility = if (pipPossible()) View.VISIBLE else View.GONE
    gearButton.contentDescription = "Настройки"
    gearButton.setOnClickListener { openSheet(false) }
    playButton.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x4D000000) }
    playButton.setOnClickListener { toggle() }
    clockLabel.textSize = 12.5f; clockLabel.typeface = Theme.weight(500); clockLabel.fontFeatureSettings = "tnum"; clockLabel.setTextColor(Color.WHITE)
    clockLabel.gravity = Gravity.CENTER
    clockLabel.setPadding(dp(8f), 0, dp(8f), 0)
    clockLabel.background = GradientDrawable().apply { setColor(0x4D000000); cornerRadius = 14f * d }
    fillButton.setOnClickListener { toggleFill() }
    for (view in listOf(closeButton, pipButton, gearButton, playButton, clockLabel, fillButton, bar)) controls.addView(view, FrameLayout.LayoutParams(0, 0))
    bar.contentDescription = "Позиция воспроизведения"
    tooltip.orientation = LinearLayout.VERTICAL
    tooltip.gravity = Gravity.CENTER_HORIZONTAL
    tooltipFrame.scaleType = ImageView.ScaleType.CENTER_CROP
    tooltipFrame.background = GradientDrawable().apply { setColor(Color.BLACK); cornerRadius = 8f * d; setStroke(dp(2f), Color.WHITE) }
    tooltipFrame.clipToOutline = true
    tooltip.addView(tooltipFrame, LinearLayout.LayoutParams(0, 0))
    tooltipTime.textSize = 13f; tooltipTime.typeface = Theme.weight(500); tooltipTime.fontFeatureSettings = "tnum"; tooltipTime.setTextColor(Color.WHITE); tooltipTime.gravity = Gravity.CENTER
    tooltipTime.setShadowLayer(3f * d, 0f, d, Color.BLACK)
    tooltip.addView(tooltipTime, LinearLayout.LayoutParams(-1, dp(18f)).apply { topMargin = dp(6f) })
    tooltip.visibility = View.GONE
    controls.addView(tooltip, FrameLayout.LayoutParams(0, 0))
    scrubHint.textSize = 13f; scrubHint.typeface = Theme.weight(500); scrubHint.setTextColor(Color.WHITE); scrubHint.gravity = Gravity.CENTER
    scrubHint.setShadowLayer(3f * d, 0f, d, Color.BLACK)
    scrubHint.visibility = View.GONE
    controls.addView(scrubHint, FrameLayout.LayoutParams(0, 0))
    root.addView(hairline, FrameLayout.LayoutParams(-1, dp(2f), Gravity.BOTTOM))
    holdPill.text = "${PlayerModel.holdRate.toInt()}× ▶▶"
    holdPill.textSize = 14f; holdPill.typeface = Theme.weight(500); holdPill.setTextColor(Color.WHITE); holdPill.gravity = Gravity.CENTER
    holdPill.setPadding(dp(14f), 0, dp(14f), 0)
    holdPill.background = GradientDrawable().apply { setColor(0x99000000.toInt()); cornerRadius = 18f * d }
    holdPill.visibility = View.GONE
    root.addView(holdPill, FrameLayout.LayoutParams(-2, dp(34f), Gravity.CENTER_HORIZONTAL))
    noteBox.textSize = 13f; noteBox.typeface = Theme.weight(500); noteBox.setTextColor(Color.WHITE); noteBox.gravity = Gravity.CENTER
    noteBox.setPadding(dp(14f), dp(8f), dp(14f), dp(8f))
    noteBox.background = GradientDrawable().apply { setColor(0xA6000000.toInt()); cornerRadius = 18f * d }
    noteBox.visibility = View.GONE
    root.addView(noteBox, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL))
    sheetDim.setBackgroundColor(0x66000000)
    sheetDim.contentDescription = "Закрыть"
    sheetDim.setOnClickListener { closeSheet(null) }
    sheetDim.visibility = View.GONE
    root.addView(sheetDim, FrameLayout.LayoutParams(-1, -1))
    sheet.orientation = LinearLayout.VERTICAL
    sheet.background = GradientDrawable().apply { setColor(0xFF212121.toInt()); cornerRadius = 14f * d }
    sheet.setPadding(0, dp(10f), 0, dp(8f))
    sheet.addView(View(context).apply { background = GradientDrawable().apply { setColor(0xFF555555.toInt()); cornerRadius = 2f * d } }, LinearLayout.LayoutParams(dp(40f), dp(4f)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(8f) })
    sheetRows.orientation = LinearLayout.VERTICAL
    sheet.addView(sheetRows, LinearLayout.LayoutParams(-1, -2))
    sheet.visibility = View.GONE
    sheet.isClickable = true
    root.addView(sheet, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))

    setContentView(root)
    window?.apply {
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      statusBarColor = Color.BLACK
      navigationBarColor = Color.BLACK
    }
    player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
    player.setOnPreparedListener { readyToPlay() }
    player.setOnVideoSizeChangedListener { _, width, height -> videoWidth = width; videoHeight = height; fit(); updatePipParams() }
    player.setOnCompletionListener { ended = true; shown = true; main.removeCallbacks(hideTask); paint(); show(true) }
    player.setOnErrorListener { _, _, _ ->
      failed = true
      spinner.visibility = View.GONE
      errorLabel.visibility = View.VISIBLE
      errorLabel.text = "Устройство не смогло воспроизвести это видео. Можно сохранить файл и открыть совместимым проигрывателем."
      paint()
      true
    }
    try { player.setDataSource(file.absolutePath); player.prepareAsync() } catch (_: Exception) { player.setOnErrorListener(null); failed = true; errorLabel.visibility = View.VISIBLE; errorLabel.text = "Устройство не смогло воспроизвести это видео. Можно сохранить файл и открыть совместимым проигрывателем." }
    setOnShowListener {
      if (MusicPlayer.shared.current != null) MusicPlayer.shared.stop()
      current = this
      watchActivity()
      updatePipParams()
    }
    setOnDismissListener { closed() }
    paint()
  }

  // The surface

  private var videoSurface: Surface? = null

  override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
    videoSurface = Surface(texture)
    try { player.setSurface(videoSurface) } catch (_: Exception) {}
    fit()
  }
  override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = fit()
  override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean { try { player.setSurface(null) } catch (_: Exception) {}; videoSurface?.release(); videoSurface = null; return true }
  override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {}

  /** The picture whole in the screen, or filling it («Масштаб по экрану»). */
  private fun fit() {
    val width = surface.width.toFloat(); val height = surface.height.toFloat()
    if (width <= 0 || height <= 0 || videoWidth <= 0 || videoHeight <= 0) return
    val scaleToFit = minOf(width / videoWidth, height / videoHeight)
    val scaleToFill = maxOf(width / videoWidth, height / videoHeight)
    val scale = if (fill) scaleToFill else scaleToFit
    val matrix = Matrix()
    // The system stretches the picture over the whole view; it is brought back to its own shape here.
    matrix.setScale(videoWidth * scale / width, videoHeight * scale / height, width / 2, height / 2)
    surface.setTransform(matrix)
  }

  // The player's state

  private val duration: Double get() = if (prepared) maxOf(0, player.duration) / 1000.0 else 0.0
  private val currentTime: Double get() = if (prepared) try { player.currentPosition / 1000.0 } catch (_: Exception) { 0.0 } else 0.0
  private val playing: Boolean get() = prepared && !ended && try { player.isPlaying } catch (_: Exception) { false }

  private fun readyToPlay() {
    prepared = true
    spinner.visibility = View.GONE
    applyRate(speed)
    try { player.start() } catch (_: Exception) {}
    main.post(ticker)
    show(true)
    paint()
  }

  private fun applyRate(rate: Float) {
    if (!prepared) return
    try {
      val playingNow = player.isPlaying
      player.playbackParams = player.playbackParams.setSpeed(rate)
      // Changing the speed starts a paused player on some phones: it is held as it was.
      if (!playingNow && player.isPlaying) player.pause()
    } catch (_: Exception) {}
  }

  private val ticker = object : Runnable {
    override fun run() {
      if (!prepared || cleaned) return
      if (!dragging && SystemClock.uptimeMillis() >= settleUntil) {
        position = PlayerModel.fraction(currentTime, duration)
        paintTime(currentTime)
      }
      main.postDelayed(this, 250)
    }
  }

  private fun seek(seconds: Double): Double {
    val length = duration
    val target = seconds.coerceIn(0.0, length)
    try {
      if (Build.VERSION.SDK_INT >= 26) player.seekTo((target * 1000).toLong(), MediaPlayer.SEEK_CLOSEST) else player.seekTo((target * 1000).toInt())
    } catch (_: Exception) {}
    if (target < length - 0.25) ended = false
    return target
  }

  // Showing and hiding

  private val noteTask = Runnable { noteBox.visibility = View.GONE }
  private val hideTask = Runnable { if (!dragging && !sheetOpen) show(false) }

  /** The emulator check: a note and the seek highlight stay up for the screenshot taken seconds later. */
  private var demoHold = false

  private fun say(words: String) {
    noteBox.text = words
    noteBox.visibility = View.VISIBLE
    main.removeCallbacks(noteTask)
    if (!demoHold) main.postDelayed(noteTask, 1500)
    root.requestLayout()
  }

  private fun show(on: Boolean) {
    if (on && locked) { say(LOCKED_NOTE); return }
    shown = on
    main.removeCallbacks(hideTask)
    if (on && playing && !dragging) main.postDelayed(hideTask, (PlayerModel.hideMs * 1000).toLong())
    controls.animate().alpha(if (shown && !inPip) 1f else 0f).setDuration(180).start()
    controls.visibility = View.VISIBLE
    setControlsTouchable(shown && !locked && !inPip)
    hairline.visibility = if (shown || inPip) View.GONE else View.VISIBLE
    touchSurface.contentDescription = if (shown) "Скрыть управление" else "Показать управление"
  }

  private fun setControlsTouchable(on: Boolean) {
    for (index in 0 until controls.childCount) controls.getChildAt(index).isEnabled = on
    controls.isClickable = false
    controlsLive = on
  }
  private var controlsLive = true

  private fun paint() {
    playButton.symbol = if (ended) "replay" else if (playing) "pause" else "play"
    playButton.contentDescription = if (ended) "Смотреть сначала" else if (playing) "Пауза" else "Воспроизвести"
    playButton.visibility = if (dragging) View.GONE else View.VISIBLE
    playButton.invalidate()
    fillButton.symbol = if (fill) "shrink" else "resize"
    fillButton.contentDescription = if (fill) "Исходный размер" else "Масштаб по экрану"
    fillButton.invalidate()
    holdPill.visibility = if (holding) View.VISIBLE else View.GONE
    scrubHint.visibility = if (dragging) View.VISIBLE else View.GONE
    scrubHint.text = if (fine) "Точная перемотка" else "Потяни вверх для точной перемотки"
    tooltip.visibility = if (dragging) View.VISIBLE else View.GONE
    bar.dragging = dragging
    paintTime(position * duration)
    root.requestLayout()
  }

  private fun paintTime(seconds: Double) {
    val words = android.text.SpannableStringBuilder(PlayerModel.clock(seconds))
    val start = words.length
    words.append(" / " + PlayerModel.clock(duration))
    words.setSpan(android.text.style.ForegroundColorSpan(0xB3FFFFFF.toInt()), start, words.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    clockLabel.text = words
    tooltipTime.text = PlayerModel.clock(seconds)
    bar.position = position
    if (Build.VERSION.SDK_INT >= 30) bar.stateDescription = PlayerModel.clock(seconds)
    hairline.position = position
    if (dragging) placeTooltip()
  }

  // Buttons

  private fun toggle() {
    if (!prepared) return
    try {
      if (ended) { seek(0.0); player.start(); applyRate(speed); ended = false }
      else if (player.isPlaying) player.pause()
      else { player.start(); applyRate(speed) }
    } catch (_: Exception) {}
    show(true)
    paint()
  }

  private fun toggleFill() {
    fill = !fill
    fit()
    say(if (fill) "Масштаб по экрану" else "Исходный размер")
    show(true)
    paint()
  }

  private fun pipPossible(): Boolean = Build.VERSION.SDK_INT >= 26 && context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE)

  private fun pipParams(): PictureInPictureParams? {
    if (Build.VERSION.SDK_INT < 26) return null
    val builder = PictureInPictureParams.Builder()
    if (videoWidth > 0 && videoHeight > 0) {
      val ratio = (videoWidth.toFloat() / videoHeight).coerceIn(1 / 2.39f, 2.39f)
      builder.setAspectRatio(Rational((ratio * 1000).roundToInt(), 1000))
    }
    // As the iPhone's player: leaving the app while the film plays opens the small window by itself.
    if (Build.VERSION.SDK_INT >= 31) builder.setAutoEnterEnabled(isShowing && !cleaned)
    return builder.build()
  }

  private fun updatePipParams() {
    if (!pipPossible()) return
    val params = pipParams() ?: return
    try { activity?.setPictureInPictureParams(params) } catch (_: Exception) {}
  }

  private fun startPip() {
    val window = activity
    val params = pipParams()
    val started = pipPossible() && window != null && params != null && try { window.enterPictureInPictureMode(params) } catch (_: Exception) { false }
    if (!started) say("Окно не открылось")
  }

  /** The window went into the small window or came back from it (MainActivity tells, see `pipChanged`). */
  private fun pipMode(on: Boolean) {
    inPip = on
    if (on) { main.removeCallbacks(hideTask); controls.alpha = 0f; sheet.visibility = View.GONE; sheetDim.visibility = View.GONE; noteBox.visibility = View.GONE; hairline.visibility = View.GONE }
    else show(true)
    setControlsTouchable(!on && shown && !locked)
  }

  private var lifecycle: Application.ActivityLifecycleCallbacks? = null

  /** Leaving the app without the small window pauses the film; closing the small window too. */
  private fun watchActivity() {
    val owner = activity ?: return
    val callbacks = object : Application.ActivityLifecycleCallbacks {
      override fun onActivityStopped(stopped: Activity) {
        if (stopped !== owner) return
        val pip = Build.VERSION.SDK_INT >= 24 && stopped.isInPictureInPictureMode
        if (!pip) try { if (player.isPlaying) player.pause(); paint() } catch (_: Exception) {}
      }
      override fun onActivityDestroyed(destroyed: Activity) { if (destroyed === owner) cleanUp() }
      override fun onActivityCreated(created: Activity, state: Bundle?) {}
      override fun onActivityStarted(started: Activity) {}
      override fun onActivityResumed(resumed: Activity) {}
      override fun onActivityPaused(paused: Activity) {}
      override fun onActivitySaveInstanceState(saved: Activity, state: Bundle) {}
    }
    owner.application.registerActivityLifecycleCallbacks(callbacks)
    lifecycle = callbacks
  }

  // Taps and the hold on the picture

  private var downAt = 0L
  private var downX = 0f
  private var downY = 0f
  private val holdTask = Runnable { held(true) }
  private val singleTap = Runnable { if (!PlayerModel.burstActive(taps, now())) show(!shown) }

  private fun now() = SystemClock.uptimeMillis() / 1000.0

  private fun touched(event: MotionEvent) {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { downAt = event.eventTime; downX = event.x; downY = event.y; main.postDelayed(holdTask, (PlayerModel.hold * 1000).toLong()) }
      MotionEvent.ACTION_MOVE -> if (!holding && (abs(event.x - downX) > 24 * d || abs(event.y - downY) > 24 * d)) main.removeCallbacks(holdTask)
      MotionEvent.ACTION_UP -> {
        main.removeCallbacks(holdTask)
        if (holding || heldUnlock) { held(false); heldUnlock = false; return }
        if (event.eventTime - downAt < (PlayerModel.hold * 1000).toLong()) tapped(event.x)
      }
      MotionEvent.ACTION_CANCEL -> { main.removeCallbacks(holdTask); if (holding) held(false) }
    }
  }

  private fun tapped(x: Float) {
    if (locked) { say(LOCKED_NOTE); return }
    val (state, side) = PlayerModel.tapStep(taps, x, now(), root.width.toFloat())
    taps = state
    main.removeCallbacks(singleTap)
    if (side != 0) { seekTap(side, state.acc); return }
    // A lone tap: the double-tap window is waited out first (never in the middle of a seek burst).
    main.postDelayed(singleTap, (PlayerModel.doubleTap * 1000).toLong())
  }

  private val burstEnd = Runnable { seekSide.visibility = View.GONE; seekSide.running = false; taps = taps.copy(acc = 0.0, side = 0) }

  private fun seekTap(side: Int, seconds: Double) {
    // The controls step aside for the side highlight.
    shown = false
    main.removeCallbacks(hideTask)
    controls.alpha = 0f
    setControlsTouchable(false)
    hairline.visibility = View.VISIBLE
    val target = seek(PlayerModel.seekTarget(currentTime, duration, side * PlayerModel.seekStep))
    position = PlayerModel.fraction(target, duration)
    paintTime(target)
    settleUntil = SystemClock.uptimeMillis() + 400
    seekSide.show(side, seconds.toInt())
    seekSide.visibility = View.VISIBLE
    main.removeCallbacks(burstEnd)
    if (!demoHold) main.postDelayed(burstEnd, (PlayerModel.seekBurst * 1000).toLong())
  }

  private var heldUnlock = false

  private fun held(began: Boolean) {
    if (began) {
      if (locked) {
        locked = false
        heldUnlock = true
        say("Блокировка снята")
        root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        return
      }
      if (!playing) return
      holding = true
      applyRate(PlayerModel.holdRate)
      shown = false
      main.removeCallbacks(hideTask)
      controls.alpha = 0f
      setControlsTouchable(false)
      hairline.visibility = View.VISIBLE
      paint()
    } else {
      if (!holding) return
      holding = false
      applyRate(speed)
      paint()
    }
  }

  // The seek bar

  private fun scrubBegan(x: Float, y: Float) {
    if (!controlsLive) return
    dragging = true
    fine = false
    main.removeCallbacks(hideTask)
    dragStartY = y
    dragLastX = x
    position = PlayerModel.fractionAt(x, bar.width.toFloat())
    tooltipFrame.setImageDrawable(null)
    requestFrame(position * duration)
    paint()
  }

  private fun scrubMoved(x: Float, y: Float) {
    if (!dragging) return
    if (!fine && (dragStartY - y) / d > PlayerModel.finePull) { fine = true; bar.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) }
    position = PlayerModel.scrubMove(position, x - dragLastX, bar.width.toFloat(), fine)
    dragLastX = x
    val seconds = position * duration
    if (SystemClock.uptimeMillis() - lastSeek >= (PlayerModel.scrubSeek * 1000).toLong()) { lastSeek = SystemClock.uptimeMillis(); seek(seconds) }
    requestFrame(seconds)
    paint()
  }

  private fun scrubEnded() {
    if (!dragging) return
    val target = seek(position * duration)
    settleUntil = SystemClock.uptimeMillis() + 400
    dragging = false
    fine = false
    paintTime(target)
    show(true)
    paint()
  }

  /** One decode at a time, always for the newest place asked; at most 24 kept (the reference's FRAME_CACHE). */
  private fun requestFrame(seconds: Double) {
    if (framesOff) return
    val at = PlayerModel.thumbTime(seconds, duration)
    frames[at]?.let { frameWanted = null; tooltipFrame.setImageBitmap(it); placeTooltip(); return }
    frameWanted = at
    if (frameBusy) return
    frameBusy = true
    nextFrame()
  }

  private fun nextFrame() {
    val wanted = frameWanted
    if (wanted == null || !dragging) { frameBusy = false; return }
    frameWanted = null
    val path = file.absolutePath
    decoding.execute {
      val image = try {
        val source = retriever ?: MediaMetadataRetriever().also { it.setDataSource(path); retriever = it }
        val us = (wanted * 1_000_000).toLong()
        if (Build.VERSION.SDK_INT >= 27) source.getScaledFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 320, 320) else source.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
      } catch (_: Exception) { null }
      main.post {
        if (image == null) { framesOff = true; frameBusy = false; return@post }
        if (frames.size >= 24) frames.keys.firstOrNull()?.let { frames.remove(it) }
        frames[wanted] = image
        if (dragging) { tooltipFrame.setImageBitmap(image); placeTooltip() }
        nextFrame()
      }
    }
  }

  private fun placeTooltip() {
    val width = dp(180f)
    val center = PlayerModel.tooltipCenter(position, bar.width.toFloat())
    val drawable = tooltipFrame.drawable
    var frameW = 0; var frameH = 0
    if (drawable != null) { if (drawable.intrinsicWidth > drawable.intrinsicHeight) { frameW = dp(160f); frameH = dp(90f) } else { frameW = dp(120f); frameH = dp(160f) } }
    (tooltipFrame.layoutParams as LinearLayout.LayoutParams).let { it.width = frameW; it.height = frameH; tooltipFrame.layoutParams = it }
    tooltipFrame.visibility = if (frameH == 0) View.GONE else View.VISIBLE
    val height = frameH + (if (frameH > 0) dp(6f) else 0) + dp(18f)
    put(tooltip, (bar.left + center - width / 2).roundToInt(), bar.bottom - dp(44f) - height, width, height)
  }

  // The settings sheet

  private fun sheetRow(symbol: String?, words: String, value: String?, current: Boolean, enabled: Boolean = true, action: () -> Unit): View {
    val color = if (current) 0xFF3EA6FF.toInt() else Color.WHITE
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(dp(20f), 0, dp(20f), 0)
    row.addView(KitIcon(context, symbol ?: "", 20f, color).apply { isClickable = false }, LinearLayout.LayoutParams(dp(24f), dp(24f)))
    row.addView(TextView(context).apply { text = words; textSize = 16f; setTextColor(color) }, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(20f) })
    if (value != null) row.addView(TextView(context).apply { text = value; textSize = 16f; setTextColor(0xFFAAAAAA.toInt()) }, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(20f) }) // `gap: 20`
    row.contentDescription = if (value != null) "$words, $value" else words
    row.isSelected = current
    row.isEnabled = enabled
    row.alpha = if (enabled) 1f else 0.5f
    row.isClickable = true
    row.background = android.graphics.drawable.StateListDrawable().apply { addState(intArrayOf(android.R.attr.state_pressed), android.graphics.drawable.ColorDrawable(0x14FFFFFF)) }
    row.setOnClickListener { action() }
    return row
  }

  private fun openSheet(speeds: Boolean) {
    sheetOpen = true
    main.removeCallbacks(hideTask)
    sheetRows.removeAllViews()
    val add = { view: View -> sheetRows.addView(view, LinearLayout.LayoutParams(-1, dp(50f))) }
    if (speeds) {
      for (value in PlayerModel.speeds) add(sheetRow(if (value == speed) "check" else null, PlayerModel.speedLabel(value), null, value == speed) { chooseSpeed(value) })
    } else {
      add(sheetRow("speedometer", "Скорость воспроизведения", PlayerModel.speedLabel(speed), false) { openSheet(true) })
      add(sheetRow("lock", "Заблокировать экран", null, false) { lockScreen() })
      if (pipPossible()) add(sheetRow("pip", "Картинка в картинке", null, false) { closeSheet { startPip() } })
      attachment?.let { file ->
        val kept = KeptMedia.isKept(context, file) && !forgetKept
        add(sheetRow(if (kept) "check.circle" else "download", if (kept) "Сохранено для просмотра без сети" else "Сохранить для просмотра без сети", null, false, enabled = !keepBusy) { toggleKeep() })
      }
      add(sheetRow("share", "Поделиться", null, false) { closeSheet { share() } })
    }
    val wasOpen = sheet.visibility == View.VISIBLE
    sheet.visibility = View.VISIBLE
    sheetDim.visibility = View.VISIBLE
    root.requestLayout()
    if (wasOpen) return
    sheet.post {
      sheet.translationY = (sheet.height + dp(16f)).toFloat()
      sheetDim.alpha = 0f
      sheet.animate().translationY(0f).setDuration(220).start()
      sheetDim.animate().alpha(1f).setDuration(220).start()
    }
  }

  private fun closeSheet(then: (() -> Unit)?) {
    sheetOpen = false
    sheet.animate().translationY((sheet.height + dp(16f)).toFloat()).setDuration(160).withEndAction { sheet.visibility = View.GONE; sheet.translationY = 0f }.start()
    sheetDim.animate().alpha(0f).setDuration(160).withEndAction { sheetDim.visibility = View.GONE }.start()
    if (then != null) then() else show(true)
  }

  private fun lockScreen() {
    closeSheet {
      locked = true
      shown = false
      main.removeCallbacks(hideTask)
      controls.alpha = 0f
      setControlsTouchable(false)
      hairline.visibility = View.VISIBLE
      say(LOCKED_NOTE)
    }
  }

  private fun chooseSpeed(value: Float) {
    speed = value
    if (playing) applyRate(value)
    closeSheet(null)
  }

  private fun toggleKeep() {
    val file = attachment ?: return
    if (keepBusy) return
    val kept = KeptMedia.isKept(context, file) && !forgetKept
    // Playing the kept file itself: it is not touched while it plays — it goes (or stays) once the player closes.
    if (folder == null) {
      forgetKept = kept
      closeSheet(null)
      say(if (kept) "Убрано из сохранённых" else "Сохранено")
      return
    }
    keepBusy = true
    val app = context.applicationContext
    val source = this.file
    decoding.execute {
      var now = false
      if (kept) KeptMedia.remove(app, file) else now = KeptMedia.keep(app, source, file)
      main.post {
        keepBusy = false
        closeSheet(null)
        say(if (now) "Сохранено" else "Убрано из сохранённых")
      }
    }
  }

  /** «Поделиться»: the system's share sheet with the decrypted file, readable by the app chosen, this once. */
  private fun share() {
    val app = context.applicationContext
    val written = if (folder != null && DecryptedFiles.folderName.matches(folder.name)) DecryptedFiles.Written(folder, file) else {
      // A kept film is shared as a copy of its own in the cache (removed with the other decrypted copies).
      val copyFolder = File(app.cacheDir, "invizent-view-" + UUID.randomUUID().toString().lowercase())
      try { copyFolder.mkdirs(); val copy = File(copyFolder, file.name); file.copyTo(copy, overwrite = true); DecryptedFiles.Written(copyFolder, copy) } catch (_: Exception) { copyFolder.deleteRecursively(); null }
    } ?: return say("Не удалось поделиться")
    val address = DecryptedFiles.address(app, written)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = DecryptedFiles.mimeType(written.file.name)
      putExtra(Intent.EXTRA_STREAM, address)
      clipData = ClipData.newRawUri("", address)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    try { context.startActivity(Intent.createChooser(send, "Поделиться").apply { addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }) } catch (_: Exception) { say("Не удалось поделиться") }
  }

  // Closing

  private fun closed() {
    // Picture in picture may still be showing the film: then it is left to finish there.
    if (inPip) return
    cleanUp()
  }

  /** The decrypted copy goes once nothing shows it any more. */
  private fun cleanUp() {
    if (cleaned) return
    cleaned = true
    if (current === this) current = null
    main.removeCallbacksAndMessages(null)
    lifecycle?.let { activity?.application?.unregisterActivityLifecycleCallbacks(it) }
    lifecycle = null
    if (Build.VERSION.SDK_INT >= 31) try { activity?.setPictureInPictureParams(PictureInPictureParams.Builder().setAutoEnterEnabled(false).build()) } catch (_: Exception) {}
    try { player.stop() } catch (_: Exception) {}
    player.release()
    val source = retriever
    retriever = null
    val app = context.applicationContext
    val attachment = attachment
    val forget = forgetKept
    decoding.execute {
      try { source?.release() } catch (_: Exception) {}
      folder?.deleteRecursively()
      if (forget && attachment != null) KeptMedia.remove(app, attachment)
    }
  }

  // Layout

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    if (width <= 0 || height <= 0) { view.layout(0, 0, 0, 0); return }
    view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width, top + height)
  }

  private fun place(width: Int, height: Int) {
    val insets = root.rootWindowInsets
    var top = 0; var bottom = 0; var left = 0; var right = 0
    if (insets != null && Build.VERSION.SDK_INT >= 30) {
      val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout())
      top = bars.top; bottom = bars.bottom; left = bars.left; right = bars.right
    }
    val y = top + dp(6f)
    put(closeButton, dp(6f) + left, y, dp(48f), dp(48f))
    put(gearButton, width - dp(6f) - right - dp(48f), y, dp(48f), dp(48f))
    put(pipButton, width - dp(6f) - right - dp(96f), y, dp(48f), dp(48f))
    put(playButton, width / 2 - dp(36f), height / 2 - dp(36f), dp(72f), dp(72f))
    val barY = height - bottom - dp(4f) - dp(30f)
    put(bar, dp(12f) + left, barY, width - dp(24f) - left - right, dp(30f))
    put(fillButton, width - dp(12f) - right - dp(48f), barY - dp(48f), dp(48f), dp(48f))
    clockLabel.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED), View.MeasureSpec.makeMeasureSpec(dp(26f), View.MeasureSpec.EXACTLY))
    put(clockLabel, dp(12f) + left, barY - dp(37f), clockLabel.measuredWidth, dp(26f))
    put(scrubHint, dp(16f), height - bottom - dp(268f), width - dp(32f), dp(18f))
    if (dragging) placeTooltip()
    holdPill.translationY = (top + dp(16f)).toFloat()
    noteBox.translationY = height * 0.3f
  }

  override fun show() {
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }

  /** `videodemo player|sheet|speed|locked|seek` (debug builds): the player in that state. */
  fun demoState(state: String) {
    main.postDelayed({
      // The shot comes seconds later: «заблокировано» and «20 с» stay on screen for it.
      demoHold = state == "locked" || state == "seek"
      when (state) {
        "sheet" -> openSheet(false)
        "speed" -> openSheet(true)
        "locked" -> lockScreen()
        "seek" -> seekTap(1, 20.0)
        else -> { try { if (player.isPlaying) player.pause() } catch (_: Exception) {}; show(true); paint() }
      }
    }, 1000)
  }

  companion object {
    private const val LOCKED_NOTE = "Экран заблокирован. Удерживай, чтобы снять"
    private val decoding = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.video-player").apply { isDaemon = true } }
    private var current: VideoPlayer? = null

    /** MainActivity: the window went into picture in picture, or came back. */
    fun pipChanged(on: Boolean) { current?.pipMode(on) }

    /** Opens the player; on any failure the decrypted copy goes at once. */
    fun open(context: Context, file: File, folder: File?, attachment: Map<String, Any?>?): VideoPlayer? = try {
      VideoPlayer(context, file, folder, attachment).also { it.show() }
    } catch (_: Exception) {
      folder?.deleteRecursively()
      ChatAttachments.say(context, "Не удалось воспроизвести видео.")
      null
    }
  }

  /** The seek bar: a track 3 pt high (5 while dragged), what is played, a 13 pt thumb (×1.6 while dragged). The
   *  finger is taken the moment it goes down, so a plain tap on the bar seeks too. */
  private inner class SeekBar : View(context) {
    var position = 0f; set(value) { field = value; invalidate() }
    var dragging = false; set(value) { field = value; invalidate() }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    init { isFocusable = true }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.SeekBar"
    override fun onDraw(canvas: Canvas) {
      val h = (if (dragging) 5f else 3f) * d
      val top = (if (dragging) 12f else 13f) * d
      paint.color = 0x38FFFFFF
      canvas.drawRect(0f, top, width.toFloat(), top + h, paint)
      paint.color = Color.WHITE
      canvas.drawRect(0f, top, width * position, top + h, paint)
      canvas.drawCircle(width * position, 14.5f * d, 6.5f * d * (if (dragging) 1.6f else 1f), paint)
    }
    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
      if (!isEnabled) return false
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> { parent?.requestDisallowInterceptTouchEvent(true); scrubBegan(event.x, event.rawY) }
        MotionEvent.ACTION_MOVE -> scrubMoved(event.x, event.rawY)
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> scrubEnded()
      }
      return true
    }
  }

  /** The thin line of what was played, while the controls are hidden. */
  private inner class SeekLine : View(context) {
    var position = 0f; set(value) { field = value; invalidate() }
    private val paint = Paint()
    override fun onDraw(canvas: Canvas) {
      paint.color = 0x33FFFFFF; canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
      paint.color = Color.WHITE; canvas.drawRect(0f, 0f, width * position, height.toFloat(), paint)
    }
  }

  /** The half-ellipse a double tap lights on its side (the reference's SeekSide): a band 19 % of the width at the
   *  edge, then a bulge 23 % wide, half an ellipse 120 % of the height tall; three running chevrons and the seconds. */
  private inner class SeekSide : View(context) {
    private var side = 1
    private var seconds = 0
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val started = SystemClock.uptimeMillis()
    var running = false
    fun show(side: Int, seconds: Int) { this.side = side; this.seconds = seconds; running = true; invalidate() }
    override fun onDraw(canvas: Canvas) {
      val width = width.toFloat(); val height = height.toFloat()
      val band = width * 0.19f; val bulge = width * 0.23f; val diameter = height * 1.2f
      paint.color = 0x24FFFFFF
      canvas.save()
      if (side < 0) {
        canvas.drawRect(0f, 0f, band, height, paint)
        canvas.clipRect(band, 0f, band + bulge, height)
        canvas.drawOval(RectF(band - bulge, (height - diameter) / 2, band + bulge, (height + diameter) / 2), paint)
      } else {
        canvas.drawRect(width - band, 0f, width, height, paint)
        canvas.clipRect(width - band - bulge, 0f, width - band, height)
        canvas.drawOval(RectF(width - band - bulge, (height - diameter) / 2, width - band + bulge, (height + diameter) / 2), paint)
      }
      canvas.restore()
      val area = width * 0.42f
      val centerX = if (side < 0) area / 2 else width - area / 2
      val phase = ((SystemClock.uptimeMillis() - started) / 750.0) % 1
      for (index in 0 until 3) {
        val alpha = PlayerModel.chevronOpacity(phase, index, side > 0)
        KitIcons.draw(canvas, if (side < 0) "triangle.left" else "triangle.right", centerX - 16 * d + index * 16 * d, height / 2 - 12 * d, 13 * d, Theme.alpha(Color.WHITE, alpha))
      }
      paint.color = Color.WHITE
      paint.textSize = 13f * d
      paint.typeface = Theme.weight(500)
      paint.textAlign = Paint.Align.CENTER
      canvas.drawText("$seconds секунд", centerX, height / 2 + 18 * d, paint)
      if (running) postInvalidateOnAnimation()
    }
  }
}
