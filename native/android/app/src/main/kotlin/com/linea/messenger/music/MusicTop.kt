package com.linea.messenger.music

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.ai.AIIconView
import com.linea.messenger.ai.AIKit
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.settings.ThemeStore

/** F: the parts of the top of «Музыка» as the reference draws them (MusicScreen.tsx; iOS Music/MusicViewController.swift):
 *  the colours on the cold ambient, the tabs as a plain row, the source on a quiet well, the tall mood chips, and the
 *  box that holds the top and centres «Слушать микс» in what is left of it. */
object MusicInk {
  /** The reference's `ink` (titles and the chosen tab on the ambient), `inkInverse` (the chosen tab's words), `soft`. */
  val ink: Int get() = if (Theme.dark) Color.WHITE else 0xFF14243D.toInt()
  val inkInverse: Int get() = if (Theme.dark) 0xFF0A1529.toInt() else Color.WHITE
  val soft: Int get() = if (Theme.dark) 0xFFD2DEF2.toInt() else 0xFF4A5D7D.toInt()

  /** The height of the top from the screen's top, dp: most of the top half on «Главная» without a search, 132 otherwise. */
  fun headHeight(catalog: Boolean, searching: Boolean, screenHeight: Float): Float = if (catalog && !searching) minOf(430f, screenHeight * 0.5f) else 132f
}

/** The tabs: a plain row (gap 6), the chosen one on an `ink` pill (radius 12, 14 × 7 inside), 16 sp words. */
@SuppressLint("ViewConstructor")
class MusicTabs(context: Context, labels: List<String>) : LinearLayout(context) {
  var onPick: ((Int) -> Unit)? = null
  private val buttons = ArrayList<TextView>()
  var chosen = 0
    set(value) { field = value; paint() }

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    labels.forEachIndexed { index, label ->
      val button = AIKit.label(context, label, 16f, 600, lines = 1, align = Gravity.CENTER)
      button.setPadding(context.px(14f), context.px(7f), context.px(14f), context.px(7f))
      button.isClickable = true
      button.isFocusable = true
      button.contentDescription = label
      button.setOnClickListener { if (index != chosen) { chosen = index; onPick?.invoke(index) } }
      buttons.add(button)
      addView(button, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { if (index > 0) marginStart = context.px(6f) })
    }
    paint()
  }

  private fun paint() {
    buttons.forEachIndexed { index, button ->
      val on = index == chosen
      button.setTextColor(if (on) MusicInk.inkInverse else MusicInk.soft)
      button.typeface = Theme.weight(if (on) 700 else 600)
      button.background = if (on) context.plate(MusicInk.ink, 12f) else null
      button.isSelected = on
    }
  }
}

/** The source: SoundCloud | Audius on a quiet well (radius 16, 3 inside), the chosen one lighter (radius 13). */
@SuppressLint("ViewConstructor")
class MusicSourceSwitch(context: Context, labels: List<String>, spoken: String) : LinearLayout(context) {
  var onPick: ((Int) -> Unit)? = null
  private val buttons = ArrayList<TextView>()
  var chosen = 0
    set(value) { field = value; paint() }

  init {
    orientation = HORIZONTAL
    background = context.plate(if (Theme.dark) 0x14FFFFFF else 0x0F14243D, 16f)
    setPadding(context.px(3f), context.px(3f), context.px(3f), context.px(3f))
    contentDescription = spoken
    labels.forEachIndexed { index, label ->
      val button = AIKit.label(context, label, 15f, 600, lines = 1, align = Gravity.CENTER)
      button.isClickable = true
      button.isFocusable = true
      button.contentDescription = "$spoken: $label"
      button.setOnClickListener { if (index != chosen) { chosen = index; onPick?.invoke(index) } }
      buttons.add(button)
      addView(button, LayoutParams(0, context.px(40f), 1f))
    }
    paint()
  }

  private fun paint() {
    buttons.forEachIndexed { index, button ->
      val on = index == chosen
      button.setTextColor(if (on) MusicInk.ink else MusicInk.soft)
      button.typeface = Theme.weight(if (on) 700 else 600)
      button.background = if (on) context.plate(if (Theme.dark) 0x29FFFFFF else Color.WHITE, 13f) else null
      button.isSelected = on
    }
  }
}

/** A mood: a tall chip (at least 62 × 100, radius 21, 16 inside, a hairline), the icon (15) over the name (11). */
@SuppressLint("ViewConstructor")
class MusicMoodChip(context: Context, label: String, symbol: String, selected: Boolean) : LinearLayout(context) {
  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_VERTICAL or Gravity.START
    minimumWidth = context.px(100f)
    setPadding(context.px(16f), 0, context.px(16f), 0)
    background = context.plate(if (selected) ThemeStore.look.accentSoft else Theme.veil(0.04f), 21f, if (selected) Theme.accent else ThemeStore.look.border).apply {
      setStroke(context.px(1f), if (selected) Theme.accent else ThemeStore.look.border)
    }
    addView(AIIconView(context, symbol, 15f, if (selected) Theme.accent else Theme.muted), LayoutParams(context.px(18f), context.px(18f)))
    addView(AIKit.label(context, label, 11f, 600, if (selected) Theme.accent else Theme.text, lines = 1), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(5f) })
    isClickable = true
    isFocusable = true
    isSelected = selected
    contentDescription = label
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
}

/** The top of the page: `stack` (title row, tabs, source) at the top, `hero` («Слушать микс») centred in what is left
 *  of `wanted` px, 10 dp above the lower edge. As tall as `wanted`, or the stack when that is taller. */
@SuppressLint("ViewConstructor")
class MusicHeadBox(context: Context, private val stack: View, private val hero: View) : ViewGroup(context) {
  var wanted = 0
    set(value) { if (field != value) { field = value; requestLayout() } }

  init {
    clipChildren = false
    addView(stack)
    addView(hero)
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    stack.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    hero.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    setMeasuredDimension(width, maxOf(wanted, stack.measuredHeight))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    stack.layout(0, 0, width, stack.measuredHeight)
    if (hero.visibility == GONE) return
    val spaceTop = stack.measuredHeight; val spaceBottom = (b - t) - context.px(10f)
    val cy = (spaceTop + spaceBottom) / 2
    val left = (width - hero.measuredWidth) / 2
    val top = cy - hero.measuredHeight / 2
    hero.layout(left, top, left + hero.measuredWidth, top + hero.measuredHeight)
  }
}
