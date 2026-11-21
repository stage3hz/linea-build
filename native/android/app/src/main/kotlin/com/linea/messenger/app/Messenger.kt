package com.linea.messenger.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.linea.messenger.attachments.AttachmentRows
import com.linea.messenger.auth.Account
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoFailure
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.design.orbPair
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.storage.Vault
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.UUID

/** The signed-in account at work: its server, its private storage, its encryption — and what the screens ask of them. */
class Messenger(context: Context, token: String, val user: Map<String, Any?>) {
  /** Throws when the storage cannot be opened: the app then says so and changes nothing (a lost key never
   *  silently makes a new identity). */
  val userId: String = user["id"] as? String ?: throw Vault.Failure(Vault.Kind.CANNOT_OPEN)
  val server = Server(Account.server, token)
  private val vault = Vault(context, Account.server, userId, earlierServers = listOf("https://141-133-194-51.nip.io"))
  val crypto = CryptoService(userId, vault, server)
  val live = Live(server)

  /** What a screen hears of, on the main thread. */
  interface Watcher {
    /** Something on the server changed: `chatId` is the chat's id, or null for «anything». */
    fun changed(chatId: String?) {}
    /** The other side read up to a message. */
    fun peerRead(chatId: String, messageId: Long) {}
  }

  private val main = Handler(Looper.getMainLooper())
  private val watchers = LinkedHashSet<Watcher>()
  fun watch(watcher: Watcher) { watchers.add(watcher) }
  fun unwatch(watcher: Watcher) { watchers.remove(watcher) }
  private fun tellChanged(chatId: String?) { for (watcher in watchers.toList()) watcher.changed(chatId) }
  /** Attachments: this device itself changed a chat (a message with a file went out). Main thread only. */
  fun noteChanged(chatId: String?) = tellChanged(chatId)

  /** The app is on the screen; the keys are published. The live line is open only when both are true. */
  private var front = true
  private var ready = false
  private var closed = false

  init {
    live.onEvent = { event ->
      when (event) {
        is Live.Event.Ready -> { resendPending(); tellChanged(null) }
        is Live.Event.Chat -> tellChanged(event.id)
        is Live.Event.Read -> {
          if (event.userId != userId) for (watcher in watchers.toList()) watcher.peerRead(event.chatId, event.messageId)
          tellChanged(null)
        }
        // ChatActions: «печатает…» of the other side (chatactions/ChatLocal.kt).
        is Live.Event.Typing -> { if (event.userId != userId) com.linea.messenger.chatactions.ChatTyping.heard(event.chatId, event.on) }
      }
    }
    // Publishes this device's keys (making them on the very first start), then opens the live line.
    crypto.call("initialize") {
      ready = true
      if (front && !closed) live.start()
    }
  }

  /** The app came to the front, or left the screen: the live line follows. */
  fun wake() { front = true; if (ready && !closed) live.wake() }
  fun sleep() { front = false; live.sleep() }

  /** The account's window is gone: the line is closed, the encryption ends after the work it has, the storage closes. */
  fun close() {
    // Calls: a call that is on ends with the account (the other side is told while the session still lives).
    com.linea.messenger.calls.Calls.left(this)
    closed = true
    watchers.clear()
    live.sleep()
    crypto.close()
  }

  /** Tells the server the chat was read up to a message. */
  fun markRead(chatId: String, messageId: Long) {
    if (messageId <= 0) return
    server.op("read", listOf(chatId, messageId)) { }
  }

  // The list of chats

  class ChatSummary(val id: String, val peerId: String, val title: String, val peerLastRead: Long, val row: Map<String, Any?>,
    /** ChatActions: the chat as the server lists it (its settings, what is unread), and its last message as this device shows it. */
    val chat: Map<String, Any?> = emptyMap(), val last: Map<String, Any?> = emptyMap())

  /** The chats as the server lists them, each with its last message as this device has decrypted it. */
  fun chats(done: (Result<List<ChatSummary>>) -> Unit) {
    server.op("chats", emptyList()) { result ->
      if (result.isFailure) {
        main.post { done(Result.failure(Server.error(result))) }
      } else {
        val list = (Core.map(result.getOrNull())?.get("chats") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
        // Pictures of people are fetched by the list itself, as this session.
        Core.prepare("GET", "/files/x", jsonBody = false, token = server.token, proof = server.currentProof)?.let { made -> AvatarStore.headers = made.headers.reversed().toMap() }
        crypto.run({ crypto ->
          val now = Instant.now(); val zone = ZoneId.systemDefault()
          var part = ""
          Result.success(list.mapNotNull { chat ->
            // A quiet heading above the first chat of each part of the list.
            val own = section(chat, now, zone)
            val heading = if (own != part) own else ""
            part = own
            summary(chat, crypto, heading, now, zone)
          })
        }, done)
      }
    }
  }

  /** One chat as a row of the list. Runs on the encryption thread (the last message is read from the kept copy). */
  private fun summary(chat: Map<String, Any?>, crypto: CryptoService, section: String, now: Instant, zone: ZoneId): ChatSummary? {
    val id = chat["id"] as? String ?: return null
    var last = Core.map(chat["lastMessage"])
    if (last != null) {
      // The list never shows the server's own text: only the copy this device decrypted and kept.
      var shown = Core.map(crypto.callNow("preview", listOf(last)).getOrNull())
      if (shown?.get("cryptoState") as? String == "no-key") {
        // Not opened on this device yet: a short catch-up of this chat, then the kept copy.
        crypto.callNow("sync", listOf(id, 2))
        shown = Core.map(crypto.callNow("preview", listOf(last)).getOrNull())
      }
      if (shown != null) last = shown
    }
    return summary(chat, last, userId, now, zone, section, server.base)
  }

  // One chat

  class Page(val rows: List<Map<String, Any?>>, val newestTheirs: Long)

  /** The newest page of a chat as rows for the message list, oldest first, with the id of the newest message
   *  from the other side (what «read» is reported up to). A failure is a `ServerError`. */
  fun messages(chatId: String, peerLastRead: Long, done: (Result<Page>) -> Unit) {
    crypto.run({ crypto ->
      // First everything new is opened and kept (each message exactly once), then the page is shown from the kept copies.
      val synced = CryptoService.failure(crypto.callNow("sync", listOf(chatId)))
      if (synced != null && synced.name == "NetworkError") return@run Result.failure<Page>(ServerError.Network(synced.words))
      val answer = server.opAndWait("messages", listOf(chatId))
      if (answer.isFailure) return@run Result.failure<Page>(Server.error(answer))
      val list = (Core.map(answer.getOrNull())?.get("messages") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
      val opened = list.mapNotNull { message -> Core.map(crypto.callNow("preview", listOf(message)).getOrNull()) }
      // Edits, deletions, reactions, pins and the rest are folded into the lines they belong to (the core's rules).
      val shown = folded(opened, userId, System.currentTimeMillis())
      val newest = list.filter { it["senderId"] as? String != userId }.mapNotNull { (it["id"] as? Number)?.toLong() }.maxOrNull() ?: 0L
      Result.success(Page(rows(shown, userId, peerLastRead, Instant.now(), ZoneId.systemDefault()), newest))
    }, done)
  }

  /** Encrypts one message for every device of the conversation (or takes the ciphertext already kept for this
   *  id), hands it to the server and marks it delivered. Runs on the encryption thread. A failure is a `CryptoFailure`.
   *
   *  - The device list changed since the ciphertext was made: it is dropped and the message encrypted afresh, once.
   *  - Refused for good (not «try later», not a dead session): the kept copy is forgotten, so it is not sent
   *    again after every start.
   *  - No answer: it stays in the list of unsent messages and goes out later with the very same ciphertext.
   *
   *  LinkPreview: `linkPreview` is the card of a link in the text (linkpreview/), or null; the core checks it and
   *  carries it inside the ciphertext.
   *  Calls: `push` is what the server does about the notification ("call" rings, "missed", "none"); null — an
   *  ordinary message. */
  fun deliver(crypto: CryptoService, chatId: String, peerId: String, clientId: String, text: Any?, attachment: Any?, meta: Any?, again: Boolean = true, linkPreview: Any? = null, push: String? = null): Result<Unit> {
    val encrypted = crypto.callNow("encrypt", listOf(chatId, peerId, clientId, text, attachment, meta, null, linkPreview))
    if (encrypted.isFailure) return Result.failure(CryptoService.failure(encrypted) ?: CryptoFailure("Error", "Шифрование недоступно."))
    val sent = server.opAndWait("sendEncrypted", listOfNotNull<Any?>(chatId, clientId, encrypted.getOrNull() ?: emptyMap<String, Any?>(), push))
    if (sent.isSuccess) {
      crypto.callNow("delivered", listOf(chatId, clientId))
      return Result.success(Unit)
    }
    val error = Server.error(sent)
    if (error !is ServerError.Refused) return Result.failure(CryptoFailure("NetworkError", error.words))
    when (afterRefusal(error.status, error.code)) {
      Refusal.AFRESH -> {
        crypto.callNow("forget", listOf(chatId, clientId))
        if (again) return deliver(crypto, chatId, peerId, clientId, text, attachment, meta, again = false, linkPreview = linkPreview, push = push)
      }
      Refusal.FORGET -> crypto.callNow("forget", listOf(chatId, clientId))
      Refusal.KEEP -> {}
    }
    return Result.failure(CryptoFailure("Error", error.words))
  }

  /** Sends a text. A failure is a `CryptoFailure`. */
  fun send(chatId: String, peerId: String, text: String, done: (Result<Unit>) -> Unit) {
    val clientId = UUID.randomUUID().toString().lowercase()
    crypto.run({ crypto -> deliver(crypto, chatId, peerId, clientId, text, null, null) }, done)
  }

  /** Attachments: sends a message that carries a file — already sealed, uploaded and described by the core
   *  (attachments/ChatAttachments.kt). A failure is a `CryptoFailure`. */
  fun send(chatId: String, peerId: String, text: String, attachment: Map<String, Any?>, done: (Result<Unit>) -> Unit) {
    val clientId = UUID.randomUUID().toString().lowercase()
    crypto.run({ crypto -> deliver(crypto, chatId, peerId, clientId, text, attachment, null) }, done)
  }

  /** Messages that were encrypted and kept but never confirmed by the server (the app was closed, the network
   *  went away) go out again — each with the very ciphertext it was first given, so nothing is sent twice. */
  fun resendPending() {
    crypto.run({ crypto ->
      val items = (crypto.callNow("pendingOutbox").getOrNull() as? List<*>).orEmpty().mapNotNull { Core.map(it) }
      var sent = 0
      for (item in items) {
        // Scheduled messages have their own road to the server; they are not built here yet.
        if (item["deliverAt"] != null) continue
        val chatId = item["chatId"] as? String ?: continue
        val clientId = item["clientId"] as? String ?: continue
        val peerId = item["peerId"] as? String ?: continue
        val result = deliver(crypto, chatId, peerId, clientId, item["text"] ?: "", item["attachment"], item["meta"])
        if (result.isSuccess) sent += 1 else if (CryptoService.failure(result)?.name == "NetworkError") break
      }
      sent
    }, { sent -> if (sent > 0) tellChanged(null) })
  }

  // Words and looks: plain functions of what they are given, so they can be checked without a phone.

  /** What becomes of a kept ciphertext the server refused. */
  enum class Refusal { AFRESH, FORGET, KEEP }

  companion object {
    /** The rule of a refused sending: the list of devices changed — forget and encrypt afresh (once); refused for
     *  good (4xx, but not a dead session 401, «too slow» 408 or «too often» 429) — forget; else it is kept. */
    fun afterRefusal(status: Int, code: String?): Refusal = when {
      code == "E2EE_DEVICES_CHANGED" -> Refusal.AFRESH
      status in 400..499 && status != 401 && status != 408 && status != 429 -> Refusal.FORGET
      else -> Refusal.KEEP
    }

    /** A chat's opened messages folded into the lines that are shown (the core's `foldChat`): an edit changes
     *  its message and marks it `edited`, a deleted one is gone, reactions are gathered on their message. Without
     *  the core's answer the service messages are only left out. */
    fun folded(opened: List<Map<String, Any?>>, userId: String, nowMs: Long): List<Map<String, Any?>> {
      val lines = Core.map(Core.view("foldChat", listOf(opened, userId, emptyList<String>(), nowMs)))?.get("messages") as? List<*>
      return lines?.mapNotNull { Core.map(it) } ?: opened.filter { Core.map(it["meta"])?.get("action") == null }
    }

    /** A message's text as the core lays it out (`nativeText`): `{text, fmt, urls}`; null without an answer. */
    fun laidOut(text: String, entities: Any?): Map<String, Any?>? = Core.map(Core.view("nativeText", listOf(text, entities)))

    /** One chat of the server's list as a row; `last` is its last message as this device opened it (or as the
     *  server gave it, when it could not be opened). Null for a chat without an id or the other person. */
    fun summary(chat: Map<String, Any?>, last: Map<String, Any?>?, userId: String, now: Instant, zone: ZoneId, section: String = "", base: String = ""): ChatSummary? {
      val id = chat["id"] as? String ?: return null
      val peer = Core.map(chat["peer"]) ?: return null
      val peerId = peer["id"] as? String ?: return null
      val title = peer["displayName"] as? String ?: ""
      val peerLastRead = (chat["peerLastReadMessageId"] as? Number)?.toLong() ?: 0L
      var preview = ""; var time = ""; var ticks = 0
      if (last != null) {
        // The line of the list as the core words it (a call's outcome, hidden spoilers); else the plain words.
        preview = (Core.view("chatListText", listOf(last)) as? String).orEmpty().ifEmpty { previewText(last) }
        time = listTime(last["createdAt"] as? String, now, zone)
        if (last["senderId"] as? String == userId) ticks = if (peerLastRead >= ((last["id"] as? Number)?.toLong() ?: 0L)) 2 else 1
      }
      val color = color(peer["avatarColor"] as? String)
      val orb = orbPair(color)
      val settings = Core.map(chat["settings"])
      val avatarId = peer["avatarId"] as? String ?: ""
      val avatarUrl = if (avatarId.isEmpty()) "" else base + "/files/" + pathPart(avatarId)
      val row = mapOf<String, Any?>(
        "section" to section, "avatarUrl" to avatarUrl, "avatarKey" to avatarId, "id" to id, "title" to title, "preview" to preview, "time" to time, "unread" to ((chat["unreadCount"] as? Number)?.toInt() ?: 0),
        "muted" to (settings?.get("muted") as? Boolean ?: false), "pinned" to (settings?.get("pinnedAt") is String), "ticks" to ticks,
        "avatarColor" to (0xFF000000.toInt() or color), "initials" to initials(title), "orbA" to orb.first, "orbB" to orb.second,
      )
      return ChatSummary(id, peerId, title, peerLastRead, row, chat, last ?: emptyMap())
    }

    /** The part of the list a chat belongs to: pinned ones first, then by the day of the last message. */
    fun section(chat: Map<String, Any?>, now: Instant, zone: ZoneId): String {
      if (Core.map(chat["settings"])?.get("pinnedAt") is String) return "Закреплённые"
      val at = date(Core.map(chat["lastMessage"])?.get("createdAt") as? String) ?: return "Раньше"
      val days = daysAgo(at.atZone(zone).toLocalDate(), now, zone)
      return if (days <= 0) "Сегодня" else if (days == 1L) "Вчера" else "Раньше"
    }

    /** A text as one part of an address: everything but letters, digits and `-_.~` is percent-encoded. */
    fun pathPart(text: String): String = buildString {
      for (byte in text.toByteArray(Charsets.UTF_8)) {
        val c = (byte.toInt() and 0xFF).toChar()
        if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c in "-_.~") append(c) else append(String.format(Locale.ROOT, "%%%02X", byte.toInt() and 0xFF))
      }
    }

    /** The opened messages of a page, oldest first, as rows of the message list: a line with the day before the
     *  first message of each day; two ticks on the person's own messages the other side has read. The messages
     *  are the folded ones (`folded`): «изм. » stands before the time of an edited one, reactions are chips
     *  (triples [emoji, count, "1" if mine]); `layout` gives a text its formatting (the core's `nativeText`);
     *  `attached` gives a message with a file its picture or label (attachments/AttachmentOpen.kt). */
    fun rows(messages: List<Map<String, Any?>>, userId: String, peerLastRead: Long, now: Instant, zone: ZoneId,
             attached: (message: Map<String, Any?>, key: String) -> Map<String, Any?> = AttachmentRows::fields,
             layout: (text: String, entities: Any?) -> Map<String, Any?>? = ::laidOut): List<Map<String, Any?>> {
      val rows = ArrayList<Map<String, Any?>>()
      var day = ""
      messages.forEachIndexed { index, message ->
        val sender = message["senderId"] as? String
        val mine = sender == userId
        val date = date(message["createdAt"] as? String)
        val today = date?.let { dayWords(it, now, zone) } ?: ""
        if (today != day && today.isNotEmpty()) { day = today; rows.add(mapOf("key" to "day-$index", "kind" to 1, "text" to today)) }
        val next = messages.getOrNull(index + 1)
        val id = (message["id"] as? Number)?.toLong() ?: 0L
        // Bold, links, spoilers and the rest: the text and its runs as the core lays them out.
        var body = previewText(message)
        var fmt = emptyList<Int>(); var urls = emptyList<String>()
        val laid = layout(message["text"] as? String ?: "", Core.map(message["meta"])?.get("entities"))
        val text = laid?.get("text") as? String
        if (!text.isNullOrEmpty()) {
          body = text
          fmt = (laid["fmt"] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() }
          urls = (laid["urls"] as? List<*>).orEmpty().mapNotNull { it as? String }
        }
        val chips = (message["reactions"] as? List<*>).orEmpty().mapNotNull { Core.map(it) }.flatMap { reaction ->
          listOf(reaction["emoji"] as? String ?: "", ((reaction["count"] as? Number)?.toInt() ?: 1).toString(), if (reaction["mine"] == true) "1" else "")
        }
        rows.add(mapOf(
          "key" to "${sender ?: ""}:${message["clientId"] as? String ?: ""}", "kind" to 0, "mine" to mine, "fmt" to fmt, "urls" to urls,
          "text" to body, "time" to ((if (message["edited"] == true) "изм. " else "") + (date?.let { clock(it, zone) } ?: "")), "chips" to chips,
          "ticks" to (if (mine) (if (peerLastRead >= id) 2 else 1) else 0), "tail" to (next?.get("senderId") as? String != sender),
        ))
        // Attachments: a photo's small picture or a file's name and size (attachments/AttachmentOpen.kt).
        if (Core.map(message["attachment"] as? Map<*, *>) != null) rows[rows.size - 1] = rows.last().let { row -> row + attached(message, row["key"] as String) }
        // LinkPreview: the card of a link, as it came inside the message.
        Core.map(message["linkPreview"] as? Map<*, *>)?.let { card -> rows[rows.size - 1] = rows.last() + ("card" to card) }
      }
      return rows
    }

    fun previewText(message: Map<String, Any?>): String {
      val text = message["text"] as? String ?: ""
      if (text.isNotEmpty()) return text
      val attachment = Core.map(message["attachment"]) ?: return ""
      val type = attachment["mimeType"] as? String ?: ""
      return when {
        type.startsWith("image/") -> "Фото"
        type.startsWith("video/") -> "Видео"
        type.startsWith("audio/") -> "Голосовое сообщение"
        else -> attachment["name"] as? String ?: "Файл"
      }
    }

    /** The first letters of the first two words, in capitals. */
    fun initials(name: String): String =
      name.split(' ').filter { it.isNotEmpty() }.take(2).joinToString("") { String(Character.toChars(it.codePointAt(0))) }.uppercase()

    /** `#RRGGBB` → 0xRRGGBB; the app's blue when it is not a colour. */
    fun color(hex: String?): Int {
      if (hex == null || hex.length != 7 || hex[0] != '#' || !hex.drop(1).all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return 0x5E7BFF
      return hex.drop(1).toInt(16)
    }

    /** The moment of a server's time (`2026-11-21T07:00:00.000Z`, with or without the fraction); null if it is not one. */
    fun date(text: String?): Instant? {
      if (text == null) return null
      return try { Instant.parse(text) } catch (_: Exception) { try { OffsetDateTime.parse(text).toInstant() } catch (_: Exception) { null } }
    }

    private val weekdays = listOf("Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс")
    private val months = listOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

    /** `09:05` on the clock of the place. */
    fun clock(moment: Instant, zone: ZoneId): String = moment.atZone(zone).let { String.format(Locale.ROOT, "%02d:%02d", it.hour, it.minute) }

    /** How many midnights lie between a moment and now (0 = today, 1 = yesterday). */
    private fun daysAgo(day: LocalDate, now: Instant, zone: ZoneId): Long = ChronoUnit.DAYS.between(day, now.atZone(zone).toLocalDate())

    /** The time of a chat's last message in the list: the clock today, «Вчера», the weekday within a week, else the date. */
    fun listTime(text: String?, now: Instant, zone: ZoneId): String {
      val moment = date(text) ?: return ""
      val day = moment.atZone(zone).toLocalDate()
      val ago = daysAgo(day, now, zone)
      return when {
        ago == 0L -> clock(moment, zone)
        ago == 1L -> "Вчера"
        ago < 7 -> weekdays[day.dayOfWeek.value - 1]
        else -> String.format(Locale.ROOT, "%02d.%02d", day.dayOfMonth, day.monthValue)
      }
    }

    /** The day a message was written on, for the line above the first message of that day. */
    fun dayWords(moment: Instant, now: Instant, zone: ZoneId): String {
      val day = moment.atZone(zone).toLocalDate()
      return when (daysAgo(day, now, zone)) {
        0L -> "Сегодня"
        1L -> "Вчера"
        else -> "${day.dayOfMonth} ${months[day.monthValue - 1]}" + if (day.year == now.atZone(zone).year) "" else " ${day.year}"
      }
    }
  }
}
