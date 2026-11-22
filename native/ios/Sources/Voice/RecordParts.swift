import UIKit

/// The pieces of the composer's record button (owner's spec: the recording and sending of voice and round video
/// messages look and move exactly as the owner described them, every number below is part of that spec):
/// the button itself with its touch tracking, the swelling blob around it, the lock above it, the «slide to cancel»
/// line, the tooltip, and the preview of a stopped voice take. Sources/Voice/RecordControl.swift puts them together.

enum RecordSpec {
    /// The finger must stay this long on the button before a take starts; a shorter touch switches the mode.
    static let holdSeconds = 0.19
    /// A new touch this soon after the previous one is ignored.
    static let touchDebounce = 0.4
    /// While holding: a slide this far left calls the take off, this far up locks it.
    static let cancelDistance: CGFloat = 150
    static let lockDistance: CGFloat = 110
    /// On release: the larger of the two movements decides; this far (or a flick this fast) left cancels, up locks.
    static let cancelOnRelease: CGFloat = 100
    static let lockOnRelease: CGFloat = 60
    static let flick: CGFloat = 400
    /// The blob shrinks while the finger slides left: 1 − distance / 300, never under 0.4.
    static let shrinkDistance: CGFloat = 300
    static let minScale: CGFloat = 0.4
    /// The lock closes over this much of the slide up.
    static let lockRange: CGFloat = 105
    /// Per frame the shown translations move 30% of the way to the finger, the level 10% of the way to the voice.
    static let follow: CGFloat = 0.3
    static let levelFollow: CGFloat = 0.1
    /// The blob view's side and the part of it that takes taps.
    static let blobSide: CGFloat = 220
    static let blobHitSide: CGFloat = 110
    /// The lock's glass: 40 × 72, its centre 122 pt above the button's centre.
    static let lockLift: CGFloat = 122
    /// The red recording dot.
    static let dotColor = UIColor(hex: 0xFF2D55, alpha: 1)
    /// The trash the dot turns into when a take is called off.
    static let binColor = UIColor(hex: 0xFF3B30, alpha: 1)
    /// The layout transitions of the composer: 0.4 s on this curve.
    static let layoutDuration = 0.4
    static func layoutTiming() -> UICubicTimingParameters {
        UICubicTimingParameters(controlPoint1: CGPoint(x: 0.38, y: 0.7), controlPoint2: CGPoint(x: 0.125, y: 1))
    }
    static func layoutCurve() -> CAMediaTimingFunction {
        CAMediaTimingFunction(controlPoints: 0.38, 0.7, 0.125, 1)
    }

    /// The colour of the composer's quiet controls (lock, arrow, «slide to cancel»).
    static var controlColor: UIColor { Theme.muted }

    /// Runs `changes` as one of the composer's layout transitions.
    static func animateLayout(_ changes: @escaping () -> Void) {
        let animator = UIViewPropertyAnimator(duration: layoutDuration, timingParameters: layoutTiming())
        animator.addAnimations(changes)
        animator.startAnimation()
    }
}

// MARK: - The button

/// The microphone / camera button: it follows the touch itself (down, moving, up) rather than through gesture
/// recognisers, so the very first movement already counts. It takes touches 10 pt beyond its sides.
final class RecordMicButton: UIControl {
    /// Down on the button: false when the touch must be ignored.
    var onDown: (() -> Bool)?
    /// The finger moved: its offset from where it went down (only left and up count, both ≤ 0) and its velocity.
    var onMove: ((CGPoint, CGPoint) -> Bool)?
    /// The finger left the screen: the offset and the last velocity.
    var onUp: ((CGPoint, CGPoint) -> Void)?
    var onCancel: (() -> Void)?

    let iconView = UIImageView()
    private var start = CGPoint.zero
    private var lastPoint = CGPoint.zero
    private var lastTime = 0.0
    private var velocity = CGPoint.zero
    private var holding = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isExclusiveTouch = true
        isMultipleTouchEnabled = false
        iconView.contentMode = .center
        iconView.isUserInteractionEnabled = false
        addSubview(iconView)
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        let saved = iconView.transform
        iconView.transform = .identity
        iconView.frame = bounds
        iconView.transform = saved
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        return bounds.insetBy(dx: -10, dy: 0).contains(point)
    }

    private func offset(_ touch: UITouch) -> CGPoint {
        let point = touch.location(in: self)
        return CGPoint(x: min(0, point.x - start.x), y: min(0, point.y - start.y))
    }

    override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        guard onDown?() ?? false else { return false }
        start = touch.location(in: self)
        lastPoint = start
        lastTime = touch.timestamp
        velocity = .zero
        holding = true
        return true
    }

    override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        guard holding else { return false }
        let point = touch.location(in: self)
        let elapsed = touch.timestamp - lastTime
        if elapsed > 0.001 {
            velocity = CGPoint(x: (point.x - lastPoint.x) / CGFloat(elapsed), y: (point.y - lastPoint.y) / CGFloat(elapsed))
        }
        lastPoint = point
        lastTime = touch.timestamp
        let keep = onMove?(offset(touch), velocity) ?? false
        if !keep { holding = false }
        return keep
    }

    override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
        guard holding else { return }
        holding = false
        let end = touch.map { offset($0) } ?? .zero
        onUp?(end, velocity)
    }

    override func cancelTracking(with event: UIEvent?) {
        guard holding else { return }
        holding = false
        onCancel?()
    }
}

// MARK: - The blob

/// The swelling shapes around the button while a take runs: a solid circle (the button, 0.45…0.55 of the view's
/// side with the level), a wavy shape at 30% (0.52…0.87) and a wavy shape at 15% (0.57…1.0). The wavy shapes take
/// a new random form whenever the last one is reached, faster and wilder the louder the voice was meanwhile; they
/// grow from 0.75 of their size in 0.35 s when the take starts and shrink back in 0.15 s when it ends.
final class RecordBlobView: UIView {
    private struct Wave {
        let layer = CAShapeLayer()
        let minScale: CGFloat
        let maxScale: CGFloat
        let minSpeed: CGFloat
        let maxSpeed: CGFloat
        let minRandom: CGFloat
        let maxRandom: CGFloat
        let round: Bool
    }

    private var waves: [Wave] = []
    private var displayLink: CADisplayLink?
    private var level: CGFloat = 0
    private var shownLevel: CGFloat = 0
    private var speedLevels: [CGFloat] = [0, 0, 0]
    private var presence: CGFloat = 0.75
    private var presenceFrom: CGFloat = 0.75
    private var presenceTo: CGFloat = 0.75
    private var presenceStart = 0.0
    private var presenceDuration = 0.0
    private(set) var running = false
    let iconView = UIImageView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        waves = [
            Wave(minScale: 0.57, maxScale: 1.0, minSpeed: 0.9, maxSpeed: 4, minRandom: 1, maxRandom: 1, round: false),
            Wave(minScale: 0.52, maxScale: 0.87, minSpeed: 0.9, maxSpeed: 4, minRandom: 1, maxRandom: 1, round: false),
            Wave(minScale: 0.45, maxScale: 0.55, minSpeed: 0.2, maxSpeed: 0.6, minRandom: 0.1, maxRandom: 0.5, round: true),
        ]
        for wave in waves {
            wave.layer.strokeColor = nil
            wave.layer.transform = CATransform3DMakeScale(wave.minScale, wave.minScale, 1)
            layer.addSublayer(wave.layer)
        }
        iconView.contentMode = .center
        addSubview(iconView)
        setColor(Theme.accent)
    }

    required init?(coder: NSCoder) { return nil }

    func setColor(_ color: UIColor) {
        waves[0].layer.fillColor = color.withAlphaComponent(0.15).cgColor
        waves[1].layer.fillColor = color.withAlphaComponent(0.3).cgColor
        waves[2].layer.fillColor = color.cgColor
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let side = RecordSpec.blobHitSide
        return CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side).contains(point)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let middle = CGPoint(x: bounds.midX, y: bounds.midY)
        for (index, wave) in waves.enumerated() {
            wave.layer.bounds = CGRect(x: 0, y: 0, width: 0, height: 0)
            wave.layer.position = middle
            if wave.round {
                let half = bounds.width / 2
                wave.layer.path = UIBezierPath(ovalIn: CGRect(x: -half, y: -half, width: half * 2, height: half * 2)).cgPath
            } else if wave.layer.path == nil || index < 0 {
                wave.layer.path = RecordBlobView.blobPath(side: bounds.width, randomness: wave.minRandom)
            }
        }
        CATransaction.commit()
        iconView.frame = bounds
    }

    /// The loudness, 0…1.
    func updateLevel(_ value: CGFloat) {
        let normal = min(1, max(0, value))
        for index in 0..<speedLevels.count { speedLevels[index] = max(speedLevels[index], normal) }
        level = normal
    }

    func start() {
        guard !running else { return }
        running = true
        animatePresence(to: 1, duration: 0.35)
        for index in 0..<2 { morph(index) }
        if displayLink == nil {
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }
    }

    func stop() {
        guard running else { return }
        running = false
        animatePresence(to: 0.75, duration: 0.15)
        for wave in waves { wave.layer.removeAnimation(forKey: "path") }
        // One more frame for the shrink; then the loop rests.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self, !self.running else { return }
            self.displayLink?.invalidate()
            self.displayLink = nil
            self.shownLevel = 0
            self.level = 0
        }
    }

    deinit { displayLink?.invalidate() }

    private func animatePresence(to value: CGFloat, duration: Double) {
        presenceFrom = presence
        presenceTo = value
        presenceStart = CACurrentMediaTime()
        presenceDuration = duration
    }

    @objc private func tick() {
        shownLevel = shownLevel * (1 - RecordSpec.levelFollow) + level * RecordSpec.levelFollow
        if presenceDuration > 0 {
            let progress = min(1, (CACurrentMediaTime() - presenceStart) / presenceDuration)
            presence = presenceFrom + (presenceTo - presenceFrom) * RecordBlobView.easeInOut(CGFloat(progress))
            if progress >= 1 { presenceDuration = 0 }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for wave in waves {
            var scale = wave.minScale + (wave.maxScale - wave.minScale) * shownLevel
            if !wave.round { scale *= presence }
            wave.layer.transform = CATransform3DMakeScale(scale, scale, 1)
        }
        CATransaction.commit()
    }

    private func morph(_ index: Int) {
        guard running, index < waves.count, !waves[index].round else { return }
        let wave = waves[index]
        let speedLevel = speedLevels[index]
        speedLevels[index] = 0
        let randomness = wave.minRandom + (wave.maxRandom - wave.minRandom) * speedLevel
        let next = RecordBlobView.blobPath(side: max(1, bounds.width), randomness: randomness)
        let animation = CABasicAnimation(keyPath: "path")
        animation.fromValue = wave.layer.presentation()?.path ?? wave.layer.path
        animation.toValue = next
        animation.duration = CFTimeInterval(1 / (wave.minSpeed + (wave.maxSpeed - wave.minSpeed) * speedLevel))
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        wave.layer.path = next
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            guard let self, self.running else { return }
            self.morph(index)
        }
        wave.layer.add(animation, forKey: "path")
        CATransaction.commit()
    }

    static func easeInOut(_ value: CGFloat) -> CGFloat {
        // The 0.42/0.58 cubic, solved well enough by its smooth-step shape.
        let x = min(1, max(0, value))
        return x * x * (3 - 2 * x)
    }

    /// A closed smooth shape through 8 points around the centre, each between 1 / (1 + randomness / 10) and 1 of
    /// the half side away, at angles 45° apart give or take 10%.
    static func blobPath(side: CGFloat, randomness: CGFloat) -> CGPath {
        let count = 8
        let step = CGFloat.pi * 2 / CGFloat(count)
        let near = 1 / (1 + randomness / 10)
        let begin = step * CGFloat.random(in: 0..<1)
        var points: [CGPoint] = []
        for index in 0..<count {
            let reach = (near + CGFloat.random(in: 0..<1) * (1 - near)) / 2
            let wobble = step * 0.1
            let angle = begin + CGFloat(index) * (step + step * (wobble * CGFloat.random(in: 0..<1) - wobble * 0.5))
            points.append(CGPoint(x: sin(angle) * reach * side, y: cos(angle) * reach * side))
        }
        return smoothClosed(points, count: count)
    }

    /// Each point gets a tangent along the line from its previous to its next neighbour; the handles are the
    /// circle-approximation share of the distance to the neighbours.
    static func smoothClosed(_ points: [CGPoint], count: Int) -> CGPath {
        let step = CGFloat.pi * 2 / CGFloat(count)
        let share = ((4 / 3) * tan(step / 4)) / sin(step / 2) / 2
        func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }
        var outHandles: [CGPoint] = []
        var inHandles: [CGPoint] = []
        for index in 0..<points.count {
            let previous = points[(index + points.count - 1) % points.count]
            let current = points[index]
            let next = points[(index + 1) % points.count]
            let dx = next.x - previous.x, dy = next.y - previous.y
            let length = max(0.0001, hypot(dx, dy))
            let ux = dx / length, uy = dy / length
            let outLength = share * distance(current, next)
            let inLength = share * distance(current, previous)
            outHandles.append(CGPoint(x: current.x + ux * outLength, y: current.y + uy * outLength))
            inHandles.append(CGPoint(x: current.x - ux * inLength, y: current.y - uy * inLength))
        }
        let path = UIBezierPath()
        path.move(to: points[0])
        for index in 0..<points.count {
            let next = (index + 1) % points.count
            path.addCurve(to: points[next], controlPoint1: outHandles[index], controlPoint2: inHandles[next])
        }
        path.close()
        return path.cgPath
    }
}

// MARK: - The lock

/// The padlock drawn in a 40 × 60 box. At rest it is open and bobs with the arrow under it (2 s each way); as the
/// finger slides up (`lockness` 0…1) the shackle drops into the body, the arrow folds away and the body turns into
/// a 16 pt rounded square — the stop button of a locked take.
final class RecordLockGlyph: UIView {
    private let body = CAShapeLayer()
    private let shackle = CAShapeLayer()
    private let arrow = CAShapeLayer()
    private(set) var lockness: CGFloat = 0
    var color: UIColor = RecordSpec.controlColor {
        didSet { paint() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        for line in [shackle, arrow] {
            line.fillColor = nil
            line.lineWidth = 1.33
            line.lineCap = .round
            line.lineJoin = .round
            layer.addSublayer(line)
        }
        layer.addSublayer(body)
        // The shackle, its anchor (the right leg's foot) at the layer's origin.
        let hoop = UIBezierPath()
        hoop.move(to: CGPoint(x: -10, y: -4))
        hoop.addLine(to: CGPoint(x: -10, y: -7))
        hoop.addArc(withCenter: CGPoint(x: -5, y: -7), radius: 5, startAngle: .pi, endAngle: 0, clockwise: true)
        hoop.addLine(to: CGPoint(x: 0, y: 0))
        shackle.path = hoop.cgPath
        shackle.anchorPoint = .zero
        shackle.bounds = .zero
        let chevron = UIBezierPath()
        chevron.move(to: CGPoint(x: -8, y: 3))
        chevron.addLine(to: CGPoint(x: 0, y: -3))
        chevron.addLine(to: CGPoint(x: 8, y: 3))
        arrow.path = chevron.cgPath
        arrow.bounds = .zero
        paint()
        update(lockness: 0)
        bob()
    }

    required init?(coder: NSCoder) { return nil }

    private func paint() {
        body.fillColor = color.cgColor
        body.strokeColor = color.cgColor
        body.lineWidth = 1.33
        shackle.strokeColor = color.cgColor
        arrow.strokeColor = color.cgColor
    }

    private static func ease(_ from: CGFloat, _ to: CGFloat, _ frame: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat {
        if frame <= a { return from }
        if frame >= b { return to }
        return from + (to - from) * RecordBlobView.easeInOut((frame - a) / (b - a))
    }

    /// The resting bob: the shackle rises and tilts, the arrow rises, on the 120-frame (2 s) cycle, back and forth.
    private func bob() {
        let times: [NSNumber] = [0, 0.375, 0.4917, 0.625, 1]
        let curve = CAMediaTimingFunction(controlPoints: 0.333, 0, 0.667, 1)
        let shackleY = CAKeyframeAnimation(keyPath: "transform.translation.y")
        shackleY.values = [0, 1.667, 0.833, 1.667, 0]
        shackleY.keyTimes = times
        shackleY.timingFunctions = [curve, curve, curve, curve]
        shackleY.isAdditive = true
        let tilt = CAKeyframeAnimation(keyPath: "transform.rotation.z")
        tilt.values = [10, 0, 5, 0, 10].map { (degrees: Double) -> Double in degrees * .pi / 180 }
        tilt.keyTimes = times
        tilt.timingFunctions = [curve, curve, curve, curve]
        tilt.isAdditive = true
        let group = CAAnimationGroup()
        group.animations = [shackleY, tilt]
        group.duration = 2
        group.autoreverses = true
        group.repeatCount = .infinity
        shackle.add(group, forKey: "bob")
        let arrowY = CAKeyframeAnimation(keyPath: "transform.translation.y")
        arrowY.values = [0, -1.667, -0.833, -1.667, 0]
        arrowY.keyTimes = times
        arrowY.timingFunctions = [curve, curve, curve, curve]
        arrowY.duration = 2
        arrowY.autoreverses = true
        arrowY.repeatCount = .infinity
        arrowY.isAdditive = true
        arrow.add(arrowY, forKey: "bob")
    }

    func update(lockness value: CGFloat) {
        let wasResting = lockness <= 0
        lockness = min(1, max(0, value))
        let frame = lockness * 30
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // The body: 16 × 14 → 16 × 16, down 8.33 pt then back up 3.33 (frames 0–13–23).
        let bodyY = lockness <= 0 ? 25 : (frame <= 13 ? RecordLockGlyph.ease(25, 33.33, frame, 0, 13) : RecordLockGlyph.ease(33.33, 30, frame, 13, 23))
        let bodyHeight = RecordLockGlyph.ease(14, 16, frame, 13, 23)
        let rect = CGRect(x: -8, y: -bodyHeight / 2, width: 16, height: bodyHeight)
        body.path = UIBezierPath(roundedRect: rect, cornerRadius: 3).cgPath
        body.position = CGPoint(x: 20, y: bodyY)
        // The shackle's foot: 5.33 above the body's centre at rest, 6.67 below it at frame 15 (inside the body).
        let footY = RecordLockGlyph.ease(-5.33, 6.67, frame, 0, 15)
        shackle.position = CGPoint(x: 20 + 5, y: bodyY + footY)
        let tilt = RecordLockGlyph.ease(10, 0, frame, 0, 10) * .pi / 180
        shackle.setAffineTransform(lockness <= 0 ? .identity : CGAffineTransform(rotationAngle: tilt))
        shackle.strokeStart = frame <= 10 ? RecordLockGlyph.ease(0, 0.07, frame, 0, 10) : RecordLockGlyph.ease(0.07, 0.5, frame, 10, 15)
        shackle.strokeEnd = frame <= 10 ? RecordLockGlyph.ease(0.9, 0.79, frame, 0, 10) : RecordLockGlyph.ease(0.79, 0.5, frame, 10, 13)
        // The arrow: 22 pt below the body's centre, folding into it by frame 16, its stroke gone by frame 12.
        let arrowOffset = lockness <= 0 ? 22 : RecordLockGlyph.ease(22, 1.34, frame, 0, 16)
        arrow.position = CGPoint(x: 20, y: lockness <= 0 ? 47 : bodyY + arrowOffset)
        arrow.strokeStart = RecordLockGlyph.ease(0, 0.5, frame, 5, 12)
        arrow.strokeEnd = RecordLockGlyph.ease(1, 0.5, frame, 5, 12)
        CATransaction.commit()
        if lockness > 0 && wasResting {
            shackle.removeAnimation(forKey: "bob")
            arrow.removeAnimation(forKey: "bob")
        } else if lockness <= 0 && !wasResting {
            bob()
        }
    }
}

/// The lock above the button: a glass pill 40 × 72 with the padlock; as the lock closes the pill shrinks to a
/// 40 pt circle at its lower end (72 − 32 × lockness tall, 40 × lockness down) and the padlock moves up 16 pt with it.
final class RecordLockPanel: UIView {
    let glass = GlassPill(interactive: false)
    let glyph = RecordLockGlyph(frame: CGRect(x: 0, y: 0, width: 40, height: 60))
    /// The stop button of a locked take: the padlock's square.
    var onStop: (() -> Void)?
    private(set) var lockness: CGFloat = 0
    private(set) var locked = false

    override init(frame: CGRect) {
        super.init(frame: CGRect(x: 0, y: 0, width: 40, height: 72))
        addSubview(glass)
        glass.contentView.addSubview(glyph)
        glass.isUserInteractionEnabled = false
        accessibilityLabel = "Остановить и прослушать"
        accessibilityTraits = .button
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        update(lockness: 0)
    }

    required init?(coder: NSCoder) { return nil }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard locked else { return false }
        return glass.frame.insetBy(dx: -6, dy: -6).contains(point)
    }

    func update(lockness value: CGFloat) {
        lockness = min(1, max(0, value))
        glass.frame = CGRect(x: 0, y: 40 * lockness, width: 40, height: 72 - 32 * lockness)
        glass.shape(radius: 20)
        glyph.frame = CGRect(x: 0, y: 6 - 16 * lockness, width: 40, height: 60)
        glyph.update(lockness: lockness)
    }

    /// The take is locked: the pill settles into the circle in 0.2 s and the square becomes a button.
    func lock() {
        locked = true
        isAccessibilityElement = true
        UIView.animate(withDuration: 0.2) { self.update(lockness: 1) }
    }

    func reset() {
        locked = false
        isAccessibilityElement = false
        update(lockness: 0)
    }

    @objc private func tapped() {
        if locked { onStop?() }
    }
}

// MARK: - «Slide to cancel»

/// The arrow (a 9 × 18 chevron) and «Влево — отмена» 14 pt in the quiet colour, 6 pt apart; once the take is locked
/// they give way to «Отмена» 17 pt in the accent colour (the words rise 22 pt and shrink to a quarter in 0.2–0.25 s,
/// the button comes up from 22 pt below growing from a quarter).
final class RecordCancelIndicator: UIView {
    private let arrow = CAShapeLayer()
    private let arrowHolder = UIView()
    private let label = UILabel()
    let cancelButton = UIButton(type: .custom)
    private(set) var showingCancel = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        let chevron = UIBezierPath()
        chevron.move(to: CGPoint(x: 7.97, y: 0.97))
        chevron.addLine(to: CGPoint(x: 0.97, y: 9))
        chevron.addLine(to: CGPoint(x: 7.97, y: 17.03))
        arrow.path = chevron.cgPath
        arrow.fillColor = nil
        arrow.lineWidth = 1.33
        arrow.lineCap = .round
        arrow.lineJoin = .round
        arrowHolder.layer.addSublayer(arrow)
        arrowHolder.isUserInteractionEnabled = false
        addSubview(arrowHolder)
        label.text = "Влево — отмена"
        label.font = .systemFont(ofSize: 14)
        addSubview(label)
        cancelButton.setTitle("Отмена", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 17)
        cancelButton.alpha = 0
        cancelButton.accessibilityLabel = "Отменить запись"
        addSubview(cancelButton)
        recolor()
        let labelSize = label.sizeThatFits(CGSize(width: 200, height: 100))
        let height = max(18, ceil(labelSize.height))
        bounds = CGRect(x: 0, y: 0, width: 9 + 12 + ceil(labelSize.width), height: height)
        arrowHolder.frame = CGRect(x: 0, y: floor((height - 18) / 2), width: 9, height: 18)
        label.frame = CGRect(x: 9 + 6, y: 1 + floor((height - ceil(labelSize.height)) / 2), width: ceil(labelSize.width), height: ceil(labelSize.height))
        let cancelSize = cancelButton.sizeThatFits(CGSize(width: 200, height: 100))
        cancelButton.frame = CGRect(x: floor((bounds.width - cancelSize.width) / 2), y: floor((height - cancelSize.height) / 2), width: cancelSize.width, height: cancelSize.height)
    }

    required init?(coder: NSCoder) { return nil }

    func recolor() {
        arrow.strokeColor = RecordSpec.controlColor.cgColor
        label.textColor = RecordSpec.controlColor
        cancelButton.setTitleColor(Theme.accent, for: .normal)
        cancelButton.setTitleColor(Theme.accent.withAlphaComponent(0.4), for: .highlighted)
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        return showingCancel && cancelButton.frame.insetBy(dx: -5, dy: -5).contains(point)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        return self.point(inside: point, with: event) ? cancelButton : nil
    }

    func showCancel(_ value: Bool, animated: Bool) {
        guard value != showingCancel else { return }
        showingCancel = value
        if value {
            arrowHolder.alpha = 0
            label.alpha = 0
            cancelButton.alpha = 1
            guard animated else { return }
            let rise = CABasicAnimation(keyPath: "position")
            rise.fromValue = NSValue(cgPoint: .zero)
            rise.toValue = NSValue(cgPoint: CGPoint(x: 0, y: -22))
            rise.isAdditive = true
            rise.duration = 0.2
            rise.fillMode = .forwards
            rise.isRemovedOnCompletion = false
            label.layer.add(rise, forKey: "rise")
            let shrink = CABasicAnimation(keyPath: "transform.scale")
            shrink.fromValue = 1
            shrink.toValue = 0.25
            shrink.duration = 0.25
            shrink.fillMode = .forwards
            shrink.isRemovedOnCompletion = false
            label.layer.add(shrink, forKey: "shrink")
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1
            fade.toValue = 0
            fade.duration = 0.25
            label.layer.add(fade, forKey: "fade")
            arrowHolder.layer.add(fade, forKey: "fade")
            let come = CABasicAnimation(keyPath: "position")
            come.fromValue = NSValue(cgPoint: CGPoint(x: 0, y: 22))
            come.toValue = NSValue(cgPoint: .zero)
            come.isAdditive = true
            come.duration = 0.2
            cancelButton.layer.add(come, forKey: "come")
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 0.25
            grow.toValue = 1
            grow.duration = 0.25
            cancelButton.layer.add(grow, forKey: "grow")
            let appear = CABasicAnimation(keyPath: "opacity")
            appear.fromValue = 0
            appear.toValue = 1
            appear.duration = 0.25
            cancelButton.layer.add(appear, forKey: "appear")
        } else {
            label.layer.removeAllAnimations()
            arrowHolder.alpha = 1
            label.alpha = 1
            cancelButton.alpha = 0
        }
    }
}

// MARK: - The tooltip

/// A dark bubble (black at 80%, corners 10, an 18 × 9 arrow) with 14 pt white words, its arrow on the button's
/// top centre; it fades in in 0.25 s, stays 2 s and fades out in 0.3 s.
final class RecordTooltip: UIView {
    private let label = UILabel()
    private let shape = CAShapeLayer()
    private var hide: DispatchWorkItem?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.addSublayer(shape)
        shape.fillColor = UIColor(white: 0, alpha: 0.8).cgColor
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.15
        layer.shadowRadius = 10
        layer.shadowOffset = .zero
        label.font = .systemFont(ofSize: 14)
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        addSubview(label)
        alpha = 0
    }

    required init?(coder: NSCoder) { return nil }

    /// `anchor`: the button's frame in the superview.
    func show(_ words: String, anchor: CGRect, in host: UIView) {
        if superview !== host { host.addSubview(self) }
        host.bringSubviewToFront(self)
        let wasShown = alpha > 0
        label.text = words
        let maxWidth = host.bounds.width - 20 - 16
        var size = label.sizeThatFits(CGSize(width: maxWidth, height: .greatestFiniteMagnitude))
        size.width = ceil(size.width / 2) * 2
        size.height = ceil(size.height / 2) * 2
        let box = CGSize(width: size.width + 12, height: size.height + 34)
        let x = floor(min(max(8, anchor.midX - box.width / 2), host.bounds.width - box.width - 8))
        frame = CGRect(x: x, y: anchor.minY - box.height, width: box.width, height: box.height)
        label.frame = CGRect(x: 6, y: 17, width: size.width, height: size.height)
        shape.path = RecordTooltip.bubble(size: box, arrowX: anchor.midX - x)
        if !wasShown {
            UIView.animate(withDuration: 0.25) { self.alpha = 1 }
        }
        hide?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.dismiss() }
        hide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    func dismiss() {
        hide?.cancel()
        guard alpha > 0 else { return }
        UIView.animate(withDuration: 0.3) { self.alpha = 0 }
    }

    private static func bubble(size: CGSize, arrowX requested: CGFloat) -> CGPath {
        let radius: CGFloat = 10, inset: CGFloat = 9, arrowWidth: CGFloat = 18
        let arrowX = max(radius + arrowWidth / 2, min(size.width - radius - arrowWidth / 2, requested))
        let path = UIBezierPath()
        path.move(to: CGPoint(x: 0, y: inset + radius))
        path.addArc(withCenter: CGPoint(x: radius, y: inset + radius), radius: radius, startAngle: .pi, endAngle: .pi * 1.5, clockwise: true)
        path.addLine(to: CGPoint(x: size.width - radius, y: inset))
        path.addArc(withCenter: CGPoint(x: size.width - radius, y: inset + radius), radius: radius, startAngle: .pi * 1.5, endAngle: 0, clockwise: true)
        path.addLine(to: CGPoint(x: size.width, y: size.height - radius - inset))
        path.addArc(withCenter: CGPoint(x: size.width - radius, y: size.height - radius - inset), radius: radius, startAngle: 0, endAngle: .pi / 2, clockwise: true)
        path.addLine(to: CGPoint(x: arrowX + arrowWidth / 2, y: size.height - inset))
        path.addLine(to: CGPoint(x: arrowX, y: size.height))
        path.addLine(to: CGPoint(x: arrowX - arrowWidth / 2, y: size.height - inset))
        path.addLine(to: CGPoint(x: radius, y: size.height - inset))
        path.addArc(withCenter: CGPoint(x: radius, y: size.height - radius - inset), radius: radius, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        path.close()
        return path.cgPath
    }
}

// MARK: - The preview of a stopped voice take

/// The stopped take in the field, 40 pt tall: an accent capsule (3 pt in, 34 pt tall) spanning the kept part, the
/// waveform (2 pt bars 1 pt apart, up to 12 pt, 13 pt tall band 21 pt in from each side), white grips (3 × 12) at
/// the inner ends of 16 pt handles that trim the take (from 2 s on), and a capsule 63 × 22 in the middle with
/// play/pause and the time. Outside the kept part the waveform is the quiet colour at 40%; inside, white at 50%,
/// and what has played is white.
final class VoicePreviewPanel: UIView {
    var onToggle: (() -> Void)?
    /// A touch on the waveform: the fraction of the whole take to play from.
    var onSeek: ((Double) -> Void)?
    /// The kept part changed (fractions of the whole take); `done`: the finger left the handle.
    var onTrim: ((Double, Double, Bool) -> Void)?

    private let capsule = UIView()
    private let waveHolder = UIView()
    private let waveOutside = CAShapeLayer()
    private let waveInside = CAShapeLayer()
    private let wavePlayed = CAShapeLayer()
    private let insideMask = CALayer()
    private let playedMask = CALayer()
    private let leftGrip = UIView()
    private let rightGrip = UIView()
    private let leftHandle = UIView()
    private let rightHandle = UIView()
    private let playCapsule = UIView()
    private let playIcon = UIImageView()
    private let timeLabel = UILabel()
    private var samples: [Double] = []
    private var durationMs = 0
    private(set) var trimStart: Double = 0
    private(set) var trimEnd: Double = 1
    private var progress: Double = 0
    private var playing = false
    private var dragStart: Double = 0
    /// A round video's preview: no waveform and no handles, only the capsule with play and the time.
    var allowsTrim = true {
        didSet { setNeedsLayout() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        capsule.layer.cornerRadius = 17
        capsule.layer.cornerCurve = .continuous
        addSubview(capsule)
        addSubview(waveHolder)
        waveHolder.isUserInteractionEnabled = false
        for wave in [waveOutside, waveInside, wavePlayed] { waveHolder.layer.addSublayer(wave) }
        insideMask.backgroundColor = UIColor.black.cgColor
        playedMask.backgroundColor = UIColor.black.cgColor
        waveInside.mask = insideMask
        wavePlayed.mask = playedMask
        for (handle, grip) in [(leftHandle, leftGrip), (rightHandle, rightGrip)] {
            grip.backgroundColor = Theme.onAccent // the grip sits on the accent
            grip.layer.cornerRadius = 1
            grip.isUserInteractionEnabled = false
            handle.addSubview(grip)
            let drag = UILongPressGestureRecognizer(target: self, action: #selector(dragged(_:)))
            drag.minimumPressDuration = 0
            drag.allowableMovement = .infinity
            handle.addGestureRecognizer(drag)
            addSubview(handle)
        }
        playCapsule.layer.cornerRadius = 11
        playCapsule.clipsToBounds = true
        addSubview(playCapsule)
        playIcon.contentMode = .center
        playCapsule.addSubview(playIcon)
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
        timeLabel.textAlignment = .right
        playCapsule.addSubview(timeLabel)
        playCapsule.isAccessibilityElement = true
        playCapsule.accessibilityTraits = .button
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(waveTapped(_:))))
        recolor()
    }

    required init?(coder: NSCoder) { return nil }

    func recolor() {
        capsule.backgroundColor = Theme.accent
        for grip in [leftGrip, rightGrip] { grip.backgroundColor = Theme.onAccent }
        playCapsule.backgroundColor = Theme.bg.withAlphaComponent(0.7)
        playIcon.tintColor = Theme.text.withAlphaComponent(0.7)
        timeLabel.textColor = Theme.text.withAlphaComponent(0.7)
        waveOutside.fillColor = RecordSpec.controlColor.withAlphaComponent(0.4).cgColor
        waveInside.fillColor = Theme.onAccent.withAlphaComponent(0.5).cgColor
        wavePlayed.fillColor = Theme.onAccent.cgColor
        showPlayIcon()
    }

    func setTake(samples: [Double], durationMs: Int) {
        self.samples = samples
        self.durationMs = durationMs
        trimStart = 0
        trimEnd = 1
        progress = 0
        playing = false
        showPlayIcon()
        setNeedsLayout()
    }

    func setPlayback(progress value: Double, playing nowPlaying: Bool) {
        progress = min(1, max(0, value))
        if nowPlaying != playing {
            playing = nowPlaying
            showPlayIcon()
        }
        placeMasks()
        showTime()
    }

    private func showPlayIcon() {
        playIcon.image = IonIcon.image(playing ? "pause" : "play", size: 13).withRenderingMode(.alwaysTemplate)
        playCapsule.accessibilityLabel = playing ? "Пауза" : "Прослушать"
    }

    private func showTime() {
        let kept = Double(durationMs) * (trimEnd - trimStart)
        let shown: Double
        if playing || progress > trimStart + 0.0001 {
            shown = max(0, Double(durationMs) * (trimEnd - progress))
        } else {
            shown = kept
        }
        timeLabel.text = FileCore.call("voiceTime", [shown.rounded()]) as? String ?? ""
    }

    private var trackWidth: CGFloat { max(0, bounds.width - 6) }
    private let handleWidth: CGFloat = 16

    private func handleFrames() -> (CGRect, CGRect) {
        let range = trackWidth - handleWidth
        let left = floor(handleWidth / 2 + range * CGFloat(trimStart)) - handleWidth / 2
        var right = floor(handleWidth / 2 + range * CGFloat(trimEnd)) - handleWidth / 2
        right = max(left + handleWidth, right)
        return (CGRect(x: 3 + left, y: 3, width: handleWidth, height: 34), CGRect(x: 3 + right, y: 3, width: handleWidth, height: 34))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let (left, right) = handleFrames()
        capsule.frame = CGRect(x: left.minX, y: 3, width: right.maxX - left.minX, height: 34)
        leftHandle.frame = left.insetBy(dx: -9, dy: 0)
        rightHandle.frame = right.insetBy(dx: -9, dy: 0)
        leftGrip.frame = CGRect(x: 9 + 8, y: (34 - 12) / 2, width: 3, height: 12)
        rightGrip.frame = CGRect(x: 9 + handleWidth - 8 - 3, y: (34 - 12) / 2, width: 3, height: 12)
        let trims = durationMs >= 2000 && allowsTrim
        waveHolder.isHidden = !allowsTrim
        leftHandle.isHidden = !trims
        rightHandle.isHidden = !trims
        let band = CGRect(x: 21, y: floor((40 - 13) / 2), width: max(0, bounds.width - 42), height: 13)
        waveHolder.frame = band
        let path = VoicePreviewPanel.wavePath(samples: samples, size: band.size)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for wave in [waveOutside, waveInside, wavePlayed] {
            wave.frame = waveHolder.bounds
            wave.path = path
        }
        CATransaction.commit()
        placeMasks()
        let zone = max(0, right.minX - left.maxX)
        let wide = zone >= 70
        let button = CGSize(width: wide ? 63 : 27, height: 22)
        playCapsule.frame = CGRect(x: left.maxX + (zone - button.width) / 2, y: (40 - 22) / 2, width: button.width, height: 22)
        playIcon.frame = CGRect(x: 3, y: 0.5, width: 21, height: 21)
        timeLabel.frame = CGRect(x: 18, y: 3, width: 35, height: 16)
        timeLabel.alpha = wide ? 1 : 0
        showTime()
    }

    private func placeMasks() {
        let (left, right) = handleFrames()
        let origin = waveHolder.frame.minX
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        insideMask.frame = CGRect(x: left.minX - origin, y: -4, width: right.maxX - left.minX, height: waveHolder.bounds.height + 8)
        let playedX = CGFloat(progress) * waveHolder.bounds.width
        playedMask.frame = CGRect(x: insideMask.frame.minX, y: -4, width: max(0, min(insideMask.frame.maxX, playedX) - insideMask.frame.minX), height: waveHolder.bounds.height + 8)
        playedMask.isHidden = !(playing || progress > trimStart + 0.0001)
        CATransaction.commit()
    }

    /// Bars 2 pt wide every 3 pt, each the loudest of its share of the take, up to 12 pt, round at both ends; a quiet
    /// bar is a 2 pt dot. Centred in the band.
    static func wavePath(samples: [Double], size: CGSize) -> CGPath {
        let path = CGMutablePath()
        let count = Int(floor(size.width / 3))
        guard count > 0 else { return path }
        var bars = [Double](repeating: 0, count: count)
        if !samples.isEmpty {
            for (index, sample) in samples.enumerated() {
                let slot = min(count - 1, index * count / samples.count)
                bars[slot] = max(bars[slot], sample)
            }
        }
        let loudest = max(0.0001, bars.max() ?? 0)
        for index in 0..<count {
            let x = CGFloat(index) * 3
            let height = min(12, CGFloat(bars[index] / loudest) * 12)
            if height <= 2 {
                path.addEllipse(in: CGRect(x: x, y: (size.height - 2) / 2, width: 2, height: 2))
            } else {
                path.addRoundedRect(in: CGRect(x: x, y: (size.height - height) / 2, width: 2, height: height), cornerWidth: 1, cornerHeight: 1)
            }
        }
        return path
    }

    @objc private func waveTapped(_ tap: UITapGestureRecognizer) {
        if playCapsule.frame.contains(tap.location(in: self)) {
            onToggle?()
            return
        }
        let x = tap.location(in: waveHolder).x
        let fraction = Double(min(1, max(0, x / max(1, waveHolder.bounds.width))))
        onSeek?(min(trimEnd, max(trimStart, fraction)))
    }

    @objc private func dragged(_ press: UILongPressGestureRecognizer) {
        guard let handle = press.view else { return }
        let range = max(1, trackWidth - handleWidth)
        let x = press.location(in: self).x - 3 - handleWidth / 2
        let fraction = Double(min(1, max(0, x / range)))
        // At least 1 s, or 56 pt of the band.
        let least = max(1000.0, 56.0 * Double(durationMs) / Double(max(1, trackWidth))) / Double(max(1, durationMs))
        switch press.state {
        case .changed, .began:
            if handle === leftHandle { trimStart = min(fraction, trimEnd - least) } else { trimEnd = max(fraction, trimStart + least) }
            trimStart = max(0, trimStart)
            trimEnd = min(1, trimEnd)
            setNeedsLayout()
            layoutIfNeeded()
            onTrim?(trimStart, trimEnd, false)
        case .ended, .cancelled:
            onTrim?(trimStart, trimEnd, true)
        default:
            break
        }
    }
}

// MARK: - The preview of a stopped round video

/// The stopped round video in the field: a strip of its frames 33 pt tall with round ends, two accent handles 16 pt
/// wide with grips in onAccent (3 × 12, 10 pt in from the outer edge) that trim it, accent lines along the kept part, the
/// rest of the strip dimmed. A tap plays or pauses the circle.
final class VideoTrimPanel: UIView {
    var onToggle: (() -> Void)?
    var onTrim: ((Double, Double, Bool) -> Void)?
    private let strip = UIView()
    private var frameViews: [UIImageView] = []
    private let dimLeft = UIView()
    private let dimRight = UIView()
    private let leftHandle = UIView()
    private let rightHandle = UIView()
    private let leftGrip = UIView()
    private let rightGrip = UIView()
    private let topLine = UIView()
    private let bottomLine = UIView()
    private(set) var trimStart: Double = 0
    private(set) var trimEnd: Double = 1
    private var durationMs = 0
    private let handleWidth: CGFloat = 16
    private let trackHeight: CGFloat = 33

    override init(frame: CGRect) {
        super.init(frame: frame)
        strip.clipsToBounds = true
        strip.layer.cornerRadius = 16.5
        strip.isUserInteractionEnabled = false
        addSubview(strip)
        for dim in [dimLeft, dimRight] {
            dim.isUserInteractionEnabled = false
            strip.addSubview(dim)
        }
        for line in [topLine, bottomLine] {
            line.isUserInteractionEnabled = false
            addSubview(line)
        }
        for (handle, grip, left) in [(leftHandle, leftGrip, true), (rightHandle, rightGrip, false)] {
            handle.layer.cornerRadius = 16.5
            handle.layer.maskedCorners = left ? [.layerMinXMinYCorner, .layerMinXMaxYCorner] : [.layerMaxXMinYCorner, .layerMaxXMaxYCorner]
            grip.backgroundColor = Theme.onAccent // the grip sits on the accent
            grip.layer.cornerRadius = 1
            grip.isUserInteractionEnabled = false
            handle.addSubview(grip)
            let drag = UILongPressGestureRecognizer(target: self, action: #selector(dragged(_:)))
            drag.minimumPressDuration = 0
            drag.allowableMovement = .infinity
            handle.addGestureRecognizer(drag)
            addSubview(handle)
        }
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        isAccessibilityElement = false
        recolor()
    }

    required init?(coder: NSCoder) { return nil }

    func recolor() {
        for view in [leftHandle, rightHandle, topLine, bottomLine] { view.backgroundColor = Theme.accent }
        for grip in [leftGrip, rightGrip] { grip.backgroundColor = Theme.onAccent }
        dimLeft.backgroundColor = Theme.bg.withAlphaComponent(0.6)
        dimRight.backgroundColor = Theme.bg.withAlphaComponent(0.6)
        strip.backgroundColor = Theme.surface2
    }

    func setTake(durationMs: Int) {
        self.durationMs = durationMs
        trimStart = 0
        trimEnd = 1
        for view in frameViews { view.removeFromSuperview() }
        frameViews = []
        setNeedsLayout()
    }

    /// The frames, left to right (square, as the circle is).
    func setFrames(_ images: [UIImage]) {
        for view in frameViews { view.removeFromSuperview() }
        frameViews = images.map { (image: UIImage) -> UIImageView in
            let view = UIImageView(image: image)
            view.contentMode = .scaleAspectFill
            view.clipsToBounds = true
            return view
        }
        for view in frameViews { strip.insertSubview(view, at: 0) }
        setNeedsLayout()
    }

    /// How many frames fill the strip.
    var frameCount: Int { max(1, Int(ceil(max(1, bounds.width - 6) / trackHeight))) }

    private func handleFrames() -> (CGRect, CGRect) {
        let total = max(0, bounds.width - 6)
        let range = total - handleWidth
        let top = (bounds.height - trackHeight) / 2
        let left = floor(handleWidth / 2 + range * CGFloat(trimStart)) - handleWidth / 2
        let right = max(left + handleWidth, floor(handleWidth / 2 + range * CGFloat(trimEnd)) - handleWidth / 2)
        return (CGRect(x: 3 + left, y: top, width: handleWidth, height: trackHeight), CGRect(x: 3 + right, y: top, width: handleWidth, height: trackHeight))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let top = (bounds.height - trackHeight) / 2
        strip.frame = CGRect(x: 3, y: top, width: max(0, bounds.width - 6), height: trackHeight)
        let side = trackHeight
        for (index, view) in frameViews.enumerated() {
            view.frame = CGRect(x: CGFloat(index) * side, y: 0, width: side, height: side)
        }
        let (left, right) = handleFrames()
        leftHandle.frame = left
        rightHandle.frame = right
        leftGrip.frame = CGRect(x: 10 - 3, y: (trackHeight - 12) / 2, width: 3, height: 12)
        rightGrip.frame = CGRect(x: handleWidth - 10, y: (trackHeight - 12) / 2, width: 3, height: 12)
        dimLeft.frame = CGRect(x: 0, y: 0, width: max(0, left.minX - 3), height: trackHeight)
        dimRight.frame = CGRect(x: right.maxX - 3, y: 0, width: max(0, strip.bounds.width - (right.maxX - 3)), height: trackHeight)
        topLine.frame = CGRect(x: left.maxX, y: top, width: max(0, right.minX - left.maxX), height: 2)
        bottomLine.frame = CGRect(x: left.maxX, y: top + trackHeight - 2, width: max(0, right.minX - left.maxX), height: 2)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        for handle in [leftHandle, rightHandle] where handle.frame.insetBy(dx: -9, dy: -8).contains(point) { return handle }
        return super.hitTest(point, with: event)
    }

    @objc private func tapped() { onToggle?() }

    @objc private func dragged(_ press: UILongPressGestureRecognizer) {
        guard let handle = press.view else { return }
        let range = max(1, bounds.width - 6 - handleWidth)
        let fraction = Double(min(1, max(0, (press.location(in: self).x - 3 - handleWidth / 2) / range)))
        // At least 1 s.
        let least = 1000.0 / Double(max(1, durationMs))
        switch press.state {
        case .began, .changed:
            if handle === leftHandle { trimStart = max(0, min(fraction, trimEnd - least)) } else { trimEnd = min(1, max(fraction, trimStart + least)) }
            setNeedsLayout()
            layoutIfNeeded()
            onTrim?(trimStart, trimEnd, false)
        case .ended, .cancelled:
            onTrim?(trimStart, trimEnd, true)
        default:
            break
        }
    }
}
