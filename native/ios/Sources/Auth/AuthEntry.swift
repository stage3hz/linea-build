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
        plate.backgroundColor = Theme.surface2
        plate.layer.cornerRadius = 16
        plate.layer.cornerCurve = .continuous

        field.font = .systemFont(ofSize: 17)
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
            field.leadingAnchor.constraint(equalTo: plate.leadingAnchor, constant: 16),
            field.trailingAnchor.constraint(equalTo: plate.trailingAnchor, constant: secret ? -54 : -16),
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
        self.caption.text = caption.uppercased()
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
        // No suggestions of saved or new passwords: only typing is taken.
        let kind: UITextContentType? = hidden ? UITextContentType.oneTimeCode : nil
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
}

/// A few words in a plate: something the person should know, or (in the danger colour) something that went wrong.
final class AuthNotice: UIView {
    private let label = UILabel()

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
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -13),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { return nil }
}
