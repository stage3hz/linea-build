package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.text.style.UnderlineSpan
import android.view.View
import com.linea.messenger.design.Theme
import com.linea.messenger.design.orbPair
import kotlin.math.ceil

// Where everything of one row of a channel's chat goes, for the width it is shown at — and the lines of text
// themselves, already broken and measured. A layout is made OFF the main thread (ChannelEngine) and never
// changes afterwards; the main thread only draws what is in it: no measuring, no line breaking, no nested views.

/** The colours of a channel's chat (the black look), 0xAARRGGBB. */
object ChannelLook {
  val text: Int get() = Theme.text
  val muted: Int get() = Theme.muted
  val subtle: Int get() = Theme.subtle
  val accent: Int get() = Theme.accent
  val surface: Int get() = Theme.surface2
  const val card = 0xF5161718.toInt()
  const val soft = 0x1AFFFFFF
  const val line = 0x14FFFFFF
  const val mark = 0xFFF5C542.toInt()
  const val join = 0xFF2FA36B.toInt()
  const val white = 0xFFFFFFFF.toInt()
}

/** The fonts of a channel's chat: size in dp, weight. */
enum class ChannelFont(val size: Float, val weight: Int) {
  BODY(15.5f, 400), POST(16f, 400), NAME(15f, 700), SMALL(11f, 400), SMALL_BOLD(11f, 600), REPLY(13f, 400), REPLY_BOLD(13f, 600),
  FILE_NAME(14f, 600), FILE_SIZE(12f, 400), CHIP_EMOJI(14f, 400), CHIP_COUNT(12f, 600), CARD_NAME(16f, 700), BUTTON(14f, 700),
  INITIALS(14.5f, 700), KIND(11f, 700), FACE(16f, 700),
}

/** One paint per font. A set belongs to ONE thread: the engine's worker measures with its own set, the main
 *  thread draws with another, so no paint is ever used by two threads at once. */
class ChannelPaints(val d: Float) {
  private val all = ChannelFont.values().map { font -> TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = font.size * d; typeface = Theme.weight(font.weight) } }
  operator fun get(font: ChannelFont): TextPaint = all[font.ordinal]
}

/** Text made ready for drawing: a measured line or a broken paragraph is a value that the worker makes and the
 *  main thread draws without laying it out again. */
object ChannelType {
  /** One line, already cut with «…» to its width. `ascent` is the room above the baseline (positive). */
  class Line(val text: String, val font: ChannelFont, val color: Int, val width: Float, val ascent: Float, val descent: Float) {
    val height: Float get() = ceil(ascent + descent)
  }

  /** One line, cut with «…» when it is wider than `width`. */
  fun line(text: String, font: ChannelFont, color: Int, width: Float, paints: ChannelPaints): Line {
    val paint = paints[font]
    val plain = text.replace("\n", " ")
    val shown = if (paint.measureText(plain) > width) TextUtils.ellipsize(plain, paint, maxOf(1f, width), TextUtils.TruncateAt.END).toString() else plain
    return Line(shown, font, color, ceil(paint.measureText(shown)), -paint.ascent(), paint.descent())
  }

  /** The text of a message: its links in the accent colour, «(изм.)» after an edited one. */
  fun body(row: ChannelRow, d: Float): CharSequence {
    if (row.links.isEmpty() && !row.edited) return row.text
    val made = SpannableStringBuilder(row.text)
    val total = row.text.length
    for (link in row.links) {
      if (link.location < 0 || link.length <= 0 || link.location + link.length > total) continue
      made.setSpan(ForegroundColorSpan(ChannelLook.accent), link.location, link.location + link.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      if (!link.url.startsWith("mention:")) made.setSpan(UnderlineSpan(), link.location, link.location + link.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    if (row.edited) {
      made.append(" (изм.)")
      made.setSpan(AbsoluteSizeSpan((ChannelFont.SMALL.size * d).toInt()), total, made.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      made.setSpan(ForegroundColorSpan(ChannelLook.subtle), total, made.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    return made
  }

  /** A paragraph broken into lines for `width`. Its paint is its own (a copy): after this, only the main thread
   *  touches it, when it draws. */
  fun block(text: CharSequence, font: ChannelFont, spacing: Float, width: Float, paints: ChannelPaints): StaticLayout {
    val paint = TextPaint(paints[font]).apply { color = ChannelLook.text }
    return StaticLayout.Builder.obtain(text, 0, text.length, paint, maxOf(1, width.toInt()))
      .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(false).setLineSpacing(spacing * paints.d, 1f).build()
  }
}

/** One thing to draw. Coordinates are the row's own, px, y going down. */
sealed class ChannelPiece {
  /** A filled rounded plate. */
  class Fill(val box: RectF, val radius: Float, val color: Int) : ChannelPiece()
  /** A hairline around a rounded plate. */
  class Border(val box: RectF, val radius: Float, val color: Int) : ChannelPiece()
  /** A line of text: its left edge and its baseline. */
  class Text(val line: ChannelType.Line, val x: Float, val baseline: Float) : ChannelPiece()
  /** A paragraph at its corner. */
  class Block(val layout: StaticLayout, val x: Float, val y: Float) : ChannelPiece()
  /** A round picture: the file's id (empty: none), the colours shown without one, and the letters on them. */
  class Avatar(val box: RectF, val id: String, val colors: IntArray, val letters: ChannelType.Line?) : ChannelPiece() {
    /** Made at the first drawing (main thread). */
    var gradient: Shader? = null
    var picture: Shader? = null
    var pictureOf: Bitmap? = null
  }
  /** A picture filling its box, corners rounded. */
  class Picture(val box: RectF, val id: String, val radius: Float) : ChannelPiece() {
    var shader: Shader? = null
    var shaderOf: Bitmap? = null
  }
  /** One of `ChannelIcons` centred in its box. */
  class Icon(val name: String, val box: RectF, val color: Int) : ChannelPiece()
}

/** What a touch on a row landed on. */
sealed class ChannelHit {
  object Row : ChannelHit()
  class Link(val url: String) : ChannelHit()
  class Chip(val emoji: String) : ChannelHit()
  object Author : ChannelHit()
  object Attachment : ChannelHit()
  object Invite : ChannelHit()
}

/** `width` px; `paints`: the set of the thread that makes the layout. */
class ChannelRowLayout(val row: ChannelRow, /** The message the row was made from (for the menu and the actions on it). */ val message: CommunityMessage, val width: Int, private val paints: ChannelPaints) {
  private val d = paints.d
  var height = 0
    private set
  val pieces = ArrayList<ChannelPiece>()
  /** The ids of the pictures the row shows: it is drawn again when one of them arrives. */
  val pictures = ArrayList<String>()
  private var body: StaticLayout? = null
  private var bodyX = 0f
  private var bodyY = 0f
  private val chipBoxes = ArrayList<Pair<RectF, String>>()
  private val authorBoxes = ArrayList<RectF>()
  private var attachmentBox: RectF? = null
  private var inviteBox: RectF? = null

  init { build() }

  private fun box(x: Float, y: Float, w: Float, h: Float) = RectF(x, y, x + w, y + h)
  private fun line(text: String, font: ChannelFont, color: Int, width: Float) = ChannelType.line(text, font, color, width, paints)
  private fun text(line: ChannelType.Line, x: Float, baseline: Float) { pieces.add(ChannelPiece.Text(line, x, baseline)) }
  private fun argb(rgb: Int) = 0xFF000000.toInt() or rgb

  private fun build() {
    val w = width.toFloat()
    var y = 0f
    if (row.day.isNotEmpty()) {
      // The date between two hairlines.
      val day = line(row.day, ChannelFont.SMALL_BOLD, ChannelLook.muted, w - 80 * d)
      val left = (w - day.width) / 2
      text(day, left, 19 * d + day.ascent - day.height / 2)
      val thin = maxOf(1f, 0.5f * d)
      pieces.add(ChannelPiece.Fill(box(14 * d, 19 * d, maxOf(0f, left - 24 * d), thin), 0f, ChannelLook.line))
      pieces.add(ChannelPiece.Fill(box(left + day.width + 10 * d, 19 * d, maxOf(0f, w - 14 * d - (left + day.width + 10 * d)), thin), 0f, ChannelLook.line))
      y = 38 * d
    }
    val top = y
    val marks = pieces.size
    if (row.blog) {
      // A post: a card with the text, what is attached, and the time in its lower corner.
      val cardTop = y + 6 * d
      var inside = cardTop + 14 * d
      inside = content(26 * d, w - 52 * d, inside, 6 * d)
      val time = line(row.time, ChannelFont.SMALL, ChannelLook.subtle, 120 * d)
      if (inside > cardTop + 14 * d) inside += 6 * d
      text(time, w - 26 * d - time.width, inside + time.ascent)
      inside += time.height + 14 * d
      pieces.add(marks, ChannelPiece.Fill(box(12 * d, cardTop, w - 24 * d, inside - cardTop), 18 * d, ChannelLook.card))
      y = inside + 6 * d
    } else {
      y += (if (row.header) 10 else 1) * d
      val left = 66 * d
      val inner = w - left - 14 * d
      val headTop = y
      if (row.header) {
        val face = box(14 * d, y, 40 * d, 40 * d)
        val pair = orbPair(row.avatarColor)
        val letters = if (row.initials.isEmpty()) null else line(row.initials, ChannelFont.INITIALS, ChannelLook.white, 34 * d)
        pieces.add(ChannelPiece.Avatar(face, row.avatarId, intArrayOf(pair.first, argb(row.avatarColor), pair.second), letters))
        if (row.avatarId.isNotEmpty()) pictures.add(row.avatarId)
        authorBoxes.add(face)
        val time = line(row.time, ChannelFont.SMALL, ChannelLook.subtle, 60 * d)
        val ribbon = if (row.owner) 19 * d else 0f
        val name = line(row.author, ChannelFont.NAME, row.authorColor?.let { argb(it) } ?: ChannelLook.text, maxOf(20 * d, inner - time.width - 8 * d - ribbon))
        val baseline = y + name.ascent
        text(name, left, baseline)
        authorBoxes.add(box(left, y - 4 * d, name.width, name.height + 8 * d))
        var after = left + name.width + 8 * d
        if (row.owner) {
          pieces.add(ChannelPiece.Icon("rosette", box(after - 2 * d, baseline - 12 * d, 14 * d, 14 * d), ChannelLook.mark))
          after += ribbon
        }
        text(time, after, baseline)
        y += name.height + 2 * d
      }
      y = content(left, inner, y, 0f)
      if (row.header) y = maxOf(y, headTop + 40 * d)
      y += 2 * d
    }
    if (row.forMe) {
      // It mentions the person or answers them.
      pieces.add(marks, ChannelPiece.Fill(RectF(0f, top, w, y), 0f, Theme.alpha(ChannelLook.mark, 0.10f)))
      pieces.add(marks + 1, ChannelPiece.Fill(RectF(0f, top, 2 * d, y), 0f, ChannelLook.mark))
    }
    height = ceil(y).toInt()
  }

  /** The message itself: what it answers, its text, what is attached, an invitation, the reactions. */
  private fun content(x: Float, inner: Float, start: Float, gap: Float): Float {
    var y = start
    var any = false
    fun step(margin: Float) {
      if (any) y += gap + margin * d
      any = true
    }
    if (row.hasReply) {
      step(0f)
      val author = line(row.replyAuthor, ChannelFont.REPLY_BOLD, ChannelLook.muted, (inner - 19 * d) * 0.6f)
      val space = paints[ChannelFont.REPLY].measureText(" ")
      val words = line(row.replyText, ChannelFont.REPLY, ChannelLook.muted, maxOf(0f, inner - 19 * d - author.width - space))
      pieces.add(ChannelPiece.Icon("reply", box(x, y + 2 * d, 13 * d, 13 * d), ChannelLook.subtle))
      text(author, x + 19 * d, y + author.ascent)
      text(words, x + 19 * d + author.width + space, y + author.ascent)
      y += author.height + 3 * d
    }
    if (row.text.isNotEmpty()) {
      step(0f)
      val made = ChannelType.block(ChannelType.body(row, d), if (row.blog) ChannelFont.POST else ChannelFont.BODY, if (row.blog) 4f else 2.5f, inner, paints)
      pieces.add(ChannelPiece.Block(made, x, y))
      body = made; bodyX = x; bodyY = y
      y += made.height
    }
    if (row.attachKind == 1) {
      step(4f)
      val picture = box(x, y, if (row.blog) inner else minOf(240 * d, inner), (if (row.blog) 240 else 180) * d)
      pieces.add(ChannelPiece.Fill(picture, 12 * d, ChannelLook.surface))
      pieces.add(ChannelPiece.Picture(picture, row.attachId, 12 * d))
      pictures.add(row.attachId)
      attachmentBox = picture
      y += picture.height()
    } else if (row.attachKind != 0) {
      step(4f)
      val file = box(x, y, minOf(300 * d, inner), 60 * d)
      pieces.add(ChannelPiece.Fill(file, 12 * d, ChannelLook.surface))
      pieces.add(ChannelPiece.Fill(box(x + 10 * d, y + 10 * d, 40 * d, 40 * d), 10 * d, ChannelLook.soft))
      pieces.add(ChannelPiece.Icon(if (row.attachKind == 3) "video" else "doc", box(x + 19 * d, y + 19 * d, 22 * d, 22 * d), ChannelLook.accent))
      val name = line(row.attachName, ChannelFont.FILE_NAME, ChannelLook.text, file.width() - 70 * d)
      val size = line(row.attachSize, ChannelFont.FILE_SIZE, ChannelLook.muted, file.width() - 70 * d)
      text(name, x + 60 * d, y + 13 * d + name.ascent)
      text(size, x + 60 * d, y + 33 * d + size.ascent)
      attachmentBox = file
      y += file.height()
    }
    val invite = row.invite
    if (invite != null) {
      step(6f)
      y = inviteCard(invite, x, minOf(300 * d, inner), y)
    }
    if (row.chips.isNotEmpty()) {
      step(4f)
      var cx = 0f; var cy = 0f
      for (chip in row.chips) {
        val emoji = line(chip.emoji, ChannelFont.CHIP_EMOJI, ChannelLook.text, 60 * d)
        val count = line(chip.count.toString(), ChannelFont.CHIP_COUNT, if (chip.mine) ChannelLook.accent else ChannelLook.muted, 60 * d)
        val wide = 8 * d + emoji.width + 5 * d + count.width + 8 * d
        if (cx > 0 && cx + wide > inner) { cx = 0f; cy += 31 * d }
        val frame = box(x + cx, y + cy, wide, 26 * d)
        pieces.add(ChannelPiece.Fill(frame, 13 * d, if (chip.mine) ChannelLook.soft else ChannelLook.surface))
        pieces.add(ChannelPiece.Border(frame, 13 * d, if (chip.mine) ChannelLook.accent else ChannelLook.line))
        text(emoji, frame.left + 8 * d, frame.centerY() + (emoji.ascent - emoji.descent) / 2)
        text(count, frame.left + 8 * d + emoji.width + 5 * d, frame.centerY() + (count.ascent - count.descent) / 2)
        chipBoxes.add(Pair(frame, chip.emoji))
        cx += wide + 5 * d
      }
      y += cy + 26 * d
    }
    return y
  }

  private fun inviteCard(invite: ChannelInviteCard, x: Float, wide: Float, y: Float): Float {
    if (invite.state != 2) {
      val plate = box(x, y, wide, 44 * d)
      pieces.add(ChannelPiece.Fill(plate, 14 * d, ChannelLook.surface))
      pieces.add(ChannelPiece.Icon("link", box(x + 12 * d, y + 13 * d, 18 * d, 18 * d), ChannelLook.subtle))
      val words = line(if (invite.state == 1) "Приглашение недействительно" else "Приглашение", ChannelFont.REPLY, ChannelLook.muted, wide - 50 * d)
      text(words, x + 38 * d, y + 22 * d + (words.ascent - words.descent) / 2)
      return y + 44 * d
    }
    val card = box(x, y, wide, 144 * d)
    pieces.add(ChannelPiece.Fill(card, 16 * d, 0x0FFFFFFF))
    pieces.add(ChannelPiece.Border(card, 16 * d, ChannelLook.line))
    val kind = line((if (invite.blog) "КАНАЛ" else "СЕРВЕР") + (if (invite.closed) " · ЗАКРЫТЫЙ" else ""), ChannelFont.KIND, ChannelLook.muted, wide - 24 * d)
    text(kind, x + 12 * d, y + 12 * d + kind.ascent)
    val face = box(x + 12 * d, y + 36 * d, 48 * d, 48 * d)
    val pair = ChannelWords.gradient(invite.communityId)
    val letters = line(ChannelWords.initials(invite.name), ChannelFont.FACE, ChannelLook.white, 40 * d)
    pieces.add(ChannelPiece.Avatar(face, invite.avatarId, intArrayOf(argb(pair.first), argb(pair.second)), letters))
    if (invite.avatarId.isNotEmpty()) pictures.add(invite.avatarId)
    val name = line(invite.name, ChannelFont.CARD_NAME, ChannelLook.text, wide - 83 * d)
    text(name, x + 71 * d, y + 40 * d + name.ascent)
    val details = line(invite.details, ChannelFont.FILE_SIZE, ChannelLook.muted, wide - 83 * d)
    text(details, x + 71 * d, y + 63 * d + details.ascent)
    val button = box(x + 12 * d, y + 94 * d, wide - 24 * d, 38 * d)
    pieces.add(ChannelPiece.Fill(button, 10 * d, if (invite.member) ChannelLook.surface else ChannelLook.join))
    val label = line(if (invite.member) "Открыть" else if (invite.blog) "Перейти в канал" else "Перейти на сервер", ChannelFont.BUTTON, if (invite.member) ChannelLook.text else ChannelLook.white, wide - 40 * d)
    text(label, button.centerX() - label.width / 2, button.centerY() + (label.ascent - label.descent) / 2)
    inviteBox = card
    return y + 144 * d
  }

  /** What is under a point of the row. */
  fun hit(x: Float, y: Float): ChannelHit {
    for ((frame, emoji) in chipBoxes) if (x >= frame.left - 3 * d && x <= frame.right + 3 * d && y >= frame.top - 4 * d && y <= frame.bottom + 4 * d) return ChannelHit.Chip(emoji)
    link(x, y)?.let { return ChannelHit.Link(it) }
    if (attachmentBox?.contains(x, y) == true) return ChannelHit.Attachment
    if (inviteBox?.contains(x, y) == true) return ChannelHit.Invite
    if (authorBoxes.any { it.contains(x, y) }) return ChannelHit.Author
    return ChannelHit.Row
  }

  private fun link(px: Float, py: Float): String? {
    val layout = body ?: return null
    if (row.links.isEmpty()) return null
    val x = px - bodyX; val y = py - bodyY
    if (y < 0 || y > layout.height || x < -4 * d) return null
    val line = layout.getLineForVertical(y.toInt())
    if (x > layout.getLineWidth(line) + 4 * d) return null
    val touched = layout.getOffsetForHorizontal(line, x)
    // The nearest gap between two letters: the letter touched is the one before it or after it.
    val at = if (touched > 0 && x < layout.getPrimaryHorizontal(touched)) touched - 1 else touched
    return row.links.firstOrNull { at >= it.location && at < it.location + it.length }?.url
  }

  /** Read aloud for the row. */
  val spoken: String
    get() {
      val parts = ArrayList<String>()
      if (row.header) parts.add(row.author)
      if (row.text.isNotEmpty()) parts.add(row.text)
      if (row.attachKind != 0) parts.add(if (row.attachKind == 1) "Фото" else row.attachName)
      parts.add(row.time)
      return parts.joinToString(". ")
    }
}

/** One row of the list: ONE view that draws its finished layout — no children, nothing measured. */
@SuppressLint("ViewConstructor")
class ChannelRowView(context: Context) : View(context) {
  var layoutInfo: ChannelRowLayout? = null
    private set

  fun show(layout: ChannelRowLayout) {
    val before = layoutInfo
    if (before === layout) return
    layoutInfo = layout
    contentDescription = layout.spoken
    if (before == null || before.height != layout.height || before.width != layout.width) requestLayout()
    invalidate()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthSpec), layoutInfo?.height ?: 0)
  }

  private fun cover(image: Bitmap, box: RectF, kept: Shader?, keptOf: Bitmap?): Shader {
    val shader = if (kept != null && keptOf === image) kept else BitmapShader(image, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
    val scale = maxOf(box.width() / image.width, box.height() / image.height)
    matrix.reset(); matrix.setScale(scale, scale)
    matrix.postTranslate(box.centerX() - image.width * scale / 2, box.centerY() - image.height * scale / 2)
    shader.setLocalMatrix(matrix)
    return shader
  }

  private fun draw(canvas: Canvas, line: ChannelType.Line, x: Float, baseline: Float, paints: ChannelPaints) {
    val paint = paints[line.font]
    paint.color = line.color
    canvas.drawText(line.text, x, baseline, paint)
  }

  override fun onDraw(canvas: Canvas) {
    val layout = layoutInfo ?: return
    val d = resources.displayMetrics.density
    val paints = drawing?.takeIf { it.d == d } ?: ChannelPaints(d).also { drawing = it }
    for (piece in layout.pieces) {
      when (piece) {
        is ChannelPiece.Fill -> {
          fill.color = piece.color
          if (piece.radius <= 0f) canvas.drawRect(piece.box, fill) else canvas.drawRoundRect(piece.box, piece.radius, piece.radius, fill)
        }
        is ChannelPiece.Border -> {
          stroke.color = piece.color; stroke.strokeWidth = maxOf(1f, d * 0.75f)
          val half = stroke.strokeWidth / 2
          canvas.drawRoundRect(piece.box.left + half, piece.box.top + half, piece.box.right - half, piece.box.bottom - half, piece.radius, piece.radius, stroke)
        }
        is ChannelPiece.Text -> draw(canvas, piece.line, piece.x, piece.baseline, paints)
        is ChannelPiece.Block -> { canvas.save(); canvas.translate(piece.x, piece.y); piece.layout.draw(canvas); canvas.restore() }
        is ChannelPiece.Avatar -> {
          val box = piece.box
          val image = ChannelImages.image(piece.id, ChannelPixels.pixels(box.width(), box.height()))
          if (image != null) {
            val shader = cover(image, box, piece.picture, piece.pictureOf)
            piece.picture = shader; piece.pictureOf = image
            picture.shader = shader
            canvas.drawCircle(box.centerX(), box.centerY(), box.width() / 2, picture)
            picture.shader = null
          } else {
            val gradient = piece.gradient ?: LinearGradient(box.left + box.width() * 0.1f, box.top, box.left + box.width() * 0.9f, box.bottom, piece.colors, null, Shader.TileMode.CLAMP).also { piece.gradient = it }
            fill.shader = gradient
            canvas.drawCircle(box.centerX(), box.centerY(), box.width() / 2, fill)
            fill.shader = null
            piece.letters?.let { draw(canvas, it, box.centerX() - it.width / 2, box.centerY() + (it.ascent - it.descent) / 2, paints) }
          }
        }
        is ChannelPiece.Picture -> {
          val box = piece.box
          val image = ChannelImages.image(piece.id, ChannelPixels.pixels(box.width(), box.height())) ?: continue
          val shader = cover(image, box, piece.shader, piece.shaderOf)
          piece.shader = shader; piece.shaderOf = image
          picture.shader = shader
          canvas.drawRoundRect(box, piece.radius, piece.radius, picture)
          picture.shader = null
        }
        is ChannelPiece.Icon -> ChannelIcons.draw(canvas, piece.name, piece.box.centerX(), piece.box.centerY(), minOf(piece.box.width(), piece.box.height()), piece.color)
      }
    }
  }

  /** What the main thread draws with (it is the only thread that draws). */
  private companion object {
    val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    val matrix = Matrix()
    var drawing: ChannelPaints? = null
  }
}
