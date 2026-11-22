package com.linea.messenger

import com.linea.messenger.shell.EdgeRamp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The numbers of the soft edge behind floating bars (shell/EdgeFade.kt `EdgeRamp`; the same as iOS
 *  Shell/EdgeFade.swift): solid colour from the screen's edge, an S-shaped fade over the last `fade`, never rising
 *  inwards, gone at the inner end. */
class EdgeFadeRulesTest {
  @Test fun solidThenFadesAlongTheCourse() {
    val total = 125f; val fade = EdgeRamp.FADE
    assertEquals(1f, EdgeRamp.wash(0f, total, fade), 0f)
    assertEquals(1f, EdgeRamp.wash(total - fade, total, fade), 0f)
    assertEquals(0.483f, EdgeRamp.wash(total - fade / 2, total, fade), 1e-4f)
    assertEquals(0f, EdgeRamp.wash(total, total, fade), 0f)
    var last = 1f; var y = 0f
    while (y <= total) { val v = EdgeRamp.wash(y, total, fade); assertTrue(v <= last + 1e-6f); last = v; y += 0.5f }
  }

  @Test fun aShortEdgeFadesOverItsWholeHeight() {
    assertEquals(1f, EdgeRamp.wash(0f, 30f, 1000f), 0f)
    assertEquals(0f, EdgeRamp.wash(30f, 30f, 1000f), 0f)
    val stops = EdgeRamp.stops(30f, 1000f)
    assertEquals(0f, stops.first().first, 0f); assertEquals(1f, stops.last().first, 1e-6f)
  }

  @Test fun theHeaderNumbers() {
    assertEquals(14f, EdgeRamp.REACH, 0f); assertEquals(54f, EdgeRamp.FADE, 0f); assertEquals(0.85f, EdgeRamp.STRENGTH, 0f)
  }
}
