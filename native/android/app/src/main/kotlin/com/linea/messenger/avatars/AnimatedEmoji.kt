package com.linea.messenger.avatars

import android.content.Context
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import com.airbnb.lottie.LottieComposition
import com.airbnb.lottie.LottieCompositionFactory
import com.airbnb.lottie.LottieDrawable

/** One emoji that moves (the reference's platina/AnimatedEmoji.tsx `LottieEmoji`): on Android the reference plays the
 *  bundled Noto Emoji Animation (Google, CC BY 4.0) Lottie files — mobile/assets/emoji, here res/raw/emoji_*.json —
 *  with lottie-android, the very library its Android build links. Without an animation for the emoji, while it is
 *  still loading, or with animations (or its switch) off, it is the ordinary system glyph. `loop` plays for ever,
 *  `once` once (and again on a tap with `tapToReplay`), `still` as `loop` (vector art scales cleanly).
 *  `feature`: "emoji" for statuses, "stickers" for big emoji. The view is `size` × `size`. */
class AnimatedEmojiView(context: Context) : FrameLayout(context) {
  enum class Mode { LOOP, ONCE, STILL }

  private val picture = ImageView(context)
  private val glyph = TextView(context)
  private val drawable = LottieDrawable()
  var emoji = ""
    private set
  private var mode = Mode.LOOP
  private var feature = "emoji"
  private var shownComposition: LottieComposition? = null
  var tapToReplay = false
    set(value) { field = value; isClickable = value }

  init {
    glyph.gravity = Gravity.CENTER
    glyph.includeFontPadding = false
    addView(glyph, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    picture.setImageDrawable(drawable)
    picture.scaleType = ImageView.ScaleType.FIT_CENTER
    picture.visibility = GONE
    addView(picture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    setOnClickListener { if (tapToReplay) play() }
  }

  /** `size`: the box, dp (the glyph is 0.86 of it, as the reference). */
  fun show(emoji: String, size: Float, mode: Mode = Mode.LOOP, feature: String = "emoji") {
    val same = emoji == this.emoji && mode == this.mode
    this.emoji = emoji
    this.mode = mode
    this.feature = feature
    contentDescription = emoji
    glyph.text = emoji
    glyph.textSize = size * 0.86f
    if (same && shownComposition != null) return refresh()
    shownComposition = null
    picture.visibility = GONE
    glyph.visibility = VISIBLE
    val id = resource(context, emoji)
    if (id == 0 || !AvatarMotion.feature(feature, context)) return
    val asked = emoji
    LottieCompositionFactory.fromRawRes(context, id).addListener { composition ->
      if (this.emoji != asked) return@addListener
      shownComposition = composition
      drawable.composition = composition
      refresh()
      play()
    }
  }

  private fun refresh() {
    val moving = shownComposition != null && AvatarMotion.feature(feature, context)
    picture.visibility = if (moving) VISIBLE else GONE
    glyph.visibility = if (moving) GONE else VISIBLE
    if (!moving) drawable.stop()
  }

  /** Plays from the beginning. */
  fun play() {
    if (shownComposition == null || !AvatarMotion.feature(feature, context)) return
    drawable.repeatCount = if (mode == Mode.ONCE) 0 else LottieDrawable.INFINITE
    drawable.progress = 0f
    drawable.playAnimation()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (shownComposition != null && mode != Mode.ONCE) play()
  }

  override fun onDetachedFromWindow() {
    drawable.stop()
    super.onDetachedFromWindow()
  }

  companion object {
    /** The raw resource of an emoji's animation, tolerant to a missing or extra U+FE0F (0: none). */
    fun resource(context: Context, emoji: String): Int {
      for (name in names(emoji)) {
        val id = context.resources.getIdentifier(name, "raw", context.packageName)
        if (id != 0) return id
      }
      return 0
    }

    /** The resource names to try for an emoji: as it is, without U+FE0F, with it added. */
    fun names(emoji: String): List<String> {
      val points = emoji.codePoints().toArray().map { Integer.toHexString(it) }
      val bare = points.filter { it != "fe0f" }
      return listOf(points, bare, bare + "fe0f").distinct().filter { it.isNotEmpty() }.map { "emoji_" + it.joinToString("_") }
    }
  }
}
