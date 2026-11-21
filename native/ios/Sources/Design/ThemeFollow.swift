import UIKit

/// Colours that the screens once fixed for the black look, made to follow the theme that is on. On «Чёрная» each
/// gives back the very colour the screen always had, so the app's own look does not change by a pixel; every other
/// theme takes its own colours from `ThemeStore.look`.
extension Theme {
    /// On «Чёрная» the fixed colour; on any other theme the given one.
    static func onBlack(_ fixed: UIColor, otherwise: UIColor) -> UIColor {
        return ThemeStore.look.black ? fixed : otherwise
    }

    /// An opaque page of its own (a sheet, a screen opened on top): `fixed` on «Чёрная», the theme's page elsewhere.
    static func page(_ fixed: UIColor) -> UIColor {
        return onBlack(fixed, otherwise: bg)
    }

    /// A card, a field or a bubble raised over the page: `fixed` on «Чёрная», the theme's card colour elsewhere.
    static func raised(_ fixed: UIColor) -> UIColor {
        return onBlack(fixed, otherwise: ThemeStore.look.incoming)
    }

    /// An opaque panel floating over the page (a menu, a toast, a bar): `fixed` on «Чёрная»; elsewhere the theme's
    /// card colour laid over its page, so nothing shows through.
    static func panel(_ fixed: UIColor) -> UIColor {
        return onBlack(fixed, otherwise: solid(ThemeStore.look.incoming, over: bg))
    }

    /// One colour laid over another, as a single opaque colour.
    static func solid(_ top: UIColor, over bottom: UIColor) -> UIColor {
        var topRed: CGFloat = 0, topGreen: CGFloat = 0, topBlue: CGFloat = 0, topAlpha: CGFloat = 0
        var lowRed: CGFloat = 0, lowGreen: CGFloat = 0, lowBlue: CGFloat = 0, lowAlpha: CGFloat = 0
        guard top.getRed(&topRed, green: &topGreen, blue: &topBlue, alpha: &topAlpha),
              bottom.getRed(&lowRed, green: &lowGreen, blue: &lowBlue, alpha: &lowAlpha) else { return bottom }
        let keep: CGFloat = 1 - topAlpha
        return UIColor(red: topRed * topAlpha + lowRed * keep, green: topGreen * topAlpha + lowGreen * keep,
                       blue: topBlue * topAlpha + lowBlue * keep, alpha: 1)
    }

    /// The thin blur under menus and panels: dark on a dark theme, light on a light one.
    static var thinBlur: UIBlurEffect {
        return UIBlurEffect(style: dark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight)
    }
}
