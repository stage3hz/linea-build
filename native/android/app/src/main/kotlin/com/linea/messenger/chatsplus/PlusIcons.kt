package com.linea.messenger.chatsplus

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import com.linea.messenger.ai.AIIcons
import com.linea.messenger.chatactions.ChatIcons
import com.linea.messenger.design.Theme

/** ChatsPlus: the small pictures of the chat list's extras (where the iPhone app uses the system's symbols):
 *  lines in a box of 24 units, as the other icon sets draw theirs; what those already have is drawn by them.
 *  Main thread only. */
object PlusIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val box = RectF()
  private val fromAI = setOf("plus", "xmark", "arrow.up", "chevron.down", "chevron.up", "copy", "play", "pause", "mic", "doc", "download", "compose")
  private val fromChats = setOf("pin", "pin.slash", "forward", "bell", "bell.slash", "archive", "person.2", "search", "bubble", "bubble.fill", "clock", "trash", "check", "check.circle", "chevron.left", "chevron.right")

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    if (name in fromAI) return AIIcons.draw(canvas, name, cx, cy, size, color)
    if (name in fromChats) return ChatIcons.draw(canvas, name, cx, cy, size, color)
    if (name == "phone") return com.linea.messenger.calls.CallIcons.draw(canvas, name, cx, cy, size, color)
    if (name == "paperclip") return com.linea.messenger.people.PeopleIcons.draw(canvas, name, cx, cy, size, color)
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.8f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "folder" -> {
        path.moveTo(3.4f, 7f); path.quadTo(3.4f, 5f, 5.4f, 5f); path.lineTo(9.4f, 5f); path.lineTo(11.4f, 7.2f); path.lineTo(18.6f, 7.2f)
        path.quadTo(20.6f, 7.2f, 20.6f, 9.2f); path.lineTo(20.6f, 17f); path.quadTo(20.6f, 19f, 18.6f, 19f); path.lineTo(5.4f, 19f); path.quadTo(3.4f, 19f, 3.4f, 17f); path.close()
        canvas.drawPath(path, stroke)
      }
      "bookmark", "bookmark.fill" -> {
        path.moveTo(6.4f, 4.4f); path.lineTo(17.6f, 4.4f); path.lineTo(17.6f, 20f); path.lineTo(12f, 15.8f); path.lineTo(6.4f, 20f); path.close()
        if (name == "bookmark.fill") canvas.drawPath(path, fill) else canvas.drawPath(path, stroke)
      }
      "bubbles" -> {
        // Two speech bubbles, one behind the other.
        canvas.drawRoundRect(3f, 4f, 15.6f, 13.4f, 4.6f, 4.6f, stroke)
        path.moveTo(6f, 13.2f); path.lineTo(4.6f, 16.6f); path.lineTo(9f, 13.4f)
        path.moveTo(17.6f, 8.4f); path.quadTo(21f, 8.6f, 21f, 12.4f); path.quadTo(21f, 16.4f, 17f, 16.6f); path.lineTo(18.8f, 20f); path.lineTo(13.4f, 16.6f); path.lineTo(11.4f, 16.6f)
        canvas.drawPath(path, stroke)
      }
      "checkmark.circle" -> {
        canvas.drawCircle(12f, 12f, 8.6f, stroke)
        path.moveTo(8.2f, 12.2f); path.lineTo(10.8f, 14.8f); path.lineTo(15.8f, 9.4f); canvas.drawPath(path, stroke)
      }
      "circle" -> canvas.drawCircle(12f, 12f, 8.6f, stroke)
      "circle.fill.check" -> {
        canvas.drawCircle(12f, 12f, 9.4f, fill)
        stroke.color = Theme.onAccent; stroke.strokeWidth = 2.2f
        path.moveTo(7.8f, 12.2f); path.lineTo(10.8f, 15.2f); path.lineTo(16.4f, 9.2f); canvas.drawPath(path, stroke)
      }
      "video" -> {
        canvas.drawRoundRect(3f, 6.4f, 15.6f, 17.6f, 2.6f, 2.6f, stroke)
        path.moveTo(15.6f, 10.6f); path.lineTo(21f, 7.6f); path.lineTo(21f, 16.4f); path.lineTo(15.6f, 13.4f); path.close()
        canvas.drawPath(path, stroke)
      }
      "arrow.up.right" -> {
        stroke.strokeWidth = 2.4f
        path.moveTo(7f, 17f); path.lineTo(17f, 7f); path.moveTo(9.4f, 7f); path.lineTo(17f, 7f); path.lineTo(17f, 14.6f); canvas.drawPath(path, stroke)
      }
      "arrow.down.left" -> {
        stroke.strokeWidth = 2.4f
        path.moveTo(17f, 7f); path.lineTo(7f, 17f); path.moveTo(7f, 9.4f); path.lineTo(7f, 17f); path.lineTo(14.6f, 17f); canvas.drawPath(path, stroke)
      }
      "nosign" -> { stroke.strokeWidth = 2.2f; canvas.drawCircle(12f, 12f, 7.6f, stroke); canvas.drawLine(6.6f, 6.6f, 17.4f, 17.4f, stroke) }
      "exclamation.circle" -> {
        stroke.strokeWidth = 2.2f; canvas.drawCircle(12f, 12f, 8f, stroke); canvas.drawLine(12f, 7.6f, 12f, 12.8f, stroke); canvas.drawCircle(12f, 16.2f, 1.2f, fill)
      }
      "cloud.down" -> {
        path.moveTo(7f, 17.4f); path.quadTo(3f, 17.4f, 3f, 13.6f); path.quadTo(3f, 10.2f, 6.6f, 9.8f); path.quadTo(7.8f, 5.4f, 12.2f, 5.4f)
        path.quadTo(16.8f, 5.4f, 17.6f, 9.8f); path.quadTo(21f, 10.4f, 21f, 13.8f); path.quadTo(21f, 17.4f, 17f, 17.4f)
        path.moveTo(12f, 11f); path.lineTo(12f, 20f); path.moveTo(9f, 17.2f); path.lineTo(12f, 20.2f); path.lineTo(15f, 17.2f)
        canvas.drawPath(path, stroke)
      }
      "slider" -> {
        for ((y, knob) in listOf(7f to 15f, 12f to 8f, 17f to 13f)) {
          canvas.drawLine(4f, y, 20f, y, stroke); canvas.drawCircle(knob, y, 2f, fill)
        }
      }
      "photo" -> {
        canvas.drawRoundRect(3.4f, 5f, 20.6f, 19f, 2.6f, 2.6f, stroke)
        canvas.drawCircle(8.6f, 9.6f, 1.6f, fill)
        path.moveTo(4f, 17.4f); path.lineTo(9.6f, 12.6f); path.lineTo(13f, 15.4f); path.lineTo(15.8f, 13.2f); path.lineTo(20f, 16.8f); canvas.drawPath(path, stroke)
      }
      "pencil" -> {
        path.moveTo(15.4f, 4.6f); path.lineTo(19.4f, 8.6f); path.lineTo(9f, 19f); path.lineTo(4.6f, 19.4f); path.lineTo(5f, 15f); path.close(); canvas.drawPath(path, stroke)
      }
      "arrow.down.circle" -> {
        canvas.drawCircle(12f, 12f, 8.6f, stroke)
        path.moveTo(12f, 7.6f); path.lineTo(12f, 16f); path.moveTo(8.6f, 12.8f); path.lineTo(12f, 16.2f); path.lineTo(15.4f, 12.8f); canvas.drawPath(path, stroke)
      }
      "checkmark" -> { stroke.strokeWidth = 2.4f; path.moveTo(5.6f, 12.4f); path.lineTo(10f, 16.8f); path.lineTo(18.6f, 7.6f); canvas.drawPath(path, stroke) }
      "archivebox.fill" -> {
        canvas.drawRoundRect(3.4f, 4.6f, 20.6f, 9f, 1.6f, 1.6f, fill)
        path.moveTo(5f, 9.8f); path.lineTo(19f, 9.8f); path.lineTo(19f, 18f); path.quadTo(19f, 19.6f, 17.4f, 19.6f); path.lineTo(6.6f, 19.6f); path.quadTo(5f, 19.6f, 5f, 18f); path.close()
        canvas.drawPath(path, fill)
        stroke.color = Theme.surface2; stroke.strokeWidth = 1.8f; canvas.drawLine(9.6f, 13f, 14.4f, 13f, stroke)
      }
      "bell.slash.fill" -> {
        path.moveTo(5f, 17f); path.cubicTo(6.6f, 15.4f, 6.8f, 13.6f, 6.8f, 10.6f); path.cubicTo(6.8f, 7.2f, 9f, 4.8f, 12f, 4.8f)
        path.cubicTo(15f, 4.8f, 17.2f, 7.2f, 17.2f, 10.6f); path.cubicTo(17.2f, 13.6f, 17.4f, 15.4f, 19f, 17f); path.close()
        canvas.drawPath(path, fill)
        box.set(9.8f, 17.4f, 14.2f, 21f); canvas.drawArc(box, 0f, 180f, true, fill)
        stroke.strokeWidth = 2.2f; canvas.drawLine(3.6f, 3.4f, 20.4f, 20.6f, stroke)
      }
    }
    canvas.restore()
  }
}

/** One of the pictures above as a view; with a click listener it is a button that dims under a finger. */
@SuppressLint("ViewConstructor")
class PlusIconView(context: Context, var symbol: String, private val size: Float, var color: Int) : View(context) {
  private val d = resources.displayMetrics.density
  override fun getAccessibilityClassName(): CharSequence = if (isClickable) "android.widget.Button" else "android.view.View"
  override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
  override fun setEnabled(enabled: Boolean) { super.setEnabled(enabled); alpha = if (enabled) 1f else 0.4f }
  override fun onDraw(canvas: Canvas) {
    PlusIcons.draw(canvas, symbol, width / 2f, height / 2f, size * d, if (isPressed) Theme.alpha(color, 0.5f) else color)
  }
}
