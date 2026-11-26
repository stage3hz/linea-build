import UIKit

/// A hold on a row of a list, told from a scroll or a tap that reached the app late.
///
/// The hold's clock runs inside the app; the finger's moves and its lift come from outside. When the app is busy
/// for as long as a hold lasts, the clock runs out before the moves (or the lift) the finger has already made are
/// read: the recognizer then begins on a finger that has in fact gone on, and a scroll or a plain tap opened the
/// row's menu. So a hold is believed a moment later, and only when the list has not gone with the finger, the
/// finger is where it was put down, and — if it is up already — it was down for as long as a hold lasts.
final class SteadyHold: NSObject, UIGestureRecognizerDelegate {
    /// The finger may wander this far, pt (the recognizer's own allowance).
    private static let slack: CGFloat = 10
    /// How long after the recognizer's word the finger is looked at, s.
    private static let wait: TimeInterval = 0.08

    private weak var finger: UITouch?
    private var downAt: TimeInterval = 0
    private var turn = 0

    /// The recognizer's touches are remembered from here on (its delegate is this object).
    func watch(_ recognizer: UILongPressGestureRecognizer) {
        recognizer.allowableMovement = SteadyHold.slack
        recognizer.delegate = self
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        finger = touch
        downAt = touch.timestamp
        return true
    }

    /// Called with the recognizer when it begins. `run` gets the place of the hold in the window, once the hold
    /// is believed; it is not called for a scroll or a tap.
    func began(_ recognizer: UILongPressGestureRecognizer, in scroll: UIScrollView, run: @escaping (CGPoint) -> Void) {
        guard recognizer.state == .began else { return }
        // A list that is moving is being scrolled, not held.
        if scroll.isDragging || scroll.isDecelerating { return }
        turn += 1
        look(turn: turn, start: recognizer.location(in: nil), needed: recognizer.minimumPressDuration, scroll: scroll, again: 2, run: run)
    }

    private func look(turn asked: Int, start: CGPoint, needed: TimeInterval, scroll: UIScrollView, again: Int, run: @escaping (CGPoint) -> Void) {
        let from = CACurrentMediaTime()
        DispatchQueue.main.asyncAfter(deadline: .now() + SteadyHold.wait) { [weak self, weak scroll] in
            guard let self, self.turn == asked else { return }
            // The app was busy again while this waited: what the finger did may still be unread, one more look.
            if again > 0 && CACurrentMediaTime() - from > SteadyHold.wait + 0.2, let scroll {
                self.look(turn: asked, start: start, needed: needed, scroll: scroll, again: again - 1, run: run)
                return
            }
            if let scroll, scroll.isDragging || scroll.isDecelerating { return }
            if let touch = self.finger {
                let place = touch.location(in: nil)
                if abs(place.x - start.x) > SteadyHold.slack || abs(place.y - start.y) > SteadyHold.slack { return }
                // Up already: a hold only if the finger was down for about as long as a hold lasts.
                if touch.phase == .ended && touch.timestamp - self.downAt < needed * 0.9 { return }
            }
            run(start)
        }
    }
}
