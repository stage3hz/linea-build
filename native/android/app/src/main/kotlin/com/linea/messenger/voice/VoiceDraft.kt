package com.linea.messenger.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import com.linea.messenger.attachments.FileCore
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.Executors

/** A stopped voice take waiting in the composer (owner's spec): played, trimmed, recorded on («record more» adds a
 *  part after it), then sent or thrown away. The parts stay files in the app's cache until it is sent; then they are
 *  joined and cut to the kept part into one .m4a (the AAC samples copied as they are, nothing re-encoded), which goes
 *  the way of any voice message: sealed with a fresh key and uploaded. The iPhone's Sources/Voice/VoiceDraft.swift. */
class VoiceDraft(private val context: Context) {
  private val main = Handler(Looper.getMainLooper())
  private val work = Executors.newSingleThreadExecutor()
  val parts = ArrayList<VoiceRecorder.Take>()
  var trimStart = 0.0
  var trimEnd = 1.0
  private var joined: File? = null
  private var player: MediaPlayer? = null
  /** Main thread: where playing is (a fraction of the whole draft) and whether it plays. */
  var onPlayback: ((Double, Boolean) -> Unit)? = null

  val durationMs: Long get() = parts.fold(0L) { sum, part -> sum + part.durationMs }
  val levels: List<Double> get() = parts.flatMap { it.levels }
  val isEmpty: Boolean get() = parts.isEmpty()
  val isPlaying: Boolean get() = try { player?.isPlaying == true } catch (_: Exception) { false }

  fun add(take: VoiceRecorder.Take) {
    stopPlaying()
    releasePlayer()
    parts.add(take)
    trimStart = 0.0; trimEnd = 1.0
  }

  fun discard() {
    stopPlaying()
    releasePlayer()
    for (part in parts) part.file.delete()
    parts.clear()
  }

  private fun releasePlayer() {
    main.removeCallbacks(ticker)
    try { player?.release() } catch (_: Exception) {}
    player = null
    joined?.let { file -> if (parts.none { it.file == file }) file.delete() }
    joined = null
  }

  private val ticker = object : Runnable {
    override fun run() {
      val made = player ?: return
      val fraction = currentFraction
      if (isPlaying && fraction >= trimEnd) { reachedEnd(); return }
      onPlayback?.invoke(fraction, isPlaying)
      if (isPlaying) main.postDelayed(this, 33)
    }
  }

  val currentFraction: Double get() {
    val made = player ?: return trimStart
    val total = maxOf(1L, durationMs).toDouble()
    return try { made.currentPosition / total } catch (_: Exception) { trimStart }
  }

  private fun prepared(): MediaPlayer? {
    player?.let { return it }
    val file = if (parts.size == 1) parts[0].file else {
      val target = File(context.cacheDir, VoiceRecorder.filePrefix + UUID.randomUUID().toString().lowercase() + ".m4a")
      if (!copy(parts.map { it.file }, target, 0L, Long.MAX_VALUE)) { target.delete(); return null }
      joined = target
      target
    }
    return try {
      MediaPlayer().apply {
        setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        setDataSource(file.absolutePath)
        prepare()
        setOnCompletionListener { reachedEnd() }
      }.also { player = it }
    } catch (_: Exception) { null }
  }

  private fun reachedEnd() {
    try { player?.pause() } catch (_: Exception) {}
    seek(trimStart)
    onPlayback?.invoke(trimStart, false)
  }

  fun toggle() {
    val made = prepared() ?: return
    if (isPlaying) {
      try { made.pause() } catch (_: Exception) {}
      onPlayback?.invoke(currentFraction, false)
      return
    }
    val at = currentFraction
    if (at < trimStart || at >= trimEnd - 0.001) seek(trimStart)
    try { made.start() } catch (_: Exception) { return }
    main.removeCallbacks(ticker)
    main.post(ticker)
  }

  fun seek(fraction: Double) {
    val made = prepared() ?: return
    try { made.seekTo((fraction * durationMs).toLong(), MediaPlayer.SEEK_CLOSEST) } catch (_: Exception) {}
    onPlayback?.invoke(fraction, isPlaying)
  }

  /** While a handle moves, playing stops; let go, the draft plays from the new start (or a second before the end). */
  fun trimmed(start: Double, end: Double, endMoved: Boolean, done: Boolean) {
    trimStart = start; trimEnd = end
    try { player?.pause() } catch (_: Exception) {}
    if (!done) { onPlayback?.invoke(currentFraction, false); return }
    val from = if (endMoved) maxOf(start, end - 1000.0 / maxOf(1L, durationMs)) else start
    seek(from)
    try { prepared()?.start() } catch (_: Exception) {}
    main.removeCallbacks(ticker)
    main.post(ticker)
  }

  fun stopPlaying() {
    try { if (isPlaying) player?.pause() } catch (_: Exception) {}
    main.removeCallbacks(ticker)
  }

  /** The single file to send (main thread): the parts joined and cut to the kept part, its waveform, its length. */
  fun build(done: (File?, Long, String?) -> Unit) {
    stopPlaying()
    releasePlayer()
    val total = durationMs
    val all = levels
    val from = (all.size * trimStart).toInt().coerceIn(0, all.size)
    val to = Math.ceil(all.size * trimEnd).toInt().coerceIn(from, all.size)
    val waveform = FileCore.call("waveform", listOf(all.subList(from, to))) as? String
    val trimmed = trimStart > 0.0005 || trimEnd < 0.9995
    val sources = parts.map { it.file }
    if (sources.size == 1 && !trimmed) {
      val only = parts[0]
      parts.clear()
      done(only.file, total, waveform ?: only.waveform)
      return
    }
    parts.clear()
    val fromUs = (total * trimStart * 1000).toLong()
    val toUs = (total * trimEnd * 1000).toLong()
    val keptMs = (total * (trimEnd - trimStart)).toLong()
    val target = File(context.cacheDir, VoiceRecorder.filePrefix + UUID.randomUUID().toString().lowercase() + ".m4a")
    work.execute {
      val ok = copy(sources, target, fromUs, toUs)
      for (source in sources) source.delete()
      main.post {
        if (ok) done(target, keptMs, waveform) else { target.delete(); done(null, 0, null) }
      }
    }
  }

  companion object {
    /** Copies the audio samples of `sources`, one after another, between `fromUs` and `toUs` of the whole, into an
     *  MPEG-4 file. False when it could not. */
    fun copy(sources: List<File>, target: File, fromUs: Long, toUs: Long): Boolean {
      var muxer: MediaMuxer? = null
      return try {
        var track = -1
        var offset = 0L
        val buffer = ByteBuffer.allocate(1 shl 20)
        val info = MediaCodec.BufferInfo()
        for (source in sources) {
          val extractor = MediaExtractor()
          try {
            extractor.setDataSource(source.absolutePath)
            var index = -1
            for (i in 0 until extractor.trackCount) if ((extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) { index = i; break }
            if (index < 0) continue
            val format = extractor.getTrackFormat(index)
            if (muxer == null) {
              muxer = MediaMuxer(target.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
              track = muxer!!.addTrack(format)
              muxer!!.start()
            }
            extractor.selectTrack(index)
            var last = 0L
            while (true) {
              val size = extractor.readSampleData(buffer, 0)
              if (size < 0) break
              val time = extractor.sampleTime
              last = time
              val whole = offset + time
              if (whole >= fromUs && whole <= toUs) {
                info.offset = 0
                info.size = size
                info.presentationTimeUs = whole - fromUs
                info.flags = if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
                muxer!!.writeSampleData(track, buffer, info)
              }
              if (whole > toUs) break
              extractor.advance()
            }
            offset += if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else last + 21_333L
          } finally {
            extractor.release()
          }
        }
        muxer?.stop()
        muxer != null
      } catch (_: Exception) {
        false
      } finally {
        try { muxer?.release() } catch (_: Exception) {}
      }
    }
  }
}
