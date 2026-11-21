import Foundation
import Network

// Offline: which server address the app talks to right now, how fast the connection is, and when the phone's
// network came back. Ported from the reference: mobile/src/servers/pool.ts + servers/list.ts (`chooseServer`,
// `fallbackServer`), mobile/src/network/quality.ts and network/netChange.ts.
//
// The account lives at a fixed «realm» (Account.server): keys and history on the device are tied to it, never to
// the address in use. For the real server the requests go to the fastest live address of: the realm itself, the
// address earlier builds used, and — only when no direct address answers (a VPN that cannot reach the server) —
// the reserve entrance through Cloudflare. Every address is HTTPS with the system's certificate checks; a local
// test server (simulator) is never pooled. The same rules are in the core (servers.rs, network.rs), which the
// phones do not reach for these yet.

/// How fast the connection really is, measured from the app's own requests (no permissions, no list of networks):
/// the round trip of small answers and the speed of big ones. The tier stretches the time limits (the core's
/// `request_timeout`): a 3 KB message on EDGE, or through a slow VPN, must not time out.
final class NetQuality {
    static let shared = NetQuality()
    private let lock = NSLock()
    private var rtt: Double? = nil
    private var kbps: Double? = nil
    private var now = "fast"

    /// "slow" ≈ EDGE/2G, "medium" ≈ 3G, "fast" ≈ LTE/Wi-Fi.
    var tier: String {
        lock.lock()
        defer { lock.unlock() }
        return now
    }

    /// One finished request: `ms` the whole time it took, `bytes` the size of the answer.
    func report(ms: Double, bytes: Int) {
        guard ms > 0, bytes >= 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        let alpha = 0.2
        if bytes < 4096 {
            if let old = rtt { rtt = old + alpha * (ms - old) } else { rtt = ms }
        } else if bytes >= 16384 {
            // One round trip is subtracted so a big answer from a fast but distant server is not called slow.
            let transfer = max(20, ms - (rtt ?? 0))
            let sample = Double(bytes) * 8 / transfer
            if let old = kbps { kbps = old + alpha * (sample - old) } else { kbps = sample }
        }
        now = NetQuality.classify(rtt: rtt, kbps: kbps)
    }

    static func classify(rtt: Double?, kbps: Double?) -> String {
        if let speed = kbps, speed < 200 { return "slow" }
        if let delay = rtt, delay > 900 { return "slow" }
        if let speed = kbps, speed < 2000 { return "medium" }
        if let delay = rtt, delay > 350 { return "medium" }
        return "fast"
    }
}

/// The addresses of the real server and the one in use.
final class ServerPool: NSObject, URLSessionTaskDelegate {
    static let shared = ServerPool()
    /// Posted (main queue) when the phone got its network back or moved to another one: the live line connects at
    /// once instead of waiting out its pause.
    static let networkBack = Notification.Name("invizent.network-back")

    static let realm = "https://api.invizent.com"
    /// Earlier builds connected through this address (the same server).
    static let legacy = ["https://141-133-194-51.nip.io"]
    /// Reserve entrance through Cloudflare: used only when no direct address answers. Messages stay end-to-end encrypted.
    static let edges = ["https://invizent-api.invizent-8165e2.workers.dev"]

    enum Rtt: Equatable {
        /// The last probe got no answer.
        case dead
        /// Round trip, milliseconds.
        case ms(Double)
    }

    private static let reprobeSeconds: TimeInterval = 5 * 60
    private static let downSeconds: TimeInterval = 60
    private static let storeKey = "invizent.servers.v1"

    private let lock = NSLock()
    private var current: String?
    /// Absent: never measured.
    private var rtt: [String: Rtt] = [:]
    private var down: [String: Date] = [:]
    private var probing = false
    private var started = false
    private var timer: Timer?
    private let monitor = NWPathMonitor()
    private var lastPath = ""
    private let queue = DispatchQueue(label: "invizent.servers", qos: .utility)
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    /// The probe never follows a redirect (the reference's `redirect: 'error'`).
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    static var candidates: [String] { [realm] + legacy + edges }

    /// Only the real server is pooled; a test server (simulator) is used as it is.
    func pooled(_ base: String) -> Bool { base == ServerPool.realm }

    /// Where the requests of an account at `base` go now (the realm until the first measurement).
    func endpoint(for base: String) -> String {
        guard pooled(base) else { return base }
        lock.lock()
        defer { lock.unlock() }
        return current ?? base
    }

    /// Restores the address the last run used, measures every address, and keeps measuring every few minutes;
    /// watches the phone's network. Safe to call more than once. Main queue.
    func start(base: String) {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] (path: NWPath) -> Void in self?.pathChanged(path) }
        monitor.start(queue: queue)
        guard pooled(base) else { return }
        if let saved = UserDefaults.standard.string(forKey: ServerPool.storeKey), let fields = Core.value(saved) as? [String: Any],
           let address = fields["current"] as? String, ServerPool.candidates.contains(address) {
            lock.lock()
            current = address
            lock.unlock()
        }
        measure()
        timer = Timer.scheduledTimer(withTimeInterval: ServerPool.reprobeSeconds, repeats: true) { [weak self] _ in self?.measure() }
    }

    /// Going offline is not a change to act on; coming back, or a different network, is (the reference's netChange.ts).
    private func pathChanged(_ path: NWPath) {
        let key: String
        if path.status == .satisfied {
            key = "net|" + path.availableInterfaces.map { "\($0.type)" }.joined(separator: ",")
        } else {
            key = "offline"
        }
        let previous = lastPath
        lastPath = key
        if previous.isEmpty || key == previous || key == "offline" { return }
        measure()
        DispatchQueue.main.async { NotificationCenter.default.post(name: ServerPool.networkBack, object: nil) }
    }

    /// Measures every address and switches if needed (one run at a time).
    func measure() {
        guard started else { return }
        lock.lock()
        if probing { lock.unlock(); return }
        probing = true
        let downNow = down
        lock.unlock()
        let urls = ServerPool.candidates
        let now = Date()
        let group = DispatchGroup()
        let resultLock = NSLock()
        var results: [String: Rtt] = [:]
        for url in urls {
            if let at = downNow[url], now.timeIntervalSince(at) < ServerPool.downSeconds {
                resultLock.lock()
                results[url] = .dead
                resultLock.unlock()
                continue
            }
            group.enter()
            probe(url, attempt: 0, best: nil) { (ms: Double?) -> Void in
                resultLock.lock()
                results[url] = ms.map { Rtt.ms($0) } ?? .dead
                resultLock.unlock()
                group.leave()
            }
        }
        group.notify(queue: queue) { [weak self] in
            guard let self else { return }
            resultLock.lock()
            let measured = results
            resultLock.unlock()
            let ordered: [(String, Rtt)] = urls.map { ($0, measured[$0] ?? .dead) }
            let direct = ordered.filter { !ServerPool.edges.contains($0.0) }
            let reserve = ordered.filter { ServerPool.edges.contains($0.0) }
            let directAlive = direct.contains { (pair: (String, Rtt)) -> Bool in
                if case .ms = pair.1 { return true }
                return false
            }
            self.lock.lock()
            let previous = self.current
            var keep: String? = previous
            if let held = previous, measured[held] == .dead { keep = nil }
            let keepDirect: String? = keep.flatMap { (url: String) -> String? in ServerPool.edges.contains(url) ? nil : url }
            let keepEdge: String? = keep.flatMap { (url: String) -> String? in ServerPool.edges.contains(url) ? url : nil }
            // The reserve entrance is chosen only when no direct address answers at all.
            var chosen = ServerPool.choose(keepDirect, direct)
            if chosen == nil, !directAlive { chosen = ServerPool.choose(keepEdge, reserve) }
            self.rtt = measured
            self.current = chosen ?? previous
            self.probing = false
            let saved = self.current
            self.lock.unlock()
            if let saved, let text = Core.text(["current": saved]) { UserDefaults.standard.set(text, forKey: ServerPool.storeKey) }
        }
    }

    /// `/health` twice; the best round trip, or nil when neither answered. Waits longer on a slow link
    /// (EDGE: one TLS handshake alone takes about a second).
    private func probe(_ url: String, attempt: Int, best: Double?, done: @escaping (Double?) -> Void) {
        guard attempt < 2 else { return done(best) }
        guard let address = URL(string: url + "/health") else { return done(best) }
        let tier = NetQuality.shared.tier
        let wait: TimeInterval = tier == "slow" ? 9 : tier == "medium" ? 5 : 3
        var request = URLRequest(url: address, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: wait)
        request.httpShouldHandleCookies = false
        let started = Date()
        session.dataTask(with: request) { [weak self] (_: Data?, response: URLResponse?, error: Error?) -> Void in
            var next = best
            if error == nil, let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) {
                let ms = Date().timeIntervalSince(started) * 1000
                next = min(best ?? ms, ms)
            }
            guard let self else { return done(next) }
            self.probe(url, attempt: attempt + 1, best: next, done: done)
        }.resume()
    }

    /// A request to `endpoint` got no answer (no connection, no answer in time, or the proxy in front of a server
    /// that is down): it is skipped at once and everything is measured again.
    func reportFailure(_ endpoint: String) {
        guard ServerPool.candidates.contains(endpoint) else { return }
        lock.lock()
        let now = Date()
        down[endpoint] = now
        rtt[endpoint] = .dead
        // Before the first measurement the realm is the address in use.
        if (current ?? ServerPool.realm) == endpoint {
            let next = ServerPool.fallback(failed: endpoint, all: ServerPool.candidates, rtt: rtt, down: down, now: now, downSeconds: ServerPool.downSeconds)
            current = next ?? current
        }
        lock.unlock()
        measure()
    }

    // MARK: The rules (servers/list.ts)

    /// Measured round trips decide; the current address is kept unless it fails or another is clearly faster
    /// (≥40 ms and ≥30 %), so the app does not flip-flop. Nil when nothing answered and nothing is kept.
    static func choose(_ current: String?, _ rtt: [(String, Rtt)]) -> String? {
        var alive: [(url: String, ms: Double, at: Int)] = []
        for (index, pair) in rtt.enumerated() {
            if case .ms(let ms) = pair.1 { alive.append((url: pair.0, ms: ms, at: index)) }
        }
        alive.sort { (a: (url: String, ms: Double, at: Int), b: (url: String, ms: Double, at: Int)) -> Bool in
            a.ms != b.ms ? a.ms < b.ms : a.at < b.at
        }
        guard let best = alive.first else { return current }
        if let current, let mine = rtt.first(where: { $0.0 == current }), case .ms(let now) = mine.1 {
            if !(now - best.ms >= 40 && best.ms <= now * 0.7) { return current }
        }
        return best.url
    }

    /// After `failed` stopped answering: measured-alive addresses first (fastest first), then never-measured ones;
    /// those whose last probe failed or that failed recently come after — and if every other address is known dead,
    /// it stays on `failed` (a slow link drops requests now and then).
    static func fallback(failed: String, all: [String], rtt: [String: Rtt], down: [String: Date], now: Date, downSeconds: TimeInterval) -> String? {
        let others = all.filter { $0 != failed }
        guard !others.isEmpty else { return nil }
        func rank(_ url: String) -> Int {
            if let at = down[url], now.timeIntervalSince(at) < downSeconds { return 2 }
            guard let known = rtt[url] else { return 1 }
            if case .ms = known { return 0 }
            return 2
        }
        func ms(_ url: String) -> Double {
            if let known = rtt[url], case .ms(let value) = known { return value }
            return 0
        }
        func downAt(_ url: String) -> Double { down[url]?.timeIntervalSince1970 ?? 0 }
        let sorted = others.enumerated().sorted { (a: (offset: Int, element: String), b: (offset: Int, element: String)) -> Bool in
            let first = rank(a.element), second = rank(b.element)
            if first != second { return first < second }
            if first == 0, ms(a.element) != ms(b.element) { return ms(a.element) < ms(b.element) }
            if first == 2, downAt(a.element) != downAt(b.element) { return downAt(a.element) < downAt(b.element) }
            return a.offset < b.offset
        }
        let best = sorted[0].element
        return rank(best) == 2 && all.contains(failed) ? failed : best
    }
}
