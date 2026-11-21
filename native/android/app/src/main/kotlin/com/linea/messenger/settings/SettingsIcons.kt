package com.linea.messenger.settings

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

/** The small pictures of «Оформление», «Уведомления и звуки» and «Данные и память» (where the iPhone app uses the
 *  system's symbols): lines in a box of 24 units, drawn through `Symbols`. Main thread only. */
object SettingsIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val path = Path()
  private val box = RectF()
  private val own = setOf("bell", "drive", "cloud", "moon", "sun", "battery", "video", "photo", "smile", "sparkles", "wand", "passcode", "plus", "xmark", "magnifyingglass", "minus.circle", "fingerprint", "backspace") // Effects / Security: the last thirteen

  fun adds(name: String): Boolean = name in own

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    stroke.color = color; stroke.strokeWidth = 1.7f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "bell" -> {
        path.moveTo(5f, 17f); path.cubicTo(6.6f, 15.4f, 6.8f, 13.6f, 6.8f, 10.6f); path.cubicTo(6.8f, 7.2f, 9f, 4.8f, 12f, 4.8f)
        path.cubicTo(15f, 4.8f, 17.2f, 7.2f, 17.2f, 10.6f); path.cubicTo(17.2f, 13.6f, 17.4f, 15.4f, 19f, 17f); path.close()
        canvas.drawPath(path, stroke)
        box.set(9.8f, 16.4f, 14.2f, 20.6f); canvas.drawArc(box, 0f, 180f, false, stroke)
      }
      "drive" -> {
        // A disk: its case, the line of its front, its light.
        path.moveTo(6.4f, 5f); path.lineTo(17.6f, 5f); path.lineTo(20.4f, 13f); path.lineTo(3.6f, 13f); path.close()
        canvas.drawPath(path, stroke)
        canvas.drawRoundRect(3.6f, 13f, 20.4f, 19f, 1.8f, 1.8f, stroke)
        canvas.drawLine(16.6f, 16f, 17.2f, 16f, stroke)
      }
      "cloud" -> {
        path.moveTo(7.2f, 18.4f); path.cubicTo(4.4f, 18.4f, 2.8f, 16.6f, 2.8f, 14.4f); path.cubicTo(2.8f, 12.2f, 4.4f, 10.6f, 6.6f, 10.4f)
        path.cubicTo(7f, 7.4f, 9.2f, 5.6f, 12f, 5.6f); path.cubicTo(14.6f, 5.6f, 16.6f, 7.2f, 17.2f, 9.6f)
        path.cubicTo(19.6f, 9.8f, 21.2f, 11.6f, 21.2f, 14f); path.cubicTo(21.2f, 16.6f, 19.4f, 18.4f, 16.8f, 18.4f); path.close()
        canvas.drawPath(path, stroke)
      }
      "moon" -> {
        path.moveTo(19.6f, 14.2f); path.cubicTo(18.6f, 14.6f, 17.6f, 14.8f, 16.4f, 14.8f); path.cubicTo(12f, 14.8f, 9.2f, 12f, 9.2f, 7.6f)
        path.cubicTo(9.2f, 6.4f, 9.4f, 5.4f, 9.8f, 4.4f); path.cubicTo(6.4f, 5.4f, 4f, 8.6f, 4f, 12.2f); path.cubicTo(4f, 16.6f, 7.4f, 20f, 11.8f, 20f)
        path.cubicTo(15.4f, 20f, 18.6f, 17.6f, 19.6f, 14.2f); path.close()
        canvas.drawPath(path, stroke)
      }
      "sun" -> {
        canvas.drawCircle(12f, 12f, 3.8f, stroke)
        for (k in 0 until 8) {
          canvas.save(); canvas.rotate(k * 45f, 12f, 12f)
          canvas.drawLine(12f, 2.8f, 12f, 5f, stroke)
          canvas.restore()
        }
      }
      // Effects: «Энергосбережение и анимации» and its rows; Security: «Код-пароль».
      "battery" -> {
        canvas.drawRoundRect(3f, 7.5f, 19f, 16.5f, 2.4f, 2.4f, stroke)
        canvas.drawLine(21f, 10.6f, 21f, 13.4f, stroke)
        canvas.drawLine(6.2f, 10.6f, 6.2f, 13.4f, stroke); canvas.drawLine(9.4f, 10.6f, 9.4f, 13.4f, stroke)
      }
      "video" -> {
        canvas.drawRoundRect(3f, 6.5f, 15.5f, 17.5f, 2.6f, 2.6f, stroke)
        path.moveTo(15.5f, 10.4f); path.lineTo(21f, 7.4f); path.lineTo(21f, 16.6f); path.lineTo(15.5f, 13.6f); canvas.drawPath(path, stroke)
      }
      "photo" -> {
        canvas.drawRoundRect(3.5f, 5f, 20.5f, 19f, 2.6f, 2.6f, stroke)
        path.moveTo(3.8f, 16.4f); path.lineTo(9f, 11.4f); path.lineTo(13f, 15.2f); path.lineTo(15.6f, 12.8f); path.lineTo(20.2f, 16.8f); canvas.drawPath(path, stroke)
        canvas.drawCircle(15.8f, 8.8f, 1.4f, stroke)
      }
      "smile" -> {
        canvas.drawCircle(12f, 12f, 8.6f, stroke)
        box.set(8f, 9.6f, 16f, 16.4f); canvas.drawArc(box, 20f, 140f, false, stroke)
        canvas.drawLine(9.3f, 9.6f, 9.3f, 10.2f, stroke); canvas.drawLine(14.7f, 9.6f, 14.7f, 10.2f, stroke)
      }
      "sparkles" -> {
        path.moveTo(10f, 4f); path.quadTo(10.8f, 9.2f, 16f, 10f); path.quadTo(10.8f, 10.8f, 10f, 16f); path.quadTo(9.2f, 10.8f, 4f, 10f); path.quadTo(9.2f, 9.2f, 10f, 4f)
        canvas.drawPath(path, stroke)
        canvas.drawLine(18f, 14.6f, 18f, 19.4f, stroke); canvas.drawLine(15.6f, 17f, 20.4f, 17f, stroke)
      }
      "wand" -> {
        canvas.drawLine(4.4f, 19.6f, 15.2f, 8.8f, stroke)
        canvas.drawLine(17.4f, 3.6f, 17.4f, 7.2f, stroke); canvas.drawLine(15.6f, 5.4f, 19.2f, 5.4f, stroke)
        canvas.drawLine(20.2f, 10.2f, 20.2f, 12.2f, stroke); canvas.drawLine(19.2f, 11.2f, 21.2f, 11.2f, stroke)
      }
      "passcode" -> {
        canvas.drawRoundRect(3f, 7f, 21f, 17f, 3f, 3f, stroke)
        for (x in floatArrayOf(7.5f, 12f, 16.5f)) canvas.drawCircle(x, 12f, 0.9f, stroke)
      }
      "plus" -> { canvas.drawLine(12f, 5f, 12f, 19f, stroke); canvas.drawLine(5f, 12f, 19f, 12f, stroke) }
      "xmark" -> { canvas.drawLine(6.5f, 6.5f, 17.5f, 17.5f, stroke); canvas.drawLine(17.5f, 6.5f, 6.5f, 17.5f, stroke) }
      "magnifyingglass" -> { canvas.drawCircle(10.5f, 10.5f, 6f, stroke); canvas.drawLine(15f, 15f, 20f, 20f, stroke) }
      "minus.circle" -> { canvas.drawCircle(12f, 12f, 8.6f, stroke); canvas.drawLine(8f, 12f, 16f, 12f, stroke) }
      "fingerprint" -> {
        for (r in floatArrayOf(2.4f, 5f, 7.6f)) { box.set(12f - r, 12f - r, 12f + r, 12f + r); canvas.drawArc(box, 200f, 230f, false, stroke) }
        canvas.drawLine(12f, 12f, 12f, 17f, stroke)
      }
      "backspace" -> {
        path.moveTo(8.6f, 5.5f); path.lineTo(20.5f, 5.5f); path.lineTo(20.5f, 18.5f); path.lineTo(8.6f, 18.5f); path.lineTo(2.8f, 12f); path.close(); canvas.drawPath(path, stroke)
        canvas.drawLine(11.4f, 9.4f, 16.6f, 14.6f, stroke); canvas.drawLine(16.6f, 9.4f, 11.4f, 14.6f, stroke)
      }
    }
    canvas.restore()
  }
}
