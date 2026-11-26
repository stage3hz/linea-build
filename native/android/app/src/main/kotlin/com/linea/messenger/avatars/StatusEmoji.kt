package com.linea.messenger.avatars

import android.content.Context
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import java.time.Instant

/** The emoji status next to a name (the reference's StatusEmoji.tsx; iOS Avatars/StatusEmoji.swift): the chosen
 *  emoji while it lasts; a Platina account without one shows the Platina gem instead (`gem` false turns that off).
 *  It disappears by itself when the status runs out (the view is GONE when nothing is shown). `size`: the emoji's
 *  size, dp. `animated` (profiles, the chat header): the Lottie animation plays while animations and «Анимированные
 *  эмодзи» are on; lists keep the plain glyph. */
class StatusEmojiView(context: Context) : FrameLayout(context) {
  private val d = resources.displayMetrics.density
  private val glyph = TextView(context)
  private var moving: AnimatedEmojiView? = null
  private var gemView: PlatinaGemView? = null
  private var look = PersonLook()
  private var size = 16f
  private var gem = true
  private var animated = false
  private val expire = Runnable { refresh() }
  /** What a press on it does, where it is a button («Сменить статус рядом с именем»): read out instead of what it
   *  shows. The view names itself anew each time it is drawn again, so a name given from outside did not last. */
  var buttonLabel: String? = null
    set(value) { field = value; if (value != null && visibility == VISIBLE) contentDescription = value }

  init {
    glyph.gravity = Gravity.CENTER
    glyph.includeFontPadding = false
    addView(glyph, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    visibility = GONE
  }

  fun show(look: PersonLook, size: Float = 16f, gem: Boolean = true, animated: Boolean = false) {
    this.look = look; this.size = size; this.gem = gem; this.animated = animated
    refresh()
  }

  /** Something is shown. */
  val showsSomething: Boolean get() = visibility == VISIBLE

  private fun refresh() {
    removeCallbacks(expire)
    gemView?.let { removeView(it) }
    gemView = null
    val emoji = look.visibleStatus()
    if (emoji != null) {
      if (animated && AvatarMotion.feature("emoji", context)) {
        val player = moving ?: AnimatedEmojiView(context).also { moving = it; addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }
        player.visibility = VISIBLE
        player.show(emoji, size * 1.2f, AnimatedEmojiView.Mode.LOOP, "emoji")
        glyph.visibility = GONE
      } else {
        moving?.visibility = GONE
        glyph.visibility = VISIBLE
      }
      glyph.text = emoji
      glyph.textSize = size
      contentDescription = buttonLabel ?: "Статус $emoji"
      look.statusEnds()?.let { ends ->
        val wait = (ends.toEpochMilli() - Instant.now().toEpochMilli() + 1000).coerceIn(1000, Int.MAX_VALUE.toLong())
        postDelayed(expire, wait)
      }
      visibility = VISIBLE
    } else if (gem && look.platina) {
      glyph.visibility = GONE
      moving?.visibility = GONE
      val made = PlatinaGemView(context, Math.round(size * 0.8f).toFloat())
      addView(made, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER))
      gemView = made
      contentDescription = buttonLabel ?: "Platina"
      visibility = VISIBLE
    } else {
      visibility = GONE
    }
    requestLayout()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val gemShown = gemView
    if (gemShown != null) {
      val side = Math.round((gemShown.size + 4) * d)
      super.onMeasure(MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY))
      return
    }
    val animatedShown = moving?.visibility == VISIBLE
    val w = Math.ceil(((if (animatedShown) 1.2f else 1.25f) * size * d).toDouble()).toInt()
    val h = Math.ceil((size * 1.4f * d).toDouble()).toInt()
    super.onMeasure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    refresh()
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(expire)
    super.onDetachedFromWindow()
  }
}
