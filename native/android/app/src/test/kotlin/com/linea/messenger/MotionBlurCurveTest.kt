package com.linea.messenger

import com.linea.messenger.effects.MotionBlur
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The speed → blur curve of effects/MotionBlur.kt (iOS: Sources/Effects/MotionBlur.swift, the same numbers). */
class MotionBlurCurveTest {
  @Test fun zeroAtRestAndSlow() {
    assertEquals(0f, MotionBlur.radiusDp(0f), 0f)
    assertEquals(0f, MotionBlur.radiusDp(MotionBlur.DEAD), 0f)
  }

  @Test fun fullAtPeakAndCapped() {
    assertEquals(MotionBlur.MAX_RADIUS_DP, MotionBlur.radiusDp(MotionBlur.FULL), 1e-4f)
    assertEquals(MotionBlur.MAX_RADIUS_DP, MotionBlur.radiusDp(20000f), 1e-4f)
  }

  @Test fun risesSmoothly() {
    var last = 0f
    var speed = 0f
    while (speed <= 4000f) {
      val now = MotionBlur.radiusDp(speed)
      assertTrue(now >= last)
      last = now
      speed += 50f
    }
    // Halfway between the dead zone and the top: half the blur (smoothstep).
    assertEquals(MotionBlur.MAX_RADIUS_DP / 2, MotionBlur.radiusDp((MotionBlur.DEAD + MotionBlur.FULL) / 2), 1e-4f)
  }
}
