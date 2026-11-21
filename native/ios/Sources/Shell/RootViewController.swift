import UIKit

/// The app's shell: the sections one over another, and the bar at the bottom that chooses between them.
final class RootViewController: UIViewController {
    private struct Section { let id: String; let label: String; let symbol: String; let make: () -> UIViewController }

    /// The signed-in account; nil shows the shell with the simulator's samples.
    private let messenger: Messenger?

    init(messenger: Messenger? = nil) {
        self.messenger = messenger
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    private lazy var sections: [Section] = [
        Section(id: "chats", label: "Чаты", symbol: "message") { [messenger] in ChatsViewController(messenger: messenger) },
        Section(id: "ai", label: "AI", symbol: "sparkles") { [messenger] in AIViewController(messenger: messenger) },
        Section(id: "people", label: "Люди", symbol: "person.2") { [messenger] in PeopleViewController(messenger: messenger) },
        Section(id: "channels", label: "Каналы", symbol: "dot.radiowaves.left.and.right") { [messenger] in ChannelsViewController(messenger: messenger) },
        Section(id: "music", label: "Музыка", symbol: "headphones") { [messenger] in MusicViewController(messenger: messenger) },
        Section(id: "profile", label: "Настройки", symbol: "gearshape") { [messenger] in SettingsViewController(messenger: messenger) },
    ]
    /// The two sections that have an icon in the bar; the others are in the list under the first one.
    private let inBar = ["chats", "profile"]

    private let bar = TabBarView()
    /// ChatsPlus: «Удержи «Чаты» — остальные разделы» until the hold has been used (Sources/ChatsPlus/BarHint.swift).
    private let barHint = BarHintView()
    /// Shell: the mini-player over every section but «Музыка», the soft edges under the bar and under the status bar,
    /// and the bar giving way while the chat list chooses chats (Sources/Shell/PlayerStrips.swift, ScrollEdges.swift).
    private let miniHolder = UIView()
    private let mini = MiniPlayerView()
    private let barEdge = TabBarEdgeView()
    private let statusStrip = StatusStripView()
    private var barAway = false
    private let stage = UIView()
    private var pages: [String: UIViewController] = [:]
    private(set) var open = ""
    /// The section that was open when a preview from the list began: a cancelled list goes back to it.
    private var beforePreview: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        stage.frame = view.bounds
        stage.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(stage)
        bar.setItems(sections.map { TabEntry(id: $0.id, label: $0.label, symbol: $0.symbol, badge: 0, dot: "") })
        bar.setBar(inBar)
        bar.setDark(Theme.dark) // Settings: the theme that is on (Settings/ThemeStore.swift)
        #if targetEnvironment(simulator)
        // For choosing the glow on a screenshot: `-barlook 0…5`.
        if UserDefaults.standard.object(forKey: "barlook") != nil { bar.look = UserDefaults.standard.integer(forKey: "barlook") }
        #endif
        bar.moreWords = "Остальные разделы"
        bar.onSelect = { [weak self] event in
            guard let self, let id = event["id"] as? String else { return }
            self.beforePreview = nil
            self.show(id)
        }
        bar.onPreview = { [weak self] event in
            guard let self, let id = event["id"] as? String else { return }
            if id.isEmpty { if let back = self.beforePreview { self.beforePreview = nil; self.show(back) } }
            else { if self.beforePreview == nil { self.beforePreview = self.open }; self.show(id, quiet: true) }
        }
        view.addSubview(bar)
        show("chats")
        // Shell: the edges and the mini-player stand under the bar, over the sections; the update window over all.
        view.insertSubview(barEdge, belowSubview: bar)
        view.insertSubview(statusStrip, belowSubview: bar)
        mini.onOpen = { [weak self] in self?.openPlayer() }
        miniHolder.addSubview(mini)
        view.insertSubview(miniHolder, belowSubview: bar)
        NotificationCenter.default.addObserver(self, selector: #selector(refreshMini), name: MusicPlayer.changed, object: nil)
        refreshMini()
        UpdateGate.shared.start(messenger, host: self)
        // People: the number of requests to be friends on the row of «Люди» (People/PeopleServer.swift).
        NotificationCenter.default.addObserver(self, selector: #selector(peopleBadge), name: FriendRequests.changed, object: nil)
        FriendRequests.shared.start(messenger)
        // Channels: what is unread in the communities on the row of «Каналы» (Channels/ChannelsStore.swift).
        NotificationCenter.default.addObserver(self, selector: #selector(peopleBadge), name: ChannelsStore.changed, object: nil)
        ChannelsStore.shared.start(messenger)
        // ChatsPlus: the unread of the chats on «Чаты», and the words about the hold above the bar (Sources/ChatsPlus).
        NotificationCenter.default.addObserver(self, selector: #selector(peopleBadge), name: UnreadTotal.changed, object: nil)
        barHint.attach(to: view, bar: bar)
        // Music: the bar is lit by the playing track's cover (Music/CoverTint.swift).
        MusicGlow.attach(self)
        // Calls: the call screen and the bar of a minimised call, over every section (Calls/CallOverlay.swift).
        CallOverlay.shared.start(messenger)
        // Rooms: the list of rooms, the ring and the bar of the room this phone is in (Sources/Rooms); the quiet
        // dot on «Каналы» while somebody is inside one of them.
        NotificationCenter.default.addObserver(self, selector: #selector(peopleBadge), name: Rooms.changed, object: nil)
        Rooms.shared.start(messenger)
        RoomMusic.shared.start()
        RoomOverlay.shared.start()
        // Profile: Platina's state and its confetti, birthday reminders of friends, and the chat list's decorations
        // (Sources/Platina/PlatinaState.swift, Sources/Profile/Birthdays.swift, Sources/Avatars/ChatListDecor.swift).
        PlatinaState.shared.start(messenger, host: self)
        BirthdayReminders.shared.start(messenger)
        ChatListDecor.install()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let gap = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom)
        bar.frame = CGRect(x: (view.bounds.width - BarMetrics.width) / 2, y: view.bounds.height - gap - BarMetrics.height, width: BarMetrics.width, height: BarMetrics.height)
        barHint.place(above: bar.frame, width: view.bounds.width) // ChatsPlus
        layoutShell() // Shell
    }

    /// Opens a section. `quiet`: a look from the list — the bar's own choice stays where it is.
    func show(_ id: String, quiet: Bool = false) {
        guard id != open, let section = sections.first(where: { $0.id == id }) else { return }
        let next = pages[id] ?? section.make()
        if pages[id] == nil { pages[id] = next; addChild(next); next.didMove(toParent: self) }
        let previous = pages[open]?.view
        next.view.frame = stage.bounds
        next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        next.view.alpha = 0
        stage.addSubview(next.view)
        open = id
        if !quiet { bar.setActive(id) }
        refreshMini() // Shell: «Музыка» shows its own player
        UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: {
            next.view.alpha = 1
            previous?.alpha = 0
        }, completion: { _ in
            if let previous, self.pages[self.open]?.view !== previous { previous.removeFromSuperview() }
        })
    }

    @objc private func peopleBadge() {
        let requests: Int = FriendRequests.shared.incoming.count, unread: Int = ChannelsStore.shared.badge
        // Rooms: a quiet green dot on «Каналы» while somebody is inside one of the rooms.
        let roomsDot: String = Rooms.shared.awake ? RoomRules.talkHex : ""
        bar.setItems(sections.map { TabEntry(id: $0.id, label: $0.label, symbol: $0.symbol, badge: $0.id == "people" ? requests : ($0.id == "channels" ? unread : ($0.id == "chats" ? UnreadTotal.shared.total : 0)), dot: $0.id == "channels" ? roomsDot : "") })
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: the «Люди» section, once it has been opened.
    func peoplePage() -> PeopleViewController? { pages["people"] as? PeopleViewController }
    /// For the simulator check: the «Настройки» section, once it has been opened.
    func settingsPage() -> SettingsViewController? { pages["profile"] as? SettingsViewController }
    /// For the simulator check: the «Каналы» section, once it has been opened.
    func channelsPage() -> ChannelsViewController? { pages["channels"] as? ChannelsViewController }
    /// For the simulator check: the «Музыка» section, once it has been opened.
    func musicPage() -> MusicViewController? { pages["music"] as? MusicViewController }
    /// For the simulator check: opens the first chat of the list.
    func openFirstChat() { (pages["chats"] as? ChatsViewController)?.openFirst() }
    #endif

    /// Settings: the same shell built again, for a theme that has just been put on (Settings/ThemeStore.swift).
    func rebuilt() -> RootViewController { RootViewController(messenger: messenger) }

    // MARK: Shell — the mini-player, the edges, the bar giving way

    private func layoutShell() {
        let width = view.bounds.width, height = view.bounds.height
        let lift = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom)
        miniHolder.frame = CGRect(x: 12, y: bar.frame.minY - ShellInsets.miniGap - ShellInsets.miniHeight, width: width - 24, height: ShellInsets.miniHeight)
        mini.frame = miniHolder.bounds
        // The tab block: the pill, its 5 pt margin above, the mini-player when it is shown.
        let block = height - bar.frame.minY + 5 + ShellInsets.miniPlayer
        barEdge.place(width: width, height: height, block: block, lift: lift)
        statusStrip.place(width: width, safeTop: view.safeAreaInsets.top)
        // The hint about the hold stands above the whole block (above the mini-player when it is there).
        if !miniHolder.isHidden { barHint.place(above: miniHolder.frame, width: width) }
        view.bringSubviewToFront(miniHolder)
        view.bringSubviewToFront(bar)
        view.bringSubviewToFront(barHint)
    }

    /// The mini-player is shown while a track is chosen, everywhere but «Музыка» and while the bar is away; the
    /// sections are told the room it takes.
    @objc private func refreshMini() {
        let visible = !barAway && open != "music" && MusicPlayer.shared.current != nil
        miniHolder.isHidden = !visible
        let room: CGFloat = visible ? ShellInsets.miniHeight + ShellInsets.miniGap : 0
        guard room != ShellInsets.miniPlayer else { return }
        ShellInsets.miniPlayer = room
        for page in pages.values { page.viewIfLoaded?.setNeedsLayout() }
        view.setNeedsLayout()
        NotificationCenter.default.post(name: ShellInsets.changed, object: nil)
    }

    private func openPlayer() {
        guard presentedViewController == nil else { return }
        present(PlayerViewController(), animated: true)
    }

    /// The bar, its edge and the mini-player give way (the chat list while choosing chats: its own actions stand there).
    func setBarAway(_ away: Bool) {
        guard away != barAway else { return }
        barAway = away
        UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: {
            self.bar.alpha = away ? 0 : 1
            self.barEdge.alpha = away ? 0 : 1
            self.barHint.alpha = away ? 0 : 1
        })
        bar.isUserInteractionEnabled = !away
        refreshMini()
    }

    /// Music: three colours of the playing track's cover for the bar's light; an empty list restores the calm silver.
    func setBarGlow(_ hexes: [String]) { bar.setGlow(hexes) }

    /// The list of the sections without an icon (for a check on the simulator and for accessibility).
    func showSections() { bar.openList(sticky: true) }
}

/// A section that is not built yet: its name on the page, nothing else.
final class PlaceholderViewController: UIViewController {
    private let heading = UILabel()

    init(title: String) {
        super.init(nibName: nil, bundle: nil)
        heading.text = title
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        heading.font = .systemFont(ofSize: 34, weight: .bold)
        heading.textColor = Theme.text
        heading.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(heading)
        NSLayoutConstraint.activate([
            heading.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            heading.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
        ])
    }
}
