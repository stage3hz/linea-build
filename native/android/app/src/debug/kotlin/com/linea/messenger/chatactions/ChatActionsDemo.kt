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
 *    --es chataction forwardsend --es forwardto <name>                                 its attachments forwarded to the chat of @<name>… (live check)
 *    --es chatlist menu|mute|delete|archive|archived|draft|unread                     the list of chats: on the first chat (archive: on the last one)
 *    --es chatsearch <query>                                                          the search screen with these words
 *    --es chatsearchscope messages|people|channels                                    ChatSearch: that scope of the search screen
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
  /** `chataction forwardsend`: the start of the @name of the person whose chat gets the forwarded attachments. */
  var forwardto: String? = null
    private set
  var chatlist: String? = null
    private set
  var chatsearch: String? = null
    private set
  /** ChatSearch: the scope the search screen opens on (messages|people|channels). */
  var chatsearchscope: String? = null
    private set

  fun read(intent: Intent) {
    chatdemo = intent.getStringExtra("chatdemo")
    chataction = intent.getStringExtra("chataction")
    forwardto = intent.getStringExtra("forwardto")
    chatlist = intent.getStringExtra("chatlist")
    chatsearch = intent.getStringExtra("chatsearch")
    chatsearchscope = intent.getStringExtra("chatsearchscope") // ChatSearch
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
    // Polls, Composer: `chatdemo features` — a poll with results, a poll with several answers, big emoji and a message
    // sent «без звука» (also under search, newpoll and albummenu, as on the iPhone).
    if (extra in listOf("features", "poll", "album", "emoji", "search", "albummenu", "newpoll")) {
      val lunch = mapOf("question" to "Куда пойдём в пятницу?", "options" to listOf("Кино", "Боулинг", "Остаться дома"), "multiple" to false)
      add(false, com.linea.messenger.polls.PollText.fallback(lunch), "09:44", mapOf("poll" to lunch))
      val pollClient = client(list.size)
      add(false, "🗳 Голос в опросе", "09:45", mapOf("action" to mapOf("type" to "vote", "target" to pollClient, "options" to listOf(0))))
      add(true, "🗳 Голос в опросе", "09:45", mapOf("action" to mapOf("type" to "vote", "target" to pollClient, "options" to listOf(1))))
      val picnic = mapOf("question" to "Что взять на пикник?", "options" to listOf("Плед", "Мяч", "Термос", "Гитара"), "multiple" to true)
      add(true, com.linea.messenger.polls.PollText.fallback(picnic), "09:46", mapOf("poll" to picnic))
      for ((mine, words) in listOf(false to "🎉🔥", true to "👍")) {
        val id = list.size + 1
        list.add(mapOf("id" to id, "chatId" to chatId, "senderId" to (if (mine) userId else peer), "clientId" to client(id), "text" to words,
          "attachment" to null, "createdAt" to at("09:47", id), "cryptoState" to "decrypted"))
      }
      add(true, "Не буду звонить, напиши, как проснёшься", "09:48", mapOf("silent" to true))
      // Media: an album of three photos (attachments/AlbumGrid.kt), as the iPhone's sample chat has it.
      val albumId = "a0000000-0000-4000-8000-000000000001"
      for ((index, shape) in listOf(240 to 160, 160 to 240, 240 to 180).withIndex()) {
        val bytes = java.io.ByteArrayOutputStream().also { com.linea.messenger.attachments.AttachmentsDemo.picture(shape.first, shape.second).compress(android.graphics.Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
        val picture = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        val attachment = mapOf("id" to "f000000$index-0000-4000-8000-000000000000", "name" to "photo.jpg", "mimeType" to "image/jpeg", "size" to 120_000,
          "encryption" to mapOf("scheme" to "aes-256-gcm-siv"), "preview" to mapOf("base64" to picture, "width" to shape.first, "height" to shape.second))
        val id = list.size + 1
        list.add(mapOf("id" to id, "chatId" to chatId, "senderId" to peer, "clientId" to client(id), "text" to (if (index == 0) "Фото с прогулки" else ""),
          "attachment" to attachment, "createdAt" to at("09:50", id), "cryptoState" to "decrypted", "meta" to mapOf("album" to mapOf("id" to albumId, "index" to index, "count" to 3))))
      }
    }
    return list
  }

  /** The people «Переслать» offers when there is no account. */
  fun forwardTargets(): List<ForwardPicker.Target> =
    PeopleDemo.friends.map { person -> ForwardPicker.Target("demo-chat-" + person.id, person.id, person.displayName, person, null) }
}
