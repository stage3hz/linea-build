import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Attachments of one chat: the paperclip in the composer, choosing a photo or a file, getting it ready, sealing
/// and uploading it, sending the message — and opening the attachments of the messages on screen.
///
/// A photo comes from the paperclip's own panel (Sources/Attachments/AttachmentPanel.swift): the photo library is
/// asked for only when the panel opens, and the system's picker stays as the way without that permission. Every picture is drawn anew before it leaves (`PhotoPrepare`):
/// what is sent has no EXIF, no place, no camera data and not the original name. A file is sent as it is.
/// The key of a file exists only in memory and inside the encrypted message.
final class ChatAttachments: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate {
    /// What is sealed and sent: the cleaned photo or the file itself, and how the message describes it.
    private struct Prepared {
        let bytes: Data
        let name: String
        let mimeType: String
        let media: [String: Any]?
        let preview: [String: Any]?
    }

    /// An attachment on its way out, shown as a row of the chat until the server has the message.
    private final class Pending {
        let key = "attach-" + UUID().uuidString.lowercased()
        let time = Messenger.clock.string(from: Date())
        var heading: String
        var note = ""
        var thumb = ""
        var wide = 1.0
        var failed: String?
        var prepared: Prepared?
        var transfer: FileTransfer?
        var removed = false
        var percent = -1
        /// What goes with the message inside the ciphertext: the answer it is, or nil.
        var meta: [String: Any]?
        /// Attachments: the upload has begun (the photos of an album start in their order).
        var started = false

        init(heading: String) {
            self.heading = heading
        }
    }

    private weak var host: UIViewController?
    private let messenger: Messenger?
    private let chatId: String
    private let peerId: String
    private let button = UIButton(type: .system)
    private var pending: [Pending] = []
    /// One attachment at a time is prepared, sealed and uploaded.
    private let work = DispatchQueue(label: "invizent.attachments", qos: .userInitiated)
    private let preparing = NSLock()
    private static let maxFile = 20 * 1024 * 1024
    /// Called on the main queue when the rows of outgoing attachments changed.
    var onPendingChanged: (() -> Void)?
    /// Voice/Video (Sources/Voice/ChatMedia.swift): a touched row is offered there first — a voice message, a
    /// video, a round video, a big (chunked) file of any kind or one of its own unsent rows; true: it took it.
    var mediaPressed: ((String) -> Bool)?
    /// Voice/Video: «Видео» of the paperclip's sheet.
    var onVideo: (() -> Void)?
    /// Voice/Video: a video chosen in «Файл» goes the way of «Видео» (written anew without its metadata); the
    /// copy the picker gave is handed over. True: it was taken.
    var onVideoFile: ((URL) -> Bool)?
    /// ChatActions: the answer being written, taken by the first thing sent (see `ChatScreenActions.takeReply`).
    var takeReply: (() -> [String: Any]?)?
    /// Polls: «Опрос» of the paperclip's sheet (Sources/Polls/PollComposer.swift).
    var onPoll: (() -> Void)?

    init(messenger: Messenger?, chatId: String, peerId: String) {
        self.messenger = messenger
        self.chatId = chatId
        self.peerId = peerId
        super.init()
        DispatchQueue.global(qos: .utility).async { DecryptedFiles.sweep() }
    }

    // MARK: The composer

    /// Puts the paperclip into the composer.
    func install(host: UIViewController, composer: UIView) {
        self.host = host
        button.setImage(UIImage(systemName: "paperclip", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .regular)), for: .normal)
        button.tintColor = Theme.text
        button.accessibilityLabel = "Вложения: галерея, файлы, опрос"
        button.addTarget(self, action: #selector(choose), for: .touchUpInside)
        composer.addSubview(button)
    }

    /// Places the paperclip at the composer's leading edge and moves the text field next to it.
    func place(field: UIView, height: CGFloat) {
        // At the composer's lower edge: the field grows upwards with its text (ChatActions).
        button.frame = CGRect(x: 4, y: height - 46, width: 44, height: 44)
        let right = field.frame.maxX
        field.frame = CGRect(x: 50, y: field.frame.minY, width: max(0, right - 50), height: field.frame.height)
    }

    @objc private func choose() {
        guard let host else { return }
        host.view.endEditing(true)
        // Composer: the reference's own panel — «Недавние» from the gallery, the camera, «Файл», «Опрос», «Аудио»
        // (Sources/Attachments/AttachmentPanel.swift). The gallery is read only once the panel is open.
        let panel = AttachmentPanelController(pollAvailable: onPoll != nil)
        panel.onPoll = { [weak self] in self?.onPoll?() }
        panel.onSend = { [weak self] (items: [AttachmentPanelController.Picked]) -> Void in self?.take(items) }
        host.present(panel, animated: false)
    }

    private func pickPhotos() {
        // Without a photo library given, the picker returns only copies of the chosen pictures: no permission.
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 10
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        host?.present(picker, animated: true)
    }

    private func pickFiles() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.item], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = true
        host?.present(picker, animated: true)
    }

    private func say(_ words: String) {
        let alert = UIAlertController(title: nil, message: words, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
        host?.present(alert, animated: true)
    }

    // MARK: What was chosen

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard messenger != nil else { return }
        // Attachments: one photo opens in the editor first — crop, turn, draw, size (Sources/Attachments/PhotoEditor.swift).
        if results.count == 1, let only = results.first, only.itemProvider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            editThenSend(only)
            return
        }
        // Attachments: two or more photos go out as one album — up to ten per album (Sources/Attachments/AlbumGrid.swift).
        let albums = AlbumRows.groups(results.count)
        for (index, result) in results.enumerated() {
            let item = add(Pending(heading: "🖼 Фотография"))
            item.meta = takeReply?()
            if index < albums.count, let album = albums[index] {
                var meta = item.meta ?? [:]
                meta["album"] = ["id": album.id, "index": album.index, "count": album.count]
                item.meta = meta
            }
            let provider = result.itemProvider
            guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else {
                fail(item, "Не удалось обработать фото. Файл не отправлен.")
                continue
            }
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] (url: URL?, _: Error?) -> Void in
                // The file is the system's own temporary copy and exists only during this call: the picture is
                // read and drawn anew right here, one picture at a time.
                guard let self else { return }
                self.preparing.lock()
                let prepared: Result<Prepared, PhotoPrepare.Failure>
                if let url { prepared = self.photo(at: url) } else { prepared = .failure(PhotoPrepare.Failure(words: "Не удалось обработать фото. Файл не отправлен.")) }
                self.preparing.unlock()
                DispatchQueue.main.async { self.ready(item, prepared) }
            }
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard messenger != nil else {
            for url in urls { try? FileManager.default.removeItem(at: url) }
            return
        }
        for url in urls { sendFile(url) }
    }

    /// A file copy in the app's own folder: prepared, sent, and the copy removed.
    private func sendFile(_ url: URL) {
        if ChatAttachments.isVideo(url), let onVideoFile, onVideoFile(url) { return }
        let item = add(Pending(heading: "📎 " + url.lastPathComponent))
        item.meta = takeReply?()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            self.preparing.lock()
            let prepared = self.file(at: url)
            // The picker gave a copy of the file inside the app's own folder; it is not kept.
            try? FileManager.default.removeItem(at: url)
            self.preparing.unlock()
            DispatchQueue.main.async { self.ready(item, prepared) }
        }
    }

    /// Composer: what the panel added — the photos as one album (up to ten per album) in their order, each video
    /// the way of «Видео» (written anew without its metadata), each file as it is.
    private func take(_ items: [AttachmentPanelController.Picked]) {
        guard messenger != nil else {
            for item in items {
                switch item {
                case .video(let url), .file(let url): try? FileManager.default.removeItem(at: url)
                case .photo: break
                }
            }
            return
        }
        var photos: [(Data, String?)] = []
        for item in items {
            switch item {
            case .photo(let data, let format):
                photos.append((data, format))
            case .video(let url):
                if let onVideoFile, onVideoFile(url) { continue }
                try? FileManager.default.removeItem(at: url)
                let failed = add(Pending(heading: "🎬 Видео"))
                fail(failed, "Видео пока нельзя отправить в этой версии приложения.")
            case .file(let url):
                sendFile(url)
            }
        }
        let albums = AlbumRows.groups(photos.count)
        for (index, photo) in photos.enumerated() {
            let item = add(Pending(heading: "🖼 Фотография"))
            item.meta = takeReply?()
            if index < albums.count, let album = albums[index] {
                var meta = item.meta ?? [:]
                meta["album"] = ["id": album.id, "index": album.index, "count": album.count]
                item.meta = meta
            }
            let (bytes, format) = photo
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { return }
                self.preparing.lock()
                let prepared: Result<Prepared, PhotoPrepare.Failure>
                if let source = CGImageSourceCreateWithData(bytes as CFData, nil) {
                    prepared = PhotoPrepare.prepare(source, fileSize: bytes.count, format: format).map { (photo: PhotoPrepare.Prepared) -> Prepared in
                        Prepared(bytes: photo.bytes, name: photo.name, mimeType: photo.mimeType, media: ["width": photo.width, "height": photo.height, "hdr": "sdr"], preview: photo.preview)
                    }
                } else {
                    prepared = .failure(PhotoPrepare.Failure(words: "Не удалось обработать фото. Файл не отправлен."))
                }
                self.preparing.unlock()
                DispatchQueue.main.async { self.ready(item, prepared) }
            }
        }
    }

    /// Attachments: the photo is read once (the system's copy lives only during the call), shown in the editor,
    /// and sent as edited — or as it was, when nothing was changed, with its HDR kept by `PhotoPrepare`.
    private func editThenSend(_ result: PHPickerResult) {
        _ = result.itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] (url: URL?, _: Error?) -> Void in
            let data = url.flatMap { try? Data(contentsOf: $0) }
            var picture: UIImage?
            if let data, let source = CGImageSourceCreateWithData(data as CFData, nil) {
                let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                                kCGImageSourceThumbnailMaxPixelSize: 4096, kCGImageSourceShouldCacheImmediately: true]
                if let made = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) { picture = UIImage(cgImage: made) }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                guard let data, let picture else {
                    let item = self.add(Pending(heading: "🖼 Фотография"))
                    self.fail(item, "Не удалось обработать фото. Файл не отправлен.")
                    return
                }
                self.presentEditor(picture, data: data, tries: 0)
            }
        }
    }

    private func presentEditor(_ picture: UIImage, data: Data, tries: Int) {
        guard let host else { return }
        // The system's picker may still be going away.
        if host.presentedViewController != nil {
            if tries < 10 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.presentEditor(picture, data: data, tries: tries + 1) } }
            return
        }
        let editor = PhotoEditorController(image: picture)
        editor.onDone = { [weak self] (edited: PhotoEditorController.Output?) -> Void in
            guard let self else { return }
            let item = self.add(Pending(heading: "🖼 Фотография"))
            item.meta = self.takeReply?()
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { return }
                var bytes = data
                // Attachments: the edited bitmap goes as lossless PNG and is written in the editor's chosen format.
                if let edited, let png = AttachmentPanelController.png(edited.image) { bytes = png }
                self.preparing.lock()
                let prepared: Result<Prepared, PhotoPrepare.Failure>
                if let source = CGImageSourceCreateWithData(bytes as CFData, nil) {
                    prepared = PhotoPrepare.prepare(source, fileSize: bytes.count, format: edited?.format).map { (photo: PhotoPrepare.Prepared) -> Prepared in
                        Prepared(bytes: photo.bytes, name: photo.name, mimeType: photo.mimeType, media: ["width": photo.width, "height": photo.height, "hdr": "sdr"], preview: photo.preview)
                    }
                } else {
                    prepared = .failure(PhotoPrepare.Failure(words: "Не удалось обработать фото. Файл не отправлен."))
                }
                self.preparing.unlock()
                DispatchQueue.main.async { self.ready(item, prepared) }
            }
        }
        host.present(editor, animated: true)
    }

    private func photo(at url: URL) -> Result<Prepared, PhotoPrepare.Failure> {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return .failure(PhotoPrepare.Failure(words: "Не удалось обработать фото. Файл не отправлен.")) }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        return PhotoPrepare.prepare(source, fileSize: size).map { (photo: PhotoPrepare.Prepared) -> Prepared in
            Prepared(bytes: photo.bytes, name: photo.name, mimeType: photo.mimeType, media: ["width": photo.width, "height": photo.height, "hdr": "sdr"], preview: photo.preview)
        }
    }

    /// Whether a chosen file is a video: by its name or by how it begins (a picture is never one).
    private static func isVideo(_ url: URL) -> Bool {
        if let source = CGImageSourceCreateWithURL(url as CFURL, nil), PhotoPrepare.isPicture(source) { return false }
        let type = UTType(filenameExtension: url.pathExtension)
        var head = Data()
        if let handle = try? FileHandle(forReadingFrom: url) {
            head = (try? handle.read(upToCount: 16)) ?? Data()
            try? handle.close()
        }
        let audio = type?.conforms(to: .audio) ?? false
        let named = type.map { (found: UTType) -> Bool in found.conforms(to: .movie) || found.conforms(to: .video) } ?? false
        let iso = head.count >= 12 && head.subdata(in: 4..<8) == Data("ftyp".utf8)
        let matroska = head.starts(with: [0x1a, 0x45, 0xdf, 0xa3])
        let avi = head.count >= 12 && head.starts(with: Data("RIFF".utf8)) && head.subdata(in: 8..<12) == Data("AVI ".utf8)
        return named || (iso && !audio) || matroska || avi
    }

    /// A file chosen in «Файлы»: a picture is prepared as a photo whatever its name says, a video goes the way of
    /// «Видео» (see `onVideoFile`; with nobody to take it, it is not sent — it cannot be cleaned of its metadata
    /// here), anything else goes as it is.
    private func file(at url: URL) -> Result<Prepared, PhotoPrepare.Failure> {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        guard size > 0 else { return .failure(PhotoPrepare.Failure(words: "Не удалось прочитать файл.")) }
        if let source = CGImageSourceCreateWithURL(url as CFURL, nil), PhotoPrepare.isPicture(source) { return photo(at: url) }
        let type = UTType(filenameExtension: url.pathExtension)
        if ChatAttachments.isVideo(url) { return .failure(PhotoPrepare.Failure(words: "Видео пока нельзя отправить в этой версии приложения.")) }
        guard size <= ChatAttachments.maxFile else { return .failure(PhotoPrepare.Failure(words: "Файл слишком большой. Максимум — 20 МБ.")) }
        guard let bytes = try? Data(contentsOf: url), !bytes.isEmpty, bytes.count <= ChatAttachments.maxFile else { return .failure(PhotoPrepare.Failure(words: "Не удалось прочитать файл.")) }
        return .success(Prepared(bytes: bytes, name: url.lastPathComponent, mimeType: type?.preferredMIMEType ?? "application/octet-stream", media: nil, preview: nil))
    }

    // MARK: On the way out

    private func add(_ item: Pending) -> Pending {
        pending.append(item)
        onPendingChanged?()
        return item
    }

    private func fail(_ item: Pending, _ words: String) {
        item.failed = words
        item.transfer = nil
        onPendingChanged?()
        sendAlbumInOrder() // Attachments: the next photo of an album need not wait for this one
    }

    private func remove(_ item: Pending) {
        item.removed = true
        item.transfer?.cancel()
        pending.removeAll { $0 === item }
        onPendingChanged?()
    }

    /// The picture or file is ready (main queue): it is shown, then sealed and sent.
    private func ready(_ item: Pending, _ prepared: Result<Prepared, PhotoPrepare.Failure>) {
        guard !item.removed else { return }
        switch prepared {
        case .failure(let failure): fail(item, failure.words)
        case .success(let made):
            item.prepared = made
            if let preview = made.preview, let picture = preview["base64"] as? String,
               let width = (preview["width"] as? NSNumber)?.doubleValue, let height = (preview["height"] as? NSNumber)?.doubleValue, height > 0 {
                item.thumb = picture
                item.wide = width / height
            }
            item.note = FileCore.sizeText(made.bytes.count)
            // Attachments: the photos of an album go out in the order they were chosen, each once the ones before
            // it are ready (or have failed), so the album keeps its order on both sides.
            if item.meta?["album"] != nil {
                sendAlbumInOrder()
            } else {
                item.started = true
                send(item)
            }
        }
    }

    /// Starts the photos of albums whose turn it is.
    private func sendAlbumInOrder() {
        for item in pending where item.meta?["album"] != nil && !item.started {
            if item.failed != nil { continue }
            guard item.prepared != nil else { return }
            item.started = true
            send(item)
        }
    }

    /// Seals the prepared bytes under a key of their own, uploads them and sends the message (from the main queue).
    private func send(_ item: Pending) {
        guard let messenger, let prepared = item.prepared, !item.removed else { return }
        item.failed = nil
        let transfer = FileTransfer()
        item.transfer = transfer
        onPendingChanged?()
        let whole = FileCore.sizeText(prepared.bytes.count)
        item.percent = -1
        transfer.onProgress = { [weak self, weak item] (sent: Int, total: Int) -> Void in
            let percent = total > 0 ? sent * 100 / total : 0
            DispatchQueue.main.async {
                guard let self, let item, !item.removed, item.failed == nil, percent != item.percent else { return }
                item.percent = percent
                item.note = FileCore.sizeText(prepared.bytes.count * percent / 100) + " из " + whole
                self.onPendingChanged?()
            }
        }
        let (chatId, peerId) = (self.chatId, self.peerId)
        work.async { [weak self] in
            let failed: (String) -> Void = { words in
                DispatchQueue.main.async {
                    guard let self, !item.removed else { return }
                    self.fail(item, words)
                }
            }
            // A new key, nonce and key id for every attempt: the same key never seals two uploads.
            guard let encryption = FileCore.call("newEncryption") as? [String: Any] else { return failed("Шифрование ещё не готово. Попробуй ещё раз.") }
            let sealed: Data
            switch FileCore.seal(prepared.bytes, encryption: encryption) {
            case .success(let data): sealed = data
            case .failure(let failure): return failed(failure.words)
            }
            let id: String
            switch messenger.server.uploadSealedFile(sealed, transfer: transfer) {
            case .success(let made): id = made
            case .failure(.words(let words)): return failed(words)
            case .failure(.proof): return failed("Не удалось подтвердить устройство. Попробуй ещё раз.")
            case .failure(.cancelled): return
            }
            let parts: [Any] = [id, prepared.name, prepared.mimeType, prepared.bytes.count, encryption, prepared.media ?? NSNull(), prepared.preview ?? NSNull()]
            guard let attachment = FileCore.call("attachment", parts) as? [String: Any] else { return failed("Не удалось отправить файл.") }
            DispatchQueue.main.async {
                guard !item.removed else { return }
                messenger.send(chatId: chatId, peerId: peerId, text: "", attachment: attachment, meta: item.meta) { [weak self] result in
                    guard let self else { return }
                    // Without an answer the message stays among the unsent ones and goes out by itself later,
                    // with this very attachment: the row has done its part either way.
                    if case .failure(let failure) = result, failure.name != "NetworkError" {
                        self.fail(item, failure.message)
                        return
                    }
                    self.remove(item)
                    NotificationCenter.default.post(name: Messenger.changed, object: chatId)
                }
            }
        }
    }

    /// The rows of what is on its way out, to stand after the chat's own.
    var pendingRows: [[String: Any]] {
        pending.map { (item: Pending) -> [String: Any] in
            var label = ""
            if let failed = item.failed {
                label = "Не отправлено · повторить\n" + failed
            } else if item.thumb.isEmpty {
                label = item.note.isEmpty ? item.heading : item.heading + "\n" + item.note
            } else if item.transfer != nil {
                label = item.note
            }
            var row: [String: Any] = ["key": item.key, "kind": 0, "mine": true, "text": "", "time": item.time, "ticks": item.failed == nil ? 3 : 4, "tail": true, "label": label]
            if !item.thumb.isEmpty {
                row["thumb"] = item.thumb
                row["thumbWide"] = item.wide
            }
            return row
        }
    }

    // MARK: A touch on a row

    /// A row of the chat was touched: an unsent attachment offers to try again, a received one is opened.
    func pressed(_ key: String) {
        // Voice/Video: voice messages, videos, round videos and big files are played and opened there.
        if mediaPressed?(key) == true { return }
        if let item = pending.first(where: { $0.key == key }) {
            guard item.failed != nil, let host else { return }
            let sheet = UIAlertController(title: nil, message: item.failed, preferredStyle: .actionSheet)
            if item.prepared != nil { sheet.addAction(UIAlertAction(title: "Повторить отправку", style: .default, handler: { [weak self] _ in self?.send(item) })) }
            sheet.addAction(UIAlertAction(title: "Удалить", style: .destructive, handler: { [weak self] _ in self?.remove(item) }))
            sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
            sheet.popoverPresentationController?.sourceView = host.view
            host.present(sheet, animated: true)
            return
        }
        guard let attachment = AttachmentStore.shared.attachment(key) else { return }
        open(attachment)
    }

    private func open(_ attachment: [String: Any]) {
        guard let host else { return }
        let about = FileCore.describe(attachment)
        if let refusal = about.refusal { return say(refusal) }
        guard let messenger, let cipherSize = about.cipherSize else { return }
        let load = AttachmentLoad(server: messenger.server, attachment: attachment, cipherSize: cipherSize)
        host.view.endEditing(true)
        if about.kind == "photo" {
            let small = ((attachment["preview"] as? [String: Any])?["base64"] as? String).flatMap { Data(base64Encoded: $0) }.flatMap { UIImage(data: $0) }
            host.present(PhotoViewer(small: small, load: load), animated: true)
        } else {
            host.present(FileOpenController(title: attachment["name"] as? String ?? "Файл", fileName: about.fileName, load: load, presenter: host), animated: true)
        }
    }

    // MARK: The simulator check

    /// The chat's rows were read: gives the rows of outgoing attachments to add to them.
    func loaded(_ rows: [[String: Any]]) -> [[String: Any]] {
        #if targetEnvironment(simulator)
        simulatorOpen(rows)
        #endif
        return pendingRows
    }

    #if targetEnvironment(simulator)
    private var simulatorOpened = false

    /// `-openattachment photo|file`: once the chat is on screen, opens its newest photo or file by itself.
    private func simulatorOpen(_ rows: [[String: Any]]) {
        // Attachments: -photoeditor crop|draw|size opens the editor with a drawn picture (with or without an account).
        if !simulatorOpened, let tool = UserDefaults.standard.string(forKey: "photoeditor") {
            simulatorOpened = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let host = self?.host else { return }
                let editor = PhotoEditorController(image: ChatAttachments.demoPicture(width: 1200, height: 800))
                host.present(editor, animated: false)
                editor.simulatorShow(tool)
            }
            return
        }
        // Composer: -attachdemo panel|panellimited|paneldenied|panelselected opens the paperclip's panel with drawn tiles.
        if !simulatorOpened, let demo = UserDefaults.standard.string(forKey: "attachdemo"), demo.hasPrefix("panel") {
            simulatorOpened = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.choose() }
            return
        }
        guard !simulatorOpened, let wanted = UserDefaults.standard.string(forKey: "openattachment") else { return }
        for row in rows.reversed() {
            guard let key = row["key"] as? String, let attachment = AttachmentStore.shared.attachment(key) else { continue }
            let photo = FileCore.describe(attachment).kind == "photo"
            if photo != (wanted == "photo") { continue }
            simulatorOpened = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.pressed(key) }
            return
        }
    }

    /// `-attachdemo 1` with `-demo 1 -chat 1`: sample rows with a photo, a file, a big file and an upload on its way.
    static func demoRows() -> [[String: Any]] {
        let picture = demoPicture(width: 240, height: 160).jpegData(compressionQuality: 0.6)?.base64EncodedString() ?? ""
        return [
            ["key": "sample-attach-1", "kind": 0, "mine": false, "text": "", "time": "09:38", "tail": false, "thumb": picture, "thumbWide": 1.5],
            ["key": "sample-attach-2", "kind": 0, "mine": false, "text": "Договор и приложение к нему", "time": "09:39", "tail": false, "label": "📎 Договор № 7.pdf\n" + FileCore.sizeText(1_258_291)],
            ["key": "sample-attach-3", "kind": 0, "mine": false, "text": "", "time": "09:39", "tail": true, "label": "🎬 Видео\n" + FileCore.sizeText(3_221_225_472)],
            ["key": "sample-attach-4", "kind": 0, "mine": true, "text": "", "time": "09:41", "ticks": 3, "tail": true, "thumb": picture, "thumbWide": 1.5, "label": FileCore.sizeText(2_202_009) + " из " + FileCore.sizeText(5_505_024)],
        ]
    }

    /// A drawn picture for the sample rows and the sample viewer (no photo of anyone).
    static func demoPicture(width: CGFloat, height: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let size = CGSize(width: width, height: height)
        return UIGraphicsImageRenderer(size: size, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
            let colors = [UIColor(hex: 0x1F3B73).cgColor, UIColor(hex: 0xE0803B).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1] as [CGFloat]) {
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: width, y: height), options: [])
            }
            UIColor(white: 1, alpha: 0.85).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: width * 0.62, y: height * 0.16, width: height * 0.3, height: height * 0.3))
        }
    }

    /// `-attachdemo viewer`: the photo viewer with the drawn picture.
    static func demoViewer(over host: UIViewController) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak host] in
            host?.present(PhotoViewer(small: ChatAttachments.demoPicture(width: 1200, height: 800), load: nil), animated: false)
        }
    }
    #endif
}
