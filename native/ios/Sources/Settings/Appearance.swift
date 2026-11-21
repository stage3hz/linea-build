import UIKit

/// A theme as a small picture of a chat in its own colours, with its name under it. The one that is on has a
/// mark; a palette the account cannot use yet has a lock.
final class ThemeCard: UIControl {
    var onPress: (() -> Void)?

    /// `page`: the theme's background; `theirs` and `mine`: the two kinds of lines; `dot`: its accent (palettes).
    init(label: String, spoken: String, chosen: Bool, locked: Bool, page: UIColor, theirs: UIColor, mine: UIColor, edge: UIColor, dot: UIColor?) {
        super.init(frame: .zero)
        backgroundColor = chosen ? ThemeStore.look.accentSoft : .clear
        layer.cornerRadius = 18
        layer.cornerCurve = .continuous
        layer.borderWidth = chosen ? 1.5 : 1
        layer.borderColor = (chosen ? Theme.accent : Theme.veil(0.12)).cgColor

        let preview = UIView()
        preview.backgroundColor = page
        preview.layer.cornerRadius = 12
        preview.layer.cornerCurve = .continuous
        preview.layer.borderWidth = 1
        preview.layer.borderColor = edge.cgColor
        preview.layer.masksToBounds = true
        preview.isUserInteractionEnabled = false
        preview.translatesAutoresizingMaskIntoConstraints = false
        addSubview(preview)
        var rules: [NSLayoutConstraint] = [
            preview.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            preview.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            preview.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            preview.heightAnchor.constraint(equalToConstant: 58),
        ]
        // Three lines of a chat: theirs, mine, theirs.
        let shares: [CGFloat] = [0.62, 0.66, 0.45]
        for (index, share) in shares.enumerated() {
            let own = index == 1
            let line = UIView()
            line.backgroundColor = own ? mine : theirs
            line.layer.cornerRadius = 5
            line.translatesAutoresizingMaskIntoConstraints = false
            preview.addSubview(line)
            rules.append(line.topAnchor.constraint(equalTo: preview.topAnchor, constant: 8 + CGFloat(index) * 15))
            rules.append(line.heightAnchor.constraint(equalToConstant: 10))
            rules.append(line.widthAnchor.constraint(equalTo: preview.widthAnchor, multiplier: share, constant: -12))
            if own {
                rules.append(line.trailingAnchor.constraint(equalTo: preview.trailingAnchor, constant: -8))
            } else {
                rules.append(line.leadingAnchor.constraint(equalTo: preview.leadingAnchor, constant: 8))
            }
        }
        if let dot {
            let ball = UIView()
            ball.backgroundColor = dot
            ball.layer.cornerRadius = 7
            ball.translatesAutoresizingMaskIntoConstraints = false
            preview.addSubview(ball)
            rules.append(ball.widthAnchor.constraint(equalToConstant: 14))
            rules.append(ball.heightAnchor.constraint(equalToConstant: 14))
            rules.append(ball.trailingAnchor.constraint(equalTo: preview.trailingAnchor, constant: -7))
            rules.append(ball.bottomAnchor.constraint(equalTo: preview.bottomAnchor, constant: -6))
        }
        if locked {
            let lock = UIImageView(image: SettingsLook.symbol("lock.fill", size: 10, weight: .semibold))
            lock.tintColor = UIColor(hex: 0xE8ECF4)
            lock.contentMode = .center
            lock.backgroundColor = UIColor(white: 0, alpha: 0.55)
            lock.layer.cornerRadius = 10
            lock.layer.masksToBounds = true
            lock.translatesAutoresizingMaskIntoConstraints = false
            preview.addSubview(lock)
            rules.append(lock.widthAnchor.constraint(equalToConstant: 20))
            rules.append(lock.heightAnchor.constraint(equalToConstant: 20))
            rules.append(lock.leadingAnchor.constraint(equalTo: preview.leadingAnchor, constant: 6))
            rules.append(lock.bottomAnchor.constraint(equalTo: preview.bottomAnchor, constant: -6))
        }

        let name = UILabel()
        name.text = label
        name.font = .systemFont(ofSize: 12, weight: .semibold)
        name.textColor = chosen ? Theme.text : Theme.muted
        name.adjustsFontSizeToFitWidth = true
        name.minimumScaleFactor = 0.75
        let mark = UIImageView(image: SettingsLook.symbol("checkmark.circle.fill", size: 12, weight: .semibold))
        mark.tintColor = Theme.accent
        mark.isHidden = !chosen
        mark.setContentHuggingPriority(.required, for: .horizontal)
        let foot = UIStackView(arrangedSubviews: [name, mark])
        foot.axis = .horizontal
        foot.alignment = .center
        foot.spacing = 4
        foot.isUserInteractionEnabled = false
        foot.translatesAutoresizingMaskIntoConstraints = false
        addSubview(foot)
        rules.append(foot.topAnchor.constraint(equalTo: preview.bottomAnchor, constant: 8))
        rules.append(foot.centerXAnchor.constraint(equalTo: centerXAnchor))
        rules.append(foot.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 6))
        rules.append(foot.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -6))
        rules.append(foot.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9))
        NSLayoutConstraint.activate(rules)

        isAccessibilityElement = true
        accessibilityTraits.insert(.button)
        if chosen { accessibilityTraits.insert(.selected) }
        accessibilityLabel = locked ? spoken + ", доступна с Platina" : spoken
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }

    @objc private func pressed() {
        onPress?()
    }

    /// The card of a theme by its id, in the theme's own colours (the core's `settingsTheme`).
    static func of(_ id: String, chosen: Bool, locked: Bool) -> ThemeCard {
        let fields = ThemeStore.plainFields(id)
        let name = ThemeStore.themeName(id)
        let page = ThemeLook.color(fields["bg"] as? String) ?? UIColor.black
        let theirs = ThemeLook.color(fields["incoming"] as? String) ?? UIColor.darkGray
        let mine = ThemeLook.color(fields["bubble"] as? String) ?? UIColor.gray
        let dark = fields["dark"] as? Bool ?? true
        return ThemeCard(label: name, spoken: "Тема " + name, chosen: chosen, locked: locked, page: page, theirs: theirs, mine: mine,
                         edge: UIColor(white: dark ? 1 : 0, alpha: 0.12), dot: ThemeLook.color(fields["accent"] as? String))
    }

    /// Cards side by side that scroll sideways.
    static func strip(_ cards: [ThemeCard], width: CGFloat) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        let row = UIStackView(arrangedSubviews: cards)
        row.axis = .horizontal
        row.spacing = 9
        row.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(row)
        var rules: [NSLayoutConstraint] = [
            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ]
        for card in cards { rules.append(card.widthAnchor.constraint(equalToConstant: width)) }
        NSLayoutConstraint.activate(rules)
        return scroll
    }
}

/// «Оформление»: the theme, the night theme, the person's own colour of the interface, the size of the text in
/// chats. (The previous app: `Appearance` of `mobile/src/SettingsScreen.tsx`, `ThemeSettings.tsx`.)
///
/// Everything here is kept on this device, as in the previous app. Not on this page yet, because this app has
/// nothing to show them with: the app's icon, wallpapers of chats, the corners and the colour of one's own
/// messages (the chat here has no bubbles), «Пиксельный след», «Снег», «Ледяное стекло».
final class AppearanceViewController: SettingsPage {
    private let messenger: Messenger?
    private var lockedHint = false

    init(messenger: Messenger?) {
        self.messenger = messenger
        super.init(name: "Оформление")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        fill()
        askPlatina()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Back from «Ночная тема» or «Цвет интерфейса»: what they changed is shown.
        if isViewLoaded, !column.arrangedSubviews.isEmpty { fill() }
    }

    /// The palettes belong to Platina: the server says whether the account has it.
    private func askPlatina() {
        guard let messenger else { return }
        messenger.accountCall("usernameStatus", []) { [weak self] result in
            guard case .success(let body) = result else { return }
            let active = (body["platina"] as? [String: Any])?["active"] as? Bool ?? false
            guard active != ThemeStore.platina else { return }
            ThemeStore.platina = active
            self?.apply()
        }
    }

    /// Puts on what was just chosen. The app is redrawn when the look changed; otherwise only this page is.
    private func apply() {
        if !ThemeStore.refresh(reopen: ["appearance"]) { fill() }
    }

    private func fill() {
        clear()
        let state = ThemeStore.nightState()
        let night = state["night"] as? Bool ?? false
        let known = state["known"] as? Bool ?? true
        let auto = state["auto"] as? Bool ?? false
        let shown = state["shown"] as? String ?? "black"
        let day = state["day"] as? String ?? "black"
        let platina = ThemeStore.platina

        // «Тема»: the four built-in ones, then the palettes.
        let builtIn = UIStackView()
        builtIn.axis = .horizontal
        builtIn.distribution = .fillEqually
        builtIn.spacing = 7
        for item in ThemeStore.list("appearances") {
            guard let id = item["value"] as? String, let label = item["label"] as? String else { continue }
            let page = ThemeLook.color(item["color"] as? String) ?? UIColor.black
            let line = ThemeLook.color(item["line"] as? String) ?? UIColor.gray
            let card = ThemeCard(label: label, spoken: label + " тема", chosen: shown == id, locked: false, page: page, theirs: line, mine: line, edge: line, dot: nil)
            card.onPress = { [weak self] in self?.choose(id) }
            builtIn.addArrangedSubview(card)
        }
        let palettesName = UILabel()
        let palettesWords = NSMutableAttributedString(string: "ПАЛИТРЫ", attributes: [.kern: 1.2, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        if !platina {
            palettesWords.append(NSAttributedString(string: "  · с Platina", attributes: [.font: UIFont.systemFont(ofSize: 11), .foregroundColor: Theme.muted]))
        }
        palettesName.attributedText = palettesWords
        var cards: [ThemeCard] = []
        for item in ThemeStore.list("palettes") {
            guard let id = item["id"] as? String else { continue }
            let card = ThemeCard.of(id, chosen: platina && shown == id, locked: !platina)
            card.onPress = { [weak self] in self?.pick(palette: id) }
            cards.append(card)
        }
        let strip = ThemeCard.strip(cards, width: 112)
        let themes = UIStackView(arrangedSubviews: [builtIn, palettesName, strip])
        themes.axis = .vertical
        themes.spacing = 12
        themes.setCustomSpacing(16, after: builtIn)
        if lockedHint && !platina {
            themes.addArrangedSubview(SettingsLook.words("Палитры входят в Инвиз Platina. Войди в аккаунт с Platina, чтобы их включить.", size: 12, color: Theme.muted))
        }
        addGroup("Тема", rows: [SettingsLook.inset(themes, top: 14, side: 14, bottom: 14)])
        if night && day != ThemeStore.shownWithPlatina(ThemeStore.darkTheme) {
            add(SettingsLook.foot("Включён ночной режим. Дневная тема «" + ThemeStore.themeName(day) + "» вернётся, когда он выключится."), gap: 8)
        }

        // «Ночной режим» switches now; «Ночная тема» is when it switches by itself, and to which theme.
        let nightNow = SettingsSwitchRow(label: "Ночной режим", words: "", value: night, enabled: known)
        nightNow.onChange = { [weak self] (value: Bool) -> Void in
            DevicePreferences.set(["nightForced": value, "nightForcedAt": auto])
            self?.apply()
        }
        let kind = state["kind"] as? String ?? "off"
        let kindName = (ThemeStore.rules["nightLabels"] as? [String: Any])?[kind] as? String ?? ""
        let nightRule = SettingsRow(symbol: "moon", label: "Ночная тема", value: kindName)
        nightRule.onPress = { [weak self] in
            guard let self else { return }
            self.open(NightThemeViewController())
        }
        addGroup(rows: [nightNow, nightRule])

        // «Свои цвета». Only the colour of the interface: the chat here has no bubbles to colour.
        let own = DevicePreferences.word("accentColor")
        let accentRow = SettingsRow(label: "Цвет интерфейса", value: own == nil ? "Как в теме" : "Свой", swatch: Theme.accent)
        accentRow.onPress = { [weak self] in
            guard let self else { return }
            self.open(AccentColorViewController())
        }
        addGroup("Свои цвета", rows: [accentRow])

        // «Размер текста в чатах»: a sample message, then the sizes.
        let chosenSize = DevicePreferences.word("textSize") ?? "medium"
        let sample = PaddedSample(text: "Привет! Так будет выглядеть текст сообщений.", size: ThemeStore.textSize)
        var sizeRows: [UIView] = [SettingsLook.inset(sample, top: 14, side: 14, bottom: 12)]
        for item in ThemeStore.list("textSizes") {
            guard let id = item["id"] as? String, let label = item["label"] as? String else { continue }
            let row = SettingsRow(label: label, checked: id == chosenSize)
            row.onPress = { [weak self] in
                guard id != chosenSize else { return }
                DevicePreferences.set(["textSize": id])
                self?.fill()
            }
            sizeRows.append(row)
        }
        addGroup("Размер текста в чатах", rows: sizeRows)
        add(SettingsLook.foot("Тема, цвет и размер текста хранятся только на этом устройстве."), gap: 10)
    }

    /// A tap on a theme card: the tapped theme is what the screen shows next (the core's `settingsThemeTap`).
    private func choose(_ id: String) {
        let state = ThemeStore.nightState()
        let night = state["night"] as? Bool ?? false
        let known = state["known"] as? Bool ?? true
        let auto = state["auto"] as? Bool ?? false
        guard let plan = Core.view("settingsThemeTap", [id, night]) as? [String: Any] else { return }
        if plan["nightOff"] as? Bool == true {
            // «Светлая» at night turns the night mode off by hand, as the switch would.
            DevicePreferences.set(["nightForced": false, "nightForcedAt": known ? auto : true])
        }
        if let dark = plan["darkTheme"] as? String { ThemeStore.darkTheme = dark }
        if let mode = plan["mode"] as? String {
            // Before the night settings were touched, «Как в системе» meant following the system: that is kept.
            if DevicePreferences.word("nightMode") == nil {
                DevicePreferences.set(["nightMode": ThemeStore.mode == "system" ? "system" : "off"])
            }
            ThemeStore.mode = mode
        }
        apply()
    }

    private func pick(palette id: String) {
        guard ThemeStore.platina else {
            lockedHint = true
            fill()
            return
        }
        choose(id)
    }
}

/// A sample message: words on a rounded plate.
final class PaddedSample: UIView {
    init(text: String, size: CGFloat) {
        super.init(frame: .zero)
        let plate = UIView()
        plate.backgroundColor = ThemeStore.look.incoming
        plate.layer.cornerRadius = 18
        plate.layer.cornerCurve = .continuous
        plate.translatesAutoresizingMaskIntoConstraints = false
        addSubview(plate)
        let words = SettingsLook.words(text, size: size, color: Theme.text)
        words.translatesAutoresizingMaskIntoConstraints = false
        plate.addSubview(words)
        NSLayoutConstraint.activate([
            plate.topAnchor.constraint(equalTo: topAnchor),
            plate.bottomAnchor.constraint(equalTo: bottomAnchor),
            plate.leadingAnchor.constraint(equalTo: leadingAnchor),
            plate.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            words.topAnchor.constraint(equalTo: plate.topAnchor, constant: 9),
            words.bottomAnchor.constraint(equalTo: plate.bottomAnchor, constant: -9),
            words.leadingAnchor.constraint(equalTo: plate.leadingAnchor, constant: 12),
            words.trailingAnchor.constraint(equalTo: plate.trailingAnchor, constant: -12),
        ])
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { return nil }
}

/// «Ночная тема»: when the night theme turns on by itself (with the system, never, by the clock, by the
/// screen's brightness) and which theme it is. (The previous app: `NightSettings` of `SettingsScreen.tsx`.)
final class NightThemeViewController: SettingsPage {
    init() {
        super.init(name: "Ночная тема")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        fill()
    }

    private func apply() {
        if !ThemeStore.refresh(reopen: ["appearance", "night"]) { fill() }
    }

    private func fill() {
        clear()
        let state = ThemeStore.nightState()
        let kind = state["kind"] as? String ?? "off"
        let labels = ThemeStore.rules["nightLabels"] as? [String: Any] ?? [:]
        var modes: [UIView] = []
        for mode in ThemeStore.words("nightModes") {
            let row = SettingsRow(label: labels[mode] as? String ?? mode, checked: mode == kind)
            row.onPress = { [weak self] in
                DevicePreferences.set(["nightMode": mode, "nightForced": NSNull(), "nightForcedAt": NSNull()])
                self?.apply()
            }
            modes.append(row)
        }
        addGroup(rows: modes)

        if kind == "schedule" {
            let from = DevicePreferences.word("nightFrom") ?? "22:00"
            let until = DevicePreferences.word("nightTo") ?? "07:00"
            let start = SettingsRow(symbol: "moon", label: "Начало", value: from)
            start.onPress = { [weak self] in self?.askClock(heading: "Начало", name: "nightFrom", value: from) }
            let end = SettingsRow(symbol: "sun.max", label: "Конец", value: until)
            end.onPress = { [weak self] in self?.askClock(heading: "Конец", name: "nightTo", value: until) }
            addGroup("Время использования", rows: [start, end])
        }
        if kind == "auto" {
            let levels: [Double] = [0.1, 0.25, 0.4, 0.6]
            let now = DevicePreferences.number("nightBrightness") ?? 0.25
            var chosen = -1
            for (index, level) in levels.enumerated() where abs(level - now) < 0.01 { chosen = index }
            let segments = SettingsSegments(labels: levels.map { (level: Double) -> String in return "\(Int((level * 100).rounded()))%" }, chosen: chosen, spoken: "Порог яркости")
            segments.onPick = { [weak self] (index: Int) -> Void in
                DevicePreferences.set(["nightBrightness": levels[index]])
                self?.apply()
            }
            let words = SettingsLook.words("Ночная тема включится, когда яркость экрана опустится до \(Int((now * 100).rounded()))% и ниже.", size: 12, color: Theme.muted)
            let box = UIStackView(arrangedSubviews: [segments, words])
            box.axis = .vertical
            box.spacing = 10
            addGroup("Порог яркости", rows: [SettingsLook.inset(box, top: 14, side: 14, bottom: 14)])
        }
        if kind == "system" {
            add(SettingsLook.foot("Ночная тема включается вместе с тёмным оформлением iPhone."), gap: 10)
        }

        // «Выбранная ночная тема»: the dark built-in ones, and the palettes with Platina.
        var ids = ThemeStore.words("nightThemes")
        if ThemeStore.platina {
            for item in ThemeStore.list("palettes") {
                if let id = item["id"] as? String { ids.append(id) }
            }
        }
        let chosenNight = ThemeStore.shownWithPlatina(ThemeStore.darkTheme)
        var cards: [ThemeCard] = []
        for id in ids {
            let card = ThemeCard.of(id, chosen: id == chosenNight, locked: false)
            card.onPress = { [weak self] in
                ThemeStore.darkTheme = id
                self?.apply()
            }
            cards.append(card)
        }
        let strip = ThemeCard.strip(cards, width: 112)
        addGroup("Выбранная ночная тема", rows: [SettingsLook.inset(strip, top: 14, side: 14, bottom: 14)])
        add(SettingsLook.foot("Сама по себе ночная тема включается, когда приложение открывают или возвращаются в него. Открытый чат при этом не перерисовывается."), gap: 10)
    }

    private func askClock(heading: String, name: String, value: String) {
        let page = ClockViewController(heading: heading, value: value) { [weak self] (picked: String) -> Void in
            DevicePreferences.set([name: picked, "nightForced": NSNull(), "nightForcedAt": NSNull()])
            self?.apply()
        }
        open(page)
    }
}

/// «Начало» / «Конец»: an hour and a minute of the day.
final class ClockViewController: SettingsPage {
    private let picker = UIDatePicker()
    private let start: String
    private let done: (String) -> Void

    init(heading: String, value: String, done: @escaping (String) -> Void) {
        self.start = value
        self.done = done
        super.init(name: heading)
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        picker.datePickerMode = .time
        picker.preferredDatePickerStyle = .wheels
        picker.locale = Locale(identifier: "ru_RU")
        picker.minuteInterval = 15
        let pieces = start.split(separator: ":")
        var parts = DateComponents()
        parts.hour = pieces.count == 2 ? Int(pieces[0]) ?? 22 : 22
        parts.minute = pieces.count == 2 ? Int(pieces[1]) ?? 0 : 0
        if let date = Calendar.current.date(from: parts) { picker.date = date }
        add(picker, gap: 8)
        let ready = SettingsButton(label: "Готово")
        ready.onPress = { [weak self] in self?.finish() }
        add(ready, gap: 16)
    }

    private func finish() {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: picker.date)
        let words = String(format: "%02ld:%02ld", parts.hour ?? 0, parts.minute ?? 0)
        let stack = navigationController
        stack?.popViewController(animated: true)
        done(words)
    }
}

/// «Цвет интерфейса»: the person's own accent colour over whichever theme is on — a row of colours, «Свой цвет»
/// with three sliders, and «Как в теме» to go back. The choice is put on at once: the app itself is the
/// preview. (The previous app: `mobile/src/ColorSettings.tsx`; the rules are the core's `settingsTheme`.)
final class AccentColorViewController: SettingsPage {
    /// «Свой цвет» is open, and where its sliders stand (a grey has no hue of its own: the slider must not jump).
    private static var custom = false
    private static var sliders: (h: Double, s: Double, v: Double)?
    private let hue = UISlider()
    private let saturation = UISlider()
    private let brightness = UISlider()
    private let code = UILabel()

    init() {
        super.init(name: "Цвет интерфейса")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        fill()
    }

    private var choices: [String] { return ThemeStore.words("accentChoices") }
    private var base: String { return DevicePreferences.word("accentColor") ?? choices.first ?? "#3568E7" }

    private func set(_ color: String?) {
        var value: Any = NSNull()
        if let color { value = color }
        DevicePreferences.set(["accentColor": value])
        if !ThemeStore.refresh(reopen: ["appearance", "accent"]) { fill() }
    }

    private func fill() {
        clear()
        let current = DevicePreferences.word("accentColor")

        // How it looks, in the colours that are on right now.
        let link = SettingsLook.words("ссылка · 12:30", size: 13, color: Theme.accent)
        let sampleButton = PaddedLabel()
        sampleButton.text = "Кнопка"
        sampleButton.font = .systemFont(ofSize: 14, weight: .bold)
        sampleButton.textColor = Theme.onAccent
        sampleButton.backgroundColor = Theme.accent
        sampleButton.textAlignment = .center
        sampleButton.layer.cornerRadius = 12
        sampleButton.layer.masksToBounds = true
        sampleButton.setContentHuggingPriority(.required, for: .horizontal)
        let sample = UIStackView(arrangedSubviews: [SettingsLook.words("Нравится, оставляю", size: 15, color: Theme.text), link, sampleButton])
        sample.axis = .vertical
        sample.alignment = .leading
        sample.spacing = 6
        sample.isAccessibilityElement = false

        // The colours offered before «Свой цвет»: two rows of round ones.
        let rowsOfColours = UIStackView()
        rowsOfColours.axis = .vertical
        rowsOfColours.spacing = 10
        var line = UIStackView()
        for (index, color) in choices.enumerated() {
            if index % 6 == 0 {
                line = UIStackView()
                line.axis = .horizontal
                line.distribution = .equalSpacing
                rowsOfColours.addArrangedSubview(line)
            }
            let on = current == color
            let ball = UIButton(type: .custom)
            ball.backgroundColor = ThemeLook.color(color) ?? UIColor.gray
            ball.layer.cornerRadius = 20
            ball.layer.borderWidth = on ? 3 : 0
            ball.layer.borderColor = Theme.text.cgColor
            if on {
                ball.setImage(SettingsLook.symbol("checkmark", size: 15, weight: .bold), for: .normal)
                ball.tintColor = UIColor.white
                ball.accessibilityTraits.insert(.selected)
            }
            ball.tag = index
            ball.accessibilityLabel = "Цвет " + color
            ball.translatesAutoresizingMaskIntoConstraints = false
            ball.widthAnchor.constraint(equalToConstant: 40).isActive = true
            ball.heightAnchor.constraint(equalToConstant: 40).isActive = true
            ball.addTarget(self, action: #selector(picked(_:)), for: .touchUpInside)
            line.addArrangedSubview(ball)
        }

        let asTheme = SettingsButton(label: "Как в теме", kind: current == nil ? .primary : .secondary)
        asTheme.onPress = { [weak self] in
            AccentColorViewController.custom = false
            self?.set(nil)
        }
        let ownColour = SettingsButton(label: "Свой цвет", kind: AccentColorViewController.custom ? .primary : .secondary)
        ownColour.onPress = { [weak self] in self?.toggleCustom() }
        let buttons = UIStackView(arrangedSubviews: [asTheme, ownColour])
        buttons.axis = .horizontal
        buttons.distribution = .fillEqually
        buttons.spacing = 8

        let box = UIStackView(arrangedSubviews: [sample, rowsOfColours, buttons])
        box.axis = .vertical
        box.spacing = 16
        if AccentColorViewController.custom {
            let position = AccentColorViewController.sliders ?? hsv(of: base)
            hue.minimumValue = 0
            hue.maximumValue = 359.9
            hue.value = Float(position.h)
            saturation.minimumValue = 0
            saturation.maximumValue = 1
            saturation.value = Float(position.s)
            brightness.minimumValue = 0.12
            brightness.maximumValue = 1
            brightness.value = Float(position.v)
            let named: [(String, UISlider)] = [("Оттенок", hue), ("Насыщенность", saturation), ("Яркость", brightness)]
            for (name, slider) in named {
                slider.minimumTrackTintColor = Theme.accent
                slider.accessibilityLabel = name
                slider.removeTarget(self, action: nil, for: .allEvents)
                slider.addTarget(self, action: #selector(moved), for: .valueChanged)
                slider.addTarget(self, action: #selector(released), for: [.touchUpInside, .touchUpOutside, .touchCancel])
                let part = UIStackView(arrangedSubviews: [SettingsLook.words(name, size: 12, color: Theme.muted), slider])
                part.axis = .vertical
                part.spacing = 2
                box.addArrangedSubview(part)
            }
            code.text = current ?? base
            code.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            code.textColor = Theme.muted
            code.textAlignment = .center
            box.addArrangedSubview(code)
        }
        addGroup(rows: [SettingsLook.inset(box, top: 16, side: 16, bottom: 16)])
        add(SettingsLook.foot("Цвет действует поверх любой темы. Если он плохо читается на её фоне, приложение слегка сдвигает его, чтобы текст оставался разборчивым."), gap: 10)
    }

    private func hsv(of color: String) -> (h: Double, s: Double, v: Double) {
        let read = Core.view("settingsColorHsv", [color]) as? [String: Any] ?? [:]
        let part = { (name: String) -> Double in return (read[name] as? NSNumber)?.doubleValue ?? 0 }
        return (part("h"), part("s"), part("v"))
    }

    private func colourOfSliders() -> String? {
        let args: [Any] = [Double(hue.value), Double(saturation.value), Double(brightness.value)]
        return Core.view("settingsHsvColor", args) as? String
    }

    @objc private func picked(_ sender: UIButton) {
        let list = choices
        guard sender.tag >= 0, sender.tag < list.count else { return }
        AccentColorViewController.custom = false
        set(list[sender.tag])
    }

    private func toggleCustom() {
        AccentColorViewController.sliders = hsv(of: base)
        AccentColorViewController.custom.toggle()
        if AccentColorViewController.custom && DevicePreferences.word("accentColor") == nil {
            set(base)
        } else {
            fill()
        }
    }

    /// While a slider moves only the code of the colour follows; the colour is put on when the finger lets go.
    @objc private func moved() {
        AccentColorViewController.sliders = (Double(hue.value), Double(saturation.value), Double(brightness.value))
        if let color = colourOfSliders() { code.text = color }
    }

    @objc private func released() {
        AccentColorViewController.sliders = (Double(hue.value), Double(saturation.value), Double(brightness.value))
        guard let color = colourOfSliders() else { return }
        set(color)
    }
}
