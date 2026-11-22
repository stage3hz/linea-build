import UIKit

// Small things the screens of «Каналы» share.

extension Server {
    /// A server operation whose answer (a JSON object) comes on the main queue.
    func ask(_ name: String, _ args: [Any], done: @escaping (Result<[String: Any], ServerError>) -> Void) {
        op(name, args) { (result: Result<Any, ServerError>) -> Void in
            let answer: Result<[String: Any], ServerError> = result.map { (body: Any) -> [String: Any] in body as? [String: Any] ?? [:] }
            DispatchQueue.main.async { done(answer) }
        }
    }
}

/// A community's round picture; without one — a cold gradient chosen by its id, its initials, and a small mark
/// of its kind (reference: parts.tsx CommunityAvatar).
final class CommunityAvatarView: UIView {
    private let gradient = CAGradientLayer()
    private let letters = UILabel()
    private let picture = UIImageView()
    private let mark = UIImageView()
    private var pictureId = ""
    private var markName = "game-controller"

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        isUserInteractionEnabled = false
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        layer.addSublayer(gradient)
        letters.textColor = .white
        letters.textAlignment = .center
        addSubview(letters)
        mark.contentMode = .center
        mark.tintColor = .white
        mark.backgroundColor = UIColor(white: 0, alpha: 0.35)
        mark.clipsToBounds = true
        addSubview(mark)
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.isHidden = true
        addSubview(picture)
        NotificationCenter.default.addObserver(self, selector: #selector(pictureReady(_:)), name: ChannelImages.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    func show(_ community: CommunitySummary) {
        show(id: community.id, name: community.name, avatarId: community.avatarId, blog: community.blog)
    }

    func show(id: String, name: String, avatarId: String, blog: Bool) {
        let pair = ChannelWords.gradient(id)
        gradient.colors = [UIColor(hex: pair.0).cgColor, UIColor(hex: pair.1).cgColor]
        letters.text = ChannelWords.initials(name)
        markName = blog ? "megaphone" : "game-controller"
        pictureId = avatarId
        loadPicture()
        setNeedsLayout()
    }

    private func loadPicture() {
        var image: UIImage? = nil
        if !pictureId.isEmpty, bounds.width > 0 {
            let scale = window?.screen.scale ?? traitCollection.displayScale
            image = ChannelImages.shared.image(id: pictureId, pixels: ChannelLook.pixels(bounds.size, scale: scale))
        }
        picture.image = image
        picture.isHidden = image == nil
    }

    @objc private func pictureReady(_ note: Notification) {
        guard let id = note.object as? String, id == pictureId, !id.isEmpty else { return }
        loadPicture()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.frame = bounds
        CATransaction.commit()
        picture.frame = bounds
        letters.frame = bounds
        letters.font = .systemFont(ofSize: bounds.width * 0.34, weight: .bold)
        let side = bounds.width * 0.3
        mark.frame = CGRect(x: bounds.width - side - 2, y: bounds.height - side - 2, width: side, height: side)
        mark.layer.cornerRadius = side / 2
        mark.image = IonIcon.image(markName, size: max(5, bounds.width * 0.17)) // the reference: size × 0.17
        layer.cornerRadius = min(bounds.width, bounds.height) / 2
        if picture.image == nil && !pictureId.isEmpty { loadPicture() }
    }
}

/// A counter on a row: «@» for mentions, a number for what is unread.
final class ChannelBadgeLabel: UILabel {
    override init(frame: CGRect) {
        super.init(frame: frame)
        font = .systemFont(ofSize: 11, weight: .heavy)
        textColor = Theme.onAccent
        textAlignment = .center
        backgroundColor = Theme.accent
        layer.cornerRadius = 10
        layer.masksToBounds = true
        isHidden = true
    }

    required init?(coder: NSCoder) { return nil }

    /// Shows the words (hidden when empty). `quiet`: the grey of a muted community.
    func show(_ words: String, quiet: Bool = false, spoken: String = "") {
        text = words
        isHidden = words.isEmpty
        backgroundColor = quiet ? Theme.subtle : Theme.accent
        accessibilityLabel = spoken
    }

    /// The width the badge takes (0 when hidden).
    var wide: CGFloat {
        if isHidden { return 0 }
        return max(20, ceil(sizeThatFits(CGSize(width: 80, height: 20)).width) + 12)
    }
}

/// Where the screens of the section lead to one another.
enum ChannelsRoute {
    /// Opens a community over the section's root (whatever form or preview was on top goes away).
    static func openCommunity(from screen: UIViewController, messenger: Messenger, id: String) {
        guard let stack = screen.navigationController, let root = stack.viewControllers.first else { return }
        stack.setViewControllers([root, CommunityViewController(messenger: messenger, communityId: id, known: nil)], animated: true)
    }

    /// Back to the section's root (the community is gone, or was left).
    static func closeCommunity(from screen: UIViewController) {
        screen.navigationController?.popToRootViewController(animated: true)
    }

    /// Asks the server what an invitation leads to, and shows it (reference: InviteSheet).
    static func openInvite(from screen: UIViewController, messenger: Messenger, code: String) {
        screen.navigationController?.pushViewController(InvitePage(messenger: messenger, code: code), animated: true)
    }
}
