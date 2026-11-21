import AVFoundation
import UIKit

/// The recorder of a round video message: the front camera in a circle over the dimmed chat, a ring that fills
/// in a minute (the longest take), the time, and three buttons — call off, stop and send, turn the camera.
/// The camera and the microphone are used only while this screen is open; both permissions are asked when it
/// first opens.
///
/// Reference: mobile/src/videonote/VideoNote.tsx (`VideoNoteRecorder`: front camera first, 60 s at most, the
/// wording) and mobile/modules/linea-photo/ios/VideoNoteCamera.swift (640×480 capture, 480×640 H.264 + AAC).
/// The system's recorder writes a QuickTime file here; before it is sent it is written anew as an MP4 without
/// metadata (`VideoPrepare.prepare(small: true)`), which is what every other app plays.
final class NoteRecorder: UIViewController, AVCaptureFileOutputRecordingDelegate {
    static let maxSeconds = 60.0
    static let noAccess = "Нужен доступ к камере и микрофону. Разреши их для Инвиза в настройках телефона."

    private let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let work = DispatchQueue(label: "invizent.note.camera")
    private let circle = UIView()
    private var previewLayer: AVCaptureVideoPreviewLayer?
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
        previewLayer?.frame = circle.bounds
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
        // The camera is not turned in the middle of a take: the file would end there.
        flipButton.isEnabled = !recording && ready
        flipButton.alpha = recording ? 0.3 : 1
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
        let torch = flash && !front
        work.async { [weak self] in self?.applyTorch(torch) }
    }

    private var videoDevice: AVCaptureDevice? {
        session.inputs.compactMap { $0 as? AVCaptureDeviceInput }.first { $0.device.hasMediaType(.video) }?.device
    }

    /// Camera queue.
    private func applyTorch(_ on: Bool) {
        guard let device = videoDevice, device.hasTorch, device.isTorchModeSupported(on ? .on : .off) else { return }
        do {
            try device.lockForConfiguration()
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        } catch {}
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
        let wanted = zoom
        work.async { [weak self] in
            guard let device = self?.videoDevice else { return }
            let top = min(device.activeFormat.videoMaxZoomFactor, 6)
            let factor = max(device.minAvailableVideoZoomFactor, min(top, 1 + wanted * (top - 1)))
            do {
                try device.lockForConfiguration()
                device.videoZoomFactor = factor
                device.unlockForConfiguration()
            } catch {}
        }
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

    private func camera(front: Bool) -> AVCaptureDevice? {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: front ? .front : .back)
    }

    private func open() {
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = circle.bounds
        circle.layer.addSublayer(layer)
        previewLayer = layer
        let wantFront = front
        work.async { [weak self] in
            guard let self else { return }
            var failed = true
            // Video: Center Stage off before the camera is added (it would pan the picture inside the circle).
            if AVCaptureDevice.isCenterStageEnabled {
                AVCaptureDevice.centerStageControlMode = .cooperative
                AVCaptureDevice.isCenterStageEnabled = false
            }
            self.session.beginConfiguration()
            if self.session.canSetSessionPreset(.vga640x480) { self.session.sessionPreset = .vga640x480 }
            if let device = self.camera(front: wantFront), let video = try? AVCaptureDeviceInput(device: device), self.session.canAddInput(video) {
                self.session.addInput(video)
                if let microphone = AVCaptureDevice.default(for: .audio), let audio = try? AVCaptureDeviceInput(device: microphone), self.session.canAddInput(audio) {
                    self.session.addInput(audio)
                }
                if self.session.canAddOutput(self.output) {
                    self.session.addOutput(self.output)
                    self.output.maxRecordedDuration = CMTime(seconds: NoteRecorder.maxSeconds, preferredTimescale: 600)
                    failed = false
                }
            }
            self.session.commitConfiguration()
            if !failed {
                self.upright()
                self.session.startRunning()
            }
            DispatchQueue.main.async {
                if failed {
                    self.say("Камера недоступна.")
                    return
                }
                self.ready = true
                self.recordButton.isEnabled = true
                self.recordButton.alpha = 1
                self.showButtons()
                if self.startAtOnce { self.begin() }
            }
        }
    }

    /// The picture is written upright (the phone is held upright: the app is portrait only).
    private func upright() {
        guard let connection = output.connection(with: .video) else { return }
        if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
    }

    @objc private func flip() {
        guard ready, startedAt == nil else { return }
        front.toggle()
        // Video: a new camera starts at its widest; the flash follows the camera.
        zoom = 0
        zoomPill.isHidden = true
        showFlash()
        let wantFront = front
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        work.async { [weak self] in
            guard let self, let device = self.camera(front: wantFront), let next = try? AVCaptureDeviceInput(device: device) else { return }
            self.session.beginConfiguration()
            for input in self.session.inputs {
                if let old = input as? AVCaptureDeviceInput, old.device.hasMediaType(.video) { self.session.removeInput(old) }
            }
            if self.session.canAddInput(next) { self.session.addInput(next) }
            self.session.commitConfiguration()
            self.upright()
            let torch = self.flash && !wantFront
            self.applyTorch(torch)
        }
    }

    // MARK: The take

    @objc private func recordTapped() {
        if startedAt == nil { begin() } else { finish(keep: true) }
    }

    private func begin() {
        guard ready, startedAt == nil, !output.isRecording else { return }
        if MusicPlayer.shared.current != nil { MusicPlayer.shared.stop() }
        let file = VideoPrepare.freshFile("mov")
        startedAt = Date()
        keep = false
        output.startRecording(to: file, recordingDelegate: self)
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
    }

    private func finish(keep: Bool) {
        self.keep = keep
        clock?.invalidate()
        clock = nil
        if output.isRecording {
            output.stopRecording()
        } else {
            close()
        }
    }

    @objc private func cancelTake() {
        finish(keep: false)
    }

    private func close() {
        // Video: the screen's brightness comes back, the torch goes off.
        flash = false
        showFlash()
        work.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
        dismiss(animated: true)
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        // The longest take ends by itself with an «error» that says the file is whole: it is sent.
        var whole = error == nil
        if let error = error as NSError?, let finished = error.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool { whole = finished }
        let limit = (error as NSError?)?.code == AVError.Code.maximumDurationReached.rawValue
        DispatchQueue.main.async { [self] in
            clock?.invalidate()
            clock = nil
            let seconds = startedAt.map { Date().timeIntervalSince($0) } ?? 0
            startedAt = nil
            if whole && (keep || limit) && seconds >= 1 {
                onDone?(outputFileURL)
            } else {
                try? FileManager.default.removeItem(at: outputFileURL)
            }
            close()
        }
    }
}
