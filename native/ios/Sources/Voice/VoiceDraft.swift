import AVFoundation
import UIKit

/// A stopped voice take waiting in the composer (owner's spec): it can be played, trimmed, recorded on («record
/// more» adds a new part after it) and then sent or thrown away. The parts stay separate files in the app's
/// temporary area until it is sent; then they are joined and cut to the kept part into one .m4a (AAC, as the
/// recorder writes), which goes the same way as any voice message: sealed with a fresh key and uploaded.
final class VoiceDraft: NSObject {
    private(set) var parts: [VoiceRecorder.Take] = []
    /// The kept part, as fractions of the whole draft.
    var trimStart: Double = 0
    var trimEnd: Double = 1
    private var player: AVPlayer?
    private var observer: Any?
    private var endObserver: NSObjectProtocol?
    /// Main queue: where playing is (fraction of the whole draft) and whether it plays.
    var onPlayback: ((Double, Bool) -> Void)?

    var durationMs: Int { parts.reduce(0) { (sum: Int, part: VoiceRecorder.Take) -> Int in sum + part.durationMs } }
    var levels: [Double] { parts.flatMap { (part: VoiceRecorder.Take) -> [Double] in part.levels } }
    var isEmpty: Bool { parts.isEmpty }
    var isPlaying: Bool { (player?.rate ?? 0) > 0 }

    func add(_ take: VoiceRecorder.Take) {
        stopPlaying()
        parts.append(take)
        trimStart = 0
        trimEnd = 1
        player = nil
    }

    /// Throws the parts away.
    func discard() {
        stopPlaying()
        for part in parts { try? FileManager.default.removeItem(at: part.file) }
        parts = []
        player = nil
    }

    deinit {
        if let observer, let player { player.removeTimeObserver(observer) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    }

    private func composition() -> AVMutableComposition? {
        let made = AVMutableComposition()
        guard let track = made.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { return nil }
        var cursor = CMTime.zero
        for part in parts {
            let asset = AVURLAsset(url: part.file)
            guard let source = asset.tracks(withMediaType: .audio).first else { continue }
            let range = CMTimeRange(start: .zero, duration: asset.duration)
            do {
                try track.insertTimeRange(range, of: source, at: cursor)
            } catch {
                continue
            }
            cursor = CMTimeAdd(cursor, asset.duration)
        }
        return made
    }

    private func preparePlayer() -> AVPlayer? {
        if let player { return player }
        guard let made = composition() else { return nil }
        let item = AVPlayerItem(asset: made)
        let created = AVPlayer(playerItem: item)
        observer = created.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] (time: CMTime) -> Void in
            self?.ticked(time)
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] (_: Notification) -> Void in
            self?.reachedEnd()
        }
        player = created
        return created
    }

    private func ticked(_ time: CMTime) {
        let total = Double(max(1, durationMs)) / 1000
        let fraction = time.seconds / total
        if isPlaying && fraction >= trimEnd {
            reachedEnd()
            return
        }
        onPlayback?(fraction, isPlaying)
    }

    private func reachedEnd() {
        player?.pause()
        seek(to: trimStart)
        onPlayback?(trimStart, false)
    }

    /// Play / pause; a paused draft goes on from where it stopped, or from the kept part's start.
    func toggle() {
        guard let player = preparePlayer() else { return }
        if isPlaying {
            player.pause()
            onPlayback?(currentFraction, false)
            return
        }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
        try? AVAudioSession.sharedInstance().setActive(true)
        let at = currentFraction
        if at < trimStart || at >= trimEnd - 0.001 { seek(to: trimStart) }
        player.play()
        onPlayback?(currentFraction, true)
    }

    var currentFraction: Double {
        guard let player else { return trimStart }
        let total = Double(max(1, durationMs)) / 1000
        return player.currentTime().seconds / total
    }

    func seek(to fraction: Double) {
        guard let player = preparePlayer() else { return }
        let total = Double(max(1, durationMs)) / 1000
        player.seek(to: CMTime(seconds: fraction * total, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        onPlayback?(fraction, isPlaying)
    }

    /// While a handle moves, playing stops; when it is let go, the draft plays from the new start (or the last
    /// second before the new end).
    func trimmed(start: Double, end: Double, endMoved: Bool, done: Bool) {
        trimStart = start
        trimEnd = end
        player?.pause()
        guard done else {
            onPlayback?(currentFraction, false)
            return
        }
        let total = Double(max(1, durationMs)) / 1000
        let from = endMoved ? max(start, end - 1 / total) : start
        seek(to: from)
        player?.play()
        onPlayback?(from, true)
    }

    func stopPlaying() {
        player?.pause()
    }

    /// The single file to send (main queue): the parts joined and cut to the kept part, the waveform of that part,
    /// its length. A single untrimmed part is handed over as it is.
    func build(_ done: @escaping (URL?, Int, String?) -> Void) {
        stopPlaying()
        let total = durationMs
        let allLevels = levels
        let keptFrom = Int((Double(allLevels.count) * trimStart).rounded(.down))
        let keptTo = max(keptFrom, Int((Double(allLevels.count) * trimEnd).rounded(.up)))
        let keptLevels = Array(allLevels[min(keptFrom, allLevels.count)..<min(keptTo, allLevels.count)])
        let waveform = FileCore.call("waveform", [keptLevels]) as? String
        let trimmed = trimStart > 0.0005 || trimEnd < 0.9995
        if parts.count == 1 && !trimmed, let only = parts.first {
            parts = []
            done(only.file, total, waveform ?? only.waveform)
            return
        }
        guard let made = composition(), let export = AVAssetExportSession(asset: made, presetName: AVAssetExportPresetAppleM4A) else {
            done(nil, 0, nil)
            return
        }
        let target = FileManager.default.temporaryDirectory.appendingPathComponent("invizent-voice-" + UUID().uuidString.lowercased() + ".m4a")
        export.outputURL = target
        export.outputFileType = .m4a
        let seconds = Double(total) / 1000
        export.timeRange = CMTimeRange(start: CMTime(seconds: seconds * trimStart, preferredTimescale: 600), end: CMTime(seconds: seconds * trimEnd, preferredTimescale: 600))
        let keptMs = Int((Double(total) * (trimEnd - trimStart)).rounded())
        let old = parts
        parts = []
        player = nil
        export.exportAsynchronously {
            let ok = export.status == .completed
            DispatchQueue.main.async {
                for part in old { try? FileManager.default.removeItem(at: part.file) }
                if ok {
                    done(target, keptMs, waveform)
                } else {
                    try? FileManager.default.removeItem(at: target)
                    done(nil, 0, nil)
                }
            }
        }
    }
}
