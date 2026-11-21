package com.linea.messenger.voice

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.linea.messenger.attachments.FileCore
import java.io.File
import java.util.UUID
import kotlin.math.log10

/** The system's answers about permissions asked at the moment of use (`MainActivity.onRequestPermissionsResult`),
 *  carried to whoever asked. Nothing is asked at the start of the app. Main thread only. */
object Permits {
  private const val FIRST = 0x5650
  private var next = FIRST
  private val waiting = HashMap<Int, (Boolean) -> Unit>()

  fun has(context: Context, permission: String): Boolean = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  /** Asks for the permissions that are not given yet (the system shows its question, or answers by itself when
   *  the person has refused for good). `done`: whether all of them are given now. */
  fun ask(activity: Activity, permissions: List<String>, done: (Boolean) -> Unit) {
    val missing = permissions.filter { !has(activity, it) }
    if (missing.isEmpty()) return done(true)
    val code = next
    next = if (next >= FIRST + 400) FIRST else next + 1
    waiting[code] = done
    try { activity.requestPermissions(missing.toTypedArray(), code) } catch (_: Exception) { waiting.remove(code); done(false) }
  }

  /** The window's word about a question that was answered. True when it was one of these. */
  fun result(requestCode: Int, grantResults: IntArray): Boolean {
    val done = waiting.remove(requestCode) ?: return false
    done(grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED })
    return true
  }
}

/** The waveform's samples of one take. When the buffer is full, neighbours are merged (the louder wins) and from
 *  then on every `stride` levels make one sample: memory stays bounded and the waveform still spans the whole
 *  take. Reference: mobile/src/voice/voice.ts (`pushVoiceSample`). */
class VoiceSamples(private val cap: Int = 20000) {
  var samples = ArrayList<Double>()
    private set
  var stride = 1
    private set
  private var pendingLevel = 0.0
  private var pendingCount = 0
  var loudest = 0.0
    private set

  fun push(level: Double) {
    loudest = maxOf(loudest, level)
    pendingLevel = if (pendingCount == 0) level else maxOf(pendingLevel, level)
    pendingCount += 1
    if (pendingCount < stride) return
    samples.add(pendingLevel)
    pendingCount = 0
    pendingLevel = 0.0
    if (samples.size < cap) return
    val merged = ArrayList<Double>(samples.size / 2 + 1)
    var index = 0
    while (index < samples.size) {
      val other = if (index + 1 < samples.size) samples[index + 1] else 0.0
      merged.add(maxOf(samples[index], other))
      index += 2
    }
    samples = merged
    stride *= 2
  }

  /** Every level of the take, with the one still being gathered. */
  fun levels(): List<Double> = if (pendingCount > 0) samples + pendingLevel else samples
}

/** The microphone of one chat's composer. Nothing is recorded before `start()`, and the permission is asked only
 *  when the person first holds the microphone button.
 *
 *  Reference: mobile/src/voice/VoiceMessage.tsx (`VOICE_RECORDING`, `useVoiceRecorder`) and mobile/src/voice/voice.ts
 *  (`pushVoiceSample`, `levelFromMetering`, `diagnoseVoiceTake`). The file is what every other app plays: AAC-LC
 *  in an MPEG-4 container (.m4a), mono, 48 kHz, 128 kbit/s — the reference's own Android parameters. The loudness
 *  is read from the recorder ten times a second while the take runs; the core turns those levels into the
 *  waveform that travels with the message. */
class VoiceRecorder(private val context: Context) {
  /** A finished take. */
  class Take(
    val file: File, val durationMs: Long,
    /** The letters of the waveform; null when the take has no sound to draw. */
    val waveform: String?,
    /** The file is not the take (the microphone stopped): it is not sent. */
    val broken: Boolean,
    /** Nothing above the waveform's threshold was heard: sent, but the person is told. */
    val silent: Boolean,
  )

  private val main = Handler(Looper.getMainLooper())
  private var recorder: MediaRecorder? = null
  private var file: File? = null
  private var gathered = VoiceSamples()
  private var startedAt = 0L
  private var pausedAt = 0L
  private var pausedFor = 0L
  var isPaused = false
    private set
  /** The loudness right now, 0…1 (main thread, ten times a second). */
  var onLevel: ((Float) -> Unit)? = null
  /** The longest take was reached: it must be finished and sent. */
  var onLimit: (() -> Unit)? = null

  val isRecording: Boolean get() = recorder != null

  /** How long the take is by now (the time it stood paused is not counted). */
  val elapsedMs: Long get() {
    if (recorder == null) return 0
    val until = if (isPaused) pausedAt else SystemClock.elapsedRealtime()
    return maxOf(0L, until - startedAt - pausedFor)
  }

  private val meter = object : Runnable {
    override fun run() {
      if (recorder == null) return
      measure()
      main.postDelayed(this, 100)
    }
  }

  /** Starts a take; the words of the failure, or null. The permission must have been given already. */
  fun start(): String? {
    if (recorder != null) return null
    if (!allowed(context)) return noAccess
    val target = File(context.cacheDir, filePrefix + UUID.randomUUID().toString().lowercase() + ".m4a")
    @Suppress("DEPRECATION")
    val made = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
    try {
      made.setAudioSource(MediaRecorder.AudioSource.MIC)
      made.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      made.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      made.setAudioSamplingRate(SAMPLE_RATE)
      made.setAudioChannels(1)
      made.setAudioEncodingBitRate(BIT_RATE)
      made.setOutputFile(target.absolutePath)
      made.prepare()
      made.start()
    } catch (_: Exception) {
      try { made.release() } catch (_: Exception) {}
      target.delete()
      return "Не удалось начать запись."
    }
    recorder = made
    file = target
    gathered = VoiceSamples()
    startedAt = SystemClock.elapsedRealtime()
    pausedFor = 0
    isPaused = false
    // The first reading only starts the recorder's own measuring.
    try { made.maxAmplitude } catch (_: Exception) {}
    main.postDelayed(meter, 100)
    return null
  }

  private fun measure() {
    val recorder = recorder ?: return
    if (isPaused) return
    val amplitude = try { recorder.maxAmplitude } catch (_: Exception) { 0 }
    val level = level(amplitude)
    gathered.push(level)
    onLevel?.invoke(level.toFloat())
    if (elapsedMs >= MAX_MS) onLimit?.invoke()
  }

  /** Pauses the take or goes on with the same file. */
  fun togglePause() {
    val recorder = recorder ?: return
    try {
      if (isPaused) {
        recorder.resume()
        pausedFor += SystemClock.elapsedRealtime() - pausedAt
        isPaused = false
      } else {
        recorder.pause()
        pausedAt = SystemClock.elapsedRealtime()
        isPaused = true
      }
    } catch (_: Exception) { /* the recorder refused: the take goes on as it was */ }
  }

  /** Stops the take. Gives the file, or null when it is called off (the file is deleted then). */
  fun finish(keep: Boolean): Take? {
    val recorder = recorder ?: return null
    val target = file
    main.removeCallbacks(meter)
    val durationMs = minOf(MAX_MS, elapsedMs)
    // A recorder stopped before it wrote anything throws: the file is not a take then.
    val stopped = try { recorder.stop(); true } catch (_: Exception) { false }
    try { recorder.release() } catch (_: Exception) {}
    this.recorder = null
    file = null
    isPaused = false
    if (target == null) return null
    if (!keep) {
      target.delete()
      return null
    }
    val waveform = FileCore.call("waveform", listOf(gathered.levels())) as? String
    return Take(target, durationMs, waveform, broken = !stopped || tiny(durationMs, target.length()), silent = durationMs >= 1000 && !(gathered.loudest > 0.02))
  }

  companion object {
    const val noAccess = "Нет доступа к микрофону. Разреши его для Инвиза в настройках телефона, чтобы записывать голосовые."
    const val filePrefix = "invizent-voice-"
    const val SAMPLE_RATE = 48000
    const val BIT_RATE = 128000
    const val MAX_MS = 18L * 60 * 60 * 1000

    /** Whether the microphone may be used. */
    fun allowed(context: Context): Boolean = Permits.has(context, Manifest.permission.RECORD_AUDIO)

    /** The recorder's peak (0…32767) as the level the waveform is made of, 0…1: decibels of full scale, −60 dB
     *  and quieter read as silence (the reference's `levelFromMetering`). */
    fun level(amplitude: Int): Double {
      if (amplitude <= 0) return 0.0
      val decibels = 20.0 * log10(amplitude / 32767.0)
      return if (decibels.isFinite()) ((decibels + 60.0) / 60.0).coerceIn(0.0, 1.0) else 0.0
    }

    /** 128 kbit/s is 16 bytes a millisecond; a file under an eighth of that is not the take. */
    fun tiny(durationMs: Long, bytes: Long): Boolean = durationMs >= 1000 && bytes < durationMs * 16 / 8
  }
}
