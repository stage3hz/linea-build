import UIKit

// The small parts of a chat's screen that the actions on messages need: the field that grows with its text, the
// bar above it (an answer, an edit, a forward), the pinned message's bar, the way down, a short notice, and the
// two bars of the multi-select.

func chatGlass() -> UIVisualEffect { TabGlass.effect(clear: false, interactive: false, dark: Theme.dark) }

func chatSymbol(_ name: String, _ size: CGFloat, _ weight: UIImage.SymbolWeight = .regular) -> UIImage? {
    // "ion:<name>": the reference's own Ionicons glyph, `size` points square (Design/IonIcon.swift).
    if name.hasPrefix("ion:") { return IonIcon.image(String(name.dropFirst(4)), size: size) }
    return UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: weight))
}

/// The field a message is written in: several lines, growing with the text up to a height and scrolling past it
/// (the reference's composer: one line at first, at most 136 pt of text).
final class ComposerField: UITextView {
    // Composer: the reference's field — at least 40 pt, at most 140 (ChatScreen.tsx `minHeight 40, maxHeight 140`).
    static let lowest: CGFloat = 40
    static let highest: CGFloat = 140
    private let hintLabel = UILabel()

    /// The quiet words shown while the field is empty.
    var hintWords = "" {
        didSet { hintLabel.text = hintWords }
    }

    init() {
        super.init(frame: .zero, textContainer: nil)
        backgroundColor = .clear
        font = .systemFont(ofSize: 17)
        textColor = Theme.text
        tintColor = Theme.text
        keyboardAppearance = Theme.dark ? .dark : .light
        textContainerInset = UIEdgeInsets(top: 10, left: 0, bottom: 9, right: 0) // Composer: 17 pt text in a 40 pt pill
        textContainer.lineFragmentPadding = 0
        isScrollEnabled = false
        showsVerticalScrollIndicator = false
        hintLabel.font = .systemFont(ofSize: 17)
        hintLabel.textColor = Theme.muted
        hintLabel.isUserInteractionEnabled = false
        addSubview(hintLabel)
        NotificationCenter.default.addObserver(self, selector: #selector(wordsChanged), name: UITextView.textDidChangeNotification, object: self)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override var text: String! {
        didSet { wordsChanged() }
    }

    @objc private func wordsChanged() {
        hintLabel.isHidden = !(text ?? "").isEmpty
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        hintLabel.frame = CGRect(x: 0, y: textContainerInset.top, width: bounds.width, height: ceil(hintLabel.font.lineHeight))
    }

    /// The height the field asks for at this width: its text, within the two limits.
    func wantedHeight(width: CGFloat) -> CGFloat {
        let fit = sizeThatFits(CGSize(width: max(1, width), height: CGFloat.greatestFiniteMagnitude)).height
        return min(ComposerField.highest, max(ComposerField.lowest, ceil(fit)))
    }

    /// Whether the text is taller than the field may be (it scrolls then).
    func overflows(width: CGFloat) -> Bool {
        sizeThatFits(CGSize(width: max(1, width), height: CGFloat.greatestFiniteMagnitude)).height > ComposerField.highest
    }
}

/// The bar above the field: «Ответ …», «Редактирование» or «Переслать сообщение», with the line it is about and
/// a cross that calls it off.
final class ComposerBar: UIVisualEffectView {
    static let height: CGFloat = 50
    private let mark = UIImageView()
    private let stripe = UIView()
    private let headingLabel = UILabel()
    private let wordsLabel = UILabel()
    private let closeButton = UIButton(type: .system)
    var onClose: (() -> Void)?

    init() {
        super.init(effect: nil)
        clipsToBounds = true
        layer.cornerRadius = 22
        layer.cornerCurve = .continuous
        mark.tintColor = Theme.accent
        mark.contentMode = .center
        contentView.addSubview(mark)
        stripe.backgroundColor = Theme.accent
        stripe.layer.cornerRadius = 1.5
        contentView.addSubview(stripe)
        headingLabel.font = .systemFont(ofSize: 12, weight: .bold)
        headingLabel.textColor = Theme.accent
        contentView.addSubview(headingLabel)
        wordsLabel.font = .systemFont(ofSize: 13)
        wordsLabel.textColor = Theme.muted
        contentView.addSubview(wordsLabel)
        closeButton.setImage(chatSymbol("xmark", 14, .semibold), for: .normal)
        closeButton.tintColor = Theme.muted
        closeButton.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        contentView.addSubview(closeButton)
    }

    required init?(coder: NSCoder) { return nil }

    func show(symbol: String, heading: String, words: String, closeWords: String) {
        if effect == nil { effect = chatGlass() }
        mark.image = chatSymbol(symbol, 16)
        headingLabel.text = heading
        wordsLabel.text = words
        closeButton.accessibilityLabel = closeWords
    }

    @objc private func closeNow() { onClose?() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let height = bounds.height, width = bounds.width
        mark.frame = CGRect(x: 10, y: 0, width: 28, height: height)
        stripe.frame = CGRect(x: 44, y: 9, width: 3, height: height - 18)
        headingLabel.frame = CGRect(x: 56, y: 8, width: max(0, width - 56 - 44), height: 16)
        wordsLabel.frame = CGRect(x: 56, y: 25, width: max(0, width - 56 - 44), height: 17)
        closeButton.frame = CGRect(x: width - 44, y: (height - 44) / 2, width: 44, height: 44)
    }
}

/// The pinned message under the header: «Закреплённое сообщение» over its first line; a touch goes to the
/// message, the cross unpins it.
final class PinnedBar: UIVisualEffectView {
    static let height: CGFloat = 56
    private let stripe = UIView()
    private let headingLabel = UILabel()
    private let wordsLabel = UILabel()
    private let openButton = UIButton(type: .custom)
    private let unpinButton = UIButton(type: .system)
    var onOpen: (() -> Void)?
    var onUnpin: (() -> Void)?

    init() {
        super.init(effect: nil)
        clipsToBounds = true
        layer.cornerRadius = 26
        layer.cornerCurve = .continuous
        stripe.backgroundColor = Theme.text.withAlphaComponent(0.9)
        stripe.layer.cornerRadius = 1.25 // borderRadius 2 on a 2.5-point line: a capsule
        contentView.addSubview(stripe)
        headingLabel.text = "Закреплённое сообщение"
        headingLabel.font = .systemFont(ofSize: 15, weight: .medium)
        headingLabel.textColor = Theme.text
        contentView.addSubview(headingLabel)
        wordsLabel.font = .systemFont(ofSize: 15)
        wordsLabel.textColor = Theme.muted
        contentView.addSubview(wordsLabel)
        openButton.accessibilityLabel = "Перейти к закреплённому сообщению"
        openButton.addTarget(self, action: #selector(openNow), for: .touchUpInside)
        contentView.addSubview(openButton)
        unpinButton.setImage(chatSymbol("ion:close", 22), for: .normal) // <Icon name="close" size={22} color={t.muted}>
        unpinButton.tintColor = Theme.muted
        unpinButton.accessibilityLabel = "Открепить"
        unpinButton.addTarget(self, action: #selector(unpinNow), for: .touchUpInside)
        contentView.addSubview(unpinButton)
    }

    required init?(coder: NSCoder) { return nil }

    func show(words: String) {
        if effect == nil { effect = chatGlass() }
        wordsLabel.text = words
    }

    @objc private func openNow() { onOpen?() }
    @objc private func unpinNow() { onUnpin?() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        // ChatScreen.tsx: padding 16, the 2.5 × 34 line, 12 to the words; two 15-point lines 1 apart, centred.
        stripe.frame = CGRect(x: 16, y: (bounds.height - 34) / 2, width: 2.5, height: 34)
        let line = ceil(UIFont.systemFont(ofSize: 15).lineHeight)
        let top = (bounds.height - 2 * line - 1) / 2
        headingLabel.frame = CGRect(x: 30.5, y: top, width: max(0, width - 30.5 - 50), height: line)
        wordsLabel.frame = CGRect(x: 30.5, y: top + line + 1, width: max(0, width - 30.5 - 50), height: line)
        openButton.frame = CGRect(x: 0, y: 0, width: max(0, width - 50), height: bounds.height)
        unpinButton.frame = CGRect(x: width - 50, y: 6, width: 44, height: 44)
    }
}

/// The round button that takes the list down to its newest message, with the number of messages that came
/// while it was scrolled away.
final class DownButton: UIView {
    static let side: CGFloat = 40
    private let glass = UIVisualEffectView(effect: nil)
    private let arrow = UIImageView()
    private let badge = UILabel()
    private let touch = UIButton(type: .custom)
    var onPress: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.clipsToBounds = true
        glass.layer.cornerRadius = DownButton.side / 2
        addSubview(glass)
        // ChatScreen.tsx: <Icon name="chevron-down" size={26} color={t.text}> on a 40-point glass circle; no count.
        arrow.image = chatSymbol("ion:chevron-down", 26)
        arrow.tintColor = Theme.text
        arrow.contentMode = .center
        addSubview(arrow)
        badge.font = .systemFont(ofSize: 11, weight: .bold)
        badge.textColor = Theme.onAccent
        badge.backgroundColor = Theme.accent
        badge.textAlignment = .center
        badge.clipsToBounds = true
        badge.layer.cornerRadius = 9
        badge.isHidden = true
        addSubview(badge)
        touch.accessibilityLabel = "Вниз к новым сообщениям"
        touch.addTarget(self, action: #selector(pressNow), for: .touchUpInside)
        addSubview(touch)
    }

    required init?(coder: NSCoder) { return nil }

    /// `count`: how many new messages wait below; 0 hides the number.
    func show(count: Int) {
        if glass.effect == nil { glass.effect = chatGlass() }
        // The reference's button shows no number of new messages.
        badge.isHidden = true
        badge.text = count > 99 ? "99+" : String(count)
        touch.accessibilityValue = count > 0 ? "новых: \(count)" : nil
        setNeedsLayout()
    }

    @objc private func pressNow() { onPress?() }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        arrow.frame = bounds
        touch.frame = bounds.insetBy(dx: -4, dy: -4)
        let wide = max(18, ceil(badge.intrinsicContentSize.width) + 10)
        badge.frame = CGRect(x: bounds.midX - wide / 2, y: -9, width: wide, height: 18)
    }
}

/// A short line under the header («Скопировано», «Сообщение удалено») that goes away by itself; one that stays
/// («Действие не отправлено · повторить») until it is touched.
final class ChatNotice: UIView {
    private let label = UILabel()
    private var hiding: DispatchWorkItem?
    var onPress: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Theme.surface2
        layer.cornerRadius = 16
        layer.borderWidth = 1
        layer.borderColor = Theme.veil(0.1).cgColor
        label.font = .systemFont(ofSize: 13)
        label.textColor = Theme.text
        label.textAlignment = .center
        label.numberOfLines = 2
        addSubview(label)
        isHidden = true
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(pressNow)))
    }

    required init?(coder: NSCoder) { return nil }

    var words: String { label.text ?? "" }

    /// Shows the words; with `stay` they remain until `hide()`.
    func show(_ words: String, danger: Bool = false, stay: Bool = false) {
        hiding?.cancel()
        label.text = words
        label.textColor = danger ? Theme.danger : Theme.text
        layer.borderColor = (danger ? Theme.danger.withAlphaComponent(0.6) : Theme.veil(0.1)).cgColor
        isHidden = false
        superview?.setNeedsLayout()
        guard !stay else { return }
        let work = DispatchWorkItem { [weak self] in self?.hide() }
        hiding = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2, execute: work)
    }

    func hide() {
        hiding?.cancel()
        isHidden = true
    }

    @objc private func pressNow() {
        if let onPress { onPress() } else { hide() }
    }

    /// The size the notice takes within `width`.
    func fitting(width: CGFloat) -> CGSize {
        let box = label.sizeThatFits(CGSize(width: max(1, width - 28), height: 60))
        return CGSize(width: min(width, ceil(box.width) + 28), height: ceil(box.height) + 14)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds.insetBy(dx: 14, dy: 7)
    }
}

/// The header of the multi-select: «Отмена», «Выбрано: N» and copying what is chosen.
final class SelectionHeader: UIView {
    private let cancelButton = UIButton(type: .system)
    private let countLabel = UILabel()
    private let copyButton = UIButton(type: .system)
    var onCancel: (() -> Void)?
    var onCopy: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        // Opaque: messages scrolled under it must not show through its words.
        backgroundColor = Theme.bg
        cancelButton.setTitle("Отмена", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        cancelButton.tintColor = Theme.accent
        cancelButton.addTarget(self, action: #selector(cancelNow), for: .touchUpInside)
        addSubview(cancelButton)
        countLabel.font = .systemFont(ofSize: 16, weight: .bold)
        countLabel.textColor = Theme.text
        countLabel.textAlignment = .center
        addSubview(countLabel)
        copyButton.setImage(chatSymbol("doc.on.doc", 18), for: .normal)
        copyButton.tintColor = Theme.accent
        copyButton.accessibilityLabel = "Скопировать выбранные"
        copyButton.addTarget(self, action: #selector(copyNow), for: .touchUpInside)
        addSubview(copyButton)
    }

    required init?(coder: NSCoder) { return nil }

    func show(count: Int, canCopy: Bool) {
        countLabel.text = "Выбрано: \(count)"
        copyButton.isEnabled = canCopy
        copyButton.alpha = canCopy ? 1 : 0.4
    }

    @objc private func cancelNow() { onCancel?() }
    @objc private func copyNow() { onCopy?() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width, height = bounds.height
        cancelButton.frame = CGRect(x: 12, y: 0, width: 84, height: height)
        cancelButton.contentHorizontalAlignment = .left
        countLabel.frame = CGRect(x: 100, y: 0, width: max(0, width - 200), height: height)
        copyButton.frame = CGRect(x: width - 56, y: 0, width: 44, height: height)
    }
}

/// The bar of the multi-select, where the field usually is: «Переслать», «Поделиться», «Удалить».
final class SelectionBar: UIVisualEffectView {
    static let height: CGFloat = 60
    private var buttons: [UIButton] = []
    var onForward: (() -> Void)?
    var onShare: (() -> Void)?
    var onDelete: (() -> Void)?

    init() {
        super.init(effect: nil)
        clipsToBounds = true
        layer.cornerRadius = 28
        layer.cornerCurve = .continuous
        let specs: [(String, String, Bool)] = [("arrowshape.turn.up.right", "Переслать", false), ("square.and.arrow.up", "Поделиться", false), ("trash", "Удалить", true)]
        for (index, spec) in specs.enumerated() {
            var config = UIButton.Configuration.plain()
            config.image = chatSymbol(spec.0, 18)
            config.imagePlacement = .top
            config.imagePadding = 4
            var words = AttributedString(spec.1)
            words.font = UIFont.systemFont(ofSize: 10, weight: .semibold)
            config.attributedTitle = words
            config.baseForegroundColor = spec.2 ? Theme.danger : Theme.accent
            config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4)
            let button = UIButton(configuration: config)
            button.tag = index
            button.addTarget(self, action: #selector(pressed(_:)), for: .touchUpInside)
            contentView.addSubview(button)
            buttons.append(button)
        }
    }

    required init?(coder: NSCoder) { return nil }

    /// `export`: something chosen may leave the chat (not when copying is forbidden); `chosen`: something is chosen.
    func show(export: Bool, chosen: Bool) {
        if effect == nil { effect = chatGlass() }
        for button in buttons {
            let on = button.tag == 2 ? chosen : export
            button.isEnabled = on
            button.alpha = on ? 1 : 0.35
        }
    }

    /// The «Удалить» button, for the sheet it opens on a wide screen.
    var deleteSource: UIView? { buttons.count > 2 ? buttons[2] : nil }

    @objc private func pressed(_ sender: UIButton) {
        switch sender.tag {
        case 0: onForward?()
        case 1: onShare?()
        default: onDelete?()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard !buttons.isEmpty else { return }
        let each = bounds.width / CGFloat(buttons.count)
        for (index, button) in buttons.enumerated() {
            button.frame = CGRect(x: CGFloat(index) * each, y: 0, width: each, height: bounds.height)
        }
    }
}

/// A sheet of a few choices, each with a line of explanation under it — «Выключить звук», «Удалить чат?», what
/// can be done with a chat. A choice closes the sheet and is then carried out.
final class ChoiceSheet: UIViewController {
    struct Choice {
        let symbol: String
        let label: String
        var note = ""
        var danger = false
        /// One of several (the reference's `SheetAction selected`): no chevron, a radio for VoiceOver; nil: an action.
        var selected: Bool? = nil
        let run: () -> Void
    }

    private let headingWords: String
    private let noteWords: String
    private let choices: [Choice]
    private let dim = UIView()
    private let card = UIView()
    private let grabber = UIView()
    private let headingLabel = UILabel()
    private let close = GlassRoundButton(symbol: "ion:close", label: "Закрыть", iconSize: 23)
    private let scroll = UIScrollView()
    private let noteLabel = UILabel()
    private var rows: [ChoiceRow] = []
    private var dragStart: CGFloat = 0
    /// Content of its own instead of choices (the reference's `<Sheet>` holding Buttons and words), `partsGap` apart.
    private var parts: [UIView] = []
    private var partsGap: CGFloat = 10
    private let partsStack = UIStackView()

    /// The same sheet holding `parts` one under another, `gap` apart (ProfileScreen.tsx: the media sheet's Buttons, 10).
    convenience init(heading: String, parts: [UIView], gap: CGFloat) {
        self.init(heading: heading, note: "", choices: [])
        self.parts = parts
        partsGap = gap
    }

    /// The reference's `Sheet` (components.tsx) holding `SheetAction`s: a floating card over a dim (fading in, as the
    /// reference's Modal `animationType="fade"`), 12 from the sides and max(12, the safe area) from the bottom, at most
    /// 580 wide and 88% tall; radius 32, the theme's `glassOpaque`, a hairline `border`, 22 inside (25 at the bottom), a
    /// shadow (0.18, 24, 0 −4). On top: the handle (36 × 4, `subtle` at 0.45, 17 under it), then the title (Unbounded
    /// 19, line 25, −0.2) and the round close button 12 apart, 13 above the content. A pull down closes it (a quarter
    /// of its height or a flick), a tap on the dim too.
    init(heading: String, note: String = "", choices: [Choice]) {
        headingWords = heading
        noteWords = note
        self.choices = choices
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        // The dim: «Чёрная» rgba(0,0,0,0.55), other dark themes rgba(0,5,19,0.5), light rgba(20,32,60,0.28).
        dim.backgroundColor = ThemeStore.look.black ? UIColor(white: 0, alpha: 0.55)
            : Theme.dark ? UIColor(red: 0, green: 5 / 255, blue: 19 / 255, alpha: 0.5) : UIColor(red: 20 / 255, green: 32 / 255, blue: 60 / 255, alpha: 0.28)
        dim.isAccessibilityElement = true
        dim.accessibilityLabel = "Закрыть"
        dim.accessibilityTraits = .button
        dim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(closePressed)))
        view.addSubview(dim)

        card.backgroundColor = ThemeStore.look.glassOpaque
        card.layer.cornerRadius = 32
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = 1 / UIScreen.main.scale
        card.layer.borderColor = ThemeStore.look.border.cgColor
        card.layer.shadowColor = UIColor.black.cgColor
        card.layer.shadowOpacity = 0.18
        card.layer.shadowRadius = 24
        card.layer.shadowOffset = CGSize(width: 0, height: -4)
        view.addSubview(card)
        card.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pulled(_:))))

        grabber.backgroundColor = Theme.subtle.withAlphaComponent(0.45)
        grabber.layer.cornerRadius = 2
        card.addSubview(grabber)
        headingLabel.attributedText = NSAttributedString(string: headingWords, attributes: [.font: Theme.title(Theme.TypeSize.sheetTitle), .kern: -0.2, .foregroundColor: Theme.text])
        headingLabel.numberOfLines = 2
        headingLabel.accessibilityTraits = .header
        card.addSubview(headingLabel)
        close.onPress = { [weak self] in self?.closePressed() }
        card.addSubview(close)

        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceVertical = false
        card.addSubview(scroll)
        // The words under the title (MuteSheet.tsx): 13, line 19, `muted`, two lines at most, 6 above the actions.
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 19
        style.maximumLineHeight = 19
        noteLabel.attributedText = NSAttributedString(string: noteWords, attributes: [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: Theme.muted, .paragraphStyle: style])
        noteLabel.numberOfLines = 2
        noteLabel.isHidden = noteWords.isEmpty
        scroll.addSubview(noteLabel)
        for (index, choice) in choices.enumerated() {
            let row = ChoiceRow(choice: choice)
            row.tag = index
            row.addTarget(self, action: #selector(chosen(_:)), for: .touchUpInside)
            scroll.addSubview(row)
            rows.append(row)
        }
        if !parts.isEmpty {
            partsStack.axis = .vertical
            partsStack.spacing = partsGap
            for part in parts { partsStack.addArrangedSubview(part) }
            scroll.addSubview(partsStack)
        }
    }

    @objc private func chosen(_ sender: UIControl) {
        guard sender.tag < choices.count else { return }
        let run = choices[sender.tag].run
        dismiss(animated: true) { run() }
    }

    @objc private func closePressed() {
        dismiss(animated: true)
    }

    /// The reference's swipe-to-dismiss (swipeDismiss.tsx, swipeDismissModel.ts): the card follows the finger down 1:1 and
    /// up only a little (a rubber band of 14), the dim fades with it. On release it closes past a quarter of its height
    /// (at least 56, at most 240) or on a flick of 1000 pt/s (8 pt down at least) unless flicked back up (−400): it slides
    /// below the screen in 120…280 ms (easeOutQuad) and the sheet fades away. Otherwise it springs back (damping 22,
    /// stiffness 260, mass 0.8, from the finger's speed).
    @objc private func pulled(_ pan: UIPanGestureRecognizer) {
        let travel = pan.translation(in: view).y
        let offset = travel >= 0 ? travel : -14 * (1 - exp(travel / (14 * 3)))
        let height = card.bounds.height > 0 ? card.bounds.height : 400
        switch pan.state {
        case .changed:
            card.transform = CGAffineTransform(translationX: 0, y: offset)
            dim.alpha = offset > 0 ? max(0, min(1, 1 - offset / height)) : 1
        case .ended, .cancelled:
            let speed = pan.velocity(in: view).y
            let distance = min(240, max(56, height * 0.25))
            let closes = offset > 0 && speed > -400 && ((speed >= 1000 && offset >= 8) || offset >= distance)
            if closes {
                let target = max(height, view.bounds.height) + 24
                let left = max(0, target - max(0, offset))
                let duration = max(120, min(280, left / max(1200, speed) * 1000)) / 1000
                let slide = UIViewPropertyAnimator(duration: Double(duration), timingParameters: UICubicTimingParameters(controlPoint1: CGPoint(x: 0.25, y: 0.46), controlPoint2: CGPoint(x: 0.45, y: 0.94)))
                slide.addAnimations { () -> Void in
                    self.card.transform = CGAffineTransform(translationX: 0, y: target)
                    self.dim.alpha = 0
                }
                slide.addCompletion { [weak self] (_: UIViewAnimatingPosition) -> Void in self?.dismiss(animated: true) }
                slide.startAnimation()
            } else {
                let start = card.transform.ty
                let velocity = abs(start) > 0.5 ? CGVector(dx: 0, dy: -speed / start) : .zero
                let spring = UIViewPropertyAnimator(duration: 0.5, timingParameters: UISpringTimingParameters(mass: 0.8, stiffness: 260, damping: 22, initialVelocity: velocity))
                spring.addAnimations { () -> Void in
                    self.card.transform = .identity
                    self.dim.alpha = 1
                }
                spring.startAnimation()
            }
        default: break
        }
    }

    /// The reference's SheetAction: 13 above and below a 46 tile (72), at least 76 for an action; a two-line note adds 18.
    static func rowHeight(_ choice: Choice) -> CGFloat {
        let least: CGFloat = choice.selected != nil ? 72 : 76
        if choice.note.isEmpty { return least }
        return max(least, 13 + 20 + 5 + (choice.note.count > 44 ? 36 : 18) + 13)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        dim.frame = view.bounds
        let safe = view.safeAreaInsets
        let width = min(580, view.bounds.width - 24)
        let inner = width - 44
        var y: CGFloat = 0
        if !noteWords.isEmpty {
            let noteHeight = min(38, noteLabel.sizeThatFits(CGSize(width: inner, height: 38)).height)
            noteLabel.frame = CGRect(x: 0, y: 0, width: inner, height: noteHeight)
            y = noteHeight + 6
        }
        for (index, row) in rows.enumerated() {
            let height = ChoiceSheet.rowHeight(choices[index])
            row.frame = CGRect(x: 0, y: y, width: inner, height: height)
            y += height
        }
        if !parts.isEmpty {
            let fitted = partsStack.systemLayoutSizeFitting(CGSize(width: inner, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
            partsStack.frame = CGRect(x: 0, y: y, width: inner, height: fitted.height)
            y += fitted.height
        }
        scroll.contentSize = CGSize(width: inner, height: y)
        let titleHeight = max(44, min(50, headingLabel.sizeThatFits(CGSize(width: inner - 44 - 12, height: 50)).height))
        let top: CGFloat = 22 + 4 + 17 + titleHeight + 13
        let most = view.bounds.height * 0.88
        let height = min(most, top + y + 25)
        let bottom = max(12, safe.bottom)
        card.bounds = CGRect(x: 0, y: 0, width: width, height: height)
        card.center = CGPoint(x: view.bounds.width / 2, y: view.bounds.height - bottom - height / 2)
        grabber.frame = CGRect(x: (width - 36) / 2, y: 22, width: 36, height: 4)
        let rowTop: CGFloat = 22 + 4 + 17
        close.frame = CGRect(x: width - 22 - 44, y: rowTop + (titleHeight - 44) / 2, width: 44, height: 44)
        headingLabel.frame = CGRect(x: 22, y: rowTop, width: inner - 44 - 12, height: titleHeight)
        scroll.frame = CGRect(x: 22, y: top, width: inner, height: height - top - 25)
    }
}

/// One choice of a `ChoiceSheet`.
private final class ChoiceRow: UIControl {
    /// Glass inside the opaque sheet draws flat (glass.tsx FlatGlassScope): `glassClear`, a 1 `glassBorder` rim and the
    /// `glassHighlight` line at the top (0.7, 0.58 of the radius in from the sides).
    private let tile = UIView()
    private let shine = UIView()
    private let mark = UIImageView()
    private let nameLabel = UILabel()
    private let noteLabel = UILabel()
    private let chevron = UIImageView(image: IonIcon.image("chevron-forward", size: 18))
    private let hasNote: Bool
    private let isChoice: Bool

    /// The reference's `SheetAction` (components.tsx): a 46 tile of clear glass (radius 16) holding the Ionicons glyph 22
    /// in the accent (`danger` for a dangerous one), 14 to the words — the label 16 SemiBold, the note 12 (line 18) 5
    /// under it in `muted` — and a chevron-forward 18 in `subtle` unless it is one of several; 13 above and below, 10 at
    /// the sides, radius 19, `surface2` under the finger.
    init(choice: ChoiceSheet.Choice) {
        hasNote = !choice.note.isEmpty
        isChoice = choice.selected != nil
        super.init(frame: .zero)
        tile.backgroundColor = ThemeStore.look.glassClear
        tile.layer.borderWidth = 1
        tile.layer.borderColor = ThemeStore.look.glassBorder.cgColor
        tile.layer.cornerRadius = 16
        tile.layer.cornerCurve = .continuous
        tile.clipsToBounds = true
        tile.isUserInteractionEnabled = false
        addSubview(tile)
        shine.backgroundColor = ThemeStore.look.glassHighlight
        shine.alpha = 0.7
        shine.layer.cornerRadius = 0.5
        tile.addSubview(shine)
        mark.image = chatSymbol(choice.symbol, 22)
        mark.tintColor = choice.danger ? Theme.danger : Theme.accent
        mark.contentMode = .center
        tile.addSubview(mark)
        nameLabel.text = choice.label
        nameLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        nameLabel.textColor = choice.danger ? Theme.danger : Theme.text
        addSubview(nameLabel)
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 18
        style.maximumLineHeight = 18
        noteLabel.attributedText = NSAttributedString(string: choice.note, attributes: [.font: UIFont.systemFont(ofSize: 12), .foregroundColor: Theme.muted, .paragraphStyle: style])
        noteLabel.numberOfLines = 2
        addSubview(noteLabel)
        chevron.tintColor = Theme.subtle
        chevron.isHidden = isChoice
        addSubview(chevron)
        layer.cornerRadius = 19
        layer.cornerCurve = .continuous
        isAccessibilityElement = true
        accessibilityTraits = .button
        if let selected = choice.selected, selected { accessibilityTraits.insert(.selected) }
        accessibilityLabel = choice.note.isEmpty ? choice.label : choice.label + ". " + choice.note
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? Theme.surface2 : .clear }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width, height = bounds.height
        tile.frame = CGRect(x: 10, y: (height - 46) / 2, width: 46, height: 46)
        mark.frame = tile.bounds
        shine.frame = CGRect(x: 16 * 0.58, y: 1, width: 46 - 2 * 16 * 0.58, height: 1)
        let left: CGFloat = 10 + 46 + 14
        let right: CGFloat = isChoice ? 10 : 10 + 18 + 14
        chevron.frame = CGRect(x: width - 10 - 18, y: (height - 18) / 2, width: 18, height: 18)
        let room = width - left - right
        if hasNote {
            let noteHeight = noteLabel.sizeThatFits(CGSize(width: room, height: 36)).height
            let block = 20 + 5 + min(36, noteHeight)
            let top = (height - block) / 2
            nameLabel.frame = CGRect(x: left, y: top, width: room, height: 20)
            noteLabel.frame = CGRect(x: left, y: top + 25, width: room, height: min(36, noteHeight))
        } else {
            nameLabel.frame = CGRect(x: left, y: 0, width: room, height: height)
        }
    }
}
