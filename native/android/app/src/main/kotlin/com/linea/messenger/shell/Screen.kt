package com.linea.messenger.shell

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import com.linea.messenger.design.Edges
import com.linea.messenger.design.edges

/** One full page of the app. It fills the window edge to edge and puts its parts in place itself (`place`), for
 *  its size and for what the system covers (`edges`: the status bar, the navigation bar, the keyboard). */
abstract class Screen(context: Context) : ViewGroup(context) {
  protected val d: Float = resources.displayMetrics.density
  protected var edges = Edges.none
    private set

  /** Whole px from dp. */
  protected fun dp(value: Float): Int = Math.round(value * d)

  override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
    val next = insets.edges()
    if (next != edges) { edges = next; requestLayout() }
    return insets
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    // A page added later (a chat) has missed the window's first word about its edges.
    rootWindowInsets?.let { onApplyWindowInsets(it) }
    requestApplyInsets()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (right > left && bottom > top) place(right - left, bottom - top)
  }

  /** Puts every part where it belongs in a page of this size. */
  protected abstract fun place(width: Int, height: Int)

  /** A part at an exact place and size. */
  protected fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** A text at a corner, as wide and as tall as its words need, at most `maxWidth`. Its height is returned. */
  protected fun putText(view: View, left: Int, top: Int, maxWidth: Int): Int {
    view.measure(MeasureSpec.makeMeasureSpec(maxWidth.coerceAtLeast(0), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    view.layout(left, top, left + view.measuredWidth, top + view.measuredHeight)
    return view.measuredHeight
  }
}
