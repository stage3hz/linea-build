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
        // People: the number of requests to be friends on the row of «Люди» (People/PeopleServer.swift).
        NotificationCenter.default.addObserver(self, selector: #selector(peopleBadge), name: FriendRequests.changed, object: nil)
        FriendRequests.shared.start(messenger)
        // Channels: what is unread in the communities on the row of «Каналы» (Channels/ChannelsStore.swift).
        NotificationCenter.default.addObserver(self, selector: #selector(peopleBadge), name: ChannelsStore.changed, object: nil)
        ChannelsStore.shared.start(messenger)
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
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let gap = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom)
        bar.frame = CGRect(x: (view.bounds.width - BarMetrics.width) / 2, y: view.bounds.height - gap - BarMetrics.height, width: BarMetrics.width, height: BarMetrics.height)
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
        UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: {
            next.view.alpha = 1
            previous?.alpha = 0
        }, completion: { _ in
            if let previous, self.pages[self.open]?.view !== previous { previous.removeFromSuperview() }
        })
    }

    @objc private func peopleBadge() {
        bar.setItems(sections.map { TabEntry(id: $0.id, label: $0.label, symbol: $0.symbol, badge: $0.id == "people" ? FriendRequests.shared.incoming.count : ($0.id == "channels" ? ChannelsStore.shared.badge : 0), dot: $0.id == "channels" && Rooms.shared.awake ? RoomRules.talkHex : "") })
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
