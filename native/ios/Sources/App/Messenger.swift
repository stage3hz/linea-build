import UIKit

/// The signed-in account at work: its server, its private storage, its encryption — and what the screens ask of them.
final class Messenger {
    let server: Server
    let user: [String: Any]
    let userId: String
    private let vault: Vault
    let crypto: CryptoService
    let live: Live
    /// Offline: the background opening of the chat list's closed lines (Sources/Offline/ListCatchUp.swift).
    let catchUp = ListCatchUp()
    /// Posted on the main queue when something on the server changed: `object` is the chat's id, or nil for «anything».
    static let changed = Notification.Name("invizent.changed")
    /// Posted when the other side read up to a message: `userInfo` holds `chatId` and `messageId`.
    static let peerRead = Notification.Name("invizent.peer-read")

    /// Opens the account's storage and encryption. Throws when the storage cannot be opened: the app then says
    /// so and changes nothing (a lost key never silently makes a new identity).
    init(token: String, user: [String: Any]) throws {
        // The account's id: text as the server gives it; a number is taken as its digits. Without one nothing can
        // open — the log is told so apart from the storage (only the profile's field names, never their values).
        Vault.note("")
        guard let id = (user["id"] as? String) ?? (user["id"] as? NSNumber)?.stringValue, !id.isEmpty else {
            Vault.note("the profile has no id (fields: \(user.keys.sorted().prefix(12).joined(separator: ",")))")
            throw Vault.Failure.cannotOpen
        }
        self.user = user
        userId = id
        server = Server(base: Account.server, token: token)
        vault = try Vault(server: Account.server, userId: id, earlierServers: ["https://141-133-194-51.nip.io"])
        crypto = CryptoService(userId: id, vault: vault, server: server)
        live = Live(server: server)
        live.onEvent = { [weak self] event in
            guard let self else { return }
            switch event {
            case .ready:
                self.resendPending()
                NotificationCenter.default.post(name: Messenger.changed, object: nil)
            case .chat(let id): NotificationCenter.default.post(name: Messenger.changed, object: id)
            case .read(let chatId, let userId, let messageId):
                if userId != self.userId { NotificationCenter.default.post(name: Messenger.peerRead, object: nil, userInfo: ["chatId": chatId, "messageId": messageId]) }
                NotificationCenter.default.post(name: Messenger.changed, object: nil)
            // ChatActions: «печатает», «записывает голосовое»… of the other side (Sources/ChatActions/ChatLocal.swift).
            case .typing(let chatId, let userId, let on, let kind): if userId != self.userId { ChatTyping.shared.heard(chatId: chatId, userId: userId, kind: kind, on: on) }
            }
        }
        // Offline: the fastest live address of the server, and the phone's network (Sources/Offline/ServerPool.swift).
        ServerPool.shared.start(base: Account.server)
        // Publishes this device's keys (making them on the very first start). The live line opens at once beside
        // it, as in the reference: a slow or failing key publication must not hold back everything else.
        crypto.call("initialize") { _ in }
        // Composer: the scheduled messages listen to the live line from the start (Sources/Composer/ScheduledStore.swift).
        DispatchQueue.main.async { [weak self] in if let self { _ = ScheduledStore.of(self) } }
        live.start()
        // Security: «Новый вход», «Запрос восстановления», the number on the icon, links (Security/AccountNotices.swift).
        DispatchQueue.main.async { [weak self] in if let self { AccountNotices.shared.start(self) } }
        // Old chats on a new device: a copy from or to the account's other devices, the backup (Security/HistoryTransfer.swift).
        DispatchQueue.main.async { [weak self] in if let self { HistoryTransfer.shared.start(self) } }
    }

    /// Tells the server the chat was read up to a message.
    func markRead(chatId: String, messageId: Int) {
        guard messageId > 0 else { return }
        server.op("read", [chatId, messageId]) { _ in }
    }

    // MARK: The list of chats

    struct ChatSummary {
        let id: String
        let peerId: String
        let title: String
        let peerLastRead: Int
        let row: [String: Any]
        /// ChatActions: the chat as the server lists it (its settings, what is unread), and its last message as this device shows it.
        var chat: [String: Any] = [:]
        var last: [String: Any] = [:]
    }

    /// The chats as the server lists them, each with its last message as this device has decrypted it.
    /// Offline: `previous` — the lines on screen now by chat id (a line already opened here never turns closed
    /// again); chats whose line is still closed are opened afterwards in the background (`catchUpList`), not
    /// here, so one slow chat never holds the whole list back.
    func chats(previous: [String: [String: Any]] = [:], done: @escaping (Result<[ChatSummary], ServerError>) -> Void) {
        server.op("chats", []) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): DispatchQueue.main.async { done(.failure(error)) }
            case .success(let body):
                let list = (body as? [String: Any])?["chats"] as? [[String: Any]] ?? []
                // Pictures of people are fetched by the list itself, as this session.
                if let made = Core.prepare(method: "GET", path: "/files/x", jsonBody: false, token: self.server.token, proof: self.server.currentProof) {
                    let headers = Dictionary(made.headers, uniquingKeysWith: { first, _ in first })
                    DispatchQueue.main.async { ChatAvatarStore.shared.headers = headers }
                }
                self.crypto.run({ crypto -> [ChatSummary] in
                    var part = ""
                    return list.compactMap { (chat: [String: Any]) -> ChatSummary? in
                        // A quiet heading above the first chat of each part of the list.
                        let own = Self.section(chat)
                        let heading = own != part ? own : ""
                        part = own
                        var shown: [String: Any]? = nil
                        if let id = chat["id"] as? String, let last = chat["lastMessage"] as? [String: Any] {
                            shown = self.catchUp.line(chatId: id, last: last, crypto: crypto, previous: previous[id])
                        }
                        return self.summary(chat, shown: shown, section: heading)
                    }
                }, done: { done(.success($0)) })
            }
        }
    }

    /// One chat as a row of the list. Runs on the encryption queue (the last message is read from the kept copy).
    /// The part of the list a chat belongs to: pinned ones first, then by the day of the last message.
    private static func section(_ chat: [String: Any]) -> String {
        if (chat["settings"] as? [String: Any])?["pinnedAt"] is String { return "Закреплённые" }
        guard let at = date((chat["lastMessage"] as? [String: Any])?["createdAt"] as? String) else { return "Раньше" }
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: at), to: calendar.startOfDay(for: Date())).day ?? 2
        return days <= 0 ? "Сегодня" : days == 1 ? "Вчера" : "Раньше"
    }

    /// `shown`: the chat's last message as this device shows it (the list never shows the server's own text:
    /// only the copy this device decrypted and kept). Any queue.
    func summary(_ chat: [String: Any], shown: [String: Any]?, section: String) -> ChatSummary? {
        guard let id = chat["id"] as? String, let peer = chat["peer"] as? [String: Any], let peerId = peer["id"] as? String else { return nil }
        let title = peer["displayName"] as? String ?? ""
        var preview = "", time = "", ticks = 0
        var shownLast: [String: Any] = [:]
        var quiet = false
        if chat["lastMessage"] is [String: Any], let last = shown {
            shownLast = last
            // Offline: a message this device cannot open is said in a quieter way than a real line.
            quiet = ListCatchUp.awaitsInbox(last)
            // The line of the list as the core words it (a call's outcome, hidden spoilers); else the plain words.
            let line = Core.view("chatListText", [last]) as? String ?? ""
            preview = Self.listWords(line.isEmpty ? Self.previewText(last) : line)
            if preview.isEmpty { preview = "Сообщение" }
            time = Self.listTime(last["createdAt"] as? String)
            if last["senderId"] as? String == userId {
                let read = (chat["peerLastReadMessageId"] as? NSNumber)?.intValue ?? 0, own = (last["id"] as? NSNumber)?.intValue ?? 0
                ticks = read >= own ? 2 : 1
            }
        }
        // ChatListScreen.tsx nativeLine: a chat without messages yet.
        if !(chat["lastMessage"] is [String: Any]) { preview = "Напиши первое сообщение" }
        let color = Self.color(peer["avatarColor"] as? String ?? "#4B73BB") // Avatars: the reference's colour for a person without one
        let orb = orbPair(color)
        let settings = chat["settings"] as? [String: Any]
        let avatarId = peer["avatarId"] as? String ?? ""
        let avatarUrl = avatarId.isEmpty ? "" : server.endpoint + "/files/" + (avatarId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? "")
        let row: [String: Any] = ["section": section, "avatarUrl": avatarUrl, "avatarKey": avatarId, "id": id, "title": title, "preview": preview, "time": time, "unread": (chat["unreadCount"] as? NSNumber)?.intValue ?? 0,
                                  "muted": settings?["muted"] as? Bool ?? false, "pinned": settings?["pinnedAt"] is String, "ticks": ticks,
                                  "avatarColor": Int(0xFF00_0000 | color), "initials": Self.initials(title), "orbA": orb.light, "orbB": orb.deep,
                                  "quietPreview": quiet]
        return ChatSummary(id: id, peerId: peerId, title: title, peerLastRead: (chat["peerLastReadMessageId"] as? NSNumber)?.intValue ?? 0, row: row, chat: chat, last: shownLast)
    }

    // MARK: One chat

    /// The newest page of a chat as rows for the message list, oldest first.
    func messages(chatId: String, peerLastRead: Int, done: @escaping (Result<[[String: Any]], ServerError>) -> Void) {
        messagesAndNewest(chatId: chatId, peerLastRead: peerLastRead) { result in done(result.map { $0.rows }) }
    }

    /// The same with the id of the newest message from the other side (what «read» is reported up to).
    func messagesAndNewest(chatId: String, peerLastRead: Int, done: @escaping (Result<(rows: [[String: Any]], newestTheirs: Int), ServerError>) -> Void) {
        messagesPage(chatId: chatId, peerLastRead: peerLastRead, done: done)
    }

    private func messagesPage(chatId: String, peerLastRead: Int, done: @escaping (Result<(rows: [[String: Any]], newestTheirs: Int), ServerError>) -> Void) {
        crypto.run({ crypto -> Result<(rows: [[String: Any]], newestTheirs: Int), ServerError> in
            // First everything new is opened and kept (each message exactly once), then the page is shown from the kept copies.
            if case .failure(let failure) = crypto.callNow("sync", [chatId]), failure.name == "NetworkError" { return .failure(.network(failure.message)) }
            switch self.server.opAndWait("messages", [chatId]) {
            case .failure(let error): return .failure(error)
            case .success(let body):
                let list = (body as? [String: Any])?["messages"] as? [[String: Any]] ?? []
                var shown: [[String: Any]] = []
                for message in list {
                    guard case .success(let value) = crypto.callNow("preview", [message]), let opened = value as? [String: Any] else { continue }
                    shown.append(opened)
                }
                // Edits, deletions, reactions, pins and the rest are folded into the lines they belong to (the core's rules).
                if let folded = Core.view("foldChat", [shown, self.userId, [String](), Date().timeIntervalSince1970 * 1000]) as? [String: Any], let lines = folded["messages"] as? [[String: Any]] {
                    shown = lines
                } else {
                    shown = shown.filter { ($0["meta"] as? [String: Any])?["action"] == nil }
                }
                let newest = list.filter { $0["senderId"] as? String != self.userId }.compactMap { ($0["id"] as? NSNumber)?.intValue }.max() ?? 0
                return .success((self.rows(shown, peerLastRead: peerLastRead), newest))
            }
        }, done: done)
    }

    private func rows(_ messages: [[String: Any]], peerLastRead: Int) -> [[String: Any]] {
        var rows: [[String: Any]] = []
        var day = ""
        for (index, message) in messages.enumerated() {
            let mine = message["senderId"] as? String == userId
            let date = Self.date(message["createdAt"] as? String)
            let today = date.map { Self.dayWords($0) } ?? ""
            if today != day, !today.isEmpty { day = today; rows.append(["key": "day-\(index)", "kind": 1, "text": today, "label": "day"]) }
            let next = index + 1 < messages.count ? messages[index + 1] : nil
            let id = (message["id"] as? NSNumber)?.intValue ?? 0
            // Bold, links, spoilers and the rest: the text and its runs as the core lays them out.
            var body = Self.previewText(message)
            var fmt: [Int] = [], urls: [String] = []
            if let laid = Core.view("nativeText", [message["text"] as? String ?? "", (message["meta"] as? [String: Any])?["entities"] ?? NSNull()]) as? [String: Any],
               let text = laid["text"] as? String, !text.isEmpty {
                body = text
                fmt = (laid["fmt"] as? [NSNumber] ?? []).map { $0.intValue }
                urls = laid["urls"] as? [String] ?? []
            }
            rows.append(["key": "\(message["senderId"] as? String ?? ""):\(message["clientId"] as? String ?? "")", "kind": 0, "mine": mine, "fmt": fmt, "urls": urls,
                         "text": body, "time": (message["edited"] as? Bool == true ? "изм. " : "") + (date.map { Self.clock.string(from: $0) } ?? ""),
                         "chips": (message["reactions"] as? [[String: Any]] ?? []).flatMap { [$0["emoji"] as? String ?? "", String(($0["count"] as? NSNumber)?.intValue ?? 1), $0["mine"] as? Bool == true ? "1" : ""] },
                         "ticks": mine ? (peerLastRead >= id ? 2 : 1) : 0, "tail": next?["senderId"] as? String != message["senderId"] as? String])
            // Attachments: a photo's small picture or a file's name and size (Sources/Attachments/AttachmentOpen.swift).
            if message["attachment"] is [String: Any], let key = rows[rows.count - 1]["key"] as? String {
                rows[rows.count - 1].merge(AttachmentRows.fields(message, key: key)) { _, new in new }
            }
            // LinkPreview: the card of a link, as it came inside the message.
            if let card = message["linkPreview"] as? [String: Any] { rows[rows.count - 1]["card"] = card }
        }
        return rows
    }

    /// Encrypts one message for every device of the conversation (or takes the ciphertext already kept for this
    /// id), hands it to the server and marks it delivered. Runs on the encryption queue.
    ///
    /// - The device list changed since the ciphertext was made: it is dropped and the message encrypted afresh, once.
    /// - Refused for good (not «try later», not a dead session): the kept copy is forgotten, so it is not sent
    ///   again after every start.
    /// - No answer: it stays in the list of unsent messages and goes out later with the very same ciphertext.
    /// - `push` is what the server does about the notification ("call" rings, "missed", "none", "silent"); nil — the
    ///   core decides by the message's `meta` (an ordinary message stays without one).
    ///
    /// LinkPreview: `linkPreview` is the card of a link in the text (Sources/LinkPreview), or NSNull; the core
    /// checks it and carries it inside the ciphertext.
    func deliver(_ crypto: CryptoService, chatId: String, peerId: String, clientId: String, text: Any, attachment: Any, meta: Any, again: Bool = true, push: String? = nil, linkPreview: Any = NSNull()) -> Result<Void, CryptoFailure> {
        switch crypto.callNow("encrypt", [chatId, peerId, clientId, text, attachment, meta, NSNull(), linkPreview]) {
        case .failure(let failure): return .failure(failure)
        case .success(let encrypted):
            var sent: [Any] = [chatId, clientId, encrypted]
            // The notification follows the message itself when the caller did not name it: nothing for an action
            // (a reaction, an edit, a vote…), a quiet one for «без звука».
            let kind: String? = push ?? (Core.view("callPushKind", [meta]) as? String)
            if let kind { sent.append(kind) }
            switch server.opAndWait("sendEncrypted", sent) {
            case .success:
                _ = crypto.callNow("delivered", [chatId, clientId])
                return .success(())
            case .failure(.refused(let message, let status, let code, _)):
                if code == "E2EE_DEVICES_CHANGED" {
                    _ = crypto.callNow("forget", [chatId, clientId])
                    if again { return deliver(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: text, attachment: attachment, meta: meta, again: false, push: push, linkPreview: linkPreview) }
                } else if (400..<500).contains(status), status != 401, status != 408, status != 429 {
                    _ = crypto.callNow("forget", [chatId, clientId])
                }
                return .failure(CryptoFailure(name: "Error", message: message))
            case .failure(let error):
                return .failure(CryptoFailure(name: "NetworkError", message: error.words))
            }
        }
    }

    /// Sends a text.
    func send(chatId: String, peerId: String, text: String, done: @escaping (Result<Void, CryptoFailure>) -> Void) {
        let clientId = UUID().uuidString.lowercased()
        crypto.run({ crypto in self.deliver(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: text, attachment: NSNull(), meta: NSNull()) }, done: done)
    }

    /// Attachments: sends a message that carries a file — already sealed, uploaded and described by the core
    /// (Sources/Attachments/ChatAttachments.swift).
    /// `meta`: what goes with it inside the ciphertext (the answer it is — `reply`), or nil.
    func send(chatId: String, peerId: String, text: String, attachment: [String: Any], meta: [String: Any]? = nil, done: @escaping (Result<Void, CryptoFailure>) -> Void) {
        let clientId = UUID().uuidString.lowercased()
        var fields: Any = NSNull()
        if let meta { fields = meta }
        let sentMeta = fields
        crypto.run({ crypto in self.deliver(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: text, attachment: attachment, meta: sentMeta) }, done: done)
    }

    /// Messages that were encrypted and kept but never confirmed by the server (the app was closed, the network
    /// went away) go out again — each with the very ciphertext it was first given, so nothing is sent twice.
    func resendPending() {
        crypto.run({ crypto -> Int in
            guard case .success(let value) = crypto.callNow("pendingOutbox"), let items = value as? [[String: Any]] else { return 0 }
            var sent = 0
            for item in items {
                // Scheduled messages have their own road to the server; they are not built here yet.
                guard item["deliverAt"] == nil, let chatId = item["chatId"] as? String, let clientId = item["clientId"] as? String, let peerId = item["peerId"] as? String else { continue }
                switch self.deliver(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: item["text"] ?? "", attachment: item["attachment"] ?? NSNull(), meta: item["meta"] ?? NSNull()) {
                case .success: sent += 1
                case .failure(let failure): if failure.name == "NetworkError" { return sent }
                }
            }
            return sent
        }, done: { sent in if sent > 0 { NotificationCenter.default.post(name: Messenger.changed, object: nil) } })
    }

    // MARK: Words and looks

    static func previewText(_ message: [String: Any]) -> String {
        let text = message["text"] as? String ?? ""
        if !text.isEmpty { return text }
        if let attachment = message["attachment"] as? [String: Any] {
            let type = attachment["mimeType"] as? String ?? ""
            return type.hasPrefix("image/") ? "Фото" : type.hasPrefix("video/") ? "Видео" : type.hasPrefix("audio/") ? "Голосовое сообщение" : (attachment["name"] as? String ?? "Файл")
        }
        return ""
    }

    /// ChatListScreen.tsx listText: a server invitation reads without its link, or «🔗 Приглашение на сервер».
    static func listWords(_ text: String) -> String {
        guard !text.isEmpty, ChannelWords.inviteCode(in: text) != nil else { return text }
        let rest = ChannelWords.withoutInviteLink(text).trimmingCharacters(in: .whitespacesAndNewlines)
        return rest.isEmpty ? "🔗 Приглашение на сервер" : rest
    }

    static func initials(_ name: String) -> String {
        // Avatars: as the reference — the first letters of the first two words, split on any white space.
        name.split(whereSeparator: { $0.isWhitespace }).prefix(2).compactMap { $0.first }.map { String($0) }.joined().uppercased()
    }

    /// `#RRGGBB` → 0xRRGGBB; the app's blue when it is not a colour.
    static func color(_ hex: String?) -> UInt32 {
        guard let hex, hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return 0x5E7BFF }
        return value
    }

    private static let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private static let isoPlain = ISO8601DateFormatter()
    static func date(_ text: String?) -> Date? { text.flatMap { iso.date(from: $0) ?? isoPlain.date(from: $0) } }
    private static func formatter(_ format: String) -> DateFormatter { let f = DateFormatter(); f.locale = Locale(identifier: "ru_RU"); f.dateFormat = format; return f }
    static let clock = formatter("HH:mm")
    /// theme.ts formatListTime: `toLocaleDateString('ru-RU', {day:'numeric',month:'short'})` — «5 нояб.».
    private static let dayMonth = formatter("d MMM")
    private static let dayLong = formatter("d MMMM")

    /// theme.ts formatListTime: the clock today, «вчера» (lower case), else the day and the short month.
    static func listTime(_ text: String?) -> String {
        guard let date = date(text) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return clock.string(from: date) }
        if calendar.isDateInYesterday(date) { return "вчера" }
        return dayMonth.string(from: date)
    }

    static func dayWords(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Сегодня" }
        if calendar.isDateInYesterday(date) { return "Вчера" }
        // theme.ts formatDay: «5 ноября», without a year.
        return dayLong.string(from: date)
    }
}
