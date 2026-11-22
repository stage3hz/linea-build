import UIKit

/// A person in one line: the round picture, the name, the @login, a button on the right.
final class PersonListRow: UIView {
    var onPress: (() -> Void)?
    private let button = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)

    init(person: [String: Any], base: String, adding: Bool) {
        super.init(frame: .zero)
        let ball = SettingsAvatar(frame: CGRect(x: 0, y: 0, width: 36, height: 36))
        ball.show(person, base: base)
        ball.translatesAutoresizingMaskIntoConstraints = false
        let name = UILabel()
        name.text = person["displayName"] as? String ?? ""
        name.font = .systemFont(ofSize: 15)
        name.textColor = Theme.text
        let handle = UILabel()
        let login = person["username"] as? String ?? ""
        handle.text = login.isEmpty ? "" : "@" + login
        handle.font = .systemFont(ofSize: 12.5)
        handle.textColor = Theme.muted
        handle.isHidden = login.isEmpty
        let texts = UIStackView(arrangedSubviews: [name, handle])
        texts.axis = .vertical
        texts.spacing = 1
        button.setImage(SettingsLook.symbol(adding ? "ion:add-circle" : "ion:close-circle", size: 22), for: .normal)
        button.tintColor = adding ? Theme.accent : Theme.muted
        button.accessibilityLabel = (adding ? "Добавить в список" : "Убрать из списка") + ": " + (name.text ?? "")
        button.addTarget(self, action: #selector(pressed), for: .touchUpInside)
        button.setContentHuggingPriority(.required, for: .horizontal)
        spinner.color = Theme.accent
        spinner.hidesWhenStopped = true
        let content = UIStackView(arrangedSubviews: [ball, texts, button, spinner])
        content.axis = .horizontal
        content.alignment = .center
        content.spacing = 12
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            ball.widthAnchor.constraint(equalToConstant: 36),
            ball.heightAnchor.constraint(equalToConstant: 36),
            content.topAnchor.constraint(equalTo: topAnchor, constant: 9),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    func setBusy(_ busy: Bool) {
        button.isHidden = busy
        if busy { spinner.startAnimating() } else { spinner.stopAnimating() }
    }

    @objc private func pressed() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onPress?()
    }
}

/// «Всегда показывать» / «Никогда не показывать» of «Время захода»: who is in the list, and friends or anyone found
/// by @login to add. (The previous app: `LastSeenExceptions` of `mobile/src/SettingsScreen.tsx`.)
final class LastSeenExceptionsViewController: SettingsPage, UITextFieldDelegate {
    private let messenger: Messenger
    private let model: SettingsPrivacyModel
    private let rule: String
    private var listed: [[String: Any]]?
    private var friends: [[String: Any]] = []
    private var found: [[String: Any]] = []
    private var query = ""
    private var busy = ""
    private var failure = ""
    private var searchTimer: Timer?
    private let field = UITextField()

    init(messenger: Messenger, model: SettingsPrivacyModel, rule: String) {
        self.messenger = messenger
        self.model = model
        self.rule = rule
        super.init(name: rule == "allow" ? "Всегда показывать" : "Никогда не показывать")
    }

    required init?(coder: NSCoder) { return nil }

    deinit { searchTimer?.invalidate() }

    override func build() {
        field.placeholder = "Имя или @логин"
        field.font = .systemFont(ofSize: 15)
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .search
        field.clearButtonMode = .whileEditing
        field.accessibilityLabel = "Поиск людей"
        field.delegate = self
        field.addTarget(self, action: #selector(typed), for: .editingChanged)
        loadRules()
        messenger.accountCall("contacts", []) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self, case .success(let body) = result else { return }
            self.friends = body["users"] as? [[String: Any]] ?? []
            self.fill()
        }
        fill()
    }

    private func loadRules() {
        messenger.accountCall("lastSeenRules", []) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            switch result {
            case .success(let body):
                self.listed = body[self.rule] as? [[String: Any]] ?? []
                self.failure = ""
            case .failure(let error):
                self.failure = error.words.isEmpty ? "Не удалось загрузить списки." : error.words
            }
            self.fill()
        }
    }

    private var needle: String {
        var text = query.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("@") { text.removeFirst() }
        return text.lowercased()
    }

    @objc private func typed() {
        query = field.text ?? ""
        found = []
        searchTimer?.invalidate()
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        // The app's rules for the global search: an exact @login, or four letters and more.
        if needle.count >= 2 && (trimmed.hasPrefix("@") || needle.count >= 4) {
            searchTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { [weak self] (_: Timer) -> Void in
                guard let self else { return }
                self.messenger.accountCall("users", [trimmed]) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
                    guard let self, case .success(let body) = result else { return }
                    self.found = body["users"] as? [[String: Any]] ?? []
                    self.fillLists()
                }
            }
        }
        fillLists()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    private var listsHolder = UIStackView()

    private func fill() {
        clear()
        listsHolder = UIStackView()
        listsHolder.axis = .vertical
        listsHolder.spacing = 8
        add(listsHolder, gap: 0)
        fillLists()
    }

    private func fillLists() {
        for old in listsHolder.arrangedSubviews {
            listsHolder.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        let base = messenger.server.endpoint
        if !failure.isEmpty {
            listsHolder.addArrangedSubview(SettingsNotice(failure, error: true, onRetry: { [weak self] in self?.loadRules() }))
        }
        var inList = Set<String>()
        var rows: [UIView] = []
        if let listed {
            for person in listed {
                guard let id = person["id"] as? String else { continue }
                inList.insert(id)
                let row = PersonListRow(person: person, base: base, adding: false)
                row.setBusy(busy == id)
                row.onPress = { [weak self] in self?.toggle(id, add: false) }
                rows.append(row)
            }
            if rows.isEmpty { rows.append(SettingsLook.inset(SettingsLook.words("Список пуст. Выбери людей ниже.", size: 13, color: Theme.muted), top: 16, side: 16, bottom: 16)) }
        } else {
            rows.append(SettingsLook.inset(SettingsLook.words("Загрузка…", size: 13, color: Theme.muted), top: 16, side: 16, bottom: 16))
        }
        listsHolder.addArrangedSubview(SettingsLook.caption(rule == "allow" ? "Всегда показывать" : "Никогда не показывать"))
        listsHolder.addArrangedSubview(SettingsGroup(rows: rows))
        listsHolder.addArrangedSubview(SettingsLook.foot(rule == "allow" ? "Эти люди всегда будут видеть время вашего захода, независимо от настроек выше." : "Эти люди никогда не будут видеть время вашего захода, независимо от настроек выше."))

        let own = messenger.userId
        var seen = Set<String>()
        var candidates: [[String: Any]] = []
        for person in friends + found {
            guard let id = person["id"] as? String, id != own, !seen.contains(id), !inList.contains(id) else { continue }
            seen.insert(id)
            let name = (person["displayName"] as? String ?? "").lowercased()
            let login = (person["username"] as? String ?? "").lowercased()
            if !needle.isEmpty && !name.contains(needle) && !login.contains(needle) { continue }
            candidates.append(person)
            if candidates.count >= 50 { break }
        }
        let icon = UIImageView(image: SettingsLook.symbol("ion:search", size: 18))
        icon.tintColor = Theme.muted
        icon.setContentHuggingPriority(.required, for: .horizontal)
        let search = UIStackView(arrangedSubviews: [icon, field])
        search.axis = .horizontal
        search.alignment = .center
        search.spacing = 10
        var addRows: [UIView] = [SettingsLook.inset(search, top: 13, side: 14, bottom: 13)]
        for person in candidates {
            guard let id = person["id"] as? String else { continue }
            let row = PersonListRow(person: person, base: base, adding: true)
            row.setBusy(busy == id)
            row.onPress = { [weak self] in self?.toggle(id, add: true) }
            addRows.append(row)
        }
        if candidates.isEmpty {
            addRows.append(SettingsLook.inset(SettingsLook.words(needle.isEmpty ? "Здесь появятся друзья и люди из твоих чатов." : "Никого не нашли. Введи точный @логин.", size: 13, color: Theme.muted), top: 0, side: 16, bottom: 14))
        }
        listsHolder.addArrangedSubview(SettingsLook.caption("Добавить пользователей"))
        listsHolder.addArrangedSubview(SettingsGroup(rows: addRows))
    }

    private func toggle(_ id: String, add: Bool) {
        guard busy.isEmpty else { return }
        busy = id
        fillLists()
        let call = add ? "setLastSeenRule" : "removeLastSeenRule"
        let args: [Any] = add ? [id, rule] : [id]
        messenger.accountCall(call, args) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            self.busy = ""
            switch result {
            case .success(let body):
                if let fresh = body[self.rule] as? [[String: Any]] { self.listed = fresh } else { self.loadRules() }
                if add {
                    self.field.text = ""
                    self.query = ""
                    self.found = []
                }
                self.failure = ""
                // «Время захода» shows how many are in the lists.
                self.model.load()
            case .failure(let error):
                self.failure = error.words.isEmpty ? "Не удалось сохранить." : error.words
            }
            self.fillLists()
        }
    }
}

/// The two lists of «Кто может звонить»: «Разрешить» (not with «Все») and «Никогда», added to by @login.
/// (The previous app: `RuleList` of `mobile/src/privacy/CallPrivacy.tsx`.) A page of its own here, opened from
/// the «Звонки» group of «Конфиденциальность».
final class CallRulesViewController: SettingsPage, UITextFieldDelegate {
    private let messenger: Messenger
    private var rules: [String: Any]?
    private var failure = ""
    private var mode = "everyone"
    private var fields: [String: UITextField] = [:]
    private var errors: [String: String] = [:]
    private var busy = false

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Звонки")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        load()
        messenger.accountCall("privacy", []) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self, case .success(let body) = result else { return }
            self.mode = (body["privacy"] as? [String: Any])?["calls"] as? String ?? "everyone"
            self.fill()
        }
        fill()
    }

    private func load() {
        failure = ""
        messenger.accountCall("callRules", []) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            switch result {
            case .success(let body): self.rules = body
            case .failure(let error): self.failure = error.words.isEmpty ? "Не удалось загрузить списки." : error.words
            }
            self.fill()
        }
    }

    private func fill() {
        clear()
        if !failure.isEmpty { add(SettingsNotice(failure, error: true, onRetry: { [weak self] in self?.load() })) }
        guard let rules else {
            if failure.isEmpty { add(SettingsLook.foot("Загрузка…"), gap: 16) }
            return
        }
        if mode != "everyone" { list("Разрешить", rule: "allow", users: rules["allow"] as? [[String: Any]] ?? []) }
        list("Никогда", rule: "deny", users: rules["deny"] as? [[String: Any]] ?? [])
        add(SettingsLook.foot("Проверяет сервер; телефон получателя дополнительно не звонит, если звонящему нельзя."), gap: 10)
    }

    private func list(_ title: String, rule: String, users: [[String: Any]]) {
        let field = fields[rule] ?? UITextField()
        fields[rule] = field
        field.placeholder = "логин"
        field.font = .systemFont(ofSize: 15)
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .done
        field.accessibilityLabel = "Добавить в список «" + title + "» по логину"
        field.delegate = self
        let at = SettingsLook.words("@", size: 15, color: Theme.muted)
        at.setContentHuggingPriority(.required, for: .horizontal)
        let plus = UIButton(type: .system)
        plus.setImage(SettingsLook.symbol("ion:add", size: 20), for: .normal)
        plus.tintColor = Theme.accent
        plus.backgroundColor = ThemeStore.look.accentSoft
        plus.layer.cornerRadius = 11
        plus.accessibilityLabel = "Добавить в «" + title + "»"
        plus.isEnabled = !busy
        plus.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.addLogin(rule) }, for: .touchUpInside)
        plus.translatesAutoresizingMaskIntoConstraints = false
        plus.widthAnchor.constraint(equalToConstant: 36).isActive = true
        plus.heightAnchor.constraint(equalToConstant: 36).isActive = true
        let line = UIStackView(arrangedSubviews: [at, field, plus])
        line.axis = .horizontal
        line.alignment = .center
        line.spacing = 8
        var rows: [UIView] = [SettingsLook.inset(line, top: 4, side: 12, bottom: 4)]
        if let problem = errors[rule], !problem.isEmpty {
            rows.append(SettingsLook.inset(SettingsLook.words(problem, size: 12, color: Theme.danger), top: 6, side: 14, bottom: 8))
        }
        for user in users {
            guard let id = user["id"] as? String else { continue }
            let row = PersonListRow(person: user, base: messenger.server.endpoint, adding: false)
            row.onPress = { [weak self] in self?.remove(id, rule: rule) }
            rows.append(row)
        }
        addGroup(title + (users.isEmpty ? "" : " · \(users.count)"), rows: rows)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        for (rule, field) in fields where field === textField { addLogin(rule) }
        return true
    }

    private func addLogin(_ rule: String) {
        var login = (fields[rule]?.text ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if login.hasPrefix("@") { login.removeFirst() }
        guard login.count >= 2, !busy else { return }
        busy = true
        errors[rule] = ""
        messenger.accountCall("users", ["@" + login]) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            let users = (try? result.get())?["users"] as? [[String: Any]] ?? []
            guard let person = users.first(where: { (user: [String: Any]) -> Bool in (user["username"] as? String ?? "").lowercased() == login }), let id = person["id"] as? String else {
                self.busy = false
                if case .failure(let error) = result { self.errors[rule] = error.words } else { self.errors[rule] = "Пользователь @" + login + " не найден." }
                self.fill()
                return
            }
            self.messenger.accountCall("setCallRule", [id, rule]) { [weak self] (answer: Result<[String: Any], ServerError>) -> Void in
                guard let self else { return }
                self.busy = false
                switch answer {
                case .success(let body):
                    self.rules = body
                    self.fields[rule]?.text = ""
                case .failure(let error):
                    self.errors[rule] = error.words.isEmpty ? "Не удалось добавить." : error.words
                }
                self.fill()
            }
        }
    }

    private func remove(_ id: String, rule: String) {
        messenger.accountCall("removeCallRule", [id]) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            switch result {
            case .success(let body): self.rules = body
            case .failure(let error): self.errors[rule] = error.words.isEmpty ? "Не удалось убрать." : error.words
            }
            self.fill()
        }
    }
}
