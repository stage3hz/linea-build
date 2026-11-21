package com.linea.messenger.chatactions

import android.app.Dialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.TextPaint
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.TextView
import com.linea.messenger.design.Glass
import com.linea.messenger.design.Theme
import com.linea.messenger.design.edges

/** The reactions a message can get — the reference's set, in its order (messageMeta.ts `REACTIONS`; the core
 *  refuses any other). The first seven are the quick row of the menu. */
object MessageReactions {
  val all: List<String> = listOf("👍", "❤️", "😂", "😮", "😢", "🔥", "👎", "🎉", "🙏", "👏", "🤔", "💯", "😍", "🥰", "😁", "🤣", "😎", "🤯", "😱", "🤬", "🥺", "😭", "🤡", "💩", "👀", "💀", "🫡", "🤝", "✍️", "🙈", "😴", "🤗", "🍾", "💔", "⚡", "🏆", "🥶", "😈", "🫶", "✅", "❌", "👌")
  const val quick = 7
}

/** The menu of one message: the quick reactions, the message's own words, and what can be done with it.
 *  It stands over the chat, next to the message it was opened for; a touch beside it puts it away. */
class MessageMenu(
  context: Context,
  /** Where on the screen the message was touched, px. */
  private val anchorY: Float,
  /** The menu stands at the sender's edge. */
  private val mine: Boolean,
  private val preview: String,
  /** Each reaction, and whether it is the person's own one on this message. */
  private val reactions: List<Pair<String, Boolean>>,
  items: List<Item>,
) : Dialog(context, android.R.style.Theme_Translucent_NoTitleBar) {
  class Item(
    val symbol: String, val label: String, val danger: Boolean = false,
    /** A little room above the item (the reference's «separated»). */
    val separated: Boolean = false,
    /** The item changes the menu itself instead of closing it («Удалить» → for whom). */
    val stays: Boolean = false,
    val run: () -> Unit,
  )

  var items: List<Item> = items
    private set
  /** A reaction was chosen (the menu is already closed). */
  var onReact: ((String) -> Unit)? = null

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var allShown = false
  private var pillHidden = reactions.isEmpty()

  /** One line of the menu. */
  private inner class Row(val item: Item) : View(context) {
    private val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 16f * d }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Theme.veil(0.1f) }
    init { isClickable = true; isFocusable = true; contentDescription = item.label }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
    override fun onDraw(canvas: Canvas) {
      if (isPressed) canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), fill)
      val ink = if (item.danger) Theme.danger else Theme.text
      ChatIcons.draw(canvas, item.symbol, 26f * d, height / 2f, 19f * d, ink)
      text.color = ink
      val shown = TextUtils.ellipsize(item.label, text, width - 60f * d, TextUtils.TruncateAt.END)
      canvas.drawText(shown, 0, shown.length, 48f * d, height / 2f - (text.ascent() + text.descent()) / 2, text)
    }
  }

  /** A plate of glass that clips its children to its round corners. */
  private inner class Plate(private val radius: Float) : ViewGroup(context) {
    private val glass = Glass(this)
    init { setWillNotDraw(false); clipToOutline = true; outlineProvider = object : android.view.ViewOutlineProvider() {
      override fun getOutline(view: View, outline: android.graphics.Outline) = outline.setRoundRect(0, 0, view.width, view.height, radius * d)
    } }
    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}
    override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), radius * d)
  }

  private val pill = Plate(24f)
  private val panel = Plate(22f)
  private val reactionButtons = ArrayList<TextView>()
  private val moreButton = ChatIconView(context, "chevron.down", 16f, Theme.muted).apply { isClickable = true; isFocusable = true; contentDescription = "Все реакции" }
  private val bubble = TextView(context).apply {
    text = preview
    textSize = 17f
    setTextColor(Theme.text)
    maxLines = 6
    ellipsize = TextUtils.TruncateAt.END
    setPadding(dp(12f), dp(7f), dp(12f), dp(7f))
    background = GradientDrawable().apply { setColor(Theme.panel(0xFF1F2023.toInt())); cornerRadius = 18f * d }
  }
  private var rowViews: List<Row> = emptyList()

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  private val page = object : ViewGroup(context) {
    private var safeTop = 0
    private var safeBottom = 0
    private val here = IntArray(2)

    init {
      // A touch beside the menu puts it away.
      isClickable = true
      contentDescription = "Закрыть меню"
      setOnClickListener { dismiss() }
    }

    override fun onApplyWindowInsets(insets: android.view.WindowInsets): android.view.WindowInsets {
      val edges = insets.edges()
      if (edges.top != safeTop || edges.bottom != safeBottom) { safeTop = edges.top; safeBottom = edges.bottom; requestLayout() }
      return insets
    }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
      val width = right - left; val height = bottom - top
      val column = minOf(dp(340f), width - dp(24f))
      val panelWidth = minOf(dp(250f), column)

      var pillW = 0; var pillH = 0
      pill.visibility = if (pillHidden) GONE else VISIBLE
      if (!pillHidden) {
        if (allShown) {
          val cell = (column - dp(16f)) / 7f
          val line = minOf(cell, 44f * d)
          val lines = (reactions.size + 6) / 7
          pillW = column; pillH = Math.round(lines * line) + dp(16f)
          reactionButtons.forEachIndexed { index, button ->
            val x = 8f * d + (index % 7) * cell + (cell - 40f * d) / 2
            val y = 8f * d + (index / 7) * line + (line - 40f * d) / 2
            button.visibility = VISIBLE
            put(button, Math.round(x), Math.round(y), dp(40f), dp(40f))
          }
          moreButton.visibility = GONE
        } else {
          val quick = minOf(MessageReactions.quick, reactions.size)
          val more = if (reactions.size > quick) dp(30f) else 0
          pillW = quick * dp(40f) + more + dp(8f); pillH = dp(48f)
          reactionButtons.forEachIndexed { index, button ->
            button.visibility = if (index >= quick) GONE else VISIBLE
            put(button, dp(4f) + index * dp(40f), dp(4f), dp(40f), dp(40f))
          }
          moreButton.visibility = if (more == 0) GONE else VISIBLE
          put(moreButton, dp(4f) + quick * dp(40f), dp(4f), dp(30f), dp(40f))
        }
      }
      var bubbleW = 0; var bubbleH = 0
      bubble.visibility = if (preview.isEmpty()) GONE else VISIBLE
      if (preview.isNotEmpty()) {
        val widest = minOf(column.toFloat(), (width - 18f * d) * 0.85f).toInt()
        bubble.measure(MeasureSpec.makeMeasureSpec(widest.coerceAtLeast(1), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        bubbleW = bubble.measuredWidth; bubbleH = bubble.measuredHeight
      }
      var panelHeight = 0
      rowViews.forEachIndexed { index, row ->
        if (row.item.separated && index > 0) panelHeight += dp(8f)
        put(row, 0, panelHeight, panelWidth, dp(46f))
        panelHeight += dp(46f)
      }

      var total = panelHeight
      if (pillH > 0) total += pillH + dp(8f)
      if (bubbleH > 0) total += bubbleH + dp(8f)
      getLocationOnScreen(here)
      val highest = safeTop + dp(8f)
      val lowest = height - safeBottom - dp(8f) - total
      var y = maxOf(highest, minOf(Math.round(anchorY) - here[1] - dp(70f), lowest))
      fun placed(view: View, w: Int, h: Int) {
        val x = if (mine) width - dp(9f) - w else dp(9f)
        put(view, x, y, w, h)
      }
      if (pillH > 0) { placed(pill, pillW, pillH); y += pillH + dp(8f) }
      if (bubbleH > 0) { placed(bubble, bubbleW, bubbleH); y += bubbleH + dp(8f) }
      placed(panel, panelWidth, panelHeight)
    }
  }

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    reactions.forEach { (emoji, chosen) ->
      val button = TextView(context).apply {
        text = emoji
        textSize = 23f
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        includeFontPadding = false
        isClickable = true
        isFocusable = true
        contentDescription = "Реакция $emoji"
        isSelected = chosen
        if (chosen) background = GradientDrawable().apply { setColor(Theme.veil(0.16f)); cornerRadius = 20f * d }
        setOnClickListener { dismiss(); onReact?.invoke(emoji) }
      }
      pill.addView(button)
      reactionButtons.add(button)
    }
    moreButton.setOnClickListener { allShown = true; page.requestLayout() }
    pill.addView(moreButton)
    // The message's own words are only shown: a touch on them closes the menu like one beside it.
    page.addView(pill); page.addView(bubble); page.addView(panel)
    buildRows()
    setContentView(page, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.let { window ->
      window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      // The thin veil behind the menu: dark on a dark theme; on a light one the page stays light (Theme.thinBlur on iOS).
      window.setDimAmount(if (Theme.dark) 0.5f else 0.18f)
      if (Build.VERSION.SDK_INT >= 31) Blur.behind(window, Math.round(18f * d))
      if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
      window.setWindowAnimations(android.R.style.Animation_Dialog)
    }
    setCanceledOnTouchOutside(true)
  }

  @android.annotation.TargetApi(31)
  private object Blur {
    fun behind(window: Window, radius: Int) {
      window.addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
      window.attributes = window.attributes.apply { blurBehindRadius = radius }
    }
  }

  private fun buildRows() {
    for (row in rowViews) panel.removeView(row)
    rowViews = items.map { item ->
      Row(item).also { row ->
        row.setOnClickListener { chosen(item) }
        panel.addView(row)
      }
    }
    page.requestLayout()
  }

  /** Puts other items into the open menu («Удалить» asks for whom); the reactions go away. */
  fun replace(next: List<Item>) {
    items = next
    pillHidden = true
    buildRows()
  }

  private fun chosen(item: Item) {
    if (item.stays) { item.run(); return }
    dismiss()
    item.run()
  }

  /** Whether the row of reactions is shown (for the checks). */
  val showsReactions: Boolean get() = !pillHidden

  override fun show() {
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }
}
