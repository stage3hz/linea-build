package com.linea.messenger.stories

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.channels.ChannelImages
import com.linea.messenger.core.Core
import com.linea.messenger.design.BusyButton
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.people.personAvatarAddress
import com.linea.messenger.settings.SettingsPage
import java.lang.ref.WeakReference

// «Публикации» and «Истории» on a profile (the reference's `PostsSection` in ProfilePosts.tsx): the photos and
// videos a person pinned to it, three in a row. Seen by friends only — or by everyone, when the person chose so in
// «Конфиденциальность» — and the server decides; a story is gone after 24 hours. On the person's own profile a
// button adds one and holding a tile removes it. A tap opens the viewer. The ring around the avatar says there
// are stories and opens them.
//
// The reference has a third tab, «Подарки»; gifts are not part of this feature and are not built here.

/** One tile of the grid. Its picture is asked for only when the tile comes near the screen. */
class StoryTileView(context: Context) : FrameLayout(context) {
  private val d = resources.displayMetrics.density
  private val picture = StoryPictureView(context)
  private val playMark = StoryIconView(context, "play", 13f, Color.WHITE)
  var post: StoryPost? = null
    private set
  private var asked = false

  init {
    setBackgroundColor(0xFF1A1D24.toInt())
    picture.scaleType = ImageView.ScaleType.CENTER_CROP
    addView(picture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(playMark, LayoutParams(Math.round(20f * d), Math.round(20f * d), Gravity.BOTTOM or Gravity.END).apply { rightMargin = Math.round(6f * d); bottomMargin = Math.round(6f * d) })
    isClickable = true
    isFocusable = true
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    alpha = if (pressed) 0.8f else 1f
  }

  fun show(next: StoryPost) {
    post = next
    asked = false
    playMark.visibility = if (next.isVideo) View.VISIBLE else View.GONE
    contentDescription = StoryRules.word(if (next.isVideo) "video" else "photo")
  }

  fun loadIfNeeded() {
    val post = post ?: return
    if (asked) return
    asked = true
    // One size for every tile, so a picture decoded once serves the grid on any phone.
    picture.show(post, 420)
  }
}

/** The arithmetic of the grid: plain, so it can be checked without a phone. */
object StoryGrid {
  /** The side of a tile (px) in a row `width` px wide. */
  fun side(width: Int, columns: Int, gap: Int): Int = (width - gap * (columns - 1)) / maxOf(1, columns)

  /** How tall the grid of `count` tiles is. */
  fun height(count: Int, side: Int, columns: Int, gap: Int): Int {
    val rows = (count + columns - 1) / maxOf(1, columns)
    return rows * side + maxOf(0, rows - 1) * gap
  }

  /** The corner of the tile at `position`. */
  fun corner(position: Int, side: Int, columns: Int, gap: Int): Pair<Int, Int> = Pair((position % columns) * (side + gap), (position / columns) * (side + gap))
}

class ProfilePostsBlock(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var host = WeakReference<View>(null)
  private var messenger: Messenger? = null
  private var userId = ""
  private var own = false
  private var data: ProfilePostsData? = null
  private var tab = "post"
  private var problem = ""
  private var tiles: List<StoryTileView> = emptyList()
  private var publisher: StoryPublisher? = null
  private var viewer: StoryViewer? = null

  private val tabsBox = View(context)
  private val postsTab = TextView(context)
  private val storiesTab = TextView(context)
  private val problemLabel = TextView(context)
  private val spinner = ProgressBar(context)
  private val lockIcon = StoryIconView(context, "lock", 22f, Theme.muted)
  private val lockLabel = TextView(context)
  private val addButton = LinearLayout(context)
  private val addLabel = TextView(context)
  private val grid = object : ViewGroup(context) {
    // The tiles are put in place by the block itself (`flow`).
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}
  }
  private val emptyEmoji = TextView(context)
  private val emptyHeading = TextView(context)
  private val emptyHint = TextView(context)
  private val emptyButton = BusyButton(context, "", Theme.accent, Theme.onAccent, 25f, 16f)
  private val ring = StoryRingDrawable(d)
  private var ringAround: ViewGroup? = null
  private var ringAvatar: View? = null
  private var ringShown = false
  private var ringColor = 0x5E7BFF
  private val scrolled = ViewTreeObserver.OnScrollChangedListener { loadVisible() }

  init {
    tabsBox.background = context.plate(Theme.surface2, 23f)
    addView(tabsBox)
    for ((button, name) in listOf(postsTab to "post", storiesTab to "story")) {
      button.textSize = 15f
      button.gravity = Gravity.CENTER
      button.maxLines = 1
      button.isClickable = true
      button.isFocusable = true
      button.setOnClickListener { tabPressed(name) }
      addView(button)
    }
    problemLabel.textSize = 14f
    problemLabel.setTextColor(Theme.danger)
    problemLabel.gravity = Gravity.CENTER
    addView(problemLabel)
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = ColorStateList.valueOf(Theme.muted)
    addView(spinner)
    addView(lockIcon)
    lockLabel.text = StoryRules.word("hidden")
    lockLabel.textSize = 14f
    lockLabel.setTextColor(Theme.muted)
    lockLabel.gravity = Gravity.CENTER
    addView(lockLabel)

    addButton.orientation = LinearLayout.HORIZONTAL
    addButton.gravity = Gravity.CENTER
    addButton.background = context.plate(Theme.surface2, 19f)
    addButton.setPadding(dp(16f), 0, dp(18f), 0)
    addButton.addView(StoryIconView(context, "plus", 13f, Theme.accent), LinearLayout.LayoutParams(dp(14f), dp(14f)).apply { rightMargin = dp(6f) })
    addLabel.textSize = 15f
    addLabel.typeface = Theme.weight(600)
    addLabel.setTextColor(Theme.accent)
    addLabel.includeFontPadding = false
    addButton.addView(addLabel)
    addButton.isClickable = true
    addButton.isFocusable = true
    addButton.setOnClickListener { addPressed() }
    addView(addButton)
    grid.background = context.plate(Color.TRANSPARENT, 14f)
    grid.clipToOutline = true
    addView(grid)

    emptyEmoji.textSize = 54f
    emptyEmoji.gravity = Gravity.CENTER
    emptyEmoji.setTextColor(Theme.text)
    addView(emptyEmoji)
    emptyHeading.textSize = 19f
    emptyHeading.typeface = Theme.weight(700)
    emptyHeading.setTextColor(Theme.text)
    emptyHeading.gravity = Gravity.CENTER
    addView(emptyHeading)
    emptyHint.textSize = 14f
    emptyHint.setTextColor(Theme.muted)
    emptyHint.gravity = Gravity.CENTER
    addView(emptyHint)
    emptyButton.onPress = { addPressed() }
    addView(emptyButton)
  }

  // Setting up

  /** `host`: a view of the page the block stands in. `avatar`: the profile's picture, to put the ring of
   *  stories around (null: no ring). */
  fun attach(host: View, messenger: Messenger?, userId: String, own: Boolean, avatar: View?) {
    this.host = WeakReference(host)
    this.messenger = messenger
    this.userId = userId
    this.own = own
    if (messenger != null && own) {
      val made = StoryPublisher(messenger)
      made.onPublished = {
        reload()
        StoriesStore.refresh()
      }
      publisher = made
    }
    val around = avatar?.parent as? ViewGroup
    if (avatar != null && around != null) {
      ringAvatar = avatar
      ringAround = around
      // The ring is drawn over the page, around the picture, wherever the page puts it.
      avatar.addOnLayoutChangeListener { view, _, _, _, _, _, _, _, _ -> ring.setBounds(view.left - dp(6f), view.top - dp(6f), view.right + dp(6f), view.bottom + dp(6f)); around.invalidate() }
      ring.setBounds(avatar.left - dp(6f), avatar.top - dp(6f), avatar.right + dp(6f), avatar.bottom + dp(6f))
      avatar.setOnClickListener { ringPressed() }
      avatar.isClickable = false
    }
    rebuild()
    reload()
  }

  /** The person's colour lights the ring. */
  fun setColor(color: Int) {
    ringColor = color
    ring.show(color, fresh = true)
    ringAround?.invalidate()
  }

  /** Reads the posts and stories again (after a change, and when the two became friends or stopped being). */
  fun reload() {
    val messenger = messenger
    if (messenger == null) {
      StoriesDemo.profile(own)?.let { data = it; rebuild() }
      return
    }
    ChannelImages.server = messenger.server
    val asked = userId
    messenger.profilePosts(asked) { result ->
      if (userId != asked) return@profilePosts
      val found = result.getOrNull()
      // As in the reference: what was shown stays; with nothing shown yet, the closed look.
      if (found != null) data = found else if (data == null) data = ProfilePostsData(visible = false, posts = emptyList(), stories = emptyList())
      rebuild()
    }
  }

  // What is shown

  private val items: List<StoryPost> get() = data?.let { if (tab == "post") it.posts else it.stories } ?: emptyList()

  /** The tab that is open: "post" or "story". */
  val shownTab: String get() = tab

  private fun rebuild() {
    val labels = (Core.view("storiesTabs", listOf(data?.posts?.size ?: 0, data?.stories?.size ?: 0)) as? List<*>)?.mapNotNull { it as? String }
      ?: listOf(StoryRules.word("tabPosts"), StoryRules.word("tabStories"))
    listOf(postsTab, storiesTab).forEachIndexed { position, button ->
      val on = (position == 0) == (tab == "post")
      button.text = labels.getOrNull(position) ?: ""
      button.setTextColor(if (on) Theme.text else Theme.muted)
      button.typeface = Theme.weight(if (on) 700 else 600)
      button.background = if (on) context.plate(Theme.veil(0.14f), 19f) else null
      button.isSelected = on
    }
    grid.removeAllViews()
    tiles = items.mapIndexed { position, post ->
      val tile = StoryTileView(context)
      tile.show(post)
      tile.setOnClickListener { tilePressed(position) }
      if (own) tile.setOnLongClickListener { tileHeld(post); true }
      grid.addView(tile)
      tile
    }
    val addWords = StoryRules.word(if (tab == "post") "addPost" else "addStory")
    addLabel.text = addWords
    addButton.contentDescription = addWords
    val empty = Core.map(Core.view("storiesEmpty", listOf(tab, own))) ?: emptyMap()
    emptyEmoji.text = empty["emoji"] as? String ?: ""
    emptyHeading.text = empty["heading"] as? String ?: ""
    emptyHint.text = empty["hint"] as? String ?: ""
    emptyButton.label = empty["button"] as? String ?: addWords
    problemLabel.text = problem

    val stories = data?.stories ?: emptyList()
    showRing(stories.isNotEmpty())
    applyShown()
    requestLayout()
    invalidate()
  }

  private fun showRing(on: Boolean) {
    val around = ringAround ?: return
    val avatar = ringAvatar ?: return
    ring.show(ringColor, fresh = true)
    avatar.isClickable = on
    avatar.contentDescription = if (on) StoryRules.word("stories") else null
    if (on == ringShown) return around.invalidate()
    ringShown = on
    if (on) around.overlay.add(ring) else around.overlay.remove(ring)
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    setMeasuredDimension(width, if (width > 0) flow(width, lay = false) else 0)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (right - left > 0) flow(right - left, lay = true)
    loadVisible()
  }

  private fun shown(view: View, on: Boolean) { view.visibility = if (on) View.VISIBLE else View.GONE }

  /** Which parts there are, for what is known now. */
  private fun applyShown() {
    val closed = data?.visible == false
    val waiting = data == null
    val has = items.isNotEmpty()
    shown(lockIcon, closed)
    shown(lockLabel, closed)
    shown(tabsBox, !closed)
    shown(postsTab, !closed)
    shown(storiesTab, !closed)
    shown(problemLabel, !closed && problem.isNotEmpty())
    shown(grid, !closed && !waiting && has)
    shown(addButton, !closed && !waiting && has && own)
    val showEmpty = !closed && !waiting && !has
    shown(emptyEmoji, showEmpty)
    shown(emptyHeading, showEmpty)
    shown(emptyHint, showEmpty)
    shown(emptyButton, showEmpty && own)
    shown(spinner, waiting && !closed)
  }

  /** Puts every part in its place in a block `width` px wide (when `lay`), and says how tall the block is. */
  private fun flow(width: Int, lay: Boolean): Int {
    fun put(view: View, left: Int, top: Int, wide: Int, tall: Int) {
      view.measure(MeasureSpec.makeMeasureSpec(maxOf(0, wide), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(maxOf(0, tall), MeasureSpec.EXACTLY))
      if (lay) view.layout(left, top, left + maxOf(0, wide), top + maxOf(0, tall))
    }
    /** A text across the block, as tall as its words need; its height is returned. */
    fun text(view: View, top: Int): Int {
      view.measure(MeasureSpec.makeMeasureSpec(maxOf(0, width - dp(24f)), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      if (lay) view.layout(dp(12f), top, width - dp(12f), top + view.measuredHeight)
      return view.measuredHeight
    }
    val closed = data?.visible == false
    val waiting = data == null
    val has = items.isNotEmpty()
    var y = 0

    if (closed) {
      put(lockIcon, 0, dp(22f), width, dp(24f))
      return dp(52f) + text(lockLabel, dp(52f)) + dp(22f)
    }

    val tabsWidth = minOf(dp(420f), width)
    val tabsLeft = (width - tabsWidth) / 2
    put(tabsBox, tabsLeft, y, tabsWidth, dp(46f))
    val half = (tabsWidth - dp(8f)) / 2
    put(postsTab, tabsLeft + dp(4f), y + dp(4f), half, dp(38f))
    put(storiesTab, tabsLeft + dp(4f) + half, y + dp(4f), half, dp(38f))
    y += dp(46f + 14f)
    if (problem.isNotEmpty()) y += text(problemLabel, y) + dp(14f)
    if (waiting) {
      put(spinner, width / 2 - dp(13f), y + dp(21f), dp(26f), dp(26f))
      return y + dp(68f)
    }
    if (has) {
      if (own) {
        addButton.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(dp(38f), MeasureSpec.EXACTLY))
        val wanted = addButton.measuredWidth
        put(addButton, (width - wanted) / 2, y, wanted, dp(38f))
        y += dp(38f + 10f)
      }
      val gap = dp(StoryRules.number("gap", 2.0).toFloat()); val columns = maxOf(1, StoryRules.number("columns", 3.0).toInt())
      val side = StoryGrid.side(width, columns, gap)
      val tall = StoryGrid.height(tiles.size, side, columns, gap)
      put(grid, 0, y, width, tall)
      tiles.forEachIndexed { position, tile ->
        val corner = StoryGrid.corner(position, side, columns, gap)
        tile.measure(MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY))
        if (lay) tile.layout(corner.first, corner.second, corner.first + side, corner.second + side)
      }
      return y + tall
    }
    y += dp(18f)
    put(emptyEmoji, 0, y, width, dp(72f))
    y += dp(72f + 8f)
    y += text(emptyHeading, y) + dp(8f)
    y += text(emptyHint, y)
    if (own) {
      y += dp(16f)
      put(emptyButton, dp(30f), y, width - dp(60f), dp(50f))
      y += dp(50f)
    }
    return y + dp(18f)
  }

  // Pictures only near the screen

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnScrollChangedListener(scrolled)
    loadVisible()
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnScrollChangedListener(scrolled)
    super.onDetachedFromWindow()
  }

  /** Asks for the pictures of the tiles on the screen and a little beyond; the rest wait for the scroll. */
  private fun loadVisible() {
    if (grid.visibility != View.VISIBLE || tiles.isEmpty() || !isAttachedToWindow || height <= 0) return
    val place = IntArray(2)
    grid.getLocationOnScreen(place)
    val screen = rootView.height.takeIf { it > 0 } ?: resources.displayMetrics.heightPixels
    val beyond = dp(300f)
    for (tile in tiles) {
      val top = place[1] + tile.top
      if (top + tile.height >= -beyond && top <= screen + beyond) tile.loadIfNeeded()
    }
  }

  // What the person does

  private fun tabPressed(next: String) {
    if (next == tab) return
    tab = next
    problem = ""
    rebuild()
  }

  private fun addPressed() {
    val host = host.get() ?: return
    if (!own) return
    problem = ""
    publisher?.begin(tab, host)
  }

  private fun ringPressed() {
    val stories = data?.stories ?: return
    if (stories.isEmpty()) return
    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    open(stories, 0, story = true)
  }

  private fun tilePressed(position: Int) {
    val shown = items
    if (position in shown.indices) open(shown, position, story = tab == "story")
  }

  private fun open(list: List<StoryPost>, start: Int, story: Boolean) {
    if (!isAttachedToWindow || viewer?.isShowing == true) return
    // No owner line here: the profile behind says whose these are (as in the reference).
    val made = StoryViewer(context, StoryViewerGroup(userId, null, list, start, story = story, own = own, canReply = false, runsOn = story))
    val messenger = messenger
    if (messenger != null) {
      val account = WeakReference(messenger)
      made.avatarAddress = { person -> account.get()?.personAvatarAddress(person.avatarId) ?: "" }
      if (own) {
        made.loadViewers = { post, done ->
          val messenger = account.get()
          if (messenger == null) done(null) else messenger.storyViewers(post.id) { result -> done(result.getOrNull()) }
        }
      } else {
        made.onWatched = { _, post -> if (!post.seen) account.get()?.viewStory(post.id) }
      }
    }
    StoriesDemo.dress(made)
    viewer = made
    made.show()
  }

  private fun tileHeld(post: StoryPost) {
    if (!own || !isAttachedToWindow) return
    AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert)
      .setTitle(StoryRules.word(if (post.kind == "story") "removeStory" else "removePost"))
      .setMessage(StoryRules.word("removeAbout"))
      .setPositiveButton(StoryRules.word("remove")) { _, _ -> remove(post) }
      .setNegativeButton("Отмена", null)
      .show()
  }

  private fun remove(post: StoryPost) {
    val messenger = messenger ?: return
    problem = ""
    messenger.deletePost(post.id) { error ->
      if (error != null) {
        problem = error.words.ifEmpty { StoryRules.word("removeFailed") }
        rebuild()
      } else {
        reload()
        StoriesStore.refresh()
      }
    }
  }

  /** For a shot on the emulator: the other tab, or the first tile opened. */
  fun emulatorShow(wanted: String) {
    tab = wanted
    rebuild()
  }

  fun emulatorOpenFirst() {
    val shown = items
    if (shown.isNotEmpty()) open(shown, 0, story = tab == "story")
  }
}

/** «Публикации и истории» of the signed-in account: what it has pinned to its profile, with adding and removing. */
@SuppressLint("ViewConstructor")
class OwnPostsScreen(context: Context, private val messenger: Messenger?) : SettingsPage(context, NAME) {
  val block = ProfilePostsBlock(context)

  override fun build() {
    add(block, 8f)
    block.attach(this, messenger, messenger?.userId ?: "demo-me", own = true, avatar = null)
  }

  companion object {
    const val NAME = "Публикации и истории"
  }
}

/** An answer to a story carries the story's reference inside its ciphertext (`meta.story`), and the chat shows it
 *  as a quote «История». This opens the story such a quote points at, read afresh — a story lives 24 hours, so an
 *  old answer says «История недоступна» instead (the reference's `openStory` in ChatScreen.tsx). For the chat's
 *  screen to call on a tap on the quote. */
object StoryQuote {
  /** Which story of a person's live ones a quote points at; null when it is gone or may not be seen. */
  fun find(data: ProfilePostsData?, storyId: String): Int? {
    if (data == null || !data.visible) return null
    return data.stories.indexOfFirst { it.id == storyId }.takeIf { it >= 0 }
  }

  fun open(ownerId: String, storyId: String, messenger: Messenger, from: View, unavailable: (String) -> Unit) {
    val origin = WeakReference(from)
    val account = WeakReference(messenger)
    messenger.profilePosts(ownerId) { result ->
      val view = origin.get() ?: return@profilePosts
      val messenger = account.get() ?: return@profilePosts
      val data = result.getOrNull()
      val start = find(data, storyId)
      if (!view.isAttachedToWindow) return@profilePosts
      if (data == null || start == null) return@profilePosts unavailable(StoryRules.word("storyGone"))
      val own = ownerId == messenger.userId
      val viewer = StoryViewer(view.context, StoryViewerGroup(ownerId, null, data.stories, start, story = true, own = own, canReply = false, runsOn = true))
      if (!own) viewer.onWatched = { _, post -> if (!post.seen) account.get()?.viewStory(post.id) }
      viewer.show()
    }
  }
}
