import CoreImage
import UIKit

/// Chat wallpapers (the reference's wallpapers.ts): a preset gradient or the person's own picture, for all chats or
/// one chat. Kept only on this phone (pictures in the app's own folder); never sent anywhere.
struct WallpaperChoice: Equatable {
    /// "preset" or "image".
    var kind: String
    /// A preset's id («none», «aurora», …).
    var preset = "none"
    /// The picture's file name in the app's wallpapers folder.
    var file = ""
    var blur = false
    var motion = false
    var dim: Double = 0.2
    /// How the picture is fitted (wallpaperFit.ts): its width / height, the zoom and the shift as shares of the screen.
    var aspect: Double = 0
    var zoom: Double = 1
    var fx: Double = 0
    var fy: Double = 0

    static func preset(_ id: String) -> WallpaperChoice { WallpaperChoice(kind: "preset", preset: id) }

    var isImage: Bool { kind == "image" }

    /// The preset's colours; nil for «Как фон» and for a picture.
    var colors: [UInt32]? {
        guard kind == "preset" else { return nil }
        return Wallpapers.presetColors(preset)
    }

    /// A wallpaper is on (a gradient or a picture): the chat then shows its words in bubbles, as in the reference.
    var shown: Bool { isImage || colors != nil }

    var fields: [String: Any] {
        if isImage {
            return ["kind": "image", "file": file, "blur": blur, "motion": motion, "dim": dim, "aspect": aspect, "zoom": zoom, "fx": fx, "fy": fy]
        }
        return ["kind": "preset", "id": preset]
    }

    /// A stored choice read back, as `parseWallpapers` does: anything unknown or broken is dropped.
    static func read(_ raw: Any?) -> WallpaperChoice? {
        guard let item = raw as? [String: Any] else { return nil }
        if item["kind"] as? String == "preset", let id = item["id"] as? String, Wallpapers.presetIds.contains(id) { return .preset(id) }
        guard item["kind"] as? String == "image", let file = item["file"] as? String, !file.isEmpty, !file.contains("/") else { return nil }
        func number(_ name: String, _ fallback: Double) -> Double {
            guard let value = (item[name] as? NSNumber)?.doubleValue, value.isFinite else { return fallback }
            return value
        }
        let dims: [Double] = [0, 0.2, 0.4, 0.6]
        let dim = number("dim", 0.2)
        let aspect = number("aspect", 0)
        return WallpaperChoice(kind: "image", file: file, blur: item["blur"] as? Bool == true, motion: item["motion"] as? Bool == true,
                               dim: dims.contains(dim) ? dim : 0.2, aspect: aspect > 0.05 && aspect < 20 ? aspect : 0,
                               zoom: min(WallpaperFit.maxZoom, max(1, number("zoom", 1))),
                               fx: min(WallpaperFit.maxZoom, max(-WallpaperFit.maxZoom, number("fx", 0))),
                               fy: min(WallpaperFit.maxZoom, max(-WallpaperFit.maxZoom, number("fy", 0))))
    }
}

/// How the person's own picture is fitted (the reference's wallpaperFit.ts, the same maths).
enum WallpaperFit {
    static let maxZoom: Double = 4

    /// The size the picture is drawn at to cover a `width` × `height` screen at zoom 1.
    static func cover(aspect: Double, width: Double, height: Double) -> CGSize {
        let a = aspect > 0 && aspect.isFinite ? aspect : width / max(1, height)
        if a > width / max(1, height) { return CGSize(width: height * a, height: height) }
        return CGSize(width: width, height: width / a)
    }

    /// The fit kept inside its limits: zoom 1…4, never moved so far that an edge shows.
    static func clamp(zoom: Double, fx: Double, fy: Double, aspect: Double, width: Double, height: Double) -> (zoom: Double, fx: Double, fy: Double) {
        let z = min(maxZoom, max(1, zoom.isFinite ? zoom : 1))
        guard width > 0, height > 0 else { return (z, 0, 0) }
        let size = cover(aspect: aspect, width: width, height: height)
        let maxX = max(0, (Double(size.width) * z - width) / 2 / width), maxY = max(0, (Double(size.height) * z - height) / 2 / height)
        let x = fx.isFinite ? fx : 0, y = fy.isFinite ? fy : 0
        return (z, min(maxX, max(-maxX, x)), min(maxY, max(-maxY, y)))
    }
}

/// Where the choices are kept: the global one and those of single chats.
enum Wallpapers {
    static let changed = Notification.Name("invizent.wallpapers-changed")
    private static let key = "invizent.wallpapers.v1"

    /// The presets as the core lists them (the reference's WALLPAPERS: id, label, colours or none).
    static var presets: [(id: String, label: String, colors: [UInt32]?)] {
        var result: [(id: String, label: String, colors: [UInt32]?)] = []
        for item in ThemeStore.list("wallpapers") {
            guard let id = item["id"] as? String, let label = item["label"] as? String else { continue }
            let colors = (item["colors"] as? [String])?.compactMap { LookColor.hex($0) }
            result.append((id, label, colors?.isEmpty == false ? colors : nil))
        }
        if result.isEmpty {
            // The reference's own list, should the core not answer.
            result = [("none", "Как фон", nil), ("aurora", "Аврора", [0x0E2A47, 0x1B3F6B, 0x3A2A63]), ("night", "Ночь", [0x05060B, 0x0B1020, 0x121A33]),
                      ("mint", "Мята", [0x0D3B3A, 0x145650, 0x1E3B5A]), ("sunset", "Закат", [0x3B1838, 0x5A2440, 0x2A1E4A]),
                      ("violet", "Фиолет", [0x3A2D8F, 0x5B3FB8, 0x2B5BB5])]
        }
        return result
    }

    static var presetIds: [String] { presets.map { $0.id } }

    static func presetColors(_ id: String) -> [UInt32]? { presets.first { $0.id == id }?.colors }

    #if targetEnvironment(simulator)
    /// The simulator check: a choice shown without being kept.
    static var demo: WallpaperChoice?
    #endif

    private static func stored() -> (global: WallpaperChoice?, chats: [String: WallpaperChoice]) {
        guard let text = UserDefaults.standard.string(forKey: key), let value = Core.value(text) as? [String: Any] else { return (nil, [:]) }
        var chats: [String: WallpaperChoice] = [:]
        for (id, item) in value["chats"] as? [String: Any] ?? [:] {
            if let choice = WallpaperChoice.read(item), id.count == 36 { chats[id] = choice }
        }
        return (WallpaperChoice.read(value["global"]), chats)
    }

    private static func save(global: WallpaperChoice?, chats: [String: WallpaperChoice]) {
        let before = Set(files(global: stored().global, chats: stored().chats))
        var value: [String: Any] = ["chats": chats.mapValues { $0.fields }]
        value["global"] = global?.fields ?? NSNull()
        if let text = Core.text(value) { UserDefaults.standard.set(text, forKey: key) }
        // Pictures no wallpaper uses any more are deleted.
        let after = Set(files(global: global, chats: chats))
        for name in before.subtracting(after) { try? FileManager.default.removeItem(at: folder.appendingPathComponent(name)) }
        NotificationCenter.default.post(name: changed, object: nil)
    }

    private static func files(global: WallpaperChoice?, chats: [String: WallpaperChoice]) -> [String] {
        return ([global] + chats.values.map { Optional($0) }).compactMap { (item: WallpaperChoice?) -> String? in
            guard let item, item.isImage else { return nil }
            return item.file
        }
    }

    /// The wallpaper of a chat: its own, else the global one, else the preset of the preferences.
    static func choice(chatId: String) -> WallpaperChoice {
        #if targetEnvironment(simulator)
        if let demo { return demo }
        #endif
        let all = stored()
        if !chatId.isEmpty, let own = all.chats[chatId] { return own }
        if let global = all.global { return global }
        return .preset(DevicePreferences.word("wallpaper") ?? "none")
    }

    static func hasOwn(chatId: String) -> Bool { stored().chats[chatId] != nil }

    /// Sets a wallpaper for one chat (`chatId`) or for all (nil removes it).
    static func set(_ choice: WallpaperChoice?, chatId: String?) {
        let all = stored()
        if let chatId, !chatId.isEmpty {
            var chats = all.chats
            chats[chatId] = choice
            save(global: all.global, chats: chats)
        } else {
            save(global: choice, chats: all.chats)
        }
    }

    /// The app's own folder of pictures (Application Support, not backed up to the cloud).
    static var folder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let url = base.appendingPathComponent("wallpapers", isDirectory: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            var made = url
            try? FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? made.setResourceValues(values)
        }
        return url
    }

    /// Keeps a picked picture as a phone-screen-sized JPEG (1600 points wide at most) in the app's folder; its file name.
    static func keep(_ image: UIImage) -> String? {
        var picture = image
        if image.size.width > 1600 {
            let size = CGSize(width: 1600, height: (1600 * image.size.height / image.size.width).rounded())
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            picture = UIGraphicsImageRenderer(size: size, format: format).image { (_: UIGraphicsImageRendererContext) -> Void in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
        }
        guard let data = picture.jpegData(compressionQuality: 0.85) else { return nil }
        let name = UUID().uuidString.lowercased() + ".jpg"
        do {
            try data.write(to: folder.appendingPathComponent(name), options: [.atomic, .completeFileProtection])
        } catch {
            return nil
        }
        return name
    }

    /// A picture picked and then not used is deleted (unless a wallpaper uses it).
    static func discard(_ file: String) {
        guard !file.isEmpty, !file.contains("/") else { return }
        let all = stored()
        if files(global: all.global, chats: all.chats).contains(file) { return }
        try? FileManager.default.removeItem(at: folder.appendingPathComponent(file))
    }

    static func image(_ file: String) -> UIImage? {
        guard !file.isEmpty else { return nil }
        return UIImage(contentsOfFile: folder.appendingPathComponent(file).path)
    }

    /// The picture blurred as the reference's `blurRadius={18}`.
    static func blurred(_ image: UIImage) -> UIImage? {
        guard let source = CIImage(image: image) else { return nil }
        let filter = CIFilter(name: "CIGaussianBlur")
        filter?.setValue(source.clampedToExtent(), forKey: kCIInputImageKey)
        filter?.setValue(18 * image.scale, forKey: kCIInputRadiusKey)
        guard let output = filter?.outputImage?.cropped(to: source.extent) else { return nil }
        guard let made = CIContext(options: nil).createCGImage(output, from: source.extent) else { return nil }
        return UIImage(cgImage: made, scale: image.scale, orientation: .up)
    }
}

/// A chat's wallpaper behind the messages (the reference's `ChatWallpaper`): a preset gradient, or the picture
/// with its blur, dimming (dark themes) and the slight movement with the phone's tilt.
final class WallpaperView: UIView {
    private let gradient = CAGradientLayer()
    private let frameView = UIView()
    private let picture = UIImageView()
    private let veil = UIView()
    private var choice = WallpaperChoice.preset("none")
    private var shownFile = ""
    private var shownBlur = false
    private var motion: UIMotionEffectGroup?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        layer.addSublayer(gradient)
        addSubview(frameView)
        picture.contentMode = .scaleToFill
        frameView.addSubview(picture)
        veil.backgroundColor = .black
        addSubview(veil)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ next: WallpaperChoice) {
        choice = next
        if let colors = next.colors {
            gradient.colors = colors.map { LookColor.color($0).cgColor }
            gradient.isHidden = false
        } else {
            gradient.isHidden = true
        }
        frameView.isHidden = !next.isImage
        veil.isHidden = !(next.isImage && Theme.dark && next.dim > 0)
        veil.alpha = CGFloat(next.dim)
        if next.isImage && (next.file != shownFile || next.blur != shownBlur) {
            shownFile = next.file
            shownBlur = next.blur
            let raw = Wallpapers.image(next.file)
            picture.image = raw
            if next.blur, let raw {
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    let soft = Wallpapers.blurred(raw)
                    DispatchQueue.main.async {
                        guard let self, self.shownFile == next.file, self.shownBlur else { return }
                        self.picture.image = soft ?? raw
                    }
                }
            }
        }
        // «Движение»: the picture follows the phone's tilt by up to 14 points, drawn 8 % larger.
        if next.isImage && next.motion && !UIAccessibility.isReduceMotionEnabled {
            if motion == nil {
                let x = UIInterpolatingMotionEffect(keyPath: "center.x", type: .tiltAlongHorizontalAxis)
                x.minimumRelativeValue = -14
                x.maximumRelativeValue = 14
                let y = UIInterpolatingMotionEffect(keyPath: "center.y", type: .tiltAlongVerticalAxis)
                y.minimumRelativeValue = -14
                y.maximumRelativeValue = 14
                let group = UIMotionEffectGroup()
                group.motionEffects = [x, y]
                frameView.addMotionEffect(group)
                motion = group
            }
        } else if let motion {
            frameView.removeMotionEffect(motion)
            self.motion = nil
        }
        setNeedsLayout()
    }

    /// The preview: the fit follows the fingers.
    func fit(zoom: Double, fx: Double, fy: Double) {
        choice.zoom = zoom
        choice.fx = fx
        choice.fy = fy
        setNeedsLayout()
        layoutIfNeeded()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.frame = bounds
        CATransaction.commit()
        veil.frame = bounds
        frameView.bounds = CGRect(origin: .zero, size: bounds.size)
        frameView.center = CGPoint(x: bounds.midX, y: bounds.midY)
        let grown: CGFloat = choice.motion ? 1.08 : 1
        frameView.transform = CGAffineTransform(scaleX: grown, y: grown)
        let width = Double(bounds.width), height = Double(bounds.height)
        guard width > 0, height > 0 else { return }
        var aspect = choice.aspect
        if aspect <= 0, let image = picture.image, image.size.height > 0 { aspect = Double(image.size.width / image.size.height) }
        let size = WallpaperFit.cover(aspect: aspect, width: width, height: height)
        let fitted = WallpaperFit.clamp(zoom: choice.zoom, fx: choice.fx, fy: choice.fy, aspect: aspect, width: width, height: height)
        picture.bounds = CGRect(origin: .zero, size: size)
        picture.center = CGPoint(x: bounds.midX + CGFloat(fitted.fx * width), y: bounds.midY + CGFloat(fitted.fy * height))
        picture.transform = CGAffineTransform(scaleX: CGFloat(fitted.zoom), y: CGFloat(fitted.zoom))
    }
}
