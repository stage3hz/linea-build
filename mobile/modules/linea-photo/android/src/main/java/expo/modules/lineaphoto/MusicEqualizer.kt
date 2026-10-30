package expo.modules.lineaphoto

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.audiofx.Equalizer
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import expo.modules.kotlin.sharedobjects.SharedObject
import expo.modules.kotlin.sharedobjects.SharedRef
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Music equalizer on Android: the system Equalizer effect attached to expo-audio's ExoPlayer
 * audio session. The device has its own fixed bands (often 5); each band gets the gain of our
 * three-band curve (НЧ low shelf ~120 Hz, СЧ peak ~1 kHz, ВЧ high shelf ~8 kHz) at its centre.
 */
@OptIn(UnstableApi::class)
class MusicEqualizerModule : Module() {
  private var equalizer: Equalizer? = null
  private var sessionId = 0
  private var gains = doubleArrayOf(0.0, 0.0, 0.0)
  private var enabled = false
  private var routeCallback: AudioDeviceCallback? = null
  private fun audio() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    Name("LineaEqualizer")
    Events("onAudioRoute")
    AsyncFunction("attachEqualizer") { player: SharedObject ->
      // expo-audio's AudioPlayer is a SharedRef<ExoPlayer>; no compile-time dependency on expo-audio.
      val exo = (player as? SharedRef<*>)?.ref as? ExoPlayer ?: return@AsyncFunction
      val session = exo.audioSessionId
      if (session != sessionId || equalizer == null) {
        try { equalizer?.release() } catch (_: Exception) {}
        equalizer = try { Equalizer(0, session) } catch (_: Exception) { null }
        sessionId = session
      }
      apply()
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    Function("setEqualizer") { low: Double, mid: Double, high: Double, on: Boolean ->
      gains = doubleArrayOf(low.coerceIn(-12.0, 12.0), mid.coerceIn(-12.0, 12.0), high.coerceIn(-12.0, 12.0)); enabled = on
      Handler(Looper.getMainLooper()).post { apply() }
    }
    Function("audioRoute") { route() }
    OnStartObserving("onAudioRoute") {
      val manager = audio() ?: return@OnStartObserving
      val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) { sendEvent("onAudioRoute", route()) }
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) { sendEvent("onAudioRoute", route()) }
      }
      routeCallback = callback
      manager.registerAudioDeviceCallback(callback, Handler(Looper.getMainLooper()))
    }
    OnStopObserving("onAudioRoute") { routeCallback?.let { audio()?.unregisterAudioDeviceCallback(it) }; routeCallback = null }
    OnDestroy { try { equalizer?.release() } catch (_: Exception) {}; equalizer = null }
  }

  private fun route(): Map<String, Any?> {
    val headphones = setOf(AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER)
    val device = audio()?.getDevices(AudioManager.GET_DEVICES_OUTPUTS)?.firstOrNull { it.type in headphones }
    return mapOf("route" to if (device != null) "headphones" else "speaker", "name" to device?.productName?.toString())
  }

  /** Gain (dB) of the three-band curve at a frequency; matches the iOS filters closely enough for fixed bands. */
  private fun curve(hz: Double): Double {
    val low = 1.0 / (1.0 + (hz / 120.0).pow(2))
    val high = 1.0 / (1.0 + (8000.0 / hz).pow(2))
    val octaves = ln(hz / 1000.0) / ln(2.0)
    val mid = exp(-(octaves * octaves) / (2 * 1.1 * 1.1))
    return gains[0] * low + gains[1] * mid + gains[2] * high
  }

  private fun apply() {
    val eq = equalizer ?: return
    try {
      eq.enabled = enabled
      if (!enabled) return
      val range = eq.bandLevelRange // millibels
      for (band in 0 until eq.numberOfBands.toInt()) {
        val hz = eq.getCenterFreq(band.toShort()) / 1000.0
        val level = (curve(hz) * 100).roundToInt().coerceIn(range[0].toInt(), range[1].toInt())
        eq.setBandLevel(band.toShort(), level.toShort())
      }
    } catch (_: Exception) { /* the effect may be unavailable on this device */ }
  }
}
