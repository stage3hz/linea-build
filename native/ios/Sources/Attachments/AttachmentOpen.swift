import QuickLook
import UIKit

/// The attachments of the messages on screen, by the key of their row: the list itself only knows what to draw.
final class AttachmentStore {
    static let shared = AttachmentStore()
    private let lock = NSLock()
    private var held: [String: [String: Any]] = [:]

    func remember(_ key: String, _ attachment: [String: Any]) {
        lock.lock()
        // The keys of a session's messages never repeat; the map is kept from growing without end all the same.
        if held.count > 4000 { held.removeAll() }
        held[key] = attachment
        lock.unlock()
    }

    func attachment(_ key: String) -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        return held[key]
    }
}

/// How a message with an attachment looks in the list (`MsgRow`: `thumb`, `thumbWide`, `label`).
enum AttachmentRows {
    /// The fields to put over a message's row; empty for a message without an attachment. `key`: the row's key.
    static func fields(_ message: [String: Any], key: String) -> [String: Any] {
        guard let attachment = message["attachment"] as? [String: Any] else { return [:] }
        AttachmentStore.shared.remember(key, attachment)
        var fields: [String: Any] = [:]
        // A message that is only an attachment has no words of its own.
        if (message["text"] as? String ?? "").isEmpty {
            fields["text"] = ""
            fields["fmt"] = [Int]()
            fields["urls"] = [String]()
        }
        let about = FileCore.describe(attachment)
        let name = attachment["name"] as? String ?? "Файл"
        // The small picture was checked by the core when the message was opened (`photo::valid_preview`).
        if about.kind == "photo", about.refusal == nil, let preview = attachment["preview"] as? [String: Any], let picture = preview["base64"] as? String,
           let width = (preview["width"] as? NSNumber)?.doubleValue, let height = (preview["height"] as? NSNumber)?.doubleValue, width > 0, height > 0 {
            fields["thumb"] = picture
            fields["thumbWide"] = width / height
            return fields
        }
        let heading = about.kind == "photo" ? "🖼 Фотография" : about.kind == "video" ? "🎬 Видео" : "📎 " + name
        fields["label"] = about.sizeText.isEmpty ? heading : heading + "\n" + about.sizeText
        return fields
    }
}

/// Brings one attachment: downloads the sealed bytes, has the core check and open them, and hands the file over
/// on the main queue. The decrypted bytes stay in memory; nothing is written and nothing is logged here.
final class AttachmentLoad {
    private let server: Server
    private let attachment: [String: Any]
    private let cipherSize: Int
    private var transfer: FileTransfer?
    private var cancelled = false
    private var shownPercent = -1
    /// Which start is the current one: what an earlier start still reports (progress, the result) is dropped.
    private var run = 0
    /// «1.2 МБ из 3.4 МБ», on the main queue.
    var onProgress: ((String) -> Void)?

    init(server: Server, attachment: [String: Any], cipherSize: Int) {
        self.server = server
        self.attachment = attachment
        self.cipherSize = cipherSize
    }

    func start(done: @escaping (Result<Data, FileCore.Failure>) -> Void) {
        guard let id = attachment["id"] as? String else { return done(.failure(FileCore.Failure(words: "Не удалось загрузить зашифрованный файл."))) }
        cancelled = false
        run += 1
        let current = run
        self.transfer?.cancel()
        let transfer = FileTransfer()
        self.transfer = transfer
        let size = max(0, cipherSize - 16)
        let whole = FileCore.sizeText(size)
        shownPercent = -1
        transfer.onProgress = { [weak self] (got: Int, all: Int) -> Void in
            let percent = all > 0 ? got * 100 / all : 0
            DispatchQueue.main.async {
                guard let self, !self.cancelled, self.run == current, percent != self.shownPercent else { return }
                self.shownPercent = percent
                self.onProgress?(FileCore.sizeText(size * percent / 100) + " из " + whole)
            }
        }
        let (server, attachment, cipherSize) = (self.server, self.attachment, self.cipherSize)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result: Result<Data, FileCore.Failure>
            switch server.downloadSealedFile(id: id, cipherSize: cipherSize, transfer: transfer) {
            case .success(let sealed): result = FileCore.open(sealed, attachment: attachment)
            case .failure(.words(let words)): result = .failure(FileCore.Failure(words: words))
            case .failure(.proof): result = .failure(FileCore.Failure(words: "Не удалось загрузить зашифрованный файл."))
            case .failure(.cancelled): result = .failure(FileCore.Failure(words: "Загрузка отменена."))
            }
            DispatchQueue.main.async {
                guard let self, !self.cancelled, self.run == current else { return }
                done(result)
            }
        }
    }

    /// Stops the download; nothing more is reported.
    func cancel() {
        cancelled = true
        transfer?.cancel()
    }
}

/// Decrypted files while the system shows them: a folder per file under the app's own temporary directory,
/// protected by the device's passcode key, removed as soon as the preview is closed (and swept at the next start
/// of a chat, should the app have been stopped in between).
enum DecryptedFiles {
    private static let prefix = "invizent-view-"

    /// Writes the file under its safe name; gives the folder (to remove) and the file (to show).
    static func write(_ data: Data, name: String) -> (folder: URL, file: URL)? {
        let manager = FileManager.default
        let folder = manager.temporaryDirectory.appendingPathComponent(prefix + UUID().uuidString.lowercased(), isDirectory: true)
        let file = folder.appendingPathComponent(name.isEmpty ? "file" : name, isDirectory: false)
        do {
            try manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            try data.write(to: file, options: [.atomic, .completeFileProtection])
            return (folder, file)
        } catch {
            try? manager.removeItem(at: folder)
            return nil
        }
    }

    static func remove(_ folder: URL) {
        try? FileManager.default.removeItem(at: folder)
    }

    /// Removes whatever an interrupted preview left behind.
    static func sweep() {
        let manager = FileManager.default
        let names = (try? manager.contentsOfDirectory(atPath: manager.temporaryDirectory.path)) ?? []
        for name in names where name.hasPrefix(prefix) {
            try? manager.removeItem(at: manager.temporaryDirectory.appendingPathComponent(name))
        }
    }
}

/// A file being brought and then shown by the system's preview (which has the share sheet): a small card with
/// the name, how much has arrived and a way to stop; then Quick Look; then the decrypted copy is deleted.
final class FileOpenController: UIViewController, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    private let fileTitle: String
    private let fileName: String
    private let loader: AttachmentLoad
    private weak var presenter: UIViewController?
    private let card = UIView()
    private let heading = UILabel()
    private let progress = UILabel()
    private let stop = UIButton(type: .system)
    private var shown: (folder: URL, file: URL)?
    /// Kept while Quick Look is on screen (it does not keep its data source).
    private static var showing: FileOpenController?

    /// `title`: the file's name as the message gives it; `fileName`: the safe name of the temporary copy.
    init(title: String, fileName: String, load: AttachmentLoad, presenter: UIViewController) {
        fileTitle = title
        self.fileName = fileName
        loader = load
        self.presenter = presenter
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(white: 0, alpha: 0.4)
        card.backgroundColor = Theme.surface2
        card.layer.cornerRadius = 22
        card.layer.cornerCurve = .continuous
        view.addSubview(card)
        heading.text = fileTitle
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        heading.textColor = Theme.text
        heading.textAlignment = .center
        heading.lineBreakMode = .byTruncatingMiddle
        card.addSubview(heading)
        progress.text = "Загрузка…"
        progress.font = .systemFont(ofSize: 13)
        progress.textColor = Theme.muted
        progress.textAlignment = .center
        card.addSubview(progress)
        stop.setTitle("Отменить загрузку", for: .normal)
        stop.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        stop.tintColor = Theme.text
        stop.addTarget(self, action: #selector(stopNow), for: .touchUpInside)
        card.addSubview(stop)

        loader.onProgress = { [weak self] words in self?.progress.text = words }
        loader.start { [weak self] result in self?.finished(result) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = min(view.bounds.width - 48, 320)
        card.frame = CGRect(x: (view.bounds.width - width) / 2, y: (view.bounds.height - 132) / 2, width: width, height: 132)
        heading.frame = CGRect(x: 16, y: 18, width: width - 32, height: 20)
        progress.frame = CGRect(x: 16, y: 44, width: width - 32, height: 18)
        stop.frame = CGRect(x: 16, y: 76, width: width - 32, height: 44)
    }

    @objc private func stopNow() {
        loader.cancel()
        dismiss(animated: true)
    }

    private func finished(_ result: Result<Data, FileCore.Failure>) {
        let host = presenter
        switch result {
        case .failure(let failure):
            dismiss(animated: true) {
                let alert = UIAlertController(title: nil, message: failure.words, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
                host?.present(alert, animated: true)
            }
        case .success(let data):
            guard let written = DecryptedFiles.write(data, name: fileName) else {
                dismiss(animated: true) {
                    let alert = UIAlertController(title: nil, message: "Не удалось открыть файл.", preferredStyle: .alert)
                    alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
                    host?.present(alert, animated: true)
                }
                return
            }
            shown = written
            dismiss(animated: true) { [self] in
                guard let host else {
                    DecryptedFiles.remove(written.folder)
                    return
                }
                let preview = QLPreviewController()
                preview.dataSource = self
                preview.delegate = self
                FileOpenController.showing = self
                host.present(preview, animated: true)
            }
        }
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { shown == nil ? 0 : 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        (shown?.file ?? URL(fileURLWithPath: NSTemporaryDirectory())) as NSURL
    }

    /// The preview is gone: so is the decrypted copy.
    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        if let shown { DecryptedFiles.remove(shown.folder) }
        shown = nil
        FileOpenController.showing = nil
    }
}
