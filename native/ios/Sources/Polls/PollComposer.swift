import UIKit

/// «Новый опрос» (the reference's PollBubble.tsx `PollComposer`): the question, from two to ten options, «Несколько
/// ответов», «Отправить опрос». Limits as the reference's POLL_LIMITS (the core checks them once more).
final class PollComposerController: UIViewController, UITextFieldDelegate {
    static let questionLimit = 255
    static let optionLimit = 100
    static let minOptions = 2
    static let maxOptions = 10

    /// The poll to send: `{question, options, multiple}` (the sheet is already closing).
    var onSend: (([String: Any]) -> Void)?

    private let scroll = UIScrollView()
    private let headingLabel = UILabel()
    private let questionField = UITextField()
    private var optionFields: [UITextField] = []
    private var removeButtons: [UIButton] = []
    private let addButton = UIButton(type: .system)
    private let multipleLabel = UILabel()
    private let multipleSwitch = UISwitch()
    private let sendButton = UIButton(type: .custom)

    init() {
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 28
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.page(UIColor(hex: 0x141516))
        scroll.keyboardDismissMode = .interactive
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        headingLabel.text = "Новый опрос"
        headingLabel.font = Theme.title(Theme.TypeSize.sheetTitle) // Fonts
        headingLabel.textColor = Theme.text
        scroll.addSubview(headingLabel)
        style(questionField, hint: "Вопрос")
        scroll.addSubview(questionField)
        addOption()
        addOption()
        addButton.setImage(chatSymbol("plus.circle", 19), for: .normal)
        addButton.setTitle("  Добавить вариант", for: .normal)
        addButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        addButton.tintColor = Theme.accent
        addButton.contentHorizontalAlignment = .leading
        addButton.addTarget(self, action: #selector(addTapped), for: .touchUpInside)
        scroll.addSubview(addButton)
        multipleLabel.text = "Несколько ответов"
        multipleLabel.font = .systemFont(ofSize: 14)
        multipleLabel.textColor = Theme.text
        scroll.addSubview(multipleLabel)
        SettingsLook.paint(multipleSwitch)
        multipleSwitch.accessibilityLabel = "Несколько ответов"
        scroll.addSubview(multipleSwitch)
        sendButton.backgroundColor = Theme.accent
        sendButton.layer.cornerRadius = 16
        sendButton.layer.cornerCurve = .continuous
        sendButton.setImage(chatSymbol("chart.bar", 16), for: .normal)
        sendButton.setTitle("  Отправить опрос", for: .normal)
        sendButton.tintColor = Theme.onAccent
        sendButton.setTitleColor(Theme.onAccent, for: .normal)
        sendButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
        sendButton.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        scroll.addSubview(sendButton)
        showReady()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if questionField.text?.isEmpty ?? true { questionField.becomeFirstResponder() }
    }

    private func style(_ field: UITextField, hint: String) {
        field.font = .systemFont(ofSize: 15)
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.attributedPlaceholder = NSAttributedString(string: hint, attributes: [.foregroundColor: Theme.muted])
        field.backgroundColor = Theme.surface2
        field.layer.cornerRadius = 14
        field.layer.cornerCurve = .continuous
        field.layer.borderWidth = 1
        field.layer.borderColor = Theme.veil(0.08).cgColor
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 13, height: 10))
        field.leftViewMode = .always
        field.keyboardAppearance = Theme.dark ? .dark : .light
        field.returnKeyType = .next
        field.accessibilityLabel = hint
        field.delegate = self
        field.addTarget(self, action: #selector(edited), for: .editingChanged)
    }

    private func addOption() {
        guard optionFields.count < PollComposerController.maxOptions else { return }
        let field = UITextField()
        style(field, hint: "Вариант \(optionFields.count + 1)")
        scroll.addSubview(field)
        optionFields.append(field)
        let remove = UIButton(type: .system)
        remove.setImage(chatSymbol("xmark", 15, .semibold), for: .normal)
        remove.tintColor = Theme.muted
        remove.accessibilityLabel = "Убрать вариант"
        remove.addTarget(self, action: #selector(removeTapped(_:)), for: .touchUpInside)
        scroll.addSubview(remove)
        removeButtons.append(remove)
        renumber()
    }

    /// The hints follow the order («Вариант 1», «Вариант 2»…) and the buttons know their rows.
    private func renumber() {
        for (index, field) in optionFields.enumerated() {
            let hint = "Вариант \(index + 1)"
            field.attributedPlaceholder = NSAttributedString(string: hint, attributes: [.foregroundColor: Theme.muted])
            field.accessibilityLabel = hint
            removeButtons[index].tag = index
            removeButtons[index].isHidden = optionFields.count <= PollComposerController.minOptions
        }
        addButton.isHidden = optionFields.count >= PollComposerController.maxOptions
        view.setNeedsLayout()
    }

    @objc private func addTapped() {
        addOption()
        optionFields.last?.becomeFirstResponder()
        showReady()
    }

    @objc private func removeTapped(_ sender: UIButton) {
        guard optionFields.count > PollComposerController.minOptions, sender.tag < optionFields.count else { return }
        optionFields[sender.tag].removeFromSuperview()
        removeButtons[sender.tag].removeFromSuperview()
        optionFields.remove(at: sender.tag)
        removeButtons.remove(at: sender.tag)
        renumber()
        showReady()
    }

    @objc private func edited() { showReady() }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        let limit = textField === questionField ? PollComposerController.questionLimit : PollComposerController.optionLimit
        let now = ((textField.text ?? "") as NSString).length
        return now - range.length + (string as NSString).length <= limit
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === questionField { optionFields.first?.becomeFirstResponder(); return false }
        if let index = optionFields.firstIndex(where: { $0 === textField }), index + 1 < optionFields.count {
            optionFields[index + 1].becomeFirstResponder()
        } else {
            textField.resignFirstResponder()
        }
        return false
    }

    private var question: String { (questionField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    private var options: [String] {
        optionFields.map { ($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
    private var ready: Bool { !question.isEmpty && options.count >= PollComposerController.minOptions }

    private func showReady() {
        sendButton.isEnabled = ready
        sendButton.alpha = ready ? 1 : 0.4
    }

    @objc private func sendTapped() {
        guard ready else { return }
        let poll: [String: Any] = ["question": question, "options": options, "multiple": multipleSwitch.isOn]
        let send = onSend
        view.endEditing(true)
        dismiss(animated: true) { send?(poll) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scroll.frame = view.bounds
        let width = view.bounds.width
        var y: CGFloat = 30
        headingLabel.frame = CGRect(x: 20, y: y, width: width - 40, height: 26)
        y += 44
        questionField.frame = CGRect(x: 16, y: y, width: width - 32, height: 46)
        y += 56
        let many = optionFields.count > PollComposerController.minOptions
        for (index, field) in optionFields.enumerated() {
            field.frame = CGRect(x: 16, y: y, width: width - 32 - (many ? 40 : 0), height: 46)
            removeButtons[index].frame = CGRect(x: width - 16 - 34, y: y + 6, width: 34, height: 34)
            y += 56
        }
        if !addButton.isHidden {
            addButton.frame = CGRect(x: 16, y: y, width: width - 32, height: 36)
            y += 44
        }
        multipleLabel.frame = CGRect(x: 16, y: y, width: width - 32 - 60, height: 32)
        multipleSwitch.frame = CGRect(x: width - 16 - 51, y: y, width: 51, height: 31)
        y += 46
        sendButton.frame = CGRect(x: 16, y: y, width: width - 32, height: 50)
        y += 50 + 40
        scroll.contentSize = CGSize(width: width, height: y)
    }
}

/// What a poll goes out with (the reference's messageMeta.ts `pollFallback`): the text a chat list or an older
/// client shows — «📊 question», then «1. option» lines — at most 8000 UTF-16 units.
enum PollText {
    static func fallback(_ poll: [String: Any]) -> String {
        var lines = ["📊 " + (poll["question"] as? String ?? "")]
        for (index, option) in (poll["options"] as? [String] ?? []).enumerated() { lines.append("\(index + 1). " + option) }
        let whole = lines.joined(separator: "\n")
        let units = Array(whole.utf16)
        if units.count <= 8000 { return whole }
        // JavaScript's slice by units: a surrogate pair cut in two keeps its first half, as the reference does.
        return String(decoding: units.prefix(8000), as: UTF16.self)
    }
}
