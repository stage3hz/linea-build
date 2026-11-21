import Foundation

/// What the chat list and the open chats showed last time, kept in this account's encrypted vault (SQLCipher, next
/// to the decrypted message cache — never in plain files, never on the server). The app opens with it at once and
/// without a network; a successful refresh from the server replaces it. The ciphertext of a message (`encrypted`)
/// is left out: only what was already shown is kept.
///
/// Port of the reference's mobile/src/chatListCache.ts: the same vault names (`chats:v1`, `page:v1:<chatId>`), the
/// same JSON, the same limits and checks. Written through the core's `storeCache`; read with
/// `CryptoService.loadCacheAtOnce` (the same entry the core's `loadCache` reads, but not queued behind network work).
enum ChatCache {
    static let listName = "chats:v1"
    static let listLimit = 500
    static let pageLimit = 60

    private static func chatIdOk(_ chatId: String) -> Bool {
        let count = chatId.utf8.count
        return count >= 1 && count <= 80 && chatId.unicodeScalars.allSatisfy { (c: Unicode.Scalar) -> Bool in
            (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "_" || c == "-"
        }
    }

    /// Vault name of a chat's last shown page of messages; nil for an id that cannot be one.
    static func pageName(_ chatId: String) -> String? { chatIdOk(chatId) ? "page:v1:" + chatId : nil }

    /// The names the core's `loadCache` / `storeCache` accept (its `cache_name`).
    static func isCacheName(_ name: String) -> Bool {
        if name == listName { return true }
        guard name.hasPrefix("page:v1:") else { return false }
        return chatIdOk(String(name.dropFirst("page:v1:".count)))
    }

    private static func stripped(_ message: [String: Any]) -> [String: Any] {
        var copy = message
        copy["encrypted"] = nil
        return copy
    }

    private static func validMessage(_ value: Any?) -> Bool {
        guard let message = value as? [String: Any] else { return false }
        let attachmentOk = message["attachment"] is NSNull || message["attachment"] is [String: Any]
        return message["id"] is NSNumber && message["chatId"] is String && message["senderId"] is String && message["clientId"] is String
            && message["text"] is String && message["createdAt"] is String && attachmentOk
    }

    private static func validChat(_ value: Any?) -> Bool {
        guard let chat = value as? [String: Any], chat["id"] is String, let peer = chat["peer"] as? [String: Any], peer["id"] is String,
              chat["updatedAt"] is String, chat["unreadCount"] is NSNumber else { return false }
        return chat["lastMessage"] is NSNull || validMessage(chat["lastMessage"])
    }

    /// The list as shown: each chat as the server listed it, with its last message as this device showed it.
    static func encodeList(_ chats: [Messenger.ChatSummary]) -> String? {
        var out: [[String: Any]] = []
        for summary in chats.prefix(listLimit) {
            var chat = summary.chat
            if summary.last.isEmpty {
                chat["lastMessage"] = NSNull()
            } else {
                var line = stripped(summary.last)
                if line["attachment"] == nil { line["attachment"] = NSNull() }
                if line["text"] == nil { line["text"] = "" }
                chat["lastMessage"] = line
            }
            if chat["id"] == nil { continue }
            out.append(chat)
        }
        return Core.text(out)
    }

    /// The kept list in the order it was shown (pinned first); anything damaged reads as nothing.
    static func decodeList(_ raw: String?) -> [[String: Any]] {
        guard let raw, !raw.isEmpty, let list = Core.value(raw) as? [Any] else { return [] }
        var seen = Set<String>()
        var out: [[String: Any]] = []
        for item in list {
            guard validChat(item), let chat = item as? [String: Any], let id = chat["id"] as? String, !seen.contains(id) else { continue }
            seen.insert(id)
            out.append(chat)
            if out.count >= listLimit { break }
        }
        return out
    }

    /// The newest `pageLimit` messages of a chat as shown (opened copies; never anything still being sent).
    static func encodePage(_ messages: [[String: Any]], hasMore: Bool) -> String? {
        let kept = messages.filter { (message: [String: Any]) -> Bool in
            let id = (message["id"] as? NSNumber)?.intValue ?? 0
            return id > 0 && message["localState"] == nil && message["mesh"] == nil
        }
        let page = kept.suffix(pageLimit).map { stripped($0) }
        let fields: [String: Any] = ["messages": Array(page), "hasMore": hasMore || kept.count > page.count]
        return Core.text(fields)
    }

    static func decodePage(_ raw: String?, chatId: String) -> (messages: [[String: Any]], hasMore: Bool)? {
        guard let raw, !raw.isEmpty, let fields = Core.value(raw) as? [String: Any], let list = fields["messages"] as? [Any] else { return nil }
        var messages: [[String: Any]] = []
        for item in list {
            guard validMessage(item), let message = item as? [String: Any], message["chatId"] as? String == chatId else { continue }
            messages.append(message)
        }
        messages.sort { (a: [String: Any], b: [String: Any]) -> Bool in
            ((a["id"] as? NSNumber)?.intValue ?? 0) < ((b["id"] as? NSNumber)?.intValue ?? 0)
        }
        return messages.isEmpty ? nil : (messages: messages, hasMore: fields["hasMore"] as? Bool == true)
    }
}

extension Messenger {
    /// The chat list as it was shown last time (from the vault), as rows — at once, before (or without) the
    /// network. Empty when nothing was kept. `done` on the main queue.
    func cachedChats(done: @escaping ([ChatSummary]) -> Void) {
        let crypto = self.crypto
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let chats = ChatCache.decodeList(crypto.loadCacheAtOnce(ChatCache.listName))
            var made: [ChatSummary] = []
            if let self {
                for chat in chats {
                    let last = chat["lastMessage"] as? [String: Any]
                    if let summary = self.summary(chat, shown: last, section: "") { made.append(summary) }
                }
            }
            DispatchQueue.main.async { done(made) }
        }
    }

    /// Keeps the list as shown now (after the server answered) for the next start.
    func storeChats(_ chats: [ChatSummary]) {
        guard let text = ChatCache.encodeList(chats) else { return }
        crypto.call("storeCache", [ChatCache.listName, text]) { _ in }
    }
}
