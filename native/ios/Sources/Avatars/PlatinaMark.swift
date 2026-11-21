import UIKit

// Platina's marks (the reference's platina/PlatinaMark.tsx): the platinum name — the letters a window onto moving
// metal —, the «PLATINA» seal that opens the showcase, and the small gem of list rows.

enum PlatinaMetal {
    /// Platinum: cool white metal with a slow light passing over it.
    static let platinum = ["#D9DEE8", "#FFFFFF", "#AEB8CA", "#F4F6FA", "#C3CBD9", "#FFFFFF"]
    static let name = ["#C9D0DC", "#FFFFFF", "#9AA4B6", "#F3F5F9", "#C9D0DC", "#FFFFFF", "#9AA4B6"]
    /// On a light theme white metal would vanish: dark polished platinum instead.
    static let nameLight = ["#3B4352", "#7D889C", "#262C37", "#5E687B", "#3B4352", "#8A95A8", "#262C37"]
    /// The metal of the big platinum buttons (showcase, offer).
    static let button = ["#E9EDF3", "#FFFFFF", "#BCC5D3", "#F6F8FB"]

    /// The metal's colours as one number each (0xAARRGGBB), for the chat list's `metal`.
    static func argb(_ colors: [String]) -> [Int] {
        return colors.map { (hex: String) -> Int in Int(UInt32(0xFF00_0000) | Messenger.color(hex)) }
    }
}

/// A gradient band 2.5× as wide as its host that slides across it and back (PlatinaMark.tsx `Sheen`).
final class SheenLayerView: UIView {
    private let gradient = CAGradientLayer()
    private var duration: Double = 3.6
    private var moving = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        gradient.startPoint = CGPoint(x: 0, y: 0.3)
        gradient.endPoint = CGPoint(x: 1, y: 0.7)
        gradient.anchorPoint = .zero
        layer.addSublayer(gradient)
        NotificationCenter.default.addObserver(self, selector: #selector(back), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    func set(colors: [String], moving: Bool, duration: Double) {
        gradient.colors = colors.map { lookColor($0).cgColor }
        self.moving = moving
        self.duration = duration
        restart()
    }

    @objc private func back() { restart() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { restart() }
    }

    private func restart() {
        gradient.removeAnimation(forKey: "sheen")
        let width = bounds.width
        guard moving, width > 0 else { return }
        let slide = CABasicAnimation(keyPath: "transform.translation.x")
        slide.fromValue = 0
        slide.toValue = -width * 1.5
        slide.duration = duration
        slide.autoreverses = true
        slide.repeatCount = .infinity
        slide.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        slide.isRemovedOnCompletion = false
        gradient.add(slide, forKey: "sheen")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let wanted = CGRect(x: 0, y: 0, width: bounds.width * 2.5, height: bounds.height)
        if gradient.bounds != wanted {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            gradient.bounds = wanted
            gradient.position = .zero
            CATransaction.commit()
            restart()
        }
    }
}

/// A name, in platinum when the person has Platina (PlatinaMark.tsx `PlatinaName`); otherwise ordinary text in
/// `plainColor`. Sizes itself like a label (Auto Layout or `sizeThatFits`).
final class PlatinaNameLabel: UIView {
    /// Lays the text out and gives the size; visible when the name is plain.
    let label = UILabel()
    private let maskLabel = UILabel()
    private let metal = SheenLayerView()
    private var platina = false
    private var animated = true
    /// Force the light metal (always-dark surfaces: the showcase, a tinted header, a nameplate).
    var onDark = false {
        didSet { refresh() }
    }
    var plainColor: UIColor = Theme.text {
        didSet { refresh() }
    }
    /// Unbounded titles are set with the reference's −0.2 spacing.
    var kern: CGFloat = 0 {
        didSet { refresh() }
    }
    var font: UIFont {
        get { return label.font }
        set { label.font = newValue; maskLabel.font = newValue; refresh() }
    }
    var textAlignment: NSTextAlignment {
        get { return label.textAlignment }
        set { label.textAlignment = newValue; maskLabel.textAlignment = newValue }
    }
    var numberOfLines: Int {
        get { return label.numberOfLines }
        set { label.numberOfLines = newValue; maskLabel.numberOfLines = newValue }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        label.numberOfLines = 1
        maskLabel.numberOfLines = 1
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor),
            label.bottomAnchor.constraint(equalTo: bottomAnchor),
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        metal.isHidden = true
        addSubview(metal)
        metal.mask = maskLabel
        NotificationCenter.default.addObserver(self, selector: #selector(motionChanged), name: Motion.changed, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    var text: String { return label.text ?? "" }

    /// `animated`: the light moves (profiles, the chat header); false in long lists.
    func show(_ name: String, platina: Bool, animated: Bool = true) {
        self.platina = platina
        self.animated = animated
        label.text = name
        maskLabel.text = name
        accessibilityLabel = name
        refresh()
    }

    @objc private func motionChanged() { refresh() }

    private func words(_ color: UIColor) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = label.textAlignment
        paragraph.lineBreakMode = .byTruncatingTail
        return NSAttributedString(string: label.text ?? "", attributes: [.font: label.font as Any, .kern: kern, .foregroundColor: color, .paragraphStyle: paragraph])
    }

    private func refresh() {
        let dark = onDark || Theme.dark
        label.attributedText = words(platina ? .clear : plainColor)
        maskLabel.attributedText = words(.black)
        metal.isHidden = !platina
        if platina { metal.set(colors: dark ? PlatinaMetal.name : PlatinaMetal.nameLight, moving: animated && Motion.enabled, duration: 3.6) }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        metal.frame = bounds
        maskLabel.frame = metal.bounds
    }

    override var intrinsicContentSize: CGSize { return label.intrinsicContentSize }

    override func sizeThatFits(_ size: CGSize) -> CGSize { return label.sizeThatFits(size) }
}

/// The «PLATINA» seal next to a name. A tap opens the showcase («вот так будешь выглядеть ты»).
final class PlatinaSealView: UIControl {
    private let metal = SheenLayerView()
    private let gem = UIImageView()
    private let word = UILabel()
    private let small: Bool
    /// Instead of the showcase.
    var onPress: (() -> Void)?
    /// Whose seal it is (the showcase says «У … — Platina»).
    var owner: (id: String, name: String)?

    init(small: Bool = false) {
        self.small = small
        super.init(frame: .zero)
        clipsToBounds = true
        layer.cornerRadius = small ? 6 : 7
        layer.cornerCurve = .continuous
        addSubview(metal)
        gem.image = UIImage(systemName: "diamond.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: small ? 8 : 10, weight: .bold))
        gem.tintColor = UIColor(hex: 0x1A1F2A)
        gem.contentMode = .center
        addSubview(gem)
        word.attributedText = NSAttributedString(string: "PLATINA", attributes: [.font: UIFont.systemFont(ofSize: small ? 8.5 : 10.5, weight: .heavy), .kern: small ? 1 : 1.4, .foregroundColor: UIColor(hex: 0x151922)])
        addSubview(word)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = "Инвиз Platina"
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
        NotificationCenter.default.addObserver(self, selector: #selector(motionChanged), name: Motion.changed, object: nil)
        motionChanged()
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func motionChanged() { metal.set(colors: PlatinaMetal.platinum, moving: Motion.enabled, duration: 4.2) }

    override var intrinsicContentSize: CGSize {
        let left: CGFloat = small ? 5 : 6, right: CGFloat = small ? 6 : 8, gap: CGFloat = small ? 3 : 5, icon: CGFloat = small ? 9 : 11
        return CGSize(width: left + icon + gap + word.intrinsicContentSize.width + right, height: small ? 18 : 22)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { return intrinsicContentSize }

    override func layoutSubviews() {
        super.layoutSubviews()
        metal.frame = bounds
        let left: CGFloat = small ? 5 : 6, gap: CGFloat = small ? 3 : 5, icon: CGFloat = small ? 9 : 11
        gem.frame = CGRect(x: left, y: 0, width: icon, height: bounds.height)
        let wordSize = word.intrinsicContentSize
        word.frame = CGRect(x: left + icon + gap, y: (bounds.height - wordSize.height) / 2, width: wordSize.width, height: wordSize.height)
    }

    override var isHighlighted: Bool {
        didSet { transform = isHighlighted ? CGAffineTransform(scaleX: 0.96, y: 0.96) : .identity }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        return bounds.insetBy(dx: -12, dy: -12).contains(point)
    }

    @objc private func pressed() {
        if let onPress { return onPress() }
        PlatinaShowcase.open(owner: owner)
    }
}

/// The compact mark of list rows: a small platinum gem (PlatinaMark.tsx `PlatinaGem`). Its side is `size` + 4.
final class PlatinaGemView: UIView {
    private let gradient = CAGradientLayer()
    private let gem = UIImageView()
    let size: CGFloat

    init(size: CGFloat = 13) {
        self.size = size
        super.init(frame: CGRect(x: 0, y: 0, width: size + 4, height: size + 4))
        isUserInteractionEnabled = false
        clipsToBounds = true
        gradient.colors = PlatinaMetal.platinum.map { lookColor($0).cgColor }
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        layer.addSublayer(gradient)
        gem.image = UIImage(systemName: "diamond.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: size * 0.55, weight: .bold))
        gem.tintColor = UIColor(hex: 0x1A1F2A)
        gem.contentMode = .center
        addSubview(gem)
        isAccessibilityElement = true
        accessibilityLabel = "Platina"
    }

    required init?(coder: NSCoder) { return nil }

    override var intrinsicContentSize: CGSize { return CGSize(width: size + 4, height: size + 4) }

    override func layoutSubviews() {
        super.layoutSubviews()
        gradient.frame = bounds
        gem.frame = bounds
        layer.cornerRadius = bounds.width / 2
    }
}

/// A platinum button of the showcase and the offer: the metal fill, dark heavy words, pressed it shrinks.
final class PlatinaButton: UIControl {
    private let gradient = CAGradientLayer()
    private let words = UILabel()

    init(title: String, size: CGFloat = 16) {
        super.init(frame: .zero)
        clipsToBounds = true
        layer.cornerCurve = .continuous
        gradient.colors = PlatinaMetal.button.map { lookColor($0).cgColor }
        gradient.startPoint = CGPoint(x: 0, y: 0.3)
        gradient.endPoint = CGPoint(x: 1, y: 0.7)
        layer.addSublayer(gradient)
        words.font = .systemFont(ofSize: size, weight: .heavy)
        words.textColor = UIColor(hex: 0x12151C)
        words.textAlignment = .center
        addSubview(words)
        setTitle(title)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    func setTitle(_ title: String) {
        words.text = title
        accessibilityLabel = title
    }

    override var isHighlighted: Bool {
        didSet { UIView.animate(withDuration: 0.12) { self.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.96, y: 0.96) : .identity } }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        gradient.frame = bounds
        words.frame = bounds
    }
}
