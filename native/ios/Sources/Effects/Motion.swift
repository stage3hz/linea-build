import UIKit

/// May the app animate right now, and which heavy processes may play: «Энергосбережение и анимации».
/// (The previous app: `mobile/src/motionPolicy.ts` — the pure rules, word for word — and `mobile/src/motion.tsx`
/// — the battery, the system's low power mode and «Уменьшение движения».) The choices themselves are the
/// device preferences `animations`, `lowBattery`, `autoplayVideo`, `autoplayGif`, `animatedStickers`,
/// `animatedEmoji` (Settings/ThemeStore.swift, read back through the core's `settingsPreferences`).
enum Motion {
    /// Posted on the main queue whenever the answer may have changed (a preference, the battery, the system).
    static let changed = Notification.Name("invizent.motion")

    /// Battery level (0…1) at or below which animations switch off in automatic mode.
    static let lowBatteryDefault: Double = 0.27

    struct Power {
        var level: Double?
        var charging = false
        var lowPower = false
        var reduceMotion = false
    }

    private static var started = false
    private(set) static var power = Power()

    /// Starts watching the battery and the system once (safe to call again).
    static func start() {
        guard !started else { return }
        started = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        read()
        let centre = NotificationCenter.default
        let names: [Notification.Name] = [
            UIDevice.batteryLevelDidChangeNotification,
            UIDevice.batteryStateDidChangeNotification,
            Notification.Name.NSProcessInfoPowerStateDidChange,
            UIAccessibility.reduceMotionStatusDidChangeNotification,
            DevicePreferences.changed,
        ]
        for name in names {
            _ = centre.addObserver(forName: name, object: nil, queue: .main) { (_: Notification) -> Void in
                Motion.read()
                NotificationCenter.default.post(name: Motion.changed, object: nil)
            }
        }
    }

    private static func read() {
        let device = UIDevice.current
        let level = Double(device.batteryLevel)
        power.level = level >= 0 ? level : nil
        power.charging = device.batteryState == .charging || device.batteryState == .full
        power.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        power.reduceMotion = UIAccessibility.isReduceMotionEnabled
    }

    // MARK: The rules (motionPolicy.ts)

    /// «Режим энергосбережения»: on always (threshold 1), in the system's low power mode, or below the chosen
    /// battery level while not charging. Threshold 0 = never by battery.
    static func powerSaving(_ power: Power, threshold: Double) -> Bool {
        if threshold >= 1 || power.lowPower { return true }
        guard let level = power.level, level >= 0 else { return false }
        return !power.charging && threshold > 0 && level <= threshold + 1e-9
    }

    static func motionAllowed(_ mode: String, _ power: Power, threshold: Double) -> Bool {
        if mode == "on" { return true }
        if mode == "off" { return false }
        if power.reduceMotion { return false }
        return !powerSaving(power, threshold: threshold)
    }

    static func percent(_ value: Double) -> Int { return Int((value * 100).rounded()) }

    static func motionReason(_ mode: String, _ power: Power, threshold: Double) -> String {
        if mode == "on" { return "Анимации включены всегда." }
        if mode == "off" { return "Анимации выключены." }
        if power.reduceMotion { return "Выключены: в системе включено «Уменьшение движения»." }
        if threshold >= 1 { return "Выключены: режим энергосбережения включён всегда." }
        if power.lowPower { return "Выключены: включён режим энергосбережения." }
        if !motionAllowed(mode, power, threshold: threshold) {
            return "Выключены: заряд \(percent(power.level ?? 0))% — не больше \(percent(threshold))%."
        }
        return threshold > 0 ? "Включены. Выключатся сами при заряде \(percent(threshold))% и ниже или в режиме энергосбережения." : "Включены. По заряду не выключаются, только в режиме энергосбережения."
    }

    // MARK: What the app asks

    static var mode: String { return DevicePreferences.word("animations") ?? "auto" }
    static var threshold: Double { return DevicePreferences.number("lowBattery") ?? 0.25 }

    /// Animations (and the decorative effects) may run now.
    static var enabled: Bool {
        start()
        return motionAllowed(mode, power, threshold: threshold)
    }

    static var reason: String {
        start()
        return motionReason(mode, power, threshold: threshold)
    }

    static var saving: Bool {
        start()
        return powerSaving(power, threshold: threshold)
    }

    /// A heavy process plays when its switch is on and power saving is not active:
    /// "video" (autoplay of videos and round videos), "gif", "stickers" (big emoji move), "emoji" (emoji statuses move).
    static func feature(_ kind: String) -> Bool {
        if saving { return false }
        switch kind {
        case "video": return DevicePreferences.flag("autoplayVideo") ?? true
        case "gif": return DevicePreferences.flag("autoplayGif") ?? true
        case "stickers": return DevicePreferences.flag("animatedStickers") ?? true
        default: return DevicePreferences.flag("animatedEmoji") ?? true
        }
    }

    /// `seconds` when animations are allowed, otherwise 0 (jump straight to the end).
    static func duration(_ seconds: TimeInterval) -> TimeInterval { return enabled ? seconds : 0 }
}
