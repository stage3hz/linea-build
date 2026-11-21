import UIKit

/// The record button of the composer and the strip that replaces the field while a voice take runs.
///
/// Reference: mobile/src/voice/RecordButton.tsx, mobile/src/videonote/recordGesture.ts (the rules, kept to the
/// number) and `VoiceRecordingBar` of mobile/src/voice/VoiceMessage.tsx. A tap switches microphone ↔ round video;
/// holding for 0.19 s records; while holding, sliding 150 pt left cancels and 110 pt up locks (hands free); on
/// release a slide of 100 pt left (or a fast flick) cancels, 60 pt up (or a flick) locks, anything else sends.
/// Locked: «Отмена», pause and the send button are on the strip.
final class RecordControl: NSObject {
    enum Mode { case voice, video }
    enum Phase { case idle, holding, locked }

    static let holdSeconds = 0.19
    private static let cancelDistance: CGFloat = 150
    private static let lockDistance: CGFloat = 110
    private static let cancelOnRelease: CGFloat = 100
    private static let lockOnRelease: CGFloat = 60
    private static let flick: CGFloat = 400
    private static let hintKey = "invizent.hint.voice-lock.v1"

    private(set) var mode = Mode.voice
    private(set) var phase = Phase.idle
    let button = UIView()
    private let icon = UIImageView()
    private let bar = UIView()
    private let dot = UIView()
    private let timeLabel = UILabel()
    private let slideLabel = UILabel()
    private let cancelButton = UIButton(type: .system)
    private let pauseButton = UIButton(type: .system)
    private let lockPill = UIView()
    private let lockHint = UILabel()
    private var startPoint = CGPoint.zero
    private var lastPoint = CGPoint.zero
    private var lastTime = 0.0
    private var velocity = CGPoint.zero
    private var clock: Timer?
    private var blink = false
    private var paused = false
    private var hold: UILongPressGestureRecognizer?

    /// A tap: the mode was switched (the owner shows the hint in the field).
    var onModeChanged: ((Mode) -> Void)?
    /// The finger is down long enough in the microphone mode: the take must start. False: it did not.
    var onHoldStart: (() -> Bool)?
    /// The same in the video mode: the round video recorder opens.
    var onVideo: (() -> Void)?
    /// The take ends: true to send it, false to call it off.
    var onFinish: ((Bool) -> Void)?
    var onPause: (() -> Void)?
    /// The length of the take by now, for the strip's clock («0:04,63»).
    var timeWords: (() -> String)?

    func install(composer: UIView, host: UIView) {
        bar.backgroundColor = Theme.bg
        bar.isHidden = true
        composer.addSubview(bar)
        dot.backgroundColor = Theme.danger
        dot.layer.cornerRadius = 5
        bar.addSubview(dot)
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 17, weight: .regular)
        timeLabel.textColor = Theme.text
        bar.addSubview(timeLabel)
        slideLabel.text = "‹ Влево — отмена"
        slideLabel.font = .systemFont(ofSize: 15)
        slideLabel.textColor = Theme.text
        slideLabel.textAlignment = .center
        bar.addSubview(slideLabel)
        cancelButton.setTitle("Отмена", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 17)
        cancelButton.tintColor = Theme.text
        cancelButton.accessibilityLabel = "Отменить запись"
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        bar.addSubview(cancelButton)
        pauseButton.tintColor = Theme.text
        pauseButton.addTarget(self, action: #selector(pauseTapped), for: .touchUpInside)
        bar.addSubview(pauseButton)

        button.layer.cornerRadius = 20
        button.isAccessibilityElement = true
        button.accessibilityTraits = .button
        icon.contentMode = .center
        button.addSubview(icon)
        composer.addSubview(button)
        let press = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        press.minimumPressDuration = RecordControl.holdSeconds
        press.allowableMovement = 12
        button.addGestureRecognizer(press)
        hold = press
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        button.addGestureRecognizer(tap)

        lockPill.backgroundColor = Theme.surface2
        lockPill.layer.cornerRadius = 20
        lockPill.layer.borderWidth = 1
        lockPill.layer.borderColor = UIColor(white: 1, alpha: 0.12).cgColor
        lockPill.isHidden = true
        lockPill.isUserInteractionEnabled = false
        let lock = UIImageView(image: UIImage(systemName: "lock.open", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .regular)))
        lock.tintColor = Theme.text
        lock.contentMode = .center
        lock.frame = CGRect(x: 0, y: 8, width: 40, height: 24)
        lockPill.addSubview(lock)
        let chevron = UIImageView(image: UIImage(systemName: "chevron.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .regular)))
        chevron.tintColor = Theme.muted
        chevron.contentMode = .center
        chevron.frame = CGRect(x: 0, y: 36, width: 40, height: 20)
        lockPill.addSubview(chevron)
        host.addSubview(lockPill)
        lockHint.text = "Вверх — без рук"
        lockHint.font = .systemFont(ofSize: 12.5)
        lockHint.textColor = Theme.text
        lockHint.textAlignment = .center
        lockHint.backgroundColor = Theme.surface2
        lockHint.layer.cornerRadius = 12
        lockHint.layer.masksToBounds = true
        lockHint.isHidden = true
        host.addSubview(lockHint)
        show()
    }

    /// Places the button where the send button stands, the strip over the whole composer, the lock above it.
    func place(composerBounds: CGRect, composerFrame: CGRect) {
        let width = composerBounds.width, height = composerBounds.height
        bar.frame = composerBounds
        if phase != .holding { button.transform = .identity }
        let saved = button.transform
        button.transform = .identity
        button.frame = CGRect(x: width - 44, y: height - 44, width: 40, height: 40)
        icon.frame = button.bounds
        button.transform = saved
        let middle = height - 24
        dot.frame = CGRect(x: 16, y: middle - 5, width: 10, height: 10)
        timeLabel.frame = CGRect(x: 34, y: middle - 12, width: 92, height: 24)
        let rightEdge = phase == .locked ? width - 96 : width - 56
        slideLabel.frame = CGRect(x: 126, y: middle - 12, width: max(0, rightEdge - 126), height: 24)
        cancelButton.frame = CGRect(x: 126, y: middle - 22, width: max(0, rightEdge - 126), height: 44)
        pauseButton.frame = CGRect(x: width - 92, y: middle - 20, width: 40, height: 40)
        lockPill.frame = CGRect(x: composerFrame.maxX - 44, y: composerFrame.minY - 76, width: 40, height: 66)
        lockHint.frame = CGRect(x: lockPill.frame.minX - 140, y: lockPill.frame.minY + 18, width: 132, height: 28)
    }

    /// Whether the button is on screen at all (the owner hides it while there is text to send).
    func setVisible(_ visible: Bool) {
        if phase != .idle { return }
        button.isHidden = !visible
    }

    var isBusy: Bool { phase != .idle }

    private func show() {
        let active = phase != .idle
        bar.isHidden = !active
        if active { button.isHidden = false }
        lockPill.isHidden = phase != .holding
        if phase != .holding { lockHint.isHidden = true }
        slideLabel.isHidden = phase != .holding
        cancelButton.isHidden = phase != .locked
        pauseButton.isHidden = phase != .locked
        let symbol: String
        if active { symbol = "arrow.up" } else { symbol = mode == .voice ? "mic" : "video" }
        icon.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: active ? 17 : 21, weight: active ? .bold : .regular))
        icon.tintColor = active ? Theme.onAccent : Theme.text
        button.backgroundColor = active ? Theme.accent : .clear
        pauseButton.setImage(UIImage(systemName: paused ? "mic.fill" : "pause.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular)), for: .normal)
        pauseButton.tintColor = paused ? Theme.danger : Theme.text
        pauseButton.accessibilityLabel = paused ? "Продолжить запись" : "Пауза"
        dot.backgroundColor = paused ? Theme.muted : Theme.danger
        if phase == .locked {
            button.accessibilityLabel = "Отправить голосовое сообщение"
        } else if mode == .voice {
            button.accessibilityLabel = "Голосовое: удерживай для записи, свайп влево — отмена, вверх — без рук. Нажми — переключить на видео"
        } else {
            button.accessibilityLabel = "Видеосообщение: удерживай для записи. Нажми — переключить на голосовое"
        }
        if active && clock == nil {
            let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in self?.ticked() }
            RunLoop.main.add(timer, forMode: .common)
            clock = timer
            ticked()
        } else if !active {
            clock?.invalidate()
            clock = nil
            dot.alpha = 1
            button.transform = .identity
            slideLabel.alpha = 0.85
            slideLabel.transform = .identity
        }
        bar.superview?.setNeedsLayout()
        if let composer = bar.superview { place(composerBounds: composer.bounds, composerFrame: lockPillAnchor(composer)) }
    }

    private func lockPillAnchor(_ composer: UIView) -> CGRect {
        guard let host = lockPill.superview else { return composer.frame }
        return composer.convert(composer.bounds, to: host)
    }

    private var ticks = 0

    private func ticked() {
        timeLabel.text = timeWords?() ?? "0:00,00"
        ticks += 1
        // The red dot blinks every 0.6 s while the take runs.
        if ticks % 12 == 0 { blink.toggle() }
        dot.alpha = paused || !blink ? 1 : 0.25
    }

    /// The loudness right now: the button breathes with the voice.
    func setLevel(_ level: CGFloat) {
        guard phase == .locked, !paused else { return }
        let scale = 1 + min(1, max(0, level)) * 0.18
        button.transform = CGAffineTransform(scaleX: scale, y: scale)
    }

    func setPaused(_ value: Bool) {
        paused = value
        show()
    }

    /// The take ended by itself (the limit, a failure): back to the resting button.
    func reset() {
        phase = .idle
        paused = false
        show()
    }

    private func end(send: Bool) {
        phase = .idle
        paused = false
        show()
        onFinish?(send)
    }

    private func lock() {
        phase = .locked
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        show()
    }

    @objc private func tapped() {
        if phase == .locked {
            end(send: true)
            return
        }
        guard phase == .idle else { return }
        mode = mode == .voice ? .video : .voice
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        show()
        onModeChanged?(mode)
    }

    @objc private func cancelTapped() {
        if phase == .locked { end(send: false) }
    }

    @objc private func pauseTapped() {
        if phase == .locked { onPause?() }
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        let point = recognizer.location(in: button.superview)
        switch recognizer.state {
        case .began:
            guard phase == .idle else { return }
            if mode == .video {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                onVideo?()
                return
            }
            guard onHoldStart?() ?? false else { return }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            startPoint = point
            lastPoint = point
            lastTime = CACurrentMediaTime()
            velocity = .zero
            phase = .holding
            let shown = UserDefaults.standard.integer(forKey: RecordControl.hintKey)
            // The lock is a gesture nobody guesses: the first few holds say it in words, beside the pill.
            lockHint.isHidden = shown >= 5
            if shown < 5 { UserDefaults.standard.set(shown + 1, forKey: RecordControl.hintKey) }
            show()
        case .changed:
            guard phase == .holding else { return }
            let now = CACurrentMediaTime()
            if now - lastTime > 0.001 {
                velocity = CGPoint(x: (point.x - lastPoint.x) / CGFloat(now - lastTime), y: (point.y - lastPoint.y) / CGFloat(now - lastTime))
            }
            lastPoint = point
            lastTime = now
            // One axis at a time: the larger movement (left or up) wins; right and down count as nothing.
            let left = min(0, point.x - startPoint.x), up = min(0, point.y - startPoint.y)
            let x = -left > -up ? left : 0
            let y = -left > -up ? 0 : up
            button.transform = CGAffineTransform(translationX: x * 0.9, y: 0)
            let progress = min(1, max(0, -x / RecordControl.cancelDistance))
            slideLabel.alpha = (1 - progress) * 0.85
            slideLabel.transform = CGAffineTransform(translationX: -progress * 40, y: 0)
            if -x >= RecordControl.cancelDistance {
                end(send: false)
            } else if -y >= RecordControl.lockDistance {
                lock()
            }
        case .ended:
            guard phase == .holding else { return }
            let left = -min(0, point.x - startPoint.x), up = -min(0, point.y - startPoint.y)
            if left >= RecordControl.cancelOnRelease || velocity.x < -RecordControl.flick {
                end(send: false)
            } else if up >= RecordControl.lockOnRelease || velocity.y < -RecordControl.flick {
                lock()
            } else {
                end(send: true)
            }
        case .cancelled, .failed:
            if phase == .holding { end(send: false) }
        default:
            break
        }
    }

    #if targetEnvironment(simulator)
    /// `-voicedemo recording`: the strip as it stands while the finger holds the button.
    func demoHolding() {
        phase = .holding
        lockHint.isHidden = false
        show()
    }
    #endif
}
