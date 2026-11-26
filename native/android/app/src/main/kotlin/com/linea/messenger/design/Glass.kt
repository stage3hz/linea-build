package com.linea.messenger.design

import android.annotation.TargetApi
import android.content.Context
import android.graphics.Canvas
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.os.Build
import android.view.View
import android.widget.FrameLayout
import com.linea.messenger.effects.EffectsHost
import com.linea.messenger.effects.Rime

/** What stands behind glass: a layout that keeps the drawing of its children in one node, so that a plate of
 *  glass above it can draw the same picture again, blurred. On Android 12 and later only; before that it is a
 *  plain FrameLayout. Recording costs nothing extra: the children are drawn once, into the node. */
open class GlassSource(context: Context) : FrameLayout(context) {
  private val recorder: Any? = if (Build.VERSION.SDK_INT >= 31) SourceNode() else null

  override fun dispatchDraw(canvas: Canvas) {
    val node = recorder
    if (Build.VERSION.SDK_INT >= 31 && node is SourceNode && canvas.isHardwareAccelerated) node.draw(this, canvas) { super.dispatchDraw(it) }
    else super.dispatchDraw(canvas)
  }

  /** The node with the children's drawing; null where glass is a plain fill. */
  internal fun node(): Any? = recorder

  /** The same node typed, for the progressive edges behind bars (shell/EdgeFade.kt); null before Android 12. */
  @TargetApi(31)
  internal fun renderNode(): RenderNode? = (recorder as? SourceNode)?.node
}

@TargetApi(31)
private class SourceNode {
  val node = RenderNode("glass-source")

  fun draw(view: View, canvas: Canvas, children: (Canvas) -> Unit) {
    node.setPosition(0, 0, view.width, view.height)
    val recording = node.beginRecording()
    try { children(recording) } finally { node.endRecording() }
    canvas.drawRenderNode(node)
  }
}

/** A plate of glass drawn by `owner`: the page behind it blurred (Android 12 and later, on a
 *  hardware-accelerated canvas), under a translucent fill and a thin rim. Where the blur is not available the fill
 *  alone is drawn, and denser. Dark glass with a light rim on a dark theme (as it always was); on a light theme
 *  light glass with a faint dark rim, as the iPhone's glass turns light there (TabGlass.effect `dark:`). */
class Glass(private val owner: View) {
  /** The page behind the plate; null = no blur. */
  var source: GlassSource? = null
  /** The fill over the blur, and the fill without one. */
  var tint = if (Theme.dark) DARK_TINT else LIGHT_TINT
  var plain = if (Theme.dark) DARK_PLAIN else LIGHT_PLAIN
  var rim = if (Theme.dark) DARK_RIM else LIGHT_RIM

  companion object {
    const val DARK_TINT = 0x8C141518.toInt()
    const val DARK_PLAIN = 0xF7161718.toInt()
    const val DARK_RIM = 0x1FFFFFFF
    // Light glass is white, as the iPhone's glass on a light theme (the reference's `glassOpaque` #F6F8FD): the earlier
    // page-grey fill under a grey rim read as a grey outlined pill beside the iPhone's white one.
    const val LIGHT_TINT = 0xD9FFFFFF.toInt()
    const val LIGHT_PLAIN = 0xFAFFFFFF.toInt()
    const val LIGHT_RIM = 0x0A000000
    /** Effects: every plate that has been drawn (weakly held; effects/EffectsHost.kt reads it). */
    val plates = java.util.WeakHashMap<Glass, Unit>()

    /** Effects: every plate is drawn again — «Ледяное стекло» was switched, or its theme or heat changed. `forget`:
     *  the plates let their rime go first (the setting is off). */
    fun redraw(forget: Boolean = false) {
      for (glass in plates.keys.toList()) {
        if (forget) glass.forgetRime()
        glass.owner.invalidate()
      }
    }
  }

  private val d = owner.resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val blur: Any? = if (Build.VERSION.SDK_INT >= 31) BlurNode(22f * d) else null
  private val here = IntArray(2)
  private val there = IntArray(2)

  /** Effects: where this plate was last drawn (owner's coordinates) and its corners — the snow lies on it
   *  (effects/EffectsHost.kt). */
  val owned: View get() = owner
  val drawn = android.graphics.RectF()
  var drawnRadius = 0f
    private set

  /** «Ледяное стекло»: the plate's own rime, drawn with the plate (effects/Rime.kt); made when first wanted. */
  private var rime: Rime? = null
  /** Whether this plate asked for its rime (for the tests). */
  internal val rimed: Boolean get() = rime?.asked == true
  /** The rime's picture is let go; it is made again if the plate is drawn with the setting on. */
  internal fun forgetRime() { rime?.forget() }

  /** Draws the plate into the rectangle (owner's coordinates) with corners of `radius`. */
  /** `inside`: drawn in the glass, over its fill and under its rim (the tab bar's lights). */
  fun draw(canvas: Canvas, left: Float, top: Float, right: Float, bottom: Float, radius: Float, inside: ((Canvas) -> Unit)? = null) {
    drawn.set(left, top, right, bottom); drawnRadius = radius; plates[this] = Unit // Effects
    var blurred = false
    val page = source
    val node = blur
    if (Build.VERSION.SDK_INT >= 31 && node is BlurNode && page != null && canvas.isHardwareAccelerated && page.isAttachedToWindow) {
      owner.getLocationInWindow(here); page.getLocationInWindow(there)
      blurred = try { node.draw(canvas, page.node(), left, top, right, bottom, radius, there[0] - here[0], there[1] - here[1]) } catch (_: RuntimeException) { false }
    }
    fill.color = if (blurred) tint else plain
    canvas.drawRoundRect(left, top, right, bottom, radius, radius, fill)
    inside?.invoke(canvas)
    val half = maxOf(1f, d) / 2
    line.strokeWidth = half * 2; line.color = rim
    canvas.drawRoundRect(left + half, top + half, right - half, bottom - half, radius - half, radius - half, line)
    // «Ледяное стекло»: the rime is part of the plate, over its fill and rim, so it goes wherever the plate goes.
    if (EffectsHost.iced) try { (rime ?: Rime(owner).also { rime = it }).draw(canvas, left, top, right, bottom, radius) } catch (_: Throwable) { /* decorative: no rime */ }
  }
}

@TargetApi(31)
private class BlurNode(radius: Float) {
  private val node = RenderNode("glass").apply {
    setRenderEffect(RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP))
    clipToOutline = true
  }
  private val outline = Outline()

  /** `dx`, `dy`: where the page's corner is, from the owner's corner. False when there was nothing to blur. */
  fun draw(canvas: Canvas, page: Any?, left: Float, top: Float, right: Float, bottom: Float, radius: Float, dx: Int, dy: Int): Boolean {
    val source = (page as? SourceNode)?.node ?: return false
    if (!source.hasDisplayList()) return false
    val l = left.toInt(); val t = top.toInt(); val r = right.toInt(); val b = bottom.toInt()
    if (r <= l || b <= t) return false
    node.setPosition(l, t, r, b)
    outline.setRoundRect(0, 0, r - l, b - t, radius)
    node.setOutline(outline)
    val recording = node.beginRecording()
    try {
      recording.drawColor(Theme.bg)
      recording.translate((dx - l).toFloat(), (dy - t).toFloat())
      recording.drawRenderNode(source)
    } finally { node.endRecording() }
    canvas.drawRenderNode(node)
    return true
  }
}
