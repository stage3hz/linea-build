import UIKit

// Nameplates (the reference's platina/Nameplates.tsx): a picture that fills the whole row behind a person's name in
// the chat list and in member lists, fading into the row on the left so the name and the preview stay readable.
// All the artwork is drawn here, shape for shape as the reference's SVG (a 400 × 84 box), with its deterministic
// generator — the same plate looks the same on every phone.

enum Nameplates {
    static let width: CGFloat = 400
    static let height: CGFloat = 84
    private static var baked: [String: UIImage] = [:]

    /// The reference's small generator (an LCG seeded by the plate's id).
    private struct Generator {
        var state: UInt64
        init(_ id: String) {
            var seed: UInt64 = 7
            for unit in id.utf16 { seed = seed &* 31 &+ UInt64(unit) }
            state = seed & 0xFFFF_FFFF
        }
        mutating func next() -> CGFloat {
            state = (state &* 1_664_525 &+ 1_013_904_223) & 0xFFFF_FFFF
            return CGFloat(Double(state) / 4_294_967_296)
        }
    }

    /// The plate's art (background gradient and drawing, no readability fade), `width` × `height` points.
    static func image(_ id: String) -> UIImage? {
        if let hit = baked[id] { return hit }
        guard let plate = AvatarCatalog.plate(id) else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        format.opaque = true
        let made = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { (renderer: UIGraphicsImageRendererContext) -> Void in
            let context = renderer.cgContext
            let colors = [lookColor(plate.colors.0).cgColor, lookColor(plate.colors.1).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: width, y: 0), options: [])
            }
            draw(id, context)
        }
        baked[id] = made
        return made
    }

    private static func fill(_ context: CGContext, _ path: CGPath, _ color: String, _ alpha: CGFloat) {
        context.addPath(path)
        context.setFillColor(lookColor(color, alpha: alpha).cgColor)
        context.fillPath()
    }

    private static func stroke(_ context: CGContext, _ path: CGPath, _ color: String, _ alpha: CGFloat, _ width: CGFloat, dash: [CGFloat] = [], round: Bool = false) {
        context.saveGState()
        context.addPath(path)
        context.setStrokeColor(lookColor(color, alpha: alpha).cgColor)
        context.setLineWidth(width)
        if !dash.isEmpty { context.setLineDash(phase: 0, lengths: dash) }
        if round { context.setLineCap(.round) }
        context.strokePath()
        context.restoreGState()
    }

    private static func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat) -> CGPath {
        return CGPath(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2), transform: nil)
    }

    /// A path turned by `degrees` about (x, y), as SVG's `rotate(a x y)`.
    private static func turned(_ path: CGPath, _ degrees: CGFloat, _ x: CGFloat, _ y: CGFloat) -> CGPath {
        var move = CGAffineTransform(translationX: x, y: y).rotated(by: degrees * .pi / 180).translatedBy(x: -x, y: -y)
        return path.copy(using: &move) ?? path
    }

    private static func draw(_ id: String, _ context: CGContext) {
        var g = Generator(id)
        let W = width, H = height
        switch id {
        case "crows":
            for _ in 0..<14 {
                let x = 120 + g.next() * 270, y = 8 + g.next() * 66, s = 4 + g.next() * 9
                let path = CGMutablePath()
                path.move(to: CGPoint(x: x - s, y: y - s * 0.25))
                path.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: x - s * 0.45, y: y - s * 0.55))
                path.addQuadCurve(to: CGPoint(x: x + s, y: y - s * 0.25), control: CGPoint(x: x + s * 0.45, y: y - s * 0.55))
                path.addQuadCurve(to: CGPoint(x: x, y: y + s * 0.22), control: CGPoint(x: x + s * 0.45, y: y - s * 0.2))
                path.addQuadCurve(to: CGPoint(x: x - s, y: y - s * 0.25), control: CGPoint(x: x - s * 0.45, y: y - s * 0.2))
                path.closeSubpath()
                fill(context, path, "#0B0C10", 0.55 + g.next() * 0.4)
            }
        case "leopard":
            for _ in 0..<34 {
                let x = 90 + g.next() * 320, y = g.next() * H, s = 4 + g.next() * 6
                stroke(context, ellipse(x, y, s * 1.25, s), "#1E1E22", 0.8, s * 0.55, dash: [s * 1.4, s * 0.6])
                fill(context, ellipse(x, y, s * 0.55, s * 0.42), "#6E6A60", 0.55)
            }
        case "sparkle":
            for _ in 0..<16 {
                let x = 110 + g.next() * 285, y = 6 + g.next() * 72, s = 2 + g.next() * 7
                let path = CGMutablePath()
                path.move(to: CGPoint(x: x, y: y - s * 2))
                path.addQuadCurve(to: CGPoint(x: x + s * 2, y: y), control: CGPoint(x: x + s * 0.25, y: y - s * 0.25))
                path.addQuadCurve(to: CGPoint(x: x, y: y + s * 2), control: CGPoint(x: x + s * 0.25, y: y + s * 0.25))
                path.addQuadCurve(to: CGPoint(x: x - s * 2, y: y), control: CGPoint(x: x - s * 0.25, y: y + s * 0.25))
                path.addQuadCurve(to: CGPoint(x: x, y: y - s * 2), control: CGPoint(x: x - s * 0.25, y: y - s * 0.25))
                path.closeSubpath()
                fill(context, path, "#FFFFFF", 0.5 + g.next() * 0.5)
            }
        case "deep":
            for index in 0..<4 {
                let i = CGFloat(index) * 14
                let path = CGMutablePath()
                path.move(to: CGPoint(x: 0, y: 30 + i))
                path.addCurve(to: CGPoint(x: 300, y: 28 + i), control1: CGPoint(x: 100, y: 18 + i), control2: CGPoint(x: 200, y: 44 + i))
                // S: the first control is the previous one mirrored about the point.
                path.addCurve(to: CGPoint(x: 420, y: 30 + i), control1: CGPoint(x: 400, y: 12 + i), control2: CGPoint(x: 400, y: 36 + i))
                path.addLine(to: CGPoint(x: 420, y: 90))
                path.addLine(to: CGPoint(x: 0, y: 90))
                path.closeSubpath()
                fill(context, path, "#4F8CFF", 0.12 + CGFloat(index) * 0.05)
            }
            for _ in 0..<10 {
                let cx = 200 + g.next() * 200, cy = g.next() * H, r = 1.5 + g.next() * 3.5
                stroke(context, ellipse(cx, cy, r, r), "#BFD8FF", 0.6, 1)
            }
        case "aurora":
            let bands: [(String, CGFloat)] = [("#2EE6C8", 0), ("#7B5CFF", 16), ("#36A8FF", 30)]
            for (index, band) in bands.enumerated() {
                let o = band.1
                let path = CGMutablePath()
                path.move(to: CGPoint(x: 120, y: 70 - o))
                path.addCurve(to: CGPoint(x: 330, y: 20), control1: CGPoint(x: 200, y: 10 - o / 2), control2: CGPoint(x: 260, y: 80 - o))
                path.addCurve(to: CGPoint(x: 420, y: 10), control1: CGPoint(x: 400, y: 40 - 80 + o), control2: CGPoint(x: 400, y: 40 - o / 2))
                stroke(context, path, band.0, 0.38, 18 - CGFloat(index) * 4, round: true)
            }
            for _ in 0..<12 {
                let cx = g.next() * W, cy = g.next() * 40, r = 0.8 + g.next()
                fill(context, ellipse(cx, cy, r, r), "#FFFFFF", 0.7)
            }
        case "ember":
            for index in 0..<9 {
                let x = 150 + CGFloat(index) * 30 + g.next() * 10, h = 30 + g.next() * 40
                let path = CGMutablePath()
                path.move(to: CGPoint(x: x - 16, y: H))
                path.addCurve(to: CGPoint(x: x, y: H - h), control1: CGPoint(x: x - 18, y: H - h * 0.5), control2: CGPoint(x: x - 2, y: H - h * 0.6))
                path.addCurve(to: CGPoint(x: x + 16, y: H), control1: CGPoint(x: x + 4, y: H - h * 0.55), control2: CGPoint(x: x + 18, y: H - h * 0.45))
                path.closeSubpath()
                fill(context, path, index % 2 == 1 ? "#FF7A2E" : "#FF3D1F", 0.55)
            }
            for _ in 0..<14 {
                let cx = 160 + g.next() * 240, cy = g.next() * 50, r = 1 + g.next() * 1.8
                fill(context, ellipse(cx, cy, r, r), "#FFC36B", 0.85)
            }
        case "night":
            for _ in 0..<26 {
                let cx = g.next() * W, cy = g.next() * H, r = 0.6 + g.next() * 1.5
                fill(context, ellipse(cx, cy, r, r), "#FFFFFF", 0.4 + g.next() * 0.6)
            }
            fill(context, ellipse(352, 38, 22, 22), "#F3E9C6", 0.9)
            fill(context, ellipse(364, 31, 20, 20), "#2A1C66", 1)
        case "sakura":
            for index in 0..<18 {
                let x = 120 + g.next() * 280, y = g.next() * H, s = 3 + g.next() * 4, a = g.next() * 180
                fill(context, turned(ellipse(x, y, s * 1.6, s), a, x, y), index % 3 != 0 ? "#FFB3CC" : "#FFD6E4", 0.75)
            }
        case "mint":
            for _ in 0..<12 {
                let x = 140 + g.next() * 260, y = g.next() * H, s = 6 + g.next() * 8, a = g.next() * 180
                let path = CGMutablePath()
                path.move(to: CGPoint(x: x - s, y: y))
                path.addQuadCurve(to: CGPoint(x: x + s, y: y), control: CGPoint(x: x, y: y - s * 0.8))
                path.addQuadCurve(to: CGPoint(x: x - s, y: y), control: CGPoint(x: x, y: y + s * 0.8))
                path.closeSubpath()
                fill(context, turned(path, a, x, y), "#5BE3A6", 0.4)
            }
        case "platinum":
            for index in 0..<7 {
                let x = 150 + CGFloat(index) * 40
                let rect = CGPath(rect: CGRect(x: x, y: -40, width: 6 + CGFloat(index % 3) * 5, height: 170), transform: nil)
                fill(context, turned(rect, 25, x, 40), "#FFFFFF", 0.08 + CGFloat(index % 2) * 0.08)
            }
        default:
            break
        }
    }

    /// The plate as a PNG in base64 (what ChatDecorStore.setPlates takes).
    static func base64(_ id: String) -> String? {
        return image(id)?.pngData()?.base64EncodedString()
    }
}

/// The plate behind a row (Nameplates.tsx `Nameplate`): fills its bounds, the art right-aligned and cropped to fill,
/// a hairline border, and — unless `compact` — the readability fade from the left.
final class NameplateView: UIView {
    private let art = UIImageView()
    private let fade = CAGradientLayer()
    private var plateId = ""
    var compact = false {
        didSet { fade.isHidden = compact }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        layer.borderWidth = 1 / UIScreen.main.scale
        layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
        addSubview(art)
        fade.colors = [UIColor(white: 0, alpha: 0.62).cgColor, UIColor(white: 0, alpha: 0.32).cgColor, UIColor(white: 0, alpha: 0.05).cgColor]
        fade.locations = [0, 0.5, 1]
        fade.startPoint = CGPoint(x: 0, y: 0.5)
        fade.endPoint = CGPoint(x: 1, y: 0.5)
        layer.addSublayer(fade)
    }

    required init?(coder: NSCoder) { return nil }

    /// Empty or unknown: nothing is shown (the view hides itself).
    func show(_ plate: String, radius: CGFloat = 0) {
        plateId = plate
        art.image = Nameplates.image(plate)
        isHidden = art.image == nil
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        fade.frame = bounds
        guard bounds.width > 0, bounds.height > 0 else { return }
        let scale = max(bounds.width / Nameplates.width, bounds.height / Nameplates.height)
        let size = CGSize(width: Nameplates.width * scale, height: Nameplates.height * scale)
        art.frame = CGRect(x: bounds.width - size.width, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
    }
}
