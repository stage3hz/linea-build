import UIKit

/// «Язык»: the language of the interface; the choice applies at once and is kept on this device.
/// (The previous app: `LanguageSection` of `mobile/src/SettingsScreen.tsx`; the dictionary: Language/Language.swift.)
final class LanguageSettingsViewController: SettingsPage {
    init() {
        super.init(name: "Язык")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        clear()
        var rows: [UIView] = []
        for choice in Language.choices {
            let row = LanguageRow(native: choice.native, name: choice.name, chosen: choice.id == Language.current)
            let id = choice.id
            row.addAction(UIAction { [weak self] (_: UIAction) -> Void in
                UISelectionFeedbackGenerator().selectionChanged()
                self?.choose(id)
            }, for: .touchUpInside)
            rows.append(row)
        }
        addGroup("Язык интерфейса", rows: rows)
        add(SettingsLook.foot("Язык меняется только в интерфейсе. Сообщения и имена остаются как есть."), gap: 8)
    }

    private func choose(_ id: String) {
        guard id != Language.current else { return }
        Language.set(id)
        LanguageSettingsViewController.redraw()
    }

    /// Every screen is made again in the new language, with «Настройки › Язык» open on top, as the theme does.
    static func redraw() {
        let scenes = UIApplication.shared.connectedScenes
        for scene in scenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                guard let stack = window.rootViewController as? NavigationController, let root = stack.viewControllers.first as? RootViewController else { continue }
                let fresh = root.rebuilt()
                let next = NavigationController(rootViewController: fresh)
                window.rootViewController = next
                fresh.loadViewIfNeeded()
                fresh.show("profile")
                for child in fresh.children {
                    guard let settings = child as? SettingsViewController else { continue }
                    settings.loadViewIfNeeded()
                    if let page = settings.page(named: "language") { next.pushViewController(page, animated: false) }
                }
                return
            }
        }
    }
}

/// One language: its own name, its name in English, a mark on the chosen one (neither is in the dictionary).
final class LanguageRow: UIControl {
    init(native: String, name: String, chosen: Bool) {
        super.init(frame: .zero)
        let first = UILabel()
        first.attributedText = NSAttributedString(string: native, attributes: [.font: UIFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: Theme.text])
        let second = UILabel()
        second.attributedText = NSAttributedString(string: name, attributes: [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: Theme.muted])
        let texts = UIStackView(arrangedSubviews: [first, second])
        texts.axis = .vertical
        texts.spacing = 2
        let mark = UIImageView(image: SettingsLook.symbol("ion:checkmark", size: 20))
        mark.tintColor = Theme.accent
        mark.alpha = chosen ? 1 : 0
        mark.setContentHuggingPriority(.required, for: .horizontal)
        let content = UIStackView(arrangedSubviews: [texts, mark])
        content.axis = .horizontal
        content.alignment = .center
        content.spacing = 12
        content.isUserInteractionEnabled = false
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor, constant: 9),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
        ])
        isAccessibilityElement = true
        accessibilityTraits.insert(.button)
        if chosen { accessibilityTraits.insert(.selected) }
        accessibilityLabel = native
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? SettingsLook.pressed : .clear }
    }
}
