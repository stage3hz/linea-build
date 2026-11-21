package com.linea.messenger.chatactions

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.chats.ChatListView
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Server
import com.linea.messenger.people.RoundIconButton
import com.linea.messenger.people.pages
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Locale

/** What a person does with the chats in their list (the reference's ChatListScreen.tsx and listSwipes.ts): the
 *  buttons behind a row — read / not read and pin on one side, archive, delete and sound on the other — the same
 *  choices by a long press, «Архив» above the first chat, the draft and «Печатает…» in a row's line, and the
 *  search by name and, in the history kept on this device, by the text of messages.
 *
 *  The list's screen hands its views over in `install` and the chats in `show`; the rows come back through
 *  `onRows`. Main thread only. */
class ChatListActions(private val context: Context, private val messenger: Messenger?) {
  /** A message found by its text in the history kept on this device. */
  class Hit(val chatId: String, val clientId: String, val text: String, val sentAt: String)

  /** One chat of the list: what the server said of it, as it is held here (changed at once by what the person
   *  does; the server's word follows). */
  class Chat(val id: String, val peerId: String, val title: String, val peerLastRead: Long, val row: Map<String, Any?>, val chat: Map<String, Any?>, val last: Map<String, Any?>) {
    constructor(summary: Messenger.ChatSummary) : this(summary.id, summary.peerId, summary.title, summary.peerLastRead, summary.row, summary.chat, summary.last)
    fun with(fields: Map<String, Any?>) = Chat(id, peerId, title, peerLastRead, row, fields, last)
  }

  /** The line shown for a chat whose last message is not one to show, with the id of that last message. */
  class Fill(val lastId: Long, val line: String)

  /** Everything the rows are made from, taken at one moment. */
  class State(
    val chats: List<Chat>, val userId: String?, val archiveOpen: Boolean = false, val query: String = "", val hits: List<Hit> = emptyList(),
    val searchingHistory: Boolean = false, val fills: Map<String, Fill> = emptyMap(), val hidden: Set<String> = emptySet(),
    val removed: (Chat) -> Boolean = { false }, val marked: (String) -> Boolean = { false }, val draft: (String) -> String = { "" },
    val typing: (String) -> Boolean = { false }, val now: Instant = Instant.now(), val zone: ZoneId = ZoneId.systemDefault(),
  )

  /** What `rows` made: the rows, the words for an empty list, the heading, and whether «Архив» stays open. */
  class Made(val rows: List<Map<String, Any?>>, val emptyWords: String, val heading: String, val archiveOpen: Boolean)

  private val local: ChatLocal? = messenger?.let { ChatLocal.of(context, it) }
  private val main = Handler(Looper.getMainLooper())
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var host: ViewGroup? = null
  private var chats: List<Chat> = emptyList()
  private var archiveOpen = false
  private var query = ""
  private var hits: List<Hit> = emptyList()
  private var searchRun = 0
  private var searchSoon: Runnable? = null
  private var searchingHistory = false
  private var fills: Map<String, Fill> = emptyMap()
  private val asked = HashSet<String>()
  /** The sample list's own marks and drafts (no account, nothing is kept). */
  private val sampleMarked = HashSet<String>()
  private val sampleDrafts = HashMap<String, String>()
  private var demoDone = false
  private var attached = false

  private val searchButton = RoundIconButton(context, "search", RoundIconButton.Look.SOFT, 18f)
  private val searchBox = FrameLayout(context)
  private val searchField = EditText(context)
  private val searchClose = ChatIconView(context, "xmark", 13f, Theme.muted)
  var searching = false
    private set

  /** The rows to show, and the words for an empty list. */
  var onRows: ((List<ChatRow>, String) -> Unit)? = null
  /** The screen's heading: «Чаты» or «Архив». */
  var onHeading: ((String) -> Unit)? = null
  /** The chats should be read from the server again. */
  var onReload: (() -> Unit)? = null

  private val localWatcher: (String?) -> Unit = { refresh() }

  // Setting up

  fun install(host: ViewGroup, list: ChatListView) {
    this.host = host
    list.onRowAction = { id, action -> act(id, action) }
    list.onRowLongPress = { id, _ -> openMenu(id) }
    searchButton.contentDescription = "Поиск"
    searchButton.setOnClickListener { toggleSearch() }
    host.addView(searchButton)
    searchBox.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 20f * d }
    searchBox.visibility = View.GONE
    host.addView(searchBox)
    searchBox.addView(ChatIconView(context, "search", 17f, Theme.muted), FrameLayout.LayoutParams(dp(32f), dp(40f)).apply { leftMargin = dp(6f) })
    searchField.hint = "Поиск"
    searchField.setHintTextColor(Theme.muted)
    searchField.setTextColor(Theme.text)
    searchField.textSize = 16f
    searchField.background = null
    searchField.setPadding(0, 0, 0, 0)
    searchField.maxLines = 1
    searchField.isSingleLine = true
    searchField.gravity = Gravity.CENTER_VERTICAL
    searchField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    searchField.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    searchField.contentDescription = "Поиск"
    searchField.setOnEditorActionListener { _, _, _ -> hideKeyboard(); true }
    searchField.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(text: Editable?) { if (searching) setQuery(text?.toString() ?: "") }
    })
    searchBox.addView(searchField, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply { leftMargin = dp(40f); rightMargin = dp(40f) })
    searchClose.isClickable = true
    searchClose.isFocusable = true
    searchClose.contentDescription = "Закрыть поиск"
    searchClose.setOnClickListener { toggleSearch() }
    searchBox.addView(searchClose, FrameLayout.LayoutParams(dp(40f), dp(40f), Gravity.END))
  }

  /** The list's screen is in the window: drafts, marks and «Печатает…» are followed. */
  fun attached() {
    if (attached) return
    attached = true
    ChatLocal.changed.watch(localWatcher)
    ChatTyping.changed.watch(localWatcher)
  }

  fun detached() {
    if (!attached) return
    attached = false
    ChatLocal.changed.unwatch(localWatcher)
    ChatTyping.changed.unwatch(localWatcher)
    searchSoon?.let { main.removeCallbacks(it) }
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** Places the search button beside «Новый чат» and the search field under the heading (`below`: where the
   *  heading ends, px). Gives the room the list must leave at the top. */
  fun place(width: Int, safeTop: Int, below: Int): Int {
    put(searchButton, width - dp(20f) - dp(40f) - dp(8f) - dp(40f), safeTop + dp(8f), dp(40f), dp(40f))
    if (!searching) return below
    put(searchBox, dp(16f), below, width - dp(32f), dp(40f))
    return below + dp(48f)
  }

  // The chats

  /** The chats as the server lists them now. */
  fun show(list: List<Messenger.ChatSummary>) = showChats(list.map { Chat(it) })

  private fun showChats(list: List<Chat>) {
    chats = list
    refresh()
    fillQuiet()
    if (ChatActionsDemo.present) demoAct()
  }

  private fun marked(chatId: String): Boolean = local?.isMarked(chatId) ?: sampleMarked.contains(chatId)
  private fun removed(chat: Chat): Boolean = local?.isRemoved(chat.id, lastId(chat)) ?: false

  private fun refresh() {
    val made = rows(State(chats, messenger?.userId, archiveOpen, query, hits, searchingHistory, fills, local?.hiddenKeys?.toSet() ?: emptySet(),
      removed = { removed(it) }, marked = { marked(it) }, draft = { local?.draft(it) ?: sampleDrafts[it] ?: "" }, typing = { ChatTyping.isTyping(it) }))
    archiveOpen = made.archiveOpen
    onHeading?.invoke(made.heading)
    onRows?.invoke(ChatRow.parse(made.rows), made.emptyWords)
  }

  /** For chats whose last message is a reaction, an edit, a deletion (or is hidden on this device), the line
   *  to show is looked up in the history kept here — the newest message that is one to show (the core's
   *  `listPreviewMessage`). The server cannot do it: to the server they are all the same ciphertext. */
  private fun fillQuiet() {
    val messenger = messenger ?: return
    val local = local ?: return
    val hidden = local.hiddenKeys.toSet()
    class Ask(val id: String, val lastId: Long, val title: String)
    val asks = ArrayList<Ask>()
    for (chat in chats) {
      if (chat.last.isEmpty()) continue
      val last = lastId(chat)
      if (!skipped(chat.last) && !hidden.contains(ChatHistory.key(chat.last))) continue
      if (!asked.add(chat.id + ":" + last)) continue
      asks.add(Ask(chat.id, last, chat.title))
    }
    if (asks.isEmpty()) return
    val me = messenger.userId
    messenger.crypto.run({ crypto: CryptoService ->
      val lines = HashMap<String, String>()
      for (chat in asks) {
        val kept = (crypto.callNow("history", listOf(chat.id, 120)).getOrNull() as? List<*> ?: continue).mapNotNull { Core.map(it) }
        val line = Core.map(Core.view("listPreviewMessage", listOf(numbered(kept, hidden)))) ?: continue
        var words = (Core.view("chatListText", listOf(line)) as? String).orEmpty().ifEmpty { Messenger.previewText(line) }
        if (isPin(line)) words = pinLine(words, line["senderId"] as? String == me, chat.title)
        lines[chat.id] = words
      }
      lines
    }, { lines ->
      val next = HashMap(fills)
      for (chat in asks) lines[chat.id]?.let { next[chat.id] = Fill(chat.lastId, it) }
      fills = next
      refresh()
    })
  }

  // A touch on a row

  /** A row was touched. True when it was dealt with here; false leaves it to the screen (the sample chats). */
  fun pressed(id: String): Boolean {
    if (id == archiveRow) {
      archiveOpen = true
      refresh()
      return true
    }
    if (id == backRow) {
      archiveOpen = false
      refresh()
      return true
    }
    if (id.startsWith("msg|")) {
      val parts = id.split("|")
      if (parts.size == 3) open(parts[1], parts[2])
      return true
    }
    if (messenger == null) return false
    open(id, "")
    return true
  }

  /** Opens a chat; with `focus`, at that message. */
  fun open(chatId: String, focus: String, animated: Boolean = true) {
    val messenger = messenger ?: return
    val chat = chats.firstOrNull { it.id == chatId } ?: return
    val stack = host?.pages() ?: return
    val screen = ChatScreen(context, chat.title, messenger, chat.id, chat.peerId, chat.peerLastRead) { stack.pop() }
    screen.actions.opened(chat.chat)
    if (focus.isNotEmpty()) screen.actions.focus(focus)
    // Opening the chat reads it: the hand-made mark goes too.
    if (local?.isMarked(chat.id) == true) local.setMarked(chat.id, false)
    hideKeyboard()
    stack.push(screen, animated)
  }

  private fun hideKeyboard() {
    val host = host ?: return
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(host.windowToken, 0)
  }

  // What can be done with a chat

  /** A swipe button of a row. */
  private fun act(id: String, action: String) {
    val chat = chats.firstOrNull { it.id == id } ?: return
    host?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    when (action) {
      "read" -> read(chat)
      "unread" -> mark(chat, true)
      "pin", "unpin" -> change(chat, mapOf("pinned" to (action == "pin")))
      "mute", "unmute" -> askMute(chat)
      "delete" -> askRemove(chat)
      "archive", "unarchive" -> change(chat, mapOf("archived" to (action == "archive")))
    }
  }

  /** A long press: the same choices as a list. */
  private fun openMenu(id: String) {
    val chat = chats.firstOrNull { it.id == id } ?: return
    host?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    ChoiceSheet(context, chat.title, choices = menuChoices(unread(chat) > 0 || marked(chat.id), pinned(chat), muted(chat, Instant.now()), archived(chat)).map { (name, symbol, label) ->
      ChoiceSheet.Choice(symbol, label, danger = name == "delete") {
        when (name) {
          "read" -> read(chat)
          "unread" -> mark(chat, true)
          "pin", "unpin" -> change(chat, mapOf("pinned" to (name == "pin")))
          "mute", "unmute" -> askMute(chat)
          "archive", "unarchive" -> change(chat, mapOf("archived" to (name == "archive")))
          // Rooms: «Выбрать» — mark several people and ring them all at once; that makes a room (rooms/RoomPicker.kt).
          "pick" -> com.linea.messenger.rooms.RoomPicker(context, messenger, chat.id).show()
          else -> askRemove(chat)
        }
      }
    }).show()
  }

  private fun say(words: String) = ChatAttachments.say(context, words)

  private fun mark(chat: Chat, on: Boolean) {
    if (local != null) {
      local.setMarked(chat.id, on)
    } else {
      if (on) sampleMarked.add(chat.id) else sampleMarked.remove(chat.id)
      refresh()
    }
  }

  /** «Прочитано»: read up to the newest message the server has (reactions and edits are messages too), and the
   *  hand-made mark goes. */
  private fun read(chat: Chat) {
    if (marked(chat.id)) mark(chat, false)
    if (unread(chat) > 0) {
      messenger?.markRead(chat.id, lastId(chat))
      patch(chat.id) { fields -> fields + ("unreadCount" to 0) }
    }
  }

  /** Changes the copy of a chat held here, so the row answers at once; the server's word follows. */
  private fun patch(chatId: String, change: (Map<String, Any?>) -> Map<String, Any?>) {
    if (chats.none { it.id == chatId }) return
    chats = chats.map { if (it.id == chatId) it.with(change(it.chat)) else it }
    refresh()
  }

  /** Pin, archive, sound: the chat's own settings on the server (they follow the account to its other devices). */
  private fun change(chat: Chat, update: Map<String, Any?>) {
    patch(chat.id) { fields -> fields + ("settings" to changed(Core.map(fields["settings"]) ?: emptyMap(), update, Instant.now())) }
    val messenger = messenger ?: return
    messenger.server.op("chatSettings", listOf(chat.id, update)) { result ->
      main.post {
        if (result.isFailure) say(Server.error(result).words.ifEmpty { "Не удалось изменить чат." })
        onReload?.invoke()
      }
    }
  }

  /** «Выключить звук»: a chat without sound gets it back in one touch; otherwise the sheet asks for how long. */
  private fun askMute(chat: Chat) {
    if (muted(chat, Instant.now())) {
      change(chat, mapOf("muted" to false))
      return
    }
    val now = Instant.now(); val zone = ZoneId.systemDefault()
    val choices = muteSpans.map { (label, seconds) ->
      ChoiceSheet.Choice("clock", label, "Без звука " + untilWords(now.plusSeconds(seconds), now, zone) + ".") {
        // Counted from the moment of the choice, not from the moment the sheet was opened.
        change(chat, mapOf("mutedUntil" to Instant.now().plusSeconds(seconds).truncatedTo(ChronoUnit.MILLIS).toString()))
      }
    } + ChoiceSheet.Choice("bell.slash", "Навсегда", "Пока не включишь снова. Звонки продолжат звонить.") { change(chat, mapOf("muted" to true)) }
    ChoiceSheet(context, "Выключить звук", chat.title, choices).show()
  }

  /** «Удалить чат?»: for me (this device) or for both (the server). */
  private fun askRemove(chat: Chat) {
    ChoiceSheet(context, "Удалить чат?", choices = listOf(
      ChoiceSheet.Choice("trash", "Удалить у меня", "Чат и загруженные сообщения исчезнут на этом устройстве. Если собеседник напишет снова, чат вернётся.", danger = true) { removeForMe(chat) },
      ChoiceSheet.Choice("person.2", "Удалить у меня и у собеседника", "Чат, все сообщения и файлы будут удалены на сервере и у обоих. Отменить нельзя.", danger = true) { removeForEveryone(chat) },
    )).show()
  }

  /** The chat leaves the list until a newer message comes; the messages kept here are hidden for good, and
   *  what the chat left in the private storage (its history names, its unsent messages) goes. */
  private fun removeForMe(chat: Chat) {
    val messenger = messenger
    if (messenger == null || local == null) {
      chats = chats.filter { it.id != chat.id }
      refresh()
      return
    }
    local.removeChat(chat.id, lastId(chat))
    refresh()
    val chatId = chat.id
    messenger.crypto.run({ crypto: CryptoService ->
      val keys = (crypto.callNow("history", listOf(chatId, 2000)).getOrNull() as? List<*>).orEmpty().mapNotNull { Core.map(it) }.map { ChatHistory.key(it) }
      crypto.callNow("forgetChat", listOf(chatId))
      keys
    }, { keys -> local.hide(keys) })
  }

  private fun removeForEveryone(chat: Chat) {
    val messenger = messenger
    if (messenger == null) {
      chats = chats.filter { it.id != chat.id }
      refresh()
      return
    }
    val chatId = chat.id
    messenger.server.op("deleteChatForEveryone", listOf(chatId)) { result ->
      main.post {
        if (result.isFailure) {
          say(Server.error(result).words.ifEmpty { "Не удалось удалить чат. Попробуй ещё раз." })
        } else {
          messenger.crypto.call("forgetChat", listOf(chatId)) { }
          chats = chats.filter { it.id != chatId }
          refresh()
          onReload?.invoke()
        }
      }
    }
  }

  // The search

  private fun toggleSearch() {
    searching = !searching
    searchBox.visibility = if (searching) View.VISIBLE else View.GONE
    if (searching) {
      searchField.requestFocus()
      (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(searchField, 0)
    } else {
      searchField.setText("")
      hideKeyboard()
      setQuery("")
    }
    host?.requestLayout()
  }

  private fun setQuery(text: String) {
    query = text
    hits = emptyList()
    searchRun += 1
    searchSoon?.let { main.removeCallbacks(it) }
    val wanted = text.trim(' ').lowercase()
    searchingHistory = wanted.length >= 2 && messenger != null
    refresh()
    if (!searchingHistory) return
    val run = searchRun
    val work = Runnable { searchHistory(wanted, run) }
    searchSoon = work
    main.postDelayed(work, 300)
  }

  /** Looks for the words in the decrypted history kept on this device (nothing is asked of the server: it has
   *  only ciphertext). Messages hidden here and the actions on messages are not results. */
  private fun searchHistory(wanted: String, run: Int) {
    val messenger = messenger ?: return
    val local = local ?: return
    if (run != searchRun) return
    val known = chats.filter { !removed(it) }.map { it.id }.toSet()
    val hidden = local.hiddenKeys.toSet()
    messenger.crypto.run({ crypto: CryptoService ->
      val found = ArrayList<Hit>()
      val ids = (crypto.callNow("historyChats").getOrNull() as? List<*>).orEmpty().mapNotNull { it as? String }
      for (chatId in ids) {
        if (!known.contains(chatId)) continue
        val kept = (crypto.callNow("history", listOf(chatId, 600)).getOrNull() as? List<*>).orEmpty().mapNotNull { Core.map(it) }
        found.addAll(found(chatId, kept, wanted, hidden))
      }
      found.sortedByDescending { it.sentAt }.take(60)
    }, { found ->
      if (run == searchRun) {
        searchingHistory = false
        hits = found
        refresh()
      }
    })
  }

  // The sample list (no account) and the emulator check

  /** The sample list: the same rows as before, as chats the actions can work on. */
  fun showSamples(rows: List<ChatRow>) {
    var part = ""
    showChats(rows.mapIndexed { index, row ->
      if (row.section.isNotEmpty()) part = row.section
      val settings = linkedMapOf<String, Any?>("muted" to row.muted, "archived" to false)
      if (row.pinned) settings["pinnedAt"] = "2026-11-20T09:00:00.000Z"
      val fields = mapOf<String, Any?>("id" to row.id, "title" to row.title, "preview" to row.preview, "time" to row.time, "unread" to row.unread, "muted" to row.muted, "pinned" to row.pinned,
        "ticks" to row.ticks, "avatarColor" to row.avatarColor, "initials" to row.initials, "orbA" to row.orbA, "orbB" to row.orbB, "section" to row.section, "previewIcon" to row.previewIcon)
      val chat = mapOf<String, Any?>("settings" to settings, "unreadCount" to row.unread, "sampleSection" to (if (part == "Закреплённые") "Сегодня" else part))
      Chat(row.id, "demo-person-$index", row.title, 0, fields, chat, emptyMap())
    })
  }

  /** What the emulator check asks of the list, once it has chats (with an account or with `--ez demo true`):
   *    --es chatlist menu|mute|delete|archive|archived|draft|unread     on the first chat (archive: on the last one)
   *    --es chatsearch <query>                                          the search field with these words */
  private fun demoAct() {
    if (demoDone) return
    val first = chats.firstOrNull() ?: return
    val last = chats.last()
    demoDone = true
    val wanted = ChatActionsDemo.chatsearch
    if (!wanted.isNullOrEmpty()) {
      main.postDelayed({
        if (!searching) toggleSearch()
        searchField.setText(wanted)
        hideKeyboard()
      }, 500)
      return
    }
    val ask = ChatActionsDemo.chatlist ?: return
    main.postDelayed({
      if (host?.isAttachedToWindow == true) when (ask) {
        "menu" -> openMenu(first.id)
        "mute" -> askMute(chats.firstOrNull { !muted(it, Instant.now()) } ?: first)
        "delete" -> askRemove(first)
        "unread" -> mark(last, true)
        "archive", "archived" -> {
          if (!archived(last)) change(last, mapOf("archived" to true))
          if (ask == "archived") {
            archiveOpen = true
            refresh()
          }
        }
        "draft" -> if (local != null) local.setDraft(first.id, ChatActionsDemo.draft) else {
          sampleDrafts[first.id] = ChatActionsDemo.draft
          refresh()
        }
      }
    }, 500)
  }

  companion object {
    const val archiveRow = "__archive"
    const val backRow = "__back"
    private const val draftWord = "Черновик:"
    private val swipeWords = mapOf("read" to "Прочитано", "unread" to "Не прочитано", "pin" to "Закрепить", "unpin" to "Открепить", "mute" to "Без звука",
      "unmute" to "Со звуком", "delete" to "Удалить", "archive" to "В архив", "unarchive" to "Вернуть")
    val muteSpans: List<Pair<String, Long>> = listOf("На 1 час" to 3600L, "На 8 часов" to 8 * 3600L, "На 2 дня" to 2 * 86400L)
    private val months = listOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")
    private val blanks = Regex("[ \\n\\t]+")

    private fun settings(chat: Chat): Map<String, Any?> = Core.map(chat.chat["settings"]) ?: emptyMap()
    fun lastId(chat: Chat): Long = ChatHistory.number(Core.map(chat.chat["lastMessage"])?.get("id"))
    fun archived(chat: Chat): Boolean = settings(chat)["archived"] as? Boolean ?: false
    fun pinned(chat: Chat): Boolean = settings(chat)["pinnedAt"] is String
    fun unread(chat: Chat): Int = ChatHistory.number(chat.chat["unreadCount"]).toInt()

    /** The sound is off: for good, or until a moment the clock has not reached (the reference's `isMuted`). */
    fun muted(chat: Chat, now: Instant): Boolean {
      val fields = settings(chat)
      if (fields["muted"] != true) return false
      val until = fields["mutedUntil"] as? String
      if (until.isNullOrEmpty()) return true
      val end = Messenger.date(until) ?: return true
      return end.isAfter(now)
    }

    /** The part of the list a chat stands in: pinned ones first, then by the day of the last message. */
    fun section(chat: Chat, now: Instant, zone: ZoneId): String {
      if (pinned(chat)) return "Закреплённые"
      (chat.chat["sampleSection"] as? String)?.let { return it }
      val at = Messenger.date(Core.map(chat.chat["lastMessage"])?.get("createdAt") as? String) ?: return "Раньше"
      val days = ChronoUnit.DAYS.between(at.atZone(zone).toLocalDate(), now.atZone(zone).toLocalDate())
      return if (days <= 0) "Сегодня" else if (days == 1L) "Вчера" else "Раньше"
    }

    fun plural(count: Int, one: String, few: String, many: String): String {
      val last = Math.abs(count) % 10; val tens = Math.abs(count) % 100
      if (last == 1 && tens != 11) return one
      if (last in 2..4 && (tens < 10 || tens >= 20)) return few
      return many
    }

    /** «Черновик: …» for a chat with unsent text. */
    fun draftLine(text: String): String {
      val typed = text.split(blanks).filter { it.isNotEmpty() }.joinToString(" ")
      return if (typed.isEmpty()) "" else draftWord + " " + typed.take(160)
    }

    /** «Вы закрепили «…»» / «Имя закрепил(а) «…»» for a pin (the reference's `pinPreview`). */
    fun pinLine(text: String, mine: Boolean, name: String): String {
      val trimmed = text.trim()
      val open = trimmed.indexOf('«')
      val quote = if (trimmed.endsWith("»") && open >= 0) trimmed.substring(open) else ""
      return (if (mine) "Вы закрепили" else "$name закрепил(а)") + (if (quote.isEmpty()) " сообщение" else " $quote")
    }

    fun isPin(message: Map<String, Any?>): Boolean {
      val action = ChatHistory.action(message) ?: return false
      return action["type"] as? String == "pin" && action["target"] is String
    }

    /** A message the list looks past for the line to show (the reference's `skippedInList`): an action on
     *  another message, or a call's signalling. */
    fun skipped(message: Map<String, Any?>): Boolean {
      val action = ChatHistory.action(message) ?: return false
      return when (action["type"] as? String ?: return false) {
        "react", "vote", "edit", "delete" -> true
        "pin" -> action["target"] !is String
        "call" -> action["step"] as? String != "end"
        else -> false
      }
    }

    /** The settings of a chat as they will be after a change (shown at once, before the server's word). */
    fun changed(settings: Map<String, Any?>, update: Map<String, Any?>, now: Instant): Map<String, Any?> {
      val kept = LinkedHashMap(settings)
      (update["pinned"] as? Boolean)?.let { kept["pinnedAt"] = if (it) now.toString() else null }
      (update["archived"] as? Boolean)?.let { kept["archived"] = it }
      (update["muted"] as? Boolean)?.let { kept["muted"] = it; kept["mutedUntil"] = null }
      (update["mutedUntil"] as? String)?.let { kept["muted"] = true; kept["mutedUntil"] = it }
      return kept
    }

    /** «до 18:30», «до завтра, 09:15», «до 12 марта, 09:15» — when the sound comes back (the reference's `muteUntilLabel`). */
    fun untilWords(end: Instant, now: Instant, zone: ZoneId): String {
      val parts = end.atZone(zone); val today = now.atZone(zone).toLocalDate()
      val time = String.format(Locale.ROOT, "%02d:%02d", parts.hour, parts.minute)
      if (parts.toLocalDate() == today) return "до $time"
      if (parts.toLocalDate() == today.plusDays(1)) return "до завтра, $time"
      val year = if (parts.year == today.year) "" else " ${parts.year}"
      return "до ${parts.dayOfMonth} ${months[parts.monthValue - 1]}$year, $time"
    }

    /** What a long press on a chat offers: (what it does, its picture, its words). */
    fun menuChoices(unread: Boolean, pinned: Boolean, muted: Boolean, archived: Boolean): List<Triple<String, String, String>> = listOf(
      if (unread) Triple("read", "bubble", "Пометить как прочитанное") else Triple("unread", "bubble.fill", "Пометить как непрочитанное"),
      if (pinned) Triple("unpin", "pin.slash", "Открепить") else Triple("pin", "pin", "Закрепить"),
      if (muted) Triple("unmute", "bell", "Включить звук") else Triple("mute", "bell.slash", "Выключить звук"),
      if (archived) Triple("unarchive", "archive", "Вернуть из архива") else Triple("archive", "archive", "В архив"),
      Triple("pick", "check.circle", "Выбрать"),
      Triple("delete", "trash", "Удалить чат"),
    )

    /** The line of a found message: the words around the place where the query stands. */
    fun snippet(text: String, wanted: String): String {
      val flat = text.split('\n', '\t').filter { it.isNotEmpty() }.joinToString(" ")
      // Looked for without regard to case, in the text itself: its places are then the text's own.
      val before = if (wanted.isEmpty()) -1 else flat.indexOf(wanted, ignoreCase = true)
      if (before <= 24) return flat.take(160)
      return "…" + flat.drop(before - 16).take(160)
    }

    /** The messages of one chat's kept history that hold the words: not the hidden ones, not the actions. */
    fun found(chatId: String, kept: List<Map<String, Any?>>, wanted: String, hidden: Set<String>): List<Hit> = kept.mapNotNull { item ->
      val text = item["text"] as? String
      val clientId = item["clientId"] as? String
      if (text.isNullOrEmpty() || clientId == null || ChatHistory.action(item) != null || !text.lowercase().contains(wanted) || hidden.contains(ChatHistory.key(item))) null
      else Hit(chatId, clientId, text, item["sentAt"] as? String ?: "")
    }

    /** The kept history of a chat (newest first, as the storage gives it) without what is hidden here, numbered
     *  so that the core reads the same order. */
    fun numbered(kept: List<Map<String, Any?>>, hidden: Set<String>): List<Map<String, Any?>> = kept.mapIndexedNotNull { index, item ->
      if (hidden.contains(ChatHistory.key(item))) null else {
        val message = LinkedHashMap(item)
        message["id"] = kept.size - index
        if (message["createdAt"] == null) (item["sentAt"] as? String)?.let { message["createdAt"] = it }
        message
      }
    }

    private fun special(id: String, title: String, preview: String, initials: String): Map<String, Any?> =
      mapOf("id" to id, "title" to title, "preview" to preview, "time" to "", "unread" to 0, "initials" to initials, "avatarColor" to 0xFF161718.toInt(), "orbA" to 0, "orbB" to 0, "section" to "")

    /** The rows of the list for everything that is known at the moment. */
    fun rows(state: State): Made {
      val visible = state.chats.filter { !state.removed(it) }
      val archivedCount = visible.count { archived(it) }
      val inArchive = state.archiveOpen && archivedCount > 0
      val wanted = state.query.trim(' ').lowercase()
      var shown = visible.filter { archived(it) == inArchive }
      if (wanted.isNotEmpty()) {
        shown = shown.filter { chat ->
          val username = Core.map(chat.chat["peer"])?.get("username") as? String ?: ""
          (chat.title + " " + username).lowercase().contains(wanted)
        }
      }
      val rows = ArrayList<Map<String, Any?>>()
      if (inArchive) {
        rows.add(special(backRow, "‹ Архив", "Вернуться к чатам", "‹"))
      } else if (archivedCount > 0 && wanted.isEmpty()) {
        rows.add(special(archiveRow, "Архив", "$archivedCount " + plural(archivedCount, "чат", "чата", "чатов"), "▤"))
      }
      var part = ""
      for (chat in shown) {
        val row = LinkedHashMap(chat.row)
        val quiet = muted(chat, state.now)
        val isPinned = pinned(chat)
        val count = unread(chat)
        val isMarked = state.marked(chat.id)
        row["muted"] = quiet
        row["pinned"] = isPinned
        // Avatars: the title may carry the person's status emoji (avatars/ChatListDecor.kt).
        row["title"] = (chat.row["title"] as? String ?: chat.title) + (if (quiet) " 🔕" else "")
        row["unread"] = if (count > 0) count else if (isMarked) 1 else 0
        val draft = draftLine(state.draft(chat.id))
        // Offline: the quiet look belongs to the line of a message that cannot be opened here, nothing else.
        if (state.typing(chat.id) || draft.isNotEmpty() || state.fills[chat.id] != null) row["quietPreview"] = false
        if (state.typing(chat.id)) {
          row["preview"] = "Печатает…"
          row["accentPreview"] = true
          row["previewIcon"] = ""
        } else if (draft.isNotEmpty()) {
          row["preview"] = draft
          row["previewRed"] = draftWord.length
          row["previewIcon"] = ""
        } else if (chat.last.isNotEmpty()) {
          val mine = chat.last["senderId"] as? String == state.userId
          val fill = state.fills[chat.id]
          if (fill != null && fill.lastId == lastId(chat)) {
            row["preview"] = fill.line
          } else if (skipped(chat.last) || state.hidden.contains(ChatHistory.key(chat.last))) {
            // Until the line to show is found: nothing, never the hidden text.
            row["preview"] = ""
          } else if (isPin(chat.last)) {
            row["preview"] = pinLine(chat.last["text"] as? String ?: "", mine, chat.title)
          }
        }
        // The buttons behind the row (the reference's `rowActions`): the outermost first.
        val lead = listOf(if (count > 0 || isMarked) "read" else "unread", if (isPinned) "unpin" else "pin")
        val trail = listOf(if (inArchive) "unarchive" else "archive", "delete", if (quiet) "unmute" else "mute")
        row["lead"] = lead.map { it + ":" + (swipeWords[it] ?: it) }
        row["trail"] = trail.map { it + ":" + (swipeWords[it] ?: it) }
        val own = if (inArchive || wanted.isNotEmpty()) "" else section(chat, state.now, state.zone)
        row["section"] = if (own != part) own else ""
        part = own
        rows.add(row)
      }
      // «Сообщения»: what the history kept on this device holds, newest first; a touch opens the chat at that message.
      var firstHit = true
      for (hit in state.hits) {
        val chat = state.chats.firstOrNull { it.id == hit.chatId } ?: continue
        val row = LinkedHashMap(chat.row)
        row["id"] = "msg|" + hit.chatId + "|" + hit.clientId
        row["preview"] = snippet(hit.text, wanted)
        row["time"] = Messenger.listTime(hit.sentAt, state.now, state.zone)
        row["section"] = if (firstHit) "Сообщения" else ""
        firstHit = false
        row["unread"] = 0
        row["ticks"] = 0
        row["pinned"] = false
        row["muted"] = false
        row["previewIcon"] = ""
        row["thumb"] = ""
        rows.add(row)
      }
      val words = if (wanted.isEmpty()) "Пока нет чатов" else if (state.searchingHistory) "Поиск…" else "Ничего не нашли."
      return Made(rows, words, if (inArchive) "Архив" else "Чаты", inArchive)
    }
  }
}
