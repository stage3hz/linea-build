import Foundation

/// Why a request to the server did not give its answer.
enum ServerError: Error {
    /// No answer came: there may be no internet.
    case network(String)
    /// The server answered no, in its own words.
    case refused(message: String, status: Int, code: String?, details: [String: Any])
    case timeout

    /// The words for the person.
    var words: String {
        switch self {
        case .network(let words): return words
        case .refused(let message, _, _, _): return message
        case .timeout: return "Сервер не ответил вовремя. Проверь подключение."
        }
    }
}

/// One server, and the session on it when signed in. Every request is HTTPS with the system's certificate
/// checks; no cookies, no cache, no redirects.
final class Server: NSObject, URLSessionTaskDelegate {
    let base: String
    var token: String?
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    init(base: String, token: String? = nil) {
        self.base = base.hasSuffix("/") ? String(base.dropLast()) : base
        self.token = token
    }

    /// A redirect is never followed: the server does not send them, and following one would carry the session elsewhere.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// The session's device proof (see DeviceProof). Its own requests go out without waiting for a proof.
    private lazy var proof: DeviceProof = {
        let proof = DeviceProof()
        proof.post = { [weak self] path, body in
            guard let self, let request = try? self.request("POST", path, body) else { return nil }
            let (data, response, error) = self.wait(request)
            guard error == nil, let http = response as? HTTPURLResponse else { return nil }
            return Core.read(status: http.statusCode, body: String(data: data ?? Data(), encoding: .utf8) ?? "")
        }
        return proof
    }()
    /// The proof for the live line's first frame.
    var currentProof: String? { token == nil ? nil : proof.current }
    private let work = DispatchQueue(label: "invizent.server", qos: .userInitiated, attributes: .concurrent)

    /// Offline: where the requests go now — the account's server itself, or, for the real server, the fastest live
    /// address of it (Sources/Offline/ServerPool.swift). `base` stays the account's identity.
    var endpoint: String { ServerPool.shared.endpoint(for: base) }

    private func request(_ method: String, _ path: String, _ body: String?, to target: String? = nil) throws -> URLRequest {
        let host = target ?? endpoint
        guard host.hasPrefix("https://"), let url = URL(string: host + path),
              let made = Core.prepare(method: method, path: path, jsonBody: body != nil, token: token, proof: token == nil ? nil : proof.current, tier: NetQuality.shared.tier) else { throw ServerError.network("Нет связи с сервером. Проверь интернет и адрес подключения.") }
        var request = URLRequest(url: url, timeoutInterval: made.timeout)
        request.httpMethod = method
        for (name, value) in made.headers { request.setValue(value, forHTTPHeaderField: name) }
        request.httpBody = body?.data(using: .utf8)
        return request
    }

    private func wait(_ request: URLRequest) -> (Data?, URLResponse?, Error?) {
        let waiting = DispatchSemaphore(value: 0)
        var result: (Data?, URLResponse?, Error?) = (nil, nil, nil)
        session.dataTask(with: request) { data, response, error in result = (data, response, error); waiting.signal() }.resume()
        waiting.wait()
        return result
    }

    /// One request to one address. `unreached`: no answer at all (no connection, no answer in time, or the proxy in
    /// front of a server that is down); `notDelivered`: provably never reached the server itself (502/503/504).
    private func attempt(_ method: String, _ path: String, _ body: String?, to target: String) -> (result: Result<Any, ServerError>, unreached: Bool, notDelivered: Bool) {
        guard let request = try? request(method, path, body, to: target) else { return (Result<Any, ServerError>.failure(.network("Нет связи с сервером. Проверь интернет и адрес подключения.")), false, false) }
        let started = Date()
        let (data, response, error) = wait(request)
        if let error = error as? URLError, error.code == .timedOut { return (Result<Any, ServerError>.failure(.timeout), true, false) }
        guard error == nil, let http = response as? HTTPURLResponse else { return (Result<Any, ServerError>.failure(.network("Нет связи с сервером. Проверь интернет и адрес подключения.")), true, false) }
        if http.statusCode < 500 { NetQuality.shared.report(ms: Date().timeIntervalSince(started) * 1000, bytes: data?.count ?? 0) }
        let read = Core.read(status: http.statusCode, body: String(data: data ?? Data(), encoding: .utf8) ?? "")
        if read["updateRequired"] as? Bool == true { UpdateGate.markRequired() } // Shell: 426 — this build is retired (Shell/UpdateGate.swift)
        if let ok = read["ok"] { return (Result<Any, ServerError>.success(ok), false, false) }
        if let refused = read["refused"] as? [String: Any] {
            return (Result<Any, ServerError>.failure(.refused(message: refused["message"] as? String ?? "Не удалось выполнить запрос. Попробуй ещё раз.", status: http.statusCode, code: refused["code"] as? String, details: refused)), false, false)
        }
        return (Result<Any, ServerError>.failure(.network("Сервер недоступен.")), true, true)
    }

    /// One request; for the real server, an address that gives no answer is skipped at once (the reference's
    /// `Api.send`): only reads, or a request that provably never arrived, are repeated on the next address by
    /// themselves — writes have their own retries (messages are idempotent by their client id), so nothing is
    /// ever done twice.
    private func once(_ method: String, _ path: String, _ body: String?) -> Result<Any, ServerError> {
        let target = endpoint
        let first = attempt(method, path, body, to: target)
        guard first.unreached, ServerPool.shared.pooled(base) else { return first.result }
        ServerPool.shared.reportFailure(target)
        let next = endpoint
        let verb = method.uppercased()
        guard next != target, verb == "GET" || verb == "HEAD" || first.notDelivered else { return first.result }
        return attempt(method, path, body, to: next).result
    }

    /// One request with everything around it, waiting for the answer on the calling thread (never the main one).
    /// A signed-in session is bound to this device's key: a request known to need the proof waits for a fresh
    /// one, and a request the server refuses for lack of it is repeated once with a new proof (the refused
    /// request did nothing, so repeating a write is safe).
    func sendAndWait(_ method: String, _ path: String, body: String? = nil) -> Result<Any, ServerError> {
        precondition(!Thread.isMainThread)
        let bound = token != nil && !path.hasPrefix("/auth/device/")
        guard bound else { return once(method, path, body) }
        let first = proof.due && !proof.known
        if proof.due && !first { _ = proof.ensure(force: false) }
        let seen = proof.generation
        // Not known yet whether this session needs a proof: the request goes at once, the exchange starts beside it.
        if first { work.async { [proof] in _ = proof.ensure(force: false) } }
        let result = once(method, path, body)
        guard case .failure(.refused(_, 401, let code, _)) = result, code == "device_proof" else { return result }
        switch proof.ensure(force: true, seen: seen) {
        case .lost: return .failure(.refused(message: "Войдите в аккаунт заново.", status: 401, code: nil, details: [:]))
        case .failed: return .failure(.network("Не удалось подтвердить устройство. Проверь подключение."))
        case .ok:
            let again = once(method, path, body)
            // Still refused with a fresh proof: not a reason to sign the account out — say it could not be done.
            if case .failure(.refused(_, 401, let code, _)) = again, code == "device_proof" { return .failure(.network("Не удалось подтвердить устройство. Попробуй ещё раз.")) }
            return again
        }
    }

    /// Sends a request; the answer's JSON body comes back on a background queue.
    func send(_ method: String, _ path: String, body: String? = nil, done: @escaping (Result<Any, ServerError>) -> Void) {
        work.async { done(self.sendAndWait(method, path, body: body)) }
    }

    /// A server operation by its name (the table is in the core): `op("chats", [])`.
    func op(_ name: String, _ args: [Any], done: @escaping (Result<Any, ServerError>) -> Void) {
        guard let call = Core.call(name, args) else { return done(.failure(.network("Не удалось выполнить запрос. Попробуй ещё раз."))) }
        send(call.method, call.path, body: call.body, done: done)
    }

    func opAndWait(_ name: String, _ args: [Any]) -> Result<Any, ServerError> {
        guard let call = Core.call(name, args) else { return .failure(.network("Не удалось выполнить запрос. Попробуй ещё раз.")) }
        return sendAndWait(call.method, call.path, body: call.body)
    }
}
