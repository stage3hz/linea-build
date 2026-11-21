import CoreImage
import Darwin
import LiveKitWebRTC
import ReplayKit
import UIKit

/// The broadcast extension of this app (native/ios/ScreenBroadcast, «INVIZENT Screen»), as the reference's
/// LineScreenModule.swift talks to it: the shared App Group's settings carry the quality, whether the broadcast is
/// running (`active`, set by the extension) and the request to stop (`stop`, set here). The frames come over a
/// local socket inside the App Group's folder (ScreenCaptureSource below). Main queue.
enum ScreenBroadcast {
    /// The App Group shared with the extension (Info.plist `RTCAppGroupIdentifier`, as the reference names it).
    static var group: String? { Bundle.main.object(forInfoDictionaryKey: "RTCAppGroupIdentifier") as? String }
    /// The extension's bundle identifier (Info.plist `RTCScreenSharingExtension`).
    static var extensionId: String? { Bundle.main.object(forInfoDictionaryKey: "RTCScreenSharingExtension") as? String }
    private static weak var picker: RPSystemBroadcastPickerView?

    /// Whether the app carries the extension at all (an older build does not).
    static var installed: Bool {
        guard let plugins = Bundle.main.builtInPlugInsURL else { return false }
        return FileManager.default.fileExists(atPath: plugins.appendingPathComponent("ScreenBroadcast.appex").path)
    }

    /// The shared settings, or the reference's words when the signing does not allow the App Group.
    static func defaults() throws -> UserDefaults {
        guard let group, FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) != nil,
              let defaults = UserDefaults(suiteName: group) else {
            throw ScreenShareError(words: "Профиль подписи не разрешает App Groups для демонстрации экрана.")
        }
        return defaults
    }

    /// The path of the socket the frames come over.
    static func socketPath() throws -> String {
        guard let group, let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw ScreenShareError(words: "Профиль подписи не разрешает App Groups для демонстрации экрана.")
        }
        return folder.appendingPathComponent("rtc_SSFD").path
    }

    /// `prepareScreenCapture` + `configure`: the quality for the extension, a fresh start.
    static func configure(_ quality: ScreenQuality) throws {
        guard installed, extensionId != nil else { throw ScreenShareError(words: "Нужна новая IPA с расширением демонстрации экрана.") }
        let d = try defaults()
        d.set(quality.rawValue, forKey: "quality")
        d.set(false, forKey: "active")
        d.set(false, forKey: "stop")
        d.synchronize()
    }

    /// `showPicker`: the system's sheet «Начать трансляцию» for this app's extension (the person confirms there).
    static func showPicker() throws {
        let made = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        made.preferredExtension = extensionId
        made.showsMicrophoneButton = false
        var root: UIView?
        for scene in UIApplication.shared.connectedScenes {
            guard let scene = scene as? UIWindowScene else { continue }
            for window in scene.windows where window.isKeyWindow { root = window.rootViewController?.view }
        }
        guard let root else { throw ScreenShareError(words: "Не удалось включить демонстрацию.") }
        made.alpha = 0.01
        root.addSubview(made)
        picker?.removeFromSuperview()
        picker = made
        for view in made.subviews {
            if let button = view as? UIButton { button.sendActions(for: .touchUpInside) }
        }
    }

    /// `isActive`: the extension has connected and is sending.
    static func isActive() -> Bool {
        guard let d = try? defaults() else { return false }
        d.synchronize()
        return d.bool(forKey: "active")
    }

    /// `stop`: the extension ends the broadcast at its next frame.
    static func stop() {
        if let d = try? defaults() {
            d.set(true, forKey: "stop")
            d.synchronize()
        }
        picker?.removeFromSuperview()
        picker = nil
    }
}

/// A sentence for the person about why the screen is not shared.
struct ScreenShareError: Error {
    let words: String
}

/// This phone's screen as a video track: the reference's ScreenCaptureController + ScreenCapturer + SocketConnection
/// (react-native-webrtc). A local socket is opened in the App Group's folder before the system sheet is shown; the
/// extension connects to it and sends every frame as «HTTP/1.1 200 OK» headers (Content-Length, Buffer-Width,
/// Buffer-Height, Buffer-Orientation) followed by a JPEG; each JPEG is drawn into a pixel buffer and handed to the
/// WebRTC video source. Nothing of it leaves the phone except through an encrypted connection.
final class ScreenCaptureSource {
    let source: LKRTCVideoSource
    let track: LKRTCVideoTrack
    private let capturer: LKRTCVideoCapturer
    private let queue = DispatchQueue(label: "invizent.screen.socket")
    private var server: Int32 = -1
    private var client: Int32 = -1
    private var listening: DispatchSourceRead?
    private var reading: DispatchSourceRead?
    private var buffer = Data()
    private var start: Int64 = -1
    private var stopped = false
    private static let context = CIContext(options: nil)
    /// The extension closed the socket (the broadcast ended in Control Centre, or failed). Main queue.
    var onEnded: (() -> Void)?

    /// nil when the socket cannot be opened.
    init?(path: String) {
        source = CallMedia.factory.videoSource(forScreenCast: true)
        track = CallMedia.factory.videoTrack(with: source, trackId: UUID().uuidString.lowercased())
        capturer = LKRTCVideoCapturer(delegate: source)
        guard listenOn(path) else { return nil }
    }

    private func listenOn(_ path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            Darwin.close(fd)
            return false
        }
        withUnsafeMutableBytes(of: &address.sun_path) { (target: UnsafeMutableRawBufferPointer) -> Void in
            bytes.withUnsafeBytes { (from: UnsafeRawBufferPointer) -> Void in target.copyBytes(from: from) }
        }
        unlink(path)
        let bound = withUnsafePointer(to: &address) { (pointer: UnsafePointer<sockaddr_un>) -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { (raw: UnsafePointer<sockaddr>) -> Int32 in
                Darwin.bind(fd, raw, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, Darwin.listen(fd, 10) == 0 else {
            Darwin.close(fd)
            return false
        }
        server = fd
        let watcher = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        watcher.setEventHandler { [weak self] in self?.takeConnection() }
        listening = watcher
        watcher.resume()
        return true
    }

    private func takeConnection() {
        let fd = Darwin.accept(server, nil, nil)
        guard fd >= 0, !stopped else { return }
        // One sender at a time: a newer connection takes the place of the old one.
        reading?.cancel()
        if client >= 0 { Darwin.close(client) }
        client = fd
        buffer = Data()
        let watcher = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        watcher.setEventHandler { [weak self] in self?.readBytes() }
        reading = watcher
        watcher.resume()
    }

    private func readBytes() {
        guard client >= 0 else { return }
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let count = chunk.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) -> Int in Darwin.read(client, raw.baseAddress, raw.count) }
        if count <= 0 {
            if count < 0 && (errno == EAGAIN || errno == EINTR) { return }
            ended()
            return
        }
        buffer.append(contentsOf: chunk[0..<count])
        parse()
    }

    /// Takes every complete frame out of what has arrived.
    private func parse() {
        let separator = Data("\r\n\r\n".utf8)
        while let range = buffer.range(of: separator) {
            let head = String(decoding: buffer[buffer.startIndex..<range.lowerBound], as: UTF8.self)
            var fields: [String: String] = [:]
            for line in head.components(separatedBy: "\r\n") {
                guard let colon = line.firstIndex(of: ":") else { continue }
                fields[line[line.startIndex..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            guard let length = Int(fields["content-length"] ?? ""), length > 0, length < 32 * 1024 * 1024 else {
                // Not a frame: the stream cannot be read any further.
                ended()
                return
            }
            let bodyStart = range.upperBound
            guard buffer.distance(from: bodyStart, to: buffer.endIndex) >= length else { return }
            let bodyEnd = buffer.index(bodyStart, offsetBy: length)
            let jpeg = buffer.subdata(in: bodyStart..<bodyEnd)
            buffer = buffer.subdata(in: bodyEnd..<buffer.endIndex)
            let width = Int(fields["buffer-width"] ?? "") ?? 0
            let height = Int(fields["buffer-height"] ?? "") ?? 0
            let orientation = Int(fields["buffer-orientation"] ?? "") ?? 1
            deliver(jpeg, width: width, height: height, orientation: orientation)
        }
    }

    private func deliver(_ jpeg: Data, width: Int, height: Int, orientation: Int) {
        guard width > 0, height > 0, width <= 4096, height <= 4096, let image = CIImage(data: jpeg) else { return }
        var made: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()]
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &made) == kCVReturnSuccess, let pixels = made else { return }
        CVPixelBufferLockBaseAddress(pixels, [])
        ScreenCaptureSource.context.render(image, to: pixels)
        CVPixelBufferUnlockBaseAddress(pixels, [])
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let now = Int64(mach_absolute_time()) * Int64(info.numer) / Int64(info.denom)
        if start < 0 { start = now }
        // CGImagePropertyOrientation: left 8 → 90°, down 3 → 180°, right 6 → 270°.
        let rotation: LKRTCVideoRotation
        switch orientation {
        case 8: rotation = ._90
        case 3: rotation = ._180
        case 6: rotation = ._270
        default: rotation = ._0
        }
        let frame = LKRTCVideoFrame(buffer: LKRTCCVPixelBuffer(pixelBuffer: pixels), rotation: rotation, timeStampNs: now - start)
        source.capturer(capturer, didCapture: frame)
    }

    private func ended() {
        guard !stopped else { return }
        teardown()
        DispatchQueue.main.async { [weak self] in self?.onEnded?() }
    }

    private func teardown() {
        stopped = true
        reading?.cancel()
        reading = nil
        listening?.cancel()
        listening = nil
        if client >= 0 { Darwin.close(client) }
        client = -1
        if server >= 0 { Darwin.close(server) }
        server = -1
    }

    /// The share is over: the socket closes, the track is turned off.
    func stop() {
        onEnded = nil
        track.isEnabled = false
        queue.async { self.teardown() } // held until the socket is closed
    }
}
