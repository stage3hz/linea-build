package com.linea.messenger.shell

import android.view.View
import com.linea.messenger.app.Messenger
import com.linea.messenger.chatsplus.BarHintView
import com.linea.messenger.music.MiniPlayerView
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.music.PlayerScreen
import com.linea.messenger.people.pages

/** Shell: what the shell lays over its sections besides the bar (native/ios/Sources/Shell/RootViewController.swift,
 *  its «Shell» and «ChatsPlus» parts): the mini-player over every section but «Музыка», the soft edges under the bar
 *  and under the status bar, the words about the hold above the bar, the bar giving way while the chat list chooses
 *  chats, and the update window over everything. Main thread only. */
class ShellExtras(private val root: RootScreen, private val bar: View, messenger: Messenger?) {
  private val context = root.context
  private val d = context.resources.displayMetrics.density
  private val player = MusicPlayer.shared
  private val mini = MiniPlayerView(context, player)
  private val barEdge = TabBarEdgeView(context)
  private val statusStrip = StatusStripView(context)
  /** «Удержи «Чаты» — остальные разделы» until the hold has been used (chatsplus/BarHint.kt). */
  val hint = BarHintView(context)
  var barAway = false
    private set
  private var open = ""
  private val playerChanged: () -> Unit = { refreshMini() }

  init {
    // The edges and the mini-player stand under the bar, over the sections.
    val at = root.indexOfChild(bar)
    root.addView(barEdge, at)
    root.addView(statusStrip, at + 1)
    root.addView(mini, at + 2)
    // EdgeFade: the edges blur the section behind them (the stage the bar's glass shows, shell/EdgeFade.kt).
    (bar as? TabBarView)?.behind?.let { stage -> barEdge.glass = stage; statusStrip.glass = stage }
    root.addView(hint)
    mini.onOpen = { openPlayer() }
    player.changed.watch(playerChanged)
    UpdateGate.onChange = { root.backChanged() }
    root.post { UpdateGate.start(messenger, root) }
    refreshMini()
  }

  fun detached() { player.changed.unwatch(playerChanged) }
  fun attached() { player.changed.watch(playerChanged); refreshMini() }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** `barTop`: where the bar's upper edge is, px; `lift`: the bar's lower edge above the screen's bottom, px. */
  fun place(width: Int, height: Int, barTop: Int, lift: Int, safeTop: Int) {
    val miniTop = barTop - Math.round((ShellInsets.miniGap + ShellInsets.miniHeight) * d)
    put(mini, Math.round(12 * d), miniTop, width - Math.round(24 * d), Math.round(ShellInsets.miniHeight * d))
    // The tab block: the pill, its 5 dp margin above, the mini-player when it is shown.
    val block = height - barTop + Math.round(5 * d) + Math.round(ShellInsets.miniPlayer * d)
    barEdge.place(width, height, block, lift)
    statusStrip.place(width, safeTop)
    // The hint about the hold stands above the whole block (above the mini-player when it is there).
    val above = if (mini.visibility == View.VISIBLE && ShellInsets.miniPlayer > 0) miniTop else barTop
    val wide = hint.wide()
    put(hint, (width - wide) / 2, above - Math.round(3 * d) - Math.round(28 * d), wide, Math.round(28 * d))
  }

  /** A section was opened: «Музыка» shows its own player. */
  fun sectionShown(id: String) {
    open = id
    refreshMini()
  }

  /** The list of the other sections was opened: the hold has been learnt, the words above the bar go. */
  fun listChanged(opened: Boolean) { if (opened) hint.used() }

  /** The mini-player is shown while a track is chosen, everywhere but «Музыка» and while the bar is away; the
   *  sections are told the room it takes. */
  private fun refreshMini() {
    val visible = !barAway && open != "music" && player.current != null
    mini.visibility = if (visible) View.VISIBLE else View.GONE
    val room = if (visible) ShellInsets.miniHeight + ShellInsets.miniGap else 0f
    if (room == ShellInsets.miniPlayer) return
    ShellInsets.miniPlayer = room
    root.requestLayout()
    ShellInsets.changed.post(Unit)
  }

  private fun openPlayer() {
    val stack = root.pages() ?: return
    if (stack.top is PlayerScreen || player.current == null) return
    stack.push(PlayerScreen(context, player), animated = false) // it slides up by itself
  }

  /** The bar, its edge and the mini-player give way (the chat list while choosing chats: its own actions stand there). */
  fun setBarAway(away: Boolean) {
    if (away == barAway) return
    barAway = away
    for (view in listOf(bar, barEdge, hint)) view.animate().alpha(if (away) 0f else 1f).setDuration(180).start()
    bar.isEnabled = !away
    bar.visibility = View.VISIBLE
    if (away) bar.postDelayed({ if (barAway) bar.visibility = View.INVISIBLE }, 180)
    refreshMini()
  }
}
