package com.linea.messenger.ai

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import com.linea.messenger.design.Icons
import com.linea.messenger.design.Symbols

/** The small pictures of «AI» and «Музыка» (where the iPhone app uses the system's symbols): lines in a box of
 *  24 units, as `Icons` and `Symbols` draw theirs — and what those two already have is drawn by them.
 *  Used on the main thread only. */
object AIIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val letters = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; isFakeBoldText = true; typeface = com.linea.messenger.design.Theme.weight(400) }
  private val path = Path()
  private val box = RectF()
  private val fromIcons = setOf("sparkles", "headphones")
  private val fromSymbols = setOf("lock", "trash", "refresh", "check", "info", "eye", "eye.slash", "check.circle")

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). An unknown name draws nothing. */
  /** The reference's own glyphs (Ionicons) for the names this app asks by (AIScreen.tsx, MusicScreen.tsx). */
  private val ion = mapOf(
    "menu" to "menu-outline", "compose" to "create-outline", "plus" to "add", "xmark" to "close", "arrow.up" to "arrow-up", "stop" to "stop",
    "chevron.down" to "chevron-down", "chevron.up" to "chevron-up", "copy" to "copy-outline", "play" to "play", "pause" to "pause", "play.rect" to "play",
    "share" to "share-outline", "mic" to "mic-outline", "doc" to "document-text-outline", "heart" to "heart-outline", "heart.fill" to "heart",
    "more" to "ellipsis-horizontal", "prev" to "play-skip-back", "next" to "play-skip-forward", "shuffle" to "shuffle", "sliders" to "options-outline",
    "photo" to "images-outline", "note" to "musical-note", "search" to "search-outline", "drop" to "water-outline", "bolt" to "flash-outline",
    "sun" to "sunny-outline", "moon" to "moon-outline", "speaker" to "volume-medium-outline", "link" to "open-outline", "download" to "download-outline",
    "lock" to "lock-closed", "trash" to "trash-outline", "refresh" to "refresh-outline", "check" to "checkmark", "info" to "information-outline",
    "eye" to "eye-outline", "eye.slash" to "eye-off-outline", "check.circle" to "checkmark-circle", "sparkles" to "sparkles-outline", "headphones" to "headset-outline", "repeat" to "repeat", "repeat.1" to "repeat",
  )

  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    if (name == "ion:chevron-back") return com.linea.messenger.design.Symbols.draw(canvas, name, cx, cy, size, color) // the reference's drawn chevron
    if (name.startsWith("ion:")) return com.linea.messenger.design.IonIcon.draw(canvas, name.substring(4), cx, cy, size, color)
    ion[name]?.let { return com.linea.messenger.design.IonIcon.draw(canvas, it, cx, cy, size, color) }
    if (name in fromIcons) return Icons.draw(canvas, name, cx, cy, size, color)
    if (name in fromSymbols) return Symbols.draw(canvas, name, cx, cy, size, color)
    stroke.color = color; fill.color = color; letters.color = color; stroke.strokeWidth = 1.8f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "menu" -> { for (y in floatArrayOf(7f, 12f, 17f)) canvas.drawLine(4.6f, y, 19.4f, y, stroke) }
      "compose" -> {
        // A sheet with a pencil across its corner.
        path.moveTo(11f, 4.6f); path.lineTo(6.6f, 4.6f); path.quadTo(4.4f, 4.6f, 4.4f, 6.8f); path.lineTo(4.4f, 17.4f); path.quadTo(4.4f, 19.6f, 6.6f, 19.6f)
        path.lineTo(17.2f, 19.6f); path.quadTo(19.4f, 19.6f, 19.4f, 17.4f); path.lineTo(19.4f, 13f)
        path.moveTo(18.2f, 3.4f); path.lineTo(20.6f, 5.8f); path.lineTo(12.4f, 14f); path.lineTo(9.6f, 14.4f); path.lineTo(10f, 11.6f); path.close()
        canvas.drawPath(path, stroke)
      }
      "plus" -> { stroke.strokeWidth = 2f; canvas.drawLine(12f, 5f, 12f, 19f, stroke); canvas.drawLine(5f, 12f, 19f, 12f, stroke) }
      "xmark" -> { stroke.strokeWidth = 2f; canvas.drawLine(6.4f, 6.4f, 17.6f, 17.6f, stroke); canvas.drawLine(17.6f, 6.4f, 6.4f, 17.6f, stroke) }
      "arrow.up" -> {
        stroke.strokeWidth = 2.2f
        path.moveTo(12f, 19f); path.lineTo(12f, 5.4f); path.moveTo(6.4f, 10.8f); path.lineTo(12f, 5.2f); path.lineTo(17.6f, 10.8f)
        canvas.drawPath(path, stroke)
      }
      "stop" -> canvas.drawRoundRect(6.4f, 6.4f, 17.6f, 17.6f, 2.2f, 2.2f, fill)
      "chevron.down" -> { stroke.strokeWidth = 2.2f; path.moveTo(5.6f, 9f); path.lineTo(12f, 15.4f); path.lineTo(18.4f, 9f); canvas.drawPath(path, stroke) }
      "chevron.up" -> { stroke.strokeWidth = 2.2f; path.moveTo(5.6f, 15f); path.lineTo(12f, 8.6f); path.lineTo(18.4f, 15f); canvas.drawPath(path, stroke) }
      "copy" -> {
        canvas.drawRoundRect(8.6f, 8.6f, 19.8f, 20.4f, 2.4f, 2.4f, stroke)
        path.moveTo(15.4f, 5.8f); path.quadTo(15.4f, 3.6f, 13.2f, 3.6f); path.lineTo(6.4f, 3.6f); path.quadTo(4.2f, 3.6f, 4.2f, 5.8f); path.lineTo(4.2f, 13.2f); path.quadTo(4.2f, 15.4f, 6.2f, 15.4f)
        canvas.drawPath(path, stroke)
      }
      "play" -> { path.moveTo(8f, 4.8f); path.lineTo(19.6f, 12f); path.lineTo(8f, 19.2f); path.close(); stroke.strokeWidth = 1.6f; canvas.drawPath(path, fill); canvas.drawPath(path, stroke) }
      "pause" -> { canvas.drawRoundRect(6.2f, 4.8f, 10.2f, 19.2f, 1.2f, 1.2f, fill); canvas.drawRoundRect(13.8f, 4.8f, 17.8f, 19.2f, 1.2f, 1.2f, fill) }
      "play.rect" -> {
        canvas.drawRoundRect(3.4f, 5.4f, 20.6f, 18.6f, 3f, 3f, stroke)
        path.moveTo(10.2f, 8.8f); path.lineTo(15.6f, 12f); path.lineTo(10.2f, 15.2f); path.close(); canvas.drawPath(path, fill)
      }
      "share" -> {
        // A tray with an arrow out of it.
        path.moveTo(8f, 10.4f); path.lineTo(6.4f, 10.4f); path.quadTo(4.8f, 10.4f, 4.8f, 12f); path.lineTo(4.8f, 19f); path.quadTo(4.8f, 20.6f, 6.4f, 20.6f)
        path.lineTo(17.6f, 20.6f); path.quadTo(19.2f, 20.6f, 19.2f, 19f); path.lineTo(19.2f, 12f); path.quadTo(19.2f, 10.4f, 17.6f, 10.4f); path.lineTo(16f, 10.4f)
        path.moveTo(12f, 14.8f); path.lineTo(12f, 3.4f); path.moveTo(8.6f, 6.6f); path.lineTo(12f, 3.2f); path.lineTo(15.4f, 6.6f)
        canvas.drawPath(path, stroke)
      }
      "mic" -> {
        canvas.drawRoundRect(9f, 3f, 15f, 14f, 3f, 3f, stroke)
        box.set(5.6f, 4.6f, 18.4f, 17.4f); canvas.drawArc(box, 0f, 180f, false, stroke)
        canvas.drawLine(12f, 17.4f, 12f, 20.8f, stroke); canvas.drawLine(8.6f, 20.8f, 15.4f, 20.8f, stroke)
      }
      "doc" -> {
        path.moveTo(13.6f, 3.2f); path.lineTo(7.4f, 3.2f); path.quadTo(5.6f, 3.2f, 5.6f, 5f); path.lineTo(5.6f, 19f); path.quadTo(5.6f, 20.8f, 7.4f, 20.8f)
        path.lineTo(16.6f, 20.8f); path.quadTo(18.4f, 20.8f, 18.4f, 19f); path.lineTo(18.4f, 8f); path.close()
        path.moveTo(9f, 12.4f); path.lineTo(15f, 12.4f); path.moveTo(9f, 16f); path.lineTo(15f, 16f)
        canvas.drawPath(path, stroke)
      }
      "heart", "heart.fill" -> {
        path.moveTo(12f, 20f); path.cubicTo(4.6f, 14.8f, 2.8f, 11.4f, 3.6f, 8.2f); path.cubicTo(4.6f, 4.4f, 9.6f, 3.6f, 12f, 7.4f)
        path.cubicTo(14.4f, 3.6f, 19.4f, 4.4f, 20.4f, 8.2f); path.cubicTo(21.2f, 11.4f, 19.4f, 14.8f, 12f, 20f); path.close()
        if (name == "heart.fill") canvas.drawPath(path, fill)
        canvas.drawPath(path, stroke)
      }
      "more" -> { for (x in floatArrayOf(5.4f, 12f, 18.6f)) canvas.drawCircle(x, 12f, 1.7f, fill) }
      "prev" -> {
        path.moveTo(19f, 5.4f); path.lineTo(9f, 12f); path.lineTo(19f, 18.6f); path.close(); stroke.strokeWidth = 1.6f; canvas.drawPath(path, fill); canvas.drawPath(path, stroke)
        stroke.strokeWidth = 2.4f; canvas.drawLine(5.8f, 5.6f, 5.8f, 18.4f, stroke)
      }
      "next" -> {
        path.moveTo(5f, 5.4f); path.lineTo(15f, 12f); path.lineTo(5f, 18.6f); path.close(); stroke.strokeWidth = 1.6f; canvas.drawPath(path, fill); canvas.drawPath(path, stroke)
        stroke.strokeWidth = 2.4f; canvas.drawLine(18.2f, 5.6f, 18.2f, 18.4f, stroke)
      }
      "repeat", "repeat.1" -> {
        // Two lines that turn into each other, with an arrow each.
        path.moveTo(4.4f, 11.4f); path.lineTo(4.4f, 9.6f); path.quadTo(4.4f, 6.8f, 7.2f, 6.8f); path.lineTo(18.6f, 6.8f); path.moveTo(15.8f, 3.8f); path.lineTo(18.8f, 6.8f); path.lineTo(15.8f, 9.8f)
        path.moveTo(19.6f, 12.6f); path.lineTo(19.6f, 14.4f); path.quadTo(19.6f, 17.2f, 16.8f, 17.2f); path.lineTo(5.4f, 17.2f); path.moveTo(8.2f, 14.2f); path.lineTo(5.2f, 17.2f); path.lineTo(8.2f, 20.2f)
        canvas.drawPath(path, stroke)
        if (name == "repeat.1") { letters.textSize = 7.4f; canvas.drawText("1", 12f, 12f - (letters.descent() + letters.ascent()) / 2, letters) }
      }
      "shuffle" -> {
        path.moveTo(3.6f, 7.4f); path.lineTo(7f, 7.4f); path.cubicTo(11.6f, 7.4f, 12.4f, 16.6f, 17f, 16.6f); path.lineTo(20f, 16.6f)
        path.moveTo(3.6f, 16.6f); path.lineTo(7f, 16.6f); path.cubicTo(8.8f, 16.6f, 9.8f, 15.4f, 10.6f, 14f); path.moveTo(13.4f, 10f); path.cubicTo(14.2f, 8.6f, 15.2f, 7.4f, 17f, 7.4f); path.lineTo(20f, 7.4f)
        path.moveTo(17.8f, 4.8f); path.lineTo(20.4f, 7.4f); path.lineTo(17.8f, 10f); path.moveTo(17.8f, 14f); path.lineTo(20.4f, 16.6f); path.lineTo(17.8f, 19.2f)
        canvas.drawPath(path, stroke)
      }
      // Music: «Эквалайзер» (music/MusicEqualizer.kt); AI: a photo or a file in the request (ai/AIAttachments.kt).
      "sliders" -> {
        canvas.drawLine(4f, 7f, 20f, 7f, stroke); canvas.drawLine(4f, 12f, 20f, 12f, stroke); canvas.drawLine(4f, 17f, 20f, 17f, stroke)
        canvas.drawCircle(9f, 7f, 2f, fill); canvas.drawCircle(15f, 12f, 2f, fill); canvas.drawCircle(7f, 17f, 2f, fill)
      }
      "photo" -> {
        canvas.drawRoundRect(3.5f, 5f, 20.5f, 19f, 2.6f, 2.6f, stroke)
        path.moveTo(3.8f, 16.4f); path.lineTo(9f, 11.4f); path.lineTo(13f, 15.2f); path.lineTo(15.6f, 12.8f); path.lineTo(20.2f, 16.8f); canvas.drawPath(path, stroke)
        canvas.drawCircle(15.8f, 8.8f, 1.4f, stroke)
      }
      "paperclip" -> {
        path.moveTo(15.5f, 7.5f); path.lineTo(8.6f, 14.4f); path.cubicTo(7.6f, 15.4f, 7.6f, 17f, 8.6f, 18f); path.cubicTo(9.6f, 19f, 11.2f, 19f, 12.2f, 18f)
        path.lineTo(19f, 11.2f); path.cubicTo(20.8f, 9.4f, 20.8f, 6.6f, 19f, 4.8f); path.cubicTo(17.2f, 3f, 14.4f, 3f, 12.6f, 4.8f); path.lineTo(5.6f, 11.8f)
        path.cubicTo(3f, 14.4f, 3f, 18.4f, 5.6f, 21f)
        canvas.drawPath(path, stroke)
      }
      "note" -> {
        canvas.drawOval(5f, 14.6f, 11f, 19.6f, fill)
        path.moveTo(10.2f, 17f); path.lineTo(10.2f, 5.4f); path.lineTo(18.4f, 3.6f); path.lineTo(18.4f, 8f); path.lineTo(10.2f, 9.8f)
        stroke.strokeWidth = 1.9f; canvas.drawPath(path, stroke)
      }
      "search" -> { stroke.strokeWidth = 2f; canvas.drawCircle(10.6f, 10.6f, 6.4f, stroke); canvas.drawLine(15.4f, 15.4f, 20.4f, 20.4f, stroke) }
      "drop" -> {
        path.moveTo(12f, 3.2f); path.cubicTo(8f, 8.4f, 5.6f, 11.4f, 5.6f, 14.6f); path.cubicTo(5.6f, 18.2f, 8.4f, 20.8f, 12f, 20.8f)
        path.cubicTo(15.6f, 20.8f, 18.4f, 18.2f, 18.4f, 14.6f); path.cubicTo(18.4f, 11.4f, 16f, 8.4f, 12f, 3.2f); path.close()
        canvas.drawPath(path, stroke)
      }
      "bolt" -> { path.moveTo(13.4f, 2.8f); path.lineTo(5.6f, 13.4f); path.lineTo(11.4f, 13.4f); path.lineTo(10.4f, 21.2f); path.lineTo(18.4f, 10.4f); path.lineTo(12.6f, 10.4f); path.close(); canvas.drawPath(path, stroke) }
      "sun" -> {
        canvas.drawCircle(12f, 12f, 4.2f, stroke)
        for (i in 0 until 8) {
          val a = Math.toRadians(i * 45.0); val x = Math.cos(a).toFloat(); val y = Math.sin(a).toFloat()
          canvas.drawLine(12f + x * 7.2f, 12f + y * 7.2f, 12f + x * 9.4f, 12f + y * 9.4f, stroke)
        }
      }
      "moon" -> {
        path.moveTo(19.6f, 14.2f); path.cubicTo(13.4f, 16.2f, 7.8f, 10.6f, 9.8f, 4.4f); path.cubicTo(1.8f, 6.8f, 2.4f, 18.4f, 10.6f, 20.2f); path.cubicTo(14.6f, 21f, 18.4f, 18.4f, 19.6f, 14.2f); path.close()
        canvas.drawPath(path, stroke)
      }
      "speaker" -> {
        path.moveTo(3.6f, 9.4f); path.lineTo(7.2f, 9.4f); path.lineTo(12f, 5.2f); path.lineTo(12f, 18.8f); path.lineTo(7.2f, 14.6f); path.lineTo(3.6f, 14.6f); path.close()
        canvas.drawPath(path, fill); canvas.drawPath(path, stroke)
        box.set(9.6f, 7.6f, 18.4f, 16.4f); canvas.drawArc(box, -50f, 100f, false, stroke)
        box.set(6.4f, 4.4f, 21.6f, 19.6f); canvas.drawArc(box, -46f, 92f, false, stroke)
      }
      "link" -> {
        // A square with an arrow leaving through its corner.
        path.moveTo(11f, 5.4f); path.lineTo(7f, 5.4f); path.quadTo(4.8f, 5.4f, 4.8f, 7.6f); path.lineTo(4.8f, 17f); path.quadTo(4.8f, 19.2f, 7f, 19.2f)
        path.lineTo(16.4f, 19.2f); path.quadTo(18.6f, 19.2f, 18.6f, 17f); path.lineTo(18.6f, 13f)
        path.moveTo(11.4f, 12.6f); path.lineTo(20f, 4f); path.moveTo(14.6f, 3.8f); path.lineTo(20.2f, 3.8f); path.lineTo(20.2f, 9.4f)
        canvas.drawPath(path, stroke)
      }
      "download" -> {
        canvas.drawCircle(12f, 12f, 8.8f, stroke)
        path.moveTo(12f, 7.4f); path.lineTo(12f, 16.2f); path.moveTo(8.4f, 12.8f); path.lineTo(12f, 16.4f); path.lineTo(15.6f, 12.8f)
        canvas.drawPath(path, stroke)
      }
    }
    canvas.restore()
  }
}
