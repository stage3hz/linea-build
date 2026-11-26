import UIKit
import UserNotifications

/// Push notifications on the iPhone, as the previous app did them (`mobile/src/push.ts`): straight through Apple
/// (APNs). The server sends only the sender's name and «Новое сообщение» / «Входящий звонок» — message text stays
/// end-to-end encrypted and never reaches a notification. While the app is open the live line already delivers
/// everything, so no banner is shown then.
///
/// - Permission is asked once the account is open (the reference's `usePush`); the device token is registered for
///   the signed-in session as lowercase hex (`PUT /me/push {token, platform: "ios"}`) at every start, and removed
///   before signing out (`DELETE /me/push`, Settings/AccountActions.swift).
/// - A build without the «aps-environment» entitlement (every sideloaded build: InvizentPush.entitlements is only for a
///   Push-capable signature) gets no token: the status is then `unavailable`, and «Уведомления и звуки» says
///   «Уведомления не настроены в этой сборке приложения.» (`text(_:)`, word for word the reference's).
/// - A tapped notification opens its chat (or the room of «зовёт в комнату»); one that started the app waits for the
///   account and the code lock. Birthday reminders (Profile/Birthdays.swift) are handed to their owner.
/// - The notification centre's delegate is this object, taken at launch (AppDelegate) so that the tap which started
///   the app is not lost.
final class Push: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Push()
    /// Posted (main queue) when `status` changed.
    static let changed = Notification.Name("invizent.push.changed")

    /// What this device managed to do (the reference's `PushStatus` without `unsupported`):
    /// pending — not asked yet; denied — the system permission is off; unavailable — this build has no push
    /// configuration (no Push entitlement) or Apple could not be reached; serverOff — the token is registered but the
    /// server has no key for this platform; on — working.
    enum Status: String { case pending, denied, unavailable, serverOff = "server-off", on }

    private(set) var status: Status = .pending {
        didSet { if status != oldValue { NotificationCenter.default.post(name: Push.changed, object: nil) } }
    }
    private weak var messenger: Messenger?
    /// Apple was asked for a token only to learn whether this build can have one (the simulator check, `start`).
    private var probing = false
    /// A tapped notification that came before the account (or behind the code lock).
    private var waiting: [AnyHashable: Any]?

    /// The few words of «Уведомления и звуки»; empty when everything works (`pushStatusText` of push.ts).
    static func text(_ status: Status) -> String {
        switch status {
        case .denied: return "Уведомления выключены в настройках системы."
        case .unavailable: return "Уведомления не настроены в этой сборке приложения."
        case .serverOff: return "Сервер пока не отправляет уведомления на это устройство."
        default: return ""
        }
    }

    /// At launch, before it ends: the delegate, and «opening the app clears what is already on screen».
    func install() {
        UNUserNotificationCenter.current().delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(cameBack), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// The account is open: asks for permission once and registers this device's token.
    func start(_ messenger: Messenger) {
        self.messenger = messenger
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.deliver() }
        #if targetEnvironment(simulator)
        // The simulator check takes pictures: the system question would cover them (`-asknotify 1` shows it). Without
        // the question Apple is still asked for a token — that needs no permission and shows nothing — so that a
        // build without the Push entitlement says so on «Уведомления и звуки», as the previous app does there.
        let mayAsk = UserDefaults.standard.bool(forKey: "asknotify")
        #else
        let mayAsk = true
        #endif
        let centre = UNUserNotificationCenter.current()
        centre.getNotificationSettings { [weak self] (settings: UNNotificationSettings) -> Void in
            let go: (Bool) -> Void = { (granted: Bool) -> Void in
                DispatchQueue.main.async {
                    guard let self, self.messenger != nil else { return }
                    guard granted else { self.status = .denied; return }
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
            switch settings.authorizationStatus {
            case .notDetermined:
                if mayAsk {
                    centre.requestAuthorization(options: [.alert, .badge, .sound]) { (granted: Bool, _: Error?) -> Void in go(granted) }
                } else {
                    DispatchQueue.main.async {
                        guard let self, self.messenger != nil else { return }
                        self.probing = true
                        UIApplication.shared.registerForRemoteNotifications()
                    }
                }
            case .authorized, .provisional, .ephemeral:
                go(true)
            default:
                go(false)
            }
        }
    }

    /// AppDelegate: Apple gave the token (raw bytes) — registered as lowercase hex for this session.
    func registered(_ deviceToken: Data) {
        // A token that came without the permission having been asked is not registered: it only showed that this
        // build can have one.
        if probing {
            probing = false
            return
        }
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard let messenger, !hex.isEmpty else { return }
        messenger.server.op("registerPush", [hex, "ios"]) { [weak self] (result: Result<Any, ServerError>) -> Void in
            guard case .success(let body) = result else { return } // as the reference: a failed request changes nothing
            let enabled = (body as? [String: Any])?["enabled"] as? Bool ?? false
            DispatchQueue.main.async { self?.status = enabled ? .on : .serverOff }
        }
    }

    /// AppDelegate: no token — no «aps-environment» entitlement (a sideloaded build) or no way to Apple.
    func failed(_ error: Error) {
        DispatchQueue.main.async {
            self.probing = false
            self.status = .unavailable
        }
    }

    /// Before signing out, so this device stops receiving pushes (`stopPush`); `done` on the main queue either way.
    func stop(_ server: Server, done: @escaping () -> Void) {
        messenger = nil
        waiting = nil
        server.op("unregisterPush", []) { [weak self] (_: Result<Any, ServerError>) -> Void in
            DispatchQueue.main.async {
                self?.status = .pending
                done()
            }
        }
    }

    /// The account was closed without signing out here (the session ended elsewhere): nothing is asked of the server.
    func forget() {
        messenger = nil
        waiting = nil
        status = .pending
    }

    @objc private func cameBack() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    // MARK: Showing and tapping

    /// While the app is open: «Уведомления и звуки» per kind (push.ts `setNotificationHandler`) — a call always rings,
    /// a community message follows «Сообщества», everything else «Личные чаты»; «Отправить без звука» never sounds.
    /// The app in front shows nothing (the live line has it already).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let info = notification.request.content.userInfo
        DispatchQueue.main.async {
            let background = UIApplication.shared.applicationState != .active
            let kind = info["kind"] as? String
            if kind == "birthday" {
                // As before (Profile/Birthdays.swift): quietly into the list while the app is open.
                completionHandler(background ? [.banner, .list, .sound] : [.list])
                return
            }
            let group: String? = kind == "call" ? nil : kind == "community" ? "communities" : "chats"
            let show = background && (group.map { NotificationPrefs.flag($0, "show") } ?? true)
            let sound = show && kind != "silent" && (group.map { NotificationPrefs.flag($0, "sound") } ?? true)
            var options: UNNotificationPresentationOptions = []
            if show { options.insert(.banner); options.insert(.list) }
            if sound { options.insert(.sound) }
            completionHandler(options)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        DispatchQueue.main.async {
            if !BirthdayReminders.shared.open(info), info["chatId"] is String || info["roomId"] is String {
                self.waiting = info
                self.deliver()
            }
            completionHandler()
        }
    }

    /// Opens what a tapped notification is about, once the account is open and not locked (tried again shortly).
    private func deliver(tries: Int = 15) {
        guard let info = waiting else { return }
        guard let messenger, !LockGate.shared.locked, let stack = RoomRouter.navigation(), let root = stack.viewControllers.first as? RootViewController else {
            if tries > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.deliver(tries: tries - 1) } }
            return
        }
        waiting = nil
        // «<имя> зовёт в комнату»: the room in «Каналы» (walking in stays a deliberate press on «Зайти»).
        if let roomId = info["roomId"] as? String { RoomRouter.open(roomId); return }
        guard let chatId = info["chatId"] as? String else { return }
        messenger.chats { (result: Result<[Messenger.ChatSummary], ServerError>) -> Void in
            DispatchQueue.main.async {
                guard case .success(let list) = result, let chat = list.first(where: { $0.id == chatId }) else { return }
                stack.presentedViewController?.dismiss(animated: false)
                root.loadViewIfNeeded()
                root.show("chats")
                let screen = ChatViewController(name: chat.title, messenger: messenger, chatId: chat.id, peerId: chat.peerId)
                screen.peerLastRead = chat.peerLastRead
                stack.setViewControllers([root, screen], animated: stack.viewControllers.count == 1)
            }
        }
    }
}
