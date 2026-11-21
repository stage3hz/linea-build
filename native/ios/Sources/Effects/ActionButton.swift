import UIKit

/// The button with states for signing in and saving (the reference's `ActionButton`, effects.tsx → expokit
/// `StatefulButton size="lg" block pill`, kit/ui/stateful-button.tsx): idle → loading (a spinner grows in beside the
/// label) → success (the label rolls letter by letter to «Готово», a check draws itself, the button turns green) or
/// error (a cross, «Ошибка», red, the button shakes) for 1.4 s after each new error. With the app's animations off
/// (Effects/Motion.swift) every change is shown at once.
final class ActionButton: UIControl {
    enum Phase { case idle, loading, success, error }

    // size "lg": height 54, padding 22, font 17, icon 20, gap 9.
    static let height: CGFloat = 54
    private static let iconSide: CGFloat = 20
    private static let gap: CGFloat = 9
    static let stagger: Double = 22

    /// The label at rest (and while loading).
    var label: String { didSet { refresh() } }
    var successLabel = "Готово" { didSet { refresh() } }
    /// While true the spinner turns and the button takes no touch.
    var loading = false { didSet { refresh() } }
    var success = false { didSet { refresh() } }
    /// The button's colour at rest (the theme's accent unless said otherwise).
    var tint: UIColor = Theme.accent { didSet { paint(animated: false) } }

    private var failed = false
    private var failTimer: Timer?
    private var phase = Phase.idle
    private let surface = UIView()
    private let slot = UIView()
    private let icon = UIView()
    private let ring = CAShapeLayer()
    private let arc = CAShapeLayer()
    private let mark = CAShapeLayer()
    private let roll = RollingLabel()
    private var slotWidth: NSLayoutConstraint?

    init(label: String) {
        self.label = label
        super.init(frame: .zero)
        surface.isUserInteractionEnabled = false
        surface.layer.cornerRadius = ActionButton.height / 2
        surface.layer.cornerCurve = .continuous
        surface.clipsToBounds = true
        surface.translatesAutoresizingMaskIntoConstraints = false
        addSubview(surface)
        let row = UIStackView(arrangedSubviews: [slot, roll])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 0
        row.isUserInteractionEnabled = false
        row.translatesAutoresizingMaskIntoConstraints = false
        surface.addSubview(row)
        slot.clipsToBounds = false
        icon.frame = CGRect(x: 0, y: 0, width: ActionButton.iconSide, height: ActionButton.iconSide)
        slot.addSubview(icon)
        let width = slot.widthAnchor.constraint(equalToConstant: 0)
        slotWidth = width
        NSLayoutConstraint.activate([
            surface.topAnchor.constraint(equalTo: topAnchor), surface.bottomAnchor.constraint(equalTo: bottomAnchor),
            surface.leadingAnchor.constraint(equalTo: leadingAnchor), surface.trailingAnchor.constraint(equalTo: trailingAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: ActionButton.height),
            row.centerXAnchor.constraint(equalTo: surface.centerXAnchor), row.centerYAnchor.constraint(equalTo: surface.centerYAnchor),
            row.leadingAnchor.constraint(greaterThanOrEqualTo: surface.leadingAnchor, constant: 22),
            slot.heightAnchor.constraint(equalToConstant: ActionButton.iconSide), width,
        ])
        // The spinner: a faint full ring and a short bright arc (r 9 of 24, stroke 2.75, dash 15 / 60).
        let scale = ActionButton.iconSide / 24
        let circle = UIBezierPath(arcCenter: CGPoint(x: 12 * scale, y: 12 * scale), radius: 9 * scale, startAngle: 0, endAngle: .pi * 2, clockwise: true)
        for shape in [ring, arc] {
            shape.path = circle.cgPath
            shape.fillColor = UIColor.clear.cgColor
            shape.lineWidth = 2.75 * scale
            shape.lineCap = .round
            icon.layer.addSublayer(shape)
        }
        arc.strokeEnd = 15 / (2 * .pi * 9)
        mark.fillColor = UIColor.clear.cgColor
        mark.lineWidth = 3 * scale
        mark.lineCap = .round
        mark.lineJoin = .round
        icon.layer.addSublayer(mark)
        icon.alpha = 0
        isAccessibilityElement = true
        accessibilityTraits = .button
        roll.font = Theme.font(17, .bold)
        roll.set(label, animated: false)
        addTarget(self, action: #selector(pressDown), for: [.touchDown, .touchDragEnter])
        addTarget(self, action: #selector(pressUp), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
        paint(animated: false)
        accessibilityLabel = label
    }

    required init?(coder: NSCoder) { return nil }

    deinit { failTimer?.invalidate() }

    /// A new error happened: «Ошибка» with a cross for 1.4 s.
    func signalError() {
        failTimer?.invalidate()
        failed = true
        refresh()
        failTimer = Timer.scheduledTimer(withTimeInterval: 1.4, repeats: false) { [weak self] (_: Timer) -> Void in
            guard let self else { return }
            self.failed = false
            self.refresh()
        }
    }

    override var isEnabled: Bool {
        didSet { surface.alpha = isEnabled || phase != .idle ? 1 : 0.5 }
    }

    override var intrinsicContentSize: CGSize { return CGSize(width: UIView.noIntrinsicMetric, height: ActionButton.height) }

    // MARK: Looks

    private static var darkLook: Bool { return Theme.dark }
    private static var okColor: UIColor { return darkLook ? UIColor(hex: 0x3DD68C) : UIColor(hex: 0x16A34A) }
    private static var badColor: UIColor { return darkLook ? UIColor(hex: 0xFF6369) : UIColor(hex: 0xE5484D) }

    /// Black or white, whichever reads better on the colour (kit's `readableOn`).
    static func readable(on colour: UIColor) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        colour.getRed(&r, green: &g, blue: &b, alpha: &a)
        return (r * 255 * 299 + g * 255 * 587 + b * 255 * 114) / 1000 > 150 ? UIColor(hex: 0x09090B) : .white
    }

    private func look(_ phase: Phase) -> (bg: UIColor, fg: UIColor) {
        switch phase {
        case .success: return (ActionButton.okColor, ActionButton.readable(on: ActionButton.okColor))
        case .error: return (ActionButton.badColor, .white)
        default: return (tint, ActionButton.readable(on: tint))
        }
    }

    private func paint(animated: Bool) {
        let colours = look(phase)
        let change = { [weak self] () -> Void in
            guard let self else { return }
            self.surface.backgroundColor = colours.bg
        }
        if animated { UIView.animate(withDuration: 0.22, animations: change) } else { change() }
        roll.color = colours.fg
        ring.strokeColor = colours.fg.withAlphaComponent(0.25).cgColor
        arc.strokeColor = colours.fg.cgColor
        mark.strokeColor = colours.fg.cgColor
        surface.alpha = isEnabled || phase != .idle ? 1 : 0.5
    }

    // MARK: State changes

    private func refresh() {
        let next: Phase = loading ? .loading : (success ? .success : (failed ? .error : .idle))
        let text = next == .success ? successLabel : (next == .error ? "Ошибка" : label)
        accessibilityLabel = label
        accessibilityValue = next == .loading ? "Загрузка" : (next == .idle ? nil : text)
        let moving = Motion.enabled
        roll.set(text, animated: moving)
        guard next != phase else { return }
        phase = next
        if next == .loading || next == .success || next == .error { UIAccessibility.post(notification: .announcement, argument: text) }
        paint(animated: moving)
        // The icon's slot opens beside the label and the icon grows in (or shrinks away on the way back).
        slotWidth?.constant = next == .idle ? 0 : ActionButton.iconSide + ActionButton.gap
        let spring = { [weak self] () -> Void in self?.layoutIfNeeded() }
        if moving {
            UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.95, initialSpringVelocity: 0, options: [.beginFromCurrentState], animations: spring, completion: nil)
        } else { spring() }
        arc.removeAnimation(forKey: "spin")
        icon.layer.removeAnimation(forKey: "spin")
        if next == .idle {
            UIView.animate(withDuration: moving ? 0.14 : 0) { [weak self] in
                self?.icon.alpha = 0
                self?.icon.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
            }
            return
        }
        ring.isHidden = next != .loading
        arc.isHidden = next != .loading
        mark.isHidden = next == .loading
        icon.alpha = moving ? 0.2 : 1
        icon.transform = moving ? CGAffineTransform(scaleX: 0.44, y: 0.44) : .identity
        if moving {
            UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0, options: [.beginFromCurrentState], animations: { [weak self] in
                self?.icon.alpha = 1
                self?.icon.transform = .identity
            }, completion: nil)
        }
        if next == .loading {
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = Double.pi * 2
            spin.duration = 0.8
            spin.repeatCount = .infinity
            icon.layer.add(spin, forKey: "spin")
            return
        }
        // The check (M6 12.5 l4 4 L18.5 8) or the cross (M7.5 7.5 l9 9 M16.5 7.5 l-9 9) draws itself.
        let s = ActionButton.iconSide / 24
        let path = UIBezierPath()
        if next == .error {
            path.move(to: CGPoint(x: 7.5 * s, y: 7.5 * s)); path.addLine(to: CGPoint(x: 16.5 * s, y: 16.5 * s))
            path.move(to: CGPoint(x: 16.5 * s, y: 7.5 * s)); path.addLine(to: CGPoint(x: 7.5 * s, y: 16.5 * s))
        } else {
            path.move(to: CGPoint(x: 6 * s, y: 12.5 * s)); path.addLine(to: CGPoint(x: 10 * s, y: 16.5 * s)); path.addLine(to: CGPoint(x: 18.5 * s, y: 8 * s))
        }
        mark.path = path.cgPath
        mark.removeAllAnimations()
        mark.strokeEnd = 1
        if moving {
            let draw = CABasicAnimation(keyPath: "strokeEnd")
            draw.fromValue = 0
            draw.toValue = 1
            draw.beginTime = CACurrentMediaTime() + 0.09
            draw.duration = 0.38
            draw.fillMode = .backwards
            draw.timingFunction = CAMediaTimingFunction(controlPoints: 0.33, 1, 0.68, 1)
            mark.add(draw, forKey: "draw")
        }
        let feedback = UINotificationFeedbackGenerator()
        feedback.notificationOccurred(next == .success ? .success : .error)
        if next == .error && moving {
            let shake = CAKeyframeAnimation(keyPath: "transform.translation.x")
            shake.values = [0, 10, -8, 6, -4, 2, 0]
            shake.keyTimes = [0, 1 / 6.0, 2 / 6.0, 3 / 6.0, 4 / 6.0, 5 / 6.0, 1].map { NSNumber(value: $0) }
            shake.duration = 0.3
            layer.add(shake, forKey: "shake")
        }
    }

    // MARK: Touches

    override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        if phase == .loading { return false }
        return super.beginTracking(touch, with: event)
    }

    @objc private func pressDown() {
        guard Motion.enabled else { return }
        UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.75, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: { [weak self] in
            self?.surface.transform = CGAffineTransform(scaleX: 0.96, y: 0.96)
        }, completion: nil)
    }

    @objc private func pressUp() {
        UIView.animate(withDuration: Motion.enabled ? 0.35 : 0, delay: 0, usingSpringWithDamping: 0.75, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: { [weak self] in
            self?.surface.transform = .identity
        }, completion: nil)
    }

    @objc private func tapped() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

/// A one-line label whose letters roll up and out while the next text rolls in from below (stateful-button.tsx
/// `RollLabel`): every letter 22 ms after the one before; in — opacity over 200 ms, rising a line on a firm spring
/// over 520 ms; out — within 120 ms in all, fading in 110 ms, leaving upwards over 300 ms.
final class RollingLabel: UIView {
    var font = UIFont.systemFont(ofSize: 17, weight: .bold) { didSet { rebuild(current, into: &entering); invalidateIntrinsicContentSize() } }
    var color = UIColor.white { didSet { (entering + leaving).forEach { $0.textColor = color } } }
    private var current = ""
    private var entering: [UILabel] = []
    private var leaving: [UILabel] = []
    private var link: CADisplayLink?
    private var started: CFTimeInterval = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setContentHuggingPriority(.required, for: .horizontal)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { link?.invalidate() }

    private var lineHeight: CGFloat { return ceil(font.pointSize * 1.3) }

    override var intrinsicContentSize: CGSize {
        let width = (current as NSString).size(withAttributes: [.font: font, .kern: -0.1]).width
        return CGSize(width: ceil(width) + 1, height: lineHeight)
    }

    func set(_ text: String, animated: Bool) {
        if text == current && !entering.isEmpty { return }
        let previous = entering
        leaving.forEach { $0.removeFromSuperview() }
        leaving = animated ? previous : []
        if !animated { previous.forEach { $0.removeFromSuperview() } }
        current = text
        var fresh: [UILabel] = []
        rebuild(text, into: &fresh)
        entering = fresh
        invalidateIntrinsicContentSize()
        link?.invalidate()
        link = nil
        guard animated, !previous.isEmpty || !fresh.isEmpty else {
            fresh.forEach { $0.alpha = 1; $0.transform = .identity }
            return
        }
        started = CACurrentMediaTime()
        let made = CADisplayLink(target: self, selector: #selector(frame(_:)))
        made.add(to: .main, forMode: .common)
        link = made
        step(0)
    }

    /// One label per letter, laid out as one line would set them.
    private func rebuild(_ text: String, into list: inout [UILabel]) {
        list.forEach { $0.removeFromSuperview() }
        list = []
        var x: CGFloat = 0
        for character in text {
            let piece = UILabel()
            piece.text = String(character)
            piece.font = font
            piece.textColor = color
            let width = (String(character) as NSString).size(withAttributes: [.font: font]).width - 0.1
            piece.frame = CGRect(x: x, y: 0, width: ceil(width) + 1, height: lineHeight)
            x += width
            addSubview(piece)
            list.append(piece)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The new text is centred in the box; the old one keeps its own place while it leaves.
        let width = entering.last.map { $0.frame.maxX } ?? 0
        let shift = max(0, (bounds.width - width) / 2) - (entering.first?.frame.minX ?? 0)
        for piece in entering { piece.frame.origin.x += shift }
    }

    @objc private func frame(_ link: CADisplayLink) {
        let ms = (CACurrentMediaTime() - started) * 1000
        step(ms)
        let total = Double(max(entering.count, leaving.count)) * ActionButton.stagger + 60 + 520
        if ms >= total {
            link.invalidate()
            self.link = nil
            leaving.forEach { $0.removeFromSuperview() }
            leaving = []
            step(.greatestFiniteMagnitude)
        }
    }

    private func step(_ ms: Double) {
        let line = lineHeight
        func part(_ start: Double, _ duration: Double) -> Double { return min(1, max(0, (ms - start) / duration)) }
        for (index, piece) in entering.enumerated() {
            let start = Double(index) * ActionButton.stagger + 60
            piece.alpha = CGFloat(AppearingTextView.easeOut(part(start, 200)))
            let t = part(start, 520)
            let settle = t >= 1 ? 1 : 1 - exp(-7 * t) * cos(7 * t)
            piece.transform = CGAffineTransform(translationX: 0, y: line * CGFloat(1 - settle))
        }
        let exitStagger = min(ActionButton.stagger, 120 / Double(max(leaving.count, 1)))
        for (index, piece) in leaving.enumerated() {
            let start = Double(index) * exitStagger
            piece.alpha = CGFloat(1 - AppearingTextView.easeOut(part(start, 110)))
            let t = part(start, 300)
            let eased = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
            piece.transform = CGAffineTransform(translationX: 0, y: -line * CGFloat(eased))
        }
    }
}
