import UIKit

/// «Безопасность и устройства» — the reference's SecurityScreen.tsx with its AccountZone.tsx, on one page: the header
/// pill (clear glass, radius 27, the shield at the right), the intro card, the password and the two secret words, the
/// sessions and devices, the blocked people and «Удалить аккаунт», each on a glass card of radius 28.
final class SecurityViewController: SettingsPage {
    private let messenger: Messenger
    private var status: [String: Any]?
    private var loading = true
    private var failure = ""
    private var notice = ""
    private var request = 0
    private var sessions: [[String: Any]] = []
    private var busy = false
    private var blocked: [[String: Any]]?
    private var unblocking = ""

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Безопасность")
    }

    required init?(coder: NSCoder) { return nil }

    override var ownLook: OwnLook? {
        // `marginHorizontal: 14`, `padding: 10`, `minHeight: 68`, the name 20 Bold with letter spacing −0.5, the
        // shield-checkmark-outline 23 in the accent with 10 to its right; the list 17 from the sides, 17 under the
        // pill's 2 of margin, 36 at the end.
        return OwnLook(side: 14, padding: 10, minHeight: 68, clear: true, titleFont: .systemFont(ofSize: 20, weight: .bold), titleKern: -0.5,
                       mark: "shield-checkmark-outline", markSize: 23, markRoom: 10, backLabel: "Назад в профиль",
                       columnSide: 17, columnTop: 17, columnBottom: 36)
    }

    override func build() {
        messenger.prepareSettingsAvatars()
        load()
        loadBlocked()
    }

    private func load() {
        request += 1
        let mine = request
        loading = true
        failure = ""
        fill()
        let group = DispatchGroup()
        var security: Result<[String: Any], ServerError>?
        var list: Result<[String: Any], ServerError>?
        group.enter()
        messenger.accountCall("security", []) { (result: Result<[String: Any], ServerError>) -> Void in security = result; group.leave() }
        group.enter()
        messenger.accountCall("sessions", []) { (result: Result<[String: Any], ServerError>) -> Void in list = result; group.leave() }
        group.notify(queue: .main) { [weak self] in
            guard let self, mine == self.request else { return }
            self.loading = false
            switch (security, list) {
            case (.success(let body)?, .success(let found)?):
                self.status = body
                self.sessions = SessionWords.ordered(found["sessions"] as? [[String: Any]] ?? [])
            case (.failure(let error)?, _), (_, .failure(let error)?):
                if error.refusalStatus == 401 {
                    self.closeAccount(notice: self.messenger.sessionEndedHere("Сессия завершилась. Войди в аккаунт снова."))
                    return
                }
                self.failure = error.refusalStatus == 404
                    ? "Сервер ещё не поддерживает настройки безопасности. Обнови сервер Инвиза до версии 0.3.0."
                    : (error.words.isEmpty ? "Не удалось загрузить настройки безопасности." : error.words)
            default: break
            }
            self.fill()
        }
    }

    private func loadBlocked() {
        messenger.accountCall("blocks", []) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            if case .success(let body) = result { self.blocked = body["users"] as? [[String: Any]] ?? [] } else { self.blocked = [] }
            self.fill()
        }
    }

    /// The name of a secret word and whether it is set up: a 42 square of `accentSoft` (radius 16) with
    /// checkmark-circle-outline / key-outline 25 in the accent, 11 to the name (15 Bold) and the state (12) 4 under it.
    private func wordState(_ name: String, configured: Bool) -> UIView {
        let icon = UIImageView(image: IonIcon.image(configured ? "checkmark-circle-outline" : "key-outline", size: 25))
        icon.tintColor = Theme.accent
        icon.contentMode = .center
        icon.backgroundColor = ThemeStore.look.accentSoft
        icon.layer.cornerRadius = 16
        icon.layer.cornerCurve = .continuous
        icon.layer.masksToBounds = true
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 42).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 42).isActive = true
        let texts = UIStackView(arrangedSubviews: [
            SettingsLook.words(name, size: 15, color: Theme.text, weight: .bold),
            SettingsLook.words(configured ? "Настроено" : "Пока не настроено", size: 12, color: configured ? Theme.accent : Theme.muted),
        ])
        texts.axis = .vertical
        texts.spacing = 4
        let row = UIStackView(arrangedSubviews: [icon, texts])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 11
        return row
    }

    private func fill() {
        clear()
        add(SettingsLook.glassCard([
            SettingsLook.para("Твой доступ.\nТвои устройства.", size: 23, color: Theme.text, weight: .heavy, line: 28, kern: -0.7),
            SettingsLook.para("Вход по логину (тайному, не @имени), паролю и слову подтверждения. Для восстановления — другое слово. Почта и номер телефона не нужны.", size: 13, color: Theme.muted, line: 20),
        ], radius: 28, padding: 22, gap: 11, clear: true), gap: 0)
        if !failure.isEmpty { add(SettingsNotice(failure, error: true, onRetry: { [weak self] in if self?.busy == false { self?.load() } }), gap: 16) }
        if !notice.isEmpty { add(SettingsNotice(notice), gap: 16) }
        if loading && status == nil {
            // `padding: 30`, the spinner and «Загружаем настройки…» (13, `muted`) 12 apart, centred.
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.color = Theme.accent
            spinner.startAnimating()
            let words = SettingsLook.para("Загружаем настройки…", size: 13, color: Theme.muted, centered: true)
            let box = UIStackView(arrangedSubviews: [spinner, words])
            box.axis = .vertical
            box.alignment = .center
            box.spacing = 12
            add(SettingsLook.inset(box, top: 30, side: 30, bottom: 30), gap: 16)
        }
        if let status { fillStatus(status) }
        // The closing words: 11, line 17, `subtle`, centred, 10 in from the sides.
        add(SettingsLook.inset(SettingsLook.para("Выбирай два разных непредсказуемых слова. Они должны отличаться друг от друга, логина и пароля. Все значения здесь вводятся вручную.", size: 11, color: Theme.subtle, line: 17, centered: true), top: 0, side: 10, bottom: 0), gap: 16)
    }

    private func fillStatus(_ status: [String: Any]) {
        let confirmationConfigured = status["confirmationConfigured"] as? Bool ?? false
        let recoveryConfigured = status["recoveryConfigured"] as? Bool ?? false
        if !confirmationConfigured || !recoveryConfigured {
            add(SettingsNotice("Заверши настройку двух слов. В старом аккаунте недостающие слова можно добавить, пока помнишь пароль."), gap: 16)
        }

        // «Пароль»: padding 20, gap 16.
        let lockIcon = UIImageView(image: IonIcon.image("lock-closed-outline", size: 23))
        lockIcon.tintColor = Theme.accent
        lockIcon.contentMode = .center
        lockIcon.setContentHuggingPriority(.required, for: .horizontal)
        let passwordLine = UIStackView(arrangedSubviews: [lockIcon, SettingsLook.para("Можно использовать длинную фразу. После смены пароля все сеансы завершатся.", size: 13, color: Theme.muted, line: 20)])
        passwordLine.axis = .horizontal
        passwordLine.alignment = .center
        passwordLine.spacing = 12
        let password = SettingsButton(label: "Изменить пароль", kind: .secondary, icon: "key-outline")
        password.isEnabled = !busy
        password.onPress = { [weak self] in self?.openForm(.password, confirmationConfigured) }
        add(SettingsLook.glassCard([SettingsLook.sectionLabel("Пароль"), passwordLine, password], gap: 16, labelled: true), gap: 16)

        let confirmation = SettingsButton(label: confirmationConfigured ? "Изменить слово подтверждения" : "Настроить слово подтверждения", kind: .secondary, icon: "key-outline")
        confirmation.isEnabled = !busy
        confirmation.onPress = { [weak self] in self?.openForm(.confirmation, confirmationConfigured) }
        add(SettingsLook.glassCard([
            SettingsLook.sectionLabel("Подтверждение входа"),
            wordState("Слово подтверждения", configured: confirmationConfigured),
            SettingsLook.para("Это слово нужно при каждом входе после пароля. Посмотреть его повторно нельзя.", size: 13, color: Theme.muted, line: 20),
            confirmation,
        ], gap: 15, labelled: true), gap: 16)

        // The limit: radius 17, padding 13, gap 5, `accentSoft`.
        let limitBox = UIStackView(arrangedSubviews: [
            SettingsLook.words("3 попытки → 24 часа ожидания", size: 12, color: Theme.text, weight: .bold),
            SettingsLook.para("Ограничение действует на сервере и относится только к восстановлению. Вход с паролем и словом подтверждения остаётся доступен.", size: 12, color: Theme.muted, line: 18),
        ])
        limitBox.axis = .vertical
        limitBox.spacing = 5
        let limit = SettingsLook.inset(limitBox, top: 13, side: 13, bottom: 13)
        limit.backgroundColor = ThemeStore.look.accentSoft
        limit.layer.cornerRadius = 17
        limit.layer.cornerCurve = .continuous
        let recovery = SettingsButton(label: recoveryConfigured ? "Изменить слово восстановления" : "Настроить слово восстановления", kind: .secondary, icon: "key-outline")
        recovery.isEnabled = !busy
        recovery.onPress = { [weak self] in self?.openForm(.recovery, confirmationConfigured) }
        add(SettingsLook.glassCard([
            SettingsLook.sectionLabel("Восстановление доступа"),
            wordState("Слово восстановления", configured: recoveryConfigured),
            SettingsLook.para(recoveryConfigured
                ? "Отдельное слово для случая, когда пароль забыт. После его проверки действует 10-минутное ожидание. Открытые сеансы могут отменить запрос."
                : "Настрой слово сейчас, пока помнишь пароль. Без слова восстановления вернуть доступ через этот экран не получится.", size: 13, color: Theme.muted, line: 20),
            limit,
            recovery,
        ], gap: 15, labelled: true), gap: 16)

        add(sessionsCard(), gap: 16)
        // HistorySection.tsx stands here (between the sessions and AccountZone): its own page in this app
        // (Settings/HistorySettings.swift), reached from a card with the reference's section name.
        let history = SettingsRow(symbol: "ion:cloud-download-outline", label: "Переписки на новом устройстве")
        history.onPress = { [weak self] in
            guard let self else { return }
            self.open(HistoryViewController(messenger: self.messenger))
        }
        add(SettingsLook.glassCard([SettingsLook.inset(SettingsLook.sectionLabel("Переписки на новом устройстве"), top: 14, side: 14, bottom: 0), history], padding: 6, gap: 13), gap: 16)
        add(blockedCard(), gap: 16)
        add(deleteCard(confirmationConfigured), gap: 16)
    }

    // MARK: «Сеансы и устройства»

    private func sessionsCard() -> UIView {
        // The label with the refresh IconButton (19) at the right, 8 apart.
        // The label keeps its 13 of margin under it inside the row (the row is as tall as the 44 button, centred).
        let label = SettingsLook.inset(SettingsLook.sectionLabel("Сеансы и устройства"), top: 0, side: 0, bottom: 13)
        let refresh = GlassRoundButton(symbol: "ion:refresh-outline", label: "Обновить список сеансов", iconSize: 19)
        refresh.isEnabled = !busy && !loading
        refresh.onPress = { [weak self] in
            guard let self, !self.busy, !self.loading else { return }
            self.load()
        }
        refresh.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([refresh.widthAnchor.constraint(equalToConstant: 44), refresh.heightAnchor.constraint(equalToConstant: 44)])
        let head = UIStackView(arrangedSubviews: [label, refresh])
        head.axis = .horizontal
        head.alignment = .center
        head.spacing = 8
        var parts: [UIView] = [head, SettingsLook.para("Здесь показаны действующие входы: устройство, система, версия приложения и IP-адрес, с которого выполнен вход. Нажми на сеанс, чтобы увидеть подробности или завершить его.", size: 12, color: Theme.muted, line: 18)]
        let current = sessions.filter { SessionWords.isCurrent($0) }
        let others = sessions.filter { !SessionWords.isCurrent($0) }
        for session in current { parts.append(row(session, first: true)) }
        // «Завершить все другие сеансы» sits between this device and the other sessions.
        let endOthers = SettingsButton(label: "Завершить все другие сеансы", kind: .danger, icon: "log-out-outline")
        endOthers.isEnabled = !busy && !others.isEmpty
        endOthers.onPress = { [weak self] in self?.askToEndOthers() }
        parts.append(endOthers)
        var otherLabel: UIView?
        if !others.isEmpty {
            let made = SettingsLook.sectionLabel("Другие устройства")
            otherLabel = made
            parts.append(made)
        }
        for (index, session) in others.enumerated() { parts.append(row(session, first: index == 0)) }
        if sessions.isEmpty && !loading { parts.append(SettingsLook.words("Действующие сеансы не найдены.", size: 13, color: Theme.muted)) }
        if loading && status != nil {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.color = Theme.accent
            spinner.startAnimating()
            parts.append(spinner)
        }
        parts.append(SettingsLook.para("Если ты видишь вход, которого не делал, заверши его и смени пароль. IP-адрес показан как есть, местоположение по нему не определяется.", size: 11, color: Theme.subtle, line: 16))
        // The card's own 15 between the parts; «Другие устройства» (a SectionLabel) has its 13 of margin below it too.
        let card = SettingsLook.glassCard(parts, gap: 15)
        if let others = otherLabel, let stack = card.subviews.compactMap({ (view: UIView) -> UIStackView? in view as? UIStackView }).first {
            stack.setCustomSpacing(15 + 13, after: others)
        }
        return card
    }

    private func row(_ session: [String: Any], first: Bool) -> UIView {
        let current = SessionWords.isCurrent(session)
        let made = SessionRow(session: session, plain: true, first: first)
        made.isEnabled = !busy
        made.accessibilityLabel = "Сеанс: " + SessionWords.loginLabel(session) + (current ? ", это устройство" : "") + ". Подробности"
        made.onPress = { [weak self] in self?.showDetails(session) }
        return made
    }

    private func showDetails(_ session: [String: Any]) {
        let page = SessionDetailViewController(session: session) { [weak self] (detail: SessionDetailViewController) -> Void in
            self?.end(session, from: detail)
        }
        navigationController?.pushViewController(page, animated: true)
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
        messenger.accountCall("revokeOtherSessions", []) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success:
                self.notice = "Все другие сеансы завершены."
                self.load()
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
        messenger.accountCall("revokeSession", [id]) { [weak self, weak detail] (result: Result<[String: Any], ServerError>) -> Void in
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
                self.load()
            case .failure(let error):
                self.failure = error.words.isEmpty ? "Не удалось завершить сеанс." : error.words
                self.navigationController?.popToViewController(self, animated: true)
                self.fill()
            }
        }
    }

    // MARK: AccountZone.tsx — «Заблокированные» and «Удалить аккаунт»

    private func blockedCard() -> UIView {
        var parts: [UIView] = [SettingsLook.sectionLabel("Заблокированные")]
        if let blocked {
            if blocked.isEmpty {
                parts.append(SettingsLook.words("Никого нет. Заблокировать можно в профиле собеседника через «⋯».", size: 13, color: Theme.muted))
            } else {
                for user in blocked { parts.append(person(user)) }
            }
        } else {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.color = Theme.accent
            spinner.startAnimating()
            parts.append(spinner)
        }
        return SettingsLook.glassCard(parts, gap: 12, labelled: true)
    }

    /// One blocked person: the avatar 40, 12 to the name (15 SemiBold) and @username (12, `muted`), «Разблокировать»
    /// (14 SemiBold, the accent) at the right.
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
        texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let free = UIButton(type: .system)
        free.setTitle("Разблокировать", for: .normal)
        free.setTitleColor(Theme.accent, for: .normal)
        free.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        free.isEnabled = unblocking.isEmpty
        free.setContentHuggingPriority(.required, for: .horizontal)
        free.setContentCompressionResistancePriority(.required, for: .horizontal)
        free.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.unblock(id) }, for: .touchUpInside)
        let row = UIStackView(arrangedSubviews: [ball, texts, free])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 12
        return row
    }

    private func unblock(_ id: String) {
        guard unblocking.isEmpty, !id.isEmpty else { return }
        unblocking = id
        messenger.accountCall("unblock", [id]) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            self.unblocking = ""
            // The reference: on a failure the row stays.
            if case .success = result { self.blocked = (self.blocked ?? []).filter { $0["id"] as? String != id } }
            self.fill()
        }
    }

    /// «Удалить аккаунт»: a card (padding 6) holding one row — padding 14, radius 22, `dangerBg` under the finger,
    /// trash-outline 20 and the words (15 SemiBold) in `danger`, 12 apart.
    private func deleteCard(_ confirmationConfigured: Bool) -> UIView {
        let row = DeleteRow()
        row.onPress = { [weak self] in
            guard let self else { return }
            self.open(DeleteAccountViewController(messenger: self.messenger, confirmationConfigured: confirmationConfigured))
        }
        return SettingsLook.glassCard([row], padding: 6, gap: 0)
    }

    private func openForm(_ form: SecretChangeViewController.Form, _ confirmationConfigured: Bool) {
        open(SecretChangeViewController(messenger: messenger, form: form, confirmationConfigured: confirmationConfigured))
    }
}

/// The row of «Удалить аккаунт» (AccountZone.tsx).
private final class DeleteRow: UIControl {
    var onPress: (() -> Void)?

    init() {
        super.init(frame: .zero)
        layer.cornerRadius = 22
        layer.cornerCurve = .continuous
        let icon = UIImageView(image: IonIcon.image("trash-outline", size: 20))
        icon.tintColor = Theme.danger
        icon.setContentHuggingPriority(.required, for: .horizontal)
        let words = SettingsLook.words("Удалить аккаунт", size: 15, color: Theme.danger, weight: .semibold)
        let line = UIStackView(arrangedSubviews: [icon, words])
        line.axis = .horizontal
        line.alignment = .center
        line.spacing = 12
        line.isUserInteractionEnabled = false
        line.translatesAutoresizingMaskIntoConstraints = false
        addSubview(line)
        NSLayoutConstraint.activate([
            line.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            line.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            line.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            line.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
        ])
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = "Удалить аккаунт"
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? ThemeStore.look.dangerBg : .clear }
    }

    @objc private func pressed() {
        onPress?()
    }
}

/// Changing one of the three secrets: the password, the confirmation word, the recovery word. The current
/// ones are asked first; after saving every device is signed out — this one too.
final class SecretChangeViewController: SettingsPage {
    enum Form { case password, confirmation, recovery }

    private let messenger: Messenger
    private let form: Form
    private let confirmationConfigured: Bool
    private var busy = false

    private let currentPassword = SettingsField(caption: "Текущий пароль", placeholder: "Пароль этого аккаунта", secret: true)
    private let currentWord = SettingsField(caption: "Текущее слово подтверждения", placeholder: "Слово, которое используешь при входе", secret: true)
    private let fresh: SettingsField
    private let again: SettingsField
    private let noticeBox = UIStackView()
    private let saveButton = SettingsButton(label: "Сохранить изменения")

    init(messenger: Messenger, form: Form, confirmationConfigured: Bool) {
        self.messenger = messenger
        self.form = form
        self.confirmationConfigured = confirmationConfigured
        switch form {
        case .password:
            fresh = SettingsField(caption: "Новый пароль", placeholder: "От 10 до 128 символов", secret: true)
            again = SettingsField(caption: "Повтори новый пароль", placeholder: "Для проверки без опечаток", secret: true)
        case .confirmation:
            fresh = SettingsField(caption: "Новое слово подтверждения", placeholder: "Русские или английские буквы", secret: true)
            again = SettingsField(caption: "Повтори новое слово", placeholder: "Введи то же слово вручную", secret: true)
        case .recovery:
            fresh = SettingsField(caption: "Новое слово восстановления", placeholder: "Русские или английские буквы", secret: true)
            again = SettingsField(caption: "Повтори новое слово", placeholder: "Введи то же слово вручную", secret: true)
        }
        let name: String
        switch form {
        case .password: name = "Изменить пароль"
        case .confirmation: name = "Слово подтверждения"
        case .recovery: name = "Слово восстановления"
        }
        super.init(name: name)
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        add(SettingsLook.foot("Подтверди текущие данные. После сохранения все устройства выйдут из аккаунта. Новое значение введи дважды вручную."), gap: 4)
        add(currentPassword, gap: 16)
        if confirmationConfigured { add(currentWord, gap: 14) }
        add(fresh, gap: 14)
        if form != .password {
            add(SettingsLook.foot("От 4 до 64 букв, без пробелов. Регистр не важен; «е» и «ё» различаются. Два слова должны отличаться друг от друга, логина и пароля."), gap: 8)
        }
        again.onReturn = { [weak self] in self?.save() }
        add(again, gap: 14)
        noticeBox.axis = .vertical
        add(noticeBox, gap: 14)
        saveButton.onPress = { [weak self] in self?.save() }
        add(saveButton, gap: 14)
        let cancel = UIButton(type: .system)
        cancel.setTitle("Отмена", for: .normal)
        cancel.tintColor = Theme.muted
        cancel.titleLabel?.font = .systemFont(ofSize: 13)
        cancel.addTarget(self, action: #selector(cancelPressed), for: .touchUpInside)
        cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        add(cancel, gap: 4)
    }

    @objc private func cancelPressed() {
        guard !busy else { return }
        forgetSecrets()
        navigationController?.popViewController(animated: true)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // What was typed does not wait on a screen that is no longer looked at.
        if !busy { forgetSecrets() }
    }

    private func forgetSecrets() {
        currentPassword.value = ""
        currentWord.value = ""
        fresh.value = ""
        again.value = ""
    }

    private func showError(_ words: String) {
        for part in noticeBox.arrangedSubviews {
            noticeBox.removeArrangedSubview(part)
            part.removeFromSuperview()
        }
        if !words.isEmpty {
            let plate = SettingsNotice(words, error: true)
            noticeBox.addArrangedSubview(plate)
            UIAccessibility.post(notification: .announcement, argument: words)
        }
    }

    private func setBusy(_ value: Bool) {
        busy = value
        saveButton.setBusy(value)
        for field in [currentPassword, currentWord, fresh, again] { field.setEnabled(!value) }
    }

    private static func same(_ a: String, _ b: String) -> Bool {
        return a.unicodeScalars.elementsEqual(b.unicodeScalars)
    }

    private func save() {
        guard !busy else { return }
        let password = currentPassword.value
        let wordNow = currentWord.value
        if password.isEmpty || password.unicodeScalars.count > 128 {
            showError("Введи текущий пароль.")
            return
        }
        if confirmationConfigured && wordNow.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            showError("Введи текущее слово подтверждения.")
            return
        }
        let typed = fresh.value
        let repeated = again.value
        var invalid = ""
        switch form {
        case .password: invalid = AuthRules.newPasswordError(typed)
        case .confirmation: invalid = AuthRules.wordError(typed, password: password, login: "", otherWord: "")
        case .recovery: invalid = AuthRules.wordError(typed, password: password, login: "", otherWord: wordNow)
        }
        if !invalid.isEmpty {
            showError(invalid)
            return
        }
        if form == .password {
            if !SecretChangeViewController.same(typed, repeated) {
                showError("Новые пароли не совпадают.")
                return
            }
        } else if !SecretChangeViewController.same(AuthRules.word(typed), AuthRules.word(repeated)) {
            showError("Секретные слова не совпадают.")
            return
        }
        let sentWord = AuthRules.word(wordNow)
        let operation: String
        let value: String
        let done: String
        switch form {
        case .password:
            operation = "changePassword"
            value = typed
            done = "Пароль изменён. Все устройства вышли из аккаунта. Войди с новым паролем и словом подтверждения."
        case .confirmation:
            operation = "changeConfirmationWord"
            value = AuthRules.word(typed)
            done = "Слово подтверждения сохранено. Все устройства вышли из аккаунта. Используй новое слово при входе."
        case .recovery:
            operation = "changeRecoveryWord"
            value = AuthRules.word(typed)
            done = "Слово восстановления сохранено. Все устройства вышли из аккаунта. Войди с паролем и словом подтверждения."
        }
        view.endEditing(true)
        showError("")
        setBusy(true)
        messenger.accountCall(operation, [password, value, sentWord]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.forgetSecrets()
                self.setBusy(false)
                self.closeAccount(notice: self.messenger.sessionEndedHere(done))
            case .failure(let error):
                self.setBusy(false)
                self.currentPassword.value = ""
                self.currentWord.value = ""
                self.showError(error.words.isEmpty ? "Не удалось изменить настройки. Попробуй ещё раз." : error.words)
            }
        }
    }
}

/// «Удалить аккаунт»: for good, after the password and the confirmation word are typed once more.
/// (The previous app: the sheet of `mobile/src/AccountZone.tsx`.)
final class DeleteAccountViewController: SettingsPage {
    private let messenger: Messenger
    /// Whether the account has a confirmation word; nil until the server said.
    private var confirmationConfigured: Bool?
    private var busy = false
    private var loadFailure = ""
    private let password = SettingsField(caption: "Пароль", placeholder: "Пароль этого аккаунта", secret: true)
    private let word = SettingsField(caption: "Слово подтверждения", placeholder: "Слово для входа", secret: true)
    private let noticeBox = UIStackView()
    private let removeButton = SettingsButton(label: "Удалить навсегда", kind: .danger, icon: "trash-outline")

    init(messenger: Messenger, confirmationConfigured: Bool? = nil) {
        self.messenger = messenger
        self.confirmationConfigured = confirmationConfigured
        super.init(name: "Удалить аккаунт")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        noticeBox.axis = .vertical
        removeButton.onPress = { [weak self] in self?.remove() }
        fill()
        if confirmationConfigured == nil { load() }
    }

    private func load() {
        loadFailure = ""
        fill()
        messenger.accountCall("security", []) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let body): self.confirmationConfigured = body["confirmationConfigured"] as? Bool ?? false
            case .failure(let error): self.loadFailure = error.words.isEmpty ? "Не удалось загрузить настройки безопасности." : error.words
            }
            self.fill()
        }
    }

    private func fill() {
        clear()
        add(SettingsLook.inset(SettingsLook.words("Удалить аккаунт навсегда?", size: 20, color: Theme.text, weight: .bold), top: 0, side: 2, bottom: 0), gap: 4)
        add(SettingsLook.inset(SettingsLook.words("Удалятся профиль, все личные чаты (у собеседников тоже), файлы, каналы и серверы, где ты владелец, твои сообщения в чужих каналах и устройства. Вернуть будет нельзя. Подписку Platina это не отменяет, если она оплачена через магазин приложений.", size: 13, color: Theme.muted), top: 0, side: 2, bottom: 0), gap: 8)
        guard let confirmationConfigured else {
            if loadFailure.isEmpty {
                add(SettingsLook.foot("Загрузка…"), gap: 16)
            } else {
                add(SettingsNotice(loadFailure, error: true, onRetry: { [weak self] in self?.load() }), gap: 16)
            }
            return
        }
        add(password, gap: 16)
        if confirmationConfigured { add(word, gap: 14) }
        add(noticeBox, gap: 14)
        add(removeButton, gap: 14)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !busy {
            password.value = ""
            word.value = ""
        }
    }

    private func showError(_ words: String) {
        for part in noticeBox.arrangedSubviews {
            noticeBox.removeArrangedSubview(part)
            part.removeFromSuperview()
        }
        if !words.isEmpty { noticeBox.addArrangedSubview(SettingsNotice(words, error: true)) }
    }

    private func setBusy(_ value: Bool) {
        busy = value
        removeButton.setBusy(value)
        password.setEnabled(!value)
        word.setEnabled(!value)
    }

    private func remove() {
        guard !busy, let confirmationConfigured else { return }
        let typed = password.value
        let typedWord = word.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty {
            showError("Введи пароль.")
            return
        }
        if confirmationConfigured && typedWord.isEmpty {
            showError("Введи слово подтверждения.")
            return
        }
        view.endEditing(true)
        showError("")
        setBusy(true)
        messenger.accountCall("deleteAccount", [typed, confirmationConfigured ? typedWord : ""]) { [weak self] result in
            guard let self else { return }
            self.setBusy(false)
            switch result {
            case .success:
                self.password.value = ""
                self.word.value = ""
                self.closeAccount(notice: self.messenger.sessionEndedHere("Аккаунт удалён."))
            case .failure(let error):
                self.showError(error.words.isEmpty ? "Не удалось удалить аккаунт." : error.words)
            }
        }
    }
}
