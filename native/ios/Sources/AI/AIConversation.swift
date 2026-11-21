import Foundation

// The AI conversation in memory, the requests it makes, its history in the encrypted vault and the cache of
// made pictures / speech / video. Ported from mobile/src/ai/conversation.ts (class AIConversation), client.ts,
// history.ts (useAIHistory) and mediaCache.ts. Everything here lives on the main queue.

/// The AI requests. Plain ones go through `Server.send` (the core gives the long AI time limits by path);
/// the answers come back on the main queue.
enum AIClient {
    private static func post(_ server: Server, _ path: String, _ body: [String: Any], done: @escaping (Result<Any, AIFailure>) -> Void) {
        guard let text = Core.text(body) else { return done(.failure(AIFailure("Не удалось получить ответ. Попробуй ещё раз."))) }
        server.send("POST", path, body: text) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let value): done(.success(value))
                case .failure(let error): done(.failure(AIFailure(error.words)))
                }
            }
        }
    }

    static func status(_ server: Server, done: @escaping (Result<AIStatus, AIFailure>) -> Void) {
        server.send("GET", "/ai/status") { result in
            DispatchQueue.main.async {
                switch result {
                case .failure(let error): done(.failure(AIFailure(error.words)))
                case .success(let value):
                    do { done(.success(try AIModel.parseStatus(value))) }
                    catch { done(.failure((error as? AIFailure) ?? AIFailure("Не удалось проверить доступность AI."))) }
                }
            }
        }
    }

    static func models(_ server: Server, done: @escaping ([String]) -> Void) {
        server.send("GET", "/ai/models") { result in
            DispatchQueue.main.async {
                if case .success(let value) = result { done(AIModel.parseModels(value)) } else { done([]) }
            }
        }
    }

    static func chat(_ server: Server, messages: [[String: String]], model: String?, done: @escaping (Result<AIReply, AIFailure>) -> Void) {
        var body: [String: Any] = ["messages": messages, "consent": true]
        if let model { body["model"] = model }
        post(server, "/ai/chat", body) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let value):
                do { done(.success(try AIModel.parseReply(value))) }
                catch { done(.failure((error as? AIFailure) ?? AIFailure("Не удалось получить ответ. Попробуй ещё раз."))) }
            }
        }
    }

    private static func media(_ server: Server, _ path: String, _ body: [String: Any], kinds: String, done: @escaping (Result<(mimeType: String, data: Data, routedVia: String?), AIFailure>) -> Void) {
        post(server, path, body) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let value):
                do { done(.success(try AIModel.parseMedia(value, kinds: kinds))) }
                catch { done(.failure((error as? AIFailure) ?? AIFailure("AI-сервис вернул некорректный файл."))) }
            }
        }
    }

    static func image(_ server: Server, prompt: String, done: @escaping (Result<(mimeType: String, data: Data, routedVia: String?), AIFailure>) -> Void) {
        media(server, "/ai/image", ["prompt": prompt, "consent": true], kinds: "^image/(png|jpeg|webp)$", done: done)
    }

    static func speech(_ server: Server, text: String, voice: String, done: @escaping (Result<(mimeType: String, data: Data, routedVia: String?), AIFailure>) -> Void) {
        media(server, "/ai/speech", ["text": text, "voice": voice, "consent": true], kinds: "^audio/[a-z0-9.+-]+$", done: done)
    }

    static func transcribe(_ server: Server, audio: Data, done: @escaping (Result<String, AIFailure>) -> Void) {
        post(server, "/ai/transcribe", ["audio": audio.base64EncodedString(), "consent": true]) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let value):
                let text = (value as? [String: Any])?["text"] as? String ?? ""
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { done(.failure(AIFailure("AI-сервис не вернул текст расшифровки."))) } else { done(.success(text)) }
            }
        }
    }

    /// Video comes back as MP4 bytes, not JSON: it is not in the core's table of operations, so the request is
    /// made here with the session's headers from `Core.prepare` (as Attachments/FileTransfer.swift does). A small
    /// signed-in request goes first: it renews the device proof when one is due.
    static func video(_ server: Server, prompt: String, duration: Int, done: @escaping (Result<Data, AIFailure>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let finish: (Result<Data, AIFailure>) -> Void = { result in DispatchQueue.main.async { done(result) } }
            if case .failure(let error) = server.sendAndWait("GET", "/ai/status") { return finish(.failure(AIFailure(error.words))) }
            let unreachable = AIFailure("Нет связи с сервером. Проверь интернет и адрес подключения.")
            guard server.endpoint.hasPrefix("https://"), let url = URL(string: server.endpoint + "/ai/video"),
                  let made = Core.prepare(method: "POST", path: "/ai/video", jsonBody: true, token: server.token, proof: server.currentProof),
                  let body = Core.text(["prompt": prompt, "duration": duration, "consent": true] as [String: Any]) else { return finish(.failure(unreachable)) }
            var request = URLRequest(url: url, timeoutInterval: made.timeout)
            request.httpMethod = "POST"
            for (name, value) in made.headers { request.setValue(value, forHTTPHeaderField: name) }
            request.setValue("video/mp4", forHTTPHeaderField: "Accept")
            request.httpBody = body.data(using: .utf8)
            let config = URLSessionConfiguration.ephemeral
            config.httpCookieStorage = nil
            config.httpShouldSetCookies = false
            config.urlCache = nil
            config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            let session = URLSession(configuration: config, delegate: AINoRedirect(), delegateQueue: nil)
            session.dataTask(with: request) { data, response, error in
                session.finishTasksAndInvalidate()
                if let failed = error as? URLError, failed.code == .timedOut { return finish(.failure(AIFailure("Сервер не ответил вовремя. Проверь подключение."))) }
                guard error == nil, let http = response as? HTTPURLResponse, let data else { return finish(.failure(unreachable)) }
                guard (200..<300).contains(http.statusCode) else {
                    let read = Core.read(status: http.statusCode, body: String(data: data.prefix(64 * 1024), encoding: .utf8) ?? "")
                    let words = (read["refused"] as? [String: Any])?["message"] as? String
                    return finish(.failure(AIFailure(words ?? "Не удалось выполнить запрос. Попробуй ещё раз.")))
                }
                let type = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
                guard type.hasPrefix("video/mp4"), !data.isEmpty else { return finish(.failure(AIFailure("AI-сервис вернул некорректный файл."))) }
                finish(.success(data))
            }.resume()
        }
    }
}

/// A redirect is never followed (the same rule as `Server`).
private final class AINoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// One conversation. Memory only; the screen owns one.
final class AIConversation {
    struct TaskResult {
        var text: String
        var model: String
        var routedVia: String?
        var media: AIMedia?
    }
    typealias Transport = (_ messages: [[String: String]], _ model: String?, _ done: @escaping (Result<AIReply, AIFailure>) -> Void) -> Void
    typealias Work = (_ stage: @escaping (String) -> Void, _ done: @escaping (Result<TaskResult, AIFailure>) -> Void) -> Void

    private(set) var consent = false
    private(set) var pending = false
    private(set) var turns: [AITurn] = []
    private(set) var error = ""
    var onChange: (() -> Void)?
    /// A file was produced for a turn that is gone (cancelled, consent revoked, screen closed).
    var discardMedia: ((AIMedia) -> Void)?
    /// While on, new turns are marked private and stay out of the stored history.
    var privateTurns = false

    private let transport: Transport
    private var revision = 0
    private var nextId = 0
    private var closed = false
    private var active: (revision: Int, turnId: Int)?
    private var tasks: [Int: Work] = [:]

    init(transport: @escaping Transport) { self.transport = transport }

    private func publish() { onChange?() }

    func setConsent(_ value: Bool) {
        if closed { return }
        if !value { cancel() }
        consent = value
        error = ""
        publish()
    }

    private func canStart() -> Bool {
        if closed || pending { return false }
        if consent { return true }
        error = "Сначала разреши отправлять вопросы внешней AI-службе."
        publish()
        return false
    }

    func ask(_ question: String, model: String?) {
        guard canStart() else { return }
        let messages: [[String: String]]
        do { messages = try AIModel.historyForQuestion(turns, question) }
        catch let failure {
            error = (failure as? AIFailure)?.words ?? "Не удалось получить ответ. Попробуй ещё раз."
            publish()
            return
        }
        nextId += 1
        var turn = AITurn(id: nextId, question: question.trimmingCharacters(in: .whitespacesAndNewlines), status: "pending")
        turn.startedAt = Date()
        turn.model = model
        turn.isPrivate = privateTurns
        turns.append(turn)
        pending = true
        error = ""
        publish()
        run(turn.id, messages, model, nil)
    }

    /// Picture, video, speech or transcription as a turn of the same conversation.
    func askTask(_ question: String, kind: String, work: @escaping Work) {
        guard canStart() else { return }
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            error = "Напиши, что сделать."
            publish()
            return
        }
        nextId += 1
        var turn = AITurn(id: nextId, question: text, status: "pending")
        turn.startedAt = Date()
        turn.kind = kind
        turn.isPrivate = privateTurns
        tasks[turn.id] = work
        turns.append(turn)
        pending = true
        error = ""
        publish()
        run(turn.id, [], nil, work)
    }

    func retry() {
        guard canStart(), let turn = turns.last, turn.status == "failed" || turn.status == "cancelled" else { return }
        // A stored picture request has no work any more: it is asked again by hand.
        if turn.kind != nil && tasks[turn.id] == nil { return }
        let messages: [[String: String]]
        do { messages = try AIModel.historyForQuestion(Array(turns.dropLast()), turn.question) }
        catch let failure {
            error = (failure as? AIFailure)?.words ?? "Не удалось получить ответ. Попробуй ещё раз."
            publish()
            return
        }
        let index = turns.count - 1
        turns[index].status = "pending"
        turns[index].startedAt = Date()
        turns[index].ms = nil
        turns[index].error = nil
        turns[index].stage = nil
        pending = true
        error = ""
        publish()
        run(turn.id, messages, turn.model, turn.kind != nil ? tasks[turn.id] : nil)
    }

    func cancel() {
        guard let running = active else { return }
        active = nil
        revision += 1
        if let index = turns.firstIndex(where: { $0.id == running.turnId }) {
            turns[index].status = "cancelled"
            turns[index].error = nil
        }
        pending = false
        error = ""
        publish()
    }

    /// Reopens a stored conversation. Unfinished turns come back as cancelled.
    func restore(_ stored: [AITurn], consent: Bool) {
        if closed { return }
        cancel()
        nextId = stored.reduce(0) { max($0, $1.id) }
        self.consent = consent
        pending = false
        error = ""
        // The works of the conversation that was open belong to its turns, not to these (which may bear the same numbers).
        tasks = [:]
        turns = AIModel.storedTurns(stored)
        publish()
    }

    /// Forgets media whose cache files are gone, so no broken picture is shown or stored.
    func dropMedia(_ names: [String]) {
        if closed || names.isEmpty { return }
        let gone = Set(names.map { AIModel.mediaName($0) })
        var changed = false
        for index in turns.indices {
            if let media = turns[index].media, gone.contains(AIModel.mediaName(media.uri)) {
                turns[index].media = nil
                changed = true
            }
        }
        if changed { publish() }
    }

    func clear() {
        if closed { return }
        cancel()
        pending = false
        turns = []
        error = ""
        tasks = [:]
        publish()
    }

    func close() {
        if closed { return }
        cancel()
        closed = true
        onChange = nil
    }

    private func run(_ turnId: Int, _ messages: [[String: String]], _ model: String?, _ work: Work?) {
        revision += 1
        let mine = revision
        active = (mine, turnId)
        let current: () -> Bool = { [weak self] in
            guard let self else { return false }
            return !self.closed && self.consent && self.active?.revision == mine
        }
        let finish: (Result<TaskResult, AIFailure>, String) -> Void = { [weak self] result, provider in
            guard let self else { return }
            switch result {
            case .success(let made):
                // The turn is gone while the work went on: nothing shows the file any more.
                guard current() else {
                    if let media = made.media { self.discardMedia?(media) }
                    return
                }
                self.active = nil
                self.pending = false
                self.error = ""
                if let index = self.turns.firstIndex(where: { $0.id == turnId }) {
                    self.turns[index].status = "complete"
                    self.turns[index].answer = AIReply(text: made.text, model: made.model, provider: provider, routedVia: made.routedVia)
                    self.turns[index].error = nil
                    self.turns[index].stage = nil
                    if let media = made.media { self.turns[index].media = media }
                    if let started = self.turns[index].startedAt { self.turns[index].ms = (Date().timeIntervalSince(started) * 1000).rounded() }
                }
                self.publish()
            case .failure(let failure):
                guard current() else { return }
                self.active = nil
                self.pending = false
                self.error = failure.words
                if let index = self.turns.firstIndex(where: { $0.id == turnId }) {
                    self.turns[index].status = "failed"
                    self.turns[index].error = failure.words
                }
                self.publish()
            }
        }
        if let work {
            let stage: (String) -> Void = { [weak self] text in
                guard let self, current(), let index = self.turns.firstIndex(where: { $0.id == turnId }) else { return }
                self.turns[index].stage = text
                self.publish()
            }
            work(stage) { result in finish(result, "freellmapi") }
        } else {
            transport(messages, model) { result in
                switch result {
                case .success(let reply): finish(.success(TaskResult(text: reply.text, model: reply.model, routedVia: reply.routedVia, media: nil)), reply.provider)
                case .failure(let failure): finish(.failure(failure), "")
                }
            }
        }
    }
}

/// The AI chat history: kept only on this device, inside the encrypted vault (entry `ai:v1`, the reference's JSON).
final class AIHistory {
    private(set) var items: [AIStoredConversation] = []
    private(set) var loaded = false
    var onChange: (() -> Void)?
    private let crypto: CryptoService?

    init(crypto: CryptoService?) { self.crypto = crypto }

    func load() {
        guard let crypto else {
            loaded = true
            onChange?()
            return
        }
        crypto.call("loadLocal", ["ai:v1"]) { [weak self] result in
            guard let self else { return }
            if case .success(let value) = result { self.items = AIModel.parseHistory(value as? String) }
            self.loaded = true
            self.onChange?()
        }
    }

    private func persist(_ next: [AIStoredConversation]) {
        items = next
        onChange?()
        // The vault's own queue keeps the writes in order.
        crypto?.call("storeLocal", ["ai:v1", AIModel.historyJSON(next)]) { _ in }
    }

    func save(id: String, turns: [AITurn], consent: Bool) {
        guard loaded else { return }
        let stored = AIModel.storedTurns(turns)
        if let existing = items.first(where: { $0.id == id }), existing.consent == consent, existing.turns == Array(stored.suffix(AILimits.storedTurns)) { return }
        persist(AIModel.upsert(items, id: id, turns: turns, consent: consent, now: AIModel.nowISO()))
    }

    func remove(_ id: String) { persist(items.filter { $0.id != id }) }

    #if targetEnvironment(simulator)
    func simulatorSet(_ list: [AIStoredConversation]) {
        items = list
        loaded = true
    }
    #endif
}

/// Pictures, video and speech made by the AI: files of the app's cache folder under the `linea-ai-` prefix,
/// identified by name only (the folder's path changes between app updates).
enum AIMediaCache {
    static let limitBytes = 150 * 1024 * 1024
    private static let extensions = ["image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "audio/mp4": "m4a", "audio/webm": "webm", "video/mp4": "mp4"]

    private static var folder: URL? { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first }

    /// Where the file is right now.
    static func url(_ uri: String) -> URL? {
        guard AIModel.isMediaUri(uri), let folder else { return nil }
        return folder.appendingPathComponent(AIModel.mediaName(uri))
    }

    static func names(_ turns: [AITurn]) -> [String] {
        turns.compactMap { turn -> String? in
            guard let media = turn.media, AIModel.isMediaUri(media.uri) else { return nil }
            return AIModel.mediaName(media.uri)
        }
    }

    /// Writes AI output to the cache and gives the file's name.
    static func write(conversationId: String, data: Data, mimeType: String) throws -> String {
        guard let folder else { throw AIFailure("Кэш недоступен на этом устройстве.") }
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-")
        let owner = String(String(conversationId.map { allowed.contains($0) ? $0 : "_" }).prefix(64))
        let name = AIModel.mediaPrefix + owner + "-" + UUID().uuidString.lowercased() + "." + (extensions[mimeType] ?? "bin")
        do { try data.write(to: folder.appendingPathComponent(name), options: [.atomic]) }
        catch { throw AIFailure("Кэш недоступен на этом устройстве.") }
        return name
    }

    static func delete(_ uris: [String]) {
        for uri in uris {
            if let file = url(uri) { try? FileManager.default.removeItem(at: file) }
        }
    }

    /// Media of a reopened conversation whose files are no longer on disk.
    static func missing(_ turns: [AITurn]) -> [String] {
        names(turns).filter { name in
            guard let file = url(name) else { return true }
            return !FileManager.default.fileExists(atPath: file.path)
        }
    }

    /// Removes orphans (older than two minutes) and keeps the cache under the limit: the oldest files of other
    /// conversations go first, never those of the conversation on screen (`protect`).
    static func prune(keep: [String], protect: [String]) {
        guard let folder, let found = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey], options: []) else { return }
        let kept = Set(keep.map { AIModel.mediaName($0) }).union(protect.map { AIModel.mediaName($0) })
        let safe = Set(protect.map { AIModel.mediaName($0) })
        let now = Date()
        var held: [(url: URL, size: Int, at: Date)] = []
        for file in found where file.lastPathComponent.hasPrefix(AIModel.mediaPrefix) {
            let values = try? file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            let at = values?.contentModificationDate ?? now
            if kept.contains(file.lastPathComponent) { held.append((file, values?.fileSize ?? 0, at)) }
            else if now.timeIntervalSince(at) >= 120 { try? FileManager.default.removeItem(at: file) }
        }
        var total = held.reduce(0) { $0 + $1.size }
        for file in held.sorted(by: { $0.at < $1.at }) {
            if total <= limitBytes { break }
            if safe.contains(file.url.lastPathComponent) { continue }
            try? FileManager.default.removeItem(at: file.url)
            total -= file.size
        }
    }
}
