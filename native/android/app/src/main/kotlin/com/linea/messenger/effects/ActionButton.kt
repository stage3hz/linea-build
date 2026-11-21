package com.linea.messenger.effects

import android.animation.Keyframe
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.animation.OvershootInterpolator
import com.linea.messenger.design.Theme
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** The button with states for signing in and saving (the reference's `ActionButton`, effects.tsx → expokit
 *  `StatefulButton size="lg" block pill`, kit/ui/stateful-button.tsx; iOS Effects/ActionButton.swift): idle → loading (a
 *  spinner grows in beside the label) → success (the label rolls letter by letter to «Готово», a check draws itself, the
 *  button turns green) or error (a cross, «Ошибка», red, the button shakes) for 1.4 s after each new error. With the
 *  app's animations off (effects/Motion.kt) every change is shown at once. One view, drawn in place. */
class ActionButton(context: Context, label: String) : View(context) {
  enum class Phase { IDLE, LOADING, SUCCESS, ERROR }

  companion object {
    // size "lg": height 54, padding 22, font 17, icon 20, gap 9.
    const val HEIGHT = 54f
    private const val ICON = 20f
    private const val GAP = 9f
    const val STAGGER = 22.0

    /** Black or white, whichever reads better on the colour (kit's `readableOn`). */
    fun readable(color: Int): Int {
      val light = (Color.red(color) * 299 + Color.green(color) * 587 + Color.blue(color) * 114) / 1000
      return if (light > 150) 0xFF09090B.toInt() else Color.WHITE
    }

    fun easeOut(t: Double): Double = 1 - (1 - t).pow(3)
  }

  var onPress: (() -> Unit)? = null
  /** The label at rest (and while loading). */
  var label = label
    set(value) { if (field != value) { field = value; refresh() } }
  var successLabel = "Готово"
    set(value) { field = value; refresh() }
  /** While true the spinner turns and the button takes no touch. */
  var loading = false
    set(value) { if (field != value) { field = value; refresh() } }
  var success = false
    set(value) { if (field != value) { field = value; refresh() } }
  /** BusyButton's word for `success`. */
  var done: Boolean
    get() = success
    set(value) { success = value }
  /** The button's colour at rest (the theme's accent unless said otherwise). */
  var tint = Theme.accent
    set(value) { field = value; invalidate() }

  private val d = resources.displayMetrics.density
  private val main = Handler(Looper.getMainLooper())
  private var failed = false
  private var phase = Phase.IDLE
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val letters = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 17 * resources.displayMetrics.density; typeface = Theme.weight(700) }
  private var background = tint
  private var fromBackground = tint
  private var colorAt = 0L
  private var slot = 0f
  private var slotFrom = 0f
  private var slotTo = 0f
  private var slotAt = 0L
  private var iconAt = 0L
  private var drawAt = 0L
  private var pressScale = 1f
  // The rolling label: the letters coming in and those leaving.
  private var current = label
  private var leaving = ""
  private var rollAt = -1L
  private val markPath = Path()
  private val shown = Path()

  init {
    isClickable = true
    isFocusable = true
    contentDescription = label
    minimumHeight = (HEIGHT * d).toInt()
  }

  /** The words the button shows now (a screen reader and the page checks read them). */
  val shownText: String get() = current

  /** A new error happened: «Ошибка» with a cross for 1.4 s. */
  fun signalError() {
    main.removeCallbacksAndMessages(null)
    failed = true
    refresh()
    main.postDelayed({ failed = false; refresh() }, 1400)
  }

  override fun setEnabled(enabled: Boolean) { super.setEnabled(enabled); invalidate() }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(getDefaultSize(suggestedMinimumWidth, widthMeasureSpec), resolveSize((HEIGHT * d).toInt(), heightMeasureSpec))
  }

  private fun look(phase: Phase): Pair<Int, Int> = when (phase) {
    Phase.SUCCESS -> { val ok = if (Theme.dark) 0xFF3DD68C.toInt() else 0xFF16A34A.toInt(); ok to readable(ok) }
    Phase.ERROR -> (if (Theme.dark) 0xFFFF6369.toInt() else 0xFFE5484D.toInt()) to Color.WHITE
    else -> tint to readable(tint)
  }

  private fun refresh() {
    val next = if (loading) Phase.LOADING else if (success) Phase.SUCCESS else if (failed) Phase.ERROR else Phase.IDLE
    val text = if (next == Phase.SUCCESS) successLabel else if (next == Phase.ERROR) "Ошибка" else label
    contentDescription = label
    val moving = Motion.enabled
    if (text != current) {
      leaving = if (moving) current else ""
      current = text
      rollAt = if (moving) SystemClock.uptimeMillis() else -1L
    }
    if (next == phase) { invalidate(); return }
    if (next != Phase.IDLE) announceForAccessibility(text)
    val now = SystemClock.uptimeMillis()
    fromBackground = background; colorAt = if (moving) now else 0L
    slotFrom = slot; slotTo = if (next == Phase.IDLE) 0f else ICON + GAP; slotAt = if (moving) now else 0L
    iconAt = if (moving) now else 0L
    drawAt = if (moving) now + 90 else 0L
    phase = next
    if (next == Phase.SUCCESS || next == Phase.ERROR) {
      performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) (if (next == Phase.SUCCESS) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.REJECT) else HapticFeedbackConstants.LONG_PRESS)
      if (next == Phase.ERROR && moving) {
        val frames = listOf(0f, 10f, -8f, 6f, -4f, 2f, 0f).mapIndexed { index, value -> Keyframe.ofFloat(index / 6f, value * d) }.toTypedArray()
        ObjectAnimator.ofPropertyValuesHolder(this, PropertyValuesHolder.ofKeyframe(TRANSLATION_X, *frames)).apply { duration = 300 }.start()
      }
    }
    invalidate()
  }

  // ---- Touches ----

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (phase == Phase.LOADING || !isEnabled) return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> press(0.96f)
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> press(1f)
    }
    return super.onTouchEvent(event)
  }

  private fun press(to: Float) {
    if (!Motion.enabled) { pressScale = 1f; return }
    ValueAnimator.ofFloat(pressScale, to).apply {
      duration = if (to < 1f) 300 else 350
      interpolator = OvershootInterpolator(1.2f)
      addUpdateListener { pressScale = it.animatedValue as Float; invalidate() }
      start()
    }
  }

  override fun performClick(): Boolean {
    super.performClick()
    if (phase == Phase.LOADING) return true
    performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    onPress?.invoke()
    return true
  }

  // ---- Drawing ----

  private fun mix(a: Int, b: Int, t: Float): Int {
    val k = t.coerceIn(0f, 1f)
    fun part(shift: Int) = ((((a shr shift) and 255) * (1 - k)) + (((b shr shift) and 255) * k)).toInt() and 255
    return (part(24) shl 24) or (part(16) shl 16) or (part(8) shl 8) or part(0)
  }

  override fun onDraw(canvas: Canvas) {
    val now = SystemClock.uptimeMillis()
    var again = false
    val (target, ink) = look(phase)
    // The colour passes in 0.22 s.
    background = if (colorAt == 0L) target else mix(fromBackground, target, (now - colorAt) / 220f).also { if (now - colorAt < 220) again = true }
    // The icon's slot opens beside the label on a firm spring (0.45 s).
    slot = if (slotAt == 0L) slotTo else {
      val t = ((now - slotAt) / 450f).coerceIn(0f, 1f)
      if (t < 1f) again = true
      // Damping 0.95: nearly critical, no visible overshoot.
      val k = if (t >= 1f) 1f else (1 - exp(-8.0 * t) * (1 + 8.0 * t)).toFloat()
      slotFrom + (slotTo - slotFrom) * k
    }
    val w = width.toFloat(); val h = height.toFloat()
    canvas.save()
    canvas.scale(pressScale, pressScale, w / 2, h / 2)
    fill.color = background
    fill.alpha = if (isEnabled || phase != Phase.IDLE) Color.alpha(background) else (Color.alpha(background) * 0.5f).toInt()
    canvas.drawRoundRect(0f, 0f, w, h, h / 2, h / 2, fill)
    letters.color = ink
    val textWidth = letters.measureText(current)
    val slotPx = slot * d
    val rowWidth = slotPx + textWidth
    val left = (w - rowWidth) / 2
    val baseline = h / 2 - (letters.descent() + letters.ascent()) / 2
    // The icon.
    if (slotPx > 0.5f || phase != Phase.IDLE) {
      val side = ICON * d
      val cx = left + side / 2; val cy = h / 2
      var grow = 1f; var alpha = 1f
      if (iconAt != 0L) {
        val t = ((now - iconAt) / 500f).coerceIn(0f, 1f)
        if (t < 1f) again = true
        if (phase == Phase.IDLE) { val k = ((now - iconAt) / 140f).coerceIn(0f, 1f); grow = 1 - 0.7f * k; alpha = 1 - k }
        else { grow = 0.44f + 0.56f * (1 - exp(-6.0 * t) * cos(3.0 * t)).toFloat(); alpha = 0.2f + 0.8f * t }
      }
      canvas.save()
      canvas.translate(cx, cy)
      canvas.scale(grow, grow)
      val s = side / 24
      stroke.color = ink
      if (phase == Phase.LOADING) {
        // A faint full ring and a short bright arc (r 9 of 24, stroke 2.75, dash 15), turning once in 0.8 s.
        stroke.strokeWidth = 2.75f * s
        stroke.alpha = (alpha * 0.25f * 255).toInt()
        canvas.drawCircle(0f, 0f, 9 * s, stroke)
        stroke.alpha = (alpha * 255).toInt()
        val turn = ((now % 800) / 800f) * 360f
        val sweep = (15 / (2 * PI * 9) * 360).toFloat()
        canvas.drawArc(-9 * s, -9 * s, 9 * s, 9 * s, turn, sweep, false, stroke)
        again = true
      } else if (phase != Phase.IDLE || alpha > 0) {
        // The check (M6 12.5 l4 4 L18.5 8) or the cross (M7.5 7.5 l9 9 M16.5 7.5 l-9 9) draws itself.
        stroke.strokeWidth = 3 * s
        stroke.alpha = (alpha * 255).toInt()
        markPath.reset()
        if (phase == Phase.ERROR) {
          markPath.moveTo(7.5f * s, 7.5f * s); markPath.lineTo(16.5f * s, 16.5f * s)
          markPath.moveTo(16.5f * s, 7.5f * s); markPath.lineTo(7.5f * s, 16.5f * s)
        } else {
          markPath.moveTo(6 * s, 12.5f * s); markPath.lineTo(10 * s, 16.5f * s); markPath.lineTo(18.5f * s, 8 * s)
        }
        markPath.offset(-12 * s, -12 * s)
        var part = 1f
        if (drawAt != 0L) {
          val t = ((now - drawAt) / 380f).coerceIn(0f, 1f)
          if (t < 1f) again = true
          part = (1 - (1 - t).pow(3)).coerceIn(0f, 1f)
        }
        shown.reset()
        val measure = PathMeasure(markPath, false)
        var total = 0f
        do { total += measure.length } while (measure.nextContour())
        var budget = total * part
        val walk = PathMeasure(markPath, false)
        do {
          val length = walk.length
          if (budget > 0) walk.getSegment(0f, min(length, budget), shown, true)
          budget -= length
        } while (walk.nextContour())
        canvas.drawPath(shown, stroke)
      }
      canvas.restore()
    }
    // The label: letters rolling in from below, the old ones leaving upwards.
    val line = letters.textSize * 1.3f
    val textLeft = left + slotPx
    canvas.save()
    canvas.clipRect(0f, (h - line) / 2, w, (h + line) / 2)
    val ms = if (rollAt < 0) Double.MAX_VALUE else (now - rollAt).toDouble()
    var x = textLeft
    current.forEachIndexed { index, letter ->
      val text = letter.toString()
      val start = index * STAGGER + 60
      val fade = easeOut(((ms - start) / 200).coerceIn(0.0, 1.0))
      val t = ((ms - start) / 520).coerceIn(0.0, 1.0)
      val settle = if (t >= 1) 1.0 else 1 - exp(-7 * t) * cos(7 * t)
      letters.alpha = (fade * 255).toInt()
      canvas.drawText(text, x, baseline + line * (1 - settle).toFloat(), letters)
      x += letters.measureText(text)
    }
    if (leaving.isNotEmpty() && ms < 600) {
      val exitStagger = min(STAGGER, 120.0 / max(leaving.length, 1))
      var lx = (w - letters.measureText(leaving)) / 2
      leaving.forEachIndexed { index, letter ->
        val text = letter.toString()
        val start = index * exitStagger
        letters.alpha = ((1 - easeOut(((ms - start) / 110).coerceIn(0.0, 1.0))) * 255).toInt()
        val t = ((ms - start) / 300).coerceIn(0.0, 1.0)
        val eased = if (t < 0.5) 4 * t * t * t else 1 - (-2 * t + 2).pow(3) / 2
        canvas.drawText(text, lx, baseline - line * eased.toFloat(), letters)
        lx += letters.measureText(text)
      }
    }
    letters.alpha = 255
    canvas.restore()
    canvas.restore()
    if (rollAt >= 0 && ms < current.length * STAGGER + 60 + 520) again = true
    if (again && isAttachedToWindow) postInvalidateOnAnimation()
  }

  override fun onDetachedFromWindow() { main.removeCallbacksAndMessages(null); super.onDetachedFromWindow() }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
}
