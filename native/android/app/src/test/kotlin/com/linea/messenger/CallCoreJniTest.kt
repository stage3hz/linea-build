package com.linea.messenger

import com.linea.messenger.calls.CallRules
import com.linea.messenger.calls.CallState
import com.linea.messenger.core.Core
import com.linea.messenger.people.Person
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Calls: Kotlin ↔ the core through JNI, for real — the names and the arguments the app asks the rules of calls
 *  with (`Core.view`, as on a phone), in the core built for this machine (native/android/build-core-host.sh).
 *  Skipped when that library has not been built. The rules themselves are pinned in the core's own tests. */
class CallCoreJniTest {
  private val peer = Person("u2", "alisa", "Алиса Воронцова", "", "", 0x5E7BFF, "")
  private fun call(status: String, incoming: Boolean = false, video: Boolean = false) = CallState("7b0c2f0e-6c1d-4a55-9d0e-0a1b2c3d4e5f", "chat1", peer, incoming, video, status, speaker = video)

  @Test fun theLimitsAreTheCores() {
    assumeTrue(Core.loaded)
    assertEquals(60_000L, CallRules.ringTimeout)
    assertEquals(20_000L, CallRules.networkWait)
    assertEquals(14_400_000L, CallRules.iceReuse)
    assertEquals(36f, CallRules.barHeight, 0f)
    assertEquals("Нет соединения", CallRules.noConnectionText)
    // An unknown name or arguments of the wrong kind: no answer.
    assertNull(Core.view("callNothing", emptyList()))
    assertNull(Core.view("callStatus", listOf("words")))
  }

  @Test fun theStatusLineOfEveryState() {
    assumeTrue(Core.loaded)
    fun words(call: CallState, network: String = "online") = CallRules.status(call, network, now = 100_000.0).text
    assertEquals("Запрос…", words(call("requesting")))
    assertEquals("Вызов…", words(call("ringing")))
    assertEquals("Ожидание сети…", words(call("requesting"), "waiting"))
    assertEquals("Соединение…", words(call("ringing"), "connecting"))
    assertEquals("Входящий звонок", words(call("incoming", incoming = true)))
    assertEquals("Входящий видеозвонок", words(call("incoming", incoming = true, video = true)))
    assertEquals("Соединение…", words(call("connecting")))
    assertEquals("Звонок завершён", words(call("ended").copy(endedText = "Звонок завершён")))
    // The clock of a running call; while it reconnects the words take its place and the clock stands beside them.
    val running = call("active").copy(startedAt = 58_000.0)
    val status = CallRules.status(running, "online", now = 100_000.0)
    assertEquals("0:42", status.text); assertNull(status.clock); assertEquals("active", status.tone)
    val trouble = CallRules.status(running.copy(reconnecting = true), "online", now = 100_000.0)
    assertEquals("Восстановление связи…", trouble.text); assertEquals("0:42", trouble.clock); assertEquals("trouble", trouble.tone)
    assertEquals("pending", CallRules.status(call("ringing"), "online").tone)
    assertEquals("trouble", CallRules.status(call("ringing"), "waiting").tone)
    assertEquals("ended", CallRules.status(call("ended"), "online").tone)
    assertEquals("слабая связь", CallRules.linkWords("weak"))
    assertEquals("плохая связь", CallRules.linkWords("bad"))
    assertEquals("", CallRules.linkWords("good"))
  }

  @Test fun theRoadOfTheSignalling() {
    assumeTrue(Core.loaded)
    assertEquals("online", CallRules.words("callSignalNetwork", listOf("connected", true)))
    assertEquals("online", CallRules.words("callSignalNetwork", listOf("connected", null)))
    assertEquals("waiting", CallRules.words("callSignalNetwork", listOf("connected", false)))
    assertEquals("connecting", CallRules.words("callSignalNetwork", listOf("connecting", null)))
    assertEquals("waiting", CallRules.words("callSignalNetwork", listOf("offline", null)))
    assertEquals(mapOf("text" to "Нет ответа", "retry" to false), CallRules.fields("callRingExpiry", listOf("online")))
    assertEquals(mapOf("text" to "Нет соединения", "retry" to true), CallRules.fields("callRingExpiry", listOf("waiting")))
  }

  @Test fun hangingUpAndTheEndBothChatsShow() {
    assumeTrue(Core.loaded)
    assertEquals(mapOf("text" to "Звонок отклонён", "reason" to "declined"), CallRules.fields("callHangup", listOf("incoming", true)))
    assertEquals(mapOf("text" to "Звонок отменён", "reason" to null), CallRules.fields("callHangup", listOf("requesting", false)))
    assertEquals(mapOf("text" to "Звонок отменён", "reason" to "missed"), CallRules.fields("callHangup", listOf("ringing", false)))
    assertEquals(mapOf("text" to "Звонок завершён", "reason" to "hangup"), CallRules.fields("callHangup", listOf("active", false)))

    val end = CallRules.end(call("active").copy(startedAt = 0.0), "hangup")
    assertEquals("call", end["type"]); assertEquals("end", end["step"]); assertEquals("hangup", end["reason"]); assertEquals(true, end["caller"])
    assertEquals("7b0c2f0e-6c1d-4a55-9d0e-0a1b2c3d4e5f", end["call"])
    val busy = CallRules.end("7b0c2f0e-6c1d-4a55-9d0e-0a1b2c3d4e5f", video = false, incoming = true, startedAt = null, reason = "busy")
    assertEquals("busy", busy["reason"]); assertEquals(false, busy["caller"])

    // What the server is told about the notification: an offer rings, the caller's «not answered» leaves a notice, the rest is silent.
    assertEquals("call", Core.view("callPushKind", listOf(mapOf("action" to mapOf("type" to "call", "step" to "offer")))))
    assertEquals("missed", Core.view("callPushKind", listOf(mapOf("action" to CallRules.end(call("ringing"), "missed")))))
    assertEquals("none", Core.view("callPushKind", listOf(mapOf("action" to end))))

    // The row of the call in the chat names its direction, for each side.
    val mine = Core.view("callServiceText", listOf(end, "u1", "u1")) as String
    val theirs = Core.view("callServiceText", listOf(end, "u1", "u2")) as String
    assertTrue(mine, mine.startsWith("Исходящий звонок"))
    assertTrue(theirs, theirs.startsWith("Входящий звонок"))
  }

  @Test fun theAddressesAndTheKeyOfACall() {
    assumeTrue(Core.loaded)
    // Non-trickle ICE: at once when gathering is complete; after 3 s with the relay's address or without a relay; never later than 10 s.
    assertTrue(CallRules.flag("callGatherDone", listOf(true, false, true, 0.0)))
    assertFalse(CallRules.flag("callGatherDone", listOf(false, false, true, 3_500.0)))
    assertTrue(CallRules.flag("callGatherDone", listOf(false, true, true, 3_500.0)))
    assertTrue(CallRules.flag("callGatherDone", listOf(false, false, false, 3_500.0)))
    assertTrue(CallRules.flag("callGatherDone", listOf(false, false, true, 10_500.0)))
    assertTrue(CallRules.flag("callIsRelayCandidate", listOf("candidate:1 1 udp 41885439 203.0.113.7 50000 typ relay raddr 0.0.0.0 rport 0")))
    assertFalse(CallRules.flag("callIsRelayCandidate", listOf("candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host")))
    assertTrue(CallRules.flag("callHasRelay", listOf(listOf(mapOf("urls" to listOf("turn:relay.example:3478"), "username" to "u", "credential" to "p")))))
    assertFalse(CallRules.flag("callHasRelay", listOf(listOf(mapOf("urls" to listOf("stun:stun.l.google.com:19302"))))))

    // The mark that says «this app answers ICE restarts» travels inside the SDP and is taken off before the SDP is used.
    val sdp = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
    val marked = CallRules.words("callMarkRestart", listOf(sdp))!!
    assertTrue(CallRules.flag("callRestartCapable", listOf(marked)))
    assertFalse(CallRules.flag("callRestartCapable", listOf(sdp)))
    assertFalse(CallRules.flag("callRestartCapable", listOf(null)))
    assertEquals(sdp, CallRules.words("callStripRestart", listOf(marked)))
    assertTrue(CallRules.flag("callSameFingerprints", listOf(sdp, marked)))

    // An offer rings once, and only while it is fresh.
    assertTrue(CallRules.flag("callOfferFresh", listOf("2026-11-21T10:00:00.000Z", 1795255230000.0, emptyList<String>(), "c1")))
    assertFalse(CallRules.flag("callOfferFresh", listOf("2026-11-21T10:00:00.000Z", 1795255230000.0, listOf("c1"), "c1")))
    assertFalse(CallRules.flag("callOfferFresh", listOf("2026-11-21T10:00:00.000Z", 1795255330000.0, emptyList<String>(), "c1")))
  }
}
