package com.linea.messenger

import com.linea.messenger.attachments.AttachmentRows
import com.linea.messenger.attachments.AttachmentStore
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.FileRules
import com.linea.messenger.attachments.PhotoPrepare
import com.linea.messenger.attachments.PhotoViewer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.Deflater

/** The rules of attachments that need no phone and no core, as the iPhone app has them (native/ios/Sources/Attachments). */
class AttachmentRulesTest {
  private fun about(kind: String, sizeText: String = "", refusal: String? = null) = { _: Map<String, Any?> -> FileCore.Description(kind, "file", sizeText, 100, refusal) }

  @Test fun howAMessageWithAnAttachmentLooks() {
    val preview = mapOf("mimeType" to "image/jpeg", "base64" to "QUJD", "width" to 240.0, "height" to 160.0)
    val photo = mapOf("id" to "f1", "name" to "photo.png", "mimeType" to "image/png", "size" to 1000.0, "preview" to preview)
    // Attachments: a photo is shown whole in its row (InlineMedia): its shape, its size for the pill, the small
    // picture to blur until it is here, and no words of its own.
    assertEquals(mapOf("text" to "", "fmt" to emptyList<Int>(), "urls" to emptyList<String>(), "media" to "photo", "thumbWide" to 1.5, "mediaTime" to "1 КБ", "thumb" to "QUJD"),
      AttachmentRows.fields(mapOf("text" to "", "attachment" to photo), "peer:c1", about("photo", "1 КБ")))
    assertEquals(photo, AttachmentStore.attachment("peer:c1"))
    // With words of its own the text stays as it is; the photo's own shape wins over the small picture's.
    assertEquals(mapOf("media" to "photo", "thumbWide" to 0.5, "mediaTime" to "", "thumb" to "QUJD"),
      AttachmentRows.fields(mapOf("text" to "Смотри", "attachment" to photo + ("media" to mapOf("width" to 600.0, "height" to 1200.0))), "peer:c2", about("photo")))
    // A photo that cannot be opened here is a label; one without a sound small picture is 4:3.
    assertEquals("🖼 Фотография\n1 КБ", AttachmentRows.fields(mapOf("text" to "x", "attachment" to photo), "k", about("photo", "1 КБ", refusal = "Нет ключа"))["label"])
    assertEquals(mapOf("media" to "photo", "thumbWide" to 4.0 / 3.0, "mediaTime" to ""), AttachmentRows.fields(mapOf("text" to "x", "attachment" to photo - "preview"), "k", about("photo")))
    assertEquals(4.0 / 3.0, AttachmentRows.fields(mapOf("text" to "x", "attachment" to photo + ("preview" to (preview + ("height" to 0.0)))), "k", about("photo"))["thumbWide"])
    assertEquals(mapOf("label" to "🎬 Видео\n3 ГБ"), AttachmentRows.fields(mapOf("text" to "x", "attachment" to mapOf("name" to "a.mp4")), "k", about("video", "3 ГБ")))
    // Any other file is a card: the name, then «1.2 МБ · PDF» (FileBubble).
    assertEquals(mapOf("media" to "file", "label" to "Договор № 7.pdf\n1.2 МБ · PDF"), AttachmentRows.fields(mapOf("text" to "x", "attachment" to mapOf("name" to "Договор № 7.pdf")), "k", about("file", "1.2 МБ")))
    assertEquals(mapOf("media" to "file", "label" to "Файл\n"), AttachmentRows.fields(mapOf("text" to "x", "attachment" to emptyMap<String, Any?>()), "k", about("audio")))
    // No attachment: nothing to add, nothing remembered.
    assertEquals(emptyMap<String, Any?>(), AttachmentRows.fields(mapOf("text" to "x"), "none", about("file")))
    assertEquals(emptyMap<String, Any?>(), AttachmentRows.fields(mapOf("text" to "x", "attachment" to "f1"), "none", about("file")))
    assertNull(AttachmentStore.attachment("none"))
  }

  @Test fun theRowOfAnAttachmentOnItsWayOut() {
    fun row(heading: String = "📎 a.pdf", note: String = "", thumb: String = "", failed: String? = null, uploading: Boolean = false) =
      ChatAttachments.pendingRow("attach-1", "09:41", heading, note, thumb, 1.5, failed, uploading)
    // A file: its name, then how much of it has gone.
    assertEquals(mapOf("key" to "attach-1", "kind" to 0, "mine" to true, "text" to "", "time" to "09:41", "ticks" to 3, "tail" to true, "label" to "📎 a.pdf"), row())
    assertEquals("📎 a.pdf\n1 МБ из 2 МБ", row(note = "1 МБ из 2 МБ", uploading = true)["label"])
    // A photo: the picture itself; the progress only while it is uploaded.
    val photo = row(heading = "🖼 Фотография", note = "1 МБ из 2 МБ", thumb = "QUJD", uploading = true)
    assertEquals(listOf("1 МБ из 2 МБ", "QUJD", 1.5), listOf(photo["label"], photo["thumb"], photo["thumbWide"]))
    assertEquals("", row(heading = "🖼 Фотография", note = "2 МБ", thumb = "QUJD")["label"])
    // What was not sent says so, in red (ticks 4), and offers to try again.
    val failed = row(note = "2 МБ", failed = "Нет связи с сервером.")
    assertEquals(listOf("Не отправлено · повторить\nНет связи с сервером.", 4), listOf(failed["label"], failed["ticks"]))
    assertNull(row()["thumb"])
  }

  @Test fun aVideoIsNotSentYet() {
    fun head(vararg bytes: Int) = ByteArray(bytes.size) { bytes[it].toByte() }
    val mp4 = head(0, 0, 0, 0x18) + "ftypmp42".toByteArray() + ByteArray(4)
    val webm = head(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4)
    val avi = "RIFF".toByteArray() + ByteArray(4) + "AVI LIST".toByteArray()
    val wav = "RIFF".toByteArray() + ByteArray(4) + "WAVEfmt ".toByteArray()
    val pdf = "%PDF-1.7\n%âãÏÓ\n1 0".toByteArray()
    assertTrue(FileRules.isVideo("video/mp4", pdf))
    assertTrue(FileRules.isVideo(null, mp4))
    assertTrue(FileRules.isVideo("application/octet-stream", mp4))
    // The same container with sound only is not a video.
    assertFalse(FileRules.isVideo("audio/mp4", mp4))
    assertTrue(FileRules.isVideo("audio/webm", webm))
    assertTrue(FileRules.isVideo(null, avi))
    assertFalse(FileRules.isVideo("audio/wav", wav))
    assertFalse(FileRules.isVideo("application/pdf", pdf))
    assertFalse(FileRules.isVideo(null, ByteArray(0)))
    assertFalse(FileRules.isVideo(null, head(0x1a, 0x45, 0xdf)))
  }

  @Test fun theSizeAPictureIsWorkedAt() {
    assertEquals(4000 to 3000, PhotoPrepare.fit(4000, 3000))
    // More than sixteen million pixels: scaled down to that, keeping its shape.
    val big = PhotoPrepare.fit(8000, 6000)!!
    assertTrue(big.first.toLong() * big.second <= 16_000_000 && big.first.toLong() * big.second > 15_900_000)
    assertEquals(8000.0 / 6000, big.first.toDouble() / big.second, 0.001)
    assertEquals(1 to 1, PhotoPrepare.fit(1, 1))
    assertEquals(20000 to 1, PhotoPrepare.fit(20000, 1))
    for ((width, height) in listOf(0 to 10, 10 to 0, -1 to 5, 20001 to 1, 1 to 20001, 10001 to 10000)) assertNull(PhotoPrepare.fit(width, height))
    assertEquals(10000 to 10000, PhotoPrepare.fit(10000, 10000, limit = 100_000_000))
    // What the viewer decodes for the screen: at most 4096 on the longer side.
    assertEquals(3000 to 2000, PhotoViewer.shownSize(3000, 2000))
    assertEquals(4096 to 3072, PhotoViewer.shownSize(8192, 6144))
    assertEquals(1 to 4096, PhotoViewer.shownSize(2, 20000))
  }

  private fun chunk(kind: String, data: ByteArray = ByteArray(0)): ByteArray {
    val out = ByteArrayOutputStream()
    val length = data.size
    out.write(byteArrayOf((length ushr 24).toByte(), (length ushr 16).toByte(), (length ushr 8).toByte(), length.toByte()))
    val body = kind.toByteArray(Charsets.ISO_8859_1) + data
    out.write(body)
    val crc = CRC32().apply { update(body) }.value
    out.write(byteArrayOf((crc ushr 24).toByte(), (crc ushr 16).toByte(), (crc ushr 8).toByte(), crc.toByte()))
    return out.toByteArray()
  }

  @Test fun aPngKeepsOnlyThePicture() {
    val signature = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)
    // One grey pixel.
    val header = chunk("IHDR", byteArrayOf(0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0))
    val packed = ByteArray(64).let { buffer -> Deflater().run { setInput(byteArrayOf(0, 127)); finish(); buffer.copyOf(deflate(buffer)) } }
    val pixels = chunk("IDAT", packed)
    val end = chunk("IEND")
    val clean = signature + header + pixels + end
    assertArrayEquals(clean, PhotoPrepare.cleanPng(clean))
    // Text, time, EXIF and a colour profile are dropped; the picture's own parts stay, byte for byte.
    val dressed = signature + header + chunk("tEXt", "Author\u0000Someone".toByteArray()) + chunk("eXIf", ByteArray(20)) + chunk("iCCP", ByteArray(30)) + chunk("tIME", ByteArray(7)) +
      chunk("PLTE", ByteArray(3)) + chunk("tRNS", ByteArray(1)) + pixels + chunk("tEXt", "Comment\u0000after".toByteArray()) + end
    assertArrayEquals(signature + header + chunk("PLTE", ByteArray(3)) + chunk("tRNS", ByteArray(1)) + pixels + end, PhotoPrepare.cleanPng(dressed))
    // Not a sound PNG: nothing is let out.
    assertNull(PhotoPrepare.cleanPng(ByteArray(0)))
    assertNull(PhotoPrepare.cleanPng(signature))
    assertNull(PhotoPrepare.cleanPng(byteArrayOf(0xFF.toByte(), 0xD8.toByte()) + ByteArray(40)))
    assertNull("no end", PhotoPrepare.cleanPng(signature + header + pixels))
    assertNull("no pixels", PhotoPrepare.cleanPng(signature + header + end))
    assertNull("no header", PhotoPrepare.cleanPng(signature + pixels + end))
    assertNull("two headers", PhotoPrepare.cleanPng(signature + header + header + pixels + end))
    assertNull("after the end", PhotoPrepare.cleanPng(signature + header + pixels + end + chunk("tEXt", ByteArray(4))))
    assertNull("a palette after the pixels", PhotoPrepare.cleanPng(signature + header + pixels + chunk("PLTE", ByteArray(3)) + end))
    assertNull("a moving picture", PhotoPrepare.cleanPng(signature + header + chunk("acTL", ByteArray(8)) + pixels + end))
    assertNull("an unknown part it cannot be read without", PhotoPrepare.cleanPng(signature + header + chunk("ABCD", ByteArray(2)) + pixels + end))
    assertNull("cut short", PhotoPrepare.cleanPng(clean.copyOf(clean.size - 3)))
    val spoiled = clean.copyOf().also { it[signature.size + header.size + 9] = (it[signature.size + header.size + 9] + 1).toByte() }
    assertNull("a wrong checksum", PhotoPrepare.cleanPng(spoiled))
  }

  @Test fun whereADecryptedFileLives() {
    assertTrue(DecryptedFiles.folderName.matches("invizent-view-0f8fad5b-d9cb-469f-a165-70867728950e"))
    for (wrong in listOf("invizent-view-", "invizent-view-../..", "other-0f8fad5b-d9cb-469f-a165-70867728950e", "invizent-view-0F8FAD5B-D9CB-469F-A165-70867728950E", "invizent-view-0f8fad5b-d9cb-469f-a165-70867728950e/x"))
      assertFalse(wrong, DecryptedFiles.folderName.matches(wrong))
  }

  @Test fun inlineMediaWords() {
    val sizes = { bytes: Long -> "$bytes Б" }
    // «44 Б · PDF»: the size, then the name's ending in capitals (at most five letters or digits).
    assertEquals("44 Б · PDF", com.linea.messenger.attachments.InlineMedia.sizeLine(mapOf("name" to "Договор.pdf"), "44 Б"))
    assertEquals("44 Б", com.linea.messenger.attachments.InlineMedia.sizeLine(mapOf("name" to "README"), "44 Б"))
    assertEquals("44 Б", com.linea.messenger.attachments.InlineMedia.sizeLine(mapOf("name" to "a.toolong"), "44 Б"))
    assertEquals("2 КБ · XLSX", com.linea.messenger.attachments.InlineMedia.sizeLine(mapOf("name" to "Смета.xlsx"), "2 КБ"))
    // While coming: «got / all» for a photo, «got из all» for a file.
    assertEquals("40 Б / 100 Б", com.linea.messenger.attachments.InlineMedia.loadingWords(100, 0.4f, photo = true, sizeText = sizes))
    assertEquals("100 Б из 100 Б", com.linea.messenger.attachments.InlineMedia.loadingWords(100, 1.5f, photo = false, sizeText = sizes))
    // The file's icon once it is here (FileBubble `fileIcon`).
    assertEquals("doc.text.fill", com.linea.messenger.attachments.InlineMedia.fileIcon("a.PDF"))
    assertEquals("music.note", com.linea.messenger.attachments.InlineMedia.fileIcon("song.mp3"))
    assertEquals("archivebox.fill", com.linea.messenger.attachments.InlineMedia.fileIcon("x.tar.gz"))
    assertEquals("doc.fill", com.linea.messenger.attachments.InlineMedia.fileIcon("notes.txt"))
    assertEquals(10 * 1024 * 1024, com.linea.messenger.attachments.InlineMedia.AUTO_PHOTO_BYTES)
  }
}
