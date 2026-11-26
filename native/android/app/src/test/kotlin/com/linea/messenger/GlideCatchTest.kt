package com.linea.messenger

import com.linea.messenger.design.GlideCatch
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When a touch on a gliding list stops the glide and goes on to the row under it (design/GlideCatch.kt). */
class GlideCatchTest {
  @Test fun aGlideThatIsNearlyOverLetsTheTouchThrough() {
    assertTrue(GlideCatch.lets(gliding = true, dpPerSecond = 0f))
    assertTrue(GlideCatch.lets(gliding = true, dpPerSecond = 80f))
    assertTrue(GlideCatch.lets(gliding = true, dpPerSecond = GlideCatch.SLOW_DP - 1f))
  }

  @Test fun aFastGlideIsOnlyStoppedByTheTouch() {
    assertFalse(GlideCatch.lets(gliding = true, dpPerSecond = GlideCatch.SLOW_DP))
    assertFalse(GlideCatch.lets(gliding = true, dpPerSecond = 600f))
    assertFalse(GlideCatch.lets(gliding = true, dpPerSecond = 4000f))
  }

  @Test fun aListAtRestOrUnderTheFingerIsLeftAlone() {
    assertFalse(GlideCatch.lets(gliding = false, dpPerSecond = 0f))
    assertFalse(GlideCatch.lets(gliding = false, dpPerSecond = 80f))
  }
}
