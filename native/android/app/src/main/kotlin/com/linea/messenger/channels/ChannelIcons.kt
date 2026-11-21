package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import com.linea.messenger.design.Icons
import com.linea.messenger.design.Symbols
import com.linea.messenger.design.Theme
import com.linea.messenger.people.PeopleIcons

/** The small pictures of «Каналы», drawn as lines in a box of 24 units (as `Icons`, `Symbols` and `PeopleIcons`
 *  draw theirs; the ones those already have are taken from them). Where the iPhone app shows a system symbol,
 *  this app shows the picture of the same meaning. Used on the main thread only. */
object ChannelIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val box = RectF()

  private val fromIcons = setOf("back", "gear", "send", "people")
  private val fromSymbols = setOf("person", "lock", "shield", "blocked", "exit", "check", "clock", "trash", "refresh", "globe", "info", "chevron.right", "chevron.left")
  private val fromPeople = mapOf("bubble" to "bubble", "person.plus" to "person.plus", "person.minus" to "person.minus", "cross" to "cross", "pencil" to "compose", "search" to "search")

  /** The names this file draws itself (the others belong to the files named above). */
  val own = setOf("link", "plus", "megaphone", "gamecontroller", "speaker", "speaker.slash", "chevron.down", "plus.circle", "reply", "answer", "copy", "alert",
    "share", "plane", "rosette", "video", "doc", "newspaper", "music", "cpu", "smile", "cap", "sport", "palette", "dots.circle")

  /** A name `Symbols` does not draw itself and this file does (so a row of the settings can show it). */
  fun adds(name: String): Boolean = name in own || name in fromIcons || name in fromPeople

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). An unknown name draws nothing. */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    if (name in fromIcons) return Icons.draw(canvas, name, cx, cy, size, color)
    if (name in fromSymbols) return Symbols.draw(canvas, name, cx, cy, size, color)
    fromPeople[name]?.let { return PeopleIcons.draw(canvas, it, cx, cy, size, color) }
    if (name !in own) return
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.8f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "link" -> {
        // Two links of a chain, one through the other.
        canvas.save(); canvas.rotate(-45f, 12f, 12f)
        canvas.drawRoundRect(2.6f, 8.6f, 12.6f, 15.4f, 3.4f, 3.4f, stroke)
        canvas.drawRoundRect(11.4f, 8.6f, 21.4f, 15.4f, 3.4f, 3.4f, stroke)
        canvas.restore()
      }
      "plus" -> { stroke.strokeWidth = 2.2f; canvas.drawLine(12f, 5f, 12f, 19f, stroke); canvas.drawLine(5f, 12f, 19f, 12f, stroke) }
      "plus.circle" -> {
        canvas.drawCircle(12f, 12f, 10.4f, fill)
        stroke.color = Theme.bg; stroke.strokeWidth = 2f
        canvas.drawLine(12f, 7.2f, 12f, 16.8f, stroke); canvas.drawLine(7.2f, 12f, 16.8f, 12f, stroke)
      }
      "megaphone" -> {
        path.moveTo(3.6f, 10f); path.lineTo(7.4f, 10f); path.lineTo(17.6f, 5f); path.lineTo(17.6f, 19f); path.lineTo(7.4f, 14.4f); path.lineTo(3.6f, 14.4f); path.close()
        canvas.drawPath(path, stroke)
        canvas.drawLine(7.6f, 14.6f, 9f, 19.4f, stroke)
        box.set(16.4f, 8.6f, 22f, 15.4f); canvas.drawArc(box, -60f, 120f, false, stroke)
      }
      "gamecontroller" -> {
        canvas.drawRoundRect(2.6f, 7.2f, 21.4f, 17.2f, 5f, 5f, stroke)
        canvas.drawLine(6.6f, 12.2f, 10.6f, 12.2f, stroke); canvas.drawLine(8.6f, 10.2f, 8.6f, 14.2f, stroke)
        canvas.drawCircle(15.4f, 13.4f, 1f, fill); canvas.drawCircle(18f, 11f, 1f, fill)
      }
      "speaker", "speaker.slash" -> {
        path.moveTo(3.4f, 9.6f); path.lineTo(7f, 9.6f); path.lineTo(11.6f, 5.6f); path.lineTo(11.6f, 18.4f); path.lineTo(7f, 14.4f); path.lineTo(3.4f, 14.4f); path.close()
        canvas.drawPath(path, fill); canvas.drawPath(path, stroke)
        if (name == "speaker") {
          box.set(9.4f, 8f, 16.2f, 16f); canvas.drawArc(box, -55f, 110f, false, stroke)
          box.set(8.2f, 4.6f, 20.2f, 19.4f); canvas.drawArc(box, -50f, 100f, false, stroke)
        } else {
          canvas.drawLine(15f, 9.4f, 20.4f, 14.8f, stroke); canvas.drawLine(20.4f, 9.4f, 15f, 14.8f, stroke)
        }
      }
      "chevron.down" -> { stroke.strokeWidth = 2.2f; path.moveTo(5.6f, 9f); path.lineTo(12f, 15.4f); path.lineTo(18.4f, 9f); canvas.drawPath(path, stroke) }
      "reply" -> {
        // Down, then to the right: «in answer to».
        path.moveTo(5.4f, 4.6f); path.lineTo(5.4f, 11f); path.quadTo(5.4f, 14.6f, 9f, 14.6f); path.lineTo(19f, 14.6f)
        path.moveTo(15f, 10.4f); path.lineTo(19.2f, 14.6f); path.lineTo(15f, 18.8f)
        canvas.drawPath(path, stroke)
      }
      "answer" -> {
        // An arrow that turns back to the left.
        path.moveTo(9.4f, 5.6f); path.lineTo(4f, 11f); path.lineTo(9.4f, 16.4f)
        path.moveTo(4.4f, 11f); path.lineTo(13f, 11f); path.quadTo(20f, 11f, 20f, 18.6f)
        canvas.drawPath(path, stroke)
      }
      "copy" -> {
        canvas.drawRoundRect(8.4f, 8.4f, 20f, 20.6f, 2.4f, 2.4f, stroke)
        path.moveTo(15.6f, 5.4f); path.lineTo(15.6f, 5f); path.quadTo(15.6f, 3.4f, 14f, 3.4f); path.lineTo(5.6f, 3.4f); path.quadTo(4f, 3.4f, 4f, 5f); path.lineTo(4f, 14f); path.quadTo(4f, 15.6f, 5.4f, 15.6f)
        canvas.drawPath(path, stroke)
      }
      "alert" -> {
        canvas.drawCircle(12f, 12f, 9f, stroke)
        stroke.strokeWidth = 2f; canvas.drawLine(12f, 7.4f, 12f, 13f, stroke); canvas.drawCircle(12f, 16.4f, 1.1f, fill)
      }
      "share" -> {
        path.moveTo(7.6f, 10f); path.lineTo(6f, 10f); path.quadTo(4.6f, 10f, 4.6f, 11.4f); path.lineTo(4.6f, 19.2f); path.quadTo(4.6f, 20.6f, 6f, 20.6f); path.lineTo(18f, 20.6f)
        path.quadTo(19.4f, 20.6f, 19.4f, 19.2f); path.lineTo(19.4f, 11.4f); path.quadTo(19.4f, 10f, 18f, 10f); path.lineTo(16.4f, 10f)
        path.moveTo(12f, 14.6f); path.lineTo(12f, 3.2f); path.moveTo(8.4f, 6.6f); path.lineTo(12f, 3f); path.lineTo(15.6f, 6.6f)
        canvas.drawPath(path, stroke)
      }
      "plane" -> {
        path.moveTo(20.6f, 3.4f); path.lineTo(3.2f, 10.4f); path.lineTo(10.2f, 13.6f); path.lineTo(13.4f, 20.6f); path.close()
        path.moveTo(10.2f, 13.6f); path.lineTo(20.6f, 3.4f)
        canvas.drawPath(path, stroke)
      }
      "rosette" -> {
        // A medal: a disc and two ribbons under it.
        canvas.drawCircle(12f, 9f, 6.2f, fill)
        path.moveTo(8.4f, 13.4f); path.lineTo(7f, 21.4f); path.lineTo(12f, 18.4f); path.lineTo(17f, 21.4f); path.lineTo(15.6f, 13.4f); path.close()
        canvas.drawPath(path, fill)
      }
      "video" -> {
        canvas.drawRoundRect(2.8f, 6.6f, 15.4f, 17.4f, 2.6f, 2.6f, fill)
        path.moveTo(16.6f, 10.4f); path.lineTo(21.4f, 7.4f); path.lineTo(21.4f, 16.6f); path.lineTo(16.6f, 13.6f); path.close()
        canvas.drawPath(path, fill)
      }
      "doc" -> {
        // A sheet with a folded corner.
        path.moveTo(6.4f, 3f); path.lineTo(13.6f, 3f); path.lineTo(18.6f, 8f); path.lineTo(18.6f, 19.4f); path.quadTo(18.6f, 21f, 17f, 21f); path.lineTo(7f, 21f); path.quadTo(5.4f, 21f, 5.4f, 19.4f); path.lineTo(5.4f, 4.4f); path.quadTo(5.4f, 3f, 6.4f, 3f); path.close()
        canvas.drawPath(path, fill)
        stroke.color = Theme.bg; stroke.strokeWidth = 1.4f
        path.reset(); path.moveTo(13.4f, 3.4f); path.lineTo(13.4f, 8.2f); path.lineTo(18.2f, 8.2f); canvas.drawPath(path, stroke)
      }
      "newspaper" -> {
        canvas.drawRoundRect(3.4f, 5f, 20.6f, 19f, 2f, 2f, stroke)
        canvas.drawRect(6.4f, 8.2f, 11f, 12.4f, stroke)
        canvas.drawLine(13.6f, 8.4f, 17.6f, 8.4f, stroke); canvas.drawLine(13.6f, 12f, 17.6f, 12f, stroke); canvas.drawLine(6.4f, 15.6f, 17.6f, 15.6f, stroke)
      }
      "music" -> {
        canvas.drawCircle(7.6f, 17.6f, 2.8f, fill); canvas.drawCircle(17.2f, 15.6f, 2.8f, fill)
        path.moveTo(10.4f, 17.6f); path.lineTo(10.4f, 6f); path.lineTo(20f, 4f); path.lineTo(20f, 15.6f)
        canvas.drawPath(path, stroke)
      }
      "cpu" -> {
        canvas.drawRoundRect(6.4f, 6.4f, 17.6f, 17.6f, 2f, 2f, stroke)
        canvas.drawRect(10f, 10f, 14f, 14f, stroke)
        for (at in floatArrayOf(9.4f, 14.6f)) {
          canvas.drawLine(at, 3.4f, at, 6.4f, stroke); canvas.drawLine(at, 17.6f, at, 20.6f, stroke)
          canvas.drawLine(3.4f, at, 6.4f, at, stroke); canvas.drawLine(17.6f, at, 20.6f, at, stroke)
        }
      }
      "smile" -> {
        canvas.drawCircle(12f, 12f, 9f, stroke)
        canvas.drawCircle(8.8f, 10f, 1.1f, fill); canvas.drawCircle(15.2f, 10f, 1.1f, fill)
        box.set(7.6f, 8.4f, 16.4f, 16.6f); canvas.drawArc(box, 25f, 130f, false, stroke)
      }
      "cap" -> {
        path.moveTo(2.4f, 9.6f); path.lineTo(12f, 5f); path.lineTo(21.6f, 9.6f); path.lineTo(12f, 14.2f); path.close()
        path.moveTo(6.6f, 12f); path.lineTo(6.6f, 16.2f); path.quadTo(12f, 20f, 17.4f, 16.2f); path.lineTo(17.4f, 12f)
        path.moveTo(21.6f, 9.6f); path.lineTo(21.6f, 15f)
        canvas.drawPath(path, stroke)
      }
      "sport" -> {
        // A field: its line and its circle.
        canvas.drawRoundRect(3f, 5.4f, 21f, 18.6f, 2f, 2f, stroke)
        canvas.drawLine(12f, 5.4f, 12f, 18.6f, stroke); canvas.drawCircle(12f, 12f, 2.8f, stroke)
      }
      "palette" -> {
        path.moveTo(12f, 3.2f); path.cubicTo(6.6f, 3.2f, 3f, 7.2f, 3f, 12f); path.cubicTo(3f, 17f, 7f, 20.8f, 11.4f, 20.8f)
        path.cubicTo(13.8f, 20.8f, 14f, 19f, 13.2f, 17.8f); path.cubicTo(12.2f, 16.2f, 13.2f, 14.6f, 15.2f, 14.6f); path.lineTo(17.4f, 14.6f)
        path.cubicTo(19.6f, 14.6f, 21f, 13f, 21f, 11f); path.cubicTo(21f, 6.4f, 17f, 3.2f, 12f, 3.2f); path.close()
        canvas.drawPath(path, stroke)
        canvas.drawCircle(7.6f, 11f, 1.2f, fill); canvas.drawCircle(10.6f, 7.4f, 1.2f, fill); canvas.drawCircle(15f, 7.6f, 1.2f, fill)
      }
      "dots.circle" -> {
        canvas.drawCircle(12f, 12f, 9f, stroke)
        canvas.drawCircle(8f, 12f, 1.1f, fill); canvas.drawCircle(12f, 12f, 1.1f, fill); canvas.drawCircle(16f, 12f, 1.1f, fill)
      }
    }
    canvas.restore()
  }
}

/** A button that is one of the pictures above, `size` dp across, in the middle of its place; `plate` (not 0): a
 *  round plate of that colour behind it. It dims under a finger. Give it a `contentDescription`. */
@SuppressLint("ViewConstructor")
class ChannelIconButton(context: Context, symbol: String, private val size: Float, color: Int, private val plate: Int = 0) : View(context) {
  private val d = resources.displayMetrics.density
  private val back = Paint(Paint.ANTI_ALIAS_FLAG)
  var symbol: String = symbol
    set(value) { if (field != value) { field = value; invalidate() } }
  var color: Int = color
    set(value) { if (field != value) { field = value; invalidate() } }

  init {
    isClickable = true
    isFocusable = true
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val dim = if (isPressed || !isEnabled) 0.5f else 1f
    if (plate != 0) { back.color = Theme.alpha(plate, (plate ushr 24) / 255f * dim); canvas.drawCircle(width / 2f, height / 2f, minOf(width, height) / 2f, back) }
    ChannelIcons.draw(canvas, symbol, width / 2f, height / 2f, size * d, Theme.alpha(color, (color ushr 24) / 255f * dim))
  }
}

/** One of the pictures above that is not pressed and not read aloud. */
@SuppressLint("ViewConstructor")
class ChannelIconView(context: Context, symbol: String, private val size: Float, color: Int) : View(context) {
  private val d = resources.displayMetrics.density
  var symbol: String = symbol
    set(value) { if (field != value) { field = value; invalidate() } }
  var color: Int = color
    set(value) { if (field != value) { field = value; invalidate() } }

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  override fun onDraw(canvas: Canvas) = ChannelIcons.draw(canvas, symbol, width / 2f, height / 2f, size * d, color)
}
