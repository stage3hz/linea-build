import Foundation
import LocalAuthentication
import Security

/// Where the code-lock settings live and the one store the screens read them from. (The previous app:
/// `mobile/src/lock/storage.ts` and `biometrics.ts`.) The keychain entry is the previous app's own
/// (`linea.passcode.v1`, readable after the first unlock since boot, this device only), so an update keeps the code.
final class LockStore {
    static let shared = LockStore()
    static let changed = Notification.Name("invizent.lock")
    private static let name = "linea.passcode.v1"

    private(set) var current = LockSettings()
    private(set) var loaded = false

    /// Reads the saved settings. Throws when the keychain cannot be read: that is never taken for «no code set».
    func load() throws {
        let raw = try Keychain.get(LockStore.name)
        current = LockSettings.parse(raw)
        loaded = true
        NotificationCenter.default.post(name: LockStore.changed, object: nil)
    }

    /// Changes some of them and keeps them (without a code nothing is kept at all).
    func update(_ change: (inout LockSettings) -> Void) {
        var next = current
        change(&next)
        if next.record == nil {
            next.biometrics = false
            next.failures = 0
            next.lastFailureAt = nil
        }
        current = next
        LockStore.write(next.text())
        NotificationCenter.default.post(name: LockStore.changed, object: nil)
    }

    private static func query() -> [String: Any] {
        let account = Data(name.utf8)
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app:no-auth", kSecAttrGeneric as String: account, kSecAttrAccount as String: account]
    }

    private static func write(_ text: String?) {
        guard let text else {
            SecItemDelete(query() as CFDictionary)
            return
        }
        let data = Data(text.utf8)
        // Readable after the first unlock since boot even while the phone is locked again: the app may be woken in
        // the background and must still find the lock, or it would start open.
        var add = query()
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            SecItemUpdate(query() as CFDictionary, [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary)
        }
    }

    // MARK: The shared counter of wrong codes (the lock screen and the settings' check cost the same)

    func recordFailure() {
        let now = LockRules.nowMs()
        update { (settings: inout LockSettings) -> Void in
            settings.failures += 1
            settings.lastFailureAt = now
        }
    }

    /// A right code anywhere: the wait is over, the app counts as open from now.
    func recordSuccess() {
        let now = LockRules.nowMs()
        update { (settings: inout LockSettings) -> Void in
            settings.failures = 0
            settings.lastFailureAt = nil
            settings.backgroundAt = now
        }
    }

    /// Milliseconds before the next try is allowed (0 = may try).
    var waitMs: Double {
        return LockRules.retryWaitMs(current.failures, lastFailureAt: current.lastFailureAt, now: LockRules.nowMs())
    }

    /// Turns the lock on with `code` (or replaces the code, keeping the other choices). False when it could not be made.
    func enable(_ code: String) -> Bool {
        guard let record = LockRules.makeRecord(code) else { return false }
        let now = LockRules.nowMs()
        update { (settings: inout LockSettings) -> Void in
            settings.record = record
            settings.failures = 0
            settings.lastFailureAt = nil
            settings.backgroundAt = now
        }
        return true
    }

    func disable() {
        update { (settings: inout LockSettings) -> Void in
            settings.record = nil
            settings.biometrics = false
            settings.failures = 0
            settings.lastFailureAt = nil
            settings.backgroundAt = nil
        }
    }

    /// Checks a code off the main thread (the hash takes a moment) and answers on the main thread.
    func check(_ code: String, done: @escaping (Bool) -> Void) {
        guard let record = current.record else { done(false); return }
        DispatchQueue.global(qos: .userInitiated).async {
            let right = LockRules.verify(code, record: record)
            DispatchQueue.main.async { done(right) }
        }
    }
}

/// Face ID / Touch ID. The device passcode is never accepted instead: the app has its own code.
enum LockBiometrics {
    /// What the switch and the pad key are called: «Face ID», «Touch ID» or «Биометрия»; nil when nothing is enrolled.
    static func label() -> String? {
        let context = LAContext()
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem) else { return nil }
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return "Биометрия"
        }
    }

    /// True once the system confirmed the owner (answers on the main thread).
    static func authenticate(_ prompt: String = "Разблокировать Инвиз", done: @escaping (Bool) -> Void) {
        let context = LAContext()
        context.localizedCancelTitle = "Отмена"
        context.localizedFallbackTitle = ""
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: prompt) { (success: Bool, _: Error?) -> Void in
            DispatchQueue.main.async { done(success) }
        }
    }
}
