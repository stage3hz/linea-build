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
  /// Polls: the poll the message is (Sources/Polls/PollRow.swift); nil: none.
  var poll: MsgPoll? = nil
  /// Attachments: the photos of an album (Sources/Attachments/AlbumGrid.swift); nil: none.
  var album: MsgAlbum? = nil
  /// Composer: 1–3 emoji alone, drawn large (Sources/Composer/BigEmoji.swift); 0: ordinary text.
  var bigEmoji = 0
  /// Composer: an own message sent «без звука» (a crossed bell before the time).
  var silent = false
  /// The quoted message's small picture (base64), round for a round video (MessageRow.tsx replyThumb); empty: none.
  var quoteThumb = ""
  var quoteRound = false

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
      // Polls, Attachments, Composer: what those parts add to a row.
      result[result.count - 1].poll = MsgPoll.parse(row["poll"])
      result[result.count - 1].album = MsgAlbum.parse(row["album"])
      result[result.count - 1].bigEmoji = min(3, max(0, int(row["bigEmoji"], 0)))
      result[result.count - 1].silent = flag(row["silent"])
      result[result.count - 1].quoteThumb = text(row["quoteThumb"])
      result[result.count - 1].quoteRound = flag(row["quoteRound"])
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
/// MessageRow.tsx: «Переслано от …» 11 semibold in the accent, 4 above what follows.
private let msgForwardFont = UIFont.systemFont(ofSize: 11, weight: .semibold)
/// MessageRow.tsx quote: the author 11 bold, the words 12 (two lines at most), 1 between, padding 5 above and below,
/// 3-point bar, 7 from the bar to the words, 8 at the right, radius 10, 6 below the block.
private let msgQuoteAuthorFont = UIFont.systemFont(ofSize: 11, weight: .bold)
private let msgQuoteFont = UIFont.systemFont(ofSize: 12)
private func msgQuoteStyle() -> NSParagraphStyle {
  let style = NSMutableParagraphStyle()
  style.lineBreakMode = .byWordWrapping
  return style
}
private func msgQuoteHeight(_ textHeight: CGFloat, thumb: Bool = false) -> CGFloat {
  5 + max(ceil(msgQuoteAuthorFont.lineHeight) + 1 + textHeight, thumb ? 32 : 0) + 5
}
/// MessageRow.tsx: under an own message that was refused, «Не отправлено · повторить» (11 semibold, danger) with
/// 8 above and below.
private let msgFailedFont = UIFont.systemFont(ofSize: 11, weight: .semibold)
private func msgFailedRoom(_ row: MsgRow) -> CGFloat { row.mine && row.ticks == 4 ? 8 + ceil(msgFailedFont.lineHeight) + 8 : 0 }

/// The words of a quote stand this far in: the bar 3 + 7, and with the picture 32 + 7 more (MessageRow.tsx).
private func msgQuoteIndent(_ row: MsgRow) -> CGFloat { row.quoteThumb.isEmpty ? 10 : 10 + 32 + 7 }
private let msgMetaFont = UIFont.systemFont(ofSize: 11)
/// MessageRow.tsx DayChip and CallServiceRow.
private let msgDayFont = UIFont.systemFont(ofSize: 10, weight: .semibold)
private let msgCallFont = UIFont.systemFont(ofSize: 14, weight: .semibold)
private let msgCallTimeFont = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)

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
  // MessageRow.tsx: reactions outside a bubble (a round video, big emoji) carry a 1-point border: 2 taller and wider.
  let border: CGFloat = row.media == "note" || row.bigEmoji > 0 ? 2 : 0
  while i + 2 < row.chips.count {
    let emoji = row.chips[i]
    let count = Int(row.chips[i + 1]) ?? 1
    let mine = row.chips[i + 2] == "1"
    i += 3
    var w = ceil(NSAttributedString(string: emoji, attributes: [.font: msgChipEmoji]).size().width) + 16 + border
    if count > 1 { w += 4 + ceil(NSAttributedString(string: String(count), attributes: [.font: msgChipCount]).size().width) }
    if x > 0 && x + w > width {
      x = 0
      y += 29 + border
    }
    chips.append(MsgChip(emoji: emoji, count: count, mine: mine, frame: CGRect(x: x, y: y, width: w, height: 24 + border)))
    x += w + 5
    widest = max(widest, x - 5)
  }
  return (chips, chips.isEmpty ? .zero : CGSize(width: widest, height: y + 24 + border))
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

  /// The bottom of the line that holds a character.
  func lineBottom(atCharacter index: Int) -> CGFloat {
    let glyph = manager.glyphIndexForCharacter(at: index)
    return manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).maxY
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

/// chatPreferences.ts TEXT_SIZES: each text size has its own line (15/20, 17/22, 19/25, 22/28); the big emoji of
/// MessageRow.tsx 64/76, 52/62, 44/54.
func msgLineHeight(_ fontSize: CGFloat) -> CGFloat {
  switch fontSize {
  case 15: return 20
  case 17: return 22
  case 19: return 25
  case 22: return 28
  case 64: return 76
  case 52: return 62
  case 44: return 54
  default: return (fontSize * 1.3).rounded()
  }
}

/// The paragraph of a message's words: a fixed line, as React Native's `lineHeight` gives it.
private func msgBodyStyle(_ fontSize: CGFloat) -> NSParagraphStyle {
  let style = NSMutableParagraphStyle()
  style.lineBreakMode = .byWordWrapping
  style.minimumLineHeight = msgLineHeight(fontSize)
  style.maximumLineHeight = msgLineHeight(fontSize)
  return style
}

/// A paragraph style of a quote or a code block: the text stands in from the block's edge.
private func msgBlockStyle(_ inset: CGFloat, fontSize: CGFloat) -> NSParagraphStyle {
  let style = NSMutableParagraphStyle()
  style.lineBreakMode = .byWordWrapping
  style.minimumLineHeight = msgLineHeight(fontSize)
  style.maximumLineHeight = msgLineHeight(fontSize)
  style.firstLineHeadIndent = inset
  style.headIndent = inset
  style.tailIndent = -8
  return style
}

/// The text of a bubble with its formatting. Flags: 1 bold, 2 italic, 4 underline, 8 strike, 16 monospace,
/// 32 spoiler (a block until tapped), 64 link, 128 quote, 256 code block.
func msgBody(_ row: MsgRow, fontSize: CGFloat, text: UIColor, link: UIColor, quote: UIColor, revealed: Bool) -> NSAttributedString {
  let base = UIFont.systemFont(ofSize: fontSize)
  // React Native centres the glyphs in a fixed line: the baseline is lifted by half of the extra room.
  let lift = max(0, (msgLineHeight(fontSize) - base.lineHeight) / 2)
  let result = NSMutableAttributedString(string: row.text, attributes: [.font: base, .foregroundColor: text, .paragraphStyle: msgBodyStyle(fontSize), .baselineOffset: lift])
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
    if flags & 128 != 0 { result.addAttribute(.paragraphStyle, value: msgBlockStyle(11, fontSize: fontSize), range: range) }
    if flags & 256 != 0 { result.addAttribute(.paragraphStyle, value: msgBlockStyle(8, fontSize: fontSize), range: range) }
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

/// MessageRow.tsx `plainTime` (the open look): the time is a run of the words themselves — «\u00A0\u00A0[изм. ]time»
/// in 11 pt and, for one's own, «\u00A0» and the 15-point mark — so it is glued to the last word and takes that word
/// to the next line when it does not fit. Here the run is invisible; the time and the mark are drawn over it.
private let msgMarkRoom: UIImage = UIGraphicsImageRenderer(size: CGSize(width: 15, height: 1)).image { (_: UIGraphicsImageRendererContext) -> Void in }
private func msgTrailing(_ row: MsgRow) -> NSAttributedString {
  let out = NSMutableAttributedString(string: "\u{00A0}\u{00A0}" + row.time, attributes: [.font: msgMetaFont, .foregroundColor: UIColor.clear])
  if row.mine {
    out.append(NSAttributedString(string: "\u{00A0}", attributes: [.font: msgMetaFont, .foregroundColor: UIColor.clear]))
    let mark = NSTextAttachment()
    mark.image = msgMarkRoom
    mark.bounds = CGRect(x: 0, y: 0, width: 15, height: 1)
    out.append(NSAttributedString(attachment: mark))
  }
  return out
}
/// MessageRow.tsx `inlineTime`: words that do not end in a quote or a code block, without reactions inside.
private func msgInlineTime(_ row: MsgRow) -> Bool {
  !row.text.isEmpty && row.bigEmoji == 0 && row.chips.isEmpty && row.reactions.isEmpty && row.linkCard == nil
    && !stride(from: 0, to: row.fmt.count, by: 3).contains(where: { row.fmt[$0] & (128 | 256) != 0 })
}
/// MessageRow.tsx `plainTime`: the open look, and no rare marks (silent).
private func msgPlainTime(_ row: MsgRow) -> Bool { msgInlineTime(row) && msgOpenLook && row.media != "photo" && !row.silent }
/// The words of a row as they are laid out and drawn, with the invisible run at their end that keeps the time's room:
/// the open look's time itself (msgTrailing), or the bubbles' spacer «\u00A0\u00A0\u00A0[silent: 5 × \u00A0]time
/// [mine: 7 × \u00A0]\u00A0» in 11 pt — glued to the last word, so both take it to the next line together.
private func msgLaidBody(_ row: MsgRow, fontSize: CGFloat, text: UIColor, link: UIColor, quote: UIColor, revealed: Bool) -> NSAttributedString {
  let body = msgBody(row, fontSize: fontSize, text: text, link: link, quote: quote, revealed: revealed)
  guard msgInlineTime(row) else { return body }
  let out = NSMutableAttributedString(attributedString: body)
  if msgPlainTime(row) {
    out.append(msgTrailing(row))
  } else {
    let spacer = "\u{00A0}\u{00A0}\u{00A0}" + (row.silent ? String(repeating: "\u{00A0}", count: 5) : "") + row.time + (row.mine ? String(repeating: "\u{00A0}", count: 7) : "") + "\u{00A0}"
    out.append(NSAttributedString(string: spacer, attributes: [.font: msgMetaFont, .foregroundColor: UIColor.clear]))
  }
  return out
}

/// Where everything of one row goes, for the width it is shown at.
/// The open look: no bubbles. A message is its text on the page — own at the right edge, the other side's at
/// the left — and the time follows the last word on the same line.
/// ChatLook: the open look is the default; bubbles come with a wallpaper or the choice in «Оформление»
/// (Sources/ChatLook/BubbleLook.swift).
var msgOpenLook: Bool { ChatBubbleLook.open }
/// From the screen's edge to a message's plate (the text stands 13 further in).
private var msgEdge: CGFloat { msgOpenLook ? 6 : 9 } // ChatScreen.tsx listSide: 6 open, 9 with bubbles

/// From the plate's edges to the words (MessageRow.tsx): bubbles 11 + the text's own 1 on both sides; the open look
/// keeps the 2-point line + 10 + 1 at the other side's left and 4 + 1 at its right, own words 4 + 1 at the left and
/// 0 + 1 at the right. A photo with words keeps its card.
func msgPads(_ row: MsgRow) -> (left: CGFloat, right: CGFloat) {
  if !msgOpenLook || row.media == "photo" { return (12, 12) }
  return row.mine ? (5, 1) : (13, 5)
}

struct MsgLayout {
  /// The time stands on the text's last line, at this point from the text's corner (x: its left, y: the line's bottom).
  var timeInline = false
  var timeAt = CGPoint.zero
  /// Bubbles: the time in the plate's lower corner, its room kept at the end of the words.
  var timeCorner = false
  /// The time at the right of the reaction chips' row.
  var timeBeside = false
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
  /// Polls: the poll (zero size: none).
  var poll = MsgPollLayout()
  /// Attachments: the album's mosaic (zero size: none).
  var album = MsgAlbumLayout()
  /// Attachments: a photo without words — the picture alone, the time in its corner (Sources/Attachments/InlineMedia.swift).
  var photoBare = false
  /// Attachments: a file's card with the round button (zero size: none).
  var fileSize = CGSize.zero
  var height: CGFloat = 0

  static func make(_ row: MsgRow, width: CGFloat, fontSize: CGFloat, hasThumb: Bool) -> MsgLayout {
    var layout = MsgLayout()
    if row.kind == 2 {
      // Offline: the lock notice of messages sent before this device signed in (the reference's MissingRow).
      let box = min(width - 2 * msgEdge, 360)
      let size = msgSize(row.text, msgSmallFont, box - 28 - 26, 200)
      layout.textSize = size
      layout.bubble = CGSize(width: min(box, size.width + 28 + 26), height: max(size.height, 18) + 20)
      layout.height = layout.bubble.height + 20
      return layout
    }
    if row.kind == 1 && row.label == "day" {
      // MessageRow.tsx DayChip: 10 pt semibold, padding 6/14, a 1-point border; 15 above, 18 below.
      let words = NSAttributedString(string: row.text, attributes: [.font: msgDayFont])
      let size = CGSize(width: ceil(words.size().width), height: ceil(msgDayFont.lineHeight))
      layout.textSize = size
      layout.bubble = CGSize(width: size.width + 2 * 14 + 2, height: size.height + 2 * 6 + 2)
      layout.height = 15 + layout.bubble.height + 18
      return layout
    }
    if row.kind == 1 && row.label.hasPrefix("call") {
      // MessageRow.tsx CallServiceRow: up to 360 wide, padding 8 left / 14 right / 7 vertical, a 1-point border,
      // a 34-point round icon, 10 between; the words (14 semibold, one line) over the time (11); 6 below.
      let time = ceil(NSAttributedString(string: row.time, attributes: [.font: msgCallTimeFont]).size().width)
      let words = ceil(NSAttributedString(string: row.text, attributes: [.font: msgCallFont]).size().width)
      let room = min(360, width - 2 * msgEdge) - 2 - 8 - 34 - 10 - 14
      let textWidth = min(room, max(words, time))
      layout.textSize = CGSize(width: textWidth, height: ceil(msgCallFont.lineHeight) + 1 + ceil(msgCallTimeFont.lineHeight))
      layout.bubble = CGSize(width: 2 + 8 + 34 + 10 + textWidth + 14, height: 2 + 2 * 7 + max(34, layout.textSize.height))
      layout.height = layout.bubble.height + 6
      return layout
    }
    if row.kind == 1 {
      let size = msgSize(row.text, msgSmallFont, width * 0.8, 120)
      layout.textSize = size
      layout.bubble = CGSize(width: size.width + 24, height: size.height + 12)
      layout.height = layout.bubble.height + 8
      return layout
    }
    // MessageRow.tsx: a message is at most 85 % of the row (the list's own side margins taken off).
    let pads = msgPads(row)
    let inner = floor((width - 2 * msgEdge) * 0.85) - pads.left - pads.right
    let laidBody = row.text.isEmpty ? nil : MsgText(msgLaidBody(row, fontSize: fontSize, text: .black, link: .black, quote: .clear, revealed: true), width: inner)
    layout.textSize = laidBody?.size ?? .zero
    if !row.quoteText.isEmpty || !row.quoteAuthor.isEmpty {
      let words = NSAttributedString(string: row.quoteText.isEmpty ? " " : row.quoteText, attributes: [.font: msgQuoteFont, .paragraphStyle: msgQuoteStyle()])
      let box = words.boundingRect(with: CGSize(width: max(1, inner - msgQuoteIndent(row) - 8), height: ceil(msgQuoteFont.lineHeight * 2) + 1), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
      layout.quoteSize = CGSize(width: ceil(box.width), height: min(ceil(box.height), ceil(msgQuoteFont.lineHeight * 2)))
    }
    layout.labelSize = msgSize(row.label, msgSmallFont, inner, 36)
    // MessageRow.tsx `reactionsInside`: the chips and, 10 to their right, the time share one row.
    let metaRoom = ceil(NSAttributedString(string: row.time, attributes: [.font: msgMetaFont]).size().width) + (row.mine ? 19 : 0) + (row.silent ? 15 : 0)
    layout.timeBeside = !row.chips.isEmpty && row.media != "note" && row.bigEmoji == 0
    layout.reactSize = row.chips.isEmpty ? msgSize(row.reactions, msgSmallFont, inner, 40) : msgChips(row, width: layout.timeBeside ? max(40, inner - 10 - metaRoom) : inner).size
    if hasThumb {
      let w = min(inner, 220)
      layout.thumbSize = CGSize(width: w, height: min(300, max(90, w / row.thumbWide)))
    }
    // Voice/Video: a round video is a circle, a video keeps its place even before its picture is known, a voice
    // message is a block of its own.
    if row.media == "note" {
      let side = min(inner, 212)
      layout.thumbSize = CGSize(width: side, height: side)
    } else if row.media == "video" {
      // MediaBubble.tsx `mediaBox` / `captionedMediaBox`: a video takes a photo's place (Attachments/InlineMedia.swift).
      layout.thumbSize = InlineMediaArt.photoSize(row, width: width)
    } else if row.media == "voice" {
      layout.voiceSize = CGSize(width: min(inner, MediaRowArt.voiceWidth), height: MediaRowArt.voiceHeight) // VoiceMessage.tsx: 262 wide
    } else if row.media == "photo" {
      // Attachments: a photo shown whole, a file as a card (MediaBubble.tsx; Sources/Attachments/InlineMedia.swift).
      layout.thumbSize = InlineMediaArt.photoSize(row, width: width)
      layout.labelSize = .zero
    } else if row.media == "file" {
      layout.fileSize = InlineMediaArt.fileSize(row, inner: inner)
      layout.labelSize = .zero
    }
    let timeWidth = ceil(NSAttributedString(string: row.time, attributes: [.font: msgMetaFont]).size().width) + (row.mine ? 19 : 0) + (row.silent ? 15 : 0) // the mark 4 + 15 after the time; Composer: the bell of «без звука»
    var w = max(max(layout.textSize.width, timeWidth, layout.thumbSize.width, layout.labelSize.width), max(layout.reactSize.width, layout.voiceSize.width))
    if layout.timeBeside { w = max(w, min(inner, layout.reactSize.width + 10 + metaRoom)) }
    w = max(w, layout.fileSize.width) // Attachments
    if layout.quoteSize != .zero {
      let author = ceil(NSAttributedString(string: row.quoteAuthor, attributes: [.font: msgQuoteAuthorFont]).size().width)
      w = max(w, min(inner, max(layout.quoteSize.width, author) + msgQuoteIndent(row) + 8))
    }
    if !row.forward.isEmpty { w = max(w, min(inner, ceil(NSAttributedString(string: row.forward, attributes: [.font: msgForwardFont]).size().width) + 2)) }
    // LinkPreview: the card stands under the text, and the time then goes under the card.
    if let card = row.linkCard {
      layout.card = MsgLinkCardLayout.make(card, width: inner)
      w = max(w, layout.card.size.width)
    }
    // Polls: the poll stands where the text would (a poll's text is only for clients without polls).
    if let poll = row.poll {
      layout.poll = MsgPollLayout.make(poll, width: inner)
      w = max(w, layout.poll.size.width)
    }
    // Attachments: an album's mosaic stands above its caption.
    if let album = row.album {
      layout.album = MsgAlbumLayout.make(album, screenWidth: width, inner: inner)
      w = max(w, layout.album.size.width)
    }
    // MessageRow.tsx `inlineTime`: the time's room is the invisible run at the end of the words (msgLaidBody).
    if let laid = laidBody, msgInlineTime(row) {
      w = max(w, laid.size.width)
      if msgPlainTime(row) {
        // The open look: the time stands where its run was laid out, on that line's baseline.
        let start = (row.text as NSString).length + 2
        let place = laid.rect(NSRange(location: start, length: (row.time as NSString).length))
        layout.timeInline = true
        layout.timeAt = CGPoint(x: place.minX, y: laid.lineBottom(atCharacter: start))
      } else {
        // Bubbles (and the open look with a rare mark): the time sits in the lower corner, 10 from the right and 6
        // from the bottom.
        layout.timeCorner = true
      }
    }
    // Attachments: a photo without words is the picture alone (MessageRow.tsx `bare`).
    if row.media == "photo" && row.text.isEmpty && row.quoteText.isEmpty && row.quoteAuthor.isEmpty && row.forward.isEmpty && layout.reactSize == .zero {
      layout.photoBare = true
      layout.bubble = layout.thumbSize
      layout.height = layout.thumbSize.height + msgFailedRoom(row) + (row.tail ? 6 : 2)
      return layout
    }
    // MessageRow.tsx: 6 above the content.
    var h: CGFloat = 6
    if !row.forward.isEmpty { h += ceil(msgForwardFont.lineHeight) + 4 }
    if layout.quoteSize != .zero { h += msgQuoteHeight(layout.quoteSize.height, thumb: !row.quoteThumb.isEmpty) + 6 }
    if layout.thumbSize != .zero { h += layout.thumbSize.height + 6 }
    if layout.voiceSize != .zero { h += layout.voiceSize.height + 4 }
    if layout.labelSize != .zero { h += layout.labelSize.height + 4 }
    if layout.fileSize != .zero { h += layout.fileSize.height + 4 } // Attachments
    if layout.album.size != .zero { h += layout.album.size.height + 6 } // Attachments
    if layout.poll.size != .zero { h += layout.poll.size.height + 4 } // Polls
    h += layout.textSize.height
    if layout.card.size != .zero { h += layout.card.size.height + 7 }
    if layout.reactSize != .zero { h += layout.reactSize.height + 6 }
    if layout.timeBeside {
      // The time stands beside the chips: only the plate's 5 below.
      layout.bubble = CGSize(width: max(msgOpenLook ? 0 : 60, w + pads.left + pads.right), height: h + 5)
      layout.height = h + 5 + msgFailedRoom(row) + (row.tail ? 6 : 2)
      return layout
    }
    // Below: 6 under words that carry the time; else the time's own row (4 above it, 5 below).
    h += layout.timeInline || layout.timeCorner ? 6 : 4 + ceil(msgMetaFont.lineHeight) + 5
    // Bubbles are at least 60 wide; 6 under the last message of a run, 2 inside one (`groupNext`).
    layout.bubble = CGSize(width: max(msgOpenLook ? 0 : 60, w + pads.left + pads.right), height: h)
    layout.height = h + msgFailedRoom(row) + (row.tail ? 6 : 2)
    return layout
  }
}

final class MsgRowCanvas: UIView {
  var row: MsgRow?
  var palette = MsgPalette()
  var fontSize: CGFloat = 17
  var layoutInfo = MsgLayout()
  var thumbImage: UIImage?
  /// The quoted message's small picture, decoded once per cell.
  var quoteImage: UIImage?
  var pressed = false
  /// The spoilers of this message have been tapped open.
  var revealed = false
  /// Where the body text was drawn last (for taps on links and spoilers).
  private var bodyBox = CGRect.zero
  /// Avatars: a big emoji's glyphs are left out while their pop plays over them (Sources/Avatars/BigEmojiPop.swift).
  var hideBody = false
  /// Avatars: where the body was drawn last, for the pop of big emoji.
  var drawnBodyBox: CGRect { return bodyBox }
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
  /// Polls: where the poll was drawn last (a tap on an option votes).
  private var pollBox = CGRect.zero
  /// Attachments: the album's decoded small pictures, and where the album was drawn last.
  var albumPictures: [String: UIImage] = [:]
  private var albumBox = CGRect.zero

  /// Polls: the part of the poll under a point of this view ("option:<n>", "vote", "retract").
  func poll(at point: CGPoint) -> String? {
    guard pollBox != .zero, pollBox.contains(point), let poll = row?.poll else { return nil }
    return layoutInfo.poll.part(at: CGPoint(x: point.x - pollBox.minX, y: point.y - pollBox.minY), poll: poll)
  }

  /// Attachments: the key of the album's part under a point of this view.
  func albumPart(at point: CGPoint) -> String? {
    guard albumBox != .zero, albumBox.contains(point), let album = row?.album else { return nil }
    return layoutInfo.album.part(at: CGPoint(x: point.x - albumBox.minX, y: point.y - albumBox.minY), album: album)
  }

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
    let laid = MsgText(msgLaidBody(item, fontSize: fontSize, text: .black, link: .black, quote: .clear, revealed: true), width: bodyBox.width)
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
    pollBox = .zero // Polls
    albumBox = .zero // Attachments
    if item.kind == 2 {
      let box = CGRect(x: (w - bubble.width) / 2, y: 10, width: bubble.width, height: bubble.height)
      context.setFillColor(palette.notice.cgColor)
      context.addPath(UIBezierPath(roundedRect: box, cornerRadius: 16).cgPath)
      context.fillPath()
      if let lock = UIImage(systemName: "lock", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .regular))?
        .withTintColor(palette.noticeText, renderingMode: .alwaysOriginal) {
        lock.draw(at: CGPoint(x: box.minX + 14 + (16 - lock.size.width) / 2, y: box.midY - lock.size.height / 2))
      }
      let style = NSMutableParagraphStyle()
      style.alignment = .left
      style.lineSpacing = 2
      let textBox = CGRect(x: box.minX + 14 + 16 + 10, y: box.minY + 10, width: box.width - 28 - 26, height: box.height - 20)
      NSAttributedString(string: item.text, attributes: [.font: msgSmallFont, .foregroundColor: palette.noticeText, .paragraphStyle: style])
        .draw(with: textBox, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
      return
    }
    if item.kind == 1 && item.label == "day" {
      let look = ThemeStore.look
      let box = CGRect(x: (w - bubble.width) / 2, y: 15, width: bubble.width, height: bubble.height)
      let fill = look.black ? UIColor(white: 0, alpha: 0.68) : look.dark ? UIColor(red: 30 / 255, green: 36 / 255, blue: 53 / 255, alpha: 0.68) : UIColor(white: 1, alpha: 0.52)
      let edge = look.dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 1, alpha: 0.88)
      let outline = UIBezierPath(roundedRect: box.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 13.5)
      context.setFillColor(fill.cgColor)
      context.addPath(UIBezierPath(roundedRect: box, cornerRadius: 14).cgPath)
      context.fillPath()
      context.setStrokeColor(edge.cgColor)
      context.setLineWidth(1)
      context.addPath(outline.cgPath)
      context.strokePath()
      NSAttributedString(string: item.text, attributes: [.font: msgDayFont, .foregroundColor: palette.muted])
        .draw(at: CGPoint(x: box.minX + 15, y: box.minY + 7))
      return
    }
    if item.kind == 1 && item.label.hasPrefix("call") {
      let look = ThemeStore.look
      let red = item.label.contains("!")
      let box = CGRect(x: (w - bubble.width) / 2, y: 0, width: bubble.width, height: bubble.height)
      let fill = item.checked == 1 ? look.accentSoft : pressed ? (look.dark ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 1, alpha: 0.78))
        : look.dark ? UIColor(red: 12 / 255, green: 15 / 255, blue: 24 / 255, alpha: 0.60) : UIColor(white: 1, alpha: 0.62)
      let edge = look.dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 1, alpha: 0.88)
      context.setFillColor(fill.cgColor)
      context.addPath(UIBezierPath(roundedRect: box, cornerRadius: 20).cgPath)
      context.fillPath()
      context.setStrokeColor(edge.cgColor)
      context.setLineWidth(1)
      context.addPath(UIBezierPath(roundedRect: box.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 19.5).cgPath)
      context.strokePath()
      let circle = CGRect(x: box.minX + 1 + 8, y: box.midY - 17, width: 34, height: 34)
      context.setFillColor((red ? look.dangerBg : look.accentSoft).cgColor)
      context.fillEllipse(in: circle)
      let icon = IonIcon.image(item.label.contains("v") ? "videocam" : "call", size: 17).withTintColor(red ? palette.danger : palette.accent, renderingMode: .alwaysOriginal)
      icon.draw(at: CGPoint(x: circle.midX - 8.5, y: circle.midY - 8.5))
      let textX = circle.maxX + 10
      let textY = box.midY - layoutInfo.textSize.height / 2
      let line = NSMutableParagraphStyle()
      line.lineBreakMode = .byTruncatingTail
      NSAttributedString(string: item.text, attributes: [.font: msgCallFont, .foregroundColor: red ? palette.danger : palette.text, .paragraphStyle: line])
        .draw(with: CGRect(x: textX, y: textY, width: layoutInfo.textSize.width, height: ceil(msgCallFont.lineHeight)), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
      NSAttributedString(string: item.time, attributes: [.font: msgCallTimeFont, .foregroundColor: palette.muted])
        .draw(at: CGPoint(x: textX, y: textY + ceil(msgCallFont.lineHeight) + 1))
      return
    }
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
      // MessageRow.tsx: a chosen message lies on accentSoft (radius 14, 6 past the list's margins); the mark is
      // <Icon name="checkmark-circle"|"ellipse-outline" size={24}> at the left of a 30-point column.
      if item.checked == 1 {
        context.setFillColor(ThemeStore.look.accentSoft.cgColor)
        context.addPath(UIBezierPath(roundedRect: CGRect(x: msgEdge - 6, y: 0, width: w - 2 * (msgEdge - 6), height: bounds.height), cornerRadius: 14).cgPath)
        context.fillPath()
      }
      let mark = IonIcon.image(item.checked == 1 ? "checkmark-circle" : "ellipse-outline", size: 24)
        .withTintColor(item.checked == 1 ? palette.accent : palette.subtle, renderingMode: .alwaysOriginal)
      mark.draw(at: CGPoint(x: msgEdge, y: bounds.height / 2 - 12))
      if !item.mine { side += 30 }
    }
    let left = item.mine ? w - msgEdge - bubble.width : side
    let box = CGRect(x: left, y: 0, width: bubble.width, height: bubble.height)
    // The corner by the sender's edge is tight on the last bubble of a run (the «tail»).
    // ChatLook: «Углы сообщений» (8, 14, 20), the tail corner 6 at most (Sources/ChatLook/BubbleLook.swift).
    let shape = ChatBubbleLook.shape(box, mine: item.mine, tail: item.tail)
    // Attachments: a photo alone — the picture with the time in its corner, no plate and no line.
    // MessageRow.tsx: a refused message has a 1-point danger border and «Не отправлено · повторить» under it (a touch
    // on the row sends it again).
    if item.mine && item.ticks == 4 {
      let words = NSAttributedString(string: "Не отправлено · повторить", attributes: [.font: msgFailedFont, .foregroundColor: palette.danger])
      words.draw(at: CGPoint(x: w - msgEdge - ceil(words.size().width), y: bubble.height + 8))
    }
    if layoutInfo.photoBare {
      let outline = UIBezierPath(roundedRect: box, cornerRadius: 15)
      InlineMediaArt.drawPhoto(context, row: item, box: box, palette: palette, small: thumbImage, radius: 15, alone: true)
      if pressed || flash {
        context.setFillColor(Theme.veil(pressed ? 0.08 : 0.14).cgColor)
        context.addPath(outline.cgPath)
        context.fillPath()
      }
      return
    }
    // Attachments: a photo with words keeps its card in the open look too («a picture with a caption keeps its card»).
    if !msgOpenLook || item.media == "photo" {
      context.setFillColor((item.mine ? palette.mine : palette.theirs).cgColor)
      context.addPath(shape.cgPath)
      context.fillPath()
    } else if !item.mine && item.checked < 0 && item.thumb.isEmpty && item.media != "note" && item.media != "video" && item.media != "photo" {
      // ChatLook: the open look — the other side's words carry a thin line in their colour.
      ChatBubbleLook.drawPeerLine(context, box: box, fallback: palette.accent)
    }
    // MessageRow.tsx: a message has no pressed look (a tap opens its menu); the light after a jump from a quote is
    // the cell's JumpFlash (MsgRowCell.playFlash).

    let pads = msgPads(item)
    let x = left + pads.left
    var y: CGFloat = 6
    let inner = bubble.width - pads.left - pads.right
    let metaColor = item.mine ? palette.mineMeta : palette.muted
    let markColor = item.mine ? palette.mineMark : palette.accent
    if !item.forward.isEmpty {
      draw(item.forward, msgForwardFont, palette.accent, CGRect(x: x + 1, y: y, width: inner - 2, height: ceil(msgForwardFont.lineHeight)), lines: false)
      y += ceil(msgForwardFont.lineHeight) + 4
    }
    if layoutInfo.quoteSize != .zero {
      let height = msgQuoteHeight(layoutInfo.quoteSize.height, thumb: !item.quoteThumb.isEmpty)
      quoteBox = CGRect(x: x, y: y, width: inner, height: height)
      context.setFillColor((Theme.dark ? UIColor(white: 1, alpha: 0.06) : UIColor(white: 0, alpha: 0.04)).cgColor)
      context.addPath(UIBezierPath(roundedRect: quoteBox, cornerRadius: 10).cgPath)
      context.fillPath()
      context.saveGState()
      UIBezierPath(roundedRect: quoteBox, cornerRadius: 10).addClip()
      context.setFillColor(markColor.cgColor)
      context.addPath(UIBezierPath(roundedRect: CGRect(x: x, y: y, width: 3, height: height), cornerRadius: 2).cgPath)
      context.fillPath()
      context.restoreGState()
      // MessageRow.tsx replyThumb: 32 × 32 after the bar, centred, radius 5 (16 for a round video), on
      // rgba(120,130,160,0.18) until it shows.
      if !item.quoteThumb.isEmpty {
        let box = CGRect(x: x + 10, y: y + (height - 32) / 2, width: 32, height: 32)
        let corner: CGFloat = item.quoteRound ? 16 : 5
        context.setFillColor(UIColor(red: 120 / 255, green: 130 / 255, blue: 160 / 255, alpha: 0.18).cgColor)
        context.addPath(UIBezierPath(roundedRect: box, cornerRadius: corner).cgPath)
        context.fillPath()
        if let picture = quoteImage, picture.size.width > 0, picture.size.height > 0 {
          context.saveGState()
          UIBezierPath(roundedRect: box, cornerRadius: corner).addClip()
          let scale = max(32 / picture.size.width, 32 / picture.size.height)
          let size = CGSize(width: picture.size.width * scale, height: picture.size.height * scale)
          picture.draw(in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height))
          context.restoreGState()
        }
      }
      let words = x + msgQuoteIndent(item)
      let top = y + 5 // the words stand at the top of the block (paddingVertical 5); the picture is centred
      draw(item.quoteAuthor, msgQuoteAuthorFont, markColor, CGRect(x: words, y: top, width: inner - msgQuoteIndent(item) - 8, height: ceil(msgQuoteAuthorFont.lineHeight)), lines: false)
      NSAttributedString(string: item.quoteText, attributes: [.font: msgQuoteFont, .foregroundColor: metaColor, .paragraphStyle: msgQuoteStyle()])
        .draw(with: CGRect(x: words, y: top + ceil(msgQuoteAuthorFont.lineHeight) + 1, width: inner - msgQuoteIndent(item) - 8, height: layoutInfo.quoteSize.height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
      y += height + 6
    }
    // Attachments: the album's mosaic.
    if layoutInfo.album.size != .zero, let album = item.album {
      albumBox = CGRect(x: x, y: y, width: layoutInfo.album.size.width, height: layoutInfo.album.size.height)
      layoutInfo.album.draw(album, pictures: albumPictures, in: context, at: albumBox.origin, palette: palette)
      y += layoutInfo.album.size.height + 6
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
    // Attachments: a photo with words, shown whole above them.
    if item.media == "photo" && layoutInfo.thumbSize != .zero {
      let picture = CGRect(x: x, y: y, width: layoutInfo.thumbSize.width, height: layoutInfo.thumbSize.height)
      InlineMediaArt.drawPhoto(context, row: item, box: picture, palette: palette, small: thumbImage, radius: 12, alone: false)
      y += picture.height + 6
    }
    if let image = thumbImage, item.media != "photo", layoutInfo.thumbSize != .zero, image.size.width > 0, image.size.height > 0 {
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
    if mediaBoxes.thumb != .zero { MediaRowArt.marks(context, row: item, state: mediaState, palette: palette, box: mediaBoxes.thumb, hosted: subviews.contains { $0 is NotePlayerView }) }
    if layoutInfo.voiceSize != .zero {
      mediaBoxes = MediaRowArt.voice(context, row: item, state: mediaState, palette: palette, box: CGRect(x: x, y: y, width: layoutInfo.voiceSize.width, height: layoutInfo.voiceSize.height))
      y += layoutInfo.voiceSize.height + 4
    }
    if layoutInfo.labelSize != .zero {
      draw(item.label, msgSmallFont, markColor, CGRect(x: x, y: y, width: inner, height: layoutInfo.labelSize.height), lines: true)
      y += layoutInfo.labelSize.height + 4
    }
    // Attachments: a file's card with the round button.
    if layoutInfo.fileSize != .zero {
      InlineMediaArt.drawFile(context, row: item, box: CGRect(x: x, y: y, width: layoutInfo.fileSize.width, height: layoutInfo.fileSize.height), palette: palette)
      y += layoutInfo.fileSize.height + 4
    }
    // Polls: the question, the options and the results.
    if layoutInfo.poll.size != .zero, let poll = item.poll {
      pollBox = CGRect(x: x, y: y, width: layoutInfo.poll.size.width, height: layoutInfo.poll.size.height)
      layoutInfo.poll.draw(poll, in: context, at: pollBox.origin, palette: palette)
      y += layoutInfo.poll.size.height + 4
    }
    bodyBox = .zero
    if layoutInfo.textSize != .zero {
      bodyBox = CGRect(x: x, y: y, width: inner, height: layoutInfo.textSize.height + 2)
      if hideBody && item.bigEmoji > 0 {
        // Avatars: the big emoji is drawn by its pop for the moment (Sources/Avatars/BigEmojiPop.swift).
      } else if item.fmt.isEmpty {
        MsgText(msgLaidBody(item, fontSize: fontSize, text: palette.text, link: markColor, quote: palette.quote, revealed: revealed), width: inner).draw(at: CGPoint(x: x, y: y))
      } else {
        let laid = MsgText(msgLaidBody(item, fontSize: fontSize, text: palette.text, link: markColor, quote: palette.quote, revealed: revealed), width: inner)
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
      let metaRoom = ceil(NSAttributedString(string: item.time, attributes: [.font: msgMetaFont]).size().width) + (item.mine ? 19 : 0) + (item.silent ? 15 : 0)
      for chip in msgChips(item, width: layoutInfo.timeBeside ? max(40, inner - 10 - metaRoom) : inner).chips {
        let frame = chip.frame.offsetBy(dx: x, dy: y + 6)
        chipBoxes.append((frame, chip.emoji))
        // MessageRow.tsx: mine in the accent, else white 0.10 on dark / black 0.06 on light; radius 14. Under a round
        // video or big emoji (reactions outside a bubble): white 0.07 on dark / white 0.7 on light, a 1-point border.
        let outside = item.media == "note" || item.bigEmoji > 0
        let quiet = outside ? (Theme.dark ? UIColor(white: 1, alpha: 0.07) : UIColor(white: 1, alpha: 0.7)) : (Theme.dark ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.06))
        context.setFillColor((chip.mine ? palette.accent : quiet).cgColor)
        context.addPath(UIBezierPath(roundedRect: frame, cornerRadius: min(14, frame.height / 2)).cgPath)
        context.fillPath()
        if outside {
          context.setStrokeColor(ThemeStore.look.border.cgColor)
          context.setLineWidth(1)
          context.addPath(UIBezierPath(roundedRect: frame.insetBy(dx: 0.5, dy: 0.5), cornerRadius: min(13.5, frame.height / 2 - 0.5)).cgPath)
          context.strokePath()
        }
        let emoji = NSAttributedString(string: chip.emoji, attributes: [.font: msgChipEmoji])
        let emojiSize = emoji.size()
        emoji.draw(at: CGPoint(x: frame.minX + 8 + (outside ? 1 : 0), y: frame.midY - emojiSize.height / 2))
        if chip.count > 1 {
          let count = NSAttributedString(string: String(chip.count), attributes: [.font: msgChipCount, .foregroundColor: chip.mine ? palette.onAccent : palette.text])
          count.draw(at: CGPoint(x: frame.minX + 8 + (outside ? 1 : 0) + ceil(emojiSize.width) + 4, y: frame.midY - count.size().height / 2))
        }
      }
    } else if layoutInfo.reactSize != .zero {
      draw(item.reactions, msgSmallFont, palette.text, CGRect(x: x, y: y + 6, width: inner, height: layoutInfo.reactSize.height + 2), lines: true)
    }

    let time = NSAttributedString(string: item.time, attributes: [.font: msgMetaFont, .foregroundColor: metaColor]) // the time keeps its colour; the red is the mark
    let timeSize = time.size()
    // After the last word of the text, or in the plate's lower corner.
    let inline = layoutInfo.timeInline && bodyBox != .zero
    // The mark: 4 after the time in a row of marks; after a «\u00A0» when it follows the words.
    let nbsp = NSAttributedString(string: "\u{00A0}", attributes: [.font: msgMetaFont]).size().width
    let marks: CGFloat = item.mine ? (inline ? nbsp + 15 : 19) : 0
    // MessageRow.tsx: in the corner of a bubble 10 from the right and 6 from the bottom; on a row of its own at the
    // right of the content (justify flex-end), 5 above the plate's bottom.
    let corner = layoutInfo.timeCorner && bodyBox != .zero
    let under = left + bubble.width - (corner ? 10 : msgOpenLook && item.media != "photo" ? pads.right - 1 : 11)
    let right = inline ? bodyBox.minX + layoutInfo.timeAt.x + ceil(timeSize.width) + marks + (item.silent ? 15 : 0) : under // Composer: room for the bell
    // Inline, the time shares the last line's baseline (it is a trailing run of the words in the reference).
    let bodyFont = UIFont.systemFont(ofSize: fontSize)
    let lift = max(0, (msgLineHeight(fontSize) - bodyFont.lineHeight) / 2)
    let baseline = bodyBox.minY + layoutInfo.timeAt.y - lift + bodyFont.descender
    let timeBottom = inline ? baseline - msgMetaFont.ascender + timeSize.height : bubble.height - (corner ? 6 : layoutInfo.timeBeside ? 6 : 5)
    time.draw(at: CGPoint(x: right - marks - ceil(timeSize.width), y: timeBottom - timeSize.height))
    // Composer: «без звука» — <Icon name="notifications-off" size={11} color={t.subtle}> before the time, 4 apart.
    if item.silent {
      let bell = IonIcon.image("notifications-off", size: 11).withTintColor(palette.subtle, renderingMode: .alwaysOriginal)
      bell.draw(at: CGPoint(x: right - marks - ceil(timeSize.width) - 4 - 11, y: timeBottom - timeSize.height / 2 - 5.5))
    }
    // MessageRow.tsx: after the time (4 apart) <Icon name="checkmark"|"checkmark-done" size={15}>, read in the accent;
    // on its way <Icon name="time-outline" size={12}>; failed <Icon name="alert-circle" size={13} color={t.danger}>.
    let middle = timeBottom - timeSize.height / 2
    if item.mine && item.ticks == 4 && (!msgOpenLook || item.media == "photo") {
      context.setStrokeColor(palette.danger.cgColor)
      context.setLineWidth(1)
      context.addPath(ChatBubbleLook.shape(box.insetBy(dx: 0.5, dy: 0.5), mine: true, tail: item.tail).cgPath)
      context.strokePath()
    }
    if item.mine && (item.ticks == 1 || item.ticks == 2) {
      let tick = IonIcon.image(item.ticks == 2 ? "checkmark-done" : "checkmark", size: 15).withTintColor(item.ticks == 2 ? markColor : metaColor, renderingMode: .alwaysOriginal)
      tick.draw(at: CGPoint(x: right - 15, y: middle - 7.5))
    } else if item.mine && item.ticks >= 3 {
      let failed = item.ticks == 4
      let side: CGFloat = failed ? 13 : 12
      let mark = IonIcon.image(failed ? "alert-circle" : "time-outline", size: side).withTintColor(failed ? palette.danger : metaColor, renderingMode: .alwaysOriginal)
      mark.draw(at: CGPoint(x: right - 15 + (15 - side) / 2, y: middle - side / 2))
    }
  }
}

final class MsgRowCell: UITableViewCell {
  let canvas = MsgRowCanvas(frame: .zero)
  private var thumbOf = ""
  private var quoteOf = ""
  /// LinkPreview: the picture of the card this cell decoded last.
  private var cardOf = ""
  /// Attachments: the album whose pictures this cell decoded last.
  private var albumOf = ""

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

  /// MessageRow.tsx JumpFlash: accentSoft over the row (9 past the list's margins, 2 higher), in 160 ms, held
  /// 650 ms, out in 550 ms.
  private let jumpLight = UIView()
  func playFlash() {
    if jumpLight.superview == nil {
      jumpLight.isUserInteractionEnabled = false
      contentView.insertSubview(jumpLight, belowSubview: canvas)
    }
    jumpLight.backgroundColor = ThemeStore.look.accentSoft
    jumpLight.frame = CGRect(x: msgEdge - 9, y: -2, width: contentView.bounds.width - 2 * (msgEdge - 9), height: contentView.bounds.height)
    jumpLight.alpha = 0
    // withTiming's own easing: Easing.inOut(Easing.quad).
    let light = jumpLight
    let rise = UIViewPropertyAnimator(duration: 0.16, controlPoint1: CGPoint(x: 0.455, y: 0.03), controlPoint2: CGPoint(x: 0.515, y: 0.955)) { light.alpha = 1 }
    rise.addCompletion { (_: UIViewAnimatingPosition) -> Void in
      let fade = UIViewPropertyAnimator(duration: 0.55, controlPoint1: CGPoint(x: 0.455, y: 0.03), controlPoint2: CGPoint(x: 0.515, y: 0.955)) { light.alpha = 0 }
      fade.startAnimation(afterDelay: 0.65)
    }
    rise.startAnimation()
  }

  func show(_ row: MsgRow, _ palette: MsgPalette, _ fontSize: CGFloat, _ layout: MsgLayout, _ revealed: Bool) {
    // Voice/Video: a round video playing in place belongs to one row; a cell given to another row lets it go.
    if canvas.row?.key != row.key { canvas.subviews.forEach { $0.removeFromSuperview() } }
    canvas.row = row
    canvas.revealed = revealed
    canvas.palette = palette
    canvas.fontSize = row.bigEmoji > 0 ? BigEmoji.fontSize(row.bigEmoji) : fontSize // Composer: big emoji
    canvas.layoutInfo = layout
    if row.thumb != thumbOf {
      thumbOf = row.thumb
      canvas.thumbImage = row.thumb.isEmpty ? nil : Data(base64Encoded: row.thumb, options: .ignoreUnknownCharacters).flatMap { UIImage(data: $0) }
    }
    if row.quoteThumb != quoteOf {
      quoteOf = row.quoteThumb
      canvas.quoteImage = row.quoteThumb.isEmpty ? nil : Data(base64Encoded: row.quoteThumb, options: .ignoreUnknownCharacters).flatMap { UIImage(data: $0) }
    }
    if row.media == "photo" { InlineMedia.shared.want(row.key) } // Attachments: a photo up to 10 MB comes by itself
    // LinkPreview: the card's picture is decoded once per cell, not on every drawing.
    // Attachments: the small pictures of an album are decoded once per cell.
    let albumKeys = row.album?.parts.map { $0.key }.joined(separator: ",") ?? ""
    if albumKeys != albumOf {
      albumOf = albumKeys
      canvas.albumPictures = row.album.map { MsgAlbumLayout.pictures($0) } ?? [:]
    }
    let cardPicture = row.linkCard?.image ?? ""
    if cardPicture != cardOf {
      cardOf = cardPicture
      canvas.cardImage = row.linkCard?.picture()
    }
    BigEmojiPop.shown(self, row) // Avatars: big emoji pop in as on the reference's iPhone
    accessibilityLabel = [row.media == "photo" ? "Фото" : "", MediaRowArt.spoken(row), row.album.map { "Альбом · \($0.parts.count)" } ?? "", row.poll?.spoken ?? "", row.label, row.text, row.linkCard?.spoken ?? "", row.silent ? "без звука" : "", row.time].filter { !$0.isEmpty }.joined(separator: ". ")
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
  /// Polls: a tap on a poll (`key`: the row, `part`: "option:<n>", "vote" or "retract").
  var onPollPress: ([String: Any]) -> Void = { _ in }
  /// Attachments: a tap on a photo of an album (`key`: the row, `part`: the key of that photo's own message).
  var onAlbumPress: ([String: Any]) -> Void = { _ in }
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
  /// ChatLook: a swipe to the left answers a message (`key`); new messages slide in; the look the rows were laid
  /// out for (Sources/ChatLook/MsgMotion.swift, BubbleLook.swift).
  var onSwipeReply: ([String: Any]) -> Void = { _ in }
  var canSwipeReply: (String) -> Bool = { _ in false }
  private var swipeReply: MsgSwipeReply?
  private let arrivals = MsgArrivals()
  private var lookKey = ChatBubbleLook.key

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
    lookInstall() // ChatLook
    NotificationCenter.default.addObserver(self, selector: #selector(inlineMediaChanged(_:)), name: InlineMedia.changed, object: nil) // Attachments
  }

  /// Attachments: a photo or a file of a row came, is coming or stopped — only that row is drawn again.
  @objc private func inlineMediaChanged(_ note: Notification) {
    guard let key = note.object as? String else { return }
    for cell in table.visibleCells {
      guard let rowCell = cell as? MsgRowCell, rowCell.canvas.row?.key == key else { continue }
      rowCell.canvas.setNeedsDisplay()
    }
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

  /// Polls: the part of a poll under a point of the table (not while messages are being chosen).
  private func poll(atTablePoint point: CGPoint) -> (key: String, part: String)? {
    guard let path = table.indexPathForRow(at: point), path.row < rows.count, rows[path.row].checked < 0, let cell = table.cellForRow(at: path) as? MsgRowCell,
          let part = cell.canvas.poll(at: table.convert(point, to: cell.canvas)) else { return nil }
    return (rows[path.row].key, part)
  }

  /// Attachments: the photo of an album under a point of the table (not while messages are being chosen).
  private func album(atTablePoint point: CGPoint) -> (key: String, part: String)? {
    guard let path = table.indexPathForRow(at: point), path.row < rows.count, rows[path.row].checked < 0, let cell = table.cellForRow(at: path) as? MsgRowCell,
          let part = cell.canvas.albumPart(at: table.convert(point, to: cell.canvas)) else { return nil }
    return (rows[path.row].key, part)
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

  /// Record: the play button of a voice row while it is on screen (drawn at once if it was not yet), for the blob
  /// of a sent take to fly to.
  func mediaPlayHost(_ key: String) -> (view: UIView, frame: CGRect)? {
    table.layoutIfNeeded()
    for cell in table.visibleCells {
      guard let rowCell = cell as? MsgRowCell, rowCell.canvas.row?.key == key else { continue }
      rowCell.canvas.layer.displayIfNeeded()
      let play = rowCell.canvas.mediaBoxes.play
      return play == .zero ? nil : (rowCell.canvas, play)
    }
    return nil
  }

  /// Voice/Video: the rows on screen, by key.
  /// ChatScreen.tsx `peek`: a picture of the row of `key` as it stands now (the whole width), for the message menu.
  func rowSnapshot(_ key: String) -> UIView? {
    guard let index = rows.firstIndex(where: { $0.key == key }), let cell = table.cellForRow(at: IndexPath(row: index, section: 0)) as? MsgRowCell else { return nil }
    let picture = cell.canvas.snapshotView(afterScreenUpdates: false)
    picture?.bounds = CGRect(origin: .zero, size: cell.canvas.bounds.size)
    return picture
  }

  func visibleKeys() -> [String] {
    table.visibleCells.compactMap { ($0 as? MsgRowCell)?.canvas.row?.key }
  }

  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    if gestureRecognizer === linkTap {
      let point = gestureRecognizer.location(in: table)
      return chip(atTablePoint: point) != nil || run(atTablePoint: point) != nil || quote(atTablePoint: point) != nil || media(atTablePoint: point) != nil
        || card(atTablePoint: point) != nil
        || poll(atTablePoint: point) != nil || album(atTablePoint: point) != nil // Polls, Attachments
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
      if let hit = card(atTablePoint: recognizer.location(in: table)) { onCardPress(["key": hit.key, "url": hit.url]); return }
      // Polls: an option, «Голосовать», «Отменить голос».
      if let hit = poll(atTablePoint: recognizer.location(in: table)) { onPollPress(["key": hit.key, "part": hit.part]); return }
      // Attachments: one photo of an album.
      if let hit = album(atTablePoint: recognizer.location(in: table)) { onAlbumPress(["key": hit.key, "part": hit.part]) }
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
    if row.key == expandedNote, row.media == "note" { return grown(row, width: width) } // Videonote
    if let hit = layouts[row.key], hit.row == row, hit.width == width, hit.font == fontSize { return hit.layout }
    // Composer: 1–3 emoji alone are laid out large.
    let made = MsgLayout.make(row, width: width, fontSize: row.bigEmoji > 0 ? BigEmoji.fontSize(row.bigEmoji) : fontSize, hasThumb: !row.thumb.isEmpty)
    layouts[row.key] = (row, width, fontSize, made)
    return made
  }

  // MARK: Videonote — a circle listened to grows in place (VideoNote.tsx `noteSizes`: 212 → min(404, the row))

  /// The row whose round video is being listened to (its slot is large); empty: none.
  private(set) var expandedNote = ""

  /// The layout of a round video's row with its slot at the large size.
  private func grown(_ row: MsgRow, width: CGFloat) -> MsgLayout {
    var made = MsgLayout.make(row, width: width, fontSize: fontSize, hasThumb: !row.thumb.isEmpty)
    let small = made.thumbSize.width
    let big = max(small, min(404, floor(width - 18)))
    let grow = big - small
    guard grow > 0 else { return made }
    made.thumbSize = CGSize(width: big, height: big)
    made.bubble = CGSize(width: max(made.bubble.width, made.bubble.width + grow), height: made.bubble.height + grow)
    made.height += grow
    return made
  }

  /// Makes the slot of `key` large (or, with an empty key, gives the room back), at once and without moving the
  /// list's other rows by animation.
  func setExpandedNote(_ key: String) {
    if key == expandedNote { return }
    let keys = [expandedNote, key].filter { !$0.isEmpty }
    expandedNote = key
    let paths = keys.compactMap { (wanted: String) -> IndexPath? in rows.firstIndex(where: { $0.key == wanted }).map { IndexPath(row: $0, section: 0) } }
    guard !paths.isEmpty else { return }
    UIView.performWithoutAnimation {
      table.reloadRows(at: paths, with: .none)
      table.layoutIfNeeded()
    }
  }

  /// Whether a row is one's own (its circle grows away from the right edge).
  func isMine(_ key: String) -> Bool { rows.first(where: { $0.key == key })?.mine ?? true }

  func setRows(_ oldestFirst: [MsgRow]) {
    let next = Array(oldestFirst.reversed())
    if next == rows { return }
    let sameOrder = next.count == rows.count && zip(next, rows).allSatisfy { $0.key == $1.key }
    let sameHeights = sameOrder && zip(next, rows).allSatisfy { $0 == $1 || layout($0).height == layout($1).height }
    // Telegram: a message of your own takes the list to its end, wherever it was scrolled to.
    let ownNew = !rows.isEmpty && (next.first.map { $0.mine && $0.key != rows.first?.key } ?? false)
    arrivals.take(next) // ChatLook: which rows are new and slide in
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
        if lit { rowCell.playFlash() }
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
    // ChatLook: a message that just arrived slides in.
    if let rowCell = cell as? MsgRowCell, indexPath.row < rows.count {
      arrivals.play(rowCell.canvas, key: rows[indexPath.row].key, note: rows[indexPath.row].media == "note")
    }
    // Once per «oldest row»: asked again only after older rows have arrived.
    guard let oldest = rows.last, indexPath.row >= rows.count - 5, askedAt != oldest.key else { return }
    askedAt = oldest.key
    onNearTop(["key": oldest.key])
  }

  /// ChatsPlus: a notice row that takes a touch — a finished call («Перезвонить», MessageRow.tsx).
  var noticeTappable: (String) -> Bool = { _ in false }

  func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
    indexPath.row < rows.count && (rows[indexPath.row].kind == 0 || noticeTappable(rows[indexPath.row].key))
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

// MARK: ChatLook — swipe to answer, the look of the rows (Sources/ChatLook/)

extension MsgListView {
  fileprivate func lookInstall() {
    let swipe = MsgSwipeReply(table: table)
    swipe.rowAt = { [weak self] (point: CGPoint) -> (key: String, view: UIView)? in
      guard let self, let path = self.table.indexPathForRow(at: point), path.row < self.rows.count, self.rows[path.row].kind == 0,
            self.rows[path.row].checked < 0, let cell = self.table.cellForRow(at: path) as? MsgRowCell else { return nil }
      return (self.rows[path.row].key, cell.canvas)
    }
    swipe.canReply = { [weak self] (key: String) -> Bool in self?.canSwipeReply(key) ?? false }
    swipe.onReply = { [weak self] (key: String) -> Void in self?.onSwipeReply(["key": key]) }
    swipeReply = swipe
  }

  #if targetEnvironment(simulator)
  /// The simulator check: the newest message of the other side on screen, and a new one that arrives.
  func demoTheirs() -> (key: String, view: UIView)? {
    for cell in table.visibleCells {
      guard let rowCell = cell as? MsgRowCell, let row = rowCell.canvas.row, row.kind == 0, !row.mine else { continue }
      return (row.key, rowCell.canvas)
    }
    return nil
  }

  func swipeDemo(view: UIView) { swipeReply?.demo(view) }

  func demoArrive() {
    let fresh = MsgRow.parse([["key": "demo-arrive", "kind": 0, "mine": false, "text": "Кстати, я уже на месте 👋", "time": "12:41", "tail": true]])
    setRows(Array(rows.reversed()) + fresh)
  }
  #endif

  /// The look changed (bubbles or not, the corners, the colours): every row is laid out and drawn again.
  func setLook(palette next: MsgPalette) {
    let key = ChatBubbleLook.key
    if key == lookKey && next == palette { return }
    lookKey = key
    palette = next
    layouts.removeAll()
    table.reloadData()
  }
}
