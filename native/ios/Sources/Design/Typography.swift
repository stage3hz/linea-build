import CoreText
import ObjectiveC
import UIKit

// The app's typefaces, as the reference sets them (mobile/src/typography.tsx):
//  - every text is Montserrat (SIL OFL 1.1) with the usual weights 400…800;
//  - screen titles and the big names of profiles are Unbounded ExtraBold (SIL OFL 1.1), letter spacing −0.2.
//
// API for every screen (also documented on `Theme` in Theme.swift):
//   Theme.font(15, .semibold)     Montserrat 15 SemiBold — or simply UIFont.systemFont(ofSize: 15, weight: .semibold):
//                                 after `Typography.install()` the system font calls give Montserrat too, so the
//                                 screens written with systemFont follow the reference without being touched.
//   Theme.title(30)               Unbounded ExtraBold 30 (a title: «Чаты», «Каналы», a profile's name)
//   Theme.titleWords("Чаты", size: 30, color: Theme.text)   the same with the reference's −0.2 letter spacing
//   Theme.TypeSize.chatsTitle …   the sizes the reference uses (see Theme.swift)
// Monospaced fonts (`monospacedDigitSystemFont`, `monospacedSystemFont`) stay the system's, as the reference's MONO does.
enum Typography {
    /// The faces in the app (Sources/Design/Fonts, copied from mobile/assets/fonts).
    static let files = ["Montserrat-Regular", "Montserrat-Medium", "Montserrat-SemiBold", "Montserrat-Bold", "Montserrat-ExtraBold", "Unbounded-ExtraBold"]
    static let titleFace = "Unbounded-ExtraBold"
    /// False until the faces are registered; the system font calls give the system face until then.
    private(set) static var active = false
    private static var done = false

    /// Registers the faces and makes the system font calls give Montserrat. Called once, at launch (AppDelegate).
    static func install() {
        guard !done else { return }
        done = true
        register()
        // Only when the faces are really there: otherwise every text keeps the system face.
        guard UIFont(name: "Montserrat-Regular", size: 12) != nil else { return }
        active = true
        exchange("systemFontOfSize:weight:", "invizent_systemFontOfSize:weight:")
        exchange("systemFontOfSize:", "invizent_systemFontOfSize:")
        exchange("boldSystemFontOfSize:", "invizent_boldSystemFontOfSize:")
    }

    /// The faces are registered for this process only (no Info.plist list needed).
    private static func register() {
        for name in files {
            guard let address = Bundle.main.url(forResource: name, withExtension: "ttf") else { continue }
            // Already registered (a second scene, a test): the error is harmless.
            _ = CTFontManagerRegisterFontsForURL(address as CFURL, .process, nil)
        }
    }

    private static func exchange(_ original: String, _ replacement: String) {
        guard let first = class_getClassMethod(UIFont.self, NSSelectorFromString(original)),
              let second = class_getClassMethod(UIFont.self, NSSelectorFromString(replacement)) else { return }
        method_exchangeImplementations(first, second)
    }

    /// The Montserrat face of a weight, as the reference's fontWeight values pick it: 800/900 ExtraBold, 700 Bold,
    /// 600 SemiBold, 500 Medium, the rest Regular.
    static func faceName(_ weight: UIFont.Weight) -> String {
        let value = weight.rawValue
        if value >= UIFont.Weight.heavy.rawValue - 0.01 { return "Montserrat-ExtraBold" }
        if value >= UIFont.Weight.bold.rawValue - 0.01 { return "Montserrat-Bold" }
        if value >= UIFont.Weight.semibold.rawValue - 0.01 { return "Montserrat-SemiBold" }
        if value >= UIFont.Weight.medium.rawValue - 0.01 { return "Montserrat-Medium" }
        return "Montserrat-Regular"
    }

    static func montserrat(_ size: CGFloat, _ weight: UIFont.Weight) -> UIFont? {
        return UIFont(name: faceName(weight), size: size)
    }
}

extension UIFont {
    // After `Typography.install()` these stand in place of the system's methods (and the system's own stand in
    // place of these, which is how the system face is still reached when Montserrat is missing).
    @objc(invizent_systemFontOfSize:weight:)
    dynamic class func invizent_systemFont(ofSize size: CGFloat, weight: UIFont.Weight) -> UIFont {
        if Typography.active, let font = Typography.montserrat(size, weight) { return font }
        return invizent_systemFont(ofSize: size, weight: weight)
    }

    @objc(invizent_systemFontOfSize:)
    dynamic class func invizent_systemFont(ofSize size: CGFloat) -> UIFont {
        if Typography.active, let font = Typography.montserrat(size, .regular) { return font }
        return invizent_systemFont(ofSize: size)
    }

    @objc(invizent_boldSystemFontOfSize:)
    dynamic class func invizent_boldSystemFont(ofSize size: CGFloat) -> UIFont {
        if Typography.active, let font = Typography.montserrat(size, .bold) { return font }
        return invizent_boldSystemFont(ofSize: size)
    }
}
