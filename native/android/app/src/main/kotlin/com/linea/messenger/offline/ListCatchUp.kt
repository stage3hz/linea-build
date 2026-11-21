package com.linea.messenger.offline

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService

/** The chat list's line for a chat not opened yet (port of the reference's mobile/src/listCatchUp.ts and the list
 *  part of useMessenger.ts; iOS: Sources/Offline/ListCatchUp.swift).
 *
 *  The server only has ciphertext, so the list is drawn at once from what this device already opened and kept, and
 *  the envelopes of the chats whose line is still closed are opened in the background afterwards — at most
 *  `CHATS_PER_PASS` chats per pass, unread and newest first, `PAGES` inbox pages each. A message sent before this
 *  device signed in has no envelope for it: once the inbox of its chat went through, the line says so
 *  («Это сообщение недоступно на данном устройстве.») instead of «Открой чат для расшифровки», and the chat is not
 *  tried again for that message. */
class ListCatchUp {
  /** Chat → the last message id whose inbox went through (never tried again). Encryption thread only. */
  val caughtUp = HashMap<String, Long>()
  /** Chat → the last try (message id, when): a try that did not get through waits `RETRY_AFTER_MS`. Encryption thread only. */
  val tried = HashMap<String, Pair<Long, Long>>()
  /** Main thread only. */
  var busy = false
  var again: List<Messenger.ChatSummary>? = null

  enum class Outcome { SYNCED, PARTIAL, FAILED, NETWORK }

  /** The line of one chat's last message on this device, on the encryption thread: the kept copy (or a placeholder
   *  when the vault or Signal threw), this device's verdict when the chat was caught up for that very message, and
   *  never a closed line over one already shown opened. */
  fun line(chatId: String, last: Map<String, Any?>, crypto: CryptoService, previous: Map<String, Any?>?): Map<String, Any?> {
    val made = Core.map(crypto.callNow("preview", listOf(last)).getOrNull())
    var shown = made ?: placeholder(last)
    if (made != null && caughtUp[chatId] == number(shown["id"])) shown = settled(shown)
    return kept(shown, previous)
  }

  companion object {
    const val CHATS_PER_PASS = 20
    const val PAGES = 5
    const val EXTRA_PASSES = 4
    const val DEEP_CHATS = 2
    const val RETRY_AFTER_MS = 60_000L
    /** What a list line says when the inbox of the chat was read through and the message still has no key here. */
    const val NOT_FOR_DEVICE = "Это сообщение недоступно на данном устройстве."

    fun number(value: Any?): Long = (value as? Number)?.toLong() ?: 0L

    /** A line still closed: this device holds no decrypted copy of the message (yet). */
    fun awaitsInbox(message: Map<String, Any?>?): Boolean =
      message != null && message.isNotEmpty() && message["cryptoState"] == "no-key" && message["mesh"] == null

    /** The inbox of the chat went through and the message is still closed: no key is coming. Say so. */
    fun settled(message: Map<String, Any?>): Map<String, Any?> =
      if (!awaitsInbox(message) || message["text"] == NOT_FOR_DEVICE) message
      else LinkedHashMap(message).apply { put("text", NOT_FOR_DEVICE); put("attachment", null) }

    /** What the line says when the vault or Signal threw (not this device's verdict on the message). */
    fun placeholder(message: Map<String, Any?>): Map<String, Any?> {
      val legacy = message["legacy"] == true
      return LinkedHashMap(message).apply {
        put("text", if (legacy) "Сообщение из старой версии без сквозного шифрования." else "Зашифрованное сообщение недоступно на этом устройстве.")
        put("attachment", null)
        put("cryptoState", if (legacy) "legacy" else "no-key")
      }
    }

    /** A fresh line never replaces one this device has already opened (or given its verdict on) with a closed
     *  placeholder for the same message (the reference's `keepOpened`). */
    fun kept(fresh: Map<String, Any?>, previous: Map<String, Any?>?): Map<String, Any?> {
      if (!awaitsInbox(fresh) || previous == null || number(previous["id"]) != number(fresh["id"])) return fresh
      return if (previous["cryptoState"] == "decrypted" || previous["text"] == NOT_FOR_DEVICE) previous else fresh
    }

    /** The chats whose last message should be opened now: closed line, not skipped for that very message. Unread
     *  chats first, then the newest; at most `limit`. */
    fun targets(chats: List<Messenger.ChatSummary>, skip: (String, Long) -> Boolean, limit: Int = CHATS_PER_PASS): List<String> =
      chats.filter { awaitsInbox(it.last) && !skip(it.id, number(it.last["id"])) }
        .sortedWith(compareByDescending<Messenger.ChatSummary> { number(it.chat["unreadCount"]) > 0 }.thenByDescending { it.chat["updatedAt"] as? String ?: "" })
        .take(limit).map { it.id }

    /** One chat's background sync; every pass goes on from the vault's cursor, so nothing is opened twice.
     *  `deep`: may use the extra passes for a long queue. */
    fun sync(crypto: CryptoService, chatId: String, deep: Boolean): Outcome {
      var pass = 0
      while (true) {
        val result = crypto.callNow("sync", listOf(chatId, PAGES))
        if (result.isSuccess) return Outcome.SYNCED
        val name = CryptoService.failure(result)?.name ?: "Error"
        if (name == "NetworkError") return Outcome.NETWORK
        if (name != "PartialSync") return Outcome.FAILED
        if (!deep || pass >= EXTRA_PASSES) return Outcome.PARTIAL
        pass += 1
      }
    }

    /** The list line after a background sync: only a full sync and a preview that ran without an exception are this
     *  device's verdict (the reference's `afterSync`). */
    fun afterSync(line: Map<String, Any?>, outcome: Outcome, opened: Boolean): Pair<Map<String, Any?>, Boolean> {
      val caught = outcome == Outcome.SYNCED && opened
      return (if (caught) settled(line) else line) to caught
    }
  }
}

/** Opens, in the background, the last messages of the chats whose line is still closed, and hands each new line
 *  (chat id, the server's last message id, the line) to `update` on the main thread. One pass at a time; a list
 *  given while one runs is taken up after it. Main thread. */
fun Messenger.catchUpList(list: List<Messenger.ChatSummary>, update: (String, Long, Map<String, Any?>) -> Unit) {
  val state = catchUp
  if (state.busy) { state.again = list; return }
  state.busy = true
  crypto.run({ crypto ->
    val now = System.currentTimeMillis()
    val targets = ListCatchUp.targets(list, { chatId, id ->
      state.caughtUp[chatId] == id || state.tried[chatId]?.let { it.first == id && now - it.second < ListCatchUp.RETRY_AFTER_MS } == true
    })
    var deep = ListCatchUp.DEEP_CHATS
    val main = android.os.Handler(android.os.Looper.getMainLooper())
    for (chatId in targets) {
      val chat = list.firstOrNull { it.id == chatId } ?: continue
      val last = Core.map(chat.chat["lastMessage"]) ?: continue
      val id = ListCatchUp.number(last["id"])
      state.tried[chatId] = id to System.currentTimeMillis()
      val outcome = ListCatchUp.sync(crypto, chatId, deep > 0)
      if (outcome == ListCatchUp.Outcome.NETWORK) break
      if (outcome != ListCatchUp.Outcome.SYNCED && deep > 0) deep -= 1
      val made = Core.map(crypto.callNow("preview", listOf(last)).getOrNull())
      val (line, caught) = ListCatchUp.afterSync(made ?: ListCatchUp.placeholder(last), outcome, made != null)
      if (caught) state.caughtUp[chatId] = id
      main.post { update(chatId, id, line) }
    }
  }, {
    state.busy = false
    state.again?.let { next -> state.again = null; catchUpList(next, update) }
  })
}
