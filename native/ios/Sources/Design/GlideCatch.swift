import UIKit

/// A list still gliding after a flick, but almost at rest, gives a new touch to what is under the finger.
///
/// A finger put on a list that glides is taken by the list's own scroll at once: the touch only stops the glide,
/// and nothing else may begin with it — not a row's swipe, the swipe back, the turn of a folder, nor a strip that
/// scrolls sideways (the stories). A sideways swipe made at the very end of a glide was lost so. When the glide has
/// slowed below `slow` points a second, the touch stops it at once instead, before anything has looked at the touch,
/// and the touch then goes on as on a list at rest: a mostly sideways move is the row's or the strip's, a vertical
/// one scrolls, a tap is a tap. A faster glide is still stopped by the touch alone, as before.
///
/// The list's speed is not told by the system: it is measured here from how far the list went between two
/// `scrolled` calls (its delegate's scrollViewDidScroll). `touching` is called from the hitTest of the view that
/// holds the list, for a touch that comes down on it. Main thread only.
final class GlideCatch {
    /// Below this speed (points a second) a glide is nearly over and a touch goes to what is under it.
    static let slow: CGFloat = 160
    /// A glide that has not moved the list for this long is as good as stopped, s.
    private static let still: CFTimeInterval = 0.1

    private var lastY: CGFloat = 0
    private var lastAt: CFTimeInterval = 0
    /// The last measured speed, points a second.
    private var speed: CGFloat = 0

    /// Whether a touch that comes down now stops the glide and goes on to what is under it.
    static func lets(gliding: Bool, speed: CGFloat) -> Bool { gliding && speed < slow }

    func scrolled(_ scroll: UIScrollView) {
        let now = CACurrentMediaTime()
        let y = scroll.contentOffset.y
        if lastAt > 0 && now > lastAt && (scroll.isDragging || scroll.isDecelerating) {
            let step = abs(y - lastY) / CGFloat(now - lastAt)
            // Halfway to the newest step: one late frame does not make the glide look slower than it is.
            speed = speed == 0 ? step : (speed + step) / 2
        } else if !scroll.isDecelerating {
            speed = 0
        }
        lastY = y
        lastAt = now
    }

    /// A touch is coming down on the list: a slow glide is stopped where it is (true); anything else is left alone.
    @discardableResult
    func touching(_ scroll: UIScrollView, event: UIEvent?) -> Bool {
        guard event?.type == .touches, !scroll.isTracking else { return false }
        let quiet = CACurrentMediaTime() - lastAt
        guard GlideCatch.lets(gliding: scroll.isDecelerating, speed: quiet > GlideCatch.still ? 0 : speed) else { return false }
        // A list pulled past its end springs back by itself; that is left alone (stopped, it would stay pulled).
        let inset = scroll.adjustedContentInset
        let top = -inset.top
        let bottom = max(top, scroll.contentSize.height - scroll.bounds.height + inset.bottom)
        let y = scroll.contentOffset.y
        guard y >= top - 0.5 && y <= bottom + 0.5 else { return false }
        // Set where it stands, the list stops gliding and is at rest for the touch that follows.
        scroll.setContentOffset(scroll.contentOffset, animated: false)
        speed = 0
        return true
    }
}
