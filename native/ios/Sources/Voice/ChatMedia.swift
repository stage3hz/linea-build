import AVFoundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// How a voice message, a video or a round video looks in the list (`MsgRow`: `media`, `wave`, `mediaTime`,
/// `thumb`, `thumbRound`, `thumbWide`). Reference: mobile/src/MessageRow.tsx with mobile/src/voice/voice.ts
/// (`isVoice`, `isVideoNote` — both decided by the core here, `mediaKind`).
enum MediaRows {
    static func kind(_ attachment: [String: Any]) -> String {
        var bare = attachment
        bare["preview"] = nil
        return FileCore.call("mediaKind", [bare]) as? String ?? "file"
    }

    /// The fields to put over a message's row; nil for an attachment that is none of the three.
    static func fields(_ attachment: [String: Any]) -> [String: Any]? {
        let kind = MediaRows.kind(attachment)
        guard kind == "voice" || kind == "note" || kind == "video" else { return nil }
        let media = attachment["media"] as? [String: Any] ?? [:]
        var fields: [String: Any] = ["media": kind]
        if let ms = (media["durationMs"] as? NSNumber)?.doubleValue, ms > 0 { fields["mediaTime"] = FileCore.call("voiceTime", [ms]) as? String ?? "" }
        if kind == "voice" {
            fields["wave"] = media["waveform"] as? String ?? ""
            return fields
        }
        // The small picture was checked by the core when the message was opened (`photo::valid_preview`).
        if let preview = attachment["preview"] as? [String: Any], let picture = preview["base64"] as? String,
           let width = (preview["width"] as? NSNumber)?.doubleValue, let height = (preview["height"] as? NSNumber)?.doubleValue, width > 0, height > 0 {
            fields["thumb"] = picture
            fields["thumbWide"] = kind == "note" ? 1 : width / height
        } else if let width = (media["width"] as? NSNumber)?.doubleValue, let height = (media["height"] as? NSNumber)?.doubleValue, width > 0, height > 0 {
            fields["thumbWide"] = kind == "note" ? 1 : width / height
        } else {
            fields["thumbWide"] = kind == "note" ? 1 : 1.5
        }
        if kind == "note" { fields["thumbRound"] = true }
        return fields
    }
}

/// Voice messages, videos and round videos of one chat: the record button of the composer, recording, getting a
/// video ready, sealing and uploading (a big file in chunks, going on after a lost connection), the rows of what
/// is on its way out, and playing what the messages on screen carry.
///
/// All three are attachments of ordinary end-to-end encrypted messages: the file's key exists only in memory and
/// inside the encrypted message. Reference: mobile/src/ChatScreen.tsx (`finishVoice`, the record hints),
/// mobile/src/videonote/noteSender.ts, mobile/src/e2ee/attachments.ts.
final class ChatMedia: NSObject, PHPickerViewControllerDelegate {
    /// What is sealed and sent, and how the message describes it.
    private struct Payload {
        let file: URL
        let name: String
        let mimeType: String
        let media: [String: Any]
        let preview: [String: Any]?
        /// Counted against the server's limit for videos (a big upload says which).
        let video: Bool
    }

    /// A voice message, a video or a round video on its way out, shown as a row until the server has the message.
    private final class Outgoing {
        let key = "media-" + UUID().uuidString.lowercased()
        let time = Messenger.clock.string(from: Date())
        let kind: String
        var wave = ""
        var mediaTime = ""
        var thumb = ""
        var wide = 1.0
        var note = ""
        var failed: String?
        var payload: Payload?
        /// A recorded round video that still has to be written anew (kept for another try).
        var source: URL?
        var export: AVAssetExportSession?
        var small: FileTransfer?
        let big = BigTransfer()
        var removed = false
        var percent = -1

        init(kind: String) {
            self.kind = kind
        }
    }

    private static let smallLimit = 20 * 1024 * 1024
    private weak var host: UIViewController?
    private weak var list: MsgListView?
    private weak var field: ComposerField?
    private weak var sendButton: UIButton?
    private weak var composer: UIView?
    private weak var actions: ChatScreenActions?
    private let messenger: Messenger?
    private let chatId: String
    private let peerId: String
    private let control = RecordControl()
    private let recorder = VoiceRecorder()
    private lazy var voice = VoicePlayer(server: messenger?.server)
    private var notes: NotePlayback?
    private var outgoing: [Outgoing] = []
    private let work = DispatchQueue(label: "invizent.media", qos: .userInitiated)
    private let toast = UILabel()
    private var toastHide: DispatchWorkItem?
    private var hintBack: DispatchWorkItem?
    private var watch: Timer?
    private var sampleRows: [[String: Any]] = []
    /// Called on the main queue when the rows of what is on its way out changed.
    var onPendingChanged: (() -> Void)?

    init(messenger: Messenger?, chatId: String, peerId: String) {
        self.messenger = messenger
        self.chatId = chatId
        self.peerId = peerId
        super.init()
    }

    deinit {
        watch?.invalidate()
    }

    // MARK: The screen

    func install(host: UIViewController, list: MsgListView, composer: UIView, field: ComposerField, send: UIButton, attachments: ChatAttachments, actions: ChatScreenActions) {
        self.host = host
        self.list = list
        self.field = field
        self.composer = composer
        self.actions = actions
        sendButton = send
        control.install(composer: composer, host: host.view)
        notes = NotePlayback(server: messenger?.server, list: list)

        toast.font = .systemFont(ofSize: 14)
        toast.textColor = .white
        toast.textAlignment = .center
        toast.numberOfLines = 0
        toast.backgroundColor = UIColor(red: 20 / 255, green: 24 / 255, blue: 36 / 255, alpha: 0.92)
        toast.layer.cornerRadius = 14
        toast.layer.masksToBounds = true
        toast.isHidden = true
        toast.isUserInteractionEnabled = false
        host.view.addSubview(toast)

        // A touch on a row: an unsent one offers to try again; a voice message, a video or a round video plays;
        // a big file of any kind opens.
        attachments.mediaPressed = { [weak self] (key: String) -> Bool in self?.pressed(key) ?? false }
        attachments.onVideo = { [weak self] in self?.pickVideo() }
        list.onMediaPress = { [weak self] (event: [String: Any]) -> Void in
            self?.partPressed(event["key"] as? String ?? "", part: event["part"] as? String ?? "", fraction: CGFloat((event["fraction"] as? NSNumber)?.doubleValue ?? 0))
        }

        voice.onState = { [weak self] (state: MsgMediaState?) -> Void in self?.list?.setMediaState(state) }
        voice.onProblem = { [weak self] (words: String) -> Void in self?.say(words) }
        voice.onWillPlay = { [weak self] in self?.notes?.quiet() }
        notes?.onState = { [weak self] (state: MsgMediaState?) -> Void in self?.list?.setMediaState(state) }
        notes?.onProblem = { [weak self] (words: String) -> Void in self?.say(words) }
        notes?.onWillPlay = { [weak self] in self?.voice.pause() }
        notes?.holdsSilence = { [weak self] () -> Bool in
            guard let self else { return true }
            // Also while something stands over the chat (the round video recorder uses the microphone).
            return self.recorder.isRecording || self.voice.isPlaying || self.host?.presentedViewController != nil
        }

        control.timeWords = { [weak self] () -> String in
            FileCore.call("voiceTimeFine", [self?.recorder.elapsedMs ?? 0]) as? String ?? "0:00,00"
        }
        control.onModeChanged = { [weak self] (mode: RecordControl.Mode) -> Void in self?.modeChanged(mode) }
        control.onHoldStart = { [weak self] () -> Bool in self?.startVoice() ?? false }
        control.onFinish = { [weak self] (send: Bool) -> Void in self?.finishVoice(send: send) }
        control.onPause = { [weak self] in
            guard let self else { return }
            self.recorder.togglePause()
            self.control.setPaused(self.recorder.isPaused)
        }
        control.onVideo = { [weak self] in self?.recordNote() }
        recorder.onLevel = { [weak self] (level: CGFloat) -> Void in self?.control.setLevel(level) }
        recorder.onLimit = { [weak self] in
            guard let self else { return }
            self.control.reset()
            self.finishVoice(send: true)
        }
        DispatchQueue.global(qos: .utility).async { ChatMedia.sweepOld() }
        #if targetEnvironment(simulator)
        if messenger == nil { demo() }
        #endif
    }

    /// Removes recordings and exports an interrupted app left behind a day ago or earlier.
    private static func sweepOld() {
        let manager = FileManager.default
        let names = (try? manager.contentsOfDirectory(atPath: manager.temporaryDirectory.path)) ?? []
        for name in names where name.hasPrefix("invizent-video-") || name.hasPrefix("invizent-voice-") {
            let file = manager.temporaryDirectory.appendingPathComponent(name)
            let made = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date.distantPast
            if Date().timeIntervalSince(made) > 86400 { try? manager.removeItem(at: file) }
        }
    }

    /// Places the record button and the strip (after the screen placed the composer). The microphone stands in
    /// the send button's place while there is nothing to send.
    func place(composerFrame: CGRect, in view: UIView) {
        guard let composer, let field, let sendButton else { return }
        let empty = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        var canRecord = messenger != nil
        #if targetEnvironment(simulator)
        canRecord = true
        #endif
        let microphone = canRecord && empty && !(actions?.wantsSendButton ?? false)
        if control.isBusy {
            sendButton.isHidden = true
        } else {
            control.setVisible(microphone)
            sendButton.isHidden = microphone
        }
        control.place(composerBounds: composer.bounds, composerFrame: composerFrame)
        composer.bringSubviewToFront(control.button)
        if !toast.isHidden { placeToast(in: view) }
    }

    private func placeToast(in view: UIView) {
        let width = view.bounds.width - 24
        let size = toast.sizeThatFits(CGSize(width: width - 28, height: 200))
        let wide = min(width, ceil(size.width) + 28)
        toast.frame = CGRect(x: (view.bounds.width - wide) / 2, y: view.safeAreaInsets.top + 64, width: wide, height: ceil(size.height) + 20)
    }

    private func say(_ words: String) {
        guard let view = host?.view else { return }
        toast.text = words
        toast.isHidden = false
        view.bringSubviewToFront(toast)
        placeToast(in: view)
        toastHide?.cancel()
        let hide = DispatchWorkItem { [weak self] in self?.toast.isHidden = true }
        toastHide = hide
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.6, execute: hide)
    }

    private func relayout() {
        host?.view.setNeedsLayout()
    }

    /// The chat is on screen: round videos in view start their silent loop.
    func appeared() {
        watch?.invalidate()
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.notes?.refresh() }
        RunLoop.main.add(timer, forMode: .common)
        watch = timer
    }

    /// The chat is left: whatever plays stops, a take in progress is called off, the decrypted copies go.
    func left() {
        watch?.invalidate()
        watch = nil
        if recorder.isRecording {
            _ = recorder.finish(keep: false)
            control.reset()
        }
        voice.left()
        notes?.left()
    }

    // MARK: Recording a voice message

    private func modeChanged(_ mode: RecordControl.Mode) {
        // As the reference: the hint stands right in the field for a moment.
        field?.hintWords = mode == .video ? "Видео — удерживайте. Звук — нажмите." : "Звук — удерживайте. Видео — нажмите."
        hintBack?.cancel()
        let back = DispatchWorkItem { [weak self] in self?.field?.hintWords = "Сообщение" }
        hintBack = back
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2, execute: back)
    }

    private func startVoice() -> Bool {
        guard messenger != nil else { return false }
        switch VoiceRecorder.allowed {
        case .none:
            // The system asks once; the finger has left the button by then, so the person holds it again.
            VoiceRecorder.ask { [weak self] (granted: Bool) -> Void in
                if !granted { self?.say(VoiceRecorder.noAccess) }
            }
            return false
        case .some(false):
            say(VoiceRecorder.noAccess)
            return false
        case .some(true):
            break
        }
        voice.pause()
        notes?.rest()
        if MusicPlayer.shared.current != nil { MusicPlayer.shared.stop() }
        host?.view.endEditing(true)
        if let failure = recorder.start() {
            say(failure.words)
            return false
        }
        return true
    }

    private func finishVoice(send: Bool) {
        relayout()
        guard let take = recorder.finish(keep: send) else { return }
        if take.durationMs < 500 {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            try? FileManager.default.removeItem(at: take.file)
            say("Слишком короткое голосовое — держи запись хотя бы секунду.")
            return
        }
        if take.broken {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            try? FileManager.default.removeItem(at: take.file)
            say("Микрофон записал тишину — голосовое не отправлено. Запиши ещё раз.")
            return
        }
        if take.silent { say("Микрофон записал тишину. Если в голосовом нет звука — запиши ещё раз.") }
        let now = Date().timeIntervalSince1970 * 1000
        guard let name = FileCore.call("voiceName", [now.rounded(.down)]) as? String else { return }
        var media: [String: Any] = ["durationMs": take.durationMs]
        if let waveform = take.waveform { media["waveform"] = waveform }
        let item = Outgoing(kind: "voice")
        item.wave = take.waveform ?? ""
        item.mediaTime = FileCore.call("voiceTime", [take.durationMs]) as? String ?? ""
        item.payload = Payload(file: take.file, name: name, mimeType: "audio/mp4", media: media, preview: nil, video: false)
        add(item)
        run(item)
    }

    // MARK: A round video

    private func recordNote() {
        guard messenger != nil, let host else { return }
        voice.pause()
        notes?.rest()
        host.view.endEditing(true)
        let screen = NoteRecorder(startAtOnce: true)
        screen.onDone = { [weak self] (file: URL) -> Void in
            guard let self else {
                try? FileManager.default.removeItem(at: file)
                return
            }
            let item = Outgoing(kind: "note")
            item.source = file
            self.add(item)
            self.run(item)
        }
        host.present(screen, animated: true)
    }

    // MARK: A video from the gallery

    /// The system's picker: it runs outside the app and hands over only what was chosen, so no permission to the
    /// photo library is asked.
    func pickVideo() {
        guard messenger != nil else { return }
        var config = PHPickerConfiguration()
        config.filter = .videos
        config.selectionLimit = 5
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        host?.present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        for result in results {
            let item = Outgoing(kind: "video")
            add(item)
            let provider = result.itemProvider
            guard provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) else {
                fail(item, VideoPrepare.failed)
                continue
            }
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { [weak self] (url: URL?, _: Error?) -> Void in
                // The system's copy exists only during this call: it is copied into the app's own temporary area.
                var copy: URL?
                if let url {
                    let ending = url.pathExtension.isEmpty ? "mov" : url.pathExtension
                    let target = VideoPrepare.freshFile(ending)
                    if (try? FileManager.default.copyItem(at: url, to: target)) != nil { copy = target }
                }
                DispatchQueue.main.async {
                    guard let self, !item.removed, let copy else {
                        if let copy { try? FileManager.default.removeItem(at: copy) }
                        if let self, !item.removed { self.fail(item, VideoPrepare.failed) }
                        return
                    }
                    item.source = copy
                    self.run(item)
                }
            }
        }
    }

    // MARK: On the way out

    private func add(_ item: Outgoing) {
        outgoing.append(item)
        onPendingChanged?()
    }

    private func fail(_ item: Outgoing, _ words: String) {
        item.failed = words
        item.small = nil
        item.export = nil
        onPendingChanged?()
    }

    private func remove(_ item: Outgoing, forget: Bool) {
        item.removed = true
        item.small?.cancel()
        item.export?.cancelExport()
        if forget {
            item.big.cancel()
            if let messenger { BigFiles.forget(messenger.server, state: item.big.state) }
            if let file = item.payload?.file { try? FileManager.default.removeItem(at: file) }
            if let source = item.source { try? FileManager.default.removeItem(at: source) }
        }
        outgoing.removeAll { $0 === item }
        onPendingChanged?()
    }

    /// Gets the item ready when it is not yet (a video is written anew without its metadata), then seals,
    /// uploads and sends it. From the main queue; also «Повторить отправку».
    private func run(_ item: Outgoing) {
        guard let messenger, !item.removed else { return }
        item.failed = nil
        if item.payload == nil {
            guard let source = item.source else { return fail(item, VideoPrepare.failed) }
            item.note = "Обработка…"
            onPendingChanged?()
            let note = item.kind == "note"
            VideoPrepare.prepare(source: source, small: note, started: { (export: AVAssetExportSession) -> Void in item.export = export }, done: { [weak self] (result: Result<VideoPrepare.Prepared, FileCore.Failure>) -> Void in
                let now = Date().timeIntervalSince1970 * 1000
                let noteName = FileCore.call("noteName", [now.rounded(.down)]) as? String ?? "video.mp4"
                DispatchQueue.main.async {
                    item.export = nil
                    guard let self, !item.removed else {
                        if case .success(let prepared) = result { try? FileManager.default.removeItem(at: prepared.file) }
                        return
                    }
                    switch result {
                    case .failure(let failure): self.fail(item, failure.words)
                    case .success(let prepared):
                        // The copy that was written anew is what leaves; the original copy is not kept.
                        try? FileManager.default.removeItem(at: source)
                        item.source = nil
                        item.payload = Payload(file: prepared.file, name: note ? noteName : "video.mp4", mimeType: "video/mp4", media: prepared.media, preview: prepared.preview, video: true)
                        item.mediaTime = FileCore.call("voiceTime", [prepared.durationMs]) as? String ?? ""
                        if let preview = prepared.preview, let picture = preview["base64"] as? String,
                           let width = (preview["width"] as? NSNumber)?.doubleValue, let height = (preview["height"] as? NSNumber)?.doubleValue, height > 0 {
                            item.thumb = picture
                            item.wide = note ? 1 : width / height
                        }
                        self.run(item)
                    }
                }
            })
            return
        }
        guard let payload = item.payload else { return }
        let size = (try? payload.file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        let whole = FileCore.sizeText(size)
        item.percent = -1
        item.note = whole
        onPendingChanged?()
        let report: (Int, Int) -> Void = { [weak self, weak item] (sent: Int, total: Int) -> Void in
            let percent = total > 0 ? sent * 100 / total : 0
            DispatchQueue.main.async {
                guard let self, let item, !item.removed, item.failed == nil, percent != item.percent else { return }
                item.percent = percent
                item.note = FileCore.sizeText(size / 100 * percent) + " из " + whole
                self.onPendingChanged?()
            }
        }
        let transfer = FileTransfer()
        transfer.onProgress = report
        item.small = transfer
        let (chatId, peerId) = (self.chatId, self.peerId)
        // The upload and the message do not depend on this screen: a take sent just before the chat is left
        // still goes out. Only the row's looks do.
        work.async { [weak self] in
            let failed: (String) -> Void = { (words: String) -> Void in
                DispatchQueue.main.async {
                    guard !item.removed else { return }
                    if let self { self.fail(item, words) }
                }
            }
            var id = ""
            var encryption: [String: Any] = [:]
            if size <= 0 { return failed("Не удалось прочитать файл.") }
            if size <= ChatMedia.smallLimit {
                guard let bytes = try? Data(contentsOf: payload.file), bytes.count == size else { return failed("Не удалось прочитать файл.") }
                // A new key, nonce and key id for every attempt: the same key never seals two uploads.
                guard let fresh = FileCore.call("newEncryption") as? [String: Any] else { return failed("Шифрование ещё не готово. Попробуй ещё раз.") }
                let sealed: Data
                switch FileCore.seal(bytes, encryption: fresh) {
                case .success(let data): sealed = data
                case .failure(let failure): return failed(failure.words)
                }
                switch messenger.server.uploadSealedFile(sealed, transfer: transfer) {
                case .success(let made): id = made
                case .failure(.words(let words)): return failed(words)
                case .failure(.proof): return failed("Не удалось подтвердить устройство. Попробуй ещё раз.")
                case .failure(.cancelled): return
                }
                encryption = fresh
            } else {
                switch BigFiles.upload(messenger.server, file: payload.file, video: payload.video, transfer: item.big, progress: report) {
                case .failure(let failure):
                    if item.big.isCancelled { return }
                    return failed(failure.words)
                case .success(let done):
                    id = done.id
                    encryption = done.encryption
                }
            }
            let parts: [Any] = [id, payload.name, payload.mimeType, size, encryption, payload.media, payload.preview ?? NSNull()]
            guard let attachment = FileCore.call("attachment", parts) as? [String: Any] else { return failed("Не удалось отправить файл.") }
            DispatchQueue.main.async {
                guard !item.removed else { return }
                messenger.send(chatId: chatId, peerId: peerId, text: "", attachment: attachment) { (result: Result<Void, CryptoFailure>) -> Void in
                    // Without an answer the message stays among the unsent ones and goes out by itself later,
                    // with this very attachment: the row has done its part either way.
                    if case .failure(let failure) = result, failure.name != "NetworkError" {
                        if let self { self.fail(item, failure.message) }
                        return
                    }
                    try? FileManager.default.removeItem(at: payload.file)
                    item.payload = nil
                    if let self { self.remove(item, forget: false) }
                    NotificationCenter.default.post(name: Messenger.changed, object: chatId)
                }
            }
        }
    }

    /// The rows of what is on its way out, to stand after the chat's own.
    var pendingRows: [[String: Any]] {
        outgoing.map { (item: Outgoing) -> [String: Any] in
            var label = item.note
            if let failed = item.failed { label = "Не отправлено · повторить\n" + failed }
            var row: [String: Any] = ["key": item.key, "kind": 0, "mine": true, "text": "", "time": item.time, "ticks": item.failed == nil ? 3 : 4, "tail": true,
                                      "label": label, "media": item.kind, "wave": item.wave, "mediaTime": item.mediaTime, "thumbWide": item.wide]
            if !item.thumb.isEmpty { row["thumb"] = item.thumb }
            if item.kind == "note" { row["thumbRound"] = true }
            return row
        }
    }

    /// The chat's rows were read: gives the rows to add after them.
    func loaded(_ rows: [[String: Any]]) -> [[String: Any]] {
        pendingRows + sampleRows
    }

    // MARK: Touches

    /// A row was touched. True: it was one of this object's (an unsent one, a voice message, a video, a round
    /// video, a big file).
    private func pressed(_ key: String) -> Bool {
        if let item = outgoing.first(where: { $0.key == key }) {
            guard item.failed != nil, let host else { return true }
            let sheet = UIAlertController(title: nil, message: item.failed, preferredStyle: .actionSheet)
            sheet.addAction(UIAlertAction(title: "Повторить отправку", style: .default, handler: { [weak self] _ in self?.run(item) }))
            sheet.addAction(UIAlertAction(title: "Удалить", style: .destructive, handler: { [weak self] _ in self?.remove(item, forget: true) }))
            sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
            sheet.popoverPresentationController?.sourceView = host.view
            host.present(sheet, animated: true)
            return true
        }
        guard let attachment = AttachmentStore.shared.attachment(key) else { return false }
        switch MediaRows.kind(attachment) {
        case "voice":
            voice.toggle(key: key, attachment: attachment)
            return true
        case "note":
            notes?.toggle(key: key, attachment: attachment)
            return true
        case "video":
            open(attachment, video: true)
            return true
        default:
            // A big file of any other kind: brought chunk by chunk and shown by the system's preview.
            guard ChunkCore.isChunked(attachment) else { return false }
            open(attachment, video: false)
            return true
        }
    }

    private func open(_ attachment: [String: Any], video: Bool) {
        guard let host, let messenger else { return }
        host.view.endEditing(true)
        voice.pause()
        notes?.quiet()
        host.present(MediaOpenController(server: messenger.server, attachment: attachment, video: video, presenter: host), animated: true)
    }

    /// A part of a media row was touched: the play button, the waveform, the speed, the picture.
    private func partPressed(_ key: String, part: String, fraction: CGFloat) {
        if part == "rate" {
            say(voice.cycleRate())
            return
        }
        if part == "wave", voice.seek(key: key, fraction: fraction) { return }
        _ = pressed(key)
    }

    // MARK: The simulator check

    #if targetEnvironment(simulator)
    private static func demoWave(_ seed: Int) -> String {
        let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")
        var out = ""
        for index in 0..<100 {
            let swell = sin(Double(index + seed) / 7) * 0.5 + 0.5
            let ripple = sin(Double(index * (3 + seed % 4)) / 2.3) * 0.5 + 0.5
            out.append(letters[min(31, max(0, Int((swell * 0.65 + ripple * 0.35) * 31)))])
        }
        return out
    }

    /// `-voicedemo 1`: an incoming and an outgoing voice row, the first playing at 0:07 of 0:23 at 1,5×.
    /// `-voicedemo recording`: the strip of a take being recorded. `-videodemo 1`: a video row and a round one.
    private func demo() {
        let defaults = UserDefaults.standard
        if let wanted = defaults.string(forKey: "voicedemo") {
            let voices: [[String: Any]] = [
                ["key": "sample-voice-1", "kind": 0, "mine": false, "text": "", "time": "09:42", "tail": true, "media": "voice", "wave": ChatMedia.demoWave(3), "mediaTime": "0:23"],
                ["key": "sample-voice-2", "kind": 0, "mine": true, "text": "", "time": "09:43", "ticks": 2, "tail": true, "media": "voice", "wave": ChatMedia.demoWave(11), "mediaTime": "1:05"],
            ]
            sampleRows += voices
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                var state = MsgMediaState()
                state.key = "sample-voice-1"
                state.playing = true
                state.progress = 7.0 / 23.0
                state.time = "0:07 / 0:23"
                state.rate = "1,5×"
                self?.list?.setMediaState(state)
            }
            if wanted == "recording" {
                control.timeWords = { () -> String in "0:04,63" }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                    self?.control.demoHolding()
                    self?.relayout()
                }
            }
        }
        if defaults.string(forKey: "videodemo") != nil {
            let wide = ChatAttachments.demoPicture(width: 240, height: 135).jpegData(compressionQuality: 0.6)?.base64EncodedString() ?? ""
            let square = ChatAttachments.demoPicture(width: 212, height: 212).jpegData(compressionQuality: 0.6)?.base64EncodedString() ?? ""
            let videos: [[String: Any]] = [
                ["key": "sample-video-1", "kind": 0, "mine": false, "text": "", "time": "09:44", "tail": true, "media": "video", "thumb": wide, "thumbWide": 16.0 / 9.0, "mediaTime": "0:42"],
                ["key": "sample-video-2", "kind": 0, "mine": true, "text": "", "time": "09:45", "ticks": 1, "tail": true, "media": "note", "thumb": square, "thumbWide": 1.0, "thumbRound": true, "mediaTime": "0:12"],
            ]
            sampleRows += videos
        }
    }
    #endif
}
