import AVFoundation
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
  private var readySent = false

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

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    previewLayer.session = session
    previewLayer.videoGravity = .resizeAspectFill
    layer.addSublayer(previewLayer)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
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
  /// Kept per camera and per connection kind (recording / preview), read once before the first change.
  private var defaultAngles: [String: CGFloat] = [:]

  @available(iOS 17.0, *)
  private func setPortrait(_ connection: AVCaptureConnection, kind: String) {
    let key = "\(kind)|\(videoInput?.device.uniqueID ?? facing)"
    let base = defaultAngles[key] ?? connection.videoRotationAngle
    defaultAngles[key] = base
    let upright = (base + 90).truncatingRemainder(dividingBy: 360)
    if connection.isVideoRotationAngleSupported(upright) { connection.videoRotationAngle = upright }
    else if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
  }

  private func applyConnection() {
    guard let connection = videoOutput.connection(with: .video) else { return }
    if #available(iOS 17.0, *) {
      setPortrait(connection, kind: "output")
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
    if connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = facing == "front"
    }
    if let preview = previewLayer.connection {
      if #available(iOS 17.0, *) {
        setPortrait(preview, kind: "preview")
      } else if preview.isVideoOrientationSupported {
        preview.videoOrientation = .portrait
      }
      if preview.isVideoMirroringSupported {
        preview.automaticallyAdjustsVideoMirroring = false
        preview.isVideoMirrored = facing == "front"
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
      if !self.configured { self.configured = self.configure(); if self.configured { self.applyConnection() } }
      guard self.configured else { return }
      if !self.session.isRunning { self.session.startRunning() }
      self.applyTorch()
      if self.session.isRunning && !self.readySent {
        self.readySent = true
        DispatchQueue.main.async { self.onReady([:]) }
      }
    }
  }

  private func stopSession() {
    sessionQueue.async {
      if self.session.isRunning { self.session.stopRunning() }
      self.readySent = false
    }
  }

  /** Swaps only the camera input: the writer and the microphone keep going, so a flip does not stop the take. */
  func setFacing(_ value: String) {
    let next = value == "back" ? "back" : "front"
    sessionQueue.async {
      guard next != self.facing else { return }
      self.facing = next
      guard self.configured, let camera = self.device(for: next), let input = try? AVCaptureDeviceInput(device: camera) else { return }
      self.session.beginConfiguration()
      if let old = self.videoInput { self.session.removeInput(old) }
      if self.session.canAddInput(input) { self.session.addInput(input); self.videoInput = input }
      else if let old = self.videoInput, self.session.canAddInput(old) { self.session.addInput(old) }
      self.session.commitConfiguration()
      // After the commit: the new camera's connections exist and still hold their own default rotation.
      self.applyConnection()
      self.applyTorch()
      self.applyZoom()
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
    guard let writer = writer, !stopping, CMSampleBufferDataIsReady(sampleBuffer) else { return }
    let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if output === videoOutput {
      // Right after a camera flip the new camera can deliver a few landscape frames before the
      // rotation applies: they are skipped, the file simply holds the last good frame a moment.
      if let pixels = CMSampleBufferGetImageBuffer(sampleBuffer), CVPixelBufferGetWidth(pixels) > CVPixelBufferGetHeight(pixels) { return }
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
