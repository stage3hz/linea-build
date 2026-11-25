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
/** From the screen's edge to a message's plate, dp (ChatScreen.tsx listSide: 6 in the open look, 9 with bubbles). */
private const val MSG_EDGE = 6f
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
  private val body = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Theme.weight(400) }
  private val small = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f * d; typeface = Theme.weight(400) }
  private val meta = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d; typeface = Theme.weight(400) }
  // MessageRow.tsx: «Переслано от …» 11 semibold; the quote's author 11 bold over its words 12; the day 10 semibold;
  // a call's row 14 semibold over its time 11 (tabular digits).
  private val forwardPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d; typeface = Theme.weight(600) }
  private val quoteAuthorPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d; typeface = Theme.weight(700) }
  private val quotePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f * d; typeface = Theme.weight(400) }
  private val dayPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 10f * d; typeface = Theme.weight(600) }
  private val callPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 14f * d; typeface = Theme.weight(600) }
  private val callTimePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d; fontFeatureSettings = "tnum"; typeface = Theme.weight(400) }
  /** Bubbles: the time in the plate's lower corner, its room kept at the end of the words. */
  private var timeCorner = false
  /** The time at the right of the reaction chips' row. */
  private var timeBeside = false
  /** MessageRow.tsx JumpFlash: how much of the light is on (0…1). */
  private var flashLight = 0f
  private var flashRun: android.animation.Animator? = null
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val bigPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; typeface = Theme.weight(400) }
  private val matrix = Matrix()
  private val path = Path()
  private val plateBox = android.graphics.RectF()

  private var row: MsgRow? = null
  private var palette = MsgPalette.DARK
  private var fontSize = 17f
  private var thumbOf = ""
  private var thumb: Bitmap? = null
  /** The quoted message's small picture, decoded once per row. */
  private var quoteOf = ""
  private var quotePicture: Bitmap? = null
  /** The spoilers of this message have been tapped open. */
  private var revealed = false
  /** Where the body text was drawn last (for taps on links and spoilers). */
  private var bodyX = 0f
  private var bodyY = 0f
  /** ChatActions: the row is lit for a moment (the message a quote or the pinned bar jumped to). */
  var flash = false
    set(value) { if (field != value) { field = value; if (value) playFlash(); invalidate() } }

  /** MessageRow.tsx JumpFlash: accentSoft over the row, in 160 ms, held 650 ms, out in 550 ms (withTiming's
   *  Easing.inOut(Easing.quad)). */
  private fun playFlash() {
    flashRun?.cancel()
    val ease = android.view.animation.PathInterpolator(0.455f, 0.03f, 0.515f, 0.955f)
    val rise = android.animation.ValueAnimator.ofFloat(0f, 1f).apply { duration = 160; interpolator = ease; addUpdateListener { flashLight = it.animatedValue as Float; invalidate() } }
    val fade = android.animation.ValueAnimator.ofFloat(1f, 0f).apply { duration = 550; startDelay = 650; interpolator = ease; addUpdateListener { flashLight = it.animatedValue as Float; invalidate() } }
    flashRun = android.animation.AnimatorSet().apply { playSequentially(rise, fade); start() }
  }

  /** From the plate's edges to the words (MessageRow.tsx), px: bubbles 11 + the text's own 1 on both sides; the open
   *  look 2 (line) + 10 + 1 / 4 + 1 for the other side, 4 + 1 / 0 + 1 for one's own. A photo with words keeps its card. */
  private fun pads(item: MsgRow): Pair<Float, Float> =
    // MessageRow.tsx `flush`: a captioned photo, video or album fills its card (2 around it); the words stand 2 + 9 in.
    if (flush(item)) Pair(11f * d, 11f * d)
    else if (!MSG_OPEN_LOOK || item.media == "photo") Pair(12f * d, 12f * d) else if (item.mine) Pair(5f * d, 1f * d) else Pair(13f * d, 5f * d)

  /** MessageRow.tsx `flush`: words under a photo, a video or an album — the picture fills the card edge to edge
   *  (2 around it), always on a card, even in the open look. */
  private fun flush(item: MsgRow): Boolean = (item.media == "photo" || item.media == "video" || item.album != null) && item.text.isNotEmpty() && item.bigEmoji == 0

  /** chatPreferences.ts TEXT_SIZES: the line of each text size (15/20, 17/22, 19/25, 22/28), dp. */
  private fun lineOf(size: Float): Float = when (size) { 15f -> 20f; 17f -> 22f; 19f -> 25f; 22f -> 28f; else -> Math.round(size * 1.3f).toFloat() }

  /** React Native's `lineHeight`: every line exactly `height` px, the glyphs in its middle. */
  private class FixedLine(val height: Int) : android.text.style.LineHeightSpan {
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
      val now = fm.descent - fm.ascent
      if (now <= 0) return
      val extra = height - now
      val up = extra / 2
      fm.ascent -= up; fm.descent += extra - up
      fm.top = fm.ascent; fm.bottom = fm.descent
    }
  }

  /** MessageRow.tsx `inlineTime`: words that do not end in a quote or a code block, without reactions inside. */
  private fun inlineTime(item: MsgRow): Boolean = item.text.isNotEmpty() && item.bigEmoji == 0 && item.chips.isEmpty() && item.reactions.isEmpty() &&
    item.linkCard == null && (0 until item.fmt.size step 3).none { item.fmt[it] and (128 or 256) != 0 }
  /** MessageRow.tsx `plainTime`: the open look, and no rare marks (silent). */
  private fun plainTime(item: MsgRow): Boolean = inlineTime(item) && MSG_OPEN_LOOK && item.media != "photo" && !flush(item) && !item.silent

  /** Room of a fixed width in a line (the 15-point mark after the time), drawing nothing. */
  private class Room(val size: Int) : android.text.style.ReplacementSpan() {
    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int = size
    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {}
  }

  /** The words with the invisible run at their end that keeps the time's room, glued to the last word so both go to
   *  the next line together: the open look's time itself («\u00A0\u00A0[изм. ]time», then «\u00A0» and the 15-point
   *  mark for one's own), or the bubbles' spacer «\u00A0\u00A0\u00A0[silent: 5 × \u00A0]time[mine: 7 × \u00A0]\u00A0», in 11 pt. */
  private fun withTrailing(text: CharSequence, item: MsgRow): CharSequence {
    if (!inlineTime(item)) return text
    val plain = plainTime(item)
    val tail = if (plain) "\u00A0\u00A0" + item.time + (if (item.mine) "\u00A0\uFFFC" else "")
      else "\u00A0\u00A0\u00A0" + (if (item.silent) "\u00A0".repeat(5) else "") + item.time + (if (item.mine) "\u00A0".repeat(7) else "") + "\u00A0"
    val out = android.text.SpannableStringBuilder(text)
    val start = out.length
    out.append(tail)
    out.setSpan(AbsoluteSizeSpan(Math.round(11f * d)), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    out.setSpan(ForegroundColorSpan(Color.TRANSPARENT), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    if (plain && item.mine) out.setSpan(Room(Math.round(15f * d)), out.length - 1, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    return out
  }

  private fun bodyLayout(text: CharSequence, width: Int): StaticLayout {
    val lined = SpannableString(text)
    lined.setSpan(FixedLine(Math.round(lineOf(fontSize) * d)), 0, lined.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
    return StaticLayout.Builder.obtain(lined, 0, lined.length, body, width.coerceAtLeast(1))
      .setAlignment(Layout.Alignment.ALIGN_NORMAL).setMaxLines(400).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).setLineSpacing(0f, 1f).build()
  }
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
  /** Record: a voice row's play button (once the row has been drawn). */
  fun mediaPlay(): android.graphics.RectF? = if (mediaBoxes.play.isEmpty) null else mediaBoxes.play

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
  /** Attachments: whether the row is an album that has the photo of `key` as one of its tiles. */
  fun hasAlbumPart(key: String): Boolean = row?.album?.parts?.any { it.key == key } ?: false
  /** Whether the row is one's own. */
  val mine: Boolean get() = row?.mine ?: true

  /** ChatActions: whether a point of this view is on the quote of an answer. */
  fun quoteAt(px: Float, py: Float): Boolean =
    quoteLayout != null && quoteRight > quoteLeft && px >= quoteLeft - 2f * d && px <= quoteRight + 2f * d && py >= quoteTop - 3f * d && py <= quoteBottom + 3f * d
  private val chipEmoji = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 15f * d; typeface = Theme.weight(400) }
  private val chipCount = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f * d; typeface = Theme.weight(600) }
  private class Chip(val emoji: String, val count: Int, val mine: Boolean, val x: Float, val y: Float, val w: Float)
  /** Reaction chips laid out for the bubble's width (positions from the chips' own corner). */
  private var chips: List<Chip> = emptyList()
  private var chipsW = 0f
  private var chipsH = 0f
  private var chipsX = 0f
  private var chipsY = 0f

  private fun layoutChips(item: MsgRow, width: Float) {
    val out = ArrayList<Chip>(); var x = 0f; var y = 0f; var widest = 0f; var i = 0
    // MessageRow.tsx: reactions outside a bubble (a round video, big emoji) carry a 1-point border: 2 taller and wider.
    val border = if (item.media == "note" || item.bigEmoji > 0) 2f * d else 0f
    while (i + 2 < item.chips.size) {
      val emoji = item.chips[i]; val count = item.chips[i + 1].toIntOrNull() ?: 1; val mine = item.chips[i + 2] == "1"; i += 3
      var w = chipEmoji.measureText(emoji) + 16f * d + border
      if (count > 1) w += 4f * d + chipCount.measureText(count.toString())
      if (x > 0f && x + w > width) { x = 0f; y += 29f * d + border }
      out.add(Chip(emoji, count, mine, x, y, w)); x += w + 5f * d; widest = maxOf(widest, x - 5f * d)
    }
    chips = out; chipsW = widest; chipsH = if (out.isEmpty()) 0f else y + 24f * d + border
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
    if (next.quoteThumb != quoteOf) {
      quoteOf = next.quoteThumb
      quotePicture = if (next.quoteThumb.isEmpty()) null else try { val bytes = Base64.decode(next.quoteThumb, Base64.DEFAULT); BitmapFactory.decodeByteArray(bytes, 0, bytes.size) } catch (_: Throwable) { null }
    }
    // LinkPreview: the card's picture is decoded once per row, not on every drawing.
    val cardImage = next.linkCard?.image ?: ""
    if (cardImage != cardOf) { cardOf = cardImage; cardPicture = next.linkCard?.picture() }
    // Attachments: a photo or a file card shown in its row; a photo up to 10 MB comes by itself (attachments/InlineMedia.kt).
    if (next.media == "photo" || next.media == "file") com.linea.messenger.attachments.InlineMedia.shown(next.key, next.media == "photo")
    else if (next.album != null) com.linea.messenger.attachments.InlineMedia.gone(next.key) // an album's first photo opens from its tile
    // Attachments: the photos of an album come by themselves as well (a photo sent without a small picture showed an empty tile).
    next.album?.parts?.forEach { part -> if (!part.video) com.linea.messenger.attachments.InlineMedia.shownInAlbum(part.key) }
    contentDescription = if (next.kind == 1 || next.kind == 2) next.text else listOf(if (next.media == "photo") "Фото" else "", MediaRowArt.spoken(next), next.label, next.text, next.poll?.spoken ?: "", next.linkCard?.spoken ?: "", if (next.silent) "без звука" else "", next.time).filter { it.isNotEmpty() }.joinToString(". ")
    if (relayout) requestLayout()
    invalidate()
  }

  /** The laid-out words of the row and where they were drawn (for a selectable copy in the message menu). */
  fun bodyCopy(): Triple<StaticLayout, Float, Float>? = textLayout?.let { Triple(it, bodyX, bodyY) }

  /** One tap shows every spoiler of the message. */
  fun reveal() { if (revealed) return; revealed = true; builtFor = null; requestLayout(); invalidate() }

  /** Videonote: the row's circle grew or gave its room back — laid out again. */
  fun regrow() { builtFor = null; requestLayout(); invalidate() }

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

  /** The quote's block: 5 above, the author, 1, the words, 5 below. */
  private fun quoteHeight(quote: StaticLayout): Float =
    5f * d + maxOf(Math.ceil((quoteAuthorPaint.descent() - quoteAuthorPaint.ascent()).toDouble()).toFloat() + 1f * d + quote.height, if (row?.quoteThumb?.isNotEmpty() == true) 32f * d else 0f) + 5f * d
  /** MessageRow.tsx: under an own message that was refused, «Не отправлено · повторить» (11 semibold, danger), 8 above
   *  and below. */
  private val failedPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d; typeface = Theme.weight(600) }
  private fun failedRoom(item: MsgRow): Float = if (item.mine && item.ticks == 4) 16f * d + (failedPaint.descent() - failedPaint.ascent()) else 0f

  /** The words of a quote stand this far in: the bar 3 + 7, and with the picture 32 + 7 more (MessageRow.tsx). */
  private fun quoteIndent(item: MsgRow): Float = if (item.quoteThumb.isEmpty()) 10f * d else (10f + 32f + 7f) * d

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
    } else if (item.kind == 1 && item.label == "day") {
      // MessageRow.tsx DayChip: padding 6/14 and a 1-point border around 10-point semibold words.
      bubbleW = Math.ceil(dayPaint.measureText(item.text).toDouble()).toFloat() + 30f * d
      bubbleH = Math.ceil((dayPaint.descent() - dayPaint.ascent()).toDouble()).toFloat() + 14f * d
    } else if (item.kind == 1 && item.label.startsWith("call")) {
      // MessageRow.tsx CallServiceRow: up to 360 wide; border 1, padding 8 / 14 / 7, the 34-point circle, 10 between.
      val words = maxOf(callPaint.measureText(item.text), callTimePaint.measureText(item.time))
      val room = minOf(360f * d, width - 2 * edge) - (2f + 8f + 34f + 10f + 14f) * d
      val textW = minOf(room, words)
      val textH = (callPaint.descent() - callPaint.ascent()) + 1f * d + (callTimePaint.descent() - callTimePaint.ascent())
      bubbleW = (2f + 8f + 34f + 10f) * d + textW + 14f * d
      bubbleH = (2f + 14f) * d + maxOf(34f * d, textH)
    } else if (item.kind == 1) {
      noticeLayout = layout(item.text, small, (width * 0.8f).toInt(), 6, true)
      bubbleW = widest(noticeLayout) + 24f * d; bubbleH = (noticeLayout?.height ?: 0) + 12f * d
    } else {
      // MessageRow.tsx: at most 85 % of the row (the list's side margins taken off), less the plate's padding.
      val pad = pads(item)
      // MessageRow.tsx `flush`: the card is the picture's width + 4, the words 9 in from the picture's edges.
      val isFlush = flush(item)
      val albumInner = ((width - 2 * edge) * 0.85f - pad.first - pad.second).toInt()
      val flushWidth = if (!isFlush) 0f else item.album?.let { com.linea.messenger.attachments.MsgAlbumLayout.make(it, width.toFloat(), albumInner.toFloat(), d).width }
        ?: com.linea.messenger.attachments.InlineMediaArt.photoSize(item, width.toFloat(), d).first
      val inner = if (isFlush) maxOf(40f * d, flushWidth - 18f * d).toInt() else albumInner
      timeCorner = false; timeBeside = false; timeX = 0f; timeBase = 0f
      // Composer: 1–3 emoji alone stand large, each in its box (the reference's 112 / 84 / 68).
      if (item.bigEmoji > 0) { bigGlyphs = com.linea.messenger.composer.BigEmoji.graphemes(item.text).take(3); bigBox = com.linea.messenger.composer.BigEmoji.box(bigGlyphs.size) * d }
      if (item.text.isNotEmpty() && bigGlyphs.isEmpty()) textLayout = bodyLayout(withTrailing(styled(item), item), inner)
      if (item.quoteText.isNotEmpty() || item.quoteAuthor.isNotEmpty()) quoteLayout = StaticLayout.Builder.obtain(item.quoteText, 0, item.quoteText.length, quotePaint, (inner - quoteIndent(item) - 8f * d).toInt().coerceAtLeast(1))
        .setMaxLines(2).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).build()
      if (item.label.isNotEmpty() && item.media != "photo" && item.media != "file") labelLayout = layout(item.label, small, inner, 2) // Attachments: a file's card draws its own words
      // MessageRow.tsx `reactionsInside`: the chips and, 10 to their right, the time share one row.
      val metaRoom = meta.measureText(item.time) + (if (item.mine) 19f * d else 0f) + (if (item.silent) 15f * d else 0f)
      timeBeside = item.chips.isNotEmpty() && item.media != "note" && item.bigEmoji == 0
      layoutChips(item, if (timeBeside) maxOf(40f * d, inner - 10f * d - metaRoom) else inner.toFloat())
      if (item.reactions.isNotEmpty() && chips.isEmpty()) reactLayout = layout(item.reactions, small, inner, 2)
      if (thumb != null) { thumbW = minOf(inner.toFloat(), 220f * d); thumbH = (thumbW / item.thumbWide.toFloat()).coerceIn(90f * d, 300f * d) }
      // Voice/Video: a round video is a circle, a video keeps its place even before its picture is known, a voice
      // message is a block of its own.
      if (item.media == "note") {
        thumbW = minOf(inner.toFloat(), MediaRowArt.noteSide * d)
        // Videonote: a circle listened to grows to min(404, the row) (VideoNote.tsx `noteSizes`).
        if (item.key == msgExpandedNote) thumbW = maxOf(thumbW, minOf(404f * d, Math.floor((width - 18f * d).toDouble()).toFloat()))
        thumbH = thumbW
      }
      // MediaBubble.tsx `mediaBox` / `captionedMediaBox`: a video takes a photo's place.
      else if (item.media == "video") com.linea.messenger.attachments.InlineMediaArt.photoSize(item, width.toFloat(), d).let { thumbW = it.first; thumbH = it.second }
      else if (item.media == "voice") { voiceW = minOf(inner.toFloat(), MediaRowArt.voiceWidth * d); voiceH = MediaRowArt.voiceHeight * d }
      // Attachments: a photo shown whole, a file as a card (MediaBubble.tsx; attachments/InlineMedia.kt).
      else if (item.media == "photo") com.linea.messenger.attachments.InlineMediaArt.photoSize(item, width.toFloat(), d).let { thumbW = it.first; thumbH = it.second }
      else if (item.media == "file") com.linea.messenger.attachments.InlineMediaArt.fileSize(item, inner.toFloat(), d).let { fileW = it.first; fileH = it.second }
      val metaWidth = meta.measureText(item.time) + (if (item.mine) 19f * d else 0f) + (if (item.silent) 15f * d else 0f) // the mark 4 + 15; Composer: the bell of «без звука»
      var w = maxOf(maxOf(widest(textLayout), metaWidth, thumbW, widest(labelLayout)), maxOf(widest(reactLayout), chipsW, voiceW))
      if (timeBeside) w = maxOf(w, minOf(inner.toFloat(), chipsW + 10f * d + metaRoom))
      w = maxOf(w, fileW) // Attachments
      if (quoteLayout != null) w = maxOf(w, minOf(inner.toFloat(), maxOf(widest(quoteLayout), quoteAuthorPaint.measureText(item.quoteAuthor)) + quoteIndent(item) + 8f * d))
      if (item.forward.isNotEmpty()) w = maxOf(w, minOf(inner.toFloat(), forwardPaint.measureText(item.forward) + 2f * d))
      // LinkPreview: the card stands under the text, and the time then goes under the card.
      item.linkCard?.let { link -> card = com.linea.messenger.linkpreview.MsgLinkCardLayout.make(link, inner.toFloat(), d).also { w = maxOf(w, it.width) } }
      // Polls: the poll stands where the text would (a poll's text is only for clients without polls).
      item.poll?.let { poll -> pollLayout = com.linea.messenger.polls.MsgPollLayout.make(poll, inner.toFloat(), d).also { w = maxOf(w, it.width) } }
      if (bigGlyphs.isNotEmpty()) w = maxOf(w, bigBox * bigGlyphs.size)
      // Media: an album's mosaic stands above its caption.
      item.album?.let { album -> albumLayout = com.linea.messenger.attachments.MsgAlbumLayout.make(album, width.toFloat(), albumInner.toFloat(), d).also { w = maxOf(w, it.width) } }
      // MessageRow.tsx `inlineTime`: the time's room is the invisible run at the end of the words (withTrailing).
      val text = textLayout
      if (text != null && text.lineCount > 0 && inlineTime(item)) {
        w = maxOf(w, widest(text))
        if (plainTime(item)) {
          // The open look: the time stands where its run was laid out, on that line's baseline.
          val start = item.text.length + 2
          val line = text.getLineForOffset(start)
          timeInline = true; timeX = text.getPrimaryHorizontal(start); timeBase = text.getLineBaseline(line).toFloat()
        } else timeCorner = true // bubbles (and the open look with a rare mark): the lower corner, 10 / 6
      }
      // Attachments: a photo without words is the picture alone (MessageRow.tsx `bare`).
      // MessageRow.tsx `bare`: a video without words is the picture alone as well.
      if ((item.media == "photo" || item.media == "video") && item.text.isEmpty() && item.quoteText.isEmpty() && item.quoteAuthor.isEmpty() && item.forward.isEmpty() && reactLayout == null && chips.isEmpty()) {
        photoBare = true; bubbleW = thumbW; bubbleH = thumbH
        builtFor = item; builtWidth = width; builtFont = fontSize
        return
      }
      // MessageRow.tsx: 6 above the content; the forward line 4 above what follows; the quote's block 6 above it.
      // `flush`: 2 above; the forward line 7 more, the quote 8 more, 7 under the picture.
      var h = (if (isFlush) 2f else 6f) * d
      if (item.forward.isNotEmpty()) h += Math.ceil((forwardPaint.descent() - forwardPaint.ascent()).toDouble()).toFloat() + 4f * d + (if (isFlush) 7f * d else 0f)
      if (quoteLayout != null) h += quoteHeight(quoteLayout!!) + 6f * d + (if (isFlush) 8f * d else 0f)
      if (thumbH > 0f) h += thumbH + (if (isFlush) 7f else 6f) * d
      albumLayout?.let { h += it.height + (if (isFlush) 7f else 6f) * d } // Media
      if (voiceH > 0f) h += voiceH + 4f * d
      if (labelLayout != null) h += labelLayout!!.height + 4f * d
      if (fileH > 0f) h += fileH + 4f * d // Attachments
      pollLayout?.let { h += it.height + 4f * d } // Polls
      if (bigGlyphs.isNotEmpty()) h += bigBox // Composer
      if (textLayout != null) h += textLayout!!.height
      card?.let { h += it.height + 7f * d }
      if (reactLayout != null) h += reactLayout!!.height + 6f * d
      if (chipsH > 0f) h += chipsH + 6f * d
      // Below: 6 under words that carry the time or beside the chips (5 + the time's 1), else the time's own row
      // (4 above it, 5 below).
      h += if (timeInline || timeCorner || timeBeside) 6f * d else 4f * d + Math.ceil((meta.descent() - meta.ascent()).toDouble()).toFloat() + 5f * d
      bubbleW = if (isFlush) flushWidth + 4f * d else maxOf(if (MSG_OPEN_LOOK) 0f else 60f * d, w + pad.first + pad.second); bubbleH = h
    }
    builtFor = item; builtWidth = width; builtFont = fontSize
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    val item = row
    if (item == null) { setMeasuredDimension(width, 0); return }
    if (builtFor != item || builtWidth != width || builtFont != fontSize) build(item, width)
    // MessageRow.tsx: the day chip 15 above and 18 below, a call's row 6 below, a message 6 after a run and 2 inside one.
    val gap = if (item.kind == 2) 20f * d else if (item.kind == 1 && item.label == "day") 33f * d else if (item.kind == 1 && item.label.startsWith("call")) 6f * d
      else if (item.kind == 1) 8f * d else (if (item.tail) 6f * d else 2f * d) + failedRoom(item)
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
    if (item.kind == 1 && item.label == "day") {
      val look = com.linea.messenger.settings.ThemeStore.look
      val left = (w - bubbleW) / 2; val top = 15f * d
      fill.color = if (look.black) 0xAD000000.toInt() else if (look.dark) 0xAD1E2435.toInt() else 0x85FFFFFF.toInt()
      canvas.drawRoundRect(left, top, left + bubbleW, top + bubbleH, 14f * d, 14f * d, fill)
      stroke.color = if (look.dark) 0x14FFFFFF else 0xE0FFFFFF.toInt(); stroke.strokeWidth = 1f * d
      canvas.drawRoundRect(left + 0.5f * d, top + 0.5f * d, left + bubbleW - 0.5f * d, top + bubbleH - 0.5f * d, 13.5f * d, 13.5f * d, stroke)
      dayPaint.color = palette.muted
      canvas.drawText(item.text, left + 15f * d, top + 7f * d - dayPaint.ascent(), dayPaint)
      return
    }
    if (item.kind == 1 && item.label.startsWith("call")) {
      val look = com.linea.messenger.settings.ThemeStore.look
      val red = item.label.contains("!")
      val left = (w - bubbleW) / 2
      fill.color = if (item.checked == 1) look.accentSoft else if (isPressed) (if (look.dark) 0x1AFFFFFF else 0xC7FFFFFF.toInt())
        else if (look.dark) 0x990C0F18.toInt() else 0x9EFFFFFF.toInt()
      canvas.drawRoundRect(left, 0f, left + bubbleW, bubbleH, 20f * d, 20f * d, fill)
      stroke.color = if (look.dark) 0x14FFFFFF else 0xE0FFFFFF.toInt(); stroke.strokeWidth = 1f * d
      canvas.drawRoundRect(left + 0.5f * d, 0.5f * d, left + bubbleW - 0.5f * d, bubbleH - 0.5f * d, 19.5f * d, 19.5f * d, stroke)
      val cx = left + (1f + 8f + 17f) * d; val cy = bubbleH / 2
      fill.color = if (red) look.dangerBg else look.accentSoft
      canvas.drawCircle(cx, cy, 17f * d, fill)
      com.linea.messenger.design.IonIcon.draw(canvas, if (item.label.contains("v")) "videocam" else "call", cx, cy, 17f * d, if (red) palette.danger else palette.accent)
      val tx = cx + 17f * d + 10f * d
      val wordsH = callPaint.descent() - callPaint.ascent(); val timeH = callTimePaint.descent() - callTimePaint.ascent()
      val ty = cy - (wordsH + 1f * d + timeH) / 2
      callPaint.color = if (red) palette.danger else palette.text
      val shown = TextUtils.ellipsize(item.text, callPaint, left + bubbleW - 14f * d - tx, TextUtils.TruncateAt.END)
      canvas.drawText(shown, 0, shown.length, tx, ty - callPaint.ascent(), callPaint)
      callTimePaint.color = palette.muted
      canvas.drawText(item.time, tx, ty + wordsH + 1f * d - callTimePaint.ascent(), callTimePaint)
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
    // MessageRow.tsx JumpFlash: accentSoft over the row, 9 past the list's margins, 2 higher.
    if (flashLight > 0f) {
      fill.color = alpha(com.linea.messenger.settings.ThemeStore.look.accentSoft, Math.round(((com.linea.messenger.settings.ThemeStore.look.accentSoft ushr 24) and 255) * flashLight))
      canvas.drawRect(edge - 9f * d, -2f * d, w - edge + 9f * d, height - 2f * d, fill)
    }
    if (item.checked >= 0) {
      // MessageRow.tsx: a chosen message lies on accentSoft (radius 14, 6 past the margins); the mark is
      // <Icon name="checkmark-circle"|"ellipse-outline" size={24}> at the left of a 30-point column.
      if (item.checked == 1) {
        fill.color = com.linea.messenger.settings.ThemeStore.look.accentSoft
        canvas.drawRoundRect(edge - 6f * d, 0f, w - edge + 6f * d, height.toFloat(), 14f * d, 14f * d, fill)
      }
      com.linea.messenger.design.IonIcon.draw(canvas, if (item.checked == 1) "checkmark-circle" else "ellipse-outline", edge + 12f * d, height / 2f, 24f * d, if (item.checked == 1) palette.accent else palette.subtle)
      if (!item.mine) side += 30f * d
    }
    val left = if (item.mine) w - edge - bubbleW else side
    fill.color = if (item.mine) palette.mine else palette.theirs
    // ChatLook: «Углы сообщений» (8, 14, 20), the corner by the sender's edge 6 at most on the last bubble of a run
    // (chatlook/BubbleLook.kt).
    plateBox.set(left, 0f, left + bubbleW, bubbleH)
    // Attachments: a photo alone — the picture with the time in its corner, no plate and no line.
    if (photoBare) {
      if (item.media == "video") {
        // MediaBubble.tsx `MediaTile` alone (radius 15): the poster, the play round, the label, the time in its corner.
        mediaBoxes.clear()
        mediaPicture.set(left, 0f, left + bubbleW, bubbleH)
        mediaBoxes.thumb.set(mediaPicture)
        com.linea.messenger.attachments.InlineMediaArt.drawVideo(canvas, item, left, 0f, bubbleW, bubbleH, palette, thumb, 15f * d, d)
        MediaRowArt.marks(canvas, item, mediaState, palette, mediaPicture, d)
        com.linea.messenger.attachments.InlineMediaArt.timePill(canvas, item, left + bubbleW, bubbleH, palette, d)
      } else com.linea.messenger.attachments.InlineMediaArt.drawPhoto(canvas, item, left, 0f, bubbleW, bubbleH, palette, thumb, 15f * d, true, d)
      if (isPressed || flash) { fill.color = Theme.veil(if (isPressed) 0.08f else 0.14f); canvas.drawRoundRect(left, 0f, left + bubbleW, bubbleH, 15f * d, 15f * d, fill) }
      return
    }
    com.linea.messenger.chatlook.ChatBubbleLook.shape(path, plateBox, item.mine, item.tail, d)
    // Attachments: a photo with words keeps its card in the open look too.
    if (!MSG_OPEN_LOOK || item.media == "photo" || flush(item)) canvas.drawPath(path, fill)
    // ChatLook: the open look — the other side's words carry a thin line in their colour.
    if (MSG_OPEN_LOOK && !item.mine && item.media != "photo" && !flush(item) && (item.text.isNotEmpty() || item.label.isNotEmpty())) {
      val line = com.linea.messenger.chatlook.ChatBubbleLook.peerLine
      fill.color = if (line != 0) line else palette.accent
      canvas.drawRect(left, 0f, left + 2f * d, bubbleH, fill) // `borderLeftWidth: 2`, the whole height
    }
    // MessageRow.tsx: a message has no pressed look (a tap opens its menu); the jump's light is drawn above.

    val pad = pads(item)
    val x = left + pad.first
    // MessageRow.tsx `flush`: 2 around the picture; the forward line 12 in and 7 lower, the quote 8 in and 8 lower.
    val isFlush = flush(item)
    var y = (if (isFlush) 2f else 6f) * d
    val metaColor = if (item.mine) palette.mineMeta else palette.muted
    val markColor = if (item.mine) palette.mineMark else palette.accent
    val inner = bubbleW - pad.first - pad.second
    if (item.forward.isNotEmpty()) {
      // MessageRow.tsx: 11 semibold in the accent, 4 above what follows.
      forwardPaint.color = palette.accent
      if (isFlush) y += 7f * d
      val shown = TextUtils.ellipsize(item.forward, forwardPaint, if (isFlush) bubbleW - 28f * d else inner - 2f * d, TextUtils.TruncateAt.END)
      canvas.drawText(shown, 0, shown.length, if (isFlush) left + 14f * d else x + 1f * d, y - forwardPaint.ascent(), forwardPaint)
      y += Math.ceil((forwardPaint.descent() - forwardPaint.ascent()).toDouble()).toFloat() + 4f * d
    }
    quoteLayout?.let { quote ->
      // MessageRow.tsx: white 0.06 / black 0.04, radius 10, the 3-point bar, 7 to the words, 5 above and below.
      if (isFlush) y += 8f * d
      val x = if (isFlush) left + 10f * d else x
      val inner = if (isFlush) bubbleW - 20f * d else inner
      val height = quoteHeight(quote)
      quoteLeft = x; quoteTop = y; quoteRight = x + inner; quoteBottom = y + height
      fill.color = if (Theme.dark) 0x0FFFFFFF else 0x0A000000
      canvas.drawRoundRect(x, y, x + inner, y + height, 10f * d, 10f * d, fill)
      canvas.save()
      path.reset(); path.addRoundRect(x, y, x + inner, y + height, 10f * d, 10f * d, Path.Direction.CW); canvas.clipPath(path)
      fill.color = markColor; canvas.drawRoundRect(x, y, x + 3f * d, y + height, 2f * d, 2f * d, fill)
      canvas.restore()
      // MessageRow.tsx replyThumb: 32 × 32 after the bar, centred, radius 5 (16 for a round video), on
      // rgba(120,130,160,0.18) until it shows.
      if (item.quoteThumb.isNotEmpty()) {
        val tx = x + 10f * d; val ty = y + (height - 32f * d) / 2; val corner = if (item.quoteRound) 16f * d else 5f * d
        fill.color = 0x2E7882A0
        canvas.drawRoundRect(tx, ty, tx + 32f * d, ty + 32f * d, corner, corner, fill)
        quotePicture?.let { drawPicture(canvas, it, tx, ty, 32f * d, 32f * d, corner) }
      }
      val wordsX = x + quoteIndent(item)
      quoteAuthorPaint.color = markColor
      val author = TextUtils.ellipsize(item.quoteAuthor, quoteAuthorPaint, inner - quoteIndent(item) - 8f * d, TextUtils.TruncateAt.END)
      canvas.drawText(author, 0, author.length, wordsX, y + 5f * d - quoteAuthorPaint.ascent(), quoteAuthorPaint)
      quotePaint.color = metaColor
      canvas.save(); canvas.translate(wordsX, y + 5f * d + Math.ceil((quoteAuthorPaint.descent() - quoteAuthorPaint.ascent()).toDouble()).toFloat() + 1f * d); quote.draw(canvas); canvas.restore()
      y += height + 6f * d
    }
    val image = thumb
    // Voice/Video: where the picture of a video or a round video stands; without a picture, a quiet plate.
    mediaBoxes.clear()
    // MessageRow.tsx `flush`: the picture 2 in from the card's edges, its corners max(4, the card's − 3), 7 above the words.
    val pictureX = if (isFlush) left + 2f * d else x
    val pictureRadius = if (isFlush) maxOf(4f, com.linea.messenger.chatlook.ChatBubbleLook.radius - 3f) * d else 12f * d
    val pictureGap = (if (isFlush) 7f else 6f) * d
    if (thumbH > 0f && (item.media == "video" || item.media == "note")) {
      mediaPicture.set(pictureX, y, pictureX + thumbW, y + thumbH)
      mediaBoxes.thumb.set(mediaPicture)
      if (image == null) { MediaRowArt.plate(canvas, item.media == "note", palette, mediaPicture, d); y += thumbH + pictureGap }
    }
    // Attachments: a photo with words, shown whole above them.
    if (item.media == "photo" && thumbH > 0f) { com.linea.messenger.attachments.InlineMediaArt.drawPhoto(canvas, item, pictureX, y, thumbW, thumbH, palette, image, pictureRadius, false, d); y += thumbH + pictureGap }
    if (image != null && item.media != "photo" && thumbH > 0f) { drawPicture(canvas, image, pictureX, y, thumbW, thumbH, if (item.thumbRound) minOf(thumbW, thumbH) / 2 else pictureRadius); y += thumbH + pictureGap }
    // Voice/Video: the play mark and the length over the picture; the waveform row of a voice message.
    if (!mediaBoxes.thumb.isEmpty) MediaRowArt.marks(canvas, item, mediaState, palette, mediaPicture, d, hosted = com.linea.messenger.video.NotePlayback.hostedKeys.contains(item.key))
    // Media: the album's mosaic.
    albumLayout?.let { albumX = pictureX; albumY = y; it.draw(canvas, item.album ?: return@let, albumPictures, pictureX, y, palette); y += it.height + pictureGap }
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
      // MessageRow.tsx: mine in the accent, else white 0.10 on dark / black 0.06 on light.
      // Under a round video or big emoji (reactions outside a bubble): white 0.07 on dark / white 0.7 on light, a border.
      val outside = item.media == "note" || item.bigEmoji > 0
      fill.color = if (chip.mine) palette.accent else if (outside) (if (Theme.dark) 0x12FFFFFF else 0xB3FFFFFF.toInt()) else if (Theme.dark) 0x1AFFFFFF else 0x0F000000
      val chipH = if (outside) 26f * d else 24f * d
      canvas.drawRoundRect(cx, cy, cx + chip.w, cy + chipH, chipH / 2, chipH / 2, fill)
      if (outside) { stroke.color = com.linea.messenger.settings.ThemeStore.look.border; stroke.strokeWidth = 1f * d; canvas.drawRoundRect(cx + 0.5f * d, cy + 0.5f * d, cx + chip.w - 0.5f * d, cy + chipH - 0.5f * d, chipH / 2 - 0.5f * d, chipH / 2 - 0.5f * d, stroke) }
      val pad = if (outside) 1f * d else 0f
      chipEmoji.color = palette.text
      canvas.drawText(chip.emoji, cx + 8f * d + pad, cy + chipH / 2 - (chipEmoji.ascent() + chipEmoji.descent()) / 2, chipEmoji)
      if (chip.count > 1) {
        chipCount.color = if (chip.mine) palette.onAccent else palette.text
        canvas.drawText(chip.count.toString(), cx + 8f * d + pad + chipEmoji.measureText(chip.emoji) + 4f * d, cy + chipH / 2 - (chipCount.ascent() + chipCount.descent()) / 2, chipCount)
      }
    }

    meta.color = metaColor // the time keeps its colour; a failed message's red is its mark
    val inlineNow = timeInline && textLayout != null
    // The mark: 4 after the time in a row of marks; after a «\u00A0» when it follows the words.
    val marks = if (!item.mine) 0f else if (inlineNow) meta.measureText("\u00A0") + 15f * d else 19f * d
    // MessageRow.tsx: after the last word (the open look), in a bubble's corner 10 from the right and 6 from the
    // bottom, beside the chips, or on a row of its own at the right (5 above the plate's bottom).
    val inline = timeInline && textLayout != null
    val corner = timeCorner && textLayout != null
    val under = left + bubbleW - (if (corner) 10f * d else if (flush(item)) 2f * d else if (MSG_OPEN_LOOK && item.media != "photo") pad.second - 1f * d else 11f * d)
    val right = if (inline) x + timeX + meta.measureText(item.time) + marks + (if (item.silent) 15f * d else 0f) else under // Composer: room for the bell
    val base = if (inline) textTop + timeBase else bubbleH - (if (corner || timeBeside) 6f * d else 5f * d) - meta.descent()
    canvas.drawText(item.time, right - marks - meta.measureText(item.time), base, meta)
    val middle = base + (meta.ascent() + meta.descent()) / 2
    if (item.mine && item.ticks == 4) {
      // MessageRow.tsx: a refused message — a 1-point danger border on its plate, and «Не отправлено · повторить» under it
      // (a touch on the row sends it again).
      if (!MSG_OPEN_LOOK || item.media == "photo" || flush(item)) { com.linea.messenger.chatlook.ChatBubbleLook.shape(path, plateBox, item.mine, item.tail, d); stroke.color = palette.danger; stroke.strokeWidth = 1f * d; canvas.drawPath(path, stroke) }
      failedPaint.color = palette.danger
      val words = "Не отправлено · повторить"
      canvas.drawText(words, w - edge - failedPaint.measureText(words), bubbleH + 8f * d - failedPaint.ascent(), failedPaint)
    }
    // Composer: «без звука» — <Icon name="notifications-off" size={11} color={t.subtle}> before the time, 4 apart.
    if (item.silent) com.linea.messenger.design.IonIcon.draw(canvas, "notifications-off", right - marks - meta.measureText(item.time) - 4f * d - 5.5f * d, middle, 11f * d, palette.subtle)
    // After the time, 4 apart: <Icon name="checkmark"|"checkmark-done" size={15}> (read in the accent); on its way
    // <Icon name="time-outline" size={12}>; failed <Icon name="alert-circle" size={13} color={t.danger}>.
    if (item.mine && item.ticks in 1..2) {
      com.linea.messenger.design.IonIcon.draw(canvas, if (item.ticks == 2) "checkmark-done" else "checkmark", right - 7.5f * d, middle, 15f * d, if (item.ticks == 2) markColor else metaColor)
    } else if (item.mine && item.ticks >= 3) {
      val failed = item.ticks == 4
      com.linea.messenger.design.IonIcon.draw(canvas, if (failed) "alert-circle" else "time-outline", right - 7.5f * d, middle, if (failed) 13f * d else 12f * d, if (failed) palette.danger else metaColor)
    }
  }
}

/** Videonote: the row whose round video is being listened to (its slot is large); empty: none. Main thread. */
var msgExpandedNote = ""
