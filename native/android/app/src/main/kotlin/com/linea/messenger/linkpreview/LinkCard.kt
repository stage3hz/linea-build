package com.linea.messenger.linkpreview

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.Base64
import com.linea.messenger.chat.MsgPalette
import com.linea.messenger.design.Theme

/** The card of a link under a message's text: the site's name, the page's title, a few lines of its description
 *  and its picture. Everything shown came inside the encrypted message (the shared core checked it on arrival);
 *  showing it asks nothing of anyone — no request is made for a card that was received. */
data class MsgLinkCard(
  val url: String, val site: String, val title: String, val about: String,
  /** The picture as it travelled (a small JPEG in base64); empty: the card has none. */
  val image: String,
  /** The picture's width over its height. */
  val imageWide: Double,
) {
  /** The decoded picture; null when the card has none (or it is not a picture after all). */
  fun picture(): Bitmap? {
    if (image.isEmpty()) return null
    return try { val bytes = Base64.decode(image, Base64.DEFAULT); BitmapFactory.decodeByteArray(bytes, 0, bytes.size) } catch (_: Throwable) { null }
  }

  /** What a screen reader says for the card. */
  val spoken: String get() = listOf(site, title, about).filter { it.isNotEmpty() }.joinToString(". ")

  companion object {
    /** From the `linkPreview` of a decrypted message (or the same fields in a row). */
    fun parse(value: Any?): MsgLinkCard? {
      val fields = value as? Map<*, *> ?: return null
      val url = fields["url"] as? String ?: return null
      if (url.isEmpty()) return null
      var picture = ""
      var wide = 1.0
      val image = fields["image"] as? Map<*, *>
      val base64 = image?.get("base64") as? String
      val width = (image?.get("width") as? Number)?.toDouble() ?: 0.0
      val height = (image?.get("height") as? Number)?.toDouble() ?: 0.0
      if (!base64.isNullOrEmpty() && width > 0 && height > 0) {
        picture = base64
        wide = width / height
      }
      val card = MsgLinkCard(url, fields["site"] as? String ?: "", fields["title"] as? String ?: "", fields["description"] as? String ?: "", picture, wide)
      if (card.site.isEmpty() && card.title.isEmpty() && card.about.isEmpty() && card.image.isEmpty()) return null
      return card
    }
  }
}

/** Where the parts of a card go for the width it is given (all in the units of that width). Frames are from the
 *  card's own corner: left, top, width, height; all zero for a part the card does not have. */
data class MsgLinkCardFrames(
  val width: Float = 0f, val height: Float = 0f,
  val site: List<Float> = none, val title: List<Float> = none, val words: List<Float> = none, val picture: List<Float> = none,
) {
  companion object {
    val none = listOf(0f, 0f, 0f, 0f)
    /** From the card's left edge to its texts: the accent bar and a little air. */
    const val lead = 13f
    const val trail = 11f
    const val widest = 320f

    /** The width the card may take within `width` (the width a message's text may take), and its texts' column. */
    fun outer(width: Float, d: Float): Float = maxOf(120f * d, minOf(width, widest * d))
    fun inner(width: Float, d: Float): Float = outer(width, d) - (lead + trail) * d

    /** The card for texts of these sizes (each `[width, height]`, zero height: none), measured within `inner`.
     *  `d`: how many of the width's units one point of the design is. */
    fun make(site: List<Float>, title: List<Float>, words: List<Float>, hasPicture: Boolean, imageWide: Double, width: Float, d: Float): MsgLinkCardFrames {
      val outer = outer(width, d)
      val inner = inner(width, d)
      // With a picture the card takes the whole width it may; without one it is as wide as its words.
      var textWide = maxOf(site[0], title[0], words[0])
      if (hasPicture) textWide = inner
      val cardWide = minOf(outer, maxOf(140f * d, textWide + (lead + trail) * d))
      val column = cardWide - (lead + trail) * d
      var y = 9f * d
      var siteAt = none; var titleAt = none; var wordsAt = none; var pictureAt = none
      if (site[1] > 0f) { siteAt = listOf(lead * d, y, column, site[1]); y += site[1] + 3f * d }
      if (title[1] > 0f) { titleAt = listOf(lead * d, y, column, title[1]); y += title[1] + 3f * d }
      if (words[1] > 0f) { wordsAt = listOf(lead * d, y, column, words[1]); y += words[1] + 3f * d }
      if (hasPicture) {
        // At its own proportions, within reason: a very tall or very wide picture is cropped to fit.
        val wide = imageWide.coerceIn(0.6, 3.0).toFloat()
        val height = Math.round(column / wide).toFloat().coerceIn(60f * d, 260f * d)
        y += 4f * d
        pictureAt = listOf(lead * d, y, column, height)
        y += height + 3f * d
      }
      return MsgLinkCardFrames(cardWide, y + 7f * d, siteAt, titleAt, wordsAt, pictureAt)
    }
  }
}

/** A card laid out for one row: its texts wrapped and cut (the site in one line, the title in two, the
 *  description in five), and where everything goes. */
class MsgLinkCardLayout private constructor(
  val card: MsgLinkCard, val frames: MsgLinkCardFrames, private val d: Float,
  private val site: StaticLayout?, private val title: StaticLayout?, private val words: StaticLayout?,
) {
  val width: Float get() = frames.width
  val height: Float get() = frames.height

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val image = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val matrix = Matrix()
  private val clip = Path()
  private val box = RectF()

  /** Draws the card with its corner at (`x`, `y`): a soft plate, the accent bar at its left edge, the site's
   *  name, the title in bold, the description, the picture below with rounded corners. */
  fun draw(canvas: Canvas, x: Float, y: Float, palette: MsgPalette, accent: Int, picture: Bitmap?, pressed: Boolean) {
    box.set(x, y, x + width, y + height)
    clip.reset(); clip.addRoundRect(box, 12f * d, 12f * d, Path.Direction.CW)
    canvas.save()
    canvas.clipPath(clip)
    fill.color = if (pressed) 0x1CFFFFFF else 0x0FFFFFFF
    canvas.drawRect(box, fill)
    fill.color = accent
    canvas.drawRect(x, y, x + 3f * d, y + height, fill)
    canvas.restore()

    fun text(layout: StaticLayout?, color: Int, frame: List<Float>) {
      if (layout == null || frame[3] <= 0f) return
      layout.paint.color = color
      canvas.save()
      canvas.clipRect(x + frame[0], y + frame[1] - d, x + frame[0] + frame[2] + d, y + frame[1] + frame[3] + d)
      canvas.translate(x + frame[0], y + frame[1])
      layout.draw(canvas)
      canvas.restore()
    }
    text(site, accent, frames.site)
    text(title, palette.text, frames.title)
    text(words, (palette.text and 0x00FFFFFF) or (0xD1 shl 24), frames.words)

    val at = frames.picture
    if (at[3] > 0f) {
      val left = x + at[0]; val top = y + at[1]; val w = at[2]; val h = at[3]
      if (picture != null && picture.width > 0 && picture.height > 0) {
        image.shader = BitmapShader(picture, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        val scale = maxOf(w / picture.width, h / picture.height)
        matrix.reset(); matrix.setScale(scale, scale); matrix.postTranslate(left + (w - picture.width * scale) / 2, top + (h - picture.height * scale) / 2)
        image.shader?.setLocalMatrix(matrix)
        canvas.drawRoundRect(left, top, left + w, top + h, 9f * d, 9f * d, image)
        image.shader = null
      } else {
        fill.color = 0x0DFFFFFF
        canvas.drawRoundRect(left, top, left + w, top + h, 9f * d, 9f * d, fill)
      }
    }
  }

  companion object {
    private fun paint(size: Float, weight: Int, d: Float) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = size * d; typeface = Theme.weight(weight) }

    private fun lines(text: String, paint: TextPaint, width: Int, lines: Int, d: Float): StaticLayout? =
      if (text.isEmpty()) null else StaticLayout.Builder.obtain(text, 0, text.length, paint, width.coerceAtLeast(1))
        .setAlignment(Layout.Alignment.ALIGN_NORMAL).setMaxLines(lines).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).setLineSpacing(2f * d, 1f).build()

    private fun size(layout: StaticLayout?): List<Float> {
      if (layout == null) return listOf(0f, 0f)
      var wide = 0f
      for (line in 0 until layout.lineCount) wide = maxOf(wide, layout.getLineWidth(line))
      return listOf(Math.ceil(wide.toDouble()).toFloat(), layout.height.toFloat())
    }

    /** The card within `width` px (the width a message's text may take); `d`: px per dp. */
    fun make(card: MsgLinkCard, width: Float, d: Float): MsgLinkCardLayout {
      val inner = MsgLinkCardFrames.inner(width, d).toInt()
      val site = lines(card.site, paint(13f, 600, d), inner, 1, d)
      val title = lines(card.title, paint(15f, 700, d), inner, 2, d)
      val words = lines(card.about, paint(14f, 400, d), inner, 5, d)
      val frames = MsgLinkCardFrames.make(size(site), size(title), size(words), card.image.isNotEmpty(), card.imageWide, width, d)
      return MsgLinkCardLayout(card, frames, d, site, title, words)
    }
  }
}
