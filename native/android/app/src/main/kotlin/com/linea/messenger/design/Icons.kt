package com.linea.messenger.design

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import kotlin.math.cos
import kotlin.math.sin

/** The app's own small pictures, drawn as lines in a box of 24 units. Used on the main thread only. */
object Icons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val more = Path()
  private val box = RectF()

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). `filled`: the heavier drawing of a chosen
   *  tab, where the picture has one. `ink`: the colour of what is cut out of a filled shape. */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int, filled: Boolean = false, ink: Int = Theme.bg) {
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.7f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    when (name) {
      "chats" -> {
        // A speech bubble with its tail at the lower left.
        path.reset(); path.addRoundRect(3f, 4f, 21f, 17f, 5.5f, 5.5f, Path.Direction.CW)
        more.reset(); more.moveTo(6.2f, 14f); more.lineTo(5.2f, 20.6f); more.lineTo(12f, 16.6f); more.close()
        path.op(more, Path.Op.UNION)
        if (filled) canvas.drawPath(path, fill)
        canvas.drawPath(path, stroke)
      }
      "gear" -> {
        // A wheel with eight teeth and a hole.
        stroke.strokeWidth = 2.6f; stroke.strokeCap = Paint.Cap.BUTT
        for (i in 0 until 8) {
          val a = Math.toRadians(i * 45.0); val x = cos(a).toFloat(); val y = sin(a).toFloat()
          canvas.drawLine(12f + x * 7f, 12f + y * 7f, 12f + x * 9.6f, 12f + y * 9.6f, stroke)
        }
        stroke.strokeCap = Paint.Cap.ROUND
        if (filled) {
          path.reset(); path.fillType = Path.FillType.EVEN_ODD
          path.addCircle(12f, 12f, 7.4f, Path.Direction.CW); path.addCircle(12f, 12f, 2.7f, Path.Direction.CW)
          canvas.drawPath(path, fill); path.fillType = Path.FillType.WINDING
        } else {
          stroke.strokeWidth = 1.7f
          canvas.drawCircle(12f, 12f, 6.6f, stroke); canvas.drawCircle(12f, 12f, 2.6f, stroke)
        }
      }
      "sparkles" -> { star(canvas, 10f, 13.5f, 8f); star(canvas, 18.6f, 5.6f, 3.6f) }
      "people" -> {
        canvas.drawCircle(9f, 8.4f, 3.2f, stroke)
        path.reset(); path.moveTo(2.8f, 19.2f); path.cubicTo(2.8f, 15.6f, 5.6f, 13.8f, 9f, 13.8f); path.cubicTo(12.4f, 13.8f, 15.2f, 15.6f, 15.2f, 19.2f)
        canvas.drawPath(path, stroke)
        box.set(13.6f, 5.6f, 19.2f, 11.2f); canvas.drawArc(box, -100f, 200f, false, stroke)
        path.reset(); path.moveTo(17.4f, 13.9f); path.cubicTo(19.8f, 14.4f, 21.4f, 16.2f, 21.4f, 19.2f)
        canvas.drawPath(path, stroke)
      }
      "waves" -> {
        // A point that broadcasts: two arcs on each side.
        canvas.drawCircle(12f, 12f, 1.9f, fill)
        for (reach in floatArrayOf(5.2f, 9f)) {
          box.set(12f - reach, 12f - reach, 12f + reach, 12f + reach)
          canvas.drawArc(box, -48f, 96f, false, stroke); canvas.drawArc(box, 132f, 96f, false, stroke)
        }
      }
      "headphones" -> {
        box.set(4.4f, 4.6f, 19.6f, 19.8f); canvas.drawArc(box, 180f, 180f, false, stroke)
        canvas.drawRoundRect(3.2f, 12.6f, 7.4f, 19.6f, 2f, 2f, fill); canvas.drawRoundRect(16.6f, 12.6f, 20.8f, 19.6f, 2f, 2f, fill)
      }
      "back" -> {
        stroke.strokeWidth = 2.3f
        path.reset(); path.moveTo(14.6f, 4.8f); path.lineTo(7.8f, 12f); path.lineTo(14.6f, 19.2f)
        canvas.drawPath(path, stroke)
      }
      "send" -> {
        // An arrow up, cut out of a disc.
        canvas.drawCircle(12f, 12f, 11f, fill)
        stroke.color = ink; stroke.strokeWidth = 2.1f
        path.reset(); path.moveTo(12f, 17.2f); path.lineTo(12f, 7.4f); path.moveTo(7.8f, 11.4f); path.lineTo(12f, 7.2f); path.lineTo(16.2f, 11.4f)
        canvas.drawPath(path, stroke)
      }
      else -> canvas.drawCircle(12f, 12f, 8f, stroke)
    }
    canvas.restore()
  }

  /** A star of four points: the sides bend towards the centre. */
  private fun star(canvas: Canvas, cx: Float, cy: Float, r: Float) {
    val k = r * 0.16f
    path.reset(); path.moveTo(cx, cy - r)
    path.quadTo(cx + k, cy - k, cx + r, cy); path.quadTo(cx + k, cy + k, cx, cy + r)
    path.quadTo(cx - k, cy + k, cx - r, cy); path.quadTo(cx - k, cy - k, cx, cy - r); path.close()
    canvas.drawPath(path, fill)
  }
}
