package expo.modules.lineasnow

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.ActionMode
import android.view.Choreographer
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.Window
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

/** The pre-rendered rime of one glass ledge (kept in Ledge.tag) and the shape it was rendered for. */
internal class Rime {
  var bitmap: Bitmap? = null
  /** A render was made for (w, h, r, dark); the bitmap may still be null (a ledge too large to frost). */
  var rendered = false
  var w = 0f; var h = 0f; var r = 0f; var dark = false
  // The shape last seen: a ledge that is still resizing is not re-rendered every frame.
  var seenW = -1f; var seenH = -1f; var seenR = -1f; var seenDark = false
  var since = 0.0

  private fun near(a: Float, b: Float) = a - b < .5f && b - a < .5f
  fun fits(s: Ledge, isDark: Boolean) = rendered && dark == isDark && near(w, s.width) && near(h, s.height) && near(r, s.radius)
  fun settling(s: Ledge, isDark: Boolean) = seenDark == isDark && near(seenW, s.width) && near(seenH, s.height) && near(seenR, s.radius)
  fun see(s: Ledge, isDark: Boolean, now: Double) { seenW = s.width; seenH = s.height; seenR = s.radius; seenDark = isDark; since = now }
}

/** Device heat (API 29+). Kept in its own class so that older devices never load the listener type. */
@TargetApi(29)
private class ThermalWatch(private val power: PowerManager, sink: (Int) -> Unit) {
  private val listener = PowerManager.OnThermalStatusChangedListener { status -> sink(status) }
  fun start(): Int { power.addThermalStatusListener(listener); return power.currentThermalStatus }
  fun stop() { power.removeThermalStatusListener(listener) }
}

/** The snow of the app (main thread only): the model in window dp, the mounted views, the pre-rendered art, the
 *  frame loop and the thermal listener. The loop (Choreographer) runs only while the snow is enabled, the app is in
 *  the foreground, a mounted view is active and shown, and something is left to animate. */
internal object SnowHub {
  val model = SnowModel()
  var enabled = false
    private set
  var foreground = true
    set(value) { if (field == value) return; field = value; if (value) frame() else park() }
  var dark = true
    set(value) { if (field == value) return; field = value; frame() } // the rime is re-rendered in the next tick
  var density = 1f
    private set
  /** Time of the last frame, ms: the phase of the sparkles. */
  var now = 0.0
    private set
  /** System «Remove animations» (animator duration scale 0) = no snow, as with the pixel trail. */
  var still = false
    private set
  /** Aggregate flake sprites and the grain of the caps; built in tick(), never in onDraw. */
  var sprites: Array<Bitmap>? = null
    private set
  var grain: BitmapShader? = null
    private set
  /** Top display cutout in window dp (x, y, width, height), refreshed on the main thread, read from JS. */
  @Volatile var cutout: FloatArray? = null
    private set
  @Volatile var cutoutKnown = false
    private set

  private val views = ArrayList<SnowView>()
  private val main = Handler(Looper.getMainLooper())
  private var running = false
  private var lastNanos = 0L
  private var lead = -1 // pointer id of the first finger; the others are ignored
  private var override = -1f
  private var device = 0f
  private var thermal: ThermalWatch? = null
  private var artDensity = 0f
  private val random = Random.Default
  private val callback = Choreographer.FrameCallback { nanos ->
    try { tick(nanos) } catch (_: Throwable) { running = false /* decorative: a failed frame draws nothing */ }
  }

  fun add(view: SnowView) {
    if (!views.contains(view)) views.add(view)
    density = view.resources.displayMetrics.density
    readCutout(view.rootView)
    frame()
  }

  fun remove(view: SnowView) { views.remove(view); if (views.isEmpty()) park() }

  fun start(context: Context?) { enabled = true; listen(context); frame() }

  /** Off: no loop, no listener, nothing remembered. */
  fun stop() {
    enabled = false
    park(); unlisten()
    lead = -1
    model.clear()
    redraw()
  }

  fun setLedges(specs: List<LedgeSpec>) { model.setLedges(specs); frame() }

  /** Test override of the heat; negative = the device's real thermal state. */
  fun setHeat(value: Float) { override = if (value.isNaN() || value < 0) -1f else min(1f, value); frame() }

  private fun listen(context: Context?) {
    if (thermal != null || context == null || Build.VERSION.SDK_INT < 29) return
    try {
      val power = context.applicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
      val watch = ThermalWatch(power) { status -> main.post { device = SnowRules.thermal(status); frame() } }
      device = SnowRules.thermal(watch.start())
      thermal = watch
    } catch (_: Throwable) { device = 0f }
  }

  private fun unlisten() {
    try { thermal?.stop() } catch (_: Throwable) { /* decorative */ }
    thermal = null; device = 0f
  }

  /** The top cutout of the window `decor` belongs to (API 28+). Only getters: safe to call for a first read off the main thread. */
  fun readCutout(decor: View?) {
    cutout = try { topCutout(decor) } catch (_: Throwable) { null }
    if (decor != null) cutoutKnown = true
  }

  private fun topCutout(decor: View?): FloatArray? {
    if (decor == null || Build.VERSION.SDK_INT < 28) return null
    val shape = decor.rootWindowInsets?.displayCutout ?: return null
    var rect: Rect? = null
    if (Build.VERSION.SDK_INT >= 29) rect = shape.boundingRectTop
    else if (shape.safeInsetTop > 0) for (r in shape.boundingRects) if (r.top <= 0 && (rect == null || r.width() > rect.width())) rect = r
    if (rect == null || rect.isEmpty) return null
    val scale = decor.resources.displayMetrics.density
    if (scale <= 0f) return null
    return floatArrayOf(rect.left / scale, rect.top / scale, rect.width() / scale, rect.height() / scale)
  }

  private fun shown(): SnowView? {
    for (k in views.indices) { val view = views[k]; if (view.active && view.isShown) return view }
    return null
  }

  private fun redraw() { for (k in views.indices) views[k].invalidate() }

  private fun park() {
    if (running) { running = false; Choreographer.getInstance().removeFrameCallback(callback) }
    lastNanos = 0
  }

  /** Asks for a frame; the tick decides whether the loop goes on. Safe to call at any time. */
  fun frame() {
    if (running || !enabled || !foreground) return
    val frozen = !ValueAnimator.areAnimatorsEnabled()
    if (frozen != still) { still = frozen; redraw() }
    if (frozen || shown() == null) return
    running = true
    Choreographer.getInstance().postFrameCallback(callback)
  }

  /** Called from the window callback BEFORE the app sees the event; never consumes it. Window coordinates. */
  fun observe(event: MotionEvent) {
    if (!enabled || still || views.isEmpty()) return
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        lead = event.getPointerId(0)
        model.down(event.getX(0) / density, event.getY(0) / density)
      }
      MotionEvent.ACTION_MOVE -> {
        val index = if (lead >= 0) event.findPointerIndex(lead) else -1
        if (index >= 0) model.move(event.getX(index) / density, event.getY(index) / density)
      }
      MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_UP -> {
        val index = event.actionIndex
        if (lead < 0 || event.getPointerId(index) != lead) return
        lead = -1
        model.up(event.getX(index) / density, event.getY(index) / density)
      }
      MotionEvent.ACTION_CANCEL -> { lead = -1; model.cancel() }
    }
  }

  private fun tick(nanos: Long) {
    running = false
    still = !ValueAnimator.areAnimatorsEnabled()
    val view = shown()
    if (!enabled || !foreground || still || view == null) { lastNanos = 0; redraw(); return }
    density = view.resources.displayMetrics.density
    val root = view.rootView
    model.resize(root.width / density, root.height / density)
    if (model.width <= 0f || model.height <= 0f) { frame(); return } // not laid out yet
    now = nanos / 1e6
    val dt = if (lastNanos == 0L) 0f else ((nanos - lastNanos) / 1e9).toFloat()
    lastNanos = nanos
    model.heatTarget = if (override >= 0) override else device
    val awake = model.step(now, dt)
    art()
    rime()
    redraw()
    // Hot, melted and fallen: sleep until the heat drops (saves the battery exactly when the phone is hot).
    if (awake) frame() else lastNanos = 0
  }

  // ---- pre-rendered art ----

  private fun art() {
    if (sprites != null && grain != null && artDensity == density) return
    artDensity = density
    val scale = min(3f, max(1f, density))
    val side = kotlin.math.ceil(SnowView.SPRITE * scale).toInt()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; setShadowLayer(.6f, 0f, 0f, 0xE6FFFFFF.toInt()) }
    // Aggregates: a few crystals stuck together, each sprite of its own shape. No six-armed stars.
    sprites = Array(SnowRules.SPRITES) {
      val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap)
      canvas.translate(side / 2f, side / 2f)
      for (m in 0 until 3 + random.nextInt(5)) {
        val a = random.nextFloat() * 6.283f; val r = random.nextFloat() * 2.2f * scale
        paint.alpha = ((.55f + random.nextFloat() * .45f) * 255).roundToInt()
        val rx = (.5f + random.nextFloat() * 1.1f) * scale; val ry = (.4f + random.nextFloat() * .7f) * scale
        canvas.save()
        canvas.translate(cos(a) * r, sin(a) * r)
        canvas.rotate(random.nextFloat() * 172f)
        canvas.drawOval(-rx, -ry, rx, ry, paint)
        canvas.restore()
      }
      bitmap
    }
    // The grain of a cap's surface: bright specks and small cold shadows between them. One texel = 1 dp.
    val tile = Bitmap.createBitmap(SnowView.TILE, SnowView.TILE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(tile)
    val speck = Paint(Paint.ANTI_ALIAS_FLAG)
    for (k in 0 until 1500) {
      if (random.nextFloat() < .5f) speck.setARGB(((.10f + random.nextFloat() * .22f) * 255).roundToInt(), 120, 145, 190)
      else speck.setARGB(((.3f + random.nextFloat() * .5f) * 255).roundToInt(), 255, 255, 255)
      val x = random.nextFloat() * SnowView.TILE; val y = random.nextFloat() * SnowView.TILE
      canvas.drawRect(x, y, x + 1, y + 1, speck)
    }
    grain = BitmapShader(tile, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)
  }

  /** Keeps the rime bitmaps of the glass ledges up to date: at most one render per frame, and only once a ledge
   *  has kept its shape for a moment (a resizing ledge shows its previous rime stretched). */
  private fun rime() {
    var budget = 1
    val ledges = model.ledges
    for (k in ledges.indices) {
      val s = ledges[k]
      if (!s.glass) { s.tag = null; continue }
      val rime = s.tag as? Rime ?: Rime().also { s.tag = it }
      if (rime.fits(s, dark)) continue
      // First sight: render at once. Later changes: wait until the shape has been the same for 120 ms.
      if (!rime.settling(s, dark)) { rime.see(s, dark, now); if (rime.rendered) continue }
      if (budget <= 0 || (rime.rendered && now - rime.since < 120)) continue
      budget--
      rime.bitmap = try { frost(s, dark) } catch (_: Throwable) { null }
      rime.rendered = true
      rime.w = s.width; rime.h = s.height; rime.r = s.radius; rime.dark = dark
    }
  }

  /** The demo's `frost()`: the haze, then sub-pixel specks near the rim, then thin ice feathers growing inward. */
  private fun frost(s: Ledge, dark: Boolean): Bitmap? {
    val scale = min(2f, max(1f, density))
    val pw = (s.width * scale).roundToInt(); val ph = (s.height * scale).roundToInt()
    if (pw < 1 || ph < 1 || pw > 4096 || ph > 2048 || pw.toLong() * ph > 1_500_000L) return null
    val field = FrostField(s.width, s.height, s.radius, s.frostSeed, !dark)
    val pixels = IntArray(pw * ph)
    field.fill(pixels, pw, ph, scale)
    val bitmap = Bitmap.createBitmap(pw, ph, Bitmap.Config.ARGB_8888)
    bitmap.setPixels(pixels, 0, pw, 0, 0, pw, ph)
    val canvas = Canvas(bitmap)
    canvas.scale(scale, scale)
    val w = field.w; val h = field.h; val light = field.light
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    var k = 0
    val specks = w * h / 14
    while (k < specks) {
      k++
      val px = field.rand() * w; val py = field.rand() * h
      val power = field.power(px, py)
      if (field.rand() > power * power) continue
      val alpha = ((.10f + field.rand() * .22f) * 255).roundToInt()
      if (light) paint.setARGB(alpha, 110, 150, 215) else paint.setARGB(alpha, 255, 255, 255)
      canvas.drawRect(px, py, px + .5f, py + .5f, paint)
    }
    paint.style = Paint.Style.STROKE
    paint.strokeCap = Paint.Cap.ROUND
    val r = field.r
    val rim = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * PI.toFloat() * r
    for (f in 0 until max(1, (rim / 90).toInt())) {
      // A point on the rim and the direction inward.
      var px: Float; var py: Float; var tries = 0
      do {
        px = field.rand() * w
        py = if (field.rand() < .5f) (if (field.rand() < .5f) 1f else h - 1) else field.rand() * h
        if (py > 1 && py < h - 1) px = if (field.rand() < .5f) 1f else w - 1
      } while (field.inside(px, py) < 0 && ++tries < 8)
      if (field.inside(px, py) < 0) continue
      val e = 1.5f
      val gx = field.inside(px + e, py) - field.inside(px - e, py); val gy = field.inside(px, py + e) - field.inside(px, py - e)
      feather(canvas, paint, field, px, py, atan2(gy, gx) + (field.rand() - .5f) * 1.1f, field.reach * (1 + field.rand() * 1.4f), 0)
    }
    return bitmap
  }

  /** One ice feather: grows from the rim, bends a little, branches unevenly (two levels at most). */
  private fun feather(canvas: Canvas, paint: Paint, field: FrostField, px: Float, py: Float, angle: Float, length: Float, depth: Int) {
    var cx = px; var cy = py; var a = angle
    val steps = max(3, (length / 2.2f).toInt())
    val stride = length / steps
    for (t in 0 until steps) {
      a += (field.rand() - .5f) * .22f
      val nx = cx + cos(a) * stride; val ny = cy + sin(a) * stride
      if (field.inside(nx, ny) < .5f) break
      val part = t.toFloat() / steps
      val alpha = ((.22f * (1 - part) + .03f) * 255).roundToInt()
      if (field.light) paint.setARGB(alpha, 120, 160, 225) else paint.setARGB(alpha, 245, 250, 255)
      paint.strokeWidth = (if (depth > 0) .3f else .45f) * (1 - part * .5f)
      canvas.drawLine(cx, cy, nx, ny, paint)
      if (depth < 2 && t > 0 && field.rand() < .62f) {
        val turn = (if (field.rand() < .5f) -1 else 1) * (.75f + field.rand() * .5f)
        feather(canvas, paint, field, nx, ny, a + turn, length * (1 - part) * (.35f + field.rand() * .3f), depth + 1)
      }
      cx = nx; cy = ny
    }
  }
}

/** The one transparent surface the app mounts above everything (src/SnowPhone.tsx). It never takes touches, focus
 *  or accessibility and draws the hub's model: rime, caps, falling flakes, knocked-off snow, meltwater. The model
 *  is in window dp, so drawing is offset by the view's own position in the window. Paints, the path and the
 *  rectangles are reused — no allocation per frame. */
@SuppressLint("ViewConstructor")
class SnowView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  /** false: the view stops drawing and (when no other view is shown) the frame loop sleeps. */
  var active = true
    set(value) { if (field != value) { field = value; invalidate(); if (value) SnowHub.frame() } }

  private val capPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.FILL
    // White at the cap's top, cold 9 dp lower; drawn translated to the top, so one shader serves every cap.
    shader = LinearGradient(0f, 0f, 0f, 9f, 0xF5FFFFFF.toInt(), 0xEBD6E0F0.toInt(), Shader.TileMode.CLAMP)
    // Soft shadow under the cap (shape shadows need API 28+ on a hardware canvas; older: no shadow).
    setShadowLayer(1.8f, 0f, 1f, 0x59283C6E)
  }
  private val grainPaint = Paint().apply { style = Paint.Style.FILL; isFilterBitmap = false; alpha = 128 }
  private val flakePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = Color.WHITE }
  private val spritePaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val rimePaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val snowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = Color.WHITE }
  private val underPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = 0xFFC9D4E6.toInt() }
  private val dropPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = 0x8CCDE4FF.toInt() }
  private val glintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = 0xE6FFFFFF.toInt() }
  private val path = Path()
  private val rect = RectF()
  private val spriteRect = RectF(-SPRITE / 2, -SPRITE / 2, SPRITE / 2, SPRITE / 2)
  private val place = IntArray(2)

  init {
    isClickable = false
    isFocusable = false
    isLongClickable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    setWillNotDraw(false)
  }

  // Never part of touch dispatch: a touch falls through to the app.
  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent?) = false
  override fun dispatchTouchEvent(event: MotionEvent?) = false

  override fun onAttachedToWindow() { super.onAttachedToWindow(); try { SnowHub.add(this) } catch (_: Throwable) { /* decorative */ } }
  override fun onDetachedFromWindow() { try { SnowHub.remove(this) } catch (_: Throwable) { /* decorative */ }; super.onDetachedFromWindow() }

  // Shown again (screen, window): wake the loop; hidden: the next tick finds no shown view and stops.
  override fun onVisibilityChanged(changedView: View, visibility: Int) {
    super.onVisibilityChanged(changedView, visibility)
    if (visibility == VISIBLE) try { SnowHub.frame() } catch (_: Throwable) { /* decorative */ }
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    if (visibility == VISIBLE) try { SnowHub.frame() } catch (_: Throwable) { /* decorative */ }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    try { SnowHub.readCutout(rootView); SnowHub.frame() } catch (_: Throwable) { /* decorative */ }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val saved = canvas.save()
    try { paint(canvas) } catch (_: Throwable) { /* decorative: draw nothing */ } finally { canvas.restoreToCount(saved) }
  }

  private fun paint(canvas: Canvas) {
    val hub = SnowHub
    val model = hub.model
    if (!active || !hub.enabled || hub.still || model.width <= 0f) return
    getLocationInWindow(place)
    canvas.translate(-place[0].toFloat(), -place[1].toFloat())
    canvas.scale(hub.density, hub.density) // from here on: window dp
    rime(canvas, model)
    caps(canvas, model, hub.now, hub.grain)
    if (!model.asleep) flakes(canvas, model, hub.sprites)
    particles(canvas, model)
  }

  /** 1) Rime on the glass ledges; the heat takes it off first. */
  private fun rime(canvas: Canvas, model: SnowModel) {
    val alpha = ((1 - model.heat * 1.4f).coerceIn(0f, 1f) * 255).roundToInt()
    if (alpha <= 0) return
    rimePaint.alpha = alpha
    val ledges = model.ledges
    for (k in ledges.indices) {
      val s = ledges[k]
      val bitmap = (s.tag as? Rime)?.bitmap ?: continue
      rect.set(s.x, s.y, s.x + s.width, s.y + s.height)
      canvas.drawBitmap(bitmap, null, rect, rimePaint)
    }
  }

  /** 2) The caps: a smoothed top, back along the ledge's outline; gradient + shadow, grain, sparkles. */
  private fun caps(canvas: Canvas, model: SnowModel, now: Double, grain: BitmapShader?) {
    val col = SnowRules.COL
    val ledges = model.ledges
    val hop = floor(now / 2600).toLong()
    for (k in ledges.indices) {
      val s = ledges[k]
      val n = s.n
      if (n < 1) continue
      val h = s.h
      var top = Float.MAX_VALUE
      for (i in 0 until n) top = min(top, s.base(i) - h[i])
      path.rewind()
      for (i in 0 until n) {
        val a = if (i > 0) h[i - 1] else 0f; val c = if (i < n - 1) h[i + 1] else 0f
        val y = s.base(i) - (a + 2 * h[i] + c) / 4 - top
        if (i == 0) path.moveTo(.5f * col, y) else path.lineTo((i + .5f) * col, y)
      }
      for (i in n - 1 downTo 0) path.lineTo((i + .5f) * col, s.base(i) + .5f - top)
      path.close()
      canvas.save()
      canvas.translate(s.x, top)
      canvas.drawPath(path, capPaint)
      canvas.restore()
      if (grain != null) {
        // The grain is fixed to the window (not to the cap's top), so it does not shimmer as the cap grows.
        path.offset(s.x, top)
        if (grainPaint.shader !== grain) grainPaint.shader = grain
        canvas.drawPath(path, grainPaint)
      }
      // Sparkles: single crystal faces catch the light for a moment; the places hop every 2.6 s.
      val count = max(1f, n / 22f)
      var q = 0
      while (q < count) {
        val i = ((q * 37 + 11 + hop * 13 + q * 7) % n).toInt()
        val hh = h[i]
        if (hh >= 2) {
          val twinkle = max(0.0, sin(now / 330 + q * 2.1 + s.x)).pow(10).toFloat()
          if (twinkle >= .05f) {
            val x = s.x + (i + .5f) * col; val y = s.base(i) - hh * .6f
            flakePaint.alpha = (twinkle * 255).roundToInt().coerceIn(0, 255)
            canvas.drawRect(x - 1.6f, y - .3f, x + 1.6f, y + .3f, flakePaint)
            canvas.drawRect(x - .3f, y - 1.6f, x + .3f, y + 1.6f, flakePaint)
          }
        }
        q++
      }
    }
  }

  /** 3) Falling snow: far flakes are pale dots, nearer ones slowly turning fluffy aggregates. */
  private fun flakes(canvas: Canvas, model: SnowModel, sprites: Array<Bitmap>?) {
    for (k in 0 until model.falling) {
      val z = model.flakeZ[k]
      val alpha = (model.flakeA[k] * 255).roundToInt().coerceIn(0, 255)
      if (z < SnowRules.FAR || sprites == null) {
        flakePaint.alpha = alpha
        canvas.drawCircle(model.flakeX[k], model.flakeY[k], model.flakeR[k], flakePaint)
      } else {
        val scale = .45f + z * .75f
        spritePaint.alpha = alpha
        canvas.save()
        canvas.translate(model.flakeX[k], model.flakeY[k])
        canvas.rotate(model.flakeRot[k] * DEGREES)
        canvas.scale(scale, scale)
        canvas.drawBitmap(sprites[model.flakeSprite[k] % sprites.size], null, spriteRect, spritePaint)
        canvas.restore()
      }
    }
  }

  /** 4) Knocked-off snow (clumps, grains) and meltwater drops. Opaque: they fall off the window, never fade. */
  private fun particles(canvas: Canvas, model: SnowModel) {
    val stride = SnowRules.BLOBS * 3
    for (k in 0 until model.particles) {
      val x = model.partX[k]; val y = model.partY[k]; val r = model.partR[k]
      when (model.kind[k]) {
        SnowRules.DROP -> {
          // Stretched by its speed once it has left the glass.
          val stretch = if (y < model.partEnd[k]) 1f else min(2.4f, 1 + model.partVy[k] / 260)
          val ry = r * 1.35f * stretch
          canvas.drawOval(x - r, y - ry, x + r, y + ry, dropPaint)
          canvas.drawRect(x - r * .35f, y - r * .6f, x + r * .1f, y - r * .15f, glintPaint)
        }
        SnowRules.CLUMP -> {
          // A clump: the cold underside first, then the white body — a loose volume.
          val c = cos(model.partRot[k]); val s = sin(model.partRot[k])
          val at = k * stride
          val blobs = model.blobs
          val count = model.blobCount[k]
          for (b in 0 until count) {
            val ax = blobs[at + b * 3]; val ay = blobs[at + b * 3 + 1]
            canvas.drawCircle(x + ax * c - ay * s, y + ax * s + ay * c + .7f, blobs[at + b * 3 + 2], underPaint)
          }
          for (b in 0 until count) {
            val ax = blobs[at + b * 3]; val ay = blobs[at + b * 3 + 1]
            canvas.drawCircle(x + ax * c - ay * s, y + ax * s + ay * c - .3f, blobs[at + b * 3 + 2] * .9f, snowPaint)
          }
        }
        else -> canvas.drawCircle(x, y, r, snowPaint)
      }
    }
  }

  companion object {
    const val SPRITE = 12f  // side of a flake sprite, dp
    const val TILE = 96     // side of the grain tile, texels (= dp)
    private const val DEGREES = 57.29578f
  }
}

/** Wraps the Activity's Window.Callback: every touch is shown to the hub first, then handed on unchanged.
 *  The result is always the wrapped callback's own; nothing here can consume or alter an event. */
class SnowCallback(val inner: Window.Callback) : Window.Callback by inner {
  override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
    if (event != null) {
      try { SnowHub.observe(event) } catch (_: Throwable) { /* decorative: never in the way */ }
    }
    return inner.dispatchTouchEvent(event)
  }

  // Default interface methods are spelled out so the Activity's own overrides keep working.
  override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>?, menu: Menu?, deviceId: Int) = inner.onProvideKeyboardShortcuts(data, menu, deviceId)
  override fun onPointerCaptureChanged(hasCapture: Boolean) = inner.onPointerCaptureChanged(hasCapture)
  override fun dispatchKeyEvent(event: KeyEvent?) = inner.dispatchKeyEvent(event)
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? = inner.onWindowStartingActionMode(callback, type)
}
