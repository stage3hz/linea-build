import AVFoundation
import UIKit

/// Both cameras of a round-video recorder running at once (AVCaptureMultiCamSession, iOS 13+), so a flip
/// is only a switch of which camera's frames the writer takes and which preview layer is visible — as in
/// Telegram. Built after Apple's AVMultiCamPiP sample: inputs and outputs are added without connections
/// and every connection (camera → data output, camera → preview layer, microphone → audio output) is made
/// explicitly. Used by VideoNoteView (VideoNoteCamera.swift) only where `make()` returns a rig; every
/// other iPhone keeps the single-session recorder. All methods except `make()` run on the view's session
/// queue, inside the caller's beginConfiguration/commitConfiguration where noted.
final class VideoNoteMultiCam {
  final class Camera {
    let position: AVCaptureDevice.Position
    let facing: String
    let output = AVCaptureVideoDataOutput()
    /// Created on the main thread with `setSessionWithNoConnection`; its connection is made in `attach`.
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

  /// Main thread. Nil where the hardware cannot run two cameras (the session class must not even be made
  /// there) — the caller then uses its single-session path.
  static func make() -> VideoNoteMultiCam? {
    guard AVCaptureMultiCamSession.isMultiCamSupported else { return nil }
    let rig = VideoNoteMultiCam(session: AVCaptureMultiCamSession())
    for camera in [rig.front, rig.back] { camera.preview.setSessionWithNoConnection(rig.session) }
    return rig
  }

  func camera(_ facing: String) -> Camera { facing == "back" ? back : front }
  func other(_ camera: Camera) -> Camera { camera === front ? back : front }
  func camera(for output: AVCaptureOutput) -> Camera? {
    if output === front.output { return front }
    if output === back.output { return back }
    return nil
  }

  /// Front and back wide-angle cameras, only if the system lists them as a pair that may stream together.
  func findDevices() -> Bool {
    guard let frontDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
          let backDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { return false }
    let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .unspecified)
    guard discovery.supportedMultiCamDeviceSets.contains(where: { $0.contains(frontDevice) && $0.contains(backDevice) }) else { return false }
    front.device = frontDevice
    back.device = backDevice
    return true
  }

  /// Multi-cam formats for a camera, best first: 4:3 like the single-session path (VGA preset), at least
  /// 480 px on the short side, no more than 1280 px on the long one, 30 fps, smallest first (the writer
  /// encodes 480×640 anyway; a small format keeps hardware and system-pressure cost low).
  static func formats(_ device: AVCaptureDevice) -> [AVCaptureDevice.Format] {
    let candidates = device.formats.filter { format in
      guard format.isMultiCamSupported else { return false }
      let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
      guard subtype == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || subtype == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange else { return false }
      let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
      let long = max(size.width, size.height), short = min(size.width, size.height)
      guard long <= 1280, short >= 360 else { return false }
      return format.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 30 && 30 <= $0.maxFrameRate }
    }
    func rank(_ format: AVCaptureDevice.Format) -> (Int, Int, Int32, Int) {
      let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
      let long = max(size.width, size.height), short = min(size.width, size.height)
      let fourThree = long * 3 == short * 4 ? 0 : 1
      let bigEnough = short >= 480 ? 0 : 1
      let videoRange = CMFormatDescriptionGetMediaSubType(format.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ? 0 : 1
      return (bigEnough, fourThree, long * short, videoRange)
    }
    if !candidates.isEmpty { return candidates.sorted { rank($0) < rank($1) } }
    // A camera with no small multi-cam format (a new sensor's format list) would send the whole recorder to
    // the slow single-session path: any multi-cam 4:2:0 format at 30 fps then, smallest first (the writer
    // scales to 480×640 anyway; fitCost steps down further if needed).
    let relaxed = device.formats.filter { format in
      guard format.isMultiCamSupported else { return false }
      let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
      guard subtype == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || subtype == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange else { return false }
      return format.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 30 && 30 <= $0.maxFrameRate }
    }
    return relaxed.sorted { rank($0) < rank($1) }
  }

  /// The smallest multi-cam format (by area) — the step down when the session costs too much.
  static func smallestFormat(_ device: AVCaptureDevice) -> AVCaptureDevice.Format? {
    formats(device).min { a, b in
      let x = CMVideoFormatDescriptionGetDimensions(a.formatDescription), y = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
      return Int(x.width) * Int(x.height) < Int(y.width) * Int(y.height)
    }
  }

  /// Format, at most 30 fps, and the same SDR colour space on both cameras (as the single path does).
  @discardableResult
  static func use(_ format: AVCaptureDevice.Format, on device: AVCaptureDevice) -> Bool {
    do { try device.lockForConfiguration() } catch { return false }
    defer { device.unlockForConfiguration() }
    device.activeFormat = format
    if format.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 30 && 30 <= $0.maxFrameRate }) {
      device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
    }
    if format.supportedColorSpaces.contains(.sRGB) { device.activeColorSpace = .sRGB }
    return true
  }

  /// Inside the caller's configuration: the camera's input and its two connections (data output, preview
  /// layer). The caller sets their rotation and mirroring before committing. False leaves nothing behind.
  func attach(_ camera: Camera) -> Bool {
    guard !camera.attached else { return true }
    guard let device = camera.device, let format = VideoNoteMultiCam.formats(device).first,
          let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return false }
    session.addInputWithNoConnections(input)
    guard VideoNoteMultiCam.use(format, on: device),
          let port = input.ports(for: .video, sourceDeviceType: device.deviceType, sourceDevicePosition: device.position).first else {
      session.removeInput(input); return false
    }
    let data = AVCaptureConnection(inputPorts: [port], output: camera.output)
    guard session.canAddConnection(data) else { session.removeInput(input); return false }
    session.addConnection(data)
    let preview = AVCaptureConnection(inputPort: port, videoPreviewLayer: camera.preview)
    guard session.canAddConnection(preview) else { session.removeConnection(data); session.removeInput(input); return false }
    session.addConnection(preview)
    camera.input = input
    camera.dataConnection = data
    camera.previewConnection = preview
    return true
  }

  /// Inside the caller's configuration: the camera stops streaming (its connections and input go).
  func detach(_ camera: Camera) {
    if let connection = camera.dataConnection { session.removeConnection(connection) }
    if let connection = camera.previewConnection { session.removeConnection(connection) }
    if let input = camera.input { session.removeInput(input) }
    camera.input = nil
    camera.dataConnection = nil
    camera.previewConnection = nil
  }

  /// Inside the caller's configuration: the outputs (no connections yet) and the microphone, connected
  /// explicitly to the audio output. Without a microphone the take is silent, as on the single path.
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
    // The omnidirectional port (as the single session's implicit connection uses); else any audio port.
    let port = input.ports(for: .audio, sourceDeviceType: mic.deviceType, sourceDevicePosition: .unspecified).first
      ?? input.ports.first(where: { $0.mediaType == .audio })
    guard let audioPort = port else { session.removeInput(input); return true }
    let connection = AVCaptureConnection(inputPorts: [audioPort], output: audioOutput)
    if session.canAddConnection(connection) { session.addConnection(connection) } else { session.removeInput(input) }
    return true
  }

  /// After the commit: hardware and system-pressure cost must stay below 1.0 or the session cannot run.
  /// Steps both cameras down to their smallest multi-cam format once; false if that is still too much.
  func fitCost() -> Bool {
    if session.hardwareCost < 1.0 && session.systemPressureCost < 1.0 { return true }
    session.beginConfiguration()
    for camera in [front, back] where camera.attached {
      if let device = camera.device, let format = VideoNoteMultiCam.smallestFormat(device) { VideoNoteMultiCam.use(format, on: device) }
    }
    session.commitConfiguration()
    return session.hardwareCost < 1.0 && session.systemPressureCost < 1.0
  }

  /// Everything out of the multi-cam session, so the single-session fallback can take the cameras.
  func tearDown() {
    if session.isRunning { session.stopRunning() }
    session.beginConfiguration()
    for connection in session.connections { session.removeConnection(connection) }
    for input in session.inputs { session.removeInput(input) }
    for output in session.outputs { session.removeOutput(output) }
    session.commitConfiguration()
    for camera in [front, back] { camera.input = nil; camera.dataConnection = nil; camera.previewConnection = nil }
  }
}
