package com.linea.messenger

import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.orbPair
import com.linea.messenger.shell.BarTouch
import com.linea.messenger.shell.springAt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rules of the shell that need no phone: the finger on the bar, the spring, the colours of a letter avatar. */
class ShellRulesTest {
  /** A bar of two tabs, 176 × 62, with a list of rows above it (each 44 high, the lowest ending 12 above the bar). */
  private class Bar(private val rows: List<String> = listOf("ai", "people", "channels", "music")) : BarTouch.Host {
    val said = ArrayList<String>()
    var open = false
    var sticky = false
    override val barWidth = 176f
    override val barHeight = 62f
    override val tabCount = 2
    override val hasOthers get() = rows.isNotEmpty()
    override val listOpen get() = open
    override val listSticky get() = sticky
    override fun lift(on: Boolean) {}
    override fun hold(start: Boolean) { if (start) said.add("hold") }
    override fun openList(sticky: Boolean) { open = true; this.sticky = sticky; said.add("open") }
    override fun rowAt(x: Float, y: Float): String? {
      val top = -12f - rows.size * 44f
      if (y < top || y >= -12f) return null
      return rows[((y - top) / 44f).toInt()]
    }
    override fun light(id: String?) { said.add("light:${id ?: ""}") }
    override fun pick(id: String) { open = false; said.add("pick:$id") }
    override fun closeList(restore: Boolean) { open = false; said.add("close:$restore") }
    override fun stick() { sticky = true; said.add("stick") }
    override fun choose(index: Int) { said.add("choose:$index") }
  }

  @Test fun aTapChoosesTheTabUnderTheFinger() {
    val bar = Bar(); val touch = BarTouch(bar, 1f)
    touch.down(130f, 30f); touch.up(131f, 31f)
    assertEquals(listOf("choose:1"), bar.said)
  }

  @Test fun aTapOnTheFirstTabStartsTheHoldAndChoosesIt() {
    val bar = Bar(); val touch = BarTouch(bar, 1f)
    touch.down(40f, 30f); touch.up(40f, 30f)
    assertEquals(listOf("hold", "choose:0"), bar.said)
  }

  @Test fun aFingerThatLeftTheBarChoosesNothing() {
    val bar = Bar(); val touch = BarTouch(bar, 1f)
    touch.down(130f, 30f); touch.move(130f, 120f); touch.up(130f, 120f)
    assertEquals(emptyList<String>(), bar.said)
  }

  @Test fun aHoldLeavesTheListOpenForTaps() {
    val bar = Bar(); val touch = BarTouch(bar, 1f)
    touch.down(40f, 30f)
    bar.openList(false)   // the hold timer fired
    touch.up(41f, 30f)
    assertEquals(listOf("hold", "open", "stick"), bar.said)
    assertTrue(bar.open && bar.sticky)
  }

  @Test fun movingUpFromTheFirstTabOpensTheListAndLightsTheRowUnderTheFinger() {
    val bar = Bar(); val touch = BarTouch(bar, 1f)
    touch.down(40f, 30f)
    touch.move(40f, 23f)   // 7 up: not yet
    assertEquals(listOf("hold"), bar.said)
    touch.move(40f, 21f)   // 9 up
    touch.move(40f, -30f)  // on the lowest row
    touch.up(40f, -30f)
    assertEquals(listOf("hold", "open", "light:", "light:music", "pick:music"), bar.said)
  }

  @Test fun movingUpFromTheSecondTabOpensNothing() {
    val bar = Bar(); val touch = BarTouch(bar, 1f)
    touch.down(130f, 30f); touch.move(130f, 0f)
    assertEquals(emptyList<String>(), bar.said)
  }

  @Test fun lettingGoBesideTheRowsAfterMovingClosesTheListAndRestoresThePage() {
    val bar = Bar(); val touch = BarTouch(bar, 1f)
    touch.down(40f, 30f); touch.move(40f, 10f); touch.move(40f, -400f); touch.up(40f, -400f)
    assertEquals("close:true", bar.said.last())
  }

  @Test fun aCancelledTouchClosesAListTheFingerWasHolding() {
    val bar = Bar(); val touch = BarTouch(bar, 1f)
    touch.down(40f, 30f); touch.move(40f, 10f); touch.cancel()
    assertEquals("close:true", bar.said.last())
  }

  @Test fun withoutOtherSectionsTheFirstTabIsAPlainTab() {
    val bar = Bar(emptyList()); val touch = BarTouch(bar, 1f)
    touch.down(40f, 30f); touch.move(40f, 15f); touch.up(40f, 15f)
    assertEquals(listOf("choose:0"), bar.said)
  }

  @Test fun distancesFollowTheScreensDensity() {
    val bar = object : BarTouch.Host by Bar() { override val barWidth = 528f; override val barHeight = 186f }
    val touch = BarTouch(bar, 3f)
    touch.down(120f, 90f); touch.move(120f, 70f)   // 20 px is under 8 dp at density 3
    assertTrue(!bar.listOpen)
    touch.move(120f, 60f)
    assertTrue(bar.listOpen)
  }

  @Test fun theSpringStartsAtRestEndsAtItsPlaceAndPassesItALittle() {
    assertEquals(0f, springAt(0f, 0.82f), 0f)
    assertEquals(1f, springAt(1f, 0.82f), 0f)
    val steps = (1..99).map { springAt(it / 100f, 0.82f) }
    assertTrue(steps.max() > 1f && steps.max() < 1.05f)
    assertTrue(Math.abs(steps.last() - 1f) < 0.01f)
    // Fully damped: never past its place.
    assertTrue((1..99).all { springAt(it / 100f, 1f) <= 1f })
  }

  @Test fun theBarKeepsClearOfTheScreensEdge() {
    // The reference on Android (chatLayout.ts tabBarMarginBottom): 10 above the navigation bar, whatever its height.
    assertEquals(10f, BarMetrics.bottomGap(0f), 0f)
    assertEquals(34f, BarMetrics.bottomGap(24f), 0f) // the gesture handle
    assertEquals(58f, BarMetrics.bottomGap(48f), 0f) // the three buttons
  }

  @Test fun aLetterAvatarsColoursAreTheSameAsOnTheOtherPhone() {
    // Expected values: the same arithmetic as native/ios/Sources/Design/Theme.swift, worked out separately.
    assertEquals(Pair(0xFFB170FF.toInt(), 0xFF17C4FF.toInt()), orbPair(0x5E7BFF))
    assertEquals(Pair(0xFFE3FF70.toInt(), 0xFFE70000.toInt()), orbPair(0xF2A33C))
    assertEquals(Pair(0xFFA9A1C4.toInt(), 0xFF4E7B7D.toInt()), orbPair(0x7A8699))
    assertEquals(Pair(0xFFB0ABA2.toInt(), 0xFF64555D.toInt()), orbPair(0x808080))
  }
}
