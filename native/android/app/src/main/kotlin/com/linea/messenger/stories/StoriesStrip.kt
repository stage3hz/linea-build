package com.linea.messenger.stories

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.text.TextUtils
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.chats.ChatListView
import com.linea.messenger.design.Theme
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.people.personAvatarAddress
import com.linea.messenger.people.preparePersonAvatars
import java.lang.ref.WeakReference

// The strip above the chats (the reference's stories/StoriesStrip.tsx): «Моя история» first — a «+» adds one —
// then the people who have a live story or published a post in the last two days: those with something not yet
// seen first, with a lit ring; all seen, a grey ring. A person this account has only sent a request to carries a
// small clock and «заявка»; one shown for a post, «запись». The strip is not there at all while nobody has
// anything. Who is in it is the server's decision; the order and the words are the core's.
//
// The strip is the header of the chats' list, so it scrolls away with them. Its cells are kept and shown again
// with other people; the pictures of people come through the avatars' own loader, decoded off the main thread.

class StoryStripCell(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val ring = StoryRingView(context)
  private val avatar = PersonAvatarView(context)
  private val badge = StoryIconView(context, "plus", 12f, Theme.onAccent)
  private val spinner = ProgressBar(context)
  private val nameLabel = TextView(context)
  private val subLabel = TextView(context)
  /** «+» on «Моя история» was pressed. */
  var onAdd: (() -> Unit)? = null

  init {
    addView(ring)
    addView(avatar)
    badge.setOnClickListener { onAdd?.invoke() }
    addView(badge)
    spinner.isIndeterminate = true
    spinner.visibility = View.GONE
    addView(spinner)
    for ((label, size, weight) in listOf(Triple(nameLabel, 12f, 600), Triple(subLabel, 11f, 400))) {
      label.textSize = size
      label.typeface = Theme.weight(weight)
      label.gravity = Gravity.CENTER
      label.maxLines = 1
      label.ellipsize = TextUtils.TruncateAt.END
      label.includeFontPadding = false
      label.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
      addView(label)
    }
    isClickable = true
    isFocusable = true
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    alpha = if (pressed) 0.75f else 1f
  }

  /** «Моя история»: the ring only when there is a story; «+» always (a spinner while one is being added). */
  fun showMine(person: Person?, address: String, has: Boolean, spoken: String, busy: Boolean) {
    val shown = person ?: Person("", "", "", "", "", 0x5E7BFF, "")
    avatar.show(shown, address)
    ring.visibility = if (has) View.VISIBLE else View.INVISIBLE
    ring.show(shown.avatarColor, fresh = true)
    badge.visibility = View.VISIBLE
    badge.isClickable = !busy
    badge.disc = Theme.accent
    badge.rim = Theme.bg
    badge.color = Theme.onAccent
    badge.symbol = if (busy) "" else "plus"
    badge.contentDescription = StoryRules.word("addStory")
    badge.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    spinner.indeterminateTintList = ColorStateList.valueOf(Theme.onAccent)
    spinner.visibility = if (busy) View.VISIBLE else View.GONE
    nameLabel.text = StoryRules.word("mine")
    nameLabel.setTextColor(Theme.text)
    subLabel.text = ""
    contentDescription = spoken
  }

  fun show(entry: StripEntry, address: String) {
    avatar.show(entry.person, address)
    ring.visibility = View.VISIBLE
    ring.show(entry.person.avatarColor, entry.fresh)
    // Not a friend yet: the request to this person is still waiting.
    badge.visibility = if (entry.pending) View.VISIBLE else View.GONE
    badge.isClickable = false
    badge.disc = Theme.surface2 or 0xFF000000.toInt()
    badge.rim = Theme.bg
    badge.color = Theme.muted
    badge.symbol = "clock"
    badge.contentDescription = null
    badge.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    spinner.visibility = View.GONE
    nameLabel.text = entry.name
    nameLabel.setTextColor(Theme.text)
    subLabel.text = entry.sub
    subLabel.setTextColor(Theme.muted)
    contentDescription = entry.spoken
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(dp(WIDTH), dp(HEIGHT))

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    view.layout(left, top, left + width, top + height)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    val side = dp(68f); val boxLeft = (width - side) / 2
    put(ring, boxLeft, 0, side, side)
    put(avatar, boxLeft + dp(6f), dp(6f), side - dp(12f), side - dp(12f))
    put(badge, boxLeft + side - dp(22f), side - dp(22f), dp(22f), dp(22f))
    put(spinner, boxLeft + side - dp(18f), side - dp(18f), dp(14f), dp(14f))
    put(nameLabel, dp(4f), dp(73f), width - dp(8f), dp(15f))
    put(subLabel, dp(4f), dp(89f), width - dp(8f), dp(13f))
  }

  companion object {
    const val WIDTH = 80f
    const val HEIGHT = 102f
  }
}

/** The strip and what its taps do. Made by the chats' screen, which hands over the list in `install` and says
 *  in `place` whether the strip may be shown. Main thread only. */
class StoriesStrip(private val context: Context, private val messenger: Messenger?) {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var host: View? = null
  private var list: ChatListView? = null
  private val holder = FrameLayout(context)
  private val scroller = HorizontalScrollView(context)
  private val row = LinearLayout(context)
  private val cells = ArrayList<StoryStripCell>()
  private var publisher: StoryPublisher? = null
  private var viewer: StoryViewer? = null
  private var allowed = true
  private var shown = false
  private val storeChanged: (Unit) -> Unit = { reload(); apply() }

  private val store: StoriesStore get() = StoriesStore

  @SuppressLint("ClickableViewAccessibility")
  fun install(host: View, list: ChatListView) {
    this.host = host
    this.list = list
    scroller.isHorizontalScrollBarEnabled = false
    scroller.overScrollMode = View.OVER_SCROLL_ALWAYS
    scroller.clipToPadding = false
    row.orientation = LinearLayout.HORIZONTAL
    row.setPadding(dp(12f), 0, dp(12f), 0)
    scroller.addView(row, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(StoryStripCell.HEIGHT)))
    holder.addView(scroller, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(StoryStripCell.HEIGHT)))
    holder.layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, dp(HEIGHT))
    // The strip listens while the chats' screen is in the window.
    host.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(view: View) { store.changed.watch(storeChanged); storeChanged(Unit) }
      override fun onViewDetachedFromWindow(view: View) { store.changed.unwatch(storeChanged) }
    })
    if (host.isAttachedToWindow) store.changed.watch(storeChanged)
    if (messenger != null) {
      messenger.preparePersonAvatars()
      val made = StoryPublisher(messenger)
      made.onPublished = { StoriesStore.refresh() }
      publisher = made
    }
    store.start(context, messenger)
    current = WeakReference(this)
  }

  /** From the screen's layout. `allowed`: not in «Архив» and not while searching (as in the reference). */
  fun place(allowed: Boolean) {
    this.allowed = allowed
    apply()
  }

  private fun apply() {
    val want = allowed && store.show
    if (want == shown) return
    shown = want
    list?.setHeader(if (want) holder else null)
  }

  // The cells

  private fun address(person: Person?): String = if (person == null || messenger == null) "" else messenger.personAvatarAddress(person.avatarId)

  private fun reload() {
    val people = store.people
    val wanted = 1 + people.size
    while (cells.size < wanted) {
      val cell = StoryStripCell(context)
      cells.add(cell)
      row.addView(cell, LinearLayout.LayoutParams(dp(StoryStripCell.WIDTH), dp(StoryStripCell.HEIGHT)).apply { leftMargin = if (cells.size == 1) 0 else dp(6f) })
    }
    while (cells.size > wanted) row.removeView(cells.removeAt(cells.size - 1))
    cells.forEachIndexed { index, cell ->
      if (index == 0) {
        cell.showMine(store.me, address(store.me), store.mineHas, store.mineSpoken, busy = false)
        cell.onAdd = { add() }
        cell.setOnClickListener { pressed(cell); if (store.mineHas) open(store.myId) else add() }
        // Holding «Моя история» adds one, as a tap on «+» does.
        cell.setOnLongClickListener { add(); true }
      } else {
        val entry = people[index - 1]
        cell.show(entry, address(entry.person))
        cell.onAdd = null
        cell.setOnClickListener { pressed(cell); open(entry.person.id) }
        cell.setOnLongClickListener(null)
        cell.isLongClickable = false
      }
    }
  }

  private fun pressed(cell: View) { cell.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }

  // What the taps do

  private fun add() {
    val host = host ?: return
    if (viewer?.isShowing == true) return
    publisher?.begin("story", host)
  }

  /** Opens the viewer on a person of the strip (the account's own id: «Моя история»). */
  fun open(id: String): StoryViewer? {
    if (host?.isAttachedToWindow != true || viewer?.isShowing == true) return null
    val group = store.group(id, entered = 1) ?: return null
    val made = StoryViewer(context, group)
    // At the end of one person's stories the viewer runs on to the next; before the first, back to the previous.
    made.neighbour = { key, step -> StoriesStore.neighbour(key, step) }
    made.onWatched = { key, post -> StoriesStore.watched(key, post) }
    made.onOpened = { post -> StoriesStore.opened(post) }
    if (messenger != null) {
      val account = WeakReference(messenger)
      made.avatarAddress = { person -> account.get()?.personAvatarAddress(person.avatarId) ?: "" }
      made.onReply = { authorId, post, text, done ->
        val messenger = account.get()
        if (messenger == null) done(StoryRules.word("replyFailed")) else messenger.replyToStory(authorId, post.id, text, done)
      }
      made.loadViewers = { post, done ->
        val messenger = account.get()
        if (messenger == null) done(null) else messenger.storyViewers(post.id) { result -> done(result.getOrNull()) }
      }
    }
    StoriesDemo.dress(made)
    viewer = made
    made.show()
    return made
  }

  /** For the emulator check: the first person's stories (or the account's own when nobody else has any). */
  fun emulatorOpenFirst(): Boolean {
    store.people.firstOrNull()?.let { return open(it.person.id) != null }
    if (store.mineHas) return open(store.myId) != null
    return false
  }

  companion object {
    /** The room the strip takes above the first chat, dp. */
    const val HEIGHT = StoryStripCell.HEIGHT + 6f

    /** For the emulator check: the strip of the chats' screen. */
    var current = WeakReference<StoriesStrip>(null)
      private set
  }
}
