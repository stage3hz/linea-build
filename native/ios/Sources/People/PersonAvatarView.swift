import UIKit

/// A person's round picture; without one — their colour as a lit ball with their initials (as in the chat list).
final class PersonAvatarView: UIView {
    private let orb = AvatarOrb.bodyLayer()
    private let shine = AvatarOrb.shineLayer()
    private let letters = UILabel()
    private var lettersText = ""
    private var lettersRGB: UInt32 = 0
    private let picture = UIImageView()
    private var pictureKey = ""
    private var pictureAddress = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        isUserInteractionEnabled = false
        // components.tsx:150 `Avatar` (Avatars/AvatarOrb.swift): the ball, its white highlight, the initials.
        layer.addSublayer(orb)
        layer.addSublayer(shine)
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
        orb.colors = AvatarOrb.bodyColors(person.avatarColor)
        lettersText = Messenger.initials(person.displayName)
        lettersRGB = person.avatarColor
        setLetters()
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

    private func setLetters() {
        letters.attributedText = AvatarOrb.letters(lettersText, side: bounds.width, rgb: lettersRGB)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        orb.frame = bounds
        shine.frame = bounds
        CATransaction.commit()
        picture.frame = bounds
        letters.frame = bounds.insetBy(dx: bounds.width * 0.12, dy: 0)
        setLetters()
        layer.cornerRadius = min(bounds.width, bounds.height) / 2
    }
}
