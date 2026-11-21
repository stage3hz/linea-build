package com.linea.messenger

import android.content.Intent
import com.linea.messenger.app.Launcher
import com.linea.messenger.chat.MsgRow
import com.linea.messenger.chats.ChatRow

/** The release build's side of the demo (see src/debug): no made-up chats, no made-up messages, nothing to
 *  "send" with, no launch arguments, and no server but the real one. */
object Demo {
  fun chats(): List<ChatRow> = emptyList()

  fun messages(): List<MsgRow> = emptyList()

  val send: ((rows: List<MsgRow>, text: String) -> List<MsgRow>)? = null

  /** A release build is never pointed at a test server. */
  val testServer: String? get() = null

  /** A release build's sign-in screen always opens at its first step, and has no made-up recovery request. */
  val authMode: String? get() = null
  const val authLogin = ""

  /** Security: a release build always reads the real lock. */
  val lockDemo: Boolean get() = false

  /** A release build shows no made-up person in the settings. */
  fun settingsPerson(): Map<String, Any?> = emptyMap()

  @Suppress("UNUSED_PARAMETER")
  fun start(intent: Intent?, launcher: Launcher): Boolean = false
}
