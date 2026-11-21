package com.linea.messenger.channels

import android.content.Context
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import java.lang.ref.WeakReference

/** The person's communities and what is unread in them: the list of «Каналы», the marks on its rows and on a
 *  community's channels, the number on the section's row in the bar. The server is the source of truth
 *  (summaries, channel lists, «community.read» events); new messages bump the numbers at once.
 *  Reference: mobile/src/communities/unread.ts and the socket listener of CommunitiesScreen.tsx. Main thread only.
 *
 *  The live line posts every event about communities (its `type` begins with «community») and «ready» to
 *  `Live.communityEvent`, as it came. */
object ChannelsStore {
  /** Posted when the list or a counter changed. */
  val changed = Live.Signal<Unit>()

  data class Counts(val unread: Int = 0, val mentions: Int = 0, val muted: Boolean = false, val communityId: String = "")

  /** null until the list has been read once. */
  var list: List<CommunitySummary>? = null
    private set
  /** Why the list could not be read; empty when it could. */
  var failure = ""
    private set
  private val communities = HashMap<String, Counts>()
  private val channels = HashMap<String, Counts>()
  /** The channel on screen right now: its new messages are read as they come. */
  private var viewing = ""
  private var messenger = WeakReference<Messenger>(null)
  private var meId = ""
  private var observing = false

  /** Begins to follow the account (a new sign-in forgets what the previous account had). */
  fun start(context: Context, messenger: Messenger?) {
    ChannelFiles.cache = context.applicationContext.cacheDir
    if (messenger != null && this.messenger.get() === messenger) return
    this.messenger = WeakReference(messenger)
    ChannelImages.server = messenger?.server
    ChannelImages.forget()
    ChannelOutboxDisk.attach(context) // Channels: the outbox survives a restart
    ChannelOutbox.start(messenger)
    reset(messenger?.userId ?: "")
    if (!observing) {
      observing = true
      Live.communityEvent.watch { data -> if (this.messenger.get() != null) event(data) }
    }
    changed.post(Unit)
    reload()
  }

  /** Forgets everything; `me` is the person the counters are kept for. */
  fun reset(me: String) {
    meId = me
    list = null
    failure = ""
    communities.clear()
    channels.clear()
    viewing = ""
  }

  /** Reads the list of communities again. A failed reading keeps the list that is shown. */
  fun reload() {
    val messenger = messenger.get() ?: return
    messenger.server.ask("communities", emptyList()) { result ->
      if (this.messenger.get() !== messenger) return@ask
      val body = result.getOrNull()
      if (body != null) took(CommunitySummary.list(body["communities"])) else failure = Server.error(result).words
      changed.post(Unit)
    }
  }

  /** The list as the server gave it. */
  fun took(found: List<CommunitySummary>) {
    list = found
    failure = ""
    communities.clear()
    for (item in found) communities[item.id] = Counts(item.unread, item.mentions, item.muted, item.id)
    channels.entries.removeAll { !communities.containsKey(it.value.communityId) }
  }

  // What the screens tell

  /** A community was read from the server (opened, changed, joined). */
  fun put(summary: CommunitySummary) {
    if (!summary.isMember) return remove(summary.id)
    communities[summary.id] = Counts(summary.unread, summary.mentions, summary.muted, summary.id)
    list?.let { known ->
      list = if (known.any { it.id == summary.id }) known.map { if (it.id == summary.id) summary else it } else listOf(summary) + known
    }
    changed.post(Unit)
  }

  fun remove(id: String) {
    communities.remove(id)
    channels.entries.removeAll { it.value.communityId == id }
    list = list?.filter { it.id != id }
    changed.post(Unit)
  }

  /** The channels of an opened community, each with its own counters. */
  fun setChannels(communityId: String, found: List<CommunityChannel>) {
    channels.entries.removeAll { it.value.communityId == communityId }
    for (channel in found) if (channel.isText) channels[channel.id] = Counts(channel.unread, channel.mentions, false, communityId)
    changed.post(Unit)
  }

  fun setViewing(channelId: String) { viewing = channelId }

  /** The server's answer to «read up to here». */
  fun read(channelId: String, unread: Int, mentions: Int, community: CommunitySummary?) {
    channels[channelId]?.let { channels[channelId] = it.copy(unread = unread, mentions = mentions) }
    if (community != null) communities[community.id] = Counts(community.unread, community.mentions, community.muted, community.id)
    changed.post(Unit)
  }

  // What the screens ask

  fun community(id: String): Counts = communities[id] ?: Counts()
  fun channel(id: String): Counts = channels[id] ?: Counts()

  /** The number on the section's row: a muted community counts only its @mentions. */
  val badge: Int get() = communities.values.sumOf { if (it.muted) it.mentions else it.unread }

  // The live line

  /** One event of the live line about communities (or «ready»). */
  fun event(data: Map<String, Any?>) {
    when (data["type"] as? String) {
      "ready" -> reload()
      "community" -> CommunitySummary.from(data["community"])?.let { put(it) }
      "community.removed" -> (data["communityId"] as? String)?.let { remove(it) }
      "community.read" -> {
        val channelId = data["channelId"] as? String ?: return
        read(channelId, (data["unread"] as? Number)?.toInt() ?: 0, (data["mentions"] as? Number)?.toInt() ?: 0, CommunitySummary.from(data["community"]))
      }
      "community.message" -> {
        val communityId = data["communityId"] as? String ?: return
        val message = Core.map(data["message"] as? Map<*, *>) ?: return
        list = list?.map { if (it.id == communityId) it.copy(lastText = message["text"] as? String ?: "") else it }
        val edited = data["edited"] as? Boolean ?: false
        val channelId = message["channelId"] as? String ?: ""
        val community = communities[communityId]
        if (!edited && message["senderId"] as? String != meId && channelId != viewing && community != null) {
          val mention = if ((data["mentions"] as? List<*>).orEmpty().contains(meId)) 1 else 0
          communities[communityId] = community.copy(unread = community.unread + 1, mentions = community.mentions + mention)
          channels[channelId]?.let { channels[channelId] = it.copy(unread = it.unread + 1, mentions = it.mentions + mention) }
        }
        changed.post(Unit)
      }
    }
  }
}
