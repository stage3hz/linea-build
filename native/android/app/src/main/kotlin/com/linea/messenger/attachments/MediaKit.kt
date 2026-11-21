package com.linea.messenger.attachments

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View

/** Media: the drawn icons of the paperclip's panel, the photo editor and the video player (the iOS screens use the
 *  system's symbols of the same names). Each is drawn on a 24-unit grid, scaled to `size`, in one colour. */
object KitIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val path = Path()
  private val box = RectF()

  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int, weight: Float = 1.8f) {
    if (name.isEmpty()) return
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    stroke.color = color; stroke.strokeWidth = weight; fill.color = color
    path.reset()
    when (name) {
      "xmark" -> { canvas.drawLine(6.5f, 6.5f, 17.5f, 17.5f, stroke); canvas.drawLine(17.5f, 6.5f, 6.5f, 17.5f, stroke) }
      "camera" -> {
        path.moveTo(3f, 8f); path.lineTo(7.5f, 8f); path.lineTo(9f, 5.5f); path.lineTo(15f, 5.5f); path.lineTo(16.5f, 8f); path.lineTo(21f, 8f)
        path.lineTo(21f, 19f); path.lineTo(3f, 19f); path.close(); canvas.drawPath(path, stroke)
        canvas.drawCircle(12f, 13f, 3.6f, stroke)
      }
      "photo" -> {
        box.set(3f, 5f, 21f, 19f); canvas.drawRoundRect(box, 2.5f, 2.5f, stroke)
        path.moveTo(3.5f, 17f); path.lineTo(9f, 11.5f); path.lineTo(13f, 15.5f); path.lineTo(15.5f, 13f); path.lineTo(20.5f, 18f); canvas.drawPath(path, stroke)
        canvas.drawCircle(16f, 9f, 1.5f, fill)
      }
      "photo.stack" -> {
        box.set(5f, 7f, 21f, 20f); canvas.drawRoundRect(box, 2.5f, 2.5f, stroke)
        path.moveTo(3f, 16f); path.lineTo(3f, 6f); path.quadTo(3f, 4f, 5f, 4f); path.lineTo(17f, 4f); canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(5.5f, 18f); path.lineTo(10f, 13.5f); path.lineTo(13.5f, 17f); path.lineTo(15.5f, 15f); path.lineTo(20.5f, 19.5f); canvas.drawPath(path, stroke)
      }
      "doc" -> {
        path.moveTo(6f, 3f); path.lineTo(14f, 3f); path.lineTo(19f, 8f); path.lineTo(19f, 21f); path.lineTo(6f, 21f); path.close(); canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(14f, 3f); path.lineTo(14f, 8f); path.lineTo(19f, 8f); canvas.drawPath(path, stroke)
      }
      "folder" -> {
        path.moveTo(3f, 6.5f); path.lineTo(9f, 6.5f); path.lineTo(11f, 8.5f); path.lineTo(21f, 8.5f); path.lineTo(21f, 19f); path.lineTo(3f, 19f); path.close(); canvas.drawPath(path, stroke)
      }
      "chart.bar" -> { for ((x, top) in listOf(6f to 13f, 12f to 6f, 18f to 10f)) { box.set(x - 2f, top, x + 2f, 20f); canvas.drawRoundRect(box, 1f, 1f, fill) } }
      "music.note", "music.list" -> {
        canvas.drawCircle(8f, 17.5f, 2.6f, fill); canvas.drawCircle(17f, 15.5f, 2.6f, fill)
        path.moveTo(10.4f, 17.5f); path.lineTo(10.4f, 5.5f); path.lineTo(19.4f, 3.5f); path.lineTo(19.4f, 15.5f); canvas.drawPath(path, stroke)
      }
      "headphones" -> {
        path.moveTo(4f, 15f); path.lineTo(4f, 12f); path.cubicTo(4f, 2f, 20f, 2f, 20f, 12f); path.lineTo(20f, 15f); canvas.drawPath(path, stroke)
        box.set(3.5f, 13.5f, 8f, 20.5f); canvas.drawRoundRect(box, 2f, 2f, fill); box.set(16f, 13.5f, 20.5f, 20.5f); canvas.drawRoundRect(box, 2f, 2f, fill)
      }
      "arrow.up" -> { canvas.drawLine(12f, 19f, 12f, 5.5f, stroke); path.moveTo(6.5f, 11f); path.lineTo(12f, 5.5f); path.lineTo(17.5f, 11f); canvas.drawPath(path, stroke) }
      "video" -> {
        box.set(3f, 6.5f, 15.5f, 17.5f); canvas.drawRoundRect(box, 2.5f, 2.5f, stroke)
        path.moveTo(15.5f, 10.5f); path.lineTo(21f, 7.5f); path.lineTo(21f, 16.5f); path.lineTo(15.5f, 13.5f); canvas.drawPath(path, stroke)
      }
      "video.fill" -> {
        box.set(3f, 6.5f, 15.5f, 17.5f); canvas.drawRoundRect(box, 2.5f, 2.5f, fill)
        path.moveTo(16f, 10.5f); path.lineTo(21f, 7.5f); path.lineTo(21f, 16.5f); path.lineTo(16f, 13.5f); path.close(); canvas.drawPath(path, fill)
      }
      "pencil" -> {
        path.moveTo(5f, 19f); path.lineTo(6f, 15f); path.lineTo(16f, 5f); path.lineTo(19f, 8f); path.lineTo(9f, 18f); path.close(); canvas.drawPath(path, stroke)
      }
      "check.fill" -> { canvas.drawCircle(12f, 12f, 10f, fill) }
      "check" -> { path.moveTo(5.5f, 12.5f); path.lineTo(10f, 17f); path.lineTo(18.5f, 7.5f); canvas.drawPath(path, stroke) }
      "check.circle" -> { canvas.drawCircle(12f, 12f, 9.5f, stroke); path.moveTo(7.5f, 12.3f); path.lineTo(10.6f, 15.3f); path.lineTo(16.5f, 9f); canvas.drawPath(path, stroke) }
      "circle" -> canvas.drawCircle(12f, 12f, 9.5f, stroke)
      "crop" -> {
        path.moveTo(7f, 2.5f); path.lineTo(7f, 17f); path.lineTo(21.5f, 17f); canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(2.5f, 7f); path.lineTo(17f, 7f); path.lineTo(17f, 21.5f); canvas.drawPath(path, stroke)
      }
      "brush" -> {
        path.moveTo(20f, 4f); path.lineTo(11f, 13f); canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(10.5f, 13.5f); path.cubicTo(7f, 12f, 5f, 15f, 5.5f, 17f); path.cubicTo(5.8f, 18.5f, 4.5f, 19.5f, 3.5f, 19.8f)
        path.cubicTo(7f, 21.5f, 11.5f, 19.5f, 10.5f, 13.5f); canvas.drawPath(path, fill)
      }
      "bandage" -> {
        canvas.save(); canvas.rotate(-45f, 12f, 12f); box.set(2.5f, 8f, 21.5f, 16f); canvas.drawRoundRect(box, 4f, 4f, stroke)
        box.set(9f, 8f, 15f, 16f); canvas.drawRect(box, stroke); canvas.restore()
        canvas.drawCircle(11f, 11f, 0.8f, fill); canvas.drawCircle(13f, 13f, 0.8f, fill)
      }
      "sparkles" -> {
        star(canvas, 10f, 13f, 7f); star(canvas, 18f, 6f, 3.5f)
      }
      "resize" -> {
        canvas.drawLine(5f, 19f, 19f, 5f, stroke)
        path.moveTo(12.5f, 5f); path.lineTo(19f, 5f); path.lineTo(19f, 11.5f); canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(5f, 12.5f); path.lineTo(5f, 19f); path.lineTo(11.5f, 19f); canvas.drawPath(path, stroke)
      }
      "shrink" -> {
        path.moveTo(14f, 4f); path.lineTo(14f, 10f); path.lineTo(20f, 10f); canvas.drawPath(path, stroke); canvas.drawLine(14f, 10f, 20.5f, 3.5f, stroke)
        path.reset(); path.moveTo(4f, 14f); path.lineTo(10f, 14f); path.lineTo(10f, 20f); canvas.drawPath(path, stroke); canvas.drawLine(10f, 14f, 3.5f, 20.5f, stroke)
      }
      "undo", "redo" -> {
        if (name == "redo") { canvas.save(); canvas.scale(-1f, 1f, 12f, 12f) }
        path.moveTo(9f, 5f); path.lineTo(4.5f, 9.5f); path.lineTo(9f, 14f); canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(4.5f, 9.5f); path.lineTo(14f, 9.5f); path.cubicTo(21f, 9.5f, 21f, 19f, 14f, 19f); path.lineTo(10f, 19f); canvas.drawPath(path, stroke)
        if (name == "redo") canvas.restore()
      }
      "chevron.down" -> { path.moveTo(5.5f, 9f); path.lineTo(12f, 15.5f); path.lineTo(18.5f, 9f); canvas.drawPath(path, stroke) }
      "pip" -> {
        box.set(2.5f, 4.5f, 21.5f, 19.5f); canvas.drawRoundRect(box, 2.5f, 2.5f, stroke)
        box.set(12f, 12f, 19f, 17f); canvas.drawRoundRect(box, 1.2f, 1.2f, fill)
      }
      "gear" -> {
        canvas.drawCircle(12f, 12f, 3f, stroke)
        for (i in 0 until 8) {
          canvas.save(); canvas.rotate(i * 45f, 12f, 12f); canvas.drawLine(12f, 2.8f, 12f, 5f, stroke); canvas.restore()
        }
        canvas.drawCircle(12f, 12f, 7f, stroke)
      }
      "play" -> { path.moveTo(7.5f, 4.5f); path.lineTo(19.5f, 12f); path.lineTo(7.5f, 19.5f); path.close(); canvas.drawPath(path, fill) }
      "pause" -> { box.set(6.5f, 4.5f, 10f, 19.5f); canvas.drawRoundRect(box, 1f, 1f, fill); box.set(14f, 4.5f, 17.5f, 19.5f); canvas.drawRoundRect(box, 1f, 1f, fill) }
      "replay" -> {
        path.addArc(RectF(4f, 4f, 20f, 20f), -60f, 300f); canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(16.5f, 2.5f); path.lineTo(16.3f, 6.6f); path.lineTo(20.3f, 7f); canvas.drawPath(path, stroke)
      }
      "lock" -> {
        box.set(5f, 10.5f, 19f, 20.5f); canvas.drawRoundRect(box, 2f, 2f, stroke)
        path.moveTo(8f, 10.5f); path.lineTo(8f, 7.5f); path.cubicTo(8f, 2.5f, 16f, 2.5f, 16f, 7.5f); path.lineTo(16f, 10.5f); canvas.drawPath(path, stroke)
      }
      "speedometer" -> {
        path.addArc(RectF(3f, 5f, 21f, 23f), 180f, 180f); canvas.drawPath(path, stroke)
        canvas.drawLine(12f, 14f, 16f, 9f, stroke); canvas.drawCircle(12f, 14f, 1.4f, fill)
      }
      "download" -> {
        path.moveTo(7f, 17f); path.cubicTo(2f, 17f, 2f, 10f, 7f, 10f); path.cubicTo(8f, 4f, 16f, 4f, 17f, 10f); path.cubicTo(22f, 10f, 22f, 17f, 17f, 17f); canvas.drawPath(path, stroke)
        canvas.drawLine(12f, 11f, 12f, 20f, stroke); path.reset(); path.moveTo(9f, 17.5f); path.lineTo(12f, 20.5f); path.lineTo(15f, 17.5f); canvas.drawPath(path, stroke)
      }
      "share" -> {
        canvas.drawLine(12f, 3.5f, 12f, 15f, stroke); path.moveTo(8f, 7f); path.lineTo(12f, 3f); path.lineTo(16f, 7f); canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(8.5f, 10f); path.lineTo(5f, 10f); path.lineTo(5f, 21f); path.lineTo(19f, 21f); path.lineTo(19f, 10f); path.lineTo(15.5f, 10f); canvas.drawPath(path, stroke)
      }
      "forward" -> {
        path.moveTo(3.5f, 6f); path.lineTo(11.5f, 12f); path.lineTo(3.5f, 18f); path.close(); canvas.drawPath(path, fill)
        path.reset(); path.moveTo(12f, 6f); path.lineTo(20f, 12f); path.lineTo(12f, 18f); path.close(); canvas.drawPath(path, fill)
      }
      "triangle.left" -> { path.moveTo(16f, 5f); path.lineTo(7f, 12f); path.lineTo(16f, 19f); path.close(); canvas.drawPath(path, fill) }
      "triangle.right" -> { path.moveTo(8f, 5f); path.lineTo(17f, 12f); path.lineTo(8f, 19f); path.close(); canvas.drawPath(path, fill) }
      "camera.flip" -> {
        path.moveTo(3f, 8f); path.lineTo(7.5f, 8f); path.lineTo(9f, 5.5f); path.lineTo(15f, 5.5f); path.lineTo(16.5f, 8f); path.lineTo(21f, 8f)
        path.lineTo(21f, 19f); path.lineTo(3f, 19f); path.close(); canvas.drawPath(path, stroke)
        path.reset(); path.addArc(RectF(8.5f, 9.5f, 15.5f, 16.5f), 200f, 250f); canvas.drawPath(path, stroke)
      }
    }
    canvas.restore()
  }

  private fun star(canvas: Canvas, cx: Float, cy: Float, r: Float) {
    path.reset()
    path.moveTo(cx, cy - r); path.quadTo(cx, cy, cx + r, cy); path.quadTo(cx, cy, cx, cy + r); path.quadTo(cx, cy, cx - r, cy); path.quadTo(cx, cy, cx, cy - r); path.close()
    canvas.drawPath(path, fill)
  }
}

/** A drawn icon as a view (the colour and the icon may change; a pressed one dims). */
@SuppressLint("ViewConstructor")
class KitIcon(context: Context, var symbol: String, var iconSize: Float, var color: Int) : View(context) {
  private val d = context.resources.displayMetrics.density
  init { isClickable = true; isFocusable = true }
  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
  override fun onDraw(canvas: Canvas) {
    val tint = if (isPressed) (color and 0x00FFFFFF) or ((((color ushr 24) * 0.55f).toInt()) shl 24) else color
    KitIcons.draw(canvas, symbol, width / 2f, height / 2f, iconSize * d, if (isEnabled) tint else (tint and 0x00FFFFFF) or 0x66000000)
  }
}
