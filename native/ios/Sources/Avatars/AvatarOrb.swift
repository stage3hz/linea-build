import UIKit

/// The avatar of a person without a photo, one rule for every screen — the reference's `Avatar`
/// (mobile/src/components.tsx:139-150, colours from mobile/src/design/peerLight.tsx `orbColors`):
/// - a ball of three colours [lighter, the colour, deeper] from (.9, 1) to (.1, 0);
/// - over it a white highlight 0.42 → 0.06 → 0 at .0/.38/.6, from (.12, .02) to (.7, .8);
/// - the initials (`Messenger.initials`: the first character of the first two words, in capitals) at 0.32 of the
///   side, bold (700), letter spacing −0.5, dark (#14243D) on a light colour and white on the others.
/// Round always (the owner's rule). Views use the layers and `letters`; canvases call `draw`.
enum AvatarOrb {
    /// components.tsx:139 `avatarTextColor`: #14243D when 0.299 R + 0.587 G + 0.114 B is above 0.68, else white.
    static func lettersColor(_ rgb: UInt32) -> UIColor {
        let r = CGFloat((rgb >> 16) & 255) / 255, g = CGFloat((rgb >> 8) & 255) / 255, b = CGFloat(rgb & 255) / 255
        return r * 0.299 + g * 0.587 + b * 0.114 > 0.68 ? UIColor(hex: 0x14243D) : UIColor.white
    }

    /// peerLight.tsx `orbColors`: [lighter, colour, deeper].
    static func bodyColors(_ rgb: UInt32) -> [CGColor] {
        let pair = orbPair(rgb & 0xFFFFFF)
        let light = UIColor(hex: UInt32(truncatingIfNeeded: pair.light) & 0xFFFFFF)
        let deep = UIColor(hex: UInt32(truncatingIfNeeded: pair.deep) & 0xFFFFFF)
        return [light.cgColor, UIColor(hex: rgb & 0xFFFFFF).cgColor, deep.cgColor]
    }

    static let bodyStart = CGPoint(x: 0.9, y: 1)
    static let bodyEnd = CGPoint(x: 0.1, y: 0)
    static let shineColors: [CGColor] = [UIColor(white: 1, alpha: 0.42).cgColor, UIColor(white: 1, alpha: 0.06).cgColor, UIColor(white: 1, alpha: 0).cgColor]
    static let shineStart = CGPoint(x: 0.12, y: 0.02)
    static let shineEnd = CGPoint(x: 0.7, y: 0.8)
    private static let bodyStops: [CGFloat] = [0, 0.5, 1]
    private static let shineStops: [CGFloat] = [0, 0.38, 0.6]

    /// The ball's gradient as a layer (its colours: `bodyColors`).
    static func bodyLayer() -> CAGradientLayer {
        let layer = CAGradientLayer()
        layer.startPoint = bodyStart
        layer.endPoint = bodyEnd
        return layer
    }

    /// The white highlight as a layer, laid over the ball.
    static func shineLayer() -> CAGradientLayer {
        let layer = CAGradientLayer()
        layer.colors = shineColors
        layer.locations = [0, 0.38, 0.6]
        layer.startPoint = shineStart
        layer.endPoint = shineEnd
        return layer
    }

    /// The initials as the reference sets them for an avatar `side` points wide.
    static func letters(_ text: String, side: CGFloat, rgb: UInt32) -> NSAttributedString {
        let font = AppFont.text(max(1, side * 0.32), .bold)
        return NSAttributedString(string: text, attributes: [.font: font, .kern: CGFloat(-0.5), .foregroundColor: lettersColor(rgb)])
    }

    /// The whole avatar (ball, highlight, initials) inside the circle of `box`, into the current graphics context.
    static func draw(in context: CGContext, box: CGRect, rgb: UInt32, initials: String) {
        guard box.width > 0, box.height > 0 else { return }
        context.saveGState()
        context.addEllipse(in: box)
        context.clip()
        let space: CGColorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let extend: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        let bodyFrom = CGPoint(x: box.minX + box.width * bodyStart.x, y: box.minY + box.height * bodyStart.y)
        let bodyTo = CGPoint(x: box.minX + box.width * bodyEnd.x, y: box.minY + box.height * bodyEnd.y)
        if let body = CGGradient(colorsSpace: space, colors: bodyColors(rgb) as CFArray, locations: bodyStops) {
            context.drawLinearGradient(body, start: bodyFrom, end: bodyTo, options: extend)
        }
        let shineFrom = CGPoint(x: box.minX + box.width * shineStart.x, y: box.minY + box.height * shineStart.y)
        let shineTo = CGPoint(x: box.minX + box.width * shineEnd.x, y: box.minY + box.height * shineEnd.y)
        if let shine = CGGradient(colorsSpace: space, colors: shineColors as CFArray, locations: shineStops) {
            context.drawLinearGradient(shine, start: shineFrom, end: shineTo, options: extend)
        }
        context.restoreGState()
        drawLetters(initials, box: box, rgb: rgb)
    }

    /// Only the initials, centred in `box` (into the current graphics context).
    static func drawLetters(_ text: String, box: CGRect, rgb: UInt32) {
        guard !text.isEmpty else { return }
        let words = letters(text, side: box.width, rgb: rgb)
        let size = words.size()
        words.draw(at: CGPoint(x: box.midX - size.width / 2, y: box.midY - size.height / 2))
    }
}
