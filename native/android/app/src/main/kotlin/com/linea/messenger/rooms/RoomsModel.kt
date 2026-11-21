package com.linea.messenger.rooms

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.people.Person
import java.time.Instant
import java.time.ZoneId

/** Somebody who is inside a room right now (`VoiceMember` of the reference). */
data class RoomInside(val userId: String, val muted: Boolean)

/** A room («комната»): a lasting voice room for a fixed set of friends, outside communities (`Room` of the
 *  reference's rooms.ts). The server keeps only the name and the list of members; who is inside is live. */
data class Room(
  val id: String,
  val name: String,
  /** The name was made from the members' names (nobody renamed the room). */
  val auto: Boolean,
  val members: List<Person>,
  val inside: List<RoomInside>,
  /** Somebody is inside, or the last one left less than five minutes ago. */
  val awake: Boolean,
  /** Empty when nobody has been in the room yet. */
  val lastActiveAt: String,
  val createdAt: String,
) {
  companion object {
    /** Null for what is not a room (no id). */
    fun from(raw: Any?): Room? {
      val fields = Core.map(raw as? Map<*, *>) ?: return null
      val id = fields["id"] as? String ?: return null
      if (id.isEmpty()) return null
      val inside = (fields["inside"] as? List<*>).orEmpty().mapNotNull { item ->
        val member = Core.map(item as? Map<*, *>) ?: return@mapNotNull null
        val userId = member["userId"] as? String ?: return@mapNotNull null
        RoomInside(userId, member["muted"] as? Boolean ?: false)
      }
      return Room(id, fields["name"] as? String ?: "", fields["auto"] as? Boolean ?: false, Person.list(fields["members"]), inside,
        fields["awake"] as? Boolean ?: false, fields["lastActiveAt"] as? String ?: "", fields["createdAt"] as? String ?: "")
    }
  }
}

/** «Зовёт в комнату»: the call that is ringing right now. */
data class RoomRing(
  val roomId: String,
  val name: String,
  val from: Person,
  /** When it arrived, milliseconds since 1970. */
  val at: Double,
) {
  companion object {
    fun from(raw: Any?): RoomRing? {
      val fields = Core.map(raw as? Map<*, *>) ?: return null
      val roomId = fields["roomId"] as? String ?: return null
      val from = Person.from(fields["from"]) ?: return null
      return RoomRing(roomId, fields["name"] as? String ?: "", from, (fields["at"] as? Number)?.toDouble() ?: 0.0)
    }
  }
}

/** The rules of rooms, asked of the shared core (native/core/src/rooms.rs — a port of the reference's rooms.ts,
 *  voiceAuth.ts and the music wire of roomMusic.tsx, the same on both phones). Nothing here decides by itself. */
object RoomRules {
  private val rules: Map<String, Any?> by lazy { Core.map(Core.view("roomRules", emptyList())) ?: emptyMap() }
  private fun number(key: String, otherwise: Double): Double = (rules[key] as? Number)?.toDouble() ?: otherwise

  /** Members of a room, this account included. */
  val limit: Int get() = number("limit", 12.0).toInt()
  val maxName: Int get() = number("maxName", 48.0).toInt()
  /** How long «зовёт в комнату» rings before it gives up by itself, ms. */
  val ringTime: Long get() = number("ringMs", 30_000.0).toLong()
  /** A connection whose end-to-end check has not come in this time is refused, ms. */
  val authTimeout: Long get() = number("authTimeoutMs", 20_000.0).toLong()
  val linkPoll: Long get() = number("linkPollMs", 4_000.0).toLong()
  val speakingPoll: Long get() = number("speakingPollMs", 350.0).toLong()
  val speakingLevel: Double get() = number("speakingLevel", 0.02)
  val musicDrift: Double get() = number("musicDrift", 2.5)
  val musicBeat: Long get() = number("musicBeatMs", 4_000.0).toLong()
  val musicOff: String get() = rules["musicOff"] as? String ?: "{\"type\":\"music\",\"off\":true}"
  val refused: String get() = rules["refused"] as? String ?: "Не удалось подтвердить шифрование с участником — соединение с ним отключено."
  /** The green of «somebody is inside» and «is talking», `#RRGGBB`. */
  val talkHex: String get() = rules["talk"] as? String ?: "#3EE08E"
  /** The same as 0xAARRGGBB. */
  val talk: Int get() = 0xFF000000.toInt() or Messenger.color(talkHex)

  val nowMs: Double get() = System.currentTimeMillis().toDouble()

  /** «трое внутри» for 3, «5 внутри» above four. */
  fun insideLine(count: Int): String = Core.view("roomInsideLine", listOf(count)) as? String ?: "$count внутри"

  /** «спит · были вчера в 18:20». The phone says what only it knows about its time zone. */
  fun sleepLine(room: Room, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val nowMs = now.toEpochMilli().toDouble()
    val at = if (room.lastActiveAt.isEmpty()) null else Messenger.date(room.lastActiveAt)
    if (at == null) return Core.view("roomSleepLine", listOf(null, nowMs, 0, 0, 0)) as? String ?: "спит"
    val midnightAt = at.atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli().toDouble()
    val midnightNow = now.atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli().toDouble()
    val offset = zone.rules.getOffset(at).totalSeconds / 60.0
    return Core.view("roomSleepLine", listOf(room.lastActiveAt, nowMs, midnightAt, midnightNow, offset)) as? String ?: "спит"
  }

  /** Where everyone sits, as fractions of the stage (the centre of each picture): this account in the middle,
   *  the others around it — always in the same places for the same people. */
  fun seats(room: Room, me: String): Map<String, Pair<Double, Double>> {
    val source = mapOf("id" to room.id, "members" to room.members.map { mapOf("id" to it.id) })
    val out = LinkedHashMap<String, Pair<Double, Double>>()
    for (item in (Core.view("roomSeats", listOf(source, me)) as? List<*>).orEmpty()) {
      val seat = Core.map(item as? Map<*, *>) ?: continue
      val id = seat["id"] as? String ?: continue
      val x = (seat["x"] as? Number)?.toDouble() ?: continue
      val y = (seat["y"] as? Number)?.toDouble() ?: continue
      out[id] = Pair(x, y)
    }
    return out
  }

  /** The size of a picture (dp) for a room of this many people on a stage this wide (dp). */
  fun seatSize(members: Int, stage: Float): Float = (Core.view("roomSeatSize", listOf(members, stage.toDouble())) as? Number)?.toFloat() ?: 58f

  /** The first name of a person, as the room shows it under the picture. */
  fun firstName(person: Person): String = person.displayName.split(' ', '\t', '\n').firstOrNull { it.isNotEmpty() } ?: person.displayName

  /** The core keeps the reference's own words for a caller it cannot name; the app has one word for friends. */
  fun callerName(person: Person): String = if (person.displayName == "Кто-то из своих") "Кто-то из друзей" else person.displayName

  /** The bar's line: «Походники · Комната · 4 внутри» (this phone and the people its voice flows with). */
  fun barLine(voice: RoomVoiceState): String {
    var line = voice.name + " · Комната"
    if (voice.status == "connected") line += " · ${voice.peers.count { it.connected } + 1} внутри"
    return line
  }

  /** The words under a room's name on its screen. `inside`: how many are inside as this phone counts them. */
  fun statusLine(room: Room, voice: RoomVoiceState?, inside: Int, linkWords: (String) -> String): String {
    if (voice != null) {
      if (voice.status != "connected") return "подключение…"
      val link = if (voice.link == "good") "" else linkWords(voice.link)
      return "комната · " + insideLine(inside) + if (link.isEmpty()) "" else " · $link"
    }
    if (room.inside.isNotEmpty()) return "комната · " + insideLine(room.inside.size)
    return if (room.awake) "комната · никого, ещё не спит" else sleepLine(room)
  }
}
