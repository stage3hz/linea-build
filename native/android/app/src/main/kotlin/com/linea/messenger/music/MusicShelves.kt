package com.linea.messenger.music

import android.content.Context
import android.graphics.Canvas
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Rect
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import com.linea.messenger.ai.AIKit
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px

/** The shelves of «Главная» (mobile/src/music/MusicScreen.tsx: `Shelf`, `CoverCard`, `ArtistCircle`; iOS
 *  Music/MusicShelves.swift): a 24 dp bold title and a row of cards that scrolls sideways — «Любимое» (covers come first)
 *  and «Артисты» (round, the first track of each artist in the list gives the picture; a touch searches for the artist). */
object MusicShelves {
  /** Spotify's Mist #B3B3B3 for artist names on dark surfaces; the theme's grey on light ones. */
  val mist: Int get() = if (Theme.dark) 0xFFB3B3B3.toInt() else Theme.muted

  /** The artists of a list: the first track of each (by name, case and spaces aside), at most twelve. */
  fun artists(rows: List<MusicTrack>): List<MusicTrack> {
    val seen = HashSet<String>()
    val out = ArrayList<MusicTrack>()
    for (track in rows) {
      val key = track.artist.trim().lowercase()
      if (key.isEmpty() || !seen.add(key)) continue
      out.add(track)
      if (out.size == 12) break
    }
    return out
  }

  /** A shelf: the title, then the cards; the row runs to the screen's edges (`edge` — the page's side margin, dp). */
  fun shelf(context: Context, title: String, cards: List<View>, edge: Float): View {
    val box = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    val heading = AIKit.label(context, title, 24f, 700, lines = 1)
    if (android.os.Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true
    box.addView(heading)
    val scroll = HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; clipToPadding = false; setPadding(context.px(edge), 0, context.px(edge), 0) }
    val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    cards.forEachIndexed { index, card -> row.addView(card, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { if (index > 0) leftMargin = context.px(12f) }) }
    scroll.addView(row)
    box.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(14f); leftMargin = -context.px(edge); rightMargin = -context.px(edge) })
    return box
  }

  /** «Covers come first»: a near-square cover (radius 6) with the title and the artist under it. */
  fun coverCard(context: Context, track: MusicTrack, action: () -> Unit): View {
    val card = PressCard(context)
    card.contentDescription = "Слушать: ${track.title}, ${track.artist}"
    val cover = MusicCoverView(context, 6f).also { it.bind(track) }
    card.addView(cover, LinearLayout.LayoutParams(context.px(140f), context.px(140f)))
    card.addView(AIKit.label(context, track.title, 14f, 600, lines = 1), LinearLayout.LayoutParams(context.px(140f), LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(6f) })
    card.addView(AIKit.label(context, track.artist, 13f, color = mist, lines = 1), LinearLayout.LayoutParams(context.px(140f), LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(6f) })
    card.setOnClickListener { action() }
    return card
  }

  /** Artists are round. */
  fun artistCircle(context: Context, track: MusicTrack, action: () -> Unit): View {
    val card = PressCard(context)
    card.gravity = Gravity.CENTER_HORIZONTAL
    card.contentDescription = "Найти: ${track.artist}"
    card.addView(MusicArtistFace(context, track), LinearLayout.LayoutParams(context.px(120f), context.px(120f)))
    card.addView(AIKit.label(context, track.artist, 14f, 600, lines = 1, align = Gravity.CENTER), LinearLayout.LayoutParams(context.px(120f), LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(8f) })
    card.addView(AIKit.label(context, "Артист", 12f, color = mist, lines = 1, align = Gravity.CENTER), LinearLayout.LayoutParams(context.px(120f), LinearLayout.LayoutParams.WRAP_CONTENT))
    card.setOnClickListener { action() }
    return card
  }

  /** A card: pressed, a little transparent (opacity .75). */
  private class PressCard(context: Context) : LinearLayout(context) {
    init { orientation = VERTICAL; isClickable = true; isFocusable = true }
    override fun setPressed(pressed: Boolean) { super.setPressed(pressed); alpha = if (pressed) 0.75f else 1f }
    override fun onInterceptTouchEvent(event: MotionEvent?): Boolean = false
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  }
}

/** An artist's round picture: the cover of their track, or the first letter of the name. */
class MusicArtistFace(context: Context, private val track: MusicTrack) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val letter = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; typeface = Theme.weight(700); textSize = 30 * resources.displayMetrics.density; color = Theme.text }
  private val from = Rect()
  private val into = Rect()
  private val arrived: (String) -> Unit = { id -> if (id == track.id) invalidate() }

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    outlineProvider = object : ViewOutlineProvider() { override fun getOutline(view: View, outline: Outline) = outline.setOval(0, 0, view.width, view.height) }
    clipToOutline = true
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); MusicCovers.ready.watch(arrived) }
  override fun onDetachedFromWindow() { MusicCovers.ready.unwatch(arrived); super.onDetachedFromWindow() }

  override fun onDraw(canvas: Canvas) {
    paint.color = Theme.surface2
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    val picture = MusicCovers.image(track)
    if (picture == null) {
      val initial = track.artist.trim().take(1).uppercase()
      canvas.drawText(initial, width / 2f, height / 2f - (letter.descent() + letter.ascent()) / 2, letter)
      return
    }
    val side = minOf(picture.width, picture.height)
    from.set((picture.width - side) / 2, (picture.height - side) / 2, (picture.width + side) / 2, (picture.height + side) / 2)
    into.set(0, 0, width, height)
    canvas.drawBitmap(picture, from, into, paint.apply { color = 0xFFFFFFFF.toInt() })
  }
}
