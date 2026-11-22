package com.linea.messenger

import com.linea.messenger.chatactions.ChatActionsDemo
import com.linea.messenger.chatactions.ChatForward
import com.linea.messenger.chatactions.ChatHistory
import com.linea.messenger.chatactions.ChatListActions
import com.linea.messenger.chatactions.ChatLocal
import com.linea.messenger.chatactions.ChatScreenActions
import com.linea.messenger.chatactions.DownButton
import com.linea.messenger.chatactions.ForwardDraft
import com.linea.messenger.chatactions.ForwardPicker
import com.linea.messenger.chatactions.MessageReactions
import com.linea.messenger.chat.MsgRow
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.core.Core
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** The rules and the words of the actions on messages and chats (chatactions/): what needs no phone. The tests
 *  that ask the core (folding, the 48 hours, the words of an action) are skipped when the core for this machine
 *  has not been built (native/android/build-core-host.sh). */
class ChatActionsRulesTest {
  private val moscow = ZoneId.of("Europe/Moscow")
  /** Saturday 21 November 2026, 12:00 in Moscow. */
  private val now = Instant.parse("2026-11-21T09:00:00Z")
  private val me = "user-me"

  private fun message(id: Int, sender: String, text: String, at: String = "2026-11-21T06:00:00.000Z", meta: Map<String, Any?>? = null, state: String = "decrypted"): Map<String, Any?> {
    val made = linkedMapOf<String, Any?>("id" to id, "chatId" to "chat", "senderId" to sender, "clientId" to "c$id", "text" to text, "attachment" to null, "createdAt" to at, "cryptoState" to state)
    if (meta != null) made["meta"] = meta
    return made
  }

  private fun ids(list: List<Map<String, Any?>>) = list.map { ChatHistory.number(it["id"]).toInt() }

  // Pages

  @Test fun anOlderPageIsOnlyAdded() {
    val loaded = listOf(message(5, me, "e"), message(6, "peer", "f"))
    val applied = ChatHistory.applyPage(loaded, hadMore = true, page = listOf(message(3, me, "c"), message(4, me, "d")), older = true, more = false)
    assertEquals(listOf(3, 4, 5, 6), ids(applied.raw))
    assertFalse(applied.hasMore)
  }

  @Test fun theNewestPageReplacesItsOwnRangeAndKeepsWhatWasScrolledUp() {
    val loaded = (1..6).map { message(it, me, "m$it") }
    // 5 was deleted on the server; 7 is new; the page overlaps what is loaded, so 1…3 stay.
    val applied = ChatHistory.applyPage(loaded, hadMore = false, page = listOf(message(4, me, "m4"), message(6, me, "m6"), message(7, "peer", "m7")), older = false, more = true)
    assertEquals(listOf(1, 2, 3, 4, 6, 7), ids(applied.raw))
    assertFalse(applied.hasMore)   // the older ones are kept, so what was known of «more» stays
  }

  @Test fun aPageThatDoesNotReachWhatIsLoadedReplacesIt() {
    val loaded = (1..3).map { message(it, me, "m$it") }
    val applied = ChatHistory.applyPage(loaded, hadMore = false, page = listOf(message(60, me, "x"), message(61, me, "y")), older = false, more = true)
    assertEquals(listOf(60, 61), ids(applied.raw))
    assertTrue(applied.hasMore)
    // The whole chat fits the page: older leftovers were deleted on the server and go too.
    assertEquals(listOf(2, 3), ids(ChatHistory.applyPage(loaded, true, listOf(message(2, me, "b"), message(3, me, "c")), older = false, more = false).raw))
    assertEquals(emptyList<Int>(), ids(ChatHistory.applyPage(loaded, true, emptyList(), older = false, more = false).raw))
  }

  // Words

  @Test fun theWordsOfMessagesWithoutAKey() {
    assertEquals(listOf("сообщение", "сообщения", "сообщений", "сообщений", "сообщение", "сообщения", "сообщений"),
      listOf(1, 3, 5, 11, 21, 22, 112).map { ChatHistory.missingWords(it) })
  }

  @Test fun theQuoteFallsBackToTheStoredLine() {
    assertEquals("Лучше распечатки, там таблица", ChatHistory.quoteText(null, "Лучше  распечатки,\nтам\tтаблица"))
    assertEquals("Сообщение удалено", ChatHistory.quoteText(null, "  \n"))
  }

  @Test fun theHeadingsOfAForward() {
    assertEquals("Переслать сообщение", ChatScreenActions.forwardHeading(1))
    assertEquals("Переслать 3 сообщения", ChatScreenActions.forwardHeading(3))
    assertEquals("Переслать 7 сообщений", ChatScreenActions.forwardHeading(7))
    assertEquals("Переслать", ForwardPicker.heading(1))
    assertEquals("Переслать (4)", ForwardPicker.heading(4))
    assertEquals("Изменить сообщение можно в течение 48 часов после отправки.", ChatScreenActions.editWindowClosed)
  }

  @Test fun theBadgeOfTheWayDown() {
    assertEquals(listOf("", "1", "99", "99+"), listOf(0, 1, 99, 100).map { DownButton.badgeWords(it) })
  }

  @Test fun theReactionsAreTheReferenceSet() {
    assertEquals(42, MessageReactions.all.size)
    assertEquals(MessageReactions.all.size, MessageReactions.all.toSet().size)
    assertEquals(listOf("👍", "❤️", "😂", "😮", "😢", "🔥", "👎"), MessageReactions.all.take(MessageReactions.quick))
  }

  // The menu of a message

  @Test fun whatTheMenuOffers() {
    val theirs = message(1, "peer", "Привет")
    assertEquals(listOf("reply", "copy", "pin", "forward", "delete", "select"), ChatScreenActions.menuItems(theirs, noCopy = false, pinnedNow = false, editable = false))
    assertEquals(listOf("reply", "copy", "pin", "forward", "edit", "delete", "select"), ChatScreenActions.menuItems(message(2, me, "Да"), false, false, editable = true))
    // «Копирование запрещено»: nothing leaves the chat.
    assertEquals(listOf("reply", "pin", "delete", "select"), ChatScreenActions.menuItems(theirs, noCopy = true, pinnedNow = false, editable = false))
    // A message this device cannot read: only deleting and choosing.
    assertEquals(listOf("delete", "select"), ChatScreenActions.menuItems(message(3, "peer", "", state = "no-key"), false, false, false))
    // On its way out: its text can be copied; refused: it can be sent again.
    assertEquals(listOf("copy"), ChatScreenActions.menuItems(message(4, me, "Иду") + ("localState" to "sending"), false, false, false))
    assertEquals(listOf("copy", "retry"), ChatScreenActions.menuItems(message(4, me, "Иду") + ("localState" to "failed"), false, false, false))
  }

  @Test fun whoMayEditWhat() {
    assertTrue(ChatScreenActions.mayEdit(message(1, me, "Привет"), me))
    assertFalse(ChatScreenActions.mayEdit(message(1, "peer", "Привет"), me))
    assertFalse(ChatScreenActions.mayEdit(message(1, me, "Привет") + ("localState" to "sending"), me))
    assertFalse(ChatScreenActions.mayEdit(message(1, me, ""), me))
    assertFalse(ChatScreenActions.mayEdit(message(1, me, "Опрос", meta = mapOf("poll" to mapOf("question" to "?"))), me))
    val voice = mapOf("mimeType" to "audio/mp4", "name" to "voice-1.m4a"); val circle = mapOf("mimeType" to "video/mp4", "name" to "circle-1.mp4")
    assertTrue(ChatScreenActions.isVoice(voice)); assertTrue(ChatScreenActions.isVideoNote(circle))
    assertFalse(ChatScreenActions.mayEdit(message(1, me, "") + ("attachment" to voice), me))
    assertFalse(ChatScreenActions.mayEdit(message(1, me, "") + ("attachment" to circle), me))
    // The caption of a photo is edited like a text.
    assertTrue(ChatScreenActions.mayEdit(message(1, me, "") + ("attachment" to mapOf("mimeType" to "image/jpeg", "name" to "a.jpg")), me))
  }

  @Test fun oneReactionPerPersonAndTheSameOneAgainTakesItOff() {
    val plain = message(1, "peer", "Привет")
    assertEquals(mapOf("type" to "react", "target" to "c1", "emoji" to "❤️"), ChatScreenActions.reaction(plain, "❤️"))
    val reacted = plain + ("reactions" to listOf(mapOf("emoji" to "👍", "count" to 2, "mine" to false), mapOf("emoji" to "❤️", "count" to 1, "mine" to true)))
    assertEquals(mapOf("type" to "react", "target" to "c1", "emoji" to null), ChatScreenActions.reaction(reacted, "❤️"))
    assertEquals("👍", ChatScreenActions.reaction(reacted, "👍")?.get("emoji"))
    assertNull(ChatScreenActions.reaction(mapOf("text" to "x"), "👍"))
  }

  @Test fun theStepsOfGoingToAMessage() {
    fun step(found: Boolean = false, noKey: Boolean = false, deleted: Boolean = false, loading: Boolean = false, hasMore: Boolean = true, pages: Int = 0) =
      ChatScreenActions.jumpStep(found, noKey, deleted, loading, hasMore, pages)
    assertEquals("scroll", step(found = true))
    assertEquals("no-key", step(noKey = true))
    assertEquals("deleted", step(deleted = true))
    assertEquals("wait", step(loading = true))
    assertEquals("deleted", step(hasMore = false))
    assertEquals("load", step(pages = 29))
    assertEquals("too-far", step(pages = 30))
  }

  // Forwarding

  @Test fun aTextIsClippedWithoutCuttingACharacter() {
    assertEquals("абв", ChatForward.clipped("абв", 3))
    assertEquals("аб", ChatForward.clipped("абв", 2))
    // «😀» is two UTF-16 units: it does not fit into the one that is left.
    assertEquals("а", ChatForward.clipped("а😀б", 2))
    assertEquals("а😀", ChatForward.clipped("а😀б", 3))
  }

  @Test fun whatTravelsWithAForwardedMessage() {
    val entities = listOf(mapOf("type" to "bold", "offset" to 0, "length" to 3))
    val meta = ChatForward.meta(message(1, "peer", "Три пункта", meta = mapOf("entities" to entities, "reply" to mapOf("clientId" to "c0"))), "  Дмитрий Орлов ")
    assertEquals(mapOf("forward" to mapOf("from" to "Дмитрий Орлов"), "entities" to entities), meta)
    assertEquals(mapOf("forward" to mapOf("from" to "собеседник")), ChatForward.meta(message(1, "peer", "Привет"), " "))
    assertNull(ChatForward.meta(message(1, "peer", "  "), "Имя"))
    assertEquals(80, (ChatForward.meta(message(1, "peer", "x"), "я".repeat(200))?.get("forward") as Map<*, *>)["from"].toString().length)
  }

  @Test fun aForwardWaitsForOneChat() {
    ForwardDraft.put("chat-1", listOf(ForwardDraft.Item(message(1, "peer", "Привет"), "Алиса")))
    assertEquals(1, ForwardDraft.waiting("chat-1").size)
    assertEquals(0, ForwardDraft.waiting("chat-2").size)
    ForwardDraft.clear()
    assertEquals(0, ForwardDraft.waiting("chat-1").size)
  }

  @Test fun theChatsOfThePickerAreFoundByName() {
    val all = listOf(ForwardPicker.Target("1", "p1", "Алиса Воронцова", null, null), ForwardPicker.Target("2", "p2", "Лев", null, null))
    assertEquals(listOf("Алиса Воронцова"), ForwardPicker.matching(all, " ворон ").map { it.name })
    assertEquals(2, ForwardPicker.matching(all, "").size)
    assertEquals(0, ForwardPicker.matching(all, "нет").size)
  }

  // What is kept on this device

  @Test fun hiddenNamesAreKeptOnceAndTheOldestGo() {
    assertEquals(listOf("a", "b", "c"), ChatLocal.hidden(listOf("a", "b"), listOf("b", "c", "c")))
    assertEquals(listOf("b", "c", "d"), ChatLocal.hidden(listOf("a", "b"), listOf("c", "d"), limit = 3))
  }

  @Test fun draftsAsTheyAreReadAndWritten() {
    val read = ChatLocal.readDrafts("""{"chat-1":"Привет","chat-2":"","chat-3":7,"${"x".repeat(81)}":"длинное имя"}""")
    assertEquals(mapOf("chat-1" to "Привет"), read)
    assertEquals(emptyMap<String, String>(), ChatLocal.readDrafts(null))
    assertEquals(emptyMap<String, String>(), ChatLocal.readDrafts("[1]"))
    assertEquals(8000, ChatLocal.readDrafts(Core.text(mapOf("c" to "я".repeat(9000))))["c"]?.length)
    assertEquals(mapOf("a" to "текст"), ChatLocal.draftsToKeep(mapOf("a" to "текст", "b" to "  \n")))
    assertEquals(200, ChatLocal.draftsToKeep((1..250).associate { "chat-$it" to "x" }).size)
  }

  // The list of chats

  private fun chat(id: String, title: String, settings: Map<String, Any?> = emptyMap(), unread: Int = 0, last: Map<String, Any?>? = message(9, "peer-$id", "Последнее"), username: String = "") =
    ChatListActions.Chat(id, "peer-$id", title, 0, mapOf("id" to id, "title" to title, "preview" to (last?.get("text") ?: ""), "time" to "09:00"),
      mapOf("id" to id, "peer" to mapOf("id" to "peer-$id", "username" to username), "settings" to settings, "unreadCount" to unread, "lastMessage" to last), last ?: emptyMap())

  private fun state(chats: List<ChatListActions.Chat>, archiveOpen: Boolean = false, query: String = "", hits: List<ChatListActions.Hit> = emptyList(), searching: Boolean = false,
                    fills: Map<String, ChatListActions.Fill> = emptyMap(), hidden: Set<String> = emptySet(), marked: Set<String> = emptySet(), drafts: Map<String, String> = emptyMap(), typing: Set<String> = emptySet()) =
    ChatListActions.State(chats, me, archiveOpen, query, hits, searching, fills, hidden, marked = { it in marked }, draft = { drafts[it] ?: "" }, typing = { it in typing }, now = now, zone = moscow)

  @Test fun theSoundOfAChat() {
    assertFalse(ChatListActions.muted(chat("1", "А"), now))
    assertTrue(ChatListActions.muted(chat("1", "А", mapOf("muted" to true)), now))
    assertTrue(ChatListActions.muted(chat("1", "А", mapOf("muted" to true, "mutedUntil" to "2026-11-21T10:00:00.000Z")), now))
    assertFalse(ChatListActions.muted(chat("1", "А", mapOf("muted" to true, "mutedUntil" to "2026-11-21T08:59:00.000Z")), now))
    assertTrue(ChatListActions.muted(chat("1", "А", mapOf("muted" to true, "mutedUntil" to "когда-нибудь")), now))
  }

  @Test fun whenTheSoundComesBack() {
    fun until(text: String) = ChatListActions.untilWords(Instant.parse(text), now, moscow)
    assertEquals("до 13:00", until("2026-11-21T10:00:00Z"))
    assertEquals("до завтра, 09:15", until("2026-11-22T06:15:00Z"))
    assertEquals("до 23 ноября, 12:00", until("2026-11-23T09:00:00Z"))
    assertEquals("до 2 января 2027, 12:00", until("2027-01-02T09:00:00Z"))
    assertEquals(listOf("На 1 час", "На 8 часов", "На 2 дня"), ChatListActions.muteSpans.map { it.first })
  }

  @Test fun theSettingsOfAChatAfterAChange() {
    val pinned = ChatListActions.changed(emptyMap(), mapOf("pinned" to true), now)
    assertEquals(now.toString(), pinned["pinnedAt"])
    assertNull(ChatListActions.changed(pinned, mapOf("pinned" to false), now)["pinnedAt"])
    assertEquals(mapOf("muted" to true, "mutedUntil" to "2026-11-21T10:00:00.000Z"), ChatListActions.changed(emptyMap(), mapOf("mutedUntil" to "2026-11-21T10:00:00.000Z"), now))
    assertEquals(mapOf("muted" to false, "mutedUntil" to null), ChatListActions.changed(mapOf("muted" to true, "mutedUntil" to "x"), mapOf("muted" to false), now))
    assertEquals(true, ChatListActions.changed(emptyMap(), mapOf("archived" to true), now)["archived"])
  }

  @Test fun theWordsOfTheList() {
    assertEquals(listOf("чат", "чата", "чатов", "чатов", "чат"), listOf(1, 2, 5, 11, 21).map { ChatListActions.plural(it, "чат", "чата", "чатов") })
    assertEquals("Черновик: Не забыть спросить", ChatListActions.draftLine(" Не забыть\nспросить "))
    assertEquals("", ChatListActions.draftLine(" \n"))
    assertEquals("Вы закрепили «План встречи»", ChatListActions.pinLine("📌 Закреплено: «План встречи»", mine = true, name = "Алиса"))
    assertEquals("Алиса закрепил(а) сообщение", ChatListActions.pinLine("Закреплено сообщение", mine = false, name = "Алиса"))
  }

  @Test fun whatTheListLooksPast() {
    fun action(fields: Map<String, Any?>) = message(1, "peer", "x", meta = mapOf("action" to fields))
    for (type in listOf("react", "vote", "edit", "delete")) assertTrue(ChatListActions.skipped(action(mapOf("type" to type, "target" to "c0"))))
    assertTrue(ChatListActions.skipped(action(mapOf("type" to "pin", "target" to null))))     // an unpin
    assertFalse(ChatListActions.skipped(action(mapOf("type" to "pin", "target" to "c0"))))
    assertTrue(ChatListActions.isPin(action(mapOf("type" to "pin", "target" to "c0"))))
    assertTrue(ChatListActions.skipped(action(mapOf("type" to "call", "step" to "offer"))))
    assertFalse(ChatListActions.skipped(action(mapOf("type" to "call", "step" to "end"))))
    assertFalse(ChatListActions.skipped(message(1, "peer", "Привет")))
  }

  @Test fun theLineOfAFoundMessage() {
    assertEquals("Короткий текст про проектор", ChatListActions.snippet("Короткий текст\nпро проектор", "проектор"))
    val long = "а".repeat(40) + " Проектор стоит в переговорной"
    assertEquals("…" + "а".repeat(15) + " Проектор стоит в переговорной", ChatListActions.snippet(long, "проектор"))
    assertEquals("нет такого слова", ChatListActions.snippet("нет такого слова", "проектор"))
  }

  @Test fun whatTheSearchFindsInTheKeptHistory() {
    val kept = listOf(
      mapOf("senderId" to "peer", "clientId" to "c1", "text" to "Где Проектор?", "sentAt" to "2026-11-21T06:00:00.000Z"),
      mapOf("senderId" to "peer", "clientId" to "c2", "text" to "проектор спрятан", "sentAt" to "2026-11-21T06:01:00.000Z"),
      mapOf("senderId" to me, "clientId" to "c3", "text" to "✏️ проектор", "meta" to mapOf("action" to mapOf("type" to "edit", "target" to "c1", "text" to "проектор"))),
      mapOf("senderId" to me, "clientId" to "c4", "text" to "Другое"),
    )
    val found = ChatListActions.found("chat", kept, "проектор", hidden = setOf("peer:c2"))
    assertEquals(listOf("c1"), found.map { it.clientId })
    // Newest first, as the storage gives them: the core is given the same order by number, without the hidden.
    assertEquals(listOf(4, 2, 1), ChatListActions.numbered(kept, setOf("peer:c2")).map { it["id"] })
    assertEquals("2026-11-21T06:00:00.000Z", ChatListActions.numbered(kept, emptySet())[0]["createdAt"])
  }

  @Test fun whatALongPressOnAChatOffers() {
    assertEquals(listOf("Пометить как непрочитанное", "Закрепить", "Выключить звук", "В архив", "Выбрать", "Удалить чат"),
      ChatListActions.menuChoices(unread = false, pinned = false, muted = false, archived = false).map { it.third })
    assertEquals(listOf("Пометить как прочитанное", "Открепить", "Включить звук", "Вернуть из архива", "Выбрать", "Удалить чат"),
      ChatListActions.menuChoices(unread = true, pinned = true, muted = true, archived = true).map { it.third })
  }

  @Test fun theRowsOfTheList() {
    val chats = listOf(
      chat("1", "Алиса", mapOf("pinnedAt" to "2026-11-20T09:00:00.000Z"), unread = 2, username = "alisa_v"),
      chat("2", "Мама", mapOf("muted" to true)),
      chat("3", "Лев", last = message(9, "peer-3", "старое", at = "2026-11-19T06:00:00.000Z")),
      chat("4", "Саша", mapOf("archived" to true)),
    )
    val made = ChatListActions.rows(state(chats, marked = setOf("3"), drafts = mapOf("2" to "Не забыть"), typing = setOf("1")))
    assertEquals("Чаты", made.heading)
    assertEquals("Пока нет чатов", made.emptyWords)
    val rows = ChatRow.parse(made.rows)
    assertEquals(listOf("__archive", "1", "2", "3"), rows.map { it.id })
    assertEquals(listOf("Архив", "1 чат"), listOf(rows[0].title, rows[0].preview))
    // Pinned and typing: the buttons say «Прочитано» and «Открепить».
    assertEquals(listOf("Закреплённые", "Печатает…", true, 2), listOf(rows[1].section, rows[1].preview, rows[1].accentPreview, rows[1].unread))
    assertEquals(listOf("read:Прочитано", "unpin:Открепить"), rows[1].lead)
    assertEquals(listOf("archive:В архив", "delete:Удалить", "mute:Без звука"), rows[1].trail)
    // Without sound, with a draft: «Черновик:» is the red part.
    assertEquals(listOf("Мама", "Черновик: Не забыть", 9, "Сегодня"), listOf(rows[2].title, rows[2].preview, rows[2].previewRed, rows[2].section))
    assertEquals(listOf("archive:В архив", "delete:Удалить", "unmute:Со звуком"), rows[2].trail)
    // Marked as unread by hand: one, and the button reads it back.
    assertEquals(listOf(1, "Раньше", "read:Прочитано"), listOf(rows[3].unread, rows[3].section, rows[3].lead[0]))

    val archive = ChatListActions.rows(state(chats, archiveOpen = true))
    assertEquals("Архив", archive.heading)
    assertEquals(listOf("__back", "4"), archive.rows.map { it["id"] })
    assertEquals(listOf("unarchive:Вернуть", "delete:Удалить", "mute:Без звука"), archive.rows[1]["trail"])
    // Nothing is in the archive any more: the list of chats is shown again.
    assertFalse(ChatListActions.rows(state(chats.take(3), archiveOpen = true)).archiveOpen)
  }

  @Test fun theLineOfAChatWhoseLastMessageIsNotOneToShow() {
    val reaction = message(9, "peer-1", "❤️ Реакция на сообщение", meta = mapOf("action" to mapOf("type" to "react", "target" to "c1", "emoji" to "❤️")))
    val pin = message(9, me, "📌 Закреплено: «План»", meta = mapOf("action" to mapOf("type" to "pin", "target" to "c1")))
    val chats = listOf(chat("1", "Алиса", last = reaction), chat("2", "Лев", last = pin), chat("3", "Мама", last = message(9, "peer-3", "Скрытое")))
    val before = ChatListActions.rows(state(chats, hidden = setOf("peer-3:c9"))).rows
    // Until the line to show is found: nothing, never the hidden text.
    assertEquals(listOf("", "Вы закрепили «План»", ""), before.map { it["preview"] })
    val after = ChatListActions.rows(state(chats, fills = mapOf("1" to ChatListActions.Fill(9, "Привет"), "3" to ChatListActions.Fill(8, "устарело")), hidden = setOf("peer-3:c9"))).rows
    assertEquals(listOf("Привет", "Вы закрепили «План»", ""), after.map { it["preview"] })
  }

  @Test fun theSearchOfTheList() {
    val chats = listOf(chat("1", "Алиса", username = "alisa_v"), chat("2", "Лев"), chat("3", "Саша", mapOf("archived" to true)))
    val byName = ChatListActions.rows(state(chats, query = " ALISA_ "))
    assertEquals(listOf("1"), byName.rows.map { it["id"] })
    assertEquals("", byName.rows[0]["section"])
    assertEquals("Поиск…", ChatListActions.rows(state(chats, query = "нет", searching = true)).emptyWords)
    assertEquals("Ничего не нашли.", ChatListActions.rows(state(chats, query = "нет")).emptyWords)
    val hits = listOf(ChatListActions.Hit("2", "c7", "Где проектор?", "2026-11-21T06:05:00.000Z"), ChatListActions.Hit("gone", "c1", "проектор", ""))
    val found = ChatRow.parse(ChatListActions.rows(state(chats, query = "проектор", hits = hits)).rows)
    assertEquals(listOf("msg|2|c7"), found.map { it.id })
    assertEquals(listOf("Сообщения", "Где проектор?", "09:05", "Лев"), listOf(found[0].section, found[0].preview, found[0].time, found[0].title))
  }

  @Test fun aChatDeletedHereStaysOutOfTheList() {
    val chats = listOf(chat("1", "Алиса"), chat("2", "Лев"))
    val made = ChatListActions.rows(ChatListActions.State(chats, me, removed = { it.id == "1" }, now = now, zone = moscow))
    assertEquals(listOf("2"), made.rows.map { it["id"] })
  }

  // The rows of a chat

  private fun build(raw: List<Map<String, Any?>>, pending: List<ChatHistory.Pending> = emptyList(), hidden: List<String> = emptyList(), selection: Set<String>? = null, read: Long = 0, unreadAfter: Long? = null) =
    ChatHistory.build(ChatHistory.Snapshot(raw, pending, hidden, selection, read, unreadAfter, me, "Алиса", now, moscow))

  @Test fun theRowsOfAChatWithoutTheCoreLeaveTheActionsOut() {
    assumeTrue(!Core.loaded)
    val shown = build(listOf(message(1, "peer", "Привет"), message(2, me, "❤️", meta = mapOf("action" to mapOf("type" to "react", "target" to "c1", "emoji" to "❤️")))))
    assertEquals(listOf("peer:c1"), shown.order)
  }

  @Test fun daysOfMessagesWithoutAKeyAreOneNoticeWithoutDayLines() {
    val raw = listOf(
      message(1, "peer", "", at = "2026-11-17T06:00:00.000Z", state = "no-key"),
      message(2, "peer", "", at = "2026-11-18T06:00:00.000Z", state = "no-key"),
      message(3, "peer", "", at = "2026-11-19T06:00:00.000Z", state = "no-key"),
      message(4, "peer", "", at = "2026-11-20T06:00:00.000Z", state = "no-key"),
      message(5, "peer", "", at = "2026-11-20T07:00:00.000Z", state = "no-key"),
      message(6, me, "Теперь видно", at = "2026-11-20T08:00:00.000Z"),
      message(7, "peer", "", at = "2026-11-21T06:00:00.000Z", state = "no-key"),
      message(8, "peer", "Привет", at = "2026-11-21T06:05:00.000Z"),
    )
    val rows = MsgRow.parse(build(raw).rows)
    assertEquals(listOf("17 ноября", "5 сообщений до входа на этом устройстве. Они зашифрованы для других твоих устройств и здесь не открываются.",
      "Вчера", "Теперь видно", "Сегодня", "1 сообщение до входа на этом устройстве. Они зашифрованы для других твоих устройств и здесь не открываются.", "Привет"), rows.map { it.text })
    assertEquals(listOf(1, 2, 1, 0, 1, 2, 0), rows.map { it.kind })
  }

  @Test fun unreadLineRunsOfMessagesWithoutAKeyAndTheSelection() {
    val raw = listOf(
      message(1, "peer", "", at = "2026-11-20T06:00:00.000Z", state = "no-key"),
      message(2, "peer", "", at = "2026-11-20T06:01:00.000Z", state = "no-key"),
      message(3, me, "Привет", at = "2026-11-21T06:00:00.000Z"),
      message(4, me, "Ты тут?", at = "2026-11-21T06:02:00.000Z"),
      message(5, me, "Ау", at = "2026-11-21T06:10:00.000Z"),
      message(6, "peer", "Тут", at = "2026-11-21T06:11:00.000Z", meta = mapOf("forward" to mapOf("from" to "Лев"))),
      message(7, "peer", "Отвечаю", at = "2026-11-21T06:12:00.000Z", meta = mapOf("reply" to mapOf("clientId" to "gone", "senderId" to me, "preview" to "Старое  сообщение"))),
    )
    val pending = listOf(ChatHistory.Pending("p1", "Иду", null, null, "2026-11-21T08:59:00.000Z"), ChatHistory.Pending("p2", "Не ушло", null, null, "2026-11-21T08:59:30.000Z", failed = true),
      ChatHistory.Pending("p3", "❤️", mapOf("action" to mapOf("type" to "react", "target" to "c6", "emoji" to "❤️")), null, "2026-11-21T08:59:40.000Z", failed = true))
    val shown = build(raw, pending, selection = setOf("$me:c4"), read = 4, unreadAfter = 5)
    val rows = MsgRow.parse(shown.rows)
    assertEquals(listOf("Вчера", "2 сообщения до входа на этом устройстве. Они зашифрованы для других твоих устройств и здесь не открываются.", "Сегодня", "Привет", "Ты тут?", "Ау", "Тут", "Отвечаю", "Иду", "Не ушло"), rows.map { it.text }) // no «Непрочитанные сообщения» line, as the reference
    // Offline: the notice of messages from before this device has its own look (the lock), kind 2.
    assertEquals(2, rows[1].kind)
    assertEquals(setOf("c1", "c2"), shown.noKey)
    assertEquals(7L, shown.newestTheirs)
    assertEquals(1, shown.failedActions)
    val byText = rows.associateBy { it.text }
    // Read up to 4: two ticks; 5 has one; what is on its way out has the clock, what was refused the mark.
    assertEquals(listOf(2, 2, 1, 3, 4), listOf("Привет", "Ты тут?", "Ау", "Иду", "Не ушло").map { byText.getValue(it).ticks })
    // The same sender within five minutes: no tail on the first of the two.
    assertEquals(listOf(false, true, true), listOf("Привет", "Ты тут?", "Ау").map { byText.getValue(it).tail })
    assertEquals(listOf(0, 1, 0), listOf("Привет", "Ты тут?", "Ау").map { byText.getValue(it).checked })
    assertEquals("Переслано от Лев", byText.getValue("Тут").forward)
    assertEquals(listOf("Ты", "Старое сообщение"), listOf(byText.getValue("Отвечаю").quoteAuthor, byText.getValue("Отвечаю").quoteText))
    assertEquals("$me:c4", shown.keyOfClient["c4"])
  }

  @Test fun theCoreFoldsTheActionsIntoTheirMessages() {
    assumeTrue(Core.loaded)
    val raw = ChatActionsDemo.seed("chat", me, "pinned", moscow, LocalDate.of(2026, 11, 21))
    val shown = build(raw, read = ChatActionsDemo.read)
    val rows = MsgRow.parse(shown.rows).filter { it.kind == 0 }
    assertEquals(9, rows.size)
    assertEquals(ChatActionsDemo.client(3), shown.pinned?.get("clientId"))
    val seventh = rows.first { it.text == "Тогда до завтра, я принесу распечатки" }
    assertEquals(listOf("❤️", "2", "1"), seventh.chips)
    val answer = rows.first { it.text == "Принесу свои тоже, на всякий случай" }
    assertEquals(listOf("Алиса", "Лучше распечатки, там таблица"), listOf(answer.quoteAuthor, answer.quoteText))
    assertEquals("Переслано от Дмитрий Орлов", rows.first { it.text.startsWith("Встреча") }.forward)
    // «Удалить у меня» hides a message on this device; a deletion for both is folded by the core.
    assertEquals(8, build(raw, hidden = listOf("${ChatActionsDemo.peer}:${ChatActionsDemo.client(1)}")).order.size)
    val deleted = build(raw, pending = listOf(ChatHistory.Pending("p", "x", mapOf("action" to mapOf("type" to "delete", "target" to ChatActionsDemo.client(2))), null, "2026-11-21T08:00:00.000Z")))
    assertNull(deleted.keyOfClient[ChatActionsDemo.client(2)])
    // An edit shown at once, as already applied.
    val edited = build(raw, pending = listOf(ChatHistory.Pending("p", "x", mapOf("action" to mapOf("type" to "edit", "target" to ChatActionsDemo.client(4), "text" to "Хорошо, буду")), null, "2026-11-21T06:20:00.000Z")))
    val row = MsgRow.parse(edited.rows).first { it.key == "$me:${ChatActionsDemo.client(4)}" }
    assertEquals("Хорошо, буду", row.text)
    assertTrue(row.time.startsWith("изм. "))
  }

  @Test fun theCoreWordsTheActionsAndKeepsTheEditWindow() {
    assumeTrue(Core.loaded)
    assertEquals(true, Core.view("editWindowOpen", listOf("2026-11-20T09:00:00.000Z", now.toEpochMilli())))
    assertEquals(false, Core.view("editWindowOpen", listOf("2026-11-19T08:59:00.000Z", now.toEpochMilli())))
    assertTrue((Core.view("actionFallback", listOf(mapOf("type" to "react", "target" to "c1", "emoji" to "❤️"), "Привет")) as String).isNotEmpty())
    val meta = ChatScreenActions.replyMeta(message(1, "peer", "Привет"))
    assertEquals(mapOf("clientId" to "c1", "senderId" to "peer", "preview" to "Привет"), meta?.get("reply"))
    // The list shows the newest message that is one to show, not the reaction after it.
    val kept = listOf(
      mapOf("senderId" to me, "clientId" to "c2", "text" to "❤️", "cryptoState" to "decrypted", "sentAt" to "2026-11-21T06:01:00.000Z", "meta" to mapOf("action" to mapOf("type" to "react", "target" to "c1", "emoji" to "❤️"))),
      mapOf("senderId" to "peer", "clientId" to "c1", "text" to "Привет", "cryptoState" to "decrypted", "sentAt" to "2026-11-21T06:00:00.000Z"),
    )
    assertEquals("Привет", Core.map(Core.view("listPreviewMessage", listOf(ChatListActions.numbered(kept, emptySet()))))?.get("text"))
  }
}
