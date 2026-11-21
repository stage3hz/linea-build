import CoreImage
import UIKit

// What the top of a profile is made of (the reference's music/MusicAmbient.tsx, platina/Decor.tsx ProfileBanner,
// platina/Effects.tsx, design/peerLight.tsx ProfileLight and ProfilePosts.tsx ProfilePattern):
//   AmbientView        soft light patches drifting while their colour flows (the animated banner presets)
//   ProfileBannerView  the banner: an uploaded photo / video or a preset, soft top and bottom edges, fading out below
//   ProfileEffectView  particles over the top of an open profile (snow, sparks, petals, bubbles, stars, embers)
//   ProfileLightView   the person's colour as light falling from above when there is no banner
//   ProfilePatternView the chosen emoji repeated in rings around the avatar

/// A colour lifted until its brightest channel reaches `floor` (peerLight.tsx `brightTint`): the hue is kept.
func brightTint(_ rgb: UInt32, floor: CGFloat = 190) -> UIColor {
    var channels = [CGFloat((rgb >> 16) & 255), CGFloat((rgb >> 8) & 255), CGFloat(rgb & 255)]
    let top = channels.max() ?? 0
    if top < floor {
        let lift = (floor - top) / max(1, 255 - top)
        channels = channels.map { ($0 + (255 - $0) * lift).rounded() }
    }
    return UIColor(red: channels[0] / 255, green: channels[1] / 255, blue: channels[2] / 255, alpha: 1)
}

/// The music screen's moving light, here the banner presets (MusicAmbient.tsx): four patches, each five glows of
/// the palette crossfading in turn (6 s a colour), drifting slowly. `still` holds them.
final class AmbientView: UIView {
    struct Palette { let base: String; let colors: [String]; let accent: Int; let green: Int }
    static let palettes: [String: Palette] = [
        "dark": Palette(base: "#0A1529", colors: ["#0D3480", "#0B6450", "#123E92", "#0A2F6E", "#B8D8F5"], accent: 4, green: 1),
        "black": Palette(base: "#000000", colors: ["#0A2766", "#08483A", "#0E2F72", "#071F4F", "#8FB3D9"], accent: 4, green: 1),
        "light": Palette(base: "#E7EFFC", colors: ["#9DBDF2", "#A9E0CF", "#B5CDF5", "#8FB0EA", "#FFFFFF"], accent: 4, green: 1),
        "deep": Palette(base: "#050B1C", colors: ["#0D3480", "#0A2F6E", "#143F9E", "#08245A", "#8FB3D9"], accent: 4, green: 1),
        "glacier": Palette(base: "#0B1B2E", colors: ["#4C8FD6", "#7FC8E8", "#2F6DB5", "#9FD6F2", "#FFFFFF"], accent: 4, green: 1),
        "aurora": Palette(base: "#04131C", colors: ["#0B6450", "#1AA889", "#0D3480", "#2EE6C8", "#CFF7EE"], accent: 4, green: 1),
        "ocean": Palette(base: "#031424", colors: ["#0A4E8A", "#0C7A9E", "#063A6B", "#1593B8", "#B8E4F5"], accent: 4, green: 1),
        "mint": Palette(base: "#061A16", colors: ["#118A6A", "#4FD1A5", "#0B5C4A", "#7BE8C3", "#E6FFF6"], accent: 4, green: 1),
        "night": Palette(base: "#000000", colors: ["#0A1A40", "#101F4D", "#06122E", "#1A2C66", "#5D7BB8"], accent: 4, green: 1),
    ]
    private let count = 5
    private let step: Double = 6
    private var tone = "deep"
    private var still = false
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

    func show(tone: String, still: Bool) {
        self.tone = AmbientView.palettes[tone] == nil ? "deep" : tone
        self.still = still
        built = .zero
        setNeedsLayout()
    }

    @objc private func again() { built = .zero; setNeedsLayout() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { built = .zero; setNeedsLayout() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.size != built, let palette = AmbientView.palettes[tone] else { return }
        built = bounds.size
        layer.sublayers?.forEach { $0.removeFromSuperlayer() }
        backgroundColor = lookColor(palette.base)
        let paused = still || !Motion.enabled
        let strength: Double = tone == "light" ? 0.75 : 1
        let w = Double(bounds.width), h = Double(bounds.height)
        patch(palette, x: w * 0.25, y: h * 0.35, size: w * 1.3, offset: 0, drift: 50, strength: 0.55 * strength, paused: paused)
        patch(palette, x: w * 0.85, y: h * 0.55, size: w * 1.2, offset: 1.7, drift: 45, strength: 0.45 * strength, paused: paused)
        patch(palette, x: w * 0.5, y: h * 0.85, size: w * 1.3, offset: 3.1, drift: 40, strength: 0.5 * strength, paused: paused)
        patch(palette, x: w * 0.55, y: h * 0.3, size: w * 0.8, offset: 4.2, drift: 55, strength: 0.3 * strength, paused: paused)
    }

    /// How strongly glow `index` shows at `phase`: a smooth bump around its slot of the cycle.
    private func weight(_ phase: Double, _ index: Int) -> Double {
        let n = Double(count)
        var d = abs(((phase - Double(index)).truncatingRemainder(dividingBy: n) + n).truncatingRemainder(dividingBy: n))
        d = min(d, n - d)
        let k = max(0, 1 - d)
        return k * k * (3 - 2 * k)
    }

    private func patch(_ palette: Palette, x: Double, y: Double, size: Double, offset: Double, drift: Double, strength: Double, paused: Bool) {
        let holder = CALayer()
        holder.frame = CGRect(x: x - size / 2, y: y - size / 2, width: size, height: size)
        for (index, hex) in palette.colors.enumerated() {
            let glow = CAGradientLayer()
            glow.type = .radial
            glow.frame = holder.bounds
            glow.startPoint = CGPoint(x: 0.5, y: 0.5)
            glow.endPoint = CGPoint(x: 1, y: 1)
            let opacity = index == palette.accent ? strength * (tone == "light" ? 0.8 : 0.35) : index == palette.green ? strength * 0.7 : strength
            let color = lookColor(hex)
            glow.colors = [color.withAlphaComponent(CGFloat(opacity)).cgColor, color.withAlphaComponent(0).cgColor]
            glow.opacity = Float(weight(offset, index))
            if !paused {
                let samples = 60
                let fade = CAKeyframeAnimation(keyPath: "opacity")
                fade.values = (0...samples).map { (n: Int) -> NSNumber in NSNumber(value: weight(offset + Double(count) * Double(n) / Double(samples), index)) }
                fade.duration = step * Double(count)
                fade.repeatCount = .infinity
                fade.isRemovedOnCompletion = false
                glow.add(fade, forKey: "flow")
            }
            holder.addSublayer(glow)
        }
        if !paused {
            let ease = CAMediaTimingFunction(name: .easeInEaseOut)
            let across = CABasicAnimation(keyPath: "transform.translation.x")
            across.fromValue = -drift
            across.toValue = drift
            across.duration = (9000 + offset * 900) / 1000
            across.autoreverses = true
            across.repeatCount = .infinity
            across.timingFunction = ease
            across.timeOffset = across.duration / 2
            across.isRemovedOnCompletion = false
            holder.add(across, forKey: "x")
            let down = CABasicAnimation(keyPath: "transform.translation.y")
            down.fromValue = drift * 0.7
            down.toValue = -drift * 0.7
            down.duration = (11000 + offset * 700) / 1000
            down.autoreverses = true
            down.repeatCount = .infinity
            down.timingFunction = ease
            down.timeOffset = down.duration / 2
            down.isRemovedOnCompletion = false
            holder.add(down, forKey: "y")
        }
        layer.addSublayer(holder)
    }
}

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
    private let ambient = AmbientView()
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

/// The light of a person at the top of their profile when they have no banner (peerLight.tsx `ProfileLight`): it falls
/// from above, behind the avatar, and fades into the page.
final class ProfileLightView: UIView {
    private let glow = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        glow.type = .radial
        glow.startPoint = CGPoint(x: 0.5, y: 0.06)
        glow.endPoint = CGPoint(x: 0.5 + 0.92, y: 0.06 + 0.88)
        glow.locations = [0, 0.5, 1]
        layer.addSublayer(glow)
    }

    required init?(coder: NSCoder) { return nil }

    func show(color rgb: UInt32) {
        let light = brightTint(rgb, floor: 150)
        let dark = Theme.dark
        glow.colors = [light.withAlphaComponent(dark ? 0.5 : 0.22).cgColor, light.withAlphaComponent(dark ? 0.16 : 0.08).cgColor, light.withAlphaComponent(0).cgColor]
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        glow.frame = bounds
        CATransaction.commit()
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
