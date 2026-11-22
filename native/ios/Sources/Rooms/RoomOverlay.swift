import UIKit

/// The window the room's ring and bar are shown in, above the app's own (and under the window of calls). A touch
/// that lands on neither goes through to the app underneath.
private final class RoomWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        if hit === self || hit === rootViewController?.view { return nil }
        return hit
    }
}

private final class RoomHostController: UIViewController {
    let banner = RoomRingBanner()
    let bar = RoomBarView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        banner.isHidden = true
        bar.isHidden = true
        view.addSubview(bar)
        view.addSubview(banner)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, top = view.safeAreaInsets.top
        bar.frame = CGRect(x: 12, y: top + 2, width: width - 24, height: RoomBarView.tall)
        let wide = min(460, width * 0.94)
        banner.frame = CGRect(x: (width - wide) / 2, y: top + 8, width: wide, height: 66)
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
}

/// A sheet of the system's glass with rounded corners (the reference's `GlassSurface`): the ring's banner and the
/// room's bar are made of it.
class RoomGlassView: UIView {
    private let glass = UIVisualEffectView(effect: nil)
    private var glassDark: Bool?
    private let clear: Bool
    var content: UIView { glass.contentView }

    init(radius: CGFloat, clear: Bool) {
        self.clear = clear
        super.init(frame: .zero)
        glass.clipsToBounds = true
        glass.layer.cornerRadius = radius
        addSubview(glass)
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        guard bounds.width > 0 else { return }
        if glass.effect == nil || glassDark != Theme.dark {
            // The glass is made once the view has a size (an effect made earlier does not draw).
            glass.effect = TabGlass.effect(clear: clear, interactive: false, dark: Theme.dark)
            glassDark = Theme.dark
        }
    }
}

/// «Зовёт в комнату» over any screen (the reference's `RoomsHost`): who calls, how many are inside already,
/// «Не сейчас» and «Зайти». Goes by itself after half a minute.
final class RoomRingBanner: RoomGlassView {
    private let avatar = PersonAvatarView()
    private let nameLabel = UILabel()
    private let lineLabel = UILabel()
    private let laterButton = UIButton(type: .system)
    private let enterButton = UIButton(type: .system)

    init() {
        super.init(radius: 26, clear: false)
        content.addSubview(avatar)
        nameLabel.font = .systemFont(ofSize: 15.5, weight: .bold)
        nameLabel.textColor = Theme.text
        content.addSubview(nameLabel)
        lineLabel.font = .systemFont(ofSize: 13)
        lineLabel.textColor = RoomRules.talk
        content.addSubview(lineLabel)
        laterButton.setImage(IonIcon.image("close", size: 20), for: .normal)
        laterButton.tintColor = Theme.text
        laterButton.layer.cornerRadius = 21
        laterButton.layer.borderWidth = 1
        laterButton.layer.borderColor = ThemeStore.look.glassBorder.cgColor
        laterButton.accessibilityLabel = "Не сейчас"
        laterButton.addTarget(self, action: #selector(later), for: .touchUpInside)
        content.addSubview(laterButton)
        enterButton.setTitle("Зайти", for: .normal)
        enterButton.setTitleColor(UIColor(hex: 0x04210F), for: .normal)
        enterButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        enterButton.backgroundColor = RoomRules.talk
        enterButton.layer.cornerRadius = 21
        enterButton.accessibilityLabel = "Зайти в комнату"
        enterButton.addTarget(self, action: #selector(enter), for: .touchUpInside)
        content.addSubview(enterButton)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ ring: RoomRing, room: Room?) {
        avatar.show(ring.from, address: Rooms.shared.pictureAddress(ring.from))
        // The core keeps the reference's own words for a caller it cannot name; the app has one word for friends.
        nameLabel.text = ring.from.displayName == "Кто-то из своих" ? "Кто-то из друзей" : ring.from.displayName
        var line = "зовёт в комнату"
        if let room { line += " · " + RoomRules.insideLine(room.inside.count) }
        lineLabel.text = line
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        avatar.frame = CGRect(x: 10, y: 10, width: 46, height: 46)
        let enterWide = ceil(enterButton.sizeThatFits(CGSize(width: 200, height: 42)).width) + 32
        enterButton.frame = CGRect(x: width - 10 - enterWide, y: 12, width: enterWide, height: 42)
        laterButton.frame = CGRect(x: enterButton.frame.minX - 12 - 42, y: 12, width: 42, height: 42)
        let left: CGFloat = 10 + 46 + 12
        let wide = max(0, laterButton.frame.minX - 12 - left)
        nameLabel.frame = CGRect(x: left, y: 13, width: wide, height: 20)
        lineLabel.frame = CGRect(x: left, y: 35, width: wide, height: 18)
    }

    @objc private func later() { Rooms.shared.dismissRing() }
    @objc private func enter() { Rooms.shared.answerRing() }
}

/// The strip shown over every screen while this phone is inside a room and the room's own screen is not the one
/// on top (the reference's `VoiceBar`): the state of the voice, the room's name and how many are inside; a tap
/// opens the room; the microphone and the way out are on the right.
final class RoomBarView: RoomGlassView {
    static let tall: CGFloat = 48
    private let opener = UIControl()
    private let dot = UIView()
    private let heading = UILabel()
    private let words = UILabel()
    private let micButton = UIButton(type: .custom)
    private let leaveButton = UIButton(type: .custom)
    // ScreenShare: «Остановить демонстрацию» while this phone shares its screen (the reference's VoiceBar).
    private let stopShareButton = UIButton(type: .custom)
    private var roomId = ""
    /// Channels: the bar of a community's voice channel opens the community.
    private var communityId: String?

    init() {
        super.init(radius: 18, clear: false)
        opener.addTarget(self, action: #selector(open), for: .touchUpInside)
        content.addSubview(opener)
        dot.layer.cornerRadius = 4
        dot.isUserInteractionEnabled = false
        opener.addSubview(dot)
        heading.font = .systemFont(ofSize: 13, weight: .bold)
        opener.addSubview(heading)
        words.font = .systemFont(ofSize: 12)
        words.textColor = Theme.muted
        opener.addSubview(words)
        opener.isAccessibilityElement = true
        opener.accessibilityTraits = .button
        micButton.addTarget(self, action: #selector(mute), for: .touchUpInside)
        // `IconButton`: 44 round of clear glass that gives a little under the finger.
        micButton.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        GlassBacking.put(under: micButton)
        content.addSubview(micButton)
        leaveButton.setImage(IonIcon.image("call", size: 18), for: .normal)
        leaveButton.tintColor = .white
        leaveButton.backgroundColor = Theme.danger
        leaveButton.layer.cornerRadius = 20
        leaveButton.accessibilityLabel = "Отключиться"
        leaveButton.addTarget(self, action: #selector(leave), for: .touchUpInside)
        content.addSubview(leaveButton)
        // ScreenShare
        stopShareButton.setImage(IonIcon.image("stop-circle-outline", size: 23), for: .normal)
        stopShareButton.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        GlassBacking.put(under: stopShareButton)
        stopShareButton.tintColor = Theme.danger
        stopShareButton.accessibilityLabel = "Остановить демонстрацию"
        stopShareButton.addAction(UIAction { _ in ScreenShare.shared.stop() }, for: .touchUpInside)
        stopShareButton.isHidden = true
        content.addSubview(stopShareButton)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ voice: RoomVoiceState) {
        roomId = voice.roomId
        communityId = voice.communityId
        let connected = voice.status == "connected"
        let green = UIColor(hex: 0x2FD27A)
        dot.backgroundColor = connected ? green : UIColor(hex: 0xF5C542)
        heading.text = connected ? "Голосовая связь" : "Подключение…"
        heading.textColor = connected ? green : Theme.muted
        var line = voice.name + " · Комната"
        if connected {
            let flowing = voice.peers.filter { (peer: RoomVoicePeer) -> Bool in peer.connected }.count
            line += " · \(flowing + 1) внутри"
        }
        if voice.communityId != nil {
            // A community's voice channel: «канал · сервер · N в канале».
            line = voice.name + " · " + voice.communityName
            if connected {
                let flowing = voice.peers.filter { (peer: RoomVoicePeer) -> Bool in peer.connected }.count
                line += " · \(flowing + 1) в канале"
            }
        }
        words.text = line
        opener.accessibilityLabel = (voice.communityId != nil ? "Голосовой канал " : "Комната ") + voice.name
        micButton.setImage(IonIcon.image(voice.muted ? "mic-off" : "mic", size: 21), for: .normal)
        micButton.tintColor = voice.muted ? Theme.danger : Theme.text
        micButton.accessibilityLabel = voice.muted ? "Включить микрофон" : "Выключить микрофон"
        stopShareButton.isHidden = ScreenShare.shared.sharing == nil // ScreenShare
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width, height = bounds.height
        // paddingRight 4, gap 8: the way out (40), the microphone and the stop button (`IconButton`, 44 each).
        leaveButton.frame = CGRect(x: width - 4 - 40, y: (height - 40) / 2, width: 40, height: 40)
        micButton.frame = CGRect(x: leaveButton.frame.minX - 8 - 44, y: (height - 44) / 2, width: 44, height: 44)
        // ScreenShare: the stop button left of the microphone while sharing.
        stopShareButton.frame = CGRect(x: micButton.frame.minX - 8 - 44, y: (height - 44) / 2, width: 44, height: 44)
        let openerEnd = stopShareButton.isHidden ? micButton.frame.minX : stopShareButton.frame.minX
        opener.frame = CGRect(x: 0, y: 0, width: openerEnd - 8, height: height)
        dot.frame = CGRect(x: 12, y: (height - 8) / 2, width: 8, height: 8)
        heading.frame = CGRect(x: 29, y: 7, width: max(0, opener.bounds.width - 29), height: 17)
        words.frame = CGRect(x: 29, y: 25, width: max(0, opener.bounds.width - 29), height: 16)
    }

    @objc private func open() {
        if let communityId { return RoomRouter.openCommunity(communityId) }
        RoomRouter.open(roomId)
    }
    @objc private func mute() { RoomVoice.shared.toggleMute() }
    @objc private func leave() { Rooms.shared.exit() }
}

/// Puts the room's ring and bar on the screen and takes them off: the ring wherever the person is in the app, the
/// bar while this phone is inside a room whose screen is not on top (every screen then starts lower by the bar's
/// height, so nothing hides under it). Main queue.
final class RoomOverlay {
    static let shared = RoomOverlay()
    private var window: RoomWindow?
    private let host = RoomHostController()
    private var watching = false
    private var barRoom = false

    private init() {}

    /// Begins to follow the rooms and the voice. Called by the shell.
    func start() {
        if !watching {
            watching = true
            NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: Rooms.changed, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: RoomVoice.changed, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(callMoved), name: Calls.changed, object: nil)
        }
        refresh()
    }

    /// The overlay of calls gives the screens their room back when a call is gone (CallOverlay.swift): the room's
    /// bar, if it is shown, takes its own room again right after.
    @objc private func callMoved() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.barRoom = false
            self.refresh()
        }
    }

    private var appWindow: UIWindow? {
        for scene in UIApplication.shared.connectedScenes {
            guard let scene = scene as? UIWindowScene else { continue }
            for window in scene.windows where window.rootViewController is NavigationController { return window }
        }
        return nil
    }

    private func makeWindow() -> RoomWindow? {
        if let window { return window }
        guard let scene = appWindow?.windowScene else { return nil }
        let made = RoomWindow(windowScene: scene)
        made.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 0.5)
        made.backgroundColor = .clear
        made.overrideUserInterfaceStyle = Theme.dark ? .dark : .light
        made.rootViewController = host
        made.isHidden = false
        window = made
        return made
    }

    /// The app's screens start lower while the bar is shown.
    private func setBarRoom(_ on: Bool) {
        if on == barRoom { return }
        barRoom = on
        guard let root = appWindow?.rootViewController else { return }
        root.additionalSafeAreaInsets.top = on ? RoomBarView.tall + 6 : 0
        UIView.animate(withDuration: 0.25) { root.view.layoutIfNeeded() }
    }

    /// Also asked by the room's own screen when it comes to the top or leaves it.
    @objc func refresh() {
        let ring = Rooms.shared.ring
        var voice = RoomVoice.shared.state
        // The room's own screen has the same controls: no bar over it. A one-to-one call has its own bar.
        if let shown = voice, let top = RoomRouter.navigation()?.topViewController as? RoomViewController, top.roomId == shown.roomId { voice = nil }
        // Channels: the community's own screen shows its voice panel.
        if let shown = voice, let id = shown.communityId, let top = RoomRouter.navigation()?.topViewController as? CommunityViewController, top.shownCommunityId == id { voice = nil }
        if Calls.shared.call != nil { voice = nil }
        guard ring != nil || voice != nil else {
            setBarRoom(false)
            window?.isHidden = true
            window = nil
            return
        }
        guard makeWindow() != nil else { return }
        host.loadViewIfNeeded()
        if let voice {
            host.bar.show(voice)
            host.bar.isHidden = false
            setBarRoom(true)
        } else {
            host.bar.isHidden = true
            setBarRoom(false)
        }
        if let ring {
            host.banner.show(ring, room: Rooms.shared.room(ring.roomId))
            host.banner.isHidden = false
        } else {
            host.banner.isHidden = true
        }
        host.view.setNeedsLayout()
    }
}
