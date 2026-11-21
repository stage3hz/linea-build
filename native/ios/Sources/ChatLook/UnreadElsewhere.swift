import UIKit

/// What the list of chats last showed, for the chat header (the reference's ChatScreen.tsx `otherUnread`): the
/// unread messages of the other chats — not counting chats whose sound is off or that are in the archive — and
/// each chat's person as the server listed them (their colour, picture, emoji status, Platina).
enum ChatLookUnread {
    static let changed = Notification.Name("invizent.unread-elsewhere")
    private static var unread: [String: Int] = [:]
    private static var peers: [String: [String: Any]] = [:]

    /// The list of chats as it was just shown (ChatListActions.show). Main thread.
    static func take(_ chats: [Messenger.ChatSummary]) {
        var counts: [String: Int] = [:]
        for chat in chats {
            if let peer = chat.chat["peer"] as? [String: Any] { peers[chat.id] = peer }
            settingsOf[chat.id] = chat.chat["settings"] as? [String: Any] ?? [:] // Profile: the sound of a chat
            let settings = chat.chat["settings"] as? [String: Any] ?? [:]
            if settings["archived"] as? Bool == true || muted(settings) { continue }
            let count = (chat.chat["unreadCount"] as? NSNumber)?.intValue ?? 0
            if count > 0 { counts[chat.id] = count }
        }
        guard counts != unread else { return }
        unread = counts
        NotificationCenter.default.post(name: changed, object: nil)
    }

    /// The sound is off for good, or until a moment the clock has not reached (the reference's `isMuted`).
    private static func muted(_ settings: [String: Any]) -> Bool {
        guard settings["muted"] as? Bool == true else { return false }
        guard let until = settings["mutedUntil"] as? String, !until.isEmpty, let end = Messenger.date(until) else { return true }
        return end > Date()
    }

    /// The unread messages of every chat but this one.
    static func elsewhere(_ chatId: String) -> Int {
        return unread.reduce(0) { (sum: Int, item: (key: String, value: Int)) -> Int in item.key == chatId ? sum : sum + item.value }
    }

    /// The person of a chat as the list knows them (empty when the list has not shown it).
    static func peer(_ chatId: String) -> [String: Any] { peers[chatId] ?? [:] }

    /// Profile: the chat's own settings as the list last read them (`muted`, `mutedUntil`, …); the profile's
    /// «Звук» tile changes them here too, so the list's next reading and the profile agree.
    static var settingsOf: [String: [String: Any]] = [:]
}
