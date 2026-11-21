package com.linea.messenger.channels

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.people.Person
import java.util.Locale
import java.util.regex.Pattern

// «Каналы»: communities («серверы») with text channels, and blog channels. What the server sends about them,
// as plain values (reference: mobile/src/communities/types.ts, server/src/communities.js). By the reference's
// design communities are not end-to-end encrypted: their messages are read from the server as they are.

private fun fields(raw: Any?): Map<String, Any?>? = Core.map(raw as? Map<*, *>)
private fun strings(raw: Any?): List<String> = (raw as? List<*>).orEmpty().mapNotNull { it as? String }
private fun int(raw: Any?, fallback: Int = 0): Int = (raw as? Number)?.toInt() ?: fallback

/** What a member may do in a community: the bits of `perms` (reference: PERM). */
object Perm {
  const val admin = 1
  const val manageCommunity = 2
  const val manageChannels = 4
  const val manageRoles = 8
  const val invite = 16
  const val send = 32
  const val voice = 64
  const val post = 128
  const val kick = 256
  const val manageMessages = 512
  const val ban = 1024
  const val muteMembers = 2048
  const val deafenMembers = 4096

  /** `blog`: only for blog channels; `server`: only for servers. */
  class Label(val bit: Int, val label: String, val blog: Boolean, val server: Boolean)

  /** The rights a role can be given, in the reference's order and words (PERM_LABELS). */
  val labels: List<Label> = listOf(
    Label(send, "Писать в каналах", blog = false, server = true),
    Label(voice, "Голосовые каналы", blog = false, server = true),
    Label(post, "Публиковать посты", blog = true, server = false),
    Label(invite, "Приглашать по ссылке", blog = false, server = false),
    Label(manageMessages, "Удалять чужие сообщения", blog = false, server = false),
    Label(kick, "Исключать участников", blog = false, server = false),
    Label(ban, "Блокировать участников", blog = false, server = false),
    Label(muteMembers, "Отключать микрофон другим", blog = false, server = true),
    Label(deafenMembers, "Отключать звук другим", blog = false, server = true),
    Label(manageChannels, "Управлять каналами", blog = false, server = true),
    Label(manageRoles, "Управлять ролями", blog = false, server = false),
    Label(manageCommunity, "Менять название и фото", blog = false, server = false),
    Label(admin, "Администратор (все права)", blog = false, server = false),
  )
}

/** What a standard channel is about (reference: CATEGORIES). `symbol`: one of `ChannelIcons`. */
class ChannelCategory(val id: String, val label: String, val symbol: String) {
  companion object {
    val all: List<ChannelCategory> = listOf(
      ChannelCategory("blog", "Блог", "pencil"),
      ChannelCategory("news", "Новости", "newspaper"),
      ChannelCategory("music", "Музыка", "music"),
      ChannelCategory("tech", "Технологии", "cpu"),
      ChannelCategory("humor", "Юмор", "smile"),
      ChannelCategory("education", "Обучение", "cap"),
      ChannelCategory("sport", "Спорт", "sport"),
      ChannelCategory("games", "Игры", "gamecontroller"),
      ChannelCategory("art", "Творчество", "palette"),
      ChannelCategory("other", "Другое", "dots.circle"),
    )

    fun label(id: String): String = all.firstOrNull { it.id == id }?.label ?: "Канал"
  }
}

/** One message of a channel. */
data class CommunityMessage(
  val id: Long,
  val channelId: String,
  val senderId: String,
  val text: String,
  val attachment: Attachment?,
  /** 0 when it answers nothing. */
  val replyTo: Long,
  val createdAt: String,
  val edited: Boolean,
  val reactions: List<Reaction>,
) {
  data class Attachment(val id: String, val name: String, val mimeType: String, val size: Long)
  data class Reaction(val emoji: String, val count: Int, val userIds: List<String>)

  companion object {
    fun from(raw: Any?): CommunityMessage? {
      val fields = fields(raw) ?: return null
      val id = (fields["id"] as? Number)?.toLong() ?: return null
      val file = fields(fields["attachment"])
      val fileId = file?.get("id") as? String
      val attachment = if (file != null && !fileId.isNullOrEmpty()) Attachment(fileId, file["name"] as? String ?: "", file["mimeType"] as? String ?: "", (file["size"] as? Number)?.toLong() ?: 0L) else null
      val reactions = (fields["reactions"] as? List<*>).orEmpty().mapNotNull { item ->
        val reaction = fields(item) ?: return@mapNotNull null
        val emoji = reaction["emoji"] as? String
        if (emoji.isNullOrEmpty()) null else Reaction(emoji, int(reaction["count"], 1), strings(reaction["userIds"]))
      }
      return CommunityMessage(
        id, fields["channelId"] as? String ?: "", fields["senderId"] as? String ?: "", fields["text"] as? String ?: "", attachment,
        (fields["replyTo"] as? Number)?.toLong() ?: 0L, fields["createdAt"] as? String ?: "", fields["editedAt"] is String, reactions,
      )
    }

    fun list(raw: Any?): List<CommunityMessage> = (raw as? List<*>).orEmpty().mapNotNull { from(it) }
  }
}

/** A community as the list of communities shows it. */
data class CommunitySummary(
  val id: String,
  /** "server" or "blog". */
  val kind: String,
  val category: String,
  val closed: Boolean,
  val name: String,
  val about: String,
  val avatarId: String,
  val ownerId: String,
  val memberCount: Int,
  val isMember: Boolean,
  val perms: Int,
  /** The text of the newest message the person may see; empty when there is none. */
  val lastText: String,
  val muted: Boolean,
  val unread: Int,
  val mentions: Int,
) {
  val blog: Boolean get() = kind == "blog"
  fun can(bit: Int): Boolean = perms and bit != 0
  /** «12 участников» / «3 подписчика». */
  val countWords: String get() = if (blog) ChannelWords.subscribers(memberCount) else ChannelWords.members(memberCount)

  companion object {
    fun from(raw: Any?): CommunitySummary? {
      val fields = fields(raw) ?: return null
      val id = fields["id"] as? String
      if (id.isNullOrEmpty()) return null
      return CommunitySummary(
        id, fields["kind"] as? String ?: "server", fields["category"] as? String ?: "", fields["closed"] as? Boolean ?: false,
        fields["name"] as? String ?: "", fields["description"] as? String ?: "", fields["avatarId"] as? String ?: "", fields["ownerId"] as? String ?: "",
        int(fields["memberCount"]),
        // Absent in an invite's preview of a community; a summary always says it.
        fields["isMember"] as? Boolean ?: true,
        int(fields["perms"]), fields(fields["lastMessage"])?.get("text") as? String ?: "", fields["muted"] as? Boolean ?: false,
        int(fields["unreadCount"]), int(fields["mentionCount"]),
      )
    }

    fun list(raw: Any?): List<CommunitySummary> = (raw as? List<*>).orEmpty().mapNotNull { from(it) }
  }
}

data class CommunityRole(
  val id: String,
  val name: String,
  /** «#RRGGBB», as the server keeps it. */
  val colorHex: String,
  val position: Int,
  val perms: Int,
  val isDefault: Boolean,
) {
  /** 0xAARRGGBB. */
  val color: Int get() = 0xFF000000.toInt() or Messenger.color(colorHex)

  companion object {
    fun from(raw: Any?): CommunityRole? {
      val fields = fields(raw) ?: return null
      val id = fields["id"] as? String ?: return null
      return CommunityRole(id, fields["name"] as? String ?: "", fields["color"] as? String ?: "#8A9BB8", int(fields["position"]), int(fields["perms"]), fields["isDefault"] as? Boolean ?: false)
    }
  }
}

data class CommunityChannel(
  val id: String,
  /** "text" or "voice". */
  val kind: String,
  val name: String,
  val topic: String,
  val category: String,
  val position: Int,
  /** Not empty: only these roles see the channel. */
  val roleIds: List<String>,
  /** How many people are in a voice channel now. */
  val voiceCount: Int,
  val unread: Int,
  val mentions: Int,
) {
  val isText: Boolean get() = kind == "text"

  companion object {
    fun from(raw: Any?): CommunityChannel? {
      val fields = fields(raw) ?: return null
      val id = fields["id"] as? String ?: return null
      return CommunityChannel(
        id, fields["kind"] as? String ?: "text", fields["name"] as? String ?: "", fields["topic"] as? String ?: "", fields["category"] as? String ?: "",
        int(fields["position"]), strings(fields["roleIds"]), (fields["voice"] as? List<*>)?.size ?: 0, int(fields["unread"]), int(fields["mentions"]),
      )
    }
  }
}

/** A community opened: what the list knows, and its roles and channels. */
data class Community(val summary: CommunitySummary, val roles: List<CommunityRole>, val myRoleIds: List<String>, val channels: List<CommunityChannel>) {
  val id: String get() = summary.id
  val blog: Boolean get() = summary.blog
  fun can(bit: Int): Boolean = summary.can(bit)

  class Group(val name: String, val channels: List<CommunityChannel>)

  /** The channels in groups, as the reference groups them: by the channel's own category, else «Текстовые
   *  каналы» / «Голосовые каналы»; groups in the order their first channel comes. */
  val groups: List<Group>
    get() {
      val byName = LinkedHashMap<String, ArrayList<CommunityChannel>>()
      for (channel in channels) {
        val key = channel.category.ifEmpty { if (channel.isText) "Текстовые каналы" else "Голосовые каналы" }
        byName.getOrPut(key) { ArrayList() }.add(channel)
      }
      return byName.map { Group(it.key, it.value) }
    }

  /** The colour of a member's name (0xRRGGBB): their highest role that is not «everyone» (reference: ChannelChat
   *  roleColors). Null: the usual colour of text. */
  fun nameColor(roleIds: List<String>): Int? =
    roles.filter { !it.isDefault }.sortedByDescending { it.position }.firstOrNull { roleIds.contains(it.id) }?.let { Messenger.color(it.colorHex) }

  companion object {
    fun from(raw: Any?): Community? {
      val summary = CommunitySummary.from(raw) ?: return null
      val fields = fields(raw) ?: return null
      return Community(
        summary, (fields["roles"] as? List<*>).orEmpty().mapNotNull { CommunityRole.from(it) }, strings(fields["myRoleIds"]),
        (fields["channels"] as? List<*>).orEmpty().mapNotNull { CommunityChannel.from(it) },
      )
    }
  }
}

class CommunityMember(val user: Person, val roleIds: List<String>, val owner: Boolean) {
  companion object {
    fun from(raw: Any?): CommunityMember? {
      val fields = fields(raw) ?: return null
      val user = Person.from(fields["user"]) ?: return null
      return CommunityMember(user, strings(fields["roleIds"]), fields["owner"] as? Boolean ?: false)
    }

    fun list(raw: Any?): List<CommunityMember> = (raw as? List<*>).orEmpty().mapNotNull { from(it) }
  }
}

/** What an invitation leads to, before it is accepted. */
class InvitePreview(val code: String, val community: CommunitySummary, val isMember: Boolean) {
  companion object {
    fun from(raw: Any?): InvitePreview? {
      val fields = fields(raw) ?: return null
      val community = CommunitySummary.from(fields["community"]) ?: return null
      return InvitePreview(fields["code"] as? String ?: "", community, fields["isMember"] as? Boolean ?: false)
    }
  }
}

/** The words and small rules of the section, ported from the reference word for word
 *  (communities/parts.tsx, communities/types.ts, communities/unread.ts, unreadBadge.ts, theme.ts formatSize). */
object ChannelWords {
  /** «1 234», «12,3 тыс.», «1,2 млн». */
  fun compactCount(count: Int): String {
    val n = maxOf(0, count)
    fun short(tenths: Int, unit: String): String {
      val whole = tenths / 10; val part = tenths % 10
      return (if (part == 0) "$whole" else "$whole,$part") + " " + unit
    }
    if (n >= 1_000_000) return short(n / 100_000, "млн")
    if (n >= 10_000) return short(n / 100, "тыс.")
    if (n >= 1000) {
      val rest = n % 1000
      val padded = if (rest < 10) "00$rest" else if (rest < 100) "0$rest" else "$rest"
      return "${n / 1000} " + padded
    }
    return n.toString()
  }

  private fun counted(count: Int, one: String, few: String, many: String): String {
    val n = maxOf(0, count)
    if (n >= 10_000) return compactCount(n) + " " + many
    val mod10 = n % 10; val mod100 = n % 100
    val word = if (mod10 == 1 && mod100 != 11) one else if (mod10 in 2..4 && (mod100 < 12 || mod100 > 14)) few else many
    return compactCount(n) + " " + word
  }

  fun members(count: Int): String = counted(count, "участник", "участника", "участников")
  fun subscribers(count: Int): String = counted(count, "подписчик", "подписчика", "подписчиков")

  /** A counter on a badge: exact up to 999, then «4,3K», «12K», «1,2M». */
  fun badge(n: Int): String {
    if (n < 1) return ""
    if (n < 1000) return n.toString()
    fun short(tenths: Int, unit: String): String {
      val whole = tenths / 10; val part = tenths % 10
      if (whole >= 10) return "$whole$unit"
      return (if (part == 0) "$whole" else "$whole,$part") + unit
    }
    if (n < 1_000_000) return short(n / 100, "K")
    return short(n / 100_000, "M")
  }

  fun fileSize(bytes: Long): String {
    val value = maxOf(0L, bytes).toDouble()
    if (bytes < 1024) return "${maxOf(0L, bytes)} Б"
    if (bytes < 1024 * 1024) return String.format(Locale.ROOT, "%.0f КБ", value / 1024)
    if (bytes >= 1024L * 1024 * 1024) return String.format(Locale.ROOT, "%.1f ГБ", value / 1024 / 1024 / 1024)
    return String.format(Locale.ROOT, "%.1f МБ", value / 1024 / 1024)
  }

  /** The letters on a community's picture when it has none: the first letters of its first two words, else «#». */
  fun initials(name: String): String {
    val words = name.split(Regex("\\s+")).filter { it.isNotEmpty() }
    val letters = words.take(2).joinToString("") { String(Character.toChars(it.codePointAt(0))) }.uppercase()
    return letters.ifEmpty { "#" }
  }

  private val palette = listOf(0x2C5BD6 to 0x1AA889, 0x3FA9F5 to 0x0D3480, 0x0B6450 to 0x2EE6C8, 0x1B3B78 to 0x4F8CFF, 0x0A4E8A to 0x1593B8, 0x16316A to 0x7FC8E8)

  /** The two colours (0xRRGGBB) of a community without a picture, chosen by its id (reference: parts.tsx PALETTE and hash). */
  fun gradient(id: String): Pair<Int, Int> {
    var h = 0
    for (unit in id) h = h * 31 + unit.code
    return palette[(Math.abs(h.toLong()) % palette.size).toInt()]
  }

  // Invite links are recognised only on the app's own addresses (reference: types.ts INVITE_LINK); a look-alike
  // on any other host stays plain text.
  private val inviteLink = Pattern.compile("(^|[\\s(«\"'])(?:(?:invizent|linea)://invite/|https://(?:(?:api\\.)?invizent\\.com|141-133-194-51\\.nip\\.io)/i/)([A-Za-z0-9]{6,16})(?![A-Za-z0-9])") // Android's regex already reads \s as any Unicode space; the flag itself is refused there
  private val bareCode = Pattern.compile("^[A-Za-z0-9]{6,16}$")
  private val spacesBeforeBreak = Pattern.compile("[ \\t]+\\n")
  private val manyBreaks = Pattern.compile("\\n{3,}")
  private val mention = Pattern.compile("(^|[^a-z0-9_@])@([a-z0-9_]{3,24})(?![a-z0-9_])", Pattern.CASE_INSENSITIVE)

  /** The code of the first invite link in a text; null when there is none. */
  fun inviteCode(text: String): String? {
    if (!text.contains("/i/") && !text.contains("://invite/")) return null
    val match = inviteLink.matcher(text)
    return if (match.find()) match.group(2) else null
  }

  /** What was typed into «Ссылка или код»: a link's code, or the code itself. */
  fun typedInviteCode(typed: String): String? {
    inviteCode(typed)?.let { return it }
    val bare = typed.trim()
    return if (bareCode.matcher(bare).find()) bare else null
  }

  /** A message's text without its invite links: a link is shown as the banner only. */
  fun withoutInviteLink(text: String): String {
    var out = inviteLink.matcher(text).replaceAll("$1")
    out = spacesBeforeBreak.matcher(out).replaceAll("\n")
    out = manyBreaks.matcher(out).replaceAll("\n\n")
    return out.trim()
  }

  /** The same rule as the server's: «@name» standing on its own. */
  fun mentions(text: String, username: String): Boolean {
    if (text.isEmpty() || username.isEmpty() || !text.contains("@")) return false
    val wanted = username.lowercase()
    val match = mention.matcher(text)
    while (match.find()) if (match.group(2)?.lowercase() == wanted) return true
    return false
  }

  /** The reactions offered in a message's menu (reference: messageMeta.ts REACTIONS, the first seven). */
  val quickReactions = listOf("👍", "❤️", "😂", "😮", "😢", "🔥", "👎")

  /** The colours a role can have (reference: CommunitySettings ROLE_COLORS) and how each is read aloud. */
  val roleColors: List<Pair<String, String>> = listOf(
    "#3FA9F5" to "голубой", "#2EE6C8" to "бирюзовый", "#2FD27A" to "зелёный", "#F5C542" to "жёлтый",
    "#FF7A45" to "оранжевый", "#FF4D6A" to "красный", "#B18CFF" to "сиреневый", "#8A9BB8" to "серый",
  )
}
