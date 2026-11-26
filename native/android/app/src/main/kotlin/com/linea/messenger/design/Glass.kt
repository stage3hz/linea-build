package com.linea.messenger.design

import android.annotation.TargetApi
import android.content.Context
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.os.Build
import android.view.View
import android.view.ViewTreeObserver
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
    if (Build.VERSION.SDK_INT >= 31 && node is SourceNode && canvas.isHardwareAccelerated) {
      node.draw(this, canvas) { super.dispatchDraw(it) }
      // A plate drawn before the page had any picture showed the plain fill: it is drawn again, now with the page.
      if (viewers.isNotEmpty()) for (glass in viewers.keys) if (glass.missed) glass.owned.invalidate()
    }
    else super.dispatchDraw(canvas)
  }

  /** The node with the children's drawing; null where glass is a plain fill. */
  internal fun node(): Any? = recorder

  // The plates that show this page (weakly held). A plate's own drawing holds the place of the page under it as it
  // was when the plate was last drawn; when something inside the page changes (a list scrolls, a picture moves) the
  // plates are drawn again for the same frame, so their picture never stays a step behind the page.
  private val viewers = java.util.WeakHashMap<Glass, Unit>()
  private var relaying = false

  internal fun shownBy(glass: Glass, on: Boolean) { if (on) viewers[glass] = Unit else viewers.remove(glass) }

  override fun onDescendantInvalidated(child: View, target: View) {
    super.onDescendantInvalidated(child, target)
    if (relaying || viewers.isEmpty()) return
    relaying = true
    try { for (glass in viewers.keys) glass.owned.invalidate() } finally { relaying = false }
  }

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
  // Where the page lies in the plate's own coordinates (the page's corner, and any scale on the way, as on a pressed
  // button), as last drawn; and the same looked at again before a frame.
  private val placed = Matrix()
  private val placedValues = FloatArray(9)
  private val probe = Matrix()
  private val probeValues = FloatArray(9)
  /** The page this plate last showed (it tells the plate when it changes). */
  private var shown: GlassSource? = null
  private var watched: ViewTreeObserver? = null
  /** The plate was asked to be drawn again and has not been yet (it is asked once: an owner that no longer draws its
   *  glass is not asked frame after frame). */
  private var pending = false
  /** The plate wanted its page but the page had no picture yet. */
  internal var missed = false
    private set
  /** Before every frame: a plate whose page moved under it, or which moved over its page, without being drawn again
   *  (a row of a scrolled list, the bar over a page sliding in, the composer going up with the keyboard) is drawn
   *  again, so its picture is the page where it is in this frame, not where it was. */
  private val follow = ViewTreeObserver.OnPreDrawListener {
    val page = shown
    if (!pending && page != null && Build.VERSION.SDK_INT >= 31 && owner.isShown && page.isAttachedToWindow) {
      place(page, probe); probe.getValues(probeValues)
      if (!probeValues.contentEquals(placedValues)) { pending = true; owner.invalidate() }
    }
    true
  }

  init {
    // A plate taken off the window and put back (a list's row) may come back without being drawn again: it looks
    // again before its next frame.
    owner.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(view: View) { listen(true) }
      override fun onViewDetachedFromWindow(view: View) { listen(false) }
    })
  }

  /** The page this plate shows is followed (or no page, `null`). */
  private fun watch(page: GlassSource?) {
    if (shown !== page) { shown?.shownBy(this, false); page?.shownBy(this, true); shown = page }
    listen(owner.isAttachedToWindow)
  }

  private fun listen(attached: Boolean) {
    val tree = if (shown != null && attached) owner.viewTreeObserver.takeIf { it.isAlive } else null
    if (tree === watched) return
    watched?.let { if (it.isAlive) it.removeOnPreDrawListener(follow) }
    watched = tree
    tree?.addOnPreDrawListener(follow)
  }

  /** `out`: from the page's coordinates to the owner's (both in this window), with every scroll, offset, translation
   *  and scale between them as they are now. */
  @TargetApi(31)
  private fun place(page: View, out: Matrix) {
    out.reset()
    page.transformMatrixToGlobal(out)
    owner.transformMatrixToLocal(out)
  }

  /** Whether the owner stands inside `page`: the page would then hold the plate that shows the page. */
  private fun within(page: View): Boolean {
    var at = owner.parent
    while (at != null) { if (at === page) return true; at = at.parent }
    return false
  }

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
  /** The rime's picture is let go; it is made again if the plate is drawn with the setting on. `fade`: it then
   *  fades in as a new plate's does (false: the plate only left the screen for a while). */
  internal fun forgetRime(fade: Boolean = true) { rime?.forget(fade) }

  /** Draws the plate into the rectangle (owner's coordinates) with corners of `radius`. */
  /** `inside`: drawn in the glass, over its fill and under its rim (the tab bar's lights). */
  fun draw(canvas: Canvas, left: Float, top: Float, right: Float, bottom: Float, radius: Float, inside: ((Canvas) -> Unit)? = null) {
    drawn.set(left, top, right, bottom); drawnRadius = radius; plates[this] = Unit // Effects
    pending = false
    var blurred = false
    val page = source
    val node = blur
    // A plate inside its own page would be drawn into the very picture it shows (and always from the frame before):
    // it keeps the plain fill instead.
    // With «Ледяное стекло» the plate is frosted matte glass: its own fill and rime, no picture of the page behind it
    // (the owner's rule — that picture could lag behind a moving page; a matte plate has nothing to lag).
    val live = Build.VERSION.SDK_INT >= 31 && node is BlurNode && page != null && canvas.isHardwareAccelerated && page.isAttachedToWindow && !within(page) && !EffectsHost.iced
    if (live && node is BlurNode && page != null) {
      place(page, placed); placed.getValues(placedValues)
      blurred = try { node.draw(canvas, page.node(), left, top, right, bottom, radius, placed) } catch (_: RuntimeException) { false }
    }
    missed = live && !blurred
    watch(if (live) page else null)
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

  /** `placed`: from the page's coordinates to the owner's. False when there was nothing to blur. */
  fun draw(canvas: Canvas, page: Any?, left: Float, top: Float, right: Float, bottom: Float, radius: Float, placed: Matrix): Boolean {
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
      recording.translate(-l.toFloat(), -t.toFloat())
      recording.concat(placed)
      recording.drawRenderNode(source)
    } finally { node.endRecording() }
    canvas.drawRenderNode(node)
    return true
  }
}
