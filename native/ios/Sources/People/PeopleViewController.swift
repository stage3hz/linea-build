import UIKit

/// The «Люди» section: friends, requests to be friends, and the search of people by @username or name.
/// Ported from the reference's PeopleScreen.tsx (its «Звонки» half waits for calls).
final class PeopleViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextFieldDelegate {
    private enum Item {
        case label(String)
        case notice(String)
        case request(Person, incoming: Bool)
        case person(Person)
        case empty(heading: String, words: String)
    }

    /// The account whose people are shown; nil shows the simulator's samples (or nothing on a phone).
    private let messenger: Messenger?
    private let heading = UILabel()
    private let caption = UILabel()
    private let searchBox = UIView()
    private let searchIcon = UIImageView()
    private let field = UITextField()
    private let clearButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let table = UITableView(frame: .zero, style: .plain)

    private var items: [Item] = []
    private var friends: [Person] = []
    private var found: [Person] = []
    private var demoIncoming: [Person] = []
    private var demoOutgoing: [Person] = []
    private var searching = false
    private var problem = ""
    private var sequence = 0
    /// The person whose request is being answered, and the one a chat is being opened with.
    private var acting: String?
    private var creating: String?
    private var keyboardHeight: CGFloat = 0
    #if targetEnvironment(simulator)
    private var profileWanted = false
    #endif

    /// A failed reading (no network) keeps the friends shown last time in this run of the app.
    private static var lastFriends: (owner: String, list: [Person])?

    init(messenger: Messenger? = nil) {
        self.messenger = messenger
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var incoming: [Person] { messenger == nil ? demoIncoming : FriendRequests.shared.incoming }
    private var outgoing: [Person] { messenger == nil ? demoOutgoing : FriendRequests.shared.outgoing }
    private var query: String { (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isSearch: Bool { query.utf16.count >= 2 }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg

        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.dataSource = self
        table.delegate = self
        table.keyboardDismissMode = .onDrag
        table.showsVerticalScrollIndicator = false
        table.register(PeopleLabelCell.self, forCellReuseIdentifier: "label")
        table.register(PersonCell.self, forCellReuseIdentifier: "person")
        table.register(PeopleEmptyCell.self, forCellReuseIdentifier: "empty")
        view.addSubview(table)

        heading.text = "Люди"
        heading.font = .systemFont(ofSize: 34, weight: .bold)
        heading.textColor = Theme.text
        view.addSubview(heading)
        caption.text = "Друзья, заявки и поиск по @имени"
        caption.font = .systemFont(ofSize: 13)
        caption.textColor = Theme.muted
        view.addSubview(caption)

        searchBox.backgroundColor = Theme.surface2
        searchBox.layer.cornerRadius = 24
        searchBox.layer.cornerCurve = .continuous
        view.addSubview(searchBox)
        searchIcon.image = UIImage(systemName: "magnifyingglass", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))
        searchIcon.tintColor = Theme.accent
        searchIcon.contentMode = .center
        searchBox.addSubview(searchIcon)
        field.attributedPlaceholder = NSAttributedString(string: "@имя или имя", attributes: [.foregroundColor: Theme.muted])
        field.font = .systemFont(ofSize: 15)
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.keyboardAppearance = .dark
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.returnKeyType = .search
        field.accessibilityLabel = "Ник или имя пользователя"
        field.delegate = self
        field.addTarget(self, action: #selector(queryChanged), for: .editingChanged)
        searchBox.addSubview(field)
        clearButton.setImage(UIImage(systemName: "xmark.circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)), for: .normal)
        clearButton.tintColor = Theme.muted
        clearButton.accessibilityLabel = "Очистить поиск"
        clearButton.addTarget(self, action: #selector(clearQuery), for: .touchUpInside)
        clearButton.isHidden = true
        searchBox.addSubview(clearButton)
        spinner.color = Theme.accent
        spinner.hidesWhenStopped = true
        searchBox.addSubview(spinner)

        if let messenger {
            if let last = PeopleViewController.lastFriends, last.owner == messenger.userId { friends = last.list }
            NotificationCenter.default.addObserver(self, selector: #selector(requestsChanged), name: FriendRequests.changed, object: nil)
        } else {
            #if targetEnvironment(simulator)
            friends = PeopleDemo.friends
            demoIncoming = PeopleDemo.incoming
            demoOutgoing = PeopleDemo.outgoing
            #endif
        }
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        rebuild()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard let messenger else { return }
        messenger.preparePersonAvatars()
        loadFriends()
        FriendRequests.shared.refresh()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top, width = view.bounds.width
        heading.frame = CGRect(x: 20, y: top + 8, width: width - 40, height: 41)
        caption.frame = CGRect(x: 20, y: heading.frame.maxY + 2, width: width - 40, height: 17)
        searchBox.frame = CGRect(x: 17, y: caption.frame.maxY + 14, width: width - 34, height: 52)
        searchIcon.frame = CGRect(x: 12, y: 0, width: 28, height: 52)
        clearButton.frame = CGRect(x: searchBox.bounds.width - 46, y: 4, width: 44, height: 44)
        spinner.center = clearButton.center
        field.frame = CGRect(x: 46, y: 0, width: searchBox.bounds.width - 46 - 48, height: 52)
        let listTop = searchBox.frame.maxY + 12
        table.frame = CGRect(x: 0, y: listTop, width: width, height: view.bounds.height - listTop)
        let barRoom = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 12
        let bottom = max(barRoom, keyboardHeight + 12)
        table.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: bottom, right: 0)
        table.verticalScrollIndicatorInsets = table.contentInset
    }

    @objc private func keyboardMoved(_ note: Notification) {
        guard isViewLoaded, let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let top = view.convert(frame, from: nil).minY
        keyboardHeight = max(0, view.bounds.height - top)
        view.setNeedsLayout()
    }

    // MARK: Reading

    private func loadFriends() {
        guard let messenger else { return }
        messenger.friends { [weak self] result in
            guard let self, case .success(let list) = result else { return }
            self.friends = list
            PeopleViewController.lastFriends = (owner: messenger.userId, list: list)
            self.rebuild()
            #if targetEnvironment(simulator)
            self.simulatorProfileIfWanted()
            #endif
        }
    }

    /// A request accepted on any device (or by the other person) changes the friends too.
    @objc private func requestsChanged() {
        loadFriends()
        rebuild()
    }

    @objc private func queryChanged() {
        sequence += 1
        let mine = sequence
        let wanted = query
        clearButton.isHidden = (field.text ?? "").isEmpty
        guard wanted.utf16.count >= 2 else {
            found = []
            searching = false
            problem = ""
            rebuild()
            return
        }
        searching = true
        rebuild()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, mine == self.sequence else { return }
            guard let messenger = self.messenger else {
                #if targetEnvironment(simulator)
                self.found = PeopleDemo.find(wanted)
                #endif
                self.searching = false
                self.rebuild()
                return
            }
            messenger.findPeople(wanted) { [weak self] result in
                guard let self, mine == self.sequence else { return }
                switch result {
                case .success(let list):
                    self.found = list
                    self.problem = ""
                case .failure(let error):
                    self.problem = error.words
                }
                self.searching = false
                self.rebuild()
            }
        }
    }

    @objc private func clearQuery() {
        field.text = ""
        queryChanged()
    }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        let length = ((textField.text ?? "") as NSString).length - range.length + (string as NSString).length
        return length <= 50
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return false
    }

    // MARK: The list

    private func rebuild() {
        guard isViewLoaded else { return }
        if searching {
            clearButton.isHidden = true
            spinner.startAnimating()
        } else {
            spinner.stopAnimating()
            clearButton.isHidden = (field.text ?? "").isEmpty
        }
        var list: [Item] = []
        if !problem.isEmpty { list.append(.notice(problem)) }
        let search = isSearch
        if !search {
            let came = incoming, sent = outgoing
            if !came.isEmpty {
                list.append(.label("ЗАЯВКИ В ДРУЗЬЯ  \(came.count)"))
                for person in came { list.append(.request(person, incoming: true)) }
            }
            if !sent.isEmpty {
                list.append(.label("ОТПРАВЛЕННЫЕ  \(sent.count)"))
                for person in sent { list.append(.request(person, incoming: false)) }
            }
        }
        let shown = search ? found : friends
        if !shown.isEmpty {
            list.append(.label(search ? "РЕЗУЛЬТАТЫ ПОИСКА" : "ДРУЗЬЯ  \(friends.count)"))
            for person in shown { list.append(.person(person)) }
        } else if !searching {
            if !search {
                list.append(.empty(heading: "Кому напишем?", words: "Введи @имя целиком или его первые 4 символа, либо имя полностью."))
            } else {
                let name = query.hasPrefix("@") ? String(query.dropFirst()) : query
                let words = name.utf16.count < 4 ? "По началу @имени ищется с 4 символов. Введи ещё или напиши @имя целиком." : "По этому запросу никого нет. Проверь написание @имени."
                list.append(.empty(heading: "Пока никого", words: words))
            }
        }
        items = list
        table.reloadData()
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { items.count }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        switch items[indexPath.row] {
        case .label: return 34
        case .notice(let words): return PeopleLabelCell.height(words, width: tableView.bounds.width)
        case .request: return 78
        case .person: return 83
        case .empty: return 300
        }
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        switch items[indexPath.row] {
        case .label(let words):
            let cell = tableView.dequeueReusableCell(withIdentifier: "label", for: indexPath)
            (cell as? PeopleLabelCell)?.show(words, notice: false)
            return cell
        case .notice(let words):
            let cell = tableView.dequeueReusableCell(withIdentifier: "label", for: indexPath)
            (cell as? PeopleLabelCell)?.show(words, notice: true)
            return cell
        case .empty(let heading, let words):
            let cell = tableView.dequeueReusableCell(withIdentifier: "empty", for: indexPath)
            (cell as? PeopleEmptyCell)?.show(heading: heading, words: words)
            return cell
        case .request(let person, let came):
            let cell = tableView.dequeueReusableCell(withIdentifier: "person", for: indexPath)
            var buttons: [PersonCell.Action] = []
            if came {
                buttons.append(PersonCell.Action(symbol: "checkmark", words: "Принять: \(person.displayName)", look: .primary) { [weak self] in self?.answer(person, accept: true) })
                buttons.append(PersonCell.Action(symbol: "xmark", words: "Отклонить: \(person.displayName)", look: .outline) { [weak self] in self?.answer(person, accept: false) })
            } else {
                buttons.append(PersonCell.Action(symbol: "xmark", words: "Отменить заявку: \(person.displayName)", look: .outline) { [weak self] in self?.answer(person, accept: false) })
            }
            let handle = came ? "@\(person.username)" : "@\(person.username) · Ждёт ответа"
            (cell as? PersonCell)?.show(person, address: address(person), handle: handle, framed: true, dimmed: acting != nil && acting != person.id,
                                        busy: acting == person.id, enabled: acting == nil, buttons: buttons)
            cell.accessibilityLabel = "Профиль \(person.displayName)"
            return cell
        case .person(let person):
            let cell = tableView.dequeueReusableCell(withIdentifier: "person", for: indexPath)
            let buttons: [PersonCell.Action] = [
                PersonCell.Action(symbol: "info.circle", words: "Профиль \(person.displayName)", look: .plain) { [weak self] in self?.showProfile(person) },
                PersonCell.Action(symbol: "bubble.left", words: "Написать: \(person.displayName)", look: .soft) { [weak self] in self?.openChat(person) },
            ]
            (cell as? PersonCell)?.show(person, address: address(person), handle: "@\(person.username)", framed: false, dimmed: creating != nil && creating != person.id,
                                        busy: creating == person.id, enabled: creating == nil, buttons: buttons)
            cell.accessibilityLabel = person.displayName
            return cell
        }
    }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
        switch items[indexPath.row] {
        case .request, .person: return true
        default: return false
        }
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        switch items[indexPath.row] {
        case .request(let person, _): showProfile(person)
        case .person(let person): openChat(person)
        default: break
        }
    }

    private func address(_ person: Person) -> String { messenger?.personAvatarAddress(person.avatarId) ?? "" }

    // MARK: What the person does

    private func showProfile(_ person: Person) {
        view.endEditing(true)
        navigationController?.pushViewController(PersonProfileViewController(messenger: messenger, userId: person.id, name: person.displayName, person: person), animated: true)
    }

    private func openChat(_ person: Person) {
        guard creating == nil else { return }
        guard let messenger else {
            #if targetEnvironment(simulator)
            navigationController?.pushViewController(ChatViewController(name: person.displayName), animated: true)
            #endif
            return
        }
        creating = person.id
        problem = ""
        rebuild()
        messenger.openChat(with: person, from: self) { [weak self] error in
            guard let self else { return }
            self.creating = nil
            if let error { self.problem = error.words } else { self.view.endEditing(true) }
            self.rebuild()
        }
    }

    /// «Принять», «Отклонить», «Отменить заявку».
    private func answer(_ person: Person, accept: Bool) {
        guard acting == nil else { return }
        guard let messenger else {
            #if targetEnvironment(simulator)
            demoIncoming.removeAll { $0.id == person.id }
            demoOutgoing.removeAll { $0.id == person.id }
            if accept { friends.append(person) }
            rebuild()
            #endif
            return
        }
        acting = person.id
        problem = ""
        rebuild()
        let done: (ServerError?) -> Void = { [weak self] error in
            guard let self else { return }
            self.acting = nil
            if let error { self.problem = error.words }
            self.rebuild()
            FriendRequests.shared.refresh()
        }
        if accept { messenger.acceptFriend(person.id, done: done) } else { messenger.dropFriendRequest(person.id, done: done) }
    }

    // MARK: The simulator check

    #if targetEnvironment(simulator)
    /// Fills the search field in and searches.
    func simulatorSearch(_ text: String) {
        loadViewIfNeeded()
        field.text = text
        queryChanged()
    }

    /// Opens the profile of the first friend when the friends are read; without friends — of the first
    /// request, else of the person of the first chat.
    func simulatorOpenFirstProfile() {
        loadViewIfNeeded()
        profileWanted = true
        if messenger == nil { simulatorProfileIfWanted() }
    }

    private func simulatorProfileIfWanted() {
        guard profileWanted else { return }
        profileWanted = false
        if let person = friends.first ?? incoming.first ?? outgoing.first { return showProfile(person) }
        messenger?.chats { [weak self] result in
            guard let self, case .success(let chats) = result, let chat = chats.first else { return }
            self.navigationController?.pushViewController(PersonProfileViewController(messenger: self.messenger, userId: chat.peerId, name: chat.title), animated: true)
        }
    }
    #endif
}

/// A quiet heading of a part of the list («ДРУЗЬЯ  5»), or words about what did not work.
final class PeopleLabelCell: UITableViewCell {
    private let words = UILabel()
    private static let noticeFont = UIFont.systemFont(ofSize: 14)

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        words.numberOfLines = 0
        contentView.addSubview(words)
    }

    required init?(coder: NSCoder) { return nil }

    static func height(_ text: String, width: CGFloat) -> CGFloat {
        let box = (text as NSString).boundingRect(with: CGSize(width: max(10, width - 52), height: 1000), options: [.usesLineFragmentOrigin], attributes: [.font: noticeFont], context: nil)
        return ceil(box.height) + 22
    }

    func show(_ text: String, notice: Bool) {
        if notice {
            words.attributedText = nil
            words.text = text
            words.font = PeopleLabelCell.noticeFont
            words.textColor = Theme.danger
        } else {
            words.attributedText = NSAttributedString(string: text, attributes: [.kern: 1.7, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        }
        accessibilityTraits = notice ? .staticText : .header
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        words.frame = CGRect(x: 26, y: 0, width: contentView.bounds.width - 52, height: contentView.bounds.height - 8)
    }
}

/// «Кому напишем?» — the list is empty.
final class PeopleEmptyCell: UITableViewCell {
    private let badge = UIView()
    private let icon = UIImageView()
    private let heading = UILabel()
    private let words = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        badge.backgroundColor = UIColor(white: 1, alpha: 0.07)
        badge.layer.cornerRadius = 30
        badge.layer.cornerCurve = .continuous
        contentView.addSubview(badge)
        icon.image = UIImage(systemName: "person.2", withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .regular))
        icon.tintColor = Theme.accent
        icon.contentMode = .center
        badge.addSubview(icon)
        heading.font = .systemFont(ofSize: 21, weight: .heavy)
        heading.textColor = Theme.text
        heading.textAlignment = .center
        contentView.addSubview(heading)
        words.font = .systemFont(ofSize: 15)
        words.textColor = Theme.muted
        words.textAlignment = .center
        words.numberOfLines = 0
        contentView.addSubview(words)
    }

    required init?(coder: NSCoder) { return nil }

    func show(heading title: String, words text: String) {
        heading.text = title
        words.text = text
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width
        badge.frame = CGRect(x: (width - 94) / 2, y: 38, width: 94, height: 94)
        icon.frame = badge.bounds
        heading.frame = CGRect(x: 28, y: badge.frame.maxY + 21, width: width - 56, height: 27)
        let room = min(310, width - 56)
        let size = words.sizeThatFits(CGSize(width: room, height: 1000))
        words.frame = CGRect(x: (width - room) / 2, y: heading.frame.maxY + 13, width: room, height: ceil(size.height))
    }
}

/// A person in the list: the picture, the name, the @username, and round buttons on the right.
final class PersonCell: UITableViewCell {
    enum Look { case plain, soft, primary, outline }
    struct Action {
        let symbol: String
        let words: String
        let look: Look
        let run: () -> Void
    }

    private let card = UIView()
    private let avatar = PersonAvatarView()
    private let nameLabel = UILabel()
    private let handleLabel = UILabel()
    private let waiting = UIActivityIndicatorView(style: .medium)
    private var buttons: [UIButton] = []
    private var framed = false

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        card.layer.cornerRadius = 24
        card.layer.cornerCurve = .continuous
        contentView.addSubview(card)
        card.addSubview(avatar)
        nameLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        nameLabel.textColor = Theme.text
        card.addSubview(nameLabel)
        handleLabel.font = .systemFont(ofSize: 12)
        handleLabel.textColor = Theme.muted
        card.addSubview(handleLabel)
        waiting.color = Theme.accent
        waiting.hidesWhenStopped = true
        card.addSubview(waiting)
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ person: Person, address: String, handle: String, framed: Bool, dimmed: Bool, busy: Bool, enabled: Bool, buttons actions: [Action]) {
        self.framed = framed
        avatar.show(person, address: address)
        nameLabel.text = person.displayName
        handleLabel.text = handle
        card.layer.borderWidth = framed ? 1 : 0
        card.layer.borderColor = UIColor(white: 1, alpha: 0.08).cgColor
        card.backgroundColor = framed ? UIColor(white: 1, alpha: 0.04) : .clear
        card.alpha = dimmed ? 0.5 : 1
        for button in buttons { button.removeFromSuperview() }
        buttons = []
        // While this row's request is on its way, the wheel stands where its buttons were (in a list of
        // people: where the «написать» button was).
        var shown: [Action] = actions
        if busy { shown = framed ? [] : Array(actions.dropLast()) }
        for action in shown {
            let button = UIButton(type: .system)
            button.setImage(UIImage(systemName: action.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: action.look == .plain ? 19 : 15, weight: .medium)), for: .normal)
            button.accessibilityLabel = action.words
            button.isEnabled = enabled
            button.layer.cornerRadius = 19
            switch action.look {
            case .plain:
                button.tintColor = Theme.muted
            case .soft:
                button.tintColor = Theme.accent
                button.backgroundColor = UIColor(white: 1, alpha: 0.08)
            case .primary:
                button.tintColor = Theme.onAccent
                button.backgroundColor = Theme.accent
            case .outline:
                button.tintColor = Theme.muted
                button.layer.borderWidth = 1
                button.layer.borderColor = UIColor(white: 1, alpha: 0.14).cgColor
            }
            let run = action.run
            button.addAction(UIAction { _ in run() }, for: .touchUpInside)
            card.addSubview(button)
            buttons.append(button)
        }
        if busy { waiting.startAnimating() } else { waiting.stopAnimating() }
        setNeedsLayout()
    }

    override func setHighlighted(_ highlighted: Bool, animated: Bool) {
        super.setHighlighted(highlighted, animated: animated)
        card.backgroundColor = highlighted ? UIColor(white: 1, alpha: 0.07) : (framed ? UIColor(white: 1, alpha: 0.04) : .clear)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let gap: CGFloat = framed ? 6 : 7
        card.frame = CGRect(x: 14, y: 0, width: contentView.bounds.width - 28, height: contentView.bounds.height - gap)
        let height = card.bounds.height
        avatar.frame = CGRect(x: 14, y: (height - 48) / 2, width: 48, height: 48)
        var right = card.bounds.width - 12
        if waiting.isAnimating {
            waiting.center = CGPoint(x: right - 19, y: height / 2)
            right -= 38 + 6
        }
        for button in buttons.reversed() {
            button.frame = CGRect(x: right - 38, y: (height - 38) / 2, width: 38, height: 38)
            right -= 38 + 6
        }
        let left = avatar.frame.maxX + 14
        let room = max(0, right - left)
        nameLabel.frame = CGRect(x: left, y: height / 2 - 21, width: room, height: 21)
        handleLabel.frame = CGRect(x: left, y: height / 2 + 4, width: room, height: 16)
    }
}
