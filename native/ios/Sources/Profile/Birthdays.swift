import UIKit
import UserNotifications

/// Birthday reminders for friends (the reference's birthdayNotifications.ts and birthday.ts `birthdayReminders`):
/// local notifications on this phone — the day before at 10:00 and 20:00 («Иван: завтра день рождения»), on the day at
/// 00:00 and 10:00 («Иван: сегодня день рождения!»). Nothing is sent to the server: the birthdays come with the chats
/// this account already has (the server shares them with friends only). Archived chats are left out; at most 48 are
/// pending (iOS keeps 64 per app). Tapping one opens that chat with the person's profile on top.
///
/// The notification centre's delegate is taken only when nobody else has taken it; whoever owns it (push) calls
/// `BirthdayReminders.shared.open(userInfo)` for a tapped notification and gets true when it was a birthday's.
final class BirthdayReminders: NSObject, UNUserNotificationCenterDelegate {
    static let shared = BirthdayReminders()
    private static let prefix = "invizent-birthday-"
    private static let most = 48
    private weak var messenger: Messenger?
    private var signature = ""
    private var askedAt = Date.distantPast

    struct Reminder { let at: Date; let title: String; let body: String }

    /// The reminders of one person, only those still ahead (birthday.ts `birthdayReminders`, word for word).
    static func reminders(name: String, birthday: String, now: Date = Date()) -> [Reminder] {
        guard let day = AvatarCatalog.nextBirthday(birthday, now: now) else { return [] }
        let calendar = Calendar.current
        func at(_ offsetDays: Int, _ hour: Int) -> Date? {
            guard let shifted = calendar.date(byAdding: .day, value: offsetDays, to: day) else { return nil }
            return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: shifted)
        }
        // The name is not declined (an app cannot decline arbitrary names), so it stands in the nominative.
        let tomorrow = (title: "🎂 \(name): завтра день рождения", body: "Нажми, чтобы открыть профиль.")
        let today = (title: "🎉 \(name): сегодня день рождения!", body: "Нажми, чтобы открыть профиль и поздравить.")
        var made: [Reminder] = []
        for (offset, hour, words) in [(-1, 10, tomorrow), (-1, 20, tomorrow), (0, 0, today), (0, 10, today)] {
            if let moment = at(offset, hour), moment > now { made.append(Reminder(at: moment, title: words.title, body: words.body)) }
        }
        return made
    }

    func start(_ messenger: Messenger?) {
        guard let messenger else { return }
        self.messenger = messenger
        let centre = UNUserNotificationCenter.current()
        if centre.delegate == nil { centre.delegate = self }
        NotificationCenter.default.removeObserver(self)
        NotificationCenter.default.addObserver(self, selector: #selector(changed), name: Messenger.changed, object: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refresh() }
    }

    @objc private func changed() {
        // The list changes often; the birthdays rarely: asked at most every ten minutes.
        guard Date().timeIntervalSince(askedAt) > 600 else { return }
        refresh()
    }

    private func refresh() {
        guard let messenger else { return }
        askedAt = Date()
        messenger.server.op("chats", []) { [weak self] (result: Result<Any, ServerError>) -> Void in
            guard case .success(let body) = result else { return }
            let chats = (body as? [String: Any])?["chats"] as? [[String: Any]] ?? []
            var people: [(chatId: String, peerId: String, name: String, birthday: String)] = []
            for chat in chats {
                guard let id = chat["id"] as? String, let peer = chat["peer"] as? [String: Any], let birthday = peer["birthday"] as? String, !birthday.isEmpty else { continue }
                if (chat["settings"] as? [String: Any])?["archived"] as? Bool == true { continue }
                people.append((chatId: id, peerId: peer["id"] as? String ?? "", name: peer["displayName"] as? String ?? "", birthday: birthday))
            }
            DispatchQueue.main.async { self?.schedule(people) }
        }
    }

    private func schedule(_ people: [(chatId: String, peerId: String, name: String, birthday: String)]) {
        let mark = people.map { "\($0.chatId):\($0.name):\($0.birthday)" }.sorted().joined(separator: "|")
        guard mark != signature else { return }
        signature = mark
        let centre = UNUserNotificationCenter.current()
        centre.getPendingNotificationRequests { (pending: [UNNotificationRequest]) -> Void in
            let old = pending.map { $0.identifier }.filter { $0.hasPrefix(BirthdayReminders.prefix) }
            centre.removePendingNotificationRequests(withIdentifiers: old)
            guard !people.isEmpty else { return }
            #if targetEnvironment(simulator)
            // The simulator check takes pictures: the system question would cover them (`-asknotify 1` shows it).
            guard UserDefaults.standard.bool(forKey: "asknotify") else { return }
            #endif
            centre.requestAuthorization(options: [.alert, .sound]) { (granted: Bool, _: Error?) -> Void in
                guard granted else { return }
                var all: [(reminder: Reminder, chatId: String, peerId: String, name: String)] = []
                for person in people {
                    for reminder in BirthdayReminders.reminders(name: person.name, birthday: person.birthday) {
                        all.append((reminder: reminder, chatId: person.chatId, peerId: person.peerId, name: person.name))
                    }
                }
                all.sort { $0.reminder.at < $1.reminder.at }
                for (index, item) in all.prefix(BirthdayReminders.most).enumerated() {
                    let content = UNMutableNotificationContent()
                    content.title = item.reminder.title
                    content.body = item.reminder.body
                    content.sound = .default
                    content.userInfo = ["kind": "birthday", "birthdayChatId": item.chatId, "peerId": item.peerId, "name": item.name]
                    let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: item.reminder.at)
                    let trigger = UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
                    centre.add(UNNotificationRequest(identifier: BirthdayReminders.prefix + "\(index)", content: content, trigger: trigger), withCompletionHandler: nil)
                }
            }
        }
    }

    /// A tapped birthday notification: the chat, then the person's profile on top. False for any other notification.
    @discardableResult
    func open(_ info: [AnyHashable: Any]) -> Bool {
        guard info["kind"] as? String == "birthday", let chatId = info["birthdayChatId"] as? String, let messenger else { return false }
        let peerId = info["peerId"] as? String ?? ""
        let name = info["name"] as? String ?? ""
        guard let stack = platinaKeyWindow()?.rootViewController as? UINavigationController else { return true }
        stack.popToRootViewController(animated: false)
        stack.pushViewController(ChatViewController(name: name, messenger: messenger, chatId: chatId, peerId: peerId), animated: false)
        stack.pushViewController(PersonProfileViewController(messenger: messenger, userId: peerId, name: name, chatId: chatId), animated: true)
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // While the app is open the reminder goes to the list quietly (the reference: no banner, no sound).
        completionHandler(UIApplication.shared.applicationState == .active ? [.list] : [.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        DispatchQueue.main.async {
            self.open(info)
            completionHandler()
        }
    }
}
