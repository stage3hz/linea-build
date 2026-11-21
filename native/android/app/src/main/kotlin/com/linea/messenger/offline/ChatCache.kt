package com.linea.messenger.offline

import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** What the chat list and the open chats showed last time, kept in this account's encrypted vault (SQLCipher, next
 *  to the decrypted message cache — never in plain files, never on the server). The app opens with it at once and
 *  without a network; a successful refresh from the server replaces it. The ciphertext of a message (`encrypted`)
 *  is left out: only what was already shown is kept.
 *
 *  Port of the reference's mobile/src/chatListCache.ts (iOS: Sources/Offline/ChatCache.swift): the same vault names
 *  (`chats:v1`, `page:v1:<chatId>`), the same JSON, the same limits and checks. Written through the core's
 *  `storeCache`; read with `CryptoService.loadCacheAtOnce` (the same entry the core's `loadCache` reads, but not
 *  queued behind network work). */
object ChatCache {
  const val LIST_NAME = "chats:v1"
  const val LIST_LIMIT = 500
  const val PAGE_LIMIT = 60
  private val chatIdRule = Regex("^[A-Za-z0-9_-]{1,80}$")

  /** Where the vault's copies are read, off the main thread and off the encryption thread. */
  val reader: ExecutorService = Executors.newSingleThreadExecutor { work -> Thread(work, "invizent.cache").apply { isDaemon = true } }

  /** Vault name of a chat's last shown page of messages; null for an id that cannot be one. */
  fun pageName(chatId: String): String? = if (chatIdRule.matches(chatId)) "page:v1:$chatId" else null

  /** The names the core's `loadCache` / `storeCache` accept (its `cache_name`). */
  fun isCacheName(name: String): Boolean = name == LIST_NAME || (name.startsWith("page:v1:") && chatIdRule.matches(name.removePrefix("page:v1:")))

  private fun stripped(message: Map<String, Any?>): Map<String, Any?> = LinkedHashMap(message).apply { remove("encrypted") }

  private fun validMessage(value: Any?): Boolean {
    val message = Core.map(value) ?: return false
    val attachmentOk = message.containsKey("attachment") && (message["attachment"] == null || message["attachment"] is Map<*, *>)
    return message["id"] is Number && message["chatId"] is String && message["senderId"] is String && message["clientId"] is String &&
      message["text"] is String && message["createdAt"] is String && attachmentOk
  }

  private fun validChat(value: Any?): Boolean {
    val chat = Core.map(value) ?: return false
    val peer = Core.map(chat["peer"]) ?: return false
    if (chat["id"] !is String || peer["id"] !is String || chat["updatedAt"] !is String || chat["unreadCount"] !is Number) return false
    return chat.containsKey("lastMessage") && (chat["lastMessage"] == null || validMessage(chat["lastMessage"]))
  }

  /** The list as shown: each chat as the server listed it, with its last message as this device showed it. */
  fun encodeList(chats: List<Messenger.ChatSummary>): String? {
    val out = ArrayList<Map<String, Any?>>()
    for (summary in chats.take(LIST_LIMIT)) {
      if (summary.chat["id"] == null) continue
      val chat = LinkedHashMap(summary.chat)
      chat["lastMessage"] = if (summary.last.isEmpty()) null else LinkedHashMap(stripped(summary.last)).apply {
        if (!containsKey("attachment")) put("attachment", null)
        if (this["text"] == null) put("text", "")
      }
      out.add(chat)
    }
    return Core.text(out)
  }

  /** The kept list in the order it was shown (pinned first); anything damaged reads as nothing. */
  fun decodeList(raw: String?): List<Map<String, Any?>> {
    if (raw.isNullOrEmpty()) return emptyList()
    val list = Core.value(raw) as? List<*> ?: return emptyList()
    val seen = HashSet<String>()
    val out = ArrayList<Map<String, Any?>>()
    for (item in list) {
      if (!validChat(item)) continue
      val chat = Core.map(item) ?: continue
      val id = chat["id"] as String
      if (!seen.add(id)) continue
      out.add(chat)
      if (out.size >= LIST_LIMIT) break
    }
    return out
  }

  class Page(val messages: List<Map<String, Any?>>, val hasMore: Boolean)

  /** The newest `PAGE_LIMIT` messages of a chat as shown (opened copies; never anything still being sent). */
  fun encodePage(messages: List<Map<String, Any?>>, hasMore: Boolean): String? {
    val kept = messages.filter { ((it["id"] as? Number)?.toLong() ?: 0L) > 0L && it["localState"] == null && it["mesh"] == null }
    val page = kept.takeLast(PAGE_LIMIT).map { stripped(it) }
    return Core.text(mapOf("messages" to page, "hasMore" to (hasMore || kept.size > page.size)))
  }

  fun decodePage(raw: String?, chatId: String): Page? {
    if (raw.isNullOrEmpty()) return null
    val fields = Core.map(Core.value(raw)) ?: return null
    val list = fields["messages"] as? List<*> ?: return null
    val messages = list.filter { validMessage(it) && Core.map(it)?.get("chatId") == chatId }.mapNotNull { Core.map(it) }
      .sortedBy { (it["id"] as? Number)?.toLong() ?: 0L }
    return if (messages.isEmpty()) null else Page(messages, fields["hasMore"] == true)
  }

  private val main by lazy { Handler(Looper.getMainLooper()) }

  /** The chat list as it was shown last time (from the vault), as rows — at once, before (or without) the network.
   *  Empty when nothing was kept. `done` on the main thread. */
  fun cachedChats(messenger: Messenger, done: (List<Messenger.ChatSummary>) -> Unit) {
    reader.execute {
      val chats = decodeList(messenger.crypto.loadCacheAtOnce(LIST_NAME))
      val made = chats.mapNotNull { chat -> messenger.lineSummary(chat, Core.map(chat["lastMessage"])) }
      main.post { done(made) }
    }
  }

  /** Keeps the list as shown now (after the server answered) for the next start. */
  fun storeChats(messenger: Messenger, chats: List<Messenger.ChatSummary>) {
    val text = encodeList(chats) ?: return
    messenger.crypto.call("storeCache", listOf(LIST_NAME, text)) { }
  }
}
