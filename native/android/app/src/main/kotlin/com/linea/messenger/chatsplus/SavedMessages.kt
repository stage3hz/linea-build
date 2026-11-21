package com.linea.messenger.chatsplus

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoFailure
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.net.Live
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID

/** ChatsPlus: «Избранное» — personal notes and saved messages (the reference's saved/saved.ts and useSaved.ts). The
 *  list lives only in this device's encrypted storage (the core's local entry `saved:v1`, the same one the previous
 *  app used); attachments keep pointing at the already end-to-end encrypted files on the server. The server never
 *  learns what is saved (native/ios/Sources/ChatsPlus/SavedMessages.swift).
 *
 *  For other screens (the message menu's «В Избранное»):
 *
 *      SavedMessages.of(messenger).save(message, chatId, author) { result -> … }
 *
 *  `result` is success(true) when the message was added, success(false) when it was already there, and a failure
 *  with the words to show. Main thread in, main thread out. */
class SavedMessages private constructor(private val crypto: CryptoService?) {
  /** The words a failure carries. */
  class Failure(val words: String) : Exception(words)

  /** Oldest first, as the reference keeps them. */
  var items: List<Map<String, Any?>> = emptyList()
    private set
  var loaded = false
    private set
  var error = ""
    private set

  private fun load() {
    val crypto = crypto ?: run { loaded = true; return }
    crypto.call("loadLocal", listOf("saved:v1")) { result ->
      if (result.isSuccess) items = parse(result.getOrNull() as? String)
      else error = (result.exceptionOrNull() as? CryptoFailure)?.words?.ifEmpty { null } ?: "Не удалось открыть Избранное."
      loaded = true
      changed.post(Unit)
    }
  }

  /** Every change goes to the encrypted storage in order; a failed write puts the list back as it was. */
  private fun commit(next: List<Map<String, Any?>>, done: ((Failure?) -> Unit)? = null) {
    val previous = items
    items = next
    error = ""
    changed.post(Unit)
    val crypto = crypto ?: return done?.invoke(null) ?: Unit
    val json = Core.text(next) ?: return done?.invoke(Failure("Не удалось сохранить Избранное.")) ?: Unit
    crypto.call("storeLocal", listOf("saved:v1", json)) { result ->
      if (result.isFailure) {
        val words = (result.exceptionOrNull() as? CryptoFailure)?.words?.ifEmpty { null } ?: "Не удалось сохранить Избранное."
        if (items == next) items = previous
        error = words
        changed.post(Unit)
        done?.invoke(Failure(words))
      } else done?.invoke(null)
    }
  }

  /** A note or a file, optionally with where it came from. success(false): already saved. */
  fun save(text: String, attachment: Map<String, Any?>?, origin: Map<String, Any?>? = null, done: (Result<Boolean>) -> Unit) {
    if (!loaded) return done(Result.failure(Failure("Избранное ещё загружается. Попробуй через секунду.")))
    val item = linkedMapOf<String, Any?>("id" to UUID.randomUUID().toString().lowercase(), "savedAt" to stamp(Instant.now()),
      "text" to text.trim().take(TEXT_LIMIT), "attachment" to attachment)
    if (origin != null) item["origin"] = origin
    if (!valid(item)) return done(Result.failure(Failure("Не удалось сохранить: сообщение пустое или слишком длинное.")))
    if (origin != null && items.any { entry ->
        val kept = Core.map(entry["origin"]) ?: return@any false
        kept["chatId"] == origin["chatId"] && kept["clientId"] == origin["clientId"]
      }) return done(Result.success(false))
    if (items.size >= LIMIT) return done(Result.failure(Failure("В Избранном уже $LIMIT записей. Удали старые, чтобы добавить новые.")))
    commit(items + item) { failure -> done(if (failure != null) Result.failure(failure) else Result.success(true)) }
  }

  /** «В Избранное» from a chat: the message as this device shows it (decrypted: `text`, `attachment`, `clientId`,
   *  `createdAt` or `sentAt`), the chat it is in and the name of its author. */
  fun save(message: Map<String, Any?>, chatId: String, author: String, done: (Result<Boolean>) -> Unit) {
    val text = message["text"] as? String ?: ""
    val attachment = Core.map(message["attachment"])
    val sentAt = message["createdAt"] as? String ?: message["sentAt"] as? String ?: stamp(Instant.now())
    val clientId = message["clientId"] as? String
    val origin = if (clientId == null) null else mapOf("chatId" to chatId, "clientId" to clientId, "author" to author.take(80).ifEmpty { "Собеседник" }, "sentAt" to sentAt)
    save(text, attachment, origin, done)
  }

  fun remove(id: String, done: ((Failure?) -> Unit)? = null) = commit(items.filter { it["id"] != id }, done)

  /** «Выбрать» → «Удалить»: several notes in one write. */
  fun remove(ids: Set<String>, done: ((Failure?) -> Unit)? = null) = commit(items.filter { !ids.contains(it["id"] as? String ?: "") }, done)

  /** «Очистить Избранное»: everything, in one write. */
  fun clear(done: ((Failure?) -> Unit)? = null) = commit(emptyList(), done)

  fun edit(id: String, text: String, done: ((Failure?) -> Unit)? = null) {
    val next = text.trim()
    val index = items.indexOfFirst { it["id"] == id }
    if (index < 0) return done?.invoke(null) ?: Unit
    val changed = items.toMutableList()
    changed[index] = LinkedHashMap(changed[index]).apply { put("text", next); put("editedAt", stamp(Instant.now())) }
    if (!valid(changed[index])) return done?.invoke(Failure("Текст пустой или слишком длинный.")) ?: Unit
    commit(changed, done)
  }

  companion object {
    const val LIMIT = 5000
    const val TEXT_LIMIT = 8000
    /** Posted on the main thread when a list changed or finished loading. */
    val changed = Live.Signal<Unit>()
    private val byAccount = HashMap<String, SavedMessages>()
    private var sample: SavedMessages? = null

    /** The list of one account (one copy per account: the chat list's row and the screen stay in step). */
    fun of(messenger: Messenger): SavedMessages = byAccount.getOrPut(messenger.userId) { SavedMessages(messenger.crypto).also { it.load() } }

    /** The list for a screen that may have no account (the debug build's samples; null in a release build). */
    fun shared(messenger: Messenger?): SavedMessages? {
      if (messenger != null) return of(messenger)
      sample?.let { return it }
      val items = ChatsPlusDemo.savedItems()
      if (!ChatsPlusDemo.present) return null
      return SavedMessages(null).also { it.items = items; it.loaded = true; sample = it }
    }

    fun stamp(at: Instant): String = at.truncatedTo(ChronoUnit.MILLIS).toString().let { if (it.contains('.')) it else it.dropLast(1) + ".000Z" }

    /** The reference's `parseSaved`: anything malformed is dropped, not the whole list. */
    fun parse(raw: String?): List<Map<String, Any?>> = (Core.value(raw) as? List<*>).orEmpty().mapNotNull { Core.map(it) }.filter { valid(it) }.takeLast(LIMIT)

    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    private fun isUuid(value: Any?): Boolean = (value as? String)?.let { it.length == 36 && uuid.matches(it) } ?: false
    private fun isDate(value: Any?): Boolean = (value as? String)?.let { it.length <= 40 && Messenger.date(it) != null } ?: false

    /** The reference's `validSavedItem` (the attachment itself is checked by the core when it is opened). */
    fun valid(item: Map<String, Any?>): Boolean {
      if (!isUuid(item["id"]) || !isDate(item["savedAt"])) return false
      val text = item["text"] as? String ?: return false
      if (text.length > TEXT_LIMIT) return false
      val raw = item["attachment"]
      val attachment = Core.map(raw)
      if (raw != null && attachment == null) return false
      if (attachment != null && attachment["id"] !is String) return false
      if (text.isBlank() && attachment == null) return false
      if (item.containsKey("origin")) {
        val fields = Core.map(item["origin"]) ?: return false
        val author = fields["author"] as? String ?: return false
        if (!isUuid(fields["chatId"]) || !isUuid(fields["clientId"]) || author.isEmpty() || author.length > 80 || !isDate(fields["sentAt"])) return false
      }
      if (item.containsKey("editedAt") && !isDate(item["editedAt"])) return false
      return true
    }

    /** The line of a note in the list: its text, else what its file is (the reference's `listAttachment`). */
    fun line(item: Map<String, Any?>): Pair<String, String> {
      val text = (item["text"] as? String ?: "").split('\n').joinToString(" ")
      if (text.isNotBlank()) return text to ""
      val attachment = Core.map(item["attachment"]) ?: return "Запись" to ""
      return ChatRowLooks.attachmentLine(attachment)
    }

    /** The reference's `searchSaved`. */
    fun search(list: List<Map<String, Any?>>, query: String): List<Map<String, Any?>> {
      val needle = query.trim().lowercase()
      if (needle.isEmpty()) return list
      return list.filter { item ->
        val name = Core.map(item["attachment"])?.get("name") as? String ?: ""
        val author = Core.map(item["origin"])?.get("author") as? String ?: ""
        ((item["text"] as? String ?: "") + " " + name + " " + author).lowercase().contains(needle)
      }
    }
  }
}
