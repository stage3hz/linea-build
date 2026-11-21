import Foundation

/// Big files: the chunked scheme of the core (native/core/src/e2ee/files.rs — `seal_chunk`, `open_chunk`), the
/// resumable upload and the ranged download around it.
/// Reference: mobile/src/e2ee/attachments.ts (`uploadChunks`, `downloadChunked`, `limitError`, `sizeLabel`).
/// One 4 MiB chunk is in memory at a time. What travels is ciphertext only; keys and bytes are never logged.
enum ChunkCore {
    private static func take(_ pointer: UnsafeMutablePointer<CChar>?) -> String? {
        guard let pointer else { return nil }
        defer { invizent_string_free(pointer) }
        return String(cString: pointer)
    }

    private static func finish(_ words: String?, _ out: InvizentBytes) -> Result<Data, FileCore.Failure> {
        defer { invizent_file_bytes_free(out) }
        if let words { return .failure(FileCore.Failure(words: words)) }
        guard let data = out.data else { return .success(Data()) }
        return .success(Data(bytes: data, count: out.len))
    }

    /// Seals chunk `index` of a file of `size` bytes with the key `FileCore.call("newChunkedEncryption")` gave.
    static func seal(_ plain: Data, encryption: [String: Any], index: Int, size: Int) -> Result<Data, FileCore.Failure> {
        guard let json = Core.text(encryption) else { return .failure(FileCore.Failure(words: "Не удалось зашифровать файл.")) }
        var out = InvizentBytes(data: nil, len: 0)
        let words: String? = plain.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> String? in
            let bytes = raw.bindMemory(to: UInt8.self).baseAddress
            return json.withCString { (text: UnsafePointer<CChar>) -> String? in
                take(invizent_file_seal_chunk(bytes, plain.count, text, UInt64(index), UInt64(size), &out))
            }
        }
        return finish(words, out)
    }

    /// Opens chunk `index` of a downloaded file with the key of its message.
    static func open(_ cipher: Data, attachmentJSON: String, index: Int) -> Result<Data, FileCore.Failure> {
        var out = InvizentBytes(data: nil, len: 0)
        let words: String? = cipher.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> String? in
            let bytes = raw.bindMemory(to: UInt8.self).baseAddress
            return attachmentJSON.withCString { (text: UnsafePointer<CChar>) -> String? in
                take(invizent_file_open_chunk(bytes, cipher.count, text, UInt64(index), &out))
            }
        }
        return finish(words, out)
    }

    /// Whether an attachment uses the chunked scheme.
    static func isChunked(_ attachment: [String: Any]) -> Bool {
        (attachment["encryption"] as? [String: Any])?["scheme"] as? String == "aes-256-gcm-siv-chunked"
    }

    /// Where chunk `index` of a file of `size` bytes stands on the server, and how long it is.
    static func chunk(size: Int, index: Int) -> (start: Int, end: Int, plain: Int)? {
        guard let made = FileCore.call("chunk", [size, index]) as? [String: Any], let start = (made["start"] as? NSNumber)?.intValue,
              let end = (made["end"] as? NSNumber)?.intValue, let plain = (made["plain"] as? NSNumber)?.intValue else { return nil }
        return (start, end, plain)
    }
}

/// One plain request of a big transfer, waited for on a background thread. The same rules as every other
/// request: HTTPS with the system's checks, no cookies, no cache, no redirects.
final class ChunkRequest: NSObject, URLSessionDataDelegate {
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    private var received = Data()
    private var limit = 0
    private var tooMuch = false
    private var status = 0
    private var failed = false
    private let finished = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var stopped = false

    func cancel() {
        lock.lock()
        stopped = true
        let running = task
        lock.unlock()
        running?.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = (response as? HTTPURLResponse)?.statusCode ?? 0
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if received.count + data.count > limit {
            tooMuch = true
            received = Data()
            dataTask.cancel()
            return
        }
        received.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        failed = error != nil
        finished.signal()
    }

    /// Sends the request and waits. Nil: no answer (no connection, cancelled, or more bytes than `limit`).
    func run(_ server: Server, method: String, path: String, range: String?, body: Data?, limit: Int) -> (status: Int, body: Data)? {
        guard server.endpoint.hasPrefix("https://"), let url = URL(string: server.endpoint + path),
              let made = Core.prepare(method: method, path: path, jsonBody: false, token: server.token, proof: server.currentProof) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: max(made.timeout, 120))
        request.httpMethod = method
        for (name, value) in made.headers { request.setValue(value, forHTTPHeaderField: name) }
        if let range { request.setValue(range, forHTTPHeaderField: "Range") }
        if body != nil { request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type") }
        self.limit = limit
        let made2: URLSessionTask
        if let body { made2 = session.uploadTask(with: request, from: body) } else { made2 = session.dataTask(with: request) }
        lock.lock()
        let cancelled = stopped
        if !cancelled { task = made2 }
        lock.unlock()
        if cancelled {
            session.invalidateAndCancel()
            return nil
        }
        made2.resume()
        finished.wait()
        session.finishTasksAndInvalidate()
        if failed || tooMuch || status == 0 { return nil }
        return (status, received)
    }
}

/// What a big upload needs to go on after a lost connection: the same key and the server's upload id.
struct BigUploadState {
    var encryption: [String: Any]
    var sessionId: String?
}

/// A big transfer that can be stopped from another thread.
final class BigTransfer {
    private let lock = NSLock()
    private var stopped = false
    private var request: ChunkRequest?
    /// The upload's state, kept for «повторить» (main queue reads it after a failure).
    var state: BigUploadState?

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    func cancel() {
        lock.lock()
        stopped = true
        let running = request
        lock.unlock()
        running?.cancel()
    }

    fileprivate func fresh() -> ChunkRequest {
        let made = ChunkRequest()
        lock.lock()
        request = made
        let cancelled = stopped
        lock.unlock()
        if cancelled { made.cancel() }
        return made
    }
}

enum BigFiles {
    static let cancelled = "Загрузка отменена."
    private static let platinaFile = 4 * 1024 * 1024 * 1024

    /// «1.5 ГБ», «100 МБ» — as the reference's limits are worded.
    static func sizeLabel(_ bytes: Int) -> String {
        let gib = 1024.0 * 1024.0 * 1024.0
        if Double(bytes) >= gib {
            let text = String(format: "%.1f", Double(bytes) / gib).replacingOccurrences(of: ".0", with: "")
            return text + " ГБ"
        }
        return String(Int((Double(bytes) / (1024.0 * 1024.0)).rounded())) + " МБ"
    }

    private static func object(_ result: Result<Any, ServerError>) -> [String: Any]? {
        if case .success(let value) = result { return value as? [String: Any] }
        return nil
    }

    private static func json(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private static func limitWords(_ limits: [String: Any], video: Bool, size: Int) -> String? {
        let file = (limits["maxFileBytes"] as? NSNumber)?.intValue ?? 0
        let most = video ? ((limits["maxVideoBytes"] as? NSNumber)?.intValue ?? file) : file
        if most <= 0 || (size > 0 && size <= most) { return nil }
        if video { return "Видео больше " + sizeLabel(most) + "." }
        let platina = limits["platina"] as? Bool ?? false
        if !platina && platinaFile > most { return "Файл больше " + sizeLabel(most) + ". С Platina можно отправлять файлы до " + sizeLabel(platinaFile) + "." }
        return "Файл больше " + sizeLabel(most) + "."
    }

    /// Encrypts and uploads a file chunk by chunk; an interrupted upload goes on from the last chunk the server
    /// confirmed (`transfer.state` keeps the key and the upload's id). Gives the server's id of the file and the
    /// encryption for the message. Runs on the calling (background) thread. `progress`: plaintext bytes sent, of all.
    static func upload(_ server: Server, file: URL, video: Bool, transfer: BigTransfer, restarted: Bool = false, progress: @escaping (Int, Int) -> Void) -> Result<(id: String, encryption: [String: Any], size: Int), FileCore.Failure> {
        precondition(!Thread.isMainThread)
        func fail(_ words: String) -> Result<(id: String, encryption: [String: Any], size: Int), FileCore.Failure> { .failure(FileCore.Failure(words: words)) }
        guard server.token != nil else { return fail("Нужно войти в аккаунт.") }
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        guard size > 0, let plan = FileCore.call("chunks", [size]) as? [String: Any], let count = (plan["count"] as? NSNumber)?.intValue,
              let total = (plan["cipherSize"] as? NSNumber)?.intValue else { return fail("Не удалось определить размер файла.") }
        // The limits are asked first; the request also renews the session's device proof when one is due.
        if let limits = object(server.sendAndWait("GET", "/e2ee/limits")), let words = limitWords(limits, video: video, size: size) { return fail(words) }

        var state = transfer.state
        var received = 0
        if let known = state, let session = known.sessionId {
            if let answer = object(server.sendAndWait("GET", "/e2ee/uploads/" + session)), let got = (answer["received"] as? NSNumber)?.intValue {
                received = got
            } else {
                state = nil
            }
        }
        if state?.sessionId == nil {
            // From the first byte: a new key — different bytes are never sealed under the same key and nonce.
            guard let encryption = FileCore.call("newChunkedEncryption") as? [String: Any] else { return fail("Шифрование ещё не готово. Попробуй ещё раз.") }
            guard let body = Core.text(["size": size, "kind": video ? "video" : "file"]) else { return fail("Не удалось отправить файл.") }
            switch server.sendAndWait("POST", "/e2ee/uploads", body: body) {
            case .failure(let error): return fail(error.words)
            case .success(let value):
                guard let id = (value as? [String: Any])?["id"] as? String, !id.isEmpty else { return fail("Сервер отклонил файл.") }
                state = BigUploadState(encryption: encryption, sessionId: id)
            }
            received = 0
        }
        guard let ready = state, let session = ready.sessionId else { return fail("Не удалось отправить файл.") }
        transfer.state = ready
        guard let handle = try? FileHandle(forReadingFrom: file) else { return fail("Не удалось прочитать файл.") }
        defer { try? handle.close() }
        let first = (FileCore.call("chunkAfter", [received]) as? NSNumber)?.intValue ?? 0
        var index = first
        while index < count {
            if transfer.isCancelled { return fail(cancelled) }
            guard let place = ChunkCore.chunk(size: size, index: index) else { return fail("Не удалось определить размер файла.") }
            let offset = index * 4 * 1024 * 1024
            var plain = Data()
            do {
                try handle.seek(toOffset: UInt64(offset))
                plain = try handle.read(upToCount: place.plain) ?? Data()
            } catch { return fail("Не удалось прочитать файл.") }
            if plain.count != place.plain { return fail("Файл изменился во время отправки.") }
            let sealed: Data
            switch ChunkCore.seal(plain, encryption: ready.encryption, index: index, size: size) {
            case .success(let data): sealed = data
            case .failure(let failure): return .failure(failure)
            }
            plain = Data()
            let next = min(total, place.start + sealed.count)
            var attempt = 0
            var busyFor = 0
            var sent = false
            while !sent {
                if transfer.isCancelled { return fail(cancelled) }
                let answer = transfer.fresh().run(server, method: "PUT", path: "/e2ee/uploads/" + session + "?offset=" + String(place.start), range: nil, body: sealed, limit: 64 * 1024)
                if transfer.isCancelled { return fail(cancelled) }
                let status = answer?.status ?? 0
                let body = answer.map { json($0.body) } ?? [:]
                let code = body["code"] as? String ?? ""
                if status == 200 { sent = true; continue }
                // The chunk got through but the reply was lost: the server already has it.
                if status == 409, (body["received"] as? NSNumber)?.intValue == next { sent = true; continue }
                // An earlier request of this upload still runs on the server: wait without spending the retries.
                if status == 409, code == "UPLOAD_BUSY", busyFor < 90 {
                    Thread.sleep(forTimeInterval: 5)
                    busyFor += 5
                    continue
                }
                // The server lost the part file: drop the session and start over once, with a new key.
                if status == 409, code == "UPLOAD_LOST", !restarted {
                    _ = server.sendAndWait("DELETE", "/e2ee/uploads/" + session)
                    transfer.state = nil
                    return upload(server, file: file, video: video, transfer: transfer, restarted: true, progress: progress)
                }
                // The session's device proof was refused: a small signed-in request renews it, then the chunk goes again.
                if status == 401, code == "device_proof", attempt < 2 {
                    _ = server.sendAndWait("GET", "/e2ee/uploads/" + session)
                    attempt += 1
                    continue
                }
                if [401, 403, 404, 413, 507].contains(status) { return fail(body["error"] as? String ?? body["message"] as? String ?? "Сервер отклонил файл.") }
                if attempt >= 5 { return fail("Связь прервалась. Нажми «повторить» — отправка продолжится с того же места.") }
                Thread.sleep(forTimeInterval: 0.8 * pow(2, Double(attempt)))
                attempt += 1
            }
            progress(min(size, offset + place.plain), size)
            index += 1
        }
        if transfer.isCancelled { return fail(cancelled) }
        switch server.sendAndWait("POST", "/e2ee/uploads/" + session + "/complete") {
        case .failure(let error): return fail(error.words)
        case .success(let value):
            guard let done = value as? [String: Any], let id = done["id"] as? String, !id.isEmpty else { return fail("Сервер отклонил файл.") }
            if (done["size"] as? NSNumber)?.intValue != total { return fail("Размер загруженного файла не совпадает.") }
            transfer.state = nil
            return .success((id, ready.encryption, size))
        }
    }

    /// Drops an unfinished big upload on the server.
    static func forget(_ server: Server, state: BigUploadState?) {
        guard let session = state?.sessionId else { return }
        server.send("DELETE", "/e2ee/uploads/" + session) { _ in }
    }

    /// Downloads a chunked file by byte ranges and opens it chunk by chunk straight into `target` (a new file,
    /// protected by the device's passcode key). Nothing of a chunk is written before its own check passed — its
    /// exact size, its own nonce, its place and the number of chunks. A failure leaves no file behind.
    /// Runs on the calling (background) thread. `progress`: plaintext bytes written, of all.
    static func download(_ server: Server, attachment: [String: Any], to target: URL, transfer: BigTransfer, progress: @escaping (Int, Int) -> Void) -> Result<Void, FileCore.Failure> {
        precondition(!Thread.isMainThread)
        func fail(_ words: String) -> Result<Void, FileCore.Failure> {
            try? FileManager.default.removeItem(at: target)
            return .failure(FileCore.Failure(words: words))
        }
        var bare = attachment
        bare["preview"] = nil
        guard let about = FileCore.call("chunked", [bare]) as? [String: Any] else { return fail("У вложения нет ключа сквозного шифрования.") }
        if let refusal = about["refusal"] as? String { return fail(refusal) }
        guard let size = (about["size"] as? NSNumber)?.intValue, let count = (about["count"] as? NSNumber)?.intValue,
              let id = attachment["id"] as? String, let message = Core.text(bare) else { return fail("У вложения нет ключа сквозного шифрования.") }
        guard server.token != nil else { return fail("Нужно войти в аккаунт.") }
        guard server.endpoint.hasPrefix("https://") else { return fail("Файлы загружаются только по защищённому соединению.") }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
        guard let name = id.addingPercentEncoding(withAllowedCharacters: allowed) else { return fail("Файл недоступен.") }
        let manager = FileManager.default
        try? manager.removeItem(at: target)
        guard manager.createFile(atPath: target.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]),
              let handle = try? FileHandle(forWritingTo: target) else { return fail("Не удалось открыть файл.") }
        defer { try? handle.close() }
        var written = 0
        for index in 0..<count {
            guard let place = ChunkCore.chunk(size: size, index: index) else { return fail("Размер вложения не совпадает с сообщением.") }
            let wanted = place.end - place.start + 1
            var cipher: Data?
            var attempt = 0
            while cipher == nil {
                if transfer.isCancelled { return fail(cancelled) }
                let answer = transfer.fresh().run(server, method: "GET", path: "/files/" + name, range: "bytes=" + String(place.start) + "-" + String(place.end), body: nil, limit: wanted)
                if transfer.isCancelled { return fail(cancelled) }
                if let answer, answer.status == 206 || (answer.status == 200 && count == 1), answer.body.count == wanted {
                    cipher = answer.body
                    continue
                }
                if let answer, [401, 403, 404].contains(answer.status) { return fail("Файл недоступен.") }
                if attempt >= 5 { return fail("Не удалось загрузить файл. Проверь интернет и попробуй ещё раз.") }
                Thread.sleep(forTimeInterval: 0.8 * pow(2, Double(attempt)))
                attempt += 1
            }
            guard let sealed = cipher else { return fail("Не удалось загрузить файл. Проверь интернет и попробуй ещё раз.") }
            switch ChunkCore.open(sealed, attachmentJSON: message, index: index) {
            case .failure(let failure): return fail(failure.words)
            case .success(let plain):
                do { try handle.write(contentsOf: plain) } catch { return fail("Не удалось открыть файл.") }
                written += plain.count
            }
            progress(written, size)
        }
        return .success(())
    }
}
