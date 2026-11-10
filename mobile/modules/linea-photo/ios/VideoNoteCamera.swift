import AVFoundation
import CoreImage
import ExpoModulesCore
import UIKit

// Round video messages on iPhone: one AVCaptureSession whose camera input can be swapped while an
// AVAssetWriter keeps writing the same MP4 (expo-camera's recordAsync stops when the camera flips).
// Written from Apple's AVFoundation documentation; the same JS interface as the Android module
// (VideoNoteCamera.kt): a view with `facing`, `startRecording(path)` and `stopRecording()`.
// iPhones that can stream two cameras at once (AVCaptureMultiCamSession) run the front and back camera
// together instead, so a flip is instant (VideoNoteMultiCam.swift, «two cameras» below).
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
  private var holdToken = 0                    // the flip (flipToken) this hold belongs to
  // Thread-safe; used on dataQueue and, at a flip tap, on the main thread.
  private let ciContext = CIContext()
  private let cover = UIImageView()
  // Main thread: the facing the circle shows, the number of the latest flip (a late release of an earlier
  // flip must not uncover a newer one), and whether the session's first frame was revealed.
  private var shownFacing = "front"
  private var flipToken = 0
  private var revealed = false

  // Two cameras at once (VideoNoteMultiCam.swift) where the iPhone supports it: a flip only switches which
  // camera's frames are written and which preview layer is visible — no input swap, no hold, no cover.
  // Any failure while setting it up falls back to the single-session path above, unchanged.
  private let rig = VideoNoteMultiCam.make()
  private let multiHost = CALayer()           // holds both cameras' preview layers (main thread)
  private var multiOn = false                 // sessionQueue: the rig is the running session
  private var mainMulti = false               // main thread copy of multiOn (no flip cover then)
  private var degraded = false                // sessionQueue: system pressure — only the shown camera runs
  private var handoffPending = false          // sessionQueue: degraded flip waiting for the new camera
  private var pressureObservations: [NSKeyValueObservation] = []
  private var multiCoordinators: [AnyObject] = []
  // dataQueue: the output whose frames are shown/written, a degraded flip's output waiting for its first
  // settled frame, and per output the capture time before which frames carry an older rotation.
  private var multiActive: AVCaptureOutput?
  private var multiPending: AVCaptureOutput?
  private var multiPendingSince = CMTime.invalid
  private var multiPendingFirst = CMTime.invalid
  private var multiDropBefore: [ObjectIdentifier: CMTime] = [:]

  /// sessionQueue: the session that runs (the rig's while two cameras are used).
  private var activeSession: AVCaptureSession {
    if multiOn, let rig = rig { return rig.session }
    return session
  }

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
    if let rig = rig {
      for preview in [rig.front.preview, rig.back.preview] {
        preview.videoGravity = .resizeAspectFill
        preview.backgroundColor = UIColor.clear.cgColor
        preview.isHidden = true
        multiHost.addSublayer(preview)
      }
      layer.addSublayer(multiHost)
    }
    cover.contentMode = .scaleAspectFill
    cover.clipsToBounds = true
    // No dark backdrop: without a picture the circle's own background shows, never a black frame.
    cover.backgroundColor = .clear
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
      multiHost.opacity = 0
    }
  }

  deinit { UIDevice.current.endGeneratingDeviceOrientationNotifications() }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
    if let rig = rig {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      multiHost.frame = bounds
      rig.front.preview.frame = multiHost.bounds
      rig.back.preview.frame = multiHost.bounds
      CATransaction.commit()
    }
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

  private func clockNow() -> CMTime { CMClockGetTime(activeSession.synchronizationClock ?? CMClockGetHostTimeClock()) }

  /// Called on sessionQueue right after the recording connection's rotation changed: frames captured
  /// before now carry the old rotation and are never written.
  private func rotationChanged() {
    let now = clockNow()
    dataQueue.async {
      if self.holding { self.holdAngleTime = now; self.holdFirstFrame = .invalid } else { self.dropBefore = now }
    }
  }

  /// Main thread, at the flip tap, before the session is touched: the last upright frame (lightly blurred,
  /// no tint) covers the circle at full opacity at once (no fade-in), and the preview layer is hidden under
  /// it until the new camera's first upright frame (`uncover`). The preview layer keeps showing the old
  /// camera's last picture while the swap runs, and the new connection's angle turned that picture 90°.
  private func coverForFlip() -> Int {
    flipToken += 1
    let frame = dataQueue.sync { self.lastFrame }
    let image = frame.flatMap { snapshot($0) } ?? VideoNoteView.placeholder
    cover.layer.removeAllAnimations()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer.removeAllAnimations()
    previewLayer.opacity = 0
    CATransaction.commit()
    cover.image = image
    cover.alpha = 1
    cover.isHidden = image == nil
    // To the screen now, before the session queue starts the swap.
    CATransaction.flush()
    return flipToken
  }

  /// Main thread: the live preview comes back under the cover, then the cover crossfades out (~150 ms).
  /// Ignored when a newer flip has covered the circle since.
  private func uncover(_ token: Int) {
    guard token == flipToken else { return }
    if cover.isHidden {
      CATransaction.begin()
      CATransaction.setAnimationDuration(0.15)
      previewLayer.opacity = 1
      CATransaction.commit()
      return
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer.opacity = 1
    CATransaction.commit()
    UIView.animate(withDuration: 0.15, delay: 0, options: [.beginFromCurrentState], animations: { self.cover.alpha = 0 }) { finished in
      if finished && token == self.flipToken { self.cover.isHidden = true; self.cover.image = nil }
    }
  }

  /// Start of a flip (sessionQueue, before the input swap): from here no frame is shown or written
  /// until `frameAllowed` releases the hold. The cover was already put up on the main thread (coverForFlip).
  private func beginHold(token: Int) {
    dataQueue.async {
      self.holding = true
      self.holdToken = token
      self.holdAngleTime = .invalid; self.holdFirstFrame = .invalid
      self.holdDevice = nil; self.holdNeedsCoordinator = false; self.holdCoordinatorSeen = false
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
    let token = holdToken
    DispatchQueue.main.async { self.uncover(token) }
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
      self.revealed = true
      CATransaction.begin()
      CATransaction.setAnimationDuration(0.15)
      self.previewLayer.opacity = 1
      self.multiHost.opacity = 1
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
        if let rig = self.rig, self.configureMulti(rig) {
          self.multiOn = true; self.configured = true
          DispatchQueue.main.async { self.mainMulti = true }
        } else {
          self.configured = self.configure(); if self.configured { self.applyConnection() }
        }
      }
      guard self.configured else { return }
      if self.multiOn, let rig = self.rig {
        self.restoreMulti(rig)
        if !rig.session.isRunning { rig.session.startRunning() }
        if rig.session.isRunning { self.applyTorch(); return }
        // Could not run both cameras: the single-session recorder from here on.
        self.abandonMulti(rig)
        self.configured = self.configure(); if self.configured { self.applyConnection() }
        guard self.configured else { return }
      }
      if !self.session.isRunning { self.session.startRunning() }
      self.applyTorch()
      // onReady is sent with the first upright frame (reveal), not here: startRunning returns before
      // frames reach the preview and the writer.
    }
  }

  private func stopSession() {
    sessionQueue.async {
      if self.activeSession.isRunning { self.activeSession.stopRunning() }
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
    // Props arrive on the main thread; the cover must go up there, synchronously, before the swap.
    guard Thread.isMainThread else { DispatchQueue.main.async { self.setFacing(value) }; return }
    let next = value == "back" ? "back" : "front"
    var covered = 0
    // Before the first frame the start placeholder (or the hidden preview) already covers the circle.
    // Both cameras running: nothing to cover, the switch is immediate (multiFlip).
    if next != shownFacing {
      shownFacing = next
      if revealed && !mainMulti { covered = coverForFlip() }
    }
    let token = covered
    let release = { if token != 0 { DispatchQueue.main.async { self.uncover(token) } } }
    sessionQueue.async {
      if self.multiOn { release(); self.multiFlip(to: next); return }
      guard next != self.facing else { release(); return }
      let previous = self.facing
      self.facing = next
      guard self.configured, let camera = self.device(for: next), let input = try? AVCaptureDeviceInput(device: camera) else { release(); return }
      self.beginHold(token: token)
      self.session.beginConfiguration()
      if let old = self.videoInput { self.session.removeInput(old) }
      if self.session.canAddInput(input) { self.session.addInput(input); self.videoInput = input }
      else if let old = self.videoInput, self.session.canAddInput(old) { self.session.addInput(old); self.facing = previous }
      // Only the connections made by addInput above are touched (the old ones went with removeInput), and
      // only after the preview was hidden under the cover. They get the upright angle before the commit,
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

  /// sessionQueue: the camera that is shown and written (the rig's camera for `facing` with two cameras).
  private var activeDevice: AVCaptureDevice? {
    if multiOn, let rig = rig { let camera = rig.camera(facing); return camera.attached ? camera.device : nil }
    return videoInput?.device
  }

  private func applyZoom() {
    guard let camera = activeDevice else { return }
    let top = min(camera.activeFormat.videoMaxZoomFactor, 6)
    let factor = max(camera.minAvailableVideoZoomFactor, min(top, 1 + CGFloat(zoom) * (top - 1)))
    do { try camera.lockForConfiguration(); camera.videoZoomFactor = factor; camera.unlockForConfiguration() } catch { /* zoom is optional */ }
  }

  func setTorch(_ on: Bool) {
    sessionQueue.async { self.torch = on; self.applyTorch() }
  }

  private func applyTorch() {
    if multiOn, let rig = rig {
      // Two cameras: the back camera's torch follows the prop only while the back camera is the one shown.
      let back = rig.back
      guard back.attached, let camera = back.device, camera.hasTorch, camera.isTorchModeSupported(.on) else { return }
      let mode: AVCaptureDevice.TorchMode = torch && facing == "back" ? .on : .off
      guard camera.torchMode != mode else { return }
      do { try camera.lockForConfiguration(); camera.torchMode = mode; camera.unlockForConfiguration() } catch { /* torch is optional */ }
      return
    }
    guard let camera = videoInput?.device, camera.hasTorch, camera.isTorchModeSupported(.on) else { return }
    do {
      try camera.lockForConfiguration()
      camera.torchMode = torch && camera.position == .back ? .on : .off
      camera.unlockForConfiguration()
    } catch { /* torch is optional */ }
  }

  // MARK: two cameras (AVCaptureMultiCamSession)

  /// sessionQueue, first start: both cameras and the microphone in the rig, each camera with its own upright
  /// angle and mirroring set once here. False (the rig emptied again) sends the caller to the single path.
  private func configureMulti(_ rig: VideoNoteMultiCam) -> Bool {
    guard rig.findDevices() else { return false }
    let multi = rig.session
    multi.beginConfiguration()
    multi.automaticallyConfiguresCaptureDeviceForWideColor = false
    var ok = rig.addOutputsAndMicrophone(delegate: self, queue: dataQueue)
    if ok { ok = rig.attach(rig.front) && rig.attach(rig.back) }
    if ok { orientMulti(rig.front); orientMulti(rig.back) }
    multi.commitConfiguration()
    guard ok, rig.fitCost() else { abandonMulti(rig); return false }
    let shown = rig.camera(facing)
    dataQueue.async {
      self.multiActive = shown.output; self.multiPending = nil; self.multiDropBefore = [:]
      DispatchQueue.main.async { self.showMulti(shown.facing) }
    }
    observePressure(rig)
    if #available(iOS 17.0, *) { followMultiCoordinators(rig) }
    return true
  }

  /// sessionQueue: back to the single-session recorder (the rig gives up both cameras).
  private func abandonMulti(_ rig: VideoNoteMultiCam) {
    pressureObservations.removeAll()
    rig.tearDown()
    multiOn = false; degraded = false; handoffPending = false
    // The single path reads its own connections' default rotation.
    defaultAngles.removeAll()
    dataQueue.async { self.multiActive = nil; self.multiPending = nil; self.multiDropBefore = [:] }
    DispatchQueue.main.async {
      self.mainMulti = false
      self.multiRotationObservations.removeAll()
      self.multiCoordinators = []
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      rig.front.preview.isHidden = true
      rig.back.preview.isHidden = true
      CATransaction.commit()
    }
  }

  /// Inside the rig's configuration, right after `attach`: the same upright logic as the single path
  /// (remembered angle, else «default + 90°», else 90°; before iOS 17 `.portrait`), front mirrored. It is
  /// not touched at a flip; only the RotationCoordinator may correct it while the phone is held upright.
  private func orientMulti(_ camera: VideoNoteMultiCam.Camera) {
    guard let id = camera.device?.uniqueID else { return }
    let mirrored = camera.position == .front
    var upright: CGFloat?
    if let connection = camera.dataConnection {
      if #available(iOS 17.0, *) {
        let key = "output|\(id)"
        let base = defaultAngles[key] ?? connection.videoRotationAngle
        defaultAngles[key] = base
        let guess = (base + 90).truncatingRemainder(dividingBy: 360)
        for angle in [rememberedAngle(id), guess, 90] {
          if let angle = angle, connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle; upright = angle; break }
        }
      } else if connection.isVideoOrientationSupported {
        connection.videoOrientation = .portrait
      }
      if connection.isVideoMirroringSupported {
        connection.automaticallyAdjustsVideoMirroring = false
        connection.isVideoMirrored = mirrored
      }
    }
    if let preview = camera.previewConnection {
      if #available(iOS 17.0, *) {
        for angle in [rememberedAngle("preview|\(id)"), upright, 90] {
          if let angle = angle, preview.isVideoRotationAngleSupported(angle) { preview.videoRotationAngle = angle; break }
        }
      } else if preview.isVideoOrientationSupported {
        preview.videoOrientation = .portrait
      }
      if preview.isVideoMirroringSupported {
        preview.automaticallyAdjustsVideoMirroring = false
        preview.isVideoMirrored = mirrored
      }
    }
  }

  private var multiRotationObservations: [NSKeyValueObservation] = []  // main thread

  /// One RotationCoordinator per camera (with its own preview layer), as on the single path.
  @available(iOS 17.0, *)
  private func followMultiCoordinators(_ rig: VideoNoteMultiCam) {
    let cameras = [rig.front, rig.back].compactMap { camera in camera.device.map { (camera, $0) } }
    DispatchQueue.main.async {
      self.multiRotationObservations.removeAll()
      self.multiCoordinators = []
      for (camera, device) in cameras {
        let id = device.uniqueID
        let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: camera.preview)
        self.multiCoordinators.append(coordinator)
        self.multiRotationObservations.append(
          coordinator.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.initial, .old, .new]) { [weak self] value, change in
            self?.useMultiCoordinator(capture: value.videoRotationAngleForHorizonLevelCapture, preview: nil, camera: camera, device: id, initial: change.oldValue == nil) })
        self.multiRotationObservations.append(
          coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .old, .new]) { [weak self] value, change in
            self?.useMultiCoordinator(capture: nil, preview: value.videoRotationAngleForHorizonLevelPreview, camera: camera, device: id, initial: change.oldValue == nil) })
      }
    }
  }

  @available(iOS 17.0, *)
  private func useMultiCoordinator(capture: CGFloat?, preview: CGFloat?, camera: VideoNoteMultiCam.Camera, device: String, initial: Bool) {
    DispatchQueue.main.async {
      let held = UIDevice.current.orientation
      guard held == .portrait || held == .unknown || held == .faceUp || held == .faceDown else { return }
      self.sessionQueue.async {
        guard self.multiOn, camera.device?.uniqueID == device else { return }
        // As on the single path: a camera already seen upright does not take a fresh coordinator's first value.
        if let angle = capture, !(initial && self.rememberedAngle(device) != nil),
           let connection = camera.dataConnection, connection.isVideoRotationAngleSupported(angle) {
          if connection.videoRotationAngle != angle {
            connection.videoRotationAngle = angle
            // Frames of this camera captured before now carry the old rotation: never shown or written.
            let now = self.clockNow(), key = ObjectIdentifier(camera.output)
            self.dataQueue.async { self.multiDropBefore[key] = now }
          }
          if held == .portrait { self.rememberAngle(device, angle) }
        }
        let previewKey = "preview|\(device)"
        if let angle = preview, !(initial && self.rememberedAngle(previewKey) != nil),
           let connection = camera.previewConnection, connection.isVideoRotationAngleSupported(angle) {
          connection.videoRotationAngle = angle
          if held == .portrait { self.rememberAngle(previewKey, angle) }
        }
      }
    }
  }

  /// Main thread: only the shown camera's preview layer is visible; the switch is not animated.
  private func showMulti(_ facing: String) {
    guard let rig = rig else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    rig.front.preview.isHidden = facing != "front"
    rig.back.preview.isHidden = facing != "back"
    CATransaction.commit()
  }

  /// sessionQueue. Both cameras running: the writer takes the other camera's frames from its next frame and
  /// its preview layer is shown — nothing is reconfigured. Degraded (one camera): the other camera is started
  /// beside the shown one, which stays live until the new one gives a settled frame (multiFrameAllowed).
  private func multiFlip(to next: String) {
    guard let rig = rig, next != facing else { return }
    let camera = rig.camera(next)
    if camera.attached {
      facing = next
      handoffPending = false
      // The preview switch is sent from dataQueue, after the writer's switch: every switch (also a degraded
      // flip's, made there) reaches the main thread in the order the writer saw them.
      dataQueue.async {
        self.multiActive = camera.output; self.multiPending = nil
        DispatchQueue.main.async { self.showMulti(next) }
      }
      // A degraded flip back before the new camera was shown: that camera stops again.
      if degraded { detachMulti(rig.other(camera)) }
    } else {
      rig.session.beginConfiguration()
      let ok = rig.attach(camera)
      if ok { orientMulti(camera) }
      rig.session.commitConfiguration()
      guard ok else { return }
      facing = next
      handoffPending = true
      let now = clockNow()
      dataQueue.async { self.multiPending = camera.output; self.multiPendingSince = now; self.multiPendingFirst = .invalid }
    }
    applyTorch()
    applyZoom()
  }

  /// sessionQueue, after a degraded flip switched to the new camera: the old one stops.
  private func multiHandoffDone() {
    guard multiOn, let rig = rig else { return }
    handoffPending = false
    let shown = rig.camera(facing)
    if degraded && shown.attached { detachMulti(rig.other(shown)) }
  }

  private func detachMulti(_ camera: VideoNoteMultiCam.Camera) {
    guard let rig = rig, camera.attached else { return }
    rig.session.beginConfiguration()
    rig.detach(camera)
    rig.session.commitConfiguration()
    let output = camera.output
    dataQueue.async { if self.multiPending === output { self.multiPending = nil } }
  }

  /// Heat: at serious/critical system pressure only the shown camera keeps running (until the recorder
  /// closes); flips then start the other camera on demand.
  private func observePressure(_ rig: VideoNoteMultiCam) {
    pressureObservations = [rig.front, rig.back].compactMap { $0.device }.map { device in
      device.observe(\.systemPressureState, options: [.initial, .new]) { [weak self] observed, _ in
        let level = observed.systemPressureState.level
        guard level == .serious || level == .critical else { return }
        guard let self = self else { return }
        self.sessionQueue.async { self.degradeMulti() }
      }
    }
  }

  private func degradeMulti() {
    guard multiOn, !degraded, let rig = rig else { return }
    degraded = true
    if !handoffPending { detachMulti(rig.other(rig.camera(facing))) }
  }

  /// sessionQueue, at a (re)start: a recorder degraded by heat runs both cameras again once it has cooled.
  private func restoreMulti(_ rig: VideoNoteMultiCam) {
    guard degraded, !handoffPending else { return }
    let calm = [rig.front, rig.back].allSatisfy { camera in
      guard let level = camera.device?.systemPressureState.level else { return true }
      return level != .serious && level != .critical && level != .shutdown
    }
    guard calm else { return }
    let other = rig.other(rig.camera(facing))
    rig.session.beginConfiguration()
    let ok = rig.attach(other)
    if ok { orientMulti(other) }
    rig.session.commitConfiguration()
    if ok { degraded = false }
  }

  /// dataQueue: whether a frame of one of the rig's cameras is shown / written. Only the active camera's
  /// upright frames are; a degraded flip's new camera takes over on its first settled frame (the same short
  /// skip of a fresh camera's dark first frames as the single path; at most 0.7 s).
  private func multiFrameAllowed(_ output: AVCaptureOutput, portrait: Bool, at time: CMTime) -> Bool {
    let key = ObjectIdentifier(output)
    if let drop = multiDropBefore[key] {
      if CMTimeCompare(time, drop) < 0 { return false }
      multiDropBefore[key] = nil
    }
    if let pending = multiPending, output === pending {
      guard portrait, multiPendingSince.isValid, CMTimeCompare(time, multiPendingSince) >= 0 else { return false }
      if !multiPendingFirst.isValid { multiPendingFirst = time }
      let waited = CMTimeGetSeconds(CMTimeSubtract(time, multiPendingFirst))
      let total = CMTimeGetSeconds(CMTimeSubtract(time, multiPendingSince))
      let camera = rig?.camera(for: output)
      let settling = camera?.device.map { $0.isAdjustingFocus || $0.isAdjustingExposure } ?? false
      if total < 0.7 && (waited < 0.03 || (settling && waited < 0.12)) { return false }
      multiActive = output
      multiPending = nil
      if let facing = camera?.facing { DispatchQueue.main.async { self.showMulti(facing) } }
      sessionQueue.async { self.multiHandoffDone() }
      return true
    }
    return output === multiActive && portrait
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
    let multiVideo = rig?.camera(for: output) != nil
    if multiVideo {
      // Two cameras: only the shown camera's frames go on (a degraded flip may switch here).
      let pixels = CMSampleBufferGetImageBuffer(sampleBuffer)
      let portrait = pixels.map { CVPixelBufferGetWidth($0) <= CVPixelBufferGetHeight($0) } ?? false
      guard multiFrameAllowed(output, portrait: portrait, at: time) else { return }
      lastFrame = pixels
      if !firstFrameSent { firstFrameSent = true; reveal() }
    } else if output === videoOutput {
      // Flip hold first (also while not recording: it releases the preview cover). Landscape buffers are
      // never shown or written; the file simply holds the last good frame a moment.
      let pixels = CMSampleBufferGetImageBuffer(sampleBuffer)
      let portrait = pixels.map { CVPixelBufferGetWidth($0) <= CVPixelBufferGetHeight($0) } ?? false
      guard frameAllowed(portrait: portrait, at: time), portrait else { return }
      lastFrame = pixels
      if !firstFrameSent { firstFrameSent = true; reveal() }
    }
    guard let writer = writer, !stopping, CMSampleBufferDataIsReady(sampleBuffer) else { return }
    if output === videoOutput || multiVideo {
      if paused { return }
      // After a switch between two running cameras the new camera's first frame can be captured before
      // the old camera's last written one: the file's timestamps must keep rising.
      if multiVideo, lastVideoTime.isValid, CMTimeCompare(time, lastVideoTime) <= 0 { return }
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
    } else if output === audioOutput || output === rig?.audioOutput {
      // Audio before the first video frame (and while paused / until video resumes) is dropped.
      guard sessionStarted, !paused, !resumePending, let input = writerAudio, input.isReadyForMoreMediaData, let buffer = shifted(sampleBuffer) else { return }
      input.append(buffer)
    }
  }
}
