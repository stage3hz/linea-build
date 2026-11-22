package com.linea.messenger

import com.linea.messenger.attachments.AttachmentRows
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.core.Core
import com.linea.messenger.video.ChunkCore
import com.linea.messenger.voice.WaveBars
import com.linea.messenger.voice.MediaRows
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Big files, voice messages and round videos: Kotlin ↔ the core through JNI, for real — the very functions the
 *  app calls on a phone (`ChunkCore.fileSealChunk` / `fileOpenChunk` and the by-name ones of `FileCore.fileCall`),
 *  in the core built for this machine (native/android/build-core-host.sh). Skipped when that library has not
 *  been built. The same is asked of the iPhone's side in native/core/tests/e2ee_files.rs. */
class MediaCoreJniTest {
  private fun pattern(size: Int, start: Int) = ByteArray(size) { (it * 31 + (it shr 8) * 17 + start).toByte() }

  @Test fun aBigFileIsSealedAndOpenedChunkByChunk() {
    assumeTrue(Core.loaded)
    val encryption = Core.map(FileCore.call("newChunkedEncryption"))!!
    assertEquals(listOf(ChunkCore.SCHEME, ChunkCore.CHUNK.toDouble()), listOf(encryption["scheme"], encryption["chunkSize"]))
    assertNotEquals(encryption["key"], Core.map(FileCore.call("newChunkedEncryption"))!!["key"])
    val size = ChunkCore.CHUNK + 1000
    assertEquals(mapOf("count" to 2.0, "chunkSize" to 4194304.0, "cipherSize" to 4195336.0), FileCore.call("chunks", listOf(size)))
    val first = ChunkCore.chunk(size, 0)!!; val second = ChunkCore.chunk(size, 1)!!
    assertEquals(listOf(0L, 4194319L, 4194304L), listOf(first.start, first.end, first.plain.toLong()))
    assertEquals(listOf(4194320L, 4195335L, 1000L), listOf(second.start, second.end, second.plain.toLong()))
    assertNull(ChunkCore.chunk(size, 2))
    // Where an upload goes on once the server holds this many bytes.
    assertEquals(listOf(0.0, 1.0), listOf(FileCore.call("chunkAfter", listOf(0)), FileCore.call("chunkAfter", listOf(4194320))))

    val plain = pattern(size.toInt(), 11)
    val one = ChunkCore.seal(plain.copyOfRange(0, first.plain), encryption, 0, size).getOrThrow()
    val two = ChunkCore.seal(plain.copyOfRange(first.plain, plain.size), encryption, 1, size).getOrThrow()
    assertEquals(listOf(first.plain + 16, second.plain + 16), listOf(one.size, two.size))
    // The object that travels inside the message; the app chooses the road by its scheme.
    val attachment = Core.map(FileCore.call("attachment", listOf("0f8fad5b-d9cb-469f-a165-70867728950e", "video.mp4", "video/mp4", size, encryption,
      mapOf("width" to 1280, "height" to 720, "durationMs" to 4000, "hdr" to "sdr"), null)))!!
    assertTrue(ChunkCore.isChunked(attachment))
    assertFalse(ChunkCore.isChunked(mapOf("encryption" to mapOf("scheme" to "aes-256-gcm-siv"))))
    assertEquals(mapOf("size" to size.toDouble(), "count" to 2.0, "cipherSize" to 4195336.0, "refusal" to null), FileCore.call("chunked", listOf(attachment)))
    assertEquals("video", MediaRows.kind(attachment))
    // The small-file road still refuses it; the row is a video's all the same.
    assertNotEquals(null, FileCore.describe(attachment).refusal)
    assertEquals(mapOf("text" to "", "fmt" to emptyList<Int>(), "urls" to emptyList<String>(), "media" to "video", "mediaTime" to "0:04", "thumbWide" to 1280.0 / 720.0),
      AttachmentRows.fields(mapOf("text" to "", "attachment" to attachment), "peer:big"))

    val message = Core.text(attachment)!!
    assertArrayEquals(plain.copyOfRange(0, first.plain), ChunkCore.open(one, message, 0).getOrThrow())
    assertArrayEquals(plain.copyOfRange(first.plain, plain.size), ChunkCore.open(two, message, 1).getOrThrow())
    // A chunk from another place, a chunk of another size and a chunk with one changed byte are never given out.
    fun refused(result: Result<ByteArray>): String = (result.exceptionOrNull() as FileCore.Failure).words
    assertTrue(refused(ChunkCore.open(one, message, 1)).isNotEmpty())
    assertTrue(refused(ChunkCore.open(two, message, 0)).isNotEmpty())
    val changed = one.copyOf().also { it[5] = (it[5].toInt() xor 1).toByte() }
    assertTrue(refused(ChunkCore.open(changed, message, 0)).isNotEmpty())
    assertTrue(refused(ChunkCore.open(one, "{}", 0)).isNotEmpty())
    assertTrue(refused(ChunkCore.open(one, message, -1)).isNotEmpty())
    // A chunk that is not the one its place asks for is not sealed.
    assertTrue(refused(ChunkCore.seal(ByteArray(10), encryption, 0, size)).isNotEmpty())
    assertTrue(refused(ChunkCore.seal(ByteArray(10), encryption, -1, 10)).isNotEmpty())
    assertEquals(16 + 10, ChunkCore.seal(ByteArray(10), encryption, 0, 10).getOrThrow().size)
  }

  @Test fun voiceMessagesAndRoundVideosAreNamedAndDrawnByTheCore() {
    assumeTrue(Core.loaded)
    assertEquals(listOf("0:23", "0:04,63"), listOf(FileCore.call("voiceTime", listOf(23000)), FileCore.call("voiceTimeFine", listOf(4630L))))
    assertEquals("voice-1795244400000.m4a", FileCore.call("voiceName", listOf(1795244400000L)))
    assertEquals("circle-1795244400000.mp4", FileCore.call("noteName", listOf(1795244400000L)))
    assertEquals(listOf("voice", "note", "audio", "video", "file"), listOf(
      mapOf("name" to "voice-1795244400000.m4a", "mimeType" to "audio/mp4"), mapOf("name" to "circle-1795244400000.mp4", "mimeType" to "video/mp4"),
      mapOf("name" to "song.m4a", "mimeType" to "audio/mp4"), mapOf("name" to "video.mp4", "mimeType" to "video/mp4"), mapOf("name" to "a.pdf", "mimeType" to "application/pdf"),
    ).map { MediaRows.kind(it) })
    val rules = Core.map(FileCore.call("recordRules"))!!
    assertEquals(listOf("audio/mp4", "video/mp4", 500.0, 64800000.0, 60000.0), listOf(rules["voiceMime"], rules["noteMime"], rules["voiceMinMs"], rules["voiceMaxMs"], rules["noteMaxMs"]))

    // A take's levels become the letters of its waveform; silence and a take too short to draw have none.
    val levels = List(40) { if (it % 2 == 0) 0.9 else 0.1 }
    val waveform = FileCore.call("waveform", listOf(levels)) as String
    assertTrue(waveform, waveform.length == 100 && waveform.all { it in 'A'..'Z' || it in 'a'..'f' } && waveform.toSet().size > 1)
    assertNull(FileCore.call("waveform", listOf(listOf(0, 0, 0, 0, 0))))
    assertNull(FileCore.call("waveform", listOf(listOf(0.9, 0.9))))
    // The bars a row draws: the waveform fitted to the row's width; a message without one shows even low bars.
    assertArrayEquals(floatArrayOf(0f, 0f, 0f, 0f, 1f, 1f, 1f, 1f), WaveBars.bars("AAAAffff", 58), 0f)
    assertArrayEquals(FloatArray(12) { 0.12f }, WaveBars.bars("", 10), 0f)
    assertEquals(40, WaveBars.bars(waveform, 40).size)

    // The rows of received messages, by the core's own word.
    val voice = mapOf("id" to "f1", "name" to "voice-1795244400000.m4a", "mimeType" to "audio/mp4", "size" to 40000.0, "media" to mapOf("durationMs" to 65000.0, "waveform" to waveform))
    assertEquals(mapOf("text" to "", "fmt" to emptyList<Int>(), "urls" to emptyList<String>(), "media" to "voice", "mediaTime" to "1:05", "wave" to waveform),
      AttachmentRows.fields(mapOf("text" to "", "attachment" to voice), "peer:v1"))
    val note = mapOf("id" to "f2", "name" to "circle-1795244400000.mp4", "mimeType" to "video/mp4", "size" to 900000.0, "media" to mapOf("durationMs" to 12000.0, "width" to 480.0, "height" to 640.0))
    assertEquals(mapOf("media" to "note", "mediaTime" to "0:12", "thumbWide" to 1.0, "thumbRound" to true), AttachmentRows.fields(mapOf("text" to "x", "attachment" to note), "peer:n1"))
    // An ordinary sound file stays a file (a file card: attachments/InlineMedia.kt).
    assertEquals("song.m4a\n" + FileCore.sizeText(40000) + " · M4A", AttachmentRows.fields(mapOf("text" to "x", "attachment" to mapOf("name" to "song.m4a", "mimeType" to "audio/mp4", "size" to 40000.0)), "peer:a1")["label"])
  }
}
