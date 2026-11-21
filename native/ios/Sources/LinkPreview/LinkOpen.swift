import UIKit

/// Opening a link of a chat in the system browser (the previous app: `openLink` in
/// mobile/src/format/FormattedText.tsx with `linkTextMatchesUrl` of mobile/src/format/entities.ts).
enum LinkOpen {
    /// `linkTextMatchesUrl`: whether the words already show where the link goes.
    static func matches(shown: String, url: String) -> Bool {
        func strip(_ value: String) -> String {
            var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
            for scheme in ["https://", "http://"] where text.lowercased().hasPrefix(scheme) {
                text = String(text.dropFirst(scheme.count))
                break
            }
            if text.lowercased().hasPrefix("www.") { text = String(text.dropFirst(4)) }
            while text.hasSuffix("/") { text = String(text.dropLast()) }
            return text.lowercased()
        }
        let words = strip(shown)
        return !words.isEmpty && words == strip(url)
    }

    private static func address(_ url: String) -> URL? {
        let lower = url.lowercased()
        guard lower.hasPrefix("https://") || lower.hasPrefix("http://") else { return nil }
        if let made = URL(string: url) { return made }
        // An address with letters outside ASCII, as people type them.
        return url.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed).flatMap { URL(string: $0) }
    }

    private static func go(_ address: URL) {
        UIApplication.shared.open(address, options: [:], completionHandler: nil)
    }

    /// A link in a message's text: opened at once when its words show the address; a link whose words hide the
    /// address («подробнее» → https://…) is confirmed first, with the whole address shown.
    static func pressed(url: String, shown: String, over host: UIViewController?) {
        guard let address = address(url) else { return }
        if matches(shown: shown, url: url) {
            go(address)
            return
        }
        guard let host else { return }
        let alert = UIAlertController(title: "Открыть ссылку?", message: url, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        alert.addAction(UIAlertAction(title: "Открыть", style: .default, handler: { (_: UIAlertAction) -> Void in go(address) }))
        host.present(alert, animated: true)
    }

    /// The card of a link: its address is the link written in the message itself, so nothing is asked.
    static func cardPressed(url: String) {
        guard let address = address(url) else { return }
        go(address)
    }
}
