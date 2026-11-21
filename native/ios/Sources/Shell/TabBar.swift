import QuartzCore
import Symbols
import UIKit

/// The phone's tab bar, drawn and driven by UIKit alone.
/// - The bar is the system's own glass (iOS 26: UIGlassEffect, clear and interactive; before: a thin blur).
/// - The chosen tab stands on a light capsule; choosing another tab sends the capsule there with a spring and a
///   faint second capsule follows a little late and fades — the trail.
/// - A light lives in the bar: two quiet colours at the sides, a brighter one under the chosen tab; with a
///   track playing, the three colours of its cover.
/// - The first tab also holds the other sections: hold it (or move the finger up from it) and their list appears
///   above the bar; the row under the finger is lit, letting go on a row opens it. A plain hold leaves the list
///   open: a tap on a row opens it, a tap beside closes the list.
/// The owner gives the items and the open section and hears `onSelect` / `onPreview`.
struct TabEntry: Equatable {
  let id: String
  let label: String
  let symbol: String
  let badge: Int
  let dot: String

  static func parse(_ raw: [[String: Any]]) -> [TabEntry] {
    return raw.compactMap { item in
      guard let id = item["id"] as? String, !id.isEmpty else { return nil }
      let badge = (item["badge"] as? NSNumber)?.intValue ?? 0
      return TabEntry(id: id, label: item["label"] as? String ?? "", symbol: item["symbol"] as? String ?? "circle", badge: max(0, badge), dot: item["dot"] as? String ?? "")
    }
  }
}

private func tabColor(_ hex: String) -> UIColor? {
  var text = hex.trimmingCharacters(in: .whitespaces)
  if text.hasPrefix("#") { text.removeFirst() }
  guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
  return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
}

// ChatsPlus: the reference's badgeText — exact up to 999, then «4,3K» (Sources/ChatsPlus/ChatListStatus.swift).
private func badgeWords(_ count: Int) -> String { return ChatListStatus.badgeText(count) }

/// ChatsPlus: each icon's own little motion on a tap (TabBar.tsx `TabIcon`): the gear turns once (760 ms, out-back
/// 1.7), the chat bubble hops (650 ms, out-quad: up 4 pt and 22 % larger at the top), any other icon wobbles.
private func tabKick(_ view: UIView, id: String) {
  guard !UIAccessibility.isReduceMotionEnabled else { return }
  let steps = 30
  var values: [NSValue] = []
  let gear = id == "profile"
  for step in 0...steps {
    let t = CGFloat(step) / CGFloat(steps)
    var transform = CATransform3DIdentity
    if gear {
      let s: CGFloat = 1.7, u = 1 - t
      let k = 1 - u * u * ((s + 1) * u - s)
      transform = CATransform3DMakeRotation(k * 2 * .pi, 0, 0, 1)
    } else {
      let k = 1 - (1 - t) * (1 - t)
      let bump = sin(k * .pi)
      if id == "chats" {
        transform = CATransform3DMakeTranslation(0, -bump * 4, 0)
        transform = CATransform3DScale(transform, 1 + bump * 0.22, 1 + bump * 0.22, 1)
      } else {
        transform = CATransform3DMakeRotation(sin(k * .pi * 2) * 18 * .pi / 180, 0, 0, 1)
        transform = CATransform3DScale(transform, 1 + bump * 0.3, 1 + bump * 0.3, 1)
      }
    }
    values.append(NSValue(caTransform3D: transform))
  }
  let kick = CAKeyframeAnimation(keyPath: "transform")
  kick.values = values
  kick.duration = gear ? 0.76 : 0.65
  kick.calculationMode = .linear
  view.layer.add(kick, forKey: "kick")
}

private let badgeRed = UIColor(red: 1, green: 0.30, blue: 0.37, alpha: 1)

/// The same colour with its saturation and brightness scaled.
private func tabTone(_ color: UIColor, saturation: CGFloat, brightness: CGFloat) -> UIColor {
  var hue: CGFloat = 0, sat: CGFloat = 0, bri: CGFloat = 0, alpha: CGFloat = 0
  guard color.getHue(&hue, saturation: &sat, brightness: &bri, alpha: &alpha) else { return color }
  return UIColor(hue: hue, saturation: sat * saturation, brightness: min(1, bri * brightness), alpha: alpha)
}

/// A small tile of random grey, made once, for the grain over the glow.
private let tabNoise: UIImage = {
  let side = 96
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = true
  return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
    for y in 0..<side {
      for x in 0..<side {
        UIColor(white: CGFloat(UInt8.random(in: 0...255)) / 255, alpha: 1).setFill()
        context.fill(CGRect(x: x, y: y, width: 1, height: 1))
      }
    }
  }
}()

/// One icon of the bar; an accessibility element of its own.
private final class TabIconView: UIView {
  let image = UIImageView()
  let badge = UILabel()
  let dot = UIView()
  var onActivate: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    image.contentMode = .center
    addSubview(image)
    badge.font = UIFont.systemFont(ofSize: 10, weight: .heavy)
    badge.textColor = .white
    badge.textAlignment = .center
    badge.backgroundColor = badgeRed
    badge.layer.masksToBounds = true
    badge.isHidden = true
    addSubview(badge)
    dot.layer.cornerRadius = 4
    dot.isHidden = true
    addSubview(dot)
    isAccessibilityElement = true
  }

  required init?(coder: NSCoder) { return nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    image.frame = bounds
    let size = badge.sizeThatFits(CGSize(width: 60, height: 18))
    let width = max(18, size.width + 10)
    badge.frame = CGRect(x: bounds.midX + 4, y: bounds.midY - 22, width: width, height: 18)
    badge.layer.cornerRadius = 9
    dot.frame = CGRect(x: bounds.midX + 9, y: bounds.midY - 17, width: 8, height: 8)
  }

  override func accessibilityActivate() -> Bool {
    onActivate?()
    return true
  }
}

/// The list of the sections that have no icon in the bar. Lives in the window, above everything.
private final class TabListOverlay: UIView {
  static let rowHeight: CGFloat = 44
  static let width: CGFloat = 216

  private let panel = UIVisualEffectView(effect: nil)
  private var rows: [(entry: TabEntry, view: UIView, icon: UIImageView, label: UILabel, badge: UILabel)] = []
  private var dark = true
  var onPick: ((TabEntry) -> Void)?
  var onClose: (() -> Void)?
  private(set) var lit: String = ""

  init(entries: [TabEntry], dark: Bool) {
    super.init(frame: .zero)
    self.dark = dark
    overrideUserInterfaceStyle = dark ? .dark : .light
    panel.clipsToBounds = true
    panel.layer.cornerRadius = 24
    panel.layer.cornerCurve = .continuous
    addSubview(panel)
    for entry in entries {
      let view = UIView()
      view.layer.cornerRadius = 16
      view.layer.cornerCurve = .continuous
      let icon = UIImageView()
      icon.contentMode = .center
      let label = UILabel()
      label.text = entry.label
      label.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
      let badge = UILabel()
      badge.font = UIFont.systemFont(ofSize: 11, weight: .heavy)
      badge.textColor = .white
      badge.textAlignment = .center
      badge.backgroundColor = badgeRed
      badge.layer.masksToBounds = true
      badge.layer.cornerRadius = 10
      badge.text = entry.badge > 0 ? badgeWords(entry.badge) : ""
      badge.isHidden = entry.badge <= 0
      view.addSubview(icon); view.addSubview(label); view.addSubview(badge)
      view.isAccessibilityElement = true
      view.accessibilityLabel = entry.badge > 0 ? "\(entry.label), \(entry.badge)" : entry.label
      view.accessibilityTraits = .button
      panel.contentView.addSubview(view)
      rows.append((entry, view, icon, label, badge))
    }
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
    accessibilityViewIsModal = true
    paint()
  }

  required init?(coder: NSCoder) { return nil }

  /// The panel stands above `anchor` (the bar, in this view's coordinates), centred on it.
  func place(above anchor: CGRect) {
    let height = CGFloat(rows.count) * TabListOverlay.rowHeight + 12
    let x = min(max(8, anchor.midX - TabListOverlay.width / 2), max(8, bounds.width - TabListOverlay.width - 8))
    panel.frame = CGRect(x: x, y: anchor.minY - 12 - height, width: TabListOverlay.width, height: height)
    if panel.effect == nil { panel.effect = TabGlass.effect(clear: false, interactive: false, dark: dark) }
    for (index, row) in rows.enumerated() {
      row.view.frame = CGRect(x: 6, y: 6 + CGFloat(index) * TabListOverlay.rowHeight, width: TabListOverlay.width - 12, height: TabListOverlay.rowHeight)
      row.icon.frame = CGRect(x: 10, y: 0, width: 28, height: TabListOverlay.rowHeight)
      let badgeWidth: CGFloat = row.badge.isHidden ? 0 : max(20, row.badge.sizeThatFits(CGSize(width: 60, height: 20)).width + 12)
      row.badge.frame = CGRect(x: row.view.bounds.width - 10 - badgeWidth, y: (TabListOverlay.rowHeight - 20) / 2, width: badgeWidth, height: 20)
      row.label.frame = CGRect(x: 48, y: 0, width: row.view.bounds.width - 48 - badgeWidth - 16, height: TabListOverlay.rowHeight)
    }
  }

  /// The entry whose row is under `point` (this view's coordinates), with a little room at the sides.
  func entry(at point: CGPoint) -> TabEntry? {
    let inPanel = convert(point, to: panel.contentView)
    for row in rows where row.view.frame.insetBy(dx: -40, dy: 0).contains(inPanel) { return row.entry }
    return nil
  }

  func light(_ id: String) {
    if id == lit { return }
    lit = id
    paint()
  }

  private func paint() {
    let ink: UIColor = dark ? .white : .black
    let config = UIImage.SymbolConfiguration(pointSize: 18, weight: .medium)
    for row in rows {
      let on = row.entry.id == lit
      row.view.backgroundColor = on ? ink.withAlphaComponent(dark ? 0.14 : 0.08) : .clear
      row.icon.image = UIImage(systemName: row.entry.symbol, withConfiguration: config)
      row.icon.tintColor = ink.withAlphaComponent(on ? 1 : 0.62)
      row.label.textColor = ink.withAlphaComponent(on ? 1 : 0.72)
    }
  }

  @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
    if let entry = entry(at: recognizer.location(in: self)) { onPick?(entry) } else { onClose?() }
  }

  override func accessibilityPerformEscape() -> Bool {
    onClose?()
    return true
  }
}

/// The system's glass where it exists, a thin blur where it does not.
enum TabGlass {
  static func effect(clear: Bool, interactive: Bool, dark: Bool) -> UIVisualEffect {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      let glass = UIGlassEffect(style: clear ? .clear : .regular)
      glass.isInteractive = interactive
      return glass
    }
    #endif
    return UIBlurEffect(style: dark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight)
  }
}

final class TabBarView: UIView, UIGestureRecognizerDelegate {
  var onSelect: ([String: Any]) -> Void = { _ in }
  var onPreview: ([String: Any]) -> Void = { _ in }
  var moreWords = ""
  /// ChatsPlus: the list of the other sections was opened (the hold has been learnt: the hint above the bar goes).
  var onListOpened: () -> Void = {}

  private let glass = UIVisualEffectView(effect: nil)
  private let glowView = UIView()
  private let glowLeft = CAGradientLayer()
  private let glowRight = CAGradientLayer()
  private let spotView = UIView()
  private let spot = CAGradientLayer()
  private let trail = UIView()
  private let capsule = UIView()
  private let capsuleRim = CALayer()
  /// Light along the bar's upper edge above the chosen tab (rides in `spotView`).
  private let sheen = CAGradientLayer()
  /// Light on the upper half of the chosen capsule.
  private let gloss = CAGradientLayer()
  /// Fine grain over the glow, so a gradient reads as material rather than as a smooth fill.
  private let grain = UIView()
  /// Which glow look is on: 6, chosen by the owner (a small round glow behind the chosen icon). Others stay for comparison (`-barlook N` in the simulator).
  var look = 6 {
    didSet {
      // 6…8: a halo centred on the chosen icon (6, 7) or just below it (8), instead of light rising from the edge.
      let halo = look >= 6
      spot.startPoint = halo ? CGPoint(x: 0.5, y: 0.5) : CGPoint(x: 0.5, y: 1)
      spot.endPoint = halo ? CGPoint(x: 1, y: 1) : CGPoint(x: 1, y: 0)
      laidOut = .zero; setNeedsLayout(); paintGlow(animated: false)
    }
  }
  private var icons: [TabIconView] = []

  private var items: [TabEntry] = []
  private var bar: [String] = []
  private var active = ""
  private var dark = true
  private var glow: [UIColor] = []
  private var laidOut = CGSize.zero
  private var glassDark: Bool?

  // The touch in progress.
  private var startPoint = CGPoint.zero
  private var startIndex = -1
  private var movedFar = false
  private var holdTimer: Timer?
  private var previewTimer: Timer?
  private var overlay: TabListOverlay?
  private var overlaySticky = false
  private var previewed = ""
  private let tick = UISelectionFeedbackGenerator()

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = false
    glass.clipsToBounds = true
    addSubview(glass)
    glowView.isUserInteractionEnabled = false
    glowView.clipsToBounds = true
    for layer in [glowLeft, glowRight, spot] {
      layer.type = .radial
      layer.startPoint = CGPoint(x: 0.5, y: 1)
      layer.endPoint = CGPoint(x: 1, y: 0)
    }
    // The owner's choice (look 6): a small round glow right behind the chosen icon.
    let halo = look >= 6
    spot.startPoint = halo ? CGPoint(x: 0.5, y: 0.5) : CGPoint(x: 0.5, y: 1)
    spot.endPoint = halo ? CGPoint(x: 1, y: 1) : CGPoint(x: 1, y: 0)
    glowView.layer.addSublayer(glowLeft)
    glowView.layer.addSublayer(glowRight)
    spotView.isUserInteractionEnabled = false
    spotView.layer.addSublayer(spot)
    sheen.startPoint = CGPoint(x: 0, y: 0.5)
    sheen.endPoint = CGPoint(x: 1, y: 0.5)
    spotView.layer.addSublayer(sheen)
    glowView.addSubview(spotView)
    grain.isUserInteractionEnabled = false
    grain.backgroundColor = UIColor(patternImage: tabNoise)
    grain.layer.compositingFilter = "overlayBlendMode"
    grain.alpha = 0
    glowView.addSubview(grain)
    glass.contentView.addSubview(glowView)
    trail.isUserInteractionEnabled = false
    trail.alpha = 0
    glass.contentView.addSubview(trail)
    capsule.isUserInteractionEnabled = false
    gloss.startPoint = CGPoint(x: 0.5, y: 0)
    gloss.endPoint = CGPoint(x: 0.5, y: 0.55)
    capsule.layer.addSublayer(gloss)
    capsule.layer.addSublayer(capsuleRim)
    glass.contentView.addSubview(capsule)

    let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
    press.minimumPressDuration = 0
    press.allowableMovement = 10_000
    press.delegate = self
    addGestureRecognizer(press)
    paintChrome()
  }

  required init?(coder: NSCoder) { return nil }

  deinit {
    holdTimer?.invalidate()
    previewTimer?.invalidate()
    overlay?.removeFromSuperview()
  }

  // MARK: Props

  func setItems(_ next: [TabEntry]) {
    if next == items { return }
    items = next
    rebuildIcons()
  }

  func setBar(_ next: [String]) {
    if next == bar { return }
    bar = next
    rebuildIcons()
  }

  func setActive(_ id: String) {
    if id == active { return }
    let before = activeIndex
    active = id
    paintIcons()
    moveCapsule(from: before, animated: laidOut != .zero)
  }

  func setDark(_ next: Bool) {
    if next == dark { return }
    dark = next
    paintChrome()
    paintIcons()
    setNeedsLayout()
  }

  /// Three colours of the playing track's cover (centre, left, right) as `#RRGGBB`; none = the calm silver.
  func setGlow(_ hexes: [String]) {
    let next = hexes.compactMap { tabColor($0) }
    if next == glow { return }
    glow = next
    paintGlow(animated: laidOut != .zero)
  }

  // MARK: Layout

  private var activeIndex: Int { return bar.firstIndex(of: active) ?? -1 }
  private var cell: CGFloat { return bar.isEmpty ? 0 : bounds.width / CGFloat(bar.count) }
  private func capsuleFrame(_ index: Int) -> CGRect {
    let slot = max(0, index)
    return CGRect(x: CGFloat(slot) * cell, y: 0, width: cell, height: bounds.height).insetBy(dx: 4, dy: 4)
  }
  private func spotFrame(_ index: Int) -> CGRect {
    let centre = index < 0 ? bounds.midX : (CGFloat(index) + 0.5) * cell
    switch look {
    case 6:
      let side = bounds.height * 0.95
      return CGRect(x: centre - side / 2, y: bounds.midY - side / 2, width: side, height: side)
    case 7:
      let width = cell * 0.95, height = bounds.height * 1.1
      return CGRect(x: centre - width / 2, y: bounds.midY - height / 2, width: width, height: height)
    case 8:
      let width = cell * 0.9, height = bounds.height * 0.9
      return CGRect(x: centre - width / 2, y: bounds.height * 0.8 - height / 2, width: width, height: height)
    default: break
    }
    let width = (look == 1 || look == 3) ? max(90, cell * 1.1) : max(110, bounds.width * 0.7)
    return CGRect(x: centre - width / 2, y: 0, width: width, height: bounds.height)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0, bounds.height > 0 else { return }
    let radius = bounds.height / 2
    glass.frame = bounds
    if glass.effect == nil || glassDark != dark {
      // The glass effect is made here, once the view has a size (an effect made earlier does not draw).
      glass.effect = TabGlass.effect(clear: true, interactive: true, dark: dark)
      glassDark = dark
    }
    glass.layer.cornerRadius = radius
    glass.layer.cornerCurve = .continuous
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      let corner = UICornerRadius(floatLiteral: Double(radius))
      glass.cornerConfiguration = .corners(topLeftRadius: corner, topRightRadius: corner, bottomLeftRadius: corner, bottomRightRadius: corner)
    }
    #endif
    if bounds.size == laidOut { return }
    laidOut = bounds.size

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    glowView.frame = bounds
    glowView.layer.cornerRadius = radius
    glowLeft.frame = CGRect(x: -bounds.width * 0.16, y: 0, width: bounds.width * 0.72, height: bounds.height)
    glowRight.frame = CGRect(x: bounds.width * 0.46, y: 0, width: bounds.width * 0.72, height: bounds.height)
    spotView.frame = spotFrame(activeIndex)
    spot.frame = spotView.bounds
    sheen.frame = CGRect(x: spotView.bounds.width * 0.18, y: 0.5, width: spotView.bounds.width * 0.64, height: 1.2)
    grain.frame = bounds
    capsule.frame = capsuleFrame(activeIndex)
    capsule.alpha = activeIndex < 0 ? 0 : 1
    trail.frame = capsule.frame
    shapeCapsules()
    CATransaction.commit()
    for (index, icon) in icons.enumerated() {
      icon.frame = CGRect(x: CGFloat(index) * cell, y: 0, width: cell, height: bounds.height)
    }
    paintGlow(animated: false)
  }

  private func shapeCapsules() {
    let radius = capsule.bounds.height / 2
    for view in [capsule, trail] {
      view.layer.cornerRadius = radius
      view.layer.cornerCurve = .continuous
    }
    capsuleRim.frame = capsule.bounds
    gloss.frame = capsule.bounds
    gloss.cornerRadius = radius
    gloss.cornerCurve = .continuous
    capsuleRim.cornerRadius = radius
    capsuleRim.cornerCurve = .continuous
  }

  // MARK: Looks

  private func paintChrome() {
    overrideUserInterfaceStyle = dark ? .dark : .light
    let ink: UIColor = dark ? .white : .black
    capsule.backgroundColor = ink.withAlphaComponent(dark ? 0.14 : 0.07)
    capsuleRim.borderWidth = 1
    capsuleRim.borderColor = (dark ? UIColor.white.withAlphaComponent(0.22) : UIColor.white.withAlphaComponent(0.8)).cgColor
    trail.backgroundColor = ink.withAlphaComponent(dark ? 0.16 : 0.08)
    paintGlow(animated: false)
  }

  private func paintGlow(animated: Bool) {
    // Calm: a cool silver. With colours (a track's cover): centre, left, right.
    let calm: [UIColor] = dark
      ? [UIColor(red: 0.91, green: 0.93, blue: 0.96, alpha: 1), UIColor(red: 0.50, green: 0.56, blue: 0.66, alpha: 1), UIColor(red: 0.79, green: 0.82, blue: 0.88, alpha: 1)]
      : [UIColor(red: 0.56, green: 0.60, blue: 0.68, alpha: 1), UIColor(red: 0.71, green: 0.74, blue: 0.80, alpha: 1), UIColor(red: 0.60, green: 0.65, blue: 0.72, alpha: 1)]
    let coloured = glow.count == 3
    let colors = coloured ? glow : calm
    let strength: CGFloat = coloured ? 1 : (dark ? 0.7 : 0.45)
    CATransaction.begin()
    CATransaction.setAnimationDuration(animated ? 0.5 : 0)
    if !animated { CATransaction.setDisableActions(true) }
    var spotColor = colors[0], leftColor = colors[1], rightColor = colors[2], sheenColor = UIColor.white
    var spotAlpha: CGFloat = 0.8 * strength, sideAlpha: CGFloat = 0.6 * strength
    var sheenAlpha: CGFloat = 0, glossAlpha: CGFloat = 0, grainAlpha: CGFloat = 0
    switch look {
    case 1: // a soft spot under the chosen tab only
      spotAlpha *= 0.45; sideAlpha = 0
    case 2: // chrome: no hue of its own, light on the capsule and along the edge
      spotColor = coloured ? tabTone(colors[0], saturation: 0.3, brightness: 1.1) : UIColor(white: 0.92, alpha: 1)
      spotAlpha = 0.38; sideAlpha = 0; glossAlpha = 0.22; sheenAlpha = 0.35
    case 3: // one quiet colour under the chosen tab, with grain
      spotColor = coloured ? tabTone(colors[0], saturation: 0.55, brightness: 1) : UIColor(white: 0.85, alpha: 1)
      spotAlpha = 0.55; sideAlpha = 0; grainAlpha = 0.09
    case 4: // light along the upper edge only
      sheenColor = coloured ? tabTone(colors[0], saturation: 0.5, brightness: 1.2) : .white
      sheenAlpha = 0.75; spotColor = sheenColor; spotAlpha = 0.16; sideAlpha = 0
    case 5: // depth: the colours darkened and muted, spread wide, with grain
      leftColor = tabTone(colors[1], saturation: 0.6, brightness: 0.55)
      rightColor = tabTone(colors[2], saturation: 0.6, brightness: 0.55)
      spotColor = tabTone(colors[0], saturation: 0.6, brightness: 0.8)
      sideAlpha = 0.55; spotAlpha = 0.35; grainAlpha = 0.08
    case 6, 7, 8: // a halo at the chosen icon; a track's colour softened a little
      spotColor = coloured ? tabTone(colors[0], saturation: 0.8, brightness: 1) : colors[0]
      spotAlpha = (look == 6 ? 0.55 : (look == 7 ? 0.45 : 0.5)) * strength; sideAlpha = 0
    default: break
    }
    spot.colors = [spotColor.withAlphaComponent(spotAlpha).cgColor, spotColor.withAlphaComponent(0).cgColor]
    glowLeft.colors = [leftColor.withAlphaComponent(sideAlpha).cgColor, leftColor.withAlphaComponent(0).cgColor]
    glowRight.colors = [rightColor.withAlphaComponent(sideAlpha).cgColor, rightColor.withAlphaComponent(0).cgColor]
    sheen.colors = [sheenColor.withAlphaComponent(0).cgColor, sheenColor.withAlphaComponent(sheenAlpha).cgColor, sheenColor.withAlphaComponent(0).cgColor]
    gloss.colors = [UIColor.white.withAlphaComponent(glossAlpha).cgColor, UIColor.white.withAlphaComponent(0).cgColor]
    grain.alpha = grainAlpha
    CATransaction.commit()
  }

  private func rebuildIcons() {
    icons.forEach { $0.removeFromSuperview() }
    icons = bar.enumerated().map { index, _ in
      let icon = TabIconView()
      icon.onActivate = { [weak self] in self?.choose(index) }
      glass.contentView.addSubview(icon)
      return icon
    }
    laidOut = .zero
    paintIcons()
    setNeedsLayout()
  }

  private func entry(_ id: String) -> TabEntry? { return items.first { $0.id == id } }
  private var others: [TabEntry] { return items.filter { !bar.contains($0.id) } }

  private func paintIcons() {
    let ink: UIColor = dark ? .white : .black
    let config = UIImage.SymbolConfiguration(pointSize: 23, weight: .medium)
    let waiting = others.reduce(0) { $0 + $1.badge }
    let awake = others.first { !$0.dot.isEmpty }?.dot ?? ""
    for (index, icon) in icons.enumerated() where index < bar.count {
      guard let item = entry(bar[index]) else { continue }
      let on = item.id == active
      // The filled drawing for the chosen tab where the symbol has one.
      let filled = UIImage(systemName: item.symbol + ".fill", withConfiguration: config)
      icon.image.image = on ? (filled ?? UIImage(systemName: item.symbol, withConfiguration: config)) : UIImage(systemName: item.symbol, withConfiguration: config)
      icon.image.tintColor = ink.withAlphaComponent(on ? 1 : 0.58)
      // The first tab also carries what waits in the sections without an icon.
      let count = item.badge + (index == 0 ? waiting : 0)
      icon.badge.text = count > 0 ? badgeWords(count) : ""
      icon.badge.isHidden = count <= 0
      let dot = count > 0 ? "" : (item.dot.isEmpty && index == 0 ? awake : item.dot)
      icon.dot.isHidden = dot.isEmpty
      icon.dot.backgroundColor = tabColor(dot)
      icon.setNeedsLayout()
      icon.accessibilityLabel = count > 0 ? "\(item.label), \(count)" : item.label
      icon.accessibilityTraits = on ? [.button, .selected] : .button
      if index == 0, !moreWords.isEmpty {
        icon.accessibilityCustomActions = [UIAccessibilityCustomAction(name: moreWords) { [weak self] _ in
          self?.openList(sticky: true)
          return true
        }]
      } else {
        icon.accessibilityCustomActions = nil
      }
    }
  }

  // MARK: The capsule and its trail

  private func moveCapsule(from before: Int, animated: Bool) {
    let index = activeIndex
    guard bounds.width > 0 else { return }
    let target = capsuleFrame(index)
    guard animated else {
      capsule.frame = target
      capsule.alpha = index < 0 ? 0 : 1
      spotView.frame = spotFrame(index)
      trail.alpha = 0
      shapeCapsules()
      return
    }
    if index < 0 || before < 0 {
      // Appearing or leaving: a fade, nothing travels.
      if index >= 0 { capsule.frame = target; shapeCapsules() }
      UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
        self.capsule.alpha = index < 0 ? 0 : 1
        self.spotView.frame = self.spotFrame(index)
      }
      return
    }
    // The trail starts where the capsule stands now, follows late and fades as it arrives.
    trail.layer.removeAllAnimations()
    trail.frame = capsule.layer.presentation()?.frame ?? capsule.frame
    trail.alpha = 0.6
    UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0.4, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.capsule.frame = target
      self.capsule.alpha = 1
      self.spotView.frame = self.spotFrame(index)
    }
    UIView.animate(withDuration: 0.62, delay: 0.05, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [.allowUserInteraction]) {
      self.trail.frame = target
    }
    UIView.animate(withDuration: 0.34, delay: 0.26, options: [.allowUserInteraction, .curveEaseOut]) {
      self.trail.alpha = 0
    }
  }

  private func lift(_ on: Bool) {
    UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.75, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.capsule.transform = on ? CGAffineTransform(scaleX: 1.05, y: 1.05) : .identity
    }
  }

  private func choose(_ index: Int) {
    guard index >= 0, index < bar.count else { return }
    let id = bar[index]
    if index < icons.count {
      tabKick(icons[index].image, id: id) // ChatsPlus: the reference's own motion, not the system bounce
    }
    // The capsule goes at once; the owner confirms with `active`.
    if id != active {
      let before = activeIndex
      active = id
      paintIcons()
      moveCapsule(from: before, animated: true)
    }
    onSelect(["id": id])
  }

  // MARK: Touches

  private func index(at point: CGPoint) -> Int {
    guard cell > 0 else { return -1 }
    return min(bar.count - 1, max(0, Int(point.x / cell)))
  }

  @objc private func pressed(_ recognizer: UILongPressGestureRecognizer) {
    let point = recognizer.location(in: self)
    switch recognizer.state {
    case .began:
      startPoint = point
      startIndex = index(at: point)
      movedFar = false
      lift(true)
      if startIndex == 0, !others.isEmpty {
        holdTimer?.invalidate()
        holdTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { [weak self] _ in self?.openList(sticky: false) }
      }
    case .changed:
      let dx = point.x - startPoint.x, dy = point.y - startPoint.y
      if abs(dx) > 12 || abs(dy) > 12 { movedFar = true }
      if overlay == nil {
        if startIndex == 0, dy < -8, !others.isEmpty { openList(sticky: false) }
        else if movedFar { holdTimer?.invalidate(); holdTimer = nil }
      }
      if let overlay = overlay, !overlaySticky { light(overlay.entry(at: convert(point, to: overlay))) }
    case .ended:
      holdTimer?.invalidate(); holdTimer = nil
      lift(false)
      if let overlay = overlay, !overlaySticky {
        if let picked = overlay.entry(at: convert(point, to: overlay)) { pick(picked) }
        else if movedFar { closeList(restore: true) }
        else { stick() }
      } else if overlay == nil, !movedFar || bounds.insetBy(dx: -10, dy: -10).contains(point) {
        if bounds.insetBy(dx: -10, dy: -10).contains(point) { choose(index(at: point)) }
      }
    case .cancelled, .failed:
      holdTimer?.invalidate(); holdTimer = nil
      lift(false)
      if overlay != nil, !overlaySticky { closeList(restore: true) }
    default:
      break
    }
  }

  // MARK: The list

  func openList(sticky: Bool) {
    holdTimer?.invalidate(); holdTimer = nil
    guard overlay == nil, let window = window, !others.isEmpty else { return }
    let list = TabListOverlay(entries: others, dark: dark)
    list.frame = window.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.onPick = { [weak self] entry in self?.pick(entry) }
    list.onClose = { [weak self] in self?.closeList(restore: false) }
    window.addSubview(list)
    list.place(above: convert(bounds, to: list))
    list.isUserInteractionEnabled = sticky
    list.alpha = 0
    list.transform = CGAffineTransform(translationX: 0, y: 8)
    UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
      list.alpha = 1
      list.transform = .identity
    }
    overlay = list
    overlaySticky = sticky
    previewed = ""
    onListOpened() // ChatsPlus
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    tick.prepare()
    if sticky { UIAccessibility.post(notification: .screenChanged, argument: list) }
  }

  /// The finger was lifted without moving: the list stays, rows and the space around take taps.
  private func stick() {
    overlaySticky = true
    overlay?.isUserInteractionEnabled = true
    overlay?.light("")
  }

  private func light(_ entry: TabEntry?) {
    guard let overlay = overlay else { return }
    let id = entry?.id ?? ""
    if id == overlay.lit { return }
    overlay.light(id)
    if !id.isEmpty { tick.selectionChanged(); tick.prepare() }
    // The page behind follows only a row the finger has stayed on.
    previewTimer?.invalidate()
    previewTimer = Timer.scheduledTimer(withTimeInterval: 0.14, repeats: false) { [weak self] _ in
      guard let self = self, self.overlay?.lit == id, self.previewed != id else { return }
      self.previewed = id
      self.onPreview(["id": id])
    }
  }

  private func pick(_ entry: TabEntry) {
    dismissList()
    let before = activeIndex
    active = entry.id
    paintIcons()
    moveCapsule(from: before, animated: true)
    onSelect(["id": entry.id])
  }

  private func closeList(restore: Bool) {
    let shown = previewed
    dismissList()
    if restore, !shown.isEmpty { onPreview(["id": ""]) }
  }

  private func dismissList() {
    previewTimer?.invalidate(); previewTimer = nil
    previewed = ""
    guard let list = overlay else { return }
    overlay = nil
    overlaySticky = false
    UIView.animate(withDuration: 0.14, delay: 0, options: [.curveEaseIn], animations: { list.alpha = 0 }, completion: { _ in list.removeFromSuperview() })
    UIAccessibility.post(notification: .screenChanged, argument: icons.first)
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow == nil { dismissList() }
  }
}
