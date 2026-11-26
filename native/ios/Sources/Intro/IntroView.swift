import UIKit
import Metal

/// The first-launch intro on the screen: the scene (Intro/IntroSceneView.swift) or, with motion reduced or where the
/// scene cannot be drawn, four still stages; over it the hint «Проведи вверх». It feeds the person's way through the
/// intro (`IntroFlow`) with the time of every frame and with the touches, and reports what happened (`onEvents`: the
/// haptic swell starts, the honeycomb layer is passed, the intro is finished). There is nothing to tap and no way to
/// skip. Android: intro/IntroView.kt.
final class IntroView: UIView {
    let flow: IntroFlow
    /// Bits of `IntroFlow.swell`, `pass`, `finishedBit`.
    var onEvents: ((Int) -> Void)?

    /// The page behind everything.
    static let page = UIColor(
        red: CGFloat(IntroModel.background[0] / 255), green: CGFloat(IntroModel.background[1] / 255),
        blue: CGFloat(IntroModel.background[2] / 255), alpha: 1
    )
    /// A tap's own wobble, points: the first few points of a touch do not count.
    private static let slop: CGFloat = 8
    /// A finger that leaves moving up faster than this (points a second) has flung.
    private static let flingSpeed: CGFloat = 500

    private var scene: IntroSceneView?
    private var stills: IntroStills?
    private let hint = IntroHint(frame: .zero)
    private var art: IntroArt?
    private var link: CADisplayLink?
    private var ready = false
    private var last: CFTimeInterval = 0
    private var frozenDrawn = 0
    private var left: Double = -12
    private var right: Double = 39
    private var laidOut: CGSize = .zero
    private var giveUp: DispatchWorkItem?

    // The touch that is down.
    private var downY: CGFloat = 0
    private var lastY: CGFloat = 0
    private var lastTime: TimeInterval = 0
    private var velocity: CGFloat = 0

    init(frame: CGRect, flow: IntroFlow) {
        self.flow = flow
        super.init(frame: frame)
        backgroundColor = IntroView.page
        isOpaque = true
        isMultipleTouchEnabled = false
        art = IntroArt.make()
        if flow.stills { showStills() } else { showScene() }
        addSubview(hint)
    }

    required init?(coder: NSCoder) { return nil }

    private func showScene() {
        guard let art, let device = MTLCreateSystemDefaultDevice() else {
            NSLog("Linea: intro: no scene on this phone: the still stages")
            toStills()
            return
        }
        let memory = Int(ProcessInfo.processInfo.physicalMemory / (1024 * 1024))
        let count = IntroModel.particleCount(memoryMB: memory)
        let modest = count <= 60_000
        let made = IntroSceneView(frame: bounds, device: device, art: art, count: count, glow: !modest, finest: modest ? 720 : 1080)
        made.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        made.onReady = { [weak self] (l: Double, r: Double) -> Void in
            guard let self else { return }
            self.left = l
            self.right = r
            self.ready = true
            self.giveUp?.cancel()
            self.giveUp = nil
            self.shape()
        }
        made.onFailed = { [weak self] () -> Void in self?.toStills() }
        scene = made
        insertSubview(made, at: 0)
        // No picture after three seconds: the still stages. (A frozen picture on a slow simulator is given the time it takes.)
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.ready, self.scene != nil else { return }
            NSLog("Linea: intro: no picture in three seconds: the still stages")
            self.toStills()
        }
        giveUp = work
        let patience: Double = flow.frozen ? 30 : 3
        DispatchQueue.main.asyncAfter(deadline: .now() + patience, execute: work)
    }

    private func showStills() {
        let made = IntroStills(frame: bounds, art: art)
        made.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        stills = made
        insertSubview(made, at: 0)
        hint.moving = false
        ready = true
    }

    private func toStills() {
        giveUp?.cancel()
        giveUp = nil
        if let gone = scene {
            scene = nil
            gone.letGo()
            gone.removeFromSuperview()
        }
        flow.toStills()
        if stills == nil { showStills() }
    }

    /// The screen's shape decides where the camera passes the honeycomb layer.
    private func shape() {
        if bounds.width > 0 && bounds.height > 0 {
            flow.passAt = IntroModel.shieldPass(nDistance: IntroModel.nDistance(total: right - left, aspect: Double(bounds.width / bounds.height)))
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != laidOut {
            laidOut = bounds.size
            frozenDrawn = 0
            shape()
        }
        // The hint stands at the bottom, above the home indicator.
        let inset = safeAreaInsets.bottom
        let height = Swift.min(bounds.height, inset + 176)
        hint.inset = inset
        hint.frame = CGRect(x: 0, y: bounds.height - height, width: bounds.width, height: height)
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    // MARK: The clock

    /// Runs on the screen's frames (again after `pause`).
    func play() {
        if link != nil { return }
        last = 0
        let made = CADisplayLink(target: self, selector: #selector(onFrame(_:)))
        // The scene is drawn at 60 frames a second at most, as it was made and checked (a ProMotion screen would
        // otherwise ask for twice the frames now that the app may go above 60 Hz).
        made.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        made.add(to: .main, forMode: .common)
        link = made
    }

    /// The app left the screen: nothing moves, nothing is drawn; a finger that was down is as lifted.
    func pause() {
        guard let running = link else { return }
        running.invalidate()
        link = nil
        flow.touchCancel()
    }

    /// The overlay is gone.
    func letGo() {
        pause()
        giveUp?.cancel()
        giveUp = nil
        onEvents = nil
        if let gone = scene {
            scene = nil
            gone.letGo()
            gone.removeFromSuperview()
        }
    }

    @objc private func onFrame(_ sender: CADisplayLink) {
        // A long hitch does not make the picture jump.
        let now = sender.timestamp
        let dt = last == 0 ? 0 : Swift.min(0.1, now - last)
        last = now
        step(dt)
    }

    /// One frame: `dt` seconds have passed since the last.
    func step(_ dt: Double) {
        if !ready {
            // The first picture is tried on every frame until it is on the screen (the scene then says it is ready).
            if let scene, scene.paint(t: flow.t, p: flow.p, clock: flow.clock, speed: flow.speed, squares: flow.t + flow.past), flow.frozen {
                frozenDrawn += 1
            }
            return
        }
        let events = flow.tick(dt)
        // A frozen picture is drawn a few times and left.
        if let scene, !flow.frozen || frozenDrawn < 3 {
            let drew = scene.paint(t: flow.t, p: flow.p, clock: flow.clock, speed: flow.speed, squares: flow.t + flow.past)
            if drew && flow.frozen { frozenDrawn += 1 }
        }
        stills?.show(flow.p)
        hint.update(wanted: flow.hintVisible, dt: dt)
        if events != 0 { onEvents?(events) }
    }

    // MARK: The touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first else { return }
        let y = touch.location(in: self).y
        downY = y
        lastY = y
        lastTime = touch.timestamp
        velocity = 0
        flow.touchDown()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first else { return }
        let y = touch.location(in: self).y
        follow(y, at: touch.timestamp)
        flow.drag(up: up(y))
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first else { return }
        let y = touch.location(in: self).y
        follow(y, at: touch.timestamp)
        flow.drag(up: up(y))
        // A finger that stopped before it left has not flung.
        let fresh = touch.timestamp - lastTime < 0.1
        flow.touchUp(fling: fresh && velocity < -IntroView.flingSpeed && downY - y > 0)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        flow.touchCancel()
    }

    /// The finger's speed down the screen, points a second, from its last moves.
    private func follow(_ y: CGFloat, at time: TimeInterval) {
        let passed = time - lastTime
        if passed < 0.002 { return }
        let now = (y - lastY) / CGFloat(passed)
        velocity = velocity * 0.4 + now * 0.6
        lastY = y
        lastTime = time
    }

    /// How far the finger is above where it came down, in steps: a little under half the screen is a whole step; the
    /// first few points (a tap's own wobble) do not count.
    private func up(_ y: CGFloat) -> Double {
        let moved = downY - y
        let span = Swift.max(1, bounds.height * 0.45)
        if moved > IntroView.slop { return Double((moved - IntroView.slop) / span) }
        if moved < 0 { return Double(moved / span) }
        return 0
    }
}

/// «Проведи вверх» with a finger mark that moves up, again and again. Drawn by the app over the scene, not part of it.
/// With motion reduced the mark stands still (an arrow up). It comes and goes softly. Android: IntroHint.
final class IntroHint: UIView {
    /// The finger mark moves (false: the still arrow).
    var moving = true
    /// The home indicator's room at the bottom, points.
    var inset: CGFloat = 0 {
        didSet { if inset != oldValue { setNeedsDisplay() } }
    }

    private static let words = "Проведи вверх"
    private var shown: Double = 0
    private var phase: Double = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityLabel = IntroHint.words
        accessibilityTraits = .staticText
    }

    required init?(coder: NSCoder) { return nil }

    /// Called every frame: whether the hint is wanted now, and the time since the last frame.
    func update(wanted: Bool, dt: Double) {
        let before = shown
        shown = IntroModel.clamp(shown + (wanted ? dt : -dt) / 0.35, 0, 1)
        if shown <= 0 {
            phase = 0
        } else if moving {
            phase += dt / 1.8
            if phase >= 1 { phase -= 1 }
        }
        if shown > 0 || before > 0 { setNeedsDisplay() }
    }

    override func draw(_ rect: CGRect) {
        guard shown > 0, let context = UIGraphicsGetCurrentContext() else { return }
        let a = IntroModel.ease(shown)
        let cx = bounds.width / 2
        let baseline = bounds.height - inset - 44
        let font = Theme.font(15, .semibold)
        let text = NSAttributedString(string: IntroHint.words, attributes: [
            .font: font,
            .foregroundColor: UIColor(white: 1, alpha: CGFloat(0.84 * a)),
        ])
        let size = text.size()
        text.draw(at: CGPoint(x: cx - size.width / 2, y: baseline - font.ascender))

        let from = baseline - 44
        let travel: CGFloat = 52
        context.setLineWidth(1.6)
        context.setLineCap(.round)
        if !moving {
            // A plain arrow up.
            let top = from - 26
            let wing: CGFloat = 8
            context.setStrokeColor(UIColor(white: 1, alpha: CGFloat(0.8 * a)).cgColor)
            context.move(to: CGPoint(x: cx, y: from))
            context.addLine(to: CGPoint(x: cx, y: top))
            context.move(to: CGPoint(x: cx - wing, y: top + wing))
            context.addLine(to: CGPoint(x: cx, y: top))
            context.addLine(to: CGPoint(x: cx + wing, y: top + wing))
            context.strokePath()
            return
        }
        let rise = CGFloat(IntroModel.ease(phase / 0.7))
        let light = sin(Double.pi * Swift.min(1.0, phase / 0.9)) * a
        let y = from - travel * rise
        context.setStrokeColor(UIColor(white: 1, alpha: CGFloat(0.22 * light)).cgColor)
        context.move(to: CGPoint(x: cx, y: y + 10))
        context.addLine(to: CGPoint(x: cx, y: y + 10 + travel * rise * 0.55))
        context.strokePath()
        context.setStrokeColor(UIColor(white: 1, alpha: CGFloat(0.5 * light)).cgColor)
        context.strokeEllipse(in: CGRect(x: cx - 13, y: y - 13, width: 26, height: 26))
        context.setFillColor(UIColor(white: 1, alpha: CGFloat(0.9 * light)).cgColor)
        context.fillEllipse(in: CGRect(x: cx - 6, y: y - 6, width: 12, height: 12))
    }
}

/// The intro without flights (motion reduced, or a phone that cannot draw the scene): four calm still stages that
/// cross-fade one into the next with the steps — the word, N alone, the cipher, a soft dim blur. Android: IntroStills.
final class IntroStills: UIView {
    private struct Row {
        let signs: String
        let y: CGFloat
        let size: CGFloat
        let light: CGFloat
    }

    private let art: IntroArt?
    /// The word and N alone, cut from the word's picture.
    private var wordPicture: UIImage?
    private var signPicture: UIImage?
    private var rows: [Row] = []
    private var builtFor: CGSize = .zero
    private var p: Double = 0

    init(frame: CGRect, art: IntroArt?) {
        self.art = art
        super.init(frame: frame)
        isOpaque = true
        backgroundColor = IntroView.page
        isUserInteractionEnabled = false
        contentMode = .redraw
        if let art, let whole = art.image() {
            let top = Int(IntroArt.base - IntroArt.cap)
            let tall = Int(IntroArt.cap)
            let wordLeft = Int(IntroArt.left)
            let wordWide = Int(art.wordEnd) + 1 - wordLeft
            if let cut = whole.cropping(to: CGRect(x: wordLeft, y: top, width: wordWide, height: tall)) { wordPicture = UIImage(cgImage: cut) }
            let signLeft = Int(art.spans[1][0])
            let signWide = Int(art.spans[1][0] + art.spans[1][1]) + 1 - signLeft
            if let cut = whole.cropping(to: CGRect(x: signLeft, y: top, width: signWide, height: tall)) { signPicture = UIImage(cgImage: cut) }
        }
    }

    required init?(coder: NSCoder) { return nil }

    /// The progress through the steps, 0…4.
    func show(_ progress: Double) {
        if abs(progress - p) < 1e-6 { return }
        p = progress
        setNeedsDisplay()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = bounds.width
        let h = bounds.height
        if w <= 0 || h <= 0 || bounds.size == builtFor { return }
        builtFor = bounds.size
        // The cipher: rows of signs in groups, most of them dim and small, a few large and bright.
        var random = IntroModel.Random(seed: 7)
        var made: [Row] = []
        var y: CGFloat = 0
        var index = 0
        while y < h + 40 {
            let large = index % 5 == 2
            let size: CGFloat = large ? 30 : (index % 2 == 0 ? 13 : 18)
            y += size * 1.7
            let length = Int(w / (size * 0.6)) + 2
            var signs = [String](repeating: " ", count: length)
            var k = 0
            while k < length {
                let n = random.next() < 0.5 ? 2 : 4
                let on = random.next() < (large ? 0.3 : 0.6)
                for _ in 0..<n {
                    if k < length && on {
                        signs[k] = IntroArt.signs[Swift.max(0, Swift.min(15, Int(random.next() * 16)))]
                    }
                    k += 1
                }
                k += 1
            }
            made.append(Row(signs: signs.joined(), y: y, size: size, light: large ? 0.85 : (index % 2 == 0 ? 0.2 : 0.34)))
            index += 1
        }
        rows = made
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.setFillColor(IntroView.page.cgColor)
        context.fill(bounds)
        let w = bounds.width
        let h = bounds.height
        if w <= 0 || h <= 0 { return }
        let first = IntroModel.clamp(1 - p, 0, 1)
        let second = IntroModel.clamp(1 - abs(p - 1), 0, 1)
        let third = IntroModel.clamp(1 - abs(p - 2), 0, 1)
        let fourth = IntroModel.clamp(p - 2, 0, 1)
        let cap = CGFloat(IntroArt.cap)
        if let art, let picture = wordPicture, first > 0 {
            // The word across the screen less the margins.
            let span = CGFloat(art.wordEnd - IntroArt.left)
            let scale = Swift.min(w * CGFloat(1 - 2 * IntroModel.margin) / span, h * 0.3 / cap)
            let x = (w - span * scale) / 2
            let y = h * 0.46 - cap * scale / 2
            stand(context, picture, CGRect(x: x, y: y, width: span * scale, height: cap * scale), first)
        }
        if let art, let picture = signPicture, second > 0 {
            // N alone at the centre.
            let wide = CGFloat(art.spans[1][1])
            let scale = Swift.min(h * 0.25 / cap, w * 0.58 / wide)
            let x = (w - wide * scale) / 2
            let y = h * 0.46 - cap * scale / 2
            stand(context, picture, CGRect(x: x, y: y, width: wide * scale, height: cap * scale), second)
        }
        if third > 0 {
            for row in rows {
                let font = UIFont.monospacedSystemFont(ofSize: row.size, weight: .bold)
                let colour = UIColor(red: 0xBF / 255.0, green: 0xD6 / 255.0, blue: 1, alpha: row.light * CGFloat(third))
                let text = NSAttributedString(string: row.signs, attributes: [.font: font, .foregroundColor: colour])
                text.draw(at: CGPoint(x: 0, y: row.y - font.ascender))
            }
        }
        if fourth > 0 {
            let colours = [
                UIColor(red: 0x23 / 255.0, green: 0x2B / 255.0, blue: 0x42 / 255.0, alpha: 1).cgColor,
                UIColor(red: 0x10 / 255.0, green: 0x14 / 255.0, blue: 0x1F / 255.0, alpha: 1).cgColor,
                IntroView.page.cgColor,
            ] as CFArray
            let stops: [CGFloat] = [0, 0.55, 1]
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colours, locations: stops) {
                let centre = CGPoint(x: w / 2, y: h * 0.46)
                context.saveGState()
                context.setAlpha(CGFloat(fourth))
                context.drawRadialGradient(gradient, startCenter: centre, startRadius: 0, endCenter: centre, endRadius: Swift.max(w, h) * 0.75, options: [.drawsAfterEndLocation])
                context.restoreGState()
            }
        }
    }

    /// The picture at `place`, with a faint mirror image under it.
    private func stand(_ context: CGContext, _ picture: UIImage, _ place: CGRect, _ light: Double) {
        picture.draw(in: place, blendMode: .normal, alpha: CGFloat(0.92 * light))
        context.saveGState()
        context.translateBy(x: 0, y: 2 * place.maxY)
        context.scaleBy(x: 1, y: -1)
        picture.draw(in: place, blendMode: .normal, alpha: CGFloat(0.1 * light))
        context.restoreGState()
    }
}
