package com.linea.messenger

import com.linea.messenger.chat.MsgRow
import com.linea.messenger.linkpreview.LinkComposer
import com.linea.messenger.linkpreview.LinkCore
import com.linea.messenger.linkpreview.LinkDns
import com.linea.messenger.linkpreview.LinkDownload
import com.linea.messenger.linkpreview.LinkFetcherAgent
import com.linea.messenger.linkpreview.LinkOpen
import com.linea.messenger.linkpreview.LinkPicture
import com.linea.messenger.linkpreview.LinkSettings
import com.linea.messenger.linkpreview.MsgLinkCard
import com.linea.messenger.linkpreview.MsgLinkCardFrames
import okhttp3.Authenticator
import okhttp3.CookieJar
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.Proxy

/** The cards of links: the rules that need no phone — which links open at once, what a card is made of and
 *  where its parts go, what the fetcher will and will not read, and how its client is set up. The words are
 *  those of the iPhone app (native/ios/Sources/LinkPreview). */
class LinkPreviewRulesTest {
  @Test fun aLinkOpensAtOnceOnlyWhenItsWordsShowWhereItGoes() {
    assertTrue(LinkOpen.matches("example.org/page", "https://example.org/page/"))
    assertTrue(LinkOpen.matches(" HTTPS://WWW.Example.org ", "http://example.org"))
    assertTrue(LinkOpen.matches("www.example.org///", "https://www.example.org"))
    assertFalse(LinkOpen.matches("подробнее", "https://example.org"))
    assertFalse(LinkOpen.matches("example.org", "https://example.org.evil.test"))
    assertFalse(LinkOpen.matches("", "https://"))
    assertEquals("open", LinkOpen.step("https://example.org/a", "https://example.org/a"))
    assertEquals("ask", LinkOpen.step("https://example.org/a", "подробнее"))
    assertEquals("ask", LinkOpen.step("http://example.org", "bank.example"))
    // Nothing but the web is ever handed to the system.
    for (url in listOf("javascript:alert(1)", "intent://x#Intent;end", "file:///sdcard/a", "content://a/b", "tel:112", "", "example.org")) {
      assertEquals(url, "", LinkOpen.step(url, url))
      assertFalse(LinkOpen.opens(url))
    }
  }

  @Test fun aCardIsReadFromWhatCameInsideTheMessage() {
    val whole = mapOf("url" to "https://example.org/a", "site" to "Пример", "title" to "Заголовок", "description" to "Описание",
      "image" to mapOf("mimeType" to "image/jpeg", "base64" to "AAAA", "width" to 480.0, "height" to 240.0))
    assertEquals(MsgLinkCard("https://example.org/a", "Пример", "Заголовок", "Описание", "AAAA", 2.0), MsgLinkCard.parse(whole))
    assertEquals("Пример. Заголовок. Описание", MsgLinkCard.parse(whole)!!.spoken)
    // A picture without its size is no picture; a card with nothing to show is no card.
    val bare = MsgLinkCard.parse(mapOf("url" to "https://example.org/a", "site" to "example.org", "image" to mapOf("base64" to "AAAA", "width" to 0, "height" to 10)))!!
    assertEquals(listOf("", 1.0, "example.org"), listOf(bare.image, bare.imageWide, bare.spoken))
    assertNull(bare.picture())
    assertNull(MsgLinkCard.parse(mapOf("url" to "https://example.org/a")))
    assertNull(MsgLinkCard.parse(mapOf("url" to "", "title" to "Заголовок")))
    assertNull(MsgLinkCard.parse(mapOf("site" to "example.org", "title" to "Заголовок")))
    assertNull(MsgLinkCard.parse("https://example.org"))
    assertNull(MsgLinkCard.parse(null))
    // A row carries its card; a row without one has none.
    val rows = MsgRow.parse(listOf(mapOf("key" to "a", "text" to "https://example.org/a", "card" to whole), mapOf("key" to "b", "text" to "привет")))
    assertEquals(listOf("Заголовок", null), rows.map { it.linkCard?.title })
  }

  @Test fun thePartsOfACardStandUnderOneAnother() {
    val none = listOf(0f, 0f)
    // With a picture the card takes the whole width it may (at most 320); the picture keeps its proportions.
    val full = MsgLinkCardFrames.make(listOf(90f, 16f), listOf(200f, 40f), listOf(250f, 60f), hasPicture = true, imageWide = 480.0 / 252.0, width = 400f, d = 1f)
    assertEquals(listOf(320f, 13f, 296f), listOf(full.width, full.site[0], full.site[2]))
    assertEquals(listOf(9f, 28f, 71f), listOf(full.site[1], full.title[1], full.words[1]))
    assertEquals(listOf(13f, 138f, 296f, 155f), full.picture)
    assertEquals(138f + 155f + 3f + 7f, full.height)
    // Without one it is as wide as its words, but not narrower than 140.
    val words = MsgLinkCardFrames.make(listOf(90f, 16f), listOf(200f, 20f), none, hasPicture = false, imageWide = 1.0, width = 400f, d = 1f)
    assertEquals(listOf(224f, 9f + 16f + 3f + 20f + 3f + 7f), listOf(words.width, words.height))
    assertEquals(listOf(MsgLinkCardFrames.none, MsgLinkCardFrames.none), listOf(words.words, words.picture))
    assertEquals(140f, MsgLinkCardFrames.make(listOf(30f, 16f), none, none, false, 1.0, 400f, 1f).width)
    // A narrow row: the card is the row's width; a very tall or very wide picture is cropped to fit.
    val narrow = MsgLinkCardFrames.make(none, listOf(100f, 20f), none, true, 0.1, 200f, 1f)
    assertEquals(listOf(200f, 176f, 260f), listOf(narrow.width, narrow.picture[2], narrow.picture[3]))
    assertEquals(99f, MsgLinkCardFrames.make(none, listOf(100f, 20f), none, true, 9.0, 400f, 1f).picture[3])
    assertEquals(60f, MsgLinkCardFrames.make(none, listOf(100f, 20f), none, true, 3.0, 100f, 1f).picture[3])
    // Everything grows with the screen's density.
    val dense = MsgLinkCardFrames.make(listOf(180f, 32f), none, none, true, 2.0, 1000f, 2f)
    assertEquals(listOf(640f, 26f, 18f, 592f), listOf(dense.width, dense.site[0], dense.site[1], dense.picture[2]))
  }

  @Test fun aNameIsContactedOnlyWhenEveryAddressOfItIsPublic() {
    val private = { ip: String -> ip.startsWith("10.") || ip.startsWith("127.") || ip == "::1" }
    assertTrue(LinkDns.public(listOf("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"), private))
    // One private address among public ones refuses the whole name: the connection may not choose it.
    assertFalse(LinkDns.public(listOf("93.184.216.34", "10.0.0.7"), private))
    assertFalse(LinkDns.public(listOf("127.0.0.1"), private))
    assertFalse(LinkDns.public(listOf("::1", "93.184.216.34"), private))
    assertFalse(LinkDns.public(emptyList(), private))
    assertFalse(LinkDns.public(listOf("93.184.216.34", ""), private))
  }

  @Test fun onlyAPageOrAPictureIsRead() {
    val page = LinkDownload.Kind.PAGE; val picture = LinkDownload.Kind.PICTURE
    assertTrue(LinkDownload.fits(page, "text/html; charset=utf-8"))
    assertTrue(LinkDownload.fits(page, "Application/XHTML+XML"))
    assertTrue(LinkDownload.fits(page, null))
    assertFalse(LinkDownload.fits(page, "application/json"))
    assertFalse(LinkDownload.fits(page, "image/png"))
    assertFalse(LinkDownload.fits(page, "application/pdf"))
    assertTrue(LinkDownload.fits(picture, "image/jpeg"))
    assertTrue(LinkDownload.fits(picture, "IMAGE/WebP"))
    assertFalse(LinkDownload.fits(picture, "image/svg+xml"))
    assertFalse(LinkDownload.fits(picture, "text/html"))
    assertFalse(LinkDownload.fits(picture, null))
    assertEquals("text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", LinkDownload.accept(page))
    assertEquals("image/jpeg,image/png,image/webp,image/*;q=0.8", LinkDownload.accept(picture))

    val bytes = ByteArray(1000) { it.toByte() }
    // The head of a page is in its first bytes: the rest is not read. A picture longer than the limit is no picture.
    assertArrayEquals(bytes.copyOf(300), LinkDownload.read(ByteArrayInputStream(bytes), page, 300))
    assertArrayEquals(bytes, LinkDownload.read(ByteArrayInputStream(bytes), page, 4000))
    assertNull(LinkDownload.read(ByteArrayInputStream(bytes), picture, 999))
    assertArrayEquals(bytes, LinkDownload.read(ByteArrayInputStream(bytes), picture, 1000))
    assertArrayEquals(bytes, LinkDownload.read(ByteArrayInputStream(bytes), picture, 100_000))
    assertEquals(0, LinkDownload.read(ByteArrayInputStream(ByteArray(0)), page, 10)!!.size)
  }

  @Test fun theFetchersClientKeepsNothingAndSaysNothingOfTheApp() {
    val client = LinkDownload.client
    assertFalse(client.followRedirects)
    assertFalse(client.followSslRedirects)
    assertFalse(client.retryOnConnectionFailure)
    assertSame(CookieJar.NO_COOKIES, client.cookieJar)
    assertNull(client.cache)
    assertSame(Authenticator.NONE, client.authenticator)
    assertSame(Authenticator.NONE, client.proxyAuthenticator)
    assertSame(Proxy.NO_PROXY, client.proxy)
    assertSame(LinkDns, client.dns)
    assertTrue(client.connectionSpecs.all { it.isTls })
    // Not the client of our own server: nothing of the session can travel to a site.
    assertFalse(client === com.linea.messenger.net.Server.client)
    assertFalse(client.connectionPool === com.linea.messenger.net.Server.client.connectionPool)
    val agent = LinkFetcherAgent.words.lowercase()
    assertTrue(agent.startsWith("mozilla/5.0 "))
    for (word in listOf("invizent", "linea", "messenger", "okhttp", BuildConfig.VERSION_NAME.lowercase())) assertFalse(word, agent.contains(word))
    // Without the core nothing may be fetched and every address counts as private.
    if (!com.linea.messenger.core.Core.loaded) {
      assertFalse(LinkCore.fetchable("https://example.org/"))
      assertTrue(LinkCore.privateAddress("93.184.216.34"))
      assertNull(LinkDownload.allowed("https://example.org/"))
    }
  }

  @Test fun aPictureIsReadSmallOrNotAtAll() {
    assertEquals(1, LinkPicture.sample(480, 252, 480))
    assertEquals(1, LinkPicture.sample(900, 500, 480))
    assertEquals(2, LinkPicture.sample(1200, 630, 480))
    assertEquals(8, LinkPicture.sample(4000, 3000, 480))
    // A sliver, nothing, and a file that claims an absurd size are not decoded.
    assertNull(LinkPicture.sample(39, 400, 480))
    assertNull(LinkPicture.sample(400, 39, 480))
    assertNull(LinkPicture.sample(0, 0, 480))
    assertNull(LinkPicture.sample(-1, -1, 480))
    assertNull(LinkPicture.sample(12001, 100, 480))
    assertNull(LinkPicture.sample(8000, 8000, 480))
    assertEquals(listOf(480, 360, 240), LinkPicture.edges(480))
    assertEquals(Pair(480, 252), LinkPicture.fitted(960, 504, 480))
    assertEquals(Pair(120, 480), LinkPicture.fitted(500, 2000, 480))
    // Never made larger.
    assertEquals(Pair(200, 100), LinkPicture.fitted(200, 100, 480))
    assertEquals(listOf(82, 70, 58, 46, 34), LinkPicture.qualities)
  }

  @Test fun theLimitsAreTheCoresAndHaveTheirOwnWithoutIt() {
    val base = LinkCore.Limits()
    assertEquals(listOf(262144, 2097152, 24576, 480, 3), listOf(base.htmlBytes, base.imageDownloadBytes, base.imageBytes, base.imageSide, base.redirects))
    assertEquals(6000L, base.timeoutMs)
    assertEquals(base, LinkCore.limits(null))
    assertEquals(base, LinkCore.limits(mapOf("htmlBytes" to 0.0, "imageSide" to -5.0, "timeoutMs" to "6000", "redirects" to Double.NaN)))
    assertEquals(LinkCore.Limits(1000, 2000, 300, 240, 0, 2500),
      LinkCore.limits(mapOf("htmlBytes" to 1000.0, "imageDownloadBytes" to 2000.0, "imageBytes" to 300.0, "imageSide" to 240.0, "redirects" to 0.0, "timeoutMs" to 2500.0)))
  }

  @Test fun theComposerWaitsOnlyForATextThatCouldHoldALink() {
    assertTrue(LinkComposer.mayHoldLink("смотри HTTPS://example.org"))
    assertTrue(LinkComposer.mayHoldLink("www.example.org"))
    assertFalse(LinkComposer.mayHoldLink("http://example.org"))
    assertFalse(LinkComposer.mayHoldLink("привет"))
    assertEquals(600L, LinkComposer.pause)
    assertEquals("Предпросмотр ссылок", LinkSettings.label)
    assertTrue(LinkSettings.words.startsWith("Когда ты пишешь ссылку, телефон сам загружает страницу"))
    assertTrue(LinkSettings.words.endsWith("карточки от собеседников показываются по-прежнему."))
  }
}
