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
