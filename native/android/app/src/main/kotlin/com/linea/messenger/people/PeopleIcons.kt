package com.linea.messenger.people

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import com.linea.messenger.design.Icons
import com.linea.messenger.design.Theme

/** The small pictures of «Люди» and of a profile, drawn as lines in a box of 24 units (as `Icons` draws the
 *  shell's). Used on the main thread only. */
object PeopleIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val box = RectF()

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). `ink`: the colour of what is cut out of a filled shape. */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int, ink: Int = Theme.bg) {
    if (name == "people" || name == "back") return Icons.draw(canvas, name, cx, cy, size, color)
    // Calls: the pictures of «Звонок» and «Видео» (calls/CallIcons.kt).
    if (com.linea.messenger.calls.CallIcons.adds(name)) return com.linea.messenger.calls.CallIcons.draw(canvas, name, cx, cy, size, color, ink)
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.8f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    when (name) {
      "search" -> {
        stroke.strokeWidth = 2f
        canvas.drawCircle(10.6f, 10.6f, 6.4f, stroke)
        canvas.drawLine(15.4f, 15.4f, 20.4f, 20.4f, stroke)
      }
      "clear" -> {
        // A cross cut out of a disc.
        canvas.drawCircle(12f, 12f, 10f, fill)
        stroke.color = ink; stroke.strokeWidth = 2f
        canvas.drawLine(8.6f, 8.6f, 15.4f, 15.4f, stroke); canvas.drawLine(15.4f, 8.6f, 8.6f, 15.4f, stroke)
      }
      "check" -> {
        stroke.strokeWidth = 2.4f
        path.reset(); path.moveTo(5.2f, 12.6f); path.lineTo(10f, 17.2f); path.lineTo(18.8f, 7.2f)
        canvas.drawPath(path, stroke)
      }
      "cross" -> {
        stroke.strokeWidth = 2.4f
        canvas.drawLine(6.2f, 6.2f, 17.8f, 17.8f, stroke); canvas.drawLine(17.8f, 6.2f, 6.2f, 17.8f, stroke)
      }
      "info" -> {
        canvas.drawCircle(12f, 12f, 9.4f, stroke)
        stroke.strokeWidth = 2f
        canvas.drawLine(12f, 11f, 12f, 16.6f, stroke)
        canvas.drawCircle(12f, 7.6f, 1.25f, fill)
      }
      "bubble", "bubble.fill" -> {
        // A speech bubble with its tail at the lower left.
        path.reset(); path.addRoundRect(3f, 4f, 21f, 17f, 5.5f, 5.5f, Path.Direction.CW)
        val tail = Path().apply { moveTo(6.2f, 14f); lineTo(5.2f, 20.6f); lineTo(12f, 16.6f); close() }
        path.op(tail, Path.Op.UNION)
        if (name == "bubble.fill") canvas.drawPath(path, fill)
        canvas.drawPath(path, stroke)
      }
      "person.plus", "person.minus" -> {
        canvas.drawCircle(9.6f, 8.2f, 3.6f, stroke)
        path.reset(); path.moveTo(2.8f, 20f); path.cubicTo(2.8f, 15.8f, 5.8f, 13.8f, 9.6f, 13.8f); path.cubicTo(11.4f, 13.8f, 13f, 14.3f, 14.2f, 15.2f)
        canvas.drawPath(path, stroke)
        stroke.strokeWidth = 2f
        canvas.drawLine(15.4f, 18f, 21.4f, 18f, stroke)
        if (name == "person.plus") canvas.drawLine(18.4f, 15f, 18.4f, 21f, stroke)
      }
      "clock" -> {
        canvas.drawCircle(12f, 12f, 9.2f, stroke)
        path.reset(); path.moveTo(12f, 6.8f); path.lineTo(12f, 12f); path.lineTo(15.6f, 14.2f)
        canvas.drawPath(path, stroke)
      }
      "dots" -> for (x in floatArrayOf(5.4f, 12f, 18.6f)) canvas.drawCircle(x, 12f, 1.9f, fill)
      "lock" -> {
        canvas.drawRoundRect(5f, 10.4f, 19f, 21f, 3f, 3f, fill)
        stroke.strokeWidth = 2.4f
        box.set(8f, 3.6f, 16f, 13.6f); canvas.drawArc(box, 180f, 180f, false, stroke)
        canvas.drawLine(8f, 8.6f, 8f, 11f, stroke); canvas.drawLine(16f, 8.6f, 16f, 11f, stroke)
      }
      "compose" -> {
        // A sheet with a pencil across its upper right corner.
        stroke.strokeWidth = 2f
        path.reset(); path.moveTo(11f, 4.6f); path.lineTo(6.8f, 4.6f); path.cubicTo(5f, 4.6f, 4f, 5.6f, 4f, 7.4f); path.lineTo(4f, 17.2f)
        path.cubicTo(4f, 19f, 5f, 20f, 6.8f, 20f); path.lineTo(16.6f, 20f); path.cubicTo(18.4f, 20f, 19.4f, 19f, 19.4f, 17.2f); path.lineTo(19.4f, 13f)
        canvas.drawPath(path, stroke)
        path.reset(); path.moveTo(18.2f, 3.4f); path.lineTo(20.8f, 6f); path.lineTo(12.6f, 14.2f); path.lineTo(9.4f, 14.8f); path.lineTo(10f, 11.6f); path.close()
        canvas.drawPath(path, stroke)
      }
      "radio" -> canvas.drawCircle(12f, 12f, 9.2f, stroke)
      "radio.on" -> {
        canvas.drawCircle(12f, 12f, 10f, fill)
        stroke.color = ink; stroke.strokeWidth = 2.2f
        path.reset(); path.moveTo(7.4f, 12.4f); path.lineTo(10.6f, 15.6f); path.lineTo(16.6f, 8.8f)
        canvas.drawPath(path, stroke)
      }
      "paperclip" -> {
        stroke.strokeWidth = 1.9f
        path.reset(); path.moveTo(17.6f, 11.4f); path.lineTo(11.2f, 17.8f); path.cubicTo(9.4f, 19.6f, 6.6f, 19.6f, 4.9f, 17.9f)
        path.cubicTo(3.2f, 16.2f, 3.2f, 13.4f, 5f, 11.6f); path.lineTo(12.4f, 4.2f); path.cubicTo(13.6f, 3f, 15.6f, 3f, 16.8f, 4.2f)
        path.cubicTo(18f, 5.4f, 18f, 7.4f, 16.8f, 8.6f); path.lineTo(9.6f, 15.8f); path.cubicTo(9f, 16.4f, 8f, 16.4f, 7.4f, 15.8f)
        path.cubicTo(6.8f, 15.2f, 6.8f, 14.2f, 7.4f, 13.6f); path.lineTo(13.6f, 7.4f)
        canvas.drawPath(path, stroke)
      }
      else -> canvas.drawCircle(12f, 12f, 8f, stroke)
    }
    canvas.restore()
  }
}

/** A round button with one of the pictures above in its middle, in one of the looks of the reference's rows:
 *  the picture alone, on a soft disc, on a disc of the accent colour, or in a thin ring. It dims under a finger
 *  and while it cannot be pressed. Give it a `contentDescription`. */
@SuppressLint("ViewConstructor")
class RoundIconButton(context: Context, private val symbol: String, private val look: Look, private val size: Float) : View(context) {
  enum class Look { PLAIN, SOFT, PRIMARY, OUTLINE }

  private val d = resources.displayMetrics.density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  init {
    isClickable = true
    // A row of a list stays pressable around its buttons.
    isFocusable = false
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f; val cy = height / 2f; val radius = minOf(width, height) / 2f
    val dim = if (isPressed || !isEnabled) 0.5f else 1f
    fun shade(color: Int) = Theme.alpha(color, (color ushr 24) / 255f * dim)
    var ink = Theme.bg
    val color = when (look) {
      Look.PLAIN -> Theme.muted
      Look.SOFT -> { paint.style = Paint.Style.FILL; paint.color = shade(Theme.veil(0.08f)); canvas.drawCircle(cx, cy, radius, paint); Theme.accent }
      Look.PRIMARY -> { paint.style = Paint.Style.FILL; paint.color = shade(Theme.accent); canvas.drawCircle(cx, cy, radius, paint); ink = Theme.accent; Theme.onAccent }
      Look.OUTLINE -> { paint.style = Paint.Style.STROKE; paint.strokeWidth = d; paint.color = shade(Theme.veil(0.14f)); canvas.drawCircle(cx, cy, radius - d / 2, paint); Theme.muted }
    }
    PeopleIcons.draw(canvas, symbol, cx, cy, size * d, shade(color), ink)
  }
}
