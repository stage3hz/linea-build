import UIKit

/// The update the account's server offers and whether it is mandatory for this build (the reference's update/store.ts
/// and update/UpdateScreen.tsx). `GET /app/update` answers even builds the server otherwise turns away (426), so an
/// outdated app always learns where to get the new version.
/// - Mandatory (below `minVersion`, or the grace period after `requiredAt` is over, or any answer 426): a screen over
///   the whole app that cannot be put away.
/// - Optional: a window with «Позже», shown once per version; it comes back on a cold start and after the app was
///   away for five minutes or more.
/// The deadline is on the server's clock (a wrong phone clock does not move it) and checked every 30 s, so the app
/// locks at the exact moment. Asked only of the signed-in account's own server. Main queue only (except
/// `markRequired`).
final class UpdateGate: NSObject {
    static let shared = UpdateGate()
    static let repromptAfter: TimeInterval = 5 * 60

    struct Info {
        let version: String?
        let minVersion: String?
        let page: String?
        /// Milliseconds on the SERVER's clock.
        let releasedAt: Double?
        let requiredAt: Double?
        /// The server's time minus the phone's.
        let clockOffset: Double
    }

    private(set) var info: Info?
    private(set) var mandatory = false
    private(set) var available = false
    private(set) var dismissed = false
    private var server: Server?
    private weak var host: UIViewController?
    private weak var screen: UpdateViewController?
    private var clock: Timer?
    private var leftAt: Date?

    static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0" }

    func start(_ messenger: Messenger?, host: UIViewController) {
        self.host = host
        let centre = NotificationCenter.default
        centre.removeObserver(self)
        centre.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        centre.addObserver(self, selector: #selector(wentAway), name: UIApplication.willResignActiveNotification, object: nil)
        clock?.invalidate()
        clock = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] (_: Timer) -> Void in
            self?.recheckDeadline()
            self?.screen?.refresh()
        }
        #if targetEnvironment(simulator)
        if let demo = UserDefaults.standard.string(forKey: "updatedemo"), !demo.isEmpty {
            let now = Date().timeIntervalSince1970 * 1000
            info = Info(version: "9.0.0", minVersion: demo == "required" ? "9.0.0" : nil, page: "https://github.com/stage3hz/linea-build/releases",
                        releasedAt: now - 2 * 3_600_000, requiredAt: now + (2 * 86_400_000 + 14 * 3_600_000 + 5 * 60_000), clockOffset: 0)
            publish(dismissed: false)
            return
        }
        #endif
        // Only the account's own server is asked (never a server the person did not choose).
        guard let messenger else { return }
        server = Server(base: messenger.server.base)
        check()
    }

    /// Any answer 426: the server has retired this build. From any queue.
    static func markRequired() {
        DispatchQueue.main.async {
            let gate = UpdateGate.shared
            guard !gate.mandatory else { return }
            gate.mandatory = true
            gate.available = true
            gate.dismissed = false
            gate.show()
            gate.check()
        }
    }

    @objc private func wentAway() { leftAt = Date() }

    /// «Every time the app is opened»: the window returns after the app was away a while.
    @objc private func becameActive() {
        if let leftAt, Date().timeIntervalSince(leftAt) >= UpdateGate.repromptAfter, dismissed {
            dismissed = false
            show()
        }
        leftAt = nil
        check()
    }

    func check() {
        guard let server else { return }
        server.send("GET", "/app/update") { [weak self] (result: Result<Any, ServerError>) -> Void in
            guard case .success(let body) = result, let raw = body as? [String: Any] else { return }
            DispatchQueue.main.async { self?.take(raw) }
        }
    }

    private static func time(_ value: Any?) -> Double? {
        guard let text = value as? String, let date = Messenger.date(text) else { return nil }
        return date.timeIntervalSince1970 * 1000
    }

    private func take(_ raw: [String: Any]) {
        let server = UpdateGate.time(raw["serverTime"])
        let version = raw["version"] as? String
        let minimum = raw["minVersion"] as? String
        let made = Info(version: UpdateGate.parse(version) != nil ? version : nil, minVersion: UpdateGate.parse(minimum) != nil ? minimum : nil,
                        page: raw["page"] as? String, releasedAt: UpdateGate.time(raw["releasedAt"]), requiredAt: UpdateGate.time(raw["requiredAt"]),
                        clockOffset: server.map { $0 - Date().timeIntervalSince1970 * 1000 } ?? 0)
        let sameVersion = info?.version == made.version
        info = made
        publish(dismissed: dismissed && sameVersion)
    }

    private func publish(dismissed kept: Bool) {
        guard let info else { return }
        let decided = UpdateGate.decide(info, current: UpdateGate.appVersion, nowMs: Date().timeIntervalSince1970 * 1000)
        // A 426 already heard stays mandatory.
        mandatory = mandatory || decided.mandatory
        available = mandatory || decided.available
        dismissed = mandatory ? false : kept
        show()
    }

    private func recheckDeadline() {
        guard let info, !mandatory else { return }
        if UpdateGate.decide(info, current: UpdateGate.appVersion, nowMs: Date().timeIntervalSince1970 * 1000).mandatory {
            mandatory = true
            available = true
            dismissed = false
            show()
        }
    }

    /// «Позже» (the optional window only).
    func dismissUpdate() {
        guard !mandatory else { return }
        dismissed = true
        screen?.dismiss(animated: true)
    }

    /// The window or the screen, as the state says.
    private func show() {
        if let screen {
            if !available || (dismissed && !mandatory) {
                screen.dismiss(animated: true)
                return
            }
            screen.mandatory = mandatory
            screen.refresh()
            return
        }
        guard available, !dismissed || mandatory, let host, var top = host.view.window?.rootViewController else { return }
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        let made = UpdateViewController(mandatory: mandatory)
        screen = made
        top.present(made, animated: true)
    }

    // MARK: The rules (update/store.ts)

    static func parse(_ value: String?) -> [Int]? {
        guard let text = value?.trimmingCharacters(in: .whitespaces) else { return nil }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let limits = [4, 4, 5]
        guard parts.count == 3 else { return nil }
        var numbers: [Int] = []
        for (index, part) in parts.enumerated() {
            guard !part.isEmpty, part.count <= limits[index], part.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(part) else { return nil }
            numbers.append(number)
        }
        return numbers
    }

    static func less(_ a: String, _ b: String) -> Bool {
        guard let pa = parse(a), let pb = parse(b) else { return false }
        for index in 0..<3 where pa[index] != pb[index] { return pa[index] < pb[index] }
        return false
    }

    static func decide(_ info: Info, current: String, nowMs: Double) -> (mandatory: Bool, available: Bool) {
        let newer = info.version.map { less(current, $0) } ?? false
        let serverNow = nowMs + info.clockOffset
        let belowMinimum = info.minVersion.map { less(current, $0) } ?? false
        let late = newer && info.requiredAt.map { serverNow >= $0 } == true
        let mandatory = belowMinimum || late
        return (mandatory: mandatory, available: mandatory || newer)
    }

    /// «2 д 14 ч 05 мин» / «14 ч 05 мин» / «5 мин».
    static func span(_ ms: Double) -> String {
        let total = max(0, Int((ms / 60_000).rounded(.down)))
        let days = total / 1440, hours = (total % 1440) / 60, minutes = total % 60
        let two = String(format: "%02d", minutes)
        if days > 0 { return "\(days) д \(hours) ч \(two) мин" }
        if hours > 0 { return "\(hours) ч \(two) мин" }
        return "\(max(1, minutes)) мин"
    }
}

/// The screen of an update (UpdateScreen.tsx): the card with the cloud, the words, the versions, «Вышло … назад» and
/// «Обязательно через …», the way to the download page and, while optional, «Позже».
final class UpdateViewController: UIViewController {
    var mandatory: Bool
    private let card = UIView()
    private let badge = UIView()
    private let icon = UIImageView()
    private let heading = UILabel()
    private let body = UILabel()
    private let versions = UILabel()
    private let releasedBox = UIView()
    private let releasedCaption = UILabel()
    private let releasedWords = UILabel()
    private let leftBox = UIView()
    private let leftCaption = UILabel()
    private let leftWords = UILabel()
    private let pageButton = UIButton(type: .system)
    private let note = UILabel()
    private let later = UIButton(type: .system)

    init(mandatory: Bool) {
        self.mandatory = mandatory
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
        isModalInPresentation = true
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        card.backgroundColor = Theme.dark ? UIColor(red: 0x15 / 255, green: 0x1B / 255, blue: 0x2C / 255, alpha: 1) : .white
        card.layer.cornerRadius = 28
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = 1
        card.layer.borderColor = Theme.veil(0.12).cgColor
        view.addSubview(card)
        badge.backgroundColor = Theme.accent.withAlphaComponent(0.16)
        badge.layer.cornerRadius = 22
        badge.layer.cornerCurve = .continuous
        card.addSubview(badge)
        icon.image = UIImage(systemName: "icloud.and.arrow.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 28, weight: .regular))
        icon.tintColor = Theme.accent
        icon.contentMode = .center
        badge.addSubview(icon)
        for label in [heading, body, versions, note] {
            label.textAlignment = .center
            label.numberOfLines = 0
            card.addSubview(label)
        }
        body.font = Theme.font(14)
        body.textColor = Theme.muted
        versions.font = Theme.font(12)
        versions.textColor = Theme.muted
        note.font = Theme.font(12)
        note.textColor = Theme.muted
        note.text = "На iPhone новую версию нужно скачать и подписать, как обычно."
        for (box, caption, words, tinted) in [(releasedBox, releasedCaption, releasedWords, false), (leftBox, leftCaption, leftWords, true)] {
            box.backgroundColor = tinted ? Theme.accent.withAlphaComponent(0.16) : Theme.surface2
            box.layer.cornerRadius = 16
            caption.font = Theme.font(11)
            caption.textColor = tinted ? Theme.accent : Theme.muted
            caption.textAlignment = .center
            words.font = Theme.font(15, .bold)
            words.textColor = tinted ? Theme.accent : Theme.text
            words.textAlignment = .center
            words.adjustsFontSizeToFitWidth = true
            words.minimumScaleFactor = 0.7
            box.addSubview(caption)
            box.addSubview(words)
            card.addSubview(box)
        }
        releasedCaption.text = "Вышло"
        leftCaption.text = "Обязательно через"
        pageButton.setTitle("  Открыть страницу загрузки", for: .normal)
        pageButton.setImage(UIImage(systemName: "arrow.up.right.square", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        pageButton.titleLabel?.font = Theme.font(16, .semibold)
        pageButton.tintColor = Theme.onAccent
        pageButton.setTitleColor(Theme.onAccent, for: .normal)
        pageButton.backgroundColor = Theme.accent
        pageButton.layer.cornerRadius = 16
        pageButton.addTarget(self, action: #selector(openPage), for: .touchUpInside)
        card.addSubview(pageButton)
        later.setTitle("Позже", for: .normal)
        later.titleLabel?.font = Theme.font(14)
        later.setTitleColor(Theme.muted, for: .normal)
        later.addTarget(self, action: #selector(putOff), for: .touchUpInside)
        card.addSubview(later)
        refresh()
    }

    func refresh() {
        guard isViewLoaded else { return }
        let gate = UpdateGate.shared
        view.backgroundColor = mandatory ? Theme.bg : UIColor(white: 0, alpha: 0.55)
        let title = NSMutableAttributedString(string: mandatory ? "Требуется обновление" : "Доступна новая версия",
                                              attributes: [.font: Theme.font(22, .heavy), .foregroundColor: Theme.text, .kern: -0.4])
        heading.attributedText = title
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 20
        paragraph.maximumLineHeight = 20
        paragraph.alignment = .center
        let words = mandatory ? "Эта версия Инвиза больше не поддерживается. Установи новую — переписка и аккаунт сохранятся."
            : "Вышло обновление Инвиза. Пока им можно пользоваться и без него, но после срока обновление станет обязательным. Переписка и аккаунт сохранятся."
        body.attributedText = NSAttributedString(string: words, attributes: [.font: Theme.font(14), .foregroundColor: Theme.muted, .paragraphStyle: paragraph])
        let info = gate.info
        if let version = info?.version { versions.text = "Новая версия \(version) · у тебя \(UpdateGate.appVersion)" } else { versions.text = "У тебя \(UpdateGate.appVersion)" }
        let now = Date().timeIntervalSince1970 * 1000 + (info?.clockOffset ?? 0)
        if let released = info?.releasedAt {
            releasedBox.isHidden = false
            releasedWords.text = UpdateGate.span(now - released) + " назад"
        } else {
            releasedBox.isHidden = true
        }
        if let until = info?.requiredAt, !mandatory, until - now > 0 {
            leftBox.isHidden = false
            leftWords.text = UpdateGate.span(until - now)
        } else {
            leftBox.isHidden = true
        }
        pageButton.isHidden = UpdateViewController.pageAddress(info?.page) == nil
        later.isHidden = mandatory
        isModalInPresentation = true
        view.setNeedsLayout()
    }

    /// Only an https address opens.
    private static func pageAddress(_ text: String?) -> URL? {
        guard let text, let address = URL(string: text), address.scheme?.lowercased() == "https", address.host != nil else { return nil }
        return address
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = min(420, view.bounds.width - 48)
        let inner = width - 48
        var y: CGFloat = 24
        badge.frame = CGRect(x: (width - 64) / 2, y: y, width: 64, height: 64)
        icon.frame = badge.bounds
        y += 64 + 16
        func put(_ label: UILabel) {
            let height = ceil(label.sizeThatFits(CGSize(width: inner, height: 400)).height)
            label.frame = CGRect(x: 24, y: y, width: inner, height: height)
            y += height + 16
        }
        put(heading)
        put(body)
        put(versions)
        let boxes = [releasedBox, leftBox].filter { !$0.isHidden }
        if !boxes.isEmpty {
            let each = (inner - CGFloat(boxes.count - 1) * 10) / CGFloat(boxes.count)
            for (index, box) in boxes.enumerated() {
                box.frame = CGRect(x: 24 + CGFloat(index) * (each + 10), y: y, width: each, height: 62)
                let caption = box === releasedBox ? releasedCaption : leftCaption
                let words = box === releasedBox ? releasedWords : leftWords
                caption.frame = CGRect(x: 6, y: 12, width: each - 12, height: 14)
                words.frame = CGRect(x: 6, y: 30, width: each - 12, height: 20)
            }
            y += 62 + 16
        }
        if !pageButton.isHidden {
            pageButton.frame = CGRect(x: 24, y: y, width: inner, height: 50)
            y += 50 + 16
        }
        put(note)
        if !later.isHidden {
            later.frame = CGRect(x: (width - 120) / 2, y: y - 6, width: 120, height: 40)
            y += 34
        }
        let height = y + 8
        card.frame = CGRect(x: (view.bounds.width - width) / 2, y: max(view.safeAreaInsets.top + 12, (view.bounds.height - height) / 2), width: width, height: height)
    }

    @objc private func openPage() {
        guard let address = UpdateViewController.pageAddress(UpdateGate.shared.info?.page) else { return }
        UIApplication.shared.open(address)
    }

    @objc private func putOff() { UpdateGate.shared.dismissUpdate() }
}
