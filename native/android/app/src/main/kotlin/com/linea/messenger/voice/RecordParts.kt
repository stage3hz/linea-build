package com.linea.messenger.voice

import android.animation.TimeInterpolator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.graphics.Typeface
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import android.view.animation.PathInterpolator
import com.linea.messenger.design.Glass
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.Theme
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/** The pieces of the composer's record button (owner's spec; the iPhone's Sources/Voice/RecordParts.swift has the
 *  same numbers): the swelling blob, the lock, «slide to cancel», the tooltip, the preview of a stopped voice take. */
object RecordSpec {
  const val holdMs = 190L
  const val touchDebounceMs = 400L
  const val cancelDistance = 150f
  const val lockDistance = 110f
  const val cancelOnRelease = 100f
  const val lockOnRelease = 60f
  const val flick = 400f
  const val shrinkDistance = 300f
  const val minScale = 0.4f
  const val lockRange = 105f
  const val follow = 0.3f
  const val levelFollow = 0.1f
  const val blobSide = 220f
  const val blobHitSide = 110f
  const val lockLift = 122f
  const val dotColor = 0xFFFF2D55.toInt()
  const val binColor = 0xFFFF3B30.toInt()
  const val layoutMs = 400L
  /** The composer's transitions: 0.4 s on this curve. */
  fun layoutCurve(): TimeInterpolator = PathInterpolator(0.38f, 0.7f, 0.125f, 1f)
  fun easeInOut(): TimeInterpolator = PathInterpolator(0.42f, 0f, 0.58f, 1f)
  val controlColor: Int get() = Theme.muted

  fun smooth(value: Float): Float { val x = value.coerceIn(0f, 1f); return x * x * (3 - 2 * x) }
}

/** The rules of the record button's gesture (owner's spec). Distances are dp, speeds dp a second; offsets count
 *  only left and up (≤ 0). */
object RecordGesture {
  const val holdMs = RecordSpec.holdMs
  const val cancelDistance = RecordSpec.cancelDistance
  const val lockDistance = RecordSpec.lockDistance
  const val cancelOnRelease = RecordSpec.cancelOnRelease
  const val lockOnRelease = RecordSpec.lockOnRelease
  const val flick = RecordSpec.flick

  /** One axis at a time (on release): the larger of left and up; right and down count as nothing. */
  fun axis(dx: Float, dy: Float): Pair<Float, Float> {
    val left = minOf(0f, dx); val up = minOf(0f, dy)
    return if (Math.abs(left) > Math.abs(up)) Pair(left, 0f) else Pair(0f, up)
  }

  /** While holding (both directions count at once): "cancel" past 150 dp left, "lock" past 110 dp up, else null. */
  fun move(dx: Float, dy: Float): String? = if (dx < -cancelDistance) "cancel" else if (dy < -lockDistance) "lock" else null

  /** On release: the larger movement decides; past 100 dp left (or a flick faster than 400 dp/s) cancels, past 60 dp up
   *  (or such a flick up) locks, anything else sends. */
  fun release(dx: Float, dy: Float, vx: Float, vy: Float): String {
    val (x, y) = axis(dx, dy)
    if (vx < -flick || x < -cancelOnRelease) return "cancel"
    if (vy < -flick || y < -lockOnRelease) return "lock"
    return "send"
  }
}

/** A damped spring as a time curve: the system's spring of `durationMs` with `damping` (the share of critical
 *  damping). The natural frequency is chosen so that the swing has died down to 0.1 % at the end of the duration
 *  (ω₀ = ln 1000 / (ζ·T)); below critical damping x(t) = 1 − e^(−ζω₀t)(cos ω_d t + ζω₀/ω_d · sin ω_d t), at or
 *  above it the critically damped 1 − e^(−ω₀t)(1 + ω₀t). */
class SpringCurve(private val damping: Float, private val durationMs: Long) : TimeInterpolator {
  private val zeta = damping.coerceIn(0.01f, 1f).toDouble()
  private val seconds = durationMs / 1000.0
  private val omega = Math.log(1000.0) / (zeta * seconds)

  override fun getInterpolation(input: Float): Float {
    if (input >= 1f) return 1f
    val t = input * seconds
    val value = if (zeta < 1.0) {
      val wd = omega * Math.sqrt(1 - zeta * zeta)
      1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + zeta * omega / wd * Math.sin(wd * t))
    } else {
      1 - Math.exp(-omega * t) * (1 + omega * t)
    }
    return value.toFloat()
  }
}

// The blob

/** The swelling shapes around the button while a take runs: a solid circle (0.45…0.55 of the side with the level),
 *  a wavy shape at 30% (0.52…0.87) and one at 15% (0.57…1.0); the wavy ones take a new random form whenever the last
 *  one is reached, faster and wilder the louder the voice was, and grow from 0.75 in 0.35 s when the take starts. */
class RecordBlobView(context: Context) : View(context) {
  private class Wave(val minScale: Float, val maxScale: Float, val minSpeed: Float, val maxSpeed: Float, val minRandom: Float, val maxRandom: Float, val round: Boolean) {
    var from: FloatArray? = null
    var to: FloatArray? = null
    var started = 0L
    var durationMs = 1000L
    var speedLevel = 0f
  }

  private val d = resources.displayMetrics.density
  private val waves = listOf(
    Wave(0.57f, 1f, 0.9f, 4f, 1f, 1f, false),
    Wave(0.52f, 0.87f, 0.9f, 4f, 1f, 1f, false),
    Wave(0.45f, 0.55f, 0.2f, 0.6f, 0.1f, 0.5f, true),
  )
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private var level = 0f
  private var shownLevel = 0f
  private var presence = 0.75f
  private var presenceFrom = 0.75f
  private var presenceTo = 0.75f
  private var presenceStart = 0L
  private var presenceMs = 0L
  var running = false
    private set
  var color = Theme.accent
  /** The icon in the middle (Ionicons name), white. */
  var icon = "mic"
  var iconAlpha = 1f
  var iconScale = 1f
  /** The icon being replaced (shrinks away while `icon` grows). */
  var ghostIcon: String? = null
  var ghostScale = 1f
  var ghostAlpha = 0f
  private var stopAt = 0L

  private val frame = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      shownLevel = shownLevel * (1 - RecordSpec.levelFollow) + level * RecordSpec.levelFollow
      val now = System.currentTimeMillis()
      if (presenceMs > 0) {
        val progress = ((now - presenceStart).toFloat() / presenceMs).coerceIn(0f, 1f)
        presence = presenceFrom + (presenceTo - presenceFrom) * RecordSpec.smooth(progress)
        if (progress >= 1f) presenceMs = 0
      }
      invalidate()
      if (running || now < stopAt) Choreographer.getInstance().postFrameCallback(this)
    }
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    val side = RecordSpec.blobHitSide * d
    val inside = abs(event.x - width / 2f) <= side / 2 && abs(event.y - height / 2f) <= side / 2
    if (!inside && event.actionMasked == MotionEvent.ACTION_DOWN) return false
    return super.onTouchEvent(event)
  }

  fun updateLevel(value: Float) {
    val normal = value.coerceIn(0f, 1f)
    for (wave in waves) wave.speedLevel = max(wave.speedLevel, normal)
    level = normal
  }

  fun start() {
    if (running) return
    running = true
    animatePresence(1f, 350)
    val now = System.currentTimeMillis()
    for (wave in waves) if (!wave.round) { wave.from = points(wave.minRandom); nextShape(wave, now) }
    Choreographer.getInstance().removeFrameCallback(frame)
    Choreographer.getInstance().postFrameCallback(frame)
  }

  fun stop() {
    if (!running) return
    running = false
    animatePresence(0.75f, 150)
    stopAt = System.currentTimeMillis() + 200
  }

  private fun animatePresence(to: Float, ms: Long) {
    presenceFrom = presence; presenceTo = to; presenceStart = System.currentTimeMillis(); presenceMs = ms
  }

  private fun nextShape(wave: Wave, now: Long) {
    val speedLevel = wave.speedLevel
    wave.speedLevel = 0f
    wave.to = points(wave.minRandom + (wave.maxRandom - wave.minRandom) * speedLevel)
    wave.started = now
    wave.durationMs = (1000f / (wave.minSpeed + (wave.maxSpeed - wave.minSpeed) * speedLevel)).toLong()
  }

  /** 8 points around the centre (unit half side), each between 1 / (1 + randomness / 10) and 1 away, 45° apart
   *  give or take 10%. */
  private fun points(randomness: Float): FloatArray {
    val count = 8
    val step = (2 * PI / count).toFloat()
    val near = 1f / (1f + randomness / 10f)
    val begin = step * Math.random().toFloat()
    val out = FloatArray(count * 2)
    for (index in 0 until count) {
      val reach = near + Math.random().toFloat() * (1 - near)
      val wobble = step * 0.1f
      val angle = begin + index * (step + step * (wobble * Math.random().toFloat() - wobble * 0.5f))
      out[index * 2] = sin(angle) * reach
      out[index * 2 + 1] = cos(angle) * reach
    }
    return out
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f; val cy = height / 2f
    val half = RecordSpec.blobSide * d / 2
    val now = System.currentTimeMillis()
    val alphas = floatArrayOf(0.15f, 0.3f, 1f)
    for ((index, wave) in waves.withIndex()) {
      var scale = wave.minScale + (wave.maxScale - wave.minScale) * shownLevel
      if (!wave.round) scale *= presence
      paint.color = color
      paint.alpha = (alphas[index] * 255).toInt()
      if (wave.round) {
        canvas.drawCircle(cx, cy, half * scale, paint)
        continue
      }
      val from = wave.from ?: continue
      var to = wave.to ?: continue
      var progress = ((now - wave.started).toFloat() / wave.durationMs).coerceIn(0f, 1f)
      if (progress >= 1f && running) {
        wave.from = to
        nextShape(wave, now)
        to = wave.to ?: to
        progress = 0f
      }
      val eased = RecordSpec.smooth(progress)
      val current = FloatArray(16) { from[it] + ((wave.to ?: to)[it] - from[it]) * eased }
      blobPath(current, cx, cy, half * scale)
      canvas.drawPath(path, paint)
    }
    ghostIcon?.let { if (ghostAlpha > 0f) IonIcon.draw(canvas, it, cx, cy, 28f * d * ghostScale, applyAlpha(0xFFFFFFFF.toInt(), ghostAlpha)) }
    if (iconAlpha > 0f) IonIcon.draw(canvas, icon, cx, cy, 28f * d * iconScale, applyAlpha(0xFFFFFFFF.toInt(), iconAlpha))
  }

  private fun applyAlpha(color: Int, alpha: Float): Int = (((color ushr 24) * alpha).toInt().coerceIn(0, 255) shl 24) or (color and 0xFFFFFF)

  /** Each point gets a tangent along the line from its previous to its next neighbour, handles the circle share of
   *  the distance to the neighbours. */
  private fun blobPath(points: FloatArray, cx: Float, cy: Float, radius: Float) {
    val count = points.size / 2
    val step = (2 * PI / count).toFloat()
    val share = ((4f / 3f) * tan(step / 4)) / sin(step / 2) / 2
    val xs = FloatArray(count) { cx + points[it * 2] * radius }
    val ys = FloatArray(count) { cy + points[it * 2 + 1] * radius }
    val outX = FloatArray(count); val outY = FloatArray(count); val inX = FloatArray(count); val inY = FloatArray(count)
    for (i in 0 until count) {
      val p = (i + count - 1) % count; val n = (i + 1) % count
      val dx = xs[n] - xs[p]; val dy = ys[n] - ys[p]
      val length = max(0.0001f, hypot(dx, dy))
      val ux = dx / length; val uy = dy / length
      val outLength = share * hypot(xs[n] - xs[i], ys[n] - ys[i])
      val inLength = share * hypot(xs[p] - xs[i], ys[p] - ys[i])
      outX[i] = xs[i] + ux * outLength; outY[i] = ys[i] + uy * outLength
      inX[i] = xs[i] - ux * inLength; inY[i] = ys[i] - uy * inLength
    }
    path.reset()
    path.moveTo(xs[0], ys[0])
    for (i in 0 until count) {
      val n = (i + 1) % count
      path.cubicTo(outX[i], outY[i], inX[n], inY[n], xs[n], ys[n])
    }
    path.close()
  }
}

// The lock

/** The lock above the button: a glass pill 40 × 72 dp with the padlock drawn in a 40 × 60 box. At rest it is open
 *  and bobs with the arrow under it (2 s each way); as the finger slides up (`lockness`) the shackle drops into the
 *  body, the arrow folds away and the body becomes a 16 dp rounded square (the stop button); the pill shrinks to a
 *  40 dp circle at its lower end (72 − 32 × lockness tall, 40 × lockness down). */
@SuppressLint("ViewConstructor")
class RecordLockPanel(context: Context, source: GlassSource?) : View(context) {
  private val d = resources.displayMetrics.density
  private val glass = Glass(this).apply { this.source = source }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val path = Path()
  private val part = Path()
  private val measure = PathMeasure()
  var lockness = 0f
    private set
  var locked = false
    private set
  var onStop: (() -> Unit)? = null
  private val born = System.currentTimeMillis()

  init {
    isClickable = true
    contentDescription = "Остановить и прослушать"
  }

  private val ticker = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      if (lockness <= 0f && isAttachedToWindow && visibility == VISIBLE) { invalidate(); Choreographer.getInstance().postFrameCallback(this) }
    }
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); Choreographer.getInstance().postFrameCallback(ticker) }

  fun update(value: Float) {
    val was = lockness
    lockness = value.coerceIn(0f, 1f)
    if (lockness <= 0f && was > 0f) { Choreographer.getInstance().removeFrameCallback(ticker); Choreographer.getInstance().postFrameCallback(ticker) }
    invalidate()
  }

  fun lock() {
    locked = true
    val start = lockness
    val animator = android.animation.ValueAnimator.ofFloat(start, 1f)
    animator.duration = 200
    animator.addUpdateListener { update(it.animatedValue as Float) }
    animator.start()
  }

  fun reset() { locked = false; update(0f) }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (!locked) return false
    if (event.actionMasked == MotionEvent.ACTION_UP) { performClick() }
    return true
  }

  override fun performClick(): Boolean { super.performClick(); if (locked) onStop?.invoke(); return true }

  private fun ease(from: Float, to: Float, frame: Float, a: Float, b: Float): Float {
    if (frame <= a) return from
    if (frame >= b) return to
    return from + (to - from) * RecordSpec.smooth((frame - a) / (b - a))
  }

  /** The resting bob, 0…1…0 over 4 s: keyframes at 0, 0.375, 0.4917, 0.625, 1 of each 2 s half. */
  private fun bob(values: FloatArray): Float {
    val ms = ((System.currentTimeMillis() - born) % 4000L).toFloat()
    val t = if (ms < 2000f) ms / 2000f else (4000f - ms) / 2000f
    val keys = floatArrayOf(0f, 0.375f, 0.4917f, 0.625f, 1f)
    for (i in 0 until 4) if (t <= keys[i + 1]) {
      val local = (t - keys[i]) / (keys[i + 1] - keys[i])
      return values[i] + (values[i + 1] - values[i]) * RecordSpec.smooth(local)
    }
    return values[4]
  }

  override fun onDraw(canvas: Canvas) {
    val u = d
    glass.draw(canvas, 0f, 40f * lockness * u, 40f * u, 72f * u, 20f * u)
    val color = RecordSpec.controlColor
    fill.color = color; line.color = color; line.strokeWidth = 1.33f * u
    canvas.save()
    canvas.translate(0f, (6f - 16f * lockness) * u + 40f * lockness * u)
    canvas.scale(u, u)
    val frame = lockness * 30f
    val bodyY = if (lockness <= 0f) 25f else if (frame <= 13f) ease(25f, 33.33f, frame, 0f, 13f) else ease(33.33f, 30f, frame, 13f, 23f)
    val bodyHeight = ease(14f, 16f, frame, 13f, 23f)
    // The shackle, its right foot at (25, bodyY + footY), tilted around it.
    val footY = ease(-5.33f, 6.67f, frame, 0f, 15f)
    val restingDrop = if (lockness <= 0f) bob(floatArrayOf(0f, 1.667f, 0.833f, 1.667f, 0f)) else 0f
    val tilt = if (lockness <= 0f) bob(floatArrayOf(10f, 0f, 5f, 0f, 10f)) else ease(10f, 0f, frame, 0f, 10f)
    path.reset()
    path.moveTo(-10f, -4f); path.lineTo(-10f, -7f)
    path.arcTo(RectF(-10f, -12f, 0f, -2f), 180f, 180f, false)
    path.lineTo(0f, 0f)
    val start = if (frame <= 10f) ease(0f, 0.07f, frame, 0f, 10f) else ease(0.07f, 0.5f, frame, 10f, 15f)
    val end = if (frame <= 10f) ease(0.9f, 0.79f, frame, 0f, 10f) else ease(0.79f, 0.5f, frame, 10f, 13f)
    canvas.save()
    canvas.translate(25f, bodyY + footY + restingDrop)
    canvas.rotate(tilt)
    drawTrimmed(canvas, path, if (lockness <= 0f) 0f else start, if (lockness <= 0f) 0.9f else end)
    canvas.restore()
    // The arrow.
    path.reset()
    path.moveTo(-8f, 3f); path.lineTo(0f, -3f); path.lineTo(8f, 3f)
    val arrowY = if (lockness <= 0f) 47f + bob(floatArrayOf(0f, -1.667f, -0.833f, -1.667f, 0f)) else bodyY + ease(22f, 1.34f, frame, 0f, 16f)
    canvas.save()
    canvas.translate(20f, arrowY)
    drawTrimmed(canvas, path, ease(0f, 0.5f, frame, 5f, 12f), ease(1f, 0.5f, frame, 5f, 12f))
    canvas.restore()
    // The body (drawn last: it covers the shackle's feet).
    canvas.drawRoundRect(20f - 8f, bodyY - bodyHeight / 2, 20f + 8f, bodyY + bodyHeight / 2, 3f, 3f, fill)
    canvas.restore()
  }

  private fun drawTrimmed(canvas: Canvas, whole: Path, from: Float, to: Float) {
    if (to - from <= 0.001f) return
    measure.setPath(whole, false)
    val length = measure.length
    part.reset()
    measure.getSegment(from * length, to * length, part, true)
    canvas.drawPath(part, line)
  }
}

// «Slide to cancel»

/** The arrow (a 9 × 18 chevron) and «Влево — отмена» 14 sp in the quiet colour, 6 dp apart; locked, «Отмена» 17 sp
 *  in the accent colour (the words rise 22 dp and shrink to a quarter, the button comes up from 22 dp below). */
class RecordCancelIndicator(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val words = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 14f * resources.displayMetrics.scaledDensity }
  private val cancelWords = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 17f * resources.displayMetrics.scaledDensity }
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val path = Path()
  private val label = "Влево — отмена"
  private val cancelLabel = "Отмена"
  /** 0 = «slide to cancel», 1 = «Отмена». */
  var swap = 0f
    set(value) { field = value; invalidate() }
  val showingCancel: Boolean get() = swap >= 0.5f
  var onCancel: (() -> Unit)? = null

  init { contentDescription = "Отменить запись" }

  val naturalWidth: Int get() = Math.ceil((9f * d + 12f * d + words.measureText(label)).toDouble()).toInt()
  val naturalHeight: Int get() = Math.ceil(maxOf(18f * d, 20f * d).toDouble()).toInt()

  override fun onDraw(canvas: Canvas) {
    val h = height.toFloat()
    val labelWidth = words.measureText(label)
    val fade = 1f - swap
    if (fade > 0f) {
      line.color = RecordSpec.controlColor; line.alpha = (fade * 255).toInt(); line.strokeWidth = 1.33f * d
      canvas.save()
      canvas.translate(0f, (h - 18f * d) / 2)
      canvas.scale(d, d)
      path.reset(); path.moveTo(7.97f, 0.97f); path.lineTo(0.97f, 9f); path.lineTo(7.97f, 17.03f)
      canvas.drawPath(path, line)
      canvas.restore()
      words.color = RecordSpec.controlColor; words.alpha = (fade * 255).toInt()
      val scale = 1f - 0.75f * swap
      canvas.save()
      val lx = 9f * d + 6f * d; val ly = h / 2 - 22f * d * swap
      canvas.scale(scale, scale, lx + labelWidth / 2, ly)
      canvas.drawText(label, lx, ly - (words.descent() + words.ascent()) / 2 + d, words)
      canvas.restore()
    }
    if (swap > 0f) {
      cancelWords.color = Theme.accent; cancelWords.alpha = (swap * 255).toInt()
      val cw = cancelWords.measureText(cancelLabel)
      val scale = 0.25f + 0.75f * swap
      val cy = h / 2 + 22f * d * (1 - swap)
      canvas.save()
      canvas.scale(scale, scale, width / 2f, cy)
      canvas.drawText(cancelLabel, (width - cw) / 2, cy - (cancelWords.descent() + cancelWords.ascent()) / 2, cancelWords)
      canvas.restore()
    }
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (!showingCancel) return false
    if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
    return true
  }

  override fun performClick(): Boolean { super.performClick(); if (showingCancel) onCancel?.invoke(); return true }
}

// The tooltip

/** A dark bubble (black at 80%, corners 10, an 18 × 9 arrow) with 14 sp white words, its arrow on the button's top
 *  centre; in 0.25 s, 2 s on screen, out in 0.3 s. */
class RecordTooltip(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xCC000000.toInt() }
  private val text = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textSize = 14f * resources.displayMetrics.scaledDensity }
  private var layout: android.text.StaticLayout? = null
  private var arrowX = 0f
  private val path = Path()
  private val hide = Runnable { dismiss() }

  init { alpha = 0f; isClickable = false; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES; accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE }

  /** `anchor`: the button, in the parent's coordinates. */
  fun show(words: String, anchor: RectF, parentWidth: Int) {
    val maxWidth = (parentWidth - 20f * d - 16f * d).toInt()
    val made = android.text.StaticLayout.Builder.obtain(words, 0, words.length, text, maxWidth).setAlignment(android.text.Layout.Alignment.ALIGN_CENTER).build()
    var wide = 0f
    for (i in 0 until made.lineCount) wide = max(wide, made.getLineWidth(i))
    val textW = Math.ceil(wide / 2.0).toFloat() * 2
    val textH = Math.ceil(made.height / 2.0).toFloat() * 2
    val boxW = textW + 12f * d; val boxH = textH + 34f * d
    val x = floor(min(max(8f * d, anchor.centerX() - boxW / 2), parentWidth - boxW - 8f * d))
    layout = android.text.StaticLayout.Builder.obtain(words, 0, words.length, text, textW.toInt().coerceAtLeast(1)).setAlignment(android.text.Layout.Alignment.ALIGN_CENTER).build()
    arrowX = anchor.centerX() - x
    contentDescription = words
    measure(MeasureSpec.makeMeasureSpec(boxW.toInt(), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(boxH.toInt(), MeasureSpec.EXACTLY))
    layout(x.toInt(), (anchor.top - boxH).toInt(), (x + boxW).toInt(), anchor.top.toInt())
    bringToFront()
    invalidate()
    if (alpha < 1f) animate().alpha(1f).setDuration(250).start()
    removeCallbacks(hide)
    postDelayed(hide, 2000)
  }

  fun dismiss() {
    removeCallbacks(hide)
    if (alpha > 0f) animate().alpha(0f).setDuration(300).start()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    val r = 10f * d; val inset = 9f * d; val aw = 18f * d
    val ax = arrowX.coerceIn(r + aw / 2, w - r - aw / 2)
    path.reset()
    path.addRoundRect(0f, inset, w, h - inset, r, r, Path.Direction.CW)
    path.moveTo(ax - aw / 2, h - inset); path.lineTo(ax, h); path.lineTo(ax + aw / 2, h - inset); path.close()
    canvas.drawPath(path, paint)
    val made = layout ?: return
    canvas.save()
    canvas.translate(6f * d, 17f * d)
    made.draw(canvas)
    canvas.restore()
  }
}

// «Record more»

/** A 40 dp glass circle (in a 44 dp box) with the microphone; pressed it goes to (w − 8) / w in 0.2 s and comes
 *  back through (w + 2) / w (0.13 s out, 0.1 s in). */
@SuppressLint("ViewConstructor")
class RecordMoreButton(context: Context, source: GlassSource?) : View(context) {
  private val d = resources.displayMetrics.density
  private val glass = Glass(this).apply { this.source = source }

  init { isClickable = true; isFocusable = true; contentDescription = "Дописать" }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun onDraw(canvas: Canvas) {
    glass.draw(canvas, 2f * d, 2f * d, width - 2f * d, height - 2f * d, 20f * d)
    IonIcon.draw(canvas, "mic-outline", width / 2f, height / 2f, 24f * d, RecordSpec.controlColor)
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { val top = (width - 8f * d) / width; animate().scaleX(top).scaleY(top).setDuration(200).setInterpolator(RecordSpec.easeInOut()).start() }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val most = (width + 2f * d) / width
        animate().scaleX(most).scaleY(most).setDuration(130).withEndAction { animate().scaleX(1f).scaleY(1f).setDuration(100).start() }.start()
        if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
      }
    }
    return true
  }
}

// The preview of a stopped voice take

/** The stopped take in the field, 40 dp tall: an accent capsule (3 dp in, 34 dp tall) over the kept part, the
 *  waveform (2 dp bars 1 dp apart, up to 12 dp, in a 13 dp band 21 dp in from the sides), white grips (3 × 12) on
 *  16 dp handles that trim the take (from 2 s on), and a 63 × 22 capsule with play/pause and the time. */
class VoicePreviewPanel(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  var onToggle: (() -> Unit)? = null
  var onSeek: ((Double) -> Unit)? = null
  var onTrim: ((Double, Double, Boolean) -> Unit)? = null
  var allowsTrim = true
  private var samples: List<Double> = emptyList()
  private var durationMs = 0L
  var trimStart = 0.0
    private set
  var trimEnd = 1.0
    private set
  private var progress = 0.0
  private var playing = false
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val timePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); textSize = 13f * resources.displayMetrics.scaledDensity; fontFeatureSettings = "tnum"; textAlign = Paint.Align.RIGHT }
  private val rect = RectF()
  private var dragging = 0 // 0 none, 1 left, 2 right, 3 tap
  private var downX = 0f
  private val handle = 16f

  init { isClickable = true; contentDescription = "Прослушать" }

  fun setTake(levels: List<Double>, durationMs: Long) {
    samples = levels; this.durationMs = durationMs
    trimStart = 0.0; trimEnd = 1.0; progress = 0.0; playing = false
    invalidate()
  }

  fun setPlayback(fraction: Double, nowPlaying: Boolean) {
    progress = fraction.coerceIn(0.0, 1.0); playing = nowPlaying
    contentDescription = if (playing) "Пауза" else "Прослушать"
    invalidate()
  }

  private val track: Float get() = max(0f, width - 6f * d)

  private fun handles(): Pair<Float, Float> {
    val range = track - handle * d
    val left = floor(handle * d / 2 + range * trimStart.toFloat()) - handle * d / 2
    var right = floor(handle * d / 2 + range * trimEnd.toFloat()) - handle * d / 2
    right = max(left + handle * d, right)
    return Pair(3f * d + left, 3f * d + right)
  }

  override fun onDraw(canvas: Canvas) {
    val (left, right) = handles()
    val rightEnd = right + handle * d
    paint.color = Theme.accent
    rect.set(left, 3f * d, rightEnd, 37f * d)
    canvas.drawRoundRect(rect, 17f * d, 17f * d, paint)
    val trims = durationMs >= 2000 && allowsTrim
    if (allowsTrim) {
      val bandLeft = 21f * d; val bandWidth = max(0f, width - 42f * d); val bandTop = floor((40f - 13f) / 2f) * d
      val count = floor(bandWidth / (3f * d)).toInt()
      if (count > 0) {
        val bars = DoubleArray(count)
        for ((index, sample) in samples.withIndex()) { val slot = min(count - 1, index * count / max(1, samples.size)); bars[slot] = max(bars[slot], sample) }
        val loudest = max(0.0001, bars.maxOrNull() ?: 0.0)
        val playedX = bandLeft + progress.toFloat() * bandWidth
        val showPlayed = playing || progress > trimStart + 0.0001
        for (i in 0 until count) {
          val x = bandLeft + i * 3f * d
          val inside = x + d >= left && x + d <= rightEnd
          paint.color = when {
            !inside -> applyAlpha(RecordSpec.controlColor, 0.4f)
            showPlayed && x + d <= playedX -> Theme.onAccent
            else -> applyAlpha(Theme.onAccent, 0.5f)
          }
          val barH = min(12f, (bars[i] / loudest * 12).toFloat()) * d
          if (barH <= 2f * d) canvas.drawCircle(x + d, bandTop + 6.5f * d, d, paint)
          else { rect.set(x, bandTop + (13f * d - barH) / 2, x + 2f * d, bandTop + (13f * d + barH) / 2); canvas.drawRoundRect(rect, d, d, paint) }
        }
      }
    }
    if (trims) {
      paint.color = 0xFFFFFFFF.toInt()
      rect.set(left + 8f * d, 14f * d, left + 11f * d, 26f * d); canvas.drawRoundRect(rect, d, d, paint)
      rect.set(right + handle * d - 11f * d, 14f * d, right + handle * d - 8f * d, 26f * d); canvas.drawRoundRect(rect, d, d, paint)
    }
    val zone = max(0f, right - (left + handle * d))
    val wide = zone >= 70f * d
    val bw = (if (wide) 63f else 27f) * d
    val bx = left + handle * d + (zone - bw) / 2
    paint.color = applyAlpha(Theme.bg, 0.7f)
    rect.set(bx, 9f * d, bx + bw, 31f * d)
    canvas.drawRoundRect(rect, 11f * d, 11f * d, paint)
    val ink = applyAlpha(Theme.text, 0.7f)
    IonIcon.draw(canvas, if (playing) "pause" else "play", bx + 3f * d + 10.5f * d, 20f * d, 13f * d, ink)
    if (wide) {
      timePaint.color = ink
      val shown = if (playing || progress > trimStart + 0.0001) max(0.0, durationMs * (trimEnd - progress)) else durationMs * (trimEnd - trimStart)
      val words = com.linea.messenger.attachments.FileCore.call("voiceTime", listOf(Math.round(shown))) as? String ?: ""
      canvas.drawText(words, bx + 53f * d, 20f * d - (timePaint.descent() + timePaint.ascent()) / 2, timePaint)
    }
  }

  private fun applyAlpha(color: Int, alpha: Float): Int = (((color ushr 24) * alpha).toInt().coerceIn(0, 255) shl 24) or (color and 0xFFFFFF)

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    val (left, right) = handles()
    val x = event.x
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = x
        val trims = durationMs >= 2000 && allowsTrim
        dragging = when {
          trims && abs(x - (left + handle * d / 2)) <= (handle / 2 + 9f) * d -> 1
          trims && abs(x - (right + handle * d / 2)) <= (handle / 2 + 9f) * d -> 2
          else -> 3
        }
        parent?.requestDisallowInterceptTouchEvent(true)
      }
      MotionEvent.ACTION_MOVE -> if (dragging == 1 || dragging == 2) {
        val range = max(1f, track - handle * d)
        val fraction = ((x - 3f * d - handle * d / 2) / range).toDouble().coerceIn(0.0, 1.0)
        val least = max(1000.0, 56.0 * durationMs / max(1.0, (track / d).toDouble())) / max(1L, durationMs)
        if (dragging == 1) trimStart = min(fraction, trimEnd - least).coerceAtLeast(0.0) else trimEnd = max(fraction, trimStart + least).coerceAtMost(1.0)
        invalidate()
        onTrim?.invoke(trimStart, trimEnd, false)
      }
      MotionEvent.ACTION_UP -> {
        if (dragging == 1 || dragging == 2) onTrim?.invoke(trimStart, trimEnd, true)
        else if (dragging == 3 && abs(x - downX) < 12f * d) {
          val zone = max(0f, right - (left + handle * d))
          val bw = (if (zone >= 70f * d) 63f else 27f) * d
          val bx = left + handle * d + (zone - bw) / 2
          if (x >= bx && x <= bx + bw || !allowsTrim) onToggle?.invoke()
          else {
            val fraction = ((x - 21f * d) / max(1f, width - 42f * d)).toDouble().coerceIn(0.0, 1.0)
            onSeek?.invoke(fraction.coerceIn(trimStart, trimEnd))
          }
        }
        dragging = 0
      }
      MotionEvent.ACTION_CANCEL -> dragging = 0
    }
    return true
  }
}

// The preview of a stopped round video

/** The stopped round video in the field: a strip of its frames 33 dp tall with round ends, two accent handles 16 dp
 *  wide with white grips (3 × 12, 10 dp in from the outer edge) that trim it, accent lines along the kept part, the
 *  rest dimmed. A tap plays or pauses the circle. */
class VideoTrimPanel(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  var onToggle: (() -> Unit)? = null
  var onTrim: ((Double, Double, Boolean) -> Unit)? = null
  private var frames: List<android.graphics.Bitmap> = emptyList()
  private var durationMs = 0L
  var trimStart = 0.0
    private set
  var trimEnd = 1.0
    private set
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val rect = RectF()
  private val src = android.graphics.Rect()
  private val clip = Path()
  private var dragging = 0
  private var downX = 0f
  private val handle = 16f
  private val track = 33f

  init { isClickable = true; contentDescription = "Видеосообщение: нажмите, чтобы остановить или продолжить" }

  fun setTake(durationMs: Long) { this.durationMs = durationMs; trimStart = 0.0; trimEnd = 1.0; frames = emptyList(); invalidate() }
  fun setFrames(images: List<android.graphics.Bitmap>) { frames = images; invalidate() }
  val frameCount: Int get() = maxOf(1, Math.ceil(((width - 6f * d) / (track * d)).toDouble()).toInt())

  private fun handles(): Pair<Float, Float> {
    val range = maxOf(0f, width - 6f * d) - handle * d
    val left = floor(handle * d / 2 + range * trimStart.toFloat()) - handle * d / 2
    val right = max(left + handle * d, floor(handle * d / 2 + range * trimEnd.toFloat()) - handle * d / 2)
    return Pair(3f * d + left, 3f * d + right)
  }

  override fun onDraw(canvas: Canvas) {
    val top = (height - track * d) / 2
    val bottom = top + track * d
    val stripRight = width - 3f * d
    rect.set(3f * d, top, stripRight, bottom)
    canvas.save()
    clip.reset(); clip.addRoundRect(rect, 16.5f * d, 16.5f * d, Path.Direction.CW)
    canvas.clipPath(clip)
    paint.color = Theme.surface2
    canvas.drawRect(rect, paint)
    val side = track * d
    for ((index, bitmap) in frames.withIndex()) {
      val w = bitmap.width; val h = bitmap.height; val s = minOf(w, h)
      src.set((w - s) / 2, (h - s) / 2, (w - s) / 2 + s, (h - s) / 2 + s)
      val x = 3f * d + index * side
      canvas.drawBitmap(bitmap, src, RectF(x, top, x + side, bottom), paint)
    }
    val (left, right) = handles()
    paint.color = (Theme.bg and 0xFFFFFF) or (0x99 shl 24)
    canvas.drawRect(3f * d, top, left, bottom, paint)
    canvas.drawRect(right + handle * d, top, stripRight, bottom, paint)
    canvas.restore()
    paint.color = Theme.accent
    canvas.save(); canvas.clipRect(left, top, left + handle * d, bottom)
    canvas.drawRoundRect(RectF(left, top, left + handle * d * 2, bottom), 16.5f * d, 16.5f * d, paint)
    canvas.restore()
    rect.set(right, top, right + handle * d, bottom)
    canvas.save(); canvas.clipRect(rect)
    canvas.drawRoundRect(RectF(right - handle * d, top, right + handle * d, bottom), 16.5f * d, 16.5f * d, paint)
    canvas.restore()
    canvas.drawRect(left + handle * d, top, right, top + 2f * d, paint)
    canvas.drawRect(left + handle * d, bottom - 2f * d, right, bottom, paint)
    paint.color = 0xFFFFFFFF.toInt()
    val gripTop = top + (track - 12f) / 2 * d
    canvas.drawRoundRect(RectF(left + 7f * d, gripTop, left + 10f * d, gripTop + 12f * d), d, d, paint)
    canvas.drawRoundRect(RectF(right + (handle - 10f) * d, gripTop, right + (handle - 7f) * d, gripTop + 12f * d), d, d, paint)
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    val (left, right) = handles()
    val x = event.x
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = x
        dragging = when {
          abs(x - (left + handle * d / 2)) <= (handle / 2 + 9f) * d -> 1
          abs(x - (right + handle * d / 2)) <= (handle / 2 + 9f) * d -> 2
          else -> 3
        }
        parent?.requestDisallowInterceptTouchEvent(true)
      }
      MotionEvent.ACTION_MOVE -> if (dragging == 1 || dragging == 2) {
        val range = max(1f, width - 6f * d - handle * d)
        val fraction = ((x - 3f * d - handle * d / 2) / range).toDouble().coerceIn(0.0, 1.0)
        val least = 1000.0 / maxOf(1L, durationMs)
        if (dragging == 1) trimStart = min(fraction, trimEnd - least).coerceAtLeast(0.0) else trimEnd = max(fraction, trimStart + least).coerceAtMost(1.0)
        invalidate()
        onTrim?.invoke(trimStart, trimEnd, false)
      }
      MotionEvent.ACTION_UP -> {
        if (dragging == 1 || dragging == 2) onTrim?.invoke(trimStart, trimEnd, true)
        else if (abs(x - downX) < 12f * d) { performClick(); onToggle?.invoke() }
        dragging = 0
      }
      MotionEvent.ACTION_CANCEL -> dragging = 0
    }
    return true
  }
}
