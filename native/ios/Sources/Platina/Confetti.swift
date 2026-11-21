import UIKit

/// Confetti for the moments that deserve it (the reference's kit/ui/confetti.tsx, from expokit by Karan, MIT): every
/// piece flies on a real arc — launch, gravity, drag — and flutters as it falls. `origin` "bottom" fires two cannons
/// from the corners, "top" rains down, "center" pops outward. With «Уменьшение движения» a quarter of the pieces.
/// The view never takes touches; it removes its pieces when they have landed.
final class ConfettiView: UIView {
    static let palette = ["#ff3d77", "#ffb000", "#3ddcff", "#7cff6b", "#a855ff", "#ffffff", "#ff7a1a"]
    private static let samples: [Double] = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1]
    var onDone: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) { return nil }

    private static func color(_ text: String) -> UIColor {
        let hex = text.hasPrefix("#") && text.count == 7 ? text.uppercased() : "#FFFFFF"
        return lookColor(hex)
    }

    /// Fires one burst (bursts may overlap). Call once the view has its size.
    func burst(origin: String = "bottom", count: Int = 80, colors: [String] = ConfettiView.palette, duration: Double = 2.6, at point: CGPoint? = nil) {
        let w = Double(bounds.width), h = Double(bounds.height)
        guard w > 0, h > 0 else { return }
        let n = min(160, max(1, Int((Double(count) * (UIAccessibility.isReduceMotionEnabled ? 0.25 : 1)).rounded())))
        let D = duration
        let g = h * 1.25
        let burst = CALayer()
        burst.frame = bounds
        layer.addSublayer(burst)
        for i in 0..<n {
            var x0 = 0.0, y0 = 0.0, vx = 0.0, vy = 0.0
            if origin == "top" {
                x0 = Double.random(in: 0..<1) * w
                y0 = -20 - Double.random(in: 0..<1) * h * 0.25
                vx = (Double.random(in: 0..<1) - 0.5) * w * 0.25
                vy = Double.random(in: 0..<1) * h * 0.1
            } else if origin == "center" {
                x0 = Double(point?.x ?? CGFloat(w / 2))
                y0 = Double(point?.y ?? CGFloat(h / 2))
                let a = -Double.pi / 2 + (Double.random(in: 0..<1) - 0.5) * Double.pi * 1.6
                let v = (0.45 + Double.random(in: 0..<1) * 0.75) * max(w, h) * 0.9
                vx = cos(a) * v
                vy = sin(a) * v
            } else {
                let leftSide = i % 2 == 0
                x0 = leftSide ? -6 : w + 6
                y0 = h + 6
                let a = -Double.pi / 2 + (leftSide ? 1 : -1) * (0.25 + Double.random(in: 0..<1) * 0.45)
                let v = (0.75 + Double.random(in: 0..<1) * 0.55) * h * 1.15
                vx = cos(a) * v
                vy = sin(a) * v
            }
            // Air drag eases the launch; sideways sway makes paper fall like paper.
            let drag = 1.6 + Double.random(in: 0..<1)
            let sway = (Double.random(in: 0..<1) - 0.5) * 40
            var points: [NSValue] = []
            for p in ConfettiView.samples {
                let t = p * D
                let k = (1 - exp(-drag * t)) / drag
                points.append(NSValue(cgPoint: CGPoint(x: x0 + vx * k + sway * sin(t * 6 + Double(i)), y: y0 + vy * k + 0.5 * g * t * t * 0.55)))
            }
            let round = Double.random(in: 0..<1) < 0.3
            let strip = !round && Double.random(in: 0..<1) < 0.35
            let s0 = (Double.random(in: 0..<1) * 360).rounded() * Double.pi / 180
            let turns = (Double.random(in: 0..<1) < 0.5 ? -1.0 : 1.0) * (1 + Double.random(in: 0..<1) * 2.5)
            let flips = 2 + Double.random(in: 0..<1) * 4
            let width: CGFloat = round ? 7 : strip ? 4 : 7, height: CGFloat = round ? 7 : strip ? 16 : 11
            let fill = colors.isEmpty ? UIColor.white : ConfettiView.color(colors[Int.random(in: 0..<colors.count)])

            let mover = CALayer()
            mover.bounds = CGRect(x: 0, y: 0, width: width, height: height)
            mover.position = points.first?.cgPointValue ?? .zero
            let spinner = CALayer()
            spinner.frame = mover.bounds
            let piece = CALayer()
            piece.frame = mover.bounds
            piece.backgroundColor = fill.cgColor
            piece.cornerRadius = round ? width / 2 : 1.5
            spinner.addSublayer(piece)
            mover.addSublayer(spinner)
            burst.addSublayer(mover)

            let path = CAKeyframeAnimation(keyPath: "position")
            path.values = points
            path.keyTimes = ConfettiView.samples.map { NSNumber(value: $0) }
            path.duration = D
            path.fillMode = .forwards
            path.isRemovedOnCompletion = false
            mover.add(path, forKey: "path")
            let fade = CAKeyframeAnimation(keyPath: "opacity")
            fade.values = [1, 1, 0]
            fade.keyTimes = [0, 0.8, 1]
            fade.duration = D
            fade.fillMode = .forwards
            fade.isRemovedOnCompletion = false
            mover.add(fade, forKey: "fade")
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = s0
            spin.toValue = s0 + turns * Double.pi * 2
            spin.duration = D
            spin.fillMode = .forwards
            spin.isRemovedOnCompletion = false
            spinner.add(spin, forKey: "spin")
            let flip = CABasicAnimation(keyPath: "transform.rotation.x")
            flip.fromValue = 0
            flip.toValue = flips * Double.pi * 2
            flip.duration = D
            flip.fillMode = .forwards
            flip.isRemovedOnCompletion = false
            piece.add(flip, forKey: "flip")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + D) { [weak self, weak burst] in
            burst?.removeFromSuperlayer()
            self?.onDone?()
        }
    }
}
