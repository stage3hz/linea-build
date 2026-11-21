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
    com.linea.messenger.language.Language.install(this) // Language: «Язык», before the first screen (language/Language.kt)
    stack = Navigation(this)
    setContentView(stack)
    if (Build.VERSION.SDK_INT >= 33) {
      gate = BackGate(this, onBack = { goBack() }, onProgress = { if (root?.sectionsOpen != true && !callShown()) stack.backProgress(it) }, onCancel = { stack.backCancelled() })
    }
    stack.onDepthChange = { syncBack() }
    com.linea.messenger.calls.Calls.changed.watch(callWatch)
    start()
    // Effects / Security: the snow, the trail, the rime, the palette's page; the code lock (effects/EffectsHost.kt, security/LockGate.kt).
    com.linea.messenger.effects.EffectsHost.attach(this)
    if (!Demo.lockDemo) com.linea.messenger.security.LockGate.attach(this)
    com.linea.messenger.security.LockGate.changed.watch(callWatch)
  }

  override fun onStart() {
    super.onStart()
    front = true
    com.linea.messenger.settings.ThemeStore.cameBack() // Settings: the night theme may have come by itself
    messenger?.wake()
    com.linea.messenger.shell.UpdateGate.cameBack() // Shell: the update window comes back after five minutes away
    com.linea.messenger.security.LockGate.cameBack() // Security: the autolock
    com.linea.messenger.security.AccountNotices.cameBack() // Security: the recovery requests
  }

  override fun onStop() {
    front = false
    com.linea.messenger.shell.UpdateGate.wentAway() // Shell
    com.linea.messenger.security.LockGate.wentAway() // Security: «Сразу» locks now; the time away is kept
    com.linea.messenger.security.AccountNotices.front = false // Security
    messenger?.sleep()
    super.onStop()
  }

  override fun onDestroy() {
    com.linea.messenger.calls.Calls.changed.unwatch(callWatch)
    com.linea.messenger.security.LockGate.changed.unwatch(callWatch) // Security
    said?.dismiss()
    messenger?.close()
    messenger = null
    super.onDestroy()
  }

  /** Attachments: what the system's photo picker or file chooser was closed with (attachments/ChatAttachments.kt). */
  @Deprecated("The platform's own way for a plain Activity.")
  @Suppress("DEPRECATION")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
    if (com.linea.messenger.screenshare.ScreenShare.result(requestCode, resultCode, data)) return // ScreenShare: the system's answer about the screen
    if (!Picks.result(requestCode, resultCode, data)) super.onActivityResult(requestCode, resultCode, data)
  }

  /** Media: the video player's small window (video/VideoPlayer.kt). */
  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    com.linea.messenger.video.VideoPlayer.pipChanged(isInPictureInPictureMode)
  }

  /** Profile: a tapped birthday reminder while the window lives (profile/Birthdays.kt). */
  override fun onNewIntent(intent: android.content.Intent) {
    super.onNewIntent(intent)
    com.linea.messenger.profile.BirthdayReminders.tapped(intent)
    com.linea.messenger.links.DeepLinks.open(this, intent) // Links: an invitation opened while the app runs
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
    com.linea.messenger.profile.BirthdayReminders.tapped(intent) // Profile: opened by a birthday reminder
    com.linea.messenger.links.DeepLinks.open(this, intent) // Links: opened by an invitation (it waits for the account)
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
    shell.onSectionChange = { syncBack() } // Shell: Back from a section goes to «Чаты»
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
    com.linea.messenger.video.KeptMedia.wipe(this) // Media: films kept for watching without the network go with the account
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
    com.linea.messenger.effects.EffectsHost.restyled() // Effects: the backs in the new colours
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
  private fun wantsBack(): Boolean = com.linea.messenger.security.LockGate.isUp || callShown() || stack.depth > 1 || root?.sectionsOpen == true || (stack.depth == 1 && root?.wantsBack == true) // Shell: a section, choosing chats, the update window

  private fun syncBack() { gate?.set(wantsBack()) }

  /** Calls: the call screen covers the app (the call is not minimised). */
  private fun callShown(): Boolean {
    val call = com.linea.messenger.calls.Calls.call ?: return false
    return !call.minimized
  }

  private fun goBack() {
    if (com.linea.messenger.security.LockGate.isUp) return // Security: nothing under the lock is reached
    // Calls: Back minimises the call to its bar (an incoming call or one that is ending stays as it is).
    if (callShown()) return com.linea.messenger.calls.Calls.minimize()
    val shell = root
    if (shell != null && shell.sectionsOpen) shell.closeSections()
    else if (stack.depth == 1 && shell != null) { shell.back(); syncBack() } // Shell: the reference's App.tsx back
    else stack.pop()
  }

  @Deprecated("Android 12 and earlier; later the system asks BackGate.")
  @Suppress("DEPRECATION")
  override fun onBackPressed() {
    if (wantsBack()) goBack() else super.onBackPressed()
  }
}
