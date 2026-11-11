package expo.modules.lineatrail

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.SystemClock
import android.view.ActionMode
import android.view.Choreographer
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MotionEvent
import android.view.Window
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The one light of the app (main thread only): the model in window coordinates (dp), the views that draw it and
 *  the frame loop. The loop (Choreographer) runs only while the light is alive and some mounted view is shown. */
internal object TrailHub {
  val model = TrailModel()
  /** Default tile colour (opaque ARGB): the theme's. */
  var color = Color.WHITE
    set(value) { field = value or (0xFF shl 24); for (view in views) view.invalidate() }
  var enabled = false
    set(value) { if (field == value) return; field = value; if (!value) quit() }
  var density = 1f
    private set

  private val views = ArrayList<TrailBackgroundView>()
  private var running = false
  private var lead = -1 // pointer id of the one finger that leads the light
  private val callback = Choreographer.FrameCallback { tick() }

  fun add(view: TrailBackgroundView) {
    if (!views.contains(view)) views.add(view)
    density = view.resources.displayMetrics.density
  }

  fun remove(view: TrailBackgroundView) { views.remove(view); if (views.isEmpty()) quit() }

  private fun quit() {
    lead = -1
    model.clear()
    if (running) { running = false; Choreographer.getInstance().removeFrameCallback(callback) }
    for (view in views) view.invalidate()
  }

  private fun frame() {
    if (running || !enabled || views.isEmpty()) return
    running = true
    Choreographer.getInstance().postFrameCallback(callback)
  }

  /** Called from the window callback BEFORE the app sees the event; never consumes it. Window coordinates. */
  fun observe(event: MotionEvent) {
    if (!enabled || views.isEmpty()) return
    val now = SystemClock.uptimeMillis().toDouble()
    when (event.actionMasked) {
      // One finger only: the first finger down leads the light; other fingers are ignored while it is on the screen.
      MotionEvent.ACTION_DOWN -> {
        // System «Remove animations» (animator duration scale 0) = no trail.
        if (!ValueAnimator.areAnimatorsEnabled()) return
        lead = event.getPointerId(0)
        model.down((event.getX(0) / density).toDouble(), (event.getY(0) / density).toDouble(), now)
      }
      MotionEvent.ACTION_MOVE -> {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        val index = if (lead >= 0) event.findPointerIndex(lead) else -1
        if (index < 0) return
        model.point((event.getX(index) / density).toDouble(), (event.getY(index) / density).toDouble())
      }
      MotionEvent.ACTION_POINTER_UP -> {
        if (lead < 0 || event.getPointerId(event.actionIndex) != lead) return
        lead = -1; model.release(now)
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { if (lead < 0) return; lead = -1; model.release(now) }
      else -> return
    }
    frame()
  }

  private fun tick() {
    running = false
    val now = SystemClock.uptimeMillis().toDouble()
    val alive = model.step(now)
    model.compute(now)
    var visible = false
    for (view in views) {
      if (!view.active || !view.isShown) continue
      view.invalidate()
      visible = true
    }
    // Idle = no loop once the light has faded out, or when no view is there to show it.
    if (alive && visible) frame() else if (!visible) model.clear()
  }
}

/** The background view the app mounts (src/PixelTrail.tsx, PixelTrailLayer) inside its background layers. It never
 *  takes touches, focus or accessibility, and draws the part of the hub's light that falls on it: the mesh is fixed
 *  to the window, so drawing is offset by the view's own position in the window. One Paint, drawRect per tile, the
 *  bloom is a cached shader — no allocation per frame. */
@SuppressLint("ViewConstructor")
class TrailBackgroundView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  /** This view's own tile colour (opaque ARGB); null = the hub's (theme) colour. */
  var tint: Int? = null
    set(value) { field = value?.let { it or (0xFF shl 24) }; invalidate() }
  /** false: a screen kept mounted under another one — nothing is drawn. */
  var active = true
    set(value) { if (field != value) { field = value; invalidate() } }

  private val paint = Paint().apply { style = Paint.Style.FILL; isAntiAlias = false; color = Color.WHITE }
  private val bloomPaint = Paint().apply { style = Paint.Style.FILL; isAntiAlias = true }
  private var shader: RadialGradient? = null
  private var shaderColor = 0
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

  override fun onAttachedToWindow() { super.onAttachedToWindow(); TrailHub.add(this) }
  override fun onDetachedFromWindow() { TrailHub.remove(this); super.onDetachedFromWindow() }

  private fun bloomShader(rgb: Int, radius: Float): RadialGradient {
    val made = shader
    if (made != null && shaderColor == rgb) return made
    // Centred at 0,0 and drawn translated: one shader per colour, no allocation per frame.
    return RadialGradient(0f, 0f, radius, rgb, rgb and 0x00FFFFFF, Shader.TileMode.CLAMP).also { shader = it; shaderColor = rgb }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val model = TrailHub.model
    if (!active || (model.lit <= 0 && model.bloomAlpha <= 0)) return
    val density = TrailHub.density
    val rgb = tint ?: TrailHub.color
    getLocationInWindow(place)
    val ox = place[0]; val oy = place[1]
    // 1) The soft bloom under the mesh, at the newest sample.
    if (model.bloomAlpha > 0) {
      val reach = (TrailRules.RADIUS * TrailRules.BLOOM_SCALE).toFloat() * density
      bloomPaint.shader = bloomShader(rgb, reach)
      bloomPaint.alpha = (model.bloomAlpha * 255).roundToInt().coerceIn(0, 255)
      canvas.save()
      canvas.translate((model.bloomX * density).toFloat() - ox, (model.bloomY * density).toFloat() - oy)
      canvas.drawCircle(0f, 0f, reach, bloomPaint)
      canvas.restore()
    }
    // 2) The tiles of the window grid that fall on this view.
    if (model.lit <= 0) return
    val pitch = TrailRules.PITCH * density
    val inset = (TrailRules.PITCH - TrailRules.DOT) / 2 * density
    val side = TrailRules.DOT * density
    val alpha = model.alpha; val cols = model.cols
    val rFrom = max(0, floor(oy / pitch).toInt() - model.r0); val rTo = min(model.rows - 1, ceil((oy + height) / pitch).toInt() - model.r0)
    val cFrom = max(0, floor(ox / pitch).toInt() - model.c0); val cTo = min(cols - 1, ceil((ox + width) / pitch).toInt() - model.c0)
    for (r in rFrom..rTo) {
      val top = (((model.r0 + r) * pitch + inset).roundToInt() - oy).toFloat()
      val bottom = (((model.r0 + r) * pitch + inset + side).roundToInt() - oy).toFloat()
      for (c in cFrom..cTo) {
        val a = alpha[r * cols + c]
        if (a <= 0f) continue
        val left = (((model.c0 + c) * pitch + inset).roundToInt() - ox).toFloat()
        val right = (((model.c0 + c) * pitch + inset + side).roundToInt() - ox).toFloat()
        paint.color = (rgb and 0x00FFFFFF) or ((a * 255).roundToInt().coerceIn(0, 255) shl 24)
        canvas.drawRect(left, top, right, bottom, paint)
      }
    }
  }
}

/** Wraps the Activity's Window.Callback: every touch is shown to the hub first, then handed on unchanged.
 *  The result is always the wrapped callback's own; nothing here can consume or alter an event. */
class TrailCallback(val inner: Window.Callback) : Window.Callback by inner {
  override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
    if (event != null) {
      try { TrailHub.observe(event) } catch (_: Throwable) { /* decorative: never in the way */ }
    }
    return inner.dispatchTouchEvent(event)
  }

  // Default interface methods are spelled out so the Activity's own overrides keep working.
  override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>?, menu: Menu?, deviceId: Int) = inner.onProvideKeyboardShortcuts(data, menu, deviceId)
  override fun onPointerCaptureChanged(hasCapture: Boolean) = inner.onPointerCaptureChanged(hasCapture)
  override fun dispatchKeyEvent(event: KeyEvent?) = inner.dispatchKeyEvent(event)
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? = inner.onWindowStartingActionMode(callback, type)
}
