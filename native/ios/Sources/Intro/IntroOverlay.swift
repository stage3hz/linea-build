import UIKit

/// The first-launch intro over the sign-in screen: once per install, at a start with no session, in a window of its
/// own just above the app's (the sign-in screen stays untouched under it, and nothing the app lays over its screens —
/// the snow — comes above it). At the end it fades out (0.35 s) and the sign-in screen is there; a tap anywhere skips
/// it at once and the haptics stop. Never with Reduce Motion (or the app's «Анимации» off,
/// Effects/Motion.swift): the sign-in screen is shown directly. For VoiceOver it is one element, «Инвиз», gone by
/// itself at the end. Android: intro/IntroOverlay.kt.
final class IntroOverlay: NSObject {
    static let shared = IntroOverlay()

    /// The one-time flag, in the app's defaults as the other one-time flags (ChatsPlus/BarHint.swift).
    static let seenKey = "linea.intro.seen.v1"

    private var window: UIWindow?
    private var view: IntroView?
    private let haptics = IntroHaptics()
    private var ending = false
    private var away: NSObjectProtocol?

    static var seen: Bool { return UserDefaults.standard.bool(forKey: seenKey) }
    static func markSeen() { UserDefaults.standard.set(true, forKey: seenKey) }

    /// Whether the intro plays at this start (IntroModel.shouldPlay with this phone's answers).
    static func wanted(hasSession: Bool) -> Bool {
        let motion = !UIAccessibility.isReduceMotionEnabled && Motion.enabled
        return IntroModel.shouldPlay(seen: seen, hasSession: hasSession, motionAllowed: motion)
    }

    /// Called by the start with no session (SceneDelegate.start), right after the sign-in screen is set.
    func firstStart(over main: UIWindow?) {
        guard IntroOverlay.wanted(hasSession: false), let main else { return }
        IntroOverlay.markSeen()
        show(over: main, hold: nil)
    }

    /// The simulator check: the intro frozen at `t` over the sign-in screen, no haptics (`-intro hold 2.9`).
    func hold(over main: UIWindow?, at t: Double) {
        guard let main else { return }
        show(over: main, hold: Swift.max(0, Swift.min(IntroModel.duration, t)))
    }

    private func show(over main: UIWindow, hold: Double?) {
        close()
        let made: UIWindow
        if let scene = main.windowScene { made = UIWindow(windowScene: scene) } else { made = UIWindow(frame: main.bounds) }
        // Above the app's window, below the code lock's (Security/LockGate.swift: alert + 1).
        made.windowLevel = UIWindow.Level.normal + 1
        made.backgroundColor = .clear
        made.overrideUserInterfaceStyle = .dark
        let controller = IntroViewController()
        made.rootViewController = controller
        let intro = IntroView(frame: made.bounds)
        intro.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        controller.view.addSubview(intro)
        made.isHidden = false
        window = made
        view = intro
        ending = false
        if let hold {
            intro.hold(hold)
            return
        }
        controller.view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        intro.onActivate = { [weak self] in self?.skip() }
        intro.onTime = { [weak self] (t: Double) -> Void in
            if t >= IntroModel.duration { self?.end() }
        }
        intro.play()
        haptics.start(begin: intro.started)
        away = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] (_: Notification) -> Void in
            self?.wentAway()
        }
        UIAccessibility.post(notification: .screenChanged, argument: intro)
    }

    @objc private func tapped() { skip() }

    /// A tap: the haptics stop, the overlay fades out now.
    func skip() { end() }

    private func end() {
        guard !ending else { return }
        ending = true
        haptics.stop()
        guard let intro = view else { return close() }
        intro.stop()
        window?.isUserInteractionEnabled = false
        UIView.animate(withDuration: IntroModel.fade, delay: 0, options: [.curveEaseOut], animations: { () -> Void in
            intro.alpha = 0
        }, completion: { [weak self] (_: Bool) -> Void in
            self?.close()
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        })
    }

    /// Gone at once.
    func close() {
        haptics.stop()
        if let away { NotificationCenter.default.removeObserver(away) }
        away = nil
        view?.stop()
        view = nil
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
        ending = false
    }

    /// The app went to the background mid-intro: it is over (no haptics while away).
    func wentAway() { if window != nil { close() } }
}

/// The intro's window holds nothing else: a plain controller with the status bar light.
private final class IntroViewController: UIViewController {
    override func loadView() {
        let plain = UIView()
        plain.backgroundColor = .clear
        view = plain
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { return .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { return true }
}
