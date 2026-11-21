import Foundation
import Security

/// The server's permission to set a new password after the waiting period: a short-lived credential.
struct RecoveryGrant {
    let resetToken: String
    let requestId: String
    var readyAt: String
    var expiresAt: String
    var serverTime: String

    /// Milliseconds since 1970 of a date as the server writes it (`2026-11-21T07:00:00.000Z`); nil when it is not one.
    static func ms(_ text: String) -> Double? {
        let full = ISO8601DateFormatter()
        full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = full.date(from: text) { return (date.timeIntervalSince1970 * 1000).rounded() }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: text) { return (date.timeIntervalSince1970 * 1000).rounded() }
        return nil
    }

    var readyMs: Double { return RecoveryGrant.ms(readyAt) ?? 0 }
    var expiresMs: Double { return RecoveryGrant.ms(expiresAt) ?? 0 }
    var serverMs: Double { return RecoveryGrant.ms(serverTime) ?? 0 }

    /// Read from a server answer or from what was kept; nil unless every part is there and well-formed.
    init?(_ value: Any?) {
        guard let fields = value as? [String: Any],
              let token = fields["resetToken"] as? String, !token.isEmpty,
              let request = fields["requestId"] as? String, !request.isEmpty,
              let ready = fields["readyAt"] as? String, RecoveryGrant.ms(ready) != nil,
              let expires = fields["expiresAt"] as? String, RecoveryGrant.ms(expires) != nil,
              let server = fields["serverTime"] as? String, RecoveryGrant.ms(server) != nil else { return nil }
        resetToken = token
        requestId = request
        readyAt = ready
        expiresAt = expires
        serverTime = server
    }

    var fields: [String: Any] {
        return ["resetToken": resetToken, "requestId": requestId, "readyAt": readyAt, "expiresAt": expiresAt, "serverTime": serverTime]
    }
}

/// The pending recovery request, kept so that the waiting period survives closing the app
/// (`mobile/src/auth/recoveryStorage.ts`): in the keychain under the name and in the form the previous app
/// used, on this device only, readable only while it is unlocked. Never in settings, addresses or logs.
enum RecoveryStore {
    private static let name = "linea.recovery.pending.v1"

    struct Saved {
        let base: String
        let username: String
        let grant: RecoveryGrant
    }

    private static func decode(_ raw: String?) -> Saved? {
        guard let raw, let value = Core.value(raw) as? [String: Any],
              let version = value["version"] as? NSNumber, version.doubleValue == 1,
              let base = value["base"] as? String, base.utf16.count <= 512,
              let username = value["username"] as? String, username == AuthRules.name(username), AuthRules.validName(username),
              let grant = RecoveryGrant(value["challenge"]) else { return nil }
        guard grant.requestId.utf16.count <= 128, grant.expiresMs > grant.readyMs else { return nil }
        // The token is 43 symbols of the URL-safe base64 alphabet.
        let token = grant.resetToken.unicodeScalars
        guard token.count == 43 else { return nil }
        for scalar in token {
            let v = scalar.value
            let letter = (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A)
            let digit = v >= 0x30 && v <= 0x39
            if !letter && !digit && v != 0x5F && v != 0x2D { return nil }
        }
        return Saved(base: base, username: username, grant: grant)
    }

    /// The request kept for this server; nil when there is none. What is kept but cannot be understood is removed.
    /// Throws when the keychain cannot be read at all.
    static func read(base: String) throws -> Saved? {
        let raw = try Keychain.get(name)
        let saved = decode(raw)
        if raw != nil && saved == nil { Keychain.remove(name) }
        guard let saved, saved.base == base else { return nil }
        return saved
    }

    static func save(base: String, username: String, grant: RecoveryGrant) throws {
        let value: [String: Any] = ["version": 1, "base": base, "username": username, "challenge": grant.fields]
        guard let raw = Core.text(value), decode(raw) != nil else { throw KeychainError(status: errSecParam) }
        try Keychain.set(name, raw)
    }

    /// Removes the request kept for this server — only the one with `resetToken` when it is given.
    static func clear(base: String, resetToken: String? = nil) {
        var raw: String?
        do { raw = try Keychain.get(name) } catch { return }
        guard let saved = decode(raw), saved.base == base else { return }
        if let resetToken, saved.grant.resetToken != resetToken { return }
        Keychain.remove(name)
    }
}
