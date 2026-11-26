import UIKit

/// A theme as a small picture of a chat in its own colours, with its name under it. The one that is on has a
/// mark; a palette the account cannot use yet has a lock.
final class ThemeCard: UIControl {
    var onPress: (() -> Void)?

    /// Which of the previous app's cards this is (ThemeSettings.tsx): `tile` — one of the four built-in themes
    /// (at least 110 tall, 10 around a picture of 51 with three thin lines, 10 to the name); `palette` — a palette
    /// (118 wide, 8 around a picture of 92 with three bars of 16 and a ball of 22, 8 to the name); `plain` — the
    /// card of «Ночная тема».
    enum Kind { case plain, tile, palette }

    /// `page`: the theme's background; `theirs` and `mine`: the two kinds of lines; `dot`: its accent (palettes).
    init(label: String, spoken: String, chosen: Bool, locked: Bool, page: UIColor, theirs: UIColor, mine: UIColor, edge: UIColor, dot: UIColor?, kind: Kind = .plain) {
        super.init(frame: .zero)
        backgroundColor = chosen ? ThemeStore.look.accentSoft : .clear
        layer.cornerRadius = kind == .plain ? 18 : 20
        layer.cornerCurve = .continuous
        layer.borderWidth = kind == .palette ? 1.5 : kind == .tile ? 1 : (chosen ? 1.5 : 1)
        layer.borderColor = (chosen ? Theme.accent : Theme.veil(0.12)).cgColor
        // The room around the picture counts the card's own border, as the previous app's padding stands inside it.
        let around: CGFloat = kind == .tile ? 11 : kind == .palette ? 9.5 : 8
        let pictureHeight: CGFloat = kind == .tile ? 51 : kind == .palette ? 92 : 58

        let preview = UIView()
        preview.backgroundColor = page
        preview.layer.cornerRadius = kind == .palette ? 14 : 12
        preview.layer.cornerCurve = .continuous
        preview.layer.borderWidth = kind == .palette ? 0 : 1
        preview.layer.borderColor = edge.cgColor
        preview.layer.masksToBounds = true
        preview.isUserInteractionEnabled = false
        preview.translatesAutoresizingMaskIntoConstraints = false
        addSubview(preview)
        var rules: [NSLayoutConstraint] = [
            preview.topAnchor.constraint(equalTo: topAnchor, constant: around),
            preview.leadingAnchor.constraint(equalTo: leadingAnchor, constant: around),
            preview.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -around),
            preview.heightAnchor.constraint(equalToConstant: pictureHeight),
        ]
        // Three lines of a chat: theirs, mine, theirs. A built-in theme's are thin and its last one stands at the
        // far side (68 %, 48 %, 52 % of the room inside the picture's 8 and its border); a palette's are bars of 16.
        let shares: [CGFloat] = kind == .tile ? [0.68, 0.48, 0.52] : kind == .palette ? [0.62, 0.70, 0.45] : [0.62, 0.66, 0.45]
        let lineHeight: CGFloat = kind == .tile ? 7 : kind == .palette ? 16 : 10
        let lineStep: CGFloat = kind == .tile ? 12 : kind == .palette ? 22 : 15
        let lineInset: CGFloat = kind == .tile ? 9 : 8
        for (index, share) in shares.enumerated() {
            let own = kind == .tile ? index == 2 : index == 1
            let line = UIView()
            line.backgroundColor = own ? mine : theirs
            line.layer.cornerRadius = kind == .tile ? 4 : kind == .palette ? 8 : 5
            line.translatesAutoresizingMaskIntoConstraints = false
            preview.addSubview(line)
            rules.append(line.topAnchor.constraint(equalTo: preview.topAnchor, constant: lineInset + CGFloat(index) * lineStep))
            rules.append(line.heightAnchor.constraint(equalToConstant: lineHeight))
            rules.append(line.widthAnchor.constraint(equalTo: preview.widthAnchor, multiplier: share, constant: kind == .plain ? -12 : -2 * lineInset * share))
            if own {
                rules.append(line.trailingAnchor.constraint(equalTo: preview.trailingAnchor, constant: -lineInset))
            } else {
                rules.append(line.leadingAnchor.constraint(equalTo: preview.leadingAnchor, constant: lineInset))
            }
        }
        if let dot {
            let ballSize: CGFloat = kind == .palette ? 22 : 14
            let ball = UIView()
            ball.backgroundColor = dot
            ball.layer.cornerRadius = ballSize / 2
            ball.translatesAutoresizingMaskIntoConstraints = false
            preview.addSubview(ball)
            rules.append(ball.widthAnchor.constraint(equalToConstant: ballSize))
            rules.append(ball.heightAnchor.constraint(equalToConstant: ballSize))
            rules.append(ball.trailingAnchor.constraint(equalTo: preview.trailingAnchor, constant: kind == .palette ? -8 : -7))
            rules.append(ball.bottomAnchor.constraint(equalTo: preview.bottomAnchor, constant: kind == .palette ? -8 : -6))
        }
        if locked {
            let lock = UIImageView(image: SettingsLook.symbol("ion:lock-closed", size: 10))
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
        let mark = UIImageView(image: SettingsLook.symbol("ion:checkmark-circle", size: kind == .tile ? 15 : 14))
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
        rules.append(foot.topAnchor.constraint(equalTo: preview.bottomAnchor, constant: kind == .tile ? 10 : 8))
        rules.append(foot.centerXAnchor.constraint(equalTo: centerXAnchor))
        rules.append(foot.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 6))
        rules.append(foot.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -6))
        if kind == .tile {
            // `minHeight: 110`: the name stands right under the picture and the rest of the height is under it.
            rules.append(foot.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -around))
            rules.append(heightAnchor.constraint(greaterThanOrEqualToConstant: 110))
            let least = heightAnchor.constraint(equalToConstant: 110)
            least.priority = .defaultHigh
            rules.append(least)
        } else {
            rules.append(foot.bottomAnchor.constraint(equalTo: bottomAnchor, constant: kind == .palette ? -around : -9))
        }
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
    static func of(_ id: String, chosen: Bool, locked: Bool, kind: Kind = .plain) -> ThemeCard {
        let fields = ThemeStore.plainFields(id)
        let name = ThemeStore.themeName(id)
        let page = ThemeLook.color(fields["bg"] as? String) ?? UIColor.black
        let theirs = ThemeLook.color(fields["incoming"] as? String) ?? UIColor.darkGray
        let mine = ThemeLook.color(fields["bubble"] as? String) ?? UIColor.gray
        let dark = fields["dark"] as? Bool ?? true
        return ThemeCard(label: name, spoken: "Тема " + name, chosen: chosen, locked: locked, page: page, theirs: theirs, mine: mine,
                         edge: UIColor(white: dark ? 1 : 0, alpha: 0.12), dot: ThemeLook.color(fields["accent"] as? String), kind: kind)
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
    /// The page has been on the screen once: its first appearance follows `build()`, which filled it already.
    private var appeared = false

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
        // Back from «Ночная тема»: what it changed is shown.
        if appeared { fill() }
        appeared = true
    }

    /// The palettes belong to Platina: the server says whether the account has it.
    private func askPlatina() {
        guard let messenger else { return }
        messenger.accountCall("usernameStatus", []) { [weak self] result in
            guard case .success(let body) = result else { return }
            let active = (body["platina"] as? [String: Any])?["active"] as? Bool ?? false
            guard active != ThemeStore.platina else { return }
            ThemeStore.platina = active
            guard let self else { return }
            // The answer may come while «Ночная тема» is open over this page: it stays open.
            if !ThemeStore.refresh(reopen: self.openPages()) { self.fill() }
        }
    }

    /// A colour's sheet over this page changed something the page shows (Settings/ColorSheets.swift).
    func refill() {
        guard isViewLoaded else { return }
        fill()
    }

    /// Puts on what was just chosen. The app is redrawn when the look changed; otherwise only this page is.
    private func apply() {
        if !ThemeStore.refresh(reopen: ["appearance"]) { fill() }
    }

    /// This page and those open over it, by the names the settings reopen them with after the app is redrawn.
    private func openPages() -> [String] {
        var pages: [String] = ["appearance"]
        guard let stack = navigationController?.viewControllers, let at = stack.firstIndex(where: { (page: UIViewController) -> Bool in page === self }) else { return pages }
        for page in stack.dropFirst(at + 1) {
            if page is NightThemeViewController {
                pages.append("night")
            } else {
                break
            }
        }
        return pages
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
        builtIn.spacing = 9 // ThemeSettings.tsx: `gap: 9`
        for item in ThemeStore.list("appearances") {
            guard let id = item["value"] as? String, let label = item["label"] as? String else { continue }
            let page = ThemeLook.color(item["color"] as? String) ?? UIColor.black
            let line = ThemeLook.color(item["line"] as? String) ?? UIColor.gray
            let card = ThemeCard(label: label, spoken: label + " тема", chosen: shown == id, locked: false, page: page, theirs: line, mine: line, edge: line, dot: nil, kind: .tile)
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
            let card = ThemeCard.of(id, chosen: platina && shown == id, locked: !platina, kind: .palette)
            card.onPress = { [weak self] in self?.pick(palette: id) }
            cards.append(card)
        }
        let strip = ThemeCard.strip(cards, width: 118)
        let themes = UIStackView(arrangedSubviews: [builtIn, palettesName, strip])
        themes.axis = .vertical
        themes.spacing = 9 // ThemeSettings.tsx: 9 from «Палитры» to its cards, 16 above it
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
        let nightRule = SettingsRow(symbol: "ion:moon", label: "Ночная тема", value: kindName)
        nightRule.onPress = { [weak self] in
            guard let self else { return }
            self.open(NightThemeViewController())
        }
        addGroup(rows: [nightNow, nightRule])

        // Effects: «Иконка приложения» (Settings/AppearanceEffects.swift).
        addIconGroup()
        // «Свои цвета». Only the colour of the interface: the chat here has no bubbles to colour.
        let own = DevicePreferences.word("accentColor")
        let accentRow = SettingsRow(label: "Цвет интерфейса", value: own == nil ? "Как в теме" : "Свой", swatch: Theme.accent)
        accentRow.onPress = { [weak self] in
            guard let self else { return }
            // ColorSettings.tsx: a sheet over this page, not a page of its own.
            ColourSheets.present(.accent, over: self)
        }
        // ChatLook: «Цвет своих сообщений» — seen in chats with bubbles (Sources/ChatLook/ChatLookSettings.swift).
        addGroup("Свои цвета", rows: [accentRow, ChatLookSettings.colourRow(page: self)])
        // Effects: «Пиксельный след», «Снег», «Ледяное стекло» (Settings/AppearanceEffects.swift).
        addEffectGroups()
        // «Свечение панели»: the bottom bar's lights on or off, and their own colour (Settings/BarGlowSettings.swift).
        addBarGlowGroup(refresh: { [weak self] in self?.fill() })

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
        // ChatLook: «Обои чатов», «Пузыри сообщений», «Углы сообщений» (Sources/ChatLook/ChatLookSettings.swift).
        ChatLookSettings.addGroups(to: self, refill: { [weak self] in self?.fill() })
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
            let start = SettingsRow(symbol: "ion:moon", label: "Начало", value: from)
            start.onPress = { [weak self] in self?.askClock(heading: "Начало", name: "nightFrom", value: from) }
            let end = SettingsRow(symbol: "ion:sunny", label: "Конец", value: until)
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
