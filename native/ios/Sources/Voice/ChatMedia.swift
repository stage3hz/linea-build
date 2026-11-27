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
        // MediaBubble.tsx: a video's label is «0:42 · 12 МБ» (its length, then its size until it is here).
        if kind == "video" {
            let ms = (media["durationMs"] as? NSNumber)?.doubleValue ?? 0
            let clock = FileCore.call("voiceTime", [max(0, ms)]) as? String ?? "0:00"
            fields["mediaTime"] = clock + " · " + FileCore.sizeText((attachment["size"] as? NSNumber)?.intValue ?? 0)
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
        /// What goes with the message inside the ciphertext: the answer it is, or nil.
        var meta: [String: Any]?
        /// «отправляет голосовое / видеосообщение / видео», said while it is on its way (Sources/Net/ActivitySend.swift).
        var activity: ActivitySend.Token?

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
    private weak var attachments: ChatAttachments?
    /// Record: the row of the voice message just sent (the blob flies to it).
    private var flightKey: String?
    private let messenger: Messenger?
    private let chatId: String
    private let peerId: String
    /// Record: the record button, its takes, the preview and the round camera (Sources/Voice/MediaRecording.swift).
    private let recording = MediaRecording()
    private var control: RecordControl { recording.control }
    private lazy var voice = VoicePlayer(server: messenger?.server)
    private var notes: NotePlayback?
    private var outgoing: [Outgoing] = []
    private let work = DispatchQueue(label: "invizent.media", qos: .userInitiated)
    private let toast = UILabel()
    private var toastHide: DispatchWorkItem?
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
        self.attachments = attachments
        sendButton = send
        recording.install(composer: composer, host: host.view)
        control.clipView = attachments.clipButton
        control.clipSlides = true
        if let emoji = actions.extras.emojiView { control.fieldViews = [field, emoji] } else { control.fieldViews = [field] }
        notes = NotePlayback(server: messenger?.server, list: list)

        toast.font = .systemFont(ofSize: 14)
        toast.textColor = Theme.onBlack(.white, otherwise: Theme.text)
        toast.textAlignment = .center
        toast.numberOfLines = 0
        toast.backgroundColor = Theme.panel(UIColor(red: 20 / 255, green: 24 / 255, blue: 36 / 255, alpha: 0.92))
        toast.layer.cornerRadius = 14
        toast.layer.masksToBounds = true
        toast.isHidden = true
        toast.isUserInteractionEnabled = false
        host.view.addSubview(toast)

        // A touch on a row: an unsent one offers to try again; a voice message, a video or a round video plays;
        // a big file of any kind opens.
        attachments.mediaPressed = { [weak self] (key: String) -> Bool in self?.pressed(key) ?? false }
        attachments.onVideo = { [weak self] in self?.pickVideo() }
        attachments.onVideoFile = { [weak self] (url: URL) -> Bool in self?.takeVideoFile(url) ?? false }
        attachments.takeReply = { [weak self] () -> [String: Any]? in self?.actions?.takeReply() }
        list.onMediaPress = { [weak self] (event: [String: Any]) -> Void in
            self?.partPressed(event["key"] as? String ?? "", part: event["part"] as? String ?? "", fraction: CGFloat((event["fraction"] as? NSNumber)?.doubleValue ?? 0))
        }

        voice.onState = { [weak self] (state: MsgMediaState?) -> Void in self?.list?.setMediaState(state) }
        voice.onProblem = { [weak self] (words: String) -> Void in self?.say(words) }
        voice.onWillPlay = { [weak self] in self?.notes?.quiet() }
        notes?.onState = { [weak self] (state: MsgMediaState?) -> Void in self?.list?.setMediaState(state) }
        notes?.onProblem = { [weak self] (words: String) -> Void in self?.say(words) }
        // A circle brought or dropped: its row is drawn again (the download mark, the speaker-off mark).
        notes?.onReadyChanged = { (key: String) -> Void in NotificationCenter.default.post(name: InlineMedia.changed, object: key) }
        // VideoNote.tsx: a circle listened to grows to min(404, the row) and gives the room back afterwards.
        notes?.onExpanded = { [weak list] (key: String, open: Bool) -> Void in list?.setExpandedNote(open ? key : "") }
        notes?.anchorsRight = { [weak list] (key: String) -> Bool in list?.isMine(key) ?? true }
        notes?.onWillPlay = { [weak self] in self?.voice.pause() }
        notes?.holdsSilence = { [weak self] () -> Bool in
            guard let self else { return true }
            // Also while something stands over the chat (the round video recorder uses the microphone).
            return self.recording.isRecording || self.voice.isPlaying || self.host?.presentedViewController != nil
        }

        recording.canStart = { [weak self] (_: RecordControl.Mode) -> String? in
            guard let self else { return "" }
            return self.messenger == nil ? "" : nil
        }
        recording.willStart = { [weak self] in
            guard let self else { return }
            self.voice.pause()
            self.notes?.rest()
            self.host?.view.endEditing(true)
        }
        recording.say = { [weak self] (words: String) -> Void in self?.say(words) }
        recording.sendVoice = { [weak self] (file: URL, ms: Int, waveform: String?) -> Void in self?.sendVoice(file: file, durationMs: ms, waveform: waveform) }
        recording.sendNote = { [weak self] (file: URL) -> Void in self?.sendNote(file) }
        // The composer lays itself out again in one of its 0.4 s transitions when a take starts, locks or stops.
        // Record: the blob of a sent take flies to the new message's play button.
        control.sentTarget = { [weak self] () -> CGRect? in
            guard let self, let key = self.flightKey, let view = self.host?.view, let found = self.list?.mediaPlayHost(key) else { return nil }
            self.flightKey = nil
            return found.view.convert(found.frame, to: view)
        }
        control.onPhase = { [weak self] (phase: RecordControl.Phase) -> Void in
            self?.recordingSaid(phase)
            guard let view = self?.host?.view else { return }
            view.setNeedsLayout()
            RecordSpec.animateLayout { view.layoutIfNeeded() }
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

    /// Record: a take is on screen (the composer's pills make room for it) / its preview waits.
    var recordingTake: Bool { control.phase == .holding || control.phase == .locked }
    var recordingPreview: Bool { control.phase == .preview }

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
        // Record: while a take runs the paperclip slides off to the left and the field's pill takes its place
        // (from the composer's edge to the button's gap); the preview has the usual pill, the trash in the
        // paperclip's place.
        let width = composer.bounds.width, height = composer.bounds.height
        let side = ComposerPills.side
        let takeShown = control.phase == .holding || control.phase == .locked
        let pill = takeShown ? CGRect(x: 0, y: 0, width: width - side - ComposerPills.gap, height: height) : ComposerPills.fieldPill(width: width, height: height)
        if takeShown, let clip = attachments?.clipButton {
            clip.frame = CGRect(x: -side - ComposerPills.gap - 6, y: height - side, width: side, height: side)
        }
        control.place(button: CGRect(x: width - side, y: height - side, width: side, height: side), field: pill, trash: CGRect(x: 0, y: height - side, width: side, height: side))
        composer.bringSubviewToFront(control.button)
        recording.layout()
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
        recording.left()
        voice.left()
        notes?.left()
    }

    // MARK: Recording a voice message

    /// Record: a voice message to send (a take, or a stopped take joined and trimmed): sealed and uploaded as
    /// any other attachment.
    private func sendVoice(file: URL, durationMs: Int, waveform: String?) {
        relayout()
        let now = Date().timeIntervalSince1970 * 1000
        guard let name = FileCore.call("voiceName", [now.rounded(.down)]) as? String else {
            try? FileManager.default.removeItem(at: file)
            return
        }
        var media: [String: Any] = ["durationMs": durationMs]
        if let waveform { media["waveform"] = waveform }
        let item = Outgoing(kind: "voice")
        flightKey = item.key
        item.meta = actions?.takeReply()
        item.wave = waveform ?? ""
        item.mediaTime = FileCore.call("voiceTime", [durationMs]) as? String ?? ""
        item.payload = Payload(file: file, name: name, mimeType: "audio/mp4", media: media, preview: nil, video: false)
        add(item)
        run(item)
    }

    /// Record: a recorded round video to send (written anew without metadata on the way).
    private func sendNote(_ file: URL) {
        guard messenger != nil else {
            try? FileManager.default.removeItem(at: file)
            return
        }
        let item = Outgoing(kind: "note")
        item.meta = actions?.takeReply()
        item.source = file
        add(item)
        run(item)
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
            item.meta = actions?.takeReply()
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

    /// A video chosen in «Файл» (the picker's copy, which becomes this item's): it is written anew without its
    /// metadata, as one from the gallery. False: there is no account to send it with.
    func takeVideoFile(_ url: URL) -> Bool {
        guard messenger != nil else { return false }
        let item = Outgoing(kind: "video")
        item.meta = actions?.takeReply()
        item.source = url
        add(item)
        run(item)
        return true
    }

    // MARK: On the way out

    /// «записывает голосовое» / «записывает видеосообщение» while a take is recorded (held or locked); its end —
    /// sent, called off, stopped for the preview — tells the other side.
    private var recordingToken: ActivitySend.Token?
    private func recordingSaid(_ phase: RecordControl.Phase) {
        let recording = phase == .holding || phase == .locked
        let kind = control.mode == .video ? "round" : "voice"
        if recording, let token = recordingToken, !token.ended, token.kind == kind { return }
        recordingToken?.end()
        recordingToken = recording ? messenger?.live.activity.begin(chatId: chatId, kind: kind) : nil
    }

    /// The item is being made ready or uploaded: the other side hears of it until it is sent, fails or is called off.
    private func sendingSaid(_ item: Outgoing) {
        if let token = item.activity, !token.ended { return }
        let kind = item.kind == "voice" ? "voice-upload" : item.kind == "note" ? "round-upload" : "video"
        item.activity = messenger?.live.activity.begin(chatId: chatId, kind: kind)
    }

    private func sendingDone(_ item: Outgoing) {
        item.activity?.end()
        item.activity = nil
    }

    private func add(_ item: Outgoing) {
        outgoing.append(item)
        onPendingChanged?()
    }

    private func fail(_ item: Outgoing, _ words: String) {
        sendingDone(item)
        item.failed = words
        item.small = nil
        InlineMedia.shared.forgetSending(item.key)
        item.export = nil
        onPendingChanged?()
    }

    private func remove(_ item: Outgoing, forget: Bool) {
        sendingDone(item)
        item.removed = true
        item.small?.cancel()
        InlineMedia.shared.forgetSending(item.key)
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
        sendingSaid(item)
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
        // A video on its way: the reference's upload bubble — the ring with ✕ over its picture and sent / total.
        let ringed = item.kind == "video"
        if ringed { InlineMedia.shared.showSending(item.key, progress: 0, words: "Шифрование · " + whole) }
        onPendingChanged?()
        let report: (Int, Int) -> Void = { [weak self, weak item] (sent: Int, total: Int) -> Void in
            let percent = total > 0 ? sent * 100 / total : 0
            DispatchQueue.main.async {
                guard let self, let item, !item.removed, item.failed == nil, percent != item.percent else { return }
                item.percent = percent
                item.activity?.progress(percent)
                item.note = FileCore.sizeText(size / 100 * percent) + " из " + whole
                if ringed { InlineMedia.shared.showSending(item.key, progress: CGFloat(percent) / 100, words: FileCore.sizeText(size / 100 * percent) + " / " + whole) }
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
                messenger.send(chatId: chatId, peerId: peerId, text: "", attachment: attachment, meta: item.meta) { (result: Result<Void, CryptoFailure>) -> Void in
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
            if let failed = item.failed { label = "Не отправлено · повторить\n" + failed } else if item.kind == "video" && item.small != nil { label = "" } // the ring's pill says it
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
            // A video on its way: the ✕ on its ring calls the upload off (the reference's «Отменить отправку»).
            if item.failed == nil, item.kind == "video", item.small != nil {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                remove(item, forget: true)
                return true
            }
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
        // The owner: a tap on a voice message only starts or pauses it — a tap on the waveform never seeks.
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
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                    self?.control.demoHolding()
                    self?.relayout()
                }
            }
        }
        // Video: -notedemo 1 opens the round-video recorder through the composer (Voice/MediaRecording.swift).
        if defaults.string(forKey: "notedemo") != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.recording.demoNote()
                self?.relayout()
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
