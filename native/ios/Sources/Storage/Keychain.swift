import Foundation
import Security

/// Small secrets of the app in the system keychain.
///
/// The entries are kept exactly where the previous app kept them, so an update finds the keys of the storage that
/// is already on the phone. The previous app wrote them through expo-secure-store 57
/// (mobile/node_modules/expo-secure-store/ios/SecureStoreModule.swift), whose item is: class generic password,
/// service `app` + `:no-auth` (no `keychainService` option given; `:auth` only for entries behind Face ID, which
/// the previous app never wrote), the name as UTF-8 bytes in BOTH the account and the generic attribute, the text
/// as UTF-8 data, no access group (the app's default one), and the accessibility the caller asks for.
/// Reading also looks under the bare service `app`, where the library's first versions wrote; writing removes
/// such an older copy, and removing deletes every copy, as the library does.
/// They never leave this device and are readable only while it is unlocked (unless a caller asks otherwise).
enum Keychain {
    /// Where the previous app's entries are (no Face ID).
    static let service = "app:no-auth"
    /// Where the library's versions before the two kinds of entries wrote.
    static let legacyService = "app"
    /// Entries behind Face ID: never written by either app, only removed (as the library does on delete).
    static let authService = "app:auth"

    static func query(_ name: String, service: String = Keychain.service) -> [String: Any] {
        let account = Data(name.utf8)
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrGeneric as String: account, kSecAttrAccount as String: account]
    }

    /// The text kept under `name` in one place; nil when there is none there.
    private static func read(_ name: String, service: String) throws -> String? {
        var find = query(name, service: service)
        find[kSecReturnData as String] = true
        find[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(find as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = found as? Data, let text = String(data: data, encoding: .utf8) else { throw KeychainError(status: status) }
        return text
    }

    /// The text kept under `name`; nil when there is none. Throws when the keychain cannot be read at all
    /// (a locked phone): «no key» and «cannot tell» must not be confused — the first makes a new key.
    static func get(_ name: String) throws -> String? {
        if let current = try read(name, service: service) { return current }
        return try read(name, service: legacyService)
    }

    /// Keeps `value` under `name`. `accessible`: when it may be read — this device only, as the previous app chose
    /// for each entry (the session, the storage keys, the recovery request: while unlocked; the code lock: after the
    /// first unlock since boot).
    static func set(_ name: String, _ value: String, accessible: CFString = kSecAttrAccessibleWhenUnlockedThisDeviceOnly) throws {
        let data = Data(value.utf8)
        var add = query(name)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = accessible
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(query(name) as CFDictionary, [kSecValueData as String: data, kSecAttrAccessible as String: accessible] as CFDictionary)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        // As the library does after a write: an older copy elsewhere would be read instead of this one later.
        SecItemDelete(query(name, service: legacyService) as CFDictionary)
        SecItemDelete(query(name, service: authService) as CFDictionary)
    }

    static func remove(_ name: String) {
        for place in [legacyService, authService, service] { SecItemDelete(query(name, service: place) as CFDictionary) }
    }
}

struct KeychainError: Error { let status: OSStatus }
