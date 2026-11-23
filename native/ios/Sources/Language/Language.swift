import ObjectiveC
import UIKit

/// The language of the interface (Настройки → Язык), the way the previous app does it (`mobile/src/i18n/index.ts`):
/// the app is written in Russian; another language is a dictionary keyed by the Russian text (`en.json`, the
/// reference's own file, bundled as it is), applied where text is put on the screen — a label, a button's title,
/// a field's placeholder, an alert. Unknown text stays as it is (names, numbers, messages). Kept on this device.
enum Language {
    struct Choice { let id: String; let name: String; let native: String }
    static let choices: [Choice] = [
        Choice(id: "ru", name: "Russian", native: "Русский"),
        Choice(id: "en", name: "English", native: "English"),
    ]
    static let changed = Notification.Name("invizent.language")
    private static let key = "linea.language.v1"

    /// "ru" unless English was chosen in the settings.
    private(set) static var current: String = {
        return UserDefaults.standard.string(forKey: "linea.language.v1") == "en" ? "en" : "ru"
    }()

    static var chosenName: String {
        return choices.first(where: { (choice: Choice) -> Bool in choice.id == current })?.native ?? "Русский"
    }

    static func set(_ id: String) {
        let next = id == "en" ? "en" : "ru"
        UserDefaults.standard.set(next, forKey: key)
        guard next != current else { return }
        current = next
        NotificationCenter.default.post(name: changed, object: nil)
    }

    private static var english: [String: String] = [:]
    private static var englishUpper: [String: String] = [:]
    private static var loaded = false

    private static func load() {
        guard !loaded else { return }
        loaded = true
        guard let address = Bundle.main.url(forResource: "en", withExtension: "json"),
              let data = try? Data(contentsOf: address),
              let table = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] else { return }
        english = table
        // Captions are put on the screen in capitals («ТЕМА»): they are found by their capitals too.
        var upper: [String: String] = [:]
        for (russian, translated) in table { upper[russian.uppercased()] = translated.uppercased() }
        englishUpper = upper
    }

    /// The text in the current language; unknown text is returned as is. Surrounding spaces are kept.
    static func tr(_ text: String) -> String {
        guard current != "ru", !text.isEmpty else { return text }
        load()
        if let direct = english[text] { return direct }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return text }
        if trimmed != text, let found = english[trimmed] { return text.replacingOccurrences(of: trimmed, with: found) }
        if let upper = englishUpper[trimmed] { return trimmed == text ? upper : text.replacingOccurrences(of: trimmed, with: upper) }
        // A text of several lines whose lines are known one by one (the reference puts them as separate strings around
        // a `{'\n'}`, e.g. «Твой профиль —» / «заметнее любого другого»): each line in its turn — only when every line
        // is known, so a text of someone's own is never half translated.
        if text.contains("\n") {
            let parts = text.components(separatedBy: "\n")
            let done = parts.map { (part: String) -> String in tr(part) }
            let whole = zip(parts, done).allSatisfy { (pair: (String, String)) -> Bool in
                pair.0.trimmingCharacters(in: .whitespaces).isEmpty || pair.0 != pair.1
            }
            if whole && done != parts { return done.joined(separator: "\n") }
        }
        return text
    }

    static func tr(_ text: String?) -> String? {
        guard let text else { return nil }
        return tr(text)
    }

    /// An attributed text whose whole string has a translation: the same attributes (those of its first letter).
    static func tr(_ text: NSAttributedString?) -> NSAttributedString? {
        guard let text, current != "ru", text.length > 0 else { return text }
        let plain = text.string
        let translated = tr(plain)
        if translated == plain { return text }
        let attributes = text.attributes(at: 0, effectiveRange: nil)
        return NSAttributedString(string: translated, attributes: attributes)
    }

    private static var installed = false

    /// Puts the dictionary on the way of every text the interface shows (once, at start).
    static func install() {
        guard !installed else { return }
        installed = true
        swap(UILabel.self, #selector(setter: UILabel.text), #selector(UILabel.lang_setText(_:)))
        swap(UILabel.self, #selector(setter: UILabel.attributedText), #selector(UILabel.lang_setAttributedText(_:)))
        swap(UIButton.self, #selector(UIButton.setTitle(_:for:)), #selector(UIButton.lang_setTitle(_:for:)))
        swap(UITextField.self, #selector(setter: UITextField.placeholder), #selector(UITextField.lang_setPlaceholder(_:)))
    }

    private static func swap(_ type: AnyClass, _ original: Selector, _ replacement: Selector) {
        guard let first = class_getInstanceMethod(type, original), let second = class_getInstanceMethod(type, replacement) else { return }
        // The class's own method is added first when it only inherits it, so nothing above it is changed.
        if class_addMethod(type, original, method_getImplementation(second), method_getTypeEncoding(second)) {
            class_replaceMethod(type, replacement, method_getImplementation(first), method_getTypeEncoding(first))
        } else {
            method_exchangeImplementations(first, second)
        }
    }
}

extension UILabel {
    @objc dynamic func lang_setText(_ text: String?) {
        lang_setText(Language.tr(text))
    }

    @objc dynamic func lang_setAttributedText(_ text: NSAttributedString?) {
        lang_setAttributedText(Language.tr(text))
    }
}

extension UIButton {
    @objc dynamic func lang_setTitle(_ title: String?, for state: UIControl.State) {
        lang_setTitle(Language.tr(title), for: state)
    }
}

extension UITextField {
    @objc dynamic func lang_setPlaceholder(_ text: String?) {
        lang_setPlaceholder(Language.tr(text))
    }
}
