import Foundation

/// The proof that a session is used on the device it was bound to.
///
/// At sign-in the session is bound to a key that lives in this phone's secure chip and never leaves it; from then
/// on the server asks for a short-lived proof signed with that key. A copied session token is useless on another
/// device. The rules of the exchange are the core's; this class only carries its steps out.
final class DeviceProof {
    enum Outcome { case ok, lost, failed }

    private let handle = invizent_proof_new()
    private let exchange = DispatchQueue(label: "invizent.device-proof")
    /// Sends one request of the exchange: path, JSON body → the server's answer as `Core.read` gives it, nil when none came.
    var post: ((String, String?) -> [String: Any]?)?

    deinit { invizent_proof_free(handle) }

    private func call(_ input: [String: Any]) -> [String: Any] {
        var input = input
        input["now"] = Int(Date().timeIntervalSince1970 * 1000)
        guard let text = Core.text(input), let raw = text.withCString({ invizent_proof_call(handle, $0) }) else { return [:] }
        defer { invizent_string_free(raw) }
        return Core.value(String(cString: raw)) as? [String: Any] ?? [:]
    }

    private var state: [String: Any] { call(["op": "state"]) }
    /// The proof to send with a request, if one is held and still good.
    var current: String? { state["proof"] as? String }
    var generation: Int { (state["generation"] as? NSNumber)?.intValue ?? 0 }
    /// Whether a request should first wait for a fresh proof / whether this session is known to need one.
    var due: Bool { state["due"] as? Bool ?? false }
    var known: Bool { state["known"] as? Bool ?? false }

    /// Gets a proof (binding the session first, if it has no key yet). Waits for the answer: never on the main queue.
    /// `force`: the server has just refused the proof we hold; `seen`: the generation when that request left.
    func ensure(force: Bool, seen: Int? = nil) -> Outcome {
        exchange.sync { () -> Outcome in
            var step = call(["op": "refresh", "force": force, "seen": seen.map { $0 as Any } ?? NSNull()])
            for _ in 0..<12 {
                if step["refresh"] != nil { return .ok }
                if let done = step["done"] as? String { return done == "held" || done == "notUsed" ? .ok : done == "lost" ? .lost : .failed }
                if let request = step["post"] as? [String: Any], let path = request["path"] as? String {
                    let body = request["body"].flatMap { $0 is NSNull ? nil : Core.text($0) }
                    let hasKey = (try? DeviceKey.ensure()) != nil
                    guard let answer = post?(path, body) else { step = call(["op": "reply", "hasKey": hasKey, "failed": true]); continue }
                    if let ok = answer["ok"] { step = call(["op": "reply", "hasKey": hasKey, "ok": ok]) }
                    else if let refused = answer["refused"] as? [String: Any] { step = call(["op": "reply", "hasKey": hasKey, "refused": ["status": refused["status"] ?? 0, "code": refused["code"] ?? ""]]) }
                    else { step = call(["op": "reply", "hasKey": hasKey, "failed": true]) }
                } else if let sign = step["sign"] as? [String: Any], let message = sign["message"] as? String {
                    if let signature = try? DeviceKey.sign(message), let key = try? DeviceKey.ensure(), let publicKey = key["publicKey"], let kind = key["kind"] {
                        step = call(["op": "signed", "signature": signature, "publicKey": publicKey, "kind": kind])
                    } else {
                        step = call(["op": "signed", "failed": true, "keyChanged": false])
                    }
                } else {
                    return .failed
                }
            }
            return .failed
        }
    }
}
