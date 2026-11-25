package com.linea.messenger.channels

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import java.time.Instant
import java.time.ZoneId

// The rows of a channel's chat: what one message looks like, as plain values. A row is made from a message and
// what stands around it (its author, the message before it, the message it answers) — off the main thread, by
// ChannelEngine. Reference: mobile/src/communities/ChannelChat.tsx `render`.

/** Who wrote a message, as the row shows them. `avatarColor`: 0xRRGGBB. `platina`: the author's Platina is active
 *  (the person's `seal`) — the small gem stands after the name. */
data class ChannelAuthor(val name: String, val username: String, val avatarId: String, val avatarColor: Int, val platina: Boolean = false) {
  companion object {
    fun from(raw: Any?): ChannelAuthor? {
      val fields = Core.map(raw as? Map<*, *>) ?: return null
      if (fields["id"] !is String) return null
      return ChannelAuthor(fields["displayName"] as? String ?: "", fields["username"] as? String ?: "", fields["avatarId"] as? String ?: "", Messenger.color(fields["avatarColor"] as? String), fields["seal"] as? String == "platina")
    }
  }
}

/** The banner of an invitation under a message that carries an invite link. */
data class ChannelInviteCard(
  /** 0: being asked, 1: not valid, 2: known. */
  val state: Int,
  val code: String,
  val communityId: String = "",
  val blog: Boolean = false,
  val closed: Boolean = false,
  val name: String = "",
  val avatarId: String = "",
  /** «Игровой · 12 участников». */
  val details: String = "",
  val member: Boolean = false,
) {
  companion object {
    fun loading(code: String) = ChannelInviteCard(0, code)
    fun invalid(code: String) = ChannelInviteCard(1, code)

    fun known(preview: InvitePreview, code: String): ChannelInviteCard {
      val community = preview.community
      val kindWords = if (community.blog) ChannelCategory.label(community.category) else "Игровой"
      return ChannelInviteCard(2, code, community.id, community.blog, community.closed, community.name, community.avatarId, kindWords + " · " + community.countWords, preview.isMember)
    }
  }
}

data class ChannelChip(val emoji: String, val count: Int, val mine: Boolean)

/** A link or a mention inside a row's text: UTF-16 offsets, and where it leads (`https://…` or `mention:<name>`). */
data class ChannelLink(val location: Int, val length: Int, val url: String)

/** One message as a row. */
data class ChannelRow(
  val id: Long,
  /** A blog channel shows a message as a card (a post); a server's channel as a line of a conversation. */
  val blog: Boolean = false,
  /** The date above the row when a new day begins with it; empty otherwise. */
  val day: String = "",
  /** The first message of a run by one author: the avatar ball, the name and the time stand above the text. */
  val header: Boolean = true,
  val senderId: String = "",
  val author: String = "Участник",
  /** The colour of the author's highest role (0xRRGGBB); null: the usual colour of text. */
  val authorColor: Int? = null,
  val owner: Boolean = false,
  /** The author's Platina is active: the gem after the name (ChannelChat.tsx:199 `PlatinaGem size={10}`). */
  val platina: Boolean = false,
  val avatarId: String = "",
  val avatarColor: Int = 0x5E7BFF,
  val initials: String = "",
  val time: String = "",
  val edited: Boolean = false,
  val text: String = "",
  val links: List<ChannelLink> = emptyList(),
  val hasReply: Boolean = false,
  val replyAuthor: String = "",
  val replyText: String = "",
  /** 0: none, 1: a picture, 2: a file, 3: a video (shown as a file). */
  val attachKind: Int = 0,
  val attachId: String = "",
  val attachName: String = "",
  val attachSize: String = "",
  val invite: ChannelInviteCard? = null,
  val chips: List<ChannelChip> = emptyList(),
  /** It mentions the person or answers them: the row stands out. */
  val forMe: Boolean = false,
)

/** What a row is made in the middle of: the people known so far, the colours of their roles, who is reading. */
class ChannelContext {
  var blog = false
  var meId = ""
  var meUsername = ""
  var ownerId = ""
  val authors = HashMap<String, ChannelAuthor>()
  var roleColors: Map<String, Int> = emptyMap()
  val invites = HashMap<String, ChannelInviteCard>()
}

/** Makes rows. One of these belongs to one engine and is used on its thread only (it keeps the dates it has read).
 *  `laidOut`: a text's links and @names as the core cuts them (the same cutting as in chats). */
class ChannelRowMaker(
  private val zone: ZoneId = ZoneId.systemDefault(),
  private val laidOut: (String) -> Map<String, Any?>? = { Messenger.laidOut(it, null) },
) {
  private val dates = HashMap<String, Instant>()

  fun date(text: String): Instant? {
    dates[text]?.let { return it }
    val made = Messenger.date(text) ?: return null
    if (dates.size > 4000) dates.clear()
    dates[text] = made
    return made
  }

  /** The invite code a message's text carries (the first, as the reference shows one banner). */
  fun inviteCode(message: CommunityMessage): String? = ChannelWords.inviteCode(message.text)

  /** `older`: the message right before this one in the channel; `replied`: the message it answers, when loaded. */
  fun row(message: CommunityMessage, older: CommunityMessage?, replied: CommunityMessage?, context: ChannelContext): ChannelRow {
    val moment = date(message.createdAt)
    val before = older?.let { date(it.createdAt) }
    var time = ""; var day = ""
    if (moment != null) {
      time = Messenger.clock(moment, zone)
      val today = moment.atZone(zone).toLocalDate()
      val sameDay = before?.let { it.atZone(zone).toLocalDate() == today } ?: false
      if (!sameDay) day = "${today.dayOfMonth} ${months[today.monthValue - 1]}"
    }
    var grouped = false
    if (!context.blog && older != null && older.senderId == message.senderId && moment != null && before != null) {
      grouped = moment.toEpochMilli() - before.toEpochMilli() < 7 * 60 * 1000
    }
    val author = context.authors[message.senderId]

    var shown = message.text
    var invite: ChannelInviteCard? = null
    val code = inviteCode(message)
    if (code != null) {
      shown = ChannelWords.withoutInviteLink(message.text)
      invite = context.invites[code] ?: ChannelInviteCard.loading(code)
    }
    // Addresses and @names as the core cuts them.
    val links = ArrayList<ChannelLink>()
    if (shown.isNotEmpty() && (shown.contains("@") || shown.contains("www.") || shown.contains("://"))) {
      val laid = laidOut(shown)
      if (laid != null && laid["text"] as? String == shown) {
        val fmt = (laid["fmt"] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() }
        val urls = (laid["urls"] as? List<*>).orEmpty().mapNotNull { it as? String }
        var link = 0; var index = 0
        while (index + 2 < fmt.size) {
          if (fmt[index] and 64 != 0) {
            if (link < urls.size) links.add(ChannelLink(fmt[index + 1], fmt[index + 2], urls[link]))
            link += 1
          }
          index += 3
        }
      }
    }
    val answers = message.replyTo != 0L && replied != null
    val file = message.attachment
    return ChannelRow(
      id = message.id, blog = context.blog, day = day, header = !grouped, senderId = message.senderId,
      author = author?.name?.ifEmpty { "Участник" } ?: "Участник",
      authorColor = context.roleColors[message.senderId], owner = message.senderId == context.ownerId, platina = author?.platina ?: false,
      avatarId = author?.avatarId ?: "", avatarColor = author?.avatarColor ?: 0x5E7BFF, initials = author?.let { Messenger.initials(it.name) } ?: "",
      time = time, edited = message.edited, text = shown, links = links,
      hasReply = answers,
      replyAuthor = if (answers) context.authors[replied!!.senderId]?.name ?: "Участник" else "",
      replyText = if (answers) replied!!.text.ifEmpty { "Вложение" }.replace("\n", " ") else "",
      attachKind = if (file == null) 0 else if (file.mimeType.startsWith("image/")) 1 else if (file.mimeType.startsWith("video/")) 3 else 2,
      attachId = file?.id ?: "", attachName = file?.name ?: "", attachSize = file?.let { ChannelWords.fileSize(it.size) } ?: "",
      invite = invite,
      chips = message.reactions.map { ChannelChip(it.emoji, it.count, it.userIds.contains(context.meId)) },
      forMe = message.senderId != context.meId && (ChannelWords.mentions(message.text, context.meUsername) || (answers && replied!!.senderId == context.meId)),
    )
  }

  private companion object {
    val months = listOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")
  }
}
