import UIKit

/// The first section: the list of chats.
final class ChatsViewController: UIViewController {
    private let heading = UILabel()
    private let list = ChatListView()
    private let empty = UILabel()
    /// People: «Новый чат» opens the «Люди» section, as in the reference.
    private let newChat = UIButton(type: .system)
    /// The account whose chats are shown; nil shows the simulator's samples (or nothing on a phone).
    private let messenger: Messenger?
    private var summaries: [Messenger.ChatSummary] = []
    private var demo: [ChatRow] = []
    /// ChatActions: the buttons behind a row, the long-press choices, «Архив», drafts and the search
    /// (Sources/ChatActions/ChatListActions.swift).
    private lazy var actions = ChatListActions(messenger: messenger)
    /// Stories: the strip of stories above the chats (Sources/Stories/StoriesStrip.swift).
    private lazy var stories = StoriesStrip(messenger: messenger)
    /// ChatsPlus: the connection in the title, the line under it, the skeleton, the empty states, the folders and
    /// «Избранное» (Sources/ChatsPlus/ChatListPlus.swift).
    private lazy var plus = ChatListPlus(messenger: messenger)
    /// Offline: the list on screen came from the server at least once (until then it is the vault's copy).
    private var serverLoaded = false
    /// Offline: lines opened in the background since the rows were last shown (Sources/Offline/ListCatchUp.swift).
    private var opened: [(chatId: String, lastId: Int, line: [String: Any])] = []

    init(messenger: Messenger? = nil) {
        self.messenger = messenger
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        list.setPalette(Theme.chatList)
        view.addSubview(list)
        heading.text = "Чаты"
        heading.font = AppFont.title(Theme.TypeSize.chatsTitle) // Fonts
        heading.textColor = Theme.text
        view.addSubview(heading)
        newChat.setImage(UIImage(systemName: "square.and.pencil", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)), for: .normal)
        newChat.tintColor = Theme.onAccent
        newChat.backgroundColor = Theme.accent
        newChat.layer.cornerRadius = 22
        newChat.accessibilityLabel = "Новый чат"
        newChat.addTarget(self, action: #selector(openPeople), for: .touchUpInside)
        view.addSubview(newChat)
        empty.text = "Пока нет чатов"
        empty.font = .systemFont(ofSize: 17)
        empty.textColor = Theme.muted
        empty.textAlignment = .center
        view.addSubview(empty)
        // ChatActions: the rows are made there (swipe buttons, drafts, «Архив», what the search found) and come back here.
        actions.install(host: self, list: list)
        // ChatsPlus: hooked into the actions and the screen.
        actions.plus = plus
        plus.install(host: self, heading: heading, empty: empty, list: list, actions: actions)
        plus.onNewChat = { [weak self] in self?.openPeople() }
        actions.onRows = { [weak self] (rows: [ChatRow], emptyWords: String) -> Void in
            guard let self else { return }
            self.list.setRows(rows)
            self.empty.text = emptyWords
            self.empty.isHidden = !rows.isEmpty
            self.plus.rowsShown(rows, emptyWords: emptyWords) // ChatsPlus
        }
        actions.onHeading = { [weak self] (words: String) -> Void in
            self?.heading.text = words
            self?.view.setNeedsLayout() // Stories: the strip is not shown in «Архив»
        }
        actions.onReload = { [weak self] in self?.reload() }
        // Stories: the strip stands in the header, over the list.
        stories.install(host: self)
        list.onRowPress = { [weak self] event in
            guard let self, let id = event["id"] as? String else { return }
            // ChatActions: «Архив», a found message, and the chats of an account are opened there.
            if self.actions.pressed(id) { return }
            if let row = self.demo.first(where: { $0.id == id }) {
                self.navigationController?.pushViewController(ChatViewController(name: row.title), animated: true)
            }
        }
        if messenger != nil { NotificationCenter.default.addObserver(self, selector: #selector(changed), name: Messenger.changed, object: nil) }
        // Security: a notice that arrives while the list is open takes its room under the heading at once.
        NotificationCenter.default.addObserver(self, selector: #selector(noticesChanged), name: AccountNotices.changed, object: nil)
        if messenger == nil {
            #if targetEnvironment(simulator)
            demo = SimulatorDemo.chats()
            #endif
            list.setRows(demo)
            empty.isHidden = !demo.isEmpty
            #if targetEnvironment(simulator)
            // ChatActions: the samples as chats the actions can work on.
            actions.showSamples(demo)
            #endif
        } else {
            empty.text = "Загрузка…"
            // Offline: the list as it was shown last time, from the vault — at once, before (or without) the network.
            messenger?.cachedChats { [weak self] (cached: [Messenger.ChatSummary]) -> Void in
                guard let self, !self.serverLoaded, self.summaries.isEmpty, !cached.isEmpty else { return }
                self.summaries = cached
                self.actions.show(cached)
            }
        }
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// Something changed on the server: the list is read again (a burst of events is one reading).
    @objc private func changed() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(reloadSoon), object: nil)
        perform(#selector(reloadSoon), with: nil, afterDelay: 0.25)
    }

    @objc private func reloadSoon() { reload() }

    @objc private func noticesChanged() {
        guard isViewLoaded else { return }
        view.setNeedsLayout()
    }

    @objc private func openPeople() { (parent as? RootViewController)?.show("people") }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        reload()
    }

    #if targetEnvironment(simulator)
    func openFirst() {
        guard let chat = summaries.first, messenger != nil else { return }
        actions.open(chat.id, focus: "", animated: false)
    }
    #endif

    /// Asks the server for the chats again (on opening the screen and on coming back from a chat).
    func reload() {
        guard let messenger else { return }
        // Offline: a line already shown opened is never turned back into a closed one by a fresh list.
        var previous: [String: [String: Any]] = [:]
        for chat in summaries where !chat.last.isEmpty { previous[chat.id] = chat.last }
        messenger.chats(previous: previous) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let chats):
                self.serverLoaded = true
                self.plus.serverAnswered() // ChatsPlus
                self.summaries = chats
                AppBadge.shared.chats(chats) // Links: the number on the app's icon (Links/AppBadge.swift)
                // ChatActions: shown through `actions.onRows`.
                self.actions.show(chats)
                self.keepSoon()
                // Offline: the lines still closed are opened in the background, then shown.
                messenger.catchUpList(chats) { [weak self] (chatId: String, lastId: Int, line: [String: Any]) -> Void in
                    self?.lineOpened(chatId: chatId, lastId: lastId, line: line)
                }
            case .failure(let error):
                // Offline: the chats on screen (the vault's copy) stay; the words only when there is nothing to show.
                if self.summaries.isEmpty { self.empty.text = error.words; self.empty.isHidden = false }
                self.plus.serverFailed(error) // ChatsPlus
            }
        }
    }

    /// Offline: a closed line opened in the background; a burst of them is shown once.
    private func lineOpened(chatId: String, lastId: Int, line: [String: Any]) {
        opened.append((chatId: chatId, lastId: lastId, line: line))
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(showOpened), object: nil)
        perform(#selector(showOpened), with: nil, afterDelay: 0.2)
    }

    @objc private func showOpened() {
        guard let messenger, !opened.isEmpty else { return }
        let lines = opened
        opened = []
        var changed = false
        for item in lines {
            guard let index = summaries.firstIndex(where: { $0.id == item.chatId }) else { continue }
            let chat = summaries[index]
            // Only for the very message the line was opened for: a newer one may have come meanwhile.
            guard ((chat.chat["lastMessage"] as? [String: Any])?["id"] as? NSNumber)?.intValue == item.lastId,
                  let made = messenger.summary(chat.chat, shown: item.line, section: "") else { continue }
            summaries[index] = made
            changed = true
        }
        guard changed else { return }
        actions.show(summaries)
        keepSoon()
    }

    /// Offline: the list as shown goes to the vault a moment after it changes (only once the server answered,
    /// so an empty list at start never overwrites it).
    private func keepSoon() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(keepNow), object: nil)
        perform(#selector(keepNow), with: nil, afterDelay: 1.5)
    }

    @objc private func keepNow() {
        guard serverLoaded, let messenger else { return }
        messenger.storeChats(summaries)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top
        // ChatListScreen.tsx header: 6 above a title on a line of 36 (its middle 24 under the status bar); the round
        // buttons are 44, 16 from the side and 8 apart, at the middle of the title and the line under it together.
        heading.frame = CGRect(x: 20, y: top + 4, width: view.bounds.width - 40, height: 40)
        newChat.frame = CGRect(x: view.bounds.width - 16 - 44, y: top + 10, width: 44, height: 44)
        list.frame = view.bounds
        // Shell: the mini-player's room above the bar; ChatsPlus: the choosing bar's room while choosing chats.
        let barRoom = plus.listBottom(BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 12 + ShellInsets.miniPlayer, safeBottom: view.safeAreaInsets.bottom)
        // ChatActions: the search button beside «Новый чат»; the search field, when open, under the heading.
        let listTop = actions.place(in: view, safeTop: top)
        // ChatsPlus: the line under the title and the folder tabs take their room above the list.
        // Stories: the strip stands in the header, above the folders; not in «Архив», not while searching (the
        // search field takes room under the heading) and not while choosing chats.
        let storiesAllowed = heading.text == "Чаты" && listTop <= top + 58 && !plus.selecting
        let width = view.bounds.width
        let plusTop = plus.place(in: view, safeTop: top, listTop: listTop) { (y: CGFloat) -> CGFloat in
            self.stories.place(allowed: storiesAllowed, top: y, width: width)
        }
        // Security: «Новый вход» and «Запрос восстановления» under the heading (Security/AccountNotices.swift).
        let noticesEnd = AccountNotices.shared.place(in: view, top: plusTop, account: messenger != nil)
        list.setPad(top: Double(noticesEnd), bottom: Double(barRoom))
        plus.placeHeaderEdge(top: noticesEnd, width: view.bounds.width) // ChatsPlus: the floating header's edge
        newChat.isHidden = plus.selecting // ChatsPlus: «Выбрать» — «Новый чат» gives way
        empty.frame = CGRect(x: 20, y: view.bounds.midY - 12, width: view.bounds.width - 40, height: 24)
    }
}
