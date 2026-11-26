import UIKit
import ObjectiveC

/// Motion blur for screens slower than 90 Hz (Android: effects/MotionBlur.kt, the same numbers).
///
/// On a 60 Hz panel a page that slides 3000 pt/s jumps 50 pt between two frames; a little smear along the motion
/// hides the steps and the slide reads smoother. A watched view is smeared along the way it moves, by its own measured
/// speed: nothing below `dead` pt/s, a smooth rise (smoothstep) to the strongest at `full` pt/s, and gone the very
/// frame it stops. A screen that gives 120 Hz gets nothing (a ProMotion screen held at 60 Hz is a slow one: `slowScreen`);
/// nothing either in the low power mode, in power saving, with
/// animations off («Энергосбережение и анимации») or with «Уменьшение движения».
///
/// How (there is no public directional blur of a live view, and a CoreImage blur every frame would cost the frames it
/// is meant to save): when the view starts to move, it is copied once with `snapshotView(afterScreenUpdates: false)`
/// (a reference to what the GPU already drew, no CPU drawing), twice, and the two copies sit inside the view, one
/// behind and one ahead along the motion, at ± `maxSpread`·strength and alpha ½ and ⅓ (three equal taps: a shutter
/// smear). Each frame only their centres and alphas change; at rest they are hidden at once and taken away a moment
/// later. A display link runs only while the view is kicked (a gesture, an animation, a scroll) and stops itself
/// `linger` s after the last kick. Cost: no work at all on 120 Hz; on 60 Hz one presentation-layer conversion per
/// frame while moving, two snapshots per motion, and two extra translucent layers for the GPU to blend.
enum MotionBlur {
    /// Below this speed (pt/s) nothing is smeared: a slow drag stays crisp.
    static let dead: CGFloat = 250
    /// At and above this speed (pt/s) the smear is at its strongest.
    static let full: CGFloat = 3500
    /// The copies sit this far behind and ahead of the view at the strongest, pt.
    static let maxSpread: CGFloat = 5
    /// How long a view is still watched after its last kick, s (a released swipe's settling animation included).
    static let linger: CFTimeInterval = 0.6

    /// 0…1 from the speed in pt/s: zero up to `dead`, a smoothstep up to `full`.
    static func strength(_ speed: CGFloat) -> CGFloat {
        let t = max(0, min(1, (speed - dead) / (full - dead)))
        return t * t * (3 - 2 * t)
    }

    #if targetEnvironment(simulator)
    /// The simulator check: `-motionblur 1` on whatever the screen and the power, `0` off, `hold` on and the strongest
    /// smear kept on a view once it has moved (a still shot mid-slide, e.g. with `-shelldemo swipe`).
    static let forced: Bool? = {
        guard let word = UserDefaults.standard.string(forKey: "motionblur"), !word.isEmpty else { return nil }
        return word != "0"
    }()
    static let hold: Bool = UserDefaults.standard.string(forKey: "motionblur") == "hold"
    #else
    static let forced: Bool? = nil
    static let hold = false
    #endif

    /// The screen's fastest rate is below 90 Hz by its make (every iPhone without ProMotion).
    private static let slowByMake: Bool = UIScreen.main.maximumFramesPerSecond < 90

    /// The screen gives fewer than 90 frames a second now. By its make, or — a ProMotion screen — because it is held
    /// at 60 Hz («Ограничение частоты кадров» in the system's settings): the system does not say so, so the rate is
    /// measured (`MotionBlurRate`). Until the first measure, the make decides.
    static var slowScreen: Bool { return MotionBlurRate.shared.slow ?? slowByMake }

    /// May the effect ever run on this device. Every screen may turn slow (see `slowScreen`), so the watchers are
    /// attached everywhere; on a fast screen they do nothing (`allowed`).
    static var possible: Bool { return forced ?? true }

    /// May a view be smeared right now.
    static var allowed: Bool {
        if let forced { return forced }
        guard slowScreen else { return false }
        let power = Motion.power
        return Motion.enabled && !Motion.saving && !power.lowPower && !power.reduceMotion
    }

    private static var trackerKey: UInt8 = 0
    private static var installed = false

    /// The watcher of `view`, made once (nil on 120 Hz screens).
    @discardableResult
    static func attach(_ view: UIView) -> MotionBlurTracker? {
        guard possible else { return nil }
        if let found = objc_getAssociatedObject(view, &trackerKey) as? MotionBlurTracker { return found }
        let made = MotionBlurTracker(view: view)
        objc_setAssociatedObject(view, &trackerKey, made, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return made
    }

    /// `view` moves under this pan (and settles after it): every step of the pan kicks the watcher.
    static func attach(_ view: UIView, following pan: UIPanGestureRecognizer) {
        attach(view)?.follow(pan)
    }

    /// `view` moves when this scroll view scrolls (a pager's page): every change of its offset kicks the watcher.
    static func attach(_ view: UIView, kickedBy scroll: UIScrollView) {
        attach(view)?.observe(scroll)
    }

    /// `view` is about to move by an animation. `fresh`: its content has just changed, copy it again.
    static func kick(_ view: UIView?, fresh: Bool = false) {
        guard let view else { return }
        attach(view)?.kick(fresh: fresh)
    }

    // MARK: Sheets

    /// The app's sheets (UISheetPresentationController) are smeared as they slide in, out and under the finger,
    /// without a line in each of them: UIViewController's `viewWillAppear` / `viewWillDisappear` are passed through
    /// here once (only on screens below 90 Hz).
    static func install() {
        guard !installed, possible else { return }
        installed = true
        MotionBlurRate.shared.start()
        swap(#selector(UIViewController.viewWillAppear(_:)), #selector(UIViewController.motionBlur_viewWillAppear(_:)))
        swap(#selector(UIViewController.viewWillDisappear(_:)), #selector(UIViewController.motionBlur_viewWillDisappear(_:)))
    }

    private static func swap(_ original: Selector, _ replacement: Selector) {
        let type: AnyClass = UIViewController.self
        guard let first = class_getInstanceMethod(type, original), let second = class_getInstanceMethod(type, replacement) else { return }
        method_exchangeImplementations(first, second)
    }

    /// A sheet of the app's own starts to come or go.
    static func sheetMoves(_ screen: UIViewController, animated: Bool) {
        guard animated, screen.isBeingPresented || screen.isBeingDismissed else { return }
        guard screen.presentationController is UISheetPresentationController else { return }
        // Only the app's own screens (a system screen's views are not ours to put copies in).
        let own: (UIViewController) -> Bool = { (item: UIViewController) -> Bool in Bundle(for: type(of: item)) == Bundle.main }
        let holder = screen as? UINavigationController
        guard own(screen) || (holder?.viewControllers.first.map(own) ?? false) else { return }
        guard let view = screen.viewIfLoaded, let tracker = attach(view) else { return }
        tracker.followDrags()
        tracker.kick(fresh: true)
    }
}

extension UIViewController {
    // After `MotionBlur.install()` these stand in place of UIKit's (and UIKit's own are called through them).
    @objc dynamic func motionBlur_viewWillAppear(_ animated: Bool) {
        motionBlur_viewWillAppear(animated)
        MotionBlur.sheetMoves(self, animated: animated)
    }

    @objc dynamic func motionBlur_viewWillDisappear(_ animated: Bool) {
        motionBlur_viewWillDisappear(animated)
        MotionBlur.sheetMoves(self, animated: animated)
    }
}

/// Watches one view while it is kicked and smears it by its speed (see `MotionBlur`).
final class MotionBlurTracker: NSObject, UIGestureRecognizerDelegate {
    private weak var view: UIView?
    private weak var pan: UIPanGestureRecognizer?
    private var dragWatch: UIPanGestureRecognizer?
    private var observation: NSKeyValueObservation?
    private var link: CADisplayLink?
    private var last: CGPoint?
    private var lastTime: CFTimeInterval = 0
    private var kickedAt: CFTimeInterval = 0
    /// pt/s, smoothed over two frames.
    private var speed = CGVector.zero
    private var ghosts: [UIView] = []
    /// The view's bounds centre when it was copied (the copies stay with the content of a scroll view).
    private var ghostCentre = CGPoint.zero
    /// Frames to wait before copying the view (it must have been drawn where it is); nil = not asked.
    private var copyIn: Int?
    private var held = false
    /// The simulator check `hold`: the way the view last moved.
    private var holdWay: CGVector?

    init(view: UIView) {
        self.view = view
        super.init()
    }

    deinit {
        link?.invalidate()
        observation?.invalidate()
        pan?.removeTarget(self, action: nil)
        for ghost in ghosts { ghost.removeFromSuperview() }
    }

    func follow(_ recognizer: UIPanGestureRecognizer) {
        guard pan !== recognizer else { return }
        pan?.removeTarget(self, action: nil)
        pan = recognizer
        recognizer.addTarget(self, action: #selector(panned(_:)))
    }

    func observe(_ scroll: UIScrollView) {
        observation?.invalidate()
        observation = scroll.observe(\.contentOffset, options: []) { [weak self] (_: UIScrollView, _: NSKeyValueObservedChange<CGPoint>) -> Void in
            self?.kick(fresh: false)
        }
    }

    /// A sheet: its drags (by the grabber or by the content) kick the watcher too. The watching pan never takes a
    /// touch from anything: it recognises together with every other gesture and cancels nothing.
    func followDrags() {
        guard dragWatch == nil, let view else { return }
        let watch = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        watch.cancelsTouchesInView = false
        watch.delaysTouchesBegan = false
        watch.delaysTouchesEnded = false
        watch.delegate = self
        view.addGestureRecognizer(watch)
        dragWatch = watch
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        switch recognizer.state {
        case .ended, .cancelled, .failed:
            // What settles after a swipe often shows new content (a folder, a tab): copy it again.
            kick(fresh: true)
        default:
            kick(fresh: false)
        }
    }

    func kick(fresh: Bool) {
        // A hidden view (the archive block between pulls) is not watched: an ordinary scroll costs nothing.
        guard let view, !view.isHidden, view.alpha > 0.01, !held else { return }
        guard MotionBlur.allowed else { stop(); return }
        kickedAt = CACurrentMediaTime()
        if fresh {
            dropGhosts()
            copyIn = nil
        }
        guard link == nil else { return }
        last = nil
        let made = CADisplayLink(target: self, selector: #selector(frame(_:)))
        made.add(to: .main, forMode: .common)
        link = made
    }

    @objc private func frame(_ clock: CADisplayLink) {
        guard let view, view.window != nil else { stop(); return }
        let now = clock.timestamp
        let layer: CALayer = view.layer.presentation() ?? view.layer
        // Where the view's content origin is in the window: its own and its parents' moves and scrolls, animated
        // ones included.
        let spot = layer.convert(CGPoint.zero, to: nil)
        let before = last
        let elapsed = now - lastTime
        last = spot
        lastTime = now
        guard let before, elapsed > 0, elapsed < 0.1 else { return }
        let dx = spot.x - before.x
        let dy = spot.y - before.y
        let size = view.bounds.size
        let jump = abs(dx) > size.width * 0.75 || abs(dy) > size.height * 0.75
        if (dx == 0 && dy == 0) || jump || view.isHidden || !MotionBlur.allowed {
            // Still: no smear from this very frame (the simulator check `hold` keeps trying for its shot).
            speed = .zero
            if MotionBlur.hold, let way = holdWay, !jump { show(view, strength: 1, way: way); return }
            for ghost in ghosts { ghost.alpha = 0 }
            if now - kickedAt > MotionBlur.linger { stop() }
            return
        }
        let dt = CGFloat(elapsed)
        speed = CGVector(dx: speed.dx * 0.5 + dx / dt * 0.5, dy: speed.dy * 0.5 + dy / dt * 0.5)
        let magnitude = hypot(speed.dx, speed.dy)
        let strength = MotionBlur.hold ? 1 : MotionBlur.strength(magnitude)
        guard strength > 0.01, magnitude > 0 else {
            for ghost in ghosts { ghost.alpha = 0 }
            return
        }
        let way = CGVector(dx: speed.dx / magnitude, dy: speed.dy / magnitude)
        if MotionBlur.hold { holdWay = way }
        show(view, strength: strength, way: way)
    }

    /// The copies `strength` (0…1) apart along `way` (a unit vector), made first if they are not there yet.
    private func show(_ view: UIView, strength: CGFloat, way: CGVector) {
        guard prepareGhosts(view) else { return }
        let spread = MotionBlur.maxSpread * strength
        let weights: [CGFloat] = [0.5, 1.0 / 3.0]
        let fade = min(1, strength * 3)
        for (index, ghost) in ghosts.enumerated() {
            let sign: CGFloat = index == 0 ? -1 : 1
            ghost.center = CGPoint(x: ghostCentre.x + way.dx * spread * sign, y: ghostCentre.y + way.dy * spread * sign)
            ghost.alpha = weights[index] * fade
            if view.subviews.last !== ghosts.last { view.bringSubviewToFront(ghost) }
        }
        if MotionBlur.hold {
            // The simulator check: the strongest smear stays for the shot.
            held = true
            link?.invalidate()
            link = nil
        }
    }

    /// The two copies are there (true), or will be made on a later frame.
    private func prepareGhosts(_ view: UIView) -> Bool {
        if !ghosts.isEmpty { return true }
        guard let wait = copyIn else { copyIn = 1; return false }
        if wait > 0 { copyIn = wait - 1; return false }
        copyIn = nil
        var made: [UIView] = []
        for _ in 0..<2 {
            guard let copy = view.snapshotView(afterScreenUpdates: false) else { break }
            copy.frame = view.bounds
            copy.isUserInteractionEnabled = false
            copy.accessibilityElementsHidden = true
            copy.alpha = 0
            made.append(copy)
        }
        guard made.count == 2 else { return false }
        for copy in made { view.addSubview(copy) }
        ghosts = made
        ghostCentre = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        return true
    }

    private func dropGhosts() {
        for ghost in ghosts { ghost.removeFromSuperview() }
        ghosts = []
    }

    private func stop() {
        link?.invalidate()
        link = nil
        last = nil
        speed = .zero
        copyIn = nil
        if !held { dropGhosts() }
    }
}

/// The rate the screen really gives: a display link asks for the fastest there is and a few frames are timed. Measured
/// at the start, each time the app comes back (the system's switch may have been changed meanwhile) and when the
/// power mode changes. (A display link may go above 60 Hz on an iPhone only with
/// `CADisableMinimumFrameDurationOnPhone` in Info.plist — project.yml.)
final class MotionBlurRate: NSObject {
    static let shared = MotionBlurRate()

    /// Fewer than 90 frames a second; nil until measured.
    private(set) var slow: Bool?
    private var link: CADisplayLink?
    private var frames = 0
    private var shortest: CFTimeInterval = 1
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        let centre = NotificationCenter.default
        centre.addObserver(self, selector: #selector(measure), name: UIApplication.didBecomeActiveNotification, object: nil)
        centre.addObserver(self, selector: #selector(measure), name: NSNotification.Name.NSProcessInfoPowerStateDidChange, object: nil)
        measure()
    }

    @objc private func measure() {
        // The power mode's notice may come on another thread.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.link == nil else { return }
            if UIScreen.main.maximumFramesPerSecond < 90 {
                self.slow = true
                return
            }
            self.frames = 0
            self.shortest = 1
            let made = CADisplayLink(target: self, selector: #selector(self.frame(_:)))
            made.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
            made.add(to: .main, forMode: .common)
            self.link = made
        }
    }

    @objc private func frame(_ link: CADisplayLink) {
        frames += 1
        // The first frames after a link starts may come at the old rate.
        if frames > 4 { shortest = min(shortest, link.targetTimestamp - link.timestamp) }
        guard frames >= 24 else { return }
        link.invalidate()
        self.link = nil
        slow = shortest > 1.0 / 90
    }
}
