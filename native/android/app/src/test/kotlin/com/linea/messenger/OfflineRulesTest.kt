package com.linea.messenger

import com.linea.messenger.app.Messenger
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.core.Core
import com.linea.messenger.offline.ChatCache
import com.linea.messenger.offline.ListCatchUp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** Offline (offline/): the vault's copy of the chat list and of a chat's page (the reference's chatListCache.ts) and
 *  the rules of the list's closed lines (listCatchUp.ts) — what needs no phone and no server. */
class OfflineRulesTest {
  private val moscow = ZoneId.of("Europe/Moscow")
  private val now = Instant.parse("2026-11-21T09:00:00Z")
  private val me = "user-me"

  private fun message(id: Int, chatId: String = "chat1", text: String = "Привет", state: String = "decrypted", extra: Map<String, Any?> = emptyMap()): Map<String, Any?> =
    linkedMapOf<String, Any?>("id" to id, "chatId" to chatId, "senderId" to "peer", "clientId" to "c$id", "text" to text, "attachment" to null,
      "createdAt" to "2026-11-21T06:0$id:00.000Z", "cryptoState" to state) + extra

  private fun chat(id: String, last: Map<String, Any?>?, unread: Int = 0, updatedAt: String = "2026-11-21T06:00:00.000Z"): Map<String, Any?> =
    linkedMapOf("id" to id, "peer" to mapOf("id" to "peer-$id", "displayName" to "Имя $id"), "updatedAt" to updatedAt, "unreadCount" to unread, "lastMessage" to last)

  private fun summary(chat: Map<String, Any?>, shown: Map<String, Any?>?) = Messenger.summary(chat, shown, me, now, moscow, "", "https://localhost:8443")!!

  @Test fun theNamesAreTheReferencesAndTheCores() {
    assertEquals("page:v1:abc_D-9", ChatCache.pageName("abc_D-9"))
    assertNull(ChatCache.pageName("a/b"))
    assertNull(ChatCache.pageName(""))
    assertNull(ChatCache.pageName("x".repeat(81)))
    assertTrue(ChatCache.isCacheName("chats:v1"))
    assertTrue(ChatCache.isCacheName("page:v1:chat1"))
    assertFalse(ChatCache.isCacheName("page:v1:"))
    assertFalse(ChatCache.isCacheName("protocol"))
    assertFalse(ChatCache.isCacheName("saved:v1"))
  }

  @Test fun theListGoesToTheVaultWithoutCiphertextAndComesBackInItsOrder() {
    val server = message(5, text = "", state = "no-key", extra = mapOf("encrypted" to mapOf("body" to "secret"), "lean" to true))
    val shown = message(5, text = "Добрый вечер")
    val chats = listOf(summary(chat("b", server), shown), summary(chat("a", null), null))
    val raw = ChatCache.encodeList(chats)!!
    assertFalse(raw.contains("secret"))
    assertFalse(raw.contains("encrypted"))
    val back = ChatCache.decodeList(raw)
    assertEquals(listOf("b", "a"), back.map { it["id"] })
    assertEquals("Добрый вечер", Core.map(back[0]["lastMessage"])?.get("text"))
    assertNull(back[1]["lastMessage"])
    // Shown again as rows with the same line.
    val rows = ChatRow.parse(back.map { summary(it, Core.map(it["lastMessage"])).row })
    assertEquals("Добрый вечер", rows[0].preview)
    assertFalse(rows[0].quietPreview)
  }

  @Test fun aDamagedOrForeignListReadsAsNothing() {
    assertEquals(emptyList<Map<String, Any?>>(), ChatCache.decodeList(null))
    assertEquals(emptyList<Map<String, Any?>>(), ChatCache.decodeList("not json"))
    assertEquals(emptyList<Map<String, Any?>>(), ChatCache.decodeList("{\"id\":\"x\"}"))
    // A chat without its peer, a message without its text, and a repeated id are left out.
    val raw = Core.text(listOf(
      mapOf("id" to "1", "updatedAt" to "t", "unreadCount" to 0, "lastMessage" to null),
      chat("2", message(1) - "text"),
      chat("3", message(1)),
      chat("3", message(2)),
    ))
    assertEquals(listOf("3"), ChatCache.decodeList(raw).map { it["id"] })
  }

  @Test fun aChatsPageKeepsTheNewestSixtyAndNothingBeingSent() {
    val messages = (1..70).map { message(it) } + listOf(message(71) + mapOf("localState" to "sending"), message(0))
    val raw = ChatCache.encodePage(messages, hasMore = false)!!
    val back = ChatCache.decodePage(raw, "chat1")!!
    assertEquals((11..70).toList(), back.messages.map { (it["id"] as Number).toInt() })
    assertTrue(back.hasMore) // ten older ones were left out
    assertNull(ChatCache.decodePage(raw, "other"))
    assertNull(ChatCache.decodePage("[]", "chat1"))
    val small = ChatCache.decodePage(ChatCache.encodePage(listOf(message(2), message(1)), hasMore = false), "chat1")!!
    assertEquals(listOf(1, 2), small.messages.map { (it["id"] as Number).toInt() })
    assertFalse(small.hasMore)
  }

  @Test fun aClosedLineIsSaidQuietlyAndSettledOnlyByThisDevicesVerdict() {
    val closed = message(4, text = "Зашифрованное сообщение. Открой чат для расшифровки.", state = "no-key")
    assertTrue(ListCatchUp.awaitsInbox(closed))
    assertFalse(ListCatchUp.awaitsInbox(closed + mapOf("mesh" to true)))
    assertFalse(ListCatchUp.awaitsInbox(message(4)))
    val settled = ListCatchUp.settled(closed)
    assertEquals(ListCatchUp.NOT_FOR_DEVICE, settled["text"])
    assertEquals("Это сообщение недоступно на данном устройстве.", settled["text"])
    // Only a full sync with a preview that ran says so; anything else is shown as it is and tried again.
    assertEquals(ListCatchUp.NOT_FOR_DEVICE to true, ListCatchUp.afterSync(closed, ListCatchUp.Outcome.SYNCED, true).let { it.first["text"] to it.second })
    assertEquals(closed, ListCatchUp.afterSync(closed, ListCatchUp.Outcome.PARTIAL, true).first)
    assertEquals(closed, ListCatchUp.afterSync(closed, ListCatchUp.Outcome.SYNCED, false).first)
    // The row says it quietly.
    val row = ChatRow.parse(listOf(summary(chat("x", closed), settled).row))[0]
    assertTrue(row.quietPreview)
    assertEquals(ListCatchUp.NOT_FOR_DEVICE, row.preview)
  }

  @Test fun aLineOpenedHereNeverTurnsClosedAgain() {
    val closed = message(4, text = "Зашифрованное сообщение. Открой чат для расшифровки.", state = "no-key")
    val opened = message(4, text = "Привет")
    assertEquals(opened, ListCatchUp.kept(closed, opened))
    assertEquals(ListCatchUp.settled(closed), ListCatchUp.kept(closed, ListCatchUp.settled(closed)))
    // Another message, or a fresh line that is open, wins.
    assertEquals(closed, ListCatchUp.kept(closed, message(3, text = "Старое")))
    assertEquals(opened, ListCatchUp.kept(opened, message(4, text = "Другое")))
    assertEquals(closed, ListCatchUp.kept(closed, null))
    // The vault or Signal threw: a placeholder, still closed.
    val placeholder = ListCatchUp.placeholder(message(4, text = "", extra = mapOf("lean" to true)))
    assertEquals("no-key", placeholder["cryptoState"])
    assertEquals("Зашифрованное сообщение недоступно на этом устройстве.", placeholder["text"])
  }

  @Test fun theChatsToOpenAreUnreadThenNewestAndAtMostTwenty() {
    val closed = { id: Int -> message(id, text = "", state = "no-key") }
    val chats = listOf(
      summary(chat("old", closed(1), updatedAt = "2026-11-20T06:00:00.000Z"), closed(1)),
      summary(chat("new", closed(2), updatedAt = "2026-11-21T06:00:00.000Z"), closed(2)),
      summary(chat("unread", closed(3), unread = 2, updatedAt = "2026-11-19T06:00:00.000Z"), closed(3)),
      summary(chat("open", message(4), updatedAt = "2026-11-21T07:00:00.000Z"), message(4)),
      summary(chat("tried", closed(5), updatedAt = "2026-11-21T08:00:00.000Z"), closed(5)),
    )
    assertEquals(listOf("unread", "new", "old"), ListCatchUp.targets(chats, { id, message -> id == "tried" && message == 5L }))
    assertEquals(listOf("unread"), ListCatchUp.targets(chats, { _, _ -> false }, limit = 1))
    val many = (1..30).map { summary(chat("c$it", closed(1)), closed(1)) }
    assertEquals(ListCatchUp.CHATS_PER_PASS, ListCatchUp.targets(many, { _, _ -> false }).size)
  }
}
