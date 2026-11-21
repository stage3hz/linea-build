package com.linea.messenger

import com.linea.messenger.calls.CallAudio
import com.linea.messenger.calls.CallBarView
import com.linea.messenger.calls.CallNetwork
import com.linea.messenger.calls.CallRules
import com.linea.messenger.calls.CallScreenView
import com.linea.messenger.calls.CallSignals
import com.linea.messenger.calls.CallState
import com.linea.messenger.calls.CallsDemo
import com.linea.messenger.people.Person
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** Calls: what the app itself decides, without a phone and without the core — where a call sounds, which buttons
 *  its screen has, the words of its lines, which messages are a call's steps. The rules of a call itself are the
 *  core's (native/core/src/calls.rs); how the app asks for them is pinned in CallCoreJniTest. */
class CallRulesTest {
  private val peer = Person("u2", "alisa", "Алиса Воронцова", "", "", 0x5E7BFF, "")
  private fun call(status: String, incoming: Boolean = false, video: Boolean = false) = CallState("c1", "chat1", peer, incoming, video, status, speaker = video)

  @Test fun aCallBeginsQuietAndUnanswered() {
    val fresh = call("requesting")
    assertFalse(fresh.muted); assertFalse(fresh.cameraOff); assertFalse(fresh.minimized); assertFalse(fresh.reconnecting); assertFalse(fresh.retry)
    assertNull(fresh.startedAt); assertNull(fresh.key); assertEquals("good", fresh.grade)
    assertFalse(fresh.isOver)
    assertTrue(fresh.copy(status = "ended").isOver)
    // A video call starts on the loudspeaker.
    assertTrue(call("requesting", video = true).speaker)
  }

  @Test fun theLoudspeakerButtonAndTheRoute() {
    // «Динамик» on: the loudspeaker. Off: the system's own route — but a video call's own route is the loudspeaker,
    // so there the earpiece is forced.
    assertEquals(true, CallRules.speakerRoute(true, video = false))
    assertEquals(true, CallRules.speakerRoute(true, video = true))
    assertNull(CallRules.speakerRoute(false, video = false))
    assertEquals(false, CallRules.speakerRoute(false, video = true))
    assertNull(CallRules.speakerRoute(null, video = true))
  }

  @Test fun whereACallSounds() {
    // The system's own route: headphones when they are connected (Bluetooth first), else the earpiece — a video call: the loudspeaker.
    assertEquals("earpiece", CallRules.soundRoute(null, video = false, bluetooth = false, wired = false))
    assertEquals("speaker", CallRules.soundRoute(null, video = true, bluetooth = false, wired = false))
    assertEquals("bluetooth", CallRules.soundRoute(null, video = false, bluetooth = true, wired = true))
    assertEquals("bluetooth", CallRules.soundRoute(null, video = true, bluetooth = true, wired = false))
    assertEquals("wired", CallRules.soundRoute(null, video = true, bluetooth = false, wired = true))
    // «Динамик» wins over headphones; forced off, the phone's own earpiece does.
    assertEquals("speaker", CallRules.soundRoute(true, video = false, bluetooth = true, wired = true))
    assertEquals("earpiece", CallRules.soundRoute(false, video = true, bluetooth = true, wired = true))
  }

  @Test fun theWordsACallEndsWith() {
    assertEquals("Звонок отклонён", CallRules.endedWords("declined"))
    assertEquals("Собеседник занят", CallRules.endedWords("busy"))
    assertEquals("Пропущенный звонок", CallRules.endedWords("missed"))
    assertEquals("Звонок завершён", CallRules.endedWords("hangup"))
    assertEquals("Звонок завершён", CallRules.endedWords(null))
    assertEquals("Нет доступа к микрофону. Разреши его для Инвиза в настройках телефона, чтобы звонить.", CallAudio.noMicrophone)
    assertEquals("Нет доступа к камере. Разреши её для Инвиза в настройках телефона, чтобы включить видео.", CallAudio.noCamera)
  }

  @Test fun theButtonsOfTheCallScreen() {
    assertEquals(listOf("Отклонить", "Ответить"), CallRules.buttons(call("incoming", incoming = true)))
    assertEquals(listOf("Динамик", "Видео", "Убрать звук", "Завершить"), CallRules.buttons(call("ringing")))
    assertEquals(listOf("Динамик", "Видео", "Звук выкл", "Завершить"), CallRules.buttons(call("active").copy(muted = true)))
    // «Повернуть» only while this phone's camera is on.
    assertEquals(listOf("Динамик", "Видео", "Повернуть", "Убрать звук", "Завершить"), CallRules.buttons(call("active", video = true)))
    assertEquals(listOf("Динамик", "Видео", "Убрать звук", "Завершить"), CallRules.buttons(call("active", video = true).copy(cameraOff = true)))
    assertEquals(emptyList<String>(), CallRules.buttons(call("ended")))
    assertEquals(listOf("Закрыть", "Повторить"), CallRules.buttons(call("ended").copy(retry = true)))
  }

  @Test fun theBarIsGreenOrangeOrBlue() {
    assertEquals(0xFF2BA36B.toInt(), CallRules.barColor("active"))
    assertEquals(0xFFD9822B.toInt(), CallRules.barColor("trouble"))
    assertEquals(0xFF3B6FB6.toInt(), CallRules.barColor("pending"))
    assertEquals(0xFF6B7280.toInt(), CallRules.barColor("ended"))
  }

  @Test fun theLineUnderTheName() {
    val running = call("active").copy(startedAt = 0.0)
    assertEquals("0:42", CallScreenView.statusWords(running, CallRules.Status("0:42", null, "active"), "", showsVideo = false))
    assertEquals("0:42 · слабая связь", CallScreenView.statusWords(running, CallRules.Status("0:42", null, "active"), "слабая связь", showsVideo = false))
    // Reconnecting: the clock has its own line under the status — except over the other side's picture, where it follows the words.
    val trouble = CallRules.Status("Восстановление связи…", "3:12", "trouble")
    assertEquals("Восстановление связи…", CallScreenView.statusWords(running.copy(reconnecting = true), trouble, "", showsVideo = false))
    assertEquals("Восстановление связи… · 3:12", CallScreenView.statusWords(running.copy(reconnecting = true), trouble, "", showsVideo = true))
    assertEquals("Алиса Воронцова, Восстановление связи… 3:12", CallBarView.barWords("Алиса Воронцова", trouble))
    assertEquals("Алиса Воронцова, 0:42", CallBarView.barWords("Алиса Воронцова", CallRules.Status("0:42", null, "active")))
  }

  @Test fun onlyTheOtherSidesOpenedCallStepsAreSignals() {
    val step = mapOf<String, Any?>("senderId" to "u2", "cryptoState" to "decrypted", "meta" to mapOf("action" to mapOf("type" to "call", "step" to "offer")))
    assertTrue(CallSignals.isSignal(step, "u1"))
    assertFalse(CallSignals.isSignal(step, "u2"))
    assertFalse(CallSignals.isSignal(step + ("cryptoState" to "no-key"), "u1"))
    assertFalse(CallSignals.isSignal(step + ("meta" to mapOf("action" to mapOf("type" to "reaction"))), "u1"))
    assertFalse(CallSignals.isSignal(step + ("meta" to null), "u1"))
  }

  @Test fun afterAReconnectionOnlyFreshChatsAreLookedInto() {
    val now = Instant.parse("2026-11-21T10:00:00Z")
    fun chat(id: String, sender: String, at: String) = mapOf<String, Any?>("id" to id, "lastMessage" to mapOf("senderId" to sender, "createdAt" to at))
    val list = listOf(chat("a", "u2", "2026-11-21T09:59:10.000Z"), chat("b", "u2", "2026-11-21T09:58:40.000Z"), chat("c", "u1", "2026-11-21T09:59:59.000Z"),
      mapOf<String, Any?>("id" to "d"), chat("e", "u3", "not a time"))
    assertEquals(listOf("a"), CallSignals.recentChats(list, "u1", now))
  }

  @Test fun aStepIsRememberedByItsMessage() {
    assertEquals("id:42", CallRules.stepKey(mapOf("id" to 42.0, "senderId" to "u2", "clientId" to "x")))
    assertEquals("u2:x", CallRules.stepKey(mapOf("senderId" to "u2", "clientId" to "x")))
    assertNull(CallRules.stepKey(mapOf("senderId" to "u2")))
  }

  @Test fun theServersOfACall() {
    val fresh = listOf(mapOf<String, Any?>("urls" to listOf("turn:relay.example:3478"), "username" to "u", "credential" to "p"))
    val kept = listOf(mapOf<String, Any?>("urls" to "turn:old.example:3478"))
    val finder = listOf(mapOf<String, Any?>("urls" to listOf("stun:stun.l.google.com:19302")))
    assertEquals(fresh, CallRules.iceChoice(fresh, Pair(0L, kept), 1_000, 14_400_000))
    // Not answered: the servers of the last call while their password lasts, then the public address finder alone.
    assertEquals(kept, CallRules.iceChoice(null, Pair(0L, kept), 14_399_999, 14_400_000))
    assertEquals(finder, CallRules.iceChoice(null, Pair(0L, kept), 14_400_000, 14_400_000))
    assertEquals(finder, CallRules.iceChoice(null, null, 0, 14_400_000))
  }

  @Test fun thePhoneSaysWhenItsNetworkBecameAnotherOne() {
    val network = CallNetwork()
    var online = 0; var changes = 0
    network.onOnline = { online += 1 }
    network.onChange = { changes += 1 }
    assertNull(network.online)
    network.heard("wifi|1")
    assertEquals(true, network.online); assertEquals(1, online); assertEquals(0, changes)
    network.heard("wifi|1")
    assertEquals(1, online); assertEquals(0, changes)
    // Wi-Fi → mobile: a live call restarts ICE at once.
    network.heard("cellular|2")
    assertEquals(1, online); assertEquals(1, changes)
    // Going offline is not a change to act on; coming back is.
    network.heard("offline")
    assertEquals(false, network.online); assertEquals(2, online); assertEquals(1, changes)
    network.heard("cellular|2")
    assertEquals(true, network.online); assertEquals(3, online); assertEquals(2, changes)
  }

  @Test fun theSampleCallsOfTheEmulatorCheck() {
    val now = 1_000_000.0
    assertEquals("ringing", CallsDemo.sample("outgoing", now)?.status)
    assertEquals(true, CallsDemo.sample("incoming", now)?.incoming)
    assertEquals("incoming", CallsDemo.sample("incoming", now)?.status)
    val active = CallsDemo.sample("active", now)!!
    assertEquals("active", active.status); assertEquals(now - 42_000, active.startedAt!!, 0.0); assertEquals(4, active.key?.size); assertFalse(active.minimized)
    assertTrue(CallsDemo.sample("bar", now)!!.minimized)
    val video = CallsDemo.sample("video", now)!!
    assertTrue(video.video && video.localVideo && video.remoteVideo && video.speaker)
    assertEquals("Звонок завершён", CallsDemo.sample("ended", now)?.endedText)
    assertTrue(CallsDemo.sample("retry", now)!!.retry)
    assertNull(CallsDemo.sample("nothing", now))
    assertEquals("Алиса Воронцова", active.peer.displayName)
  }
}
