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
        // Easing.inOut(Easing.quad) of the reference (easeInOutQuad), not the system's ease-in-ease-out.
        slide.timingFunction = CAMediaTimingFunction(controlPoints: 0.455, 0.03, 0.515, 0.955)
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
        gem.image = GemGlyph.image(size: small ? 9 : 11)
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
        gem.image = GemGlyph.image(size: size * 0.62)
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
        // The reference's Pressable style: 0.96 while pressed, at once (no animation of its own).
        didSet { transform = isHighlighted ? CGAffineTransform(scaleX: 0.96, y: 0.96) : .identity }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        gradient.frame = bounds
        words.frame = bounds
    }
}

/// The gem of the reference's seal and list mark (its icon set's «diamond», MIT): the outline as drawn there, as a
/// template image `size` points square (the icon's own box), tinted by the image view.
enum GemGlyph {
    /// The outline in a unit square (M/L/Q/Z, y down), 0.913 of the icon's box.
    private static let outline = "M 0.3393 0.0209 L 0.4697 0.0209 L 0.4718 0.0274 Q 0.4740 0.0316 0.3927 0.1407 Q 0.3307 0.2219 0.3190 0.2369 Q 0.3072 0.2519 0.3029 0.2519 L 0.2986 0.2519 L 0.2516 0.1407 Q 0.2046 0.0316 0.2046 0.0284 Q 0.2046 0.0252 0.2067 0.0231 Q 0.2088 0.0209 0.3393 0.0209 Z M 0.6076 0.1418 Q 0.5210 0.0274 0.5210 0.0241 Q 0.5210 0.0209 0.6589 0.0209 Q 0.7969 0.0209 0.7969 0.0241 Q 0.7969 0.0274 0.7477 0.1418 Q 0.6985 0.2561 0.6964 0.2561 Q 0.6942 0.2561 0.6076 0.1418 Z M 0.1361 0.0744 Q 0.1447 0.0680 0.1490 0.0787 Q 0.1532 0.0872 0.1949 0.1845 Q 0.2366 0.2818 0.2366 0.2839 Q 0.2388 0.2882 0.2356 0.2914 Q 0.2324 0.2946 0.1233 0.2946 Q 0.0143 0.2946 0.0100 0.2925 Q 0.0057 0.2904 0.0057 0.2872 Q 0.0057 0.2839 0.0688 0.1813 Q 0.1319 0.0787 0.1361 0.0744 Z M 0.8525 0.0744 Q 0.8589 0.0701 0.8632 0.0723 Q 0.8653 0.0744 0.9284 0.1760 Q 0.9914 0.2775 0.9936 0.2829 Q 0.9957 0.2882 0.9914 0.2914 Q 0.9872 0.2946 0.8770 0.2946 Q 0.7669 0.2946 0.7637 0.2914 Q 0.7605 0.2882 0.7627 0.2839 Q 0.7648 0.2733 0.8086 0.1738 Q 0.8525 0.0744 0.8525 0.0744 Z M 0.3713 0.2861 Q 0.3713 0.2818 0.4334 0.2006 Q 0.4954 0.1193 0.4996 0.1193 Q 0.5039 0.1193 0.5659 0.2006 Q 0.6279 0.2818 0.6279 0.2861 Q 0.6279 0.2904 0.6237 0.2925 Q 0.6194 0.2946 0.4996 0.2946 Q 0.3799 0.2946 0.3756 0.2925 Q 0.3713 0.2904 0.3713 0.2861 Z M 0.1361 0.3631 L 0.2687 0.3631 L 0.2708 0.3673 Q 0.2730 0.3695 0.3703 0.6464 Q 0.4676 0.9233 0.4761 0.9511 Q 0.4847 0.9746 0.4761 0.9767 Q 0.4697 0.9789 0.4665 0.9778 Q 0.4633 0.9767 0.2324 0.6763 Q 0.0014 0.3759 0.0004 0.3716 Q -0.0007 0.3673 0.0014 0.3652 Q 0.0036 0.3631 0.1361 0.3631 Z M 0.6536 0.3695 Q 0.6536 0.3716 0.5809 0.5780 Q 0.5082 0.7843 0.5061 0.7886 Q 0.5039 0.7907 0.4996 0.7907 Q 0.4954 0.7907 0.4932 0.7886 Q 0.4911 0.7843 0.4184 0.5780 Q 0.3457 0.3716 0.3457 0.3695 Q 0.3457 0.3673 0.3489 0.3652 Q 0.3521 0.3631 0.4986 0.3631 Q 0.6450 0.3631 0.6493 0.3652 Q 0.6536 0.3673 0.6536 0.3695 Z M 0.7284 0.3673 Q 0.7284 0.3673 0.7284 0.3673 L 0.7306 0.3631 L 0.8632 0.3631 Q 0.9808 0.3631 0.9936 0.3652 Q 1.0000 0.3652 1.0000 0.3716 Q 0.9979 0.3738 0.7691 0.6720 Q 0.5403 0.9703 0.5339 0.9746 Q 0.5232 0.9853 0.5168 0.9703 Q 0.5168 0.9661 0.6215 0.6688 Q 0.7263 0.3716 0.7284 0.3673 Z"
    private static var cache: [CGFloat: UIImage] = [:]

    static func image(size: CGFloat) -> UIImage {
        if let made = cache[size] { return made }
        let side = size * 0.913
        let inset = (size - side) / 2
        let path = UIBezierPath()
        let parts = outline.split(separator: " ")
        var index = 0
        func number() -> CGFloat {
            let value = CGFloat(Double(parts[index]) ?? 0)
            index += 1
            return value
        }
        func point() -> CGPoint {
            let x = number(), y = number()
            return CGPoint(x: inset + x * side, y: inset + y * side)
        }
        while index < parts.count {
            let command = parts[index]
            index += 1
            switch command {
            case "M": path.move(to: point())
            case "L": path.addLine(to: point())
            case "Q":
                let control = point()
                path.addQuadCurve(to: point(), controlPoint: control)
            case "Z": path.close()
            default: break
            }
        }
        let made = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { (_: UIGraphicsImageRendererContext) -> Void in
            UIColor.black.setFill()
            path.fill()
        }.withRenderingMode(.alwaysTemplate)
        cache[size] = made
        return made
    }
}
