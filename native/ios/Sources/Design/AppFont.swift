import UIKit

/// The reference's typefaces (typography.tsx) under a short name. One source of truth: everything here hands over
/// to `Theme.font` / `Theme.title` (Design/Theme.swift, faces registered by Design/Typography.swift), so the two
/// spellings can never drift apart.
enum AppFont {
    /// Text in Montserrat at the weight asked for.
    static func text(_ size: CGFloat, _ weight: UIFont.Weight = .regular) -> UIFont {
        return Theme.font(size, weight)
    }

    /// A screen title: Unbounded ExtraBold («Чаты», «Настройки»…). The reference sets it with letterSpacing −0.2.
    static func title(_ size: CGFloat) -> UIFont {
        return Theme.title(size)
    }

    /// The kern the reference gives titles.
    static let titleKern: CGFloat = Theme.titleKern
}
