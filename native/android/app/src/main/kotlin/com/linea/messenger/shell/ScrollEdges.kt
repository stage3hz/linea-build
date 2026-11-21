package com.linea.messenger.shell

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.view.View
import com.linea.messenger.design.Theme

/** Shell: the scroll-edge effect behind floating bars (the reference's tabInset.tsx `ScrollEdgeEffect`,
 *  native/ios/Sources/Shell/ScrollEdges.swift): the content under a bar is covered by the page's colour over the bar,
 *  then dissolves across its inner edge — fully covered up to 14 dp short of it, then a soft ramp ending `fade` dp past
 *  it. No hard line, no crisp text next to the glass. This side has no blur of what scrolls under it, so the colour
 *  alone does the work, as the iPhone does with Reduce Transparency. Static: nothing runs per frame. */
class ScrollEdgeView(context: Context, private val top: Boolean) : View(context) {
  /** The page's colour. */
  var color: Int = Theme.bg
  var fade = 8f
  private val d = resources.displayMetrics.density
  private val paint = Paint()
  private var size = 0

  init { isClickable = false; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  /** `size`: the bar's height from the screen edge, px (status bar included); `height`: the container's height (for a
   *  bottom edge). Lays itself out. */
  fun place(width: Int, size: Int, height: Int) {
    this.size = size
    visibility = if (size <= 0) GONE else VISIBLE
    if (size <= 0) return
    val total = size + (fade * d).toInt()
    val y = if (top) 0 else height - total
    measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(total, MeasureSpec.EXACTLY))
    layout(0, y, width, y + total)
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val total = height.toFloat()
    if (total <= 0) return
    val solid = ((size - 14f * d) / total).coerceIn(0f, 1f)
    val colors = intArrayOf(Theme.alpha(color, 1f), Theme.alpha(color, 0.9f), Theme.alpha(color, 0.45f), Theme.alpha(color, 0f))
    val stops = floatArrayOf(0f, solid, solid + (1 - solid) * 0.45f, 1f)
    paint.shader = if (top) LinearGradient(0f, 0f, 0f, total, colors, stops, Shader.TileMode.CLAMP)
    else LinearGradient(0f, total, 0f, 0f, colors, stops, Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), total, paint)
  }
}

/** Shell: the bottom scroll-edge effect behind the floating tab bar (the reference's `TabBarEdge` with chatLayout.ts
 *  `tabBarEdge`, `TAB_BAR_EDGE_SOFT` and `TAB_BAR_EDGE_SOFT_FADE`): rows passing behind the bar dissolve into the page
 *  — nothing readable under the pill, beside its rounded ends or in the navigation strip below it; rows above the bar
 *  are untouched. Without the iPhone's blur the colour is laid denser than its 0.34, so that nothing stays crisp. */
class TabBarEdgeView(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val paint = Paint()
  private var pillBottom = 0f
  private var pillTop = 0f

  init { isClickable = false; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  /** `block`: the height of the tab block above the screen's bottom (the pill, its margins, the mini-player when
   *  shown, the navigation bar), px; `lift`: the pill's lower edge above the screen's bottom, px. */
  fun place(width: Int, height: Int, block: Int, lift: Int) {
    pillBottom = maxOf(0, lift).toFloat()
    pillTop = pillBottom + PILL * d
    val total = (maxOf(pillTop, maxOf(0, block).toFloat()) + SOFT_FADE * d).toInt()
    measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(total, MeasureSpec.EXACTLY))
    layout(0, height - total, width, height)
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val total = height.toFloat()
    if (total <= 0) return
    fun at(points: Float) = (points / total).coerceIn(0f, 1f)
    val color = Theme.bg
    val colors = SOFT.map { Theme.alpha(color, it) }.toIntArray()
    val stops = floatArrayOf(0f, at(pillBottom + PILL * d * 0.2f), at(pillBottom + PILL * d * 0.6f), at(pillTop), 1f)
    paint.shader = LinearGradient(0f, total, 0f, 0f, colors, stops, Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), total, paint)
  }

  companion object {
    private const val PILL = 62f
    private val SOFT = floatArrayOf(0.9f, 0.82f, 0.6f, 0.26f, 0f)
    private const val SOFT_FADE = 22f
  }
}

/** Shell: the strip under the status bar (the reference's TabsFade top part): the page's colour fading out over the
 *  strip and 10 dp below it, so rows passing under the clock are not crisp. */
class StatusStripView(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val paint = Paint()

  init { isClickable = false; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  fun place(width: Int, safeTop: Int) {
    visibility = if (safeTop <= 0) GONE else VISIBLE
    if (safeTop <= 0) return
    val total = safeTop + (10 * d).toInt()
    measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(total, MeasureSpec.EXACTLY))
    layout(0, 0, width, total)
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    paint.shader = LinearGradient(0f, 0f, 0f, height.toFloat(), intArrayOf(Theme.alpha(Theme.bg, 0.6f), Theme.alpha(Theme.bg, 0f)), null, Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
  }
}
