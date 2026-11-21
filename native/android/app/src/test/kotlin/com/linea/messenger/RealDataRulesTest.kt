package com.linea.messenger

import com.linea.messenger.app.Messenger
import com.linea.messenger.auth.Account
import com.linea.messenger.auth.AuthScreen
import com.linea.messenger.chat.MsgRow
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.core.Core
import com.linea.messenger.storage.Vault
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** The rules of the real-data path that need no phone and no core: the words of time, the rows of the list and
 *  of a chat, the checks of signing in, the names the storage goes by, JSON as the app holds it. */
class RealDataRulesTest {
  private val moscow = ZoneId.of("Europe/Moscow")
  /** Saturday 21 November 2026, 12:00 in Moscow. */
  private val now = Instant.parse("2026-11-21T09:00:00Z")
  private val me = "user-me"

  @Test fun theTimeOfAChatInTheList() {
    fun at(text: String?) = Messenger.listTime(text, now, moscow)
    assertEquals("09:05", at("2026-11-21T06:05:00.000Z"))
    assertEquals("00:00", at("2026-11-20T21:00:00Z"))            // midnight in Moscow is already today
    assertEquals("Вчера", at("2026-11-20T20:59:59.999Z"))
    assertEquals("Вчера", at("2026-11-19T21:00:00.000Z"))
    assertEquals("Чт", at("2026-11-19T10:00:00.000Z"))
    assertEquals("Вс", at("2026-11-15T10:00:00.000Z"))            // six days ago: still the weekday
    assertEquals("14.11", at("2026-11-14T10:00:00.000Z"))         // a week ago: the date
    assertEquals("03.01", at("2025-01-03T10:00:00+03:00"))
    assertEquals("", at(null))
    assertEquals("", at("yesterday"))
  }

  @Test fun theDayAboveTheFirstMessageOfADay() {
    fun at(text: String) = Messenger.dayWords(Instant.parse(text), now, moscow)
    assertEquals("Сегодня", at("2026-11-21T00:30:00Z"))
    assertEquals("Вчера", at("2026-11-20T08:00:00Z"))
    assertEquals("12 ноября", at("2026-11-12T08:00:00Z"))
    assertEquals("1 января", at("2025-12-31T22:00:00Z"))          // already the new year in Moscow
    assertEquals("3 марта 2025", at("2025-03-03T08:00:00Z"))
  }

  private fun message(id: Int, sender: String, text: String, at: String, client: String = "c$id") =
    mapOf<String, Any?>("id" to id.toDouble(), "senderId" to sender, "clientId" to client, "text" to text, "createdAt" to at)

  @Test fun theRowsOfAChat() {
    val rows = Messenger.rows(listOf(
      message(1, "peer", "Привет", "2026-11-20T10:00:00.000Z"),
      message(2, me, "Привет!", "2026-11-20T10:01:00.000Z"),
      message(3, me, "Как дела?", "2026-11-21T06:00:00.000Z"),
      message(4, "peer", "", "2026-11-21T06:02:00.000Z") + mapOf("attachment" to mapOf("mimeType" to "image/jpeg", "name" to "a.jpg")),
    ), me, peerLastRead = 2, now, moscow)
    assertEquals(listOf("day-0", "peer:c1", "$me:c2", "day-2", "$me:c3", "peer:c4"), rows.map { it["key"] })
    assertEquals(listOf("Вчера", "Привет", "Привет!", "Сегодня", "Как дела?", "Фото"), rows.map { it["text"] })
    assertEquals(listOf(1, 0, 0, 1, 0, 0), rows.map { it["kind"] })
    // Two ticks up to what the other side has read, one after it, none on their messages.
    assertEquals(listOf(null, 0, 2, null, 1, 0), rows.map { it["ticks"] })
    // The tail is on the last message of a run of one person's.
    assertEquals(listOf(null, true, false, null, true, true), rows.map { it["tail"] })
    assertEquals(listOf(null, "13:00", "13:01", null, "09:00", "09:02"), rows.map { it["time"] })
    val drawn = MsgRow.parse(rows)
    assertEquals(6, drawn.size)
    assertTrue(drawn[2].mine && drawn[2].ticks == 2 && !drawn[2].tail)
    assertEquals(emptyList<Map<String, Any?>>(), Messenger.rows(emptyList(), me, 0, now, moscow))
  }

  @Test fun theRowsOfAFoldedPage() {
    // A page as the core folds it: an edited message with its formatting, reactions gathered on their messages.
    val page = listOf(
      message(1, "peer", "Смотри https://example.com", "2026-11-21T06:00:00.000Z") + mapOf("edited" to false,
        "reactions" to listOf(mapOf("emoji" to "👍", "count" to 2.0, "mine" to true), mapOf("emoji" to "🔥", "count" to 1.0, "mine" to false))),
      message(2, me, "Очень важно", "2026-11-21T06:01:00.000Z") + mapOf("edited" to true, "reactions" to emptyList<Any?>(),
        "meta" to mapOf("entities" to listOf(mapOf("type" to "bold", "offset" to 6.0, "length" to 5.0)))),
      message(3, me, "", "2026-11-21T06:02:00.000Z") + mapOf("attachment" to mapOf("mimeType" to "image/jpeg"), "reactions" to listOf(mapOf("emoji" to "❤️"))),
    )
    // The layout of a text stands in for the core's `nativeText` here: what it is asked, and what the row does with the answer.
    val asked = ArrayList<Pair<String, Any?>>()
    val rows = Messenger.rows(page, me, peerLastRead = 2, now, moscow) { text, entities ->
      asked.add(text to entities)
      when (text) {
        "Смотри https://example.com" -> mapOf("text" to text, "fmt" to listOf(64.0, 7.0, 19.0), "urls" to listOf("https://example.com"))
        "Очень важно" -> mapOf("text" to text, "fmt" to listOf(1.0, 6.0, 5.0), "urls" to emptyList<Any?>())
        else -> mapOf("text" to "", "fmt" to emptyList<Any?>(), "urls" to emptyList<Any?>())
      }
    }
    assertEquals(listOf<Pair<String, Any?>>("Смотри https://example.com" to null, "Очень важно" to listOf(mapOf("type" to "bold", "offset" to 6.0, "length" to 5.0)), "" to null), asked)
    val drawn = MsgRow.parse(rows)
    assertEquals(listOf("Сегодня", "Смотри https://example.com", "Очень важно", "Фото"), drawn.map { it.text })
    // «изм. » stands before the time of the edited message only.
    assertEquals(listOf("", "09:00", "изм. 09:01", "09:02"), drawn.map { it.time })
    assertEquals(listOf(emptyList(), listOf(64, 7, 19), listOf(1, 6, 5), emptyList()), drawn.map { it.fmt })
    assertEquals(listOf(emptyList(), listOf("https://example.com"), emptyList(), emptyList()), drawn.map { it.urls })
    // Chips: [emoji, count, "1" if mine] for each reaction, in the page's order; a count that is missing is one.
    assertEquals(listOf(emptyList(), listOf("👍", "2", "1", "🔥", "1", ""), emptyList(), listOf("❤️", "1", "")), drawn.map { it.chips })
    assertEquals(listOf(0, 0, 2, 1), drawn.map { it.ticks })
    // Without an answer of the layout the text is shown plain.
    val plain = MsgRow.parse(Messenger.rows(page, me, 2, now, moscow) { _, _ -> null })
    assertEquals(listOf("Сегодня", "Смотри https://example.com", "Очень важно", "Фото"), plain.map { it.text })
    assertTrue(plain.all { it.fmt.isEmpty() && it.urls.isEmpty() })
  }

  @Test fun whatBecomesOfARefusedSending() {
    // The list of devices changed: the ciphertext is dropped and made afresh, whatever the status.
    assertEquals(Messenger.Refusal.AFRESH, Messenger.afterRefusal(409, "E2EE_DEVICES_CHANGED"))
    // Refused for good: forgotten, so it is not sent again after every start.
    for (status in listOf(400, 403, 404, 413, 422)) assertEquals(Messenger.Refusal.FORGET, Messenger.afterRefusal(status, null))
    assertEquals(Messenger.Refusal.FORGET, Messenger.afterRefusal(403, "BLOCKED"))
    // A dead session, «too slow», «too often», and the server's own trouble: kept for later.
    for (status in listOf(401, 408, 429, 500, 503, 0)) assertEquals(Messenger.Refusal.KEEP, Messenger.afterRefusal(status, null))
  }

  @Test fun aChatOfTheList() {
    val chat = mapOf<String, Any?>(
      "id" to "chat-1", "unreadCount" to 3.0, "peerLastReadMessageId" to 7.0,
      "peer" to mapOf("id" to "peer", "displayName" to "алиса воронцова младшая", "avatarColor" to "#34C3A0"),
      "settings" to mapOf("muted" to true, "pinnedAt" to "2026-11-01T00:00:00.000Z"),
    )
    val mine = Messenger.summary(chat, message(7, me, "До завтра", "2026-11-21T06:05:00.000Z"), me, now, moscow)!!
    assertEquals(listOf("chat-1", "peer", "алиса воронцова младшая", 7L), listOf(mine.id, mine.peerId, mine.title, mine.peerLastRead))
    val row = ChatRow.parse(listOf(mine.row)).single()
    assertEquals("До завтра", row.preview)
    assertEquals("09:05", row.time)
    assertEquals(3, row.unread)
    assertTrue(row.muted && row.pinned)
    assertEquals(2, row.ticks)                                    // read by the other side
    assertEquals("АВ", row.initials)
    assertEquals(0xFF34C3A0.toInt(), row.avatarColor)
    assertTrue(row.orbA != 0 && row.orbB != 0)
    // Not read yet: one tick. Their message: none. No message: an empty line.
    assertEquals(1, Messenger.summary(chat, message(8, me, "Ещё", "2026-11-21T06:06:00.000Z"), me, now, moscow)!!.row["ticks"])
    assertEquals(0, Messenger.summary(chat, message(8, "peer", "Ок", "2026-11-21T06:06:00.000Z"), me, now, moscow)!!.row["ticks"])
    val silent = Messenger.summary(chat - "settings", null, me, now, moscow)!!.row
    assertEquals(listOf("", "", false, false), listOf(silent["preview"], silent["time"], silent["muted"], silent["pinned"]))
    // The picture of the other person is asked from the chat's own server; the part of the list is the caller's word.
    val pictured = Messenger.summary(chat + mapOf("peer" to mapOf("id" to "peer", "displayName" to "Лев", "avatarId" to "a/b c")), null, me, now, moscow, "Сегодня", "https://localhost:8443")!!
    assertEquals(listOf("https://localhost:8443/files/a%2Fb%20c", "a/b c", "Сегодня"), listOf(pictured.row["avatarUrl"], pictured.row["avatarKey"], pictured.row["section"]))
    assertEquals("", mine.row["avatarUrl"])
    // The parts of the list: pinned first, then by the day of the last message.
    fun part(at: String?) = Messenger.section(mapOf("lastMessage" to mapOf("createdAt" to at)), now, moscow)
    assertEquals("Закреплённые", Messenger.section(chat, now, moscow))
    assertEquals(listOf("Сегодня", "Вчера", "Раньше", "Раньше"), listOf(part("2026-11-21T06:00:00Z"), part("2026-11-20T06:00:00Z"), part("2026-11-10T06:00:00Z"), part(null)))
    // A chat the app cannot name or has nobody in is not a row.
    assertNull(Messenger.summary(chat - "id", null, me, now, moscow))
    assertNull(Messenger.summary(chat - "peer", null, me, now, moscow))
  }

  @Test fun theWordsOfAMessageWithoutText() {
    fun file(type: String, name: String? = null) = Messenger.previewText(mapOf("text" to "", "attachment" to mapOf("mimeType" to type, "name" to name)))
    assertEquals("Фото", file("image/png"))
    assertEquals("Видео", file("video/mp4"))
    assertEquals("Голосовое сообщение", file("audio/ogg"))
    assertEquals("план.pdf", file("application/pdf", "план.pdf"))
    assertEquals("Файл", file("application/pdf"))
    assertEquals("", Messenger.previewText(mapOf("id" to 1.0)))
    assertEquals("текст", Messenger.previewText(mapOf("text" to "текст", "attachment" to mapOf("mimeType" to "image/png"))))
  }

  @Test fun lettersAndColours() {
    assertEquals("АВ", Messenger.initials("Алиса Воронцова"))
    assertEquals("М", Messenger.initials("мама"))
    assertEquals("КЗ", Messenger.initials("  Команда   запуска  сегодня"))
    assertEquals("", Messenger.initials(""))
    assertEquals("😀Я", Messenger.initials("😀смех Я"))
    assertEquals(0x34C3A0, Messenger.color("#34C3A0"))
    assertEquals(0xabcdef, Messenger.color("#abcdef"))
    for (bad in listOf(null, "", "34C3A0", "#34C3A", "#34C3A0FF", "#GGGGGG", "#+1234 ")) assertEquals(0x5E7BFF, Messenger.color(bad))
  }

  @Test fun theChecksOfSigningIn() {
    for (good in listOf("abc", "native_tester", "A1_", "x".repeat(24))) assertTrue(good, AuthScreen.validLogin(good))
    for (bad in listOf("", "ab", "x".repeat(25), "имя", "a b", "a-b", "abc\n", "a@b")) assertFalse(bad, AuthScreen.validLogin(bad))
    assertTrue(AuthScreen.validPassword("p"))
    assertTrue(AuthScreen.validPassword("я".repeat(128)))
    assertTrue(AuthScreen.validPassword("😀".repeat(128)))        // counted as a person sees them
    assertFalse(AuthScreen.validPassword(""))
    assertFalse(AuthScreen.validPassword("x".repeat(129)))
    assertEquals("ambergardenprism", AuthScreen.confirmationWord("  AmberGardenPrism\n"))
    assertEquals("ёлка", AuthScreen.confirmationWord("ЁЛКА"))   // composed, then small letters
    assertEquals("", AuthScreen.confirmationWord("   "))
    assertEquals(4L, AuthScreen.wholeNumber(4.0))
    assertNull(AuthScreen.wholeNumber(4.5))
    assertNull(AuthScreen.wholeNumber("4"))
  }

  @Test fun theNameOfADevice() {
    assertEquals("Samsung SM-S911B", Account.deviceName("samsung", "SM-S911B"))
    assertEquals("Google Pixel 8", Account.deviceName("google", "Pixel 8"))
    assertEquals("Google Pixel 8", Account.deviceName("Google", "Google Pixel 8"))
    assertEquals("Pixel 8", Account.deviceName(null, " Pixel 8 "))
    assertNull(Account.deviceName("samsung", " "))
  }

  @Test fun theStorageIsNamedAsThePreviousAppNamedIt() {
    // sha256("https://api.invizent.com" + NUL + user id), as mobile/src/e2ee/vault.native.ts makes it.
    val scope = Vault.scope("https://api.invizent.com", "00000000-0000-4000-8000-00000000c0de")
    assertEquals("d861a9301dc1bf7ce549649b946fb099185eab2ee6c331affc75ef99299d261c", scope)
    assertEquals("linea.e2ee.v1.$scope", Vault.keyName(scope))
  }

  @Test fun jsonAsTheAppHoldsIt() {
    val text = """{"b":[1,2.5,"три",null,true],"a":{"id":9007199254740991,"пусто":{}}}"""
    val value = Core.map(Core.value(text))!!
    assertEquals(listOf(1.0, 2.5, "три", null, true), value["b"])
    assertEquals(text, Core.text(value))                          // the order of the keys and whole numbers survive
    assertEquals("""["chat",12,null]""", Core.text(listOf("chat", 12L, null)))
    assertNull(Core.value("{"))
    assertNull(Core.value(null))
    assertNull(Core.text(mapOf("when" to Instant.EPOCH)))          // not JSON: nothing is written, nothing is guessed
  }
}
