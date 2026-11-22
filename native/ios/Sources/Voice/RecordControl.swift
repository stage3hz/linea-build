import UIKit

/// The record button of the composer and everything a take shows (owner's spec, Sources/Voice/RecordParts.swift
/// holds the numbers): a tap switches microphone ↔ round video and says so in a tooltip; holding 0.19 s starts a
/// take. The blob swells around the button with the voice and follows the finger — left (shrinking, at 30% a frame)
/// towards cancelling, up (with the lock) towards hands-free; the field shows the blinking red dot, the time and
/// «Влево — отмена» swaying 6 pt. On release the larger movement decides: cancel, lock, or send. Locked: the blob is
/// the send button, the lock is the stop button (it opens the preview), «Отмена» calls the take off. The preview of
/// a stopped take sits in the field: play, trim, «record more» above the send button, the trash in the paperclip's
/// place.
final class RecordControl: NSObject {
    enum Mode { case voice, video }
    enum Phase { case idle, holding, locked, preview }
    enum Ending { case send, cancel, preview }

    private(set) var mode = Mode.voice
    private(set) var phase = Phase.idle
    let button = RecordMicButton()
    /// Composer: the old inset of the button (kept for callers; the host places the button itself).
    var edgeInset: CGFloat = 0
    /// The paperclip of the composer: hidden while a take or its preview stands there (the trash takes its place).
    weak var clipView: UIView?
    /// The paperclip slides away with the composer's layout while a take runs (a chat) instead of fading («Избранное»).
    var clipSlides = false
    /// The field's own content (text, emoji button): faded out while a take or its preview is shown.
    var fieldViews: [UIView] = []

    /// A tap switched the mode.
    var onModeChanged: ((Mode) -> Void)?
    /// The finger stayed 0.19 s: the take must start (voice: the microphone; video: the camera). False: it did not.
    var onHoldStart: ((Mode) -> Bool)?
    /// The take ended: sent, called off, or stopped for the preview.
    var onFinish: ((Ending) -> Void)?
    /// The phase changed: the composer lays itself out again (one of its 0.4 s transitions).
    var onPhase: ((Phase) -> Void)?
    /// The time of the take by now («0:04,63»).
    var timeWords: (() -> String)?
    /// The preview: send it, throw it away, record more after it, play / pause, seek, trim.
    var onPreviewSend: (() -> Void)?
    var onPreviewDelete: (() -> Void)?
    var onRecordMore: (() -> Void)?

    // In the composer
    private weak var composer: UIView?
    private weak var host: UIView?
    private let info = UIView()
    private let dot = UIView()
    private let timeLabel = UILabel()
    private let indicator = RecordCancelIndicator()
    let preview = VoicePreviewPanel()
    /// The preview of a stopped round video (its frames, trimmed by two handles).
    let videoPreview = VideoTrimPanel()
    private let trashButton = UIButton(type: .custom)
    private let sendFill = UIView()
    // Over everything
    private let overlay = RecordOverlayView()
    private let blob = RecordBlobView(frame: CGRect(x: 0, y: 0, width: RecordSpec.blobSide, height: RecordSpec.blobSide))
    private let lockWrapper = UIView(frame: CGRect(x: 0, y: 0, width: 40, height: 72))
    private let lockPanel = RecordLockPanel()
    private let recordMore = RecordMoreButton()
    private let tooltip = RecordTooltip()
    private let bin = UIImageView()

    private var buttonRect = CGRect.zero
    private var fieldRect = CGRect.zero
    private var trashRect = CGRect.zero
    private var visible = true
    private var holdTimer: Timer?
    private var holdFailed = false
    private var lastTouch = 0.0
    private var displayLink: CADisplayLink?
    private var scale: CGFloat = 1
    private var translation: CGFloat = 0
    private var targetTranslation: CGFloat = 0
    private var cancelShift: CGFloat = 0
    private var cancelTarget: CGFloat = 0
    private var clock: Timer?
    private var lockAnimating = false
    private var previewIsVideo = false
    private var flying = false
    private var flightPending = false
    /// Asked right after a voice take was sent: where the sent message's play button is, in the host's
    /// coordinates (nil: nowhere to fly, the blob shrinks into the button instead).
    var sentTarget: (() -> CGRect?)?

    // MARK: Installing and placing

    func install(composer: UIView, host: UIView) {
        self.composer = composer
        self.host = host
        info.isHidden = true
        composer.addSubview(info)
        dot.backgroundColor = RecordSpec.dotColor
        dot.layer.cornerRadius = 5
        dot.bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
        info.addSubview(dot)
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 15, weight: .regular)
        timeLabel.textColor = Theme.text
        info.addSubview(timeLabel)
        info.addSubview(indicator)
        indicator.cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        preview.isHidden = true
        composer.addSubview(preview)
        videoPreview.isHidden = true
        composer.addSubview(videoPreview)
        videoPreview.onToggle = { [weak self] in self?.previewToggle?() }
        videoPreview.onTrim = { [weak self] (start: Double, end: Double, done: Bool) -> Void in self?.previewTrim?(start, end, done) }
        trashButton.setImage(IonIcon.image("trash-outline", size: 22).withRenderingMode(.alwaysTemplate), for: .normal)
        trashButton.tintColor = RecordSpec.controlColor
        trashButton.accessibilityLabel = "Удалить запись"
        trashButton.isHidden = true
        trashButton.addTarget(self, action: #selector(trashTapped), for: .touchUpInside)
        composer.addSubview(trashButton)

        sendFill.isUserInteractionEnabled = false
        sendFill.backgroundColor = Theme.accent
        sendFill.alpha = 0
        button.insertSubview(sendFill, at: 0)
        sendFill.layer.zPosition = -1 // the glyph's view stays above the fill, in whatever order it is made
        button.isAccessibilityElement = true
        button.accessibilityTraits = .button
        composer.addSubview(button)
        button.onDown = { [weak self] () -> Bool in self?.touchDown() ?? false }
        button.onMove = { [weak self] (offset: CGPoint, velocity: CGPoint) -> Bool in self?.touchMoved(offset, velocity: velocity) ?? false }
        button.onUp = { [weak self] (offset: CGPoint, velocity: CGPoint) -> Void in self?.touchUp(offset, velocity: velocity) }
        button.onCancel = { [weak self] in self?.touchCancelled() }

        overlay.frame = host.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(overlay)
        lockWrapper.addSubview(lockPanel)
        lockWrapper.alpha = 0
        lockWrapper.isHidden = true
        overlay.addSubview(lockWrapper)
        lockPanel.onStop = { [weak self] in self?.stopTapped() }
        blob.alpha = 0
        blob.isHidden = true
        blob.isAccessibilityElement = true
        blob.accessibilityTraits = .button
        blob.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(blobTapped)))
        overlay.addSubview(blob)
        recordMore.isHidden = true
        recordMore.addTarget(self, action: #selector(recordMoreTapped), for: .touchUpInside)
        overlay.addSubview(recordMore)
        bin.contentMode = .center
        bin.isHidden = true
        overlay.addSubview(bin)
        overlay.touchables = [blob, lockPanel, recordMore]

        preview.onToggle = { [weak self] in self?.previewToggle?() }
        preview.onSeek = { [weak self] (fraction: Double) -> Void in self?.previewSeek?(fraction) }
        preview.onTrim = { [weak self] (start: Double, end: Double, done: Bool) -> Void in self?.previewTrim?(start, end, done) }
        showIdleIcon(animated: false)
    }

    /// The preview's own controls, set by the owner of the draft.
    var previewToggle: (() -> Void)?
    var previewSeek: ((Double) -> Void)?
    var previewTrim: ((Double, Double, Bool) -> Void)?

    /// `buttonFrame`: the record button; `field`: the field's pill while a take runs (the dot, the time and the
    /// cancel line go there, and the preview); `trash`: the paperclip's place. All in the composer's coordinates.
    func place(button buttonFrame: CGRect, field: CGRect, trash: CGRect) {
        buttonRect = buttonFrame
        fieldRect = field
        trashRect = trash
        button.bounds = CGRect(origin: .zero, size: buttonFrame.size)
        button.center = CGPoint(x: buttonFrame.midX, y: buttonFrame.midY)
        sendFill.frame = button.bounds
        sendFill.layer.cornerRadius = buttonFrame.height / 2
        info.frame = composer?.bounds ?? .zero
        preview.frame = CGRect(x: field.minX, y: field.maxY - 40, width: field.width, height: 40)
        videoPreview.frame = preview.frame
        trashButton.frame = trash
        placeInfo()
        placeOverlay()
    }

    private func placeInfo() {
        let middle = fieldRect.maxY - 20
        if dot.layer.animation(forKey: "move") == nil {
            dot.center = CGPoint(x: fieldRect.minX + 16 + 5, y: middle)
        }
        let timeSize = timeLabel.sizeThatFits(CGSize(width: 200, height: 100))
        timeLabel.bounds = CGRect(x: 0, y: 0, width: max(92, ceil(timeSize.width)), height: ceil(timeSize.height))
        timeLabel.center = CGPoint(x: fieldRect.minX + 34 + timeLabel.bounds.width / 2, y: middle + 1)
        placeIndicator()
    }

    /// Centred in the screen's width less 16 pt, moved left by half of the finger's slide past 8 pt; it fades over
    /// its last 10 pt before 100 pt from the screen's left edge.
    private func placeIndicator() {
        guard let composer, let host else { return }
        let slide = max(0, -cancelTarget - 8)
        let width = indicator.bounds.width
        let hostX = floor((host.bounds.width - 16 - width - slide) / 2)
        let x = composer.convert(CGPoint(x: hostX, y: 0), from: host).x
        indicator.center = CGPoint(x: x + width / 2, y: fieldRect.maxY - 20)
        if -cancelTarget > 8 && phase == .holding {
            indicator.alpha = max(0, min(1, (hostX - 100) / 10))
        } else if phase != .idle {
            indicator.alpha = 1
        }
    }

    private func placeOverlay() {
        guard let composer, let host else { return }
        overlay.frame = host.bounds
        host.bringSubviewToFront(overlay)
        let center = composer.convert(CGPoint(x: buttonRect.midX, y: buttonRect.midY), to: host)
        let blobCenter = CGPoint(x: center.x, y: center.y - 1 + 1 / UIScreen.main.scale)
        // The centre is not touched by the transforms (they scale and move around it).
        if !flying { blob.center = blobCenter }
        lockWrapper.center = CGPoint(x: blobCenter.x, y: blobCenter.y - RecordSpec.lockLift)
        recordMore.center = CGPoint(x: center.x, y: center.y - buttonRect.height / 2 - 16 - 20)
        if !bin.isHidden {
            bin.center = composer.convert(CGPoint(x: trashRect.midX, y: trashRect.midY), to: host)
        }
    }

    /// Whether the button is on screen at all (the owner hides it while there is text to send).
    func setVisible(_ value: Bool) {
        visible = value
        if phase != .idle { return }
        button.isHidden = !value
    }

    var isBusy: Bool { phase != .idle }

    // MARK: The button's look

    private func idleIcon() -> UIImage {
        IonIcon.image(mode == .voice ? "mic-outline" : "videocam-outline", size: 24).withRenderingMode(.alwaysTemplate)
    }

    private func showIdleIcon(animated: Bool) {
        let image = idleIcon()
        button.iconView.tintColor = Theme.text
        if mode == .voice {
            button.accessibilityLabel = "Голосовое: удерживайте для записи, влево — отмена, вверх — без рук. Нажмите — видео"
        } else {
            button.accessibilityLabel = "Видеосообщение: удерживайте для записи. Нажмите — голосовое"
        }
        guard animated, let old = button.iconView.image else {
            button.iconView.image = image
            return
        }
        // The icon turns into the other one in 0.25 s.
        let ghost = UIImageView(image: old)
        ghost.tintColor = Theme.text
        ghost.contentMode = .center
        ghost.frame = button.bounds
        button.addSubview(ghost)
        button.iconView.image = image
        button.iconView.alpha = 0
        button.iconView.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseInOut], animations: { () -> Void in
            ghost.alpha = 0
            ghost.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
            self.button.iconView.alpha = 1
            self.button.iconView.transform = .identity
        }, completion: { (_: Bool) -> Void in
            ghost.removeFromSuperview()
        })
    }

    private func blobIcon(locked: Bool) -> UIImage {
        if locked { return IonIcon.image("arrow-up", size: 26).withRenderingMode(.alwaysTemplate) }
        return IonIcon.image(mode == .voice ? "mic" : "videocam", size: 28).withRenderingMode(.alwaysTemplate)
    }

    private func showSendLook(_ on: Bool) {
        if on {
            button.iconView.image = IonIcon.image("arrow-up", size: 22).withRenderingMode(.alwaysTemplate)
            button.iconView.tintColor = Theme.onAccent
            sendFill.backgroundColor = Theme.accent
            button.accessibilityLabel = previewIsVideo ? "Отправить видеосообщение" : "Отправить голосовое сообщение"
        } else {
            button.iconView.tintColor = Theme.text
            button.iconView.image = idleIcon()
        }
    }

    // MARK: Touches

    private func touchDown() -> Bool {
        switch phase {
        case .locked:
            finish(.send)
            return false
        case .preview:
            onPreviewSend?()
            return false
        case .holding:
            return false
        case .idle:
            break
        }
        let now = CACurrentMediaTime()
        if abs(now - lastTouch) < RecordSpec.touchDebounce { return false }
        lastTouch = now
        holdFailed = false
        tooltip.dismiss()
        holdTimer?.invalidate()
        let timer = Timer(timeInterval: RecordSpec.holdSeconds, repeats: false) { [weak self] _ in self?.holdReached() }
        RunLoop.main.add(timer, forMode: .common)
        holdTimer = timer
        return true
    }

    private func holdReached() {
        holdTimer = nil
        guard phase == .idle else { return }
        guard onHoldStart?(mode) ?? false else {
            holdFailed = true
            return
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        begin(locked: false)
    }

    private func touchMoved(_ offset: CGPoint, velocity: CGPoint) -> Bool {
        if holdTimer != nil {
            if offset.x < -RecordSpec.cancelDistance {
                holdTimer?.invalidate()
                holdTimer = nil
                holdFailed = true
                return false
            }
            return true
        }
        guard phase == .holding else { return !holdFailed && phase == .idle }
        let progressX = max(0, min(1, -offset.x / RecordSpec.shrinkDistance))
        scale = max(RecordSpec.minScale, min(1, 1 - progressX))
        targetTranslation = offset.y
        cancelTarget = offset.x
        let lockness = min(1, abs(targetTranslation) / RecordSpec.lockRange)
        if !lockAnimating { lockPanel.update(lockness: lockness) }
        placeIndicator()
        if offset.x < -RecordSpec.cancelDistance {
            targetTranslation = 0
            finish(.cancel)
            return false
        }
        if offset.y < -RecordSpec.lockDistance {
            lock()
            return false
        }
        return true
    }

    private func touchUp(_ offset: CGPoint, velocity: CGPoint) {
        if let timer = holdTimer {
            // A tap: the other mode.
            timer.invalidate()
            holdTimer = nil
            switchMode()
            return
        }
        guard phase == .holding else { return }
        targetTranslation = 0
        var dx = offset.x, dy = offset.y
        if abs(dx) > abs(dy) { dy = 0 } else { dx = 0 }
        if velocity.x < -RecordSpec.flick || dx < -RecordSpec.cancelOnRelease {
            finish(.cancel)
        } else if velocity.y < -RecordSpec.flick || dy < -RecordSpec.lockOnRelease {
            lock()
        } else {
            finish(.send)
        }
    }

    /// The system took the touch away (a call, the control centre): the take locks a second later.
    private func touchCancelled() {
        if holdTimer != nil {
            holdTimer?.invalidate()
            holdTimer = nil
            return
        }
        guard phase == .holding else { return }
        translation = 0
        targetTranslation = 0
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.phase == .holding else { return }
            self.lock()
        }
    }

    private func switchMode() {
        // A medium knock, as the owner's spec has it.
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        mode = mode == .voice ? .video : .voice
        showIdleIcon(animated: true)
        onModeChanged?(mode)
        guard let composer, let host else { return }
        let anchor = composer.convert(buttonRect, to: host)
        tooltip.show(mode == .voice
            ? "Удерживайте, чтобы записать голосовое. Нажмите, чтобы переключиться на видео."
            : "Удерживайте, чтобы записать видео. Нажмите, чтобы переключиться на голосовое.", anchor: anchor, in: host)
    }

    // MARK: A take

    /// Shows a take that started (`locked`: going on hands-free, as after «record more»).
    private func begin(locked: Bool) {
        phase = .holding
        scale = 1
        translation = 0
        targetTranslation = 0
        cancelShift = 0
        cancelTarget = 0
        lockPanel.reset()
        placeOverlay()
        blob.setColor(Theme.accent)
        blob.iconView.image = blobIcon(locked: false)
        blob.iconView.tintColor = Theme.onAccent // on the accent: «Чёрная»'s accent is nearly white
        blob.iconView.transform = .identity
        blob.layer.removeAllAnimations()
        flying = false
        flightPending = false
        placeOverlay()
        blob.isHidden = false
        blob.transform = CGAffineTransform(scaleX: 0.2, y: 0.2)
        blob.alpha = 0.2
        lockWrapper.isHidden = false
        lockWrapper.transform = CGAffineTransform(translationX: 0, y: locked ? 36 : 100)
        lockWrapper.alpha = 0
        lockAnimating = true
        UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0, options: [.beginFromCurrentState], animations: { () -> Void in
            self.blob.transform = .identity
            self.lockWrapper.transform = .identity
        }, completion: { (_: Bool) -> Void in
            self.lockAnimating = false
        })
        UIView.animate(withDuration: 0.1) {
            self.blob.alpha = 1
            self.lockWrapper.alpha = 1
        }
        blob.start()
        // The composer's icon goes small and away in 0.15 s.
        UIView.animate(withDuration: 0.15, delay: 0, options: [.curveEaseInOut], animations: { () -> Void in
            self.button.iconView.alpha = 0
            self.button.iconView.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
        }, completion: nil)
        showInfo()
        startLoop()
        changedPhase()
        if locked { lock() }
    }

    private func showInfo() {
        info.isHidden = false
        timeLabel.text = timeWords?() ?? "0:00,00"
        indicator.recolor()
        indicator.showCancel(false, animated: false)
        indicator.alpha = 1
        timeLabel.textColor = Theme.text
        timeLabel.alpha = 1
        timeLabel.transform = .identity
        placeInfo()
        // The dot grows from 0.3 in 0.15 s, then blinks: on for 0.45 of the half second, off by 0.91, back and forth.
        dot.layer.removeAllAnimations()
        dot.alpha = 1
        dot.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
        dot.alpha = 0
        UIView.animate(withDuration: 0.15, animations: { () -> Void in
            self.dot.transform = .identity
            self.dot.alpha = 1
        }, completion: { [weak self] (finished: Bool) -> Void in
            guard finished, let self, self.phase == .holding || self.phase == .locked else { return }
            let blink = CAKeyframeAnimation(keyPath: "opacity")
            blink.values = [1, 1, 0, 0]
            blink.keyTimes = [0, 0.4546, 0.9091, 1]
            blink.duration = 0.5
            blink.autoreverses = true
            blink.repeatCount = .infinity
            self.dot.layer.add(blink, forKey: "recording")
        })
        // The time fades in over 0.5 s; the dot and the time travel with the field's pill (the host's transition).
        timeLabel.alpha = 0
        let timeAnimator = UIViewPropertyAnimator(duration: 0.5, timingParameters: RecordSpec.layoutTiming())
        timeAnimator.addAnimations { () -> Void in self.timeLabel.alpha = 1 }
        timeAnimator.startAnimation()
        // «Slide to cancel» comes in from the right in 0.4 s and then sways 6 pt each second.
        indicator.layer.removeAllAnimations()
        let slideIn = CABasicAnimation(keyPath: "position.x")
        let width = host?.bounds.width ?? 400
        slideIn.fromValue = indicator.layer.position.x + width
        slideIn.toValue = indicator.layer.position.x
        slideIn.duration = 0.4
        slideIn.timingFunction = RecordSpec.layoutCurve()
        indicator.layer.add(slideIn, forKey: "slideIn")
        startSway()
        clock?.invalidate()
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.timeLabel.text = self.timeWords?() ?? "0:00,00"
        }
        RunLoop.main.add(timer, forMode: .common)
        clock = timer
    }

    private func startSway() {
        guard (host?.bounds.width ?? 0) > 320, indicator.layer.animation(forKey: "sway") == nil else { return }
        let sway = CABasicAnimation(keyPath: "transform")
        sway.toValue = CATransform3DMakeTranslation(6, 0, 0)
        sway.duration = 1
        sway.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        sway.autoreverses = true
        sway.repeatCount = .infinity
        indicator.layer.add(sway, forKey: "sway")
    }

    private func stopSway() {
        guard indicator.layer.animation(forKey: "sway") != nil else { return }
        let shift = indicator.layer.presentation()?.transform.m41 ?? 0
        indicator.layer.removeAnimation(forKey: "sway")
        if shift != 0 {
            let back = CABasicAnimation(keyPath: "position.x")
            back.fromValue = indicator.layer.position.x + shift
            back.toValue = indicator.layer.position.x
            back.duration = 0.3
            indicator.layer.add(back, forKey: "swayBack")
        }
    }

    private func lock() {
        guard phase == .holding else { return }
        phase = .locked
        scale = 1
        targetTranslation = 0
        cancelTarget = 0
        lockAnimating = true
        lockPanel.lock()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.lockAnimating = false }
        // The blob's icon becomes the send arrow: the old one shrinks away (0.3 s), the arrow grows from 0.3.
        if let old = blob.iconView.image {
            let ghost = UIImageView(image: old)
            ghost.tintColor = Theme.onAccent
            ghost.contentMode = .center
            ghost.frame = blob.bounds
            blob.insertSubview(ghost, belowSubview: blob.iconView)
            UIView.animate(withDuration: 0.3, delay: 0, options: [UIView.AnimationOptions(rawValue: 7 << 16)], animations: { () -> Void in
                ghost.transform = CGAffineTransform(scaleX: 0.001, y: 0.001)
            }, completion: { (_: Bool) -> Void in ghost.removeFromSuperview() })
            UIView.animate(withDuration: 0.2) { ghost.alpha = 0 }
        }
        blob.iconView.image = blobIcon(locked: true)
        blob.iconView.alpha = 0
        blob.iconView.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
        UIView.animate(withDuration: 0.3, delay: 0, options: [UIView.AnimationOptions(rawValue: 7 << 16)], animations: { () -> Void in
            self.blob.iconView.transform = .identity
        }, completion: nil)
        UIView.animate(withDuration: 0.2) { self.blob.iconView.alpha = 1 }
        blob.accessibilityLabel = mode == .voice ? "Отправить голосовое сообщение" : "Отправить видеосообщение"
        stopSway()
        indicator.showCancel(true, animated: true)
        placeIndicator()
        changedPhase()
    }

    @objc private func blobTapped() {
        if phase == .locked { finish(.send) }
    }

    @objc private func stopTapped() {
        if phase == .locked { finish(.preview) }
    }

    @objc private func cancelTapped() {
        if phase == .locked { finish(.cancel) }
    }

    /// The take ends. The host is told first (it stops the recorder), then everything of the take goes.
    private func finish(_ ending: Ending) {
        guard phase == .holding || phase == .locked else { return }
        holdTimer?.invalidate()
        holdTimer = nil
        phase = .idle
        hideTake(ending)
        onFinish?(ending)
        if phase == .idle { changedPhase() }
    }

    /// The host ends the take (the longest take was reached): as if the person had done it.
    func end(_ ending: Ending) {
        finish(ending)
    }

    /// Called by the host when a take ended by itself (the limit, a failure): back to rest without a word.
    func reset() {
        holdTimer?.invalidate()
        holdTimer = nil
        if phase == .holding || phase == .locked {
            phase = .idle
            hideTake(.send)
            clipView?.alpha = 1
        } else if phase == .preview {
            phase = .idle
            hidePreview(deleted: false)
        }
        changedPhase()
    }

    private func hideTake(_ ending: Ending) {
        stopLoop()
        clock?.invalidate()
        clock = nil
        blob.stop()
        lockAnimating = true
        let sent = ending == .send
        UIView.animate(withDuration: 0.18, animations: { () -> Void in
            if !sent {
                self.blob.transform = CGAffineTransform(scaleX: 0.2, y: 0.2)
                self.blob.alpha = 0
            }
            self.lockWrapper.transform = CGAffineTransform(translationX: 0, y: 100).scaledBy(x: 0.2, y: 0.2)
            self.lockWrapper.alpha = 0
        }, completion: { (_: Bool) -> Void in
            self.lockAnimating = false
            guard self.phase == .idle || self.phase == .preview else { return }
            if !self.flying && !self.flightPending { self.blob.isHidden = true }
            self.lockWrapper.isHidden = true
            self.lockPanel.reset()
        })
        if sent {
            // Sent: once the host has put the message in the list, the blob flies to its play button; with no
            // such button it shrinks into the composer's button.
            flightPending = true
            DispatchQueue.main.async { [weak self] in
                guard let self, self.flightPending else { return }
                self.flightPending = false
                if let target = self.sentTarget?(), target.width > 0 { self.fly(to: target) } else { self.shrinkSent() }
            }
        }
        // The composer's icon comes back in 0.15 s.
        if ending != .preview {
            UIView.animate(withDuration: 0.15, delay: 0, options: [.curveEaseInOut], animations: { () -> Void in
                self.button.iconView.alpha = 1
                self.button.iconView.transform = .identity
            }, completion: nil)
        }
        // The dot: thrown into the trash when called off, otherwise it shrinks away with the time.
        dot.layer.removeAnimation(forKey: "recording")
        if ending == .cancel {
            throwDotAway()
        } else {
            UIView.animate(withDuration: 0.15, animations: { () -> Void in
                self.dot.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
                self.dot.alpha = 0
            })
        }
        if ending == .send, let clip = clipView {
            UIView.animate(withDuration: 0.2) { clip.alpha = 1 }
        }
        RecordSpec.animateLayout { () -> Void in
            self.timeLabel.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
            self.timeLabel.alpha = 0
        }
        stopSway()
        UIView.animate(withDuration: 0.25, animations: { () -> Void in
            self.indicator.alpha = 0
        }, completion: { (_: Bool) -> Void in
            if self.phase == .idle || self.phase == .preview {
                self.info.isHidden = true
                self.indicator.showCancel(false, animated: false)
            }
        })
    }

    /// The sent take with no message to fly to: the blob shrinks to a third and vanishes at the end (0.18 s).
    private func shrinkSent() {
        UIView.animate(withDuration: 0.18, animations: { () -> Void in
            self.blob.transform = CGAffineTransform(scaleX: 0.33, y: 0.33).concatenating(CGAffineTransform(translationX: 0, y: 2 - 1 / UIScreen.main.scale))
        }, completion: { (_: Bool) -> Void in
            if self.phase == .idle || self.phase == .preview { self.blob.isHidden = true }
        })
        UIView.animate(withDuration: 0.03, delay: 0.15, options: [], animations: { () -> Void in self.blob.alpha = 0 }, completion: nil)
    }

    /// The sent voice message's play button is at `target` (the host's coordinates): the blob flies there in 0.3 s
    /// — across on the (0.23, 1, 0.32, 1) curve, down/up on (0.199, 0.011, 0.279, 0.910) — shrinking so that its
    /// centre circle lands on the button, and fades out in its first 0.06 s while the message takes over.
    private func fly(to target: CGRect) {
        flying = true
        let current = blob.transform
        let from = CGPoint(x: blob.center.x + current.tx, y: blob.center.y + current.ty)
        let fromScale = sqrt(current.a * current.a + current.c * current.c)
        let to = CGPoint(x: target.midX, y: target.midY)
        let toScale = target.width / (RecordSpec.blobSide * 0.45)
        blob.layer.removeAllAnimations()
        blob.center = to
        blob.transform = CGAffineTransform(scaleX: toScale, y: toScale)
        let duration = 0.3
        let across = CABasicAnimation(keyPath: "position.x")
        across.fromValue = from.x - to.x
        across.toValue = 0
        across.isAdditive = true
        across.duration = duration
        across.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
        blob.layer.add(across, forKey: "flyX")
        let down = CABasicAnimation(keyPath: "position.y")
        down.fromValue = from.y - to.y
        down.toValue = 0
        down.isAdditive = true
        down.duration = duration
        down.timingFunction = CAMediaTimingFunction(controlPoints: 0.199, 0.0106, 0.279, 0.910)
        blob.layer.add(down, forKey: "flyY")
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = fromScale
        grow.toValue = toScale
        grow.duration = duration
        grow.timingFunction = CAMediaTimingFunction(controlPoints: 0.199, 0.0106, 0.279, 0.910)
        blob.layer.add(grow, forKey: "flyScale")
        blob.alpha = 1
        UIView.animate(withDuration: 0.06) { self.blob.alpha = 0 }
        DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in
            guard let self else { return }
            self.flying = false
            if self.phase == .idle || self.phase == .preview {
                self.blob.isHidden = true
                self.blob.transform = .identity
                self.placeOverlay()
            }
        }
    }

    /// Called off: the red dot jumps into a red trash in the paperclip's place, the trash's lid bounces, then the
    /// trash goes small and the paperclip grows back (1.34 s, then 0.2 s).
    private func throwDotAway() {
        guard let composer, let host else { return }
        let start = composer.convert(dot.center, to: host)
        let target = composer.convert(CGPoint(x: trashRect.midX, y: trashRect.midY), to: host)
        let flyer = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
        flyer.backgroundColor = RecordSpec.dotColor
        flyer.layer.cornerRadius = 5
        flyer.center = start
        overlay.addSubview(flyer)
        dot.alpha = 0
        clipView?.alpha = 0
        RecordSpec.animateLayout { flyer.center = target }
        // Up 8 pt, then down 13.7 pt into the trash.
        let hop = CAKeyframeAnimation(keyPath: "transform.translation.y")
        hop.values = [0, -8, 5.66]
        hop.keyTimes = [0, 0.52, 1]
        hop.duration = 0.35
        hop.isAdditive = true
        hop.fillMode = .forwards
        hop.isRemovedOnCompletion = false
        flyer.layer.add(hop, forKey: "hop")
        bin.image = IonIcon.image("trash", size: 22).withRenderingMode(.alwaysTemplate)
        bin.tintColor = RecordSpec.binColor
        bin.bounds = CGRect(x: 0, y: 0, width: 40, height: 40)
        bin.center = target
        bin.alpha = 0
        bin.transform = .identity
        bin.isHidden = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.325) {
            self.bin.alpha = 1
            flyer.removeFromSuperview()
            let lid = CAKeyframeAnimation(keyPath: "transform.rotation.z")
            lid.values = [0, -5, 0, 10, -12, 0, -3, 0].map { (degrees: Double) -> Double in degrees * .pi / 180 }
            lid.keyTimes = [0, 0.25, 0.43, 0.55, 0.69, 0.77, 0.86, 1]
            lid.duration = 1.34 - 0.325
            self.bin.layer.add(lid, forKey: "lid")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.34) {
            UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseInOut], animations: { () -> Void in
                self.bin.alpha = 0
                self.bin.transform = CGAffineTransform(scaleX: 0.001, y: 0.001)
            }, completion: { (_: Bool) -> Void in
                self.bin.isHidden = true
                self.bin.transform = .identity
            })
            self.growClipBack()
        }
    }

    private func growClipBack() {
        guard phase == .idle, let clip = clipView else { return }
        clip.transform = CGAffineTransform(scaleX: 0.001, y: 0.001)
        clip.alpha = 0
        UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseInOut], animations: { () -> Void in
            clip.alpha = 1
            clip.transform = .identity
        }, completion: nil)
    }

    // MARK: The display loop

    private func startLoop() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(stepFrame))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopLoop() {
        displayLink?.invalidate()
        displayLink = nil
        translation = 0
        targetTranslation = 0
        cancelShift = 0
        cancelTarget = 0
        scale = 1
    }

    /// Every frame the shown slide moves 30% of the way to the finger; the blob shrinks with the slide left and
    /// moves by it (scaled), the blob and the lock rise with the slide up.
    @objc private func stepFrame() {
        translation = min(0, translation * (1 - RecordSpec.follow) + targetTranslation * RecordSpec.follow)
        cancelShift = min(0, cancelShift * (1 - RecordSpec.follow) + cancelTarget * RecordSpec.follow)
        placeOverlay()
        let move = CGAffineTransform(translationX: 0, y: translation)
        if blob.layer.animationKeys()?.isEmpty ?? true {
            blob.transform = move.scaledBy(x: scale, y: scale).translatedBy(x: cancelShift, y: 0)
        }
        if lockWrapper.layer.animationKeys()?.isEmpty ?? true {
            lockWrapper.transform = move
        }
    }

    /// The loudness, 0…1.
    func setLevel(_ level: CGFloat) {
        blob.updateLevel(level)
    }

    /// Record: the old pause of a locked take is gone (owner's spec: stop opens the preview instead).
    func setPaused(_ value: Bool) {}

    private func changedPhase() {
        let busy = phase != .idle
        for view in fieldViews {
            UIView.animate(withDuration: 0.15) { view.alpha = busy ? 0 : 1 }
        }
        if busy {
            button.isHidden = false
        } else {
            button.isHidden = !visible
        }
        if busy && !(clipSlides && phase != .preview) { clipView?.alpha = 0 }
        onPhase?(phase)
    }

    // MARK: The preview

    /// A stopped take waits in the field (`video`: a round video, shown in its circle; no waveform, no trimming).
    func showPreview(levels: [Double], durationMs: Int, video: Bool) {
        previewIsVideo = video
        phase = .preview
        let shown: UIView = video ? videoPreview : preview
        if video {
            videoPreview.setTake(durationMs: durationMs)
            videoPreview.recolor()
        } else {
            preview.allowsTrim = true
            preview.setTake(samples: levels, durationMs: durationMs)
            preview.recolor()
        }
        shown.isHidden = false
        shown.alpha = 0
        UIView.animate(withDuration: 0.2) { shown.alpha = 1 }
        trashButton.isHidden = false
        trashButton.tintColor = RecordSpec.controlColor
        trashButton.alpha = 0
        trashButton.transform = CGAffineTransform(scaleX: 0.001, y: 0.001)
        UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseInOut], animations: { () -> Void in
            self.trashButton.alpha = 1
            self.trashButton.transform = .identity
        }, completion: nil)
        // The button becomes the send button.
        button.iconView.alpha = 1
        button.iconView.transform = .identity
        showSendLook(true)
        sendFill.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
        UIView.animate(withDuration: 0.2) {
            self.sendFill.alpha = 1
            self.sendFill.transform = .identity
        }
        // «Record more», a glass circle above the send button: it grows from 0.01 (a round video: while it is
        // shorter than 59 s).
        if !video || durationMs < 59000 {
            recordMore.isHidden = false
            recordMore.alpha = 0
            recordMore.transform = CGAffineTransform(scaleX: 0.01, y: 0.01)
            RecordSpec.animateLayout { () -> Void in
                self.recordMore.alpha = 1
                self.recordMore.transform = .identity
            }
        }
        placeOverlay()
        changedPhase()
    }

    /// The frames of a stopped round video, as many as `videoFrameCount`.
    func setVideoFrames(_ images: [UIImage]) {
        videoPreview.setFrames(images)
    }

    var videoFrameCount: Int { videoPreview.frameCount }

    /// The preview played / paused / moved (fraction of the whole take).
    func setPreviewPlayback(_ fraction: Double, playing: Bool) {
        preview.setPlayback(progress: fraction, playing: playing)
    }

    /// The preview goes (sent: `deleted` false; thrown away: the trash bounces first).
    func endPreview(deleted: Bool) {
        guard phase == .preview else { return }
        phase = .idle
        hidePreview(deleted: deleted)
        changedPhase()
    }

    private func hidePreview(deleted: Bool) {
        UIView.animate(withDuration: 0.2, animations: { () -> Void in
            self.preview.alpha = 0
            self.videoPreview.alpha = 0
            self.sendFill.alpha = 0
        }, completion: { (_: Bool) -> Void in
            if self.phase != .preview {
                self.preview.isHidden = true
                self.videoPreview.isHidden = true
            }
        })
        showSendLook(false)
        button.iconView.alpha = 0
        button.iconView.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
        UIView.animate(withDuration: 0.15, delay: 0, options: [.curveEaseInOut], animations: { () -> Void in
            self.button.iconView.alpha = 1
            self.button.iconView.transform = .identity
        }, completion: nil)
        RecordSpec.animateLayout { () -> Void in
            self.recordMore.alpha = 0
            self.recordMore.transform = CGAffineTransform(scaleX: 0.01, y: 0.01)
        }
        let finishTrash = { () -> Void in
            UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseInOut], animations: { () -> Void in
                self.trashButton.alpha = 0
                self.trashButton.transform = CGAffineTransform(scaleX: 0.001, y: 0.001)
            }, completion: { (_: Bool) -> Void in
                if self.phase != .preview {
                    self.trashButton.isHidden = true
                    self.trashButton.transform = .identity
                }
            })
            self.growClipBack()
        }
        if deleted {
            // The trash's lid bounces (0.5 s) before it goes.
            let lid = CAKeyframeAnimation(keyPath: "transform.rotation.z")
            lid.values = [0, -10, 8, -5, 0].map { (degrees: Double) -> Double in degrees * .pi / 180 }
            lid.duration = 0.5
            trashButton.layer.add(lid, forKey: "lid")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: finishTrash)
        } else {
            finishTrash()
        }
    }

    @objc private func trashTapped() {
        guard phase == .preview else { return }
        onPreviewDelete?()
    }

    @objc private func recordMoreTapped() {
        guard phase == .preview else { return }
        onRecordMore?()
    }

    #if targetEnvironment(simulator)
    fileprivate func demoBegin(video: Bool = false) {
        if video {
            mode = .video
            showIdleIcon(animated: false)
        } else {
            timeWords = { () -> String in "0:04,63" }
        }
        begin(locked: false)
    }
    #endif

    /// «Record more»: the preview gives way to a locked take again.
    func resumeLocked() {
        guard phase == .preview else { return }
        phase = .idle
        preview.isHidden = true
        videoPreview.isHidden = true
        trashButton.isHidden = true
        recordMore.isHidden = true
        sendFill.alpha = 0
        showSendLook(false)
        begin(locked: true)
    }
}

extension RecordControl {
    #if targetEnvironment(simulator)
    /// `-voicedemo recording`: the take as it stands while the finger holds the button.
    func demoHolding() {
        demoBegin()
    }

    /// `-notedemo 1`: a round video being held — the circle over the chat and the composer's strip (the time,
    /// «slide to cancel») with the blob, as on a phone.
    func demoHoldingVideo() {
        demoBegin(video: true)
    }
    #endif
}

/// The layer over the screen that holds the blob, the lock and «record more»: it takes only touches that land on
/// one of those, everything else goes through to the screen.
final class RecordOverlayView: UIView {
    var touchables: [UIView] = []

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        for view in touchables.reversed() where !view.isHidden && view.alpha > 0.01 {
            let local = convert(point, to: view)
            if view.point(inside: local, with: event) {
                return view.hitTest(local, with: event) ?? view
            }
        }
        return nil
    }
}

/// «Record more»: a 40 pt glass circle (in a 44 pt box) with the microphone; pressed it goes to (w − 8) / w in
/// 0.2 s and comes back through (w + 2) / w (0.13 s out, 0.1 s in).
final class RecordMoreButton: UIControl {
    private let glass = GlassPill(interactive: false)
    private let icon = UIImageView()

    override init(frame: CGRect) {
        super.init(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        glass.frame = CGRect(x: 2, y: 2, width: 40, height: 40)
        glass.shape(radius: 20)
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        icon.image = IonIcon.image("mic-outline", size: 24).withRenderingMode(.alwaysTemplate)
        icon.tintColor = RecordSpec.controlColor
        icon.contentMode = .center
        icon.frame = bounds
        addSubview(icon)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = "Дописать"
        addTarget(self, action: #selector(down), for: [.touchDown, .touchDragEnter])
        addTarget(self, action: #selector(up), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func down() {
        let top = (bounds.width - 8) / bounds.width
        UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState], animations: { () -> Void in
            self.transform = CGAffineTransform(scaleX: top, y: top)
        }, completion: nil)
    }

    @objc private func up() {
        let most = (bounds.width + 2) / bounds.width
        UIView.animate(withDuration: 0.13, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: { () -> Void in
            self.transform = CGAffineTransform(scaleX: most, y: most)
        }, completion: { (_: Bool) -> Void in
            UIView.animate(withDuration: 0.1, delay: 0, options: [.curveEaseIn], animations: { () -> Void in
                self.transform = .identity
            }, completion: nil)
        })
    }
}
