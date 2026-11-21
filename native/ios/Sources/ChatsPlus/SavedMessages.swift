import UIKit

/// ChatsPlus: «Избранное» — personal notes and saved messages (the reference's saved/saved.ts and useSaved.ts).
/// The list lives only in this device's encrypted storage (the core's local entry `saved:v1`, the same one the
/// previous app used); attachments keep pointing at the already end-to-end encrypted files on the server. The
/// server never learns what is saved.
///
/// For other screens (the message menu's «В Избранное»):
///
///     SavedMessages.of(messenger).save(message: message, chatId: chatId, author: name) { result in … }
///
/// `result` is `.success(true)` when the message was added, `.success(false)` when it was already there, and
/// `.failure(words)` with the words to show. Main queue in, main queue out.
final class SavedMessages {
    static let limit = 5000
    static let textLimit = 8000
    /// Posted on the main queue when the list changed or finished loading.
    static let changed = Notification.Name("invizent.saved.changed")
    /// The words a failure carries.
    struct Failure: Error { let words: String }

    private static var byAccount: [String: SavedMessages] = [:]
    #if targetEnvironment(simulator)
    private static var sample: SavedMessages?
    #endif

    /// The list of one account (one copy per account: the chat list's row and the screen stay in step).
    static func of(_ messenger: Messenger) -> SavedMessages {
        if let kept = byAccount[messenger.userId] { return kept }
        let made = SavedMessages(crypto: messenger.crypto)
        byAccount[messenger.userId] = made
        made.load()
        return made
    }

    /// The list for a screen that may have no account (the simulator's samples; nil on a phone).
    static func shared(_ messenger: Messenger?) -> SavedMessages? {
        if let messenger { return of(messenger) }
        #if targetEnvironment(simulator)
        if let sample { return sample }
        let made = SavedMessages(crypto: nil)
        made.items = SavedMessages.sampleItems()
        made.loaded = true
        sample = made
        return made
        #else
        return nil
        #endif
    }

    private let crypto: CryptoService?
    /// Oldest first, as the reference keeps them.
    private(set) var items: [[String: Any]] = []
    private(set) var loaded = false
    private(set) var error = ""

    private init(crypto: CryptoService?) {
        self.crypto = crypto
    }

    // MARK: Reading

    private func load() {
        guard let crypto else { loaded = true; return }
        crypto.call("loadLocal", ["saved:v1"]) { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let value): self.items = SavedMessages.parse(value as? String)
                case .failure(let failure): self.error = failure.message.isEmpty ? "Не удалось открыть Избранное." : failure.message
                }
                self.loaded = true
                NotificationCenter.default.post(name: SavedMessages.changed, object: self)
            }
        }
    }

    /// The reference's `parseSaved`: anything malformed is dropped, not the whole list.
    static func parse(_ raw: String?) -> [[String: Any]] {
        guard let raw, let list = Core.value(raw) as? [Any] else { return [] }
        let good = list.compactMap { $0 as? [String: Any] }.filter { valid($0) }
        return Array(good.suffix(limit))
    }

    private static func isUuid(_ value: Any?) -> Bool {
        guard let text = value as? String, text.count == 36 else { return false }
        return text.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil
    }

    private static func isDate(_ value: Any?) -> Bool {
        guard let text = value as? String, text.count <= 40 else { return false }
        return Messenger.date(text) != nil
    }

    /// The reference's `validSavedItem` (the attachment itself is checked by the core when it is opened).
    static func valid(_ item: [String: Any]) -> Bool {
        guard isUuid(item["id"]), isDate(item["savedAt"]), let text = item["text"] as? String, text.count <= textLimit else { return false }
        let attachment = item["attachment"] as? [String: Any]
        if item["attachment"] != nil, !(item["attachment"] is NSNull), attachment == nil { return false }
        if let attachment, !(attachment["id"] is String) { return false }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachment == nil { return false }
        if let origin = item["origin"] {
            guard let fields = origin as? [String: Any], isUuid(fields["chatId"]), isUuid(fields["clientId"]),
                  let author = fields["author"] as? String, !author.isEmpty, author.count <= 80, isDate(fields["sentAt"]) else { return false }
        }
        if let edited = item["editedAt"], !isDate(edited) { return false }
        return true
    }

    // MARK: Changing

    private static let stamp: ISO8601DateFormatter = {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format
    }()

    /// Every change goes to the encrypted storage in order; a failed write puts the list back as it was.
    private func commit(_ next: [[String: Any]], done: ((Failure?) -> Void)? = nil) {
        let previous = items
        items = next
        error = ""
        NotificationCenter.default.post(name: SavedMessages.changed, object: self)
        guard let crypto else { done?(nil); return }
        guard let json = Core.text(next) else { done?(Failure(words: "Не удалось сохранить Избранное.")); return }
        crypto.call("storeLocal", ["saved:v1", json]) { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .failure(let failure) = result {
                    let words = failure.message.isEmpty ? "Не удалось сохранить Избранное." : failure.message
                    if (self.items as NSArray).isEqual(to: next) { self.items = previous }
                    self.error = words
                    NotificationCenter.default.post(name: SavedMessages.changed, object: self)
                    done?(Failure(words: words))
                } else {
                    done?(nil)
                }
            }
        }
    }

    /// A note or a file, optionally with where it came from. `.success(false)`: already saved.
    func save(text: String, attachment: [String: Any]?, origin: [String: Any]? = nil, done: @escaping (Result<Bool, Failure>) -> Void) {
        guard loaded else { done(.failure(Failure(words: "Избранное ещё загружается. Попробуй через секунду."))); return }
        var item: [String: Any] = ["id": UUID().uuidString.lowercased(), "savedAt": SavedMessages.stamp.string(from: Date()),
                                   "text": String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(SavedMessages.textLimit))]
        item["attachment"] = attachment ?? NSNull()
        if let origin { item["origin"] = origin }
        guard SavedMessages.valid(item) else { done(.failure(Failure(words: "Не удалось сохранить: сообщение пустое или слишком длинное."))); return }
        if let origin, items.contains(where: { (entry: [String: Any]) -> Bool in
            guard let kept = entry["origin"] as? [String: Any] else { return false }
            return kept["chatId"] as? String == origin["chatId"] as? String && kept["clientId"] as? String == origin["clientId"] as? String
        }) {
            done(.success(false))
            return
        }
        guard items.count < SavedMessages.limit else { done(.failure(Failure(words: "В Избранном уже \(SavedMessages.limit) записей. Удали старые, чтобы добавить новые."))); return }
        commit(items + [item]) { (failure: Failure?) -> Void in
            if let failure { done(.failure(failure)) } else { done(.success(true)) }
        }
    }

    /// «В Избранное» from a chat: the message as this device shows it (decrypted: `text`, `attachment`,
    /// `clientId`, `createdAt` or `sentAt`), the chat it is in and the name of its author.
    func save(message: [String: Any], chatId: String, author: String, done: @escaping (Result<Bool, Failure>) -> Void) {
        let text = message["text"] as? String ?? ""
        let attachment = message["attachment"] as? [String: Any]
        let sentAt = message["createdAt"] as? String ?? message["sentAt"] as? String ?? SavedMessages.stamp.string(from: Date())
        var origin: [String: Any]? = nil
        if let clientId = message["clientId"] as? String {
            origin = ["chatId": chatId, "clientId": clientId, "author": String(author.prefix(80)).isEmpty ? "Собеседник" : String(author.prefix(80)), "sentAt": sentAt]
        }
        save(text: text, attachment: attachment, origin: origin, done: done)
    }

    func remove(_ id: String, done: ((Failure?) -> Void)? = nil) {
        commit(items.filter { $0["id"] as? String != id }, done: done)
    }

    /// «Выбрать» → «Удалить»: several notes in one write.
    func remove(_ ids: Set<String>, done: ((Failure?) -> Void)? = nil) {
        commit(items.filter { !ids.contains($0["id"] as? String ?? "") }, done: done)
    }

    /// «Очистить Избранное»: everything, in one write.
    func clear(done: ((Failure?) -> Void)? = nil) {
        commit([], done: done)
    }

    func edit(_ id: String, text: String, done: ((Failure?) -> Void)? = nil) {
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var changed = items
        guard let index = changed.firstIndex(where: { $0["id"] as? String == id }) else { done?(nil); return }
        changed[index]["text"] = next
        changed[index]["editedAt"] = SavedMessages.stamp.string(from: Date())
        guard SavedMessages.valid(changed[index]) else { done?(Failure(words: "Текст пустой или слишком длинный.")); return }
        commit(changed, done: done)
    }

    // MARK: Words

    /// The line of a note in the list: its text, else what its file is (the reference's `listAttachment`).
    static func line(_ item: [String: Any]) -> (text: String, icon: String) {
        let text = (item["text"] as? String ?? "").split(whereSeparator: { $0 == "\n" }).joined(separator: " ")
        if !text.trimmingCharacters(in: .whitespaces).isEmpty { return (text, "") }
        guard let attachment = item["attachment"] as? [String: Any] else { return ("Запись", "") }
        return ChatRowLooks.attachmentLine(attachment)
    }

    /// The reference's `searchSaved`.
    static func search(_ list: [[String: Any]], _ query: String) -> [[String: Any]] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return list }
        return list.filter { (item: [String: Any]) -> Bool in
            let name = (item["attachment"] as? [String: Any])?["name"] as? String ?? ""
            let author = (item["origin"] as? [String: Any])?["author"] as? String ?? ""
            return ((item["text"] as? String ?? "") + " " + name + " " + author).lowercased().contains(needle)
        }
    }

    #if targetEnvironment(simulator)
    static func sampleItems() -> [[String: Any]] {
        let now = Date()
        func at(_ minutesAgo: Double) -> String { stamp.string(from: now.addingTimeInterval(-minutesAgo * 60)) }
        return [
            ["id": "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b01", "savedAt": at(60 * 26), "text": "Список к поездке: зарядка, документы, плед", "attachment": NSNull()],
            ["id": "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b02", "savedAt": at(60 * 25), "text": "Адрес: Садовая, 14, третий подъезд, код 27",
             "attachment": NSNull(), "origin": ["chatId": "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7c01", "clientId": "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7c02", "author": "Алиса Воронцова", "sentAt": at(60 * 27)]],
            ["id": "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b03", "savedAt": at(42), "text": "",
             "attachment": ["id": "demo-file", "name": "план-встречи.pdf", "mimeType": "application/pdf", "size": 182_000]],
            ["id": "6f1c2a7e-0b1d-4c8e-9a2f-3d4e5f6a7b04", "savedAt": at(7), "text": "Позвонить в сервис до пятницы", "attachment": NSNull()],
        ]
    }
    #endif
}
