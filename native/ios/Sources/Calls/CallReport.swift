import Foundation

/// What one call went through, told in a single grey line under its last words — in the preview build only
/// (`com.linea.messenger.preview`, the one the owner tests on his phones; the App Store's `com.invizent.app` never
/// shows it), so that a call that did not come up can be explained from a picture of the screen, without a cable.
/// Android keeps the very same fields (CallReport.kt), so pictures of both phones can be laid side by side.
///
/// Only states, counts, yes/no and seconds: never an SDP, an address, a key, a token, a name or a message. The
/// addresses are counted by their kind and are never kept.
final class CallReport {
    let incoming: Bool
    private let began = Date()
    /// How many servers the call was given, and where they came from: «сервер», «повтор» (another ask),
    /// «прошлые» (the last call's), «публичные» (the public finder alone).
    var servers = 0
    var source = "—"
    /// A relay is among the servers; its address was gathered.
    var wantRelay = false
    var relayFound = false
    /// How long the addresses were waited for (ms), and whether the gathering said it was complete.
    var gatherMs: Double?
    var gatherComplete = false
    /// This phone's own addresses as they went out inside its SDP (see `counts`).
    var own = "—"
    /// The answer: «нет» (none yet), «сделан», «отправлен», «не отправлен», «не сделан»; on the caller's side
    /// «получен» or «не принят» (the connection refused it).
    var answer = "нет"
    /// The connection's last state as it said it ("new", "connecting", "connected", "failed"…).
    var state = "—"
    /// The kind of network the phone was on when the call began: «wifi», «cellular»…
    var network = "?"
    /// When the offer was made (the caller: sent; the callee: the message's time) and when the answer went or came.
    var offerAt: Date?
    var answerAt: Date?
    /// When the call started saying «Соединение…».
    var connectingAt: Date?
    /// What ended the call, in a word or two («ICE failed», «60 с», «собеседник: …», «кнопка»…).
    var cause = ""

    init(incoming: Bool) { self.incoming = incoming }

    /// The line itself, at the end of the call; `theirs`: the other side's SDP as this phone has it.
    func line(theirs: String?) -> String {
        let relay = !wantRelay ? "не настроен" : relayFound ? "да" : "нет"
        var parts: [String] = []
        parts.append("ICE: \(state)")
        parts.append("relay: \(relay)")
        parts.append("серверов: \(servers) (\(source))")
        parts.append("ответ: \(answer)")
        if let offerAt, let answerAt { parts.append("ответ через \(CallReport.seconds(answerAt.timeIntervalSince(offerAt) * 1000)) с") }
        if let gatherMs { parts.append("сбор: \(CallReport.seconds(gatherMs)) с" + (gatherComplete ? "" : " (не весь)")) }
        let other = (theirs ?? "").isEmpty ? "—" : CallReport.counts(theirs ?? "")
        parts.append("кандидаты: свои \(own) · чужие \(other)")
        parts.append("сеть: \(network)")
        if !cause.isEmpty { parts.append("конец: \(cause)") }
        parts.append("\(CallReport.seconds(Date().timeIntervalSince(connectingAt ?? began) * 1000)) с")
        return parts.joined(separator: " · ")
    }

    /// Whether this build shows the line: the preview one only, never the store's.
    static var shown: Bool { Bundle.main.bundleIdentifier == "com.linea.messenger.preview" }

    private static func seconds(_ ms: Double) -> String {
        ms < 10_000 ? String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), ms / 1000) : String(Int(ms / 1000))
    }

    /// The addresses inside an SDP counted by kind: «h2 s1 r0», with how many of the host ones are IPv6 or a hidden
    /// `.local` name, and «p» for peer-reflexive ones when there are any. Nothing of the address itself is kept:
    /// only the kind and those two yes/no questions.
    static func counts(_ sdp: String) -> String {
        var host = 0, srflx = 0, relay = 0, prflx = 0, v6 = 0, mdns = 0, tcp = 0
        // An SDP's lines end in "\r\n", which Swift holds as one character: split on either.
        for raw in sdp.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("a=candidate:") else { continue }
            let fields = line.split(separator: " ").map(String.init)
            guard let at = fields.firstIndex(of: "typ"), at + 1 < fields.count else { continue }
            if fields.count > 2, fields[2].lowercased() == "tcp" { tcp += 1 }
            switch fields[at + 1] {
            case "host":
                host += 1
                let address = fields.count > 4 ? fields[4] : ""
                if address.hasSuffix(".local") { mdns += 1 } else if address.contains(":") { v6 += 1 }
            case "srflx": srflx += 1
            case "relay": relay += 1
            case "prflx": prflx += 1
            default: break
            }
        }
        var extra: [String] = []
        if v6 > 0 { extra.append("v6 \(v6)") }
        if mdns > 0 { extra.append(".local \(mdns)") }
        var words = "h\(host)" + (extra.isEmpty ? "" : " (\(extra.joined(separator: ", ")))") + " s\(srflx) r\(relay)"
        if prflx > 0 { words += " p\(prflx)" }
        if tcp > 0 { words += " tcp \(tcp)" }
        return words
    }
}
