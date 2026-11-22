package com.linea.messenger.shell

import android.annotation.TargetApi
import android.content.Context
import android.graphics.BlendMode
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.os.Build
import android.view.View
import android.view.ViewTreeObserver
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import com.linea.messenger.effects.Motion
import kotlin.math.ceil
import kotlin.math.roundToInt

/** The numbers of the progressive edge behind floating bars (native/ios/Sources/Shell/EdgeFade.swift `EdgeRamp`, the
 *  same numbers). Positions are counted from the screen's edge inwards; `size` is the bar's height from that edge (the
 *  status bar / navigation bar included), `total` the whole effect: the bar plus `reach` past its inner edge. Units
 *  are whatever the caller uses (dp or px), as long as they are the same for all arguments.
 *
 *  The idea: what scrolls under a bar is blurred hardest at the very edge of the screen and the blur thins out towards
 *  the content, so there is no line where blurred meets crisp. A colour wash (the page's colour: near-black on dark
 *  themes, near-white on light ones) follows the same course, held at its peak over the outer part of the bar and
 *  easing away past it. Here the ramp is made of a few blurred copies of the page, from a light blur reaching far to
 *  a heavy one reaching only a little way, each laid over the previous and dissolving smoothly at its own depth. */
object EdgeRamp {
  /** How far the effect reaches past the bar's inner edge, dp. */
  const val REACH = 24f
  /** The part of the bar over which the colour and the blur already ease away (ending at `REACH` past it), dp. */
  const val SOFTEN = 30f
  /** How many blurred copies make the ramp. */
  const val LAYERS = 4
  /** Their blur radii, dp, from the one reaching furthest (lightest) to the one closest to the edge (heaviest). */
  val RADII = floatArrayOf(5f, 10f, 18f, 30f)

  /** The colour wash's peak right at the screen's edge (with the blur; without it the wash is a little denser). */
  fun peak(dark: Boolean): Float = if (dark) 0.8f else 0.7f
  /** Without a blur behind it the wash carries everything, so it is laid denser. */
  fun peakWithoutBlur(peak: Float): Float = minOf(1f, peak + 0.12f)

  /** Smooth 1 → 0 between `from` and `to` (1 before `from`, 0 after `to`), with no kink at either end. */
  fun fall(y: Float, from: Float, to: Float): Float {
    if (y <= from) return 1f
    if (y >= to || to <= from) return 0f
    val u = (y - from) / (to - from)
    return 1f - u * u * (3f - 2f * u)
  }

  /** Where the colour starts easing away. `soften`: SOFTEN in the caller's units. */
  fun holdEnd(size: Float, total: Float, soften: Float): Float = maxOf(0f, minOf(total * 0.8f, size - soften))

  /** The colour wash at `y` (0…1 of the peak). */
  fun wash(y: Float, size: Float, total: Float, soften: Float): Float = fall(y, holdEnd(size, total, soften), total)

  /** Where the blurred copy `index` (0 = the one reaching furthest) starts thinning and where it is gone. */
  fun layerSpan(index: Int, size: Float, total: Float, soften: Float): Pair<Float, Float> {
    val rampStart = holdEnd(size, total, soften)
    val ramp = maxOf(1f, total - rampStart)
    val step = ramp / LAYERS
    val end = maxOf(1f, total - index * step)
    val start = maxOf(0f, end - ramp * 0.5f)
    return start to end
  }

  /** How many layers act at `y` (0…LAYERS): the blur ramp, for tests and checks. */
  fun blurAt(y: Float, size: Float, total: Float, soften: Float): Float {
    var sum = 0f
    for (index in 0 until LAYERS) {
      val (start, end) = layerSpan(index, size, total, soften)
      sum += fall(y, start, end)
    }
    return sum
  }

  /** Gradient stops (position 0…1 from the edge, value 0…1) for a course that only changes between `from` and `to`:
   *  one stop at each end of the view and `count` across the change. */
  fun samples(total: Float, from: Float, to: Float, count: Int = 10, value: (Float) -> Float): List<Pair<Float, Float>> {
    if (total <= 0f || count < 2) return listOf(0f to 1f, 1f to 0f)
    val low = from.coerceIn(0f, total)
    val high = to.coerceIn(low, total)
    val out = ArrayList<Pair<Float, Float>>()
    if (low > 0f) out.add(0f to value(0f))
    for (i in 0 until count) {
      val y = low + (high - low) * i / (count - 1)
      out.add(y / total to value(y))
    }
    if (high < total) out.add(1f to value(total))
    return out
  }
}

/** Shell: a progressive edge behind a floating bar — blurred copies of the page behind (Android 12 and later, on a
 *  hardware-accelerated canvas) ramping from a heavy blur at the screen's edge to nothing `REACH` dp past the bar,
 *  under a colour wash easing the same way. Below Android 12 and in power saving: the wash alone, denser.
 *
 *  What it blurs: a [GlassSource] page (its recorded drawing is reused, nothing is drawn twice) or any other view
 *  (drawn again into a small node when the page scrolls or lays out). Either must NOT contain this view. It redraws
 *  only on a scroll, a layout or a change of its own; nothing runs per frame. The glass bars stay above it. */
open class ProgressiveEdgeView(context: Context, val top: Boolean) : View(context) {
  /** The wash's colour (0xRRGGBB, any alpha ignored); null: the page's colour. */
  var color: Int? = null
    set(value) { field = value; invalidate() }
  /** The wash's peak; null: EdgeRamp.peak for the colour's lightness. */
  var peak: Float? = null
    set(value) { field = value; invalidate() }
  /** How far past the bar the effect reaches, dp (used by `place`). */
  var reach = EdgeRamp.REACH
  /** The bar's height from the screen's edge, px (set by `place`, or by an owner that lays the view out itself). */
  var size = 0f
    set(value) { if (field != value) { field = value; invalidate() } }
  /** The page behind as a recorded GlassSource (preferred), or any view. */
  var glass: GlassSource? = null
    set(value) { field = value; invalidate() }
  var source: View? = null
    set(value) { field = value; invalidate() }

  private val d = resources.displayMetrics.density
  private val paint = Paint()
  private val blur: Any? = if (Build.VERSION.SDK_INT >= 31) EdgeBlur() else null
  private val here = IntArray(2)
  private val there = IntArray(2)
  private val redraw = ViewTreeObserver.OnScrollChangedListener { postInvalidateOnAnimation() }
  private val relaid = ViewTreeObserver.OnGlobalLayoutListener { if (glass != null || source != null) postInvalidateOnAnimation() }
  private val motionWatcher: (Unit) -> Unit = { invalidate() }

  init { isClickable = false; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnScrollChangedListener(redraw)
    viewTreeObserver.addOnGlobalLayoutListener(relaid)
    Motion.changed.watch(motionWatcher)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnScrollChangedListener(redraw)
    viewTreeObserver.removeOnGlobalLayoutListener(relaid)
    Motion.changed.unwatch(motionWatcher)
    super.onDetachedFromWindow()
  }

  /** `size`: the bar's height from the screen's edge, px; `height`: the container's height (for a bottom edge). Lays
   *  itself out. */
  fun place(width: Int, size: Int, height: Int) {
    this.size = size.toFloat()
    visibility = if (size <= 0) GONE else VISIBLE
    if (size <= 0) return
    val total = size + (reach * d).roundToInt()
    val y = if (top) 0 else height - total
    measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(total, MeasureSpec.EXACTLY))
    layout(0, y, width, y + total)
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val total = height.toFloat()
    if (total <= 0f || width <= 0) return
    val rgb = (color ?: Theme.bg) and 0xFFFFFF
    val dark = lightness(rgb) < 0.5f
    val basePeak = minOf(1f, peak ?: EdgeRamp.peak(dark))
    val soften = EdgeRamp.SOFTEN * d
    var blurred = false
    val node = blur
    val page = glass
    val other = source
    if (Build.VERSION.SDK_INT >= 31 && node is EdgeBlur && canvas.isHardwareAccelerated && !Motion.saving && isAttachedToWindow) {
      val behind: View? = page ?: other
      if (behind != null && behind.isAttachedToWindow) {
        getLocationInWindow(here); behind.getLocationInWindow(there)
        blurred = try {
          node.draw(canvas, width, height, size, top, soften, d, page, if (page == null) other else null, there[0] - here[0], there[1] - here[1], Theme.bg)
        } catch (_: RuntimeException) { false }
      }
    }
    val washPeak = if (blurred) basePeak else EdgeRamp.peakWithoutBlur(basePeak)
    val stops = EdgeRamp.samples(total, EdgeRamp.holdEnd(size, total, soften), total, 12) { y -> EdgeRamp.wash(y, size, total, soften) }
    val colors = IntArray(stops.size) { argb(rgb, washPeak * stops[it].second) }
    val positions = FloatArray(stops.size) { stops[it].first }
    paint.shader = if (top) LinearGradient(0f, 0f, 0f, total, colors, positions, Shader.TileMode.CLAMP)
    else LinearGradient(0f, total, 0f, 0f, colors, positions, Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), total, paint)
  }

  private fun lightness(rgb: Int): Float {
    val r = (rgb shr 16) and 0xFF; val g = (rgb shr 8) and 0xFF; val b = rgb and 0xFF
    return (0.299f * r + 0.587f * g + 0.114f * b) / 255f
  }

  private fun argb(rgb: Int, alpha: Float): Int = ((alpha.coerceIn(0f, 1f) * 255).roundToInt() shl 24) or (rgb and 0xFFFFFF)
}

/** The blurred copies: the page behind drawn once into a small node (a quarter… a third of the size: a blur does not
 *  need the detail), then the same node shown through LAYERS nodes, each with its own blur and its own gradient mask
 *  (the mask is applied inside the node's effect, so no extra offscreen layer is needed). */
@TargetApi(31)
private class EdgeBlur {
  private val content = RenderNode("edge-content")
  private val layers = Array(EdgeRamp.LAYERS) { RenderNode("edge-blur-$it") }
  private var effectKey = ""

  /** False when there was nothing to blur. */
  fun draw(canvas: Canvas, width: Int, height: Int, size: Float, top: Boolean, soften: Float, density: Float,
           page: GlassSource?, other: View?, dx: Int, dy: Int, background: Int): Boolean {
    val pageNode = page?.renderNode()
    if (page != null && (pageNode == null || !pageNode.hasDisplayList())) return false
    if (page == null && other == null) return false
    val scale = SCALE
    val w = maxOf(1, ceil(width / scale).toInt())
    val h = maxOf(1, ceil(height / scale).toInt())
    content.setPosition(0, 0, w, h)
    val recording = content.beginRecording()
    try {
      recording.scale(1f / scale, 1f / scale)
      recording.drawColor(background)
      recording.translate(dx.toFloat(), dy.toFloat())
      if (pageNode != null) recording.drawRenderNode(pageNode) else other?.draw(recording)
    } finally { content.endRecording() }

    val total = height.toFloat()
    val key = "$w|$h|$size|$top|$soften"
    val fresh = key != effectKey
    effectKey = key
    for (index in layers.indices) {
      val layer = layers[index]
      layer.setPosition(0, 0, w, h)
      if (fresh) {
        val (start, end) = EdgeRamp.layerSpan(index, size, total, soften)
        val stops = EdgeRamp.samples(total, start, end, 8) { y -> EdgeRamp.fall(y, start, end) }
        val colors = IntArray(stops.size) { ((stops[it].second.coerceIn(0f, 1f) * 255).roundToInt() shl 24) }
        val positions = FloatArray(stops.size) { stops[it].first }
        val hh = h.toFloat()
        val mask = if (top) LinearGradient(0f, 0f, 0f, hh, colors, positions, Shader.TileMode.CLAMP)
        else LinearGradient(0f, hh, 0f, 0f, colors, positions, Shader.TileMode.CLAMP)
        val radius = maxOf(0.5f, EdgeRamp.RADII[index] * density / scale)
        layer.setRenderEffect(RenderEffect.createBlendModeEffect(
          RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP),
          RenderEffect.createShaderEffect(mask),
          BlendMode.DST_IN))
      }
      val inner = layer.beginRecording()
      try { inner.drawRenderNode(content) } finally { layer.endRecording() }
    }
    canvas.save()
    canvas.scale(scale, scale)
    for (layer in layers) canvas.drawRenderNode(layer)
    canvas.restore()
    return true
  }

  companion object { const val SCALE = 3f }
}
