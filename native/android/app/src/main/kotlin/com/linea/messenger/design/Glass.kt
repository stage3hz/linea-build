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
    const val LIGHT_TINT = 0xA6F7F7F9.toInt()
    const val LIGHT_PLAIN = 0xF7F7F7F9.toInt()
    const val LIGHT_RIM = 0x14000000
  }

  private val d = owner.resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val blur: Any? = if (Build.VERSION.SDK_INT >= 31) BlurNode(22f * d) else null
  private val here = IntArray(2)
  private val there = IntArray(2)

  /** Draws the plate into the rectangle (owner's coordinates) with corners of `radius`. */
  fun draw(canvas: Canvas, left: Float, top: Float, right: Float, bottom: Float, radius: Float) {
    var blurred = false
    val page = source
    val node = blur
    if (Build.VERSION.SDK_INT >= 31 && node is BlurNode && page != null && canvas.isHardwareAccelerated && page.isAttachedToWindow) {
      owner.getLocationInWindow(here); page.getLocationInWindow(there)
      blurred = try { node.draw(canvas, page.node(), left, top, right, bottom, radius, there[0] - here[0], there[1] - here[1]) } catch (_: RuntimeException) { false }
    }
    fill.color = if (blurred) tint else plain
    canvas.drawRoundRect(left, top, right, bottom, radius, radius, fill)
    val half = maxOf(1f, d) / 2
    line.strokeWidth = half * 2; line.color = rim
    canvas.drawRoundRect(left + half, top + half, right - half, bottom - half, radius - half, radius - half, line)
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
