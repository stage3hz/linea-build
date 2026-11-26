package com.linea.messenger

import com.linea.messenger.app.Messenger
import com.linea.messenger.chatactions.ChatListActions
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.chatsplus.CallLog
import com.linea.messenger.chatsplus.CallRecord
import com.linea.messenger.chatsplus.ChatFolderStore
import com.linea.messenger.chatsplus.ChatListPlus
import com.linea.messenger.chatsplus.ChatListStatus
import com.linea.messenger.chatsplus.ChatPeekMenu
import com.linea.messenger.chatsplus.ChatRowLooks
import com.linea.messenger.chatsplus.ListPeopleSearch
import com.linea.messenger.chatsplus.MuteCustomSheet
import com.linea.messenger.chatsplus.SavedMessages
import com.linea.messenger.core.Core
import com.linea.messenger.people.Person
import com.linea.messenger.shell.UpdateGate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** The rules and the words of the chat list's extras (chatsplus/) and of the shell (shell/UpdateGate.kt): what needs
 *  no phone, word for word as on the iPhone (native/ios/Sources/ChatsPlus). The one that asks the core is skipped
 *  when the core for this machine has not been built (native/android/build-core-host.sh). */
class ChatsPlusRulesTest {
  private val moscow = ZoneId.of("Europe/Moscow")
  /** Saturday 21 November 2026, 12:00 in Moscow. */
  private val now = Instant.parse("2026-11-21T09:00:00Z")

  @Test fun theTitleSaysWhatTheConnectionDoes() {
    assertEquals(ChatListStatus.Title.CHATS, ChatListStatus.title("connected", true, updating = false))
    assertEquals(ChatListStatus.Title.UPDATING, ChatListStatus.title("connected", null, updating = true))
    assertEquals(ChatListStatus.Title.WAITING, ChatListStatus.title("offline", false, updating = false))
    assertEquals(ChatListStatus.Title.CONNECTING, ChatListStatus.title("offline", true, updating = false))
    assertEquals(ChatListStatus.Title.CONNECTING, ChatListStatus.title("connecting", null, updating = false))
    assertEquals(ChatListStatus.Title.WAITING, ChatListStatus.title("offline", null, updating = false))
    assertEquals(listOf("Ожидание сети…", "Соединение…", "Обновление…"), listOf(ChatListStatus.Title.WAITING.words, ChatListStatus.Title.CONNECTING.words, ChatListStatus.Title.UPDATING.words))
  }

  @Test fun theLineUnderTheTitleAndTheBadges() {
    assertEquals("всё прочитано", ChatListStatus.unreadLine(0))
    assertEquals("1 чат ждёт ответа", ChatListStatus.unreadLine(1))
    assertEquals("3 чата ждут ответа", ChatListStatus.unreadLine(3))
    assertEquals("5 чатов ждут ответа", ChatListStatus.unreadLine(5))
    assertEquals("11 чатов ждут ответа", ChatListStatus.unreadLine(11))
    assertEquals("22 чата ждут ответа", ChatListStatus.unreadLine(22))
    assertEquals(listOf("", "7", "999", "1K", "4,3K", "12K", "1,2M"), listOf(0, 7, 999, 1000, 4350, 12999, 1_250_000).map { ChatListStatus.badgeText(it) })
    // Muted and archived chats do not count; a chat marked by hand adds one.
    val total = ChatListStatus.total(listOf(
      ChatListStatus.Counted("1", 3, marked = false, muted = false, archived = false), ChatListStatus.Counted("2", 0, marked = true, muted = false, archived = false),
      ChatListStatus.Counted("3", 9, marked = false, muted = true, archived = false), ChatListStatus.Counted("4", 5, marked = false, muted = false, archived = true),
    ))
    assertEquals(4, total)
  }

  @Test fun theFoldersAndTheSwipeBetweenThem() {
    val parsed = ChatFolderStore.parse("""[{"id":"f1","name":"Работа","chatIds":["a","b"]},{"id":2,"name":"x","chatIds":[]},{"id":"f2","name":"Семья","chatIds":["c",5]}]""")
    assertEquals(listOf("f1", "f2"), parsed.map { it.id })
    assertEquals(listOf("c"), parsed[1].chatIds)
    assertEquals(emptyList<Any>(), ChatFolderStore.parse("не json"))
    assertTrue(ChatFolderStore.newId(1_700_000_000_000).startsWith("f"))
    assertEquals("f" + java.lang.Long.toString(1_700_000_000_000, 36), ChatFolderStore.newId(1_700_000_000_000))
    // listSwipes.ts: a quarter of the width or a flick turns one page, never past the ends; a flick back keeps it.
    assertEquals(1, ChatListPlus.pageRelease(0, 3, -120f, 0f, 400f))
    assertEquals(0, ChatListPlus.pageRelease(0, 3, -80f, 0f, 400f))
    assertEquals(1, ChatListPlus.pageRelease(0, 3, -20f, -700f, 400f))
    assertEquals(0, ChatListPlus.pageRelease(0, 3, -120f, 400f, 400f))
    assertEquals(2, ChatListPlus.pageRelease(2, 3, -200f, 0f, 400f))
    assertEquals(0.5f, ChatListPlus.pagePosition(0, 3, -200f, 400f), 0.001f)
    // Past the ends the page is held back to a fifth.
    assertEquals(-0.1f, ChatListPlus.pagePosition(0, 3, 200f, 400f), 0.001f)
  }

  @Test fun theSavedRowAndTheNotes() {
    val note = mapOf<String, Any?>("id" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b01", "savedAt" to "2026-11-21T08:00:00.000Z", "text" to "Список\nк поездке", "attachment" to null)
    val file = mapOf<String, Any?>("id" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b02", "savedAt" to "2026-11-20T08:00:00.000Z", "text" to "",
      "attachment" to mapOf("id" to "f", "name" to "voice-1700000000000.m4a", "mimeType" to "audio/mp4"))
    assertTrue(SavedMessages.valid(note))
    assertTrue(SavedMessages.valid(file))
    assertFalse(SavedMessages.valid(note + ("id" to "1")))
    assertFalse(SavedMessages.valid(note + ("text" to " ")))
    assertFalse(SavedMessages.valid(note + ("origin" to mapOf("chatId" to "x"))))
    assertFalse(SavedMessages.valid(note + ("editedAt" to "вчера")))
    assertTrue(SavedMessages.valid(note + ("origin" to mapOf("chatId" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7c01", "clientId" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7c02", "author" to "Алиса", "sentAt" to "2026-11-19T08:00:00.000Z"))))
    assertEquals(listOf("6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b01"), SavedMessages.parse(Core.text(listOf(note, mapOf("id" to "плохая")))).map { it["id"] })
    assertEquals("Список к поездке" to "", SavedMessages.line(note))
    assertEquals("Голосовое сообщение" to "mic", SavedMessages.line(file))
    assertEquals(listOf(note), SavedMessages.search(listOf(note, file), "ПОЕЗД"))
    assertEquals(listOf(file), SavedMessages.search(listOf(note, file), "voice"))
    assertEquals("2026-11-21T09:00:00.000Z", SavedMessages.stamp(now))
    val row = ChatListPlus.savedRowFor(note, 0xFFE5E5E6.toInt(), now, moscow)
    assertEquals(listOf("__saved", "Избранное", "Список к поездке", "11:00", "★"), listOf(row["id"], row["title"], row["preview"], row["time"], row["initials"]))
    assertEquals("Заметки, файлы и сохранённые сообщения", ChatListPlus.savedRowFor(null, 0, now, moscow)["preview"])
  }

  @Test fun aCallInTheListIsADrawnPhoneOrCameraNotAnEmoji() {
    // The owner's choice over messageMeta.ts: the emoji of the core's words becomes the icon before them.
    assertEquals("Звонок · 0:04" to "phone", ChatRowLooks.callLine("📞 Звонок · 0:04"))
    assertEquals("Пропущенный видеозвонок" to "video", ChatRowLooks.callLine("📹 Пропущенный видеозвонок"))
    assertEquals("Видеозвонок" to "video", ChatRowLooks.callLine("📹 Видеозвонок"))
    assertNull(ChatRowLooks.callLine("📞 позвони мне"))
    assertNull(ChatRowLooks.callLine("Вы закрепили «📞 Звонок»"))
    assertEquals("Вы закрепили «Звонок»", ChatRowLooks.withoutCallMark("Вы закрепили «📞 Звонок»"))
    assertEquals("Входящий звонок", ChatRowLooks.withoutCallMark("📞 Входящий звонок"))
    assertEquals("📞 позвони мне", ChatRowLooks.withoutCallMark("📞 позвони мне"))
    val rows = ChatRow.parse(listOf(
      mapOf("id" to "a", "preview" to "📞 Звонок · 0:04"),
      mapOf("id" to "b", "preview" to "📹 Отклонённый видеозвонок"),
      mapOf("id" to "c", "preview" to "Голосовое сообщение", "previewIcon" to "mic"),
      mapOf("id" to "d", "preview" to "Привет 📞"),
    ))
    assertEquals(listOf("Звонок · 0:04" to "phone", "Отклонённый видеозвонок" to "video", "Голосовое сообщение" to "mic", "Привет 📞" to ""),
      rows.map { it.preview to it.previewIcon })
  }

  @Test fun thePictureAndTheMicrophoneOfARow() {
    assertTrue(ChatRowLooks.isVoice(mapOf("mimeType" to "audio/mp4", "name" to "voice-12.m4a")))
    assertFalse(ChatRowLooks.isVoice(mapOf("mimeType" to "audio/mp4", "name" to "song.m4a")))
    assertTrue(ChatRowLooks.isVideoNote(mapOf("mimeType" to "video/mp4", "name" to "circle-5.mp4")))
    assertEquals("Фотография" to "", ChatRowLooks.attachmentLine(mapOf("mimeType" to "image/jpeg", "name" to "x.jpg")))
    assertEquals("📎 план.pdf" to "", ChatRowLooks.attachmentLine(mapOf("mimeType" to "application/pdf", "name" to "план.pdf")))
    val row = HashMap<String, Any?>()
    ChatRowLooks.applyMedia(row, mapOf("attachment" to mapOf("mimeType" to "video/mp4", "name" to "circle-5.mp4", "preview" to mapOf("base64" to "AAAA"))), words = "")
    assertEquals(listOf("Видеосообщение", "", "AAAA", true), listOf(row["preview"], row["previewIcon"], row["thumb"], row["thumbRound"]))
    // A message with words keeps its own line.
    val worded = HashMap<String, Any?>()
    ChatRowLooks.applyMedia(worded, mapOf("attachment" to mapOf("mimeType" to "image/jpeg")), words = "Смотри")
    assertTrue(worded.isEmpty())
  }

  private fun chat(id: String, title: String, settings: Map<String, Any?> = emptyMap(), unread: Int = 0) =
    ChatListActions.Chat(id, "peer-$id", title, 0, mapOf("id" to id, "title" to title, "preview" to "Последнее", "time" to "09:00"),
      mapOf("id" to id, "peer" to mapOf("id" to "peer-$id"), "settings" to settings, "unreadCount" to unread,
        "lastMessage" to mapOf("id" to 9, "createdAt" to "2026-11-21T06:00:00.000Z")), mapOf("id" to 9, "senderId" to "peer-$id", "clientId" to "c9", "text" to "Последнее"))

  @Test fun theListWithFoldersSavedChoosingAndPeople() {
    val chats = listOf(chat("1", "Алиса", unread = 2), chat("2", "Лев"), chat("3", "Саша", mapOf("archived" to true)))
    val saved = ChatListPlus.savedRowFor(null, 0, now, moscow)
    val people = ListPeopleSearch.rowsFor(listOf(Person("p1", "mira", "Мира Ковалёва", "", "", 0x5B8DEF, ""), Person("peer-2", "lev", "Лев", "", "", 0, ""), Person("me", "me", "Я", "", "", 0, "")), setOf("peer-2"), "me")
    assertEquals(listOf("user|p1"), people.map { it["id"] })
    assertEquals(listOf("Люди", "@mira", "МК"), listOf(people[0]["section"], people[0]["preview"], people[0]["initials"]))
    val made = ChatListActions.rows(ChatListActions.State(chats, "me", now = now, zone = moscow, savedRow = saved, archivePulled = true,
      keeps = { id, _ -> id != "2" }, selecting = true, chosen = { it == "1" }, sections = false))
    val rows = ChatRow.parse(made.rows)
    // «Избранное» first, «Архив» behind the pull (no row), the folder keeps «Алиса» only, a round mark and no buttons.
    assertEquals(listOf("__saved", "1"), rows.map { it.id })
    assertEquals(listOf(1, emptyList<String>(), ""), listOf(rows[1].checked, rows[1].lead, rows[1].section))
    assertEquals(listOf("1") to 1, made.shownIds to made.unreadShown)
    val searched = ChatListActions.rows(ChatListActions.State(chats, "me", query = "мир", now = now, zone = moscow, people = people))
    assertEquals(listOf("user|p1"), searched.rows.map { it["id"] })
  }

  @Test fun theCardOfAHeldChat() {
    val kept = listOf(
      mapOf("senderId" to "me", "clientId" to "c3", "text" to "Договорились"),
      mapOf("senderId" to "p", "clientId" to "c2", "text" to "", "attachment" to mapOf("mimeType" to "image/png")),
      mapOf("senderId" to "p", "clientId" to "c1", "text" to "реакция", "meta" to mapOf("action" to mapOf("type" to "react"))),
      mapOf("senderId" to "p", "clientId" to "c0", "text" to "Привет"),
    )
    val lines = ChatPeekMenu.lines(kept, "me", setOf("p:c0"))
    assertEquals(listOf("Фотография" to false, "Договорились" to true), lines.map { it.text to it.mine })
  }

  @Test fun theHistoryOfCalls() {
    val summary = Messenger.ChatSummary("chat", "p", "Алиса", 0, emptyMap(), emptyMap(), emptyMap())
    fun record(minutesAgo: Long, kind: String, unseen: Boolean = false) = CallRecord("k$minutesAgo", summary, now.minusSeconds(minutesAgo * 60), kind, false, "x", unseen)
    assertEquals("Сегодня", CallLog.dayLabel(now, now, moscow))
    assertEquals("Вчера", CallLog.dayLabel(now.minusSeconds(86_400), now, moscow))
    assertEquals("3 ноября", CallLog.dayLabel(Instant.parse("2026-11-03T09:00:00Z"), now, moscow))
    assertEquals("3 ноября 2025 г.", CallLog.dayLabel(Instant.parse("2025-11-03T09:00:00Z"), now, moscow))
    val groups = CallLog.group(listOf(record(10, "missed", unseen = true), record(20, "missed"), record(30, "outgoing"), record(60 * 30, "incoming")), now, moscow)
    assertEquals(listOf("Сегодня", "Вчера"), groups.map { it.first })
    assertEquals(listOf(2 to true, 1 to false), groups[0].second.map { it.count to it.unseen })
    assertEquals(1, CallLog.unseenCount(listOf(record(10, "missed", unseen = true), record(20, "missed"))))
  }

  @Test fun theUpdateRules() {
    assertEquals(listOf(1, 2, 3), UpdateGate.parse(" 1.2.3 "))
    assertNull(UpdateGate.parse("1.2"))
    assertNull(UpdateGate.parse("1.2.3.4"))
    assertNull(UpdateGate.parse("12345.0.0"))
    assertTrue(UpdateGate.less("0.17.0", "0.18.0"))
    assertFalse(UpdateGate.less("0.18.0", "0.17.9"))
    assertFalse(UpdateGate.less("x", "0.18.0"))
    val base = UpdateGate.Info("0.18.0", null, null, null, null, 1_000L, 0)
    assertEquals(false to true, UpdateGate.decide(base, "0.17.0", 500L))
    assertEquals(true to true, UpdateGate.decide(base, "0.17.0", 1_000L))
    assertEquals(true to true, UpdateGate.decide(UpdateGate.Info("0.18.0", "0.18.0", null, null, null, null, 0), "0.17.0", 0L))
    assertEquals(false to false, UpdateGate.decide(base, "0.18.0", 5_000L))
    // The server's clock decides, not the phone's.
    assertEquals(true to true, UpdateGate.decide(UpdateGate.Info("0.18.0", null, null, null, null, 1_000L, 600), "0.17.0", 500L))
    assertEquals(listOf("2 д 14 ч 05 мин", "14 ч 05 мин", "5 мин", "1 мин"), listOf(223_500_000L, 50_700_000L, 300_000L, 10_000L).map { UpdateGate.span(it) })
    val url = "https://github.com/stage3hz/linea-build/releases/download/v0.18.0/INVIZENT-0.18.0.apk"
    assertTrue(UpdateGate.releaseAssetUrl(url))
    assertFalse(UpdateGate.releaseAssetUrl("https://github.com/stage3hz/linea-build/releases/download/../../../other/repo/x.apk"))
    assertFalse(UpdateGate.releaseAssetUrl("http://github.com/stage3hz/linea-build/releases/download/v1/x.apk"))
    assertFalse(UpdateGate.releaseAssetUrl("https://evil.example/stage3hz/linea-build/releases/download/v1/x.apk"))
    assertFalse(UpdateGate.releaseAssetUrl("$url?x=1"))
    val sha = "a".repeat(64)
    assertEquals(58_000_000L, UpdateGate.asset(mapOf("url" to url, "sha256" to sha, "size" to 58_000_000))?.size)
    assertNull(UpdateGate.asset(mapOf("url" to url, "sha256" to "A".repeat(64), "size" to 1)))
    assertNull(UpdateGate.asset(mapOf("url" to url, "sha256" to sha, "size" to 0)))
  }

  @Test fun theOwnTimeWithoutSound() {
    assumeTrue(Core.loaded)
    val (until, label) = MuteCustomSheet.answer(0, 1, 30, now.toEpochMilli())
    assertTrue(until?.startsWith("2026-11-21T10:30:00") == true)
    assertTrue(label.isNotEmpty())
    assertNull(MuteCustomSheet.answer(0, 0, 0, now.toEpochMilli()).first)
  }
}
