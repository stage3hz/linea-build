package com.linea.messenger.chatactions

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.net.Live
import java.lang.ref.WeakReference

/** «печатает…»: who is typing in which chat right now, as the live line says it. Main thread only.
 *  The reference keeps the mark for five seconds after the last event (useMessenger.ts, `typing`). */
object ChatTyping {
  /** Posted on the main thread when somebody started or stopped typing: the chat's id. */
  val changed = Live.Signal<String?>()
  private val until = HashMap<String, Long>()
  private val main by lazy { Handler(Looper.getMainLooper()) }

  fun heard(chatId: String, on: Boolean) {
    if (on) until[chatId] = SystemClock.elapsedRealtime() + 5000 else until.remove(chatId)
    changed.post(chatId)
    if (!on) return
    main.postDelayed({
      val end = until[chatId]
      if (end != null && end <= SystemClock.elapsedRealtime()) {
        until.remove(chatId)
        changed.post(chatId)
      }
    }, 5100)
  }

  fun isTyping(chatId: String): Boolean {
    val end = until[chatId] ?: return false
    return end > SystemClock.elapsedRealtime()
  }
}

/** What one account keeps about its chats on this device only:
 *  - messages deleted «у меня» (their `senderId:clientId` names, never their text);
 *  - chats deleted «у меня» (the id of the last message each had then: a newer message brings the chat back);
 *  - chats marked as unread by hand;
 *  - the unsent text of every chat («Черновик»), kept in the encrypted storage under `drafts:v1`, as the
 *    reference keeps it (useMessenger.ts).
 *  The first three are names and numbers only and live in the app's own settings, as in the reference. */
class ChatLocal private constructor(context: Context, private val userId: String) {
  private val store: SharedPreferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  private var crypto: WeakReference<CryptoService>? = null
  private val lock = Any()
  private var hiddenList: List<String> = emptyList()
  private val removedAt = HashMap<String, Long>()
  private var markedList: List<String> = emptyList()
  private var draftTexts = HashMap<String, String>()
  private var draftsLoaded = false
  private val main = Handler(Looper.getMainLooper())
  private val saving = Runnable { saveDrafts() }

  private val hiddenName get() = "invizent.hidden.v1:$userId"
  private val removedName get() = "invizent.removed-chats.v1:$userId"
  private val markedName get() = "invizent.marked-unread.v1:$userId"

  init {
    hiddenList = names(store.getString(hiddenName, null))
    markedList = names(store.getString(markedName, null))
    for ((chatId, value) in Core.map(Core.value(store.getString(removedName, null))).orEmpty()) {
      (value as? Number)?.let { removedAt[chatId] = it.toLong() }
    }
  }

  /** Takes the account's encryption (its private storage) and reads the drafts kept there. */
  private fun attach(service: CryptoService) {
    crypto = WeakReference(service)
    synchronized(lock) { draftsLoaded = false }
    service.call("loadLocal", listOf("drafts:v1")) { result ->
      val kept = HashMap(readDrafts(result.getOrNull() as? String))
      val typedBefore: Boolean
      synchronized(lock) {
        // What was typed before the saved drafts were read wins over them (and is written now that it can be).
        typedBefore = draftTexts.isNotEmpty()
        kept.putAll(draftTexts)
        draftTexts = kept
        draftsLoaded = true
      }
      if (typedBefore) saveDrafts()
      changed.post(null)
    }
  }

  // Messages deleted «у меня»

  /** The names (`senderId:clientId`) of the messages hidden on this device. */
  val hiddenKeys: List<String> get() = synchronized(lock) { hiddenList }

  fun hide(keys: List<String>) {
    if (keys.isEmpty()) return
    val list = synchronized(lock) {
      hiddenList = hidden(hiddenList, keys)
      hiddenList
    }
    store.edit().putString(hiddenName, Core.text(list)).apply()
  }

  // Chats deleted «у меня»

  /** The chat stays out of the list until a message newer than `lastMessageId` comes. */
  fun removeChat(chatId: String, lastMessageId: Long) {
    val kept = synchronized(lock) {
      removedAt[chatId] = lastMessageId
      HashMap<String, Any?>(removedAt)
    }
    store.edit().putString(removedName, Core.text(kept)).apply()
    changed.post(null)
  }

  fun isRemoved(chatId: String, lastMessageId: Long): Boolean = synchronized(lock) {
    val at = removedAt[chatId] ?: return false
    lastMessageId <= at
  }

  // Marked as unread

  fun isMarked(chatId: String): Boolean = synchronized(lock) { markedList.contains(chatId) }

  fun setMarked(chatId: String, on: Boolean) {
    val list = synchronized(lock) {
      markedList = (markedList.filter { it != chatId } + (if (on) listOf(chatId) else emptyList())).takeLast(MARKED_LIMIT)
      markedList
    }
    store.edit().putString(markedName, Core.text(list)).apply()
    changed.post(null)
  }

  // Drafts

  fun draft(chatId: String): String = synchronized(lock) { draftTexts[chatId] ?: "" }

  /** Remembers the unsent text of a chat; it is written to the encrypted storage a moment after typing stops.
   *  Main thread only. */
  fun setDraft(chatId: String, text: String) {
    val same = synchronized(lock) {
      val same = (draftTexts[chatId] ?: "") == text
      if (!same) draftTexts[chatId] = text
      same
    }
    if (same) return
    main.removeCallbacks(saving)
    main.postDelayed(saving, 700)
    changed.post(chatId)
  }

  private fun saveDrafts() {
    val loaded: Boolean
    val kept: Map<String, String>
    synchronized(lock) {
      loaded = draftsLoaded
      kept = draftsToKeep(draftTexts)
    }
    // Before the saved drafts were read nothing is written: writing now would lose the ones not read yet.
    if (!loaded) return
    val json = Core.text(kept) ?: return
    crypto?.get()?.call("storeLocal", listOf("drafts:v1", json)) { }
  }

  companion object {
    /** Posted on the main thread when something here changed (the list of chats is drawn again). */
    val changed = Live.Signal<String?>()
    private const val PREFERENCES = "invizent.chat-local"
    private const val HIDDEN_LIMIT = 5000
    private const val MARKED_LIMIT = 500
    private val made = HashMap<String, ChatLocal>()

    /** The account's own keeper (one per account for as long as the app runs). */
    @Synchronized fun of(context: Context, messenger: Messenger): ChatLocal {
      val kept = made[messenger.userId]
      if (kept != null) {
        if (kept.crypto?.get() !== messenger.crypto) kept.attach(messenger.crypto)
        return kept
      }
      val fresh = ChatLocal(context, messenger.userId)
      made[messenger.userId] = fresh
      fresh.attach(messenger.crypto)
      return fresh
    }

    private fun names(text: String?): List<String> = (Core.value(text) as? List<*>).orEmpty().mapNotNull { it as? String }

    /** The hidden names with new ones added after them, each once; the oldest go when there are too many. */
    fun hidden(known: List<String>, added: List<String>, limit: Int = HIDDEN_LIMIT): List<String> {
      val seen = HashSet(known)
      val out = ArrayList(known)
      for (key in added) if (seen.add(key)) out.add(key)
      return if (out.size > limit) out.takeLast(limit) else out
    }

    /** The drafts as the encrypted storage gave them (`{chatId: text}` as JSON): only texts, each at most 8000 long. */
    fun readDrafts(raw: String?): Map<String, String> {
      val kept = LinkedHashMap<String, String>()
      for ((chatId, text) in Core.map(Core.value(raw)).orEmpty()) {
        if (text is String && text.isNotEmpty() && chatId.length <= 80) kept[chatId] = text.take(8000)
      }
      return kept
    }

    /** What is written: at most 200 chats, none with only spaces. */
    fun draftsToKeep(all: Map<String, String>): Map<String, String> {
      val kept = LinkedHashMap<String, String>()
      for ((chatId, text) in all) {
        if (kept.size >= 200) break
        if (text.isNotBlank()) kept[chatId] = text
      }
      return kept
    }
  }
}
