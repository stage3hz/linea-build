import ImageIO
import UIKit

// «Каналы»: the requests that are not in the core's table of operations — plain files (a channel's attachments
// and pictures are not end-to-end encrypted, by the reference's design) — and the pictures' cache.
// Every request is HTTPS as the signed-in session, with the system's certificate checks; redirects are never
// followed; nothing is cached by the system.

/// Downloads to a file and one-request uploads. Waits on the calling thread: never call it on the main one.
final class ChannelTransfer: NSObject, URLSessionTaskDelegate {
    static let shared = ChannelTransfer()

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// A request of the signed-in session; nil when it cannot be made (no HTTPS address, no headers).
    static func request(_ server: Server, _ method: String, _ path: String, contentType: String?) -> URLRequest? {
        guard server.token != nil, server.base.hasPrefix("https://"), let url = URL(string: server.base + path),
              let made = Core.prepare(method: method, path: path, jsonBody: false, token: server.token, proof: server.currentProof) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: made.timeout)
        request.httpMethod = method
        for (name, value) in made.headers { request.setValue(value, forHTTPHeaderField: name) }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        return request
    }

    /// Downloads what the request answers into `file`. True when the server answered 200 and the file is there.
    func fetch(_ request: URLRequest, to file: URL) -> Bool {
        let waiting = DispatchSemaphore(value: 0)
        var done = false
        let task = session.downloadTask(with: request) { (location: URL?, response: URLResponse?, error: Error?) -> Void in
            if error == nil, let location, (response as? HTTPURLResponse)?.statusCode == 200 {
                let manager = FileManager.default
                try? manager.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? manager.removeItem(at: file)
                if (try? manager.moveItem(at: location, to: file)) != nil { done = true }
            }
            waiting.signal()
        }
        task.resume()
        waiting.wait()
        return done
    }

    /// Sends a body and gives the answer's status and bytes (status 0: no answer came).
    func send(_ request: URLRequest, body: Data) -> (status: Int, data: Data) {
        let waiting = DispatchSemaphore(value: 0)
        var status = 0
        var answer = Data()
        let task = session.uploadTask(with: request, from: body) { (data: Data?, response: URLResponse?, error: Error?) -> Void in
            if error == nil, let http = response as? HTTPURLResponse {
                status = http.statusCode
                answer = data ?? Data()
            }
            waiting.signal()
        }
        task.resume()
        waiting.wait()
        return (status, answer)
    }
}

extension Server {
    /// `/files/<id>` — where an uploaded file is read from (reference: Api.fileUrl).
    static func filePath(_ id: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
        return "/files/" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }

    /// The link of an invitation as it is shared (reference: Api.inviteUrl).
    func inviteAddress(_ code: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
        return base + "/i/" + (code.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }

    /// Uploads one plain file in one multipart request, as the reference's `sendMultipart` does
    /// (`POST /uploads`, the part is called `file`). `purpose`: "channel" for a channel's attachment, nil for a
    /// community's picture. Gives the server's `attachment`. Waits on the calling (background) thread.
    ///
    /// A session bound to this device's key needs a fresh proof and an upload cannot repeat itself, so a small
    /// signed-in request goes first (it renews the proof when one is due), and an upload refused for lack of
    /// the proof is sent once more.
    func uploadPlainFile(_ bytes: Data, name: String, mimeType: String, purpose: String?) -> Result<[String: Any], ServerError> {
        let unreachable = ServerError.network("Нет связи с сервером. Проверь интернет и адрес подключения.")
        let path = purpose == nil ? "/uploads" : "/uploads?purpose=" + (purpose ?? "")
        // The same body as the reference's `multipartFile`.
        let boundary = "----invizent" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        var safeName = ""
        for character in name.prefix(200) {
            safeName.append(character == "\"" || character == "\\" || character == "\r" || character == "\n" ? "_" : character)
        }
        if safeName.isEmpty { safeName = "file" }
        let typeRule = try? NSRegularExpression(pattern: "^[\\w.+-]+/[\\w.+-]+$", options: [])
        let typeFits = typeRule?.firstMatch(in: mimeType, options: [], range: NSRange(location: 0, length: (mimeType as NSString).length)) != nil
        let safeType = typeFits ? mimeType : "application/octet-stream"
        let head = "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(safeType)\r\n\r\n"
        let tail = "\r\n--\(boundary)--\r\n"
        var body = Data(capacity: bytes.count + 512)
        body.append(Data(head.utf8))
        body.append(bytes)
        body.append(Data(tail.utf8))
        for attempt in 0..<2 {
            if case .failure(let error) = sendAndWait("GET", "/e2ee/limits") {
                // The limits themselves are not needed: only no connection or an ended session stops the upload.
                var stops = true
                if case .refused(_, let status, _, _) = error, status != 401 { stops = false }
                if stops { return .failure(error) }
            }
            guard let request = ChannelTransfer.request(self, "POST", path, contentType: "multipart/form-data; boundary=" + boundary) else { return .failure(unreachable) }
            let sent = ChannelTransfer.shared.send(request, body: body)
            if sent.status == 0 { return .failure(unreachable) }
            let read = Core.read(status: sent.status, body: String(data: sent.data, encoding: .utf8) ?? "")
            if let ok = read["ok"] as? [String: Any], let attachment = ok["attachment"] as? [String: Any] { return .success(attachment) }
            if let refused = read["refused"] as? [String: Any] {
                if sent.status == 401, refused["code"] as? String == "device_proof", attempt == 0 { continue }
                return .failure(.refused(message: refused["message"] as? String ?? "Не удалось выполнить запрос. Попробуй ещё раз.", status: sent.status, code: refused["code"] as? String, details: refused))
            }
            return .failure(.network("Сервер недоступен."))
        }
        return .failure(.network("Не удалось подтвердить устройство. Попробуй ещё раз."))
    }
}

/// The files of channels kept on this device between openings: the app's cache folder, which the system may
/// empty at any time (the reference keeps them in its cache folder the same way).
enum ChannelFiles {
    static let folder: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("channel-files", isDirectory: true)
    }()

    private static func safe(_ text: String) -> String {
        return String(text.map { (character: Character) -> Character in character.isLetter || character.isNumber || character == "-" || character == "_" || character == "." ? character : "_" })
    }

    /// Where the file with this id is kept under this name.
    static func place(id: String, name: String) -> URL {
        var shown = safe(name)
        if shown.isEmpty || shown == "." || shown == ".." { shown = "file" }
        return folder.appendingPathComponent(safe(id), isDirectory: true).appendingPathComponent(shown)
    }

    /// The file, downloaded when it is not here yet. Waits on the calling (background) thread.
    static func bring(_ server: Server, id: String, name: String) -> URL? {
        let file = place(id: id, name: name)
        if FileManager.default.fileExists(atPath: file.path) { return file }
        guard let request = ChannelTransfer.request(server, "GET", Server.filePath(id), contentType: nil) else { return nil }
        return ChannelTransfer.shared.fetch(request, to: file) ? file : nil
    }
}

/// The pictures the section shows — attachments, people, communities. A picture is read from the cache folder
/// (or downloaded into it), decoded OFF the main thread straight at the size it is shown at, and kept in memory
/// under a limit counted in bytes; the system drops them first when memory is short.
final class ChannelImages {
    static let shared = ChannelImages()
    /// Posted on the main queue when a picture has arrived (or failed): `object` is the file's id.
    static let ready = Notification.Name("invizent.channel-image")

    /// The session the pictures are asked as. Main queue.
    var server: Server?
    private let memory = NSCache<NSString, UIImage>()
    private var loading = Set<String>()
    private var failedAt: [String: Date] = [:]
    private let work: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 3
        queue.qualityOfService = .userInitiated
        return queue
    }()

    private init() {
        memory.totalCostLimit = 48 * 1024 * 1024
    }

    /// Main queue only. The picture at `pixels` on its longer side; nil while it is not here — `ready` is
    /// posted when it is.
    func image(id: String, pixels: Int) -> UIImage? {
        guard !id.isEmpty else { return nil }
        #if targetEnvironment(simulator)
        if let sample = samples[id] { return sample }
        #endif
        let key = id + "@" + String(pixels)
        if let hit = memory.object(forKey: key as NSString) { return hit }
        if loading.contains(key) { return nil }
        if let at = failedAt[key], Date().timeIntervalSince(at) < 60 { return nil }
        guard let server else { return nil }
        loading.insert(key)
        work.addOperation { [weak self] in
            var made: UIImage? = nil
            if let file = ChannelFiles.bring(server, id: id, name: "picture") {
                made = ChannelImages.decode(file, pixels: pixels)
                // Not a picture after all: the bytes are not kept.
                if made == nil { try? FileManager.default.removeItem(at: file) }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.loading.remove(key)
                if let made {
                    self.keep(made, key: key)
                    self.failedAt[key] = nil
                } else {
                    self.failedAt[key] = Date()
                }
                NotificationCenter.default.post(name: ChannelImages.ready, object: id)
            }
        }
        return nil
    }

    private func keep(_ image: UIImage, key: String) {
        let cost = (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0)
        memory.setObject(image, forKey: key as NSString, cost: max(1, cost))
    }

    /// The picture of a file, decoded at once at no more than `pixels` on its longer side, upright.
    static func decode(_ file: URL, pixels: Int) -> UIImage? {
        let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithURL(file as CFURL, sourceOptions as CFDictionary) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: max(16, pixels), kCGImageSourceShouldCacheImmediately: true]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    #if targetEnvironment(simulator)
    /// For the simulator's samples: pictures that are simply there, at whatever size they are asked for.
    private var samples: [String: UIImage] = [:]

    func putSample(_ image: UIImage, id: String) {
        samples[id] = image
    }
    #endif
}
