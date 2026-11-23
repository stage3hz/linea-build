package com.linea.messenger

import com.linea.messenger.auth.AuthFit
import com.linea.messenger.auth.AuthFit.Part
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** How the sign-in screen fits without scrolling (auth/AuthFit.kt, the same rules as iOS Auth/AuthFit.swift). */
class AuthFitTest {
  private val chrome = listOf(Part("progress", 25f), Part("switcher", 44f))

  @Test fun withTheKeyboardEverythingStaysWhenThereIsRoom() {
    val kept = AuthFit.compact(400f, 150f, 0f, listOf(Part("help", 44f)), chrome, listOf(Part("back", 48f), Part("manual", 40f)))
    assertEquals(setOf("progress", "switcher", "help", "back", "manual"), kept)
  }

  @Test fun theHintUnderTheFieldStaysLongerThanTheRest() {
    // Room for the hint and the progress only: the switch, the links and «Только ручной ввод» leave.
    val kept = AuthFit.compact(150f + 44f + 25f + 10f, 150f, 0f, listOf(Part("help", 44f)), chrome, listOf(Part("back", 48f), Part("manual", 40f)))
    assertEquals(setOf("help", "progress"), kept)
  }

  @Test fun aMessageThatAppearsDoesNotMoveTheFields() {
    // The progress and the switch above the fields are the same with and without a message that still fits:
    // the message pushes out the hints and the links below the fields instead.
    val helps = listOf(Part("help", 44f))
    val extras = listOf(Part("back", 48f))
    val room = 150f + 44f + 69f + 48f
    val quiet = AuthFit.compact(room, 150f, 0f, helps, chrome, extras)
    val failed = AuthFit.compact(room, 150f, 70f, helps, chrome, extras)
    assertTrue(quiet.containsAll(listOf("progress", "switcher", "help", "back")))
    assertTrue(failed.containsAll(listOf("progress", "switcher")))
    assertFalse(failed.contains("back"))
  }

  @Test fun onlyAMessageThatCannotBeShownOtherwiseTakesThePlaceOfTheSwitch() {
    val kept = AuthFit.compact(150f + 69f + 20f, 150f, 80f, emptyList(), chrome, emptyList())
    assertFalse(kept.contains("switcher"))
  }

  @Test fun theSmallestPhoneKeepsTheTitleTheFieldsAndTheButton() {
    // 360×640 dp with the keyboard up (status bar 24, keyboard with the navigation bar 290): the profile step, two
    // fields. The card's inside is what is left under the title; the fields and the button must fit in it.
    val heading = 29f
    val room = 640f - 290f - AuthFit.COMPACT_EDGE - (24f + AuthFit.COMPACT_TOP + heading + AuthFit.COMPACT_HEADING_GAP) - 2 * AuthFit.COMPACT_PAD
    val field = 13f + 8f + 54f
    val core = 2 * (field + AuthFit.GAP) + 54f
    assertTrue("room $room for $core", core <= room)
    val kept = AuthFit.compact(room, core, 0f, listOf(Part("profileHelp", 32f + AuthFit.GAP)),
      listOf(Part("progress", 13f + AuthFit.COMPACT_CHROME_GAP), Part("switcher", 36f + AuthFit.COMPACT_CHROME_GAP)), emptyList())
    // What stays never takes more than the room.
    var taken = core
    if ("profileHelp" in kept) taken += 32f + AuthFit.GAP
    if ("progress" in kept) taken += 13f + AuthFit.COMPACT_CHROME_GAP
    if ("switcher" in kept) taken += 36f + AuthFit.COMPACT_CHROME_GAP
    assertTrue(taken <= room)
  }

  @Test fun withoutTheKeyboardTheChipsLeaveFirstThenTheDescriptionThenTheWordmark() {
    // brand 90, heading 27, hint 40, card 300 (+69 the switch and the progress), chips 30.
    val roomy = AuthFit.full(900f, 90f, 27f, 40f, 300f, 30f, emptyList(), chrome, emptyList(), 1f)
    assertTrue(roomy.brand && roomy.chips && roomy.hint)
    assertEquals(AuthFit.TOP_GAP, roomy.gap, 0.01f)
    // Everything: 90+26+27+12+40+24 = 219 above the card, 300+69 the card, 22+30 the chips = 640.
    val noChips = AuthFit.full(600f, 90f, 27f, 40f, 300f, 30f, emptyList(), chrome, emptyList(), 1f)
    assertTrue(noChips.brand && !noChips.chips && noChips.hint)
    // Without the chips: 219+369 = 588; without the description too: 90+26+27+16+369 = 528.
    val noHint = AuthFit.full(540f, 90f, 27f, 40f, 300f, 30f, emptyList(), chrome, emptyList(), 1f)
    assertTrue(noHint.brand && !noHint.chips && !noHint.hint)
    assertEquals(12f, noHint.gap, 0.01f)
    val tight = AuthFit.full(480f, 90f, 27f, 40f, 300f, 30f, listOf(Part("help", 60f)), chrome, listOf(Part("manual", 40f)), 1f)
    assertFalse(tight.brand || tight.chips)
    assertTrue(tight.kept.contains("help"))
    assertFalse(tight.kept.contains("manual"))
  }

  @Test fun theRoomAboveTheWordmarkShrinksBeforeAnythingLeaves() {
    val plan = AuthFit.full(640f + 30f, 90f, 27f, 40f, 300f, 30f, emptyList(), chrome, emptyList(), 1f)
    assertTrue(plan.brand && plan.chips && plan.hint)
    assertEquals(30f, plan.gap, 0.01f)
  }
}
