package com.linea.messenger.intro

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import com.linea.messenger.effects.Motion
import kotlin.math.roundToInt

/** The intro's touch on the phone's haptic motor (IntroModel.haptic): ONE long soft swell, never a train of taps — a
 *  single waveform from 1.1 s on the intro's clock, 20 ms steps whose strength follows the curve, kept low (at most
 *  110 of 255) so it stays a soft touch. Only where the motor can set its strength; elsewhere nothing at all (never a
 *  coarse buzz). Silent when the system's touch feedback is off or power saving is on.
 *  iOS: Sources/Intro/IntroHaptics.swift. */
class IntroHaptics(context: Context) {
  private val app = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val token = Any()
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

    /** The pure choice: the swell where the motor can set its strength, nothing (null) where it cannot. The steps run
     *  from 1.1 s to 4.1 s, each sampled at its middle. */
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

  /** Plays the swell against the intro's clock: t = 0 at the uptime `begin` (ms); the waveform starts at 1.1 s. If the
   *  main thread comes late, the steps already past are dropped, so the swell stays in step with the picture. */
  fun start(begin: Long) {
    stop()
    if (!allowed(app)) return
    val vib = try { vibrator()?.takeIf { it.hasVibrator() } } catch (_: Exception) { null } ?: return
    val wave = try { plan(vib.hasAmplitudeControl()) } catch (_: Exception) { null } ?: return
    motor = vib
    val at = begin + (IntroModel.SWELL_START * 1000).roundToInt()
    main.postAtTime({
      val late = ((SystemClock.uptimeMillis() - at) / STEP_MS).toInt().coerceAtLeast(0)
      if (late < wave.timings.size) {
        val effect = try {
          VibrationEffect.createWaveform(wave.timings.copyOfRange(late, wave.timings.size), wave.amplitudes.copyOfRange(late, wave.amplitudes.size), -1)
        } catch (_: Exception) { null }
        if (effect != null) play(vib, effect)
      }
    }, token, at)
  }

  @Suppress("DEPRECATION")
  private fun play(vib: Vibrator, effect: VibrationEffect) {
    try {
      if (Build.VERSION.SDK_INT >= 33) vib.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
      else vib.vibrate(effect, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
    } catch (_: Exception) { /* no swell */ }
  }

  /** Nothing more: the swell stops at once (or never starts). */
  fun stop() {
    main.removeCallbacksAndMessages(token)
    try { motor?.cancel() } catch (_: Exception) {}
    motor = null
  }
}
