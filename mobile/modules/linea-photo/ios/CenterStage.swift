import AVFoundation

/// Center Stage (front camera keeps the face in frame while you move) on devices that have it:
/// iPhone 17 / Air / 17 Pro and Center Stage iPads. The app and the user share control
/// (`cooperative`), so it can also be switched in Control Center. Applies to every capture
/// session of the app (video messages and video calls) whose active format supports it.
enum CenterStage {
  static func supported() -> Bool {
    guard #available(iOS 14.5, *) else { return false }
    let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .builtInTrueDepthCamera], mediaType: .video, position: .front)
    return discovery.devices.contains { device in device.formats.contains { $0.isCenterStageSupported } }
  }
  static func set(_ enabled: Bool) -> [String: Any] {
    guard #available(iOS 14.5, *), supported() else { return ["supported": false, "enabled": false] }
    AVCaptureDevice.centerStageControlMode = .cooperative
    AVCaptureDevice.isCenterStageEnabled = enabled
    return ["supported": true, "enabled": AVCaptureDevice.isCenterStageEnabled]
  }
}
