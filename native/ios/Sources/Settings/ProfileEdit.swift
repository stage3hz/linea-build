import UIKit

/// «Мой профиль»: the name, a few words about oneself, the public @username, the birthday, the colour.
/// (The previous app: the editor of `mobile/src/ProfileScreen.tsx`.) Nothing is sent until «Сохранить».
final class ProfileEditViewController: SettingsPage {
    private let messenger: Messenger
    private var birthday: String?
    private var gender: String?
    private var color: String
    private var busy = false

    // Profile: the banner and the decorated avatar at the top, tapped to change (photo, GIF, video up to 10 s), the
    // background pattern and «Рамки и анимации» (Sources/Profile, Sources/Platina).
    private let ball = DecoratedAvatarView(frame: CGRect(x: 0, y: 0, width: 96, height: 96))
    private let bannerTile = UIControl()
    private let bannerArt = ProfileBannerView()
    private let photoWords = UIButton(type: .system)
    private var pattern: String?
    private let patternRow = SettingsRow(symbol: "ion:sparkles", label: "Узор фона")
    private lazy var media = ProfilePhotoChange(messenger: messenger, host: self)
    private let noticeBox = UIStackView()
    private let nameField = SettingsField(caption: "", placeholder: "Имя")
    private let bioArea = SettingsTextArea(placeholder: "О себе")
    private let handleRow = SettingsRow(symbol: "ion:at", label: "Имя пользователя")
    private let birthdayRow = SettingsRow(symbol: "ion:gift", label: "День рождения")
    private let genderRow = SettingsRow(symbol: "ion:person", label: "Пол")
    private let saveButton = SettingsButton(label: "Сохранить")
    private var swatches: [UIButton] = []

    /// The colours a person can be seen in while there is no photo (the reference's eight).
    private static let colors = ["#596FE8", "#4088C7", "#9271C3", "#B78358", "#AD6C8C", "#667FA4", "#3FA37C", "#D0644E"]

    init(messenger: Messenger) {
        self.messenger = messenger
        let own = messenger.ownProfile
        birthday = own["birthday"] as? String
        gender = own["gender"] as? String
        color = own["avatarColor"] as? String ?? "#5E7BFF"
        pattern = own["profilePattern"] as? String // Profile
        super.init(name: "Мой профиль")
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func build() {
        let own = messenger.ownProfile
        NotificationCenter.default.addObserver(self, selector: #selector(profileChanged), name: Messenger.ownProfileChanged, object: nil)

        add(ProfileEditMedia.top(banner: bannerTile, art: bannerArt, avatar: ball, words: photoWords), gap: 0) // Profile
        bannerTile.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.media.ask(kind: "banner") }, for: .touchUpInside)
        ball.isUserInteractionEnabled = true
        ball.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(avatarPressed)))
        photoWords.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.media.ask(kind: "avatar") }, for: .touchUpInside)
        media.onBusy = { [weak self] (busy: Bool) -> Void in self?.photoWords.setTitle(busy ? "Загружаем…" : "Изменить фотографию", for: .normal) }
        media.onNotice = { [weak self] (words: String, error: Bool) -> Void in
            if !words.isEmpty { self?.showNotice(words, error: error) }
        }
        PlatinaState.shared.start(messenger)

        noticeBox.axis = .vertical
        noticeBox.spacing = 8
        add(noticeBox, gap: 10)

        nameField.limit = 50
        nameField.input.autocapitalizationType = .words
        nameField.value = own["displayName"] as? String ?? ""
        nameField.onEdit = { [weak self] in self?.edited() }
        add(nameField, gap: 10)

        bioArea.limit = 160
        bioArea.value = own["bio"] as? String ?? ""
        bioArea.onEdit = { [weak self] in self?.clearNotice() }
        add(bioArea, gap: 10)
        add(SettingsLook.foot("Несколько слов о себе — например, чем занимаешься. Видно в профиле."), gap: 6)

        handleRow.onPress = { [weak self] in
            guard let self, !self.busy else { return }
            self.open(UsernameViewController(messenger: self.messenger))
        }
        addGroup(rows: [handleRow])

        birthdayRow.onPress = { [weak self] in
            guard let self, !self.busy else { return }
            let page = BirthdayViewController(value: self.birthday, done: { [weak self] chosen in
                self?.birthday = chosen
                self?.showValues()
                self?.clearNotice()
            })
            self.open(page)
        }
        genderRow.onPress = { [weak self] in self?.chooseGender() }
        // Profile: «Узор фона» — the emoji around the photo in the profile (saved with «Сохранить»).
        patternRow.onPress = { [weak self] in
            guard let self, !self.busy else { return }
            let picker = PatternPickerViewController(current: self.pattern) { [weak self] (chosen: String?) -> Void in
                self?.pattern = chosen
                self?.showValues()
                self?.clearNotice()
            }
            self.present(picker, animated: true, completion: nil)
        }
        addGroup(rows: [birthdayRow, genderRow, patternRow])

        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .equalSpacing
        row.alignment = .center
        for (index, value) in ProfileEditViewController.colors.enumerated() {
            let dot = UIButton(type: .custom)
            dot.backgroundColor = UIColor(hex: Messenger.color(value))
            dot.layer.cornerRadius = 16
            dot.layer.borderColor = Theme.text.cgColor
            dot.tag = index
            dot.accessibilityLabel = "Цвет \(index + 1)"
            dot.translatesAutoresizingMaskIntoConstraints = false
            dot.widthAnchor.constraint(equalToConstant: 32).isActive = true
            dot.heightAnchor.constraint(equalToConstant: 32).isActive = true
            dot.addTarget(self, action: #selector(colorPicked(_:)), for: .touchUpInside)
            row.addArrangedSubview(dot)
            swatches.append(dot)
        }
        addGroup("Персональный цвет", rows: [SettingsLook.inset(row, top: 12, side: 14, bottom: 12)])
        add(SettingsLook.foot("Этим цветом тебя видят в чатах у других, пока нет фото."), gap: 7)

        saveButton.onPress = { [weak self] in self?.save() }
        add(saveButton, gap: 20)
        // Profile: «Рамки и анимации» — the decorations of Platina, saved at once (Sources/Platina/PlatinaStudio.swift).
        add(SettingsLook.caption("Рамки и анимации"), gap: 24)
        let studio = PlatinaStudioView(messenger: messenger, compact: true)
        add(SettingsLook.inset(ProfileEditMedia.card(studio), top: 0, side: 0, bottom: 0), gap: 7)
        showValues()
    }

    @objc private func avatarPressed() { media.ask(kind: "avatar") } // Profile

    @objc private func profileChanged() {
        // The @username was changed on its own page: the row follows.
        showValues()
    }

    private func edited() {
        clearNotice()
        showBall()
    }

    private func showBall() {
        var shown = messenger.ownProfile
        let typed = nameField.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { shown["displayName"] = typed }
        shown["avatarColor"] = color
        // Profile: the decorated avatar and the banner as they are now.
        if var person = Person(shown) {
            person.look = PersonLook(shown)
            ball.show(person, look: person.look, base: messenger.server.endpoint, animated: true)
            bannerArt.show(person.look, base: messenger.server.endpoint, preview: true)
        }
    }

    private func showValues() {
        let own = messenger.ownProfile
        let handle = own["username"] as? String ?? ""
        handleRow.setValue(handle.isEmpty ? "" : "@" + handle)
        let day = BirthdayWords.format(birthday)
        birthdayRow.setValue(day.isEmpty ? "Не указан" : day)
        genderRow.setValue(gender == "male" ? "Мужской" : gender == "female" ? "Женский" : "Не указан")
        patternRow.setValue(pattern ?? "Нет") // Profile
        for (index, dot) in swatches.enumerated() {
            let on = ProfileEditViewController.colors[index].uppercased() == color.uppercased()
            dot.layer.borderWidth = on ? 3 : 0
            if on { dot.accessibilityTraits.insert(.selected) } else { dot.accessibilityTraits.remove(.selected) }
        }
        showBall()
    }

    @objc private func colorPicked(_ sender: UIButton) {
        guard !busy, sender.tag >= 0, sender.tag < ProfileEditViewController.colors.count else { return }
        color = ProfileEditViewController.colors[sender.tag]
        clearNotice()
        showValues()
    }

    private func chooseGender() {
        guard !busy else { return }
        // The reference's Sheet «Пол»: SheetActions with «checkmark-circle» on the chosen one, «ellipse-outline» on the others.
        let options: [(String?, String)] = [("male", "Мужской"), ("female", "Женский"), (nil, "Не указан")]
        let choices = options.map { (option: (String?, String)) -> ChoiceSheet.Choice in
            ChoiceSheet.Choice(symbol: gender == option.0 ? "ion:checkmark-circle" : "ion:ellipse-outline", label: option.1, selected: gender == option.0, run: { [weak self] in
                self?.setGender(option.0)
            })
        }
        let sheet = ChoiceSheet(heading: "Пол", note: "Нужен только для оформления в день рождения: синее или розовое. Можно не указывать.", choices: choices)
        present(sheet, animated: true)
    }

    private func setGender(_ value: String?) {
        gender = value
        clearNotice()
        showValues()
    }

    private func clearNotice() {
        for part in noticeBox.arrangedSubviews {
            noticeBox.removeArrangedSubview(part)
            part.removeFromSuperview()
        }
    }

    private func showNotice(_ words: String, error: Bool) {
        clearNotice()
        noticeBox.addArrangedSubview(SettingsNotice(words, error: error))
        scroll.setContentOffset(.zero, animated: true)
    }

    private func setBusy(_ value: Bool) {
        busy = value
        saveButton.setBusy(value)
        nameField.setEnabled(!value)
        bioArea.setEnabled(!value)
    }

    private func save() {
        guard !busy else { return }
        let name = nameField.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            showNotice("Имя не может быть пустым.", error: true)
            return
        }
        var fields: [String: Any] = [:]
        fields["displayName"] = name
        fields["bio"] = bioArea.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let birthday { fields["birthday"] = birthday } else { fields["birthday"] = NSNull() }
        if let gender { fields["gender"] = gender } else { fields["gender"] = NSNull() }
        fields["avatarColor"] = color
        if let pattern { fields["profilePattern"] = pattern } else { fields["profilePattern"] = NSNull() } // Profile
        view.endEditing(true)
        setBusy(true)
        messenger.accountCall("profile", [fields]) { [weak self] result in
            guard let self else { return }
            self.setBusy(false)
            switch result {
            case .success(let body):
                if let fresh = body["user"] as? [String: Any] {
                    self.messenger.keepOwnProfile(fresh)
                    self.birthday = fresh["birthday"] as? String
                    self.gender = fresh["gender"] as? String
                    self.color = fresh["avatarColor"] as? String ?? self.color
                    self.pattern = fresh["profilePattern"] as? String // Profile
                    self.showValues()
                }
                self.showNotice("Профиль сохранён.", error: false)
            case .failure(let error):
                self.showNotice(error.words.isEmpty ? "Не удалось сохранить профиль." : error.words, error: true)
            }
        }
    }
}

/// A birthday as it is kept («MM-DD» or «YYYY-MM-DD») and as it is shown («2 мар», «2 мар 1999»).
/// The rules of `mobile/src/birthday.ts`.
enum BirthdayWords {
    static let monthsShort = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
    static let months = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]

    struct Day {
        var day: Int
        var month: Int
        var year: Int?
    }

    private static func number(_ text: Substring, digits: Int) -> Int? {
        guard text.unicodeScalars.count == digits else { return nil }
        for scalar in text.unicodeScalars {
            if scalar.value < 0x30 || scalar.value > 0x39 { return nil }
        }
        return Int(text)
    }

    static func parse(_ value: String?) -> Day? {
        guard let value else { return nil }
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        if parts.count == 2, let month = number(parts[0], digits: 2), let day = number(parts[1], digits: 2) {
            return Day(day: day, month: month, year: nil)
        }
        if parts.count == 3, let year = number(parts[0], digits: 4), let month = number(parts[1], digits: 2), let day = number(parts[2], digits: 2) {
            return Day(day: day, month: month, year: year)
        }
        return nil
    }

    static func format(_ value: String?) -> String {
        guard let made = parse(value), made.month >= 1, made.month <= 12 else { return "" }
        let tail = made.year.map { " \($0)" } ?? ""
        return "\(made.day) \(monthsShort[made.month - 1])" + tail
    }

    /// Without a year February has 29 days (2000 is a leap year).
    static func daysInMonth(_ month: Int, year: Int?) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? calendar.timeZone
        var parts = DateComponents()
        parts.year = year ?? 2000
        parts.month = month
        parts.day = 1
        guard let first = calendar.date(from: parts), let range = calendar.range(of: .day, in: .month, for: first) else { return 31 }
        return range.count
    }

    static func value(_ made: Day) -> String {
        let tail = String(format: "%02d-%02d", made.month, made.day)
        if let year = made.year { return "\(year)-" + tail }
        return tail
    }
}

/// «День рождения»: the day and the month, the year if the person wants («2 мар» or «2 мар 1999»).
final class BirthdayViewController: SettingsPage, UIPickerViewDataSource, UIPickerViewDelegate {
    private let initial: String?
    private let done: (String?) -> Void
    private var month = 1
    private var day = 1
    private let picker = UIPickerView()
    private let yearField = SettingsField(caption: "Год (необязательно)", placeholder: "Например, 1999")
    private let yearError = SettingsLook.words("", size: 12, color: Theme.danger)
    private let preview = SettingsLook.words("", size: 13, color: Theme.muted)
    private let doneButton = SettingsButton(label: "Готово")
    private let thisYear = Calendar(identifier: .gregorian).component(.year, from: Date())

    init(value: String?, done: @escaping (String?) -> Void) {
        initial = value
        self.done = done
        if let made = BirthdayWords.parse(value), made.month >= 1, made.month <= 12 {
            month = made.month
            day = max(1, min(31, made.day))
        }
        super.init(name: "День рождения")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        picker.dataSource = self
        picker.delegate = self
        picker.translatesAutoresizingMaskIntoConstraints = false
        picker.heightAnchor.constraint(equalToConstant: 180).isActive = true
        addGroup(rows: [picker])

        yearField.limit = 4
        yearField.allowed = CharacterSet(charactersIn: "0123456789")
        yearField.input.keyboardType = .numberPad
        if let year = BirthdayWords.parse(initial)?.year { yearField.value = String(year) }
        yearField.onEdit = { [weak self] in self?.show() }
        add(yearField, gap: 16)
        add(SettingsLook.inset(yearError, top: 0, side: 2, bottom: 0), gap: 6)
        add(SettingsLook.inset(preview, top: 0, side: 2, bottom: 0), gap: 10)

        doneButton.onPress = { [weak self] in self?.finish() }
        add(doneButton, gap: 18)
        if initial != nil {
            let remove = SettingsButton(label: "Убрать день рождения", kind: .danger)
            remove.onPress = { [weak self] in
                guard let self else { return }
                self.done(nil)
                self.navigationController?.popViewController(animated: true)
            }
            add(remove, gap: 10)
        }
        picker.selectRow(month - 1, inComponent: 1, animated: false)
        picker.selectRow(min(day, BirthdayWords.daysInMonth(month, year: year)) - 1, inComponent: 0, animated: false)
        show()
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
        picker.reloadComponent(0)
        let made = chosen
        if picker.selectedRow(inComponent: 0) != made.day - 1 { picker.selectRow(made.day - 1, inComponent: 0, animated: false) }
        let problem = yearProblem
        yearError.text = problem
        yearError.isHidden = problem.isEmpty
        preview.text = "Видят только друзья: " + BirthdayWords.format(BirthdayWords.value(made))
        doneButton.isEnabled = problem.isEmpty
    }

    private func finish() {
        guard yearProblem.isEmpty else { return }
        done(BirthdayWords.value(chosen))
        navigationController?.popViewController(animated: true)
    }

    func numberOfComponents(in pickerView: UIPickerView) -> Int {
        return 2
    }

    func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
        return component == 0 ? BirthdayWords.daysInMonth(month, year: year) : 12
    }

    func pickerView(_ pickerView: UIPickerView, attributedTitleForRow row: Int, forComponent component: Int) -> NSAttributedString? {
        let words = component == 0 ? String(row + 1) : BirthdayWords.months[min(max(row, 0), 11)]
        return NSAttributedString(string: words, attributes: [.foregroundColor: Theme.text])
    }

    func pickerView(_ pickerView: UIPickerView, didSelectRow row: Int, inComponent component: Int) {
        if component == 0 { day = row + 1 } else { month = row + 1 }
        show()
    }
}

/// «Имя пользователя»: the public @username. It is not the login: changing it changes nothing about signing in.
final class UsernameViewController: SettingsPage {
    private let messenger: Messenger
    private var status: [String: Any]?
    private var loading = true
    private var statusError = ""
    private var failure = ""
    private var notice = ""
    private var busy = false
    private var request = 0
    private let field = SettingsField(caption: "Публичное имя пользователя", placeholder: "@username")
    private let change = SettingsButton(label: "Изменить публичное имя", kind: .secondary, icon: "at-outline")

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Имя пользователя")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        field.limit = 25
        field.value = messenger.ownProfile["username"] as? String ?? ""
        field.onEdit = { [weak self] in self?.showButton() }
        field.onReturn = { [weak self] in self?.review() }
        change.onPress = { [weak self] in self?.review() }
        fill()
        loadStatus(resetDraft: true)
    }

    private var ready: Bool { return status != nil && !loading && statusError.isEmpty }
    private var canChange: Bool { return status?["canChangeUsername"] as? Bool ?? false }
    private var platina: Bool { return (status?["platina"] as? [String: Any])?["active"] as? Bool ?? false }
    private var currentName: String { return status?["username"] as? String ?? "" }

    private func fill() {
        clear()
        if !statusError.isEmpty { add(SettingsNotice(statusError, error: true, onRetry: { [weak self] in self?.loadStatus(resetDraft: false) })) }
        if !failure.isEmpty { add(SettingsNotice(failure, error: true)) }
        if !notice.isEmpty { add(SettingsNotice(notice)) }
        add(field, gap: 12)
        if loading && status == nil {
            add(SettingsLook.foot("Загрузка…"), gap: 8)
        } else if status != nil {
            var words = ""
            if canChange {
                words = platina ? "С Platina публичное имя можно менять раз в день." : "Публичное имя можно менять раз в неделю, с Platina — раз в день."
            } else {
                words = platina ? "С Platina имя можно менять раз в день." : "Имя можно менять раз в неделю, с Platina — раз в день."
                let later = SettingsLook.longMomentWords(status?["nextUsernameChangeAt"] as? String)
                if !later.isEmpty { words += " Следующая смена — \(later)." }
            }
            add(SettingsLook.foot(words), gap: 8)
        }
        add(change, gap: 16)
        field.setEnabled(!busy && ready && canChange)
        showButton()
    }

    private func showButton() {
        change.isEnabled = !busy && ready && canChange && AuthRules.handle(field.value) != currentName
    }

    private func loadStatus(resetDraft: Bool) {
        request += 1
        let mine = request
        loading = true
        statusError = ""
        fill()
        messenger.accountCall("usernameStatus", []) { [weak self] result in
            guard let self, mine == self.request else { return }
            self.loading = false
            switch result {
            case .success(let body):
                if body["accountId"] as? String != self.messenger.userId {
                    self.statusError = "Сервер вернул настройки другого аккаунта."
                } else {
                    self.status = body
                    if resetDraft { self.field.value = body["username"] as? String ?? self.field.value }
                }
            case .failure(let error):
                self.statusError = error.words.isEmpty ? "Не удалось получить настройки имени и статуса." : error.words
            }
            self.fill()
        }
    }

    private func review() {
        let wanted = AuthRules.handle(field.value)
        failure = ""
        notice = ""
        guard AuthRules.validName(wanted) else {
            failure = "Имя пользователя: от 3 до 24 символов a–z, 0–9 и подчёркивание."
            fill()
            return
        }
        fill()
        guard !busy, ready, canChange, wanted != currentName else { return }
        let previous = currentName
        let login = status?["loginName"] as? String ?? ""
        let later = platina ? "Следующая смена будет доступна через день." : "Следующая смена будет доступна через неделю, с Platina — через день."
        let words = "@\(previous) → @\(wanted)\n\nЛогин для входа «\(login)», ID аккаунта и ключи переписки останутся прежними. Старое публичное имя перестанет вести на твой профиль.\n\n\(later)"
        view.endEditing(true)
        confirm(heading: "Изменить публичное имя?", words: words, action: "Подтвердить смену имени", destructive: false) { [weak self] in
            self?.apply(previous: previous, wanted: wanted)
        }
    }

    private func apply(previous: String, wanted: String) {
        guard !busy, ready, canChange else { return }
        if previous != currentName {
            failure = "Имя уже изменилось. Проверь новый вариант ещё раз."
            fill()
            return
        }
        busy = true
        request += 1
        change.setBusy(true)
        field.setEnabled(false)
        messenger.accountCall("changeUsername", [wanted]) { [weak self] result in
            guard let self else { return }
            self.busy = false
            self.change.setBusy(false)
            switch result {
            case .success(let body):
                let fresh = body["user"] as? [String: Any] ?? [:]
                let state = body["status"] as? [String: Any] ?? [:]
                if fresh["id"] as? String != self.messenger.userId || state["accountId"] as? String != self.messenger.userId {
                    self.failure = "Сервер вернул настройки другого аккаунта."
                    self.fill()
                    self.loadStatus(resetDraft: false)
                    return
                }
                self.status = state
                self.field.value = state["username"] as? String ?? wanted
                self.messenger.keepOwnProfile(fresh)
                self.notice = "Публичное имя изменено. Логин для входа остался прежним."
                self.fill()
            case .failure(let error):
                self.failure = error.words.isEmpty ? "Не удалось изменить имя пользователя." : error.words
                self.fill()
                self.loadStatus(resetDraft: false)
            }
        }
    }
}
