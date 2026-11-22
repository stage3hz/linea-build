package com.linea.messenger.design

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.view.View

/** A button that is one of the app's pictures (see Icons), `size` dp across, in the middle of its place. It
 *  dims under a finger. Give it a `contentDescription`: that is its name for a screen reader. */
@SuppressLint("ViewConstructor")
class IconButton(context: Context, symbol: String, size: Float, private val color: Int) : View(context) {
  /** The icon ("ion:<name>" for the reference's own Ionicons glyph, design/IonIcon.kt) and its size, dp. */
  var symbol: String = symbol
    set(value) { if (field != value) { field = value; invalidate() } }
  var size: Float = size
    set(value) { if (field != value) { field = value; invalidate() } }
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
    val ink = if (isPressed) Theme.alpha(color, 0.5f) else color
    if (symbol.startsWith("ion:")) Symbols.draw(canvas, symbol, width / 2f, height / 2f, size * d, ink) // «ion:chevron-back»: the reference's drawn chevron
    else Icons.draw(canvas, symbol, width / 2f, height / 2f, size * d, ink)
  }
}
