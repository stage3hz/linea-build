package com.linea.messenger.intro

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.view.Choreographer
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.FrameLayout
import com.linea.messenger.design.Fonts
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** The first-launch intro on the screen: the scene (intro/IntroGlView.kt) or, with motion reduced or where the scene
 *  cannot be drawn, four still stages; over it the hint «Проведи вверх». It feeds the person's way through the intro
 *  (`IntroFlow`) with the time of every frame and with the touches, and reports what happened (`onEvents`: the haptic
 *  swell starts, the honeycomb layer is passed, the intro is finished). There is nothing to tap and no way to skip. */
@SuppressLint("ViewConstructor")
class IntroView(context: Context, val flow: IntroFlow) : FrameLayout(context), Choreographer.FrameCallback {
  /** Bits of `IntroFlow.SWELL`, `PASS`, `FINISHED`. */
  var onEvents: ((Int) -> Unit)? = null

  private var scene: IntroGlView? = null
  private var stills: IntroStills? = null
  private val hint = IntroHint(context)
  private var running = false
  private var ready = false
  private var last = 0L
  private var left = -12.0
  private var right = 39.0
  private var downY = 0f
  private var tracker: VelocityTracker? = null
  private val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
  private val flingSpeed = 500f * resources.displayMetrics.density
  private val giveUp = Runnable { if (!ready && scene != null) toStills() }

  init {
    setBackgroundColor(IntroModel.BACKGROUND)
    if (flow.stills) showStills() else showScene()
    addView(hint, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  private fun showScene() {
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
    val count = IntroModel.particleCount(manager?.memoryClass ?: 128, manager?.isLowRamDevice ?: true)
    val weak = count <= 60_000
    val made = IntroGlView(context, count, glow = !weak, finest = if (weak) 720 else 1080)
    made.onReady = { l, r -> left = l; right = r; ready = true; removeCallbacks(giveUp); shape() }
    made.onFailed = { toStills() }
    scene = made
    addView(made, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    // No picture after three seconds (a window that cannot hold the texture): the still stages.
    postDelayed(giveUp, 3000)
  }

  private fun showStills() {
    val made = IntroStills(context)
    stills = made
    addView(made, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    hint.moving = false
    ready = true
  }

  private fun toStills() {
    removeCallbacks(giveUp)
    scene?.let { it.release(); removeView(it) }
    scene = null
    flow.toStills()
    if (stills == null) showStills()
  }

  /** The screen's shape decides where the camera passes the honeycomb layer. */
  private fun shape() {
    if (width > 0 && height > 0) flow.passAt = IntroModel.shieldPass(IntroModel.nDistance(right - left, width.toDouble() / height))
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    shape()
  }

  @Suppress("DEPRECATION")
  override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
    hint.inset = if (Build.VERSION.SDK_INT >= 30) insets.getInsets(WindowInsets.Type.systemBars()).bottom else insets.systemWindowInsetBottom
    return super.onApplyWindowInsets(insets)
  }

  // ---- The clock ----

  /** Runs on the screen's frames (again after `pause`). */
  fun play() {
    if (running || Build.FINGERPRINT == "robolectric") return // the JVM page tests have no frame clock: `step` there
    running = true; last = 0L
    Choreographer.getInstance().postFrameCallback(this)
  }

  /** The app left the screen: nothing moves, nothing is drawn; a finger that was down is as lifted. */
  fun pause() {
    if (!running) return
    running = false
    Choreographer.getInstance().removeFrameCallback(this)
    flow.touchCancel()
    tracker?.recycle(); tracker = null
  }

  /** The overlay is gone. */
  fun release() {
    pause()
    removeCallbacks(giveUp)
    onEvents = null
    scene?.release(); scene = null
  }

  override fun doFrame(frameTimeNanos: Long) {
    if (!running) return
    // A long hitch does not make the picture jump.
    val dt = if (last == 0L) 0.0 else min(0.1, (frameTimeNanos - last) / 1e9)
    last = frameTimeNanos
    step(dt)
    if (running) Choreographer.getInstance().postFrameCallback(this)
  }

  /** One frame: `dt` seconds have passed since the last. */
  fun step(dt: Double) {
    if (!ready) return
    val events = flow.tick(dt)
    scene?.frame(flow.t, flow.p, flow.clock, flow.speed, flow.t + flow.past)
    stills?.show(flow.p)
    hint.update(flow.hintVisible, dt)
    if (events != 0) onEvents?.invoke(events)
  }

  // ---- The touches ----

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean = true

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downY = event.y
        tracker?.recycle()
        tracker = VelocityTracker.obtain().also { it.addMovement(event) }
        flow.touchDown()
      }
      MotionEvent.ACTION_MOVE -> {
        tracker?.addMovement(event)
        flow.drag(up(event.y))
      }
      MotionEvent.ACTION_UP -> {
        val speed = tracker?.let { it.addMovement(event); it.computeCurrentVelocity(1000); it.yVelocity } ?: 0f
        tracker?.recycle(); tracker = null
        flow.drag(up(event.y))
        flow.touchUp(fling = speed < -flingSpeed && downY - event.y > 0)
      }
      MotionEvent.ACTION_CANCEL -> {
        tracker?.recycle(); tracker = null
        flow.touchCancel()
      }
    }
    return true
  }

  /** How far the finger is above where it came down, in steps: a little under half the screen is a whole step; the
   *  first few pixels (a tap's own wobble) do not count. */
  private fun up(y: Float): Double {
    val moved = downY - y
    val span = max(1f, height * 0.45f)
    return when {
      moved > slop -> ((moved - slop) / span).toDouble()
      moved < 0 -> (moved / span).toDouble()
      else -> 0.0
    }
  }
}

/** «Проведи вверх» with a finger mark that moves up, again and again. Drawn by the app over the scene, not part of it.
 *  With motion reduced the mark stands still (an arrow up). It comes and goes softly. */
internal class IntroHint(context: Context) : View(context) {
  /** The finger mark moves (false: the still arrow). */
  var moving = true
  /** The system bar at the bottom, px. */
  var inset = 0
    set(value) { if (field != value) { field = value; invalidate() } }

  private val density = resources.displayMetrics.density
  private val words = "Проведи вверх"
  private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    textAlign = Paint.Align.CENTER
    textSize = 15f * resources.displayMetrics.scaledDensity
    typeface = Fonts.weight(600)
  }
  private val mark = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 1.6f * density; strokeCap = Paint.Cap.ROUND }
  private var shown = 0.0
  private var phase = 0.0

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    contentDescription = words
  }

  /** Called every frame: whether the hint is wanted now, and the time since the last frame. */
  fun update(wanted: Boolean, dt: Double) {
    val before = shown
    shown = IntroModel.clamp(shown + (if (wanted) dt else -dt) / 0.35, 0.0, 1.0)
    if (shown <= 0.0) phase = 0.0
    else if (moving) { phase += dt / 1.8; if (phase >= 1.0) phase -= 1.0 }
    if (shown > 0.0 || before > 0.0) invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    if (shown <= 0.0) return
    val a = IntroModel.ease(shown)
    val cx = width / 2f
    val baseline = height - inset - 44f * density
    text.alpha = (0.84 * a * 255).toInt()
    canvas.drawText(words, cx, baseline, text)
    val from = baseline - 44f * density
    val travel = 52f * density
    if (!moving) {
      // A plain arrow up.
      line.alpha = (0.8 * a * 255).toInt()
      val top = from - 26f * density; val wing = 8f * density
      canvas.drawLine(cx, from, cx, top, line)
      canvas.drawLine(cx, top, cx - wing, top + wing, line)
      canvas.drawLine(cx, top, cx + wing, top + wing, line)
      return
    }
    val rise = IntroModel.ease(phase / 0.7)
    val light = sin(PI * min(1.0, phase / 0.9)) * a
    val y = from - travel * rise.toFloat()
    line.alpha = (0.22 * light * 255).toInt()
    canvas.drawLine(cx, y + 10f * density, cx, y + 10f * density + travel * rise.toFloat() * 0.55f, line)
    line.alpha = (0.5 * light * 255).toInt()
    canvas.drawCircle(cx, y, 13f * density, line)
    mark.alpha = (0.9 * light * 255).toInt()
    canvas.drawCircle(cx, y, 6f * density, mark)
  }
}

/** The intro without flights (motion reduced, or a phone that cannot draw the scene): four calm still stages that
 *  cross-fade one into the next with the steps — the word, N alone, the cipher, a soft dim blur. */
internal class IntroStills(context: Context) : View(context) {
  private class Row(val signs: CharArray, val y: Float, val size: Float, val light: Float)

  private val art: IntroArt? = try { IntroArt.make(context) } catch (_: Throwable) { null }
  private val word: Bitmap? = try { art?.bitmap() } catch (_: Throwable) { null }
  private val picture = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
  private val signs = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFBFD6FF.toInt(); typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) }
  private val haze = Paint(Paint.ANTI_ALIAS_FLAG)
  private val from = Rect()
  private val to = RectF()
  private var rows: List<Row> = emptyList()
  private var p = 0.0

  /** The progress through the steps, 0…4. */
  fun show(progress: Double) {
    if (abs(progress - p) < 1e-6) return
    p = progress
    invalidate()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w <= 0 || h <= 0) return
    haze.shader = RadialGradient(w / 2f, h * 0.46f, max(w, h) * 0.75f, intArrayOf(0xFF232B42.toInt(), 0xFF10141F.toInt(), IntroModel.BACKGROUND), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
    // The cipher: rows of signs in groups, most of them dim and small, a few large and bright.
    val random = IntroModel.Random(7)
    val scaled = resources.displayMetrics.scaledDensity
    val made = ArrayList<Row>()
    var y = 0f
    var index = 0
    while (y < h + 40f * scaled) {
      val large = index % 5 == 2
      val size = (if (large) 30f else if (index % 2 == 0) 13f else 18f) * scaled
      y += size * 1.7f
      val length = (w / (size * 0.6f)).toInt() + 2
      val chars = CharArray(length) { ' ' }
      var k = 0
      while (k < length) {
        val n = if (random.next() < 0.5) 2 else 4
        val on = random.next() < (if (large) 0.3 else 0.6)
        for (j in 0 until n) { if (k < length) chars[k] = if (on) IntroArt.SIGNS[(random.next() * 16).toInt().coerceIn(0, 15)] else ' '; k++ }
        k++
      }
      made.add(Row(chars, y, size, if (large) 0.85f else if (index % 2 == 0) 0.2f else 0.34f))
      index++
    }
    rows = made
  }

  override fun onDraw(canvas: Canvas) {
    canvas.drawColor(IntroModel.BACKGROUND)
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0 || h <= 0) return
    val first = IntroModel.clamp(1 - p, 0.0, 1.0)
    val second = IntroModel.clamp(1 - abs(p - 1), 0.0, 1.0)
    val third = IntroModel.clamp(1 - abs(p - 2), 0.0, 1.0)
    val fourth = IntroModel.clamp(p - 2, 0.0, 1.0)
    val made = art; val bitmap = word
    if (made != null && bitmap != null) {
      val top = (IntroArt.BASE - IntroArt.CAP).toInt(); val bottom = IntroArt.BASE.toInt()
      if (first > 0) {
        // The word across the screen less the margins.
        val span = made.wordEnd - IntroArt.LEFT
        val scale = min(w * (1 - 2 * IntroModel.MARGIN.toFloat()) / span, h * 0.3f / IntroArt.CAP)
        from.set(IntroArt.LEFT.toInt(), top, made.wordEnd.toInt() + 1, bottom)
        val x = (w - span * scale) / 2; val y = h * 0.46f - IntroArt.CAP * scale / 2
        to.set(x, y, x + span * scale, y + IntroArt.CAP * scale)
        stand(canvas, bitmap, first)
      }
      if (second > 0) {
        // N alone at the centre.
        val sign = made.spans[1]
        val scale = min(h * 0.25f / IntroArt.CAP, w * 0.58f / sign[1])
        from.set(sign[0].toInt(), top, (sign[0] + sign[1]).toInt() + 1, bottom)
        val x = (w - sign[1] * scale) / 2; val y = h * 0.46f - IntroArt.CAP * scale / 2
        to.set(x, y, x + sign[1] * scale, y + IntroArt.CAP * scale)
        stand(canvas, bitmap, second)
      }
    }
    if (third > 0) {
      for (row in rows) {
        signs.textSize = row.size
        signs.alpha = (row.light * third * 255).toInt()
        canvas.drawText(row.signs, 0, row.signs.size, 0f, row.y, signs)
      }
    }
    if (fourth > 0) {
      haze.alpha = (fourth * 255).toInt()
      canvas.drawRect(0f, 0f, w, h, haze)
    }
  }

  /** The picture's part `from` at `to`, with a faint mirror image under it. */
  private fun stand(canvas: Canvas, bitmap: Bitmap, light: Double) {
    picture.alpha = (0.92 * light * 255).toInt()
    canvas.drawBitmap(bitmap, from, to, picture)
    picture.alpha = (0.1 * light * 255).toInt()
    canvas.save()
    canvas.scale(1f, -1f, 0f, to.bottom)
    canvas.drawBitmap(bitmap, from, to, picture)
    canvas.restore()
  }
}
