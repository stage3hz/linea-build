package com.linea.messenger.chats

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.TextView
import com.linea.messenger.Demo
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.Theme
import com.linea.messenger.shell.Screen

/** The first section: the list of chats. */
class ChatsScreen(context: Context, private val openChat: (name: String) -> Unit) : Screen(context) {
  private val heading = TextView(context)
  private val list = ChatListView(context)
  private val empty = TextView(context)

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
    // Made-up chats in a debug build; none in a release one (there is no account behind the list yet).
    val rows = Demo.chats()
    list.setRows(rows)
    empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
    list.onRowPress = { id -> rows.firstOrNull { it.id == id }?.let { openChat(it.title) } }
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
