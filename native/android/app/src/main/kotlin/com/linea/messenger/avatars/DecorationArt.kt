package com.linea.messenger.avatars

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** The pictures of the decorations, from the app's resources (decoded once). */
object DecorationPictures {
  private val pictures = HashMap<String, Bitmap?>()
  private val glows = HashMap<String, Bitmap>()

  fun picture(context: Context, decoration: AvatarCatalog.Decoration): Bitmap? {
    if (pictures.containsKey(decoration.file)) return pictures[decoration.file]
    val id = context.resources.getIdentifier(decoration.file, "drawable", context.packageName)
    val made = if (id == 0) null else try { BitmapFactory.decodeResource(context.resources, id, BitmapFactory.Options().apply { inScaled = false }) } catch (_: Throwable) { null }
    pictures[decoration.file] = made
    return made
  }

  /** The art's silhouette in one colour, blurred (about 5% of the art, at least 4 px), made once per size. */
  fun glow(picture: Bitmap, color: String, size: Int): Bitmap? {
    if (size <= 0) return null
    val key = "$color@$size@${picture.hashCode()}"
    glows[key]?.let { return it }
    val radius = max(4f, size * 0.05f)
    // Drawn small and scaled up with filtering: a soft blur at a fraction of the cost.
    val small = max(8, (size / (radius / 1.5f)).toInt())
    val tinted = Bitmap.createBitmap(small, small, Bitmap.Config.ARGB_8888)
    val paint = Paint(Paint.FILTER_BITMAP_FLAG).apply { colorFilter = PorterDuffColorFilter(lookColor(color), PorterDuff.Mode.SRC_IN) }
    Canvas(tinted).drawBitmap(picture, null, Rect(0, 0, small, small), paint)
    val made = Bitmap.createScaledBitmap(tinted, size, size, true)
    if (glows.size > 24) glows.clear()
    glows[key] = made
    return made
  }
}

/** Painted art around a round avatar (the reference's platina/Decorations.tsx `DecorationArt`; iOS
 *  Avatars/DecorationArt.swift): the still picture, and — while `live` (profiles, the chosen tile) — the motion
 *  drawn over it: a band of light crossing the art, its own silhouette breathing as a glow behind it, embers rising
 *  or sparkles twinkling. The view is the art's box (the avatar × `scale`), centred on the avatar. */
class DecorationArtView(context: Context, val decoration: AvatarCatalog.Decoration) : LiveCanvasView(context) {
  private val picturePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val bandPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val mask = Paint(Paint.FILTER_BITMAP_FLAG).apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN) }
  private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
  private val box = RectF()

  override fun paint(canvas: Canvas, width: Float, height: Float) {
    val picture = DecorationPictures.picture(context, decoration) ?: return
    val size = min(width, height)
    if (size <= 0f) return
    box.set(0f, 0f, size, size)
    val t = seconds

    if (live && decoration.glow.isNotEmpty()) {
      DecorationPictures.glow(picture, decoration.glow, size.toInt())?.let { glow ->
        val p = DecorEase.loop(t, 2.4, ease = DecorEase::inOutQuad)
        val grow = (1 + 0.03 * sin(p * Math.PI)).toFloat()
        picturePaint.alpha = Math.round(255 * (0.2 + 0.45 * sin(p * Math.PI)).toFloat().coerceIn(0f, 1f))
        canvas.save(); canvas.scale(grow, grow, size / 2, size / 2)
        canvas.drawBitmap(glow, null, box, picturePaint)
        canvas.restore()
        picturePaint.alpha = 255
      }
    }

    canvas.drawBitmap(picture, null, box, picturePaint)

    if (live && decoration.sweep) {
      // Sweep, then rest: a constant shimmer looks cheap, an occasional glint looks expensive.
      val moving = 1.5; val total = 1.5 + 2.6
      val k = (t % total)
      val p = if (k < moving) DecorEase.inOutCubic(k / moving) else 1.0
      if (p < 1.0) {
        val layer = canvas.saveLayer(box, null)
        val bandW = size * 0.55f; val bandH = size * 1.5f
        canvas.save()
        canvas.translate((-size * 1.2f + p.toFloat() * size * 2.4f), -size * 0.25f)
        canvas.rotate(18f, bandW / 2, bandH / 2)
        bandPaint.shader = LinearGradient(0f, 0f, bandW, 0f, intArrayOf(0x00FFFFFF, 0xBFFFFFFF.toInt(), 0x00FFFFFF), null, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, bandW, bandH, bandPaint)
        canvas.restore()
        canvas.drawBitmap(picture, null, box, mask)
        canvas.restoreToCount(layer)
      }
    }

    if (live && decoration.particles.isNotEmpty()) {
      val rise = decoration.rise
      val color = lookColor(decoration.particles)
      for (index in 0 until (if (rise) 9 else 7)) {
        fun r(n: Double) = decorRand(index * 11.0 + n)
        val angle = r(1.0) * Math.PI * 2; val radius = size * (0.36 + r(2.0) * 0.1)
        var x = (size / 2 + cos(angle) * radius).toFloat(); var y = (size / 2 + sin(angle) * radius).toFloat()
        val sparkSize = max(2.0, size * (if (rise) 0.018 else 0.022) * (0.7 + r(3.0) * 0.6)).toFloat()
        val duration = (1800 + r(4.0) * 1800) / 1000; val delay = Math.round(r(5.0) * 1600) / 1000.0
        if (t < delay) continue
        val p = DecorEase.loop(t, duration, delay, DecorEase::inOutQuad)
        val opacity: Double; var scale = 1.0
        if (rise) {
          opacity = minOf(1.0, p * 4, (1 - p) * 2)
          x += (sin(p * 6 + index) * size * 0.015).toFloat()
          y += (-p * size * 0.14).toFloat()
        } else {
          opacity = Math.abs(sin(p * Math.PI)) * 0.9
          scale = 0.5 + sin(p * Math.PI) * 0.7
        }
        val alpha = opacity.toFloat().coerceIn(0f, 1f)
        val s = sparkSize * scale.toFloat()
        dot.shader = RadialGradient(x, y, s * 2f, intArrayOf((color and 0xFFFFFF) or (Math.round(alpha * 0.6f * 255) shl 24), color and 0xFFFFFF), null, Shader.TileMode.CLAMP)
        canvas.drawCircle(x, y, s * 2f, dot)
        dot.shader = null
        dot.color = (color and 0xFFFFFF) or (Math.round(alpha * 255) shl 24)
        canvas.drawCircle(x, y, s / 2, dot)
      }
    }
  }
}
