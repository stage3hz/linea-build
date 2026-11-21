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
    messenger.chats { result ->
      if (!isAttachedToWindow) return@chats
      val chats = result.getOrNull()
      if (chats != null) {
        summaries = chats
        // ChatActions: shown through `actions.onRows`.
        actions.show(chats)
      } else if (summaries.isEmpty()) {
        empty.text = Server.error(result).words
        empty.visibility = View.VISIBLE
      }
    }
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    val headingHeight = putText(heading, dp(20f), top + dp(8f), width - dp(40f))
    put(newChat, width - dp(20f) - dp(40f), top + dp(8f), dp(40f), dp(40f))
    val barRoom = dp(BarMetrics.bottomGap(edges.bottom / d) + BarMetrics.height + 12f)
    // ChatActions: the search button beside «Новый чат»; the search field, when open, under the heading.
    list.setPad(actions.place(width, top, top + dp(8f) + headingHeight + dp(8f)), barRoom)
    put(list, 0, 0, width, height)
    put(empty, dp(20f), height / 2 - dp(24f), width - dp(40f), dp(48f))
  }
}
