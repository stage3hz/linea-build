import CoreGraphics
import ExpoModulesCore
import QuartzCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// «Снег» on the phone (src/SnowPhone.tsx, contract in ../index.ts). One transparent, non-interactive view above the
/// app draws falling snow, the caps lying on the «ledges» JS reports, the rime on frozen glass, the snow knocked or
/// swept off and the meltwater drops. A window-level gesture recognizer only OBSERVES touches (as in linea-trail):
/// it never recognizes, cancels or delays them. One shared engine (SnowEngine, main thread only) owns the state and
/// a CADisplayLink that runs only while the effect is on, the view is active and the app is in the foreground.
/// Every number and formula mirrors the approved browser demo. Anything missing = nothing drawn.
public final class LineSnowModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LineaSnow")

    Function("setEnabled") { (on: Bool) in
      DispatchQueue.main.async { SnowEngine.shared.setEnabled(on) }
    }

    Function("setLedges") { (ledges: [[String: Any]]) in
      // Parsed here into plain values, so that nothing loosely typed crosses to the main queue.
      let parsed = SnowLedgeSpec.parse(ledges)
      DispatchQueue.main.async { SnowEngine.shared.setLedges(parsed) }
    }

    Function("setDark") { (dark: Bool) in
      DispatchQueue.main.async { SnowEngine.shared.setDark(dark) }
    }

    Function("setHeat") { (heat: Double) in
      DispatchQueue.main.async { SnowEngine.shared.setHeat(heat) }
    }

    // Android only (display cutout); iOS has nothing to report.
    Function("cutout") { () -> [String: Double]? in
      return nil
    }

    View(SnowOverlayView.self) {
      Prop("active") { (view: SnowOverlayView, on: Bool?) in
        view.snowActive = on ?? true
      }
      // 'front' (default): caps and what is knocked off, above the app. 'back': only the falling flakes, mounted
      // inside a screen's background. 'rime': only the rime of the glass surface the view fills.
      Prop("layer") { (view: SnowOverlayView, layer: String?) in
        let name = layer ?? "front"
        if name == "back" {
          view.snowRole = 1
        } else if name == "rime" {
          view.snowRole = 2
        } else {
          view.snowRole = 0
        }
      }
      // Corner radius of the glass surface, pt (used by 'rime').
      Prop("radius") { (view: SnowOverlayView, radius: Double?) in
        let value = radius ?? 0
        view.snowRadius = value.isFinite ? max(0, value) : 0
      }
    }

    OnDestroy {
      DispatchQueue.main.async { SnowEngine.shared.setEnabled(false) }
    }
  }
}

/// Constants of the demo (COL, BRUSH, GAIN, FLAKES…).
enum SnowRules {
  static let col: Double = 3              // column width, pt
  static let brush: Double = 30           // sweep radius around the finger, pt
  static let gain: Double = 0.5           // cap growth per landed flake, × flake radius
  static let flakes: Double = 70          // flakes per 393×852 pt
  static let maxFlakes = 160
  static let maxParticles = 1600
  static let spriteCount = 10
  static let spriteSize: Double = 12      // pt
  static let grainTile: Double = 96       // pt
  static let gravity: Double = 1200       // pt/s²
}

/// One ledge as reported by JS (window coordinates, pt).
struct SnowLedgeSpec {
  var id: String = ""
  var x: Double = 0
  var y: Double = 0
  var width: Double = 0
  var height: Double = 0
  var radius: Double = 0
  var maxCap: Double = 6
  var glass: Bool = true

  /// A JS number may arrive as Double, Int or NSNumber.
  static func number(_ value: Any?) -> Double? {
    guard let value = value else { return nil }
    if let d = value as? Double { return d.isFinite ? d : nil }
    if let i = value as? Int { return Double(i) }
    if let n = value as? NSNumber {
      let d = n.doubleValue
      return d.isFinite ? d : nil
    }
    return nil
  }

  /// Malformed entries are skipped; a repeated id keeps its first entry.
  static func parse(_ raw: [[String: Any]]) -> [SnowLedgeSpec] {
    var out: [SnowLedgeSpec] = []
    var seen = Set<String>()
    for item in raw {
      guard let id = item["id"] as? String, !id.isEmpty, !seen.contains(id) else { continue }
      guard let x = number(item["x"]), let y = number(item["y"]) else { continue }
      guard let w = number(item["width"]), let h = number(item["height"]) else { continue }
      if w < SnowRules.col || h <= 0 || w > 8192 || h > 8192 { continue }
      if abs(x) > 100000 || abs(y) > 100000 { continue }
      var spec = SnowLedgeSpec()
      spec.id = id
      spec.x = x
      spec.y = y
      spec.width = w
      spec.height = h
      spec.radius = max(0, number(item["radius"]) ?? 0)
      spec.maxCap = max(0, min(40, number(item["max"]) ?? 6))
      if let kind = item["kind"] as? String, kind == "island" { spec.glass = false }
      seen.insert(id)
      out.append(spec)
    }
    return out
  }
}

/// The snow lying on one ledge: columns COL pt wide across its width.
final class SnowDrift {
  let id: String
  /// Lumps of the cap ceiling differ per ledge; derived from the id so that they are stable.
  let seed: Double
  var x: Double = 0
  var y: Double = 0
  var width: Double = 0
  var height: Double = 0
  var radius: Double = 0
  var maxCap: Double = 0
  var glass = true
  var n = 0
  var drop: [Double] = []   // how far the top outline is below the ledge's y at the column (corner arc)
  var base: [Double] = []   // window y where the cap sits
  var cap: [Double] = []    // ceiling of the cap
  var h: [Double] = []      // current height
  /// Heights changed since the last ground redraw: by a sweep, a knock or melting (redrawn next frame)…
  var dirty = false
  /// …or only by flakes landing (redrawn a few times per second: growth is slow).
  var landed = false
  /// Fade-in progress, 0…1: a ledge that appears (again) must not pop in.
  var appear: Double = 1
  /// The fade moved since the last ground redraw: the cap is redrawn.
  var fadeDirty = false
  /// When the ledge stopped being reported (s, media time); its drift waits in the engine's cache.
  var cachedAt: Double = 0

  /// Opacity of the cap and the sparkles (ease-out).
  var fade: Double {
    let rest = 1 - max(0, min(1, appear))
    return 1 - rest * rest
  }

  /// The next apply() rebuilds the drift from scratch.
  func forget() {
    n = 0
    width = -1
  }

  /// After a rest in the cache: not more snow than the current heat lets stay.
  func clamp(heat: Double) {
    var i = 0
    while i < n {
      h[i] = min(h[i], cap[i] * (1 - heat))
      i += 1
    }
  }

  /// Everything the cap can cover, with its shadow (window coordinates).
  var capRect: CGRect {
    return CGRect(x: x - 8, y: y - maxCap - 9, width: width + 16, height: maxCap + radius + 22)
  }

  var ledgeRect: CGRect {
    return CGRect(x: x, y: y, width: width, height: height)
  }

  init(id: String) {
    self.id = id
    var hash: UInt64 = 14695981039346656037   // FNV-1a
    for byte in id.utf8 {
      hash ^= UInt64(byte)
      hash = hash &* 1099511628211
    }
    seed = Double(hash % 6283) / 100
  }

  /// Takes the reported geometry. Heights survive a move; a new width / radius rebuilds the drift.
  func apply(_ spec: SnowLedgeSpec, heat: Double) {
    let rad = max(0, min(spec.radius, min(spec.height / 2, spec.width / 2)))
    let count = max(0, Int(floor(spec.width / SnowRules.col)))
    let reshaped = count != n || abs(rad - radius) > 0.01 || abs(spec.width - width) > 0.01
    let recapped = reshaped || abs(spec.maxCap - maxCap) > 0.001
    x = spec.x
    y = spec.y
    width = spec.width
    height = spec.height
    radius = rad
    maxCap = spec.maxCap
    glass = spec.glass
    if recapped {
      build(count, fresh: reshaped, heat: heat)
    } else {
      var i = 0
      while i < n {
        base[i] = y + drop[i] + 1
        i += 1
      }
    }
  }

  private func build(_ count: Int, fresh: Bool, heat: Double) {
    let col = SnowRules.col
    if fresh || h.count != count {
      n = count
      drop = [Double](repeating: 0, count: count)
      base = [Double](repeating: 0, count: count)
      cap = [Double](repeating: 0, count: count)
      h = [Double](repeating: 0, count: count)
    }
    var i = 0
    while i < count {
      let cx = (Double(i) + 0.5) * col
      let d = min(cx, width - cx)
      // The base follows the top arc of the rounded block: the snow hugs it instead of hanging over the corners.
      var fall = 0.0
      if d < radius {
        let k = radius - d
        fall = radius - max(0, radius * radius - k * k).squareRoot()
      }
      // On the arc the cap fades out where the edge gets too steep (below ~60% of the radius).
      var hold = 1.0
      if radius > 0 { hold = max(0, 1 - fall / (radius * 0.6)) }
      let lx = Double(i) * col
      let waveA = sin(lx / 47 + seed) * 0.5
      let waveB = sin(lx / 19 + seed * 2.3) * 0.3
      let waveC = sin(lx / 8 + seed * 5.1) * 0.2
      let lumps = 0.5 + 0.5 * (waveA + waveB + waveC)
      let ceiling = maxCap * (0.55 + 0.45 * lumps) * hold.squareRoot()
      drop[i] = fall
      base[i] = y + fall + 1
      cap[i] = ceiling
      if fresh {
        // Snow already lies on a new ledge — but not more than the current heat lets stay.
        h[i] = min(ceiling * 0.85, ceiling * (1 - heat))
      } else {
        h[i] = min(h[i], ceiling)
      }
      i += 1
    }
  }
}

struct SnowFlake {
  var x: Double = 0
  var y: Double = 0
  var r: Double = 1
  var v: Double = 20
  var phase: Double = 0
  var alpha: Double = 0.5
  var z: Double = 0
  var sprite: Int = 0
  var rot: Double = 0
  var spin: Double = 0
}

/// kind 0: grain, 1: clump, 2: meltwater drop.
struct SnowParticle {
  var kind: Int = 0
  var x: Double = 0
  var y: Double = 0
  var vx: Double = 0
  var vy: Double = 0
  var r: Double = 1
  var drag: Double = 0
  var rot: Double = 0
  var spin: Double = 0
  var end: Double = 0         // drop: where it leaves the glass and falls
  var blobs: [Double] = []    // clump: (dx, dy, radius) triples
}

/// Renders the rime of one glass surface (frost() in the demo; pure bitmap work, safe off the main thread as long
/// as one painter is used by one thread): a matte haze strongest at the rim with an irregular
/// inner boundary, fine specks near the rim and a few thin ice feathers growing inward.
final class SnowRimePainter {
  let w: Double
  let h: Double
  let corner: Double
  let reach: Double
  let light: Bool
  let seed: Double
  private var lcg: Int

  init(width: Double, height: Double, radius: Double, dark: Bool, seed: Int) {
    w = width
    h = height
    corner = max(0, min(radius, min(height / 2, width / 2)))
    reach = min(height * 0.2, 8)
    light = !dark
    self.seed = Double(seed)
    lcg = seed * 9301 + 49297
  }

  // The demo's small deterministic generator: the same ledge always freezes the same way.
  private func rand() -> Double {
    lcg = (lcg * 9301 + 49297) % 233280
    return Double(lcg) / 233280
  }

  private func hash(_ x: Double, _ y: Double) -> Double {
    let n = sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
    return n - floor(n)
  }

  /// Value noise, 0…1.
  private func noise(_ x: Double, _ y: Double) -> Double {
    let xi = floor(x)
    let yi = floor(y)
    let xf = x - xi
    let yf = y - yi
    let u = xf * xf * (3 - 2 * xf)
    let v = yf * yf * (3 - 2 * yf)
    let top = hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u
    let bottom = hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u
    return top * (1 - v) + bottom * v
  }

  /// Distance to the rim of the rounded rectangle (positive inside).
  private func inside(_ px: Double, _ py: Double) -> Double {
    let qx = abs(px - w / 2) - (w / 2 - corner)
    let qy = abs(py - h / 2) - (h / 2 - corner)
    let outer = hypot(max(qx, 0), max(qy, 0))
    let inner = min(max(qx, qy), 0)
    return corner - (outer + inner)
  }

  /// Strength of the rime at a point: from the rim inward, the boundary cut by low-frequency noise.
  private func power(_ px: Double, _ py: Double) -> Double {
    let e = inside(px, py)
    if e < 0 { return 0 }
    // Beyond twice the reach the formula below is always ≤ 0: the middle of the control stays clear (and cheap).
    if e > reach * 2 { return 0 }
    let big = noise(px / 26, py / 26)
    let mid = noise(px / 9 + 40, py / 9 + 40)
    let edge = 1 - e / (reach * (0.45 + big * 1.15))
    return max(0, min(1, edge * 1.15 + (mid - 0.5) * 0.55))
  }

  func render(scale: Double) -> CGImage? {
    if !(w > 0) || !(h > 0) || !(reach > 0) || !(scale > 0) { return nil }
    let pw = Int((w * scale).rounded())
    let ph = Int((h * scale).rounded())
    if pw <= 0 || ph <= 0 || pw > 8192 || ph > 8192 { return nil }
    let space = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: pw * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.clear(CGRect(x: 0, y: 0, width: pw, height: ph))
    guard let raw = ctx.data else { return nil }
    let rowBytes = ctx.bytesPerRow
    let pixels = raw.bindMemory(to: UInt8.self, capacity: rowBytes * ph)
    let red: Double = light ? 150 : 228
    let green: Double = light ? 185 : 240
    let blue: Double = light ? 235 : 255
    let peak: Double = light ? 0.42 : 0.3
    // 1) The haze, per pixel (premultiplied RGBA; memory row 0 is the top row of the image).
    var py = 0
    while py < ph {
      let yy = Double(py) / scale
      var px = 0
      while px < pw {
        let xx = Double(px) / scale
        let strength = power(xx, yy)
        if strength > 0 {
          let grain = 0.72 + 0.28 * noise(xx * 2.3 + 9, yy * 2.3 + 9) + (rand() - 0.5) * 0.16
          let a = max(0, min(1, pow(strength, 1.7) * peak * grain))
          let o = py * rowBytes + px * 4
          pixels[o] = UInt8(max(0, min(255, red * a)))
          pixels[o + 1] = UInt8(max(0, min(255, green * a)))
          pixels[o + 2] = UInt8(max(0, min(255, blue * a)))
          pixels[o + 3] = UInt8(max(0, min(255, a * 255)))
        }
        px += 1
      }
      py += 1
    }
    // The vector part is drawn in points with y down, like the demo's canvas.
    ctx.translateBy(x: 0, y: CGFloat(ph))
    ctx.scaleBy(x: CGFloat(scale), y: CGFloat(-scale))
    ctx.setLineCap(.round)
    // 2) Fine sub-pixel specks, only near the rim.
    let speckRed: CGFloat = light ? 110.0 / 255.0 : 1
    let speckGreen: CGFloat = light ? 150.0 / 255.0 : 1
    let speckBlue: CGFloat = light ? 215.0 / 255.0 : 1
    let specks = Int(w * h / 14)
    var k = 0
    while k < specks {
      let sx = rand() * w
      let sy = rand() * h
      let strength = power(sx, sy)
      if !(rand() > strength * strength) {
        let alpha = 0.10 + rand() * 0.22
        ctx.setFillColor(red: speckRed, green: speckGreen, blue: speckBlue, alpha: CGFloat(alpha))
        ctx.fill(CGRect(x: sx, y: sy, width: 0.5, height: 0.5))
      }
      k += 1
    }
    // 3) Ice feathers: start on the rim, point inward, bend a little and branch unevenly.
    let perimeter = 2 * (w - 2 * corner) + 2 * (h - 2 * corner) + 2 * Double.pi * corner
    let feathers = max(1, Int(perimeter / 90))
    k = 0
    while k < feathers {
      var fx = 0.0
      var fy = 0.0
      var tries = 0
      while true {
        fx = rand() * w
        if rand() < 0.5 {
          fy = rand() < 0.5 ? 1 : h - 1
        } else {
          fy = rand() * h
        }
        if fy > 1 && fy < h - 1 { fx = rand() < 0.5 ? 1 : w - 1 }
        tries += 1
        if !(inside(fx, fy) < 0) || tries >= 8 { break }
      }
      if !(inside(fx, fy) < 0) {
        let e = 1.5
        let gx = inside(fx + e, fy) - inside(fx - e, fy)
        let gy = inside(fx, fy + e) - inside(fx, fy - e)
        let angle = atan2(gy, gx) + (rand() - 0.5) * 1.1
        let length = reach * (1 + rand() * 1.4)
        feather(ctx, fx, fy, angle, length, 0)
      }
      k += 1
    }
    return ctx.makeImage()
  }

  private func feather(_ ctx: CGContext, _ px: Double, _ py: Double, _ start: Double, _ length: Double, _ depth: Int) {
    var cx = px
    var cy = py
    var angle = start
    let steps = max(3, Int(length / 2.2))
    let pace = length / Double(steps)
    let inkRed: CGFloat = light ? 120.0 / 255.0 : 245.0 / 255.0
    let inkGreen: CGFloat = light ? 160.0 / 255.0 : 250.0 / 255.0
    let inkBlue: CGFloat = light ? 225.0 / 255.0 : 1
    var t = 0
    while t < steps {
      angle += (rand() - 0.5) * 0.22
      let nx = cx + cos(angle) * pace
      let ny = cy + sin(angle) * pace
      if inside(nx, ny) < 0.5 { break }
      let part = Double(t) / Double(steps)
      let alpha = 0.22 * (1 - part) + 0.03
      let thickness = (depth > 0 ? 0.3 : 0.45) * (1 - part * 0.5)
      ctx.setStrokeColor(red: inkRed, green: inkGreen, blue: inkBlue, alpha: CGFloat(alpha))
      ctx.setLineWidth(CGFloat(thickness))
      ctx.beginPath()
      ctx.move(to: CGPoint(x: cx, y: cy))
      ctx.addLine(to: CGPoint(x: nx, y: ny))
      ctx.strokePath()
      if depth < 2 && t > 0 && rand() < 0.62 {
        let side: Double = rand() < 0.5 ? -1 : 1
        let turn = 0.75 + rand() * 0.5
        let share = 0.35 + rand() * 0.3
        feather(ctx, nx, ny, angle + side * turn, length * (1 - part) * share, depth + 1)
      }
      cx = nx
      cy = ny
      t += 1
    }
  }
}

/// CADisplayLink retains its target: a proxy keeps the engine out of that cycle.
final class SnowLinkProxy: NSObject {
  @objc func tick(_ link: CADisplayLink) { SnowEngine.shared.tick() }
}

/// The one snowfall of the app. Main thread only. Everything is in window coordinates (pt).
final class SnowEngine {
  static let shared = SnowEngine()

  private(set) var enabled = false
  private(set) var dark = true
  private var heatOverride: Double = -1   // < 0: the device's real thermal state
  private var thermal: Double = 0
  private var heat: Double = 0            // applied heat, eased towards the target
  private var foreground = true
  /// Hot and nothing left to melt: the loop sleeps until the device cools (saves the battery when it matters).
  private var sleeping = false

  private weak var canvas: SnowCanvasView?
  /// The rime views (role 'rime') that are active and in a window. They live apart from the snow: its own setting.
  private let rimeViews = NSHashTable<SnowRimeView>.weakObjects()
  /// The thermal state is watched while the snow is on OR some rime view is shown.
  private var thermalToken: NSObjectProtocol?
  /// Every front canvas in a window: when the anchor leaves, another one takes over.
  private let canvases = NSHashTable<SnowCanvasView>.weakObjects()
  /// The 'back' views (inside screen backgrounds) that show the falling flakes.
  private let flakeViews = NSHashTable<SnowFlakesView>.weakObjects()
  private var observer: SnowTouchObserver?
  private var link: CADisplayLink?
  private let proxy = SnowLinkProxy()
  private var tokens: [NSObjectProtocol] = []

  private var width: Double = 0           // window size
  private var height: Double = 0
  private var scale: Double = 2           // screen scale
  private var now: Double = 0             // ms
  private var lastTick: Double = 0        // s; 0 = the loop has just (re)started
  private var rimeStep = 50               // rime opacity in steps of 0.02, as applied to the rime views
  private var lastLandFlush: Double = 0   // ms; when landed flakes last caused a ground redraw
  private var airMoving = false           // the front air has something to show: particles, or sparkles on lying snow
  private var airShown = false            // the air view shows something that must be erased once the air is empty
  private var flakesAlive = false         // flakes are falling (drawn by the back views)
  private var flakesShown = false         // the back views show flakes that must be erased once none fall
  private var frameCount = 0
  private var slowFrames = 0
  private var fastFrames = 0
  private var airHalved = false           // the main thread struggles: the air is redrawn every other frame
  private var airSkip = false

  private var drifts: [String: SnowDrift] = [:]
  /// Drifts of ledges that are not reported right now (a covered screen, a moving control): the same snow lies
  /// there when the ledge comes back. At most 24, for 120 s.
  private var resting: [String: SnowDrift] = [:]
  private var order: [SnowDrift] = []
  private var flakes: [SnowFlake] = []
  private var liveFlakes = 0
  private var particles: [SnowParticle] = []

  // The first finger: swept snow follows its movement, a tap knocks the snow off a glass ledge.
  private var fingerDown = false
  private var fingerX: Double = 0
  private var fingerY: Double = 0
  private var prevX: Double = 0
  private var prevY: Double = 0
  private var downX: Double = 0
  private var downY: Double = 0
  private var tapId: String?

  // Pre-rendered once: aggregate sprites, the grain tile, the cap gradient.
  private var sprites: [CGImage] = []
  private var spriteScale: Double = 0
  private var grain: UIColor?
  private var capGradient: CGGradient?
  private let white = UIColor.white.cgColor
  private let capFallback = UIColor(red: 1, green: 1, blue: 1, alpha: 0.96).cgColor
  private let capShadow = UIColor(red: 40.0 / 255.0, green: 60.0 / 255.0, blue: 110.0 / 255.0, alpha: 0.35).cgColor
  private let clumpShade = UIColor(red: 201.0 / 255.0, green: 212.0 / 255.0, blue: 230.0 / 255.0, alpha: 1).cgColor
  private let dropBody = UIColor(red: 205.0 / 255.0, green: 228.0 / 255.0, blue: 1, alpha: 0.55).cgColor
  private let dropLight = UIColor(red: 1, green: 1, blue: 1, alpha: 0.9).cgColor

  private var rngState: UInt64 = 0x9E3779B97F4A7C15

  private init() {
    let salt = UInt64(Date().timeIntervalSince1970 * 1000)
    rngState = rngState ^ salt
    if rngState == 0 { rngState = 0x9E3779B97F4A7C15 }
  }

  /// Cheap generator for the hot loops (xorshift), 0 ≤ value < 1.
  private func rnd() -> Double {
    rngState ^= rngState << 13
    rngState ^= rngState >> 7
    rngState ^= rngState << 17
    return Double(rngState >> 11) / 9007199254740992.0
  }

  // MARK: Entry points (JS, the view)

  func setEnabled(_ on: Bool) {
    if on == enabled { return }
    enabled = on
    if on {
      foreground = UIApplication.shared.applicationState != .background
      updateThermalWatch()
      let centre = NotificationCenter.default
      tokens.append(centre.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
        SnowEngine.shared.setForeground(false)
      })
      tokens.append(centre.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
        SnowEngine.shared.setForeground(true)
      })
      refresh()
    } else {
      for token in tokens { NotificationCenter.default.removeObserver(token) }
      tokens.removeAll()
      detachObserver()
      stopLoop()
      drifts.removeAll()
      resting.removeAll()
      order.removeAll()
      flakes.removeAll()
      liveFlakes = 0
      particles.removeAll()
      heat = 0
      sleeping = false
      airMoving = false
      airShown = false
      flakesAlive = false
      flakesShown = false
      airHalved = false
      slowFrames = 0
      fastFrames = 0
      fingerDown = false
      tapId = nil
      width = 0
      height = 0
      canvas?.setNeedsDisplay()
      canvas?.air?.setNeedsDisplay()
      for back in flakeViews.allObjects { back.setNeedsDisplay() }
      // The rime is a separate setting: its views stay, and the heat is still watched for them.
      updateThermalWatch()
      applyRimeHeat()
    }
  }

  func setLedges(_ specs: [SnowLedgeSpec]) {
    if !enabled { return }
    var next: [String: SnowDrift] = [:]
    var list: [SnowDrift] = []
    let stamp = CACurrentMediaTime()
    for spec in specs {
      if let shown = drifts[spec.id] {
        shown.apply(spec, heat: heat)
        next[spec.id] = shown
        list.append(shown)
        continue
      }
      // The ledge appears: with the snow it had when it left (same shape only), or with fresh snow. It fades in.
      var drift = SnowDrift(id: spec.id)
      if let rested = resting[spec.id] {
        resting[spec.id] = nil
        if abs(spec.maxCap - rested.maxCap) > 0.001 { rested.forget() }
        drift = rested
      }
      drift.apply(spec, heat: heat)
      drift.clamp(heat: heat)
      drift.appear = 0
      drift.dirty = false
      drift.landed = false
      next[spec.id] = drift
      list.append(drift)
    }
    // Ledges that are gone disappear at once (nothing hangs in the air); their drifts rest in the cache.
    for (id, drift) in drifts where next[id] == nil {
      drift.cachedAt = stamp
      resting[id] = drift
    }
    pruneResting(stamp)
    drifts = next
    order = list
    refresh()
    canvas?.setNeedsDisplay()
  }

  private func pruneResting(_ stamp: Double) {
    if resting.isEmpty { return }
    for (id, drift) in resting where stamp - drift.cachedAt > 120 || stamp < drift.cachedAt {
      resting[id] = nil
    }
    while resting.count > 24 {
      var oldest: String?
      var oldestAt = Double.infinity
      for (id, drift) in resting where drift.cachedAt < oldestAt {
        oldest = id
        oldestAt = drift.cachedAt
      }
      guard let key = oldest else { break }
      resting[key] = nil
    }
  }

  func setDark(_ value: Bool) {
    if value == dark { return }
    dark = value
    // Only the rime depends on the theme; it works with the snow off too.
    for view in rimeViews.allObjects { view.refreshContents() }
  }

  func setHeat(_ value: Double) {
    if !value.isFinite { return }
    heatOverride = value < 0 ? -1 : min(1, value)
    refresh()
  }

  func attach(_ view: SnowCanvasView) {
    canvases.add(view)
    canvas = view
    let screen = view.screenScale
    if screen > 0 { scale = screen }
    prepareAssets()
    refresh()
  }

  func detach(_ view: SnowCanvasView) {
    canvases.remove(view)
    if canvas === view {
      // Another front canvas still in a window (if any) becomes the anchor.
      canvas = canvases.allObjects.first(where: { $0.window != nil && $0.hosted })
    }
    refresh()
  }

  func register(_ view: SnowFlakesView) {
    flakeViews.add(view)
  }

  func unregister(_ view: SnowFlakesView) {
    flakeViews.remove(view)
  }

  func registerRime(_ view: SnowRimeView) {
    rimeViews.add(view)
    updateThermalWatch()
    applyRimeHeat()
    view.setHeatAlpha(Double(rimeStep) / 50, animated: false)
  }

  func unregisterRime(_ view: SnowRimeView) {
    rimeViews.remove(view)
    updateThermalWatch()
  }

  /// The device's real thermal state is observed while anything depends on it.
  private func updateThermalWatch() {
    let wanted = enabled || !rimeViews.allObjects.isEmpty
    if wanted {
      if thermalToken == nil {
        thermal = SnowEngine.thermalHeat()
        // Posted on an arbitrary thread: delivered on the main queue.
        thermalToken = NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { _ in
          SnowEngine.shared.thermalChanged()
        }
      }
    } else if let token = thermalToken {
      NotificationCenter.default.removeObserver(token)
      thermalToken = nil
    }
  }

  /// The rime goes first as the phone warms up: opacity clamp(1 − heat·1.4). While the frame loop runs, the views
  /// follow the eased heat step by step; without it nothing eases the heat, so it takes the target at once and
  /// the views animate there themselves.
  private func applyRimeHeat() {
    let running = link != nil
    if !running { heat = max(0, min(1, targetHeat())) }
    let opacity = max(0, min(1, 1 - heat * 1.4))
    let step = Int((opacity * 50).rounded())
    if step == rimeStep { return }
    rimeStep = step
    let value = Double(step) / 50
    for view in rimeViews.allObjects { view.setHeatAlpha(value, animated: !running) }
  }

  private func thermalChanged() {
    thermal = SnowEngine.thermalHeat()
    refresh()
  }

  private func setForeground(_ on: Bool) {
    foreground = on
    refresh()
  }

  private static func thermalHeat() -> Double {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: return 0
    case .fair: return 0.4
    case .serious: return 0.8
    case .critical: return 1
    @unknown default: return 0
    }
  }

  private func targetHeat() -> Double {
    return heatOverride >= 0 ? heatOverride : thermal
  }

  // MARK: Touch observer and frame loop

  /// Brings the touch observer and the frame loop in line with the current state. Safe to call at any time.
  func refresh() {
    guard enabled, let view = canvas, let window = view.window else {
      detachObserver()
      stopLoop()
      applyRimeHeat()
      return
    }
    if let current = observer, current.view !== window {
      current.view?.removeGestureRecognizer(current)
      observer = nil
    }
    if observer == nil {
      let recognizer = SnowTouchObserver(target: nil, action: nil)
      window.addGestureRecognizer(recognizer)
      observer = recognizer
    }
    if sleeping && targetHeat() < 0.99 { sleeping = false }
    if foreground && !sleeping && view.canShow {
      startLoop()
    } else {
      stopLoop()
    }
    applyRimeHeat()
  }

  private func detachObserver() {
    if let current = observer { current.view?.removeGestureRecognizer(current) }
    observer = nil
    fingerDown = false
    tapId = nil
  }

  private func startLoop() {
    if link != nil { return }
    lastTick = 0
    let made = CADisplayLink(target: proxy, selector: #selector(SnowLinkProxy.tick(_:)))
    // Snow is slow: 60 Hz is plenty and halves the work on a 120 Hz display.
    made.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
    made.add(to: .main, forMode: .common)
    link = made
  }

  private func stopLoop() {
    link?.invalidate()
    link = nil
    fingerDown = false
    // A fade-in cannot go on without the loop: it ends at once.
    var finished = false
    for s in order where s.appear < 1 {
      s.appear = 1
      s.fadeDirty = false
      finished = true
    }
    if finished { canvas?.setNeedsDisplay() }
    // Flakes must not hang frozen in the backgrounds while the loop rests.
    flakesAlive = false
    if flakesShown {
      flakesShown = false
      for back in flakeViews.allObjects { back.setNeedsDisplay() }
    }
  }

  func tick() {
    guard enabled, foreground, let view = canvas, view.canShow, let window = view.window else {
      stopLoop()
      return
    }
    let seconds = CACurrentMediaTime()
    var dt = 1.0 / 60.0
    if lastTick > 0 { dt = seconds - lastTick }
    dt = min(0.05, max(0, dt))
    lastTick = seconds
    now = seconds * 1000
    resize(Double(window.bounds.width), Double(window.bounds.height))
    // The applied heat follows the target gradually (~0.25 per second).
    let ease = 0.25 * dt
    heat += max(-ease, min(ease, targetHeat() - heat))
    heat = max(0, min(1, heat))
    applyRimeHeat()
    // Ledges that have just appeared fade in over 0.9 s: quicker, the buttons seemed to jump as the app opened.
    for s in order where s.appear < 1 {
      s.appear = min(1, s.appear + dt / 0.9)
      s.fadeDirty = true
    }
    sweep()
    prevX = fingerX
    prevY = fingerY
    melt(dt)
    stepFlakes(dt)
    stepParticles(dt)
    if heat >= 0.99 && targetHeat() >= 0.99 && particles.isEmpty && !anySnow() {
      sleeping = true
      stopLoop()
    }
    flushGround(view)
    // A busy main thread (a heavy screen opening): the air is redrawn every other frame until it recovers.
    if dt > 0.036 {
      slowFrames += 1
      fastFrames = 0
      if slowFrames >= 4 { airHalved = true }
    } else {
      fastFrames += 1
      if !airHalved {
        slowFrames = 0
      } else if fastFrames >= 30 {
        airHalved = false
        slowFrames = 0
      }
    }
    airSkip = !airSkip
    frameCount = (frameCount + 1) % 1024
    let skip = airHalved && airSkip
    // The front air: every frame while something falls off; a low rate is enough for the sparkles on lying snow.
    let falling = !particles.isEmpty
    let lying = anySnow()
    airMoving = falling || lying
    if let air = view.air {
      if falling {
        if !skip {
          air.setNeedsDisplay()
          airShown = true
        }
      } else if lying {
        if frameCount % 4 == 0 {
          air.setNeedsDisplay()
          airShown = true
        }
      } else if airShown {
        // Nothing to show any more: one last redraw erases what was shown, then the air view rests.
        air.setNeedsDisplay()
        airShown = false
      }
    }
    // The falling flakes: drawn by the back views that are active and in a window.
    flakesAlive = link != nil && !sleeping && liveFlakes > 0
    if flakesAlive {
      if !skip {
        for back in flakeViews.allObjects where back.canShow { back.setNeedsDisplay() }
        flakesShown = true
      }
    } else if flakesShown {
      flakesShown = false
      for back in flakeViews.allObjects { back.setNeedsDisplay() }
    }
  }

  /// Redraws the ground (the caps) only where something changed since its last redraw.
  private func flushGround(_ view: SnowCanvasView) {
    var changed = CGRect.null
    let flushLanded = now - lastLandFlush >= 100 || now < lastLandFlush
    for s in order {
      if s.dirty || (flushLanded && s.landed) {
        changed = changed.union(s.capRect)
        s.dirty = false
        s.landed = false
      }
      if s.fadeDirty {
        changed = changed.union(s.capRect)
        s.fadeDirty = false
      }
    }
    if flushLanded { lastLandFlush = now }
    if changed.isNull { return }
    let corner = view.convert(CGPoint.zero, to: nil)
    let local = changed.offsetBy(dx: -corner.x, dy: -corner.y).intersection(view.bounds)
    if local.isNull || local.isEmpty { return }
    view.setNeedsDisplay(local.integral)
  }

  private func anySnow() -> Bool {
    for s in order {
      var i = 0
      while i < s.n {
        if s.h[i] > 0.1 { return true }
        i += 1
      }
    }
    return false
  }

  /// FLAKES per 393×852 pt, scaled by the window area.
  private func resize(_ w: Double, _ h: Double) {
    if !(w > 0) || !(h > 0) { return }
    width = w
    height = h
    let area = w * h / (393.0 * 852.0)
    let wanted = max(1, min(SnowRules.maxFlakes, Int((SnowRules.flakes * area).rounded())))
    if flakes.count == wanted { return }
    while flakes.count < wanted { flakes.append(makeFlake(anywhere: true)) }
    while flakes.count > wanted { flakes.removeLast() }
  }

  private func makeFlake(anywhere: Bool) -> SnowFlake {
    let z = rnd()
    var f = SnowFlake()
    f.x = rnd() * width
    f.y = anywhere ? rnd() * height : -5
    f.r = 0.5 + z * z * 1.5
    f.v = 20 + z * 46
    f.phase = rnd() * 6.28
    f.alpha = 0.25 + z * 0.6
    f.z = z
    f.sprite = min(SnowRules.spriteCount - 1, Int(rnd() * Double(SnowRules.spriteCount)))
    f.rot = rnd() * 6.28
    f.spin = (rnd() - 0.5) * 1.6
    return f
  }

  // MARK: Simulation

  private func stepFlakes(_ dt: Double) {
    let col = SnowRules.col
    let wind = sin(now / 5200) * 12 + sin(now / 1700) * 4
    let room = 1 - heat
    // With heat it snows less: only the first part of the flakes is alive.
    liveFlakes = max(0, min(flakes.count, Int((Double(flakes.count) * (1 - heat * 0.85)).rounded())))
    var k = 0
    while k < liveFlakes {
      var f = flakes[k]
      f.y += f.v * dt
      let sway = sin(now / 900 + f.phase) * 9
      f.x += (wind * f.r * 0.5 + sway) * dt
      if f.x < -4 {
        f.x = width + 4
      } else if f.x > width + 4 {
        f.x = -4
      }
      var landed = f.y > height + 5
      if !landed {
        for s in order {
          let offset = (f.x - s.x) / col
          if offset < 0 || offset >= Double(s.n) { continue }
          let i = Int(offset)
          if i < 0 || i >= s.n { continue }
          let top = s.base[i] - s.h[i]
          if f.y >= top && f.y < top + 7 {
            let limit = s.cap[i] * room
            if s.h[i] < limit {
              s.h[i] = min(limit, s.h[i] + f.r * SnowRules.gain)
              s.landed = true
            }
            landed = true
            break
          }
        }
      }
      if landed {
        flakes[k] = makeFlake(anywhere: false)
      } else {
        if f.z >= 0.35 { f.rot += f.spin * dt }
        flakes[k] = f
      }
      k += 1
    }
  }

  /// Caps melt down to the share (1 − heat); meltwater creeps down the glass in drops.
  private func melt(_ dt: Double) {
    if heat <= 0 { return }
    let col = SnowRules.col
    let rate = (1.2 + heat * 5) * dt
    let chance = dt * (0.12 + heat * 0.5)
    for s in order {
      var i = 0
      while i < s.n {
        let limit = s.cap[i] * (1 - heat)
        if s.h[i] > limit + 0.05 {
          s.h[i] = max(limit, s.h[i] - rate)
          s.dirty = true
          if rnd() < chance && particles.count < SnowRules.maxParticles {
            var p = SnowParticle()
            p.kind = 2
            p.x = s.x + (Double(i) + 0.5) * col
            p.y = s.base[i] + 1
            p.vy = 6 + rnd() * 10
            p.end = s.base[i] + s.height * (0.5 + rnd() * 0.5)
            p.r = 0.9 + rnd() * 0.8
            particles.append(p)
          }
        }
        i += 1
      }
    }
  }

  /// The moving finger sweeps the snow within BRUSH pt off the caps.
  private func sweep() {
    if !fingerDown { return }
    let dx = fingerX - prevX
    let dy = fingerY - prevY
    if hypot(dx, dy) < 0.5 { return }
    let col = SnowRules.col
    let brush = SnowRules.brush
    for s in order {
      if s.n == 0 { continue }
      let lo = (fingerX - brush - s.x) / col
      let hi = (fingerX + brush - s.x) / col
      if hi < 0 || lo > Double(s.n) { continue }
      let i0 = max(0, Int(floor(max(0, lo))))
      let i1 = min(s.n - 1, Int(ceil(min(Double(s.n), hi))))
      var i = i0
      while i <= i1 {
        let snow = s.h[i]
        if snow > 0.3 {
          let cx = s.x + Double(i) * col
          let d = hypot(cx - fingerX, s.base[i] - snow / 2 - fingerY)
          if d <= brush {
            let take = min(snow, snow * (1 - d / brush) * 0.9 + 0.4)
            s.h[i] = snow - take
            s.dirty = true
            if take > 0.5 { shed(cx, s.base[i] - s.h[i], take * col, dx * 5, -8, col) }
          }
        }
        i += 1
      }
    }
  }

  /// A tap inside a glass ledge knocks the snow off: the whole cap of a small control, the stretch under the finger
  /// of a wide one. A thin uneven crust stays.
  private func knock(_ s: SnowDrift, _ tapX: Double) {
    let col = SnowRules.col
    let n = s.n
    let wide = Double(n) * col > 130
    let reach: Double = wide ? 46 : 1e9
    let mid = s.x + Double(n) * col / 2
    var i = 0
    while i < n {
      let px = s.x + (Double(i) + 1.5) * col
      let d = abs(px - tapX)
      if d <= reach {
        var amount = 0.0
        var top = 1e9
        let stop = min(n, i + 3)
        var q = i
        while q < stop {
          var keep = rnd() * 0.12
          if wide { keep += pow(d / reach, 2.4) }
          keep = min(1, keep)
          amount += s.h[q] * (1 - keep) * col
          top = min(top, s.base[q] - s.h[q])
          s.h[q] = s.h[q] * keep
          q += 1
        }
        if amount > 1 {
          let push = wide ? (px - tapX) * 0.8 : (px - mid) * 1.6
          shed(px, top + 2, amount * 1.6, push, -22, col * 3)
        }
      }
      i += 3
    }
    s.dirty = true
  }

  /// Snow torn off a cap: its volume splits into loose clumps and a trail of fine grains.
  private func shed(_ x: Double, _ y: Double, _ amount: Double, _ vx: Double, _ vy: Double, _ spread: Double) {
    var left = amount
    while left > 6 {
      let r = min(5.5, 1.2 + pow(rnd(), 2.2) * left.squareRoot() * 0.7)
      let cx = x + (rnd() - 0.5) * spread
      let cy = y - rnd() * 3
      let cvx = vx + (rnd() - 0.5) * 46
      let cvy = vy - rnd() * 45
      addClump(cx, cy, cvx, cvy, r)
      left -= r * r * 2.2
    }
    let grains = Int(ceil(min(60, 6 + amount * 0.9)))
    var k = 0
    while k < grains {
      let gx = x + (rnd() - 0.5) * spread
      let gy = y - rnd() * 4
      let gvx = vx * 0.8 + (rnd() - 0.5) * 90
      let gvy = vy * 0.6 - rnd() * 70
      addGrain(gx, gy, gvx, gvy)
      k += 1
    }
  }

  private func addClump(_ x: Double, _ y: Double, _ vx: Double, _ vy: Double, _ r: Double) {
    if particles.count > SnowRules.maxParticles { return }
    let count = 3 + min(2, Int(rnd() * 3))
    var blobs: [Double] = [0, 0, r]
    blobs.reserveCapacity(count * 3)
    var k = 1
    while k < count {
      let a = rnd() * 6.283
      let d = r * (0.45 + rnd() * 0.45)
      blobs.append(cos(a) * d)
      blobs.append(sin(a) * d)
      blobs.append(r * (0.45 + rnd() * 0.4))
      k += 1
    }
    var p = SnowParticle()
    p.kind = 1
    p.x = x
    p.y = y
    p.vx = vx
    p.vy = vy
    p.r = r
    p.blobs = blobs
    p.rot = rnd() * 6.28
    p.spin = (rnd() - 0.5) * 6
    p.drag = 0.25 + 1.2 / r
    particles.append(p)
  }

  private func addGrain(_ x: Double, _ y: Double, _ vx: Double, _ vy: Double) {
    if particles.count > SnowRules.maxParticles { return }
    var p = SnowParticle()
    p.kind = 0
    p.x = x
    p.y = y
    p.vx = vx
    p.vy = vy
    p.r = 0.45 + rnd() * 0.75
    p.drag = 2.2 + rnd() * 2.2
    particles.append(p)
  }

  /// Clumps, grains and drops are never faded: they leave only below the bottom of the window.
  private func stepParticles(_ dt: Double) {
    var k = particles.count - 1
    while k >= 0 {
      var p = particles[k]
      var gone = false
      if p.kind == 2 {
        // A drop creeps down the glass, gathers speed, then breaks off and falls.
        if p.y < p.end {
          p.vy += 22 * dt
        } else {
          p.vy += SnowRules.gravity * dt
        }
        p.y += p.vy * dt
        gone = p.y > height + 10
      } else {
        p.vy += SnowRules.gravity * dt
        let keep = max(0, 1 - p.drag * dt)
        p.vx *= keep
        p.vy *= keep
        p.x += p.vx * dt
        p.y += p.vy * dt
        if p.kind == 1 { p.rot += p.spin * dt }
        gone = p.y > height + 20
      }
      if gone {
        // Order does not matter: the last one takes the freed place.
        let last = particles.count - 1
        if k != last { particles[k] = particles[last] }
        particles.removeLast()
      } else {
        particles[k] = p
      }
      k -= 1
    }
  }

  // MARK: Touches (window coordinates; observed, never consumed)

  func touchBegan(_ point: CGPoint) {
    if link == nil { return }
    let x = Double(point.x)
    let y = Double(point.y)
    if !x.isFinite || !y.isFinite { return }
    fingerDown = true
    fingerX = x
    fingerY = y
    prevX = x
    prevY = y
    downX = x
    downY = y
    tapId = nil
    for s in order where s.glass {
      if x >= s.x && x <= s.x + s.width && y >= s.y && y <= s.y + s.height {
        tapId = s.id
        break
      }
    }
  }

  func touchMoved(_ point: CGPoint) {
    if !fingerDown { return }
    let x = Double(point.x)
    let y = Double(point.y)
    if !x.isFinite || !y.isFinite { return }
    fingerX = x
    fingerY = y
  }

  func touchEnded(_ point: CGPoint, cancelled: Bool) {
    let wasDown = fingerDown
    let id = tapId
    fingerDown = false
    tapId = nil
    if !wasDown || cancelled || link == nil { return }
    let x = Double(point.x)
    let y = Double(point.y)
    if !x.isFinite || !y.isFinite { return }
    guard let key = id, let drift = drifts[key] else { return }
    if hypot(x - downX, y - downY) > 10 { return }
    knock(drift, x)
  }

  func touchLost() {
    fingerDown = false
    tapId = nil
  }

  // MARK: Pre-rendered assets

  private func prepareAssets() {
    let wanted = min(3, max(1, scale))
    if capGradient == nil {
      let space = CGColorSpaceCreateDeviceRGB()
      let top = UIColor(red: 1, green: 1, blue: 1, alpha: 0.96).cgColor
      let low = UIColor(red: 214.0 / 255.0, green: 224.0 / 255.0, blue: 240.0 / 255.0, alpha: 0.92).cgColor
      let stops: [CGFloat] = [0, 1]
      capGradient = CGGradient(colorsSpace: space, colors: [top, low] as CFArray, locations: stops)
    }
    if grain == nil {
      // Grain of the cap surface: 1 pt specks, half white, half cold shadows between the grains.
      let side = SnowRules.grainTile
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = false
      let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
      let tile = renderer.image { rc in
        let c = rc.cgContext
        var k = 0
        while k < 1500 {
          if Double.random(in: 0..<1) < 0.5 {
            let a = 0.10 + Double.random(in: 0..<1) * 0.22
            c.setFillColor(red: 120.0 / 255.0, green: 145.0 / 255.0, blue: 190.0 / 255.0, alpha: CGFloat(a))
          } else {
            let a = 0.3 + Double.random(in: 0..<1) * 0.5
            c.setFillColor(red: 1, green: 1, blue: 1, alpha: CGFloat(a))
          }
          let px = Double.random(in: 0..<1) * side
          let py = Double.random(in: 0..<1) * side
          c.fill(CGRect(x: px, y: py, width: 1, height: 1))
          k += 1
        }
      }
      grain = UIColor(patternImage: tile)
    }
    if sprites.isEmpty || spriteScale != wanted {
      // A snowflake that reaches the ground is a loose aggregate of crystals, not a six-armed star:
      // a few small soft ellipses stuck together, every sprite of its own shape.
      let side = SnowRules.spriteSize
      let format = UIGraphicsImageRendererFormat()
      format.scale = CGFloat(wanted)
      format.opaque = false
      let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
      let glow = UIColor(red: 1, green: 1, blue: 1, alpha: 0.9).cgColor
      let ink = UIColor.white.cgColor
      var made: [CGImage] = []
      var index = 0
      while index < SnowRules.spriteCount {
        let image = renderer.image { rc in
          let c = rc.cgContext
          c.translateBy(x: CGFloat(side / 2), y: CGFloat(side / 2))
          c.setShadow(offset: CGSize.zero, blur: 1.2, color: glow)
          c.setFillColor(ink)
          let parts = 3 + min(4, Int(Double.random(in: 0..<1) * 5))
          var m = 0
          while m < parts {
            let a = Double.random(in: 0..<1) * 6.283
            let r = Double.random(in: 0..<1) * 2.2
            let rx = 0.5 + Double.random(in: 0..<1) * 1.1
            let ry = 0.4 + Double.random(in: 0..<1) * 0.7
            let turn = Double.random(in: 0..<1) * 3
            c.saveGState()
            c.translateBy(x: CGFloat(cos(a) * r), y: CGFloat(sin(a) * r))
            c.rotate(by: CGFloat(turn))
            c.setAlpha(CGFloat(0.55 + Double.random(in: 0..<1) * 0.45))
            c.fillEllipse(in: CGRect(x: -rx, y: -ry, width: rx * 2, height: ry * 2))
            c.restoreGState()
            m += 1
          }
        }
        if let cg = image.cgImage { made.append(cg) }
        index += 1
      }
      sprites = made
      spriteScale = wanted
    }
  }

  // MARK: Drawing (called from the view's draw(_:); `origin` is the view's corner in the window)

  /// The ground: the caps. `rect` is the part of the view being redrawn.
  func draw(in context: CGContext, origin: CGPoint, view: SnowCanvasView, rect: CGRect) {
    guard enabled, let current = canvas, current === view else { return }
    let part = rect.offsetBy(dx: origin.x, dy: origin.y)
    context.saveGState()
    context.translateBy(x: -origin.x, y: -origin.y)
    drawCaps(context, part)
    context.restoreGState()
  }

  /// The front air: sparkles, clumps, grains and drops.
  func drawAir(in context: CGContext, origin: CGPoint, view: SnowAirView) {
    guard enabled, airMoving, let current = canvas, let air = current.air, air === view else { return }
    context.saveGState()
    context.translateBy(x: -origin.x, y: -origin.y)
    drawSparkles(context)
    drawParticles(context)
    context.restoreGState()
  }

  /// A back view: the falling flakes, behind the app's content. `origin` is the view's corner in the window.
  func drawBack(in context: CGContext, origin: CGPoint) {
    guard enabled, flakesAlive else { return }
    context.saveGState()
    context.translateBy(x: -origin.x, y: -origin.y)
    drawFlakes(context)
    context.restoreGState()
  }

  private func drawCaps(_ context: CGContext, _ part: CGRect) {
    let col = SnowRules.col
    for s in order {
      let n = s.n
      if n < 2 { continue }
      if !s.capRect.intersects(part) { continue }
      let fade = s.fade
      if fade <= 0.003 { continue }
      var top = 1e9
      var i = 0
      while i < n {
        top = min(top, s.base[i] - s.h[i])
        i += 1
      }
      context.saveGState()
      // The transparency layer below is only as large as the cap and its shadow — the same rect that is
      // invalidated when the cap changes, so nothing is ever drawn outside a redrawn area.
      context.clip(to: s.capRect)
      // The layer is composited with the fade-in opacity, shadow included.
      context.setAlpha(CGFloat(fade))
      // One soft shadow for the whole cap (gradient + grain), not one per drawing call.
      context.setShadow(offset: CGSize(width: 0, height: 1), blur: 3, color: capShadow)
      context.beginTransparencyLayer(auxiliaryInfo: nil)
      context.beginPath()
      i = 0
      while i < n {
        // Smoothed top over the neighbours.
        let a = i > 0 ? s.h[i - 1] : 0.0
        let b = s.h[i]
        let c = i < n - 1 ? s.h[i + 1] : 0.0
        let px = s.x + (Double(i) + 0.5) * col
        let py = s.base[i] - (a + 2 * b + c) / 4
        if i == 0 {
          context.move(to: CGPoint(x: px, y: py))
        } else {
          context.addLine(to: CGPoint(x: px, y: py))
        }
        i += 1
      }
      i = n - 1
      while i >= 0 {
        let px = s.x + (Double(i) + 0.5) * col
        context.addLine(to: CGPoint(x: px, y: s.base[i] + 0.5))
        i -= 1
      }
      context.closePath()
      context.clip()
      if let gradient = capGradient {
        let options: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: top), end: CGPoint(x: 0, y: top + 9), options: options)
      } else {
        context.setFillColor(capFallback)
        context.fill(CGRect(x: s.x - 2, y: top - 2, width: Double(n) * col + 4, height: 60))
      }
      if let pattern = grain {
        context.setAlpha(0.5)
        pattern.setFill()
        context.fill(CGRect(x: s.x - 2, y: top - 2, width: Double(n) * col + 4, height: 40))
        context.setAlpha(1)
      }
      context.endTransparencyLayer()
      context.restoreGState()
    }
  }

  /// Sparkles: single crystal faces catch the light for a moment; their places hop every 2.6 s. They live in the
  /// air view, so that the ground is not redrawn for them.
  private func drawSparkles(_ context: CGContext) {
    let col = SnowRules.col
    let hop = Int(now / 2600) % 100000
    for s in order {
      let n = s.n
      if n < 2 { continue }
      let count = max(1, Int(ceil(Double(n) / 22)))
      context.setFillColor(white)
      var q = 0
      while q < count {
        let at = (q * 37 + 11 + hop * 13 + q * 7) % n
        let snow = s.h[at]
        if snow >= 2 {
          let wave = max(0, sin(now / 330 + Double(q) * 2.1 + s.x))
          let twinkle = pow(wave, 10)
          if twinkle >= 0.05 {
            let sx = s.x + (Double(at) + 0.5) * col
            let sy = s.base[at] - snow * 0.6
            context.setAlpha(CGFloat(twinkle * s.fade))
            context.fill(CGRect(x: sx - 1.6, y: sy - 0.3, width: 3.2, height: 0.6))
            context.fill(CGRect(x: sx - 0.3, y: sy - 1.6, width: 0.6, height: 3.2))
          }
        }
        q += 1
      }
    }
    context.setAlpha(1)
  }

  private func drawFlakes(_ context: CGContext) {
    let count = min(liveFlakes, flakes.count)
    let half = SnowRules.spriteSize / 2
    let box = CGRect(x: -half, y: -half, width: SnowRules.spriteSize, height: SnowRules.spriteSize)
    context.setFillColor(white)
    var k = 0
    while k < count {
      let f = flakes[k]
      context.setAlpha(CGFloat(f.alpha))
      if f.z < 0.35 || f.sprite >= sprites.count {
        // Far flakes are plain pale dots.
        context.fillEllipse(in: CGRect(x: f.x - f.r, y: f.y - f.r, width: f.r * 2, height: f.r * 2))
      } else {
        let size = CGFloat(0.45 + f.z * 0.75)
        context.saveGState()
        context.translateBy(x: CGFloat(f.x), y: CGFloat(f.y))
        context.rotate(by: CGFloat(f.rot))
        context.scaleBy(x: size, y: size)
        context.draw(sprites[f.sprite], in: box)
        context.restoreGState()
      }
      k += 1
    }
    context.setAlpha(1)
  }

  private func drawParticles(_ context: CGContext) {
    if particles.isEmpty { return }
    context.setAlpha(1)
    var grains = 0
    for p in particles {
      if p.kind == 0 {
        grains += 1
      } else if p.kind == 2 {
        var stretch = 1.0
        if !(p.y < p.end) { stretch = min(2.4, 1 + p.vy / 260) }
        let ry = p.r * 1.35 * stretch
        context.setFillColor(dropBody)
        context.fillEllipse(in: CGRect(x: p.x - p.r, y: p.y - ry, width: p.r * 2, height: ry * 2))
        context.setFillColor(dropLight)
        context.fill(CGRect(x: p.x - p.r * 0.35, y: p.y - p.r * 0.6, width: p.r * 0.45, height: p.r * 0.45))
      } else {
        // A clump: the cold underside first, then the white body — reads as loose volume.
        let c = cos(p.rot)
        let sn = sin(p.rot)
        let blobs = p.blobs
        let total = blobs.count / 3
        context.setFillColor(clumpShade)
        context.beginPath()
        var b = 0
        while b < total {
          let ax = blobs[b * 3]
          let ay = blobs[b * 3 + 1]
          let br = blobs[b * 3 + 2]
          let bx = p.x + ax * c - ay * sn
          let by = p.y + ax * sn + ay * c + 0.7
          context.addEllipse(in: CGRect(x: bx - br, y: by - br, width: br * 2, height: br * 2))
          b += 1
        }
        context.fillPath()
        context.setFillColor(white)
        context.beginPath()
        b = 0
        while b < total {
          let ax = blobs[b * 3]
          let ay = blobs[b * 3 + 1]
          let br = blobs[b * 3 + 2] * 0.9
          let bx = p.x + ax * c - ay * sn
          let by = p.y + ax * sn + ay * c - 0.3
          context.addEllipse(in: CGRect(x: bx - br, y: by - br, width: br * 2, height: br * 2))
          b += 1
        }
        context.fillPath()
      }
    }
    if grains > 0 {
      // All grains are opaque white dots: one path, one fill.
      context.setFillColor(white)
      context.beginPath()
      for p in particles where p.kind == 0 {
        context.addEllipse(in: CGRect(x: p.x - p.r, y: p.y - p.r, width: p.r * 2, height: p.r * 2))
      }
      context.fillPath()
    }
  }
}

/// Watches the touches of the window and never takes part in gesture arbitration: it stays .possible while fingers
/// are down and fails when the last one lifts. Only the first finger is followed. Points are in window coordinates.
final class SnowTouchObserver: UIGestureRecognizer, UIGestureRecognizerDelegate {
  private weak var lead: UITouch?

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
    if lead == nil, let first = touches.first {
      lead = first
      SnowEngine.shared.touchBegan(first.location(in: view))
    }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    if let finger = lead, touches.contains(finger) {
      SnowEngine.shared.touchMoved(finger.location(in: view))
    }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    leadLifted(touches, cancelled: false)
    finishIfDone(event)
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    leadLifted(touches, cancelled: true)
    finishIfDone(event)
  }

  private func leadLifted(_ touches: Set<UITouch>, cancelled: Bool) {
    if let finger = lead, touches.contains(finger) {
      let point = finger.location(in: view)
      lead = nil
      SnowEngine.shared.touchEnded(point, cancelled: cancelled)
    }
  }

  // UIKit resets the recognizer after the sequence; this also covers a sequence that ended unseen.
  override func reset() {
    super.reset()
    if lead != nil {
      lead = nil
      SnowEngine.shared.touchLost()
    }
  }

  private func finishIfDone(_ event: UIEvent) {
    let down = event.allTouches?.contains(where: { $0.phase != .ended && $0.phase != .cancelled }) ?? false
    if !down {
      if lead != nil {
        lead = nil
        SnowEngine.shared.touchLost()
      }
      if state == .possible { state = .failed }
    }
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool { false }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool { false }
}

/// The view the app mounts above everything (src/SnowPhone.tsx): a passthrough container for the canvas.
final class SnowOverlayView: ExpoView {
  let canvas = SnowCanvasView(frame: .zero)   // front, the ground: the caps, redrawn only where they change
  let air = SnowAirView(frame: .zero)         // front, the air: sparkles and what falls off, at 1 px per pt
  let flakes = SnowFlakesView(frame: .zero)   // back: the falling flakes, at 1 px per pt
  let rime = SnowRimeView(frame: .zero)       // rime: the rime of the glass surface this view fills

  /// The `active` prop.
  var snowActive = true { didSet { if snowActive != oldValue { applyRole() } } }
  /// The `layer` prop: 0 = 'front' (the engine's anchor), 1 = 'back' (flakes only), 2 = 'rime' (rime only).
  /// Only 'front' can be the anchor and brings the touch observer.
  var snowRole = 0 { didSet { if snowRole != oldValue { applyRole() } } }
  /// The `radius` prop (for 'rime').
  var snowRadius: Double = 0 { didSet { if snowRadius != oldValue { applyRole() } } }

  /// The props may arrive after init and in any order: the role is applied again on every change.
  private func applyRole() {
    let front = snowRole == 0
    let back = snowRole == 1
    let frost = snowRole == 2
    canvas.isHidden = !front
    air.isHidden = !front
    flakes.isHidden = !back
    rime.isHidden = !frost
    canvas.hosted = front
    canvas.active = front && snowActive
    flakes.active = back && snowActive
    rime.radius = snowRadius
    rime.active = frost && snowActive
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    backgroundColor = .clear
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    canvas.frame = bounds
    canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(canvas)
    air.frame = bounds
    air.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(air)
    canvas.air = air
    air.ground = canvas
    flakes.frame = bounds
    flakes.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(flakes)
    rime.frame = bounds
    rime.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(rime)
    applyRole()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if canvas.frame != bounds { canvas.frame = bounds }
    if air.frame != bounds { air.frame = bounds }
    if flakes.frame != bounds { flakes.frame = bounds }
    if rime.frame != bounds { rime.frame = bounds }
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
}

/// The ground surface (the caps) and the engine's anchor in the window. Never takes touches and is hidden from
/// accessibility. Its backing store is at most 2 px per pt; it is redrawn only where the snow on a ledge changed.
final class SnowCanvasView: UIView {
  /// The sibling that shows everything in the air.
  weak var air: SnowAirView?

  /// false: this canvas belongs to a 'back' or 'rime' view — it never becomes the engine's anchor.
  var hosted = true {
    didSet {
      if hosted != oldValue { syncAnchor() }
    }
  }
  private var attached = false

  /// Only a hosted canvas in a window talks to the engine: there may be dozens of 'rime' views.
  private func syncAnchor() {
    if hosted && window != nil {
      attached = true
      SnowEngine.shared.attach(self)
    } else if attached {
      attached = false
      SnowEngine.shared.detach(self)
    }
  }

  /// false: both views draw nothing and the frame loop sleeps.
  var active = true {
    didSet {
      if active != oldValue {
        setNeedsDisplay()
        air?.setNeedsDisplay()
        SnowEngine.shared.refresh()
      }
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isOpaque = false
    backgroundColor = .clear
    clearsContextBeforeDrawing = true
    contentMode = .redraw
    isAccessibilityElement = false
    accessibilityElementsHidden = true
  }

  required init?(coder: NSCoder) { return nil }

  var screenScale: Double {
    if let screen = window?.windowScene?.screen { return Double(screen.scale) }
    let trait = Double(traitCollection.displayScale)
    return trait > 0 ? trait : 2
  }

  /// In a window, active, not hidden, not empty.
  var canShow: Bool {
    return window != nil && hosted && active && !isHidden && bounds.width > 0 && bounds.height > 0
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { contentScaleFactor = CGFloat(min(2, max(1, screenScale))) }
    syncAnchor()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // The loop waits for a non-empty view.
    if attached { SnowEngine.shared.refresh() }
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }

  override func draw(_ rect: CGRect) {
    guard active, window != nil, let context = UIGraphicsGetCurrentContext() else { return }
    // The engine works in window coordinates.
    let corner = convert(CGPoint.zero, to: nil)
    SnowEngine.shared.draw(in: context, origin: corner, view: self, rect: rect)
  }
}

/// The front air surface: sparkles, clumps, grains and drops. It is redrawn every frame while anything falls off
/// (and a few times per second for the sparkles), so its backing store is 1 px per pt: soft dots look the same and
/// cost a quarter of the pixels.
final class SnowAirView: UIView {
  weak var ground: SnowCanvasView?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isOpaque = false
    backgroundColor = .clear
    clearsContextBeforeDrawing = true
    contentMode = .redraw
    contentScaleFactor = 1
    isAccessibilityElement = false
    accessibilityElementsHidden = true
  }

  required init?(coder: NSCoder) { return nil }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // UIKit resets the scale to the screen's when the view enters a window.
    contentScaleFactor = 1
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }

  override func draw(_ rect: CGRect) {
    guard let owner = ground, owner.active, window != nil, let context = UIGraphicsGetCurrentContext() else { return }
    let corner = convert(CGPoint.zero, to: nil)
    SnowEngine.shared.drawAir(in: context, origin: corner, view: self)
  }
}

/// A 'back' surface: only the falling flakes, mounted inside a screen's background (the app backdrop, a chat
/// wallpaper…), so the snow falls behind the content. Several can be mounted at once; each draws the part of the
/// window-wide snowfall that falls on it. 1 px per pt. Never takes touches and is hidden from accessibility.
final class SnowFlakesView: UIView {
  /// false: a background kept mounted under another one — nothing is drawn.
  var active = false {
    didSet {
      if active != oldValue {
        setNeedsDisplay()
        syncEngine()
      }
    }
  }

  /// Only an active view in a window is on the engine's list (every LineaSnow view hosts one of these).
  private func syncEngine() {
    if active && window != nil {
      SnowEngine.shared.register(self)
    } else {
      SnowEngine.shared.unregister(self)
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isOpaque = false
    backgroundColor = .clear
    clearsContextBeforeDrawing = true
    contentMode = .redraw
    // Background snow is dimmed: at full brightness the flakes outshone the grey text they pass behind and
    // read as lying on top of it.
    alpha = 0.45
    contentScaleFactor = 1
    isAccessibilityElement = false
    accessibilityElementsHidden = true
  }

  required init?(coder: NSCoder) { return nil }

  /// In a window, active, not hidden, not empty.
  var canShow: Bool {
    return window != nil && active && !isHidden && bounds.width > 0 && bounds.height > 0
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // UIKit resets the scale to the screen's when the view enters a window.
    contentScaleFactor = 1
    // The engine holds the view weakly, so a view that dies without leaving its window needs no deinit.
    syncEngine()
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }

  override func draw(_ rect: CGRect) {
    guard active, window != nil, let context = UIGraphicsGetCurrentContext() else { return }
    // The snowfall is in window coordinates; the context is already clipped to this view.
    let corner = convert(CGPoint.zero, to: nil)
    SnowEngine.shared.drawBack(in: context, origin: corner)
  }
}

/// Rendered rime bitmaps, by size / radius / theme / scale / seed. Main thread only; the rendering itself runs on
/// `queue`, one bitmap at a time, so that a large card never stalls scrolling.
final class SnowRimeCache {
  static let shared = SnowRimeCache()
  static let queue = DispatchQueue(label: "linea.snow.rime", qos: .userInitiated)
  static let limit = 64

  private var images: [String: CGImage] = [:]
  private var stamps: [String: Int] = [:]
  private var clock = 0

  func image(_ key: String) -> CGImage? {
    guard let found = images[key] else { return nil }
    clock += 1
    stamps[key] = clock
    return found
  }

  func store(_ key: String, _ image: CGImage) {
    clock += 1
    images[key] = image
    stamps[key] = clock
    // Over the limit: the least recently used ones go.
    while images.count > SnowRimeCache.limit {
      var oldest: String?
      var oldestAt = Int.max
      for (name, stamp) in stamps where stamp < oldestAt {
        oldest = name
        oldestAt = stamp
      }
      guard let name = oldest else { break }
      images[name] = nil
      stamps[name] = nil
    }
  }
}

/// A 'rime' surface: the rime of the glass surface it fills (a child of that surface, so it scrolls and clips with
/// it). The bitmap is rendered off the main thread when the size, the radius or the theme changes, becomes the
/// layer's contents and fades in; nothing is drawn per frame. Its alpha follows the heat. Never takes touches and
/// is hidden from accessibility.
final class SnowRimeView: UIView {
  /// false: nothing is shown.
  var active = false {
    didSet {
      if active != oldValue {
        syncEngine()
        refreshContents()
      }
    }
  }

  /// Corner radius of the glass surface, pt.
  var radius: Double = 0 {
    didSet {
      if radius != oldValue { refreshContents() }
    }
  }

  /// Equal-sized buttons must not all carry the same pattern: every view freezes its own way.
  private let seed = Int.random(in: 5...1000)
  private var shownKey = ""     // what the layer shows
  private var wantedKey = ""    // what is being rendered
  private var generation = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isOpaque = false
    backgroundColor = .clear
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    layer.contentsGravity = .resize
  }

  required init?(coder: NSCoder) { return nil }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }

  private func syncEngine() {
    if active && window != nil {
      SnowEngine.shared.registerRime(self)
    } else {
      SnowEngine.shared.unregisterRime(self)
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    syncEngine()
    refreshContents()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if !active || window == nil { return }
    if shownKey.isEmpty && wantedKey.isEmpty {
      refreshContents()
      return
    }
    // A surface that is being resized (an animation) is rendered once it settles; the old rime stretches meanwhile.
    generation += 1
    let ticket = generation
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
      guard let view = self, view.generation == ticket else { return }
      view.refreshContents()
    }
  }

  /// The engine's heat, as opacity. Animated when no frame loop eases it.
  func setHeatAlpha(_ value: Double, animated: Bool) {
    let target = CGFloat(max(0, min(1, value)))
    if animated && window != nil {
      UIView.animate(withDuration: 0.6, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: {
        self.alpha = target
      }, completion: nil)
    } else {
      alpha = target
    }
  }

  private func clearContents() {
    shownKey = ""
    wantedKey = ""
    layer.contents = nil
  }

  /// Shows the rime for the current size, radius and theme (rendering it first when it is not in the cache).
  func refreshContents() {
    if !active {
      clearContents()
      return
    }
    if window == nil { return }
    let w = Double(bounds.width)
    let h = Double(bounds.height)
    if !(w >= 4) || !(h >= 4) || w > 4096 || h > 4096 {
      clearContents()
      return
    }
    var screen = Double(traitCollection.displayScale)
    if let real = window?.windowScene?.screen { screen = Double(real.scale) }
    let density = min(2, max(1, screen))
    let dark = SnowEngine.shared.dark
    let corner = radius
    let own = seed
    let w10 = Int((w * 10).rounded())
    let h10 = Int((h * 10).rounded())
    let r10 = Int((corner * 10).rounded())
    let key = "\(w10)x\(h10)r\(r10)" + (dark ? "d" : "l") + "\(Int(density * 10))s\(own)"
    if key == shownKey {
      wantedKey = ""
      return
    }
    if key == wantedKey { return }
    wantedKey = key
    if let cached = SnowRimeCache.shared.image(key) {
      show(cached, key, density)
      return
    }
    SnowRimeCache.queue.async { [weak self] in
      let painter = SnowRimePainter(width: w, height: h, radius: corner, dark: dark, seed: own)
      let image = painter.render(scale: density)
      DispatchQueue.main.async {
        guard let made = image else { return }
        SnowRimeCache.shared.store(key, made)
        guard let view = self, view.wantedKey == key else { return }
        view.show(made, key, density)
      }
    }
  }

  private func show(_ image: CGImage, _ key: String, _ density: Double) {
    shownKey = key
    wantedKey = ""
    // Fades in (and cross-fades on a theme change) instead of popping.
    let fade = CATransition()
    fade.type = .fade
    fade.duration = 0.3
    layer.add(fade, forKey: "rime")
    layer.contentsScale = CGFloat(density)
    layer.contents = image
  }
}
