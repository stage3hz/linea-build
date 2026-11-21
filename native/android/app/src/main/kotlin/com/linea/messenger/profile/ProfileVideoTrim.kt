package com.linea.messenger.profile

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer

/** A profile video is at most ten seconds (iOS Profile/ProfilePhotoChange.swift: the system's trimmer, 10 s): a video
 *  already written anew without metadata (video/VideoPrepare.kt) is cut to its first ten seconds by copying its samples
 *  into a new file — nothing is encoded again, so the picture stays as it was. A video that fits is left as it is. */
object ProfileVideoTrim {
  const val LIMIT_US = 10_000_000L

  /** The first `limitUs` of `source` in a new file next to it; `source` itself when it is short enough or cannot be cut. */
  fun firstSeconds(source: File, limitUs: Long = LIMIT_US): File {
    val extractor = MediaExtractor()
    var muxer: MediaMuxer? = null
    val target = File(source.parentFile, source.nameWithoutExtension + "-10s.mp4")
    try {
      extractor.setDataSource(source.absolutePath)
      var longest = 0L
      for (index in 0 until extractor.trackCount) longest = maxOf(longest, extractor.getTrackFormat(index).let { if (it.containsKey(android.media.MediaFormat.KEY_DURATION)) it.getLong(android.media.MediaFormat.KEY_DURATION) else 0L })
      if (longest in 1..(limitUs + 500_000)) return source
      val made = MediaMuxer(target.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      muxer = made
      val tracks = IntArray(extractor.trackCount) { index -> made.addTrack(extractor.getTrackFormat(index)) }
      made.start()
      val buffer = ByteBuffer.allocateDirect(8 * 1024 * 1024)
      val info = MediaCodec.BufferInfo()
      for (index in 0 until extractor.trackCount) {
        extractor.selectTrack(index)
        extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
        while (true) {
          buffer.clear()
          val size = extractor.readSampleData(buffer, 0)
          if (size < 0) break
          val time = extractor.sampleTime
          if (time > limitUs) break
          info.set(0, size, time, extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC)
          made.writeSampleData(tracks[index], buffer, info)
          extractor.advance()
        }
        extractor.unselectTrack(index)
      }
      made.stop()
      made.release()
      muxer = null
      // What the system's muxer writes about the moment and the phone goes again (video/VideoClean.kt, Mp4Scrub).
      if (!com.linea.messenger.video.Mp4Scrub.scrub(target)) { target.delete(); return source }
      return target
    } catch (_: Throwable) {
      target.delete()
      return source
    } finally {
      try { muxer?.release() } catch (_: Throwable) {}
      extractor.release()
    }
  }
}
