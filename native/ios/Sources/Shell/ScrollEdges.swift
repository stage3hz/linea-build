import UIKit

/// The scroll-edge effect behind floating bars (the reference's tabInset.tsx `ScrollEdgeEffect`): the content
/// under a bar is blurred and covered by the page's colour evenly over the bar, then dissolves across its inner
/// edge — fully covered up to 14 pt short of it, then a soft ramp ending `fade` pt past it. No hard line, no crisp
/// text next to the glass. Static views only: nothing runs per frame. Reduce Transparency: a solid band, no blur.
final class ScrollEdgeView: UIView {
    enum Edge { case top, bottom }
    /// The reference's EDGE_STRENGTH: how much of `alpha` the colour reaches right behind the bar.
    static let strength: CGFloat = 0.3

    let edge: Edge
    /// The page's colour and how strongly it covers (FloatingHeader: the theme's background at .78 on iPhone).
    var color: UIColor = Theme.bg
    var alphaOfEdge: CGFloat = 0.78
    var cover: CGFloat = ScrollEdgeView.strength
    var fade: CGFloat = 8
    private let blur = UIVisualEffectView(effect: nil)
    private let blurMask = CAGradientLayer()
    private let tint = CAGradientLayer()
    private var blurDark: Bool?

    init(edge: Edge) {
        self.edge = edge
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        addSubview(blur)
        blur.layer.mask = blurMask
        layer.addSublayer(tint)
    }

    required init?(coder: NSCoder) { return nil }

    /// `size`: the bar's height from the screen edge (status bar / home indicator included); `height`: the
    /// container's height (for a bottom edge).
    func place(width: CGFloat, size: CGFloat, height: CGFloat = 0) {
        isHidden = size <= 0
        guard size > 0 else { return }
        let total = size + fade
        frame = CGRect(x: 0, y: edge == .top ? 0 : height - total, width: width, height: total)
        let reduced = UIAccessibility.isReduceTransparencyEnabled
        let solid = max(0, min(1, (size - 14) / total))
        let peak = reduced ? 1 : min(1, alphaOfEdge * cover)
        let from = edge == .top ? CGPoint(x: 0.5, y: 0) : CGPoint(x: 0.5, y: 1)
        let to = edge == .top ? CGPoint(x: 0.5, y: 1) : CGPoint(x: 0.5, y: 0)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        blur.frame = bounds
        blurMask.frame = bounds
        blurMask.startPoint = from
        blurMask.endPoint = to
        blurMask.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
        blurMask.locations = [0, NSNumber(value: Double(solid)), NSNumber(value: Double(min(1, solid + (1 - solid) * 0.8)))]
        tint.frame = bounds
        tint.startPoint = from
        tint.endPoint = to
        tint.colors = [color.withAlphaComponent(peak).cgColor, color.withAlphaComponent(peak * 0.9).cgColor,
                       color.withAlphaComponent(peak * 0.45).cgColor, color.withAlphaComponent(0).cgColor]
        tint.locations = [0, NSNumber(value: Double(solid)), NSNumber(value: Double(solid + (1 - solid) * 0.45)), 1]
        CATransaction.commit()
        // The material follows the edge colour, not only the theme.
        var white: CGFloat = 0, alpha: CGFloat = 0
        color.getWhite(&white, alpha: &alpha)
        let darkEdge = white < 0.5
        if blurDark != darkEdge {
            blurDark = darkEdge
            blur.effect = UIBlurEffect(style: darkEdge ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight)
        }
        blur.isHidden = reduced
    }
}

/// The bottom scroll-edge effect behind the floating tab bar (the reference's `TabBarEdge` with chatLayout.ts
/// `tabBarEdge`, `TAB_BAR_EDGE_SOFT` and `TAB_BAR_EDGE_SOFT_FADE`): rows passing behind the bar dissolve into the
/// page — nothing readable under the pill, beside its rounded ends or in the home-indicator strip below it; rows
/// above the bar are untouched. Blurred and barely tinted on iPhone; Reduce Transparency: colour alone.
final class TabBarEdgeView: UIView {
    private static let pill: CGFloat = 62
    private static let soft: [CGFloat] = [0.34, 0.3, 0.22, 0.1, 0]
    private static let softFade: CGFloat = 22
    private let blur = UIVisualEffectView(effect: nil)
    private let blurMask = CAGradientLayer()
    private let tint = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        addSubview(blur)
        blur.layer.mask = blurMask
        layer.addSublayer(tint)
    }

    required init?(coder: NSCoder) { return nil }

    /// `block`: the height of the tab block above the screen's bottom (the pill, its margins, the mini-player when
    /// shown, the home indicator); `lift`: the pill's lower edge above the screen's bottom.
    func place(width: CGFloat, height: CGFloat, block: CGFloat, lift: CGFloat) {
        let reduced = UIAccessibility.isReduceTransparencyEnabled
        let fade: CGFloat = reduced ? 8 : TabBarEdgeView.softFade
        let pillBottom = max(0, lift), pillTop = pillBottom + TabBarEdgeView.pill
        let total = max(pillTop, max(0, block)) + fade
        func at(_ points: CGFloat) -> NSNumber { NSNumber(value: Double(min(1, points / total))) }
        frame = CGRect(x: 0, y: height - total, width: width, height: total)
        let alphas: [CGFloat] = reduced ? [1, 1, 1, 0.9, 0] : TabBarEdgeView.soft
        let color = Theme.bg
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        tint.frame = bounds
        tint.startPoint = CGPoint(x: 0.5, y: 1)
        tint.endPoint = CGPoint(x: 0.5, y: 0)
        tint.colors = alphas.map { (alpha: CGFloat) -> CGColor in color.withAlphaComponent(alpha).cgColor }
        tint.locations = [0, at(pillBottom + TabBarEdgeView.pill * 0.2), at(pillBottom + TabBarEdgeView.pill * 0.6), at(pillTop), 1]
        blur.frame = bounds
        blurMask.frame = bounds
        blurMask.startPoint = CGPoint(x: 0.5, y: 1)
        blurMask.endPoint = CGPoint(x: 0.5, y: 0)
        blurMask.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
        blurMask.locations = [0, at(pillTop - 14), 1]
        CATransaction.commit()
        if blur.effect == nil { blur.effect = UIBlurEffect(style: Theme.dark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight) }
        blur.isHidden = reduced
    }
}

/// The strip under the status bar (the reference's TabsFade top part): a light blur that thins out 10 pt below
/// the strip and the page's colour from .3 to nothing over it, so rows passing under the clock are not crisp.
final class StatusStripView: UIView {
    private let blur = UIVisualEffectView(effect: nil)
    private let blurMask = CAGradientLayer()
    private let tint = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        addSubview(blur)
        blur.layer.mask = blurMask
        layer.addSublayer(tint)
    }

    required init?(coder: NSCoder) { return nil }

    func place(width: CGFloat, safeTop: CGFloat) {
        isHidden = safeTop <= 0
        guard safeTop > 0 else { return }
        frame = CGRect(x: 0, y: 0, width: width, height: safeTop + 10)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        blur.frame = bounds
        blurMask.frame = bounds
        blurMask.colors = [UIColor.black.cgColor, UIColor.clear.cgColor]
        blurMask.locations = [0, 1]
        tint.frame = CGRect(x: 0, y: 0, width: width, height: safeTop)
        tint.colors = [Theme.bg.withAlphaComponent(0.3).cgColor, Theme.bg.withAlphaComponent(0).cgColor]
        CATransaction.commit()
        if blur.effect == nil { blur.effect = UIBlurEffect(style: Theme.dark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight) }
        blur.alpha = 0.5
        blur.isHidden = UIAccessibility.isReduceTransparencyEnabled
    }
}
