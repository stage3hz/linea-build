package com.linea.messenger.effects

import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.view.View
import android.view.ViewTreeObserver
import android.view.animation.AnimationUtils
import java.util.WeakHashMap
import kotlin.math.abs
import kotlin.math.hypot

/** Motion blur for screens slower than 90 Hz (iOS: Sources/Effects/MotionBlur.swift).
 *
 *  On a 60 Hz panel a page that slides 3000 dp/s jumps 50 dp between two frames; a little blur along the motion
 *  hides the steps and the slide reads smoother. A watched view is blurred along the axis it moves on, by its own
 *  measured speed: nothing below [DEAD] dp/s, a smooth rise to [MAX_RADIUS_DP] at [FULL] dp/s and above, and gone the
 *  very frame it stops. 90 Hz and faster panels get nothing (they are smooth already); nothing either below
 *  Android 12 (no RenderEffect), in power saving, with animations off («Энергосбережение и анимации») or with the
 *  system's «Remove animations».
 *
 *  How: [attach] puts one pre-draw listener on the view's window. The listener runs only on frames the window draws
 *  anyway (a moving view makes it draw), reads where the view is in the window (its own and its parents' translations
 *  and scrolls, plus its own scroll for a pager), and sets a one-axis RenderEffect blur when the speed calls for one.
 *  When a blur is on it asks for one more frame, which sees the view still and takes the blur off.
 *  Cost: no work at all on 90 Hz+ panels (the listener is never added); on 60 Hz one getLocationInWindow per watched
 *  view per drawn frame (microseconds), and while moving fast a GPU blur of the view (one axis, Skia downsamples it). */
object MotionBlur {
  /** Below this speed (dp/s) nothing is blurred: a slow drag stays crisp. */
  const val DEAD = 250f
  /** At and above this speed (dp/s) the blur is at its strongest. */
  const val FULL = 3500f
  /** The strongest blur radius, dp (the RenderEffect radius, along the motion only). */
  const val MAX_RADIUS_DP = 6f
  /** A move longer than this share of the view's size in one frame is a jump (a page put in place), not a motion. */
  private const val JUMP = 0.75f

  /** The emulator check (`--es motionblur 1|0|hold`, src/debug Demo.kt): null = automatic, true = on whatever the
   *  screen and the power, false = off. */
  @JvmStatic var forced: Boolean? = null
  /** The emulator check `hold`: the strongest blur stays on a view once it has moved, for a still screenshot. */
  @JvmStatic var hold = false

  /** 0…1 from the speed in dp/s: zero up to [DEAD], a smoothstep up to [FULL]. */
  fun strength(speed: Float): Float {
    val t = ((speed - DEAD) / (FULL - DEAD)).coerceIn(0f, 1f)
    return t * t * (3f - 2f * t)
  }

  /** The blur radius in dp for a speed in dp/s. */
  fun radiusDp(speed: Float): Float = strength(speed) * MAX_RADIUS_DP

  private val watchers = WeakHashMap<View, Watcher>()
  private var slow: Boolean? = null
  private var allowedAt = -1L
  private var allowedNow = false

  /** Starts watching `view` (safe to call again). Nothing happens below Android 12. `offsetY`: for a view that moves
   *  its picture inside its own drawing (the photo viewer's drag), how far down that picture is now, px. */
  fun attach(view: View, offsetY: (() -> Float)? = null) {
    if (Build.VERSION.SDK_INT < 31 || forced == false || watchers.containsKey(view)) return
    val watcher = Watcher(view, offsetY)
    watchers[view] = watcher
    view.addOnAttachStateChangeListener(watcher)
    if (view.isAttachedToWindow) watcher.onViewAttachedToWindow(view)
  }

  /** Stops watching `view` and takes its blur off. */
  fun detach(view: View) {
    val watcher = watchers.remove(view) ?: return
    view.removeOnAttachStateChangeListener(watcher)
    watcher.onViewDetachedFromWindow(view)
  }

  /** The panel's fastest rate is below 90 Hz. The highest supported mode is asked, not the current one: a 120 Hz
   *  panel rests at 60 and speeds up as soon as something moves. */
  private fun slowScreen(view: View): Boolean {
    slow?.let { return it }
    val display = view.display ?: return false
    var best = display.refreshRate
    try { for (mode in display.supportedModes) best = maxOf(best, mode.refreshRate) } catch (_: Exception) {}
    val found = best < 89f
    slow = found
    return found
  }

  /** May a view be blurred on this frame (read once per frame for all the views). */
  private fun allowed(frame: Long): Boolean {
    if (frame == allowedAt) return allowedNow
    allowedAt = frame
    allowedNow = forced ?: (Motion.enabled && !Motion.saving && !Motion.power.reduceMotion && !Motion.power.lowPower)
    return allowedNow
  }

  private class Watcher(val view: View, val offsetY: (() -> Float)?) : ViewTreeObserver.OnPreDrawListener, View.OnAttachStateChangeListener {
    private var observer: ViewTreeObserver? = null
    private val spot = IntArray(2)
    private var lastX = 0f
    private var lastY = 0f
    private var lastAt = 0L
    private var speedX = 0f
    private var speedY = 0f
    /** The radius on the view now, px (positive = along x, negative = along y), 0 = none. */
    private var shown = 0f
    private var held = false

    override fun onViewAttachedToWindow(v: View) {
      if (observer != null) return
      if (forced != true && !slowScreen(view)) return
      observer = view.viewTreeObserver.also { it.addOnPreDrawListener(this) }
      lastAt = 0L
    }

    override fun onViewDetachedFromWindow(v: View) {
      observer?.let { if (it.isAlive) it.removeOnPreDrawListener(this) }
      observer = null
      set(0f)
      held = false
    }

    override fun onPreDraw(): Boolean {
      val now = AnimationUtils.currentAnimationTimeMillis()
      view.getLocationInWindow(spot)
      val x = spot[0] - view.scrollX.toFloat()
      val y = spot[1] - view.scrollY.toFloat() + (offsetY?.invoke() ?: 0f)
      val dt = now - lastAt
      val first = lastAt == 0L || dt > 100L
      if (dt <= 0L && !first) return true
      val dx = x - lastX; val dy = y - lastY
      lastX = x; lastY = y; lastAt = now
      if (held) return true
      if (first) { set(0f); return true }
      val jump = abs(dx) > view.width * JUMP || abs(dy) > view.height * JUMP
      if ((dx == 0f && dy == 0f) || jump || view.visibility != View.VISIBLE || !allowed(now)) {
        speedX = 0f; speedY = 0f
        set(0f)
        return true
      }
      val density = view.resources.displayMetrics.density
      // Speed in dp/s, smoothed over two frames (touch moves come unevenly).
      speedX = speedX * 0.5f + dx / dt * 1000f / density * 0.5f
      speedY = speedY * 0.5f + dy / dt * 1000f / density * 0.5f
      val speed = hypot(speedX, speedY)
      var radius = if (hold) MAX_RADIUS_DP * density else radiusDp(speed) * density
      radius = Math.round(radius * 2f) / 2f
      if (hold && radius > 0f) held = true
      set(if (abs(speedX) >= abs(speedY)) radius else -radius)
      // One more frame: if the view has stopped by then, that frame takes the blur off.
      if (radius > 0f && !held) view.postInvalidateOnAnimation()
      return true
    }

    private fun set(radius: Float) {
      if (radius == shown || Build.VERSION.SDK_INT < 31) return
      shown = radius
      view.setRenderEffect(when {
        radius > 0f -> RenderEffect.createBlurEffect(radius, 0f, Shader.TileMode.CLAMP)
        radius < 0f -> RenderEffect.createBlurEffect(0f, -radius, Shader.TileMode.CLAMP)
        else -> null
      })
    }
  }
}
