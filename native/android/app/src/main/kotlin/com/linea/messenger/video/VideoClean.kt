package com.linea.messenger.video

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

// The cleaning of a video before it leaves the phone, as the previous app's Android module does it
// (mobile/modules/linea-video/android: VideoProcessor, VideoTracks, VideoAudio, VideoNal, VideoBits, VideoPolicy —
// ported class for class, with the platform's own MediaExtractor / MediaCodec / MediaMuxer and nothing else):
//  - the picture is NOT encoded again: its samples are copied into a new MP4, each one first cleaned of private
//    data (user-data SEI, filler) — what cannot be judged safely stops the whole video, it is never guessed;
//  - the sound is never copied: it is decoded and encoded anew as AAC-LC;
//  - the container is a new one written by the system's muxer, so nothing of the source's own description (place,
//    camera model, dates, the original name) is carried over; what the muxer itself adds is removed after it
//    (`Mp4Scrub`).

/** Why a video could not be cleaned; `reason` is the reference's code. */
class VideoFailure(val reason: String) : Exception(reason)

object VideoPolicy {
  /** A sanity bound only (the server's own limits are asked before the upload). */
  const val MAX_INPUT = 10L * 1024 * 1024 * 1024
  const val MAX_SAMPLES = 50_000_000
  const val MAX_OUTPUT = 10L * 1024 * 1024 * 1024
  const val MAX_SAMPLE = 16 * 1024 * 1024
  const val MAX_DURATION_US = 48L * 60 * 60 * 1000000

  fun dimensions(width: Int, height: Int) {
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) throw VideoFailure("VIDEO_DIMENSIONS")
  }

  fun validateDepth(depth: Int, hdr: String, transferKnown: Boolean) {
    if (depth !in 8..16) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    if (depth > 8 && !transferKnown) throw VideoFailure("UNKNOWN_HDR")
    if (hdr != "sdr" && depth < 10) throw VideoFailure("UNKNOWN_HDR")
  }

  fun hdr(transfer: Int, standard: Int): String = when (transfer) {
    0, 3 -> "sdr"
    1 -> if (standard == 6) throw VideoFailure("UNKNOWN_HDR") else "sdr"
    6, 7 -> { if (standard != 6) throw VideoFailure("UNKNOWN_HDR"); if (transfer == 6) "pq" else "hlg" }
    else -> throw VideoFailure("UNKNOWN_HDR")
  }

  /** The words for the person, as the reference's module says them. */
  fun words(reason: String): String = when (reason) {
    "CANCELLED" -> BigFiles.cancelled
    "UNKNOWN_HDR", "DYNAMIC_HDR_UNSUPPORTED", "DYNAMIC_HDR_OR_REGISTERED_DATA_UNSUPPORTED", "HDR_CONTAINER_UNSUPPORTED" ->
      "Этот вариант HDR или дополнительных видеоданных пока нельзя сохранить безопасно. Видео не преобразовано в SDR и не отправлено."
    "DRM_UNSUPPORTED" -> "Защищённое видео не поддерживается."
    "CODEC_TIMEOUT" -> "Обработка видео не завершилась вовремя. Исходник не отправлен."
    "UNSUPPORTED_CODEC", "UNSUPPORTED_TRACKS", "NO_VIDEO_TRACK", "UNSUPPORTED_VIDEO_NAL", "UNSUPPORTED_VIDEO_METADATA", "UNSUPPORTED_VIDEO_CONFIG", "MULTILAYER_UNSUPPORTED" ->
      "Этот файл или его кодек не удалось безопасно обработать. Исходное видео не отправлено."
    else -> VideoPrepare.failed
  }
}

/** Private NAL units and SEI payloads are removed without decoding or tone-mapping the picture.
 *  Registered T.35 payloads are refused: this includes unverified dynamic HDR. */
object VideoNal {
  private fun invalid(): Nothing = throw VideoFailure("MALFORMED_VIDEO")
  private fun size(bytes: ByteArray) { if (bytes.isEmpty() || bytes.size > VideoPolicy.MAX_SAMPLE) invalid() }

  private fun start(bytes: ByteArray, index: Int): Int {
    if (index + 3 > bytes.size || bytes[index] != 0.toByte() || bytes[index + 1] != 0.toByte()) return 0
    if (bytes[index + 2] == 1.toByte()) return 3
    return if (index + 4 <= bytes.size && bytes[index + 2] == 0.toByte() && bytes[index + 3] == 1.toByte()) 4 else 0
  }

  fun annexUnits(bytes: ByteArray): List<ByteArray> {
    size(bytes)
    val units = ArrayList<ByteArray>(); var offset = 0
    while (offset < bytes.size) {
      val prefix = start(bytes, offset); if (prefix == 0) invalid()
      val begin = offset + prefix; var end = begin
      while (end < bytes.size && start(bytes, end) == 0) end++
      var payloadEnd = end; while (payloadEnd > begin && bytes[payloadEnd - 1] == 0.toByte()) payloadEnd--
      if (payloadEnd <= begin) invalid()
      units.add(bytes.copyOfRange(begin, payloadEnd)); if (units.size > 4096) invalid()
      offset = end
    }
    return units
  }

  fun cleanAnnexB(bytes: ByteArray, hevc: Boolean, hdr: String): ByteArray {
    val output = ByteArrayOutputStream()
    annexUnits(bytes).forEach { nal -> cleanNal(nal, hevc, hdr)?.let { output.write(byteArrayOf(0, 0, 0, 1)); output.write(it) } }
    return output.toByteArray()
  }

  fun cleanSample(bytes: ByteArray, hevc: Boolean, hdr: String): ByteArray =
    if (start(bytes, 0) > 0) cleanAnnexB(bytes, hevc, hdr) else cleanLengthPrefixed(bytes, hevc, hdr)

  fun cleanConfig(bytes: ByteArray, hevc: Boolean, hdr: String): ByteArray {
    val output = ByteArrayOutputStream(); val parameters = if (hevc) setOf(32, 33, 34) else setOf(7, 8, 13)
    annexUnits(bytes).forEach { nal ->
      val type = type(nal, hevc)
      if (type in parameters) { output.write(byteArrayOf(0, 0, 0, 1)); output.write(nal) }
      else { val clean = cleanNal(nal, hevc, hdr); if (clean != null) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG") }
    }
    if (output.size() == 0) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    return output.toByteArray()
  }

  fun cleanLengthPrefixed(bytes: ByteArray, hevc: Boolean, hdr: String, lengthBytes: Int = 4): ByteArray {
    size(bytes); if (lengthBytes !in setOf(1, 2, 4)) invalid()
    val output = ByteArrayOutputStream(); var offset = 0; var count = 0
    while (offset < bytes.size) {
      if (offset + lengthBytes > bytes.size || ++count > 4096) invalid()
      var length = 0L; repeat(lengthBytes) { length = (length shl 8) or (bytes[offset++].toLong() and 255) }
      if (length <= 0 || length > bytes.size - offset) invalid()
      val nal = bytes.copyOfRange(offset, offset + length.toInt()); offset += length.toInt()
      cleanNal(nal, hevc, hdr)?.let { clean ->
        for (i in lengthBytes - 1 downTo 0) output.write((clean.size ushr (i * 8)) and 255)
        output.write(clean)
      }
    }
    return output.toByteArray()
  }

  private fun type(nal: ByteArray, hevc: Boolean): Int {
    if (nal.isEmpty() || (nal[0].toInt() and 128) != 0) invalid()
    if (!hevc) return nal[0].toInt() and 31
    if (nal.size < 2 || (nal[1].toInt() and 7) == 0) invalid()
    if ((nal[0].toInt() and 1) != 0 || (nal[1].toInt() and 248) != 0) throw VideoFailure("MULTILAYER_UNSUPPORTED")
    return (nal[0].toInt() ushr 1) and 63
  }

  private fun cleanNal(nal: ByteArray, hevc: Boolean, hdr: String): ByteArray? {
    val type = type(nal, hevc)
    if (hevc) {
      if (type == 62 || type == 63) throw VideoFailure("DYNAMIC_HDR_UNSUPPORTED")
      if (type == 38) return null
      if (type == 39 || type == 40) return cleanSei(nal, 2, hdr)
      if (type !in 0..9 && type !in 16..21 && type !in 32..37) throw VideoFailure("UNSUPPORTED_VIDEO_NAL")
    } else {
      if (type == 12) return null
      if (type == 6) return cleanSei(nal, 1, hdr)
      if (type !in 1..5 && type !in 7..11 && type != 13) throw VideoFailure("UNSUPPORTED_VIDEO_NAL")
    }
    return nal
  }

  private fun cleanSei(nal: ByteArray, header: Int, hdr: String): ByteArray? {
    val rbsp = unescape(nal.copyOfRange(header, nal.size)); val output = ByteArrayOutputStream()
    var offset = 0; var count = 0; var ended = false
    while (offset < rbsp.size) {
      if (rbsp[offset] == (-128).toByte() && offset == rbsp.size - 1) { ended = true; break }
      if (++count > 256) invalid()
      val type = extended(rbsp, offset); offset = type.second
      val length = extended(rbsp, offset); offset = length.second
      if (length.first > rbsp.size - offset - 1) invalid()
      val payload = rbsp.copyOfRange(offset, offset + length.first); offset += length.first
      if (keepSei(type.first, payload, hdr)) {
        writeExtended(output, type.first); writeExtended(output, payload.size); output.write(payload)
      }
    }
    if (!ended) invalid()
    if (output.size() == 0) return null
    output.write(128)
    return nal.copyOfRange(0, header) + escape(output.toByteArray())
  }

  private fun keepSei(type: Int, payload: ByteArray, hdr: String): Boolean {
    if (type == 4) throw VideoFailure("DYNAMIC_HDR_OR_REGISTERED_DATA_UNSUPPORTED")
    if (type == 5) { if (payload.size < 16) invalid(); return false }
    if (type == 3) return false
    // Buffer timing and recovery are decoding instructions, not user metadata.
    if (type in setOf(0, 1, 6)) { if (payload.isEmpty() || payload.size > 256) invalid(); return true }
    if (type !in setOf(137, 144, 147)) throw VideoFailure("UNSUPPORTED_VIDEO_METADATA")
    if (hdr !in setOf("pq", "hlg")) throw VideoFailure("UNKNOWN_HDR")
    validateHdr(type, payload, hdr); return true
  }

  private fun validateHdr(type: Int, data: ByteArray, hdr: String) {
    when (type) {
      137 -> {
        if (data.size != 24) invalid()
        for (i in 0 until 8) if (u16(data, i * 2) > 50000) invalid()
        val max = u32(data, 16); val min = u32(data, 20)
        if (max == 0L || max > 100000000L || min >= max) invalid()
      }
      144 -> { if (data.size != 4) invalid(); if (u16(data, 0) != 0 && u16(data, 2) > u16(data, 0)) invalid() }
      147 -> { if (data.size != 1 || data[0].toInt() != (if (hdr == "pq") 16 else 18)) invalid() }
    }
  }

  private fun u16(data: ByteArray, index: Int) = ((data[index].toInt() and 255) shl 8) or (data[index + 1].toInt() and 255)
  private fun u32(data: ByteArray, index: Int) = (u16(data, index).toLong() shl 16) or u16(data, index + 2).toLong()

  private fun extended(data: ByteArray, start: Int): Pair<Int, Int> {
    var index = start; var value = 0
    while (true) {
      if (index >= data.size) invalid()
      val part = data[index++].toInt() and 255; value += part
      if (value > VideoPolicy.MAX_SAMPLE) invalid()
      if (part != 255) return value to index
    }
  }

  private fun writeExtended(out: ByteArrayOutputStream, input: Int) { var value = input; while (value >= 255) { out.write(255); value -= 255 }; out.write(value) }

  internal fun unescape(bytes: ByteArray): ByteArray {
    val output = ByteArrayOutputStream(); var zeros = 0; var index = 0
    while (index < bytes.size) {
      val value = bytes[index++].toInt() and 255
      if (zeros == 2 && value == 3) { if (index >= bytes.size || (bytes[index].toInt() and 255) > 3) invalid(); zeros = 0; continue }
      output.write(value); zeros = if (value == 0) zeros + 1 else 0
    }
    return output.toByteArray()
  }

  private fun escape(bytes: ByteArray): ByteArray {
    val output = ByteArrayOutputStream(); var zeros = 0
    for (byte in bytes) {
      val value = byte.toInt() and 255
      if (zeros == 2 && value <= 3) { output.write(3); zeros = 0 }
      output.write(value); zeros = if (value == 0) zeros + 1 else 0
    }
    return output.toByteArray()
  }
}

/** The real bit depth of a picture, read from its sequence parameter set. */
object VideoBits {
  fun depth(nal: ByteArray, hevc: Boolean): Int {
    val header = if (hevc) 2 else 1
    if (nal.size <= header) throw VideoFailure("MALFORMED_VIDEO")
    val bits = Bits(VideoNal.unescape(nal.copyOfRange(header, nal.size)))
    return if (hevc) hevcDepth(bits) else avcDepth(bits)
  }

  private fun hevcDepth(bits: Bits): Int {
    bits.skip(4); val layers = bits.read(3); bits.skip(1)
    if (layers > 6) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    bits.skip(96)
    val profile = BooleanArray(layers); val level = BooleanArray(layers)
    for (index in 0 until layers) { profile[index] = bits.read(1) == 1; level[index] = bits.read(1) == 1 }
    if (layers > 0) bits.skip((8 - layers) * 2)
    for (index in 0 until layers) { if (profile[index]) bits.skip(88); if (level[index]) bits.skip(8) }
    bits.ue(); val chroma = bits.ue(); if (chroma !in 0..3) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    if (chroma == 3) bits.skip(1)
    VideoPolicy.dimensions(bits.ue(), bits.ue())
    if (bits.read(1) == 1) repeat(4) { bits.ue() }
    return checkedDepth(bits)
  }

  private fun avcDepth(bits: Bits): Int {
    val profile = bits.read(8); bits.skip(16); bits.ue()
    if (profile in setOf(66, 77, 88)) return 8
    if (profile !in setOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135, 144)) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    val chroma = bits.ue(); if (chroma !in 0..3) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    if (chroma == 3) bits.skip(1)
    return checkedDepth(bits)
  }

  private fun checkedDepth(bits: Bits): Int {
    val luma = bits.ue() + 8; val chroma = bits.ue() + 8
    if (luma !in 8..16 || luma != chroma) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    return luma
  }

  private class Bits(private val data: ByteArray) {
    private var offset = 0
    fun skip(count: Int) { if (count < 0 || count > data.size * 8 - offset) throw VideoFailure("MALFORMED_VIDEO"); offset += count }
    fun read(count: Int): Int {
      if (count !in 0..30 || count > data.size * 8 - offset) throw VideoFailure("MALFORMED_VIDEO")
      var result = 0; repeat(count) { result = (result shl 1) or ((data[offset / 8].toInt() ushr (7 - offset % 8)) and 1); offset++ }; return result
    }
    fun ue(): Int { var zeros = 0; while (read(1) == 0) { if (++zeros > 29) throw VideoFailure("MALFORMED_VIDEO") }; return (1 shl zeros) - 1 + read(zeros) }
  }
}

/** The tracks of a video that are kept: the first picture track and the first sound track of one or two channels. */
class VideoTracks(val video: Int, val audio: Int?, val format: MediaFormat, val hdr: String, val durationUs: Long, val rotation: Int) {
  val hevc get() = format.getString(MediaFormat.KEY_MIME) == "video/hevc"
  val width get() = format.getInteger(MediaFormat.KEY_WIDTH)
  val height get() = format.getInteger(MediaFormat.KEY_HEIGHT)

  companion object {
    fun open(file: File): MediaExtractor {
      val extractor = MediaExtractor()
      try {
        extractor.setDataSource(file.absolutePath)
        // drmInitData is non-null on some devices for clear camera recordings (a stray crypto-key track entry);
        // real encryption is caught by PSSH here and by SAMPLE_FLAG_ENCRYPTED per sample.
        if (!extractor.psshInfo.isNullOrEmpty()) throw VideoFailure("DRM_UNSUPPORTED")
        return extractor
      } catch (error: Throwable) { extractor.release(); throw error }
    }

    fun inspect(extractor: MediaExtractor): VideoTracks {
      if (extractor.trackCount !in 1..32) throw VideoFailure("UNSUPPORTED_TRACKS")
      val video = ArrayList<Int>(); val audio = ArrayList<Int>()
      for (index in 0 until extractor.trackCount) {
        val mime = extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME) ?: ""
        if (mime.startsWith("video/")) video.add(index)
        if (mime.startsWith("audio/")) audio.add(index)
      }
      // Some phones write extra audio tracks (multi-mic / spatial) or a second video track: keep the first video
      // track and the first audio track with at most two channels; drop the rest.
      if (video.isEmpty()) throw VideoFailure(if (audio.isNotEmpty()) "NO_VIDEO_TRACK" else "UNSUPPORTED_TRACKS")
      val keptAudio = audio.firstOrNull { integer(extractor.getTrackFormat(it), MediaFormat.KEY_CHANNEL_COUNT, 0) in 1..2 } ?: audio.firstOrNull()
      val format = extractor.getTrackFormat(video[0]); val mime = format.getString(MediaFormat.KEY_MIME)
      if (mime !in setOf("video/avc", "video/hevc")) throw VideoFailure("UNSUPPORTED_CODEC")
      VideoPolicy.dimensions(format.getInteger(MediaFormat.KEY_WIDTH), format.getInteger(MediaFormat.KEY_HEIGHT))
      val duration = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0
      if (duration <= 0 || duration > VideoPolicy.MAX_DURATION_US) throw VideoFailure("UNSUPPORTED_DURATION")
      val rotation = (integer(format, MediaFormat.KEY_ROTATION, 0) % 360 + 360) % 360
      if (rotation !in setOf(0, 90, 180, 270)) throw VideoFailure("UNSUPPORTED_TRANSFORM")
      if (format.containsKey("hdr10-plus-info") || integer(format, MediaFormat.KEY_PROFILE, 0) == 8192) throw VideoFailure("DYNAMIC_HDR_UNSUPPORTED")
      // Android only documents muxing this descriptor into WebM, not MP4.
      if (format.containsKey(MediaFormat.KEY_HDR_STATIC_INFO)) throw VideoFailure("HDR_CONTAINER_UNSUPPORTED")
      val hdr = VideoPolicy.hdr(integer(format, MediaFormat.KEY_COLOR_TRANSFER, 0), integer(format, MediaFormat.KEY_COLOR_STANDARD, 0))
      return VideoTracks(video[0], keptAudio, format, hdr, duration, rotation)
    }

    fun integer(format: MediaFormat, key: String, fallback: Int): Int = if (format.containsKey(key)) format.getInteger(key) else fallback

    fun bytes(format: MediaFormat, key: String): ByteArray? {
      val data = (if (format.containsKey(key)) format.getByteBuffer(key)?.duplicate() else null) ?: return null
      if (data.remaining() > VideoPolicy.MAX_SAMPLE) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
      return ByteArray(data.remaining()).also { data.get(it) }
    }

    fun videoFormat(tracks: VideoTracks): MediaFormat {
      val source = tracks.format
      val output = MediaFormat.createVideoFormat(source.getString(MediaFormat.KEY_MIME)!!, source.getInteger(MediaFormat.KEY_WIDTH), source.getInteger(MediaFormat.KEY_HEIGHT))
      var configs = 0; val parameterSets = ArrayList<ByteArray>()
      for (index in 0..2) {
        val key = "csd-$index"; val data = bytes(source, key) ?: continue
        val clean = VideoNal.cleanConfig(data, tracks.hevc, tracks.hdr)
        parameterSets.addAll(VideoNal.annexUnits(clean))
        output.setByteBuffer(key, ByteBuffer.wrap(clean)); configs++
      }
      if (configs == 0) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
      val sps = parameterSets.filter { if (tracks.hevc) ((it[0].toInt() ushr 1) and 63) == 33 else (it[0].toInt() and 31) == 7 }
      if (sps.isEmpty()) throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
      for (nal in sps) VideoPolicy.validateDepth(VideoBits.depth(nal, tracks.hevc), tracks.hdr, integer(source, MediaFormat.KEY_COLOR_TRANSFER, 0) != 0)
      for (key in listOf(MediaFormat.KEY_COLOR_STANDARD, MediaFormat.KEY_COLOR_TRANSFER, MediaFormat.KEY_COLOR_RANGE, "sar-width", "sar-height")) {
        if (source.containsKey(key)) output.setInteger(key, source.getInteger(key))
      }
      return output
    }

    /** Called only for output produced by our fresh AAC encoder. */
    fun audioFormat(source: MediaFormat): MediaFormat {
      val output = MediaFormat.createAudioFormat("audio/mp4a-latm", source.getInteger(MediaFormat.KEY_SAMPLE_RATE), source.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
      val config = bytes(source, "csd-0") ?: throw VideoFailure("AUDIO_CONFIG_FAILED")
      if (config.size !in 2..64) throw VideoFailure("AUDIO_CONFIG_FAILED")
      output.setByteBuffer("csd-0", ByteBuffer.wrap(config))
      for (key in listOf(MediaFormat.KEY_BIT_RATE, MediaFormat.KEY_AAC_PROFILE, MediaFormat.KEY_ENCODER_DELAY, MediaFormat.KEY_ENCODER_PADDING)) {
        if (source.containsKey(key)) output.setInteger(key, source.getInteger(key))
      }
      return output
    }
  }
}

/** Source compressed audio is never copied: only fresh PCM is sent to AAC. */
class VideoAudio(private val input: File, private val track: Int, private val output: File, private val stopped: () -> Boolean) {
  private lateinit var extractor: MediaExtractor
  private var decoder: MediaCodec? = null
  private var encoder: MediaCodec? = null
  private var muxer: MediaMuxer? = null
  private var muxerTrack = -1
  private var inputDone = false
  private var decodedDone = false
  private var encodedDone = false
  private var pending: ByteArray? = null
  private var pendingOffset = 0
  private var pendingTime = 0L
  private var pendingEnd = false
  private var channels = 0
  private var rate = 0
  private var written = 0L
  private val info = MediaCodec.BufferInfo()

  fun run() {
    extractor = VideoTracks.open(input)
    try {
      extractor.selectTrack(track)
      val format = extractor.getTrackFormat(track)
      val name = MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format) ?: throw VideoFailure("AUDIO_DECODER_UNAVAILABLE")
      format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
      decoder = MediaCodec.createByCodecName(name)
      decoder!!.configure(format, null, null, 0); decoder!!.start()
      muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val started = SystemClock.elapsedRealtime(); var lastProgress = started
      while (!encodedDone) {
        if (stopped()) throw VideoFailure("CANCELLED")
        var progress = feedDecoder()
        if (drainDecoder()) progress = true
        if (feedEncoder()) progress = true
        if (drainEncoder()) progress = true
        val now = SystemClock.elapsedRealtime()
        if (progress) lastProgress = now
        if (now - lastProgress > 30000 || now - started > 600000) throw VideoFailure("CODEC_TIMEOUT")
      }
      if (muxerTrack < 0 || written == 0L) throw VideoFailure("AUDIO_ENCODE_FAILED")
      muxer!!.stop()
    } finally {
      runCatching { decoder?.stop() }; runCatching { decoder?.release() }
      runCatching { encoder?.stop() }; runCatching { encoder?.release() }
      runCatching { muxer?.release() }; extractor.release()
    }
  }

  private fun feedDecoder(): Boolean {
    if (inputDone) return false
    val codec = decoder!!; val index = codec.dequeueInputBuffer(1000); if (index < 0) return false
    val buffer = codec.getInputBuffer(index) ?: throw VideoFailure("AUDIO_DECODE_FAILED")
    val size = extractor.readSampleData(buffer, 0)
    // At end of stream getSampleFlags() returns -1, which has every bit set: the encrypted check must only look
    // at real samples, or every clear video with sound is rejected.
    if (size >= 0 && extractor.sampleFlags >= 0 && (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_ENCRYPTED) != 0) throw VideoFailure("DRM_UNSUPPORTED")
    if (size < 0) {
      codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true
    } else {
      val flags = if ((extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_PARTIAL_FRAME) != 0) MediaCodec.BUFFER_FLAG_PARTIAL_FRAME else 0
      codec.queueInputBuffer(index, 0, size, extractor.sampleTime, flags); extractor.advance()
    }
    return true
  }

  private fun startEncoder(format: MediaFormat) {
    if (encoder != null) throw VideoFailure("AUDIO_FORMAT_CHANGED")
    channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT); rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    val pcm = VideoTracks.integer(format, MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
    if (channels !in 1..2 || rate !in 8000..96000 || pcm != AudioFormat.ENCODING_PCM_16BIT) throw VideoFailure("UNSUPPORTED_AUDIO_FORMAT")
    val target = MediaFormat.createAudioFormat("audio/mp4a-latm", rate, channels).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, if (channels == 1) 128000 else 256000)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65536)
    }
    encoder = MediaCodec.createEncoderByType("audio/mp4a-latm")
    encoder!!.configure(target, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE); encoder!!.start()
  }

  private fun drainDecoder(): Boolean {
    if (decodedDone || pending != null) return false
    val codec = decoder!!; val index = codec.dequeueOutputBuffer(info, 1000)
    if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { startEncoder(codec.outputFormat); return true }
    if (index < 0) return false
    try {
      if (info.size < 0 || info.size > VideoPolicy.MAX_SAMPLE) throw VideoFailure("AUDIO_DECODE_FAILED")
      val buffer = codec.getOutputBuffer(index) ?: throw VideoFailure("AUDIO_DECODE_FAILED")
      buffer.position(info.offset); buffer.limit(info.offset + info.size)
      pending = ByteArray(info.size).also { buffer.get(it) }; pendingOffset = 0; pendingTime = info.presentationTimeUs
      pendingEnd = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
      if (pendingEnd) decodedDone = true
    } finally { codec.releaseOutputBuffer(index, false) }
    return true
  }

  private fun feedEncoder(): Boolean {
    val data = pending ?: return false; val codec = encoder ?: return false
    val index = codec.dequeueInputBuffer(1000); if (index < 0) return false
    val buffer = codec.getInputBuffer(index) ?: throw VideoFailure("AUDIO_ENCODE_FAILED")
    buffer.clear(); val frameBytes = channels * 2
    if (data.size % frameBytes != 0) throw VideoFailure("AUDIO_DECODE_FAILED")
    val count = minOf(data.size - pendingOffset, buffer.remaining() / frameBytes * frameBytes)
    if (count == 0 && pendingOffset < data.size) throw VideoFailure("AUDIO_ENCODE_FAILED")
    buffer.put(data, pendingOffset, count)
    val timestamp = pendingTime + pendingOffset.toLong() * 1000000 / (rate.toLong() * frameBytes)
    pendingOffset += count; val complete = pendingOffset == data.size
    codec.queueInputBuffer(index, 0, count, timestamp, if (complete && pendingEnd) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
    if (complete) pending = null
    return true
  }

  private fun drainEncoder(): Boolean {
    val codec = encoder ?: return false; val index = codec.dequeueOutputBuffer(info, 1000)
    if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
      if (muxerTrack >= 0) throw VideoFailure("AUDIO_FORMAT_CHANGED")
      muxerTrack = muxer!!.addTrack(VideoTracks.audioFormat(codec.outputFormat)); muxer!!.start(); return true
    }
    if (index < 0) return false
    try {
      if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
        if (muxerTrack < 0) throw VideoFailure("AUDIO_ENCODE_FAILED")
        written += info.size; if (written > VideoPolicy.MAX_OUTPUT) throw VideoFailure("OUTPUT_TOO_LARGE")
        val buffer = codec.getOutputBuffer(index) ?: throw VideoFailure("AUDIO_ENCODE_FAILED")
        info.presentationTimeUs = maxOf(0, info.presentationTimeUs)
        muxer!!.writeSampleData(muxerTrack, buffer, info)
      }
      if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) encodedDone = true
    } finally { codec.releaseOutputBuffer(index, false) }
    return true
  }
}

/** Writes the cleaned video: the picture's samples copied (each cleaned), the sound encoded anew, a new container. */
class VideoProcessor(private val stopped: () -> Boolean) {
  class Cleaned(val width: Int, val height: Int, val rotation: Int, val durationUs: Long, val hdr: String)

  /** `source` → `output` (a new file). `scratch`: a file for the sound on its way (removed here). Throws a
   *  `VideoFailure`; nothing of the output is left behind then. */
  fun sanitize(source: File, output: File, scratch: File): Cleaned {
    try {
      val extractor = VideoTracks.open(source)
      try {
        val tracks = VideoTracks.inspect(extractor)
        val audio = tracks.audio?.let { index -> scratch.also { VideoAudio(source, index, it, stopped).run(); validateOutput(it) } }
        remux(extractor, tracks, audio, output); validateOutput(output)
        return Cleaned(tracks.width, tracks.height, tracks.rotation, tracks.durationUs, tracks.hdr)
      } finally { extractor.release() }
    } catch (error: Throwable) {
      output.delete()
      throw error as? VideoFailure ?: if (error is OutOfMemoryError) VideoFailure("OUT_OF_MEMORY") else VideoFailure("PROCESSING_FAILED")
    } finally {
      scratch.delete()
    }
  }

  private fun validateOutput(file: File) {
    if (file.length() <= 0) throw VideoFailure("WRITE_FAILED")
    if (file.length() > VideoPolicy.MAX_OUTPUT) throw VideoFailure("OUTPUT_TOO_LARGE")
  }

  private fun remux(video: MediaExtractor, tracks: VideoTracks, audioFile: File?, output: File) {
    val videoFormat = VideoTracks.videoFormat(tracks)
    var audio: MediaExtractor? = null; var muxer: MediaMuxer? = null
    try {
      audio = audioFile?.let { VideoTracks.open(it) }
      muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val videoTrack = muxer.addTrack(videoFormat)
      val audioTrack = audio?.let {
        if (it.trackCount != 1) throw VideoFailure("AUDIO_ENCODE_FAILED")
        it.selectTrack(0); muxer.addTrack(VideoTracks.audioFormat(it.getTrackFormat(0)))
      }
      muxer.setOrientationHint(tracks.rotation); muxer.start(); video.selectTrack(tracks.video)
      copyTrack(video, muxer, videoTrack, tracks)
      if (audio != null && audioTrack != null) copyTrack(audio, muxer, audioTrack, null)
      muxer.stop()
    } finally { runCatching { muxer?.release() }; audio?.release() }
  }

  private fun copyTrack(extractor: MediaExtractor, muxer: MediaMuxer, track: Int, video: VideoTracks?) {
    val buffer = ByteBuffer.allocateDirect(VideoPolicy.MAX_SAMPLE); val info = MediaCodec.BufferInfo()
    var written = 0L; var samples = 0; val started = SystemClock.elapsedRealtime()
    while (true) {
      if (stopped()) throw VideoFailure("CANCELLED")
      buffer.clear(); val size = extractor.readSampleData(buffer, 0); if (size < 0) break
      if (size <= 0 || size > VideoPolicy.MAX_SAMPLE || ++samples > VideoPolicy.MAX_SAMPLES) throw VideoFailure("MALFORMED_VIDEO")
      if (extractor.sampleFlags and (MediaExtractor.SAMPLE_FLAG_ENCRYPTED or MediaExtractor.SAMPLE_FLAG_PARTIAL_FRAME) != 0) throw VideoFailure("UNSUPPORTED_SAMPLE")
      val timestamp = extractor.sampleTime
      if (timestamp < 0 || timestamp > VideoPolicy.MAX_DURATION_US) throw VideoFailure("UNSUPPORTED_TIMESTAMP")
      val source = ByteArray(size); buffer.position(0); buffer.get(source)
      val clean = if (video != null) VideoNal.cleanSample(source, video.hevc, video.hdr) else source
      written += clean.size; if (written > VideoPolicy.MAX_OUTPUT) throw VideoFailure("OUTPUT_TOO_LARGE")
      if (clean.isNotEmpty()) {
        info.set(0, clean.size, timestamp, extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC)
        muxer.writeSampleData(track, ByteBuffer.wrap(clean), info)
      }
      if (SystemClock.elapsedRealtime() - started > 600000) throw VideoFailure("CODEC_TIMEOUT")
      extractor.advance()
    }
    if (samples == 0) throw VideoFailure("EMPTY_TRACK")
  }
}

/** What the system's muxer itself writes into a new MP4 and a receiver has no use for: the moment the file was
 *  made (in the movie's, the tracks' and the media headers) and its own notes (`udta`, `meta` — the muxer puts
 *  the phone's Android version there). The dates are zeroed and the notes become free space, in place: no byte
 *  of the picture or the sound moves. Reference: mobile/src/media/mp4.ts (`dates`, `PRIVATE`). */
object Mp4Scrub {
  private class Box(val type: String, val start: Long, val header: Int, val size: Long)

  private fun type(bytes: ByteArray, at: Int) = String(bytes, at, 4, Charsets.ISO_8859_1)
  private fun u32(bytes: ByteArray, at: Int): Long =
    ((bytes[at].toLong() and 255) shl 24) or ((bytes[at + 1].toLong() and 255) shl 16) or ((bytes[at + 2].toLong() and 255) shl 8) or (bytes[at + 3].toLong() and 255)

  /** The boxes inside `bytes[from, to)`; null when they do not add up. */
  private fun boxes(bytes: ByteArray, from: Int, to: Int): List<Box>? {
    val out = ArrayList<Box>(); var at = from
    while (at < to) {
      if (to - at < 8) return null
      var size = u32(bytes, at); var header = 8
      if (size == 1L) {
        if (to - at < 16) return null
        if (u32(bytes, at + 8) != 0L) return null
        size = u32(bytes, at + 12); header = 16
      } else if (size == 0L) size = (to - at).toLong()
      if (size < header || size > to - at) return null
      out.add(Box(type(bytes, at + 4), at.toLong(), header, size)); if (out.size > 100_000) return null
      at += size.toInt()
    }
    return out
  }

  private val containers = setOf("moov", "trak", "mdia", "minf", "stbl", "edts", "dinf")
  private val notes = setOf("udta", "meta")

  /** Scrubs a whole `moov` box held in memory (its bytes from the size field on). False: not a box it can read. */
  fun scrubMovie(moov: ByteArray): Boolean {
    val top = boxes(moov, 0, moov.size) ?: return false
    if (top.size != 1 || top[0].type != "moov") return false
    return walk(moov, top[0], 0)
  }

  private fun walk(bytes: ByteArray, box: Box, depth: Int): Boolean {
    if (depth > 8) return false
    val inner = boxes(bytes, (box.start + box.header).toInt(), (box.start + box.size).toInt()) ?: return false
    for (child in inner) {
      val data = (child.start + child.header).toInt(); val end = (child.start + child.size).toInt()
      when {
        child.type in notes -> {
          "free".toByteArray(Charsets.ISO_8859_1).copyInto(bytes, child.start.toInt() + 4)
          java.util.Arrays.fill(bytes, data, end, 0)
        }
        child.type == "mvhd" || child.type == "tkhd" || child.type == "mdhd" -> {
          if (end - data < 4) return false
          val version = bytes[data].toInt()
          // Version 0: two 32-bit moments; version 1: two 64-bit ones.
          val dates = if (version == 0) 8 else if (version == 1) 16 else return false
          if (end - data < 4 + dates) return false
          java.util.Arrays.fill(bytes, data + 4, data + 4 + dates, 0)
        }
        child.type in containers -> if (!walk(bytes, child, depth + 1)) return false
      }
    }
    return true
  }

  /** Scrubs the file in place. False: the file is not an MP4 this can read (it must not be sent then). */
  fun scrub(file: File): Boolean = try {
    java.io.RandomAccessFile(file, "rw").use { handle ->
      val length = handle.length(); var at = 0L; var found = false
      val head = ByteArray(16)
      while (at < length) {
        if (length - at < 8) return false
        handle.seek(at); handle.readFully(head, 0, 8)
        var size = u32(head, 0); var header = 8
        if (size == 1L) {
          if (length - at < 16) return false
          handle.readFully(head, 8, 8)
          if (u32(head, 8) > 0x7FFFFFFFL) return false
          size = (u32(head, 8) shl 32) or u32(head, 12); header = 16
        } else if (size == 0L) size = length - at
        if (size < header || size > length - at) return false
        val name = type(head, 4)
        if (name == "moov") {
          // A movie header of a size no real file has is not read into memory.
          if (size > 256L * 1024 * 1024) return false
          val moov = ByteArray(size.toInt())
          handle.seek(at); handle.readFully(moov)
          // A 64-bit size field is rewritten as it was: only what `scrubMovie` touches changes.
          if (header == 16) return false
          if (!scrubMovie(moov)) return false
          handle.seek(at); handle.write(moov)
          found = true
        } else if (name in notes || name == "uuid") {
          // Notes beside the movie: free space as well.
          handle.seek(at + 4); handle.write("free".toByteArray(Charsets.ISO_8859_1))
          val zeros = ByteArray(64 * 1024); var left = size - header
          handle.seek(at + header)
          while (left > 0) { val count = minOf(left, zeros.size.toLong()).toInt(); handle.write(zeros, 0, count); left -= count }
        }
        at += size
      }
      found
    }
  } catch (_: Exception) { false }
}
