import AVFoundation
import UIKit

/// The round camera of a video message (owner's spec): while the composer's button is held (or the take is locked)
/// the chat is blurred behind it, the camera stands in a circle min(369, width − 24) wide, centred, its centre at
/// 40% of the height above the keyboard (never above the status bar); a ring of 4 pt, white at 60%, fills around
/// its edge in the minute a take may last. The circle comes up from below the screen (a 0.5 s spring, damping 0.8),
/// the blur fades in in 0.4 s and out in 0.25 s. Two 40 pt glass buttons stand 8 pt above the composer at the
/// left: turn the camera, and the flash (11 pt apart). Everything else of the take — the time, «slide to cancel»,
/// the lock, the blob — is the composer's (Sources/Voice/RecordControl.swift).
///
/// The camera and the microphone are used only while the circle is open. Video: the writer is
/// Sources/Video/NoteCamera.swift (both cameras at once where the iPhone can; the camera turns in the middle of a
/// take, covered by its last frame for an instant). Before it is sent the file is written anew without metadata
/// (`VideoPrepare.prepare(small: true)`).
final class NoteRecorder: NSObject {
    static let maxSeconds = 60.0
    static let noAccess = "Нужен доступ к камере и микрофону. Разреши их для Инвиза в настройках телефона."

    private let camera = NoteCamera()
    private weak var host: UIView?
    private weak var composer: UIView?
    private let blur = UIVisualEffectView(effect: nil)
    private let circle = UIView()
    private let ring = CAShapeLayer()
    private let flipGlass = GlassPill(interactive: false)
    private let flipButton = UIButton(type: .custom)
    private let flashGlass = GlassPill(interactive: false)
    private let flashButton = UIButton(type: .custom)
    private let problem = UILabel()
    private let zoomPill = UILabel()
    private let screenFlash = UIView()
    private var brightnessBefore: CGFloat?
    private var flash = false
    private var front = true
    private var zoom: CGFloat = 0
    private var zoomBase: CGFloat = 0
    private(set) var ready = false
    private var recording = false
    private var startedAt: Date?
    private var stoppedMs = 0
    private var clock: Timer?
    private var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var loopObserver: NSObjectProtocol?
    private var closed = false
    /// Record: the length of the parts recorded before this one («record more»): the time, the ring and the
    /// minute count them too.
    var baseMs = 0
    private var trimStart: Double = 0
    private var trimEnd: Double = 1
    private var timeObserver: Any?

    /// The longest take was reached (main queue).
    var onLimit: (() -> Void)?
    /// The camera could not start (main queue): the words for the person.
    var onFailure: ((String) -> Void)?

    /// `host`: the screen's view; `composer`: the composer, which stays above the blur.
    init(host: UIView, composer: UIView) {
        self.host = host
        self.composer = composer
        super.init()
    }

    deinit {
        if let loopObserver { NotificationCenter.default.removeObserver(loopObserver) }
    }

    /// Whether the camera and the microphone may be used: true, false, or nil when not asked yet.
    static var allowed: Bool? {
        let video = AVCaptureDevice.authorizationStatus(for: .video)
        let audio = AVCaptureDevice.authorizationStatus(for: .audio)
        if video == .authorized && audio == .authorized { return true }
        if video == .denied || video == .restricted || audio == .denied || audio == .restricted { return false }
        return nil
    }

    /// Asks for both (the system asks each once); the answer on the main queue.
    static func ask(_ done: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .video) { (camera: Bool) -> Void in
            AVCaptureDevice.requestAccess(for: .audio) { (microphone: Bool) -> Void in
                DispatchQueue.main.async { done(camera && microphone) }
            }
        }
    }

    // MARK: Opening

    /// Shows the circle and starts the camera; the take starts as soon as the first frame is there.
    func open() {
        guard let host, let composer else { return }
        let dark = Theme.dark
        blur.frame = host.bounds
        blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.insertSubview(blur, belowSubview: composer.superview === host ? composer : (topAncestor(of: composer, in: host) ?? composer))
        screenFlash.backgroundColor = UIColor(red: 1, green: 0.965, blue: 0.91, alpha: 1)
        screenFlash.isHidden = true
        screenFlash.isUserInteractionEnabled = false
        screenFlash.frame = blur.bounds
        screenFlash.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        blur.contentView.addSubview(screenFlash)
        circle.backgroundColor = Theme.surface2
        circle.clipsToBounds = true
        blur.contentView.addSubview(circle)
        ring.fillColor = UIColor.clear.cgColor
        ring.strokeColor = UIColor(white: 1, alpha: 0.6).cgColor
        ring.lineWidth = 4
        ring.lineCap = .round
        ring.strokeEnd = 0
        circle.layer.addSublayer(ring)
        zoomPill.font = .systemFont(ofSize: 12, weight: .bold)
        zoomPill.textColor = .white
        zoomPill.textAlignment = .center
        zoomPill.backgroundColor = UIColor(white: 0, alpha: 0.3)
        zoomPill.layer.cornerRadius = 10
        zoomPill.clipsToBounds = true
        zoomPill.isHidden = true
        circle.addSubview(zoomPill)
        circle.addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))))
        circle.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(circleTapped)))
        // The reference's error line (VideoNote.tsx): #FFB4B4, 13, centred, at most 320 wide, under the circle.
        problem.font = .systemFont(ofSize: 13)
        problem.textColor = UIColor(red: 1, green: 180 / 255, blue: 180 / 255, alpha: 1)
        problem.textAlignment = .center
        problem.numberOfLines = 0
        problem.isHidden = true
        blur.contentView.addSubview(problem)
        for (glass, button) in [(flipGlass, flipButton), (flashGlass, flashButton)] {
            glass.shape(radius: 20)
            glass.isUserInteractionEnabled = false
            blur.contentView.addSubview(glass)
            button.tintColor = RecordSpec.controlColor
            blur.contentView.addSubview(button)
        }
        flipButton.setImage(IonIcon.image("camera-reverse-outline", size: 24).withRenderingMode(.alwaysTemplate), for: .normal)
        flipButton.accessibilityLabel = "Сменить камеру"
        flipButton.addTarget(self, action: #selector(flip), for: .touchUpInside)
        flashButton.accessibilityLabel = "Вспышка"
        flashButton.addTarget(self, action: #selector(flashTapped), for: .touchUpInside)
        showFlash()
        layout()

        // In: the blur in 0.4 s, the circle up from below the screen, the buttons from 0.1 in 0.25 s.
        blur.effect = nil
        UIView.animate(withDuration: 0.4) { self.blur.effect = UIBlurEffect(style: dark ? .dark : .light) }
        let target = circle.center
        circle.center = CGPoint(x: target.x, y: host.bounds.height + circle.bounds.height / 2)
        UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.2, options: [], animations: { () -> Void in
            self.circle.center = target
        }, completion: nil)
        for view in [flipGlass, flipButton, flashGlass, flashButton] as [UIView] {
            view.alpha = 0.1
            view.transform = CGAffineTransform(scaleX: 0.01, y: 0.01)
        }
        UIView.animate(withDuration: 0.25) {
            for view in [self.flipGlass, self.flipButton, self.flashGlass, self.flashButton] as [UIView] {
                view.alpha = 1
                view.transform = .identity
            }
        }

        circle.insertSubview(camera.view, at: 0)
        camera.layout(circle.bounds)
        camera.onFailure = { [weak self] (words: String) -> Void in self?.fail(words) }
        camera.onReady = { [weak self] in
            guard let self, !self.ready else { return }
            self.ready = true
            self.begin()
        }
        if MusicPlayer.shared.current != nil { MusicPlayer.shared.stop() }
        camera.start(front: front)
        NotificationCenter.default.addObserver(self, selector: #selector(relayout), name: UIResponder.keyboardDidChangeFrameNotification, object: nil)
    }

    private func topAncestor(of view: UIView, in host: UIView) -> UIView? {
        var current: UIView? = view
        while let item = current, item.superview !== host { current = item.superview }
        return current
    }

    @objc private func relayout() { layout() }

    /// Places everything (after the host's layout too).
    func layout() {
        guard let host, let composer else { return }
        let width = host.bounds.width, height = host.bounds.height
        let side = min(369, width - 24)
        let statusBar = host.window?.windowScene?.statusBarManager?.statusBarFrame.height ?? host.safeAreaInsets.top
        let available = height
        let y = max(statusBar, available * 0.4 - side / 2)
        let center = CGPoint(x: width / 2, y: y + side / 2)
        circle.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        if circle.layer.animation(forKey: "position") == nil { circle.center = center }
        circle.layer.cornerRadius = side / 2
        camera.layout(circle.bounds)
        playerLayer?.frame = circle.bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.bounds = circle.bounds
        ring.position = CGPoint(x: side / 2, y: side / 2)
        ring.path = UIBezierPath(ovalIn: circle.bounds.insetBy(dx: 4, dy: 4)).cgPath
        ring.setAffineTransform(CGAffineTransform(rotationAngle: -.pi / 2))
        CATransaction.commit()
        zoomPill.frame = CGRect(x: (side - 46) / 2, y: side - 24 - 9, width: 46, height: 18)
        let problemWidth = min(320, width - 64)
        let problemHeight = ceil(problem.sizeThatFits(CGSize(width: problemWidth, height: 200)).height)
        problem.frame = CGRect(x: (width - problemWidth) / 2, y: y + side + 18, width: problemWidth, height: problemHeight)
        // The buttons: 8 pt above the composer, 8 pt from the left (26 on a phone without a home indicator).
        let panelTop = composer.convert(composer.bounds, to: host).minY
        let sideInset: CGFloat = host.safeAreaInsets.bottom <= 32 ? 26 : 8
        let buttonY = panelTop - 8 - 40
        flipGlass.bounds = CGRect(x: 0, y: 0, width: 40, height: 40)
        flipGlass.center = CGPoint(x: sideInset + 20, y: buttonY + 20)
        flipButton.bounds = flipGlass.bounds
        flipButton.center = flipGlass.center
        flashGlass.bounds = flipGlass.bounds
        flashGlass.center = CGPoint(x: 40 + sideInset + 11 + 20, y: buttonY + 20)
        flashButton.bounds = flashGlass.bounds
        flashButton.center = flashGlass.center
    }

    private func fail(_ words: String) {
        problem.text = words
        problem.isHidden = false
        layout()
        onFailure?(words)
    }

    // MARK: The take

    private func begin() {
        guard ready, !recording, !closed else { return }
        let file = VideoPrepare.freshFile("mp4")
        startedAt = Date()
        recording = true
        camera.startRecording(to: file) { [weak self] (ok: Bool) -> Void in
            guard let self, !ok else { return }
            self.recording = false
            self.startedAt = nil
            self.fail("Не удалось начать запись видео.")
        }
        clock?.invalidate()
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in self?.ticked() }
        RunLoop.main.add(timer, forMode: .common)
        clock = timer
        showFlash()
    }

    /// How long the take is by now.
    var elapsedMs: Int {
        guard let startedAt else { return baseMs + stoppedMs }
        return baseMs + Int(Date().timeIntervalSince(startedAt) * 1000)
    }

    /// The microphone's peak right now, 0…1 (for the blob).
    var level: CGFloat { CGFloat(camera.peakLevel()) }

    private func ticked() {
        let seconds = Double(elapsedMs) / 1000
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.strokeEnd = CGFloat(min(1, seconds / NoteRecorder.maxSeconds))
        CATransaction.commit()
        if seconds >= NoteRecorder.maxSeconds {
            clock?.invalidate()
            clock = nil
            onLimit?()
        }
    }

    /// Stops the take: the file (nil when it is called off, or too short, or failed). `keep` false deletes it.
    func stop(keep: Bool, done: @escaping (URL?, Int) -> Void) {
        clock?.invalidate()
        clock = nil
        let ms = elapsedMs - baseMs
        stoppedMs = ms
        startedAt = nil
        guard recording else {
            done(nil, 0)
            return
        }
        recording = false
        flash = false
        showFlash()
        camera.stopRecording { (file: URL?) -> Void in
            guard let file else {
                done(nil, ms)
                return
            }
            if keep {
                done(file, ms)
            } else {
                try? FileManager.default.removeItem(at: file)
                done(nil, ms)
            }
        }
    }

    /// The stopped take plays round and round in the circle (the camera is off by then); a tap pauses it.
    func showResult(_ file: URL) {
        camera.stop()
        let made = AVPlayer(url: file)
        let shown = AVPlayerLayer(player: made)
        shown.videoGravity = .resizeAspectFill
        shown.frame = circle.bounds
        circle.layer.insertSublayer(shown, below: ring)
        player = made
        playerLayer = shown
        trimStart = 0
        trimEnd = 1
        loopObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: made.currentItem, queue: .main) { [weak self] (_: Notification) -> Void in
            self?.loopBack()
        }
        // The kept part plays round and round.
        timeObserver = made.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] (time: CMTime) -> Void in
            guard let self, let item = self.player?.currentItem else { return }
            let total = item.duration.seconds
            guard total.isFinite, total > 0 else { return }
            if time.seconds / total >= self.trimEnd { self.loopBack() }
        }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
        made.play()
        UIView.animate(withDuration: 0.2) {
            for view in [self.flipGlass, self.flipButton, self.flashGlass, self.flashButton] as [UIView] {
                view.alpha = 0
                view.transform = CGAffineTransform(scaleX: 0.01, y: 0.01)
            }
        }
        ring.strokeEnd = 0
    }

    private func loopBack() {
        guard let player, let item = player.currentItem else { return }
        let total = item.duration.seconds
        let start = total.isFinite ? total * trimStart : 0
        player.seek(to: CMTime(seconds: start, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        player.play()
    }

    /// Record: the kept part of the stopped take changed (fractions); playing stops while a handle moves and goes
    /// on from the kept part's start when it is let go.
    func setTrim(start: Double, end: Double, done: Bool) {
        trimStart = start
        trimEnd = end
        guard let player, let item = player.currentItem else { return }
        let total = item.duration.seconds
        guard total.isFinite else { return }
        player.pause()
        player.seek(to: CMTime(seconds: total * (done ? start : end), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        if done { player.play() }
    }

    /// Record: «record more» — the stopped take's playing ends and the camera records the next part.
    func resume(after ms: Int) {
        baseMs = ms
        stoppedMs = 0
        player?.pause()
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let loopObserver { NotificationCenter.default.removeObserver(loopObserver) }
        loopObserver = nil
        playerLayer?.removeFromSuperlayer()
        playerLayer = nil
        player = nil
        UIView.animate(withDuration: 0.2) {
            for view in [self.flipGlass, self.flipButton, self.flashGlass, self.flashButton] as [UIView] {
                view.alpha = 1
                view.transform = .identity
            }
        }
        ready = false
        camera.restart(front: front)
    }

    /// Play / pause of the stopped take.
    func togglePlayback() -> Bool {
        guard let player else { return false }
        if player.rate > 0 { player.pause() } else { player.play() }
        return player.rate > 0
    }

    @objc private func circleTapped() {
        _ = togglePlayback()
    }

    /// Everything goes: the camera stops, the blur fades out in 0.25 s, the buttons in 0.15 s, the circle in 0.25 s.
    func close() {
        guard !closed else { return }
        closed = true
        NotificationCenter.default.removeObserver(self)
        clock?.invalidate()
        clock = nil
        player?.pause()
        flash = false
        showFlash()
        camera.stop()
        UIView.animate(withDuration: 0.15) {
            for view in [self.flipGlass, self.flipButton, self.flashGlass, self.flashButton] as [UIView] { view.alpha = 0 }
        }
        UIView.animate(withDuration: 0.25, animations: { () -> Void in
            self.blur.effect = nil
            self.circle.alpha = 0
            self.problem.alpha = 0
        }, completion: { (_: Bool) -> Void in
            self.blur.removeFromSuperview()
        })
    }

    // MARK: The buttons

    /// The camera turns at once (its last frame covers the circle for an instant), during a take too.
    @objc private func flip() {
        guard ready, !closed else { return }
        front.toggle()
        zoom = 0
        zoomPill.isHidden = true
        camera.flip()
        camera.setZoom(0)
        showFlash()
    }

    @objc private func flashTapped() {
        flash.toggle()
        showFlash()
    }

    /// The front camera's flash is the screen itself (warm white at full brightness) while recording; the back
    /// camera's is its torch.
    private func showFlash() {
        flashButton.setImage(IonIcon.image(flash ? "flash-outline" : "flash-off-outline", size: 24).withRenderingMode(.alwaysTemplate), for: .normal)
        flashButton.accessibilityValue = flash ? "включена" : "выключена"
        let lit = flash && front && recording
        if lit != !screenFlash.isHidden {
            screenFlash.isHidden = !lit
            let screen = host?.window?.windowScene?.screen
            if lit {
                brightnessBefore = screen?.brightness
                screen?.brightness = 1
            } else if let before = brightnessBefore {
                screen?.brightness = before
                brightnessBefore = nil
            }
        }
        camera.setTorch(flash && !front && recording)
    }

    /// Pinch: the scale moves the zoom by 0.6 of its change, between 0 and 1 (up to 6× or the camera's limit).
    @objc private func pinched(_ pinch: UIPinchGestureRecognizer) {
        switch pinch.state {
        case .began:
            zoomBase = zoom
        case .changed:
            zoom = min(1, max(0, zoomBase + (pinch.scale - 1) * 0.6))
            zoomPill.text = String(format: "%.1f", Double(1 + zoom * 5)).replacingOccurrences(of: ".", with: ",") + "×"
            zoomPill.isHidden = zoom <= 0.02
            camera.setZoom(zoom)
        default:
            break
        }
    }

}

extension NoteRecorder {
    /// Record: the parts of a round video («record more») joined one after another and cut to the kept part
    /// (`from`…`to`, fractions of the whole), copied as they are (nothing encoded again) into a new .mp4. A single
    /// part kept whole is handed back as it is. Main queue for `done`.
    static func join(_ parts: [URL], from: Double, to: Double, done: @escaping (URL?) -> Void) {
        let whole = from <= 0.0005 && to >= 0.9995
        if parts.count == 1 && whole {
            done(parts[0])
            return
        }
        let made = AVMutableComposition()
        guard let video = made.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            done(nil)
            return
        }
        let audio = made.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        var cursor = CMTime.zero
        for part in parts {
            let asset = AVURLAsset(url: part)
            let range = CMTimeRange(start: .zero, duration: asset.duration)
            if let source = asset.tracks(withMediaType: .video).first {
                try? video.insertTimeRange(range, of: source, at: cursor)
                video.preferredTransform = source.preferredTransform
            }
            if let source = asset.tracks(withMediaType: .audio).first {
                try? audio?.insertTimeRange(range, of: source, at: cursor)
            }
            cursor = CMTimeAdd(cursor, asset.duration)
        }
        guard let export = AVAssetExportSession(asset: made, presetName: AVAssetExportPresetPassthrough) else {
            done(nil)
            return
        }
        let target = VideoPrepare.freshFile("mp4")
        export.outputURL = target
        export.outputFileType = .mp4
        let seconds = cursor.seconds
        if !whole {
            export.timeRange = CMTimeRange(start: CMTime(seconds: seconds * from, preferredTimescale: 600), end: CMTime(seconds: seconds * to, preferredTimescale: 600))
        }
        export.exportAsynchronously {
            let ok = export.status == .completed
            DispatchQueue.main.async {
                if ok { done(target) } else {
                    try? FileManager.default.removeItem(at: target)
                    done(nil)
                }
            }
        }
    }

    /// Record: `count` square frames spread over the video, for the preview's strip (main queue for `done`).
    static func frames(of file: URL, count: Int, side: CGFloat, done: @escaping ([UIImage]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let asset = AVURLAsset(url: file)
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: side * 3, height: side * 3)
            generator.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 10)
            generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 10)
            let total = asset.duration.seconds
            var images: [UIImage] = []
            if total.isFinite && total > 0 {
                for index in 0..<max(1, count) {
                    let at = CMTime(seconds: total * (Double(index) + 0.5) / Double(max(1, count)), preferredTimescale: 600)
                    if let picture = try? generator.copyCGImage(at: at, actualTime: nil) { images.append(UIImage(cgImage: picture)) }
                }
            }
            DispatchQueue.main.async { done(images) }
        }
    }
}
