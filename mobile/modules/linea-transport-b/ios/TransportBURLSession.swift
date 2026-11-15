import Foundation
import Network

/// App-owned URLSession only. No global proxy, custom TLS trust or direct failover.
/// The module supplies its immutable service origins; JS cannot add destinations.
@available(iOS 17.0, macOS 14.0, *)
final class TransportBURLSession: NSObject, URLSessionDataDelegate, URLSessionWebSocketDelegate {
    struct Reply {
        let status: Int
        let headers: [String: String]
        let body: Data
    }
    enum Failure: Error { case invalidRequest, unavailable, tooLarge, cancelled, network }
    private struct Pending {
        let id: String
        let task: URLSessionDataTask
        let complete: (Result<Reply, Error>) -> Void
        var response: HTTPURLResponse?
        var data = Data()
    }
    private struct Socket {
        let id: String
        let task: URLSessionWebSocketTask
        let event: (String, String?, Int?) -> Void
    }
    private let lock = NSLock()
    private let origins: Set<String>
    private var pending: [Int: Pending] = [:]
    private var sockets: [Int: Socket] = [:]
    private var closed = false
    private var session: URLSession!
    static let maxBody = 8 * 1024 * 1024
    static let maxMessage = 256 * 1024

    init(port: UInt16, username: String, password: String, origins: Set<String>) throws {
        guard port > 0, !username.isEmpty, !password.isEmpty, !origins.isEmpty else { throw Failure.invalidRequest }
        self.origins = origins
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        let proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!))
        proxy.applyCredential(username: username, password: password)
        proxy.allowFailover = false
        configuration.proxyConfigurations = [proxy]
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 340
        configuration.waitsForConnectivity = false
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }

    private func url(_ value: String, socket: Bool = false) throws -> URL {
        guard value.utf8.count <= 4096, let parts = URLComponents(string: value),
              parts.scheme == (socket ? "wss" : "https"), parts.user == nil, parts.password == nil,
              parts.fragment == nil, let host = parts.host, let result = parts.url else { throw Failure.invalidRequest }
        let origin = "https://\(host.lowercased())" + (parts.port.map { ":\($0)" } ?? "")
        guard origins.contains(origin) else { throw Failure.invalidRequest }
        return result
    }

    func request(id: String, address: String, method: String, headers: [String: String], body: Data?, timeout: TimeInterval = 30) async throws -> Reply {
        guard !id.isEmpty, id.utf8.count <= 128, ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(method),
              (body?.count ?? 0) <= 1024 * 1024, headers.count <= 64, timeout >= 1, timeout <= 340 else { throw Failure.invalidRequest }
        var request = URLRequest(url: try url(address))
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = timeout
        let forbidden: Set<String> = ["host", "connection", "upgrade", "proxy-authorization", "proxy-connection", "content-length", "transfer-encoding"]
        for (name, value) in headers {
            guard name.range(of: "^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$", options: .regularExpression) != nil,
                  value.utf8.count <= 8192, !value.contains("\r"), !value.contains("\n"),
                  !forbidden.contains(name.lowercased()) else { throw Failure.invalidRequest }
            request.setValue(value, forHTTPHeaderField: name)
        }
        return try await withTaskCancellationHandler {
          try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            guard !Task.isCancelled else { lock.unlock(); continuation.resume(throwing: Failure.cancelled); return }
            guard !closed, pending.count < 16, !pending.values.contains(where: { $0.id == id }) else {
                lock.unlock(); continuation.resume(throwing: Failure.unavailable); return
            }
            let task = session.dataTask(with: request)
            pending[task.taskIdentifier] = Pending(id: id, task: task, complete: { continuation.resume(with: $0) })
            lock.unlock()
            task.resume()
          }
        } onCancel: { self.cancel(id) }
    }

    func cancel(_ id: String) {
        lock.lock()
        let entry = pending.values.first { $0.id == id }
        if let entry { pending.removeValue(forKey: entry.task.taskIdentifier) }
        lock.unlock()
        entry?.task.cancel()
        entry?.complete(.failure(Failure.cancelled))
    }

    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true
        let requests = Array(pending.values), connections = Array(sockets.values)
        pending.removeAll(); sockets.removeAll()
        lock.unlock()
        session.invalidateAndCancel()
        requests.forEach { $0.complete(.failure(Failure.cancelled)) }
        connections.forEach { $0.event("close", nil, 1001) }
    }

    // Never carry authorization across a redirect, including redirects to another owned origin.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        guard pending[dataTask.taskIdentifier] != nil, let http = response as? HTTPURLResponse else {
            lock.unlock(); completionHandler(.cancel); return
        }
        if response.expectedContentLength > Int64(Self.maxBody) {
            let entry = pending.removeValue(forKey: dataTask.taskIdentifier)
            lock.unlock(); entry?.complete(.failure(Failure.tooLarge)); completionHandler(.cancel); return
        }
        pending[dataTask.taskIdentifier]?.response = http
        lock.unlock(); completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard var entry = pending[dataTask.taskIdentifier] else { lock.unlock(); return }
        if entry.data.count + data.count > Self.maxBody {
            pending.removeValue(forKey: dataTask.taskIdentifier)
            lock.unlock(); dataTask.cancel(); entry.complete(.failure(Failure.tooLarge)); return
        }
        entry.data.append(data); pending[dataTask.taskIdentifier] = entry
        lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let entry = pending.removeValue(forKey: task.taskIdentifier); lock.unlock()
        if let entry {
            if error != nil { entry.complete(.failure(Failure.network)); return }
            guard let response = entry.response else { entry.complete(.failure(Failure.network)); return }
            var headers: [String: String] = [:]
            for (name, value) in response.allHeaderFields { headers[String(describing: name)] = String(describing: value) }
            entry.complete(.success(Reply(status: response.statusCode, headers: headers, body: entry.data)))
        } else if error != nil { finishSocket(task.taskIdentifier, kind: "error", code: 1006) }
    }

    func openSocket(id: String, address: String, event: @escaping (String, String?, Int?) -> Void) throws {
        let address = try url(address, socket: true)
        guard !id.isEmpty, id.utf8.count <= 128 else { throw Failure.invalidRequest }
        lock.lock()
        guard !closed, sockets.count < 4, !sockets.values.contains(where: { $0.id == id }) else { lock.unlock(); throw Failure.unavailable }
        let task = session.webSocketTask(with: address)
        task.maximumMessageSize = Self.maxMessage
        sockets[task.taskIdentifier] = Socket(id: id, task: task, event: event)
        lock.unlock()
        task.resume()
        Task { [weak self, weak task] in
            guard let task else { return }
            while true {
                do {
                    let message = try await task.receive()
                    guard let self else { return }
                    let socket = self.lock.withLock { self.sockets[task.taskIdentifier] }
                    guard let socket else { return }
                    switch message {
                    case .string(let text): socket.event("message", text, nil)
                    case .data: self.finishSocket(task.taskIdentifier, kind: "error", code: 1003); return
                    @unknown default: self.finishSocket(task.taskIdentifier, kind: "error", code: 1003); return
                    }
                } catch { self?.finishSocket(task.taskIdentifier, kind: "error", code: 1006); return }
            }
        }
    }
    func sendSocket(id: String, text: String) async throws {
        guard text.utf8.count <= Self.maxMessage else { throw Failure.tooLarge }
        let task = lock.withLock { sockets.values.first { $0.id == id }?.task }
        guard let task else { throw Failure.unavailable }
        try await task.send(.string(text))
    }
    func closeSocket(id: String) {
        lock.lock(); let identifier = sockets.first { $0.value.id == id }?.key; lock.unlock()
        if let identifier { finishSocket(identifier, kind: "close", code: 1000) }
    }
    private func finishSocket(_ identifier: Int, kind: String, code: Int) {
        lock.lock(); let socket = sockets.removeValue(forKey: identifier); lock.unlock()
        socket?.task.cancel(with: .goingAway, reason: nil)
        socket?.event(kind, nil, code)
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        lock.lock(); let socket = sockets[webSocketTask.taskIdentifier]; lock.unlock()
        socket?.event("open", nil, nil)
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finishSocket(webSocketTask.taskIdentifier, kind: "close", code: closeCode.rawValue)
    }
}
