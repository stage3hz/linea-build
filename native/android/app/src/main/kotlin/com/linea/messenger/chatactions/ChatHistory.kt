package com.linea.messenger.chatactions

import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.AttachmentRows
import com.linea.messenger.composer.deliverLater
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.UUID
import java.util.concurrent.Executors

/** The messages of one open chat: the pages read from the server (each message as this device decrypted and kept
 *  it), what is on its way out, and the rows the list draws for them.
 *
 *  Everything a person does to a message — an edit, a deletion for both, a reaction, a pin — is itself an
 *  end-to-end encrypted message (`meta.action`, the reference's messageMeta.ts); the server cannot tell it from
 *  any other. They are folded into the lines they belong to by the shared core (`foldChat`), exactly as the
 *  other phone folds them.
 *
 *  Main thread only; the folding itself runs on a thread of its own and its result comes back to the main one. */
class ChatHistory(private val messenger: Messenger?, private val local: ChatLocal?, val chatId: String, val peerId: String, var peerName: String) {
  /** A message handed to the encryption and not yet seen in a page from the server. */
  data class Pending(val clientId: String, val text: String, val meta: Map<String, Any?>?, val attachment: Map<String, Any?>?, val createdAt: String, val failed: Boolean = false,
    /** LinkPreview: the card of a link in the text, made on this phone (linkpreview/); null: none. */
    val linkPreview: Map<String, Any?>? = null,
    /** Composer: «Отправить позже» — the moment the server releases it (ISO); null: now. */
    val deliverAt: String? = null)

  /** What the screen shows, made from the messages by `build`. */
  class Shown(
    /** Rows for `MsgRow.parse`, oldest first. */
    val rows: List<Map<String, Any?>> = emptyList(),
    /** The folded message of a row, by the row's key (`senderId:clientId`). */
    val messages: Map<String, Map<String, Any?>> = emptyMap(),
    /** The row of a message, by its clientId. */
    val keyOfClient: Map<String, String> = emptyMap(),
    /** The keys of the message rows, oldest first. */
    val order: List<String> = emptyList(),
    val pinned: Map<String, Any?>? = null,
    /** The chat's rule «копирование запрещено» (an encrypted setting both sides follow). */
    val noCopy: Boolean = false,
    /** The newest message of the other side among everything loaded (what «read» is reported up to). */
    val newestTheirs: Long = 0,
    /** Messages that are loaded but cannot be read on this device (sent before it signed in), by clientId. */
    val noKey: Set<String> = emptySet(),
    val failedActions: Int = 0,
    /** Profile: the chat's rule «Автоудаление», seconds (0 = off; an encrypted setting both sides follow). */
    val ttl: Long = 0,
    /** ChatsPlus: the `end` action of a finished call, by its row's key (a touch calls back). */
    val calls: Map<String, Map<String, Any?>> = emptyMap(),
    /** ChatActions: how many messages hold the words of the search (0 without a search). */
    val found: Int = 0,
  )

  /** Everything `build` reads, taken at one moment. */
  class Snapshot(
    val raw: List<Map<String, Any?>>, val pending: List<Pending>, val hidden: List<String>, val selection: Set<String>?,
    val peerLastRead: Long, val unreadAfter: Long?, val userId: String, val peerName: String,
    val now: Instant = Instant.now(), val zone: ZoneId = ZoneId.systemDefault(),
    /** Polls: the options ticked so far in polls with several answers, by row key. */
    val pollDrafts: Map<String, List<Int>> = emptyMap(),
    /** ChatActions: the words of the search in this chat (empty: the whole chat shows). */
    val needle: String = "",
  )

  /** What is loaded after a page was applied to it. */
  class Applied(val raw: List<Map<String, Any?>>, val hasMore: Boolean)

  private class Loaded(val messages: List<Map<String, Any?>>, val hasMore: Boolean, val newestTheirs: Long)

  val userId: String = messenger?.userId ?: "demo-me"
  private val main = Handler(Looper.getMainLooper())

  private var raw: List<Map<String, Any?>> = emptyList()
  var hasMore = false
    private set
  var loadingOlder = false
    private set
  private var loadingNewest = false
  private var loadAgain = false
  private var pending: List<Pending> = emptyList()
  private var generation = 0
  private var demoHidden: List<String> = emptyList()
  private var demoNext = 100L
  var loadedOnce = false
    private set

  var shown = Shown()
    private set
  /** Rows chosen in the multi-select; null when nothing is being selected. */
  var selection: Set<String>? = null
    set(value) { if (field != value) { field = value; rebuild() } }
  var peerLastRead = 0L
    set(value) { if (field != value) { field = value; rebuild() } }
  /** The last message read before the chat was opened: «Непрочитанные сообщения» stands after it. Null: no line. */
  var unreadAfter: Long? = null
    set(value) { if (field != value) { field = value; rebuild() } }

  /** Polls: the options ticked so far in polls with several answers, by row key (until «Голосовать»). */
  var pollDrafts: Map<String, List<Int>> = emptyMap()
    set(value) { if (field != value) { field = value; rebuild() } }
  /** ChatActions: the words of the search in this chat (empty: the whole chat shows). */
  var searchNeedle = ""
    set(value) { if (field != value) { field = value; rebuild() } }
  /** Composer: a scheduled message was handed to the server (the moment it goes out, ISO). */
  var onScheduled: ((String) -> Unit)? = null

  /** The rows changed. */
  var onShown: ((Shown) -> Unit)? = null
  /** A page came from the server (not an older one): the newest message of the other side in it. */
  var onLoaded: ((Long) -> Unit)? = null
  /** Something could not be sent or read: the words for the person. */
  var onProblem: ((String) -> Unit)? = null

  // Reading

  /** Reads the newest page (or, with `older`, the page before the oldest loaded one) and shows it. */
  fun load(older: Boolean = false, done: ((Boolean) -> Unit)? = null) {
    val messenger = messenger
    if (messenger == null) {
      loadedOnce = true
      rebuild()
      done?.invoke(true)
      return
    }
    var before: Long? = null
    if (older) {
      val oldest = raw.firstOrNull()
      if (!hasMore || loadingOlder || oldest == null) { done?.invoke(false); return }
      before = number(oldest["id"])
      loadingOlder = true
    } else {
      if (loadingNewest) { loadAgain = true; done?.invoke(false); return }
      loadingNewest = true
      showKept(messenger)
    }
    val chatId = chatId; val me = userId; val pageBefore = before
    messenger.crypto.run({ crypto: CryptoService ->
      // Offline: the page request goes out together with the inbox sync (one round trip saved before the chat
      // shows, as in the reference); a sync that failed does not hold the page back — what was opened and kept
      // before is shown. The page is opened only after the sync has consumed the envelopes.
      val asked = java.util.concurrent.CompletableFuture<Result<Any?>>()
      messenger.server.op("messages", if (pageBefore != null) listOf(chatId, pageBefore) else listOf(chatId)) { asked.complete(it) }
      crypto.callNow("sync", listOf(chatId))
      val answer = asked.get()
      if (answer.isFailure) return@run Result.failure<Loaded>(Server.error(answer))
      val fields = Core.map(answer.getOrNull())
      val list = (fields?.get("messages") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
      val opened = list.mapNotNull { message -> Core.map(crypto.callNow("preview", listOf(message)).getOrNull()) }
      val theirs = list.filter { it["senderId"] as? String != me }.maxOfOrNull { number(it["id"]) } ?: 0L
      Result.success(Loaded(opened, fields?.get("hasMore") as? Boolean ?: false, theirs))
    }, { result ->
      if (older) loadingOlder = false else loadingNewest = false
      val answer = result.getOrNull()
      if (answer == null) {
        if (older) onProblem?.invoke(Server.error(result).words)
        done?.invoke(false)
      } else {
        loadedOnce = true
        // What the server has now is no longer «on its way out».
        val confirmed = answer.messages.filter { it["senderId"] as? String == userId }.mapNotNull { it["clientId"] as? String }.toSet()
        pending = pending.filter { it.clientId !in confirmed }
        val applied = applyPage(raw, hasMore, answer.messages, older, answer.hasMore)
        raw = applied.raw
        hasMore = applied.hasMore
        rebuild()
        keepSoon()
        if (!older) onLoaded?.invoke(answer.newestTheirs)
        done?.invoke(true)
      }
      if (!older && loadAgain) {
        loadAgain = false
        load()
      }
    })
  }

  /** Offline: the page shown last time was looked for in the vault (once per opening). */
  private var cacheTried = false
  private val keepRun = Runnable { keepNow() }

  /** Offline: the page shown last time (the vault's copy) is on screen at once, also without a network, while the
   *  server is asked (the reference's useMessenger `loadMessages`). */
  private fun showKept(messenger: Messenger) {
    val name = com.linea.messenger.offline.ChatCache.pageName(chatId)
    if (cacheTried || raw.isNotEmpty() || name == null) return
    cacheTried = true
    val crypto = messenger.crypto; val chatId = chatId
    com.linea.messenger.offline.ChatCache.reader.execute {
      val kept = com.linea.messenger.offline.ChatCache.decodePage(crypto.loadCacheAtOnce(name), chatId)
      main.post {
        if (kept != null && raw.isEmpty()) {
          raw = kept.messages
          hasMore = kept.hasMore
          rebuild()
        }
      }
    }
  }

  /** Offline: the chat's newest messages go to the vault a moment after a page came. */
  private fun keepSoon() {
    main.removeCallbacks(keepRun)
    main.postDelayed(keepRun, 2000)
  }

  private fun keepNow() {
    val messenger = messenger ?: return
    val name = com.linea.messenger.offline.ChatCache.pageName(chatId) ?: return
    if (raw.isEmpty()) return
    val text = com.linea.messenger.offline.ChatCache.encodePage(raw, hasMore) ?: return
    messenger.crypto.call("storeCache", listOf(name, text)) { }
  }

  /** Whether a message is known to be gone: it is loaded but folded out of the view, or its deletion is loaded. */
  fun knownDeleted(clientId: String): Boolean {
    if (shown.keyOfClient[clientId] != null || shown.noKey.contains(clientId)) return false
    return raw.any { message ->
      if (message["clientId"] as? String == clientId) return@any true
      val action = action(message) ?: return@any false
      action["type"] as? String == "delete" && action["target"] as? String == clientId
    }
  }

  // Sending

  /** Sends a message of this chat: a plain one, an answer (`meta.reply`), a forwarded one, or an action.
   *  LinkPreview: `linkPreview` is the card of a link the person typed (the core checks it once more). */
  fun send(text: String, meta: Map<String, Any?>?, attachment: Map<String, Any?>? = null, linkPreview: Map<String, Any?>? = null, deliverAt: String? = null) {
    // Composer: a scheduled message is shown as being sent until the server keeps it (then it is in the list of
    // «Отложенные сообщения», composer/SchedulePicker.kt).
    val item = Pending(UUID.randomUUID().toString().lowercase(), text, meta, attachment, Instant.now().truncatedTo(ChronoUnit.MILLIS).toString(), linkPreview = linkPreview, deliverAt = deliverAt)
    pending = pending + item
    rebuild()
    deliver(item)
  }

  /** An edit, a deletion for both, a reaction or a pin: sent as an ordinary encrypted message. The text that
   *  goes with it is what a client that does not know the action would show (the core words it). */
  fun sendAction(action: Map<String, Any?>, targetText: String = "") {
    val fallback = Core.view("actionFallback", listOf(action, targetText)) as? String ?: ""
    send(fallback, mapOf("action" to action))
  }

  /** Sends again what was refused. */
  fun retryFailed() {
    val again = pending.filter { it.failed }
    pending = pending.map { if (it.failed) it.copy(failed = false) else it }
    for (item in again) deliver(item.copy(failed = false))
    rebuild()
  }

  private fun deliver(item: Pending) {
    // Composer: «Отправить позже» goes its own road (composer/ScheduledStore.kt).
    item.deliverAt?.let { return deliverLater(item, it) }
    val messenger = messenger
    if (messenger == null) {
      if (!ChatActionsDemo.present) return
      // The sample chat: the message is simply there.
      pending = pending.filter { it.clientId != item.clientId }
      demoNext += 1
      val message = linkedMapOf<String, Any?>("id" to demoNext, "chatId" to chatId, "senderId" to userId, "clientId" to item.clientId, "text" to item.text,
        "attachment" to null, "createdAt" to item.createdAt, "cryptoState" to "decrypted")
      if (item.meta != null) message["meta"] = item.meta
      if (item.linkPreview != null) message["linkPreview"] = item.linkPreview
      raw = raw + message
      rebuild()
      return
    }
    val chatId = chatId; val peerId = peerId
    messenger.crypto.run({ crypto: CryptoService ->
      messenger.deliver(crypto, chatId, peerId, item.clientId, item.text, item.attachment, item.meta, linkPreview = item.linkPreview)
    }, { result ->
      if (result.isSuccess) {
        // The page read next holds it; until then it stays shown as being sent.
        load()
      } else {
        val failure = CryptoService.failure(result)
        // Without an answer it is kept among the unsent and goes out by itself, with the same ciphertext.
        if (failure?.name != "NetworkError") {
          pending = pending.map { if (it.clientId == item.clientId) it.copy(failed = true) else it }
          rebuild()
          onProblem?.invoke(failure?.words ?: "")
        }
      }
    })
  }

  /** Composer: encrypted now, kept by the server until `deliverAt`. While it is on its way it is shown as being sent;
   *  once the server keeps it, it leaves the chat for the list of scheduled messages. */
  private fun deliverLater(item: Pending, deliverAt: String) {
    val messenger = messenger
    if (messenger == null) {
      pending = pending.filter { it.clientId != item.clientId }
      rebuild()
      onScheduled?.invoke(deliverAt)
      return
    }
    val chatId = chatId; val peerId = peerId
    messenger.crypto.run({ crypto: CryptoService ->
      messenger.deliverLater(crypto, chatId, peerId, item.clientId, item.text, item.attachment, item.meta, deliverAt)
    }, { result ->
      if (result.isSuccess) {
        pending = pending.filter { it.clientId != item.clientId }
        rebuild()
        if (result.getOrNull() == true) {
          onScheduled?.invoke(deliverAt)
          com.linea.messenger.composer.ScheduledStore.of(messenger).refresh()
        } else load()
      } else {
        val failure = CryptoService.failure(result)
        if (failure?.name != "NetworkError") {
          pending = pending.map { if (it.clientId == item.clientId) it.copy(failed = true) else it }
          rebuild()
          onProblem?.invoke(failure?.words ?: "")
        }
      }
    })
  }

  /** «Удалить у меня»: the messages disappear on this device only. */
  fun hideForMe(keys: List<String>) {
    if (local != null) local.hide(keys) else demoHidden = demoHidden + keys
    rebuild()
  }

  // The rows

  fun rebuild() {
    generation += 1
    val run = generation
    val snapshot = Snapshot(raw, pending, local?.hiddenKeys ?: demoHidden, selection, peerLastRead, unreadAfter, userId, peerName, pollDrafts = pollDrafts, needle = searchNeedle)
    queue.execute {
      val made = build(snapshot)
      main.post {
        if (generation != run) return@post
        shown = made
        onShown?.invoke(made)
      }
    }
  }

  // The sample chat (debug builds: chatactions/ChatActionsDemo.kt of src/debug)

  /** Fills the chat with messages that are not from a server (the debug build's sample chat). */
  fun seed(list: List<Map<String, Any?>>, read: Long) {
    raw = list
    demoNext = list.size + 1L
    peerLastRead = read
    hasMore = false
  }

  companion object {
    /** Ids of messages that are not on the server yet stand after every real one. */
    const val localBase = 9_000_000_000_000L
    private val queue = Executors.newSingleThreadExecutor { work -> Thread(work, "invizent.chat-view").apply { isDaemon = true } }

    fun number(value: Any?): Long = (value as? Number)?.toLong() ?: 0L
    fun key(message: Map<String, Any?>): String = (message["senderId"] as? String ?: "") + ":" + (message["clientId"] as? String ?: "")
    fun action(message: Map<String, Any?>): Map<String, Any?>? = Core.map(Core.map(message["meta"])?.get("action"))

    /** A page applied to what is loaded (the reference's messagePages.ts `applyPage`): an older page is only added;
     *  the newest page replaces its own range of ids, so a message deleted on the server goes, while the history
     *  scrolled up earlier stays — unless the page does not reach it, when a gap would be left. */
    fun applyPage(raw: List<Map<String, Any?>>, hadMore: Boolean, page: List<Map<String, Any?>>, older: Boolean, more: Boolean): Applied {
      fun id(message: Map<String, Any?>) = number(message["id"])
      fun merged(first: List<Map<String, Any?>>, second: List<Map<String, Any?>>): List<Map<String, Any?>> {
        val byId = java.util.TreeMap<Long, Map<String, Any?>>()
        for (message in first) byId[id(message)] = message
        for (message in second) byId[id(message)] = message
        return byId.values.toList()
      }
      if (older) return Applied(merged(page, raw), more)
      if (page.isEmpty()) return Applied(emptyList(), false)
      val low = page.minOf { id(it) }; val high = page.maxOf { id(it) }
      val overlap = raw.any { id(it) in low..high }
      val kept = raw.filter { id(it) > high || (id(it) < low && more && overlap) }
      val olderKept = kept.any { id(it) < low }
      return Applied(merged(page, kept), if (olderKept) hadMore else more)
    }

    fun missingWords(count: Int): String {
      if (count % 10 == 1 && count % 100 != 11) return "сообщение"
      if (count % 10 in 2..4 && (count % 100 < 12 || count % 100 > 14)) return "сообщения"
      return "сообщений"
    }

    /** The notice of a run of messages this device cannot open, in the reference's words (MessageRow.tsx `MissingRow`). */
    fun missingText(count: Int): String =
      "$count ${missingWords(count)} до входа на этом устройстве. Они зашифрованы для других твоих устройств и здесь не открываются."

    private val blanks = Regex("[ \\n\\t]+")

    /** The quote above an answer (the reference's replyQuote.ts): the original as it is now when it is loaded,
     *  else the line stored with the answer; «Сообщение удалено» when there is neither. */
    fun quoteText(original: Map<String, Any?>?, stored: String): String {
      if (original != null) {
        val line = Core.view("replyPreview", listOf(original)) as? String
        if (!line.isNullOrEmpty()) return line
      }
      val kept = stored.split(blanks).filter { it.isNotEmpty() }.joinToString(" ")
      return kept.ifEmpty { "Сообщение удалено" }
    }

    fun build(input: Snapshot): Shown {
      val all = ArrayList(input.raw)
      var failedActions = 0
      input.pending.forEachIndexed { index, item ->
        // Shown at once (as in the reference): the message itself as being sent, an action as already applied.
        if (item.failed && item.meta?.get("action") != null) { failedActions += 1; return@forEachIndexed }
        val message = linkedMapOf<String, Any?>("id" to localBase + index, "senderId" to input.userId, "clientId" to item.clientId, "text" to item.text,
          "attachment" to item.attachment, "createdAt" to item.createdAt, "cryptoState" to "decrypted", "localState" to (if (item.failed) "failed" else "sending"))
        if (item.meta != null) message["meta"] = item.meta
        if (item.linkPreview != null) message["linkPreview"] = item.linkPreview
        all.add(message)
      }
      val newestTheirs = input.raw.filter { it["senderId"] as? String != input.userId }.maxOfOrNull { number(it["id"]) } ?: 0L

      val folded = Core.map(Core.view("foldChat", listOf(all, input.userId, input.hidden, input.now.toEpochMilli())))
      val lines = (folded?.get("messages") as? List<*>)?.mapNotNull { Core.map(it) }
      val messages = lines ?: all.filter { action(it) == null }.sortedBy { number(it["id"]) }
      val pinned = if (lines != null) Core.map(folded["pinned"]) else null
      val noCopy = if (lines != null) Core.map(folded["rules"])?.get("noCopy") as? Boolean ?: false else false
      val ttl = if (lines != null) number(Core.map(folded["rules"])?.get("ttl")) else 0L // Profile
      val byClient = HashMap<String, Map<String, Any?>>()
      for (message in messages) (message["clientId"] as? String)?.let { byClient[it] = message }

      val rows = ArrayList<MutableMap<String, Any?>>()
      val shownMessages = LinkedHashMap<String, Map<String, Any?>>()
      val keyOfClient = HashMap<String, String>()
      val order = ArrayList<String>()
      val noKey = HashSet<String>()
      var day = ""
      var missingRow = -1
      var missingCount = 0
      var unreadShown = false
      val calls = HashMap<String, Map<String, Any?>>() // ChatsPlus
      var found = 0 // ChatActions: the search
      messages.forEachIndexed { index, message ->
        val sender = message["senderId"] as? String ?: ""
        val client = message["clientId"] as? String ?: ""
        // ChatActions: while searching, only the messages that hold the words (chatactions/ChatSearch.kt).
        if (input.needle.isNotEmpty() && (message["cryptoState"] as? String == "no-key" || action(message) != null || !ChatSearchBar.matches(message, input.needle))) return@forEachIndexed
        val key = "$sender:$client"
        val mine = sender == input.userId
        val id = number(message["id"])
        val date = Messenger.date(message["createdAt"] as? String)
        val today = date?.let { Messenger.dayWords(it, input.now, input.zone) } ?: ""
        val clock = date?.let { Messenger.clock(it, input.zone) } ?: ""
        // Offline: messages this device has no key for (sent before it signed in) are ONE notice for the whole
        // run, across days — no day lines between them; the next readable message gets its day line again.
        if (message["cryptoState"] as? String == "no-key" && missingRow >= 0) {
          noKey.add(client)
          missingCount += 1
          rows[missingRow]["text"] = missingText(missingCount)
          return@forEachIndexed
        }
        if (today != day && today.isNotEmpty()) {
          day = today
          rows.add(linkedMapOf("key" to "d$key", "kind" to 1, "text" to today))
          missingRow = -1
        }
        val after = input.unreadAfter
        if (after != null && !unreadShown && !mine && id > after && id < localBase) {
          unreadShown = true
          // Not before the very first row of the page: there it would say nothing.
          if (rows.any { (it["kind"] as? Int) == 0 }) {
            rows.add(linkedMapOf("key" to "unread", "kind" to 1, "text" to "Непрочитанные сообщения"))
            missingRow = -1
          }
        }
        // A run of messages this device has no key for is one line.
        if (message["cryptoState"] as? String == "no-key") {
          noKey.add(client)
          missingCount = 1
          missingRow = rows.size
          rows.add(linkedMapOf("key" to "x$key", "kind" to 2, "text" to missingText(missingCount)))
          return@forEachIndexed
        }
        missingRow = -1
        val meta = Core.map(message["meta"])
        // A finished call is a line of its own, not a message of anyone's.
        val own = Core.map(meta?.get("action"))
        if (own != null && own["type"] as? String == "call") {
          if (own["step"] == "end") calls[key] = own // ChatsPlus: «Перезвонить»
          // Calls: the row names the direction («Исходящий звонок · 3:12»), as the reference's chat does.
          val words = Core.view("callServiceText", listOf(own, sender, input.userId)) as? String ?: Core.view("chatListText", listOf(message)) as? String ?: (message["text"] as? String ?: "")
          rows.add(linkedMapOf("key" to key, "kind" to 1, "text" to (if (clock.isEmpty()) words else "$words · $clock")))
          return@forEachIndexed
        }
        val next = messages.getOrNull(index + 1)
        var tail = true
        if (next != null && action(next) == null && next["senderId"] as? String == sender) {
          val nextDate = Messenger.date(next["createdAt"] as? String)
          if (nextDate != null && date != null) {
            tail = Messenger.dayWords(nextDate, input.now, input.zone) != today || nextDate.toEpochMilli() - date.toEpochMilli() >= 5 * 60 * 1000
          }
        }
        // Bold, links, spoilers and the rest: the text and its runs as the core lays them out.
        var body = message["text"] as? String ?: ""
        var fmt = emptyList<Int>()
        var urls = emptyList<String>()
        val laid = Messenger.laidOut(body, meta?.get("entities"))
        val text = laid?.get("text") as? String
        if (!text.isNullOrEmpty()) {
          body = text
          fmt = (laid["fmt"] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() }
          urls = (laid["urls"] as? List<*>).orEmpty().mapNotNull { it as? String }
        }
        val state = message["localState"] as? String ?: ""
        val ticks = if (state == "failed") 4 else if (state == "sending") 3 else if (mine) (if (input.peerLastRead >= id) 2 else 1) else 0
        val chips = ArrayList<String>()
        for (reaction in (message["reactions"] as? List<*>).orEmpty().mapNotNull { Core.map(it) }) {
          chips.add(reaction["emoji"] as? String ?: "")
          chips.add(maxOf(1L, number(reaction["count"])).toString())
          chips.add(if (reaction["mine"] == true) "1" else "0")
        }
        val row = linkedMapOf<String, Any?>("key" to key, "kind" to 0, "mine" to mine, "text" to body, "fmt" to fmt, "urls" to urls,
          "time" to ((if (message["edited"] == true) "изм. " else "") + clock), "ticks" to ticks, "tail" to tail, "chips" to chips)
        val reply = Core.map(meta?.get("reply"))
        val story = Core.map(meta?.get("story"))
        if (reply != null) {
          row["quoteAuthor"] = if (reply["senderId"] as? String == input.userId) "Ты" else input.peerName
          row["quoteText"] = quoteText((reply["clientId"] as? String)?.let { byClient[it] }, reply["preview"] as? String ?: "")
        } else if (story != null) {
          row["quoteAuthor"] = if (story["ownerId"] as? String == input.userId) "Ты" else input.peerName
          row["quoteText"] = "История"
        }
        val forward = Core.map(meta?.get("forward"))
        if (forward != null) {
          val from = forward["from"] as? String ?: ""
          row["forward"] = if (from.isEmpty()) "Пересланное сообщение" else "Переслано от $from"
        }
        // Attachments: a photo's small picture or a file's name and size (attachments/AttachmentOpen.kt).
        if (Core.map(message["attachment"] as? Map<*, *>) != null) row.putAll(AttachmentRows.fields(message, key))
        else if (meta?.get("poll") != null) {
          // Polls: the poll itself (polls/PollRow.kt); its text is only for clients without polls.
          val usable = state.isEmpty() && message["cryptoState"] as? String == "decrypted" && input.selection == null
          val poll = com.linea.messenger.polls.PollRows.fields(message, input.pollDrafts[key] ?: emptyList(), disabled = !usable)
          if (poll != null) { row["poll"] = poll; row["text"] = ""; row["fmt"] = emptyList<Int>(); row["urls"] = emptyList<String>() } else row["label"] = "Опрос"
        }
        // Composer: «без звука» on own messages; 1–3 emoji alone are drawn large.
        if (mine && meta?.get("silent") == true) row["silent"] = true
        if (Core.map(message["attachment"] as? Map<*, *>) == null && meta?.get("poll") == null) {
          val count = com.linea.messenger.composer.BigEmoji.count(body)
          if (count > 0) row["bigEmoji"] = count
        }
        // LinkPreview: the card of a link, as it came inside the message (linkpreview/LinkCard.kt).
        Core.map(message["linkPreview"] as? Map<*, *>)?.let { row["card"] = it }
        input.selection?.let { row["checked"] = if (it.contains(key)) 1 else 0 }
        if (input.needle.isNotEmpty()) found += 1
        rows.add(row)
        shownMessages[key] = message
        keyOfClient[client] = key
        order.add(key)
      }
      return Shown(rows, shownMessages, keyOfClient, order, pinned, noCopy, newestTheirs, noKey, failedActions, ttl, calls = calls, found = found)
    }
  }
}
