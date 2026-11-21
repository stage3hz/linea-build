package com.linea.messenger

import android.content.Intent
import com.linea.messenger.chat.MsgRow
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.shell.RootScreen

/** The release build's side of the demo (see src/debug): no made-up chats, no made-up messages, nothing to
 *  "send" with, and no launch arguments. */
object Demo {
  fun chats(): List<ChatRow> = emptyList()

  fun messages(): List<MsgRow> = emptyList()

  val send: ((rows: List<MsgRow>, text: String) -> List<MsgRow>)? = null

  @Suppress("UNUSED_PARAMETER")
  fun launch(intent: Intent?, root: RootScreen, openChat: (name: String) -> Unit) = Unit
}
