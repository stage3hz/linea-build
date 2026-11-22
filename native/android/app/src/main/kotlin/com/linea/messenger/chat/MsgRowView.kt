package com.linea.messenger.chat

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
import android.graphics.Color
import android.text.Layout
import android.text.SpannableString
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LeadingMarginSpan
import android.text.style.LineBackgroundSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.Base64
import android.view.View
import com.linea.messenger.design.Theme
import com.linea.messenger.voice.MediaRowArt
import com.linea.messenger.voice.MsgMediaBoxes
import com.linea.messenger.voice.MsgMediaState

/** The open look: no bubbles. A message is its text on the page — own at the right edge, the other side's at
 *  the left — and the time follows the last word on the same line. */
// ChatLook: the open look is the default; bubbles come with a wallpaper or the choice in «Оформление»
// (chatlook/BubbleLook.kt).
val MSG_OPEN_LOOK: Boolean get() = com.linea.messenger.chatlook.ChatBubbleLook.open
/** From the screen's edge to a message's plate, dp (the text stands 13 further in). */
private const val MSG_EDGE = 3f
/** The same without the open look. */
private const val MSG_EDGE_BUBBLES = 9f

/** One chat row drawn on the canvas: a message (forward line, quote, picture with its label, text, time and ticks)
 *  or a centred notice. Its height comes from the text it lays out for the width it is given. */
class MsgRowView(context: Context) : View(context) {
  private val edge: Float get() = (if (MSG_OPEN_LOOK) MSG_EDGE else MSG_EDGE_BUBBLES) * resources.displayMetrics.density
  /** ChatLook: the look the last layout was made for (bubbles or not, the corners, the line's colour). */
  private var builtLook = ""
  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val body = TextPaint(Paint.ANTI_ALIAS_FLAG)
  private val small = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f * d }
  private val smallBold = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12.5f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
  private val meta = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d }
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val bigPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
  private val matrix = Matrix()
  private val path = Path()
  private val plateBox = android.graphics.RectF()

  private var row: MsgRow? = null
  private var palette = MsgPalette.DARK
  private var fontSize = 17f
  private var thumbOf = ""
  private var thumb: Bitmap? = null
  /** The spoilers of this message have been tapped open. */
  private var revealed = false
  /** Where the body text was drawn last (for taps on links and spoilers). */
  private var bodyX = 0f
  private var bodyY = 0f
  /** ChatActions: the row is lit for a moment (the message a quote or the pinned bar jumped to). */
  var flash = false
    set(value) { if (field != value) { field = value; invalidate() } }
  /** ChatActions: where the quote of an answer was drawn last (a tap on it jumps to the original). */
  private var quoteLeft = 0f
  private var quoteTop = 0f
  private var quoteRight = 0f
  private var quoteBottom = 0f

  /** Voice/Video: what is playing in this row right now (null: nothing), and where its parts were drawn last. */
  var mediaState: MsgMediaState? = null
    set(value) { if (field != value) { field = value; invalidate() } }
  private val mediaBoxes = MsgMediaBoxes()
  private val mediaPicture = android.graphics.RectF()
  private var voiceW = 0f
  private var voiceH = 0f

  /** Voice/Video: the part of a voice message, a video or a round video under a point of this view
   *  ("play", "wave" with the place on it, "rate" or "thumb"). */
  fun mediaAt(px: Float, py: Float): Pair<String, Float>? = mediaBoxes.part(px, py, d)

  /** Voice/Video: where the picture of this row's video or round video was drawn last (null: it has none). */
  fun mediaThumb(): android.graphics.RectF? = if (mediaBoxes.thumb.isEmpty) null else mediaBoxes.thumb

  /** LinkPreview: the card of the row laid out by the last measure, its decoded picture, and where it was drawn last. */
  private var card: com.linea.messenger.linkpreview.MsgLinkCardLayout? = null
  private var cardOf = ""
  private var cardPicture: Bitmap? = null
  private var cardX = 0f
  private var cardY = 0f

  /** LinkPreview: the address of the card under a point of this view. */
  fun cardAt(px: Float, py: Float): String? {
    val laid = card ?: return null
    if (builtFor != row || px < cardX || px > cardX + laid.width || py < cardY || py > cardY + laid.height) return null
    return laid.card.url
  }

  /** The key of the row this view shows. */
  val rowKey: String get() = row?.key ?: ""

  /** ChatActions: whether a point of this view is on the quote of an answer. */
  fun quoteAt(px: Float, py: Float): Boolean =
    quoteLayout != null && quoteRight > quoteLeft && px >= quoteLeft - 2f * d && px <= quoteRight + 2f * d && py >= quoteTop - 3f * d && py <= quoteBottom + 3f * d
  private val chipEmoji = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 15f * d }
  private val chipCount = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
  private class Chip(val emoji: String, val count: Int, val mine: Boolean, val x: Float, val y: Float, val w: Float)
  /** Reaction chips laid out for the bubble's width (positions from the chips' own corner). */
  private var chips: List<Chip> = emptyList()
  private var chipsW = 0f
  private var chipsH = 0f
  private var chipsX = 0f
  private var chipsY = 0f

  private fun layoutChips(item: MsgRow, width: Float) {
    val out = ArrayList<Chip>(); var x = 0f; var y = 0f; var widest = 0f; var i = 0
    while (i + 2 < item.chips.size) {
      val emoji = item.chips[i]; val count = item.chips[i + 1].toIntOrNull() ?: 1; val mine = item.chips[i + 2] == "1"; i += 3
      var w = chipEmoji.measureText(emoji) + 16f * d
      if (count > 1) w += 4f * d + chipCount.measureText(count.toString())
      if (x > 0f && x + w > width) { x = 0f; y += 29f * d }
      out.add(Chip(emoji, count, mine, x, y, w)); x += w + 5f * d; widest = maxOf(widest, x - 5f * d)
    }
    chips = out; chipsW = widest; chipsH = if (out.isEmpty()) 0f else y + 24f * d
  }

  /** The reaction chip under a point of this view. */
  fun chipAt(px: Float, py: Float): String? =
    chips.firstOrNull { px >= chipsX + it.x - 3f * d && px <= chipsX + it.x + it.w + 3f * d && py >= chipsY + it.y - 4f * d && py <= chipsY + it.y + 28f * d }?.emoji

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
  /** The time stands on the text's last line: `timeX` from the text's left, its baseline `timeBase` under the text's top. */
  /** Polls: the poll laid out for this row, and where it was drawn last. */
  private var pollLayout: com.linea.messenger.polls.MsgPollLayout? = null
  private var pollX = 0f
  private var pollY = 0f
  /** Composer: the big emoji of the row (1–3), their box (px), and their animations (composer/BigEmoji.kt). */
  private var bigGlyphs: List<String> = emptyList()
  private var bigBox = 0f
  private val bigArt = com.linea.messenger.composer.BigEmojiArt(this)

  /** Polls: the part of the poll under a point of this view ("option:<n>", "vote", "retract"). */
  fun pollAt(px: Float, py: Float): String? {
    val laid = pollLayout ?: return null
    if (builtFor != row) return null
    return laid.part(px - pollX, py - pollY)
  }

  private var timeInline = false
  private var timeX = 0f
  private var timeBase = 0f

  // Media: an album's mosaic (attachments/AlbumGrid.kt), its decoded small pictures, and where it was drawn last.
  private var albumLayout: com.linea.messenger.attachments.MsgAlbumLayout? = null
  private var albumOf: com.linea.messenger.attachments.MsgAlbum? = null
  private var albumPictures: Map<String, Bitmap> = emptyMap()
  private var albumX = 0f
  private var albumY = 0f
  /** Attachments: a photo without words — the picture alone, the time in its corner; a file's card (0: none). */
  private var photoBare = false
  private var fileW = 0f
  private var fileH = 0f

  /** Media: the row key of the album's part under a point of this view, or null. */
  fun albumAt(px: Float, py: Float): String? {
    val laid = albumLayout ?: return null
    val album = row?.album ?: return null
    if (builtFor != row) return null
    return laid.part(px - albumX, py - albumY, album)
  }

  fun bind(next: MsgRow, colors: MsgPalette, size: Float, open: Boolean = false) {
    // ChatLook: a new look (bubbles, corners) lays the row out again.
    val look = com.linea.messenger.chatlook.ChatBubbleLook.key
    if (look != builtLook) { builtLook = look; builtFor = null; requestLayout() }
    if (row == next && palette == colors && fontSize == size && revealed == open) { invalidate(); return }
    // Formatted text carries its colours in spans, so new colours mean a new layout as well.
    val styledAgain = next.fmt.isNotEmpty() && (palette != colors || revealed != open)
    val relayout = row != next || fontSize != size || styledAgain
    if (styledAgain) builtFor = null
    row = next; palette = colors; fontSize = size; revealed = open
    if (next.album != albumOf) { albumOf = next.album; albumPictures = next.album?.let { com.linea.messenger.attachments.MsgAlbumLayout.pictures(it) } ?: emptyMap() } // Media
    if (next.thumb != thumbOf) {
      thumbOf = next.thumb
      thumb = if (next.thumb.isEmpty()) null else try { val bytes = Base64.decode(next.thumb, Base64.DEFAULT); BitmapFactory.decodeByteArray(bytes, 0, bytes.size) } catch (_: Throwable) { null }
    }
    // LinkPreview: the card's picture is decoded once per row, not on every drawing.
    val cardImage = next.linkCard?.image ?: ""
    if (cardImage != cardOf) { cardOf = cardImage; cardPicture = next.linkCard?.picture() }
    // Attachments: a photo or a file card shown in its row; a photo up to 10 MB comes by itself (attachments/InlineMedia.kt).
    if (next.media == "photo" || next.media == "file") com.linea.messenger.attachments.InlineMedia.shown(next.key, next.media == "photo")
    else if (next.album != null) com.linea.messenger.attachments.InlineMedia.gone(next.key) // an album's first photo opens from its tile
    contentDescription = if (next.kind == 1 || next.kind == 2) next.text else listOf(if (next.media == "photo") "Фото" else "", MediaRowArt.spoken(next), next.label, next.text, next.poll?.spoken ?: "", next.linkCard?.spoken ?: "", if (next.silent) "без звука" else "", next.time).filter { it.isNotEmpty() }.joinToString(". ")
    if (relayout) requestLayout()
    invalidate()
  }

  /** One tap shows every spoiler of the message. */
  fun reveal() { if (revealed) return; revealed = true; builtFor = null; requestLayout(); invalidate() }

  private fun alpha(color: Int, a: Int) = (color and 0x00FFFFFF) or (a shl 24)

  /** The text with its formatting. Flags: 1 bold, 2 italic, 4 underline, 8 strike, 16 monospace, 32 spoiler
   *  (a block until tapped), 64 link, 128 quote, 256 code block. */
  private fun styled(item: MsgRow): CharSequence {
    if (item.fmt.isEmpty()) return item.text
    val out = SpannableString(item.text)
    val linkColor = if (item.mine) palette.mineMark else palette.accent
    var i = 0
    while (i + 2 < item.fmt.size) {
      val flags = item.fmt[i]; val start = item.fmt[i + 1]; val end = start + item.fmt[i + 2]; i += 3
      if (start < 0 || end <= start || end > item.text.length) continue
      fun put(span: Any) = out.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      val bold = flags and 1 != 0; val italic = flags and 2 != 0
      if (bold || italic) put(StyleSpan(if (bold && italic) Typeface.BOLD_ITALIC else if (bold) Typeface.BOLD else Typeface.ITALIC))
      if (flags and (4 or 64) != 0) put(UnderlineSpan())
      if (flags and 8 != 0) put(StrikethroughSpan())
      if (flags and 16 != 0) { put(TypefaceSpan("monospace")); put(AbsoluteSizeSpan(((fontSize - 1f).coerceAtLeast(10f) * d).toInt())); if (flags and 256 == 0) put(BackgroundColorSpan(alpha(palette.text, 0x1A))) }
      // A quote (with the accent bar) and a code block are plates under their lines.
      if (flags and 128 != 0) { put(LeadingMarginSpan.Standard((11f * d).toInt())); put(Plate(palette.quote, linkColor, 3f * d)) }
      if (flags and 256 != 0) { put(LeadingMarginSpan.Standard((8f * d).toInt())); put(Plate(alpha(palette.text, 0x1A), 0, 0f)) }
      if (flags and 64 != 0) put(ForegroundColorSpan(linkColor))
      if (flags and 32 != 0) {
        if (revealed) put(BackgroundColorSpan(alpha(palette.text, 0x12)))
        else { put(ForegroundColorSpan(Color.TRANSPARENT)); put(BackgroundColorSpan(alpha(palette.text, 0x47))) }
      }
    }
    return out
  }

  /** The plate of a quote or a code block: every line of it gets the fill, a quote also the bar on the left. */
  private class Plate(val color: Int, val bar: Int, val barWidth: Float) : LineBackgroundSpan {
    override fun drawBackground(canvas: Canvas, paint: Paint, left: Int, right: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, lineNumber: Int) {
      val was = paint.color; val style = paint.style
      paint.style = Paint.Style.FILL; paint.color = color
      canvas.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
      if (barWidth > 0f) { paint.color = bar; canvas.drawRect(left.toFloat(), top.toFloat(), left + barWidth, bottom.toFloat(), paint) }
      paint.color = was; paint.style = style
    }
  }

  /** A link (address, linked text) or a still hidden spoiler ("" as the address) under a point of this view. */
  fun runAt(px: Float, py: Float): Pair<String, String>? {
    val item = row ?: return null
    val layout = textLayout ?: return null
    if (item.fmt.isEmpty()) return null
    val x = px - bodyX; val y = py - bodyY
    if (y < 0 || y > layout.height || x < -4f * d) return null
    val line = layout.getLineForVertical(y.toInt())
    if (x > layout.getLineWidth(line) + 4f * d) return null
    val index = layout.getOffsetForHorizontal(line, x).coerceIn(0, (item.text.length - 1).coerceAtLeast(0))
    var link = 0; var i = 0
    while (i + 2 < item.fmt.size) {
      val flags = item.fmt[i]; val start = item.fmt[i + 1]; val end = start + item.fmt[i + 2]; i += 3
      val isLink = flags and 64 != 0
      if (index in start until end && start >= 0 && end <= item.text.length) {
        val hidden = flags and 32 != 0 && !revealed
        val url = if (isLink) item.urls.getOrNull(link) ?: "" else ""
        if (hidden || url.isNotEmpty()) return Pair(if (hidden) "" else url, item.text.substring(start, end))
      }
      if (isLink) link++
    }
    return null
  }

  private fun layout(text: CharSequence, paint: TextPaint, width: Int, lines: Int, center: Boolean = false): StaticLayout =
    StaticLayout.Builder.obtain(text, 0, text.length, paint, width.coerceAtLeast(1))
      .setAlignment(if (center) Layout.Alignment.ALIGN_CENTER else Layout.Alignment.ALIGN_NORMAL)
      .setMaxLines(lines).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).setLineSpacing(2f * d, 1f).build()

  private fun widest(layout: StaticLayout?): Float { var w = 0f; if (layout != null) for (i in 0 until layout.lineCount) w = maxOf(w, layout.getLineWidth(i)); return w }

  private fun build(item: MsgRow, width: Int) {
    body.textSize = fontSize * d
    textLayout = null; quoteLayout = null; labelLayout = null; noticeLayout = null; reactLayout = null; thumbW = 0f; thumbH = 0f; voiceW = 0f; voiceH = 0f
    chips = emptyList(); chipsW = 0f; chipsH = 0f; timeInline = false; card = null; pollLayout = null; bigGlyphs = emptyList(); bigBox = 0f
    albumLayout = null // Media
    photoBare = false; fileW = 0f; fileH = 0f // Attachments
    if (item.kind == 2) {
      // Offline: the lock notice of messages sent before this device signed in (the reference's MissingRow).
      val box = minOf(width - 2 * edge, 360f * d)
      noticeLayout = layout(item.text, small, (box - 54f * d).toInt(), 8, false)
      bubbleW = minOf(box, widest(noticeLayout) + 54f * d); bubbleH = maxOf((noticeLayout?.height ?: 0).toFloat(), 18f * d) + 20f * d
    } else if (item.kind == 1) {
      noticeLayout = layout(item.text, small, (width * 0.8f).toInt(), 6, true)
      bubbleW = widest(noticeLayout) + 24f * d; bubbleH = (noticeLayout?.height ?: 0) + 12f * d
    } else {
      val inner = (width * 0.78f - 26f * d).toInt()
      // Composer: 1–3 emoji alone stand large, each in its box (the reference's 112 / 84 / 68).
      if (item.bigEmoji > 0) { bigGlyphs = com.linea.messenger.composer.BigEmoji.graphemes(item.text).take(3); bigBox = com.linea.messenger.composer.BigEmoji.box(bigGlyphs.size) * d }
      if (item.text.isNotEmpty() && bigGlyphs.isEmpty()) textLayout = layout(styled(item), body, inner, 400)
      if (item.quoteText.isNotEmpty() || item.quoteAuthor.isNotEmpty()) quoteLayout = layout(item.quoteText, small, inner - (12f * d).toInt(), 2)
      if (item.label.isNotEmpty() && item.media != "photo" && item.media != "file") labelLayout = layout(item.label, small, inner, 2) // Attachments: a file's card draws its own words
      layoutChips(item, inner.toFloat())
      if (item.reactions.isNotEmpty() && chips.isEmpty()) reactLayout = layout(item.reactions, small, inner, 2)
      if (thumb != null) { thumbW = minOf(inner.toFloat(), 220f * d); thumbH = (thumbW / item.thumbWide.toFloat()).coerceIn(90f * d, 300f * d) }
      // Voice/Video: a round video is a circle, a video keeps its place even before its picture is known, a voice
      // message is a block of its own.
      if (item.media == "note") { thumbW = minOf(inner.toFloat(), MediaRowArt.noteSide * d); thumbH = thumbW }
      else if (item.media == "video" && thumb == null) { thumbW = minOf(inner.toFloat(), 220f * d); thumbH = (thumbW / item.thumbWide.toFloat()).coerceIn(90f * d, 300f * d) }
      else if (item.media == "voice") { voiceW = minOf(inner.toFloat(), MediaRowArt.voiceWidth * d); voiceH = MediaRowArt.voiceHeight * d }
      // Attachments: a photo shown whole, a file as a card (MediaBubble.tsx; attachments/InlineMedia.kt).
      else if (item.media == "photo") com.linea.messenger.attachments.InlineMediaArt.photoSize(item, width.toFloat(), d).let { thumbW = it.first; thumbH = it.second }
      else if (item.media == "file") com.linea.messenger.attachments.InlineMediaArt.fileSize(item, inner.toFloat(), d).let { fileW = it.first; fileH = it.second }
      val metaWidth = meta.measureText(item.time) + (if (item.mine) 22f * d else 0f) + (if (item.silent) 15f * d else 0f) // Composer: the bell of «без звука»
      var w = maxOf(maxOf(widest(textLayout), metaWidth, thumbW, widest(labelLayout)), maxOf(widest(reactLayout), chipsW, voiceW))
      w = maxOf(w, fileW) // Attachments
      if (quoteLayout != null) w = maxOf(w, maxOf(widest(quoteLayout), smallBold.measureText(item.quoteAuthor)) + 12f * d)
      if (item.forward.isNotEmpty()) w = maxOf(w, minOf(inner.toFloat(), smallBold.measureText(item.forward)))
      // LinkPreview: the card stands under the text, and the time then goes under the card.
      item.linkCard?.let { link -> card = com.linea.messenger.linkpreview.MsgLinkCardLayout.make(link, inner.toFloat(), d).also { w = maxOf(w, it.width) } }
      // Polls: the poll stands where the text would (a poll's text is only for clients without polls).
      item.poll?.let { poll -> pollLayout = com.linea.messenger.polls.MsgPollLayout.make(poll, inner.toFloat(), d).also { w = maxOf(w, it.width) } }
      if (bigGlyphs.isNotEmpty()) w = maxOf(w, bigBox * bigGlyphs.size)
      // Media: an album's mosaic stands above its caption.
      item.album?.let { album -> albumLayout = com.linea.messenger.attachments.MsgAlbumLayout.make(album, width.toFloat(), inner.toFloat(), d).also { w = maxOf(w, it.width) } }
      // The open look: the time goes after the last word when the line has room for it (plain left-to-right
      // text only: not under reactions, not after a quote or a code block).
      val text = textLayout
      if (MSG_OPEN_LOOK && text != null && text.lineCount > 0 && reactLayout == null && chips.isEmpty() && card == null && (0 until item.fmt.size step 3).none { item.fmt[it] and (128 or 256) != 0 }) {
        val last = text.lineCount - 1
        val end = Math.ceil(text.getLineMax(last).toDouble()).toFloat()
        if (text.getParagraphDirection(last) == Layout.DIR_LEFT_TO_RIGHT && text.getEllipsisCount(last) == 0 && end + 8f * d + metaWidth <= inner) {
          timeInline = true; timeX = end + 8f * d; timeBase = text.getLineBaseline(last).toFloat()
          w = maxOf(w, end + 8f * d + metaWidth)
        }
      }
      // Attachments: a photo without words is the picture alone (MessageRow.tsx `bare`).
      if (item.media == "photo" && item.text.isEmpty() && item.quoteText.isEmpty() && item.quoteAuthor.isEmpty() && item.forward.isEmpty() && reactLayout == null && chips.isEmpty()) {
        photoBare = true; bubbleW = thumbW; bubbleH = thumbH
        builtFor = item; builtWidth = width; builtFont = fontSize
        return
      }
      var h = 9f * d
      if (item.forward.isNotEmpty()) h += 18f * d
      if (quoteLayout != null) h += 17f * d + quoteLayout!!.height + 8f * d
      if (thumbH > 0f) h += thumbH + 6f * d
      albumLayout?.let { h += it.height + 6f * d } // Media
      if (voiceH > 0f) h += voiceH + 4f * d
      if (labelLayout != null) h += labelLayout!!.height + 4f * d
      if (fileH > 0f) h += fileH + 4f * d // Attachments
      pollLayout?.let { h += it.height + 4f * d } // Polls
      if (bigGlyphs.isNotEmpty()) h += bigBox // Composer
      if (textLayout != null) h += textLayout!!.height
      card?.let { h += it.height + 7f * d }
      if (reactLayout != null) h += reactLayout!!.height + 6f * d
      if (chipsH > 0f) h += chipsH + 6f * d
      h += if (timeInline) 6f * d else 16f * d + 6f * d
      bubbleW = w + 26f * d; bubbleH = h
    }
    builtFor = item; builtWidth = width; builtFont = fontSize
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    val item = row
    if (item == null) { setMeasuredDimension(width, 0); return }
    if (builtFor != item || builtWidth != width || builtFont != fontSize) build(item, width)
    val gap = if (item.kind == 2) 20f * d else if (item.kind == 1) 8f * d else if (item.tail) 7f * d else 2f * d
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
    if (item.kind == 2) {
      val left = (w - bubbleW) / 2; val top = 10f * d
      fill.color = palette.notice; canvas.drawRoundRect(left, top, left + bubbleW, top + bubbleH, 16f * d, 16f * d, fill)
      // The lock: its body and its shackle, in the notice's colour.
      val lx = left + 14f * d + 8f * d; val ly = top + bubbleH / 2 + 1f * d
      fill.color = palette.noticeText
      canvas.drawRoundRect(lx - 6f * d, ly - 2f * d, lx + 6f * d, ly + 6f * d, 2f * d, 2f * d, fill)
      stroke.color = palette.noticeText; stroke.strokeWidth = 1.6f * d
      canvas.drawArc(lx - 4f * d, ly - 9f * d, lx + 4f * d, ly - 1f * d, 180f, 180f, false, stroke)
      canvas.drawLine(lx - 4f * d, ly - 5f * d, lx - 4f * d, ly - 2f * d, stroke)
      canvas.drawLine(lx + 4f * d, ly - 5f * d, lx + 4f * d, ly - 2f * d, stroke)
      small.color = palette.noticeText
      noticeLayout?.let { canvas.save(); canvas.translate(left + 40f * d, top + 10f * d); it.draw(canvas); canvas.restore() }
      return
    }
    if (item.kind == 1) {
      val left = (w - bubbleW) / 2
      fill.color = palette.notice; canvas.drawRoundRect(left, 0f, left + bubbleW, bubbleH, 14f * d, 14f * d, fill)
      small.color = palette.noticeText
      noticeLayout?.let { canvas.save(); canvas.translate((w - it.width) / 2, 6f * d); it.draw(canvas); canvas.restore() }
      return
    }
    var side = edge
    if (item.checked >= 0) {
      val cx = 9f * d + 12f * d; val cy = bubbleH / 2
      if (item.checked == 1) {
        fill.color = palette.accent; canvas.drawCircle(cx, cy, 11f * d, fill)
        stroke.color = palette.onAccent; stroke.strokeWidth = 2f * d
        path.reset(); path.moveTo(cx - 5f * d, cy); path.lineTo(cx - 1.5f * d, cy + 3.5f * d); path.lineTo(cx + 5f * d, cy - 3.5f * d); canvas.drawPath(path, stroke)
      } else { stroke.color = palette.subtle; stroke.strokeWidth = 1.6f * d; canvas.drawCircle(cx, cy, 10.5f * d, stroke) }
      if (!item.mine) side += 34f * d
    }
    val left = if (item.mine) w - edge - bubbleW else side
    fill.color = if (item.mine) palette.mine else palette.theirs
    // ChatLook: «Углы сообщений» (8, 14, 20), the corner by the sender's edge 6 at most on the last bubble of a run
    // (chatlook/BubbleLook.kt).
    plateBox.set(left, 0f, left + bubbleW, bubbleH)
    // Attachments: a photo alone — the picture with the time in its corner, no plate and no line.
    if (photoBare) {
      com.linea.messenger.attachments.InlineMediaArt.drawPhoto(canvas, item, left, 0f, bubbleW, bubbleH, palette, thumb, 15f * d, true, d)
      if (isPressed || flash) { fill.color = Theme.veil(if (isPressed) 0.08f else 0.14f); canvas.drawRoundRect(left, 0f, left + bubbleW, bubbleH, 15f * d, 15f * d, fill) }
      return
    }
    com.linea.messenger.chatlook.ChatBubbleLook.shape(path, plateBox, item.mine, item.tail, d)
    // Attachments: a photo with words keeps its card in the open look too.
    if (!MSG_OPEN_LOOK || item.media == "photo") canvas.drawPath(path, fill)
    // ChatLook: the open look — the other side's words carry a thin line in their colour.
    if (MSG_OPEN_LOOK && !item.mine && item.media != "photo" && (item.text.isNotEmpty() || item.label.isNotEmpty())) {
      val line = com.linea.messenger.chatlook.ChatBubbleLook.peerLine
      fill.color = if (line != 0) line else palette.accent
      canvas.drawRect(left, 2f * d, left + 2f * d, bubbleH - 2f * d, fill)
    }
    if (isPressed) { fill.color = Theme.veil(0.08f); canvas.drawPath(path, fill) }
    // ChatActions: the message a jump ended at is lit.
    if (flash) { fill.color = Theme.veil(0.16f); canvas.drawPath(path, fill) }

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
      quoteLeft = x; quoteTop = y; quoteRight = left + bubbleW - 13f * d; quoteBottom = y + height + 2f * d
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
    // Voice/Video: where the picture of a video or a round video stands; without a picture, a quiet plate.
    mediaBoxes.clear()
    if (thumbH > 0f && (item.media == "video" || item.media == "note")) {
      mediaPicture.set(x, y, x + thumbW, y + thumbH)
      mediaBoxes.thumb.set(mediaPicture)
      if (image == null) { MediaRowArt.plate(canvas, item.media == "note", palette, mediaPicture, d); y += thumbH + 6f * d }
    }
    // Attachments: a photo with words, shown whole above them.
    if (item.media == "photo" && thumbH > 0f) { com.linea.messenger.attachments.InlineMediaArt.drawPhoto(canvas, item, x, y, thumbW, thumbH, palette, image, 12f * d, false, d); y += thumbH + 6f * d }
    if (image != null && item.media != "photo" && thumbH > 0f) { drawPicture(canvas, image, x, y, thumbW, thumbH, if (item.thumbRound) minOf(thumbW, thumbH) / 2 else 12f * d); y += thumbH + 6f * d }
    // Voice/Video: the play mark and the length over the picture; the waveform row of a voice message.
    if (!mediaBoxes.thumb.isEmpty) MediaRowArt.marks(canvas, item, mediaState, palette, mediaPicture, d, hosted = com.linea.messenger.video.NotePlayback.hostedKeys.contains(item.key))
    // Media: the album's mosaic.
    albumLayout?.let { albumX = x; albumY = y; it.draw(canvas, item.album ?: return@let, albumPictures, x, y, palette); y += it.height + 6f * d }
    if (voiceH > 0f) { MediaRowArt.voice(canvas, item, mediaState, palette, x, y, voiceW, d, mediaBoxes); y += voiceH + 4f * d }
    labelLayout?.let { small.color = markColor; canvas.save(); canvas.translate(x, y); it.draw(canvas); canvas.restore(); y += it.height + 4f * d }
    // Attachments: a file's card with the round button.
    if (fileH > 0f) { com.linea.messenger.attachments.InlineMediaArt.drawFile(canvas, item, x, y, fileW, fileH, palette, d); y += fileH + 4f * d }
    // Polls: the question, the options and the results.
    pollLayout?.let { pollX = x; pollY = y; it.draw(canvas, x, y, palette); y += it.height + 4f * d }
    // Composer: the big emoji — their animations where the reference has them, the glyphs otherwise.
    if (bigGlyphs.isNotEmpty()) {
      bigArt.show(context, item.key, bigGlyphs)
      bigPaint.textSize = bigBox * 0.86f
      bigGlyphs.forEachIndexed { index, glyph ->
        val bx = x + index * bigBox
        if (bigArt.has(index)) bigArt.draw(canvas, index, bx, y, bigBox)
        else canvas.drawText(glyph, bx + bigBox / 2, y + bigBox / 2 - (bigPaint.ascent() + bigPaint.descent()) / 2, bigPaint)
      }
      y += bigBox
    }
    val textTop = y
    textLayout?.let { body.color = palette.text; bodyX = x; bodyY = y; canvas.save(); canvas.translate(x, y); it.draw(canvas); canvas.restore(); y += it.height }
    // LinkPreview: the card of the link, under the text.
    card?.let { cardX = x; cardY = y + 7f * d; it.draw(canvas, cardX, cardY, palette, markColor, cardPicture, pressed = false); y += it.height + 7f * d }
    reactLayout?.let { small.color = palette.text; canvas.save(); canvas.translate(x, y + 6f * d); it.draw(canvas); canvas.restore() }
    chipsX = x; chipsY = y + 6f * d
    for (chip in chips) {
      val cx = chipsX + chip.x; val cy = chipsY + chip.y
      fill.color = if (chip.mine) palette.accent else alpha(palette.text, 0x1A)
      canvas.drawRoundRect(cx, cy, cx + chip.w, cy + 24f * d, 12f * d, 12f * d, fill)
      chipEmoji.color = palette.text
      canvas.drawText(chip.emoji, cx + 8f * d, cy + 12f * d - (chipEmoji.ascent() + chipEmoji.descent()) / 2, chipEmoji)
      if (chip.count > 1) {
        chipCount.color = if (chip.mine) palette.onAccent else palette.text
        canvas.drawText(chip.count.toString(), cx + 8f * d + chipEmoji.measureText(chip.emoji) + 4f * d, cy + 12f * d - (chipCount.ascent() + chipCount.descent()) / 2, chipCount)
      }
    }

    meta.color = if (item.ticks == 4) palette.danger else metaColor
    val marks = if (item.mine) 20f * d else 0f
    // After the last word of the text, or in the plate's lower corner.
    val inline = timeInline && textLayout != null
    val right = if (inline) x + timeX + meta.measureText(item.time) + marks + (if (item.silent) 15f * d else 0f) else left + bubbleW - 13f * d // Composer: room for the bell
    val base = if (inline) textTop + timeBase else bubbleH - 8f * d
    canvas.drawText(item.time, right - marks - meta.measureText(item.time), base, meta)
    // Composer: «без звука» — a crossed bell before the time.
    if (item.silent) com.linea.messenger.chatactions.ChatIcons.draw(canvas, "bell.slash", right - marks - meta.measureText(item.time) - 8f * d, base - 4f * d, 11f * d, metaColor)
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
