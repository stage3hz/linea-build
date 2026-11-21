import UIKit

/// One soft elliptic light: a radial gradient in the units of the view's own box (the reference's SVG
/// `RadialGradient gradientUnits="objectBoundingBox"`): the centre and the two radii are shares of the width and
/// the height.
struct LookGlow {
    let cx: CGFloat
    let cy: CGFloat
    let rx: CGFloat
    let ry: CGFloat
    /// (offset, colour with its opacity)
    let stops: [(CGFloat, UIColor)]

    func draw(in context: CGContext, box: CGRect) {
        guard box.width > 0, box.height > 0, stops.count >= 2 else { return }
        let colors = stops.map { $0.1.cgColor } as CFArray
        let locations = stops.map { $0.0 }
        guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: locations) else { return }
        context.saveGState()
        context.clip(to: box)
        context.translateBy(x: box.minX + cx * box.width, y: box.minY + cy * box.height)
        context.scaleBy(x: max(0.001, rx * box.width), y: max(0.001, ry * box.height))
        context.drawRadialGradient(gradient, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: 1, options: [])
        context.restoreGState()
    }
}

/// The light of the person you are talking to (the reference's design/peerLight.tsx `PeerLight`): a soft glow
/// in their own colour on their side of the screen (the left, where their words are), and a faint white one on
/// yours. One still picture: nothing is redrawn while the list scrolls, and it lets the page behind it show.
final class PeerLightView: UIView {
    /// The person's colour (0xRRGGBB): their photo's colour, else the one they chose.
    var peerColor: UInt32 = 0x5E7BFF {
        didSet { if peerColor != oldValue { setNeedsDisplay() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { return nil }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let dark = Theme.dark
        let glow = LookColor.color(LookColor.bright(peerColor, floor: 150))
        // On a light page the glow is a tint, on a dark one it is light.
        let near: CGFloat = dark ? 0.46 : 0.18, far: CGFloat = dark ? 0.14 : 0.06
        LookGlow(cx: -0.12, cy: 0.32, rx: 0.78, ry: 0.46, stops: [
            (0, glow.withAlphaComponent(near)), (0.55, glow.withAlphaComponent(far)), (1, glow.withAlphaComponent(0)),
        ]).draw(in: context, box: bounds)
        let own = dark ? UIColor.white : Theme.accent
        LookGlow(cx: 1.12, cy: 0.80, rx: 0.62, ry: 0.34, stops: [
            (0, own.withAlphaComponent(dark ? 0.09 : 0.07)), (1, own.withAlphaComponent(0)),
        ]).draw(in: context, box: bounds)
    }
}

/// The same light at the top of a person's profile when they have no banner (`ProfileLight`): it falls from
/// above, behind the avatar, and fades into the page. Its height is 440 points in the reference.
final class ProfileLightView: UIView {
    static let height: CGFloat = 440

    var color: UInt32 = 0x5E7BFF {
        didSet { if color != oldValue { setNeedsDisplay() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { return nil }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let dark = Theme.dark
        let glow = LookColor.color(LookColor.bright(color, floor: 150))
        LookGlow(cx: 0.5, cy: 0.06, rx: 0.92, ry: 0.88, stops: [
            (0, glow.withAlphaComponent(dark ? 0.5 : 0.22)), (0.5, glow.withAlphaComponent(dark ? 0.16 : 0.08)), (1, glow.withAlphaComponent(0)),
        ]).draw(in: context, box: bounds)
    }

    /// Puts the light at the top of `host` (behind everything else in it), as wide as the host.
    static func install(in host: UIView, color: UInt32) -> ProfileLightView {
        let light = ProfileLightView(frame: CGRect(x: 0, y: 0, width: host.bounds.width, height: height))
        light.color = color
        light.autoresizingMask = [.flexibleWidth]
        host.insertSubview(light, at: 0)
        return light
    }
}
