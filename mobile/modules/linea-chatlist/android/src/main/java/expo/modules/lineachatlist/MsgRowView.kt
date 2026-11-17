package expo.modules.lineachatlist

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.Base64
import android.view.View

/** One chat row drawn on the canvas: a bubble (forward line, quote, picture with its label, text, time and ticks)
 *  or a centred notice. Its height comes from the text it lays out for the width it is given. */
class MsgRowView(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val body = TextPaint(Paint.ANTI_ALIAS_FLAG)
  private val small = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f * d }
  private val smallBold = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12.5f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
  private val meta = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d }
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val matrix = Matrix()
  private val path = Path()

  private var row: MsgRow? = null
  private var palette = MsgPalette.DARK
  private var fontSize = 17f
  private var thumbOf = ""
  private var thumb: Bitmap? = null

  // What the last measure laid out.
  private var builtFor: MsgRow? = null
  private var builtWidth = 0
  private var builtFont = 0f
  private var textLayout: StaticLayout? = null
  private var quoteLayout: StaticLayout? = null
  private var labelLayout: StaticLayout? = null
  private var noticeLayout: StaticLayout? = null
  private var reactLayout: StaticLayout? = null
  private var bubbleW = 0f
  private var bubbleH = 0f
  private var thumbW = 0f
  private var thumbH = 0f

  fun bind(next: MsgRow, colors: MsgPalette, size: Float) {
    if (row == next && palette == colors && fontSize == size) return
    val relayout = row != next || fontSize != size
    row = next; palette = colors; fontSize = size
    if (next.thumb != thumbOf) {
      thumbOf = next.thumb
      thumb = if (next.thumb.isEmpty()) null else try { val bytes = Base64.decode(next.thumb, Base64.DEFAULT); BitmapFactory.decodeByteArray(bytes, 0, bytes.size) } catch (_: Throwable) { null }
    }
    contentDescription = if (next.kind == 1) next.text else listOf(next.label, next.text, next.time).filter { it.isNotEmpty() }.joinToString(". ")
    if (relayout) requestLayout()
    invalidate()
  }

  private fun layout(text: String, paint: TextPaint, width: Int, lines: Int, center: Boolean = false): StaticLayout =
    StaticLayout.Builder.obtain(text, 0, text.length, paint, width.coerceAtLeast(1))
      .setAlignment(if (center) Layout.Alignment.ALIGN_CENTER else Layout.Alignment.ALIGN_NORMAL)
      .setMaxLines(lines).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).setLineSpacing(2f * d, 1f).build()

  private fun widest(layout: StaticLayout?): Float { var w = 0f; if (layout != null) for (i in 0 until layout.lineCount) w = maxOf(w, layout.getLineWidth(i)); return w }

  private fun build(item: MsgRow, width: Int) {
    body.textSize = fontSize * d
    textLayout = null; quoteLayout = null; labelLayout = null; noticeLayout = null; reactLayout = null; thumbW = 0f; thumbH = 0f
    if (item.kind == 1) {
      noticeLayout = layout(item.text, small, (width * 0.8f).toInt(), 6, true)
      bubbleW = widest(noticeLayout) + 24f * d; bubbleH = (noticeLayout?.height ?: 0) + 12f * d
    } else {
      val inner = (width * 0.78f - 26f * d).toInt()
      if (item.text.isNotEmpty()) textLayout = layout(item.text, body, inner, 400)
      if (item.quoteText.isNotEmpty() || item.quoteAuthor.isNotEmpty()) quoteLayout = layout(item.quoteText, small, inner - (12f * d).toInt(), 2)
      if (item.label.isNotEmpty()) labelLayout = layout(item.label, small, inner, 2)
      if (item.reactions.isNotEmpty()) reactLayout = layout(item.reactions, small, inner, 2)
      if (thumb != null) { thumbW = minOf(inner.toFloat(), 220f * d); thumbH = (thumbW / item.thumbWide.toFloat()).coerceIn(90f * d, 300f * d) }
      val metaWidth = meta.measureText(item.time) + (if (item.mine) 22f * d else 0f)
      var w = maxOf(maxOf(widest(textLayout), metaWidth, thumbW, widest(labelLayout)), widest(reactLayout))
      if (quoteLayout != null) w = maxOf(w, maxOf(widest(quoteLayout), smallBold.measureText(item.quoteAuthor)) + 12f * d)
      if (item.forward.isNotEmpty()) w = maxOf(w, minOf(inner.toFloat(), smallBold.measureText(item.forward)))
      var h = 9f * d
      if (item.forward.isNotEmpty()) h += 18f * d
      if (quoteLayout != null) h += 17f * d + quoteLayout!!.height + 8f * d
      if (thumbH > 0f) h += thumbH + 6f * d
      if (labelLayout != null) h += labelLayout!!.height + 4f * d
      if (textLayout != null) h += textLayout!!.height
      if (reactLayout != null) h += reactLayout!!.height + 6f * d
      h += 16f * d + 6f * d
      bubbleW = w + 26f * d; bubbleH = h
    }
    builtFor = item; builtWidth = width; builtFont = fontSize
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    val item = row
    if (item == null) { setMeasuredDimension(width, 0); return }
    if (builtFor != item || builtWidth != width || builtFont != fontSize) build(item, width)
    val gap = if (item.kind == 1) 8f * d else if (item.tail) 7f * d else 2f * d
    setMeasuredDimension(width, (bubbleH + gap).toInt())
  }

  private fun drawPicture(canvas: Canvas, bitmap: Bitmap, x: Float, y: Float, w: Float, h: Float, radius: Float) {
    picture.shader = BitmapShader(bitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
    val scale = maxOf(w / bitmap.width, h / bitmap.height)
    matrix.reset(); matrix.setScale(scale, scale); matrix.postTranslate(x + (w - bitmap.width * scale) / 2, y + (h - bitmap.height * scale) / 2)
    picture.shader?.setLocalMatrix(matrix)
    canvas.drawRoundRect(x, y, x + w, y + h, radius, radius, picture)
    picture.shader = null
  }

  override fun onDraw(canvas: Canvas) {
    val item = row ?: return
    if (builtFor != item || builtWidth != width) build(item, width)
    val w = width.toFloat()
    if (item.kind == 1) {
      val left = (w - bubbleW) / 2
      fill.color = palette.notice; canvas.drawRoundRect(left, 0f, left + bubbleW, bubbleH, 14f * d, 14f * d, fill)
      small.color = palette.noticeText
      noticeLayout?.let { canvas.save(); canvas.translate((w - it.width) / 2, 6f * d); it.draw(canvas); canvas.restore() }
      return
    }
    var side = 9f * d
    if (item.checked >= 0) {
      val cx = 9f * d + 12f * d; val cy = bubbleH / 2
      if (item.checked == 1) {
        fill.color = palette.accent; canvas.drawCircle(cx, cy, 11f * d, fill)
        stroke.color = palette.onAccent; stroke.strokeWidth = 2f * d
        path.reset(); path.moveTo(cx - 5f * d, cy); path.lineTo(cx - 1.5f * d, cy + 3.5f * d); path.lineTo(cx + 5f * d, cy - 3.5f * d); canvas.drawPath(path, stroke)
      } else { stroke.color = palette.subtle; stroke.strokeWidth = 1.6f * d; canvas.drawCircle(cx, cy, 10.5f * d, stroke) }
      if (!item.mine) side += 34f * d
    }
    val left = if (item.mine) w - 9f * d - bubbleW else side
    val r = 20f * d; val tight = 7f * d
    fill.color = if (item.mine) palette.mine else palette.theirs
    // The corner by the sender's edge is tight on the last bubble of a run (the «tail»).
    val radii = floatArrayOf(r, r, r, r, if (item.mine && item.tail) tight else r, if (item.mine && item.tail) tight else r, if (!item.mine && item.tail) tight else r, if (!item.mine && item.tail) tight else r)
    path.reset(); path.addRoundRect(left, 0f, left + bubbleW, bubbleH, radii, Path.Direction.CW); canvas.drawPath(path, fill)
    if (isPressed) { fill.color = 0x14FFFFFF; canvas.drawPath(path, fill) }

    val x = left + 13f * d
    var y = 9f * d
    val metaColor = if (item.mine) palette.mineMeta else palette.muted
    val markColor = if (item.mine) palette.mineMark else palette.accent
    if (item.forward.isNotEmpty()) {
      smallBold.color = markColor
      val shown = TextUtils.ellipsize(item.forward, smallBold, bubbleW - 26f * d, TextUtils.TruncateAt.END)
      canvas.drawText(shown, 0, shown.length, x, y - smallBold.ascent(), smallBold); y += 18f * d
    }
    quoteLayout?.let { quote ->
      val height = 17f * d + quote.height
      fill.color = palette.quote; canvas.drawRoundRect(x, y, left + bubbleW - 13f * d, y + height + 2f * d, 6f * d, 6f * d, fill)
      fill.color = markColor; canvas.drawRoundRect(x, y, x + 3f * d, y + height + 2f * d, 2f * d, 2f * d, fill)
      smallBold.color = markColor
      val author = TextUtils.ellipsize(item.quoteAuthor, smallBold, bubbleW - 44f * d, TextUtils.TruncateAt.END)
      canvas.drawText(author, 0, author.length, x + 9f * d, y + 2f * d - smallBold.ascent(), smallBold)
      small.color = metaColor
      canvas.save(); canvas.translate(x + 9f * d, y + 17f * d); quote.draw(canvas); canvas.restore()
      y += height + 8f * d
    }
    val image = thumb
    if (image != null && thumbH > 0f) { drawPicture(canvas, image, x, y, thumbW, thumbH, if (item.thumbRound) minOf(thumbW, thumbH) / 2 else 12f * d); y += thumbH + 6f * d }
    labelLayout?.let { small.color = markColor; canvas.save(); canvas.translate(x, y); it.draw(canvas); canvas.restore(); y += it.height + 4f * d }
    textLayout?.let { body.color = palette.text; canvas.save(); canvas.translate(x, y); it.draw(canvas); canvas.restore(); y += it.height }
    reactLayout?.let { small.color = palette.text; canvas.save(); canvas.translate(x, y + 6f * d); it.draw(canvas); canvas.restore() }

    val right = left + bubbleW - 13f * d
    val base = bubbleH - 8f * d
    meta.color = if (item.ticks == 4) palette.danger else metaColor
    val marks = if (item.mine) 20f * d else 0f
    canvas.drawText(item.time, right - marks - meta.measureText(item.time), base, meta)
    if (item.mine && item.ticks in 1..2) {
      stroke.color = if (item.ticks == 2) markColor else metaColor; stroke.strokeWidth = 1.5f * d
      val bx = right - 15f * d; val my = base - 4f * d
      path.reset(); path.moveTo(bx, my); path.lineTo(bx + 3.5f * d, my + 3.5f * d); path.lineTo(bx + 10f * d, my - 4f * d)
      if (item.ticks == 2) { path.moveTo(bx + 5f * d, my + 1.5f * d); path.lineTo(bx + 7f * d, my + 3.5f * d); path.lineTo(bx + 13.5f * d, my - 4f * d) }
      canvas.drawPath(path, stroke)
    } else if (item.mine && item.ticks >= 3) {
      stroke.color = if (item.ticks == 4) palette.danger else metaColor; stroke.strokeWidth = 1.4f * d
      val cx = right - 7f * d; val cy = base - 4f * d
      canvas.drawCircle(cx, cy, 5f * d, stroke)
      if (item.ticks == 3) { canvas.drawLine(cx, cy - 2.5f * d, cx, cy, stroke); canvas.drawLine(cx, cy, cx + 2f * d, cy + 1f * d, stroke) }
      else { canvas.drawLine(cx, cy - 2.5f * d, cx, cy + 0.5f * d, stroke); canvas.drawPoint(cx, cy + 2.5f * d, stroke) }
    }
  }
}
