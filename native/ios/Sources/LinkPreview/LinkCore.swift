import Foundation

/// The shared core's part about the cards of links (native/core/src/link_preview.rs), as Swift sees it: which
/// link of a text gets a card, whether an address may be fetched at all, what a fetched page says, and the card
/// as it travels inside an encrypted message. The rules are the core's; nothing here decides anything.
enum LinkCore {
    /// What a fetched page says about itself.
    struct Page {
        let site: String
        let title: String
        let description: String
        let imageUrl: String?
    }

    /// What this phone keeps to when it fetches a page for a card.
    struct Limits {
        var htmlBytes = 256 * 1024
        var imageDownloadBytes = 2 * 1024 * 1024
        var imageBytes = 24 * 1024
        var imageSide = 480
        var redirects = 3
        var timeout: TimeInterval = 6
    }

    private static func take(_ pointer: UnsafeMutablePointer<CChar>?) -> String? {
        guard let pointer else { return nil }
        defer { invizent_string_free(pointer) }
        return String(cString: pointer)
    }

    /// One of the core's link functions by name (see `invizent_link_call`); nil when it has no answer.
    static func call(_ name: String, _ args: [Any] = []) -> Any? {
        guard let argsText = Core.text(args) else { return nil }
        let answer: String? = name.withCString { (name: UnsafePointer<CChar>) -> String? in
            return argsText.withCString { (args: UnsafePointer<CChar>) -> String? in
                return take(invizent_link_call(name, args))
            }
        }
        let value = Core.value(answer)
        return value is NSNull ? nil : value
    }

    static let limits: Limits = {
        var limits = Limits()
        guard let made = call("limits") as? [String: Any] else { return limits }
        if let value = (made["htmlBytes"] as? NSNumber)?.intValue, value > 0 { limits.htmlBytes = value }
        if let value = (made["imageDownloadBytes"] as? NSNumber)?.intValue, value > 0 { limits.imageDownloadBytes = value }
        if let value = (made["imageBytes"] as? NSNumber)?.intValue, value > 0 { limits.imageBytes = value }
        if let value = (made["imageSide"] as? NSNumber)?.intValue, value > 0 { limits.imageSide = value }
        if let value = (made["redirects"] as? NSNumber)?.intValue, value >= 0 { limits.redirects = value }
        if let value = (made["timeoutMs"] as? NSNumber)?.doubleValue, value > 0 { limits.timeout = value / 1000 }
        return limits
    }()

    /// The link of a text that gets the card: its first `https` link, when it may be fetched. Nil: no card.
    static func candidate(_ text: String) -> String? {
        return call("candidate", [text, NSNull()]) as? String
    }

    /// Whether this phone may fetch the address: `https`, the default port, a public host name.
    static func fetchable(_ url: String) -> Bool {
        return call("fetchable", [url]) as? Bool ?? false
    }

    /// Whether an address a host name resolved to must NOT be contacted (loopback, private, link-local…).
    static func privateAddress(_ ip: String) -> Bool {
        return call("privateAddress", [ip]) as? Bool ?? true
    }

    /// The head of a fetched page; nil when the page's address is not one a card may come from.
    static func parse(html: Data, contentType: String?, pageUrl: String) -> Page? {
        var header: Any = NSNull()
        if let contentType { header = contentType }
        guard let made = call("parse", [html.base64EncodedString(), header, pageUrl]) as? [String: Any] else { return nil }
        return Page(site: made["site"] as? String ?? "", title: made["title"] as? String ?? "",
                    description: made["description"] as? String ?? "", imageUrl: made["imageUrl"] as? String)
    }

    /// The card for the encryption service's `encrypt`: the texts made plain and cut to their limits, the picture
    /// (a JPEG this phone has just encoded) cleaned of everything but the picture. Nil: nothing to show.
    static func wire(url: String, site: String, title: String, description: String, jpeg: Data?) -> [String: Any]? {
        var picture: Any = NSNull()
        if let jpeg { picture = jpeg.base64EncodedString() }
        return call("wire", [url, site, title, description, picture]) as? [String: Any]
    }
}
