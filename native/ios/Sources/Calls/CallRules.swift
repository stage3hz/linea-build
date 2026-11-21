import Foundation

/// One call as the screens show it (the reference's `CallState` in CallProvider.tsx).
struct CallState {
    let id: String
    let chatId: String
    var peer: Person
    /// The other side placed it.
    let incoming: Bool
    var video: Bool
    /// "requesting", "ringing", "incoming", "connecting", "active" or "ended" (`CallStatus` of the reference).
    var status: String
    var muted = false
    var speaker: Bool
    var cameraOff = false
    /// When the media connected (milliseconds since 1970); nil before that.
    var startedAt: Double?
    var endedText = ""
    /// The four emoji both sides see once the keys of the media are known.
    var key: [String]?
    /// The other side's first SDP (its fingerprints are the ones the key was made of).
    var remoteSdp: String?
    var minimized = false
    /// "good", "weak" or "bad": how the link is doing right now.
    var grade = "good"
    /// «Восстановление связи…»: the media dropped mid-call and an ICE restart is under way.
    var reconnecting = false
    /// Ended without a connection («Нет соединения»): the screen stays with «Повторить».
    var retry = false
    /// This phone's camera is sending / the other side's picture is arriving.
    var localVideo = false
    var remoteVideo = false

    var isOver: Bool { status == "ended" }
}

/// The rules of calls, asked of the shared core (native/core/src/calls.rs — a port of the reference's
/// callModel.ts, reconnect.ts, callStatus.ts and callLog.ts, the same on both phones). Nothing here decides
/// anything by itself.
enum CallRules {
    private static let limits: [String: Any] = Core.view("callRules", []) as? [String: Any] ?? [:]
    private static func seconds(_ key: String, _ otherwiseMs: Double) -> TimeInterval {
        ((limits[key] as? NSNumber)?.doubleValue ?? otherwiseMs) / 1000
    }

    /// A call rings for a minute, then ends by itself (both sides).
    static var ringTimeout: TimeInterval { seconds("ringTimeoutMs", 60_000) }
    /// How long a call placed offline waits for the connection.
    static var networkWait: TimeInterval { seconds("networkWaitMs", 20_000) }
    /// How long the servers of the last call may be used again when fresh ones cannot be asked for.
    static var iceReuse: TimeInterval { seconds("iceReuseMs", 14_400_000) }
    static var barHeight: Double { (limits["barHeight"] as? NSNumber)?.doubleValue ?? 36 }
    static var noConnectionText: String { limits["noConnectionText"] as? String ?? "Нет соединения" }

    static var nowMs: Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    /// How fast the network was measured to be: "slow", "medium" or "fast". The iPhone app does not measure it
    /// yet, so economy voice (callEconomySdp) is not switched on by the network's speed — only the live link's
    /// grade lowers the bitrates.
    static var tier: String { "fast" }

    static func flag(_ name: String, _ args: [Any]) -> Bool { Core.view(name, args) as? Bool ?? false }
    static func words(_ name: String, _ args: [Any]) -> String? { Core.view(name, args) as? String }
    static func fields(_ name: String, _ args: [Any]) -> [String: Any] { Core.view(name, args) as? [String: Any] ?? [:] }

    /// The status line, the clock next to it in the bar, and the bar's tone, for a call as it is now.
    static func status(_ call: CallState, network: String) -> (text: String, clock: String?, tone: String) {
        var input: [String: Any] = ["status": call.status, "incoming": call.incoming, "video": call.video, "reconnecting": call.reconnecting,
                                    "endedText": call.endedText, "network": network, "now": nowMs]
        if let startedAt = call.startedAt { input["startedAt"] = startedAt } else { input["startedAt"] = NSNull() }
        let answer = fields("callStatus", [input])
        return (answer["text"] as? String ?? "", answer["clock"] as? String, answer["tone"] as? String ?? "pending")
    }

    /// «слабая связь» / «плохая связь», or nothing for a good link.
    static func linkWords(_ grade: String) -> String { fields("callCaps", [tier, grade])["text"] as? String ?? "" }

    /// The `end` every phone sends for a call: the outcome, video or not, who placed it, how long it lasted.
    static func end(_ call: CallState, reason: String) -> [String: Any] {
        end(id: call.id, video: call.video, incoming: call.incoming, startedAt: call.startedAt, reason: reason)
    }

    static func end(id: String, video: Bool, incoming: Bool, startedAt: Double?, reason: String) -> [String: Any] {
        var source: [String: Any] = ["id": id, "video": video, "incoming": incoming]
        if let startedAt { source["startedAt"] = startedAt } else { source["startedAt"] = NSNull() }
        return fields("callEnd", [source, reason, nowMs])
    }

    /// What the call's audio is told about the loudspeaker (the reference's `speakerRoute`): true — force the
    /// loudspeaker, false — force the phone's earpiece, nil — the system's own route (headphones when connected).
    /// «Динамик» off goes back to the system's route, except in a video call, whose own route is the loudspeaker.
    static func speakerRoute(chosen: Bool?, video: Bool) -> Bool? {
        guard let chosen else { return nil }
        if chosen { return true }
        return video ? false : nil
    }

    /// The words a call ends with when the other side's `end` arrives (CallProvider.tsx, onCallSignal).
    static func endedWords(reason: String?) -> String {
        switch reason {
        case "declined": return "Звонок отклонён"
        case "busy": return "Собеседник занят"
        case "missed": return "Пропущенный звонок"
        default: return "Звонок завершён"
        }
    }
}
