package com.linea.messenger

import com.linea.messenger.channels.ChannelLook
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.rooms.RoomLightsView
import com.linea.messenger.settings.KeptWords
import com.linea.messenger.settings.ThemeStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Every section follows the theme (native/ios/Sources/Design/ThemeFollow.swift): on «Чёрная» the colours the
 *  screens always had, on any other theme the theme's own. And the room's calm lights (RoomViewController.swift). */
class ThemeFollowRulesTest {
  private class Memory : KeptWords {
    val kept = HashMap<String, String>()
    override fun get(key: String): String? = kept[key]
    override fun set(key: String, value: String?) { if (value == null) kept.remove(key) else kept[key] = value }
  }

  @After fun backToTheAppsOwnLook() {
    ThemeStore.use(null)
    ThemeStore.systemLook = null
    ThemeStore.screenLevel = null
  }

  private fun hsv(color: Int): FloatArray {
    val r = ((color shr 16) and 255) / 255f; val g = ((color shr 8) and 255) / 255f; val b = (color and 255) / 255f
    val top = maxOf(r, g, b); val low = minOf(r, g, b)
    return floatArrayOf(0f, if (top == 0f) 0f else (top - low) / top, top)
  }

  @Test fun oneColourLaidOverAnotherIsOpaque() {
    assertEquals(0xFF808080.toInt(), Theme.solid(0x80FFFFFF.toInt(), 0xFF000000.toInt()))
    assertEquals(0xFF123456.toInt(), Theme.solid(0xFF123456.toInt(), 0xFFFFFFFF.toInt()))
    assertEquals(0xFFABCDEF.toInt(), Theme.solid(0x00123456, 0xFFABCDEF.toInt()))
  }

  @Test fun onTheBlackLookTheScreensKeepTheirOwnColours() {
    // Without a choice the look is «Чёрная»: every helper gives back the fixed colour, every veil is the old white.
    assertTrue(Theme.black)
    assertEquals(0xFF141516.toInt(), Theme.page(0xFF141516.toInt()))
    assertEquals(0xF52E2E30.toInt(), Theme.raised(0xF52E2E30.toInt()))
    assertEquals(0xFF1F2023.toInt(), Theme.panel(0xFF1F2023.toInt()))
    assertEquals(-1, Theme.onBlack(-1, 0))
    assertEquals(0x1AFFFFFF, Theme.veil(0.1f))
    assertEquals(0x12FFFFFF, Theme.veil(0.07f))
    assertEquals(0x29FFFFFF, Theme.veil(0.16f))
    assertEquals(0x0FFFFFFF, Theme.veil(0.06f))
    assertEquals(0xF5161718.toInt(), ChannelLook.card)
    assertEquals(0x1AFFFFFF, ChannelLook.soft)
    assertEquals(0x14FFFFFF, ChannelLook.line)
  }

  @Test fun aLightThemeGivesItsOwnColours() {
    assumeTrue(Core.loaded)
    ThemeStore.systemLook = { "light" }
    ThemeStore.screenLevel = { 0.8 }
    ThemeStore.use(Memory())
    ThemeStore.mode = "light"
    ThemeStore.refresh()
    assertFalse(Theme.black)
    assertFalse(Theme.dark)
    assertEquals(Theme.bg, Theme.page(0xFF141516.toInt()))
    assertEquals(ThemeStore.look.incoming, Theme.raised(0xF52E2E30.toInt()))
    val panel = Theme.panel(0xFF1F2023.toInt())
    assertEquals(0xFF, panel ushr 24)
    assertEquals(Theme.solid(ThemeStore.look.incoming, Theme.bg), panel)
    assertEquals(0x1A000000, ChannelLook.soft)
    assertEquals(ThemeStore.look.incoming, ChannelLook.card)
    // «Графит» is dark but not black: its own page, the white veil.
    ThemeStore.mode = "graphite"
    ThemeStore.refresh()
    assertTrue(Theme.dark)
    assertFalse(Theme.black)
    assertNotEquals(0xFF141516.toInt(), Theme.page(0xFF141516.toInt()))
    assertEquals(0x1AFFFFFF, ChannelLook.soft)
  }

  @Test fun theRoomsLightsAreQuiet() {
    assertEquals(0.2f, RoomLightsView.TALKING_STRENGTH)
    assertEquals(0.11f, RoomLightsView.QUIET_STRENGTH)
    assertEquals(2.1f, RoomLightsView.REACH)
    for (rgb in listOf(0xFF3B30, 0x34C759, 0x007AFF, 0xAF52DE, 0xFF9500, 0x101010, 0xFFFFFF)) {
      for (dark in listOf(true, false)) {
        val calm = RoomLightsView.calm(rgb, dark)
        val (_, saturation, brightness) = hsv(calm).toList()
        assertEquals(0xFF, calm ushr 24)
        assertTrue("saturation of %06X: $saturation".format(rgb), saturation <= 0.33f)
        if (dark) assertTrue(brightness >= 0.71f) else assertTrue(brightness in 0.54f..0.79f)
      }
    }
    // Pure red: saturation 1 × 0.45 is capped at 0.32; brightness 1 stays on a dark theme, 0.78 on a light one.
    assertEquals(0xFFFFADAD.toInt(), RoomLightsView.calm(0xFF0000, dark = true))
    assertEquals(0xFFC78787.toInt(), RoomLightsView.calm(0xFF0000, dark = false))
  }
}
