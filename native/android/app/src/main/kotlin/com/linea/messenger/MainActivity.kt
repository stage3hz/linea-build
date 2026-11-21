package com.linea.messenger

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.shell.BackGate
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.RootScreen

/** The app's only window: the stack of pages with the shell at its bottom. */
class MainActivity : Activity() {
  private lateinit var stack: Navigation
  private lateinit var root: RootScreen
  /** The system's Back on Android 13 and later; before that `onBackPressed` is asked. */
  private var gate: BackGate? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    edgeToEdge()
    stack = Navigation(this)
    root = RootScreen(this) { name -> openChat(name, animated = true) }
    stack.setRoot(root)
    setContentView(stack)
    if (Build.VERSION.SDK_INT >= 33) {
      gate = BackGate(this, onBack = { goBack() }, onProgress = { if (!root.sectionsOpen) stack.backProgress(it) }, onCancel = { stack.backCancelled() })
    }
    stack.onDepthChange = { syncBack() }
    root.onSectionsChange = { syncBack() }
    // For the emulator check (debug builds only; a release build has an empty `Demo.launch`).
    if (savedInstanceState == null) Demo.launch(intent, root) { name -> openChat(name, animated = false) }
  }

  private fun openChat(name: String, animated: Boolean) {
    stack.push(ChatScreen(this, name) { stack.pop() }, animated)
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

  /** There is somewhere to go back to inside the app: an open chat, or the open list of sections. */
  private fun wantsBack(): Boolean = stack.depth > 1 || root.sectionsOpen

  private fun syncBack() { gate?.set(wantsBack()) }

  private fun goBack() {
    if (root.sectionsOpen) root.closeSections() else stack.pop()
  }

  @Deprecated("Android 12 and earlier; later the system asks BackGate.")
  @Suppress("DEPRECATION")
  override fun onBackPressed() {
    if (wantsBack()) goBack() else super.onBackPressed()
  }
}
