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
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.Window
import kotlin.math.roundToInt

/** The drawing surface: a plain View on top of the decor view that never takes touches, focus or accessibility.
 *  It draws a soft bloom and the lit tiles of a fixed mesh and redraws (postInvalidateOnAnimation, i.e. on the
 *  Choreographer frame) only while the light is alive. With hardware acceleration Android
 *  redraws the whole (cheap, separate) display list of this view anyway, so no dirty rect is tracked. */
@SuppressLint("ViewConstructor")
class TrailOverlay(context: Context) : View(context) {
  private val model = TrailModel()
  private val paint = Paint().apply { style = Paint.Style.FILL; isAntiAlias = false; color = Color.WHITE }
  private var rgb = Color.WHITE
  private val density = context.resources.displayMetrics.density
  private var running = false
  private val bloomPaint = Paint().apply { style = Paint.Style.FILL; isAntiAlias = true }
  private var shader: RadialGradient? = null
  private var shaderColor = 0

  init {
    isClickable = false
    isFocusable = false
    isLongClickable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    setWillNotDraw(false)
  }

  fun setColor(color: Int) { rgb = color or (0xFF shl 24); invalidate() }

  // Never part of touch dispatch: a touch falls through to the app underneath.
  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent?) = false
  override fun dispatchTouchEvent(event: MotionEvent?) = false

  private fun frame() { if (!running) { running = true; postInvalidateOnAnimation() } }

  /** Called from the window callback BEFORE the app sees the event; never consumes it. */
  fun observe(event: MotionEvent) {
    val now = SystemClock.uptimeMillis().toDouble()
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
        // System «Remove animations» (animator duration scale 0) = no trail.
        if (!ValueAnimator.areAnimatorsEnabled()) return
        val index = event.actionIndex
        model.down((event.getX(index) / density).toDouble(), (event.getY(index) / density).toDouble(), now)
      }
      MotionEvent.ACTION_MOVE -> {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        // The light glides after the finger that moved last (sampled once per frame in onDraw).
        val index = event.pointerCount - 1
        model.point((event.getX(index) / density).toDouble(), (event.getY(index) / density).toDouble())
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> model.release(now)
      else -> return
    }
    frame()
  }

  fun stop() { model.clear(); running = false; invalidate() }

  private fun bloomShader(): RadialGradient {
    val radius = (TrailRules.RADIUS * TrailRules.BLOOM_SCALE).toFloat() * density
    val made = shader
    if (made != null && shaderColor == rgb) return made
    // Centred at 0,0 and drawn translated: one shader per colour, no allocation per frame.
    return RadialGradient(0f, 0f, radius, rgb, rgb and 0x00FFFFFF, Shader.TileMode.CLAMP).also { shader = it; shaderColor = rgb }
  }

  override fun onDraw(canvas: Canvas) {
    running = false
    val now = SystemClock.uptimeMillis().toDouble()
    val alive = model.step(now)
    if (alive) {
      // 1) The soft bloom under the mesh, at the newest sample.
      if (model.bloomAlpha > 0) {
        bloomPaint.shader = bloomShader()
        bloomPaint.alpha = (model.bloomAlpha * 255).roundToInt().coerceIn(0, 255)
        val cx = (model.bloomX * density).toFloat(); val cy = (model.bloomY * density).toFloat()
        canvas.save()
        canvas.translate(cx, cy)
        canvas.drawCircle(0f, 0f, (TrailRules.RADIUS * TrailRules.BLOOM_SCALE).toFloat() * density, bloomPaint)
        canvas.restore()
      }
      // 2) The tiles, snapped to the fixed screen grid.
      model.compute(now)
      if (model.lit > 0) {
        val pitch = TrailRules.PITCH * density
        val inset = (TrailRules.PITCH - TrailRules.DOT) / 2 * density
        val side = TrailRules.DOT * density
        val alpha = model.alpha; val cols = model.cols
        for (r in 0 until model.rows) {
          val top = ((model.r0 + r) * pitch + inset).roundToInt().toFloat()
          val bottom = ((model.r0 + r) * pitch + inset + side).roundToInt().toFloat()
          for (c in 0 until cols) {
            val a = alpha[r * cols + c]
            if (a <= 0f) continue
            val left = ((model.c0 + c) * pitch + inset).roundToInt().toFloat()
            val right = ((model.c0 + c) * pitch + inset + side).roundToInt().toFloat()
            paint.color = (rgb and 0x00FFFFFF) or ((a * 255).roundToInt().coerceIn(0, 255) shl 24)
            canvas.drawRect(left, top, right, bottom, paint)
          }
        }
      }
      // Idle = no loop once the light has faded out.
      frame()
    }
  }
}

/** Wraps the Activity's Window.Callback: every touch is shown to the overlay first, then handed on unchanged.
 *  The result is always the wrapped callback's own; nothing here can consume or alter an event. */
class TrailCallback(val inner: Window.Callback, @Volatile var overlay: TrailOverlay?) : Window.Callback by inner {
  override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
    if (event != null) {
      try { overlay?.observe(event) } catch (_: Throwable) { /* decorative: never in the way */ }
    }
    return inner.dispatchTouchEvent(event)
  }

  // Default interface methods are spelled out so the Activity's own overrides keep working.
  override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>?, menu: Menu?, deviceId: Int) = inner.onProvideKeyboardShortcuts(data, menu, deviceId)
  override fun onPointerCaptureChanged(hasCapture: Boolean) = inner.onPointerCaptureChanged(hasCapture)
  override fun dispatchKeyEvent(event: KeyEvent?) = inner.dispatchKeyEvent(event)
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? = inner.onWindowStartingActionMode(callback, type)
}
