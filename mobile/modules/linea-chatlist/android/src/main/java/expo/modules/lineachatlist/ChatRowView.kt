package expo.modules.lineachatlist

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.View

/** One row, drawn on the canvas in a single pass (no child views): avatar, title, time, two lines of preview,
 *  unread badge, ticks and the «Изм.» circle. Layout of the texts is rebuilt only when the row or the width changes. */
class ChatRowView(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 16f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
  private val previewPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 15f * d }
  private val timePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f * d }
  private val badgePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); textAlign = Paint.Align.CENTER }
  private val avatarPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 21f * d; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); textAlign = Paint.Align.CENTER; color = 0xFFFFFFFF.toInt() }
  private val path = Path()

  private var row: ChatRow? = null
  private var palette = ChatPalette.DARK
  private var title: CharSequence = ""
  private var preview: StaticLayout? = null
  private var builtFor: ChatRow? = null
  private var builtWidth = 0

  fun bind(next: ChatRow, colors: ChatPalette) {
    if (row == next && palette == colors) return
    row = next; palette = colors; contentDescription = next.title + ". " + next.preview
    invalidate()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthSpec), (ROW_DP * d).toInt())
  }

  override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }

  private fun build(item: ChatRow, textWidth: Int, titleWidth: Float) {
    title = TextUtils.ellipsize(item.title, titlePaint, titleWidth.coerceAtLeast(0f), TextUtils.TruncateAt.END)
    val width = textWidth.coerceAtLeast(1)
    preview = StaticLayout.Builder.obtain(item.preview, 0, item.preview.length, previewPaint, width)
      .setAlignment(Layout.Alignment.ALIGN_NORMAL).setMaxLines(2).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).build()
    builtFor = item; builtWidth = this.width
  }

  override fun onDraw(canvas: Canvas) {
    val item = row ?: return
    val w = width.toFloat(); val h = height.toFloat()
    if (item.selected || isPressed) { fill.color = if (item.selected) palette.selected else palette.pressed; canvas.drawRect(0f, 0f, w, h, fill) }

    var x = 16f * d
    if (item.checked >= 0) {
      val cx = x + 12f * d; val cy = h / 2
      if (item.checked == 1) {
        fill.color = palette.accent; canvas.drawCircle(cx, cy, 11f * d, fill)
        stroke.color = palette.onAccent; stroke.strokeWidth = 2f * d
        path.reset(); path.moveTo(cx - 5f * d, cy); path.lineTo(cx - 1.5f * d, cy + 3.5f * d); path.lineTo(cx + 5f * d, cy - 3.5f * d); canvas.drawPath(path, stroke)
      } else { stroke.color = palette.subtle; stroke.strokeWidth = 1.6f * d; canvas.drawCircle(cx, cy, 10.5f * d, stroke) }
      x += 36f * d
    }

    val avatar = 60f * d
    fill.color = item.avatarColor; canvas.drawCircle(x + avatar / 2, h / 2, avatar / 2, fill)
    canvas.drawText(item.initials, x + avatar / 2, h / 2 - (avatarPaint.descent() + avatarPaint.ascent()) / 2, avatarPaint)
    x += avatar + 12f * d

    val right = w - 16f * d
    timePaint.color = if (item.unread > 0 && !item.muted) palette.accent else palette.muted
    val timeWidth = timePaint.measureText(item.time)
    val badge = if (item.unread > 0) (if (item.unread > 999) "999+" else item.unread.toString()) else ""
    val badgeWidth = if (badge.isEmpty()) 0f else maxOf(22f * d, badgePaint.measureText(badge) + 12f * d)
    val markWidth = if (badge.isEmpty() && item.ticks > 0) 22f * d else badgeWidth
    val titleWidth = right - x - timeWidth - 8f * d
    val textWidth = (right - x - (if (markWidth > 0f) markWidth + 8f * d else 0f)).toInt()
    if (builtFor != item || builtWidth != width) build(item, textWidth, titleWidth)

    val top = 12f * d
    titlePaint.color = palette.text
    canvas.drawText(title, 0, title.length, x, top - titlePaint.ascent(), titlePaint)
    canvas.drawText(item.time, right - timeWidth, top - timePaint.ascent() + 1.5f * d, timePaint)

    previewPaint.color = if (item.accentPreview) palette.accent else palette.muted
    preview?.let { layout -> canvas.save(); canvas.translate(x, top + 23f * d); layout.draw(canvas); canvas.restore() }

    val markY = top + 23f * d + 11f * d
    if (badge.isNotEmpty()) {
      fill.color = if (item.muted) palette.badgeMuted else palette.accent
      canvas.drawRoundRect(right - badgeWidth, markY - 11f * d, right, markY + 11f * d, 11f * d, 11f * d, fill)
      badgePaint.color = if (item.muted) palette.text else palette.onAccent
      canvas.drawText(badge, right - badgeWidth / 2, markY - (badgePaint.descent() + badgePaint.ascent()) / 2, badgePaint)
    } else if (item.ticks > 0) {
      stroke.color = if (item.ticks == 2) palette.accent else palette.muted; stroke.strokeWidth = 1.8f * d
      val bx = right - 16f * d
      path.reset(); path.moveTo(bx, markY); path.lineTo(bx + 4f * d, markY + 4f * d); path.lineTo(bx + 12f * d, markY - 5f * d)
      if (item.ticks == 2) { path.moveTo(bx + 6f * d, markY + 2f * d); path.lineTo(bx + 8f * d, markY + 4f * d); path.lineTo(bx + 16f * d, markY - 5f * d) }
      canvas.drawPath(path, stroke)
    }

    fill.color = palette.border; canvas.drawRect(x, h - maxOf(1f, d / 2), w, h, fill)
  }

  companion object { const val ROW_DP = 76f }
}
