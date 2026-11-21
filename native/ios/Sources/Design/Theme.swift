import UIKit

extension UIColor {
    /// A colour from 0xRRGGBB.
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: alpha)
    }
}

/// The app's colours: those of the theme that is on. «Чёрная», the app's own look, unless the person chose
/// another in Настройки → Оформление (Settings/ThemeStore.swift keeps the choice and makes the colours).
enum Theme {
    static var bg: UIColor { ThemeStore.look.bg }
    static var text: UIColor { ThemeStore.look.text }
    static var muted: UIColor { ThemeStore.look.muted }
    static var subtle: UIColor { ThemeStore.look.subtle }
    static var accent: UIColor { ThemeStore.look.accent }
    static var onAccent: UIColor { ThemeStore.look.onAccent }
    static var surface2: UIColor { ThemeStore.look.surface2 }
    static var danger: UIColor { ThemeStore.look.danger }
    /// Settings: a dark theme or a light one, and a thin veil over the page (white on dark, black on light).
    static var dark: Bool { ThemeStore.look.dark }
    static func veil(_ alpha: CGFloat) -> UIColor { ThemeStore.look.veil(alpha) }

    /// The colours the chat list draws with.
    static var chatList: ChatPalette {
        var palette = ChatPalette()
        palette.bg = bg; palette.text = text; palette.muted = muted; palette.subtle = subtle
        palette.accent = accent; palette.onAccent = onAccent; palette.border = .clear
        palette.pressed = veil(0.07); palette.selected = veil(0.07)
        palette.badgeMuted = surface2; palette.danger = danger; palette.pinned = veil(0.055)
        return palette
    }
}

extension Theme {
    /// The colours a chat's messages draw with.
    static var messages: MsgPalette {
        var palette = MsgPalette()
        palette.text = text; palette.muted = muted; palette.accent = accent; palette.onAccent = onAccent; palette.subtle = subtle
        palette.mine = ThemeStore.look.bubble
        palette.theirs = ThemeStore.look.incoming
        palette.notice = veil(0.06); palette.noticeText = text
        palette.danger = danger; palette.quote = veil(0.08)
        palette.mineMeta = muted; palette.mineMark = text
        return palette
    }
}

/// The bar at the bottom: its size and place.
enum BarMetrics {
    static let height: CGFloat = 62
    static let width: CGFloat = 176
    /// From the bar's lower edge to the screen's.
    static func bottomGap(safeBottom: CGFloat) -> CGFloat { max(safeBottom - 8, 12) }
}

/// A person's colour as a lit ball: the lighter corner and the deeper one (0xAARRGGBB each).
func orbPair(_ rgb: UInt32) -> (light: Int, deep: Int) {
    let r = CGFloat((rgb >> 16) & 255) / 255, g = CGFloat((rgb >> 8) & 255) / 255, b = CGFloat(rgb & 255) / 255
    let top = max(r, g, b), low = min(r, g, b), l = (top + low) / 2, d = top - low
    let sat = d == 0 ? 0 : d / (1 - abs(2 * l - 1))
    let hue: CGFloat = d == 0 ? 0 : top == r ? ((g - b) / d + 6).truncatingRemainder(dividingBy: 6) * 60 : top == g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60
    func hsl(_ h: CGFloat, _ s: CGFloat, _ light: CGFloat) -> Int {
        let a = s * min(light, 1 - light)
        let turn = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 30
        func part(_ n: CGFloat) -> Int {
            let k = (n + turn).truncatingRemainder(dividingBy: 12)
            return Int((255 * (light - a * max(-1, min(k - 3, 9 - k, 1)))).rounded())
        }
        return Int(0xFF00_0000) | part(0) << 16 | part(8) << 8 | part(4)
    }
    let s = min(1, sat * 1.15 + 0.08)
    return (hsl(hue + 38, s, min(0.72, l + 0.16)), hsl(hue - 34, s, max(0.22, l - 0.14)))
}
