import UIKit
import Metal

/// The first-launch intro over the sign-in screen: once per install, at a start with no session, in a window of its
/// own just above the app's (the sign-in screen stays untouched under it). The person goes through its four steps by
/// swiping up — there is no skip; when the fourth is complete the sign-in screen comes out of the blur the scene has
/// melted into (a blur over it clears while the intro fades) and the overlay is gone. Only then is the intro marked
/// seen.
/// With VoiceOver running there is no intro at all: straight to the sign-in screen, marked seen. With Reduce Motion
/// (or the app's «Анимации» off, Effects/Motion.swift), or where the phone cannot draw the scene, four calm still
/// stages instead of the flights.
/// While the app is not active nothing moves, nothing is drawn and nothing is felt; it goes on from the same place
/// when the app is back, and in a new window too. Android: intro/IntroOverlay.kt.
final class IntroOverlay: NSObject {
    static let shared = IntroOverlay()

    /// The one-time flag, in the app's defaults as the other one-time flags (ChatsPlus/BarHint.swift).
    static let seenKey = "linea.intro.seen.v1"

    private var window: UIWindow?
    private var view: IntroView?
    private var veil: UIVisualEffectView?
    private var haptics: IntroHaptics?
    private var ending = false
    private var observers: [NSObjectProtocol] = []
    /// The person's way through the intro, kept until it is finished: a new window goes on from the same place.
    private var kept: IntroFlow?

    static var seen: Bool { return UserDefaults.standard.bool(forKey: seenKey) }
    static func markSeen() { UserDefaults.standard.set(true, forKey: seenKey) }

    /// The phone can draw the scene (it has a graphics chip Metal speaks to).
    static var canDrawScene: Bool { return MTLCreateSystemDefaultDevice() != nil }

    /// How the intro is shown at this start (IntroModel.mode with this phone's answers). A start with VoiceOver
    /// running marks the intro seen without showing it.
    static func mode(hasSession: Bool) -> IntroModel.Mode {
        let before = IntroOverlay.seen
        let reader = UIAccessibility.isVoiceOverRunning
        if IntroModel.seenWithoutShowing(seen: before, hasSession: hasSession, screenReader: reader) { markSeen() }
        let motion = !UIAccessibility.isReduceMotionEnabled && Motion.enabled
        return IntroModel.mode(seen: before, hasSession: hasSession, motionAllowed: motion, screenReader: reader, canDrawScene: canDrawScene)
    }

    /// Called by the start with no session (SceneDelegate.start), right after the sign-in screen is set.
    func firstStart(over main: UIWindow?) {
        guard let main else { return }
        let mode = IntroOverlay.mode(hasSession: false)
        if mode == .none {
            kept = nil
            return
        }
        let flow = kept ?? IntroFlow(stills: mode == .stills)
        if mode == .stills { flow.toStills() }
        kept = flow
        show(over: main, flow: flow, real: true)
    }

    /// The simulator check: the intro frozen at the ident's time `t` over the sign-in screen, no haptics, the seen flag
    /// untouched (`-intro hold 2.9`).
    func hold(over main: UIWindow?, at t: Double) {
        guard let main else { return }
        let flow = IntroFlow(stills: false)
        flow.freeze(time: t, progress: 0)
        show(over: main, flow: flow, real: false)
    }

    /// The same, frozen at a progress through the steps, 0…4 (`-intro step 1.5`); `stills` — the still stages
    /// (`-intro still 2`).
    func step(over main: UIWindow?, at p: Double, stills: Bool = false) {
        guard let main else { return }
        let flow = IntroFlow(stills: stills)
        flow.freeze(time: IntroModel.identEnd, progress: p)
        show(over: main, flow: flow, real: false)
    }

    private func show(over main: UIWindow, flow: IntroFlow, real: Bool) {
        close()
        let made: UIWindow
        if let scene = main.windowScene { made = UIWindow(windowScene: scene) } else { made = UIWindow(frame: main.bounds) }
        // Above the app's window, below the code lock's (Security/LockGate.swift: alert + 1).
        made.windowLevel = UIWindow.Level.normal + 1
        made.backgroundColor = .clear
        made.overrideUserInterfaceStyle = .dark
        let controller = IntroViewController()
        made.rootViewController = controller
        // The blur the sign-in screen comes out of: nothing until the end.
        let blur = UIVisualEffectView(effect: nil)
        blur.frame = controller.view.bounds
        blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        blur.isUserInteractionEnabled = false
        blur.isHidden = true
        controller.view.addSubview(blur)
        let intro = IntroView(frame: controller.view.bounds, flow: flow)
        intro.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        controller.view.addSubview(intro)
        made.isHidden = false
        window = made
        view = intro
        veil = blur
        ending = false

        if real {
            let touch = IntroHaptics()
            touch.prepare()
            haptics = touch
            intro.onEvents = { [weak self] (events: Int) -> Void in
                if events & IntroFlow.swell != 0 { touch.swell() }
                if events & IntroFlow.pass != 0 { touch.tick() }
                if events & IntroFlow.finishedBit != 0 { self?.finish() }
            }
        }
        // Nothing moves and nothing is drawn unless the app is active.
        let centre = NotificationCenter.default
        let away = { [weak self] (_: Notification) -> Void in self?.wentAway() }
        let back = { [weak self] (_: Notification) -> Void in self?.cameBack() }
        observers.append(centre.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main, using: away))
        observers.append(centre.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main, using: back))
        observers.append(centre.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main, using: away))
        observers.append(centre.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main, using: back))
        if real {
            // VoiceOver turned on mid-intro: the swipes are no longer the intro's, so it ends at once.
            observers.append(centre.addObserver(forName: UIAccessibility.voiceOverStatusDidChangeNotification, object: nil, queue: .main) { [weak self] (_: Notification) -> Void in
                if UIAccessibility.isVoiceOverRunning { self?.finish() }
            })
        }

        intro.step(0)
        if main.windowScene?.activationState == .foregroundActive || UIApplication.shared.applicationState == .active { intro.play() }
        // A kept way that was already complete (the window was lost during the hand-over): straight on.
        if real && flow.finished { finish() }
    }

    /// The fourth step is complete: the intro is seen; the sign-in screen comes out of the blur and the overlay goes.
    private func finish() {
        if ending { return }
        ending = true
        IntroOverlay.markSeen()
        kept = nil
        guard let intro = view, let shown = window else {
            close()
            return
        }
        intro.onEvents = nil
        shown.isUserInteractionEnabled = false
        let blur = veil
        if let blur, !UIAccessibility.isReduceTransparencyEnabled {
            blur.effect = UIBlurEffect(style: .dark)
            blur.isHidden = false
        }
        UIView.animate(withDuration: IntroModel.handover, delay: 0, options: [.curveEaseInOut], animations: { () -> Void in
            intro.alpha = 0
            blur?.effect = nil
        }, completion: { [weak self, weak shown] (_: Bool) -> Void in
            // Only if this window is still the intro's (a newer one is not closed by an older ending).
            guard let self, let shown, self.window === shown else { return }
            self.close()
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        })
    }

    /// Gone at once (the intro is over, or another is shown): the haptics stop, the graphics are given back. An
    /// unfinished way through the intro is kept for the next window.
    func close() {
        haptics?.stop()
        haptics = nil
        for one in observers { NotificationCenter.default.removeObserver(one) }
        observers = []
        view?.letGo()
        view = nil
        veil = nil
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
        ending = false
    }

    /// The app is not active mid-intro: it waits (nothing moves, nothing is drawn, nothing is felt).
    func wentAway() {
        haptics?.stop()
        view?.pause()
    }

    /// The app is active again: the intro goes on from where it was.
    func cameBack() {
        if window != nil { view?.play() }
    }
}

/// The intro's window holds nothing else: a plain controller with the status bar light. The first swipe up from the
/// bottom edge is the intro's, not the system's.
private final class IntroViewController: UIViewController {
    override func loadView() {
        let plain = UIView()
        plain.backgroundColor = .clear
        view = plain
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { return .lightContent }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { return .bottom }
}
