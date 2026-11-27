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

/** «печатает», «записывает голосовое», «отправляет видео»…: what the people of each chat are doing right now, as
 *  the live line says it (`typing` events with their `kind`). Main thread only.
 *
 *  One action per person: a newer kind replaces the older one, an explicit stop clears everything that person was
 *  doing in the chat. The sender says it again every few seconds while it lasts (net/ActivitySend.kt); a mark not
 *  heard again for `HOLD` ms goes by itself, so a lost stop never sticks. */
object ChatTyping {
  /** How long a mark lasts without being heard again, ms (the sender repeats it every 4 s). */
  const val HOLD = 6000L
  /** Posted on the main thread when somebody started or stopped: the chat's id. */
  val changed = Live.Signal<String?>()
  /** Tests: the clock the marks are timed by. */
  var clock: () -> Long = { SystemClock.elapsedRealtime() }
  /** Tests: where the expiry is waited for; null — the main thread. */
  var timer: Handler? = null

  private class Mark(val kind: String, val since: Long, val until: Long)
  /** chat → person → what they do. */
  private val active = HashMap<String, LinkedHashMap<String, Mark>>()
  private val main by lazy { Handler(Looper.getMainLooper()) }

  fun heard(chatId: String, userId: String, kind: String, on: Boolean) {
    val now = clock()
    if (!on) {
      val people = active[chatId] ?: return
      if (people.remove(userId) == null) return
      if (people.isEmpty()) active.remove(chatId)
      changed.post(chatId)
      return
    }
    val known = ChatActivityWords.known(kind)
    val people = active.getOrPut(chatId) { LinkedHashMap() }
    val before = people[userId]
    // The same action heard again only moves its end; a new one starts now (the newest is said first).
    people[userId] = Mark(known, if (before != null && before.kind == known) before.since else now, now + HOLD)
    if (before == null || before.kind != known) changed.post(chatId)
    (timer ?: main).postDelayed({ expire(chatId) }, HOLD + 100)
  }

  /** Drops the marks of a chat that were not heard again in time. */
  fun expire(chatId: String) {
    val people = active[chatId] ?: return
    val now = clock()
    if (!people.values.removeAll { it.until <= now }) return
    if (people.isEmpty()) active.remove(chatId)
    changed.post(chatId)
  }

  fun isTyping(chatId: String): Boolean = who(chatId).isNotEmpty()

  /** Who does what in a chat now, the newest action first: (person, kind). */
  fun who(chatId: String): List<Pair<String, String>> {
    val now = clock()
    // Newest first; heard in the same moment, the one heard later comes first (the sort keeps that order).
    return active[chatId].orEmpty().entries.toList().asReversed().filter { it.value.until > now }.sortedByDescending { it.value.since }.map { it.key to it.value.kind }
  }

  /** The words for a chat, without the dots («печатает», «Аня и Лев печатают»); null — nobody does anything.
   *  `name`: a person's name, for a group. */
  fun words(chatId: String, group: Boolean, name: (String) -> String?): String? =
    ChatActivityWords.label(who(chatId).map { (userId, kind) -> name(userId) to kind }, group)

  /** Tests and the account's end: forgets everything. */
  fun clear() { active.clear(); changed.post(null) }
}

/** The words of what people are doing in a chat. The app's own lines carry no emoji. */
object ChatActivityWords {
  /** kind → (one person, several people). */
  private val verbs = linkedMapOf(
    "typing" to ("печатает" to "печатают"),
    "voice" to ("записывает голосовое" to "записывают голосовое"),
    "round" to ("записывает видеосообщение" to "записывают видеосообщение"),
    "video" to ("отправляет видео" to "отправляют видео"),
    "photo" to ("отправляет фото" to "отправляют фото"),
    "file" to ("отправляет файл" to "отправляют файл"),
    "voice-upload" to ("отправляет голосовое" to "отправляют голосовое"),
    "round-upload" to ("отправляет видеосообщение" to "отправляют видеосообщение"),
  )
  val kinds: Set<String> get() = verbs.keys

  /** A kind this app knows, else plain typing (an unknown or missing kind from another version). */
  fun known(kind: String?): String = if (kind != null && verbs.containsKey(kind)) kind else "typing"

  /** `people`: (name, kind), the newest action first. One to one: just the action of the other person. In a group:
   *  the people doing what the newest one does — «Аня печатает», «Аня и Лев печатают», «3 человека печатают». */
  fun label(people: List<Pair<String?, String>>, group: Boolean): String? {
    val first = people.firstOrNull() ?: return null
    val kind = known(first.second)
    val (one, many) = verbs.getValue(kind)
    if (!group) return one
    val doing = people.filter { known(it.second) == kind }
    val names = doing.map { it.first?.trim().orEmpty() }
    return when {
      doing.size == 1 -> if (names[0].isEmpty()) one.replaceFirstChar { it.uppercase() } else "${names[0]} $one"
      doing.size == 2 && names.none { it.isEmpty() } -> "${names[0]} и ${names[1]} $many"
      else -> "${doing.size} ${people(doing.size)} $many"
    }
  }

  /** 2 человека, 5 человек, 21 человек, 22 человека. */
  fun people(count: Int): String {
    val tens = count % 100
    val last = count % 10
    return if (last in 2..4 && tens !in 12..14) "человека" else "человек"
  }

  /** The start of a chat row's line: the same words with a capital letter. */
  fun line(words: String): String = words.replaceFirstChar { it.uppercase() }

  /** How many of the three dots after the words are lit at `ms` (0…3, a step every 350 ms). */
  fun dots(ms: Long): Int = ((ms / 350) % 4).toInt()
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

/** The words of what someone is doing with three dots after them, `lit` of them shown (the others take their room,
 *  so the line does not move while they blink). */
fun activityDotted(words: String, lit: Int): CharSequence {
  val said = com.linea.messenger.language.Language.tr(words)
  val text = android.text.SpannableString("$said...")
  val from = said.length + lit.coerceIn(0, 3)
  if (from < text.length) text.setSpan(android.text.style.ForegroundColorSpan(0), from, text.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  return text
}
