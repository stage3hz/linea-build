import UIKit

/// Glass parts of the reference's pages (mobile/src/components.tsx `IconButton`, the headers of SettingsScreen.tsx
/// `Page`, PeopleScreen.tsx and communities/CommunitiesScreen.tsx). Every glass surface here is a rounded
/// UIVisualEffectView, so «Ледяное стекло» puts its rime on it (Effects/EffectsHost.swift `placeRime`).

/// The reference's `IconButton`: a 44-point round of clear, interactive glass with an icon; pressed it springs to
/// 0.86 (`Bouncy scaleTo={.86}`). `filled`: the accent round of «Создать» (42, the accent, the icon in `onAccent`).
final class GlassRoundButton: UIControl {
    var onPress: (() -> Void)?
    private let glass = UIVisualEffectView(effect: nil)
    private let icon = UIImageView()
    private let filled: Bool
    private let side: CGFloat

    init(symbol: String, label: String, iconSize: CGFloat = 19, weight: UIImage.SymbolWeight = .regular, filled: Bool = false, side: CGFloat = 44) {
        self.filled = filled
        self.side = side
        super.init(frame: CGRect(x: 0, y: 0, width: side, height: side))
        if filled {
            backgroundColor = Theme.accent
            icon.tintColor = Theme.onAccent
        } else {
            glass.effect = TabGlass.effect(clear: true, interactive: true, dark: Theme.dark)
            glass.clipsToBounds = true
            glass.layer.cornerCurve = .continuous
            glass.isUserInteractionEnabled = false
            addSubview(glass)
            icon.tintColor = Theme.text
        }
        layer.cornerCurve = .continuous
        icon.contentMode = .center
        icon.isUserInteractionEnabled = false
        addSubview(icon)
        setSymbol(symbol, size: iconSize, weight: weight)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = label
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
        Bouncy.attach(self, scale: 0.86)
    }

    required init?(coder: NSCoder) { return nil }

    func setSymbol(_ symbol: String, size: CGFloat = 19, weight: UIImage.SymbolWeight = .regular) {
        // "ion:<name>": the reference's own Ionicons glyph, `size` points square (Design/IonIcon.swift).
        // «ion:chevron-back» is the reference's own drawn chevron (components.tsx `BackChevron`).
        if symbol == "ion:chevron-back" { icon.image = BackChevronGlyph.image(size: size); return }
        if symbol.hasPrefix("ion:") { icon.image = IonIcon.image(String(symbol.dropFirst(4)), size: size); return }
        icon.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: weight))
    }

    /// The icon's colour (the reference's `color`; the text colour by default).
    func setTint(_ color: UIColor) {
        icon.tintColor = color
    }

    override var intrinsicContentSize: CGSize { CGSize(width: side, height: side) }

    override var isEnabled: Bool {
        didSet { alpha = isEnabled ? 1 : 0.45 }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let radius = min(bounds.width, bounds.height) / 2
        if filled {
            layer.cornerRadius = radius
        } else {
            glass.frame = bounds
            glass.layer.cornerRadius = radius
        }
        icon.frame = bounds
    }

    @objc private func pressed() {
        onPress?()
    }
}

/// The header pill of the reference's pages: a glass pill (radius 27) holding — left to right — an optional round
/// back button, the page's name in the title face with an optional quiet line under it, and round glass buttons on
/// the right. The owner places the view (the pill fills it); the settings pages put it 12 from the edges and the
/// safe area, the sections 14 from the sides and 12 under the safe area.
final class GlassHeaderView: UIView {
    let pill = GlassPill(interactive: false)
    let titleLabel = UILabel()
    let subtitleLabel = UILabel()
    private(set) var backButton: GlassRoundButton?
    private let row = UIStackView()
    private let texts = UIStackView()
    private let tools = UIStackView()

    /// - Parameters:
    ///   - titleSize: the name's size (settings pages: 22 / 19 / 17 by length; the sections: 26).
    ///   - lineHeight: the name's line (28 on the settings pages, 32 in the sections).
    ///   - subtitleSize: the quiet line's size (11 «Люди», 12 «Каналы»).
    ///   - padding: the pill's inner room (8 on the settings pages, 10 in the sections).
    ///   - minHeight: the pill's least height (60 / 64 / 72).
    init(title: String, subtitle: String = "", titleSize: CGFloat, lineHeight: CGFloat, subtitleSize: CGFloat = 12,
         padding: CGFloat, minHeight: CGFloat, clear: Bool = false, back: (() -> Void)? = nil, backLabel: String = "Назад") {
        super.init(frame: .zero)
        backgroundColor = .clear
        pill.shape(radius: 27)
        // `material="clear"` (the sections' headers) or the default «regular» (the settings pages).
        if clear { pill.effect = TabGlass.effect(clear: true, interactive: false, dark: Theme.dark) }
        pill.translatesAutoresizingMaskIntoConstraints = false
        addSubview(pill)

        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 9
        row.translatesAutoresizingMaskIntoConstraints = false
        pill.contentView.addSubview(row)

        if let back {
            let button = GlassRoundButton(symbol: "ion:chevron-back", label: backLabel, iconSize: 23) // IconButton «chevron-back», 23
            button.onPress = back
            button.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                button.widthAnchor.constraint(equalToConstant: 44),
                button.heightAnchor.constraint(equalToConstant: 44),
            ])
            row.addArrangedSubview(button)
            backButton = button
        }

        titleLabel.text = title
        titleLabel.textColor = Theme.text
        titleLabel.font = Theme.title(titleSize)
        titleLabel.numberOfLines = 1
        titleLabel.adjustsFontSizeToFitWidth = true
        titleLabel.minimumScaleFactor = 0.62
        titleLabel.accessibilityTraits = .header
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.heightAnchor.constraint(equalToConstant: lineHeight).isActive = true
        subtitleLabel.text = subtitle
        subtitleLabel.textColor = Theme.muted
        subtitleLabel.font = AppFont.text(subtitleSize)
        subtitleLabel.numberOfLines = 1
        subtitleLabel.isHidden = subtitle.isEmpty
        texts.axis = .vertical
        texts.spacing = back == nil ? 4 : 0
        texts.addArrangedSubview(titleLabel)
        texts.addArrangedSubview(subtitleLabel)
        texts.setContentHuggingPriority(.defaultLow, for: .horizontal)
        texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        row.addArrangedSubview(texts)

        tools.axis = .horizontal
        tools.alignment = .center
        tools.spacing = 9
        tools.setContentHuggingPriority(.required, for: .horizontal)
        tools.setContentCompressionResistancePriority(.required, for: .horizontal)
        tools.isHidden = true
        row.addArrangedSubview(tools)

        NSLayoutConstraint.activate([
            pill.topAnchor.constraint(equalTo: topAnchor),
            pill.bottomAnchor.constraint(equalTo: bottomAnchor),
            pill.leadingAnchor.constraint(equalTo: leadingAnchor),
            pill.trailingAnchor.constraint(equalTo: trailingAnchor),
            pill.heightAnchor.constraint(greaterThanOrEqualToConstant: minHeight),
            row.topAnchor.constraint(greaterThanOrEqualTo: pill.contentView.topAnchor, constant: padding),
            row.bottomAnchor.constraint(lessThanOrEqualTo: pill.contentView.bottomAnchor, constant: -padding),
            row.centerYAnchor.constraint(equalTo: pill.contentView.centerYAnchor),
            // Without a back button the words stand 6 further in (`paddingLeft: 6`).
            row.leadingAnchor.constraint(equalTo: pill.contentView.leadingAnchor, constant: back == nil ? padding + 6 : padding),
            row.trailingAnchor.constraint(equalTo: pill.contentView.trailingAnchor, constant: -padding),
        ])
        let snug = pill.heightAnchor.constraint(equalToConstant: minHeight)
        snug.priority = .defaultLow
        snug.isActive = true
    }

    required init?(coder: NSCoder) { return nil }

    func setTitle(_ title: String) {
        titleLabel.text = title
    }

    func setSubtitle(_ subtitle: String) {
        subtitleLabel.text = subtitle
        subtitleLabel.isHidden = subtitle.isEmpty
    }

    /// A plain glyph at the right in the accent, `room` from the pill's padding (SecurityScreen.tsx: the shield, 10).
    func addMark(_ image: UIImage, room: CGFloat) {
        let mark = UIImageView(image: image)
        mark.tintColor = Theme.accent
        mark.contentMode = .center
        mark.isAccessibilityElement = false
        let holder = UIView()
        holder.addSubview(mark)
        mark.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            mark.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
            mark.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -room),
            mark.topAnchor.constraint(equalTo: holder.topAnchor),
            mark.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
        tools.addArrangedSubview(holder)
        tools.isHidden = false
    }

    /// A round button on the right (glass; `filled`: the accent round of «Создать», 42).
    @discardableResult
    func addTool(symbol: String, label: String, filled: Bool = false, iconSize: CGFloat = 19, action: @escaping () -> Void) -> GlassRoundButton {
        let side: CGFloat = filled ? 42 : 44
        let button = GlassRoundButton(symbol: symbol, label: label, iconSize: filled ? 21 : iconSize, weight: filled ? .medium : .regular, filled: filled, side: side)
        button.onPress = action
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: side),
            button.heightAnchor.constraint(equalToConstant: side),
        ])
        tools.addArrangedSubview(button)
        tools.isHidden = false
        return button
    }
}

/// The reference's search field on glass (PeopleScreen.tsx, MusicScreen.tsx: GlassSurface «regular», radius 24,
/// at least 54 tall, 15 inside, the accent magnifier (21) 10 before the words).
final class GlassSearchField: UIView {
    let pill = GlassPill(interactive: false)
    let icon = UIImageView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        pill.shape(radius: 24)
        addSubview(pill)
        icon.image = IonIcon.image("search-outline", size: 21) // the reference's own glyph, 21
        icon.tintColor = Theme.accent
        icon.contentMode = .center
        pill.contentView.addSubview(icon)
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        pill.frame = bounds
        icon.frame = CGRect(x: 15, y: 0, width: 21, height: bounds.height)
    }

    /// Where the words go (after the magnifier and 10 of room).
    var wordsLeft: CGFloat { return 15 + 21 + 10 }
}

/// A round of clear glass under the icon of a plain button that keeps its own target or menu (the reference's
/// `IconButton` look for a UIButton): fills the button, never takes touches.
final class GlassBacking: UIVisualEffectView {
    /// A fixed corner radius (a wide button); nil: a round (half the shorter side).
    var radius: CGFloat?

    @discardableResult
    static func put(under button: UIButton, side: CGFloat = 44, scale: CGFloat = 0.86, clear: Bool = true) -> GlassBacking {
        let glass = GlassBacking(effect: TabGlass.effect(clear: clear, interactive: false, dark: Theme.dark))
        glass.frame = button.bounds // follows the button's size from here on
        glass.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        glass.clipsToBounds = true
        glass.layer.cornerRadius = side / 2
        glass.layer.cornerCurve = .continuous
        glass.isUserInteractionEnabled = false
        glass.layer.zPosition = -1 // drawn behind the button's own image and title views, whenever they are made
        button.insertSubview(glass, at: 0)
        Bouncy.attach(button, scale: scale)
        return glass
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let wanted = radius ?? min(bounds.width, bounds.height) / 2
        if layer.cornerRadius != wanted { layer.cornerRadius = wanted }
        // The button's image view may be made after the glass: the glass stays at the back.
        if let holder = superview, holder.subviews.first !== self { holder.sendSubviewToBack(self) }
    }
}
