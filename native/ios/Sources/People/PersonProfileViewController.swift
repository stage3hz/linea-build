import UIKit

/// A person's profile: the picture, the name, when they were in the line, the buttons («Написать», friends,
/// «Ещё») and the card with the @username, the birthday and «о себе». Ported from the reference's
/// UserProfile.tsx and ProfileInfo.tsx.
final class PersonProfileViewController: UIViewController, UIScrollViewDelegate {
    private let messenger: Messenger?
    private let userId: String
    private let name: String
    /// Not empty: the profile was opened from this chat (then there is no «Написать» — the chat is one step back).
    private let chatId: String

    private var person: Person?
    /// nil while the profile is being read.
    private var isFriend: Bool?
    /// "incoming", "outgoing" or nil.
    private var request: String?
    private var blocked = false
    private var busy = false
    private var copied = false
    private var copyTurn = 0
    private var noticeWords = ""
    private var problemWords = ""
    private var clock: Timer?

    private let scroll = UIScrollView()
    private let content = UIStackView()
    /// ChatLook: the person's light falling from the top (the reference's ProfileLight; Sources/ChatLook/PeerLight.swift).
    private var profileLight: ProfileLightView?
    private let topBar = UIView()
    private let back = UIButton(type: .system)
    private let more = UIButton(type: .system)
    // Profile: the top as the reference's UserProfile.tsx — banner / festive colour, the decorated avatar, the
    // platinum name and emoji status, the effect (Sources/Profile/ProfileHead.swift).
    private let hero = ProfileHeroView()
    private let topLayers = ProfileTopLayers()
    private let topShade = CAGradientLayer()
    private var avatar: DecoratedAvatarView { return hero.avatar }
    private let tiles = UIStackView()
    private let noticeLabel = UILabel()
    private let problemLabel = UILabel()
    private let cardBox = UIView()
    private let card = UIStackView()
    /// Stories: «Публикации» / «Истории» under the card and the ring around the picture (Sources/Stories/ProfilePosts.swift).
    private let postsBlock = ProfilePostsBlock(frame: .zero)
    /// Profile: the chat this profile was opened from — «Звук», «Поиск», the shared media and the chat's items of
    /// «Ещё» (Sources/Profile/ProfileChatExtras.swift). Nil: opened from elsewhere.
    var chatLink: ProfileChatLink?
    private let sharedMedia = SharedMediaView()

    /// `person`: what is already known about them (a row of a list), shown until the profile is read.
    init(messenger: Messenger?, userId: String, name: String, person: Person? = nil, chatId: String = "") {
        self.messenger = messenger
        self.userId = userId
        self.name = name
        self.person = person
        self.chatId = chatId
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        clock?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    private var fromChat: Bool { !chatId.isEmpty }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg

        topLayers.showsLight = false // Profile: ChatLook's light below is the page's light
        view.addSubview(topLayers.back)
        scroll.alwaysBounceVertical = true
        scroll.showsVerticalScrollIndicator = false
        scroll.delegate = self // Profile: the top follows the scroll
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        profileLight = ProfileLightView.install(in: view, color: 0x5E7BFF) // ChatLook
        content.axis = .vertical
        content.alignment = .fill
        content.spacing = 16
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(content)

        content.addArrangedSubview(hero) // Profile
        hero.avatarHolder.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(avatarTapped)))

        let tilesHolder = UIView()
        tiles.axis = .horizontal
        tiles.spacing = 10
        tiles.translatesAutoresizingMaskIntoConstraints = false
        tilesHolder.addSubview(tiles)
        content.addArrangedSubview(tilesHolder)

        noticeLabel.font = .systemFont(ofSize: 13)
        noticeLabel.textColor = Theme.accent
        noticeLabel.textAlignment = .center
        noticeLabel.numberOfLines = 0
        noticeLabel.isHidden = true
        content.addArrangedSubview(noticeLabel)
        problemLabel.font = .systemFont(ofSize: 14)
        problemLabel.textColor = Theme.danger
        problemLabel.textAlignment = .center
        problemLabel.numberOfLines = 0
        problemLabel.isHidden = true
        content.addArrangedSubview(problemLabel)

        cardBox.backgroundColor = Theme.surface2
        cardBox.layer.cornerRadius = 22
        cardBox.layer.cornerCurve = .continuous
        cardBox.clipsToBounds = true
        card.axis = .vertical
        card.translatesAutoresizingMaskIntoConstraints = false
        cardBox.addSubview(card)
        content.addArrangedSubview(cardBox)
        // Stories: the person's posts and stories.
        content.addArrangedSubview(postsBlock)
        postsBlock.attach(host: self, messenger: messenger, userId: userId, own: false, avatar: avatar)
        // Profile: «Фото · Видео · Файлы · Голосовые · Ссылки» of the chat (SharedMedia.tsx).
        content.addArrangedSubview(sharedMedia)
        sharedMedia.onOpen = { [weak self] (key: String, attachment: [String: Any]) -> Void in
            guard let self, let link = self.chatLink, !key.isEmpty else { return }
            link.openAttachment(key: key, attachment: attachment, from: self)
        }

        // Profile: the content scrolls under the floating back / «Ещё» row and dissolves there.
        topShade.colors = [Theme.bg.withAlphaComponent(0.92).cgColor, Theme.bg.withAlphaComponent(0).cgColor]
        topShade.opacity = 0
        topBar.layer.addSublayer(topShade)
        topBar.backgroundColor = .clear
        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topLayers.front)
        view.addSubview(topBar)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        back.tintColor = Theme.text
        back.accessibilityLabel = "Назад"
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        back.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(back)
        more.setImage(UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        more.tintColor = Theme.text
        more.accessibilityLabel = "Ещё"
        more.showsMenuAsPrimaryAction = true
        more.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(more)

        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor), // Profile
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 48 + 18), // Profile: under the floating row
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 18),
            content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -18),
            content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -36),

            tiles.centerXAnchor.constraint(equalTo: tilesHolder.centerXAnchor),
            tiles.topAnchor.constraint(equalTo: tilesHolder.topAnchor),
            tiles.bottomAnchor.constraint(equalTo: tilesHolder.bottomAnchor),
            tiles.leadingAnchor.constraint(greaterThanOrEqualTo: tilesHolder.leadingAnchor),

            card.topAnchor.constraint(equalTo: cardBox.topAnchor),
            card.bottomAnchor.constraint(equalTo: cardBox.bottomAnchor),
            card.leadingAnchor.constraint(equalTo: cardBox.leadingAnchor),
            card.trailingAnchor.constraint(equalTo: cardBox.trailingAnchor),

            topBar.topAnchor.constraint(equalTo: view.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topBar.bottomAnchor.constraint(equalTo: safe.topAnchor, constant: 48),
            back.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 6),
            back.bottomAnchor.constraint(equalTo: topBar.bottomAnchor, constant: -2),
            back.widthAnchor.constraint(equalToConstant: 44),
            back.heightAnchor.constraint(equalToConstant: 44),
            more.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -6),
            more.bottomAnchor.constraint(equalTo: topBar.bottomAnchor, constant: -2),
            more.widthAnchor.constraint(equalToConstant: 44),
            more.heightAnchor.constraint(equalToConstant: 44),
        ])

        if let messenger {
            messenger.preparePersonAvatars()
            NotificationCenter.default.addObserver(self, selector: #selector(presenceChanged), name: Live.presenceChanged, object: nil)
            messenger.personProfile(userId) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let profile):
                    self.person = profile.person
                    self.isFriend = profile.isFriend
                    self.request = profile.request
                    self.blocked = profile.blocked
                case .failure(let error):
                    self.problemWords = error.words
                }
                self.refresh()
            }
        } else {
            #if targetEnvironment(simulator)
            if person == nil { person = PeopleDemo.named(name) } // Profile: a sample person handed over keeps its decorations
            isFriend = PeopleDemo.friends.contains { $0.displayName == name }
            if PeopleDemo.incoming.contains(where: { $0.displayName == name }) { request = "incoming" }
            if PeopleDemo.outgoing.contains(where: { $0.displayName == name }) { request = "outgoing" }
            #endif
        }
        refresh()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refreshStatus()
        clock?.invalidate()
        // «был(а) 5 минут назад» grows old by itself.
        clock = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.refreshStatus() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        clock?.invalidate()
        clock = nil
    }

    @objc private func goBack() { navigationController?.popViewController(animated: true) }

    // MARK: Profile: the top follows the scroll

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutTop()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        topLayers.celebrate(in: view)
    }

    private func layoutTop() {
        let scrolled = scroll.contentOffset.y + scroll.adjustedContentInset.top
        let heroBottom = tiles.superview?.frame.maxY ?? hero.frame.maxY
        topLayers.layout(width: view.bounds.width, topInset: view.safeAreaInsets.top, scrolled: scrolled, heroBottom: heroBottom)
        hero.applyScroll(scrolled)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        topShade.frame = topBar.bounds
        topShade.opacity = Float(max(0, min(1, scrolled / 60)))
        CATransaction.commit()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { layoutTop() }

    /// A long pull opens the stories, or the photo and video full screen (as the reference).
    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        if scrollView.contentOffset.y + scrollView.adjustedContentInset.top < -110 { avatarTapped() }
    }

    @objc private func avatarTapped() {
        guard presentedViewController == nil else { return }
        if postsBlock.openStoriesIfAny() { return }
        let items = ProfileMediaViewer.items(shownPerson)
        guard !items.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        present(ProfileMediaViewer(person: shownPerson, base: messenger?.server.endpoint ?? ""), animated: true, completion: nil)
    }

    @objc private func presenceChanged() { refreshStatus() }

    // MARK: What is shown

    private var shownPerson: Person {
        person ?? Person(id: userId, username: "", displayName: name, bio: "", birthday: "", avatarColor: 0x5E7BFF, avatarId: "")
    }

    private func refreshStatus() {
        guard isViewLoaded else { return }
        var words: String? = nil
        if let messenger {
            words = PresenceWords.text(messenger.live.presence[userId])
        } else {
            #if targetEnvironment(simulator)
            words = "в сети"
            #endif
        }
        hero.setPresence(words) // Profile
    }

    private func refresh() {
        guard isViewLoaded else { return }
        let shown = shownPerson
        // Profile: the decorated top (banner, festive colour, effect, avatar, name, status).
        let base = messenger?.server.endpoint ?? ""
        topLayers.show(shown, base: base)
        hero.show(shown, base: base, presenceWords: hero.presence.text, tinted: topLayers.tinted)
        profileLight?.isHidden = shown.look.hasBanner || topLayers.tinted
        // ChatLook: the light in the colour of the person's photo, else of the colour they chose.
        profileLight?.color = LookColor.tint(avatarId: shown.avatarId, address: messenger?.personAvatarAddress(shown.avatarId) ?? "", chosen: shown.avatarColor)
        postsBlock.setColor(shown.avatarColor) // Stories: the ring is lit by the person's own colour
        refreshStatus()
        noticeLabel.text = noticeWords
        noticeLabel.isHidden = noticeWords.isEmpty
        problemLabel.text = problemWords
        problemLabel.isHidden = problemWords.isEmpty
        more.menu = moreMenu()
        more.isEnabled = !busy
        rebuildTiles()
        rebuildCard(shown)
        sharedMedia.show(chatLink?.messages ?? []) // Profile
    }

    private func makeTile(symbol: String, words: String, loading: Bool) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium))
        config.title = words
        config.imagePlacement = .top
        config.imagePadding = 6
        config.baseForegroundColor = Theme.text
        config.background.backgroundColor = Theme.surface2
        config.background.cornerRadius = 18
        config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 4, bottom: 8, trailing: 4)
        config.titleLineBreakMode = .byTruncatingTail
        config.showsActivityIndicator = loading
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { (incoming: AttributeContainer) -> AttributeContainer in
            var outgoing = incoming
            outgoing.font = UIFont.systemFont(ofSize: 12, weight: .semibold)
            return outgoing
        }
        let button = UIButton(configuration: config)
        button.isEnabled = !loading && !busy
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 104).isActive = true
        button.heightAnchor.constraint(equalToConstant: 66).isActive = true
        return button
    }

    private func rebuildTiles() {
        for old in tiles.arrangedSubviews {
            tiles.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        if !fromChat {
            let write = makeTile(symbol: "bubble.left.fill", words: "Написать", loading: false)
            write.addTarget(self, action: #selector(writeTapped), for: .touchUpInside)
            tiles.addArrangedSubview(write)
        }
        if fromChat {
            // Calls: opened from a chat, the row is «Звонок», «Видео», «Ещё», as in the reference (the friends
            // action is in «Ещё» then). Sources/Calls/CallOverlay.swift places the call.
            for video in [false, true] {
                let tile = makeTile(symbol: video ? "video.fill" : "phone.fill", words: video ? "Видео" : "Звонок", loading: false)
                tile.addAction(UIAction { [weak self] (_: UIAction) -> Void in
                    guard let self else { return }
                    CallEntry.call(messenger: self.messenger, chatId: self.chatId, peerId: self.userId, name: self.name, person: self.shownPerson, video: video)
                }, for: .touchUpInside)
                tiles.addArrangedSubview(tile)
            }
        } else {
            let symbol = isFriend == true ? "person.badge.minus" : request == "outgoing" ? "clock" : "person.badge.plus"
            let words = isFriend == true ? "В друзьях" : request == "outgoing" ? "Заявка" : request == "incoming" ? "Принять" : "В друзья"
            let friend = makeTile(symbol: symbol, words: words, loading: isFriend == nil && problemWords.isEmpty)
            if isFriend == nil { friend.isEnabled = false }
            friend.addTarget(self, action: #selector(friendTapped), for: .touchUpInside)
            tiles.addArrangedSubview(friend)
        }
        if let link = chatLink {
            // Profile: «Звук» / «Без звука» (with how long under it) and «Поиск», as the reference's row
            // «call · video · sound · search · more».
            let quiet = ProfileChatExtras.muted(link.settings)
            let sound = makeTile(symbol: quiet ? "bell.slash.fill" : "bell.fill", words: quiet ? "Без звука" : "Звук", loading: false)
            if var config = sound.configuration {
                if quiet {
                    config.baseForegroundColor = Theme.accent
                    config.subtitle = ProfileChatExtras.untilLabel(link.settings["mutedUntil"] as? String)
                    config.subtitleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { (incoming: AttributeContainer) -> AttributeContainer in
                        var outgoing = incoming
                        outgoing.font = UIFont.systemFont(ofSize: 10)
                        outgoing.foregroundColor = Theme.muted
                        return outgoing
                    }
                    config.titleAlignment = .center
                }
                sound.configuration = config
            }
            sound.addTarget(self, action: #selector(soundTapped), for: .touchUpInside)
            tiles.addArrangedSubview(sound)
            let search = makeTile(symbol: "magnifyingglass", words: "Поиск", loading: false)
            search.addAction(UIAction { [weak self] (_: UIAction) -> Void in
                guard let self, let link = self.chatLink else { return }
                link.openSearch(from: self)
            }, for: .touchUpInside)
            tiles.addArrangedSubview(search)
        }
        let other = makeTile(symbol: "ellipsis", words: "Ещё", loading: false)
        other.menu = moreMenu()
        other.showsMenuAsPrimaryAction = true
        tiles.addArrangedSubview(other)
        fitTiles() // Profile: up to five tiles share the row, as the reference's flex 1, at most 120 wide
    }

    private func moreMenu() -> UIMenu {
        var actions: [UIMenuElement] = []
        if fromChat, let friendNow = isFriend {
            let words = friendNow ? "Удалить из друзей" : request == "outgoing" ? "Отменить заявку" : request == "incoming" ? "Принять в друзья" : "Добавить в друзья"
            let symbol = friendNow ? "person.badge.minus" : "person.badge.plus"
            actions.append(UIAction(title: words, image: UIImage(systemName: symbol)) { [weak self] _ in self?.friendTapped() })
        }
        // Profile: the chat's own items, then «Очистить историю» apart with «Заблокировать» and «Пожаловаться».
        var tail: [UIMenuElement] = []
        if let link = chatLink {
            let items = ProfileChatExtras.menuItems(link, profile: self, name: shownPerson.displayName.isEmpty ? name : shownPerson.displayName) { [weak self] (words: String) -> Void in
                self?.say(notice: words)
                // The rule is folded into the history a moment later: the items' words follow it then.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.refresh() }
            }
            actions.append(contentsOf: items.top)
            tail.append(items.clear)
        }
        if blocked {
            actions.append(UIAction(title: "Разблокировать", image: UIImage(systemName: "hand.raised")) { [weak self] _ in self?.setBlocked(false) })
        } else {
            actions.append(UIAction(title: "Заблокировать", image: UIImage(systemName: "minus.circle"), attributes: .destructive) { [weak self] _ in self?.confirmBlock() })
        }
        actions.append(UIAction(title: "Пожаловаться", image: UIImage(systemName: "exclamationmark.triangle"), attributes: .destructive) { [weak self] _ in self?.report() })
        if chatLink != nil {
            // Profile: «Очистить историю» stands apart (the reference's `separated`); block and report follow it.
            let firstTail = actions.firstIndex { ($0 as? UIAction)?.title == "Разблокировать" || ($0 as? UIAction)?.title == "Заблокировать" } ?? actions.count
            let head = Array(actions[..<firstTail])
            tail.append(contentsOf: actions[firstTail...])
            return UIMenu(title: "", children: [UIMenu(title: "", options: .displayInline, children: head), UIMenu(title: "", options: .displayInline, children: tail)])
        }
        return UIMenu(title: "", children: actions)
    }

    // MARK: Profile: the row of tiles and the sound

    /// Up to five tiles share the row (the reference's `flex: 1, maxWidth: 120`): each as wide as the room allows.
    private func fitTiles() {
        let count = CGFloat(tiles.arrangedSubviews.count)
        guard count > 0 else { return }
        let room = max(200, view.bounds.width - 36)
        let each = min(104, floor((room - 10 * (count - 1)) / count))
        for tile in tiles.arrangedSubviews {
            for constraint in tile.constraints where constraint.firstAttribute == .width && constraint.secondItem == nil {
                constraint.constant = each
            }
        }
    }

    /// «Звук»: a chat without sound gets it back in one touch; otherwise the sheet asks for how long.
    @objc private func soundTapped() {
        guard let link = chatLink, !busy else { return }
        Haptic.light()
        if ProfileChatExtras.muted(link.settings) {
            changeSound(link, ["muted": false], ok: "Звук включён")
            return
        }
        let title = shownPerson.displayName.isEmpty ? name : shownPerson.displayName
        ProfileChatExtras.muteSheet(title: title, over: self) { [weak self] (until: String?) -> Void in
            guard let self else { return }
            if let until {
                self.changeSound(link, ["mutedUntil": until], ok: "Звук выключен " + ProfileChatExtras.untilLabel(until))
            } else {
                self.changeSound(link, ["muted": true], ok: "Звук выключен навсегда")
            }
        }
    }

    private func changeSound(_ link: ProfileChatLink, _ update: [String: Any], ok: String) {
        busy = true
        refresh()
        ProfileChatExtras.changeSound(link, messenger: messenger, update: update) { [weak self] (failure: String?) -> Void in
            guard let self else { return }
            self.busy = false
            if let failure { self.say(problem: failure) } else { self.say(notice: ok) }
        }
    }

    #if targetEnvironment(simulator)
    func simulatorSharedTab(_ tab: String) {
        if let chosen = SharedMediaView.Tab(rawValue: tab) { sharedMedia.select(chosen) }
        simulatorScrollToShared()
    }

    func simulatorScrollToShared() {
        view.layoutIfNeeded()
        let bottom = max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        let target = min(bottom, max(0, sharedMedia.frame.minY + content.frame.minY - 120))
        scroll.setContentOffset(CGPoint(x: 0, y: target), animated: false)
    }

    /// «Ещё» as a sheet of its items (a UIMenu cannot be opened by code): the same items, in order.
    func simulatorOpenMore() {
        let menu = moreMenu()
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        func walk(_ elements: [UIMenuElement]) {
            for element in elements {
                if let group = element as? UIMenu { walk(group.children) }
                if let action = element as? UIAction { sheet.addAction(UIAlertAction(title: action.title, style: action.attributes.contains(.destructive) ? .destructive : .default, handler: nil)) }
            }
        }
        walk(menu.children)
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        present(sheet, animated: false)
    }
    #endif

    private func hairline() -> UIView {
        let holder = UIView()
        let line = UIView()
        line.backgroundColor = Theme.veil(0.1)
        line.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(line)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 16),
            line.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -16),
            line.topAnchor.constraint(equalTo: holder.topAnchor),
            line.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            line.heightAnchor.constraint(equalToConstant: 1 / max(1, traitCollection.displayScale)),
        ])
        return holder
    }

    /// A row of the card: a small grey label above the value.
    private func infoRow(label: String, value: String, accent: Bool) -> UIStackView {
        let small = UILabel()
        small.text = label
        small.font = .systemFont(ofSize: 14)
        small.textColor = Theme.muted
        let big = UILabel()
        big.text = value
        big.font = .systemFont(ofSize: 17)
        big.textColor = accent ? Theme.accent : Theme.text
        big.numberOfLines = 0
        let row = UIStackView(arrangedSubviews: [small, big])
        row.axis = .vertical
        row.spacing = 2
        row.isLayoutMarginsRelativeArrangement = true
        row.layoutMargins = UIEdgeInsets(top: 11, left: 16, bottom: 11, right: 16)
        row.isAccessibilityElement = true
        row.accessibilityLabel = "\(label): \(value)"
        return row
    }

    private func rebuildCard(_ shown: Person) {
        for old in card.arrangedSubviews {
            card.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        if !shown.username.isEmpty {
            let row = infoRow(label: "имя пользователя", value: copied ? "Скопировано" : "@\(shown.username)", accent: true)
            row.accessibilityTraits = .button
            row.accessibilityHint = "Нажми, чтобы скопировать"
            row.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(copyUsername)))
            card.addArrangedSubview(row)
        }
        let birthday = shown.birthdayWords
        if !birthday.isEmpty {
            if !card.arrangedSubviews.isEmpty { card.addArrangedSubview(hairline()) }
            card.addArrangedSubview(infoRow(label: "день рождения", value: birthday, accent: false))
        }
        if !shown.bio.isEmpty {
            if !card.arrangedSubviews.isEmpty { card.addArrangedSubview(hairline()) }
            card.addArrangedSubview(infoRow(label: "о себе", value: shown.bio, accent: false))
        }
        if !card.arrangedSubviews.isEmpty { card.addArrangedSubview(hairline()) }
        let lock = UIImageView(image: UIImage(systemName: "lock.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .regular)))
        lock.tintColor = Theme.accent
        lock.setContentHuggingPriority(.required, for: .horizontal)
        lock.setContentCompressionResistancePriority(.required, for: .horizontal)
        let words = UILabel()
        words.text = "Переписка защищена сквозным шифрованием"
        words.font = .systemFont(ofSize: 12)
        words.textColor = Theme.muted
        words.numberOfLines = 0
        let secure = UIStackView(arrangedSubviews: [lock, words])
        secure.axis = .horizontal
        secure.alignment = .center
        secure.spacing = 8
        secure.isLayoutMarginsRelativeArrangement = true
        secure.layoutMargins = UIEdgeInsets(top: 11, left: 16, bottom: 11, right: 16)
        card.addArrangedSubview(secure)
        // Security: «Защита чата» — the safety codes of the devices to compare (Security/TrustSheet.swift).
        TrustSheet.attach(to: secure, words: words, from: self, messenger: messenger, peerId: userId)
    }

    // MARK: What the person does

    private func say(notice: String = "", problem: String = "") {
        noticeWords = notice
        problemWords = problem
        refresh()
    }

    /// As on the own profile in the reference: the row itself reads «Скопировано» for a moment.
    @objc private func copyUsername() {
        guard let username = person?.username, !username.isEmpty else { return }
        UIPasteboard.general.string = "@" + username
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        copied = true
        copyTurn += 1
        let turn = copyTurn
        refresh()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            guard let self, self.copyTurn == turn else { return }
            self.copied = false
            self.refresh()
        }
    }

    @objc private func writeTapped() {
        guard !busy else { return }
        guard let messenger else {
            #if targetEnvironment(simulator)
            navigationController?.pushViewController(ChatViewController(name: shownPerson.displayName), animated: true)
            #endif
            return
        }
        busy = true
        say()
        messenger.openChat(with: shownPerson, from: self) { [weak self] error in
            guard let self else { return }
            self.busy = false
            self.say(problem: error?.words ?? "")
        }
    }

    @objc private func friendTapped() {
        guard let friendNow = isFriend, !busy else { return }
        guard friendNow else { return toggleFriend() }
        // Removing a friend asks first.
        let sheet = UIAlertController(title: "Удалить \(shownPerson.displayName) из друзей?",
                                      message: "Публикации, истории и подарки друг друга вы больше не увидите. Заявку можно отправить снова.", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Удалить из друзей", style: .destructive) { [weak self] _ in self?.toggleFriend() })
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel))
        present(sheet, animated: true)
    }

    /// The one friends button of the reference (`toggleContact`): remove, take the request back, accept, or ask.
    private func toggleFriend() {
        guard let friendNow = isFriend, !busy else { return }
        guard let messenger else {
            #if targetEnvironment(simulator)
            if friendNow { isFriend = false; say(notice: "Удалён из друзей") }
            else if request == "outgoing" { request = nil; say(notice: "Заявка отменена") }
            else if request == "incoming" { request = nil; isFriend = true; say(notice: "Теперь вы друзья") }
            else { request = "outgoing"; say(notice: "Заявка отправлена") }
            #endif
            return
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        busy = true
        say()
        let finish: (ServerError?, String, () -> Void) -> Void = { [weak self] error, notice, apply in
            guard let self else { return }
            self.busy = false
            if let error {
                self.say(problem: error.words)
            } else {
                apply()
                self.say(notice: notice)
                FriendRequests.shared.refresh()
                // Stories: posts and stories are for friends — what may be seen has changed.
                self.postsBlock.reload()
            }
        }
        if friendNow {
            messenger.removeFriend(userId) { [weak self] error in finish(error, "Удалён из друзей") { self?.isFriend = false } }
        } else if request == "outgoing" {
            messenger.dropFriendRequest(userId) { [weak self] error in finish(error, "Заявка отменена") { self?.request = nil } }
        } else if request == "incoming" {
            messenger.acceptFriend(userId) { [weak self] error in
                finish(error, "Теперь вы друзья") {
                    self?.request = nil
                    self?.isFriend = true
                }
            }
        } else {
            messenger.addFriend(userId) { [weak self] result in
                switch result {
                case .failure(let error):
                    finish(error, "") { }
                case .success(let friends):
                    if friends {
                        finish(nil, "Теперь вы друзья") { self?.isFriend = true }
                    } else {
                        finish(nil, "Заявка отправлена") { self?.request = "outgoing" }
                    }
                }
            }
        }
    }

    private func confirmBlock() {
        let sheet = UIAlertController(title: "Заблокировать \(shownPerson.displayName)?", message: "Он не сможет писать и звонить тебе, пока ты не разблокируешь.", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Заблокировать", style: .destructive) { [weak self] _ in self?.setBlocked(true) })
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel))
        present(sheet, animated: true)
    }

    /// Blocking also ends the friendship and drops a request between the two (the server does; the screen follows).
    private func setBlocked(_ block: Bool) {
        guard !busy else { return }
        guard let messenger else {
            #if targetEnvironment(simulator)
            blocked = block
            if block { isFriend = false; request = nil }
            say(notice: block ? "Заблокирован: он не сможет тебе писать и звонить" : "Разблокирован")
            #endif
            return
        }
        busy = true
        say()
        messenger.setPersonBlocked(userId, block) { [weak self] error in
            guard let self else { return }
            self.busy = false
            if let error { return self.say(problem: error.words) }
            self.blocked = block
            if block {
                if self.isFriend != nil { self.isFriend = false }
                self.request = nil
                FriendRequests.shared.refresh()
            }
            self.say(notice: block ? "Заблокирован: он не сможет тебе писать и звонить" : "Разблокирован")
        }
    }

    private func report() {
        let sheet = ReportSheetViewController()
        sheet.onSend = { [weak self] reason in self?.sendReport(reason) }
        present(sheet, animated: true)
    }

    private func sendReport(_ reason: String) {
        guard !busy else { return }
        guard let messenger else {
            #if targetEnvironment(simulator)
            say(notice: "Жалоба отправлена. Спасибо!")
            #endif
            return
        }
        busy = true
        say()
        messenger.reportPerson(userId, reason: reason) { [weak self] error in
            guard let self else { return }
            self.busy = false
            if let error { self.say(problem: error.words) } else { self.say(notice: "Жалоба отправлена. Спасибо!") }
        }
    }
}

/// «Пожаловаться»: the reason is chosen, then sent. The reasons and the words are the reference's.
final class ReportSheetViewController: UIViewController {
    private static let reasons: [(id: String, label: String)] = [
        (id: "spam", label: "Спам"), (id: "scam", label: "Мошенничество"), (id: "abuse", label: "Оскорбления и травля"),
        (id: "violence", label: "Насилие"), (id: "sexual", label: "Откровенный контент"), (id: "illegal", label: "Незаконное"), (id: "other", label: "Другое"),
    ]

    /// Called with the chosen reason after the sheet has gone.
    var onSend: ((String) -> Void)?
    private var chosen = -1
    private var rows: [UIButton] = []
    private let sendButton = UIButton(type: .system)

    init() {
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            let tall = UISheetPresentationController.Detent.custom(resolver: { context -> CGFloat? in
                return min(600, context.maximumDetentValue)
            })
            sheet.detents = [tall]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 28
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = Theme.dark ? .dark : .light
        view.backgroundColor = Theme.page(UIColor(hex: 0x141516))

        let heading = UILabel()
        heading.text = "Пожаловаться"
        heading.font = Theme.title(Theme.TypeSize.sheetTitle) // Fonts
        heading.textColor = Theme.text
        let words = UILabel()
        words.text = "Переписка зашифрована: модератор увидит только причину и профиль, но не сообщения."
        words.font = .systemFont(ofSize: 13)
        words.textColor = Theme.muted
        words.numberOfLines = 0

        let stack = UIStackView(arrangedSubviews: [heading, words])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 6
        stack.setCustomSpacing(10, after: heading)
        stack.translatesAutoresizingMaskIntoConstraints = false

        for (index, reason) in ReportSheetViewController.reasons.enumerated() {
            var config = UIButton.Configuration.plain()
            config.title = reason.label
            config.image = UIImage(systemName: "circle")
            config.imagePadding = 12
            config.baseForegroundColor = Theme.text
            config.contentInsets = NSDirectionalEdgeInsets(top: 11, leading: 0, bottom: 11, trailing: 0)
            let row = UIButton(configuration: config)
            row.contentHorizontalAlignment = .leading
            row.tag = index
            row.addTarget(self, action: #selector(pick(_:)), for: .touchUpInside)
            rows.append(row)
            stack.addArrangedSubview(row)
        }

        var config = UIButton.Configuration.filled()
        config.title = "Отправить жалобу"
        config.baseBackgroundColor = Theme.accent
        config.baseForegroundColor = Theme.onAccent
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 15, leading: 16, bottom: 15, trailing: 16)
        sendButton.configuration = config
        sendButton.isEnabled = false
        sendButton.addTarget(self, action: #selector(sendNow), for: .touchUpInside)
        stack.addArrangedSubview(sendButton)
        if let last = rows.last { stack.setCustomSpacing(14, after: last) }

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 30),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -22),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -44),
        ])
    }

    @objc private func pick(_ sender: UIButton) {
        chosen = sender.tag
        for row in rows {
            let on = row.tag == chosen
            row.configuration?.image = UIImage(systemName: on ? "checkmark.circle.fill" : "circle")
            row.accessibilityTraits = on ? [.button, .selected] : .button
        }
        sendButton.isEnabled = true
    }

    @objc private func sendNow() {
        guard chosen >= 0, chosen < ReportSheetViewController.reasons.count else { return }
        let reason = ReportSheetViewController.reasons[chosen].id
        let send = onSend
        dismiss(animated: true) { send?(reason) }
    }
}
