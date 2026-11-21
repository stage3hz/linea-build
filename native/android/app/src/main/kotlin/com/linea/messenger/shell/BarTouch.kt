package com.linea.messenger.shell

import kotlin.math.abs

/** One finger on the tab bar, as decisions: which tab a tap chooses, when the list of the other sections opens
 *  (a hold on the first tab, or the finger moving up from it), which row is lit under the finger and what a
 *  release does. The bar itself (`Host`) draws, keeps the list and runs the hold timer; nothing here touches a
 *  view, so the rules can be checked without a phone. Distances are px; `density` turns dp into them. */
class BarTouch(private val host: Host, private val density: Float) {
  interface Host {
    /** The bar's size and how many tabs it shows. */
    val barWidth: Float
    val barHeight: Float
    val tabCount: Int
    /** There are sections without an icon in the bar. */
    val hasOthers: Boolean
    val listOpen: Boolean
    /** The list stays open by itself and takes taps (the finger is not what holds it). */
    val listSticky: Boolean
    /** The capsule grows a little under a finger. */
    fun lift(on: Boolean)
    /** Starts (or stops) the wait after which a still finger opens the list: `HOLD_MS`. */
    fun hold(start: Boolean)
    fun openList(sticky: Boolean)
    /** The id of the list's row under a point given in the bar's coordinates. */
    fun rowAt(x: Float, y: Float): String?
    fun light(id: String?)
    fun pick(id: String)
    /** `restore`: the page shown as a preview gives way to the one that was open. */
    fun closeList(restore: Boolean)
    fun stick()
    fun choose(index: Int)
  }

  private var startX = 0f
  private var startY = 0f
  private var startIndex = -1
  private var movedFar = false

  fun index(x: Float): Int {
    val count = host.tabCount
    if (count <= 0 || host.barWidth <= 0f) return -1
    return (x / (host.barWidth / count)).toInt().coerceIn(0, count - 1)
  }

  /** With a little room around the bar. */
  private fun inside(x: Float, y: Float): Boolean {
    val room = 10f * density
    return x >= -room && y >= -room && x <= host.barWidth + room && y <= host.barHeight + room
  }

  fun down(x: Float, y: Float) {
    startX = x; startY = y
    startIndex = index(x)
    movedFar = false
    host.lift(true)
    if (startIndex == 0 && host.hasOthers) host.hold(true)
  }

  fun move(x: Float, y: Float) {
    val dx = x - startX; val dy = y - startY
    if (abs(dx) > 12f * density || abs(dy) > 12f * density) movedFar = true
    if (!host.listOpen) {
      if (startIndex == 0 && dy < -MOVE_UP_DP * density && host.hasOthers) host.openList(false)
      else if (movedFar) host.hold(false)
    }
    if (host.listOpen && !host.listSticky) host.light(host.rowAt(x, y))
  }

  fun up(x: Float, y: Float) {
    host.hold(false)
    host.lift(false)
    if (host.listOpen && !host.listSticky) {
      val picked = host.rowAt(x, y)
      if (picked != null) host.pick(picked)
      else if (movedFar) host.closeList(true)
      else host.stick()
    } else if (!host.listOpen && inside(x, y)) {
      host.choose(index(x))
    }
  }

  fun cancel() {
    host.hold(false)
    host.lift(false)
    if (host.listOpen && !host.listSticky) host.closeList(true)
  }

  companion object {
    /** A finger held still on the first tab for this long opens the list. */
    const val HOLD_MS = 350L
    /** …and so does a finger that moved up from it by this much. */
    const val MOVE_UP_DP = 8f
  }
}
