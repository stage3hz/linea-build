package com.linea.messenger.profile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import com.linea.messenger.avatars.drawGem
import com.linea.messenger.chatactions.ChatIcons
import com.linea.messenger.design.Theme
import com.linea.messenger.people.PeopleIcons

/** The small pictures of the profile screens, drawn on a 24-unit grid: the ones the people and chat screens already
 *  draw are borrowed from them; the rest (camera, photo, timer, open lock, trash, play, file, cross, tick, sparkles,
 *  gem, hand, minus) are drawn here. */
object ProfileIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val people = setOf("search", "clock", "dots", "lock", "bubble.fill", "person.minus", "person.plus", "phone.fill", "video.fill", "check", "info")
  private val chat = setOf("bell", "bell.slash", "archive", "forward", "pencil", "xmark")

  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    if (name in people) return PeopleIcons.draw(canvas, name, cx, cy, size, color, Theme.surface2 or 0xFF000000.toInt())
    if (name in chat) return ChatIcons.draw(canvas, name, cx, cy, size, color)
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.8f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "camera" -> {
        canvas.drawRoundRect(RectF(3f, 7f, 21f, 19f), 3f, 3f, stroke)
        path.moveTo(8f, 7f); path.lineTo(9.5f, 4.5f); path.lineTo(14.5f, 4.5f); path.lineTo(16f, 7f); canvas.drawPath(path, stroke)
        canvas.drawCircle(12f, 13f, 3.4f, stroke)
      }
      "photo" -> {
        canvas.drawRoundRect(RectF(3f, 5f, 21f, 19f), 3f, 3f, stroke)
        path.moveTo(4f, 17f); path.lineTo(9f, 12f); path.lineTo(13f, 16f); path.lineTo(16f, 13f); path.lineTo(20f, 17f); canvas.drawPath(path, stroke)
        canvas.drawCircle(15.5f, 9f, 1.5f, fill)
      }
      "timer" -> {
        canvas.drawCircle(12f, 13f, 7.5f, stroke)
        canvas.drawLine(12f, 13f, 12f, 9f, stroke); canvas.drawLine(10f, 3f, 14f, 3f, stroke)
      }
      "lock.open" -> {
        canvas.drawRoundRect(RectF(5f, 11f, 19f, 20f), 2.5f, 2.5f, stroke)
        path.moveTo(8f, 11f); path.lineTo(8f, 8f); path.cubicTo(8f, 4f, 15f, 3.5f, 16f, 7f); canvas.drawPath(path, stroke)
      }
      "trash" -> {
        canvas.drawLine(4f, 6.5f, 20f, 6.5f, stroke)
        path.moveTo(6f, 6.5f); path.lineTo(7f, 20f); path.lineTo(17f, 20f); path.lineTo(18f, 6.5f); canvas.drawPath(path, stroke)
        canvas.drawLine(9.5f, 6.5f, 10f, 3.8f, stroke); canvas.drawLine(10f, 3.8f, 14f, 3.8f, stroke); canvas.drawLine(14f, 3.8f, 14.5f, 6.5f, stroke)
      }
      "play" -> { path.moveTo(8f, 5f); path.lineTo(19f, 12f); path.lineTo(8f, 19f); path.close(); canvas.drawPath(path, fill) }
      "doc" -> {
        path.moveTo(6f, 3f); path.lineTo(14f, 3f); path.lineTo(19f, 8f); path.lineTo(19f, 21f); path.lineTo(6f, 21f); path.close(); canvas.drawPath(path, fill)
      }
      "video" -> { canvas.drawRoundRect(RectF(3f, 7f, 15f, 17f), 2.5f, 2.5f, fill); path.moveTo(16f, 10.5f); path.lineTo(21f, 7.5f); path.lineTo(21f, 16.5f); path.lineTo(16f, 13.5f); path.close(); canvas.drawPath(path, fill) }
      "cross" -> { stroke.strokeWidth = 2f; canvas.drawLine(6f, 6f, 18f, 18f, stroke); canvas.drawLine(18f, 6f, 6f, 18f, stroke) }
      "tick" -> { stroke.strokeWidth = 2.6f; path.moveTo(5f, 12.5f); path.lineTo(10f, 17f); path.lineTo(19f, 7f); canvas.drawPath(path, stroke) }
      "sparkles" -> {
        path.moveTo(10f, 3f); path.quadTo(11f, 10f, 17f, 11f); path.quadTo(11f, 12f, 10f, 19f); path.quadTo(9f, 12f, 3f, 11f); path.quadTo(9f, 10f, 10f, 3f); path.close()
        canvas.drawPath(path, fill); canvas.drawCircle(18f, 5f, 1.6f, fill); canvas.drawCircle(19f, 18f, 1.2f, fill)
      }
      "gem" -> drawGem(canvas, 12f, 12f, 18f, fill)
      "hand" -> { canvas.drawRoundRect(RectF(7f, 5f, 17f, 20f), 4f, 4f, stroke); canvas.drawLine(10f, 5f, 10f, 11f, stroke); canvas.drawLine(14f, 5f, 14f, 11f, stroke) }
      "minus.circle" -> { canvas.drawCircle(12f, 12f, 8.5f, stroke); canvas.drawLine(8f, 12f, 16f, 12f, stroke) }
      "plus" -> { stroke.strokeWidth = 2f; canvas.drawLine(12f, 5f, 12f, 19f, stroke); canvas.drawLine(5f, 12f, 19f, 12f, stroke) }
      else -> canvas.drawCircle(12f, 12f, 3f, fill)
    }
    canvas.restore()
  }
}

/** One of the pictures above as a view. */
@SuppressLint("ViewConstructor")
class ProfileIconView(context: Context, var symbol: String, private val size: Float, var color: Int) : View(context) {
  override fun onDraw(canvas: Canvas) = ProfileIcons.draw(canvas, symbol, width / 2f, height / 2f, size * resources.displayMetrics.density, color)
}
