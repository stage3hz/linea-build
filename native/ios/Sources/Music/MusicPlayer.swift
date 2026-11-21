import UIKit
import AVFoundation
import MediaPlayer

/// The one music player of the app: the queue, what plays, the favourites and the person's own files.
/// Ported from mobile/src/music/MusicProvider.tsx. Plays in the background (the audio session's `.playback`
/// category, `UIBackgroundModes: audio`) and is driven from the lock screen as well.
/// Everything here lives on the main queue; `changed` is posted whenever something a screen shows has changed.
final class MusicPlayer: NSObject {
    static let shared = MusicPlayer()
    static let changed = Notification.Name("invizent.music.changed")
    private static let libraryKey = "linea.music.device-library.v1"
    private static let maxTracks = 500
    private static let maxFileSize = 250 * 1024 * 1024
    private static let audioExtensions: Set<String> = ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "aiff", "aif", "caf", "webm", "mp4"]
    private static let extensionMimes = ["mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg", "opus": "audio/opus", "webm": "audio/webm", "aiff": "audio/aiff", "aif": "audio/aiff", "caf": "audio/x-caf"]

    /// The signed-in session: SoundCloud is asked through the person's server.
    var server: Server? {
        didSet { if server !== oldValue { restoreSoundCloud() } }
    }

    private(set) var current: MusicTrack?
    private(set) var queue: [MusicTrack] = []
    private(set) var favorites: [MusicTrack] = []
    private(set) var saved: [MusicTrack] = []
    /// off · all · one
    private(set) var repeatMode = "off"
    private(set) var shuffle = false
    private(set) var notice = ""
    private var playbackError = ""
    private var operationError = ""
    private var resolving = false
    private var sourceReady = false
    private var generation = 0
    private var finished = false
    private var names: [String: String] = [:]
    private var audiusIds: [String] = []
    private var scIds: [String] = []
    private var visited = Set<String>()
    private var trail: [String] = []
    private var startTimer: Timer?
    private let engine = AVPlayer()
    private var watchers: [NSKeyValueObservation] = []
    private var itemWatch: NSKeyValueObservation?
    private var commandsReady = false
    #if targetEnvironment(simulator)
    /// The simulator's sample state: shown as playing without any sound.
    var demo = false
    var demoPosition = 0.0
    #endif

    private override init() {
        super.init()
        engine.automaticallyWaitsToMinimizeStalling = true
        _ = engine.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.4, preferredTimescale: 600), queue: .main) { [weak self] _ in self?.tell(info: false) }
        watchers.append(engine.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.tell(info: true) } })
        NotificationCenter.default.addObserver(self, selector: #selector(ended(_:)), name: .AVPlayerItemDidPlayToEndTime, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(broke(_:)), name: .AVPlayerItemFailedToPlayToEndTime, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(coverReady(_:)), name: MusicCovers.ready, object: nil)
        loadLibrary()
    }

    // MARK: What the screens read

    var playing: Bool {
        #if targetEnvironment(simulator)
        if demo { return current != nil }
        #endif
        return current != nil && sourceReady && engine.timeControlStatus != .paused
    }

    var loading: Bool {
        if resolving { return true }
        guard current != nil, sourceReady, playbackError.isEmpty else { return false }
        return engine.currentItem?.status != .readyToPlay || engine.timeControlStatus == .waitingToPlayAtSpecifiedRate
    }

    var position: Double {
        #if targetEnvironment(simulator)
        if demo { return demoPosition }
        #endif
        guard current != nil, sourceReady else { return 0 }
        let seconds = engine.currentTime().seconds
        return seconds.isFinite && seconds >= 0 ? seconds : 0
    }

    var duration: Double {
        guard let current else { return 0 }
        if sourceReady, let seconds = engine.currentItem?.duration.seconds, seconds.isFinite, seconds > 0 { return seconds }
        return current.duration
    }

    var error: String { operationError.isEmpty ? playbackError : operationError }

    func isFavorite(_ track: MusicTrack) -> Bool { favorites.contains { $0.id == track.id } }

    func clearError() {
        operationError = ""
        playbackError = ""
        tell(info: false)
    }

    func clearNotice() {
        notice = ""
        tell(info: false)
    }

    private func tell(info: Bool) {
        if info { updateNowPlaying() }
        NotificationCenter.default.post(name: MusicPlayer.changed, object: nil)
    }

    private static func unique(_ tracks: [MusicTrack]) -> [MusicTrack] {
        var seen = Set<String>()
        var out: [MusicTrack] = []
        for track in tracks where !seen.contains(track.id) {
            seen.insert(track.id)
            out.append(track)
        }
        return Array(out.prefix(maxTracks))
    }

    // MARK: Playing

    private func prepareSession() throws {
        // Rooms (Sources/Rooms): inside a room the phone's sound is the room's own (the microphone is open) —
        // the music plays through it and must not take it over.
        if RoomVoice.shared.state != nil { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true)
    }

    private func silence() {
        startTimer?.invalidate()
        startTimer = nil
        engine.pause()
        itemWatch = nil
        engine.replaceCurrentItem(with: nil)
    }

    func play(_ track: MusicTrack, queue items: [MusicTrack]? = nil) {
        #if targetEnvironment(simulator)
        if demo {
            current = track
            if let items, !items.isEmpty { queue = items }
            return tell(info: false)
        }
        #endif
        generation += 1
        let mine = generation
        playbackError = ""
        operationError = ""
        resolving = true
        sourceReady = false
        finished = false
        silence()
        let prior = current
        // One service per queue: SoundCloud's tracks never share a queue with another service's.
        var base: [MusicTrack] = [track]
        if let items, !items.isEmpty { base = items } else if queue.contains(where: { $0.id == track.id }) { base = queue }
        var nextQueue = MusicPlayer.unique(base.filter { $0.source == track.source })
        if !nextQueue.contains(where: { $0.id == track.id }) { nextQueue.insert(track, at: 0) }
        if nextQueue.map({ $0.id }) != queue.map({ $0.id }) {
            trail = []
            visited = []
        }
        if let prior, prior.id != track.id { trail = Array((trail + [prior.id]).suffix(100)) }
        visited.insert(track.id)
        current = track
        queue = nextQueue
        tell(info: false)
        do { try prepareSession() }
        catch { return fail(mine, "Не удалось включить трек. Проверь соединение и попробуй ещё раз.") }
        if let owned = saved.first(where: { $0.id == track.id }) {
            guard let file = fileURL(owned), FileManager.default.fileExists(atPath: file.path) else { return fail(mine, "Файл больше не доступен на устройстве. Импортируй его ещё раз.") }
            current = owned
            return start(mine, file)
        }
        if track.source == "local" { return fail(mine, "Файл не найден. Импортируй его с устройства ещё раз.") }
        MusicCatalog.resolveStream(track, server: server) { [weak self] result in
            guard let self, mine == self.generation else { return }
            switch result {
            case .failure(let failure): self.fail(mine, failure.words)
            case .success(let address):
                guard let url = URL(string: address), url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else { return self.fail(mine, "Источник музыки вернул неподходящий адрес.") }
                self.start(mine, url)
            }
        }
    }

    private func fail(_ mine: Int, _ words: String) {
        guard mine == generation else { return }
        startTimer?.invalidate()
        resolving = false
        sourceReady = false
        playbackError = words
        engine.pause()
        tell(info: true)
    }

    private func start(_ mine: Int, _ url: URL) {
        guard mine == generation else { return }
        let item = AVPlayerItem(url: url)
        itemWatch = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self, mine == self.generation else { return }
                if item.status == .readyToPlay { self.startTimer?.invalidate() }
                if item.status == .failed, self.sourceReady { self.fail(mine, "Не удалось воспроизвести трек. Попробуй другой источник.") } else { self.tell(info: true) }
            }
        }
        engine.replaceCurrentItem(with: item)
        sourceReady = true
        resolving = false
        setCommands()
        startTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self, mine == self.generation, self.engine.currentItem?.status != .readyToPlay else { return }
            self.fail(mine, "Трек загружается слишком долго. Проверь соединение и попробуй ещё раз.")
        }
        engine.play()
        tell(info: true)
    }

    func togglePlayback() {
        #if targetEnvironment(simulator)
        if demo { return }
        #endif
        guard let current else { return }
        if !sourceReady { return play(current, queue: queue) }
        playbackError = ""
        if engine.timeControlStatus != .paused { engine.pause() } else {
            if finished {
                finished = false
                engine.seek(to: .zero)
            }
            try? prepareSession()
            engine.play()
        }
        tell(info: true)
    }

    func seek(_ seconds: Double) {
        guard sourceReady, seconds.isFinite else { return }
        let limit = duration > 0 ? duration : max(0, seconds)
        finished = false
        engine.seek(to: CMTime(seconds: min(max(0, seconds), limit), preferredTimescale: 600)) { [weak self] _ in
            DispatchQueue.main.async { self?.tell(info: true) }
        }
    }

    func next() {
        guard let selected = current, !queue.isEmpty else { return }
        let index = queue.firstIndex { $0.id == selected.id } ?? -1
        var target: MusicTrack?
        if shuffle && queue.count > 1 {
            var others = queue.filter { !visited.contains($0.id) }
            if others.isEmpty && repeatMode == "all" {
                visited = [selected.id]
                others = queue.filter { $0.id != selected.id }
            }
            target = others.randomElement()
        } else if index + 1 < queue.count {
            target = queue[index + 1]
        } else if repeatMode == "all" {
            target = queue.first
        }
        if let target { return play(target, queue: queue) }
        engine.pause()
        notice = "Очередь закончилась. Выбери следующий трек."
        tell(info: true)
    }

    func previous() {
        guard let selected = current else { return }
        if position > 3 { return seek(0) }
        let index = queue.firstIndex { $0.id == selected.id } ?? -1
        var target: MusicTrack?
        if shuffle, let last = trail.popLast() { target = queue.first { $0.id == last } }
        if target == nil, index > 0 { target = queue[index - 1] }
        if target == nil, repeatMode == "all" { target = queue.last }
        guard let target else { return seek(0) }
        play(target, queue: queue)
        if shuffle, !trail.isEmpty { trail.removeLast() }
    }

    func toggleRepeat() {
        repeatMode = repeatMode == "off" ? "all" : (repeatMode == "all" ? "one" : "off")
        tell(info: false)
    }

    func toggleShuffle() {
        shuffle.toggle()
        trail = []
        visited = []
        if let current { visited.insert(current.id) }
        tell(info: false)
    }

    func stop() {
        generation += 1
        sourceReady = false
        silence()
        current = nil
        queue = []
        trail = []
        visited = []
        resolving = false
        playbackError = ""
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        tell(info: false)
    }

    @objc private func ended(_ note: Notification) {
        guard let item = note.object as? AVPlayerItem, item === engine.currentItem, sourceReady else { return }
        if repeatMode == "one" {
            engine.seek(to: .zero)
            engine.play()
            return
        }
        finished = true
        next()
    }

    @objc private func broke(_ note: Notification) {
        guard let item = note.object as? AVPlayerItem, item === engine.currentItem, sourceReady else { return }
        fail(generation, "Не удалось воспроизвести трек. Попробуй другой источник.")
    }

    @objc private func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let kind = AVAudioSession.InterruptionType(rawValue: raw), kind == .ended, current != nil, sourceReady else { return tell(info: true) }
        let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
        if options.contains(.shouldResume) { engine.play() }
        tell(info: true)
    }

    @objc private func coverReady(_ note: Notification) {
        if let id = note.object as? String, id == current?.id { updateNowPlaying() }
    }

    // MARK: The lock screen

    private func setCommands() {
        if commandsReady { return }
        commandsReady = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            guard let self, self.current != nil else { return .noActionableNowPlayingItem }
            if self.engine.timeControlStatus == .paused { self.togglePlayback() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self, self.current != nil else { return .noActionableNowPlayingItem }
            if self.engine.timeControlStatus != .paused { self.togglePlayback() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self, self.current != nil else { return .noActionableNowPlayingItem }
            self.togglePlayback()
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self, self.current != nil else { return .noActionableNowPlayingItem }
            self.next()
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self, self.current != nil else { return .noActionableNowPlayingItem }
            self.previous()
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self, let event = event as? MPChangePlaybackPositionCommandEvent, self.current != nil else { return .commandFailed }
            self.seek(event.positionTime)
            return .success
        }
    }

    private func updateNowPlaying() {
        guard let current, sourceReady else { return }
        var info: [String: Any] = [MPMediaItemPropertyTitle: current.title, MPMediaItemPropertyArtist: current.artist]
        info[MPMediaItemPropertyPlaybackDuration] = duration
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        info[MPNowPlayingInfoPropertyPlaybackRate] = engine.timeControlStatus == .playing ? 1.0 : 0.0
        if let cover = MusicCovers.image(current) {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: cover.size) { _ in cover }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    // MARK: The library on this device

    private static var folder: URL? {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        return documents.appendingPathComponent("linea-music", isDirectory: true)
    }

    /// The person's own file behind a saved track.
    func fileURL(_ track: MusicTrack) -> URL? {
        guard let name = names[track.id], MusicCatalog.matches("^[A-Fa-f0-9-]{36}\\.[A-Za-z0-9]{2,5}$", name), let folder = MusicPlayer.folder else { return nil }
        return folder.appendingPathComponent(name)
    }

    private static func track(_ value: Any?) -> MusicTrack? {
        guard let raw = value as? [String: Any], let id = raw["id"] as? String, !id.isEmpty, id.utf16.count <= 180, let source = raw["source"] as? String, ["audius", "soundcloud", "local"].contains(source),
              let title = raw["title"] as? String, let artist = raw["artist"] as? String else { return nil }
        var out = MusicTrack(id: id, source: source, sourceId: nil, title: String(title.prefix(300)), artist: String(artist.prefix(250)), artworkUrl: MusicCatalog.safeHttpsUrl(raw["artworkUrl"]),
                             duration: max(0, (raw["duration"] as? NSNumber)?.doubleValue ?? 0), genre: nil, mood: nil, sourceUrl: MusicCatalog.safeHttpsUrl(raw["sourceUrl"]), downloadable: (raw["downloadable"] as? Bool) == true)
        if let text = raw["sourceId"] as? String { out.sourceId = String(text.prefix(120)) }
        out.fileName = raw["fileName"] as? String
        out.mimeType = raw["mimeType"] as? String
        out.fileSize = (raw["fileSize"] as? NSNumber)?.intValue
        out.savedAt = raw["savedAt"] as? String
        return out
    }

    private func loadLibrary() {
        if let folder = MusicPlayer.folder { try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        guard let text = UserDefaults.standard.string(forKey: MusicPlayer.libraryKey), let data = text.data(using: .utf8),
              let parsed = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else { return }
        if let version = parsed["version"] as? Int, version != 1 {
            operationError = "Не удалось прочитать музыкальную библиотеку."
            return
        }
        for entry in (parsed["saved"] as? [[String: Any]] ?? []).prefix(MusicPlayer.maxTracks) {
            guard let track = MusicPlayer.track(entry["track"]), track.source == "local", let file = entry["file"] as? String else { continue }
            names[track.id] = file
            if let url = fileURL(track), FileManager.default.fileExists(atPath: url.path) { saved.append(track) } else { names[track.id] = nil }
        }
        let localFavorites = (parsed["favorites"] as? [Any] ?? []).compactMap { MusicPlayer.track($0) }
        favorites = MusicPlayer.unique(localFavorites.compactMap { favorite in saved.first { $0.id == favorite.id } })
        audiusIds = Array((parsed["audiusFavoriteIds"] as? [Any] ?? []).compactMap { $0 as? String }.filter { MusicCatalog.matches("^[a-zA-Z0-9_-]{1,100}$", $0) }.prefix(MusicPlayer.maxTracks))
        scIds = Array((parsed["soundcloudFavoriteIds"] as? [Any] ?? []).compactMap { $0 as? String }.filter { MusicCatalog.isSoundCloudUrn($0) }.prefix(MusicPlayer.maxTracks))
        // Only the catalogues' ids are kept on disk: their tracks are asked again into memory.
        var failedAny = false
        var left = audiusIds.count
        for id in audiusIds {
            MusicCatalog.audiusTrack(id) { [weak self] result in
                guard let self else { return }
                left -= 1
                if case .success(let track) = result, self.audiusIds.contains(id) { self.favorites = MusicPlayer.unique(self.favorites + [track]) } else { failedAny = true }
                if left == 0, failedAny { self.notice = "Часть избранного Audius сейчас недоступна. Локальная музыка остаётся на устройстве." }
                self.tell(info: false)
            }
        }
    }

    private func restoreSoundCloud() {
        guard server?.token != nil else { return }
        let missing = scIds.filter { id in !favorites.contains { $0.sourceId == id } }
        for urn in missing.prefix(60) {
            MusicCatalog.soundCloudTrack(server, urn: urn) { [weak self] result in
                guard let self, case .success(let track) = result, self.scIds.contains(urn) else { return }
                self.favorites = MusicPlayer.unique(self.favorites + [track])
                self.tell(info: false)
            }
        }
    }

    private func storeLibrary() {
        let storedSaved: [[String: Any]] = saved.compactMap { track -> [String: Any]? in
            guard let file = names[track.id] else { return nil }
            return ["track": track.json, "file": file]
        }
        let storedFavorites: [[String: Any]] = favorites.filter { $0.source == "local" }.map { $0.json }
        let body: [String: Any] = ["version": 1, "saved": storedSaved, "favorites": storedFavorites, "audiusFavoriteIds": audiusIds, "soundcloudFavoriteIds": scIds]
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: []), let text = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(text, forKey: MusicPlayer.libraryKey)
    }

    func toggleFavorite(_ track: MusicTrack) {
        let present = isFavorite(track)
        if track.source == "audius", let id = track.sourceId {
            audiusIds.removeAll { $0 == id }
            if !present { audiusIds = Array(([id] + audiusIds).prefix(MusicPlayer.maxTracks)) }
        }
        if track.source == "soundcloud", let id = track.sourceId {
            scIds.removeAll { $0 == id }
            if !present { scIds = Array(([id] + scIds).prefix(MusicPlayer.maxTracks)) }
        }
        if present { favorites.removeAll { $0.id == track.id } } else { favorites = MusicPlayer.unique([saved.first { $0.id == track.id } ?? track] + favorites) }
        storeLibrary()
        tell(info: false)
    }

    /// Copies audio files the person chose into the app's own folder. Nothing is sent to a server.
    func importFiles(_ urls: [URL]) {
        operationError = ""
        notice = ""
        var imported = 0
        for source in urls {
            defer { try? FileManager.default.removeItem(at: source) }
            if saved.count >= MusicPlayer.maxTracks {
                operationError = "В библиотеке уже 500 файлов. Удали ненужные и попробуй снова."
                break
            }
            let ext = source.pathExtension.lowercased()
            guard MusicPlayer.audioExtensions.contains(ext) else {
                operationError = "Выбери аудиофайл: MP3, M4A, WAV, FLAC или другой поддерживаемый формат."
                break
            }
            let size = (try? source.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            guard size > 0, size <= MusicPlayer.maxFileSize else {
                operationError = "Аудиофайл пустой или больше 250 МБ."
                break
            }
            guard let folder = MusicPlayer.folder else { break }
            let storage = UUID().uuidString.lowercased() + "." + ext
            do { try FileManager.default.copyItem(at: source, to: folder.appendingPathComponent(storage)) }
            catch {
                operationError = "Не удалось импортировать аудиофайл. Проверь свободное место и попробуй ещё раз."
                break
            }
            let id = "local:" + UUID().uuidString.lowercased()
            let fileName = String(source.lastPathComponent.prefix(150))
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var track = MusicTrack(id: id, source: "local", sourceId: nil, title: source.deletingPathExtension().lastPathComponent, artist: "На этом устройстве", artworkUrl: nil, duration: 0, genre: nil, mood: nil, sourceUrl: nil, downloadable: true)
            track.fileName = fileName
            track.mimeType = MusicPlayer.extensionMimes[ext]
            track.fileSize = size
            track.savedAt = formatter.string(from: Date())
            names[id] = storage
            saved.insert(track, at: 0)
            imported += 1
        }
        if imported > 0 {
            storeLibrary()
            notice = "Добавлено файлов: \(imported). Музыка сохранена только на этом устройстве."
        }
        tell(info: false)
    }

    func removeSaved(_ track: MusicTrack) {
        if current?.id == track.id { stop() }
        if let file = fileURL(track) { try? FileManager.default.removeItem(at: file) }
        names[track.id] = nil
        saved.removeAll { $0.id == track.id }
        favorites.removeAll { $0.id == track.id }
        queue.removeAll { $0.id == track.id }
        storeLibrary()
        tell(info: false)
    }

    func report(_ words: String) {
        operationError = words
        tell(info: false)
    }

    func say(_ words: String) {
        notice = words
        tell(info: false)
    }

    #if targetEnvironment(simulator)
    func simulatorShow(_ tracks: [MusicTrack], current track: MusicTrack, position: Double, favorites liked: [MusicTrack]) {
        demo = true
        demoPosition = position
        queue = tracks
        current = track
        favorites = liked
        tell(info: false)
    }
    #endif
}
