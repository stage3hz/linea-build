package com.linea.messenger.shell

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.view.View
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import kotlin.math.roundToInt

/** The numbers of the soft edge behind floating bars (native/ios/Sources/Shell/EdgeFade.swift `EdgeRamp`, the same
 *  numbers). Positions are counted from the screen's edge inwards; `total` is the whole effect: the bar plus `reach`
 *  past its inner edge. Units are whatever the caller uses, the same for all arguments.
 *
 *  Owner (device photos, compared side by side with the big messenger he pointed to): no heavy blur — what scrolls
 *  under a bar is covered by the page's colour at a fixed strength, solid from the screen's edge and fading out along
 *  an S-shaped course over the last `fade`. The page's colour comes from the theme, the chat's from its wallpaper. */
object EdgeRamp {
  /** The chat list's and settings' header: 14 dp past the header, fading over 54 dp, colour at .85. */
  const val REACH = 14f
  const val FADE = 54f
  const val STRENGTH = 0.85f

  /** The fading course (0 = where it starts fading, 1 = its inner end) → share of the full strength: measured points
   *  of the S-curve, evenly spaced; straight pieces between them. */
  val COURSE = floatArrayOf(1.0f, 0.987f, 0.956f, 0.901f, 0.802f, 0.656f, 0.483f, 0.317f, 0.179f, 0.089f, 0.044f, 0.022f, 0.0f)

  /** The share of the strength at `y` from the screen's edge. */
  fun wash(y: Float, total: Float, fade: Float): Float {
    val start = maxOf(0f, total - maxOf(1f, fade))
    if (y <= start) return 1f
    if (y >= total) return 0f
    val t = (y - start) / maxOf(1f, total - start) * (COURSE.size - 1)
    val index = minOf(COURSE.size - 2, t.toInt())
    val part = t - index
    return COURSE[index] + (COURSE[index + 1] - COURSE[index]) * part
  }

  /** Gradient stops (position 0…1 from the screen's edge, share 0…1) for the whole effect. */
  fun stops(total: Float, fade: Float): List<Pair<Float, Float>> {
    if (total <= 0f) return listOf(0f to 1f, 1f to 0f)
    val start = maxOf(0f, total - maxOf(1f, fade))
    val out = ArrayList<Pair<Float, Float>>()
    if (start > 0f) out.add(0f to 1f)
    for (i in COURSE.indices) out.add((start + (total - start) * i / (COURSE.size - 1)) / total to COURSE[i])
    return out
  }
}

/** Shell: the soft edge behind a floating bar — the page's colour, solid from the screen's edge, fading out `reach` dp
 *  past the bar along EdgeRamp's course. Nothing runs per frame. The glass bars stay above it. */
open class ProgressiveEdgeView(context: Context, private val top: Boolean) : View(context) {
  /** The colour (0xRRGGBB, any alpha ignored); null: the page's colour. */
  var color: Int? = null
    set(value) { field = value; invalidate() }
  /** The colour's strength; null: EdgeRamp.STRENGTH. */
  var peak: Float? = null
    set(value) { field = value; invalidate() }
  /** How far past the bar the effect reaches, dp (used by `place`). */
  var reach = EdgeRamp.REACH
  /** Over how many dp (ending at `reach` past the bar) the colour fades out. */
  var fade = EdgeRamp.FADE
    set(value) { field = value; invalidate() }
  /** A top edge only: the status bar's height, px. The colour is laid a second time over it (fading out 10 dp below,
   *  as the reference's extra status-bar layer), so under the clock the cover is near-solid (1 − (1 − strength)²)
   *  and nothing scrolling there stays readable; the strength itself is unchanged. */
  var statusBand = 0
    set(value) { if (field != value) { field = value; invalidate() } }
  /** Solid over the whole bar: the fade (still `fade` long) begins only at the bar's inner edge, so nothing behind the
   *  bar's clear glass shows through; false: the fade ends `reach` past the bar (and may begin inside it). */
  var solidThroughBar = false
  /** The whole effect past the bar, dp: `reach`, or the whole `fade` when solid through the bar. */
  val past: Float get() = if (solidThroughBar) maxOf(reach, fade) else reach
  /** The bar's height from the screen's edge, px (set by `place`, or by an owner that lays the view out itself). */
  var size = 0f
    set(value) { if (field != value) { field = value; invalidate() } }
  /** Kept for callers; the edge draws only colour now (no blur of the page behind). */
  var glass: GlassSource? = null
  var source: View? = null

  private val d = resources.displayMetrics.density
  private val paint = Paint()

  init { isClickable = false; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  /** `size`: the bar's height from the screen's edge, px; `height`: the container's height (for a bottom edge). Lays
   *  itself out. */
  fun place(width: Int, size: Int, height: Int) {
    this.size = size.toFloat()
    visibility = if (size <= 0) GONE else VISIBLE
    if (size <= 0) return
    val total = size + (past * d).roundToInt()
    val y = if (top) 0 else height - total
    measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(total, MeasureSpec.EXACTLY))
    layout(0, y, width, y + total)
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val total = height.toFloat()
    if (total <= 0f || width <= 0) return
    val rgb = (color ?: Theme.bg) and 0xFFFFFF
    val strength = (peak ?: EdgeRamp.STRENGTH).coerceIn(0f, 1f)
    val stops = EdgeRamp.stops(total, fade * d)
    val colors = IntArray(stops.size) { argb(rgb, strength * stops[it].second) }
    val positions = FloatArray(stops.size) { stops[it].first }
    paint.shader = if (top) LinearGradient(0f, 0f, 0f, total, colors, positions, Shader.TileMode.CLAMP)
    else LinearGradient(0f, total, 0f, 0f, colors, positions, Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), total, paint)
    val bandSolid = if (top) minOf(total, statusBand.toFloat()) else 0f
    if (bandSolid > 0f) {
      val bandHeight = minOf(total, bandSolid + 10 * d)
      val full = argb(rgb, strength)
      paint.shader = LinearGradient(0f, 0f, 0f, bandHeight, intArrayOf(full, full, argb(rgb, 0f)), floatArrayOf(0f, bandSolid / bandHeight, 1f), Shader.TileMode.CLAMP)
      canvas.drawRect(0f, 0f, width.toFloat(), bandHeight, paint)
    }
  }

  private fun argb(rgb: Int, alpha: Float): Int = ((alpha.coerceIn(0f, 1f) * 255).roundToInt() shl 24) or (rgb and 0xFFFFFF)
}
