import UIKit

/// ChatsPlus: the reference's `Empty` (components.tsx): an icon on a tilted glass tile over a softer tilted one,
/// a title, a line of words and, when there is something to do, a button. Used by the chat list («Начни разговор»,
/// «Чат не найден», «Всё прочитано», «Здесь пока пусто»), «Избранное» and «Звонки».
final class EmptyStateView: UIView {
    private let back = UIView()
    private let tile = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
    private let icon = UIImageView()
    private let titleLabel = UILabel()
    private let wordsLabel = UILabel()
    private let button = UIButton(type: .system)
    private var action: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        back.layer.cornerRadius = 47
        back.layer.cornerCurve = .continuous
        back.layer.borderWidth = 1
        back.transform = CGAffineTransform(rotationAngle: -15 * .pi / 180)
        addSubview(back)
        tile.layer.cornerRadius = 34
        tile.layer.cornerCurve = .continuous
        tile.clipsToBounds = true
        tile.layer.borderWidth = 1
        tile.transform = CGAffineTransform(rotationAngle: -5 * .pi / 180)
        addSubview(tile)
        icon.contentMode = .center
        tile.contentView.addSubview(icon)
        titleLabel.font = AppFont.title(21)
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0
        addSubview(titleLabel)
        wordsLabel.font = AppFont.text(15)
        wordsLabel.textAlignment = .center
        wordsLabel.numberOfLines = 0
        addSubview(wordsLabel)
        // The reference's `Button`: 54 tall, radius 21, the words 16 bold (−0.15), the glyph 20 ten before them.
        button.titleLabel?.font = AppFont.text(16, .bold)
        button.layer.cornerRadius = 21
        button.titleEdgeInsets = UIEdgeInsets(top: 0, left: 10, bottom: 0, right: -10)
        button.layer.cornerCurve = .continuous
        button.addTarget(self, action: #selector(pressed), for: .touchUpInside)
        addSubview(button)
        paint()
    }

    required init?(coder: NSCoder) { return nil }

    /// `symbol`: an SF Symbol; `button`: the words of the button (empty: none) and what it does.
    func show(symbol: String, title: String, words: String, button words2: String = "", buttonSymbol: String = "plus", action: (() -> Void)? = nil) {
        // "ion:<name>": the reference's own Ionicons glyph (Design/IonIcon.swift).
        icon.image = symbol.hasPrefix("ion:") ? IonIcon.image(String(symbol.dropFirst(4)), size: 35).withRenderingMode(.alwaysTemplate)
            : UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 33, weight: .regular))
        titleLabel.attributedText = NSAttributedString(string: title, attributes: [.kern: AppFont.titleKern, .font: AppFont.title(21)])
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 4
        style.alignment = .center
        wordsLabel.attributedText = NSAttributedString(string: words, attributes: [.paragraphStyle: style, .font: AppFont.text(15)])
        button.isHidden = words2.isEmpty || action == nil
        button.setAttributedTitle(NSAttributedString(string: words2, attributes: [.font: AppFont.text(16, .bold), .kern: -0.15, .foregroundColor: Theme.onAccent]), for: .normal)
        let glyph = buttonSymbol == "plus" ? "add" : (buttonSymbol.hasPrefix("ion:") ? String(buttonSymbol.dropFirst(4)) : buttonSymbol)
        button.setImage(IonIcon.has(glyph) ? IonIcon.image(glyph, size: 20) : UIImage(systemName: buttonSymbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        self.action = action
        accessibilityLabel = title + ". " + words
        paint()
        setNeedsLayout()
    }

    func paint() {
        back.backgroundColor = ThemeStore.look.accentSoft
        back.layer.borderColor = Theme.veil(0.12).cgColor
        tile.layer.borderColor = Theme.veil(0.14).cgColor
        tile.effect = UIBlurEffect(style: Theme.dark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight)
        icon.tintColor = Theme.accent
        titleLabel.textColor = Theme.text
        wordsLabel.textColor = Theme.muted
        button.backgroundColor = Theme.accent
        button.tintColor = Theme.onAccent
        button.setTitleColor(Theme.onAccent, for: .normal)
    }

    /// The height the content takes at this width.
    func height(for width: CGFloat) -> CGFloat {
        let inner = min(310, width - 56)
        let title = titleLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height
        let words = wordsLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height
        return 38 + 126 + 8 + 13 + title + 13 + words + (button.isHidden ? 0 : 13 + 11 + 54) + 38
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        let inner = min(310, width - 56)
        var y = max(0, (bounds.height - height(for: width)) / 2) + 38
        let art = CGRect(x: (width - 126) / 2, y: y, width: 126, height: 126)
        back.bounds = CGRect(x: 0, y: 0, width: 126, height: 126)
        back.center = CGPoint(x: art.midX, y: art.midY)
        tile.bounds = CGRect(x: 0, y: 0, width: 94, height: 94)
        tile.center = back.center
        icon.frame = tile.contentView.bounds
        y = art.maxY + 8 + 13
        let title = titleLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height
        titleLabel.frame = CGRect(x: (width - inner) / 2, y: y, width: inner, height: ceil(title))
        y = titleLabel.frame.maxY + 13
        let words = wordsLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height
        wordsLabel.frame = CGRect(x: (width - inner) / 2, y: y, width: inner, height: ceil(words))
        y = wordsLabel.frame.maxY + 13 + 11
        let buttonWidth = min(270, width - 56)
        button.frame = CGRect(x: (width - buttonWidth) / 2, y: y, width: buttonWidth, height: 54)
    }

    @objc private func pressed() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        action?()
    }
}
