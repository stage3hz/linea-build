package com.linea.messenger.design

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

/** Whole px from dp. */
fun Context.px(dp: Float): Int = Math.round(dp * resources.displayMetrics.density)

/** A piece of text in the app's look. */
fun Context.words(text: String, size: Float, color: Int, weight: Int = 400): TextView = TextView(this).apply {
  this.text = text
  textSize = size
  typeface = Theme.weight(weight)
  setTextColor(color)
  includeFontPadding = false
}

/** A filled shape with round corners, as a background. `line`: a hairline around it (0 = none). */
fun Context.plate(fill: Int, radius: Float, line: Int = 0): GradientDrawable = GradientDrawable().apply {
  setColor(fill)
  cornerRadius = radius * resources.displayMetrics.density
  if (line != 0) setStroke(maxOf(1, Math.round(0.5f * resources.displayMetrics.density)), line)
}

/** A wide button with its words in the middle. It can show that it is busy (a turning ring before the words)
 *  or done (a tick before them); it fades when it cannot be pressed. */
@SuppressLint("ViewConstructor")
open class BusyButton(context: Context, label: String, fill: Int, private val ink: Int, radius: Float, textSize: Float = 15f, weight: Int = 600) : LinearLayout(context) {
  var onPress: (() -> Unit)? = null
  private val text = context.words(label, textSize, ink, weight)
  private val ring = ProgressBar(context)
  private val tick = SymbolView(context, "check", 16f, ink)

  var label: String
    get() = text.text.toString()
    set(value) { if (text.text.toString() != value) { text.text = value; contentDescription = value } }

  /** The turning ring is shown (the button can still be pressed, or not: see `setBusy`). */
  var loading: Boolean
    get() = ring.visibility == View.VISIBLE
    set(value) { ring.visibility = if (value) View.VISIBLE else View.GONE }

  var done: Boolean
    get() = tick.visibility == View.VISIBLE
    set(value) { tick.visibility = if (value) View.VISIBLE else View.GONE }

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER
    background = context.plate(fill, radius)
    setPadding(context.px(18f), context.px(14f), context.px(18f), context.px(14f))
    minimumHeight = context.px(48f)
    ring.isIndeterminate = true
    ring.indeterminateTintList = ColorStateList.valueOf(ink)
    ring.visibility = View.GONE
    tick.visibility = View.GONE
    addView(ring, LayoutParams(context.px(18f), context.px(18f)).apply { marginEnd = context.px(8f) })
    addView(tick, LayoutParams(context.px(18f), context.px(18f)).apply { marginEnd = context.px(8f) })
    text.gravity = Gravity.CENTER
    addView(text, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    isClickable = true
    isFocusable = true
    contentDescription = label
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setEnabled(enabled: Boolean) {
    super.setEnabled(enabled)
    alpha = if (enabled) 1f else 0.5f
  }

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    text.alpha = if (pressed) 0.6f else 1f
  }

  /** Busy: the ring turns and the button cannot be pressed. */
  fun setBusy(busy: Boolean) {
    loading = busy
    isEnabled = !busy
  }
}
