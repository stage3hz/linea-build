package com.linea.messenger.chats

import android.annotation.SuppressLint
import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.TextView
import com.linea.messenger.Demo
import com.linea.messenger.app.ChatTarget
import com.linea.messenger.app.Messenger
import com.linea.messenger.chatactions.ChatListActions
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Server
import com.linea.messenger.offline.catchUpList
import com.linea.messenger.people.RoundIconButton
import com.linea.messenger.shell.RootScreen
import com.linea.messenger.shell.Screen

/** The first section: the list of chats. */
@SuppressLint("ViewConstructor")
class ChatsScreen(
  context: Context,
  /** The account whose chats are shown; null shows the debug build's samples (or nothing in a release one). */
  private val messenger: Messenger?,
  private val openChat: (ChatTarget) -> Unit,
) : Screen(context), Messenger.Watcher {
  private val heading = TextView(context)
  private val list = ChatListView(context)
  private val empty = TextView(context)
  /** People: «Новый чат» opens the «Люди» section, as in the reference. */
  private val newChat = RoundIconButton(context, "compose", RoundIconButton.Look.PRIMARY, 20f)
  private var summaries: List<Messenger.ChatSummary> = emptyList()
  private var demo: List<ChatRow> = emptyList()
  /** The page is in the window and not covered by another one. */
  private var showing = false
  private val reloadSoon = Runnable { reload() }
  /** ChatActions: the buttons behind a row, the long-press choices, «Архив», drafts and the search
   *  (chatactions/ChatListActions.kt). */
  private val actions = ChatListActions(context, messenger)
  /** Stories: the strip of stories above the chats (stories/StoriesStrip.kt). */
  private val stories = com.linea.messenger.stories.StoriesStrip(context, messenger)
  /** Offline: the list on screen came from the server at least once (until then it is the vault's copy). */
  private var serverLoaded = false
  /** Offline: lines opened in the background since the rows were last shown (offline/ListCatchUp.kt). */
  private val opened = ArrayList<Triple<String, Long, Map<String, Any?>>>()
  private val showOpened = Runnable { showOpened() }
  private val keepRun = Runnable { keepNow() }

  init {
    setBackgroundColor(Theme.bg)
    list.setPalette(Theme.chatList)
    addView(list)
    heading.text = "Чаты"
    heading.textSize = 34f
    heading.typeface = Theme.weight(700)
    heading.setTextColor(Theme.text)
    heading.includeFontPadding = false
    addView(heading)
    newChat.contentDescription = "Новый чат"
    newChat.setOnClickListener { openPeople() }
    addView(newChat)
    empty.text = "Пока нет чатов"
    empty.textSize = 17f
    empty.setTextColor(Theme.muted)
    empty.gravity = Gravity.CENTER
    addView(empty)
    // ChatActions: the rows are made there (swipe buttons, drafts, «Архив», what the search found) and come back here.
    actions.install(this, list)
    // Stories: the strip is the list's header.
    stories.install(this, list)
    actions.onRows = { rows, emptyWords ->
      list.setRows(rows)
      empty.text = emptyWords
      empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
    }
    actions.onHeading = { words -> if (heading.text.toString() != words) heading.text = words }
    actions.onReload = { reload() }
    list.onRowPress = { id ->
      // ChatActions: «Архив», a found message, and the chats of an account are opened there.
      if (!actions.pressed(id)) demo.firstOrNull { it.id == id }?.let { openChat(ChatTarget(it.title)) }
    }
    if (messenger == null) {
      demo = Demo.chats()
      list.setRows(demo)
      empty.visibility = if (demo.isEmpty()) View.VISIBLE else View.GONE
      // ChatActions: the samples as chats the actions can work on.
      if (demo.isNotEmpty()) actions.showSamples(demo)
    } else {
      empty.text = "Загрузка…"
      // Offline: the list as it was shown last time, from the vault — at once, before (or without) the network.
      com.linea.messenger.offline.ChatCache.cachedChats(messenger) { cached ->
        if (!serverLoaded && summaries.isEmpty() && cached.isNotEmpty()) {
          summaries = cached
          actions.show(cached)
        }
      }
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    messenger?.watch(this)
    actions.attached()
    appeared()
  }

  override fun onDetachedFromWindow() {
    messenger?.unwatch(this)
    actions.detached()
    removeCallbacks(reloadSoon)
    showing = false
    super.onDetachedFromWindow()
  }

  /** A chat that covered the list was closed: the page is seen again. */
  override fun onVisibilityChanged(changedView: View, visibility: Int) {
    super.onVisibilityChanged(changedView, visibility)
    appeared()
  }

  /** Asks the server again each time the page comes into view (on opening it and on coming back from a chat). */
  private fun appeared() {
    val seen = isAttachedToWindow && isShown
    if (seen && !showing) reload()
    showing = seen
  }

  /** Something changed on the server: the list is read again (a burst of events is one reading). */
  override fun changed(chatId: String?) {
    removeCallbacks(reloadSoon)
    postDelayed(reloadSoon, 250)
  }

  /** People: the shell this section stands in shows «Люди». */
  private fun openPeople() {
    var above = parent
    while (above != null && above !is RootScreen) above = above.parent
    (above as? RootScreen)?.show("people")
  }

  /** Opens the first chat of the list (for a check on the emulator). */
  fun openFirst() {
    val chat = summaries.firstOrNull() ?: return
    if (messenger != null) actions.open(chat.id, "", animated = false)
  }

  /** Asks the server for the chats again. */
  fun reload() {
    val messenger = messenger ?: return
    // Offline: a line already shown opened is never turned back into a closed one by a fresh list.
    val previous = summaries.filter { it.last.isNotEmpty() }.associate { it.id to it.last }
    messenger.chats(previous) { result ->
      if (!isAttachedToWindow) return@chats
      val chats = result.getOrNull()
      if (chats != null) {
        serverLoaded = true
        summaries = chats
        // ChatActions: shown through `actions.onRows`.
        actions.show(chats)
        keepSoon()
        // Offline: the lines still closed are opened in the background, then shown.
        messenger.catchUpList(chats) { chatId, lastId, line -> lineOpened(chatId, lastId, line) }
      } else if (summaries.isEmpty()) {
        // Offline: the chats on screen (the vault's copy) stay; the words only when there is nothing to show.
        empty.text = Server.error(result).words
        empty.visibility = View.VISIBLE
      }
    }
  }

  /** Offline: a closed line opened in the background; a burst of them is shown once. */
  private fun lineOpened(chatId: String, lastId: Long, line: Map<String, Any?>) {
    opened.add(Triple(chatId, lastId, line))
    removeCallbacks(showOpened)
    postDelayed(showOpened, 200)
  }

  private fun showOpened() {
    val messenger = messenger ?: return
    if (opened.isEmpty()) return
    val lines = opened.toList()
    opened.clear()
    val next = summaries.toMutableList()
    var changed = false
    for ((chatId, lastId, line) in lines) {
      val index = next.indexOfFirst { it.id == chatId }
      if (index < 0) continue
      val chat = next[index]
      // Only for the very message the line was opened for: a newer one may have come meanwhile.
      if (((com.linea.messenger.core.Core.map(chat.chat["lastMessage"])?.get("id") as? Number)?.toLong() ?: 0L) != lastId) continue
      next[index] = messenger.lineSummary(chat.chat, line) ?: continue
      changed = true
    }
    if (!changed) return
    summaries = next
    actions.show(next)
    keepSoon()
  }

  /** Offline: the list as shown goes to the vault a moment after it changes (only once the server answered, so an
   *  empty list at start never overwrites it). */
  private fun keepSoon() {
    removeCallbacks(keepRun)
    postDelayed(keepRun, 1500)
  }

  private fun keepNow() {
    val messenger = messenger ?: return
    if (serverLoaded) com.linea.messenger.offline.ChatCache.storeChats(messenger, summaries)
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    val headingHeight = putText(heading, dp(20f), top + dp(8f), width - dp(40f))
    put(newChat, width - dp(20f) - dp(40f), top + dp(8f), dp(40f), dp(40f))
    val barRoom = dp(BarMetrics.bottomGap(edges.bottom / d) + BarMetrics.height + 12f)
    // ChatActions: the search button beside «Новый чат»; the search field, when open, under the heading.
    val listTop = top + dp(8f) + headingHeight + dp(8f)
    val pad = actions.place(width, top, listTop)
    list.setPad(pad, barRoom)
    // Stories: not in «Архив» and not while searching (the search field takes room under the heading).
    stories.place(allowed = heading.text.toString() == "Чаты" && pad <= listTop)
    put(list, 0, 0, width, height)
    put(empty, dp(20f), height / 2 - dp(24f), width - dp(40f), dp(48f))
  }
}
