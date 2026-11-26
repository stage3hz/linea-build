package com.linea.messenger

import com.linea.messenger.calls.CallReport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The grey line of a call in the preview build: kinds and counts only, never an address. */
class CallReportTest {
  private val sdp = listOf(
    "v=0",
    "a=candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host generation 0",
    "a=candidate:2 1 udp 2122262783 2001:db8::7 50001 typ host generation 0",
    "a=candidate:3 1 udp 2122260223 0f6c2a1e-1111-2222-3333-444455556666.local 50002 typ host",
    "a=candidate:4 1 tcp 1518280447 192.0.2.10 9 typ host tcptype active",
    "a=candidate:5 1 udp 1686052607 198.51.100.4 40000 typ srflx raddr 192.0.2.10 rport 50000",
    "a=candidate:6 1 udp 41885439 203.0.113.7 50000 typ relay raddr 198.51.100.4 rport 40000",
  ).joinToString("\r\n")

  @Test fun countsByKind() {
    assertEquals("h4 (v6 1, .local 1) s1 r1 tcp 1", CallReport.counts(sdp))
    assertEquals("h0 s0 r0", CallReport.counts("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"))
  }

  @Test fun lineHoldsNoAddress() {
    val report = CallReport(incoming = true)
    report.servers = 2; report.source = "сервер"; report.wantRelay = true; report.state = "failed"; report.answer = "отправлен"
    report.own = CallReport.counts(sdp); report.cause = "ICE failed"; report.network = "wifi"
    val line = report.line(sdp)
    assertTrue(line.startsWith("ICE: failed · relay: нет · серверов: 2 (сервер) · ответ: отправлен"))
    assertTrue(line.contains("кандидаты: свои h4 (v6 1, .local 1) s1 r1 tcp 1 · чужие h4"))
    for (secret in listOf("192.0.2", "2001:db8", "198.51", "203.0.113", ".local 5", "0f6c2a1e")) assertFalse(secret, line.contains(secret))
  }

  @Test fun onlyThePreviewBuildShowsIt() {
    assertTrue(CallReport.shown("com.linea.messenger.preview"))
    assertFalse(CallReport.shown("com.invizent.app"))
    assertFalse(CallReport.shown(null))
  }
}
