import UIKit

// ChatLook: small shared pieces of the chat's look — the reference's haptics.ts, the colour helpers of
// design/peerLight.tsx and design/avatarTint.ts, the glass pill of glass.tsx and the springy press of
// components.tsx (Bouncy).

/// Light vibration feedback, the reference's haptics.ts word for word: never fails, does nothing where there is no
/// engine for it.
enum Haptic {
    /// `tapFeedback`: a selection tick.
    static func tap() { UISelectionFeedbackGenerator().selectionChanged() }
    /// `impactFeedback`: a medium knock (a hold that opened something, a recording that starts).
    static func impact() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    /// `lightFeedback`: a light knock (a swipe that armed, a small action done).
    static func light() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    /// `errorFeedback`: the error pattern.
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}

/// Colours as the reference works them out (design/peerLight.tsx, design/avatarTint.ts).
enum LookColor {
    /// 0xRRGGBB → its three channels.
    static func channels(_ rgb: UInt32) -> (r: Int, g: Int, b: Int) {
        return (Int((rgb >> 16) & 255), Int((rgb >> 8) & 255), Int(rgb & 255))
    }

    static func color(_ rgb: UInt32, alpha: CGFloat = 1) -> UIColor { UIColor(hex: rgb & 0xFFFFFF, alpha: alpha) }

    /// `brightTint`: lifts a dark colour until its brightest channel reaches `floor`, keeping the hue.
    static func bright(_ rgb: UInt32, floor: Int = 190) -> UInt32 {
        let c = channels(rgb)
        let top = max(c.r, c.g, c.b)
        if top >= floor { return rgb & 0xFFFFFF }
        let spread = Double(255 - top)
        let lift = Double(floor - top) / (spread == 0 ? 1 : spread)
        func up(_ value: Int) -> UInt32 {
            return UInt32(max(0, min(255, Int((Double(value) + Double(255 - value) * lift).rounded()))))
        }
        return up(c.r) << 16 | up(c.g) << 8 | up(c.b)
    }

    /// `vividTint`: a picture's average colour made into a light; nil for a picture without a colour of its own.
    static func vivid(r: Int, g: Int, b: Int) -> UInt32? {
        let R = Double(r) / 255, G = Double(g) / 255, B = Double(b) / 255
        let top = max(R, G, B), low = min(R, G, B), l = (top + low) / 2, d = top - low
        if d < 0.06 { return nil }
        let denominator = 1 - abs(2 * l - 1)
        let sat = d / (denominator == 0 ? 1 : denominator)
        var hue: Double
        if top == R {
            hue = ((G - B) / d + 6).truncatingRemainder(dividingBy: 6) * 60
        } else if top == G {
            hue = ((B - R) / d + 2) * 60
        } else {
            hue = ((R - G) / d + 4) * 60
        }
        let s = min(0.85, max(0.5, sat * 1.5)), light = min(0.62, max(0.46, l))
        let a = s * min(light, 1 - light)
        func part(_ n: Double) -> UInt32 {
            let k = (n + hue / 30).truncatingRemainder(dividingBy: 12)
            let value = 255 * (light - a * max(-1, min(k - 3, 9 - k, 1)))
            return UInt32(max(0, min(255, Int(value.rounded()))))
        }
        return part(0) << 16 | part(8) << 8 | part(4)
    }

    private static var known: [String: UInt32] = [:]
    private static var grey = Set<String>()

    /// `tintOf`: the colour of a person's light — the average colour of their photo when it has one and it is on
    /// this phone already, else the colour they chose. Main thread.
    static func tint(avatarId: String, address: String, chosen: UInt32) -> UInt32 {
        guard !avatarId.isEmpty else { return chosen }
        if let hit = known[avatarId] { return hit }
        if grey.contains(avatarId) { return chosen }
        guard !address.isEmpty, let image = ChatAvatarStore.shared.image(key: avatarId, url: address), let average = average(image) else { return chosen }
        if let color = vivid(r: average.r, g: average.g, b: average.b) {
            known[avatarId] = color
            return color
        }
        grey.insert(avatarId)
        return chosen
    }

    /// The average colour of a picture (drawn into 8 × 8 points, as the reference does on the web).
    static func average(_ image: UIImage) -> (r: Int, g: Int, b: Int)? {
        guard let source = image.cgImage else { return nil }
        let side = 8
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let space = CGColorSpaceCreateDeviceRGB()
        let drawn: Bool = pixels.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.interpolationQuality = .medium
            context.draw(source, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        guard drawn else { return nil }
        var r = 0, g = 0, b = 0
        var index = 0
        while index < pixels.count {
            r += Int(pixels[index]); g += Int(pixels[index + 1]); b += Int(pixels[index + 2])
            index += 4
        }
        let count = side * side
        return (r / count, g / count, b / count)
    }

    /// `#RRGGBB` → 0xRRGGBB.
    static func hex(_ text: String?) -> UInt32? {
        guard let text, text.count == 7, text.hasPrefix("#"), let value = UInt32(text.dropFirst(), radix: 16) else { return nil }
        return value
    }
}

/// A pill of glass (the reference's GlassSurface, material «regular»): the live glass on iOS 26, a thin material
/// before. Content goes into `contentView`.
final class GlassPill: UIVisualEffectView {
    private let interactive: Bool

    init(interactive: Bool = true) {
        self.interactive = interactive
        super.init(effect: nil)
        clipsToBounds = true
        layer.cornerCurve = .continuous
        effect = TabGlass.effect(clear: false, interactive: interactive, dark: Theme.dark)
    }

    required init?(coder: NSCoder) { return nil }

    /// The corner radius; the pill is drawn again in the look of the theme that is on.
    func shape(radius: CGFloat) {
        if layer.cornerRadius != radius { layer.cornerRadius = radius }
    }
}

/// The springy press of the reference's `Bouncy`: down to `scale` with one spring, back with a softer one.
final class Bouncy: NSObject {
    private weak var view: UIView?
    private let scale: CGFloat
    private var animator: UIViewPropertyAnimator?

    /// Keeps itself alive as long as the control does.
    @discardableResult
    static func attach(_ control: UIControl, scale: CGFloat = 0.9, view: UIView? = nil) -> Bouncy {
        let bouncy = Bouncy(view: view ?? control, scale: scale)
        control.addTarget(bouncy, action: #selector(down), for: [.touchDown, .touchDragEnter])
        control.addTarget(bouncy, action: #selector(up), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        objc_setAssociatedObject(control, &Bouncy.key, bouncy, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return bouncy
    }

    private static var key: UInt8 = 0

    private init(view: UIView, scale: CGFloat) {
        self.view = view
        self.scale = scale
        super.init()
    }

    @objc private func down() {
        // withSpring(scaleTo, {damping: 15, stiffness: 420, mass: .6})
        run(to: scale, damping: 15, stiffness: 420)
    }

    @objc private func up() {
        // withSpring(1, {damping: 11, stiffness: 300, mass: .6})
        run(to: 1, damping: 11, stiffness: 300)
    }

    private func run(to value: CGFloat, damping: CGFloat, stiffness: CGFloat) {
        guard let view else { return }
        animator?.stopAnimation(true)
        let spring = UISpringTimingParameters(mass: 0.6, stiffness: stiffness, damping: damping, initialVelocity: .zero)
        let next = UIViewPropertyAnimator(duration: 0, timingParameters: spring)
        next.addAnimations { view.transform = value == 1 ? .identity : CGAffineTransform(scaleX: value, y: value) }
        next.startAnimation()
        animator = next
    }
}
