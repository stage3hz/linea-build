import UIKit

/// ChatsPlus: the words above the bar about the hold — «Удержи «Чаты» — остальные разделы» (TabBar.tsx
/// `useBarHint`): shown on the first six starts of the app until the list of the other sections has been opened
/// once (by the hold, the swipe up or accessibility), then never again.
final class BarHintView: UIView {
    private static let key = "linea.hint.bar-scrub.v1"
    private static let starts = 6
    private static var decided: Bool?
    private let words = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.cornerRadius = 14
        layer.borderWidth = 1
        words.text = "Удержи «Чаты» — остальные разделы"
        words.font = AppFont.text(12.5, .semibold)
        words.textAlignment = .center
        addSubview(words)
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { return nil }

    /// Whether to show the words in this run of the app (counted once per start).
    private static var wanted: Bool {
        if let decided { return decided }
        var show = false
        let defaults = UserDefaults.standard
        let value = defaults.string(forKey: key) ?? ""
        let seen = Int(value) ?? 0
        if value != "used" && seen < starts {
            show = true
            defaults.set(String(seen + 1), forKey: key)
        }
        #if targetEnvironment(simulator)
        if UserDefaults.standard.string(forKey: "chatsdemo") == "hint" { show = true }
        #endif
        decided = show
        return show
    }

    func attach(to host: UIView, bar: TabBarView) {
        backgroundColor = Theme.dark ? UIColor(red: 22 / 255, green: 24 / 255, blue: 29 / 255, alpha: 0.94) : UIColor(white: 1, alpha: 0.96)
        layer.borderColor = Theme.veil(0.12).cgColor
        words.textColor = Theme.text
        isHidden = !BarHintView.wanted
        host.addSubview(self)
        bar.onListOpened = { [weak self] in self?.used() }
    }

    /// The gesture has been used: the words go for good.
    private func used() {
        guard BarHintView.decided != false || !isHidden else { return }
        BarHintView.decided = false
        UserDefaults.standard.set("used", forKey: BarHintView.key)
        UIView.animate(withDuration: 0.2, animations: { self.alpha = 0 }, completion: { _ in self.isHidden = true })
    }

    func place(above bar: CGRect, width: CGFloat) {
        superview?.bringSubviewToFront(self)
        let size = ceil(words.sizeThatFits(CGSize(width: width - 40, height: 28)).width) + 26
        frame = CGRect(x: (width - size) / 2, y: bar.minY - 3 - 28, width: size, height: 28)
        words.frame = bounds
    }
}
