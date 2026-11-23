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
/** The reference's Ionicons for the menu's items (ChatScreen.tsx MenuItem icons), by the names the items carry. */
private val ION = mapOf(
  "reply" to "arrow-undo-outline", "copy" to "copy-outline", "square.and.arrow.down" to "download-outline", "pin" to "pin-outline",
  "pin.slash" to "pin", "forward" to "arrow-redo-outline", "pencil" to "create-outline", "refresh" to "refresh-outline",
  "trash" to "trash-outline", "check.circle" to "checkmark-circle-outline", "eye.slash" to "eye-off-outline", "bookmark" to "bookmark-outline",
)

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
    // ContextMenu.tsx MenuItem: 15.5-point words, pressed white 0.08 on dark / black 0.05 on light.
    private val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 15.5f * d; typeface = Theme.weight(400) }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = if (Theme.dark) 0x14FFFFFF else 0x0D000000 }
    /** «separated»: a 6-point band above the item (black 0.22 on dark, 0.05 on light). */
    var band = 0f
    init { isClickable = true; isFocusable = true; contentDescription = item.label }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
    override fun onDraw(canvas: Canvas) {
      if (band > 0f) { fill.color = if (Theme.dark) 0x38000000 else 0x0D000000; canvas.drawRect(0f, 0f, width.toFloat(), band, fill) }
      fill.color = if (Theme.dark) 0x14FFFFFF else 0x0D000000
      if (isPressed) canvas.drawRect(0f, band, width.toFloat(), height.toFloat(), fill)
      val ink = if (item.danger) Theme.danger else Theme.text
      val middle = band + (height - band) / 2f
      // padding 16, <Icon size={19}> (the reference's Ionicons), 13 to the words.
      ChatIcons.draw(canvas, ION[item.symbol]?.let { "ion:$it" } ?: item.symbol, 16f * d + 9.5f * d, middle, 19f * d, ink)
      text.color = ink
      val shown = TextUtils.ellipsize(item.label, text, width - 64f * d, TextUtils.TruncateAt.END)
      canvas.drawText(shown, 0, shown.length, 48f * d, middle - (text.ascent() + text.descent()) / 2, text)
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
    // ContextMenu.tsx on Android: an opaque plate — rgba(36,38,46,0.92) on dark, white 0.94 on light — with a
    // hairline border of white 0.14 / black 0.08.
    private val plate = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
      plate.style = Paint.Style.FILL; plate.color = if (Theme.dark) 0xEB24262E.toInt() else 0xF0FFFFFF.toInt()
      canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), radius * d, radius * d, plate)
      plate.style = Paint.Style.STROKE; plate.strokeWidth = 1f; plate.color = if (Theme.dark) 0x24FFFFFF else 0x14000000
      canvas.drawRoundRect(0.5f, 0.5f, width - 0.5f, height - 0.5f, radius * d, radius * d, plate)
    }
  }

  /** ChatScreen.tsx `peek`: the message's own row as it stands in the chat, shown full width above the menu. */
  private var peek: android.widget.ImageView? = null
  /** ContextMenu.tsx `peekTouch`: a hold on the copy selects its words — they lie over the picture, invisible, exactly
   *  where the row drew them (`words`: the laid-out text and its place). */
  private var peekWords: TextView? = null
  private var peekWordsAt: Pair<Float, Float> = Pair(0f, 0f)
  private var peekWordsSize: Pair<Int, Int> = Pair(0, 0)
  fun showPeek(picture: android.graphics.Bitmap?, words: Triple<android.text.StaticLayout, Float, Float>? = null) {
    if (picture == null) return
    if (words != null) {
      val laid = words.first
      val field = TextView(context).apply {
        // The row's own spans (line height, styles) stay; its colours go, so only the selection shows.
        val copy = android.text.SpannableString(laid.text)
        for (span in copy.getSpans(0, copy.length, android.text.style.ForegroundColorSpan::class.java)) copy.removeSpan(span)
        for (span in copy.getSpans(0, copy.length, android.text.style.BackgroundColorSpan::class.java)) copy.removeSpan(span)
        for (span in copy.getSpans(0, copy.length, android.text.style.LineBackgroundSpan::class.java)) copy.removeSpan(span)
        text = copy
        setTextColor(Color.TRANSPARENT)
        textSize = laid.paint.textSize / d
        typeface = laid.paint.typeface
        includeFontPadding = false
        setPadding(0, 0, 0, 0)
        setTextIsSelectable(true)
        highlightColor = Theme.alpha(Theme.accent, 0.35f)
      }
      peekWords = field
      peekWordsAt = Pair(words.second, words.third)
      peekWordsSize = Pair(laid.width, laid.height)
    }
    val view = android.widget.ImageView(context).apply { setImageBitmap(picture); scaleType = android.widget.ImageView.ScaleType.FIT_XY; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
    peek = view
    page.addView(view)
    peekWords?.let { page.addView(it) }
    bubble.visibility = View.GONE
    page.requestLayout()
  }

  /** ContextMenu.tsx ReadDateRow: «Прочитано …» over the items (40 tall, the 19-point checkmark-done, 12 to the words
   *  in 14, muted; a grey bar while it loads; a 7-point band under it); no row when the answer is null. */
  private var readRow: View? = null
  private var readWords: String? = null
  private var readLoading = true
  fun askReadDate(load: ((String?) -> Unit) -> Unit) {
    val row = object : View(context) {
      private val ink = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 14f * d; color = Theme.muted; typeface = Theme.weight(400) }
      private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
      override fun onDraw(canvas: Canvas) {
        ChatIcons.draw(canvas, "ion:checkmark-done", 14f * d + 9.5f * d, 20f * d, 19f * d, Theme.muted)
        val x = (14f + 19f + 12f) * d
        val words = readWords
        if (readLoading || words == null) {
          fill.color = if (Theme.dark) 0x1AFFFFFF else 0x12000000
          canvas.drawRoundRect(x, 14f * d, x + 150f * d, 26f * d, 6f * d, 6f * d, fill)
        } else {
          val shown = TextUtils.ellipsize(words, ink, width - x - 14f * d, TextUtils.TruncateAt.END)
          canvas.drawText(shown, 0, shown.length, x, 20f * d - (ink.ascent() + ink.descent()) / 2, ink)
        }
        fill.color = if (Theme.dark) 0x47000000 else 0x0F000000
        canvas.drawRect(0f, 40f * d, width.toFloat(), height.toFloat(), fill)
      }
    }
    readRow = row
    panel.addView(row)
    load { words ->
      readLoading = false
      if (words == null) { panel.removeView(row); readRow = null } else { readWords = words; row.contentDescription = words; row.invalidate() }
      page.requestLayout()
    }
  }

  // ContextMenu.tsx `shadow`: elevation 8 on Android; the plates' outlines carry it.
  private val pill = Plate(24f).apply { elevation = 8f * d }
  private val panel = Plate(26f).apply { elevation = 8f * d } // ContextMenu.tsx: the menu's radius 26
  private val reactionButtons = ArrayList<TextView>()
  private val moreButton = ChatIconView(context, "ion:chevron-down", 18f, Theme.muted).apply { isClickable = true; isFocusable = true; contentDescription = "Все реакции" }
  private val bubble = TextView(context).apply {
    text = preview
    // ContextMenu.tsx: the chat's own text size and line (chatPreferences.ts TEXT_SIZES).
    textSize = com.linea.messenger.settings.ThemeStore.textSize
    setLineSpacing(0f, 1f)
    val lineDp = when (com.linea.messenger.settings.ThemeStore.textSize) { 15f -> 20f; 17f -> 22f; 19f -> 25f; 22f -> 28f; else -> Math.round(com.linea.messenger.settings.ThemeStore.textSize * 1.3f).toFloat() }
    if (Build.VERSION.SDK_INT >= 28) lineHeight = Math.round(lineDp * d)
    // ContextMenu.tsx `shadow` (elevation 8 on Android).
    elevation = 8f * d
    setTextColor(Theme.text)
    maxLines = 6
    ellipsize = TextUtils.TruncateAt.END
    // ContextMenu.tsx: the words on the message's own colour, the chat's corner radius, padding 12 / 6.
    setPadding(dp(12f), dp(6f), dp(12f), dp(6f))
    background = GradientDrawable().apply { setColor(if (mine) com.linea.messenger.settings.ThemeStore.look.bubble else com.linea.messenger.settings.ThemeStore.look.incoming); cornerRadius = com.linea.messenger.chatlook.ChatBubbleLook.radius * d }
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
      bubble.visibility = if (preview.isEmpty() || peek != null) GONE else VISIBLE
      if (preview.isNotEmpty() && peek == null) {
        val widest = minOf(column.toFloat(), (width - 18f * d) * 0.85f).toInt()
        bubble.measure(MeasureSpec.makeMeasureSpec(widest.coerceAtLeast(1), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        bubbleW = bubble.measuredWidth; bubbleH = bubble.measuredHeight
      }
      var panelHeight = 0
      readRow?.let { put(it, 0, 0, panelWidth, dp(47f)); panelHeight = dp(47f) }
      // ContextMenu.tsx `peekRow`: the copy of the message spans the screen.
      val peekView = peek
      val peekH = peekView?.drawable?.intrinsicHeight ?: 0
      rowViews.forEachIndexed { index, row ->
        // ContextMenu.tsx MenuItem: 44 tall; a «separated» one carries its 6-point band above.
        val band = if (row.item.separated && index > 0) dp(6f) else 0
        row.band = band.toFloat()
        put(row, 0, panelHeight, panelWidth, dp(44f) + band)
        panelHeight += dp(44f) + band
      }

      var total = panelHeight
      if (pillH > 0) total += pillH + dp(8f)
      if (bubbleH > 0) total += bubbleH + dp(8f)
      if (peekH > 0) total += peekH + dp(8f)
      getLocationOnScreen(here)
      val highest = safeTop + dp(8f)
      val lowest = height - safeBottom - dp(8f) - total
      var y = maxOf(highest, minOf(Math.round(anchorY) - here[1] - dp(70f), lowest))
      fun placed(view: View, w: Int, h: Int) {
        val x = if (mine) width - dp(9f) - w else dp(9f)
        put(view, x, y, w, h)
      }
      if (pillH > 0) { placed(pill, pillW, pillH); y += pillH + dp(8f) }
      if (peekView != null && peekH > 0) {
        put(peekView, 0, y, width, peekH)
        peekWords?.let { put(it, Math.round(peekWordsAt.first), y + Math.round(peekWordsAt.second), peekWordsSize.first, peekWordsSize.second) }
        y += peekH + dp(8f)
      }
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
      // ContextMenu.tsx: the veil behind the menu, black 0.34 on dark, rgba(20,30,60,0.14) on light.
      page.setBackgroundColor(if (Theme.dark) 0x57000000 else 0x24141E3C)
      if (Build.VERSION.SDK_INT >= 31) Blur.behind(window, Math.round(18f * d))
      com.linea.messenger.design.coverWindow(window, darkPage = Theme.dark) // the blur and the veil to the screen's edges, under the bars
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
    readRow?.let { panel.removeView(it) }; readRow = null // the read row is not part of «Удалить» → for whom
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
