import UIKit

/// The soft edge under the chat's header and above its composer (Shell/EdgeFade.swift): the messages that pass
/// under the glass are covered by the chat's colour (the wallpaper's own colour at that edge) and fade out past it.
final class HeaderEdgeView: ProgressiveEdgeView {
    /// How strongly the colour covers (owner: as in the messenger he compared with — a plain colour .85, a gradient
    /// wallpaper .75, a picture .7).
    var alphaOfEdge: CGFloat = 0.85 {
        didSet { peak = alphaOfEdge }
    }

    override init(edge: ProgressiveEdgeView.Edge = .top) {
        super.init(edge: edge)
        peak = alphaOfEdge
        // Header: 34 pt past it, fading over 80 pt; composer: from 20 pt above it, fading over 60 pt.
        reach = edge == .top ? 34 : 20
        fade = edge == .top ? 34 : 60 // top: solid through the header, then gone within the 34 pt past it (nothing at rest is dimmed)
        // The header's pills are clear glass: the colour stays solid behind the whole header and fades past it.
        solidThroughBar = edge == .top
    }

    required init?(coder: NSCoder) { return nil }
}

/// A name in platinum (the reference's platina/PlatinaMark.tsx `PlatinaName`): the letters are a window onto
/// metal that slowly moves to and fro (3.6 s each way, ease in-out).
final class MetalNameView: UIView {
    private static let darkMetal: [UInt32] = [0xC9D0DC, 0xFFFFFF, 0x9AA4B6, 0xF3F5F9, 0xC9D0DC, 0xFFFFFF, 0x9AA4B6]
    private static let lightMetal: [UInt32] = [0x3B4352, 0x7D889C, 0x262C37, 0x5E687B, 0x3B4352, 0x8A95A8, 0x262C37]
    private let metal = CAGradientLayer()
    private let letters = UILabel()
    private var sheenWidth: CGFloat = -1

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.addSublayer(metal)
        metal.startPoint = CGPoint(x: 0, y: 0.3)
        metal.endPoint = CGPoint(x: 1, y: 0.7)
        letters.textColor = .black
        mask = letters
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ text: NSAttributedString, alignment: NSTextAlignment) {
        letters.attributedText = text
        letters.textAlignment = alignment
        letters.lineBreakMode = .byTruncatingTail
        metal.colors = (Theme.dark ? MetalNameView.darkMetal : MetalNameView.lightMetal).map { LookColor.color($0).cgColor }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        letters.frame = bounds
        let width = bounds.width
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        metal.frame = CGRect(x: 0, y: 0, width: width * 2.5, height: bounds.height)
        CATransaction.commit()
        if width == sheenWidth && metal.animation(forKey: "sheen") != nil { return }
        sheenWidth = width
        metal.removeAnimation(forKey: "sheen")
        guard width > 0, Motion.enabled else { return } // Effects: «Анимации интерфейса» (motionPolicy.ts)
        let sheen = CABasicAnimation(keyPath: "position.x")
        sheen.fromValue = metal.position.x
        sheen.toValue = metal.position.x - width * 1.5
        sheen.duration = 3.6
        sheen.autoreverses = true
        sheen.repeatCount = .infinity
        sheen.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        sheen.isRemovedOnCompletion = false
        metal.add(sheen, forKey: "sheen")
    }
}

/// The emoji status next to a name (the reference's statusEmojiModel.ts `visibleStatusEmoji`): one of a fixed set,
/// shown while it has not run out; a permanent one only with the server's explicit mark and no end.
enum StatusEmojiWords {
    static let allowed: [String] = ["✨", "⭐", "🌙", "☀️", "🌊", "🌿", "🔥", "💎", "🪐", "🎧", "🎮", "🦋", "🌛", "🌞", "🎶", "👾", "⚡", "❄️", "🌈", "👑"]

    static func visible(_ user: [String: Any], now: Date = Date()) -> String? {
        guard let emoji = user["statusEmoji"] as? String, allowed.contains(emoji) else { return nil }
        let expiry = user["statusEmojiExpiresAt"]
        if let permanent = user["statusEmojiPermanent"] as? Bool, permanent { return expiry is NSNull || expiry == nil ? emoji : nil }
        if let marker = user["statusEmojiPermanent"], (marker as? Bool) != false { return nil }
        guard let text = expiry as? String, let end = Messenger.date(text), end > now else { return nil }
        return emoji
    }
}

/// A long touch on the avatar in the header (the reference's ChatScreen.tsx avatar `ContextMenu`): a large card with
/// the picture (220 points), the name and the status, and under it «Открыть профиль» and «Поиск».
final class AvatarPeekController: UIViewController {
    struct Item {
        let symbol: String
        let label: String
        let run: () -> Void
    }

    private let picture: UIView
    private let name: String
    private let status: String
    private let items: [Item]
    private let top: CGFloat
    private let backdrop = UIVisualEffectView(effect: nil)
    private let card = UIView()
    private let menu = GlassPill(interactive: false)

    init(picture: UIView, name: String, status: String, top: CGFloat, items: [Item]) {
        self.picture = picture
        self.name = name
        self.status = status
        self.top = top
        self.items = items
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        backdrop.frame = view.bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(backdrop)
        let close = UITapGestureRecognizer(target: self, action: #selector(closeNow))
        backdrop.addGestureRecognizer(close)

        card.backgroundColor = Theme.dark ? UIColor(hex: 0x1C1C1E) : .white
        card.layer.cornerRadius = 28
        card.layer.cornerCurve = .continuous
        view.addSubview(card)
        card.addSubview(picture)
        let nameLabel = UILabel()
        nameLabel.text = name
        nameLabel.font = .systemFont(ofSize: 18, weight: .bold)
        nameLabel.textColor = Theme.text
        nameLabel.textAlignment = .center
        nameLabel.tag = 1
        card.addSubview(nameLabel)
        let statusLabel = UILabel()
        statusLabel.text = status
        statusLabel.font = .systemFont(ofSize: 14)
        statusLabel.textColor = Theme.muted
        statusLabel.textAlignment = .center
        statusLabel.tag = 2
        card.addSubview(statusLabel)

        menu.shape(radius: 18)
        view.addSubview(menu)
        for (index, item) in items.enumerated() {
            let row = UIButton(type: .system)
            row.tag = index
            row.contentHorizontalAlignment = .leading
            var config = UIButton.Configuration.plain()
            config.image = UIImage(systemName: item.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
            config.imagePadding = 12
            config.title = item.label
            config.baseForegroundColor = Theme.text
            config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
            row.configuration = config
            row.addTarget(self, action: #selector(chosen(_:)), for: .touchUpInside)
            menu.contentView.addSubview(row)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        let cardWidth: CGFloat = 220 + 36
        let cardHeight: CGFloat = 18 + 220 + 14 + 22 + 2 + 18 + 18
        card.frame = CGRect(x: (width - cardWidth) / 2, y: top, width: cardWidth, height: cardHeight)
        picture.frame = CGRect(x: 18, y: 18, width: 220, height: 220)
        card.viewWithTag(1)?.frame = CGRect(x: 12, y: 18 + 220 + 14, width: cardWidth - 24, height: 22)
        card.viewWithTag(2)?.frame = CGRect(x: 12, y: 18 + 220 + 14 + 24, width: cardWidth - 24, height: 18)
        let menuWidth: CGFloat = 250
        menu.frame = CGRect(x: (width - menuWidth) / 2, y: card.frame.maxY + 10, width: menuWidth, height: CGFloat(items.count) * 48)
        for case let row as UIButton in menu.contentView.subviews {
            row.frame = CGRect(x: 0, y: CGFloat(row.tag) * 48, width: menuWidth, height: 48)
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        card.transform = CGAffineTransform(scaleX: 0.86, y: 0.86)
        menu.transform = CGAffineTransform(translationX: 0, y: -12)
        menu.alpha = 0
        let spring = UISpringTimingParameters(mass: 1, stiffness: 320, damping: 24, initialVelocity: .zero)
        let animator = UIViewPropertyAnimator(duration: 0, timingParameters: spring)
        animator.addAnimations {
            self.backdrop.effect = UIBlurEffect(style: Theme.dark ? .systemThinMaterialDark : .systemThinMaterialLight)
            self.card.transform = .identity
            self.menu.transform = .identity
            self.menu.alpha = 1
        }
        animator.startAnimation()
    }

    @objc private func closeNow() { dismiss(animated: true) }

    @objc private func chosen(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < items.count else { return }
        let run = items[sender.tag].run
        dismiss(animated: true) { run() }
    }
}
