import UIKit

/// The sheets of the profile editor (the reference's ProfileScreen.tsx): «Персональный цвет», «Узор фона» and
/// «День рождения», each the content of a `ChoiceSheet`.
enum ProfileEditSheets {
    /// The width of a sheet's content: the card is 12 from the screen's sides (580 wide at most) with 22 inside.
    static var contentWidth: CGFloat { return min(580, UIScreen.main.bounds.width - 24) - 44 }

    /// «Персональный цвет»: the words (13, line 19, `muted`), the eight colours and «Готово», 14 apart. A colour is
    /// taken as it is touched; «Готово» only closes.
    static func color(current: String, picked: @escaping (String) -> Void) -> ChoiceSheet {
        let grid = ProfileColorGrid(current: current, width: contentWidth, picked: picked)
        let ready = SettingsButton(label: "Готово")
        let sheet = ChoiceSheet(heading: "Персональный цвет", parts: [
            SettingsLook.para("Этим цветом тебя видят в чатах у других, пока нет фото.", size: 13, color: Theme.muted, line: 19),
            grid,
            ready,
        ], gap: 14)
        ready.onPress = { [weak sheet] in sheet?.dismiss(animated: true) }
        return sheet
    }

    /// «Узор фона»: the words, «Без узора» and the emoji (tiles of 48, 8 apart, in the middle) and «Готово», 14 apart.
    static func pattern(current: String?, picked: @escaping (String?) -> Void) -> ChoiceSheet {
        let grid = ProfilePatternGrid(current: current, width: contentWidth, picked: picked)
        let ready = SettingsButton(label: "Готово")
        let sheet = ChoiceSheet(heading: "Узор фона", parts: [
            SettingsLook.para("Значок, которым усыпан фон вокруг твоего фото в профиле.", size: 13, color: Theme.muted, line: 19),
            grid,
            ready,
        ], gap: 14)
        ready.onPress = { [weak sheet] in sheet?.dismiss(animated: true) }
        return sheet
    }

    /// «День рождения»: the months, the days, the year if the person wants it, «Готово» (and «Убрать день рождения»
    /// when there is one). `done` gets the chosen day, or nil when it was removed.
    static func birthday(value: String?, done: @escaping (String?) -> Void) -> ChoiceSheet {
        let picker = BirthdayPickerView(value: value, width: contentWidth)
        let sheet = ChoiceSheet(heading: "День рождения", parts: [picker], gap: 14)
        picker.onDone = { [weak sheet] (chosen: String?) -> Void in
            sheet?.dismiss(animated: true) { done(chosen) }
        }
        return sheet
    }
}

/// The colours a person can be seen in while there is no photo: rounds of 46, 12 apart, wrapping; the chosen one has
/// a 3 rim in the text colour and a white «checkmark» 20.
final class ProfileColorGrid: UIView {
    /// The reference's eight.
    static let colors = ["#596FE8", "#4088C7", "#9271C3", "#B78358", "#AD6C8C", "#667FA4", "#3FA37C", "#D0644E"]
    private var current: String
    private let picked: (String) -> Void
    private var dots: [UIButton] = []
    private var marks: [UIImageView] = []
    private let side: CGFloat = 46
    private let gap: CGFloat = 12

    init(current: String, width: CGFloat, picked: @escaping (String) -> Void) {
        self.current = current
        self.picked = picked
        super.init(frame: .zero)
        for (index, value) in ProfileColorGrid.colors.enumerated() {
            let dot = UIButton(type: .custom)
            dot.backgroundColor = UIColor(hex: Messenger.color(value))
            dot.layer.cornerRadius = side / 2
            dot.layer.borderColor = Theme.text.cgColor
            dot.tag = index
            dot.accessibilityLabel = "Цвет \(index + 1)"
            dot.addTarget(self, action: #selector(pressed(_:)), for: .touchUpInside)
            let mark = UIImageView(image: IonIcon.image("checkmark", size: 20))
            mark.tintColor = .white
            mark.contentMode = .center
            mark.isUserInteractionEnabled = false
            mark.frame = CGRect(x: 0, y: 0, width: side, height: side)
            dot.addSubview(mark)
            addSubview(dot)
            dots.append(dot)
            marks.append(mark)
        }
        let columns = self.columns(width)
        let rows = (dots.count + columns - 1) / columns
        heightAnchor.constraint(equalToConstant: CGFloat(rows) * side + CGFloat(rows - 1) * gap).isActive = true
        show()
    }

    required init?(coder: NSCoder) { return nil }

    private func columns(_ width: CGFloat) -> Int {
        return max(1, Int((width + gap) / (side + gap)))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let columns = self.columns(bounds.width)
        for (index, dot) in dots.enumerated() {
            dot.frame = CGRect(x: CGFloat(index % columns) * (side + gap), y: CGFloat(index / columns) * (side + gap), width: side, height: side)
        }
    }

    private func show() {
        for (index, dot) in dots.enumerated() {
            let on = ProfileColorGrid.colors[index].uppercased() == current.uppercased()
            dot.layer.borderWidth = on ? 3 : 0
            marks[index].isHidden = !on
            dot.accessibilityTraits = on ? [.button, .selected] : [.button]
        }
    }

    @objc private func pressed(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < ProfileColorGrid.colors.count else { return }
        current = ProfileColorGrid.colors[sender.tag]
        show()
        picked(current)
    }
}

/// «Без узора» and the emoji the background around the photo can be strewn with: tiles of 48 (radius 14, `surface2`),
/// 8 apart, wrapping, each row in the middle; the chosen one has a 2 rim in the accent.
final class ProfilePatternGrid: UIView {
    private var current: String?
    private let picked: (String?) -> Void
    private let options: [String?]
    private var cells: [UIButton] = []
    private let side: CGFloat = 48
    private let gap: CGFloat = 8

    init(current: String?, width: CGFloat, picked: @escaping (String?) -> Void) {
        self.current = current
        self.picked = picked
        var all: [String?] = [nil]
        for value in AvatarCatalog.patterns { all.append(value) }
        options = all
        super.init(frame: .zero)
        for (index, option) in options.enumerated() {
            let cell = UIButton(type: .custom)
            cell.backgroundColor = Theme.surface2
            cell.layer.cornerRadius = 14
            cell.layer.borderWidth = 2
            if let option {
                cell.setTitle(option, for: .normal)
                cell.titleLabel?.font = .systemFont(ofSize: 24)
                cell.accessibilityLabel = option
            } else {
                cell.setImage(IonIcon.image("close", size: 20), for: .normal)
                cell.tintColor = Theme.muted
                cell.accessibilityLabel = "Без узора"
            }
            cell.tag = index
            cell.addTarget(self, action: #selector(pressed(_:)), for: .touchUpInside)
            addSubview(cell)
            cells.append(cell)
        }
        let columns = self.columns(width)
        let rows = (cells.count + columns - 1) / columns
        heightAnchor.constraint(equalToConstant: CGFloat(rows) * side + CGFloat(rows - 1) * gap).isActive = true
        show()
    }

    required init?(coder: NSCoder) { return nil }

    private func columns(_ width: CGFloat) -> Int {
        return max(1, Int((width + gap) / (side + gap)))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let columns = self.columns(bounds.width)
        let rows = (cells.count + columns - 1) / columns
        for (index, cell) in cells.enumerated() {
            let row = index / columns
            // The last row may be shorter; like every row it stands in the middle.
            let inRow = row == rows - 1 ? cells.count - row * columns : columns
            let rowWidth = CGFloat(inRow) * side + CGFloat(inRow - 1) * gap
            let left = (bounds.width - rowWidth) / 2
            cell.frame = CGRect(x: left + CGFloat(index % columns) * (side + gap), y: CGFloat(row) * (side + gap), width: side, height: side)
        }
    }

    private func show() {
        for (index, cell) in cells.enumerated() {
            let on = options[index] == current
            cell.layer.borderColor = on ? Theme.accent.cgColor : UIColor.clear.cgColor
            cell.accessibilityTraits = on ? [.button, .selected] : [.button]
        }
    }

    @objc private func pressed(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < options.count else { return }
        current = options[sender.tag]
        show()
        picked(current)
    }
}

/// The content of «День рождения» (ProfileScreen.tsx `BirthdaySheet`), 14 between its parts: the months as chips in
/// one row that scrolls sideways (34 tall, 12 inside, 6 apart; the chosen one in the accent, 14 Bold), the days as
/// rounds of 40, 6 apart, wrapping (the chosen one in the accent, 15 Bold), «Год (необязательно)», «Видят только
/// друзья: …» (13, `muted`), «Готово» and — when there is a birthday — «Убрать день рождения».
final class BirthdayPickerView: UIView {
    /// The chosen day («MM-DD» or «YYYY-MM-DD»), or nil when the birthday is removed.
    var onDone: ((String?) -> Void)?
    private var month = 1
    private var day = 1
    private let chips = UIScrollView()
    private var monthButtons: [UIButton] = []
    private var monthWidths: [NSLayoutConstraint] = []
    private let dayGrid = UIView()
    private var dayButtons: [UIButton] = []
    private let yearField = SettingsField(caption: "Год (необязательно)", placeholder: "Например, 1999")
    private let yearError = SettingsLook.words("", size: 12, color: Theme.danger)
    private let preview = SettingsLook.words("", size: 13, color: Theme.muted)
    private let doneButton = SettingsButton(label: "Готово")
    private let thisYear = Calendar(identifier: .gregorian).component(.year, from: Date())
    private let daySide: CGFloat = 40
    private let dayGap: CGFloat = 6

    init(value: String?, width: CGFloat) {
        super.init(frame: .zero)
        let made = BirthdayWords.parse(value)
        if let made, made.month >= 1, made.month <= 12 {
            month = made.month
            day = max(1, min(31, made.day))
        }

        let chipRow = UIStackView()
        chipRow.axis = .horizontal
        chipRow.spacing = 6
        chipRow.translatesAutoresizingMaskIntoConstraints = false
        for (index, label) in BirthdayWords.months.enumerated() {
            let chip = UIButton(type: .custom)
            chip.setTitle(label, for: .normal)
            chip.layer.cornerRadius = 17
            chip.tag = index + 1
            chip.addTarget(self, action: #selector(monthPressed(_:)), for: .touchUpInside)
            chip.translatesAutoresizingMaskIntoConstraints = false
            let wide = chip.widthAnchor.constraint(equalToConstant: 60)
            wide.isActive = true
            chip.heightAnchor.constraint(equalToConstant: 34).isActive = true
            chipRow.addArrangedSubview(chip)
            monthButtons.append(chip)
            monthWidths.append(wide)
        }
        chips.showsHorizontalScrollIndicator = false
        chips.translatesAutoresizingMaskIntoConstraints = false
        chips.addSubview(chipRow)
        NSLayoutConstraint.activate([
            chips.heightAnchor.constraint(equalToConstant: 34),
            chipRow.topAnchor.constraint(equalTo: chips.contentLayoutGuide.topAnchor),
            chipRow.bottomAnchor.constraint(equalTo: chips.contentLayoutGuide.bottomAnchor),
            chipRow.leadingAnchor.constraint(equalTo: chips.contentLayoutGuide.leadingAnchor),
            chipRow.trailingAnchor.constraint(equalTo: chips.contentLayoutGuide.trailingAnchor),
            chipRow.heightAnchor.constraint(equalTo: chips.frameLayoutGuide.heightAnchor),
        ])

        for number in 1...31 {
            let button = UIButton(type: .custom)
            button.setTitle(String(number), for: .normal)
            button.layer.cornerRadius = daySide / 2
            button.tag = number
            button.addTarget(self, action: #selector(dayPressed(_:)), for: .touchUpInside)
            dayGrid.addSubview(button)
            dayButtons.append(button)
        }
        // Room for the longest month (31 days) at this width, so the sheet keeps its height from month to month.
        let columns = self.columns(width)
        let rows = (31 + columns - 1) / columns
        dayGrid.translatesAutoresizingMaskIntoConstraints = false
        dayGrid.heightAnchor.constraint(equalToConstant: CGFloat(rows) * daySide + CGFloat(rows - 1) * dayGap).isActive = true

        yearField.limit = 4
        yearField.allowed = CharacterSet(charactersIn: "0123456789")
        yearField.input.keyboardType = .numberPad
        if let year = made?.year { yearField.value = String(year) }
        yearField.onEdit = { [weak self] in self?.show() }
        let yearBox = UIStackView(arrangedSubviews: [yearField, SettingsLook.inset(yearError, top: 0, side: 3, bottom: 0)])
        yearBox.axis = .vertical
        yearBox.spacing = 8

        doneButton.onPress = { [weak self] in self?.finish() }
        let stack = UIStackView(arrangedSubviews: [chips, dayGrid, yearBox, preview, doneButton])
        stack.axis = .vertical
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        if value != nil {
            let remove = SettingsButton(label: "Убрать день рождения", kind: .danger)
            remove.onPress = { [weak self] in self?.onDone?(nil) }
            stack.addArrangedSubview(remove)
        }
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        show()
    }

    required init?(coder: NSCoder) { return nil }

    private func columns(_ width: CGFloat) -> Int {
        return max(1, Int((width + dayGap) / (daySide + dayGap)))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let columns = self.columns(bounds.width)
        for (index, button) in dayButtons.enumerated() {
            button.frame = CGRect(x: CGFloat(index % columns) * (daySide + dayGap), y: CGFloat(index / columns) * (daySide + dayGap), width: daySide, height: daySide)
        }
    }

    /// The typed year when it is four digits; nil otherwise.
    private var year: Int? {
        let typed = yearField.value
        guard typed.unicodeScalars.count == 4 else { return nil }
        return Int(typed)
    }

    private var yearProblem: String {
        let typed = yearField.value
        if typed.isEmpty { return "" }
        if let year, year >= 1900, year <= thisYear { return "" }
        return "Год — от 1900 до \(thisYear)"
    }

    private var chosen: BirthdayWords.Day {
        let most = BirthdayWords.daysInMonth(month, year: year)
        return BirthdayWords.Day(day: min(day, most), month: month, year: year)
    }

    private func show() {
        let made = chosen
        for (index, chip) in monthButtons.enumerated() {
            let on = index + 1 == month
            let font = UIFont.systemFont(ofSize: 14, weight: on ? .bold : .medium)
            chip.titleLabel?.font = font
            chip.setTitleColor(on ? Theme.onAccent : Theme.text, for: .normal)
            chip.backgroundColor = on ? Theme.accent : Theme.surface2
            chip.accessibilityTraits = on ? [.button, .selected] : [.button]
            let words = BirthdayWords.months[index] as NSString
            monthWidths[index].constant = ceil(words.size(withAttributes: [.font: font]).width) + 24
        }
        let most = BirthdayWords.daysInMonth(month, year: year)
        for (index, button) in dayButtons.enumerated() {
            let on = index + 1 == made.day
            button.isHidden = index >= most
            button.titleLabel?.font = .systemFont(ofSize: 15, weight: on ? .bold : .medium)
            button.setTitleColor(on ? Theme.onAccent : Theme.text, for: .normal)
            button.backgroundColor = on ? Theme.accent : .clear
            button.accessibilityTraits = on ? [.button, .selected] : [.button]
        }
        let problem = yearProblem
        yearError.text = problem
        yearError.superview?.isHidden = problem.isEmpty
        preview.text = "Видят только друзья: " + BirthdayWords.format(BirthdayWords.value(made))
        doneButton.isEnabled = problem.isEmpty
    }

    @objc private func monthPressed(_ sender: UIButton) {
        guard sender.tag >= 1, sender.tag <= 12 else { return }
        month = sender.tag
        show()
    }

    @objc private func dayPressed(_ sender: UIButton) {
        guard sender.tag >= 1, sender.tag <= 31 else { return }
        day = sender.tag
        show()
    }

    private func finish() {
        guard yearProblem.isEmpty else { return }
        onDone?(BirthdayWords.value(chosen))
    }
}
