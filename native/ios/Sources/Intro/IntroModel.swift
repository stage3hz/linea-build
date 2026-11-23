import Foundation

/// The first-launch intro, its pure side: no views, no clock. The word INVIZ made of particles, the timeline (4.6 s),
/// the camera, the field, the light behind «N» and the taps of the haptics — the formulas of the approved preview
/// (`build()`, `frame(t)`, `TAPS`), deterministic (the preview's seeded generator, mulberry32, seed 5). Everything is
/// in the preview's scene units (N is 10 high); a frame is drawn in 2D from the points `IntroProjector` gives.
/// Android: intro/IntroModel.kt — the same numbers, line for line.
enum IntroModel {
    /// The whole timeline, s.
    static let duration: Double = 4.6
    /// The fade that reveals the sign-in screen at the end (or after a tap), s.
    static let fade: Double = 0.35
    /// The phases (s): the word appears whole; the break-in; the field; it settles.
    static let breakStart: Double = 1.1
    static let fieldStart: Double = 2.6
    static let settled: Double = 3.5

    // MARK: The seeded generator and the curves of the preview

    /// mulberry32, as the preview's `rng(a)`: the same doubles in [0, 1) for the same seed.
    struct Mulberry32 {
        private var a: UInt32
        init(seed: UInt32) { a = seed }
        mutating func next() -> Double {
            a = a &+ 0x6D2B79F5
            var t: UInt32 = (a ^ (a >> 15)) &* (1 | a)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
            return Double(t ^ (t >> 14)) / 4294967296.0
        }
    }

    static func clamp(_ x: Double, _ a: Double, _ b: Double) -> Double { return Swift.min(b, Swift.max(a, x)) }
    static func ease(_ value: Double) -> Double { let x = clamp(value, 0, 1); return x * x * (3 - 2 * x) }
    static func easeOut(_ value: Double) -> Double { return 1 - pow(1 - clamp(value, 0, 1), 3) }

    // MARK: The shapes

    /// The letters I, V, Z: the app's own face, Unbounded ExtraBold (Unbounded-ExtraBold.ttf), outlines in font units
    /// (1000 per em, baseline at 0, y up), with the advance. All three are straight lines.
    struct Glyph {
        let advance: Double
        let outline: [Double]
    }

    static let glyphI = Glyph(advance: 362, outline: [65, 750, 298, 750, 298, 0, 65, 0])
    static let glyphV = Glyph(advance: 951, outline: [527, 106, 430, 106, 708, 750, 952, 750, 608, 0, 343, 0, -1, 750, 248, 750])
    static let glyphZ = Glyph(advance: 819, outline: [42, 0, 42, 167, 512, 615, 685, 570, 46, 570, 46, 751, 773, 751, 773, 584, 304, 135, 157, 180, 776, 180, 776, 0])
    /// The cap height of N in the same face: what the preview fits to 220 px.
    private static let cap: Double = 750

    /// The app's sign, N: the three pieces of the bundled app icon's mark (AppIcon-Light — the same picture as
    /// mobile/assets/icons/light.png, the dark N on it), traced into outlines. Coordinates in the preview's crop of the
    /// icon (x 138, y 144, 237 × 221 of the 512-px icon) at twice that: 474 × 442, y down.
    static let markPieces: [[Double]] = [
        [331, 69, 337, 56, 346, 48, 448, 2, 457, 1, 462, 2, 468, 6, 473, 17, 473, 304, 471, 310, 467, 313, 460, 313, 458, 312, 433, 286, 333, 175, 331, 170],
        [0, 34, 2, 27, 6, 19, 15, 11, 22, 7, 30, 5, 114, 5, 125, 8, 134, 13, 154, 33, 237, 122, 466, 377, 471, 386, 473, 395, 473, 402, 471, 411, 464, 424, 452, 435, 443, 439, 429, 442, 372, 442, 360, 440, 351, 436, 346, 432, 5, 55, 0, 44],
        [0, 133, 2, 128, 5, 125, 13, 125, 36, 147, 133, 250, 135, 257, 135, 381, 134, 386, 131, 392, 121, 401, 25, 440, 13, 440, 5, 435, 0, 426],
    ]
    private static let markW: Double = 474
    private static let markH: Double = 442

    /// Even-odd point-in-polygon (x0, y0, x1, y1, …).
    static func inside(_ poly: [Double], _ x: Double, _ y: Double) -> Bool {
        var hit = false
        let n = poly.count / 2
        var j = n - 1
        for i in 0..<n {
            let xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1]
            if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi { hit.toggle() }
            j = i
        }
        return hit
    }

    // MARK: The word made into particles (the preview's `build`)

    /// One small square of the letters. Home (x0, y0) in scene units; `fly` how far it goes along (vx, vy); `lost`
    /// shrinks away; `t0` when its turn comes; `s` and `b` the size and brightness it ends at; `letter` 0 I, 2 V, 3 I, 4 Z.
    struct Particle {
        let x0: Double, y0: Double, vx: Double, vy: Double, fly: Double
        let lost: Bool
        let z: Double, s: Double, b: Double, t0: Double, spin: Double, scatter: Double
        let letter: Int
    }

    /// The whole scene: the particles, the edge of a particle's cell, N's outlines (scene units, y up, N's middle at
    /// x 0), and the span of the word either side of N's middle.
    struct Scene {
        let particles: [Particle]
        let cell: Double
        let mark: [[Double]]
        let span: Double
        let leftSpan: Double
        var total: Double { return span + leftSpan }
        var mid: Double { return (span - leftSpan) / 2 }
    }

    private static let px: Double = 220
    private static let base: Double = 270
    private static let unit: Double = 10 / px

    static let scene: Scene = build()

    static func build() -> Scene {
        // The letters laid out as the preview's canvas does: N's height fitted to 220 px, a gap of 0.13 em between letters.
        let scale = px / cap
        let fs = 1000 * scale
        let gap = fs * 0.13
        let wN = px * 237 / 221
        let word: [Glyph?] = [glyphI, nil, glyphV, glyphI, glyphZ]
        var placed: [[Double]] = []
        var letterOf: [Int] = []
        var x: Double = 20
        var xN: Double = 0
        for (index, glyph) in word.enumerated() {
            guard let glyph = glyph else { xN = x; x += wN + gap; continue }
            let o = glyph.outline
            placed.append((0..<o.count).map { (k: Int) -> Double in k % 2 == 0 ? x + o[k] * scale : base - o[k] * scale })
            letterOf.append(index)
            x += glyph.advance * scale + gap
        }
        let tw = x - gap
        func letterAt(_ px: Double, _ py: Double) -> Int {
            for k in placed.indices where inside(placed[k], px, py) { return letterOf[k] }
            return -1
        }
        var cubes: [Particle] = []
        var random = Mulberry32(seed: 5)
        let cell = px / 17
        let reach = tw * 0.6
        let s0 = tw / 0.99
        let u = unit
        var py = base - px
        while py < base {
            var cx0: Double = 20
            while cx0 < tw + 20 {
                let cx = cx0 + cell / 2, cy = py + cell / 2
                let letter = (cx >= xN && cx <= xN + wN) ? -1 : letterAt(cx, cy)
                if letter >= 0 {
                    let left = cx0 < xN
                    let d = left ? xN - cx0 : cx0 - (xN + wN)
                    let t = left ? Swift.min(0.48, 0.26 + d / (reach * 0.9)) : Swift.min(1, d / reach)
                    let r1 = random.next(), r2 = random.next(), r3 = random.next(), r4 = random.next()
                    let x0 = (cx0 + cell / 2 - xN - wN / 2) * u
                    let y0 = (base - py - cell / 2) * u
                    var vx = x0
                    var vy = (y0 - 5) * 1.5 + (r3 - 0.5) * 10 * 0.5 * t
                    let length = hypot(vx, vy)
                    let vl = length == 0 ? 1 : length
                    vx /= vl; vy /= vl
                    let lost = r1 < pow(t, 1.3) * 0.82 + 0.08
                    let fly = (0.25 + r2 * r2 * 1.6) * t * t * s0 * 0.11 * u
                    // When its turn comes: the far end of the word goes first, the wave runs toward N.
                    let far = left ? 0.55 : clamp(d / (tw - (xN + wN - 20)), 0, 1)
                    let t0 = 1.1 + (1 - far) * 0.95 + r4 * 0.25
                    cubes.append(Particle(x0: x0, y0: y0, vx: vx, vy: vy, fly: lost ? fly + 6 + r2 * 22 : fly, lost: lost,
                                          z: (r4 - 0.5) * t * t * 5, s: 0.95 - 0.4 * t, b: 1 - 0.25 * t, t0: t0, spin: (r3 - 0.5) * 3, scatter: t, letter: letter))
                }
                cx0 += cell
            }
            py += cell
        }
        let mark: [[Double]] = markPieces.map { (piece: [Double]) -> [Double] in
            (0..<piece.count).map { (k: Int) -> Double in
                k % 2 == 0 ? (xN + piece[k] / markW * wN - xN - wN / 2) * u : (base - (base - px + piece[k] / markH * px)) * u
            }
        }
        return Scene(particles: cubes, cell: cell * u, mark: mark, span: (tw + 20 - xN - wN / 2) * u, leftSpan: (xN + wN / 2 - 20) * u)
    }

    // MARK: A particle at time t

    /// Where a particle is at t: scene units, `size` the edge of its square, `brightness` 0…1 (white × it), `angle`
    /// its turn about the view axis, radians.
    struct ParticleState: Equatable {
        let x: Double, y: Double, z: Double, size: Double, brightness: Double, angle: Double
    }

    static func appear(_ t: Double) -> Double { return ease(t / 0.9) }

    /// The preview's `frame(t)` for one cube.
    static func particle(_ q: Particle, _ t: Double, cell: Double = scene.cell) -> ParticleState {
        let shown = appear(t)
        let p = easeOut((t - q.t0) / 1.15)
        let f = q.fly * p
        let s = (q.lost ? 1 - p : 1) * (1 - (1 - q.s) * p) * (0.2 + 0.8 * shown)
        return ParticleState(
            x: q.x0 + q.vx * f,
            y: q.y0 + q.vy * f + (1 - shown) * -2,
            z: q.z * p,
            size: cell * 0.8 * Swift.max(s, 0),
            brightness: (1 - (1 - q.b) * p) * (0.82 - 0.2 * ease((t - 1.0) / 0.8)) * shown,
            angle: q.lost ? q.spin * p : 0)
    }

    // MARK: The camera

    /// The camera at t: it comes closer and turns a little to the side (the word group turns by `yaw`), with a slight
    /// shake during the break-in. Vertical field of view 30°.
    struct Camera {
        let yaw: Double, x: Double, y: Double, z: Double, lookX: Double, lookY: Double, lookZ: Double
        var fovY: Double { return 30 * Double.pi / 180 }
    }

    static func shake(_ t: Double) -> Double {
        return t > 1.1 && t < 2.6 ? 0.12 * ease((t - 1.1) / 1.5) * sin(t * 61) * sin(t * 37) : 0
    }

    static func camera(_ t: Double, world: Scene = scene) -> Camera {
        let yaw = -0.3 * ease((t - 0.4) / 3.2)
        let dist = world.total * (5.9 - 0.9 * easeOut(t / 3.6))
        let mx = world.mid * cos(yaw) * 0.95
        return Camera(yaw: yaw, x: mx + shake(t), y: 6.5 + world.total * 0.05, z: dist, lookX: mx, lookY: 5.2, lookZ: 0)
    }

    // MARK: N, the field, the light

    /// The light plate behind N (white × it): quiet at first, flares when the field comes up.
    static func flare(_ t: Double) -> Double {
        let up = ease((t - 2.6) / 0.5)
        return 0.25 * appear(t) + 0.75 * up + 0.35 * exp(-pow((t - 2.7) / 0.18, 2))
    }

    /// The slab's own light (its colours × it).
    static func body(_ t: Double) -> Double { return 0.35 + 0.65 * appear(t) }

    /// The plate: N's outlines 1.06 times larger about N's middle, just behind the slab.
    static let plateZ: Double = -1.25
    static let slabBack: Double = -1.2
    static let slabFront: Double = 1.2
    static func plate(_ world: Scene = scene) -> [[Double]] {
        return world.mark.map { (piece: [Double]) -> [Double] in
            (0..<piece.count).map { (k: Int) -> Double in k % 2 == 0 ? piece[k] * 1.06 : 5 + (piece[k] - 5) * 1.06 }
        }
    }

    /// The radius of the field's ring wave at t (scene units), negative before it starts.
    static func fieldWave(_ t: Double) -> Double { return (t - 2.6) * 42 }

    /// How lit a point of the field is at t, by its distance from N's middle: the ring and the glow it leaves inside.
    static func fieldGlow(_ distance: Double, _ t: Double) -> Double {
        if t <= 2.6 { return 0 }
        let wave = fieldWave(t)
        return 0.6 * exp(-pow((distance - wave) / 5, 2)) + (distance < wave ? 0.16 * exp(-distance / 60) : 0)
    }

    static let fieldZ: Double = -3.2

    /// The field's honeycomb: each edge once (x1, y1, x2, y2), and how many cells share it (1 or 2 — the preview draws
    /// each cell's six edges, so a shared one shines twice).
    struct Edges {
        let lines: [Double]
        let shared: [Int]
        var count: Int { return shared.count }
    }

    private struct EdgeKey: Hashable { let a: Int64, b: Int64, c: Int64, d: Int64 }

    private static func edgeKey(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ grid: Double) -> EdgeKey {
        let a = Int64((x1 * grid).rounded()), b = Int64((y1 * grid).rounded()), c = Int64((x2 * grid).rounded()), d = Int64((y2 * grid).rounded())
        return (a, b) < (c, d) ? EdgeKey(a: a, b: b, c: c, d: d) : EdgeKey(a: c, b: d, c: a, d: b)
    }

    static let field: Edges = {
        let fr = 3.4, fw = 3.4 * sqrt(3.0)
        var seen: [EdgeKey: Int] = [:]
        var lines: [Double] = []
        var counts: [Int] = []
        for row in -9...12 {
            for c in -9...16 {
                let cx = Double(c) * fw + (row % 2 != 0 ? fw / 2 : 0), cy = 5 + Double(row) * fr * 1.5
                for i in 0..<6 {
                    let a0 = Double.pi / 6 + Double(i) * Double.pi / 3, a1 = a0 + Double.pi / 3
                    let x1 = cx + fr * cos(a0), y1 = cy + fr * sin(a0), x2 = cx + fr * cos(a1), y2 = cy + fr * sin(a1)
                    let key = IntroModel.edgeKey(x1, y1, x2, y2, 100)
                    if let at = seen[key] { counts[at] += 1; continue }
                    seen[key] = counts.count
                    lines.append(contentsOf: [x1, y1, x2, y2])
                    counts.append(1)
                }
            }
        }
        return Edges(lines: lines, shared: counts)
    }()

    /// The light of one field edge at t: the mean of its two ends' (the preview's vertex colours), times the cells
    /// that share it.
    static func edgeGlow(_ edges: Edges, _ index: Int, _ t: Double) -> Double {
        if t <= 2.6 { return 0 }
        let l = edges.lines
        let a = fieldGlow(hypot(l[4 * index], l[4 * index + 1] - 5), t)
        let b = fieldGlow(hypot(l[4 * index + 2], l[4 * index + 3] - 5), t)
        return (a + b) / 2 * Double(edges.shared[index])
    }

    /// The honeycomb on N's face (the preview's per-cell colouring: pointy-top cells, outer radius 0.62): the edges of
    /// the cells that touch N's outlines, scene units. The face's lighter lines are these, clipped to N.
    static let faceRadius: Double = 0.62

    static let faceCells: [Double] = {
        let hr = IntroModel.faceRadius, hw = IntroModel.faceRadius * sqrt(3.0)
        var out: [Double] = []
        var seen = Set<EdgeKey>()
        let mark = IntroModel.scene.mark
        var minX = Double.greatestFiniteMagnitude, maxX = -Double.greatestFiniteMagnitude
        var minY = Double.greatestFiniteMagnitude, maxY = -Double.greatestFiniteMagnitude
        for piece in mark {
            for k in stride(from: 0, to: piece.count, by: 2) {
                minX = Swift.min(minX, piece[k]); maxX = Swift.max(maxX, piece[k])
                minY = Swift.min(minY, piece[k + 1]); maxY = Swift.max(maxY, piece[k + 1])
            }
        }
        let rowLow = Int(floor((minY - hr) / (hr * 1.5))), rowHigh = Int(ceil((maxY + hr) / (hr * 1.5)))
        for row in rowLow...rowHigh {
            let off = row % 2 != 0 ? hw / 2 : 0
            let colLow = Int(floor((minX - hw - off) / hw)), colHigh = Int(ceil((maxX + hw - off) / hw))
            for c in colLow...colHigh {
                let cx = Double(c) * hw + off, cy = Double(row) * hr * 1.5
                for i in 0..<6 {
                    let a0 = Double.pi / 6 + Double(i) * Double.pi / 3, a1 = a0 + Double.pi / 3
                    let x1 = cx + hr * cos(a0), y1 = cy + hr * sin(a0), x2 = cx + hr * cos(a1), y2 = cy + hr * sin(a1)
                    if !seen.insert(IntroModel.edgeKey(x1, y1, x2, y2, 1000)).inserted { continue }
                    let mx = (x1 + x2) / 2, my = (y1 + y2) / 2
                    if !mark.contains(where: { (piece: [Double]) -> Bool in IntroModel.inside(piece, mx, my) || IntroModel.inside(piece, x1, y1) || IntroModel.inside(piece, x2, y2) }) { continue }
                    out.append(contentsOf: [x1, y1, x2, y2])
                }
            }
        }
        return out
    }()

    // MARK: The haptics: taps only

    /// One tap of the phone's haptic engine: when (s), how strong (0…1), and its kind — a light `tap` or the one soft
    /// `thud` when the field comes up. Never a continuous vibration.
    struct Tap: Equatable {
        enum Kind { case tap, thud }
        let time: Double
        let strength: Double
        let kind: Kind
    }

    /// The preview's `TAPS`: light taps that get denser while the letters crumble (every 0.22 s down to 0.07 s, 0.25 →
    /// 0.45), one soft thud at 2.62 s, three fading taps after it.
    static let taps: [Tap] = {
        var out: [Tap] = []
        var t = 1.1
        while t < 2.56 {
            let k = (t - 1.1) / 1.46
            out.append(Tap(time: t, strength: 0.25 + 0.2 * k, kind: .tap))
            t += 0.22 - 0.15 * k
        }
        out.append(Tap(time: 2.62, strength: 0.8, kind: .thud))
        for (at, strength) in [(2.78, 0.3), (2.95, 0.2), (3.15, 0.12)] { out.append(Tap(time: at, strength: strength, kind: .tap)) }
        return out
    }()

    /// The preview's line of the haptics (strength 0…1 over time): each tap a narrow bump (0.018 s; the thud 0.05 s).
    static func haptic(_ t: Double) -> Double {
        var v: Double = 0
        for tap in taps {
            let d = (t - tap.time) / (tap.kind == .thud ? 0.05 : 0.018)
            if d > -3 && d < 3 { v = Swift.max(v, tap.strength * exp(-d * d)) }
        }
        return v
    }

    // MARK: When it plays

    /// The intro plays at a start with no session, once per install, and never when motion is reduced (the system's
    /// setting or the app's «Анимации»); the person who signed out of an install that has seen it never sees it again.
    static func shouldPlay(seen: Bool, hasSession: Bool, motionAllowed: Bool) -> Bool { return !seen && !hasSession && motionAllowed }

    /// The overlay's opacity at t when it plays through: whole until the end, then the fade.
    static func overlayAlpha(_ t: Double) -> Double { return 1 - clamp((t - duration) / fade, 0, 1) }
}

/// A simple perspective: the group's turn about the vertical axis, the camera's look-at basis, the divide. `project`
/// gives the screen x, y (points of a `width` × `height` view, y down) and the depth (distance along the view axis;
/// bigger = farther). The vertical field of view widens on a view narrower than the preview's phone (9 : 19.5) so the
/// word always fits across. (Android: IntroModel.Projector.)
struct IntroProjector {
    private let cy: Double, sy: Double
    private let ex: Double, ey: Double, ez: Double
    private let fx: Double, fy: Double, fz: Double
    private let rx: Double, rz: Double
    private let ux: Double, uy: Double, uz: Double
    private let width: Double, height: Double
    /// Points per unit at depth 1.
    let focal: Double

    init(camera: IntroModel.Camera, width: Double, height: Double) {
        self.width = width
        self.height = height
        cy = cos(camera.yaw); sy = sin(camera.yaw)
        ex = camera.x; ey = camera.y; ez = camera.z
        var ax = camera.lookX - camera.x, ay = camera.lookY - camera.y, az = camera.lookZ - camera.z
        let al = sqrt(ax * ax + ay * ay + az * az)
        ax /= al; ay /= al; az /= al
        fx = ax; fy = ay; fz = az
        // right = forward × up(0, 1, 0)
        var bx = -az, bz = ax
        let bl = sqrt(bx * bx + bz * bz)
        bx /= bl; bz /= bl
        rx = bx; rz = bz
        // up = right × forward
        ux = -bz * ay; uy = bz * ax - bx * az; uz = bx * ay
        let aspect = width / height
        let tanHalf = tan(camera.fovY / 2) * Swift.max(1, (9.0 / 19.5) / aspect)
        focal = (height / 2) / tanHalf
    }

    /// (screen x, screen y, depth).
    func project(_ x: Double, _ y: Double, _ z: Double) -> (Double, Double, Double) {
        let wx = x * cy + z * sy
        let wz = -x * sy + z * cy
        let dx = wx - ex, dy = y - ey, dz = wz - ez
        let xc = dx * rx + dz * rz
        let yc = dx * ux + dy * uy + dz * uz
        let zc = Swift.max(1e-3, dx * fx + dy * fy + dz * fz)
        return (width / 2 + xc / zc * focal, height / 2 - yc / zc * focal, zc)
    }
}
