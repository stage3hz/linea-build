import UIKit

/// The emoji status next to a name (the reference's StatusEmoji.tsx): the chosen emoji while it lasts; a Platina
/// account without one shows the Platina gem instead (`gem: false` turns that off). It disappears by itself when
/// the status runs out. Size: the emoji's point size; `intrinsicContentSize` follows what is shown.
///
/// The reference plays a bundled animation of the emoji with Platina (Lottie, Noto Emoji Animation); there is no
/// animation player in this app, so the emoji is the still glyph everywhere.
final class StatusEmojiView: UIView {
    private let glyph = UILabel()
    private var gemView: PlatinaGemView?
    private var look = PersonLook()
    private var size: CGFloat = 16
    private var gem = true
    private var timer: Timer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        glyph.textAlignment = .center
        addSubview(glyph)
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        timer?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    func show(_ look: PersonLook, size: CGFloat = 16, gem: Bool = true) {
        self.look = look
        self.size = size
        self.gem = gem
        refresh()
    }

    /// True when something is shown.
    var showsSomething: Bool { return !isHidden }

    @objc private func refresh() {
        timer?.invalidate()
        timer = nil
        let emoji = look.visibleStatus()
        gemView?.removeFromSuperview()
        gemView = nil
        if let emoji {
            glyph.isHidden = false
            glyph.text = emoji
            glyph.font = .systemFont(ofSize: size)
            accessibilityLabel = "Статус \(emoji)"
            if let ends = look.statusEnds() {
                let wait = max(1, ends.timeIntervalSinceNow + 1)
                timer = Timer.scheduledTimer(withTimeInterval: min(wait, 2_147_483), repeats: false) { [weak self] (_: Timer) -> Void in self?.refresh() }
            }
            isHidden = false
        } else if gem && look.platina {
            glyph.isHidden = true
            let made = PlatinaGemView(size: (size * 0.8).rounded())
            addSubview(made)
            gemView = made
            accessibilityLabel = "Platina"
            isHidden = false
        } else {
            glyph.isHidden = true
            isHidden = true
        }
        isAccessibilityElement = !isHidden
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }

    override var intrinsicContentSize: CGSize {
        if isHidden { return CGSize(width: 0, height: 0) }
        if let gemView { return gemView.intrinsicContentSize }
        return CGSize(width: ceil(size * 1.25), height: ceil(size * 1.4))
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { return intrinsicContentSize }

    override func layoutSubviews() {
        super.layoutSubviews()
        glyph.frame = bounds
        if let gemView {
            let side = gemView.intrinsicContentSize
            gemView.frame = CGRect(x: (bounds.width - side.width) / 2, y: (bounds.height - side.height) / 2, width: side.width, height: side.height)
        }
    }
}
