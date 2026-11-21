import Foundation
import Security

/// Small secrets of the app in the system keychain.
///
/// The entries are kept exactly where the previous app kept them (service `app:no-auth`, the name as the
/// account, text as UTF-8), so an update finds the keys of the storage that is already on the phone.
/// They never leave this device and are readable only while it is unlocked.
enum Keychain {
    private static let service = "app:no-auth"

    private static func query(_ name: String) -> [String: Any] {
        let account = Data(name.utf8)
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrGeneric as String: account, kSecAttrAccount as String: account]
    }

    /// The text kept under `name`; nil when there is none. Throws when the keychain cannot be read at all
    /// (a locked phone): «no key» and «cannot tell» must not be confused — the first makes a new key.
    static func get(_ name: String) throws -> String? {
        var find = query(name)
        find[kSecReturnData as String] = true
        find[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(find as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = found as? Data, let text = String(data: data, encoding: .utf8) else { throw KeychainError(status: status) }
        return text
    }

    static func set(_ name: String, _ value: String) throws {
        let data = Data(value.utf8)
        var add = query(name)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(query(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    static func remove(_ name: String) {
        SecItemDelete(query(name) as CFDictionary)
    }
}

struct KeychainError: Error { let status: OSStatus }
