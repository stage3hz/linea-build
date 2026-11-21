import UIKit

/// The code entry shared by the lock screen and the passcode settings: four dots and a round pad for a 4-digit
/// code, a password field otherwise; the whole thing shakes and clears on a wrong code. (The previous app:
/// `mobile/src/lock/CodeEntry.tsx` — the same sizes, words and timings.)
final class CodeEntryView: UIView, UITextFieldDelegate {
    /// A 4-digit code is sent as soon as the fourth digit is typed; a password on «Готово» / Enter.
    var onSubmit: ((String) -> Void)?
    /// The bottom-left pad key (Face ID / Touch ID): its picture and name.
    var biometric: (symbol: String, label: String, press: () -> Void)? { didSet { buildPad() } }

    private(set) var kind: String
    private var code = ""
    private let titleLabel = UILabel()
    private let hintLabel = UILabel()
    private let dots = UIStackView()
    private let field = UITextField()
    private let fieldBox = UIView()
    private let pad = UIStackView()
    private let doneButton = UIButton(type: .system)
    private let bioButton = UIButton(type: .system)
    private let shaker = UIStackView()
    private let column = UIStackView()
    private var submitTimer: Timer?
    private var errorShown = false
    var disabled = false { didSet { applyDisabled() } }
    let footer = UIStackView()

    private static let key: CGFloat = 74

    init(kind: String) {
        self.kind = kind
        super.init(frame: .zero)
        column.axis = .vertical
        column.alignment = .center
        column.spacing = 18
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        titleLabel.font = Theme.title(Theme.TypeSize.sheetTitle) // Fonts
        titleLabel.textColor = Theme.text
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0
        hintLabel.font = .systemFont(ofSize: 14)
        hintLabel.textAlignment = .center
        hintLabel.numberOfLines = 0
        let texts = UIStackView(arrangedSubviews: [titleLabel, hintLabel])
        texts.axis = .vertical
        texts.spacing = 8
        texts.alignment = .center
        column.addArrangedSubview(SettingsLook.inset(texts, top: 0, side: 24, bottom: 0))

        shaker.axis = .vertical
        shaker.alignment = .center
        column.addArrangedSubview(shaker)
        dots.axis = .horizontal
        dots.spacing = 20
        dots.isAccessibilityElement = true
        for _ in 0..<LockRules.digitsLength {
            let dot = UIView()
            dot.layer.cornerRadius = 8
            dot.layer.borderWidth = 1.5
            dot.translatesAutoresizingMaskIntoConstraints = false
            dot.widthAnchor.constraint(equalToConstant: 16).isActive = true
            dot.heightAnchor.constraint(equalToConstant: 16).isActive = true
            dots.addArrangedSubview(dot)
        }
        // The app's own code must not be offered to the system's password manager.
        field.isSecureTextEntry = true
        field.textContentType = .oneTimeCode
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .done
        field.textAlignment = .center
        field.font = .systemFont(ofSize: 17)
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.keyboardAppearance = Theme.dark ? .dark : .light
        field.attributedPlaceholder = NSAttributedString(string: "Пароль", attributes: [.foregroundColor: Theme.subtle])
        field.delegate = self
        field.addTarget(self, action: #selector(typed), for: .editingChanged)
        field.translatesAutoresizingMaskIntoConstraints = false
        fieldBox.backgroundColor = Theme.veil(0.06)
        fieldBox.layer.cornerRadius = 18
        fieldBox.layer.cornerCurve = .continuous
        fieldBox.layer.borderWidth = 1.4
        fieldBox.addSubview(field)
        fieldBox.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: fieldBox.topAnchor),
            field.bottomAnchor.constraint(equalTo: fieldBox.bottomAnchor),
            field.leadingAnchor.constraint(equalTo: fieldBox.leadingAnchor, constant: 17),
            field.trailingAnchor.constraint(equalTo: fieldBox.trailingAnchor, constant: -17),
            fieldBox.heightAnchor.constraint(equalToConstant: 54),
            fieldBox.widthAnchor.constraint(equalToConstant: 292),
        ])

        pad.axis = .vertical
        pad.spacing = 16
        pad.alignment = .center
        column.addArrangedSubview(pad)
        var look = UIButton.Configuration.filled()
        look.baseBackgroundColor = Theme.accent
        look.baseForegroundColor = Theme.onAccent
        look.cornerStyle = .large
        look.title = "Готово"
        doneButton.configuration = look
        doneButton.addTarget(self, action: #selector(donePressed), for: .touchUpInside)
        doneButton.translatesAutoresizingMaskIntoConstraints = false
        doneButton.heightAnchor.constraint(equalToConstant: 50).isActive = true
        doneButton.widthAnchor.constraint(equalToConstant: 292).isActive = true
        bioButton.tintColor = Theme.accent
        bioButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        bioButton.addTarget(self, action: #selector(bioPressed), for: .touchUpInside)
        footer.axis = .vertical
        footer.alignment = .center
        footer.spacing = 2
        column.addArrangedSubview(footer)
        setKind(kind)
    }

    required init?(coder: NSCoder) { return nil }

    func setTitle(_ title: String, hint: String, error: String) {
        titleLabel.text = title
        errorShown = !error.isEmpty
        hintLabel.text = error.isEmpty ? hint : error
        hintLabel.textColor = error.isEmpty ? Theme.muted : Theme.danger
        hintLabel.isHidden = (error.isEmpty ? hint : error).isEmpty
        paint()
        field.accessibilityLabel = title
    }

    /// A new kind (digits ↔ password) starts over.
    func setKind(_ next: String) {
        kind = next
        code = ""
        field.text = ""
        for old in shaker.arrangedSubviews {
            shaker.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        shaker.addArrangedSubview(kind == "digits" ? SettingsLook.inset(dots, top: 10, side: 0, bottom: 10) : fieldBox)
        buildPad()
        paint()
    }

    func focus() {
        if kind == "password" { field.becomeFirstResponder() }
    }

    private func buildPad() {
        for old in pad.arrangedSubviews {
            pad.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        if kind != "digits" {
            pad.spacing = 12
            pad.addArrangedSubview(doneButton)
            if let biometric {
                bioButton.setTitle(" " + biometric.label, for: .normal)
                bioButton.setImage(SettingsLook.symbol(biometric.symbol, size: 18, weight: .medium), for: .normal)
                pad.addArrangedSubview(bioButton)
            }
            applyDisabled()
            return
        }
        pad.spacing = 16
        let rows: [[String]] = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]]
        for row in rows {
            let line = UIStackView(arrangedSubviews: row.map { (digit: String) -> UIView in self.digitKey(digit) })
            line.axis = .horizontal
            line.spacing = 22
            pad.addArrangedSubview(line)
        }
        var last: [UIView] = []
        if let biometric {
            last.append(iconKey(biometric.symbol, label: biometric.label, action: #selector(bioPressed)))
        } else {
            last.append(blank())
        }
        last.append(digitKey("0"))
        let erase = iconKey("delete.left", label: "Стереть", action: #selector(erasePressed))
        erase.tag = 77
        last.append(erase)
        let line = UIStackView(arrangedSubviews: last)
        line.axis = .horizontal
        line.spacing = 22
        pad.addArrangedSubview(line)
        applyDisabled()
        paint()
    }

    private func blank() -> UIView {
        let space = UIView()
        space.translatesAutoresizingMaskIntoConstraints = false
        space.widthAnchor.constraint(equalToConstant: CodeEntryView.key).isActive = true
        space.heightAnchor.constraint(equalToConstant: CodeEntryView.key).isActive = true
        return space
    }

    private func digitKey(_ digit: String) -> UIView {
        let key = PadKeyButton(frame: .zero)
        key.backgroundColor = Theme.veil(0.08)
        key.layer.cornerRadius = CodeEntryView.key / 2
        key.layer.borderWidth = 0.5
        key.layer.borderColor = Theme.veil(0.12).cgColor
        key.setTitle(digit, for: .normal)
        key.setTitleColor(Theme.text, for: .normal)
        key.titleLabel?.font = .systemFont(ofSize: 30, weight: .medium)
        key.accessibilityLabel = digit
        key.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.press(digit) }, for: .touchUpInside)
        key.translatesAutoresizingMaskIntoConstraints = false
        key.widthAnchor.constraint(equalToConstant: CodeEntryView.key).isActive = true
        key.heightAnchor.constraint(equalToConstant: CodeEntryView.key).isActive = true
        return key
    }

    private func iconKey(_ symbol: String, label: String, action: Selector) -> UIView {
        let key = PadKeyButton(frame: .zero)
        key.setImage(SettingsLook.symbol(symbol, size: 26, weight: .regular), for: .normal)
        key.tintColor = Theme.text
        key.accessibilityLabel = label
        key.addTarget(self, action: action, for: .touchUpInside)
        key.translatesAutoresizingMaskIntoConstraints = false
        key.widthAnchor.constraint(equalToConstant: CodeEntryView.key).isActive = true
        key.heightAnchor.constraint(equalToConstant: CodeEntryView.key).isActive = true
        return key
    }

    private func applyDisabled() {
        pad.alpha = kind == "digits" && disabled ? 0.5 : 1
        field.isEnabled = !disabled
        doneButton.isEnabled = !disabled && !(field.text ?? "").isEmpty
        doneButton.alpha = doneButton.isEnabled ? 1 : 0.45
        bioButton.isEnabled = !disabled
    }

    private func paint() {
        let ink = errorShown ? Theme.danger : Theme.text
        for (index, dot) in dots.arrangedSubviews.enumerated() {
            dot.layer.borderColor = ink.cgColor
            dot.backgroundColor = index < code.count ? ink : .clear
        }
        dots.accessibilityLabel = "Введено цифр: \(code.count) из \(LockRules.digitsLength)"
        fieldBox.layer.borderColor = (errorShown ? Theme.danger : Theme.accent).cgColor
        if let erase = pad.viewWithTag(77) {
            erase.alpha = code.isEmpty ? 0 : 1
            erase.isUserInteractionEnabled = !code.isEmpty
        }
    }

    private func press(_ digit: String) {
        guard !disabled, kind == "digits", code.count < LockRules.digitsLength else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        code += digit
        paint()
        guard code.count == LockRules.digitsLength else { return }
        // The fourth digit sends the code by itself — after the dot has been drawn.
        submitTimer?.invalidate()
        let typedCode = code
        submitTimer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: false) { [weak self] (_: Timer) -> Void in
            self?.onSubmit?(typedCode)
        }
    }

    @objc private func erasePressed() {
        guard !disabled, !code.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        code.removeLast()
        paint()
    }

    @objc private func bioPressed() {
        guard !disabled else { return }
        biometric?.press()
    }

    @objc private func typed() {
        code = field.text ?? ""
        applyDisabled()
    }

    @objc private func donePressed() {
        guard !disabled, !code.isEmpty else { return }
        onSubmit?(code)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        donePressed()
        return false
    }

    /// A wrong code: what was typed is cleared, the phone buzzes and the entry shakes.
    func shake() {
        code = ""
        field.text = ""
        paint()
        applyDisabled()
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        let move = CAKeyframeAnimation(keyPath: "transform.translation.x")
        move.values = [0, -14, 12, -9, 6, 0]
        let total = 0.045 + 0.07 + 0.07 + 0.06 + 0.05
        move.keyTimes = [0, NSNumber(value: 0.045 / total), NSNumber(value: 0.115 / total), NSNumber(value: 0.185 / total), NSNumber(value: 0.245 / total), 1]
        move.duration = total
        shaker.layer.add(move, forKey: "shake")
    }

    /// The first code was taken: a quiet clear for «Повтори».
    func clearQuietly() {
        code = ""
        field.text = ""
        paint()
        applyDisabled()
    }
}

/// A round key of the pad that shrinks a little while pressed (Bouncy 0.88).
final class PadKeyButton: UIButton {
    override var isHighlighted: Bool {
        didSet {
            UIView.animate(withDuration: Motion.duration(0.12)) {
                self.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.88, y: 0.88) : .identity
            }
        }
    }
}
