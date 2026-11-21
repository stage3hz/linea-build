package com.linea.messenger.design

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.view.View

/** A button that is one of the app's pictures (see Icons), `size` dp across, in the middle of its place. It
 *  dims under a finger. Give it a `contentDescription`: that is its name for a screen reader. */
@SuppressLint("ViewConstructor")
class IconButton(context: Context, private val symbol: String, private val size: Float, private val color: Int) : View(context) {
  private val d = resources.displayMetrics.density

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
    Icons.draw(canvas, symbol, width / 2f, height / 2f, size * d, if (isPressed) Theme.alpha(color, 0.5f) else color)
  }
}
