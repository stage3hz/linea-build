package com.linea.messenger.video

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.PhotoPrepare
import com.linea.messenger.voice.VoiceRecorder
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.roundToLong

/** Gets a video ready to leave the phone: it is written anew as an MP4 with no metadata — no place, no camera
 *  model, no dates, not the original name — and a small picture of it is made for the row.
 *
 *  Reference: mobile/src/media/pipeline.ts (`prepareVideo`: metadata removed, the result described by
 *  `media {width, height, durationMs, hdr}`), mobile/modules/linea-video/android (the cleaning itself, ported in
 *  VideoClean.kt: the picture's samples are copied, not encoded again; the sound is encoded anew) and
 *  mobile/src/media/thumbnail.ts (`makeThumbnail`: a frame at min(600 ms, a sixth of the length), then the small
 *  JPEG the core checks). */
object VideoPrepare {
  class Prepared(val file: File, val media: Map<String, Any?>, val preview: Map<String, Any?>?, val durationMs: Long)

  /** One preparation that can be stopped from another thread. */
  class Job {
    @Volatile var stopped = false
      private set
    fun cancel() { stopped = true }
  }

  const val failed = "Не удалось обработать видео. Файл не отправлен."
  const val filePrefix = "invizent-video-"
  /** One video at a time is written anew (as the reference does). */
  private val work = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.video.prepare").apply { isDaemon = true } }

  /** A new file of this app's own in its private cache (removed by the caller when the upload is over). */
  fun freshFile(context: Context, ending: String): File = File(context.cacheDir, filePrefix + UUID.randomUUID().toString().lowercase() + "." + ending)

  /** Removes recordings and prepared videos an interrupted app left behind `olderThanMs` ago or earlier. */
  fun sweep(context: Context, olderThanMs: Long, now: Long = System.currentTimeMillis()) {
    val files = context.cacheDir.listFiles { file -> file.isFile && (file.name.startsWith(filePrefix) || file.name.startsWith(VoiceRecorder.filePrefix)) } ?: return
    for (file in files) if (now - file.lastModified() > olderThanMs) file.delete()
  }

  /** Copies what the system's picker handed over into the app's own cache: the picker's permission to read it
   *  lasts only for a while. Null: it could not be read. Call on a background thread. */
  fun copy(context: Context, resolver: ContentResolver, uri: Uri, job: Job): File? {
    val target = freshFile(context, "bin")
    try {
      val input = resolver.openInputStream(uri) ?: return null
      var total = 0L
      input.use { source ->
        target.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            if (job.stopped) throw IllegalStateException("stopped")
            val count = source.read(buffer)
            if (count < 0) break
            total += count
            if (total > VideoPolicy.MAX_INPUT) throw IllegalStateException("too big")
            output.write(buffer, 0, count)
          }
        }
      }
      if (total == 0L) throw IllegalStateException("empty")
      return target
    } catch (_: Exception) {
      target.delete()
      return null
    }
  }

  /** The size a video is shown in: its picture's size turned as the track says. */
  fun shown(width: Int, height: Int, rotation: Int): Pair<Int, Int> = if (rotation == 90 || rotation == 270) Pair(height, width) else Pair(width, height)

  /** When the frame for the small picture is taken, ms: a little after the start (the very first one is often black). */
  fun previewAt(durationMs: Long): Long = if (durationMs > 0) minOf(600.0, durationMs / 6.0).roundToLong() else 400L

  /** The small picture of a video this app has just written. */
  private fun preview(file: File, durationMs: Long): Map<String, Any?>? {
    val retriever = MediaMetadataRetriever()
    var frame: Bitmap? = null
    return try {
      retriever.setDataSource(file.absolutePath)
      val at = previewAt(durationMs) * 1000
      frame = if (Build.VERSION.SDK_INT >= 27) retriever.getScaledFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 480, 480)
        else retriever.getFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
      frame?.let { PhotoPrepare.preview(it) }
    } catch (_: Throwable) {
      null
    } finally {
      frame?.recycle()
      try { retriever.release() } catch (_: Throwable) {}
    }
  }

  /** Writes the video at `source` anew, without metadata. `done` comes on a background thread; the source is
   *  not touched. A failure is a `FileCore.Failure` with the words for the person. */
  fun prepare(context: Context, source: File, job: Job, done: (Result<Prepared>) -> Unit) {
    val app = context.applicationContext
    work.execute {
      if (job.stopped) return@execute done(Result.failure(FileCore.Failure(BigFiles.cancelled)))
      val target = freshFile(app, "mp4")
      val scratch = freshFile(app, "m4a")
      val result: Result<Prepared> = try {
        val cleaned = VideoProcessor { job.stopped }.sanitize(source, target, scratch)
        // What the muxer itself wrote about the moment and the phone goes too; a file it cannot read is not sent.
        if (!Mp4Scrub.scrub(target)) throw VideoFailure("WRITE_FAILED")
        val size = shown(cleaned.width, cleaned.height, cleaned.rotation)
        val durationMs = (cleaned.durationUs / 1000.0).roundToLong()
        if (durationMs < 0 || durationMs > 86_400_000) throw VideoFailure("UNSUPPORTED_DURATION")
        val media = mapOf<String, Any?>("width" to size.first, "height" to size.second, "durationMs" to durationMs, "hdr" to cleaned.hdr)
        Result.success(Prepared(target, media, preview(target, durationMs), durationMs))
      } catch (failure: VideoFailure) {
        target.delete()
        Result.failure(FileCore.Failure(VideoPolicy.words(failure.reason)))
      } catch (_: Throwable) {
        target.delete()
        Result.failure(FileCore.Failure(failed))
      }
      done(result)
    }
  }
}
