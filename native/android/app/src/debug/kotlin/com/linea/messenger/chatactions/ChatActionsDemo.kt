package com.linea.messenger.chatactions

import android.content.Intent
import com.linea.messenger.people.PeopleDemo
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

/** The sample chat as messages the core can fold, and the launch arguments that ask something of the actions on
 *  messages and chats (see `Demo.start`), as the iOS simulator check does:
 *    --es chatdemo menu|delete|reply|edit|pinned|select|forward|quotes|typing|draft   the sample chat (with --ez demo true --ez chat true)
 *    --es chataction menu|delete|reply|edit|pin|select|forward|react                  the first chat of an account (with --ez openchat true)
 *    --es chatlist menu|mute|delete|archive|archived|draft|unread                     the list of chats: on the first chat (archive: on the last one)
 *    --es chatsearch <query>                                                          the list's search field with these words
 *  This file is in the debug source set: a release build is compiled with the empty `ChatActionsDemo` of
 *  src/release instead and contains none of this. */
object ChatActionsDemo {
  const val present = true
  const val peer = "demo-peer"
  const val draft = "Не забыть спросить про проектор"

  var chatdemo: String? = null
    private set
  var chataction: String? = null
    private set
  var chatlist: String? = null
    private set
  var chatsearch: String? = null
    private set

  fun read(intent: Intent) {
    chatdemo = intent.getStringExtra("chatdemo")
    chataction = intent.getStringExtra("chataction")
    chatlist = intent.getStringExtra("chatlist")
    chatsearch = intent.getStringExtra("chatsearch")
  }

  /** The clientId of the sample chat's Nth message (1 is the first). */
  fun client(index: Int): String = String.format(Locale.ROOT, "d0000000-0000-4000-8000-%012d", index)

  /** How many of the sample chat's messages the other side has read. */
  const val read = 7L

  /** A made-up conversation (no account, no server): the same words as the sample chat had before, as messages
   *  the core can fold — so every action can be tried on them. With `extra`, also what the actions leave behind:
   *  an answer with its quote, a forwarded message, reactions from both sides. */
  fun seed(chatId: String, userId: String, extra: String, zone: ZoneId = ZoneId.systemDefault(), today: LocalDate = LocalDate.now(zone)): List<Map<String, Any?>> {
    val said = listOf(
      Triple(false, "Привет! Ты завтра будешь на встрече?", "09:12"),
      Triple(true, "Привет. Да, к десяти подойду", "09:14"),
      Triple(false, "Отлично. Я подготовила короткий план — три пункта, должно уложиться в полчаса, если никто не уйдёт в детали", "09:15"),
      Triple(true, "Хорошо", "09:15"),
      Triple(true, "Распечатки нужны или хватит экрана?", "09:16"),
      Triple(false, "Лучше распечатки, там таблица", "09:30"),
      Triple(false, "Тогда до завтра, я принесу распечатки", "09:38"),
    )
    val start: Instant = today.atStartOfDay(zone).toInstant()
    fun at(clock: String, extraSeconds: Int = 0): String {
      val parts = clock.split(":").mapNotNull { it.toIntOrNull() }
      return start.plusSeconds((parts.getOrElse(0) { 0 } * 3600 + parts.getOrElse(1) { 0 } * 60 + extraSeconds).toLong()).toString()
    }
    val list = ArrayList<Map<String, Any?>>()
    said.forEachIndexed { index, line ->
      list.add(mapOf("id" to index + 1, "chatId" to chatId, "senderId" to (if (line.first) userId else peer), "clientId" to client(index + 1), "text" to line.second,
        "attachment" to null, "createdAt" to at(line.third, index), "cryptoState" to "decrypted"))
    }
    fun add(mine: Boolean, text: String, clock: String, meta: Map<String, Any?>) {
      val id = list.size + 1
      list.add(mapOf("id" to id, "chatId" to chatId, "senderId" to (if (mine) userId else peer), "clientId" to client(id), "text" to text,
        "attachment" to null, "createdAt" to at(clock, id), "cryptoState" to "decrypted", "meta" to meta))
    }
    if (extra.isNotEmpty()) {
      add(true, "Принесу свои тоже, на всякий случай", "09:40", mapOf("reply" to mapOf("clientId" to client(6), "senderId" to peer, "preview" to "Лучше распечатки, там таблица")))
      add(false, "Встреча в переговорной на третьем этаже", "09:41", mapOf("forward" to mapOf("from" to "Дмитрий Орлов")))
      add(false, "👍 Реакция на сообщение", "09:41", mapOf("action" to mapOf("type" to "react", "target" to client(8), "emoji" to "👍")))
      add(true, "❤️ Реакция на сообщение", "09:42", mapOf("action" to mapOf("type" to "react", "target" to client(7), "emoji" to "❤️")))
      add(false, "❤️ Реакция на сообщение", "09:42", mapOf("action" to mapOf("type" to "react", "target" to client(7), "emoji" to "❤️")))
    }
    if (extra == "pinned") add(true, "Закреплено сообщение", "09:43", mapOf("action" to mapOf("type" to "pin", "target" to client(3))))
    return list
  }

  /** The people «Переслать» offers when there is no account. */
  fun forwardTargets(): List<ForwardPicker.Target> =
    PeopleDemo.friends.map { person -> ForwardPicker.Target("demo-chat-" + person.id, person.id, person.displayName, person, null) }
}
