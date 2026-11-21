import UIKit
import UserNotifications

/// The number on the app's icon: unread chats (not archived; a muted chat only with «Включая чаты без звука»),
/// the communities' counters and the waiting requests to be friends — the same total the server sends in pushes
/// while the app is closed. Off with «Считать непрочитанные» (Уведомления и звуки › Бейдж на иконке).
/// (The previous app: `mobile/src/appBadge.ts` and the total of `App.tsx`.)
final class AppBadge: NSObject {
    static let shared = AppBadge()

    private weak var messenger: Messenger?
    private var chatsTotal = 0
    private var last = -1
    private var asking = false

    func start(_ messenger: Messenger) {
        self.messenger = messenger
        chatsTotal = 0
        last = -1
        let centre = NotificationCenter.default
        centre.removeObserver(self)
        centre.addObserver(self, selector: #selector(apply), name: ChannelsStore.changed, object: nil)
        centre.addObserver(self, selector: #selector(apply), name: FriendRequests.changed, object: nil)
        centre.addObserver(self, selector: #selector(apply), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    /// The chats as the list has them now (Chats/ChatsViewController.swift, after each reading).
    func chats(_ list: [Messenger.ChatSummary]) {
        let countMuted = (NotificationPrefs.all["badge"] as? [String: Any])?["countMuted"] as? Bool ?? false
        var total = 0
        for chat in list {
            let settings = chat.chat["settings"] as? [String: Any] ?? [:]
            if settings["archived"] as? Bool == true { continue }
            if !countMuted && AppBadge.muted(settings) { continue }
            total += max(0, (chat.chat["unreadCount"] as? NSNumber)?.intValue ?? 0)
        }
        chatsTotal = total
        apply()
    }

    /// The sound is off: for good, or until a moment the clock has not reached (`isMuted`).
    static func muted(_ settings: [String: Any]) -> Bool {
        guard settings["muted"] as? Bool == true else { return false }
        guard let until = settings["mutedUntil"] as? String, !until.isEmpty else { return true }
        guard let end = Messenger.date(until) else { return true }
        return end > Date()
    }

    @objc func apply() {
        guard messenger != nil else { return }
        let enabled = NotificationPrefs.flag("badge", "enabled")
        let total = enabled ? chatsTotal + ChannelsStore.shared.badge + FriendRequests.shared.incoming.count : 0
        set(total)
    }

    /// Clears the number (the account was left).
    func clear() {
        messenger = nil
        chatsTotal = 0
        set(0)
    }

    private func set(_ total: Int) {
        let n = max(0, total)
        guard n != last else { return }
        let centre = UNUserNotificationCenter.current()
        centre.getNotificationSettings { [weak self] (settings: UNNotificationSettings) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                if settings.authorizationStatus == .notDetermined {
                    // The number on the icon needs the person's yes once; it is asked when there is first something to show.
                    guard n > 0, !self.asking, UIApplication.shared.applicationState == .active else { return }
                    self.asking = true
                    centre.requestAuthorization(options: [.badge]) { (_: Bool, _: Error?) -> Void in
                        DispatchQueue.main.async {
                            self.asking = false
                            self.last = -1
                            self.apply()
                        }
                    }
                    return
                }
                guard settings.badgeSetting == .enabled || n == 0 else { return }
                self.last = n
                centre.setBadgeCount(n) { (problem: Error?) -> Void in
                    if problem != nil { DispatchQueue.main.async { self.last = -1 } }
                }
            }
        }
    }
}
