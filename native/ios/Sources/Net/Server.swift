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

    private func request(_ method: String, _ path: String, _ body: String?) throws -> URLRequest {
        guard base.hasPrefix("https://"), let url = URL(string: base + path),
              let made = Core.prepare(method: method, path: path, jsonBody: body != nil, token: token, proof: nil) else { throw ServerError.network("Нет связи с сервером. Проверь интернет и адрес подключения.") }
        var request = URLRequest(url: url, timeoutInterval: made.timeout)
        request.httpMethod = method
        for (name, value) in made.headers { request.setValue(value, forHTTPHeaderField: name) }
        request.httpBody = body?.data(using: .utf8)
        return request
    }

    private func answer(_ data: Data?, _ response: URLResponse?, _ error: Error?) -> Result<Any, ServerError> {
        if let error = error as? URLError, error.code == .timedOut { return .failure(.timeout) }
        guard error == nil, let http = response as? HTTPURLResponse else { return .failure(.network("Нет связи с сервером. Проверь интернет и адрес подключения.")) }
        let read = Core.read(status: http.statusCode, body: String(data: data ?? Data(), encoding: .utf8) ?? "")
        if let ok = read["ok"] { return .success(ok) }
        if let refused = read["refused"] as? [String: Any] {
            return .failure(.refused(message: refused["message"] as? String ?? "Не удалось выполнить запрос. Попробуй ещё раз.", status: http.statusCode, code: refused["code"] as? String, details: refused))
        }
        return .failure(.network("Сервер недоступен."))
    }

    /// Sends a request; the answer's JSON body comes back on a background queue.
    func send(_ method: String, _ path: String, body: String? = nil, done: @escaping (Result<Any, ServerError>) -> Void) {
        do {
            let request = try request(method, path, body)
            session.dataTask(with: request) { [weak self] data, response, error in
                done(self?.answer(data, response, error) ?? .failure(.network("Запрос отменён.")))
            }.resume()
        } catch { done(.failure(error as? ServerError ?? .network("Нет связи с сервером."))) }
    }

    /// The same, waiting for the answer on the calling thread (never the main one): the encryption service
    /// asks the server in the middle of its own work.
    func sendAndWait(_ method: String, _ path: String, body: String? = nil) -> Result<Any, ServerError> {
        precondition(!Thread.isMainThread)
        let waiting = DispatchSemaphore(value: 0)
        var result: Result<Any, ServerError> = .failure(.network("Нет связи с сервером."))
        send(method, path, body: body) { result = $0; waiting.signal() }
        waiting.wait()
        return result
    }
}
