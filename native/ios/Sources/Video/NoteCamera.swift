import AVFoundation
import CoreImage
import UIKit

/// The round video's camera, ported from the reference's native module (mobile/modules/linea-photo/ios/
/// VideoNoteCamera.swift and VideoNoteMultiCam.swift): an AVAssetWriter writes a 480×640 H.264 + AAC MP4 from the
/// camera's frames, so the camera can be turned in the middle of a take — the file goes on. Where the iPhone can
/// stream both cameras at once (AVCaptureMultiCamSession) both run together and a turn only switches which
/// camera's frames are written and which preview is on top: instant, as the reference. Elsewhere one session swaps
/// its camera input; until the new camera gives an upright frame nothing new is written (the file holds the last
/// frame) and the circle shows that last frame, lightly blurred.
///
/// Not ported: the reference's RotationCoordinator corrections and remembered angles (the «default + 90°» rule is
/// used, as its first guess), the heat fallback that stops one of the two cameras, and the pause.
final class NoteCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    /// The preview, to be put into the circle (main thread).
    let view = UIView()
    /// The first upright frame arrived (main queue): the camera really shows a picture now.
    var onReady: (() -> Void)?
    var onFailure: ((String) -> Void)?
    /// «two cameras» or «one camera: why» — which recorder runs.
    private(set) var path = "one camera"

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "invizent.note.session")
    private let dataQueue = DispatchQueue(label: "invizent.note.data")
    private let videoOutput = AVCaptureVideoDataOutput()
    private let audioOutput = AVCaptureAudioDataOutput()
    private let previewLayer = AVCaptureVideoPreviewLayer()
    private let cover = UIImageView()
    private let ciContext = CIContext()
    private var videoInput: AVCaptureDeviceInput?
    private var defaultAngles: [String: CGFloat] = [:]

    // sessionQueue
    private var facing = "front"
    private var torch = false
    private var zoom: CGFloat = 0
    private var configured = false
    private var multiOn = false
    private let rig = NoteMultiCam.make()

    // dataQueue
    private var writer: AVAssetWriter?
    private var writerVideo: AVAssetWriterInput?
    private var writerAudio: AVAssetWriterInput?
    private var sessionStarted = false
    private var stopping = false
    private var lastVideoTime = CMTime.invalid
    private var firstFrameSent = false
    private var lastFrame: CVPixelBuffer?
    private var holding = false
    private var holdSince = CMTime.invalid
    private var holdFirst = CMTime.invalid
    private var holdToken = 0
    private var multiActive: AVCaptureOutput?

    // main thread
    private var flipToken = 0
    private var shownFacing = "front"
    private var revealed = false

    override init() {
        super.init()
        view.clipsToBounds = true
        view.backgroundColor = .clear
        previewLayer.session = session
        previewLayer.videoGravity = .resizeAspectFill
        previewLayer.opacity = 0
        view.layer.addSublayer(previewLayer)
        if let rig {
            for preview in [rig.front.preview, rig.back.preview] {
                preview.videoGravity = .resizeAspectFill
                preview.isHidden = true
                view.layer.addSublayer(preview)
            }
        }
        cover.contentMode = .scaleAspectFill
        cover.clipsToBounds = true
        cover.isHidden = true
        view.addSubview(cover)
    }

    /// Main thread, from the owner's layout.
    func layout(_ bounds: CGRect) {
        view.frame = bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer.frame = view.bounds
        rig?.front.preview.frame = view.bounds
        rig?.back.preview.frame = view.bounds
        CATransaction.commit()
        cover.frame = view.bounds
    }

    var isFront: Bool { shownFacing == "front" }

    // MARK: Starting and stopping

    func start(front: Bool) {
        shownFacing = front ? "front" : "back"
        sessionQueue.async {
            self.facing = front ? "front" : "back"
            if !self.configured {
                // Center Stage off before the camera is added (it would pan the picture inside the circle).
                if AVCaptureDevice.isCenterStageEnabled {
                    AVCaptureDevice.centerStageControlMode = .cooperative
                    AVCaptureDevice.isCenterStageEnabled = false
                }
                if let rig = self.rig, self.configureMulti(rig) {
                    self.path = "two cameras"
                    self.multiOn = true
                    self.configured = true
                } else {
                    if self.rig == nil { self.path = "one camera: multi-cam not supported on this device" }
                    self.configured = self.configure()
                    if self.configured { self.setAngles() }
                }
            }
            guard self.configured else { return }
            if self.multiOn, let rig = self.rig {
                rig.session.startRunning()
                if rig.session.isRunning {
                    self.applyTorch()
                    return
                }
                self.path = "one camera: the two-camera session did not start"
                self.abandonMulti(rig)
                self.configured = self.configure()
                if self.configured { self.setAngles() }
                guard self.configured else { return }
            }
            if !self.session.isRunning { self.session.startRunning() }
            self.applyTorch()
        }
    }

    /// Record: starts again after `stop()` («record more»); `onReady` comes again with the first frame.
    func restart(front: Bool) {
        dataQueue.async { self.firstFrameSent = false }
        start(front: front)
    }

    func stop() {
        sessionQueue.async {
            if let rig = self.rig, self.multiOn { rig.session.stopRunning() } else if self.session.isRunning { self.session.stopRunning() }
        }
    }

    private func fail(_ words: String) {
        DispatchQueue.main.async { self.onFailure?(words) }
    }

    private func device(for facing: String) -> AVCaptureDevice? {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: facing == "back" ? .back : .front) else { return nil }
        // The same SDR colour space on both cameras (no P3 / HDR switch when the camera turns).
        if camera.activeFormat.supportedColorSpaces.contains(.sRGB), (try? camera.lockForConfiguration()) != nil {
            camera.activeColorSpace = .sRGB
            camera.unlockForConfiguration()
        }
        return camera
    }

    private func configure() -> Bool {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.automaticallyConfiguresCaptureDeviceForWideColor = false
        if session.canSetSessionPreset(.vga640x480) { session.sessionPreset = .vga640x480 }
        guard let camera = device(for: facing), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
            fail("Камера недоступна.")
            return false
        }
        session.addInput(input)
        videoInput = input
        if let mic = AVCaptureDevice.default(for: .audio), let audio = try? AVCaptureDeviceInput(device: mic), session.canAddInput(audio) { session.addInput(audio) }
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        videoOutput.setSampleBufferDelegate(self, queue: dataQueue)
        if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }
        audioOutput.setSampleBufferDelegate(self, queue: dataQueue)
        if session.canAddOutput(audioOutput) { session.addOutput(audioOutput) }
        return true
    }

    /// The reference's upright rule: the connection's own default + 90° (90° on most iPhones, 0° on a camera
    /// mounted turned), else 90°; the front camera mirrored.
    private func orient(_ connection: AVCaptureConnection, key: String, mirrored: Bool) -> CGFloat? {
        let base = defaultAngles[key] ?? connection.videoRotationAngle
        defaultAngles[key] = base
        var chosen: CGFloat?
        for angle in [(base + 90).truncatingRemainder(dividingBy: 360), 90] where connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
            chosen = angle
            break
        }
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = mirrored
        }
        return chosen
    }

    private func setAngles() {
        let id = videoInput?.device.uniqueID ?? facing
        let mirrored = facing == "front"
        var upright: CGFloat?
        if let connection = videoOutput.connection(with: .video) { upright = orient(connection, key: "output|" + id, mirrored: mirrored) }
        if let preview = previewLayer.connection {
            for angle in [upright ?? 90, 90] where preview.isVideoRotationAngleSupported(angle) {
                preview.videoRotationAngle = angle
                break
            }
            if preview.isVideoMirroringSupported {
                preview.automaticallyAdjustsVideoMirroring = false
                preview.isVideoMirrored = mirrored
            }
        }
    }

    // MARK: Two cameras

    private func configureMulti(_ rig: NoteMultiCam) -> Bool {
        guard rig.findDevices() else {
            path = "one camera: front and back cannot stream together"
            return false
        }
        rig.session.beginConfiguration()
        rig.session.automaticallyConfiguresCaptureDeviceForWideColor = false
        var ok = rig.addOutputsAndMicrophone(delegate: self, queue: dataQueue)
        if ok { ok = rig.attach(rig.front) }
        if ok { ok = rig.attach(rig.back) }
        if ok { orientMulti(rig.front); orientMulti(rig.back) }
        rig.session.commitConfiguration()
        if ok && !rig.fitCost() {
            ok = false
            path = "one camera: too costly"
        }
        guard ok else {
            abandonMulti(rig)
            return false
        }
        let shown = rig.camera(facing)
        dataQueue.async {
            self.multiActive = shown.output
            DispatchQueue.main.async { self.showMulti(shown.facing) }
        }
        return true
    }

    private func orientMulti(_ camera: NoteMultiCam.Camera) {
        guard let id = camera.device?.uniqueID else { return }
        let mirrored = camera.position == .front
        var upright: CGFloat?
        if let connection = camera.dataConnection { upright = orient(connection, key: "output|" + id, mirrored: mirrored) }
        if let preview = camera.previewConnection {
            for angle in [upright ?? 90, 90] where preview.isVideoRotationAngleSupported(angle) {
                preview.videoRotationAngle = angle
                break
            }
            if preview.isVideoMirroringSupported {
                preview.automaticallyAdjustsVideoMirroring = false
                preview.isVideoMirrored = mirrored
            }
        }
    }

    private func abandonMulti(_ rig: NoteMultiCam) {
        rig.tearDown()
        multiOn = false
        defaultAngles.removeAll()
        dataQueue.async { self.multiActive = nil }
        DispatchQueue.main.async {
            rig.front.preview.isHidden = true
            rig.back.preview.isHidden = true
        }
    }

    /// Main thread: the shown camera's preview on top; both stay visible so each keeps its latest picture.
    private func showMulti(_ facing: String) {
        guard let rig, facing == shownFacing else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        rig.front.preview.isHidden = false
        rig.back.preview.isHidden = false
        rig.front.preview.zPosition = facing == "front" ? 1 : 0
        rig.back.preview.zPosition = facing == "back" ? 1 : 0
        CATransaction.commit()
    }

    // MARK: Turning the camera

    /// Main thread. Works while recording: the writer keeps going.
    func flip() {
        let next = shownFacing == "front" ? "back" : "front"
        shownFacing = next
        var token = 0
        let both = rig != nil && rig?.front.preview.isHidden == false
        if both {
            showMulti(next)
        } else if revealed {
            token = coverForFlip()
        }
        let release = token
        sessionQueue.async {
            if self.multiOn, let rig = self.rig {
                self.facing = next
                let camera = rig.camera(next)
                self.dataQueue.async { self.multiActive = camera.output }
                self.applyTorch()
                self.applyZoom()
                return
            }
            guard self.configured, next != self.facing, let camera = self.device(for: next), let input = try? AVCaptureDeviceInput(device: camera) else {
                if release != 0 { DispatchQueue.main.async { self.uncover(release) } }
                return
            }
            let previous = self.facing
            self.facing = next
            self.dataQueue.async {
                self.holding = true
                self.holdToken = release
                self.holdSince = .invalid
                self.holdFirst = .invalid
            }
            self.session.beginConfiguration()
            if let old = self.videoInput { self.session.removeInput(old) }
            if self.session.canAddInput(input) {
                self.session.addInput(input)
                self.videoInput = input
            } else if let old = self.videoInput, self.session.canAddInput(old) {
                self.session.addInput(old)
                self.facing = previous
            }
            self.setAngles()
            self.session.commitConfiguration()
            self.setAngles()
            self.applyTorch()
            self.applyZoom()
            let now = CMClockGetTime(self.session.synchronizationClock ?? CMClockGetHostTimeClock())
            self.dataQueue.async { if self.holding { self.holdSince = now } }
        }
    }

    /// Main thread: the last upright frame, lightly blurred, covers the circle until the new camera's first one.
    private func coverForFlip() -> Int {
        flipToken += 1
        let frame = dataQueue.sync { self.lastFrame }
        let image = frame.flatMap { snapshot($0) }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer.opacity = 0
        CATransaction.commit()
        cover.layer.removeAllAnimations()
        cover.image = image
        cover.alpha = 1
        cover.isHidden = image == nil
        return flipToken
    }

    private func uncover(_ token: Int) {
        guard token == flipToken else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer.opacity = 1
        CATransaction.commit()
        guard !cover.isHidden else { return }
        UIView.animate(withDuration: 0.15, delay: 0, options: [.beginFromCurrentState], animations: { () -> Void in
            self.cover.alpha = 0
        }, completion: { (finished: Bool) -> Void in
            if finished && token == self.flipToken {
                self.cover.isHidden = true
                self.cover.image = nil
            }
        })
    }

    private func snapshot(_ pixels: CVPixelBuffer) -> UIImage? {
        let small = CIImage(cvPixelBuffer: pixels).transformed(by: CGAffineTransform(scaleX: 0.5, y: 0.5))
        let extent = small.extent
        let image = small.clampedToExtent().applyingGaussianBlur(sigma: 5).cropped(to: extent)
        guard let made = ciContext.createCGImage(image, from: extent) else { return nil }
        return UIImage(cgImage: made)
    }

    /// dataQueue: a frame of the single session may be shown and written (the reference's flip hold).
    private func frameAllowed(portrait: Bool, at time: CMTime) -> Bool {
        guard holding else { return true }
        guard holdSince.isValid, CMTimeCompare(time, holdSince) >= 0 else { return false }
        let release = { () -> Void in
            self.holding = false
            let token = self.holdToken
            DispatchQueue.main.async { self.uncover(token) }
        }
        if CMTimeGetSeconds(CMTimeSubtract(time, holdSince)) >= 0.7 { release(); return true }
        guard portrait else { return false }
        if !holdFirst.isValid { holdFirst = time }
        let waited = CMTimeGetSeconds(CMTimeSubtract(time, holdFirst))
        let settling = videoInput.map { $0.device.isAdjustingFocus || $0.device.isAdjustingExposure } ?? false
        if waited < 0.03 || (settling && waited < 0.12) { return false }
        release()
        return true
    }

    // MARK: Torch and zoom

    /// Record: the microphone's peak right now, 0…1 (linear amplitude ÷ 16000 of 32768), for the composer's blob.
    func peakLevel() -> Float {
        let output = multiOn ? (rig?.audioOutput ?? audioOutput) : audioOutput
        guard let channel = output.connections.first?.audioChannels.first else { return 0 }
        let decibels = channel.peakHoldLevel
        guard decibels.isFinite else { return 0 }
        return min(1, max(0, powf(10, decibels / 20) * 32768 / 16000))
    }

    func setTorch(_ on: Bool) {
        sessionQueue.async {
            self.torch = on
            self.applyTorch()
        }
    }

    func setZoom(_ value: CGFloat) {
        sessionQueue.async {
            self.zoom = min(1, max(0, value))
            self.applyZoom()
        }
    }

    private var activeDevice: AVCaptureDevice? {
        if multiOn, let rig { return rig.camera(facing).device }
        return videoInput?.device
    }

    private func applyZoom() {
        guard let camera = activeDevice else { return }
        let top = min(camera.activeFormat.videoMaxZoomFactor, 6)
        let factor = max(camera.minAvailableVideoZoomFactor, min(top, 1 + zoom * (top - 1)))
        do {
            try camera.lockForConfiguration()
            camera.videoZoomFactor = factor
            camera.unlockForConfiguration()
        } catch {}
    }

    private func applyTorch() {
        let back: AVCaptureDevice? = multiOn ? rig?.back.device : (facing == "back" ? videoInput?.device : nil)
        guard let camera = back, camera.hasTorch, camera.isTorchModeSupported(.on) else { return }
        let mode: AVCaptureDevice.TorchMode = torch && facing == "back" ? .on : .off
        guard camera.torchMode != mode else { return }
        do {
            try camera.lockForConfiguration()
            camera.torchMode = mode
            camera.unlockForConfiguration()
        } catch {}
    }

    // MARK: Recording

    /// Starts writing to `url` (an MP4) from the next frame. `done` on the main queue: false if it cannot.
    func startRecording(to url: URL, done: @escaping (Bool) -> Void) {
        dataQueue.async {
            guard self.writer == nil else { DispatchQueue.main.async { done(false) }; return }
            try? FileManager.default.removeItem(at: url)
            guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { DispatchQueue.main.async { done(false) }; return }
            let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: 480,
                AVVideoHeightKey: 640,
                AVVideoScalingModeKey: AVVideoScalingModeResizeAspectFill,
                // One colour description for the whole take: the two cameras tag frames differently.
                AVVideoColorPropertiesKey: [
                    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
                ],
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_200_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel] as [String: Any],
            ])
            video.expectsMediaDataInRealTime = true
            let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: 1, AVSampleRateKey: 44_100, AVEncoderBitRateKey: 64_000])
            audio.expectsMediaDataInRealTime = true
            guard writer.canAdd(video), writer.canAdd(audio) else { DispatchQueue.main.async { done(false) }; return }
            writer.add(video)
            writer.add(audio)
            self.writer = writer
            self.writerVideo = video
            self.writerAudio = audio
            self.sessionStarted = false
            self.stopping = false
            self.lastVideoTime = .invalid
            DispatchQueue.main.async { done(true) }
        }
    }

    /// Finishes the file. `done` on the main queue: the file, or nil when nothing could be written.
    func stopRecording(done: @escaping (URL?) -> Void) {
        dataQueue.async {
            guard let writer = self.writer else { DispatchQueue.main.async { done(nil) }; return }
            self.stopping = true
            let reset = { () -> Void in
                self.writer = nil
                self.writerVideo = nil
                self.writerAudio = nil
                self.sessionStarted = false
                self.stopping = false
            }
            guard self.sessionStarted, writer.status == .writing else {
                writer.cancelWriting()
                reset()
                DispatchQueue.main.async { done(nil) }
                return
            }
            self.writerVideo?.markAsFinished()
            self.writerAudio?.markAsFinished()
            let url = writer.outputURL
            writer.finishWriting {
                self.dataQueue.async {
                    let ok = writer.status == .completed
                    reset()
                    DispatchQueue.main.async { done(ok ? url : nil) }
                }
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let multiVideo = rig?.camera(for: output) != nil
        let isVideo = multiVideo || output === videoOutput
        if isVideo {
            let pixels = CMSampleBufferGetImageBuffer(sampleBuffer)
            let portrait = pixels.map { CVPixelBufferGetWidth($0) <= CVPixelBufferGetHeight($0) } ?? false
            if multiVideo {
                guard output === multiActive, portrait else { return }
            } else {
                guard frameAllowed(portrait: portrait, at: time), portrait else { return }
            }
            lastFrame = pixels
            if !firstFrameSent {
                firstFrameSent = true
                DispatchQueue.main.async {
                    self.revealed = true
                    CATransaction.begin()
                    CATransaction.setAnimationDuration(0.15)
                    self.previewLayer.opacity = 1
                    CATransaction.commit()
                    self.onReady?()
                }
            }
        }
        guard let writer, !stopping, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        if isVideo {
            // After a switch between two running cameras the file's timestamps must keep rising.
            if lastVideoTime.isValid, CMTimeCompare(time, lastVideoTime) <= 0 { return }
            if !sessionStarted {
                guard writer.startWriting() else {
                    fail("Не удалось начать запись видео.")
                    return
                }
                writer.startSession(atSourceTime: time)
                sessionStarted = true
            }
            lastVideoTime = time
            if let input = writerVideo, input.isReadyForMoreMediaData { input.append(sampleBuffer) }
        } else if output === audioOutput || output === rig?.audioOutput {
            guard sessionStarted, let input = writerAudio, input.isReadyForMoreMediaData else { return }
            input.append(sampleBuffer)
        }
    }
}

/// Both cameras at once (the reference's VideoNoteMultiCam.swift, after Apple's AVMultiCamPiP sample): inputs and
/// outputs are added without connections and every connection is made explicitly.
final class NoteMultiCam {
    final class Camera {
        let position: AVCaptureDevice.Position
        let facing: String
        let output = AVCaptureVideoDataOutput()
        let preview = AVCaptureVideoPreviewLayer()
        var device: AVCaptureDevice?
        var input: AVCaptureDeviceInput?
        var dataConnection: AVCaptureConnection?
        var previewConnection: AVCaptureConnection?
        var attached: Bool { input != nil }

        init(position: AVCaptureDevice.Position) {
            self.position = position
            facing = position == .back ? "back" : "front"
        }
    }

    let session: AVCaptureMultiCamSession
    let audioOutput = AVCaptureAudioDataOutput()
    let front = Camera(position: .front)
    let back = Camera(position: .back)

    private init(session: AVCaptureMultiCamSession) { self.session = session }

    /// Nil where the hardware cannot run two cameras (the session class must not even be made there).
    static func make() -> NoteMultiCam? {
        guard AVCaptureMultiCamSession.isMultiCamSupported else { return nil }
        let rig = NoteMultiCam(session: AVCaptureMultiCamSession())
        for camera in [rig.front, rig.back] { camera.preview.setSessionWithNoConnection(rig.session) }
        return rig
    }

    func camera(_ facing: String) -> Camera { facing == "back" ? back : front }

    func camera(for output: AVCaptureOutput) -> Camera? {
        if output === front.output { return front }
        if output === back.output { return back }
        return nil
    }

    func findDevices() -> Bool {
        guard let frontDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let backDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { return false }
        let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .unspecified)
        guard discovery.supportedMultiCamDeviceSets.contains(where: { (set: Set<AVCaptureDevice>) -> Bool in set.contains(frontDevice) && set.contains(backDevice) }) else { return false }
        front.device = frontDevice
        back.device = backDevice
        return true
    }

    /// Multi-cam 4:2:0 formats at 30 fps, best first: 4:3, at least 480 px short side, at most 1280 long, small.
    static func formats(_ device: AVCaptureDevice) -> [AVCaptureDevice.Format] {
        func usable(_ format: AVCaptureDevice.Format) -> Bool {
            guard format.isMultiCamSupported else { return false }
            let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
            guard subtype == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || subtype == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange else { return false }
            return format.videoSupportedFrameRateRanges.contains { (range: AVFrameRateRange) -> Bool in range.minFrameRate <= 30 && 30 <= range.maxFrameRate }
        }
        func rank(_ format: AVCaptureDevice.Format) -> [Int] {
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let long = Int(max(size.width, size.height)), short = Int(min(size.width, size.height))
            let videoRange = CMFormatDescriptionGetMediaSubType(format.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ? 0 : 1
            return [short >= 480 ? 0 : 1, long * 3 == short * 4 ? 0 : 1, long * short, videoRange]
        }
        let sorted = { (list: [AVCaptureDevice.Format]) -> [AVCaptureDevice.Format] in
            list.sorted { (a: AVCaptureDevice.Format, b: AVCaptureDevice.Format) -> Bool in rank(a).lexicographicallyPrecedes(rank(b)) }
        }
        let small = device.formats.filter { (format: AVCaptureDevice.Format) -> Bool in
            guard usable(format) else { return false }
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            return max(size.width, size.height) <= 1280 && min(size.width, size.height) >= 360
        }
        if !small.isEmpty { return sorted(small) }
        return sorted(device.formats.filter(usable))
    }

    @discardableResult
    static func use(_ format: AVCaptureDevice.Format, on device: AVCaptureDevice) -> Bool {
        do { try device.lockForConfiguration() } catch { return false }
        defer { device.unlockForConfiguration() }
        device.activeFormat = format
        device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
        if format.supportedColorSpaces.contains(.sRGB) { device.activeColorSpace = .sRGB }
        return true
    }

    func attach(_ camera: Camera) -> Bool {
        guard !camera.attached else { return true }
        guard let device = camera.device, let format = NoteMultiCam.formats(device).first,
              let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return false }
        session.addInputWithNoConnections(input)
        guard NoteMultiCam.use(format, on: device),
              let port = input.ports(for: .video, sourceDeviceType: device.deviceType, sourceDevicePosition: device.position).first else {
            session.removeInput(input)
            return false
        }
        let data = AVCaptureConnection(inputPorts: [port], output: camera.output)
        guard session.canAddConnection(data) else {
            session.removeInput(input)
            return false
        }
        session.addConnection(data)
        let preview = AVCaptureConnection(inputPort: port, videoPreviewLayer: camera.preview)
        guard session.canAddConnection(preview) else {
            session.removeConnection(data)
            session.removeInput(input)
            return false
        }
        session.addConnection(preview)
        camera.input = input
        camera.dataConnection = data
        camera.previewConnection = preview
        return true
    }

    func addOutputsAndMicrophone(delegate: AVCaptureVideoDataOutputSampleBufferDelegate & AVCaptureAudioDataOutputSampleBufferDelegate, queue: DispatchQueue) -> Bool {
        for camera in [front, back] {
            camera.output.alwaysDiscardsLateVideoFrames = true
            camera.output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
            camera.output.setSampleBufferDelegate(delegate, queue: queue)
            guard session.canAddOutput(camera.output) else { return false }
            session.addOutputWithNoConnections(camera.output)
        }
        audioOutput.setSampleBufferDelegate(delegate, queue: queue)
        guard session.canAddOutput(audioOutput) else { return true }
        session.addOutputWithNoConnections(audioOutput)
        guard let mic = AVCaptureDevice.default(for: .audio), let input = try? AVCaptureDeviceInput(device: mic), session.canAddInput(input) else { return true }
        session.addInputWithNoConnections(input)
        let port = input.ports(for: .audio, sourceDeviceType: mic.deviceType, sourceDevicePosition: .unspecified).first ?? input.ports.first(where: { $0.mediaType == .audio })
        guard let audioPort = port else {
            session.removeInput(input)
            return true
        }
        let connection = AVCaptureConnection(inputPorts: [audioPort], output: audioOutput)
        if session.canAddConnection(connection) { session.addConnection(connection) } else { session.removeInput(input) }
        return true
    }

    /// Hardware and system-pressure cost must stay below 1.0: steps both cameras down to their smallest format once.
    func fitCost() -> Bool {
        if session.hardwareCost < 1.0 && session.systemPressureCost < 1.0 { return true }
        session.beginConfiguration()
        for camera in [front, back] where camera.attached {
            if let device = camera.device, let smallest = NoteMultiCam.formats(device).min(by: { (a: AVCaptureDevice.Format, b: AVCaptureDevice.Format) -> Bool in
                let x = CMVideoFormatDescriptionGetDimensions(a.formatDescription), y = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
                return Int(x.width) * Int(x.height) < Int(y.width) * Int(y.height)
            }) {
                NoteMultiCam.use(smallest, on: device)
            }
        }
        session.commitConfiguration()
        return session.hardwareCost < 1.0 && session.systemPressureCost < 1.0
    }

    func tearDown() {
        if session.isRunning { session.stopRunning() }
        session.beginConfiguration()
        for connection in session.connections { session.removeConnection(connection) }
        for input in session.inputs { session.removeInput(input) }
        for output in session.outputs { session.removeOutput(output) }
        session.commitConfiguration()
        for camera in [front, back] {
            camera.input = nil
            camera.dataConnection = nil
            camera.previewConnection = nil
        }
    }
}
