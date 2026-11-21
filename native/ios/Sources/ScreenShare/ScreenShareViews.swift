import LiveKitWebRTC
import UIKit

/// A shared screen on the screen (`ScreenVideo` of the reference: the whole picture, black around it). Draws nothing
/// until it is given a track (or, in the simulator's samples, a drawn frame).
final class ScreenVideoView: UIView {
    private var surface: LKRTCMTLVideoView?
    private var track: LKRTCVideoTrack?
    private let still = UIImageView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
        still.contentMode = .scaleAspectFit
        still.frame = bounds
        still.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(still)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ next: LKRTCVideoTrack?) {
        if track === next { return }
        if let track, let surface { track.remove(surface) }
        track = next
        guard let next else {
            surface?.removeFromSuperview()
            surface = nil
            return
        }
        let made = surface ?? LKRTCMTLVideoView(frame: bounds)
        if surface == nil {
            made.videoContentMode = .scaleAspectFit
            made.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            made.frame = bounds
            addSubview(made)
            surface = made
        }
        next.add(made)
    }

    /// The simulator's drawn frame (nil: none).
    func showStill(_ image: UIImage?) {
        still.image = image
    }

    /// The screen of a person (or this phone's own: peer "self").
    func show(peer: String, track: LKRTCVideoTrack?) {
        show(track)
        #if targetEnvironment(simulator)
        if ScreenShare.shared.isDemo { showStill(ScreenShare.shared.demoFrames[peer]) }
        #endif
    }

    deinit {
        if let track, let surface { track.remove(surface) }
    }
}

/// The «Демонстрация экрана» part of a voice channel's panel: the reference's ScreenSharePanel.tsx — the two
/// qualities (or «Остановить демонстрацию»), the warning, «Отменить запуск» while the system's sheet is up, the
/// notice of what went wrong, «Твой экран», and every person's screen with their name and quality. A touch on a
/// screen opens it on the whole screen (ScreenViewerController).
final class ScreenSharePanel: UIView {
    /// The name of a person by id (the community's people); nil: «Участник».
    var names: ((String) -> String?)?
    private let column = UIStackView()
    private let heading = UILabel()
    private let buttons = UIStackView()
    private let low = ScreenShareButton()
    private let high = ScreenShareButton()
    private let stopButton = ScreenShareButton()
    private let note = UILabel()
    private let cancel = UIButton(type: .system)
    private let problem = UILabel()
    private let ownTitle = UILabel()
    private let ownVideo = ScreenVideoView()
    private var tiles: [String: (box: UIView, title: UILabel, video: ScreenVideoView)] = [:]
    private let screensColumn = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        column.axis = .vertical
        column.spacing = 10
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor), column.bottomAnchor.constraint(equalTo: bottomAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor), column.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        heading.text = "Демонстрация экрана"
        heading.font = .systemFont(ofSize: 15, weight: .bold)
        heading.textColor = Theme.text
        heading.accessibilityTraits = .header
        buttons.axis = .horizontal
        buttons.spacing = 8
        buttons.distribution = .fillEqually
        low.addAction(UIAction { [weak self] _ in self?.start(.p720) }, for: .touchUpInside)
        high.addAction(UIAction { [weak self] _ in self?.start(.p1080) }, for: .touchUpInside)
        stopButton.addAction(UIAction { _ in ScreenShare.shared.stop() }, for: .touchUpInside)
        for button in [low, high, stopButton] { buttons.addArrangedSubview(button) }
        note.font = .systemFont(ofSize: 12)
        note.textColor = Theme.muted
        note.numberOfLines = 0
        note.text = "Фактическое качество зависит от устройства и сети. Всё, что видно на экране, может попасть в трансляцию."
        cancel.setTitle("Отменить запуск", for: .normal)
        cancel.setTitleColor(Theme.accent, for: .normal)
        cancel.titleLabel?.font = .systemFont(ofSize: 14, weight: .medium)
        cancel.contentHorizontalAlignment = .leading
        cancel.addAction(UIAction { _ in ScreenShare.shared.stop() }, for: .touchUpInside)
        problem.font = .systemFont(ofSize: 13)
        problem.textColor = Theme.danger
        problem.numberOfLines = 0
        problem.isUserInteractionEnabled = true
        problem.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(clearProblem)))
        ownTitle.text = "Твой экран"
        ownTitle.font = .systemFont(ofSize: 13)
        ownTitle.textColor = Theme.muted
        ownVideo.layer.cornerRadius = 10
        ownVideo.heightAnchor.constraint(equalTo: ownVideo.widthAnchor, multiplier: 9.0 / 16.0).isActive = true
        screensColumn.axis = .vertical
        screensColumn.spacing = 10
        for part in [heading, buttons, note, cancel, problem, ownTitle, ownVideo, screensColumn] as [UIView] { column.addArrangedSubview(part) }
        column.setCustomSpacing(4, after: ownTitle)
    }

    required init?(coder: NSCoder) { return nil }

    private func start(_ quality: ScreenQuality) {
        ScreenShare.shared.start(quality) { (_: String?) -> Void in }
    }

    @objc private func clearProblem() { ScreenShare.shared.clearError() }

    func show(_ voice: RoomVoiceState) {
        let share = ScreenShare.shared
        let connected = voice.status == "connected"
        let sharing = share.sharing != nil
        low.isHidden = sharing
        high.isHidden = sharing
        stopButton.isHidden = !sharing
        low.show(words: ScreenQuality.p720.label, danger: false, enabled: !share.starting && connected, dim: share.starting)
        high.show(words: ScreenQuality.p1080.label, danger: false, enabled: !share.starting && connected, dim: share.starting)
        stopButton.show(words: "Остановить демонстрацию", danger: true, enabled: true, dim: false)
        cancel.isHidden = !share.starting
        problem.text = share.error
        problem.isHidden = share.error.isEmpty
        ownTitle.isHidden = !(sharing && share.localTrack != nil)
        ownVideo.isHidden = ownTitle.isHidden
        #if targetEnvironment(simulator)
        if share.isDemo && sharing {
            ownTitle.isHidden = false
            ownVideo.isHidden = false
        }
        #endif
        ownVideo.show(peer: "self", track: share.localTrack)
        let screens = share.screens
        let wanted = Set(screens.map { (item: ScreenShare.Screen) -> String in item.peer })
        for (peer, tile) in tiles where !wanted.contains(peer) {
            tile.video.show(nil)
            tile.box.removeFromSuperview()
            tiles[peer] = nil
        }
        for (index, screen) in screens.enumerated() {
            let tile = tiles[screen.peer] ?? makeTile(screen.peer)
            var name = names?(screen.userId) ?? "Участник"
            if name.isEmpty { name = "Участник" }
            tile.title.text = name + " · " + screen.quality.label
            tile.box.accessibilityLabel = "Экран: " + name
            tile.video.show(peer: screen.peer, track: screen.track)
            if screensColumn.arrangedSubviews.firstIndex(of: tile.box) != index {
                tile.box.removeFromSuperview()
                screensColumn.insertArrangedSubview(tile.box, at: min(index, screensColumn.arrangedSubviews.count))
            }
        }
        screensColumn.isHidden = screens.isEmpty
    }

    private func makeTile(_ peer: String) -> (box: UIView, title: UILabel, video: ScreenVideoView) {
        let box = UIControl()
        let title = UILabel()
        title.font = .systemFont(ofSize: 14, weight: .medium)
        title.textColor = Theme.text
        title.isUserInteractionEnabled = false
        let video = ScreenVideoView()
        video.layer.cornerRadius = 10
        video.isUserInteractionEnabled = false
        let stack = UIStackView(arrangedSubviews: [title, video])
        stack.axis = .vertical
        stack.spacing = 4
        stack.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: box.topAnchor), stack.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor), stack.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            video.heightAnchor.constraint(equalTo: video.widthAnchor, multiplier: 9.0 / 16.0),
        ])
        box.isAccessibilityElement = true
        box.accessibilityTraits = .button
        box.accessibilityHint = "Открыть на весь экран"
        box.addAction(UIAction { [weak self] _ in self?.open(peer) }, for: .touchUpInside)
        let tile = (box: box as UIView, title: title, video: video)
        tiles[peer] = tile
        return tile
    }

    private func open(_ peer: String) {
        guard let top = ScreenViewerController.topController(from: window) else { return }
        let viewer = ScreenViewerController(peer: peer, names: names)
        top.present(viewer, animated: true)
    }
}

/// A button of the panel: «720p · 60 FPS» in the accent's soft colour, «Остановить демонстрацию» in red.
final class ScreenShareButton: UIControl {
    private let words = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 12
        words.font = .systemFont(ofSize: 14, weight: .semibold)
        words.textAlignment = .center
        words.adjustsFontSizeToFitWidth = true
        words.minimumScaleFactor = 0.75
        words.isUserInteractionEnabled = false
        words.translatesAutoresizingMaskIntoConstraints = false
        addSubview(words)
        NSLayoutConstraint.activate([
            words.topAnchor.constraint(equalTo: topAnchor, constant: 12), words.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            words.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8), words.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
        ])
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    func show(words text: String, danger: Bool, enabled: Bool, dim: Bool) {
        words.text = text
        words.textColor = danger ? .white : Theme.accent
        backgroundColor = danger ? Theme.danger : ThemeStore.look.accentSoft
        isEnabled = enabled
        alpha = dim ? 0.5 : 1
        accessibilityLabel = text
        accessibilityTraits = enabled ? UIAccessibilityTraits.button : UIAccessibilityTraits([.button, .notEnabled])
    }

    override var isHighlighted: Bool {
        didSet { if isEnabled { alpha = isHighlighted ? 0.7 : 1 } }
    }
}

/// A person's screen on the whole phone screen: pinch or double-tap to look closer, «Повернуть» for a computer's wide
/// screen (the app itself stays upright), the name and the quality on top, «Закрыть». Closes by itself when the
/// person stops sharing.
final class ScreenViewerController: UIViewController, UIScrollViewDelegate {
    private let peer: String
    private let names: ((String) -> String?)?
    private let scroll = UIScrollView()
    /// What is zoomed; the picture inside it is turned (zooming sets the holder's own transform).
    private let holder = UIView()
    private let video = ScreenVideoView()
    private let top = UIView()
    private let titleLabel = UILabel()
    private let closeButton = UIButton(type: .system)
    private let turnButton = UIButton(type: .system)
    private var turned = false
    private var chromeHidden = false

    init(peer: String, names: ((String) -> String?)?) {
        self.peer = peer
        self.names = names
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    /// The controller on top of a window, for presenting.
    static func topController(from window: UIWindow?) -> UIViewController? {
        var found = window?.rootViewController
        while let shown = found?.presentedViewController { found = shown }
        return found
    }

    override var prefersStatusBarHidden: Bool { chromeHidden }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        scroll.delegate = self
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 4
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.backgroundColor = .black
        view.addSubview(scroll)
        holder.backgroundColor = .black
        scroll.addSubview(holder)
        holder.addSubview(video)
        let single = UITapGestureRecognizer(target: self, action: #selector(toggleChrome))
        let double = UITapGestureRecognizer(target: self, action: #selector(zoomTap(_:)))
        double.numberOfTapsRequired = 2
        single.require(toFail: double)
        scroll.addGestureRecognizer(single)
        scroll.addGestureRecognizer(double)

        top.backgroundColor = UIColor(white: 0, alpha: 0.45)
        view.addSubview(top)
        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLabel.textColor = .white
        titleLabel.textAlignment = .center
        top.addSubview(titleLabel)
        let symbols = UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
        closeButton.setImage(UIImage(systemName: "xmark", withConfiguration: symbols), for: .normal)
        closeButton.tintColor = .white
        closeButton.accessibilityLabel = "Закрыть"
        closeButton.addTarget(self, action: #selector(close), for: .touchUpInside)
        top.addSubview(closeButton)
        turnButton.setImage(UIImage(systemName: "rotate.right", withConfiguration: symbols), for: .normal)
        turnButton.tintColor = .white
        turnButton.accessibilityLabel = "Повернуть"
        turnButton.addTarget(self, action: #selector(turn), for: .touchUpInside)
        top.addSubview(turnButton)

        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: ScreenShare.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: RoomVoice.changed, object: nil)
        refresh()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, height = view.bounds.height, inset = view.safeAreaInsets.top
        scroll.frame = view.bounds
        if scroll.zoomScale == 1 {
            holder.frame = view.bounds
            scroll.contentSize = view.bounds.size
        }
        video.transform = .identity
        video.bounds = CGRect(x: 0, y: 0, width: turned ? height : width, height: turned ? width : height)
        video.center = CGPoint(x: width / 2, y: height / 2)
        if turned { video.transform = CGAffineTransform(rotationAngle: .pi / 2) }
        top.frame = CGRect(x: 0, y: 0, width: width, height: inset + 52)
        closeButton.frame = CGRect(x: 8, y: inset + 4, width: 44, height: 44)
        turnButton.frame = CGRect(x: width - 52, y: inset + 4, width: 44, height: 44)
        titleLabel.frame = CGRect(x: 60, y: inset + 4, width: max(0, width - 120), height: 44)
    }

    @objc private func refresh() {
        guard let screen = ScreenShare.shared.screens.first(where: { (item: ScreenShare.Screen) -> Bool in item.peer == peer }) else {
            // The person stopped sharing (or left).
            if presentingViewController != nil, !isBeingDismissed { dismiss(animated: true) }
            return
        }
        var name = names?(screen.userId) ?? "Участник"
        if name.isEmpty { name = "Участник" }
        titleLabel.text = name + " · " + screen.quality.label
        video.show(peer: screen.peer, track: screen.track)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { holder }

    @objc private func zoomTap(_ tap: UITapGestureRecognizer) {
        if scroll.zoomScale > 1 {
            scroll.setZoomScale(1, animated: true)
        } else {
            let point = tap.location(in: holder)
            let width = holder.bounds.width / 2.5, height = holder.bounds.height / 2.5
            scroll.zoom(to: CGRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height), animated: true)
        }
    }

    @objc private func toggleChrome() {
        chromeHidden.toggle()
        UIView.animate(withDuration: 0.2) {
            self.top.alpha = self.chromeHidden ? 0 : 1
            self.setNeedsStatusBarAppearanceUpdate()
        }
    }

    @objc private func turn() {
        turned.toggle()
        scroll.setZoomScale(1, animated: false)
        UIView.animate(withDuration: 0.25) {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    @objc private func close() { dismiss(animated: true) }
}

/// The room's screen: whoever shares their screen there, as small live pictures under the room's bar; a touch opens
/// the picture on the whole screen. (The reference's rooms show no panel of their own; a computer in a room can
/// still share, and this is where it is seen.)
final class ScreenShareStrip: UIView {
    private let roomId: String
    private let stack = UIStackView()
    private var chips: [String: (box: UIControl, video: ScreenVideoView, name: UILabel)] = [:]

    /// Puts the strip on a room's screen, under its bar.
    static func attach(to view: UIView, roomId: String) {
        let strip = ScreenShareStrip(roomId: roomId)
        strip.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(strip)
        NSLayoutConstraint.activate([
            strip.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 86),
            strip.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            strip.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -14),
        ])
    }

    init(roomId: String) {
        self.roomId = roomId
        super.init(frame: .zero)
        stack.axis = .horizontal
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: ScreenShare.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: RoomVoice.changed, object: nil)
        refresh()
    }

    required init?(coder: NSCoder) { return nil }

    private func name(_ userId: String) -> String {
        let person = Rooms.shared.room(roomId)?.members.first { (item: Person) -> Bool in item.id == userId }
        let words = person?.displayName ?? ""
        return words.isEmpty ? "Участник" : words
    }

    @objc private func refresh() {
        let here = RoomVoice.shared.state?.roomId == roomId
        let screens = here ? ScreenShare.shared.screens : []
        let wanted = Set(screens.map { (item: ScreenShare.Screen) -> String in item.peer })
        for (peer, chip) in chips where !wanted.contains(peer) {
            chip.video.show(nil)
            chip.box.removeFromSuperview()
            chips[peer] = nil
        }
        for screen in screens {
            let chip = chips[screen.peer] ?? makeChip(screen.peer)
            chip.name.text = name(screen.userId)
            chip.box.accessibilityLabel = "Экран: " + name(screen.userId)
            chip.video.show(peer: screen.peer, track: screen.track)
        }
        isHidden = screens.isEmpty
    }

    private func makeChip(_ peer: String) -> (box: UIControl, video: ScreenVideoView, name: UILabel) {
        let box = UIControl()
        box.backgroundColor = Theme.surface2.withAlphaComponent(0.92)
        box.layer.cornerRadius = 14
        let video = ScreenVideoView()
        video.layer.cornerRadius = 8
        video.isUserInteractionEnabled = false
        let icon = UIImageView(image: UIImage(systemName: "rectangle.on.rectangle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)))
        icon.tintColor = Theme.accent
        let label = UILabel()
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = Theme.text
        let line = UILabel()
        line.text = "показывает экран"
        line.font = .systemFont(ofSize: 11)
        line.textColor = Theme.muted
        let words = UIStackView(arrangedSubviews: [label, line])
        words.axis = .vertical
        words.spacing = 1
        let row = UIStackView(arrangedSubviews: [video, words, icon])
        row.axis = .horizontal
        row.spacing = 8
        row.alignment = .center
        row.isUserInteractionEnabled = false
        row.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: box.topAnchor, constant: 6), row.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -6),
            row.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 6), row.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -10),
            video.widthAnchor.constraint(equalToConstant: 64), video.heightAnchor.constraint(equalToConstant: 36),
        ])
        box.isAccessibilityElement = true
        box.accessibilityTraits = .button
        box.accessibilityHint = "Открыть на весь экран"
        box.addAction(UIAction { [weak self] _ in self?.open(peer) }, for: .touchUpInside)
        stack.addArrangedSubview(box)
        let chip = (box: box, video: video, name: label)
        chips[peer] = chip
        return chip
    }

    private func open(_ peer: String) {
        guard let top = ScreenViewerController.topController(from: window) else { return }
        let roomId = self.roomId
        let viewer = ScreenViewerController(peer: peer, names: { (userId: String) -> String? in
            Rooms.shared.room(roomId)?.members.first { (item: Person) -> Bool in item.id == userId }?.displayName
        })
        top.present(viewer, animated: true)
    }
}
