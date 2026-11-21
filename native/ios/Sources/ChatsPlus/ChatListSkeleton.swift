import UIKit

/// ChatsPlus: placeholder rows shaped like the chat list's while it waits for its first chats — the reference's
/// `ChatListSkeleton` (effects.tsx) over the expokit `Skeleton` (kit/ui/skeleton.tsx), «shimmer» variant: nine rows
/// (a 60 pt avatar — round, the owner's rule —, a name bar, the time, a preview bar) and one angled light band
/// that sweeps across all of them together. Static when the system asks for less motion.
final class ChatListSkeletonView: UIView {
    // The reference's numbers.
    private static let nameWidths: [CGFloat] = [0.58, 0.42, 0.66, 0.50, 0.36, 0.62, 0.47, 0.55, 0.40]
    private static let previewWidths: [CGFloat] = [0.88, 0.72, 0.94, 0.80, 0.66, 0.90, 0.76, 0.84, 0.70]
    private static let rows = 9
    private static let cycle: CFTimeInterval = 2.1
    private static let sweep: Double = 0.7
    private static let angle: CGFloat = 20 * .pi / 180

    private let blocks = CAShapeLayer()
    private let shineHolder = CALayer()
    private let shineMask = CAShapeLayer()
    private let band = CAGradientLayer()
    private var laidFor: CGSize = .zero
    private var dark = true

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        accessibilityLabel = "Загрузка чатов"
        accessibilityTraits = .updatesFrequently
        layer.addSublayer(blocks)
        shineHolder.mask = shineMask
        shineHolder.addSublayer(band)
        layer.addSublayer(shineHolder)
    }

    required init?(coder: NSCoder) { return nil }

    /// The theme's foreground: a faint tint of it is the block, a light band moves over it.
    func setDark(_ on: Bool) {
        dark = on
        laidFor = .zero
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != laidFor, bounds.width > 0 else { return }
        laidFor = bounds.size
        let path = UIBezierPath()
        let width = bounds.width
        for index in 0..<ChatListSkeletonView.rows {
            // SkeletonGroup paddingTop 4; each row: 8 pt above and below a 60 pt line, 16 pt at the sides.
            let top = 4 + CGFloat(index) * 76 + 8
            path.append(UIBezierPath(ovalIn: CGRect(x: 16, y: top, width: 60, height: 60)))
            let column = CGRect(x: 16 + 60 + 12, y: top, width: width - 16 - 60 - 12 - 16, height: 60)
            // The name row (14 pt) and the preview (12 pt), 9 pt apart, centred in the 60 pt column.
            let lineTop = column.minY + (60 - 14 - 9 - 12) / 2
            let name = CGRect(x: column.minX, y: lineTop, width: column.width * ChatListSkeletonView.nameWidths[index % 9], height: 14)
            path.append(UIBezierPath(roundedRect: name, cornerRadius: 7))
            let time = CGRect(x: column.maxX - 34, y: lineTop + 1.5, width: 34, height: 11)
            path.append(UIBezierPath(roundedRect: time, cornerRadius: 5.5))
            let preview = CGRect(x: column.minX, y: lineTop + 14 + 9, width: column.width * ChatListSkeletonView.previewWidths[(index + 3) % 9], height: 12)
            path.append(UIBezierPath(roundedRect: preview, cornerRadius: 6))
        }
        // kit.ts: foreground #fafafa (dark) / #09090b (light); the block at 11 % / 9 %.
        let foreground = dark ? UIColor(hex: 0xFAFAFA) : UIColor(hex: 0x09090B)
        blocks.frame = bounds
        blocks.path = path.cgPath
        blocks.fillColor = foreground.withAlphaComponent(dark ? 0.11 : 0.09).cgColor
        shineHolder.frame = bounds
        shineMask.frame = bounds
        shineMask.path = path.cgPath
        startShine(foreground: foreground)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { laidFor = .zero; setNeedsLayout() }
    }

    private func startShine(foreground: UIColor) {
        band.removeAllAnimations()
        guard !UIAccessibility.isReduceMotionEnabled else { band.isHidden = true; return }
        band.isHidden = false
        let shine = dark ? foreground : UIColor.white
        let peak: CGFloat = dark ? 0.11 : 0.62
        let alphas: [CGFloat] = [0, peak * 0.12, peak * 0.62, peak, peak * 0.62, peak * 0.12, 0]
        band.colors = alphas.map { shine.withAlphaComponent($0).cgColor }
        band.locations = [0, 0.22, 0.4, 0.5, 0.6, 0.78, 1]
        band.startPoint = CGPoint(x: 0, y: 0.5)
        band.endPoint = CGPoint(x: 1, y: 0.5)
        let w = bounds.width
        let h = min(bounds.height, 900)
        let slope = tan(ChatListSkeletonView.angle)
        let wide = max(160, min(320, w * 0.55))
        let tall = (bounds.height + wide) / cos(ChatListSkeletonView.angle) + 40
        // A vertical band turned by 20°: its top leans to the right, as the reference's slanted line does.
        band.bounds = CGRect(x: 0, y: 0, width: wide * cos(ChatListSkeletonView.angle), height: tall)
        band.setAffineTransform(CGAffineTransform(rotationAngle: ChatListSkeletonView.angle))
        // Where the band's centre line crosses the top of the frame: from −B to W + H·tan20° + B, eased by a sine,
        // over 70 % of the 2.1 s cycle; then a calm pause. The layer's middle stands at half the height.
        let middle = bounds.height / 2
        let from = -wide - middle * slope
        let to = w + h * slope + wide - middle * slope
        band.position = CGPoint(x: from, y: middle)
        let move = CAKeyframeAnimation(keyPath: "position.x")
        var values: [CGFloat] = []
        var times: [NSNumber] = []
        let steps = 24
        for step in 0...steps {
            let x = Double(step) / Double(steps)
            let eased = 0.5 - 0.5 * cos(Double.pi * x) // easeInOut(sin)
            values.append(from + (to - from) * CGFloat(eased))
            times.append(NSNumber(value: x * ChatListSkeletonView.sweep))
        }
        values.append(to)
        times.append(1)
        move.values = values
        move.keyTimes = times
        move.duration = ChatListSkeletonView.cycle
        move.repeatCount = .infinity
        move.calculationMode = .linear
        move.isRemovedOnCompletion = false
        band.add(move, forKey: "shimmer")
    }
}
