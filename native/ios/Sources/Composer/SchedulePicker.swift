import UIKit

/// «Отправить позже» (the reference's scheduled/SchedulePicker.tsx): quick presets, or a day (stepped with ‹ ›,
/// up to a year ahead) with an hour and a minute typed in. The chosen moment is handed back; the message is
/// encrypted now and the server releases it then.
final class SchedulePickerController: UIViewController, UITextFieldDelegate {
    /// The moment chosen (the sheet is already closing).
    var onPick: ((Date) -> Void)?

    private var now = Date()
    private var dayOffset = 0
    private let scroll = UIScrollView()
    private let headingLabel = UILabel()
    private var presetRows: [UIControl] = []
    private var presets: [(label: String, at: Date)] = []
    private let card = UIView()
    private let cardHeading = UILabel()
    private let earlier = UIButton(type: .system)
    private let later = UIButton(type: .system)
    private let dayLabel = UILabel()
    private let hourField = UITextField()
    private let colon = UILabel()
    private let minuteField = UITextField()
    private let problemLabel = UILabel()
    private let planButton = UIButton(type: .custom)

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
        view.addSubview(scroll)
        scroll.keyboardDismissMode = .interactive
        scroll.alwaysBounceVertical = true

        headingLabel.text = "Отправить позже"
        headingLabel.font = .systemFont(ofSize: 20, weight: .bold)
        headingLabel.textColor = Theme.text
        scroll.addSubview(headingLabel)

        // Every time the sheet opens: «now» and the suggested time (the next whole hour, tomorrow after 23:00).
        now = Date()
        presets = ScheduleModel.presets(now: now)
        for (index, preset) in presets.enumerated() {
            let row = SchedulePresetRow(label: preset.label, note: ScheduleModel.formatDeliverAt(preset.at, now: now))
            row.tag = index
            row.addTarget(self, action: #selector(presetChosen(_:)), for: .touchUpInside)
            scroll.addSubview(row)
            presetRows.append(row)
        }

        card.backgroundColor = Theme.surface2
        card.layer.cornerRadius = 20
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = 1
        card.layer.borderColor = Theme.veil(0.08).cgColor
        scroll.addSubview(card)
        cardHeading.attributedText = NSAttributedString(string: "ДРУГОЕ ВРЕМЯ", attributes: [.kern: 1.2, .font: UIFont.systemFont(ofSize: 12, weight: .bold), .foregroundColor: Theme.muted])
        card.addSubview(cardHeading)
        earlier.setImage(chatSymbol("chevron.left", 18, .semibold), for: .normal)
        earlier.tintColor = Theme.accent
        earlier.accessibilityLabel = "Днём раньше"
        earlier.addTarget(self, action: #selector(stepBack), for: .touchUpInside)
        card.addSubview(earlier)
        later.setImage(chatSymbol("chevron.right", 18, .semibold), for: .normal)
        later.tintColor = Theme.accent
        later.accessibilityLabel = "Днём позже"
        later.addTarget(self, action: #selector(stepOn), for: .touchUpInside)
        card.addSubview(later)
        dayLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        dayLabel.textColor = Theme.text
        dayLabel.textAlignment = .center
        card.addSubview(dayLabel)
        for (field, label) in [(hourField, "Часы"), (minuteField, "Минуты")] {
            field.font = .systemFont(ofSize: 22, weight: .bold)
            field.textColor = Theme.text
            field.textAlignment = .center
            field.keyboardType = .numberPad
            field.keyboardAppearance = Theme.dark ? .dark : .light
            field.backgroundColor = Theme.veil(0.07)
            field.layer.cornerRadius = 12
            field.accessibilityLabel = label
            field.delegate = self
            field.addTarget(self, action: #selector(typed), for: .editingChanged)
            card.addSubview(field)
        }
        let next = (Calendar.current.component(.hour, from: now) + 1) % 24
        hourField.text = next < 10 ? "0\(next)" : "\(next)"
        minuteField.text = "00"
        dayOffset = next == 0 ? 1 : 0
        colon.text = ":"
        colon.font = .systemFont(ofSize: 22, weight: .bold)
        colon.textColor = Theme.text
        colon.textAlignment = .center
        card.addSubview(colon)
        problemLabel.font = .systemFont(ofSize: 12)
        problemLabel.textColor = Theme.muted
        problemLabel.textAlignment = .center
        problemLabel.numberOfLines = 2
        card.addSubview(problemLabel)
        planButton.backgroundColor = Theme.accent
        planButton.layer.cornerRadius = 16
        planButton.layer.cornerCurve = .continuous
        planButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
        planButton.titleLabel?.adjustsFontSizeToFitWidth = true
        planButton.titleLabel?.minimumScaleFactor = 0.8
        planButton.setTitleColor(Theme.onAccent, for: .normal)
        planButton.addTarget(self, action: #selector(plan), for: .touchUpInside)
        card.addSubview(planButton)
        showCustom()
    }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        let digits = string.filter { $0.isASCII && $0.isNumber }
        let current = (textField.text ?? "") as NSString
        let next = current.replacingCharacters(in: range, with: digits)
        if digits != string || next.count > 2 {
            textField.text = String(next.filter { $0.isASCII && $0.isNumber }.prefix(2))
            showCustom()
            return false
        }
        return true
    }

    func textFieldDidBeginEditing(_ textField: UITextField) {
        // selectTextOnFocus
        DispatchQueue.main.async { textField.selectAll(nil) }
    }

    @objc private func typed() { showCustom() }

    private var day: Date { Calendar.current.date(byAdding: .day, value: dayOffset, to: now) ?? now }

    /// The moment the custom part makes, or nil when the time is not «ЧЧ:ММ».
    private var custom: Date? {
        let hourText = hourField.text ?? "", minuteText = minuteField.text ?? ""
        guard (1...2).contains(hourText.count), (1...2).contains(minuteText.count), let hour = Int(hourText), let minute = Int(minuteText), hour <= 23, minute <= 59 else { return nil }
        return ScheduleModel.withDayTime(day, hour: hour, minute: minute)
    }

    private func showCustom() {
        dayLabel.text = ScheduleModel.dayLabel(day, now: now)
        earlier.isEnabled = dayOffset > 0
        earlier.alpha = dayOffset > 0 ? 1 : 0.3
        later.isEnabled = dayOffset < 365
        later.alpha = dayOffset < 365 ? 1 : 0.3
        let made = custom
        let problem: String? = made.map { ScheduleModel.validate($0, now: now) } ?? "Укажи время в виде ЧЧ:ММ."
        problemLabel.text = problem
        problemLabel.isHidden = problem == nil
        if let made, problem == nil {
            planButton.setTitle("Запланировать: " + ScheduleModel.formatDeliverAt(made, now: now), for: .normal)
        } else {
            planButton.setTitle("Запланировать", for: .normal)
        }
        planButton.isEnabled = problem == nil
        planButton.alpha = problem == nil ? 1 : 0.4
        view.setNeedsLayout()
    }

    @objc private func stepBack() {
        dayOffset = max(0, dayOffset - 1)
        UISelectionFeedbackGenerator().selectionChanged()
        showCustom()
    }

    @objc private func stepOn() {
        dayOffset = min(365, dayOffset + 1)
        UISelectionFeedbackGenerator().selectionChanged()
        showCustom()
    }

    private func pick(_ at: Date) {
        // Checked once more against the clock of this moment.
        guard ScheduleModel.validate(at, now: Date()) == nil else { return }
        let picked = onPick
        view.endEditing(true)
        dismiss(animated: true) { picked?(at) }
    }

    @objc private func presetChosen(_ sender: UIControl) {
        guard sender.tag < presets.count else { return }
        pick(presets[sender.tag].at)
    }

    @objc private func plan() {
        guard let made = custom else { return }
        pick(made)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scroll.frame = view.bounds
        let width = view.bounds.width
        var y: CGFloat = 30
        headingLabel.frame = CGRect(x: 20, y: y, width: width - 40, height: 26)
        y += 40
        for row in presetRows {
            row.frame = CGRect(x: 8, y: y, width: width - 16, height: 64)
            y += 64
        }
        y += 10
        let inner = width - 32 - 28
        cardHeading.frame = CGRect(x: 14, y: 14, width: inner, height: 16)
        earlier.frame = CGRect(x: 8, y: 40, width: 40, height: 40)
        later.frame = CGRect(x: width - 32 - 48, y: 40, width: 40, height: 40)
        dayLabel.frame = CGRect(x: 52, y: 40, width: width - 32 - 104, height: 40)
        let fieldsWidth: CGFloat = 56 * 2 + 6 * 2 + 12
        let left = (width - 32 - fieldsWidth) / 2
        hourField.frame = CGRect(x: left, y: 92, width: 56, height: 46)
        colon.frame = CGRect(x: left + 56 + 6, y: 92, width: 12, height: 46)
        minuteField.frame = CGRect(x: left + 56 + 24, y: 92, width: 56, height: 46)
        var cardY: CGFloat = 150
        if !problemLabel.isHidden {
            problemLabel.frame = CGRect(x: 14, y: cardY, width: inner, height: 32)
            cardY += 40
        }
        planButton.frame = CGRect(x: 14, y: cardY, width: inner, height: 46)
        cardY += 46 + 14
        card.frame = CGRect(x: 16, y: y, width: width - 32, height: cardY)
        y += cardY + 40
        scroll.contentSize = CGSize(width: width, height: y)
    }
}

/// One quick choice of the picker: a clock, the choice, and when exactly it is.
private final class SchedulePresetRow: UIControl {
    private let mark = UIImageView()
    private let nameLabel = UILabel()
    private let noteLabel = UILabel()

    init(label: String, note: String) {
        super.init(frame: .zero)
        mark.image = chatSymbol("clock", 19)
        mark.tintColor = Theme.text
        mark.contentMode = .center
        addSubview(mark)
        nameLabel.text = label
        nameLabel.font = .systemFont(ofSize: 17)
        nameLabel.textColor = Theme.text
        addSubview(nameLabel)
        noteLabel.text = note
        noteLabel.font = .systemFont(ofSize: 13)
        noteLabel.textColor = Theme.muted
        addSubview(noteLabel)
        layer.cornerRadius = 14
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = label + ". " + note
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? Theme.veil(0.07) : .clear }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        mark.frame = CGRect(x: 8, y: 0, width: 36, height: bounds.height)
        nameLabel.frame = CGRect(x: 52, y: 11, width: width - 64, height: 22)
        noteLabel.frame = CGRect(x: 52, y: 34, width: width - 64, height: 18)
    }
}
