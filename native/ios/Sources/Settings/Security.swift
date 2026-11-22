import UIKit

/// «Безопасность»: the password and the two secret words, and deleting the account.
/// (The previous app: `mobile/src/SecurityScreen.tsx` and `AccountZone.tsx`; the sessions and the blocked
/// people of that screen have their own pages here.)
final class SecurityViewController: SettingsPage {
    private let messenger: Messenger
    private var status: [String: Any]?
    private var loading = true
    private var failure = ""
    private var request = 0

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Безопасность")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        load()
    }

    private func load() {
        request += 1
        let mine = request
        loading = true
        failure = ""
        fill()
        messenger.accountCall("security", []) { [weak self] result in
            guard let self, mine == self.request else { return }
            self.loading = false
            switch result {
            case .success(let body):
                self.status = body
            case .failure(let error):
                if error.refusalStatus == 404 {
                    self.failure = "Сервер ещё не поддерживает настройки безопасности. Обнови сервер Инвиза до версии 0.3.0."
                } else {
                    self.failure = error.words.isEmpty ? "Не удалось загрузить настройки безопасности." : error.words
                }
                if error.refusalStatus == 401 {
                    self.closeAccount(notice: self.messenger.sessionEndedHere("Сессия завершилась. Войди в аккаунт снова."))
                    return
                }
            }
            self.fill()
        }
    }

    private func card(_ parts: [UIView]) -> UIView {
        let box = UIStackView(arrangedSubviews: parts)
        box.axis = .vertical
        box.spacing = 13
        return SettingsLook.inset(box, top: 16, side: 16, bottom: 16)
    }

    /// The name of a secret word and whether it is set up.
    private func wordState(_ name: String, configured: Bool) -> UIView {
        // The reference: Ionicons «checkmark-circle-outline» / «key-outline» 25 in the accent, on a 42 square of
        // `accentSoft` with radius 16; «Настроено» in the accent.
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
        addGroup(rows: [card([
            SettingsLook.words("Твой доступ.\nТвои устройства.", size: 23, color: Theme.text, weight: .heavy),
            SettingsLook.words("Вход по логину (тайному, не @имени), паролю и слову подтверждения. Для восстановления — другое слово. Почта и номер телефона не нужны.", size: 13, color: Theme.muted),
        ])])
        if !failure.isEmpty { add(SettingsNotice(failure, error: true, onRetry: { [weak self] in self?.load() }), gap: 14) }
        if loading && status == nil { add(SettingsLook.foot("Загружаем настройки…"), gap: 16) }
        guard let status else { return }
        let confirmationConfigured = status["confirmationConfigured"] as? Bool ?? false
        let recoveryConfigured = status["recoveryConfigured"] as? Bool ?? false
        if !confirmationConfigured || !recoveryConfigured {
            add(SettingsNotice("Заверши настройку двух слов. В старом аккаунте недостающие слова можно добавить, пока помнишь пароль."), gap: 14)
        }

        let password = SettingsButton(label: "Изменить пароль", kind: .secondary, icon: "key-outline")
        password.onPress = { [weak self] in self?.openForm(.password, confirmationConfigured) }
        // The reference: Ionicons «lock-closed-outline» 23 in the accent beside the words, 12 apart.
        let lockIcon = UIImageView(image: IonIcon.image("lock-closed-outline", size: 23))
        lockIcon.tintColor = Theme.accent
        lockIcon.contentMode = .center
        lockIcon.setContentHuggingPriority(.required, for: .horizontal)
        let passwordLine = UIStackView(arrangedSubviews: [lockIcon, SettingsLook.words("Можно использовать длинную фразу. После смены пароля все сеансы завершатся.", size: 13, color: Theme.muted)])
        passwordLine.axis = .horizontal
        passwordLine.alignment = .center
        passwordLine.spacing = 12
        addGroup("Пароль", rows: [card([passwordLine, password])])

        let confirmation = SettingsButton(label: confirmationConfigured ? "Изменить слово подтверждения" : "Настроить слово подтверждения", kind: .secondary, icon: "key-outline")
        confirmation.onPress = { [weak self] in self?.openForm(.confirmation, confirmationConfigured) }
        addGroup("Подтверждение входа", rows: [card([
            wordState("Слово подтверждения", configured: confirmationConfigured),
            SettingsLook.words("Это слово нужно при каждом входе после пароля. Посмотреть его повторно нельзя.", size: 13, color: Theme.muted),
            confirmation,
        ])])

        let limitBox = UIStackView(arrangedSubviews: [
            SettingsLook.words("3 попытки → 24 часа ожидания", size: 12, color: Theme.text, weight: .bold),
            SettingsLook.words("Ограничение действует на сервере и относится только к восстановлению. Вход с паролем и словом подтверждения остаётся доступен.", size: 12, color: Theme.muted),
        ])
        limitBox.axis = .vertical
        limitBox.spacing = 5
        let limit = SettingsLook.inset(limitBox, top: 13, side: 13, bottom: 13)
        limit.backgroundColor = SettingsLook.chip
        limit.layer.cornerRadius = 14
        limit.layer.cornerCurve = .continuous
        let recovery = SettingsButton(label: recoveryConfigured ? "Изменить слово восстановления" : "Настроить слово восстановления", kind: .secondary, icon: "key-outline")
        recovery.onPress = { [weak self] in self?.openForm(.recovery, confirmationConfigured) }
        addGroup("Восстановление доступа", rows: [card([
            wordState("Слово восстановления", configured: recoveryConfigured),
            SettingsLook.words(recoveryConfigured
                ? "Отдельное слово для случая, когда пароль забыт. После его проверки действует 10-минутное ожидание. Открытые сеансы могут отменить запрос."
                : "Настрой слово сейчас, пока помнишь пароль. Без слова восстановления вернуть доступ через этот экран не получится.", size: 13, color: Theme.muted),
            limit,
            recovery,
        ])])

        // «Сеансы и устройства» and «Заблокированные» stand here in the reference's SecurityScreen (before «Удалить
        // аккаунт»); their lists are on their own pages (Settings/Sessions.swift, Settings/PrivacyLists.swift).
        let sessions = SettingsRow(symbol: "ion:phone-portrait-outline", label: "Активные сеансы")
        sessions.onPress = { [weak self] in
            guard let self else { return }
            self.open(SessionsViewController(messenger: self.messenger))
        }
        // Old chats on a new device: the copy from another own device and the encrypted backup (Settings/HistorySettings.swift).
        let history = SettingsRow(symbol: "ion:cloud-download-outline", label: "Переписки на новом устройстве")
        history.onPress = { [weak self] in
            guard let self else { return }
            self.open(HistoryViewController(messenger: self.messenger))
        }
        addGroup("Сеансы и устройства", rows: [sessions, history])
        let blocked = SettingsRow(symbol: "ion:hand-left-outline", label: "Заблокированные")
        blocked.onPress = { [weak self] in
            guard let self else { return }
            self.open(BlockedViewController(messenger: self.messenger))
        }
        addGroup(rows: [blocked])

        let remove = SettingsRow(symbol: "ion:trash-outline", label: "Удалить аккаунт", danger: true)
        remove.onPress = { [weak self] in
            guard let self else { return }
            self.open(DeleteAccountViewController(messenger: self.messenger, confirmationConfigured: confirmationConfigured))
        }
        addGroup(rows: [remove])

        add(SettingsLook.foot("Выбирай два разных непредсказуемых слова. Они должны отличаться друг от друга, логина и пароля. Все значения здесь вводятся вручную."), gap: 16)
    }

    private func openForm(_ form: SecretChangeViewController.Form, _ confirmationConfigured: Bool) {
        open(SecretChangeViewController(messenger: messenger, form: form, confirmationConfigured: confirmationConfigured))
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
