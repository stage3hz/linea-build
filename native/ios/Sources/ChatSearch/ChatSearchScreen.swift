import UIKit

/// The search of the chat list as a screen of its own (mobile/src/ChatSearch.tsx): the heading and the bar give way
/// to a glass field with a round ✕, «Недавние» (kept only on this device) while the field is empty, results by scope
/// as plain rows (the name and @имя), and a glass strip of scopes — «Чаты · Сообщения · Люди · Каналы» — riding
/// above the keyboard where the bar was. A swipe to the right closes it, as the ✕ does.
///
/// «Сообщения» looks in the decrypted history kept on this device only: nothing about it is sent to the server.
final class ChatSearchScreen: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextFieldDelegate {
    enum Scope { case chats, messages, people, channels }
    private static let scopes: [(scope: Scope, label: String)] = [(.chats, "Чаты"), (.messages, "Сообщения"), (.people, "Люди"), (.channels, "Каналы")]
    private static let recentLimit = 15

    /// One line of the results.
    struct Row {
        var key: String
        var title: String
        var sub: String
        var person: Person?
        var community: CommunitySummary?
        var saved = false
        /// «Сообщения»: the chat a group of found messages belongs to.
        var header = false
        /// «Сообщения»: a found message (with its date at the right).
        var date: String?
        var run: () -> Void
    }

    private struct Hit {
        let chatId: String
        let clientId: String
        let senderId: String
        let text: String
        let sentAt: String
    }

    private let messenger: Messenger?
    private let chats: [Messenger.ChatSummary]
    private var query: String
    private var scope = Scope.chats
    private var rows: [Row] = []
    private var recent: [[String: Any]] = []
    private var people: [Person]?
    private var peopleFor = ""
    private var peopleSoon: DispatchWorkItem?
    /// The friends of this account, for the people listed with the chats (loaded once, when the search opens).
    private var friendList: [Person] = []
    private var hits: [Hit] = []
    private var hitsFor = ""
    private var historyRun = 0
    private var error = ""

    /// Opens a chat after the search has closed (`focus`: the message to stand at; empty: none).
    var openChat: ((String, String) -> Void)?
    /// Opens the chat with a person who has none here yet (it is made).
    var openPerson: ((Person) -> Void)?
    var openSaved: (() -> Void)?
    var openCommunity: ((String) -> Void)?

    private let header = UIView()
    private let fieldPill = GlassPill(interactive: false)
    private let searchIcon = UIImageView()
    private let field = UITextField()
    private let erase = UIButton(type: .system)
    private let closePill = GlassPill(interactive: true)
    private let closeButton = UIButton(type: .system)
    private let errorLabel = UILabel()
    private let table = UITableView(frame: .zero, style: .plain)
    private let recentHead = UIView()
    private let recentWords = UILabel()
    private let recentClear = UIButton(type: .system)
    private let emptyLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let scopeBar = GlassPill(interactive: false)
    private var scopeButtons: [UIButton] = []
    private var keyboardTop: CGFloat?

    init(messenger: Messenger?, chats: [Messenger.ChatSummary], query: String) {
        self.messenger = messenger
        self.chats = chats
        self.query = query
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var recentKey: String { "linea.recent-search.v1:" + (messenger?.userId ?? "sample") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        loadRecent()
        messenger?.friends { [weak self] (result: Result<[Person], ServerError>) -> Void in
            DispatchQueue.main.async {
                guard let self, case .success(let list) = result else { return }
                self.friendList = list
                self.refresh()
            }
        }

        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.keyboardDismissMode = .onDrag
        table.alwaysBounceVertical = true
        table.contentInsetAdjustmentBehavior = .never
        table.dataSource = self
        table.delegate = self
        table.register(ChatSearchCell.self, forCellReuseIdentifier: "row")
        view.addSubview(table)

        recentWords.text = "НЕДАВНИЕ"
        recentWords.font = .systemFont(ofSize: 13, weight: .semibold)
        recentWords.textColor = Theme.muted
        recentWords.attributedText = NSAttributedString(string: "НЕДАВНИЕ", attributes: [.kern: 0.3, .font: UIFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: Theme.muted])
        recentHead.addSubview(recentWords)
        recentClear.setTitle("Очистить", for: .normal)
        recentClear.titleLabel?.font = .systemFont(ofSize: 14)
        recentClear.tintColor = Theme.accent
        recentClear.addTarget(self, action: #selector(clearRecent), for: .touchUpInside)
        recentHead.addSubview(recentClear)
        recentHead.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: 30)

        emptyLabel.font = .systemFont(ofSize: 14)
        emptyLabel.textColor = Theme.muted
        emptyLabel.textAlignment = .center
        emptyLabel.numberOfLines = 0
        view.addSubview(emptyLabel)
        spinner.color = Theme.accent
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)

        view.addSubview(header)
        header.addSubview(fieldPill)
        searchIcon.image = UIImage(systemName: "magnifyingglass", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
        searchIcon.tintColor = Theme.muted
        searchIcon.contentMode = .center
        fieldPill.contentView.addSubview(searchIcon)
        field.text = query
        field.attributedPlaceholder = NSAttributedString(string: "Поиск", attributes: [.foregroundColor: Theme.muted])
        field.font = .systemFont(ofSize: 17)
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.keyboardAppearance = Theme.dark ? .dark : .light
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.returnKeyType = .search
        field.accessibilityLabel = "Поиск"
        field.delegate = self
        field.addTarget(self, action: #selector(typed), for: .editingChanged)
        fieldPill.contentView.addSubview(field)
        erase.setImage(UIImage(systemName: "xmark.circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)), for: .normal)
        erase.tintColor = Theme.muted
        erase.accessibilityLabel = "Стереть"
        erase.addTarget(self, action: #selector(eraseQuery), for: .touchUpInside)
        fieldPill.contentView.addSubview(erase)
        header.addSubview(closePill)
        closeButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium)), for: .normal)
        closeButton.tintColor = Theme.text
        closeButton.accessibilityLabel = "Закрыть поиск"
        closeButton.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        closePill.contentView.addSubview(closeButton)
        Bouncy.attach(closeButton, scale: 0.84, view: closePill)
        errorLabel.font = .systemFont(ofSize: 13)
        errorLabel.textColor = Theme.danger
        errorLabel.numberOfLines = 0
        view.addSubview(errorLabel)

        for (index, item) in ChatSearchScreen.scopes.enumerated() {
            let button = UIButton(type: .custom)
            button.tag = index
            button.setTitle(item.label, for: .normal)
            button.layer.cornerRadius = 17
            button.layer.cornerCurve = .continuous
            button.addTarget(self, action: #selector(scopeTapped(_:)), for: .touchUpInside)
            scopeBar.contentView.addSubview(button)
            scopeButtons.append(button)
        }
        view.addSubview(scopeBar)
        #if targetEnvironment(simulator)
        // The simulator check: -chatsearchscope messages|people|channels opens that scope.
        switch UserDefaults.standard.string(forKey: "chatsearchscope") ?? "" {
        case "messages": scope = .messages
        case "people": scope = .people
        case "channels": scope = .channels
        default: break
        }
        #endif
        showScopes()

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(channelsChanged), name: ChannelsStore.changed, object: nil)
        refresh()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        #if targetEnvironment(simulator)
        // The simulator check (-chatsearch <words>): the words are in, the keyboard stays away.
        if UserDefaults.standard.string(forKey: "chatsearch") != nil { return }
        #endif
        if query.isEmpty { field.becomeFirstResponder() }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, top = view.safeAreaInsets.top
        // ChatSearch.tsx: a row of the field (flex) and the ✕ (44), gap 10, 16 from the sides, 6 above, 10 under.
        header.frame = CGRect(x: 0, y: top, width: width, height: 6 + 44 + 10)
        closePill.frame = CGRect(x: width - 16 - 44, y: 6, width: 44, height: 44)
        closePill.shape(radius: 22)
        closeButton.frame = closePill.bounds
        fieldPill.frame = CGRect(x: 16, y: 6, width: max(0, closePill.frame.minX - 10 - 16), height: 44)
        fieldPill.shape(radius: 22)
        let hasWords = !(field.text ?? "").isEmpty
        erase.isHidden = !hasWords
        searchIcon.frame = CGRect(x: 13, y: 0, width: 19, height: 44)
        let fieldRight = hasWords ? fieldPill.bounds.width - 13 - 18 - 8 : fieldPill.bounds.width - 13
        field.frame = CGRect(x: 13 + 19 + 8, y: 0, width: max(0, fieldRight - (13 + 19 + 8)), height: 44)
        erase.frame = CGRect(x: fieldPill.bounds.width - 13 - 26, y: 0, width: 30, height: 44)

        var y = header.frame.maxY
        if !error.isEmpty {
            let size = errorLabel.sizeThatFits(CGSize(width: width - 32, height: 200))
            errorLabel.frame = CGRect(x: 16, y: y, width: width - 32, height: ceil(size.height))
            errorLabel.isHidden = false
            y = errorLabel.frame.maxY + 8
        } else {
            errorLabel.isHidden = true
        }

        // The scopes ride on top of the keyboard (8 above it), else 8 above the bottom's safe edge.
        var widthSum: CGFloat = 0
        var sizes: [CGFloat] = []
        for button in scopeButtons {
            let text = button.title(for: .normal) ?? ""
            let words = ceil(NSAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: 14, weight: .bold)]).size().width)
            sizes.append(words + 32)
            widthSum += words + 32
        }
        let barWidth = min(width - 16, widthSum + 2 * CGFloat(max(0, scopeButtons.count - 1)) + 8)
        let floor = keyboardTop.map { $0 - 8 } ?? (view.bounds.height - view.safeAreaInsets.bottom - 8)
        scopeBar.frame = CGRect(x: (width - barWidth) / 2, y: floor - 42, width: barWidth, height: 42)
        scopeBar.shape(radius: 21)
        var x: CGFloat = 4
        for (index, button) in scopeButtons.enumerated() {
            button.frame = CGRect(x: x, y: 4, width: sizes[index], height: 34)
            x += sizes[index] + 2
        }

        table.frame = CGRect(x: 0, y: y, width: width, height: max(0, view.bounds.height - y))
        table.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: 90 + view.safeAreaInsets.bottom, right: 0)
        recentHead.frame = CGRect(x: 0, y: 0, width: width, height: 4 + 20 + 6)
        recentWords.frame = CGRect(x: 16, y: 4, width: width - 32 - 80, height: 20)
        recentClear.frame = CGRect(x: width - 16 - 80, y: 0, width: 80, height: 28)
        recentClear.contentHorizontalAlignment = .right
        let emptySize = emptyLabel.sizeThatFits(CGSize(width: width - 80, height: 400))
        emptyLabel.frame = CGRect(x: 40, y: y + 40, width: width - 80, height: ceil(emptySize.height))
        spinner.center = CGPoint(x: width / 2, y: y + 40)
    }

    @objc private func keyboardMoved(_ note: Notification) {
        guard let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let local = view.convert(frame, from: nil).minY
        keyboardTop = note.name == UIResponder.keyboardWillHideNotification || local >= view.bounds.height ? nil : local
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        UIView.animate(withDuration: duration, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    // MARK: Touches

    @objc private func closeNow() {
        view.endEditing(true)
        close(then: nil)
    }

    /// Leaves the search (the list and the bar come back), then runs `then`.
    private func close(then: (() -> Void)?) {
        view.endEditing(true)
        guard let stack = navigationController else { then?(); return }
        if stack.topViewController === self {
            stack.popViewController(animated: false)
        } else {
            stack.viewControllers = stack.viewControllers.filter { $0 !== self }
        }
        then?()
    }

    @objc private func eraseQuery() {
        field.text = ""
        typed()
    }

    @objc private func typed() {
        query = field.text ?? ""
        error = ""
        refresh()
        view.setNeedsLayout()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return false
    }

    @objc private func scopeTapped(_ sender: UIButton) {
        guard sender.tag < ChatSearchScreen.scopes.count else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        scope = ChatSearchScreen.scopes[sender.tag].scope
        showScopes()
        refresh()
    }

    private func showScopes() {
        for (index, button) in scopeButtons.enumerated() {
            let chosen = ChatSearchScreen.scopes[index].scope == scope
            button.titleLabel?.font = .systemFont(ofSize: 14, weight: chosen ? .bold : .medium)
            button.setTitleColor(chosen ? Theme.text : Theme.muted, for: .normal)
            button.backgroundColor = chosen ? Theme.accent.withAlphaComponent(0.14) : .clear
            button.accessibilityTraits = chosen ? [.button, .selected] : .button
        }
    }

    @objc private func channelsChanged() {
        if scope == .channels { refresh() }
    }

    // MARK: Recent

    private func loadRecent() {
        guard let raw = UserDefaults.standard.string(forKey: recentKey), let data = raw.data(using: .utf8),
              let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { recent = []; return }
        recent = Array(list.prefix(ChatSearchScreen.recentLimit))
    }

    private func saveRecent() {
        guard let data = try? JSONSerialization.data(withJSONObject: recent), let raw = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(raw, forKey: recentKey)
    }

    private static func recentId(_ item: [String: Any]) -> String {
        if item["kind"] as? String == "user" { return "u:" + (((item["user"] as? [String: Any])?["id"] as? String) ?? "") }
        return "c:" + (((item["community"] as? [String: Any])?["id"] as? String) ?? "")
    }

    private func remember(_ item: [String: Any]) {
        let id = ChatSearchScreen.recentId(item)
        recent = Array(([item] + recent.filter { ChatSearchScreen.recentId($0) != id }).prefix(ChatSearchScreen.recentLimit))
        saveRecent()
    }

    private func remember(person: Person) {
        let hex = String(format: "#%06X", Int(person.avatarColor & 0xFF_FFFF))
        remember(["kind": "user", "user": ["id": person.id, "displayName": person.displayName, "username": person.username, "avatarId": person.avatarId, "avatarColor": hex]])
    }

    private func remember(community: CommunitySummary) {
        remember(["kind": "community", "community": ["id": community.id, "name": community.name, "kind": community.kind, "avatarId": community.avatarId]])
    }

    @objc private func clearRecent() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        recent = []
        UserDefaults.standard.removeObject(forKey: recentKey)
        refresh()
    }

    // MARK: Opening

    private func person(of chat: Messenger.ChatSummary) -> Person {
        if let found = Person(chat.chat["peer"]) { return found }
        let color = UInt32(truncatingIfNeeded: (chat.row["avatarColor"] as? NSNumber)?.intValue ?? 0x4B73BB) & 0xFF_FFFF
        return Person(id: chat.peerId, username: "", displayName: chat.title, bio: "", birthday: "", avatarColor: color, avatarId: "")
    }

    private func open(person: Person) {
        remember(person: person)
        if let chat = chats.first(where: { $0.peerId == person.id }) {
            let id = chat.id
            let go = openChat
            close { go?(id, "") }
            return
        }
        let make = openPerson
        close { make?(person) }
    }

    private func open(community: CommunitySummary) {
        remember(community: community)
        let id = community.id
        let go = openCommunity
        close { go?(id) }
    }

    private func open(chatId: String, peer: Person, clientId: String) {
        remember(person: peer)
        let go = openChat
        close { go?(chatId, clientId) }
    }

    // MARK: The rows

    private var needle: String { query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    private static func snippet(_ text: String, _ needle: String) -> String {
        // A call's line reads without its emoji (ChatsPlus/ChatRowLooks.swift `withoutCallMark`).
        let flat = ChatRowLooks.withoutCallMark(text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " "))
        guard let found = flat.lowercased().range(of: needle) else { return String(flat.prefix(90)) }
        let at = flat.lowercased().distance(from: flat.lowercased().startIndex, to: found.lowerBound)
        if at > 24 { return "…" + String(flat.dropFirst(at - 20).prefix(90)) }
        return String(flat.prefix(90))
    }

    /// Whether a person's name or @имя holds the words (a leading «@» asks for the @имя as typed).
    static func matches(_ person: Person, _ wanted: String) -> Bool {
        var words = wanted.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if words.hasPrefix("@") { words.removeFirst() }
        guard !words.isEmpty else { return false }
        return (person.displayName + " " + person.username).lowercased().contains(words)
    }

    /// The people listed after the chats (the owner's report: people were not found in the search of the chats):
    /// first the friends whose name or @имя holds the words, then those the server's people search found (`/users`,
    /// from 2 letters), each once, without those who already have a chat here (they are listed as chats above) and
    /// without this account (the same rule as the Android app's ChatSearchScreen.morePeople).
    static func morePeople(_ wanted: String, chatPeers: Set<String>, friends: [Person], found: [Person]?, me: String?) -> [Person] {
        var made: [Person] = []
        var seen = chatPeers
        if let me { seen.insert(me) }
        for person in friends where matches(person, wanted) && seen.insert(person.id).inserted { made.append(person) }
        if wanted.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 {
            for person in found ?? [] where seen.insert(person.id).inserted { made.append(person) }
        }
        return made
    }

    private func refresh() {
        let wanted = needle
        var made: [Row] = []
        var loading = false
        if wanted.isEmpty {
            for item in recent {
                if item["kind"] as? String == "user", let fields = item["user"] as? [String: Any], let found = Person(fields) {
                    made.append(Row(key: ChatSearchScreen.recentId(item), title: found.displayName, sub: "@" + found.username, person: found, run: { [weak self] in self?.open(person: found) }))
                } else if let fields = item["community"] as? [String: Any], let id = fields["id"] as? String {
                    let name = fields["name"] as? String ?? ""
                    let kind = fields["kind"] as? String ?? "server"
                    let summary = ChannelsStore.shared.list?.first(where: { $0.id == id })
                        ?? CommunitySummary(id: id, kind: kind, category: "", closed: false, name: name, about: "", avatarId: fields["avatarId"] as? String ?? "", ownerId: "",
                                            memberCount: 0, isMember: true, perms: 0, lastText: "", muted: false, unread: 0, mentions: 0)
                    made.append(Row(key: ChatSearchScreen.recentId(item), title: name, sub: kind == "blog" ? "канал" : "сервер", community: summary, run: { [weak self] in self?.open(community: summary) }))
                }
            }
        } else {
            switch scope {
            case .chats:
                if "избранное".contains(wanted) {
                    made.append(Row(key: "saved", title: "Избранное", sub: "Заметки и сохранённое", saved: true, run: { [weak self] in
                        guard let self else { return }
                        let go = self.openSaved
                        self.close { go?() }
                    }))
                }
                for chat in chats {
                    let peer = person(of: chat)
                    if (peer.displayName + " " + peer.username).lowercased().contains(wanted) || ChatSearchScreen.matches(peer, wanted) {
                        made.append(Row(key: chat.id, title: peer.displayName, sub: peer.username.isEmpty ? "" : "@" + peer.username, person: peer, run: { [weak self] in self?.open(person: peer) }))
                    }
                }
                // People with no chat here yet: friends, then the server's people search (as the scope «Люди» finds them).
                if wanted.count >= 2 && peopleFor != wanted { askPeople(wanted) }
                let found = peopleFor == wanted ? people : nil
                for person in ChatSearchScreen.morePeople(wanted, chatPeers: Set(chats.map { $0.peerId }), friends: friendList, found: found, me: messenger?.userId) {
                    made.append(Row(key: "p:" + person.id, title: person.displayName, sub: person.username.isEmpty ? "" : "@" + person.username, person: person, run: { [weak self] in self?.open(person: person) }))
                }
                if wanted.count >= 2 && found == nil && messenger != nil { loading = true }
                // Words in the last message of each chat and in the notes of «Избранное» (both already decrypted here).
                if wanted.count >= 2 {
                    for chat in chats {
                        let line = chat.row["preview"] as? String ?? ""
                        guard !line.isEmpty, line.lowercased().contains(wanted) else { continue }
                        let peer = person(of: chat)
                        made.append(Row(key: "m:" + chat.id, title: peer.displayName, sub: ChatSearchScreen.snippet(line, wanted), person: peer, run: { [weak self] in self?.open(person: peer) }))
                    }
                    let notes = SavedMessages.shared(messenger)?.items ?? []
                    for item in notes.reversed() {
                        if made.count > 60 { break }
                        guard let text = item["text"] as? String, text.lowercased().contains(wanted) else { continue }
                        made.append(Row(key: "s:" + String(made.count), title: "Избранное", sub: ChatSearchScreen.snippet(text, wanted), saved: true, run: { [weak self] in
                            guard let self else { return }
                            let go = self.openSaved
                            self.close { go?() }
                        }))
                    }
                }
            case .messages:
                if hitsFor != wanted {
                    searchHistory(wanted)
                    loading = messenger != nil
                }
                var order: [String] = []
                var groups: [String: [Hit]] = [:]
                for hit in hits {
                    if groups[hit.chatId] == nil { order.append(hit.chatId) }
                    if (groups[hit.chatId]?.count ?? 0) < 30 { groups[hit.chatId, default: []].append(hit) }
                }
                for chatId in order {
                    guard let chat = chats.first(where: { $0.id == chatId }) else { continue }
                    let peer = person(of: chat)
                    made.append(Row(key: "h:" + chatId, title: peer.displayName, sub: "", person: peer, header: true, run: { [weak self] in self?.open(person: peer) }))
                    for hit in groups[chatId] ?? [] {
                        let who = hit.senderId == messenger?.userId ? "Ты" : peer.displayName
                        made.append(Row(key: "g:" + hit.chatId + ":" + hit.clientId, title: who, sub: ChatSearchScreen.snippet(hit.text, wanted), date: Messenger.listTime(hit.sentAt),
                                        run: { [weak self] in self?.open(chatId: hit.chatId, peer: peer, clientId: hit.clientId) }))
                    }
                }
            case .people:
                if wanted.count >= 2 {
                    if peopleFor != wanted { askPeople(wanted) }
                    // The chat partners and friends whose name or @имя holds the words first (the server finds a name
                    // only in full and an @имя from its first 4 letters), then the rest of what the server found, each once.
                    var seen = Set<String>()
                    if let me = messenger?.userId { seen.insert(me) }
                    let local = chats.map { person(of: $0) } + friendList
                    for found in local where ChatSearchScreen.matches(found, wanted) && seen.insert(found.id).inserted {
                        made.append(Row(key: found.id, title: found.displayName, sub: "@" + found.username, person: found, run: { [weak self] in self?.open(person: found) }))
                    }
                    if let people, peopleFor == wanted {
                        for found in people where seen.insert(found.id).inserted {
                            made.append(Row(key: found.id, title: found.displayName, sub: "@" + found.username, person: found, run: { [weak self] in self?.open(person: found) }))
                        }
                    } else {
                        loading = true
                    }
                }
            case .channels:
                if let list = ChannelsStore.shared.list {
                    for item in list where item.name.lowercased().contains(wanted) {
                        let sub = item.blog ? "канал · \(item.memberCount) подписч." : "сервер · \(item.memberCount) участн."
                        made.append(Row(key: item.id, title: item.name, sub: sub, community: item, run: { [weak self] in self?.open(community: item) }))
                    }
                } else {
                    loading = messenger != nil
                    ChannelsStore.shared.reload()
                }
            }
        }
        rows = made
        table.tableHeaderView = wanted.isEmpty && !made.isEmpty ? recentHead : nil
        if loading && made.isEmpty { spinner.startAnimating() } else { spinner.stopAnimating() }
        let emptyWords: String
        if !wanted.isEmpty {
            emptyWords = scope == .people && wanted.count < 2 ? "Введи хотя бы 2 буквы @имени." : scope == .messages ? "В сохранённой на этом устройстве переписке такого нет." : "Ничего не нашли."
        } else {
            emptyWords = scope == .messages ? "Поиск по тексту сообщений и имени отправителя. История хранится только на этом устройстве." : "Здесь появятся чаты и каналы, которые ты открывал из поиска."
        }
        emptyLabel.text = emptyWords
        emptyLabel.isHidden = !made.isEmpty || loading
        table.reloadData()
        view.setNeedsLayout()
    }

    /// «Люди»: the server's people search, 300 ms after the last letter.
    private func askPeople(_ wanted: String) {
        peopleFor = wanted
        people = nil
        peopleSoon?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.peopleFor == wanted else { return }
            guard let messenger = self.messenger else {
                #if targetEnvironment(simulator)
                self.people = ListPeopleSearch.samples.filter { ($0.displayName + " " + $0.username).lowercased().contains(wanted.replacingOccurrences(of: "@", with: "")) }
                self.refresh()
                #endif
                return
            }
            messenger.findPeople(wanted) { [weak self] (result: Result<[Person], ServerError>) -> Void in
                DispatchQueue.main.async {
                    guard let self, self.peopleFor == wanted else { return }
                    switch result {
                    case .success(let found): self.people = found
                    case .failure: self.people = []
                    }
                    self.refresh()
                }
            }
        }
        peopleSoon = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    /// «Сообщения»: the history kept on this device, newest first, without hidden messages and actions.
    private func searchHistory(_ wanted: String) {
        hitsFor = wanted
        hits = []
        historyRun += 1
        guard let messenger, wanted.count >= 1 else { return }
        let run = historyRun
        let known = Set(chats.map { $0.id })
        let hidden = Set(ChatLocal.of(messenger).hiddenKeys)
        let names: [String: String] = Dictionary(chats.map { ($0.id, $0.title.lowercased()) }, uniquingKeysWith: { (first: String, _: String) -> String in first })
        let me = messenger.userId
        messenger.crypto.run({ (crypto: CryptoService) -> [Hit] in
            var found: [Hit] = []
            guard case .success(let value) = crypto.callNow("historyChats"), let ids = value as? [String] else { return found }
            for chatId in ids where known.contains(chatId) {
                guard case .success(let page) = crypto.callNow("history", [chatId, 600]), let kept = page as? [[String: Any]] else { continue }
                for item in kept {
                    guard ChatHistory.action(item) == nil, let clientId = item["clientId"] as? String, !hidden.contains(ChatHistory.key(item)) else { continue }
                    let text = (item["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let file = (item["attachment"] as? [String: Any])?["name"] as? String ?? ""
                    let shown = text.isEmpty ? file : text
                    let sender = item["senderId"] as? String ?? ""
                    let senderName = sender == me ? "ты" : (names[chatId] ?? "")
                    guard !shown.isEmpty, shown.lowercased().contains(wanted) || senderName.contains(wanted) else { continue }
                    found.append(Hit(chatId: chatId, clientId: clientId, senderId: sender, text: shown, sentAt: item["sentAt"] as? String ?? ""))
                }
            }
            found.sort { $0.sentAt > $1.sentAt }
            return Array(found.prefix(150))
        }, done: { [weak self] (found: [Hit]) -> Void in
            guard let self, run == self.historyRun else { return }
            self.hits = found
            self.refresh()
        })
    }

    // MARK: The table

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        indexPath.row < rows.count && rows[indexPath.row].header ? 12 + 28 + 4 : 7 + 44 + 7
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        if let searchCell = cell as? ChatSearchCell, indexPath.row < rows.count {
            searchCell.show(rows[indexPath.row], address: messenger?.personAvatarAddress(rows[indexPath.row].person?.avatarId ?? "") ?? "")
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard indexPath.row < rows.count else { return }
        rows[indexPath.row].run()
    }
}

/// One row of the search: a 44 pt avatar (a person, a community, «Избранное» or a found message's bubble), the
/// name in 16 pt semibold and the line under it in 13 pt; a chat's heading over its found messages: a 28 pt
/// avatar and the name in 15 pt bold.
final class ChatSearchCell: UITableViewCell {
    private let personAvatar = PersonAvatarView()
    private let communityAvatar = CommunityAvatarView()
    private let badge = UIView()
    private let badgeIcon = UIImageView()
    private let title = UILabel()
    private let sub = UILabel()
    private let date = UILabel()
    private var isHeader = false

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        let pressed = UIView()
        pressed.backgroundColor = Theme.accent.withAlphaComponent(0.14)
        selectedBackgroundView = pressed
        contentView.addSubview(personAvatar)
        contentView.addSubview(communityAvatar)
        badge.layer.cornerRadius = 22
        badge.addSubview(badgeIcon)
        badgeIcon.contentMode = .center
        contentView.addSubview(badge)
        title.textColor = Theme.text
        contentView.addSubview(title)
        sub.font = .systemFont(ofSize: 13)
        sub.textColor = Theme.muted
        contentView.addSubview(sub)
        date.font = .systemFont(ofSize: 12)
        date.textColor = Theme.muted
        date.textAlignment = .right
        contentView.addSubview(date)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ row: ChatSearchScreen.Row, address: String) {
        isHeader = row.header
        title.text = row.title
        title.font = row.header ? .systemFont(ofSize: 15, weight: .bold) : .systemFont(ofSize: 16, weight: .semibold)
        sub.text = row.sub
        sub.isHidden = row.header
        date.text = row.date ?? ""
        date.isHidden = row.date == nil
        personAvatar.isHidden = true
        communityAvatar.isHidden = true
        badge.isHidden = true
        if row.date != nil {
            badge.isHidden = false
            badge.backgroundColor = Theme.accent.withAlphaComponent(0.14)
            badgeIcon.image = UIImage(systemName: "ellipsis.bubble", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular))
            badgeIcon.tintColor = Theme.accent
        } else if let person = row.person {
            personAvatar.isHidden = false
            personAvatar.show(person, address: address)
        } else if let community = row.community {
            communityAvatar.isHidden = false
            communityAvatar.show(community)
        } else {
            badge.isHidden = false
            badge.backgroundColor = Theme.accent
            badgeIcon.image = UIImage(systemName: "bookmark.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular))
            badgeIcon.tintColor = Theme.onAccent
        }
        accessibilityLabel = [row.title, row.sub, row.date ?? ""].filter { !$0.isEmpty }.joined(separator: ", ")
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width
        if isHeader {
            personAvatar.frame = CGRect(x: 16, y: 12, width: 28, height: 28)
            title.frame = CGRect(x: 16 + 28 + 10, y: 12, width: max(0, width - 54 - 16), height: 28)
            return
        }
        let box = CGRect(x: 16, y: 7, width: 44, height: 44)
        personAvatar.frame = box
        communityAvatar.frame = box
        badge.frame = box
        badgeIcon.frame = badge.bounds
        let textX = box.maxX + 12
        let dateWidth: CGFloat = date.isHidden ? 0 : ceil(date.sizeThatFits(CGSize(width: 120, height: 20)).width)
        title.frame = CGRect(x: textX, y: 9, width: max(0, width - textX - 16 - (dateWidth > 0 ? dateWidth + 5 : 0)), height: 21)
        date.frame = CGRect(x: width - 16 - dateWidth, y: 10, width: dateWidth, height: 18)
        sub.frame = CGRect(x: textX, y: 31, width: max(0, width - textX - 16), height: 17)
    }
}
