import UIKit

/// «Изменить»: the editor of one's own profile — the banner and the photo, a few words about oneself, the name, the
/// public @username, the birthday, the gender, the colour, the background pattern, the decorations of Platina.
/// (The previous app: the editing state of `mobile/src/ProfileScreen.tsx`.) The header's «close» discards the draft,
/// its «checkmark» saves and closes; nothing is sent before that.
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
    private let patternRow = SettingsRow(symbol: "ion:sparkles", label: "Узор фона", valueSize: 14)
    private lazy var media = ProfilePhotoChange(messenger: messenger, host: self)
    private let noticeBox = UIStackView()
    private let nameField = SettingsField(caption: "", placeholder: "Имя")
    private let bioArea = SettingsTextArea(placeholder: "О себе", glass: true)
    // ProfileScreen.tsx EditRow: the value is 14 (13 in a row of the settings).
    private let handleRow = SettingsRow(symbol: "ion:at", label: "Имя пользователя", valueSize: 14)
    private let birthdayRow = SettingsRow(symbol: "ion:gift", label: "День рождения", valueSize: 14)
    private let genderRow = SettingsRow(symbol: "ion:person", label: "Пол", valueSize: 14)
    private let colorRow = SettingsRow(symbol: "ion:color-palette", label: "Персональный цвет", swatch: UIColor.clear)
    private var saveButton: GlassRoundButton?

    /// The colour of a profile that has none yet.
    private static let plainColor = "#5E7BFF"

    init(messenger: Messenger) {
        self.messenger = messenger
        let own = messenger.ownProfile
        birthday = own["birthday"] as? String
        gender = own["gender"] as? String
        color = own["avatarColor"] as? String ?? ProfileEditViewController.plainColor
        pattern = own["profilePattern"] as? String // Profile
        super.init(name: "Изменить")
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override var ownLook: OwnLook? {
        // ProfileScreen.tsx, editing: the pill 14 from the sides, 10 inside, at least 68 tall; «Изменить» 20 Bold with
        // letter spacing −0.5 in the middle, «close» at the left and the accent «checkmark» at the right. The column is
        // 17 from the sides, 8 under the pill's 2 of margin (4 of them are the top part's own), 36 at the end.
        return OwnLook(side: 14, padding: 10, minHeight: 68, clear: false, titleFont: .systemFont(ofSize: 20, weight: .bold), titleKern: -0.5,
                       mark: "", markSize: 0, markRoom: 0, backLabel: "Отменить изменения",
                       columnSide: 17, columnTop: 4, columnBottom: 36, closes: true)
    }

    /// «Отменить изменения»: the draft is dropped. Not while it is being saved.
    override func goBack() {
        guard !busy else { return }
        super.goBack()
    }

    override func build() {
        let own = messenger.ownProfile
        NotificationCenter.default.addObserver(self, selector: #selector(profileChanged), name: Messenger.ownProfileChanged, object: nil)
        saveButton = setConfirm(label: "Сохранить") { [weak self] () -> Void in self?.finishEdit() }

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

        // The parts stand 17 apart (the top part keeps 4 of its own under its last line). The place of a notice takes
        // no room while there is none.
        noticeBox.axis = .vertical
        noticeBox.spacing = 8
        noticeBox.isHidden = true
        add(noticeBox, gap: 13)

        // «О себе» first, with its words 6 under it (12 on lines of 17, 14 in from the sides).
        bioArea.limit = 160
        bioArea.value = own["bio"] as? String ?? ""
        bioArea.onEdit = { [weak self] in self?.clearNotice() }
        add(bioArea, gap: 17)
        add(SettingsLook.inset(SettingsLook.para("Несколько слов о себе — например, чем занимаешься. Видно в профиле.", size: 12, color: Theme.muted, line: 17),
                               top: 0, side: 14, bottom: 0), gap: 6)

        // The name, and the @username's row 6 under it.
        nameField.limit = 50
        nameField.input.autocapitalizationType = .words
        nameField.value = own["displayName"] as? String ?? ""
        nameField.onEdit = { [weak self] in self?.edited() }
        add(nameField, gap: 17)

        handleRow.onPress = { [weak self] in
            guard let self, !self.busy else { return }
            // ProfileScreen.tsx: the @username is a sheet over the editor, not a page of its own.
            self.view.endEditing(true)
            self.present(UsernameSheet.make(messenger: self.messenger), animated: true)
        }
        add(SettingsGroup(rows: [handleRow], glass: 22), gap: 6)

        // «День рождения» and «Персональный цвет» are sheets over the editor (ProfileEditSheets.swift).
        birthdayRow.onPress = { [weak self] in
            guard let self, !self.busy else { return }
            let sheet = ProfileEditSheets.birthday(value: self.birthday) { [weak self] (chosen: String?) -> Void in
                self?.birthday = chosen
                self?.showValues()
                self?.clearNotice()
            }
            self.present(sheet, animated: true)
        }
        genderRow.onPress = { [weak self] in self?.chooseGender() }
        colorRow.onPress = { [weak self] in
            guard let self, !self.busy else { return }
            let sheet = ProfileEditSheets.color(current: self.color) { [weak self] (chosen: String) -> Void in
                self?.color = chosen
                self?.showValues()
                self?.clearNotice()
            }
            self.present(sheet, animated: true)
        }
        // Profile: «Узор фона» — the emoji around the photo in the profile (saved with the rest).
        patternRow.onPress = { [weak self] in
            guard let self, !self.busy else { return }
            let sheet = ProfileEditSheets.pattern(current: self.pattern) { [weak self] (chosen: String?) -> Void in
                self?.pattern = chosen
                self?.showValues()
                self?.clearNotice()
            }
            self.present(sheet, animated: true)
        }
        add(SettingsGroup(rows: [birthdayRow, genderRow, colorRow, patternRow], glass: 22), gap: 17)

        // Profile: «Рамки и анимации» — the decorations of Platina, saved at once (Sources/Platina/PlatinaStudio.swift).
        add(SettingsLook.sectionLabel("Рамки и анимации"), gap: 17)
        let studio = PlatinaStudioView(messenger: messenger, compact: true)
        add(SettingsLook.inset(ProfileEditMedia.card(studio), top: 0, side: 0, bottom: 0), gap: 8)
        showValues()
    }

    @objc private func avatarPressed() { media.ask(kind: "avatar") } // Profile

    @objc private func profileChanged() {
        // The @username was changed in its sheet: the row follows.
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
        colorRow.setSwatch(UIColor(hex: Messenger.color(color)))
        patternRow.setValue(pattern ?? "Нет") // Profile
        showBall()
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
        noticeBox.isHidden = true
    }

    private func showNotice(_ words: String, error: Bool) {
        clearNotice()
        noticeBox.addArrangedSubview(SettingsNotice(words, error: error))
        noticeBox.isHidden = false
        scroll.setContentOffset(.zero, animated: true)
    }

    private func setBusy(_ value: Bool) {
        busy = value
        saveButton?.isEnabled = !value
        nameField.setEnabled(!value)
        bioArea.setEnabled(!value)
    }

    /// Whether anything of the draft differs from the profile as the server has it.
    private var changed: Bool {
        let own = messenger.ownProfile
        if nameField.value.trimmingCharacters(in: .whitespacesAndNewlines) != (own["displayName"] as? String ?? "") { return true }
        if bioArea.value.trimmingCharacters(in: .whitespacesAndNewlines) != (own["bio"] as? String ?? "") { return true }
        if birthday != (own["birthday"] as? String) { return true }
        if gender != (own["gender"] as? String) { return true }
        if color.uppercased() != (own["avatarColor"] as? String ?? ProfileEditViewController.plainColor).uppercased() { return true }
        return pattern != (own["profilePattern"] as? String)
    }

    /// The header's «Сохранить»: nothing changed — the editor just closes; otherwise it closes once the profile is saved.
    private func finishEdit() {
        guard !busy else { return }
        if !changed {
            navigationController?.popViewController(animated: true)
            return
        }
        save()
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
                // Saved: the editor closes, as the previous app's does.
                self.navigationController?.popViewController(animated: true)
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

/// «Имя пользователя»: the public @username, a sheet over the editor as in the previous app (ProfileScreen.tsx: the
/// Sheet with the field, the words about how often the name can change — 12 on lines of 18 — and «Изменить
/// публичное имя», 14 apart). It is not the login: changing it changes nothing about signing in. What went wrong, or
/// that the name was changed, is said in the words' place. The sheet's own controls keep this object alive.
final class UsernameSheet {
    private let messenger: Messenger
    private var status: [String: Any]?
    private var loading = true
    private var statusError = ""
    private var failure = ""
    private var notice = ""
    private var busy = false
    private var request = 0
    private weak var sheet: ChoiceSheet?
    private weak var field: SettingsField?
    private weak var words: UILabel?
    private weak var change: SettingsButton?

    private init(messenger: Messenger) {
        self.messenger = messenger
    }

    static func make(messenger: Messenger) -> ChoiceSheet {
        let model = UsernameSheet(messenger: messenger)
        let field = SettingsField(caption: "Публичное имя пользователя", placeholder: "@username")
        let words = SettingsLook.para("Загрузка…", size: 12, color: Theme.muted, line: 18)
        let change = SettingsButton(label: "Изменить публичное имя", kind: .secondary, icon: "at-outline")
        let sheet = ChoiceSheet(heading: "Имя пользователя", parts: [field, words, change], gap: 14)
        model.sheet = sheet
        model.field = field
        model.words = words
        model.change = change
        field.limit = 25
        field.input.autocapitalizationType = .none
        field.input.autocorrectionType = .no
        field.value = messenger.ownProfile["username"] as? String ?? ""
        field.onEdit = { () -> Void in model.showButton() }
        field.onReturn = { () -> Void in model.review() }
        change.onPress = { () -> Void in model.review() }
        model.fill()
        model.loadStatus(resetDraft: true)
        return sheet
    }

    private var ready: Bool { return status != nil && !loading && statusError.isEmpty }
    private var canChange: Bool { return status?["canChangeUsername"] as? Bool ?? false }
    private var platina: Bool { return (status?["platina"] as? [String: Any])?["active"] as? Bool ?? false }
    private var currentName: String { return status?["username"] as? String ?? "" }

    private func fill() {
        var text = ""
        var wrong = false
        if !statusError.isEmpty {
            text = statusError
            wrong = true
        } else if !failure.isEmpty {
            text = failure
            wrong = true
        } else if !notice.isEmpty {
            text = notice
        } else if loading && status == nil {
            text = "Загрузка…"
        } else if status != nil {
            if canChange {
                text = platina ? "С Platina публичное имя можно менять раз в день." : "Публичное имя можно менять раз в неделю, с Platina — раз в день."
            } else {
                text = platina ? "С Platina имя можно менять раз в день." : "Имя можно менять раз в неделю, с Platina — раз в день."
                let later = SettingsLook.longMomentWords(status?["nextUsernameChangeAt"] as? String)
                if !later.isEmpty { text += " Следующая смена — \(later)." }
            }
        }
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 18
        style.maximumLineHeight = 18
        words?.attributedText = NSAttributedString(string: text.isEmpty ? " " : text, attributes: [
            .font: UIFont.systemFont(ofSize: 12), .foregroundColor: wrong ? Theme.danger : Theme.muted, .paragraphStyle: style,
        ])
        field?.setEnabled(!busy && ready && canChange)
        showButton()
        sheet?.viewIfLoaded?.setNeedsLayout()
    }

    private func showButton() {
        change?.isEnabled = !busy && ready && canChange && AuthRules.handle(field?.value ?? "") != currentName
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
                    if resetDraft, let name = body["username"] as? String { self.field?.value = name }
                }
            case .failure(let error):
                self.statusError = error.words.isEmpty ? "Не удалось получить настройки имени и статуса." : error.words
            }
            self.fill()
        }
    }

    private func review() {
        let wanted = AuthRules.handle(field?.value ?? "")
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
        sheet?.view.endEditing(true)
        // ProfileScreen.tsx: the Sheet «Изменить публичное имя?» — «@old → @new» (19 SemiBold), the words about the login
        // (14, line 21, `muted`), when the next change comes (13, line 20, `muted`), the main «Подтвердить смену имени»; 18 apart.
        let confirmButton = SettingsButton(label: "Подтвердить смену имени")
        let confirm = ChoiceSheet(heading: "Изменить публичное имя?", parts: [
            SettingsLook.words("@\(previous) → @\(wanted)", size: 19, color: Theme.text, weight: .semibold),
            SettingsLook.para("Логин для входа «\(login)», ID аккаунта и ключи переписки останутся прежними. Старое публичное имя перестанет вести на твой профиль.", size: 14, color: Theme.muted, line: 21),
            SettingsLook.para(later, size: 13, color: Theme.muted, line: 20),
            confirmButton,
        ], gap: 18)
        confirmButton.onPress = { [weak self, weak confirm] in confirm?.dismiss(animated: true) { self?.apply(previous: previous, wanted: wanted) } }
        sheet?.present(confirm, animated: true)
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
        change?.setBusy(true)
        field?.setEnabled(false)
        messenger.accountCall("changeUsername", [wanted]) { [weak self] result in
            guard let self else { return }
            self.busy = false
            self.change?.setBusy(false)
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
                self.field?.value = state["username"] as? String ?? wanted
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
