import Foundation

/// One upload or download of a sealed file, with its progress. HTTPS with the system's certificate checks, no
/// cookies, no cache, no redirects — the same rules as every other request (see `Server`). What travels here is
/// ciphertext only; it is kept in memory and never written to disk.
final class FileTransfer: NSObject, URLSessionDataDelegate {
    /// What ended a transfer without its result.
    enum Failure: Error {
        /// The words for the person.
        case words(String)
        /// The server refused the session's device proof: the request may be repeated once with a fresh one.
        case proof
        case cancelled
    }

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var stopped = false
    private var received = Data()
    private var status = 0
    private var limit = 0
    private var refusal: String?
    private var failure: Error?
    private let finished = DispatchSemaphore(value: 0)
    /// Bytes done and bytes in all; called on a background queue.
    var onProgress: ((Int, Int) -> Void)?

    /// Stops the transfer; the waiting call ends as cancelled.
    func cancel() {
        lock.lock()
        stopped = true
        let running = task
        lock.unlock()
        running?.cancel()
    }

    private var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    /// Runs one request to its end on the calling (background) thread. `limit`: the most bytes the answer may have.
    private func run(_ request: URLRequest, body: Data?, limit: Int) -> Result<Data, Failure> {
        precondition(!Thread.isMainThread)
        self.limit = limit
        let made: URLSessionTask
        if let body { made = session.uploadTask(with: request, from: body) } else { made = session.dataTask(with: request) }
        lock.lock()
        let cancelled = stopped
        if !cancelled { task = made }
        lock.unlock()
        if cancelled { session.invalidateAndCancel(); return .failure(.cancelled) }
        made.resume()
        finished.wait()
        session.finishTasksAndInvalidate()
        if isStopped { return .failure(.cancelled) }
        if let refusal { return .failure(.words(refusal)) }
        if let error = failure as? URLError, error.code == .timedOut { return .failure(.words("Сервер не ответил вовремя. Проверь подключение.")) }
        if failure != nil || status == 0 { return .failure(.words("Нет связи с сервером. Проверь интернет и адрес подключения.")) }
        return .success(received)
    }

    /// A redirect is never followed: the server does not send them, and following one would carry the session elsewhere.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        onProgress?(Int(totalBytesSent), Int(max(totalBytesSent, totalBytesExpectedToSend)))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // A download: the core judges the status and the announced size before a byte of the body is taken.
        if dataTask.originalRequest?.httpMethod == "GET" {
            let claimed: Any = response.expectedContentLength >= 0 ? NSNumber(value: response.expectedContentLength) : NSNull()
            if let words = FileCore.call("received", [status, claimed]) as? String {
                refusal = words
                completionHandler(.cancel)
                return
            }
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if received.count + data.count > limit {
            // More than the message's file can be: nothing of it is kept.
            if refusal == nil { refusal = "Размер вложения не совпадает с сообщением." }
            received = Data()
            dataTask.cancel()
            return
        }
        received.append(data)
        if dataTask.originalRequest?.httpMethod == "GET" { onProgress?(received.count, max(received.count, limit)) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        failure = error
        finished.signal()
    }

    // MARK: The two requests

    private static let unreachable = "Нет связи с сервером. Проверь интернет и адрес подключения."

    private static func request(_ server: Server, _ method: String, _ path: String, contentType: String?) -> URLRequest? {
        guard server.base.hasPrefix("https://"), let url = URL(string: server.base + path),
              let made = Core.prepare(method: method, path: path, jsonBody: false, token: server.token, proof: server.currentProof) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: made.timeout)
        request.httpMethod = method
        for (name, value) in made.headers { request.setValue(value, forHTTPHeaderField: name) }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        return request
    }

    /// `POST /e2ee/files`: one multipart part `file` with the sealed bytes. Gives the id the server keeps it under.
    func upload(_ server: Server, sealed: Data) -> Result<String, Failure> {
        guard server.token != nil else { return .failure(.words("Нужно войти в аккаунт.")) }
        guard let form = FileCore.call("uploadForm") as? [String: Any], let head = (form["head"] as? String)?.data(using: .utf8), let tail = (form["tail"] as? String)?.data(using: .utf8),
              let contentType = form["contentType"] as? String, let request = FileTransfer.request(server, "POST", "/e2ee/files", contentType: contentType) else { return .failure(.words(FileTransfer.unreachable)) }
        var body = Data(capacity: head.count + sealed.count + tail.count)
        body.append(head)
        body.append(sealed)
        body.append(tail)
        switch run(request, body: body, limit: 64 * 1024) {
        case .failure(let failure): return .failure(failure)
        case .success(let answer):
            let read = Core.read(status: status, body: String(data: answer, encoding: .utf8) ?? "")
            if let ok = read["ok"] as? [String: Any], let id = ok["id"] as? String, !id.isEmpty { return .success(id) }
            if let refused = read["refused"] as? [String: Any] {
                if status == 401, refused["code"] as? String == "device_proof" { return .failure(.proof) }
                return .failure(.words(refused["message"] as? String ?? "Не удалось выполнить запрос. Попробуй ещё раз."))
            }
            return .failure(.words("Сервер недоступен."))
        }
    }

    /// `GET /files/<id>`: the sealed bytes of an attachment, exactly `cipherSize` of them or nothing.
    func download(_ server: Server, id: String, cipherSize: Int) -> Result<Data, Failure> {
        guard server.token != nil else { return .failure(.words("Нужно войти в аккаунт.")) }
        guard server.base.hasPrefix("https://") else { return .failure(.words("Файлы загружаются только по защищённому соединению.")) }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
        guard let name = id.addingPercentEncoding(withAllowedCharacters: allowed), let request = FileTransfer.request(server, "GET", "/files/" + name, contentType: nil) else { return .failure(.words(FileTransfer.unreachable)) }
        switch run(request, body: nil, limit: cipherSize) {
        case .failure(let failure): return .failure(failure)
        case .success(let data):
            guard (200..<300).contains(status) else { return .failure(.words("Не удалось загрузить зашифрованный файл.")) }
            return .success(data)
        }
    }
}

extension Server {
    /// Uploads a sealed file as this session. Uploads are not in the core's table of operations: the request is
    /// made here, with the session's headers from `Core.prepare`. A session bound to this device's key needs a
    /// fresh proof, and an upload cannot repeat itself: a small signed-in request goes first (it renews the
    /// proof when one is due), and an upload refused for lack of the proof is sent once more after another.
    /// Waits on the calling (background) thread.
    func uploadSealedFile(_ sealed: Data, transfer: FileTransfer) -> Result<String, FileTransfer.Failure> {
        for attempt in 0..<2 {
            if case .failure(let error) = sendAndWait("GET", "/e2ee/limits") {
                if case .refused(_, let status, _, _) = error, status != 401 {
                    // The limits themselves are not needed here; only a signed-out session stops the upload.
                } else {
                    return .failure(.words(error.words))
                }
            }
            let fresh = attempt == 0 ? transfer : FileTransfer()
            fresh.onProgress = transfer.onProgress
            let result = fresh.upload(self, sealed: sealed)
            if case .failure(.proof) = result, attempt == 0 { continue }
            if case .failure(.proof) = result { return .failure(.words("Не удалось подтвердить устройство. Попробуй ещё раз.")) }
            return result
        }
        return .failure(.words("Не удалось подтвердить устройство. Попробуй ещё раз."))
    }

    /// Downloads the sealed bytes of an attachment as this session.
    func downloadSealedFile(id: String, cipherSize: Int, transfer: FileTransfer) -> Result<Data, FileTransfer.Failure> {
        transfer.download(self, id: id, cipherSize: cipherSize)
    }
}
