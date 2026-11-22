import UIKit

/// The lock over the whole app («Код-пароль»): a window of its own above every screen and every presented sheet,
/// shown on start when a code is set, on return after the autolock delay, or at once on leaving with «Сразу».
/// Nothing under it is touchable until the right code (or Face ID / Touch ID) opens it. While the app is not
/// active (the app switcher) an opaque cover hides it. (The previous app: `mobile/src/lock/LockGate.tsx`.)
final class LockGate: NSObject {
    static let shared = LockGate()

    private var window: UIWindow?
    private weak var mainWindow: UIWindow?
    private(set) var locked = false
    private var covered = false
    private var unreadable = false
    private var wasBackground = false
    private var grace: Timer?

    /// True while the lock (or the cover that stands in for it) is up.
    var isUp: Bool { return window?.isHidden == false }

    /// Called once with the app's window (SceneDelegate): reads the settings and locks when a code is set.
    func attach(_ main: UIWindow) {
        mainWindow = main
        let centre = NotificationCenter.default
        centre.addObserver(self, selector: #selector(resigned), name: UIApplication.willResignActiveNotification, object: nil)
        centre.addObserver(self, selector: #selector(backgrounded), name: UIApplication.didEnterBackgroundNotification, object: nil)
        centre.addObserver(self, selector: #selector(activated), name: UIApplication.didBecomeActiveNotification, object: nil)
        load()
    }

    private func load() {
        do {
            try LockStore.shared.load()
            unreadable = false
            if LockRules.shouldLockOnLaunch(LockStore.shared.current, now: LockRules.nowMs()) {
                lock()
            } else {
                show()
            }
        } catch {
            // A read error must never open the app: an opaque cover with «Повторить».
            unreadable = true
            show()
        }
    }

    /// Locks the app now; nothing happens when no code is set.
    func lock() {
        guard LockStore.shared.current.record != nil else { return }
        if locked { show(); return }
        locked = true
        // Locked is also what is saved: a kill-and-relaunch inside the autolock delay must not skip the code.
        LockStore.shared.update { (settings: inout LockSettings) -> Void in settings.backgroundAt = nil }
        show()
    }

    func unlock() {
        locked = false
        LockStore.shared.recordSuccess()
        show()
    }

    // MARK: The app's moments

    @objc private func resigned() {
        leave(background: false)
    }

    @objc private func backgrounded() {
        wasBackground = true
        leave(background: true)
    }

    private func leave(background: Bool) {
        let settings = LockStore.shared.current
        let action = LockRules.onLeave(settings, locked: locked, background: background)
        if action.cover { covered = true; show() }
        if action.recordBackgroundAt {
            let now = LockRules.nowMs()
            LockStore.shared.update { (next: inout LockSettings) -> Void in next.backgroundAt = now }
        }
        if action.lock == "now" {
            grace?.invalidate()
            grace = nil
            lock()
        } else if action.lock == "soon" && grace == nil {
            // «Сразу» on a mere inactive (Face ID sheet, Control Centre): a short grace first.
            grace = Timer.scheduledTimer(withTimeInterval: LockRules.inactiveGraceSeconds, repeats: false) { [weak self] (_: Timer) -> Void in
                self?.grace = nil
                self?.lock()
            }
        }
    }

    @objc private func activated() {
        grace?.invalidate()
        grace = nil
        covered = false
        let settings = LockStore.shared.current
        if !locked && LockRules.shouldLockOnReturn(settings, wasBackground: wasBackground, now: LockRules.nowMs()) {
            wasBackground = false
            lock()
            return
        }
        wasBackground = false
        show()
        if locked, let screen = window?.rootViewController as? LockViewController { screen.offerBiometrics() }
    }

    // MARK: The window

    private func show() {
        let enabled = LockStore.shared.current.record != nil
        let lockShown = enabled && locked
        let coverShown = unreadable || (enabled && covered && !locked)
        guard lockShown || coverShown else {
            if let window, !window.isHidden {
                window.isHidden = true
                mainWindow?.makeKey()
            }
            return
        }
        let shown = ensureWindow()
        if lockShown {
            if !(shown.rootViewController is LockViewController) {
                let screen = LockViewController()
                screen.onUnlock = { [weak self] in self?.unlock() }
                shown.rootViewController = screen
            }
        } else if let cover = shown.rootViewController as? LockCoverViewController {
            cover.setRetry(unreadable)
        } else {
            let cover = LockCoverViewController()
            cover.setRetry(unreadable)
            cover.onRetry = { [weak self] in self?.load() }
            shown.rootViewController = cover
        }
        if shown.isHidden {
            shown.isHidden = false
            shown.makeKeyAndVisible()
        }
    }

    private func ensureWindow() -> UIWindow {
        if let window { return window }
        var made: UIWindow
        if let scene = mainWindow?.windowScene {
            made = UIWindow(windowScene: scene)
        } else {
            made = UIWindow(frame: UIScreen.main.bounds)
        }
        made.windowLevel = UIWindow.Level.alert + 1
        made.backgroundColor = Theme.bg
        made.overrideUserInterfaceStyle = Theme.dark ? .dark : .light
        made.isHidden = true
        window = made
        return made
    }
}

/// The opaque stand-in: in the app switcher, or when the settings could not be read.
final class LockCoverViewController: UIViewController {
    var onRetry: (() -> Void)?
    private let words = UILabel()
    private let again = SettingsButton(label: "Повторить", kind: .primary, icon: "refresh-outline")
    private var retrying = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        let logo = UIImageView(image: UIImage(named: "IconPreviewBlue"))
        logo.layer.cornerRadius = 15
        logo.layer.masksToBounds = true
        logo.translatesAutoresizingMaskIntoConstraints = false
        logo.widthAnchor.constraint(equalToConstant: 64).isActive = true
        logo.heightAnchor.constraint(equalToConstant: 64).isActive = true
        words.text = "Не удалось прочитать настройки код-пароля"
        words.font = .systemFont(ofSize: 16)
        words.textColor = Theme.text
        words.textAlignment = .center
        words.numberOfLines = 0
        again.onPress = { [weak self] in self?.onRetry?() }
        let column = UIStackView(arrangedSubviews: [logo, words, again])
        column.axis = .vertical
        column.alignment = .center
        column.spacing = 18
        column.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(column)
        NSLayoutConstraint.activate([
            column.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            column.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            column.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
        ])
        setRetry(retrying)
    }

    func setRetry(_ on: Bool) {
        retrying = on
        guard isViewLoaded else { return }
        words.isHidden = !on
        again.isHidden = !on
    }
}

/// The lock screen: the logo, «ИНВИЗ», and the code entry with Face ID / Touch ID when it is on.
final class LockViewController: UIViewController {
    var onUnlock: (() -> Void)?
    /// The simulator check: the kind of a sample code (nothing is read or kept).
    var sampleKind: String?
    private var entry: CodeEntryView?
    private var wrong = false
    private var checking = false
    private var prompting = false
    private var ticker: Timer?
    private var bioLabel: String?

    deinit { ticker?.invalidate() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        let record = LockStore.shared.current.record
        let kind = sampleKind ?? record?.kind ?? "digits"
        let logo = UIImageView(image: UIImage(named: "IconPreviewBlue"))
        logo.layer.cornerRadius = 15
        logo.layer.masksToBounds = true
        logo.translatesAutoresizingMaskIntoConstraints = false
        logo.widthAnchor.constraint(equalToConstant: 64).isActive = true
        logo.heightAnchor.constraint(equalToConstant: 64).isActive = true
        let name = UILabel()
        name.attributedText = NSAttributedString(string: "ИНВИЗ", attributes: [.kern: 1.6, .font: UIFont.systemFont(ofSize: 13, weight: .bold), .foregroundColor: Theme.muted])
        let head = UIStackView(arrangedSubviews: [logo, name])
        head.axis = .vertical
        head.alignment = .center
        head.spacing = 14
        let made = CodeEntryView(kind: kind)
        made.onSubmit = { [weak self] (code: String) -> Void in self?.submit(code) }
        entry = made
        let column = UIStackView(arrangedSubviews: [head, made])
        column.axis = .vertical
        column.alignment = .center
        column.spacing = 28
        column.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.bounces = false
        scroll.keyboardDismissMode = .interactive
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(column)
        let middle = column.centerYAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerYAnchor)
        middle.priority = .defaultLow
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            column.centerXAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerXAnchor),
            middle,
            column.topAnchor.constraint(greaterThanOrEqualTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            column.bottomAnchor.constraint(lessThanOrEqualTo: scroll.contentLayoutGuide.bottomAnchor, constant: -28),
            column.widthAnchor.constraint(lessThanOrEqualTo: scroll.frameLayoutGuide.widthAnchor, constant: -32),
            scroll.contentLayoutGuide.heightAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.heightAnchor),
            scroll.contentLayoutGuide.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
        ])
        if LockStore.shared.current.biometrics, let label = LockBiometrics.label() {
            bioLabel = label
            made.biometric = (symbol: label == "Face ID" ? "ion:scan-outline" : "ion:finger-print-outline", label: label, press: { [weak self] in self?.tryBiometrics() })
        }
        refreshWords()
        ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] (_: Timer) -> Void in self?.refreshWords() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        entry?.focus()
        offerBiometrics()
    }

    /// Face ID / Touch ID is offered straight away when it is on and the app is active.
    func offerBiometrics() {
        guard bioLabel != nil, UIApplication.shared.applicationState == .active else { return }
        tryBiometrics()
    }

    private func tryBiometrics() {
        guard !prompting else { return }
        prompting = true
        LockBiometrics.authenticate { [weak self] (success: Bool) -> Void in
            guard let self else { return }
            self.prompting = false
            if success {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                self.onUnlock?()
            }
        }
    }

    private func refreshWords() {
        guard let entry else { return }
        let wait = LockStore.shared.waitMs
        let digits = entry.kind == "digits"
        let hint = wait > 0 ? LockRules.retryHint(wait) : (digits ? "Введи код-пароль, чтобы открыть Инвиз" : "Введи пароль, чтобы открыть Инвиз")
        entry.setTitle(digits ? "Введи код-пароль" : "Введи пароль", hint: hint, error: wrong && wait <= 0 ? "Неверный код-пароль" : "")
        entry.disabled = checking || wait > 0
    }

    #if targetEnvironment(simulator)
    /// The simulator check: a wrong code was typed (the shake and the red line); nothing is kept.
    func simulatorWrong() {
        wrong = true
        entry?.shake()
        refreshWords()
    }
    #endif

    private func submit(_ code: String) {
        guard !checking, LockStore.shared.waitMs <= 0 else { return }
        checking = true
        refreshWords()
        LockStore.shared.check(code) { [weak self] (right: Bool) -> Void in
            guard let self else { return }
            self.checking = false
            if right {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                self.onUnlock?()
                return
            }
            self.wrong = true
            LockStore.shared.recordFailure()
            self.entry?.shake()
            self.refreshWords()
        }
    }
}
