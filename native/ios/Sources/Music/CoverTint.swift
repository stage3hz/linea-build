import UIKit

/// The covers of tracks: fetched once over HTTPS (no cookies, no cache on disk) and kept in memory.
enum MusicCovers {
    static let ready = Notification.Name("invizent.music.cover")
    private static let cache = NSCache<NSString, UIImage>()
    /// Covers drawn in code (the simulator's samples), by track id.
    static var drawn: [String: UIImage] = [:]
    private static var busy = Set<String>()
    private static var failed = Set<String>()
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config)
    }()

    /// The cover when it is already here; otherwise nil, and `ready` is posted (object: the track's id) once it is.
    static func image(_ track: MusicTrack) -> UIImage? {
        if let made = drawn[track.id] { return made }
        if let found = cache.object(forKey: track.id as NSString) { return found }
        guard let address = track.artworkUrl, address.lowercased().hasPrefix("https://"), let url = URL(string: address), !busy.contains(track.id), !failed.contains(track.id) else { return nil }
        let id = track.id
        busy.insert(id)
        session.dataTask(with: url) { data, response, _ in
            var picture: UIImage?
            if let data, data.count <= 8 * 1024 * 1024, (response as? HTTPURLResponse)?.statusCode == 200 { picture = UIImage(data: data) }
            DispatchQueue.main.async {
                busy.remove(id)
                guard let picture else {
                    failed.insert(id)
                    return
                }
                cache.setObject(picture, forKey: id as NSString)
                NotificationCenter.default.post(name: ready, object: id)
            }
        }.resume()
        return nil
    }
}

/// The colours of the light under the bar while music plays: three colours taken from the track's cover, left
/// to right. Ported from mobile/src/design/coverTint.ts (`glowOf`, and the cover read as three places across its
/// width, as the reference's canvas path does) and design/avatarTint.ts (`vividTint`). A track without a cover,
/// or a cover with no colour of its own (black and white), has none — the bar keeps its calm light.
enum CoverTint {
    private static let key = "linea.cover-tint.v1"
    private static let limit = 200
    private static var order: [String] = []
    /// Known answers by track id: three `#rrggbb`, or an empty list for «no colour».
    private static var known: [String: [String]] = {
        let stored = UserDefaults.standard.dictionary(forKey: key) as? [String: [String]] ?? [:]
        return stored.filter { $0.value.isEmpty || ($0.value.count == 3 && $0.value.allSatisfy { MusicCatalog.matches("^#[0-9a-fA-F]{6}$", $0) }) }
    }()

    /// A colour as a light: its own hue, saturated enough to read as a colour, neither too dark nor washed
    /// out. No colour of its own gives "".
    static func vivid(_ r: Int, _ g: Int, _ b: Int) -> String {
        let R = Double(r) / 255, G = Double(g) / 255, B = Double(b) / 255
        let top = max(R, G, B), low = min(R, G, B), l = (top + low) / 2, d = top - low
        if d < 0.06 { return "" }
        let spread = 1 - abs(2 * l - 1)
        let sat = d / (spread == 0 ? 1 : spread)
        var hue: Double
        if top == R { hue = ((G - B) / d + 6).truncatingRemainder(dividingBy: 6) * 60 }
        else if top == G { hue = ((B - R) / d + 2) * 60 }
        else { hue = ((R - G) / d + 4) * 60 }
        if hue < 0 { hue += 360 }
        let s = min(0.85, max(0.5, sat * 1.5)), light = min(0.62, max(0.46, l))
        let a = s * min(light, 1 - light)
        func part(_ n: Double) -> String {
            let k = (n + hue / 30).truncatingRemainder(dividingBy: 12)
            let value = Int((255 * (light - a * max(-1, min(k - 3, 9 - k, 1)))).rounded())
            return String(format: "%02x", max(0, min(255, value)))
        }
        return "#" + part(0) + part(8) + part(4)
    }

    /// Three cover colours as lights; a cover with no colour of its own gives nil.
    static func glowOf(_ colors: [(Int, Int, Int)]) -> [String]? {
        let lights = colors.map { vivid($0.0, $0.1, $0.2) }
        guard lights.count == 3, let first = lights.first(where: { !$0.isEmpty }) else { return nil }
        return lights.map { $0.isEmpty ? first : $0 }
    }

    /// The cover's colour at three places from left to right.
    static func row(_ picture: UIImage) -> [(Int, Int, Int)]? {
        guard let source = picture.cgImage else { return nil }
        var pixels = [UInt8](repeating: 0, count: 12)
        let made: Bool = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: 3, height: 1, bitsPerComponent: 8, bytesPerRow: 12, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            context.interpolationQuality = .high
            context.draw(source, in: CGRect(x: 0, y: 0, width: 3, height: 1))
            return true
        }
        guard made else { return nil }
        var out: [(Int, Int, Int)] = []
        for place in 0..<3 {
            let at = place * 4
            let red = Int(pixels[at]), green = Int(pixels[at + 1]), blue = Int(pixels[at + 2])
            out.append((red, green, blue))
        }
        return out
    }

    private static func remember(_ id: String, _ glow: [String]) {
        known[id] = glow
        order.removeAll { $0 == id }
        order.append(id)
        while known.count > limit {
            let oldest = order.isEmpty ? known.keys.first : order.removeFirst()
            guard let oldest else { break }
            known[oldest] = nil
        }
        UserDefaults.standard.set(known, forKey: key)
    }

    /// The cover's three colours, or nil while unknown / when there is none.
    static func glow(_ track: MusicTrack?) -> [String]? {
        guard let track else { return nil }
        if let found = known[track.id] { return found.isEmpty ? nil : found }
        guard MusicCovers.drawn[track.id] != nil || (track.artworkUrl ?? "").lowercased().hasPrefix("https://") else { return nil }
        guard let picture = MusicCovers.image(track) else { return nil }
        let glow = row(picture).flatMap { glowOf($0) }
        remember(track.id, glow ?? [])
        return glow
    }
}

/// Keeps the shell's bar lit by the playing track's cover: calm silver while nothing plays or the cover gives no colour.
final class MusicGlow: NSObject {
    private static var shared: MusicGlow?
    private weak var root: RootViewController?
    private var shown: [String] = []

    static func attach(_ root: RootViewController) {
        let glow = MusicGlow()
        glow.root = root
        shared = glow
        NotificationCenter.default.addObserver(glow, selector: #selector(update), name: MusicPlayer.changed, object: nil)
        NotificationCenter.default.addObserver(glow, selector: #selector(update), name: MusicCovers.ready, object: nil)
        glow.update()
    }

    @objc private func update() {
        let player = MusicPlayer.shared
        var colours: [String] = []
        if let current = player.current, player.playing { colours = CoverTint.glow(current) ?? [] }
        if colours == shown { return }
        shown = colours
        root?.setBarGlow(colours)
    }
}
