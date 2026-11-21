import UIKit

/// The card of a link under a message's text: the site's name, the page's title, a few lines of its description
/// and its picture. Everything shown came inside the encrypted message (the shared core checked it on arrival);
/// showing it asks nothing of anyone — no request is made for a card that was received.
struct MsgLinkCard: Equatable {
    let url: String
    let site: String
    let title: String
    let about: String
    /// The picture as it travelled (a small JPEG in base64); empty: the card has none.
    let image: String
    /// The picture's width over its height.
    let imageWide: CGFloat

    /// From the `linkPreview` of a decrypted message (or the same fields in a row).
    static func parse(_ value: Any?) -> MsgLinkCard? {
        guard let fields = value as? [String: Any], let url = fields["url"] as? String, !url.isEmpty else { return nil }
        var picture = ""
        var wide: CGFloat = 1
        if let image = fields["image"] as? [String: Any], let base64 = image["base64"] as? String, !base64.isEmpty,
           let width = (image["width"] as? NSNumber)?.doubleValue, let height = (image["height"] as? NSNumber)?.doubleValue, width > 0, height > 0 {
            picture = base64
            wide = CGFloat(width / height)
        }
        let card = MsgLinkCard(url: url, site: fields["site"] as? String ?? "", title: fields["title"] as? String ?? "",
                               about: fields["description"] as? String ?? "", image: picture, imageWide: wide)
        if card.site.isEmpty && card.title.isEmpty && card.about.isEmpty && card.image.isEmpty { return nil }
        return card
    }

    /// The decoded picture; nil when the card has none (or it is not a picture after all).
    func picture() -> UIImage? {
        if image.isEmpty { return nil }
        return Data(base64Encoded: image, options: .ignoreUnknownCharacters).flatMap { UIImage(data: $0) }
    }

    /// What a screen reader says for the card.
    var spoken: String {
        return [site, title, about].filter { !$0.isEmpty }.joined(separator: ". ")
    }
}

/// Where the parts of a card go for the width it is given. Frames are from the card's own corner.
struct MsgLinkCardLayout: Equatable {
    var size = CGSize.zero
    var site = CGRect.zero
    var title = CGRect.zero
    var words = CGRect.zero
    var picture = CGRect.zero

    private static let siteFont = UIFont.systemFont(ofSize: 13, weight: .semibold)
    private static let titleFont = UIFont.systemFont(ofSize: 15, weight: .bold)
    private static let wordsFont = UIFont.systemFont(ofSize: 14)
    /// From the card's left edge to its texts: the accent bar and a little air.
    private static let lead: CGFloat = 13
    private static let trail: CGFloat = 11
    private static let widest: CGFloat = 320

    private static func style() -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        style.lineSpacing = 2
        return style
    }

    private static func measure(_ text: String, _ font: UIFont, width: CGFloat, lines: Int) -> CGSize {
        if text.isEmpty { return .zero }
        let limit = ceil(font.lineHeight * CGFloat(lines) + 2 * CGFloat(max(0, lines - 1))) + 1
        let box = NSAttributedString(string: text, attributes: [.font: font, .paragraphStyle: style()])
            .boundingRect(with: CGSize(width: max(1, width), height: limit), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
        return CGSize(width: ceil(box.width), height: ceil(min(box.height, limit)))
    }

    /// The card within `width` (the width a message's text may take).
    static func make(_ card: MsgLinkCard, width: CGFloat) -> MsgLinkCardLayout {
        var layout = MsgLinkCardLayout()
        let outer = max(120, min(width, widest))
        let inner = outer - lead - trail
        let site = measure(card.site, siteFont, width: inner, lines: 1)
        let title = measure(card.title, titleFont, width: inner, lines: 2)
        let words = measure(card.about, wordsFont, width: inner, lines: 5)
        let hasPicture = !card.image.isEmpty
        // With a picture the card takes the whole width it may; without one it is as wide as its words.
        var textWide = max(site.width, title.width, words.width)
        if hasPicture { textWide = inner }
        let cardWide = min(outer, max(140, textWide + lead + trail))
        let column = cardWide - lead - trail
        var y: CGFloat = 9
        if site != .zero {
            layout.site = CGRect(x: lead, y: y, width: column, height: site.height)
            y += site.height + 3
        }
        if title != .zero {
            layout.title = CGRect(x: lead, y: y, width: column, height: title.height)
            y += title.height + 3
        }
        if words != .zero {
            layout.words = CGRect(x: lead, y: y, width: column, height: words.height)
            y += words.height + 3
        }
        if hasPicture {
            // At its own proportions, within reason: a very tall or very wide picture is cropped to fit.
            let wide = min(3, max(0.6, card.imageWide))
            let height = min(260, max(60, (column / wide).rounded()))
            y += 4
            layout.picture = CGRect(x: lead, y: y, width: column, height: height)
            y += height + 3
        }
        layout.size = CGSize(width: cardWide, height: y + 7)
        return layout
    }

    /// Draws the card with its corner at `origin`: a soft plate, the accent bar at its left edge, the site's name,
    /// the title in bold, the description, the picture below with rounded corners.
    func draw(_ card: MsgLinkCard, in context: CGContext, at origin: CGPoint, palette: MsgPalette, accent: UIColor, picture image: UIImage?, pressed: Bool) {
        let box = CGRect(origin: origin, size: size)
        let plate = UIBezierPath(roundedRect: box, cornerRadius: 12)
        context.saveGState()
        context.addPath(plate.cgPath)
        context.clip()
        context.setFillColor(Theme.veil(pressed ? 0.11 : 0.06).cgColor)
        context.fill(box)
        context.setFillColor(accent.cgColor)
        context.fill(CGRect(x: box.minX, y: box.minY, width: 3, height: box.height))
        context.restoreGState()

        func text(_ words: String, _ font: UIFont, _ color: UIColor, _ frame: CGRect) {
            if frame == .zero || words.isEmpty { return }
            NSAttributedString(string: words, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: MsgLinkCardLayout.style()])
                .draw(with: frame.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: 0, dy: -1), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
        }
        text(card.site, MsgLinkCardLayout.siteFont, accent, site)
        text(card.title, MsgLinkCardLayout.titleFont, palette.text, title)
        text(card.about, MsgLinkCardLayout.wordsFont, palette.text.withAlphaComponent(0.82), words)

        if picture != .zero {
            let frame = picture.offsetBy(dx: origin.x, dy: origin.y)
            context.saveGState()
            UIBezierPath(roundedRect: frame, cornerRadius: 9).addClip()
            if let image, image.size.width > 0, image.size.height > 0 {
                let scale = max(frame.width / image.size.width, frame.height / image.size.height)
                let drawn = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                image.draw(in: CGRect(x: frame.midX - drawn.width / 2, y: frame.midY - drawn.height / 2, width: drawn.width, height: drawn.height))
            } else {
                context.setFillColor(Theme.veil(0.05).cgColor)
                context.fill(frame)
            }
            context.restoreGState()
        }
    }
}
