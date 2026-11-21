import UIKit

/// «печатает…»: who is typing in which chat right now, as the live line says it. Main queue only.
/// The reference keeps the mark for five seconds after the last event (useMessenger.ts, `typing`).
final class ChatTyping {
    static let shared = ChatTyping()
    /// Posted on the main queue when somebody started or stopped typing: `object` is the chat's id.
    static let changed = Notification.Name("invizent.typing")
    private var until: [String: Date] = [:]

    func heard(chatId: String, on: Bool) {
        until[chatId] = on ? Date().addingTimeInterval(5) : nil
        NotificationCenter.default.post(name: ChatTyping.changed, object: chatId)
        guard on else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.1) { [weak self] in
            guard let self, let end = self.until[chatId], end <= Date() else { return }
            self.until[chatId] = nil
            NotificationCenter.default.post(name: ChatTyping.changed, object: chatId)
        }
    }

    func isTyping(_ chatId: String) -> Bool {
        guard let end = until[chatId] else { return false }
        return end > Date()
    }
}

/// What one account keeps about its chats on this device only:
/// - messages deleted «у меня» (their `senderId:clientId` names, never their text);
/// - chats deleted «у меня» (the id of the last message each had then: a newer message brings the chat back);
/// - chats marked as unread by hand;
/// - the unsent text of every chat («Черновик»), kept in the encrypted storage under `drafts:v1`, as the
///   reference keeps it (useMessenger.ts).
/// The first three are names and numbers only and live in the app's own settings, as in the reference.
final class ChatLocal {
    /// Posted on the main queue when something here changed (the list of chats is drawn again).
    static let changed = Notification.Name("invizent.chat-local")
    private static var made: [String: ChatLocal] = [:]
    private static let madeLock = NSLock()
    private static let hiddenLimit = 5000
    private static let markedLimit = 500

    /// The account's own keeper (one per account for as long as the app runs).
    static func of(_ messenger: Messenger) -> ChatLocal {
        madeLock.lock()
        defer { madeLock.unlock() }
        if let kept = made[messenger.userId] {
            if kept.crypto !== messenger.crypto { kept.attach(messenger.crypto) }
            return kept
        }
        let fresh = ChatLocal(userId: messenger.userId)
        made[messenger.userId] = fresh
        fresh.attach(messenger.crypto)
        return fresh
    }

    private let userId: String
    private weak var crypto: CryptoService?
    private let lock = NSLock()
    private var hiddenList: [String] = []
    private var removedAt: [String: Int] = [:]
    private var markedList: [String] = []
    private var draftTexts: [String: String] = [:]
    private var draftsLoaded = false
    private var saving: DispatchWorkItem?

    private var hiddenName: String { "invizent.hidden.v1:" + userId }
    private var removedName: String { "invizent.removed-chats.v1:" + userId }
    private var markedName: String { "invizent.marked-unread.v1:" + userId }

    private init(userId: String) {
        self.userId = userId
        let store = UserDefaults.standard
        hiddenList = store.stringArray(forKey: hiddenName) ?? []
        markedList = store.stringArray(forKey: markedName) ?? []
        if let kept = store.dictionary(forKey: removedName) {
            for (chatId, value) in kept {
                if let number = value as? NSNumber { removedAt[chatId] = number.intValue }
            }
        }
    }

    /// Takes the account's encryption (its private storage) and reads the drafts kept there.
    private func attach(_ service: CryptoService) {
        crypto = service
        lock.lock()
        draftsLoaded = false
        lock.unlock()
        service.call("loadLocal", ["drafts:v1"]) { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self else { return }
            var kept: [String: String] = [:]
            if case .success(let value) = result, let raw = value as? String, let saved = Core.value(raw) as? [String: Any] {
                for (chatId, text) in saved {
                    if let text = text as? String, !text.isEmpty, chatId.count <= 80 { kept[chatId] = String(text.prefix(8000)) }
                }
            }
            self.lock.lock()
            // What was typed before the saved drafts were read wins over them (and is written now that it can be).
            let typedBefore = !self.draftTexts.isEmpty
            for (chatId, text) in self.draftTexts { kept[chatId] = text }
            self.draftTexts = kept
            self.draftsLoaded = true
            self.lock.unlock()
            if typedBefore { self.saveDrafts() }
            NotificationCenter.default.post(name: ChatLocal.changed, object: nil)
        }
    }

    // MARK: Messages deleted «у меня»

    /// The names (`senderId:clientId`) of the messages hidden on this device.
    var hiddenKeys: [String] {
        lock.lock()
        defer { lock.unlock() }
        return hiddenList
    }

    func hide(_ keys: [String]) {
        guard !keys.isEmpty else { return }
        lock.lock()
        var seen = Set(hiddenList)
        for key in keys where !seen.contains(key) {
            seen.insert(key)
            hiddenList.append(key)
        }
        if hiddenList.count > ChatLocal.hiddenLimit { hiddenList = Array(hiddenList.suffix(ChatLocal.hiddenLimit)) }
        let list = hiddenList
        lock.unlock()
        UserDefaults.standard.set(list, forKey: hiddenName)
    }

    // MARK: Chats deleted «у меня»

    /// The chat stays out of the list until a message newer than `lastMessageId` comes.
    func removeChat(_ chatId: String, lastMessageId: Int) {
        lock.lock()
        removedAt[chatId] = lastMessageId
        let kept = removedAt
        lock.unlock()
        UserDefaults.standard.set(kept, forKey: removedName)
        NotificationCenter.default.post(name: ChatLocal.changed, object: nil)
    }

    func isRemoved(_ chatId: String, lastMessageId: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let at = removedAt[chatId] else { return false }
        return lastMessageId <= at
    }

    // MARK: Marked as unread

    func isMarked(_ chatId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return markedList.contains(chatId)
    }

    func setMarked(_ chatId: String, _ on: Bool) {
        lock.lock()
        markedList.removeAll { $0 == chatId }
        if on { markedList.append(chatId) }
        if markedList.count > ChatLocal.markedLimit { markedList = Array(markedList.suffix(ChatLocal.markedLimit)) }
        let list = markedList
        lock.unlock()
        UserDefaults.standard.set(list, forKey: markedName)
        NotificationCenter.default.post(name: ChatLocal.changed, object: nil)
    }

    // MARK: Drafts

    func draft(_ chatId: String) -> String {
        lock.lock()
        defer { lock.unlock() }
        return draftTexts[chatId] ?? ""
    }

    /// Remembers the unsent text of a chat; it is written to the encrypted storage a moment after typing stops.
    /// Main queue only.
    func setDraft(_ chatId: String, _ text: String) {
        lock.lock()
        let same = (draftTexts[chatId] ?? "") == text
        if !same { draftTexts[chatId] = text }
        lock.unlock()
        if same { return }
        saving?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.saveDrafts() }
        saving = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: work)
        NotificationCenter.default.post(name: ChatLocal.changed, object: chatId)
    }

    private func saveDrafts() {
        lock.lock()
        let loaded = draftsLoaded
        var kept: [String: String] = [:]
        for (chatId, text) in draftTexts {
            if kept.count >= 200 { break }
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { kept[chatId] = text }
        }
        lock.unlock()
        // Before the saved drafts were read nothing is written: writing now would lose the ones not read yet.
        guard loaded, let json = Core.text(kept) else { return }
        crypto?.call("storeLocal", ["drafts:v1", json]) { (_: Result<Any, CryptoFailure>) -> Void in }
    }
}
