package com.linea.messenger.intro

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import com.linea.messenger.effects.Motion
import kotlin.math.roundToInt

/** The intro's taps on the phone's haptic engine (IntroModel.taps): purely tactile — the engine's own fine primitives
 *  where the phone has them (a low tick for the taps, a thud for the field), very short low pulses where it can only
 *  set the strength, and nothing at all where it can do neither (never a coarse buzz). Silent when the system's touch
 *  feedback is off or power saving is on. iOS: Sources/Intro/IntroHaptics.swift. */
class IntroHaptics(context: Context) {
  private val app = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val token = Any()
  private var motor: Vibrator? = null

  /** How each kind of tap is played on this phone. */
  enum class Way { PRIMITIVE, PULSE, NONE }

  /** What the phone offers (decided once, see `plan`). */
  class Plan(val tap: Way, val thud: Way, val tapPrimitive: Int, val thudPrimitive: Int)

  companion object {
    /** The pure choice: primitives first (LOW_TICK on Android 12+, else TICK on 11; THUD on 12+), else short pulses
     *  with amplitude control, else nothing. */
    fun plan(sdk: Int, lowTick: Boolean, tick: Boolean, thud: Boolean, amplitude: Boolean): Plan {
      val tapPrimitive = when {
        sdk >= 31 && lowTick -> VibrationEffect.Composition.PRIMITIVE_LOW_TICK
        sdk >= 30 && tick -> VibrationEffect.Composition.PRIMITIVE_TICK
        else -> -1
      }
      val thudPrimitive = if (sdk >= 31 && thud) VibrationEffect.Composition.PRIMITIVE_THUD else -1
      fun way(primitive: Int) = when { primitive >= 0 -> Way.PRIMITIVE; amplitude -> Way.PULSE; else -> Way.NONE }
      return Plan(way(tapPrimitive), way(thudPrimitive), tapPrimitive, thudPrimitive)
    }

    /** A pulse where only the strength can be set: a tap 10 ms low, the thud 35 ms at mid strength (1…255). */
    fun pulse(tap: IntroModel.Tap): Pair<Long, Int> =
      if (tap.kind == IntroModel.Tap.Kind.THUD) 35L to (255 * tap.strength * 0.6).roundToInt().coerceIn(1, 255)
      else 10L to (255 * (0.12 + 0.3 * tap.strength)).roundToInt().coerceIn(1, 255)

    /** The system's touch feedback is on and the app is not saving power. */
    fun allowed(context: Context): Boolean {
      val touch = try { Settings.System.getInt(context.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0 } catch (_: Exception) { true }
      return touch && !Motion.saving
    }
  }

  @Suppress("DEPRECATION")
  private fun vibrator(): Vibrator? =
    if (Build.VERSION.SDK_INT >= 31) (app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    else app.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator

  /** Schedules every tap against the intro's clock: t = 0 at the uptime `begin` (ms). */
  fun start(begin: Long) {
    stop()
    if (!allowed(app)) return
    val vib = try { vibrator()?.takeIf { it.hasVibrator() } } catch (_: Exception) { null } ?: return
    val plan = try {
      val lowTick = Build.VERSION.SDK_INT >= 31 && vib.areAllPrimitivesSupported(VibrationEffect.Composition.PRIMITIVE_LOW_TICK)
      val tick = Build.VERSION.SDK_INT >= 30 && vib.areAllPrimitivesSupported(VibrationEffect.Composition.PRIMITIVE_TICK)
      val thud = Build.VERSION.SDK_INT >= 31 && vib.areAllPrimitivesSupported(VibrationEffect.Composition.PRIMITIVE_THUD)
      plan(Build.VERSION.SDK_INT, lowTick, tick, thud, vib.hasAmplitudeControl())
    } catch (_: Exception) { return }
    motor = vib
    for (tap in IntroModel.taps) {
      val effect = effect(tap, plan) ?: continue
      main.postAtTime({ play(vib, effect) }, token, begin + (tap.time * 1000).roundToInt())
    }
  }

  private fun effect(tap: IntroModel.Tap, plan: Plan): VibrationEffect? {
    val thud = tap.kind == IntroModel.Tap.Kind.THUD
    val way = if (thud) plan.thud else plan.tap
    return try {
      when (way) {
        Way.PRIMITIVE -> if (Build.VERSION.SDK_INT >= 30) VibrationEffect.startComposition().addPrimitive(if (thud) plan.thudPrimitive else plan.tapPrimitive, tap.strength.toFloat().coerceIn(0f, 1f)).compose() else null
        Way.PULSE -> pulse(tap).let { (ms, amplitude) -> VibrationEffect.createOneShot(ms, amplitude) }
        Way.NONE -> null
      }
    } catch (_: Exception) { null }
  }

  @Suppress("DEPRECATION")
  private fun play(vib: Vibrator, effect: VibrationEffect) {
    try {
      if (Build.VERSION.SDK_INT >= 33) vib.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
      else vib.vibrate(effect, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
    } catch (_: Exception) { /* no tap */ }
  }

  /** Nothing more: the taps not yet played are dropped, the one playing stops. */
  fun stop() {
    main.removeCallbacksAndMessages(token)
    try { motor?.cancel() } catch (_: Exception) {}
    motor = null
  }
}
