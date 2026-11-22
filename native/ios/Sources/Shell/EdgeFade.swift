import UIKit

/// The numbers of the progressive edge behind floating bars (ScrollEdges.swift, ChatLook's header and composer
/// edges; Android shell/EdgeFade.kt has the same numbers). Positions are counted in points from the screen's edge
/// inwards; `size` is the bar's height from that edge (the status bar / home indicator included), `total` the whole
/// effect: the bar plus `reach` past its inner edge.
///
/// The idea: what scrolls under a bar is blurred hardest at the very edge of the screen, and the blur thins out
/// gradually towards the content, so there is no line where blurred meets crisp. A colour wash (the page's colour:
/// near-black on dark themes, near-white on light ones) follows the same course, held at its peak over the outer
/// part of the bar and easing away past it. A real per-pixel varying blur radius is not public on iOS, so the
/// ramp is built from a few partial blurs stacked on top of each other: all of them act right at the edge (they
/// compound into a strong blur), fewer and fewer further in, each fading out smoothly at its own depth.
enum EdgeRamp {
    /// How far the effect reaches past the bar's inner edge.
    static let reach: CGFloat = 24
    /// The part of the bar over which the colour and the blur already ease away (ending at `reach` past it).
    static let soften: CGFloat = 30
    /// How many partial blurs make the ramp.
    static let layers = 4
    /// How strong each partial blur is (a fraction of the material's full blur).
    static let layerStrength: CGFloat = 0.5
    /// The colour wash's peak right at the screen's edge.
    static func peak(dark: Bool) -> CGFloat { return dark ? 0.8 : 0.7 }

    /// Smooth 1 → 0 between `from` and `to` (1 before `from`, 0 after `to`), with no kink at either end.
    static func fall(_ y: CGFloat, from: CGFloat, to: CGFloat) -> CGFloat {
        if y <= from { return 1 }
        if y >= to || to <= from { return 0 }
        let u = (y - from) / (to - from)
        return 1 - u * u * (3 - 2 * u)
    }

    /// Where the colour starts easing away.
    static func holdEnd(size: CGFloat, total: CGFloat) -> CGFloat {
        return max(0, min(total * 0.8, size - soften))
    }

    /// The colour wash at `y` (0…1 of the peak).
    static func wash(_ y: CGFloat, size: CGFloat, total: CGFloat) -> CGFloat {
        return fall(y, from: holdEnd(size: size, total: total), to: total)
    }

    /// The depth where the partial blur `index` (0 = the deepest) is gone, and where it starts thinning.
    static func layerSpan(_ index: Int, size: CGFloat, total: CGFloat) -> (start: CGFloat, end: CGFloat) {
        let rampStart = holdEnd(size: size, total: total)
        let ramp = max(1, total - rampStart)
        let step = ramp / CGFloat(layers)
        let end = max(1, total - CGFloat(index) * step)
        let start = max(0, end - ramp * 0.5)
        return (start, end)
    }

    /// How many partial blurs act at `y` (0…`layers`): the blur ramp, for tests and checks.
    static func blurAt(_ y: CGFloat, size: CGFloat, total: CGFloat) -> CGFloat {
        var sum: CGFloat = 0
        for index in 0..<layers {
            let span = layerSpan(index, size: size, total: total)
            sum += fall(y, from: span.start, to: span.end)
        }
        return sum
    }

    /// Gradient stops (location 0…1 from the edge, value 0…1) for a course that only changes between `from` and
    /// `to`: one stop at each end of the view and `count` across the change, dense enough that the straight pieces
    /// between them read as one smooth curve.
    static func samples(total: CGFloat, from: CGFloat, to: CGFloat, count: Int = 10, _ value: (CGFloat) -> CGFloat) -> [(CGFloat, CGFloat)] {
        guard total > 0, count >= 2 else { return [(0, 1), (1, 0)] }
        let low = max(0, min(total, from))
        let high = max(low, min(total, to))
        var out: [(CGFloat, CGFloat)] = []
        if low > 0 { out.append((0, value(0))) }
        for i in 0..<count {
            let y = low + (high - low) * CGFloat(i) / CGFloat(count - 1)
            out.append((y / total, value(y)))
        }
        if high < total { out.append((1, value(total))) }
        return out
    }
}

/// A progressive edge behind a floating bar: stacked partial blurs that ramp from strong at the screen's edge to
/// nothing `reach` past the bar, and a colour wash over them easing the same way. Static: nothing runs per frame,
/// a new layout only redraws masks when the size changes. Energy saving: the wash alone (no blur). Reduce
/// Transparency: a denser wash, no blur. The glass bars stay above it (callers put it under them).
class ProgressiveEdgeView: UIView {
    enum Edge { case top, bottom }

    let edge: Edge
    /// The wash's colour; nil: the page's colour.
    var color: UIColor?
    /// The wash's peak; nil: EdgeRamp.peak for the colour's lightness.
    var peak: CGFloat?
    /// How far past the bar the effect reaches.
    var reach: CGFloat = EdgeRamp.reach

    private var blurs: [PartialBlurView] = []
    private var masks: [CAGradientLayer] = []
    private let wash = CAGradientLayer()
    private var key = ""

    init(edge: Edge) {
        self.edge = edge
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        for _ in 0..<EdgeRamp.layers {
            let blur = PartialBlurView(strength: EdgeRamp.layerStrength)
            let mask = CAGradientLayer()
            blur.layer.mask = mask
            addSubview(blur)
            blurs.append(blur)
            masks.append(mask)
        }
        layer.addSublayer(wash)
        NotificationCenter.default.addObserver(self, selector: #selector(conditionsChanged), name: Motion.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(conditionsChanged), name: UIAccessibility.reduceTransparencyStatusDidChangeNotification, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func conditionsChanged() {
        key = ""
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    /// `size`: the bar's height from the screen's edge; `height`: the container's height (for a bottom edge).
    /// Lays itself out.
    func place(width: CGFloat, size: CGFloat, height: CGFloat = 0) {
        isHidden = size <= 0
        guard size > 0 else { return }
        let total = size + max(0, reach)
        frame = CGRect(x: 0, y: edge == .top ? 0 : height - total, width: width, height: total)
        let reduced = UIAccessibility.isReduceTransparencyEnabled
        let saving = Motion.saving
        let tone = color ?? Theme.bg
        var white: CGFloat = 0, alpha: CGFloat = 0
        tone.getWhite(&white, alpha: &alpha)
        let darkTone = white < 0.5
        let top = min(1, peak ?? EdgeRamp.peak(dark: darkTone))
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0
        tone.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let newKey = "\(width)|\(size)|\(total)|\(reduced)|\(saving)|\(red)|\(green)|\(blue)|\(alpha)|\(top)|\(edge == .top)"
        guard newKey != key else { return }
        key = newKey

        let from = edge == .top ? CGPoint(x: 0.5, y: 0) : CGPoint(x: 0.5, y: 1)
        let to = edge == .top ? CGPoint(x: 0.5, y: 1) : CGPoint(x: 0.5, y: 0)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, blur) in blurs.enumerated() {
            blur.frame = bounds
            let mask = masks[index]
            mask.frame = bounds
            mask.startPoint = from
            mask.endPoint = to
            let span = EdgeRamp.layerSpan(index, size: size, total: total)
            let stops = EdgeRamp.samples(total: total, from: span.start, to: span.end, count: 8) { (y: CGFloat) -> CGFloat in
                EdgeRamp.fall(y, from: span.start, to: span.end)
            }
            mask.colors = stops.map { (stop: (CGFloat, CGFloat)) -> CGColor in UIColor(white: 0, alpha: stop.1).cgColor }
            mask.locations = stops.map { (stop: (CGFloat, CGFloat)) -> NSNumber in NSNumber(value: Double(stop.0)) }
        }
        wash.frame = bounds
        wash.startPoint = from
        wash.endPoint = to
        // Reduce Transparency: nothing shows through right behind the bar.
        let washPeak: CGFloat = reduced ? 1 : (saving ? min(1, top + 0.1) : top)
        let stops = EdgeRamp.samples(total: total, from: EdgeRamp.holdEnd(size: size, total: total), to: total, count: 12) { (y: CGFloat) -> CGFloat in
            EdgeRamp.wash(y, size: size, total: total)
        }
        wash.colors = stops.map { (stop: (CGFloat, CGFloat)) -> CGColor in tone.withAlphaComponent(washPeak * stop.1).cgColor }
        wash.locations = stops.map { (stop: (CGFloat, CGFloat)) -> NSNumber in NSNumber(value: Double(stop.0)) }
        CATransaction.commit()

        let noBlur = reduced || saving
        for blur in blurs {
            blur.isHidden = noBlur
            if !noBlur { blur.setStyle(darkTone ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight) }
        }
    }
}

/// A blur weaker than the material's own: the effect is set through an animation that is held part of the way
/// (a public UIKit technique; no private API). The held animation is let go before the view goes away, and set
/// up again when the view comes back to a window or the app back to the foreground (the system may drop it).
final class PartialBlurView: UIVisualEffectView {
    private let strength: CGFloat
    private var style: UIBlurEffect.Style?
    private var animator: UIViewPropertyAnimator?

    init(strength: CGFloat) {
        self.strength = max(0.05, min(1, strength))
        super.init(effect: nil)
        isUserInteractionEnabled = false
        NotificationCenter.default.addObserver(self, selector: #selector(foreground), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        NotificationCenter.default.removeObserver(self)
        animator?.stopAnimation(true)
    }

    func setStyle(_ wanted: UIBlurEffect.Style) {
        guard wanted != style else { return }
        style = wanted
        hold()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            letGo()
        } else if style != nil {
            hold()
        }
    }

    @objc private func foreground() {
        if window != nil && style != nil { hold() }
    }

    private func letGo() {
        animator?.stopAnimation(true)
        animator = nil
    }

    private func hold() {
        letGo()
        guard let style else { return }
        effect = nil
        let made = UIViewPropertyAnimator(duration: 1, curve: .linear)
        made.addAnimations { [weak self] () -> Void in
            self?.effect = UIBlurEffect(style: style)
        }
        made.fractionComplete = strength
        animator = made
    }
}
