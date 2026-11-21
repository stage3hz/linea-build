import CoreText
import UIKit

// Where everything of one row of a channel's chat goes, for the width it is shown at — and the lines of text
// themselves, already broken and shaped. A layout is made OFF the main thread (ChannelEngine) and never changes
// afterwards; the main thread only draws what is in it: no measuring, no line breaking, no Auto Layout.

/// The colours and fonts of a channel's chat. The colours are those of the theme that is on, read each time, so a
/// change of theme reaches the next layout without a restart.
enum ChannelLook {
    static var text: UIColor { Theme.text }
    static var muted: UIColor { Theme.muted }
    static var subtle: UIColor { Theme.subtle }
    static var accent: UIColor { Theme.accent }
    static var onAccent: UIColor { Theme.onAccent }
    static var surface: UIColor { Theme.surface2 }
    static var card: UIColor { Theme.raised(UIColor(red: 22 / 255, green: 23 / 255, blue: 24 / 255, alpha: 0.96)) }
    static var soft: UIColor { Theme.veil(0.10) }
    static var line: UIColor { Theme.veil(0.08) }
    static let mark = UIColor(hex: 0xF5C542)
    static let join = UIColor(hex: 0x2FA36B)

    static let body = UIFont.systemFont(ofSize: 15.5)
    static let post = UIFont.systemFont(ofSize: 16)
    static let name = UIFont.systemFont(ofSize: 15, weight: .bold)
    static let small = UIFont.systemFont(ofSize: 11)
    static let smallBold = UIFont.systemFont(ofSize: 11, weight: .semibold)
    static let reply = UIFont.systemFont(ofSize: 13)
    static let replyBold = UIFont.systemFont(ofSize: 13, weight: .semibold)
    static let fileName = UIFont.systemFont(ofSize: 14, weight: .semibold)
    static let fileSize = UIFont.systemFont(ofSize: 12)
    static let chipEmoji = UIFont.systemFont(ofSize: 14)
    static let chipCount = UIFont.systemFont(ofSize: 12, weight: .semibold)
    static let cardName = UIFont.systemFont(ofSize: 16, weight: .bold)
    static let button = UIFont.systemFont(ofSize: 14, weight: .bold)

    /// How many pixels a picture shown in a box of this size is decoded at.
    static func pixels(_ size: CGSize, scale: CGFloat) -> Int {
        return Int((max(size.width, size.height) * scale * 1.5).rounded())
    }
}

/// Text through Core Text: a shaped line or a broken paragraph is an immutable value that any thread may make
/// and the main thread draws without laying it out again.
enum ChannelType {
    private static let colorKey = NSAttributedString.Key(kCTForegroundColorAttributeName as String)
    private static let paragraphKey = NSAttributedString.Key(kCTParagraphStyleAttributeName as String)

    static func attributes(_ font: UIFont, _ color: UIColor) -> [NSAttributedString.Key: Any] {
        return [.font: font, colorKey: color.cgColor]
    }

    /// A paragraph that wraps by words with a little room between its lines.
    static func paragraph(spacing: CGFloat) -> CTParagraphStyle {
        var gap = spacing
        var mode = CTLineBreakMode.byWordWrapping
        return withUnsafePointer(to: &gap) { (gapPointer: UnsafePointer<CGFloat>) -> CTParagraphStyle in
            return withUnsafePointer(to: &mode) { (modePointer: UnsafePointer<CTLineBreakMode>) -> CTParagraphStyle in
                let settings: [CTParagraphStyleSetting] = [
                    CTParagraphStyleSetting(spec: .lineSpacingAdjustment, valueSize: MemoryLayout<CGFloat>.size, value: UnsafeRawPointer(gapPointer)),
                    CTParagraphStyleSetting(spec: .lineBreakMode, valueSize: MemoryLayout<CTLineBreakMode>.size, value: UnsafeRawPointer(modePointer)),
                ]
                return CTParagraphStyleCreate(settings, settings.count)
            }
        }
    }

    private static let bodyParagraph = paragraph(spacing: 2.5)
    private static let postParagraph = paragraph(spacing: 4)

    /// The text of a message: its links in the accent colour, «(изм.)» after an edited one.
    static func body(_ row: ChannelRow) -> NSAttributedString {
        var base = attributes(row.blog ? ChannelLook.post : ChannelLook.body, ChannelLook.text)
        base[paragraphKey] = row.blog ? postParagraph : bodyParagraph
        let made = NSMutableAttributedString(string: row.text, attributes: base)
        let total = (row.text as NSString).length
        for link in row.links where link.location >= 0 && link.length > 0 && link.location + link.length <= total {
            let range = NSRange(location: link.location, length: link.length)
            made.addAttribute(colorKey, value: ChannelLook.accent.cgColor, range: range)
            if !link.url.hasPrefix("mention:") { made.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range) }
        }
        if row.edited {
            var quiet = attributes(ChannelLook.small, ChannelLook.subtle)
            quiet[paragraphKey] = row.blog ? postParagraph : bodyParagraph
            made.append(NSAttributedString(string: " (изм.)", attributes: quiet))
        }
        return made
    }

    struct Line {
        let line: CTLine
        let width: CGFloat
        let ascent: CGFloat
        let descent: CGFloat
        var height: CGFloat { return ceil(ascent + descent) }
    }

    /// One line, cut with «…» when it is wider than `width`.
    static func line(_ text: NSAttributedString, width: CGFloat) -> Line {
        var line = CTLineCreateWithAttributedString(text)
        var ascent: CGFloat = 0
        var descent: CGFloat = 0
        var leading: CGFloat = 0
        var wide = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
        if wide > width, text.length > 0 {
            let token = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: text.attributes(at: text.length - 1, effectiveRange: nil)))
            if let cut = CTLineCreateTruncatedLine(line, Double(max(1, width)), .end, token) {
                line = cut
                wide = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
            }
        }
        return Line(line: line, width: ceil(wide), ascent: ascent, descent: descent)
    }

    static func line(_ text: String, _ font: UIFont, _ color: UIColor, width: CGFloat) -> Line {
        return line(NSAttributedString(string: text.replacingOccurrences(of: "\n", with: " "), attributes: attributes(font, color)), width: width)
    }

    /// A paragraph broken into lines for `width`: the frame to draw and the room it takes.
    static func block(_ text: NSAttributedString, width: CGFloat) -> (frame: CTFrame, size: CGSize) {
        let setter = CTFramesetterCreateWithAttributedString(text)
        let wide = max(1, width)
        let fit = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(location: 0, length: 0), nil, CGSize(width: wide, height: CGFloat.greatestFiniteMagnitude), nil)
        // Two points of slack: a frame exactly as tall as its text may drop the last line.
        let size = CGSize(width: ceil(fit.width), height: ceil(fit.height) + 2)
        let path = CGPath(rect: CGRect(x: 0, y: 0, width: wide, height: size.height), transform: nil)
        return (CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil), size)
    }
}

/// One thing to draw. Coordinates are the row's own, y going down.
enum ChannelPiece {
    /// A filled rounded plate.
    case fill(CGRect, CGFloat, CGColor)
    /// A hairline around a rounded plate.
    case border(CGRect, CGFloat, CGColor)
    /// A line of text: its left edge and its baseline.
    case text(CTLine, CGPoint)
    /// A paragraph in its box (the box is exactly as tall as the frame's path).
    case block(CTFrame, CGRect)
    /// A round picture: the file's id (empty: none), the colours shown without one, and the letters on them.
    case avatar(CGRect, String, [CGColor], ChannelType.Line?)
    /// A picture filling its box, corners rounded.
    case picture(CGRect, String, CGFloat)
    /// A system symbol centred in its box.
    case icon(String, CGRect, UIColor)
}

/// What a touch on a row landed on.
enum ChannelHit {
    case row
    case link(String)
    case chip(String)
    case author
    case attachment
    case invite
}

final class ChannelRowLayout {
    let row: ChannelRow
    /// The message the row was made from (for the menu and the actions on it).
    let message: CommunityMessage
    let width: CGFloat
    private(set) var height: CGFloat = 0
    private(set) var pieces: [ChannelPiece] = []
    /// The ids of the pictures the row shows: it is drawn again when one of them arrives.
    private(set) var pictures: [String] = []
    private var bodyFrame: CTFrame?
    private var bodyBox = CGRect.zero
    private var chipBoxes: [(frame: CGRect, emoji: String)] = []
    private var authorBoxes: [CGRect] = []
    private var attachmentBox = CGRect.zero
    private var inviteBox = CGRect.zero

    init(row: ChannelRow, message: CommunityMessage, width: CGFloat) {
        self.row = row
        self.message = message
        self.width = width
        build()
    }

    private func build() {
        var y: CGFloat = 0
        if !row.day.isEmpty {
            // The date between two hairlines.
            let day = ChannelType.line(row.day, ChannelLook.smallBold, ChannelLook.muted, width: width - 80)
            let left = (width - day.width) / 2
            pieces.append(.text(day.line, CGPoint(x: left, y: 12 + 7 + day.ascent - day.height / 2)))
            pieces.append(.fill(CGRect(x: 14, y: 19, width: max(0, left - 10 - 14), height: 0.5), 0, ChannelLook.line.cgColor))
            pieces.append(.fill(CGRect(x: left + day.width + 10, y: 19, width: max(0, width - 14 - (left + day.width + 10)), height: 0.5), 0, ChannelLook.line.cgColor))
            y = 38
        }
        let top = y
        let marks = pieces.count
        if row.blog {
            // A post: a card with the text, what is attached, and the time in its lower corner.
            let cardTop = y + 6
            var inside = cardTop + 14
            inside = content(x: 26, width: width - 52, y: inside, gap: 6)
            let time = ChannelType.line(row.time, ChannelLook.small, ChannelLook.subtle, width: 120)
            if inside > cardTop + 14 { inside += 6 }
            pieces.append(.text(time.line, CGPoint(x: width - 26 - time.width, y: inside + time.ascent)))
            inside += time.height + 14
            pieces.insert(.fill(CGRect(x: 12, y: cardTop, width: width - 24, height: inside - cardTop), 18, ChannelLook.card.cgColor), at: marks)
            y = inside + 6
        } else {
            y += row.header ? 10 : 1
            let left: CGFloat = 66
            let inner = width - left - 14
            let headTop = y
            if row.header {
                let box = CGRect(x: 14, y: y, width: 40, height: 40)
                let pair = orbPair(row.avatarColor)
                let colors = [UIColor(hex: UInt32(truncatingIfNeeded: pair.light) & 0xFFFFFF).cgColor, UIColor(hex: row.avatarColor).cgColor, UIColor(hex: UInt32(truncatingIfNeeded: pair.deep) & 0xFFFFFF).cgColor]
                let letters = row.initials.isEmpty ? nil : ChannelType.line(row.initials, UIFont.systemFont(ofSize: 14.5, weight: .bold), .white, width: 34)
                pieces.append(.avatar(box, row.avatarId, colors, letters))
                if !row.avatarId.isEmpty { pictures.append(row.avatarId) }
                authorBoxes.append(box)
                let time = ChannelType.line(row.time, ChannelLook.small, ChannelLook.subtle, width: 60)
                let ribbon: CGFloat = row.owner ? 19 : 0
                let name = ChannelType.line(row.author, ChannelLook.name, row.authorColor.map { UIColor(hex: $0) } ?? ChannelLook.text, width: max(20, inner - time.width - 8 - ribbon))
                let baseline = y + name.ascent
                pieces.append(.text(name.line, CGPoint(x: left, y: baseline)))
                authorBoxes.append(CGRect(x: left, y: y - 4, width: name.width, height: name.height + 8))
                var after = left + name.width + 8
                if row.owner {
                    pieces.append(.icon("rosette", CGRect(x: after - 2, y: baseline - 12, width: 14, height: 14), ChannelLook.mark))
                    after += ribbon
                }
                pieces.append(.text(time.line, CGPoint(x: after, y: baseline)))
                y += name.height + 2
            }
            y = content(x: left, width: inner, y: y, gap: 0)
            if row.header { y = max(y, headTop + 40) }
            y += 2
        }
        if row.forMe {
            // It mentions the person or answers them.
            pieces.insert(.fill(CGRect(x: 0, y: top, width: width, height: y - top), 0, ChannelLook.mark.withAlphaComponent(0.10).cgColor), at: marks)
            pieces.insert(.fill(CGRect(x: 0, y: top, width: 2, height: y - top), 0, ChannelLook.mark.cgColor), at: marks + 1)
        }
        height = ceil(y)
    }

    /// The message itself: what it answers, its text, what is attached, an invitation, the reactions.
    private func content(x: CGFloat, width inner: CGFloat, y start: CGFloat, gap: CGFloat) -> CGFloat {
        var y = start
        var any = false
        func step(_ margin: CGFloat) {
            if any { y += gap + margin }
            any = true
        }
        if row.hasReply {
            step(0)
            let words = NSMutableAttributedString(string: row.replyAuthor.replacingOccurrences(of: "\n", with: " "), attributes: ChannelType.attributes(ChannelLook.replyBold, ChannelLook.muted))
            words.append(NSAttributedString(string: " " + row.replyText, attributes: ChannelType.attributes(ChannelLook.reply, ChannelLook.muted)))
            let line = ChannelType.line(words, width: inner - 19)
            pieces.append(.icon("arrow.turn.down.right", CGRect(x: x, y: y + 2, width: 13, height: 13), ChannelLook.subtle))
            pieces.append(.text(line.line, CGPoint(x: x + 19, y: y + line.ascent)))
            y += line.height + 3
        }
        if !row.text.isEmpty {
            step(0)
            let made = ChannelType.block(ChannelType.body(row), width: inner)
            let box = CGRect(x: x, y: y, width: inner, height: made.size.height)
            pieces.append(.block(made.frame, box))
            bodyFrame = made.frame
            bodyBox = box
            y += made.size.height - 2
        }
        if row.attachKind == 1 {
            step(4)
            let box = CGRect(x: x, y: y, width: row.blog ? inner : min(240, inner), height: row.blog ? 240 : 180)
            pieces.append(.fill(box, 12, ChannelLook.surface.cgColor))
            pieces.append(.picture(box, row.attachId, 12))
            pictures.append(row.attachId)
            attachmentBox = box
            y += box.height
        } else if row.attachKind != 0 {
            step(4)
            let box = CGRect(x: x, y: y, width: min(300, inner), height: 60)
            pieces.append(.fill(box, 12, ChannelLook.surface.cgColor))
            pieces.append(.fill(CGRect(x: x + 10, y: y + 10, width: 40, height: 40), 10, ChannelLook.soft.cgColor))
            pieces.append(.icon(row.attachKind == 3 ? "video.fill" : "doc.fill", CGRect(x: x + 10, y: y + 10, width: 40, height: 40), ChannelLook.accent))
            let name = ChannelType.line(row.attachName, ChannelLook.fileName, ChannelLook.text, width: box.width - 70)
            let size = ChannelType.line(row.attachSize, ChannelLook.fileSize, ChannelLook.muted, width: box.width - 70)
            pieces.append(.text(name.line, CGPoint(x: x + 60, y: y + 13 + name.ascent)))
            pieces.append(.text(size.line, CGPoint(x: x + 60, y: y + 33 + size.ascent)))
            attachmentBox = box
            y += box.height
        }
        if let invite = row.invite {
            step(6)
            y = inviteCard(invite, x: x, width: min(300, inner), y: y)
        }
        if !row.chips.isEmpty {
            step(4)
            var cx: CGFloat = 0
            var cy: CGFloat = 0
            for chip in row.chips {
                let emoji = ChannelType.line(chip.emoji, ChannelLook.chipEmoji, ChannelLook.text, width: 60)
                let count = ChannelType.line(String(chip.count), ChannelLook.chipCount, chip.mine ? ChannelLook.accent : ChannelLook.muted, width: 60)
                let wide = 8 + emoji.width + 5 + count.width + 8
                if cx > 0 && cx + wide > inner {
                    cx = 0
                    cy += 31
                }
                let frame = CGRect(x: x + cx, y: y + cy, width: wide, height: 26)
                pieces.append(.fill(frame, 13, (chip.mine ? ChannelLook.soft : ChannelLook.surface).cgColor))
                pieces.append(.border(frame, 13, (chip.mine ? ChannelLook.accent : ChannelLook.line).cgColor))
                pieces.append(.text(emoji.line, CGPoint(x: frame.minX + 8, y: frame.midY + (emoji.ascent - emoji.descent) / 2)))
                pieces.append(.text(count.line, CGPoint(x: frame.minX + 8 + emoji.width + 5, y: frame.midY + (count.ascent - count.descent) / 2)))
                chipBoxes.append((frame, chip.emoji))
                cx += wide + 5
            }
            y += cy + 26
        }
        return y
    }

    private func inviteCard(_ invite: ChannelInviteCard, x: CGFloat, width wide: CGFloat, y: CGFloat) -> CGFloat {
        if invite.state != 2 {
            let box = CGRect(x: x, y: y, width: wide, height: 44)
            pieces.append(.fill(box, 14, ChannelLook.surface.cgColor))
            pieces.append(.icon("link", CGRect(x: x + 12, y: y + 13, width: 18, height: 18), ChannelLook.subtle))
            let words = ChannelType.line(invite.state == 1 ? "Приглашение недействительно" : "Приглашение", ChannelLook.reply, ChannelLook.muted, width: wide - 50)
            pieces.append(.text(words.line, CGPoint(x: x + 38, y: y + 22 + (words.ascent - words.descent) / 2)))
            return y + 44
        }
        let box = CGRect(x: x, y: y, width: wide, height: 144)
        pieces.append(.fill(box, 16, Theme.veil(0.06).cgColor))
        pieces.append(.border(box, 16, ChannelLook.line.cgColor))
        let kind = ChannelType.line((invite.blog ? "КАНАЛ" : "СЕРВЕР") + (invite.closed ? " · ЗАКРЫТЫЙ" : ""), UIFont.systemFont(ofSize: 11, weight: .bold), ChannelLook.muted, width: wide - 24)
        pieces.append(.text(kind.line, CGPoint(x: x + 12, y: y + 12 + kind.ascent)))
        let face = CGRect(x: x + 12, y: y + 36, width: 48, height: 48)
        let pair = ChannelWords.gradient(invite.communityId)
        let letters = ChannelType.line(ChannelWords.initials(invite.name), UIFont.systemFont(ofSize: 16, weight: .bold), .white, width: 40)
        pieces.append(.avatar(face, invite.avatarId, [UIColor(hex: pair.0).cgColor, UIColor(hex: pair.1).cgColor], letters))
        if !invite.avatarId.isEmpty { pictures.append(invite.avatarId) }
        let name = ChannelType.line(invite.name, ChannelLook.cardName, ChannelLook.text, width: wide - 24 - 59)
        pieces.append(.text(name.line, CGPoint(x: x + 71, y: y + 40 + name.ascent)))
        let details = ChannelType.line(invite.details, ChannelLook.fileSize, ChannelLook.muted, width: wide - 24 - 59)
        pieces.append(.text(details.line, CGPoint(x: x + 71, y: y + 63 + details.ascent)))
        let button = CGRect(x: x + 12, y: y + 94, width: wide - 24, height: 38)
        pieces.append(.fill(button, 10, (invite.member ? ChannelLook.surface : ChannelLook.join).cgColor))
        let label = ChannelType.line(invite.member ? "Открыть" : (invite.blog ? "Перейти в канал" : "Перейти на сервер"), ChannelLook.button, invite.member ? ChannelLook.text : UIColor.white, width: wide - 40)
        pieces.append(.text(label.line, CGPoint(x: button.midX - label.width / 2, y: button.midY + (label.ascent - label.descent) / 2)))
        inviteBox = box
        return y + 144
    }

    /// What is under a point of the row.
    func hit(_ point: CGPoint) -> ChannelHit {
        for chip in chipBoxes where chip.frame.insetBy(dx: -3, dy: -4).contains(point) { return .chip(chip.emoji) }
        if let url = link(at: point) { return .link(url) }
        if attachmentBox.contains(point) { return .attachment }
        if inviteBox.contains(point) { return .invite }
        for box in authorBoxes where box.contains(point) { return .author }
        return .row
    }

    private func link(at point: CGPoint) -> String? {
        guard let bodyFrame, !row.links.isEmpty, bodyBox.contains(point) else { return nil }
        let lines = CTFrameGetLines(bodyFrame) as? [CTLine] ?? []
        guard !lines.isEmpty else { return nil }
        var origins = [CGPoint](repeating: .zero, count: lines.count)
        CTFrameGetLineOrigins(bodyFrame, CFRange(location: 0, length: 0), &origins)
        let x = point.x - bodyBox.minX
        let fromTop = point.y - bodyBox.minY
        for (index, line) in lines.enumerated() {
            var ascent: CGFloat = 0
            var descent: CGFloat = 0
            var leading: CGFloat = 0
            let wide = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
            let baseline = bodyBox.height - origins[index].y
            guard fromTop >= baseline - ascent - 2, fromTop <= baseline + descent + 2, x >= origins[index].x - 4, x <= origins[index].x + wide + 4 else { continue }
            let at = CTLineGetStringIndexForPosition(line, CGPoint(x: x - origins[index].x, y: 0))
            guard at != kCFNotFound else { return nil }
            // The nearest gap between two letters: the letter touched is the one before it or after it.
            let offset = CTLineGetOffsetForStringIndex(line, at, nil)
            let touched = x - origins[index].x < offset ? at - 1 : at
            for link in row.links where touched >= link.location && touched < link.location + link.length { return link.url }
            return nil
        }
        return nil
    }

    /// Read aloud for the row.
    var spoken: String {
        var parts: [String] = []
        if row.header { parts.append(row.author) }
        if !row.text.isEmpty { parts.append(row.text) }
        if row.attachKind != 0 { parts.append(row.attachKind == 1 ? "Фото" : row.attachName) }
        parts.append(row.time)
        return parts.joined(separator: ". ")
    }
}

/// The symbols rows draw, tinted once each. Main queue.
private enum ChannelSymbols {
    private static var made: [String: UIImage] = [:]

    static func image(_ name: String, side: CGFloat, color: UIColor) -> UIImage? {
        let key = name + "|" + String(Int(side * 10)) + "|" + String(color.hashValue)
        if let hit = made[key] { return hit }
        let config = UIImage.SymbolConfiguration(pointSize: side * 0.82, weight: .semibold)
        guard let image = UIImage(systemName: name, withConfiguration: config)?.withTintColor(color, renderingMode: .alwaysOriginal) else { return nil }
        made[key] = image
        return image
    }
}

/// Draws one row from its finished layout.
final class ChannelRowCanvas: UIView {
    var layoutInfo: ChannelRowLayout?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { return nil }

    private func rounded(_ box: CGRect, _ radius: CGFloat) -> CGPath {
        return radius <= 0 ? CGPath(rect: box, transform: nil) : UIBezierPath(roundedRect: box, cornerRadius: radius).cgPath
    }

    private func draw(_ line: CTLine, at point: CGPoint, in context: CGContext) {
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: 0, y: point.y)
        context.scaleBy(x: 1, y: -1)
        context.textPosition = CGPoint(x: point.x, y: 0)
        CTLineDraw(line, context)
        context.restoreGState()
    }

    private func drawCover(_ image: UIImage, in box: CGRect) {
        guard image.size.width > 0, image.size.height > 0 else { return }
        let scale = max(box.width / image.size.width, box.height / image.size.height)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        image.draw(in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height))
    }

    override func draw(_ rect: CGRect) {
        guard let layoutInfo, let context = UIGraphicsGetCurrentContext() else { return }
        let scale = window?.screen.scale ?? traitCollection.displayScale
        for piece in layoutInfo.pieces {
            switch piece {
            case .fill(let box, let radius, let color):
                context.setFillColor(color)
                context.addPath(rounded(box, radius))
                context.fillPath()
            case .border(let box, let radius, let color):
                context.setStrokeColor(color)
                context.setLineWidth(1)
                context.addPath(rounded(box.insetBy(dx: 0.5, dy: 0.5), radius))
                context.strokePath()
            case .text(let line, let point):
                draw(line, at: point, in: context)
            case .block(let frame, let box):
                context.saveGState()
                context.textMatrix = .identity
                context.translateBy(x: box.minX, y: box.maxY)
                context.scaleBy(x: 1, y: -1)
                CTFrameDraw(frame, context)
                context.restoreGState()
            case .avatar(let box, let id, let colors, let letters):
                context.saveGState()
                context.addEllipse(in: box)
                context.clip()
                if let image = ChannelImages.shared.image(id: id, pixels: ChannelLook.pixels(box.size, scale: scale)) {
                    drawCover(image, in: box)
                } else {
                    if let space = CGColorSpace(name: CGColorSpace.sRGB), let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: nil) {
                        context.drawLinearGradient(gradient, start: CGPoint(x: box.minX + box.width * 0.1, y: box.minY), end: CGPoint(x: box.minX + box.width * 0.9, y: box.maxY),
                                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
                    }
                    if let letters {
                        draw(letters.line, at: CGPoint(x: box.midX - letters.width / 2, y: box.midY + (letters.ascent - letters.descent) / 2), in: context)
                    }
                }
                context.restoreGState()
            case .picture(let box, let id, let radius):
                guard let image = ChannelImages.shared.image(id: id, pixels: ChannelLook.pixels(box.size, scale: scale)) else { continue }
                context.saveGState()
                context.addPath(rounded(box, radius))
                context.clip()
                drawCover(image, in: box)
                context.restoreGState()
            case .icon(let name, let box, let color):
                guard let image = ChannelSymbols.image(name, side: min(box.width, box.height), color: color) else { continue }
                let size = image.size
                let fit = min(1, min(box.width / max(1, size.width), box.height / max(1, size.height)))
                let shown = CGSize(width: size.width * fit, height: size.height * fit)
                image.draw(in: CGRect(x: box.midX - shown.width / 2, y: box.midY - shown.height / 2, width: shown.width, height: shown.height))
            }
        }
    }
}

/// A cell of the list: one canvas, nothing else. The table is upside down, so the cell turns its content back.
final class ChannelRowCell: UITableViewCell {
    let canvas = ChannelRowCanvas(frame: .zero)

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        selectionStyle = .none
        contentView.transform = CGAffineTransform(scaleX: 1, y: -1)
        canvas.frame = contentView.bounds
        canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        contentView.addSubview(canvas)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ layout: ChannelRowLayout) {
        canvas.layoutInfo = layout
        accessibilityLabel = layout.spoken
        canvas.setNeedsDisplay()
    }
}
