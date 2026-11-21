package com.linea.messenger.chatsplus

import android.content.Intent
import com.linea.messenger.Demo
import com.linea.messenger.app.Messenger
import com.linea.messenger.people.Person
import java.time.Instant
import java.time.temporal.ChronoUnit

/** The chat list's extras for the emulator check (native/ios/Sources/ChatsPlus — the simulator parts), read from the
 *  launch arguments by `Demo.start`:
 *    --es chatsdemo waiting|connecting|updating|skeleton|empty|folders|folder|foldereditor|foldersettings|
 *                   savedmenu|saved|savedsearch|calls|hint|select|mutecustom|archivepull
 *  This file is in the debug source set: a release build is compiled with the empty `ChatsPlusDemo` of src/release
 *  instead and contains none of this. */
object ChatsPlusDemo {
  const val present = true

  var chatsdemo: String? = null
    private set
  /** The words about the hold above the bar: null on an ordinary start (the app's own rule), else whether the check
   *  asked for them (the other checks' shots stay as they were). */
  var hint: Boolean? = null
    private set
  val calls: Boolean get() = chatsdemo == "calls"
  val savedSearch: Boolean get() = chatsdemo == "savedsearch"

  fun read(intent: Intent) {
    chatsdemo = intent.getStringExtra("chatsdemo")
    hint = if (intent.extras?.isEmpty == false) chatsdemo == "hint" else null
  }

  /** The sample chats as the folder editor lists them. */
  fun sampleFolderChats(): List<FolderChat> = Demo.chats().map { FolderChat(it.id, it.title, it.avatarColor, it.initials, "", "") }

  /** People the search by @name finds without an account. */
  fun people(): List<Person> = listOf(
    Person("sample-p1", "mira_k", "Мира Ковалёва", "", "", 0x5B8DEF, ""),
    Person("sample-p2", "mark.s", "Марк Соловьёв", "", "", 0x3FAE8C, ""),
    Person("sample-p3", "marina", "Марина Летова", "", "", 0xD08A3E, ""),
  )

  /** «Избранное» without an account. */
  fun savedItems(): List<Map<String, Any?>> {
    val now = Instant.now()
    fun at(minutesAgo: Long) = SavedMessages.stamp(now.minus(minutesAgo, ChronoUnit.MINUTES))
    return listOf(
      mapOf("id" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b01", "savedAt" to at(60 * 26), "text" to "Список к поездке: зарядка, документы, плед", "attachment" to null),
      mapOf("id" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b02", "savedAt" to at(60 * 25), "text" to "Адрес: Садовая, 14, третий подъезд, код 27", "attachment" to null,
        "origin" to mapOf("chatId" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7c01", "clientId" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7c02", "author" to "Алиса Воронцова", "sentAt" to at(60 * 27))),
      mapOf("id" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b03", "savedAt" to at(42), "text" to "",
        "attachment" to mapOf("id" to "demo-file", "name" to "план-встречи.pdf", "mimeType" to "application/pdf", "size" to 182000)),
      mapOf("id" to "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b04", "savedAt" to at(7), "text" to "Позвонить в сервис до пятницы", "attachment" to null),
    )
  }

  /** «Звонки» without an account. */
  fun callRecords(): List<CallRecord> {
    val rows = Demo.chats()
    if (rows.isEmpty()) return emptyList()
    fun chat(index: Int): Messenger.ChatSummary {
      val row = rows[minOf(index, rows.size - 1)]
      return Messenger.ChatSummary(row.id, "demo-person-$index", row.title, 0, mapOf("avatarColor" to row.avatarColor, "initials" to row.initials), emptyMap(), emptyMap())
    }
    val now = Instant.now()
    fun ago(minutes: Long) = now.minus(minutes, ChronoUnit.MINUTES)
    return listOf(
      CallRecord("a", chat(2), ago(12), "missed", false, "Пропущенный звонок", true),
      CallRecord("b", chat(0), ago(95), "outgoing", true, "Исходящий видеозвонок · 14:05", false),
      CallRecord("c", chat(3), ago(60 * 26), "incoming", false, "Входящий звонок · 3:12", false),
      CallRecord("d", chat(3), ago(60 * 27), "incoming", false, "Входящий звонок · 0:48", false),
      CallRecord("e", chat(5), ago(60 * 24 * 4), "declined", false, "Отклонённый звонок", false),
    )
  }

  /** The peek card's lines without an account. */
  fun peekLines(): List<ChatPeekMenu.Line> = listOf(
    ChatPeekMenu.Line("Привет! Ты завтра свободна?", false), ChatPeekMenu.Line("Да, после обеда", true),
    ChatPeekMenu.Line("Отлично, тогда в три у входа", false), ChatPeekMenu.Line("Договорились 👍", true),
  )
}
