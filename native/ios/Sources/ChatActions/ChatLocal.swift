import UIKit

/// «печатает», «записывает голосовое», «отправляет видео»…: what the people of each chat are doing right now, as
/// the live line says it (`typing` events with their `kind`). Main queue only.
///
/// One action per person: a newer kind replaces the older one, an explicit stop clears everything that person was
/// doing in the chat. The sender says it again every few seconds while it lasts (Sources/Net/ActivitySend.swift); a
/// mark not heard again for `hold` seconds goes by itself, so a lost stop never sticks.
final class ChatTyping {
    static let shared = ChatTyping()
    /// How long a mark lasts without being heard again, s (the sender repeats it every 4 s).
    static let hold: TimeInterval = 6
    /// Posted on the main queue when somebody started or stopped: `object` is the chat's id.
    static let changed = Notification.Name("invizent.typing")
    /// Tests: the clock the marks are timed by.
    var clock: () -> Date = { Date() }

    private struct Mark { let kind: String; let since: Date; let until: Date }
    /// chat → person → what they do.
    private var active: [String: [String: Mark]] = [:]

    func heard(chatId: String, userId: String, kind: String, on: Bool) {
        let now = clock()
        guard on else {
            guard active[chatId]?.removeValue(forKey: userId) != nil else { return }
            if active[chatId]?.isEmpty == true { active[chatId] = nil }
            NotificationCenter.default.post(name: ChatTyping.changed, object: chatId)
            return
        }
        let known = ChatActivityWords.known(kind)
        let before = active[chatId]?[userId]
        // The same action heard again only moves its end; a new one starts now (the newest is said first).
        let since = before?.kind == known ? before!.since : now
        active[chatId, default: [:]][userId] = Mark(kind: known, since: since, until: now.addingTimeInterval(ChatTyping.hold))
        if before?.kind != known { NotificationCenter.default.post(name: ChatTyping.changed, object: chatId) }
        DispatchQueue.main.asyncAfter(deadline: .now() + ChatTyping.hold + 0.1) { [weak self] in self?.expire(chatId) }
    }

    /// Drops the marks of a chat that were not heard again in time.
    func expire(_ chatId: String) {
        guard let people = active[chatId] else { return }
        let now = clock()
        let kept = people.filter { $0.value.until > now }
        guard kept.count != people.count else { return }
        active[chatId] = kept.isEmpty ? nil : kept
        NotificationCenter.default.post(name: ChatTyping.changed, object: chatId)
    }

    func isTyping(_ chatId: String) -> Bool { !who(chatId).isEmpty }

    /// Who does what in a chat now, the newest action first: (person, kind).
    func who(_ chatId: String) -> [(userId: String, kind: String)] {
        let now = clock()
        return (active[chatId] ?? [:]).filter { $0.value.until > now }
            .sorted { $0.value.since != $1.value.since ? $0.value.since > $1.value.since : $0.key < $1.key }
            .map { (userId: $0.key, kind: $0.value.kind) }
    }

    /// The words for a chat, without the dots («печатает», «Аня и Лев печатают»); nil — nobody does anything.
    /// `name`: a person's name, for a group.
    func words(_ chatId: String, group: Bool, name: (String) -> String?) -> String? {
        ChatActivityWords.label(who(chatId).map { (name: name($0.userId), kind: $0.kind) }, group: group)
    }

    /// Tests and the account's end: forgets everything.
    func clear() {
        active = [:]
        NotificationCenter.default.post(name: ChatTyping.changed, object: nil)
    }
}

/// The words of what people are doing in a chat. The app's own lines carry no emoji.
enum ChatActivityWords {
    /// kind → (one person, several people), in their order.
    static let verbs: [(kind: String, one: String, many: String)] = [
        ("typing", "печатает", "печатают"),
        ("voice", "записывает голосовое", "записывают голосовое"),
        ("round", "записывает видеосообщение", "записывают видеосообщение"),
        ("video", "отправляет видео", "отправляют видео"),
        ("photo", "отправляет фото", "отправляют фото"),
        ("file", "отправляет файл", "отправляют файл"),
        ("voice-upload", "отправляет голосовое", "отправляют голосовое"),
        ("round-upload", "отправляет видеосообщение", "отправляют видеосообщение"),
    ]
    static var kinds: [String] { verbs.map(\.kind) }

    /// A kind this app knows, else plain typing (an unknown or missing kind from another version).
    static func known(_ kind: String?) -> String {
        guard let kind, verbs.contains(where: { $0.kind == kind }) else { return "typing" }
        return kind
    }

    /// `people`: (name, kind), the newest action first. One to one: just the action of the other person. In a
    /// group: the people doing what the newest one does — «Аня печатает», «Аня и Лев печатают», «3 человека печатают».
    static func label(_ people: [(name: String?, kind: String)], group: Bool) -> String? {
        guard let first = people.first else { return nil }
        let kind = known(first.kind)
        guard let verb = verbs.first(where: { $0.kind == kind }) else { return nil }
        if !group { return verb.one }
        let doing = people.filter { known($0.kind) == kind }
        let names = doing.map { ($0.name ?? "").trimmingCharacters(in: .whitespaces) }
        if doing.count == 1 { return names[0].isEmpty ? line(verb.one) : "\(names[0]) \(verb.one)" }
        if doing.count == 2 && !names.contains(where: { $0.isEmpty }) { return "\(names[0]) и \(names[1]) \(verb.many)" }
        return "\(doing.count) \(peopleWord(doing.count)) \(verb.many)"
    }

    /// 2 человека, 5 человек, 21 человек, 22 человека.
    static func peopleWord(_ count: Int) -> String {
        let tens = count % 100, last = count % 10
        return (2...4).contains(last) && !(12...14).contains(tens) ? "человека" : "человек"
    }

    /// The start of a chat row's line: the same words with a capital letter.
    static func line(_ words: String) -> String { words.prefix(1).uppercased() + words.dropFirst() }

    /// How many of the three dots after the words are lit at `time` (0…3, a step every 0.35 s).
    static func dots(_ time: TimeInterval) -> Int { Int((time / 0.35).rounded(.down)) % 4 }

    /// The words with three dots after them, `lit` of them shown (the others keep their room, so the line does not
    /// move while they blink).
    static func dotted(_ words: String, lit: Int, color: UIColor, font: UIFont) -> NSAttributedString {
        let said = Language.tr(words)
        let text = NSMutableAttributedString(string: said + "...", attributes: [.foregroundColor: color, .font: font])
        let from = (said as NSString).length + max(0, min(3, lit))
        if from < text.length { text.addAttribute(.foregroundColor, value: UIColor.clear, range: NSRange(location: from, length: text.length - from)) }
        return text
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
