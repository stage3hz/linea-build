import UIKit

/// One person's place in a room: the round picture with its ring (green while they talk, the text's colour around
/// this account when it is inside), the crossed microphone when theirs is off, the first name under it. A member
/// who is not inside right now is shown small and dim in their usual place.
private final class RoomSeatView: UIView {
    private let ring = UIView()
    private let avatar = PersonAvatarView()
    private let badge = UIView()
    private let badgeIcon = UIImageView()
    private let nameLabel = UILabel()
    private var side: CGFloat = 58

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        ring.backgroundColor = .clear
        addSubview(ring)
        addSubview(avatar)
        badge.backgroundColor = Theme.surface2
        badge.layer.cornerRadius = 13
        badge.layer.borderWidth = 2
        badge.layer.borderColor = Theme.bg.cgColor
        badgeIcon.image = UIImage(systemName: "mic.slash.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .regular))
        badgeIcon.tintColor = Theme.text
        badgeIcon.contentMode = .center
        badge.addSubview(badgeIcon)
        addSubview(badge)
        nameLabel.font = .systemFont(ofSize: 13, weight: .medium)
        nameLabel.textAlignment = .center
        addSubview(nameLabel)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { return nil }

    /// `center`: where the picture's middle is on the stage.
    func show(_ person: Person, mine: Bool, present: Bool, talking: Bool, muted: Bool, side: CGFloat, center: CGPoint) {
        self.side = side
        avatar.show(person, address: Rooms.shared.pictureAddress(person))
        ring.layer.borderWidth = talking ? 3 : 1.5
        ring.layer.borderColor = talking ? RoomRules.talk.cgColor : (mine && present ? Theme.text.cgColor : UIColor.clear.cgColor)
        badge.isHidden = !(present && muted)
        nameLabel.text = mine ? "ты" : RoomRules.firstName(person)
        nameLabel.textColor = present ? Theme.text : Theme.muted
        alpha = present ? 1 : (mine ? 0.7 : 0.3)
        let state = present ? (talking ? ", говорит" : (muted ? ", микрофон выключен" : ", в комнате")) : ", не в комнате"
        accessibilityLabel = (mine ? "Ты" : person.displayName) + state
        let box = side + 56
        frame = CGRect(x: center.x - box / 2, y: center.y - side / 2 - 6, width: box, height: side + 12 + 6 + 18)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let outer = side + 12
        ring.frame = CGRect(x: (bounds.width - outer) / 2, y: 0, width: outer, height: outer)
        // A thin ring sits a little inside the place of the thick one, so the picture never moves.
        let inset: CGFloat = ring.layer.borderWidth >= 3 ? 0 : 1.5
        ring.frame = ring.frame.insetBy(dx: inset, dy: inset)
        ring.layer.cornerRadius = ring.frame.width / 2
        avatar.frame = CGRect(x: (bounds.width - side) / 2, y: 6, width: side, height: side)
        badge.frame = CGRect(x: avatar.frame.maxX - 21, y: avatar.frame.maxY - 21, width: 26, height: 26)
        badgeIcon.frame = badge.bounds
        nameLabel.frame = CGRect(x: 0, y: outer + 6, width: bounds.width, height: 18)
    }
}

/// The light behind the people who are inside: each has a soft glow of their own colour, a little brighter while
/// they talk. The colours are kept quiet (little saturation, low alpha), so the stage reads as a calm room and not
/// as a bright many-coloured gradient.
private final class RoomLightsView: UIView {
    struct Light {
        let center: CGPoint
        let radius: CGFloat
        let color: UIColor
        let strength: CGFloat
    }

    /// How strong a person's light is: while talking and while quiet.
    static let talkingStrength: CGFloat = 0.2
    static let quietStrength: CGFloat = 0.11

    /// A person's colour (0xRRGGBB) made quiet for the light behind their seat: the same hue, far less saturated,
    /// a little lighter on a dark theme and a little deeper on a light one.
    static func calm(_ rgb: UInt32) -> UIColor {
        let base = UIColor(hex: rgb)
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        guard base.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha) else { return base }
        let quiet: CGFloat = min(saturation * 0.45, 0.32)
        let level: CGFloat = Theme.dark ? max(brightness, 0.72) : min(max(brightness, 0.55), 0.78)
        return UIColor(hue: hue, saturation: quiet, brightness: level, alpha: 1)
    }

    var lights: [Light] = [] {
        didSet { setNeedsDisplay() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { return nil }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let space = CGColorSpaceCreateDeviceRGB()
        for light in lights {
            let colors = [light.color.withAlphaComponent(light.strength).cgColor, light.color.withAlphaComponent(0).cgColor] as CFArray
            guard let gradient = CGGradient(colorsSpace: space, colors: colors, locations: [0, 1]) else { continue }
            context.drawRadialGradient(gradient, startCenter: light.center, startRadius: 0, endCenter: light.center, endRadius: light.radius, options: [])
        }
    }
}

/// A round button of the room's controls (no word under it: its name is read aloud).
private final class RoomRoundButton: UIControl {
    private let icon = UIImageView()
    var onPress: (() -> Void)?

    init(size: CGFloat) {
        super.init(frame: CGRect(x: 0, y: 0, width: size, height: size))
        layer.cornerRadius = size / 2
        icon.contentMode = .center
        icon.isUserInteractionEnabled = false
        addSubview(icon)
        isAccessibilityElement = true
        accessibilityTraits = .button
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    func show(symbol: String, words: String, fill: UIColor, tint: UIColor, bordered: Bool) {
        icon.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: bounds.width * 0.38, weight: .medium))
        icon.tintColor = tint
        backgroundColor = fill
        layer.borderWidth = bordered ? 1 : 0
        layer.borderColor = Theme.veil(0.18).cgColor
        accessibilityLabel = words
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        icon.frame = bounds
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.75 : 1 }
    }

    @objc private func pressed() { onPress?() }
}

/// A room on screen (the reference's `RoomScreen`): this account in the middle, the others around it, each with
/// their own light behind them. Whoever is talking gets a green ring. Above — a glass bar with the room's name,
/// how many are inside, and the room's actions; below — «Позвать всех» (rings like a call for those who are not
/// inside) and either «Зайти» or the microphone, the sound's route and the way out.
/// Pushed over «Каналы»: a swipe from the left edge goes back (the voice goes on — see RoomOverlay.swift).
final class RoomViewController: UIViewController {
    let roomId: String
    private let bar = UIVisualEffectView(effect: nil)
    private let backButton = UIButton(type: .system)
    private let nameLabel = UILabel()
    private let statusLabel = UILabel()
    private let moreButton = UIButton(type: .system)
    private let stage = UIView()
    private let lights = RoomLightsView()
    private var seatViews: [String: RoomSeatView] = [:]
    private let goneLabel = UILabel()
    private let goneButton = UIButton(type: .system)
    private let notice = UILabel()
    private let musicLine = RoomMusicLine()
    private let ringButton = UIButton(type: .system)
    private let enterButton = UIButton(type: .system)
    private let enterSpinner = UIActivityIndicatorView(style: .medium)
    private let speakerButton = RoomRoundButton(size: 60)
    private let micButton = RoomRoundButton(size: 74)
    private let leaveButton = RoomRoundButton(size: 60)

    private var speaking = Set<String>()
    private var speakingTimer: Timer?
    private var busy = false
    private var problem = ""
    private var rang = 0
    private var rangTimer: Timer?
    private var glassDark: Bool?

    init(roomId: String) {
        self.roomId = roomId
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        NotificationCenter.default.removeObserver(self)
        speakingTimer?.invalidate()
        rangTimer?.invalidate()
    }

    private var room: Room? { Rooms.shared.room(roomId) }
    private var here: Bool { RoomVoice.shared.state?.roomId == roomId }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg

        stage.clipsToBounds = true
        view.addSubview(stage)
        stage.addSubview(lights)

        bar.clipsToBounds = true
        bar.layer.cornerRadius = 27
        view.addSubview(bar)
        backButton.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        backButton.tintColor = Theme.text
        backButton.accessibilityLabel = "Назад"
        backButton.addTarget(self, action: #selector(back), for: .touchUpInside)
        bar.contentView.addSubview(backButton)
        nameLabel.font = Theme.title(Theme.TypeSize.roomTitle) // Fonts
        nameLabel.textColor = Theme.text
        nameLabel.accessibilityTraits = .header
        bar.contentView.addSubview(nameLabel)
        statusLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        bar.contentView.addSubview(statusLabel)
        moreButton.setImage(UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .semibold)), for: .normal)
        moreButton.tintColor = Theme.text
        moreButton.accessibilityLabel = "Действия с комнатой"
        moreButton.addTarget(self, action: #selector(openMenu), for: .touchUpInside)
        bar.contentView.addSubview(moreButton)

        goneLabel.font = .systemFont(ofSize: 15)
        goneLabel.textColor = Theme.muted
        goneLabel.textAlignment = .center
        goneLabel.numberOfLines = 0
        view.addSubview(goneLabel)
        goneButton.setTitle("Назад", for: .normal)
        goneButton.setTitleColor(Theme.text, for: .normal)
        goneButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        goneButton.backgroundColor = Theme.surface2
        goneButton.layer.cornerRadius = 22
        goneButton.addTarget(self, action: #selector(back), for: .touchUpInside)
        view.addSubview(goneButton)

        notice.font = .systemFont(ofSize: 13)
        notice.textColor = Theme.danger
        notice.textAlignment = .center
        notice.numberOfLines = 0
        view.addSubview(notice)
        view.addSubview(musicLine)

        ringButton.setTitleColor(Theme.text, for: .normal)
        ringButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .medium)
        ringButton.layer.cornerRadius = 18
        ringButton.layer.borderWidth = 1
        ringButton.layer.borderColor = Theme.veil(0.18).cgColor
        ringButton.accessibilityLabel = "Позвать всех"
        ringButton.addTarget(self, action: #selector(ringAll), for: .touchUpInside)
        view.addSubview(ringButton)

        enterButton.setTitle("  Зайти", for: .normal)
        enterButton.setImage(UIImage(systemName: "mic.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        enterButton.tintColor = Theme.onAccent
        enterButton.setTitleColor(Theme.onAccent, for: .normal)
        enterButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        enterButton.backgroundColor = Theme.accent
        enterButton.layer.cornerRadius = 25
        enterButton.accessibilityLabel = "Зайти"
        enterButton.addTarget(self, action: #selector(enter), for: .touchUpInside)
        view.addSubview(enterButton)
        enterSpinner.color = Theme.onAccent
        enterSpinner.hidesWhenStopped = true
        enterButton.addSubview(enterSpinner)

        speakerButton.onPress = { RoomVoice.shared.toggleSpeaker() }
        micButton.onPress = { RoomVoice.shared.toggleMute() }
        leaveButton.onPress = { Rooms.shared.exit() }
        leaveButton.show(symbol: "xmark", words: "Выйти из комнаты", fill: UIColor(hex: 0xFF4D5E), tint: .white, bordered: false)
        for button in [speakerButton, micButton, leaveButton] { view.addSubview(button) }
        ScreenShareStrip.attach(to: view, roomId: roomId) // ScreenShare: who shows their screen here

        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: Rooms.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: RoomVoice.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: RoomMusic.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: ChatAvatarStore.ready, object: nil)
        refresh()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refresh()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        speakingTimer?.invalidate()
        speakingTimer = nil
        // The room goes on without its screen: its bar takes over.
        RoomOverlay.shared.refresh()
    }

    // MARK: What is shown

    @objc private func refresh() {
        guard isViewLoaded else { return }
        watchSpeaking()
        view.setNeedsLayout()
    }

    /// Who is talking: asked of the connections a few times a second, only while this phone is inside and the
    /// screen is shown.
    private func watchSpeaking() {
        let wanted = here && view.window != nil
        if !wanted {
            speakingTimer?.invalidate()
            speakingTimer = nil
            if !speaking.isEmpty && !here { speaking = [] }
            return
        }
        if speakingTimer != nil { return }
        readSpeaking()
        speakingTimer = Timer.scheduledTimer(withTimeInterval: RoomRules.speakingPoll, repeats: true) { [weak self] (_: Timer) -> Void in self?.readSpeaking() }
    }

    private func readSpeaking() {
        RoomVoice.shared.speaking(me: Rooms.shared.userId) { [weak self] (heard: Set<String>) -> Void in
            guard let self, self.here, heard != self.speaking else { return }
            self.speaking = heard
            self.view.setNeedsLayout()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        watchSpeaking()
        RoomOverlay.shared.refresh()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, top = view.safeAreaInsets.top
        if bar.effect == nil || glassDark != Theme.dark {
            // The glass is made once the bar has a size (an effect made earlier does not draw).
            bar.frame = CGRect(x: 14, y: top + 12, width: width - 28, height: 64)
            bar.effect = TabGlass.effect(clear: true, interactive: false, dark: Theme.dark)
            glassDark = Theme.dark
        }
        bar.frame = CGRect(x: 14, y: top + 12, width: width - 28, height: 64)
        backButton.frame = CGRect(x: 6, y: 10, width: 44, height: 44)
        moreButton.frame = CGRect(x: bar.bounds.width - 6 - 44, y: 10, width: 44, height: 44)
        nameLabel.frame = CGRect(x: 54, y: 9, width: max(0, bar.bounds.width - 108), height: 26)
        statusLabel.frame = CGRect(x: 54, y: 36, width: max(0, bar.bounds.width - 108), height: 17)

        let me = Rooms.shared.userId
        guard let room else {
            // Not in the list: the list is still being read, could not be read, or the room is gone.
            let loading = Rooms.shared.rooms == nil
            nameLabel.text = "Комната"
            statusLabel.text = ""
            moreButton.isHidden = true
            goneLabel.text = loading ? (Rooms.shared.failure.isEmpty ? "Загрузка…" : Rooms.shared.failure) : "Этой комнаты больше нет."
            goneLabel.isHidden = false
            goneButton.isHidden = loading
            for part in [stage, notice, musicLine, ringButton, enterButton, speakerButton, micButton, leaveButton] as [UIView] { part.isHidden = true }
            let high = ceil(goneLabel.sizeThatFits(CGSize(width: width - 48, height: 300)).height)
            goneLabel.frame = CGRect(x: 24, y: view.bounds.midY - high - 7, width: width - 48, height: high)
            goneButton.frame = CGRect(x: (width - 140) / 2, y: view.bounds.midY + 7, width: 140, height: 44)
            return
        }
        goneLabel.isHidden = true
        goneButton.isHidden = true
        moreButton.isHidden = false
        stage.isHidden = false

        let voice = here ? RoomVoice.shared.state : nil
        // While inside, the engine's own list is the freshest; outside, the server's.
        var inside = Set<String>()
        var muted = Set<String>()
        for member in room.inside where member.muted { muted.insert(member.userId) }
        if let voice {
            inside.insert(me)
            for peer in voice.peers {
                inside.insert(peer.userId)
                if peer.muted { muted.insert(peer.userId) }
            }
            if voice.muted { muted.insert(me) } else { muted.remove(me) }
        } else {
            for member in room.inside { inside.insert(member.userId) }
        }

        nameLabel.text = room.name
        var status = ""
        if let voice {
            if voice.status == "connected" {
                let link = voice.link == "good" ? "" : CallRules.linkWords(voice.link)
                status = "комната · " + RoomRules.insideLine(inside.count)
                if !link.isEmpty { status += " · " + link }
            } else {
                status = "подключение…"
            }
        } else if !room.inside.isEmpty {
            status = "комната · " + RoomRules.insideLine(room.inside.count)
        } else {
            status = room.awake ? "комната · никого, ещё не спит" : RoomRules.sleepLine(room)
        }
        statusLabel.text = status
        statusLabel.textColor = inside.isEmpty ? Theme.muted : RoomRules.talk

        // The controls, from the bottom up.
        var bottom = view.bounds.height - 18 - view.safeAreaInsets.bottom
        let inRoom = voice != nil
        enterButton.isHidden = inRoom
        for button in [speakerButton, micButton, leaveButton] { button.isHidden = !inRoom }
        if let voice {
            speakerButton.show(symbol: voice.speaker ? "speaker.wave.2.fill" : "ear", words: voice.speaker ? "Звук на динамике" : "Звук в трубке", fill: .clear, tint: Theme.text, bordered: true)
            if voice.muted {
                micButton.show(symbol: "mic.slash.fill", words: "Включить микрофон", fill: Theme.surface2, tint: Theme.text, bordered: true)
            } else {
                micButton.show(symbol: "mic.fill", words: "Выключить микрофон", fill: Theme.text, tint: Theme.bg, bordered: false)
            }
            let rowTop = bottom - 74
            micButton.frame = CGRect(x: (width - 74) / 2, y: rowTop, width: 74, height: 74)
            speakerButton.frame = CGRect(x: micButton.frame.minX - 16 - 60, y: rowTop + 7, width: 60, height: 60)
            leaveButton.frame = CGRect(x: micButton.frame.maxX + 16, y: rowTop + 7, width: 60, height: 60)
            bottom = rowTop - 14
        } else {
            let wide = min(420, width - 36)
            enterButton.frame = CGRect(x: (width - wide) / 2, y: bottom - 50, width: wide, height: 50)
            enterSpinner.center = CGPoint(x: wide - 28, y: 25)
            if busy { enterSpinner.startAnimating() } else { enterSpinner.stopAnimating() }
            enterButton.alpha = busy ? 0.7 : 1
            enterButton.isEnabled = !busy
            bottom -= 50 + 14
        }
        ringButton.isHidden = false
        ringButton.setTitle(rang > 0 ? "Позвали: \(rang)" : "Позвать всех", for: .normal)
        let ringWide = ceil(ringButton.sizeThatFits(CGSize(width: 300, height: 36)).width) + 32
        ringButton.frame = CGRect(x: (width - ringWide) / 2, y: bottom - 36, width: ringWide, height: 36)
        bottom -= 36 + 14

        musicLine.show(inside: inRoom, members: room.members)
        if musicLine.tall > 0 {
            let wide = min(460, width - 36)
            musicLine.frame = CGRect(x: (width - wide) / 2, y: bottom - musicLine.tall, width: wide, height: musicLine.tall)
            bottom -= musicLine.tall + 14
        }

        var words = problem
        if let voice, !voice.error.isEmpty { words = words.isEmpty ? voice.error : words + "\n" + voice.error }
        if voice == nil, words.isEmpty, RoomVoice.shared.lastErrorRoom == roomId { words = RoomVoice.shared.lastError }
        notice.text = words
        notice.isHidden = words.isEmpty
        if !words.isEmpty {
            let high = ceil(notice.sizeThatFits(CGSize(width: width - 36, height: 200)).height)
            notice.frame = CGRect(x: 18, y: bottom - high, width: width - 36, height: high)
            bottom -= high + 14
        }

        // The stage and everyone's place on it.
        stage.frame = CGRect(x: 0, y: bar.frame.maxY, width: width, height: max(0, bottom - bar.frame.maxY))
        lights.frame = stage.bounds
        let places = RoomRules.seats(room, me: me)
        let stageWide = stage.bounds.width, stageHigh = stage.bounds.height
        // On a wide screen the people stay together in the middle instead of drifting to the edges.
        let span: CGFloat = min(stageWide, 620)
        let left: CGFloat = (stageWide - span) / 2
        let size: CGFloat = RoomRules.seatSize(members: room.members.count, stage: span > 0 ? span : 360)
        let pad: CGFloat = size * 0.62
        var lit: [RoomLightsView.Light] = []
        var kept = Set<String>()
        for member in room.members {
            let place = places[member.id] ?? CGPoint(x: 0.5, y: 0.5)
            let roomWide: CGFloat = max(0, span - pad * 2), roomHigh: CGFloat = max(0, stageHigh - pad * 2.1)
            let centerX: CGFloat = left + pad + place.x * roomWide
            let centerY: CGFloat = pad * 0.9 + place.y * roomHigh
            let center = CGPoint(x: centerX, y: centerY)
            let mine = member.id == me, present = inside.contains(member.id)
            let talking = present && speaking.contains(member.id)
            let full: CGFloat = mine ? size * 0.82 : size
            let scale: CGFloat = (present || mine) ? 1 : 0.72
            let side = (full * scale).rounded()
            let seat: RoomSeatView
            if let known = seatViews[member.id] { seat = known } else {
                seat = RoomSeatView()
                seatViews[member.id] = seat
                stage.addSubview(seat)
            }
            seat.show(member, mine: mine, present: present, talking: talking, muted: muted.contains(member.id), side: side, center: center)
            kept.insert(member.id)
            if present {
                let glow: UIColor = RoomLightsView.calm(member.avatarColor)
                let strength: CGFloat = talking ? RoomLightsView.talkingStrength : RoomLightsView.quietStrength
                lit.append(RoomLightsView.Light(center: center, radius: size * 2.1, color: glow, strength: strength))
            }
        }
        for (id, seat) in seatViews where !kept.contains(id) {
            seat.removeFromSuperview()
            seatViews[id] = nil
        }
        lights.lights = lit
    }

    // MARK: What the person does

    @objc private func back() { navigationController?.popViewController(animated: true) }

    @objc private func enter() {
        guard let room, !busy else { return }
        busy = true
        problem = ""
        view.setNeedsLayout()
        Rooms.shared.enter(room) { [weak self] (words: String?) -> Void in
            guard let self else { return }
            self.busy = false
            self.problem = words ?? ""
            self.view.setNeedsLayout()
        }
    }

    @objc private func ringAll() {
        problem = ""
        Rooms.shared.ringAll(roomId) { [weak self] (count: Int, words: String?) -> Void in
            guard let self else { return }
            if let words {
                self.problem = words
            } else {
                self.rang = count
                self.rangTimer?.invalidate()
                self.rangTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] (_: Timer) -> Void in
                    self?.rang = 0
                    self?.view.setNeedsLayout()
                }
            }
            self.view.setNeedsLayout()
        }
    }

    @objc private func openMenu() {
        guard let room, presentedViewController == nil else { return }
        let choices: [ChoiceSheet.Choice] = [
            ChoiceSheet.Choice(symbol: "square.and.pencil", label: "Переименовать", run: { [weak self] in self?.askName() }),
            ChoiceSheet.Choice(symbol: "rectangle.portrait.and.arrow.right", label: "Уйти из комнаты насовсем", note: "Она пропадёт из твоего списка. Остальные останутся.", danger: true, run: { [weak self] in self?.leaveForGood() }),
        ]
        present(ChoiceSheet(heading: room.name, choices: choices), animated: true)
    }

    /// «Название комнаты»: an empty field brings back the name made of the members' names.
    private func askName() {
        guard let room else { return }
        let alert = UIAlertController(title: "Название комнаты", message: "Пустое поле вернёт название из имён участников.", preferredStyle: .alert)
        alert.addTextField { (field: UITextField) -> Void in
            field.text = room.auto ? "" : room.name
            field.placeholder = "Например, Наши"
            field.autocapitalizationType = .sentences
            field.addTarget(self, action: #selector(self.nameEdited(_:)), for: .editingChanged)
        }
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        alert.addAction(UIAlertAction(title: "Сохранить", style: .default, handler: { [weak self, weak alert] (_: UIAlertAction) -> Void in
            guard let self else { return }
            let name = alert?.textFields?.first?.text ?? ""
            Rooms.shared.rename(self.roomId, name: name) { [weak self] (words: String?) -> Void in
                guard let self, let words else { return }
                self.problem = words
                self.view.setNeedsLayout()
            }
        }))
        present(alert, animated: true)
    }

    /// A room's name holds no more than the server takes.
    @objc private func nameEdited(_ field: UITextField) {
        let limit = RoomRules.maxName
        if let text = field.text, text.count > limit { field.text = String(text.prefix(limit)) }
    }

    private func leaveForGood() {
        Rooms.shared.leaveForGood(roomId) { [weak self] (words: String?) -> Void in
            guard let self else { return }
            if let words {
                self.problem = words
                self.view.setNeedsLayout()
            } else {
                self.back()
            }
        }
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: the room's actions, or the form of its name.
    func simulatorShow(_ what: String) {
        if what == "menu" { openMenu() } else if what == "rename" { askName() }
    }

    /// For the simulator check: who is drawn as talking.
    func simulatorSpeaking(_ ids: Set<String>) {
        speaking = ids
        view.setNeedsLayout()
    }
    #endif
}
