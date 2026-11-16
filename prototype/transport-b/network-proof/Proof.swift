import Foundation

@available(macOS 14.0, *)
@main struct Proof {
    static func check(_ value: Bool, _ message: String) throws { if !value { throw NSError(domain: message, code: 1) } }
    static func main() async throws {
        let configuration = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
        let origin = configuration["origin"] as! String, badOrigin = configuration["badOrigin"] as! String
        let control = configuration["control"] as! String
        func client(password: String? = nil) throws -> TransportBURLSession {
            try TransportBURLSession(port: UInt16(configuration["port"] as! Int), username: configuration["username"] as! String,
                password: password ?? (configuration["password"] as! String), origins: [origin, badOrigin])
        }
        // Check credentials before any valid connection can enter the OS connection pool.
        let wrong = try client(password: "wrong"); defer { wrong.close() }
        do { _ = try await wrong.request(id: "bad-auth", address: origin + "/health", method: "GET", headers: [:], body: nil, timeout: 3); throw NSError(domain: "Bad SOCKS credential accepted", code: 1) }
        catch TransportBURLSession.Failure.network { }
        let route = try client(); defer { route.close() }
        let health = try await route.request(id: "health", address: origin + "/health", method: "GET", headers: [:], body: nil)
        try check(health.status == 200 && String(data: health.body, encoding: .utf8) == "{\"status\":\"ok\"}", "TLS health failed")
        let (firstStatsData, _) = try await URLSession.shared.data(from: URL(string: control + "/stats")!)
        let firstStats = try JSONSerialization.jsonObject(with: firstStatsData) as! [String: Int]
        print("Initial SOCKS traversal counters:", firstStats)
        try check(firstStats["direct"] == 0 && firstStats["authenticated"]! >= 1 && firstStats["denied"]! >= 1, "HTTPS bypassed authenticated SOCKS")
        let reply = try await route.request(id: "post", address: origin + "/me", method: "POST", headers: ["Authorization": "Bearer fixture-device-session"], body: Data("encrypted-envelope".utf8))
        try check(reply.status == 200 && String(data: reply.body, encoding: .utf8)!.contains("encrypted-envelope"), "Authenticated POST failed")
        let redirect = try await route.request(id: "redirect", address: origin + "/redirect", method: "GET", headers: [:], body: nil)
        try check(redirect.status == 302, "Redirect was followed")
        do { _ = try await route.request(id: "foreign", address: "https://example.com/", method: "GET", headers: [:], body: nil); throw NSError(domain: "Foreign origin accepted", code: 1) }
        catch TransportBURLSession.Failure.invalidRequest { }
        do { _ = try await route.request(id: "bad-tls", address: badOrigin + "/health", method: "GET", headers: [:], body: nil, timeout: 3); throw NSError(domain: "Bad TLS accepted", code: 1) }
        catch TransportBURLSession.Failure.network { }
        let cancelled = Task { try await route.request(id: "cancel", address: origin + "/hang", method: "GET", headers: [:], body: nil) }
        try await Task.sleep(nanoseconds: 100_000_000); cancelled.cancel()
        do { _ = try await cancelled.value; throw NSError(domain: "Cancellation ignored", code: 1) }
        catch TransportBURLSession.Failure.cancelled { }
        let pair = AsyncStream<(String, String?)>.makeStream()
        try route.openSocket(id: "messages", address: origin.replacingOccurrences(of: "https:", with: "wss:") + "/ws") { kind, text, _ in pair.continuation.yield((kind, text)) }
        var events = pair.stream.makeAsyncIterator()
        let opened = await events.next(); try check(opened?.0 == "open", "WSS open failed")
        try await route.sendSocket(id: "messages", text: "{\"type\":\"auth\",\"token\":\"fixture-device-session\"}")
        let ready = await events.next(); try check(ready?.1 == "{\"type\":\"ready\"}", "WSS auth/ready failed")
        try await route.sendSocket(id: "messages", text: "encrypted-message-frame")
        let frame = await events.next(); try check(frame?.1 == "encrypted-message-frame", "WSS message failed")
        route.closeSocket(id: "messages"); pair.continuation.finish()
        let (data, _) = try await URLSession.shared.data(from: URL(string: control + "/stop-proxy")!)
        let stats = try JSONSerialization.jsonObject(with: data) as! [String: Int]
        try check(stats["direct"] == 0 && stats["authenticated"]! >= 2 && stats["denied"]! >= 1 && stats["websocket"] == 1, "Proxy traversal not proven")
        let offline = try client(); defer { offline.close() }
        do { _ = try await offline.request(id: "no-direct-fallback", address: origin + "/health", method: "GET", headers: [:], body: nil, timeout: 2); throw NSError(domain: "Direct fallback occurred", code: 1) }
        catch TransportBURLSession.Failure.network { }
        print("PASS: authenticated SOCKS5, TLS GET/POST, WSS auth/ready/message, TLS rejection, origin policy, redirects, cancellation and no direct fallback")
    }
}
