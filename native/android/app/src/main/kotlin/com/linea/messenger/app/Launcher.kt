package com.linea.messenger.app

import com.linea.messenger.shell.RootScreen

/** One chat to open: the person's name, and — for a real chat — its id, the other side's id and how far they read. */
class ChatTarget(val name: String, val chatId: String = "", val peerId: String = "", val peerLastRead: Long = 0)

/** What the launch arguments of the emulator check may ask the window to do (see `Demo` of src/debug; a release
 *  build has no launch arguments and asks for none of this). */
interface Launcher {
  /** The shell with sample chats, no account behind it. */
  fun showDemo(): RootScreen
  fun openChat(target: ChatTarget, animated: Boolean)
  /** The sign-in screen. */
  fun showAuth()
  /** Signs in to the server the app is pointed at, without the screen. */
  fun signIn(login: String, password: String, word: String)
  /** With an account: opens the first chat of the list. */
  fun openFirstChat()
  /** «Настройки» and one of its pages (`root` — the section itself). False while the shell is not on the screen yet. */
  fun openSettings(page: String): Boolean = false
}
