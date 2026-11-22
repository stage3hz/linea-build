package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ListView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.design.IconButton
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.people.pages
import com.linea.messenger.rooms.RoomVoice
import com.linea.messenger.shell.Screen
import java.util.Locale

/** The header of a community's screens: back, the community's picture (when asked), a name with a quiet line
 *  under it, and a few icons on the right. */
class ChannelHeaderView(context: Context) : ViewGroup(context) {
  /** An icon on the right: one of `ChannelIcons`, its name for a screen reader, what it does. */
  class Tool(val symbol: String, val label: String, val action: () -> Unit)

  var onBack: () -> Unit = {}
  /** The room above the header's content (the status bar), px. */
  var safeTop = 0
    set(value) { if (field != value) { field = value; requestLayout() } }
  var showsAvatar = false
    set(value) { field = value; avatar.visibility = if (value) VISIBLE else GONE; requestLayout() }
  val avatar = CommunityAvatarView(context)
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val backButton = IconButton(context, "back", 24f, Theme.text)
  private val nameLabel = context.words("", 17f, Theme.text, 700)
  private val quietLabel = context.words("", 12f, Theme.muted)
  private val tools = ArrayList<View>()

  init {
    setBackgroundColor(Theme.alpha(Theme.bg, 0.94f))
    isClickable = true
    backButton.contentDescription = "Назад"
    backButton.setOnClickListener { onBack() }
    com.linea.messenger.design.GlassBacking.put(backButton) // B: the reference's IconButton — a round of clear glass
    addView(backButton)
    avatar.visibility = GONE
    addView(avatar)
    for (label in listOf(nameLabel, quietLabel)) { label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END; label.gravity = Gravity.CENTER_VERTICAL; addView(label) }
    if (Build.VERSION.SDK_INT >= 28) nameLabel.isAccessibilityHeading = true
  }

  fun setWords(name: String, quiet: String) {
    nameLabel.text = name
    quietLabel.text = quiet
    requestLayout()
  }

  /** The icons on the right, left to right. */
  fun setTools(items: List<Tool>) {
    for (button in tools) removeView(button)
    tools.clear()
    for (item in items) {
      val button = ChannelIconButton(context, item.symbol, 22f, Theme.text)
      button.contentDescription = item.label
      button.setOnClickListener { item.action() }
      com.linea.messenger.design.GlassBacking.put(button) // B
      addView(button)
      tools.add(button)
    }
    requestLayout()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val top = safeTop
    put(backButton, dp(6f), top + dp(5f), dp(44f), dp(44f))
    var left = dp(52f)
    if (showsAvatar) {
      put(avatar, left, top + dp(8f), dp(38f), dp(38f))
      left += dp(48f)
    }
    var right = r - l - dp(6f)
    for (button in tools.asReversed()) {
      put(button, right - dp(44f), top + dp(5f), dp(44f), dp(44f))
      right -= dp(44f + 9f) // B: `gap: 9`
    }
    val wide = right - left - dp(4f)
    val alone = quietLabel.text.isNullOrEmpty()
    put(nameLabel, left, top + dp(if (alone) 16f else 7f), wide, dp(22f))
    quietLabel.visibility = if (alone) GONE else VISIBLE
    put(quietLabel, left, top + dp(30f), wide, dp(16f))
  }

  companion object {
    /** The header's own height, dp (the status bar's room comes on top). */
    const val height = 54f
  }
}

/** A community: for a game server — its channels in groups, with what is unread in each; for a blog channel —
 *  its posts at once. The header leads to inviting and to the settings.
 *  Reference: mobile/src/communities/CommunityScreen.tsx. */
@SuppressLint("ViewConstructor")
class CommunityScreen(context: Context, private val messenger: Messenger?, private val communityId: String, private var known: CommunitySummary?) : Screen(context) {
  private sealed class Item {
    class About(val words: String) : Item()
    class Group(val name: String) : Item()
    class Channel(val channel: CommunityChannel) : Item()
    /** Channels: a person inside the voice channel above (channels/CommunityVoice.kt). */
    class Member(val channel: CommunityChannel, val member: CommunityVoiceMember) : Item()
  }
  /** Channels: the people of the community (the names under the voice channels), the voice panel under the list. */
  private val people = HashMap<String, com.linea.messenger.people.Person>()
  private val voicePanel = CommunityVoicePanel(context)
  private val voiceBox = android.widget.FrameLayout(context)
  private val me: String get() = messenger?.userId ?: "demo-me"
  private val onVoiceEvent: (Map<String, Any?>) -> Unit = { data -> voiceEvent(data) }
  private val onVoice: (Unit) -> Unit = { placeVoicePanel(); if (community != null && chat == null) adapter.notifyDataSetChanged() }

  private var community: Community? = null
  private var items: List<Item> = emptyList()
  private val header = ChannelHeaderView(context)
  private val list = ListView(context)
  private val spinner = ChannelSpinner(context)
  private val notice = context.words("", 13f, Theme.danger)
  /** A blog channel is its posts: the chat of its only channel stands in place of the list. */
  private var chat: ChannelChatScreen? = null
  private var inviting = false
  private var started = false
  private val main = Handler(Looper.getMainLooper())
  private val again = Runnable { reload() }
  private val onEvent: (Map<String, Any?>) -> Unit = { data -> event(data) }
  private val onCounts: (Unit) -> Unit = { if (community != null && chat == null) adapter.notifyDataSetChanged() }

  private val adapter = object : BaseAdapter() {
    override fun getCount() = items.size
    override fun getItem(position: Int) = items[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getViewTypeCount() = 4
    override fun getItemViewType(position: Int) = when (items[position]) { is Item.About -> 0; is Item.Group -> 1; is Item.Channel -> 2; is Item.Member -> 3 }
    override fun areAllItemsEnabled() = false
    override fun isEnabled(position: Int) = when (val item = items[position]) {
      is Item.Channel -> true
      is Item.Member -> community?.let { CommunityVoice.hasActions(it, me, item.member.userId) } == true
      else -> false
    }
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View = when (val item = items[position]) {
      is Item.About -> ((convertView as? TextView) ?: context.words("", 14f, Theme.muted).apply { setPadding(dp(20f), dp(8f), dp(20f), dp(6f)) }).apply { text = item.words }
      is Item.Group -> ((convertView as? TextView) ?: ChannelsScreen.sectionLabel(context, 1.0f, 36f)).apply { text = item.name.uppercase(Locale.ROOT) }
      is Item.Channel -> ((convertView as? ChannelCell) ?: ChannelCell(context)).apply {
        // Without an account (the debug build's samples) the counters are the channel's own.
        val counts = if (messenger == null) ChannelsStore.Counts(item.channel.unread, item.channel.mentions, false, communityId) else ChannelsStore.channel(item.channel.id)
        show(item.channel, counts.unread, counts.mentions)
      }
      is Item.Member -> ((convertView as? VoiceMemberCell) ?: VoiceMemberCell(context)).apply {
        val actions = community?.let { CommunityVoice.hasActions(it, me, item.member.userId) } == true
        show(item.member, people[item.member.userId], me, messenger?.server?.endpoint ?: "", actions)
      }
    }
  }

  init {
    setBackgroundColor(Theme.bg)
    isClickable = true
    list.divider = null; list.dividerHeight = 0
    list.selector = ColorDrawable(Theme.veil(0.07f)); list.cacheColorHint = Color.TRANSPARENT
    list.isVerticalScrollBarEnabled = false; list.clipToPadding = false
    list.adapter = adapter
    list.setOnItemClickListener { _, _, position, _ ->
      when (val item = items.getOrNull(position)) {
        is Item.Channel -> open(item.channel)
        is Item.Member -> memberActions(item.member) // Channels
        else -> {}
      }
    }
    voiceBox.setPadding(dp(12f), dp(16f), dp(12f), dp(8f))
    voiceBox.addView(voicePanel, android.widget.FrameLayout.LayoutParams(android.widget.FrameLayout.LayoutParams.MATCH_PARENT, android.widget.FrameLayout.LayoutParams.WRAP_CONTENT))
    voiceBox.visibility = View.GONE
    list.addFooterView(voiceBox, null, false) // Channels: the panel of the voice channel this phone is in
    addView(list)

    header.onBack = { pages()?.pop() }
    header.showsAvatar = true
    addView(header)
    addView(spinner)
    notice.gravity = Gravity.CENTER
    notice.visibility = View.GONE
    notice.isClickable = true
    notice.setOnClickListener { reload() }
    addView(notice)

    val summary = known
    if (summary != null) {
      header.avatar.show(summary)
      header.setWords(summary.name, summary.countWords)
    } else {
      header.setWords("Загрузка…", "")
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (messenger != null) {
      Live.communityEvent.watch(onEvent)
      ChannelsStore.changed.watch(onCounts)
      Live.roomEvent.watch(onVoiceEvent) // Channels: `voice.state` of this community's channels
    }
    RoomVoice.changed.watch(onVoice)
    placeVoicePanel()
    if (started) return
    started = true
    if (messenger != null) reload() else ChannelsDemo.community(communityId)?.let { show(it) }
  }

  override fun onDetachedFromWindow() {
    Live.communityEvent.unwatch(onEvent)
    ChannelsStore.changed.unwatch(onCounts)
    Live.roomEvent.unwatch(onVoiceEvent)
    RoomVoice.changed.unwatch(onVoice)
    main.removeCallbacks(again)
    super.onDetachedFromWindow()
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    val headerBottom = top + dp(ChannelHeaderView.height)
    header.safeTop = top
    put(header, 0, 0, width, headerBottom)
    val bottom = maxOf(edges.bottom, dp(12f)) + dp(18f)
    if (list.paddingTop != headerBottom || list.paddingBottom != bottom) list.setPadding(0, headerBottom, 0, bottom)
    put(list, 0, 0, width, height)
    put(spinner, width / 2 - dp(12f), headerBottom + dp(48f), dp(24f), dp(24f))
    put(notice, dp(20f), headerBottom + dp(12f), width - dp(40f), dp(60f))
    chat?.let { put(it, 0, 0, width, height) }
  }

  // Reading

  private fun reload() {
    val messenger = messenger ?: return
    notice.visibility = View.GONE
    messenger.server.ask("community", listOf(communityId)) { result ->
      val body = result.getOrNull()
      if (body != null) {
        val found = Community.from(body["community"]) ?: return@ask
        ChannelsStore.put(found.summary)
        ChannelsStore.setChannels(found.id, found.channels)
        show(found)
      } else {
        spinner.visibility = View.GONE
        if (community == null) {
          notice.text = Server.error(result).words + "\nКоснись, чтобы повторить."
          notice.visibility = View.VISIBLE
        }
      }
    }
  }

  private fun show(found: Community) {
    community = found
    known = found.summary
    spinner.visibility = View.GONE
    notice.visibility = View.GONE
    header.avatar.show(found.summary)
    header.setWords(found.summary.name, found.summary.countWords)
    val tools = ArrayList<ChannelHeaderView.Tool>()
    if (found.can(Perm.invite)) tools.add(ChannelHeaderView.Tool("person.plus", "Пригласить") { invite() })
    tools.add(ChannelHeaderView.Tool("gear", "Настройки") { openSettings() })
    header.setTools(tools)
    if (found.blog) return showPosts(found, tools)
    val made = ArrayList<Item>()
    if (found.summary.about.isNotEmpty()) made.add(Item.About(found.summary.about))
    for (group in found.groups) {
      made.add(Item.Group(group.name))
      for (channel in group.channels) {
        made.add(Item.Channel(channel))
        if (!channel.isText) for (member in channel.voiceMembers) made.add(Item.Member(channel, member)) // Channels
      }
    }
    items = made
    adapter.notifyDataSetChanged()
    if (people.isEmpty()) loadPeople()
    placeVoicePanel()
  }

  // Channels: the voice channels

  /** The people of the community (for the names under the voice channels). */
  private fun loadPeople() {
    val messenger = messenger ?: return ChannelsDemo.members().forEach { people[it.user.id] = it.user }
    messenger.server.ask("communityMembers", listOf(communityId)) { result ->
      val body = result.getOrNull() ?: return@ask
      for (member in CommunityMember.list(body["members"])) people[member.user.id] = member.user
      adapter.notifyDataSetChanged()
    }
  }

  /** `voice.state` of one of this community's channels: who is inside now. */
  private fun voiceEvent(data: Map<String, Any?>) {
    if (data["type"] != "voice.state") return
    val found = community ?: return
    if (data["communityId"] as? String != null && data["communityId"] != communityId) return
    val channelId = data["channelId"] as? String ?: return
    if (found.channels.none { it.id == channelId }) return
    val members = CommunityVoiceMember.list(data["members"])
    show(found.withVoice(channelId, members))
  }

  /** The panel of the voice channel this phone is in — when it is one of this community's. */
  private fun placeVoicePanel() {
    val voice = RoomVoice.state
    if (voice == null || voice.communityId != communityId) { voiceBox.visibility = View.GONE; return }
    voicePanel.screenPanel.names = { userId -> people[userId]?.displayName } // ScreenShare
    voicePanel.show(voice)
    voiceBox.visibility = View.VISIBLE
  }

  private fun enterVoice(channel: CommunityChannel) {
    val community = community ?: return
    if (RoomVoice.state?.roomId == channel.id) return
    val messenger = messenger ?: return channelSay(context, "Голосовые каналы работают с аккаунтом.")
    RoomVoice.join(messenger, channel.id, channel.name, community.id to community.summary.name) { words -> if (words != null) channelSay(context, words) }
  }

  private fun memberActions(member: CommunityVoiceMember) {
    val community = community ?: return
    if (!CommunityVoice.hasActions(community, me, member.userId)) return
    val name = people[member.userId]?.displayName?.takeIf { it.isNotEmpty() } ?: "Участник"
    CommunityVoice.actions(context, community, me, member, name, messenger) { words -> channelSay(context, words) }
  }

  /** A blog channel: the posts of its channel, under the community's own header. */
  private fun showPosts(found: Community, tools: List<ChannelHeaderView.Tool>) {
    val channel = found.channels.firstOrNull { it.isText } ?: return
    chat?.let { shown ->
      shown.update(found)
      shown.setTools(tools)
      return
    }
    val screen = ChannelChatScreen(context, messenger, found, channel, root = true)
    screen.setTools(tools)
    addView(screen)
    chat = screen
    list.visibility = View.GONE
    header.visibility = View.GONE
    requestLayout()
  }

  private fun event(data: Map<String, Any?>) {
    val type = data["type"] as? String ?: return
    if (type == "ready") return reload()
    val subject = data["communityId"] as? String ?: (data["community"] as? Map<*, *>)?.get("id") as? String
    if (subject != communityId) return
    if (type == "community.channels" || type == "community") {
      // A burst of events is one reading.
      main.removeCallbacks(again)
      main.postDelayed(again, 200)
    } else if (type == "community.removed") {
      // The community is gone for this person (left, removed from it, deleted).
      ChannelsRoute.closeCommunity(this)
    }
  }

  // The header's icons

  private fun invite() {
    val messenger = messenger ?: return
    val community = community ?: return
    if (inviting) return
    inviting = true
    messenger.server.ask("createInvite", listOf(community.id)) { result ->
      inviting = false
      val body = result.getOrNull()
      if (body != null) {
        val code = (body["invite"] as? Map<*, *>)?.get("code") as? String ?: return@ask
        if (isAttachedToWindow) pages()?.push(InviteSharePage(context, messenger, messenger.server.inviteAddress(code)))
      } else channelSay(context, Server.error(result).words)
    }
  }

  private fun openSettings() {
    val community = community ?: return
    val page = CommunitySettingsPage(context, messenger, community)
    page.onChanged = { changed -> show(changed) }
    page.onInvite = { invite() }
    pages()?.push(page)
  }

  private fun open(channel: CommunityChannel) {
    val community = community ?: return
    if (channel.isText) pages()?.push(ChannelChatScreen(context, messenger, community, channel, root = false))
    else enterVoice(channel) // Channels: the voice channel (rooms/RoomVoice.kt)
  }

  /** For the emulator check: opens the first text channel. False while the community is not read yet. */
  fun openFirstChannel(): Boolean {
    val community = community ?: return false
    // A blog channel is its posts already.
    if (chat != null) return true
    val channel = community.channels.firstOrNull { it.isText } ?: return true
    pages()?.push(ChannelChatScreen(context, messenger, community, channel, root = false), animated = false)
    return true
  }

  /** For the emulator check (`--es channelsdemo voicemenu`): the moderator's actions on the person a moderator muted. */
  fun emulatorVoiceMenu() {
    for (item in items) if (item is Item.Member && item.member.serverMuted) return memberActions(item.member)
  }

  /** For the emulator check: the chat of a blog's posts, once it is shown. */
  fun postsChat(): ChannelChatScreen? = chat
}

/** A channel in a community's list: bold with a dot while unread, a counter for @mentions, a lock when only
 *  some roles see it; a voice channel shows how many people are in it. */
class ChannelCell(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val dot = View(context)
  private val icon = ChannelIconView(context, "bubble", 18f, Theme.muted)
  private val name = context.words("", 16f, Theme.text, 500)
  private val lock = ChannelIconView(context, "lock", 13f, Theme.subtle)
  private val mentions = ChannelBadgeLabel(context)
  private val people = context.words("", 12f, Theme.muted)

  init {
    dot.background = context.plate(Theme.text, 2.5f)
    name.maxLines = 1; name.ellipsize = TextUtils.TruncateAt.END; name.gravity = Gravity.CENTER_VERTICAL
    people.gravity = Gravity.CENTER_VERTICAL or Gravity.END
    for (part in listOf(dot, icon, name, lock, mentions, people)) addView(part)
  }

  fun show(channel: CommunityChannel, unread: Int, count: Int) {
    val fresh = channel.isText && unread > 0
    dot.visibility = if (fresh) VISIBLE else GONE
    icon.symbol = if (channel.isText) "bubble" else "speaker"
    name.text = if (channel.isText) "# " + channel.name else channel.name
    name.typeface = Theme.weight(if (fresh) 700 else 500)
    name.setTextColor(if (channel.isText && !fresh) Theme.muted else Theme.text)
    lock.visibility = if (channel.roleIds.isEmpty()) GONE else VISIBLE
    mentions.show(if (channel.isText) ChannelWords.badge(count) else "")
    people.text = if (!channel.isText && channel.voiceCount > 0) "${channel.voiceCount}/12" else ""
    var spoken = (if (channel.isText) "Текстовый" else "Голосовой") + " канал " + channel.name
    if (fresh) spoken += ", непрочитанных: $unread"
    if (count > 0) spoken += ", упоминаний: $count"
    contentDescription = spoken
    requestLayout()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), dp(44f))

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l; val height = b - t
    put(dot, dp(9f), (height - dp(9f)) / 2, dp(5f), dp(9f))
    put(icon, dp(20f), 0, dp(24f), height)
    val voice = !people.text.isNullOrEmpty()
    val room = width - dp(54f + 20f) - (if (voice) dp(50f) else 0)
    val badge = mentions.wide
    val trail = (if (lock.visibility == VISIBLE) dp(20f) else 0) + (if (badge > 0) badge + dp(6f) else 0)
    val wide = minOf(Math.ceil(name.paint.measureText(name.text.toString()).toDouble()).toInt() + 1, maxOf(0, room - trail))
    put(name, dp(54f), 0, wide, height)
    var after = dp(54f) + wide + dp(6f)
    if (lock.visibility == VISIBLE) {
      put(lock, after, 0, dp(14f), height)
      after += dp(20f)
    }
    if (badge > 0) put(mentions, after, (height - dp(20f)) / 2, badge, dp(20f))
    put(people, width - dp(70f), 0, dp(50f), height)
  }
}
