import UIKit

/// The messages of one open chat: the pages read from the server (each message as this device decrypted and kept
/// it), what is on its way out, and the rows the list draws for them.
///
/// Everything a person does to a message — an edit, a deletion for both, a reaction, a pin — is itself an
/// end-to-end encrypted message (`meta.action`, the reference's messageMeta.ts); the server cannot tell it from
/// any other. They are folded into the lines they belong to by the shared core (`foldChat`), exactly as the
/// other phone folds them.
///
/// Main queue only; the folding itself runs on a queue of its own and its result comes back to the main one.
final class ChatHistory {
    /// A message handed to the encryption and not yet seen in a page from the server.
    struct Pending {
        let clientId: String
        let text: String
        let meta: [String: Any]?
        let attachment: [String: Any]?
        let createdAt: String
        var failed = false
        /// LinkPreview: the card of a link in the text, made on this phone (Sources/LinkPreview); nil: none.
        var linkPreview: [String: Any]? = nil
        /// Composer: «Отправить позже» — the moment the server releases it (ISO); nil: now.
        var deliverAt: String? = nil
    }

    /// What the screen shows, made from the messages by `build`.
    struct Shown {
        /// Rows for `MsgRow.parse`, oldest first.
        var rows: [[String: Any]] = []
        /// The folded message of a row, by the row's key (`senderId:clientId`).
        var messages: [String: [String: Any]] = [:]
        /// The row of a message, by its clientId.
        var keyOfClient: [String: String] = [:]
        /// ChatsPlus: the `end` action of a finished call, by its row's key (a touch calls back).
        var calls: [String: [String: Any]] = [:]
        /// The keys of the message rows, oldest first.
        var order: [String] = []
        var pinned: [String: Any]?
        /// The chat's rule «копирование запрещено» (an encrypted setting both sides follow).
        var noCopy = false
        /// Profile: the chat's encrypted rule «Автоудаление» in seconds (0: off), as the core folds it.
        var ttl: Double = 0
        /// The newest message of the other side among everything loaded (what «read» is reported up to).
        var newestTheirs = 0
        /// Messages that are loaded but cannot be read on this device (sent before it signed in), by clientId.
        var noKey = Set<String>()
        var failedActions = 0
        /// Attachments: the keys of an album's further photos, by the key of the album's row.
        var albumParts: [String: [String]] = [:]
        /// ChatActions: how many messages hold the words of the search.
        var found = 0
    }

    private struct Snapshot {
        let raw: [[String: Any]]
        let pending: [Pending]
        let hidden: [String]
        let selection: Set<String>?
        let peerLastRead: Int
        let unreadAfter: Int?
        let userId: String
        let peerName: String
        /// Polls: the options ticked so far in polls with several answers, by row key.
        var pollDrafts: [String: [Int]] = [:]
        /// ChatActions: the words of the search in this chat (empty: none).
        var needle = ""
    }

    private typealias Page = (messages: [[String: Any]], hasMore: Bool)

    /// Ids of messages that are not on the server yet stand after every real one.
    private static let localBase = 9_000_000_000_000
    private static let queue = DispatchQueue(label: "invizent.chat-view", qos: .userInitiated)
    private static let stamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private let messenger: Messenger?
    private let local: ChatLocal?
    let chatId: String
    let peerId: String
    let userId: String
    var peerName: String

    private var raw: [[String: Any]] = []
    private(set) var hasMore = false
    private(set) var loadingOlder = false
    private var loadingNewest = false
    private var loadAgain = false
    private var pending: [Pending] = []
    private var generation = 0
    private var demoHidden: [String] = []
    private var demoNext = 100
    private(set) var loadedOnce = false
    /// Offline: the page shown last time was looked for in the vault (once per opening).
    private var cacheTried = false

    private(set) var shown = Shown()
    /// Rows chosen in the multi-select; nil when nothing is being selected.
    var selection: Set<String>? { didSet { if selection != oldValue { rebuild() } } }
    var peerLastRead = 0 { didSet { if peerLastRead != oldValue { rebuild() } } }
    /// The last message read before the chat was opened: «Непрочитанные сообщения» stands after it. Nil: no line.
    var unreadAfter: Int? { didSet { if unreadAfter != oldValue { rebuild() } } }

    /// The rows changed.
    var onShown: ((Shown) -> Void)?
    /// A page came from the server (not an older one): the newest message of the other side in it.
    var onLoaded: ((Int) -> Void)?
    /// Something could not be sent or read: the words for the person.
    var onProblem: ((String) -> Void)?

    init(messenger: Messenger?, chatId: String, peerId: String, peerName: String) {
        self.messenger = messenger
        self.local = messenger.map { ChatLocal.of($0) }
        self.chatId = chatId
        self.peerId = peerId
        self.peerName = peerName
        userId = messenger?.userId ?? "demo-me"
    }

    static func number(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    static func key(_ message: [String: Any]) -> String { (message["senderId"] as? String ?? "") + ":" + (message["clientId"] as? String ?? "") }
    static func action(_ message: [String: Any]) -> [String: Any]? { (message["meta"] as? [String: Any])?["action"] as? [String: Any] }

    // MARK: Reading

    /// Reads the newest page (or, with `older`, the page before the oldest loaded one) and shows it.
    func load(older: Bool = false, done: ((Bool) -> Void)? = nil) {
        guard let messenger else {
            loadedOnce = true
            rebuild()
            done?(true)
            return
        }
        var before: Int? = nil
        if older {
            guard hasMore, !loadingOlder, let oldest = raw.first else { done?(false); return }
            before = ChatHistory.number(oldest["id"])
            loadingOlder = true
        } else {
            if loadingNewest { loadAgain = true; done?(false); return }
            loadingNewest = true
            showKept(messenger)
        }
        let (chatId, me) = (self.chatId, self.userId)
        let pageBefore = before
        messenger.crypto.run({ (crypto: CryptoService) -> Result<(page: Page, newestTheirs: Int), ServerError> in
            var args: [Any] = [chatId]
            if let pageBefore { args.append(pageBefore) }
            // Offline: the page request goes out together with the inbox sync (one round trip saved before the chat
            // shows, as in the reference); a sync that failed does not hold the page back — what was opened and kept
            // before is shown. The page is opened only after the sync has consumed the envelopes.
            var asked: Result<Any, ServerError> = .failure(.timeout)
            let answered = DispatchSemaphore(value: 0)
            messenger.server.op("messages", args) { (result: Result<Any, ServerError>) -> Void in
                asked = result
                answered.signal()
            }
            _ = crypto.callNow("sync", [chatId])
            answered.wait()
            switch asked {
            case .failure(let error): return .failure(error)
            case .success(let body):
                let fields = body as? [String: Any]
                let list = fields?["messages"] as? [[String: Any]] ?? []
                var opened: [[String: Any]] = []
                for message in list {
                    guard case .success(let value) = crypto.callNow("preview", [message]), let plain = value as? [String: Any] else { continue }
                    opened.append(plain)
                }
                let theirs = list.filter { $0["senderId"] as? String != me }.map { ChatHistory.number($0["id"]) }.max() ?? 0
                let more = fields?["hasMore"] as? Bool ?? false
                return .success((page: (messages: opened, hasMore: more), newestTheirs: theirs))
            }
        }, done: { [weak self] (result: Result<(page: Page, newestTheirs: Int), ServerError>) -> Void in
            guard let self else { return }
            if older { self.loadingOlder = false } else { self.loadingNewest = false }
            switch result {
            case .failure(let error):
                if older { self.onProblem?(error.words) }
                done?(false)
            case .success(let answer):
                self.loadedOnce = true
                self.apply(answer.page.messages, older: older, more: answer.page.hasMore)
                self.rebuild()
                self.keepSoon()
                if !older { self.onLoaded?(answer.newestTheirs) }
                done?(true)
            }
            if !older, self.loadAgain {
                self.loadAgain = false
                self.load()
            }
        })
    }

    /// Offline: the page shown last time (the vault's copy) is on screen at once, also without a network, while
    /// the server is asked (the reference's useMessenger `loadMessages`).
    private func showKept(_ messenger: Messenger) {
        guard !cacheTried, raw.isEmpty, let name = ChatCache.pageName(chatId) else { return }
        cacheTried = true
        let (crypto, chatId) = (messenger.crypto, self.chatId)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let kept = ChatCache.decodePage(crypto.loadCacheAtOnce(name), chatId: chatId)
            DispatchQueue.main.async {
                guard let self, let kept, self.raw.isEmpty else { return }
                self.raw = kept.messages
                self.hasMore = kept.hasMore
                self.rebuild()
            }
        }
    }

    /// Offline: the chat's newest messages go to the vault a moment after a page came.
    private func keepSoon() {
        keepWork?.cancel()
        guard let messenger, let name = ChatCache.pageName(chatId) else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.raw.isEmpty, let text = ChatCache.encodePage(self.raw, hasMore: self.hasMore) else { return }
            messenger.crypto.call("storeCache", [name, text]) { _ in }
        }
        keepWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }
    private var keepWork: DispatchWorkItem?

    /// A page applied to what is loaded (the reference's messagePages.ts `applyPage`): an older page is only added;
    /// the newest page replaces its own range of ids, so a message deleted on the server goes, while the history
    /// scrolled up earlier stays — unless the page does not reach it, when a gap would be left.
    private func apply(_ page: [[String: Any]], older: Bool, more: Bool) {
        let id: ([String: Any]) -> Int = { ChatHistory.number($0["id"]) }
        func merged(_ first: [[String: Any]], _ second: [[String: Any]]) -> [[String: Any]] {
            var byId: [Int: [String: Any]] = [:]
            for message in first { byId[id(message)] = message }
            for message in second { byId[id(message)] = message }
            return byId.keys.sorted().compactMap { byId[$0] }
        }
        // What the server has now is no longer «on its way out».
        let confirmed = Set(page.filter { $0["senderId"] as? String == userId }.compactMap { $0["clientId"] as? String })
        pending.removeAll { confirmed.contains($0.clientId) }
        if older {
            raw = merged(page, raw)
            hasMore = more
            return
        }
        guard let low = page.map(id).min(), let high = page.map(id).max() else {
            raw = []
            hasMore = false
            return
        }
        let overlap = raw.contains { id($0) >= low && id($0) <= high }
        let kept = raw.filter { id($0) > high || (id($0) < low && more && overlap) }
        let olderKept = kept.contains { id($0) < low }
        raw = merged(page, kept)
        hasMore = olderKept ? hasMore : more
    }

    /// Whether a message is known to be gone: it is loaded but folded out of the view, or its deletion is loaded.
    func knownDeleted(_ clientId: String) -> Bool {
        if shown.keyOfClient[clientId] != nil || shown.noKey.contains(clientId) { return false }
        return raw.contains { (message: [String: Any]) -> Bool in
            if message["clientId"] as? String == clientId { return true }
            guard let action = ChatHistory.action(message) else { return false }
            return action["type"] as? String == "delete" && action["target"] as? String == clientId
        }
    }

    // MARK: Sending

    /// Sends a message of this chat: a plain one, an answer (`meta.reply`), a forwarded one, or an action.
    /// LinkPreview: `linkPreview` is the card of a link the person typed (the core checks it once more).
    func send(text: String, meta: [String: Any]?, attachment: [String: Any]? = nil, linkPreview: [String: Any]? = nil, deliverAt: String? = nil) {
        var item = Pending(clientId: UUID().uuidString.lowercased(), text: text, meta: meta, attachment: attachment, createdAt: ChatHistory.stamp.string(from: Date()))
        item.linkPreview = linkPreview
        // Composer: a scheduled message is shown as being sent until the server keeps it (then it is in the list
        // of «Отложенные сообщения», Sources/Composer/ScheduledScreen.swift).
        item.deliverAt = deliverAt
        pending.append(item)
        rebuild()
        deliver(item)
    }

    /// An edit, a deletion for both, a reaction or a pin: sent as an ordinary encrypted message. The text that
    /// goes with it is what a client that does not know the action would show (the core words it).
    func sendAction(_ action: [String: Any], targetText: String = "") {
        let fallback = Core.view("actionFallback", [action, targetText]) as? String ?? ""
        send(text: fallback, meta: ["action": action])
    }

    /// Sends again what was refused.
    func retryFailed() {
        for index in pending.indices where pending[index].failed {
            pending[index].failed = false
            deliver(pending[index])
        }
        rebuild()
    }

    private func deliver(_ item: Pending) {
        // Composer: «Отправить позже» goes its own road (Sources/Composer/ScheduledStore.swift).
        if let deliverAt = item.deliverAt {
            deliverLater(item, at: deliverAt)
            return
        }
        guard let messenger else {
            #if targetEnvironment(simulator)
            // The sample chat: the message is simply there.
            pending.removeAll { $0.clientId == item.clientId }
            demoNext += 1
            var message: [String: Any] = ["id": demoNext, "chatId": chatId, "senderId": userId, "clientId": item.clientId, "text": item.text,
                                          "attachment": NSNull(), "createdAt": item.createdAt, "cryptoState": "decrypted"]
            if let meta = item.meta { message["meta"] = meta }
            if let card = item.linkPreview { message["linkPreview"] = card }
            raw.append(message)
            rebuild()
            #endif
            return
        }
        let (chatId, peerId) = (self.chatId, self.peerId)
        var attachment: Any = NSNull()
        if let file = item.attachment { attachment = file }
        var meta: Any = NSNull()
        if let fields = item.meta { meta = fields }
        let (sentAttachment, sentMeta) = (attachment, meta)
        var card: Any = NSNull()
        if let preview = item.linkPreview { card = preview }
        let sentCard = card
        messenger.crypto.run({ (crypto: CryptoService) -> Result<Void, CryptoFailure> in
            messenger.deliver(crypto, chatId: chatId, peerId: peerId, clientId: item.clientId, text: item.text, attachment: sentAttachment, meta: sentMeta, linkPreview: sentCard)
        }, done: { [weak self] (result: Result<Void, CryptoFailure>) -> Void in
            guard let self else { return }
            switch result {
            case .success:
                // The page read next holds it; until then it stays shown as being sent.
                self.load()
            case .failure(let failure):
                // Without an answer it is kept among the unsent and goes out by itself, with the same ciphertext.
                if failure.name == "NetworkError" { return }
                if let index = self.pending.firstIndex(where: { $0.clientId == item.clientId }) { self.pending[index].failed = true }
                self.rebuild()
                self.onProblem?(failure.message)
            }
        })
    }

    /// Polls: the options ticked so far in polls with several answers, by row key (until «Голосовать»).
    var pollDrafts: [String: [Int]] = [:] { didSet { rebuild() } }
    /// ChatActions: the words of the search in this chat (empty: the whole chat shows).
    var searchNeedle = "" { didSet { if searchNeedle != oldValue { rebuild() } } }

    /// Composer: a scheduled message was handed to the server (the moment it goes out, ISO).
    var onScheduled: ((String) -> Void)?

    /// Composer: encrypted now, kept by the server until `deliverAt`. While it is on its way it is shown as being
    /// sent; once the server keeps it, it leaves the chat for the list of scheduled messages.
    private func deliverLater(_ item: Pending, at deliverAt: String) {
        guard let messenger else {
            pending.removeAll { $0.clientId == item.clientId }
            rebuild()
            onScheduled?(deliverAt)
            return
        }
        let (chatId, peerId) = (self.chatId, self.peerId)
        var attachment: Any = NSNull()
        if let file = item.attachment { attachment = file }
        var meta: Any = NSNull()
        if let fields = item.meta { meta = fields }
        let (sentAttachment, sentMeta) = (attachment, meta)
        messenger.crypto.run({ (crypto: CryptoService) -> Result<Bool, CryptoFailure> in
            messenger.deliverLater(crypto, chatId: chatId, peerId: peerId, clientId: item.clientId, text: item.text, attachment: sentAttachment, meta: sentMeta, deliverAt: deliverAt)
        }, done: { [weak self] (result: Result<Bool, CryptoFailure>) -> Void in
            guard let self else { return }
            switch result {
            case .success(let later):
                if later {
                    self.pending.removeAll { $0.clientId == item.clientId }
                    self.rebuild()
                    ScheduledStore.of(messenger).refresh()
                    self.onScheduled?(deliverAt)
                } else {
                    // The time had passed: it went out at once and the next page holds it.
                    self.load()
                }
            case .failure(let failure):
                if failure.name == "NetworkError" { return }
                if let index = self.pending.firstIndex(where: { $0.clientId == item.clientId }) { self.pending[index].failed = true }
                self.rebuild()
                self.onProblem?(failure.message)
            }
        })
    }

    /// «Удалить у меня»: the messages disappear on this device only.
    func hideForMe(_ keys: [String]) {
        if let local { local.hide(keys) } else { demoHidden += keys }
        rebuild()
    }

    // MARK: The rows

    func rebuild() {
        generation += 1
        let run = generation
        let snapshot = Snapshot(raw: raw, pending: pending, hidden: local?.hiddenKeys ?? demoHidden, selection: selection, peerLastRead: peerLastRead,
                                unreadAfter: unreadAfter, userId: userId, peerName: peerName, pollDrafts: pollDrafts, needle: searchNeedle)
        ChatHistory.queue.async {
            let made = ChatHistory.build(snapshot)
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == run else { return }
                self.shown = made
                self.onShown?(made)
            }
        }
    }

    private static func missingWords(_ count: Int) -> String {
        if count % 10 == 1 && count % 100 != 11 { return "сообщение" }
        if count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) { return "сообщения" }
        return "сообщений"
    }

    /// The notice of a run of messages this device cannot open, in the reference's words (MessageRow.tsx `MissingRow`).
    static func missingText(_ count: Int) -> String {
        "\(count) \(missingWords(count)) до входа на этом устройстве. Они зашифрованы для других твоих устройств и здесь не открываются."
    }

    /// The quote above an answer (the reference's replyQuote.ts): the original as it is now when it is loaded,
    /// else the line stored with the answer; «Сообщение удалено» when there is neither.
    static func quoteText(original: [String: Any]?, stored: String) -> String {
        if let original, let line = Core.view("replyPreview", [original]) as? String, !line.isEmpty { return line }
        let kept = stored.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).joined(separator: " ")
        return kept.isEmpty ? "Сообщение удалено" : kept
    }

    private static func build(_ input: Snapshot) -> Shown {
        var out = Shown()
        var all = input.raw
        for (index, item) in input.pending.enumerated() {
            // Shown at once (as in the reference): the message itself as being sent, an action as already applied.
            var message: [String: Any] = ["id": localBase + index, "senderId": input.userId, "clientId": item.clientId, "text": item.text,
                                          "attachment": NSNull(), "createdAt": item.createdAt, "cryptoState": "decrypted",
                                          "localState": item.failed ? "failed" : "sending"]
            if let file = item.attachment { message["attachment"] = file }
            if let meta = item.meta { message["meta"] = meta }
            if let card = item.linkPreview { message["linkPreview"] = card }
            if item.failed, item.meta?["action"] != nil {
                out.failedActions += 1
                continue
            }
            all.append(message)
        }
        out.newestTheirs = input.raw.filter { $0["senderId"] as? String != input.userId }.map { number($0["id"]) }.max() ?? 0

        var messages: [[String: Any]] = []
        let args: [Any] = [all, input.userId, input.hidden, Date().timeIntervalSince1970 * 1000]
        if let folded = Core.view("foldChat", args) as? [String: Any], let lines = folded["messages"] as? [[String: Any]] {
            messages = lines
            out.pinned = folded["pinned"] as? [String: Any]
            out.noCopy = (folded["rules"] as? [String: Any])?["noCopy"] as? Bool ?? false
            out.ttl = ((folded["rules"] as? [String: Any])?["ttl"] as? NSNumber)?.doubleValue ?? 0 // Profile
        } else {
            messages = all.filter { action($0) == nil }
        }
        var byClient: [String: [String: Any]] = [:]
        for message in messages {
            if let client = message["clientId"] as? String { byClient[client] = message }
        }

        var rows: [[String: Any]] = []
        var day = ""
        var missingRow = -1
        var missingCount = 0
        var unreadShown = false
        for (index, message) in messages.enumerated() {
            let sender = message["senderId"] as? String ?? ""
            let client = message["clientId"] as? String ?? ""
            let key = sender + ":" + client
            let mine = sender == input.userId
            let id = number(message["id"])
            let date = Messenger.date(message["createdAt"] as? String)
            let today = date.map { Messenger.dayWords($0) } ?? ""
            let clock = date.map { Messenger.clock.string(from: $0) } ?? ""
            // ChatActions: while searching, only the messages that hold the words (Sources/ChatActions/ChatSearch.swift).
            if !input.needle.isEmpty {
                guard message["cryptoState"] as? String != "no-key", action(message) == nil, matches(message, needle: input.needle) else { continue }
            }
            // Offline: messages this device has no key for (sent before it signed in) are ONE notice for the whole
            // run, across days — no day lines between them; the next readable message gets its day line again.
            if message["cryptoState"] as? String == "no-key", missingRow >= 0 {
                out.noKey.insert(client)
                missingCount += 1
                rows[missingRow]["text"] = missingText(missingCount)
                continue
            }
            if today != day, !today.isEmpty {
                day = today
                rows.append(["key": "d" + key, "kind": 1, "text": today, "label": "day"]) // MessageRow.tsx DayChip
                missingRow = -1
            }
            // The reference's chat (ChatScreen.tsx) draws no «Непрочитанные сообщения» line: none here either.
            if input.unreadAfter != nil, !unreadShown, !mine, id > (input.unreadAfter ?? 0), id < localBase { unreadShown = true }
            // A run of messages this device has no key for is one line.
            if message["cryptoState"] as? String == "no-key" {
                out.noKey.insert(client)
                missingCount = 1
                missingRow = rows.count
                rows.append(["key": "x" + key, "kind": 2, "text": missingText(missingCount)])
                continue
            }
            missingRow = -1
            let meta = message["meta"] as? [String: Any]
            // A finished call is a line of its own, not a message of anyone's.
            if let action = meta?["action"] as? [String: Any], action["type"] as? String == "call" {
                // Calls: the row names the direction («Исходящий звонок · 3:12»), as the reference's chat does.
                let words = Core.view("callServiceText", [action, sender, input.userId]) as? String ?? Core.view("chatListText", [message]) as? String ?? (message["text"] as? String ?? "")
                if action["step"] as? String == "end" {
                    out.calls[key] = action // ChatsPlus
                    // MessageRow.tsx CallServiceRow: a pill with the round icon, the words and the time under them;
                    // red for a missed or declined call. "call", then "!" when red and "v" for a video call.
                    let red = words.hasPrefix("Пропущенный") || words.hasPrefix("Отклонённый")
                    let video = action["video"] as? Bool == true
                    rows.append(["key": key, "kind": 1, "text": words, "time": clock, "label": "call" + (red ? "!" : "") + (video ? "v" : "")])
                } else {
                    rows.append(["key": key, "kind": 1, "text": clock.isEmpty ? words : words + " · " + clock])
                }
                continue
            }
            let next: [String: Any]? = index + 1 < messages.count ? messages[index + 1] : nil
            var tail = true
            if let next, action(next) == nil, next["senderId"] as? String == sender,
               let nextDate = Messenger.date(next["createdAt"] as? String), let date {
                tail = Messenger.dayWords(nextDate) != today || nextDate.timeIntervalSince(date) >= 5 * 60
            }
            // Bold, links, spoilers and the rest: the text and its runs as the core lays them out.
            var body = message["text"] as? String ?? ""
            var fmt: [Int] = []
            var urls: [String] = []
            if let laid = Core.view("nativeText", [body, meta?["entities"] ?? NSNull()]) as? [String: Any], let text = laid["text"] as? String, !text.isEmpty {
                body = text
                fmt = (laid["fmt"] as? [NSNumber] ?? []).map { $0.intValue }
                urls = laid["urls"] as? [String] ?? []
            }
            var ticks = 0
            let state = message["localState"] as? String ?? ""
            if state == "failed" { ticks = 4 } else if state == "sending" { ticks = 3 } else if mine { ticks = input.peerLastRead >= id ? 2 : 1 }
            // Attachments: the next photo of an album joins the album's row (Sources/Attachments/AlbumGrid.swift).
            if let last = rows.indices.last, AlbumRows.joins(message, sender: sender, row: rows[last]), let head = rows[last]["key"] as? String {
                var parts = rows[last]["album"] as? [[String: Any]] ?? []
                if parts.isEmpty, let first = rows[last]["albumFirst"] as? [String: Any] { parts.append(first) }
                parts.append(AlbumRows.part(message, key: key))
                rows[last]["album"] = parts
                for field in ["thumb", "thumbWide", "thumbRound", "media", "mediaTime", "label"] { rows[last][field] = nil }
                rows[last]["time"] = (message["edited"] as? Bool == true ? "изм. " : "") + clock
                rows[last]["tail"] = tail
                rows[last]["ticks"] = ticks
                // The caption is the first part that has words.
                if (rows[last]["text"] as? String ?? "").isEmpty, !(message["text"] as? String ?? "").isEmpty {
                    rows[last]["text"] = body
                    rows[last]["fmt"] = fmt
                    rows[last]["urls"] = urls
                }
                out.albumParts[head, default: []].append(key)
                out.messages[key] = message
                out.keyOfClient[client] = head
                continue
            }
            var chips: [String] = []
            for reaction in message["reactions"] as? [[String: Any]] ?? [] {
                chips.append(reaction["emoji"] as? String ?? "")
                chips.append(String(max(1, number(reaction["count"]))))
                chips.append(reaction["mine"] as? Bool == true ? "1" : "0")
            }
            var row: [String: Any] = ["key": key, "kind": 0, "mine": mine, "text": body, "fmt": fmt, "urls": urls,
                                      "time": (message["edited"] as? Bool == true ? "изм. " : "") + clock, "ticks": ticks, "tail": tail, "chips": chips]
            if let reply = meta?["reply"] as? [String: Any] {
                row["quoteAuthor"] = reply["senderId"] as? String == input.userId ? "Ты" : input.peerName
                let original = (reply["clientId"] as? String).flatMap { byClient[$0] }
                row["quoteText"] = quoteText(original: original, stored: reply["preview"] as? String ?? "")
                // replyQuote.ts quoteContent: the original's small picture (a photo, a video or a round video, not a voice
                // message or a poll), round for a round video.
                if let original, (original["meta"] as? [String: Any])?["poll"] == nil, let file = original["attachment"] as? [String: Any],
                   let preview = file["preview"] as? [String: Any], let picture = preview["base64"] as? String, !picture.isEmpty {
                    let type = file["mimeType"] as? String ?? ""
                    let round = ChatRowLooks.isVideoNote(file)
                    if !ChatRowLooks.isVoice(file) && (round || type.hasPrefix("image/") || type.hasPrefix("video/")) {
                        row["quoteThumb"] = picture
                        row["quoteRound"] = round
                    }
                }
            } else if let story = meta?["story"] as? [String: Any] {
                row["quoteAuthor"] = story["ownerId"] as? String == input.userId ? "Ты" : input.peerName
                row["quoteText"] = "История"
            }
            if let forward = meta?["forward"] as? [String: Any] {
                let from = forward["from"] as? String ?? ""
                row["forward"] = from.isEmpty ? "Пересланное сообщение" : "Переслано от " + from
            }
            // Attachments: a photo's small picture or a file's name and size (Sources/Attachments/AttachmentOpen.swift).
            if message["attachment"] is [String: Any] {
                row.merge(AttachmentRows.fields(message, key: key)) { _, new in new }
                // Attachments: the first photo of an album keeps what the album's row needs once the next one joins.
                if let album = meta?["album"] as? [String: Any], let albumId = album["id"] as? String {
                    row["albumId"] = albumId
                    row["albumSender"] = sender
                    row["albumFirst"] = AlbumRows.part(message, key: key)
                }
            } else if meta?["poll"] != nil {
                // Polls: the poll itself (Sources/Polls/PollRow.swift); its text is only for clients without polls.
                let usable = state.isEmpty && message["cryptoState"] as? String == "decrypted" && input.selection == nil
                if let poll = PollRows.fields(message, draft: input.pollDrafts[key] ?? [], disabled: !usable) {
                    row["poll"] = poll
                    row["text"] = ""
                    row["fmt"] = [Int]()
                    row["urls"] = [String]()
                } else {
                    row["label"] = "Опрос"
                }
            }
            // Composer: «без звука» on own messages; 1–3 emoji alone are drawn large.
            if mine, meta?["silent"] as? Bool == true { row["silent"] = true }
            if !(message["attachment"] is [String: Any]), meta?["poll"] == nil {
                let count = BigEmoji.count(body)
                if count > 0 { row["bigEmoji"] = count }
            }
            // LinkPreview: the card of a link, as it came inside the message (Sources/LinkPreview/LinkCard.swift).
            if let card = message["linkPreview"] as? [String: Any] { row["card"] = card }
            if let selection = input.selection { row["checked"] = selection.contains(key) ? 1 : 0 }
            if !input.needle.isEmpty { out.found += 1 }
            rows.append(row)
            out.messages[key] = message
            out.keyOfClient[client] = key
            out.order.append(key)
        }
        out.rows = rows
        return out
    }

    // MARK: The simulator's sample chat

    #if targetEnvironment(simulator)
    static let demoPeer = "demo-peer"

    /// Fills the chat with a made-up conversation (no account, no server): the same words as the sample chat
    /// had before, as messages the core can fold — so every action can be tried on them.
    func seedDemo(extra: String) {
        let said: [(Bool, String, String)] = [
            (false, "Привет! Ты завтра будешь на встрече?", "09:12"),
            (true, "Привет. Да, к десяти подойду", "09:14"),
            (false, "Отлично. Я подготовила короткий план — три пункта, должно уложиться в полчаса, если никто не уйдёт в детали", "09:15"),
            (true, "Хорошо", "09:15"),
            (true, "Распечатки нужны или хватит экрана?", "09:16"),
            (false, "Лучше распечатки, там таблица", "09:30"),
            (false, "Тогда до завтра, я принесу распечатки", "09:38"),
        ]
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: Date())
        func client(_ index: Int) -> String { String(format: "d0000000-0000-4000-8000-%012ld", index) }
        func at(_ clock: String, _ extraSeconds: Int = 0) -> String {
            let parts = clock.split(separator: ":").compactMap { Int($0) }
            let seconds = (parts.first ?? 0) * 3600 + (parts.count > 1 ? parts[1] : 0) * 60 + extraSeconds
            return ChatHistory.stamp.string(from: start.addingTimeInterval(TimeInterval(seconds)))
        }
        var list: [[String: Any]] = []
        for (index, line) in said.enumerated() {
            list.append(["id": index + 1, "chatId": chatId, "senderId": line.0 ? userId : ChatHistory.demoPeer, "clientId": client(index + 1), "text": line.1,
                         "attachment": NSNull(), "createdAt": at(line.2, index), "cryptoState": "decrypted"])
        }
        func add(_ mine: Bool, _ text: String, _ clock: String, _ meta: [String: Any]) {
            let id = list.count + 1
            list.append(["id": id, "chatId": chatId, "senderId": mine ? userId : ChatHistory.demoPeer, "clientId": client(id), "text": text,
                         "attachment": NSNull(), "createdAt": at(clock, id), "cryptoState": "decrypted", "meta": meta])
        }
        if !extra.isEmpty {
            // An answer with its quote, a forwarded message, reactions from both sides — what the actions leave behind.
            add(true, "Принесу свои тоже, на всякий случай", "09:40", ["reply": ["clientId": client(6), "senderId": ChatHistory.demoPeer, "preview": "Лучше распечатки, там таблица"]])
            add(false, "Встреча в переговорной на третьем этаже", "09:41", ["forward": ["from": "Дмитрий Орлов"]])
            add(false, "👍 Реакция на сообщение", "09:41", ["action": ["type": "react", "target": client(8), "emoji": "👍"]])
            add(true, "❤️ Реакция на сообщение", "09:42", ["action": ["type": "react", "target": client(7), "emoji": "❤️"]])
            add(false, "❤️ Реакция на сообщение", "09:42", ["action": ["type": "react", "target": client(7), "emoji": "❤️"]])
        }
        if extra == "pinned" {
            add(true, "Закреплено сообщение", "09:43", ["action": ["type": "pin", "target": client(3)]])
        }
        // Polls, Attachments, Composer: -chatdemo features — a poll with results, a poll with several answers, big
        // emoji, a message sent «без звука» and an album of three photos.
        if ["features", "poll", "album", "emoji", "search", "albummenu", "newpoll"].contains(extra) {
            let lunch: [String: Any] = ["question": "Куда пойдём в пятницу?", "options": ["Кино", "Боулинг", "Остаться дома"], "multiple": false]
            add(false, PollText.fallback(lunch), "09:44", ["poll": lunch])
            let pollClient = client(list.count)
            add(false, "🗳 Голос в опросе", "09:45", ["action": ["type": "vote", "target": pollClient, "options": [0]]])
            add(true, "🗳 Голос в опросе", "09:45", ["action": ["type": "vote", "target": pollClient, "options": [1]]])
            let picnic: [String: Any] = ["question": "Что взять на пикник?", "options": ["Плед", "Мяч", "Термос", "Гитара"], "multiple": true]
            add(true, PollText.fallback(picnic), "09:46", ["poll": picnic])
            for (mine, words) in [(false, "🎉🔥"), (true, "👍")] {
                let id = list.count + 1
                list.append(["id": id, "chatId": chatId, "senderId": mine ? userId : ChatHistory.demoPeer, "clientId": client(id), "text": words,
                             "attachment": NSNull(), "createdAt": at("09:47", id), "cryptoState": "decrypted"])
            }
            add(true, "Не буду звонить, напиши, как проснёшься", "09:48", ["silent": true])
            let albumId = "a0000000-0000-4000-8000-000000000001"
            let shapes: [(CGFloat, CGFloat)] = [(240, 160), (160, 240), (240, 180)]
            for (index, shape) in shapes.enumerated() {
                let picture = ChatAttachments.demoPicture(width: shape.0, height: shape.1).jpegData(compressionQuality: 0.6)?.base64EncodedString() ?? ""
                let attachment: [String: Any] = ["id": "f000000\(index)-0000-4000-8000-000000000000", "name": "photo.jpg", "mimeType": "image/jpeg", "size": 120_000,
                                                 "encryption": ["scheme": "aes-256-gcm-siv"], "preview": ["base64": picture, "width": shape.0, "height": shape.1]]
                let id = list.count + 1
                list.append(["id": id, "chatId": chatId, "senderId": ChatHistory.demoPeer, "clientId": client(id), "text": index == 0 ? "Фото с прогулки" : "",
                             "attachment": attachment, "createdAt": at("09:50", id), "cryptoState": "decrypted",
                             "meta": ["album": ["id": albumId, "index": index, "count": shapes.count]]])
            }
        }
        raw = list
        demoNext = list.count + 1
        peerLastRead = said.count
        hasMore = false
    }

    /// The clientId of the sample chat's Nth message (1 is the first).
    static func demoClient(_ index: Int) -> String { String(format: "d0000000-0000-4000-8000-%012ld", index) }
    #endif
}
