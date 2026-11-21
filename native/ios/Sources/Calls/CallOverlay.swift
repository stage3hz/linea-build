import UIKit

/// The window calls are shown in, above the app's own: the call screen, or — while the call is minimised — its
/// bar. A touch that lands on neither goes through to the app underneath.
private final class CallWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        if hit === self || hit === rootViewController?.view { return nil }
        return hit
    }
}

private final class CallHostController: UIViewController {
    let bar = CallBarView()
    var callScreen: CallScreenView?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        bar.isHidden = true
        view.addSubview(bar)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Below the status bar with a gap: the clock, the island and the battery stay visible above it.
        let gap = CallBarView.gap
        bar.frame = CGRect(x: gap, y: view.safeAreaInsets.top + gap, width: max(0, view.bounds.width - gap * 2), height: CGFloat(CallRules.barHeight))
        if let callScreen, callScreen.transform.isIdentity { callScreen.frame = view.bounds }
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
}

/// The active-call bar while the call is minimised (the reference's `CallBanner`): a rounded strip a little below
/// the status bar — the name and the status in the middle, a tap opens the call, the round button on the right ends
/// it. Green while the call is up, orange while it reconnects or waits, blue before it connects.
final class CallBarView: UIControl {
    /// The space between the bar and the status bar above it, and the screen's edges at its sides.
    static let gap: CGFloat = 8
    /// What the app's screens give up at the top while the bar is shown: the gap, the bar and the gap under it.
    static var room: CGFloat { return gap + CGFloat(CallRules.barHeight) + gap }
    private let words = UILabel()
    private let end = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 14
        layer.cornerCurve = .continuous
        words.textAlignment = .center
        words.lineBreakMode = .byTruncatingMiddle
        addSubview(words)
        end.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold)), for: .normal)
        end.tintColor = .white
        end.backgroundColor = UIColor(hex: 0xFF3B30)
        end.layer.cornerRadius = 13
        end.accessibilityLabel = "Завершить звонок"
        end.addTarget(self, action: #selector(endTapped), for: .touchUpInside)
        addSubview(end)
        addTarget(self, action: #selector(opened), for: .touchUpInside)
        isAccessibilityElement = false
        words.isAccessibilityElement = true
        words.accessibilityTraits = .button
        words.accessibilityHint = "Вернуться к звонку"
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        words.frame = CGRect(x: 46, y: 0, width: max(0, bounds.width - 92), height: bounds.height)
        end.frame = CGRect(x: bounds.width - 8 - 26, y: (bounds.height - 26) / 2, width: 26, height: 26)
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.85 : 1 }
    }

    func show(_ call: CallState) {
        let status = CallRules.status(call, network: Calls.shared.signalNetwork)
        switch status.tone {
        case "active": backgroundColor = UIColor(hex: 0x2BA36B)
        case "trouble": backgroundColor = UIColor(hex: 0xD9822B)
        case "pending": backgroundColor = UIColor(hex: 0x3B6FB6)
        default: backgroundColor = UIColor(hex: 0x6B7280)
        }
        let plain: [NSAttributedString.Key: Any] = [.font: UIFont.monospacedDigitSystemFont(ofSize: 14, weight: .regular), .foregroundColor: UIColor.white]
        let strong: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 14, weight: .semibold), .foregroundColor: UIColor.white]
        let faint: [NSAttributedString.Key: Any] = [.font: UIFont.monospacedDigitSystemFont(ofSize: 14, weight: .regular), .foregroundColor: UIColor(white: 1, alpha: 0.85)]
        let line = NSMutableAttributedString()
        if let symbol = UIImage(systemName: call.video ? "video.fill" : "phone.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))?.withTintColor(.white, renderingMode: .alwaysOriginal) {
            let picture = NSTextAttachment()
            picture.image = symbol
            line.append(NSAttributedString(attachment: picture))
            line.append(NSAttributedString(string: "  ", attributes: plain))
        }
        line.append(NSAttributedString(string: call.peer.displayName, attributes: strong))
        line.append(NSAttributedString(string: " · ", attributes: faint))
        line.append(NSAttributedString(string: status.text, attributes: plain))
        if let clock = status.clock { line.append(NSAttributedString(string: " " + clock, attributes: faint)) }
        words.attributedText = line
        words.accessibilityLabel = call.peer.displayName + ", " + status.text + (status.clock.map { " " + $0 } ?? "")
        end.isHidden = call.isOver
    }

    @objc private func opened() { Calls.shared.restore() }
    @objc private func endTapped() { Calls.shared.hangup() }
}

/// Puts the call on the screen and takes it off: the call screen while it is open, the bar while it is minimised
/// (every screen of the app then moves down by the bar's height, so nothing hides under it), nothing when there is
/// no call. Main queue.
final class CallOverlay {
    static let shared = CallOverlay()
    private var window: CallWindow?
    private let host = CallHostController()
    private var watching = false
    private var clock: Timer?

    private init() {}

    /// The account whose calls are shown (nil: the simulator's shell without one).
    func start(_ messenger: Messenger?) {
        if !watching {
            watching = true
            NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: Calls.changed, object: nil)
        }
        Calls.shared.start(messenger)
    }

    private var appWindow: UIWindow? {
        for scene in UIApplication.shared.connectedScenes {
            guard let scene = scene as? UIWindowScene else { continue }
            for window in scene.windows where !(window is CallWindow) && window.rootViewController != nil { return window }
        }
        return nil
    }

    private func makeWindow() -> CallWindow? {
        if let window { return window }
        guard let scene = appWindow?.windowScene else { return nil }
        let made = CallWindow(windowScene: scene)
        made.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 1)
        made.backgroundColor = .clear
        made.overrideUserInterfaceStyle = .dark
        made.rootViewController = host
        made.isHidden = false
        window = made
        return made
    }

    /// The app's screens start lower while the bar is shown.
    private func setBarRoom(_ on: Bool) {
        let room: CGFloat = on ? CallBarView.room : 0
        guard let root = appWindow?.rootViewController, root.additionalSafeAreaInsets.top != room else { return }
        root.additionalSafeAreaInsets.top = room
        UIView.animate(withDuration: 0.25) { root.view.layoutIfNeeded() }
    }

    @objc private func refresh() {
        guard let call = Calls.shared.call else {
            clock?.invalidate()
            clock = nil
            setBarRoom(false)
            host.bar.isHidden = true
            dismissScreen { [weak self] in
                // Nothing left to show: the window goes, so it is in nobody's way.
                guard let self, Calls.shared.call == nil else { return }
                self.window?.isHidden = true
                self.window = nil
            }
            return
        }
        guard makeWindow() != nil else { return }
        host.loadViewIfNeeded()
        if call.minimized {
            dismissScreen(nil)
            host.bar.show(call)
            host.bar.isHidden = false
            setBarRoom(true)
            // The bar's clock and status follow the call by themselves.
            if clock == nil {
                clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] (_: Timer) -> Void in
                    guard let self, let now = Calls.shared.call, now.minimized else { return }
                    self.host.bar.show(now)
                }
            }
            return
        }
        clock?.invalidate()
        clock = nil
        host.bar.isHidden = true
        setBarRoom(false)
        presentScreen().update(call)
    }

    private func presentScreen() -> CallScreenView {
        if let screen = host.callScreen { return screen }
        let screen = CallScreenView(frame: host.view.bounds)
        host.callScreen = screen
        host.view.addSubview(screen)
        // Slides up from the bottom, as the reference's call screen does.
        screen.transform = CGAffineTransform(translationX: 0, y: host.view.bounds.height)
        UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseOut], animations: { screen.transform = .identity }, completion: nil)
        return screen
    }

    private func dismissScreen(_ done: (() -> Void)?) {
        guard let screen = host.callScreen else { done?(); return }
        host.callScreen = nil
        let away = CGAffineTransform(translationX: 0, y: host.view.bounds.height)
        UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .curveEaseIn], animations: { screen.transform = away }, completion: { (_: Bool) -> Void in
            screen.retire()
            screen.removeFromSuperview()
            done?()
        })
    }
}

/// Where a call is placed from: the chat's header and a person's profile.
enum CallEntry {
    /// «Позвонить» (`video`: «Видеозвонок») to the person of a chat. Without an account — the simulator's sample.
    static func call(messenger: Messenger?, chatId: String, peerId: String, name: String, person: Person? = nil, video: Bool) {
        guard messenger != nil else {
            #if targetEnvironment(simulator)
            Calls.shared.showDemo("outgoing")
            #endif
            return
        }
        let peer = person ?? Person(id: peerId, username: "", displayName: name, bio: "", birthday: "", avatarColor: 0x5E7BFF, avatarId: "")
        Calls.shared.place(chatId: chatId, peer: peer, video: video)
    }

    /// The button of a chat's header: a touch rings the person, a long touch offers «Позвонить» and «Видеозвонок»
    /// (the reference keeps the second one in the header's menu).
    static func headerButton(messenger: Messenger?, chatId: String, peerId: String, name: String) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: "phone", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular)), for: .normal)
        button.tintColor = Theme.muted
        button.accessibilityLabel = "Позвонить"
        let audio = UIAction(title: "Позвонить", image: UIImage(systemName: "phone")) { [weak messenger] (_: UIAction) -> Void in
            CallEntry.call(messenger: messenger, chatId: chatId, peerId: peerId, name: name, video: false)
        }
        let video = UIAction(title: "Видеозвонок", image: UIImage(systemName: "video")) { [weak messenger] (_: UIAction) -> Void in
            CallEntry.call(messenger: messenger, chatId: chatId, peerId: peerId, name: name, video: true)
        }
        button.addAction(UIAction { [weak messenger] (_: UIAction) -> Void in
            CallEntry.call(messenger: messenger, chatId: chatId, peerId: peerId, name: name, video: false)
        }, for: .touchUpInside)
        button.menu = UIMenu(title: "", children: [audio, video])
        return button
    }
}

#if targetEnvironment(simulator)
/// What the simulator check asks of calls by launch arguments (see SceneDelegate.simulatorStart):
///   -calldemo outgoing    no account: the call screen of a call being placed — «Вызов…» under the name, the ring
///                         pulsing around the picture, «Динамик», «Видео», «Убрать звук», «Завершить»
///   -calldemo incoming    «Входящий звонок» with «Отклонить» and «Ответить»
///   -calldemo active      a running audio call: the key emoji at the top, the clock (from 0:42) under the name
///   -calldemo video       a running video call: the other side's picture over the whole screen and this phone's
///                         own in the small frame (both drawn — the simulator films nothing), «Повернуть» among the buttons
///   -calldemo ended       «Звонок завершён», no buttons
///   -calldemo retry       «Нет соединения» with «Закрыть» and «Повторить»
///   -calldemo bar         the same running call minimised: the green bar under the status bar over the chats
///   -call 1               with an account: opens the first chat and presses «Позвонить» (a real outgoing call to
///                         the local test server; the microphone has to be allowed for the app beforehand)
extension SceneDelegate {
    func simulatorCalls() -> Bool {
        guard let state = UserDefaults.standard.string(forKey: "calldemo") else { return false }
        window?.rootViewController = NavigationController(rootViewController: RootViewController())
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { Calls.shared.showDemo(state) }
        return true
    }

    func simulatorCallWithAccount() {
        guard UserDefaults.standard.bool(forKey: "call") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let stack = self?.window?.rootViewController as? NavigationController, let root = stack.viewControllers.first as? RootViewController else { return }
            PeopleSimulator.openFirstChat(stack: stack, root: root, tries: 20) { (chat: ChatViewController) -> Void in
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { chat.callButton.sendActions(for: .touchUpInside) }
            }
        }
    }
}
#endif
