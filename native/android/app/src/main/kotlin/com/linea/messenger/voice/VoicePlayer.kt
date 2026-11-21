package com.linea.messenger.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.FileTransfer
import com.linea.messenger.attachments.downloadSealedFile
import com.linea.messenger.core.Core
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.net.Server
import com.linea.messenger.video.BigFiles
import com.linea.messenger.video.BigTransfer
import com.linea.messenger.video.ChunkCore
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** Brings one attachment for playing: downloads the sealed bytes, has the core check and open them (a small file
 *  at once, a big one chunk by chunk) and leaves the decrypted file in the app's private cache
 *  (`invizent-view-…`, swept at the next start of a chat). The caller removes the folder when it is done. */
class MediaFetch {
  class Brought(val folder: File, val file: File)

  private val main = Handler(Looper.getMainLooper())
  private val small = FileTransfer()
  private val big = BigTransfer()
  @Volatile private var stopped = false

  fun cancel() {
    stopped = true
    small.cancel()
    big.cancel()
  }

  /** `progress`: 0…1 on the main thread. `done`: on the main thread, never after `cancel()`. A failure is a
   *  `FileCore.Failure`. */
  fun start(context: Context, server: Server, attachment: Map<String, Any?>, progress: (Double) -> Unit, done: (Result<Brought>) -> Unit) {
    val about = FileCore.describe(attachment)
    val folder = File(context.cacheDir, DecryptedFiles.prefix + UUID.randomUUID().toString().lowercase())
    // The core's safe name has no path in it; a name that would leave the folder is not used all the same.
    val name = about.fileName.takeIf { it.isNotEmpty() && it != "." && it != ".." && !it.contains('/') && !it.contains('\u0000') } ?: "file"
    val file = File(folder, name)
    val chunked = ChunkCore.isChunked(attachment)
    var last = -1
    val report: (Long, Long) -> Unit = { got, all ->
      val percent = if (all > 0) (got * 100 / all).toInt() else 0
      main.post {
        if (!stopped && percent != last) {
          last = percent
          progress(percent / 100.0)
        }
      }
    }
    small.onProgress = report
    work.execute {
      var result: Result<Brought> = Result.failure(FileCore.Failure("Не удалось загрузить зашифрованный файл."))
      try {
        if (!folder.mkdirs()) throw IllegalStateException("folder")
        val id = attachment["id"] as? String
        val cipherSize = about.cipherSize
        if (chunked) {
          result = BigFiles.download(server, attachment, file, big, report).map { Brought(folder, file) }
        } else if (about.refusal != null) {
          result = Result.failure(FileCore.Failure(about.refusal))
        } else if (id != null && cipherSize != null) {
          val sealed = server.downloadSealedFile(id, cipherSize, small)
          result = sealed.fold(
            onSuccess = { bytes -> FileCore.open(bytes, attachment).map { plain -> file.outputStream().use { it.write(plain) }; Brought(folder, file) } },
            onFailure = { failure -> Result.failure(FileCore.Failure(FileTransfer.words(failure, proof = "Не удалось загрузить зашифрованный файл."))) },
          )
        }
      } catch (_: Exception) {
        result = Result.failure(FileCore.Failure("Не удалось открыть файл."))
      }
      if (result.isFailure || stopped) folder.deleteRecursively()
      main.post {
        if (stopped) folder.deleteRecursively() else done(result)
      }
    }
  }

  private companion object {
    val work = Executors.newCachedThreadPool { run -> Thread(run, "invizent.media.fetch").apply { isDaemon = true } }
  }
}

/** The player of one chat's voice messages: one at a time; starting one stops the previous one and the music.
 *  Reference: mobile/src/voice/VoiceMessage.tsx (`VoicePlaybackProvider`): the speed goes 1× → 1,5× → 2× and is
 *  kept for the session; a tap on the waveform of the playing message seeks; leaving the chat stops the sound and
 *  deletes the decrypted copies. */
class VoicePlayer(private val context: Context, private val server: Server?) {
  private val main = Handler(Looper.getMainLooper())
  private var player: MediaPlayer? = null
  private var activeKey = ""
  private var totalMs = 0
  private var loading: MediaFetch? = null
  private val files = LinkedHashMap<String, MediaFetch.Brought>()
  private var ticking = false
  private var focus: AudioFocusRequest? = null
  /** What the list must show for the active row (null: nothing is active). */
  var onState: ((MsgMediaState?) -> Unit)? = null
  var onProblem: ((String) -> Unit)? = null
  /** A voice message is about to sound: whatever else sounds in the chat goes quiet. */
  var onWillPlay: (() -> Unit)? = null
  val isPlaying: Boolean get() = try { player?.isPlaying ?: false } catch (_: IllegalStateException) { false }

  private val ticker = object : Runnable {
    override fun run() {
      if (!ticking) return
      publish()
      main.postDelayed(this, 100)
    }
  }

  private fun publish() {
    if (activeKey.isEmpty()) {
      onState?.invoke(null)
      return
    }
    val player = player
    if (player == null) {
      onState?.invoke(MsgMediaState(key = activeKey, loading = loading != null, rate = rateLabel))
      return
    }
    val length = try { player.duration } catch (_: IllegalStateException) { -1 }
    val position = try { player.currentPosition } catch (_: IllegalStateException) { 0 }
    onState?.invoke(state(activeKey, loading != null, isPlaying, position, if (length > 0) length else totalMs, rateLabel, ::time))
  }

  private fun tick(on: Boolean) {
    main.removeCallbacks(ticker)
    ticking = on
    if (on) main.postDelayed(ticker, 100)
  }

  /** The play button of a row: starts this message, or pauses and continues it when it is the active one. */
  fun toggle(key: String, attachment: Map<String, Any?>) {
    val current = player
    if (key == activeKey && loading == null && current != null) {
      if (isPlaying) {
        try { current.pause() } catch (_: IllegalStateException) {}
        tick(false)
      } else {
        begin()
      }
      publish()
      return
    }
    halt()
    activeKey = key
    totalMs = (Core.map(attachment["media"] as? Map<*, *>)?.get("durationMs") as? Number)?.toInt() ?: 0
    files[key]?.let { return play(it.file) }
    val server = server ?: return
    val fetch = MediaFetch()
    loading = fetch
    publish()
    fetch.start(context, server, attachment, progress = { }, done = { result ->
      if (loading !== fetch) {
        result.getOrNull()?.let { it.folder.deleteRecursively() }
        return@start
      }
      loading = null
      val brought = result.getOrNull()
      if (brought == null) {
        activeKey = ""
        publish()
        onProblem?.invoke(FileCore.words(result))
        return@start
      }
      // No more than a dozen decrypted voice messages are kept per open chat.
      if (files.size >= 12) files.keys.firstOrNull { it != key }?.let { old -> files.remove(old)?.folder?.deleteRecursively() }
      files[key] = brought
      play(brought.file)
    })
  }

  private fun play(file: File) {
    val made = MediaPlayer()
    try {
      made.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      made.setDataSource(file.absolutePath)
      made.prepare()
    } catch (_: Exception) {
      try { made.release() } catch (_: Exception) {}
      activeKey = ""
      publish()
      onProblem?.invoke("Не удалось воспроизвести голосовое.")
      return
    }
    made.setOnCompletionListener { ended ->
      if (ended !== player) return@setOnCompletionListener
      try { ended.seekTo(0) } catch (_: IllegalStateException) {}
      tick(false)
      quietFocus()
      publish()
    }
    made.setOnErrorListener { failed, _, _ ->
      if (failed === player) stop()
      true
    }
    player = made
    begin()
    publish()
  }

  private fun begin() {
    val player = player ?: return
    onWillPlay?.invoke()
    if (MusicPlayer.shared.current != null) MusicPlayer.shared.stop()
    takeFocus()
    try {
      player.start()
      // The speed is set on a player that already plays: on one that waits, the system would start it by itself.
      if (rate != 1f) player.playbackParams = player.playbackParams.setSpeed(rate)
    } catch (_: Exception) { /* the player is gone: the ticker shows it stopped */ }
    tick(true)
  }

  /** A tap on the waveform: the active message jumps there; any other message starts playing. */
  fun seek(key: String, fraction: Float): Boolean {
    val player = player ?: return false
    if (key != activeKey) return false
    val length = try { player.duration } catch (_: IllegalStateException) { -1 }
    if (length <= 0) return false
    try { player.seekTo((fraction.coerceIn(0f, 1f) * length).toInt()) } catch (_: IllegalStateException) { return false }
    publish()
    return true
  }

  /** The speed chip: 1× → 1,5× → 2× → 1×. Gives the words that say what was chosen. */
  fun cycleRate(): String {
    val next = nextRate(rate)
    rate = next
    val player = player
    if (player != null && isPlaying) try { player.playbackParams = player.playbackParams.setSpeed(next) } catch (_: Exception) {}
    publish()
    return rateWords(next)
  }

  /** Pauses without forgetting the message (something else is about to sound). */
  fun pause() {
    val player = player ?: return
    if (!isPlaying) return
    try { player.pause() } catch (_: IllegalStateException) {}
    tick(false)
    publish()
  }

  private fun halt() {
    loading?.cancel()
    loading = null
    player?.let { old ->
      old.setOnCompletionListener(null)
      try { old.stop() } catch (_: Exception) {}
      try { old.release() } catch (_: Exception) {}
    }
    player = null
    tick(false)
    quietFocus()
  }

  /** Stops and forgets the active message. */
  fun stop() {
    halt()
    activeKey = ""
    publish()
  }

  /** The chat is left: the sound stops, the decrypted copies go. */
  fun left() {
    stop()
    for (file in files.values) file.folder.deleteRecursively()
    files.clear()
  }

  // The other sounds of the phone make room while a voice message plays, and it makes room for a call.

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) main.post { pause() }
  }

  private fun takeFocus() {
    if (focus != null) return
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setOnAudioFocusChangeListener(focusListener, main).build()
    try { manager.requestAudioFocus(request); focus = request } catch (_: Exception) {}
  }

  private fun quietFocus() {
    val request = focus ?: return
    focus = null
    try { (context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.abandonAudioFocusRequest(request) } catch (_: Exception) {}
  }

  companion object {
    /** The speed of voice and round video messages, kept until the app is closed. */
    var rate = 1f
    val rateLabel: String get() = rateLabel(rate)

    fun rateLabel(rate: Float): String = if (rate == 1.5f) "1,5×" else if (rate == 2f) "2×" else "1×"
    fun nextRate(rate: Float): Float = if (rate == 1f) 1.5f else if (rate == 1.5f) 2f else 1f
    fun rateWords(rate: Float): String =
      if (rate == 1f) "Звук будет проигрываться с обычной скоростью." else "Звук будет проигрываться в " + (if (rate == 1.5f) "1,5" else "2") + " раза быстрее."

    private fun time(ms: Int): String = FileCore.call("voiceTime", listOf(maxOf(0, ms))) as? String ?: ""

    /** What the active row shows for a player at `position` of `total` ms (the rule alone, for the checks). */
    fun state(key: String, loading: Boolean, playing: Boolean, position: Int, total: Int, rate: String, time: (Int) -> String): MsgMediaState = MsgMediaState(
      key = key, playing = playing, loading = loading,
      progress = if (total > 0) minOf(1f, position.toFloat() / total) else 0f,
      time = if (position > 0) time(position) + " / " + time(total) else time(total),
      rate = rate,
    )
  }
}
