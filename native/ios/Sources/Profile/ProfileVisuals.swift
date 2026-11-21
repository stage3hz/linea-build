import CoreImage
import UIKit

// What the top of a profile is made of (the reference's music/MusicAmbient.tsx, platina/Decor.tsx ProfileBanner,
// platina/Effects.tsx, design/peerLight.tsx ProfileLight and ProfilePosts.tsx ProfilePattern):
//   (the animated banner presets are the music screen's MusicAmbientView, Sources/Effects/MusicAmbient.swift)
//   ProfileBannerView  the banner: an uploaded photo / video or a preset, soft top and bottom edges, fading out below
//   ProfileEffectView  particles over the top of an open profile (snow, sparks, petals, bubbles, stars, embers)
//   (the person's light is ChatLook's ProfileLightView, Sources/ChatLook/PeerLight.swift)
//   ProfilePatternView the chosen emoji repeated in rings around the avatar

/// The phone-proportioned head of a profile (banner height 200 under a ~59 pt status bar).
let profileHeroRatio: CGFloat = 259 / 393

/// The profile banner (Decor.tsx `ProfileBanner`): the uploaded photo or video, or an animated preset; empty when the
/// person has none (`hasContent` false). Soft edges over a photo and a video; below, it fades out by transparency
/// (`preview` keeps it whole: the editor's tile, the studio's swatches).
final class ProfileBannerView: UIView {
    private let body = UIView()
    private let photo = UIImageView()
    private let blurred = UIImageView()
    private let blurredMask = CAGradientLayer()
    private let video = LoopVideoView()
    private let liveBlur = UIVisualEffectView(effect: UIBlurEffect(style: .regular))
    private let liveBlurMask = CAGradientLayer()
    private let ambient = MusicAmbientView(tone: "deep") // Avatars: the one ambient view of the app
    private let fadeMask = CAGradientLayer()
    private var look = PersonLook()
    private var base = ""
    private var preview = false
    private var localPicture: UIImage?
    private var localVideo: URL?
    private var askedWidth: CGFloat = 0
    private(set) var hasContent = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        body.clipsToBounds = true
        addSubview(body)
        photo.contentMode = .scaleAspectFill
        photo.clipsToBounds = true
        body.addSubview(photo)
        blurred.contentMode = .scaleAspectFill
        blurred.clipsToBounds = true
        for mask in [blurredMask, liveBlurMask] {
            // Soft top and bottom edges: the blurred copy shows only near the edges, the sharp layer in between.
            mask.colors = [UIColor.black.cgColor, UIColor.clear.cgColor, UIColor.clear.cgColor, UIColor.black.cgColor]
            mask.locations = [0, 0.3, 0.55, 1]
        }
        blurred.layer.mask = blurredMask
        body.addSubview(blurred)
        body.addSubview(video)
        liveBlur.layer.mask = liveBlurMask
        body.addSubview(liveBlur)
        body.addSubview(ambient)
        fadeMask.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
        fadeMask.locations = [0, 0.5, 1]
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: AvatarMedia.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// `local`: a photo or a video picked on this device and not uploaded yet (the «так будет выглядеть» preview).
    func show(_ look: PersonLook, base: String, preview: Bool = false, localPicture: UIImage? = nil, localVideo: URL? = nil) {
        self.look = look
        self.base = base
        self.preview = preview
        self.localPicture = localPicture
        self.localVideo = localVideo
        askedWidth = 0
        refresh()
    }

    @objc private func arrived(_ note: Notification) {
        guard let key = note.object as? String, key == look.bannerId else { return }
        refresh()
    }

    private func refresh() {
        let motion = Motion.enabled && NetQuality.shared.tier == "fast"
        body.backgroundColor = Theme.surface2
        photo.isHidden = true
        blurred.isHidden = true
        video.isHidden = true
        liveBlur.isHidden = true
        ambient.isHidden = true
        var playing: URL? = nil
        let soft = !preview
        if let localVideo {
            playing = localVideo
            video.isHidden = false
            liveBlur.isHidden = !soft
            hasContent = true
        } else if let localPicture {
            photo.image = localPicture
            photo.isHidden = false
            if soft { blurred.image = ProfileBannerView.blur(localPicture); blurred.isHidden = false }
            hasContent = true
        } else if !look.bannerId.isEmpty && look.bannerKind == "video" && motion {
            playing = AvatarMedia.shared.video(id: look.bannerId, base: base)
            video.isHidden = false
            liveBlur.isHidden = !soft
            hasContent = true
        } else if !look.bannerId.isEmpty {
            let pixels = Int(max(bounds.width, 320) * UIScreen.main.scale)
            askedWidth = bounds.width
            let picture = look.bannerKind == "video" ? nil : AvatarMedia.shared.image(id: look.bannerId, base: base, pixels: pixels, animated: Motion.feature("gif"))
            photo.image = picture
            photo.isHidden = picture == nil
            if let picture, soft { blurred.image = ProfileBannerView.blur(picture); blurred.isHidden = false }
            if picture?.images != nil { photo.startAnimating() }
            hasContent = true
        } else if !look.bannerPreset.isEmpty && AvatarCatalog.banners.contains(where: { $0.id == look.bannerPreset }) {
            ambient.show(tone: look.bannerPreset, still: !motion)
            ambient.isHidden = false
            hasContent = true
        } else {
            hasContent = false
        }
        video.play(playing)
        isHidden = !hasContent
        layer.mask = preview ? nil : fadeMask
        setNeedsLayout()
    }

    /// The reference's `blurRadius={22}` copy for the soft edges.
    private static var blurs: [Int: UIImage] = [:]
    static func blur(_ picture: UIImage) -> UIImage? {
        let key = picture.hash
        if let hit = blurs[key] { return hit }
        let still = picture.images?.first ?? picture
        guard let input = CIImage(image: still), let filter = CIFilter(name: "CIGaussianBlur") else { return nil }
        filter.setValue(input.clampedToExtent(), forKey: kCIInputImageKey)
        filter.setValue(22, forKey: kCIInputRadiusKey)
        guard let output = filter.outputImage?.cropped(to: input.extent), let made = CIContext().createCGImage(output, from: input.extent) else { return nil }
        let image = UIImage(cgImage: made)
        if blurs.count > 8 { blurs.removeAll() }
        blurs[key] = image
        return image
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        body.frame = bounds
        for part in [photo, blurred, video, liveBlur, ambient] as [UIView] { part.frame = bounds }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        blurredMask.frame = bounds
        liveBlurMask.frame = bounds
        fadeMask.frame = bounds
        CATransaction.commit()
        if !look.bannerId.isEmpty && localPicture == nil && localVideo == nil && bounds.width > askedWidth + 1 && look.bannerKind != "video" { refresh() }
    }
}

/// Particles over the top of an open profile (Effects.tsx `ProfileEffect`); off when animations are off, unless
/// `preview` (the picker's swatch, which then stands still).
final class ProfileEffectView: UIView {
    private struct Kind { let count: Int; let rise: Bool; let colors: [String]; let size: (CGFloat, CGFloat); let duration: (Double, Double); let shape: String; let twinkle: Bool }
    private static let kinds: [String: Kind] = [
        "snow": Kind(count: 22, rise: false, colors: ["#FFFFFF", "#E6F0FF"], size: (3, 7), duration: (5200, 9000), shape: "dot", twinkle: false),
        "sparks": Kind(count: 16, rise: true, colors: ["#FFF4C2", "#FFFFFF", "#FFD86B"], size: (6, 11), duration: (3200, 5200), shape: "star", twinkle: true),
        "petals": Kind(count: 14, rise: false, colors: ["#FFB8CF", "#FFD3E1", "#FF9DBB"], size: (7, 11), duration: (6000, 9500), shape: "petal", twinkle: false),
        "bubbles": Kind(count: 14, rise: true, colors: ["rgba(170,220,255,0.9)", "rgba(255,255,255,0.8)"], size: (8, 18), duration: (5000, 8500), shape: "ring", twinkle: false),
        "stars": Kind(count: 20, rise: false, colors: ["#FFFFFF", "#CFE0FF", "#FFF2C7"], size: (5, 9), duration: (1800, 3400), shape: "star", twinkle: true),
        "embers": Kind(count: 18, rise: true, colors: ["#FF8A3D", "#FFB347", "#FF5A36"], size: (3, 6), duration: (3600, 6400), shape: "dot", twinkle: false),
    ]
    private var effect = ""
    private var preview = false
    private var built = CGSize.zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        NotificationCenter.default.addObserver(self, selector: #selector(again), name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(again), name: Motion.changed, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    func show(_ effect: String, preview: Bool = false) {
        self.effect = effect
        self.preview = preview
        built = .zero
        setNeedsLayout()
    }

    @objc private func again() { built = .zero; setNeedsLayout() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { built = .zero; setNeedsLayout() }
    }

    private static func color(_ text: String) -> UIColor {
        if text.hasPrefix("rgba(") {
            let numbers = text.dropFirst(5).dropLast().split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            if numbers.count == 4 { return UIColor(red: numbers[0] / 255, green: numbers[1] / 255, blue: numbers[2] / 255, alpha: numbers[3]) }
        }
        return lookColor(text)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.size != built else { return }
        built = bounds.size
        layer.sublayers?.forEach { $0.removeFromSuperlayer() }
        let enabled = Motion.enabled
        guard let kind = ProfileEffectView.kinds[effect], enabled || preview else { return }
        let width = bounds.width, height = bounds.height
        for index in 0..<kind.count {
            let r: (Double) -> Double = { (n: Double) -> Double in decorRand(Double(index) * 7 + n) }
            let size = kind.size.0 + CGFloat(r(1)) * (kind.size.1 - kind.size.0)
            let x = CGFloat(r(2)) * (width - size), sway = CGFloat(8 + r(3) * 18)
            let duration = (kind.duration.0 + r(4) * (kind.duration.1 - kind.duration.0)) / 1000
            let color = ProfileEffectView.color(kind.colors[min(kind.colors.count - 1, Int(r(5) * Double(kind.colors.count)))])
            let phase = r(6)
            let tall = kind.shape == "petal" ? size * 0.7 : size
            let piece = CAShapeLayer()
            piece.bounds = CGRect(x: 0, y: 0, width: size, height: tall)
            piece.anchorPoint = .zero
            piece.position = .zero
            let box = CGRect(x: 0, y: 0, width: size, height: tall)
            switch kind.shape {
            case "ring":
                piece.path = UIBezierPath(roundedRect: box, cornerRadius: size).cgPath
                piece.fillColor = nil
                piece.strokeColor = color.cgColor
                piece.lineWidth = 1.2
            case "petal":
                let path = UIBezierPath()
                let big = min(size, tall) / 2, small: CGFloat = 2
                path.move(to: CGPoint(x: big, y: 0))
                path.addLine(to: CGPoint(x: size - small, y: 0))
                path.addArc(withCenter: CGPoint(x: size - small, y: small), radius: small, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
                path.addLine(to: CGPoint(x: size, y: tall - big))
                path.addArc(withCenter: CGPoint(x: size - big, y: tall - big), radius: big, startAngle: 0, endAngle: .pi / 2, clockwise: true)
                path.addLine(to: CGPoint(x: small, y: tall))
                path.addArc(withCenter: CGPoint(x: small, y: tall - small), radius: small, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
                path.addLine(to: CGPoint(x: 0, y: big))
                path.addArc(withCenter: CGPoint(x: big, y: big), radius: big, startAngle: .pi, endAngle: .pi * 1.5, clockwise: true)
                path.close()
                piece.path = path.cgPath
                piece.fillColor = color.cgColor
            case "star":
                // A small square turned 45° (the reference's «star»).
                let square = UIBezierPath(roundedRect: box, cornerRadius: 1.5)
                square.apply(CGAffineTransform(translationX: size / 2, y: tall / 2).rotated(by: .pi / 4).translatedBy(x: -size / 2, y: -tall / 2))
                piece.path = square.cgPath
                piece.fillColor = color.cgColor
            default:
                piece.path = UIBezierPath(ovalIn: box).cgPath
                piece.fillColor = color.cgColor
            }
            piece.shadowColor = color.cgColor
            piece.shadowOpacity = kind.shape == "dot" ? 0.6 : 0.9
            piece.shadowRadius = size
            piece.shadowOffset = .zero
            let place: (Double) -> CATransform3D = { (p: Double) -> CATransform3D in
                let y = kind.rise ? Double(height) - p * Double(height + size * 2) : Double(-size) + p * Double(height + size * 2)
                var made = CATransform3DMakeTranslation(x + CGFloat(sin(p * Double.pi * 2)) * sway, CGFloat(y), 0)
                if kind.shape == "petal" {
                    made = CATransform3DTranslate(made, size / 2, tall / 2, 0)
                    made = CATransform3DRotate(made, CGFloat(p * Double.pi * 2), 0, 0, 1)
                    made = CATransform3DTranslate(made, -size / 2, -tall / 2, 0)
                }
                return made
            }
            let fade: (Double) -> Double = { (p: Double) -> Double in
                kind.twinkle ? 0.25 + 0.75 * abs(sin(p * Double.pi * 3)) : min(1, p * 6, (1 - p) * 4)
            }
            if enabled {
                // Every particle is already on its way, each at its own point of the loop: full at once.
                let move = DecorDraw.loop("transform", duration: duration, samples: 40) { (p: Double) -> Any in NSValue(caTransform3D: place(p)) }
                move.timeOffset = phase * duration
                let shine = DecorDraw.loop("opacity", duration: duration, samples: 40) { (p: Double) -> Any in NSNumber(value: fade(p)) }
                shine.timeOffset = phase * duration
                piece.transform = place(phase)
                piece.opacity = Float(fade(phase))
                piece.add(move, forKey: "move")
                piece.add(shine, forKey: "fade")
            } else {
                piece.transform = place(phase)
                piece.opacity = Float(fade(phase))
            }
            layer.addSublayer(piece)
        }
    }
}

/// The profile background pattern (ProfilePosts.tsx `ProfilePattern`): the chosen emoji repeated in three rings
/// around the avatar, smaller and fainter further out, clear of the name under the photo. `center`: the avatar's
/// centre in this view.
final class ProfilePatternView: UIView {
    private var emoji = ""
    var avatarCenter = CGPoint.zero {
        didSet { setNeedsLayout() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ emoji: String) {
        self.emoji = emoji
        isHidden = emoji.isEmpty
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        subviews.forEach { $0.removeFromSuperview() }
        guard !emoji.isEmpty, bounds.width > 0 else { return }
        let rings: [(r: CGFloat, n: Int, size: CGFloat, o: CGFloat)] = [(84, 6, 20, 0.3), (124, 9, 17, 0.18), (166, 12, 14, 0.1)]
        let cx = avatarCenter.x, cy = avatarCenter.y
        for (k, ring) in rings.enumerated() {
            for i in 0..<ring.n {
                let a = CGFloat(i) / CGFloat(ring.n) * .pi * 2 + CGFloat(k) * 0.4
                let x = cx + cos(a) * ring.r * 1.3, y = cy + sin(a) * ring.r * 0.72
                if y > cy + 50 && abs(x - cx) < 110 { continue }
                if y < -ring.size || y > bounds.height + ring.size || x < -ring.size || x > bounds.width + ring.size { continue }
                let label = UILabel()
                label.text = emoji
                label.font = .systemFont(ofSize: ring.size)
                label.alpha = ring.o
                label.textAlignment = .center
                label.frame = CGRect(x: x - ring.size, y: y - ring.size * 0.6, width: ring.size * 2, height: ring.size * 1.2)
                addSubview(label)
            }
        }
    }
}
