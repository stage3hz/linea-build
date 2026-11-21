import ImageIO
import UIKit

/// Profile pictures at profile size (the chat list's store keeps 180 px, too small for a 116 pt avatar), animated
/// GIF avatars, and the files of video avatars and video banners. Asked as this session with the headers the chat
/// list uses (`ChatAvatarStore.shared.headers`), kept in the caches folder, decoded off the main queue.
/// Main thread only; `ready` is posted (object: the key) when something asked for has arrived.
final class AvatarMedia {
    static let shared = AvatarMedia()
    static let ready = Notification.Name("invizent.avatar-media-ready")

    private let memory = NSCache<NSString, UIImage>()
    private var loading = Set<String>()
    private var failedAt: [String: Date] = [:]
    private var videos: [String: URL] = [:]
    private let folder: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("invizent-profile-media", isDirectory: true)
    }()

    private init() {
        memory.totalCostLimit = 96 * 1024 * 1024
    }

    /// The address of a profile file (`GET /files/<id>`) on `base`; empty when either is empty.
    static func address(base: String, id: String) -> String {
        guard !base.isEmpty, !id.isEmpty else { return "" }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
        return base + "/files/" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }

    private func fileName(_ key: String, _ ending: String) -> URL {
        let name = String(key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
        return folder.appendingPathComponent(name + ending)
    }

    /// A picture `pixels` across at most; `animated`: a GIF keeps its frames. Nil while it is not here yet.
    func image(id: String, base: String, pixels: Int, animated: Bool) -> UIImage? {
        let address = AvatarMedia.address(base: base, id: id)
        guard !address.isEmpty else { return nil }
        let key = "\(id)@\(pixels)\(animated ? "a" : "")"
        if let hit = memory.object(forKey: key as NSString) { return hit }
        if loading.contains(key) { return nil }
        if let at = failedAt[key], Date().timeIntervalSince(at) < 60 { return nil }
        loading.insert(key)
        let file = fileName(id, ".bin")
        fetch(address, to: file) { [weak self] (data: Data?) -> Void in
            let image = data.flatMap { AvatarMedia.decode($0, pixels: pixels, animated: animated) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.loading.remove(key)
                if let image {
                    let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4) * max(1, image.images?.count ?? 1)
                    self.memory.setObject(image, forKey: key as NSString, cost: cost)
                } else {
                    self.failedAt[key] = Date()
                }
                NotificationCenter.default.post(name: AvatarMedia.ready, object: id)
            }
        }
        return nil
    }

    /// The local file of a video (avatar or banner), downloaded once. Nil while it is not here yet.
    func video(id: String, base: String) -> URL? {
        if let hit = videos[id], FileManager.default.fileExists(atPath: hit.path) { return hit }
        let address = AvatarMedia.address(base: base, id: id)
        guard !address.isEmpty else { return nil }
        let key = "video:" + id
        if loading.contains(key) { return nil }
        if let at = failedAt[key], Date().timeIntervalSince(at) < 60 { return nil }
        let file = fileName(id, ".mp4")
        if FileManager.default.fileExists(atPath: file.path) {
            videos[id] = file
            return file
        }
        loading.insert(key)
        fetch(address, to: file) { [weak self] (data: Data?) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                self.loading.remove(key)
                if data != nil { self.videos[id] = file } else { self.failedAt[key] = Date() }
                NotificationCenter.default.post(name: AvatarMedia.ready, object: id)
            }
        }
        return nil
    }

    /// The file from the caches folder, or one download (certificates checked as usual) kept there.
    private func fetch(_ address: String, to file: URL, done: @escaping (Data?) -> Void) {
        let headers = ChatAvatarStore.shared.headers
        let directory = folder
        DispatchQueue.global(qos: .utility).async {
            if let kept = try? Data(contentsOf: file), !kept.isEmpty { return done(kept) }
            guard let url = URL(string: address), url.scheme == "https" || url.scheme == "http" else { return done(nil) }
            var request = URLRequest(url: url, timeoutInterval: 30)
            for (field, value) in headers { request.setValue(value, forHTTPHeaderField: field) }
            URLSession.shared.dataTask(with: request) { (data: Data?, response: URLResponse?, _: Error?) -> Void in
                guard let data, !data.isEmpty, (response as? HTTPURLResponse)?.statusCode == 200 else { return done(nil) }
                try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try? data.write(to: file, options: .atomic)
                done(data)
            }.resume()
        }
    }

    /// A still picture scaled to `pixels`, or — `animated` and a GIF — its frames with their timing.
    static func decode(_ data: Data, pixels: Int, animated: Bool) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let count = CGImageSourceGetCount(source)
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: max(32, pixels)]
        if animated && count > 1 {
            var frames: [UIImage] = []
            var total: Double = 0
            for index in 0..<min(count, 240) {
                guard let frame = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else { continue }
                frames.append(UIImage(cgImage: frame))
                total += frameDelay(source, index)
            }
            if frames.count > 1 { return UIImage.animatedImage(with: frames, duration: max(0.1, total)) }
            return frames.first
        }
        guard let still = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: still)
    }

    /// A GIF frame's delay as browsers read it (under 20 ms counts as 100 ms).
    private static func frameDelay(_ source: CGImageSource, _ index: Int) -> Double {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
              let gif = properties[kCGImagePropertyGIFDictionary] as? [CFString: Any] else { return 0.1 }
        let delay = (gif[kCGImagePropertyGIFUnclampedDelayTime] as? NSNumber)?.doubleValue ?? (gif[kCGImagePropertyGIFDelayTime] as? NSNumber)?.doubleValue ?? 0.1
        return delay < 0.02 ? 0.1 : delay
    }
}
