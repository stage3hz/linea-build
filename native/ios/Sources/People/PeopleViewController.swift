import UIKit

/// The «Люди» section: friends, requests to be friends, and the search of people by @username or name.
/// Ported from the reference's PeopleScreen.tsx (its «Звонки» half waits for calls).
final class PeopleViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextFieldDelegate {
    private enum Item {
        /// A heading of the requests (`first`: the upper of the two sections; the next one stands 6 lower).
        case label(String, first: Bool)
        case request(Person, incoming: Bool)
        /// The 12 between the requests and the people (the requests' `paddingBottom`).
        case gap
        case person(Person)
        case empty(heading: String, words: String)
    }

    /// The account whose people are shown; nil shows the simulator's samples (or nothing on a phone).
    private let messenger: Messenger?
    // B: the reference's header — «Люди» and its quiet line in a glass pill (GlassSurface «clear», radius 27, 14 from the
    // sides, 12 under the safe area, 10 inside, at least 72 tall; the name 26 on a 32 line, the line 11) — and the
    // search on glass (radius 24, at least 54 tall).
    private let header = GlassHeaderView(title: "Люди", subtitle: "Друзья, заявки и поиск по @имени", titleSize: 26, lineHeight: 32,
                                         subtitleSize: 11, padding: 10, minHeight: 72, clear: true)
    private var caption: UILabel { header.subtitleLabel }
    private let searchBox = GlassSearchField()
    private let field = UITextField()
    private let clearButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let table = UITableView(frame: .zero, style: .plain)
    /// What did not work (the reference's `Notice error`), above the list, 17 from the sides.
    private let notice = PeopleNoticeView()
    /// «ДРУЗЬЯ  5» / «РЕЗУЛЬТАТЫ ПОИСКА»: above the list, not in it (it does not scroll), 26 from the left.
    private let listLabel = UILabel()
    /// ChatsPlus: «Друзья | Звонки» and the list of recent calls (Sources/ChatsPlus/CallHistory.swift).
    private lazy var calls = CallHistoryPanel(messenger: messenger)

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

        view.addSubview(header)
        view.addSubview(searchBox)
        notice.isHidden = true
        view.addSubview(notice)
        listLabel.isHidden = true
        listLabel.accessibilityTraits = .header
        view.addSubview(listLabel)
        field.attributedPlaceholder = NSAttributedString(string: "@имя или имя", attributes: [.foregroundColor: Theme.muted])
        field.font = .systemFont(ofSize: 15)
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.keyboardAppearance = Theme.dark ? .dark : .light
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.returnKeyType = .search
        field.accessibilityLabel = "Ник или имя пользователя"
        field.delegate = self
        field.addTarget(self, action: #selector(queryChanged), for: .editingChanged)
        searchBox.addSubview(field)
        clearButton.setImage(IonIcon.image("close-circle", size: 18), for: .normal)
        clearButton.tintColor = Theme.muted
        clearButton.accessibilityLabel = "Очистить поиск"
        clearButton.addTarget(self, action: #selector(clearQuery), for: .touchUpInside)
        clearButton.isHidden = true
        searchBox.addSubview(clearButton)
        spinner.color = Theme.accent
        spinner.hidesWhenStopped = true
        searchBox.addSubview(spinner)
        calls.install(host: self, caption: caption) // ChatsPlus

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
        header.frame = CGRect(x: 14, y: top + 12, width: width - 28, height: 72)
        // ChatsPlus: the switch «Друзья | Звонки» stands between the header and the search (14 under the pill).
        searchBox.frame = CGRect(x: 17, y: calls.place(in: view, top: header.frame.maxY + 2) + 14, width: width - 34, height: 54)
        // The clear button: `IconButton` 30 wide, 44 tall, at the end of the row (paddingHorizontal 15, gap 10).
        clearButton.frame = CGRect(x: searchBox.bounds.width - 15 - 30, y: 5, width: 30, height: 44)
        spinner.center = clearButton.center
        field.frame = CGRect(x: searchBox.wordsLeft, y: 0, width: searchBox.bounds.width - searchBox.wordsLeft - 15 - 30 - 10, height: 54)
        var listTop = searchBox.frame.maxY + 17
        if !notice.isHidden {
            let tall = notice.height(for: width - 34)
            notice.frame = CGRect(x: 17, y: listTop, width: width - 34, height: tall)
            listTop += tall + 12
        }
        if !listLabel.isHidden {
            let tall = ceil(listLabel.sizeThatFits(CGSize(width: width - 52, height: 100)).height)
            listLabel.frame = CGRect(x: 26, y: listTop, width: width - 52, height: tall)
            listTop += tall + 12
        }
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
        notice.show(problem)
        notice.isHidden = problem.isEmpty
        let search = isSearch
        if !search {
            let came = incoming, sent = outgoing
            if !came.isEmpty {
                list.append(.label("ЗАЯВКИ В ДРУЗЬЯ  \(came.count)", first: true))
                for person in came { list.append(.request(person, incoming: true)) }
            }
            if !sent.isEmpty {
                list.append(.label("ОТПРАВЛЕННЫЕ  \(sent.count)", first: came.isEmpty))
                for person in sent { list.append(.request(person, incoming: false)) }
            }
            if !came.isEmpty || !sent.isEmpty { list.append(.gap) }
        }
        let shown = search ? found : friends
        listLabel.isHidden = shown.isEmpty
        listLabel.attributedText = NSAttributedString(string: search ? "РЕЗУЛЬТАТЫ ПОИСКА" : "ДРУЗЬЯ  \(friends.count)", attributes: PeopleLabelCell.attributes)
        view.setNeedsLayout()
        if !shown.isEmpty {
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
        // A request: 12 + the picture (54) + 12, and 6 under it; a person: 14 + 54 + 14, and 7 under it.
        case .label(_, let first): return PeopleLabelCell.height + (first ? 0 : 6)
        case .gap: return 12
        case .request: return 84
        case .person: return 89
        case .empty: return max(PeopleEmptyCell.height(tableView.bounds.width), tableView.bounds.height - tableView.contentInset.bottom - 35)
        }
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        switch items[indexPath.row] {
        case .label(let words, _):
            let cell = tableView.dequeueReusableCell(withIdentifier: "label", for: indexPath)
            (cell as? PeopleLabelCell)?.show(words)
            return cell
        case .gap:
            let cell = tableView.dequeueReusableCell(withIdentifier: "label", for: indexPath)
            (cell as? PeopleLabelCell)?.show("")
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
                buttons.append(PersonCell.Action(symbol: "close", words: "Отклонить: \(person.displayName)", look: .outline) { [weak self] in self?.answer(person, accept: false) })
            } else {
                buttons.append(PersonCell.Action(symbol: "close", words: "Отменить заявку: \(person.displayName)", look: .outline) { [weak self] in self?.answer(person, accept: false) })
            }
            let handle = came ? "@\(person.username)" : "@\(person.username) · Ждёт ответа"
            (cell as? PersonCell)?.show(person, address: address(person), handle: handle, framed: true, dimmed: acting != nil && acting != person.id,
                                        busy: acting == person.id, enabled: acting == nil, buttons: buttons)
            cell.accessibilityLabel = "Профиль \(person.displayName)"
            return cell
        case .person(let person):
            let cell = tableView.dequeueReusableCell(withIdentifier: "person", for: indexPath)
            let buttons: [PersonCell.Action] = [
                PersonCell.Action(symbol: "information-circle-outline", words: "Профиль \(person.displayName)", look: .plain) { [weak self] in self?.showProfile(person) },
                PersonCell.Action(symbol: "chatbubble-outline", words: "Написать: \(person.displayName)", look: .soft) { [weak self] in self?.openChat(person) },
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

/// A quiet heading of the requests («ЗАЯВКИ В ДРУЗЬЯ  2»): 10, bold, 1.7 apart, 26 from the left, 4 above, 10 under.
final class PeopleLabelCell: UITableViewCell {
    private let words = UILabel()
    static var attributes: [NSAttributedString.Key: Any] { return [.kern: 1.7, .font: UIFont.systemFont(ofSize: 10, weight: .bold), .foregroundColor: Theme.muted] }
    static var height: CGFloat { return 4 + ceil(UIFont.systemFont(ofSize: 10, weight: .bold).lineHeight) + 10 }

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        contentView.addSubview(words)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ text: String) {
        words.attributedText = NSAttributedString(string: text, attributes: PeopleLabelCell.attributes)
        accessibilityTraits = .header
        isAccessibilityElement = !text.isEmpty
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let line = ceil(UIFont.systemFont(ofSize: 10, weight: .bold).lineHeight)
        words.frame = CGRect(x: 26, y: contentView.bounds.height - 10 - line, width: contentView.bounds.width - 52, height: line)
    }
}

/// What did not work (the reference's `Notice` with `error`): glass of radius 18 under the danger tint, the
/// `alert-circle-outline` (19) and the words (13 on 19) in the danger colour, 14 inside, 10 between.
final class PeopleNoticeView: UIView {
    private let pill = GlassPill(interactive: false)
    private let tint = UIView()
    private let icon = UIImageView(image: IonIcon.image("alert-circle-outline", size: 19))
    private let words = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        pill.shape(radius: 18)
        addSubview(pill)
        tint.layer.cornerRadius = 18
        tint.layer.cornerCurve = .continuous
        tint.isUserInteractionEnabled = false
        addSubview(tint)
        icon.tintColor = Theme.danger
        addSubview(icon)
        words.numberOfLines = 0
        addSubview(words)
        accessibilityTraits = .staticText
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { return nil }

    private func text(_ value: String) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 19
        style.maximumLineHeight = 19
        return NSAttributedString(string: value, attributes: [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: Theme.danger, .paragraphStyle: style])
    }

    func show(_ value: String) {
        words.attributedText = text(value)
        tint.backgroundColor = ThemeStore.look.dangerBg
        accessibilityLabel = value
        setNeedsLayout()
    }

    func height(for width: CGFloat) -> CGFloat {
        let room = max(10, width - 28 - 19 - 10)
        return max(19, ceil(words.sizeThatFits(CGSize(width: room, height: 1000)).height)) + 28
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        pill.frame = bounds
        tint.frame = bounds
        icon.frame = CGRect(x: 14, y: 14, width: 19, height: 19)
        let room = max(10, bounds.width - 28 - 19 - 10)
        words.frame = CGRect(x: 14 + 19 + 10, y: 14, width: room, height: bounds.height - 28)
    }
}

/// «Кому напишем?» — the list is empty: the reference's `Empty` with `people-outline`, in the middle of the room
/// left (`justifyContent: center`, 35 kept free under it).
final class PeopleEmptyCell: UITableViewCell {
    private let empty = EmptyStateView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        contentView.addSubview(empty)
    }

    required init?(coder: NSCoder) { return nil }

    private static let sizer = EmptyStateView()

    static func height(_ width: CGFloat) -> CGFloat {
        sizer.show(symbol: "ion:people-outline", title: "Кому напишем?", words: "Введи @имя целиком или его первые 4 символа, либо имя полностью.")
        return sizer.height(for: width - 28)
    }

    func show(heading title: String, words text: String) {
        empty.show(symbol: "ion:people-outline", title: title, words: text)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        empty.frame = CGRect(x: 14, y: 0, width: contentView.bounds.width - 28, height: contentView.bounds.height - 35)
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
    /// Avatars: the emoji status or the Platina gem after the name (PeopleScreen.tsx `StatusEmoji` 15, requests 14).
    private let statusEmoji = StatusEmojiView()
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
        card.addSubview(nameLabel)
        handleLabel.font = .systemFont(ofSize: 12)
        handleLabel.textColor = Theme.muted
        card.addSubview(handleLabel)
        card.addSubview(statusEmoji) // Avatars
        waiting.color = Theme.accent
        waiting.hidesWhenStopped = true
        card.addSubview(waiting)
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ person: Person, address: String, handle: String, framed: Bool, dimmed: Bool, busy: Bool, enabled: Bool, buttons actions: [Action]) {
        self.framed = framed
        avatar.show(person, address: address)
        // A request: the name 15; a person: 16 with −0.2 between the letters (PeopleScreen.tsx).
        nameLabel.attributedText = NSAttributedString(string: person.displayName, attributes: [.font: UIFont.systemFont(ofSize: framed ? 15 : 16, weight: .semibold), .foregroundColor: Theme.text, .kern: framed ? 0 : -0.2])
        nameLabel.lineBreakMode = .byTruncatingTail
        statusEmoji.show(person.look, size: framed ? 14 : 15) // Avatars
        handleLabel.text = handle
        card.layer.borderWidth = 1
        paintCard(pressed: false)
        card.layer.cornerRadius = framed ? 22 : 24
        card.alpha = dimmed ? (framed ? 0.5 : 0.45) : 1
        for button in buttons { button.removeFromSuperview() }
        buttons = []
        // While this row's request is on its way, the wheel stands where its buttons were (in a list of
        // people: where the «написать» button was).
        var shown: [Action] = actions
        if busy { shown = framed ? [] : Array(actions.dropLast()) }
        for action in shown {
            let button = UIButton(type: .custom)
            // `IconButton` (the info): 22 on a clear glass round 38 × 40; the others 19 on 38 × 38.
            button.setImage(IonIcon.image(action.symbol, size: action.look == .plain ? 22 : 19), for: .normal)
            button.accessibilityLabel = action.words
            button.isEnabled = enabled
            button.layer.cornerCurve = .continuous
            switch action.look {
            case .plain:
                button.tintColor = Theme.muted
            case .soft:
                button.tintColor = Theme.accent
                button.backgroundColor = ThemeStore.look.accentSoft
                button.layer.cornerRadius = 18
                button.layer.borderWidth = 1
                button.layer.borderColor = ThemeStore.look.border.cgColor
                button.isUserInteractionEnabled = false // the row itself opens the chat
            case .primary:
                button.tintColor = Theme.onAccent
                button.backgroundColor = Theme.accent
                button.layer.cornerRadius = 19
            case .outline:
                button.tintColor = Theme.muted
                button.layer.cornerRadius = 19
                button.layer.borderWidth = 1
                button.layer.borderColor = ThemeStore.look.border.cgColor
            }
            if action.look == .plain {
                button.frame = CGRect(x: 0, y: 0, width: 38, height: 40)
                GlassBacking.put(under: button, side: 38)
            } else if action.look != .soft {
                // Pressable with `opacity: pressed ? .6 : 1`.
                button.addAction(UIAction { [weak button] _ in button?.alpha = 0.6 }, for: [.touchDown, .touchDragEnter])
                button.addAction(UIAction { [weak button] _ in button?.alpha = 1 }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
            }
            let run = action.run
            button.addAction(UIAction { _ in run() }, for: .touchUpInside)
            card.addSubview(button)
            buttons.append(button)
        }
        if busy { waiting.startAnimating() } else { waiting.stopAnimating() }
        setNeedsLayout()
    }

    /// A person's row: clear, and on a press the page's border and a light veil; a request's: always framed.
    private func paintCard(pressed: Bool) {
        if framed {
            card.backgroundColor = Theme.dark ? UIColor(white: 1, alpha: 0.04) : UIColor(white: 1, alpha: 0.45)
            card.layer.borderColor = ThemeStore.look.border.cgColor
        } else {
            card.backgroundColor = pressed ? (Theme.dark ? UIColor(white: 1, alpha: 0.07) : UIColor(white: 1, alpha: 0.5)) : .clear
            card.layer.borderColor = pressed ? ThemeStore.look.border.cgColor : UIColor.clear.cgColor
        }
    }

    override func setHighlighted(_ highlighted: Bool, animated: Bool) {
        super.setHighlighted(highlighted, animated: animated)
        paintCard(pressed: highlighted)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // A request: 12 inside, 12 between, 6 under; a person: 14, 14, 7.
        let gap: CGFloat = framed ? 6 : 7
        let inset: CGFloat = framed ? 12 : 14
        let between: CGFloat = framed ? 12 : 14
        card.frame = CGRect(x: 14, y: 0, width: contentView.bounds.width - 28, height: contentView.bounds.height - gap)
        let height = card.bounds.height
        avatar.frame = CGRect(x: inset, y: (height - 54) / 2, width: 54, height: 54)
        var right = card.bounds.width - inset
        if waiting.isAnimating {
            waiting.center = CGPoint(x: right - waiting.bounds.width / 2, y: height / 2)
            right -= waiting.bounds.width + between
        }
        for button in buttons.reversed() {
            let tall: CGFloat = button.bounds.height == 40 ? 40 : 38
            button.frame = CGRect(x: right - 38, y: (height - tall) / 2, width: 38, height: tall)
            right -= 38 + between
        }
        right += between
        let left = avatar.frame.maxX + between
        let room = max(0, right - between - left)
        // Avatars: the name, then the emoji status 6 pt after it (the name gives way when the room is short).
        let emojiSize = statusEmoji.isHidden ? CGSize.zero : statusEmoji.intrinsicContentSize
        let emojiRoom = statusEmoji.isHidden ? 0 : emojiSize.width + 6
        let nameLine = ceil(UIFont.systemFont(ofSize: framed ? 15 : 16, weight: .semibold).lineHeight)
        let handleLine = ceil(UIFont.systemFont(ofSize: 12).lineHeight)
        let spacing: CGFloat = framed ? 4 : 6
        let top = (height - nameLine - spacing - handleLine) / 2
        let nameWidth = min(max(0, room - emojiRoom), ceil(nameLabel.intrinsicContentSize.width))
        nameLabel.frame = CGRect(x: left, y: top, width: nameWidth, height: nameLine)
        statusEmoji.frame = CGRect(x: left + nameWidth + 6, y: top + nameLine / 2 - emojiSize.height / 2, width: emojiSize.width, height: emojiSize.height)
        handleLabel.frame = CGRect(x: left, y: top + nameLine + spacing, width: room, height: handleLine)
    }
}
