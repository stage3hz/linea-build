import UIKit

/// Whether the signed-in account has an active Platina, as the server says (`GET /me/username`, the reference's
/// platina/usePlatina.ts): shared by every screen, asked when a screen needs it at most once a minute, and set by
/// screens that know better. The last state seen on this phone is kept per account, so a grant is noticed whether it
/// happens while the app is open or between launches — the confetti and «Платина активирована» then (the first time
/// an account is seen nothing is celebrated: it may have had Platina for long). Main thread only.
final class PlatinaState {
    static let shared = PlatinaState()
    /// Posted on the main queue when `active` or the status changed.
    static let changed = Notification.Name("invizent.platina")

    private(set) weak var messenger: Messenger?
    private(set) var owner = ""
    private(set) var active = false
    /// The server's whole answer (`UsernameStatus`): the emoji choices, the expiry…
    private(set) var status: [String: Any] = [:]
    private var checkedAt = Date.distantPast
    private var loading = false
    private weak var host: UIViewController?

    /// The account whose Platina this is; another account starts from nothing. `host`: where the confetti shows.
    func start(_ messenger: Messenger?, host: UIViewController? = nil) {
        if let host { self.host = host }
        guard let messenger else { return }
        if self.messenger !== messenger {
            self.messenger = messenger
            owner = messenger.userId
            active = false
            status = [:]
            checkedAt = .distantPast
        }
        refresh()
    }

    /// Asks the server again unless it was asked less than a minute ago (`force`: always).
    func refresh(force: Bool = false) {
        guard let messenger, !loading else { return }
        guard force || Date().timeIntervalSince(checkedAt) > 60 else { return }
        loading = true
        let asked = messenger.userId
        messenger.accountCall("usernameStatus", []) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            self.loading = false
            guard case .success(let body) = result, body["accountId"] as? String == asked, asked == self.owner else { return }
            self.checkedAt = Date()
            self.take(body)
        }
    }

    /// A fresh status from a screen that changed it (the @username, the emoji status).
    func take(_ body: [String: Any]) {
        status = body
        set(active: (body["platina"] as? [String: Any])?["active"] as? Bool ?? false)
    }

    func set(active next: Bool) {
        active = next
        noteGrant(next)
        NotificationCenter.default.post(name: PlatinaState.changed, object: nil)
    }

    /// «Бессрочно», «Активна до 5 марта», «Активна»; empty without Platina (SettingsScreen.tsx).
    var untilWords: String {
        guard active, let platina = status["platina"] as? [String: Any] else { return "" }
        if platina["permanent"] as? Bool == true { return "Бессрочно" }
        if let date = Messenger.date(platina["expiresAt"] as? String) {
            let format = DateFormatter()
            format.locale = Locale(identifier: "ru_RU")
            format.dateFormat = "d MMMM"
            return "Активна до " + format.string(from: date)
        }
        return "Активна"
    }

    private func noteGrant(_ now: Bool) {
        guard !owner.isEmpty else { return }
        let key = "linea.platina.seen." + owner
        let before = UserDefaults.standard.string(forKey: key)
        let value = now ? "1" : "0"
        guard before != value else { return }
        UserDefaults.standard.set(value, forKey: key)
        if before == "0" && now { PlatinaConfettiHost.show(over: host) }
    }
}

/// Confetti and a short «Платина активирована ✨» on a glass pill at the top (platina/PlatinaConfetti.tsx); with
/// animations off only the pill. Gone after 3.6 s.
enum PlatinaConfettiHost {
    static let colors = ["#E8E3D3", "#C9CED8", "#F4D68A", "#B9A7F5", "#8FD3FF", "#FFFFFF", "#F2A7C9"]

    static func show(over host: UIViewController?) {
        guard let window = host?.view.window ?? platinaKeyWindow() else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let cover = UIView(frame: window.bounds)
        cover.isUserInteractionEnabled = false
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(cover)
        if Motion.enabled {
            let confetti = ConfettiView(frame: cover.bounds)
            cover.addSubview(confetti)
            confetti.burst(origin: "bottom", count: 110, colors: colors, duration: 2.8)
        }
        let pill = UIVisualEffectView(effect: TabGlass.effect(clear: false, interactive: false, dark: Theme.dark))
        pill.clipsToBounds = true
        pill.layer.cornerRadius = 22
        pill.layer.cornerCurve = .continuous
        let words = UILabel()
        words.text = "Платина активирована ✨"
        words.font = .systemFont(ofSize: 15, weight: .bold)
        words.textColor = Theme.text
        let size = words.intrinsicContentSize
        pill.frame = CGRect(x: (cover.bounds.width - size.width - 36) / 2, y: window.safeAreaInsets.top + 12, width: size.width + 36, height: size.height + 22)
        words.frame = pill.bounds
        words.textAlignment = .center
        pill.contentView.addSubview(words)
        cover.addSubview(pill)
        pill.alpha = 0
        pill.transform = CGAffineTransform(translationX: 0, y: -30)
        UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0, options: [], animations: {
            pill.alpha = 1
            pill.transform = .identity
        }, completion: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.6) {
            UIView.animate(withDuration: 0.3, animations: {
                pill.alpha = 0
                pill.transform = CGAffineTransform(translationX: 0, y: -30)
            }, completion: { (_: Bool) -> Void in cover.removeFromSuperview() })
        }
    }
}

/// The app's key window (for what shows over everything).
func platinaKeyWindow() -> UIWindow? {
    for scene in UIApplication.shared.connectedScenes {
        guard let windows = (scene as? UIWindowScene)?.windows else { continue }
        for window in windows where window.isKeyWindow { return window }
    }
    return nil
}

/// The screen on top of everything, to present from.
func platinaTopScreen() -> UIViewController? {
    var top = platinaKeyWindow()?.rootViewController
    while let shown = top?.presentedViewController { top = shown }
    return top
}
