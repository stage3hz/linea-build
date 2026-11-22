package com.linea.messenger.auth

/** How the sign-in screen fits on the screen without scrolling (the same rules as iOS Auth/AuthFit.swift).
 *
 *  Two arrangements, and the screen moves between them once, together with the keyboard:
 *  - full (no keyboard): the wordmark, «Твоя линия связи.», the step's title and description, the glass card;
 *  - compact (the keyboard is up): the step's title at the top and the card right under it, down to the keyboard,
 *    with «Продолжить» at the card's bottom, just above the keyboard; the wordmark, the motto, the description and the
 *    theme pill step aside.
 *  What does not fit leaves in a fixed order (the hint under the field stays longest), so the title, the field with its
 *  caption, what went wrong and the button are always above the keyboard. The parts above the fields (the progress and
 *  the switch) are chosen without looking at the messages, so a message that appears never moves a field.
 *
 *  Sizes are in one unit: dp × `unit` (px on Android; points with `unit` 1 on iOS). Pure: no views. */
object AuthFit {
  /** The row of the theme pill stands above the page: the page starts this far under the status bar. */
  const val PILL_ROW = 58f
  /** The room above the wordmark when everything fits (at most). */
  const val TOP_GAP = 64f
  /** Under the card, above the navigation bar or the keyboard, in the full arrangement. */
  const val EDGE = 12f
  /** Above the title when the keyboard is up. */
  const val COMPACT_TOP = 8f
  /** Between the card and the keyboard. */
  const val COMPACT_EDGE = 8f
  /** Between the title and the card when the keyboard is up. */
  const val COMPACT_HEADING_GAP = 12f
  /** Inside the card (22 in the reference), and while the keyboard is up. */
  const val PAD = 22f
  const val COMPACT_PAD = 16f
  /** Under the switch and the progress (18 in the reference), and while the keyboard is up. */
  const val CHROME_GAP = 18f
  const val COMPACT_CHROME_GAP = 12f
  /** Between the other parts of the card. */
  const val GAP = 12f
  /** Between «Продолжить» and the links under it. */
  const val LINK_GAP = 4f
  /** A keyboard lower than this (a hardware keyboard's bar) keeps the full arrangement. */
  const val KEYBOARD = 100f
  const val AFTER_MOTTO = 28f
  const val AFTER_HINT = 24f

  /** Under the wordmark: 4 above the motto, more when the motto stepped aside. */
  fun afterBrand(motto: Boolean): Float = if (motto) 4f else 20f

  /** Under the title: 8 above the description, more when it stepped aside. */
  fun afterHeading(hint: Boolean): Float = if (hint) 8f else 16f

  /** A part that may leave, with what it takes: its height and the gap that comes with it. */
  class Part(val id: String, val cost: Float)

  /** The full arrangement: which of the parts above the card stay, the room above them, the card's parts that stay. */
  data class Plan(val brand: Boolean, val motto: Boolean, val hint: Boolean, val gap: Float, val kept: Set<String>)

  /** Takes the parts in their order while they fit; returns what they take. */
  private fun take(parts: List<Part>, budget: Float, into: MutableSet<String>): Float {
    var left = budget
    for (part in parts) {
      if (part.cost <= left) {
        into.add(part.id)
        left -= part.cost
      }
    }
    return budget - left
  }

  /** The keyboard is up: which of the card's parts stay.
   *  - `room`: the inside of the card (from under the title to above the keyboard, without the card's padding);
   *  - `core`: what is always there: the fields (with their captions), the waiting box, the button, their gaps;
   *  - `messages`: what went wrong, notices, the attempts left — shown now;
   *  - `helps`: the hints under the fields, the most needed first;
   *  - `chrome`: the progress and the switch above the fields;
   *  - `extras`: the rest (the second hint, the links, «Только ручной ввод»). */
  fun compact(room: Float, core: Float, messages: Float, helps: List<Part>, chrome: List<Part>, extras: List<Part>): Set<String> {
    val budget = room - core
    // The parts above the fields are chosen without the messages: a message that appears does not move a field.
    val helpRoom = take(helps, budget, HashSet())
    val chromeKept = HashSet<String>()
    var chromeUsed = take(chrome, budget - helpRoom, chromeKept)
    if (budget - chromeUsed - messages < 0) {
      // Only when a message cannot be shown otherwise.
      chromeKept.clear()
      chromeUsed = take(chrome, budget - messages, chromeKept)
    }
    val kept = HashSet<String>(chromeKept)
    var left = budget - chromeUsed - messages
    left -= take(helps, left, kept)
    take(extras, left, kept)
    return kept
  }

  /** No keyboard: what stays above the card and on it, and the room above the wordmark.
   *  - `room`: from under the theme pill's row to above the navigation bar;
   *  - `brand`, `motto`, `heading`, `hint`: the heights of the parts above the card;
   *  - `card`: the card with its padding, the fields, the button and the messages (what always shows on it). */
  fun full(room: Float, brand: Float, motto: Float, heading: Float, hint: Float, card: Float,
           helps: List<Part>, chrome: List<Part>, extras: List<Part>, unit: Float): Plan {
    fun top(withBrand: Boolean, withMotto: Boolean, withHint: Boolean): Float =
      (if (withBrand) brand + afterBrand(withMotto) * unit else 0f) + (if (withMotto) motto + AFTER_MOTTO * unit else 0f) +
        heading + (if (withHint) afterHeading(true) * unit + hint + AFTER_HINT * unit else afterHeading(false) * unit)
    var chromeCost = 0f
    for (part in chrome) chromeCost += part.cost
    var helpCost = 0f
    for (part in helps) helpCost += part.cost
    var extraCost = 0f
    for (part in extras) extraCost += part.cost
    val all = HashSet<String>()
    for (part in chrome + helps + extras) all.add(part.id)
    // The motto leaves first, then the description.
    for ((withMotto, withHint) in listOf(true to true, false to true, false to false)) {
      val need = top(true, withMotto, withHint) + card + chromeCost + helpCost + extraCost
      if (need <= room) return Plan(true, withMotto, withHint, minOf(TOP_GAP * unit, room - need), all)
    }
    // Then the extras, then (when even the hints do not fit) the wordmark.
    for (withBrand in listOf(true, false)) {
      val budget = room - top(withBrand, false, false) - card - chromeCost
      if (withBrand && budget < helpCost) continue
      val kept = HashSet<String>()
      for (part in chrome) kept.add(part.id)
      val left = budget - take(helps, budget, kept)
      take(extras, left, kept)
      return Plan(withBrand, false, false, 0f, kept)
    }
    return Plan(false, false, false, 0f, all)
  }
}
