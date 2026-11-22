import UIKit

/// One copy of the server's privacy settings for the pages that show them: a change on one page is seen on
/// the other. (The previous app: `mobile/src/privacy/privacyStore.ts`.)
final class SettingsPrivacyModel {
    static let changed = Notification.Name("invizent.settings-privacy")

    // Security: readable by the pages of the exception lists (Settings/PrivacyLists.swift).
    let messenger: Messenger
    private(set) var privacy: [String: Any]?
    private(set) var platina = false
    /// How many people are in the two lists of exceptions of «Время захода»; -1 while not known.
    private(set) var allowCount = -1
    private(set) var denyCount = -1
    private(set) var saving = false
    private(set) var failure = ""

    init(messenger: Messenger) {
        self.messenger = messenger
    }

    private func tell() {
        NotificationCenter.default.post(name: SettingsPrivacyModel.changed, object: self)
    }

    /// The mode of «Время захода», old servers included: they only know the on/off switch.
    var lastSeen: String {
        if let mode = privacy?["lastSeen"] as? String, !mode.isEmpty { return mode }
        if let shown = privacy?["showLastSeen"] as? Bool, shown == false { return "nobody" }
        return "everyone"
    }

    func flag(_ name: String, otherwise: Bool) -> Bool {
        return privacy?[name] as? Bool ?? otherwise
    }

    func word(_ name: String, otherwise: String) -> String {
        if let value = privacy?[name] as? String, !value.isEmpty { return value }
        return otherwise
    }

    func load() {
        failure = ""
        tell()
        messenger.accountCall("privacy", []) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let body):
                if let fresh = body["privacy"] as? [String: Any] { self.privacy = fresh }
                self.platina = body["platina"] as? Bool ?? false
            case .failure(let error):
                self.failure = error.words.isEmpty ? "Не удалось загрузить настройки." : error.words
            }
            self.tell()
        }
        messenger.accountCall("lastSeenRules", []) { [weak self] result in
            guard let self, case .success(let body) = result else { return }
            self.allowCount = (body["allow"] as? [Any])?.count ?? 0
            self.denyCount = (body["deny"] as? [Any])?.count ?? 0
            self.tell()
        }
    }

    /// The setting moves at once and comes back if the server refuses.
    func change(_ patch: [String: Any]) {
        guard let previous = privacy, !saving else {
            tell()
            return
        }
        var next = previous
        for (name, value) in patch { next[name] = value }
        if let mode = patch["lastSeen"] as? String { next["showLastSeen"] = mode != "nobody" }
        privacy = next
        saving = true
        failure = ""
        tell()
        messenger.accountCall("updatePrivacy", [patch]) { [weak self] result in
            guard let self else { return }
            self.saving = false
            switch result {
            case .success(let body):
                if let fresh = body["privacy"] as? [String: Any] { self.privacy = fresh }
                self.platina = body["platina"] as? Bool ?? false
            case .failure(let error):
                self.privacy = previous
                self.failure = error.words.isEmpty ? "Не удалось сохранить." : error.words
            }
            self.tell()
        }
    }

    static let lastSeenModes: [(value: String, label: String)] = [("everyone", "Все"), ("contacts", "Мои друзья"), ("nobody", "Никто")]

    /// The value of the «Время захода» row: «Все», «Мои друзья (−1, +2)», «Никто (+3)».
    var lastSeenSummary: String {
        let mode = lastSeen
        var label = "Все"
        for item in SettingsPrivacyModel.lastSeenModes where item.value == mode { label = item.label }
        var parts: [String] = []
        if mode != "nobody", denyCount > 0 { parts.append("−\(denyCount)") }
        if mode != "everyone", allowCount > 0 { parts.append("+\(allowCount)") }
        return parts.isEmpty ? label : label + " (" + parts.joined(separator: ", ") + ")"
    }
}

/// «Конфиденциальность»: what the server shows of the person to others, and who may reach them.
/// (The previous app: `PrivacySection` of `mobile/src/SettingsScreen.tsx`.)
final class PrivacyViewController: SettingsPage {
    private let model: SettingsPrivacyModel
    /// The inline call lists, kept while «Кто может звонить» stays the same (a rebuild of the page does not reload them).
    private var callLists: CallRulesInline?
    private var callListsMode = ""

    private static let audiences: [(value: String, label: String, hint: String)] = [
        ("friends", "Друзья", "Истории и записи видят только твои друзья."),
        ("everyone", "Все", "Истории и записи видит любой, кого ты не заблокировал."),
    ]
    private static let callModes: [(value: String, label: String, hint: String)] = [
        ("everyone", "Все", "Позвонить может любой, кроме тех, кто в списке «Никогда»."),
        ("contacts", "Друзья", "Только люди из твоих друзей и из списка «Разрешить»."),
        ("allowed", "Разрешённые", "Только люди из списка «Разрешить»."),
    ]

    init(messenger: Messenger) {
        model = SettingsPrivacyModel(messenger: messenger)
        super.init(name: "Конфиденциальность")
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func build() {
        NotificationCenter.default.addObserver(self, selector: #selector(changed), name: SettingsPrivacyModel.changed, object: model)
        model.load()
    }

    @objc private func changed() {
        fill()
    }

    private func fill() {
        clear()
        let model = self.model
        if !model.failure.isEmpty {
            if model.privacy == nil {
                add(SettingsNotice(model.failure, error: true, onRetry: { model.load() }))
            } else {
                add(SettingsNotice(model.failure, error: true))
            }
        }
        // Security: the device lock sits first on the privacy screen (Settings/PasscodeSettings.swift).
        let passcode = SettingsRow(symbol: "ion:keypad", label: "Код-пароль", value: LockStore.shared.current.record != nil ? "Вкл." : "Выкл.")
        passcode.onPress = { [weak self] in self?.open(PasscodeViewController()) }
        addGroup("Безопасность", rows: [passcode])
        guard model.privacy != nil else {
            if model.failure.isEmpty { add(SettingsLook.foot("Загрузка…"), gap: 16) }
            return
        }
        let saving = model.saving
        let platina = model.platina

        let lastSeen = SettingsRow(symbol: "ion:time", label: "Время захода", value: model.lastSeenSummary)
        lastSeen.onPress = { [weak self] in self?.open(LastSeenViewController(model: model)) }
        let newChats = SettingsSwitchRow(label: "Новые разговоры", words: "Кто ещё не писал тебе, сможет начать чат. Выключи, чтобы писали только те, с кем переписка уже есть.",
                                         value: model.flag("allowNewChats", otherwise: true), enabled: !saving)
        newChats.onChange = { value in model.change(["allowNewChats": value]) }
        let photo = SettingsSwitchRow(label: "Фото профиля для других", words: "Если выключить, собеседники и поиск увидят цветной аватар вместо фото.",
                                      value: model.flag("showAvatar", otherwise: true), enabled: !saving)
        photo.onChange = { value in model.change(["showAvatar": value]) }
        let receipts = SettingsSwitchRow(label: "Отчёты о прочтении",
                                         words: platina ? "Взаимно: если выключить, ты тоже не увидишь, прочитали ли твои сообщения." : "Скрывать прочтение можно с Platina.",
                                         value: model.flag("readReceipts", otherwise: true), enabled: !saving && platina, badge: platina ? "" : "Platina")
        receipts.onChange = { value in model.change(["readReceipts": value]) }
        addGroup("На сервере", rows: [lastSeen, newChats, photo, receipts])

        let audience = model.word("posts", otherwise: "friends")
        var audienceIndex = 0
        for (index, item) in PrivacyViewController.audiences.enumerated() where item.value == audience { audienceIndex = index }
        let audienceBox = choice(heading: "Кто видит мои истории и записи", hint: PrivacyViewController.audiences[audienceIndex].hint, hintFirst: false,
                                 labels: PrivacyViewController.audiences.map { $0.label }, chosen: audienceIndex, enabled: !saving, spoken: "") { index in
            guard index != audienceIndex else { return }
            model.change(["posts": PrivacyViewController.audiences[index].value])
        }
        addGroup("Истории и записи", rows: [audienceBox])

        let calls = model.word("calls", otherwise: "everyone")
        var callIndex = 0
        for (index, item) in PrivacyViewController.callModes.enumerated() where item.value == calls { callIndex = index }
        let callBox = choice(heading: "Кто может звонить", hint: PrivacyViewController.callModes[callIndex].hint, hintFirst: true,
                             labels: PrivacyViewController.callModes.map { $0.label }, chosen: callIndex, enabled: !saving, spoken: "Звонки") { index in
            guard index != callIndex else { return }
            model.change(["calls": PrivacyViewController.callModes[index].value])
        }
        // CallPrivacy.tsx: the lists «Разрешить» and «Никогда» right under the choice, in the same card (padding 14, 12
        // between the parts) — the choice box keeps its 14, the lists follow 12 under the segments.
        let lists: CallRulesInline
        if let kept = callLists, callListsMode == calls { lists = kept } else {
            lists = CallRulesInline(messenger: model.messenger, mode: calls)
            callLists = lists
            callListsMode = calls
        }
        lists.removeFromSuperview()
        let callCard = UIStackView(arrangedSubviews: [callBox, SettingsLook.inset(lists, top: -2, side: 14, bottom: 14)])
        callCard.axis = .vertical
        addGroup("Звонки", rows: [callCard])

        // Profile: «На этом устройстве» — the typing notice (SettingsScreen.tsx; DevicePreferences `sendTyping`, which
        // ChatActions reads before telling the other side).
        let typing = SettingsSwitchRow(label: "Показывать «печатает…»", words: "Собеседник видит, что ты набираешь сообщение.", value: DevicePreferences.flag("sendTyping") ?? true, enabled: true)
        typing.onChange = { (value: Bool) -> Void in DevicePreferences.set(["sendTyping": value]) }
        addGroup("На этом устройстве", rows: [typing])

        add(SettingsLook.foot("Содержимое сообщений, ответы, реакции, правки и закрепления шифруются на устройстве. Сервер видит только служебные данные: кто, кому и когда."), gap: 16)
    }

    /// A heading, one of several side by side, and the words about the chosen one.
    private func choice(heading: String, hint: String, hintFirst: Bool, labels: [String], chosen: Int, enabled: Bool, spoken: String, pick: @escaping (Int) -> Void) -> UIView {
        let name = SettingsLook.words(heading, size: 15, color: Theme.text, weight: .semibold)
        let about = SettingsLook.words(hint, size: 12.5, color: Theme.muted)
        let segments = SettingsSegments(labels: labels, chosen: chosen, enabled: enabled, spoken: spoken)
        segments.onPick = pick
        let parts: [UIView] = hintFirst ? [name, about, segments] : [name, segments, about]
        let box = UIStackView(arrangedSubviews: parts)
        box.axis = .vertical
        box.spacing = 12
        if hintFirst { box.setCustomSpacing(3, after: name) }
        return SettingsLook.inset(box, top: 14, side: 14, bottom: 14)
    }
}

/// «Время захода»: who sees when the person was last here, and whether the time of reading is hidden with it.
/// (The previous app: `LastSeenSection` of `mobile/src/SettingsScreen.tsx`.)
final class LastSeenViewController: SettingsPage {
    private let model: SettingsPrivacyModel

    init(model: SettingsPrivacyModel) {
        self.model = model
        super.init(name: "Время захода")
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func build() {
        NotificationCenter.default.addObserver(self, selector: #selector(changed), name: SettingsPrivacyModel.changed, object: model)
        fill()
    }

    @objc private func changed() {
        fill()
    }

    private func fill() {
        clear()
        let model = self.model
        guard model.privacy != nil else {
            if model.failure.isEmpty {
                add(SettingsLook.foot("Загрузка…"), gap: 16)
            } else {
                add(SettingsNotice(model.failure, error: true, onRetry: { model.load() }))
            }
            return
        }
        if !model.failure.isEmpty { add(SettingsNotice(model.failure, error: true)) }
        let mode = model.lastSeen
        let saving = model.saving
        var rows: [UIView] = []
        for item in SettingsPrivacyModel.lastSeenModes {
            let on = item.value == mode
            let value = item.value
            let row = SettingsRow(label: item.label, checked: on)
            row.isEnabled = !saving
            row.onPress = {
                guard !on else { return }
                model.change(["lastSeen": value])
            }
            rows.append(row)
        }
        addGroup("Кто видит, когда я в сети", rows: rows)
        add(SettingsLook.foot("Без подписки Platina вы не будете видеть появление в сети и время последнего захода пользователей, от которых скрыли свои. Вместо точного времени будет видно примерное значение (недавно, на этой неделе, в этом месяце)."), gap: 8)
        // Security: «Исключения» — «Всегда показывать» (not with «Все»), «Никогда не показывать» (not with «Никто»).
        var lists: [UIView] = []
        let count = { (people: Int) -> String in people < 0 ? "" : (people > 0 ? String(people) : "Добавить") }
        if mode != "everyone" {
            let allow = SettingsRow(symbol: "ion:checkmark-circle", label: "Всегда показывать", value: count(model.allowCount))
            allow.onPress = { [weak self] in self?.open(LastSeenExceptionsViewController(messenger: model.messenger, model: model, rule: "allow")) }
            lists.append(allow)
        }
        if mode != "nobody" {
            let deny = SettingsRow(symbol: "ion:remove-circle", label: "Никогда не показывать", value: count(model.denyCount))
            deny.onPress = { [weak self] in self?.open(LastSeenExceptionsViewController(messenger: model.messenger, model: model, rule: "deny")) }
            lists.append(deny)
        }
        addGroup("Исключения", rows: lists)
        add(SettingsLook.foot("Вы можете добавить пользователей в список исключений из настроек выше."), gap: 8)

        // The time of reading can be hidden once the time of coming is hidden from anyone.
        if mode != "everyone" || model.denyCount > 0 {
            let hide = SettingsSwitchRow(label: "Скрывать время прочтения", words: "", value: model.flag("hideReadTime", otherwise: false), enabled: !saving)
            hide.onChange = { value in model.change(["hideReadTime": value]) }
            addGroup(rows: [hide])
            add(SettingsLook.foot("Не показывать время прочтения сообщений пользователям, от которых вы скрыли время захода. Если включить, их время прочтения тоже будет скрыто от вас. Отметки о прочтении при этом остаются. Подписчики Platina видят время прочтения, даже если скрыли своё."), gap: 8)
        }
    }
}
