import UIKit

/// The «Каналы» section: the person's game servers and blog channels with what is unread in them, a way to
/// create one and a way to join one by an invite link. Reference: mobile/src/communities/CommunitiesScreen.tsx.
final class ChannelsViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private let messenger: Messenger?
    // B: the reference's header (CommunitiesScreen.tsx): «Каналы» and «Комнаты, серверы и каналы» in a glass pill
    // (GlassSurface lens «clear», radius 27, 14 from the sides, 12 under the safe area, 10 inside, at least 64 tall),
    // with a round glass «Вступить по ссылке» and the accent round «Создать» (42) on the right.
    private let header = GlassHeaderView(title: "Каналы", subtitle: "Комнаты, серверы и каналы", titleSize: 26, lineHeight: 32,
                                         subtitleSize: 12, padding: 10, minHeight: 64, clear: true)
    private let table = UITableView(frame: .zero, style: .plain)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let notice = UIButton(type: .system)
    /// «Свои места для своих»: the reference's `Empty` with `planet-outline` and «Создать» (`add`).
    private let emptyState = EmptyStateView()
    private var sections: [(name: String, items: [CommunitySummary])] = []
    private var loaded = false
    /// Rooms: «Комнаты», the first thing in the section (Sources/Rooms/RoomsSectionView.swift).
    private let rooms = RoomsSectionView()
    /// Rooms: no communities and no failure — «Свои места для своих» is shown only when there are no rooms either.
    private var nothingListed = false

    init(messenger: Messenger? = nil) {
        self.messenger = messenger
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg

        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.showsVerticalScrollIndicator = false
        table.contentInsetAdjustmentBehavior = .never
        table.rowHeight = 70
        table.estimatedRowHeight = 0
        table.sectionHeaderTopPadding = 0
        table.register(CommunityCell.self, forCellReuseIdentifier: "community")
        table.dataSource = self
        table.delegate = self
        view.addSubview(table)
        // Rooms: above the communities, as the table's header; it says when its height changes.
        rooms.onResize = { [weak self] in self?.placeRooms() }
        table.tableHeaderView = rooms

        header.addTool(symbol: "link", label: "Вступить по ссылке", iconSize: 19) { [weak self] () -> Void in self?.join() }
        header.addTool(symbol: "plus", label: "Создать", filled: true) { [weak self] () -> Void in self?.create() }
        view.addSubview(header)

        spinner.color = Theme.muted
        view.addSubview(spinner)
        notice.titleLabel?.font = .systemFont(ofSize: 13)
        notice.titleLabel?.numberOfLines = 0
        notice.titleLabel?.textAlignment = .center
        notice.setTitleColor(Theme.danger, for: .normal)
        notice.isHidden = true
        notice.addTarget(self, action: #selector(retry), for: .touchUpInside)
        view.addSubview(notice)

        emptyState.show(symbol: "ion:planet-outline", title: "Свои места для своих", words: "Создай игровой сервер с текстовыми и голосовыми каналами или стандартный канал — блог, новости, музыку, что угодно.", button: "Создать", buttonSymbol: "ion:add") { [weak self] in self?.create() }
        emptyState.isHidden = true
        view.addSubview(emptyState)

        if messenger != nil {
            NotificationCenter.default.addObserver(self, selector: #selector(storeChanged), name: ChannelsStore.changed, object: nil)
            storeChanged()
        } else {
            #if targetEnvironment(simulator)
            show(ChannelsDemo.summaries(), failure: "")
            #else
            show([], failure: "")
            #endif
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Coming back from a community: its last message and counters may have changed.
        if loaded, messenger != nil { ChannelsStore.shared.reload() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top, width = view.bounds.width
        header.frame = CGRect(x: 14, y: top + 12, width: width - 28, height: 64)
        // Where the list starts: 10 under the pill (the rooms' caption carries its own room above it).
        let listTop = header.frame.maxY + 10
        table.frame = view.bounds
        let barRoom = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 12
        let insets = UIEdgeInsets(top: listTop, left: 0, bottom: barRoom, right: 0)
        if table.contentInset != insets {
            table.contentInset = insets
            table.contentOffset = CGPoint(x: 0, y: -insets.top)
        }
        placeRooms()
        showEmpty()
        spinner.center = CGPoint(x: width / 2, y: listTop + 83 + rooms.tall)
        notice.frame = CGRect(x: 20, y: listTop + 5 + rooms.tall, width: width - 40, height: 44)
        // Rooms: «Свои места для своих» stays under the rooms.
        // Centred in what the list leaves under the rooms (`flex: 1, justifyContent: center`).
        let emptyTop = listTop + rooms.tall
        emptyState.frame = CGRect(x: 12, y: emptyTop, width: width - 24, height: max(0, view.bounds.height - emptyTop - BarMetrics.height - BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom)))
    }

    /// Rooms: gives the section of rooms the height it asks for (the table reads its header's size when it is set).
    private func placeRooms() {
        let wanted = CGRect(x: 0, y: 0, width: table.bounds.width, height: rooms.tall)
        if rooms.frame.size != wanted.size {
            rooms.frame = wanted
            table.tableHeaderView = rooms
            view.setNeedsLayout()
        }
    }

    // MARK: What is shown

    @objc private func storeChanged() {
        let store = ChannelsStore.shared
        if let list = store.list {
            show(list, failure: store.failure)
        } else {
            // Not read yet: waiting, or the reason it could not be read.
            spinner.isHidden = !store.failure.isEmpty
            if store.failure.isEmpty { spinner.startAnimating() } else { spinner.stopAnimating() }
            showNotice(store.failure)
        }
    }

    private func showNotice(_ words: String) {
        notice.setTitle(words.isEmpty ? "" : words + "\nКоснись, чтобы повторить.", for: .normal)
        notice.isHidden = words.isEmpty
    }

    private func show(_ list: [CommunitySummary], failure: String) {
        loaded = true
        spinner.stopAnimating()
        showNotice(failure)
        let servers = list.filter { !$0.blog }, blogs = list.filter { $0.blog }
        var found: [(name: String, items: [CommunitySummary])] = []
        if !servers.isEmpty { found.append((name: "Игровые серверы", items: servers)) }
        if !blogs.isEmpty { found.append((name: "Каналы", items: blogs)) }
        sections = found
        table.reloadData()
        nothingListed = list.isEmpty && failure.isEmpty
        showEmpty()
    }

    /// Rooms: as in the reference, the call to create something gives way to the rooms when there are any.
    private func showEmpty() {
        let empty = nothingListed && (Rooms.shared.rooms?.isEmpty ?? true)
        emptyState.isHidden = !empty
    }

    @objc private func retry() {
        showNotice("")
        spinner.isHidden = false
        spinner.startAnimating()
        ChannelsStore.shared.reload()
    }

    // MARK: Create, join, open

    @objc private func create() {
        guard let messenger else { return }
        navigationController?.pushViewController(CommunityKindPage(messenger: messenger), animated: true)
    }

    @objc private func join() {
        guard let messenger else { return }
        navigationController?.pushViewController(CommunityJoinPage(messenger: messenger), animated: true)
    }

    private func open(_ community: CommunitySummary, animated: Bool = true) {
        navigationController?.pushViewController(CommunityViewController(messenger: messenger, communityId: community.id, known: community), animated: animated)
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: opens the first community of the list (a server when there is one).
    func openFirst() -> CommunityViewController? {
        guard let first = sections.first?.items.first else { return nil }
        let screen = CommunityViewController(messenger: messenger, communityId: first.id, known: first)
        navigationController?.pushViewController(screen, animated: false)
        return screen
    }

    /// For the simulator check: «Что создаём?» or «Вступить по ссылке».
    func simulatorForm(_ which: String) {
        if which == "create" { create() } else { join() }
    }
    #endif

    // MARK: The table

    func numberOfSections(in tableView: UITableView) -> Int { return sections.count }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { return sections[section].items.count }

    func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat { return 34 }

    func tableView(_ tableView: UITableView, viewForHeaderInSection section: Int) -> UIView? {
        let box = UIView()
        box.backgroundColor = Theme.bg
        let label = UILabel(frame: CGRect(x: 20, y: 10, width: tableView.bounds.width - 40, height: 18))
        label.attributedText = NSAttributedString(string: sections[section].name.uppercased(), attributes: [.kern: 1.2, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        label.accessibilityTraits = .header
        box.addSubview(label)
        return box
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "community", for: indexPath)
        if let row = cell as? CommunityCell {
            let community = sections[indexPath.section].items[indexPath.row]
            // Without an account (the simulator's samples) the counters are the summaries' own.
            let counts = messenger == nil ? ChannelsStore.Counts(unread: community.unread, mentions: community.mentions, muted: community.muted, communityId: community.id)
                : ChannelsStore.shared.counts(community: community.id)
            row.show(community, counts: counts)
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        open(sections[indexPath.section].items[indexPath.row])
    }
}

/// A community in the list: its picture, its name with the counters, the newest words.
final class CommunityCell: UITableViewCell {
    private let avatar = CommunityAvatarView()
    private let name = UILabel()
    private let words = UILabel()
    private let quiet = UIImageView()
    private let mentions = ChannelBadgeLabel()
    private let unread = ChannelBadgeLabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        let pressed = UIView()
        pressed.backgroundColor = Theme.veil(0.07)
        selectedBackgroundView = pressed
        name.font = .systemFont(ofSize: 16, weight: .semibold)
        name.textColor = Theme.text
        words.font = .systemFont(ofSize: 14)
        words.textColor = Theme.muted
        quiet.image = IonIcon.image("volume-mute", size: 14)
        quiet.tintColor = Theme.subtle
        quiet.contentMode = .center
        for part in [avatar, name, words, quiet, mentions, unread] as [UIView] { contentView.addSubview(part) }
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ community: CommunitySummary, counts: ChannelsStore.Counts) {
        avatar.show(community)
        name.text = community.name
        let last = community.lastText.replacingOccurrences(of: "\n", with: " ")
        words.text = !last.isEmpty ? last : (!community.about.isEmpty ? community.about : community.countWords)
        quiet.isHidden = !(counts.muted && counts.unread == 0)
        mentions.show(counts.mentions > 0 ? "@" : "", spoken: "упоминаний: \(counts.mentions)")
        unread.show(ChannelWords.badge(counts.unread), quiet: counts.muted, spoken: "непрочитанных: \(counts.unread)")
        accessibilityLabel = community.name
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width
        avatar.frame = CGRect(x: 20, y: 8, width: 54, height: 54)
        var right = width - 20
        if !unread.isHidden {
            let wide = unread.wide
            unread.frame = CGRect(x: right - wide, y: 15, width: wide, height: 20)
            right -= wide + 4
        }
        if !mentions.isHidden {
            mentions.frame = CGRect(x: right - 20, y: 15, width: 20, height: 20)
            right -= 24
        }
        if !quiet.isHidden {
            quiet.frame = CGRect(x: right - 18, y: 15, width: 18, height: 20)
            right -= 22
        }
        name.frame = CGRect(x: 86, y: 13, width: max(0, right - 86 - 4), height: 22)
        words.frame = CGRect(x: 86, y: 37, width: max(0, width - 86 - 20), height: 20)
    }
}
