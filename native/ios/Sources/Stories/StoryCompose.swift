import AVFoundation
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// Publishing a story or a post (the reference's `pickAndUpload` in ProfilePosts.tsx and `Api.publishPost`):
// a photo or a video is chosen, made ready on this phone — drawn or encoded anew, so nothing of the original
// file's metadata (place, camera, dates, name) is left — shown with a field for the caption, uploaded as a plain
// profile file (`POST /uploads?purpose=post`) and published (`POST /me/posts`).
//
// The media of a story or a post is not end-to-end encrypted in the reference, and is not here: the server keeps
// the file as it is and gives it to whoever may see the person's posts.
//
// The reference publishes at once, without a screen in between; the caption the server takes (up to 300) could
// not be written there. Here the screen with the picture and the caption comes before «Добавить».

/// A photo or a video made ready to go up.
struct StoryPrepared {
    /// A photo's cleaned bytes.
    let bytes: Data?
    /// A video's file, written anew by this app in the temporary area.
    let file: URL?
    let name: String
    let mimeType: String
    /// What the screen shows: already decoded.
    let picture: UIImage?
    let isVideo: Bool
}

enum StoryPrepare {
    struct Failure: Error {
        let words: String
    }

    private static let photoFailed = Failure(words: "Не удалось обработать фото. Файл не отправлен.")
    private static let tooBig = Failure(words: "Файл слишком большой. Максимум — 20 МБ.")
    private static let maxPixels = 16_000_000

    /// A photo: decoded upright, scaled to the width the core names (1600 for a wider one), drawn into a fresh
    /// sRGB bitmap and written as a JPEG that then passes the core's gate (the picture only: no EXIF, no GPS, no
    /// thumbnails). Call off the main queue.
    static func photo(at url: URL) -> Result<StoryPrepared, Failure> {
        let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions as CFDictionary), PhotoPrepare.isPicture(source),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let pixelHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              pixelWidth > 0, pixelHeight > 0, pixelWidth <= 20000, pixelHeight <= 20000 else { return .failure(photoFailed) }
        // Orientations 5 … 8 lie on their side: the width seen is the stored height.
        let turn = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        let uprightWidth = turn >= 5 && turn <= 8 ? pixelHeight : pixelWidth
        let asked: [String: Any] = ["video": false, "width": uprightWidth]
        guard let plan = Core.view("storiesUpload", [asked]) as? [String: Any], (plan["error"] as? String ?? "").isEmpty else { return .failure(photoFailed) }
        let wantedWidth = (plan["resizeWidth"] as? NSNumber)?.intValue ?? uprightWidth
        var scale = min(1, Double(wantedWidth) / Double(uprightWidth))
        let pixelsThen = Double(pixelWidth) * Double(pixelHeight) * scale * scale
        if pixelsThen > Double(maxPixels) { scale *= (Double(maxPixels) / pixelsThen).squareRoot() }
        let longest = max(1, Int((Double(max(pixelWidth, pixelHeight)) * scale).rounded(.down)))
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: longest, kCGImageSourceShouldCacheImmediately: true]
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: decoded.width, height: decoded.height, bitsPerComponent: 8, bytesPerRow: decoded.width * 4, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return .failure(photoFailed) }
        let box = CGRect(x: 0, y: 0, width: decoded.width, height: decoded.height)
        context.interpolationQuality = .high
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(box)
        context.draw(decoded, in: box)
        guard let fresh = context.makeImage() else { return .failure(photoFailed) }
        // Only the bitmap is written: no property of the source is passed on.
        let written = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(written as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return .failure(photoFailed) }
        let quality = (plan["quality"] as? NSNumber)?.doubleValue ?? 0.85
        let writeOptions: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality, kCGImageDestinationEmbedThumbnail: false]
        CGImageDestinationAddImage(destination, fresh, writeOptions as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return .failure(photoFailed) }
        guard case .success(let clean) = FileCore.cleanJpeg(written as Data) else { return .failure(photoFailed) }
        if Double(clean.count) > StoryRules.number("smallUpload", 20 * 1024 * 1024) { return .failure(tooBig) }
        return .success(StoryPrepared(bytes: clean, file: nil, name: plan["name"] as? String ?? "post.jpg", mimeType: plan["mimeType"] as? String ?? "image/jpeg",
                                      picture: UIImage(cgImage: fresh), isVideo: false))
    }

    /// A video: at most a minute (the core's rule and words), encoded anew at 960×540 as an MP4 with no metadata.
    /// `source` is a file of this app's own; it is removed here. `done` comes on a background queue.
    static func video(source: URL, done: @escaping (Result<StoryPrepared, Failure>) -> Void) {
        let failed = Failure(words: VideoPrepare.failed)
        let asset = AVURLAsset(url: source)
        let seconds = CMTimeGetSeconds(asset.duration)
        func give(_ result: Result<StoryPrepared, Failure>) {
            try? FileManager.default.removeItem(at: source)
            done(result)
        }
        guard seconds.isFinite, seconds >= 0, asset.tracks(withMediaType: .video).first != nil else { return give(.failure(failed)) }
        let asked: [String: Any] = ["video": true, "durationMs": (seconds * 1000).rounded(), "mimeType": "video/mp4"]
        guard let plan = Core.view("storiesUpload", [asked]) as? [String: Any] else { return give(.failure(failed)) }
        let refusal = plan["error"] as? String ?? ""
        if !refusal.isEmpty { return give(.failure(Failure(words: refusal))) }
        let wanted = [AVAssetExportPreset960x540, AVAssetExportPresetMediumQuality]
        let known = AVAssetExportSession.exportPresets(compatibleWith: asset)
        guard let preset = wanted.first(where: { (name: String) -> Bool in known.contains(name) }), let export = AVAssetExportSession(asset: asset, presetName: preset) else { return give(.failure(failed)) }
        let target = VideoPrepare.freshFile("mp4")
        export.outputURL = target
        export.outputFileType = .mp4
        export.shouldOptimizeForNetworkUse = true
        // Nothing of the source's description is carried over: no place, no device, no dates.
        export.metadata = []
        export.metadataItemFilter = AVMetadataItemFilter.forSharing()
        export.exportAsynchronously {
            guard export.status == .completed else {
                try? FileManager.default.removeItem(at: target)
                return give(.failure(failed))
            }
            let size = ((try? FileManager.default.attributesOfItem(atPath: target.path))?[.size] as? NSNumber)?.doubleValue ?? 0
            let sized: [String: Any] = ["video": true, "durationMs": (seconds * 1000).rounded(), "mimeType": "video/mp4", "size": size]
            let again = Core.view("storiesUpload", [sized]) as? [String: Any] ?? [:]
            // Above 20 MiB the reference sends a file in resumable chunks; that road is not built in this app yet.
            if size <= 0 || again["chunked"] as? Bool != false {
                try? FileManager.default.removeItem(at: target)
                return give(.failure(size <= 0 ? failed : tooBig))
            }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: target))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 1280, height: 1280)
            var picture: UIImage? = nil
            if let frame = try? generator.copyCGImage(at: .zero, actualTime: nil) { picture = UIImage(cgImage: frame) }
            give(.success(StoryPrepared(bytes: nil, file: target, name: again["name"] as? String ?? "post.mp4", mimeType: again["mimeType"] as? String ?? "video/mp4", picture: picture, isVideo: true)))
        }
    }
}

/// Choosing the photo or video and opening the screen that publishes it. Kept by whoever starts it.
final class StoryPublisher: NSObject, PHPickerViewControllerDelegate {
    /// Called on the main queue after a story or a post was published: "story" or "post".
    var onPublished: ((String) -> Void)?
    private let messenger: Messenger
    private weak var host: UIViewController?
    private var kind = "story"

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init()
    }

    /// `kind`: "story" or "post".
    func begin(kind: String, from host: UIViewController) {
        self.kind = kind
        self.host = host
        // The system's picker hands over only a copy of what was chosen: the app asks for no access to the library.
        var config = PHPickerConfiguration()
        config.filter = .any(of: [.images, .videos])
        config.selectionLimit = 1
        config.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        host.present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider, let host, let stack = host.navigationController else { return }
        let screen = StoryComposeViewController(messenger: messenger, kind: kind)
        screen.onPublished = { [weak self] (kind: String) -> Void in self?.onPublished?(kind) }
        stack.pushViewController(screen, animated: true)
        let hand: (Result<StoryPrepared, StoryPrepare.Failure>) -> Void = { [weak screen] (result: Result<StoryPrepared, StoryPrepare.Failure>) -> Void in
            DispatchQueue.main.async {
                if let screen {
                    screen.take(result)
                } else if case .success(let prepared) = result, let file = prepared.file {
                    // The screen was left meanwhile: the prepared video is not kept.
                    try? FileManager.default.removeItem(at: file)
                }
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { (url: URL?, _: Error?) -> Void in
                // The picker's copy lives only inside this call: it is copied into this app's temporary area.
                let own = VideoPrepare.freshFile("mov")
                guard let url, (try? FileManager.default.copyItem(at: url, to: own)) != nil else { return hand(.failure(StoryPrepare.Failure(words: VideoPrepare.failed))) }
                StoryPrepare.video(source: own, done: hand)
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { (url: URL?, _: Error?) -> Void in
                guard let url else { return hand(.failure(StoryPrepare.Failure(words: "Не удалось обработать фото. Файл не отправлен."))) }
                hand(StoryPrepare.photo(at: url))
            }
        } else {
            hand(.failure(StoryPrepare.Failure(words: StoryRules.word("mediaOnly"))))
        }
    }
}

/// The screen before publishing: the picture, the caption, «Добавить историю» / «Добавить публикацию».
final class StoryComposeViewController: UIViewController, UITextFieldDelegate {
    var onPublished: ((String) -> Void)?
    private let messenger: Messenger?
    private let kind: String
    private var prepared: StoryPrepared?
    private var busy = false

    private let backButton = UIButton(type: .system)
    private let heading = UILabel()
    private let preview = UIImageView()
    private let playMark = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let problemLabel = UILabel()
    private let bar = UIVisualEffectView(effect: nil)
    private let captionField = UITextField()
    private let leftLabel = UILabel()
    private let publishButton = UIButton(type: .system)
    private let publishSpinner = UIActivityIndicatorView(style: .medium)

    init(messenger: Messenger?, kind: String) {
        self.messenger = messenger
        self.kind = kind
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        if let file = prepared?.file { try? FileManager.default.removeItem(at: file) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg

        backButton.setImage(chatSymbol("chevron.left", 19, .semibold), for: .normal)
        backButton.tintColor = Theme.text
        backButton.accessibilityLabel = "Назад"
        backButton.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        heading.text = StoryRules.word(kind == "story" ? "removeStory" : "removePost")
        heading.font = .systemFont(ofSize: 20, weight: .semibold)
        heading.textColor = Theme.text
        heading.accessibilityTraits = .header

        preview.contentMode = .scaleAspectFit
        preview.clipsToBounds = true
        preview.layer.cornerRadius = 22
        preview.layer.cornerCurve = .continuous
        preview.backgroundColor = Theme.surface2
        preview.isAccessibilityElement = true
        playMark.image = chatSymbol("play.fill", 26)
        playMark.tintColor = .white
        playMark.contentMode = .center
        playMark.isHidden = true
        spinner.color = Theme.muted
        spinner.hidesWhenStopped = true
        spinner.startAnimating()
        problemLabel.font = .systemFont(ofSize: 14)
        problemLabel.textColor = Theme.danger
        problemLabel.textAlignment = .center
        problemLabel.numberOfLines = 0

        bar.effect = chatGlass()
        bar.clipsToBounds = true
        bar.layer.cornerRadius = 26
        bar.layer.cornerCurve = .continuous
        captionField.attributedPlaceholder = NSAttributedString(string: "Подпись", attributes: [.foregroundColor: Theme.muted])
        captionField.font = .systemFont(ofSize: 16)
        captionField.textColor = Theme.text
        captionField.tintColor = Theme.text
        captionField.keyboardAppearance = Theme.dark ? .dark : .light
        captionField.returnKeyType = .done
        captionField.accessibilityLabel = "Подпись"
        captionField.delegate = self
        captionField.addTarget(self, action: #selector(captionEdited), for: .editingChanged)
        leftLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        leftLabel.textColor = Theme.muted
        leftLabel.textAlignment = .right
        leftLabel.setContentHuggingPriority(.required, for: .horizontal)
        leftLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        var look = UIButton.Configuration.filled()
        look.baseBackgroundColor = Theme.accent
        look.baseForegroundColor = Theme.onAccent
        look.cornerStyle = .capsule
        look.title = StoryRules.word(kind == "story" ? "addStory" : "addPost")
        publishButton.configuration = look
        publishButton.addTarget(self, action: #selector(publish), for: .touchUpInside)
        publishSpinner.color = Theme.onAccent
        publishSpinner.hidesWhenStopped = true
        publishSpinner.isUserInteractionEnabled = false

        let parts: [UIView] = [backButton, heading, preview, playMark, spinner, problemLabel, bar]
        for part in parts {
            part.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(part)
        }
        let inBar: [UIView] = [captionField, leftLabel, publishButton, publishSpinner]
        for part in inBar {
            part.translatesAutoresizingMaskIntoConstraints = false
            bar.contentView.addSubview(part)
        }
        let safe = view.safeAreaLayoutGuide
        let inside = bar.contentView
        NSLayoutConstraint.activate([
            backButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 4),
            backButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            backButton.widthAnchor.constraint(equalToConstant: 44),
            backButton.heightAnchor.constraint(equalToConstant: 44),
            heading.leadingAnchor.constraint(equalTo: backButton.trailingAnchor, constant: 2),
            heading.centerYAnchor.constraint(equalTo: backButton.centerYAnchor),
            heading.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -16),

            preview.topAnchor.constraint(equalTo: backButton.bottomAnchor, constant: 8),
            preview.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            preview.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            preview.bottomAnchor.constraint(equalTo: problemLabel.topAnchor, constant: -8),
            playMark.centerXAnchor.constraint(equalTo: preview.centerXAnchor),
            playMark.centerYAnchor.constraint(equalTo: preview.centerYAnchor),
            spinner.centerXAnchor.constraint(equalTo: preview.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: preview.centerYAnchor),
            problemLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            problemLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            problemLabel.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -8),

            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            // The bar ends where the keyboard begins, so the caption is never under it.
            bar.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -10),

            captionField.topAnchor.constraint(equalTo: inside.topAnchor, constant: 6),
            captionField.leadingAnchor.constraint(equalTo: inside.leadingAnchor, constant: 18),
            captionField.heightAnchor.constraint(equalToConstant: 44),
            leftLabel.leadingAnchor.constraint(equalTo: captionField.trailingAnchor, constant: 8),
            leftLabel.trailingAnchor.constraint(equalTo: inside.trailingAnchor, constant: -18),
            leftLabel.centerYAnchor.constraint(equalTo: captionField.centerYAnchor),
            publishButton.topAnchor.constraint(equalTo: captionField.bottomAnchor, constant: 4),
            publishButton.leadingAnchor.constraint(equalTo: inside.leadingAnchor, constant: 10),
            publishButton.trailingAnchor.constraint(equalTo: inside.trailingAnchor, constant: -10),
            publishButton.heightAnchor.constraint(equalToConstant: 48),
            publishButton.bottomAnchor.constraint(equalTo: inside.bottomAnchor, constant: -10),
            publishSpinner.centerXAnchor.constraint(equalTo: publishButton.centerXAnchor),
            publishSpinner.centerYAnchor.constraint(equalTo: publishButton.centerYAnchor),
        ])
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(endTyping)))
        refresh()
    }

    @objc private func goBack() { navigationController?.popViewController(animated: true) }

    @objc private func endTyping() { view.endEditing(true) }

    /// What was chosen is ready (or could not be made ready).
    func take(_ result: Result<StoryPrepared, StoryPrepare.Failure>) {
        loadViewIfNeeded()
        spinner.stopAnimating()
        switch result {
        case .success(let made):
            prepared = made
            preview.image = made.picture
            preview.accessibilityLabel = StoryRules.word(made.isVideo ? "video" : "photo")
            playMark.isHidden = !made.isVideo
        case .failure(let failure):
            problemLabel.text = failure.words
        }
        refresh()
    }

    private func refresh() {
        publishButton.isEnabled = prepared != nil && !busy
        var look = publishButton.configuration
        look?.title = busy ? "" : StoryRules.word(kind == "story" ? "addStory" : "addPost")
        publishButton.configuration = look
        if busy { publishSpinner.startAnimating() } else { publishSpinner.stopAnimating() }
        captionField.isEnabled = !busy
        backButton.isEnabled = !busy
    }

    private func checked() -> (caption: String, error: String, left: Int) {
        let made = Core.view("storiesCaption", [captionField.text ?? ""]) as? [String: Any] ?? [:]
        return (made["caption"] as? String ?? "", made["error"] as? String ?? "", (made["left"] as? NSNumber)?.intValue ?? 0)
    }

    @objc private func captionEdited() {
        let state = checked()
        // The count shows up near the limit; past it, it turns red and the server's own words are shown.
        leftLabel.text = state.left <= 40 ? String(state.left) : ""
        leftLabel.textColor = state.left < 0 ? Theme.danger : Theme.muted
        problemLabel.text = state.error
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return false
    }

    @objc private func publish() {
        guard let prepared, !busy else { return }
        let state = checked()
        if !state.error.isEmpty {
            problemLabel.text = state.error
            return
        }
        // Without an account (the simulator's samples) there is nothing to publish to.
        guard let messenger else { return }
        view.endEditing(true)
        busy = true
        problemLabel.text = ""
        refresh()
        let server = messenger.server
        let kind = self.kind
        let fallback = StoryRules.word(kind == "story" ? "addStoryFailed" : "addPostFailed")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var outcome: Result<Any, ServerError> = .failure(.network(fallback))
            var bytes = prepared.bytes
            if bytes == nil, let file = prepared.file { bytes = try? Data(contentsOf: file, options: [.mappedIfSafe]) }
            if let bytes {
                switch server.uploadPlainFile(bytes, name: prepared.name, mimeType: prepared.mimeType, purpose: "post") {
                case .failure(let error):
                    outcome = .failure(error)
                case .success(let uploaded):
                    outcome = server.opAndWait("publishPost", [uploaded["id"] as? String ?? "", kind, state.caption])
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                switch outcome {
                case .success:
                    self.onPublished?(kind)
                    self.navigationController?.popViewController(animated: true)
                case .failure(let error):
                    self.problemLabel.text = error.words.isEmpty ? fallback : error.words
                }
                self.refresh()
            }
        }
    }

    #if targetEnvironment(simulator)
    /// For a shot in the simulator: a drawn picture and a caption, as if they had just been chosen.
    func simulatorFill(_ picture: UIImage, caption: String) {
        loadViewIfNeeded()
        take(.success(StoryPrepared(bytes: picture.jpegData(compressionQuality: 0.85), file: nil, name: "post.jpg", mimeType: "image/jpeg", picture: picture, isVideo: false)))
        captionField.text = caption
        captionEdited()
    }
    #endif
}
