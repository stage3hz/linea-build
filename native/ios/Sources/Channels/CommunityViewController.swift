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

    /// The reference's header is a glass pill (GlassSurface lens, radius 27, margin 12 / 6 below, at least 60 tall).
    static let height: CGFloat = 78
    private let pill = GlassPill(interactive: false)
    /// The page fades in under the pill, so what scrolls up goes under the glass, not over the status bar.
    private let fade = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        fade.colors = [Theme.bg.cgColor, Theme.bg.cgColor, Theme.bg.withAlphaComponent(0).cgColor]
        fade.locations = [0, 0.45, 1]
        layer.addSublayer(fade)
        pill.shape(radius: 27)
        pill.isUserInteractionEnabled = false
        addSubview(pill)
        backButton.setImage(IonIcon.image("chevron-back", size: 23), for: .normal) // IconButton «chevron-back», 23
        backButton.tintColor = Theme.text
        backButton.accessibilityLabel = "Назад"
        backButton.addTarget(self, action: #selector(backPressed), for: .touchUpInside)
        addSubview(backButton)
        GlassBacking.put(under: backButton) // B: the reference's IconButton — a round of clear glass
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
            // The reference's IconButton glyph (23); a name of the icon set, else a system symbol.
            button.setImage(IonIcon.has(item.symbol) ? IonIcon.image(item.symbol, size: 23) : UIImage(systemName: item.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)), for: .normal)
            button.tintColor = Theme.text
            button.accessibilityLabel = item.label
            button.tag = index
            button.addTarget(self, action: #selector(toolPressed(_:)), for: .touchUpInside)
            addSubview(button)
            GlassBacking.put(under: button) // B
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
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fade.frame = bounds
        CATransaction.commit()
        // The pill: 12 from the edges and from the top of the safe area, 60 tall; its content 8 inside.
        pill.frame = CGRect(x: 12, y: safeTop + 12, width: max(0, bounds.width - 24), height: 60)
        let top = pill.frame.minY + 8
        backButton.frame = CGRect(x: pill.frame.minX + 8, y: top, width: 44, height: 44)
        var left: CGFloat = backButton.frame.maxX + 9
        if showsAvatar {
            avatar.frame = CGRect(x: left, y: top + 3, width: 38, height: 38)
            left += 38 + 9
        }
        var right = pill.frame.maxX - 8
        for button in tools.reversed() {
            button.frame = CGRect(x: right - 44, y: top, width: 44, height: 44)
            right -= 44 + 9 // B: `gap: 9`
        }
        let wide = max(0, right - left - 4)
        let alone = (quietLabel.text ?? "").isEmpty
        nameLabel.frame = CGRect(x: left, y: top + (alone ? 11 : 3), width: wide, height: 22)
        quietLabel.frame = CGRect(x: left, y: top + 25, width: wide, height: 16)
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
    private var groups: [(name: String, rows: [CommunityRow])] = []
    /// Voice channels: the people of the community by id (names and pictures of those inside a channel).
    private var people: [String: Person] = [:]
    private let voicePanel = CommunityVoicePanel()
    private var voiceError = ""
    /// The community this screen shows (the bar of a voice channel is not shown over it).
    var shownCommunityId: String { return communityId }
    private var me: String {
        #if targetEnvironment(simulator)
        if messenger == nil { return "demo-me" }
        #endif
        return messenger?.userId ?? ""
    }
    private let header = ChannelHeaderView()
    // Grouped: the section titles scroll with their channels (the reference's ScrollView); a plain table pins them
    // to the top, over the rows passing under it.
    private let table = UITableView(frame: .zero, style: .grouped)
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
        table.sectionFooterHeight = 0
        table.estimatedSectionFooterHeight = 0
        table.estimatedSectionHeaderHeight = 0
        table.tableHeaderView = UIView(frame: CGRect(x: 0, y: 0, width: 0, height: CGFloat.leastNonzeroMagnitude)) // no grouped top gap
        table.register(ChannelCell.self, forCellReuseIdentifier: "channel")
        table.register(VoiceMemberCell.self, forCellReuseIdentifier: "voiceMember")
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
            NotificationCenter.default.addObserver(self, selector: #selector(voiceEvent(_:)), name: Live.roomEvent, object: nil)
            reload()
            loadPeople()
        } else {
            #if targetEnvironment(simulator)
            if UserDefaults.standard.string(forKey: "channelsdemo")?.hasPrefix("voice") == true, let sample = ChannelsDemo.voiceCommunity(communityId) {
                for member in ChannelsDemo.members() { people[member.user.id] = member.user }
                people["demo-me"] = ChannelsDemo.meAsPerson()
                show(sample)
            } else if let sample = ChannelsDemo.community(communityId) { show(sample) }
            #endif
        }
        NotificationCenter.default.addObserver(self, selector: #selector(voiceChanged), name: RoomVoice.changed, object: nil)
        // ScreenShare: the panel's «Демонстрация экрана» part changes on its own (starting, error, screens): the card
        // is measured again so its height follows the content.
        NotificationCenter.default.addObserver(self, selector: #selector(voiceChanged), name: ScreenShare.changed, object: nil)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        RoomOverlay.shared.refresh()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        RoomOverlay.shared.refresh()
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
        if let footer = table.tableFooterView, footer.bounds.width != table.bounds.width { placeVoicePanel() }
        spinner.center = CGPoint(x: width / 2, y: header.frame.maxY + 60)
        notice.frame = CGRect(x: 20, y: header.frame.maxY + 12, width: width - 40, height: 60)
        chat?.view.frame = view.bounds
    }

    private func placeAbout() {
        let words = community?.summary.about ?? ""
        let width = view.bounds.width
        guard !words.isEmpty, width > 0 else {
            // Grouped: an empty header would leave the style's own gap on top.
            if (table.tableHeaderView?.bounds.height ?? 1) > 1 { table.tableHeaderView = UIView(frame: CGRect(x: 0, y: 0, width: 0, height: CGFloat.leastNonzeroMagnitude)) }
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
        if found.can(Perm.invite) { tools.append((symbol: "person-add-outline", label: "Пригласить", action: { [weak self] in self?.invite() })) }
        tools.append((symbol: "settings-outline", label: "Настройки", action: { [weak self] in self?.openSettings() }))
        header.setTools(tools)
        if found.blog {
            showPosts(found, tools: tools)
            return
        }
        regroup()
        placeAbout()
    }

    // MARK: Voice channels

    /// The rows: each channel, and under a voice channel the people inside it.
    private func regroup() {
        guard let community else { return }
        groups = community.groups.map { (group: (name: String, channels: [CommunityChannel])) -> (name: String, rows: [CommunityRow]) in
            var rows: [CommunityRow] = []
            for channel in group.channels {
                rows.append(.channel(channel))
                if !channel.isText {
                    for member in channel.voiceMembers { rows.append(.member(channel: channel, member: member)) }
                }
            }
            return (name: group.name, rows: rows)
        }
        table.reloadData()
        placeVoicePanel()
    }

    /// The people of the community (for the names under the voice channels).
    private func loadPeople() {
        guard let messenger else { return }
        messenger.server.ask("communityMembers", [communityId]) { [weak self] result in
            guard let self, case .success(let body) = result else { return }
            for member in CommunityMember.list(body["members"]) { self.people[member.user.id] = member.user }
            self.table.reloadData()
        }
    }

    /// `voice.state` of one of this community's channels: who is inside now.
    @objc private func voiceEvent(_ note: Notification) {
        guard let data = note.userInfo?["event"] as? [String: Any], data["type"] as? String == "voice.state",
              let channelId = data["channelId"] as? String, var found = community,
              let index = found.channels.firstIndex(where: { (item: CommunityChannel) -> Bool in item.id == channelId }) else { return }
        let members = CommunityVoiceMember.list(data["members"])
        found.channels[index].voiceMembers = members
        found.channels[index].voiceCount = members.count
        community = found
        regroup()
    }

    @objc private func voiceChanged() {
        placeVoicePanel()
        if community != nil, chat == nil { table.reloadData() }
    }

    /// The panel of the voice channel this phone is in — when it is one of this community's.
    private func placeVoicePanel() {
        guard let voice = RoomVoice.shared.state, voice.communityId == communityId else {
            if table.tableFooterView != nil { table.tableFooterView = nil }
            return
        }
        voicePanel.screenPanel.names = { [weak self] (userId: String) -> String? in self?.people[userId]?.displayName } // ScreenShare
        voicePanel.show(voice)
        let width = table.bounds.width > 0 ? table.bounds.width : view.bounds.width
        let box = table.tableFooterView ?? UIView()
        voicePanel.translatesAutoresizingMaskIntoConstraints = true
        if voicePanel.superview !== box { box.addSubview(voicePanel) }
        let tall = voicePanel.fittingHeight(width: width - 24)
        voicePanel.frame = CGRect(x: 12, y: 16, width: width - 24, height: tall)
        box.frame = CGRect(x: 0, y: 0, width: width, height: tall + 16 + 8)
        table.tableFooterView = box
    }

    private func enterVoice(_ channel: CommunityChannel) {
        guard let community else { return }
        if RoomVoice.shared.state?.roomId == channel.id { return }
        guard let messenger else { return }
        RoomVoice.shared.join(messenger, roomId: channel.id, name: channel.name, community: (id: community.id, name: community.summary.name)) { [weak self] (words: String?) -> Void in
            guard let self, let words else { return }
            self.say(words)
        }
    }

    private func memberActions(_ channel: CommunityChannel, _ member: CommunityVoiceMember, at indexPath: IndexPath) {
        guard let community, CommunityVoice.hasActions(community, me: me, userId: member.userId) else { return }
        var name = people[member.userId]?.displayName ?? "Участник"
        if name.isEmpty { name = "Участник" }
        let sheet = CommunityVoice.actions(community, me: me, member: member, name: name, messenger: messenger) { [weak self] (words: String) -> Void in
            self?.say(words)
        }
        if let pop = sheet.popoverPresentationController, let cell = table.cellForRow(at: indexPath) {
            pop.sourceView = cell
            pop.sourceRect = cell.bounds
        }
        present(sheet, animated: true)
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
    /// `-channelsdemo voicemenu`: the moderator's actions on the person whose microphone a moderator turned off.
    func simulatorVoiceMenu() {
        for (section, group) in groups.enumerated() {
            for (row, item) in group.rows.enumerated() {
                if case .member(let channel, let member) = item, member.serverMuted {
                    return memberActions(channel, member, at: IndexPath(row: row, section: section))
                }
            }
        }
    }

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

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { return groups[section].rows.count }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        if case .member = groups[indexPath.section].rows[indexPath.row] { return 32 }
        return 44
    }

    func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat { return 36 }

    func tableView(_ tableView: UITableView, heightForFooterInSection section: Int) -> CGFloat { return CGFloat.leastNonzeroMagnitude }

    func tableView(_ tableView: UITableView, viewForFooterInSection section: Int) -> UIView? { return nil }

    func tableView(_ tableView: UITableView, viewForHeaderInSection section: Int) -> UIView? {
        let box = UIView()
        box.backgroundColor = .clear // it scrolls with its rows now: nothing passes under it to hide
        let label = UILabel(frame: CGRect(x: 20, y: 14, width: tableView.bounds.width - 40, height: 16))
        label.attributedText = NSAttributedString(string: groups[section].name.uppercased(), attributes: [.kern: 1.0, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        label.accessibilityTraits = .header
        box.addSubview(label)
        return box
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let item = groups[indexPath.section].rows[indexPath.row]
        if case .member(_, let member) = item {
            let cell = tableView.dequeueReusableCell(withIdentifier: "voiceMember", for: indexPath)
            if let row = cell as? VoiceMemberCell, let community {
                let person = people[member.userId]
                let address = person.flatMap { (known: Person) -> String? in messenger?.personAvatarAddress(known.avatarId) } ?? ""
                row.show(member, person: person, me: me, address: address, actions: CommunityVoice.hasActions(community, me: me, userId: member.userId))
            }
            return cell
        }
        let cell = tableView.dequeueReusableCell(withIdentifier: "channel", for: indexPath)
        if let row = cell as? ChannelCell, case .channel(let channel) = item {
            // Without an account (the simulator's samples) the counters are the channel's own.
            let counts = messenger == nil ? ChannelsStore.Counts(unread: channel.unread, mentions: channel.mentions, muted: false, communityId: communityId)
                : ChannelsStore.shared.counts(channel: channel.id)
            row.show(channel, unread: counts.unread, mentions: counts.mentions)
            // Voice channels: the channel this phone is in, in green.
            row.showInside(!channel.isText && RoomVoice.shared.state?.roomId == channel.id)
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let community else { return }
        switch groups[indexPath.section].rows[indexPath.row] {
        case .member(let channel, let member):
            memberActions(channel, member, at: indexPath)
        case .channel(let channel):
            if channel.isText {
                navigationController?.pushViewController(ChannelChatViewController(messenger: messenger, community: community, channel: channel, root: false), animated: true)
            } else {
                enterVoice(channel)
            }
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
        // Pressed: the soft accent on a rounded row 12 in from the list's sides (radius 12).
        let pressed = UIView()
        let wash = UIView()
        wash.backgroundColor = ThemeStore.look.accentSoft
        wash.layer.cornerRadius = 12
        wash.layer.cornerCurve = .continuous
        wash.frame = CGRect(x: 12, y: 0, width: 100, height: 44)
        wash.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        pressed.addSubview(wash)
        selectedBackgroundView = pressed
        dot.backgroundColor = Theme.text
        dot.layer.cornerRadius = 3
        icon.contentMode = .center
        icon.tintColor = Theme.muted
        lock.image = IonIcon.image("lock-closed", size: 13)
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
        icon.image = IonIcon.image(channel.isText ? "chatbox-ellipses-outline" : "volume-medium", size: 19)
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
        // The row: 12 in from the list, paddingHorizontal 10, gap 10 — the icon (19), the name, the lock (13), the
        // counter; the unread dot 2 left of the row.
        if let wash = selectedBackgroundView?.subviews.first { wash.frame = CGRect(x: 12, y: 0, width: max(0, width - 24), height: height) }
        dot.frame = CGRect(x: 10, y: (height - 9) / 2, width: 5, height: 9)
        icon.frame = CGRect(x: 22, y: 0, width: 19, height: height)
        let peopleWide: CGFloat = people.text?.isEmpty == false ? ceil(people.sizeThatFits(CGSize(width: 100, height: 20)).width) + 10 : 0
        let room = width - 51 - 22 - peopleWide
        let trail: CGFloat = (lock.isHidden ? 0 : 13 + 10) + (mentions.isHidden ? 0 : mentions.wide + 10)
        let wide = min(ceil(name.sizeThatFits(CGSize(width: 1000, height: 22)).width), max(0, room - trail))
        name.frame = CGRect(x: 51, y: 0, width: wide, height: height)
        var after = 51 + wide + 10
        if !lock.isHidden {
            lock.frame = CGRect(x: after, y: 0, width: 13, height: height)
            after += 13 + 10
        }
        if !mentions.isHidden {
            let badge = mentions.wide
            mentions.frame = CGRect(x: after, y: (height - 20) / 2, width: badge, height: 20)
        }
        people.frame = CGRect(x: width - 22 - 50, y: 0, width: 50, height: height)
        insideTint.frame = CGRect(x: 12, y: 0, width: max(0, width - 24), height: height)
    }

    /// Voice channels: this phone is inside — a green wash, the icon and the name in green.
    private let insideTint = UIView()

    func showInside(_ inside: Bool) {
        if insideTint.superview == nil {
            insideTint.backgroundColor = CommunityVoice.green.withAlphaComponent(0.12)
            insideTint.layer.cornerRadius = 12
            insideTint.isUserInteractionEnabled = false
            contentView.insertSubview(insideTint, at: 0)
        }
        insideTint.isHidden = !inside
        if inside {
            icon.tintColor = CommunityVoice.green
            name.textColor = CommunityVoice.green
            name.font = .systemFont(ofSize: 16, weight: .bold)
        } else {
            icon.tintColor = Theme.muted
        }
    }
}
