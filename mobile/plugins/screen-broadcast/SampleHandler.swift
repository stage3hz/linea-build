import ReplayKit
import CoreImage
import ImageIO
import Darwin

final class SampleHandler: RPBroadcastSampleHandler {
  private var fd: Int32 = -1
  private let context = CIContext(options: [.cacheIntermediates: false])
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "invizent.screen.frames")
  private var busy = false
  private var stopped = false
  private var last: CMTime = .invalid
  private var defaults: UserDefaults?
  private var longEdge: CGFloat = 1280
  override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "RTCAppGroupIdentifier") as? String,
      let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
      let d = UserDefaults(suiteName: group) else { fail("Профиль подписи не разрешает App Groups."); return }
    defaults = d; longEdge = d.string(forKey: "quality") == "1080p60" ? 1920 : 1280
    let socketPath = directory.appendingPathComponent("rtc_SSFD").path
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { fail("Не удалось открыть канал экрана."); return }
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { fail("Слишком длинный путь App Group."); return }
    withUnsafeMutableBytes(of: &address.sun_path) { target in bytes.withUnsafeBytes { source in target.copyBytes(from: source) } }
    let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    guard result == 0 else { fail("Открой голосовой канал и включи демонстрацию в Инвизе."); return }
    var yes: Int32 = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
    var timeout = timeval(tv_sec: 2, tv_usec: 0); setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    d.set(true, forKey: "active"); d.synchronize()
  }
  override func broadcastFinished() { lock.lock(); stopped = true; lock.unlock(); defaults?.set(false, forKey: "active"); defaults?.synchronize(); if fd >= 0 { shutdown(fd, SHUT_RDWR); close(fd); fd = -1 } }
  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    guard sampleBufferType == .video else { return }
    if defaults?.bool(forKey: "stop") == true { fail("Демонстрация остановлена."); return }
    let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    lock.lock()
    guard !stopped && !busy && (!last.isValid || CMTimeGetSeconds(timestamp - last) >= (1.0 / 60.0 - 0.001)) else { lock.unlock(); return }
    busy = true; last = timestamp; lock.unlock()
    queue.async { [self] in
      defer { lock.lock(); busy = false; lock.unlock() }
      autoreleasepool {
        guard fd >= 0, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let image = CIImage(cvPixelBuffer: buffer)
        let scale = min(1, longEdge / max(image.extent.width, image.extent.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let color = CGColorSpace(name: CGColorSpace.sRGB), let jpeg = context.jpegRepresentation(of: scaled, colorSpace: color, options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.75]) else { return }
        let orientation = (CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber)?.intValue ?? 1
        let header = "HTTP/1.1 200 OK\r\nContent-Length: \(jpeg.count)\r\nBuffer-Width: \(Int(scaled.extent.width))\r\nBuffer-Height: \(Int(scaled.extent.height))\r\nBuffer-Orientation: \(orientation)\r\n\r\n"
        var data = Data(header.utf8); data.append(jpeg)
        let ok = data.withUnsafeBytes { raw -> Bool in
          var offset = 0
          while offset < raw.count { let sent = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset); if sent <= 0 { return false }; offset += sent }
          return true
        }
        if !ok { fail("Соединение демонстрации прервано.") }
      }
    }
  }
  private func fail(_ message: String) { finishBroadcastWithError(NSError(domain: "INVIZENT.Screen", code: 1, userInfo: [NSLocalizedDescriptionKey: message])) }
}
