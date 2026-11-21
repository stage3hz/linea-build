import UIKit

/// One emoji that moves (the reference's platina/AnimatedEmoji.tsx). On iPhone the reference shows the original
/// Apple glyph everywhere — its bundled Lottie files are Google's Noto drawings and are played on Android only
/// (`NATIVE_GLYPHS = Platform.OS === 'ios'`) — and gives the glyph a light motion of its own (`NativeEmoji`): it
/// pops in from 0.6 with a spring (Animated.spring speed 14, bounciness 14) and then, while `loop`, breathes
/// 1 → 1.08 → 1 (900 ms each way, quadratic ease in-out) for ever. `once` stops after the pop; `still` (pickers,
/// grids) is drawn at its final size from the first frame. The glyph is `size × 0.86` points in a `size` box.
///
/// Used by the emoji status (StatusEmojiView `animated`), the big emoji of a message (MsgRowCell) and the status
/// picker. `feature`: the «Энергосбережение и анимации» switch that may stop it ("emoji" for statuses,
/// "stickers" for big emoji, Effects/Motion.swift) — without animations or with it off the glyph stands still.
final class AnimatedEmojiView: UIView {
    enum Mode { case loop, once, still }

    private let glyph = UILabel()
    private(set) var emoji = ""
    private var size: CGFloat = 32
    private var mode = Mode.loop
    private var feature = "emoji"
    /// A tap plays it again (the reference's `tapToReplay`).
    var tapToReplay = false {
        didSet { isUserInteractionEnabled = tapToReplay }
    }

    /// The reference's spring, through React Native's `fromBouncinessAndSpeed(14, 14)`: tension 82.65 and friction
    /// 5.73 in Origami units, i.e. stiffness 384.6 and damping 18.2 with mass 1.
    static let popStiffness: CGFloat = 384.6
    static let popDamping: CGFloat = 18.2

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        glyph.textAlignment = .center
        glyph.adjustsFontSizeToFitWidth = false
        addSubview(glyph)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        NotificationCenter.default.addObserver(self, selector: #selector(motionChanged), name: Motion.changed, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    func show(_ emoji: String, size: CGFloat, mode: Mode = .loop, feature: String = "emoji") {
        let same = emoji == self.emoji && size == self.size && mode == self.mode
        self.emoji = emoji
        self.size = size
        self.mode = mode
        self.feature = feature
        glyph.text = emoji
        glyph.font = .systemFont(ofSize: size * 0.86)
        accessibilityLabel = emoji
        invalidateIntrinsicContentSize()
        setNeedsLayout()
        if !same { play() }
    }

    /// May it move now: the app's animations and the switch of its kind.
    private var moving: Bool { return mode != .still && Motion.enabled && Motion.feature(feature) }

    /// Starts the motion from the beginning (the pop, then the breath while `loop`).
    func play() {
        glyph.layer.removeAllAnimations()
        glyph.layer.transform = CATransform3DIdentity
        guard moving, window != nil else { return }
        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.mass = 1
        pop.stiffness = AnimatedEmojiView.popStiffness
        pop.damping = AnimatedEmojiView.popDamping
        pop.initialVelocity = 0
        pop.fromValue = 0.6
        pop.toValue = 1
        pop.duration = pop.settlingDuration
        glyph.layer.add(pop, forKey: "pop")
        guard mode == .loop else { return }
        let quad = CAMediaTimingFunction(controlPoints: 0.455, 0.03, 0.515, 0.955) // Easing.inOut(Easing.quad)
        let breathe = CABasicAnimation(keyPath: "transform.scale")
        breathe.fromValue = 1
        breathe.toValue = 1.08
        breathe.duration = 0.9
        breathe.timingFunction = quad
        breathe.autoreverses = true
        breathe.repeatCount = .infinity
        breathe.beginTime = CACurrentMediaTime() + pop.settlingDuration
        breathe.isRemovedOnCompletion = false
        glyph.layer.add(breathe, forKey: "breathe")
    }

    @objc private func tapped() { if tapToReplay { play() } }

    @objc private func motionChanged() {
        if !moving { glyph.layer.removeAllAnimations() } else if mode == .loop && glyph.layer.animation(forKey: "breathe") == nil { play() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Core Animation drops animations off screen; a looping one comes back with the view, a `once` pops again
        // as the reference's component does when it mounts.
        if window != nil { play() }
    }

    override var intrinsicContentSize: CGSize { return CGSize(width: size, height: size) }

    override func sizeThatFits(_ size: CGSize) -> CGSize { return intrinsicContentSize }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The label as tall as the box (lineHeight = size), centred; the scale turns around its middle.
        glyph.bounds = CGRect(x: 0, y: 0, width: max(bounds.width, size * 1.2), height: max(bounds.height, size))
        glyph.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
}
