import UIKit

/// The reference's typefaces (typography.tsx): Montserrat for text (weights 400–800) and Unbounded ExtraBold for
/// screen titles. The files are in Sources/Design/Fonts and named in Info.plist (`UIAppFonts`, project.yml);
/// while a face is missing (an older build) the system font of the same weight is used, so nothing breaks.
enum AppFont {
    /// Text in Montserrat at the weight asked for.
    static func text(_ size: CGFloat, _ weight: UIFont.Weight = .regular) -> UIFont {
        let name: String
        switch weight {
        case .medium: name = "Montserrat-Medium"
        case .semibold: name = "Montserrat-SemiBold"
        case .bold: name = "Montserrat-Bold"
        case .heavy, .black: name = "Montserrat-ExtraBold"
        default: name = "Montserrat-Regular"
        }
        return UIFont(name: name, size: size) ?? .systemFont(ofSize: size, weight: weight)
    }

    /// A screen title: Unbounded ExtraBold («Чаты», «Настройки»…). The reference sets it with letterSpacing −0.2.
    static func title(_ size: CGFloat) -> UIFont {
        UIFont(name: "Unbounded-ExtraBold", size: size) ?? .systemFont(ofSize: size, weight: .heavy)
    }

    /// The kern the reference gives titles.
    static let titleKern: CGFloat = -0.2
}
