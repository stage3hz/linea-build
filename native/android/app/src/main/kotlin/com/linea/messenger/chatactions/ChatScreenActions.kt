package com.linea.messenger.chatactions

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.chat.MsgListView
import com.linea.messenger.core.Core
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Live
import com.linea.messenger.people.PresenceWords
import com.linea.messenger.people.pages

/** Everything a person does with the messages of one chat beyond reading and sending plain text (the reference's
 *  ChatScreen.tsx): the menu of a message with its reactions, answering, editing, copying, forwarding, pinning,
 *  deleting, choosing several; the bar above the field; the pinned message; «печатает…» and the status under the
 *  name; the unsent text kept as a draft; the way down; older pages while scrolling up.
 *
 *  The chat's screen owns its views and hands them over in `install`; this object owns what it adds to them.
 *  Main thread only. */
class ChatScreenActions(private val context: Context, private val messenger: Messenger?, private val chatId: String, private val peerId: String, private val peerName: String) {
  private var peerUsername = ""
  private val local: ChatLocal? = messenger?.let { ChatLocal.of(context, it) }
  val history = ChatHistory(messenger, local, chatId, peerId, peerName)
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  private var host: ViewGroup? = null
  private var list: MsgListView? = null
  private var heading: TextView? = null
  private var backButton: View? = null
  private var composer: View? = null
  private var field: ComposerField? = null
  private var sendButton: SendButton? = null
  private var attachments: ChatAttachments? = null

  private val statusLabel = TextView(context)
  private val pinnedBar = PinnedBar(context)
  private val composerBar = ComposerBar(context)
  private val downButton = DownButton(context)
  private val notice = ChatNotice(context)
  private val failedNotice = ChatNotice(context)
  private val selectionHeader = SelectionHeader(context)
  private val selectionBar = SelectionBar(context)
  private var openedMenu: MessageMenu? = null
  /** LinkPreview: the card of a link being written, above the field (linkpreview/LinkComposer.kt). */
  private val links = com.linea.messenger.linkpreview.LinkComposer(context)
  /** Composer: the long touch on the send button, the scheduled messages, the emoji panel and the formatting panel
   *  (composer/ComposerExtras.kt). */
  val extras = com.linea.messenger.composer.ComposerExtras(context)
  /** Composer: the words and the «без звука» of the message scheduled last (the sample chat's list shows them). */
  private var lastScheduledText = ""
  private var lastScheduledSilent = false
  /** ChatActions: «Поиск в этом чате» (chatactions/ChatSearch.kt); made in `install`. */
  private var searchBar: ChatSearchBar? = null

  /** The rows of the chat changed (oldest first, for `MsgRow.parse`). */
  var onRows: ((List<Map<String, Any?>>) -> Unit)? = null
  /** The newest page was read: the newest message of the other side in it. */
  var onLoaded: ((Long) -> Unit)? = null
  /** The keyboard is up (the screen knows it from the window's edges). */
  var keyboardUp = false

  private var replyTo: Map<String, Any?>? = null
  private var editing: Map<String, Any?>? = null
  private var forwardItems: List<ForwardDraft.Item> = emptyList()
  private var tapWork: Runnable? = null
  private var tapKey = ""
  private var typingAt = 0L
  private val typingStop = Runnable { messenger?.live?.typing(chatId, false) }
  private var jump: Pair<String, Int>? = null
  private var focusClient = ""
  private var fromNewest = 0f
  private var unseen = 0
  private var newestKnown = 0L
  private var shownOnce = false
  private var failedShown = false
  private var attached = false
  /** The sample chat's own draft (no account, nothing is kept). */
  private var sampleDraft = ""
  private var demoDone = false

  private val statusWatcher: (String?) -> Unit = { id -> if (id == null || id == chatId || id == peerId) showStatus() }
  /** ChatLook: «соединение…» / «ожидание сети…» in the same line (chatlook/ChatLookState.kt). */
  private val connectionWatcher: (Unit) -> Unit = { showStatus() }
  /** «был(а) 5 минут назад» grows old by itself. */
  private val clock = object : Runnable {
    override fun run() {
      showStatus()
      if (attached) host?.postDelayed(this, 30_000)
    }
  }

  /** Up to which message the other side has read (the two ticks). */
  var peerLastRead: Long
    get() = history.peerLastRead
    set(value) { history.peerLastRead = value }

  private val selecting: Boolean get() = history.selection != null

  // Setting up

  /** What the list of chats knows about this chat when it opens it (the chat as the server lists it): the
   *  person's @name for the header, and where the unread messages begin. */
  fun opened(chat: Map<String, Any?>) {
    peerUsername = Core.map(chat["peer"])?.get("username") as? String ?: ""
    com.linea.messenger.profile.ProfileChatLink.settingsOf[chatId] = Core.map(chat["settings"]) ?: emptyMap() // Profile: the sound
    if (ChatHistory.number(chat["unreadCount"]) > 0) history.unreadAfter = ChatHistory.number(chat["lastReadMessageId"])
    showStatus()
  }

  /** Once the chat is read, go to this message (a result of the search in the list of chats). */
  fun focus(clientId: String) {
    focusClient = clientId
  }

  /** Takes the screen's views and adds its own to them. `behind`: the page the bars of glass blur. */
  fun install(host: ViewGroup, behind: GlassSource?, list: MsgListView, heading: TextView, back: View, composer: View, field: ComposerField, send: SendButton, attachments: ChatAttachments) {
    this.host = host
    this.list = list
    this.heading = heading
    backButton = back
    this.composer = composer
    this.field = field
    sendButton = send
    this.attachments = attachments

    statusLabel.textSize = 12f
    statusLabel.setTextColor(Theme.muted)
    statusLabel.gravity = Gravity.CENTER
    statusLabel.maxLines = 1
    statusLabel.ellipsize = TextUtils.TruncateAt.END
    statusLabel.includeFontPadding = false
    statusLabel.visibility = View.GONE
    host.addView(statusLabel)
    selectionHeader.visibility = View.GONE
    selectionHeader.onCancel = { history.selection = null }
    selectionHeader.onCopy = { copySelected() }
    host.addView(selectionHeader)

    pinnedBar.behind = behind
    pinnedBar.visibility = View.GONE
    pinnedBar.onOpen = { (history.shown.pinned?.get("clientId") as? String)?.let { jumpTo(it) } }
    pinnedBar.onUnpin = { history.sendAction(mapOf("type" to "pin", "target" to null)) }
    host.addView(pinnedBar)
    notice.onChange = { relayout() }
    host.addView(notice)
    failedNotice.onPress = { history.retryFailed() }
    failedNotice.onChange = { relayout() }
    host.addView(failedNotice)
    composerBar.behind = behind
    composerBar.visibility = View.GONE
    composerBar.onClose = { closeBar() }
    host.addView(composerBar)
    downButton.behind = behind
    downButton.visibility = View.GONE
    downButton.onPress = {
      com.linea.messenger.chatlook.Haptic.light(downButton) // ChatLook: as the reference's «Вниз к новым сообщениям»
      unseen = 0
      list.scrollToNewest(animated = true)
    }
    host.addView(downButton)
    selectionBar.behind = behind
    selectionBar.visibility = View.GONE
    selectionBar.onForward = { forwardSelected() }
    selectionBar.onShare = { shareSelected() }
    selectionBar.onDelete = { deleteSelected() }
    host.addView(selectionBar)

    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(text: Editable?) { if (!field.quiet) fieldChanged(text?.toString() ?: "") }
    })
    send.setOnClickListener { submit() }

    list.onMsgPress = { key, y -> pressed(key, y) }
    // ChatsPlus: the row of a finished call calls back (MessageRow.tsx «Перезвонить»).
    list.noticeTappable = { key -> history.shown.calls[key] != null }
    list.onMsgLongPress = { key, y -> held(key, y) }
    list.onReactPress = { key, emoji -> chipPressed(key, emoji) }
    list.onQuotePress = { key -> quotePressed(key) }
    // LinkPreview: a link in the text and the card of a link open in the system browser (linkpreview/LinkOpen.kt).
    list.onLinkPress = { _, url, shown -> com.linea.messenger.linkpreview.LinkOpen.pressed(context, url, shown) }
    list.onCardPress = { _, url -> com.linea.messenger.linkpreview.LinkOpen.cardPressed(context, url) }
    links.install(host, behind)
    links.onChanged = { relayout() }
    // Polls: voting in a poll, and «Опрос» of the paperclip (polls/).
    list.onPollPress = { key, part -> pollPressed(key, part) }
    attachments.onPoll = { newPoll() }
    // ChatActions: «Поиск в этом чате».
    val search = ChatSearchBar(context, behind)
    search.visibility = View.GONE
    search.onChange = { needle -> history.searchNeedle = needle }
    search.onClose = { closeSearch() }
    host.addView(search)
    searchBar = search
    // Composer: the long touch on the send button, the scheduled pill, the emoji panel, the formatting bar.
    (composer as? android.widget.FrameLayout)?.let { extras.install(host, behind, field, send, it, messenger, chatId, peerId, peerName) }
    extras.onSend = { silent, deliverAt -> submit(silent, deliverAt) }
    extras.canOffer = { editing == null && forwardItems.isEmpty() }
    extras.onLayout = { relayout() }
    extras.onSay = { words -> say(words) }
    history.onScheduled = { deliverAt -> extras.scheduled(deliverAt, lastScheduledText, lastScheduledSilent) }
    list.onNearTop = { if (history.hasMore) history.load(older = true) }
    list.onScrolled = { distance -> scrolled(distance / d) }

    history.onShown = { shown -> show(shown) }
    history.onLoaded = { newest -> onLoaded?.invoke(newest) }
    history.onProblem = { words -> say(words, danger = true) }

    // The unsent text of this chat, and a forward that waits for it.
    field.put(local?.draft(chatId) ?: "")
    forwardItems = ForwardDraft.waiting(chatId)
    if (messenger == null && ChatActionsDemo.present) demoSeed()
    showBar()
    showStatus()
  }

  /** The screen is in the window: what the header's status follows is watched. */
  fun attached() {
    if (attached) return
    attached = true
    ChatTyping.changed.watch(statusWatcher)
    Live.presenceChanged.watch(statusWatcher)
    com.linea.messenger.chatlook.ChatLookConnection.changed.watch(connectionWatcher) // ChatLook
    extras.attached() // Composer
    host?.postDelayed(clock, 30_000)
    showStatus()
  }

  /** The screen left the window. */
  fun detached() {
    if (!attached) return
    attached = false
    ChatTyping.changed.unwatch(statusWatcher)
    Live.presenceChanged.unwatch(statusWatcher)
    com.linea.messenger.chatlook.ChatLookConnection.changed.unwatch(connectionWatcher) // ChatLook
    extras.detached() // Composer
    host?.removeCallbacks(clock)
    host?.removeCallbacks(typingStop)
    tapWork?.let { host?.removeCallbacks(it) }
    tapWork = null
    messenger?.live?.typing(chatId, false)
    openedMenu?.dismiss()
  }

  /** Reads the chat's newest page (the rows come through `onRows`). */
  fun load() {
    history.load()
  }

  // The header

  /** The line under the name: «печатает…», else «в сети» / «был(а) …», else the person's @name. */
  private fun showStatus() {
    var words = ""
    var lit = false
    val seen = messenger?.let { PresenceWords.text(it.live.presence[peerId]) }
    if (ChatTyping.isTyping(chatId)) {
      words = "печатает…"
      lit = true
    } else if (seen != null) {
      words = seen
      lit = seen == "в сети"
    } else if (peerUsername.isNotEmpty()) {
      words = "@$peerUsername"
    }
    if (messenger == null && ChatActionsDemo.present) {
      words = if (ChatActionsDemo.chatdemo == "typing") "печатает…" else "в сети"
      lit = true
    }
    // ChatLook: while the connection is not up, the line says so (the reference's `headerStatus`).
    com.linea.messenger.chatlook.ChatLookConnection.words(context, messenger)?.let { words = it; lit = false }
    if (statusLabel.text.toString() == words) return
    statusLabel.text = words
    statusLabel.setTextColor(if (lit) Theme.accent else Theme.muted)
    showHeader()
    relayout()
  }

  /** The header's parts for what is going on: the name with its status, or the multi-select's own line. */
  private fun showHeader() {
    val chosen = selecting
    val hasStatus = statusLabel.text.isNotEmpty()
    heading?.visibility = if (chosen) View.INVISIBLE else View.VISIBLE
    statusLabel.visibility = if (chosen || !hasStatus) View.GONE else View.VISIBLE
    backButton?.visibility = if (chosen) View.INVISIBLE else View.VISIBLE
    selectionHeader.visibility = if (chosen) View.VISIBLE else View.GONE
    selectionBar.visibility = if (chosen) View.VISIBLE else View.GONE
    composer?.visibility = if (chosen) View.INVISIBLE else View.VISIBLE
    composerBar.visibility = if (chosen || !barShown) View.GONE else View.VISIBLE
  }

  /** What the status line says now (for the checks). */
  val status: String get() = statusLabel.text.toString()

  // Layout

  /** The height the composer needs for the field's text at this width of the field, px. */
  fun composerHeight(fieldWidth: Int): Int = field?.wantedHeight(fieldWidth - dp(com.linea.messenger.composer.ComposerExtras.EMOJI_ROOM)) ?: dp(ComposerField.lowest) // Composer: the emoji button's room

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** Places what this object added, after the screen has placed its own views (all px). Gives the room the
   *  list must leave under the header and above the composer. */
  fun place(width: Int, height: Int, headerBottom: Int, safeTop: Int, composerLeft: Int, composerTop: Int, composerWidth: Int, composerHeight: Int): Pair<Int, Int> {
    val hasStatus = statusLabel.text.isNotEmpty()
    heading?.let { put(it, dp(56f), safeTop + dp(if (hasStatus) 5f else 2f), width - dp(112f), dp(if (hasStatus) 22f else 44f)) }
    put(statusLabel, dp(56f), safeTop + dp(27f), width - dp(112f), dp(16f))
    put(selectionHeader, 0, safeTop + dp(2f), width, dp(44f))

    var top = headerBottom + dp(8f)
    // ChatActions: the search line stands where the pinned message would.
    searchBar?.takeIf { it.visibility == View.VISIBLE }?.let {
      put(it, dp(12f), headerBottom + dp(4f), width - dp(24f), dp(ChatSearchBar.HEIGHT))
      top = headerBottom + dp(4f) + dp(ChatSearchBar.HEIGHT) + dp(8f)
    }
    if (pinnedBar.visibility == View.VISIBLE) {
      put(pinnedBar, dp(12f), headerBottom + dp(4f), width - dp(24f), dp(PinnedBar.height))
      top = headerBottom + dp(4f) + dp(PinnedBar.height) + dp(8f)
    }
    var noticeY = top
    for (item in listOf(failedNotice, notice)) {
      if (item.visibility != View.VISIBLE) continue
      item.measure(View.MeasureSpec.makeMeasureSpec((width - dp(32f)).coerceAtLeast(0), View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
      val left = (width - item.measuredWidth) / 2
      item.layout(left, noticeY, left + item.measuredWidth, noticeY + item.measuredHeight)
      noticeY += item.measuredHeight + dp(6f)
    }

    var above = composerTop
    val barTop = composerTop + composerHeight - dp(SelectionBar.height)
    put(selectionBar, dp(12f), barTop, width - dp(24f), dp(SelectionBar.height))
    if (selecting) {
      above = barTop
    } else if (composerBar.visibility == View.VISIBLE) {
      above = composerTop - dp(6f) - dp(ComposerBar.height)
      put(composerBar, composerLeft, above, composerWidth, dp(ComposerBar.height))
    }
    // LinkPreview: the card of the link being written stands above the field (and above the bar of an answer).
    above = links.place(composerLeft, composerWidth, above, hidden = selecting)
    // Composer: the formatting bar over a selection, the emoji panel, the scheduled pill.
    above = extras.place(width, height, composerLeft, composerWidth, above, top, hidden = selecting)
    val side = dp(DownButton.side); val over = dp(DownButton.over)
    put(downButton, width - dp(14f) - side, above - dp(12f) - side - over, side, side + over)
    return Pair(top, height - above + dp(8f))
  }

  private fun relayout() {
    host?.requestLayout()
  }

  // What is shown

  private fun show(shown: ChatHistory.Shown) {
    // Messages of the other side that came while the list was scrolled away are counted on the way down.
    var newest = newestKnown
    var fresh = 0
    for (key in shown.order) {
      val message = shown.messages[key] ?: continue
      if (message["localState"] != null) continue
      val id = ChatHistory.number(message["id"])
      if (id > newestKnown && shownOnce && message["senderId"] as? String != history.userId) fresh += 1
      newest = maxOf(newest, id)
    }
    newestKnown = newest
    if (fromNewest > 350) unseen += fresh else unseen = 0
    onRows?.invoke(shown.rows)

    val pinned = shown.pinned
    if (pinned != null) {
      val line = Core.view("replyPreview", listOf(pinned)) as? String ?: ""
      pinnedBar.show(line.ifEmpty { "Вложение" })
    }
    val pinnedShown = pinned != null && searchBar?.visibility != View.VISIBLE // ChatActions: the search takes the pinned bar's place
    searchBar?.takeIf { it.visibility == View.VISIBLE }?.show(shown.found)
    if ((pinnedBar.visibility == View.VISIBLE) != pinnedShown) {
      pinnedBar.visibility = if (pinnedShown) View.VISIBLE else View.GONE
      relayout()
    }
    val failed = shown.failedActions > 0
    if (failed != failedShown) {
      failedShown = failed
      if (failed) failedNotice.show("Действие не отправлено · повторить", danger = true, stay = true) else failedNotice.hide()
      relayout()
    }
    // What was being answered or edited may be gone by now.
    replyTo?.let { if (shown.messages[ChatHistory.key(it)] == null) { replyTo = null; showBar() } }
    editing?.let { if (shown.messages[ChatHistory.key(it)] == null) endEdit() }
    showSelection()
    showDown()
    if (jump != null) stepJump()
    if (!history.loadedOnce || shownOnce) return
    shownOnce = true
    if (focusClient.isNotEmpty()) {
      val wanted = focusClient
      focusClient = ""
      host?.postDelayed({ jumpTo(wanted) }, 100)
    }
    if (ChatActionsDemo.present) host?.postDelayed({ demoAct() }, 800)
  }

  private fun scrolled(distance: Float) {
    fromNewest = distance
    if (distance < 24 && unseen != 0) unseen = 0
    showDown()
  }

  private fun showDown() {
    val wanted = fromNewest > 350 && !selecting
    if ((downButton.visibility == View.VISIBLE) != wanted) downButton.visibility = if (wanted) View.VISIBLE else View.GONE
    if (wanted) downButton.show(unseen)
  }

  /** A short line under the header. */
  private fun say(words: String, danger: Boolean = false) {
    if (words.isEmpty()) return
    notice.show(words, danger)
    relayout()
  }

  /** The short line shown now ('' when there is none; for the checks). */
  val said: String get() = if (notice.visibility == View.VISIBLE) notice.words else ""

  private fun hideKeyboard() {
    val host = host ?: return
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(host.windowToken, 0)
  }

  private fun showKeyboard() {
    val field = field ?: return
    field.requestFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(field, 0)
  }

  // ChatLook: the status line for the glass header, and a swipe to the left that answers a message
  // (chatlook/ChatLookScreen.kt, MsgMotion.kt).
  val statusView: TextView get() = statusLabel

  fun canSwipeReply(key: String): Boolean {
    if (selecting) return false
    val message = history.shown.messages[key] ?: return false
    return readable(message) && !outgoing(message)
  }

  fun swipeReply(key: String) {
    if (!canSwipeReply(key)) return
    startReply(history.shown.messages[key] ?: return, focus = true)
  }

  /** ChatLook: the emulator check — the answer bar for the newest message of the other side (as a finished swipe). */
  fun demoReply(key: String) { history.shown.messages[key]?.let { startReply(it, focus = false) } }

  private fun thump() { host?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) }
  private fun tick() { host?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) }

  // Touches on a message

  /** A tap, as in the reference: it opens the menu, a second tap right after it puts ❤️ instead. With the
   *  keyboard up a tap only puts the keyboard away; a tap on a photo or a file opens it. */
  private fun pressed(key: String, y: Float) {
    // ChatsPlus: «Перезвонить» — the same kind of call again, from the row of a finished one.
    val call = history.shown.calls[key]
    if (call != null && !selecting) {
      tick()
      com.linea.messenger.calls.CallEntry.call(messenger, chatId, peerId, peerName, video = call["video"] == true)
      return
    }
    val message = history.shown.messages[key]
    if (message == null) {
      // A row that is not a message of the chat yet: an attachment on its way out.
      attachments?.pressed(key)
      return
    }
    if (selecting) { toggle(key); return }
    if (message["localState"] as? String == "failed") { history.retryFailed(); return }
    if (keyboardUp && tapWork == null) {
      hideKeyboard()
      return
    }
    if (Core.map(message["attachment"] as? Map<*, *>) != null) {
      attachments?.pressed(key)
      return
    }
    val waiting = tapWork
    if (waiting != null && tapKey == key) {
      host?.removeCallbacks(waiting)
      tapWork = null
      if (readable(message) && !outgoing(message)) {
        thump()
        react(message, "❤️")
      }
      return
    }
    waiting?.let { host?.removeCallbacks(it) }
    tapKey = key
    val work = Runnable {
      tapWork = null
      openMenu(key, y)
    }
    tapWork = work
    host?.postDelayed(work, 230)
  }

  private fun held(key: String, y: Float) {
    if (history.shown.messages[key] == null) return
    if (selecting) { toggle(key); return }
    tapWork?.let { host?.removeCallbacks(it) }
    tapWork = null
    thump()
    openMenu(key, y)
  }

  private fun chipPressed(key: String, emoji: String) {
    val message = history.shown.messages[key] ?: return
    if (selecting) { toggle(key); return }
    if (readable(message) && MessageReactions.all.contains(emoji)) react(message, emoji)
  }

  private fun quotePressed(key: String) {
    val message = history.shown.messages[key] ?: return
    if (selecting) { toggle(key); return }
    val meta = Core.map(message["meta"])
    // Stories: the quote «История» of an answer to a story opens that story (or says it is gone).
    val story = if (meta?.get("reply") == null) Core.map(meta?.get("story")) else null
    val ownerId = story?.get("ownerId") as? String
    val storyId = story?.get("id") as? String
    if (ownerId != null && storyId != null) {
      val messenger = messenger ?: return
      val host = host ?: return
      tick()
      com.linea.messenger.stories.StoryQuote.open(ownerId, storyId, messenger, host) { words -> say(words) }
      return
    }
    val client = Core.map(meta?.get("reply"))?.get("clientId") as? String ?: return
    tick()
    jumpTo(client)
  }

  /** One reaction per person on a message: the same one again takes it off. */
  private fun react(message: Map<String, Any?>, emoji: String) {
    history.sendAction(reaction(message, emoji) ?: return, message["text"] as? String ?: "")
  }

  // The menu

  private fun editWindowOpen(message: Map<String, Any?>): Boolean =
    Core.view("editWindowOpen", listOf(message["createdAt"] as? String ?: "", System.currentTimeMillis())) as? Boolean ?: false

  private fun editable(message: Map<String, Any?>): Boolean = mayEdit(message, history.userId) && editWindowOpen(message)

  private fun openMenu(key: String, y: Float) {
    if (openedMenu?.isShowing == true) return
    val shown = history.shown
    val message = shown.messages[key] ?: return
    val text = message["text"] as? String ?: ""
    val client = message["clientId"] as? String ?: ""
    val pinnedNow = client.isNotEmpty() && shown.pinned?.get("clientId") as? String == client
    val canReact = readable(message) && !outgoing(message)

    val items = menuItems(message, shown.noCopy, pinnedNow, editable(message)).mapTo(ArrayList()) { name ->
      when (name) {
        "reply" -> MessageMenu.Item("reply", "Ответить") { startReply(message, focus = true) }
        "copy" -> MessageMenu.Item("copy", "Скопировать") { copyWords(text) }
        "pin" -> MessageMenu.Item(if (pinnedNow) "pin.slash" else "pin", if (pinnedNow) "Открепить" else "Закрепить") {
          history.sendAction(mapOf("type" to "pin", "target" to (if (pinnedNow) null else client)), text)
        }
        "forward" -> MessageMenu.Item("forward", "Переслать") { startForward(listOf(message)) }
        "edit" -> MessageMenu.Item("pencil", "Изменить") { startEdit(message, focus = true) }
        "retry" -> MessageMenu.Item("refresh", "Повторить отправку") { history.retryFailed() }
        "delete" -> MessageMenu.Item("trash", "Удалить", danger = true, stays = true) { openedMenu?.replace(deleteItems(listOf(key)) {}) }
        else -> MessageMenu.Item("check.circle", "Выбрать", separated = true) {
          thump()
          history.selection = setOf(key)
        }
      }
    }
    // Attachments: «Сохранить фото» / «Сохранить видео» / «Сохранить» after «Скопировать» (attachments/MediaSave.kt).
    val file = Core.map(message["attachment"] as? Map<*, *>)
    if (!shown.noCopy && readable(message) && file != null) {
      val at = items.indexOfFirst { it.symbol == "copy" }.let { if (it >= 0) it + 1 else minOf(1, items.size) }
      items.add(at, MessageMenu.Item("square.and.arrow.down", com.linea.messenger.attachments.MediaSave.label(file)) { saveFiles(listOf(file)) })
    }
    // ChatsPlus: «В Избранное» — the message goes to this device's saved messages (chatsplus/SavedMessages.kt),
    // after «Скопировать» as on the iPhone.
    if (!shown.noCopy && readable(message) && !outgoing(message) && com.linea.messenger.chatsplus.SavedMessages.shared(messenger) != null) {
      val at = items.indexOfFirst { it.symbol == "copy" || it.symbol == "square.and.arrow.down" }.let { found -> if (found >= 0) items.indexOfLast { it.symbol == "copy" || it.symbol == "square.and.arrow.down" } + 1 else minOf(1, items.size) }
      items.add(at, MessageMenu.Item("bookmark", "В Избранное") { saveToFavorites(listOf(message)) })
    }
    if (items.isEmpty()) return

    var current = ""
    for (reaction in (message["reactions"] as? List<*>).orEmpty().mapNotNull { Core.map(it) }) if (reaction["mine"] == true) current = reaction["emoji"] as? String ?: ""
    val reactions = if (canReact) MessageReactions.all.map { it to (it == current) } else emptyList()
    hideKeyboard()
    val menu = MessageMenu(context, y, message["senderId"] as? String == history.userId, Messenger.previewText(message), reactions, items)
    menu.onReact = { emoji -> react(message, emoji) }
    openedMenu = menu
    menu.show()
  }

  /** The menu on the screen now, if any (for the checks). */
  val shownMenu: MessageMenu? get() = openedMenu?.takeIf { it.isShowing }

  /** «Удалить у меня и у <имя>» — either side's messages, for both — and «Удалить у меня». */
  private fun deleteItems(keys: List<String>, done: () -> Unit): List<MessageMenu.Item> {
    val shown = history.shown
    val messages = keys.mapNotNull { shown.messages[it] }
    val everyone = messages.isNotEmpty() && messages.all { readable(it) }
    val items = ArrayList<MessageMenu.Item>()
    if (everyone) {
      items.add(MessageMenu.Item("trash", "Удалить у меня и у $peerName", danger = true) {
        for (message in messages) (message["clientId"] as? String)?.let { history.sendAction(mapOf("type" to "delete", "target" to it)) }
        done()
      })
    }
    items.add(MessageMenu.Item("eye.slash", "Удалить у меня", danger = true) {
      history.hideForMe(messages.map { ChatHistory.key(it) })
      done()
    })
    return items
  }

  private fun copyWords(words: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("", words))
    say("Скопировано")
  }

  // Answering, editing, the bar above the field

  private fun startReply(message: Map<String, Any?>, focus: Boolean) {
    if (editing != null) endEdit()
    replyTo = message
    showBar()
    if (focus) showKeyboard()
  }

  /** «Изменить»: the message's text is edited in the field; the chat's draft is not touched and comes back after. */
  private fun startEdit(message: Map<String, Any?>, focus: Boolean) {
    replyTo = null
    editing = message
    field?.put(message["text"] as? String ?: "")
    // Composer: the message's own formatting comes into the field with its text.
    extras.reset(field?.text?.toString() ?: "", (Core.map(message["meta"])?.get("entities") as? List<*>).orEmpty().mapNotNull { Core.map(it) })
    showBar()
    if (focus) showKeyboard()
  }

  private fun endEdit() {
    editing = null
    field?.put(local?.draft(chatId) ?: sampleDraft)
    extras.reset(field?.text?.toString() ?: "") // Composer
    showBar()
  }

  private fun closeBar() {
    if (editing != null) {
      endEdit()
    } else if (replyTo != null) {
      replyTo = null
      showBar()
    } else {
      forwardItems = emptyList()
      ForwardDraft.clear()
      showBar()
    }
  }

  private var barShown = false

  private fun showBar() {
    val editing = editing; val replyTo = replyTo; val first = forwardItems.firstOrNull()
    barShown = true
    if (editing != null) {
      composerBar.show("pencil", "Редактирование", Core.view("replyPreview", listOf(editing)) as? String ?: "", "Отменить редактирование")
    } else if (replyTo != null) {
      val own = replyTo["senderId"] as? String == history.userId
      composerBar.show("reply", "Ответ " + (if (own) "себе" else peerName), ChatHistory.quoteText(replyTo, ""), "Отменить ответ")
    } else if (first != null) {
      composerBar.show("forward", forwardHeading(forwardItems.size), first.author + ": " + Messenger.previewText(first.message), "Не пересылать")
    } else {
      barShown = false
    }
    // LinkPreview: an edit or a forward takes the field over; the card of a link typed before goes.
    if (editing != null || forwardItems.isNotEmpty()) links.reset()
    showHeader()
    showSend()
    relayout()
  }

  /** The heading of the bar above the field ('' when there is none; for the checks). */
  val bar: String get() = if (barShown) composerBar.heading else ""
  val barWords: String get() = if (barShown) composerBar.words else ""

  /** Voice/Video: the send button has work even over an empty field (an edit, a forward that waits), so the
   *  microphone does not take its place (voice/ChatMedia.kt). */
  val wantsSendButton: Boolean get() = editing != null || forwardItems.isNotEmpty()

  /** The send button: a tick while editing (greyed over an empty field), the arrow otherwise. */
  private fun showSend() {
    val sendButton = sendButton ?: return
    sendButton.editing = editing != null
    sendButton.isEnabled = !(editing != null && field?.text.isNullOrBlank())
  }

  // Sending

  /** The send button: the edit, the forward with its comment, or the message (an answer when one is being written). */
  fun submit(silent: Boolean = false, deliverAt: java.time.Instant? = null) {
    val field = field ?: return
    // Composer: the shortcuts typed (**жирный**…) and the styles of the panel become entities; the text is what
    // remains of the field, trimmed (composer/FormatBar.kt). `silent` and `deliverAt` come from the long touch on the
    // send button; they apply to a new message, not to an edit or a forward.
    val composed = extras.compose(field.text.toString())
    val text = composed.first
    val editing = editing
    if (editing != null) {
      if (text.isEmpty()) return
      val before = (Core.map(editing["meta"])?.get("entities") as? List<*>).orEmpty()
      val changed = text != (editing["text"] as? String ?: "") || before != (composed.second ?: emptyList<Any?>())
      val client = editing["clientId"] as? String
      if (changed && !editWindowOpen(editing)) {
        say(editWindowClosed)
      } else if (changed && client != null) {
        // The new text replaces the old one with its formatting.
        val action = linkedMapOf<String, Any?>("type" to "edit", "target" to client, "text" to text)
        composed.second?.let { action["entities"] = it }
        history.sendAction(action)
      }
      endEdit()
      stopTyping()
      return
    }
    if (forwardItems.isNotEmpty()) {
      sendForward(text)
      return
    }
    if (text.isEmpty()) return
    com.linea.messenger.chatlook.Haptic.light(host) // ChatLook: the reference's send knock (lightFeedback)
    var meta = replyTo?.let { replyMeta(it) }
    // Composer: the formatting chosen in the panel above the field, and «без звука».
    composed.second?.let { meta = (meta ?: emptyMap()) + ("entities" to it) }
    meta = com.linea.messenger.composer.ScheduleModel.withSilent(meta, silent)
    replyTo = null
    if (deliverAt != null) { lastScheduledText = text; lastScheduledSilent = silent }
    // LinkPreview: the card made while the link was typed goes inside the same encrypted message.
    history.send(text, meta, linkPreview = links.take(text), deliverAt = deliverAt?.let { com.linea.messenger.composer.ScheduleModel.iso(it) })
    clearField()
    showBar()
    list?.scrollToNewest(animated = true)
  }

  /** Attachments, Voice/Video: a photo, a file, a voice message or a video sent while an answer is being written
   *  is that answer — its `meta`, and the bar above the field closes. Null: nothing is being answered. */
  fun takeReply(): Map<String, Any?>? {
    if (editing != null) return null
    val message = replyTo ?: return null
    replyTo = null
    showBar()
    return replyMeta(message)
  }

  private fun clearField() {
    field?.put("")
    extras.reset("") // Composer
    if (local != null) local.setDraft(chatId, "") else sampleDraft = ""
    links.reset()
    stopTyping()
    relayout()
  }

  // Forwarding

  /** Whose words a message carries: the first author, kept through further forwards. */
  private fun author(message: Map<String, Any?>): String {
    val from = Core.map(Core.map(message["meta"])?.get("forward"))?.get("from") as? String
    if (!from.isNullOrEmpty()) return from
    if (message["senderId"] as? String == history.userId) return messenger?.user?.get("displayName") as? String ?: "Ты"
    return peerName
  }

  private fun startForward(messages: List<Map<String, Any?>>) {
    if (messages.isEmpty()) return
    val picker = ForwardPicker(context, messenger, messages.size)
    val items = messages.map { ForwardDraft.Item(it, author(it)) }
    picker.onPick = pick@{ target ->
      history.selection = null
      // ChatsPlus: «Избранное» — the messages go to this device's saved messages.
      if (target.isSaved) { saveToFavorites(messages); return@pick }
      val messenger = messenger
      if (messenger == null || (target.summary == null && target.chatId != chatId)) {
        // The debug build's samples: nothing is sent anywhere.
        say("Переслано: " + target.name)
        return@pick
      }
      // The chat opens with the forward waiting above the field: a comment can be added.
      ForwardDraft.put(target.chatId, items)
      if (target.chatId == chatId) {
        forwardItems = items
        showBar()
        return@pick
      }
      val stack = host?.pages() ?: return@pick
      val screen = ChatScreen(context, target.name, messenger, target.chatId, target.peerId, target.summary?.peerLastRead ?: 0L) { stack.pop() }
      target.summary?.let { screen.actions.opened(it.chat) }
      // The chat the message came from gives way to the one it goes to.
      while (stack.depth > 1) stack.pop(animated = false)
      stack.push(screen)
    }
    // Composer: «Выбрать» → several chats at once, the comment first in each (the reference's `onSendMany`).
    picker.onSendMany = many@{ targets, comment ->
      history.selection = null
      if (targets.any { it.isSaved }) saveToFavorites(messages)
      val messenger = messenger
      if (messenger == null) { say(ChatForward.notice(targets)); return@many }
      ChatForward.sendMany(messenger, targets, comment, items) { problem ->
        if (problem != null) say(problem, danger = true) else say(ChatForward.notice(targets))
        if (targets.any { it.chatId == chatId }) history.load()
      }
    }
    hideKeyboard()
    picker.show()
    if (messenger == null && ChatActionsDemo.chatdemo == "forwardmany") picker.demoChooseSeveral()
  }

  private fun sendForward(comment: String) {
    val items = forwardItems
    forwardItems = emptyList()
    ForwardDraft.clear()
    if (comment.isNotEmpty()) history.send(comment, null)
    clearField()
    showBar()
    list?.scrollToNewest(animated = true)
    if (messenger == null) {
      for (item in items) history.send(item.message["text"] as? String ?: "", mapOf("forward" to mapOf("from" to item.author)))
      return
    }
    forwardNext(items, 0)
  }

  /** One after another, in their order. */
  private fun forwardNext(items: List<ForwardDraft.Item>, index: Int) {
    val messenger = messenger
    if (messenger == null || index >= items.size) {
      history.load()
      return
    }
    ChatForward.send(messenger, chatId, peerId, items[index].message, items[index].author) { problem ->
      if (problem != null) {
        say(problem, danger = true)
        history.load()
      } else {
        forwardNext(items, index + 1)
      }
    }
  }

  // Choosing several

  private fun toggle(key: String) {
    if (history.shown.messages[key] == null) return
    val chosen = history.selection ?: return
    tick()
    val next = if (chosen.contains(key)) chosen - key else chosen + key
    history.selection = next.ifEmpty { null }
  }

  /** The chosen messages, oldest first. */
  private fun chosenMessages(): List<Map<String, Any?>> {
    val chosen = history.selection ?: return emptyList()
    val shown = history.shown
    return shown.order.filter { chosen.contains(it) }.mapNotNull { shown.messages[it] }
  }

  private fun showSelection() {
    val chosen = selecting
    if ((selectionHeader.visibility == View.VISIBLE) != chosen) {
      showHeader()
      if (chosen) hideKeyboard()
      relayout()
    }
    if (!chosen) return
    val messages = chosenMessages()
    // «Копирование запрещено» binds the multi-select too: nothing leaves the chat; deleting stays.
    val locked = history.shown.noCopy
    val texts = messages.filter { (it["text"] as? String ?: "").isNotEmpty() }
    selectionHeader.show(messages.size, canCopy = !locked && texts.isNotEmpty())
    selectionBar.show(export = !locked && messages.isNotEmpty(), chosen = messages.isNotEmpty())
  }

  /** «Выбрано: N» while several are being chosen, else '' (for the checks). */
  val selectionWords: String get() = if (selecting) selectionHeader.words else ""

  private fun chosenWords(): String = chosenMessages().mapNotNull { it["text"] as? String }.filter { it.isNotEmpty() }.joinToString("\n\n")

  private fun copySelected() {
    val words = chosenWords()
    if (words.isEmpty()) return
    history.selection = null
    copyWords(words)
  }

  private fun forwardSelected() {
    startForward(chosenMessages().filter { readable(it) && !outgoing(it) })
  }

  private fun shareSelected() {
    val words = chosenWords()
    if (words.isEmpty()) return
    history.selection = null
    val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, words)
    try { context.startActivity(Intent.createChooser(share, null)) } catch (_: Exception) { say("Не удалось открыть «Поделиться».", danger = true) }
  }

  private fun deleteSelected() {
    val keys = chosenMessages().map { ChatHistory.key(it) }
    if (keys.isEmpty()) return
    val choices = deleteItems(keys) { history.selection = null }.map { item -> ChoiceSheet.Choice(item.symbol, item.label, danger = true, run = item.run) }
    ChoiceSheet(context, "Выбрано: ${keys.size}", choices = choices).show()
  }

  // Polls, saving, the search, the gift

  /** Polls: a tap on an option, «Голосовать» or «Отменить голос» (the reference's PollBubble.tsx): one answer is sent
   *  at once; several are ticked first. A vote is an encrypted action the core folds into the results. */
  private fun pollPressed(key: String, part: String) {
    val message = history.shown.messages[key] ?: return
    val client = message["clientId"] as? String ?: return
    if (selecting) { toggle(key); return }
    if (!readable(message) || outgoing(message)) return
    val poll = Core.map(Core.map(message["meta"])?.get("poll")) ?: return
    val multiple = poll["multiple"] == true
    val mine = (Core.map(message["poll"])?.get("mine") as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() }
    val line = Core.view("replyPreview", listOf(message)) as? String ?: ""
    val vote: (List<Int>) -> Unit = { options -> history.sendAction(mapOf("type" to "vote", "target" to client, "options" to options), line) }
    if (part == "retract") { tick(); vote(emptyList()); return }
    if (part == "vote") {
      val draft = history.pollDrafts[key] ?: emptyList()
      if (draft.isEmpty()) return
      history.pollDrafts = history.pollDrafts - key
      vote(draft.sorted())
      return
    }
    val index = part.removePrefix("option:").toIntOrNull() ?: return
    tick()
    if (mine.isNotEmpty()) return
    if (!multiple) { vote(listOf(index)); return }
    val draft = history.pollDrafts[key] ?: emptyList()
    history.pollDrafts = history.pollDrafts + (key to (if (draft.contains(index)) draft - index else draft + index))
  }

  /** Polls: «Новый опрос»; the poll goes inside an encrypted message with its readable text for older clients. */
  fun newPoll() {
    hideKeyboard()
    val sheet = com.linea.messenger.polls.PollComposer(context)
    sheet.onSend = { poll ->
      tick()
      history.send(com.linea.messenger.polls.PollText.fallback(poll), mapOf("poll" to poll))
      list?.scrollToNewest(animated = true)
    }
    sheet.show()
  }

  /** Attachments: photos and videos to the gallery, any other file through the share sheet. */
  private fun saveFiles(files: List<Map<String, Any?>>) {
    val messenger = messenger ?: return say("Сохранено в галерею")
    com.linea.messenger.attachments.MediaSave.save(context, files, messenger) { words, danger -> say(words, danger) }
  }

  /** ChatsPlus: «В Избранное» — «Сохранено в Избранное» or «Уже в Избранном». */
  private fun saveToFavorites(messages: List<Map<String, Any?>>) {
    val saved = com.linea.messenger.chatsplus.SavedMessages.shared(messenger) ?: return
    for (message in messages) {
      saved.save(message, chatId, author(message).take(80)) { result ->
        val added = result.getOrNull()
        if (added != null) say(if (added) "Сохранено в Избранное" else "Уже в Избранном")
        else say((result.exceptionOrNull() as? com.linea.messenger.chatsplus.SavedMessages.Failure)?.words ?: "Не удалось сохранить.", danger = true)
      }
    }
  }

  /** Composer: «Отправить подарок» of the reference's chat menu (ChatScreen.tsx `headerSheet === 'gift'`): the gift
   *  sheet of profile/Gifts.kt for this person; «Подарок отправлен» once it went. */
  fun sendGift() {
    if (peerId.isEmpty() && messenger != null) return
    hideKeyboard()
    val sheet = com.linea.messenger.profile.GiftSheet(context, messenger, if (messenger == null) "sample" else peerId)
    sheet.onSent = { say("Подарок отправлен") }
    sheet.show()
  }

  /** ChatActions: «Поиск в этом чате» opens under the header (the avatar's menu and the profile's «Поиск» call it). */
  fun openSearch() {
    val search = searchBar ?: return
    if (search.visibility == View.VISIBLE) { search.input.requestFocus(); return }
    history.selection = null
    search.visibility = View.VISIBLE
    search.begin()
    pinnedBar.visibility = View.GONE
    relayout()
  }

  fun closeSearch() {
    val search = searchBar ?: return
    if (search.visibility != View.VISIBLE) return
    search.end()
    search.visibility = View.GONE
    history.searchNeedle = ""
    relayout()
  }

  /** The search line is open (for the checks). */
  val searching: Boolean get() = searchBar?.visibility == View.VISIBLE

  // Going to a message

  /** A tap on a quote or on the pinned bar (the reference's replyJump.ts): when the original is not loaded yet,
   *  earlier pages are read one after another until it is there; then the list scrolls to it and it lights up. */
  fun jumpTo(clientId: String) {
    com.linea.messenger.chatlook.Haptic.light(host) // ChatLook: as the reference's jumpTo
    jump = Pair(clientId, 0)
    stepJump()
  }

  private fun stepJump() {
    val wanted = jump ?: return
    val shown = history.shown
    val key = shown.keyOfClient[wanted.first]
    val step = jumpStep(found = key != null, noKey = shown.noKey.contains(wanted.first), deleted = key == null && history.knownDeleted(wanted.first),
      loading = history.loadingOlder, hasMore = history.hasMore, pages = wanted.second)
    when (step) {
      "wait" -> return
      "load" -> {
        jump = Pair(wanted.first, wanted.second + 1)
        history.load(older = true) { read -> if (!read) jump = null }
        return
      }
    }
    jump = null
    when (step) {
      "scroll" -> if (key == null || list?.jump(key) != true) say("Сообщение удалено")
      "no-key" -> say("Сообщение недоступно на этом устройстве")
      "too-far" -> say("Сообщение слишком далеко в истории")
      else -> say("Сообщение удалено")
    }
  }

  // The field

  private fun fieldChanged(value: String) {
    // While a message is being edited the draft is not written: nothing of the edit can later go out as a new message.
    if (editing == null) {
      if (local != null) local.setDraft(chatId, value) else sampleDraft = value
    }
    val now = SystemClock.elapsedRealtime()
    if (typingAt == 0L || now - typingAt > 1500) {
      // Composer: «Показывать «печатает…»» off — the other side is never told (DevicePreferences `sendTyping`).
      messenger?.live?.typing(chatId, value.isNotEmpty() && (com.linea.messenger.settings.DevicePreferences.flag("sendTyping") ?: true))
      typingAt = now
    }
    host?.removeCallbacks(typingStop)
    host?.postDelayed(typingStop, 1800)
    // LinkPreview: a link typed into a new message gets its card (not an edit, not the comment of a forward).
    links.typed(value, active = editing == null && forwardItems.isEmpty())
    extras.textChanged(value) // Composer: the styles move with the text
    showSend()
    relayout()
  }

  private fun stopTyping() {
    host?.removeCallbacks(typingStop)
    typingAt = 0L
    messenger?.live?.typing(chatId, false)
  }

  // The emulator check (debug builds only: `ChatActionsDemo` of a release build asks for nothing)

  /** `--ez demo true --ez chat true --es chatdemo <state>`: the sample chat as messages the core folds; with a
   *  state, what the actions leave in a chat (an answer with its quote, a forwarded message, reactions). */
  private fun demoSeed() {
    val state = ChatActionsDemo.chatdemo ?: ""
    history.seed(ChatActionsDemo.seed(chatId, history.userId, state), ChatActionsDemo.read)
    if (state == "draft") {
      sampleDraft = ChatActionsDemo.draft
      field?.put(sampleDraft)
    }
  }

  /** What the emulator check asks of an open chat, once its messages are on screen:
   *    --es chatdemo menu|delete|reply|edit|pinned|select|forward|quotes|typing|draft   the sample chat
   *    --es chataction menu|delete|reply|edit|pin|select|forward|react                  the first chat of an account */
  private fun demoAct() {
    if (demoDone) return
    demoDone = true
    // LinkPreview: `--ez linksend true` sends one message with a prepared card to this chat (linkpreview/LinkDemo.kt of src/debug).
    if (messenger != null) com.linea.messenger.linkpreview.LinkDemo.sendSample((context as? android.app.Activity)?.intent, history)
    val shown = history.shown
    val ask = (if (messenger == null) ChatActionsDemo.chatdemo else ChatActionsDemo.chataction) ?: return
    val host = host ?: return
    if (ask.isEmpty() || !host.isAttachedToWindow) return
    val all = shown.order.mapNotNull { shown.messages[it] }.filter { readable(it) && !outgoing(it) }
    val theirs = all.filter { it["senderId"] as? String != history.userId }
    val own = all.filter { it["senderId"] as? String == history.userId }
    // The sample chat: always the same two messages, so the pictures can be compared.
    var incoming = theirs.lastOrNull()
    var outgoing = own.lastOrNull { editable(it) }
    if (messenger == null) {
      incoming = shown.messages[ChatActionsDemo.peer + ":" + ChatActionsDemo.client(6)] ?: incoming
      outgoing = shown.messages[history.userId + ":" + ChatActionsDemo.client(5)] ?: outgoing
    }
    val here = IntArray(2).also { host.getLocationOnScreen(it) }
    val middle = here[1] + host.height * 0.45f
    val target = incoming ?: all.lastOrNull()
    when (ask) {
      "menu" -> target?.let { openMenu(ChatHistory.key(it), middle) }
      "delete" -> target?.let {
        val key = ChatHistory.key(it)
        openMenu(key, middle)
        host.postDelayed({ openedMenu?.replace(deleteItems(listOf(key)) {}) }, 600)
      }
      "reply" -> target?.let { startReply(it, focus = false) }
      "edit" -> outgoing?.let { startEdit(it, focus = false) }
      "select" -> history.selection = all.takeLast(2).map { ChatHistory.key(it) }.toSet().ifEmpty { null }
      "forward" -> target?.let { startForward(listOf(it)) }
      "pin" -> if (shown.pinned == null) target?.let { message ->
        (message["clientId"] as? String)?.let { history.sendAction(mapOf("type" to "pin", "target" to it), message["text"] as? String ?: "") }
      }
      // ChatActions, Polls, Composer: `chatdemo search|newpoll|gift` (with the messages of `chatdemo features`).
      "search" -> { openSearch(); searchBar?.input?.setText("распечат") }
      "newpoll" -> newPoll()
      "gift" -> sendGift()
      "forwardmany" -> target?.let { startForward(listOf(it)) }
      "react" -> incoming?.let { message ->
        val mine = (message["reactions"] as? List<*>).orEmpty().mapNotNull { Core.map(it) }.any { it["mine"] == true }
        if (!mine) react(message, "❤️")
      }
    }
  }

  companion object {
    const val editWindowClosed = "Изменить сообщение можно в течение 48 часов после отправки."

    fun readable(message: Map<String, Any?>): Boolean = message["cryptoState"] as? String == "decrypted"
    fun outgoing(message: Map<String, Any?>): Boolean = message["localState"] != null

    fun isVoice(attachment: Map<String, Any?>): Boolean {
      val name = attachment["name"] as? String ?: ""
      return attachment["mimeType"] as? String == "audio/mp4" && name.startsWith("voice-") && name.endsWith(".m4a")
    }

    fun isVideoNote(attachment: Map<String, Any?>): Boolean {
      val name = attachment["name"] as? String ?: ""
      return attachment["mimeType"] as? String == "video/mp4" && name.startsWith("circle-") && name.endsWith(".mp4")
    }

    /** The author edits their own message — its text or the caption of a photo or a file — (for 48 hours after
     *  sending: the core's `editWindowOpen` says that part). A poll, a voice or a video message has nothing to edit. */
    fun mayEdit(message: Map<String, Any?>, userId: String): Boolean {
      if (message["senderId"] as? String != userId || !readable(message) || outgoing(message)) return false
      val meta = Core.map(message["meta"])
      if (meta?.get("action") != null || meta?.get("poll") != null) return false
      val attachment = Core.map(message["attachment"] as? Map<*, *>)
      if ((message["text"] as? String ?: "").isEmpty() && attachment == null) return false
      if (attachment != null && (isVoice(attachment) || isVideoNote(attachment))) return false
      return true
    }

    /** What the menu of a message offers, in its order: reply, copy, pin, forward, edit, retry, delete, select.
     *  `noCopy`: the chat's rule «копирование запрещено»; `editable`: its author may still edit it. */
    fun menuItems(message: Map<String, Any?>, noCopy: Boolean, pinnedNow: Boolean, editable: Boolean): List<String> {
      val free = readable(message) && !outgoing(message)
      val text = message["text"] as? String ?: ""
      val items = ArrayList<String>()
      if (free) items.add("reply")
      if (!noCopy && text.isNotEmpty()) items.add("copy")
      if (free) items.add("pin")
      if (!noCopy && free) items.add("forward")
      if (editable) items.add("edit")
      if (message["localState"] as? String == "failed") items.add("retry")
      if (!outgoing(message)) { items.add("delete"); items.add("select") }
      return items
    }

    /** The action that puts a reaction on a message — or takes the person's own one off, when it is the same. */
    fun reaction(message: Map<String, Any?>, emoji: String): Map<String, Any?>? {
      val target = message["clientId"] as? String ?: return null
      var current = ""
      for (reaction in (message["reactions"] as? List<*>).orEmpty().mapNotNull { Core.map(it) }) if (reaction["mine"] == true) current = reaction["emoji"] as? String ?: ""
      return mapOf("type" to "react", "target" to target, "emoji" to (if (current == emoji) null else emoji))
    }

    /** What an answer carries about the message it answers: its id, its author and its line as it was then. */
    fun replyMeta(replyTo: Map<String, Any?>): Map<String, Any?>? {
      val client = replyTo["clientId"] as? String ?: return null
      val sender = replyTo["senderId"] as? String ?: return null
      val line = Core.view("replyPreview", listOf(replyTo)) as? String ?: ""
      return mapOf("reply" to mapOf("clientId" to client, "senderId" to sender, "preview" to ChatForward.clipped(line, 200)))
    }

    fun forwardHeading(count: Int): String = if (count > 1) "Переслать $count ${if (count < 5) "сообщения" else "сообщений"}" else "Переслать сообщение"

    /** The next step of going to a message (the reference's replyJump.ts `nextJumpStep`): scroll, no-key,
     *  deleted, wait, load or too-far. At most 30 earlier pages are read for one tap. */
    fun jumpStep(found: Boolean, noKey: Boolean, deleted: Boolean, loading: Boolean, hasMore: Boolean, pages: Int, cap: Int = 30): String = when {
      found -> "scroll"
      noKey -> "no-key"
      deleted -> "deleted"
      loading -> "wait"
      // The whole history is here and the message is not: it no longer exists.
      !hasMore -> "deleted"
      pages >= cap -> "too-far"
      else -> "load"
    }
  }
}
