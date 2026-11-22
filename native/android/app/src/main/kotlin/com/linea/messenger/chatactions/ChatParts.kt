package com.linea.messenger.chatactions

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.InputFilter
import android.text.InputType
import android.text.TextPaint
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.design.Glass
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Icons
import com.linea.messenger.design.Symbols
import com.linea.messenger.design.Theme
import com.linea.messenger.people.PeopleIcons

// The small parts of a chat's screen that the actions on messages need: the field that grows with its text, the
// bar above it (an answer, an edit, a forward), the pinned message's bar, the way down, a short notice, and the
// two bars of the multi-select.

/** The small pictures of the actions (where the iPhone app uses the system's symbols), drawn as lines in a box
 *  of 24 units like the app's other pictures; the ones other parts of the app already draw are taken from them.
 *  Main thread only. */
object ChatIcons {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val box = RectF()
  private val own = setOf("pin", "pin.slash", "forward", "bell", "bell.slash", "archive", "person.2")
  private val fromPeople = mapOf("xmark" to "cross", "bubble" to "bubble", "bubble.fill" to "bubble.fill", "search" to "search", "check.fill" to "radio.on", "pencil" to "compose")

  /** Draws `name` in a square of `size` px with its centre at (cx, cy). */
  fun draw(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    // "ion:<name>": the reference's own Ionicons glyph (design/IonIcon.kt).
    if (name.startsWith("ion:")) return com.linea.messenger.design.IonIcon.draw(canvas, name.substring(4), cx, cy, size, color)
    fromPeople[name]?.let { return PeopleIcons.draw(canvas, it, cx, cy, size, color) }
    if (name == "send") return Icons.draw(canvas, name, cx, cy, size, color)
    // «Ответить» is the arrow that turns back to the left (channels/ChannelIcons.kt, through Symbols).
    if (name == "reply") return Symbols.draw(canvas, "answer", cx, cy, size, color)
    if (name !in own) return Symbols.draw(canvas, name, cx, cy, size, color)
    stroke.color = color; fill.color = color; stroke.strokeWidth = 1.8f
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    path.reset()
    when (name) {
      "pin", "pin.slash" -> {
        // A pin: its head, its plate, its needle.
        path.moveTo(9f, 3.6f); path.lineTo(15f, 3.6f); path.lineTo(14.2f, 10f); path.lineTo(17.4f, 13.6f); path.lineTo(6.6f, 13.6f); path.lineTo(9.8f, 10f); path.close()
        path.moveTo(12f, 13.8f); path.lineTo(12f, 20.6f)
        canvas.drawPath(path, stroke)
        if (name == "pin.slash") canvas.drawLine(4.4f, 3.6f, 19.6f, 20.4f, stroke)
      }
      "forward" -> {
        // An arrow that turns on to the right.
        path.moveTo(14.6f, 5.6f); path.lineTo(20f, 11f); path.lineTo(14.6f, 16.4f)
        path.moveTo(19.6f, 11f); path.lineTo(11f, 11f); path.quadTo(4f, 11f, 4f, 18.6f)
        canvas.drawPath(path, stroke)
      }
      "bell", "bell.slash" -> {
        path.moveTo(5f, 17f); path.cubicTo(6.6f, 15.4f, 6.8f, 13.6f, 6.8f, 10.6f); path.cubicTo(6.8f, 7.2f, 9f, 4.8f, 12f, 4.8f)
        path.cubicTo(15f, 4.8f, 17.2f, 7.2f, 17.2f, 10.6f); path.cubicTo(17.2f, 13.6f, 17.4f, 15.4f, 19f, 17f); path.close()
        canvas.drawPath(path, stroke)
        box.set(9.8f, 16.4f, 14.2f, 20.6f); canvas.drawArc(box, 0f, 180f, false, stroke)
        if (name == "bell.slash") canvas.drawLine(4.4f, 3.6f, 19.6f, 20.4f, stroke)
      }
      "archive" -> {
        canvas.drawRoundRect(3.4f, 4.6f, 20.6f, 9f, 1.6f, 1.6f, stroke)
        path.moveTo(5f, 9.2f); path.lineTo(5f, 18f); path.quadTo(5f, 19.6f, 6.6f, 19.6f); path.lineTo(17.4f, 19.6f); path.quadTo(19f, 19.6f, 19f, 18f); path.lineTo(19f, 9.2f)
        path.moveTo(9.6f, 12.8f); path.lineTo(14.4f, 12.8f)
        canvas.drawPath(path, stroke)
      }
      "person.2" -> {
        canvas.drawCircle(9f, 8.4f, 3.2f, stroke)
        path.moveTo(2.8f, 19.4f); path.cubicTo(2.8f, 15.6f, 5.6f, 13.8f, 9f, 13.8f); path.cubicTo(12.4f, 13.8f, 15.2f, 15.6f, 15.2f, 19.4f)
        canvas.drawPath(path, stroke)
        box.set(13.6f, 5.2f, 19.6f, 11.4f); canvas.drawArc(box, -90f, 180f, false, stroke)
        path.reset(); path.moveTo(17.4f, 14.2f); path.cubicTo(19.8f, 14.8f, 21.2f, 16.6f, 21.2f, 19.4f)
        canvas.drawPath(path, stroke)
      }
    }
    canvas.restore()
  }
}

/** One of the pictures above as a view; with a `contentDescription` and a click listener it is a button that
 *  dims under a finger and while it cannot be pressed. */
@SuppressLint("ViewConstructor")
class ChatIconView(context: Context, var symbol: String, private val size: Float, var color: Int) : View(context) {
  private val d = resources.displayMetrics.density
  override fun getAccessibilityClassName(): CharSequence = if (isClickable) "android.widget.Button" else "android.view.View"
  override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
  override fun setEnabled(enabled: Boolean) { super.setEnabled(enabled); alpha = if (enabled) 1f else 0.4f }
  override fun onDraw(canvas: Canvas) {
    ChatIcons.draw(canvas, symbol, width / 2f, height / 2f, size * d, if (isPressed) Theme.alpha(color, 0.5f) else color)
  }
}

/** The field a message is written in: several lines, growing with the text up to a height and scrolling past it
 *  (the reference's composer: one line at first, at most 136 pt of text). */
class ComposerField(context: Context) : EditText(context) {
  /** Composer: the selection moved (the formatting bar shows over a selection; composer/ComposerExtras.kt). */
  var onSelection: (() -> Unit)? = null
  override fun onSelectionChanged(selStart: Int, selEnd: Int) { super.onSelectionChanged(selStart, selEnd); onSelection?.invoke() }
  private val d = resources.displayMetrics.density
  /** The text is being put in by the app, not typed: nobody is told. */
  var quiet = false
    private set

  init {
    hint = "Сообщение"
    setHintTextColor(Theme.muted)
    setTextColor(Theme.text)
    textSize = 17f
    background = null
    includeFontPadding = false
    setPadding(0, Math.round(10f * d), 0, Math.round(9f * d)) // Composer: 17 dp text in a 40 dp pill
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    isSingleLine = false
    maxLines = Int.MAX_VALUE
    setHorizontallyScrolling(false)
    imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
    gravity = Gravity.TOP or Gravity.START
    isVerticalScrollBarEnabled = false
    // A message holds at most 8000 UTF-16 units, as the server and the other phone expect.
    filters = arrayOf(InputFilter.LengthFilter(MAX_UNITS))
    contentDescription = "Сообщение"
  }

  /** Puts a text in without telling the watchers that somebody typed (a draft, a message being edited). */
  fun put(text: String) {
    quiet = true
    setText(text)
    setSelection(length())
    quiet = false
  }

  /** The height the field asks for at this width, px: its text, within the two limits. */
  fun wantedHeight(width: Int): Int {
    measure(MeasureSpec.makeMeasureSpec(width.coerceAtLeast(1), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    return measuredHeight.coerceIn(Math.round(lowest * d), Math.round(highest * d))
  }

  companion object {
    // Composer: the reference's field — at least 40 dp, at most 140 (ChatScreen.tsx `minHeight 40, maxHeight 140`).
    const val lowest = 40f
    const val highest = 140f
    const val MAX_UNITS = 8000
  }
}

/** The send button: the arrow, or a tick while a message is being edited (greyed over an empty field). */
class SendButton(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  var editing = false
    set(value) { if (field != value) { field = value; invalidate() } }

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "Отправить"
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
  override fun setEnabled(enabled: Boolean) { super.setEnabled(enabled); alpha = if (enabled) 1f else 0.4f }
  private val disc = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
  private val line = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
    style = android.graphics.Paint.Style.STROKE; strokeCap = android.graphics.Paint.Cap.ROUND; strokeJoin = android.graphics.Paint.Join.ROUND
  }
  private val mark = android.graphics.Path()

  /** Composer: the arrow (a tick while editing) on an accent circle of the button's size (ChatScreen.tsx). */
  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f; val cy = height / 2f
    disc.color = if (isPressed) Theme.alpha(Theme.accent, 0.8f) else Theme.accent
    canvas.drawCircle(cx, cy, minOf(width, height) / 2f, disc)
    // <Icon name={editing ? 'checkmark' : 'arrow-up'} color={t.onAccent} size={25}>
    com.linea.messenger.design.IonIcon.draw(canvas, if (editing) "checkmark" else "arrow-up", cx, cy, 25f * d, Theme.onAccent)
    if (com.linea.messenger.design.IonIcon.has("arrow-up")) return
    line.color = Theme.onAccent; line.strokeWidth = 2.4f * d
    mark.reset()
    if (editing) {
      mark.moveTo(cx - 6.5f * d, cy + 0.5f * d); mark.lineTo(cx - 2f * d, cy + 5f * d); mark.lineTo(cx + 7f * d, cy - 5f * d)
    } else {
      mark.moveTo(cx, cy + 7.5f * d); mark.lineTo(cx, cy - 7f * d)
      mark.moveTo(cx - 6.5f * d, cy - 0.5f * d); mark.lineTo(cx, cy - 7f * d); mark.lineTo(cx + 6.5f * d, cy - 0.5f * d)
    }
    canvas.drawPath(mark, line)
  }
}

/** A plate of glass with child views on it (the bars of this file). */
@SuppressLint("ViewConstructor")
open class GlassBar(context: Context, private val radius: Float) : ViewGroup(context) {
  protected val d: Float = resources.displayMetrics.density
  private val glass = Glass(this)
  /** The page behind the bar (blurred under it where the phone can). */
  var behind: GlassSource?
    get() = glass.source
    set(value) { glass.source = value }

  init { setWillNotDraw(false) }

  protected fun dp(value: Float): Int = Math.round(value * d)
  protected fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }
  protected fun line(size: Float, color: Int, weight: Int = 400): TextView = TextView(context).apply {
    textSize = size; setTextColor(color); typeface = Theme.weight(weight); maxLines = 1; ellipsize = TextUtils.TruncateAt.END; includeFontPadding = false; gravity = Gravity.CENTER_VERTICAL
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}
  override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), minOf(radius * d, height / 2f))
}

/** The bar above the field: «Ответ …», «Редактирование» or «Переслать сообщение», with the line it is about and
 *  a cross that calls it off. */
class ComposerBar(context: Context) : GlassBar(context, 22f) {
  private val mark = ChatIconView(context, "reply", 18f, Theme.accent)
  private val stripe = View(context).apply { background = GradientDrawable().apply { setColor(Theme.accent); cornerRadius = 1.5f * d } }
  private val headingLabel = line(12f, Theme.accent, 700)
  private val wordsLabel = line(13f, Theme.muted)
  private val closeButton = ChatIconView(context, "xmark", 14f, Theme.muted).apply { isClickable = true; isFocusable = true }
  var onClose: (() -> Unit)? = null

  init {
    addView(mark); addView(stripe); addView(headingLabel); addView(wordsLabel); addView(closeButton)
    closeButton.setOnClickListener { onClose?.invoke() }
  }

  fun show(symbol: String, heading: String, words: String, closeWords: String) {
    mark.symbol = symbol; mark.invalidate()
    headingLabel.text = heading
    wordsLabel.text = words
    closeButton.contentDescription = closeWords
  }

  /** What the bar says now (for the checks). */
  val heading: String get() = headingLabel.text.toString()
  val words: String get() = wordsLabel.text.toString()

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left; val height = bottom - top
    put(mark, dp(10f), 0, dp(28f), height)
    put(stripe, dp(44f), dp(9f), dp(3f), height - dp(18f))
    put(headingLabel, dp(56f), dp(8f), width - dp(56f) - dp(44f), dp(16f))
    put(wordsLabel, dp(56f), dp(25f), width - dp(56f) - dp(44f), dp(17f))
    put(closeButton, width - dp(44f), (height - dp(44f)) / 2, dp(44f), dp(44f))
  }

  companion object { const val height = 50f }
}

/** The pinned message under the header: «Закреплённое сообщение» over its first line; a touch goes to the
 *  message, the cross unpins it. */
class PinnedBar(context: Context) : GlassBar(context, 26f) {
  private val stripe = View(context).apply { background = GradientDrawable().apply { setColor(Theme.alpha(Theme.text, 0.9f)); cornerRadius = 1.25f * d } }
  private val headingLabel = line(15f, Theme.text, 500).apply { text = "Закреплённое сообщение" }
  private val wordsLabel = line(15f, Theme.muted)
  private val openButton = View(context).apply { isClickable = true; isFocusable = true; contentDescription = "Перейти к закреплённому сообщению" }
  private val unpinButton = ChatIconView(context, "ion:close", 22f, Theme.muted).apply { isClickable = true; isFocusable = true; contentDescription = "Открепить" }
  var onOpen: (() -> Unit)? = null
  var onUnpin: (() -> Unit)? = null

  init {
    addView(stripe); addView(headingLabel); addView(wordsLabel); addView(openButton); addView(unpinButton)
    openButton.setOnClickListener { onOpen?.invoke() }
    unpinButton.setOnClickListener { onUnpin?.invoke() }
  }

  fun show(words: String) { wordsLabel.text = words }
  val words: String get() = wordsLabel.text.toString()

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left; val height = bottom - top
    // ChatScreen.tsx: padding 16, the 2.5 × 34 line, 12 to the words; two 15-point lines 1 apart, centred.
    put(stripe, dp(16f), (height - dp(34f)) / 2, Math.round(2.5f * d), dp(34f))
    headingLabel.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val line = headingLabel.measuredHeight.coerceAtLeast(1)
    val top = (height - 2 * line - dp(1f)) / 2
    put(headingLabel, Math.round(30.5f * d), top, width - Math.round(30.5f * d) - dp(50f), line)
    put(wordsLabel, Math.round(30.5f * d), top + line + dp(1f), width - Math.round(30.5f * d) - dp(50f), line)
    put(openButton, 0, 0, width - dp(50f), height)
    put(unpinButton, width - dp(50f), dp(6f), dp(44f), dp(44f))
  }

  companion object { const val height = 56f }
}

/** The round button that takes the list down to its newest message, with the number of messages that came
 *  while it was scrolled away. */
class DownButton(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val glass = Glass(this)
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val badgeText = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d; typeface = Theme.weight(700); textAlign = Paint.Align.CENTER; color = Theme.onAccent }
  private var count = 0
  var behind: GlassSource?
    get() = glass.source
    set(value) { glass.source = value }
  var onPress: (() -> Unit)? = null

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "Вниз к новым сообщениям"
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }

  /** `count`: how many new messages wait below; 0 hides the number. */
  fun show(count: Int) {
    if (this.count == count) return
    this.count = count
    contentDescription = if (count > 0) "Вниз к новым сообщениям, новых: $count" else "Вниз к новым сообщениям"
    invalidate()
  }

  /** The number on the button now ('' when there is none). */
  val badge: String get() = badgeWords(count)

  override fun onDraw(canvas: Canvas) {
    // The view is taller than the disc by the badge that stands over its upper edge.
    val over = height - side * d
    glass.draw(canvas, 0f, over, width.toFloat(), height.toFloat(), side * d / 2)
    // ChatScreen.tsx: <Icon name="chevron-down" size={26} color={t.text}>; the reference's button shows no count.
    ChatIcons.draw(canvas, "ion:chevron-down", width / 2f, over + side * d / 2, 26f * d, if (isPressed) Theme.alpha(Theme.text, 0.5f) else Theme.text)
    val words = ""
    if (words.isEmpty()) return
    val wide = maxOf(18f * d, badgeText.measureText(words) + 10f * d)
    fill.color = Theme.accent
    canvas.drawRoundRect(width / 2f - wide / 2, 0f, width / 2f + wide / 2, 18f * d, 9f * d, 9f * d, fill)
    canvas.drawText(words, width / 2f, 9f * d - (badgeText.ascent() + badgeText.descent()) / 2, badgeText)
  }

  companion object {
    const val side = 40f
    /** The room the badge takes above the disc, dp. */
    const val over = 9f
    fun badgeWords(count: Int): String = if (count <= 0) "" else if (count > 99) "99+" else count.toString()
  }
}

/** A short line under the header («Скопировано», «Сообщение удалено») that goes away by itself; one that stays
 *  («Действие не отправлено · повторить») until it is touched. */
class ChatNotice(context: Context) : TextView(context) {
  private val d = resources.displayMetrics.density
  private val hiding = Runnable { hide() }
  var onPress: (() -> Unit)? = null
  /** The notice appeared or went away: the screen places its parts again. */
  var onChange: (() -> Unit)? = null

  init {
    textSize = 13f
    gravity = Gravity.CENTER
    maxLines = 2
    ellipsize = TextUtils.TruncateAt.END
    includeFontPadding = false
    setPadding(Math.round(14f * d), Math.round(7f * d), Math.round(14f * d), Math.round(7f * d))
    visibility = GONE
    setOnClickListener { val press = onPress; if (press != null) press() else hide() }
    look(false)
  }

  private fun look(danger: Boolean) {
    setTextColor(if (danger) Theme.danger else Theme.text)
    background = GradientDrawable().apply {
      setColor(Theme.surface2); cornerRadius = 16f * d
      setStroke(maxOf(1, Math.round(d)), if (danger) Theme.alpha(Theme.danger, 0.6f) else Theme.veil(0.1f))
    }
  }

  val words: String get() = text.toString()

  /** Shows the words; with `stay` they remain until `hide()`. */
  fun show(words: String, danger: Boolean = false, stay: Boolean = false) {
    removeCallbacks(hiding)
    text = words
    look(danger)
    visibility = VISIBLE
    onChange?.invoke()
    if (!stay) postDelayed(hiding, 2200)
  }

  fun hide() {
    removeCallbacks(hiding)
    if (visibility == GONE) return
    visibility = GONE
    onChange?.invoke()
  }
}

/** The header of the multi-select: «Отмена», «Выбрано: N» and copying what is chosen. */
class SelectionHeader(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private val cancelButton = TextView(context).apply {
    text = "Отмена"; textSize = 16f; typeface = Theme.weight(600); setTextColor(Theme.accent); gravity = Gravity.CENTER_VERTICAL or Gravity.START; isClickable = true; isFocusable = true
  }
  private val countLabel = TextView(context).apply { textSize = 16f; typeface = Theme.weight(700); setTextColor(Theme.text); gravity = Gravity.CENTER; maxLines = 1 }
  private val copyButton = ChatIconView(context, "copy", 20f, Theme.accent).apply { isClickable = true; isFocusable = true; contentDescription = "Скопировать выбранные" }
  var onCancel: (() -> Unit)? = null
  var onCopy: (() -> Unit)? = null

  init {
    addView(cancelButton); addView(countLabel); addView(copyButton)
    cancelButton.setOnClickListener { onCancel?.invoke() }
    copyButton.setOnClickListener { onCopy?.invoke() }
  }

  fun show(count: Int, canCopy: Boolean) {
    countLabel.text = "Выбрано: $count"
    copyButton.isEnabled = canCopy
  }

  val words: String get() = countLabel.text.toString()
  val canCopy: Boolean get() = copyButton.isEnabled

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left; val height = bottom - top
    fun put(view: View, x: Int, w: Int) {
      view.measure(MeasureSpec.makeMeasureSpec(w.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
      view.layout(x, 0, x + w.coerceAtLeast(0), height)
    }
    put(cancelButton, Math.round(12f * d), Math.round(84f * d))
    put(countLabel, Math.round(100f * d), width - Math.round(200f * d))
    put(copyButton, width - Math.round(56f * d), Math.round(44f * d))
  }
}

/** The bar of the multi-select, where the field usually is: «Переслать», «Поделиться», «Удалить». */
class SelectionBar(context: Context) : GlassBar(context, 28f) {
  private inner class Button(val index: Int, val symbol: String, val label: String, val danger: Boolean) : View(context) {
    private val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 10f * d; typeface = Theme.weight(600); textAlign = Paint.Align.CENTER }
    init { isClickable = true; isFocusable = true; contentDescription = label }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
    override fun onDraw(canvas: Canvas) {
      val ink = if (danger) Theme.danger else Theme.accent
      val color = if (isPressed) Theme.alpha(ink, 0.5f) else ink
      ChatIcons.draw(canvas, symbol, width / 2f, height / 2f - 8f * d, 20f * d, color)
      text.color = color
      canvas.drawText(label, width / 2f, height / 2f + 17f * d, text)
    }
  }

  private val buttons = listOf(Button(0, "forward", "Переслать", false), Button(1, "share", "Поделиться", false), Button(2, "trash", "Удалить", true))
  var onForward: (() -> Unit)? = null
  var onShare: (() -> Unit)? = null
  var onDelete: (() -> Unit)? = null

  init {
    for (button in buttons) {
      addView(button)
      button.setOnClickListener { when (button.index) { 0 -> onForward?.invoke(); 1 -> onShare?.invoke(); else -> onDelete?.invoke() } }
    }
  }

  /** `export`: something chosen may leave the chat (not when copying is forbidden); `chosen`: something is chosen. */
  fun show(export: Boolean, chosen: Boolean) {
    for (button in buttons) {
      val on = if (button.index == 2) chosen else export
      button.isEnabled = on
      button.alpha = if (on) 1f else 0.35f
    }
  }

  /** Which of the three can be pressed now (for the checks). */
  val enabled: List<Boolean> get() = buttons.map { it.isEnabled }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val each = (right - left) / buttons.size
    buttons.forEachIndexed { index, button -> put(button, index * each, 0, each, bottom - top) }
  }

  companion object { const val height = 60f }
}

/** A sheet of a few choices, each with a line of explanation under it — «Выключить звук», «Удалить чат?», what
 *  can be done with a chat. A choice closes the sheet and is then carried out. */
class ChoiceSheet(context: Context, val heading: String, val note: String = "", val choices: List<Choice>) : Dialog(context) {
  /** `selected`: one of several (the reference's `SheetAction selected`) — no chevron; null: an action. */
  class Choice(val symbol: String, val label: String, val note: String = "", val danger: Boolean = false, val selected: Boolean? = null, val run: () -> Unit)

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val stack = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(8f), dp(30f), dp(8f), dp(24f))
      background = GradientDrawable().apply { setColor(Theme.page(0xFF141516.toInt())); cornerRadii = floatArrayOf(28f * d, 28f * d, 28f * d, 28f * d, 0f, 0f, 0f, 0f) }
    }
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    stack.addView(TextView(context).apply {
      text = heading; textSize = 20f; typeface = Theme.weight(700); setTextColor(Theme.text); maxLines = 1; ellipsize = TextUtils.TruncateAt.END
      com.linea.messenger.design.Titles.title(this, Theme.TypeSize.sheetTitle) // Fonts: a sheet's heading
    }, LinearLayout.LayoutParams(wide, wrap).apply { leftMargin = dp(12f); rightMargin = dp(12f); bottomMargin = dp(6f) })
    if (note.isNotEmpty()) stack.addView(TextView(context).apply {
      text = note; textSize = 13f; setTextColor(Theme.muted); maxLines = 2; ellipsize = TextUtils.TruncateAt.END
    }, LinearLayout.LayoutParams(wide, wrap).apply { leftMargin = dp(12f); rightMargin = dp(12f); bottomMargin = dp(8f) })
    for (choice in choices) stack.addView(row(choice), LinearLayout.LayoutParams(wide, wrap))
    val scroll = ScrollView(context).apply { addView(stack); isVerticalScrollBarEnabled = false }
    setContentView(scroll, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
    }
    setCanceledOnTouchOutside(true)
  }

  /** One choice — the reference's `SheetAction` (components.tsx): a 46 tile of clear glass (radius 16) holding the
   *  Ionicons glyph 22 in the accent (`danger` for a dangerous one), 14 to the words (the label 16 SemiBold, the note 12,
   *  line 18, 5 under it in `muted`), a chevron-forward 18 in `subtle` unless it is one of several; 13 above and below,
   *  10 at the sides, at least 76 (60 for one of several), radius 19, `surface2` under the finger. */
  private fun row(choice: Choice): View {
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = dp(if (choice.selected != null) 60f else 76f)
      setPadding(dp(10f), dp(13f), dp(10f), dp(13f))
      isClickable = true
      isFocusable = true
      isSelected = choice.selected == true
      contentDescription = if (choice.note.isEmpty()) choice.label else choice.label + ". " + choice.note
      background = android.graphics.drawable.StateListDrawable().apply {
        addState(intArrayOf(android.R.attr.state_pressed), GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 19f * d })
      }
      setOnClickListener { chosen(choice) }
    }
    val tile = object : android.widget.FrameLayout(context) {
      private val glass = com.linea.messenger.design.Glass(this)
      init { setWillNotDraw(false) }
      override fun onDraw(canvas: android.graphics.Canvas) { glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 16f * d); super.onDraw(canvas) }
    }
    tile.addView(ChatIconView(context, choice.symbol, 22f, if (choice.danger) Theme.danger else Theme.accent), android.widget.FrameLayout.LayoutParams(dp(22f), dp(22f), Gravity.CENTER))
    row.addView(tile, LinearLayout.LayoutParams(dp(46f), dp(46f)).apply { rightMargin = dp(14f) })
    val words = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    words.addView(TextView(context).apply { text = choice.label; textSize = 16f; typeface = Theme.weight(600); setTextColor(if (choice.danger) Theme.danger else Theme.text) })
    if (choice.note.isNotEmpty()) words.addView(TextView(context).apply {
      text = choice.note; textSize = 12f; setTextColor(Theme.muted); maxLines = 3
      if (android.os.Build.VERSION.SDK_INT >= 28) lineHeight = dp(18f)
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(5f) })
    row.addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    if (choice.selected == null) row.addView(ChatIconView(context, "ion:chevron-forward", 18f, Theme.subtle), LinearLayout.LayoutParams(dp(18f), dp(18f)).apply { leftMargin = dp(14f) })
    return row
  }

  private fun chosen(choice: Choice) {
    dismiss()
    choice.run()
  }

  companion object {
    /** The sheet on the screen now, if any (for the checks). */
    var last: java.lang.ref.WeakReference<ChoiceSheet>? = null
  }

  override fun show() {
    last = java.lang.ref.WeakReference(this)
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }
}
