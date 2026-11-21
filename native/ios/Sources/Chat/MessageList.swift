import CoreGraphics
import UIKit

// The list of one chat's messages. Rows come oldest first. The table is turned upside down (and every cell turned
// back), so index 0 is the newest message at the bottom: older pages are added at the far end and nothing on
// screen moves.

/// One row of a chat kind 0 = a bubble, 1 = a centred notice.
struct MsgRow: Equatable {
  let key: String
  let kind: Int
  let mine: Bool
  let text: String
  let time: String
  let ticks: Int
  let tail: Bool
  let quoteAuthor: String
  let quoteText: String
  let forward: String
  let label: String
  let thumb: String
  let thumbRound: Bool
  let thumbWide: CGFloat
  let checked: Int
  /// Reactions in one line («👍 2  ❤️ 1»); empty = none.
  let reactions: String
  /// Reactions as chips: triples [emoji, count, "1" if mine]. With them `reactions` is only read aloud.
  let chips: [String]
  /// Formatting of `text`: triples [flags, offset, length] in UTF-16 units (NATIVE_FMT in src/format/nativeSpans.ts).
  let fmt: [Int]
  /// One address per triple with the link flag (64), in order.
  let urls: [String]
  /// Voice/Video: "voice" (a row with a waveform), "video" or "note" (a round video); empty for any other row.
  let media: String
  /// Voice: the letters of the waveform (empty: none came with the message).
  let wave: String
  /// Voice/Video: the length («0:23»); empty when the message does not say.
  let mediaTime: String
  /// LinkPreview: the card of a link under the text (Sources/LinkPreview/LinkCard.swift); nil: none.
  var linkCard: MsgLinkCard? = nil

  static func parse(_ rows: [[String: Any]]) -> [MsgRow] {
    func text(_ value: Any?) -> String { (value as? String) ?? "" }
    func flag(_ value: Any?) -> Bool { (value as? Bool) ?? false }
    func int(_ value: Any?, _ fallback: Int) -> Int { (value as? NSNumber)?.intValue ?? fallback }
    var result: [MsgRow] = []
    for row in rows {
      let key = text(row["key"])
      if key.isEmpty { continue }
      let wide = (row["thumbWide"] as? NSNumber)?.doubleValue ?? 1
      result.append(MsgRow(
        key: key, kind: int(row["kind"], 0), mine: flag(row["mine"]), text: text(row["text"]), time: text(row["time"]),
        ticks: min(4, max(0, int(row["ticks"], 0))), tail: flag(row["tail"]), quoteAuthor: text(row["quoteAuthor"]),
        quoteText: text(row["quoteText"]), forward: text(row["forward"]), label: text(row["label"]), thumb: text(row["thumb"]),
        thumbRound: flag(row["thumbRound"]), thumbWide: CGFloat(min(2.5, max(0.4, wide))), checked: min(1, max(-1, int(row["checked"], -1))), reactions: text(row["reactions"]), chips: (row["chips"] as? [String]) ?? [],
        fmt: ((row["fmt"] as? [NSNumber]) ?? []).map { $0.intValue }, urls: (row["urls"] as? [String]) ?? [],
        media: text(row["media"]), wave: text(row["wave"]), mediaTime: text(row["mediaTime"]), linkCard: MsgLinkCard.parse(row["card"])))
    }
    return result
  }
}

private func msgColor(_ argb: Int) -> UIColor {
  let value = UInt32(truncatingIfNeeded: argb)
  return UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                 blue: CGFloat(value & 0xFF) / 255, alpha: CGFloat((value >> 24) & 0xFF) / 255)
}

struct MsgPalette: Equatable {
  var text = msgColor(0xFFF1F5FF)
  var muted = msgColor(0xFF8A97B4)
  var accent = msgColor(0xFFA9C4FF)
  var onAccent = msgColor(0xFF0A1430)
  var mine = msgColor(0xFF2B4A8C)
  var theirs = msgColor(0xFF16213A)
  var notice = msgColor(0x33000000)
  var noticeText = msgColor(0xFFDCE4F5)
  var danger = msgColor(0xFFFF8A8A)
  var quote = msgColor(0x1FFFFFFF)
  var mineMeta = msgColor(0xFFC6D2EE)
  var mineMark = msgColor(0xFFDCE8FF)
  var subtle = msgColor(0xFF6B7896)

  init() {}
  init(_ map: [String: Any]) {
    func color(_ key: String, _ fallback: UIColor) -> UIColor {
      if let number = map[key] as? NSNumber { return msgColor(number.intValue) }
      return fallback
    }
    text = color("text", text); muted = color("muted", muted); accent = color("accent", accent)
    onAccent = color("onAccent", onAccent); mine = color("mine", mine); theirs = color("theirs", theirs)
    notice = color("notice", notice); noticeText = color("noticeText", noticeText); danger = color("danger", danger)
    quote = color("quote", quote); mineMeta = color("mineMeta", mineMeta); mineMark = color("mineMark", mineMark)
    subtle = color("subtle", subtle)
  }
}

private let msgSmallFont = UIFont.systemFont(ofSize: 13)
private let msgSmallBold = UIFont.systemFont(ofSize: 12.5, weight: .semibold)
private let msgMetaFont = UIFont.systemFont(ofSize: 11)

private func msgWrap(_ lines: Bool) -> NSParagraphStyle {
  let style = NSMutableParagraphStyle()
  style.lineBreakMode = lines ? .byWordWrapping : .byTruncatingTail
  style.lineSpacing = 2
  return style
}

private func msgSize(_ text: String, _ font: UIFont, _ width: CGFloat, _ maxHeight: CGFloat) -> CGSize {
  if text.isEmpty { return .zero }
  let box = NSAttributedString(string: text, attributes: [.font: font, .paragraphStyle: msgWrap(true)])
    .boundingRect(with: CGSize(width: max(1, width), height: maxHeight), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
  return CGSize(width: ceil(box.width), height: ceil(min(box.height, maxHeight)))
}

private let msgChipEmoji = UIFont.systemFont(ofSize: 15)
private let msgChipCount = UIFont.systemFont(ofSize: 12, weight: .semibold)

struct MsgChip {
  let emoji: String
  let count: Int
  let mine: Bool
  let frame: CGRect
}

/// The reaction chips of a row, wrapped into `width`; frames start at (0, 0).
func msgChips(_ row: MsgRow, width: CGFloat) -> (chips: [MsgChip], size: CGSize) {
  var chips: [MsgChip] = []
  var x: CGFloat = 0
  var y: CGFloat = 0
  var widest: CGFloat = 0
  var i = 0
  while i + 2 < row.chips.count {
    let emoji = row.chips[i]
    let count = Int(row.chips[i + 1]) ?? 1
    let mine = row.chips[i + 2] == "1"
    i += 3
    var w = ceil(NSAttributedString(string: emoji, attributes: [.font: msgChipEmoji]).size().width) + 16
    if count > 1 { w += 4 + ceil(NSAttributedString(string: String(count), attributes: [.font: msgChipCount]).size().width) }
    if x > 0 && x + w > width {
      x = 0
      y += 29
    }
    chips.append(MsgChip(emoji: emoji, count: count, mine: mine, frame: CGRect(x: x, y: y, width: w, height: 24)))
    x += w + 5
    widest = max(widest, x - 5)
  }
  return (chips, chips.isEmpty ? .zero : CGSize(width: widest, height: y + 24))
}

private func msgAttrSize(_ text: NSAttributedString, _ width: CGFloat, _ maxHeight: CGFloat) -> CGSize {
  if text.length == 0 { return .zero }
  let box = text.boundingRect(with: CGSize(width: max(1, width), height: maxHeight), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
  return CGSize(width: ceil(box.width), height: ceil(min(box.height, maxHeight)))
}

/// A laid out text: its size, the place of a range, and the drawing — one layout for measuring, drawing and taps.
final class MsgText {
  private let storage: NSTextStorage
  private let manager = NSLayoutManager()
  private let container: NSTextContainer

  init(_ text: NSAttributedString, width: CGFloat) {
    storage = NSTextStorage(attributedString: text)
    container = NSTextContainer(size: CGSize(width: max(1, width), height: CGFloat.greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    manager.addTextContainer(container)
    storage.addLayoutManager(manager)
    manager.ensureLayout(for: container)
  }

  var size: CGSize {
    let used = manager.usedRect(for: container)
    return CGSize(width: ceil(used.maxX), height: ceil(used.height))
  }

  /// The part of the last line that holds text.
  var lastLine: CGRect {
    let glyphs = manager.numberOfGlyphs
    return glyphs > 0 ? manager.lineFragmentUsedRect(forGlyphAt: glyphs - 1, effectiveRange: nil) : .zero
  }

  func rect(_ range: NSRange) -> CGRect {
    manager.boundingRect(forGlyphRange: manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil), in: container)
  }

  /// The character under a point, or nil when the point is not on a glyph.
  func index(at point: CGPoint) -> Int? {
    let glyph = manager.glyphIndex(for: point, in: container)
    let box = manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
    return box.insetBy(dx: -4, dy: -4).contains(point) ? manager.characterIndexForGlyph(at: glyph) : nil
  }

  func draw(at origin: CGPoint) {
    let all = manager.glyphRange(for: container)
    manager.drawBackground(forGlyphRange: all, at: origin)
    manager.drawGlyphs(forGlyphRange: all, at: origin)
  }
}

/// A paragraph style of a quote or a code block: the text stands in from the block's edge.
private func msgBlockStyle(_ inset: CGFloat) -> NSParagraphStyle {
  let style = NSMutableParagraphStyle()
  style.lineBreakMode = .byWordWrapping
  style.lineSpacing = 2
  style.firstLineHeadIndent = inset
  style.headIndent = inset
  style.tailIndent = -8
  return style
}

/// The text of a bubble with its formatting. Flags: 1 bold, 2 italic, 4 underline, 8 strike, 16 monospace,
/// 32 spoiler (a block until tapped), 64 link, 128 quote, 256 code block.
func msgBody(_ row: MsgRow, fontSize: CGFloat, text: UIColor, link: UIColor, quote: UIColor, revealed: Bool) -> NSAttributedString {
  let base = UIFont.systemFont(ofSize: fontSize)
  let result = NSMutableAttributedString(string: row.text, attributes: [.font: base, .foregroundColor: text, .paragraphStyle: msgWrap(true)])
  let total = (row.text as NSString).length
  var i = 0
  while i + 2 < row.fmt.count {
    let flags = row.fmt[i], start = row.fmt[i + 1], length = row.fmt[i + 2]
    i += 3
    if start < 0 || length <= 0 || start + length > total { continue }
    let range = NSRange(location: start, length: length)
    let mono = flags & 16 != 0
    var font = mono ? UIFont.monospacedSystemFont(ofSize: max(10, fontSize - 1), weight: flags & 1 != 0 ? .bold : .regular) : base
    var traits = font.fontDescriptor.symbolicTraits
    if flags & 1 != 0 && !mono { traits.insert(.traitBold) }
    if flags & 2 != 0 { traits.insert(.traitItalic) }
    if traits != font.fontDescriptor.symbolicTraits, let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
      font = UIFont(descriptor: descriptor, size: font.pointSize)
    }
    result.addAttribute(.font, value: font, range: range)
    if flags & (4 | 64) != 0 { result.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range) }
    if flags & 8 != 0 { result.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range) }
    if mono && flags & 256 == 0 { result.addAttribute(.backgroundColor, value: text.withAlphaComponent(0.10), range: range) }
    // A quote and a code block are plates drawn under the text (MsgRowCanvas); here only their indents.
    if flags & 128 != 0 { result.addAttribute(.paragraphStyle, value: msgBlockStyle(11), range: range) }
    if flags & 256 != 0 { result.addAttribute(.paragraphStyle, value: msgBlockStyle(8), range: range) }
    if flags & 64 != 0 { result.addAttribute(.foregroundColor, value: link, range: range) }
    if flags & 32 != 0 {
      if revealed {
        result.addAttribute(.backgroundColor, value: text.withAlphaComponent(0.07), range: range)
      } else {
        result.addAttribute(.foregroundColor, value: UIColor.clear, range: range)
        result.addAttribute(.backgroundColor, value: text.withAlphaComponent(0.28), range: range)
      }
    }
  }
  return result
}

/// Where everything of one row goes, for the width it is shown at.
/// The open look: no bubbles. A message is its text on the page — own at the right edge, the other side's at
/// the left — and the time follows the last word on the same line.
let msgOpenLook = true
/// From the screen's edge to a message's plate (the text stands 13 further in).
private let msgEdge: CGFloat = msgOpenLook ? 3 : 9

struct MsgLayout {
  /// The time stands on the text's last line, at this point from the text's corner (x: its left, y: the line's bottom).
  var timeInline = false
  var timeAt = CGPoint.zero
  var bubble = CGSize.zero
  var textSize = CGSize.zero
  var quoteSize = CGSize.zero
  var labelSize = CGSize.zero
  var thumbSize = CGSize.zero
  var reactSize = CGSize.zero
  /// Voice: the play button with the waveform (Sources/Voice/MediaRowArt.swift).
  var voiceSize = CGSize.zero
  /// LinkPreview: the card of a link under the text (zero size: none).
  var card = MsgLinkCardLayout()
  var height: CGFloat = 0

  static func make(_ row: MsgRow, width: CGFloat, fontSize: CGFloat, hasThumb: Bool) -> MsgLayout {
    var layout = MsgLayout()
    if row.kind == 1 {
      let size = msgSize(row.text, msgSmallFont, width * 0.8, 120)
      layout.textSize = size
      layout.bubble = CGSize(width: size.width + 24, height: size.height + 12)
      layout.height = layout.bubble.height + 8
      return layout
    }
    let inner = width * 0.78 - 26
    let body = UIFont.systemFont(ofSize: fontSize)
    layout.textSize = row.fmt.isEmpty ? msgSize(row.text, body, inner, 20000)
      : MsgText(msgBody(row, fontSize: fontSize, text: .black, link: .black, quote: .clear, revealed: true), width: inner).size
    if !row.quoteText.isEmpty || !row.quoteAuthor.isEmpty { layout.quoteSize = msgSize(row.quoteText.isEmpty ? " " : row.quoteText, msgSmallFont, inner - 12, 36) }
    layout.labelSize = msgSize(row.label, msgSmallFont, inner, 36)
    layout.reactSize = row.chips.isEmpty ? msgSize(row.reactions, msgSmallFont, inner, 40) : msgChips(row, width: inner).size
    if hasThumb {
      let w = min(inner, 220)
      layout.thumbSize = CGSize(width: w, height: min(300, max(90, w / row.thumbWide)))
    }
    // Voice/Video: a round video is a circle, a video keeps its place even before its picture is known, a voice
    // message is a block of its own.
    if row.media == "note" {
      let side = min(inner, 212)
      layout.thumbSize = CGSize(width: side, height: side)
    } else if row.media == "video" && !hasThumb {
      let w = min(inner, 220)
      layout.thumbSize = CGSize(width: w, height: min(300, max(90, w / row.thumbWide)))
    } else if row.media == "voice" {
      layout.voiceSize = CGSize(width: min(inner, 236), height: 50)
    }
    let timeWidth = ceil(NSAttributedString(string: row.time, attributes: [.font: msgMetaFont]).size().width) + (row.mine ? 22 : 0)
    var w = max(max(layout.textSize.width, timeWidth, layout.thumbSize.width, layout.labelSize.width), max(layout.reactSize.width, layout.voiceSize.width))
    if layout.quoteSize != .zero {
      let author = ceil(NSAttributedString(string: row.quoteAuthor, attributes: [.font: msgSmallBold]).size().width)
      w = max(w, min(inner, max(layout.quoteSize.width, author) + 12))
    }
    if !row.forward.isEmpty { w = max(w, min(inner, ceil(NSAttributedString(string: row.forward, attributes: [.font: msgSmallBold]).size().width))) }
    // LinkPreview: the card stands under the text, and the time then goes under the card.
    if let card = row.linkCard {
      layout.card = MsgLinkCardLayout.make(card, width: inner)
      w = max(w, layout.card.size.width)
    }
    if msgOpenLook && layout.textSize != .zero && layout.reactSize == .zero && layout.card.size == .zero && !stride(from: 0, to: row.fmt.count, by: 3).contains(where: { row.fmt[$0] & (128 | 256) != 0 }) {
      let laid = MsgText(row.fmt.isEmpty ? NSAttributedString(string: row.text, attributes: [.font: body, .paragraphStyle: msgWrap(true)])
        : msgBody(row, fontSize: fontSize, text: .black, link: .black, quote: .clear, revealed: true), width: inner)
      let last = laid.lastLine
      // The time may stand out past the text's column, up to the page's own margin.
      if last != .zero && ceil(last.maxX) + 8 + timeWidth <= width - 2 * (msgEdge + 13) {
        layout.timeInline = true
        layout.timeAt = CGPoint(x: ceil(last.maxX) + 8, y: last.maxY)
        w = max(w, ceil(last.maxX) + 8 + timeWidth)
      }
    }
    var h: CGFloat = 9
    if !row.forward.isEmpty { h += 18 }
    if layout.quoteSize != .zero { h += 17 + layout.quoteSize.height + 8 }
    if layout.thumbSize != .zero { h += layout.thumbSize.height + 6 }
    if layout.voiceSize != .zero { h += layout.voiceSize.height + 4 }
    if layout.labelSize != .zero { h += layout.labelSize.height + 4 }
    h += layout.textSize.height
    if layout.card.size != .zero { h += layout.card.size.height + 7 }
    if layout.reactSize != .zero { h += layout.reactSize.height + 6 }
    h += layout.timeInline ? 6 : 16 + 6
    layout.bubble = CGSize(width: w + 26, height: h)
    layout.height = h + (row.tail ? 7 : 2)
    return layout
  }
}

final class MsgRowCanvas: UIView {
  var row: MsgRow?
  var palette = MsgPalette()
  var fontSize: CGFloat = 17
  var layoutInfo = MsgLayout()
  var thumbImage: UIImage?
  var pressed = false
  /// The spoilers of this message have been tapped open.
  var revealed = false
  /// Where the body text was drawn last (for taps on links and spoilers).
  private var bodyBox = CGRect.zero
  /// The reaction chips as drawn last.
  private var chipBoxes: [(frame: CGRect, emoji: String)] = []
  /// ChatActions: the row is lit for a moment (the message a quote or the pinned bar jumped to).
  var flash = false
  /// ChatActions: where the quote of an answer was drawn last (a tap on it jumps to the original).
  private var quoteBox = CGRect.zero
  /// Voice/Video: what is playing in this row right now (nil: nothing), and where its parts were drawn last.
  var mediaState: MsgMediaState?
  private(set) var mediaBoxes = MsgMediaBoxes()
  /// LinkPreview: the decoded picture of the row's card, and where the card was drawn last.
  var cardImage: UIImage?
  private var cardBox = CGRect.zero

  /// LinkPreview: the address of the card under a point of this view.
  func card(at point: CGPoint) -> String? {
    guard cardBox != .zero, cardBox.contains(point) else { return nil }
    return row?.linkCard?.url
  }

  /// Voice/Video: the part of a voice message, a video or a round video under a point of this view.
  func media(at point: CGPoint) -> (part: String, fraction: CGFloat)? {
    mediaBoxes.part(at: point)
  }

  /// ChatActions: whether a point of this view is on the quote of an answer.
  func quote(at point: CGPoint) -> Bool {
    quoteBox != .zero && quoteBox.insetBy(dx: -2, dy: -3).contains(point)
  }

  /// The reaction chip under a point of this view.
  func chip(at point: CGPoint) -> String? {
    chipBoxes.first { $0.frame.insetBy(dx: -3, dy: -4).contains(point) }?.emoji
  }

  /// A link or a still hidden spoiler under a point of this view.
  func run(at point: CGPoint) -> (flags: Int, url: String, shown: String)? {
    guard let item = row, !item.fmt.isEmpty, bodyBox.contains(point) else { return nil }
    let laid = MsgText(msgBody(item, fontSize: fontSize, text: .black, link: .black, quote: .clear, revealed: true), width: bodyBox.width)
    guard let index = laid.index(at: CGPoint(x: point.x - bodyBox.minX, y: point.y - bodyBox.minY)) else { return nil }
    let total = (item.text as NSString).length
    var link = 0
    var i = 0
    while i + 2 < item.fmt.count {
      let flags = item.fmt[i], start = item.fmt[i + 1], length = item.fmt[i + 2]
      i += 3
      let isLink = flags & 64 != 0
      if index >= start && index < start + length && start >= 0 && length > 0 && start + length <= total {
        let hidden = flags & 32 != 0 && !revealed
        let url = isLink && link < item.urls.count ? item.urls[link] : ""
        if hidden || !url.isEmpty {
          return (flags, hidden ? "" : url, (item.text as NSString).substring(with: NSRange(location: start, length: length)))
        }
      }
      if isLink { link += 1 }
    }
    return nil
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
  }
  required init?(coder: NSCoder) { return nil }

  private func draw(_ text: String, _ font: UIFont, _ color: UIColor, _ box: CGRect, lines: Bool) {
    NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: msgWrap(lines)])
      .draw(with: box, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
  }

  override func draw(_ rect: CGRect) {
    guard let item = row, let context = UIGraphicsGetCurrentContext() else { return }
    let w = bounds.width
    let bubble = layoutInfo.bubble
    quoteBox = .zero
    cardBox = .zero
    if item.kind == 1 {
      let box = CGRect(x: (w - bubble.width) / 2, y: 0, width: bubble.width, height: bubble.height)
      context.setFillColor(palette.notice.cgColor)
      context.addPath(UIBezierPath(roundedRect: box, cornerRadius: 14).cgPath)
      context.fillPath()
      let style = NSMutableParagraphStyle()
      style.alignment = .center
      style.lineSpacing = 2
      NSAttributedString(string: item.text, attributes: [.font: msgSmallFont, .foregroundColor: palette.noticeText, .paragraphStyle: style])
        .draw(with: box.insetBy(dx: 12, dy: 6), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
      return
    }
    var side: CGFloat = msgEdge
    if item.checked >= 0 {
      let center = CGPoint(x: 21, y: bubble.height / 2)
      if item.checked == 1 {
        context.setFillColor(palette.accent.cgColor)
        context.fillEllipse(in: CGRect(x: center.x - 11, y: center.y - 11, width: 22, height: 22))
        context.setStrokeColor(palette.onAccent.cgColor)
        context.setLineWidth(2)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        context.move(to: CGPoint(x: center.x - 5, y: center.y))
        context.addLine(to: CGPoint(x: center.x - 1.5, y: center.y + 3.5))
        context.addLine(to: CGPoint(x: center.x + 5, y: center.y - 3.5))
        context.strokePath()
      } else {
        context.setStrokeColor(palette.subtle.cgColor)
        context.setLineWidth(1.6)
        context.strokeEllipse(in: CGRect(x: center.x - 10.5, y: center.y - 10.5, width: 21, height: 21))
      }
      if !item.mine { side += 34 }
    }
    let left = item.mine ? w - msgEdge - bubble.width : side
    let box = CGRect(x: left, y: 0, width: bubble.width, height: bubble.height)
    // The corner by the sender's edge is tight on the last bubble of a run (the «tail»).
    var corners: UIRectCorner = [.topLeft, .topRight, .bottomLeft, .bottomRight]
    if item.tail { corners.remove(item.mine ? .bottomRight : .bottomLeft) }
    let shape = UIBezierPath(roundedRect: box, byRoundingCorners: corners, cornerRadii: CGSize(width: 20, height: 20))
    if !msgOpenLook {
      context.setFillColor((item.mine ? palette.mine : palette.theirs).cgColor)
      context.addPath(shape.cgPath)
      context.fillPath()
    }
    if pressed {
      context.setFillColor(UIColor(white: 1, alpha: 0.08).cgColor)
      context.addPath(shape.cgPath)
      context.fillPath()
    }
    if flash {
      context.setFillColor(UIColor(white: 1, alpha: 0.14).cgColor)
      context.addPath(shape.cgPath)
      context.fillPath()
    }

    let x = left + 13
    var y: CGFloat = 9
    let inner = bubble.width - 26
    let metaColor = item.mine ? palette.mineMeta : palette.muted
    let markColor = item.mine ? palette.mineMark : palette.accent
    if !item.forward.isEmpty {
      draw(item.forward, msgSmallBold, markColor, CGRect(x: x, y: y, width: inner, height: 17), lines: false)
      y += 18
    }
    if layoutInfo.quoteSize != .zero {
      let height = 17 + layoutInfo.quoteSize.height + 2
      quoteBox = CGRect(x: x, y: y, width: inner, height: height)
      context.setFillColor(palette.quote.cgColor)
      context.addPath(UIBezierPath(roundedRect: CGRect(x: x, y: y, width: inner, height: height), cornerRadius: 6).cgPath)
      context.fillPath()
      context.setFillColor(markColor.cgColor)
      context.addPath(UIBezierPath(roundedRect: CGRect(x: x, y: y, width: 3, height: height), cornerRadius: 1.5).cgPath)
      context.fillPath()
      draw(item.quoteAuthor, msgSmallBold, markColor, CGRect(x: x + 9, y: y + 2, width: inner - 12, height: 16), lines: false)
      draw(item.quoteText, msgSmallFont, metaColor, CGRect(x: x + 9, y: y + 17, width: inner - 12, height: layoutInfo.quoteSize.height), lines: true)
      y += 17 + layoutInfo.quoteSize.height + 8
    }
    // Voice/Video: where the picture of a video or a round video stands; without a picture, a quiet plate.
    mediaBoxes = MsgMediaBoxes()
    let mediaPicture = CGRect(x: x, y: y, width: layoutInfo.thumbSize.width, height: layoutInfo.thumbSize.height)
    if layoutInfo.thumbSize != .zero && (item.media == "video" || item.media == "note") {
      mediaBoxes.thumb = mediaPicture
      if thumbImage == nil {
        MediaRowArt.plate(context, round: item.media == "note", palette: palette, box: mediaPicture)
        y += mediaPicture.height + 6
      }
    }
    if let image = thumbImage, layoutInfo.thumbSize != .zero, image.size.width > 0, image.size.height > 0 {
      let picture = CGRect(x: x, y: y, width: layoutInfo.thumbSize.width, height: layoutInfo.thumbSize.height)
      context.saveGState()
      UIBezierPath(roundedRect: picture, cornerRadius: item.thumbRound ? min(picture.width, picture.height) / 2 : 12).addClip()
      let scale = max(picture.width / image.size.width, picture.height / image.size.height)
      let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
      image.draw(in: CGRect(x: picture.midX - size.width / 2, y: picture.midY - size.height / 2, width: size.width, height: size.height))
      context.restoreGState()
      y += picture.height + 6
    }
    // Voice/Video: the play mark and the length over the picture; the waveform row of a voice message.
    if mediaBoxes.thumb != .zero { MediaRowArt.marks(context, row: item, state: mediaState, palette: palette, box: mediaBoxes.thumb) }
    if layoutInfo.voiceSize != .zero {
      mediaBoxes = MediaRowArt.voice(context, row: item, state: mediaState, palette: palette, box: CGRect(x: x, y: y, width: layoutInfo.voiceSize.width, height: layoutInfo.voiceSize.height))
      y += layoutInfo.voiceSize.height + 4
    }
    if layoutInfo.labelSize != .zero {
      draw(item.label, msgSmallFont, markColor, CGRect(x: x, y: y, width: inner, height: layoutInfo.labelSize.height), lines: true)
      y += layoutInfo.labelSize.height + 4
    }
    bodyBox = .zero
    if layoutInfo.textSize != .zero {
      bodyBox = CGRect(x: x, y: y, width: inner, height: layoutInfo.textSize.height + 2)
      if item.fmt.isEmpty {
        draw(item.text, UIFont.systemFont(ofSize: fontSize), palette.text, bodyBox, lines: true)
      } else {
        let laid = MsgText(msgBody(item, fontSize: fontSize, text: palette.text, link: markColor, quote: palette.quote, revealed: revealed), width: inner)
        // The plates of quotes (with the accent bar, as in the React list) and of code blocks, under the text.
        let total = (item.text as NSString).length
        var i = 0
        while i + 2 < item.fmt.count {
          let flags = item.fmt[i], start = item.fmt[i + 1], length = item.fmt[i + 2]
          i += 3
          if flags & (128 | 256) == 0 || start < 0 || length <= 0 || start + length > total { continue }
          let lines = laid.rect(NSRange(location: start, length: length))
          let plate = CGRect(x: x, y: y + lines.minY - 2, width: inner, height: lines.height + 4)
          context.setFillColor((flags & 128 != 0 ? palette.quote : palette.text.withAlphaComponent(0.10)).cgColor)
          context.addPath(UIBezierPath(roundedRect: plate, cornerRadius: 7).cgPath)
          context.fillPath()
          if flags & 128 != 0 {
            context.setFillColor(markColor.cgColor)
            context.addPath(UIBezierPath(roundedRect: CGRect(x: plate.minX, y: plate.minY, width: 3, height: plate.height), cornerRadius: 1.5).cgPath)
            context.fillPath()
          }
        }
        laid.draw(at: CGPoint(x: x, y: y))
      }
      y += layoutInfo.textSize.height
    }
    // LinkPreview: the card of the link, under the text.
    if layoutInfo.card.size != .zero, let card = item.linkCard {
      cardBox = CGRect(x: x, y: y + 7, width: layoutInfo.card.size.width, height: layoutInfo.card.size.height)
      layoutInfo.card.draw(card, in: context, at: cardBox.origin, palette: palette, accent: markColor, picture: cardImage, pressed: false)
      y += layoutInfo.card.size.height + 7
    }
    chipBoxes = []
    if layoutInfo.reactSize != .zero && !item.chips.isEmpty {
      for chip in msgChips(item, width: inner).chips {
        let frame = chip.frame.offsetBy(dx: x, dy: y + 6)
        chipBoxes.append((frame, chip.emoji))
        context.setFillColor((chip.mine ? palette.accent : palette.text.withAlphaComponent(0.10)).cgColor)
        context.addPath(UIBezierPath(roundedRect: frame, cornerRadius: 12).cgPath)
        context.fillPath()
        let emoji = NSAttributedString(string: chip.emoji, attributes: [.font: msgChipEmoji])
        let emojiSize = emoji.size()
        emoji.draw(at: CGPoint(x: frame.minX + 8, y: frame.midY - emojiSize.height / 2))
        if chip.count > 1 {
          let count = NSAttributedString(string: String(chip.count), attributes: [.font: msgChipCount, .foregroundColor: chip.mine ? palette.onAccent : palette.text])
          count.draw(at: CGPoint(x: frame.minX + 8 + ceil(emojiSize.width) + 4, y: frame.midY - count.size().height / 2))
        }
      }
    } else if layoutInfo.reactSize != .zero {
      draw(item.reactions, msgSmallFont, palette.text, CGRect(x: x, y: y + 6, width: inner, height: layoutInfo.reactSize.height + 2), lines: true)
    }

    let marks: CGFloat = item.mine ? 20 : 0
    let time = NSAttributedString(string: item.time, attributes: [.font: msgMetaFont, .foregroundColor: item.ticks == 4 ? palette.danger : metaColor])
    let timeSize = time.size()
    // After the last word of the text, or in the plate's lower corner.
    let inline = layoutInfo.timeInline && bodyBox != .zero
    // Without a plate, a time on its own line stands under the start of the other side's text.
    let under = msgOpenLook && !item.mine ? x + ceil(timeSize.width) + marks : left + bubble.width - 13
    let right = inline ? bodyBox.minX + layoutInfo.timeAt.x + ceil(timeSize.width) + marks : under
    let timeBottom = inline ? bodyBox.minY + layoutInfo.timeAt.y - 2 : bubble.height - 6
    time.draw(at: CGPoint(x: right - marks - ceil(timeSize.width), y: timeBottom - timeSize.height))
    let my = timeBottom - 6
    if item.mine && (item.ticks == 1 || item.ticks == 2) {
      context.setStrokeColor((item.ticks == 2 ? markColor : metaColor).cgColor)
      context.setLineWidth(1.5)
      context.setLineCap(.round)
      context.setLineJoin(.round)
      let bx = right - 15
      context.move(to: CGPoint(x: bx, y: my))
      context.addLine(to: CGPoint(x: bx + 3.5, y: my + 3.5))
      context.addLine(to: CGPoint(x: bx + 10, y: my - 4))
      if item.ticks == 2 {
        context.move(to: CGPoint(x: bx + 5, y: my + 1.5))
        context.addLine(to: CGPoint(x: bx + 7, y: my + 3.5))
        context.addLine(to: CGPoint(x: bx + 13.5, y: my - 4))
      }
      context.strokePath()
    } else if item.mine && item.ticks >= 3 {
      context.setStrokeColor((item.ticks == 4 ? palette.danger : metaColor).cgColor)
      context.setLineWidth(1.4)
      let center = CGPoint(x: right - 7, y: my)
      context.strokeEllipse(in: CGRect(x: center.x - 5, y: center.y - 5, width: 10, height: 10))
      context.move(to: CGPoint(x: center.x, y: center.y - 2.5))
      context.addLine(to: CGPoint(x: center.x, y: center.y + (item.ticks == 3 ? 0 : 0.5)))
      if item.ticks == 3 { context.addLine(to: CGPoint(x: center.x + 2, y: center.y + 1)) }
      context.strokePath()
    }
  }
}

final class MsgRowCell: UITableViewCell {
  let canvas = MsgRowCanvas(frame: .zero)
  private var thumbOf = ""
  /// LinkPreview: the picture of the card this cell decoded last.
  private var cardOf = ""

  override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
    super.init(style: style, reuseIdentifier: reuseIdentifier)
    backgroundColor = .clear
    contentView.backgroundColor = .clear
    selectionStyle = .none
    // The table is upside down; the cell turns its content back.
    contentView.transform = CGAffineTransform(scaleX: 1, y: -1)
    canvas.frame = contentView.bounds
    canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    contentView.addSubview(canvas)
  }
  required init?(coder: NSCoder) { return nil }

  func show(_ row: MsgRow, _ palette: MsgPalette, _ fontSize: CGFloat, _ layout: MsgLayout, _ revealed: Bool) {
    // Voice/Video: a round video playing in place belongs to one row; a cell given to another row lets it go.
    if canvas.row?.key != row.key { canvas.subviews.forEach { $0.removeFromSuperview() } }
    canvas.row = row
    canvas.revealed = revealed
    canvas.palette = palette
    canvas.fontSize = fontSize
    canvas.layoutInfo = layout
    if row.thumb != thumbOf {
      thumbOf = row.thumb
      canvas.thumbImage = row.thumb.isEmpty ? nil : Data(base64Encoded: row.thumb, options: .ignoreUnknownCharacters).flatMap { UIImage(data: $0) }
    }
    // LinkPreview: the card's picture is decoded once per cell, not on every drawing.
    let cardPicture = row.linkCard?.image ?? ""
    if cardPicture != cardOf {
      cardOf = cardPicture
      canvas.cardImage = row.linkCard?.picture()
    }
    accessibilityLabel = [MediaRowArt.spoken(row), row.label, row.text, row.linkCard?.spoken ?? "", row.time].filter { !$0.isEmpty }.joined(separator: ". ")
    canvas.setNeedsDisplay()
  }

  override func setHighlighted(_ highlighted: Bool, animated: Bool) {
    super.setHighlighted(highlighted, animated: animated)
    if canvas.pressed != highlighted {
      canvas.pressed = highlighted
      canvas.setNeedsDisplay()
    }
  }
}

final class MsgListView: UIView, UITableViewDataSource, UITableViewDelegate, UIGestureRecognizerDelegate {
  var onLinkPress: ([String: Any]) -> Void = { _ in }
  var onReactPress: ([String: Any]) -> Void = { _ in }
  /// Messages whose spoilers were tapped open (until the chat is left).
  private var revealed = Set<String>()
  private lazy var linkTap = UITapGestureRecognizer(target: self, action: #selector(linkTapped(_:)))
  var onMsgPress: ([String: Any]) -> Void = { _ in }
  var onMsgLongPress: ([String: Any]) -> Void = { _ in }
  var onNearTop: ([String: Any]) -> Void = { _ in }
  /// ChatActions: a tap on the quote of an answer (`key`: the row of the answer).
  var onQuotePress: ([String: Any]) -> Void = { _ in }
  /// ChatActions: the list moved; `fromNewest` is how far it stands from its newest message, in points.
  var onScrolled: ([String: Any]) -> Void = { _ in }
  /// ChatActions: the row lit after a jump to it.
  private var flashKey = ""
  /// Voice/Video: a tap on a part of a voice message, a video or a round video (`key`, `part`: "play", "wave",
  /// "rate" or "thumb"; `fraction`: where on the waveform, 0…1).
  var onMediaPress: ([String: Any]) -> Void = { _ in }
  /// LinkPreview: a tap on the card of a link (`key`: the row, `url`: where the card leads).
  var onCardPress: ([String: Any]) -> Void = { _ in }
  /// Voice/Video: what is playing, by the key of its row (one at a time).
  private var mediaState: MsgMediaState?

  private let table = UITableView(frame: .zero, style: .plain)
  /// Newest first (index 0 is at the bottom of the screen).
  private var rows: [MsgRow] = []
  private var palette = MsgPalette()
  private var fontSize: CGFloat = 17
  private var layouts: [String: (row: MsgRow, width: CGFloat, font: CGFloat, layout: MsgLayout)] = [:]
  private var askedAt = ""
  /// The user is at the newest message (changed only by their own scrolling).
  private var pinned = true
  /// What `pad` asked for.
  private var padInsets = UIEdgeInsets.zero

  required init?(coder: NSCoder) { return nil }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    table.backgroundColor = .clear
    table.separatorStyle = .none
    table.showsVerticalScrollIndicator = false
    table.contentInsetAdjustmentBehavior = .never
    table.keyboardDismissMode = .interactive
    table.estimatedRowHeight = 0
    table.transform = CGAffineTransform(scaleX: 1, y: -1)
    table.register(MsgRowCell.self, forCellReuseIdentifier: "msg")
    table.dataSource = self
    table.delegate = self
    if #available(iOS 15.0, *) { table.sectionHeaderTopPadding = 0 }
    table.bounds = CGRect(origin: .zero, size: bounds.size)
    table.center = CGPoint(x: bounds.midX, y: bounds.midY)
    addSubview(table)
    let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
    hold.minimumPressDuration = 0.4
    table.addGestureRecognizer(hold)
    // A tap on a link or on a hidden spoiler is taken before the row gets it; any other tap goes to the row.
    linkTap.delegate = self
    table.addGestureRecognizer(linkTap)
  }

  private func run(atTablePoint point: CGPoint) -> (path: IndexPath, key: String, hit: (flags: Int, url: String, shown: String))? {
    guard let path = table.indexPathForRow(at: point), path.row < rows.count, let cell = table.cellForRow(at: path) as? MsgRowCell,
          let hit = cell.canvas.run(at: table.convert(point, to: cell.canvas)) else { return nil }
    return (path, rows[path.row].key, hit)
  }

  private func chip(atTablePoint point: CGPoint) -> (key: String, emoji: String)? {
    guard let path = table.indexPathForRow(at: point), path.row < rows.count, let cell = table.cellForRow(at: path) as? MsgRowCell,
          let emoji = cell.canvas.chip(at: table.convert(point, to: cell.canvas)) else { return nil }
    return (rows[path.row].key, emoji)
  }

  /// ChatActions: the row whose quote is under a point of the table.
  private func quote(atTablePoint point: CGPoint) -> String? {
    guard let path = table.indexPathForRow(at: point), path.row < rows.count, let cell = table.cellForRow(at: path) as? MsgRowCell,
          cell.canvas.quote(at: table.convert(point, to: cell.canvas)) else { return nil }
    return rows[path.row].key
  }

  /// Voice/Video: the part of a media row under a point of the table.
  private func media(atTablePoint point: CGPoint) -> (key: String, part: String, fraction: CGFloat)? {
    guard let path = table.indexPathForRow(at: point), path.row < rows.count, rows[path.row].checked < 0, let cell = table.cellForRow(at: path) as? MsgRowCell,
          let hit = cell.canvas.media(at: table.convert(point, to: cell.canvas)) else { return nil }
    return (rows[path.row].key, hit.part, hit.fraction)
  }

  /// LinkPreview: the card of a link under a point of the table (not while messages are being chosen).
  private func card(atTablePoint point: CGPoint) -> (key: String, url: String)? {
    guard let path = table.indexPathForRow(at: point), path.row < rows.count, rows[path.row].checked < 0, let cell = table.cellForRow(at: path) as? MsgRowCell,
          let url = cell.canvas.card(at: table.convert(point, to: cell.canvas)) else { return nil }
    return (rows[path.row].key, url)
  }

  /// Voice/Video: shows what is playing in its row (nil: nothing plays). Only that row is drawn again.
  func setMediaState(_ next: MsgMediaState?) {
    if next == mediaState { return }
    let keys = [mediaState?.key, next?.key]
    mediaState = next
    for cell in table.visibleCells {
      guard let rowCell = cell as? MsgRowCell, let key = rowCell.canvas.row?.key, keys.contains(key) else { continue }
      rowCell.canvas.mediaState = next?.key == key ? next : nil
      rowCell.canvas.setNeedsDisplay()
    }
  }

  /// Voice/Video: the view and the place of a row's picture while the row is on screen (a round video plays there).
  func mediaHost(_ key: String) -> (view: UIView, frame: CGRect)? {
    for cell in table.visibleCells {
      guard let rowCell = cell as? MsgRowCell, rowCell.canvas.row?.key == key, rowCell.canvas.mediaBoxes.thumb != .zero else { continue }
      return (rowCell.canvas, rowCell.canvas.mediaBoxes.thumb)
    }
    return nil
  }

  /// Voice/Video: the rows on screen, by key.
  func visibleKeys() -> [String] {
    table.visibleCells.compactMap { ($0 as? MsgRowCell)?.canvas.row?.key }
  }

  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    if gestureRecognizer === linkTap {
      let point = gestureRecognizer.location(in: table)
      return chip(atTablePoint: point) != nil || run(atTablePoint: point) != nil || quote(atTablePoint: point) != nil || media(atTablePoint: point) != nil
        || card(atTablePoint: point) != nil
    }
    return super.gestureRecognizerShouldBegin(gestureRecognizer)
  }

  @objc private func linkTapped(_ recognizer: UITapGestureRecognizer) {
    if recognizer.state != .ended { return }
    if let chip = chip(atTablePoint: recognizer.location(in: table)) {
      onReactPress(["key": chip.key, "emoji": chip.emoji])
      return
    }
    guard let found = run(atTablePoint: recognizer.location(in: table)) else {
      if let key = quote(atTablePoint: recognizer.location(in: table)) { onQuotePress(["key": key]); return }
      // Voice/Video: the play button, the waveform, the speed, the picture of a video.
      if let hit = media(atTablePoint: recognizer.location(in: table)) { onMediaPress(["key": hit.key, "part": hit.part, "fraction": Double(hit.fraction)]); return }
      // LinkPreview: the card of a link opens the link.
      if let hit = card(atTablePoint: recognizer.location(in: table)) { onCardPress(["key": hit.key, "url": hit.url]) }
      return
    }
    if found.hit.url.isEmpty {
      // Telegram: one tap shows every spoiler of the message.
      revealed.insert(found.key)
      if let cell = table.cellForRow(at: found.path) as? MsgRowCell {
        cell.canvas.revealed = true
        cell.canvas.setNeedsDisplay()
      }
      return
    }
    onLinkPress(["key": found.key, "url": found.hit.url, "shown": found.hit.shown])
  }

  private func applyInsets() {
    let insets = padInsets
    if table.contentInset == insets { return }
    let atBottom = pinned
    table.contentInset = insets
    if atBottom { table.contentOffset = CGPoint(x: 0, y: -insets.top) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // The screen shrinks from below when the keyboard comes (KeyboardSafeView). The table is upside down and
    // `frame` of a transformed view is undefined, so size and centre are set instead; the scroll position is
    // kept, and a list the user left at its newest message is put back there.
    let middle = CGPoint(x: bounds.midX, y: bounds.midY)
    if table.bounds.size != bounds.size || table.center != middle {
      let widthChanged = table.bounds.width != bounds.width
      let atBottom = pinned
      let offset = table.contentOffset
      table.bounds = CGRect(origin: offset, size: bounds.size)
      table.center = middle
      if widthChanged { layouts.removeAll(); table.reloadData() }
      if atBottom { table.contentOffset = CGPoint(x: 0, y: -table.contentInset.top) }
    }
  }

  private func layout(_ row: MsgRow) -> MsgLayout {
    let width = max(1, bounds.width)
    if let hit = layouts[row.key], hit.row == row, hit.width == width, hit.font == fontSize { return hit.layout }
    let made = MsgLayout.make(row, width: width, fontSize: fontSize, hasThumb: !row.thumb.isEmpty)
    layouts[row.key] = (row, width, fontSize, made)
    return made
  }

  func setRows(_ oldestFirst: [MsgRow]) {
    let next = Array(oldestFirst.reversed())
    if next == rows { return }
    let sameOrder = next.count == rows.count && zip(next, rows).allSatisfy { $0.key == $1.key }
    let sameHeights = sameOrder && zip(next, rows).allSatisfy { $0 == $1 || layout($0).height == layout($1).height }
    // Telegram: a message of your own takes the list to its end, wherever it was scrolled to.
    let ownNew = !rows.isEmpty && (next.first.map { $0.mine && $0.key != rows.first?.key } ?? false)
    rows = next
    if layouts.count > rows.count * 2 + 200 { layouts.removeAll() }
    if sameHeights {
      for cell in table.visibleCells {
        guard let rowCell = cell as? MsgRowCell, let path = table.indexPath(for: cell), path.row < rows.count else { continue }
        rowCell.canvas.flash = !flashKey.isEmpty && rows[path.row].key == flashKey
        rowCell.canvas.mediaState = mediaState?.key == rows[path.row].key ? mediaState : nil
        rowCell.show(rows[path.row], palette, fontSize, layout(rows[path.row]), revealed.contains(rows[path.row].key))
      }
    } else {
      table.reloadData()
    }
    if ownNew {
      pinned = true
      table.layoutIfNeeded()
      table.setContentOffset(CGPoint(x: 0, y: -table.contentInset.top), animated: true)
    }
  }

  func setPalette(_ next: MsgPalette) {
    if next == palette { return }
    palette = next
    table.reloadData()
  }

  func setFontSize(_ size: CGFloat) {
    let next = min(40, max(10, size))
    if next == fontSize { return }
    fontSize = next
    layouts.removeAll()
    table.reloadData()
  }

  /// `top` is the room under the header, `bottom` the room above the composer. The table is upside down, so they swap.
  func setPad(top: Double, bottom: Double) {
    padInsets = UIEdgeInsets(top: CGFloat(bottom), left: 0, bottom: CGFloat(top), right: 0)
    applyInsets()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    if scrollView.isDragging || scrollView.isDecelerating { pinned = scrollView.contentOffset.y <= -scrollView.contentInset.top + 24 }
    onScrolled(["fromNewest": Double(scrollView.contentOffset.y + scrollView.contentInset.top)])
  }

  // MARK: ChatActions — going to a message

  /// Takes the list to its newest message.
  func scrollToNewest(animated: Bool) {
    pinned = true
    table.setContentOffset(CGPoint(x: 0, y: -table.contentInset.top), animated: animated)
  }

  /// Scrolls to the row with this key and lights it for a moment. False when there is no such row.
  func jump(to key: String) -> Bool {
    guard let index = rows.firstIndex(where: { $0.key == key }) else { return false }
    pinned = index == 0
    table.scrollToRow(at: IndexPath(row: index, section: 0), at: .middle, animated: true)
    flashKey = key
    showFlash()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
      guard let self, self.flashKey == key else { return }
      self.flashKey = ""
      self.showFlash()
    }
    return true
  }

  private func showFlash() {
    for cell in table.visibleCells {
      guard let rowCell = cell as? MsgRowCell, let path = table.indexPath(for: cell), path.row < rows.count else { continue }
      let lit = !flashKey.isEmpty && rows[path.row].key == flashKey
      if rowCell.canvas.flash != lit {
        rowCell.canvas.flash = lit
        rowCell.canvas.setNeedsDisplay()
      }
    }
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

  func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
    indexPath.row < rows.count ? layout(rows[indexPath.row]).height : 0
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "msg", for: indexPath)
    if let rowCell = cell as? MsgRowCell, indexPath.row < rows.count {
      rowCell.canvas.flash = !flashKey.isEmpty && rows[indexPath.row].key == flashKey
      rowCell.canvas.mediaState = mediaState?.key == rows[indexPath.row].key ? mediaState : nil
      rowCell.show(rows[indexPath.row], palette, fontSize, layout(rows[indexPath.row]), revealed.contains(rows[indexPath.row].key))
    }
    return cell
  }

  func tableView(_ tableView: UITableView, willDisplay cell: UITableViewCell, forRowAt indexPath: IndexPath) {
    // Once per «oldest row»: asked again only after older rows have arrived.
    guard let oldest = rows.last, indexPath.row >= rows.count - 5, askedAt != oldest.key else { return }
    askedAt = oldest.key
    onNearTop(["key": oldest.key])
  }

  func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
    indexPath.row < rows.count && rows[indexPath.row].kind == 0
  }

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: false)
    if indexPath.row < rows.count {
      // ChatActions: `y` is the middle of the row on the screen (the menu opens next to it).
      let box = tableView.convert(tableView.rectForRow(at: indexPath), to: nil)
      onMsgPress(["key": rows[indexPath.row].key, "y": Double(box.midY)])
    }
  }

  @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
    if recognizer.state != .began { return }
    guard let path = table.indexPathForRow(at: recognizer.location(in: table)), path.row < rows.count, rows[path.row].kind == 0 else { return }
    onMsgLongPress(["key": rows[path.row].key, "y": Double(recognizer.location(in: nil).y)])
  }
}
