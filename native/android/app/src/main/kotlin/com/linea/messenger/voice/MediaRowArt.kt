package com.linea.messenger.voice

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.chat.MsgPalette
import com.linea.messenger.chat.MsgRow
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.Theme
import com.linea.messenger.settings.ThemeStore
import com.linea.messenger.video.NotePlayback

/** What is playing in one row of the chat right now. The list keeps one of these and draws only that row again
 *  when it changes (`MsgListView.setMediaState`), so a playing voice message does not redraw the whole chat. */
data class MsgMediaState(
  /** The key of the row. */
  val key: String = "",
  val playing: Boolean = false,
  /** The file is still being brought. */
  val loading: Boolean = false,
  /** How much has been played, 0…1. */
  val progress: Float = 0f,
  /** «0:07 / 0:23», or how much has arrived while loading; empty: the row's own length is shown. */
  val time: String = "",
  /** «1,5×» while a voice message is the active one; empty: no speed chip. */
  val rate: String = "",
  /** A round video playing in place: its picture is the player's, so no play mark is drawn over it. */
  val inPlace: Boolean = false,
)

/** Where the parts of a media row were drawn last (px in the row's view), for taps. An empty box: no such part. */
class MsgMediaBoxes {
  val thumb = RectF()
  val play = RectF()
  val wave = RectF()
  val rate = RectF()

  fun clear() { thumb.setEmpty(); play.setEmpty(); wave.setEmpty(); rate.setEmpty() }

  private fun inside(box: RectF, x: Float, y: Float, dx: Float, dy: Float) = x >= box.left - dx && x <= box.right + dx && y >= box.top - dy && y <= box.bottom + dy

  /** The part under a point: "rate", "wave" (with the place on it), "play" or "thumb". `d`: px in a dp. */
  fun part(x: Float, y: Float, d: Float): Pair<String, Float>? {
    if (!rate.isEmpty && inside(rate, x, y, 10f * d, 10f * d)) return Pair("rate", 0f)
    if (!wave.isEmpty && inside(wave, x, y, 0f, 8f * d)) return Pair("wave", ((x - wave.left) / maxOf(1f, wave.width())).coerceIn(0f, 1f))
    if (!play.isEmpty && inside(play, x, y, 6f * d, 6f * d)) return Pair("play", 0f)
    if (!thumb.isEmpty && inside(thumb, x, y, 0f, 0f)) return Pair("thumb", 0f)
    return null
  }
}

/** The bars of voice messages' waveforms, as the rows draw them. Main thread only (the cache is shared). */
object WaveBars {
  private val barCache = HashMap<String, FloatArray>()

  /** The bars of a waveform fitted into `count` bars (the core decodes and fits them, as the reference does). */
  fun bars(wave: String, count: Int): FloatArray {
    val cacheKey = "$wave/$count"
    barCache[cacheKey]?.let { return it }
    val numbers = FileCore.call("waveformBars", listOf(wave.ifEmpty { null }, count)) as? List<*>
    var made = numbers?.mapNotNull { (it as? Number)?.toFloat() }?.toFloatArray() ?: FloatArray(0)
    if (made.isEmpty()) made = FloatArray(count.coerceIn(12, 48)) { 0.12f }
    if (barCache.size > 300) barCache.clear()
    barCache[cacheKey] = made
    return made
  }
}

/** The drawing of voice messages, videos and round videos inside a row of the chat (`MsgRowView` calls it).
 *  Reference: mobile/src/voice/VoiceMessage.tsx (`VoiceBubbleView`: a 44 dp button, bars 2.5 dp wide every
 *  4.5 dp in a strip 30 dp tall, the played part in full light, the time under it, the speed while it plays),
 *  mobile/src/media/MediaBubble.tsx and mobile/src/videonote/VideoNote.tsx (the play mark, the length in a pill).
 *  Main thread only (the paints and the cache are shared). */
object MediaRowArt {
  private const val barWidth = 2.5f
  private const val barStep = 4.5f
  private const val waveHeight = 30f
  /** VoiceMessage.tsx `VoiceBubbleView`: 262 dp wide, 4 above and below; the right column is the 30 dp wave,
   *  3 dp, then a 16 dp line with the time (and the speed while it is the active one): 49 dp. */
  const val voiceWidth = 262f
  const val voiceHeight = 57f
  /** The side of a round video (dp). */
  const val noteSide = 212f

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
  private val timePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { fontFeatureSettings = "tnum"; letterSpacing = 0.03f }
  private val ratePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
  private val pillPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { fontFeatureSettings = "tnum" }
  private val path = Path()
  private val box = RectF()

  /** What the screen reader says about a media row. */
  fun spoken(row: MsgRow): String = when (row.media) {
    "voice" -> if (row.mediaTime.isEmpty()) "Голосовое сообщение" else "Голосовое сообщение, " + row.mediaTime
    "note" -> "Видеосообщение"
    "video" -> "Видео"
    else -> ""
  }

  private fun triangle(canvas: Canvas, cx: Float, cy: Float, size: Float, color: Int) {
    fill.color = color
    path.reset()
    path.moveTo(cx - size * 0.38f, cy - size * 0.5f)
    path.lineTo(cx + size * 0.55f, cy)
    path.lineTo(cx - size * 0.38f, cy + size * 0.5f)
    path.close()
    canvas.drawPath(path, fill)
  }

  private fun pauseMark(canvas: Canvas, cx: Float, cy: Float, size: Float, color: Int, d: Float) {
    fill.color = color
    val wide = size * 0.3f
    canvas.drawRoundRect(cx - size * 0.42f, cy - size * 0.5f, cx - size * 0.42f + wide, cy + size * 0.5f, 1.5f * d, 1.5f * d, fill)
    canvas.drawRoundRect(cx + size * 0.12f, cy - size * 0.5f, cx + size * 0.12f + wide, cy + size * 0.5f, 1.5f * d, 1.5f * d, fill)
  }

  /** An arc while a file is being brought. */
  private fun loadingArc(canvas: Canvas, cx: Float, cy: Float, radius: Float, color: Int, d: Float) {
    stroke.color = color
    stroke.strokeWidth = 2.2f * d
    canvas.drawArc(cx - radius, cy - radius, cx + radius, cy + radius, -90f, 252f, false, stroke)
  }

  /** The plate of a video or a round video whose small picture did not come with the message. A circle: the
   *  reference's placeholder — surface2 with the muted «videocam» glyph, 14 % of the circle (VideoNote.tsx). */
  fun plate(canvas: Canvas, round: Boolean, palette: MsgPalette, at: RectF, d: Float) {
    fill.color = if (round) ThemeStore.look.surface2 else palette.theirs
    val radius = if (round) minOf(at.width(), at.height()) / 2 else 12f * d
    canvas.drawRoundRect(at, radius, radius, fill)
    if (round) IonIcon.draw(canvas, "videocam", at.centerX(), at.centerY(), Math.round(minOf(at.width(), at.height()) / d * 0.14f) * d, Theme.muted)
  }

  /** MediaBubble.tsx `ProgressRing`: a 3 dp ring on a 25 % white track, from 12 o'clock, at least 3 %. */
  private fun progressRing(canvas: Canvas, cx: Float, cy: Float, size: Float, progress: Float, d: Float) {
    val radius = (size - 3f * d) / 2
    stroke.strokeWidth = 3f * d
    stroke.color = 0x40FFFFFF
    canvas.drawCircle(cx, cy, radius, stroke)
    stroke.color = 0xFFFFFFFF.toInt()
    canvas.drawArc(cx - radius, cy - radius, cx + radius, cy + radius, -90f, 360f * progress.coerceIn(0.03f, 1f), false, stroke)
  }

  /** A round video at rest (VideoNote.tsx `VideoNoteBubble`): no play mark over a circle that is there; one not
   *  brought yet carries the 44 dp download mark (while it comes: its progress ring and a cross); at the lower
   *  left of its square the length in a pill, with the speaker-off mark once the circle is brought. */
  fun noteMarks(canvas: Canvas, key: String, length: String, state: MsgMediaState?, at: RectF, d: Float) {
    val cx = at.centerX(); val cy = at.centerY()
    val live = state?.takeIf { it.key == key }
    val ready = NotePlayback.readyKeys.contains(key)
    if (live?.loading == true) {
      fill.color = 0x8C0A1423.toInt()
      canvas.drawCircle(cx, cy, 22f * d, fill)
      progressRing(canvas, cx, cy, 44f * d, live.progress, d)
      IonIcon.draw(canvas, "close", cx, cy, 20f * d, 0xFFFFFFFF.toInt())
    } else if (!ready) {
      fill.color = 0x8C0A1423.toInt()
      canvas.drawCircle(cx, cy, 22f * d, fill)
      IonIcon.draw(canvas, "arrow-down", cx, cy, 22f * d, 0xFFFFFFFF.toInt())
    }
    val words = length.ifEmpty { "0:00" }
    pillPaint.textSize = 11f * d
    pillPaint.color = 0xFFFFFFFF.toInt()
    pillPaint.fontFeatureSettings = null
    val wide = Math.ceil(pillPaint.measureText(words).toDouble()).toFloat()
    val tall = Math.ceil((pillPaint.descent() - pillPaint.ascent()).toDouble()).toFloat() + 4f * d
    box.set(at.left + 6f * d, at.bottom - 6f * d - tall, at.left + 6f * d + 7f * d + wide + (if (ready) 15f * d else 0f) + 7f * d, at.bottom - 6f * d)
    fill.color = 0x6B000000
    canvas.drawRoundRect(box, 9f * d, 9f * d, fill)
    canvas.drawText(words, box.left + 7f * d, box.centerY() - (pillPaint.ascent() + pillPaint.descent()) / 2, pillPaint)
    if (ready) IonIcon.draw(canvas, "volume-mute", box.left + 7f * d + wide + 4f * d + 5.5f * d, box.centerY(), 11f * d, 0xFFFFFFFF.toInt())
    pillPaint.fontFeatureSettings = "tnum"
  }

  /** Over the picture of a video or a round video: the play mark in the middle and the length in a pill at the
   *  lower left; for a round video listened to in place, the ring of its progress. */
  fun marks(canvas: Canvas, row: MsgRow, state: MsgMediaState?, palette: MsgPalette, at: RectF, d: Float, hosted: Boolean = false) {
    // A round video: the reference's resting look; while its player stands over it, the player draws it all.
    if (row.media == "note") {
      if (!hosted) noteMarks(canvas, row.key, row.mediaTime, state, at, d)
      return
    }
    // MediaBubble.tsx `MediaTile` (a video): the 48 dp round of rgba(10,15,30,.55) with «play» 24 (while it is
    // brought: its ring and «close» 22), and «0:42 · 12 МБ» at the upper left (7 in, 6 × 3 inside, radius 8).
    val cx = at.centerX(); val cy = at.centerY()
    val live = state?.takeIf { it.key == row.key }
    fill.color = 0x8C0A0F1E.toInt()
    canvas.drawCircle(cx, cy, 24f * d, fill)
    if (live?.loading == true) {
      progressRing(canvas, cx, cy, 48f * d, live.progress, d)
      IonIcon.draw(canvas, "close", cx, cy, 22f * d, 0xFFFFFFFF.toInt())
    } else IonIcon.draw(canvas, "play", cx, cy, 24f * d, 0xFFFFFFFF.toInt())
    val words = live?.takeIf { it.loading }?.time?.takeIf { it.isNotEmpty() } ?: row.mediaTime
    if (words.isEmpty()) return
    pillPaint.textSize = 11f * d
    pillPaint.color = 0xFFFFFFFF.toInt()
    pillPaint.fontFeatureSettings = null
    val wide = Math.ceil(pillPaint.measureText(words).toDouble()).toFloat()
    val tall = Math.ceil((pillPaint.descent() - pillPaint.ascent()).toDouble()).toFloat() + 6f * d
    box.set(at.left + 7f * d, at.top + 7f * d, at.left + 7f * d + wide + 12f * d, at.top + 7f * d + tall)
    fill.color = 0x8C0A0F1E.toInt()
    canvas.drawRoundRect(box, 8f * d, 8f * d, fill)
    canvas.drawText(words, box.left + 6f * d, box.centerY() - (pillPaint.ascent() + pillPaint.descent()) / 2, pillPaint)
    pillPaint.fontFeatureSettings = "tnum"
  }

  private val monoPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.MONOSPACE; letterSpacing = 0.3f / 11f }

  /** A voice message (VoiceMessage.tsx `VoiceBubbleView`): the round button (the text colour, the page colour's
   *  play/pause glyph), the waveform with its played part in full light, the time under it (monospace) and the
   *  speed while it is the active one. Writes where the parts stand into `boxes`. */
  fun voice(canvas: Canvas, row: MsgRow, state: MsgMediaState?, palette: MsgPalette, left: Float, top: Float, width: Float, d: Float, boxes: MsgMediaBoxes) {
    val live = state?.takeIf { it.key == row.key }
    val columnLeft = left + 56f * d
    val columnTop = top + 4f * d
    val columnWidth = maxOf(20f * d, width - 56f * d)
    val buttonTop = columnTop + 49f * d / 2 - 22f * d
    boxes.play.set(left, buttonTop, left + 44f * d, buttonTop + 44f * d)
    fill.color = palette.text
    val mx = boxes.play.centerX(); val my = boxes.play.centerY()
    canvas.drawCircle(mx, my, 22f * d, fill)
    val page = ThemeStore.look.bg
    if (live?.loading == true) loadingArc(canvas, mx, my, 8f * d, page, d)
    else if (live?.playing == true) IonIcon.draw(canvas, "pause", mx, my, 20f * d, page)
    else IonIcon.draw(canvas, "play", mx + 1f * d, my, 20f * d, page)

    val stripLeft = columnLeft
    val stripWidth = columnWidth
    boxes.wave.set(stripLeft, columnTop, stripLeft + stripWidth, columnTop + waveHeight * d)
    val count = maxOf(12, (stripWidth / (barStep * d)).toInt())
    val values = WaveBars.bars(row.wave, count)
    val bar = barWidth * d
    val step = if (values.size > 1) (stripWidth - bar) / (values.size - 1) else 0f
    val middle = boxes.wave.centerY()
    path.reset()
    for ((index, value) in values.withIndex()) {
      val tall = maxOf(bar, value.coerceIn(0f, 1f) * (waveHeight - 2f) * d)
      val x = stripLeft + index * step
      path.addRoundRect(x, middle - tall / 2, x + bar, middle + tall / 2, bar / 2, bar / 2, Path.Direction.CW)
    }
    fill.color = (palette.text and 0x00FFFFFF) or (0x4D shl 24)
    canvas.drawPath(path, fill)
    val played = (live?.progress ?: 0f).coerceIn(0f, 1f)
    if (played > 0f) {
      canvas.save()
      canvas.clipRect(stripLeft, columnTop, stripLeft + stripWidth * played, columnTop + waveHeight * d)
      fill.color = palette.text
      canvas.drawPath(path, fill)
      canvas.restore()
    }

    val lineTop = boxes.wave.bottom + 3f * d
    val lineMiddle = lineTop + 8f * d
    val words = live?.time?.takeIf { it.isNotEmpty() } ?: row.mediaTime
    monoPaint.textSize = 11f * d
    monoPaint.color = palette.muted
    canvas.drawText(words, stripLeft, lineMiddle - (monoPaint.ascent() + monoPaint.descent()) / 2, monoPaint)
    val rate = live?.rate ?: ""
    if (rate.isNotEmpty()) {
      val fast = rate != "1×"
      ratePaint.textSize = 11f * d
      ratePaint.color = if (fast) page else palette.text
      val wide = Math.ceil(ratePaint.measureText(rate).toDouble()).toFloat()
      // paddingHorizontal 7, paddingVertical 1, a 1 dp border, radius 8.
      val chipHeight = Math.ceil((ratePaint.descent() - ratePaint.ascent()).toDouble()).toFloat() + 4f * d
      val chipWidth = wide + 16f * d
      boxes.rate.set(boxes.wave.right - chipWidth, lineMiddle - chipHeight / 2, boxes.wave.right, lineMiddle + chipHeight / 2)
      if (fast) {
        fill.color = palette.text
        canvas.drawRoundRect(boxes.rate, 8f * d, 8f * d, fill)
      }
      stroke.color = if (fast) palette.text else ThemeStore.look.border
      stroke.strokeWidth = 1f * d
      box.set(boxes.rate.left + 0.5f * d, boxes.rate.top + 0.5f * d, boxes.rate.right - 0.5f * d, boxes.rate.bottom - 0.5f * d)
      canvas.drawRoundRect(box, 7.5f * d, 7.5f * d, stroke)
      canvas.drawText(rate, boxes.rate.centerX() - ratePaint.measureText(rate) / 2, boxes.rate.centerY() - (ratePaint.ascent() + ratePaint.descent()) / 2, ratePaint)
    }
  }
}
