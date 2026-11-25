import UIKit

// The rows of a channel's chat: what one message looks like, as plain values. A row is made from a message and
// what stands around it (its author, the message before it, the message it answers) — off the main thread, by
// ChannelEngine. Reference: mobile/src/communities/ChannelChat.tsx `render`.

/// Who wrote a message, as the row shows them.
struct ChannelAuthor: Equatable {
    var name: String
    var username: String
    var avatarId: String
    /// 0xRRGGBB.
    var avatarColor: UInt32
    /// The author's Platina is active (the person's `seal`): the small gem stands after the name.
    var platina = false

    init(name: String, username: String, avatarId: String, avatarColor: UInt32) {
        self.name = name
        self.username = username
        self.avatarId = avatarId
        self.avatarColor = avatarColor
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], fields["id"] is String else { return nil }
        name = fields["displayName"] as? String ?? ""
        username = fields["username"] as? String ?? ""
        avatarId = fields["avatarId"] as? String ?? ""
        avatarColor = Messenger.color(fields["avatarColor"] as? String)
        platina = fields["seal"] as? String == "platina"
    }
}

/// The banner of an invitation under a message that carries an invite link.
struct ChannelInviteCard: Equatable {
    /// 0: being asked, 1: not valid, 2: known.
    var state: Int
    var code: String
    var communityId: String
    var blog: Bool
    var closed: Bool
    var name: String
    var avatarId: String
    /// «Игровой · 12 участников».
    var details: String
    var member: Bool

    static func loading(_ code: String) -> ChannelInviteCard {
        return ChannelInviteCard(state: 0, code: code, communityId: "", blog: false, closed: false, name: "", avatarId: "", details: "", member: false)
    }

    static func invalid(_ code: String) -> ChannelInviteCard {
        return ChannelInviteCard(state: 1, code: code, communityId: "", blog: false, closed: false, name: "", avatarId: "", details: "", member: false)
    }

    static func known(_ preview: InvitePreview, code: String) -> ChannelInviteCard {
        let community = preview.community
        let kindWords = community.blog ? ChannelCategory.label(community.category) : "Игровой"
        return ChannelInviteCard(state: 2, code: code, communityId: community.id, blog: community.blog, closed: community.closed, name: community.name,
                                 avatarId: community.avatarId, details: kindWords + " · " + community.countWords, member: preview.isMember)
    }
}

struct ChannelChip: Equatable {
    let emoji: String
    let count: Int
    let mine: Bool
}

/// A link or a mention inside a row's text: UTF-16 offsets, and where it leads (`https://…` or `mention:<name>`).
struct ChannelLink: Equatable {
    let location: Int
    let length: Int
    let url: String
}

/// One message as a row.
struct ChannelRow: Equatable {
    let id: Int
    /// A blog channel shows a message as a card (a post); a server's channel as a line of a conversation.
    var blog = false
    /// The date above the row when a new day begins with it; empty otherwise.
    var day = ""
    /// The first message of a run by one author: the avatar ball, the name and the time stand above the text.
    var header = true
    var senderId = ""
    var author = "Участник"
    /// The colour of the author's highest role (0xRRGGBB); nil: the usual colour of text.
    var authorColor: UInt32?
    var owner = false
    /// The author's Platina is active: the gem after the name (ChannelChat.tsx:199 `PlatinaGem size={10}`).
    var platina = false
    var avatarId = ""
    var avatarColor: UInt32 = 0x5E7BFF
    var initials = ""
    var time = ""
    var edited = false
    var text = ""
    var links: [ChannelLink] = []
    var hasReply = false
    var replyAuthor = ""
    var replyText = ""
    /// 0: none, 1: a picture, 2: a file, 3: a video (shown as a file).
    var attachKind = 0
    var attachId = ""
    var attachName = ""
    var attachSize = ""
    var invite: ChannelInviteCard?
    var chips: [ChannelChip] = []
    /// It mentions the person or answers them: the row stands out.
    var forMe = false

    init(id: Int) {
        self.id = id
    }
}

/// What a row is made in the middle of: the people known so far, the colours of their roles, who is reading.
struct ChannelContext {
    var blog = false
    var meId = ""
    var meUsername = ""
    var ownerId = ""
    var authors: [String: ChannelAuthor] = [:]
    var roleColors: [String: UInt32] = [:]
    var invites: [String: ChannelInviteCard] = [:]

    init() {}
}

/// Makes rows. One of these belongs to one engine and is used on its queue only (it owns date formatters).
final class ChannelRowMaker {
    private let iso: ISO8601DateFormatter = {
        let made = ISO8601DateFormatter()
        made.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return made
    }()
    private let isoPlain = ISO8601DateFormatter()
    private let clock: DateFormatter = {
        let made = DateFormatter()
        made.locale = Locale(identifier: "ru_RU")
        made.dateFormat = "HH:mm"
        return made
    }()
    private let dayWords: DateFormatter = {
        let made = DateFormatter()
        made.locale = Locale(identifier: "ru_RU")
        made.dateFormat = "d MMMM"
        return made
    }()
    private var dates: [String: Date] = [:]

    func date(_ text: String) -> Date? {
        if let known = dates[text] { return known }
        guard let made = iso.date(from: text) ?? isoPlain.date(from: text) else { return nil }
        if dates.count > 4000 { dates.removeAll() }
        dates[text] = made
        return made
    }

    /// The invite codes a message's text carries (at most the first, as the reference shows one banner).
    func inviteCode(_ message: CommunityMessage) -> String? {
        return ChannelWords.inviteCode(in: message.text)
    }

    /// `older`: the message right before this one in the channel; `replied`: the message it answers, when loaded.
    func row(_ message: CommunityMessage, older: CommunityMessage?, replied: CommunityMessage?, context: ChannelContext) -> ChannelRow {
        var row = ChannelRow(id: message.id)
        row.blog = context.blog
        row.senderId = message.senderId
        let moment = date(message.createdAt)
        let before = older.flatMap { date($0.createdAt) }
        if let moment {
            row.time = clock.string(from: moment)
            let sameDay = before.map { Calendar.current.isDate($0, inSameDayAs: moment) } ?? false
            if !sameDay { row.day = dayWords.string(from: moment) }
        }
        var grouped = false
        if !context.blog, let older, older.senderId == message.senderId, let moment, let before {
            grouped = moment.timeIntervalSince(before) < 7 * 60
        }
        row.header = !grouped
        if let author = context.authors[message.senderId] {
            row.author = author.name.isEmpty ? "Участник" : author.name
            row.avatarId = author.avatarId
            row.avatarColor = author.avatarColor
            row.initials = Messenger.initials(author.name)
            row.platina = author.platina
        }
        row.authorColor = context.roleColors[message.senderId]
        row.owner = message.senderId == context.ownerId
        row.edited = message.edited

        var shown = message.text
        if let code = inviteCode(message) {
            shown = ChannelWords.withoutInviteLink(message.text)
            row.invite = context.invites[code] ?? ChannelInviteCard.loading(code)
        }
        row.text = shown
        // Addresses and @names as the core cuts them (the same cutting as in chats).
        if !shown.isEmpty, shown.contains("@") || shown.contains("www.") || shown.contains("://"),
           let laid = Core.view("nativeText", [shown, NSNull()]) as? [String: Any], let text = laid["text"] as? String, text == shown {
            let fmt = (laid["fmt"] as? [NSNumber] ?? []).map { $0.intValue }
            let urls = laid["urls"] as? [String] ?? []
            var link = 0
            var index = 0
            while index + 2 < fmt.count {
                if fmt[index] & 64 != 0 {
                    if link < urls.count { row.links.append(ChannelLink(location: fmt[index + 1], length: fmt[index + 2], url: urls[link])) }
                    link += 1
                }
                index += 3
            }
        }
        if message.replyTo != 0, let replied {
            row.hasReply = true
            row.replyAuthor = context.authors[replied.senderId]?.name ?? "Участник"
            row.replyText = replied.text.isEmpty ? "Вложение" : replied.text.replacingOccurrences(of: "\n", with: " ")
        }
        if let file = message.attachment {
            row.attachId = file.id
            row.attachName = file.name
            row.attachSize = ChannelWords.fileSize(file.size)
            row.attachKind = file.mimeType.hasPrefix("image/") ? 1 : (file.mimeType.hasPrefix("video/") ? 3 : 2)
        }
        row.chips = message.reactions.map { ChannelChip(emoji: $0.emoji, count: $0.count, mine: $0.userIds.contains(context.meId)) }
        if message.senderId != context.meId {
            row.forMe = ChannelWords.mentions(message.text, username: context.meUsername) || (replied?.senderId == context.meId && message.replyTo != 0)
        }
        return row
    }
}
