import AVFoundation
import UIKit

/// The microphone of one chat's composer. Nothing is recorded before `start()`, and the permission is asked only
/// when the person first holds the microphone button.
///
/// Reference: mobile/src/voice/VoiceMessage.tsx (`VOICE_RECORDING`, `useVoiceRecorder`) and mobile/src/voice/voice.ts
/// (`pushVoiceSample`, `levelFromMetering`, `diagnoseVoiceTake`). The file is what every other app plays: AAC in
/// an MPEG-4 container (.m4a), mono, 48 kHz, 128 kbit/s. The loudness is read from the recorder ten times a second
/// while the take runs; the core turns those levels into the waveform that travels with the message.
final class VoiceRecorder: NSObject {
    /// A finished take.
    struct Take {
        let file: URL
        let durationMs: Int
        /// The letters of the waveform; nil when the take has no sound to draw.
        let waveform: String?
        /// The file is not the take (the microphone stopped): it is not sent.
        let broken: Bool
        /// Nothing above the waveform's threshold was heard: sent, but the person is told.
        let silent: Bool
    }

    struct Failure: Error {
        let words: String
    }

    static let noAccess = "Нет доступа к микрофону. Разреши его для Инвиза в настройках телефона, чтобы записывать голосовые."
    private static let sampleCap = 20000
    private static let maxMs = 18 * 60 * 60 * 1000

    private var recorder: AVAudioRecorder?
    private var meter: Timer?
    private var samples: [Double] = []
    private var sampleStride = 1
    private var pendingLevel = 0.0
    private var pendingCount = 0
    private var loudest = 0.0
    private(set) var isPaused = false
    /// The loudness right now, 0…1 (main queue, ten times a second).
    var onLevel: ((CGFloat) -> Void)?
    /// The longest take was reached: it must be finished and sent.
    var onLimit: (() -> Void)?

    var isRecording: Bool { recorder != nil }

    /// How long the take is by now.
    var elapsedMs: Int {
        guard let recorder else { return 0 }
        return Int((recorder.currentTime * 1000).rounded())
    }

    /// Whether the microphone may be used: true, false, or nil when the person has not been asked yet.
    static var allowed: Bool? {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return nil
        }
    }

    /// Asks for the microphone (the system shows its question once); the answer comes on the main queue.
    static func ask(_ done: @escaping (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission { (granted: Bool) -> Void in
            DispatchQueue.main.async { done(granted) }
        }
    }

    /// One meter level joins the waveform. When the buffer is full, neighbours are merged (the louder wins) and
    /// from then on every `stride` levels make one sample: memory stays bounded and the waveform still spans
    /// the whole take.
    private func push(_ level: Double) {
        pendingLevel = pendingCount == 0 ? level : max(pendingLevel, level)
        pendingCount += 1
        if pendingCount < sampleStride { return }
        samples.append(pendingLevel)
        pendingCount = 0
        pendingLevel = 0
        if samples.count < VoiceRecorder.sampleCap { return }
        var merged: [Double] = []
        merged.reserveCapacity(samples.count / 2 + 1)
        var index = 0
        while index < samples.count {
            let other = index + 1 < samples.count ? samples[index + 1] : 0
            merged.append(max(samples[index], other))
            index += 2
        }
        samples = merged
        sampleStride *= 2
    }

    /// Starts a take. The permission must have been given already.
    func start() -> Failure? {
        if recorder != nil { return nil }
        guard VoiceRecorder.allowed == true else { return Failure(words: VoiceRecorder.noAccess) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("invizent-voice-" + UUID().uuidString.lowercased() + ".m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 128000, AVEncoderAudioQualityKey: AVAudioQuality.max.rawValue,
        ]
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
            let made = try AVAudioRecorder(url: file, settings: settings)
            made.isMeteringEnabled = true
            guard made.prepareToRecord(), made.record() else {
                try? FileManager.default.removeItem(at: file)
                return Failure(words: "Не удалось начать запись.")
            }
            recorder = made
        } catch {
            try? FileManager.default.removeItem(at: file)
            return Failure(words: "Не удалось начать запись.")
        }
        samples = []
        sampleStride = 1
        pendingLevel = 0
        pendingCount = 0
        loudest = 0
        isPaused = false
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.measure() }
        RunLoop.main.add(timer, forMode: .common)
        meter = timer
        return nil
    }

    private func measure() {
        guard let recorder, !isPaused else { return }
        recorder.updateMeters()
        let decibels = Double(recorder.averagePower(forChannel: 0))
        let level = decibels.isFinite ? min(1, max(0, (decibels + 60) / 60)) : 0
        loudest = max(loudest, level)
        push(level)
        onLevel?(CGFloat(level))
        if elapsedMs >= VoiceRecorder.maxMs { onLimit?() }
    }

    /// Pauses the take or goes on with the same file.
    func togglePause() {
        guard let recorder else { return }
        if isPaused {
            isPaused = !recorder.record()
        } else {
            recorder.pause()
            isPaused = true
        }
    }

    /// Stops the take. Gives the file, or nil when it is called off (the file is deleted then).
    func finish(keep: Bool) -> Take? {
        guard let recorder else { return nil }
        meter?.invalidate()
        meter = nil
        // Read before `stop()`: afterwards the recorder reports zero.
        let durationMs = min(VoiceRecorder.maxMs, elapsedMs)
        let file = recorder.url
        recorder.stop()
        self.recorder = nil
        isPaused = false
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
        if !keep {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        var levels = samples
        if pendingCount > 0 { levels.append(pendingLevel) }
        let waveform = FileCore.call("waveform", [levels]) as? String
        let bytes = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        // 128 kbit/s is 16 bytes a millisecond; a file under an eighth of that is not the take.
        let tiny = durationMs >= 1000 && bytes < durationMs * 16 / 8
        return Take(file: file, durationMs: durationMs, waveform: waveform, broken: tiny, silent: durationMs >= 1000 && !(loudest > 0.02))
    }
}
