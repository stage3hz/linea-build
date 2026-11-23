import UIKit
import Accelerate

/// The first-launch intro drawn for time t (Intro/IntroModel.swift has every number): the graphite background, the
/// honeycomb field lit by its ring wave, the plate of light behind N, N's slab with its thickness (the back and the
/// side as offset layers, the front face with its honeycomb), the particles as small squares sorted back to front,
/// and a soft glow — the bright layers drawn once more into a small bitmap, blurred (vImage) and laid over at 0.7 as
/// a sublayer. Plays on a display link; `hold(_:)` freezes it at t. Core Graphics at no more than 2× the points (a
/// 565-particle frame: 16 particle fills, at most 16 line strokes, ~14 outline fills — a few ms on a phone).
/// Android: intro/IntroView.kt.
final class IntroView: UIView {
    /// Called on every frame with the time, s (the overlay ends the intro by it).
    var onTime: ((Double) -> Void)?
    /// A tap from VoiceOver's activate (the overlay skips).
    var onActivate: (() -> Void)?

    /// The graphite of the preview's stage.
    static let background = UIColor(red: 11 / 255, green: 12 / 255, blue: 16 / 255, alpha: 1)
    /// N's colours (0…1), lit: the face, its honeycomb lines, the side at the front and at the back.
    private static let faceColour: [Double] = [0.13, 0.145, 0.175]
    private static let faceLineColour: [Double] = [0.5, 0.55, 0.66]
    private static let sideFront: [Double] = [0.3, 0.33, 0.39]
    private static let sideBack: [Double] = [0.08, 0.09, 0.11]
    private static let slabLayers = 10
    private static let levels = 16

    private(set) var time: Double = 0
    private(set) var started: CFTimeInterval = 0
    private var link: CADisplayLink?

    private let world = IntroModel.scene
    private let edges = IntroModel.field
    private let face = IntroModel.faceCells
    private let plateOutline = IntroModel.plate()

    // Work arrays: filled anew each frame, never reallocated.
    private var quads: [CGPoint]
    private var depth: [Double]
    private var bright: [Double]
    private var order: [Int]
    private var fieldLight: [Double]

    private let glowLayer = CALayer()
    private var glowContext: CGContext?
    private var glowWork: UnsafeMutableRawPointer?
    private var glowWorkSize = 0
    private let sheen: CGGradient? = CGGradient(colorSpace: CGColorSpaceCreateDeviceRGB(), colorComponents: [1, 1, 1, 0.22, 1, 1, 1, 0, 1, 1, 1, 0.08], locations: [0, 0.55, 1], count: 3)

    override init(frame: CGRect) {
        let count = IntroModel.scene.particles.count
        quads = [CGPoint](repeating: .zero, count: count * 4)
        depth = [Double](repeating: 0, count: count)
        bright = [Double](repeating: 0, count: count)
        order = Array(0..<count)
        fieldLight = [Double](repeating: 0, count: IntroModel.field.count)
        super.init(frame: frame)
        backgroundColor = IntroView.background
        isOpaque = true
        contentMode = .redraw
        glowLayer.opacity = 0.7
        glowLayer.magnificationFilter = .linear
        glowLayer.contentsGravity = .resize
        layer.addSublayer(glowLayer)
        isAccessibilityElement = true
        accessibilityLabel = "Инвиз"
        accessibilityTraits = .image
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        link?.invalidate()
        glowWork?.deallocate()
    }

    override func accessibilityActivate() -> Bool {
        onActivate?()
        return true
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // At most 2× (the frame is drawn on the CPU); the glow is soft anyway.
        let scale = window?.screen.scale ?? UIScreen.main.scale
        contentScaleFactor = Swift.min(scale, 2)
        if window == nil { stop() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        glowLayer.frame = bounds
        CATransaction.commit()
        setNeedsDisplay()
    }

    /// Starts the clock now (t = 0).
    func play() {
        stop()
        started = CACurrentMediaTime()
        time = 0
        let made = CADisplayLink(target: self, selector: #selector(step))
        made.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        made.add(to: .main, forMode: .common)
        link = made
        setNeedsDisplay()
    }

    /// Shows the frame at t and stays there.
    func hold(_ t: Double) {
        stop()
        time = t
        setNeedsDisplay()
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func step() {
        time = CACurrentMediaTime() - started
        setNeedsDisplay()
        onTime?(time)
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        let w = Double(bounds.width), h = Double(bounds.height)
        guard w > 0, h > 0 else { return }
        let t = Swift.min(time, IntroModel.duration)
        ctx.setFillColor(IntroView.background.cgColor)
        ctx.fill(bounds)
        let projector = IntroProjector(camera: IntroModel.camera(t, world: world), width: w, height: h)
        prepare(projector, t)
        drawScene(ctx, projector, t, scale: 1, light: false)
        drawGlow(projector, t, w, h)
    }

    // MARK: The frame

    /// The per-frame numbers both passes use: the particles' squares on the screen in depth order, the field's light.
    private func prepare(_ projector: IntroProjector, _ t: Double) {
        let cell = world.cell
        for i in 0..<world.particles.count {
            let s = IntroModel.particle(world.particles[i], t, cell: cell)
            let half = s.size / 2
            let c = cos(s.angle), sn = sin(s.angle)
            bright[i] = s.brightness
            for k in 0..<4 {
                let sx = (k == 0 || k == 3) ? -half : half
                let sy = k < 2 ? -half : half
                let p = projector.project(s.x + sx * c - sy * sn, s.y + sx * sn + sy * c, s.z)
                quads[i * 4 + k] = CGPoint(x: p.0, y: p.1)
            }
            depth[i] = half <= 0 ? -1 : projector.project(s.x, s.y, s.z).2
        }
        // Back to front (insertion sort: the order hardly changes from one frame to the next).
        if order.count > 1 {
            for i in 1..<order.count {
                let v = order[i]
                var j = i - 1
                while j >= 0 && depth[order[j]] < depth[v] { order[j + 1] = order[j]; j -= 1 }
                order[j + 1] = v
            }
        }
        for i in 0..<edges.count { fieldLight[i] = IntroModel.edgeGlow(edges, i, t) }
    }

    /// One pass of the scene. `scale` maps the view's points to the context (the glow's small bitmap: < 1); `light`
    /// draws only the bright layers (the glow pass).
    private func drawScene(_ ctx: CGContext, _ projector: IntroProjector, _ t: Double, scale: CGFloat, light: Bool) {
        ctx.saveGState()
        ctx.scaleBy(x: scale, y: scale)
        drawField(ctx, projector, scale: scale, light: light)
        drawPlate(ctx, projector, t, light: light)
        drawParticles(ctx, light: light)
        drawSlab(ctx, projector, t, scale: scale, light: light)
        ctx.restoreGState()
    }

    private func level(_ v: Double) -> Int { return Swift.min(IntroView.levels - 1, Swift.max(0, Int(IntroModel.clamp(v, 0, 1) * Double(IntroView.levels)))) }

    private func drawField(_ ctx: CGContext, _ projector: IntroProjector, scale: CGFloat, light: Bool) {
        var paths: [CGMutablePath?] = [CGMutablePath?](repeating: nil, count: IntroView.levels)
        let l = edges.lines
        for i in 0..<edges.count {
            let v = fieldLight[i]
            if v < 0.01 { continue }
            let at = level(v)
            let a = projector.project(l[4 * i], l[4 * i + 1], IntroModel.fieldZ)
            let b = projector.project(l[4 * i + 2], l[4 * i + 3], IntroModel.fieldZ)
            let path = paths[at] ?? CGMutablePath()
            path.move(to: CGPoint(x: a.0, y: a.1))
            path.addLine(to: CGPoint(x: b.0, y: b.1))
            paths[at] = path
        }
        ctx.setLineCap(.round)
        ctx.setLineWidth(Swift.max(1 / scale, 0.8))
        for (index, path) in paths.enumerated() {
            guard let path else { continue }
            let v = (CGFloat(index) + 0.5) / CGFloat(IntroView.levels)
            ctx.setStrokeColor(light ? UIColor(white: 1, alpha: v).cgColor : UIColor(red: 236 / 255, green: 240 / 255, blue: 1, alpha: v).cgColor)
            ctx.addPath(path)
            ctx.strokePath()
        }
    }

    private func outline(_ projector: IntroProjector, _ pieces: [[Double]], _ z: Double) -> CGPath {
        let path = CGMutablePath()
        for piece in pieces {
            for k in stride(from: 0, to: piece.count, by: 2) {
                let p = projector.project(piece[k], piece[k + 1], z)
                if k == 0 { path.move(to: CGPoint(x: p.0, y: p.1)) } else { path.addLine(to: CGPoint(x: p.0, y: p.1)) }
            }
            path.closeSubpath()
        }
        return path
    }

    private func drawPlate(_ ctx: CGContext, _ projector: IntroProjector, _ t: Double, light: Bool) {
        let hal = CGFloat(IntroModel.clamp(IntroModel.flare(t), 0, 1))
        ctx.setFillColor(light ? UIColor(white: 1, alpha: hal * 0.9).cgColor : UIColor(white: hal, alpha: 1).cgColor)
        ctx.addPath(outline(projector, plateOutline, IntroModel.plateZ))
        ctx.fillPath()
    }

    private func drawParticles(_ ctx: CGContext, light: Bool) {
        var paths: [CGMutablePath?] = [CGMutablePath?](repeating: nil, count: IntroView.levels)
        for n in 0..<order.count {
            let i = order[n]
            if depth[i] < 0 { continue }
            let at = level(bright[i])
            let path = paths[at] ?? CGMutablePath()
            path.addLines(between: [quads[i * 4], quads[i * 4 + 1], quads[i * 4 + 2], quads[i * 4 + 3]])
            path.closeSubpath()
            paths[at] = path
        }
        for (index, path) in paths.enumerated() {
            guard let path else { continue }
            let v = (CGFloat(index) + 0.5) / CGFloat(IntroView.levels)
            ctx.setFillColor(light ? UIColor(white: 1, alpha: v).cgColor : UIColor(white: v, alpha: 1).cgColor)
            ctx.addPath(path)
            ctx.fillPath()
        }
    }

    private func colour(_ c: [Double], _ k: Double) -> CGColor {
        return UIColor(red: CGFloat(IntroModel.clamp(c[0] * k, 0, 1)), green: CGFloat(IntroModel.clamp(c[1] * k, 0, 1)), blue: CGFloat(IntroModel.clamp(c[2] * k, 0, 1)), alpha: 1).cgColor
    }

    private func drawSlab(_ ctx: CGContext, _ projector: IntroProjector, _ t: Double, scale: CGFloat, light: Bool) {
        let body = IntroModel.body(t)
        if !light {
            // The back and the side: the outline drawn at depths from the back to the front, darker behind.
            for layerIndex in 0..<IntroView.slabLayers {
                let k = Double(layerIndex) / Double(IntroView.slabLayers)
                let z = IntroModel.slabBack + (IntroModel.slabFront - IntroModel.slabBack) * k
                let a = IntroView.sideBack, b = IntroView.sideFront
                ctx.setFillColor(colour([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k], body))
                ctx.addPath(outline(projector, world.mark, z))
                ctx.fillPath()
            }
        }
        // The front face: dark and glossy, the honeycomb lighter on it.
        let front = outline(projector, world.mark, IntroModel.slabFront)
        ctx.saveGState()
        ctx.addPath(front)
        ctx.clip()
        if !light {
            ctx.setFillColor(colour(IntroView.faceColour, body))
            ctx.addPath(front)
            ctx.fillPath()
            if let sheen {
                let a = projector.project(-6, 10.5, IntroModel.slabFront), b = projector.project(4, 0, IntroModel.slabFront)
                ctx.saveGState()
                ctx.setAlpha(CGFloat(body))
                ctx.drawLinearGradient(sheen, start: CGPoint(x: a.0, y: a.1), end: CGPoint(x: b.0, y: b.1), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
                ctx.restoreGState()
            }
        }
        let lines = CGMutablePath()
        for k in stride(from: 0, to: face.count, by: 4) {
            let a = projector.project(face[k], face[k + 1], IntroModel.slabFront)
            let b = projector.project(face[k + 2], face[k + 3], IntroModel.slabFront)
            lines.move(to: CGPoint(x: a.0, y: a.1))
            lines.addLine(to: CGPoint(x: b.0, y: b.1))
        }
        // The lines' width: 0.15 scene units (the preview's border band of each cell) at N's depth.
        let middle = projector.project(0, 5, IntroModel.slabFront)
        ctx.setLineWidth(Swift.max(1 / scale, CGFloat(0.15 * projector.focal / middle.2)))
        ctx.setLineCap(.round)
        ctx.setStrokeColor(light ? UIColor(white: 1, alpha: CGFloat(0.15 * body)).cgColor : colour(IntroView.faceLineColour, body))
        ctx.addPath(lines)
        ctx.strokePath()
        ctx.restoreGState()
    }

    /// The glow: the bright layers into a small premultiplied bitmap, blurred twice with a box (≈ a Gaussian), shown by
    /// the glow sublayer at 0.7 — white light × alpha over the frame, the preview's screen-blended bloom.
    private func drawGlow(_ projector: IntroProjector, _ t: Double, _ w: Double, _ h: Double) {
        let down = 2.7 // points per glow pixel (Android: 2.7 dp)
        let gw = Swift.max(1, Int((w / down).rounded())), gh = Swift.max(1, Int((h / down).rounded()))
        if glowContext == nil || glowContext?.width != gw || glowContext?.height != gh {
            glowContext = CGContext(data: nil, width: gw, height: gh, bitsPerComponent: 8, bytesPerRow: 0,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            glowWork?.deallocate()
            glowWork = nil
            if let made = glowContext {
                glowWorkSize = made.bytesPerRow * gh
                glowWork = UnsafeMutableRawPointer.allocate(byteCount: glowWorkSize, alignment: 16)
            }
        }
        guard let small = glowContext, let data = small.data, let work = glowWork else { return }
        small.clear(CGRect(x: 0, y: 0, width: gw, height: gh))
        small.saveGState()
        // Top-left origin, as the view's own context.
        small.translateBy(x: 0, y: CGFloat(gh))
        small.scaleBy(x: 1, y: -1)
        drawScene(small, projector, t, scale: CGFloat(Double(gw) / w), light: true)
        small.restoreGState()
        var source = vImage_Buffer(data: data, height: vImagePixelCount(gh), width: vImagePixelCount(gw), rowBytes: small.bytesPerRow)
        var target = vImage_Buffer(data: work, height: vImagePixelCount(gh), width: vImagePixelCount(gw), rowBytes: small.bytesPerRow)
        let flags = vImage_Flags(kvImageEdgeExtend)
        _ = vImageBoxConvolve_ARGB8888(&source, &target, nil, 0, 0, 5, 5, nil, flags)
        _ = vImageBoxConvolve_ARGB8888(&target, &source, nil, 0, 0, 5, 5, nil, flags)
        let image = small.makeImage()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        glowLayer.contents = image
        CATransaction.commit()
    }
}
