package com.linea.messenger.composer

import android.content.Context
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.view.View
import com.airbnb.lottie.LottieCompositionFactory
import com.airbnb.lottie.LottieDrawable
import com.linea.messenger.avatars.AnimatedEmojiView
import com.linea.messenger.avatars.AvatarMotion
import java.text.BreakIterator

/** Up to three emoji with no other text are shown large, as stickers (iOS: Sources/Composer/BigEmoji.swift; the
 *  reference's messageMeta.ts `bigEmojiCount`). On Android the reference plays them as the Noto Lottie animations
 *  (platina/AnimatedEmoji.tsx, «Анимированные стикеры»), once each time the row appears: 112 / 84 / 68 dp boxes for
 *  one, two or three. */
object BigEmoji {
  /** The graphemes of a text, white space left out. */
  fun graphemes(value: String): List<String> {
    val out = ArrayList<String>()
    val it = BreakIterator.getCharacterInstance()
    it.setText(value)
    var start = it.first(); var end = it.next()
    while (end != BreakIterator.DONE) {
      val part = value.substring(start, end)
      if (part.isNotBlank()) out.add(part)
      start = end; end = it.next()
    }
    return out
  }

  /** How many emoji the text is (1…3), or 0 when it is not only emoji. */
  fun count(value: String): Int {
    val trimmed = value.trim()
    if (trimmed.isEmpty() || trimmed.length > 40) return 0
    val parts = graphemes(trimmed)
    if (parts.isEmpty() || parts.size > 3) return 0
    return if (parts.all { emoji(it) }) parts.size else 0
  }

  /** A pictograph or a regional indicator, and nothing of a letter or a digit once the variation selector and the
   *  keycap mark are left out (so «1️⃣» is not one, «❤️» is). */
  private fun emoji(part: String): Boolean {
    var pictured = false
    for (point in part.codePoints().toArray()) {
      if (point == 0xFE0F || point == 0x20E3 || point == 0x200D) continue
      if (Character.isLetterOrDigit(point)) return false
      when (Character.getType(point)) {
        Character.LETTER_NUMBER.toInt(), Character.OTHER_NUMBER.toInt() -> return false
      }
      if (point in 0x1F1E6..0x1F1FF || point in 0x1F000..0x1FAFF || point in 0x2600..0x27BF || point in 0x2B00..0x2BFF || point in 0x2190..0x21FF ||
        point in 0x2300..0x23FF || point in 0x2900..0x297F || point in 0x3030..0x303D || point == 0x00A9 || point == 0x00AE || point in 0x2122..0x2139 || point in 0x25A0..0x25FF) pictured = true
    }
    return pictured
  }

  /** The box of each emoji for their count, dp (the glyph is 0.86 of it). */
  fun box(count: Int): Float = if (count == 1) 112f else if (count == 2) 84f else 68f

  /** The size of the glyphs for their count, dp. */
  fun fontSize(count: Int): Float = box(count) * 0.86f
}

/** The animated big emoji of one row (`owner`): one Lottie per emoji that has a Noto animation, played once each time
 *  the row is given its emoji; the row draws a glyph where there is none (or while it loads, or with motion off). */
class BigEmojiArt(private val owner: View) : Drawable.Callback {
  private var shown: List<String> = emptyList()
  private val drawables = HashMap<Int, LottieDrawable>()
  private var key = ""

  /** The row shows these emoji now (`key`: the row; the same row again does not play again). */
  fun show(context: Context, key: String, emoji: List<String>) {
    if (key == this.key && emoji == shown) return
    this.key = key
    shown = emoji
    drawables.values.forEach { it.stop(); it.callback = null }
    drawables.clear()
    if (!AvatarMotion.enabled(context) || !AvatarMotion.feature("stickers", context)) return
    emoji.forEachIndexed { index, glyph ->
      val id = AnimatedEmojiView.resource(context, glyph)
      if (id == 0) return@forEachIndexed
      LottieCompositionFactory.fromRawRes(context, id).addListener { composition ->
        if (this.key != key || shown != emoji) return@addListener
        val drawable = LottieDrawable()
        drawable.composition = composition
        drawable.callback = this
        drawable.repeatCount = 0
        drawables[index] = drawable
        drawable.playAnimation()
        owner.invalidate()
      }
    }
  }

  /** Whether the emoji at `index` is drawn by its animation (the row then leaves its glyph out). */
  fun has(index: Int): Boolean = drawables.containsKey(index)

  /** Draws the animation of the emoji at `index` in a box of `side` px with its corner at (x, y). */
  fun draw(canvas: Canvas, index: Int, x: Float, y: Float, side: Float) {
    val drawable = drawables[index] ?: return
    drawable.setBounds(x.toInt(), y.toInt(), (x + side).toInt(), (y + side).toInt())
    drawable.draw(canvas)
  }

  fun stop() { drawables.values.forEach { it.stop() } }

  override fun invalidateDrawable(who: Drawable) { owner.invalidate() }
  override fun scheduleDrawable(who: Drawable, what: Runnable, `when`: Long) { owner.postDelayed(what, `when` - android.os.SystemClock.uptimeMillis()) }
  override fun unscheduleDrawable(who: Drawable, what: Runnable) { owner.removeCallbacks(what) }
}
