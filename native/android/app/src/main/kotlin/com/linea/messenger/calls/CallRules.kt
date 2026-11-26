package com.linea.messenger.calls

import com.linea.messenger.core.Core
import com.linea.messenger.people.Person

/** One call as the screens show it (the reference's `CallState` in CallProvider.tsx). */
data class CallState(
  val id: String,
  val chatId: String,
  val peer: Person,
  /** The other side placed it. */
  val incoming: Boolean,
  val video: Boolean,
  /** "requesting", "ringing", "incoming", "connecting", "active" or "ended" (`CallStatus` of the reference). */
  val status: String,
  val speaker: Boolean,
  val muted: Boolean = false,
  val cameraOff: Boolean = false,
  /** When the media connected (milliseconds since 1970); null before that. */
  val startedAt: Double? = null,
  val endedText: String = "",
  /** The four emoji both sides see once the keys of the media are known. */
  val key: List<String>? = null,
  /** The other side's first SDP (its fingerprints are the ones the key was made of). */
  val remoteSdp: String? = null,
  val minimized: Boolean = false,
  /** "good", "weak" or "bad": how the link is doing right now. */
  val grade: String = "good",
  /** «Восстановление связи…»: the media dropped mid-call and an ICE restart is under way. */
  val reconnecting: Boolean = false,
  /** Ended without a connection («Нет соединения»): the screen stays with «Повторить». */
  val retry: Boolean = false,
  /** This phone's camera is sending / the other side's picture is arriving. */
  val localVideo: Boolean = false,
  val remoteVideo: Boolean = false,
) {
  val isOver: Boolean get() = status == "ended"
}

/** The ids of calls the other side has already ended; the oldest are forgotten past `limit`. */
class EndedCalls(private val limit: Int = 200) {
  private val ids = LinkedHashSet<String>()
  fun add(id: String) {
    ids.add(id)
    while (ids.size > limit) ids.remove(ids.first())
  }
  operator fun contains(id: String): Boolean = id in ids
}

/** The rules of calls, asked of the shared core (native/core/src/calls.rs — a port of the reference's
 *  callModel.ts, reconnect.ts, callStatus.ts and callLog.ts, the same on both phones). Nothing here decides
 *  anything by itself. */
object CallRules {
  private val limits: Map<String, Any?> by lazy { Core.map(Core.view("callRules", emptyList())) ?: emptyMap() }
  private fun ms(key: String, otherwise: Long): Long = (limits[key] as? Number)?.toLong() ?: otherwise

  /** A call rings for a minute, then ends by itself (both sides). Milliseconds, as every time here. */
  val ringTimeout: Long get() = ms("ringTimeoutMs", 60_000)
  /** How long a call placed offline waits for the connection. */
  val networkWait: Long get() = ms("networkWaitMs", 20_000)
  /** How long the servers of the last call may be used again when fresh ones cannot be asked for. */
  val iceReuse: Long get() = ms("iceReuseMs", 14_400_000)
  /** The height of the bar of a minimised call, dp. */
  val barHeight: Float get() = (limits["barHeight"] as? Number)?.toFloat() ?: 36f
  val noConnectionText: String get() = limits["noConnectionText"] as? String ?: "Нет соединения"

  val nowMs: Double get() = System.currentTimeMillis().toDouble()

  /** How fast the network was measured to be: "slow", "medium" or "fast". The app does not measure it yet, so
   *  economy voice (callEconomySdp) is not switched on by the network's speed — only the live link's grade
   *  lowers the bitrates. */
  const val tier = "fast"

  fun flag(name: String, args: List<Any?>): Boolean = Core.view(name, args) as? Boolean ?: false
  fun words(name: String, args: List<Any?>): String? = Core.view(name, args) as? String
  fun fields(name: String, args: List<Any?>): Map<String, Any?> = Core.map(Core.view(name, args)) ?: emptyMap()

  class Status(val text: String, val clock: String?, val tone: String)

  /** The status line, the clock next to it in the bar, and the bar's tone, for a call as it is now. */
  fun status(call: CallState, network: String, now: Double = nowMs): Status {
    val input = mapOf<String, Any?>("status" to call.status, "incoming" to call.incoming, "video" to call.video, "reconnecting" to call.reconnecting,
      "endedText" to call.endedText, "network" to network, "now" to now, "startedAt" to call.startedAt)
    val answer = fields("callStatus", listOf(input))
    return Status(answer["text"] as? String ?: "", answer["clock"] as? String, answer["tone"] as? String ?: "pending")
  }

  /** «слабая связь» / «плохая связь», or nothing for a good link. */
  fun linkWords(grade: String): String = fields("callCaps", listOf(tier, grade))["text"] as? String ?: ""

  /** The `end` every phone sends for a call: the outcome, video or not, who placed it, how long it lasted. */
  fun end(call: CallState, reason: String): Map<String, Any?> = end(call.id, call.video, call.incoming, call.startedAt, reason)

  fun end(id: String, video: Boolean, incoming: Boolean, startedAt: Double?, reason: String, now: Double = nowMs): Map<String, Any?> =
    fields("callEnd", listOf(mapOf("id" to id, "video" to video, "incoming" to incoming, "startedAt" to startedAt), reason, now))

  /** What the call's audio is told about the loudspeaker (the reference's `speakerRoute`): true — force the
   *  loudspeaker, false — force the phone's earpiece, null — the system's own route (headphones when connected).
   *  «Динамик» off goes back to the system's route, except in a video call, whose own route is the loudspeaker. */
  fun speakerRoute(chosen: Boolean?, video: Boolean): Boolean? {
    if (chosen == null) return null
    if (chosen) return true
    return if (video) false else null
  }

  /** The words a call ends with when the other side's `end` arrives (CallProvider.tsx, onCallSignal). */
  fun endedWords(reason: String?): String = when (reason) {
    "declined" -> "Звонок отклонён"
    "busy" -> "Собеседник занят"
    "missed" -> "Пропущенный звонок"
    else -> "Звонок завершён"
  }

  /** The colour of the bar of a minimised call by its tone (0xAARRGGBB): green while the call is up, orange
   *  while it reconnects or waits, blue before it connects. */
  fun barColor(tone: String): Int = when (tone) {
    "active" -> 0xFF2BA36B.toInt()
    "trouble" -> 0xFFD9822B.toInt()
    "pending" -> 0xFF3B6FB6.toInt()
    else -> 0xFF6B7280.toInt()
  }

  /** Which buttons the call screen shows, as their words in order (the screen builds them again only when this changes). */
  fun buttons(call: CallState): List<String> = when {
    call.status == "incoming" -> listOf("Отклонить", "Ответить")
    call.isOver -> if (call.retry) listOf("Закрыть", "Повторить") else emptyList()
    else -> listOfNotNull("Динамик", "Видео", if (call.video && !call.cameraOff) "Повернуть" else null, if (call.muted) "Звук выкл" else "Убрать звук", "Завершить")
  }

  /** Where the call sounds: "speaker", "earpiece", "bluetooth" or "wired". `forced` true: the loudspeaker;
   *  false: the phone's earpiece; null: the system's own route — Bluetooth or wired headphones when they are
   *  connected, else the earpiece (a video call: the loudspeaker). */
  fun soundRoute(forced: Boolean?, video: Boolean, bluetooth: Boolean, wired: Boolean): String = when {
    forced == true -> "speaker"
    forced == false -> "earpiece"
    bluetooth -> "bluetooth"
    wired -> "wired"
    video -> "speaker"
    else -> "earpiece"
  }

  /** The public address finder: what a call is left with when the server gives it no servers of its own. */
  val publicIce = listOf(mapOf<String, Any?>("urls" to listOf("stun:stun.l.google.com:19302")))

  /** The servers a call uses: the fresh ones; without them those of the last call while they may be used again;
   *  else the public address finder alone. */
  fun iceChoice(fresh: List<Map<String, Any?>>?, kept: Pair<Long, List<Map<String, Any?>>>?, nowMs: Long, reuseMs: Long): List<Map<String, Any?>> {
    if (fresh != null) return fresh
    if (kept != null && nowMs - kept.first < reuseMs) return kept.second
    return publicIce
  }

  /** The name a step is remembered by, so that the same message is acted on once; null when it has none. */
  fun stepKey(message: Map<String, Any?>): String? {
    val id = (message["id"] as? Number)?.toLong()
    if (id != null && id > 0) return "id:$id"
    val clientId = message["clientId"] as? String ?: return null
    return (message["senderId"] as? String ?: "") + ":" + clientId
  }
}
