import UIKit

// The work behind a channel's chat, all of it OFF the main thread: one queue owns the channel's messages, reads
// what the server answers, takes the live line's events, makes rows and their layouts (kept per message for the
// width they were made at), and hands the main thread small finished patches (ChannelPatch).
// Reference: mobile/src/communities/ChannelChat.tsx (load, older, the socket listener, the merges).

final class ChannelEngine {
    private let server: Server?
    private let communityId: String
    private let channelId: String
    private let queue = DispatchQueue(label: "invizent.channel", qos: .userInitiated)
    private let maker = ChannelRowMaker()

    // Everything below is touched on `queue` only.
    private var context = ChannelContext()
    /// Oldest first.
    private var messages: [CommunityMessage] = []
    private var layouts: [Int: ChannelRowLayout] = [:]
    private var width: CGFloat = 0
    private var hasMore = false
    private var loadingOlder = false
    private var loaded = false
    private var askedInvites = Set<String>()

    /// Called on the main queue.
    var onPatch: (ChannelPatch) -> Void = { _ in }
    /// The first page is here (`error` empty) or could not be read. Main queue.
    var onLoaded: (_ error: String, _ newestId: Int) -> Void = { _, _ in }
    /// A message from someone arrived over the live line: it is read at once. Main queue.
    var onIncoming: (_ messageId: Int) -> Void = { _ in }
    /// A page of older messages could not be read. Main queue.
    var onOlderFailed: () -> Void = {}

    init(server: Server?, communityId: String, channelId: String, blog: Bool, meId: String, meUsername: String, ownerId: String) {
        self.server = server
        self.communityId = communityId
        self.channelId = channelId
        context.blog = blog
        context.meId = meId
        context.meUsername = meUsername
        context.ownerId = ownerId
    }

    // MARK: Asked from the main queue

    func setWidth(_ wide: CGFloat) {
        queue.async {
            guard wide > 0, wide != self.width else { return }
            self.width = wide
            self.layouts.removeAll()
            if self.loaded { self.emitReset() }
        }
    }

    /// The newest page.
    func load() {
        guard let server else { return }
        server.op("channelMessages", [communityId, channelId]) { [weak self] result in
            guard let self else { return }
            self.queue.async {
                switch result {
                case .failure(let error):
                    let words = error.words
                    let known = self.loaded
                    DispatchQueue.main.async { self.onLoaded(known ? "" : words, 0) }
                case .success(let body):
                    let page = body as? [String: Any] ?? [:]
                    self.absorb(page["users"])
                    let fresh = CommunityMessage.list(page["messages"])
                    if self.loaded {
                        // After the line came back: what arrived meanwhile is merged in, nothing is shown twice —
                        // and only the rows that are new or different go to the list.
                        let before = self.messages.map { $0.id }
                        var byId: [Int: CommunityMessage] = [:]
                        for message in self.messages { byId[message.id] = message }
                        for message in fresh { byId[message.id] = message }
                        let merged = byId.values.sorted { $0.id < $1.id }
                        let after = merged.map { $0.id }
                        self.messages = merged
                        if after.count >= before.count, Array(after.prefix(before.count)) == before {
                            self.emitChanged()
                            var patch = ChannelPatch()
                            patch.newest = (before.count..<merged.count).compactMap { self.layout(at: $0).layout }
                            self.emit(patch)
                        } else {
                            self.emitReset()
                        }
                    } else {
                        self.messages = fresh
                        self.hasMore = page["hasMore"] as? Bool ?? false
                        self.loaded = true
                        self.emitReset()
                    }
                    let newest = self.messages.last?.id ?? 0
                    DispatchQueue.main.async { self.onLoaded("", newest) }
                }
            }
        }
    }

    /// The page before the oldest message shown.
    func loadOlder() {
        queue.async {
            guard let server = self.server, self.hasMore, !self.loadingOlder, let oldest = self.messages.first else { return }
            self.loadingOlder = true
            server.op("channelMessages", [self.communityId, self.channelId, oldest.id]) { [weak self] result in
                guard let self else { return }
                self.queue.async {
                    self.loadingOlder = false
                    guard case .success(let body) = result, let page = body as? [String: Any] else {
                        DispatchQueue.main.async { self.onOlderFailed() }
                        return
                    }
                    self.absorb(page["users"])
                    let known = Set(self.messages.map { $0.id })
                    let older = CommunityMessage.list(page["messages"]).filter { !known.contains($0.id) }
                    self.hasMore = page["hasMore"] as? Bool ?? false
                    guard !older.isEmpty else { return }
                    let joint = self.messages.first?.id
                    self.messages.insert(contentsOf: older, at: 0)
                    var patch = ChannelPatch()
                    patch.older = (0..<older.count).compactMap { self.layout(at: $0).layout }
                    // The row that was the oldest now has a message before it (its date line or its header may go).
                    if let joint, let index = self.index(joint) {
                        let made = self.layout(at: index)
                        if made.changed, let layout = made.layout { patch.updated = [layout] }
                    }
                    self.emit(patch)
                }
            }
        }
    }

    /// An event of the live line (already known to be about this community).
    func socket(_ data: [String: Any]) {
        queue.async {
            guard self.loaded, let type = data["type"] as? String else { return }
            if type == "community.message", let message = CommunityMessage(data["message"]), message.channelId == self.channelId {
                var again = false
                if let author = ChannelAuthor(data["user"]), let id = (data["user"] as? [String: Any])?["id"] as? String, self.context.authors[id] != author {
                    self.context.authors[id] = author
                    again = true
                }
                let edited = data["edited"] as? Bool ?? false
                self.merge(message, own: false, everything: again)
                if !edited {
                    let id = message.id
                    DispatchQueue.main.async { self.onIncoming(id) }
                }
            } else if type == "community.message.deleted", data["channelId"] as? String == self.channelId, let id = (data["messageId"] as? NSNumber)?.intValue {
                self.remove(id)
            }
        }
    }

    /// A message the server answered a request of this device with (sent, edited, a reaction put or taken).
    func put(_ raw: Any?, own: Bool) {
        queue.async {
            guard let message = CommunityMessage(raw), message.channelId == self.channelId || message.channelId.isEmpty else { return }
            self.merge(message, own: own, everything: false)
        }
    }

    func removed(_ id: Int) {
        queue.async { self.remove(id) }
    }

    /// The members of the community are known: their names, pictures and the colours of their roles.
    func setMembers(authors: [String: ChannelAuthor], roleColors: [String: UInt32]) {
        queue.async {
            for (id, author) in authors { self.context.authors[id] = author }
            self.context.roleColors = roleColors
            if self.loaded { self.emitChanged() }
        }
    }

    #if targetEnvironment(simulator)
    /// For the simulator's samples: a channel that is simply there.
    func demo(messages: [CommunityMessage], authors: [String: ChannelAuthor], roleColors: [String: UInt32], invites: [String: ChannelInviteCard], meId: String, meUsername: String) {
        queue.async {
            self.context.meId = meId
            self.context.meUsername = meUsername
            self.context.authors = authors
            self.context.roleColors = roleColors
            self.context.invites = invites
            self.askedInvites = Set(invites.keys)
            self.messages = messages
            self.loaded = true
            self.emitReset()
            let newest = messages.last?.id ?? 0
            DispatchQueue.main.async { self.onLoaded("", newest) }
        }
    }
    #endif

    // MARK: On the queue

    private func absorb(_ users: Any?) {
        for raw in users as? [[String: Any]] ?? [] {
            if let id = raw["id"] as? String, let author = ChannelAuthor(raw) { context.authors[id] = author }
        }
    }

    private func index(_ id: Int) -> Int? {
        // Changes are nearly always about the newest messages.
        var at = messages.count - 1
        while at >= 0 {
            if messages[at].id == id { return at }
            at -= 1
        }
        return nil
    }

    /// The layout of the message at an index, made again only when its row or the width has changed.
    private func layout(at index: Int) -> (layout: ChannelRowLayout?, changed: Bool) {
        guard width > 0, index >= 0, index < messages.count else { return (nil, false) }
        let message = messages[index]
        let older = index > 0 ? messages[index - 1] : nil
        var replied: CommunityMessage? = nil
        if message.replyTo != 0, let at = self.index(message.replyTo) { replied = messages[at] }
        if let code = maker.inviteCode(message) { askInvite(code) }
        let row = maker.row(message, older: older, replied: replied, context: context)
        if let kept = layouts[message.id], kept.width == width, kept.row == row, kept.message == message { return (kept, false) }
        let made = ChannelRowLayout(row: row, message: message, width: width)
        layouts[message.id] = made
        return (made, true)
    }

    private func emit(_ patch: ChannelPatch) {
        if patch.isEmpty { return }
        DispatchQueue.main.async { self.onPatch(patch) }
    }

    private func emitReset() {
        guard width > 0 else { return }
        var patch = ChannelPatch()
        patch.reset = (0..<messages.count).compactMap { self.layout(at: $0).layout }
        let kept = Set(messages.map { $0.id })
        layouts = layouts.filter { kept.contains($0.key) }
        DispatchQueue.main.async { self.onPatch(patch) }
    }

    /// Makes every row again and shows the ones that came out different (names, colours, an invitation known).
    private func emitChanged() {
        var patch = ChannelPatch()
        for index in 0..<messages.count {
            let made = layout(at: index)
            if made.changed, let layout = made.layout { patch.updated.append(layout) }
        }
        emit(patch)
    }

    private func merge(_ message: CommunityMessage, own: Bool, everything: Bool) {
        var patch = ChannelPatch()
        if let at = index(message.id) {
            if messages[at] == message && !everything { return }
            messages[at] = message
            if everything {
                emitChanged()
                return
            }
            let made = layout(at: at)
            if made.changed, let layout = made.layout { patch.updated.append(layout) }
            // The rows that answer this message show its words.
            var other = at + 1
            while other < messages.count {
                if messages[other].replyTo == message.id {
                    let again = layout(at: other)
                    if again.changed, let layout = again.layout { patch.updated.append(layout) }
                }
                other += 1
            }
            emit(patch)
        } else if message.id > (messages.last?.id ?? 0) {
            messages.append(message)
            if let layout = layout(at: messages.count - 1).layout { patch.newest = [layout] }
            patch.own = own
            emit(patch)
            if everything { emitChanged() }
        } else {
            // Not the newest and not known: it belongs somewhere in the middle (rare — a merge after a reconnect).
            messages.append(message)
            messages.sort { $0.id < $1.id }
            emitReset()
        }
    }

    private func remove(_ id: Int) {
        guard let at = index(id) else { return }
        messages.remove(at: at)
        layouts[id] = nil
        var patch = ChannelPatch()
        patch.removed = [id]
        // The message after it has a new neighbour; the rows that answered it lose the quoted words.
        for other in at..<messages.count where other == at || messages[other].replyTo == id {
            let made = layout(at: other)
            if made.changed, let layout = made.layout { patch.updated.append(layout) }
        }
        emit(patch)
    }

    /// Asks the server what an invite link leads to, once per code; the rows that carry it are then made again.
    private func askInvite(_ code: String) {
        guard let server, !askedInvites.contains(code) else { return }
        askedInvites.insert(code)
        server.op("invite", [code]) { [weak self] result in
            guard let self else { return }
            self.queue.async {
                if case .success(let body) = result, let preview = InvitePreview(body) {
                    self.context.invites[code] = ChannelInviteCard.known(preview, code: code)
                } else {
                    self.context.invites[code] = ChannelInviteCard.invalid(code)
                }
                if self.loaded { self.emitChanged() }
            }
        }
    }
}
