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

    /// A JSON value as text, and back.
    static func text(_ value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func value(_ text: String?) -> Any? {
        guard let data = text?.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    /// The headers and the time limit (seconds) of one request.
    static func prepare(method: String, path: String, jsonBody: Bool, token: String?, proof: String?) -> (headers: [(String, String)], timeout: TimeInterval)? {
        var request: [String: Any] = ["method": method, "path": path, "jsonBody": jsonBody, "platform": "ios",
                                      "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
                                      "nowMs": Int(Date().timeIntervalSince1970 * 1000)]
        if !attestKey.isEmpty { request["attestKey"] = attestKey }
        if let token { request["token"] = token }
        if let proof { request["proof"] = proof }
        guard let json = text(request), let made = value(json.withCString { take(invizent_http_prepare($0)) }) as? [String: Any],
              let list = made["headers"] as? [[String]], let limit = made["timeoutMs"] as? Double else { return nil }
        return (list.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }, limit / 1000)
    }

    /// What the server's answer means (see `invizent_http_read`).
    static func read(status: Int, body: String) -> [String: Any] {
        let answer = body.withCString { take(invizent_http_read(UInt16(clamping: status), $0)) }
        return value(answer) as? [String: Any] ?? [:]
    }

    /// The request of a server operation by its name: method, path and JSON body.
    static func call(_ op: String, _ args: [Any]) -> (method: String, path: String, body: String?)? {
        guard let argsText = text(args), let device = text(Account.deviceFields) else { return nil }
        let answer = op.withCString { op in argsText.withCString { args in device.withCString { take(invizent_api_call(op, args, $0)) } } }
        guard let made = value(answer) as? [String: Any], let method = made["method"] as? String, let path = made["path"] as? String else { return nil }
        return (method, path, made["body"] as? String)
    }
}
