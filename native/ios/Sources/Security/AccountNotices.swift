import UIKit

extension Live {
    /// Security: `session.new`, `recovery.requested`, `recovery.updated` (`userInfo["event"]` is the packet).
    static let securityEvent = Notification.Name("invizent.live.security")
}

/// «Новый вход» and «Запрошено восстановление аккаунта»: notices above the chat list, each opening a sheet.
/// (The previous app: `NewLoginNotice.tsx` with `sessionAlerts.ts`, and `RecoveryNotice.tsx` with the polling of
/// `useMessenger.ts`.) The sign-ins are kept only while the app is open (the full list is «Активные сеансы»);
/// the recovery requests are asked from the server at start, on its events, and every 30 s while the app is active.
final class AccountNotices: NSObject {
    static let shared = AccountNotices()
    static let changed = Notification.Name("invizent.account-notices")

    struct NewLogin { let session: [String: Any]; let label: String; let id: String }

    private(set) weak var messenger: Messenger?
    private(set) var logins: [NewLogin] = []
    private(set) var recovery: [[String: Any]] = []
    private(set) var recoveryError = ""
    private var poll: Timer?
    private var revision = 0
    private weak var host: UIView?
    private let card = NoticeCards()

    /// Called once by the signed-in account (Messenger).
    func start(_ messenger: Messenger) {
        self.messenger = messenger
        logins = []
        recovery = []
        recoveryError = ""
        let centre = NotificationCenter.default
        centre.removeObserver(self)
        centre.addObserver(self, selector: #selector(heard(_:)), name: Live.securityEvent, object: nil)
        centre.addObserver(self, selector: #selector(cameBack), name: UIApplication.didBecomeActiveNotification, object: nil)
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] (_: Timer) -> Void in
            if UIApplication.shared.applicationState == .active { self?.refreshRecovery() }
        }
        refreshRecovery()
        // Links: the number on the app's icon (Links/AppBadge.swift).
        AppBadge.shared.start(messenger)
        // Links: a link that came before the account was open (Links/DeepLinks.swift).
        DeepLinks.shared.accountReady()
        tell()
    }

    private func tell() {
        card.show(logins: logins, recovery: recovery, error: recoveryError)
        host?.setNeedsLayout()
        NotificationCenter.default.post(name: AccountNotices.changed, object: nil)
    }

    @objc private func cameBack() { refreshRecovery() }

    @objc private func heard(_ note: Notification) {
        guard let data = note.userInfo?["event"] as? [String: Any], let type = data["type"] as? String else { return }
        // The live line may tell from its own queue: the notices are views, changed on the main one.
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.heard(note) }
            return
        }
        if type == "session.new" {
            noteLogin(data)
        } else {
            refreshRecovery()
        }
    }

    /// One line for the notice: model and OS, else the device name (the server's `sessionLabel`).
    static func loginLabel(_ session: [String: Any]) -> String {
        var name = session["deviceModel"] as? String ?? ""
        if name.isEmpty { name = session["deviceName"] as? String ?? "" }
        if name.isEmpty { name = "Неизвестное устройство" }
        let system = session["osVersion"] as? String ?? ""
        return system.isEmpty ? name : name + " · " + system
    }

    /// A `session.new` packet: kept (newest first, at most five).
    func noteLogin(_ data: [String: Any]) {
        guard let session = data["session"] as? [String: Any], let id = session["id"] as? String else { return }
        var label = (data["label"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        if label.isEmpty { label = AccountNotices.loginLabel(session) }
        logins = [NewLogin(session: session, label: label, id: id)] + logins.filter { (login: NewLogin) -> Bool in login.id != id }
        if logins.count > 5 { logins = Array(logins.prefix(5)) }
        tell()
    }

    func dismissLogin(_ id: String) {
        let next = logins.filter { (login: NewLogin) -> Bool in login.id != id }
        guard next.count != logins.count else { return }
        logins = next
        tell()
    }

    func refreshRecovery() {
        guard let messenger else { return }
        revision += 1
        let asked = revision
        messenger.accountCall("recoveryRequests", []) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self, asked == self.revision else { return }
            switch result {
            case .success(let body):
                self.recovery = body["requests"] as? [[String: Any]] ?? []
                self.recoveryError = ""
            case .failure(let error):
                // Offline is not «не удалось проверить»: the last known requests stay, the next poll asks again.
                switch error {
                case .network, .timeout: return
                default: self.recoveryError = error.words
                }
            }
            self.tell()
        }
    }

    func cancelRecovery(_ id: String, done: @escaping (String?) -> Void) {
        guard let messenger else { done("Не удалось отменить запрос."); return }
        messenger.accountCall("cancelRecovery", [id]) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            switch result {
            case .success:
                self.revision += 1
                self.recovery = self.recovery.filter { (request: [String: Any]) -> Bool in request["id"] as? String != id }
                self.recoveryError = ""
                self.tell()
                self.refreshRecovery()
                done(nil)
            case .failure(let error):
                done(error.words.isEmpty ? "Не удалось отменить запрос." : error.words)
            }
        }
    }

    private var samples = false

    #if targetEnvironment(simulator)
    /// For the simulator check: sample notices without a server.
    func showSamples(login: Bool, recovery: Bool) {
        samples = true
        if login {
            noteLogin(["type": "session.new", "label": "iPhone 15 · iOS 18.1", "session": ["id": "sample-session", "deviceName": "iPhone", "deviceModel": "iPhone 15", "osVersion": "iOS 18.1", "platform": "ios", "appVersion": "0.17.0", "ip": "203.0.113.24", "createdAt": "2026-11-08T18:36:00.000Z"]])
        }
        if recovery {
            self.recovery = [["id": "sample-recovery", "deviceName": "Pixel 8", "createdAt": "2026-11-21T09:15:00.000Z", "readyAt": "2026-11-22T09:15:00.000Z"]]
            tell()
        }
    }
    #endif

    // MARK: Above the chat list

    /// Puts the notices under the heading of the chats; returns where the list begins below them.
    func place(in view: UIView, top: CGFloat, account: Bool) -> CGFloat {
        // Kept even while there is nothing to show: a notice that comes later lays this screen out again.
        host = view
        // The samples of the simulator check are the only notices without an account.
        guard account || samples else {
            if card.superview === view { card.removeFromSuperview() }
            return top
        }
        if card.superview !== view {
            card.onOpen = { [weak self, weak view] (kind: String) -> Void in
                guard let self, let view else { return }
                var screen: UIViewController? = nil
                var responder: UIResponder? = view
                while let current = responder {
                    if let found = current as? UIViewController { screen = found; break }
                    responder = current.next
                }
                if let screen { self.openSheet(kind, from: screen) }
            }
            view.addSubview(card)
        }
        let height = card.isHidden ? 0 : card.fittingHeight(width: view.bounds.width - 24)
        card.frame = CGRect(x: 12, y: top + 8, width: view.bounds.width - 24, height: height)
        return card.isHidden ? top : top + 8 + height + 6
    }

    func openSheet(_ kind: String, from screen: UIViewController) {
        let page: UIViewController
        if kind == "login" {
            guard let first = logins.first else { return }
            page = NewLoginSheet(login: first)
        } else {
            page = RecoverySheet()
        }
        let holder = UINavigationController(rootViewController: page)
        holder.setNavigationBarHidden(true, animated: false)
        if let sheet = holder.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        var top = screen
        while let shown = top.presentedViewController { top = shown }
        top.present(holder, animated: true)
    }
}

/// The two notices on glass, one under the other.
final class NoticeCards: UIView {
    var onOpen: ((String) -> Void)?
    private let stack = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { return nil }

    func fittingHeight(width: CGFloat) -> CGFloat {
        return stack.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height
    }

    func show(logins: [AccountNotices.NewLogin], recovery: [[String: Any]], error: String) {
        for old in stack.arrangedSubviews {
            stack.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        if !recovery.isEmpty {
            let line = NoticeLine(symbol: "ion:shield-outline", title: "Запрошено восстановление аккаунта", words: "Если это не ты — открой запрос и отмени смену пароля.")
            line.accessibilityLabel = "Запрошено восстановление аккаунта. Проверить запрос"
            line.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.onOpen?("recovery") }, for: .touchUpInside)
            stack.addArrangedSubview(line)
        } else if !error.isEmpty {
            let line = NoticeLine(symbol: "ion:alert-circle-outline", title: "Не удалось проверить запросы на восстановление аккаунта.", words: "Коснись, чтобы повторить.")
            line.addAction(UIAction { (_: UIAction) -> Void in AccountNotices.shared.refreshRecovery() }, for: .touchUpInside)
            stack.addArrangedSubview(line)
        }
        if let latest = logins.first {
            let more = logins.count > 1 ? "Ещё входов: \(logins.count - 1). " : ""
            let line = NoticeLine(symbol: NewLoginSheet.symbol(latest.session), title: "Новый вход: " + latest.label, words: more + "Если это был не ты — заверши сеанс.", oneLine: true)
            line.accessibilityLabel = "Новый вход: " + latest.label + ". Проверить"
            line.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.onOpen?("login") }, for: .touchUpInside)
            stack.addArrangedSubview(line)
        }
        isHidden = stack.arrangedSubviews.isEmpty
    }
}

/// One notice: a red icon, a bold line, a quiet line, an arrow; on glass with a radius of 18.
final class NoticeLine: UIControl {
    /// `oneLine`: the bold line stays on one line (the reference's «Новый вход», `numberOfLines={1}`); otherwise it
    /// wraps, as RecoveryNotice.tsx's title does.
    init(symbol: String, title: String, words: String, oneLine: Bool = false) {
        super.init(frame: .zero)
        let glass = UIVisualEffectView(effect: UIBlurEffect(style: Theme.dark ? .systemThinMaterialDark : .systemThinMaterialLight))
        glass.layer.cornerRadius = 18
        glass.layer.cornerCurve = .continuous
        glass.clipsToBounds = true
        glass.isUserInteractionEnabled = false
        glass.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glass)
        let icon = UIImageView(image: SettingsLook.symbol(symbol, size: symbol.hasPrefix("ion:") ? 22 : 18, weight: .medium)) // Ionicons, 22
        icon.tintColor = Theme.danger
        icon.contentMode = .center
        icon.setContentHuggingPriority(.required, for: .horizontal)
        let name = SettingsLook.words(title, size: 14, color: Theme.text, weight: .bold)
        name.numberOfLines = oneLine ? 1 : 0
        let about = SettingsLook.words(words, size: 12, color: Theme.muted)
        let texts = UIStackView(arrangedSubviews: [name, about])
        texts.axis = .vertical
        texts.spacing = 3
        let arrow = UIImageView(image: IonIcon.image("chevron-forward", size: 18))
        arrow.tintColor = Theme.muted
        arrow.setContentHuggingPriority(.required, for: .horizontal)
        let content = UIStackView(arrangedSubviews: [icon, texts, arrow])
        content.axis = .horizontal
        content.alignment = .center
        content.spacing = 12
        content.isUserInteractionEnabled = false
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            glass.topAnchor.constraint(equalTo: topAnchor),
            glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            glass.leadingAnchor.constraint(equalTo: leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -13),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 13),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -13),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 54),
        ])
        isAccessibilityElement = true
        accessibilityTraits.insert(.button)
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }
}

/// «Новый вход в аккаунт»: the device, its system, the app, the address the server saw, the time; «Это был не я —
/// завершить сеанс» ends that session on the server at once, «Это был я» hides the notice.
final class NewLoginSheet: SettingsPage {
    private let login: AccountNotices.NewLogin
    private var ended = false
    private var failure = ""
    private let endButton = SettingsButton(label: "Это был не я — завершить сеанс", kind: .danger, icon: "log-out-outline")

    init(login: AccountNotices.NewLogin) {
        self.login = login
        super.init(name: "Новый вход в аккаунт", large: true)
    }

    required init?(coder: NSCoder) { return nil }

    static func symbol(_ session: [String: Any]) -> String {
        let platform = session["platform"] as? String ?? ""
        let model = (session["deviceModel"] as? String ?? "").lowercased()
        let device = (session["deviceName"] as? String ?? "").lowercased()
        // The reference's `deviceIcon` (SecurityScreen.tsx): Ionicons names.
        if platform == "ios" || platform == "android" { return model.contains("ipad") || model.contains("tablet") ? "ion:tablet-portrait-outline" : "ion:phone-portrait-outline" }
        if platform == "web" { return "ion:globe-outline" }
        if platform == "windows" { return "ion:desktop-outline" }
        for word in ["android", "iphone", "ipad", "ios", "pixel", "galaxy"] where device.contains(word) { return "ion:phone-portrait-outline" }
        return "ion:desktop-outline"
    }

    private func value(_ name: String) -> String {
        let text = login.session[name] as? String ?? ""
        return text.isEmpty ? "—" : text
    }

    override func build() {
        clear()
        let session = login.session
        if ended {
            add(SettingsNotice("Сеанс завершён. На том устройстве понадобится снова ввести логин, пароль и слово подтверждения. Если пароль мог утечь — смени его в разделе «Безопасность»."), gap: 4)
        } else {
            add(SettingsLook.words("В твой аккаунт вошли с другого устройства. Данные об устройстве сообщает само приложение; адрес — такой, каким его увидел сервер. Через 10 минут после входа это устройство получит копию твоих переписок (зашифрованную только для него). Если это был не ты — заверши сеанс сейчас, и перенос не состоится.", size: 14, color: Theme.muted), gap: 4)
        }
        var device = session["deviceModel"] as? String ?? ""
        if device.isEmpty { device = value("deviceName") }
        let app = session["appVersion"] as? String ?? ""
        let rows: [(String, String)] = [
            ("Устройство", device),
            ("Система", value("osVersion")),
            ("Приложение", app.isEmpty ? "—" : "Инвиз " + app),
            ("IP-адрес", value("ip")),
            ("Вход", SettingsLook.moment(session["createdAt"] as? String)),
        ]
        var lines: [UIView] = [SettingsLook.inset(SettingsLook.words(login.label, size: 16, color: Theme.text, weight: .bold), top: 14, side: 14, bottom: 2)]
        for row in rows {
            let name = SettingsLook.words(row.0, size: 13, color: Theme.muted)
            name.widthAnchor.constraint(equalToConstant: 104).isActive = true
            let shown = SettingsLook.words(row.1, size: 13, color: Theme.text)
            let line = UIStackView(arrangedSubviews: [name, shown])
            line.axis = .horizontal
            line.spacing = 12
            line.alignment = .top
            lines.append(SettingsLook.inset(line, top: 4, side: 14, bottom: 4))
        }
        let card = UIStackView(arrangedSubviews: lines)
        card.axis = .vertical
        let box = SettingsLook.inset(card, top: 0, side: 0, bottom: 10)
        box.layer.cornerRadius = 18
        box.layer.borderWidth = 1
        box.layer.borderColor = ThemeStore.look.border.cgColor
        add(box, gap: 16)
        if !failure.isEmpty { add(SettingsNotice(failure, error: true), gap: 16) }
        if ended {
            let done = SettingsButton(label: "Понятно")
            done.onPress = { [weak self] in self?.dismiss(animated: true) }
            add(done, gap: 16)
            return
        }
        endButton.onPress = { [weak self] in self?.notMe() }
        add(endButton, gap: 16)
        let me = SettingsButton(label: "Это был я", kind: .secondary, icon: "checkmark-outline")
        me.onPress = { [weak self] in
            guard let self else { return }
            AccountNotices.shared.dismissLogin(self.login.id)
            self.dismiss(animated: true)
        }
        add(me, gap: 8)
        let all = UIButton(type: .system)
        all.setTitle("Все сеансы и устройства", for: .normal)
        all.setTitleColor(Theme.accent, for: .normal)
        all.titleLabel?.font = .systemFont(ofSize: 13, weight: .bold)
        all.addAction(UIAction { [weak self] (_: UIAction) -> Void in
            guard let self, let messenger = AccountNotices.shared.messenger else { return }
            self.navigationController?.pushViewController(SessionsViewController(messenger: messenger), animated: true)
        }, for: .touchUpInside)
        add(all, gap: 4)
    }

    private func notMe() {
        guard let messenger = AccountNotices.shared.messenger else { return }
        endButton.setBusy(true)
        failure = ""
        messenger.accountCall("revokeSession", [login.id]) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            self.endButton.setBusy(false)
            switch result {
            case .success:
                self.ended = true
                AccountNotices.shared.dismissLogin(self.login.id)
            case .failure(let error):
                self.failure = error.words.isEmpty ? "Не удалось завершить сеанс. Открой Безопасность → Сеансы." : error.words
            }
            self.build()
        }
    }
}

/// «Восстановление аккаунта»: the open requests, each with «Это не я — отменить».
final class RecoverySheet: SettingsPage {
    private var busy = ""
    private var failure = ""

    init() {
        super.init(name: "Восстановление аккаунта", large: true)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(self, selector: #selector(refill), name: AccountNotices.changed, object: nil)
    }

    @objc private func refill() { build() }

    private static let clock: DateFormatter = {
        let made = DateFormatter()
        made.locale = Locale(identifier: "ru_RU")
        made.dateFormat = "HH:mm"
        return made
    }()

    override func build() {
        clear()
        let notices = AccountNotices.shared
        add(SettingsLook.words("Другое устройство подтвердило слово восстановления. Пока пароль не изменён, ты можешь отменить запрос. Название устройства указано самим клиентом.", size: 14, color: Theme.muted), gap: 4)
        if !failure.isEmpty { add(SettingsNotice(failure, error: true), gap: 16) }
        if !notices.recoveryError.isEmpty {
            add(SettingsNotice("Список запросов не удалось обновить. Проверь подключение.", error: true, onRetry: { AccountNotices.shared.refreshRecovery() }), gap: 16)
        }
        for request in notices.recovery {
            guard let id = request["id"] as? String else { continue }
            var device = request["deviceName"] as? String ?? ""
            if device.isEmpty { device = "Новое устройство" }
            let asked = SettingsLook.longMomentWords(request["createdAt"] as? String)
            var ready = ""
            if let at = Messenger.date(request["readyAt"] as? String) { ready = RecoverySheet.clock.string(from: at) }
            let name = SettingsLook.words(device, size: 16, color: Theme.text, weight: .bold)
            let when = SettingsLook.words("Запрошено: " + asked + "\nСмена пароля разрешится после: " + ready, size: 13, color: Theme.muted)
            let cancel = SettingsButton(label: "Это не я — отменить", kind: .danger, icon: "close-circle-outline")
            cancel.onPress = { [weak self] in self?.cancel(id) }
            let card = UIStackView(arrangedSubviews: [name, when, cancel])
            card.axis = .vertical
            card.spacing = 10
            let box = SettingsLook.inset(card, top: 14, side: 14, bottom: 14)
            box.layer.cornerRadius = 18
            box.layer.borderWidth = 1
            box.layer.borderColor = ThemeStore.look.border.cgColor
            add(box, gap: 16)
            if busy == id { cancel.setBusy(true) } else if !busy.isEmpty { cancel.isEnabled = false }
        }
        if notices.recovery.isEmpty { add(SettingsNotice("Активных запросов на восстановление нет."), gap: 16) }
    }

    private func cancel(_ id: String) {
        guard busy.isEmpty else { return }
        busy = id
        failure = ""
        build()
        AccountNotices.shared.cancelRecovery(id) { [weak self] (problem: String?) -> Void in
            guard let self else { return }
            self.busy = ""
            self.failure = problem ?? ""
            self.build()
        }
    }
}
