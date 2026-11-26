#if targetEnvironment(simulator)
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// The simulator's notes for a touch that seems lost (the comparison of .github/workflows/native-compare.yml reads
/// them from the log; nothing of this is in a build for a phone):
///   Linea: main thread stalled 430 ms            the main queue did not answer for that long (asked ten times a second)
///   Linea: touch down 201,682 on ChatRowCanvas (in ChatRowCell), read 12 ms late
///   Linea: touch up 201,300 after 704 ms, moved 382, read 9 ms late
///   Linea: touch cancelled 201,682 after 450 ms, moved 0, read 440 ms late
///   Linea: app active / app not active / app in background
/// «read … late» is the time between the finger's event and the app reading it. The view is named by its class
/// only; nothing that is on the screen is written.
enum SimulatorWatch {
    private static var started = false
    private static let queue = DispatchQueue(label: "invizent.simulator-watch")
    private static var clock: DispatchSourceTimer?
    /// Read and written on `queue` only: a question to the main queue is still unanswered.
    private static var asked = false

    static func start(_ window: UIWindow) {
        guard !started else { return }
        started = true
        window.addGestureRecognizer(SimulatorTouchLog(target: nil, action: nil))
        let centre = NotificationCenter.default
        _ = centre.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { (_: Notification) -> Void in
            NSLog("Linea: app active")
        }
        _ = centre.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { (_: Notification) -> Void in
            NSLog("Linea: app not active")
        }
        _ = centre.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { (_: Notification) -> Void in
            NSLog("Linea: app in background")
        }
        let made = DispatchSource.makeTimerSource(queue: queue)
        made.schedule(deadline: .now() + 1, repeating: 0.1)
        made.setEventHandler {
            if asked { return }
            asked = true
            let from = CACurrentMediaTime()
            DispatchQueue.main.async {
                let took = (CACurrentMediaTime() - from) * 1000
                if took > 250 { NSLog("Linea: main thread stalled %.0f ms", took) }
                queue.async { asked = false }
            }
        }
        made.resume()
        clock = made
    }
}

/// Watches the touches of the window and never takes part in gesture arbitration (as the observers of
/// Effects/TrailEngine.swift and Effects/SnowEngine.swift): it stays .possible while fingers are down and fails
/// when the last one lifts. Only the first finger is written down.
final class SimulatorTouchLog: UIGestureRecognizer, UIGestureRecognizerDelegate {
    private weak var lead: UITouch?
    private var downAt: TimeInterval = 0
    private var downPlace = CGPoint.zero

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        requiresExclusiveTouchType = false
        delegate = self
    }

    private static func late(_ touch: UITouch) -> Double {
        return max(0, (ProcessInfo.processInfo.systemUptime - touch.timestamp) * 1000)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard lead == nil, let first = touches.first else { return }
        lead = first
        downAt = first.timestamp
        downPlace = first.location(in: view)
        var hit = "no view"
        if let under = first.view {
            hit = String(describing: type(of: under))
            if let holder = under.superview { hit += " (in " + String(describing: type(of: holder)) + ")" }
        }
        NSLog("Linea: touch down %.0f,%.0f on %@, read %.0f ms late", Double(downPlace.x), Double(downPlace.y), hit, SimulatorTouchLog.late(first))
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        lifted(touches, word: "up")
        finishIfDone(event)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        lifted(touches, word: "cancelled")
        finishIfDone(event)
    }

    private func lifted(_ touches: Set<UITouch>, word: String) {
        guard let finger = lead, touches.contains(finger) else { return }
        lead = nil
        let place = finger.location(in: view)
        let moved = Double(hypot(place.x - downPlace.x, place.y - downPlace.y))
        NSLog("Linea: touch %@ %.0f,%.0f after %.0f ms, moved %.0f, read %.0f ms late", word, Double(place.x), Double(place.y),
              (finger.timestamp - downAt) * 1000, moved, SimulatorTouchLog.late(finger))
    }

    override func reset() {
        super.reset()
        lead = nil
    }

    private func finishIfDone(_ event: UIEvent) {
        let down = event.allTouches?.contains(where: { $0.phase != .ended && $0.phase != .cancelled }) ?? false
        if !down {
            lead = nil
            if state == .possible { state = .failed }
        }
    }

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool { false }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool { false }
}
#endif
