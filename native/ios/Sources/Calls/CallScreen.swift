import CoreImage
import UIKit

/// One round button of the call screen with its word under it (the reference's `CallButton`).
final class CallRoundButton: UIControl {
    private let circle = UIView()
    private let icon = UIImageView()
    private let caption = UILabel()
    var onPress: (() -> Void)?

    /// `icon`: the reference's Ionicons name (27 pt). `color`: the button's own colour (red, green); without one it
    /// is white when `active`, else translucent.
    init(icon name: String, words: String, active: Bool = false, color: UIColor? = nil) {
        super.init(frame: CGRect(x: 0, y: 0, width: 76, height: 88))
        circle.backgroundColor = color ?? (active ? UIColor.white : UIColor(white: 1, alpha: 0.22))
        circle.layer.cornerRadius = 31
        circle.isUserInteractionEnabled = false
        addSubview(circle)
        icon.image = IonIcon.image(name, size: 27)
        icon.tintColor = color != nil ? UIColor.white : (active ? UIColor(hex: 0x1B2440) : UIColor.white)
        icon.contentMode = .center
        circle.addSubview(icon)
        caption.text = words
        caption.font = .systemFont(ofSize: 12)
        caption.textColor = .white
        caption.textAlignment = .center
        caption.adjustsFontSizeToFitWidth = true
        caption.minimumScaleFactor = 0.8
        addSubview(caption)
        isAccessibilityElement = true
        accessibilityTraits = active ? [.button, .selected] : .button
        accessibilityLabel = words
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    override var intrinsicContentSize: CGSize { CGSize(width: 76, height: 88) }

    override func layoutSubviews() {
        super.layoutSubviews()
        circle.frame = CGRect(x: (bounds.width - 62) / 2, y: 0, width: 62, height: 62)
        icon.frame = circle.bounds
        caption.frame = CGRect(x: 0, y: 69, width: bounds.width, height: 16)
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }

    @objc private func pressed() { onPress?() }
}

/// The call on the whole screen: the reference's `CallScreen`. Behind everything — the other person's picture,
/// blurred and dimmed (without one, their colour over black); the key emoji at the top; the picture, the name and
/// the status in the middle (in a video call the other side's camera fills the screen and this phone's own sits in
/// a small frame that can be dragged); the buttons at the bottom. Pulled down, the call is minimised.
final class CallScreenView: UIView, UIGestureRecognizerDelegate {
    private let tint = CAGradientLayer()
    private let picture = UIImageView()
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .dark))
    private let dim = UIView()
    private let remoteVideo = CallVideoView()
    private let localBox = UIView()
    private let localVideo = CallVideoView()
    private let minimizeButton = UIButton(type: .system)
    private let keyPill = UIView()
    private let keyLabel = UILabel()
    /// The reference's `lock-closed` (13 pt) before the key's emoji, 6 pt from them.
    private let keyLock = UIImageView()
    /// The music screen's still ambient under everything (the reference's `<MusicAmbient still>`).
    private let ambient = MusicAmbientView(tone: Theme.dark && ThemeStore.look.black ? "black" : "dark", still: true)
    /// «Звук», opened over the call.
    private var audioPanel: CallAudioPanelView?
    private let pulse = UIView()
    private let avatar = PersonAvatarView()
    private let nameLabel = UILabel()
    private let statusButton = UIButton(type: .system)
    private let statsBox = UIView()
    private let statsLabel = UILabel()
    private let clockLabel = UILabel()
    private let buttons = UIStackView()

    private var shown: CallState?
    private var statsOpen = false
    private var clock: Timer?
    private var buttonsKey = ""
    private var pulsing = false
    /// Where the small picture was dragged to (its centre); nil — its own corner.
    private var localCentre: CGPoint?
    #if targetEnvironment(simulator)
    private let sampleRemote = CAGradientLayer()
    private let sampleLocal = CAGradientLayer()
    #endif

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
        ambient.isUserInteractionEnabled = false
        addSubview(ambient)
        tint.startPoint = CGPoint(x: 0.5, y: 0)
        tint.endPoint = CGPoint(x: 0.5, y: 1)
        layer.addSublayer(tint)
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.isHidden = true
        addSubview(picture)
        blur.isHidden = true
        blur.isUserInteractionEnabled = false
        addSubview(blur)
        dim.backgroundColor = UIColor(white: 0, alpha: 0.32)
        dim.isUserInteractionEnabled = false
        addSubview(dim)
        remoteVideo.isHidden = true
        remoteVideo.isUserInteractionEnabled = false
        addSubview(remoteVideo)
        #if targetEnvironment(simulator)
        sampleRemote.isHidden = true
        sampleRemote.startPoint = CGPoint(x: 0, y: 0)
        sampleRemote.endPoint = CGPoint(x: 1, y: 1)
        layer.addSublayer(sampleRemote)
        #endif

        minimizeButton.setImage(IonIcon.image("chevron-down", size: 24), for: .normal)
        minimizeButton.tintColor = .white
        minimizeButton.backgroundColor = UIColor(white: 0, alpha: 0.2)
        minimizeButton.layer.cornerRadius = 20
        minimizeButton.accessibilityLabel = "Свернуть звонок"
        minimizeButton.addTarget(self, action: #selector(minimizeTapped), for: .touchUpInside)
        addSubview(minimizeButton)

        keyPill.layer.cornerRadius = 16
        keyPill.isUserInteractionEnabled = false
        addSubview(keyPill)
        keyLabel.textColor = .white
        keyLabel.textAlignment = .center
        keyLabel.adjustsFontSizeToFitWidth = true // a narrow phone: the line shrinks a little rather than lose its end
        keyLabel.minimumScaleFactor = 0.8
        keyPill.addSubview(keyLabel)
        keyLock.image = IonIcon.image("lock-closed", size: 13)
        keyLock.tintColor = .white
        keyLock.isHidden = true
        keyPill.addSubview(keyLock)

        pulse.backgroundColor = UIColor(white: 1, alpha: 0.35)
        pulse.layer.cornerRadius = 70
        pulse.alpha = 0
        pulse.isUserInteractionEnabled = false
        addSubview(pulse)
        addSubview(avatar)
        nameLabel.textColor = .white
        nameLabel.textAlignment = .center
        nameLabel.adjustsFontSizeToFitWidth = true
        nameLabel.minimumScaleFactor = 0.6
        addSubview(nameLabel)
        statusButton.setTitleColor(UIColor(white: 1, alpha: 0.85), for: .normal)
        statusButton.titleLabel?.font = .systemFont(ofSize: 16)
        statusButton.titleLabel?.textAlignment = .center
        statusButton.titleLabel?.adjustsFontSizeToFitWidth = true
        statusButton.titleLabel?.minimumScaleFactor = 0.7
        statusButton.addTarget(self, action: #selector(statusTapped), for: .touchUpInside)
        addSubview(statusButton)
        statsBox.backgroundColor = UIColor(white: 0, alpha: 0.35)
        statsBox.layer.cornerRadius = 12
        statsBox.isHidden = true
        statsBox.isUserInteractionEnabled = false
        addSubview(statsBox)
        statsLabel.textColor = UIColor(white: 1, alpha: 0.9)
        statsLabel.font = .systemFont(ofSize: 12)
        statsLabel.numberOfLines = 0
        statsLabel.textAlignment = .center
        statsBox.addSubview(statsLabel)
        clockLabel.textColor = UIColor(white: 1, alpha: 0.6)
        clockLabel.font = .monospacedDigitSystemFont(ofSize: 14, weight: .regular)
        clockLabel.textAlignment = .center
        clockLabel.isHidden = true
        addSubview(clockLabel)

        localBox.layer.cornerRadius = 16
        localBox.layer.cornerCurve = .continuous
        localBox.layer.borderWidth = 1
        localBox.layer.borderColor = UIColor(white: 1, alpha: 0.4).cgColor
        localBox.clipsToBounds = true
        localBox.backgroundColor = .black
        localBox.isHidden = true
        localBox.isAccessibilityElement = true
        localBox.accessibilityTraits = .button
        localBox.accessibilityLabel = "Повернуть"
        addSubview(localBox)
        localVideo.isUserInteractionEnabled = false
        localBox.addSubview(localVideo)
        #if targetEnvironment(simulator)
        sampleLocal.isHidden = true
        sampleLocal.colors = [UIColor(hex: 0x3A3F4B).cgColor, UIColor(hex: 0x14161B).cgColor]
        localBox.layer.addSublayer(sampleLocal)
        #endif
        localBox.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(flipTapped)))
        localBox.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(localDragged(_:))))

        buttons.axis = .horizontal
        buttons.distribution = .equalSpacing
        buttons.alignment = .top
        addSubview(buttons)

        let pull = UIPanGestureRecognizer(target: self, action: #selector(pulled(_:)))
        pull.delegate = self
        addGestureRecognizer(pull)
        NotificationCenter.default.addObserver(self, selector: #selector(pictureReady(_:)), name: ChatAvatarStore.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        clock?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    /// The screen leaves: its pictures are let go, its clock stops.
    func retire() {
        closeAudio()
        CallAudioChoice.reset()
        clock?.invalidate()
        clock = nil
        remoteVideo.showRemote(of: nil)
        localVideo.showLocal(of: nil)
    }

    // MARK: What is shown

    private var showsVideo: Bool {
        guard let call = shown else { return false }
        return call.video && call.remoteVideo
    }

    private var showsLocal: Bool {
        guard let call = shown else { return false }
        return call.video && call.localVideo && !call.cameraOff
    }

    func update(_ call: CallState) {
        var peerChanged = true
        if let before = shown {
            let samePerson: Bool = before.peer.id == call.peer.id
            let samePicture: Bool = before.peer.avatarId == call.peer.avatarId && before.peer.avatarColor == call.peer.avatarColor
            peerChanged = !(samePerson && samePicture)
        }
        shown = call
        if peerChanged {
            avatar.show(call.peer, address: Calls.shared.pictureAddress(call.peer))
            let color = UIColor(hex: call.peer.avatarColor)
            tint.colors = [color.withAlphaComponent(0.8).cgColor, color.withAlphaComponent(0.33).cgColor, UIColor.clear.cgColor]
            loadPicture()
        }
        nameLabel.text = call.peer.displayName

        // The key of the call, or — before it is known — what protects it.
        if let key = call.key {
            keyLabel.attributedText = NSAttributedString(string: key.joined(separator: " "), attributes: [.font: UIFont.systemFont(ofSize: 15), .kern: 2, .foregroundColor: UIColor.white])
            keyPill.backgroundColor = UIColor(white: 0, alpha: 0.18)
            keyLock.isHidden = false
            keyPill.accessibilityLabel = "Ключ звонка: " + key.joined(separator: " ")
        } else {
            keyLabel.attributedText = NSAttributedString(string: "🔒 Звонок защищён сквозным шифрованием", attributes: [.font: UIFont.systemFont(ofSize: 12), .foregroundColor: UIColor(white: 1, alpha: 0.8)])
            keyPill.backgroundColor = .clear
            keyLock.isHidden = true
        }
        if call.isOver || call.status == "incoming" { closeAudio() }
        audioPanel?.speakerOn = call.speaker
        // The call has ended: the next one starts on the system's own microphone and output again.
        if call.isOver { CallAudioChoice.reset() }

        let canMinimize = call.status != "incoming" && !call.isOver
        minimizeButton.isHidden = !canMinimize

        // In the simulator's samples the pictures are drawn in the person's colours: nothing is filmed.
        var sample = false
        #if targetEnvironment(simulator)
        sample = Calls.shared.isDemo
        if sample {
            let color = UIColor(hex: call.peer.avatarColor)
            sampleRemote.colors = [color.cgColor, UIColor(hex: 0x10131A).cgColor]
            sampleRemote.isHidden = !showsVideo
            sampleLocal.isHidden = !showsLocal
            localBox.isHidden = !showsLocal
        }
        #endif
        if !sample {
            remoteVideo.isHidden = !showsVideo
            remoteVideo.showRemote(of: showsVideo ? Calls.shared.media : nil)
            localBox.isHidden = !showsLocal
            localVideo.showLocal(of: showsLocal ? Calls.shared.media : nil)
        }

        let ringing = call.status == "ringing" || call.status == "incoming" || call.status == "requesting"
        setPulse(ringing && !showsVideo)
        avatar.isHidden = showsVideo
        nameLabel.font = UIFont.systemFont(ofSize: showsVideo ? 18 : 28, weight: .bold)

        rebuildButtons(call)
        refreshStatus()
        if call.status == "active" && clock == nil {
            clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] (_: Timer) -> Void in self?.refreshStatus() }
        } else if call.status != "active" {
            clock?.invalidate()
            clock = nil
        }
        setNeedsLayout()
    }

    /// The status under the name; a weak link is said in words next to it, so it is clear the trouble is the
    /// network and not the app. With the diagnostics open — how the call travels.
    private func refreshStatus() {
        guard let call = shown else { return }
        let network = Calls.shared.signalNetwork
        let status = CallRules.status(call, network: network)
        var words = status.text
        let reconnecting = call.status == "active" && call.reconnecting
        if call.status == "active" && !call.reconnecting && call.grade != "good" {
            let link = CallRules.linkWords(call.grade)
            if !link.isEmpty { words += " · " + link }
        }
        if showsVideo && reconnecting, let running = status.clock { words += " · " + running }
        // The clock ticks every second: the words change without the button's own fade.
        UIView.performWithoutAnimation {
            statusButton.setTitle(words, for: .normal)
            statusButton.layoutIfNeeded()
        }
        statusButton.accessibilityLabel = words + ". Диагностика звонка"
        clockLabel.text = status.clock
        clockLabel.isHidden = !(reconnecting && !showsVideo)
        // An ended call of the preview build: what it went through, in one grey line (CallReport.swift).
        let report = call.isOver ? Calls.shared.endReport : nil
        let lines = report.map { [$0] } ?? (statsOpen && call.status == "active" ? Calls.shared.linkLines : [])
        statsLabel.textColor = UIColor(white: 1, alpha: report == nil ? 0.9 : 0.6)
        statsLabel.text = lines.joined(separator: "\n")
        let hidden = lines.isEmpty
        if statsBox.isHidden != hidden {
            statsBox.isHidden = hidden
            setNeedsLayout()
        }
    }

    private func rebuildButtons(_ call: CallState) {
        // Built again only when the set of buttons or what they show changes.
        var kind = "live"
        if call.status == "incoming" { kind = "incoming" } else if call.isOver { kind = call.retry ? "retry" : "ended" }
        var key = kind
        key += call.video ? "|video" : "|audio"
        key += call.cameraOff ? "|off" : "|on"
        key += call.muted ? "|muted" : "|heard"
        key += call.speaker ? "|loud" : "|quiet"
        if call.isOver && Calls.shared.endReport != nil { key += "|report" }
        if key == buttonsKey { return }
        buttonsKey = key
        for old in buttons.arrangedSubviews {
            buttons.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        var made: [CallRoundButton] = []
        let red = UIColor(hex: 0xFF3B30), green = UIColor(hex: 0x34C759)
        let callSymbol = call.video ? "videocam" : "call"
        if call.status == "incoming" {
            let decline = CallRoundButton(icon: "close", words: "Отклонить", color: red)
            decline.onPress = { Calls.shared.hangup() }
            let answer = CallRoundButton(icon: callSymbol, words: "Ответить", color: green)
            answer.onPress = { Calls.shared.accept() }
            made = [decline, answer]
        } else if call.isOver {
            if call.retry {
                let close = CallRoundButton(icon: "close", words: "Закрыть")
                close.onPress = { Calls.shared.close() }
                let again = CallRoundButton(icon: callSymbol, words: "Повторить", color: green)
                again.onPress = { Calls.shared.retry() }
                made = [close, again]
            } else if Calls.shared.endReport != nil {
                // The preview build keeps a call that did not come up on the screen for a while (its grey line): it can be put away.
                let close = CallRoundButton(icon: "close", words: "Закрыть")
                close.onPress = { Calls.shared.close() }
                made = [close]
            }
        } else {
            let cameraOn = call.video && !call.cameraOff
            // «Звук»: the microphone and the output of this call (CallAudioPanel.swift), as the reference's iPhone build.
            let speaker = CallRoundButton(icon: "volume-high", words: "Звук", active: call.speaker)
            speaker.onPress = { [weak self] in self?.openAudio() }
            let camera = CallRoundButton(icon: cameraOn ? "videocam" : "videocam-off", words: "Видео", active: cameraOn)
            camera.onPress = { Calls.shared.toggleCamera() }
            made = [speaker, camera]
            if cameraOn {
                let flip = CallRoundButton(icon: "camera-reverse", words: "Повернуть")
                flip.onPress = { Calls.shared.flipCamera() }
                made.append(flip)
            }
            let mute = CallRoundButton(icon: call.muted ? "mic-off" : "mic", words: call.muted ? "Звук выкл" : "Убрать звук", active: call.muted)
            mute.onPress = { Calls.shared.toggleMute() }
            let end = CallRoundButton(icon: "close", words: "Завершить", color: red)
            end.onPress = { Calls.shared.hangup() }
            made.append(mute)
            made.append(end)
        }
        for button in made {
            button.translatesAutoresizingMaskIntoConstraints = false
            button.widthAnchor.constraint(equalToConstant: made.count > 4 ? 68 : 76).isActive = true
            button.heightAnchor.constraint(equalToConstant: 88).isActive = true
            buttons.addArrangedSubview(button)
        }
        setNeedsLayout()
    }

    private func setPulse(_ on: Bool) {
        if on == pulsing { return }
        pulsing = on
        pulse.layer.removeAllAnimations()
        pulse.alpha = 0
        guard on else { return }
        // Easing.out(Easing.quad) over 1.4 s, as keyframes: 1 → 1.35 in size, 0.45 → 0 in opacity.
        var sizes: [NSNumber] = [], fades: [NSNumber] = []
        for step in 0...40 {
            let t = Double(step) / 40, v = 1 - (1 - t) * (1 - t)
            sizes.append(NSNumber(value: 1 + v * 0.35))
            fades.append(NSNumber(value: 0.45 * (1 - v)))
        }
        let grow = CAKeyframeAnimation(keyPath: "transform.scale")
        grow.values = sizes
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = fades
        let both = CAAnimationGroup()
        both.animations = [grow, fade]
        both.duration = 1.4
        both.repeatCount = .infinity
        both.isRemovedOnCompletion = false
        pulse.layer.add(both, forKey: "pulse")
    }

    private func loadPicture() {
        guard let call = shown else { return }
        var image: UIImage? = nil
        let address = Calls.shared.pictureAddress(call.peer)
        if !call.peer.avatarId.isEmpty && !address.isEmpty { image = ChatAvatarStore.shared.image(key: call.peer.avatarId, url: address) }
        picture.isHidden = image == nil
        blur.isHidden = true
        guard let source = image else { picture.image = nil; return }
        // The reference's `blurRadius={60}` (expo-image: a Gaussian of 60 × the image's scale, in its own pixels),
        // not a frosted material: the picture keeps its colours, the dim above does the darkening.
        let key = call.peer.avatarId
        DispatchQueue.global(qos: .userInitiated).async {
            let blurred = CallScreenView.blurred(source, radius: 60)
            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.shown?.peer.avatarId == key else { return }
                self.picture.image = blurred ?? source
            }
        }
    }

    private static let blurContext = CIContext(options: nil)

    private static func blurred(_ image: UIImage, radius: CGFloat) -> UIImage? {
        guard let cg = image.cgImage else { return nil }
        let input = CIImage(cgImage: cg)
        guard let filter = CIFilter(name: "CIGaussianBlur") else { return nil }
        filter.setValue(input.clampedToExtent(), forKey: kCIInputImageKey)
        filter.setValue(radius * image.scale, forKey: kCIInputRadiusKey)
        guard let output = filter.outputImage?.cropped(to: input.extent), let made = blurContext.createCGImage(output, from: input.extent) else { return nil }
        return UIImage(cgImage: made, scale: image.scale, orientation: image.imageOrientation)
    }

    @objc private func pictureReady(_ note: Notification) {
        guard let key = note.object as? String, !key.isEmpty, key == shown?.peer.avatarId else { return }
        loadPicture()
    }

    // MARK: Places

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width, height = bounds.height
        let top = safeAreaInsets.top + 10, bottom = safeAreaInsets.bottom + 24
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        tint.frame = bounds
        tint.isHidden = !picture.isHidden
        #if targetEnvironment(simulator)
        sampleRemote.frame = bounds
        #endif
        CATransaction.commit()
        // The picture behind is a little larger than the screen, so its blurred edges stay outside.
        ambient.frame = bounds
        picture.frame = bounds.insetBy(dx: -width * 0.125, dy: -height * 0.125)
        blur.frame = bounds
        dim.frame = bounds
        remoteVideo.frame = bounds
        minimizeButton.frame = CGRect(x: 16, y: safeAreaInsets.top + 6, width: 40, height: 40)

        // With the key: padding 12 × 6, the lock, 6 pt, the emoji; before it — the words alone, centred.
        // The words alone are a plain centred line in the reference (no pill, no limit but the screen): they may use
        // all the width between the «Свернуть» buttons' columns (cut short at width − 140 they lost their end).
        let lockRoom: CGFloat = keyLock.isHidden ? 0 : 13 + 6
        let room = keyLock.isHidden ? max(0, width - 2 * minimizeButton.frame.maxX) : width - 140
        let keySize = keyLabel.sizeThatFits(CGSize(width: room, height: 40))
        let pillWidth = keyLock.isHidden ? room : min(room, keySize.width + lockRoom + 24)
        let pillHeight: CGFloat = keyLock.isHidden ? 34 : ceil(keySize.height) + 12
        keyPill.frame = CGRect(x: (width - pillWidth) / 2, y: top, width: pillWidth, height: pillHeight)
        keyLock.frame = CGRect(x: 12, y: (pillHeight - 13) / 2, width: 13, height: 13)
        keyLabel.frame = CGRect(x: 12 + lockRoom, y: 0, width: pillWidth - 24 - lockRoom, height: pillHeight)
        if keyLock.isHidden { keyLabel.frame = keyPill.bounds }
        audioPanel?.frame = bounds

        let buttonsInset: CGFloat = buttons.arrangedSubviews.count <= 2 ? 30 : 8
        buttons.frame = CGRect(x: buttonsInset, y: height - bottom - 88, width: width - buttonsInset * 2, height: 88)
        buttons.isHidden = buttons.arrangedSubviews.isEmpty

        statsLabel.preferredMaxLayoutWidth = width - 72
        let statsSize = statsBox.isHidden ? CGSize.zero : statsLabel.sizeThatFits(CGSize(width: width - 72, height: 200))
        if showsVideo {
            // The other side's camera fills the screen: the name and the status sit above the buttons.
            var y = buttons.frame.minY - 14
            if !statsBox.isHidden {
                y -= statsSize.height + 16
                statsBox.frame = CGRect(x: (width - statsSize.width - 24) / 2, y: y, width: statsSize.width + 24, height: statsSize.height + 16)
                y -= 6
            }
            y -= 22
            statusButton.frame = CGRect(x: 24, y: y, width: width - 48, height: 22)
            y -= 24
            nameLabel.frame = CGRect(x: 24, y: y, width: width - 48, height: 24)
        } else {
            let block: CGFloat = 170 + 14 + 34 + 14 + 22
            var y = max(top + 44, (top + 34 + buttons.frame.minY - block) / 2)
            pulse.bounds = CGRect(x: 0, y: 0, width: 140, height: 140)
            pulse.center = CGPoint(x: width / 2, y: y + 85)
            avatar.frame = CGRect(x: (width - 130) / 2, y: y + 20, width: 130, height: 130)
            y += 170 + 14
            nameLabel.frame = CGRect(x: 24, y: y, width: width - 48, height: 34)
            y += 34 + 14
            statusButton.frame = CGRect(x: 24, y: y, width: width - 48, height: 22)
            y += 22 + 6
            if !statsBox.isHidden {
                statsBox.frame = CGRect(x: (width - statsSize.width - 24) / 2, y: y, width: statsSize.width + 24, height: statsSize.height + 16)
                y += statsSize.height + 16 + 8
            }
            clockLabel.frame = CGRect(x: 24, y: y + 8, width: width - 48, height: 18)
        }
        statsLabel.frame = statsBox.bounds.insetBy(dx: 12, dy: 8)

        // This phone's own picture: the upper right corner, or where it was dragged to.
        let localWidth = (width * 0.28).rounded(), localHeight = (localWidth * 4 / 3).rounded()
        let home = CGPoint(x: width - 16 - localWidth / 2, y: safeAreaInsets.top + 56 + localHeight / 2)
        localBox.bounds = CGRect(x: 0, y: 0, width: localWidth, height: localHeight)
        localBox.center = keptInside(localCentre ?? home, size: localBox.bounds.size)
        localVideo.frame = localBox.bounds
        #if targetEnvironment(simulator)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        sampleLocal.frame = localBox.bounds
        CATransaction.commit()
        #endif
    }

    private func keptInside(_ centre: CGPoint, size: CGSize) -> CGPoint {
        let left = 12 + size.width / 2, right = bounds.width - 12 - size.width / 2
        let high = safeAreaInsets.top + 8 + size.height / 2, low = bounds.height - safeAreaInsets.bottom - 130 - size.height / 2
        return CGPoint(x: min(max(centre.x, left), max(left, right)), y: min(max(centre.y, high), max(high, low)))
    }

    // MARK: «Звук»

    private func openAudio() {
        guard audioPanel == nil, let call = shown else { return }
        let panel = CallAudioPanelView(frame: bounds)
        panel.speakerOn = call.speaker
        panel.onSpeaker = { Calls.shared.toggleSpeaker() }
        panel.onClose = { [weak self] in self?.closeAudio() }
        addSubview(panel)
        audioPanel = panel
        UIAccessibility.post(notification: .screenChanged, argument: panel)
    }

    private func closeAudio() {
        guard let panel = audioPanel else { return }
        audioPanel = nil
        panel.stop()
        panel.removeFromSuperview()
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    // MARK: Touches

    @objc private func minimizeTapped() { Calls.shared.minimize() }
    @objc private func flipTapped() { Calls.shared.flipCamera() }

    /// A tap on the status shows how the call travels (direct or through the server), its delay, losses and bitrates.
    @objc private func statusTapped() {
        statsOpen.toggle()
        refreshStatus()
    }

    @objc private func localDragged(_ pan: UIPanGestureRecognizer) {
        let move = pan.translation(in: self)
        pan.setTranslation(.zero, in: self)
        localBox.center = keptInside(CGPoint(x: localBox.center.x + move.x, y: localBox.center.y + move.y), size: localBox.bounds.size)
        localCentre = localBox.center
        if pan.state == .ended || pan.state == .cancelled {
            // Let go, it settles at the nearer side.
            let side = localBox.center.x < bounds.width / 2 ? 12 + localBox.bounds.width / 2 : bounds.width - 12 - localBox.bounds.width / 2
            let rest = CGPoint(x: side, y: localBox.center.y)
            localCentre = rest
            UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0, options: [.beginFromCurrentState], animations: { self.localBox.center = rest }, completion: nil)
        }
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer, pan.view === self else { return true }
        guard let call = shown, call.status != "incoming", !call.isOver else { return false }
        if !localBox.isHidden && localBox.frame.contains(pan.location(in: self)) { return false }
        let speed = pan.velocity(in: self)
        return speed.y > 0 && abs(speed.y) > abs(speed.x)
    }

    /// Pulled down far or fast enough, the call is minimised (the same as the chevron) — the reference's
    /// useSwipeDismiss (swipeDismissModel.ts): it follows the finger down 1:1 and up only 14 pt with resistance;
    /// let go past a quarter of its height (56…240 pt) or flicked down at 1000 pt/s, it slides out (out-quad,
    /// 120…280 ms) and minimises; a flick back up at 400 pt/s keeps it; else it springs back (damping 22,
    /// stiffness 260, mass 0.8).
    @objc private func pulled(_ pan: UIPanGestureRecognizer) {
        let travel = pan.translation(in: superview).y
        let offset: CGFloat = travel >= 0 ? travel : -14 * (1 - exp(travel / (14 * 3)))
        switch pan.state {
        case .changed:
            transform = CGAffineTransform(translationX: 0, y: offset)
        case .ended, .cancelled:
            let speed = pan.velocity(in: superview).y
            let height = bounds.height > 0 ? bounds.height : 400
            let distance = min(240, max(56, height * 0.25))
            var close = false
            if pan.state == .ended && offset > 0 && speed > -400 {
                close = (speed >= 1000 && offset >= 8) || offset >= distance
            }
            if close {
                let target = max(height, superview?.bounds.height ?? 0) + 24
                let left = max(0, target - max(0, offset))
                let duration = max(120, min(280, (left / max(1200, speed)) * 1000)).rounded() / 1000
                // Exactly Easing.out(Easing.quad): the positions computed frame by frame (no cubic stand-in).
                let from = offset
                var steps: [NSValue] = []
                for step in 0...60 {
                    let t = CGFloat(step) / 60, v = 1 - (1 - t) * (1 - t)
                    steps.append(NSValue(caTransform3D: CATransform3DMakeTranslation(0, from + (target - from) * v, 0)))
                }
                let slide = CAKeyframeAnimation(keyPath: "transform")
                slide.values = steps
                slide.duration = Double(duration)
                slide.calculationMode = .linear
                CATransaction.begin()
                CATransaction.setCompletionBlock { Calls.shared.minimize() }
                transform = CGAffineTransform(translationX: 0, y: target)
                layer.add(slide, forKey: "slide")
                CATransaction.commit()
            } else {
                let spring = UISpringTimingParameters(mass: 0.8, stiffness: 260, damping: 22, initialVelocity: CGVector(dx: 0, dy: offset != 0 ? speed / -offset : 0))
                let back = UIViewPropertyAnimator(duration: 0, timingParameters: spring)
                back.addAnimations { self.transform = .identity }
                back.startAnimation()
            }
        default:
            break
        }
    }
}
