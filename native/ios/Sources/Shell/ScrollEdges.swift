import UIKit

// The scroll edges behind the floating bars (the reference's tabInset.tsx `ScrollEdgeEffect`, `TabBarEdge` and
// TabsFade), now drawn as the progressive edge of EdgeFade.swift: blurred hardest at the screen's edge and thinning
// out to nothing 24 pt past the bar, under a colour wash that eases the same way. No hard line, no crisp text next
// to the glass. Static views only: nothing runs per frame. Energy saving: the wash alone; Reduce Transparency: a
// solid band, no blur.

/// The edge under a floating header (or above a floating bottom bar). `size` in `place`: the bar's height from
/// the screen's edge, the status bar / home indicator included.
final class ScrollEdgeView: ProgressiveEdgeView {}

/// The bottom edge behind the floating tab bar: rows passing behind the bar dissolve into the page — nothing
/// readable under the pill, beside its rounded ends or in the home-indicator strip below it.
final class TabBarEdgeView: ProgressiveEdgeView {
    private static let pill: CGFloat = 62

    init() {
        super.init(edge: .bottom)
    }

    required init?(coder: NSCoder) { return nil }

    /// `block`: the height of the tab block above the screen's bottom (the pill, its margins, the mini-player when
    /// shown, the home indicator); `lift`: the pill's lower edge above the screen's bottom.
    func place(width: CGFloat, height: CGFloat, block: CGFloat, lift: CGFloat) {
        let pillTop = max(0, lift) + TabBarEdgeView.pill
        place(width: width, size: max(pillTop, max(0, block)), height: height)
    }
}

/// The strip under the status bar in the sections without a floating header of their own: a lighter progressive
/// edge reaching 10 pt below the strip, so rows passing under the clock are not crisp.
final class StatusStripView: ProgressiveEdgeView {
    init() {
        super.init(edge: .top)
        reach = 10
        peak = 0.45
    }

    required init?(coder: NSCoder) { return nil }

    func place(width: CGFloat, safeTop: CGFloat) {
        place(width: width, size: safeTop)
    }
}
