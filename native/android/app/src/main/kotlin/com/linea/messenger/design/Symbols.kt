package com.linea.messenger.design

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View

/** The small pictures of the sign-in screen and the settings (where the iPhone app uses the system's symbols):
 *  lines in a box of 24 units, as `Icons`. Used on the main thread only. */
object Symbols {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val letters = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
  private val path = Path()
  private val box = RectF()

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). An unknown name draws nothing. */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    // Channels: the pictures of «Каналы» (channels/ChannelIcons.kt), so that its rows of settings can show them.
    if (com.linea.messenger.channels.ChannelIcons.adds(name)) return com.linea.messenger.channels.ChannelIcons.draw(canvas, name, cx, cy, size, color)
    stroke.color = color; fill.color = color; letters.color = color; stroke.strokeWidth = 1.7f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "person" -> {
        canvas.drawCircle(12f, 8.2f, 3.7f, stroke)
        path.moveTo(4.6f, 20f); path.cubicTo(4.6f, 15.8f, 8f, 14.2f, 12f, 14.2f); path.cubicTo(16f, 14.2f, 19.4f, 15.8f, 19.4f, 20f)
        canvas.drawPath(path, stroke)
      }
      "lock" -> {
        canvas.drawRoundRect(5.4f, 10.6f, 18.6f, 20.4f, 2.6f, 2.6f, stroke)
        box.set(8.2f, 3.6f, 15.8f, 11.2f); canvas.drawArc(box, 180f, 180f, false, stroke)
        canvas.drawLine(8.2f, 7.4f, 8.2f, 10.6f, stroke); canvas.drawLine(15.8f, 7.4f, 15.8f, 10.6f, stroke)
      }
      "shield" -> {
        path.moveTo(12f, 3f); path.lineTo(19f, 5.6f); path.lineTo(19f, 11.4f)
        path.cubicTo(19f, 15.8f, 16.2f, 19.2f, 12f, 21f); path.cubicTo(7.8f, 19.2f, 5f, 15.8f, 5f, 11.4f); path.lineTo(5f, 5.6f); path.close()
        path.moveTo(8.8f, 11.8f); path.lineTo(11.2f, 14.2f); path.lineTo(15.4f, 9.6f)
        canvas.drawPath(path, stroke)
      }
      "phone" -> {
        canvas.drawRoundRect(7f, 2.6f, 17f, 21.4f, 2.6f, 2.6f, stroke)
        canvas.drawLine(10.6f, 18.6f, 13.4f, 18.6f, stroke)
      }
      "tablet" -> {
        canvas.drawRoundRect(4.6f, 3f, 19.4f, 21f, 2.4f, 2.4f, stroke)
        canvas.drawLine(10.6f, 18.2f, 13.4f, 18.2f, stroke)
      }
      "blocked" -> {
        canvas.drawCircle(12f, 12f, 8.6f, stroke)
        canvas.drawLine(5.9f, 5.9f, 18.1f, 18.1f, stroke)
      }
      "lifebuoy" -> {
        canvas.drawCircle(12f, 12f, 8.8f, stroke); canvas.drawCircle(12f, 12f, 3.6f, stroke)
        for (k in 0 until 4) {
          val a = Math.toRadians(45.0 + k * 90.0); val x = Math.cos(a).toFloat(); val y = Math.sin(a).toFloat()
          canvas.drawLine(12f + x * 3.6f, 12f + y * 3.6f, 12f + x * 8.8f, 12f + y * 8.8f, stroke)
        }
      }
      "info" -> {
        canvas.drawCircle(12f, 12f, 8.8f, stroke)
        canvas.drawLine(12f, 11f, 12f, 16.4f, stroke)
        canvas.drawCircle(12f, 7.8f, 1.1f, fill)
      }
      "exit" -> {
        path.moveTo(10.4f, 3.6f); path.lineTo(5.6f, 3.6f); path.lineTo(5.6f, 20.4f); path.lineTo(10.4f, 20.4f)
        path.moveTo(10.2f, 12f); path.lineTo(19.6f, 12f); path.moveTo(16f, 8.2f); path.lineTo(19.8f, 12f); path.lineTo(16f, 15.8f)
        canvas.drawPath(path, stroke)
      }
      "chevron.left" -> {
        stroke.strokeWidth = 2.3f
        path.moveTo(14.6f, 4.8f); path.lineTo(7.8f, 12f); path.lineTo(14.6f, 19.2f)
        canvas.drawPath(path, stroke)
      }
      "chevron.right" -> {
        stroke.strokeWidth = 2.6f
        path.moveTo(9.4f, 4.8f); path.lineTo(16.2f, 12f); path.lineTo(9.4f, 19.2f)
        canvas.drawPath(path, stroke)
      }
      "check" -> {
        stroke.strokeWidth = 2.3f
        path.moveTo(5.4f, 12.6f); path.lineTo(10f, 17.2f); path.lineTo(18.8f, 7.4f)
        canvas.drawPath(path, stroke)
      }
      "check.circle" -> {
        canvas.drawCircle(12f, 12f, 8.8f, stroke)
        path.moveTo(8.2f, 12.4f); path.lineTo(11f, 15.2f); path.lineTo(16f, 9.4f)
        canvas.drawPath(path, stroke)
      }
      "at" -> {
        letters.textSize = 19f; letters.typeface = Theme.weight(500)
        canvas.drawText("@", 12f, 12f - (letters.descent() + letters.ascent()) / 2, letters)
      }
      "gift" -> {
        canvas.drawRoundRect(4.4f, 8.4f, 19.6f, 12f, 1.2f, 1.2f, stroke)
        canvas.drawRoundRect(5.8f, 12f, 18.2f, 20.4f, 1.2f, 1.2f, stroke)
        canvas.drawLine(12f, 8.4f, 12f, 20.4f, stroke)
        path.moveTo(12f, 8.4f); path.cubicTo(9.2f, 8.4f, 7.2f, 6.6f, 8.4f, 4.8f); path.cubicTo(9.6f, 3.2f, 12f, 5.2f, 12f, 8.4f)
        path.cubicTo(12f, 5.2f, 14.4f, 3.2f, 15.6f, 4.8f); path.cubicTo(16.8f, 6.6f, 14.8f, 8.4f, 12f, 8.4f)
        canvas.drawPath(path, stroke)
      }
      "clock" -> {
        canvas.drawCircle(12f, 12f, 8.8f, stroke)
        path.moveTo(12f, 7f); path.lineTo(12f, 12f); path.lineTo(15.4f, 14f)
        canvas.drawPath(path, stroke)
      }
      "trash" -> {
        canvas.drawLine(4.6f, 6.6f, 19.4f, 6.6f, stroke)
        path.moveTo(9.4f, 6.4f); path.lineTo(9.4f, 4f); path.lineTo(14.6f, 4f); path.lineTo(14.6f, 6.4f)
        path.moveTo(6.4f, 6.8f); path.lineTo(7.4f, 20.4f); path.lineTo(16.6f, 20.4f); path.lineTo(17.6f, 6.8f)
        path.moveTo(10.2f, 10.4f); path.lineTo(10.4f, 16.8f); path.moveTo(13.8f, 10.4f); path.lineTo(13.6f, 16.8f)
        canvas.drawPath(path, stroke)
      }
      "key" -> {
        canvas.drawCircle(8.2f, 15.8f, 4f, stroke)
        path.moveTo(11f, 13f); path.lineTo(19.6f, 4.4f); path.moveTo(16.2f, 7.8f); path.lineTo(18.8f, 10.4f); path.moveTo(13.6f, 10.4f); path.lineTo(15.6f, 12.4f)
        canvas.drawPath(path, stroke)
      }
      "eye", "eye.slash" -> {
        path.moveTo(2.6f, 12f); path.cubicTo(5.4f, 7.2f, 8.6f, 5.6f, 12f, 5.6f); path.cubicTo(15.4f, 5.6f, 18.6f, 7.2f, 21.4f, 12f)
        path.cubicTo(18.6f, 16.8f, 15.4f, 18.4f, 12f, 18.4f); path.cubicTo(8.6f, 18.4f, 5.4f, 16.8f, 2.6f, 12f); path.close()
        canvas.drawPath(path, stroke)
        canvas.drawCircle(12f, 12f, 3f, stroke)
        if (name == "eye.slash") canvas.drawLine(4.6f, 3.8f, 19.4f, 20.2f, stroke)
      }
      "refresh" -> {
        box.set(4.4f, 4.4f, 19.6f, 19.6f); canvas.drawArc(box, -50f, 300f, false, stroke)
        path.moveTo(13.6f, 2.8f); path.lineTo(17.2f, 6f); path.lineTo(13f, 8.4f)
        canvas.drawPath(path, stroke)
      }
      "globe" -> {
        canvas.drawCircle(12f, 12f, 8.8f, stroke)
        box.set(8f, 3.2f, 16f, 20.8f); canvas.drawOval(box, stroke)
        canvas.drawLine(3.2f, 12f, 20.8f, 12f, stroke)
      }
      "desktop" -> {
        canvas.drawRoundRect(3.2f, 4.4f, 20.8f, 16f, 1.8f, 1.8f, stroke)
        canvas.drawLine(12f, 16f, 12f, 19.8f, stroke); canvas.drawLine(8.2f, 19.8f, 15.8f, 19.8f, stroke)
      }
    }
    canvas.restore()
  }
}

/** One of `Symbols`, `size` dp across, in the middle of its place. Not a button and not read aloud by itself. */
@SuppressLint("ViewConstructor")
open class SymbolView(context: Context, symbol: String, private val size: Float, color: Int) : View(context) {
  private val d = resources.displayMetrics.density

  var symbol: String = symbol
    set(value) { if (field != value) { field = value; invalidate() } }
  var color: Int = color
    set(value) { if (field != value) { field = value; invalidate() } }
  /** A round plate behind the picture (0 = none). */
  var plate: Int = 0
    set(value) { if (field != value) { field = value; invalidate() } }

  private val back = Paint(Paint.ANTI_ALIAS_FLAG)

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val own = Math.round(size * d)
    setMeasuredDimension(resolveSize(own, widthSpec), resolveSize(own, heightSpec))
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    if (plate != 0) { back.color = plate; canvas.drawCircle(width / 2f, height / 2f, minOf(width, height) / 2f, back) }
    val shown = if (isPressed || !isEnabled) Theme.alpha(color, 0.5f) else color
    Symbols.draw(canvas, symbol, width / 2f, height / 2f, size * d, shown)
  }
}

/** A button that is one of `Symbols`. Give it a `contentDescription`: that is its name for a screen reader. */
@SuppressLint("ViewConstructor")
class SymbolButton(context: Context, symbol: String, size: Float, color: Int) : SymbolView(context, symbol, size, color) {
  init {
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
}
