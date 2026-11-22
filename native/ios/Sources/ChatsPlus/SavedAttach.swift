import AVFoundation
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// ChatsPlus: what can be added to «Избранное» besides words (saved/SavedScreen.tsx): a photo or a file through the
/// paperclip, a voice note held on the microphone, a round video (a tap on the microphone switches to the camera,
/// as in a chat). The same pieces as a chat's composer: the photo is cleaned of its metadata (PhotoPrepare), the
/// voice is recorded by VoiceRecorder under RecordControl, the round video by NoteRecorder and written anew by
/// VideoPrepare. Each file is sealed under a key of its own and uploaded (end-to-end encrypted, as in a chat); only
/// the attachment's description goes into the note, kept in the device's encrypted storage. Main queue only.
final class SavedAttach: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate {
    private static let maxFile = 20 * 1024 * 1024
    private let messenger: Messenger?
    private let saved: SavedMessages
    private weak var host: UIViewController?
    /// Record: the record button, its takes, the preview and the round camera (Sources/Voice/MediaRecording.swift).
    private let recording = MediaRecording()
    var control: RecordControl { recording.control }
    private let work = DispatchQueue(label: "invizent.saved.attach", qos: .userInitiated)
    /// Words for the person (a notice over the list).
    var say: ((String) -> Void)?
    /// Something is being prepared or uploaded: the composer waits.
    private(set) var busy = false {
        didSet { onBusy?(busy) }
    }
    var onBusy: ((Bool) -> Void)?

    init(messenger: Messenger?, saved: SavedMessages) {
        self.messenger = messenger
        self.saved = saved
        super.init()
    }

    func install(host: UIViewController, composer: UIView) {
        self.host = host
        recording.install(composer: composer, host: host.view)
        recording.brokenWords = "Микрофон записал тишину — голосовое не сохранено. Запиши ещё раз."
        recording.canStart = { [weak self] (mode: RecordControl.Mode) -> String? in
            guard let self else { return "" }
            if self.messenger == nil { return mode == .voice ? "Голосовые в Избранном доступны в приложении." : "Видео в Избранном доступны в приложении." }
            return nil
        }
        recording.willStart = { [weak self] in self?.host?.view.endEditing(true) }
        recording.say = { [weak self] (words: String) -> Void in self?.say?(words) }
        recording.sendVoice = { [weak self] (file: URL, ms: Int, waveform: String?) -> Void in self?.saveVoice(file: file, durationMs: ms, waveform: waveform) }
        recording.sendNote = { [weak self] (file: URL) -> Void in self?.saveNote(file) }
        control.onPhase = { [weak host] (_: RecordControl.Phase) -> Void in
            guard let view = host?.view else { return }
            view.setNeedsLayout()
            RecordSpec.animateLayout { view.layoutIfNeeded() }
        }
    }

    /// The screen is left: a take is called off, a preview thrown away.
    func left() {
        recording.left()
    }

    /// The composer's place changed.
    func layoutRecording() {
        recording.layout()
    }

    /// Whether a take is running (the composer's own controls give way).
    var isRecording: Bool { recording.isRecording }

    // MARK: The paperclip

    func openMenu() {
        guard let host, host.presentedViewController == nil else { return }
        guard messenger != nil else { say?("Файлы в Избранном доступны в приложении."); return }
        let choices: [ChoiceSheet.Choice] = [
            ChoiceSheet.Choice(symbol: "photo", label: "Фото", run: { [weak self] in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self?.pickPhoto() }
            }),
            ChoiceSheet.Choice(symbol: "doc", label: "Файл", run: { [weak self] in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self?.pickFile() }
            }),
        ]
        host.present(ChoiceSheet(heading: "Добавить в Избранное", choices: choices), animated: true)
    }

    /// The system's picker: it runs outside the app and hands over only what was chosen (no photo library permission).
    private func pickPhoto() {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        host?.present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider, provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else { return }
        busy = true
        provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] (url: URL?, _: Error?) -> Void in
            // The file lives only during this call: it is read here, on the provider's queue.
            var prepared: Result<(bytes: Data, name: String, mime: String, media: [String: Any]?, preview: [String: Any]?), PhotoPrepare.Failure> = .failure(PhotoPrepare.Failure(words: "Не удалось обработать фото. Файл не отправлен."))
            if let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                switch PhotoPrepare.prepare(source, fileSize: size) {
                case .success(let photo):
                    prepared = .success((bytes: photo.bytes, name: photo.name, mime: photo.mimeType, media: ["width": photo.width, "height": photo.height, "hdr": "sdr"], preview: photo.preview))
                case .failure(let failure):
                    prepared = .failure(failure)
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                switch prepared {
                case .failure(let failure): self.done(failure.words)
                case .success(let made): self.upload(bytes: made.bytes, name: made.name, mime: made.mime, media: made.media, preview: made.preview)
                }
            }
        }
    }

    private func pickFile() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.item], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        host?.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        busy = true
        work.async { [weak self] in
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            var words = ""
            var bytes = Data()
            var media: [String: Any]?
            var preview: [String: Any]?
            var name = url.lastPathComponent
            var mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            if size <= 0 {
                words = "Не удалось прочитать файл."
            } else if let source = CGImageSourceCreateWithURL(url as CFURL, nil), PhotoPrepare.isPicture(source) {
                // A picture is prepared as a photo whatever its name says (nothing of the original file is kept).
                switch PhotoPrepare.prepare(source, fileSize: size) {
                case .success(let photo):
                    bytes = photo.bytes
                    name = photo.name
                    mime = photo.mimeType
                    media = ["width": photo.width, "height": photo.height, "hdr": "sdr"]
                    preview = photo.preview
                case .failure(let failure): words = failure.words
                }
            } else if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .movie) || type.conforms(to: .video) {
                // A video cannot be cleaned of its metadata here: it is not sent, as in a chat's «Файлы».
                words = "Видео пока нельзя отправить в этой версии приложения."
            } else if size > SavedAttach.maxFile {
                words = "Файл слишком большой. Максимум — 20 МБ."
            } else if let read = try? Data(contentsOf: url), !read.isEmpty, read.count <= SavedAttach.maxFile {
                bytes = read
            } else {
                words = "Не удалось прочитать файл."
            }
            try? FileManager.default.removeItem(at: url)
            DispatchQueue.main.async {
                guard let self else { return }
                if !words.isEmpty { self.done(words); return }
                self.upload(bytes: bytes, name: name, mime: mime, media: media, preview: preview)
            }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {}

    // MARK: A voice note

    private func saveVoice(file: URL, durationMs: Int, waveform: String?) {
        let now = Date().timeIntervalSince1970 * 1000
        let name = FileCore.call("voiceName", [now.rounded(.down)]) as? String ?? "voice.m4a"
        var media: [String: Any] = ["durationMs": durationMs]
        if let waveform { media["waveform"] = waveform }
        busy = true
        work.async { [weak self] in
            let bytes = try? Data(contentsOf: file)
            try? FileManager.default.removeItem(at: file)
            DispatchQueue.main.async {
                guard let self else { return }
                guard let bytes, !bytes.isEmpty, bytes.count <= SavedAttach.maxFile else { self.done("Не удалось прочитать файл."); return }
                self.upload(bytes: bytes, name: name, mime: "audio/mp4", media: media, preview: nil)
            }
        }
    }

    // MARK: A round video

    private func saveNote(_ file: URL) {
        busy = true
        VideoPrepare.prepare(source: file, small: true, started: { (_: AVAssetExportSession) -> Void in }, done: { [weak self] (result: Result<VideoPrepare.Prepared, FileCore.Failure>) -> Void in
            try? FileManager.default.removeItem(at: file)
            let now = Date().timeIntervalSince1970 * 1000
            let noteName = FileCore.call("noteName", [now.rounded(.down)]) as? String ?? "video.mp4"
            var bytes: Data?
            var media: [String: Any] = [:]
            var preview: [String: Any]?
            var words = ""
            switch result {
            case .failure(let failure): words = failure.words
            case .success(let prepared):
                bytes = try? Data(contentsOf: prepared.file)
                try? FileManager.default.removeItem(at: prepared.file)
                media = prepared.media
                preview = prepared.preview
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if !words.isEmpty { self.done(words); return }
                guard let bytes, !bytes.isEmpty, bytes.count <= SavedAttach.maxFile else { self.done("Не удалось обработать видео. Файл не отправлен."); return }
                self.upload(bytes: bytes, name: noteName, mime: "video/mp4", media: media, preview: preview)
            }
        })
    }

    // MARK: Sealed, uploaded, kept

    /// Seals the bytes under a fresh key, uploads them as this session and keeps the attachment as a note.
    private func upload(bytes: Data, name: String, mime: String, media: [String: Any]?, preview: [String: Any]?) {
        guard let messenger else { done(""); return }
        busy = true
        say?("Сохраняем в Избранное…")
        let transfer = FileTransfer()
        work.async { [weak self] in
            let failed: (String) -> Void = { (words: String) -> Void in DispatchQueue.main.async { self?.done(words) } }
            // A new key, nonce and key id for every upload: the same key never seals two files.
            guard let encryption = FileCore.call("newEncryption") as? [String: Any] else { return failed("Шифрование ещё не готово. Попробуй ещё раз.") }
            let sealed: Data
            switch FileCore.seal(bytes, encryption: encryption) {
            case .success(let data): sealed = data
            case .failure(let failure): return failed(failure.words)
            }
            let id: String
            switch messenger.server.uploadSealedFile(sealed, transfer: transfer) {
            case .success(let made): id = made
            case .failure(.words(let words)): return failed(words)
            case .failure(.proof): return failed("Не удалось подтвердить устройство. Попробуй ещё раз.")
            case .failure(.cancelled): return failed("")
            }
            let parts: [Any] = [id, name, mime, bytes.count, encryption, media ?? NSNull(), preview ?? NSNull()]
            guard let attachment = FileCore.call("attachment", parts) as? [String: Any] else { return failed("Не удалось сохранить файл.") }
            DispatchQueue.main.async {
                guard let self else { return }
                self.saved.save(text: "", attachment: attachment) { [weak self] (result: Result<Bool, SavedMessages.Failure>) -> Void in
                    switch result {
                    case .failure(let failure): self?.done(failure.words)
                    case .success: self?.done("")
                    }
                }
            }
        }
    }

    private func done(_ words: String) {
        busy = false
        if !words.isEmpty { say?(words) }
    }
}
