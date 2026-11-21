import UIKit

/// The look of one chat (the reference's ChatScreen.tsx header and backdrop): the header as glass — «назад» on
/// the left with the unread messages of the other chats, the name in the very middle (in platinum for Platina, with
/// the emoji status, the status line under it), and on the right «Позвонить» (the owner's decision) and the person's
/// avatar (a tap opens the profile, a long touch the large picture); the soft blurred edge under the header; behind
/// the messages the wallpaper or the person's light; bubbles or the open look; a swipe to answer.
///
/// The screen keeps its own views (the name label, «назад», the call button, the status line of ChatActions) and
/// hands them over; this object puts them into the glass and places them after the screen and ChatActions did.
final class ChatLookScreen: NSObject {
    private let messenger: Messenger?
    private let chatId: String
    private let peerId: String
    private let name: String

    private weak var host: UIViewController?
    private weak var header: UIView?
    private weak var heading: UILabel?
    private weak var back: UIButton?
    private weak var call: UIButton?
    private weak var status: UILabel?
    private weak var list: MsgListView?

    private let wallpaper = WallpaperView()
    private let light = PeerLightView()
    private let edge = HeaderEdgeView()
    private let backPill = GlassPill()
    private let namePill = GlassPill()
    private let callPill = GlassPill()
    private let badge = UILabel()
    private let emoji = StatusEmojiView() // Avatars: the emoji status (animated) or the Platina gem, as StatusEmoji size 16
    private let metal = MetalNameView()
    private let avatarControl = UIControl()
    private let avatar = DecoratedAvatarView() // Avatars: frame (inside the 44 pt box, as the reference at this size) and video avatar
    /// The person as the server describes them (`User`): colour, picture, emoji status, Platina.
    private var peer: [String: Any] = [:]
    private var unread = 0
    private var bubbles = false

    /// «Поиск» in the avatar's menu: set by whoever gives the chat its search (shown only when set).
    var onSearch: (() -> Void)?

    init(messenger: Messenger?, chatId: String, peerId: String, name: String) {
        self.messenger = messenger
        self.chatId = chatId
        self.peerId = peerId
        self.name = name
        super.init()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: Setting up

    /// The wallpaper and the person's light go under the list.
    func installBackdrop(in view: UIView, below list: UIView) {
        view.insertSubview(wallpaper, belowSubview: list)
        view.insertSubview(light, belowSubview: list)
    }

    /// Takes the header's views over. Call after ChatActions has set itself up.
    func installHeader(host: UIViewController, header: UIView, heading: UILabel, back: UIButton, call: UIButton, status: UILabel, list: MsgListView, actions: ChatScreenActions) {
        self.host = host
        self.header = header
        self.heading = heading
        self.back = back
        self.call = call
        self.status = status
        self.list = list

        header.backgroundColor = .clear
        host.view.insertSubview(edge, belowSubview: header)

        // «назад»: a glass pill; with unread messages in other chats, their number after the arrow.
        header.addSubview(backPill)
        backPill.contentView.addSubview(back)
        back.tintColor = Theme.text
        badge.font = .systemFont(ofSize: 11, weight: .bold)
        badge.textColor = Theme.dark ? .black : .white
        badge.backgroundColor = Theme.text
        badge.textAlignment = .center
        badge.layer.cornerRadius = 9
        badge.layer.masksToBounds = true
        badge.isUserInteractionEnabled = false
        backPill.contentView.addSubview(badge)
        Bouncy.attach(back, scale: 0.88, view: backPill)

        // The name in the middle, the emoji status after it, the status line under it.
        header.addSubview(namePill)
        namePill.contentView.addSubview(heading)
        namePill.contentView.addSubview(metal)
        namePill.contentView.addSubview(emoji)
        namePill.contentView.addSubview(status)
        status.font = .systemFont(ofSize: 12)
        // The whole pill opens the profile (the label's own tap would open it a second time).
        heading.isUserInteractionEnabled = false
        let nameTap = UITapGestureRecognizer(target: self, action: #selector(openProfile))
        namePill.addGestureRecognizer(nameTap)
        namePill.accessibilityTraits = .button

        // «Позвонить» (a long touch offers «Видеозвонок»), a round glass button.
        header.addSubview(callPill)
        callPill.contentView.addSubview(call)
        call.tintColor = Theme.text
        call.setImage(UIImage(systemName: "phone", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular)), for: .normal)
        Bouncy.attach(call, scale: 0.86, view: callPill)

        // The avatar: a tap opens the profile, a long touch shows the large picture.
        // Avatars: the decorated avatar (Sources/Avatars): as the reference's header — DecoratedAvatar size 44,
        // animated: a ring stays inside the box, art and code frames reach 1.3× it, the silent video avatar plays.
        header.addSubview(avatarControl)
        avatar.isUserInteractionEnabled = false
        avatarControl.addSubview(avatar)
        avatarControl.accessibilityLabel = "Полный профиль " + name
        avatarControl.accessibilityTraits = .button
        avatarControl.addTarget(self, action: #selector(openProfile), for: .touchUpInside)
        avatarControl.addTarget(self, action: #selector(avatarDown), for: [.touchDown, .touchDragEnter])
        avatarControl.addTarget(self, action: #selector(avatarUp), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(avatarHeld(_:)))
        hold.minimumPressDuration = 0.35
        avatarControl.addGestureRecognizer(hold)

        // A swipe to the left on a message answers it.
        list.canSwipeReply = { [weak actions] (key: String) -> Bool in actions?.canSwipeReply(key) ?? false }
        list.onSwipeReply = { [weak actions] (event: [String: Any]) -> Void in actions?.swipeReply(event["key"] as? String ?? "") }

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(unreadChanged), name: ChatLookUnread.changed, object: nil)
        center.addObserver(self, selector: #selector(lookChanged), name: Wallpapers.changed, object: nil)
        center.addObserver(self, selector: #selector(lookChanged), name: DevicePreferences.changed, object: nil)
        center.addObserver(self, selector: #selector(pictureReady(_:)), name: ChatAvatarStore.ready, object: nil)

        peer = ChatLookUnread.peer(chatId)
        #if targetEnvironment(simulator)
        if messenger == nil { peer = ChatLookScreen.demoPeer(name: name) }
        #endif
        unread = currentUnread()
        showPeer()
        apply()
        askPeer()
    }

    /// The person as the server describes them now (their emoji status may have changed since the list was read).
    private func askPeer() {
        guard let messenger, !peerId.isEmpty else { return }
        messenger.server.op("userProfile", [peerId]) { [weak self] (result: Result<Any, ServerError>) -> Void in
            guard case .success(let body) = result, let user = (body as? [String: Any])?["user"] as? [String: Any] else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.peer = user
                self.showPeer()
                self.apply()
            }
        }
    }

    // MARK: What is shown

    private var avatarColor: UInt32 { Messenger.color(peer["avatarColor"] as? String) }
    private var avatarId: String { peer["avatarId"] as? String ?? "" }
    private var address: String { messenger?.personAvatarAddress(avatarId) ?? "" }

    /// The colour of the person's light: their photo's, else the one they chose.
    private var peerTint: UInt32 {
        if peer["avatarColor"] == nil { return 0x5E7BFF }
        return LookColor.tint(avatarId: avatarId, address: address, chosen: avatarColor)
    }

    private func showPeer() {
        let shownName = (peer["displayName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name
        let person = Person(id: peerId, username: peer["username"] as? String ?? "", displayName: shownName, bio: "", birthday: "",
                            avatarColor: peer["avatarColor"] == nil ? 0x5E7BFF : avatarColor, avatarId: avatarId)
        // Avatars: the decorations of the same `user` (the gap of a ring is the page colour, as the reference's t.bg).
        let look = PersonLook(peer)
        avatar.show(person, look: look, base: messenger?.server.endpoint ?? "", animated: true)
        emoji.show(look, size: 16, animated: true)
        let platina = peer["seal"] as? String == "platina"
        metal.isHidden = !platina
        host?.view.setNeedsLayout()
    }

    private func currentUnread() -> Int {
        #if targetEnvironment(simulator)
        if messenger == nil { return UserDefaults.standard.string(forKey: "chatlook") != nil ? 3 : 0 }
        #endif
        return ChatLookUnread.elsewhere(chatId)
    }

    @objc private func unreadChanged() {
        let next = currentUnread()
        guard next != unread else { return }
        unread = next
        host?.view.setNeedsLayout()
    }

    @objc private func lookChanged() { apply() }

    @objc private func pictureReady(_ note: Notification) {
        guard let key = note.object as? String, key == avatarId, !key.isEmpty else { return }
        apply()
    }

    /// Bubbles or the open look, their colours, the wallpaper or the light, the header's edge.
    func apply() {
        guard let host else { return }
        let choice = Wallpapers.choice(chatId: chatId)
        bubbles = ChatBubbleLook.bubbles(chatId: chatId)
        let tint = peerTint
        ChatBubbleLook.open = !bubbles
        ChatBubbleLook.radius = ChatBubbleLook.chosenRadius
        ChatBubbleLook.peerLine = LookColor.color(LookColor.bright(tint, floor: Theme.dark ? 190 : 0))
        list?.setLook(palette: ChatBubbleLook.palette(bubbles: bubbles))
        wallpaper.show(choice)
        wallpaper.isHidden = !choice.shown
        light.peerColor = tint
        light.isHidden = choice.shown
        // The edge takes the wallpaper's own colour at the top, so it never shows as a band over it.
        if let colors = choice.colors, let first = colors.first {
            edge.color = LookColor.color(first)
            edge.alphaOfEdge = 0.9
        } else if choice.isImage {
            edge.color = .black
            edge.alphaOfEdge = 0.5
        } else {
            edge.color = Theme.bg
            edge.alphaOfEdge = 0.96
        }
        host.view.setNeedsLayout()
    }

    // MARK: Layout

    /// Places the header after the screen and ChatActions placed theirs (`safeTop`: the status bar).
    func place(in view: UIView, safeTop: CGFloat) {
        let width = view.bounds.width
        let height = view.bounds.height
        wallpaper.frame = CGRect(x: 0, y: 0, width: width, height: height)
        // The light runs past the screen's edges (top -80, bottom -60), as in the reference.
        light.frame = CGRect(x: 0, y: -80, width: width, height: height + 140)
        guard let header, let heading, let back, let call, let status else { return }
        edge.place(width: width, size: header.frame.maxY)
        // ChatActions hides the name while messages are being chosen: the glass goes with it.
        let choosing = heading.isHidden
        for part in [backPill, namePill, callPill] as [UIView] { part.isHidden = choosing }
        avatarControl.isHidden = choosing
        if choosing { return }
        backPill.isHidden = back.isHidden
        let y = safeTop + 8
        let side: CGFloat = 44

        // «назад»
        let count = unread > 99 ? "99+" : String(unread)
        badge.isHidden = unread == 0
        badge.text = count
        let badgeWidth = unread == 0 ? 0 : max(18, ceil(badge.intrinsicContentSize.width) + 10)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: unread == 0 ? 20 : 17, weight: .semibold)), for: .normal)
        back.accessibilityLabel = unread == 0 ? "Назад к чатам" : "Назад к чатам, непрочитанных \(unread)"
        let backWidth = unread == 0 ? side : 9 + 22 - 4 + badgeWidth + 11
        backPill.frame = CGRect(x: 12, y: y, width: backWidth, height: side)
        backPill.shape(radius: side / 2)
        back.frame = backPill.bounds
        back.contentHorizontalAlignment = unread == 0 ? .center : .left
        back.contentEdgeInsets = UIEdgeInsets(top: 0, left: unread == 0 ? 0 : 7, bottom: 0, right: 0)
        badge.frame = CGRect(x: 9 + 22 - 4, y: (side - 18) / 2, width: badgeWidth, height: 18)

        // The right column: «Позвонить», then the avatar at the edge.
        avatarControl.frame = CGRect(x: width - 12 - side, y: y, width: side, height: side)
        avatar.frame = avatarControl.bounds
        callPill.frame = CGRect(x: avatarControl.frame.minX - 8 - side, y: y, width: side, height: side)
        callPill.shape(radius: side / 2)
        call.frame = callPill.bounds

        // The name: in the very middle of the screen; when it is too long for that, in the middle of the room
        // between «назад» and the right column.
        let nameFont = UIFont.systemFont(ofSize: 16, weight: .semibold)
        let nameWords = NSAttributedString(string: heading.text ?? name, attributes: [.font: nameFont, .kern: -0.25, .foregroundColor: Theme.text])
        heading.attributedText = nameWords
        heading.textAlignment = .center
        heading.lineBreakMode = .byTruncatingTail
        let hasStatus = !status.isHidden && !(status.text ?? "").isEmpty
        let emojiWidth: CGFloat = emoji.isHidden ? 0 : ceil(emoji.intrinsicContentSize.width) + 5
        let nameWidth = ceil(nameWords.size().width) + emojiWidth
        let statusWidth = hasStatus ? ceil(status.intrinsicContentSize.width) : 0
        let wanted = max(nameWidth, statusWidth) + 36
        let rightColumn = width - callPill.frame.minX
        let symmetric = width - 2 * (rightColumn + 8)
        let between = callPill.frame.minX - 8 - (backPill.frame.maxX + 8)
        let pillWidth = max(60, min(wanted, width * 0.62, wanted <= symmetric ? symmetric : between))
        var pillX = (width - pillWidth) / 2
        if pillWidth > symmetric { pillX = backPill.frame.maxX + 8 + (between - pillWidth) / 2 }
        namePill.frame = CGRect(x: pillX, y: y, width: pillWidth, height: side)
        namePill.shape(radius: 22)
        namePill.accessibilityLabel = "Профиль " + (heading.text ?? name)

        let inner = pillWidth - 36
        let shownName = min(nameWidth - emojiWidth, inner - emojiWidth)
        let rowWidth = shownName + emojiWidth
        let nameY: CGFloat = hasStatus ? 4.5 : (side - 20) / 2
        heading.frame = CGRect(x: 18 + (inner - rowWidth) / 2, y: nameY, width: shownName, height: 20)
        emoji.frame = CGRect(x: heading.frame.maxX + 5, y: nameY - 1, width: max(0, emojiWidth - 5), height: 22)
        status.frame = CGRect(x: 18, y: nameY + 20, width: inner, height: 15)
        status.textAlignment = .center
        // Platina: the letters in moving platinum over the plain ones (kept for VoiceOver and the layout).
        if !metal.isHidden {
            metal.frame = heading.frame
            metal.show(nameWords, alignment: .center)
            heading.alpha = 0.011
        } else {
            heading.alpha = 1
        }
    }

    // MARK: Touches

    @objc private func openProfile() {
        (host as? ChatViewController)?.openProfile()
    }

    @objc private func avatarDown() { avatarControl.alpha = 0.75 }
    @objc private func avatarUp() { avatarControl.alpha = 1 }

    @objc private func avatarHeld(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, let host else { return }
        avatarControl.alpha = 1
        host.view.endEditing(true)
        Haptic.impact()
        showPeek()
    }

    /// The large picture with «Открыть профиль» and «Поиск».
    func showPeek() {
        guard let host else { return }
        // Avatars: the decorated, animated avatar of 220 points (the reference's `DecoratedAvatar size={220} animated
        // round`): its frame, art or code frame, the silent video avatar; the gap of a ring is the card's colour.
        let large = DecoratedAvatarView()
        let shownName = (peer["displayName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name
        large.ringBackground = Theme.dark ? UIColor(hex: 0x1C1C1E) : .white
        large.show(Person(id: peerId, username: "", displayName: shownName, bio: "", birthday: "",
                          avatarColor: peer["avatarColor"] == nil ? 0x5E7BFF : avatarColor, avatarId: avatarId),
                   look: PersonLook(peer), base: messenger?.server.endpoint ?? "", animated: true)
        var items: [AvatarPeekController.Item] = [
            AvatarPeekController.Item(symbol: "person.crop.circle", label: "Открыть профиль", run: { [weak self] in self?.openProfile() }),
        ]
        if let onSearch {
            items.append(AvatarPeekController.Item(symbol: "magnifyingglass", label: "Поиск", run: onSearch))
        }
        let peek = AvatarPeekController(picture: large, name: shownName, status: status?.text ?? "", top: host.view.safeAreaInsets.top + 60, items: items)
        host.present(peek, animated: true)
    }

    #if targetEnvironment(simulator)
    var listForDemo: MsgListView? { list }

    /// The simulator's sample person: a calm teal, a leaf as the emoji status, Platina.
    static func demoPeer(name: String) -> [String: Any] {
        let args = UserDefaults.standard
        var peer: [String: Any] = ["id": "demo-peer", "displayName": name, "username": "alisa", "avatarColor": "#2E9E8F"]
        if args.string(forKey: "chatlook") != nil {
            peer["statusEmoji"] = "🌿"
            peer["statusEmojiPermanent"] = true
            peer["statusEmojiExpiresAt"] = NSNull()
            peer["seal"] = "platina"
        }
        return peer
    }
    #endif
}
