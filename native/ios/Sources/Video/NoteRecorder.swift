import AVFoundation
import UIKit

/// The recorder of a round video message: the front camera in a circle over the dimmed chat, a ring that fills
/// in a minute (the longest take), the time, and three buttons — call off, stop and send, turn the camera.
/// The camera and the microphone are used only while this screen is open; both permissions are asked when it
/// first opens.
///
/// Reference: mobile/src/videonote/VideoNote.tsx (`VideoNoteRecorder`: front camera first, 60 s at most, the
/// wording) and mobile/modules/linea-photo/ios/VideoNoteCamera.swift (640×480 capture, 480×640 H.264 + AAC).
/// Video: the camera is the reference's own writer (Sources/Video/NoteCamera.swift) — both cameras at once where the
/// iPhone can, and the camera can be turned in the middle of a take; the circle turns like a card meanwhile
/// (VideoNote.tsx, TURN_HALF_MS 290). Before it is sent the file is written anew without metadata
/// (`VideoPrepare.prepare(small: true)`).
final class NoteRecorder: UIViewController {
    static let maxSeconds = 60.0
    static let noAccess = "Нужен доступ к камере и микрофону. Разреши их для Инвиза в настройках телефона."

    private let camera = NoteCamera()
    private var recording = false
    private var turning = false
    private let circle = UIView()
    private let ring = CAShapeLayer()
    private let heading = UILabel()
    private let problem = UILabel()
    private let closeButton = UIButton(type: .system)
    private let recordButton = UIButton(type: .system)
    private let flipButton = UIButton(type: .system)
    /// Video: «Вспышка» — the screen lights up for the front camera, the torch for the back one (VideoNote.tsx).
    private let flashButton = UIButton(type: .system)
    private let screenFlash = UIView()
    private var flash = false
    private var brightnessBefore: CGFloat?
    /// Video: pinch to zoom (0 = widest, 1 = up to 6× or the camera's limit), with its «2,0×» pill.
    private var zoom: CGFloat = 0
    private var zoomBase: CGFloat = 0
    private let zoomPill = UILabel()
    /// Video: the line under the circle («До 60 секунд · шифруется перед отправкой»).
    private let hint = UILabel()
    private var front = true
    private var ready = false
    private var keep = false
    private var startedAt: Date?
    private var clock: Timer?
    private let startAtOnce: Bool
    /// The take is finished (main queue): the recorded file, to be prepared and sent. Not called for a take
    /// that was called off.
    var onDone: ((URL) -> Void)?

    /// `startAtOnce`: opened by holding the composer's button — the take starts as soon as the camera is ready.
    init(startAtOnce: Bool) {
        self.startAtOnce = startAtOnce
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(white: 0, alpha: 0.82)
        circle.backgroundColor = Theme.surface2
        circle.clipsToBounds = true
        view.addSubview(circle)
        ring.fillColor = UIColor.clear.cgColor
        ring.strokeColor = Theme.danger.cgColor
        ring.lineWidth = 3
        ring.lineCap = .round
        ring.strokeEnd = 0
        view.layer.addSublayer(ring)
        heading.text = "Видеосообщение"
        heading.font = .monospacedDigitSystemFont(ofSize: 17, weight: .bold)
        heading.textColor = .white
        heading.textAlignment = .center
        view.addSubview(heading)
        problem.font = .systemFont(ofSize: 15)
        problem.textColor = .white
        problem.textAlignment = .center
        problem.numberOfLines = 0
        problem.isHidden = true
        view.addSubview(problem)

        closeButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .regular)), for: .normal)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor(white: 1, alpha: 0.14)
        closeButton.layer.cornerRadius = 26
        closeButton.accessibilityLabel = "Отменить видеосообщение"
        closeButton.addTarget(self, action: #selector(cancelTake), for: .touchUpInside)
        view.addSubview(closeButton)
        recordButton.layer.cornerRadius = 39
        recordButton.layer.borderWidth = 4
        recordButton.layer.borderColor = UIColor.white.cgColor
        recordButton.tintColor = .white
        recordButton.alpha = 0.4
        recordButton.isEnabled = false
        recordButton.addTarget(self, action: #selector(recordTapped), for: .touchUpInside)
        view.addSubview(recordButton)
        flipButton.setImage(UIImage(systemName: "arrow.triangle.2.circlepath.camera", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .regular)), for: .normal)
        flipButton.tintColor = .white
        flipButton.backgroundColor = UIColor(white: 1, alpha: 0.14)
        flipButton.layer.cornerRadius = 26
        flipButton.accessibilityLabel = "Сменить камеру"
        flipButton.addTarget(self, action: #selector(flip), for: .touchUpInside)
        view.addSubview(flipButton)
        // Video: the parts of the reference's recorder this screen had not had yet.
        screenFlash.backgroundColor = UIColor(red: 1, green: 0.965, blue: 0.91, alpha: 1)
        screenFlash.isHidden = true
        screenFlash.isUserInteractionEnabled = false
        view.insertSubview(screenFlash, at: 0)
        flashButton.tintColor = .white
        flashButton.layer.cornerRadius = 22
        flashButton.accessibilityLabel = "Вспышка"
        flashButton.accessibilityTraits = .button
        flashButton.addTarget(self, action: #selector(flashTapped), for: .touchUpInside)
        view.addSubview(flashButton)
        zoomPill.font = .systemFont(ofSize: 12, weight: .bold)
        zoomPill.textColor = .white
        zoomPill.textAlignment = .center
        zoomPill.backgroundColor = UIColor(white: 0, alpha: 0.45)
        zoomPill.layer.cornerRadius = 10
        zoomPill.clipsToBounds = true
        zoomPill.isHidden = true
        circle.addSubview(zoomPill)
        circle.addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))))
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = UIColor(white: 1, alpha: 0.6)
        hint.textAlignment = .center
        view.addSubview(hint)
        showFlash()
        showButtons()
        askAccess()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, height = view.bounds.height
        let side = min(300, width - 48)
        circle.frame = CGRect(x: (width - side) / 2, y: (height - side) / 2 - 40, width: side, height: side)
        circle.layer.cornerRadius = side / 2
        camera.layout(circle.bounds)
        ring.frame = view.bounds
        ring.path = UIBezierPath(arcCenter: CGPoint(x: circle.frame.midX, y: circle.frame.midY), radius: side / 2 + 6, startAngle: -CGFloat.pi / 2, endAngle: CGFloat.pi * 1.5, clockwise: true).cgPath
        heading.frame = CGRect(x: 24, y: circle.frame.minY - 56, width: width - 48, height: 24)
        problem.frame = CGRect(x: 32, y: circle.frame.maxY + 16, width: width - 64, height: 64)
        let line = min(height - view.safeAreaInsets.bottom - 70, circle.frame.maxY + 130)
        recordButton.frame = CGRect(x: width / 2 - 39, y: line - 39, width: 78, height: 78)
        closeButton.frame = CGRect(x: width / 2 - 39 - 40 - 52, y: line - 26, width: 52, height: 52)
        flipButton.frame = CGRect(x: width / 2 + 39 + 40, y: line - 26, width: 52, height: 52)
        // Video: the flash beside the circle's top, the zoom pill at the circle's foot, the hint under it.
        screenFlash.frame = view.bounds
        flashButton.frame = CGRect(x: circle.frame.maxX - 44, y: circle.frame.minY - 56, width: 44, height: 44)
        let pillWidth: CGFloat = 46
        zoomPill.frame = CGRect(x: (side - pillWidth) / 2, y: side - 14 - 18, width: pillWidth, height: 18)
        hint.frame = CGRect(x: 24, y: circle.frame.maxY + 14, width: width - 48, height: 16)
        hint.isHidden = !problem.isHidden
    }

    private func showButtons() {
        let recording = startedAt != nil
        let symbol = recording ? "arrow.up" : "circle.fill"
        recordButton.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: recording ? 28 : 44, weight: .bold)), for: .normal)
        recordButton.tintColor = recording ? .white : Theme.danger
        recordButton.accessibilityLabel = recording ? "Остановить и отправить" : "Начать запись"
        // Video: the camera turns in the middle of a take too (the writer keeps going).
        flipButton.isEnabled = ready
        flipButton.alpha = ready ? 1 : 0.4
        hint.text = recording ? "Нажми ещё раз, чтобы отправить" : "До 60 секунд · шифруется перед отправкой"
        showFlash()
    }

    // MARK: Video: the flash and the zoom

    @objc private func flashTapped() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        flash.toggle()
        showFlash()
    }

    /// The front camera's «flash» is the screen itself — warm white at full brightness — only while recording;
    /// the back camera's is its torch.
    private func showFlash() {
        let recording = startedAt != nil
        flashButton.setImage(UIImage(systemName: flash ? "bolt.fill" : "bolt.slash", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular)), for: .normal)
        flashButton.backgroundColor = flash ? UIColor(red: 1, green: 0.84, blue: 0.04, alpha: 0.28) : UIColor(white: 1, alpha: 0.14)
        flashButton.accessibilityValue = flash ? "включена" : "выключена"
        let lit = flash && front && recording
        if lit != !screenFlash.isHidden {
            screenFlash.isHidden = !lit
            if lit {
                brightnessBefore = view.window?.windowScene?.screen.brightness
                view.window?.windowScene?.screen.brightness = 1
            } else if let before = brightnessBefore {
                view.window?.windowScene?.screen.brightness = before
                brightnessBefore = nil
            }
        }
        camera.setTorch(flash && !front)
    }

    /// Pinch as in the reference: the scale moves the zoom by 0.6 of its change, between 0 and 1.
    @objc private func pinched(_ pinch: UIPinchGestureRecognizer) {
        switch pinch.state {
        case .began:
            zoomBase = zoom
        case .changed:
            zoom = min(1, max(0, zoomBase + (pinch.scale - 1) * 0.6))
            showZoom()
        default:
            break
        }
    }

    private func showZoom() {
        let shown = String(format: "%.1f", Double(1 + zoom * 5)).replacingOccurrences(of: ".", with: ",") + "×"
        zoomPill.text = shown
        zoomPill.isHidden = zoom <= 0.02
        camera.setZoom(zoom)
    }

    private func say(_ words: String) {
        problem.text = words
        problem.isHidden = false
    }

    // MARK: The camera

    private func askAccess() {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] (camera: Bool) -> Void in
            AVCaptureDevice.requestAccess(for: .audio) { (microphone: Bool) -> Void in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if camera && microphone { self.open() } else { self.say(NoteRecorder.noAccess) }
                }
            }
        }
    }

    private func open() {
        circle.insertSubview(camera.view, at: 0)
        camera.layout(circle.bounds)
        camera.onFailure = { [weak self] (words: String) -> Void in self?.say(words) }
        camera.onReady = { [weak self] in
            guard let self, !self.ready else { return }
            self.ready = true
            self.recordButton.isEnabled = true
            self.recordButton.alpha = 1
            self.showButtons()
            if self.startAtOnce { self.begin() }
        }
        camera.start(front: front)
    }

    /// The circle turns like a card around its vertical axis: 0 → 90° (edge-on, the camera switches) → −90° → 0,
    /// 290 ms each half; with reduced motion it switches at once.
    @objc private func flip() {
        guard ready, !turning else { return }
        front.toggle()
        // Video: a new camera starts at its widest; the flash follows the camera.
        zoom = 0
        zoomPill.isHidden = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if UIAccessibility.isReduceMotionEnabled {
            camera.flip()
            camera.setZoom(0)
            showFlash()
            return
        }
        turning = true
        var perspective = CATransform3DIdentity
        perspective.m34 = -1 / 900
        UIView.animate(withDuration: 0.29, delay: 0, options: [.curveEaseIn], animations: { () -> Void in
            self.circle.layer.transform = CATransform3DRotate(perspective, .pi / 2, 0, 1, 0)
        }, completion: { (_: Bool) -> Void in
            self.camera.flip()
            self.camera.setZoom(0)
            self.showFlash()
            self.circle.layer.transform = CATransform3DRotate(perspective, -.pi / 2, 0, 1, 0)
            UIView.animate(withDuration: 0.29, delay: 0, options: [.curveEaseOut], animations: { () -> Void in
                self.circle.layer.transform = CATransform3DIdentity
            }, completion: { (_: Bool) -> Void in
                self.turning = false
            })
        })
    }

    // MARK: The take

    @objc private func recordTapped() {
        if startedAt == nil { begin() } else { finish(keep: true) }
    }

    private func begin() {
        guard ready, startedAt == nil, !recording else { return }
        if MusicPlayer.shared.current != nil { MusicPlayer.shared.stop() }
        let file = VideoPrepare.freshFile("mp4")
        startedAt = Date()
        keep = false
        recording = true
        camera.startRecording(to: file) { [weak self] (ok: Bool) -> Void in
            guard let self, !ok else { return }
            self.recording = false
            self.startedAt = nil
            self.clock?.invalidate()
            self.clock = nil
            self.say("Не удалось начать запись видео.")
            self.showButtons()
        }
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in self?.ticked() }
        RunLoop.main.add(timer, forMode: .common)
        clock = timer
        showButtons()
    }

    private func ticked() {
        guard let startedAt else { return }
        let seconds = Date().timeIntervalSince(startedAt)
        heading.text = FileCore.call("voiceTimeFine", [Int(seconds * 1000)]) as? String ?? ""
        ring.strokeEnd = CGFloat(min(1, seconds / NoteRecorder.maxSeconds))
        // The longest take ends by itself and is sent.
        if seconds >= NoteRecorder.maxSeconds { finish(keep: true) }
    }

    private func finish(keep: Bool) {
        self.keep = keep
        clock?.invalidate()
        clock = nil
        guard recording else {
            close()
            return
        }
        recording = false
        let seconds = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        camera.stopRecording { [weak self] (file: URL?) -> Void in
            guard let self else { return }
            self.startedAt = nil
            if let file {
                if self.keep && seconds >= 1 { self.onDone?(file) } else { try? FileManager.default.removeItem(at: file) }
            }
            self.close()
        }
    }

    @objc private func cancelTake() {
        finish(keep: false)
    }

    private func close() {
        // Video: the screen's brightness comes back, the torch goes off.
        flash = false
        showFlash()
        camera.stop()
        dismiss(animated: true)
    }
}
