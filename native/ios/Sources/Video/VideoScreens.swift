import AVKit
import QuickLook
import UIKit

/// The system's player over the whole screen; when it is closed, the decrypted copy it played goes.
final class PlayerScreen: AVPlayerViewController {
    var onGone: (() -> Void)?
    /// Video: the rate before a press and hold took it to 2×.
    private var rateBeforeHold: Float = 1

    /// Video: the reference's player (VideoPlayerView.tsx, playerModel.ts) — its speeds from ¼× to 2×, picture in
    /// picture when the app is left while the film plays, and a press and hold that plays at 2× (after 500 ms).
    override func viewDidLoad() {
        super.viewDidLoad()
        if #available(iOS 16.0, *) {
            speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map { (rate: Float) -> AVPlaybackSpeed in
                AVPlaybackSpeed(rate: rate, localizedName: rate == 1 ? "Обычная" : String(format: "%g×", Double(rate)).replacingOccurrences(of: ".", with: ","))
            }
        }
        allowsPictureInPicturePlayback = true
        canStartPictureInPictureAutomaticallyFromInline = true
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.minimumPressDuration = 0.5
        hold.cancelsTouchesInView = false
        view.addGestureRecognizer(hold)
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard let player else { return }
        switch recognizer.state {
        case .began:
            guard player.rate > 0 else { return }
            rateBeforeHold = player.rate
            player.rate = 2
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .ended, .cancelled, .failed:
            if player.rate == 2 && rateBeforeHold != 2 { player.rate = rateBeforeHold }
        default:
            break
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil {
            player?.pause()
            onGone?()
            onGone = nil
        }
    }
}

/// A video (or a big file of any kind) being brought and then shown: a small card with the name, how much has
/// arrived and a way to stop; then the full-screen player — or, for a file, the system's preview; then the
/// decrypted copy is deleted. As the reference does, the file is downloaded and decrypted first and played then.
final class MediaOpenController: UIViewController, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    private let heading = UILabel()
    private let progress = UILabel()
    private let stop = UIButton(type: .system)
    private let card = UIView()
    private let fetch = MediaFetch()
    private let server: Server
    private let attachment: [String: Any]
    private let video: Bool
    private weak var presenter: UIViewController?
    private var shown: MediaFetch.Brought?
    /// Kept while Quick Look is on screen (it does not keep its data source).
    private static var showing: MediaOpenController?

    init(server: Server, attachment: [String: Any], video: Bool, presenter: UIViewController) {
        self.server = server
        self.attachment = attachment
        self.video = video
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
        heading.text = video ? "Видео" : (attachment["name"] as? String ?? "Файл")
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

        // Video: a film kept for watching without the network opens from the device, nothing is downloaded.
        if video, let kept = KeptMedia.file(for: attachment) {
            keptFile = kept
            progress.text = ""
            return
        }
        let size = (attachment["size"] as? NSNumber)?.intValue ?? 0
        let whole = FileCore.sizeText(size)
        fetch.start(server: server, attachment: attachment, progress: { [weak self] (part: Double) -> Void in
            self?.progress.text = FileCore.sizeText(Int(Double(size) * part)) + " из " + whole
        }, done: { [weak self] (result: Result<MediaFetch.Brought, FileCore.Failure>) -> Void in
            guard let self else {
                if case .success(let brought) = result { try? FileManager.default.removeItem(at: brought.folder) }
                return
            }
            self.finished(result)
        })
    }

    /// Video: the kept copy to play (see `KeptMedia`), set when nothing has to be brought.
    private var keptFile: URL?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard let kept = keptFile else { return }
        keptFile = nil
        let host = presenter
        let attachment = self.attachment
        dismiss(animated: false) {
            host?.present(VideoPlayerController(file: kept, folder: nil, attachment: attachment), animated: true)
        }
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
        fetch.cancel()
        dismiss(animated: true)
    }

    private func finished(_ result: Result<MediaFetch.Brought, FileCore.Failure>) {
        let host = presenter
        switch result {
        case .failure(let failure):
            dismiss(animated: true) {
                let alert = UIAlertController(title: nil, message: failure.words, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
                host?.present(alert, animated: true)
            }
        case .success(let brought):
            shown = brought
            dismiss(animated: true) { [self] in
                guard let host else {
                    try? FileManager.default.removeItem(at: brought.folder)
                    return
                }
                if video {
                    // Video: the reference's own player (Sources/Video/VideoPlayer.swift) — screen lock, keeping for
                    // watching without the network, its own sheet. It removes the decrypted copy when it closes.
                    host.present(VideoPlayerController(file: brought.file, folder: brought.folder, attachment: attachment), animated: true)
                } else {
                    let preview = QLPreviewController()
                    preview.dataSource = self
                    preview.delegate = self
                    MediaOpenController.showing = self
                    host.present(preview, animated: true)
                }
            }
        }
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { shown == nil ? 0 : 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        (shown?.file ?? URL(fileURLWithPath: NSTemporaryDirectory())) as NSURL
    }

    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        if let shown { try? FileManager.default.removeItem(at: shown.folder) }
        shown = nil
        MediaOpenController.showing = nil
    }
}
