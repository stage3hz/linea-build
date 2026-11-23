package com.linea.messenger.shell

import android.content.Context
import kotlin.math.roundToInt

// Shell: the scroll edges behind the floating bars (the reference's tabInset.tsx `ScrollEdgeEffect`, `TabBarEdge` and
// TabsFade; native/ios/Sources/Shell/ScrollEdges.swift), drawn as the progressive edge of EdgeFade.kt: blurred hardest
// at the screen's edge and thinning out to nothing 24 dp past the bar (Android 12 and later), under a colour wash that
// eases the same way. No hard line, no crisp text next to the glass. Nothing runs per frame.

/** The edge under a floating header (or above a floating bottom bar). `size` in `place`: the bar's height from the
 *  screen's edge, px, the status bar / navigation bar included. */
class ScrollEdgeView(context: Context, top: Boolean) : ProgressiveEdgeView(context, top)

/** The bottom edge behind the floating tab bar: rows passing behind the bar dissolve into the page — nothing readable
 *  under the pill, beside its rounded ends or in the navigation strip below it. The reference's own Android recipe
 *  (tabInset.tsx `TabBarEdge` without the iPhone's blur, chatLayout.ts `tabBarEdge`): the page's colour at .97 from the
 *  screen's bottom, .94 a fifth up the pill, .66 at three fifths, .3 at its top, gone 8 dp above it. (The iPhone keeps
 *  its lighter cover over a blur; without the blur that cover left the rows crossing the bar fully readable.) */
class TabBarEdgeView(context: Context) : ProgressiveEdgeView(context, false) {
  private val d = resources.displayMetrics.density
  private val paint = android.graphics.Paint()
  private var pillBottom = 0f

  init { reach = 8f; fade = 8f; peak = 0.97f }

  /** `block`: the height of the tab block above the screen's bottom (the pill, its margins, the mini-player when
   *  shown, the navigation bar), px; `lift`: the pill's lower edge above the screen's bottom, px. */
  fun place(width: Int, height: Int, block: Int, lift: Int) {
    pillBottom = maxOf(0, lift).toFloat()
    val pillTop = maxOf(0, lift) + Math.round(PILL * d)
    place(width, maxOf(pillTop, maxOf(0, block)), height)
  }

  override fun onDraw(canvas: android.graphics.Canvas) {
    val total = height.toFloat()
    if (total <= 0f || width <= 0) return
    val pill = PILL * d
    fun at(fromBottom: Float) = (fromBottom / total).coerceIn(0f, 1f)
    val rgb = (color ?: com.linea.messenger.design.Theme.bg) and 0xFFFFFF
    val alphas = floatArrayOf(0.97f, 0.94f, 0.66f, 0.3f, 0f)
    val colors = IntArray(alphas.size) { ((alphas[it] * 255).roundToInt() shl 24) or rgb }
    val positions = floatArrayOf(0f, at(pillBottom + pill * 0.2f), at(pillBottom + pill * 0.6f), at(pillBottom + pill), 1f)
    // From the screen's bottom up.
    paint.shader = android.graphics.LinearGradient(0f, total, 0f, 0f, colors, positions, android.graphics.Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), total, paint)
  }

  companion object { private const val PILL = 62f }
}

/** The strip under the status bar in the sections without a floating header of their own: a lighter progressive edge
 *  reaching 10 dp below the strip, so rows passing under the clock are not crisp. */
class StatusStripView(context: Context) : ProgressiveEdgeView(context, true) {
  init { reach = 10f; fade = 1000f; peak = 0.45f } // fades over its whole height

  fun place(width: Int, safeTop: Int) = place(width, safeTop, 0)
}
