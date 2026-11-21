import Foundation

/// The chat list's line for a chat not opened yet (port of the reference's mobile/src/listCatchUp.ts and the
/// list part of useMessenger.ts).
///
/// The server only has ciphertext, so the list is drawn at once from what this device already opened and kept,
/// and the envelopes of the chats whose line is still closed are opened in the background afterwards — at most
/// `chatsPerPass` chats per pass, unread and newest first, `pages` inbox pages each. A message sent before this
/// device signed in has no envelope for it: once the inbox of its chat went through, the line says so
/// («Это сообщение недоступно на данном устройстве.») instead of «Открой чат для расшифровки», and the chat is
/// not tried again for that message.
final class ListCatchUp {
    static let chatsPerPass = 20
    static let pages = 5
    static let extraPasses = 4
    static let deepChats = 2
    static let retryAfter: TimeInterval = 60
    /// What a list line says when the inbox of the chat was read through and the message still has no key here.
    static let notForDevice = "Это сообщение недоступно на данном устройстве."

    /// Chat → the last message id whose inbox went through (never tried again). Encryption queue only.
    var caughtUp: [String: Int] = [:]
    /// Chat → the last try: a try that did not get through waits `retryAfter` for that message. Encryption queue only.
    var tried: [String: (id: Int, at: Date)] = [:]
    /// Main queue only.
    var busy = false
    var again: [Messenger.ChatSummary]?

    static func number(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }

    /// A line still closed: this device holds no decrypted copy of the message (yet).
    static func awaitsInbox(_ message: [String: Any]?) -> Bool {
        guard let message, !message.isEmpty else { return false }
        return message["cryptoState"] as? String == "no-key" && message["mesh"] == nil
    }

    /// The inbox of the chat went through and the message is still closed: no key is coming. Say so.
    static func settled(_ message: [String: Any]) -> [String: Any] {
        guard awaitsInbox(message), message["text"] as? String != notForDevice else { return message }
        var line = message
        line["text"] = notForDevice
        line["attachment"] = NSNull()
        return line
    }

    /// What the line says when the vault or Signal threw (not this device's verdict on the message).
    static func placeholder(_ message: [String: Any]) -> [String: Any] {
        var line = message
        let legacy = message["legacy"] as? Bool == true
        line["text"] = legacy ? "Сообщение из старой версии без сквозного шифрования." : "Зашифрованное сообщение недоступно на этом устройстве."
        line["attachment"] = NSNull()
        line["cryptoState"] = legacy ? "legacy" : "no-key"
        return line
    }

    /// A fresh line never replaces one this device has already opened (or given its verdict on) with a closed
    /// placeholder for the same message (the reference's `keepOpened`).
    static func kept(_ fresh: [String: Any], previous: [String: Any]?) -> [String: Any] {
        guard awaitsInbox(fresh), let previous, number(previous["id"]) == number(fresh["id"]) else { return fresh }
        if previous["cryptoState"] as? String == "decrypted" || previous["text"] as? String == notForDevice { return previous }
        return fresh
    }

    /// The chats whose last message should be opened now: closed line, not skipped for that very message. Unread
    /// chats first, then the newest; at most `limit`.
    static func targets(_ chats: [Messenger.ChatSummary], skip: (String, Int) -> Bool, limit: Int = chatsPerPass) -> [String] {
        let open = chats.filter { (chat: Messenger.ChatSummary) -> Bool in
            awaitsInbox(chat.last) && !skip(chat.id, number(chat.last["id"]))
        }
        let sorted = open.enumerated().sorted { (a: (offset: Int, element: Messenger.ChatSummary), b: (offset: Int, element: Messenger.ChatSummary)) -> Bool in
            let unreadA = number(a.element.chat["unreadCount"]) > 0, unreadB = number(b.element.chat["unreadCount"]) > 0
            if unreadA != unreadB { return unreadA }
            let atA = a.element.chat["updatedAt"] as? String ?? "", atB = b.element.chat["updatedAt"] as? String ?? ""
            if atA != atB { return atA > atB }
            return a.offset < b.offset
        }
        return sorted.prefix(limit).map { $0.element.id }
    }

    /// The line of one chat's last message on this device, on the encryption queue: the kept copy (or a placeholder
    /// when the vault or Signal threw), this device's verdict when the chat was caught up for that very message, and
    /// never a closed line over one already shown opened.
    func line(chatId: String, last: [String: Any], crypto: CryptoService, previous: [String: Any]?) -> [String: Any] {
        var shown: [String: Any]
        var opened = true
        if case .success(let value) = crypto.callNow("preview", [last]), let made = value as? [String: Any] {
            shown = made
        } else {
            shown = ListCatchUp.placeholder(last)
            opened = false
        }
        if opened, let done = caughtUp[chatId], done == ListCatchUp.number(shown["id"]) { shown = ListCatchUp.settled(shown) }
        return ListCatchUp.kept(shown, previous: previous)
    }

    enum Outcome { case synced, partial, failed, network }

    /// One chat's background sync; every pass goes on from the vault's cursor, so nothing is opened twice.
    /// `deep`: may use the extra passes for a long queue.
    static func sync(_ crypto: CryptoService, chatId: String, deep: Bool) -> Outcome {
        var pass = 0
        while true {
            switch crypto.callNow("sync", [chatId, pages]) {
            case .success: return .synced
            case .failure(let failure):
                if failure.name == "NetworkError" { return .network }
                if failure.name != "PartialSync" { return .failed }
                if !deep || pass >= extraPasses { return .partial }
            }
            pass += 1
        }
    }
}

extension Messenger {
    /// Opens, in the background, the last messages of the chats whose line is still closed, and hands each new line
    /// (chat id, the server's last message id, the line) to `update` on the main queue. One pass at a time; a list
    /// given while one runs is taken up after it. Main queue.
    func catchUpList(_ list: [ChatSummary], update: @escaping (String, Int, [String: Any]) -> Void) {
        let state = catchUp
        if state.busy { state.again = list; return }
        state.busy = true
        crypto.run({ (crypto: CryptoService) -> Void in
            let now = Date()
            let targets = ListCatchUp.targets(list, skip: { (chatId: String, id: Int) -> Bool in
                if state.caughtUp[chatId] == id { return true }
                if let entry = state.tried[chatId], entry.id == id, now.timeIntervalSince(entry.at) < ListCatchUp.retryAfter { return true }
                return false
            })
            var deep = ListCatchUp.deepChats
            for chatId in targets {
                guard let chat = list.first(where: { $0.id == chatId }), let last = chat.chat["lastMessage"] as? [String: Any] else { continue }
                let id = ListCatchUp.number(last["id"])
                state.tried[chatId] = (id: id, at: Date())
                let outcome = ListCatchUp.sync(crypto, chatId: chatId, deep: deep > 0)
                if outcome == .network { return }
                if outcome != .synced, deep > 0 { deep -= 1 }
                var opened = true
                var shown: [String: Any]
                if case .success(let value) = crypto.callNow("preview", [last]), let made = value as? [String: Any] {
                    shown = made
                } else {
                    shown = ListCatchUp.placeholder(last)
                    opened = false
                }
                // Only a full sync and a preview that ran without an exception are this device's verdict.
                if outcome == .synced && opened {
                    state.caughtUp[chatId] = id
                    shown = ListCatchUp.settled(shown)
                }
                let line = shown
                DispatchQueue.main.async { update(chatId, id, line) }
            }
        }, done: { [weak self] (_: Void) -> Void in
            state.busy = false
            guard let self, let next = state.again else { return }
            state.again = nil
            self.catchUpList(next, update: update)
        })
    }
}
