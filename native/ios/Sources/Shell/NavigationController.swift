import UIKit

/// A pushed screen that wants its first content on screen before it slides in (the reference's `useStackReady`):
/// the slide waits until `stackReady` is true, at most `StackAnimator.readyWait`.
protocol StackReadyWaiting: AnyObject {
    var stackReady: Bool { get }
}

/// A screen whose own sideways drags must not be taken by the swipe back (a cropper, a drawing).
protocol StackSwipeBlocking: AnyObject {
    var blocksSwipeBack: Bool { get }
}

/// A pushed screen that keeps the bar of the sections at its bottom, as the previous app does on the pages of a
/// section (a page of the settings, a community, a channel, a room). A chat and the full-screen pages do not: the
/// bar stands over a pushed screen only while every screen above the sections keeps it.
protocol KeepsTabBar: AnyObject {}

/// The stack of screens (the reference's stack.tsx): no system bar on top (every screen draws its own header).
/// - A pushed screen slides in over the one below, which moves a little to the left and dims (220 ms in, 240 ms
///   out, the reference's curves); the slide waits for the screen's first content (at most 80 ms).
/// - A swipe to the right ANYWHERE on a pushed screen drags it away (it takes over once the finger has moved right
///   and mostly sideways, 2:1); released past a third of the width or flicked faster than 700 pt/s, it leaves.
/// - Held past a third for 600 ms, «Отпусти — в чаты» appears: letting go then goes straight to «Чаты».
/// - In a section of the bar other than «Чаты», with nothing pushed, a swipe from the left edge (32 pt) goes to
///   «Чаты», a round mark coming out under the finger (the reference's `HomeSwipe`).
final class NavigationController: UINavigationController, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
    private static let homeEdge: CGFloat = 32
    private static let longHold: TimeInterval = 0.6

    private let backPan = UIPanGestureRecognizer()
    private var interaction: UIPercentDrivenInteractiveTransition?
    /// "back": a pushed screen follows the finger; "home": the section's swipe to «Чаты».
    private var mode = ""
    private var canHome = false
    private var farArmed = false
    private var longReady = false
    private var longTimer: Timer?
    private var homeAfterCancel = false
    private let homeWords = HomePillView(words: true)
    private let homeMark = HomePillView(words: false)

    override func viewDidLoad() {
        super.viewDidLoad()
        setNavigationBarHidden(true, animated: false)
        view.backgroundColor = Theme.bg
        delegate = self
        MotionBlur.install() // MotionBlur: the app's sheets smeared as they slide, below 90 Hz (Effects/MotionBlur.swift)
        // The swipe below does what the system's edge swipe did, from anywhere on the screen.
        interactivePopGestureRecognizer?.isEnabled = false
        backPan.addTarget(self, action: #selector(panned(_:)))
        backPan.delegate = self
        backPan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(backPan)
        for pill in [homeWords, homeMark] {
            pill.alpha = 0
            pill.isUserInteractionEnabled = false
            view.addSubview(pill)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        root?.placeLentBar(in: view) // the bar over a pushed page that keeps it
        view.bringSubviewToFront(homeWords)
        view.bringSubviewToFront(homeMark)
        let wordsSize = homeWords.fittingSize()
        homeWords.bounds = CGRect(origin: .zero, size: wordsSize)
        homeWords.center = CGPoint(x: 14 + wordsSize.width / 2, y: view.bounds.height * 0.46 + 22)
        homeMark.bounds = CGRect(x: 0, y: 0, width: 44, height: 44)
        homeMark.center = CGPoint(x: 22, y: view.bounds.height * 0.46 + 22)
    }

    // MARK: The slide

    func navigationController(_ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation,
                              from fromVC: UIViewController, to toVC: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        guard operation == .push || operation == .pop else { return nil }
        return StackAnimator(pushing: operation == .push, interactive: interaction != nil)
    }

    func navigationController(_ navigationController: UINavigationController, interactionControllerFor animationController: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        return interaction
    }

    // MARK: The bar over pushed pages

    /// How many screens the stack had when it last came to rest.
    private var shownCount = 1

    /// Whether the bar of the sections stands over this pushed screen: it and every screen under it, down to the
    /// sections, keep the bar.
    func barKept(over page: UIViewController?) -> Bool {
        guard let page, let at = viewControllers.firstIndex(of: page), at > 0 else { return false }
        for index in 1...at where !(viewControllers[index] is KeepsTabBar) { return false }
        return true
    }

    /// The room a pushed screen leaves at its bottom for the bar that stands over it (the bar, its gap to the
    /// screen's edge and 9 above it); 0 when the bar is not there.
    func barRoom(over page: UIViewController?) -> CGFloat {
        guard barKept(over: page) else { return 0 }
        return BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 9
    }

    /// The bar goes over the stack for a screen that keeps it, and back into the sections' own screen otherwise.
    private func settleBar(for top: UIViewController) {
        guard let root else { return }
        if barKept(over: top) { root.lendBar(to: view) } else { root.takeBarBack() }
    }

    func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
        // A screen coming in slides under the bar it keeps (a screen that does not keep it covers the bar at once).
        // On the way back the bar is settled when the slide is over: a screen dragged away and let go again must
        // not be left with a bar it does not keep.
        let pushing = viewControllers.count > shownCount
        if pushing || !animated { settleBar(for: viewController) }
    }

    func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
        shownCount = viewControllers.count
        settleBar(for: viewController)
    }

    // MARK: The swipe

    private var root: RootViewController? { viewControllers.first as? RootViewController }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === backPan, transitionCoordinator == nil, presentedViewController == nil else { return false }
        let moved = backPan.translation(in: view)
        let speed = backPan.velocity(in: view)
        // Right and mostly sideways (the reference: dx > 10 and dx > 2·dy); a vertical move scrolls instead.
        let sideways = moved.x > 0 ? moved.x > abs(moved.y) * 2 : speed.x > abs(speed.y) * 2
        guard sideways, speed.x >= 0 || moved.x > 0 else { return false }
        let start = CGPoint(x: backPan.location(in: view).x - moved.x, y: backPan.location(in: view).y - moved.y)
        if viewControllers.count > 1 {
            if let top = topViewController as? StackSwipeBlocking, top.blocksSwipeBack { return false }
            if blocked(at: start) { return false }
            mode = "back"
            return true
        }
        // A section other than «Чаты» with nothing pushed: from the left edge only (it must not take sideways
        // shelves and the text cursor).
        if let root, root.open != "chats", start.x <= NavigationController.homeEdge {
            mode = "home"
            return true
        }
        return false
    }

    /// Something under the finger moves sideways itself: a slider, a switch, or a strip scrolled away from its start.
    private func blocked(at point: CGPoint) -> Bool {
        var found = view.hitTest(point, with: nil)
        while let current = found, current !== view {
            if current is UISlider || current is UISwitch { return true }
            if let scroll = current as? UIScrollView, !(scroll is UITextView) {
                let wide = scroll.contentSize.width > scroll.bounds.width + 1
                if wide && scroll.isScrollEnabled && scroll.contentOffset.x > -scroll.adjustedContentInset.left + 1 { return true }
            }
            found = current.superview
        }
        return false
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        if mode == "home" { homePanned(recognizer); return }
        let width = max(1, view.bounds.width)
        let moved = recognizer.translation(in: view).x
        let progress = min(1, max(0, moved / width))
        switch recognizer.state {
        case .began:
            let made = UIPercentDrivenInteractiveTransition()
            made.completionCurve = .easeOut
            interaction = made
            homeAfterCancel = false
            canHome = root != nil && (viewControllers.count > 2 || root?.open != "chats")
            farArmed = false
            longReady = false
            popViewController(animated: true)
            transitionCoordinator?.animate(alongsideTransition: nil, completion: { [weak self] (context: UIViewControllerTransitionCoordinatorContext) -> Void in
                guard let self else { return }
                self.interaction = nil
                if context.isCancelled && self.homeAfterCancel {
                    self.homeAfterCancel = false
                    self.goHome()
                }
            })
        case .changed:
            interaction?.update(progress)
            // MotionBlur: both screens follow the finger; each frame of the drag keeps their smear watched.
            MotionBlur.kick(transitionCoordinator?.view(forKey: .from))
            MotionBlur.kick(transitionCoordinator?.view(forKey: .to))
            guard canHome else { return }
            let far = moved > width * 0.33
            if far && !farArmed {
                farArmed = true
                longTimer?.invalidate()
                longTimer = Timer.scheduledTimer(withTimeInterval: NavigationController.longHold, repeats: false) { [weak self] (_: Timer) -> Void in
                    self?.showLong(true)
                }
            } else if !far && farArmed {
                farArmed = false
                longTimer?.invalidate()
                longTimer = nil
                showLong(false)
            }
        case .ended, .cancelled, .failed:
            longTimer?.invalidate()
            longTimer = nil
            guard let interaction else { return }
            let straightHome = longReady && recognizer.state == .ended
            showLong(false)
            farArmed = false
            if straightHome {
                // Straight to «Чаты»: this screen is not closed one step back as well; the stack goes at once.
                view.endEditing(true)
                homeAfterCancel = true
                interaction.completionSpeed = 4
                interaction.cancel()
                return
            }
            let leave = recognizer.state == .ended && (moved > width * 0.33 || recognizer.velocity(in: view).x > 700)
            if leave {
                // The keyboard leaves together with the screen, as soon as leaving is decided.
                view.endEditing(true)
                Haptic.light()
                let rest = max(0.001, 1 - progress)
                let wanted = max(0.09, 0.22 * rest)
                interaction.completionSpeed = max(0.05, CGFloat(StackAnimator.closeTime) * rest / CGFloat(wanted))
                interaction.finish()
            } else {
                let wanted = 0.2
                interaction.completionSpeed = max(0.05, CGFloat(StackAnimator.closeTime) * max(0.001, progress) / CGFloat(wanted))
                interaction.cancel()
            }
        default:
            break
        }
    }

    /// «Отпусти — в чаты»: comes (140 ms, with a light knock) or goes (100 ms).
    private func showLong(_ on: Bool) {
        if on == longReady && (on ? homeWords.alpha > 0.9 : homeWords.alpha < 0.1) { return }
        longReady = on
        if on { Haptic.light() }
        view.setNeedsLayout()
        view.layoutIfNeeded()
        homeWords.transform = on ? CGAffineTransform(scaleX: 0.9, y: 0.9) : .identity
        UIView.animate(withDuration: on ? 0.14 : 0.1, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: {
            self.homeWords.alpha = on ? 1 : 0
            self.homeWords.transform = on ? .identity : CGAffineTransform(scaleX: 0.9, y: 0.9)
        })
    }

    /// The whole stack goes and «Чаты» comes, with a short fade.
    func goHome() {
        view.endEditing(true)
        let fade = CATransition()
        fade.type = .fade
        fade.duration = 0.2
        view.layer.add(fade, forKey: "home")
        popToRootViewController(animated: false)
        root?.show("chats")
    }

    private func homePanned(_ recognizer: UIPanGestureRecognizer) {
        let pull = max(0, recognizer.translation(in: view).x)
        switch recognizer.state {
        case .began, .changed:
            let k = min(1, pull / 80)
            homeMark.alpha = k
            let scale = 0.7 + k * 0.3
            homeMark.transform = CGAffineTransform(translationX: -52 + min(pull, 110) * 0.62, y: 0).scaledBy(x: scale, y: scale)
        case .ended, .cancelled, .failed:
            if recognizer.state == .ended && (pull > 80 || recognizer.velocity(in: view).x > 700) {
                view.endEditing(true)
                Haptic.light()
                root?.show("chats")
            }
            UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: {
                self.homeMark.alpha = 0
                self.homeMark.transform = CGAffineTransform(translationX: -52, y: 0).scaledBy(x: 0.7, y: 0.7)
            })
        default:
            break
        }
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: «Отпусти — в чаты» or the section's round mark, held on screen.
    func showSwipeMarks(long: Bool) {
        if long {
            longReady = false
            showLong(true)
        } else {
            homeMark.alpha = 1
            homeMark.transform = CGAffineTransform(translationX: -52 + 110 * 0.62, y: 0)
        }
    }

    /// For the simulator check: the top screen held part way off, as under a finger.
    func holdSwipe(at fraction: CGFloat) {
        guard viewControllers.count > 1 else { return }
        let made = UIPercentDrivenInteractiveTransition()
        interaction = made
        popViewController(animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { made.update(fraction) }
    }
    #endif
}

/// The slide of the stack: the reference's OPEN (220 ms, bezier .2 .9 .25 1) and CLOSE (240 ms, bezier .3 .1 .3 1);
/// the screen below moves 28 % of the width to the left and is dimmed up to .38; a soft shadow at the top screen's
/// left edge (opacity .35 while open).
final class StackAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    static let openTime: TimeInterval = 0.22
    static let closeTime: TimeInterval = 0.24
    /// How long a screen that asked to be waited for may keep the slide from starting (the reference: 80 ms).
    static let readyWait: TimeInterval = 0.08

    private let pushing: Bool
    private let interactive: Bool
    private var animator: UIViewPropertyAnimator?

    init(pushing: Bool, interactive: Bool) {
        self.pushing = pushing
        self.interactive = interactive
        super.init()
    }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval {
        return pushing ? StackAnimator.openTime : StackAnimator.closeTime
    }

    func animateTransition(using transitionContext: UIViewControllerContextTransitioning) {
        let made = interruptibleAnimator(using: transitionContext)
        guard pushing, let waiting = transitionContext.viewController(forKey: .to) as? StackReadyWaiting, !waiting.stackReady else {
            made.startAnimation()
            return
        }
        // The screen's first content first (its rows built while it slid were what dropped frames).
        let started = Date()
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { (clock: Timer) -> Void in
            if waiting.stackReady || Date().timeIntervalSince(started) >= StackAnimator.readyWait {
                clock.invalidate()
                made.startAnimation()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    func interruptibleAnimator(using transitionContext: UIViewControllerContextTransitioning) -> UIViewImplicitlyAnimating {
        if let animator { return animator }
        let container = transitionContext.containerView
        let width = container.bounds.width
        let fromView = transitionContext.view(forKey: .from) ?? transitionContext.viewController(forKey: .from)?.view
        let toView = transitionContext.view(forKey: .to) ?? transitionContext.viewController(forKey: .to)?.view
        if let toVC = transitionContext.viewController(forKey: .to), let toView { toView.frame = transitionContext.finalFrame(for: toVC) }
        let dim = UIView(frame: container.bounds)
        dim.backgroundColor = .black
        dim.isUserInteractionEnabled = false
        let shadow = UIView(frame: container.bounds)
        shadow.isUserInteractionEnabled = false
        shadow.backgroundColor = .clear
        shadow.layer.shadowColor = UIColor.black.cgColor
        shadow.layer.shadowOpacity = 0.5
        shadow.layer.shadowRadius = 12
        shadow.layer.shadowOffset = CGSize(width: -2, height: 0)
        shadow.layer.shadowPath = UIBezierPath(rect: CGRect(x: 0, y: 0, width: 18, height: container.bounds.height)).cgPath
        let top: UIView? = pushing ? toView : fromView
        let below: UIView? = pushing ? fromView : toView
        if let below, below.superview == nil { container.addSubview(below) }
        if let below { container.bringSubviewToFront(below) }
        container.addSubview(dim)
        container.addSubview(shadow)
        if let top { container.addSubview(top) }
        let open = CGAffineTransform.identity
        let closed = CGAffineTransform(translationX: width, y: 0)
        let aside = CGAffineTransform(translationX: -width * 0.28, y: 0)
        top?.transform = pushing ? closed : open
        shadow.transform = pushing ? closed : open
        // MotionBlur: the sliding screen and the one moving aside under it, smeared by their speed below 90 Hz.
        MotionBlur.kick(top, fresh: true)
        MotionBlur.kick(below, fresh: true)
        shadow.alpha = pushing ? 0 : 0.35
        below?.transform = pushing ? open : aside
        dim.alpha = pushing ? 0 : 0.38
        let timing: UICubicTimingParameters
        if interactive {
            timing = UICubicTimingParameters(animationCurve: .linear)
        } else if pushing {
            timing = UICubicTimingParameters(controlPoint1: CGPoint(x: 0.2, y: 0.9), controlPoint2: CGPoint(x: 0.25, y: 1))
        } else {
            timing = UICubicTimingParameters(controlPoint1: CGPoint(x: 0.3, y: 0.1), controlPoint2: CGPoint(x: 0.3, y: 1))
        }
        let duration = UIAccessibility.isReduceMotionEnabled && !interactive ? 0.01 : transitionDuration(using: transitionContext)
        let made = UIViewPropertyAnimator(duration: duration, timingParameters: timing)
        let isPush = pushing
        made.addAnimations {
            top?.transform = isPush ? open : closed
            shadow.transform = isPush ? open : closed
            shadow.alpha = isPush ? 0.35 : 0
            below?.transform = isPush ? aside : open
            dim.alpha = isPush ? 0.38 : 0
        }
        made.addCompletion { (_: UIViewAnimatingPosition) -> Void in
            top?.transform = .identity
            below?.transform = .identity
            dim.removeFromSuperview()
            shadow.removeFromSuperview()
            transitionContext.completeTransition(!transitionContext.transitionWasCancelled)
        }
        animator = made
        return made
    }
}

/// The mark of «to the chat list» (the reference's `HomePill`): a round chat icon on the text colour, with the words
/// «Отпусти — в чаты» when the gesture needs telling.
final class HomePillView: UIView {
    private let icon = UIImageView()
    private let label = UILabel()
    private let words: Bool

    init(words: Bool) {
        self.words = words
        super.init(frame: .zero)
        backgroundColor = Theme.text
        layer.cornerRadius = 22
        let ink: UIColor = Theme.dark ? .black : .white
        icon.image = UIImage(systemName: "bubble.left.and.bubble.right.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
        icon.tintColor = ink
        icon.contentMode = .center
        addSubview(icon)
        label.text = words ? "Отпусти — в чаты" : ""
        label.font = Theme.font(14, .bold)
        label.textColor = ink
        label.isHidden = !words
        addSubview(label)
    }

    required init?(coder: NSCoder) { return nil }

    func fittingSize() -> CGSize {
        guard words else { return CGSize(width: 44, height: 44) }
        let text = ceil(label.sizeThatFits(CGSize(width: 400, height: 44)).width)
        return CGSize(width: 14 + 22 + 8 + text + 14, height: 44)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if words {
            icon.frame = CGRect(x: 14, y: 0, width: 22, height: bounds.height)
            label.frame = CGRect(x: 44, y: 0, width: max(0, bounds.width - 44 - 14), height: bounds.height)
        } else {
            icon.frame = bounds
        }
    }
}

/// The chat waits for its first page before it slides in (the reference's ChatScreen with `waitReady`).
extension ChatViewController: StackReadyWaiting {
    var stackReady: Bool { actions.history.loadedOnce }
}
