package com.linea.messenger.avatars

import android.content.Context
import android.os.PowerManager
import android.provider.Settings
import android.view.Choreographer
import android.view.View
import com.linea.messenger.offline.NetPool
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.sin

/** May the decorations move right now (iOS Effects/Motion.swift, the reference's motionPolicy.ts for what the
 *  avatars need): animations are off when the system's animator scale is 0 («Удалить анимации») or in the system's
 *  battery saver; the heavy ones — a looping video avatar or banner — also need a fast connection (the reference
 *  keeps the photo on a slow link, so a video does not eat what messages need). The app's own «Энергосбережение и
 *  анимации» switches, when the app has them, are read through `override` (set by whoever owns that page). */
object AvatarMotion {
  private var app: Context? = null

  /** Set by the app's energy-saving settings when they exist: (feature) → allowed; null asks the system only.
   *  Features: "motion" (all animations), "video", "gif", "emoji", "stickers". */
  var override: ((String) -> Boolean)? = null

  fun attach(context: Context) { if (app == null) app = context.applicationContext }

  /** The app's animations are on. */
  fun enabled(context: Context? = null): Boolean {
    context?.let { attach(it) }
    override?.let { return it("motion") }
    val known = app ?: return true
    val scale = try { Settings.Global.getFloat(known.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) } catch (_: Exception) { 1f }
    if (scale == 0f) return false
    val power = known.getSystemService(Context.POWER_SERVICE) as? PowerManager
    return power?.isPowerSaveMode != true
  }

  /** One heavy kind may play: animations on and its own switch on. */
  fun feature(name: String, context: Context? = null): Boolean {
    if (!enabled(context)) return false
    return override?.invoke(name) ?: true
  }

  /** The connection is fast enough for a looping video. */
  val fastNet: Boolean get() = try { NetPool.tier == "fast" } catch (_: Throwable) { true }
}

/** The one clock of every moving decoration (code frames, art, turning rings, Platina's metal, the profile's
 *  ambience): a single Choreographer callback that redraws the views now on screen, at most 60 times a second (a
 *  90/120 Hz phone does not draw decorations twice as often), and stops by itself when nothing moves, when the views
 *  leave the window or hide, and while the app's animations are off («Энергосбережение и анимации», the system's
 *  battery saver or «Удалить анимации»). The views never ask for their own next frame from onDraw. */
object DecorTicker : Choreographer.FrameCallback {
  /** At least this long between two redraws (ms): a little under 1/60 s, so a 60 Hz screen keeps every frame and a
   *  90/120 Hz one draws the decorations at most 60 times a second. */
  private const val GAP = 15L
  private val views = ArrayList<View>()
  private var posted = false
  private var postedAt = 0L
  private var lastFrame = 0L
  private var frames = 0
  private var watching = false
  private val motionChanged: (Unit) -> Unit = { refresh() }

  /** The app's animations are on (kept here, read again when they change and about once a second while ticking). */
  var allowed = true
    private set

  /** The view is on the clock now (tests). */
  fun ticking(view: View): Boolean = views.contains(view)

  fun start(view: View) {
    if (!watching) { watching = true; try { com.linea.messenger.effects.Motion.changed.watch(motionChanged) } catch (_: Throwable) {} }
    AvatarMotion.attach(view.context)
    if (!views.contains(view)) views.add(view)
    refresh()
  }

  fun stop(view: View) { views.remove(view) }

  /** Reads the animations' switch again; when it flips, the moving views redraw once (still or moving). */
  fun refresh() {
    val now = AvatarMotion.enabled()
    if (now != allowed) { allowed = now; invalidateAll() }
    schedule()
  }

  private fun schedule() {
    if (!allowed || views.isEmpty()) return
    val now = android.os.SystemClock.uptimeMillis()
    // Already asked (a request that never came back — a looper thrown away in tests — is asked again after a second).
    if (posted && now - postedAt < 1000) return
    posted = true; postedAt = now
    // The next frame no sooner than GAP after the last one: asked for a little before, so it lands on the vsync.
    val wait = lastFrame + GAP - now
    val choreographer = Choreographer.getInstance()
    choreographer.removeFrameCallback(this)
    if (wait > 0) choreographer.postFrameCallbackDelayed(this, wait) else choreographer.postFrameCallback(this)
  }

  override fun doFrame(frameTimeNanos: Long) {
    posted = false
    if (views.isEmpty()) return
    lastFrame = frameTimeNanos / 1_000_000
    frames += 1
    if (frames % 60 == 0) { refresh(); if (!allowed) return }
    invalidateAll()
    schedule()
  }

  private fun invalidateAll() {
    var index = views.size - 1
    while (index >= 0) { views[index].invalidate(); index -= 1 }
  }

  /** A view's place on the clock: it ticks while it wants to, is in a window and is shown. */
  class Link(private val view: View) {
    private var wanted = false
    private var attached = false
    private var shown = true

    fun want(value: Boolean) { wanted = value; apply() }
    fun attached(value: Boolean) { attached = value; if (value) shown = view.isShown; apply() }
    fun shown(value: Boolean) { shown = value; apply() }
    private fun apply() { if (wanted && attached && shown) start(view) else stop(view) }
  }
}

/** The reference's deterministic pseudo-random: the same frame looks the same on every phone. */
fun decorRand(seed: Double): Double {
  val x = sin(seed * 9301 + 49297) * 233280
  return x - floor(x)
}

/** Easing curves of Reanimated. */
object DecorEase {
  fun inOutSine(t: Double): Double = -(cos(Math.PI * t) - 1) / 2
  fun inOutQuad(t: Double): Double = if (t < 0.5) 2 * t * t else 1 - (-2 * t + 2).pow(2) / 2
  fun inOutCubic(t: Double): Double = if (t < 0.5) 4 * t * t * t else 1 - (-2 * t + 2).pow(3) / 2

  /** Where a repeating loop of `duration` seconds stands at `time` (seconds), after `delay`: 0…1, eased. Before the
   *  delay it rests at 0 (Reanimated's withDelay(withRepeat(…))). */
  fun loop(time: Double, duration: Double, delay: Double = 0.0, ease: (Double) -> Double = { it }): Double {
    if (duration <= 0) return 0.0
    val t = time - delay
    if (t < 0) return ease(0.0)
    return ease((t % duration) / duration)
  }

  /** The same loop not eased (0…1): for the frames' own easing applied after, without a function value — what the
   *  moving decorations use on every frame (no boxing of the numbers through a lambda). */
  fun phase(time: Double, duration: Double, delay: Double = 0.0): Double {
    if (duration <= 0) return 0.0
    val t = time - delay
    if (t < 0) return 0.0
    return (t % duration) / duration
  }
}

/** An SVG path in a `viewBox` of w×h, scaled to `width`×`height` (only M, L, C, Q, Z with absolute numbers). */
fun svgPath(text: String, viewW: Float, viewH: Float, width: Float, height: Float): android.graphics.Path {
  val path = android.graphics.Path()
  val sx = width / viewW; val sy = height / viewH
  val numbers = ArrayList<Float>()
  var command = 'M'
  fun flush() {
    fun x(i: Int) = numbers[i] * sx
    fun y(i: Int) = numbers[i + 1] * sy
    when (command) {
      'M' -> if (numbers.size >= 2) { path.moveTo(x(0), y(0)); var i = 2; while (i + 1 < numbers.size) { path.lineTo(x(i), y(i)); i += 2 } }
      'L' -> { var i = 0; while (i + 1 < numbers.size) { path.lineTo(x(i), y(i)); i += 2 } }
      'C' -> { var i = 0; while (i + 5 < numbers.size) { path.cubicTo(x(i), y(i), x(i + 2), y(i + 2), x(i + 4), y(i + 4)); i += 6 } }
      'Q' -> { var i = 0; while (i + 3 < numbers.size) { path.quadTo(x(i), y(i), x(i + 2), y(i + 2)); i += 4 } }
      'Z' -> path.close()
    }
    numbers.clear()
  }
  val current = StringBuilder()
  fun take() { current.toString().toFloatOrNull()?.let { numbers.add(it) }; current.setLength(0) }
  for (c in text) {
    when {
      c in "MLCQZ" -> { take(); flush(); command = c }
      c == ' ' || c == ',' -> take()
      c == '-' && current.isNotEmpty() -> { take(); current.append('-') }
      else -> current.append(c)
    }
  }
  take(); flush()
  return path
}
