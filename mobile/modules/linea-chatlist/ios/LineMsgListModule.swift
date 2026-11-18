import CoreGraphics
import ExpoModulesCore
import UIKit

// The experimental native list of one chat's messages (contract in ../index.ts; the Android twin is MsgListView.kt).
// Rows come oldest first. The table is turned upside down (and every cell turned back), so index 0 is the newest
// message at the bottom: older pages are added at the far end and nothing on screen moves.
public final class LineMsgListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LineaMsgList")
    View(MsgListView.self) {
      Events("onMsgPress", "onMsgLongPress", "onNearTop")
      Prop("rows") { (view: MsgListView, rows: [[String: Any]]?) in view.setRows(MsgRow.parse(rows ?? [])) }
      Prop("palette") { (view: MsgListView, palette: [String: Any]?) in view.setPalette(MsgPalette(palette ?? [:])) }
      Prop("fontSize") { (view: MsgListView, size: Double?) in view.setFontSize(CGFloat(size ?? 17)) }
      Prop("pad") { (view: MsgListView, pad: [Double]?) in
        let values = pad ?? []
        view.setPad(top: values.count > 0 ? values[0] : 0, bottom: values.count > 1 ? values[1] : 0)
      }
    }
  }
}

/// One row of a chat (see NativeMsgRow in ../index.ts). kind 0 = a bubble, 1 = a centred notice.
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
        thumbRound: flag(row["thumbRound"]), thumbWide: CGFloat(min(2.5, max(0.4, wide))), checked: min(1, max(-1, int(row["checked"], -1))), reactions: text(row["reactions"])))
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

/// Where everything of one row goes, for the width it is shown at.
struct MsgLayout {
  var bubble = CGSize.zero
  var textSize = CGSize.zero
  var quoteSize = CGSize.zero
  var labelSize = CGSize.zero
  var thumbSize = CGSize.zero
  var reactSize = CGSize.zero
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
    layout.textSize = msgSize(row.text, body, inner, 20000)
    if !row.quoteText.isEmpty || !row.quoteAuthor.isEmpty { layout.quoteSize = msgSize(row.quoteText.isEmpty ? " " : row.quoteText, msgSmallFont, inner - 12, 36) }
    layout.labelSize = msgSize(row.label, msgSmallFont, inner, 36)
    layout.reactSize = msgSize(row.reactions, msgSmallFont, inner, 40)
    if hasThumb {
      let w = min(inner, 220)
      layout.thumbSize = CGSize(width: w, height: min(300, max(90, w / row.thumbWide)))
    }
    let timeWidth = ceil(NSAttributedString(string: row.time, attributes: [.font: msgMetaFont]).size().width) + (row.mine ? 22 : 0)
    var w = max(max(layout.textSize.width, timeWidth, layout.thumbSize.width, layout.labelSize.width), layout.reactSize.width)
    if layout.quoteSize != .zero {
      let author = ceil(NSAttributedString(string: row.quoteAuthor, attributes: [.font: msgSmallBold]).size().width)
      w = max(w, min(inner, max(layout.quoteSize.width, author) + 12))
    }
    if !row.forward.isEmpty { w = max(w, min(inner, ceil(NSAttributedString(string: row.forward, attributes: [.font: msgSmallBold]).size().width))) }
    var h: CGFloat = 9
    if !row.forward.isEmpty { h += 18 }
    if layout.quoteSize != .zero { h += 17 + layout.quoteSize.height + 8 }
    if layout.thumbSize != .zero { h += layout.thumbSize.height + 6 }
    if layout.labelSize != .zero { h += layout.labelSize.height + 4 }
    h += layout.textSize.height
    if layout.reactSize != .zero { h += layout.reactSize.height + 6 }
    h += 16 + 6
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
    var side: CGFloat = 9
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
    let left = item.mine ? w - 9 - bubble.width : side
    let box = CGRect(x: left, y: 0, width: bubble.width, height: bubble.height)
    // The corner by the sender's edge is tight on the last bubble of a run (the «tail»).
    var corners: UIRectCorner = [.topLeft, .topRight, .bottomLeft, .bottomRight]
    if item.tail { corners.remove(item.mine ? .bottomRight : .bottomLeft) }
    let shape = UIBezierPath(roundedRect: box, byRoundingCorners: corners, cornerRadii: CGSize(width: 20, height: 20))
    context.setFillColor((item.mine ? palette.mine : palette.theirs).cgColor)
    context.addPath(shape.cgPath)
    context.fillPath()
    if pressed {
      context.setFillColor(UIColor(white: 1, alpha: 0.08).cgColor)
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
    if layoutInfo.labelSize != .zero {
      draw(item.label, msgSmallFont, markColor, CGRect(x: x, y: y, width: inner, height: layoutInfo.labelSize.height), lines: true)
      y += layoutInfo.labelSize.height + 4
    }
    if layoutInfo.textSize != .zero {
      draw(item.text, UIFont.systemFont(ofSize: fontSize), palette.text, CGRect(x: x, y: y, width: inner, height: layoutInfo.textSize.height + 2), lines: true)
      y += layoutInfo.textSize.height
    }
    if layoutInfo.reactSize != .zero {
      draw(item.reactions, msgSmallFont, palette.text, CGRect(x: x, y: y + 6, width: inner, height: layoutInfo.reactSize.height + 2), lines: true)
    }

    let right = left + bubble.width - 13
    let marks: CGFloat = item.mine ? 20 : 0
    let time = NSAttributedString(string: item.time, attributes: [.font: msgMetaFont, .foregroundColor: item.ticks == 4 ? palette.danger : metaColor])
    let timeSize = time.size()
    time.draw(at: CGPoint(x: right - marks - ceil(timeSize.width), y: bubble.height - 8 - timeSize.height + 2))
    let my = bubble.height - 12
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

  func show(_ row: MsgRow, _ palette: MsgPalette, _ fontSize: CGFloat, _ layout: MsgLayout) {
    canvas.row = row
    canvas.palette = palette
    canvas.fontSize = fontSize
    canvas.layoutInfo = layout
    if row.thumb != thumbOf {
      thumbOf = row.thumb
      canvas.thumbImage = row.thumb.isEmpty ? nil : Data(base64Encoded: row.thumb, options: .ignoreUnknownCharacters).flatMap { UIImage(data: $0) }
    }
    accessibilityLabel = [row.label, row.text, row.time].filter { !$0.isEmpty }.joined(separator: ". ")
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

final class MsgListView: ExpoView, UITableViewDataSource, UITableViewDelegate {
  let onMsgPress = EventDispatcher()
  let onMsgLongPress = EventDispatcher()
  let onNearTop = EventDispatcher()

  private let table = UITableView(frame: .zero, style: .plain)
  /// Newest first (index 0 is at the bottom of the screen).
  private var rows: [MsgRow] = []
  private var palette = MsgPalette()
  private var fontSize: CGFloat = 17
  private var layouts: [String: (row: MsgRow, width: CGFloat, font: CGFloat, layout: MsgLayout)] = [:]
  private var askedAt = ""
  /// What `pad` asked for, and how much of the list the keyboard covers on top of that.
  private var padInsets = UIEdgeInsets.zero
  private var keyboardOverlap: CGFloat = 0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
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
    table.frame = bounds
    addSubview(table)
    let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
    hold.minimumPressDuration = 0.4
    table.addGestureRecognizer(hold)
    // The list reaches the bottom of the screen and nothing in React shrinks it for the keyboard: seen in the
    // simulator, the newest messages (and the one just sent) stayed behind the keyboard and the composer.
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
  }

  @objc private func keyboardMoved(_ note: Notification) {
    guard let window = window, let info = note.userInfo, let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    let mine = convert(bounds, to: window)
    let overlap = max(0, mine.maxY - max(end.minY, mine.minY))
    if abs(overlap - keyboardOverlap) < 0.5 { return }
    keyboardOverlap = overlap
    let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
    let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
    UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState], animations: { self.applyInsets() }, completion: nil)
  }

  private func applyInsets() {
    var insets = padInsets
    insets.top += keyboardOverlap
    if table.contentInset == insets { return }
    let atBottom = table.contentOffset.y <= -table.contentInset.top + 1
    table.contentInset = insets
    if atBottom { table.contentOffset = CGPoint(x: 0, y: -insets.top) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if table.frame != bounds {
      let widthChanged = table.frame.width != bounds.width
      table.frame = bounds
      if widthChanged { layouts.removeAll(); table.reloadData() }
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
    rows = next
    if layouts.count > rows.count * 2 + 200 { layouts.removeAll() }
    if sameHeights {
      for cell in table.visibleCells {
        guard let rowCell = cell as? MsgRowCell, let path = table.indexPath(for: cell), path.row < rows.count else { continue }
        rowCell.show(rows[path.row], palette, fontSize, layout(rows[path.row]))
      }
    } else {
      table.reloadData()
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

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

  func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
    indexPath.row < rows.count ? layout(rows[indexPath.row]).height : 0
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "msg", for: indexPath)
    if let rowCell = cell as? MsgRowCell, indexPath.row < rows.count {
      rowCell.show(rows[indexPath.row], palette, fontSize, layout(rows[indexPath.row]))
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
    if indexPath.row < rows.count { onMsgPress(["key": rows[indexPath.row].key]) }
  }

  @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
    if recognizer.state != .began { return }
    guard let path = table.indexPathForRow(at: recognizer.location(in: table)), path.row < rows.count, rows[path.row].kind == 0 else { return }
    onMsgLongPress(["key": rows[path.row].key, "y": Double(recognizer.location(in: nil).y)])
  }
}
