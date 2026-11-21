package com.linea.messenger.chatsplus

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.titled
import com.linea.messenger.settings.ThemeStore

/** ChatsPlus: the reference's `Empty` (components.tsx): an icon on a tilted glass tile over a softer tilted one, a
 *  title, a line of words and, when there is something to do, a button. Used by the chat list («Начни разговор»,
 *  «Чат не найден», «Всё прочитано», «Здесь пока пусто»), «Избранное» and «Звонки»
 *  (native/ios/Sources/ChatsPlus/EmptyStateView.swift). */
@SuppressLint("ViewConstructor")
class EmptyStateView(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val art = Art(context)
  private val titleLabel = TextView(context).apply { gravity = Gravity.CENTER; includeFontPadding = false }
  private val wordsLabel = TextView(context).apply { gravity = Gravity.CENTER; textSize = 15f; setLineSpacing(4f * d, 1f) }
  private val button = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; isClickable = true; isFocusable = true }
  private val buttonIcon = PlusIconView(context, "plus", 15f, Theme.onAccent)
  private val buttonWords = TextView(context).apply { textSize = 16f; typeface = Theme.weight(600) }
  private var action: (() -> Unit)? = null

  init {
    addView(art)
    titleLabel.titled(Theme.TypeSize.emptyTitle)
    addView(titleLabel)
    addView(wordsLabel)
    button.addView(buttonIcon, LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { marginEnd = dp(6f) })
    button.addView(buttonWords)
    button.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      action?.invoke()
    }
    addView(button)
    paint()
  }

  /** `symbol`: one of PlusIcons; `button`: the words of the button (empty: none) and what it does. */
  fun show(symbol: String, title: String, words: String, buttonWords: String = "", buttonSymbol: String = "plus", action: (() -> Unit)? = null) {
    art.symbol = symbol
    titleLabel.text = title
    wordsLabel.text = words
    button.visibility = if (buttonWords.isEmpty() || action == null) View.GONE else View.VISIBLE
    this.buttonWords.text = buttonWords
    buttonIcon.symbol = buttonSymbol
    this.action = action
    contentDescription = "$title. $words"
    paint()
    requestLayout()
    invalidate()
  }

  fun paint() {
    titleLabel.setTextColor(Theme.text)
    wordsLabel.setTextColor(Theme.muted)
    button.background = context.plate(Theme.accent, 24f)
    buttonWords.setTextColor(Theme.onAccent)
    buttonIcon.color = Theme.onAccent
    art.invalidate()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  private fun measureText(view: View, width: Int): Int {
    view.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    return view.measuredHeight
  }

  /** The height the content takes at this width. */
  fun contentHeight(width: Int): Int {
    val inner = minOf(dp(310f), width - dp(56f)).coerceAtLeast(1)
    val title = measureText(titleLabel, inner); val words = measureText(wordsLabel, inner)
    return dp(38f) + dp(126f) + dp(8f) + dp(13f) + title + dp(13f) + words + (if (button.visibility == View.GONE) 0 else dp(13f + 11f + 48f)) + dp(38f)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left; val height = bottom - top
    if (width <= 0) return
    val inner = minOf(dp(310f), width - dp(56f)).coerceAtLeast(1)
    var y = maxOf(0, (height - contentHeight(width)) / 2) + dp(38f)
    val side = dp(126f)
    art.measure(MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY))
    art.layout((width - side) / 2, y, (width + side) / 2, y + side)
    y += side + dp(8f) + dp(13f)
    val title = measureText(titleLabel, inner)
    titleLabel.layout((width - inner) / 2, y, (width + inner) / 2, y + title)
    y += title + dp(13f)
    val words = measureText(wordsLabel, inner)
    wordsLabel.layout((width - inner) / 2, y, (width + inner) / 2, y + words)
    y += words + dp(13f + 11f)
    val wide = minOf(dp(270f), width - dp(56f))
    button.measure(MeasureSpec.makeMeasureSpec(wide, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(48f), MeasureSpec.EXACTLY))
    button.layout((width - wide) / 2, y, (width + wide) / 2, y + dp(48f))
  }

  /** The two tilted tiles and the icon. */
  private class Art(context: Context) : View(context) {
    var symbol = "bubbles"
    private val d = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    override fun onDraw(canvas: Canvas) {
      val cx = width / 2f; val cy = height / 2f
      line.strokeWidth = d
      canvas.save(); canvas.rotate(-15f, cx, cy)
      paint.color = ThemeStore.look.accentSoft
      val back = 63f * d
      canvas.drawRoundRect(cx - back, cy - back, cx + back, cy + back, 47f * d, 47f * d, paint)
      line.color = Theme.veil(0.12f)
      canvas.drawRoundRect(cx - back, cy - back, cx + back, cy + back, 47f * d, 47f * d, line)
      canvas.restore()
      canvas.save(); canvas.rotate(-5f, cx, cy)
      val tile = 47f * d
      // The glass tile: the page seen through a thin veil (no blur on this side), with its light edge.
      paint.color = if (Theme.dark) 0x4D202226 else 0x99FFFFFF.toInt()
      canvas.drawRoundRect(cx - tile, cy - tile, cx + tile, cy + tile, 34f * d, 34f * d, paint)
      line.color = Theme.veil(0.14f)
      canvas.drawRoundRect(cx - tile, cy - tile, cx + tile, cy + tile, 34f * d, 34f * d, line)
      PlusIcons.draw(canvas, symbol, cx, cy, 38f * d, Theme.accent)
      canvas.restore()
    }
  }
}
