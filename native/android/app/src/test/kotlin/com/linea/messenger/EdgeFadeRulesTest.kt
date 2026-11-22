package com.linea.messenger

import com.linea.messenger.shell.EdgeRamp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The numbers of the progressive edge behind floating bars (shell/EdgeFade.kt `EdgeRamp`; the same as iOS
 *  Shell/EdgeFade.swift): strong at the screen's edge, gone `REACH` past the bar, smooth and never rising inwards. */
class EdgeFadeRulesTest {
  private val soften = EdgeRamp.SOFTEN

  @Test fun fallIsSmoothAndClamped() {
    assertEquals(1f, EdgeRamp.fall(-5f, 0f, 10f), 0f)
    assertEquals(1f, EdgeRamp.fall(0f, 0f, 10f), 0f)
    assertEquals(0.5f, EdgeRamp.fall(5f, 0f, 10f), 1e-6f)
    assertEquals(0f, EdgeRamp.fall(10f, 0f, 10f), 0f)
    assertEquals(0f, EdgeRamp.fall(7f, 5f, 5f), 0f)
    // No kink at the ends: the first and last steps are tiny.
    assertTrue(1f - EdgeRamp.fall(0.1f, 0f, 10f) < 0.001f)
    assertTrue(EdgeRamp.fall(9.9f, 0f, 10f) < 0.001f)
  }

  @Test fun washHoldsOverTheBarThenEasesAwayPastIt() {
    // A chat header: 59 status + 52 = 111, reaching 24 past it.
    val size = 111f; val total = size + EdgeRamp.REACH
    assertEquals(81f, EdgeRamp.holdEnd(size, total, soften), 1e-4f)
    assertEquals(1f, EdgeRamp.wash(0f, size, total, soften), 0f)
    assertEquals(1f, EdgeRamp.wash(80f, size, total, soften), 0f)
    val atInnerEdge = EdgeRamp.wash(size, size, total, soften)
    assertTrue("still covering under the pills' lower edge: $atInnerEdge", atInnerEdge in 0.3f..0.6f)
    assertEquals(0f, EdgeRamp.wash(total, size, total, soften), 0f)
    var last = 2f
    var y = 0f
    while (y <= total) { val v = EdgeRamp.wash(y, size, total, soften); assertTrue(v <= last + 1e-6f); last = v; y += 0.5f }
  }

  @Test fun shortBarsHoldNothingButStillFade() {
    // The status strip alone (24 dp) reaching 10 dp: no hold, a fade over the whole strip.
    assertEquals(0f, EdgeRamp.holdEnd(24f, 34f, soften), 0f)
    assertEquals(1f, EdgeRamp.wash(0f, 24f, 34f, soften), 0f)
    assertEquals(0f, EdgeRamp.wash(34f, 24f, 34f, soften), 0f)
  }

  @Test fun blurRampsFromAllLayersAtTheEdgeToNoneAtTheEnd() {
    val size = 111f; val total = size + EdgeRamp.REACH
    assertEquals(EdgeRamp.LAYERS.toFloat(), EdgeRamp.blurAt(0f, size, total, soften), 1e-5f)
    assertEquals(0f, EdgeRamp.blurAt(total, size, total, soften), 1e-5f)
    val atInnerEdge = EdgeRamp.blurAt(size, size, total, soften)
    assertTrue("some blur left at the bar's inner edge: $atInnerEdge", atInnerEdge > 0.5f && atInnerEdge < EdgeRamp.LAYERS - 1f)
    var last = EdgeRamp.LAYERS + 1f
    var y = 0f
    while (y <= total) { val v = EdgeRamp.blurAt(y, size, total, soften); assertTrue(v <= last + 1e-5f); last = v; y += 0.5f }
    // The layer reaching furthest ends exactly at the effect's end; each next one ends earlier.
    var previousEnd = Float.MAX_VALUE
    for (i in 0 until EdgeRamp.LAYERS) {
      val (start, end) = EdgeRamp.layerSpan(i, size, total, soften)
      assertTrue(start in 0f..end)
      assertTrue(end < previousEnd)
      previousEnd = end
    }
    assertEquals(total, EdgeRamp.layerSpan(0, size, total, soften).second, 1e-4f)
    assertEquals(EdgeRamp.LAYERS, EdgeRamp.RADII.size)
    for (i in 1 until EdgeRamp.RADII.size) assertTrue(EdgeRamp.RADII[i] > EdgeRamp.RADII[i - 1])
  }

  @Test fun samplesCoverTheViewInOrder() {
    val stops = EdgeRamp.samples(135f, 81f, 135f, 12) { y -> EdgeRamp.wash(y, 111f, 135f, soften) }
    assertEquals(13, stops.size) // one before the change, 12 across it, none after (it ends at the view's end)
    assertEquals(0f, stops.first().first, 0f)
    assertEquals(1f, stops.last().first, 1e-6f)
    for (i in 1 until stops.size) assertTrue(stops[i].first >= stops[i - 1].first)
    assertEquals(1f, stops.first().second, 0f)
    assertEquals(0f, stops.last().second, 1e-6f)
  }

  @Test fun peaksFollowTheTheme() {
    assertEquals(0.8f, EdgeRamp.peak(dark = true), 0f)
    assertEquals(0.7f, EdgeRamp.peak(dark = false), 0f)
    assertEquals(0.92f, EdgeRamp.peakWithoutBlur(0.8f), 1e-6f)
    assertEquals(1f, EdgeRamp.peakWithoutBlur(0.95f), 0f)
  }
}
