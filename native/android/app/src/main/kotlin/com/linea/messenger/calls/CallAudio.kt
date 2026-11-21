package com.linea.messenger.calls

import android.Manifest
import android.app.Activity
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import com.linea.messenger.R
import com.linea.messenger.voice.Permits

/** The sound of a call on the phone: where it plays (the earpiece, the loudspeaker, headphones), the sensor that
 *  darkens the screen at the ear, and giving the sound back when the call is over. What the reference asks of
 *  react-native-incall-manager (CallProvider.tsx `inCall.start`, `setForceSpeakerphoneOn`, `stop`), with the
 *  Bluetooth route the reference patches into it. Main thread. */
object CallAudio {
  private var running = false
  private var isVideo = false
  private var forcedNow: Boolean? = null
  private var audio: AudioManager? = null
  private var focus: AudioFocusRequest? = null
  private var nearEar: PowerManager.WakeLock? = null
  private var scoOn = false
  private val main = Handler(Looper.getMainLooper())

  /** Headphones were connected or taken away during the call: the route is chosen again. */
  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) { if (running) route(forcedNow, isVideo) }
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) { if (running) route(forcedNow, isVideo) }
  }

  /** Where the call sounds: "speaker", "earpiece", "bluetooth" or "wired". `forced` true: the loudspeaker;
   *  false: the phone's earpiece; null: the system's own route — Bluetooth or wired headphones when they are
   *  connected, else the earpiece (a video call: the loudspeaker). */
  fun choice(forced: Boolean?, video: Boolean, bluetooth: Boolean, wired: Boolean): String = when {
    forced == true -> "speaker"
    forced == false -> "earpiece"
    bluetooth -> "bluetooth"
    wired -> "wired"
    video -> "speaker"
    else -> "earpiece"
  }

  private fun kind(type: Int): String? = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, 26 /* TYPE_BLE_HEADSET */ -> "bluetooth"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
    else -> null
  }

  /** The call's audio begins: before the microphone is opened.
   *  A call starts on the system's own route: Bluetooth or wired headphones when they are connected, else the
   *  earpiece (a video call: the loudspeaker). */
  fun start(context: Context, video: Boolean) {
    val system = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    audio = system
    running = true
    isVideo = video
    // Other sound (music of another app) gives way for the length of the call.
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    val asked = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes).setOnAudioFocusChangeListener { }.build()
    focus = asked
    try { system.requestAudioFocus(asked) } catch (_: Exception) {}
    try { system.mode = AudioManager.MODE_IN_COMMUNICATION } catch (_: Exception) {}
    try { system.registerAudioDeviceCallback(devices, main) } catch (_: Exception) {}
    if (nearEar == null) {
      val power = context.applicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (power != null && power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
        nearEar = try { power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "invizent:call").apply { setReferenceCounted(false) } } catch (_: Exception) { null }
      }
    }
    route(null, video)
  }

  /** true: the loudspeaker; false: the phone's earpiece; null: the system's own route. */
  fun route(forced: Boolean?, video: Boolean) {
    val system = audio
    if (!running || system == null) return
    isVideo = video
    forcedNow = forced
    val loud = forced ?: video
    try {
      if (Build.VERSION.SDK_INT >= 31) {
        val offered = system.availableCommunicationDevices
        val wanted = choice(forced, video, offered.any { kind(it.type) == "bluetooth" }, offered.any { kind(it.type) == "wired" })
        val device = offered.firstOrNull { kind(it.type) == wanted }
        if (device != null) system.setCommunicationDevice(device) else system.clearCommunicationDevice()
      } else {
        legacyRoute(system, forced, video)
      }
    } catch (_: Exception) {}
    // At the ear the screen goes dark and takes no touches — only while the sound is not in the loudspeaker.
    try { if (loud) nearEar?.let { if (it.isHeld) it.release() } else nearEar?.acquire(4 * 60 * 60 * 1000L) } catch (_: Exception) {}
  }

  @Suppress("DEPRECATION")
  private fun legacyRoute(system: AudioManager, forced: Boolean?, video: Boolean) {
    val outputs = system.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    val wanted = choice(forced, video, system.isBluetoothScoAvailableOffCall && outputs.any { kind(it.type) == "bluetooth" }, outputs.any { kind(it.type) == "wired" })
    if (wanted == "bluetooth") {
      if (!scoOn) { scoOn = true; system.startBluetoothSco(); system.isBluetoothScoOn = true }
    } else if (scoOn) {
      scoOn = false
      system.isBluetoothScoOn = false
      system.stopBluetoothSco()
    }
    system.isSpeakerphoneOn = wanted == "speaker"
  }

  /** The call is over: the sensor is released and other sound may come back. */
  @Suppress("DEPRECATION")
  fun stop() {
    if (!running) return
    running = false
    forcedNow = null
    try { nearEar?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
    val system = audio ?: return
    try { system.unregisterAudioDeviceCallback(devices) } catch (_: Exception) {}
    try {
      if (Build.VERSION.SDK_INT >= 31) system.clearCommunicationDevice()
      else {
        if (scoOn) { scoOn = false; system.isBluetoothScoOn = false; system.stopBluetoothSco() }
        system.isSpeakerphoneOn = false
      }
    } catch (_: Exception) {}
    try { system.mode = AudioManager.MODE_NORMAL } catch (_: Exception) {}
    focus?.let { try { system.abandonAudioFocusRequest(it) } catch (_: Exception) {} }
    focus = null
  }

  const val noMicrophone = "Нет доступа к микрофону. Разреши его для Инвиза в настройках телефона, чтобы звонить."
  const val noCamera = "Нет доступа к камере. Разреши её для Инвиза в настройках телефона, чтобы включить видео."

  /** Asks for the microphone (and the camera, for a video call) the first time a call needs them; the system's
   *  question appears only then. `done` gets null, or the words that say what is not allowed. Main thread. */
  fun allow(activity: Activity?, video: Boolean, done: (String?) -> Unit) {
    if (activity == null) return done(noMicrophone)
    Permits.ask(activity, listOf(Manifest.permission.RECORD_AUDIO)) { granted ->
      if (!granted) done(noMicrophone) else if (!video) done(null) else allowCamera(activity, done)
    }
  }

  fun allowCamera(activity: Activity?, done: (String?) -> Unit) {
    if (activity == null) return done(noCamera)
    Permits.ask(activity, listOf(Manifest.permission.CAMERA)) { granted -> done(if (granted) null else noCamera) }
  }
}

/** The call's own sounds (made for the app, the reference's assets): the two ringbacks the caller hears — a lower,
 *  slower one while the call is on its way and the usual one once the other phone has it — and the melody of an
 *  incoming call. Seamless loops; only one plays at a time. Main thread. */
object CallSounds {
  private var player: MediaPlayer? = null
  private var buzzer: Vibrator? = null

  /** The file of a sound by its kind; 0 for an unknown one. */
  fun resource(kind: String): Int = when (kind) {
    "connecting" -> R.raw.call_connecting
    "outgoing" -> R.raw.call_outgoing
    "incoming" -> R.raw.call_incoming
    else -> 0
  }

  /** `kind`: "connecting", "outgoing" or "incoming". */
  fun play(context: Context, kind: String) {
    stop()
    val id = resource(kind)
    if (id == 0) return
    try {
      val made = MediaPlayer()
      // The melody of an incoming call follows the phone's ringer (silent: no melody, the vibration still
      // rings); the ringback always plays — it sounds inside the call's own audio.
      made.setAudioAttributes(AudioAttributes.Builder()
        .setUsage(if (kind == "incoming") AudioAttributes.USAGE_NOTIFICATION_RINGTONE else AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
      context.applicationContext.resources.openRawResourceFd(id).use { made.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
      made.isLooping = true
      val volume = if (kind == "incoming") 1f else 0.7f
      made.setVolume(volume, volume)
      made.prepare()
      made.start()
      player = made
    } catch (_: Exception) { player = null }
  }

  fun stop() {
    val current = player ?: return
    player = null
    try { current.stop() } catch (_: Exception) {}
    try { current.release() } catch (_: Exception) {}
  }

  /** The phone hums while an incoming call rings: 0.6 s, a pause, again. Not when the phone is set to silence. */
  @Suppress("DEPRECATION")
  fun vibrate(context: Context) {
    still()
    val app = context.applicationContext
    if ((app.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.ringerMode == AudioManager.RINGER_MODE_SILENT) return
    val motor = app.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
    try {
      if (!motor.hasVibrator()) return
      motor.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 900), 0),
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
      buzzer = motor
    } catch (_: Exception) {}
  }

  fun still() {
    try { buzzer?.cancel() } catch (_: Exception) {}
    buzzer = null
  }
}
