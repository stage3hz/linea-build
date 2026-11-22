import UIKit

/// The notification switches of this device (show, sound, the call's melody and vibration, the number on the
/// icon): one JSON record kept on the phone, read back through the core (`settingsNotificationPrefs`). The server
/// knows nothing of them; the sound of a chat is the server's own setting. (The previous app:
/// `mobile/src/notifications/prefs.ts`, `model.ts`.)
enum NotificationPrefs {
    private static let key = "invizent.notification-prefs.v1"

    /// `chats`, `communities`, `calls`, `badge` — each a group of switches — and `changed`.
    static var all: [String: Any] {
        var raw: Any = NSNull()
        if let stored = UserDefaults.standard.string(forKey: key) { raw = stored }
        return Core.view("settingsNotificationPrefs", [raw]) as? [String: Any] ?? [:]
    }

    static func flag(_ group: String, _ name: String) -> Bool {
        return (all[group] as? [String: Any])?[name] as? Bool ?? true
    }

    /// The melody of an incoming call: `neon`, `pulse` or `none`.
    static var ringtone: String {
        return (all["calls"] as? [String: Any])?["ringtone"] as? String ?? "neon"
    }

    /// Any switch differs from its default.
    static var changed: Bool {
        return all["changed"] as? Bool ?? false
    }

    static func set(_ group: String, _ name: String, _ value: Any) {
        var next = all
        next["changed"] = nil
        var part = next[group] as? [String: Any] ?? [:]
        part[name] = value
        next[group] = part
        guard let text = Core.text(next) else { return }
        UserDefaults.standard.set(text, forKey: key)
    }

    /// «Сбросить настройки»: back to the defaults, the record removed.
    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

/// A chat whose sound is off: the person, until when, and a bell that turns the sound back on.
final class MutedChatRow: UIControl {
    var onPress: (() -> Void)?
    var onBell: (() -> Void)?

    init(person: [String: Any], base: String, name: String, status: String) {
        super.init(frame: .zero)
        let ball = SettingsAvatar(frame: CGRect(x: 0, y: 0, width: 36, height: 36))
        ball.show(person, base: base)
        ball.isUserInteractionEnabled = false
        ball.translatesAutoresizingMaskIntoConstraints = false
        let nameLabel = SettingsLook.words(name, size: 15, color: Theme.text, weight: .semibold)
        nameLabel.numberOfLines = 1
        let statusLabel = SettingsLook.words(status, size: 12, color: Theme.muted)
        statusLabel.numberOfLines = 1
        let texts = UIStackView(arrangedSubviews: [nameLabel, statusLabel])
        texts.axis = .vertical
        texts.spacing = 2
        texts.isUserInteractionEnabled = false
        texts.translatesAutoresizingMaskIntoConstraints = false
        let bell = UIButton(type: .system)
        bell.setImage(SettingsLook.symbol("ion:notifications-outline", size: 20), for: .normal)
        bell.tintColor = Theme.accent
        bell.accessibilityLabel = "Включить звук"
        bell.addTarget(self, action: #selector(bellPressed), for: .touchUpInside)
        bell.translatesAutoresizingMaskIntoConstraints = false
        addSubview(ball)
        addSubview(texts)
        addSubview(bell)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
            ball.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            ball.centerYAnchor.constraint(equalTo: centerYAnchor),
            ball.widthAnchor.constraint(equalToConstant: 36),
            ball.heightAnchor.constraint(equalToConstant: 36),
            texts.leadingAnchor.constraint(equalTo: ball.trailingAnchor, constant: 12),
            texts.centerYAnchor.constraint(equalTo: centerYAnchor),
            texts.trailingAnchor.constraint(lessThanOrEqualTo: bell.leadingAnchor, constant: -8),
            bell.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            bell.centerYAnchor.constraint(equalTo: centerYAnchor),
            bell.widthAnchor.constraint(equalToConstant: 44),
            bell.heightAnchor.constraint(equalToConstant: 44),
        ])
        isAccessibilityElement = false
        accessibilityElements = [texts, bell]
        texts.isAccessibilityElement = true
        texts.accessibilityTraits.insert(.button)
        texts.accessibilityLabel = name + ": изменить время без звука"
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? SettingsLook.pressed : .clear }
    }

    @objc private func pressed() {
        onPress?()
    }

    @objc private func bellPressed() {
        onBell?()
    }
}

/// «Уведомления и звуки»: the switches of this device, and the chats whose sound is off.
/// (The previous app: `mobile/src/notifications/NotificationsSection.tsx`.)
///
/// The page starts with the push state of this device, said out loud (the reference's `pushStatusText` /
/// `usePushStatus`, Shell/Push.swift): a notice when push does not work, otherwise a line of what to expect. The
/// switches decide what shows while the app is running; the sound of a chat is the server's setting and follows the
/// account to its other devices.
final class NotificationsViewController: SettingsPage {
    private let messenger: Messenger
    private var chats: [Messenger.ChatSummary] = []
    private var failure = ""

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Уведомления и звуки")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        messenger.prepareSettingsAvatars()
        NotificationCenter.default.removeObserver(self, name: Push.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(pushChanged), name: Push.changed, object: nil)
        fill()
        load()
    }

    @objc private func pushChanged() { fill() }

    /// The push state line, word for word the reference's (NotificationsSection.tsx): a notice when push does not work.
    static func pushLine(_ status: Push.Status) -> (text: String, notice: Bool) {
        let problem = Push.text(status)
        if !problem.isEmpty { return (problem, true) }
        if status == .on { return ("Когда приложение закрыто, уведомления показывает система. Переключатели ниже действуют, пока приложение запущено. В уведомлении только имя отправителя: текст остаётся зашифрованным.", false) }
        return ("Разрешение на уведомления ещё не запрошено.", false)
    }

    private func load() {
        messenger.chats { [weak self] (result: Result<[Messenger.ChatSummary], ServerError>) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let list) = result {
                    self.chats = list
                    self.fill()
                }
            }
        }
    }

    /// The sound of a chat right now (the core's `settingsMuteState`): `muted`, `until`, `status`.
    static func muteState(_ settings: [String: Any]) -> [String: Any] {
        let now = Date()
        var end = now
        if let until = settings["mutedUntil"] as? String, let date = Messenger.date(until) { end = date }
        let zone = TimeZone.current
        let args: [Any] = [settings, Int(now.timeIntervalSince1970 * 1000), zone.secondsFromGMT(for: now) / 60, zone.secondsFromGMT(for: end) / 60]
        return Core.view("settingsMuteState", args) as? [String: Any] ?? [:]
    }

    private func toggle(_ group: String, _ name: String, label: String, words: String, enabled: Bool = true) -> SettingsSwitchRow {
        let row = SettingsSwitchRow(label: label, words: words, value: NotificationPrefs.flag(group, name), enabled: enabled)
        row.onChange = { [weak self] (value: Bool) -> Void in
            NotificationPrefs.set(group, name, value)
            self?.fill()
        }
        return row
    }

    private func fill() {
        clear()
        let line = NotificationsViewController.pushLine(Push.shared.status)
        let head: UIView = line.notice ? SettingsNotice(line.text) : SettingsLook.foot(line.text)
        add(head)

        let showChats = NotificationPrefs.flag("chats", "show")
        addGroup("Личные чаты", rows: [
            toggle("chats", "show", label: "Показывать уведомления", words: "Новые сообщения и реакции в личных чатах, пока приложение свёрнуто. Когда оно закрыто, уведомления показывает система."),
            toggle("chats", "sound", label: "Звук", words: "Короткий сигнал при новом сообщении.", enabled: showChats),
        ])
        let showCommunities = NotificationPrefs.flag("communities", "show")
        addGroup("Сообщества", rows: [
            toggle("communities", "show", label: "Показывать уведомления", words: "Сообщения в каналах сообществ, где ты состоишь. Сообщества без звука присылают только упоминания."),
            toggle("communities", "sound", label: "Звук", words: "Короткий сигнал при новом сообщении в сообществе.", enabled: showCommunities),
        ])

        var melody = ""
        for tone in ThemeStore.list("ringtones") where tone["id"] as? String == NotificationPrefs.ringtone { melody = tone["label"] as? String ?? "" }
        let melodyRow = SettingsRow(symbol: "ion:musical-notes", label: "Мелодия", value: melody)
        melodyRow.onPress = { [weak self] in self?.askMelody() }
        addGroup("Звонки", rows: [
            melodyRow,
            toggle("calls", "vibration", label: "Вибрация", words: "Телефон вибрирует при входящем звонке, пока приложение запущено."),
        ])

        let badge = NotificationPrefs.flag("badge", "enabled")
        let countMuted = SettingsSwitchRow(label: "Включая чаты без звука", words: "Сообщения из чатов с выключенным звуком тоже попадают в число на иконке.",
                                           value: (NotificationPrefs.all["badge"] as? [String: Any])?["countMuted"] as? Bool ?? false, enabled: badge)
        countMuted.onChange = { [weak self] (value: Bool) -> Void in
            NotificationPrefs.set("badge", "countMuted", value)
            self?.fill()
        }
        addGroup("Бейдж на иконке", rows: [
            toggle("badge", "enabled", label: "Считать непрочитанные", words: "Число непрочитанных сообщений на иконке приложения."),
            countMuted,
        ])

        var quiet: [UIView] = []
        for chat in chats {
            let settings = chat.chat["settings"] as? [String: Any] ?? [:]
            let state = NotificationsViewController.muteState(settings)
            guard state["muted"] as? Bool == true else { continue }
            let row = MutedChatRow(person: chat.chat["peer"] as? [String: Any] ?? [:], base: messenger.server.endpoint, name: chat.title, status: state["status"] as? String ?? "")
            row.onPress = { [weak self] in self?.askMute(chat, settings: settings) }
            row.onBell = { [weak self] in self?.change(chat, ["muted": false]) }
            quiet.append(row)
        }
        if !quiet.isEmpty { addGroup("Чаты без звука", rows: quiet) }
        if !failure.isEmpty { add(SettingsNotice(failure, error: true), gap: 12) }

        let reset = SettingsRow(symbol: "ion:refresh", label: "Сбросить настройки", danger: true)
        reset.onPress = { [weak self] in self?.askReset() }
        addGroup(rows: [reset])
        add(SettingsLook.foot("Переключатели хранятся только на этом устройстве. Выключенный звук чата действует на всех твоих устройствах: сервер просто не отправляет уведомление, пока он выключен."), gap: 10)
    }

    private func askMelody() {
        var choices: [ChoiceSheet.Choice] = []
        let current = NotificationPrefs.ringtone
        for tone in ThemeStore.list("ringtones") {
            guard let id = tone["id"] as? String, let label = tone["label"] as? String else { continue }
            choices.append(ChoiceSheet.Choice(symbol: id == current ? "ion:checkmark-circle" : "ion:ellipse-outline", label: label, run: { [weak self] in
                NotificationPrefs.set("calls", "ringtone", id)
                self?.fill()
            }))
        }
        present(ChoiceSheet(heading: "Мелодия звонка", choices: choices), animated: true)
    }

    private func askReset() {
        let changed = NotificationPrefs.changed
        guard changed else {
            tell("Все переключатели уже стоят по умолчанию.")
            return
        }
        confirm(heading: "Сбросить настройки уведомлений?",
                words: "Все переключатели на этом устройстве вернутся к значениям по умолчанию. Звук в чатах останется как есть.",
                action: "Сбросить") { [weak self] in
            NotificationPrefs.reset()
            self?.fill()
        }
    }

    /// «Выключить звук» for a chat that is quiet already: the sound back, or another time.
    private func askMute(_ chat: Messenger.ChatSummary, settings: [String: Any]) {
        var choices: [ChoiceSheet.Choice] = []
        let now = NotificationsViewController.muteState(settings)
        choices.append(ChoiceSheet.Choice(symbol: "ion:notifications-outline", label: "Включить звук", note: "Сейчас звук выключен " + (now["until"] as? String ?? "навсегда") + ".", run: { [weak self] in
            self?.change(chat, ["muted": false])
        }))
        for choice in ThemeStore.list("muteChoices") {
            guard let id = choice["id"] as? String, let label = choice["label"] as? String else { continue }
            if choice["ms"] is NSNumber {
                // The note shows the end counted from now; the end sent is counted from the moment of the choice.
                var note = ""
                if let preview = NotificationsViewController.muteEnd(id) {
                    let state = NotificationsViewController.muteState(["muted": true, "mutedUntil": preview])
                    note = "Без звука " + (state["until"] as? String ?? "") + "."
                }
                choices.append(ChoiceSheet.Choice(symbol: "ion:time-outline", label: label, note: note, run: { [weak self] in
                    guard let until = NotificationsViewController.muteEnd(id) else { return }
                    self?.change(chat, ["mutedUntil": until])
                }))
            } else {
                choices.append(ChoiceSheet.Choice(symbol: "ion:notifications-off-outline", label: label, note: "Пока не включишь снова. Звонки продолжат звонить.", run: { [weak self] in
                    self?.change(chat, ["muted": true])
                }))
            }
        }
        present(ChoiceSheet(heading: "Выключить звук", note: chat.title, choices: choices), animated: true)
    }

    /// The end of a silence chosen now, as the server takes it (the core's `settingsMuteUntil`).
    private static func muteEnd(_ choice: String) -> String? {
        let args: [Any] = [choice, Int(Date().timeIntervalSince1970 * 1000)]
        return Core.view("settingsMuteUntil", args) as? String
    }

    /// The sound of a chat is its setting on the server: it follows the account to its other devices.
    private func change(_ chat: Messenger.ChatSummary, _ update: [String: Any]) {
        failure = ""
        messenger.server.op("chatSettings", [chat.id, update]) { [weak self] (result: Result<Any, ServerError>) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .failure(let error) = result {
                    self.failure = error.words.isEmpty ? "Не удалось изменить чат." : error.words
                    self.fill()
                }
                self.load()
            }
        }
    }
}
