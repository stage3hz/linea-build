package com.linea.messenger.design

import android.view.animation.AnimationUtils
import android.widget.AbsListView
import kotlin.math.abs

/** A list still gliding after a flick, but almost at rest, gives a new touch to what is under the finger.
 *
 *  While a list glides it takes every touch that comes down on it for itself: the touch only stops the glide, and
 *  what lies under the finger never hears of it, so a strip that scrolls sideways (the stories) or a row's own
 *  gesture cannot begin, and a sideways swipe made at the end of a glide is lost. When the glide has slowed below
 *  `SLOW_DP` dp a second, the touch stops it at once instead and then goes on as a touch on a list at rest: a
 *  mostly sideways move is the row's or the strip's, a vertical one scrolls (after the usual slop), a tap is a tap.
 *  A faster glide is still stopped by the touch alone, as before.
 *
 *  The list's own speed is not told: it is measured here from how far its rows went between two scroll reports.
 *  The owner of the list calls `scrolled` from its onScroll, `state` from its onScrollStateChanged and `down`
 *  before the list sees ACTION_DOWN (its dispatchTouchEvent), each with the list. Main thread only. */
class GlideCatch {
  private var gliding = false
  private var markPosition = -1
  private var markTop = 0
  private var markAt = 0L
  /** The last measured speed, px a second. */
  private var speed = 0f

  fun state(state: Int) {
    gliding = state == AbsListView.OnScrollListener.SCROLL_STATE_FLING
    if (!gliding) speed = 0f
  }

  fun scrolled(list: AbsListView) {
    val first = list.firstVisiblePosition
    val child = list.getChildAt(0) ?: return
    val now = AnimationUtils.currentAnimationTimeMillis()
    val index = markPosition - first
    if (markPosition >= 0 && index >= 0 && index < list.childCount && now > markAt) {
      val moved = abs(list.getChildAt(index).top - markTop)
      val each = moved * 1000f / (now - markAt)
      // Halfway to the newest step: one late frame does not make the glide look slower than it is.
      speed = if (speed == 0f) each else (speed + each) / 2f
    }
    markPosition = first; markTop = child.top; markAt = now
  }

  /** A finger came down on the list: a slow glide is stopped now (true), anything else is left as it is. */
  fun down(list: AbsListView): Boolean {
    val quiet = AnimationUtils.currentAnimationTimeMillis() - markAt
    // No report for a while: the rows have stood still that long.
    val dpPerSecond = if (quiet > STILL_MS) 0f else speed / list.resources.displayMetrics.density
    if (!lets(gliding, dpPerSecond)) return false
    // A list pulled past its end springs back by itself; that is left alone (stopped, it would stay pulled).
    if (list.scrollY != 0) return false
    // A scroll of nothing ends the glide where it is (the list then reports that it is at rest).
    list.smoothScrollBy(0, 0)
    gliding = false; speed = 0f
    return true
  }

  companion object {
    /** Below this speed (dp a second) a glide is nearly over and a touch goes to what is under it. */
    const val SLOW_DP = 160f
    /** A glide that has not moved its rows for this long is as good as stopped, ms. */
    const val STILL_MS = 100L

    /** Whether a touch that comes down now stops the glide and goes on to what is under it. */
    fun lets(gliding: Boolean, dpPerSecond: Float): Boolean = gliding && dpPerSecond < SLOW_DP
  }
}
