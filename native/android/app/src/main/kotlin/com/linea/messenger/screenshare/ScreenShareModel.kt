package com.linea.messenger.screenshare

import org.json.JSONObject

// Screen sharing in a voice channel: the reference's communities/screenShareModel.ts, word for word where it has words
// (iOS ScreenShare/ScreenShareModel.swift).

/** The two qualities the reference offers (`SCREEN_QUALITIES`): the size the picture is scaled to (its long edge), sixty
 *  frames a second, and the most bits a second the picture may take. */
enum class ScreenQuality(val raw: String, val width: Int, val height: Int, val maxBitrate: Int) {
  P720("720p60", 1280, 720, 4_000_000),
  P1080("1080p60", 1920, 1080, 8_000_000);

  val frameRate: Int get() = 60
  /** «720p · 60 FPS» / «1080p · 60 FPS», as the panel says it. */
  val label: String get() = if (this == P720) "720p · 60 FPS" else "1080p · 60 FPS"

  companion object {
    /** `screenQuality`: only the two known values. */
    fun parse(value: Any?): ScreenQuality? = entries.firstOrNull { it.raw == value }
  }
}

object ScreenShareModel {
  /** The sound of a shared computer, bits a second (`SCREEN_AUDIO_BITRATE`). */
  const val SCREEN_AUDIO_BITRATE = 128_000

  /** `screenControl`: `{"type":"screen","active":…,"quality":…}` from a person's peer-to-peer channel, or null. */
  fun control(raw: String): Pair<Boolean, ScreenQuality>? {
    if (raw.length > 256) return null
    val value = try { JSONObject(raw) } catch (_: Exception) { return null }
    if (value.opt("type") != "screen") return null
    val active = value.opt("active") as? Boolean ?: return null
    val quality = ScreenQuality.parse(value.opt("quality")) ?: return null
    return active to quality
  }

  /** The words of a peer-to-peer channel message (JSON). */
  fun json(value: Map<String, Any?>): String = JSONObject(value).toString()

  /** `stereoScreenAudio`: stereo for the shared computer's sound. Opus sends stereo only when the other side's SDP says
   *  stereo=1 (RFC 7587 §6.1); only the second audio section is marked — the reserved slot for the computer's sound. The
   *  microphone stays mono voice. */
  fun stereoScreenAudio(sdp: String, bitrate: Int = SCREEN_AUDIO_BITRATE): String {
    if (sdp.isEmpty()) return sdp
    val eol = if (sdp.contains("\r\n")) "\r\n" else "\n"
    val lines = sdp.split(eol).toMutableList()
    val starts = lines.indices.filter { lines[it].startsWith("m=") }
    val audio = starts.filter { lines[it].startsWith("m=audio") }
    if (audio.size < 2) return sdp
    val start = audio[1]
    val end = starts.firstOrNull { it > start } ?: lines.size
    val section = lines.subList(start, end).toMutableList()
    var payload: String? = null
    for (line in section) {
      if (!line.lowercase().startsWith("a=rtpmap:")) continue
      val rest = line.substring("a=rtpmap:".length)
      val space = rest.indexOf(' ')
      if (space <= 0) continue
      val number = rest.substring(0, space)
      if (number.all { it.isDigit() } && rest.substring(space + 1).lowercase().startsWith("opus/48000/2")) { payload = number; break }
    }
    val pt = payload ?: return sdp
    val wanted = listOf("stereo" to "1", "sprop-stereo" to "1", "maxaveragebitrate" to bitrate.toString())
    fun merge(existing: String): String {
      val keys = ArrayList<String>(); val values = HashMap<String, String>()
      for (part in existing.split(";")) {
        val item = part.trim()
        if (item.isEmpty()) continue
        val equal = item.indexOf('=')
        val key = if (equal >= 0) item.substring(0, equal) else item
        val value = if (equal >= 0) item.substring(equal + 1) else ""
        if (!values.containsKey(key)) keys.add(key)
        values[key] = value
      }
      for ((key, value) in wanted) { if (!values.containsKey(key)) keys.add(key); values[key] = value }
      return keys.joinToString(";") { key -> val value = values[key] ?: ""; if (value.isEmpty()) key else "$key=$value" }
    }
    val fmtp = "a=fmtp:$pt "
    val at = section.indexOfFirst { it.startsWith(fmtp) }
    if (at >= 0) section[at] = fmtp + merge(section[at].substring(fmtp.length))
    else {
      val after = section.indexOfFirst { it.startsWith("a=rtpmap:$pt ") } + 1
      section.add(after, fmtp + merge(""))
    }
    return (lines.subList(0, start) + section + lines.subList(end, lines.size)).joinToString(eol)
  }
}
