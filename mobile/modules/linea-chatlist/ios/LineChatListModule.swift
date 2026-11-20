import CoreGraphics
import ExpoModulesCore
import UIKit

// The experimental native chat list (contract in ../index.ts; the Android twin is ChatListView.kt).
// A UITableView whose every row is one view drawn in a single pass: JS hands over ready texts and colours and
// gets a row id back on a tap or a long press. Scrolling and row updates never go through React.
public final class LineChatListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LineaChatList")
    View(ChatListView.self) {
      Events("onRowPress", "onRowLongPress", "onRowAction")
      Prop("rows") { (view: ChatListView, rows: [[String: Any]]?) in view.setRows(ChatRow.parse(rows ?? [])) }
      Prop("palette") { (view: ChatListView, palette: [String: Any]?) in view.setPalette(ChatPalette(palette ?? [:])) }
      Prop("headers") { (view: ChatListView, headers: [String: String]?) in ChatAvatarStore.shared.headers = headers ?? [:] }
      Prop("plates") { (view: ChatListView, plates: [String: String]?) in view.setPlates(plates ?? [:]) }
      Prop("pad") { (view: ChatListView, pad: [Double]?) in
        let values = pad ?? []
        view.setPad(top: values.count > 0 ? values[0] : 0, bottom: values.count > 1 ? values[1] : 0)
      }
    }
  }
}

/// One line of the list, ready to draw (see NativeChatRow in ../index.ts).
struct ChatRow: Equatable {
  let id: String
  let title: String
  let preview: String
  let time: String
  let unread: Int
  let muted: Bool
  let pinned: Bool
  let accentPreview: Bool
  let ticks: Int
  let checked: Int
  let selected: Bool
  let avatarColor: Int
  let initials: String
  /// The letter avatar as a lit ball: its lighter and deeper corner colours (0 = a flat circle).
  let orbA: Int
  let orbB: Int
  /// A quiet heading drawn above this row (the first chat of a part of the list); empty = none.
  let section: String
  /// Picture avatar: where to get it and the key it is cached under; empty = the letter avatar.
  let avatarUrl: String
  let avatarKey: String
  /// A small JPEG/PNG (base64) shown before the preview text.
  let thumb: String
  let thumbRound: Bool
  /// A small grey icon before the preview text: "mic" for a voice message; empty = none.
  let previewIcon: String
  /// The first N characters (UTF-16) of the preview are drawn in the danger colour («Черновик:»).
  let previewRed: Int
  /// Swipe buttons as "action:Label", the outermost first (see rowActions in src/listSwipes.ts).
  let lead: [String]
  let trail: [String]
  /// Avatar frame: a ring of these colours (ARGB) around the photo; empty = none.
  let ring: [Int]
  /// Avatar decoration: the art's file address, drawn `decoScale` times the photo; empty = none.
  let deco: String
  let decoScale: CGFloat
  /// Nameplate behind the row: an id of ChatDecorStore.plates; empty = none.
  let plate: String
  /// A Platina name: the first `nameLen` UTF-16 units of the title are drawn in this metal (ARGB); empty = plain.
  let metal: [Int]
  let nameLen: Int

  private static func int(_ value: Any?, _ fallback: Int) -> Int { (value as? NSNumber)?.intValue ?? fallback }
  private static func flag(_ value: Any?) -> Bool { (value as? Bool) ?? false }
  private static func text(_ value: Any?) -> String { (value as? String) ?? "" }

  /// Rows without an id are dropped: a row the app cannot name cannot be tapped.
  static func parse(_ rows: [[String: Any]]) -> [ChatRow] {
    var result: [ChatRow] = []
    for row in rows {
      let id = text(row["id"])
      if id.isEmpty { continue }
      result.append(ChatRow(
        id: id, title: text(row["title"]), preview: text(row["preview"]), time: text(row["time"]),
        unread: max(0, int(row["unread"], 0)), muted: flag(row["muted"]), pinned: flag(row["pinned"]),
        accentPreview: flag(row["accentPreview"]), ticks: min(2, max(0, int(row["ticks"], 0))),
        checked: min(1, max(-1, int(row["checked"], -1))), selected: flag(row["selected"]),
        avatarColor: int(row["avatarColor"], 0xFF5E7BFF), initials: String(text(row["initials"]).prefix(2)), orbA: int(row["orbA"], 0), orbB: int(row["orbB"], 0), section: String(text(row["section"]).prefix(24)),
        avatarUrl: text(row["avatarUrl"]), avatarKey: text(row["avatarKey"]), thumb: text(row["thumb"]),
        thumbRound: flag(row["thumbRound"]), previewIcon: text(row["previewIcon"]), previewRed: max(0, int(row["previewRed"], 0)), lead: (row["lead"] as? [String]) ?? [], trail: (row["trail"] as? [String]) ?? [],
        ring: ((row["ring"] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.intValue }, deco: text(row["deco"]),
        decoScale: CGFloat(min(2, max(1, (row["decoScale"] as? NSNumber)?.doubleValue ?? 1))), plate: text(row["plate"]),
        metal: ((row["metal"] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.intValue }, nameLen: max(0, int(row["nameLen"], 0))))
    }
    return result
  }
}

/// A colour as JS sends it (processColor: 0xAARRGGBB).
private func chatColor(_ argb: Int) -> UIColor {
  let value = UInt32(truncatingIfNeeded: argb)
  return UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                 blue: CGFloat(value & 0xFF) / 255, alpha: CGFloat((value >> 24) & 0xFF) / 255)
}

struct ChatPalette: Equatable {
  var text = chatColor(0xFFF1F5FF)
  var muted = chatColor(0xFF8A97B4)
  var subtle = chatColor(0xFF6B7896)
  var accent = chatColor(0xFFA9C4FF)
  var onAccent = chatColor(0xFF0A1430)
  var border = chatColor(0x12FFFFFF)
  var pressed = chatColor(0x12FFFFFF)
  var selected = chatColor(0x1FA9C4FF)
  var badgeMuted = chatColor(0xFF34415F)
  /// The fill of a pinned row.
  var pinned = chatColor(0x0EFFFFFF)
  var danger = chatColor(0xFFFF6B6B)
  var bg = chatColor(0xFF070B16)

  init() {}
  init(_ map: [String: Any]) {
    func color(_ key: String, _ fallback: UIColor) -> UIColor {
      if let number = map[key] as? NSNumber { return chatColor(number.intValue) }
      return fallback
    }
    text = color("text", text); muted = color("muted", muted); subtle = color("subtle", subtle)
    accent = color("accent", accent); onAccent = color("onAccent", onAccent); border = color("border", border)
    pressed = color("pressed", pressed); selected = color("selected", selected); badgeMuted = color("badgeMuted", badgeMuted); pinned = color("pinned", pinned); danger = color("danger", danger)
    bg = color("bg", bg)
  }
}

private let chatRowHeight: CGFloat = 76
/// A row that opens a part of the list («Сегодня», «Вчера»…) is taller by its heading.
private let chatSectionHeight: CGFloat = 30

/// A rectangle with circular corners of exactly `radius`. UIBezierPath(roundedRect:cornerRadius:) turns the shape
/// into a capsule once the radius passes about a third of the side — the app's avatar (radius 0.36 of the side)
/// came out as a circle.
private func chatRound(_ rect: CGRect, _ radius: CGFloat) -> UIBezierPath {
  let r = max(0, min(radius, min(rect.width, rect.height) / 2))
  return UIBezierPath(cgPath: CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil))
}

/// Decorations of the native chat list. Nameplates arrive from JS as PNGs of the app's own vector art; the art of
/// an avatar decoration is one of the app's bundled pictures (a file address).
final class ChatDecorStore {
  static let shared = ChatDecorStore()
  private(set) var plates: [String: UIImage] = [:]
  private var plateSource: [String: Int] = [:]
  private var arts: [String: UIImage] = [:]
  private var missing = Set<String>()

  /// True when a plate was added or replaced (the rows are redrawn then).
  func setPlates(_ next: [String: String]) -> Bool {
    var changed = false
    for (id, value) in next {
      let mark = value.count &* 31 &+ value.hashValue
      if plateSource[id] == mark { continue }
      let base64 = value.range(of: "base64,").map { String(value[$0.upperBound...]) } ?? value
      guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), let image = UIImage(data: data) else { continue }
      plates[id] = image
      plateSource[id] = mark
      changed = true
    }
    return changed
  }

  func art(_ name: String) -> UIImage? {
    // A decoration the app drew itself (a frame made in code); until it is drawn, asked again and never cached as missing.
    if let baked = plates[name] { return baked }
    if name.hasPrefix("fx-") { return nil }
    if let hit = arts[name] { return hit }
    if missing.contains(name) { return nil }
    var image: UIImage? = nil
    if name.hasPrefix("file://"), let url = URL(string: name) { image = UIImage(contentsOfFile: url.path) }
    else if name.hasPrefix("/") { image = UIImage(contentsOfFile: name) }
    if let image = image { arts[name] = image } else { missing.insert(name) }
    return image
  }
}

/// Avatars of the native list: memory, then a file in the caches folder, then one download through URLSession
/// (certificates are checked as usual) with the app's own request headers. A failure is not retried for a minute.
final class ChatAvatarStore {
  static let shared = ChatAvatarStore()
  static let ready = Notification.Name("LineaChatAvatarReady")
  var headers: [String: String] = [:]
  private let memory = NSCache<NSString, UIImage>()
  private var loading = Set<String>()
  private var failedAt: [String: Date] = [:]
  private let folder: URL = {
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("linea-avatars", isDirectory: true)
  }()

  /// Main thread only. Nil while the picture is not here yet; `ready` is posted (object: the key) when it is.
  func image(key: String, url: String) -> UIImage? {
    if let hit = memory.object(forKey: key as NSString) { return hit }
    if loading.contains(key) { return nil }
    if let at = failedAt[key], Date().timeIntervalSince(at) < 60 { return nil }
    guard let address = URL(string: url), address.scheme == "https" || address.scheme == "http" else { return nil }
    loading.insert(key)
    let name = String(key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
    let file = folder.appendingPathComponent(name)
    let sent = headers
    let directory = folder
    DispatchQueue.global(qos: .utility).async {
      if let data = try? Data(contentsOf: file), let image = ChatAvatarStore.decode(data) {
        self.finish(key, image)
        return
      }
      var request = URLRequest(url: address, timeoutInterval: 20)
      for (field, value) in sent { request.setValue(value, forHTTPHeaderField: field) }
      URLSession.shared.dataTask(with: request) { data, response, _ in
        var image: UIImage? = nil
        if let data = data, (response as? HTTPURLResponse)?.statusCode == 200, let decoded = ChatAvatarStore.decode(data) {
          image = decoded
          try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          try? data.write(to: file, options: .atomic)
        }
        self.finish(key, image)
      }.resume()
    }
    return nil
  }

  private func finish(_ key: String, _ image: UIImage?) {
    DispatchQueue.main.async {
      self.loading.remove(key)
      if let image = image {
        self.memory.setObject(image, forKey: key as NSString)
        self.failedAt[key] = nil
      } else {
        self.failedAt[key] = Date()
      }
      NotificationCenter.default.post(name: ChatAvatarStore.ready, object: key)
    }
  }

  /// The picture scaled down to what a 60 pt avatar needs at 3x.
  static func decode(_ data: Data) -> UIImage? {
    guard let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else { return nil }
    let side: CGFloat = 180
    let scale = max(side / image.size.width, side / image.size.height)
    if scale >= 1 { return image }
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
  }
}

/// The row itself: avatar, title, time, two lines of preview, unread badge, ticks and the «Изм.» circle.
final class ChatRowCanvas: UIView {
  var row: ChatRow?
  var palette = ChatPalette()
  var pressed = false
  private var thumbOf = ""
  private var thumbImage: UIImage?

  /// `image` centre-cropped into the rounded rectangle `box`.
  private func drawPicture(_ context: CGContext, _ image: UIImage, _ box: CGRect, _ radius: CGFloat) {
    guard image.size.width > 0, image.size.height > 0 else { return }
    context.saveGState()
    chatRound(box, radius).addClip()
    let scale = max(box.width / image.size.width, box.height / image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    image.draw(in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height))
    context.restoreGState()
  }

  private static let titleFont = UIFont.systemFont(ofSize: 16, weight: .semibold)
  private static let previewFont = UIFont.systemFont(ofSize: 15)
  private static let timeFont = UIFont.systemFont(ofSize: 13)
  private static let badgeFont = UIFont.systemFont(ofSize: 12, weight: .bold)
  private static let avatarFont = UIFont.systemFont(ofSize: 21, weight: .bold)
  private static let sectionFont = UIFont.systemFont(ofSize: 11, weight: .bold)

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
  }
  required init?(coder: NSCoder) { return nil }

  private func paragraph(_ mode: NSLineBreakMode) -> NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = mode
    return style
  }

  override func draw(_ rect: CGRect) {
    guard let item = row, let context = UIGraphicsGetCurrentContext() else { return }
    let w = bounds.width
    let heading: CGFloat = item.section.isEmpty ? 0 : chatSectionHeight
    let h = bounds.height - heading
    if heading > 0 {
      NSAttributedString(string: item.section.uppercased(), attributes: [.font: ChatRowCanvas.sectionFont, .foregroundColor: palette.subtle, .kern: 1.4])
        .draw(at: CGPoint(x: 18, y: heading - 21))
      // Everything below is the row itself, drawn under the heading.
      context.translateBy(x: 0, y: heading)
    }
    // Telegram: pinned chats stand on a slightly different ground than the rest of the list.
    if item.pinned {
      context.setFillColor(palette.pinned.cgColor)
      context.fill(CGRect(x: 0, y: 0, width: w, height: h))
    }
    if item.selected || pressed {
      context.setFillColor((item.selected ? palette.selected : palette.pressed).cgColor)
      context.fill(CGRect(x: 0, y: 0, width: w, height: h))
    }

    // The nameplate: a picture behind the whole row (right-aligned, cropped to fill), darkened towards the name.
    let plate = item.plate.isEmpty ? nil : ChatDecorStore.shared.plates[item.plate]
    if let plate = plate, plate.size.width > 0, plate.size.height > 0 {
      let box = CGRect(x: 10, y: 3, width: w - 20, height: h - 6)
      context.saveGState()
      chatRound(box, 20).addClip()
      let scale = max(box.width / plate.size.width, box.height / plate.size.height)
      let size = CGSize(width: plate.size.width * scale, height: plate.size.height * scale)
      plate.draw(in: CGRect(x: box.maxX - size.width, y: box.midY - size.height / 2, width: size.width, height: size.height))
      let shade = [UIColor(white: 0, alpha: 0.62).cgColor, UIColor(white: 0, alpha: 0.32).cgColor, UIColor(white: 0, alpha: 0.05).cgColor] as CFArray
      if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: shade, locations: [0, 0.5, 1]) {
        context.drawLinearGradient(gradient, start: CGPoint(x: box.minX, y: 0), end: CGPoint(x: box.maxX, y: 0), options: [])
      }
      context.restoreGState()
      context.setStrokeColor(UIColor(white: 1, alpha: 0.16).cgColor)
      context.setLineWidth(1 / max(1, UIScreen.main.scale))
      context.addPath(chatRound(box, 20).cgPath)
      context.strokePath()
    }
    let textColor = plate != nil ? UIColor.white : palette.text
    let mutedColor = plate != nil ? UIColor(white: 1, alpha: 0.8) : palette.muted

    var x: CGFloat = 16
    if item.checked >= 0 {
      let center = CGPoint(x: x + 12, y: h / 2)
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
      x += 36
    }

    let avatar: CGFloat = 60
    // The avatar is a circle (the owner's choice, 18 Nov 2026; it was a rounded square before).
    let avatarBox = CGRect(x: x, y: (h - avatar) / 2, width: avatar, height: avatar)
    let art = item.deco.isEmpty ? nil : ChatDecorStore.shared.art(item.deco)
    // As DecoratedAvatar does at list sizes: a ring is drawn inside the box (the photo shrinks a little); under an
    // art decoration the photo is a circle, and it shrinks so the art reaches at most 1.3× the box.
    var photoBox = avatarBox
    var corner = avatar * 0.5
    if art != nil {
      let side = item.decoScale > 1.3 ? avatar * 1.3 / item.decoScale : avatar
      photoBox = CGRect(x: avatarBox.midX - side / 2, y: avatarBox.midY - side / 2, width: side, height: side)
      corner = side / 2
    } else if item.ring.count >= 2 {
      let ring: CGFloat = 3
      let gap: CGFloat = 2
      context.saveGState()
      chatRound(avatarBox, avatar * 0.5).addClip()
      let colors = item.ring.map { chatColor($0).cgColor } as CFArray
      if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: nil) {
        context.drawLinearGradient(gradient, start: CGPoint(x: avatarBox.minX, y: avatarBox.minY), end: CGPoint(x: avatarBox.maxX, y: avatarBox.maxY), options: [])
      }
      context.restoreGState()
      let inside = avatarBox.insetBy(dx: ring, dy: ring)
      context.setFillColor(palette.bg.cgColor)
      context.addPath(chatRound(inside, inside.width * 0.5).cgPath)
      context.fillPath()
      photoBox = avatarBox.insetBy(dx: ring + gap, dy: ring + gap)
      corner = photoBox.width * 0.5
    }
    let face = item.avatarUrl.isEmpty || item.avatarKey.isEmpty ? nil : ChatAvatarStore.shared.image(key: item.avatarKey, url: item.avatarUrl)
    if let face = face {
      drawPicture(context, face, photoBox, corner)
    } else {
      let round = chatRound(photoBox, corner).cgPath
      if item.orbA != 0, item.orbB != 0, let space = CGColorSpace(name: CGColorSpace.sRGB) {
        // A lit ball: the person's colour between a lighter and a deeper neighbour hue, a highlight from the top left.
        context.saveGState()
        context.addPath(round)
        context.clip()
        let body = [chatColor(item.orbA).cgColor, chatColor(item.avatarColor).cgColor, chatColor(item.orbB).cgColor] as CFArray
        let bodyStops: [CGFloat] = [0, 0.5, 1]
        if let gradient = CGGradient(colorsSpace: space, colors: body, locations: bodyStops) {
          context.drawLinearGradient(gradient, start: CGPoint(x: photoBox.minX + photoBox.width * 0.9, y: photoBox.maxY),
                                     end: CGPoint(x: photoBox.minX + photoBox.width * 0.1, y: photoBox.minY),
                                     options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
        let shine = [UIColor(white: 1, alpha: 0.42).cgColor, UIColor(white: 1, alpha: 0.06).cgColor, UIColor(white: 1, alpha: 0).cgColor] as CFArray
        let shineStops: [CGFloat] = [0, 0.38, 0.6]
        if let gradient = CGGradient(colorsSpace: space, colors: shine, locations: shineStops) {
          context.drawLinearGradient(gradient, start: CGPoint(x: photoBox.minX + photoBox.width * 0.12, y: photoBox.minY + photoBox.height * 0.02),
                                     end: CGPoint(x: photoBox.minX + photoBox.width * 0.7, y: photoBox.minY + photoBox.height * 0.8), options: [])
        }
        context.restoreGState()
      } else {
        context.setFillColor(chatColor(item.avatarColor).cgColor)
        context.addPath(round)
        context.fillPath()
      }
      let letters = NSAttributedString(string: item.initials, attributes: [.font: ChatRowCanvas.avatarFont, .foregroundColor: UIColor.white])
      let lettersSize = letters.size()
      letters.draw(at: CGPoint(x: x + (avatar - lettersSize.width) / 2, y: (h - lettersSize.height) / 2))
    }
    if let art = art {
      let side = photoBox.width * item.decoScale
      art.draw(in: CGRect(x: avatarBox.midX - side / 2, y: avatarBox.midY - side / 2, width: side, height: side))
    }
    x += avatar + 12

    let right = w - 16
    let top: CGFloat = 11
    let timeColor = item.unread > 0 && !item.muted ? palette.accent : mutedColor
    let time = NSAttributedString(string: item.time, attributes: [.font: ChatRowCanvas.timeFont, .foregroundColor: timeColor])
    let timeWidth = ceil(time.size().width)
    time.draw(at: CGPoint(x: right - timeWidth, y: top + 2))

    let badgeText = item.unread > 0 ? (item.unread > 999 ? "999+" : String(item.unread)) : ""
    let badgeColor = item.muted ? palette.text : palette.onAccent
    let badge = NSAttributedString(string: badgeText, attributes: [.font: ChatRowCanvas.badgeFont, .foregroundColor: badgeColor])
    let badgeWidth = badgeText.isEmpty ? 0 : max(22, ceil(badge.size().width) + 12)
    // Telegram: the ticks stand before the time; under the time is the unread badge or, without one, the pin.
    let tickWidth: CGFloat = item.ticks > 0 ? 22 : 0
    let markWidth: CGFloat = badgeText.isEmpty && item.pinned ? 20 : badgeWidth

    let title = NSAttributedString(string: item.title, attributes: [
      .font: ChatRowCanvas.titleFont, .foregroundColor: textColor, .paragraphStyle: paragraph(.byTruncatingTail)])
    let titleRoom = max(0, right - x - timeWidth - 8 - tickWidth)
    let whole = item.title as NSString
    if item.metal.count >= 2, item.nameLen > 0, item.nameLen <= whole.length, titleRoom > 1 {
      // A Platina name: the letters of the name show polished metal, the rest of the line stays plain.
      let name = NSAttributedString(string: whole.substring(to: item.nameLen), attributes: [
        .font: ChatRowCanvas.titleFont, .foregroundColor: UIColor.white, .paragraphStyle: paragraph(.byTruncatingTail)])
      let nameWidth = min(titleRoom, ceil(name.size().width))
      let size = CGSize(width: nameWidth, height: 21)
      let colors = item.metal.map { chatColor($0).cgColor } as CFArray
      // The letters as a picture first, then the metal kept only where they are. The blend mode has to be given to
      // UIImage.draw: text drawing ignores the mode set on the context (seen on a device: a solid metal bar).
      let letters = UIGraphicsImageRenderer(size: size).image { _ in
        name.draw(with: CGRect(origin: .zero, size: size), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
      }
      let picture = UIGraphicsImageRenderer(size: size).image { renderer in
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: nil) {
          renderer.cgContext.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 6), end: CGPoint(x: nameWidth, y: 15), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
        letters.draw(at: .zero, blendMode: .destinationIn, alpha: 1)
      }
      picture.draw(at: CGPoint(x: x, y: top))
      if item.nameLen < whole.length, titleRoom - nameWidth > 8 {
        let rest = NSAttributedString(string: whole.substring(from: item.nameLen), attributes: [
          .font: ChatRowCanvas.titleFont, .foregroundColor: textColor, .paragraphStyle: paragraph(.byTruncatingTail)])
        rest.draw(with: CGRect(x: x + nameWidth, y: top, width: titleRoom - nameWidth, height: 21),
                  options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
      }
    } else {
      title.draw(with: CGRect(x: x, y: top, width: titleRoom, height: 21),
                 options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
    }

    let previewColor = item.accentPreview ? palette.accent : mutedColor
    let preview = NSMutableAttributedString(string: item.preview, attributes: [
      .font: ChatRowCanvas.previewFont, .foregroundColor: previewColor, .paragraphStyle: paragraph(.byWordWrapping)])
    // Telegram: the word «Черновик:» of a draft is red.
    if item.previewRed > 0 {
      preview.addAttribute(.foregroundColor, value: palette.danger, range: NSRange(location: 0, length: min(item.previewRed, preview.length)))
    }
    if item.thumb != thumbOf {
      thumbOf = item.thumb
      thumbImage = item.thumb.isEmpty ? nil : Data(base64Encoded: item.thumb, options: .ignoreUnknownCharacters).flatMap { UIImage(data: $0) }
    }
    var thumbRoom: CGFloat = 0
    if let small = thumbImage {
      drawPicture(context, small, CGRect(x: x, y: top + 23, width: 20, height: 20), item.thumbRound ? 10 : 4)
      thumbRoom = 26
    } else if item.previewIcon == "mic", let mic = UIImage(systemName: "mic.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .regular))?
                .withTintColor(palette.subtle, renderingMode: .alwaysOriginal) {
      // Telegram: a voice message is a grey microphone before its name.
      mic.draw(at: CGPoint(x: x + 1, y: top + 22 + (ChatRowCanvas.previewFont.lineHeight - mic.size.height) / 2))
      thumbRoom = ceil(mic.size.width) + 7
    }
    let previewWidth = max(0, right - x - thumbRoom - (markWidth > 0 ? markWidth + 8 : 0))
    preview.draw(with: CGRect(x: x + thumbRoom, y: top + 22, width: previewWidth, height: 38),
                 options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)

    let markY = top + 22 + 11
    if !badgeText.isEmpty {
      let box = CGRect(x: right - badgeWidth, y: markY - 11, width: badgeWidth, height: 22)
      context.setFillColor((item.muted ? palette.badgeMuted : palette.accent).cgColor)
      context.addPath(chatRound(box, 11).cgPath)
      context.fillPath()
      let size = badge.size()
      badge.draw(at: CGPoint(x: box.midX - size.width / 2, y: box.midY - size.height / 2))
    } else if item.pinned, let pin = UIImage(systemName: "pin.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .regular))?
                .withTintColor(palette.subtle, renderingMode: .alwaysOriginal) {
      pin.draw(at: CGPoint(x: right - pin.size.width - 1, y: markY - pin.size.height / 2))
    }
    if item.ticks > 0 {
      let tickY = top + 12
      context.setStrokeColor((item.ticks == 2 ? palette.accent : palette.muted).cgColor)
      context.setLineWidth(1.7)
      context.setLineCap(.round)
      context.setLineJoin(.round)
      let bx = right - timeWidth - 6 - 16
      context.move(to: CGPoint(x: bx, y: tickY))
      context.addLine(to: CGPoint(x: bx + 4, y: tickY + 4))
      context.addLine(to: CGPoint(x: bx + 12, y: tickY - 5))
      if item.ticks == 2 {
        context.move(to: CGPoint(x: bx + 6, y: tickY + 2))
        context.addLine(to: CGPoint(x: bx + 8, y: tickY + 4))
        context.addLine(to: CGPoint(x: bx + 16, y: tickY - 5))
      }
      context.strokePath()
    }

    let line = 1 / max(1, UIScreen.main.scale)
    context.setFillColor(palette.border.cgColor)
    context.fill(CGRect(x: x, y: h - line, width: w - x, height: line))
  }
}

final class ChatRowCell: UITableViewCell {
  let canvas = ChatRowCanvas(frame: .zero)

  override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
    super.init(style: style, reuseIdentifier: reuseIdentifier)
    backgroundColor = .clear
    contentView.backgroundColor = .clear
    selectionStyle = .none
    canvas.frame = contentView.bounds
    canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    contentView.addSubview(canvas)
  }
  required init?(coder: NSCoder) { return nil }

  func show(_ row: ChatRow, _ palette: ChatPalette) {
    if canvas.row == row && canvas.palette == palette { return }
    canvas.row = row
    canvas.palette = palette
    accessibilityLabel = row.title + ". " + row.preview
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

final class ChatListView: ExpoView, UITableViewDataSource, UITableViewDelegate {
  let onRowPress = EventDispatcher()
  let onRowLongPress = EventDispatcher()
  let onRowAction = EventDispatcher()

  private let table = UITableView(frame: .zero, style: .plain)
  private var rows: [ChatRow] = []
  private var palette = ChatPalette()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    table.backgroundColor = .clear
    table.separatorStyle = .none
    table.rowHeight = chatRowHeight
    table.estimatedRowHeight = chatRowHeight
    table.showsVerticalScrollIndicator = false
    table.contentInsetAdjustmentBehavior = .never
    table.keyboardDismissMode = .onDrag
    table.register(ChatRowCell.self, forCellReuseIdentifier: "row")
    table.dataSource = self
    table.delegate = self
    if #available(iOS 15.0, *) { table.sectionHeaderTopPadding = 0 }
    table.frame = bounds
    addSubview(table)
    let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
    hold.minimumPressDuration = 0.45
    table.addGestureRecognizer(hold)
    NotificationCenter.default.addObserver(self, selector: #selector(avatarReady(_:)), name: ChatAvatarStore.ready, object: nil)
  }

  deinit { NotificationCenter.default.removeObserver(self) }

  @objc private func avatarReady(_ note: Notification) {
    guard let key = note.object as? String else { return }
    for cell in table.visibleCells {
      if let rowCell = cell as? ChatRowCell, rowCell.canvas.row?.avatarKey == key { rowCell.canvas.setNeedsDisplay() }
    }
  }

  /// Swipe buttons from "action:Label" strings; a full swipe performs the first one (as in Telegram).
  private func swipe(_ specs: [String], _ id: String) -> UISwipeActionsConfiguration? {
    if specs.isEmpty { return UISwipeActionsConfiguration(actions: []) }
    var actions: [UIContextualAction] = []
    for spec in specs {
      let parts = spec.split(separator: ":", maxSplits: 1).map(String.init)
      guard let name = parts.first, !name.isEmpty else { continue }
      let action = UIContextualAction(style: name == "delete" ? .destructive : .normal, title: parts.count > 1 ? parts[1] : name) { [weak self] _, _, done in
        self?.onRowAction(["id": id, "action": name])
        done(true)
      }
      if name != "delete" { action.backgroundColor = name == "archive" || name == "unarchive" ? .systemGray : (name == "mute" || name == "unmute" ? .systemOrange : .systemBlue) }
      actions.append(action)
    }
    let configuration = UISwipeActionsConfiguration(actions: actions)
    configuration.performsFirstActionWithFullSwipe = true
    return configuration
  }

  func tableView(_ tableView: UITableView, leadingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard indexPath.row < rows.count else { return nil }
    return swipe(rows[indexPath.row].lead, rows[indexPath.row].id)
  }

  func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard indexPath.row < rows.count else { return nil }
    return swipe(rows[indexPath.row].trail, rows[indexPath.row].id)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if table.frame != bounds { table.frame = bounds }
  }

  func setRows(_ next: [ChatRow]) {
    if next == rows { return }
    let sameOrder = next.count == rows.count && zip(next, rows).allSatisfy { $0.id == $1.id }
    rows = next
    if !sameOrder { table.reloadData(); return }
    // Same chats in the same order: only the rows on screen that changed are redrawn, the scroll stays where it is.
    for cell in table.visibleCells {
      guard let rowCell = cell as? ChatRowCell, let path = table.indexPath(for: cell), path.row < rows.count else { continue }
      rowCell.show(rows[path.row], palette)
    }
  }

  func setPalette(_ next: ChatPalette) {
    if next == palette { return }
    palette = next
    table.reloadData()
  }

  func setPlates(_ plates: [String: String]) {
    if ChatDecorStore.shared.setPlates(plates) { table.reloadData() }
  }

  func setPad(top: Double, bottom: Double) {
    let insets = UIEdgeInsets(top: CGFloat(top), left: 0, bottom: CGFloat(bottom), right: 0)
    if table.contentInset == insets { return }
    let atTop = table.contentOffset.y <= -table.contentInset.top + 1
    table.contentInset = insets
    table.verticalScrollIndicatorInsets = insets
    if atTop { table.contentOffset = CGPoint(x: 0, y: -insets.top) }
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

  func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
    indexPath.row < rows.count && !rows[indexPath.row].section.isEmpty ? chatRowHeight + chatSectionHeight : chatRowHeight
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
    if let rowCell = cell as? ChatRowCell, indexPath.row < rows.count { rowCell.show(rows[indexPath.row], palette) }
    return cell
  }

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: false)
    if indexPath.row < rows.count { onRowPress(["id": rows[indexPath.row].id]) }
  }

  @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
    if recognizer.state != .began { return }
    let point = recognizer.location(in: table)
    guard let path = table.indexPathForRow(at: point), path.row < rows.count else { return }
    onRowLongPress(["id": rows[path.row].id, "y": Double(recognizer.location(in: nil).y)])
  }
}
