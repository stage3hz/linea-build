import UIKit

// «Публикации» and «Истории» on a profile (the reference's `PostsSection` in ProfilePosts.tsx): the photos and
// videos a person pinned to it, three in a row. Seen by friends only — or by everyone, when the person chose so in
// «Конфиденциальность» — and the server decides; a story is gone after 24 hours. On the person's own profile a
// button adds one and holding a tile removes it. A tap opens the viewer. The ring around the avatar says there
// are stories and opens them.
//
// The third tab, «Подарки», is Sources/Profile/Gifts.swift (`GiftsPanel`).

/// One tile of the grid. Its picture is asked for only when the tile comes near the screen.
final class StoryTileView: UIControl {
    private let picture = StoryPictureView(frame: .zero)
    private let playMark = UIImageView()
    private(set) var post: StoryPost?
    private var asked = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Theme.onBlack(UIColor(hex: 0x1A1D24), otherwise: Theme.surface2)
        clipsToBounds = true
        picture.contentMode = .scaleAspectFill
        picture.isUserInteractionEnabled = false
        addSubview(picture)
        playMark.image = IonIcon.image("play", size: 16)
        playMark.tintColor = .white
        playMark.contentMode = .center
        playMark.isUserInteractionEnabled = false
        addSubview(playMark)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.8 : 1 }
    }

    func show(_ next: StoryPost) {
        post = next
        asked = false
        playMark.isHidden = !next.isVideo
        accessibilityLabel = StoryRules.word(next.isVideo ? "video" : "photo")
    }

    func loadIfNeeded() {
        guard !asked, let post else { return }
        asked = true
        // One size for every tile, so a picture decoded once serves the grid on any phone.
        picture.show(post, pixels: 420)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = bounds
        playMark.frame = CGRect(x: bounds.width - 26, y: bounds.height - 26, width: 20, height: 20)
    }
}

final class ProfilePostsBlock: UIView {
    private weak var host: UIViewController?
    private var messenger: Messenger?
    private var userId = ""
    private var own = false
    private var data: ProfilePostsData?
    private var tab = "post"
    private var problem = ""
    private var tiles: [StoryTileView] = []
    private var publisher: StoryPublisher?
    private var heightRule: NSLayoutConstraint?
    private var watch: NSKeyValueObservation?
    private weak var scroller: UIScrollView?

    private let tabsBox = UIView()
    private let postsTab = UIButton(type: .system)
    private let storiesTab = UIButton(type: .system)
    // Gifts: the third tab and its panel (Sources/Profile/Gifts.swift).
    private let giftsTab = UIButton(type: .system)
    private let giftsPanel = GiftsPanel(frame: .zero)
    private var giftCount = 0
    private let problemLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let lockIcon = UIImageView()
    private let lockLabel = UILabel()
    private let addButton = UIButton(type: .system)
    private let grid = UIView()
    private let emptyEmoji = UILabel()
    private let emptyHeading = UILabel()
    private let emptyHint = UILabel()
    private let emptyButton = UIButton(type: .system)
    private let ring = StoryRingView(frame: .zero)
    private let ringButton = UIButton(type: .custom)
    private var ringColor: UInt32 = 0x5E7BFF

    override init(frame: CGRect) {
        super.init(frame: frame)
        tabsBox.backgroundColor = Theme.surface2
        tabsBox.layer.cornerRadius = 23
        tabsBox.layer.cornerCurve = .continuous
        addSubview(tabsBox)
        for (button, name) in [(postsTab, "post"), (storiesTab, "story"), (giftsTab, "gift")] {
            button.layer.cornerRadius = 19
            button.layer.cornerCurve = .continuous
            button.accessibilityIdentifier = name
            button.addTarget(self, action: #selector(tabPressed(_:)), for: .touchUpInside)
            tabsBox.addSubview(button)
        }
        // Gifts
        giftsPanel.isHidden = true
        addSubview(giftsPanel)
        giftsPanel.onHeight = { [weak self] in self?.setNeedsLayout() }
        giftsPanel.onCount = { [weak self] (count: Int) -> Void in
            guard let self, self.giftCount != count else { return }
            self.giftCount = count
            self.rebuild()
        }
        problemLabel.font = .systemFont(ofSize: 14)
        problemLabel.textColor = Theme.danger
        problemLabel.textAlignment = .center
        problemLabel.numberOfLines = 0
        addSubview(problemLabel)
        spinner.color = Theme.muted
        spinner.hidesWhenStopped = true
        addSubview(spinner)
        lockIcon.image = IonIcon.image("lock-closed-outline", size: 22)
        lockIcon.tintColor = Theme.muted
        lockIcon.contentMode = .center
        addSubview(lockIcon)
        lockLabel.text = StoryRules.word("hidden")
        lockLabel.font = .systemFont(ofSize: 14)
        lockLabel.textColor = Theme.muted
        lockLabel.textAlignment = .center
        lockLabel.numberOfLines = 0
        addSubview(lockLabel)

        var addLook = UIButton.Configuration.filled()
        addLook.baseBackgroundColor = Theme.surface2
        addLook.baseForegroundColor = Theme.accent
        addLook.cornerStyle = .capsule
        addLook.image = IonIcon.image("add", size: 18)
        addLook.imagePadding = 6
        addButton.configuration = addLook
        addButton.addTarget(self, action: #selector(addPressed), for: .touchUpInside)
        addSubview(addButton)
        grid.clipsToBounds = true
        grid.layer.cornerRadius = 14
        grid.layer.cornerCurve = .continuous
        addSubview(grid)

        emptyEmoji.font = .systemFont(ofSize: 54)
        emptyEmoji.textAlignment = .center
        addSubview(emptyEmoji)
        emptyHeading.font = Theme.title(Theme.TypeSize.emptyTitle) // Fonts
        emptyHeading.textColor = Theme.text
        emptyHeading.textAlignment = .center
        emptyHeading.numberOfLines = 0
        addSubview(emptyHeading)
        emptyHint.font = .systemFont(ofSize: 14)
        emptyHint.textColor = Theme.muted
        emptyHint.textAlignment = .center
        emptyHint.numberOfLines = 0
        addSubview(emptyHint)
        var emptyLook = UIButton.Configuration.filled()
        emptyLook.baseBackgroundColor = Theme.accent
        emptyLook.baseForegroundColor = Theme.onAccent
        emptyLook.cornerStyle = .capsule
        emptyButton.configuration = emptyLook
        emptyButton.addTarget(self, action: #selector(addPressed), for: .touchUpInside)
        addSubview(emptyButton)

        let rule = heightAnchor.constraint(equalToConstant: 120)
        rule.priority = UILayoutPriority(999)
        rule.isActive = true
        heightRule = rule
    }

    required init?(coder: NSCoder) { return nil }

    deinit { watch?.invalidate() }

    // MARK: Setting up

    /// `avatar`: the profile's picture, to put the ring of stories around (nil: no ring).
    func attach(host: UIViewController, messenger: Messenger?, userId: String, own: Bool, avatar: UIView?) {
        self.host = host
        self.messenger = messenger
        self.userId = userId
        self.own = own
        if let messenger, own {
            let made = StoryPublisher(messenger: messenger)
            made.onPublished = { [weak self] (_: String) -> Void in
                self?.reload()
                StoriesStore.shared.refresh()
            }
            publisher = made
        }
        if let avatar, let around = avatar.superview {
            ring.isHidden = true
            ring.translatesAutoresizingMaskIntoConstraints = false
            around.insertSubview(ring, belowSubview: avatar)
            ringButton.isHidden = true
            ringButton.accessibilityLabel = StoryRules.word("stories")
            ringButton.addTarget(self, action: #selector(ringPressed), for: .touchUpInside)
            ringButton.translatesAutoresizingMaskIntoConstraints = false
            around.addSubview(ringButton)
            NSLayoutConstraint.activate([
                ring.centerXAnchor.constraint(equalTo: avatar.centerXAnchor),
                ring.centerYAnchor.constraint(equalTo: avatar.centerYAnchor),
                ring.widthAnchor.constraint(equalTo: avatar.widthAnchor, constant: 12),
                ring.heightAnchor.constraint(equalTo: avatar.heightAnchor, constant: 12),
                ringButton.centerXAnchor.constraint(equalTo: avatar.centerXAnchor),
                ringButton.centerYAnchor.constraint(equalTo: avatar.centerYAnchor),
                ringButton.widthAnchor.constraint(equalTo: avatar.widthAnchor),
                ringButton.heightAnchor.constraint(equalTo: avatar.heightAnchor),
            ])
        }
        giftsPanel.attach(host: host, messenger: messenger, userId: userId, own: own) // Gifts
        rebuild()
        reload()
    }

    /// Gifts / Profile: a tap on the avatar opens the stories when there are any (true then).
    func openStoriesIfAny() -> Bool {
        guard let stories = data?.stories, !stories.isEmpty else { return false }
        ringPressed()
        return true
    }

    /// The person's colour lights the ring.
    func setColor(_ color: UInt32) {
        ringColor = color
        ring.show(color: color, fresh: true)
    }

    /// Reads the posts and stories again (after a change, and when the two became friends or stopped being).
    func reload() {
        if !userId.isEmpty { giftsPanel.reload() } // Gifts: who may see them can change with the friendship
        guard let messenger else {
            #if targetEnvironment(simulator)
            data = StoriesDemo.profile(own: own)
            rebuild()
            #endif
            return
        }
        ChannelImages.shared.server = messenger.server
        let asked = userId
        messenger.profilePosts(asked) { [weak self] (result: Result<ProfilePostsData, ServerError>) -> Void in
            guard let self, self.userId == asked else { return }
            switch result {
            case .success(let found): self.data = found
            // As in the reference: what was shown stays; with nothing shown yet, the closed look.
            case .failure: if self.data == nil { self.data = ProfilePostsData(visible: false, posts: [], stories: []) }
            }
            self.rebuild()
        }
    }

    // MARK: What is shown

    private var items: [StoryPost] {
        guard let data else { return [] }
        if tab == "gift" { return [] } // Gifts
        return tab == "post" ? data.posts : data.stories
    }

    private func rebuild() {
        let labels = Core.view("storiesTabs", [data?.posts.count ?? 0, data?.stories.count ?? 0]) as? [String] ?? [StoryRules.word("tabPosts"), StoryRules.word("tabStories")]
        let titles = Array(labels.prefix(2)) + [giftCount > 0 ? "Подарки \(giftCount)" : "Подарки"] // Gifts
        for (position, button) in [postsTab, storiesTab, giftsTab].enumerated() {
            let on = ["post", "story", "gift"][position] == tab
            button.setTitle(position < titles.count ? titles[position] : "", for: .normal)
            button.setTitleColor(on ? Theme.text : Theme.muted, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 15, weight: on ? .bold : .semibold)
            button.titleLabel?.adjustsFontSizeToFitWidth = true
            button.titleLabel?.minimumScaleFactor = 0.8
            button.backgroundColor = on ? Theme.veil(0.14) : .clear
            button.accessibilityTraits = on ? [.button, .selected] : [.button]
        }
        let shown = items
        for tile in tiles { tile.removeFromSuperview() }
        tiles = []
        for (position, post) in shown.enumerated() {
            let tile = StoryTileView(frame: .zero)
            tile.show(post)
            tile.tag = position
            tile.addTarget(self, action: #selector(tilePressed(_:)), for: .touchUpInside)
            if own {
                let press = UILongPressGestureRecognizer(target: self, action: #selector(tileHeld(_:)))
                press.minimumPressDuration = 0.35
                tile.addGestureRecognizer(press)
            }
            grid.addSubview(tile)
            tiles.append(tile)
        }
        let addWords = StoryRules.word(tab == "post" ? "addPost" : "addStory")
        var addLook = addButton.configuration
        addLook?.title = addWords
        addButton.configuration = addLook
        let empty = Core.view("storiesEmpty", [tab, own]) as? [String: Any] ?? [:]
        emptyEmoji.text = empty["emoji"] as? String ?? ""
        emptyHeading.text = empty["heading"] as? String ?? ""
        emptyHint.text = empty["hint"] as? String ?? ""
        var emptyLook = emptyButton.configuration
        emptyLook?.title = empty["button"] as? String ?? addWords
        emptyButton.configuration = emptyLook
        problemLabel.text = problem

        let stories = data?.stories ?? []
        ring.isHidden = stories.isEmpty
        ringButton.isHidden = stories.isEmpty
        ring.show(color: ringColor, fresh: true)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        guard width > 0 else { return }
        let closed = data != nil && data?.visible == false
        let waiting = data == nil
        let shown = items
        let has = !shown.isEmpty
        var y: CGFloat = 0

        lockIcon.isHidden = !closed
        lockLabel.isHidden = !closed
        tabsBox.isHidden = closed
        problemLabel.isHidden = closed || problem.isEmpty
        grid.isHidden = closed || waiting || !has
        addButton.isHidden = closed || waiting || !has || !own
        let gifting = tab == "gift" && !closed && !waiting // Gifts
        giftsPanel.isHidden = !gifting
        let showEmpty = !closed && !waiting && !has && !gifting
        emptyEmoji.isHidden = !showEmpty
        emptyHeading.isHidden = !showEmpty
        emptyHint.isHidden = !showEmpty
        emptyButton.isHidden = !showEmpty || !own
        if waiting && !closed { spinner.startAnimating() } else { spinner.stopAnimating() }

        if closed {
            lockIcon.frame = CGRect(x: 0, y: 22, width: width, height: 24)
            let size = lockLabel.sizeThatFits(CGSize(width: width - 24, height: 200))
            lockLabel.frame = CGRect(x: 12, y: 52, width: width - 24, height: size.height)
            setHeight(52 + size.height + 22)
            return
        }

        let tabsWidth = min(420, width)
        tabsBox.frame = CGRect(x: (width - tabsWidth) / 2, y: y, width: tabsWidth, height: 46)
        let third = (tabsWidth - 8) / 3 // Gifts: three tabs
        postsTab.frame = CGRect(x: 4, y: 4, width: third, height: 38)
        storiesTab.frame = CGRect(x: 4 + third, y: 4, width: third, height: 38)
        giftsTab.frame = CGRect(x: 4 + third * 2, y: 4, width: third, height: 38)
        y += 46 + 14
        if !problem.isEmpty {
            let size = problemLabel.sizeThatFits(CGSize(width: width - 24, height: 200))
            problemLabel.frame = CGRect(x: 12, y: y, width: width - 24, height: size.height)
            y += size.height + 14
        }
        if waiting {
            spinner.center = CGPoint(x: width / 2, y: y + 34)
            setHeight(y + 68)
            return
        }
        if gifting {
            // Gifts: the panel lays itself out, then says how tall it is.
            giftsPanel.frame = CGRect(x: 0, y: y, width: width, height: max(1, giftsPanel.contentHeight))
            giftsPanel.layoutIfNeeded()
            giftsPanel.frame.size.height = giftsPanel.contentHeight
            setHeight(y + giftsPanel.contentHeight)
            return
        }
        if has {
            if own {
                let wanted = min(width, addButton.sizeThatFits(CGSize(width: width, height: 38)).width + 8)
                addButton.frame = CGRect(x: (width - wanted) / 2, y: y, width: wanted, height: 38)
                y += 38 + 10
            }
            let gap = CGFloat(StoryRules.number("gap", 2)), columns = max(1, Int(StoryRules.number("columns", 3)))
            let side = ((width - gap * CGFloat(columns - 1)) / CGFloat(columns)).rounded(.down)
            let rows = (shown.count + columns - 1) / columns
            let tall = CGFloat(rows) * side + CGFloat(max(0, rows - 1)) * gap
            grid.frame = CGRect(x: 0, y: y, width: width, height: tall)
            for (position, tile) in tiles.enumerated() {
                tile.frame = CGRect(x: CGFloat(position % columns) * (side + gap), y: CGFloat(position / columns) * (side + gap), width: side, height: side)
            }
            y += tall
            setHeight(y)
            loadVisible()
            return
        }
        y += 18
        emptyEmoji.frame = CGRect(x: 0, y: y, width: width, height: 64)
        y += 64 + 8
        let headingSize = emptyHeading.sizeThatFits(CGSize(width: width - 24, height: 200))
        emptyHeading.frame = CGRect(x: 12, y: y, width: width - 24, height: headingSize.height)
        y += headingSize.height + 8
        let hintSize = emptyHint.sizeThatFits(CGSize(width: width - 24, height: 300))
        emptyHint.frame = CGRect(x: 12, y: y, width: width - 24, height: hintSize.height)
        y += hintSize.height
        if own {
            y += 16
            emptyButton.frame = CGRect(x: 30, y: y, width: max(0, width - 60), height: 50)
            y += 50
        }
        setHeight(y + 18)
    }

    private func setHeight(_ height: CGFloat) {
        let wanted = height.rounded(.up)
        if heightRule?.constant != wanted { heightRule?.constant = wanted }
    }

    // MARK: Pictures only near the screen

    override func didMoveToWindow() {
        super.didMoveToWindow()
        watch?.invalidate()
        watch = nil
        scroller = nil
        guard window != nil else { return }
        var above = superview
        while let view = above, !(view is UIScrollView) { above = view.superview }
        guard let scroll = above as? UIScrollView else { return }
        scroller = scroll
        watch = scroll.observe(\.contentOffset, options: [.new]) { [weak self] (_: UIScrollView, _: NSKeyValueObservedChange<CGPoint>) -> Void in
            self?.loadVisible()
        }
        loadVisible()
    }

    /// Asks for the pictures of the tiles on the screen and a little beyond; the rest wait for the scroll.
    private func loadVisible() {
        guard !grid.isHidden, !tiles.isEmpty else { return }
        guard let scroller else {
            for tile in tiles.prefix(18) { tile.loadIfNeeded() }
            return
        }
        let origin = grid.convert(CGPoint.zero, to: scroller)
        let seen = scroller.bounds.insetBy(dx: 0, dy: -300)
        for tile in tiles {
            let top = origin.y + tile.frame.minY
            if top + tile.frame.height >= seen.minY && top <= seen.maxY { tile.loadIfNeeded() }
        }
    }

    // MARK: What the person does

    @objc private func tabPressed(_ sender: UIButton) {
        let next = sender === giftsTab ? "gift" : sender === storiesTab ? "story" : "post" // Gifts
        guard next != tab else { return }
        tab = next
        problem = ""
        rebuild()
    }

    @objc private func addPressed() {
        guard own, let host, let publisher else { return }
        problem = ""
        publisher.begin(kind: tab, from: host)
    }

    @objc private func ringPressed() {
        guard let stories = data?.stories, !stories.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        open(stories, start: 0, story: true)
    }

    @objc private func tilePressed(_ sender: StoryTileView) {
        let shown = items
        guard sender.tag >= 0, sender.tag < shown.count else { return }
        open(shown, start: sender.tag, story: tab == "story")
    }

    private func open(_ list: [StoryPost], start: Int, story: Bool) {
        guard let host, host.presentedViewController == nil else { return }
        // No owner line here: the profile behind says whose these are (as in the reference).
        let group = StoryViewerGroup(key: userId, owner: nil, items: list, start: start, story: story, own: own, canReply: false, runsOn: story)
        let viewer = StoryViewerController(group: group)
        if let messenger {
            viewer.avatarAddress = { [weak messenger] (person: Person) -> String in messenger?.personAvatarAddress(person.avatarId) ?? "" }
            if own {
                // (The type is the viewer's `loadViewers`.)
                viewer.loadViewers = { [weak messenger] post, done in
                    guard let messenger else {
                        done(nil)
                        return
                    }
                    messenger.storyViewers(post.id) { (result: Result<StoryViewersData, ServerError>) -> Void in
                        if case .success(let found) = result { done(found) } else { done(nil) }
                    }
                }
            } else {
                viewer.onWatched = { [weak messenger] (_: String, post: StoryPost) -> Void in
                    if !post.seen { messenger?.viewStory(post.id) }
                }
            }
        }
        #if targetEnvironment(simulator)
        StoriesDemo.dress(viewer)
        #endif
        host.present(viewer, animated: true, completion: nil)
    }

    @objc private func tileHeld(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, own, let tile = recognizer.view as? StoryTileView, let post = tile.post, let host else { return }
        let sheet = UIAlertController(title: StoryRules.word(post.kind == "story" ? "removeStory" : "removePost"), message: StoryRules.word("removeAbout"), preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: StoryRules.word("remove"), style: .destructive, handler: { [weak self] (_: UIAlertAction) -> Void in self?.remove(post) }))
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        sheet.popoverPresentationController?.sourceView = tile
        sheet.popoverPresentationController?.sourceRect = tile.bounds
        host.present(sheet, animated: true, completion: nil)
    }

    private func remove(_ post: StoryPost) {
        guard let messenger else { return }
        problem = ""
        messenger.deletePost(post.id) { [weak self] (error: ServerError?) -> Void in
            guard let self else { return }
            if let error {
                self.problem = error.words.isEmpty ? StoryRules.word("removeFailed") : error.words
                self.rebuild()
            } else {
                self.reload()
                StoriesStore.shared.refresh()
            }
        }
    }

    #if targetEnvironment(simulator)
    /// For a shot in the simulator: the other tab, or the first tile opened.
    func simulatorShow(tab wanted: String) {
        tab = wanted
        rebuild()
    }

    func simulatorOpenFirst() {
        let shown = items
        if !shown.isEmpty { open(shown, start: 0, story: tab == "story") }
    }
    #endif
}

/// «Публикации и истории» of the signed-in account: what it has pinned to its profile, with adding and removing.
final class OwnPostsViewController: SettingsPage {
    private let messenger: Messenger?
    let block = ProfilePostsBlock(frame: .zero)

    init(messenger: Messenger?) {
        self.messenger = messenger
        super.init(name: "Публикации и истории")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        add(block, gap: 8)
        block.attach(host: self, messenger: messenger, userId: messenger?.userId ?? "demo-me", own: true, avatar: nil)
    }
}

/// An answer to a story carries the story's reference inside its ciphertext (`meta.story`), and the chat shows it
/// as a quote «История». This opens the story such a quote points at, read afresh — a story lives 24 hours, so an
/// old answer says «История недоступна» instead (the reference's `openStory` in ChatScreen.tsx). For the chat's
/// screen to call on a tap on the quote.
enum StoryQuote {
    static func open(ownerId: String, storyId: String, messenger: Messenger, from host: UIViewController, unavailable: @escaping (String) -> Void) {
        messenger.profilePosts(ownerId) { [weak host, weak messenger] (result: Result<ProfilePostsData, ServerError>) -> Void in
            guard let host, let messenger else { return }
            guard case .success(let data) = result, data.visible,
                  let start = data.stories.firstIndex(where: { (story: StoryPost) -> Bool in story.id == storyId }) else {
                unavailable(StoryRules.word("storyGone"))
                return
            }
            let own = ownerId == messenger.userId
            let group = StoryViewerGroup(key: ownerId, owner: nil, items: data.stories, start: start, story: true, own: own, canReply: false, runsOn: true)
            let viewer = StoryViewerController(group: group)
            if !own {
                viewer.onWatched = { [weak messenger] (_: String, post: StoryPost) -> Void in
                    if !post.seen { messenger?.viewStory(post.id) }
                }
            }
            host.present(viewer, animated: true, completion: nil)
        }
    }
}
