import CoreMotion
import QuartzCore
import Symbols
import UIKit

/// The phone's tab bar, drawn and driven by UIKit alone.
/// - The bar is the system's own glass (iOS 26: UIGlassEffect, clear and interactive; before: a thin blur).
/// - The chosen tab stands on a light capsule; choosing another tab sends the capsule there with a spring and a
///   capsule stretches over to it and draws itself in there (no second capsule behind it: the owner's rule).
/// - A light lives under the glass (look 9, the default; the sketch «2. Сияние»): violet at the left, pink under the
///   chosen tab (the bar's middle in a section without an icon), cyan at the right, rising from the lower edge, and a
///   white line on the top edge above the chosen tab glowing in the centre's colour. The hues drift on slowly and
///   never repeat (kept across launches); with music the lights punch and sway by bands (bass the centre, mids the
///   left, highs the right: the equalizer's audio tap meters them; a beat from the playback's position when no level
///   comes); they are a liquid sealed in the capsule: the phone's tilt leans them to the low side, a shake sloshes them
///   from end to end, bouncing off the capsule's ends (`TabFlow`, `TabLiquid`). Animations off or power saving: the
///   gradient holds still and the sensor rests. «Оформление» › «Свечение панели» (`BarGlow`) turns the lights off
///   (plain glass, no line, no display link, no sensor) or gives all three one own colour (no drift). Looks 0…8 stay
///   for comparison.
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

/// Look 9's numbers (the same in Android's shell/TabBar.kt `TabFlow`): the sketch «2. Сияние» — three lights rising
/// from the bar's lower edge (`.aur`: radial-gradient(46% 70% at 50% 100%, #ff5fb0cc, transparent 70%), the same
/// 40% 60% at 34% #7a2cffaa and at 68% #35d6ffaa, blur 14px over a box 150 tall for a bar 96 tall), and a white
/// 54×3 line on the top edge above the chosen tab with a glow of the centre light's colour. The hues then drift.
enum TabFlow {
  /// The sketch's colours as hue, saturation, brightness — left (violet #7a2cff), centre (pink #ff5fb0, under the
  /// chosen tab), right (cyan #35d6ff): the very first state; from there the hues drift on for good (`hues`).
  static let hue0: [Double] = [0.7283, 0.9156, 0.5338]
  static let saturation: [CGFloat] = [0.827, 0.627, 0.792]
  static let brightness: CGFloat = 1
  /// The sketch's alphas (cc, aa, aa), before the wave.
  static let alpha: [CGFloat] = [0.667, 0.8, 0.667]
  /// The most a light's heart gets with the wave.
  static let alphaMost: CGFloat = 0.95
  /// Where the side lights stand (× the bar's width); the centre one stands under the chosen tab (the middle without one).
  static let sideAt: [CGFloat] = [0.34, 0.68]
  /// Visible half-width (× the bar's width) and height (× the bar's height) of each light: 0.7 of the sketch's radii
  /// (the gradient is clear at 70 %), the box 150/96 of the bar.
  static let reachX: [CGFloat] = [0.28, 0.322, 0.28]
  static let reachY: [CGFloat] = [0.656, 0.766, 0.656]
  /// The sketch's 14 px blur, as extra reach (× the bar's height) and a soft fall: alpha × `fall` at `stops`.
  static let blurReach: CGFloat = 0.22
  static let stops: [CGFloat] = [0, 0.3, 0.55, 0.8, 1]
  static let fall: [CGFloat] = [1, 0.85, 0.55, 0.2, 0]
  /// The line on the top edge: white; its glow the centre's colour, lightened, at 0.8. Half the sketch's size by the
  /// owner's rule (the sketch: 54×3, box-shadow 0 0 18px 5px).
  static let lineWidth: CGFloat = 27
  static let lineHeight: CGFloat = 1.5
  static let lineGlow: CGFloat = 0.8
  static let lineBlur: CGFloat = 9
  static let lineSpread: CGFloat = 2.5
  /// How much white is mixed into the line's glow (#ff5fb0 → about #ff8cc6).
  static let lineWhite: CGFloat = 0.3
  static let grain: CGFloat = 0 // Owner's rule: the bar is clean, no grain over its lights (the sketch had 0.08).

  // The colours' drift: all three hues turn together at an uneven pace — one turn of the circle in about 3 minutes,
  // the pace swinging ±40 % by three slow sines of incommensurate periods (so it never repeats) — and each light
  // wanders ±0.07 of the circle around its place by two slow sines of its own; the lights stay at least 60° apart.
  // The clock and the turn are kept on the device: the next launch goes on from them.
  static let turnRate: Double = 1.0 / 180
  static let paceSwing: Double = 0.4
  static let pace: [(period: Double, weight: Double, phase: Double)] = [(71, 1, 0), (113, 0.6, 1.3), (29, 0.35, 0.4)]
  static let wanderAmount: Double = 0.07
  static let wander: [[(period: Double, weight: Double, phase: Double)]] = [
    [(53, 1, 0), (89, 0.5, 0)],
    [(67, 1, 0), (131, 0.5, 0)],
    [(47, 1, 0), (101, 0.5, 0)],
  ]
  static let apart: Double = 1.0 / 6
  static let storeKey = "linea.tabflow.v1"

  /// The person's own colour («Свечение панели» › «Свой цвет», `BarGlow`): all three lights in it, no drift — the
  /// centre the colour itself, the left a little deeper (more saturated, darker), the right a little paler and
  /// brighter, so the one colour still reads as three lights.
  static let ownLeftSaturation: CGFloat = 1.12
  static let ownLeftBrightness: CGFloat = 0.78
  static let ownRightSaturation: CGFloat = 0.72
  static let ownRightLift: CGFloat = 0.12

  /// The three lights' colours (left, centre, right) for the own colour `color`, opaque.
  static func ownTones(_ color: UIColor) -> [UIColor] {
    var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, opacity: CGFloat = 0
    _ = color.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &opacity)
    let left = UIColor(hue: hue, saturation: min(1, saturation * ownLeftSaturation), brightness: brightness * ownLeftBrightness, alpha: 1)
    let right = UIColor(hue: hue, saturation: saturation * ownRightSaturation, brightness: min(1, brightness + ownRightLift), alpha: 1)
    return [left, color.withAlphaComponent(1), right]
  }

  /// A smooth value in −1…1: the weighted sum of sines (period s, weight, phase in turns).
  static func noise(_ time: Double, _ parts: [(period: Double, weight: Double, phase: Double)]) -> Double {
    var sum = 0.0, total = 0.0
    for part in parts {
      sum += part.weight * sin(2 * Double.pi * (time / part.period + part.phase))
      total += part.weight
    }
    return total > 0 ? sum / total : 0
  }

  /// How fast the common turn goes at `time` (turns a second).
  static func turnSpeed(_ time: Double) -> Double {
    return turnRate * (1 + paceSwing * noise(time, pace))
  }

  /// The three hues (0…1: left, centre, right) at `time` seconds of the clock with the common turn at `turn`.
  static func hues(_ time: Double, turn: Double) -> [Double] {
    var hues = (0..<3).map { (light: Int) -> Double in hue0[light] + turn + wanderAmount * noise(time, wander[light]) }
    // Never closer than 60°: two that come nearer are pushed apart, each half of the way.
    for _ in 0..<3 {
      for pair in [(0, 1), (1, 2), (0, 2)] {
        var gap = hues[pair.1] - hues[pair.0]
        gap -= floor(gap + 0.5)
        if abs(gap) < apart {
          let push = (apart - abs(gap)) / 2 * (gap < 0 ? -1 : 1)
          hues[pair.0] -= push
          hues[pair.1] += push
        }
      }
    }
    return hues.map { (hue: Double) -> Double in hue - floor(hue) }
  }

  // The music, by bands: the left light follows the mids, the centre one the bass, the right one the highs.
  /// How much the band's level gains before it is read as loudness (the highs and mids are quieter than the bass).
  static let bandGain: [Float] = [1.5, 1, 2.5]
  /// What a full level does to each light: brighter, taller, wider; and how far (× the bar's width) and how fast (Hz)
  /// it sways — the mids slowly, the highs as a quick shimmer, the bass not at all (it punches).
  static let punchAlpha: [CGFloat] = [0.45, 0.6, 0.45]
  static let punchTall: [CGFloat] = [0.3, 0.4, 0.2]
  static let punchWide: [CGFloat] = [0.12, 0.2, 0.1]
  static let swayWidth: [CGFloat] = [0.04, 0, 0.015]
  static let swayRate: [Double] = [0.5, 0, 6]


  /// The music's loudness heard by the tap, as 0…1 (−40 dBFS … −6 dBFS).
  static func loudness(_ rms: Float) -> CGFloat {
    let db = 20 * log10(Double(max(rms, 0.00001)))
    return CGFloat(min(1, max(0, (db + 40) / 34)))
  }

  /// A level without a meter, for light `light`, from the playback's position: the bass a kick on every beat (120 a
  /// minute), the mids a hit on the off-beats over a slow swell, the highs a quick tick on every eighth, shimmering.
  static func synthetic(_ position: Double, light: Int) -> CGFloat {
    switch light {
    case 1:
      let beat = position * 2
      return CGFloat(0.2 + 0.75 * exp(-(beat - floor(beat)) * 6))
    case 0:
      let beat = position + 0.5
      let hit = exp(-(beat - floor(beat)) * 4)
      let swell = 0.5 + 0.5 * sin(2 * Double.pi * position * 0.23)
      return CGFloat(min(1, 0.2 + 0.5 * hit + 0.25 * swell))
    default:
      let beat = position * 4
      let tick = exp(-(beat - floor(beat)) * 10)
      let shimmer = 0.5 + 0.5 * sin(2 * Double.pi * position * 0.37)
      return CGFloat(min(1, 0.15 + 0.45 * tick * (0.5 + 0.5 * shimmer) + 0.2 * shimmer))
    }
  }
}

/// Look 9's lights as a liquid sealed in the glass capsule (the same numbers in Android's shell/TabBar.kt `TabLiquid`):
/// each light is a blob along the bar with inertia — a spring to its place (0.9 Hz, damping ratio 0.25: it settles in
/// a second or two), pushed by the phone's acceleration along the bar (the tilt's gravity and the hand's movement, in
/// g, at most ±2.5 g), kept off its neighbours by a soft push, bouncing off the capsule's ends with half its speed
/// left, squashing (taller and narrower for a moment, a 3 Hz spring) and brightening at the wall. Fixed steps of
/// 1/120 s. Positions are × the bar's width, from each blob's place. Shape and brightness only: never the colour.
final class TabLiquid {
  static let frequency: Double = 0.9
  static let zeta: Double = 0.25
  /// The bar's widths a second² for 1 g along the bar: a tilt of half the gravity leans a blob 12 % of the width.
  static let gain: Double = 7.7
  static let inputMost: Double = 2.5
  /// How far a blob's middle may go (× the bar's width) before it meets the capsule's end.
  static let wallLeft: Double = 0.12
  static let wallRight: Double = 0.88
  /// The speed left after a wall (the rest is lost).
  static let bounce: Double = 0.55
  /// The closest two blobs' middles come (× the bar's width) before they push each other, and how hard.
  static let gap: Double = 0.14
  static let push: Double = 400
  static let speedMost: Double = 3
  static let squashFrequency: Double = 3
  static let squashZeta: Double = 0.35
  /// A wall turns this much of the blob's speed into squash (taller by `squashTall`, narrower by `squashWide` at 1).
  static let squashKick: Double = 1.6
  static let squashWide: Double = 0.35
  static let squashTall: Double = 0.5
  /// A moving blob stands a little taller (the slosh), fully at this speed.
  static let sloshTall: Double = 0.12
  static let sloshSpeed: Double = 0.6
  /// A wall's flash: brighter by this much at its strongest, fading in `flashFade` s; full at an impact of 0.8.
  static let flash: Double = 0.5
  static let flashFade: Double = 0.25
  static let step: Double = 1.0 / 120

  private(set) var offset: [Double] = [0, 0, 0]
  private var speed: [Double] = [0, 0, 0]
  private var squash: [Double] = [0, 0, 0]
  private var squashSpeed: [Double] = [0, 0, 0]
  private var glow: [Double] = [0, 0, 0]
  private var left: Double = 0

  /// Nothing is moving (the frame rate may drop).
  var quiet: Bool {
    for index in 0..<3 where abs(offset[index]) > 0.002 || abs(speed[index]) > 0.002 || abs(squash[index]) > 0.01 || glow[index] > 0.01 {
      return false
    }
    return true
  }

  func reset() {
    offset = [0, 0, 0]; speed = [0, 0, 0]; squash = [0, 0, 0]; squashSpeed = [0, 0, 0]; glow = [0, 0, 0]; left = 0
  }

  /// Runs the liquid on by `dt` seconds under `force` (g along the bar, + to the right) with the blobs' places `rest`.
  func advance(_ dt: Double, force raw: Double, rest: [Double]) {
    let force = min(TabLiquid.inputMost, max(-TabLiquid.inputMost, raw))
    let omega = 2 * Double.pi * TabLiquid.frequency
    let stiff = omega * omega, damp = 2 * TabLiquid.zeta * omega
    let squashOmega = 2 * Double.pi * TabLiquid.squashFrequency
    let squashStiff = squashOmega * squashOmega, squashDamp = 2 * TabLiquid.squashZeta * squashOmega
    let order = [0, 1, 2].sorted { (a: Int, b: Int) -> Bool in rest[a] < rest[b] }
    let fade = exp(-TabLiquid.step / TabLiquid.flashFade)
    left += dt
    var steps = 0
    while left >= TabLiquid.step && steps < 24 {
      left -= TabLiquid.step
      steps += 1
      var accel = [0, 1, 2].map { (index: Int) -> Double in TabLiquid.gain * force - stiff * offset[index] - damp * speed[index] }
      for pair in 0..<2 {
        let a = order[pair], b = order[pair + 1]
        let apart = (rest[b] + offset[b]) - (rest[a] + offset[a])
        if apart < TabLiquid.gap {
          let shove = TabLiquid.push * (TabLiquid.gap - apart)
          accel[a] -= shove
          accel[b] += shove
        }
      }
      for index in 0..<3 {
        speed[index] = min(TabLiquid.speedMost, max(-TabLiquid.speedMost, speed[index] + accel[index] * TabLiquid.step))
        offset[index] += speed[index] * TabLiquid.step
        let place = rest[index] + offset[index]
        if place < TabLiquid.wallLeft && speed[index] < 0 { hit(index, at: TabLiquid.wallLeft - rest[index]) }
        else if place > TabLiquid.wallRight && speed[index] > 0 { hit(index, at: TabLiquid.wallRight - rest[index]) }
        squashSpeed[index] += (-squashStiff * squash[index] - squashDamp * squashSpeed[index]) * TabLiquid.step
        squash[index] += squashSpeed[index] * TabLiquid.step
        glow[index] *= fade
      }
    }
    if steps >= 24 { left = 0 }
  }

  private func hit(_ index: Int, at place: Double) {
    let impact = abs(speed[index])
    offset[index] = place
    speed[index] = -speed[index] * TabLiquid.bounce
    squashSpeed[index] += impact * TabLiquid.squashKick
    glow[index] = max(glow[index], min(1, impact / 0.8))
  }

  /// Blob `index`'s shape now: its width and height factors and its brightness factor.
  func shape(_ index: Int) -> (wide: CGFloat, tall: CGFloat, bright: CGFloat) {
    let squeeze = min(1, max(-1, squash[index]))
    let slosh = min(1, abs(speed[index]) / TabLiquid.sloshSpeed)
    return (CGFloat(1 - TabLiquid.squashWide * squeeze), CGFloat(1 + TabLiquid.squashTall * squeeze + TabLiquid.sloshTall * slosh), CGFloat(1 + TabLiquid.flash * glow[index]))
  }
}

/// «Свечение панели» in «Оформление» (Settings/BarGlowSettings.swift): look 9's lights on or off, and the person's own
/// colour for them (nil: the colours drift — «Переливается»). Kept on this device in the app's preferences store
/// (UserDefaults, as DevicePreferences), under keys of their own; every bar follows at once (`changed`). The same in
/// Android's shell/TabBar.kt `BarGlow`.
enum BarGlow {
  static let changed = Notification.Name("linea.bar-glow")
  static let onKey = "linea.bar-glow.v1"
  static let colorKey = "linea.bar-glow-color.v1"
  /// A colour being tried (the picker under the finger): shown by the bar, not kept yet.
  private static var trying: String?

  /// The lights are on (the default). Off: the bar is plain glass — no lights, no line, no display link, no sensor.
  static var on: Bool {
    get { return UserDefaults.standard.string(forKey: onKey) != "off" }
    set {
      if newValue { UserDefaults.standard.removeObject(forKey: onKey) } else { UserDefaults.standard.set("off", forKey: onKey) }
      NotificationCenter.default.post(name: changed, object: nil)
    }
  }

  /// The own colour as `#RRGGBB`, or nil for the drift.
  static var color: String? {
    get {
      if let trying { return trying }
      guard let kept = UserDefaults.standard.string(forKey: colorKey) else { return nil }
      return normal(kept)
    }
    set {
      trying = nil
      if let value = newValue, let hex = normal(value) { UserDefaults.standard.set(hex, forKey: colorKey) } else { UserDefaults.standard.removeObject(forKey: colorKey) }
      NotificationCenter.default.post(name: changed, object: nil)
    }
  }

  /// Shows `value` on the bar without keeping it (nil: back to what is kept).
  static func tryColor(_ value: String?) {
    if let value { trying = normal(value) } else { trying = nil }
    NotificationCenter.default.post(name: changed, object: nil)
  }

  /// `#RRGGBB` in capitals from «RRGGBB» or «#rrggbb»; nil for anything else.
  static func normal(_ text: String) -> String? {
    var digits = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if digits.hasPrefix("#") { digits.removeFirst() }
    guard digits.count == 6, digits.allSatisfy({ (letter: Character) -> Bool in letter.isHexDigit }) else { return nil }
    return "#" + digits.uppercased()
  }

  /// The colour of a `#RRGGBB` code.
  static func uiColor(_ text: String) -> UIColor? {
    guard let hex = normal(text), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    return UIColor(hex: value)
  }

  /// `#RRGGBB` of a colour (sRGB, clamped).
  static func hex(_ color: UIColor) -> String {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, opacity: CGFloat = 0
    _ = color.getRed(&red, green: &green, blue: &blue, alpha: &opacity)
    let part = { (value: CGFloat) -> Int in Int((min(1, max(0, value)) * 255).rounded()) }
    return String(format: "#%02X%02X%02X", part(red), part(green), part(blue))
  }
}

/// CADisplayLink retains its target: a proxy keeps the bar out of that cycle.
private final class TabFlowLinkProxy: NSObject {
  weak var bar: TabBarView?
  @objc func tick(_ link: CADisplayLink) { bar?.flowTick(link) }
}

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
  /// Look 9: the white line on the top edge above the chosen tab, glowing in the centre light's colour (out of the
  /// glass, so its glow also shows above the bar, as in the sketch).
  private let flowLine = UIView()
  /// Look 9, the owner's choice: the first look's three lights turning through the colours, waving with the music.
  static let flowLook = 9
  /// Which glow look is on: 9 (`TabFlow`). Others stay for comparison (`-barlook N` in the simulator); 6 was the small
  /// round glow behind the chosen icon.
  var look = TabBarView.flowLook {
    didSet {
      // 6…8: a halo centred on the chosen icon (6, 7) or just below it (8), instead of light rising from the edge.
      let halo = (6...8).contains(look)
      spot.startPoint = halo ? CGPoint(x: 0.5, y: 0.5) : CGPoint(x: 0.5, y: 1)
      spot.endPoint = halo ? CGPoint(x: 1, y: 1) : CGPoint(x: 1, y: 0)
      laidOut = .zero; setNeedsLayout(); paintGlow(animated: false)
      showGlow()
      refreshFlow()
    }
  }
  /// «Свечение панели» (`BarGlow`): look 9's lights on, and the own colours of the three (nil: the drift).
  private var glowOn = BarGlow.on
  private var ownTones: [UIColor]? = TabBarView.ownTonesNow()

  // Look 9's clock: one display link, only while the bar is in a window, shown, the app in front and animations on.
  private let flowProxy = TabFlowLinkProxy()
  private var flowLink: CADisplayLink?
  private var flowFast = false
  private var flowObservers: [NSObjectProtocol] = []
  private var appInFront = true
  /// The drift's clock (seconds) and the common turn of the hues; kept on the device across launches.
  private var flowTime: Double = 0
  private var flowTurn: Double = 0
  private var flowLast: CFTimeInterval = 0
  /// The music's bands (left = mids, centre = bass, right = highs): their levels (0…1, smoothed), their slow means
  /// (what stands out over them is the beat), and how much of the music shows (eases in and out with playback).
  private var waveLevel: [CGFloat] = [0, 0, 0]
  private var waveSlow: [CGFloat] = [0, 0, 0]
  private var waveAmount: CGFloat = 0
  /// The playback's position as the wave keeps it (runs on by itself where the player's position stands still).
  private var waveClock: Double = 0
  private var waveSeen: Double = -1
  /// The lights as a liquid moved by the phone (`TabLiquid`).
  private let liquid = TabLiquid()
  private var sensing = false
  private static let motionSensor = CMMotionManager()

  override var alpha: CGFloat { didSet { refreshFlow() } }
  override var isHidden: Bool { didSet { refreshFlow() } }
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
    // Looks 6…8: a small round glow right behind the chosen icon; the default (9) rises from the lower edge.
    let halo = (6...8).contains(look)
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
    // The lights live under the glass: the glass (iOS 26's clear glass, or the thin blur) is seen over them, refracts
    // and softens them, and keeps its own highlights and rim on top.
    insertSubview(glowView, belowSubview: glass)
    trail.isUserInteractionEnabled = false
    trail.alpha = 0
    glass.contentView.addSubview(trail)
    capsule.isUserInteractionEnabled = false
    gloss.startPoint = CGPoint(x: 0.5, y: 0)
    gloss.endPoint = CGPoint(x: 0.5, y: 0.55)
    capsule.layer.addSublayer(gloss)
    capsule.layer.addSublayer(capsuleRim)
    glass.contentView.addSubview(capsule)
    flowLine.isUserInteractionEnabled = false
    flowLine.backgroundColor = .white
    flowLine.layer.cornerRadius = TabFlow.lineHeight
    flowLine.layer.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
    flowLine.layer.shadowOpacity = Float(TabFlow.lineGlow)
    flowLine.layer.shadowRadius = TabFlow.lineBlur / 2
    flowLine.layer.shadowOffset = .zero
    let spread = TabFlow.lineSpread
    flowLine.layer.shadowPath = UIBezierPath(roundedRect: CGRect(x: -spread, y: -spread, width: TabFlow.lineWidth + spread * 2, height: TabFlow.lineHeight + spread * 2), cornerRadius: TabFlow.lineHeight + spread).cgPath
    flowLine.alpha = 0
    addSubview(flowLine)

    let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
    press.minimumPressDuration = 0
    press.allowableMovement = 10_000
    press.delegate = self
    addGestureRecognizer(press)
    paintChrome()

    flowProxy.bar = self
    restoreFlow()
    showGlow()
    let centre = NotificationCenter.default
    flowObservers.append(centre.addObserver(forName: BarGlow.changed, object: nil, queue: .main) { [weak self] (_: Notification) -> Void in
      self?.readGlow()
    })
    flowObservers.append(centre.addObserver(forName: Motion.changed, object: nil, queue: .main) { [weak self] (_: Notification) -> Void in
      self?.refreshFlow()
    })
    flowObservers.append(centre.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] (_: Notification) -> Void in
      self?.appInFront = false
      self?.refreshFlow()
      self?.storeFlow()
    })
    flowObservers.append(centre.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] (_: Notification) -> Void in
      self?.storeFlow()
    })
    flowObservers.append(centre.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] (_: Notification) -> Void in
      self?.appInFront = true
      self?.refreshFlow()
    })
  }

  required init?(coder: NSCoder) { return nil }

  deinit {
    holdTimer?.invalidate()
    previewTimer?.invalidate()
    overlay?.removeFromSuperview()
    flowLink?.invalidate()
    if sensing { TabBarView.motionSensor.stopDeviceMotionUpdates() }
    flowObservers.forEach { NotificationCenter.default.removeObserver($0) }
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
  /// In a section without an icon on the bar the halo looks (1…8) show no glow (it was a smudge between the icons);
  /// look 9's gradient spans the bar, so its centre light stays, in the bar's middle.
  private func spotShown(_ index: Int) -> CGFloat {
    return index < 0 && look != TabBarView.flowLook ? 0 : 1
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
    glowView.layer.cornerCurve = .continuous
    glowLeft.frame = CGRect(x: -bounds.width * 0.16, y: 0, width: bounds.width * 0.72, height: bounds.height)
    glowRight.frame = CGRect(x: bounds.width * 0.46, y: 0, width: bounds.width * 0.72, height: bounds.height)
    spotView.frame = spotFrame(activeIndex)
    spot.frame = spotView.bounds
    sheen.frame = CGRect(x: spotView.bounds.width * 0.18, y: 0.5, width: spotView.bounds.width * 0.64, height: 1.2)
    grain.frame = bounds
    capsule.frame = capsuleFrame(activeIndex)
    capsule.alpha = activeIndex < 0 ? 0 : 1
    spotView.alpha = spotShown(activeIndex)
    flowLine.frame = lineFrame(activeIndex)
    flowLine.alpha = lineShown(activeIndex)
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
    if look == TabBarView.flowLook { paintFlow(); return }
    // Look 9's soft stops off: the other looks fade in two steps.
    for layer in [glowLeft, spot, glowRight] { layer.locations = nil }
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

  // MARK: Look 9: the turning colours and the music's wave

  /// The display link (and the motion sensor) run only while the bar can be seen and animations are allowed; otherwise
  /// the gradient holds still. The sensor also rests in power saving.
  private func refreshFlow() {
    let run = look == TabBarView.flowLook && glowOn && window != nil && !isHidden && alpha > 0.01 && appInFront && Motion.enabled
    let sense = run && !Motion.saving && TabBarView.motionSensor.isDeviceMotionAvailable
    if sense != sensing {
      sensing = sense
      if sense {
        TabBarView.motionSensor.deviceMotionUpdateInterval = 1.0 / 60
        TabBarView.motionSensor.startDeviceMotionUpdates()
      } else {
        TabBarView.motionSensor.stopDeviceMotionUpdates()
        liquid.reset()
      }
    }
    if run {
      guard flowLink == nil else { return }
      let made = CADisplayLink(target: flowProxy, selector: #selector(TabFlowLinkProxy.tick(_:)))
      made.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 60, preferred: 30)
      made.add(to: .main, forMode: .common)
      flowLink = made
      flowFast = false
      flowLast = 0
    } else if let link = flowLink {
      link.invalidate()
      flowLink = nil
      storeFlow()
      // Still: the colours where they stood, no wave, no slide.
      waveLevel = [0, 0, 0]; waveSlow = [0, 0, 0]; waveAmount = 0
      paintGlow(animated: false)
    }
  }

  /// The own colour's three tones, or nil for the drift.
  private static func ownTonesNow() -> [UIColor]? {
    guard let hex = BarGlow.color, let color = BarGlow.uiColor(hex) else { return nil }
    return TabFlow.ownTones(color)
  }

  /// «Свечение панели» changed in «Оформление»: the bar follows at once.
  private func readGlow() {
    glowOn = BarGlow.on
    ownTones = TabBarView.ownTonesNow()
    showGlow()
    refreshFlow()
    paintGlow(animated: false)
  }

  /// Look 9 with «Свечение панели» off: plain glass — the lights and the line are not there at all.
  private func showGlow() {
    let plain = look == TabBarView.flowLook && !glowOn
    glowView.isHidden = plain
    flowLine.isHidden = plain
  }

  /// The drift's clock and turn, kept for the next launch.
  private func storeFlow() {
    UserDefaults.standard.set([flowTime, flowTurn], forKey: TabFlow.storeKey)
  }

  private func restoreFlow() {
    guard let kept = UserDefaults.standard.array(forKey: TabFlow.storeKey) as? [Double], kept.count == 2, kept[0].isFinite, kept[1].isFinite else { return }
    flowTime = max(0, kept[0])
    flowTurn = kept[1] - floor(kept[1])
  }

  fileprivate func flowTick(_ link: CADisplayLink) {
    let now = link.timestamp
    let dt = flowLast == 0 ? 1.0 / 60 : min(0.1, max(0, now - flowLast))
    flowLast = now
    flowTime += dt
    flowTurn += TabFlow.turnSpeed(flowTime) * dt
    flowTurn -= floor(flowTurn)
    if flowTime > 1_000_000 { flowTime = 0 }
    let player = MusicPlayer.shared
    let playing = player.playing
    var targets: [CGFloat] = [0, 0, 0]
    if playing {
      // The wave's own clock follows the playback: re-set when the player's position moves somewhere else (a seek, a
      // new track), runs on by itself between the player's updates and where its position stands still.
      waveClock += dt
      let position = player.position
      if position != waveSeen {
        if abs(position - waveClock) > 0.6 { waveClock = position }
        waveSeen = position
      }
      let reading = MusicEqualizer.state.meterReading()
      if CACurrentMediaTime() - reading.at < 0.25 {
        // Live levels: each band's loudness, with what stands out over its last second or so made bigger (the beat,
        // not the volume).
        let bands: [Float] = [reading.mid, reading.low, reading.high]
        for index in 0..<3 {
          let loud = TabFlow.loudness(bands[index] * TabFlow.bandGain[index])
          waveSlow[index] += (loud - waveSlow[index]) * CGFloat(1 - exp(-dt / 1.2))
          targets[index] = min(1, max(0, 0.3 + (loud - waveSlow[index]) * 2.5 + 0.2 * loud))
        }
      } else {
        for index in 0..<3 { targets[index] = TabFlow.synthetic(waveClock, light: index) }
      }
    }
    // Rises quickly, falls slowly; the whole wave fades in and out with playback.
    for index in 0..<3 {
      let rate: Double = targets[index] > waveLevel[index] ? 0.05 : 0.22
      waveLevel[index] += (targets[index] - waveLevel[index]) * CGFloat(1 - exp(-dt / rate))
    }
    let shown: CGFloat = playing ? 1 : 0
    waveAmount += (shown - waveAmount) * CGFloat(1 - exp(-dt / 0.6))
    // The liquid: pushed along the bar by the tilt's gravity and against the hand's movement (in g).
    var force = 0.0
    if sensing, let device = TabBarView.motionSensor.deviceMotion {
      force = device.gravity.x - device.userAcceleration.x
    }
    let width = bounds.width
    let rest: [Double] = width > 0 ? [Double(TabFlow.sideAt[0]), Double(spotView.center.x / width), Double(TabFlow.sideAt[1])] : [0.34, 0.5, 0.68]
    liquid.advance(dt, force: force, rest: rest)
    // 30 frames a second for the slow colours alone, 60 while the music or the hand moves the lights.
    let fast = waveAmount > 0.02 || !liquid.quiet
    if fast != flowFast {
      flowFast = fast
      link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 60, preferred: fast ? 60 : 30)
    }
    paintFlow()
  }

  /// Look 9: the sketch's three lights (violet left, pink under the chosen tab, cyan right) rising from the lower
  /// edge under the glass in the colours of this moment, raised by the music's bands, moved as a liquid by the phone; the line
  /// on the top edge glows in the centre's colour.
  private func paintFlow() {
    let width = bounds.width, height = bounds.height
    guard width > 0, height > 0 else { return }
    let blur = TabFlow.blurReach * height
    let hues = TabFlow.hues(flowTime, turn: flowTurn)
    // Where each light's middle stands: the side ones in the bar's coordinates, the centre one in its view's.
    let mids: [CGFloat] = [width * TabFlow.sideAt[0], spotView.bounds.midX, width * TabFlow.sideAt[1]]
    let lows: [CGFloat] = [height, spotView.bounds.height, height]
    let layers: [CAGradientLayer] = [glowLeft, spot, glowRight]
    let locations = TabFlow.stops.map { (stop: CGFloat) -> NSNumber in NSNumber(value: Double(stop)) }
    var centreColor = UIColor.white
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for index in 0..<3 {
      let layer = layers[index]
      let push = waveLevel[index] * waveAmount
      let color = ownTones?[index] ?? UIColor(hue: CGFloat(hues[index]), saturation: TabFlow.saturation[index], brightness: TabFlow.brightness, alpha: 1)
      if index == 1 { centreColor = color }
      let blob = liquid.shape(index)
      let strength = min(TabFlow.alphaMost, TabFlow.alpha[index] * (1 + TabFlow.punchAlpha[index] * push) * blob.bright)
      layer.colors = TabFlow.fall.map { (part: CGFloat) -> CGColor in color.withAlphaComponent(strength * part).cgColor }
      layer.locations = locations
      let halfWide = (TabFlow.reachX[index] * width + blur) * (1 + TabFlow.punchWide[index] * push) * blob.wide
      let tall = (TabFlow.reachY[index] * height + blur) * (1 + TabFlow.punchTall[index] * push) * blob.tall
      let sway = CGFloat(sin(2 * Double.pi * flowTime * TabFlow.swayRate[index])) * TabFlow.swayWidth[index] * width * push
      let flow = CGFloat(liquid.offset[index]) * width
      layer.frame = CGRect(x: mids[index] - halfWide + sway + flow, y: lows[index] - tall, width: halfWide * 2, height: tall)
    }
    sheen.colors = [UIColor.white.withAlphaComponent(0).cgColor, UIColor.white.withAlphaComponent(0).cgColor]
    gloss.colors = [UIColor.white.withAlphaComponent(0).cgColor, UIColor.white.withAlphaComponent(0).cgColor]
    grain.alpha = TabFlow.grain
    // The line's glow: the centre light's colour, lightened as the sketch's #ff8cc6 is #ff5fb0.
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, opacity: CGFloat = 0
    _ = centreColor.getRed(&red, green: &green, blue: &blue, alpha: &opacity)
    let white = TabFlow.lineWhite
    flowLine.layer.shadowColor = UIColor(red: red + (1 - red) * white, green: green + (1 - green) * white, blue: blue + (1 - blue) * white, alpha: 1).cgColor
    CATransaction.commit()
  }

  /// The line on the top edge above the chosen tab (look 9).
  private func lineFrame(_ index: Int) -> CGRect {
    let centre = index < 0 ? bounds.midX : (CGFloat(index) + 0.5) * cell
    return CGRect(x: centre - TabFlow.lineWidth / 2, y: 0, width: TabFlow.lineWidth, height: TabFlow.lineHeight)
  }

  private func lineShown(_ index: Int) -> CGFloat {
    return index >= 0 && look == TabBarView.flowLook ? 1 : 0
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
      spotView.alpha = spotShown(index)
      spotView.frame = spotFrame(index)
      flowLine.frame = lineFrame(index)
      flowLine.alpha = lineShown(index)
      trail.alpha = 0
      shapeCapsules()
      return
    }
    if index < 0 || before < 0 {
      // Appearing or leaving: a fade, nothing travels.
      if index >= 0 { capsule.frame = target; shapeCapsules() }
      UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
        self.capsule.alpha = index < 0 ? 0 : 1
        self.spotView.alpha = self.spotShown(index)
        self.spotView.frame = self.spotFrame(index)
        self.flowLine.alpha = self.lineShown(index)
        if index >= 0 { self.flowLine.frame = self.lineFrame(index) }
      }
      return
    }
    // The capsule stretches: it first reaches over to the other tab, then draws itself in there (the owner's rule: no
    // second, fading capsule behind it).
    trail.layer.removeAllAnimations()
    trail.alpha = 0
    let standing = capsule.layer.presentation()?.frame ?? capsule.frame
    let reach = standing.union(target)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    capsule.frame = target
    shapeCapsules()
    CATransaction.commit()
    // The capsule's rim and gloss are layers of their own, so all three are moved by the same explicit animation:
    // from where the capsule stands, over both tabs, to the new one.
    let stops: [CGRect] = [standing, reach, target]
    let parts: [(layer: CALayer, inside: Bool)] = [(capsule.layer, false), (capsuleRim, true), (gloss, true)]
    for part in parts {
      let size = CAKeyframeAnimation(keyPath: "bounds.size")
      size.values = stops.map { (rect: CGRect) -> NSValue in NSValue(cgSize: rect.size) }
      let place = CAKeyframeAnimation(keyPath: "position")
      place.values = stops.map { (rect: CGRect) -> NSValue in
        NSValue(cgPoint: part.inside ? CGPoint(x: rect.width / 2, y: rect.height / 2) : CGPoint(x: rect.midX, y: rect.midY))
      }
      for move in [size, place] {
        move.keyTimes = [0, 0.42, 1]
        move.duration = 0.46
        move.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut)]
      }
      part.layer.add(size, forKey: "stretch.size")
      part.layer.add(place, forKey: "stretch.place")
    }
    UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0.4, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.capsule.alpha = 1
      self.spotView.alpha = 1
      self.spotView.frame = self.spotFrame(index)
      self.flowLine.frame = self.lineFrame(index)
    }
    trail.frame = target
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

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { appInFront = UIApplication.shared.applicationState != .background }
    refreshFlow()
  }
}
