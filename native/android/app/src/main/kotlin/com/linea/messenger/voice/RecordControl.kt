package com.linea.messenger.voice

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.chatlook.Haptic
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.Theme

/** The small pictures of the video recorder and the rows, drawn in a square of `size` px around (cx, cy). */
object MediaIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()

  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int, weight: Float = 1.7f) {
    val u = size / 24f
    stroke.color = color
    fill.color = color
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(u, u)
    stroke.strokeWidth = weight
    path.reset()
    when (name) {
      "mic", "mic.fill" -> {
        if (name == "mic.fill") canvas.drawRoundRect(9f, 3f, 15f, 14f, 3f, 3f, fill) else canvas.drawRoundRect(9f, 3f, 15f, 14f, 3f, 3f, stroke)
        path.moveTo(5.5f, 11f); path.cubicTo(5.5f, 19.4f, 18.5f, 19.4f, 18.5f, 11f)
        path.moveTo(12f, 17.4f); path.lineTo(12f, 21f)
        canvas.drawPath(path, stroke)
      }
      "video" -> {
        canvas.drawRoundRect(3f, 7f, 15f, 17f, 2.6f, 2.6f, stroke)
        path.moveTo(15f, 11f); path.lineTo(21f, 8f); path.lineTo(21f, 16f); path.lineTo(15f, 13f)
        canvas.drawPath(path, stroke)
      }
      "arrow.up" -> {
        path.moveTo(12f, 19f); path.lineTo(12f, 5.5f)
        path.moveTo(6f, 11.5f); path.lineTo(12f, 5.5f); path.lineTo(18f, 11.5f)
        canvas.drawPath(path, stroke)
      }
      "pause.fill" -> {
        canvas.drawRoundRect(6.5f, 5f, 10.5f, 19f, 1.2f, 1.2f, fill)
        canvas.drawRoundRect(13.5f, 5f, 17.5f, 19f, 1.2f, 1.2f, fill)
      }
      "play.fill" -> {
        path.moveTo(8f, 5f); path.lineTo(19.5f, 12f); path.lineTo(8f, 19f); path.close()
        canvas.drawPath(path, fill)
      }
      "xmark" -> {
        path.moveTo(6f, 6f); path.lineTo(18f, 18f); path.moveTo(18f, 6f); path.lineTo(6f, 18f)
        canvas.drawPath(path, stroke)
      }
      "circle.fill" -> canvas.drawCircle(12f, 12f, 10f, fill)
    }
    canvas.restore()
  }
}

/** The record button of the composer and everything a take shows (owner's spec, voice/RecordParts.kt holds the
 *  numbers; the iPhone's Sources/Voice/RecordControl.swift is the same): a tap switches microphone ↔ round video
 *  and says so in a tooltip; holding 0.19 s starts a take. The blob swells with the voice and follows the finger —
 *  left (shrinking, 30% of the way each frame) towards cancelling, up (with the lock) towards hands-free; the field
 *  shows the blinking red dot, the time and «Влево — отмена» swaying 6 dp. On release the larger movement decides:
 *  cancel, lock or send. Locked: the blob sends, the lock's square stops (the preview), «Отмена» calls it off. */
class RecordControl(private val context: Context) {
  enum class Mode { VOICE, VIDEO }
  enum class Phase { IDLE, HOLDING, LOCKED, PREVIEW }
  enum class Ending { SEND, CANCEL, PREVIEW }

  var mode = Mode.VOICE
    private set
  var phase = Phase.IDLE
    private set
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val main = Handler(Looper.getMainLooper())

  /** The paperclip: hidden while a take or its preview stands there. */
  var clipView: View? = null
  /** The paperclip slides off with the composer's transition (a chat) instead of fading. */
  var clipSlides = false
  /** The field's own content: faded while a take or its preview is shown. */
  var fieldViews: List<View> = emptyList()

  var onModeChanged: ((Mode) -> Unit)? = null
  var onHoldStart: ((Mode) -> Boolean)? = null
  var onFinish: ((Ending) -> Unit)? = null
  /** The phase changed (the composer lays itself out again). */
  var onPhase: ((Phase) -> Unit)? = null
  /** The composer's transition for a take: 0 at rest, 1 while a take is shown (0.4 s on the layout curve). */
  var onShift: ((Float) -> Unit)? = null
  var timeWords: (() -> String)? = null
  var onPreviewSend: (() -> Unit)? = null
  var onPreviewDelete: (() -> Unit)? = null
  var onRecordMore: (() -> Unit)? = null
  var previewToggle: (() -> Unit)? = null
  var previewSeek: ((Double) -> Unit)? = null
  var previewTrim: ((Double, Double, Boolean) -> Unit)? = null

  // The button

  @SuppressLint("ClickableViewAccessibility")
  inner class Button : View(context) {
    private val plate = Paint(Paint.ANTI_ALIAS_FLAG)
    var iconName = "mic-outline"
    var iconAlpha = 1f
    var iconScale = 1f
    var ghost: String? = null
    var ghostAlpha = 0f
    var ghostScale = 1f
    var sendFill = 0f
    init { isFocusable = true }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun onDraw(canvas: Canvas) {
      if (sendFill > 0f) {
        plate.color = Theme.accent; plate.alpha = (sendFill * 255).toInt()
        canvas.drawCircle(width / 2f, height / 2f, minOf(width, height) / 2f * (0.3f + 0.7f * sendFill), plate)
      }
      val ink = if (phase == Phase.PREVIEW) Theme.onAccent else Theme.text
      ghost?.let { if (ghostAlpha > 0f) IonIcon.draw(canvas, it, width / 2f, height / 2f, 24f * d * ghostScale, withAlpha(Theme.text, ghostAlpha)) }
      if (iconAlpha > 0f) IonIcon.draw(canvas, iconName, width / 2f, height / 2f, (if (phase == Phase.PREVIEW) 22f else 24f) * d * iconScale, withAlpha(ink, iconAlpha))
    }
    override fun onTouchEvent(event: MotionEvent): Boolean = touched(event)
    /** A tap (and a screen reader's «activate», which only clicks): switches voice ↔ round video at rest; sends a
     *  locked take or the preview, as a touch on it does. */
    override fun performClick(): Boolean {
      super.performClick()
      when (phase) {
        Phase.IDLE -> switchMode()
        Phase.LOCKED -> finish(Ending.SEND)
        Phase.PREVIEW -> onPreviewSend?.invoke()
        Phase.HOLDING -> {}
      }
      return true
    }
    /** 10 dp beyond its sides also count. */
    fun covers(x: Float, y: Float): Boolean = x >= -10f * d && x <= width + 10f * d && y >= 0 && y <= height
  }

  private fun withAlpha(color: Int, alpha: Float): Int = (((color ushr 24) * alpha).toInt().coerceIn(0, 255) shl 24) or (color and 0xFFFFFF)

  val button = Button()
  private val dot = View(context)
  private val timeLabel = TextView(context)
  private val indicator = RecordCancelIndicator(context)
  val preview = VoicePreviewPanel(context)
  /** The preview of a stopped round video (its frames, trimmed by two handles). */
  val videoPreview = VideoTrimPanel(context)
  /** Asked right after a voice take was sent: where the sent message's play button is, in the screen view's px
   *  (null: nowhere to fly; the blob shrinks into the button instead). */
  var sentTarget: (() -> RectF?)? = null
  private var flying = false
  private val trash = object : View(context) {
    override fun onDraw(canvas: Canvas) = IonIcon.draw(canvas, "trash-outline", width / 2f, height / 2f, 22f * d, RecordSpec.controlColor)
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  }
  private val layer = object : ViewGroup(context) {
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) = layoutLayer()
    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
  }
  private var source: GlassSource? = null
  private lateinit var overlay: ViewGroup
  private lateinit var blob: RecordBlobView
  private lateinit var lockPanel: RecordLockPanel
  private lateinit var recordMore: RecordMoreButton
  private val tooltip = RecordTooltip(context)
  private val bin = object : View(context) {
    override fun onDraw(canvas: Canvas) = IonIcon.draw(canvas, "trash", width / 2f, height / 2f, 22f * d, RecordSpec.binColor)
  }
  private var host: ViewGroup? = null
  private var composer: FrameLayout? = null

  private val buttonRect = RectF()
  private val fieldIdle = RectF()
  private val fieldTake = RectF()
  private val trashRect = RectF()
  private var shift = 0f
  private var shiftAnimator: ValueAnimator? = null
  private var visible = true
  private var holdPending = false
  private var holdFailed = false
  private var lastTouch = 0L
  private var startX = 0f
  private var startY = 0f
  private var velocity: VelocityTracker? = null
  private var scale = 1f
  private var translation = 0f
  private var targetTranslation = 0f
  private var cancelShift = 0f
  private var cancelTarget = 0f
  private var looping = false
  private var blobAnimating = false
  private var previewIsVideo = false
  private var sway: ObjectAnimator? = null
  private var blink: ObjectAnimator? = null

  /** Adds the record button and the take's parts to the composer, the blob, the lock and «record more» to the
   *  screen (`source`: the page under the glass). */
  fun install(composer: FrameLayout, host: ViewGroup, source: GlassSource?) {
    this.composer = composer
    this.host = host
    this.source = source
    dot.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(RecordSpec.dotColor) }
    dot.visibility = View.GONE
    layer.addView(dot)
    timeLabel.textSize = 15f
    timeLabel.setTextColor(Theme.text)
    timeLabel.fontFeatureSettings = "tnum"
    timeLabel.includeFontPadding = false
    timeLabel.maxLines = 1
    timeLabel.visibility = View.GONE
    layer.addView(timeLabel)
    indicator.visibility = View.GONE
    indicator.onCancel = { if (phase == Phase.LOCKED) finish(Ending.CANCEL) }
    layer.addView(indicator)
    preview.visibility = View.GONE
    preview.onToggle = { previewToggle?.invoke() }
    preview.onSeek = { previewSeek?.invoke(it) }
    preview.onTrim = { start, end, done -> previewTrim?.invoke(start, end, done) }
    layer.addView(preview)
    videoPreview.visibility = View.GONE
    videoPreview.onToggle = { previewToggle?.invoke() }
    videoPreview.onTrim = { start, end, done -> previewTrim?.invoke(start, end, done) }
    layer.addView(videoPreview)
    trash.contentDescription = "Удалить запись"
    trash.isClickable = true
    trash.visibility = View.GONE
    trash.setOnClickListener { if (phase == Phase.PREVIEW) onPreviewDelete?.invoke() }
    layer.addView(trash)
    layer.addView(button)
    composer.addView(layer, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    blob = RecordBlobView(context)
    blob.visibility = View.GONE
    blob.setOnClickListener { if (phase == Phase.LOCKED) finish(Ending.SEND) }
    lockPanel = RecordLockPanel(context, source)
    lockPanel.visibility = View.GONE
    lockPanel.onStop = { if (phase == Phase.LOCKED) finish(Ending.PREVIEW) }
    recordMore = RecordMoreButton(context, source)
    recordMore.visibility = View.GONE
    recordMore.setOnClickListener { if (phase == Phase.PREVIEW) onRecordMore?.invoke() }
    overlay = object : ViewGroup(context) {
      override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) = layoutOverlay()
      override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
    }
    overlay.addView(lockPanel)
    overlay.addView(blob)
    overlay.addView(recordMore)
    overlay.addView(bin.apply { visibility = View.GONE })
    overlay.addView(tooltip)
    host.addView(overlay)
    showIdleIcon(false)
  }

  /** `button`, `fieldIdle` (the field's pill at rest and for the preview), `fieldTake` (the pill while a take runs)
   *  and `trash` (the paperclip's place): px in the composer. `hostWidth`/`hostHeight`: the screen. */
  fun place(button: RectF, fieldIdle: RectF, fieldTake: RectF, trash: RectF, hostWidth: Int, hostHeight: Int) {
    val changed = buttonRect != button || this.fieldIdle != fieldIdle || this.fieldTake != fieldTake || trashRect != trash
    buttonRect.set(button); this.fieldIdle.set(fieldIdle); this.fieldTake.set(fieldTake); trashRect.set(trash)
    // Called from the screen's own layout pass: asking the layer for a layout here would ask for another pass every
    // frame, without end. The layer's parts are placed right away instead, and only when something moved.
    if (changed) { if (layer.width > 0 && layer.height > 0) layoutLayer() else layer.requestLayout() }
    overlay.measure(View.MeasureSpec.makeMeasureSpec(hostWidth, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(hostHeight, View.MeasureSpec.EXACTLY))
    overlay.layout(0, 0, hostWidth, hostHeight)
    overlay.bringToFront()
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(maxOf(0, width), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(maxOf(0, height), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + maxOf(0, width), top + maxOf(0, height))
  }

  private fun field(): RectF {
    val f = RectF()
    f.left = fieldIdle.left + (fieldTake.left - fieldIdle.left) * shift
    f.right = fieldIdle.right + (fieldTake.right - fieldIdle.right) * shift
    f.top = fieldTake.top; f.bottom = fieldTake.bottom
    return f
  }

  private fun layoutLayer() {
    put(button, buttonRect.left.toInt(), buttonRect.top.toInt(), buttonRect.width().toInt(), buttonRect.height().toInt())
    val f = field()
    val middle = f.bottom - 20f * d
    put(dot, (f.left + 16f * d).toInt(), (middle - 5f * d).toInt(), dp(10f), dp(10f))
    timeLabel.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    val timeW = maxOf(dp(92f), timeLabel.measuredWidth)
    put(timeLabel, (f.left + 34f * d).toInt(), (middle + d - timeLabel.measuredHeight / 2f).toInt(), timeW, timeLabel.measuredHeight)
    placeIndicator()
    put(preview, fieldIdle.left.toInt(), (fieldIdle.bottom - 40f * d).toInt(), fieldIdle.width().toInt(), dp(40f))
    put(videoPreview, fieldIdle.left.toInt(), (fieldIdle.bottom - 40f * d).toInt(), fieldIdle.width().toInt(), dp(40f))
    put(trash, trashRect.left.toInt(), trashRect.top.toInt(), trashRect.width().toInt(), trashRect.height().toInt())
  }

  /** Centred in the screen's width less 16 dp, moved left by half the slide past 8 dp; it fades over its last 10 dp
   *  before 100 dp from the screen's left edge. */
  private fun placeIndicator() {
    val composer = composer ?: return
    val hostWidth = host?.width ?: return
    val slide = maxOf(0f, -cancelTarget - 8f) * d
    val width = indicator.naturalWidth
    val height = indicator.naturalHeight
    val hostX = Math.floor(((hostWidth - 16f * d - width - slide) / 2f).toDouble()).toFloat()
    val x = hostX - composer.left
    put(indicator, x.toInt(), (field().bottom - 20f * d - height / 2f).toInt(), width, height)
    if (-cancelTarget > 8f && phase == Phase.HOLDING) indicator.alpha = ((hostX - 100f * d) / (10f * d)).coerceIn(0f, 1f)
  }

  private fun buttonCenterInHost(): Pair<Float, Float> {
    val composer = composer ?: return Pair(0f, 0f)
    return Pair(composer.left + buttonRect.centerX(), composer.top + buttonRect.centerY())
  }

  private fun layoutOverlay() {
    val (cx, cy) = buttonCenterInHost()
    val side = dp(RecordSpec.blobSide)
    if (!flying) put(blob, (cx - side / 2f).toInt(), (cy - d + 1 - side / 2f).toInt(), side, side)
    put(lockPanel, (cx - 20f * d).toInt(), (cy - RecordSpec.lockLift * d - 36f * d).toInt(), dp(40f), dp(72f))
    put(recordMore, (cx - 22f * d).toInt(), (cy - buttonRect.height() / 2 - 16f * d - 42f * d).toInt(), dp(44f), dp(44f))
    val composer = composer
    if (composer != null) put(bin, (composer.left + trashRect.centerX() - 20f * d).toInt(), (composer.top + trashRect.centerY() - 20f * d).toInt(), dp(40f), dp(40f))
  }

  fun setVisible(value: Boolean) {
    visible = value
    if (phase != Phase.IDLE) return
    button.visibility = if (value) View.VISIBLE else View.GONE
  }

  val isBusy: Boolean get() = phase != Phase.IDLE

  // The button's look

  private fun idleIcon(): String = if (mode == Mode.VOICE) "mic-outline" else "videocam-outline"

  private fun showIdleIcon(animated: Boolean) {
    // RecordButton.tsx: the button's accessibilityLabel, word for word.
    button.contentDescription = if (mode == Mode.VOICE) "Голосовое: удерживай для записи, свайп влево — отмена, вверх — без рук. Нажми — переключить на видео"
      else "Видеосообщение: удерживай для записи, свайп влево — отмена, вверх — без рук. Нажми — переключить на голосовое"
    if (!animated) { button.iconName = idleIcon(); button.ghost = null; button.invalidate(); return }
    // The icon turns into the other one in 0.25 s.
    button.ghost = button.iconName
    button.iconName = idleIcon()
    val turn = ValueAnimator.ofFloat(0f, 1f)
    turn.duration = 250
    turn.interpolator = RecordSpec.easeInOut()
    turn.addUpdateListener {
      val t = it.animatedValue as Float
      button.ghostAlpha = 1 - t; button.ghostScale = 1 - 0.5f * t
      button.iconAlpha = t; button.iconScale = 0.5f + 0.5f * t
      button.invalidate()
    }
    turn.addListener(object : AnimatorListenerAdapter() { override fun onAnimationEnd(animation: Animator) { button.ghost = null; button.invalidate() } })
    turn.start()
  }

  private fun animateButtonIcon(toAlpha: Float, toScale: Float, ms: Long) {
    val fromAlpha = button.iconAlpha; val fromScale = button.iconScale
    val run = ValueAnimator.ofFloat(0f, 1f)
    run.duration = ms
    run.interpolator = RecordSpec.easeInOut()
    run.addUpdateListener {
      val t = it.animatedValue as Float
      button.iconAlpha = fromAlpha + (toAlpha - fromAlpha) * t
      button.iconScale = fromScale + (toScale - fromScale) * t
      button.invalidate()
    }
    run.start()
  }

  // Touches

  private fun touched(event: MotionEvent): Boolean {
    val x = event.rawX; val y = event.rawY
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (!button.covers(event.x, event.y)) return false
        when (phase) {
          Phase.LOCKED -> { finish(Ending.SEND); return false }
          Phase.PREVIEW -> { onPreviewSend?.invoke(); return false }
          Phase.HOLDING -> return false
          Phase.IDLE -> {}
        }
        val now = SystemClock.uptimeMillis()
        if (now - lastTouch < RecordSpec.touchDebounceMs) return false
        lastTouch = now
        button.parent?.requestDisallowInterceptTouchEvent(true)
        startX = x; startY = y
        velocity?.recycle()
        velocity = VelocityTracker.obtain().also { it.addMovement(event) }
        holdFailed = false
        tooltip.dismiss()
        holdPending = true
        main.removeCallbacks(holdReached)
        main.postDelayed(holdReached, RecordSpec.holdMs)
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        velocity?.addMovement(event)
        val dx = minOf(0f, (x - startX) / d); val dy = minOf(0f, (y - startY) / d)
        if (holdPending) {
          if (dx < -RecordSpec.cancelDistance) { holdPending = false; holdFailed = true; main.removeCallbacks(holdReached) }
          return true
        }
        if (phase != Phase.HOLDING) return true
        scale = (1f - (-dx / RecordSpec.shrinkDistance).coerceIn(0f, 1f)).coerceIn(RecordSpec.minScale, 1f)
        targetTranslation = dy
        cancelTarget = dx
        if (!blobAnimating) lockPanel.update(minOf(1f, Math.abs(targetTranslation) / RecordSpec.lockRange))
        layer.requestLayout()
        when (RecordGesture.move(dx, dy)) {
          "cancel" -> { targetTranslation = 0f; finish(Ending.CANCEL) }
          "lock" -> lock()
        }
        return true
      }
      MotionEvent.ACTION_UP -> {
        velocity?.addMovement(event)
        velocity?.computeCurrentVelocity(1000)
        val vx = (velocity?.xVelocity ?: 0f) / d; val vy = (velocity?.yVelocity ?: 0f) / d
        velocity?.recycle(); velocity = null
        if (holdPending) {
          holdPending = false
          main.removeCallbacks(holdReached)
          button.performClick() // switches the mode
          return true
        }
        if (phase != Phase.HOLDING) return true
        targetTranslation = 0f
        when (RecordGesture.release((x - startX) / d, (y - startY) / d, vx, vy)) {
          "cancel" -> finish(Ending.CANCEL)
          "lock" -> lock()
          else -> finish(Ending.SEND)
        }
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        velocity?.recycle(); velocity = null
        if (holdPending) { holdPending = false; main.removeCallbacks(holdReached); return true }
        if (phase == Phase.HOLDING) {
          translation = 0f; targetTranslation = 0f
          // The system took the touch away: the take locks a second later.
          main.postDelayed({ if (phase == Phase.HOLDING) lock() }, 1000)
        }
        return true
      }
    }
    return true
  }

  private val holdReached = Runnable {
    holdPending = false
    if (phase != Phase.IDLE) return@Runnable
    if (onHoldStart?.invoke(mode) != true) { holdFailed = true; return@Runnable }
    Haptic.light(button)
    begin(locked = false)
  }

  private fun switchMode() {
    // A medium knock, as the owner's spec has it.
    button.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY)
    mode = if (mode == Mode.VOICE) Mode.VIDEO else Mode.VOICE
    showIdleIcon(true)
    onModeChanged?.invoke(mode)
    val composer = composer ?: return
    val host = host ?: return
    val anchor = RectF(composer.left + buttonRect.left, composer.top + buttonRect.top, composer.left + buttonRect.right, composer.top + buttonRect.bottom)
    tooltip.show(if (mode == Mode.VOICE) "Удерживайте, чтобы записать голосовое. Нажмите, чтобы переключиться на видео."
      else "Удерживайте, чтобы записать видео. Нажмите, чтобы переключиться на голосовое.", anchor, host.width)
  }

  // A take

  private fun animateShift(to: Float) {
    shiftAnimator?.cancel()
    val run = ValueAnimator.ofFloat(shift, to)
    run.duration = RecordSpec.layoutMs
    run.interpolator = RecordSpec.layoutCurve()
    run.addUpdateListener {
      shift = it.animatedValue as Float
      layer.requestLayout()
      onShift?.invoke(shift)
      if (clipSlides) clipView?.translationX = -(clipView?.let { clip -> clip.left + clip.width + 14f * d } ?: 0f) * shift
    }
    shiftAnimator = run
    run.start()
  }

  private fun begin(locked: Boolean) {
    phase = Phase.HOLDING
    scale = 1f; translation = 0f; targetTranslation = 0f; cancelShift = 0f; cancelTarget = 0f
    lockPanel.reset()
    blob.color = Theme.accent
    blob.icon = if (mode == Mode.VOICE) "mic" else "videocam"
    blob.iconAlpha = 1f; blob.iconScale = 1f; blob.ghostIcon = null
    blob.visibility = View.VISIBLE
    blob.isClickable = false
    blob.scaleX = 0.2f; blob.scaleY = 0.2f; blob.alpha = 0.2f
    blob.translationX = 0f; blob.translationY = 0f
    lockPanel.visibility = View.VISIBLE
    lockPanel.translationY = (if (locked) 36f else 100f) * d
    lockPanel.alpha = 0f; lockPanel.scaleX = 1f; lockPanel.scaleY = 1f
    blobAnimating = true
    val spring = SpringCurve(0.55f, 500)
    blob.animate().scaleX(1f).scaleY(1f).setDuration(500).setInterpolator(spring).withEndAction { blobAnimating = false }.start()
    lockPanel.animate().translationY(0f).setDuration(500).setInterpolator(spring).start()
    ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 100
      addUpdateListener { val t = it.animatedValue as Float; blob.alpha = 0.2f + 0.8f * t; lockPanel.alpha = t }
      start()
    }
    blob.start()
    animateButtonIcon(0f, 0.3f, 150)
    showInfo()
    startLoop()
    animateShift(1f)
    changedPhase()
    if (locked) lock()
  }

  private val clockTick = object : Runnable {
    override fun run() {
      if (phase != Phase.HOLDING && phase != Phase.LOCKED) return
      timeLabel.text = timeWords?.invoke() ?: "0:00,00"
      main.postDelayed(this, 50)
    }
  }

  private fun showInfo() {
    timeLabel.text = timeWords?.invoke() ?: "0:00,00"
    timeLabel.setTextColor(Theme.text)
    timeLabel.visibility = View.VISIBLE
    timeLabel.scaleX = 1f; timeLabel.scaleY = 1f
    timeLabel.alpha = 0f
    timeLabel.animate().alpha(1f).setDuration(500).setInterpolator(RecordSpec.layoutCurve()).start()
    // The dot grows from 0.3 in 0.15 s, then blinks: on for 0.45 of the half second, off by 0.91, back and forth.
    blink?.cancel()
    dot.visibility = View.VISIBLE
    dot.alpha = 0f; dot.scaleX = 0.3f; dot.scaleY = 0.3f
    dot.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(150).withEndAction {
      if (phase != Phase.HOLDING && phase != Phase.LOCKED) return@withEndAction
      val frames = PropertyValuesHolder.ofKeyframe(View.ALPHA,
        android.animation.Keyframe.ofFloat(0f, 1f), android.animation.Keyframe.ofFloat(0.4546f, 1f),
        android.animation.Keyframe.ofFloat(0.9091f, 0f), android.animation.Keyframe.ofFloat(1f, 0f))
      blink = ObjectAnimator.ofPropertyValuesHolder(dot, frames).apply {
        duration = 500; repeatCount = ValueAnimator.INFINITE; repeatMode = ValueAnimator.REVERSE; interpolator = LinearInterpolator(); start()
      }
    }.start()
    // «Slide to cancel» comes in from the right in 0.4 s, then sways 6 dp each second.
    indicator.swap = 0f
    indicator.alpha = 1f
    indicator.visibility = View.VISIBLE
    sway?.cancel()
    indicator.translationX = (host?.width ?: 400).toFloat()
    indicator.animate().translationX(0f).setDuration(400).setInterpolator(RecordSpec.layoutCurve()).withEndAction { startSway() }.start()
    main.removeCallbacks(clockTick)
    main.post(clockTick)
  }

  private fun startSway() {
    if ((host?.width ?: 0) <= dp(320f) || phase != Phase.HOLDING) return
    sway = ObjectAnimator.ofFloat(indicator, View.TRANSLATION_X, 0f, 6f * d).apply {
      duration = 1000; repeatCount = ValueAnimator.INFINITE; repeatMode = ValueAnimator.REVERSE; interpolator = RecordSpec.easeInOut(); start()
    }
  }

  private fun stopSway() {
    sway?.cancel(); sway = null
    if (indicator.translationX != 0f) indicator.animate().translationX(0f).setDuration(300).start()
  }

  private fun lock() {
    if (phase != Phase.HOLDING) return
    phase = Phase.LOCKED
    scale = 1f; targetTranslation = 0f; cancelTarget = 0f
    lockPanel.lock()
    blob.isClickable = true
    // The blob's icon becomes the send arrow: the old one shrinks away, the arrow grows from 0.3 (0.3 s).
    blob.ghostIcon = blob.icon
    blob.icon = "arrow-up"
    ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 300
      interpolator = RecordSpec.layoutCurve()
      addUpdateListener {
        val t = it.animatedValue as Float
        blob.ghostScale = 1f - 0.999f * t; blob.ghostAlpha = (1f - t / 0.66f).coerceIn(0f, 1f)
        blob.iconScale = 0.3f + 0.7f * t; blob.iconAlpha = (t / 0.66f).coerceIn(0f, 1f)
        blob.invalidate()
      }
      start()
    }
    blob.contentDescription = if (mode == Mode.VOICE) "Отправить голосовое сообщение" else "Отправить видеосообщение"
    stopSway()
    ValueAnimator.ofFloat(0f, 1f).apply { duration = 250; addUpdateListener { indicator.swap = it.animatedValue as Float }; start() }
    indicator.alpha = 1f
    changedPhase()
  }

  /** The host ends the take (the longest one was reached), as if the person had. */
  fun end(ending: Ending) = finish(ending)

  private fun finish(ending: Ending) {
    if (phase != Phase.HOLDING && phase != Phase.LOCKED) return
    holdPending = false
    main.removeCallbacks(holdReached)
    phase = Phase.IDLE
    hideTake(ending)
    onFinish?.invoke(ending)
    if (phase == Phase.IDLE) changedPhase()
  }

  /** A take ended by itself (a failure) or the screen is left: back to rest at once. */
  fun reset() {
    holdPending = false
    main.removeCallbacks(holdReached)
    if (phase == Phase.HOLDING || phase == Phase.LOCKED) { phase = Phase.IDLE; hideTake(Ending.SEND); clipView?.alpha = 1f }
    else if (phase == Phase.PREVIEW) { phase = Phase.IDLE; hidePreview(false) }
    changedPhase()
  }

  private fun hideTake(ending: Ending) {
    stopLoop()
    main.removeCallbacks(clockTick)
    blob.stop()
    blob.isClickable = false
    blob.animate().cancel(); lockPanel.animate().cancel()
    val sent = ending == Ending.SEND
    if (sent) {
      // Once the host has put the message in the list (two frames), the blob flies to its play button; with no
      // such button it shrinks into the composer's button.
      blob.postOnAnimation { blob.postOnAnimation {
        val target = sentTarget?.invoke()
        if (target != null && target.width() > 0f) fly(target) else shrinkSent()
      } }
    } else {
      blob.animate().scaleX(0.2f).scaleY(0.2f).alpha(0f).setDuration(180).start()
    }
    lockPanel.animate().translationY(100f * d).scaleX(0.2f).scaleY(0.2f).alpha(0f).setDuration(180).withEndAction {
      if (phase == Phase.IDLE || phase == Phase.PREVIEW) { if (!sent) blob.visibility = View.GONE; lockPanel.visibility = View.GONE; lockPanel.reset() }
    }.start()
    if (ending != Ending.PREVIEW) animateButtonIcon(1f, 1f, 150)
    blink?.cancel(); blink = null
    if (ending == Ending.CANCEL) throwDotAway()
    else dot.animate().alpha(0f).scaleX(0.3f).scaleY(0.3f).setDuration(150).start()
    if (sent) clipView?.animate()?.alpha(1f)?.setDuration(200)?.start()
    timeLabel.animate().alpha(0f).scaleX(0.5f).scaleY(0.5f).setDuration(RecordSpec.layoutMs).setInterpolator(RecordSpec.layoutCurve()).start()
    stopSway()
    indicator.animate().alpha(0f).setDuration(250).withEndAction {
      if (phase == Phase.IDLE || phase == Phase.PREVIEW) { indicator.visibility = View.GONE; indicator.swap = 0f; dot.visibility = View.GONE; timeLabel.visibility = View.GONE }
    }.start()
    animateShift(0f)
  }

  private fun shrinkSent() {
    blob.animate().scaleX(0.33f).scaleY(0.33f).translationY(blob.translationY + 2f * d).setDuration(180).start()
    ValueAnimator.ofFloat(1f, 0f).apply { startDelay = 150; duration = 30; addUpdateListener { blob.alpha = it.animatedValue as Float }; start() }
  }

  /** The sent voice message's play button is at `target`: the blob flies there in 0.3 s — across on the
   *  (0.23, 1, 0.32, 1) curve, down/up on (0.199, 0.011, 0.279, 0.910) — shrinking so that its centre circle lands on
   *  the button, and fades out in its first 0.06 s while the message takes over. */
  private fun fly(target: RectF) {
    flying = true
    blob.animate().cancel()
    val fromX = blob.left + blob.width / 2f + blob.translationX
    val fromY = blob.top + blob.height / 2f + blob.translationY
    val fromScale = blob.scaleX
    val toScale = target.width() / (RecordSpec.blobSide * d * 0.45f)
    val baseX = blob.left + blob.width / 2f; val baseY = blob.top + blob.height / 2f
    val across = android.view.animation.PathInterpolator(0.23f, 1f, 0.32f, 1f)
    val down = android.view.animation.PathInterpolator(0.199f, 0.0106f, 0.279f, 0.910f)
    blob.alpha = 1f
    ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 300
      addUpdateListener {
        val t = it.animatedValue as Float
        val x = fromX + (target.centerX() - fromX) * across.getInterpolation(t)
        val y = fromY + (target.centerY() - fromY) * down.getInterpolation(t)
        val sc = fromScale + (toScale - fromScale) * down.getInterpolation(t)
        blob.translationX = x - baseX; blob.translationY = y - baseY
        blob.scaleX = sc; blob.scaleY = sc
        blob.alpha = (1f - t * 0.3f / 0.06f).coerceIn(0f, 1f)
      }
      addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) {
          flying = false
          if (phase == Phase.IDLE || phase == Phase.PREVIEW) { blob.visibility = View.GONE; blob.translationX = 0f; blob.translationY = 0f; blob.scaleX = 1f; blob.scaleY = 1f }
        }
      })
      start()
    }
  }

  /** Called off: the red dot jumps into a red trash in the paperclip's place, the lid bounces (1.34 s), then the
   *  trash goes small and the paperclip grows back (0.2 s). */
  private fun throwDotAway() {
    val composer = composer ?: return
    val flyer = View(context)
    flyer.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(RecordSpec.dotColor) }
    val sx = composer.left + dot.left; val sy = composer.top + dot.top
    overlay.addView(flyer)
    put(flyer, sx, sy, dp(10f), dp(10f))
    dot.alpha = 0f
    clipView?.alpha = 0f
    val tx = composer.left + trashRect.centerX() - 5f * d - sx
    val ty = composer.top + trashRect.centerY() - 5f * d - sy
    flyer.animate().translationX(tx).setDuration(RecordSpec.layoutMs).setInterpolator(RecordSpec.layoutCurve()).start()
    val hop = ValueAnimator.ofFloat(0f, 1f)
    hop.duration = 350
    hop.addUpdateListener {
      val t = it.animatedValue as Float
      val lift = if (t < 0.52f) -8f * RecordSpec.smooth(t / 0.52f) else -8f + 13.66f * RecordSpec.smooth((t - 0.52f) / 0.48f)
      flyer.translationY = ty * RecordSpec.smooth(t) + lift * d
    }
    hop.start()
    layoutOverlay()
    bin.visibility = View.VISIBLE
    bin.alpha = 0f; bin.scaleX = 1f; bin.scaleY = 1f; bin.rotation = 0f
    main.postDelayed({
      overlay.removeView(flyer)
      bin.alpha = 1f
      val lid = PropertyValuesHolder.ofKeyframe(View.ROTATION,
        android.animation.Keyframe.ofFloat(0f, 0f), android.animation.Keyframe.ofFloat(0.25f, -5f), android.animation.Keyframe.ofFloat(0.43f, 0f),
        android.animation.Keyframe.ofFloat(0.55f, 10f), android.animation.Keyframe.ofFloat(0.69f, -12f), android.animation.Keyframe.ofFloat(0.77f, 0f),
        android.animation.Keyframe.ofFloat(0.86f, -3f), android.animation.Keyframe.ofFloat(1f, 0f))
      ObjectAnimator.ofPropertyValuesHolder(bin, lid).apply { duration = 1340 - 325; start() }
    }, 325)
    main.postDelayed({
      bin.animate().alpha(0f).scaleX(0.001f).scaleY(0.001f).setDuration(200).setInterpolator(RecordSpec.easeInOut()).withEndAction { bin.visibility = View.GONE }.start()
      growClipBack()
    }, 1340)
  }

  private fun growClipBack() {
    if (phase != Phase.IDLE) return
    val clip = clipView ?: return
    clip.scaleX = 0.001f; clip.scaleY = 0.001f; clip.alpha = 0f
    clip.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(RecordSpec.easeInOut()).start()
  }

  // The frame loop

  private val frame = FrameClock {
    if (looping) {
      translation = minOf(0f, translation * (1 - RecordSpec.follow) + targetTranslation * RecordSpec.follow)
      cancelShift = minOf(0f, cancelShift * (1 - RecordSpec.follow) + cancelTarget * RecordSpec.follow)
      if (!blobAnimating) {
        blob.translationY = translation * d
        blob.scaleX = scale; blob.scaleY = scale
        blob.translationX = cancelShift * scale * d
        lockPanel.translationY = translation * d
      }
    }
  }

  private fun startLoop() {
    if (looping) return
    looping = true
    frame.start()
  }

  private fun stopLoop() {
    looping = false
    frame.stop()
    translation = 0f; targetTranslation = 0f; cancelShift = 0f; cancelTarget = 0f; scale = 1f
  }

  fun setLevel(level: Float) = blob.updateLevel(level)

  private fun changedPhase() {
    val busy = phase != Phase.IDLE
    for (view in fieldViews) view.animate().alpha(if (busy) 0f else 1f).setDuration(150).start()
    button.visibility = if (busy || visible) View.VISIBLE else View.GONE
    // The blob is a send button only once the take is locked; while the finger holds it is just under the finger.
    blob.contentDescription = if (phase == Phase.LOCKED) "Отправить" else null
    blob.importantForAccessibility = if (phase == Phase.LOCKED) View.IMPORTANT_FOR_ACCESSIBILITY_YES else View.IMPORTANT_FOR_ACCESSIBILITY_NO
    if (busy && !(clipSlides && phase != Phase.PREVIEW)) clipView?.alpha = 0f
    onPhase?.invoke(phase)
  }

  // The preview

  fun showPreview(levels: List<Double>, durationMs: Long, video: Boolean) {
    previewIsVideo = video
    phase = Phase.PREVIEW
    val shown: View = if (video) videoPreview else preview
    if (video) videoPreview.setTake(durationMs) else { preview.allowsTrim = true; preview.setTake(levels, durationMs) }
    shown.visibility = View.VISIBLE
    shown.alpha = 0f
    shown.animate().alpha(1f).setDuration(200).start()
    trash.visibility = View.VISIBLE
    trash.alpha = 0f; trash.scaleX = 0.001f; trash.scaleY = 0.001f
    trash.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(RecordSpec.easeInOut()).start()
    button.iconName = "arrow-up"
    button.contentDescription = if (video) "Отправить видеосообщение" else "Отправить голосовое сообщение"
    button.iconAlpha = 1f; button.iconScale = 1f
    ValueAnimator.ofFloat(0f, 1f).apply { duration = 200; addUpdateListener { button.sendFill = it.animatedValue as Float; button.invalidate() }; start() }
    // «Record more» (a round video: while it is shorter than 59 s).
    if (!video || durationMs < 59_000L) {
      recordMore.visibility = View.VISIBLE
      recordMore.alpha = 0f; recordMore.scaleX = 0.01f; recordMore.scaleY = 0.01f
      recordMore.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(RecordSpec.layoutMs).setInterpolator(RecordSpec.layoutCurve()).start()
    }
    changedPhase()
  }

  fun setPreviewPlayback(fraction: Double, playing: Boolean) = preview.setPlayback(fraction, playing)

  /** The frames of a stopped round video, as many as `videoFrameCount`. */
  fun setVideoFrames(images: List<android.graphics.Bitmap>) = videoPreview.setFrames(images)
  val videoFrameCount: Int get() = videoPreview.frameCount

  fun endPreview(deleted: Boolean) {
    if (phase != Phase.PREVIEW) return
    phase = Phase.IDLE
    hidePreview(deleted)
    changedPhase()
  }

  private fun hidePreview(deleted: Boolean) {
    preview.animate().alpha(0f).setDuration(200).withEndAction { if (phase != Phase.PREVIEW) preview.visibility = View.GONE }.start()
    videoPreview.animate().alpha(0f).setDuration(200).withEndAction { if (phase != Phase.PREVIEW) videoPreview.visibility = View.GONE }.start()
    ValueAnimator.ofFloat(button.sendFill, 0f).apply { duration = 200; addUpdateListener { button.sendFill = it.animatedValue as Float; button.invalidate() }; start() }
    button.iconName = idleIcon()
    showIdleIcon(false)
    button.iconAlpha = 0f; button.iconScale = 0.3f
    animateButtonIcon(1f, 1f, 150)
    recordMore.animate().alpha(0f).scaleX(0.01f).scaleY(0.01f).setDuration(RecordSpec.layoutMs).withEndAction { if (phase != Phase.PREVIEW) recordMore.visibility = View.GONE }.start()
    val finishTrash = Runnable {
      trash.animate().alpha(0f).scaleX(0.001f).scaleY(0.001f).setDuration(200).setInterpolator(RecordSpec.easeInOut()).withEndAction {
        if (phase != Phase.PREVIEW) { trash.visibility = View.GONE; trash.scaleX = 1f; trash.scaleY = 1f }
      }.start()
      growClipBack()
    }
    if (deleted) {
      // The trash's lid bounces (0.5 s) before it goes.
      val lid = PropertyValuesHolder.ofKeyframe(View.ROTATION,
        android.animation.Keyframe.ofFloat(0f, 0f), android.animation.Keyframe.ofFloat(0.25f, -10f), android.animation.Keyframe.ofFloat(0.5f, 8f),
        android.animation.Keyframe.ofFloat(0.75f, -5f), android.animation.Keyframe.ofFloat(1f, 0f))
      ObjectAnimator.ofPropertyValuesHolder(trash, lid).apply { duration = 500; start() }
      main.postDelayed(finishTrash, 500)
    } else finishTrash.run()
  }

  /** «Record more»: the preview gives way to a locked take again. */
  fun resumeLocked() {
    if (phase != Phase.PREVIEW) return
    phase = Phase.IDLE
    preview.visibility = View.GONE
    videoPreview.visibility = View.GONE
    trash.visibility = View.GONE
    recordMore.visibility = View.GONE
    button.sendFill = 0f
    button.iconName = idleIcon()
    begin(locked = true)
  }

  /** The owner's screen is gone: nothing ticks any more. */
  fun detached() {
    main.removeCallbacks(holdReached)
    main.removeCallbacks(clockTick)
    stopLoop()
    holdPending = false
  }

  /** `--es voicedemo recording` (debug builds): the take as it stands while the finger holds the button. */
  fun demoHolding() {
    timeWords = { "0:04,63" }
    begin(locked = false)
  }
}
