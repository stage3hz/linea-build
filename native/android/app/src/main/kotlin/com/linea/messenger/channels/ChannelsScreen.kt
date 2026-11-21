package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ListView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.people.pages
import com.linea.messenger.shell.Screen
import java.util.Locale

/** The «Каналы» section: the person's game servers and blog channels with what is unread in them, a way to
 *  create one and a way to join one by an invite link. Reference: mobile/src/communities/CommunitiesScreen.tsx. */
@SuppressLint("ViewConstructor")
class ChannelsScreen(context: Context, private val messenger: Messenger?) : Screen(context) {
  private sealed class Item {
    class Section(val name: String) : Item()
    class Row(val community: CommunitySummary) : Item()
  }

  private val heading = context.words("Каналы", 34f, Theme.text, 700)
  private val joinButton = ChannelIconButton(context, "link", 20f, Theme.text, plate = Theme.surface2)
  private val createButton = ChannelIconButton(context, "plus", 20f, Theme.onAccent, plate = Theme.accent)
  private val list = ListView(context)
  private val spinner = ChannelSpinner(context)
  private val notice = context.words("", 13f, Theme.danger)
  private val emptyIcon = ChannelIconView(context, "globe", 44f, Theme.subtle)
  private val emptyHeading = context.words("Свои места для своих", 20f, Theme.text, 700)
  private val emptyWords = context.words("Создай игровой сервер с текстовыми и голосовыми каналами или стандартный канал — блог, новости, музыку, что угодно.", 14f, Theme.muted)
  private val emptyButton = context.words("Создать", 15f, Theme.onAccent, 600)
  private var items: List<Item> = emptyList()
  private var loaded = false
  private var showing = false
  private val storeChanged: (Unit) -> Unit = { fromStore() }
  /** Rooms: «Комнаты», the first thing in the section (rooms/RoomsSectionView.kt). */
  private val rooms = com.linea.messenger.rooms.RoomsSectionView(context)
  /** Rooms: no communities and no failure — «Свои места для своих» is shown only when there are no rooms either. */
  private var nothingListed = false
  private val roomsChanged: (Unit) -> Unit = { showEmpty() }

  private val adapter = object : BaseAdapter() {
    override fun getCount() = items.size
    override fun getItem(position: Int) = items[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getViewTypeCount() = 2
    override fun getItemViewType(position: Int) = if (items[position] is Item.Section) 0 else 1
    override fun areAllItemsEnabled() = false
    override fun isEnabled(position: Int) = items[position] is Item.Row
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View = when (val item = items[position]) {
      is Item.Section -> ((convertView as? TextView) ?: sectionLabel(context, 1.2f, 34f)).apply { text = item.name.uppercase(Locale.ROOT) }
      is Item.Row -> ((convertView as? CommunityCell) ?: CommunityCell(context)).apply {
        val community = item.community
        // Without an account (the debug build's samples) the counters are the summaries' own.
        show(community, if (messenger == null) ChannelsStore.Counts(community.unread, community.mentions, community.muted, community.id) else ChannelsStore.community(community.id))
      }
    }
  }

  init {
    setBackgroundColor(Theme.bg)
    list.divider = null; list.dividerHeight = 0
    list.selector = ColorDrawable(0x12FFFFFF); list.cacheColorHint = Color.TRANSPARENT
    list.isVerticalScrollBarEnabled = false; list.clipToPadding = false
    // Rooms: above the communities, as the list's header.
    list.addHeaderView(rooms, null, false)
    list.adapter = adapter
    list.setOnItemClickListener { _, _, position, _ -> (items.getOrNull(position - list.headerViewsCount) as? Item.Row)?.let { open(it.community) } }
    addView(list)

    heading.includeFontPadding = false
    if (Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true
    addView(heading)
    joinButton.contentDescription = "Вступить по ссылке"
    joinButton.setOnClickListener { join() }
    addView(joinButton)
    createButton.contentDescription = "Создать"
    createButton.setOnClickListener { create() }
    addView(createButton)

    spinner.visibility = View.GONE
    addView(spinner)
    notice.gravity = Gravity.CENTER
    notice.visibility = View.GONE
    notice.isClickable = true
    notice.setOnClickListener { retry() }
    addView(notice)

    emptyHeading.gravity = Gravity.CENTER
    emptyWords.gravity = Gravity.CENTER
    emptyButton.gravity = Gravity.CENTER
    emptyButton.background = context.plate(Theme.accent, 22f)
    emptyButton.isClickable = true; emptyButton.isFocusable = true
    emptyButton.setOnClickListener { create() }
    for (part in listOf(emptyIcon, emptyHeading, emptyWords, emptyButton)) { part.visibility = View.GONE; addView(part) }

    if (messenger != null) fromStore() else show(ChannelsDemo.summaries(), "")
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (messenger != null) { ChannelsStore.changed.watch(storeChanged); fromStore() }
    com.linea.messenger.rooms.Rooms.changed.watch(roomsChanged)
    showEmpty()
  }

  override fun onDetachedFromWindow() {
    ChannelsStore.changed.unwatch(storeChanged)
    com.linea.messenger.rooms.Rooms.changed.unwatch(roomsChanged)
    super.onDetachedFromWindow()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    // Coming back from a community: its last message and counters may have changed.
    if (isVisible && !showing && loaded && messenger != null) ChannelsStore.reload()
    showing = isVisible
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    put(heading, dp(20f), top + dp(8f), width - dp(140f), dp(41f))
    put(createButton, width - dp(60f), top + dp(8f), dp(40f), dp(40f))
    put(joinButton, width - dp(110f), top + dp(8f), dp(40f), dp(40f))
    val barRoom = dp(BarMetrics.bottomGap(edges.bottom / d) + BarMetrics.height + 12f)
    val listTop = top + dp(57f)
    if (list.paddingBottom != barRoom) list.setPadding(0, 0, 0, barRoom)
    put(list, 0, listTop, width, height - listTop)
    put(spinner, width / 2 - dp(12f), top + dp(128f), dp(24f), dp(24f))
    put(notice, dp(20f), top + dp(62f), width - dp(40f), dp(44f))
    val middle = height / 2 - dp(30f)
    put(emptyIcon, 0, middle - dp(110f), width, dp(50f))
    put(emptyHeading, dp(24f), middle - dp(50f), width - dp(48f), dp(26f))
    emptyWords.measure(MeasureSpec.makeMeasureSpec(width - dp(64f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val wordsHeight = emptyWords.measuredHeight
    emptyWords.layout(dp(32f), middle - dp(16f), width - dp(32f), middle - dp(16f) + wordsHeight)
    put(emptyButton, (width - dp(150f)) / 2, middle - dp(16f) + wordsHeight + dp(18f), dp(150f), dp(44f))
  }

  // What is shown

  private fun fromStore() {
    val known = ChannelsStore.list
    if (known != null) return show(known, ChannelsStore.failure)
    // Not read yet: waiting, or the reason it could not be read.
    spinner.visibility = if (ChannelsStore.failure.isEmpty()) View.VISIBLE else View.GONE
    showNotice(ChannelsStore.failure)
  }

  private fun showNotice(words: String) {
    notice.text = if (words.isEmpty()) "" else words + "\nКоснись, чтобы повторить."
    notice.visibility = if (words.isEmpty()) View.GONE else View.VISIBLE
  }

  private fun show(found: List<CommunitySummary>, failure: String) {
    loaded = true
    spinner.visibility = View.GONE
    showNotice(failure)
    items = rows(found).map { if (it.second == null) Item.Section(it.first) else Item.Row(it.second!!) }
    adapter.notifyDataSetChanged()
    nothingListed = found.isEmpty() && failure.isEmpty()
    showEmpty()
  }

  /** Rooms: as in the reference, the call to create something gives way to the rooms when there are any. */
  private fun showEmpty() {
    val empty = nothingListed && com.linea.messenger.rooms.Rooms.rooms.isNullOrEmpty()
    for (part in listOf(emptyIcon, emptyHeading, emptyWords, emptyButton)) part.visibility = if (empty) View.VISIBLE else View.GONE
  }

  private fun retry() {
    showNotice("")
    spinner.visibility = View.VISIBLE
    ChannelsStore.reload()
  }

  // Create, join, open

  private fun create() {
    val messenger = messenger ?: return
    pages()?.push(CommunityKindPage(context, messenger))
  }

  private fun join() {
    val messenger = messenger ?: return
    pages()?.push(CommunityJoinPage(context, messenger))
  }

  private fun open(community: CommunitySummary, animated: Boolean = true): CommunityScreen {
    val screen = CommunityScreen(context, messenger, community.id, community)
    pages()?.push(screen, animated)
    return screen
  }

  /** For the emulator check: opens the first community of the list (a server when there is one). */
  fun openFirst(): CommunityScreen? {
    val first = items.firstNotNullOfOrNull { (it as? Item.Row)?.community } ?: return null
    return open(first, animated = false)
  }

  /** For the emulator check: «Что создаём?» or «Вступить по ссылке». */
  fun emulatorForm(which: String) { if (which == "create") create() else join() }

  companion object {
    /** The list as its rows: the name of a part (the second is null), then its communities — game servers
     *  first, then channels. */
    fun rows(found: List<CommunitySummary>): List<Pair<String, CommunitySummary?>> {
      val servers = found.filter { !it.blog }; val blogs = found.filter { it.blog }
      val made = ArrayList<Pair<String, CommunitySummary?>>()
      if (servers.isNotEmpty()) { made.add(Pair("Игровые серверы", null)); servers.forEach { made.add(Pair("", it)) } }
      if (blogs.isNotEmpty()) { made.add(Pair("Каналы", null)); blogs.forEach { made.add(Pair("", it)) } }
      return made
    }

    /** The quiet name of a part of a list: small capitals, set apart. `height` dp. */
    fun sectionLabel(context: Context, spacing: Float, height: Float): TextView = context.words("", 11f, Theme.muted, 700).apply {
      letterSpacing = spacing / 11f
      gravity = Gravity.BOTTOM
      maxLines = 1
      setPadding(context.px(20f), 0, context.px(20f), context.px(6f))
      minimumHeight = context.px(height)
      this.height = context.px(height)
      if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
    }
  }
}

/** A community in the list: its picture, its name with the counters, the newest words. */
class CommunityCell(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val avatar = CommunityAvatarView(context)
  private val name = context.words("", 16f, Theme.text, 600)
  private val words = context.words("", 14f, Theme.muted)
  private val quiet = ChannelIconView(context, "speaker.slash", 14f, Theme.subtle)
  private val mentions = ChannelBadgeLabel(context)
  private val unread = ChannelBadgeLabel(context)

  init {
    for (label in listOf(name, words)) { label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END; label.gravity = Gravity.CENTER_VERTICAL }
    for (part in listOf(avatar, name, words, quiet, mentions, unread)) addView(part)
  }

  fun show(community: CommunitySummary, counts: ChannelsStore.Counts) {
    avatar.show(community)
    name.text = community.name
    words.text = line(community)
    quiet.visibility = if (counts.muted && counts.unread == 0) VISIBLE else GONE
    mentions.show(if (counts.mentions > 0) "@" else "", spoken = "упоминаний: ${counts.mentions}")
    unread.show(ChannelWords.badge(counts.unread), quiet = counts.muted, spoken = "непрочитанных: ${counts.unread}")
    contentDescription = community.name
    requestLayout()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), dp(70f))

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    put(avatar, dp(20f), dp(8f), dp(54f), dp(54f))
    var right = width - dp(20f)
    val wide = unread.wide
    if (wide > 0) { put(unread, right - wide, dp(15f), wide, dp(20f)); right -= wide + dp(4f) }
    if (mentions.visibility == VISIBLE) { put(mentions, right - dp(20f), dp(15f), dp(20f), dp(20f)); right -= dp(24f) }
    if (quiet.visibility == VISIBLE) { put(quiet, right - dp(18f), dp(15f), dp(18f), dp(20f)); right -= dp(22f) }
    put(name, dp(86f), dp(13f), right - dp(90f), dp(22f))
    put(words, dp(86f), dp(37f), width - dp(106f), dp(20f))
  }

  companion object {
    /** The quiet line under a community's name: its newest words, else what it is about, else how many are in it. */
    fun line(community: CommunitySummary): String {
      val last = community.lastText.replace("\n", " ")
      return last.ifEmpty { community.about.ifEmpty { community.countWords } }
    }
  }
}
