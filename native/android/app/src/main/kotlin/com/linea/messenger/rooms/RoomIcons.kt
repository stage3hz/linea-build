package com.linea.messenger.rooms

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import com.linea.messenger.calls.CallIcons
import com.linea.messenger.design.Symbols
import com.linea.messenger.design.Theme

/** The small pictures of rooms (where the iPhone app uses the system's symbols): shapes in a box of 24 units, as
 *  `Icons`. The microphone, the loudspeaker and the cross are those of calls. Used on the main thread only. */
object RoomIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val box = RectF()

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). `ink`: what the picture lies on (under a
   *  crossing line). An unknown name draws nothing. */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int, ink: Int = 0) {
    // "ion:<name>": the reference's own Ionicons glyph (design/IonIcon.kt).
    if (name.startsWith("ion:")) return com.linea.messenger.design.IonIcon.draw(canvas, name.substring(4), cx, cy, size, color)
    when (name) {
      "mic.fill", "mic.slash.fill", "xmark", "phone.fill" -> return CallIcons.draw(canvas, name, cx, cy, size, color, ink)
      "speaker.wave.2.fill" -> return CallIcons.draw(canvas, "speaker.fill", cx, cy, size, color, ink)
      "chevron.left" -> return Symbols.draw(canvas, "chevron.left", cx, cy, size, color)
    }
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.8f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "mic" -> {
        box.set(9.2f, 3.2f, 14.8f, 13.6f)
        canvas.drawRoundRect(box, 2.8f, 2.8f, stroke)
        box.set(6.2f, 5.6f, 17.8f, 16.8f); canvas.drawArc(box, 10f, 160f, false, stroke)
        canvas.drawLine(12f, 16.8f, 12f, 20.2f, stroke)
        canvas.drawLine(9f, 20.4f, 15f, 20.4f, stroke)
      }
      "music.note" -> {
        canvas.drawOval(5.4f, 15f, 10.6f, 19.6f, fill)
        canvas.drawOval(13.6f, 13f, 18.8f, 17.6f, fill)
        stroke.strokeWidth = 2f
        path.moveTo(10f, 17.4f); path.lineTo(10f, 6.4f); path.lineTo(18.2f, 4.4f); path.lineTo(18.2f, 15.4f)
        canvas.drawPath(path, stroke)
        canvas.drawLine(10f, 9.4f, 18.2f, 7.4f, stroke)
      }
      "ear" -> {
        // The earpiece: the sound at the ear.
        path.moveTo(7.4f, 9.6f); path.cubicTo(7.4f, 5.8f, 10f, 3.6f, 12.8f, 3.6f); path.cubicTo(15.8f, 3.6f, 18.2f, 5.8f, 18.2f, 9.2f)
        path.cubicTo(18.2f, 12.4f, 15.4f, 13.2f, 14.6f, 15.6f); path.cubicTo(14f, 17.6f, 13.6f, 20.4f, 10.8f, 20.4f); path.cubicTo(9.4f, 20.4f, 8.4f, 19.6f, 8f, 18.6f)
        canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(10.6f, 10f); path.cubicTo(10.6f, 7.8f, 11.8f, 6.6f, 13f, 6.6f); path.cubicTo(14.4f, 6.6f, 15.4f, 7.8f, 15.4f, 9.2f)
        canvas.drawPath(path, stroke)
      }
      "ellipsis" -> { canvas.drawCircle(5.6f, 12f, 1.8f, fill); canvas.drawCircle(12f, 12f, 1.8f, fill); canvas.drawCircle(18.4f, 12f, 1.8f, fill) }
      "phone.down.fill" -> {
        // The handset lying down: hang up.
        stroke.strokeWidth = 3.4f
        path.moveTo(4.4f, 14.4f); path.cubicTo(8.6f, 9.6f, 15.4f, 9.6f, 19.6f, 14.4f)
        canvas.drawPath(path, stroke)
        stroke.strokeWidth = 4.6f
        canvas.drawLine(4.6f, 14.2f, 6.4f, 16f, stroke)
        canvas.drawLine(19.4f, 14.2f, 17.6f, 16f, stroke)
      }
      "circle" -> canvas.drawCircle(12f, 12f, 9f, stroke)
      "checkmark.circle.fill" -> {
        canvas.drawCircle(12f, 12f, 9.6f, fill)
        stroke.color = if (ink != 0) ink else Theme.bg; stroke.strokeWidth = 2.2f
        path.moveTo(7.6f, 12.4f); path.lineTo(10.6f, 15.2f); path.lineTo(16.4f, 9f)
        canvas.drawPath(path, stroke)
      }
    }
    canvas.restore()
  }
}

/** One of the pictures above as a view, `size` dp across in the middle of its place; with a `contentDescription`
 *  and a click listener it is a button that dims under a finger. */
@SuppressLint("ViewConstructor")
open class RoomIconView(context: Context, symbol: String, private val size: Float, color: Int) : View(context) {
  private val d = resources.displayMetrics.density
  var symbol: String = symbol
    set(value) { if (field != value) { field = value; invalidate() } }
  var color: Int = color
    set(value) { if (field != value) { field = value; invalidate() } }
  /** What lies under the picture (for a crossing line). */
  var ink: Int = 0

  override fun getAccessibilityClassName(): CharSequence = if (isClickable) "android.widget.Button" else "android.view.View"
  override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
  override fun onDraw(canvas: Canvas) {
    RoomIcons.draw(canvas, symbol, width / 2f, height / 2f, size * d, if (isPressed && isClickable) Theme.alpha(color, 0.5f) else color, ink)
  }
}
