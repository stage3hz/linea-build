import UIKit

/// The colours of the theme that is on which only the backgrounds draw with: the page's gradient bands and the two
/// ambient lights (the reference's `Theme.bgGradient`, `ambientBlue`, `ambientLilac`, `plain`). Read from the core's
/// `settingsTheme` — the very answer Settings/ThemeStore.swift makes the look from — once per look.
struct BackdropColors {
    var plain = true
    var dark = true
    var black = true
    var bg = UIColor(hex: 0x08090A)
    var gradient: [UIColor] = [UIColor(hex: 0x08090A), UIColor(hex: 0x08090A), UIColor(hex: 0x08090A)]
    var ambientBlue = UIColor(white: 1, alpha: 0.03)
    var ambientLilac = UIColor(white: 1, alpha: 0.02)
    var accent = UIColor(hex: 0xE5E5E6)
    /// `#RRGGBB` of the page and the accent, when the theme writes them so (MusicAmbient's `themeAmbient`).
    var bgHex: String?
    var accentHex: String?

    private static var cached: (source: String, colors: BackdropColors)?

    /// The colours of the look that is on now.
    static var current: BackdropColors {
        let look = ThemeStore.look
        if let cached, cached.source == look.source { return cached.colors }
        var made = BackdropColors()
        made.dark = look.dark
        made.black = look.black
        made.bg = look.bg
        made.accent = look.accent
        let args: [Any] = [look.id, DevicePreferences.item("accentColor"), NSNull()]
        if let fields = Core.view("settingsTheme", args) as? [String: Any] {
            made.plain = fields["plain"] as? Bool ?? false
            let bands = (fields["bgGradient"] as? [String] ?? []).compactMap { ThemeLook.color($0) }
            if bands.count == 3 { made.gradient = bands }
            made.ambientBlue = ThemeLook.color(fields["ambientBlue"] as? String) ?? made.ambientBlue
            made.ambientLilac = ThemeLook.color(fields["ambientLilac"] as? String) ?? made.ambientLilac
            made.bgHex = fields["bg"] as? String
            made.accentHex = fields["accent"] as? String
        }
        cached = (look.source, made)
        return made
    }
}

/// The page under every screen (the reference's `GlassBackdrop`, glass.tsx): the built-in themes (Светлая, Тёмная,
/// Чёрная, Графит) are their plain colour; a palette theme is its gradient bands, a cool light from the upper right,
/// the accent's light from the lower left and one faint arc. Never takes a touch. Calm by design: the colours are the
/// theme's own, nothing moves.
final class PaletteBackdropView: UIView {
    private let bands = CAGradientLayer()
    private let blue = CAGradientLayer()
    private let lilac = CAGradientLayer()
    private let arc = CALayer()
    private let arcFill = CAGradientLayer()
    private var shownSource = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        // start {x:0,y:0} end {x:.8,y:1}
        bands.startPoint = CGPoint(x: 0, y: 0)
        bands.endPoint = CGPoint(x: 0.8, y: 1)
        // [ambientBlue, transparent, transparent] at [0, .62, 1], from {x:1,y:0} to {x:0,y:.85}
        blue.locations = [0, 0.62, 1]
        blue.startPoint = CGPoint(x: 1, y: 0)
        blue.endPoint = CGPoint(x: 0, y: 0.85)
        // [transparent, ambientLilac] from {x:.2,y:.15} to {x:.9,y:1}
        lilac.startPoint = CGPoint(x: 0.2, y: 0.15)
        lilac.endPoint = CGPoint(x: 0.9, y: 1)
        arc.borderWidth = 1
        arc.masksToBounds = true
        arcFill.startPoint = CGPoint(x: 0, y: 0)
        arcFill.endPoint = CGPoint(x: 0.6, y: 1)
        arc.addSublayer(arcFill)
        for part in [bands, blue, lilac, arc] { layer.addSublayer(part) }
        paint()
    }

    required init?(coder: NSCoder) { return nil }

    /// Whether the theme that is on has anything more than its plain colour.
    static var wanted: Bool { return !BackdropColors.current.plain }

    func paint() {
        let colors = BackdropColors.current
        shownSource = ThemeStore.look.source
        backgroundColor = colors.bg
        let plain = colors.plain
        for part in [bands, blue, lilac, arc] { part.isHidden = plain }
        if plain { return }
        bands.colors = colors.gradient.map { $0.cgColor }
        blue.colors = [colors.ambientBlue.cgColor, UIColor.clear.cgColor, UIColor.clear.cgColor]
        lilac.colors = [UIColor.clear.cgColor, colors.ambientLilac.cgColor]
        let rim: UIColor = colors.black ? UIColor(white: 1, alpha: 0.035) : (colors.dark ? UIColor(red: 145 / 255, green: 181 / 255, blue: 1, alpha: 0.07) : UIColor(white: 1, alpha: 0.58))
        let fill: UIColor = colors.black ? UIColor(white: 1, alpha: 0.025) : (colors.dark ? UIColor(red: 89 / 255, green: 130 / 255, blue: 222 / 255, alpha: 0.09) : UIColor(white: 1, alpha: 0.34))
        arc.borderColor = rim.cgColor
        arcFill.colors = [fill.cgColor, UIColor.clear.cgColor]
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if shownSource != ThemeStore.look.source { paint() }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for part in [bands, blue, lilac] { part.frame = bounds }
        // top −26 %, right −30 %, width 108 %, a circle, turned −24°.
        let side = bounds.width * 1.08
        let left = bounds.width - (-bounds.width * 0.30) - side
        let top = -bounds.height * 0.26
        arc.transform = CATransform3DIdentity
        arc.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        arc.position = CGPoint(x: left + side / 2, y: top + side / 2)
        arc.cornerRadius = side / 2
        arcFill.frame = arc.bounds
        arc.transform = CATransform3DMakeRotation(-24 * .pi / 180, 0, 0, 1)
        CATransaction.commit()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { return nil }
}
