package com.linea.messenger.voice

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.design.Theme

/** The small pictures of this feature, drawn in a square of `size` px around (cx, cy). */
object MediaIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()

  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int, weight: Float = 1.7f) {
    val u = size / 24f
    stroke.color = color; stroke.strokeWidth = weight * u
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
      "lock.open" -> {
        canvas.drawRoundRect(5f, 11f, 19f, 20.5f, 2.4f, 2.4f, stroke)
        path.moveTo(8.5f, 11f); path.lineTo(8.5f, 7.5f); path.cubicTo(8.5f, 2.8f, 15.5f, 2.8f, 15.5f, 6.2f)
        canvas.drawPath(path, stroke)
      }
      "chevron.up" -> {
        path.moveTo(6f, 15f); path.lineTo(12f, 9f); path.lineTo(18f, 15f)
        canvas.drawPath(path, stroke)
      }
      "xmark" -> {
        path.moveTo(6f, 6f); path.lineTo(18f, 18f); path.moveTo(18f, 6f); path.lineTo(6f, 18f)
        canvas.drawPath(path, stroke)
      }
      "circle.fill" -> canvas.drawCircle(12f, 12f, 10f, fill)
      "camera.flip" -> {
        canvas.drawRoundRect(2.5f, 7f, 21.5f, 19.5f, 3f, 3f, stroke)
        path.moveTo(8.5f, 7f); path.lineTo(10f, 4.5f); path.lineTo(14f, 4.5f); path.lineTo(15.5f, 7f)
        // Two arrows going round.
        path.moveTo(9f, 12.2f); path.cubicTo(10f, 9.6f, 14f, 9.6f, 15f, 12.2f)
        path.moveTo(15.4f, 10.2f); path.lineTo(15f, 12.2f); path.lineTo(13.1f, 11.6f)
        path.moveTo(15f, 14.4f); path.cubicTo(14f, 17f, 10f, 17f, 9f, 14.4f)
        path.moveTo(8.6f, 16.4f); path.lineTo(9f, 14.4f); path.lineTo(10.9f, 15f)
        canvas.drawPath(path, stroke)
      }
    }
    canvas.restore()
  }
}

/** The rules of the record button's gesture, kept to the number of the reference
 *  (mobile/src/videonote/recordGesture.ts). Distances are dp, speeds dp a second. */
object RecordGesture {
  const val holdMs = 190L
  const val cancelDistance = 150f
  const val lockDistance = 110f
  const val cancelOnRelease = 100f
  const val lockOnRelease = 60f
  const val flick = 400f
  /** A finger that moves this far before the hold began is neither a tap nor a hold. */
  const val allowedMove = 12f

  /** One axis at a time: the larger movement (left or up) wins; right and down count as nothing. */
  fun axis(dx: Float, dy: Float): Pair<Float, Float> {
    val left = minOf(0f, dx); val up = minOf(0f, dy)
    return if (-left > -up) Pair(left, 0f) else Pair(0f, up)
  }

  /** While moving: "cancel" or "lock" as soon as the distance is reached, else null (the take goes on). */
  fun move(x: Float, y: Float): String? = if (-x >= cancelDistance) "cancel" else if (-y >= lockDistance) "lock" else null

  /** On release: "cancel", "lock" or "send". */
  fun release(dx: Float, dy: Float, vx: Float, vy: Float): String {
    val left = -minOf(0f, dx); val up = -minOf(0f, dy)
    if (left >= cancelOnRelease || vx < -flick) return "cancel"
    if (up >= lockOnRelease || vy < -flick) return "lock"
    return "send"
  }
}

/** The record button of the composer and the strip that replaces the field while a voice take runs.
 *
 *  Reference: mobile/src/voice/RecordButton.tsx, mobile/src/videonote/recordGesture.ts (the rules, kept to the
 *  number) and `VoiceRecordingBar` of mobile/src/voice/VoiceMessage.tsx. A tap switches microphone ↔ round video;
 *  holding for 0.19 s records; while holding, sliding 150 dp left cancels and 110 dp up locks (hands free); on
 *  release a slide of 100 dp left (or a fast flick) cancels, 60 dp up (or a flick) locks, anything else sends.
 *  Locked: «Отмена», pause and the send button are on the strip. */
class RecordControl(private val context: Context) {
  enum class Mode { VOICE, VIDEO }
  enum class Phase { IDLE, HOLDING, LOCKED }

  var mode = Mode.VOICE
    private set
  var phase = Phase.IDLE
    private set
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val main = Handler(Looper.getMainLooper())

  /** The round button: the microphone or the camera at rest, the arrow on the accent while a take runs. */
  @SuppressLint("ClickableViewAccessibility")
  inner class Button : View(context) {
    private val plate = Paint(Paint.ANTI_ALIAS_FLAG)
    init { isFocusable = true }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun onDraw(canvas: Canvas) {
      val active = phase != Phase.IDLE
      if (active) { plate.color = Theme.accent; canvas.drawCircle(width / 2f, height / 2f, minOf(width, height) / 2f, plate) }
      val symbol = if (active) "arrow.up" else if (mode == Mode.VOICE) "mic" else "video"
      MediaIcons.draw(canvas, symbol, width / 2f, height / 2f, (if (active) 22f else 25f) * d, if (active) Theme.onAccent else Theme.text, if (active) 2.4f else 1.7f)
    }
    override fun onTouchEvent(event: MotionEvent): Boolean = touched(event)
    // The screen reader's double tap.
    override fun performClick(): Boolean { super.performClick(); tapped(); return true }
  }

  val button = Button()
  private val bar = object : ViewGroup(context) {
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = placeBar(right - left, bottom - top)
  }
  private val dot = View(context)
  private val timeLabel = TextView(context)
  private val slideLabel = TextView(context)
  private val cancelButton = TextView(context)
  private val pauseButton = object : View(context) {
    init { isClickable = true; isFocusable = true }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun onDraw(canvas: Canvas) =
      MediaIcons.draw(canvas, if (paused) "mic.fill" else "pause.fill", width / 2f, height / 2f, 22f * d, if (paused) Theme.danger else Theme.text)
  }
  private val lockPill = object : View(context) {
    override fun onDraw(canvas: Canvas) {
      MediaIcons.draw(canvas, "lock.open", width / 2f, 20f * d, 19f * d, Theme.text)
      MediaIcons.draw(canvas, "chevron.up", width / 2f, 46f * d, 15f * d, Theme.muted)
    }
  }
  private val lockHint = TextView(context)
  private var startX = 0f
  private var startY = 0f
  private var lastX = 0f
  private var lastY = 0f
  private var lastTime = 0L
  private var velocityX = 0f
  private var velocityY = 0f
  private var blink = false
  private var paused = false
  private var ticks = 0
  private var ticking = false
  /** The finger is down and the hold has not begun (or was given up). */
  private var pressing = false
  private var holdBegan = false

  /** A tap: the mode was switched (the owner shows the hint in the field). */
  var onModeChanged: ((Mode) -> Unit)? = null
  /** The finger is down long enough in the microphone mode: the take must start. False: it did not. */
  var onHoldStart: (() -> Boolean)? = null
  /** The same in the video mode: the round video recorder opens. */
  var onVideo: (() -> Unit)? = null
  /** The take ends: true to send it, false to call it off. */
  var onFinish: ((Boolean) -> Unit)? = null
  var onPause: (() -> Unit)? = null
  /** The length of the take by now, for the strip's clock («0:04,63»). */
  var timeWords: (() -> String)? = null
  /** The parts changed their looks or places: the owner lays the screen out again. */
  var onChanged: (() -> Unit)? = null

  /** Adds the strip and the button to the composer, the lock and its hint to the screen. */
  fun install(composer: FrameLayout, host: ViewGroup) {
    bar.background = GradientDrawable().apply { setColor(Theme.bg); cornerRadius = 24f * d }
    bar.visibility = View.GONE
    bar.isClickable = true
    composer.addView(bar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    dot.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Theme.danger) }
    bar.addView(dot)
    timeLabel.textSize = 17f
    timeLabel.setTextColor(Theme.text)
    timeLabel.fontFeatureSettings = "tnum"
    timeLabel.gravity = Gravity.CENTER_VERTICAL
    timeLabel.includeFontPadding = false
    timeLabel.maxLines = 1
    bar.addView(timeLabel)
    slideLabel.text = "‹ Влево — отмена"
    slideLabel.textSize = 15f
    slideLabel.setTextColor(Theme.text)
    slideLabel.gravity = Gravity.CENTER
    slideLabel.includeFontPadding = false
    slideLabel.maxLines = 1
    bar.addView(slideLabel)
    cancelButton.text = "Отмена"
    cancelButton.textSize = 17f
    cancelButton.setTextColor(Theme.text)
    cancelButton.gravity = Gravity.CENTER
    cancelButton.includeFontPadding = false
    cancelButton.contentDescription = "Отменить запись"
    cancelButton.isClickable = true
    cancelButton.isFocusable = true
    cancelButton.setOnClickListener { if (phase == Phase.LOCKED) end(send = false) }
    bar.addView(cancelButton)
    pauseButton.setOnClickListener { if (phase == Phase.LOCKED) onPause?.invoke() }
    bar.addView(pauseButton)

    composer.addView(button, FrameLayout.LayoutParams(dp(40f), dp(40f), Gravity.END or Gravity.BOTTOM).apply { rightMargin = dp(4f); bottomMargin = dp(4f) })

    lockPill.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 20f * d; setStroke(maxOf(1, dp(1f)), 0x1FFFFFFF) }
    lockPill.visibility = View.GONE
    host.addView(lockPill)
    lockHint.text = "Вверх — без рук"
    lockHint.textSize = 12.5f
    lockHint.setTextColor(Theme.text)
    lockHint.gravity = Gravity.CENTER
    lockHint.includeFontPadding = false
    lockHint.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 12f * d }
    lockHint.visibility = View.GONE
    host.addView(lockHint)
    show()
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(maxOf(0, width), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(maxOf(0, height), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + maxOf(0, width), top + maxOf(0, height))
  }

  private fun placeBar(width: Int, height: Int) {
    val middle = height - dp(24f)
    put(dot, dp(16f), middle - dp(5f), dp(10f), dp(10f))
    put(timeLabel, dp(34f), middle - dp(12f), dp(92f), dp(24f))
    val rightEdge = if (phase == Phase.LOCKED) width - dp(96f) else width - dp(56f)
    put(slideLabel, dp(126f), middle - dp(12f), rightEdge - dp(126f), dp(24f))
    put(cancelButton, dp(126f), middle - dp(22f), rightEdge - dp(126f), dp(44f))
    put(pauseButton, width - dp(92f), middle - dp(20f), dp(40f), dp(40f))
  }

  /** Places the lock above the composer's trailing end, its hint beside it (the composer's frame in the
   *  screen, px). The button and the strip are placed by the composer itself. */
  fun place(composerLeft: Int, composerTop: Int, composerWidth: Int) {
    val pillLeft = composerLeft + composerWidth - dp(44f)
    val pillTop = composerTop - dp(76f)
    put(lockPill, pillLeft, pillTop, dp(40f), dp(66f))
    put(lockHint, pillLeft - dp(140f), pillTop + dp(18f), dp(132f), dp(28f))
  }

  /** Whether the button is on screen at all (the owner hides it while there is text to send). */
  fun setVisible(visible: Boolean) {
    if (phase != Phase.IDLE) return
    button.visibility = if (visible) View.VISIBLE else View.GONE
  }

  val isBusy: Boolean get() = phase != Phase.IDLE

  private val clock = object : Runnable {
    override fun run() {
      if (!ticking) return
      ticked()
      main.postDelayed(this, 50)
    }
  }

  private fun show() {
    val active = phase != Phase.IDLE
    bar.visibility = if (active) View.VISIBLE else View.GONE
    if (active) { button.visibility = View.VISIBLE; button.bringToFront() }
    lockPill.visibility = if (phase == Phase.HOLDING) View.VISIBLE else View.GONE
    if (phase != Phase.HOLDING) lockHint.visibility = View.GONE
    slideLabel.visibility = if (phase == Phase.HOLDING) View.VISIBLE else View.GONE
    cancelButton.visibility = if (phase == Phase.LOCKED) View.VISIBLE else View.GONE
    pauseButton.visibility = if (phase == Phase.LOCKED) View.VISIBLE else View.GONE
    pauseButton.contentDescription = if (paused) "Продолжить запись" else "Пауза"
    pauseButton.invalidate()
    (dot.background as? GradientDrawable)?.setColor(if (paused) Theme.muted else Theme.danger)
    button.contentDescription = if (phase == Phase.LOCKED) "Отправить голосовое сообщение"
      else if (mode == Mode.VOICE) "Голосовое: удерживай для записи, свайп влево — отмена, вверх — без рук. Нажми — переключить на видео"
      else "Видеосообщение: удерживай для записи. Нажми — переключить на голосовое"
    button.invalidate()
    if (active && !ticking) {
      ticking = true
      ticked()
      main.postDelayed(clock, 50)
    } else if (!active) {
      ticking = false
      main.removeCallbacks(clock)
      dot.alpha = 1f
      button.translationX = 0f
      button.scaleX = 1f; button.scaleY = 1f
      slideLabel.alpha = 0.85f
      slideLabel.translationX = 0f
    }
    bar.requestLayout()
    onChanged?.invoke()
  }

  private fun ticked() {
    timeLabel.text = timeWords?.invoke() ?: "0:00,00"
    ticks += 1
    // The red dot blinks every 0.6 s while the take runs.
    if (ticks % 12 == 0) blink = !blink
    dot.alpha = if (paused || !blink) 1f else 0.25f
  }

  /** The loudness right now: the button breathes with the voice. */
  fun setLevel(level: Float) {
    if (phase != Phase.LOCKED || paused) return
    val scale = 1f + level.coerceIn(0f, 1f) * 0.18f
    button.scaleX = scale; button.scaleY = scale
  }

  fun setPaused(value: Boolean) {
    paused = value
    show()
  }

  /** The take ended by itself (the limit, a failure): back to the resting button. */
  fun reset() {
    phase = Phase.IDLE
    paused = false
    show()
  }

  private fun end(send: Boolean) {
    phase = Phase.IDLE
    paused = false
    show()
    onFinish?.invoke(send)
  }

  private fun lock() {
    phase = Phase.LOCKED
    button.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    button.translationX = 0f
    show()
  }

  private fun tapped() {
    if (phase == Phase.LOCKED) {
      end(send = true)
      return
    }
    if (phase != Phase.IDLE) return
    mode = if (mode == Mode.VOICE) Mode.VIDEO else Mode.VOICE
    button.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    show()
    onModeChanged?.invoke(mode)
  }

  private val hold = Runnable { if (pressing) began() }

  /** The finger has been down for 0.19 s. */
  private fun began() {
    pressing = false
    if (phase != Phase.IDLE) return
    if (mode == Mode.VIDEO) {
      button.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      onVideo?.invoke()
      return
    }
    if (onHoldStart?.invoke() != true) return
    button.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    holdBegan = true
    startX = lastX; startY = lastY
    lastTime = SystemClock.uptimeMillis()
    velocityX = 0f; velocityY = 0f
    phase = Phase.HOLDING
    val hints = context.getSharedPreferences("invizent.hints", Context.MODE_PRIVATE)
    val shown = hints.getInt(hintKey, 0)
    // The lock is a gesture nobody guesses: the first few holds say it in words, beside the pill.
    lockHint.visibility = if (shown >= 5) View.GONE else View.VISIBLE
    if (shown < 5) hints.edit().putInt(hintKey, shown + 1).apply()
    show()
    if (shown < 5) lockHint.visibility = View.VISIBLE
  }

  /** The button's touches: a tap, or a hold with its slide (the finger's place on the screen, so the button's
   *  own movement under it does not count). */
  private fun touched(event: MotionEvent): Boolean {
    val x = event.rawX; val y = event.rawY
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        button.parent?.requestDisallowInterceptTouchEvent(true)
        startX = x; startY = y; lastX = x; lastY = y
        holdBegan = false
        if (phase == Phase.IDLE) {
          pressing = true
          main.postDelayed(hold, RecordGesture.holdMs)
        } else {
          pressing = phase == Phase.LOCKED
        }
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        if (pressing && phase == Phase.IDLE) {
          lastX = x; lastY = y
          // The finger left before the hold began: neither a tap nor a hold.
          if (Math.hypot((x - startX).toDouble(), (y - startY).toDouble()) > RecordGesture.allowedMove * d) { pressing = false; main.removeCallbacks(hold) }
          return true
        }
        if (phase != Phase.HOLDING || !holdBegan) return true
        val now = SystemClock.uptimeMillis()
        if (now - lastTime >= 1) {
          velocityX = (x - lastX) / d / ((now - lastTime) / 1000f)
          velocityY = (y - lastY) / d / ((now - lastTime) / 1000f)
        }
        lastX = x; lastY = y; lastTime = now
        val moved = RecordGesture.axis((x - startX) / d, (y - startY) / d)
        button.translationX = moved.first * 0.9f * d
        val progress = (-moved.first / RecordGesture.cancelDistance).coerceIn(0f, 1f)
        slideLabel.alpha = (1f - progress) * 0.85f
        slideLabel.translationX = -progress * 40f * d
        when (RecordGesture.move(moved.first, moved.second)) {
          "cancel" -> end(send = false)
          "lock" -> lock()
        }
        return true
      }
      MotionEvent.ACTION_UP -> {
        main.removeCallbacks(hold)
        if (pressing) {
          pressing = false
          button.performClick()
          return true
        }
        if (phase != Phase.HOLDING || !holdBegan) return true
        when (RecordGesture.release((x - startX) / d, (y - startY) / d, velocityX, velocityY)) {
          "cancel" -> end(send = false)
          "lock" -> lock()
          else -> end(send = true)
        }
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        main.removeCallbacks(hold)
        pressing = false
        if (phase == Phase.HOLDING && holdBegan) end(send = false)
        return true
      }
    }
    return true
  }

  /** The owner's screen is gone: nothing ticks any more. */
  fun detached() {
    main.removeCallbacks(hold)
    main.removeCallbacks(clock)
    ticking = false
    pressing = false
  }

  /** `--es voicedemo recording` (debug builds): the strip as it stands while the finger holds the button. */
  fun demoHolding() {
    phase = Phase.HOLDING
    show()
    lockHint.visibility = View.VISIBLE
  }

  private companion object {
    const val hintKey = "invizent.hint.voice-lock.v1"
  }
}
