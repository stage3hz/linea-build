import Foundation

/// The shared core (Rust), as Swift sees it.
enum Core {
    /// Takes a text the core handed out, and gives the memory back to it.
    private static func take(_ pointer: UnsafeMutablePointer<CChar>?) -> String? {
        guard let pointer else { return nil }
        defer { invizent_string_free(pointer) }
        return String(cString: pointer)
    }

    static var version: String { take(invizent_core_version()) ?? "?" }

    struct Device: Encodable {
        let userId: String
        let deviceId: String
        let identityKey: String
        let registrationId: Int
    }

    /// The code two people compare for a pair of devices; nil if the pair is not valid.
    static func safetyCode(own: Device, other: Device) -> String? {
        struct Pair: Encodable { let own: Device; let other: Device }
        guard let data = try? JSONEncoder().encode(Pair(own: own, other: other)), let json = String(data: data, encoding: .utf8) else { return nil }
        return json.withCString { take(invizent_safety_code($0)) }
    }
}
