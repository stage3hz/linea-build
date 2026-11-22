import Foundation

// The music catalogues, ported from mobile/src/music/types.ts, catalog.ts, api.ts and soundcloud.ts.
// Audius is asked directly and anonymously (no session, no token, no cookies, no cache, no redirects — as in
// the reference); SoundCloud goes through the person's server. A track is shown only when the catalogue says,
// in a fresh answer, that anyone may listen to it: unknown access flags fail closed.

struct MusicTrack: Equatable {
    var id: String
    /// audius · soundcloud · local
    var source: String
    var sourceId: String?
    var title: String
    var artist: String
    var artworkUrl: String?
    var duration: Double
    var genre: String?
    var mood: String?
    var sourceUrl: String?
    var downloadable: Bool
    var fileName: String?
    var mimeType: String?
    var fileSize: Int?
    var savedAt: String?

    var json: [String: Any] {
        var out: [String: Any] = ["id": id, "source": source, "title": title, "artist": artist, "artworkUrl": artworkUrl ?? NSNull(), "duration": duration, "downloadable": downloadable]
        if let sourceId { out["sourceId"] = sourceId }
        if let genre { out["genre"] = genre }
        if let mood { out["mood"] = mood }
        if let sourceUrl { out["sourceUrl"] = sourceUrl }
        if let fileName { out["fileName"] = fileName }
        if let mimeType { out["mimeType"] = mimeType }
        if let fileSize { out["fileSize"] = fileSize }
        if let savedAt { out["savedAt"] = savedAt }
        return out
    }
}

struct MusicFailure: Error {
    let words: String
    var retryable = false
    init(_ words: String, retryable: Bool = false) {
        self.words = words
        self.retryable = retryable
    }
}

struct MusicPage {
    var tracks: [MusicTrack]
    var nextOffset: Int?
}

struct MusicMood {
    let id: String
    let label: String
    let symbol: String
    let apiMood: String?
}

enum MusicCatalog {
    static let moods: [MusicMood] = [
        MusicMood(id: "all", label: "Всё", symbol: "musical-notes-outline", apiMood: nil),
        MusicMood(id: "calm", label: "Спокойно", symbol: "water-outline", apiMood: "Peaceful"),
        MusicMood(id: "energy", label: "Энергия", symbol: "flash-outline", apiMood: "Energizing"),
        MusicMood(id: "focus", label: "Фокус", symbol: "headset-outline", apiMood: "Cool"),
        MusicMood(id: "upbeat", label: "Настроение", symbol: "sunny-outline", apiMood: "Upbeat"),
        MusicMood(id: "romantic", label: "Романтика", symbol: "heart-outline", apiMood: "Romantic"),
        MusicMood(id: "melancholy", label: "Меланхолия", symbol: "moon-outline", apiMood: "Melancholy"),
    ]

    private static let origin = "https://api.audius.co"
    private static let maxResponse = 4 * 1024 * 1024

    static func matches(_ pattern: String, _ text: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return false }
        return regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }

    static func time(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let value = Int(seconds)
        return "\(value / 60):" + String(format: "%02d", value % 60)
    }

    // MARK: Validation (catalog.ts)

    static func audiusId(_ value: Any?) -> String? {
        guard let text = value as? String, matches("^[A-Za-z0-9]{1,64}$", text) else { return nil }
        return text
    }

    /// Validates transport only: https, a public host name, the default port, no credentials, no fragment.
    static func safeHttpsUrl(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty, text.utf16.count <= 16384 else { return nil }
        for unit in text.unicodeScalars where unit.value <= 0x20 || unit.value == 0x7F || unit == "\\" { return nil }
        guard let parts = URLComponents(string: text), parts.scheme?.lowercased() == "https", parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.port == nil || parts.port == 443, let host = parts.host?.lowercased(), URL(string: text) != nil else { return nil }
        if !host.contains(".") || host.contains(":") || host.hasSuffix(".") || matches("^[\\d.]+$", host) { return nil }
        if matches("(?:^|\\.)(?:localhost|local|localdomain|internal|lan|home|invalid|test|onion)$", host) { return nil }
        for label in host.components(separatedBy: ".") where !matches("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", label) { return nil }
        return text
    }

    private static func emptyObject(_ value: Any?) -> Bool {
        if value == nil || value is NSNull { return true }
        if let object = value as? [String: Any] { return object.isEmpty }
        return false
    }

    private static func isTrue(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return number.boolValue
    }

    private static func isFalse(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return !number.boolValue
    }

    private static func mediaUrl(_ track: [String: Any], _ kind: String) -> String? {
        safeHttpsUrl((track[kind] as? [String: Any])?["url"])
    }

    /// The search flags are hints, never permission. Unknown access flags fail closed.
    static func canStream(_ value: Any?) -> Bool {
        guard let track = value as? [String: Any] else { return false }
        let access = track["access"] as? [String: Any]
        let keys = track["allowed_api_keys"]
        let authorities = track["access_authorities"]
        let publicAuthorities = authorities == nil || authorities is NSNull || ((authorities as? [Any])?.isEmpty == true)
        return audiusId(track["id"]) != nil && isTrue(track["is_available"]) && isTrue(track["is_streamable"]) && isFalse(track["is_delete"])
            && isFalse(track["is_unlisted"]) && isFalse(track["is_stream_gated"]) && isTrue(access?["stream"])
            // A present allowlist, including [], is not permission for an anonymous app.
            && (keys == nil || keys is NSNull) && publicAuthorities && emptyObject(track["stream_conditions"]) && mediaUrl(track, "stream") != nil
    }

    /// Artist-enabled public download; this is not an offline-storage licence.
    static func canDownload(_ value: Any?) -> Bool {
        guard canStream(value), let track = value as? [String: Any] else { return false }
        let access = track["access"] as? [String: Any]
        let flag = track["is_downloadable"] != nil ? track["is_downloadable"] : track["downloadable"]
        return isTrue(flag) && isFalse(track["is_download_gated"]) && isTrue(access?["download"]) && emptyObject(track["download_conditions"]) && mediaUrl(track, "download") != nil
    }

    private static func clean(_ value: Any?, _ limit: Int) -> String? {
        guard let text = value as? String else { return nil }
        let kept = String(String.UnicodeScalarView(text.unicodeScalars.filter { $0.value > 0x1F && $0.value != 0x7F })).trimmingCharacters(in: .whitespacesAndNewlines)
        let cut = String(kept.prefix(limit))
        return cut.isEmpty ? nil : cut
    }

    /// The track's page on audius.co: `/artist/track`, nothing else.
    private static func pageUrl(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty, !text.hasPrefix("//") else { return nil }
        guard let url = URL(string: text, relativeTo: URL(string: "https://audius.co")), let parts = URLComponents(url: url, resolvingAgainstBaseURL: true),
              parts.scheme == "https", parts.host == "audius.co", parts.port == nil, parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              matches("^/[^/]+/[^/]+/?$", parts.percentEncodedPath) else { return nil }
        return safeHttpsUrl(url.absoluteString)
    }

    static func normalize(_ value: Any?) -> MusicTrack? {
        guard canStream(value), let raw = value as? [String: Any], let id = audiusId(raw["id"]) else { return nil }
        let user = raw["user"] as? [String: Any]
        // Every displayed release keeps its artist credit and official source link.
        guard let title = clean(raw["title"], 240), let artist = clean(user?["name"], 160) ?? clean(user?["handle"], 160), let link = pageUrl(raw["permalink"]) else { return nil }
        let artwork = raw["artwork"] as? [String: Any]
        var duration = 0.0
        if let number = raw["duration"] as? NSNumber, number.doubleValue.isFinite, number.doubleValue >= 0 { duration = number.doubleValue.rounded() }
        return MusicTrack(id: "audius:" + id, source: "audius", sourceId: id, title: title, artist: artist,
                          artworkUrl: safeHttpsUrl(artwork?["480x480"]) ?? safeHttpsUrl(artwork?["150x150"]) ?? safeHttpsUrl(artwork?["1000x1000"]),
                          duration: duration, genre: clean(raw["genre"], 80), mood: clean(raw["mood"], 80), sourceUrl: link, downloadable: canDownload(raw))
    }

    private static func page(_ raw: Any?, offset: Int, limit: Int) throws -> MusicPage {
        guard let list = raw as? [Any] else { throw MusicFailure("Сервис музыки вернул неверный ответ. Попробуйте позже.") }
        var seen = Set<String>()
        var tracks: [MusicTrack] = []
        for item in list {
            guard let track = normalize(item), !seen.contains(track.id) else { continue }
            seen.insert(track.id)
            tracks.append(track)
        }
        // A full page of unavailable records must not end the pages early.
        return MusicPage(tracks: tracks, nextOffset: list.count >= limit ? offset + list.count : nil)
    }

    // MARK: Audius requests (api.ts)

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.timeoutIntervalForRequest = 12
        return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }()

    /// No session of the messenger, no user token, no cache, no other host. The answer comes on the main queue.
    private static func requestJson(_ path: String, attempt: Int = 0, done: @escaping (Result<[String: Any], MusicFailure>) -> Void) {
        guard let url = URL(string: origin + "/v1" + path) else { return done(.failure(MusicFailure("Не удалось подключиться к Audius."))) }
        var request = URLRequest(url: url, timeoutInterval: 12)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        session.dataTask(with: request) { data, response, error in
            var result: Result<[String: Any], MusicFailure>
            if let http = response as? HTTPURLResponse, error == nil {
                let body = data ?? Data()
                if http.statusCode == 429 { result = .failure(MusicFailure("Audius временно ограничил запросы. Подождите немного и попробуйте снова.")) }
                else if http.statusCode == 401 || http.statusCode == 403 { result = .failure(MusicFailure("Эта музыка сейчас недоступна через Audius.")) }
                else if http.statusCode == 404 { result = .failure(MusicFailure("Трек больше недоступен в Audius.")) }
                else if !(200..<300).contains(http.statusCode) { result = .failure(MusicFailure("Сервис музыки временно недоступен. Попробуйте позже.", retryable: http.statusCode >= 500)) }
                else if body.count > maxResponse { result = .failure(MusicFailure("Сервис музыки вернул слишком большой ответ.")) }
                else if let object = (try? JSONSerialization.jsonObject(with: body, options: [])) as? [String: Any] { result = .success(object) }
                else { result = .failure(MusicFailure("Не удалось прочитать ответ Audius. Попробуйте позже.")) }
            } else {
                let timedOut = (error as? URLError)?.code == .timedOut
                result = .failure(MusicFailure(timedOut ? "Audius не ответил вовремя. Попробуйте ещё раз." : "Не удалось подключиться к Audius. Проверьте интернет.", retryable: true))
            }
            if case .failure(let failure) = result, failure.retryable, attempt == 0 {
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { requestJson(path, attempt: 1, done: done) }
                return
            }
            DispatchQueue.main.async { done(result) }
        }.resume()
    }

    private static func query(_ items: [(String, String)]) -> String {
        var parts = URLComponents()
        parts.queryItems = items.map { URLQueryItem(name: $0.0, value: $0.1) }
        return parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B") ?? ""
    }

    /// The week's popular tracks, or a search by words and mood.
    static func searchAudius(query text: String, mood: String?, offset: Int, limit: Int, done: @escaping (Result<MusicPage, MusicFailure>) -> Void) {
        let wanted = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(160))
        let apiMood = moods.first { $0.id == mood }?.apiMood ?? moods.first { $0.apiMood != nil && $0.apiMood == mood }?.apiMood
        var items: [(String, String)] = [("offset", String(offset)), ("limit", String(limit))]
        var path = "/tracks/trending"
        if !wanted.isEmpty || apiMood != nil {
            if !wanted.isEmpty { items.append(("query", wanted)) }
            if let apiMood { items.append(("mood", apiMood)) }
            items.append(("sort_method", wanted.isEmpty ? "popular" : "relevant"))
            items.append(("includePurchaseable", "false"))
            path = "/tracks/search"
        } else {
            items.append(("time", "week"))
        }
        requestJson(path + "?" + query(items)) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let body):
                do { done(.success(try page(body["data"], offset: offset, limit: limit))) }
                catch { done(.failure((error as? MusicFailure) ?? MusicFailure("Не удалось найти музыку."))) }
            }
        }
    }

    private static func fresh(_ sourceId: String?, done: @escaping (Result<[String: Any], MusicFailure>) -> Void) {
        guard let id = audiusId(sourceId) else { return done(.failure(MusicFailure("Не удалось определить трек Audius."))) }
        requestJson("/tracks/" + id) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let body):
                guard let raw = body["data"] as? [String: Any], (raw["id"] as? String) == id else { return done(.failure(MusicFailure("Audius вернул неверные данные трека."))) }
                done(.success(raw))
            }
        }
    }

    /// Restores an Audius favourite from its id (only ids are kept on disk).
    static func audiusTrack(_ sourceId: String, done: @escaping (Result<MusicTrack, MusicFailure>) -> Void) {
        fresh(sourceId) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let raw):
                if let track = normalize(raw) { done(.success(track)) } else { done(.failure(MusicFailure("Этот трек сейчас недоступен для свободного прослушивания."))) }
            }
        }
    }

    /// Where to play the track from: asked from the official endpoint after a fresh permission check.
    static func resolveStream(_ track: MusicTrack, server: Server?, done: @escaping (Result<String, MusicFailure>) -> Void) {
        if track.source == "soundcloud" { return soundCloudStream(track, server: server, done: done) }
        guard track.source == "audius", let id = audiusId(track.sourceId) else { return done(.failure(MusicFailure("Этот источник музыки не поддерживается."))) }
        fresh(id) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let raw):
                guard canStream(raw) else { return done(.failure(MusicFailure("Автор ограничил доступ к треку, или он больше недоступен."))) }
                requestJson("/tracks/" + id + "/stream?no_redirect=true") { answer in
                    switch answer {
                    case .failure(let failure): done(.failure(failure))
                    case .success(let body):
                        if let uri = safeHttpsUrl(body["data"]) { done(.success(uri)) } else { done(.failure(MusicFailure("Audius не предоставил доступный адрес воспроизведения."))) }
                    }
                }
            }
        }
    }

    /// The official download address, when the author allows it. Opened outside the app: never kept here.
    static func resolveDownload(_ track: MusicTrack, done: @escaping (Result<String, MusicFailure>) -> Void) {
        guard track.source == "audius", let id = audiusId(track.sourceId) else { return done(.failure(MusicFailure("Этот источник музыки не поддерживается."))) }
        fresh(id) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let raw):
                guard canDownload(raw) else { return done(.failure(MusicFailure("Автор не разрешил публичное скачивание этого трека. Его можно открыть в Audius."))) }
                done(.success(origin + "/v1/tracks/" + id + "/download"))
            }
        }
    }

    // MARK: SoundCloud through the person's server (soundcloud.ts)

    static func isSoundCloudUrn(_ value: Any?) -> Bool {
        guard let text = value as? String else { return false }
        return matches("^soundcloud:tracks:\\d{1,20}$", text)
    }

    private static func encoded(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? ""
    }

    private static func ask(_ server: Server?, _ path: String, done: @escaping (Result<[String: Any], MusicFailure>) -> Void) {
        guard let server, server.token != nil else { return done(.failure(MusicFailure("SoundCloud доступен после входа в аккаунт."))) }
        server.send("GET", path) { result in
            DispatchQueue.main.async {
                switch result {
                case .failure(let error): done(.failure(MusicFailure(error.words)))
                case .success(let value): done(.success(value as? [String: Any] ?? [:]))
                }
            }
        }
    }

    static func soundCloudAvailable(_ server: Server?, done: @escaping (Bool) -> Void) {
        guard server?.token != nil else { return done(false) }
        ask(server, "/music/soundcloud/status") { result in
            if case .success(let body) = result { done((body["available"] as? Bool) == true) } else { done(false) }
        }
    }

    private static func soundCloudTrack(_ value: Any?) -> MusicTrack? {
        guard let raw = value as? [String: Any], (raw["source"] as? String) == "soundcloud", let urn = raw["sourceId"] as? String, isSoundCloudUrn(urn),
              let title = raw["title"] as? String, let artist = raw["artist"] as? String else { return nil }
        func https(_ input: Any?) -> String? {
            guard let text = input as? String, let url = URL(string: text), url.scheme?.lowercased() == "https" else { return nil }
            return text
        }
        var genre: String?
        if let text = raw["genre"] as? String { genre = String(text.prefix(60)) }
        return MusicTrack(id: "sc:" + urn, source: "soundcloud", sourceId: urn, title: String(title.prefix(200)), artist: String(artist.prefix(120)), artworkUrl: https(raw["artworkUrl"]),
                          duration: max(0, (raw["duration"] as? NSNumber)?.doubleValue ?? 0), genre: genre, mood: nil, sourceUrl: https(raw["sourceUrl"]), downloadable: false)
    }

    static func searchSoundCloud(_ server: Server?, query text: String, mood: String?, offset: Int, limit: Int, done: @escaping (Result<MusicPage, MusicFailure>) -> Void) {
        var items: [(String, String)] = [("offset", String(offset)), ("limit", String(limit))]
        let wanted = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(160))
        if !wanted.isEmpty { items.append(("q", wanted)) }
        if let mood, !mood.isEmpty { items.append(("mood", mood)) }
        ask(server, "/music/soundcloud/tracks?" + query(items)) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let body):
                let tracks = (body["tracks"] as? [Any] ?? []).compactMap { soundCloudTrack($0) }
                done(.success(MusicPage(tracks: tracks, nextOffset: (body["nextOffset"] as? NSNumber)?.intValue)))
            }
        }
    }

    static func soundCloudTrack(_ server: Server?, urn: String, done: @escaping (Result<MusicTrack, MusicFailure>) -> Void) {
        guard isSoundCloudUrn(urn) else { return done(.failure(MusicFailure("Некорректный трек SoundCloud."))) }
        ask(server, "/music/soundcloud/tracks/" + encoded(urn)) { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let body):
                if let track = soundCloudTrack(body["track"]) { done(.success(track)) } else { done(.failure(MusicFailure("Этот трек больше недоступен в SoundCloud."))) }
            }
        }
    }

    private static func soundCloudStream(_ track: MusicTrack, server: Server?, done: @escaping (Result<String, MusicFailure>) -> Void) {
        guard let urn = track.sourceId, isSoundCloudUrn(urn) else { return done(.failure(MusicFailure("Некорректный трек SoundCloud."))) }
        ask(server, "/music/soundcloud/tracks/" + encoded(urn) + "/stream") { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let body):
                if let uri = body["uri"] as? String, uri.hasPrefix("https://") { done(.success(uri)) } else { done(.failure(MusicFailure("SoundCloud не дал адрес для воспроизведения."))) }
            }
        }
    }
}
