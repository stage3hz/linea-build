import AVFoundation
import AVKit
import CryptoKit
import UIKit

/// «Сохранить для просмотра без сети» (the reference's mediaCache.ts `keepMedia`): a played video is kept, decrypted,
/// in the app's own protected folder (complete file protection, never backed up) instead of being removed when
/// the player closes, and opens from there next time without the network. One folder per file and key
/// (the reference's `mediaKey`); everything goes on sign-out and with «Очистить кэш».
enum KeptMedia {
    private static var root: URL? {
        guard let support = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return nil }
        return support.appendingPathComponent("invizent-kept", isDirectory: true)
    }

    /// The reference's `mediaKey`: the file's id and its key id, hashed into a safe folder name.
    private static func place(_ attachment: [String: Any]) -> URL? {
        guard let id = attachment["id"] as? String, !id.isEmpty, let root else { return nil }
        let keyId = (attachment["encryption"] as? [String: Any])?["fileKeyId"] as? String ?? ""
        let digest = SHA256.hash(data: Data((id + ":" + keyId).utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(digest, isDirectory: true)
    }

    /// The kept file of an attachment, if there is one.
    static func file(for attachment: [String: Any]) -> URL? {
        guard let folder = place(attachment) else { return nil }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        guard let name = names.first(where: { !$0.hasPrefix(".") }) else { return nil }
        return folder.appendingPathComponent(name)
    }

    static func isKept(_ attachment: [String: Any]) -> Bool { file(for: attachment) != nil }

    /// Copies the decrypted file in (from the player's temporary copy). Runs on any queue.
    static func keep(_ source: URL, for attachment: [String: Any]) -> Bool {
        guard let root, var folder = place(attachment) else { return false }
        let manager = FileManager.default
        do {
            try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            var top = root
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try top.setResourceValues(values)
            try? manager.removeItem(at: folder)
            try manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            try folder.setResourceValues(values)
            let target = folder.appendingPathComponent(source.lastPathComponent.isEmpty ? "video" : source.lastPathComponent)
            try manager.copyItem(at: source, to: target)
            try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: target.path)
            return true
        } catch {
            try? manager.removeItem(at: folder)
            return false
        }
    }

    static func remove(for attachment: [String: Any]) {
        guard let folder = place(attachment) else { return }
        try? FileManager.default.removeItem(at: folder)
    }

    static func wipe() {
        guard let root else { return }
        try? FileManager.default.removeItem(at: root)
    }
}

/// The reference's playerModel.ts: the numbers and decisions of the player, ported as they are.
enum PlayerModel {
    static let hideMs = 3.0
    static let doubleTap = 0.3
    static let doubleTapSlop: CGFloat = 110
    static let seekStep = 10.0
    static let seekBurst = 0.7
    static let hold = 0.5
    static let holdRate: Float = 2
    static let finePull: CGFloat = 70
    static let fineFactor: CGFloat = 0.2
    static let scrubSeek = 0.1
    static let speeds: [Float] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
    static let tooltipMin: CGFloat = 0.18, tooltipMax: CGFloat = 0.82

    /// «0:07», «12:40», «75:03».
    static func clock(_ seconds: Double) -> String {
        let value = max(0, Int(seconds.isFinite ? seconds : 0))
        return "\(value / 60):" + String(format: "%02d", value % 60)
    }

    /// «Обычная» for 1, otherwise «1.5×».
    static func speedLabel(_ speed: Float) -> String { speed == 1 ? "Обычная" : String(format: "%g×", Double(speed)) }

    static func seekTarget(_ current: Double, _ duration: Double, _ delta: Double) -> Double {
        let length = duration.isFinite && duration > 0 ? duration : 0
        return max(0, min(length, (current.isFinite ? current : 0) + delta))
    }

    static func fraction(_ time: Double, _ duration: Double) -> CGFloat {
        guard duration > 0, time.isFinite else { return 0 }
        return CGFloat(max(0, min(1, time / duration)))
    }

    struct TapState {
        var lastTime = -1e12
        var lastX: CGFloat = 0
        var acc = 0.0
        var side = 0
        var accTime = -1e12
    }

    static func burstActive(_ state: TapState, _ time: Double) -> Bool { state.acc > 0 && time - state.accTime <= seekBurst }

    /// The reference's `tapStep`: −1 / 1 seek now (the burst total in `acc`), 0 a possible single tap.
    static func tapStep(_ state: TapState, x: CGFloat, time: Double, width: CGFloat) -> (TapState, Int) {
        let side = x < width / 2 ? -1 : 1
        let continues = burstActive(state, time) && side == state.side
        let double = time - state.lastTime < doubleTap && abs(x - state.lastX) < doubleTapSlop
        if continues || double {
            return (TapState(lastTime: time, lastX: x, acc: (continues ? state.acc : 0) + seekStep, side: side, accTime: time), side)
        }
        var next = state
        next.lastTime = time
        next.lastX = x
        return (next, 0)
    }

    static func fractionAt(_ x: CGFloat, _ width: CGFloat) -> CGFloat {
        guard width > 0, x.isFinite else { return 0 }
        return max(0, min(1, x / width))
    }

    static func scrubMove(_ position: CGFloat, _ dx: CGFloat, _ width: CGFloat, fine: Bool) -> CGFloat {
        guard width > 0, dx.isFinite else { return position }
        return max(0, min(1, position + dx / width * (fine ? fineFactor : 1)))
    }

    static func tooltipCenter(_ position: CGFloat, _ width: CGFloat) -> CGFloat { max(tooltipMin, min(tooltipMax, position)) * width }

    static func thumbTime(_ time: Double, _ duration: Double) -> Double {
        guard duration > 0, time.isFinite else { return 0 }
        let step = max(0.5, duration / 120)
        return max(0, min(duration, (time / step).rounded() * step))
    }

    static func chevronOpacity(_ phase: Double, _ index: Int, forward: Bool) -> CGFloat {
        let order = Double(forward ? index : 2 - index)
        let local = ((phase - order * 0.2).truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1)
        if local < 0.3 { return CGFloat(0.25 + 0.75 * (local / 0.3)) }
        if local < 0.7 { return CGFloat(1 - 0.75 * ((local - 0.3) / 0.4)) }
        return 0.25
    }
}

/// The player's own surface: an AVPlayerLayer.
private final class PlayerSurface: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

/// The reference's own full-screen video player (media/VideoPlayerView.tsx): its controls over a bare picture. One
/// tap shows or hides them (they hide by themselves while it plays); a double tap on a side seeks ±10 s and more
/// taps gather «20 секунд», «30 секунд»; press and hold plays at 2×; the bar seeks precisely when the finger is
/// pulled up; the gear opens its sheet — speed, «Заблокировать экран», picture in picture, «Сохранить для
/// просмотра без сети», «Поделиться».
final class VideoPlayerController: UIViewController, AVPictureInPictureControllerDelegate {
    private static let lockedNote = "Экран заблокирован. Удерживай, чтобы снять"
    private static let tooltipWidth: CGFloat = 180

    private let file: URL
    /// The temporary folder of the decrypted copy (removed on close), or nil when playing a kept file.
    private let folder: URL?
    private let attachment: [String: Any]?
    private let player: AVPlayer
    private let surface = PlayerSurface()
    private var pip: AVPictureInPictureController?
    private var inPip = false
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var rateObservation: NSKeyValueObservation?

    private var shown = true
    private var locked = false
    private var speed: Float = 1
    private var fill = false
    private var ended = false
    private var holding = false
    private var dragging = false
    private var fine = false
    private var sheetOpen = false
    private var settleUntil = Date.distantPast
    private var lastSeek = Date.distantPast
    private var taps = PlayerModel.TapState()
    private var hideTimer: Timer?
    private var tapTimer: Timer?
    private var burstTimer: Timer?
    private var noteTimer: Timer?
    private var position: CGFloat = 0
    private var dragStartY: CGFloat = 0
    private var dragLastX: CGFloat = 0
    private var frames: [Double: UIImage] = [:]
    private var frameOrder: [Double] = []
    private var frameBusy = false
    private var frameWanted: Double?
    private var framesOff = false
    private lazy var generator: AVAssetImageGenerator = {
        let made = AVAssetImageGenerator(asset: AVURLAsset(url: self.file))
        made.appliesPreferredTrackTransform = true
        made.maximumSize = CGSize(width: 320, height: 320)
        made.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
        made.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
        return made
    }()

    private let touchSurface = UIView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let errorLabel = UILabel()
    private let controls = UIView()
    private let dim = UIView()
    private let closeButton = UIButton(type: .system)
    private let pipButton = UIButton(type: .system)
    private let gearButton = UIButton(type: .system)
    private let playButton = UIButton(type: .system)
    private let clockPill = UIView()
    private let clockLabel = UILabel()
    private let fillButton = UIButton(type: .system)
    private let bar = SeekBar()
    private let tooltip = UIView()
    private let tooltipFrame = UIImageView()
    private let tooltipTime = UILabel()
    private let scrubHint = UILabel()
    private let hairline = UIView()
    private let hairlinePlayed = UIView()
    private let holdPill = UIView()
    private let holdLabel = UILabel()
    private let noteBox = UIView()
    private let noteLabel = UILabel()
    private let seekSide = SeekSideView()
    private let sheetDim = UIControl()
    private let sheet = UIView()
    private let sheetRows = UIStackView()
    private var chevronLink: CADisplayLink?
    private var chevronStart = CACurrentMediaTime()
    private var keepBusy = false
    /// The kept copy was removed while it played: deleted once the player is gone.
    private var forgetKept = false

    /// `onShare`: «Поделиться» (the system's share sheet of the decrypted file).
    init(file: URL, folder: URL?, attachment: [String: Any]?) {
        self.file = file
        self.folder = folder
        self.attachment = attachment
        self.player = AVPlayer(url: file)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { !shown }

    deinit {
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        chevronLink?.invalidate()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.clipsToBounds = true
        surface.playerLayer.player = player
        surface.playerLayer.videoGravity = .resizeAspect
        surface.isUserInteractionEnabled = false
        view.addSubview(surface)
        player.actionAtItemEnd = .pause
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [])
        let possible: AVPictureInPictureController? = AVPictureInPictureController.isPictureInPictureSupported() ? AVPictureInPictureController(playerLayer: surface.playerLayer) : nil
        if let made = possible {
            made.canStartPictureInPictureAutomaticallyFromInline = true
            made.delegate = self
            pip = made
        }

        // The touch surface is a sheet of its own; the controls above it take their own touches.
        touchSurface.isAccessibilityElement = true
        touchSurface.accessibilityTraits = .button
        view.addSubview(touchSurface)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        touchSurface.addGestureRecognizer(tap)
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.minimumPressDuration = PlayerModel.hold
        hold.allowableMovement = 24
        touchSurface.addGestureRecognizer(hold)
        view.addSubview(seekSide)
        seekSide.isUserInteractionEnabled = false
        seekSide.isHidden = true
        spinner.color = Theme.accent
        spinner.hidesWhenStopped = true
        spinner.startAnimating()
        view.addSubview(spinner)
        errorLabel.font = .systemFont(ofSize: 14)
        errorLabel.textColor = Theme.danger
        errorLabel.numberOfLines = 0
        errorLabel.textAlignment = .center
        errorLabel.isHidden = true
        view.addSubview(errorLabel)

        view.addSubview(controls)
        dim.backgroundColor = UIColor(white: 0, alpha: 0.5)
        dim.isUserInteractionEnabled = false
        controls.addSubview(dim)
        closeButton.setImage(chatSymbol("chevron.down", 24, .semibold), for: .normal)
        closeButton.accessibilityLabel = "Закрыть просмотр"
        closeButton.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        pipButton.setImage(chatSymbol("pip.enter", 21), for: .normal)
        pipButton.accessibilityLabel = "Картинка в картинке"
        pipButton.addTarget(self, action: #selector(startPip), for: .touchUpInside)
        pipButton.isHidden = pip == nil
        gearButton.setImage(chatSymbol("gearshape", 22), for: .normal)
        gearButton.accessibilityLabel = "Настройки"
        gearButton.addTarget(self, action: #selector(openMainSheet), for: .touchUpInside)
        for button in [closeButton, pipButton, gearButton, fillButton] {
            button.tintColor = .white
            controls.addSubview(button)
        }
        playButton.tintColor = .white
        playButton.backgroundColor = UIColor(white: 0, alpha: 0.3)
        playButton.layer.cornerRadius = 36
        playButton.addTarget(self, action: #selector(toggle), for: .touchUpInside)
        controls.addSubview(playButton)
        clockPill.backgroundColor = UIColor(white: 0, alpha: 0.3)
        clockPill.layer.cornerRadius = 14
        clockPill.isUserInteractionEnabled = false
        controls.addSubview(clockPill)
        clockPill.addSubview(clockLabel)
        fillButton.addTarget(self, action: #selector(toggleFill), for: .touchUpInside)
        bar.onBegin = { [weak self] (x: CGFloat, y: CGFloat) -> Void in self?.scrubBegan(x: x, y: y) }
        bar.onMove = { [weak self] (x: CGFloat, y: CGFloat) -> Void in self?.scrubMoved(x: x, y: y) }
        bar.onEnd = { [weak self] in self?.scrubEnded() }
        bar.isAccessibilityElement = true
        bar.accessibilityLabel = "Позиция воспроизведения"
        bar.accessibilityTraits = .adjustable
        bar.onStep = { [weak self] (forward: Bool) -> Void in self?.accessibilityStep(forward) }
        controls.addSubview(bar)
        tooltip.isUserInteractionEnabled = false
        tooltip.isHidden = true
        tooltipFrame.contentMode = .scaleAspectFill
        tooltipFrame.clipsToBounds = true
        tooltipFrame.layer.cornerRadius = 8
        tooltipFrame.layer.borderWidth = 2
        tooltipFrame.layer.borderColor = UIColor.white.cgColor
        tooltipFrame.backgroundColor = .black
        tooltip.addSubview(tooltipFrame)
        tooltipTime.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        tooltipTime.textColor = .white
        tooltipTime.textAlignment = .center
        VideoPlayerController.shadow(tooltipTime)
        tooltip.addSubview(tooltipTime)
        controls.addSubview(tooltip)
        scrubHint.font = .systemFont(ofSize: 13, weight: .medium)
        scrubHint.textColor = .white
        scrubHint.textAlignment = .center
        scrubHint.isHidden = true
        VideoPlayerController.shadow(scrubHint)
        controls.addSubview(scrubHint)

        hairline.backgroundColor = UIColor(white: 1, alpha: 0.2)
        hairline.isUserInteractionEnabled = false
        hairlinePlayed.backgroundColor = .white
        hairline.addSubview(hairlinePlayed)
        view.addSubview(hairline)
        holdPill.backgroundColor = UIColor(white: 0, alpha: 0.6)
        holdPill.layer.cornerRadius = 18
        holdPill.isHidden = true
        holdPill.isUserInteractionEnabled = false
        let holdWords = NSMutableAttributedString(string: "\(Int(PlayerModel.holdRate))× ", attributes: [.font: UIFont.systemFont(ofSize: 14, weight: .medium), .foregroundColor: UIColor.white])
        let forward = NSTextAttachment()
        forward.image = chatSymbol("forward.fill", 13)?.withTintColor(.white, renderingMode: .alwaysOriginal)
        holdWords.append(NSAttributedString(attachment: forward))
        holdLabel.attributedText = holdWords
        holdLabel.textAlignment = .center
        holdPill.addSubview(holdLabel)
        view.addSubview(holdPill)
        noteBox.backgroundColor = UIColor(white: 0, alpha: 0.65)
        noteBox.layer.cornerRadius = 18
        noteBox.isHidden = true
        noteBox.isUserInteractionEnabled = false
        noteLabel.font = .systemFont(ofSize: 13, weight: .medium)
        noteLabel.textColor = .white
        noteLabel.textAlignment = .center
        noteLabel.numberOfLines = 0
        noteBox.addSubview(noteLabel)
        view.addSubview(noteBox)

        sheetDim.backgroundColor = UIColor(white: 0, alpha: 0.4)
        sheetDim.accessibilityLabel = "Закрыть"
        sheetDim.addTarget(self, action: #selector(closeSheetTapped), for: .touchUpInside)
        sheetDim.isHidden = true
        view.addSubview(sheetDim)
        sheet.backgroundColor = UIColor(hex: 0x212121)
        sheet.layer.cornerRadius = 14
        sheet.isHidden = true
        let grip = UIView()
        grip.backgroundColor = UIColor(hex: 0x555555)
        grip.layer.cornerRadius = 2
        grip.tag = 900
        sheet.addSubview(grip)
        sheetRows.axis = .vertical
        sheet.addSubview(sheetRows)
        view.addSubview(sheet)

        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] (time: CMTime) -> Void in
            self?.timeUpdate(time.seconds)
        }
        statusObservation = player.currentItem?.observe(\.status, options: [.new]) { [weak self] (_: AVPlayerItem, _: NSKeyValueObservedChange<AVPlayerItem.Status>) -> Void in
            DispatchQueue.main.async { self?.statusChanged() }
        }
        rateObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] (_: AVPlayer, _: NSKeyValueObservedChange<AVPlayer.TimeControlStatus>) -> Void in
            DispatchQueue.main.async { self?.playingChanged() }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(playedToEnd), name: .AVPlayerItemDidPlayToEndTime, object: player.currentItem)
        NotificationCenter.default.addObserver(self, selector: #selector(wentBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        paint()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard player.rate == 0, !ended, position == 0 else { return }
        player.play()
        // Something else letting go of the audio session may pause a video that has only just started: it is started
        // again, twice at most, while it still stands at its beginning (the reference's nudges at 300 and 700 ms).
        for delay in [0.3, 0.7] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.player.rate == 0, self.player.currentTime().seconds < 0.4, self.player.currentItem?.status != .failed else { return }
                self.player.play()
            }
        }
        show(true)
    }

    private static func shadow(_ label: UILabel) {
        label.layer.shadowColor = UIColor.black.cgColor
        label.layer.shadowOffset = CGSize(width: 0, height: 1)
        label.layer.shadowRadius = 3
        label.layer.shadowOpacity = 1
    }

    // MARK: The player's state

    private var duration: Double {
        let value = player.currentItem?.duration.seconds ?? 0
        return value.isFinite && value > 0 ? value : 0
    }

    private var playing: Bool { player.timeControlStatus != .paused && !ended }

    private func statusChanged() {
        guard let item = player.currentItem else { return }
        switch item.status {
        case .readyToPlay:
            spinner.stopAnimating()
        case .failed:
            spinner.stopAnimating()
            errorLabel.isHidden = false
            errorLabel.text = "Устройство не смогло воспроизвести это видео. " + (item.error?.localizedDescription ?? "Можно сохранить файл и открыть совместимым проигрывателем.")
        default:
            break
        }
        paint()
    }

    private func playingChanged() {
        if player.timeControlStatus == .playing {
            ended = false
            if shown { show(true) }
        }
        paint()
    }

    private func timeUpdate(_ seconds: Double) {
        if let range = player.currentItem?.loadedTimeRanges.last?.timeRangeValue {
            bar.buffered = PlayerModel.fraction(range.end.seconds, duration)
        }
        // The bar belongs to the finger while it is dragged, and for a moment after.
        if dragging || Date() < settleUntil { return }
        position = PlayerModel.fraction(seconds, duration)
        paintTime(seconds)
    }

    @objc private func playedToEnd() {
        ended = true
        shown = true
        hideTimer?.invalidate()
        paint()
    }

    @objc private func wentBackground() {
        // The small window opens a moment after the app leaves the screen: if it has not, nothing keeps playing unseen.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, !self.inPip, UIApplication.shared.applicationState == .background else { return }
            self.player.pause()
        }
    }

    private func seek(to seconds: Double) -> Double {
        let length = duration
        let target = max(0, min(length, seconds))
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        if target < length - 0.25 { ended = false }
        return target
    }

    // MARK: Showing and hiding

    /// The simulator check: a note and the seek highlight stay up for the screenshot taken seconds later.
    private var demoHold = false

    private func say(_ words: String) {
        noteLabel.text = words
        noteBox.isHidden = false
        noteTimer?.invalidate()
        if demoHold { view.setNeedsLayout(); return }
        noteTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] (_: Timer) -> Void in self?.noteBox.isHidden = true }
        view.setNeedsLayout()
    }

    private func show(_ on: Bool) {
        if on && locked {
            say(VideoPlayerController.lockedNote)
            return
        }
        shown = on
        hideTimer?.invalidate()
        if on && playing && !dragging {
            hideTimer = Timer.scheduledTimer(withTimeInterval: PlayerModel.hideMs, repeats: false) { [weak self] (_: Timer) -> Void in
                guard let self, !self.dragging, !self.sheetOpen else { return }
                self.show(false)
            }
        }
        UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.18) { () -> Void in
            self.controls.alpha = self.shown ? 1 : 0
        }
        controls.isUserInteractionEnabled = shown && !locked
        hairline.isHidden = shown
        touchSurface.accessibilityLabel = shown ? "Скрыть управление" : "Показать управление"
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    private func paint() {
        let symbol = ended ? "arrow.clockwise" : playing ? "pause.fill" : "play.fill"
        playButton.setImage(chatSymbol(symbol, 34, .semibold), for: .normal)
        playButton.accessibilityLabel = ended ? "Смотреть сначала" : playing ? "Пауза" : "Воспроизвести"
        playButton.isHidden = dragging
        fillButton.setImage(chatSymbol(fill ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right", 19), for: .normal)
        fillButton.accessibilityLabel = fill ? "Исходный размер" : "Масштаб по экрану"
        holdPill.isHidden = !holding
        scrubHint.isHidden = !dragging
        scrubHint.text = fine ? "Точная перемотка" : "Потяни вверх для точной перемотки"
        tooltip.isHidden = !dragging
        bar.dragging = dragging
        paintTime(position * duration)
        view.setNeedsLayout()
    }

    private func paintTime(_ seconds: Double) {
        let words = NSMutableAttributedString(string: PlayerModel.clock(seconds), attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .medium), .foregroundColor: UIColor.white])
        words.append(NSAttributedString(string: " / " + PlayerModel.clock(duration), attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .medium), .foregroundColor: UIColor(white: 1, alpha: 0.7)]))
        clockLabel.attributedText = words
        tooltipTime.text = PlayerModel.clock(seconds)
        bar.position = position
        bar.accessibilityValue = PlayerModel.clock(seconds)
        hairlinePlayed.frame = CGRect(x: 0, y: 0, width: hairline.bounds.width * position, height: 2)
        if dragging { placeTooltip() }
        let pillWidth = ceil(clockLabel.intrinsicContentSize.width) + 16
        clockPill.frame.size = CGSize(width: pillWidth, height: 26)
        clockLabel.frame = CGRect(x: 8, y: 0, width: pillWidth - 16, height: 26)
    }

    // MARK: Buttons

    @objc private func closeNow() {
        dismiss(animated: true)
    }

    @objc private func toggle() {
        if ended {
            player.seek(to: .zero)
            player.play()
            ended = false
        } else if player.timeControlStatus != .paused {
            player.pause()
        } else {
            player.play()
        }
        show(true)
        paint()
    }

    @objc private func toggleFill() {
        fill.toggle()
        surface.playerLayer.videoGravity = fill ? .resizeAspectFill : .resizeAspect
        say(fill ? "Масштаб по экрану" : "Исходный размер")
        show(true)
        paint()
    }

    @objc private func startPip() {
        guard let pip, pip.isPictureInPicturePossible else {
            say("Окно не открылось")
            return
        }
        pip.startPictureInPicture()
    }

    /// Kept alive while the small window shows the film after the player itself was closed.
    private static var playingInWindow: VideoPlayerController?

    func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        inPip = true
        VideoPlayerController.playingInWindow = self
    }
    func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        inPip = false
        if presentingViewController == nil { cleanUp() }
        VideoPlayerController.playingInWindow = nil
    }
    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        inPip = false
        say("Окно не открылось")
    }

    // MARK: Taps and the hold on the picture

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        if locked {
            say(VideoPlayerController.lockedNote)
            return
        }
        let x = recognizer.location(in: view).x
        let now = CACurrentMediaTime()
        let (state, seekSideValue) = PlayerModel.tapStep(taps, x: x, time: now, width: view.bounds.width)
        taps = state
        tapTimer?.invalidate()
        if seekSideValue != 0 {
            seekTap(seekSideValue, seconds: state.acc)
            return
        }
        // A lone tap: the double-tap window is waited out first (never in the middle of a seek burst).
        tapTimer = Timer.scheduledTimer(withTimeInterval: PlayerModel.doubleTap, repeats: false) { [weak self] (_: Timer) -> Void in
            guard let self, !PlayerModel.burstActive(self.taps, CACurrentMediaTime()) else { return }
            self.show(!self.shown)
        }
    }

    private func seekTap(_ side: Int, seconds: Double) {
        // The controls step aside for the side highlight.
        shown = false
        hideTimer?.invalidate()
        controls.alpha = 0
        controls.isUserInteractionEnabled = false
        hairline.isHidden = false
        let target = seek(to: PlayerModel.seekTarget(player.currentTime().seconds, duration, Double(side) * PlayerModel.seekStep))
        position = PlayerModel.fraction(target, duration)
        paintTime(target)
        settleUntil = Date().addingTimeInterval(0.4)
        seekSide.show(side: side, seconds: Int(seconds))
        seekSide.isHidden = false
        if chevronLink == nil {
            chevronStart = CACurrentMediaTime()
            let link = CADisplayLink(target: self, selector: #selector(chevronTick))
            link.add(to: .main, forMode: .common)
            chevronLink = link
        }
        burstTimer?.invalidate()
        if demoHold { return }
        burstTimer = Timer.scheduledTimer(withTimeInterval: PlayerModel.seekBurst, repeats: false) { [weak self] (_: Timer) -> Void in
            guard let self else { return }
            self.seekSide.isHidden = true
            self.chevronLink?.invalidate()
            self.chevronLink = nil
            self.taps.acc = 0
            self.taps.side = 0
        }
        view.setNeedsLayout()
    }

    @objc private func chevronTick() {
        let phase = ((CACurrentMediaTime() - chevronStart) / 0.75).truncatingRemainder(dividingBy: 1)
        seekSide.phase = phase
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        switch recognizer.state {
        case .began:
            if locked {
                locked = false
                say("Блокировка снята")
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                return
            }
            guard player.timeControlStatus != .paused else { return }
            holding = true
            player.rate = PlayerModel.holdRate
            shown = false
            hideTimer?.invalidate()
            controls.alpha = 0
            controls.isUserInteractionEnabled = false
            hairline.isHidden = false
            paint()
        case .ended, .cancelled, .failed:
            guard holding else { return }
            holding = false
            player.rate = speed
            paint()
        default:
            break
        }
    }

    // MARK: The seek bar

    private func scrubBegan(x: CGFloat, y: CGFloat) {
        dragging = true
        fine = false
        hideTimer?.invalidate()
        dragStartY = y
        dragLastX = x
        position = PlayerModel.fractionAt(x, bar.bounds.width)
        tooltipFrame.image = nil
        let seconds = Double(position) * duration
        requestFrame(seconds)
        paint()
    }

    private func scrubMoved(x: CGFloat, y: CGFloat) {
        guard dragging else { return }
        if !fine && dragStartY - y > PlayerModel.finePull {
            fine = true
            UISelectionFeedbackGenerator().selectionChanged()
        }
        position = PlayerModel.scrubMove(position, x - dragLastX, bar.bounds.width, fine: fine)
        dragLastX = x
        let seconds = Double(position) * duration
        if Date().timeIntervalSince(lastSeek) >= PlayerModel.scrubSeek {
            lastSeek = Date()
            _ = seek(to: seconds)
        }
        requestFrame(seconds)
        paint()
    }

    private func scrubEnded() {
        guard dragging else { return }
        let target = seek(to: Double(position) * duration)
        settleUntil = Date().addingTimeInterval(0.4)
        dragging = false
        fine = false
        paintTime(target)
        show(true)
        paint()
    }

    private func accessibilityStep(_ forward: Bool) {
        let target = seek(to: PlayerModel.seekTarget(player.currentTime().seconds, duration, forward ? PlayerModel.seekStep : -PlayerModel.seekStep))
        position = PlayerModel.fraction(target, duration)
        paintTime(target)
    }

    /// One decode at a time, always for the newest place asked; at most 24 kept (the reference's FRAME_CACHE).
    private func requestFrame(_ seconds: Double) {
        guard !framesOff else { return }
        let at = PlayerModel.thumbTime(seconds, duration)
        if let cached = frames[at] {
            frameWanted = nil
            tooltipFrame.image = cached
            placeTooltip()
            return
        }
        frameWanted = at
        guard !frameBusy else { return }
        frameBusy = true
        nextFrame()
    }

    private func nextFrame() {
        guard let wanted = frameWanted, dragging else {
            frameBusy = false
            return
        }
        frameWanted = nil
        generator.generateCGImageAsynchronously(for: CMTime(seconds: wanted, preferredTimescale: 600)) { [weak self] (image: CGImage?, _: CMTime, error: Error?) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let image, error == nil else {
                    self.framesOff = true
                    self.frameBusy = false
                    return
                }
                let picture = UIImage(cgImage: image)
                if self.frames.count >= 24, let oldest = self.frameOrder.first {
                    self.frames[oldest] = nil
                    self.frameOrder.removeFirst()
                }
                self.frames[wanted] = picture
                self.frameOrder.append(wanted)
                if self.dragging {
                    self.tooltipFrame.image = picture
                    self.placeTooltip()
                }
                self.nextFrame()
            }
        }
    }

    private func placeTooltip() {
        let width = VideoPlayerController.tooltipWidth
        let center = PlayerModel.tooltipCenter(position, bar.bounds.width)
        var frameSize = CGSize.zero
        if let image = tooltipFrame.image {
            frameSize = image.size.width > image.size.height ? CGSize(width: 160, height: 90) : CGSize(width: 120, height: 160)
        }
        let height = frameSize.height + (frameSize.height > 0 ? 6 : 0) + 18
        tooltip.frame = CGRect(x: bar.frame.minX + center - width / 2, y: bar.frame.maxY - 44 - height, width: width, height: height)
        tooltipFrame.frame = CGRect(x: (width - frameSize.width) / 2, y: 0, width: frameSize.width, height: frameSize.height)
        tooltipFrame.isHidden = frameSize.height == 0
        tooltipTime.frame = CGRect(x: 0, y: height - 18, width: width, height: 18)
    }

    // MARK: The settings sheet

    @objc private func openMainSheet() { openSheet(speeds: false) }

    private func openSheet(speeds: Bool) {
        sheetOpen = true
        hideTimer?.invalidate()
        sheetRows.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if speeds {
            for value in PlayerModel.speeds {
                let row = SheetRow(symbol: value == speed ? "checkmark" : nil, words: PlayerModel.speedLabel(value), value: nil, current: value == speed)
                row.onTap = { [weak self] in self?.chooseSpeed(value) }
                sheetRows.addArrangedSubview(row)
            }
        } else {
            let speedRow = SheetRow(symbol: "speedometer", words: "Скорость воспроизведения", value: PlayerModel.speedLabel(speed), current: false)
            speedRow.onTap = { [weak self] in self?.openSheet(speeds: true) }
            sheetRows.addArrangedSubview(speedRow)
            let lockRow = SheetRow(symbol: "lock", words: "Заблокировать экран", value: nil, current: false)
            lockRow.onTap = { [weak self] in self?.lockScreen() }
            sheetRows.addArrangedSubview(lockRow)
            if pip != nil {
                let pipRow = SheetRow(symbol: "pip.enter", words: "Картинка в картинке", value: nil, current: false)
                pipRow.onTap = { [weak self] in
                    self?.closeSheet(then: { [weak self] in self?.startPip() })
                }
                sheetRows.addArrangedSubview(pipRow)
            }
            if let attachment {
                let kept = KeptMedia.isKept(attachment) && !forgetKept
                let keepRow = SheetRow(symbol: kept ? "checkmark.circle" : "icloud.and.arrow.down", words: kept ? "Сохранено для просмотра без сети" : "Сохранить для просмотра без сети", value: nil, current: false)
                keepRow.isEnabled = !keepBusy
                keepRow.onTap = { [weak self] in self?.toggleKeep() }
                sheetRows.addArrangedSubview(keepRow)
            }
            let shareRow = SheetRow(symbol: "square.and.arrow.up", words: "Поделиться", value: nil, current: false)
            shareRow.onTap = { [weak self] in
                self?.closeSheet(then: { [weak self] in self?.share() })
            }
            sheetRows.addArrangedSubview(shareRow)
        }
        let wasOpen = !sheet.isHidden
        sheet.isHidden = false
        sheetDim.isHidden = false
        view.setNeedsLayout()
        view.layoutIfNeeded()
        guard !wasOpen else { return }
        sheet.transform = CGAffineTransform(translationX: 0, y: sheet.bounds.height + 16)
        sheetDim.alpha = 0
        UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.22) { () -> Void in
            self.sheet.transform = .identity
            self.sheetDim.alpha = 1
        }
    }

    @objc private func closeSheetTapped() { closeSheet(then: nil) }

    private func closeSheet(then: (() -> Void)?) {
        sheetOpen = false
        UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.16, animations: { () -> Void in
            self.sheet.transform = CGAffineTransform(translationX: 0, y: self.sheet.bounds.height + 16)
            self.sheetDim.alpha = 0
        }, completion: { (_: Bool) -> Void in
            self.sheet.isHidden = true
            self.sheetDim.isHidden = true
            self.sheet.transform = .identity
        })
        if let then { then() } else { show(true) }
    }

    private func lockScreen() {
        closeSheet(then: { [weak self] in
            guard let self else { return }
            self.locked = true
            self.shown = false
            self.hideTimer?.invalidate()
            self.controls.alpha = 0
            self.controls.isUserInteractionEnabled = false
            self.hairline.isHidden = false
            self.say(VideoPlayerController.lockedNote)
            self.setNeedsUpdateOfHomeIndicatorAutoHidden()
        })
    }

    private func chooseSpeed(_ value: Float) {
        speed = value
        if player.timeControlStatus != .paused { player.rate = value }
        player.defaultRate = value
        closeSheet(then: nil)
    }

    private func toggleKeep() {
        guard let attachment, !keepBusy else { return }
        let kept = KeptMedia.isKept(attachment) && !forgetKept
        // Playing the kept file itself: it is not touched while it plays — it goes (or stays) once the player closes.
        if folder == nil {
            forgetKept = kept
            closeSheet(then: nil)
            say(kept ? "Убрано из сохранённых" : "Сохранено")
            return
        }
        keepBusy = true
        let source = file
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var now = false
            if kept { KeptMedia.remove(for: attachment) } else { now = KeptMedia.keep(source, for: attachment) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.keepBusy = false
                self.closeSheet(then: nil)
                self.say(now ? "Сохранено" : "Убрано из сохранённых")
            }
        }
    }

    private func share() {
        let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        activity.popoverPresentationController?.sourceView = gearButton
        present(activity, animated: true)
    }

    // MARK: Closing

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed || presentingViewController == nil else { return }
        // Picture in picture may still be showing the film: then it is left to finish there.
        if inPip { return }
        cleanUp()
    }

    /// The decrypted copy goes once nothing shows it any more.
    private func cleanUp() {
        player.pause()
        if let folder { try? FileManager.default.removeItem(at: folder) }
        if forgetKept, let attachment { KeptMedia.remove(for: attachment) }
    }

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        completionHandler(presentingViewController != nil)
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds, safe = view.safeAreaInsets
        surface.frame = bounds
        touchSurface.frame = bounds
        seekSide.frame = bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
        errorLabel.frame = CGRect(x: 16, y: bounds.midY - 60, width: bounds.width - 32, height: 120)
        controls.frame = bounds
        dim.frame = bounds
        let top = safe.top + 6
        closeButton.frame = CGRect(x: 6 + safe.left, y: top, width: 48, height: 48)
        gearButton.frame = CGRect(x: bounds.width - 6 - safe.right - 48, y: top, width: 48, height: 48)
        pipButton.frame = CGRect(x: gearButton.frame.minX - 48, y: top, width: 48, height: 48)
        playButton.frame = CGRect(x: bounds.midX - 36, y: bounds.midY - 36, width: 72, height: 72)
        let barY = bounds.height - safe.bottom - 4 - 30
        bar.frame = CGRect(x: 12 + safe.left, y: barY, width: bounds.width - 24 - safe.left - safe.right, height: 30)
        fillButton.frame = CGRect(x: bounds.width - 12 - safe.right - 48, y: barY - 48, width: 48, height: 48)
        clockPill.frame.origin = CGPoint(x: 12 + safe.left, y: barY - 24 - 13)
        scrubHint.frame = CGRect(x: 16, y: bounds.height - safe.bottom - 250 - 18, width: bounds.width - 32, height: 18)
        hairline.frame = CGRect(x: 0, y: bounds.height - 2, width: bounds.width, height: 2)
        hairlinePlayed.frame = CGRect(x: 0, y: 0, width: bounds.width * position, height: 2)
        let holdWidth = ceil(holdLabel.intrinsicContentSize.width) + 28
        holdPill.frame = CGRect(x: bounds.midX - holdWidth / 2, y: safe.top + 16, width: holdWidth, height: 34)
        holdLabel.frame = holdPill.bounds
        let noteSize = noteLabel.sizeThatFits(CGSize(width: bounds.width - 32 - 28, height: 200))
        let noteWidth = min(bounds.width - 32, ceil(noteSize.width) + 28)
        noteBox.frame = CGRect(x: bounds.midX - noteWidth / 2, y: bounds.height * 0.3, width: noteWidth, height: ceil(noteSize.height) + 16)
        noteLabel.frame = noteBox.bounds.insetBy(dx: 14, dy: 8)
        if dragging { placeTooltip() }
        sheetDim.frame = bounds
        let rowsHeight = CGFloat(sheetRows.arrangedSubviews.count) * 50
        let sheetHeight = min(max(160, bounds.height - safe.top - 24), 8 + 14 + rowsHeight + safe.bottom + 8)
        sheet.bounds = CGRect(x: 0, y: 0, width: bounds.width - 16 - safe.left - safe.right, height: sheetHeight)
        sheet.center = CGPoint(x: bounds.midX, y: bounds.height - 8 - sheetHeight / 2)
        sheet.viewWithTag(900)?.frame = CGRect(x: (sheet.bounds.width - 40) / 2, y: 10, width: 40, height: 4)
        sheetRows.frame = CGRect(x: 0, y: 22, width: sheet.bounds.width, height: rowsHeight)
    }

    #if targetEnvironment(simulator)
    /// `-videodemo player|sheet|locked|seek`: the player over a drawn sample video made here (no film of anyone).
    static func simulatorOpen(over host: UIViewController, state: String) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("invizent-view-demo-" + UUID().uuidString.lowercased(), isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("sample.mov")
        SampleMovie.write(to: file) { (made: Bool) -> Void in
            guard made else { return }
            let screen = VideoPlayerController(file: file, folder: folder, attachment: ["id": "sample-video", "encryption": ["fileKeyId": "sample"]])
            host.present(screen, animated: false) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    // The shot comes seconds later: «заблокировано» and «20 с» stay on screen for it.
                    screen.demoHold = state == "locked" || state == "seek"
                    switch state {
                    case "sheet": screen.openSheet(speeds: false)
                    case "speed": screen.openSheet(speeds: true)
                    case "locked": screen.lockScreen()
                    case "seek": screen.seekTap(1, seconds: 20)
                    default: screen.player.pause(); screen.show(true); screen.paint()
                    }
                }
            }
        }
    }
    #endif
}

#if targetEnvironment(simulator)
/// A few seconds of drawn colour written as a film, for the simulator's player check.
enum SampleMovie {
    static func write(to url: URL, done: @escaping (Bool) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let size = CGSize(width: 640, height: 360)
            guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else { DispatchQueue.main.async { done(false) }; return }
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 640, AVVideoHeightKey: 360])
            let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 640, kCVPixelBufferHeightKey as String: 360])
            writer.add(input)
            writer.startWriting()
            writer.startSession(atSourceTime: .zero)
            for index in 0..<90 {
                while !input.isReadyForMoreMediaData { usleep(2000) }
                var buffer: CVPixelBuffer?
                CVPixelBufferCreate(kCFAllocatorDefault, 640, 360, kCVPixelFormatType_32ARGB, nil, &buffer)
                guard let buffer else { continue }
                CVPixelBufferLockBaseAddress(buffer, [])
                if let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: 640, height: 360, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                           space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) {
                    let t = CGFloat(index) / 90
                    context.setFillColor(UIColor(hue: 0.58 + 0.08 * t, saturation: 0.5, brightness: 0.45, alpha: 1).cgColor)
                    context.fill(CGRect(origin: .zero, size: size))
                    context.setFillColor(UIColor(white: 1, alpha: 0.85).cgColor)
                    context.fillEllipse(in: CGRect(x: 80 + 400 * t, y: 130, width: 100, height: 100))
                }
                CVPixelBufferUnlockBaseAddress(buffer, [])
                adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
            }
            input.markAsFinished()
            writer.finishWriting {
                DispatchQueue.main.async { done(writer.status == .completed) }
            }
        }
    }
}
#endif

/// The seek bar: a track 3 pt high (5 while dragged), what is loaded, what is played, a 13 pt thumb (×1.6 while
/// dragged). The finger is taken the moment it goes down, so a plain tap on the bar seeks too.
private final class SeekBar: UIControl {
    var position: CGFloat = 0 { didSet { setNeedsLayout() } }
    var buffered: CGFloat = 0 { didSet { setNeedsLayout() } }
    var dragging = false {
        didSet {
            guard dragging != oldValue else { return }
            UIView.animate(withDuration: 0.1) { () -> Void in self.layoutIfNeeded(); self.thumb.transform = self.dragging ? CGAffineTransform(scaleX: 1.6, y: 1.6) : .identity }
            setNeedsLayout()
        }
    }
    var onBegin: ((CGFloat, CGFloat) -> Void)?
    var onMove: ((CGFloat, CGFloat) -> Void)?
    var onEnd: (() -> Void)?
    var onStep: ((Bool) -> Void)?
    private let track = UIView()
    private let loaded = UIView()
    private let played = UIView()
    private let thumb = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        track.backgroundColor = UIColor(white: 1, alpha: 0.22)
        track.clipsToBounds = true
        track.isUserInteractionEnabled = false
        addSubview(track)
        loaded.backgroundColor = UIColor(white: 1, alpha: 0.12)
        track.addSubview(loaded)
        played.backgroundColor = .white
        track.addSubview(played)
        thumb.backgroundColor = .white
        thumb.layer.cornerRadius = 6.5
        thumb.isUserInteractionEnabled = false
        addSubview(thumb)
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        let height: CGFloat = dragging ? 5 : 3
        track.frame = CGRect(x: 0, y: dragging ? 12 : 13, width: bounds.width, height: height)
        loaded.frame = CGRect(x: 0, y: 0, width: bounds.width * buffered, height: height)
        played.frame = CGRect(x: 0, y: 0, width: bounds.width * position, height: height)
        thumb.bounds = CGRect(x: 0, y: 0, width: 13, height: 13)
        thumb.center = CGPoint(x: position * bounds.width, y: 14.5)
    }

    override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        let point = touch.location(in: self)
        let global = touch.location(in: nil)
        onBegin?(point.x, global.y)
        return true
    }

    override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        let point = touch.location(in: self)
        let global = touch.location(in: nil)
        onMove?(point.x, global.y)
        return true
    }

    override func endTracking(_ touch: UITouch?, with event: UIEvent?) { onEnd?() }
    override func cancelTracking(with event: UIEvent?) { onEnd?() }

    override func accessibilityIncrement() { onStep?(true) }
    override func accessibilityDecrement() { onStep?(false) }
}

/// The half-ellipse a double tap lights on its side (the reference's SeekSide): a band 19 % of the width at the
/// edge, then a bulge 23 % wide, half an ellipse 120 % of the height tall; three running chevrons and the seconds.
private final class SeekSideView: UIView {
    private var side = 1
    private let label = UILabel()
    private let chevrons: [UIImageView] = (0..<3).map { _ in UIImageView() }
    var phase: Double = 0 { didSet { paintChevrons() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        contentMode = .redraw
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .white
        label.textAlignment = .center
        addSubview(label)
        for chevron in chevrons {
            chevron.tintColor = .white
            chevron.contentMode = .center
            addSubview(chevron)
        }
    }

    required init?(coder: NSCoder) { return nil }

    func show(side: Int, seconds: Int) {
        self.side = side
        label.text = "\(seconds) секунд"
        for chevron in chevrons { chevron.image = chatSymbol(side < 0 ? "arrowtriangle.left.fill" : "arrowtriangle.right.fill", 13) }
        paintChevrons()
        setNeedsDisplay()
        setNeedsLayout()
    }

    private func paintChevrons() {
        for (index, chevron) in chevrons.enumerated() { chevron.alpha = PlayerModel.chevronOpacity(phase, index, forward: side > 0) }
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let width = bounds.width, height = bounds.height
        let band = width * 0.19, bulge = width * 0.23, diameter = height * 1.2
        context.setFillColor(UIColor(white: 1, alpha: 0.14).cgColor)
        if side < 0 {
            context.fill(CGRect(x: 0, y: 0, width: band, height: height))
            context.saveGState()
            context.clip(to: CGRect(x: band, y: 0, width: bulge, height: height))
            context.fillEllipse(in: CGRect(x: band - bulge, y: (height - diameter) / 2, width: bulge * 2, height: diameter))
            context.restoreGState()
        } else {
            context.fill(CGRect(x: width - band, y: 0, width: band, height: height))
            context.saveGState()
            context.clip(to: CGRect(x: width - band - bulge, y: 0, width: bulge, height: height))
            context.fillEllipse(in: CGRect(x: width - band - bulge, y: (height - diameter) / 2, width: bulge * 2, height: diameter))
            context.restoreGState()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width, height = bounds.height
        let area = width * 0.42
        let centerX = side < 0 ? area / 2 : width - area / 2
        for (index, chevron) in chevrons.enumerated() {
            chevron.frame = CGRect(x: centerX - 24 + CGFloat(index) * 16, y: height / 2 - 20, width: 16, height: 16)
        }
        label.frame = CGRect(x: centerX - area / 2, y: height / 2 + 4, width: area, height: 18)
    }
}

/// One row of the player's sheet: an icon, the words, a value at the right; the chosen speed in blue.
private final class SheetRow: UIControl {
    var onTap: (() -> Void)?

    init(symbol: String?, words: String, value: String?, current: Bool) {
        super.init(frame: .zero)
        let color = current ? UIColor(hex: 0x3EA6FF) : UIColor.white
        let icon = UIImageView(image: symbol.flatMap { chatSymbol($0, 20) })
        icon.tintColor = color
        icon.contentMode = .center
        icon.translatesAutoresizingMaskIntoConstraints = false
        let label = UILabel()
        label.text = words
        label.font = .systemFont(ofSize: 16)
        label.textColor = color
        label.translatesAutoresizingMaskIntoConstraints = false
        let valueLabel = UILabel()
        valueLabel.text = value
        valueLabel.font = .systemFont(ofSize: 16)
        valueLabel.textColor = UIColor(hex: 0xAAAAAA)
        valueLabel.translatesAutoresizingMaskIntoConstraints = false
        for part in [icon, label, valueLabel] as [UIView] {
            part.isUserInteractionEnabled = false
            addSubview(part)
        }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 50),
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 24),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 20),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            valueLabel.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 8),
            valueLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            valueLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        isAccessibilityElement = true
        accessibilityLabel = value.map { words + ", " + $0 } ?? words
        accessibilityTraits = current ? [.button, .selected] : .button
        addTarget(self, action: #selector(fire), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(white: 1, alpha: 0.08) : .clear }
    }

    override var isEnabled: Bool {
        didSet { alpha = isEnabled ? 1 : 0.5 }
    }

    @objc private func fire() { onTap?() }
}
