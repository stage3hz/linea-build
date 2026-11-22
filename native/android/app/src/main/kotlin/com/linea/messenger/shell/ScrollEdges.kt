package com.linea.messenger.shell

import android.content.Context

// Shell: the scroll edges behind the floating bars (the reference's tabInset.tsx `ScrollEdgeEffect`, `TabBarEdge` and
// TabsFade; native/ios/Sources/Shell/ScrollEdges.swift), drawn as the progressive edge of EdgeFade.kt: blurred hardest
// at the screen's edge and thinning out to nothing 24 dp past the bar (Android 12 and later), under a colour wash that
// eases the same way. No hard line, no crisp text next to the glass. Nothing runs per frame.

/** The edge under a floating header (or above a floating bottom bar). `size` in `place`: the bar's height from the
 *  screen's edge, px, the status bar / navigation bar included. */
class ScrollEdgeView(context: Context, top: Boolean) : ProgressiveEdgeView(context, top)

/** The bottom edge behind the floating tab bar: rows passing behind the bar dissolve into the page — nothing readable
 *  under the pill, beside its rounded ends or in the navigation strip below it. */
class TabBarEdgeView(context: Context) : ProgressiveEdgeView(context, false) {
  private val d = resources.displayMetrics.density

  /** `block`: the height of the tab block above the screen's bottom (the pill, its margins, the mini-player when
   *  shown, the navigation bar), px; `lift`: the pill's lower edge above the screen's bottom, px. */
  fun place(width: Int, height: Int, block: Int, lift: Int) {
    val pillTop = maxOf(0, lift) + Math.round(PILL * d)
    place(width, maxOf(pillTop, maxOf(0, block)), height)
  }

  companion object { private const val PILL = 62f }
}

/** The strip under the status bar in the sections without a floating header of their own: a lighter progressive edge
 *  reaching 10 dp below the strip, so rows passing under the clock are not crisp. */
class StatusStripView(context: Context) : ProgressiveEdgeView(context, true) {
  init { reach = 10f; peak = 0.45f }

  fun place(width: Int, safeTop: Int) = place(width, safeTop, 0)
}
