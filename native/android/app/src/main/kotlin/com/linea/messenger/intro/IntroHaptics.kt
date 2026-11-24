package com.linea.messenger.intro

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import com.linea.messenger.effects.Motion
import kotlin.math.roundToInt

/** The intro's touch on the phone's haptic motor: ONE long soft swell (IntroModel.haptic) that begins exactly when the
 *  letters begin to crumble and lets go as N comes to the centre — a single waveform of 20 ms steps whose strength
 *  follows the curve, kept low (at most 110 of 255) so it stays a soft touch — and one short soft tick when the
 *  honeycomb layer is passed. Nothing else. The swell only where the motor can set its strength; elsewhere nothing at
 *  all (never a coarse buzz). Silent when the system's touch feedback is off or power saving is on. */
class IntroHaptics(context: Context) {
  private val app = context.applicationContext
  private var motor: Vibrator? = null

  /** The swell as the motor plays it: how long each step lasts (ms) and its strength (0…255). */
  class Waveform(val timings: LongArray, val amplitudes: IntArray)

  companion object {
    /** One step of the waveform, ms. */
    const val STEP_MS = 20L
    /** The curve's 0…1 to the motor's 0…255, scaled down so the peak stays soft. */
    const val SCALE = 0.6
    /** The strongest step, of 255. */
    const val TOP = 110

    /** The motor's strength at t on the intro's clock (0…TOP). */
    fun strength(t: Double): Int = (IntroModel.haptic(t) * 255 * SCALE).roundToInt().coerceIn(0, TOP)

    /** How long the tick lasts, ms, and how strong it is, of 255 (where the system has no soft tick of its own). */
    const val TICK_MS = 10L
    const val TICK_STRENGTH = 60

    /** The pure choice: the swell where the motor can set its strength, nothing (null) where it cannot. The steps run
     *  from the swell's start to its end, each sampled at its middle. */
    fun plan(amplitude: Boolean): Waveform? {
      if (!amplitude) return null
      val count = ((IntroModel.SWELL_END - IntroModel.SWELL_START) * 1000 / STEP_MS).roundToInt()
      val amplitudes = IntArray(count) { i -> strength(IntroModel.SWELL_START + (i + 0.5) * STEP_MS / 1000.0) }
      return Waveform(LongArray(count) { STEP_MS }, amplitudes)
    }

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

  /** The letters begin to crumble now: the swell plays from its start. */
  fun swell() {
    stop()
    if (!allowed(app)) return
    val vib = try { vibrator()?.takeIf { it.hasVibrator() } } catch (_: Exception) { null } ?: return
    val wave = try { plan(vib.hasAmplitudeControl()) } catch (_: Exception) { null } ?: return
    motor = vib
    val effect = try { VibrationEffect.createWaveform(wave.timings, wave.amplitudes, -1) } catch (_: Exception) { null } ?: return
    play(vib, effect)
  }

  /** The honeycomb layer is passed: one short soft tick (the system's own soft tick where it has one). */
  fun tick() {
    if (!allowed(app)) return
    val vib = try { vibrator()?.takeIf { it.hasVibrator() } } catch (_: Exception) { null } ?: return
    val effect = try {
      when {
        Build.VERSION.SDK_INT >= 29 -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
        vib.hasAmplitudeControl() -> VibrationEffect.createOneShot(TICK_MS, TICK_STRENGTH)
        else -> null
      }
    } catch (_: Exception) { null } ?: return
    motor = vib
    play(vib, effect)
  }

  @Suppress("DEPRECATION")
  private fun play(vib: Vibrator, effect: VibrationEffect) {
    try {
      if (Build.VERSION.SDK_INT >= 33) vib.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
      else vib.vibrate(effect, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
    } catch (_: Exception) { /* no swell */ }
  }

  /** Nothing more: whatever plays stops at once. */
  fun stop() {
    try { motor?.cancel() } catch (_: Exception) {}
    motor = null
  }
}
