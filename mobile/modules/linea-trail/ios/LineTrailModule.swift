import ExpoModulesCore
import QuartzCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// «Пиксельный след» (src/PixelTrail.tsx). A window-level gesture recognizer only OBSERVES touches — it never
/// recognizes, never cancels or delays them and is never prevented by other recognizers — so the trail keeps
/// following the finger while a UIScrollView scrolls, an RNGH pan runs or a sheet is dragged (a JS onTouchMove
/// is cancelled at that moment). The touch points feed a passthrough overlay (isUserInteractionEnabled = false)
/// on top of the key window that draws a soft bloom and the lit tiles of a fixed mesh (one view, draw(_:) into the
/// dirty rect only), driven by a CADisplayLink that runs only while the light is alive. Anything missing (no key window) =
/// nothing drawn.
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
  private weak var lead: UITouch?   // the one finger that leads the light

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
    // One finger only: the first finger down leads the light; other fingers are ignored while it is on the screen.
    if lead == nil, let first = touches.first { lead = first; overlay.began(first) }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    guard let overlay else { return }
    if let lead, touches.contains(lead) { overlay.moved(lead, event: event) }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    leadLifted(touches)
    finishIfDone(event)
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    leadLifted(touches)
    finishIfDone(event)
  }

  /// The leading finger went up: its light fades; the next finger down leads.
  private func leadLifted(_ touches: Set<UITouch>) {
    if let lead, touches.contains(lead) { self.lead = nil; overlay?.released() }
  }

  // UIKit resets the recognizer after the sequence; a release here too covers any sequence that ended unseen.
  override func reset() {
    super.reset()
    if lead != nil { lead = nil; overlay?.released() }
  }

  private func finishIfDone(_ event: UIEvent) {
    let down = event.allTouches?.contains(where: { $0.phase != .ended && $0.phase != .cancelled }) ?? false
    if !down {
      if lead != nil { lead = nil; overlay?.released() }
      if state == .possible { state = .failed }
    }
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool { false }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool { false }
}

/// Mirrors TRAIL in src/pixelTrailModel.ts — keep the values and rules identical.
enum TrailRules {
  static let pitch: CGFloat = 5         // PITCH, pt
  static let dot: CGFloat = 4           // DOT, pt
  static let radius: Double = 140       // RADIUS, pt
  static let peak: Double = 0.44        // PEAK
  static let bloom: Double = 0.128      // BLOOM
  static let bloomScale: Double = 1.15  // BLOOM_SCALE
  static let life: Double = 150         // LIFE, ms (a moving light's samples)
  static let hold: Double = 1200        // HOLD, ms (the light under a finger at rest)
  static let release: Double = 300      // RELEASE, ms (fade after the finger lifts)
  static let lerp: Double = 1           // LERP (per 60 Hz frame)
  static let frameMs: Double = 1000.0 / 60
  static let sampleStep: Double = 4     // SAMPLE_STEP, pt
  static let maxSamples = 96            // MAX_SAMPLES
  static let fillStep: Double = 20      // FILL_STEP, pt
  static let fillMax = 8                // FILL_MAX
  static let stillMs: Double = 40       // STILL_MS: the pointer counts as stopped after this long without moving
  static let minWeight: Double = 0.008  // MIN_WEIGHT
  static let moving: Double = 0.3       // MOVING, pt

  /// trailCarry: the share of life left; a life switch at the same share keeps the brightness.
  static func carry(_ ms: Double, _ life: Double) -> Double { min(1, max(0, fade(ms, life))) }
  /// trailFade: even (linear) fade, 1 − ms / life.
  static func fade(_ ms: Double, _ life: Double) -> Double {
    if ms < 0 { return 1 }
    if !(ms < life) { return 0 }
    return 1 - ms / life
  }
  /// trailGlide: LERP at 60 Hz, the same speed at any refresh rate.
  static func glide(_ dt: Double) -> Double { lerp >= 1 ? 1 : 1 - pow(1 - lerp, max(0, dt) / frameMs) }
}

/// PixelTrailModel in src/pixelTrailModel.ts. Coordinates in pt, time in ms.
final class TrailModel {
  private var xs = [Double](repeating: 0, count: TrailRules.maxSamples)
  private var ys = [Double](repeating: 0, count: TrailRules.maxSamples)
  private var ts = [Double](repeating: -Double.infinity, count: TrailRules.maxSamples)
  private var ls = [Double](repeating: TrailRules.life, count: TrailRules.maxSamples)
  private var head = 0
  private var newest = -1
  // Pointer (target) and light (glides after it).
  private var tx = Double.nan, ty = Double.nan, px = Double.nan, py = Double.nan
  private var lastStep = Double.nan
  private var held = false
  private var ox = Double.nan, oy = Double.nan, moveAt = -Double.infinity   // last seen pointer and when it last moved
  // The lit tiles of the last compute: columns c0..<c0+cols, rows r0..<r0+rows, opacity per tile.
  private(set) var c0 = 0, r0 = 0, cols = 0, rows = 0, lit = 0
  private(set) var alpha: [Float] = []

  func point(_ x: Double, _ y: Double, _ now: Double) {
    if !x.isFinite || !y.isFinite { return }
    if !px.isFinite { px = x; py = y }
    tx = x; ty = y
  }

  /// A finger went down: the light is right there (no glide), with a fresh HOLD sample.
  func down(_ x: Double, _ y: Double, _ now: Double) {
    if !x.isFinite || !y.isFinite { return }
    tx = x; px = x; ty = y; py = y; held = true
    ox = x; oy = y; moveAt = now - TrailRules.stillMs   // a still touch starts fading at once
    push(x, y, now, TrailRules.hold)
  }

  /// Lift/cancel (also at the end of a fast swipe): the point where the finger was fades over HOLD, like a held finger.
  func release(_ now: Double) {
    held = false
    let n = newest
    if n >= 0 && live(n, now) && ls[n] != TrailRules.hold { ts[n] = now; ls[n] = TrailRules.hold }
    moveAt = -.infinity
  }

  func clear() {
    for i in 0..<TrailRules.maxSamples { ts[i] = -Double.infinity }
    newest = -1; lastStep = .nan; held = false; ox = .nan; oy = .nan; moveAt = -.infinity
    cols = 0; rows = 0; lit = 0
  }

  private func live(_ i: Int, _ now: Double) -> Bool { now - ts[i] < ls[i] }

  func alive(_ now: Double) -> Bool {
    for i in 0..<TrailRules.maxSamples where live(i, now) { return true }
    return false
  }

  /// Advances the light by one frame and samples it. Returns whether another frame is needed.
  /// Lights the current position with a sample born at `t` (refreshing the newest one when close), filling a fast swipe's gap.
  private func sample(_ t: Double, _ life: Double, _ dt: Double) {
    let n = newest, last = n >= 0 && ts[n] + ls[n] > t
    if last && hypot(xs[n] - px, ys[n] - py) < TrailRules.sampleStep { ts[n] = t; ls[n] = life; return }
    if last {
      let x0 = xs[n], y0 = ys[n], dx = px - x0, dy = py - y0
      let k = min(TrailRules.fillMax, Int(floor(hypot(dx, dy) / TrailRules.fillStep)))
      if k > 0 { for j in 1...k { let f = Double(j) / Double(k + 1); push(x0 + dx * f, y0 + dy * f, t - (1 - f) * dt, life) } }
    }
    push(px, py, t, life)
  }

  func step(_ now: Double) -> Bool {
    if tx.isFinite {
      if tx != ox || ty != oy { ox = tx; oy = ty; moveAt = now }
      let pointerMoving = now - moveAt < TrailRules.stillMs
      let dt = lastStep.isFinite ? min(100, now - lastStep) : TrailRules.frameMs
      let k = TrailRules.glide(dt)
      px += (tx - px) * k; py += (ty - py) * k
      let n = newest, last = n >= 0 && live(n, now)
      if pointerMoving {
        // Moving again after a rest: a held light keeps its brightness but fades as fast as the trail.
        for i in 0..<TrailRules.maxSamples where ls[i] == TrailRules.hold && live(i, now) {
          let left = TrailRules.carry(now - ts[i], TrailRules.hold)
          ls[i] = TrailRules.life; ts[i] = now - (1 - left) * TrailRules.life
        }
        sample(now, TrailRules.life, dt)
      } else if hypot(tx - px, ty - py) > TrailRules.moving {
        // The pointer stopped but the light still glides to it: it fades from the stop moment (no waiting).
        sample(moveAt, TrailRules.hold, 0)
      } else if last && ls[n] != TrailRules.hold {
        ts[n] = moveAt; ls[n] = TrailRules.hold
      }
    }
    lastStep = now
    if alive(now) { return true }
    px = tx; py = ty; lastStep = .nan
    return false
  }

  /// The bloom under the mesh: centre (pt) and opacity (0 = none).
  func bloom(_ now: Double) -> (x: Double, y: Double, alpha: Double) {
    let n = newest
    if n < 0 || !live(n, now) { return (0, 0, 0) }
    return (xs[n], ys[n], TrailRules.bloom * (1 - (now - ts[n]) / ls[n]))
  }

  /// The box (pt) of the tiles of the last compute; .null when nothing is lit.
  var bounds: CGRect {
    if cols == 0 || rows == 0 { return .null }
    return CGRect(x: CGFloat(c0) * TrailRules.pitch, y: CGFloat(r0) * TrailRules.pitch, width: CGFloat(cols) * TrailRules.pitch, height: CGFloat(rows) * TrailRules.pitch)
  }

  func compute(_ now: Double) {
    let P = Double(TrailRules.pitch), R = TrailRules.radius
    var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
    for i in 0..<TrailRules.maxSamples where live(i, now) {
      minX = min(minX, xs[i]); maxX = max(maxX, xs[i]); minY = min(minY, ys[i]); maxY = max(maxY, ys[i])
    }
    lit = 0
    if minX > maxX { cols = 0; rows = 0; return }
    c0 = Int(floor((minX - R) / P)); r0 = Int(floor((minY - R) / P))
    cols = Int(floor((maxX + R) / P)) - c0 + 1; rows = Int(floor((maxY + R) / P)) - r0 + 1
    let size = cols * rows
    if alpha.count < size { alpha = [Float](repeating: 0, count: size + size / 2) }
    for i in 0..<size { alpha[i] = 0 }
    // Each sample writes the max into the tiles inside its own circle (per row, only the columns that can be inside).
    for i in 0..<TrailRules.maxSamples {
      let strength = TrailRules.fade(now - ts[i], ls[i])
      if !(strength > 0) { continue }
      let x = xs[i], y = ys[i]
      let r1 = max(r0, Int(floor((y - R) / P))), r2 = min(r0 + rows - 1, Int(floor((y + R) / P)))
      if r1 > r2 { continue }
      for r in r1...r2 {
        let dy = Double(r) * P + P / 2 - y
        if dy * dy >= R * R { continue }
        let half = (R * R - dy * dy).squareRoot(), row = (r - r0) * cols - c0
        let c1 = max(c0, Int(ceil((x - half) / P - 0.5))), c2 = min(c0 + cols - 1, Int(floor((x + half) / P - 0.5)))
        if c1 > c2 { continue }
        for c in c1...c2 {
          let dx = Double(c) * P + P / 2 - x, d = (dx * dx + dy * dy).squareRoot() / R
          if d >= 1 { continue }
          let k = 1 - d
          let v = Float(strength * k * k * (3 - 2 * k))
          if v > alpha[row + c] { alpha[row + c] = v }
        }
      }
    }
    for i in 0..<size {
      if Double(alpha[i]) >= TrailRules.minWeight { alpha[i] *= Float(TrailRules.peak); lit += 1 } else { alpha[i] = 0 }
    }
  }

  private func push(_ x: Double, _ y: Double, _ now: Double, _ life: Double) {
    xs[head] = x; ys[head] = y; ts[head] = now; ls[head] = life
    newest = head
    head = (head + 1) % TrailRules.maxSamples
  }
}

private final class DisplayLinkProxy: NSObject {
  weak var owner: TrailOverlayView?
  @objc func tick(_ link: CADisplayLink) { owner?.tick() }
}

/// The drawing surface. Never takes touches and is hidden from accessibility. Its backing store is 1 px per pt
/// with nearest-neighbour scaling: the tiles sit on whole points (the DOT-pt square at the cell's origin rather than
/// half a point in — the same mesh, shifted by half a point), so they stay crisp at a ninth of the memory.
final class TrailOverlayView: UIView {
  var color: UIColor = .white { didSet { setNeedsDisplay() } }

  private let model = TrailModel()
  private var link: CADisplayLink?
  private var shown = CGRect.null
  private var bloomCentre = CGPoint.zero
  private var bloomAlpha: Double = 0
  private var gradient: CGGradient?
  private var gradientColor: UIColor?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isOpaque = false
    backgroundColor = .clear
    clearsContextBeforeDrawing = true
    contentMode = .redraw
    contentScaleFactor = 1
    layer.magnificationFilter = .nearest
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  required init?(coder: NSCoder) { return nil }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    contentScaleFactor = 1
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }

  func keepOnTop() {
    guard let parent = superview, parent.subviews.last !== self else { return }
    parent.bringSubviewToFront(self)
  }

  private static func now() -> Double { CACurrentMediaTime() * 1000 }

  func began(_ touch: UITouch) {
    if UIAccessibility.isReduceMotionEnabled { return }
    let p = touch.location(in: self)
    model.down(Double(p.x), Double(p.y), TrailOverlayView.now())
    start()
  }

  func moved(_ touch: UITouch, event: UIEvent) {
    if UIAccessibility.isReduceMotionEnabled { return }
    // The light glides after the latest finger position (sampled once per frame in tick()).
    let p = touch.location(in: self)
    model.point(Double(p.x), Double(p.y), TrailOverlayView.now())
    start()
  }

  /// The leading finger is up (or the touch sequence ended).
  func released() { model.release(TrailOverlayView.now()); start() }

  private func start() {
    guard link == nil, window != nil else { return }
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
    model.clear()
    bloomAlpha = 0
    if !shown.isNull { setNeedsDisplay(shown) }
    shown = .null
  }

  func tick() {
    let now = TrailOverlayView.now()
    let alive = model.step(now)
    model.compute(now)
    let glow = model.bloom(now)
    bloomCentre = CGPoint(x: glow.x, y: glow.y)
    bloomAlpha = glow.alpha
    var next = model.bounds
    if glow.alpha > 0 {
      let reach = CGFloat(TrailRules.radius * TrailRules.bloomScale)
      next = next.union(CGRect(x: bloomCentre.x - reach, y: bloomCentre.y - reach, width: reach * 2, height: reach * 2))
    }
    // Redraw only what was lit last frame plus what is lit now.
    let dirty = shown.union(next)
    if !dirty.isNull { setNeedsDisplay(dirty.integral) }
    shown = next
    // Idle = no loop once the light has faded out.
    if !alive {
      link?.invalidate()
      link = nil
    }
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    // 1) The soft bloom under the mesh, at the newest sample.
    if bloomAlpha > 0 {
      if gradient == nil || gradientColor != color {
        let space = CGColorSpaceCreateDeviceRGB()
        gradient = CGGradient(colorsSpace: space, colors: [color.cgColor, color.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 1])
        gradientColor = color
      }
      if let gradient {
        context.saveGState()
        context.setAlpha(CGFloat(bloomAlpha))
        context.drawRadialGradient(gradient, startCenter: bloomCentre, startRadius: 0, endCenter: bloomCentre, endRadius: CGFloat(TrailRules.radius * TrailRules.bloomScale), options: [])
        context.restoreGState()
      }
    }
    // 2) The tiles, on whole points (see the class comment).
    guard model.lit > 0 else { return }
    let pitch = TrailRules.pitch, dot = TrailRules.dot, inset = floor((pitch - dot) / 2)
    let rFrom = max(0, Int(floor(rect.minY / pitch)) - model.r0), rTo = min(model.rows - 1, Int(ceil(rect.maxY / pitch)) - model.r0)
    let cFrom = max(0, Int(floor(rect.minX / pitch)) - model.c0), cTo = min(model.cols - 1, Int(ceil(rect.maxX / pitch)) - model.c0)
    if rFrom > rTo || cFrom > cTo { return }
    context.setFillColor(color.cgColor)
    let alpha = model.alpha, cols = model.cols
    for r in rFrom...rTo {
      let y = CGFloat(model.r0 + r) * pitch + inset
      for c in cFrom...cTo {
        let a = alpha[r * cols + c]
        if a <= 0 { continue }
        context.setAlpha(CGFloat(a))
        context.fill(CGRect(x: CGFloat(model.c0 + c) * pitch + inset, y: y, width: dot, height: dot))
      }
    }
  }

  override func removeFromSuperview() {
    stop()
    super.removeFromSuperview()
  }
}
