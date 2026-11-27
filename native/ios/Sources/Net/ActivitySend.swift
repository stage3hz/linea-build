import Foundation

/// What the person is doing in each chat, as the other side is told it: typing, recording a voice message or a
/// round video, sending a video, a photo, a file, a voice message or a round video. Only the kind leaves the phone
/// (with an upload's percent), never anything of the message.
///
/// Every action is a `Token`, begun when it starts and ended when it stops (sent, called off, failed). While any
/// token of a chat lives, the newest one is said, and said again every `repeat` seconds (the other side drops a
/// mark it does not hear again). When the last one ends, the other side is told the person stopped: an explicit
/// stop clears everything that person was doing there. Main queue only.
final class ActivitySend {
    /// How often an action that lasts is said again, s.
    static let repeatEvery: TimeInterval = 4
    /// The kinds that send something; they may carry a percent.
    static let uploads: Set<String> = ["video", "photo", "file", "voice-upload", "round-upload"]

    final class Token {
        let chatId: String
        let kind: String
        fileprivate(set) var ended = false
        fileprivate(set) var percent: Int?
        fileprivate weak var owner: ActivitySend?

        fileprivate init(chatId: String, kind: String, owner: ActivitySend) {
            self.chatId = chatId
            self.kind = kind
            self.owner = owner
        }

        /// An upload's percent (0…100): carried the next time the action is said.
        func progress(_ percent: Int) {
            guard !ended, ActivitySend.uploads.contains(kind) else { return }
            self.percent = max(0, min(100, percent))
        }

        /// The action stopped (done, called off, failed). Twice is the same as once.
        func end() {
            guard !ended else { return }
            ended = true
            owner?.ended(self)
        }
    }

    private let tell: (_ chatId: String, _ on: Bool, _ kind: String, _ progress: Int?) -> Void
    private let allowed: () -> Bool
    private var active: [String: [Token]] = [:]
    private var repeats: [String: Timer] = [:]
    private var paused = false

    init(tell: @escaping (_ chatId: String, _ on: Bool, _ kind: String, _ progress: Int?) -> Void, allowed: @escaping () -> Bool = { true }) {
        self.tell = tell
        self.allowed = allowed
    }

    /// An action starts in a chat.
    @discardableResult
    func begin(chatId: String, kind: String) -> Token {
        let token = Token(chatId: chatId, kind: kind, owner: self)
        active[chatId, default: []].append(token)
        say(chatId)
        return token
    }

    /// What is said for a chat now: the newest action that lives; nil — nothing.
    func current(_ chatId: String) -> String? { active[chatId]?.last?.kind }

    /// The chat is left: everything in it ends, and the other side is told.
    func endChat(_ chatId: String) {
        guard let list = active.removeValue(forKey: chatId) else { return }
        // Marked ended without a word each: the stop below is said once for all of them.
        for token in list { token.ended = true }
        stop(chatId)
    }

    /// The app left the screen: the other side is told the person stopped; what still goes on is said again on
    /// `resume`.
    func pause() {
        guard !paused else { return }
        paused = true
        for chatId in Array(active.keys) { stop(chatId) }
    }

    /// The line is up again: what goes on is said again.
    func resume() {
        paused = false
        for chatId in Array(active.keys) { say(chatId) }
    }

    private func ended(_ token: Token) {
        guard var list = active[token.chatId] else { return }
        list.removeAll { $0 === token }
        if list.isEmpty {
            active[token.chatId] = nil
            stop(token.chatId)
        } else {
            active[token.chatId] = list
            say(token.chatId)
        }
    }

    private func say(_ chatId: String) {
        repeats.removeValue(forKey: chatId)?.invalidate()
        guard let token = active[chatId]?.last, !paused else { return }
        if allowed() { tell(chatId, true, token.kind, token.percent) }
        repeats[chatId] = Timer.scheduledTimer(withTimeInterval: ActivitySend.repeatEvery, repeats: false) { [weak self] _ in self?.say(chatId) }
    }

    private func stop(_ chatId: String) {
        repeats.removeValue(forKey: chatId)?.invalidate()
        tell(chatId, false, "typing", nil)
    }
}
