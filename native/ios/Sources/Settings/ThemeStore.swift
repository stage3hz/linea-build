import UIKit

/// What this phone keeps of the person's choices for the look and the chats: one JSON record, read back through
/// the core, so an old or broken record never breaks a screen. Kept on this device only — the server knows
/// nothing of it. (The previous app: `mobile/src/chatPreferences.ts`; the rules are the core's `settingsPreferences`.)
enum DevicePreferences {
    static let changed = Notification.Name("invizent.device-preferences")
    private static let key = "invizent.chat-preferences.v1"
    private static var kept: [String: Any]?

    /// Every preference with its value (a missing one has its default; «not chosen» is `NSNull`).
    static var all: [String: Any] {
        if let kept { return kept }
        var raw: Any = NSNull()
        if let stored = UserDefaults.standard.string(forKey: key) { raw = stored }
        let read = Core.view("settingsPreferences", [raw]) as? [String: Any] ?? [:]
        kept = read
        return read
    }

    /// Changes some of them. `quiet`: nobody is told (the change is part of working out the look itself).
    static func set(_ change: [String: Any], quiet: Bool = false) {
        var next = all
        for (name, value) in change { next[name] = value }
        guard let text = Core.text(next) else { return }
        UserDefaults.standard.set(text, forKey: key)
        kept = Core.view("settingsPreferences", [text]) as? [String: Any] ?? next
        if !quiet { NotificationCenter.default.post(name: changed, object: nil) }
    }

    static func word(_ name: String) -> String? { return all[name] as? String }
    static func flag(_ name: String) -> Bool? { return all[name] as? Bool }
    static func number(_ name: String) -> Double? { return (all[name] as? NSNumber)?.doubleValue }
    /// The value as it is handed to the core: `NSNull` when there is none.
    static func item(_ name: String, otherwise: Any = NSNull()) -> Any {
        if let value = all[name] { return value }
        return otherwise
    }
}

/// The colours of one theme, as the app draws with them. Made from the core's answer (`settingsTheme`: the
/// reference's own `Theme`); without an answer it is «Чёрная», the app's own look.
struct ThemeLook {
    var id = "black"
    var dark = true
    var black = true
    var bg = UIColor(hex: 0x08090A)
    var text = UIColor(hex: 0xE5E5E6)
    var muted = UIColor(hex: 0x8A8F98)
    var subtle = UIColor(hex: 0x62666D)
    var accent = UIColor(hex: 0xE5E5E6)
    var onAccent = UIColor(hex: 0x08090A)
    var accentSoft = UIColor(white: 1, alpha: 0.07)
    var surface2 = UIColor(red: 22 / 255, green: 23 / 255, blue: 24 / 255, alpha: 0.92)
    var border = UIColor(hex: 0x23252A)
    var danger = UIColor(hex: 0xFF9CB0)
    /// Settings: the reference's `dangerBg` (the circle of «Выйти из аккаунта») and `glassOpaque` (the flat card of a
    /// group in «Чёрная»).
    var dangerBg = UIColor(red: 69 / 255, green: 20 / 255, blue: 31 / 255, alpha: 0.88)
    var glassOpaque = UIColor(hex: 0x0F1011)
    /// The reference's flat glass (inside an opaque sheet, FlatGlassScope): `glassClear` fill, `glassBorder` rim,
    /// `glassHighlight` line.
    var glassClear = UIColor(red: 15 / 255, green: 16 / 255, blue: 17 / 255, alpha: 0.26)
    var glassBorder = UIColor(white: 1, alpha: 0.08)
    var glassHighlight = UIColor(white: 1, alpha: 0.10)
    /// The reference's `accentGradient` (the main `Button`); empty: the accent alone.
    var accentGradient: [UIColor] = [UIColor(hex: 0xF2F2F2), UIColor(hex: 0xC8C8C8)]
    var bubble = UIColor(red: 31 / 255, green: 32 / 255, blue: 35 / 255, alpha: 0.96)
    var incoming = UIColor(red: 22 / 255, green: 23 / 255, blue: 24 / 255, alpha: 0.96)
    /// The reference's `glass` and `glassBorder` (theme.tsx).
    var glass = UIColor(red: 15 / 255, green: 16 / 255, blue: 17 / 255, alpha: 0.62)
    var glassBorder = UIColor(white: 1, alpha: 0.08)
    /// The reference's `glassHighlight` (theme.tsx): the light ring of a cover without a picture.
    var glassHighlight = UIColor(white: 1, alpha: 0.10)
    /// What the look was made from: two looks with the same words here are the same look.
    var source = "black|"

    init() {}

    init(id: String, fields: [String: Any]) {
        self.id = id
        dark = fields["dark"] as? Bool ?? true
        black = fields["black"] as? Bool ?? false
        bg = ThemeLook.color(fields["bg"] as? String) ?? bg
        text = ThemeLook.color(fields["text"] as? String) ?? text
        muted = ThemeLook.color(fields["muted"] as? String) ?? muted
        subtle = ThemeLook.color(fields["subtle"] as? String) ?? subtle
        accent = ThemeLook.color(fields["accent"] as? String) ?? accent
        onAccent = ThemeLook.color(fields["onAccent"] as? String) ?? onAccent
        accentSoft = ThemeLook.color(fields["accentSoft"] as? String) ?? accentSoft
        surface2 = ThemeLook.color(fields["surface2"] as? String) ?? surface2
        border = ThemeLook.color(fields["border"] as? String) ?? border
        danger = ThemeLook.color(fields["danger"] as? String) ?? danger
        dangerBg = ThemeLook.color(fields["dangerBg"] as? String) ?? dangerBg
        glassOpaque = ThemeLook.color(fields["glassOpaque"] as? String) ?? glassOpaque
        glassClear = ThemeLook.color(fields["glassClear"] as? String) ?? glassClear
        glassBorder = ThemeLook.color(fields["glassBorder"] as? String) ?? glassBorder
        glassHighlight = ThemeLook.color(fields["glassHighlight"] as? String) ?? glassHighlight
        accentGradient = (fields["accentGradient"] as? [Any] ?? []).compactMap { (item: Any) -> UIColor? in ThemeLook.color(item as? String) }
        bubble = ThemeLook.color(fields["bubble"] as? String) ?? bubble
        incoming = ThemeLook.color(fields["incoming"] as? String) ?? incoming
        glass = ThemeLook.color(fields["glass"] as? String) ?? glass
        glassBorder = ThemeLook.color(fields["glassBorder"] as? String) ?? glassBorder
        glassHighlight = ThemeLook.color(fields["glassHighlight"] as? String) ?? glassHighlight
        source = id + "|" + (fields["accent"] as? String ?? "")
    }

    /// `#RRGGBB`, `rgba(r,g,b,a)` or `transparent`, as the reference writes a colour.
    static func color(_ text: String?) -> UIColor? {
        guard let text else { return nil }
        if text == "transparent" { return UIColor.clear }
        if text.hasPrefix("#") {
            guard text.count == 7, let value = UInt32(text.dropFirst(), radix: 16) else { return nil }
            return UIColor(hex: value)
        }
        guard text.hasPrefix("rgb"), let open = text.firstIndex(of: "("), let close = text.lastIndex(of: ")"), open < close else { return nil }
        let inside = text[text.index(after: open)..<close]
        let parts: [Double?] = inside.split(separator: ",").map { (piece: Substring) -> Double? in
            return Double(piece.trimmingCharacters(in: .whitespaces))
        }
        guard parts.count >= 3, let red = parts[0], let green = parts[1], let blue = parts[2] else { return nil }
        var alpha = 1.0
        if parts.count > 3, let given = parts[3] { alpha = given }
        return UIColor(red: CGFloat(red) / 255, green: CGFloat(green) / 255, blue: CGFloat(blue) / 255, alpha: CGFloat(alpha))
    }

    /// A thin veil over the page: white on a dark theme, black on a light one.
    func veil(_ alpha: CGFloat) -> UIColor {
        return UIColor(white: dark ? 1 : 0, alpha: alpha)
    }
}

/// Which theme is on, and putting it on.
///
/// The choice is kept on this device, as in the previous app (`mobile/src/storage.ts`, `themePreference.ts`): the
/// day theme, the night theme, and the night rule among the device preferences. Nothing chosen yet means
/// «Чёрная», the app's own look. Which theme is shown at a given moment is the core's answer (`settingsNight`).
///
/// A change made in the settings redraws the app at once: the shell is built again in the new colours and the
/// settings page is opened again on top. A change that comes by itself (the night theme by the clock, by the
/// system's look or by the screen's brightness) is put on when the app is opened or comes back to the front
/// while the sections are on the screen — an open chat or page is never rebuilt under the person's hands.
enum ThemeStore {
    static let changed = Notification.Name("invizent.theme-changed")
    private static let modeKey = "invizent.theme.v1"
    private static let darkKey = "invizent.dark-theme.v1"
    private static let platinaKey = "invizent.platina.v1"
    private static var current: ThemeLook?
    private static weak var window: UIWindow?

    /// The look that is on.
    static var look: ThemeLook {
        if let current { return current }
        let fresh = compute()
        current = fresh
        return fresh
    }

    private static func stored() -> (mode: String, dark: String) {
        let defaults = UserDefaults.standard
        let mode = defaults.string(forKey: modeKey) ?? "black"
        let dark = defaults.string(forKey: darkKey) ?? "black"
        let read = Core.view("settingsStoredTheme", [mode, dark]) as? [String: Any]
        return (read?["mode"] as? String ?? "black", read?["darkTheme"] as? String ?? "black")
    }

    /// The day theme the person chose: light, dark, black, graphite, a palette, or system.
    static var mode: String {
        get { return stored().mode }
        set { UserDefaults.standard.set(newValue, forKey: modeKey) }
    }

    /// The night theme the person chose.
    static var darkTheme: String {
        get { return stored().dark }
        set { UserDefaults.standard.set(newValue, forKey: darkKey) }
    }

    /// Whether the account has Platina, as the server last said (the palettes belong to it).
    static var platina: Bool {
        get { return UserDefaults.standard.bool(forKey: platinaKey) }
        set { UserDefaults.standard.set(newValue, forKey: platinaKey) }
    }

    /// A theme as it is shown to this account: a palette without Platina is «Тёмная»; the choice itself is kept.
    static func shownWithPlatina(_ id: String) -> String {
        return Core.view("settingsWithPlatina", [id, platina]) as? String ?? id
    }

    /// The lists the pages show (`settingsRules`): names of the themes, sizes of the text, colours to choose from…
    static let rules: [String: Any] = Core.view("settingsRules", []) as? [String: Any] ?? [:]

    static func list(_ name: String) -> [[String: Any]] {
        return rules[name] as? [[String: Any]] ?? []
    }

    static func words(_ name: String) -> [String] {
        return rules[name] as? [String] ?? []
    }

    static func themeName(_ id: String) -> String {
        return (rules["themeNames"] as? [String: Any])?[id] as? String ?? id
    }

    /// The colours of a theme by its id, with nothing of the person's own laid over (for the cards).
    static func plainFields(_ id: String) -> [String: Any] {
        return Core.view("settingsTheme", [id, NSNull(), NSNull()]) as? [String: Any] ?? [:]
    }

    /// The night theme right now (`settingsNight`): `kind`, `auto`, `known`, `expired`, `night`, `shown`, `day`.
    static func nightState() -> [String: Any] {
        var rule: [String: Any] = [:]
        rule["mode"] = DevicePreferences.item("nightMode")
        rule["from"] = DevicePreferences.item("nightFrom", otherwise: "22:00")
        rule["to"] = DevicePreferences.item("nightTo", otherwise: "07:00")
        rule["brightness"] = DevicePreferences.item("nightBrightness", otherwise: 0.25)
        rule["forced"] = DevicePreferences.item("nightForced")
        rule["forcedAt"] = DevicePreferences.item("nightForcedAt")
        let chosen = stored()
        let screen: UIScreen = window?.screen ?? UIScreen.main
        let style = screen.traitCollection.userInterfaceStyle
        var system = "unspecified"
        if style == .dark { system = "dark" } else if style == .light { system = "light" }
        let clock = Calendar.current.dateComponents([.hour, .minute], from: Date())
        let minute = (clock.hour ?? 0) * 60 + (clock.minute ?? 0)
        let level = Double(screen.brightness)
        let args: [Any] = [rule, shownWithPlatina(chosen.mode), shownWithPlatina(chosen.dark), system, minute, level]
        return Core.view("settingsNight", args) as? [String: Any] ?? [:]
    }

    private static func compute() -> ThemeLook {
        var state = nightState()
        if state["expired"] as? Bool == true {
            // The rule changed by itself since «Ночной режим» was switched by hand: the switch has run out.
            DevicePreferences.set(["nightForced": NSNull(), "nightForcedAt": NSNull()], quiet: true)
            state = nightState()
        }
        let id = state["shown"] as? String ?? "black"
        // «Цвет интерфейса». The colour of one's own messages is not laid over: this app's chat has no bubbles.
        let args: [Any] = [id, DevicePreferences.item("accentColor"), NSNull()]
        guard let fields = Core.view("settingsTheme", args) as? [String: Any] else { return ThemeLook() }
        return ThemeLook(id: id, fields: fields)
    }

    /// The size of the text of messages («Размер текста в чатах»).
    static var textSize: CGFloat {
        let chosen = DevicePreferences.word("textSize") ?? "medium"
        for size in list("textSizes") where size["id"] as? String == chosen {
            return CGFloat((size["fontSize"] as? NSNumber)?.doubleValue ?? 17)
        }
        return 17
    }

    /// The app's window: it takes the theme's light or dark side, and the theme is looked at again whenever the
    /// app comes back to the front.
    static func attach(_ window: UIWindow) {
        ThemeStore.window = window
        current = compute()
        paint(window)
        _ = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { (_: Notification) -> Void in
            ThemeStore.cameBack()
        }
    }

    private static func paint(_ window: UIWindow) {
        let shown = look
        window.overrideUserInterfaceStyle = shown.dark ? .dark : .light
        window.backgroundColor = shown.bg
    }

    private static func cameBack() {
        guard let window, let stack = window.rootViewController as? NavigationController else { return }
        guard stack.viewControllers.count == 1, stack.presentedViewController == nil, stack.viewControllers.first is RootViewController else { return }
        refresh()
    }

    /// Looks again at what should be on and, when the look changed, redraws the app in it. `pages`: the settings
    /// pages to open again on top («appearance», «night», «accent»). True when the app was redrawn.
    @discardableResult
    static func refresh(reopen pages: [String] = []) -> Bool {
        let fresh = compute()
        guard fresh.source != look.source else { return false }
        current = fresh
        NotificationCenter.default.post(name: changed, object: nil)
        restyle(reopen: pages)
        return true
    }

    private static func restyle(reopen pages: [String]) {
        guard let window else { return }
        paint(window)
        guard let stack = window.rootViewController as? NavigationController, let root = stack.viewControllers.first as? RootViewController else { return }
        let section = root.open
        let fresh = root.rebuilt()
        let next = NavigationController(rootViewController: fresh)
        window.rootViewController = next
        fresh.loadViewIfNeeded()
        if pages.isEmpty {
            if !section.isEmpty { fresh.show(section) }
            return
        }
        fresh.show("profile")
        var settings: SettingsViewController? = nil
        for child in fresh.children {
            if let found = child as? SettingsViewController { settings = found }
        }
        guard let settings else { return }
        settings.loadViewIfNeeded()
        for name in pages {
            if let page = settings.page(named: name) { next.pushViewController(page, animated: false) }
        }
    }
}
