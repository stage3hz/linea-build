import UIKit

/// Настройки › Конфиденциальность › «Код-пароль»: turn the code on, change it, unlock with Face ID / Touch ID, the
/// autolock delay, turn it off. With a code set, the page first asks for the current code. (The previous app:
/// `mobile/src/lock/PasscodeSettings.tsx`, word for word; the rules: Security/LockModel.swift.)
final class PasscodeViewController: SettingsPage {
    private enum Phase { case verify, settings, setup(change: Bool) }
    private var phase: Phase
    private var entry: CodeEntryView?
    // Setting up a code: its kind, the first code typed, the error.
    private var kind = "digits"
    private var first: String?
    private var error = ""
    private var wrong = false
    private var checking = false
    private var ticker: Timer?
    private var bioBusy = false

    init() {
        phase = LockStore.shared.current.record != nil ? .verify : .settings
        super.init(name: "Код-пароль")
    }

    required init?(coder: NSCoder) { return nil }

    deinit { ticker?.invalidate() }

    override func build() {
        fill()
    }

    private func fill() {
        clear()
        entry = nil
        ticker?.invalidate()
        ticker = nil
        switch phase {
        case .verify:
            guard let record = LockStore.shared.current.record else { phase = .settings; fill(); return }
            let made = CodeEntryView(kind: record.kind)
            made.onSubmit = { [weak self] (code: String) -> Void in self?.verify(code) }
            entry = made
            add(SettingsLook.inset(made, top: 12, side: 0, bottom: 0), gap: 0)
            refreshVerify()
            ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] (_: Timer) -> Void in self?.refreshVerify() }
            made.focus()
        case .setup(let change):
            let made = CodeEntryView(kind: kind)
            made.onSubmit = { [weak self] (code: String) -> Void in self?.take(code, change: change) }
            entry = made
            setupFooter(made)
            add(SettingsLook.inset(made, top: 12, side: 0, bottom: 0), gap: 0)
            refreshSetup(change: change)
            made.focus()
        case .settings:
            fillSettings()
        }
    }

    // MARK: Verify (the same failure counter and wait as the lock screen)

    private func refreshVerify() {
        guard let entry, let record = LockStore.shared.current.record else { return }
        let wait = LockStore.shared.waitMs
        let digits = record.kind == "digits"
        entry.setTitle(digits ? "Введи текущий код-пароль" : "Введи текущий пароль",
                       hint: wait > 0 ? LockRules.retryHint(wait) : "Чтобы менять настройки код-пароля, подтверди его",
                       error: wrong && wait <= 0 ? "Неверный код-пароль" : "")
        entry.disabled = checking || wait > 0
    }

    private func verify(_ code: String) {
        guard !checking, LockStore.shared.waitMs <= 0 else { return }
        checking = true
        refreshVerify()
        LockStore.shared.check(code) { [weak self] (right: Bool) -> Void in
            guard let self else { return }
            self.checking = false
            if right {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                LockStore.shared.recordSuccess()
                self.view.endEditing(true)
                self.phase = .settings
                self.fill()
                return
            }
            self.wrong = true
            LockStore.shared.recordFailure()
            self.entry?.shake()
            self.refreshVerify()
        }
    }

    // MARK: Setup

    private func setupFooter(_ made: CodeEntryView) {
        if first == nil {
            let other = textButton(kind == "digits" ? "Использовать пароль" : "Использовать 4-значный код", muted: false) { [weak self] in
                guard let self else { return }
                self.kind = self.kind == "digits" ? "password" : "digits"
                self.error = ""
                self.fill()
            }
            made.footer.addArrangedSubview(other)
        }
        let cancel = textButton("Отмена", muted: true) { [weak self] in
            guard let self else { return }
            self.view.endEditing(true)
            self.first = nil
            self.error = ""
            self.phase = .settings
            self.fill()
        }
        made.footer.addArrangedSubview(cancel)
    }

    private func textButton(_ label: String, muted: Bool, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(label, for: .normal)
        button.setTitleColor(muted ? Theme.muted : Theme.accent, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        button.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.addAction(UIAction { (_: UIAction) -> Void in action() }, for: .touchUpInside)
        return button
    }

    private func refreshSetup(change: Bool) {
        guard let entry else { return }
        let repeating = first != nil
        let digits = kind == "digits"
        let title: String
        if repeating {
            title = digits ? "Повтори код-пароль" : "Повтори пароль"
        } else if change {
            title = digits ? "Введи новый код-пароль" : "Введи новый пароль"
        } else {
            title = digits ? "Введи код-пароль" : "Введи пароль"
        }
        entry.setTitle(title, hint: repeating ? "Ещё раз, чтобы не ошибиться" : "Он будет запрашиваться при открытии Инвиза", error: error)
    }

    private func take(_ code: String, change: Bool) {
        if let problem = LockRules.codeProblem(code, kind: kind) {
            error = problem
            entry?.shake()
            refreshSetup(change: change)
            return
        }
        // The first code is taken: a quiet clear for «Повтори», not the wrong-code shake.
        guard let firstCode = first else {
            error = ""
            first = code
            entry?.clearQuietly()
            // «Использовать пароль» goes away while repeating.
            fill()
            return
        }
        if code != firstCode {
            error = "Коды не совпадают. Попробуй ещё раз"
            first = nil
            fill()
            entry?.shake()
            return
        }
        entry?.disabled = true
        let saved = LockStore.shared.enable(code)
        if saved {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            view.endEditing(true)
            first = nil
            error = ""
            phase = .settings
            fill()
        } else {
            error = "Не удалось сохранить код-пароль на устройстве"
            first = nil
            fill()
            entry?.shake()
        }
    }

    // MARK: The settings

    private func fillSettings() {
        let settings = LockStore.shared.current
        guard settings.record != nil else {
            let enable = SettingsRow(symbol: "ion:keypad", label: "Включить код-пароль")
            enable.onPress = { [weak self] in
                guard let self else { return }
                self.kind = "digits"
                self.first = nil
                self.error = ""
                self.phase = .setup(change: false)
                self.fill()
            }
            addGroup(rows: [enable])
            add(SettingsLook.foot("Когда код-пароль включён, при открытии Инвиза показывается экран блокировки. Код хранится только на этом устройстве в виде хеша: сервер его не знает."), gap: 8)
            add(SettingsLook.foot("Если ты забудешь код-пароль, придётся переустановить приложение (на компьютере — закрыть вкладку и войти снова)."), gap: 8)
            return
        }
        let off = SettingsRow(symbol: "ion:lock-open", label: "Выключить код-пароль", danger: true)
        off.onPress = { [weak self] in
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            LockStore.shared.disable()
            self?.fill()
        }
        let change = SettingsRow(symbol: "ion:key", label: "Сменить код-пароль")
        change.onPress = { [weak self] in
            guard let self else { return }
            self.kind = "digits"
            self.first = nil
            self.error = ""
            self.phase = .setup(change: true)
            self.fill()
        }
        addGroup(rows: [off, change])
        if let label = LockBiometrics.label() {
            let bio = SettingsSwitchRow(label: "Разблокировка " + label, words: "Открывать Инвиз без кода, когда система узнаёт тебя", value: settings.biometrics, enabled: !bioBusy)
            bio.onChange = { [weak self] (on: Bool) -> Void in self?.toggleBiometrics(on) }
            addGroup(rows: [bio])
        }
        let autolock = SettingsRow(symbol: "ion:timer", label: "Автоблокировка", value: LockRules.autolockLabels[settings.autolock] ?? "")
        autolock.onPress = { [weak self] in self?.chooseAutolock() }
        addGroup(rows: [autolock])
        add(SettingsLook.foot("Код-пароль запрашивается, если приложение не открывали дольше выбранного времени. «Сразу» блокирует при каждом уходе из Инвиза."), gap: 8)
        add(SettingsLook.foot("После пяти неверных попыток следующая разрешается с нарастающей задержкой."), gap: 8)
    }

    /// Turning Face ID / Touch ID on asks for it once, so the owner sees it works before relying on it.
    private func toggleBiometrics(_ on: Bool) {
        guard !bioBusy else { return }
        if !on {
            LockStore.shared.update { (settings: inout LockSettings) -> Void in settings.biometrics = false }
            return
        }
        bioBusy = true
        LockBiometrics.authenticate("Подтверди, что это ты") { [weak self] (success: Bool) -> Void in
            guard let self else { return }
            self.bioBusy = false
            if success {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                LockStore.shared.update { (settings: inout LockSettings) -> Void in settings.biometrics = true }
            }
            self.fill()
        }
    }

    private func chooseAutolock() {
        // The reference's Sheet «Автоблокировка»: a SheetAction per mode with `autolockIcon` (off «close-circle-outline»,
        // immediate «flash-outline», a time «time-outline»).
        let choices = LockRules.autolockModes.map { (mode: String) -> ChoiceSheet.Choice in
            let symbol = mode == "off" ? "ion:close-circle-outline" : mode == "immediate" ? "ion:flash-outline" : "ion:time-outline"
            return ChoiceSheet.Choice(symbol: symbol, label: LockRules.autolockLabels[mode] ?? mode, selected: LockStore.shared.current.autolock == mode, run: { [weak self] in
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                LockStore.shared.update { (settings: inout LockSettings) -> Void in settings.autolock = mode }
                self?.fill()
            })
        }
        let sheet = ChoiceSheet(heading: "Автоблокировка", note: "«Выключена»: код запрашивается только при запуске приложения, а не при возвращении в него.", choices: choices)
        present(sheet, animated: true)
    }
}
