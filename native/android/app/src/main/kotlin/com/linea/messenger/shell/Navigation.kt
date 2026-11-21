package com.linea.messenger.shell

import android.content.Context
import android.view.View
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import com.linea.messenger.design.Theme

/** The stack of pages: the newest lies over the others and came in from the right; going back sends it out the
 *  same way. No bar on top (every page draws its own header). The system's Back gesture drives `backProgress`
 *  while the finger is still on the screen, so the page follows it. */
class Navigation(context: Context) : FrameLayout(context) {
  /** How many pages are in the stack now (1 = only the root). */
  var onDepthChange: (depth: Int) -> Unit = {}
  val depth: Int get() = stack.size
  /** The page on top of the stack; null before the first one. */
  val top: View? get() = stack.lastOrNull()

  private val stack = ArrayList<View>()
  private val curve = PathInterpolator(0.2f, 0f, 0f, 1f)

  init { setBackgroundColor(Theme.bg) }

  fun setRoot(page: View) {
    removeAllViews(); stack.clear()
    addView(page, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    stack.add(page)
    onDepthChange(stack.size)
  }

  fun push(page: View, animated: Boolean = true) {
    val under = stack.lastOrNull()
    addView(page, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    stack.add(page)
    onDepthChange(stack.size)
    // A covered page is not drawn; it comes back when the one above starts to leave.
    val cover = Runnable { if (stack.lastOrNull() === page) under?.visibility = View.INVISIBLE }
    if (!animated || width == 0) { cover.run(); return }
    page.translationX = width.toFloat()
    page.animate().translationX(0f).setDuration(320).setInterpolator(curve).withEndAction(cover).start()
    under?.animate()?.translationX(-width * UNDER_SHIFT)?.setDuration(320)?.setInterpolator(curve)?.start()
  }

  /** Takes the top page away. Nothing happens when only the root is left. */
  fun pop(animated: Boolean = true) {
    if (stack.size <= 1) return
    val page = stack.removeAt(stack.size - 1)
    val under = stack.last()
    onDepthChange(stack.size)
    under.animate().cancel(); page.animate().cancel()
    under.visibility = View.VISIBLE
    if (!animated || width == 0) { under.translationX = 0f; removeView(page); return }
    page.animate().translationX(width.toFloat()).setDuration(260).setInterpolator(curve).withEndAction { removeView(page) }.start()
    under.animate().translationX(0f).setDuration(260).setInterpolator(curve).start()
  }

  /** The Back gesture is under way: `progress` 0…1 of it. The top page moves aside and shows the one under it. */
  fun backProgress(progress: Float) {
    if (stack.size <= 1 || width == 0) return
    val page = stack.last(); val under = stack[stack.size - 2]
    page.animate().cancel(); under.animate().cancel()
    under.visibility = View.VISIBLE
    val moved = progress.coerceIn(0f, 1f) * BACK_REACH
    page.translationX = width * moved
    under.translationX = -width * UNDER_SHIFT * (1f - moved)
  }

  /** The Back gesture was given up: everything returns. */
  fun backCancelled() {
    if (stack.size <= 1) return
    val page = stack.last(); val under = stack[stack.size - 2]
    page.animate().translationX(0f).setDuration(200).setInterpolator(curve).withEndAction { if (stack.lastOrNull() === page) under.visibility = View.INVISIBLE }.start()
    under.animate().translationX(-width * UNDER_SHIFT).setDuration(200).setInterpolator(curve).start()
  }

  companion object {
    /** How far the page under the top one is shifted to the left, in widths. */
    private const val UNDER_SHIFT = 0.25f
    /** How far the top page has gone when the gesture is at its end, in widths. */
    private const val BACK_REACH = 0.55f
  }
}
