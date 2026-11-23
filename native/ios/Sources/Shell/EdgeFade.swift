import UIKit

/// The numbers of the soft edge behind floating bars (ScrollEdges.swift, ChatLook's header and composer edges;
/// Android shell/EdgeFade.kt has the same numbers). Positions are counted in points from the screen's edge inwards;
/// `size` is the bar's height from that edge (the status bar / home indicator included), `total` the whole effect:
/// the bar plus `reach` past its inner edge.
///
/// Owner (device photos, compared side by side with the big messenger he pointed to): no heavy blur — what scrolls
/// under a bar is covered by the page's colour at a fixed strength, solid from the screen's edge and fading out
/// along an S-shaped course over the last `fade` points. The blur there is a 1 pt radius, invisible on a phone, so
/// none is drawn here. The page's colour comes from the theme (each theme its own), the chat's from its wallpaper.
enum EdgeRamp {
    /// The chat list's and settings' header: 14 pt past the header, fading over 54 pt, colour at .85.
    static let reach: CGFloat = 14
    static let fade: CGFloat = 54
    static let strength: CGFloat = 0.85

    /// The fading course (0 = where it starts fading, 1 = its inner end) → share of the full strength.
    /// Measured points of the S-curve, evenly spaced; straight pieces between them.
    static let course: [CGFloat] = [1.0, 0.987, 0.956, 0.901, 0.802, 0.656, 0.483, 0.317, 0.179, 0.089, 0.044, 0.022, 0.0]

    /// The share of the strength at `y` points from the screen's edge.
    static func wash(_ y: CGFloat, total: CGFloat, fade: CGFloat) -> CGFloat {
        let start = max(0, total - max(1, fade))
        if y <= start { return 1 }
        if y >= total { return 0 }
        let t = (y - start) / max(1, total - start) * CGFloat(course.count - 1)
        let index = min(course.count - 2, Int(t))
        let part = t - CGFloat(index)
        return course[index] + (course[index + 1] - course[index]) * part
    }

    /// Gradient stops (location 0…1 from the screen's edge, share 0…1) for the whole effect.
    static func stops(total: CGFloat, fade: CGFloat) -> [(CGFloat, CGFloat)] {
        guard total > 0 else { return [(0, 1), (1, 0)] }
        let start = max(0, total - max(1, fade))
        var out: [(CGFloat, CGFloat)] = []
        if start > 0 { out.append((0, 1)) }
        for index in 0..<course.count {
            let y = start + (total - start) * CGFloat(index) / CGFloat(course.count - 1)
            out.append((y / total, course[index]))
        }
        return out
    }
}

/// The soft edge behind a floating bar: the page's colour, solid from the screen's edge, fading out `reach` past
/// the bar along EdgeRamp's course. Static: nothing runs per frame; a new layout redraws only when the size
/// changes. Reduce Transparency: the colour is solid. The glass bars stay above it (callers put it under them).
class ProgressiveEdgeView: UIView {
    enum Edge { case top, bottom }

    let edge: Edge
    /// The colour; nil: the page's colour.
    var color: UIColor?
    /// The colour's strength; nil: EdgeRamp.strength.
    var peak: CGFloat?
    /// How far past the bar the effect reaches.
    var reach: CGFloat = EdgeRamp.reach
    /// Over how many points (ending at `reach` past the bar) the colour fades out.
    var fade: CGFloat = EdgeRamp.fade
    /// A top edge only: the status bar's height. The colour is laid over it once more, solid (fading out 10 pt below,
    /// as the reference's extra status-bar layer): under the clock nothing scrolling stays readable (without the
    /// reference's blur a .85 cover still let text show there); below the band the strength is unchanged.
    var statusBand: CGFloat = 0
    /// Solid over the whole bar: the fade (still `fade` long) begins only at the bar's inner edge, so nothing behind
    /// the bar's clear glass shows through; false: the fade ends `reach` past the bar (and may begin inside it).
    var solidThroughBar = false

    private let wash = CAGradientLayer()
    private let band = CAGradientLayer()
    private var key = ""

    init(edge: Edge) {
        self.edge = edge
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.addSublayer(wash)
        layer.addSublayer(band)
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
        let total = size + max(0, solidThroughBar ? max(reach, fade) : reach)
        frame = CGRect(x: 0, y: edge == .top ? 0 : height - total, width: width, height: total)
        let reduced = UIAccessibility.isReduceTransparencyEnabled
        let tone = color ?? Theme.bg
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        tone.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let strength = reduced ? 1 : min(1, max(0, peak ?? EdgeRamp.strength))
        let newKey = "\(width)|\(total)|\(fade)|\(red)|\(green)|\(blue)|\(alpha)|\(strength)|\(edge == .top)|\(statusBand)|\(solidThroughBar)"
        guard newKey != key else { return }
        key = newKey

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        wash.frame = bounds
        wash.startPoint = edge == .top ? CGPoint(x: 0.5, y: 0) : CGPoint(x: 0.5, y: 1)
        wash.endPoint = edge == .top ? CGPoint(x: 0.5, y: 1) : CGPoint(x: 0.5, y: 0)
        let stops = EdgeRamp.stops(total: total, fade: fade)
        wash.colors = stops.map { (stop: (CGFloat, CGFloat)) -> CGColor in tone.withAlphaComponent(strength * stop.1).cgColor }
        wash.locations = stops.map { (stop: (CGFloat, CGFloat)) -> NSNumber in NSNumber(value: Double(stop.0)) }
        let bandSolid = edge == .top ? min(total, max(0, statusBand)) : 0
        band.isHidden = bandSolid <= 0
        if bandSolid > 0 {
            let bandHeight = min(total, bandSolid + 10)
            band.frame = CGRect(x: 0, y: 0, width: width, height: bandHeight)
            band.startPoint = CGPoint(x: 0.5, y: 0)
            band.endPoint = CGPoint(x: 0.5, y: 1)
            band.colors = [tone.withAlphaComponent(1).cgColor, tone.withAlphaComponent(1).cgColor, tone.withAlphaComponent(0).cgColor]
            band.locations = [0, NSNumber(value: Double(bandSolid / bandHeight)), 1]
        }
        CATransaction.commit()
    }
}
