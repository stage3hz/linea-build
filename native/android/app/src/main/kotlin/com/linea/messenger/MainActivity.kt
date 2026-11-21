package com.linea.messenger

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import com.linea.messenger.app.ChatTarget
import com.linea.messenger.app.Launcher
import com.linea.messenger.app.Messenger
import com.linea.messenger.app.WaitingScreen
import com.linea.messenger.attachments.Picks
import com.linea.messenger.auth.Account
import com.linea.messenger.auth.AuthScreen
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.settings.AccountHost
import com.linea.messenger.shell.BackGate
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.RootScreen

/** The app's only window: the stack of pages with the shell at its bottom. It decides what the app opens with —
 *  the chats of the signed-in account, or signing in — and holds the account while the window lives. */
class MainActivity : Activity(), Launcher, AccountHost, com.linea.messenger.settings.ThemeHost {
  private lateinit var stack: Navigation
  /** The shell, when it is what the window shows (not while signing in or waiting). */
  private var root: RootScreen? = null
  private var messenger: Messenger? = null
  /** The window is on the screen (between `onStart` and `onStop`). */
  private var front = false
  /** The system's Back on Android 13 and later; before that `onBackPressed` is asked. */
  private var gate: BackGate? = null
  /** Settings: the few words shown over signing in after the account was left (`closeAccount`). */
  private var said: android.app.Dialog? = null
  /** Calls: Back is the app's own while the call screen is open (it minimises the call). */
  private val callWatch: (Unit) -> Unit = { syncBack() }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Account.start(this)
    com.linea.messenger.design.Fonts.install(this) // Fonts: Montserrat and Unbounded, as the reference (design/Fonts.kt)
    edgeToEdge()
    com.linea.messenger.settings.ThemeStore.attach(this) // Settings: the theme the person chose (settings/ThemeStore.kt)
    stack = Navigation(this)
    setContentView(stack)
    if (Build.VERSION.SDK_INT >= 33) {
      gate = BackGate(this, onBack = { goBack() }, onProgress = { if (root?.sectionsOpen != true && !callShown()) stack.backProgress(it) }, onCancel = { stack.backCancelled() })
    }
    stack.onDepthChange = { syncBack() }
    com.linea.messenger.calls.Calls.changed.watch(callWatch)
    start()
  }

  override fun onStart() {
    super.onStart()
    front = true
    com.linea.messenger.settings.ThemeStore.cameBack() // Settings: the night theme may have come by itself
    messenger?.wake()
  }

  override fun onStop() {
    front = false
    messenger?.sleep()
    super.onStop()
  }

  override fun onDestroy() {
    com.linea.messenger.calls.Calls.changed.unwatch(callWatch)
    said?.dismiss()
    messenger?.close()
    messenger = null
    super.onDestroy()
  }

  /** Attachments: what the system's photo picker or file chooser was closed with (attachments/ChatAttachments.kt). */
  @Deprecated("The platform's own way for a plain Activity.")
  @Suppress("DEPRECATION")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
    if (!Picks.result(requestCode, resultCode, data)) super.onActivityResult(requestCode, resultCode, data)
  }

  /** Voice/Video: the system's answer about the microphone or the camera, asked at the moment of the first
   *  recording (voice/VoiceRecorder.kt, `Permits`). */
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    if (!com.linea.messenger.voice.Permits.result(requestCode, grantResults)) super.onRequestPermissionsResult(requestCode, permissions, grantResults)
  }

  /** Decides what the app opens with: the chats of the signed-in account, or signing in. */
  private fun start() {
    // For the emulator check (debug builds only; a release build has an empty `Demo.start`).
    if (Demo.start(intent, this)) return
    val token = Account.token ?: return showAuth()
    Account.cachedUser?.let { return open(token, it) }
    // Signed in by the previous app: the token is there, the profile is asked from the server once.
    showWaiting("Загрузка…")
    Server(Account.server, token).op("me", emptyList()) { result ->
      runOnUiThread {
        if (isDestroyed) return@runOnUiThread
        val user = Core.map(Core.map(result.getOrNull())?.get("user"))
        val error = result.exceptionOrNull()
        when {
          result.isSuccess && user != null -> open(token, user)
          result.isSuccess -> showAuth()
          error is ServerError.Refused && error.status == 401 -> { Account.token = null; showAuth() }
          else -> showWaiting(Server.error(result).words + "\nКоснись, чтобы повторить.")
        }
      }
    }
  }

  private fun open(token: String, user: Map<String, Any?>) {
    try {
      messenger?.close()
      messenger = null
      val made = Messenger(this, token, user)
      messenger = made
      if (!front) made.sleep()
      Account.token = token
      Account.cachedUser = user
      showShell(RootScreen(this, made) { target -> openChat(target, animated = true) })
    } catch (_: Exception) {
      // The storage did not open: nothing is replaced, nothing is deleted — the person is told.
      showWaiting("Не удалось открыть зашифрованное хранилище. Ключи и сообщения сохранены без изменений.\nКоснись, чтобы повторить.")
    }
  }

  private fun showShell(shell: RootScreen) {
    root = shell
    shell.onSectionsChange = { syncBack() }
    stack.setRoot(shell)
    syncBack()
  }

  override fun showAuth() {
    root = null
    val auth = AuthScreen(this, Server(Account.server))
    auth.onSignedIn = { token, user -> open(token, user) }
    stack.setRoot(auth)
    syncBack()
  }

  private fun showWaiting(words: String) {
    root = null
    val screen = WaitingScreen(this, words)
    screen.onRetry = { start() }
    stack.setRoot(screen)
    syncBack()
  }

  override fun showDemo(): RootScreen {
    val shell = RootScreen(this, null) { target -> openChat(target, animated = true) }
    showShell(shell)
    return shell
  }

  override fun signIn(login: String, password: String, word: String) {
    showWaiting("Вход…")
    Server(Account.server).op("login", listOf(login, password, word)) { result ->
      runOnUiThread {
        if (isDestroyed) return@runOnUiThread
        val session = Core.map(result.getOrNull())
        val token = session?.get("token") as? String
        val user = Core.map(session?.get("user"))
        if (token != null && user != null) open(token, user)
        else if (result.isFailure) showWaiting("Вход не удался: " + Server.error(result).words)
      }
    }
  }

  override fun openFirstChat() { root?.openFirstChat() }

  /** Settings: the account was left (signed out, a secret changed, the session ended, the account deleted).
   *  The session is already forgotten (settings/AccountActions.kt); the account's work on this device ends —
   *  its storage and keys stay — and signing in is shown, with a few words why. */
  override fun closeAccount(notice: String) {
    messenger?.close()
    messenger = null
    showAuth()
    if (notice.isEmpty() || isFinishing || isDestroyed) return
    said?.dismiss()
    said = android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert).setMessage(notice).setPositiveButton("Понятно", null).show()
  }

  /** Settings, for the emulator check: the section and one of its pages (settings/SettingsScreen.kt, `openDetail`). */
  override fun openSettings(page: String): Boolean {
    val shell = root ?: return false
    shell.show("profile")
    if (page != "root") shell.settingsPage()?.openDetail(page)
    return true
  }

  /** Settings: nothing lies over the sections (a theme that came by itself is put on only then). */
  override val shellAlone: Boolean get() = root != null && stack.depth == 1 && root?.sectionsOpen != true

  /** Settings: a theme has just been put on — the shell is built again in its colours, on the section that was
   *  open, or with the settings pages `pages` opened again on top (settings/ThemeStore.kt). */
  override fun restyle(pages: List<String>) {
    stack.setBackgroundColor(Theme.bg)
    val shell = root ?: return
    val section = shell.open
    val fresh = shell.rebuilt()
    showShell(fresh)
    if (pages.isEmpty()) return fresh.show(section)
    fresh.show("profile")
    val settings = fresh.settingsPage() ?: return
    for (name in pages) settings.page(name)?.let { stack.push(it, animated = false) }
  }

  override fun openChat(target: ChatTarget, animated: Boolean) {
    stack.push(ChatScreen(this, target.name, messenger.takeIf { target.chatId.isNotEmpty() }, target.chatId, target.peerId, target.peerLastRead) { stack.pop() }, animated)
  }

  /** The page is drawn under the system's bars; every page keeps its own parts clear of them. */
  @Suppress("DEPRECATION")
  private fun edgeToEdge() {
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
    else window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    if (Build.VERSION.SDK_INT >= 28) {
      window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
    }
  }

  /** There is somewhere to go back to inside the app: the open call screen, an open chat, or the open list of
   *  sections. */
  private fun wantsBack(): Boolean = callShown() || stack.depth > 1 || root?.sectionsOpen == true

  private fun syncBack() { gate?.set(wantsBack()) }

  /** Calls: the call screen covers the app (the call is not minimised). */
  private fun callShown(): Boolean {
    val call = com.linea.messenger.calls.Calls.call ?: return false
    return !call.minimized
  }

  private fun goBack() {
    // Calls: Back minimises the call to its bar (an incoming call or one that is ending stays as it is).
    if (callShown()) return com.linea.messenger.calls.Calls.minimize()
    val shell = root
    if (shell != null && shell.sectionsOpen) shell.closeSections() else stack.pop()
  }

  @Deprecated("Android 12 and earlier; later the system asks BackGate.")
  @Suppress("DEPRECATION")
  override fun onBackPressed() {
    if (wantsBack()) goBack() else super.onBackPressed()
  }
}
