import AVFoundation
import CoreImage
import ExpoModulesCore
import UIKit

// Round video messages on iPhone: one AVCaptureSession whose camera input can be swapped while an
// AVAssetWriter keeps writing the same MP4 (expo-camera's recordAsync stops when the camera flips).
// Written from Apple's AVFoundation documentation; the same JS interface as the Android module
// (VideoNoteCamera.kt): a view with `facing`, `startRecording(path)` and `stopRecording()`.
public class VideoNoteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LineaVideoNote")
    View(VideoNoteView.self) {
      Events("onReady", "onCameraError")
      Prop("facing") { (view: VideoNoteView, facing: String) in view.setFacing(facing) }
      Prop("torch") { (view: VideoNoteView, on: Bool) in view.setTorch(on) }
      Prop("zoom") { (view: VideoNoteView, zoom: Double) in view.setZoom(zoom) }
      AsyncFunction("startRecording") { (view: VideoNoteView, path: String, promise: Promise) in view.start(path: path, promise: promise) }
      AsyncFunction("stopRecording") { (view: VideoNoteView, promise: Promise) in view.stop(promise: promise) }
      AsyncFunction("pauseRecording") { (view: VideoNoteView, paused: Bool) in view.setPaused(paused) }
    }
  }
}

final class VideoNoteView: ExpoView, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
  let onReady = EventDispatcher()
  let onCameraError = EventDispatcher()

  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "linea.videonote.session")
  private let dataQueue = DispatchQueue(label: "linea.videonote.data")
  private let videoOutput = AVCaptureVideoDataOutput()
  private let audioOutput = AVCaptureAudioDataOutput()
  private let previewLayer = AVCaptureVideoPreviewLayer()
  private var videoInput: AVCaptureDeviceInput?
  private var facing = "front"
  private var torch = false
  private var zoom = 0.0
  private var configured = false
  // dataQueue: the first upright frame of this session was shown (onReady sent, placeholder faded out).
  private var firstFrameSent = false
  /// The last picture of the previous recorder, lightly blurred (main thread only). A new recorder shows it
  /// at once while the camera starts, as Telegram does, instead of an empty circle.
  private static var placeholder: UIImage?

  // Writer state: touched only on dataQueue.
  private var writer: AVAssetWriter?
  private var writerVideo: AVAssetWriterInput?
  private var writerAudio: AVAssetWriterInput?
  private var sessionStarted = false
  private var stopping = false
  private var fileURL: URL?
  // Pause: nothing is written while paused; afterwards every timestamp is shifted back by the
  // paused time so the file has no gap (offset grows with each pause).
  private var paused = false
  private var resumePending = false
  private var timeOffset = CMTime.zero
  private var lastVideoTime = CMTime.invalid

  // Camera flip hold: touched only on dataQueue. From the flip until the new camera gives an upright,
  // settled frame nothing new is written (the file holds the last good frame; an MP4 frame simply lasts
  // until the next one) and the preview is covered by that frame. Frames are judged by their capture
  // time against the moment the new rotation was set, not by their size: the iPhone 17 front camera
  // (square sensor) gives portrait-sized buffers even when they are turned, so «width > height» alone
  // let sideways frames into the file.
  private var holding = false
  private var holdAngleTime = CMTime.invalid  // frames captured before this are dropped
  private var holdFirstFrame = CMTime.invalid // first upright-sized frame after holdAngleTime
  private var holdDevice: AVCaptureDevice?
  private var holdNeedsCoordinator = false    // camera never seen upright: wait for the RotationCoordinator
  private var holdCoordinatorSeen = false
  private var dropBefore = CMTime.invalid     // outside a flip: frames captured before a rotation change
  private var lastFrame: CVPixelBuffer?        // last frame shown/written, for the cover
  private lazy var ciContext = CIContext()
  private let cover = UIImageView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    // Transparent until the first frame: the circle's own background (the app's colour) shows through.
    backgroundColor = .clear
    UIDevice.current.beginGeneratingDeviceOrientationNotifications()
    previewLayer.session = session
    previewLayer.videoGravity = .resizeAspectFill
    previewLayer.backgroundColor = UIColor.clear.cgColor
    layer.addSublayer(previewLayer)
    cover.contentMode = .scaleAspectFill
    cover.clipsToBounds = true
    cover.backgroundColor = .black
    cover.isHidden = true
    addSubview(cover)
    // While the camera starts: the previous recorder's last picture (blurred), else nothing until the
    // first frame fades in (reveal()).
    if let image = VideoNoteView.placeholder {
      cover.image = image
      cover.alpha = 1
      cover.isHidden = false
    } else {
      previewLayer.opacity = 0
    }
  }

  deinit { UIDevice.current.endGeneratingDeviceOrientationNotifications() }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
    cover.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { startSession() } else { stopSession() }
  }

  // MARK: camera

  private func device(for facing: String) -> AVCaptureDevice? {
    let position: AVCaptureDevice.Position = facing == "back" ? .back : .front
    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else { return nil }
    // Same SDR colour space on both cameras (no P3 / HDR switch when the camera flips).
    if camera.activeFormat.supportedColorSpaces.contains(.sRGB), (try? camera.lockForConfiguration()) != nil {
      camera.activeColorSpace = .sRGB
      camera.unlockForConfiguration()
    }
    return camera
  }

  /// The rotation each connection had before we touched it. The angle for an upright portrait frame is
  /// that default + 90°: 0 + 90 = 90 on earlier iPhones, but the iPhone 17 front camera (square
  /// Center Stage sensor) is mounted turned — its default is 270°, so upright is 0°. A fixed 90° gave
  /// sideways 1280×720 frames there, which were then all dropped as "landscape" (no video note).
  /// Apple: «The difference in rotation angle is expected on iPhone 17 due to a different sensor rotation»
  /// (developer.apple.com/forums/thread/813548).
  /// Kept per camera (recording connection), read once before the first change.
  private var defaultAngles: [String: CGFloat] = [:]

  /// Upright angles the RotationCoordinator reported for each camera while the phone was held upright
  /// (key: device uniqueID for the recording connection, «preview|uniqueID» for the preview). A camera seen once is set straight from this on every later flip, so the
  /// picture is upright at once even if the phone is tilted at the moment of the flip.
  private var portraitAngles: [String: CGFloat] = [:]
  private let anglesLock = NSLock()
  private func rememberedAngle(_ id: String) -> CGFloat? { anglesLock.lock(); defer { anglesLock.unlock() }; return portraitAngles[id] }
  private func rememberAngle(_ id: String, _ angle: CGFloat) { anglesLock.lock(); portraitAngles[id] = angle; anglesLock.unlock() }

  /// The recording connection's upright angle (remembered, else «default + 90°»). Returns the angle applied.
  @available(iOS 17.0, *)
  @discardableResult
  private func setPortrait(_ connection: AVCaptureConnection) -> CGFloat? {
    let id = videoInput?.device.uniqueID ?? facing
    let key = "output|\(id)"
    let base = defaultAngles[key] ?? connection.videoRotationAngle
    defaultAngles[key] = base
    let guess = (base + 90).truncatingRemainder(dividingBy: 360)
    for angle in [rememberedAngle(id), guess, 90] {
      if let angle = angle, connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle; return angle }
    }
    return nil
  }

  /// The preview gets the recording's upright angle: both are «sensor → portrait» rotations. The preview
  /// connection's own default is already portrait-ish on many iPhones (90°; 0° on the turned iPhone 17 front
  /// camera), so «preview default + 90°» showed the picture 90° sideways after a camera flip until the
  /// coordinator corrected it — and never, when the phone was tilted at that moment.
  @available(iOS 17.0, *)
  private func setPreviewPortrait(_ connection: AVCaptureConnection, upright: CGFloat?) {
    let id = videoInput?.device.uniqueID ?? facing
    for angle in [rememberedAngle("preview|\(id)"), upright, 90] {
      if let angle = angle, connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle; return }
    }
  }

  // Apple's RotationCoordinator knows each camera's sensor rotation (the iPhone 17 front camera is
  // mounted turned) and gives the angle for an upright picture, for recording and for the preview
  // separately. Its angles are applied while the phone is held upright (or lies flat), so the circle
  // stays portrait when the phone is tilted. The «default + 90°» rule above is only the first guess.
  private var rotationCoordinator: AnyObject?
  private var rotationObservations: [NSKeyValueObservation] = []

  @available(iOS 17.0, *)
  private func followRotationCoordinator() {
    guard let device = videoInput?.device else { return }
    let id = device.uniqueID
    DispatchQueue.main.async {
      self.rotationObservations.removeAll()
      let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: self.previewLayer)
      self.rotationCoordinator = coordinator
      self.rotationObservations = [
        // `.old` only so the first (initial) report is recognisable: it has no old value.
        coordinator.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.initial, .old, .new]) { [weak self] value, change in
          self?.useCoordinator(capture: value.videoRotationAngleForHorizonLevelCapture, preview: nil, device: id, initial: change.oldValue == nil) },
        coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .old, .new]) { [weak self] value, change in
          self?.useCoordinator(capture: nil, preview: value.videoRotationAngleForHorizonLevelPreview, device: id, initial: change.oldValue == nil) },
      ]
    }
  }

  @available(iOS 17.0, *)
  private func useCoordinator(capture: CGFloat?, preview: CGFloat?, device: String, initial: Bool) {
    DispatchQueue.main.async {
      let held = UIDevice.current.orientation
      guard held == .portrait || held == .unknown || held == .faceUp || held == .faceDown else { return }
      self.sessionQueue.async {
        // A late value from the previous camera's coordinator must not turn the current camera.
        guard self.videoInput?.device.uniqueID == device else { return }
        // A camera already seen upright was set from its remembered angle inside the flip's configuration.
        // The first value of a freshly made coordinator is not trusted for it: applying it is what turned
        // the picture (and the file) sideways for about a second after each flip, until the next value came.
        // The same for the preview, with its own remembered angle.
        if let angle = capture, !(initial && self.rememberedAngle(device) != nil),
           let connection = self.videoOutput.connection(with: .video), connection.isVideoRotationAngleSupported(angle) {
          if connection.videoRotationAngle != angle {
            connection.videoRotationAngle = angle
            self.rotationChanged()
          }
          if held == .portrait { self.rememberAngle(device, angle) }
          self.dataQueue.async { if self.holding { self.holdCoordinatorSeen = true } }
        }
        let previewKey = "preview|\(device)"
        if let angle = preview, !(initial && self.rememberedAngle(previewKey) != nil),
           let connection = self.previewLayer.connection, connection.isVideoRotationAngleSupported(angle) {
          connection.videoRotationAngle = angle
          if held == .portrait { self.rememberAngle(previewKey, angle) }
        }
      }
    }
  }

  private func applyConnection() {
    setAngles()
    if #available(iOS 17.0, *) { followRotationCoordinator() }
  }

  /// Upright rotation and mirroring on the current recording and preview connections, synchronously.
  private func setAngles() {
    guard let connection = videoOutput.connection(with: .video) else { return }
    var upright: CGFloat?
    if #available(iOS 17.0, *) {
      upright = setPortrait(connection)
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
    if connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = facing == "front"
    }
    if let preview = previewLayer.connection {
      if #available(iOS 17.0, *) {
        setPreviewPortrait(preview, upright: upright)
      } else if preview.isVideoOrientationSupported {
        preview.videoOrientation = .portrait
      }
      if preview.isVideoMirroringSupported {
        preview.automaticallyAdjustsVideoMirroring = false
        preview.isVideoMirrored = facing == "front"
      }
    }
  }

  // MARK: flip hold

  private func clockNow() -> CMTime { CMClockGetTime(session.synchronizationClock ?? CMClockGetHostTimeClock()) }

  /// Called on sessionQueue right after the recording connection's rotation changed: frames captured
  /// before now carry the old rotation and are never written.
  private func rotationChanged() {
    let now = clockNow()
    dataQueue.async {
      if self.holding { self.holdAngleTime = now; self.holdFirstFrame = .invalid } else { self.dropBefore = now }
    }
  }

  /// Start of a flip (sessionQueue, before the input swap): from here no frame is shown or written
  /// until `frameAllowed` releases the hold; the preview is covered with the last good frame.
  private func beginHold() {
    dataQueue.async {
      self.holding = true
      self.holdAngleTime = .invalid; self.holdFirstFrame = .invalid
      self.holdDevice = nil; self.holdNeedsCoordinator = false; self.holdCoordinatorSeen = false
      let image = self.lastFrame.flatMap { self.snapshot($0) }
      DispatchQueue.main.async {
        // A quick crossfade to the last frame, lightly blurred (Telegram), not a dark tint. The swap and
        // the new camera's start take longer than the fade, so no turned frame shows through meanwhile.
        self.cover.layer.removeAllAnimations()
        self.cover.image = image ?? VideoNoteView.placeholder
        if self.cover.isHidden { self.cover.alpha = 0; self.cover.isHidden = false }
        UIView.animate(withDuration: 0.1, delay: 0, options: [.beginFromCurrentState]) { self.cover.alpha = 1 }
      }
    }
  }

  /// After the swap is committed and the new connection's rotation is set (sessionQueue).
  private func armHold(device: AVCaptureDevice?, needsCoordinator: Bool) {
    let now = clockNow()
    dataQueue.async {
      guard self.holding else { return }
      self.holdDevice = device; self.holdNeedsCoordinator = needsCoordinator
      self.holdAngleTime = now; self.holdFirstFrame = .invalid
    }
  }

  private func endHold() {
    holding = false; holdDevice = nil
    DispatchQueue.main.async {
      UIView.animate(withDuration: 0.15, animations: { self.cover.alpha = 0 }) { finished in
        if finished { self.cover.isHidden = true; self.cover.image = nil }
      }
    }
  }

  /// dataQueue: whether a video frame captured at `time` may be shown in the cover / written.
  private func frameAllowed(portrait: Bool, at time: CMTime) -> Bool {
    if dropBefore.isValid {
      if CMTimeCompare(time, dropBefore) < 0 { return false }
      dropBefore = .invalid
    }
    guard holding else { return true }
    // Not armed yet (swap still running) or captured before the new rotation was set.
    guard holdAngleTime.isValid, CMTimeCompare(time, holdAngleTime) >= 0 else { return false }
    // Hard cap: never freeze longer than this, even if no upright-sized frame comes (landscape frames are
    // still dropped by the caller, as before).
    if CMTimeGetSeconds(CMTimeSubtract(time, holdAngleTime)) >= 0.7 { endHold(); return true }
    guard portrait else { return false }
    if !holdFirstFrame.isValid { holdFirstFrame = time }
    let waited = CMTimeGetSeconds(CMTimeSubtract(time, holdFirstFrame))
    if waited >= 0.5 { endHold(); return true }
    // A camera never seen upright: its angle was only a guess, wait for the coordinator's answer.
    if holdNeedsCoordinator && !holdCoordinatorSeen { return false }
    // The very first frame of the new camera is often dark: skip it. Focus / exposure are not waited for
    // beyond ~120 ms (Telegram goes live at once; the new camera settles while it is already shown).
    let settling = holdDevice.map { $0.isAdjustingFocus || $0.isAdjustingExposure } ?? false
    if waited < 0.03 || (settling && waited < 0.12) { return false }
    endHold()
    return true
  }

  /// The frame at half size with a light Gaussian blur (no tint): the cover for a flip and the next
  /// recorder's placeholder.
  private func snapshot(_ pixels: CVPixelBuffer) -> UIImage? {
    let small = CIImage(cvPixelBuffer: pixels).transformed(by: CGAffineTransform(scaleX: 0.5, y: 0.5))
    let extent = small.extent
    let image = small.clampedToExtent().applyingGaussianBlur(sigma: 5).cropped(to: extent)
    guard let cg = ciContext.createCGImage(image, from: extent) else { return nil }
    return UIImage(cgImage: cg)
  }

  /// dataQueue, the session's first upright frame: the camera really shows a picture now. Only now is
  /// onReady sent (JS starts the take at once, so the timer starts with the first written frame), and
  /// the placeholder crossfades to the live preview.
  private func reveal() {
    DispatchQueue.main.async {
      self.onReady([:])
      CATransaction.begin()
      CATransaction.setAnimationDuration(0.15)
      self.previewLayer.opacity = 1
      CATransaction.commit()
      guard !self.cover.isHidden else { return }
      UIView.animate(withDuration: 0.15, delay: 0, options: [.beginFromCurrentState], animations: { self.cover.alpha = 0 }) { finished in
        if finished { self.cover.isHidden = true; self.cover.image = nil }
      }
    }
  }

  private func fail(_ message: String) {
    DispatchQueue.main.async { self.onCameraError(["message": message]) }
  }

  private func configure() -> Bool {
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    session.automaticallyConfiguresCaptureDeviceForWideColor = false
    if session.canSetSessionPreset(.vga640x480) { session.sessionPreset = .vga640x480 }
    guard let camera = device(for: facing), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
      fail("Камера недоступна."); return false
    }
    session.addInput(input); videoInput = input
    if let mic = AVCaptureDevice.default(for: .audio), let audioIn = try? AVCaptureDeviceInput(device: mic), session.canAddInput(audioIn) {
      session.addInput(audioIn)
    }
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
    videoOutput.setSampleBufferDelegate(self, queue: dataQueue)
    if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }
    audioOutput.setSampleBufferDelegate(self, queue: dataQueue)
    if session.canAddOutput(audioOutput) { session.addOutput(audioOutput) }
    // The rotation is set after the configuration is committed (startSession), on the final connections.
    return true
  }

  private func startSession() {
    sessionQueue.async {
      if !self.configured {
        // Center Stage off before the camera is added (it pans the crop inside the circle). Turning it
        // off from JS while the session was starting could reconfigure the camera mid-start.
        if AVCaptureDevice.isCenterStageEnabled {
          AVCaptureDevice.centerStageControlMode = .cooperative
          AVCaptureDevice.isCenterStageEnabled = false
        }
        self.configured = self.configure(); if self.configured { self.applyConnection() }
      }
      guard self.configured else { return }
      if !self.session.isRunning { self.session.startRunning() }
      self.applyTorch()
      // onReady is sent with the first upright frame (reveal), not here: startRunning returns before
      // frames reach the preview and the writer.
    }
  }

  private func stopSession() {
    sessionQueue.async {
      if self.session.isRunning { self.session.stopRunning() }
      self.dataQueue.async {
        // The last picture becomes the next recorder's placeholder.
        if let pixels = self.lastFrame, let image = self.snapshot(pixels) {
          DispatchQueue.main.async { VideoNoteView.placeholder = image }
        }
        self.lastFrame = nil
        self.firstFrameSent = false
      }
    }
  }

  /** Swaps only the camera input: the writer and the microphone keep going, so a flip does not stop the take. */
  func setFacing(_ value: String) {
    let next = value == "back" ? "back" : "front"
    sessionQueue.async {
      guard next != self.facing else { return }
      self.facing = next
      guard self.configured, let camera = self.device(for: next), let input = try? AVCaptureDeviceInput(device: camera) else { return }
      self.beginHold()
      self.session.beginConfiguration()
      if let old = self.videoInput { self.session.removeInput(old) }
      if self.session.canAddInput(input) { self.session.addInput(input); self.videoInput = input }
      else if let old = self.videoInput, self.session.canAddInput(old) { self.session.addInput(old) }
      // The new connections exist once the input is added: they get the upright angle before the commit,
      // so the camera's first frame already carries it (not a moment later, nor from the coordinator).
      self.setAngles()
      self.session.commitConfiguration()
      // Again after the commit (idempotent), in case the commit replaced a connection; then the coordinator.
      self.applyConnection()
      self.applyTorch()
      self.applyZoom()
      var needsCoordinator = false
      if #available(iOS 17.0, *), let id = self.videoInput?.device.uniqueID { needsCoordinator = self.rememberedAngle(id) == nil }
      self.armHold(device: self.videoInput?.device, needsCoordinator: needsCoordinator)
    }
  }

  /** Pinch zoom as in Telegram: 0 = widest, 1 = up to 6× (or the camera's limit). */
  func setZoom(_ value: Double) {
    sessionQueue.async { self.zoom = min(1, max(0, value)); self.applyZoom() }
  }

  private func applyZoom() {
    guard let camera = videoInput?.device else { return }
    let top = min(camera.activeFormat.videoMaxZoomFactor, 6)
    let factor = max(camera.minAvailableVideoZoomFactor, min(top, 1 + CGFloat(zoom) * (top - 1)))
    do { try camera.lockForConfiguration(); camera.videoZoomFactor = factor; camera.unlockForConfiguration() } catch { /* zoom is optional */ }
  }

  func setTorch(_ on: Bool) {
    sessionQueue.async { self.torch = on; self.applyTorch() }
  }

  private func applyTorch() {
    guard let camera = videoInput?.device, camera.hasTorch, camera.isTorchModeSupported(.on) else { return }
    do {
      try camera.lockForConfiguration()
      camera.torchMode = torch && camera.position == .back ? .on : .off
      camera.unlockForConfiguration()
    } catch { /* torch is optional */ }
  }

  // MARK: recording

  func start(path: String, promise: Promise) {
    let url: URL = path.hasPrefix("file://") ? (URL(string: path) ?? URL(fileURLWithPath: String(path.dropFirst(7)))) : URL(fileURLWithPath: path)
    dataQueue.async {
      if self.writer != nil { promise.reject("E_BUSY", "Запись уже идёт."); return }
      try? FileManager.default.removeItem(at: url)
      do {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
          AVVideoCodecKey: AVVideoCodecType.h264,
          AVVideoWidthKey: 480,
          AVVideoHeightKey: 640,
          AVVideoScalingModeKey: AVVideoScalingModeResizeAspectFill,
          // One fixed colour description for the whole take: the front and back cameras tag frames
          // differently, and a mid-file format change is refused by the send-time check
          // (linea-video, VIDEO_FORMAT_CHANGED). BT.709 SDR for both.
          AVVideoColorPropertiesKey: [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
          ],
          AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_200_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel] as [String: Any],
        ])
        video.expectsMediaDataInRealTime = true
        let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: 1, AVSampleRateKey: 44_100, AVEncoderBitRateKey: 64_000,
        ])
        audio.expectsMediaDataInRealTime = true
        guard writer.canAdd(video), writer.canAdd(audio) else { promise.reject("E_WRITER", "Не удалось подготовить запись."); return }
        writer.add(video); writer.add(audio)
        self.writer = writer; self.writerVideo = video; self.writerAudio = audio
        self.sessionStarted = false; self.stopping = false; self.fileURL = url
        self.paused = false; self.resumePending = false; self.timeOffset = .zero; self.lastVideoTime = .invalid
        promise.resolve(nil)
      } catch {
        promise.reject("E_WRITER", "Не удалось начать запись: \(error.localizedDescription)")
      }
    }
  }

  func setPaused(_ value: Bool) {
    dataQueue.async {
      guard self.writer != nil, value != self.paused else { return }
      self.paused = value
      if !value { self.resumePending = true }
    }
  }

  private func shifted(_ buffer: CMSampleBuffer) -> CMSampleBuffer? {
    if timeOffset == .zero { return buffer }
    var count: CMItemCount = 0
    CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
    var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: max(1, count))
    CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)
    for i in 0..<timing.count {
      timing[i].presentationTimeStamp = CMTimeSubtract(timing[i].presentationTimeStamp, timeOffset)
      if timing[i].decodeTimeStamp.isValid { timing[i].decodeTimeStamp = CMTimeSubtract(timing[i].decodeTimeStamp, timeOffset) }
    }
    var out: CMSampleBuffer?
    CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: buffer, sampleTimingEntryCount: timing.count, sampleTimingArray: &timing, sampleBufferOut: &out)
    return out
  }

  func stop(promise: Promise) {
    dataQueue.async {
      guard let writer = self.writer, let url = self.fileURL else { promise.reject("E_IDLE", "Запись не идёт."); return }
      self.stopping = true
      let done = {
        self.writer = nil; self.writerVideo = nil; self.writerAudio = nil; self.sessionStarted = false; self.stopping = false
      }
      guard self.sessionStarted, writer.status == .writing else {
        writer.cancelWriting(); done()
        promise.reject("E_EMPTY", "Видео не успело записаться."); return
      }
      self.writerVideo?.markAsFinished(); self.writerAudio?.markAsFinished()
      writer.finishWriting {
        self.dataQueue.async {
          let status = writer.status, message = writer.error?.localizedDescription
          done()
          if status == .completed { promise.resolve(url.absoluteString) }
          else { promise.reject("E_WRITER", "Не удалось сохранить видео: \(message ?? "ошибка записи")") }
        }
      }
    }
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if output === videoOutput {
      // Flip hold first (also while not recording: it releases the preview cover). Landscape buffers are
      // never shown or written; the file simply holds the last good frame a moment.
      let pixels = CMSampleBufferGetImageBuffer(sampleBuffer)
      let portrait = pixels.map { CVPixelBufferGetWidth($0) <= CVPixelBufferGetHeight($0) } ?? false
      guard frameAllowed(portrait: portrait, at: time), portrait else { return }
      lastFrame = pixels
      if !firstFrameSent { firstFrameSent = true; reveal() }
    }
    guard let writer = writer, !stopping, CMSampleBufferDataIsReady(sampleBuffer) else { return }
    if output === videoOutput {
      if paused { return }
      if !sessionStarted {
        guard writer.startWriting() else { fail("Не удалось начать запись видео."); return }
        writer.startSession(atSourceTime: time)
        sessionStarted = true
      }
      if resumePending {
        // First frame after a pause: the gap since the last written frame (minus one frame) is removed.
        if lastVideoTime.isValid { timeOffset = CMTimeAdd(timeOffset, CMTimeSubtract(CMTimeSubtract(time, lastVideoTime), CMTime(value: 1, timescale: 30))) }
        resumePending = false
      }
      lastVideoTime = time
      if let input = writerVideo, input.isReadyForMoreMediaData, let buffer = shifted(sampleBuffer) { input.append(buffer) }
    } else if output === audioOutput {
      // Audio before the first video frame (and while paused / until video resumes) is dropped.
      guard sessionStarted, !paused, !resumePending, let input = writerAudio, input.isReadyForMoreMediaData, let buffer = shifted(sampleBuffer) else { return }
      input.append(buffer)
    }
  }
}
