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
    /// The reference's ThemeSwitch (components.tsx): the track is the theme's accent when on, green (#34C77B) when the
    /// accent is pale (every channel above 190: «Чёрная», «Графит» …), and the theme's `subtle` when off.
    static var switchOn: UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        let accent = Theme.accent
        if accent.getRed(&r, green: &g, blue: &b, alpha: &a), a > 0.99, r * 255 > 190, g * 255 > 190, b * 255 > 190 {
            return UIColor(hex: 0x34C77B)
        }
        return accent
    }
    static var switchOff: UIColor { Theme.subtle }

    /// A switch in the reference's colours (on: `switchOn`, off: the `subtle` track, white thumb).
    static func paint(_ toggle: UISwitch) {
        toggle.onTintColor = switchOn
        toggle.thumbTintColor = .white
        toggle.backgroundColor = switchOff
        toggle.layer.cornerRadius = toggle.intrinsicContentSize.height / 2
        toggle.layer.cornerCurve = .continuous
        toggle.clipsToBounds = false
    }

    /// "ion:<name>" is the reference's own Ionicons glyph (Design/IonIcon.swift), `size` points square as
    /// `<Icon size>` draws it; any other name is a system symbol.
    static func symbol(_ name: String, size: CGFloat, weight: UIImage.SymbolWeight = .regular) -> UIImage? {
        if name.hasPrefix("ion:") { return IonIcon.image(String(name.dropFirst(4)), size: size) }
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

    /// Words with the reference's exact line height and letter spacing.
    static func para(_ text: String, size: CGFloat, color: UIColor, weight: UIFont.Weight = .regular, line: CGFloat = 0, kern: CGFloat = 0, centered: Bool = false) -> UILabel {
        let label = UILabel()
        label.numberOfLines = 0
        let style = NSMutableParagraphStyle()
        if line > 0 { style.minimumLineHeight = line; style.maximumLineHeight = line }
        if centered { style.alignment = .center }
        label.attributedText = NSAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color, .kern: kern, .paragraphStyle: style])
        return label
    }

    /// The reference's `SectionLabel` (components.tsx): 10 Bold, letter spacing 1.65, `muted`, upper case, 2 in.
    static func sectionLabel(_ text: String) -> UIView {
        let label = UILabel()
        label.attributedText = NSAttributedString(string: text.uppercased(), attributes: [.kern: 1.65, .font: UIFont.systemFont(ofSize: 10, weight: .bold), .foregroundColor: Theme.muted])
        label.accessibilityTraits = .header
        return inset(label, top: 0, side: 2, bottom: 0)
    }

    /// A card of glass (GlassSurface: `radius`, `padding` inside, `gap` between the parts; a SectionLabel first gets its
    /// 13 of margin on top of the gap). `clear`: `material="clear"`.
    static func glassCard(_ parts: [UIView], radius: CGFloat = 28, padding: CGFloat = 20, gap: CGFloat = 15, clear: Bool = false, labelled: Bool = false) -> UIView {
        let card = UIView()
        card.layer.cornerRadius = radius
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        let glass = UIVisualEffectView(effect: TabGlass.effect(clear: clear, interactive: false, dark: Theme.dark))
        glass.isUserInteractionEnabled = false
        glass.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(glass)
        let stack = UIStackView(arrangedSubviews: parts)
        stack.axis = .vertical
        stack.spacing = gap
        if labelled, let first = parts.first { stack.setCustomSpacing(gap + 13, after: first) }
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            glass.topAnchor.constraint(equalTo: card.topAnchor), glass.bottomAnchor.constraint(equalTo: card.bottomAnchor),
            glass.leadingAnchor.constraint(equalTo: card.leadingAnchor), glass.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: padding),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -padding),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: padding),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -padding),
        ])
        return card
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
        label.attributedText = NSAttributedString(string: text.uppercased(), attributes: [.kern: 1.2, .font: UIFont.systemFont(ofSize: 11, weight: ThemeStore.look.black ? .medium : .bold), .foregroundColor: Theme.muted])
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
    private let pageName: String
    private let large: Bool
    private var sideAction: (() -> Void)?
    // B: the pages with a back button have the reference's header (SettingsScreen.tsx `Page`): a glass pill
    // (radius 27, 12 from the edges, at least 60 tall, 8 inside) with a round glass back button and the name; the
    // list scrolls under it, with the scroll-edge effect behind (tabInset.tsx `FloatingHeader`).
    private var header: GlassHeaderView?
    private var sideButton: GlassRoundButton?
    private let headerEdge = ScrollEdgeView(edge: .top)
    private var columnTop: NSLayoutConstraint?

    init(name: String, large: Bool = false) {
        self.pageName = name
        self.large = large
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    /// A page whose reference has its own header and column (SecurityScreen.tsx); nil: the settings `Page` look.
    struct OwnLook {
        var side: CGFloat            // the header's margin at the sides
        var padding: CGFloat         // the pill's inner room
        var minHeight: CGFloat
        var clear: Bool              // `material="clear"`
        var titleFont: UIFont
        var titleKern: CGFloat
        var mark: String             // an Ionicons glyph at the right (in the accent), "" for none
        var markSize: CGFloat
        var markRoom: CGFloat        // room right of the mark
        var backLabel: String
        var columnSide: CGFloat
        var columnTop: CGFloat       // from the pill's bottom (+2) to the first part
        var columnBottom: CGFloat
    }
    var ownLook: OwnLook? { return nil }
    /// The reference: the root's column is 16 from the sides, a page's (`Page`, `padding: 14`) 14.
    private var columnSide: CGFloat { return ownLook?.columnSide ?? (large ? 16 : 14) }

    /// D: false — a large page without its big name (the root of Settings: the profile head is its top, as in the
    /// reference's `Root`). The column keeps its place under the status bar; the list runs up under it.
    var showsHeading: Bool { return true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        heading.text = pageName
        heading.textColor = Theme.text
        heading.font = Theme.title(Theme.TypeSize.pageTitleSize(pageName)) // Fonts: the reference's page title, 22 / 19 / 17 by length
        heading.adjustsFontSizeToFitWidth = true
        heading.minimumScaleFactor = 0.7
        heading.accessibilityTraits = .header
        heading.translatesAutoresizingMaskIntoConstraints = false
        if large && showsHeading { view.addSubview(heading) }

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
        let top = column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 8)
        columnTop = top
        var rules: [NSLayoutConstraint] = [
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            top,
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -(ownLook?.columnBottom ?? 30)),
            // The reference: the root's column is 16 from the sides, a page's (`Page`, `padding: 14`) 14.
            column.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: columnSide),
            column.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -columnSide),
            column.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -2 * columnSide),
        ]
        if large {
            if showsHeading {
                rules.append(heading.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8))
                rules.append(heading.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20))
                rules.append(heading.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -20))
                rules.append(heading.heightAnchor.constraint(equalToConstant: 41))
                rules.append(scroll.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 8))
            } else {
                // D: the column starts where it did under the big name (8 + 41 + 8 + 8 under the safe area).
                rules.append(scroll.topAnchor.constraint(equalTo: view.topAnchor))
            }
            // The list goes under the bar at the bottom; the room for the bar is left in `viewDidLayoutSubviews`.
            rules.append(scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor))
        } else {
            view.addSubview(headerEdge)
            let own = ownLook
            let made = GlassHeaderView(title: pageName, titleSize: Theme.TypeSize.pageTitleSize(pageName), lineHeight: 28,
                                       padding: own?.padding ?? 8, minHeight: own?.minHeight ?? 60, clear: own?.clear ?? false,
                                       back: { [weak self] () -> Void in self?.goBack() }, backLabel: own?.backLabel ?? "Назад")
            if let own {
                made.titleLabel.attributedText = NSAttributedString(string: pageName, attributes: [.font: own.titleFont, .kern: own.titleKern, .foregroundColor: Theme.text])
                if !own.mark.isEmpty { made.addMark(IonIcon.image(own.mark, size: own.markSize), room: own.markRoom) }
            }
            made.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(made)
            header = made
            let side = own?.side ?? 12
            rules.append(made.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12))
            rules.append(made.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: side))
            rules.append(made.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -side))
            rules.append(scroll.topAnchor.constraint(equalTo: view.topAnchor))
            // The page ends where the keyboard begins, so a field is never under it.
            rules.append(scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor))
        }
        NSLayoutConstraint.activate(rules)
        build()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let safeTop = view.safeAreaInsets.top
        if let header {
            // The list starts 7 + 16 under the pill (`paddingTop: headerHeight + 16`, the header's margin 7 below).
            let below = header.frame.maxY + (ownLook == nil ? 7 : 2)
            let wanted = below + (ownLook?.columnTop ?? 16) - 8
            if let columnTop, columnTop.constant != wanted { columnTop.constant = wanted }
            if scroll.verticalScrollIndicatorInsets.top != below { scroll.verticalScrollIndicatorInsets.top = below }
            headerEdge.color = Theme.bg
            headerEdge.place(width: view.bounds.width, size: below)
            view.bringSubviewToFront(headerEdge)
            view.bringSubviewToFront(header)
        } else if large && !showsHeading {
            let wanted = safeTop + 8 + 41 + 8 + 8
            if let columnTop, columnTop.constant != wanted { columnTop.constant = wanted }
        }
    }

    /// Subclasses put their content into `column` here.
    func build() {}

    private func goBack() {
        navigationController?.popViewController(animated: true)
    }

    /// An icon on the right of the header (pages with a back button only): a round glass button in the pill.
    func setSide(symbol: String, label: String, action: @escaping () -> Void) {
        sideAction = action
        if let sideButton {
            sideButton.setSymbol(symbol, size: symbol.hasPrefix("ion:") ? 19 : 17, weight: .medium)
            sideButton.accessibilityLabel = label
            return
        }
        sideButton = header?.addTool(symbol: symbol, label: label, iconSize: symbol.hasPrefix("ion:") ? 19 : 17) { [weak self] () -> Void in
            self?.sideAction?()
        }
    }

    func setSideEnabled(_ enabled: Bool) {
        sideButton?.isEnabled = enabled
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
            // The reference's `Group`: 16 between the parts of a page, 7 between the name and its card (the caption
            // has 8 of its own above).
            add(SettingsLook.caption(label), gap: 8)
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

/// Rows on one card (the reference's `Group`, SettingsScreen.tsx). «Чёрная» (`black` themes): a flat card of the
/// theme's `glassOpaque`, radius 12, a hairline `border` around it and between the rows from 57 in. Every other
/// theme: a glass surface, radius 20, 2 above and below the rows, no lines between them.
final class SettingsGroup: UIView {
    private let stack = UIStackView()

    init(rows: [UIView]) {
        super.init(frame: .zero)
        let flat = ThemeStore.look.black
        let hairline = 1 / UIScreen.main.scale
        layer.cornerCurve = .continuous
        layer.masksToBounds = true
        if flat {
            backgroundColor = ThemeStore.look.glassOpaque
            layer.cornerRadius = 12
            layer.borderWidth = hairline
            layer.borderColor = ThemeStore.look.border.cgColor
        } else {
            layer.cornerRadius = 20
            let glass = UIVisualEffectView(effect: TabGlass.effect(clear: false, interactive: false, dark: Theme.dark))
            glass.isUserInteractionEnabled = false
            glass.translatesAutoresizingMaskIntoConstraints = false
            glass.layer.cornerRadius = 20
            glass.layer.cornerCurve = .continuous
            glass.clipsToBounds = true
            addSubview(glass)
            NSLayoutConstraint.activate([
                glass.topAnchor.constraint(equalTo: topAnchor),
                glass.bottomAnchor.constraint(equalTo: bottomAnchor),
                glass.leadingAnchor.constraint(equalTo: leadingAnchor),
                glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            ])
        }
        stack.axis = .vertical
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        let pad: CGFloat = flat ? 0 : 2
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: pad),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -pad),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        for (index, row) in rows.enumerated() {
            if index > 0 && flat {
                let rule = UIView()
                rule.backgroundColor = ThemeStore.look.border
                rule.translatesAutoresizingMaskIntoConstraints = false
                let holder = UIView()
                holder.addSubview(rule)
                NSLayoutConstraint.activate([
                    holder.heightAnchor.constraint(equalToConstant: hairline),
                    rule.topAnchor.constraint(equalTo: holder.topAnchor),
                    rule.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
                    rule.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 57),
                    rule.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
                ])
                stack.addArrangedSubview(holder)
            }
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
    private var iconChip: UIView?

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
            // The reference's `Item`: a 34 circle of rgba(255,255,255,0.07) (dark) / rgba(0,0,0,0.05) (light), `dangerBg`
            // for «Выйти»; the Ionicons glyph 18 square in it.
            chip.backgroundColor = danger ? ThemeStore.look.dangerBg : Theme.veil(Theme.dark ? 0.07 : 0.05)
            chip.layer.cornerRadius = 17
            chip.translatesAutoresizingMaskIntoConstraints = false
            iconChip = chip
            let icon = UIImageView(image: SettingsLook.symbol(symbol, size: symbol.hasPrefix("ion:") ? 18 : 15, weight: .medium))
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
            // The reference: `<View style={{ width: 22 }}>` holding Ionicons «checkmark» 20 in the accent.
            let mark = UIImageView(image: IonIcon.image("checkmark", size: 20))
            mark.tintColor = Theme.accent
            mark.contentMode = .center
            mark.alpha = checked ? 1 : 0
            mark.translatesAutoresizingMaskIntoConstraints = false
            mark.widthAnchor.constraint(equalToConstant: 22).isActive = true
            mark.setContentHuggingPriority(.required, for: .horizontal)
            content.addArrangedSubview(mark)
            if checked { accessibilityTraits.insert(.selected) }
        } else if arrow && !danger {
            // Ionicons «chevron-forward» 17 in `subtle`.
            let chevron = UIImageView(image: IonIcon.image("chevron-forward", size: 17))
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
        didSet {
            // The reference's `Item`: rgba(127,127,127,0.12) under the finger; the icon squishes to 0.82 (spring damping
            // 14, stiffness 420) and springs back (damping 9, stiffness 260).
            backgroundColor = isHighlighted ? UIColor(red: 127 / 255, green: 127 / 255, blue: 127 / 255, alpha: 0.12) : .clear
            guard isHighlighted != oldValue, let chip = iconChip else { return }
            let spring = isHighlighted ? UISpringTimingParameters(mass: 1, stiffness: 420, damping: 14, initialVelocity: .zero)
                : UISpringTimingParameters(mass: 1, stiffness: 260, damping: 9, initialVelocity: .zero)
            let animator = UIViewPropertyAnimator(duration: 0.5, timingParameters: spring)
            let target: CGAffineTransform = isHighlighted ? CGAffineTransform(scaleX: 0.82, y: 0.82) : .identity
            animator.addAnimations { () -> Void in chip.transform = target }
            animator.startAnimation()
        }
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
        SettingsLook.paint(toggle)
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

    /// The reference's `Notice` (components.tsx): glass, radius 18, 14 inside; Ionicons «alert-circle-outline» (an
    /// error, in `danger` over `dangerBg`) or «information-circle-outline» (in the accent) 19, 10 to the words (13,
    /// line 19); «Повторить» on the right (12 Bold, the accent).
    init(_ text: String, error: Bool = false, onRetry: (() -> Void)? = nil) {
        super.init(frame: .zero)
        retry = onRetry
        layer.cornerRadius = 18
        layer.cornerCurve = .continuous
        clipsToBounds = true
        let glass = UIVisualEffectView(effect: TabGlass.effect(clear: false, interactive: false, dark: Theme.dark))
        glass.isUserInteractionEnabled = false
        glass.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glass)
        let tint = UIView()
        tint.backgroundColor = error ? ThemeStore.look.dangerBg : .clear
        tint.isUserInteractionEnabled = false
        tint.translatesAutoresizingMaskIntoConstraints = false
        addSubview(tint)
        let icon = UIImageView(image: IonIcon.image(error ? "alert-circle-outline" : "information-circle-outline", size: 19))
        icon.tintColor = error ? Theme.danger : Theme.accent
        icon.setContentHuggingPriority(.required, for: .horizontal)
        icon.setContentCompressionResistancePriority(.required, for: .horizontal)
        let label = UILabel()
        label.numberOfLines = 0
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 19
        style.maximumLineHeight = 19
        label.attributedText = NSAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: error ? Theme.danger : Theme.text, .paragraphStyle: style])
        let content = UIStackView(arrangedSubviews: [icon, label])
        content.axis = .horizontal
        content.alignment = .top
        content.spacing = 10
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            glass.topAnchor.constraint(equalTo: topAnchor), glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            glass.leadingAnchor.constraint(equalTo: leadingAnchor), glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            tint.topAnchor.constraint(equalTo: topAnchor), tint.bottomAnchor.constraint(equalTo: bottomAnchor),
            tint.leadingAnchor.constraint(equalTo: leadingAnchor), tint.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
        ])
        if onRetry != nil {
            let again = UIButton(type: .system)
            again.setTitle("Повторить", for: .normal)
            again.setTitleColor(Theme.accent, for: .normal)
            again.titleLabel?.font = .systemFont(ofSize: 12, weight: .bold)
            again.setContentHuggingPriority(.required, for: .horizontal)
            again.setContentCompressionResistancePriority(.required, for: .horizontal)
            again.heightAnchor.constraint(greaterThanOrEqualToConstant: 28).isActive = true
            again.addTarget(self, action: #selector(retryPressed), for: .touchUpInside)
            content.addArrangedSubview(again)
        }
        isAccessibilityElement = onRetry == nil
        accessibilityLabel = text
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
    private let kind: Kind
    private let gradient = CAGradientLayer()
    private let shine = CAGradientLayer()
    private let glass = UIVisualEffectView(effect: nil)

    /// The reference's `Button` (components.tsx): 54 tall, radius 21; the main one is the theme's `accentGradient`
    /// (0 0 → 0.9 1, opacity 0.96) with a white shine (0.22 → clear, 0 0 → 0.4 0.65) and a 1 border; the quiet one
    /// regular glass; the dangerous one `dangerBg`. The label 16 Bold, letter spacing −0.15; an Ionicons `icon` 20,
    /// 10 before it. Pressed it springs to 0.96; disabled it fades to 0.45.
    init(label: String, kind: Kind = .primary, icon: String = "") {
        self.kind = kind
        super.init(frame: .zero)
        layer.cornerRadius = 21
        layer.cornerCurve = .continuous
        clipsToBounds = true
        let ink: UIColor
        switch kind {
        case .primary:
            ink = Theme.onAccent
            let colors = ThemeStore.look.accentGradient.isEmpty ? [Theme.accent, Theme.accent] : ThemeStore.look.accentGradient
            gradient.colors = colors.map { (color: UIColor) -> CGColor in color.cgColor }
            gradient.startPoint = CGPoint(x: 0, y: 0)
            gradient.endPoint = CGPoint(x: 0.9, y: 1)
            gradient.opacity = 0.96
            layer.insertSublayer(gradient, at: 0)
            shine.colors = [UIColor(white: 1, alpha: 0.22).cgColor, UIColor(white: 1, alpha: 0).cgColor]
            shine.startPoint = CGPoint(x: 0, y: 0)
            shine.endPoint = CGPoint(x: 0.4, y: 0.65)
            layer.insertSublayer(shine, above: gradient)
            layer.borderWidth = 1
            layer.borderColor = (Theme.dark ? UIColor(red: 235 / 255, green: 245 / 255, blue: 1, alpha: 0.58) : UIColor(white: 1, alpha: 0.35)).cgColor
        case .secondary:
            ink = Theme.text
            glass.effect = TabGlass.effect(clear: false, interactive: true, dark: Theme.dark)
            glass.isUserInteractionEnabled = false
            glass.frame = bounds
            glass.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            insertSubview(glass, at: 0)
        case .danger:
            ink = Theme.danger
            backgroundColor = ThemeStore.look.dangerBg
        }
        var look = UIButton.Configuration.plain()
        look.title = label
        look.baseForegroundColor = ink
        if !icon.isEmpty {
            look.image = SettingsLook.symbol(icon.hasPrefix("ion:") ? icon : "ion:" + icon, size: 20)
            look.imagePadding = 10
        }
        look.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 21, bottom: 0, trailing: 21)
        look.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { (incoming: AttributeContainer) -> AttributeContainer in
            var outgoing = incoming
            outgoing.font = UIFont.systemFont(ofSize: 16, weight: .bold)
            outgoing.kern = -0.15
            return outgoing
        }
        configuration = look
        heightAnchor.constraint(equalToConstant: 54).isActive = true
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
        Bouncy.attach(self, scale: 0.96)
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        gradient.frame = bounds
        shine.frame = bounds
        if let back = glass.superview, back === self { sendSubviewToBack(glass) }
    }

    override var isEnabled: Bool {
        didSet { alpha = isEnabled ? 1 : 0.45 }
    }

    func setBusy(_ busy: Bool) {
        configuration?.showsActivityIndicator = busy
        isEnabled = !busy
        if busy { alpha = 1 }
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
    private weak var fieldPlate: UIView?

    init(caption: String, placeholder: String, secret: Bool = false) {
        input = secret ? ManualTextField() : UITextField()
        super.init(frame: .zero)
        let name = UILabel()
        name.attributedText = NSAttributedString(string: caption.uppercased(), attributes: [.kern: 1.0, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        name.numberOfLines = 0
        name.isHidden = caption.isEmpty
        // The reference's ManualField: regular glass, radius 18, at least 54 tall, 17 inside, a 1.4 accent border while typing.
        let plate = UIView()
        plate.layer.cornerRadius = 18
        plate.layer.cornerCurve = .continuous
        plate.layer.borderColor = Theme.accent.cgColor
        plate.clipsToBounds = true
        let glass = UIVisualEffectView(effect: TabGlass.effect(clear: false, interactive: false, dark: Theme.dark))
        glass.isUserInteractionEnabled = false
        glass.translatesAutoresizingMaskIntoConstraints = false
        plate.addSubview(glass)
        NSLayoutConstraint.activate([
            glass.topAnchor.constraint(equalTo: plate.topAnchor), glass.bottomAnchor.constraint(equalTo: plate.bottomAnchor),
            glass.leadingAnchor.constraint(equalTo: plate.leadingAnchor), glass.trailingAnchor.constraint(equalTo: plate.trailingAnchor),
        ])
        fieldPlate = plate
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
        eye.setImage(SettingsLook.symbol("ion:eye-outline", size: 23), for: .normal)
        eye.tintColor = Theme.muted
        eye.accessibilityLabel = "Показать"
        eye.isHidden = !secret
        eye.addTarget(self, action: #selector(eyePressed), for: .touchUpInside)
        eye.translatesAutoresizingMaskIntoConstraints = false
        plate.addSubview(eye)
        if secret { GlassBacking.put(under: eye) }
        NSLayoutConstraint.activate([
            plate.heightAnchor.constraint(equalToConstant: 54),
            input.leadingAnchor.constraint(equalTo: plate.leadingAnchor, constant: 17),
            input.topAnchor.constraint(equalTo: plate.topAnchor),
            input.bottomAnchor.constraint(equalTo: plate.bottomAnchor),
            input.trailingAnchor.constraint(equalTo: plate.trailingAnchor, constant: secret ? -58 : -17),
            // SecretInput: the eye is the reference's IconButton — a 44 round of clear glass, 5 from the top and the right.
            eye.trailingAnchor.constraint(equalTo: plate.trailingAnchor, constant: -5),
            eye.topAnchor.constraint(equalTo: plate.topAnchor, constant: 5),
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
        eye.setImage(SettingsLook.symbol(input.isSecureTextEntry ? "ion:eye-outline" : "ion:eye-off-outline", size: 23), for: .normal)
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

    func textFieldDidBeginEditing(_ textField: UITextField) {
        fieldPlate?.layer.borderWidth = 1.4
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        fieldPlate?.layer.borderWidth = 0
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

/// The reference's back chevron (components.tsx `BackChevron`, drawn instead of the Ionicons glyph): taller and
/// thinner, round caps, its point nudged 5% to the left — h 0.78, w 0.39, stroke max(1.6, 0.095) of the size.
enum BackChevronGlyph {
    private static var cache: [CGFloat: UIImage] = [:]

    static func image(size: CGFloat) -> UIImage {
        if let made = cache[size] { return made }
        let height = size * 0.78, width = size * 0.39, stroke = max(1.6, size * 0.095)
        let cx = size / 2 - size * 0.05, cy = size / 2
        let made = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { (_: UIGraphicsImageRendererContext) -> Void in
            let path = UIBezierPath()
            path.move(to: CGPoint(x: cx + width / 2, y: cy - height / 2))
            path.addLine(to: CGPoint(x: cx - width / 2, y: cy))
            path.addLine(to: CGPoint(x: cx + width / 2, y: cy + height / 2))
            path.lineWidth = stroke
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            UIColor.black.setStroke()
            path.stroke()
        }.withRenderingMode(.alwaysTemplate)
        cache[size] = made
        return made
    }
}
