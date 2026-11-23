import UIKit

/// ChatsPlus: what the reference's chat list (ChatListScreen.tsx) shows around the rows, for the list's screen
/// (Chats/ChatsViewController.swift) and its actions (ChatActions/ChatListActions.swift):
/// - the title with the state of the connection («Ожидание сети…» → «Соединение…» → «Обновление…» → «Чаты») and,
///   under it, how much is waiting («3 чата ждут ответа» / «всё прочитано»);
/// - the number on the «Чаты» tab (UnreadTotal);
/// - the skeleton rows until the first chats, and the empty states with their buttons;
/// - the folder tabs and the sideways swipe between folders (ChatFolders.swift);
/// - the «Избранное» row above the chats, its screen and its long-press menu (SavedMessages.swift).
/// Main queue only.
final class ChatListPlus: NSObject, UIGestureRecognizerDelegate {
    static let savedRow = "__saved"

    /// A chat as the actions see it: what counts towards the badges.
    struct Counted {
        let chat: Messenger.ChatSummary
        let unread: Int
        let marked: Bool
        let muted: Bool
        let archived: Bool
    }

    private let messenger: Messenger?
    private weak var host: UIViewController?
    private weak var heading: UILabel?
    private weak var oldEmpty: UILabel?
    private weak var list: ChatListView?
    private weak var actions: ChatListActions?

    private let subtitle = UILabel()
    private let status = UIView()
    private let statusSpinner = UIActivityIndicatorView(style: .medium)
    private let statusWords = UILabel()
    private let skeleton = ChatListSkeletonView()
    private let emptyState = EmptyStateView()
    private let tabs = FolderTabsView()
    private let folderSwipe = UIPanGestureRecognizer()
    /// «Выбрать» and the choosing of chats (ChatListEdit.swift).
    let edit: ChatListEdit
    /// People by @name in the search (ListExtras.swift).
    private let people: ListPeopleSearch
    /// «Архив» behind the pull (ListExtras.swift).
    private let archivePullView = ArchivePullView()
    /// The floating header: rows passing under the title, the search and the folders fade out (tabInset.tsx).
    private let headerEdge = ScrollEdgeView(edge: .top)
    /// Where on the screen the last hold on a row was (the peek card comes up from there).
    var holdY: CGFloat = 0

    private var serverLoaded = false
    private var hardError = false
    private var updating = false
    private var unreadChats = 0
    private var chatsOnScreen = 0
    private var savedOnScreen = false
    private var chats: [Messenger.ChatSummary] = []
    /// The folder shown: "all" or a folder's id.
    private(set) var filter = "all"
    /// «Новый чат» / «Найти собеседника»: the screen opens «Люди».
    var onNewChat: (() -> Void)?

    #if targetEnvironment(simulator)
    /// `-chatsdemo …`: what the simulator check wants to see (see `simulatorAct`).
    private let demo = UserDefaults.standard.string(forKey: "chatsdemo") ?? ""
    #endif

    init(messenger: Messenger?) {
        self.messenger = messenger
        edit = ChatListEdit(messenger: messenger)
        people = ListPeopleSearch(messenger: messenger)
        super.init()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var userKey: String { messenger?.userId ?? "sample" }
    private var folders: ChatFolderStore { ChatFolderStore.of(userKey) }

    // MARK: Setting up

    func install(host: UIViewController, heading: UILabel, empty: UILabel, list: ChatListView, actions: ChatListActions) {
        self.host = host
        self.heading = heading
        self.oldEmpty = empty
        self.list = list
        self.actions = actions
        // The reference's title face: Unbounded ExtraBold, 30 pt.
        heading.font = AppFont.title(30)
        heading.adjustsFontSizeToFitWidth = true
        heading.minimumScaleFactor = 0.7
        subtitle.font = AppFont.text(12.5)
        subtitle.textColor = Theme.muted
        host.view.addSubview(subtitle)
        statusSpinner.color = Theme.muted
        status.addSubview(statusSpinner)
        statusWords.font = AppFont.text(15, .semibold)
        statusWords.textColor = Theme.text
        status.addSubview(statusWords)
        status.isHidden = true
        status.isAccessibilityElement = true
        status.accessibilityTraits = .header
        host.view.addSubview(status)
        skeleton.backgroundColor = Theme.bg
        skeleton.setDark(Theme.dark)
        skeleton.isHidden = true
        host.view.addSubview(skeleton)
        emptyState.backgroundColor = Theme.bg
        emptyState.isHidden = true
        host.view.addSubview(emptyState)
        tabs.isHidden = true
        tabs.onChange = { [weak self] (id: String) -> Void in self?.choose(id) }
        tabs.onEdit = { [weak self] (folder: ChatFolder) -> Void in self?.editFolder(folder) }
        host.view.addSubview(tabs)
        // The floating header's edge: above the rows, under the title and the buttons.
        host.view.insertSubview(headerEdge, aboveSubview: list)
        edit.install(host: host, actions: actions)
        edit.onChange = { [weak self] in
            self?.actions?.redraw()
            self?.refreshTitle()
        }
        people.onChange = { [weak self] in self?.actions?.redraw() }
        archivePullView.addTarget(self, action: #selector(archivePulled), for: .touchUpInside)
        folderSwipe.addTarget(self, action: #selector(swiped(_:)))
        folderSwipe.delegate = self
        list.addGestureRecognizer(folderSwipe)
        MotionBlur.attach(list, following: folderSwipe) // MotionBlur: smeared along its move below 90 Hz (Effects/MotionBlur.swift)

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(lineChanged(_:)), name: Live.callEvent, object: nil)
        center.addObserver(self, selector: #selector(refreshTitle), name: NetworkWatch.changed, object: nil)
        center.addObserver(self, selector: #selector(foldersChanged), name: ChatFolderStore.changed, object: nil)
        center.addObserver(self, selector: #selector(savedChanged), name: SavedMessages.changed, object: nil)
        NetworkWatch.shared.start()
        if messenger == nil { serverLoaded = true }
        // The screen's own one-line «Загрузка…» / «Пока нет чатов» gives way to the skeleton and the empty states;
        // it comes back only for a real error (a refusal), as the reference's notice.
        empty.alpha = 0
        skeleton.isHidden = messenger == nil
        if let messenger { _ = SavedMessages.of(messenger) }
        #if targetEnvironment(simulator)
        simulatorPrepare()
        #endif
        refreshTitle()
    }

    /// Places the line under the title, the connection words, the folder tabs, the skeleton and the empty state;
    /// gives the top of the list. `listTop`: where the list would start without them.
    func place(in view: UIView, safeTop: CGFloat, listTop: CGFloat) -> CGFloat {
        let width = view.bounds.width
        let searching = listTop > safeTop + 60
        subtitle.frame = CGRect(x: 21, y: safeTop + 47, width: width - 42 - 96, height: 16)
        subtitle.isHidden = searching || !status.isHidden
        status.frame = CGRect(x: 20, y: safeTop + 8, width: width - 40 - 100, height: 41)
        statusSpinner.frame = CGRect(x: 0, y: 10, width: 20, height: 21)
        statusWords.frame = CGRect(x: 26, y: 0, width: status.bounds.width - 26, height: 41)
        var top = listTop + (searching ? 0 : 10)
        let showTabs = !folders.folders.isEmpty && !(actions?.showingArchive ?? false) && !searching
        tabs.isHidden = !showTabs
        if showTabs {
            tabs.frame = CGRect(x: 16, y: top, width: width - 32, height: 40)
            top += 48
        }
        edit.place(in: view, safeTop: safeTop, searchLeft: width - 20 - 40 - 8 - 40)
        let below = top + (savedOnScreen ? 76 : 0) + (actions?.showingArchive ?? false ? 76 : 0)
        let barRoom = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 12
        skeleton.frame = CGRect(x: 0, y: below, width: width, height: max(0, view.bounds.height - below))
        emptyState.frame = CGRect(x: 0, y: below, width: width, height: max(0, view.bounds.height - below - barRoom))
        return top
    }

    // MARK: What the actions tell

    /// Every chat of the list (not removed), with what counts: the tab's badge, the line under the title.
    func listed(_ items: [Counted]) {
        chats = items.map { $0.chat }
        var total = 0
        for item in items where !item.archived && !item.muted {
            // Messages count; a chat marked by hand adds one (App.tsx unreadTotal + markedExtra).
            total += item.unread > 0 ? item.unread : (item.marked ? 1 : 0)
        }
        UnreadTotal.shared.set(total)
    }

    /// Whether a chat stands in the folder shown (not in «Архив»).
    func keeps(_ chatId: String, unread: Bool) -> Bool {
        folders.matches(chatId: chatId, unread: unread, filter: filter)
    }

    /// The parts of the list («Сегодня», «Вчера»…) are shown only in «Все», and not while choosing chats.
    var showsSections: Bool { filter == "all" && !edit.selecting }

    // MARK: Choosing, the floating header, «Архив» behind the pull, people, the peek

    var selecting: Bool { edit.selecting }
    func isChosen(_ id: String) -> Bool { edit.isChosen(id) }
    func toggle(_ id: String) { edit.toggle(id) }

    /// The room the list keeps at its bottom: the bar's, or the choosing bar's while choosing.
    func listBottom(_ normal: CGFloat, safeBottom: CGFloat) -> CGFloat {
        return edit.selecting ? edit.listBottom(safeBottom: safeBottom) : normal
    }

    /// The edge under the floating header, as tall as the header (the status bar included).
    func placeHeaderEdge(top: CGFloat, width: CGFloat) {
        headerEdge.color = Theme.bg
        headerEdge.place(width: width, size: top)
    }

    /// «Архив» goes behind the pull in «Все» (not while searching or choosing). True: it is there, the actions must
    /// not add its row. `count`: the archived chats (0 takes it away).
    func archivePull(count: Int) -> Bool {
        guard count > 0, filter == "all", !edit.selecting else {
            list?.setPull(nil, height: 0)
            return false
        }
        archivePullView.set(count: count)
        list?.setPull(archivePullView, height: ArchivePullView.height)
        return true
    }

    @objc private func archivePulled() {
        _ = actions?.pressed(ChatListActions.archiveRow)
    }

    /// «Люди» under the chats the search found.
    func peopleRows(query: String) -> [[String: Any]] {
        return people.rows(query: query, known: Set(chats.map { $0.peerId }), me: messenger?.userId ?? "")
    }

    /// A touch on a person found by the search: the chat with them (the one there is, or a new one).
    func openPerson(_ rowId: String) {
        let personId = String(rowId.dropFirst("user|".count))
        if let chat = chats.first(where: { $0.peerId == personId }) {
            actions?.open(chat.id, focus: "")
            return
        }
        guard let host, let person = people.person(personId), let messenger else { return }
        host.view.endEditing(true)
        messenger.openChat(with: person, from: host) { [weak host] (error: ServerError?) -> Void in
            guard let error, let host else { return }
            let alert = UIAlertController(title: nil, message: error.words.isEmpty ? "Не удалось открыть чат." : error.words + " Нажми ещё раз, чтобы повторить.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
            host.present(alert, animated: true)
        }
    }

    /// The hold menu with the chat's card over it. False: it could not be shown (the caller shows its plain list).
    func presentPeek(chat: Messenger.ChatSummary, choices: [ChoiceSheet.Choice]) -> Bool {
        guard let host, host.presentedViewController == nil else { return false }
        let peer = chat.chat["peer"] as? [String: Any] ?? [:]
        var lines: [ChatPeekMenu.Line] = []
        #if targetEnvironment(simulator)
        if messenger == nil {
            lines = [ChatPeekMenu.Line(text: "Привет! Ты завтра свободна?", mine: false), ChatPeekMenu.Line(text: "Да, после обеда", mine: true),
                     ChatPeekMenu.Line(text: "Отлично, тогда в три у входа", mine: false), ChatPeekMenu.Line(text: "Договорились 👍", mine: true)]
        }
        #endif
        let card = ChatPeekMenu(anchorY: holdY, name: chat.title, username: peer["username"] as? String ?? "",
                                face: FolderChat(summary: chat), lines: lines, choices: choices)
        host.present(card, animated: true)
        if let messenger {
            ChatListPlus.peekLines(messenger: messenger, chatId: chat.id) { [weak card] (found: [ChatPeekMenu.Line]) -> Void in card?.setLines(found) }
        }
        return true
    }

    /// The chats shown in the list now: the line under the title counts those with unread messages.
    func shown(unread: Int) {
        unreadChats = unread
        refreshTitle()
    }

    /// The «Избранное» row (in «Все», not while searching unless the words fit «избранное»).
    func savedRow(query: String) -> [String: Any]? {
        guard filter == "all" else { return nil }
        let wanted = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard wanted.isEmpty || "избранное".contains(wanted) else { return nil }
        guard let saved = SavedMessages.shared(messenger) else { return nil }
        let last = saved.items.last
        var preview = "Заметки, файлы и сохранённые сообщения"
        var icon = ""
        var time = ""
        if let last {
            let line = SavedMessages.line(last)
            preview = line.text
            icon = line.icon
            time = Messenger.listTime(last["savedAt"] as? String)
        }
        return ["id": ChatListPlus.savedRow, "title": "Избранное", "preview": preview, "previewIcon": icon, "time": time, "unread": 0,
                "initials": "★", "avatarColor": ChatListPlus.argb(Theme.accent), "orbA": 0, "orbB": 0, "section": ""]
    }

    private static func argb(_ color: UIColor) -> Int {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        func byte(_ v: CGFloat) -> Int { Int((max(0, min(1, v)) * 255).rounded()) }
        return Int(0xFF00_0000) | byte(r) << 16 | byte(g) << 8 | byte(b)
    }

    /// The rows went on screen (after the screen's own handling): the skeleton until the first answer, then the
    /// empty state that fits.
    func rowsShown(_ rows: [ChatRow], emptyWords: String) {
        let special: Set<String> = [ChatListPlus.savedRow, ChatListActions.archiveRow, ChatListActions.backRow]
        let real = rows.filter { !special.contains($0.id) }.count
        let hadSaved = savedOnScreen
        chatsOnScreen = real
        savedOnScreen = rows.contains(where: { $0.id == ChatListPlus.savedRow })
        let query = actions?.searchWords ?? ""
        let archive = actions?.showingArchive ?? false
        var wantSkeleton = real == 0 && !serverLoaded && !hardError && messenger != nil && query.isEmpty
        var wantEmpty = !wantSkeleton && !hardError && real == 0 && emptyWords != "Поиск…" && (messenger != nil || query.isEmpty == false || archive || filter != "all")
        #if targetEnvironment(simulator)
        if demo == "skeleton" { wantSkeleton = true; wantEmpty = false }
        if demo == "empty" { wantSkeleton = false; wantEmpty = true }
        #endif
        skeleton.isHidden = !wantSkeleton
        emptyState.isHidden = !wantEmpty
        if wantEmpty {
            var forcedEmpty = false
            #if targetEnvironment(simulator)
            forcedEmpty = demo == "empty"
            #endif
            if !query.isEmpty && !forcedEmpty {
                emptyState.show(symbol: "magnifyingglass", title: "Чат не найден", words: "Попробуй другое имя или найди человека по @имени.", button: "Найти собеседника", action: { [weak self] in self?.onNewChat?() })
            } else if filter == "unread" {
                emptyState.show(symbol: "checkmark.circle", title: "Всё прочитано", words: "Здесь появятся чаты с новыми сообщениями и отмеченные как непрочитанные.")
            } else if (filter != "all" || archive) && !forcedEmpty {
                emptyState.show(symbol: "folder", title: "Здесь пока пусто", words: archive ? "В архиве нет чатов." : "В этой папке нет чатов. Добавь их в настройках папки.")
            } else {
                emptyState.show(symbol: "bubble.left.and.bubble.right", title: "Начни разговор", words: "Найди своего человека по @имени. Всё начинается с простого «привет».", button: "Найти собеседника", action: { [weak self] in self?.onNewChat?() })
            }
        }
        if hadSaved != savedOnScreen { host?.view.setNeedsLayout() }
    }

    /// The server answered the list: the skeleton may go, «Обновление…» is over.
    func serverAnswered() {
        serverLoaded = true
        updating = false
        refreshTitle()
    }

    /// The list could not be read. No network is not an error to show (the title says it); a refusal is.
    func serverFailed(_ error: ServerError) {
        updating = false
        switch error {
        case .network, .timeout:
            break
        case .refused:
            hardError = true
            skeleton.isHidden = true
            if chatsOnScreen == 0 { emptyState.isHidden = true; oldEmpty?.alpha = 1 }
        }
        refreshTitle()
    }

    // MARK: The title

    @objc private func lineChanged(_ note: Notification) {
        if let event = note.userInfo?["event"] as? [String: Any], event["type"] as? String == "ready" { updating = true }
        refreshTitle()
    }

    private var titleState: ChatListStatus.Title {
        #if targetEnvironment(simulator)
        switch demo {
        case "waiting": return .waiting
        case "connecting": return .connecting
        case "updating": return .updating
        default: break
        }
        #endif
        guard let messenger else { return .chats }
        return ChatListStatus.title(line: messenger.live.line, online: NetworkWatch.shared.online, updating: updating)
    }

    @objc private func refreshTitle() {
        let state = titleState
        let connecting = state != .chats
        status.isHidden = !connecting
        heading?.alpha = connecting ? 0 : 1
        statusWords.text = state.words
        status.accessibilityLabel = state.words
        if connecting { statusSpinner.startAnimating() } else { statusSpinner.stopAnimating() }
        subtitle.text = edit.selecting ? (edit.count > 0 ? "Выбрано: \(edit.count)" : "Отметь чаты") : ChatListStatus.unreadLine(unreadChats)
        subtitle.isHidden = connecting || (actions?.searchOpen ?? false)
    }

    // MARK: Folders

    @objc private func foldersChanged() {
        if filter != "all", !folders.folders.contains(where: { $0.id == filter }) { filter = "all" }
        tabs.set(folders: folders.folders, filter: filter)
        actions?.redraw()
        host?.view.setNeedsLayout()
    }

    private func choose(_ id: String) {
        guard id != filter else { return }
        filter = id
        tabs.set(folders: folders.folders, filter: filter)
        actions?.redraw()
    }

    private func editFolder(_ folder: ChatFolder?) {
        guard let host else { return }
        var listed = chats.map { FolderChat(summary: $0) }
        #if targetEnvironment(simulator)
        if messenger == nil { listed = ChatListPlus.sampleFolderChats() }
        #endif
        let editor = FolderEditorViewController(folder: folder, chats: listed)
        editor.onSave = { [weak self] (made: ChatFolder) -> Void in
            guard let self else { return }
            self.folders.upsert(made)
            self.choose(made.id)
        }
        editor.onDelete = { [weak self] (id: String) -> Void in self?.folders.remove(id) }
        host.present(editor, animated: true)
    }

    private var folderIndex: Int { max(0, folders.tabIds.firstIndex(of: filter) ?? 0) }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard recognizer === folderSwipe, let list, !tabs.isHidden else { return false }
        let ids = folders.tabIds
        guard ids.count > 1 else { return false }
        let speed = folderSwipe.velocity(in: list)
        guard abs(speed.x) > abs(speed.y) * 1.3 else { return false }
        // listSwipes.ts `rowClaimsSwipe`: from a row's edge its buttons slide out; from the middle the folder turns.
        let width = list.bounds.width
        let start = folderSwipe.location(in: list).x
        let edge = max(72, width * 0.25)
        let index = folderIndex
        if speed.x < 0 { return index < ids.count - 1 && start < width - edge }
        return index > 0 && start > edge
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    @objc private func swiped(_ recognizer: UIPanGestureRecognizer) {
        guard let list else { return }
        let ids = folders.tabIds
        let width = max(1, list.bounds.width)
        let moved = recognizer.translation(in: list).x
        let index = folderIndex
        let motion = !UIAccessibility.isReduceMotionEnabled
        switch recognizer.state {
        case .changed:
            tabs.follow(ChatListPlus.pagePosition(index, ids.count, moved, width), animated: false)
            let shift = motion ? moved * 0.3 : 0
            list.transform = CGAffineTransform(translationX: shift, y: 0)
            list.alpha = 1 - min(0.35, abs(shift) / 400)
        case .ended, .cancelled, .failed:
            let to = recognizer.state == .ended ? ChatListPlus.pageRelease(index, ids.count, moved, recognizer.velocity(in: list).x, width) : index
            UIView.animate(withDuration: motion ? 0.2 : 0, delay: 0, options: [.curveEaseOut], animations: {
                list.transform = .identity
                list.alpha = 1
            })
            tabs.follow(CGFloat(to), animated: motion)
            if to != index, to < ids.count {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                choose(ids[to])
            }
        default:
            break
        }
    }

    /// listSwipes.ts `pagePosition`: the fractional page under the finger, held back past the ends.
    static func pagePosition(_ index: Int, _ count: Int, _ translation: CGFloat, _ width: CGFloat) -> CGFloat {
        guard width > 0, count > 0 else { return CGFloat(index) }
        var p = CGFloat(index) - translation / width
        let last = CGFloat(count - 1)
        if p < 0 { p *= 0.2 } else if p > last { p = last + (p - last) * 0.2 }
        return max(CGFloat(index - 1), min(CGFloat(index + 1), p))
    }

    /// listSwipes.ts `pageRelease`: a quarter of the width or a flick (600 pt/s) turns one page, never past the ends.
    static func pageRelease(_ index: Int, _ count: Int, _ translation: CGFloat, _ velocity: CGFloat, _ width: CGFloat) -> Int {
        guard count > 1, width > 0 else { return index }
        let sign: (CGFloat) -> CGFloat = { (value: CGFloat) -> CGFloat in value > 0 ? 1 : (value < 0 ? -1 : 0) }
        let flickBack = translation != 0 && sign(velocity) != sign(translation) && abs(velocity) > 300
        var step = 0
        if !flickBack && (abs(translation) > width * 0.25 || abs(velocity) > 600) { step = translation < 0 || (translation == 0 && velocity < 0) ? 1 : -1 }
        return max(0, min(count - 1, index + step))
    }

    // MARK: «Избранное»

    @objc private func savedChanged() { actions?.redraw() }

    /// A touch on the «Избранное» row.
    func openSaved() {
        guard let host, let saved = SavedMessages.shared(messenger) else { return }
        host.view.endEditing(true)
        host.navigationController?.pushViewController(SavedViewController(messenger: messenger, saved: saved), animated: true)
    }

    /// A hold on «Избранное»: open it, or clear it completely (asked once more: it cannot be undone).
    func savedMenu() {
        guard let host, host.presentedViewController == nil else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let choices: [ChoiceSheet.Choice] = [
            ChoiceSheet.Choice(symbol: "bookmark", label: "Открыть", run: { [weak self] in self?.openSaved() }),
            ChoiceSheet.Choice(symbol: "trash", label: "Очистить Избранное", danger: true, run: { [weak self] in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self?.askClear() }
            }),
        ]
        host.present(ChoiceSheet(heading: "Избранное", choices: choices), animated: true)
    }

    private func askClear() {
        guard let host, let saved = SavedMessages.shared(messenger) else { return }
        let alert = UIAlertController(title: "Очистить Избранное?", message: "Все заметки, файлы и голосовые из Избранного будут удалены с этого устройства. Вернуть их нельзя.", preferredStyle: .alert)
        let wipe = UIAlertAction(title: "Удалить всё: \(saved.items.count)", style: .destructive, handler: { _ in saved.clear() })
        wipe.isEnabled = !saved.items.isEmpty
        alert.addAction(wipe)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        host.present(alert, animated: true)
    }

    // MARK: The simulator check

    #if targetEnvironment(simulator)
    static func sampleFolderChats() -> [FolderChat] {
        SimulatorDemo.chats().map { (row: ChatRow) -> FolderChat in
            let summary = Messenger.ChatSummary(id: row.id, peerId: "", title: row.title, peerLastRead: 0,
                                                row: ["avatarColor": row.avatarColor, "initials": row.initials])
            return FolderChat(summary: summary)
        }
    }

    /// `-chatsdemo …` with -demo 1 (no account) or with an account:
    ///   waiting | connecting | updating     the title in that state of the connection
    ///   skeleton | empty                    the skeleton rows / «Начни разговор»
    ///   folders | folder                    two sample folders: the tabs on «Все» / on the first folder
    ///   foldereditor | foldersettings       the editor of a new folder / Настройки → Папки с чатами
    ///   savedmenu | saved                   the hold menu of «Избранное» / the «Избранное» screen
    ///   select | mutecustom | archivepull   choosing with two chats marked / «Настроить…» of the sound / «Архив» pulled out
    private func simulatorPrepare() {
        guard !demo.isEmpty else { return }
        if demo == "folders" || demo == "folder" || demo == "foldersettings" {
            let store = folders
            if store.folders.isEmpty {
                store.upsert(ChatFolder(id: "fwork", name: "Работа", chatIds: ["demo-1", "demo-4", "demo-6"]))
                store.upsert(ChatFolder(id: "ffamily", name: "Семья", chatIds: ["demo-2", "demo-5"]))
            }
            if demo == "folder" { filter = "fwork" }
            tabs.set(folders: store.folders, filter: filter)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self, let host = self.host else { return }
            switch self.demo {
            case "foldereditor": self.editFolder(nil)
            case "foldersettings": host.navigationController?.pushViewController(FoldersSettingsPage(messenger: self.messenger), animated: false)
            case "savedmenu": self.savedMenu()
            case "select":
                // «Выбрать» with two chats marked: the round marks, «Выбрано: 2», the bar of actions.
                let ids = Array(self.chats.prefix(2).map { $0.id })
                self.edit.set(Set(ids))
            case "mutecustom":
                host.present(MuteCustomSheet(done: { (_: String) -> Void in }), animated: false)
            case "archivepull":
                self.list?.simulatorOpenPull()
            case "saved", "savedsearch": self.openSaved()
            default: break
            }
        }
    }
    #endif
}
