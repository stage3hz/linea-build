package com.linea.messenger.composer

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

/** The small pictures of the composer, the polls and the media (where the iPhone app uses the system's symbols): lines
 *  in a box of 24 units, as `Symbols`, which hands these names here. */
object ComposerIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val box = RectF()
  private val names = setOf("face.smiling", "keyboard", "delete.left", "chevron.down", "chart.bar", "square.and.arrow.down", "star", "wand", "crop", "rotate", "lock.open", "speedometer", "pip", "eraser", "scissors", "sun", "textformat")

  fun adds(name: String): Boolean = name in names

  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.7f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "face.smiling" -> {
        canvas.drawCircle(12f, 12f, 8.6f, stroke)
        canvas.drawCircle(9.2f, 10f, 1.05f, fill); canvas.drawCircle(14.8f, 10f, 1.05f, fill)
        box.set(8f, 9.6f, 16f, 16.2f); canvas.drawArc(box, 20f, 140f, false, stroke)
      }
      "keyboard" -> {
        canvas.drawRoundRect(3f, 6.5f, 21f, 17.5f, 2.4f, 2.4f, stroke)
        for (row in 0..1) for (col in 0..4) canvas.drawCircle(6.4f + col * 2.8f, 9.6f + row * 2.6f, 0.7f, fill)
        canvas.drawLine(8.5f, 14.8f, 15.5f, 14.8f, stroke)
      }
      "delete.left" -> {
        path.moveTo(8.5f, 6f); path.lineTo(20f, 6f); path.lineTo(20f, 18f); path.lineTo(8.5f, 18f); path.lineTo(3.5f, 12f); path.close()
        canvas.drawPath(path, stroke)
        canvas.drawLine(11.5f, 9.5f, 16.5f, 14.5f, stroke); canvas.drawLine(16.5f, 9.5f, 11.5f, 14.5f, stroke)
      }
      "chevron.down" -> { path.moveTo(6.5f, 9.5f); path.lineTo(12f, 15f); path.lineTo(17.5f, 9.5f); canvas.drawPath(path, stroke) }
      "chart.bar" -> {
        canvas.drawRoundRect(5f, 12f, 8.4f, 19f, 1f, 1f, stroke); canvas.drawRoundRect(10.3f, 6f, 13.7f, 19f, 1f, 1f, stroke); canvas.drawRoundRect(15.6f, 9.5f, 19f, 19f, 1f, 1f, stroke)
      }
      "square.and.arrow.down" -> {
        path.moveTo(8f, 9f); path.lineTo(5.5f, 9f); path.lineTo(5.5f, 20f); path.lineTo(18.5f, 20f); path.lineTo(18.5f, 9f); path.lineTo(16f, 9f)
        canvas.drawPath(path, stroke)
        canvas.drawLine(12f, 3.5f, 12f, 14.5f, stroke)
        path.reset(); path.moveTo(8.5f, 11f); path.lineTo(12f, 14.5f); path.lineTo(15.5f, 11f); canvas.drawPath(path, stroke)
      }
      "star" -> {
        for (i in 0 until 10) {
          val r = if (i % 2 == 0) 8.5f else 3.8f
          val a = Math.toRadians((-90 + i * 36).toDouble())
          val x = 12f + (r * Math.cos(a)).toFloat(); val y = 12.6f + (r * Math.sin(a)).toFloat()
          if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        path.close(); canvas.drawPath(path, stroke)
      }
      "wand" -> {
        canvas.drawLine(4.5f, 19.5f, 15.5f, 8.5f, stroke)
        canvas.drawLine(17.5f, 3.5f, 17.5f, 6.5f, stroke); canvas.drawLine(16f, 5f, 19f, 5f, stroke)
        canvas.drawLine(20f, 10f, 20f, 12f, stroke); canvas.drawLine(19f, 11f, 21f, 11f, stroke)
      }
      "crop" -> {
        path.moveTo(7f, 3.5f); path.lineTo(7f, 17f); path.lineTo(20.5f, 17f)
        path.moveTo(3.5f, 7f); path.lineTo(17f, 7f); path.lineTo(17f, 20.5f)
        canvas.drawPath(path, stroke)
      }
      "rotate" -> {
        box.set(5f, 5f, 19f, 19f); canvas.drawArc(box, -80f, 300f, false, stroke)
        path.moveTo(12f, 2.5f); path.lineTo(14.6f, 5f); path.lineTo(12f, 7.5f); canvas.drawPath(path, stroke)
      }
      "lock.open" -> {
        canvas.drawRoundRect(5.4f, 10.6f, 18.6f, 20.4f, 2.6f, 2.6f, stroke)
        box.set(8.2f, 3.6f, 15.8f, 11.2f); canvas.drawArc(box, 180f, 150f, false, stroke)
        canvas.drawLine(8.2f, 7.4f, 8.2f, 10.6f, stroke)
      }
      "speedometer" -> {
        box.set(3.5f, 5f, 20.5f, 22f); canvas.drawArc(box, 180f, 180f, false, stroke)
        canvas.drawLine(12f, 13.5f, 16f, 9f, stroke); canvas.drawCircle(12f, 13.5f, 1.2f, fill)
      }
      "pip" -> {
        canvas.drawRoundRect(3f, 5f, 21f, 19f, 2.4f, 2.4f, stroke)
        canvas.drawRoundRect(12f, 11.5f, 18.5f, 16.5f, 1.2f, 1.2f, fill)
      }
      "eraser" -> {
        path.moveTo(9f, 19f); path.lineTo(4f, 14f); path.lineTo(13.5f, 4.5f); path.lineTo(19.5f, 10.5f); path.lineTo(11f, 19f); path.close()
        canvas.drawPath(path, stroke); canvas.drawLine(9f, 19f, 20f, 19f, stroke); canvas.drawLine(8f, 10f, 14f, 16f, stroke)
      }
      "scissors" -> {
        canvas.drawCircle(6.5f, 17f, 2.6f, stroke); canvas.drawCircle(17.5f, 17f, 2.6f, stroke)
        canvas.drawLine(8.4f, 15.2f, 16.5f, 4f, stroke); canvas.drawLine(15.6f, 15.2f, 7.5f, 4f, stroke)
      }
      "sun" -> {
        canvas.drawCircle(12f, 12f, 4f, stroke)
        for (i in 0 until 8) {
          val a = Math.toRadians((i * 45).toDouble())
          canvas.drawLine(12f + (6.5 * Math.cos(a)).toFloat(), 12f + (6.5 * Math.sin(a)).toFloat(), 12f + (8.8 * Math.cos(a)).toFloat(), 12f + (8.8 * Math.sin(a)).toFloat(), stroke)
        }
      }
      "textformat" -> {
        path.moveTo(4f, 18f); path.lineTo(9f, 6f); path.lineTo(14f, 18f); path.moveTo(6f, 13.5f); path.lineTo(12f, 13.5f)
        canvas.drawPath(path, stroke)
        canvas.drawCircle(17.5f, 15.5f, 2.6f, stroke); canvas.drawLine(20.1f, 12.5f, 20.1f, 18f, stroke)
      }
    }
    canvas.restore()
  }
}
