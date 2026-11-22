package com.linea.messenger

import com.linea.messenger.chat.MsgRow
import com.linea.messenger.video.BigFiles
import com.linea.messenger.video.Mp4Scrub
import com.linea.messenger.video.NotePlayerView
import com.linea.messenger.video.NoteRecorder
import com.linea.messenger.video.VideoBits
import com.linea.messenger.video.VideoFailure
import com.linea.messenger.video.VideoNal
import com.linea.messenger.video.VideoPolicy
import com.linea.messenger.video.VideoPrepare
import com.linea.messenger.voice.MediaRows
import com.linea.messenger.voice.MsgMediaState
import com.linea.messenger.voice.RecordGesture
import com.linea.messenger.voice.VoicePlayer
import com.linea.messenger.voice.VoiceRecorder
import com.linea.messenger.voice.VoiceSamples
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

/** The rules of voice messages, videos and round videos that need no phone and no core, as the iPhone app has
 *  them (native/ios/Sources/Voice, native/ios/Sources/Video) and as the previous app's modules do
 *  (mobile/src/voice, mobile/src/videonote, mobile/modules/linea-video/android). */
class MediaRulesTest {
  private val time = { ms: Double -> "t" + (ms / 1000).toInt() }

  @Test fun howAVoiceMessageAVideoAndARoundVideoLook() {
    val preview = mapOf("mimeType" to "image/jpeg", "base64" to "QUJD", "width" to 240.0, "height" to 135.0)
    // A voice message: its waveform and its length; one from an older app has no waveform.
    assertEquals(mapOf("media" to "voice", "mediaTime" to "t23", "wave" to "AAAAffff"),
      MediaRows.fields(mapOf("name" to "voice-1.m4a", "media" to mapOf("durationMs" to 23000.0, "waveform" to "AAAAffff")), "voice", time))
    assertEquals(mapOf("media" to "voice", "wave" to ""), MediaRows.fields(mapOf("name" to "voice-1.m4a"), "voice", time))
    // A video: its small picture and how wide it is for its height; without one, the size the message names; without either, 3:2.
    assertEquals(mapOf("media" to "video", "mediaTime" to "t42", "thumb" to "QUJD", "thumbWide" to 240.0 / 135.0),
      MediaRows.fields(mapOf("media" to mapOf("durationMs" to 42000.0, "width" to 1080.0, "height" to 1920.0), "preview" to preview), "video", time))
    assertEquals(mapOf("media" to "video", "thumbWide" to 1080.0 / 1920.0), MediaRows.fields(mapOf("media" to mapOf("width" to 1080.0, "height" to 1920.0)), "video", time))
    assertEquals(mapOf("media" to "video", "thumbWide" to 1.5), MediaRows.fields(mapOf("preview" to (preview + ("height" to 0.0))), "video", time))
    // A round video is always a circle.
    assertEquals(mapOf("media" to "note", "mediaTime" to "t12", "thumb" to "QUJD", "thumbWide" to 1.0, "thumbRound" to true),
      MediaRows.fields(mapOf("media" to mapOf("durationMs" to 12000.0), "preview" to preview), "note", time))
    assertEquals(mapOf("media" to "note", "thumbWide" to 1.0, "thumbRound" to true), MediaRows.fields(mapOf("media" to mapOf("width" to 480.0, "height" to 640.0)), "note", time))
    // Anything else is not this feature's row.
    for (kind in listOf("photo", "audio", "file")) assertNull(MediaRows.fields(mapOf("name" to "a"), kind, time))
    // The list reads the fields.
    val row = MsgRow.parse(listOf(mapOf("key" to "k", "media" to "voice", "wave" to "AAAAffff", "mediaTime" to "0:23"))).single()
    assertEquals(listOf("voice", "AAAAffff", "0:23"), listOf(row.media, row.wave, row.mediaTime))
    assertEquals(listOf("", "", ""), MsgRow.parse(listOf(mapOf("key" to "k"))).single().let { listOf(it.media, it.wave, it.mediaTime) })
  }

  @Test fun theRowOfWhatIsOnItsWayOut() {
    val voice = MediaRows.pendingRow("media-1", "09:41", "voice", "12 КБ из 40 КБ", null, "AAAAffff", "0:05", "", 1.0)
    assertEquals(mapOf("key" to "media-1", "kind" to 0, "mine" to true, "text" to "", "time" to "09:41", "ticks" to 3, "tail" to true,
      "label" to "12 КБ из 40 КБ", "media" to "voice", "wave" to "AAAAffff", "mediaTime" to "0:05", "thumbWide" to 1.0), voice)
    val note = MediaRows.pendingRow("media-2", "09:41", "note", "Обработка…", null, "", "", "QUJD", 1.0)
    assertEquals(listOf("QUJD", true, "Обработка…"), listOf(note["thumb"], note["thumbRound"], note["label"]))
    // What was not sent says so, in red (ticks 4), and offers to try again.
    val failed = MediaRows.pendingRow("media-3", "09:41", "video", "3 МБ", "Видео больше 100 МБ.", "", "0:42", "", 1.5)
    assertEquals(listOf("Не отправлено · повторить\nВидео больше 100 МБ.", 4, null), listOf(failed["label"], failed["ticks"], failed["thumbRound"]))
  }

  @Test fun aTakeThatIsNotSent() {
    assertEquals("Слишком короткое голосовое — держи запись хотя бы секунду.", MediaRows.takeRefusal(499, broken = false))
    assertEquals("Микрофон записал тишину — голосовое не отправлено. Запиши ещё раз.", MediaRows.takeRefusal(3000, broken = true))
    assertNull(MediaRows.takeRefusal(500, broken = false))
    // 128 kbit/s is 16 bytes a millisecond; a file under an eighth of that is not the take.
    assertTrue(VoiceRecorder.tiny(10_000, 19_999))
    assertFalse(VoiceRecorder.tiny(10_000, 20_000))
    assertFalse(VoiceRecorder.tiny(999, 0))
    assertEquals("Звук — удерживайте. Видео — нажмите.", MediaRows.hintVoice)
    assertEquals("Видео — удерживайте. Звук — нажмите.", MediaRows.hintVideo)
    assertEquals("Нет доступа к микрофону. Разреши его для Инвиза в настройках телефона, чтобы записывать голосовые.", VoiceRecorder.noAccess)
    assertEquals("Нужен доступ к камере и микрофону. Разреши их для Инвиза в настройках телефона.", NoteRecorder.noAccess)
    // The file every other app plays: the reference's own parameters.
    assertEquals(listOf(48000L, 128000L, 18L * 60 * 60 * 1000), listOf(VoiceRecorder.SAMPLE_RATE.toLong(), VoiceRecorder.BIT_RATE.toLong(), VoiceRecorder.MAX_MS))
  }

  @Test fun theLoudnessOfATake() {
    // Decibels of full scale, −60 dB and quieter read as silence.
    assertEquals(0.0, VoiceRecorder.level(0), 0.0)
    assertEquals(1.0, VoiceRecorder.level(32767), 1e-9)
    assertEquals(0.0, VoiceRecorder.level(32), 1e-9)
    assertEquals(2.0 / 3.0, VoiceRecorder.level(3277), 1e-3)
    assertEquals(1.0, VoiceRecorder.level(40000), 0.0)

    // The samples of a take: bounded, the louder of two neighbours wins, the last group counts too.
    val samples = VoiceSamples(cap = 4)
    for (level in listOf(0.1, 0.2, 0.3)) samples.push(level)
    assertEquals(listOf(listOf(0.1, 0.2, 0.3), 1), listOf(samples.samples, samples.stride))
    samples.push(0.9)
    assertEquals(listOf(listOf(0.2, 0.9), 2), listOf(samples.samples, samples.stride))
    samples.push(0.5)
    assertEquals(listOf(0.2, 0.9, 0.5), samples.levels())
    samples.push(0.4)
    assertEquals(listOf(0.2, 0.9, 0.5), samples.samples)
    samples.push(0.7); samples.push(0.1)
    assertEquals(listOf(listOf(0.9, 0.7), 4, 0.9), listOf(samples.samples, samples.stride, samples.loudest))
    assertEquals(emptyList<Double>(), VoiceSamples().levels())
  }

  @Test fun theSpeedOfVoiceMessages() {
    assertEquals(listOf(1.5f, 2f, 1f), listOf(VoicePlayer.nextRate(1f), VoicePlayer.nextRate(1.5f), VoicePlayer.nextRate(2f)))
    assertEquals(listOf("1×", "1,5×", "2×"), listOf(1f, 1.5f, 2f).map { VoicePlayer.rateLabel(it) })
    assertEquals("Звук будет проигрываться с обычной скоростью.", VoicePlayer.rateWords(1f))
    assertEquals("Звук будет проигрываться в 1,5 раза быстрее.", VoicePlayer.rateWords(1.5f))
    assertEquals("Звук будет проигрываться в 2 раза быстрее.", VoicePlayer.rateWords(2f))
    // What the playing row shows.
    val clock = { ms: Int -> "${ms / 60000}:" + (ms / 1000 % 60).toString().padStart(2, '0') }
    assertEquals(MsgMediaState(key = "k", playing = true, progress = 7f / 23f, time = "0:07 / 0:23", rate = "1,5×"), VoicePlayer.state("k", false, true, 7000, 23000, "1,5×", clock))
    assertEquals(MsgMediaState(key = "k", time = "0:23", rate = "1×"), VoicePlayer.state("k", false, false, 0, 23000, "1×", clock))
    assertEquals(1f, VoicePlayer.state("k", false, false, 30000, 23000, "1×", clock).progress, 0f)
    assertEquals(0f, VoicePlayer.state("k", true, false, 5, 0, "1×", clock).progress, 0f)
  }

  @Test fun theRecordButtonsGesture() {
    // The owner's spec: hold 0.19 s; 150 / 110 dp while holding, 100 / 60 dp or 400 dp/s on release.
    assertEquals(listOf(190L, 150f, 110f, 100f, 60f, 400f), listOf(RecordGesture.holdMs, RecordGesture.cancelDistance, RecordGesture.lockDistance, RecordGesture.cancelOnRelease, RecordGesture.lockOnRelease, RecordGesture.flick))
    // On release one axis decides: the larger of left and up; right and down count as nothing.
    assertEquals(Pair(-80f, 0f), RecordGesture.axis(-80f, -30f))
    assertEquals(Pair(0f, -90f), RecordGesture.axis(-80f, -90f))
    assertEquals(Pair(0f, 0f), RecordGesture.axis(50f, 70f))
    // While holding: past the distance (both directions count at once).
    assertNull(RecordGesture.move(-150f, 0f))
    assertEquals("cancel", RecordGesture.move(-150.5f, 0f))
    assertNull(RecordGesture.move(0f, -110f))
    assertEquals("lock", RecordGesture.move(0f, -110.5f))
    // On release: past the shorter distance, or a fast flick; anything else sends.
    assertEquals("send", RecordGesture.release(-100f, -60f, 0f, 0f))
    assertEquals("cancel", RecordGesture.release(-101f, 0f, 0f, 0f))
    assertEquals("cancel", RecordGesture.release(-10f, 0f, -401f, 0f))
    assertEquals("lock", RecordGesture.release(0f, -61f, 0f, 0f))
    assertEquals("lock", RecordGesture.release(0f, -5f, 0f, -401f))
    assertEquals("lock", RecordGesture.release(-100f, -200f, 0f, 0f))
    assertEquals("send", RecordGesture.release(300f, 300f, 900f, 900f))
  }

  @Test fun theLimitsOfBigFiles() {
    val gib = 1024L * 1024 * 1024
    assertEquals(listOf("100 МБ", "1.5 ГБ", "4 ГБ", "1 МБ", "0 МБ"), listOf(100L * 1024 * 1024, gib * 3 / 2, 4 * gib, 1_000_000L, 0L).map { BigFiles.sizeLabel(it) })
    val limits = mapOf("maxFileBytes" to 2.0 * gib, "maxVideoBytes" to 100.0 * 1024 * 1024, "platina" to false)
    assertNull(BigFiles.limitWords(limits, video = false, size = 2 * gib))
    assertEquals("Файл больше 2 ГБ. С Platina можно отправлять файлы до 4 ГБ.", BigFiles.limitWords(limits, video = false, size = 2 * gib + 1))
    assertEquals("Файл больше 2 ГБ.", BigFiles.limitWords(limits + ("platina" to true), video = false, size = 3 * gib))
    assertEquals("Видео больше 100 МБ.", BigFiles.limitWords(limits, video = true, size = 100L * 1024 * 1024 + 1))
    assertNull(BigFiles.limitWords(limits, video = true, size = 100L * 1024 * 1024))
    // A server that names no limit for videos counts them as files; one that names none at all stops nothing here.
    assertNull(BigFiles.limitWords(mapOf("maxFileBytes" to 2.0 * gib), video = true, size = gib))
    assertNull(BigFiles.limitWords(emptyMap(), video = false, size = 100 * gib))
    assertEquals("Загрузка отменена.", BigFiles.cancelled)

    // What the answer to one chunk of an upload asks for next.
    assertEquals(BigFiles.Step.SENT, BigFiles.step(200, emptyMap(), 100))
    // The chunk got through but the reply was lost: the server already has it.
    assertEquals(BigFiles.Step.SENT, BigFiles.step(409, mapOf("received" to 100.0), 100))
    assertEquals(BigFiles.Step.AGAIN, BigFiles.step(409, mapOf("received" to 50.0), 100))
    assertEquals(BigFiles.Step.BUSY, BigFiles.step(409, mapOf("code" to "UPLOAD_BUSY"), 100))
    assertEquals(BigFiles.Step.LOST, BigFiles.step(409, mapOf("code" to "UPLOAD_LOST"), 100))
    assertEquals(BigFiles.Step.PROVE, BigFiles.step(401, mapOf("code" to "device_proof"), 100))
    for (status in listOf(401, 403, 404, 413, 507)) assertEquals(BigFiles.Step.REFUSED, BigFiles.step(status, emptyMap(), 100))
    for (status in listOf(0, 500, 502, 429)) assertEquals(BigFiles.Step.AGAIN, BigFiles.step(status, emptyMap(), 100))
  }

  // The cleaning of a video's picture data, as the reference's own tests ask it (VideoNalTest of linea-video).

  private fun annex(vararg units: ByteArray) = units.flatMap { listOf<Byte>(0, 0, 0, 1) + it.toList() }.toByteArray()
  private fun length(vararg units: ByteArray): ByteArray { val out = ByteArrayOutputStream(); units.forEach { n -> out.write(byteArrayOf(0, 0, (n.size ushr 8).toByte(), n.size.toByte())); out.write(n) }; return out.toByteArray() }
  private fun sei(type: Int, payload: ByteArray, hevc: Boolean = false): ByteArray = (if (hevc) byteArrayOf(78, 1) else byteArrayOf(6)) + byteArrayOf(type.toByte(), payload.size.toByte()) + payload + byteArrayOf(-128)
  private val slice = byteArrayOf(101, 9, 17, 31)

  @Test fun privateDataLeavesAVideosPictureAndTheFramesStay() {
    assertArrayEquals(annex(slice), VideoNal.cleanAnnexB(annex(sei(5, ByteArray(16) { 1 } + "GPS PRIVATE CAMERA".toByteArray()), slice), false, "sdr"))
    val frame = byteArrayOf(38, 1, 12, 34)
    assertArrayEquals(length(frame), VideoNal.cleanLengthPrefixed(length(sei(5, ByteArray(16) { 2 } + "private".toByteArray(), true), byteArrayOf(76, 1, -1, -128), frame), true, "sdr"))
    // Valid HDR light levels stay, and cleaning twice changes nothing.
    val input = length(sei(144, byteArrayOf(3, -24, 1, -112), true), frame)
    assertArrayEquals(input, VideoNal.cleanLengthPrefixed(input, true, "pq"))
    assertArrayEquals(input, VideoNal.cleanLengthPrefixed(VideoNal.cleanLengthPrefixed(input, true, "pq"), true, "pq"))
    // Three-byte start codes are read and written as four.
    assertArrayEquals(annex(slice), VideoNal.cleanAnnexB(byteArrayOf(0, 0, 1) + slice, false, "sdr"))
    assertArrayEquals(annex(slice), VideoNal.cleanSample(annex(sei(5, ByteArray(16)), slice), false, "sdr"))
    assertArrayEquals(length(slice), VideoNal.cleanSample(length(sei(5, ByteArray(16)), slice), false, "sdr"))
  }

  @Test fun whatCannotBeJudgedStopsTheVideo() {
    fun refused(run: () -> Unit) { assertThrows(VideoFailure::class.java) { run() } }
    // Dynamic HDR is refused, not dropped.
    refused { VideoNal.cleanAnnexB(annex(sei(4, byteArrayOf(-75, 0, 60, 0, 1, 4, 1)), slice), false, "pq") }
    refused { VideoNal.cleanLengthPrefixed(length(byteArrayOf(124, 1, 2)), true, "hlg") }
    // Cut lengths and wrong headers.
    for (data in listOf(byteArrayOf(0, 0, 0, 8, 101, 1), byteArrayOf(0, 0, 0, 0), byteArrayOf(1))) refused { VideoNal.cleanLengthPrefixed(data, false, "sdr") }
    refused { VideoNal.cleanAnnexB(annex(byteArrayOf(-27, 1)), false, "sdr") }
    // HDR data must be sound and must be declared.
    refused { VideoNal.cleanAnnexB(annex(sei(144, byteArrayOf(1, 2)), slice), false, "pq") }
    refused { VideoNal.cleanAnnexB(annex(sei(144, byteArrayOf(3, -24, 1, -112)), slice), false, "sdr") }
    refused { VideoNal.cleanAnnexB(annex(byteArrayOf(6, 5, 100, 1, -128)), false, "sdr") }
    refused { VideoNal.cleanAnnexB(ByteArray(VideoPolicy.MAX_SAMPLE + 1), false, "sdr") }
    // Unknown rendering data is not silently discarded.
    refused { VideoNal.cleanAnnexB(annex(sei(47, byteArrayOf(1)), slice), false, "sdr") }
    refused { VideoNal.cleanAnnexB(annex(sei(5, byteArrayOf(1, 2)), slice), false, "sdr") }

    assertEquals(listOf("sdr", "sdr", "pq", "hlg"), listOf(VideoPolicy.hdr(0, 0), VideoPolicy.hdr(3, 1), VideoPolicy.hdr(6, 6), VideoPolicy.hdr(7, 6)))
    refused { VideoPolicy.hdr(6, 1) }
    refused { VideoPolicy.hdr(99, 6) }
    refused { VideoPolicy.validateDepth(10, "sdr", false) }
    refused { VideoPolicy.validateDepth(8, "pq", true) }
    VideoPolicy.validateDepth(8, "sdr", false); VideoPolicy.validateDepth(10, "sdr", true); VideoPolicy.validateDepth(10, "pq", true)
    refused { VideoPolicy.dimensions(0, 100) }
    refused { VideoPolicy.dimensions(100, 16385) }

    // The words for the person.
    assertEquals("Не удалось обработать видео. Файл не отправлен.", VideoPrepare.failed)
    assertEquals(VideoPrepare.failed, VideoPolicy.words("MALFORMED_VIDEO"))
    assertEquals("Загрузка отменена.", VideoPolicy.words("CANCELLED"))
    assertEquals("Защищённое видео не поддерживается.", VideoPolicy.words("DRM_UNSUPPORTED"))
    assertEquals("Этот файл или его кодек не удалось безопасно обработать. Исходное видео не отправлено.", VideoPolicy.words("UNSUPPORTED_CODEC"))
    assertTrue(VideoPolicy.words("UNKNOWN_HDR").startsWith("Этот вариант HDR"))
    assertEquals("Обработка видео не завершилась вовремя. Исходник не отправлен.", VideoPolicy.words("CODEC_TIMEOUT"))
  }

  @Test fun realEncodedPicturesKeepEveryFrame() {
    // The reference's own samples (not copied here): an H.264 and an HDR10 HEVC stream with private data in them.
    val folder = File("../../../mobile/modules/linea-video/android/src/test/resources/video")
    assumeTrue(File(folder, "sdr.h264").isFile && File(folder, "hdr10.hevc").length() > 0)
    for ((name, hevc, hdr) in listOf(Triple("hdr10.hevc", true, "pq"), Triple("sdr.h264", false, "sdr"))) {
      val source = File(folder, name).readBytes()
      val clean = VideoNal.cleanAnnexB(source, hevc, hdr)
      fun frames(bytes: ByteArray) = VideoNal.annexUnits(bytes).filter { if (hevc) ((it[0].toInt() ushr 1) and 63) < 32 else (it[0].toInt() and 31) in 1..5 }
      val before = frames(source); val after = frames(clean)
      assertEquals(before.size, after.size); assertTrue(before.isNotEmpty())
      before.zip(after).forEach { (first, second) -> assertArrayEquals(first, second) }
      assertArrayEquals(clean, VideoNal.cleanAnnexB(clean, hevc, hdr)); assertTrue(clean.size < source.size)
    }
    val hevcSps = VideoNal.annexUnits(File(folder, "hdr10.hevc").readBytes()).first { (it[0].toInt() ushr 1) and 63 == 33 }
    val avcSps = VideoNal.annexUnits(File(folder, "sdr.h264").readBytes()).first { it[0].toInt() and 31 == 7 }
    assertEquals(10, VideoBits.depth(hevcSps, true)); assertEquals(8, VideoBits.depth(avcSps, false))
    assertThrows(VideoFailure::class.java) { VideoBits.depth(hevcSps.copyOf(3), true) }
  }

  // What the system's muxer writes about the moment and the phone is removed from the new file.

  private fun box(type: String, vararg parts: ByteArray): ByteArray {
    val body = parts.fold(ByteArray(0)) { all, part -> all + part }
    val size = body.size + 8
    return byteArrayOf((size ushr 24).toByte(), (size ushr 16).toByte(), (size ushr 8).toByte(), size.toByte()) + type.toByteArray(Charsets.ISO_8859_1) + body
  }
  private fun header(version: Int, rest: Int) = byteArrayOf(version.toByte(), 0, 0, 0) + ByteArray(if (version == 0) 8 else 16) { 0x55 } + ByteArray(rest) { 0x22 }

  @Test fun aNewVideoCarriesNoDatesAndNoNotes() {
    val notes = box("meta", "com.android.version 15".toByteArray())
    val moov = box("moov",
      box("mvhd", header(0, 88)),
      notes,
      box("trak", box("tkhd", header(1, 60)), box("mdia", box("mdhd", header(0, 12)), box("hdlr", ByteArray(24) { 7 }), box("minf", box("stbl", box("stsd", ByteArray(20) { 9 })))), box("udta", "©xyz+55.75+037.61/".toByteArray(Charsets.ISO_8859_1))),
    )
    val scrubbed = moov.copyOf()
    assertTrue(Mp4Scrub.scrubMovie(scrubbed))
    assertEquals(moov.size, scrubbed.size)
    val text = String(scrubbed, Charsets.ISO_8859_1)
    // The notes are free space of the same length; the dates are zero; nothing else moved or changed.
    assertFalse(text.contains("com.android.version") || text.contains("55.75") || text.contains("udta") || text.contains("meta"))
    assertEquals(2, Regex("free").findAll(text).count())
    assertFalse(scrubbed.any { it == 0x55.toByte() })
    assertEquals(moov.count { it == 0x22.toByte() }, scrubbed.count { it == 0x22.toByte() })
    assertEquals(moov.count { it == 7.toByte() }, scrubbed.count { it == 7.toByte() })
    for (kept in listOf("mvhd", "trak", "tkhd", "mdia", "mdhd", "hdlr", "minf", "stbl", "stsd")) assertEquals(text.indexOf(kept), String(moov, Charsets.ISO_8859_1).indexOf(kept))
    assertArrayEquals(scrubbed, scrubbed.copyOf().also { assertTrue(Mp4Scrub.scrubMovie(it)) })
    // What is not a movie box, or is cut short, is not touched and is said so.
    assertFalse(Mp4Scrub.scrubMovie(box("mdat", ByteArray(10))))
    assertFalse(Mp4Scrub.scrubMovie(moov.copyOf(moov.size - 3)))
    assertFalse(Mp4Scrub.scrubMovie(box("moov", box("mvhd", byteArrayOf(7, 0, 0, 0) + ByteArray(96)))))

    // A whole file: the picture's bytes stay where they were.
    val picture = ByteArray(5000) { (it * 31).toByte() }
    val whole = box("ftyp", "isom".toByteArray() + ByteArray(8)) + box("mdat", picture) + moov
    val file = File.createTempFile("invizent-scrub", ".mp4")
    try {
      file.writeBytes(whole)
      assertTrue(Mp4Scrub.scrub(file))
      val after = file.readBytes()
      assertEquals(whole.size, after.size)
      assertArrayEquals(whole.copyOfRange(0, whole.size - moov.size), after.copyOfRange(0, whole.size - moov.size))
      assertArrayEquals(scrubbed, after.copyOfRange(whole.size - moov.size, whole.size))
      // A file without a movie box, or one that is not made of boxes, is not let out.
      file.writeBytes(box("ftyp", ByteArray(8)) + box("mdat", picture))
      assertFalse(Mp4Scrub.scrub(file))
      file.writeBytes(ByteArray(100) { 3 })
      assertFalse(Mp4Scrub.scrub(file))
    } finally { file.delete() }
  }

  @Test fun howAVideoIsMeasuredAndShown() {
    // The size a video is shown in: its picture's size turned as the track says.
    assertEquals(Pair(1080, 1920), VideoPrepare.shown(1920, 1080, 90))
    assertEquals(Pair(1080, 1920), VideoPrepare.shown(1920, 1080, 270))
    assertEquals(Pair(1920, 1080), VideoPrepare.shown(1920, 1080, 180))
    // The small picture: a frame at min(600 ms, a sixth of the length) — the very first one is often black.
    assertEquals(listOf(600L, 500L, 400L, 17L), listOf(60_000L, 3000L, 0L, 100L).map { VideoPrepare.previewAt(it) })
    // A picture stretched over a view is scaled back to its own shape and fills the view.
    assertEquals(Pair(1f, 4f / 3f), NotePlayerView.fill(480, 640, 300, 300))
    assertEquals(Pair(16f / 9f, 1f), NotePlayerView.fill(1920, 1080, 200, 200))
    assertEquals(Pair(1f, 1f), NotePlayerView.fill(100, 100, 50, 50))
  }

  @Test fun theRoundVideoCamera() {
    assertEquals(60_000L, NoteRecorder.MAX_MS)
    // 640×480 as the reference's camera writes it; else the nearest 4:3 size; else the nearest in area.
    assertEquals(Pair(640, 480), NoteRecorder.captureSize(listOf(Pair(1920, 1080), Pair(640, 480), Pair(320, 240))))
    assertEquals(Pair(640, 480), NoteRecorder.captureSize(emptyList()))
    assertEquals(Pair(800, 600), NoteRecorder.captureSize(listOf(Pair(1920, 1080), Pair(800, 600), Pair(1440, 1080), Pair(320, 240))))
    assertEquals(Pair(720, 480), NoteRecorder.captureSize(listOf(Pair(1920, 1080), Pair(720, 480), Pair(176, 144))))
    // The picture is written upright: the sensor's own turn and the phone's.
    assertEquals(listOf(270, 0, 90, 180), listOf(0, 90, 180, 270).map { NoteRecorder.writtenTurn(270, it, front = true) })
    assertEquals(listOf(90, 0, 270, 180), listOf(0, 90, 180, 270).map { NoteRecorder.writtenTurn(90, it, front = false) })
    // A take is sent when its file is whole, it was not called off and it lasts a second.
    assertTrue(NoteRecorder.keeps(whole = true, keep = true, ms = 1000))
    assertFalse(NoteRecorder.keeps(whole = true, keep = true, ms = 999))
    assertFalse(NoteRecorder.keeps(whole = true, keep = false, ms = 5000))
    assertFalse(NoteRecorder.keeps(whole = false, keep = true, ms = 5000))
  }
}
