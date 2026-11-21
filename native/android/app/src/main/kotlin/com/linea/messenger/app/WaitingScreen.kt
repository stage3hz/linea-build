package com.linea.messenger.app

import android.annotation.SuppressLint
import android.content.Context
import android.view.Gravity
import android.widget.TextView
import com.linea.messenger.design.Theme
import com.linea.messenger.shell.Screen

/** A screen with a few words: waiting, or something that did not work and can be tried again by a touch. */
@SuppressLint("ViewConstructor")
class WaitingScreen(context: Context, words: String) : Screen(context) {
  var onRetry: (() -> Unit)? = null

  private val label = TextView(context).apply {
    text = words
    textSize = 17f
    setTextColor(Theme.muted)
    gravity = Gravity.CENTER
  }

  init {
    setBackgroundColor(Theme.bg)
    addView(label)
    contentDescription = words
    setOnClickListener { onRetry?.invoke() }
  }

  override fun place(width: Int, height: Int) {
    val wide = width - dp(64f)
    label.measure(MeasureSpec.makeMeasureSpec(wide.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val top = (height - label.measuredHeight) / 2
    label.layout(dp(32f), top, dp(32f) + wide, top + label.measuredHeight)
  }
}
