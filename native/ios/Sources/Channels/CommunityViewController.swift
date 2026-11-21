import UIKit

/// The header of a community's screens: back, the community's picture (when asked), a name with a quiet line
/// under it, and a few icons on the right.
final class ChannelHeaderView: UIView {
    var onBack: () -> Void = {}
    /// The room above the header's content (the status bar).
    var safeTop: CGFloat = 0 { didSet { setNeedsLayout() } }
    var showsAvatar = false { didSet { avatar.isHidden = !showsAvatar; setNeedsLayout() } }
    let avatar = CommunityAvatarView()
    private let backButton = UIButton(type: .system)
    private let nameLabel = UILabel()
    private let quietLabel = UILabel()
    private var tools: [UIButton] = []
    private var toolActions: [() -> Void] = []

    static let height: CGFloat = 54

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Theme.bg.withAlphaComponent(0.94)
        backButton.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        backButton.tintColor = Theme.text
        backButton.accessibilityLabel = "Назад"
        backButton.addTarget(self, action: #selector(backPressed), for: .touchUpInside)
        addSubview(backButton)
        avatar.isHidden = true
        addSubview(avatar)
        nameLabel.font = .systemFont(ofSize: 17, weight: .bold)
        nameLabel.textColor = Theme.text
        nameLabel.accessibilityTraits = .header
        addSubview(nameLabel)
        quietLabel.font = .systemFont(ofSize: 12)
        quietLabel.textColor = Theme.muted
        addSubview(quietLabel)
    }

    required init?(coder: NSCoder) { return nil }

    func setWords(_ name: String, _ quiet: String) {
        nameLabel.text = name
        quietLabel.text = quiet
        setNeedsLayout()
    }

    /// The icons on the right, left to right.
    func setTools(_ items: [(symbol: String, label: String, action: () -> Void)]) {
        for button in tools { button.removeFromSuperview() }
        tools = []
        toolActions = []
        for (index, item) in items.enumerated() {
            let button = UIButton(type: .system)
            button.setImage(UIImage(systemName: item.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)), for: .normal)
            button.tintColor = Theme.text
            button.accessibilityLabel = item.label
            button.tag = index
            button.addTarget(self, action: #selector(toolPressed(_:)), for: .touchUpInside)
            addSubview(button)
            tools.append(button)
            toolActions.append(item.action)
        }
        setNeedsLayout()
    }

    @objc private func backPressed() { onBack() }

    @objc private func toolPressed(_ sender: UIButton) {
        if sender.tag >= 0 && sender.tag < toolActions.count { toolActions[sender.tag]() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let top = safeTop
        backButton.frame = CGRect(x: 6, y: top + 5, width: 44, height: 44)
        var left: CGFloat = 52
        if showsAvatar {
            avatar.frame = CGRect(x: left, y: top + 8, width: 38, height: 38)
            left += 38 + 10
        }
        var right = bounds.width - 6
        for button in tools.reversed() {
            button.frame = CGRect(x: right - 44, y: top + 5, width: 44, height: 44)
            right -= 44
        }
        let wide = max(0, right - left - 4)
        let alone = (quietLabel.text ?? "").isEmpty
        nameLabel.frame = CGRect(x: left, y: top + (alone ? 16 : 8), width: wide, height: 22)
        quietLabel.frame = CGRect(x: left, y: top + 30, width: wide, height: 16)
        quietLabel.isHidden = alone
    }
}

/// A community: for a game server — its channels in groups, with what is unread in each; for a blog channel —
/// its posts at once. The header leads to inviting and to the settings.
/// Reference: mobile/src/communities/CommunityScreen.tsx.
final class CommunityViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private let messenger: Messenger?
    private let communityId: String
    private var known: CommunitySummary?
    private var community: Community?
    private var groups: [(name: String, channels: [CommunityChannel])] = []
    private let header = ChannelHeaderView()
    private let table = UITableView(frame: .zero, style: .plain)
    private let about = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let notice = UIButton(type: .system)
    /// A blog channel is its posts: the chat of its only channel stands in place of the list.
    private var chat: ChannelChatViewController?
    private var inviting = false

    init(messenger: Messenger?, communityId: String, known: CommunitySummary?) {
        self.messenger = messenger
        self.communityId = communityId
        self.known = known
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
        table.rowHeight = 44
        table.estimatedRowHeight = 0
        table.sectionHeaderTopPadding = 0
        table.register(ChannelCell.self, forCellReuseIdentifier: "channel")
        table.dataSource = self
        table.delegate = self
        view.addSubview(table)
        about.font = .systemFont(ofSize: 14)
        about.textColor = Theme.muted
        about.numberOfLines = 0

        header.onBack = { [weak self] in self?.navigationController?.popViewController(animated: true) }
        header.showsAvatar = true
        view.addSubview(header)
        spinner.color = Theme.muted
        view.addSubview(spinner)
        notice.titleLabel?.font = .systemFont(ofSize: 13)
        notice.titleLabel?.numberOfLines = 0
        notice.titleLabel?.textAlignment = .center
        notice.setTitleColor(Theme.danger, for: .normal)
        notice.isHidden = true
        notice.addTarget(self, action: #selector(reload), for: .touchUpInside)
        view.addSubview(notice)

        if let known {
            header.avatar.show(known)
            header.setWords(known.name, known.countWords)
        } else {
            header.setWords("Загрузка…", "")
        }
        spinner.startAnimating()
        if messenger != nil {
            NotificationCenter.default.addObserver(self, selector: #selector(event(_:)), name: Live.communityEvent, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(countsChanged), name: ChannelsStore.changed, object: nil)
            reload()
        } else {
            #if targetEnvironment(simulator)
            if let sample = ChannelsDemo.community(communityId) { show(sample) }
            #endif
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top, width = view.bounds.width
        header.safeTop = top
        header.frame = CGRect(x: 0, y: 0, width: width, height: top + ChannelHeaderView.height)
        table.frame = view.bounds
        let insets = UIEdgeInsets(top: header.frame.maxY, left: 0, bottom: max(view.safeAreaInsets.bottom, 12) + 18, right: 0)
        if table.contentInset != insets {
            table.contentInset = insets
            table.contentOffset = CGPoint(x: 0, y: -insets.top)
        }
        placeAbout()
        spinner.center = CGPoint(x: width / 2, y: header.frame.maxY + 60)
        notice.frame = CGRect(x: 20, y: header.frame.maxY + 12, width: width - 40, height: 60)
        chat?.view.frame = view.bounds
    }

    private func placeAbout() {
        let words = community?.summary.about ?? ""
        let width = view.bounds.width
        guard !words.isEmpty, width > 0 else {
            if table.tableHeaderView != nil { table.tableHeaderView = nil }
            return
        }
        about.text = words
        let tall = ceil(about.sizeThatFits(CGSize(width: width - 40, height: 2000)).height)
        if let box = table.tableHeaderView, box.bounds.width == width, box.bounds.height == tall + 14, about.superview === box { return }
        let box = UIView(frame: CGRect(x: 0, y: 0, width: width, height: tall + 14))
        about.frame = CGRect(x: 20, y: 8, width: width - 40, height: tall)
        box.addSubview(about)
        table.tableHeaderView = box
    }

    // MARK: Reading

    @objc private func reload() {
        guard let messenger else { return }
        notice.isHidden = true
        messenger.server.ask("community", [communityId]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let body):
                guard let found = Community(body["community"]) else { return }
                ChannelsStore.shared.put(found.summary)
                ChannelsStore.shared.setChannels(found.id, found.channels)
                self.show(found)
            case .failure(let error):
                self.spinner.stopAnimating()
                if self.community == nil {
                    self.notice.setTitle(error.words + "\nКоснись, чтобы повторить.", for: .normal)
                    self.notice.isHidden = false
                }
            }
        }
    }

    private func show(_ found: Community) {
        community = found
        known = found.summary
        spinner.stopAnimating()
        notice.isHidden = true
        header.avatar.show(found.summary)
        header.setWords(found.summary.name, found.summary.countWords)
        var tools: [(symbol: String, label: String, action: () -> Void)] = []
        if found.can(Perm.invite) { tools.append((symbol: "person.badge.plus", label: "Пригласить", action: { [weak self] in self?.invite() })) }
        tools.append((symbol: "gearshape", label: "Настройки", action: { [weak self] in self?.openSettings() }))
        header.setTools(tools)
        if found.blog {
            showPosts(found, tools: tools)
            return
        }
        groups = found.groups
        table.reloadData()
        placeAbout()
    }

    /// A blog channel: the posts of its channel, under the community's own header.
    private func showPosts(_ found: Community, tools: [(symbol: String, label: String, action: () -> Void)]) {
        guard let channel = found.channels.first(where: { $0.isText }) else { return }
        if let chat {
            chat.update(found)
            chat.setTools(tools)
            return
        }
        let screen = ChannelChatViewController(messenger: messenger, community: found, channel: channel, root: true)
        screen.setTools(tools)
        addChild(screen)
        screen.view.frame = view.bounds
        view.addSubview(screen.view)
        screen.didMove(toParent: self)
        chat = screen
        table.isHidden = true
        header.isHidden = true
    }

    @objc private func countsChanged() {
        if community != nil, chat == nil { table.reloadData() }
    }

    @objc private func event(_ note: Notification) {
        guard let data = note.userInfo?["event"] as? [String: Any], let type = data["type"] as? String else { return }
        if type == "ready" { return reload() }
        var subject = data["communityId"] as? String
        if subject == nil { subject = (data["community"] as? [String: Any])?["id"] as? String }
        guard subject == communityId else { return }
        if type == "community.channels" || type == "community" {
            // A burst of events is one reading.
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(reload), object: nil)
            perform(#selector(reload), with: nil, afterDelay: 0.2)
        } else if type == "community.removed" {
            leave()
        }
    }

    /// The community is gone for this person (left, removed from it, deleted).
    private func leave() {
        guard let stack = navigationController, stack.viewControllers.contains(where: { $0 === self }) else { return }
        ChannelsRoute.closeCommunity(from: self)
    }

    // MARK: The header's icons

    private func invite() {
        guard let messenger, let community, !inviting else { return }
        inviting = true
        messenger.server.ask("createInvite", [community.id]) { [weak self] result in
            guard let self else { return }
            self.inviting = false
            switch result {
            case .success(let body):
                guard let code = (body["invite"] as? [String: Any])?["code"] as? String else { return }
                self.navigationController?.pushViewController(InviteSharePage(messenger: messenger, link: messenger.server.inviteAddress(code)), animated: true)
            case .failure(let error):
                self.say(error.words)
            }
        }
    }

    private func openSettings() {
        guard let community else { return }
        let page = CommunitySettingsPage(messenger: messenger, community: community)
        page.onChanged = { [weak self] changed in self?.show(changed) }
        page.onInvite = { [weak self] in self?.invite() }
        navigationController?.pushViewController(page, animated: true)
    }

    private func say(_ words: String) {
        let alert = UIAlertController(title: nil, message: words, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
        present(alert, animated: true)
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: opens the first text channel. False while the community is not read yet.
    func openFirstChannel() -> Bool {
        guard let community else { return false }
        // A blog channel is its posts already.
        if chat != nil { return true }
        guard let channel = community.channels.first(where: { $0.isText }) else { return true }
        navigationController?.pushViewController(ChannelChatViewController(messenger: messenger, community: community, channel: channel, root: false), animated: false)
        return true
    }
    #endif

    // MARK: The table

    func numberOfSections(in tableView: UITableView) -> Int { return groups.count }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { return groups[section].channels.count }

    func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat { return 36 }

    func tableView(_ tableView: UITableView, viewForHeaderInSection section: Int) -> UIView? {
        let box = UIView()
        box.backgroundColor = Theme.bg
        let label = UILabel(frame: CGRect(x: 20, y: 14, width: tableView.bounds.width - 40, height: 16))
        label.attributedText = NSAttributedString(string: groups[section].name.uppercased(), attributes: [.kern: 1.0, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        label.accessibilityTraits = .header
        box.addSubview(label)
        return box
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "channel", for: indexPath)
        if let row = cell as? ChannelCell {
            let channel = groups[indexPath.section].channels[indexPath.row]
            // Without an account (the simulator's samples) the counters are the channel's own.
            let counts = messenger == nil ? ChannelsStore.Counts(unread: channel.unread, mentions: channel.mentions, muted: false, communityId: communityId)
                : ChannelsStore.shared.counts(channel: channel.id)
            row.show(channel, unread: counts.unread, mentions: counts.mentions)
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let community else { return }
        let channel = groups[indexPath.section].channels[indexPath.row]
        if channel.isText {
            navigationController?.pushViewController(ChannelChatViewController(messenger: messenger, community: community, channel: channel, root: false), animated: true)
        } else {
            say("Голосовые каналы в этой версии приложения пока не работают.")
        }
    }
}

/// A channel in a community's list: bold with a dot while unread, a counter for @mentions, a lock when only
/// some roles see it; a voice channel shows how many people are in it.
final class ChannelCell: UITableViewCell {
    private let dot = UIView()
    private let icon = UIImageView()
    private let name = UILabel()
    private let lock = UIImageView()
    private let mentions = ChannelBadgeLabel()
    private let people = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        let pressed = UIView()
        pressed.backgroundColor = UIColor(white: 1, alpha: 0.07)
        selectedBackgroundView = pressed
        dot.backgroundColor = Theme.text
        dot.layer.cornerRadius = 2.5
        icon.contentMode = .center
        icon.tintColor = Theme.muted
        lock.image = UIImage(systemName: "lock.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .regular))
        lock.tintColor = Theme.subtle
        lock.contentMode = .center
        people.font = .systemFont(ofSize: 12)
        people.textColor = Theme.muted
        people.textAlignment = .right
        for part in [dot, icon, name, lock, mentions, people] as [UIView] { contentView.addSubview(part) }
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ channel: CommunityChannel, unread: Int, mentions count: Int) {
        let fresh = channel.isText && unread > 0
        dot.isHidden = !fresh
        icon.image = UIImage(systemName: channel.isText ? "ellipsis.bubble" : "speaker.wave.2.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .regular))
        name.text = channel.isText ? "# " + channel.name : channel.name
        name.font = .systemFont(ofSize: 16, weight: fresh ? .bold : .medium)
        name.textColor = channel.isText && !fresh ? Theme.muted : Theme.text
        lock.isHidden = channel.roleIds.isEmpty
        mentions.show(channel.isText ? ChannelWords.badge(count) : "")
        people.text = !channel.isText && channel.voiceCount > 0 ? "\(channel.voiceCount)/12" : ""
        var spoken = (channel.isText ? "Текстовый" : "Голосовой") + " канал " + channel.name
        if fresh { spoken += ", непрочитанных: \(unread)" }
        if count > 0 { spoken += ", упоминаний: \(count)" }
        accessibilityLabel = spoken
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width, height = contentView.bounds.height
        dot.frame = CGRect(x: 9, y: (height - 9) / 2, width: 5, height: 9)
        icon.frame = CGRect(x: 20, y: 0, width: 24, height: height)
        let room = width - 54 - 20 - (people.text?.isEmpty == false ? 50 : 0)
        let trail: CGFloat = (lock.isHidden ? 0 : 20) + (mentions.isHidden ? 0 : mentions.wide + 6)
        let wide = min(ceil(name.sizeThatFits(CGSize(width: 1000, height: 22)).width), max(0, room - trail))
        name.frame = CGRect(x: 54, y: 0, width: wide, height: height)
        var after = 54 + wide + 6
        if !lock.isHidden {
            lock.frame = CGRect(x: after, y: 0, width: 14, height: height)
            after += 20
        }
        if !mentions.isHidden {
            let badge = mentions.wide
            mentions.frame = CGRect(x: after, y: (height - 20) / 2, width: badge, height: 20)
        }
        people.frame = CGRect(x: width - 20 - 50, y: 0, width: 50, height: height)
    }
}
