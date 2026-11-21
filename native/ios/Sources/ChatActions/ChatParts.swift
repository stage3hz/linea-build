import UIKit

// The small parts of a chat's screen that the actions on messages need: the field that grows with its text, the
// bar above it (an answer, an edit, a forward), the pinned message's bar, the way down, a short notice, and the
// two bars of the multi-select.

func chatGlass() -> UIVisualEffect { TabGlass.effect(clear: false, interactive: false, dark: true) }

func chatSymbol(_ name: String, _ size: CGFloat, _ weight: UIImage.SymbolWeight = .regular) -> UIImage? {
    UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: weight))
}

/// The field a message is written in: several lines, growing with the text up to a height and scrolling past it
/// (the reference's composer: one line at first, at most 136 pt of text).
final class ComposerField: UITextView {
    static let lowest: CGFloat = 48
    static let highest: CGFloat = 148
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
        keyboardAppearance = .dark
        textContainerInset = UIEdgeInsets(top: 14, left: 0, bottom: 13, right: 0)
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
        stripe.layer.cornerRadius = 1.25
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
        unpinButton.setImage(chatSymbol("xmark", 16, .medium), for: .normal)
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
        stripe.frame = CGRect(x: 16, y: 11, width: 2.5, height: 34)
        headingLabel.frame = CGRect(x: 30, y: 9, width: max(0, width - 30 - 50), height: 19)
        wordsLabel.frame = CGRect(x: 30, y: 28, width: max(0, width - 30 - 50), height: 19)
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
        arrow.image = chatSymbol("chevron.down", 18, .semibold)
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
        badge.isHidden = count <= 0
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
        layer.borderColor = UIColor(white: 1, alpha: 0.1).cgColor
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
        layer.borderColor = (danger ? Theme.danger.withAlphaComponent(0.6) : UIColor(white: 1, alpha: 0.1)).cgColor
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
        let run: () -> Void
    }

    private let headingWords: String
    private let noteWords: String
    private let choices: [Choice]
    private let headingLabel = UILabel()
    private let noteLabel = UILabel()
    private var rows: [ChoiceRow] = []

    init(heading: String, note: String = "", choices: [Choice]) {
        headingWords = heading
        noteWords = note
        self.choices = choices
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            let wanted = ChoiceSheet.height(heading: heading, note: note, choices: choices)
            sheet.detents = [UISheetPresentationController.Detent.custom(resolver: { context in
                return min(wanted, context.maximumDetentValue)
            })]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 28
        }
    }

    required init?(coder: NSCoder) { return nil }

    private static func height(heading: String, note: String, choices: [Choice]) -> CGFloat {
        var total: CGFloat = 30 + 30
        if !note.isEmpty { total += 44 }
        for choice in choices { total += choice.note.isEmpty ? 54 : 76 }
        // And the room under the last choice (the home indicator).
        return total + 44
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(hex: 0x141516)
        headingLabel.text = headingWords
        headingLabel.font = .systemFont(ofSize: 20, weight: .bold)
        headingLabel.textColor = Theme.text
        view.addSubview(headingLabel)
        noteLabel.text = noteWords
        noteLabel.font = .systemFont(ofSize: 13)
        noteLabel.textColor = Theme.muted
        noteLabel.numberOfLines = 2
        noteLabel.isHidden = noteWords.isEmpty
        view.addSubview(noteLabel)
        for (index, choice) in choices.enumerated() {
            let row = ChoiceRow(choice: choice)
            row.tag = index
            row.addTarget(self, action: #selector(chosen(_:)), for: .touchUpInside)
            view.addSubview(row)
            rows.append(row)
        }
    }

    @objc private func chosen(_ sender: UIControl) {
        guard sender.tag < choices.count else { return }
        let run = choices[sender.tag].run
        dismiss(animated: true) { run() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        var y: CGFloat = 30
        headingLabel.frame = CGRect(x: 20, y: y, width: width - 40, height: 26)
        y += 30
        if !noteWords.isEmpty {
            noteLabel.frame = CGRect(x: 20, y: y, width: width - 40, height: 38)
            y += 44
        }
        for (index, row) in rows.enumerated() {
            let height: CGFloat = choices[index].note.isEmpty ? 54 : 76
            row.frame = CGRect(x: 8, y: y, width: width - 16, height: height)
            y += height
        }
    }
}

/// One choice of a `ChoiceSheet`.
private final class ChoiceRow: UIControl {
    private let mark = UIImageView()
    private let nameLabel = UILabel()
    private let noteLabel = UILabel()
    private let hasNote: Bool

    init(choice: ChoiceSheet.Choice) {
        hasNote = !choice.note.isEmpty
        super.init(frame: .zero)
        let ink = choice.danger ? Theme.danger : Theme.text
        mark.image = chatSymbol(choice.symbol, 19)
        mark.tintColor = ink
        mark.contentMode = .center
        addSubview(mark)
        nameLabel.text = choice.label
        nameLabel.font = .systemFont(ofSize: 17)
        nameLabel.textColor = ink
        addSubview(nameLabel)
        noteLabel.text = choice.note
        noteLabel.font = .systemFont(ofSize: 13)
        noteLabel.textColor = Theme.muted
        noteLabel.numberOfLines = 2
        addSubview(noteLabel)
        layer.cornerRadius = 14
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = choice.note.isEmpty ? choice.label : choice.label + ". " + choice.note
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(white: 1, alpha: 0.07) : .clear }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        mark.frame = CGRect(x: 8, y: 0, width: 36, height: hasNote ? 44 : bounds.height)
        if hasNote {
            nameLabel.frame = CGRect(x: 52, y: 10, width: width - 64, height: 22)
            noteLabel.frame = CGRect(x: 52, y: 33, width: width - 64, height: 36)
        } else {
            nameLabel.frame = CGRect(x: 52, y: 0, width: width - 64, height: bounds.height)
        }
    }
}
