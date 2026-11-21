import UIKit

/// The signed-in account at work: its server, its private storage, its encryption — and what the screens ask of them.
final class Messenger {
    let server: Server
    let user: [String: Any]
    let userId: String
    private let vault: Vault
    let crypto: CryptoService

    /// Opens the account's storage and encryption. Throws when the storage cannot be opened: the app then says
    /// so and changes nothing (a lost key never silently makes a new identity).
    init(token: String, user: [String: Any]) throws {
        guard let id = user["id"] as? String else { throw Vault.Failure.cannotOpen }
        self.user = user
        userId = id
        server = Server(base: Account.server, token: token)
        vault = try Vault(server: Account.server, userId: id, earlierServers: ["https://141-133-194-51.nip.io"])
        crypto = CryptoService(userId: id, vault: vault, server: server)
    }

    // MARK: The list of chats

    struct ChatSummary {
        let id: String
        let peerId: String
        let title: String
        let row: [String: Any]
    }

    /// The chats as the server lists them, each with its last message as this device has decrypted it.
    func chats(done: @escaping (Result<[ChatSummary], ServerError>) -> Void) {
        server.op("chats", []) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): DispatchQueue.main.async { done(.failure(error)) }
            case .success(let body):
                let list = (body as? [String: Any])?["chats"] as? [[String: Any]] ?? []
                self.crypto.run({ crypto in list.compactMap { self.summary($0, crypto) } }, done: { done(.success($0)) })
            }
        }
    }

    /// One chat as a row of the list. Runs on the encryption queue (the last message is read from the kept copy).
    private func summary(_ chat: [String: Any], _ crypto: CryptoService) -> ChatSummary? {
        guard let id = chat["id"] as? String, let peer = chat["peer"] as? [String: Any], let peerId = peer["id"] as? String else { return nil }
        let title = peer["displayName"] as? String ?? ""
        var preview = "", time = "", ticks = 0
        if var last = chat["lastMessage"] as? [String: Any] {
            // Open what has come since the last look, then show the kept copy; the list never shows the server's own text.
            _ = crypto.callNow("sync", [id, 2])
            if case .success(let shown) = crypto.callNow("preview", [last]), let shown = shown as? [String: Any] { last = shown }
            preview = Self.previewText(last)
            time = Self.listTime(last["createdAt"] as? String)
            if last["senderId"] as? String == userId {
                let read = (chat["peerLastReadMessageId"] as? NSNumber)?.intValue ?? 0, own = (last["id"] as? NSNumber)?.intValue ?? 0
                ticks = read >= own ? 2 : 1
            }
        }
        let color = Self.color(peer["avatarColor"] as? String)
        let orb = orbPair(color)
        let settings = chat["settings"] as? [String: Any]
        let row: [String: Any] = ["id": id, "title": title, "preview": preview, "time": time, "unread": (chat["unreadCount"] as? NSNumber)?.intValue ?? 0,
                                  "muted": settings?["muted"] as? Bool ?? false, "pinned": settings?["pinnedAt"] is String, "ticks": ticks,
                                  "avatarColor": Int(0xFF00_0000 | color), "initials": Self.initials(title), "orbA": orb.light, "orbB": orb.deep]
        return ChatSummary(id: id, peerId: peerId, title: title, row: row)
    }

    // MARK: One chat

    /// The newest page of a chat as rows for the message list, oldest first.
    func messages(chatId: String, peerLastRead: Int, done: @escaping (Result<[[String: Any]], ServerError>) -> Void) {
        crypto.run({ crypto -> Result<[[String: Any]], ServerError> in
            // First everything new is opened and kept (each message exactly once), then the page is shown from the kept copies.
            if case .failure(let failure) = crypto.callNow("sync", [chatId]), failure.name == "NetworkError" { return .failure(.network(failure.message)) }
            switch self.server.opAndWait("messages", [chatId]) {
            case .failure(let error): return .failure(error)
            case .success(let body):
                let list = (body as? [String: Any])?["messages"] as? [[String: Any]] ?? []
                var shown: [[String: Any]] = []
                for message in list {
                    guard case .success(let value) = crypto.callNow("preview", [message]), let opened = value as? [String: Any] else { continue }
                    // Service messages (edits, reactions, calls) are not lines of the chat; they are folded in later work.
                    if (opened["meta"] as? [String: Any])?["action"] != nil { continue }
                    shown.append(opened)
                }
                return .success(self.rows(shown, peerLastRead: peerLastRead))
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
            if today != day, !today.isEmpty { day = today; rows.append(["key": "day-\(index)", "kind": 1, "text": today]) }
            let next = index + 1 < messages.count ? messages[index + 1] : nil
            let id = (message["id"] as? NSNumber)?.intValue ?? 0
            rows.append(["key": "\(message["senderId"] as? String ?? ""):\(message["clientId"] as? String ?? "")", "kind": 0, "mine": mine,
                         "text": Self.previewText(message), "time": date.map { Self.clock.string(from: $0) } ?? "",
                         "ticks": mine ? (peerLastRead >= id ? 2 : 1) : 0, "tail": next?["senderId"] as? String != message["senderId"] as? String])
        }
        return rows
    }

    /// Encrypts a text for every device of the conversation, keeps it, and hands it to the server.
    func send(chatId: String, peerId: String, text: String, done: @escaping (Result<Void, CryptoFailure>) -> Void) {
        let clientId = UUID().uuidString.lowercased()
        crypto.run({ crypto -> Result<Void, CryptoFailure> in
            switch crypto.callNow("encrypt", [chatId, peerId, clientId, text, NSNull(), NSNull(), NSNull()]) {
            case .failure(let failure): return .failure(failure)
            case .success(let encrypted):
                switch self.server.opAndWait("sendEncrypted", [chatId, clientId, encrypted]) {
                case .failure(let error):
                    // Kept in the list of unsent messages: it goes out again with the very same ciphertext.
                    return .failure(CryptoFailure(name: "NetworkError", message: error.words))
                case .success:
                    _ = crypto.callNow("delivered", [chatId, clientId])
                    return .success(())
                }
            }
        }, done: done)
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

    static func initials(_ name: String) -> String {
        name.split(separator: " ").prefix(2).compactMap { $0.first }.map { String($0) }.joined().uppercased()
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
    private static let weekday = formatter("EE")
    private static let dayMonth = formatter("dd.MM")
    private static let dayLong = formatter("d MMMM")
    private static let dayLongYear = formatter("d MMMM yyyy")

    /// The time of a chat's last message in the list: the clock today, «Вчера», the weekday within a week, else the date.
    static func listTime(_ text: String?) -> String {
        guard let date = date(text) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return clock.string(from: date) }
        if calendar.isDateInYesterday(date) { return "Вчера" }
        if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: Date())).day, days < 7 { return weekday.string(from: date).capitalized }
        return dayMonth.string(from: date)
    }

    static func dayWords(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Сегодня" }
        if calendar.isDateInYesterday(date) { return "Вчера" }
        return calendar.component(.year, from: date) == calendar.component(.year, from: Date()) ? dayLong.string(from: date) : dayLongYear.string(from: date)
    }
}
