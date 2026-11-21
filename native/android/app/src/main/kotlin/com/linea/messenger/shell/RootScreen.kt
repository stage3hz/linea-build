package com.linea.messenger.shell

import android.content.Context
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.chats.ChatsScreen
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import com.linea.messenger.settings.SettingsScreen

/** The app's shell: the sections one over another, and the bar at the bottom that chooses between them. */
class RootScreen(context: Context, private val openChat: (name: String) -> Unit) : Screen(context) {
  private class Section(val id: String, val label: String, val symbol: String, val make: (Context) -> View)

  private val sections = listOf(
    Section("chats", "Чаты", "chats") { ChatsScreen(it, openChat) },
    Section("ai", "AI", "sparkles") { PlaceholderScreen(it, "AI") },
    Section("people", "Люди", "people") { PlaceholderScreen(it, "Люди") },
    Section("channels", "Каналы", "waves") { PlaceholderScreen(it, "Каналы") },
    Section("music", "Музыка", "headphones") { PlaceholderScreen(it, "Музыка") },
    Section("profile", "Настройки", "gear") { SettingsScreen(it) },
  )
  /** The two sections that have an icon in the bar; the others are in the list under the first one. */
  private val inBar = listOf("chats", "profile")

  private val bar = TabBarView(context)
  private val stage = GlassSource(context)
  private val pages = HashMap<String, View>()
  var open = ""
    private set
  /** The section that was open when a preview from the list began: a cancelled list goes back to it. */
  private var beforePreview: String? = null

  /** The list of sections opened or closed. */
  var onSectionsChange: (open: Boolean) -> Unit = {}
  val sectionsOpen: Boolean get() = bar.listOpen

  init {
    setBackgroundColor(Theme.bg)
    addView(stage)
    bar.setItems(sections.map { TabEntry(it.id, it.label, it.symbol) })
    bar.setBar(inBar)
    bar.moreWords = "Остальные разделы"
    bar.behind = stage
    bar.onSelect = { id ->
      beforePreview = null
      show(id)
    }
    bar.onPreview = { id ->
      if (id.isEmpty()) beforePreview?.let { back -> beforePreview = null; show(back) }
      else { if (beforePreview == null) beforePreview = open; show(id, quiet = true) }
    }
    bar.onListChange = { onSectionsChange(it) }
    addView(bar)
    show("chats")
  }

  override fun place(width: Int, height: Int) {
    put(stage, 0, 0, width, height)
    val gap = dp(BarMetrics.bottomGap(edges.bottom / d))
    val wide = minOf(dp(BarMetrics.width), width); val tall = dp(BarMetrics.height)
    put(bar, (width - wide) / 2, height - gap - tall, wide, tall)
  }

  /** Opens a section. `quiet`: a look from the list — the bar's own choice stays where it is. */
  fun show(id: String, quiet: Boolean = false) {
    if (id == open) return
    val section = sections.firstOrNull { it.id == id } ?: return
    val next = pages.getOrPut(id) { section.make(context) }
    val previous = pages[open]
    next.animate().cancel()
    if (next.parent == null) stage.addView(next, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    else stage.bringChildToFront(next)
    open = id
    if (!quiet) bar.setActive(id)
    if (previous == null) { next.alpha = 1f; return }
    next.alpha = 0f
    next.animate().alpha(1f).setDuration(160).start()
    previous.animate().alpha(0f).setDuration(160).withEndAction { if (pages[open] !== previous) stage.removeView(previous) }.start()
  }

  /** The list of the sections without an icon (for a check on the emulator and for accessibility). */
  fun showSections() = bar.openList(sticky = true)

  fun closeSections() = bar.closeList()
}

/** A section that is not built yet: its name on the page, nothing else. */
class PlaceholderScreen(context: Context, title: String) : Screen(context) {
  private val heading = TextView(context).apply {
    text = title
    textSize = 34f
    typeface = Theme.weight(700)
    setTextColor(Theme.text)
    includeFontPadding = false
  }

  init {
    setBackgroundColor(Theme.bg)
    addView(heading)
  }

  override fun place(width: Int, height: Int) {
    putText(heading, dp(20f), edges.top + dp(8f), width - dp(40f))
  }
}
