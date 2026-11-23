package com.linea.messenger.design

import android.annotation.TargetApi
import android.os.Build
import android.view.WindowInsets

/** What the system covers of the screen, px: the status bar and cut-outs at the top, the navigation bar at the
 *  bottom, and the keyboard's height when it is up (0 otherwise). */
data class Edges(val top: Int, val bottom: Int, val keyboard: Int) {
  companion object { val none = Edges(0, 0, 0) }
}

fun WindowInsets.edges(): Edges = if (Build.VERSION.SDK_INT >= 30) NewInsets.read(this) else oldEdges(this)

@Suppress("DEPRECATION")
private fun oldEdges(insets: WindowInsets): Edges {
  // Before Android 11 the keyboard is part of the window's bottom inset; the bar alone is the "stable" one.
  val bar = insets.stableInsetBottom
  val all = insets.systemWindowInsetBottom
  return Edges(insets.systemWindowInsetTop, bar, if (all > bar) all else 0)
}

@TargetApi(30)
private object NewInsets {
  fun read(insets: WindowInsets): Edges {
    val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
    return Edges(bars.top, bars.bottom, insets.getInsets(WindowInsets.Type.ime()).bottom)
  }
}

/** A dialog that is a page of its own (a viewer, an editor, a menu over the whole screen, a panel): its window covers
 *  the whole screen — under the status bar, the navigation bar and a cut-out — as the activity's does
 *  (MainActivity.edgeToEdge), the bars transparent over its own colour, their icons light on a dark page. Without it a
 *  dialog's window stops at the bars (or, full-screen, at a cut-out), and the bands above and below show what lies
 *  behind it: a lighter strip over a black viewer, black strips around a blurred menu. The page keeps its own parts
 *  clear of the bars (its window insets). On the iPhone such pages are full-screen covers. */
@Suppress("DEPRECATION")
fun android.view.Window.coverScreen(darkPage: Boolean) {
  setLayout(android.view.WindowManager.LayoutParams.MATCH_PARENT, android.view.WindowManager.LayoutParams.MATCH_PARENT)
  // The status bar stays shown (the iPhone's viewers keep the clock): a full-screen theme's hiding is undone.
  clearFlags(android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN)
  addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
  statusBarColor = android.graphics.Color.TRANSPARENT
  navigationBarColor = android.graphics.Color.TRANSPARENT
  if (Build.VERSION.SDK_INT >= 29) { isStatusBarContrastEnforced = false; isNavigationBarContrastEnforced = false }
  if (Build.VERSION.SDK_INT >= 28) attributes = attributes.apply { layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
  if (Build.VERSION.SDK_INT >= 30) {
    setDecorFitsSystemWindows(false)
    val light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
    insetsController?.setSystemBarsAppearance(if (darkPage) 0 else light, light)
  } else {
    var flags = android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE or android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    if (!darkPage && Build.VERSION.SDK_INT >= 23) flags = flags or android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
    decorView.systemUiVisibility = flags
  }
}

/** `coverScreen` for a file that does not import it. */
fun coverWindow(window: android.view.Window, darkPage: Boolean) = window.coverScreen(darkPage)

/** `edges()` for a file that does not import it. */
fun coverEdges(insets: WindowInsets): Edges = insets.edges()

/** A sheet at the bottom of the screen (a dialog's window at `Gravity.BOTTOM`): its window reaches the screen's
 *  bottom, under the navigation bar, and `sheet` — the view that draws the sheet's colour — grows by the bar (or the
 *  keyboard) at its bottom, as padding, so the sheet's colour runs to the screen's edge and its last part stays
 *  above the bar. Without it the sheet stopped above the bar with a slice of the page (the tab bar) showing beneath.
 *  (Android 11 and later; before that the sheet keeps the system's place above the bar.) */
fun android.view.Window.sheetToBottom(sheet: android.view.View) {
  if (Build.VERSION.SDK_INT < 30) return
  addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
  navigationBarColor = android.graphics.Color.TRANSPARENT
  isNavigationBarContrastEnforced = false
  setDecorFitsSystemWindows(false)
  attributes = attributes.apply { fitInsetsTypes = WindowInsets.Type.statusBars() }
  val base = sheet.paddingBottom
  sheet.setOnApplyWindowInsetsListener { view, insets ->
    val edges = insets.edges()
    val want = base + maxOf(edges.bottom, edges.keyboard)
    if (view.paddingBottom != want) view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, want)
    insets
  }
  sheet.requestApplyInsets()
}

/** `sheetToBottom` for a file that does not import it. */
fun sheetWindow(window: android.view.Window, sheet: android.view.View) = window.sheetToBottom(sheet)
