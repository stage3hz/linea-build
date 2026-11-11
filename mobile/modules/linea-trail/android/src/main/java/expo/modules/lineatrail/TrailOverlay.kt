package expo.modules.lineatrail

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
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
 *  It redraws (postInvalidateOnAnimation, i.e. on the Choreographer frame) only while some cell is alive. */
@SuppressLint("ViewConstructor")
class TrailOverlay(context: Context) : View(context) {
  private val model = TrailModel()
  private val paint = Paint().apply { style = Paint.Style.FILL; isAntiAlias = false; color = Color.WHITE }
  private var rgb = Color.WHITE
  private val density = context.resources.displayMetrics.density
  private var running = false

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

  /** Called from the window callback BEFORE the app sees the event; never consumes it. */
  fun observe(event: MotionEvent) {
    val now = SystemClock.uptimeMillis().toDouble()
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
        // System «Remove animations» (animator duration scale 0) = no trail.
        if (!ValueAnimator.areAnimatorsEnabled()) return
        val index = event.actionIndex
        model.begin(event.getPointerId(index), event.getX(index) / density, event.getY(index) / density)
      }
      MotionEvent.ACTION_MOVE -> {
        var lit = 0
        for (p in 0 until event.pointerCount) {
          val id = event.getPointerId(p)
          for (h in 0 until event.historySize) lit += model.move(id, event.getHistoricalX(p, h) / density, event.getHistoricalY(p, h) / density, now)
          lit += model.move(id, event.getX(p) / density, event.getY(p) / density, now)
        }
        if (lit > 0 && !running) { running = true; postInvalidateOnAnimation() }
      }
      MotionEvent.ACTION_POINTER_UP -> model.lift(event.getPointerId(event.actionIndex))
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> model.liftAll()
    }
  }

  fun stop() { model.clear(); running = false; invalidate() }

  override fun onDraw(canvas: Canvas) {
    val now = SystemClock.uptimeMillis().toDouble()
    if (!model.alive(now)) { running = false; return }
    val cell = TrailRules.GRID * density
    for (i in 0 until TrailRules.MAX_LIVE) {
      val a = model.alpha(i, now)
      if (a <= 0.0) continue
      paint.color = (rgb and 0x00FFFFFF) or ((a * 255).roundToInt().coerceIn(0, 255) shl 24)
      val left = (model.cx[i] * cell).roundToInt().toFloat()
      val top = (model.cy[i] * cell).roundToInt().toFloat()
      val side = (model.size[i] * cell).roundToInt().toFloat()
      canvas.drawRect(left, top, left + side, top + side, paint)
    }
    postInvalidateOnAnimation()
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
