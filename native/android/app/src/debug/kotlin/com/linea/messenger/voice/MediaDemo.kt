package com.linea.messenger.voice

import android.content.Intent
import android.graphics.Bitmap
import android.util.Base64
import com.linea.messenger.attachments.AttachmentsDemo
import java.io.ByteArrayOutputStream
import kotlin.math.sin

/** Sample rows of voice messages, videos and round videos, and the launch arguments of the emulator check, as
 *  the iOS simulator check has them. This file is in the debug source set: a release build is compiled with the
 *  empty `MediaDemo` of src/release instead. All with `--ez demo true --ez chat true`:
 *    --es voicedemo 1           an incoming and an outgoing voice row, the first playing at 0:07 of 0:23 at 1,5×
 *    --es voicedemo recording   the same, and the strip of a take being recorded (0:04,63, the lock above it)
 *    --es videodemo 1           a video row and a round video row */
object MediaDemo {
  /** The debug build shows the microphone in the sample chat too (it records nothing there). */
  const val sample = true

  fun wave(seed: Int): String {
    val letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"
    val out = StringBuilder()
    for (index in 0 until 100) {
      val swell = sin((index + seed) / 7.0) * 0.5 + 0.5
      val ripple = sin(index * (3 + seed % 4) / 2.3) * 0.5 + 0.5
      out.append(letters[((swell * 0.65 + ripple * 0.35) * 31).toInt().coerceIn(0, 31)])
    }
    return out.toString()
  }

  private fun picture(width: Int, height: Int): String {
    val bytes = ByteArrayOutputStream().also { AttachmentsDemo.picture(width, height).compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
    return Base64.encodeToString(bytes, Base64.NO_WRAP)
  }

  /** The sample rows to stand after the sample chat's own; none unless asked for. */
  fun rows(intent: Intent?): List<Map<String, Any?>> {
    val rows = ArrayList<Map<String, Any?>>()
    if (intent?.getStringExtra("voicedemo") != null) {
      rows.add(mapOf("key" to "sample-voice-1", "kind" to 0, "mine" to false, "text" to "", "time" to "09:42", "tail" to true, "media" to "voice", "wave" to wave(3), "mediaTime" to "0:23"))
      rows.add(mapOf("key" to "sample-voice-2", "kind" to 0, "mine" to true, "text" to "", "time" to "09:43", "ticks" to 2, "tail" to true, "media" to "voice", "wave" to wave(11), "mediaTime" to "1:05"))
    }
    if (intent?.getStringExtra("videodemo") != null) {
      rows.add(mapOf("key" to "sample-video-1", "kind" to 0, "mine" to false, "text" to "", "time" to "09:44", "tail" to true, "media" to "video", "thumb" to picture(240, 135), "thumbWide" to 16.0 / 9.0, "mediaTime" to "0:42"))
      rows.add(mapOf("key" to "sample-video-2", "kind" to 0, "mine" to true, "text" to "", "time" to "09:45", "ticks" to 1, "tail" to true, "media" to "note", "thumb" to picture(212, 212), "thumbWide" to 1.0, "thumbRound" to true, "mediaTime" to "0:12"))
    }
    return rows
  }

  /** `voicedemo`: the first sample voice row as it looks while it plays. */
  fun state(intent: Intent?): MsgMediaState? {
    if (intent?.getStringExtra("voicedemo") == null) return null
    return MsgMediaState(key = "sample-voice-1", playing = true, progress = 7f / 23f, time = "0:07 / 0:23", rate = "1,5×")
  }

  /** `voicedemo recording`: the strip of a take being recorded is shown. */
  fun recording(intent: Intent?): Boolean = intent?.getStringExtra("voicedemo") == "recording"
}
