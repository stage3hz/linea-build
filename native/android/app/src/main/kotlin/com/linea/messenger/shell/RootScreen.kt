package com.linea.messenger.shell

import android.annotation.SuppressLint
import android.content.Context
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.ai.AIScreen
import com.linea.messenger.app.ChatTarget
import com.linea.messenger.app.Messenger
import com.linea.messenger.channels.ChannelsScreen
import com.linea.messenger.channels.ChannelsStore
import com.linea.messenger.chats.ChatsScreen
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import com.linea.messenger.music.MusicGlow
import com.linea.messenger.music.MusicScreen
import com.linea.messenger.people.FriendRequests
import com.linea.messenger.people.PeopleScreen
import com.linea.messenger.settings.SettingsScreen

/** The app's shell: the sections one over another, and the bar at the bottom that chooses between them.
 *  `messenger` is the signed-in account; without one the chats are the debug build's samples. */
@SuppressLint("ViewConstructor")
class RootScreen(context: Context, private val messenger: Messenger?, private val openChat: (ChatTarget) -> Unit) : Screen(context) {
  private class Section(val id: String, val label: String, val symbol: String, val make: (Context) -> View)

  private val sections = listOf(
    Section("chats", "Чаты", "chats") { ChatsScreen(it, messenger, openChat) },
    Section("ai", "AI", "sparkles") { AIScreen(it, messenger) },
    Section("people", "Люди", "people") { PeopleScreen(it, messenger) },
    Section("channels", "Каналы", "waves") { ChannelsScreen(it, messenger) },
    Section("music", "Музыка", "headphones") { MusicScreen(it, messenger) },
    Section("profile", "Настройки", "gear") { SettingsScreen(it, messenger) },
  )
  /** The two sections that have an icon in the bar; the others are in the list under the first one. */
  private val inBar = listOf("chats", "profile")

  private val bar = TabBarView(context)
  private val stage = GlassSource(context)
  private val pages = HashMap<String, View>()
  /** Shell: what the shell lays over the sections besides the bar (shell/ShellExtras.kt). */
  private var extras: ShellExtras? = null
  var open = ""
    private set
  /** The section that was open when a preview from the list began: a cancelled list goes back to it. */
  private var beforePreview: String? = null

  /** The list of sections opened or closed. */
  var onSectionsChange: (open: Boolean) -> Unit = {}
  /** Shell: another section came on screen (the system's Back from a section goes to «Чаты»). */
  var onSectionChange: (id: String) -> Unit = {}
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
    bar.onListChange = { extras?.listChanged(it); onSectionsChange(it) }
    addView(bar)
    // Shell: the mini-player, the soft edges, the words about the hold and the update window (shell/ShellExtras.kt).
    extras = ShellExtras(this, bar, messenger)
    show("chats")
    // People: the requests to be friends of this account (people/PeopleServer.kt).
    FriendRequests.start(messenger)
    // Avatars / Profile / Platina: the motion policy, the chat list's plates and still frames, the account's Platina
    // (confetti on a grant) and the friends' birthday reminders (avatars/, platina/PlatinaState.kt, profile/Birthdays.kt).
    com.linea.messenger.avatars.AvatarMotion.attach(context)
    com.linea.messenger.avatars.ChatListDecor.install(context)
    com.linea.messenger.platina.PlatinaState.start(messenger, this)
    com.linea.messenger.profile.BirthdayReminders.start(messenger, this)
    // Music: the bar is lit by the playing track's cover (music/CoverTint.kt).
    MusicGlow.attach(this)
    // Channels: what is unread in the communities of this account (channels/ChannelsStore.kt).
    ChannelsStore.start(context, messenger)
    // Calls: the call screen and the bar of a minimised call, over every section (calls/CallOverlay.kt).
    com.linea.messenger.calls.CallOverlay.start(context, messenger)
    // Rooms: the list of rooms, the ring and the bar of the room this phone is in (rooms/); the quiet dot on
    // «Каналы» while somebody is inside one of them.
    com.linea.messenger.rooms.Rooms.start(context, messenger)
    com.linea.messenger.rooms.RoomMusic.start(context)
    com.linea.messenger.rooms.RoomOverlay.start(context)
  }

  /** People: the number of requests to be friends on the row of «Люди». */
  private val peopleBadge: (Unit) -> Unit = {
    // Rooms: a quiet green dot on «Каналы» while somebody is inside one of the rooms.
    val roomsDot = if (com.linea.messenger.rooms.Rooms.awake) com.linea.messenger.rooms.RoomRules.talkHex else ""
    // ChatsPlus: the unread of the chats on «Чаты» (chatsplus/ChatListStatus.kt, UnreadTotal).
    bar.setItems(sections.map { TabEntry(it.id, it.label, it.symbol, badge = if (it.id == "people") FriendRequests.incoming.size else if (it.id == "channels") ChannelsStore.badge else if (it.id == "chats") com.linea.messenger.chatsplus.UnreadTotal.total else 0, dot = if (it.id == "channels") roomsDot else "") })
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    FriendRequests.changed.watch(peopleBadge)
    ChannelsStore.changed.watch(peopleBadge)
    com.linea.messenger.rooms.Rooms.changed.watch(peopleBadge)
    com.linea.messenger.chatsplus.UnreadTotal.changed.watch(peopleBadge) // ChatsPlus
    extras?.attached() // Shell
    peopleBadge(Unit)
  }

  override fun onDetachedFromWindow() {
    FriendRequests.changed.unwatch(peopleBadge)
    ChannelsStore.changed.unwatch(peopleBadge)
    com.linea.messenger.rooms.Rooms.changed.unwatch(peopleBadge)
    com.linea.messenger.chatsplus.UnreadTotal.changed.unwatch(peopleBadge) // ChatsPlus
    extras?.detached() // Shell
    super.onDetachedFromWindow()
  }

  /** For the emulator check: the «Люди» section, once it has been opened. */
  fun peoplePage(): PeopleScreen? = pages["people"] as? PeopleScreen

  override fun place(width: Int, height: Int) {
    put(stage, 0, 0, width, height)
    val gap = dp(BarMetrics.bottomGap(edges.bottom / d))
    val wide = minOf(dp(BarMetrics.width), width); val tall = dp(BarMetrics.height)
    put(bar, (width - wide) / 2, height - gap - tall, wide, tall)
    extras?.place(width, height, height - gap - tall, gap, edges.top) // Shell
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
    extras?.sectionShown(id) // Shell: «Музыка» shows its own player
    onSectionChange(id)
    if (previous == null) { next.alpha = 1f; return }
    next.alpha = 0f
    next.animate().alpha(1f).setDuration(160).start()
    previous.animate().alpha(0f).setDuration(160).withEndAction { if (pages[open] !== previous) stage.removeView(previous) }.start()
  }

  /** Shell: the bar, its edge and the mini-player give way (the chat list while choosing chats). */
  fun setBarAway(away: Boolean) { extras?.setBarAway(away); backChanged() }

  /** Shell: what the system's Back would do inside the shell has changed (see `wantsBack`). */
  fun backChanged() = onSectionChange(open)

  /** Shell: the system's Back has somewhere to go inside the shell — the chat list's choosing, the optional update
   *  window, or «Чаты» from another section (the reference's App.tsx: `page !== 'chats'` → «Чаты»). */
  val wantsBack: Boolean get() = UpdateGate.optionalShown || open != "chats" || (pages["chats"] as? ChatsScreen)?.selecting == true

  /** Shell: what the system's Back does inside the shell (see `wantsBack`). False: nothing to do here. */
  fun back(): Boolean {
    if (UpdateGate.optionalShown) { UpdateGate.dismissUpdate(); return true }
    if (open != "chats") { show("chats"); return true }
    (pages["chats"] as? ChatsScreen)?.let { if (it.selecting) { it.endSelecting(); return true } }
    return false
  }

  /** Settings: the same shell built again, for a theme that has just been put on (settings/ThemeStore.kt). */
  fun rebuilt(): RootScreen = RootScreen(context, messenger, openChat)

  /** Music: three colours of the playing track's cover for the bar's light; an empty list restores the calm silver. */
  fun setBarGlow(hexes: List<String>) = bar.setGlow(hexes)

  /** The list of the sections without an icon (for a check on the emulator and for accessibility). */
  fun showSections() = bar.openList(sticky = true)

  fun closeSections() = bar.closeList()

  /** For the emulator check: the «Каналы» section, once it has been opened. */
  fun channelsPage(): ChannelsScreen? = pages["channels"] as? ChannelsScreen

  /** For the emulator check: the «Настройки» section, once it has been opened. */
  fun settingsPage(): SettingsScreen? = pages["profile"] as? SettingsScreen

  /** Effects: the section on the screen now (the falling snow and the trail lie behind its content, effects/EffectsHost.kt). */
  fun shownSection(): View? = pages[open]

  /** Opens the first chat of the list (for a check on the emulator). */
  fun openFirstChat() { (pages["chats"] as? ChatsScreen)?.openFirst() }
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
