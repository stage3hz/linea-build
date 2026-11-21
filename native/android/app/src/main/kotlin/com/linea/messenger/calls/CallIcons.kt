package com.linea.messenger.calls

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

/** The small pictures of calls (where the iPhone app uses the system's symbols): shapes in a box of 24 units,
 *  as `Icons`. Used on the main thread only. */
object CallIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val box = RectF()

  private val names = setOf("phone", "phone.fill", "video", "video.fill", "video.slash.fill", "speaker.fill", "mic.fill", "mic.slash.fill", "xmark", "flip", "chevron.down")

  /** Whether this file draws a picture of that name. */
  fun adds(name: String): Boolean = name in names

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). `ink`: the colour under a crossing line
   *  (what the picture lies on). An unknown name draws nothing. */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int, ink: Int = 0) {
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.9f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "phone", "phone.fill" -> {
        // A handset: the grip, and the two thick ends.
        stroke.strokeWidth = if (name == "phone") 1.9f else 2.4f
        path.moveTo(6.6f, 5.2f); path.quadTo(6.2f, 17.8f, 18.8f, 17.4f)
        canvas.drawPath(path, stroke)
        stroke.strokeWidth = if (name == "phone") 4.2f else 5f
        canvas.drawLine(6.7f, 5.4f, 7.3f, 8f, stroke)
        canvas.drawLine(16f, 16.9f, 18.6f, 17.3f, stroke)
      }
      "video", "video.fill", "video.slash.fill" -> {
        val paint = if (name == "video") stroke else fill
        box.set(2.8f, 6.8f, 15.2f, 17.2f)
        canvas.drawRoundRect(box, 2.6f, 2.6f, paint)
        path.moveTo(16.6f, 11f); path.lineTo(21.2f, 8f); path.lineTo(21.2f, 16f); path.lineTo(16.6f, 13f); path.close()
        canvas.drawPath(path, paint)
        if (name == "video") canvas.drawPath(path, stroke)
        if (name == "video.slash.fill") slash(canvas, color, ink)
      }
      "speaker.fill" -> {
        path.moveTo(3.6f, 9.8f); path.lineTo(7.4f, 9.8f); path.lineTo(11.8f, 5.6f); path.lineTo(11.8f, 18.4f); path.lineTo(7.4f, 14.2f); path.lineTo(3.6f, 14.2f); path.close()
        canvas.drawPath(path, fill)
        canvas.drawPath(path, stroke.apply { strokeWidth = 1.2f })
        stroke.strokeWidth = 1.9f
        box.set(8.2f, 8f, 16.2f, 16f); canvas.drawArc(box, -50f, 100f, false, stroke)
        box.set(5.4f, 5.2f, 19f, 18.8f); canvas.drawArc(box, -50f, 100f, false, stroke)
      }
      "mic.fill", "mic.slash.fill" -> {
        box.set(9.2f, 3.2f, 14.8f, 13.6f)
        canvas.drawRoundRect(box, 2.8f, 2.8f, fill)
        box.set(6.2f, 5.6f, 17.8f, 16.8f); canvas.drawArc(box, 10f, 160f, false, stroke)
        canvas.drawLine(12f, 16.8f, 12f, 20.2f, stroke)
        canvas.drawLine(9f, 20.4f, 15f, 20.4f, stroke)
        if (name == "mic.slash.fill") slash(canvas, color, ink)
      }
      "xmark" -> {
        stroke.strokeWidth = 2.4f
        canvas.drawLine(6.6f, 6.6f, 17.4f, 17.4f, stroke)
        canvas.drawLine(17.4f, 6.6f, 6.6f, 17.4f, stroke)
      }
      "flip" -> {
        // Two arrows going round: the other camera.
        box.set(4.6f, 4.6f, 19.4f, 19.4f)
        canvas.drawArc(box, 200f, 130f, false, stroke)
        canvas.drawArc(box, 20f, 130f, false, stroke)
        path.moveTo(18.2f, 4.2f); path.lineTo(18.6f, 8.4f); path.lineTo(14.6f, 8.6f)
        path.moveTo(5.8f, 19.8f); path.lineTo(5.4f, 15.6f); path.lineTo(9.4f, 15.4f)
        canvas.drawPath(path, stroke)
      }
      "chevron.down" -> {
        stroke.strokeWidth = 2.2f
        path.moveTo(6.2f, 9.4f); path.lineTo(12f, 15.2f); path.lineTo(17.8f, 9.4f)
        canvas.drawPath(path, stroke)
      }
    }
    canvas.restore()
  }

  private fun slash(canvas: Canvas, color: Int, ink: Int) {
    if (ink != 0) { stroke.color = ink; stroke.strokeWidth = 4.6f; canvas.drawLine(4.4f, 4.4f, 19.6f, 19.6f, stroke) }
    stroke.color = color; stroke.strokeWidth = 1.9f
    canvas.drawLine(4.4f, 4.4f, 19.6f, 19.6f, stroke)
  }
}
