import UIKit

/// A text field that takes typing only: no paste, no menu (the reference's `ManualField`).
final class ManualTextField: UITextField {
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        return false
    }

    override func paste(_ sender: Any?) {}
}

/// One field of the sign-in screen with its caption: a login, a name, a password or a secret word.
/// What is typed lives only in the field; `value = ""` forgets it.
final class AuthEntry: UIView, UITextFieldDelegate {
    let field = ManualTextField()
    private let caption = UILabel()
    private let plate = UIView()
    /// The reference's focus rim: 1.4 in the accent over the field while it has the keyboard (ManualField.tsx:47).
    private let ring = UIView()
    private let eye = UIButton(type: .custom)
    private let refusal = UILabel()
    private let secret: Bool
    private var captionText: String

    /// The longest text taken, in UTF-16 units; 0 — any.
    var limit = 0
    /// Spaces are not taken at all (the @username).
    var noSpaces = false
    var onReturn: (() -> Void)?
    /// Whether an empty field starts out showing what is typed (a secret being created) or hiding it.
    var shownWhenEmpty = false

    var value: String {
        get { return field.text ?? "" }
        set {
            field.text = newValue
            if newValue.isEmpty {
                refusal.isHidden = true
                reveal(shownWhenEmpty)
            }
        }
    }

    var isEnabled: Bool {
        get { return field.isEnabled }
        set {
            field.isEnabled = newValue
            eye.isEnabled = newValue
            plate.alpha = newValue ? 1 : 0.55
        }
    }

    init(caption: String, placeholder: String, secret: Bool) {
        self.secret = secret
        self.captionText = caption
        super.init(frame: .zero)

        self.caption.font = .systemFont(ofSize: 11, weight: .bold)
        self.caption.textColor = Theme.muted
        // ManualField.tsx:46,59: a glass plate with radius 18 and its rim; the words 16, 17 from the sides.
        plate.backgroundColor = Theme.surface2
        plate.layer.cornerRadius = 18
        plate.layer.cornerCurve = .continuous
        plate.layer.borderWidth = 1
        plate.layer.borderColor = ThemeStore.look.glassBorder.cgColor
        ring.isUserInteractionEnabled = false
        ring.isHidden = true
        ring.layer.cornerRadius = 18
        ring.layer.cornerCurve = .continuous
        ring.layer.borderWidth = 1.4
        ring.layer.borderColor = Theme.accent.cgColor
        ring.translatesAutoresizingMaskIntoConstraints = false

        field.font = .systemFont(ofSize: 16)
        field.textColor = Theme.text
        field.tintColor = Theme.text
        field.keyboardAppearance = Theme.dark ? .dark : .light
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.textContentType = nil
        field.delegate = self
        field.translatesAutoresizingMaskIntoConstraints = false
        plate.addSubview(field)

        eye.tintColor = Theme.muted
        eye.isHidden = !secret
        eye.addTarget(self, action: #selector(toggle), for: .touchUpInside)
        eye.translatesAutoresizingMaskIntoConstraints = false
        GlassBacking.put(under: eye)
        plate.addSubview(eye)
        plate.addSubview(ring)

        refusal.text = "Введи по одному символу. Вставка и автозаполнение отключены."
        refusal.font = .systemFont(ofSize: 11)
        refusal.textColor = Theme.muted
        refusal.numberOfLines = 0
        refusal.isHidden = true

        let column = UIStackView(arrangedSubviews: [self.caption, plate, refusal])
        column.axis = .vertical
        column.spacing = 8
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.topAnchor.constraint(equalTo: topAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            plate.heightAnchor.constraint(equalToConstant: 54),
            ring.topAnchor.constraint(equalTo: plate.topAnchor),
            ring.bottomAnchor.constraint(equalTo: plate.bottomAnchor),
            ring.leadingAnchor.constraint(equalTo: plate.leadingAnchor),
            ring.trailingAnchor.constraint(equalTo: plate.trailingAnchor),
            field.leadingAnchor.constraint(equalTo: plate.leadingAnchor, constant: 17),
            field.trailingAnchor.constraint(equalTo: plate.trailingAnchor, constant: secret ? -54 : -17),
            field.topAnchor.constraint(equalTo: plate.topAnchor),
            field.bottomAnchor.constraint(equalTo: plate.bottomAnchor),
            eye.trailingAnchor.constraint(equalTo: plate.trailingAnchor, constant: -5),
            eye.centerYAnchor.constraint(equalTo: plate.centerYAnchor),
            eye.widthAnchor.constraint(equalToConstant: 44),
            eye.heightAnchor.constraint(equalToConstant: 44),
        ])
        set(caption: caption, placeholder: placeholder)
        reveal(!secret)
    }

    required init?(coder: NSCoder) { return nil }

    func set(caption: String, placeholder: String) {
        captionText = caption
        // ManualField.tsx:45: the caption is spaced out by 1 and stands 2 in from the field's edge.
        let indent = NSMutableParagraphStyle()
        indent.firstLineHeadIndent = 2
        indent.headIndent = 2
        self.caption.attributedText = NSAttributedString(string: caption.uppercased(), attributes: [.kern: 1, .paragraphStyle: indent, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        field.accessibilityLabel = caption
        field.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: Theme.subtle])
        updateEye()
    }

    /// Shows what is typed, or hides it behind dots. A secret being created is typed once, so it is shown
    /// while typed; the eye hides it.
    func reveal(_ shown: Bool) {
        let hidden = secret && !shown
        if field.isSecureTextEntry != hidden {
            let kept = field.text
            field.isSecureTextEntry = hidden
            field.text = kept
        }
        // No suggestions of saved or new passwords: only typing is taken. An empty kind is the reference's
        // `textContentType="none"` (ManualField.tsx:56): no «Passwords» bar over the keyboard either.
        let kind: UITextContentType = hidden ? UITextContentType.oneTimeCode : UITextContentType(rawValue: "")
        field.textContentType = kind
        updateEye()
    }

    private func updateEye() {
        let hidden = field.isSecureTextEntry
        // The reference's `IconButton` eye-outline / eye-off-outline (23) on a clear glass round.
        eye.setImage(IonIcon.image(hidden ? "eye-outline" : "eye-off-outline", size: 23), for: .normal)
        eye.accessibilityLabel = (hidden ? "Показать" : "Скрыть") + ": " + captionText.lowercased()
    }

    @objc private func toggle() {
        reveal(field.isSecureTextEntry)
    }

    // Every change is applied here by hand: an insertion of more than one symbol at once (a paste, an
    // autofill, a dictation) is turned back, and a hidden field is not emptied by its first key.
    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        let old = (textField.text ?? "") as NSString
        guard range.location != NSNotFound, range.location + range.length <= old.length else { return false }
        var typed = string
        if noSpaces {
            var kept = String.UnicodeScalarView()
            for scalar in string.unicodeScalars {
                if !CharacterSet.whitespacesAndNewlines.contains(scalar) { kept.append(scalar) }
            }
            typed = String(kept)
            if typed.isEmpty && !string.isEmpty { return false }
        }
        if typed.unicodeScalars.count > 1 {
            refusal.isHidden = false
            UIAccessibility.post(notification: .announcement, argument: refusal.text)
            return false
        }
        let made = old.replacingCharacters(in: range, with: typed)
        if limit > 0 && (made as NSString).length > limit { return false }
        textField.text = made
        let caret = range.location + (typed as NSString).length
        if let place = textField.position(from: textField.beginningOfDocument, offset: caret) {
            textField.selectedTextRange = textField.textRange(from: place, to: place)
        }
        refusal.isHidden = true
        if made.isEmpty { reveal(shownWhenEmpty) }
        return false
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        onReturn?()
        return false
    }

    func textFieldDidBeginEditing(_ textField: UITextField) {
        ring.isHidden = false
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        ring.isHidden = true
    }
}

/// A few words in a plate: something the person should know, or (in the danger colour) something that went wrong.
final class AuthNotice: UIView {
    private let label = AuthNote()
    private var labelLeading: NSLayoutConstraint?
    private var labelTrailing: NSLayoutConstraint?
    /// The room left and right of the words together.
    private var sides: CGFloat = 28

    var words: String {
        get { return label.text ?? "" }
        set {
            label.text = newValue
            isHidden = newValue.isEmpty
        }
    }

    init(error: Bool) {
        super.init(frame: .zero)
        backgroundColor = error ? Theme.danger.withAlphaComponent(0.12) : Theme.surface2
        layer.cornerRadius = 16
        layer.cornerCurve = .continuous
        label.font = .systemFont(ofSize: 13)
        label.textColor = error ? Theme.danger : Theme.text
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        let leading = label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14)
        let trailing = label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14)
        labelLeading = leading
        labelTrailing = trailing
        NSLayoutConstraint.activate([
            leading,
            trailing,
            label.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -13),
        ])
        isHidden = true
    }

    /// The reference's box on the login step (AuthScreen.tsx:329): an Ionicons glyph (18, the accent) left of the
    /// words, 13 inside, 10 between; `accentSoft` with a `border` rim, radius 16; the words 13 on lines of 19.
    func mark(icon name: String) {
        let glyph = UIImageView(image: IonIcon.image(name, size: 18))
        glyph.tintColor = Theme.accent
        glyph.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glyph)
        NSLayoutConstraint.activate([
            glyph.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 13),
            glyph.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            glyph.widthAnchor.constraint(equalToConstant: 18),
            glyph.heightAnchor.constraint(equalToConstant: 18),
        ])
        labelLeading?.constant = 13 + 18 + 10
        labelTrailing?.constant = -13
        sides = 13 + 18 + 10 + 13
        backgroundColor = ThemeStore.look.accentSoft
        layer.borderWidth = 1
        layer.borderColor = ThemeStore.look.border.cgColor
        label.lineStep = 19
        let current = label.text
        label.text = current
    }

    /// The box's height at a width, counted from the words themselves: the fitting pass of the layout engine may count
    /// a wrapped label one line short, and the card then runs under the keyboard.
    func fitHeight(_ width: CGFloat) -> CGFloat {
        if words.isEmpty { return 0 }
        let inside = label.sizeThatFits(CGSize(width: max(0, width - sides), height: CGFloat.greatestFiniteMagnitude))
        return ceil(inside.height) + 26
    }

    required init?(coder: NSCoder) { return nil }
}

/// A few words of the sign-in screen on the reference's lines: `lineStep` tall (its `lineHeight`), the words in the
/// middle of each line, and no word pushed down to keep company with a lone last one (the reference wraps plainly).
final class AuthNote: UILabel {
    /// The height of each line; 0 — the font's own.
    var lineStep: CGFloat = 0
    /// The widest the lines may be (the reference's `maxWidth`), standing in the middle of a wider label; 0 — no limit.
    var widest: CGFloat = 0

    private func narrowed(_ rect: CGRect) -> CGRect {
        guard widest > 0, rect.width > widest else { return rect }
        return rect.insetBy(dx: (rect.width - widest) / 2, dy: 0)
    }

    override func textRect(forBounds bounds: CGRect, limitedToNumberOfLines numberOfLines: Int) -> CGRect {
        return super.textRect(forBounds: narrowed(bounds), limitedToNumberOfLines: numberOfLines)
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: narrowed(rect))
    }

    override var text: String? {
        get { return super.text }
        set {
            guard lineStep > 0, let words = newValue else {
                super.text = newValue
                return
            }
            let face: UIFont = font ?? UIFont.systemFont(ofSize: 12)
            let ink: UIColor = textColor ?? Theme.muted
            let style = NSMutableParagraphStyle()
            style.minimumLineHeight = lineStep
            style.maximumLineHeight = lineStep
            style.alignment = textAlignment
            style.lineBreakStrategy = []
            attributedText = NSAttributedString(string: words, attributes: [.font: face, .foregroundColor: ink, .paragraphStyle: style,
                                                                          .baselineOffset: (lineStep - face.lineHeight) / 2])
        }
    }
}

/// «Войти» / «Создать аккаунт» (AuthScreen.tsx:321): a row 4 inside a rim (`border`, radius 19) on a dark veil; the
/// chosen one on a light veil with a glass rim (radius 15, at least 43 tall); the words 12, 700 chosen and 500 not.
final class AuthSwitch: UIControl {
    private var buttons: [UIButton] = []

    var selectedSegmentIndex = 0 {
        didSet { paint() }
    }

    override var isEnabled: Bool {
        didSet {
            for button in buttons { button.isEnabled = isEnabled }
        }
    }

    init(items: [String]) {
        super.init(frame: .zero)
        backgroundColor = Theme.dark ? UIColor(white: 0, alpha: 0.18) : UIColor(red: 97 / 255, green: 113 / 255, blue: 149 / 255, alpha: 0.08)
        layer.cornerRadius = 19
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        layer.borderColor = ThemeStore.look.border.cgColor
        accessibilityTraits = .tabBar
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor, constant: 5),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 43),
        ])
        for (index, item) in items.enumerated() {
            let button = UIButton(type: .custom)
            button.setTitle(item, for: .normal)
            button.layer.cornerRadius = 15
            button.layer.cornerCurve = .continuous
            button.layer.borderWidth = 1
            button.tag = index
            button.addTarget(self, action: #selector(picked(_:)), for: .touchUpInside)
            row.addArrangedSubview(button)
            buttons.append(button)
        }
        paint()
    }

    required init?(coder: NSCoder) { return nil }

    private func paint() {
        for button in buttons {
            let on = button.tag == selectedSegmentIndex
            button.setTitleColor(on ? Theme.text : Theme.muted, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 12, weight: on ? .bold : .medium)
            button.backgroundColor = on ? (Theme.dark ? UIColor(white: 1, alpha: 0.12) : UIColor(white: 1, alpha: 0.82)) : .clear
            button.layer.borderColor = on ? ThemeStore.look.glassBorder.cgColor : UIColor.clear.cgColor
            button.accessibilityTraits = on ? UIAccessibilityTraits([.button, .selected]) : UIAccessibilityTraits.button
        }
    }

    @objc private func picked(_ sender: UIButton) {
        guard sender.tag != selectedSegmentIndex else { return }
        selectedSegmentIndex = sender.tag
        sendActions(for: .valueChanged)
    }
}

/// The three promises under the sign-in card (AuthScreen.tsx:361-362): «Сквозное шифрование», «Без почты и SMS»,
/// «Ключи только у тебя» — each a chip (11 across, 7 down, radius 14, a 1-point rim in `border`, a faint veil: white
/// 0.03 on dark themes, 0.4 on light), the Ionicon (13, accent) 6 before the words (11, semibold, quiet); the chips
/// wrap and stand in the middle, 8 apart both ways.
final class AuthTrustChips: UIView {
    static let items: [(icon: String, words: String)] = [("lock-closed-outline", "Сквозное шифрование"),
                                                         ("mail-unread-outline", "Без почты и SMS"),
                                                         ("key-outline", "Ключи только у тебя")]
    private static let gap: CGFloat = 8
    private static let icon: CGFloat = 13
    private var chips: [UIView] = []
    private var marks: [UIImageView] = []
    private var labels: [UILabel] = []

    init() {
        super.init(frame: .zero)
        for item in AuthTrustChips.items {
            let chip = UIView()
            chip.layer.cornerRadius = 14
            chip.layer.borderWidth = 1
            chip.layer.borderColor = ThemeStore.look.border.cgColor
            chip.backgroundColor = Theme.dark ? UIColor(white: 1, alpha: 0.03) : UIColor(white: 1, alpha: 0.4)
            let mark = UIImageView(image: IonIcon.image(item.icon, size: AuthTrustChips.icon))
            mark.tintColor = Theme.accent
            let label = UILabel()
            label.text = item.words
            label.font = .systemFont(ofSize: 11, weight: .semibold)
            label.textColor = Theme.muted
            chip.addSubview(mark)
            chip.addSubview(label)
            chip.isAccessibilityElement = true
            chip.accessibilityLabel = item.words
            addSubview(chip)
            chips.append(chip)
            marks.append(mark)
            labels.append(label)
        }
    }

    required init?(coder: NSCoder) { return nil }

    /// One chip's size: 11 + icon + 6 + words + 11 across, 7 above and below the taller of the two.
    private func chipSize(_ index: Int) -> CGSize {
        let words = labels[index].sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude))
        let width = 11 + AuthTrustChips.icon + 6 + ceil(words.width) + 11
        let height = 7 + max(AuthTrustChips.icon, ceil(words.height)) + 7
        return CGSize(width: width, height: height)
    }

    /// The chips in lines at this width (as many to a line as fit).
    private func lines(_ width: CGFloat) -> [[Int]] {
        var out: [[Int]] = []
        var line: [Int] = []
        var used: CGFloat = 0
        for index in 0..<chips.count {
            let wide = chipSize(index).width
            if !line.isEmpty && used + AuthTrustChips.gap + wide > width {
                out.append(line)
                line = []
                used = 0
            }
            used += (line.isEmpty ? 0 : AuthTrustChips.gap) + wide
            line.append(index)
        }
        if !line.isEmpty { out.append(line) }
        return out
    }

    /// The height the chips take at this width.
    func fitHeight(_ width: CGFloat) -> CGFloat {
        let rows = lines(width)
        var total: CGFloat = 0
        for row in rows {
            var tallest: CGFloat = 0
            for index in row { tallest = max(tallest, chipSize(index).height) }
            total += tallest
        }
        return total + CGFloat(max(0, rows.count - 1)) * AuthTrustChips.gap
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        var y: CGFloat = 0
        for row in lines(bounds.width) {
            var rowWidth: CGFloat = 0
            var tallest: CGFloat = 0
            for index in row {
                let size = chipSize(index)
                rowWidth += size.width
                tallest = max(tallest, size.height)
            }
            rowWidth += CGFloat(max(0, row.count - 1)) * AuthTrustChips.gap
            var x = max(0, (bounds.width - rowWidth) / 2)
            for index in row {
                let size = chipSize(index)
                chips[index].frame = CGRect(x: x, y: y, width: size.width, height: size.height)
                marks[index].frame = CGRect(x: 11, y: (size.height - AuthTrustChips.icon) / 2, width: AuthTrustChips.icon, height: AuthTrustChips.icon)
                let wordsWidth = size.width - 11 - AuthTrustChips.icon - 6 - 11
                labels[index].frame = CGRect(x: 11 + AuthTrustChips.icon + 6, y: 7, width: wordsWidth, height: size.height - 14)
                x += size.width + AuthTrustChips.gap
            }
            y += tallest + AuthTrustChips.gap
        }
    }
}
