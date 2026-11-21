import UIKit

// «Каналы»: communities («серверы») with text channels, and blog channels. What the server sends about them,
// as plain values (reference: mobile/src/communities/types.ts, server/src/communities.js). By the reference's
// design communities are not end-to-end encrypted: their messages are read from the server as they are.

/// What a member may do in a community: the bits of `perms` (reference: PERM).
enum Perm {
    static let admin = 1
    static let manageCommunity = 2
    static let manageChannels = 4
    static let manageRoles = 8
    static let invite = 16
    static let send = 32
    static let voice = 64
    static let post = 128
    static let kick = 256
    static let manageMessages = 512
    static let ban = 1024
    static let muteMembers = 2048
    static let deafenMembers = 4096

    struct Label {
        let bit: Int
        let label: String
        /// Only for blog channels / only for servers.
        let blog: Bool
        let server: Bool
    }

    /// The rights a role can be given, in the reference's order and words (PERM_LABELS).
    static let labels: [Label] = [
        Label(bit: send, label: "Писать в каналах", blog: false, server: true),
        Label(bit: voice, label: "Голосовые каналы", blog: false, server: true),
        Label(bit: post, label: "Публиковать посты", blog: true, server: false),
        Label(bit: invite, label: "Приглашать по ссылке", blog: false, server: false),
        Label(bit: manageMessages, label: "Удалять чужие сообщения", blog: false, server: false),
        Label(bit: kick, label: "Исключать участников", blog: false, server: false),
        Label(bit: ban, label: "Блокировать участников", blog: false, server: false),
        Label(bit: muteMembers, label: "Отключать микрофон другим", blog: false, server: true),
        Label(bit: deafenMembers, label: "Отключать звук другим", blog: false, server: true),
        Label(bit: manageChannels, label: "Управлять каналами", blog: false, server: true),
        Label(bit: manageRoles, label: "Управлять ролями", blog: false, server: false),
        Label(bit: manageCommunity, label: "Менять название и фото", blog: false, server: false),
        Label(bit: admin, label: "Администратор (все права)", blog: false, server: false),
    ]
}

/// What a standard channel is about (reference: CATEGORIES).
struct ChannelCategory {
    let id: String
    let label: String
    let symbol: String

    static let all: [ChannelCategory] = [
        ChannelCategory(id: "blog", label: "Блог", symbol: "square.and.pencil"),
        ChannelCategory(id: "news", label: "Новости", symbol: "newspaper"),
        ChannelCategory(id: "music", label: "Музыка", symbol: "music.note"),
        ChannelCategory(id: "tech", label: "Технологии", symbol: "cpu"),
        ChannelCategory(id: "humor", label: "Юмор", symbol: "face.smiling"),
        ChannelCategory(id: "education", label: "Обучение", symbol: "graduationcap"),
        ChannelCategory(id: "sport", label: "Спорт", symbol: "sportscourt"),
        ChannelCategory(id: "games", label: "Игры", symbol: "gamecontroller"),
        ChannelCategory(id: "art", label: "Творчество", symbol: "paintpalette"),
        ChannelCategory(id: "other", label: "Другое", symbol: "ellipsis.circle"),
    ]

    static func label(_ id: String) -> String {
        for item in all where item.id == id { return item.label }
        return "Канал"
    }
}

/// One message of a channel.
struct CommunityMessage: Equatable {
    struct Attachment: Equatable {
        let id: String
        let name: String
        let mimeType: String
        let size: Int
    }

    struct Reaction: Equatable {
        let emoji: String
        let count: Int
        let userIds: [String]
    }

    let id: Int
    let channelId: String
    let senderId: String
    let text: String
    let attachment: Attachment?
    /// 0 when it answers nothing.
    let replyTo: Int
    let createdAt: String
    let edited: Bool
    let reactions: [Reaction]

    init(id: Int, channelId: String, senderId: String, text: String, attachment: Attachment?, replyTo: Int, createdAt: String, edited: Bool, reactions: [Reaction]) {
        self.id = id
        self.channelId = channelId
        self.senderId = senderId
        self.text = text
        self.attachment = attachment
        self.replyTo = replyTo
        self.createdAt = createdAt
        self.edited = edited
        self.reactions = reactions
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let number = fields["id"] as? NSNumber else { return nil }
        id = number.intValue
        channelId = fields["channelId"] as? String ?? ""
        senderId = fields["senderId"] as? String ?? ""
        text = fields["text"] as? String ?? ""
        if let file = fields["attachment"] as? [String: Any], let fileId = file["id"] as? String, !fileId.isEmpty {
            attachment = Attachment(id: fileId, name: file["name"] as? String ?? "", mimeType: file["mimeType"] as? String ?? "", size: (file["size"] as? NSNumber)?.intValue ?? 0)
        } else {
            attachment = nil
        }
        replyTo = (fields["replyTo"] as? NSNumber)?.intValue ?? 0
        createdAt = fields["createdAt"] as? String ?? ""
        edited = fields["editedAt"] is String
        var found: [Reaction] = []
        for item in fields["reactions"] as? [[String: Any]] ?? [] {
            guard let emoji = item["emoji"] as? String, !emoji.isEmpty else { continue }
            found.append(Reaction(emoji: emoji, count: (item["count"] as? NSNumber)?.intValue ?? 1, userIds: item["userIds"] as? [String] ?? []))
        }
        reactions = found
    }

    static func list(_ raw: Any?) -> [CommunityMessage] {
        let rows = raw as? [Any] ?? []
        return rows.compactMap { CommunityMessage($0) }
    }
}

/// A community as the list of communities shows it.
struct CommunitySummary {
    let id: String
    /// "server" or "blog".
    let kind: String
    let category: String
    let closed: Bool
    let name: String
    let about: String
    let avatarId: String
    let ownerId: String
    let memberCount: Int
    let isMember: Bool
    let perms: Int
    /// The text of the newest message the person may see; empty when there is none.
    var lastText: String
    let muted: Bool
    let unread: Int
    let mentions: Int

    var blog: Bool { return kind == "blog" }
    func can(_ bit: Int) -> Bool { return perms & bit != 0 }
    /// «12 участников» / «3 подписчика».
    var countWords: String { return blog ? ChannelWords.subscribers(memberCount) : ChannelWords.members(memberCount) }

    init(id: String, kind: String, category: String, closed: Bool, name: String, about: String, avatarId: String, ownerId: String, memberCount: Int, isMember: Bool, perms: Int, lastText: String, muted: Bool, unread: Int, mentions: Int) {
        self.id = id
        self.kind = kind
        self.category = category
        self.closed = closed
        self.name = name
        self.about = about
        self.avatarId = avatarId
        self.ownerId = ownerId
        self.memberCount = memberCount
        self.isMember = isMember
        self.perms = perms
        self.lastText = lastText
        self.muted = muted
        self.unread = unread
        self.mentions = mentions
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let id = fields["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        kind = fields["kind"] as? String ?? "server"
        category = fields["category"] as? String ?? ""
        closed = fields["closed"] as? Bool ?? false
        name = fields["name"] as? String ?? ""
        about = fields["description"] as? String ?? ""
        avatarId = fields["avatarId"] as? String ?? ""
        ownerId = fields["ownerId"] as? String ?? ""
        memberCount = (fields["memberCount"] as? NSNumber)?.intValue ?? 0
        // Absent in an invite's preview of a community; a summary always says it.
        isMember = fields["isMember"] as? Bool ?? true
        perms = (fields["perms"] as? NSNumber)?.intValue ?? 0
        lastText = (fields["lastMessage"] as? [String: Any])?["text"] as? String ?? ""
        muted = fields["muted"] as? Bool ?? false
        unread = (fields["unreadCount"] as? NSNumber)?.intValue ?? 0
        mentions = (fields["mentionCount"] as? NSNumber)?.intValue ?? 0
    }

    static func list(_ raw: Any?) -> [CommunitySummary] {
        let rows = raw as? [Any] ?? []
        return rows.compactMap { CommunitySummary($0) }
    }
}

struct CommunityRole {
    let id: String
    let name: String
    /// «#RRGGBB», as the server keeps it.
    let colorHex: String
    let position: Int
    let perms: Int
    let isDefault: Bool

    var color: UIColor { return UIColor(hex: Messenger.color(colorHex)) }

    init(id: String, name: String, colorHex: String, position: Int, perms: Int, isDefault: Bool) {
        self.id = id
        self.name = name
        self.colorHex = colorHex
        self.position = position
        self.perms = perms
        self.isDefault = isDefault
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let id = fields["id"] as? String else { return nil }
        self.id = id
        name = fields["name"] as? String ?? ""
        colorHex = fields["color"] as? String ?? "#8A9BB8"
        position = (fields["position"] as? NSNumber)?.intValue ?? 0
        perms = (fields["perms"] as? NSNumber)?.intValue ?? 0
        isDefault = fields["isDefault"] as? Bool ?? false
    }
}

struct CommunityChannel {
    let id: String
    /// "text" or "voice".
    let kind: String
    let name: String
    let topic: String
    let category: String
    let position: Int
    /// Not empty: only these roles see the channel.
    let roleIds: [String]
    /// How many people are in a voice channel now.
    let voiceCount: Int
    let unread: Int
    let mentions: Int

    var isText: Bool { return kind == "text" }

    init(id: String, kind: String, name: String, topic: String, category: String, position: Int, roleIds: [String], voiceCount: Int, unread: Int, mentions: Int) {
        self.id = id
        self.kind = kind
        self.name = name
        self.topic = topic
        self.category = category
        self.position = position
        self.roleIds = roleIds
        self.voiceCount = voiceCount
        self.unread = unread
        self.mentions = mentions
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let id = fields["id"] as? String else { return nil }
        self.id = id
        kind = fields["kind"] as? String ?? "text"
        name = fields["name"] as? String ?? ""
        topic = fields["topic"] as? String ?? ""
        category = fields["category"] as? String ?? ""
        position = (fields["position"] as? NSNumber)?.intValue ?? 0
        roleIds = fields["roleIds"] as? [String] ?? []
        voiceCount = (fields["voice"] as? [Any])?.count ?? 0
        unread = (fields["unread"] as? NSNumber)?.intValue ?? 0
        mentions = (fields["mentions"] as? NSNumber)?.intValue ?? 0
    }
}

/// A community opened: what the list knows, and its roles and channels.
struct Community {
    var summary: CommunitySummary
    var roles: [CommunityRole]
    var myRoleIds: [String]
    var channels: [CommunityChannel]

    var id: String { return summary.id }
    var blog: Bool { return summary.blog }
    func can(_ bit: Int) -> Bool { return summary.can(bit) }

    init(summary: CommunitySummary, roles: [CommunityRole], myRoleIds: [String], channels: [CommunityChannel]) {
        self.summary = summary
        self.roles = roles
        self.myRoleIds = myRoleIds
        self.channels = channels
    }

    init?(_ raw: Any?) {
        guard let summary = CommunitySummary(raw), let fields = raw as? [String: Any] else { return nil }
        self.summary = summary
        roles = (fields["roles"] as? [Any] ?? []).compactMap { CommunityRole($0) }
        myRoleIds = fields["myRoleIds"] as? [String] ?? []
        channels = (fields["channels"] as? [Any] ?? []).compactMap { CommunityChannel($0) }
    }

    /// The channels in groups, as the reference groups them: by the channel's own category, else «Текстовые
    /// каналы» / «Голосовые каналы»; groups in the order their first channel comes.
    var groups: [(name: String, channels: [CommunityChannel])] {
        var order: [String] = []
        var byName: [String: [CommunityChannel]] = [:]
        for channel in channels {
            let key = channel.category.isEmpty ? (channel.isText ? "Текстовые каналы" : "Голосовые каналы") : channel.category
            if byName[key] == nil { order.append(key) }
            byName[key, default: []].append(channel)
        }
        return order.map { (name: $0, channels: byName[$0] ?? []) }
    }

    /// The colour of a member's name: their highest role that is not «everyone» (reference: ChannelChat roleColors).
    func nameColor(roleIds: [String]) -> UInt32? {
        let ranked = roles.filter { !$0.isDefault }.sorted { $0.position > $1.position }
        for role in ranked where roleIds.contains(role.id) { return Messenger.color(role.colorHex) }
        return nil
    }
}

struct CommunityMember {
    let user: Person
    let roleIds: [String]
    let owner: Bool

    init(user: Person, roleIds: [String], owner: Bool) {
        self.user = user
        self.roleIds = roleIds
        self.owner = owner
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let user = Person(fields["user"]) else { return nil }
        self.user = user
        roleIds = fields["roleIds"] as? [String] ?? []
        owner = fields["owner"] as? Bool ?? false
    }

    static func list(_ raw: Any?) -> [CommunityMember] {
        let rows = raw as? [Any] ?? []
        return rows.compactMap { CommunityMember($0) }
    }
}

/// What an invitation leads to, before it is accepted.
struct InvitePreview {
    let code: String
    let community: CommunitySummary
    let isMember: Bool

    init(code: String, community: CommunitySummary, isMember: Bool) {
        self.code = code
        self.community = community
        self.isMember = isMember
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let community = CommunitySummary(fields["community"]) else { return nil }
        code = fields["code"] as? String ?? ""
        self.community = community
        isMember = fields["isMember"] as? Bool ?? false
    }
}

/// The words and small rules of the section, ported from the reference word for word
/// (communities/parts.tsx, communities/types.ts, communities/unread.ts, unreadBadge.ts, theme.ts formatSize).
enum ChannelWords {
    /// «1 234», «12,3 тыс.», «1,2 млн».
    static func compactCount(_ count: Int) -> String {
        let n = max(0, count)
        func short(_ tenths: Int, _ unit: String) -> String {
            let whole = tenths / 10, part = tenths % 10
            return (part == 0 ? "\(whole)" : "\(whole),\(part)") + "\u{00A0}" + unit
        }
        if n >= 1_000_000 { return short(n / 100_000, "млн") }
        if n >= 10_000 { return short(n / 100, "тыс.") }
        if n >= 1000 {
            let rest = n % 1000
            let padded = rest < 10 ? "00\(rest)" : rest < 100 ? "0\(rest)" : "\(rest)"
            return "\(n / 1000)\u{202F}" + padded
        }
        return String(n)
    }

    private static func counted(_ count: Int, _ one: String, _ few: String, _ many: String) -> String {
        let n = max(0, count)
        if n >= 10_000 { return compactCount(n) + " " + many }
        let mod10 = n % 10, mod100 = n % 100
        let word = mod10 == 1 && mod100 != 11 ? one : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many)
        return compactCount(n) + " " + word
    }

    static func members(_ count: Int) -> String { return counted(count, "участник", "участника", "участников") }
    static func subscribers(_ count: Int) -> String { return counted(count, "подписчик", "подписчика", "подписчиков") }

    /// A counter on a badge: exact up to 999, then «4,3K», «12K», «1,2M».
    static func badge(_ n: Int) -> String {
        if n < 1 { return "" }
        if n < 1000 { return String(n) }
        func short(_ tenths: Int, _ unit: String) -> String {
            let whole = tenths / 10, part = tenths % 10
            if whole >= 10 { return "\(whole)" + unit }
            return (part == 0 ? "\(whole)" : "\(whole),\(part)") + unit
        }
        if n < 1_000_000 { return short(n / 100, "K") }
        return short(n / 100_000, "M")
    }

    static func fileSize(_ bytes: Int) -> String {
        let value = Double(max(0, bytes))
        if bytes < 1024 { return "\(max(0, bytes)) Б" }
        if bytes < 1024 * 1024 { return String(format: "%.0f КБ", value / 1024) }
        if bytes >= 1024 * 1024 * 1024 { return String(format: "%.1f ГБ", value / 1024 / 1024 / 1024) }
        return String(format: "%.1f МБ", value / 1024 / 1024)
    }

    /// The letters on a community's picture when it has none: the first letters of its first two words, else «#».
    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: { $0.isWhitespace })
        let letters = words.prefix(2).compactMap { $0.first }.map { String($0) }.joined().uppercased()
        return letters.isEmpty ? "#" : letters
    }

    private static let palette: [(UInt32, UInt32)] = [(0x2C5BD6, 0x1AA889), (0x3FA9F5, 0x0D3480), (0x0B6450, 0x2EE6C8), (0x1B3B78, 0x4F8CFF), (0x0A4E8A, 0x1593B8), (0x16316A, 0x7FC8E8)]

    /// The two colours of a community without a picture, chosen by its id (reference: parts.tsx PALETTE and hash).
    static func gradient(_ id: String) -> (UInt32, UInt32) {
        var h: Int32 = 0
        for unit in id.utf16 { h = h &* 31 &+ Int32(truncatingIfNeeded: Int(unit)) }
        let index = Int(Int64(h).magnitude % UInt64(palette.count))
        return palette[index]
    }

    // Invite links are recognised only on the app's own addresses (reference: types.ts INVITE_LINK); a look-alike
    // on any other host stays plain text.
    private static let invitePattern = "(^|[\\s(«\"'])(?:(?:invizent|linea)://invite/|https://(?:(?:api\\.)?invizent\\.com|141-133-194-51\\.nip\\.io)/i/)([A-Za-z0-9]{6,16})(?![A-Za-z0-9])"
    private static let inviteLink = try? NSRegularExpression(pattern: invitePattern, options: [])
    private static let bareCode = try? NSRegularExpression(pattern: "^[A-Za-z0-9]{6,16}$", options: [])
    private static let spacesBeforeBreak = try? NSRegularExpression(pattern: "[ \\t]+\\n", options: [])
    private static let manyBreaks = try? NSRegularExpression(pattern: "\\n{3,}", options: [])
    private static let mention = try? NSRegularExpression(pattern: "(^|[^a-z0-9_@])@([a-z0-9_]{3,24})(?![a-z0-9_])", options: [.caseInsensitive])

    /// The code of the first invite link in a text; nil when there is none.
    static func inviteCode(in text: String) -> String? {
        guard text.contains("/i/") || text.contains("://invite/"), let inviteLink else { return nil }
        let whole = text as NSString
        guard let match = inviteLink.firstMatch(in: text, options: [], range: NSRange(location: 0, length: whole.length)), match.numberOfRanges > 2 else { return nil }
        return whole.substring(with: match.range(at: 2))
    }

    /// What was typed into «Ссылка или код»: a link's code, or the code itself.
    static func typedInviteCode(_ typed: String) -> String? {
        if let code = inviteCode(in: typed) { return code }
        let bare = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let bareCode, bareCode.firstMatch(in: bare, options: [], range: NSRange(location: 0, length: (bare as NSString).length)) != nil else { return nil }
        return bare
    }

    /// A message's text without its invite links: a link is shown as the banner only.
    static func withoutInviteLink(_ text: String) -> String {
        guard let inviteLink, let spacesBeforeBreak, let manyBreaks else { return text }
        var out = inviteLink.stringByReplacingMatches(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "$1")
        out = spacesBeforeBreak.stringByReplacingMatches(in: out, options: [], range: NSRange(location: 0, length: (out as NSString).length), withTemplate: "\n")
        out = manyBreaks.stringByReplacingMatches(in: out, options: [], range: NSRange(location: 0, length: (out as NSString).length), withTemplate: "\n\n")
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The same rule as the server's: «@name» standing on its own.
    static func mentions(_ text: String, username: String) -> Bool {
        guard !text.isEmpty, !username.isEmpty, text.contains("@"), let mention else { return false }
        let whole = text as NSString
        let wanted = username.lowercased()
        for match in mention.matches(in: text, options: [], range: NSRange(location: 0, length: whole.length)) where match.numberOfRanges > 2 {
            if whole.substring(with: match.range(at: 2)).lowercased() == wanted { return true }
        }
        return false
    }

    /// The reactions offered in a message's menu (reference: messageMeta.ts REACTIONS, the first seven).
    static let quickReactions = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👎"]
    /// The colours a role can have (reference: CommunitySettings ROLE_COLORS) and how each is read aloud.
    static let roleColors: [(hex: String, spoken: String)] = [("#3FA9F5", "голубой"), ("#2EE6C8", "бирюзовый"), ("#2FD27A", "зелёный"), ("#F5C542", "жёлтый"),
                                                              ("#FF7A45", "оранжевый"), ("#FF4D6A", "красный"), ("#B18CFF", "сиреневый"), ("#8A9BB8", "серый")]
}
