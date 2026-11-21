import CommonCrypto
import Foundation
import Security

/// «Код-пароль»: the pure rules — what a code looks like, how it is hashed and checked, when the app locks by
/// itself and how long a wrong guess costs. (The previous app: `mobile/src/lock/model.ts`, every number and rule
/// the same.) No UIKit here.
enum LockRules {
    /// When the app locks after it was last in the foreground. `immediate` = at once on leaving («Сразу»).
    static let autolockModes: [String] = ["off", "immediate", "1m", "5m", "1h", "5h"]
    static let autolockLabels: [String: String] = ["off": "Выключена", "immediate": "Сразу", "1m": "Через 1 мин", "5m": "Через 5 мин", "1h": "Через 1 ч", "5h": "Через 5 ч"]

    /// Milliseconds in the background before the lock, nil = never by itself.
    static func autolockMs(_ mode: String) -> Double? {
        switch mode {
        case "immediate": return 0
        case "1m": return 60_000
        case "5m": return 5 * 60_000
        case "1h": return 3_600_000
        case "5h": return 5 * 3_600_000
        default: return nil
        }
    }

    static let digitsLength = 4
    /// PBKDF2-HMAC-SHA256 rounds for a new code (old records keep their own count).
    static let kdfIterations = 8_000
    static let saltBytes = 16
    static let hashBytes = 32

    /// Only exactly four digits are a «4-значный код»; anything else is a password.
    static func codeKind(_ code: String) -> String {
        let digits = code.unicodeScalars.allSatisfy { (letter: Unicode.Scalar) -> Bool in letter.value >= 48 && letter.value <= 57 }
        return code.unicodeScalars.count == 4 && digits ? "digits" : "password"
    }

    /// A code the person may set: four digits, or a password of 1–64 characters.
    static func codeProblem(_ code: String, kind: String) -> String? {
        if kind == "digits" { return codeKind(code) == "digits" ? nil : "Введи четыре цифры." }
        if code.isEmpty { return "Пароль не может быть пустым." }
        if code.utf16.count > 64 { return "Пароль слишком длинный." }
        return nil
    }

    static func hex(_ bytes: [UInt8]) -> String {
        return bytes.map { (byte: UInt8) -> String in String(format: "%02x", byte) }.joined()
    }

    static func bytes(_ hex: String) -> [UInt8]? {
        let letters = Array(hex.utf8)
        guard letters.count % 2 == 0 else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(letters.count / 2)
        var at = 0
        while at < letters.count {
            guard let pair = UInt8(String(decoding: letters[at..<at + 2], as: UTF8.self), radix: 16) else { return nil }
            out.append(pair)
            at += 2
        }
        return out
    }

    /// PBKDF2-HMAC-SHA256 of the code's UTF-8 (NFC) bytes.
    static func derive(_ code: String, salt: [UInt8], iterations: Int, length: Int) -> [UInt8]? {
        let password = Array(code.precomposedStringWithCanonicalMapping.utf8).map { (byte: UInt8) -> Int8 in Int8(bitPattern: byte) }
        var out = [UInt8](repeating: 0, count: length)
        let status: Int32 = CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password, password.count, salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations), &out, length)
        return status == Int32(kCCSuccess) ? out : nil
    }

    /// A fresh salted hash of `code`.
    static func makeRecord(_ code: String) -> LockRecord? {
        var salt = [UInt8](repeating: 0, count: saltBytes)
        guard SecRandomCopyBytes(kSecRandomDefault, salt.count, &salt) == errSecSuccess else { return nil }
        guard let hash = derive(code, salt: salt, iterations: kdfIterations, length: hashBytes) else { return nil }
        return LockRecord(kind: codeKind(code), salt: hex(salt), hash: hex(hash), iterations: kdfIterations)
    }

    /// Same length and bytes, in time that does not depend on where they differ.
    static func verify(_ code: String, record: LockRecord) -> Bool {
        guard let expected = bytes(record.hash), let salt = bytes(record.salt) else { return false }
        guard let actual = derive(code, salt: salt, iterations: record.iterations, length: expected.count), actual.count == expected.count else { return false }
        var diff: UInt8 = 0
        for index in 0..<actual.count { diff |= actual[index] ^ expected[index] }
        return diff == 0
    }

    static let retryFreeAttempts = 5
    static let retryBaseMs: Double = 10_000
    static let retryMaxMs: Double = 3_600_000

    /// After five wrong codes the next try waits 10 s, then 20, 40, 80… up to an hour.
    static func retryDelayMs(_ failures: Int) -> Double {
        if failures < retryFreeAttempts { return 0 }
        return min(retryMaxMs, retryBaseMs * pow(2, Double(min(30, failures - retryFreeAttempts))))
    }

    /// Milliseconds still to wait since the last wrong code (0 = may try).
    static func retryWaitMs(_ failures: Int, lastFailureAt: Double?, now: Double) -> Double {
        guard let last = lastFailureAt else { return 0 }
        let elapsed = now - last
        // A clock that jumped back cannot shorten the wait past the full delay.
        if elapsed < 0 { return retryDelayMs(failures) }
        return max(0, retryDelayMs(failures) - elapsed)
    }

    static func retryHint(_ waitMs: Double) -> String {
        let seconds = Int(ceil(waitMs / 1000))
        if seconds <= 0 { return "" }
        if seconds < 60 { return "Попробуй через \(seconds) с" }
        if seconds < 3600 { return "Попробуй через \(Int(ceil(Double(seconds) / 60))) мин" }
        return "Попробуй через 1 ч"
    }

    /// On return to the foreground: lock when the time away reached the autolock delay (a clock that went backwards
    /// counts as a long absence). The first launch with a code is always locked.
    static func shouldLock(_ settings: LockSettings, now: Double) -> Bool {
        guard settings.record != nil else { return false }
        guard let left = settings.backgroundAt else { return true }
        guard let limit = autolockMs(settings.autolock) else { return false }
        let away = now - left
        return away < 0 || away >= limit
    }

    /// A cold start with a code set: always locked when autolock is off, otherwise by the time away.
    static func shouldLockOnLaunch(_ settings: LockSettings, now: Double) -> Bool {
        return settings.record != nil && (settings.autolock == "off" || shouldLock(settings, now: now))
    }

    /// Leaving the foreground: «Сразу» locks now, so the app switcher never shows a chat.
    static func locksOnBackground(_ settings: LockSettings) -> Bool {
        return settings.record != nil && settings.autolock == "immediate"
    }

    /// The iPhone turns «inactive» for a moment for the Face ID sheet, Control Centre, a call banner: «Сразу» waits
    /// this long before locking on inactive alone. A real «background» locks at once.
    static let inactiveGraceSeconds: TimeInterval = 1.5

    struct LeaveAction {
        var recordBackgroundAt = false
        /// "now", "soon" (after the grace unless active again) or "no".
        var lock = "no"
        var cover = false
    }

    /// The app leaves the foreground (`background` false = only inactive). iPhone only: the cover is always offered.
    static func onLeave(_ settings: LockSettings, locked: Bool, background: Bool) -> LeaveAction {
        guard settings.record != nil else { return LeaveAction() }
        var action = LeaveAction()
        action.recordBackgroundAt = !locked && background
        action.cover = !locked
        if locked || !locksOnBackground(settings) { return action }
        action.lock = background ? "now" : "soon"
        return action
    }

    /// Back in the foreground: only a real stay in the background counts, and only when the time away reached the
    /// autolock delay. «Сразу» never locks on return — it locked on leaving.
    static func shouldLockOnReturn(_ settings: LockSettings, wasBackground: Bool, now: Double) -> Bool {
        return wasBackground && settings.autolock != "immediate" && shouldLock(settings, now: now)
    }

    static func nowMs() -> Double { return Date().timeIntervalSince1970 * 1000 }
}

/// What is kept on the device. The code itself never is: only its salted PBKDF2 hash.
struct LockRecord: Equatable {
    var kind: String
    var salt: String
    var hash: String
    var iterations: Int
}

struct LockSettings {
    var record: LockRecord?
    var biometrics = false
    var autolock = "1m"
    /// Wrong guesses in a row (reset by a right one).
    var failures = 0
    /// When the app was last in the foreground with the lock open (ms); nil = never — or locked when last seen.
    var backgroundAt: Double?
    /// When the last wrong code was typed (ms); nil = none since the last right one.
    var lastFailureAt: Double?

    /// The record as the previous app keeps it (the same JSON), so an update finds the code that was set.
    static func parse(_ raw: String?) -> LockSettings {
        guard let raw, let data = raw.data(using: .utf8), let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return LockSettings() }
        var settings = LockSettings()
        if let r = value["record"] as? [String: Any], let kind = r["kind"] as? String, kind == "digits" || kind == "password",
           let salt = r["salt"] as? String, let hash = r["hash"] as? String, LockRules.bytes(salt) != nil, LockRules.bytes(hash) != nil,
           hash.count == LockRules.hashBytes * 2, let iterations = (r["iterations"] as? NSNumber)?.intValue, iterations >= 1000 {
            settings.record = LockRecord(kind: kind, salt: salt, hash: hash, iterations: iterations)
        }
        settings.biometrics = settings.record != nil && (value["biometrics"] as? Bool ?? false)
        if let mode = value["autolock"] as? String, LockRules.autolockModes.contains(mode) { settings.autolock = mode }
        if let failures = (value["failures"] as? NSNumber)?.doubleValue, failures >= 0 { settings.failures = Int(failures) }
        settings.backgroundAt = (value["backgroundAt"] as? NSNumber)?.doubleValue
        settings.lastFailureAt = (value["lastFailureAt"] as? NSNumber)?.doubleValue
        return settings
    }

    func text() -> String? {
        guard let record else { return nil }
        var value: [String: Any] = [
            "record": ["kind": record.kind, "salt": record.salt, "hash": record.hash, "iterations": record.iterations] as [String: Any],
            "biometrics": biometrics,
            "autolock": autolock,
            "failures": failures,
        ]
        if let backgroundAt { value["backgroundAt"] = backgroundAt } else { value["backgroundAt"] = NSNull() }
        if let lastFailureAt { value["lastFailureAt"] = lastFailureAt } else { value["lastFailureAt"] = NSNull() }
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
