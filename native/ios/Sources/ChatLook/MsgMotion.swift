import UIKit

/// Swipe a message to the LEFT to answer it (the reference's MessageRow.tsx `SwipeToReply`, as in the big
/// messengers for iPhone; a right swipe goes back). The row follows the finger at 0.85 of its way, at most 96
/// points; at 60 points a light knock says it is armed and the round arrow is fully there; letting go then answers.
/// The row snaps back once, without overshoot (180 ms, ease-out cubic). A mostly vertical move scrolls the list.
///
/// Works on the upside-down table of `MsgListView`: rows are found through `rowAt`, the moving view is the row's
/// own drawing (upright inside the turned cell).
final class MsgSwipeReply: NSObject, UIGestureRecognizerDelegate {
    /// The row under a point of the table and the view that moves (nil: nothing that can be answered there).
    var rowAt: (CGPoint) -> (key: String, view: UIView)? = { _ in nil }
    /// Whether the message of a row can be answered (decrypted, not on its way out, not while choosing).
    var canReply: (String) -> Bool = { _ in false }
    var onReply: (String) -> Void = { _ in }

    private weak var table: UITableView?
    private let pan = UIPanGestureRecognizer()
    private var moving: (key: String, view: UIView)?
    private var armed = false
    private let badge = UIView()
    private let arrow = UIImageView()

    init(table: UITableView) {
        self.table = table
        super.init()
        pan.addTarget(self, action: #selector(panned(_:)))
        pan.delegate = self
        table.addGestureRecognizer(pan)
        // The list scrolls only once a swipe has been ruled out (that is decided at the very first move).
        table.panGestureRecognizer.require(toFail: pan)
        badge.frame = CGRect(x: 0, y: 0, width: 32, height: 32)
        badge.layer.cornerRadius = 16
        badge.isUserInteractionEnabled = false
        arrow.image = UIImage(systemName: "arrowshape.turn.up.left.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold))
        arrow.contentMode = .center
        arrow.frame = badge.bounds
        badge.addSubview(arrow)
        badge.alpha = 0
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pan, let table else { return false }
        let speed = pan.velocity(in: table)
        // A leftward move that is more sideways than up or down (the reference: activeOffsetX -10, failOffsetY ±28).
        guard speed.x < 0, abs(speed.x) > abs(speed.y) * 1.2 else { return false }
        guard let found = rowAt(pan.location(in: table)), canReply(found.key) else { return false }
        return true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        return false
    }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        guard let table else { return }
        switch recognizer.state {
        case .began:
            armed = false
            moving = rowAt(recognizer.location(in: table))
            if let host = moving?.view.superview {
                badge.backgroundColor = Theme.accent.withAlphaComponent(0.16)
                arrow.tintColor = Theme.accent
                host.addSubview(badge)
            }
        case .changed:
            guard let moving else { return }
            let value = min(0, max(-96, recognizer.translation(in: table).x * 0.85))
            moving.view.transform = CGAffineTransform(translationX: value, y: 0)
            place(value)
            if value <= -60 && !armed {
                armed = true
                Haptic.light()
            } else if value > -60 && armed {
                armed = false
            }
        case .ended, .cancelled, .failed:
            let fire = recognizer.state == .ended && armed
            let key = moving?.key
            let view = moving?.view
            moving = nil
            armed = false
            UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction], animations: {
                view?.transform = .identity
                self.badge.alpha = 0
            }, completion: { (_: Bool) -> Void in
                if self.moving == nil { self.badge.removeFromSuperview() }
            })
            if fire, let key { onReply(key) }
        default:
            break
        }
    }

    /// The round arrow at the row's right (4 points from the edge, in the middle of the row above its 8-point
    /// gap): it grows from 0.6 and comes in between 12 and 60 points of the move.
    private func place(_ value: CGFloat) {
        guard let host = badge.superview else { return }
        let share = min(1, max(0, (-value - 12) / 48))
        badge.alpha = share
        let scale = 0.6 + 0.4 * share
        badge.transform = CGAffineTransform(scaleX: scale, y: scale)
        badge.center = CGPoint(x: host.bounds.width - 4 - 16, y: max(16, (host.bounds.height - 8) / 2))
    }
}

/// New messages slide in (the reference's MessageRow.tsx `entering={fresh ? FadeInDown.duration(220) : …}`, a
/// round video only fades in, 150 ms). Only a message or two arriving live: the first rows of a chat, a page of
/// history and anything that came in a batch of more than three are simply there. A message of one's own that
/// replaces its own row «on its way out» is not new and does not slide in twice.
final class MsgArrivals {
    private var seen: Set<String>?
    private var fresh = Set<String>()

    /// The rows now, newest first, with whether each is one's own and its kind of media.
    func take(_ rows: [MsgRow]) {
        let keys = rows.map { $0.key }
        guard var known = seen else {
            if !keys.isEmpty { seen = Set(keys) }
            return
        }
        let unseen = rows.filter { !known.contains($0.key) }
        if unseen.count > 3 {
            known.formUnion(keys)
            seen = known
            return
        }
        // Rows on their way out (attachments, voice and videos being sent) that are gone now became messages.
        let current = Set(keys)
        let landed = known.contains { (key: String) -> Bool in
            (key.hasPrefix("attach-") || key.hasPrefix("media-")) && !current.contains(key)
        }
        for row in unseen {
            known.insert(row.key)
            if row.kind != 0 { continue }
            if row.mine && landed && !(row.key.hasPrefix("attach-") || row.key.hasPrefix("media-")) { continue }
            fresh.insert(row.key)
        }
        // A row that has gone is forgotten, so the set does not keep growing with every pending row.
        known = known.filter { (key: String) -> Bool in current.contains(key) || !(key.hasPrefix("attach-") || key.hasPrefix("media-")) }
        seen = known
    }

    /// Called as a row comes on screen: a fresh one slides in; any other is put straight.
    func play(_ view: UIView, key: String, note: Bool) {
        guard fresh.remove(key) != nil, !UIAccessibility.isReduceMotionEnabled else {
            if view.alpha != 1 || view.transform != .identity {
                view.layer.removeAllAnimations()
                view.alpha = 1
                view.transform = .identity
            }
            return
        }
        view.alpha = 0
        // FadeInDown: from 25 points above, opacity 0 → 1.
        view.transform = note ? .identity : CGAffineTransform(translationX: 0, y: -25)
        UIView.animate(withDuration: note ? 0.15 : 0.22, delay: 0, options: [.curveEaseInOut, .allowUserInteraction], animations: {
            view.alpha = 1
            view.transform = .identity
        })
    }
}
