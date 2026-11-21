package com.linea.messenger

import com.linea.messenger.chat.MsgRow
import com.linea.messenger.chatactions.ChatHistory
import com.linea.messenger.core.Core
import com.linea.messenger.linkpreview.LinkCore
import com.linea.messenger.linkpreview.LinkDownload
import com.linea.messenger.linkpreview.MsgLinkCard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** The cards of links: Kotlin ↔ the core through JNI, for real — the very function the app calls on a phone
 *  (`LinkCore.linkCall`), in the core built for this machine (native/android/build-core-host.sh). Skipped when
 *  that library has not been built. The rules themselves are pinned in native/core/tests/link_preview.rs. */
class LinkCoreJniTest {
  @Test fun theLimitsOfAFetchAreTheCores() {
    assumeTrue(Core.loaded)
    assertEquals(mapOf("htmlBytes" to 262144.0, "imageDownloadBytes" to 2097152.0, "imageBytes" to 24576.0, "imageSide" to 480.0, "redirects" to 3.0, "timeoutMs" to 6000.0), LinkCore.call("limits"))
    assertEquals(LinkCore.Limits(), LinkCore.limits)
    // An unknown name or arguments of the wrong kind: no answer.
    assertNull(LinkCore.call("nothing"))
    assertNull(LinkCore.call("fetchable", listOf(1)))
  }

  @Test fun theFirstSecureLinkOfATextGetsTheCard() {
    assumeTrue(Core.loaded)
    assertEquals("https://example.org/a?b=1", LinkCore.candidate("смотри https://example.org/a?b=1 и https://other.example/c"))
    assertNull(LinkCore.candidate("просто слова"))
    assertNull(LinkCore.candidate("http://example.org/a"))
    // An address that may not be fetched gets no card.
    assertNull(LinkCore.candidate("https://192.168.0.1/admin"))
    assertNull(LinkCore.candidate("https://localhost/x"))
  }

  @Test fun onlyPublicSecureAddressesAreFetched() {
    assumeTrue(Core.loaded)
    for (url in listOf("https://example.org/", "https://sub.example.org/a/b?c=d#e", "https://пример.рф/страница")) assertTrue(url, LinkCore.fetchable(url))
    for (url in listOf("http://example.org/", "https://example.org:8443/", "https://user:pass@example.org/", "https://user@example.org/", "https://127.0.0.1/", "https://[::1]/",
      "https://10.0.0.1/", "https://2130706433/", "https://0x7f.1/", "https://localhost/", "https://router.local/", "https://printer.lan/", "https://intranet/", "https://example.onion/",
      "ftp://example.org/", "file:///etc/hosts", "javascript:alert(1)", "", "https://exa mple.org/")) assertFalse(url, LinkCore.fetchable(url))
    for (ip in listOf("127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fe80::1%wlan0",
      "fc00::1", "fd12:3456::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "not an address", "")) assertTrue(ip, LinkCore.privateAddress(ip))
    for (ip in listOf("93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:93.184.216.34", "64:ff9b::5db8:d822")) assertFalse(ip, LinkCore.privateAddress(ip))
    // The address as the fetcher's client reads it is checked as well: both must agree on where it leads.
    assertEquals("https://example.org/a", LinkDownload.allowed("https://example.org/a")?.toString())
    for (url in listOf("http://example.org/", "https://example.org:8443/", "https://user@example.org/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "not a link"))
      assertNull(url, LinkDownload.allowed(url))
  }

  @Test fun aPageIsReadByTheCore() {
    assumeTrue(Core.loaded)
    val html = """<!doctype html><html><head><meta charset="utf-8"><title>Запасной заголовок</title>
      <meta property="og:site_name" content="Журнал «Пример»"><meta property="og:title" content="Как мы переезжали">
      <meta property="og:description" content="Сорок коробок, три этажа и один лифт."><meta property="og:image" content="/pictures/cover.jpg">
      </head><body><script>alert(1)</script></body></html>""".toByteArray()
    val page = LinkCore.parse(html, "text/html; charset=utf-8", "https://journal.example.org/2026/move")!!
    assertEquals(listOf("Журнал «Пример»", "Как мы переезжали", "Сорок коробок, три этажа и один лифт.", "https://journal.example.org/pictures/cover.jpg"),
      listOf(page.site, page.title, page.description, page.imageUrl))
    // A page without a head of its own: the title and the host stand in; no picture.
    val bare = LinkCore.parse("<html><head><title>Просто страница</title></head></html>".toByteArray(), null, "https://www.example.org/x")!!
    assertEquals(listOf("example.org", "Просто страница", "", null), listOf(bare.site, bare.title, bare.description, bare.imageUrl))
    // A page that came from an address no card may come from is not read.
    assertNull(LinkCore.parse(html, "text/html", "https://192.168.0.1/"))
    assertNull(LinkCore.parse(html, "text/html", "http://example.org/"))
  }

  @Test fun theCardIsMadeAndCheckedByTheCore() {
    assumeTrue(Core.loaded)
    val url = "https://journal.example.org/2026/move"
    val card = LinkCore.wire(url, "  Журнал‮ «Пример»  ", "Как мы\n переезжали​", "Сорок   коробок", null)!!
    // The texts are made plain (the picture's side of it is in LinkPreviewPagesTest, where pictures can be made).
    assertEquals(listOf(url, "Журнал «Пример»", "Как мы переезжали", "Сорок коробок"), listOf(card["url"], card["site"], card["title"], card["description"]))
    assertFalse(card.containsKey("image"))
    val shown = MsgLinkCard.parse(card)!!
    assertEquals(listOf("Журнал «Пример»", "Как мы переезжали", "Сорок коробок", ""), listOf(shown.site, shown.title, shown.about, shown.image))
    // What is not a picture is refused, and the card goes without it.
    assertNull(LinkCore.image("not a picture".toByteArray()))
    val plain = LinkCore.wire(url, "", "Заголовок", "", "not a picture".toByteArray())!!
    assertEquals(listOf("journal.example.org", false), listOf(plain["site"], plain.containsKey("image")))
    // Nothing to show, or an address that may not carry a card: no card.
    assertNull(LinkCore.wire(url, "Журнал", "", "", null))
    assertNull(LinkCore.wire("http://journal.example.org/", "Журнал", "Заголовок", "", null))
    assertNull(LinkCore.wire("https://10.0.0.1/", "Журнал", "Заголовок", "", null))

    // A message may carry the card only when its text holds that very link.
    assertTrue(LinkCore.valid(card, "смотри $url"))
    assertFalse(LinkCore.valid(card, "смотри https://other.example/"))
    assertFalse(LinkCore.valid(card, "просто слова"))
    assertFalse(LinkCore.valid(card + ("title" to "Как мы‮ переезжали"), "смотри $url"))
    assertFalse(LinkCore.valid(card + ("extra" to 1), "смотри $url"))
  }

  @Test fun aMessageWithACardBecomesARowWithIt() {
    assumeTrue(Core.loaded)
    val url = "https://docs.example.org/plan"
    val card = LinkCore.wire(url, "", "План встречи", "Повестка и таблица.", null)!!
    val zone = ZoneId.of("UTC"); val now = Instant.parse("2026-11-21T10:00:00Z")
    val arrived = mapOf("id" to 1, "chatId" to "c", "senderId" to "peer", "clientId" to "d0000000-0000-4000-8000-000000000001", "text" to "вот план $url",
      "attachment" to null, "createdAt" to "2026-11-21T09:46:00.000Z", "cryptoState" to "decrypted", "linkPreview" to card)
    val plain = mapOf("id" to 2, "chatId" to "c", "senderId" to "peer", "clientId" to "d0000000-0000-4000-8000-000000000002", "text" to "без карточки",
      "attachment" to null, "createdAt" to "2026-11-21T09:47:00.000Z", "cryptoState" to "decrypted")
    // What is on its way out shows its card at once.
    val sending = ChatHistory.Pending("d0000000-0000-4000-8000-000000000003", "и ещё раз $url", null, null, "2026-11-21T09:48:00.000Z", linkPreview = card)
    val shown = ChatHistory.build(ChatHistory.Snapshot(listOf(arrived, plain), listOf(sending), emptyList(), null, 0, null, "me", "Алиса", now, zone))
    val rows = MsgRow.parse(shown.rows).filter { it.kind == 0 }
    assertEquals(listOf("План встречи", null, "План встречи"), rows.map { it.linkCard?.title })
    assertEquals(listOf(url, "docs.example.org", "Повестка и таблица.", ""), rows.first().linkCard!!.let { listOf(it.url, it.site, it.about, it.image) })
    assertEquals(listOf(false, true), listOf(rows.first().mine, rows.last().mine))
    // The link in the text is a link of its own (a tap on it opens it), with the same address.
    assertEquals(listOf(url), rows.first().urls)
    // The simpler list of rows carries the card as well.
    val simple = MsgRow.parse(com.linea.messenger.app.Messenger.rows(listOf(arrived, plain), "me", 0, now, zone)).filter { it.kind == 0 }
    assertEquals(listOf("План встречи", null), simple.map { it.linkCard?.title })
  }
}
