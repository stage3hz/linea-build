import UIKit

/// What a session of the list says about itself, in the words of `mobile/src/SecurityScreen.tsx` and
/// `mobile/src/sessionAlerts.ts`.
enum SessionWords {
    private static func text(_ session: [String: Any], _ name: String) -> String {
        return session[name] as? String ?? ""
    }

    static func isCurrent(_ session: [String: Any]) -> Bool {
        return session["isCurrent"] as? Bool ?? false
    }

    /// The model, else the name the app gave the device; `otherwise` when the server has neither.
    static func name(_ session: [String: Any], otherwise: String) -> String {
        let model = text(session, "deviceModel")
        if !model.isEmpty { return model }
        let device = text(session, "deviceName")
        return device.isEmpty ? otherwise : device
    }

    /// «iPhone · iOS 18.1»: one line for a question about the session.
    static func loginLabel(_ session: [String: Any]) -> String {
        let device = name(session, otherwise: "Неизвестное устройство")
        let system = text(session, "osVersion")
        return system.isEmpty ? device : device + " · " + system
    }

    /// «iOS 18.1 · Инвиз 0.14.13», without the parts the server has no data for.
    static func subtitle(_ session: [String: Any]) -> String {
        var parts: [String] = []
        let system = text(session, "osVersion")
        if !system.isEmpty { parts.append(system) }
        let app = text(session, "appVersion")
        if !app.isEmpty { parts.append("Инвиз " + app) }
        return parts.joined(separator: " · ")
    }

    private static func mentions(_ words: String, _ needles: [String]) -> Bool {
        let low = words.lowercased()
        for needle in needles where low.contains(needle) { return true }
        return false
    }

    /// The icon of the device's kind: the reference's `deviceIcon` (SecurityScreen.tsx), an Ionicons name with "ion:".
    static func symbol(_ session: [String: Any]) -> String {
        let platform = text(session, "platform")
        if platform == "ios" || platform == "android" {
            return mentions(text(session, "deviceModel"), ["ipad", "tablet"]) ? "ion:tablet-portrait-outline" : "ion:phone-portrait-outline"
        }
        if platform == "web" { return "ion:globe-outline" }
        if platform == "windows" { return "ion:desktop-outline" }
        return mentions(text(session, "deviceName"), ["android", "iphone", "ipad", "ios", "pixel", "galaxy"]) ? "ion:phone-portrait-outline" : "ion:desktop-outline"
    }

    /// This device first, then the newest sign-ins.
    static func ordered(_ sessions: [[String: Any]]) -> [[String: Any]] {
        func time(_ session: [String: Any]) -> TimeInterval {
            return Messenger.date(session["createdAt"] as? String)?.timeIntervalSince1970 ?? 0
        }
        var current: [[String: Any]] = []
        var others: [[String: Any]] = []
        for session in sessions {
            if isCurrent(session) { current.append(session) } else { others.append(session) }
        }
        current.sort { time($0) > time($1) }
        others.sort { time($0) > time($1) }
        return current + others
    }

    static func address(_ session: [String: Any]) -> String {
        return text(session, "ip")
    }
}

/// «Активные сеансы»: where the account is signed in, with the way to end one session or all the others.
final class SessionsViewController: SettingsPage {
    private let messenger: Messenger
    private var sessions: [[String: Any]] = []
    private var loaded = false
    private var loading = false
    private var busy = false
    private var failure = ""
    private var notice = ""
    private var request = 0
    #if targetEnvironment(simulator)
    /// For the simulator check: the details of the first session open by themselves once the list is here.
    var opensFirstWhenLoaded = false
    #endif

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Активные сеансы")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        setSide(symbol: "ion:refresh-outline", label: "Обновить список сеансов") { [weak self] in
            guard let self, !self.busy, !self.loading else { return }
            self.refresh()
        }
        refresh()
    }

    private func refresh() {
        request += 1
        let mine = request
        loading = true
        failure = ""
        fill()
        messenger.accountCall("sessions", []) { [weak self] result in
            guard let self, mine == self.request else { return }
            self.loading = false
            switch result {
            case .success(let body):
                self.sessions = SessionWords.ordered(body["sessions"] as? [[String: Any]] ?? [])
                self.loaded = true
            case .failure(let error):
                if error.refusalStatus == 401 {
                    self.closeAccount(notice: self.messenger.sessionEndedHere("Сессия завершилась. Войди в аккаунт снова."))
                    return
                }
                if error.refusalStatus == 404 {
                    self.failure = "Сервер ещё не поддерживает настройки безопасности. Обнови сервер Инвиза до версии 0.3.0."
                } else {
                    self.failure = error.words.isEmpty ? "Не удалось загрузить настройки безопасности." : error.words
                }
            }
            self.fill()
            #if targetEnvironment(simulator)
            if self.opensFirstWhenLoaded, let first = self.sessions.first {
                self.opensFirstWhenLoaded = false
                self.showDetails(first, animated: false)
            }
            #endif
        }
    }

    private func fill() {
        clear()
        setSideEnabled(!busy && !loading)
        add(SettingsLook.foot("Здесь показаны действующие входы: устройство, система, версия приложения и IP-адрес, с которого выполнен вход. Нажми на сеанс, чтобы увидеть подробности или завершить его."), gap: 4)
        if !failure.isEmpty { add(SettingsNotice(failure, error: true, onRetry: { [weak self] in self?.refresh() }), gap: 12) }
        if !notice.isEmpty { add(SettingsNotice(notice), gap: 12) }
        if !loaded {
            if loading { add(SettingsLook.foot("Загружаем настройки…"), gap: 16) }
            return
        }
        let current = sessions.filter { SessionWords.isCurrent($0) }
        let others = sessions.filter { !SessionWords.isCurrent($0) }
        if !current.isEmpty { addGroup(rows: current.map { row($0) }) }

        // «Завершить все другие сеансы» sits between this device and the other sessions.
        let endOthers = SettingsButton(label: "Завершить все другие сеансы", kind: .danger, icon: "log-out-outline")
        endOthers.isEnabled = !busy && !others.isEmpty
        endOthers.onPress = { [weak self] in self?.askToEndOthers() }
        add(endOthers, gap: 14)

        if !others.isEmpty { addGroup("Другие устройства", rows: others.map { row($0) }) }
        if sessions.isEmpty && !loading { add(SettingsLook.foot("Действующие сеансы не найдены."), gap: 14) }
        add(SettingsLook.foot("Если ты видишь вход, которого не делал, заверши его и смени пароль. IP-адрес показан как есть, местоположение по нему не определяется."), gap: 16)
    }

    private func row(_ session: [String: Any]) -> UIView {
        let current = SessionWords.isCurrent(session)
        let made = SessionRow(session: session)
        made.isEnabled = !busy
        made.accessibilityLabel = "Сеанс: " + SessionWords.loginLabel(session) + (current ? ", это устройство" : "") + ". Подробности"
        made.onPress = { [weak self] in self?.showDetails(session, animated: true) }
        return made
    }

    private func showDetails(_ session: [String: Any], animated: Bool) {
        let page = SessionDetailViewController(session: session) { [weak self] detail in
            self?.end(session, from: detail)
        }
        navigationController?.pushViewController(page, animated: animated)
    }

    private func askToEndOthers() {
        guard !busy else { return }
        confirm(heading: "Завершить все другие сеансы?",
                words: "Этот сеанс останется открытым. На остальных устройствах понадобится снова ввести логин, пароль и слово подтверждения.",
                action: "Завершить") { [weak self] in self?.endOthers() }
    }

    private func endOthers() {
        guard !busy else { return }
        busy = true
        failure = ""
        notice = ""
        fill()
        messenger.accountCall("revokeOtherSessions", []) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success:
                self.notice = "Все другие сеансы завершены."
                self.refresh()
            case .failure(let error):
                self.failure = error.words.isEmpty ? "Не удалось завершить сеанс." : error.words
                self.fill()
            }
        }
    }

    /// Ends one session, asked from its page of details.
    private func end(_ session: [String: Any], from detail: SessionDetailViewController) {
        guard !busy, let id = session["id"] as? String else { return }
        let current = SessionWords.isCurrent(session)
        busy = true
        failure = ""
        notice = ""
        detail.setBusy(true)
        messenger.accountCall("revokeSession", [id]) { [weak self, weak detail] result in
            guard let self else { return }
            self.busy = false
            detail?.setBusy(false)
            switch result {
            case .success:
                if current {
                    self.closeAccount(notice: self.messenger.sessionEndedHere("Сеанс на этом устройстве завершён. Войди снова, чтобы продолжить."))
                    return
                }
                self.notice = "Выбранный сеанс завершён."
                self.navigationController?.popToViewController(self, animated: true)
                self.refresh()
            case .failure(let error):
                self.failure = error.words.isEmpty ? "Не удалось завершить сеанс." : error.words
                self.navigationController?.popToViewController(self, animated: true)
                self.fill()
            }
        }
    }
}

/// One session in the list: the device's icon, its model, the system and the app's version, the address and
/// the last activity.
final class SessionRow: UIControl {
    var onPress: (() -> Void)?

    init(session: [String: Any]) {
        super.init(frame: .zero)
        let current = SessionWords.isCurrent(session)
        // The reference's `SessionRow`: a 42 square of `accentSoft`, radius 16, the glyph 23 in the accent.
        let icon = UIImageView(image: SettingsLook.symbol(SessionWords.symbol(session), size: 23))
        icon.tintColor = Theme.accent
        icon.contentMode = .center
        icon.backgroundColor = ThemeStore.look.accentSoft
        icon.layer.cornerRadius = 16
        icon.layer.cornerCurve = .continuous
        icon.layer.masksToBounds = true
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 42).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 42).isActive = true

        let name = SettingsLook.words(SessionWords.name(session, otherwise: "Устройство"), size: 14, color: Theme.text, weight: .bold)
        name.numberOfLines = 1
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let top = UIStackView(arrangedSubviews: [name])
        top.axis = .horizontal
        top.alignment = .center
        top.spacing = 8
        if current {
            let mark = PaddedLabel()
            mark.text = "Это устройство"
            mark.font = .systemFont(ofSize: 10, weight: .bold)
            mark.textColor = Theme.accent
            mark.backgroundColor = ThemeStore.look.accentSoft
            mark.layer.cornerRadius = 8
            mark.layer.masksToBounds = true
            mark.setContentHuggingPriority(.required, for: .horizontal)
            mark.setContentCompressionResistancePriority(.required, for: .horizontal)
            top.addArrangedSubview(mark)
        }
        let filler = UIView()
        filler.setContentHuggingPriority(.defaultLow, for: .horizontal)
        top.addArrangedSubview(filler)
        name.setContentHuggingPriority(.required, for: .horizontal)

        let texts = UIStackView(arrangedSubviews: [top])
        texts.axis = .vertical
        texts.spacing = 3
        let subtitle = SessionWords.subtitle(session)
        if !subtitle.isEmpty {
            let line = SettingsLook.words(subtitle, size: 12, color: Theme.muted)
            line.numberOfLines = 1
            texts.addArrangedSubview(line)
        }
        let address = SessionWords.address(session)
        let seen = current ? "в сети" : SettingsLook.moment(session["lastActiveAt"] as? String)
        let last = SettingsLook.words((address.isEmpty ? "" : address + " · ") + seen, size: 11, color: Theme.subtle)
        last.numberOfLines = 1
        texts.addArrangedSubview(last)

        let chevron = UIImageView(image: IonIcon.image("chevron-forward", size: 18))
        chevron.tintColor = Theme.subtle
        chevron.contentMode = .center
        chevron.setContentHuggingPriority(.required, for: .horizontal)
        chevron.setContentCompressionResistancePriority(.required, for: .horizontal)

        let content = UIStackView(arrangedSubviews: [icon, texts, chevron])
        content.axis = .horizontal
        content.alignment = .center
        content.spacing = 12
        content.isUserInteractionEnabled = false
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -13),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
        ])
        isAccessibilityElement = true
        accessibilityTraits.insert(.button)
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? SettingsLook.pressed : .clear }
    }

    override var isEnabled: Bool {
        didSet { alpha = isEnabled ? 1 : 0.5 }
    }

    @objc private func pressed() {
        onPress?()
    }
}

/// The details of one session, and the button that ends it.
final class SessionDetailViewController: SettingsPage {
    private let session: [String: Any]
    private let onEnd: (SessionDetailViewController) -> Void
    private let endButton: SettingsButton

    init(session: [String: Any], onEnd: @escaping (SessionDetailViewController) -> Void) {
        self.session = session
        self.onEnd = onEnd
        let current = SessionWords.isCurrent(session)
        endButton = SettingsButton(label: current ? "Выйти на этом устройстве" : "Завершить сеанс", kind: .danger, icon: "log-out-outline")
        super.init(name: current ? "Это устройство" : "Сеанс")
    }

    required init?(coder: NSCoder) { return nil }

    func setBusy(_ busy: Bool) {
        endButton.setBusy(busy)
    }

    private func detail(_ label: String, _ value: String) -> UIView {
        let name = SettingsLook.words(label, size: 13, color: Theme.muted)
        name.translatesAutoresizingMaskIntoConstraints = false
        name.widthAnchor.constraint(equalToConstant: 132).isActive = true
        let words = SettingsLook.words(value, size: 13, color: Theme.text)
        let row = UIStackView(arrangedSubviews: [name, words])
        row.axis = .horizontal
        row.alignment = .top
        row.spacing = 12
        row.isAccessibilityElement = true
        row.accessibilityLabel = label + ": " + value
        return SettingsLook.inset(row, top: 10, side: 14, bottom: 10)
    }

    override func build() {
        let current = SessionWords.isCurrent(session)
        // The reference's sheet: a 48 square of `accentSoft`, radius 18, the glyph 26 in the accent.
        let icon = UIImageView(image: SettingsLook.symbol(SessionWords.symbol(session), size: 26))
        icon.tintColor = Theme.accent
        icon.contentMode = .center
        icon.backgroundColor = ThemeStore.look.accentSoft
        icon.layer.cornerRadius = 18
        icon.layer.cornerCurve = .continuous
        icon.layer.masksToBounds = true
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 48).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 48).isActive = true
        let texts = UIStackView(arrangedSubviews: [
            SettingsLook.words(SessionWords.name(session, otherwise: "Устройство"), size: 17, color: Theme.text, weight: .heavy),
            SettingsLook.words(current ? "Текущий сеанс на этом устройстве" : "Действующий сеанс на другом устройстве", size: 12, color: Theme.muted),
        ])
        texts.axis = .vertical
        texts.spacing = 3
        let head = UIStackView(arrangedSubviews: [icon, texts])
        head.axis = .horizontal
        head.alignment = .center
        head.spacing = 12
        add(SettingsLook.inset(head, top: 4, side: 2, bottom: 0), gap: 4)

        let app = session["appVersion"] as? String ?? ""
        let system = session["osVersion"] as? String ?? ""
        let address = SessionWords.address(session)
        addGroup(rows: [
            detail("Устройство", SessionWords.name(session, otherwise: "—")),
            detail("Система", system.isEmpty ? "—" : system),
            detail("Приложение", app.isEmpty ? "—" : "Инвиз " + app),
            detail("IP-адрес", address.isEmpty ? "—" : address),
            detail("Первый вход", SettingsLook.moment(session["createdAt"] as? String)),
            detail("Последняя активность", current ? "Сейчас" : SettingsLook.moment(session["lastActiveAt"] as? String)),
            detail("Действует до", SettingsLook.moment(session["expiresAt"] as? String)),
        ])
        add(SettingsLook.foot(current
            ? "Выход завершит сеанс на этом устройстве. Переписка останется на сервере."
            : "После завершения на том устройстве понадобится снова ввести логин, пароль и слово подтверждения. Название и версии сообщает само приложение; IP-адрес показан как есть."), gap: 12)
        endButton.onPress = { [weak self] in
            guard let self else { return }
            self.onEnd(self)
        }
        add(endButton, gap: 18)
    }
}

/// «Заблокированные»: the people who cannot write to the account, with the way to let one back.
/// (The previous app: the first card of `mobile/src/AccountZone.tsx`.)
final class BlockedViewController: SettingsPage {
    private let messenger: Messenger
    private var people: [[String: Any]]?
    private var failure = ""
    private var busyId = ""

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Заблокированные")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        messenger.prepareSettingsAvatars()
        load()
    }

    private func load() {
        failure = ""
        fill()
        messenger.accountCall("blocks", []) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let body): self.people = body["users"] as? [[String: Any]] ?? []
            case .failure(let error): self.failure = error.words.isEmpty ? "Не удалось загрузить список." : error.words
            }
            self.fill()
        }
    }

    private func fill() {
        clear()
        if !failure.isEmpty {
            var retry: (() -> Void)? = nil
            if people == nil { retry = { [weak self] in self?.load() } }
            add(SettingsNotice(failure, error: true, onRetry: retry), gap: 4)
        }
        guard let people else {
            if failure.isEmpty { add(SettingsLook.foot("Загрузка…"), gap: 16) }
            return
        }
        if people.isEmpty {
            add(SettingsLook.foot("Никого нет. Заблокировать можно в профиле собеседника через «⋯»."), gap: 16)
            return
        }
        addGroup(rows: people.map { person($0) })
    }

    private func person(_ user: [String: Any]) -> UIView {
        let id = user["id"] as? String ?? ""
        let ball = SettingsAvatar(frame: CGRect(x: 0, y: 0, width: 40, height: 40))
        ball.show(user, base: messenger.server.endpoint)
        ball.translatesAutoresizingMaskIntoConstraints = false
        ball.widthAnchor.constraint(equalToConstant: 40).isActive = true
        ball.heightAnchor.constraint(equalToConstant: 40).isActive = true
        let name = SettingsLook.words(user["displayName"] as? String ?? "", size: 15, color: Theme.text, weight: .semibold)
        name.numberOfLines = 1
        let handle = SettingsLook.words("@" + (user["username"] as? String ?? ""), size: 12, color: Theme.muted)
        handle.numberOfLines = 1
        let texts = UIStackView(arrangedSubviews: [name, handle])
        texts.axis = .vertical
        texts.spacing = 2
        texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let free = BlockedButton(userId: id)
        free.setTitle("Разблокировать", for: .normal)
        free.setTitleColor(Theme.text, for: .normal)
        free.setTitleColor(Theme.subtle, for: .disabled)
        free.setTitleColor(Theme.muted, for: .highlighted)
        free.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        free.isEnabled = busyId.isEmpty
        free.setContentHuggingPriority(.required, for: .horizontal)
        free.setContentCompressionResistancePriority(.required, for: .horizontal)
        free.addTarget(self, action: #selector(unblockPressed(_:)), for: .touchUpInside)
        let row = UIStackView(arrangedSubviews: [ball, texts, free])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 12
        return SettingsLook.inset(row, top: 10, side: 14, bottom: 10)
    }

    @objc private func unblockPressed(_ sender: BlockedButton) {
        let id = sender.userId
        guard busyId.isEmpty, !id.isEmpty else { return }
        busyId = id
        failure = ""
        fill()
        messenger.accountCall("unblock", [id]) { [weak self] result in
            guard let self else { return }
            self.busyId = ""
            switch result {
            case .success:
                self.people = (self.people ?? []).filter { $0["id"] as? String != id }
            case .failure(let error):
                // The row stays; the person is told why.
                self.failure = error.words.isEmpty ? "Не удалось разблокировать." : error.words
            }
            self.fill()
        }
    }
}

/// The «Разблокировать» button of one person.
final class BlockedButton: UIButton {
    let userId: String

    init(userId: String) {
        self.userId = userId
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { return nil }
}
