import UIKit

/// A person's round picture; without one — their colour as a lit ball with their initials (as in the chat list).
final class PersonAvatarView: UIView {
    private let orb = CAGradientLayer()
    private let letters = UILabel()
    private let picture = UIImageView()
    private var pictureKey = ""
    private var pictureAddress = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        isUserInteractionEnabled = false
        // components.tsx:150 `Avatar`: [lighter, colour, deeper] from (.9, 1) to (.1, 0) — the lighter at the bottom right.
        orb.startPoint = CGPoint(x: 0.9, y: 1)
        orb.endPoint = CGPoint(x: 0.1, y: 0)
        layer.addSublayer(orb)
        letters.textColor = .white
        letters.textAlignment = .center
        letters.adjustsFontSizeToFitWidth = true
        letters.minimumScaleFactor = 0.6
        addSubview(letters)
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.isHidden = true
        addSubview(picture)
        NotificationCenter.default.addObserver(self, selector: #selector(pictureReady(_:)), name: ChatAvatarStore.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// `address`: where the picture is (empty when the person has none).
    func show(_ person: Person, address: String) {
        let pair = orbPair(person.avatarColor)
        let light = UIColor(hex: UInt32(truncatingIfNeeded: pair.light) & 0xFFFFFF)
        let deep = UIColor(hex: UInt32(truncatingIfNeeded: pair.deep) & 0xFFFFFF)
        orb.colors = [light.cgColor, UIColor(hex: person.avatarColor).cgColor, deep.cgColor]
        letters.text = Messenger.initials(person.displayName)
        pictureKey = person.avatarId
        pictureAddress = address
        loadPicture()
    }

    private func loadPicture() {
        var image: UIImage? = nil
        if !pictureKey.isEmpty && !pictureAddress.isEmpty { image = ChatAvatarStore.shared.image(key: pictureKey, url: pictureAddress) }
        picture.image = image
        picture.isHidden = image == nil
    }

    @objc private func pictureReady(_ note: Notification) {
        guard let key = note.object as? String, key == pictureKey, !key.isEmpty else { return }
        loadPicture()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        orb.frame = bounds
        CATransaction.commit()
        picture.frame = bounds
        letters.frame = bounds.insetBy(dx: bounds.width * 0.12, dy: 0)
        letters.font = .systemFont(ofSize: bounds.width * 0.36, weight: .bold)
        layer.cornerRadius = min(bounds.width, bounds.height) / 2
    }
}
