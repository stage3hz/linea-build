package com.linea.messenger.effects

import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.random.Random

/** «Ледяное стекло»: the rime of one glass plate, drawn by the plate itself in its own drawing, right over its fill
 *  and rim (design/Glass.kt) — so it scrolls, moves, scales, fades and clips with the plate's owner and nothing has
 *  to follow anything (iOS Effects/EffectsHost.swift `placeRime` puts a rime view inside each glass surface for the
 *  same reason). The picture is the one `Frost` renders (effects/SnowView.kt): a bitmap for the plate's size, corners
 *  and theme, made on the worker and kept until one of those changes; a frame only draws that bitmap. The heat of the
 *  device takes the rime off (`SnowHub.rimeAlpha`). */
class Rime(private val owner: View) {
  // Chosen once per plate, so equal buttons do not carry the identical pattern.
  private val seed = 1 + Random.nextInt(996)
  private val density = owner.resources.displayMetrics.density
  private var frost: Bitmap? = null
  // What the last request was made for (px, dp, theme), and its number: a result for an older request is dropped.
  private var askedW = 0; private var askedH = 0; private var askedR = -1f; private var askedDark = false
  @Volatile private var ticket = 0
  private var appearing = 1f
  private var fader: ValueAnimator? = null
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val rect = RectF()

  /** Whether a bitmap was asked for or is held (for the tests). */
  val asked: Boolean get() = askedW > 0

  /** Draws the rime of the plate in the rectangle (owner's coordinates, px) with corners of `radius` px. */
  fun draw(canvas: Canvas, left: Float, top: Float, right: Float, bottom: Float, radius: Float) {
    val width = right - left; val height = bottom - top
    val root = owner.rootView
    if (!rimed(width, height, radius, root.width.toFloat(), root.height.toFloat(), density)) return
    request(width.toInt(), height.toInt(), min(radius, min(width, height) / 2) / density)
    val bitmap = frost ?: return
    val alpha = (appearing * SnowHub.rimeAlpha * 255).roundToInt().coerceIn(0, 255)
    if (alpha == 0) return
    paint.alpha = alpha
    rect.set(left, top, right, bottom)
    // The bitmap is clear outside the plate's rounded rectangle (FrostField.inside), so no clip is needed.
    canvas.drawBitmap(bitmap, null, rect, paint)
  }

  /** Renders the rime for the size, radius (dp) and theme — on the worker, never in a frame. Until it is ready the
   *  previous bitmap (if any) is shown stretched; the first one fades in. */
  private fun request(w: Int, h: Int, r: Float) {
    if (w <= 0 || h <= 0) return
    val dark = SnowHub.dark
    if (askedW == w && askedH == h && askedR == r && askedDark == dark) return
    askedW = w; askedH = h; askedR = r; askedDark = dark
    val mine = ++ticket
    val scale = density
    val pattern = seed
    Frost.submit {
      if (mine != ticket) return@submit // superseded while it waited (a plate that is still resizing)
      val bitmap = try { Frost.render(w / scale, h / scale, r, pattern, dark, scale) } catch (_: Throwable) { null }
      Frost.main.post { try { accept(mine, bitmap) } catch (_: Throwable) { /* decorative */ } }
    }
  }

  private fun accept(mine: Int, bitmap: Bitmap?) {
    // A stale result was never drawn: it is safe to recycle at once.
    if (mine != ticket) { bitmap?.recycle(); return }
    val first = frost == null
    // The replaced bitmap may still be referenced by the last recorded frame: it is left to the GC, not recycled.
    frost = bitmap
    if (first && bitmap != null) appear()
    owner.invalidate()
  }

  /** The first rime of a plate fades in (~0.3 s); with «Remove animations» it is simply there. */
  private fun appear() {
    fader?.cancel()
    appearing = 1f
    if (!ValueAnimator.areAnimatorsEnabled()) return
    appearing = 0f
    fader = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 300
      addUpdateListener { appearing = it.animatedValue as Float; owner.invalidate() }
      start()
    }
  }

  /** The bitmap is let go (the setting was turned off, or the plate left the screen); the next drawing asks anew. */
  fun forget() {
    ticket++
    fader?.cancel(); fader = null; appearing = 1f
    frost = null; askedW = 0; askedH = 0; askedR = -1f
  }

  companion object {
    /** Which plates carry rime (px): rounded ones of at least 24 dp each way. A backdrop over the whole screen (a
     *  menu's dimming) is not a glass surface. */
    fun rimed(width: Float, height: Float, radius: Float, screenWidth: Float, screenHeight: Float, density: Float): Boolean {
      if (width > screenWidth * 0.98f && height > screenHeight * 0.5f) return false
      return radius > 0 && width >= 24 * density && height >= 24 * density
    }
  }
}
