package com.linea.messenger

import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.chatactions.ChatForward
import com.linea.messenger.core.Core
import com.linea.messenger.video.BigFiles
import com.linea.messenger.video.ChunkCore
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Forwarding a big file (a long video, a round video, a file over 20 MB — the chunked scheme): it used to be
 *  refused with «Большие файлы пока нельзя открыть…» because the forward went only the small-file road. Now the
 *  file is taken down chunk by chunk, opened, and goes up again under a NEW key; the recipient's copy opens with
 *  the new key only. The transfers are stood in for by the core's own chunk sealing (no server here); the rest is
 *  the app's very code (`ChatForward.copiedBig`) and the real core through JNI. Skipped without the host core. */
class ForwardCopyJniTest {
  private fun pattern(size: Int) = ByteArray(size) { (it * 13 + (it shr 9) * 7 + 5).toByte() }

  /** The chunks of a file sealed under `encryption`, as the server would hold them. */
  private fun sealAll(plain: ByteArray, encryption: Map<String, Any?>): List<ByteArray> {
    val size = plain.size.toLong()
    val count = (Core.map(FileCore.call("chunks", listOf(size)))!!["count"] as Number).toLong()
    return (0 until count).map { index ->
      val place = ChunkCore.chunk(size, index)!!
      val start = (index * ChunkCore.CHUNK).toInt()
      ChunkCore.seal(plain.copyOfRange(start, start + place.plain), encryption, index, size).getOrThrow()
    }
  }

  private fun openAll(chunks: List<ByteArray>, attachment: Map<String, Any?>): Result<ByteArray> {
    val message = Core.text(attachment - "preview")!!
    val out = java.io.ByteArrayOutputStream()
    for ((index, chunk) in chunks.withIndex()) {
      val plain = ChunkCore.open(chunk, message, index.toLong())
      out.write(plain.getOrElse { return Result.failure(it) })
    }
    return Result.success(out.toByteArray())
  }

  private fun forward(name: String, type: String, media: Map<String, Any?>?, preview: Map<String, Any?>?) {
    val size = ChunkCore.CHUNK.toInt() * 2 + 1234
    val plain = pattern(size)
    val first = Core.map(FileCore.call("newChunkedEncryption"))!!
    val held = sealAll(plain, first)
    val original = Core.map(FileCore.call("attachment", listOf("0f8fad5b-d9cb-469f-a165-70867728950e", name, type, size, first, media, preview)))!!
    assertTrue(ChunkCore.isChunked(original))
    // The old road: the small-file description refuses a chunked file — that refusal is what the person saw.
    assertEquals("Большие файлы пока нельзя открыть в этой версии приложения.", FileCore.describe(original).refusal)

    val cache = Files.createTempDirectory("forward-test").toFile()
    var uploadedChunks: List<ByteArray> = emptyList()
    var wentAsVideo: Boolean? = null
    var seenFolder: File? = null
    val made = ChatForward.copiedBig(original, cache,
      download = { file ->
        seenFolder = file.parentFile
        assertTrue(file.parentFile!!.name.matches(DecryptedFiles.folderName))
        openAll(held, original).map { bytes -> file.writeBytes(bytes) }
      },
      upload = { file, video ->
        wentAsVideo = video
        val second = Core.map(FileCore.call("newChunkedEncryption"))!!
        uploadedChunks = sealAll(file.readBytes(), second)
        Result.success(BigFiles.Uploaded("7c9e6679-7425-40de-944b-e07fc1f90ae7", second, file.length()))
      }).getOrThrow()

    // The opened copy is gone at once.
    assertFalse(seenFolder!!.exists())
    assertEquals(0, cache.listFiles()!!.size)
    cache.deleteRecursively()
    assertEquals(type.startsWith("video/"), wentAsVideo)
    // A new file under a new key, with the first one's name, type, media and preview.
    assertEquals("7c9e6679-7425-40de-944b-e07fc1f90ae7", made["id"])
    assertEquals(listOf(name, type, size.toDouble()), listOf(made["name"], made["mimeType"], made["size"]))
    assertNotEquals(Core.map(original["encryption"])!!["key"], Core.map(made["encryption"])!!["key"])
    assertNotEquals(Core.map(original["encryption"])!!["fileKeyId"], Core.map(made["encryption"])!!["fileKeyId"])
    assertEquals(original["media"], made["media"])
    assertEquals(original["preview"], made["preview"])
    assertTrue(ChunkCore.isChunked(made))
    // The recipient opens it with the key of the new message, and only with it.
    assertArrayEquals(plain, openAll(uploadedChunks, made).getOrThrow())
    assertTrue(openAll(uploadedChunks, original).isFailure)
  }

  @Test fun aBigVideoIsForwardedUnderANewKey() {
    assumeTrue(Core.loaded)
    forward("video.mp4", "video/mp4", mapOf("width" to 1280, "height" to 720, "durationMs" to 61000, "hdr" to "sdr"), null)
  }

  @Test fun aRoundVideoIsForwardedAsAVideo() {
    assumeTrue(Core.loaded)
    forward("circle-1700000000000.mp4", "video/mp4", mapOf("width" to 384, "height" to 384, "durationMs" to 9000), null)
  }

  @Test fun aBigFileIsForwardedUnderTheFileLimit() {
    assumeTrue(Core.loaded)
    forward("отчёт.pdf", "application/pdf", null, null)
  }

  @Test fun aFailedTransferLeavesNothingAndSaysWhy() {
    assumeTrue(Core.loaded)
    val encryption = Core.map(FileCore.call("newChunkedEncryption"))!!
    val original = Core.map(FileCore.call("attachment", listOf("0f8fad5b-d9cb-469f-a165-70867728950e", "video.mp4", "video/mp4", 5_000_000, encryption, null, null)))!!
    val cache = Files.createTempDirectory("forward-test").toFile()
    val refused = ChatForward.copiedBig(original, cache,
      download = { file -> file.writeBytes(ByteArray(10)); Result.success(Unit) },
      upload = { _, _ -> Result.failure(FileCore.Failure("Видео больше 100 МБ.")) })
    assertEquals("Видео больше 100 МБ.", (refused.exceptionOrNull() as FileCore.Failure).words)
    val lost = ChatForward.copiedBig(original, cache,
      download = { _ -> Result.failure(FileCore.Failure("Файл недоступен.")) },
      upload = { _, _ -> throw AssertionError("nothing goes up after a failed download") })
    assertEquals("Файл недоступен.", (lost.exceptionOrNull() as FileCore.Failure).words)
    assertEquals(0, cache.listFiles()!!.size)
    cache.deleteRecursively()
  }

  @Test fun whichLimitAForwardGoesUnder() {
    assertTrue(ChatForward.isVideo("video/mp4"))
    assertTrue(ChatForward.isVideo("Video/QuickTime"))
    assertFalse(ChatForward.isVideo("application/octet-stream"))
    assertFalse(ChatForward.isVideo("audio/mp4"))
  }
}
