package com.linea.messenger

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import com.linea.messenger.design.Glass
import com.linea.messenger.effects.EffectsHost
import com.linea.messenger.effects.Rime
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** «Ледяное стекло»: the rime is drawn by each glass plate itself (design/Glass.kt, effects/Rime.kt), only while the
 *  setting is on, and only on what is a glass surface. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassRimeTest {
  @Test fun onlyRoundedPlatesOfSomeSizeThatAreNotABackdropCarryRime() {
    val d = 3f
    // A header pill and a round button on a 1080 × 2400 screen.
    assertTrue(Rime.rimed(1000f, 180f, 81f, 1080f, 2400f, d))
    assertTrue(Rime.rimed(132f, 132f, 66f, 1080f, 2400f, d))
    // No corners; smaller than 24 dp either way.
    assertFalse(Rime.rimed(1000f, 180f, 0f, 1080f, 2400f, d))
    assertFalse(Rime.rimed(60f, 180f, 30f, 1080f, 2400f, d))
    assertFalse(Rime.rimed(180f, 60f, 30f, 1080f, 2400f, d))
    // A backdrop over the whole screen is not a glass surface; a bar across its full width is.
    assertFalse(Rime.rimed(1080f, 2400f, 40f, 1080f, 2400f, d))
    assertTrue(Rime.rimed(1080f, 200f, 40f, 1080f, 2400f, d))
  }

  @Test fun aPlateAsksForItsRimeOnlyWhileTheSettingIsOn() {
    val context = RuntimeEnvironment.getApplication()
    val page = FrameLayout(context)
    val owner = View(context)
    page.addView(owner, FrameLayout.LayoutParams(600, 180))
    page.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY))
    page.layout(0, 0, 1080, 2400)
    val glass = Glass(owner)
    val canvas = Canvas(Bitmap.createBitmap(600, 180, Bitmap.Config.ARGB_8888))
    val allowed = EffectsHost.allowed
    try {
      EffectsHost.allowed = false
      EffectsHost.update()
      assertFalse(EffectsHost.iced)
      glass.draw(canvas, 0f, 0f, 600f, 180f, 90f)
      assertFalse(glass.rimed)

      EffectsHost.allowed = true
      EffectsHost.update()
      assertTrue(EffectsHost.iced)
      glass.draw(canvas, 0f, 0f, 600f, 180f, 90f)
      assertTrue(glass.rimed)

      // Turned off: the plate lets its rime go and does not ask again.
      EffectsHost.allowed = false
      EffectsHost.update()
      assertFalse(glass.rimed)
      glass.draw(canvas, 0f, 0f, 600f, 180f, 90f)
      assertFalse(glass.rimed)
    } finally {
      EffectsHost.allowed = false
      EffectsHost.update()
      EffectsHost.allowed = allowed
      // The host's look at the window, posted while an effect was on, runs out here and not in another test.
      shadowOf(Looper.getMainLooper()).idle()
    }
  }
}
