import UIKit

/// The music «эмбиент» (mobile/src/music/MusicAmbient.tsx): soft light patches that drift slowly while each patch's
/// colour flows blue → emerald → ice white, no pulsing. Behind the top of «Музыка», the full player and the
/// equalizer; the same colours make the animated Platina banners. Everything is Core Animation (transforms and
/// opacity on the render server); it stands still while animations are off (Effects/Motion.swift) or when asked to.
final class MusicAmbientView: UIView {
    /// The reference's palettes: a base colour, five lights, which of them is the ice accent and which the emerald.
    struct Palette {
        var base: UInt32
        var colors: [UInt32]
        var accent = 4
        var green = 1
    }

    static let palettes: [String: Palette] = [
        "dark": Palette(base: 0x0A1529, colors: [0x0D3480, 0x0B6450, 0x123E92, 0x0A2F6E, 0xB8D8F5]),
        "black": Palette(base: 0x000000, colors: [0x0A2766, 0x08483A, 0x0E2F72, 0x071F4F, 0x8FB3D9]),
        "light": Palette(base: 0xE7EFFC, colors: [0x9DBDF2, 0xA9E0CF, 0xB5CDF5, 0x8FB0EA, 0xFFFFFF]),
        // Platina profile banners.
        "deep": Palette(base: 0x050B1C, colors: [0x0D3480, 0x0A2F6E, 0x143F9E, 0x08245A, 0x8FB3D9]),
        "glacier": Palette(base: 0x0B1B2E, colors: [0x4C8FD6, 0x7FC8E8, 0x2F6DB5, 0x9FD6F2, 0xFFFFFF]),
        "aurora": Palette(base: 0x04131C, colors: [0x0B6450, 0x1AA889, 0x0D3480, 0x2EE6C8, 0xCFF7EE]),
        "ocean": Palette(base: 0x031424, colors: [0x0A4E8A, 0x0C7A9E, 0x063A6B, 0x1593B8, 0xB8E4F5]),
        "mint": Palette(base: 0x061A16, colors: [0x118A6A, 0x4FD1A5, 0x0B5C4A, 0x7BE8C3, 0xE6FFF6]),
        "night": Palette(base: 0x000000, colors: [0x0A1A40, 0x101F4D, 0x06122E, 0x1A2C66, 0x5D7BB8]),
    ]

    private static let count = 5
    /// Seconds per colour.
    private static let step: Double = 6

    /// The tone the app's theme asks for: «black», «dark» or «light».
    static var themeTone: String { return Theme.dark ? (ThemeStore.look.black ? "black" : "dark") : "light" }

    /// Ambient colours from a theme (`themeAmbient`): its page colour as the base, its accent and two blends as the
    /// light. Nil unless both are `#RRGGBB`. For Графит and the palettes, so the music screen is not navy there.
    static func themePalette(bg: String?, accent: String?) -> Palette? {
        guard let bg = MusicAmbientView.hex(bg), let accent = MusicAmbientView.hex(accent) else { return nil }
        func mix(_ a: UInt32, _ b: UInt32, _ k: Double) -> UInt32 {
            var out: UInt32 = 0
            for shift in [16, 8, 0] as [UInt32] {
                let x = Double((a >> shift) & 255), y = Double((b >> shift) & 255)
                out |= UInt32(min(255, max(0, (x * (1 - k) + y * k).rounded()))) << shift
            }
            return out
        }
        return Palette(base: bg, colors: [mix(bg, accent, 0.55), mix(bg, accent, 0.35), mix(bg, accent, 0.7), mix(bg, accent, 0.45), mix(accent, 0xFFFFFF, 0.5)])
    }

    /// `#RRGGBB` → 0xRRGGBB.
    static func hex(_ text: String?) -> UInt32? {
        guard let text, text.count == 7, text.hasPrefix("#"), let value = UInt32(text.dropFirst(), radix: 16) else { return nil }
        return value
    }

    /// The custom palette the reference uses for the music screens: dark, not black, and not the old navy page.
    static var themeCustom: Palette? {
        let colors = BackdropColors.current
        guard colors.dark, !colors.black, colors.bgHex?.uppercased() != "#080F1E" else { return nil }
        return themePalette(bg: colors.bgHex, accent: colors.accentHex)
    }

    private var tone: String
    private let custom: Palette?
    private var still: Bool
    private let fadeMask: Bool
    private var patches: [CALayer] = []
    private var shownSize = CGSize.zero
    private var shownMoving = false
    private let fadeLayer = CAGradientLayer()

    /// `fade`: the lower part fades out to transparency (the top of «Музыка», which runs into the list below).
    init(tone: String = "dark", custom: Palette? = nil, still: Bool = false, fade: Bool = false) {
        self.tone = tone
        self.custom = custom
        self.still = still
        self.fadeMask = fade
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        clipsToBounds = true
        backgroundColor = UIColor(hex: palette.base)
        if fade {
            fadeLayer.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
            fadeLayer.locations = [0, 0.6, 1]
            layer.mask = fadeLayer
        }
        NotificationCenter.default.addObserver(self, selector: #selector(motionChanged), name: Motion.changed, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// Avatars: another palette or stillness on the same view (the profile banner presets, the studio's swatches;
    /// an unknown preset is «deep»). Profile's former AmbientView was this same view twice; it is gone.
    func show(tone next: String, still nextStill: Bool) {
        let known = MusicAmbientView.palettes[next] == nil ? "deep" : next
        guard known != tone || nextStill != still else { return }
        tone = known
        still = nextStill
        backgroundColor = UIColor(hex: palette.base)
        build()
    }

    private var palette: Palette { return custom ?? MusicAmbientView.palettes[tone] ?? MusicAmbientView.palettes["dark"]! }
    private var moving: Bool { return !still && Motion.enabled }

    override func layoutSubviews() {
        super.layoutSubviews()
        if fadeMask { fadeLayer.frame = bounds }
        if bounds.size != shownSize || moving != shownMoving { build() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Animations are dropped by Core Animation while off screen: they are put back on the way in.
        if window != nil { build() }
    }

    @objc private func motionChanged() {
        if moving != shownMoving { build() }
    }

    private func build() {
        let size = bounds.size
        shownSize = size
        shownMoving = moving
        patches.forEach { $0.removeFromSuperlayer() }
        patches = []
        guard size.width > 0, size.height > 0 else { return }
        let w = size.width, h = size.height
        let strength: CGFloat = tone == "light" ? 0.75 : 1
        // x, y, size, offset, drift, strength
        let plan: [(CGFloat, CGFloat, CGFloat, Double, CGFloat, CGFloat)] = [
            (w * 0.25, h * 0.35, w * 1.3, 0, 50, 0.55 * strength),
            (w * 0.85, h * 0.55, w * 1.2, 1.7, 45, 0.45 * strength),
            (w * 0.5, h * 0.85, w * 1.3, 3.1, 40, 0.5 * strength),
            (w * 0.55, h * 0.3, w * 0.8, 4.2, 55, 0.3 * strength),
        ]
        for item in plan { patches.append(patch(x: item.0, y: item.1, side: item.2, offset: item.3, drift: item.4, strength: item.5)) }
    }

    /// One patch: five colour layers on top of each other, one of them showing at a time and passing to the next.
    private func patch(x: CGFloat, y: CGFloat, side: CGFloat, offset: Double, drift: CGFloat, strength: CGFloat) -> CALayer {
        let holder = CALayer()
        holder.frame = CGRect(x: x - side / 2, y: y - side / 2, width: side, height: side)
        layer.addSublayer(holder)
        let palette = self.palette
        let count = MusicAmbientView.count
        for (index, hex) in palette.colors.enumerated() {
            let opacity: CGFloat = index == palette.accent ? strength * (tone == "light" ? 0.8 : 0.35) : (index == palette.green ? strength * 0.7 : strength)
            let glow = CAGradientLayer()
            glow.type = .radial
            glow.frame = holder.bounds
            glow.startPoint = CGPoint(x: 0.5, y: 0.5)
            glow.endPoint = CGPoint(x: 1, y: 1)
            let colour = UIColor(hex: hex)
            glow.colors = [colour.withAlphaComponent(opacity).cgColor, colour.withAlphaComponent(0).cgColor]
            glow.opacity = Float(MusicAmbientView.layerOpacity(phase: offset, index: index, count: count))
            holder.addSublayer(glow)
            guard moving else { continue }
            // The phase runs offset → offset + 5 in 30 s, linearly, for ever; the layer's opacity follows it.
            let samples = 60
            var values: [NSNumber] = []
            var times: [NSNumber] = []
            for k in 0...samples {
                let phase = offset + Double(count) * Double(k) / Double(samples)
                values.append(NSNumber(value: MusicAmbientView.layerOpacity(phase: phase, index: index, count: count)))
                times.append(NSNumber(value: Double(k) / Double(samples)))
            }
            let flow = CAKeyframeAnimation(keyPath: "opacity")
            flow.values = values
            flow.keyTimes = times
            flow.duration = MusicAmbientView.step * Double(count)
            flow.repeatCount = .infinity
            flow.calculationMode = .linear
            flow.isRemovedOnCompletion = false
            glow.add(flow, forKey: "flow")
        }
        guard moving else { return holder }
        // Drift: 0 → d → −d, then back the same way (withRepeat(…, reverse)), each leg a sine ease.
        let sine = CAMediaTimingFunction(controlPoints: 0.37, 0, 0.63, 1)
        func sway(_ path: String, _ amount: CGFloat, _ leg: Double) -> CAKeyframeAnimation {
            let move = CAKeyframeAnimation(keyPath: path)
            move.values = [0, amount, -amount, amount, 0].map { NSNumber(value: Double($0)) }
            move.keyTimes = [0, 0.25, 0.5, 0.75, 1]
            move.timingFunctions = [sine, sine, sine, sine]
            move.duration = leg * 4
            move.repeatCount = .infinity
            move.isAdditive = true
            move.isRemovedOnCompletion = false
            return move
        }
        holder.add(sway("transform.translation.x", drift, 9 + offset * 0.9), forKey: "dx")
        holder.add(sway("transform.translation.y", -drift * 0.7, 11 + offset * 0.7), forKey: "dy")
        return holder
    }

    /// The opacity of colour layer `index` at a point of the cycle: full on its slot, gone a whole slot away
    /// (smoothstep of the circular distance).
    static func layerOpacity(phase: Double, index: Int, count: Int) -> Double {
        let n = Double(count)
        var d = abs((((phase - Double(index)).truncatingRemainder(dividingBy: n)) + n).truncatingRemainder(dividingBy: n))
        d = min(d, n - d)
        let k = max(0, 1 - d)
        return k * k * (3 - 2 * k)
    }
}
