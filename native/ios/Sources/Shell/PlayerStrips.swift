import UIKit

/// What the shell lays over every section, for the screens that keep room for it at their bottom.
enum ShellInsets {
    /// Posted on the main queue when the mini-player came or went.
    static let changed = Notification.Name("invizent.shell.insets")
    /// The room the mini-player takes above the bar (its height and its gap), 0 while it is not shown.
    static var miniPlayer: CGFloat = 0
    static let miniHeight: CGFloat = 64
    static let miniGap: CGFloat = 8
}

/// The player strip under a chat's header while music plays (the reference's PlayerControls.tsx `TopPlayerBar`):
/// a glass pill 40 pt high, 12 pt from the sides — play/pause in the accent, the title (13 semibold) and the artist
/// (muted), «✕» that stops the music; a 2 pt progress line along its lower edge. A touch on the title opens the
/// full player.
final class TopPlayerBar: UIView {
    static let height: CGFloat = 40
    private let glass = UIVisualEffectView(effect: nil)
    private let toggle = UIButton(type: .system)
    private let words = UILabel()
    private let close = UIButton(type: .system)
    private let track = UIView()
    private let done = UIView()
    /// A touch on the title (the host opens the full player).
    var onOpen: (() -> Void)?
    /// The strip came or went: the host lays its screen out again.
    var onShownChanged: (() -> Void)?
    private var hadTrack: Bool?

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.effect = TabGlass.effect(clear: false, interactive: false, dark: Theme.dark)
        glass.layer.cornerRadius = 18
        glass.layer.cornerCurve = .continuous
        glass.clipsToBounds = true
        addSubview(glass)
        toggle.tintColor = Theme.accent
        toggle.addTarget(self, action: #selector(flip), for: .touchUpInside)
        addSubview(toggle)
        words.lineBreakMode = .byTruncatingTail
        words.isUserInteractionEnabled = true
        words.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open)))
        words.accessibilityTraits = .button
        addSubview(words)
        close.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        close.tintColor = Theme.muted
        close.accessibilityLabel = "Закрыть плеер и остановить музыку"
        close.addTarget(self, action: #selector(shut), for: .touchUpInside)
        addSubview(close)
        track.backgroundColor = Theme.veil(0.1)
        track.layer.cornerRadius = 1
        track.isUserInteractionEnabled = false
        addSubview(track)
        done.backgroundColor = Theme.accent
        done.layer.cornerRadius = 1
        track.addSubview(done)
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: MusicPlayer.changed, object: nil)
        refresh()
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// Whether a track is chosen (the strip is shown only then).
    var shown: Bool { MusicPlayer.shared.current != nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        toggle.frame = CGRect(x: 4, y: 0, width: 36, height: bounds.height)
        close.frame = CGRect(x: bounds.width - 2 - 36, y: 0, width: 36, height: bounds.height)
        words.frame = CGRect(x: 44, y: 0, width: max(0, close.frame.minX - 44), height: bounds.height)
        track.frame = CGRect(x: 14, y: bounds.height - 2, width: max(0, bounds.width - 28), height: 2)
        let player = MusicPlayer.shared
        let part = player.duration > 0 ? min(1, player.position / player.duration) : 0
        done.frame = CGRect(x: 0, y: 0, width: track.bounds.width * CGFloat(part), height: 2)
    }

    @objc private func refresh() {
        let player = MusicPlayer.shared
        let has = player.current != nil
        if hadTrack != has {
            hadTrack = has
            onShownChanged?()
        }
        guard let current = player.current else { return }
        toggle.setImage(UIImage(systemName: player.playing ? "pause.fill" : "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)), for: .normal)
        toggle.accessibilityLabel = player.playing ? "Пауза" : "Слушать"
        let line = NSMutableAttributedString(string: current.title, attributes: [.font: Theme.font(13, .semibold), .foregroundColor: Theme.text])
        line.append(NSAttributedString(string: "  " + current.artist, attributes: [.font: Theme.font(13), .foregroundColor: Theme.muted]))
        words.attributedText = line
        words.accessibilityLabel = "Открыть плеер: \(current.title), \(current.artist)"
        setNeedsLayout()
    }

    @objc private func flip() { MusicPlayer.shared.togglePlayback() }
    @objc private func shut() { MusicPlayer.shared.stop() }
    @objc private func open() { onOpen?() }
}

/// Music: the strip in a chat, under its header (the chat screen calls `place`).
final class ChatPlayerStrip {
    let bar = TopPlayerBar()
    private weak var host: UIViewController?

    init(host: UIViewController) {
        self.host = host
        bar.onOpen = { [weak self] in
            guard let host = self?.host, host.presentedViewController == nil else { return }
            host.view.endEditing(true)
            host.present(PlayerViewController(), animated: true)
        }
        bar.onShownChanged = { [weak host] in host?.view.setNeedsLayout() }
        host.view.addSubview(bar)
    }

    /// Places the strip under the header; gives the room it takes there (0 while nothing plays or while choosing).
    func place(in view: UIView, headerBottom: CGFloat, hidden: Bool) -> CGFloat {
        let show = bar.shown && !hidden
        bar.isHidden = !show
        guard show else { return 0 }
        view.bringSubviewToFront(bar)
        bar.frame = CGRect(x: 12, y: headerBottom + 4, width: view.bounds.width - 24, height: TopPlayerBar.height)
        return TopPlayerBar.height + 4
    }
}
