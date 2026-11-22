import UIKit

/// The reference's `Button` (components.tsx): 54 tall, radius 21, a `Bouncy` press to 0.96.
/// - Primary: clear glass under the accent gradient (0,0 → 0.9,1, at 0.96), a white sheen (0.22 → clear, 0,0 → 0.4,0.65)
///   and a 1 pt edge (dark themes rgba(235,245,255,0.58), light rgba(255,255,255,0.35)), with the glass's shadow
///   (0, 8, radius 18, opacity 0.19 dark / 0.09 light).
/// - Secondary: regular glass, no shadow.
/// The words 16 bold (−0.15) with the glyph (20) 10 before them, 21 inside; disabled at 0.45.
final class WideButton: UIButton {
    private let glass = UIVisualEffectView(effect: nil)
    private let fill = CAGradientLayer()
    private let sheen = CAGradientLayer()
    private let edge = CALayer()
    private let secondary: Bool

    init(words: String, glyph: String?, secondary: Bool) {
        self.secondary = secondary
        super.init(frame: CGRect(x: 0, y: 0, width: 200, height: 54))
        let ink = secondary ? Theme.text : Theme.onAccent
        setAttributedTitle(NSAttributedString(string: words, attributes: [.font: UIFont.systemFont(ofSize: 16, weight: .bold), .kern: -0.15, .foregroundColor: ink]), for: .normal)
        if let glyph {
            setImage(IonIcon.image(glyph, size: 20), for: .normal)
            tintColor = ink
            imageEdgeInsets = UIEdgeInsets(top: 0, left: -5, bottom: 0, right: 5)
            titleEdgeInsets = UIEdgeInsets(top: 0, left: 5, bottom: 0, right: -5)
        }
        contentEdgeInsets = UIEdgeInsets(top: 0, left: 21 + (glyph == nil ? 0 : 5), bottom: 0, right: 21 + (glyph == nil ? 0 : 5))
        adjustsImageWhenHighlighted = false
        glass.effect = TabGlass.effect(clear: !secondary, interactive: true, dark: Theme.dark)
        glass.isUserInteractionEnabled = false
        glass.clipsToBounds = true
        glass.layer.cornerRadius = 21
        glass.layer.cornerCurve = .continuous
        insertSubview(glass, at: 0)
        if !secondary {
            let colors = ThemeStore.look.accentGradient
            fill.colors = (colors.isEmpty ? [Theme.accent, Theme.accent] : colors).map { $0.cgColor }
            fill.startPoint = CGPoint(x: 0, y: 0)
            fill.endPoint = CGPoint(x: 0.9, y: 1)
            fill.opacity = 0.96
            sheen.colors = [UIColor(white: 1, alpha: 0.22).cgColor, UIColor(white: 1, alpha: 0).cgColor]
            sheen.startPoint = CGPoint(x: 0, y: 0)
            sheen.endPoint = CGPoint(x: 0.4, y: 0.65)
            edge.borderWidth = 1
            edge.borderColor = (Theme.dark ? UIColor(red: 235 / 255, green: 245 / 255, blue: 1, alpha: 0.58) : UIColor(white: 1, alpha: 0.35)).cgColor
            for part in [fill, sheen, edge] {
                part.cornerRadius = 21
                part.cornerCurve = .continuous
                part.masksToBounds = true
                glass.contentView.layer.addSublayer(part)
            }
            layer.shadowColor = (Theme.dark ? UIColor.black : UIColor(hex: 0x294C91)).cgColor
            layer.shadowOffset = CGSize(width: 0, height: 8)
            layer.shadowRadius = 18
            layer.shadowOpacity = Theme.dark ? 0.19 : 0.09
        }
        Bouncy.attach(self, scale: 0.96)
        heightAnchor.constraint(equalToConstant: 54).isActive = true
    }

    required init?(coder: NSCoder) { return nil }

    override var isEnabled: Bool {
        didSet { alpha = isEnabled ? 1 : 0.45 }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        sendSubviewToBack(glass)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for part in [fill, sheen, edge] { part.frame = bounds }
        CATransaction.commit()
        if !secondary { layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: 21).cgPath }
    }
}
