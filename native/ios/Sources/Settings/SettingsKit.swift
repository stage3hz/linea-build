import UIKit

/// What the pages of the settings are made of: the page itself (its own header, a column that scrolls),
/// a group of rows on a card, a row, a switch, a choice of several, a notice, a button, a field.
/// In the colours of the theme that is on (ThemeStore.swift).
enum SettingsLook {
    static var card: UIColor { Theme.surface2 }
    static var line: UIColor { Theme.veil(0.08) }
    static var chip: UIColor { Theme.veil(0.07) }
    static var dangerChip: UIColor { Theme.danger.withAlphaComponent(0.14) }
    static var pressed: UIColor { Theme.veil(0.07) }
    static let switchOn = UIColor(hex: 0x5E7BFF)

    static func symbol(_ name: String, size: CGFloat, weight: UIImage.SymbolWeight = .regular) -> UIImage? {
        return UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: weight))
    }

    static func words(_ text: String, size: CGFloat, color: UIColor, weight: UIFont.Weight = .regular) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.numberOfLines = 0
        return label
    }

    /// `inner` with room around it (a stack has no margins of its own for one item).
    static func inset(_ inner: UIView, top: CGFloat = 0, side: CGFloat = 0, bottom: CGFloat = 0) -> UIView {
        let box = UIView()
        inner.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.topAnchor.constraint(equalTo: box.topAnchor, constant: top),
            inner.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -bottom),
            inner.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: side),
            inner.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -side),
        ])
        return box
    }

    /// The quiet name above a group.
    static func caption(_ text: String) -> UIView {
        let label = UILabel()
        label.attributedText = NSAttributedString(string: text.uppercased(), attributes: [.kern: 1.2, .font: UIFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: Theme.muted])
        label.numberOfLines = 0
        label.accessibilityTraits = .header
        return inset(label, top: 8, side: 8, bottom: 0)
    }

    /// A few explaining words under a group.
    static func foot(_ text: String) -> UIView {
        return inset(words(text, size: 12, color: Theme.muted), top: 0, side: 8, bottom: 0)
    }

    static func rule() -> UIView {
        let rule = UIView()
        rule.backgroundColor = SettingsLook.line
        rule.translatesAutoresizingMaskIntoConstraints = false
        rule.heightAnchor.constraint(equalToConstant: 0.5).isActive = true
        return rule
    }

    private static func formatter(_ format: String) -> DateFormatter {
        let made = DateFormatter()
        made.locale = Locale(identifier: "ru_RU")
        made.dateFormat = format
        return made
    }
    private static let shortMoment = formatter("d MMM, HH:mm")
    private static let longMoment = formatter("d MMMM, HH:mm")

    /// «5 мар., 14:05» of a server time; «Неизвестно» when it is not a time.
    static func moment(_ text: String?) -> String {
        guard let date = Messenger.date(text) else { return "Неизвестно" }
        return shortMoment.string(from: date)
    }

    /// «5 марта, 14:05»; empty when it is not a time.
    static func longMomentWords(_ text: String?) -> String {
        guard let date = Messenger.date(text) else { return "" }
        return longMoment.string(from: date)
    }
}

/// A page of the settings. The root of the section has the large heading; every other page has a back
/// button and its name. Subclasses fill `column` in `build()`.
class SettingsPage: UIViewController {
    let scroll = UIScrollView()
    let column = UIStackView()
    private let heading = UILabel()
    private let backButton = UIButton(type: .system)
    private let sideButton = UIButton(type: .system)
    private let pageName: String
    private let large: Bool
    private var sideAction: (() -> Void)?

    init(name: String, large: Bool = false) {
        self.pageName = name
        self.large = large
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        heading.text = pageName
        heading.textColor = Theme.text
        heading.font = large ? .systemFont(ofSize: 34, weight: .bold) : .systemFont(ofSize: 20, weight: .semibold)
        heading.adjustsFontSizeToFitWidth = true
        heading.minimumScaleFactor = 0.7
        heading.accessibilityTraits = .header
        heading.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(heading)

        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.showsVerticalScrollIndicator = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        column.axis = .vertical
        column.spacing = 8
        column.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(column)

        let safe = view.safeAreaLayoutGuide
        var rules: [NSLayoutConstraint] = [
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 8),
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -28),
            column.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 16),
            column.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -16),
            column.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -32),
        ]
        if large {
            rules.append(heading.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8))
            rules.append(heading.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20))
            rules.append(heading.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -20))
            rules.append(heading.heightAnchor.constraint(equalToConstant: 41))
            rules.append(scroll.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 8))
            // The list goes under the bar at the bottom; the room for the bar is left in `viewDidLayoutSubviews`.
            rules.append(scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor))
        } else {
            backButton.setImage(SettingsLook.symbol("chevron.left", size: 19, weight: .semibold), for: .normal)
            backButton.tintColor = Theme.text
            backButton.accessibilityLabel = "Назад"
            backButton.addTarget(self, action: #selector(goBack), for: .touchUpInside)
            backButton.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(backButton)
            sideButton.tintColor = Theme.text
            sideButton.isHidden = true
            sideButton.addTarget(self, action: #selector(sidePressed), for: .touchUpInside)
            sideButton.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(sideButton)
            rules.append(backButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 4))
            rules.append(backButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6))
            rules.append(backButton.widthAnchor.constraint(equalToConstant: 44))
            rules.append(backButton.heightAnchor.constraint(equalToConstant: 44))
            rules.append(heading.leadingAnchor.constraint(equalTo: backButton.trailingAnchor, constant: 2))
            rules.append(heading.centerYAnchor.constraint(equalTo: backButton.centerYAnchor))
            rules.append(heading.trailingAnchor.constraint(lessThanOrEqualTo: sideButton.leadingAnchor, constant: -8))
            rules.append(sideButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6))
            rules.append(sideButton.centerYAnchor.constraint(equalTo: backButton.centerYAnchor))
            rules.append(sideButton.widthAnchor.constraint(equalToConstant: 44))
            rules.append(sideButton.heightAnchor.constraint(equalToConstant: 44))
            rules.append(scroll.topAnchor.constraint(equalTo: backButton.bottomAnchor, constant: 4))
            // The page ends where the keyboard begins, so a field is never under it.
            rules.append(scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor))
        }
        NSLayoutConstraint.activate(rules)
        build()
    }

    /// Subclasses put their content into `column` here.
    func build() {}

    @objc private func goBack() {
        navigationController?.popViewController(animated: true)
    }

    @objc private func sidePressed() {
        sideAction?()
    }

    /// An icon on the right of the header (pages with a back button only).
    func setSide(symbol: String, label: String, action: @escaping () -> Void) {
        sideButton.setImage(SettingsLook.symbol(symbol, size: 17, weight: .medium), for: .normal)
        sideButton.accessibilityLabel = label
        sideButton.isHidden = false
        sideAction = action
    }

    func setSideEnabled(_ enabled: Bool) {
        sideButton.isEnabled = enabled
    }

    /// Takes everything out of the column (before it is filled again).
    func clear() {
        for part in column.arrangedSubviews {
            column.removeArrangedSubview(part)
            part.removeFromSuperview()
        }
    }

    /// Adds a part to the column; `gap` is the room above it.
    func add(_ part: UIView, gap: CGFloat = 8) {
        if let last = column.arrangedSubviews.last { column.setCustomSpacing(gap, after: last) }
        column.addArrangedSubview(part)
    }

    /// Adds a group of rows, with its quiet name above when it has one.
    @discardableResult
    func addGroup(_ label: String = "", rows: [UIView]) -> SettingsGroup {
        let group = SettingsGroup(rows: rows)
        if label.isEmpty {
            add(group, gap: 16)
        } else {
            add(SettingsLook.caption(label), gap: 14)
            add(group, gap: 7)
        }
        return group
    }

    func open(_ page: UIViewController) {
        navigationController?.pushViewController(page, animated: true)
    }

    /// A question with one action and «Отмена».
    func confirm(heading: String, words: String, action: String, destructive: Bool = true, done: @escaping () -> Void) {
        let alert = UIAlertController(title: heading, message: words, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        alert.addAction(UIAlertAction(title: action, style: destructive ? .destructive : .default, handler: { _ in done() }))
        present(alert, animated: true)
    }

    func tell(_ words: String) {
        let alert = UIAlertController(title: nil, message: words, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
        present(alert, animated: true)
    }

    /// The account is closed on this device: signing in is shown, with a few words why.
    func closeAccount(notice: String) {
        let scenes = UIApplication.shared.connectedScenes
        for scene in scenes {
            if let delegate = scene.delegate as? SceneDelegate {
                delegate.closeAccount(notice: notice)
                return
            }
        }
    }
}

/// Rows on one card, a hairline between them.
final class SettingsGroup: UIView {
    private let stack = UIStackView()

    init(rows: [UIView]) {
        super.init(frame: .zero)
        backgroundColor = SettingsLook.card
        layer.cornerRadius = 12
        layer.cornerCurve = .continuous
        layer.masksToBounds = true
        layer.borderWidth = 0.5
        layer.borderColor = SettingsLook.line.cgColor
        stack.axis = .vertical
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        for (index, row) in rows.enumerated() {
            if index > 0 { stack.addArrangedSubview(SettingsLook.rule()) }
            stack.addArrangedSubview(row)
        }
    }

    required init?(coder: NSCoder) { return nil }
}

/// One row of a group: an icon in a quiet circle, a name, a value, an arrow. Pressing it calls `onPress`.
final class SettingsRow: UIControl {
    var onPress: (() -> Void)?
    private let nameLabel = UILabel()
    private let valueLabel = UILabel()
    private let rowName: String

    init(symbol: String = "", label: String, value: String = "", danger: Bool = false, arrow: Bool = true, swatch: UIColor? = nil, checked: Bool? = nil) {
        rowName = label
        super.init(frame: .zero)
        let content = UIStackView()
        content.axis = .horizontal
        content.alignment = .center
        content.spacing = 13
        content.isUserInteractionEnabled = false
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor, constant: 7),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -7),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])
        if !symbol.isEmpty {
            let chip = UIView()
            chip.backgroundColor = danger ? SettingsLook.dangerChip : SettingsLook.chip
            chip.layer.cornerRadius = 17
            chip.translatesAutoresizingMaskIntoConstraints = false
            let icon = UIImageView(image: SettingsLook.symbol(symbol, size: 15, weight: .medium))
            icon.tintColor = danger ? Theme.danger : Theme.text
            icon.contentMode = .center
            icon.translatesAutoresizingMaskIntoConstraints = false
            chip.addSubview(icon)
            NSLayoutConstraint.activate([
                chip.widthAnchor.constraint(equalToConstant: 34),
                chip.heightAnchor.constraint(equalToConstant: 34),
                icon.centerXAnchor.constraint(equalTo: chip.centerXAnchor),
                icon.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
            ])
            content.addArrangedSubview(chip)
        }
        nameLabel.text = label
        nameLabel.font = .systemFont(ofSize: 15)
        nameLabel.textColor = danger ? Theme.danger : Theme.text
        nameLabel.numberOfLines = 2
        nameLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        content.addArrangedSubview(nameLabel)
        valueLabel.text = value
        valueLabel.font = .systemFont(ofSize: 13)
        valueLabel.textColor = Theme.muted
        valueLabel.textAlignment = .right
        valueLabel.lineBreakMode = .byTruncatingTail
        valueLabel.setContentHuggingPriority(.required, for: .horizontal)
        valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        valueLabel.isHidden = value.isEmpty
        content.addArrangedSubview(valueLabel)
        if let swatch {
            let dot = UIView()
            dot.backgroundColor = swatch
            dot.layer.cornerRadius = 10
            dot.translatesAutoresizingMaskIntoConstraints = false
            dot.widthAnchor.constraint(equalToConstant: 20).isActive = true
            dot.heightAnchor.constraint(equalToConstant: 20).isActive = true
            content.addArrangedSubview(dot)
        }
        if let checked {
            // One of several: the chosen one has a mark, the others an empty place of the same size.
            let mark = UIImageView(image: SettingsLook.symbol("checkmark", size: 16, weight: .semibold))
            mark.tintColor = Theme.text
            mark.contentMode = .center
            mark.alpha = checked ? 1 : 0
            mark.setContentHuggingPriority(.required, for: .horizontal)
            content.addArrangedSubview(mark)
            if checked { accessibilityTraits.insert(.selected) }
        } else if arrow && !danger {
            let chevron = UIImageView(image: SettingsLook.symbol("chevron.right", size: 13, weight: .semibold))
            chevron.tintColor = Theme.subtle
            chevron.contentMode = .center
            chevron.setContentHuggingPriority(.required, for: .horizontal)
            content.addArrangedSubview(chevron)
        }
        isAccessibilityElement = true
        accessibilityTraits.insert(.button)
        accessibilityLabel = value.isEmpty ? label : label + ": " + value
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    func setValue(_ value: String) {
        valueLabel.text = value
        valueLabel.isHidden = value.isEmpty
        accessibilityLabel = value.isEmpty ? rowName : rowName + ": " + value
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? SettingsLook.pressed : .clear }
    }

    override var isEnabled: Bool {
        didSet { alpha = isEnabled ? 1 : 0.5 }
    }

    @objc private func pressed() {
        onPress?()
    }
}

/// A switch with its name and a few explaining words.
final class SettingsSwitchRow: UIView {
    var onChange: ((Bool) -> Void)?
    private let toggle = UISwitch()

    init(label: String, words: String, value: Bool, enabled: Bool = true, badge: String = "") {
        super.init(frame: .zero)
        let nameLabel = SettingsLook.words(label, size: 15, color: Theme.text)
        let top = UIStackView(arrangedSubviews: [nameLabel])
        top.axis = .horizontal
        top.alignment = .center
        top.spacing = 7
        if !badge.isEmpty {
            let mark = PaddedLabel()
            mark.text = badge
            mark.font = .systemFont(ofSize: 11, weight: .bold)
            mark.textColor = Theme.text
            mark.backgroundColor = SettingsLook.chip
            mark.layer.cornerRadius = 8
            mark.layer.masksToBounds = true
            mark.setContentHuggingPriority(.required, for: .horizontal)
            top.addArrangedSubview(mark)
            let filler = UIView()
            filler.setContentHuggingPriority(.defaultLow, for: .horizontal)
            top.addArrangedSubview(filler)
            nameLabel.setContentHuggingPriority(.required, for: .horizontal)
        }
        let texts = UIStackView(arrangedSubviews: [top])
        texts.axis = .vertical
        texts.spacing = 3
        if !words.isEmpty { texts.addArrangedSubview(SettingsLook.words(words, size: 12, color: Theme.muted)) }
        toggle.isOn = value
        toggle.isEnabled = enabled
        toggle.onTintColor = SettingsLook.switchOn
        toggle.accessibilityLabel = label
        toggle.setContentHuggingPriority(.required, for: .horizontal)
        toggle.setContentCompressionResistancePriority(.required, for: .horizontal)
        toggle.addTarget(self, action: #selector(flipped), for: .valueChanged)
        let content = UIStackView(arrangedSubviews: [texts, toggle])
        content.axis = .horizontal
        content.alignment = .center
        content.spacing = 12
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor, constant: 11),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -11),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func flipped() {
        onChange?(toggle.isOn)
    }
}

/// A label with a little room around its words (a badge).
final class PaddedLabel: UILabel {
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 14, height: size.height + 4)
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.insetBy(dx: 7, dy: 2))
    }
}

/// One of several, side by side: the chosen one is filled.
final class SettingsSegments: UIView {
    var onPick: ((Int) -> Void)?
    private var buttons: [UIButton] = []

    init(labels: [String], chosen: Int, enabled: Bool = true, spoken: String = "") {
        super.init(frame: .zero)
        backgroundColor = SettingsLook.chip
        layer.cornerRadius = 14
        layer.cornerCurve = .continuous
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 3),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
            row.heightAnchor.constraint(equalToConstant: 36),
        ])
        for (index, label) in labels.enumerated() {
            let on = index == chosen
            let button = UIButton(type: .custom)
            button.setTitle(label, for: .normal)
            button.setTitleColor(on ? Theme.onAccent : Theme.text, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 13, weight: on ? .bold : .medium)
            button.backgroundColor = on ? Theme.accent : .clear
            button.layer.cornerRadius = 11
            button.layer.cornerCurve = .continuous
            button.tag = index
            button.isEnabled = enabled
            button.accessibilityLabel = spoken.isEmpty ? label : spoken + ": " + label
            if on { button.accessibilityTraits.insert(.selected) }
            button.addTarget(self, action: #selector(picked(_:)), for: .touchUpInside)
            row.addArrangedSubview(button)
            buttons.append(button)
        }
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func picked(_ sender: UIButton) {
        onPick?(sender.tag)
    }
}

/// A few words on a plate: something happened, or something went wrong (then it can offer to try again).
final class SettingsNotice: UIView {
    private var retry: (() -> Void)?

    init(_ text: String, error: Bool = false, onRetry: (() -> Void)? = nil) {
        super.init(frame: .zero)
        retry = onRetry
        backgroundColor = error ? SettingsLook.dangerChip : SettingsLook.chip
        layer.cornerRadius = 12
        layer.cornerCurve = .continuous
        let label = SettingsLook.words(text, size: 13, color: error ? Theme.danger : Theme.text)
        let content = UIStackView(arrangedSubviews: [label])
        content.axis = .vertical
        content.alignment = .leading
        content.spacing = 6
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor, constant: 11),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -11),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 13),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -13),
        ])
        if onRetry != nil {
            let again = UIButton(type: .system)
            again.setTitle("Повторить", for: .normal)
            again.tintColor = Theme.text
            again.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
            again.addTarget(self, action: #selector(retryPressed), for: .touchUpInside)
            content.addArrangedSubview(again)
        }
        if error { accessibilityTraits.insert(.staticText) }
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func retryPressed() {
        retry?()
    }
}

/// A wide button: the main one, a quiet one, or a dangerous one. It can show that it is busy.
final class SettingsButton: UIButton {
    enum Kind { case primary, secondary, danger }
    var onPress: (() -> Void)?

    init(label: String, kind: Kind = .primary) {
        super.init(frame: .zero)
        var look = UIButton.Configuration.filled()
        switch kind {
        case .primary:
            look.baseBackgroundColor = Theme.accent
            look.baseForegroundColor = Theme.onAccent
        case .secondary:
            look.baseBackgroundColor = SettingsLook.chip
            look.baseForegroundColor = Theme.text
        case .danger:
            look.baseBackgroundColor = SettingsLook.dangerChip
            look.baseForegroundColor = Theme.danger
        }
        look.title = label
        look.cornerStyle = .large
        look.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 18)
        look.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { (incoming: AttributeContainer) -> AttributeContainer in
            var outgoing = incoming
            outgoing.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
            return outgoing
        }
        configuration = look
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    func setBusy(_ busy: Bool) {
        configuration?.showsActivityIndicator = busy
        isEnabled = !busy
    }

    @objc private func pressed() {
        onPress?()
    }
}

/// One line of typing with its caption. A secret is hidden while typed (the eye shows it) and is typed by
/// hand only: no paste, as in the reference.
final class SettingsField: UIView, UITextFieldDelegate {
    let input: UITextField
    /// The longest text the field takes (0: any).
    var limit = 0
    /// Only these symbols are taken (nil: any).
    var allowed: CharacterSet?
    var onReturn: (() -> Void)?
    var onEdit: (() -> Void)?
    private let eye = UIButton(type: .system)

    init(caption: String, placeholder: String, secret: Bool = false) {
        input = secret ? ManualTextField() : UITextField()
        super.init(frame: .zero)
        let name = UILabel()
        name.attributedText = NSAttributedString(string: caption.uppercased(), attributes: [.kern: 1.0, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        name.numberOfLines = 0
        name.isHidden = caption.isEmpty
        let plate = UIView()
        plate.backgroundColor = SettingsLook.card
        plate.layer.cornerRadius = 14
        plate.layer.cornerCurve = .continuous
        plate.layer.borderWidth = 0.5
        plate.layer.borderColor = SettingsLook.line.cgColor
        input.font = .systemFont(ofSize: 16)
        input.textColor = Theme.text
        input.tintColor = Theme.text
        input.keyboardAppearance = Theme.dark ? .dark : .light
        input.autocorrectionType = .no
        input.autocapitalizationType = .none
        input.spellCheckingType = .no
        input.smartQuotesType = .no
        input.smartDashesType = .no
        input.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: Theme.subtle])
        input.accessibilityLabel = caption.isEmpty ? placeholder : caption
        input.isSecureTextEntry = secret
        // A secret is typed by hand: no suggestions of saved or new passwords (as on the sign-in screen).
        input.textContentType = secret ? UITextContentType.oneTimeCode : nil
        input.delegate = self
        input.addTarget(self, action: #selector(edited), for: .editingChanged)
        input.translatesAutoresizingMaskIntoConstraints = false
        plate.addSubview(input)
        eye.setImage(SettingsLook.symbol("eye", size: 15), for: .normal)
        eye.tintColor = Theme.muted
        eye.accessibilityLabel = "Показать"
        eye.isHidden = !secret
        eye.addTarget(self, action: #selector(eyePressed), for: .touchUpInside)
        eye.translatesAutoresizingMaskIntoConstraints = false
        plate.addSubview(eye)
        NSLayoutConstraint.activate([
            plate.heightAnchor.constraint(equalToConstant: 50),
            input.leadingAnchor.constraint(equalTo: plate.leadingAnchor, constant: 14),
            input.topAnchor.constraint(equalTo: plate.topAnchor),
            input.bottomAnchor.constraint(equalTo: plate.bottomAnchor),
            input.trailingAnchor.constraint(equalTo: plate.trailingAnchor, constant: secret ? -48 : -14),
            eye.trailingAnchor.constraint(equalTo: plate.trailingAnchor, constant: -4),
            eye.centerYAnchor.constraint(equalTo: plate.centerYAnchor),
            eye.widthAnchor.constraint(equalToConstant: 44),
            eye.heightAnchor.constraint(equalToConstant: 44),
        ])
        let content = UIStackView(arrangedSubviews: [SettingsLook.inset(name, top: 0, side: 2, bottom: 0), plate])
        content.axis = .vertical
        content.spacing = 8
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor),
            content.bottomAnchor.constraint(equalTo: bottomAnchor),
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        if caption.isEmpty { content.arrangedSubviews.first?.isHidden = true }
    }

    required init?(coder: NSCoder) { return nil }

    var value: String {
        get { return input.text ?? "" }
        set { input.text = newValue }
    }

    func setEnabled(_ enabled: Bool) {
        input.isEnabled = enabled
        alpha = enabled ? 1 : 0.6
    }

    @objc private func edited() {
        onEdit?()
    }

    @objc private func eyePressed() {
        let kept = input.text
        input.isSecureTextEntry.toggle()
        input.text = kept
        input.textContentType = input.isSecureTextEntry ? UITextContentType.oneTimeCode : nil
        eye.setImage(SettingsLook.symbol(input.isSecureTextEntry ? "eye" : "eye.slash", size: 15), for: .normal)
        eye.accessibilityLabel = input.isSecureTextEntry ? "Показать" : "Скрыть"
    }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        if let allowed {
            for scalar in string.unicodeScalars {
                if !allowed.contains(scalar) { return false }
            }
        }
        guard limit > 0 else { return true }
        let now = (textField.text ?? "") as NSString
        guard range.location + range.length <= now.length else { return false }
        return now.length - range.length + (string as NSString).length <= limit
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if let onReturn {
            onReturn()
        } else {
            textField.resignFirstResponder()
        }
        return false
    }
}

/// Several lines of typing (the words about oneself), with the quiet hint while it is empty.
final class SettingsTextArea: UIView, UITextViewDelegate {
    private let area = UITextView()
    private let hint = UILabel()
    var limit = 0
    var onEdit: (() -> Void)?

    init(placeholder: String) {
        super.init(frame: .zero)
        backgroundColor = SettingsLook.card
        layer.cornerRadius = 14
        layer.cornerCurve = .continuous
        layer.borderWidth = 0.5
        layer.borderColor = SettingsLook.line.cgColor
        area.backgroundColor = .clear
        area.font = .systemFont(ofSize: 16)
        area.textColor = Theme.text
        area.tintColor = Theme.text
        area.keyboardAppearance = Theme.dark ? .dark : .light
        area.isScrollEnabled = false
        area.textContainerInset = UIEdgeInsets(top: 13, left: 10, bottom: 13, right: 10)
        area.accessibilityLabel = placeholder
        area.delegate = self
        area.translatesAutoresizingMaskIntoConstraints = false
        addSubview(area)
        hint.text = placeholder
        hint.font = .systemFont(ofSize: 16)
        hint.textColor = Theme.subtle
        hint.isAccessibilityElement = false
        hint.translatesAutoresizingMaskIntoConstraints = false
        addSubview(hint)
        NSLayoutConstraint.activate([
            area.topAnchor.constraint(equalTo: topAnchor),
            area.bottomAnchor.constraint(equalTo: bottomAnchor),
            area.leadingAnchor.constraint(equalTo: leadingAnchor),
            area.trailingAnchor.constraint(equalTo: trailingAnchor),
            area.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
            hint.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            hint.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 15),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    var value: String {
        get { return area.text ?? "" }
        set {
            area.text = newValue
            hint.isHidden = !newValue.isEmpty
        }
    }

    func setEnabled(_ enabled: Bool) {
        area.isEditable = enabled
        alpha = enabled ? 1 : 0.6
    }

    func textViewDidChange(_ textView: UITextView) {
        hint.isHidden = !(textView.text ?? "").isEmpty
        onEdit?()
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        guard limit > 0 else { return true }
        let now = (textView.text ?? "") as NSString
        guard range.location + range.length <= now.length else { return false }
        return now.length - range.length + (text as NSString).length <= limit
    }
}

/// A person as a round lit ball of their colour with their initials — or their picture, once it is here.
final class SettingsAvatar: UIView {
    private var rgb: UInt32 = 0x5E7BFF
    private var letters = ""
    private var pictureKey = ""
    private var pictureAddress = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        isAccessibilityElement = false
        NotificationCenter.default.addObserver(self, selector: #selector(pictureReady(_:)), name: ChatAvatarStore.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// `person`: a user as the server gives it (`displayName`, `avatarColor`, `avatarId`); `base`: the server
    /// its picture is asked from (empty: never asked).
    func show(_ person: [String: Any], base: String) {
        letters = String(Messenger.initials(person["displayName"] as? String ?? "").prefix(2))
        rgb = Messenger.color(person["avatarColor"] as? String)
        let id = person["avatarId"] as? String ?? ""
        pictureKey = base.isEmpty ? "" : id
        if pictureKey.isEmpty {
            pictureAddress = ""
        } else {
            let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? ""
            pictureAddress = base + "/files/" + safe
        }
        setNeedsDisplay()
    }

    @objc private func pictureReady(_ note: Notification) {
        guard let key = note.object as? String, key == pictureKey else { return }
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let box = bounds
        guard box.width > 0, box.height > 0 else { return }
        context.saveGState()
        UIBezierPath(ovalIn: box).addClip()
        var face: UIImage? = nil
        if !pictureKey.isEmpty { face = ChatAvatarStore.shared.image(key: pictureKey, url: pictureAddress) }
        if let face, face.size.width > 0, face.size.height > 0 {
            let scale = max(box.width / face.size.width, box.height / face.size.height)
            let size = CGSize(width: face.size.width * scale, height: face.size.height * scale)
            face.draw(in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height))
        } else {
            // The same lit ball as in the list of chats: the colour between a lighter and a deeper neighbour.
            let pair = orbPair(rgb)
            let light = UIColor(hex: UInt32(truncatingIfNeeded: pair.light) & 0xFFFFFF)
            let deep = UIColor(hex: UInt32(truncatingIfNeeded: pair.deep) & 0xFFFFFF)
            if let space = CGColorSpace(name: CGColorSpace.sRGB) {
                let body = [light.cgColor, UIColor(hex: rgb).cgColor, deep.cgColor] as CFArray
                let bodyStops: [CGFloat] = [0, 0.5, 1]
                if let gradient = CGGradient(colorsSpace: space, colors: body, locations: bodyStops) {
                    context.drawLinearGradient(gradient, start: CGPoint(x: box.minX + box.width * 0.9, y: box.maxY), end: CGPoint(x: box.minX + box.width * 0.1, y: box.minY),
                                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
                }
                let shine = [UIColor(white: 1, alpha: 0.42).cgColor, UIColor(white: 1, alpha: 0.06).cgColor, UIColor(white: 1, alpha: 0).cgColor] as CFArray
                let shineStops: [CGFloat] = [0, 0.38, 0.6]
                if let gradient = CGGradient(colorsSpace: space, colors: shine, locations: shineStops) {
                    context.drawLinearGradient(gradient, start: CGPoint(x: box.minX + box.width * 0.12, y: box.minY + box.height * 0.02),
                                               end: CGPoint(x: box.minX + box.width * 0.7, y: box.minY + box.height * 0.8), options: [])
                }
            } else {
                context.setFillColor(UIColor(hex: rgb).cgColor)
                context.fill(box)
            }
            let text = NSAttributedString(string: letters, attributes: [.font: UIFont.systemFont(ofSize: box.width * 0.36, weight: .bold), .foregroundColor: UIColor.white])
            let size = text.size()
            text.draw(at: CGPoint(x: box.midX - size.width / 2, y: box.midY - size.height / 2))
        }
        context.restoreGState()
    }
}
