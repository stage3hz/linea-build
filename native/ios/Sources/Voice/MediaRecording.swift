import AVFoundation
import UIKit

/// Recording voice and round video messages from a composer (a chat's or «Избранное»'s): the record button and its
/// take (Sources/Voice/RecordControl.swift), the microphone (VoiceRecorder), the stopped take waiting to be sent
/// (VoiceDraft), the round camera (NoteRecorder). What is finally sent goes to the owner through `sendVoice` /
/// `sendNote`, which seal and upload it as before. Permissions are asked when the button is first held; the person
/// then holds it again. Main queue only.
final class MediaRecording: NSObject {
    let control = RecordControl()
    private let recorder = VoiceRecorder()
    private let draft = VoiceDraft()
    private var note: NoteRecorder?
    /// The parts of a stopped round video («record more» adds one), the file the circle plays (the parts joined),
    /// the kept part.
    private var noteParts: [URL] = []
    private var noteShown: URL?
    private var noteTrim: (Double, Double) = (0, 1)
    private var noteMs = 0
    private var levelTimer: Timer?
    private weak var host: UIView?
    private weak var composer: UIView?
    private var lastTrim: (Double, Double) = (0, 1)

    /// Before a take: nil when it may start, otherwise the words to say ("" to refuse without a word).
    var canStart: ((RecordControl.Mode) -> String?)?
    /// A take starts: whatever plays stops, the keyboard goes.
    var willStart: (() -> Void)?
    var say: ((String) -> Void)?
    /// The voice message to send: the file, its length, its waveform.
    var sendVoice: ((URL, Int, String?) -> Void)?
    /// The recorded round video to send (still to be written anew without metadata).
    var sendNote: ((URL) -> Void)?
    /// Words for a take the microphone did not really record.
    var brokenWords = "Микрофон записал тишину — голосовое не отправлено. Запиши ещё раз."

    /// Whether a take, the camera or a preview is on.
    var isBusy: Bool { recorder.isRecording || note != nil || control.isBusy }
    var isRecording: Bool { recorder.isRecording || note != nil }

    func install(composer: UIView, host: UIView) {
        self.host = host
        self.composer = composer
        control.install(composer: composer, host: host)
        control.timeWords = { [weak self] () -> String in
            guard let self else { return "0:00,00" }
            let ms = self.note != nil ? (self.note?.elapsedMs ?? 0) : self.draft.durationMs + self.recorder.elapsedMs
            return FileCore.call("voiceTimeFine", [ms]) as? String ?? "0:00,00"
        }
        control.onHoldStart = { [weak self] (mode: RecordControl.Mode) -> Bool in
            guard let self else { return false }
            return mode == .voice ? self.startVoice() : self.startNote()
        }
        control.onFinish = { [weak self] (ending: RecordControl.Ending) -> Void in self?.finished(ending) }
        control.onPreviewSend = { [weak self] in self?.sendPreview() }
        control.onPreviewDelete = { [weak self] in self?.deletePreview() }
        control.onRecordMore = { [weak self] in self?.recordMore() }
        control.previewToggle = { [weak self] in
            guard let self else { return }
            if let note = self.note {
                self.control.setPreviewPlayback(0, playing: note.togglePlayback())
            } else {
                self.draft.toggle()
            }
        }
        control.previewSeek = { [weak self] (fraction: Double) -> Void in self?.draft.seek(to: fraction) }
        control.previewTrim = { [weak self] (start: Double, end: Double, done: Bool) -> Void in
            guard let self else { return }
            if let note = self.note {
                self.noteTrim = (start, end)
                note.setTrim(start: start, end: end, done: done)
                return
            }
            let endMoved = abs(end - self.lastTrim.1) > abs(start - self.lastTrim.0)
            if done { self.lastTrim = (start, end) }
            self.draft.trimmed(start: start, end: end, endMoved: endMoved, done: done)
        }
        draft.onPlayback = { [weak self] (fraction: Double, playing: Bool) -> Void in
            self?.control.setPreviewPlayback(fraction, playing: playing)
        }
        recorder.onPeak = { [weak self] (level: CGFloat) -> Void in self?.control.setLevel(level) }
        recorder.onLimit = { [weak self] in self?.control.end(.send) }
    }

    // MARK: Starting

    private func startVoice() -> Bool {
        if let words = canStart?(.voice) {
            if !words.isEmpty { say?(words) }
            return false
        }
        switch VoiceRecorder.allowed {
        case .none:
            // The system asks once; the finger has left the button by then, so the person holds it again.
            VoiceRecorder.ask { [weak self] (granted: Bool) -> Void in
                if !granted { self?.say?(VoiceRecorder.noAccess) }
            }
            return false
        case .some(false):
            say?(VoiceRecorder.noAccess)
            return false
        case .some(true):
            break
        }
        willStart?()
        if MusicPlayer.shared.current != nil { MusicPlayer.shared.stop() }
        draft.stopPlaying()
        if let failure = recorder.start() {
            say?(failure.words)
            return false
        }
        return true
    }

    private func startNote() -> Bool {
        if let words = canStart?(.video) {
            if !words.isEmpty { say?(words) }
            return false
        }
        switch NoteRecorder.allowed {
        case .none:
            NoteRecorder.ask { [weak self] (granted: Bool) -> Void in
                if !granted { self?.say?(NoteRecorder.noAccess) }
            }
            return false
        case .some(false):
            say?(NoteRecorder.noAccess)
            return false
        case .some(true):
            break
        }
        guard let host, let composer else { return false }
        willStart?()
        let made = NoteRecorder(host: host, composer: composer)
        made.onLimit = { [weak self] in self?.control.end(.send) }
        made.onFailure = { [weak self] (words: String) -> Void in self?.say?(words) }
        note = made
        made.open()
        startLevels()
        return true
    }

    #if targetEnvironment(simulator)
    /// `-notedemo 1`: the round-video recorder opened by the composer's own path (the simulator has no camera: the
    /// circle shows «Камера недоступна.» under it), the composer's strip held as while the finger is down.
    func demoNote() {
        guard let host, let composer, note == nil else { return }
        let made = NoteRecorder(host: host, composer: composer)
        made.onFailure = { [weak self] (words: String) -> Void in self?.say?(words) }
        note = made
        control.demoHoldingVideo()
        made.open()
    }
    #endif

    /// The camera's microphone is read every 25 ms for the blob (the voice recorder reports by itself).
    private func startLevels() {
        levelTimer?.invalidate()
        let timer = Timer(timeInterval: 0.025, repeats: true) { [weak self] _ in
            guard let self, let note = self.note else { return }
            self.control.setLevel(note.level)
        }
        RunLoop.main.add(timer, forMode: .common)
        levelTimer = timer
    }

    private func stopLevels() {
        levelTimer?.invalidate()
        levelTimer = nil
    }

    /// The composer's place changed (after the host's layout).
    func layout() {
        note?.layout()
    }

    // MARK: Ending

    private func finished(_ ending: RecordControl.Ending) {
        stopLevels()
        if let note {
            finishNote(note, ending)
        } else {
            finishVoice(ending)
        }
    }

    /// nil when the take may not be kept (said why).
    private func checked(_ take: VoiceRecorder.Take) -> VoiceRecorder.Take? {
        if take.durationMs < 500 && draft.isEmpty {
            Haptic.error()
            try? FileManager.default.removeItem(at: take.file)
            say?("Слишком короткое голосовое — держи запись хотя бы секунду.")
            return nil
        }
        if take.broken {
            Haptic.error()
            try? FileManager.default.removeItem(at: take.file)
            say?(brokenWords)
            return nil
        }
        if take.silent { say?("Микрофон записал тишину. Если в голосовом нет звука — запиши ещё раз.") }
        return take
    }

    private func finishVoice(_ ending: RecordControl.Ending) {
        switch ending {
        case .cancel:
            _ = recorder.finish(keep: false)
            draft.discard()
        case .send:
            guard let raw = recorder.finish(keep: true) else { return }
            guard let take = checked(raw) else {
                if !draft.isEmpty { sendDraft() }
                return
            }
            if draft.isEmpty {
                Haptic.tap()
                sendVoice?(take.file, take.durationMs, take.waveform)
            } else {
                draft.add(take)
                sendDraft()
            }
        case .preview:
            guard let raw = recorder.finish(keep: true) else { return }
            if let take = checked(raw) { draft.add(take) }
            guard !draft.isEmpty else { return }
            lastTrim = (0, 1)
            control.showPreview(levels: draft.levels, durationMs: draft.durationMs, video: false)
        }
    }

    private func sendDraft() {
        draft.build { [weak self] (file: URL?, ms: Int, waveform: String?) -> Void in
            guard let self else { return }
            guard let file else {
                self.say?("Не удалось подготовить голосовое. Запиши ещё раз.")
                return
            }
            Haptic.tap()
            self.sendVoice?(file, ms, waveform)
        }
    }

    private func finishNote(_ shown: NoteRecorder, _ ending: RecordControl.Ending) {
        switch ending {
        case .cancel:
            shown.stop(keep: false) { (_: URL?, _: Int) -> Void in }
            shown.close()
            note = nil
            dropNoteParts()
        case .send:
            shown.stop(keep: true) { [weak self] (file: URL?, ms: Int) -> Void in
                shown.close()
                guard let self else { return }
                self.note = nil
                if let file, ms >= 1000 || !self.noteParts.isEmpty { self.noteParts.append(file) } else if let file {
                    try? FileManager.default.removeItem(at: file)
                }
                guard !self.noteParts.isEmpty else {
                    Haptic.error()
                    return
                }
                self.sendNoteParts()
            }
        case .preview:
            shown.stop(keep: true) { [weak self] (file: URL?, ms: Int) -> Void in
                guard let self else { return }
                if let file, ms >= 1000 || !self.noteParts.isEmpty { self.noteParts.append(file) } else if let file {
                    try? FileManager.default.removeItem(at: file)
                }
                guard !self.noteParts.isEmpty else {
                    Haptic.error()
                    shown.close()
                    self.note = nil
                    return
                }
                self.noteMs = shown.elapsedMs
                self.noteTrim = (0, 1)
                // The circle plays the parts joined; the field shows their frames.
                NoteRecorder.join(self.noteParts, from: 0, to: 1) { [weak self] (joined: URL?) -> Void in
                    guard let self, self.note === shown, let joined else { return }
                    if joined != self.noteParts.first || self.noteParts.count > 1 { self.noteShown = joined }
                    shown.showResult(joined)
                    self.control.showPreview(levels: [], durationMs: self.noteMs, video: true)
                    self.control.setPreviewPlayback(0, playing: true)
                    NoteRecorder.frames(of: joined, count: self.control.videoFrameCount, side: 33) { [weak self] (images: [UIImage]) -> Void in
                        self?.control.setVideoFrames(images)
                    }
                }
            }
        }
    }

    /// The parts joined and cut to the kept part go out as one round video.
    private func sendNoteParts() {
        let parts = noteParts
        let trim = noteTrim
        noteParts = []
        noteTrim = (0, 1)
        if let shown = noteShown { try? FileManager.default.removeItem(at: shown) }
        noteShown = nil
        NoteRecorder.join(parts, from: trim.0, to: trim.1) { [weak self] (file: URL?) -> Void in
            for part in parts where part != file { try? FileManager.default.removeItem(at: part) }
            guard let file else {
                self?.say?("Не удалось подготовить видеосообщение.")
                return
            }
            self?.sendNote?(file)
        }
    }

    private func dropNoteParts() {
        for part in noteParts { try? FileManager.default.removeItem(at: part) }
        if let shown = noteShown { try? FileManager.default.removeItem(at: shown) }
        noteParts = []
        noteShown = nil
        noteTrim = (0, 1)
    }

    // MARK: The preview

    private func sendPreview() {
        if let shown = note {
            shown.close()
            note = nil
            control.endPreview(deleted: false)
            sendNoteParts()
            return
        }
        control.endPreview(deleted: false)
        sendDraft()
    }

    private func deletePreview() {
        if let shown = note {
            shown.close()
            note = nil
            dropNoteParts()
        } else {
            draft.discard()
        }
        control.endPreview(deleted: true)
    }

    private func recordMore() {
        if let shown = note {
            // A round video: the camera records the next part after the ones before.
            if let joined = noteShown { try? FileManager.default.removeItem(at: joined) }
            noteShown = nil
            noteTrim = (0, 1)
            shown.resume(after: noteMs)
            control.resumeLocked()
            startLevels()
            return
        }
        guard startVoice() else { return }
        control.resumeLocked()
    }

    /// The screen is left: a take is called off, a preview thrown away, the camera closed.
    func left() {
        stopLevels()
        if recorder.isRecording { _ = recorder.finish(keep: false) }
        if let shown = note {
            shown.stop(keep: false) { (_: URL?, _: Int) -> Void in }
            shown.close()
            note = nil
        }
        dropNoteParts()
        draft.discard()
        if control.isBusy { control.reset() }
    }
}
