package com.linea.messenger.avatars

import android.content.Context
import android.os.PowerManager
import android.provider.Settings
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
