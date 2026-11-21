import AVFoundation
import UIKit

/// Brings one attachment for playing: downloads the sealed bytes, has the core check and open them (a small file
/// at once, a big one chunk by chunk) and leaves the decrypted file in the app's protected temporary area
/// (`invizent-view-…`, swept at the next start of a chat). The caller removes the folder when it is done.
final class MediaFetch {
    typealias Brought = (folder: URL, file: URL)
    private let small = FileTransfer()
    private let big = BigTransfer()
    private var stopped = false

    func cancel() {
        stopped = true
        small.cancel()
        big.cancel()
    }

    /// `progress`: 0…1 on the main queue. `done`: on the main queue, never after `cancel()`.
    func start(server: Server, attachment: [String: Any], progress: @escaping (Double) -> Void, done: @escaping (Result<Brought, FileCore.Failure>) -> Void) {
        let about = FileCore.describe(attachment)
        let manager = FileManager.default
        let folder = manager.temporaryDirectory.appendingPathComponent("invizent-view-" + UUID().uuidString.lowercased(), isDirectory: true)
        let file = folder.appendingPathComponent(about.fileName.isEmpty ? "file" : about.fileName, isDirectory: false)
        let chunked = ChunkCore.isChunked(attachment)
        var last = -1
        let report: (Int, Int) -> Void = { (got: Int, all: Int) -> Void in
            let percent = all > 0 ? got * 100 / all : 0
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.stopped, percent != last else { return }
                last = percent
                progress(Double(percent) / 100)
            }
        }
        small.onProgress = report
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            var result: Result<Brought, FileCore.Failure> = .failure(FileCore.Failure(words: "Не удалось загрузить зашифрованный файл."))
            do {
                try manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
                if chunked {
                    switch BigFiles.download(server, attachment: attachment, to: file, transfer: big, progress: report) {
                    case .success: result = .success((folder, file))
                    case .failure(let failure): result = .failure(failure)
                    }
                } else if let refusal = about.refusal {
                    result = .failure(FileCore.Failure(words: refusal))
                } else if let id = attachment["id"] as? String, let cipherSize = about.cipherSize {
                    switch server.downloadSealedFile(id: id, cipherSize: cipherSize, transfer: small) {
                    case .failure(.words(let words)): result = .failure(FileCore.Failure(words: words))
                    case .failure: result = .failure(FileCore.Failure(words: "Не удалось загрузить зашифрованный файл."))
                    case .success(let sealed):
                        switch FileCore.open(sealed, attachment: attachment) {
                        case .failure(let failure): result = .failure(failure)
                        case .success(let plain):
                            try plain.write(to: file, options: [.atomic, .completeFileProtection])
                            result = .success((folder, file))
                        }
                    }
                }
            } catch {
                result = .failure(FileCore.Failure(words: "Не удалось открыть файл."))
            }
            DispatchQueue.main.async { [self] in
                if case .failure = result { try? manager.removeItem(at: folder) }
                if stopped {
                    try? manager.removeItem(at: folder)
                    return
                }
                done(result)
            }
        }
    }
}

/// The player of one chat's voice messages: one at a time; starting one stops the previous one and the music.
/// Reference: mobile/src/voice/VoiceMessage.tsx (`VoicePlaybackProvider`): the speed goes 1× → 1,5× → 2× and is
/// kept for the session; a tap on the waveform of the playing message seeks; leaving the chat stops the sound and
/// deletes the decrypted copies.
final class VoicePlayer: NSObject, AVAudioPlayerDelegate {
    /// The speed of voice and round video messages, kept until the app is closed.
    static var rate: Float = 1
    static var rateLabel: String { rate == 1.5 ? "1,5×" : rate == 2 ? "2×" : "1×" }

    private let server: Server?
    private var player: AVAudioPlayer?
    private var activeKey = ""
    private var totalMs = 0
    private var loading: MediaFetch?
    private var files: [String: MediaFetch.Brought] = [:]
    private var ticker: Timer?
    /// What the list must show for the active row (nil: nothing is active).
    var onState: ((MsgMediaState?) -> Void)?
    var onProblem: ((String) -> Void)?
    var isPlaying: Bool { player?.isPlaying ?? false }
    /// A voice message is about to sound: whatever else sounds in the chat goes quiet.
    var onWillPlay: (() -> Void)?

    init(server: Server?) {
        self.server = server
    }

    deinit {
        ticker?.invalidate()
        for file in files.values { try? FileManager.default.removeItem(at: file.folder) }
    }

    private static func time(_ ms: Int) -> String {
        FileCore.call("voiceTime", [max(0, ms)]) as? String ?? ""
    }

    private func publish() {
        if activeKey.isEmpty {
            onState?(nil)
            return
        }
        var state = MsgMediaState()
        state.key = activeKey
        state.loading = loading != nil
        state.rate = VoicePlayer.rateLabel
        if let player {
            let total = player.duration > 0 ? Int(player.duration * 1000) : totalMs
            let position = Int(player.currentTime * 1000)
            state.playing = player.isPlaying
            state.progress = total > 0 ? CGFloat(min(1, Double(position) / Double(total))) : 0
            state.time = position > 0 ? VoicePlayer.time(position) + " / " + VoicePlayer.time(total) : VoicePlayer.time(total)
        }
        onState?(state)
    }

    private func tick(_ on: Bool) {
        ticker?.invalidate()
        ticker = nil
        guard on else { return }
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.publish() }
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
    }

    /// The play button of a row: starts this message, or pauses and continues it when it is the active one.
    func toggle(key: String, attachment: [String: Any]) {
        if key == activeKey, loading == nil, let player {
            if player.isPlaying {
                player.pause()
                tick(false)
            } else {
                begin()
            }
            publish()
            return
        }
        halt()
        activeKey = key
        totalMs = ((attachment["media"] as? [String: Any])?["durationMs"] as? NSNumber)?.intValue ?? 0
        if let ready = files[key] {
            play(ready.file)
            return
        }
        guard let server else { return }
        let fetch = MediaFetch()
        loading = fetch
        publish()
        fetch.start(server: server, attachment: attachment, progress: { _ in }, done: { [weak self] (result: Result<MediaFetch.Brought, FileCore.Failure>) -> Void in
            guard let self, self.loading === fetch else {
                if case .success(let brought) = result { try? FileManager.default.removeItem(at: brought.folder) }
                return
            }
            self.loading = nil
            switch result {
            case .failure(let failure):
                self.activeKey = ""
                self.publish()
                self.onProblem?(failure.words)
            case .success(let brought):
                // No more than a dozen decrypted voice messages are kept per open chat.
                if self.files.count >= 12, let old = self.files.keys.first(where: { $0 != key }), let gone = self.files.removeValue(forKey: old) {
                    try? FileManager.default.removeItem(at: gone.folder)
                }
                self.files[key] = brought
                self.play(brought.file)
            }
        })
    }

    private func play(_ file: URL) {
        guard let made = try? AVAudioPlayer(contentsOf: file) else {
            activeKey = ""
            publish()
            onProblem?("Не удалось воспроизвести голосовое.")
            return
        }
        made.delegate = self
        made.enableRate = true
        made.prepareToPlay()
        player = made
        begin()
        publish()
    }

    private func begin() {
        guard let player else { return }
        onWillPlay?()
        if MusicPlayer.shared.current != nil { MusicPlayer.shared.stop() }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true)
        player.rate = VoicePlayer.rate
        player.play()
        tick(true)
    }

    /// A tap on the waveform: the active message jumps there; any other message starts playing.
    func seek(key: String, fraction: CGFloat) -> Bool {
        guard key == activeKey, let player, player.duration > 0 else { return false }
        player.currentTime = Double(min(1, max(0, fraction))) * player.duration
        publish()
        return true
    }

    /// The speed chip: 1× → 1,5× → 2× → 1×. Gives the words that say what was chosen.
    func cycleRate() -> String {
        let next: Float = VoicePlayer.rate == 1 ? 1.5 : VoicePlayer.rate == 1.5 ? 2 : 1
        VoicePlayer.rate = next
        if let player, player.isPlaying { player.rate = next }
        publish()
        if next == 1 { return "Звук будет проигрываться с обычной скоростью." }
        return "Звук будет проигрываться в " + (next == 1.5 ? "1,5" : "2") + " раза быстрее."
    }

    /// Pauses without forgetting the message (something else is about to sound).
    func pause() {
        guard let player, player.isPlaying else { return }
        player.pause()
        tick(false)
        publish()
    }

    private func halt() {
        loading?.cancel()
        loading = nil
        player?.stop()
        player = nil
        tick(false)
    }

    /// Stops and forgets the active message.
    func stop() {
        halt()
        activeKey = ""
        publish()
    }

    /// The chat is left: the sound stops, the decrypted copies go.
    func left() {
        stop()
        for file in files.values { try? FileManager.default.removeItem(at: file.folder) }
        files.removeAll()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        player.currentTime = 0
        tick(false)
        publish()
    }
}
