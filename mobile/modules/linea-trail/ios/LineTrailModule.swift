import ExpoModulesCore
import QuartzCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// «Пиксельный след» (src/PixelTrail.tsx). A window-level gesture recognizer only OBSERVES touches — it never
/// recognizes, never cancels or delays them and is never prevented by other recognizers — so the trail keeps
/// following the finger while a UIScrollView scrolls, an RNGH pan runs or a sheet is dragged (a JS onTouchMove
/// is cancelled at that moment). The touch points feed a passthrough overlay (isUserInteractionEnabled = false)
/// on top of the key window that draws the cells with a small reused pool of CALayers, driven by a CADisplayLink
/// that runs only while some cell is alive. Anything missing (no key window) = nothing drawn.
public final class LineTrailModule: Module {
  private var overlay: TrailOverlayView?
  private var observer: TrailTouchObserver?
  private var color: UIColor = .white
  private var enabled = false
  private var keyWindowToken: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("LineaTrail")

    Function("setEnabled") { (on: Bool) in
      DispatchQueue.main.async {
        self.enabled = on
        if on { self.attach() } else { self.detach() }
      }
    }

    Function("setColor") { (hex: String) in
      DispatchQueue.main.async {
        guard let parsed = LineTrailModule.color(hex) else { return }
        self.color = parsed
        self.overlay?.color = parsed
      }
    }

    OnCreate {
      DispatchQueue.main.async {
        // A new key window (scene reconnect) gets the overlay again.
        self.keyWindowToken = NotificationCenter.default.addObserver(forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] _ in
          guard let self, self.enabled else { return }
          self.attach()
        }
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        if let token = self.keyWindowToken { NotificationCenter.default.removeObserver(token) }
        self.keyWindowToken = nil
        self.detach()
      }
    }
  }

  private static func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    return windows.first(where: { $0.isKeyWindow }) ?? windows.first
  }

  private func attach() {
    guard let window = LineTrailModule.keyWindow() else { return }
    if let overlay, overlay.superview === window, observer?.view === window {
      overlay.color = color
      window.bringSubviewToFront(overlay)
      return
    }
    detach()
    let view = TrailOverlayView(frame: window.bounds)
    view.color = color
    window.addSubview(view)
    let recognizer = TrailTouchObserver(target: nil, action: nil)
    recognizer.overlay = view
    window.addGestureRecognizer(recognizer)
    overlay = view
    observer = recognizer
  }

  private func detach() {
    if let observer { observer.view?.removeGestureRecognizer(observer) }
    observer?.overlay = nil
    observer = nil
    overlay?.stop()
    overlay?.removeFromSuperview()
    overlay = nil
  }

  private static func color(_ hex: String) -> UIColor? {
    var text = hex.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
    return UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
  }
}

/// Watches every touch of the window and never takes part in gesture arbitration: it stays .possible while
/// fingers are down and fails when the last one lifts.
final class TrailTouchObserver: UIGestureRecognizer, UIGestureRecognizerDelegate {
  weak var overlay: TrailOverlayView?

  override init(target: Any?, action: Selector?) {
    super.init(target: target, action: action)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
    requiresExclusiveTouchType = false
    delegate = self
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    guard let overlay else { return }
    overlay.keepOnTop()
    for touch in touches { overlay.began(touch) }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    guard let overlay else { return }
    for touch in touches { overlay.moved(touch, event: event) }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    for touch in touches { overlay?.lifted(touch) }
    finishIfDone(event)
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    for touch in touches { overlay?.lifted(touch) }
    finishIfDone(event)
  }

  override func reset() {
    super.reset()
    overlay?.liftAll()
  }

  private func finishIfDone(_ event: UIEvent) {
    let down = event.allTouches?.contains(where: { $0.phase != .ended && $0.phase != .cancelled }) ?? false
    if !down && state == .possible { state = .failed }
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool { false }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool { false }
}

/// Mirrors TRAIL in src/pixelTrailModel.ts — keep the values and rules identical.
enum TrailRules {
  static let grid: CGFloat = 5          // GRID, pt
  static let spacing: CGFloat = 5       // SPACING, pt
  static let scatter = 2                // SCATTER, cells
  static let extraChance = 0.4          // EXTRA_CHANCE
  static let bigChance = 0.15           // BIG_CHANCE
  static let lifeMin = 0.42             // LIFE_MIN, s
  static let lifeMax = 0.70             // LIFE_MAX, s
  static let maxLive = 150              // MAX_LIVE
  static let birthAlpha = 0.85          // BIRTH_ALPHA
  static let flicker = 0.048            // FLICKER_MS, s
  static let flickerBase = 0.08         // FLICKER_BASE
  static let flickerGrow = 0.5          // FLICKER_GROW
  static let maxJump: CGFloat = 240     // MAX_JUMP, pt
  static let maxSteps = 40              // MAX_STEPS

  /// A random neighbour offset in cells, -scatter...scatter (src/pixelTrailModel.ts: Math.round((random * 2 - 1) * SCATTER)).
  static func offset() -> Int { Int(((Double.random(in: 0..<1) * 2 - 1) * Double(scatter)).rounded()) }

  /// trailHash in src/pixelTrailModel.ts (same bits).
  static func hash(_ seed: UInt32, _ step: UInt32) -> Double {
    var h = seed ^ (step &* 0x9E37_79B1)
    h = (h ^ (h >> 16)) &* 0x85EB_CA6B
    h = (h ^ (h >> 13)) &* 0xC2B2_AE35
    h ^= h >> 16
    return Double(h) / 4_294_967_296.0
  }

  /// trailAlpha in src/pixelTrailModel.ts (age and life in seconds).
  static func alpha(age: Double, life: Double, seed: UInt32) -> Double {
    if !(age >= 0) || age >= life { return 0 }
    let t = age / life
    let step = UInt32(truncatingIfNeeded: Int(floor(age / flicker)))
    if hash(seed, step) < flickerBase + flickerGrow * t { return 0 }
    return birthAlpha * (1 - t)
  }
}

private final class DisplayLinkProxy: NSObject {
  weak var owner: TrailOverlayView?
  @objc func tick(_ link: CADisplayLink) { owner?.tick() }
}

/// The drawing surface. Never takes touches and is hidden from accessibility.
final class TrailOverlayView: UIView {
  private struct Stroke { var x: CGFloat; var y: CGFloat; var carry: CGFloat }

  var color: UIColor = .white {
    didSet {
      CATransaction.begin(); CATransaction.setDisableActions(true)
      for layer in cells { layer.backgroundColor = color.cgColor }
      CATransaction.commit()
    }
  }

  private var cells: [CALayer] = []
  private var cx = [Int](repeating: 0, count: TrailRules.maxLive)
  private var cy = [Int](repeating: 0, count: TrailRules.maxLive)
  private var size = [Int](repeating: 0, count: TrailRules.maxLive)
  private var born = [Double](repeating: -Double.infinity, count: TrailRules.maxLive)
  private var life = [Double](repeating: 0, count: TrailRules.maxLive)
  private var seed = [UInt32](repeating: 0, count: TrailRules.maxLive)
  private var head = 0
  private var until = -Double.infinity
  private var strokes: [ObjectIdentifier: Stroke] = [:]
  private var link: CADisplayLink?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isOpaque = false
    backgroundColor = .clear
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  required init?(coder: NSCoder) { return nil }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }

  func keepOnTop() {
    guard let parent = superview, parent.subviews.last !== self else { return }
    parent.bringSubviewToFront(self)
  }

  func began(_ touch: UITouch) {
    if UIAccessibility.isReduceMotionEnabled { return }
    let p = touch.location(in: self)
    strokes[ObjectIdentifier(touch)] = Stroke(x: p.x, y: p.y, carry: 0)
  }

  func moved(_ touch: UITouch, event: UIEvent) {
    let id = ObjectIdentifier(touch)
    guard strokes[id] != nil else { return }
    let now = CACurrentMediaTime()
    // Coalesced samples follow a fast finger more closely than one point per event.
    let samples = event.coalescedTouches(for: touch) ?? [touch]
    var lit = 0
    for sample in samples {
      let p = sample.location(in: self)
      lit += move(id, p.x, p.y, now)
    }
    if lit > 0 { start() }
  }

  func lifted(_ touch: UITouch) { strokes[ObjectIdentifier(touch)] = nil }
  func liftAll() { strokes.removeAll() }

  private func move(_ id: ObjectIdentifier, _ x: CGFloat, _ y: CGFloat, _ now: Double) -> Int {
    guard var stroke = strokes[id] else { return 0 }
    let dx = x - stroke.x, dy = y - stroke.y, length = hypot(dx, dy)
    if length > TrailRules.maxJump {
      strokes[id] = Stroke(x: x, y: y, carry: 0)
      return 0
    }
    var lit = 0, steps = 0
    var at = TrailRules.spacing - stroke.carry
    while at <= length && steps < TrailRules.maxSteps {
      let k = at / length
      lit += light(stroke.x + dx * k, stroke.y + dy * k, now)
      at += TrailRules.spacing
      steps += 1
    }
    stroke.carry = steps >= TrailRules.maxSteps ? 0 : length - (at - TrailRules.spacing)
    stroke.x = x; stroke.y = y
    strokes[id] = stroke
    return lit
  }

  private func light(_ x: CGFloat, _ y: CGFloat, _ now: Double) -> Int {
    let gx = Int(floor(x / TrailRules.grid)), gy = Int(floor(y / TrailRules.grid))
    var lit = cell(gx, gy, Double.random(in: 0..<1) < TrailRules.bigChance ? 2 : 1, now)
    if Double.random(in: 0..<1) < TrailRules.extraChance {
      let ox = TrailRules.offset(), oy = TrailRules.offset()
      if ox != 0 || oy != 0 { lit += cell(gx + ox, gy + oy, 1, now) }
    }
    return lit
  }

  private func cell(_ gx: Int, _ gy: Int, _ blocks: Int, _ now: Double) -> Int {
    makeLayers()
    let lifetime = TrailRules.lifeMin + Double.random(in: 0..<1) * (TrailRules.lifeMax - TrailRules.lifeMin)
    var slot = -1
    for i in 0..<TrailRules.maxLive where cx[i] == gx && cy[i] == gy && size[i] == blocks && now - born[i] < life[i] {
      slot = i
      break
    }
    if slot < 0 { slot = head; head = (head + 1) % TrailRules.maxLive }
    cx[slot] = gx; cy[slot] = gy; size[slot] = blocks
    born[slot] = now; life[slot] = lifetime; seed[slot] = UInt32.random(in: 0...UInt32.max)
    until = max(until, now + lifetime)
    let side = TrailRules.grid * CGFloat(blocks)
    CATransaction.begin(); CATransaction.setDisableActions(true)
    let layer = cells[slot]
    layer.frame = CGRect(x: CGFloat(gx) * TrailRules.grid, y: CGFloat(gy) * TrailRules.grid, width: side, height: side)
    layer.opacity = Float(TrailRules.birthAlpha)
    layer.isHidden = false
    CATransaction.commit()
    return 1
  }

  private func makeLayers() {
    guard cells.isEmpty else { return }
    let still: [String: CAAction] = ["position": NSNull(), "bounds": NSNull(), "frame": NSNull(), "opacity": NSNull(), "hidden": NSNull(), "backgroundColor": NSNull()]
    for _ in 0..<TrailRules.maxLive {
      let cell = CALayer()
      cell.actions = still
      cell.isHidden = true
      cell.backgroundColor = color.cgColor
      layer.addSublayer(cell)
      cells.append(cell)
    }
  }

  private func start() {
    guard link == nil else { return }
    let proxy = DisplayLinkProxy()
    proxy.owner = self
    let made = CADisplayLink(target: proxy, selector: #selector(DisplayLinkProxy.tick(_:)))
    made.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
    made.add(to: .main, forMode: .common)
    link = made
  }

  func stop() {
    link?.invalidate()
    link = nil
    CATransaction.begin(); CATransaction.setDisableActions(true)
    for layer in cells { layer.isHidden = true }
    CATransaction.commit()
  }

  func tick() {
    let now = CACurrentMediaTime()
    if now >= until { stop(); return }
    CATransaction.begin(); CATransaction.setDisableActions(true)
    for i in 0..<cells.count {
      let a = TrailRules.alpha(age: now - born[i], life: life[i], seed: seed[i])
      let layer = cells[i]
      if a <= 0 {
        if !layer.isHidden { layer.isHidden = true }
      } else {
        layer.isHidden = false
        layer.opacity = Float(a)
      }
    }
    CATransaction.commit()
  }

  override func removeFromSuperview() {
    stop()
    super.removeFromSuperview()
  }
}
