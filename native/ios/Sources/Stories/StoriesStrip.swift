import UIKit

// The strip above the chats (the reference's stories/StoriesStrip.tsx): «Моя история» first — a «+» adds one —
// then the people who have a live story or published a post in the last two days: those with something not yet
// seen first, with a lit ring; all seen, a grey ring. A person this account has only sent a request to carries a
// small clock and «заявка»; one shown for a post, «запись». The strip is not there at all while nobody has
// anything. Who is in it is the server's decision; the order and the words are the core's.
//
// The strip stands in the chats' floating header, as in the previous app: the list scrolls under it. Its cells are
// reused; the pictures of people come through the avatars' own loader, decoded off the main queue.

final class StoryStripCell: UICollectionViewCell {
    static let size = CGSize(width: 80, height: 102)
    private let ring = StoryRingView(frame: .zero)
    private let avatar = PersonAvatarView()
    private let badge = UIButton(type: .custom)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let nameLabel = UILabel()
    private let subLabel = UILabel()
    /// «+» on «Моя история» was pressed.
    var onAdd: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.addSubview(ring)
        contentView.addSubview(avatar)
        badge.layer.cornerRadius = 11
        badge.layer.borderWidth = 2
        badge.addTarget(self, action: #selector(addPressed), for: .touchUpInside)
        contentView.addSubview(badge)
        spinner.hidesWhenStopped = true
        spinner.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
        spinner.isUserInteractionEnabled = false
        contentView.addSubview(spinner)
        nameLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        nameLabel.textAlignment = .center
        contentView.addSubview(nameLabel)
        subLabel.font = .systemFont(ofSize: 11)
        subLabel.textAlignment = .center
        contentView.addSubview(subLabel)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func addPressed() { onAdd?() }

    override var isHighlighted: Bool {
        didSet { contentView.alpha = isHighlighted ? 0.75 : 1 }
    }

    /// «Моя история»: the ring only when there is a story; «+» always (a spinner while one is being added).
    func showMine(_ person: Person?, address: String, has: Bool, spoken: String, busy: Bool) {
        let shown = person ?? Person(id: "", username: "", displayName: "", bio: "", birthday: "", avatarColor: 0x5E7BFF, avatarId: "")
        avatar.show(shown, address: address)
        ring.isHidden = !has
        ring.show(color: shown.avatarColor, fresh: true)
        badge.isHidden = false
        badge.isUserInteractionEnabled = !busy
        badge.backgroundColor = Theme.accent
        badge.layer.borderColor = Theme.bg.cgColor
        badge.tintColor = Theme.onAccent
        badge.setImage(busy ? nil : IonIcon.image("add", size: 14), for: .normal) // StoriesStrip.tsx: «add» 14
        badge.accessibilityLabel = StoryRules.word("addStory")
        if busy { spinner.color = Theme.onAccent; spinner.startAnimating() } else { spinner.stopAnimating() }
        nameLabel.text = StoryRules.word("mine")
        nameLabel.textColor = Theme.text
        subLabel.text = ""
        accessibilityLabel = spoken
    }

    func show(_ entry: StripEntry, address: String) {
        avatar.show(entry.person, address: address)
        ring.isHidden = false
        ring.show(color: entry.person.avatarColor, fresh: entry.fresh)
        // Not a friend yet: the request to this person is still waiting.
        badge.isHidden = !entry.pending
        badge.isUserInteractionEnabled = false
        badge.backgroundColor = Theme.surface2
        badge.layer.borderColor = Theme.bg.cgColor
        badge.tintColor = Theme.muted
        badge.setImage(IonIcon.image("time-outline", size: 13), for: .normal) // «time-outline» 13
        badge.accessibilityLabel = nil
        spinner.stopAnimating()
        nameLabel.text = entry.name
        nameLabel.textColor = Theme.text
        subLabel.text = entry.sub
        subLabel.textColor = Theme.muted
        accessibilityLabel = entry.spoken
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width
        let box = CGRect(x: (width - 68) / 2, y: 0, width: 68, height: 68)
        ring.frame = box
        avatar.frame = box.insetBy(dx: 6, dy: 6)
        badge.frame = CGRect(x: box.maxX - 22, y: box.maxY - 22, width: 22, height: 22)
        spinner.center = CGPoint(x: badge.frame.midX, y: badge.frame.midY)
        nameLabel.frame = CGRect(x: 4, y: 73, width: width - 8, height: 15)
        subLabel.frame = CGRect(x: 4, y: 89, width: width - 8, height: 13)
    }
}

/// The strip and what its taps do. Made by the chats' screen, which takes it in with `install` and says in `place`
/// whether the strip may be shown and where it stands. Main queue only.
final class StoriesStrip: NSObject, UICollectionViewDataSource, UICollectionViewDelegate {
    /// The strip's height in the header: the ring, the name and 6 under it; a line more when somebody carries
    /// «запись» or «заявка» (StoriesStrip.tsx).
    static func height(sub: Bool) -> CGFloat { return sub ? 106 : 92 }

    private let messenger: Messenger?
    private weak var host: UIViewController?
    private let holder = UIView()
    private let collection: UICollectionView
    /// A hold on «Моя история» is believed only when the finger stayed where it was put (Design/SteadyHold.swift).
    private let steady = SteadyHold()
    private var publisher: StoryPublisher?
    private var allowed = true
    #if targetEnvironment(simulator)
    /// For the simulator check: the strip of the chats' screen.
    static weak var simulatorCurrent: StoriesStrip?
    #endif

    init(messenger: Messenger?) {
        self.messenger = messenger
        let layout = UICollectionViewFlowLayout()
        layout.scrollDirection = .horizontal
        layout.itemSize = StoryStripCell.size
        layout.minimumLineSpacing = 6
        layout.minimumInteritemSpacing = 0
        layout.sectionInset = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
        collection = UICollectionView(frame: .zero, collectionViewLayout: layout)
        super.init()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var store: StoriesStore { return StoriesStore.shared }

    func install(host: UIViewController) {
        self.host = host
        holder.backgroundColor = .clear
        holder.isHidden = true
        host.view.addSubview(holder)
        collection.backgroundColor = .clear
        collection.showsHorizontalScrollIndicator = false
        collection.alwaysBounceHorizontal = true
        collection.register(StoryStripCell.self, forCellWithReuseIdentifier: "story")
        collection.dataSource = self
        collection.delegate = self
        holder.addSubview(collection)
        // Holding «Моя история» adds one, as a tap on «+» does.
        let press = UILongPressGestureRecognizer(target: self, action: #selector(heldDown(_:)))
        press.minimumPressDuration = 0.35
        steady.watch(press)
        collection.addGestureRecognizer(press)
        NotificationCenter.default.addObserver(self, selector: #selector(storeChanged), name: StoriesStore.changed, object: nil)
        if let messenger {
            messenger.preparePersonAvatars()
            let made = StoryPublisher(messenger: messenger)
            made.onPublished = { (_: String) -> Void in StoriesStore.shared.refresh() }
            publisher = made
        }
        store.start(messenger)
        #if targetEnvironment(simulator)
        StoriesStrip.simulatorCurrent = self
        if messenger == nil, UserDefaults.standard.string(forKey: "storiesdemo") != nil { StoriesDemo.fillStrip() }
        #endif
    }

    /// From the screen's layout. `allowed`: not in «Архив» and not while searching (as in the reference); `top`:
    /// where the strip starts in the screen. Gives the height it takes (nothing when it is not shown).
    func place(allowed next: Bool, top: CGFloat, width: CGFloat) -> CGFloat {
        allowed = next
        let want = allowed && store.show && width > 0
        holder.isHidden = !want
        guard want else { return 0 }
        let height = StoriesStrip.height(sub: store.people.contains(where: { !$0.sub.isEmpty }))
        holder.frame = CGRect(x: 0, y: top, width: width, height: height)
        collection.frame = CGRect(x: 0, y: 0, width: width, height: StoryStripCell.size.height)
        return height
    }

    @objc private func storeChanged() {
        collection.reloadData()
        // The strip may have come, gone or grown a line: the screen places its header again.
        host?.view.setNeedsLayout()
    }

    // MARK: The cells

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        return 1 + store.people.count
    }

    private func address(_ person: Person?) -> String {
        guard let person, let messenger else { return "" }
        return messenger.personAvatarAddress(person.avatarId)
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "story", for: indexPath)
        guard let storyCell = cell as? StoryStripCell else { return cell }
        if indexPath.item == 0 {
            storyCell.showMine(store.me, address: address(store.me), has: store.mineHas, spoken: store.mineSpoken, busy: false)
            storyCell.onAdd = { [weak self] in self?.add() }
        } else if indexPath.item - 1 < store.people.count {
            let entry = store.people[indexPath.item - 1]
            storyCell.show(entry, address: address(entry.person))
            storyCell.onAdd = nil
        }
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: false)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if indexPath.item == 0 {
            if store.mineHas { open(store.myId) } else { add() }
        } else if indexPath.item - 1 < store.people.count {
            open(store.people[indexPath.item - 1].person.id)
        }
    }

    @objc private func heldDown(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, let path = collection.indexPathForItem(at: recognizer.location(in: collection)), path.item == 0 else { return }
        // Not for a tap whose lift was read late (it would add a story where the circle was only touched).
        steady.began(recognizer, in: collection) { [weak self] (_: CGPoint) -> Void in
            self?.add()
        }
    }

    // MARK: What the taps do

    private func add() {
        guard let host, let publisher, host.presentedViewController == nil else { return }
        publisher.begin(kind: "story", from: host)
    }

    /// Opens the viewer on a person of the strip (the account's own id: «Моя история»).
    func open(_ id: String) {
        guard let host, host.presentedViewController == nil, let group = store.group(id, entered: 1) else { return }
        let viewer = StoryViewerController(group: group)
        // At the end of one person's stories the viewer runs on to the next; before the first, back to the previous.
        viewer.neighbour = { (key: String, step: Int) -> StoryViewerGroup? in StoriesStore.shared.neighbour(of: key, step: step) }
        viewer.onWatched = { (key: String, post: StoryPost) -> Void in StoriesStore.shared.watched(userId: key, post: post) }
        viewer.onOpened = { (post: StoryPost) -> Void in StoriesStore.shared.opened(post: post) }
        if let messenger {
            viewer.avatarAddress = { [weak messenger] (person: Person) -> String in messenger?.personAvatarAddress(person.avatarId) ?? "" }
            // (The types of these two are the viewer's `onReply` and `loadViewers`.)
            viewer.onReply = { [weak messenger] authorId, post, text, done in
                guard let messenger else {
                    done(StoryRules.word("replyFailed"))
                    return
                }
                messenger.replyToStory(authorId: authorId, storyId: post.id, text: text, done: done)
            }
            viewer.loadViewers = { [weak messenger] post, done in
                guard let messenger else {
                    done(nil)
                    return
                }
                messenger.storyViewers(post.id) { (result: Result<StoryViewersData, ServerError>) -> Void in
                    if case .success(let found) = result { done(found) } else { done(nil) }
                }
            }
        }
        #if targetEnvironment(simulator)
        StoriesDemo.dress(viewer)
        #endif
        host.present(viewer, animated: true, completion: nil)
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: the first person's stories (or the account's own when nobody else has any).
    func simulatorOpenFirst() -> Bool {
        if let first = store.people.first { open(first.person.id); return true }
        if store.mineHas { open(store.myId); return true }
        return false
    }
    #endif
}
