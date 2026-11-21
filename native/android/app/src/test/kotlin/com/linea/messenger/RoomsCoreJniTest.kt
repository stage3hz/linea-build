package com.linea.messenger

import com.linea.messenger.core.Core
import com.linea.messenger.people.Person
import com.linea.messenger.rooms.Room
import com.linea.messenger.rooms.RoomRing
import com.linea.messenger.rooms.RoomRules
import com.linea.messenger.rooms.RoomVoicePeer
import com.linea.messenger.rooms.RoomVoiceState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** Rooms: Kotlin ↔ the core through JNI, for real — the names and the arguments the app asks the rules of rooms with
 *  (`Core.view`, as on a phone), in the core built for this machine (native/android/build-core-host.sh). Skipped
 *  when that library has not been built. The rules themselves are pinned to the reference in the core's own tests
 *  (tests/rooms_vectors.rs). */
class RoomsCoreJniTest {
  private fun member(id: String, name: String) = mapOf("id" to id, "username" to id, "displayName" to name, "avatarColor" to "#5B8DEF", "avatarId" to null)

  private fun room(id: String, inside: List<String> = emptyList(), awake: Boolean = false, lastActiveAt: String? = null, members: List<Map<String, Any?>> = listOf(member("me", "Стейдж"), member("u1", "Лариса Орлова"), member("u2", "Тимур Ахметов"))) =
    mapOf("id" to id, "name" to "Комната $id", "auto" to false, "members" to members, "inside" to inside.map { mapOf("userId" to it, "muted" to false) },
      "awake" to awake, "lastActiveAt" to lastActiveAt, "createdAt" to "2026-11-01T10:00:00.000Z")

  private val sdpA = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB:CC:DD\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
  private val sdpB = "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 11:22:33:44\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"

  @Test fun theLimitsAreTheCores() {
    assumeTrue(Core.loaded)
    assertEquals(12, RoomRules.limit)
    assertEquals(48, RoomRules.maxName)
    assertEquals(30_000L, RoomRules.ringTime)
    assertEquals(20_000L, RoomRules.authTimeout)
    assertEquals(4_000L, RoomRules.linkPoll)
    assertEquals(350L, RoomRules.speakingPoll)
    assertEquals(0.02, RoomRules.speakingLevel, 0.0)
    assertEquals(2.5, RoomRules.musicDrift, 0.0)
    assertEquals(4_000L, RoomRules.musicBeat)
    assertEquals("{\"type\":\"music\",\"off\":true}", RoomRules.musicOff)
    assertEquals("#3EE08E", RoomRules.talkHex)
    assertEquals(0xFF3EE08E.toInt(), RoomRules.talk)
    assertEquals("Не удалось подтвердить шифрование с участником — соединение с ним отключено.", RoomRules.refused)
    // An unknown name or arguments of the wrong kind: no answer.
    assertNull(Core.view("roomNothing", emptyList()))
    assertNull(Core.view("roomSeats", listOf("words")))
  }

  @Test fun theWordsOfTheList() {
    assumeTrue(Core.loaded)
    assertEquals(listOf("никого внутри", "один внутри", "двое внутри", "трое внутри", "четверо внутри", "5 внутри", "11 внутри"), listOf(0, 1, 2, 3, 4, 5, 11).map { RoomRules.insideLine(it) })
    val zone = ZoneId.of("Europe/Moscow")
    val now = Instant.parse("2026-11-21T12:00:00Z")
    fun line(stamp: String?) = RoomRules.sleepLine(Room.from(room("r", lastActiveAt = stamp))!!, now, zone)
    assertEquals("спит · ещё никто не заходил", line(null))
    // 15:20 UTC is 18:20 in Moscow.
    assertEquals("спит · были вчера в 18:20", line("2026-11-20T15:20:00.000Z"))
    assertEquals("спит · были сегодня в 09:05", line("2026-11-21T06:05:00.000Z"))
    assertEquals("спит · были 3 ноября", line("2026-11-03T09:00:00.000Z"))
  }

  @Test fun theOrderAndTheEventsOfTheList() {
    assumeTrue(Core.loaded)
    val list = listOf(room("sleeping", lastActiveAt = "2026-11-10T10:00:00.000Z"), room("busy", inside = listOf("u1", "u2")), room("awake", awake = true), room("one", inside = listOf("u1")))
    val sorted = (Core.view("roomSort", listOf(list)) as List<*>).map { Core.map(it)!!["id"] }
    assertEquals(listOf("busy", "one", "awake", "sleeping"), sorted)

    // A ring from a member: the picture comes from the room's own list; never one's own ring.
    val held = mapOf("openId" to null, "rooms" to list, "ring" to null)
    val rang = Core.map(Core.view("roomEvent", listOf(held, mapOf("type" to "room.ring", "roomId" to "one", "fromId" to "u1", "name" to "Комната one"), "me", 1000.0)))!!
    val ring = RoomRing.from(rang["ring"])!!
    assertEquals(listOf("one", "Лариса Орлова", 1000.0), listOf(ring.roomId, ring.from.displayName, ring.at))
    val own = Core.map(Core.view("roomEvent", listOf(held, mapOf("type" to "room.ring", "roomId" to "one", "fromId" to "me"), "me", 1000.0)))!!
    assertNull(own["ring"])
    // A caller the room does not list: the core's words, and the app's one word for friends.
    val stranger = Core.map(Core.view("roomEvent", listOf(held, mapOf("type" to "room.ring", "roomId" to "nowhere", "fromId" to "u9"), "me", 1000.0)))!!
    assertEquals("Кто-то из друзей", RoomRules.callerName(RoomRing.from(stranger["ring"])!!.from))
    // Walking in stops the ring; a room that is gone leaves the list.
    val inside = Core.map(Core.view("roomEvent", listOf(rang, mapOf("type" to "room.state", "roomId" to "one", "inside" to listOf(mapOf("userId" to "u1", "muted" to false), mapOf("userId" to "me", "muted" to false)), "awake" to true), "me", 2000.0)))!!
    assertNull(inside["ring"])
    assertEquals(2, Room.from((inside["rooms"] as List<*>).first { Core.map(it)!!["id"] == "one" })!!.inside.size)
    val removed = Core.map(Core.view("roomEvent", listOf(held, mapOf("type" to "room.removed", "roomId" to "busy"), "me", 0.0)))!!
    assertEquals(listOf("sleeping", "awake", "one"), (removed["rooms"] as List<*>).map { Core.map(it)!!["id"] })
    // Not about rooms: no answer.
    assertNull(Core.map(Core.view("roomEvent", listOf(held, mapOf("type" to "voice.joined"), "me", 0.0))))
  }

  @Test fun aGroupCallFromTheChats() {
    assumeTrue(Core.loaded)
    assertEquals(mapOf("ids" to listOf("u1", "u2")), Core.map(Core.view("roomCallCheck", listOf(listOf("u1", "me", "u2", "u1"), "me"))))
    assertEquals(mapOf("error" to "Выбери хотя бы двоих: одному звонят обычным звонком."), Core.map(Core.view("roomCallCheck", listOf(listOf("u1"), "me"))))
    assertEquals(mapOf("error" to "В комнате максимум 12 человек."), Core.map(Core.view("roomCallCheck", listOf((1..12).map { "u$it" }, "me"))))
  }

  @Test fun everyoneSitsInTheSamePlace() {
    assumeTrue(Core.loaded)
    val made = Room.from(room("r1"))!!
    val seats = RoomRules.seats(made, "me")
    assertEquals(listOf("me", "u1", "u2"), seats.keys.sorted())
    assertEquals(Pair(0.5, 0.5), seats["me"])
    for ((_, place) in seats) assertTrue(place.first in 0.0..1.0 && place.second in 0.0..1.0)
    assertEquals(seats, RoomRules.seats(made, "me"))
    assertEquals(86f, RoomRules.seatSize(3, 360f), 0f)
    assertEquals(88f, RoomRules.seatSize(5, 620f), 0f)
    assertEquals(58f, RoomRules.seatSize(12, 620f), 0f)
  }

  @Test fun theCheckOfAConnection() {
    assumeTrue(Core.loaded)
    // What A sends B, and what B checks it against (B's local SDP is A's remote one).
    val text = Core.view("roomAuthText", listOf("room-1", "peer-a", "peer-b", sdpA, sdpB)) as String
    val fine = mapOf("channelId" to "room-1", "self" to "peer-b", "peer" to "peer-a", "localSdp" to sdpB, "remoteSdp" to sdpA)
    assertEquals(true, Core.view("roomCheckAuth", listOf(text, fine)))
    // Another fingerprint (the server in the middle), another room, another connection: refused.
    assertEquals(false, Core.view("roomCheckAuth", listOf(text, fine + ("remoteSdp" to sdpB))))
    assertEquals(false, Core.view("roomCheckAuth", listOf(text, fine + ("channelId" to "room-2"))))
    assertEquals(false, Core.view("roomCheckAuth", listOf(text, fine + ("peer" to "peer-c"))))
    // An SDP without a fingerprint: nothing to vouch for.
    assertNull(Core.view("roomAuthText", listOf("room-1", "peer-a", "peer-b", "v=0\r\n", sdpB)))
    // One side of a pair restarts first, the same answer on both.
    assertTrue(Core.view("roomRestartOfferer", listOf("a", "b")) as Boolean)
    assertFalse(Core.view("roomRestartOfferer", listOf("b", "a")) as Boolean)
  }

  @Test fun theMusicWire() {
    assumeTrue(Core.loaded)
    val track = mapOf("id" to "audius:1", "source" to "audius", "title" to "Night Drive", "artist" to "Северный ветер", "duration" to 214.0)
    val told = Core.view("roomMusicOut", listOf(track, 12.34, true)) as String
    val heard = Core.map(Core.view("roomMusicIn", listOf(told)))!!
    assertEquals(listOf(12.3, true, "Night Drive"), listOf(heard["place"], heard["playing"], Core.map(heard["track"])!!["title"]))
    assertEquals(mapOf("off" to true), Core.map(Core.view("roomMusicIn", listOf(RoomRules.musicOff))))
    // A file of the phone's own cannot be played for everyone; a text that is not about the music says nothing.
    assertNull(Core.view("roomMusicOut", listOf(track + ("source" to "local"), 0.0, false)))
    assertNull(Core.view("roomMusicIn", listOf("{\"type\":\"chat\"}")))
  }

  @Test fun theRoomAndItsWordsAsTheScreensShowThem() {
    assumeTrue(Core.loaded)
    val made = Room.from(room("r1", inside = listOf("u1"), awake = true))!!
    assertEquals(listOf("r1", "Комната r1", 3, 1), listOf(made.id, made.name, made.members.size, made.inside.size))
    assertNull(Room.from(mapOf("name" to "без id")))
    assertEquals("Лариса", RoomRules.firstName(made.members[1]))
    assertEquals("комната · один внутри", RoomRules.statusLine(made, null, 1) { it })
    val empty = Room.from(room("r2", awake = true))!!
    assertEquals("комната · никого, ещё не спит", RoomRules.statusLine(empty, null, 0) { it })
    val voice = RoomVoiceState("r1", "Комната r1", status = "connected", speaker = true,
      peers = listOf(RoomVoicePeer("p1", "u1", muted = false, connected = true), RoomVoicePeer("p2", "u2", muted = true, connected = false)))
    assertEquals("комната · трое внутри", RoomRules.statusLine(made, voice, 3) { it })
    assertEquals("комната · трое внутри · слабая связь", RoomRules.statusLine(made, voice.copy(link = "weak"), 3) { com.linea.messenger.calls.CallRules.linkWords(it) })
    assertEquals("подключение…", RoomRules.statusLine(made, voice.copy(status = "connecting"), 1) { it })
    // The bar counts this phone and the people its voice flows with.
    assertEquals("Комната r1 · Комната · 2 внутри", RoomRules.barLine(voice))
    assertEquals("Комната r1 · Комната", RoomRules.barLine(voice.copy(status = "connecting")))
    assertNotNull(Person.from(made.members[0].let { mapOf("id" to it.id) }))
  }
}
