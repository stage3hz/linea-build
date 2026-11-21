package com.linea.messenger.chats

import android.annotation.SuppressLint
import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.TextView
import com.linea.messenger.Demo
import com.linea.messenger.app.ChatTarget
import com.linea.messenger.app.Messenger
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Server
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
  private var summaries: List<Messenger.ChatSummary> = emptyList()
  private var demo: List<ChatRow> = emptyList()
  /** The page is in the window and not covered by another one. */
  private var showing = false
  private val reloadSoon = Runnable { reload() }

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
    empty.text = "Пока нет чатов"
    empty.textSize = 17f
    empty.setTextColor(Theme.muted)
    empty.gravity = Gravity.CENTER
    addView(empty)
    list.onRowPress = { id ->
      val chat = summaries.firstOrNull { it.id == id }
      if (chat != null && messenger != null) openChat(target(chat))
      else demo.firstOrNull { it.id == id }?.let { openChat(ChatTarget(it.title)) }
    }
    if (messenger == null) {
      demo = Demo.chats()
      list.setRows(demo)
      empty.visibility = if (demo.isEmpty()) View.VISIBLE else View.GONE
    } else {
      empty.text = "Загрузка…"
    }
  }

  private fun target(chat: Messenger.ChatSummary) = ChatTarget(chat.title, chat.id, chat.peerId, chat.peerLastRead)

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    messenger?.watch(this)
    appeared()
  }

  override fun onDetachedFromWindow() {
    messenger?.unwatch(this)
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

  /** Opens the first chat of the list (for a check on the emulator). */
  fun openFirst() {
    val chat = summaries.firstOrNull() ?: return
    if (messenger != null) openChat(target(chat))
  }

  /** Asks the server for the chats again. */
  fun reload() {
    val messenger = messenger ?: return
    messenger.chats { result ->
      if (!isAttachedToWindow) return@chats
      val chats = result.getOrNull()
      if (chats != null) {
        summaries = chats
        list.setRows(ChatRow.parse(chats.map { it.row }))
        empty.text = "Пока нет чатов"
        empty.visibility = if (chats.isEmpty()) View.VISIBLE else View.GONE
      } else if (summaries.isEmpty()) {
        empty.text = Server.error(result).words
        empty.visibility = View.VISIBLE
      }
    }
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    val headingHeight = putText(heading, dp(20f), top + dp(8f), width - dp(40f))
    val barRoom = dp(BarMetrics.bottomGap(edges.bottom / d) + BarMetrics.height + 12f)
    list.setPad(top + dp(8f) + headingHeight + dp(8f), barRoom)
    put(list, 0, 0, width, height)
    put(empty, dp(20f), height / 2 - dp(24f), width - dp(40f), dp(48f))
  }
}
