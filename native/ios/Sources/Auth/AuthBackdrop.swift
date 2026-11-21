import UIKit

/// «Инвиз» in platinum on the sign-in screen (the reference's `Wordmark`, mobile/src/auth/AuthBackdrop.tsx): the letters
/// are a window onto slowly moving metal, with a glint that passes now and then (a sweep across in 2.4 s, then 2.6 s of
/// rest); under them a soft, deep shadow and a faint cool glow. It springs in once; with the app's animations off
/// (Effects/Motion.swift) it is a still image.
///
/// The sign-in page itself stands on the app's page (Effects/PaletteBackdrop.swift, laid under every screen by
/// Effects/EffectsHost.swift) — as in the reference, whose AuthScreen draws over the app's GlassBackdrop. The
/// reference's separate `AuthBackdrop` (two drifting glows) is not shown by its AuthScreen, so it is not here either.
final class WordmarkView: UIView {
    // Platinum: cool white metal on dark themes, dark polished metal on light ones.
    private static let metalDark: [UInt32] = [0xB9C1CF, 0xFFFFFF, 0x8E99AD, 0xEEF1F6, 0xB9C1CF, 0xFFFFFF, 0x8E99AD]
    private static let metalLight: [UInt32] = [0x2E3542, 0x7B879B, 0x1E232D, 0x5A6477, 0x2E3542, 0x8893A7, 0x1E232D]

    private let size: CGFloat
    private let glow = UILabel()
    private let shadow = UILabel()
    private let metalBox = UIView()
    private let metal = CAGradientLayer()
    private let letters = UILabel()
    private var entered = false

    init(size: CGFloat = 60) {
        self.size = size
        super.init(frame: .zero)
        isAccessibilityElement = true
        accessibilityLabel = "Инвиз"
        accessibilityTraits = .header
        let text = WordmarkView.words(size: size)
        let dark = Theme.dark
        let colours: [UIColor] = (dark ? WordmarkView.metalDark : WordmarkView.metalLight).map { UIColor(hex: $0) }
        let glowColour: UIColor = dark ? UIColor(red: 205 / 255, green: 220 / 255, blue: 1, alpha: 0.38) : UIColor(red: 120 / 255, green: 140 / 255, blue: 190 / 255, alpha: 0.25)
        let shadowColour: UIColor = dark ? UIColor(white: 0, alpha: 0.85) : UIColor(red: 20 / 255, green: 28 / 255, blue: 45 / 255, alpha: 0.28)
        // Depth: a wide faint cool glow behind, a dark shadow right under the letters.
        style(glow, text: text, fill: colours[2], colour: glowColour, radius: size * 0.55, offset: 0)
        style(shadow, text: text, fill: colours[2], colour: shadowColour, radius: size * 0.16, offset: size * 0.07)
        metal.colors = colours.map { $0.cgColor }
        metal.startPoint = CGPoint(x: 0, y: 0.35)
        metal.endPoint = CGPoint(x: 1, y: 0.65)
        metalBox.layer.addSublayer(metal)
        letters.attributedText = text
        letters.textAlignment = .center
        metalBox.mask = letters
        addSubview(metalBox)
        NotificationCenter.default.addObserver(self, selector: #selector(restart), name: Motion.changed, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    private func style(_ label: UILabel, text: NSAttributedString, fill: UIColor, colour: UIColor, radius: CGFloat, offset: CGFloat) {
        let painted = NSMutableAttributedString(attributedString: text)
        painted.addAttribute(.foregroundColor, value: fill, range: NSRange(location: 0, length: painted.length))
        label.attributedText = painted
        label.textAlignment = .center
        label.layer.shadowColor = colour.cgColor
        label.layer.shadowOpacity = 1
        label.layer.shadowRadius = radius / 2
        label.layer.shadowOffset = CGSize(width: 0, height: offset)
        addSubview(label)
    }

    private static func words(size: CGFloat) -> NSAttributedString {
        return NSAttributedString(string: "Инвиз", attributes: [.font: Theme.font(size, .heavy), .kern: -size * 0.035, .foregroundColor: UIColor.black])
    }

    override var intrinsicContentSize: CGSize { return CGSize(width: UIView.noIntrinsicMetric, height: size * 1.5) }

    private var wordWidth: CGFloat { return ceil(WordmarkView.words(size: size).size().width) + 2 }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = wordWidth
        let height = ceil(size * 1.18)
        let frame = CGRect(x: (bounds.width - width) / 2, y: (bounds.height - height) / 2, width: width, height: height)
        glow.frame = frame
        shadow.frame = frame
        metalBox.frame = frame
        letters.frame = metalBox.bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        metal.frame = CGRect(x: 0, y: 0, width: width * 3, height: height)
        CATransaction.commit()
        if metal.animation(forKey: "sweep") == nil { restart() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else { return }
        restart()
        guard !entered else { return }
        entered = true
        // Springs in: opacity 0 → 1, scale .92 → 1.
        guard Motion.enabled else { return }
        alpha = 0
        transform = CGAffineTransform(scaleX: 0.92, y: 0.92)
        UIView.animate(withDuration: 0.7, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0, options: [], animations: { [weak self] in
            self?.alpha = 1
            self?.transform = .identity
        }, completion: nil)
    }

    /// The metal sweeps across the letters (2.4 s, ease in-out cubic), rests 2.6 s, again; still at 0.35 when off.
    @objc private func restart() {
        metal.removeAnimation(forKey: "sweep")
        let travel: CGFloat = wordWidth * 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        metal.transform = CATransform3DMakeTranslation(-travel * 0.35, 0, 0)
        CATransaction.commit()
        guard Motion.enabled, window != nil else { return }
        let sweep = CAKeyframeAnimation(keyPath: "transform.translation.x")
        sweep.values = [NSNumber(value: 0.0), NSNumber(value: Double(-travel)), NSNumber(value: Double(-travel))]
        sweep.keyTimes = [NSNumber(value: 0.0), NSNumber(value: 0.48), NSNumber(value: 1.0)]
        sweep.timingFunctions = [CAMediaTimingFunction(controlPoints: 0.65, 0, 0.35, 1), CAMediaTimingFunction(name: .linear)]
        sweep.duration = 5
        sweep.repeatCount = .infinity
        metal.add(sweep, forKey: "sweep")
    }
}
