import AVFoundation
import UIKit

/// The picture of a round video playing inside its row: the player's layer cut to a circle, the ring of a listen
/// around it, a play mark while it is paused, and the pill at the lower left of its square (the length and the
/// speaker-off mark while it loops silently, the seconds played while it is listened to). It takes no touches —
/// a tap goes to the row under it. Reference: mobile/src/videonote/VideoNote.tsx (`VideoNoteBubble`, NoteRing.tsx).
final class NotePlayerView: UIView, UIGestureRecognizerDelegate {
    private final class Video: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
    }
    private let video = Video()
    private let ring = CAShapeLayer()
    private let mark = UIImageView(image: IonIcon.image("play", size: 26).withRenderingMode(.alwaysTemplate))
    private let pill = UIView()
    private let pillWords = UILabel()
    private let pillMute = UIImageView(image: IonIcon.image("volume-mute", size: 11).withRenderingMode(.alwaysTemplate))
    /// VideoNote.tsx: while a listen is rewound — the picture dimmed by 0.28 black, the play mark, and the white
    /// 14 pt knob on the ring (its shadow .3, radius 3, 1 down).
    private let dim = UIView()
    private let knob = UIView()
    private var progressNow: CGFloat = 0
    private var scrubbing = false
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    /// A rewind along the ring of a circle being listened to: began, moved to a share (0…0.985), ended at a share.
    var onScrub: ((String, CGFloat) -> Void)?
    /// Rewinding is possible (the circle is open, being listened to).
    var canScrub = false {
        didSet { isUserInteractionEnabled = canScrub }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        video.clipsToBounds = true
        video.backgroundColor = Theme.surface2
        (video.layer as? AVPlayerLayer)?.videoGravity = .resizeAspectFill
        addSubview(video)
        ring.fillColor = UIColor.clear.cgColor
        ring.strokeColor = Theme.accent.cgColor
        ring.lineWidth = 3
        ring.lineCap = .round
        ring.strokeEnd = 0
        layer.addSublayer(ring)
        mark.tintColor = .white
        mark.contentMode = .center
        mark.backgroundColor = UIColor(red: 10 / 255, green: 20 / 255, blue: 35 / 255, alpha: 0.45)
        mark.layer.cornerRadius = 26
        mark.clipsToBounds = true
        mark.isHidden = true
        addSubview(mark)
        pill.backgroundColor = UIColor(white: 0, alpha: 0.42)
        pill.layer.cornerRadius = 9
        pill.isHidden = true
        pillWords.textColor = .white
        pill.addSubview(pillWords)
        pillMute.tintColor = .white
        pill.addSubview(pillMute)
        addSubview(pill)
        dim.backgroundColor = UIColor(white: 0, alpha: 0.28)
        dim.isHidden = true
        dim.isUserInteractionEnabled = false
        video.addSubview(dim)
        knob.backgroundColor = .white
        knob.layer.cornerRadius = 7
        knob.layer.shadowColor = UIColor.black.cgColor
        knob.layer.shadowOpacity = 0.3
        knob.layer.shadowRadius = 3
        knob.layer.shadowOffset = CGSize(width: 0, height: 1)
        knob.alpha = 0
        knob.isUserInteractionEnabled = false
        addSubview(knob)
        pan.delegate = self
        addGestureRecognizer(pan)
    }

    /// playback.ts `onScrubBand`: a rewind starts on the outer 56 pt of the ring (to 12 past it).
    private func onBand(_ point: CGPoint) -> Bool {
        let side = min(bounds.width, bounds.height)
        let distance = hypot(point.x - bounds.midX, point.y - bounds.midY), radius = side / 2
        return distance >= radius - 56 && distance <= radius + 12
    }

    /// playback.ts `scrubFraction`: the share of the circle clockwise from 12 o'clock; crossing 12 does not wrap.
    private func share(_ point: CGPoint, previous: CGFloat?) -> CGFloat {
        var value = atan2(point.x - bounds.midX, -(point.y - bounds.midY)) / (2 * .pi)
        if value < 0 { value += 1 }
        if let previous {
            if previous > 0.75 && value < 0.25 { value = 1 } else if previous < 0.25 && value > 0.75 { value = 0 }
        }
        return max(0, min(0.985, value))
    }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        let point = recognizer.location(in: self)
        switch recognizer.state {
        case .began:
            scrubbing = true
            let value = share(point, previous: nil)
            onScrub?("begin", value)
            showScrub(value)
            dim.isHidden = false
            mark.isHidden = false
            UIView.animate(withDuration: 0.12) { self.knob.alpha = 1 }
        case .changed:
            let value = share(point, previous: progressNow)
            if abs(value - progressNow) >= 0.01 { onScrub?("to", value) }
            showScrub(value)
        default:
            guard scrubbing else { return }
            scrubbing = false
            dim.isHidden = true
            onScrub?("end", progressNow)
            UIView.animate(withDuration: 0.16) { self.knob.alpha = 0 }
        }
    }

    private func showScrub(_ value: CGFloat) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.strokeEnd = value
        ring.opacity = 1
        CATransaction.commit()
        progressNow = value
        placeKnob()
    }

    private func placeKnob() {
        let side = min(bounds.width, bounds.height), radius = side / 2 - 1.5
        let angle = progressNow * 2 * .pi
        knob.frame = CGRect(x: bounds.midX + radius * sin(angle) - 7, y: bounds.midY - radius * cos(angle) - 7, width: 14, height: 14)
    }

    required init?(coder: NSCoder) { return nil }

    // VideoNote.tsx: the rewind starts on the ring band after 8 pt of movement, so a tap still pauses and a drag
    // from the middle still scrolls the list.
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pan else { return super.gestureRecognizerShouldBegin(gestureRecognizer) }
        let start = pan.location(in: self)
        let moved = pan.translation(in: self)
        return canScrub && onBand(CGPoint(x: start.x - moved.x, y: start.y - moved.y)) && hypot(moved.x, moved.y) >= 8
    }

    // The row under it draws its resting marks only while no player stands over it.
    override func willMove(toSuperview newSuperview: UIView?) {
        super.willMove(toSuperview: newSuperview)
        superview?.setNeedsDisplay()
    }

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        superview?.setNeedsDisplay()
    }

    var player: AVPlayer? {
        get { (video.layer as? AVPlayerLayer)?.player }
        set { (video.layer as? AVPlayerLayer)?.player = newValue }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = min(bounds.width, bounds.height)
        video.frame = bounds
        video.layer.cornerRadius = side / 2
        ring.frame = bounds
        // NoteRing: r = (size − stroke) / 2, from 12 o'clock clockwise.
        ring.path = UIBezierPath(arcCenter: CGPoint(x: bounds.midX, y: bounds.midY), radius: max(1, (side - 3) / 2), startAngle: -CGFloat.pi / 2, endAngle: CGFloat.pi * 1.5, clockwise: true).cgPath
        mark.frame = CGRect(x: bounds.midX - 26, y: bounds.midY - 26, width: 52, height: 52)
        dim.frame = video.bounds
        placeKnob()
        placePill()
    }

    private func placePill() {
        let words = ceil(pillWords.sizeThatFits(CGSize(width: 200, height: 20)).width)
        let tall = ceil(pillWords.font.lineHeight) + 4
        let icon: CGFloat = pillMute.isHidden ? 0 : 4 + 11
        pill.frame = CGRect(x: 6, y: bounds.height - 6 - tall, width: 7 + words + icon + 7, height: tall)
        pillWords.frame = CGRect(x: 7, y: 2, width: words, height: tall - 4)
        pillMute.frame = CGRect(x: 7 + words + 4, y: (tall - 11) / 2, width: 11, height: 11)
    }

    /// The pill at the lower left: `muted` — the silent loop (11 pt with the speaker-off mark), else the seconds
    /// played (12 pt, tabular figures). Empty words hide it.
    func showPill(_ words: String, muted: Bool) {
        pill.isHidden = words.isEmpty
        pillWords.font = muted ? UIFont.systemFont(ofSize: 11) : UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        pillWords.text = words
        pillMute.isHidden = !muted
        placePill()
    }

    /// Shows or hides the play mark without touching the ring.
    func showPause(_ paused: Bool) {
        mark.isHidden = !paused
    }

    func show(progress: CGFloat, paused: Bool) {
        if scrubbing { return }
        progressNow = min(1, max(0, progress))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.strokeEnd = min(1, max(0, progress))
        // NoteRing: the stroke is invisible until something has played.
        ring.opacity = progress > 0.001 ? 1 : 0
        CATransaction.commit()
        mark.isHidden = !paused
    }
}

/// Round video messages of one chat, played in their rows.
///
/// Reference: mobile/src/videonote/VideoNote.tsx (`VideoNoteBubble`) and playback.ts: a circle on screen is
/// brought by itself and loops without sound; a tap plays it from the start with sound, at the speed chosen for
/// voice messages, with a ring of its progress; another tap pauses; when it ends it goes back to the silent
/// loop. One circle sounds at a time, and a voice message goes quiet for it. Here one circle at a time is shown
/// moving (the reference moves every circle on screen), and only circles of at most 8 MiB are brought unasked.
final class NotePlayback {
    private static let unasked = 8 * 1024 * 1024
    private let server: Server?
    /// Where a row's circle stands while the row is on screen, and the rows on screen (the chat's list, or
    /// «Избранное»).
    private let hostOf: (String) -> (view: UIView, frame: CGRect)?
    private let keysOnScreen: () -> [String]
    /// Rows whose circle is brought and decrypted (any list): drawn without the download mark, with the
    /// speaker-off mark in their pill (VideoNote.tsx `ready`).
    private(set) static var readyKeys = Set<String>()
    /// A circle of this row was brought (or its copy dropped): the row is drawn again.
    var onReadyChanged: ((String) -> Void)?
    /// VideoNote.tsx: a circle listened to grows in place to min(404, the row's width) and gives the room back
    /// when the listen ends. The list makes the row's slot large (true) or small again (false) at once; the circle
    /// itself is scaled meanwhile (200 ms, ease-out cubic), anchored at the lower corner on the message's side.
    var onExpanded: ((String, Bool) -> Void)?
    /// Whether a row's circle stands at the right edge (own messages); it grows away from that edge.
    var anchorsRight: ((String) -> Bool)?
    /// The row whose slot is large now (empty: none).
    private(set) var expandedKey = ""
    private var smallScale: CGFloat = 1
    private var shrinking: UIViewPropertyAnimator?
    private var resumeAfterScrub = false
    private var files: [String: MediaFetch.Brought] = [:]
    private var isNote: [String: Bool] = [:]
    private var failed = Set<String>()
    private var player: AVPlayer?
    private let screen = NotePlayerView(frame: .zero)
    private var key = ""
    private var sound = false
    private var observer: Any?
    private var ended: NSObjectProtocol?
    private var fetch: MediaFetch?
    private var fetchKey = ""
    private var fetchForSound = false
    /// What the list must show while a circle is being brought after a tap (nil: nothing).
    var onState: ((MsgMediaState?) -> Void)?
    var onProblem: ((String) -> Void)?
    /// A circle is about to sound: the voice message goes quiet.
    var onWillPlay: (() -> Void)?
    /// True while a take is recorded or a voice message plays: no silent loop starts then (it would have to
    /// touch the audio session under them).
    var holdsSilence: (() -> Bool)?

    init(server: Server?, list: MsgListView) {
        self.server = server
        hostOf = { [weak list] (key: String) -> (view: UIView, frame: CGRect)? in list?.mediaHost(key) }
        keysOnScreen = { [weak list] () -> [String] in list?.visibleKeys() ?? [] }
        screen.onScrub = { [weak self] (phase: String, share: CGFloat) -> Void in self?.scrub(phase, share) }
    }

    init(server: Server?, host: @escaping (String) -> (view: UIView, frame: CGRect)?, keys: @escaping () -> [String]) {
        self.server = server
        hostOf = host
        keysOnScreen = keys
        screen.onScrub = { [weak self] (phase: String, share: CGFloat) -> Void in self?.scrub(phase, share) }
    }

    /// The transform of the circle at `scale`, its lower corner on the message's side kept in place.
    private func anchored(_ scale: CGFloat, right: Bool) -> CGAffineTransform {
        let side = screen.bounds.width
        let shift = side * (1 - scale) / 2
        return CGAffineTransform(translationX: right ? shift : -shift, y: shift).scaledBy(x: scale, y: scale)
    }

    /// The slot of `rowKey` becomes large, and the circle grows into it from its small size.
    private func grow(_ rowKey: String) {
        shrinking?.stopAnimation(true)
        shrinking = nil
        guard expandedKey != rowKey, let small = hostOf(rowKey)?.frame.width, small > 0 else { return }
        expandedKey = rowKey
        onExpanded?(rowKey, true)
        guard let host = hostOf(rowKey), host.frame.width > 0 else { return }
        smallScale = min(1, small / host.frame.width)
        screen.transform = .identity
        screen.frame = host.frame
        guard smallScale < 1, Motion.enabled else { return }
        let right = anchorsRight?(rowKey) ?? true
        screen.transform = anchored(smallScale, right: right)
        let animator = UIViewPropertyAnimator(duration: 0.2, controlPoint1: CGPoint(x: 0.215, y: 0.61), controlPoint2: CGPoint(x: 0.355, y: 1)) { [weak self] in
            self?.screen.transform = .identity
        }
        animator.startAnimation()
    }

    /// The listen is over: the circle shrinks back, then the slot gives its room back. `animated` false: at once.
    private func shrink(animated: Bool) {
        let was = expandedKey
        guard !was.isEmpty else { return }
        screen.canScrub = false
        let finish: () -> Void = { [weak self] in
            guard let self, self.expandedKey == was else { return }
            self.expandedKey = ""
            self.screen.transform = .identity
            self.onExpanded?(was, false)
            if self.key == was, let host = self.hostOf(was) {
                if self.screen.superview !== host.view { host.view.addSubview(self.screen) }
                self.screen.frame = host.frame
            }
        }
        guard animated, Motion.enabled, smallScale < 1, screen.superview != nil else { finish(); return }
        let right = anchorsRight?(was) ?? true
        let target = anchored(smallScale, right: right)
        let animator = UIViewPropertyAnimator(duration: 0.2, controlPoint1: CGPoint(x: 0.215, y: 0.61), controlPoint2: CGPoint(x: 0.355, y: 1)) { [weak self] in
            self?.screen.transform = target
        }
        animator.addCompletion { (_: UIViewAnimatingPosition) -> Void in finish() }
        shrinking = animator
        animator.startAnimation()
    }

    /// A rewind along the ring (VideoNote.tsx `scrubBegin` / `scrubTo` / `scrubEnd`).
    private func scrub(_ phase: String, _ share: CGFloat) {
        guard sound, let player, let item = player.currentItem else { return }
        let total = CMTimeGetSeconds(item.duration)
        guard total.isFinite, total > 0 else { return }
        if phase == "begin" {
            resumeAfterScrub = player.rate != 0
            player.pause()
        }
        player.seek(to: CMTime(seconds: total * Double(share), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        if phase == "end" {
            if resumeAfterScrub { player.playImmediately(atRate: VoicePlayer.rate) }
            screen.show(progress: share, paused: !resumeAfterScrub)
        }
    }

    /// The length of a circle as its pill shows it at rest.
    private static func length(_ attachment: [String: Any]?) -> String {
        let ms = ((attachment?["media"] as? [String: Any])?["durationMs"] as? NSNumber)?.doubleValue ?? 0
        return FileCore.call("voiceTime", [ms]) as? String ?? "0:00"
    }

    deinit {
        drop()
        for (rowKey, file) in files {
            NotePlayback.readyKeys.remove(rowKey)
            try? FileManager.default.removeItem(at: file.folder)
        }
    }

    private func note(_ rowKey: String) -> [String: Any]? {
        guard let attachment = AttachmentStore.shared.attachment(rowKey) else { return nil }
        if let known = isNote[rowKey] { return known ? attachment : nil }
        var bare = attachment
        bare["preview"] = nil
        let yes = FileCore.call("mediaKind", [bare]) as? String == "note"
        if isNote.count > 2000 { isNote.removeAll() }
        isNote[rowKey] = yes
        return yes ? attachment : nil
    }

    private func drop() {
        shrink(animated: false)
        if let observer, let player { player.removeTimeObserver(observer) }
        observer = nil
        if let ended { NotificationCenter.default.removeObserver(ended) }
        ended = nil
        player?.pause()
        player = nil
        screen.player = nil
        screen.removeFromSuperview()
        key = ""
        sound = false
    }

    /// Starts the circle of `rowKey` in its row: silently looping, or from the start with sound.
    private func start(_ rowKey: String, file: URL, withSound: Bool) {
        drop()
        guard hostOf(rowKey) != nil else { return }
        if withSound { grow(rowKey) }
        guard let host = hostOf(rowKey) else { return }
        let made = AVPlayer(url: file)
        made.isMuted = !withSound
        player = made
        key = rowKey
        sound = withSound
        if screen.transform == .identity { screen.frame = host.frame }
        screen.player = made
        screen.canScrub = withSound
        screen.show(progress: 0, paused: false)
        // VideoNote.tsx: the seconds played while it is listened to, the length and the speaker-off mark while it loops.
        screen.showPill(withSound ? "0:00" : NotePlayback.length(AttachmentStore.shared.attachment(rowKey)), muted: !withSound)
        host.view.addSubview(screen)
        ended = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: made.currentItem, queue: .main) { [weak self] _ in self?.reachedEnd() }
        if withSound {
            onWillPlay?()
            if MusicPlayer.shared.current != nil { MusicPlayer.shared.stop() }
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .default, options: [])
            try? session.setActive(true)
            observer = made.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { [weak self] (time: CMTime) -> Void in
                guard let self, self.sound, let item = self.player?.currentItem else { return }
                let total = CMTimeGetSeconds(item.duration)
                let part = total.isFinite && total > 0 ? CMTimeGetSeconds(time) / total : 0
                self.screen.show(progress: CGFloat(part), paused: self.player?.rate == 0)
                // VideoNote.tsx `playedSeconds`: whole seconds, never past the length.
                let now = CMTimeGetSeconds(time)
                let played = max(0, floor(min(now.isFinite ? now : 0, total.isFinite && total > 0 ? total : now)))
                self.screen.showPill(FileCore.call("voiceTime", [played * 1000]) as? String ?? "0:00", muted: false)
            }
            made.playImmediately(atRate: VoicePlayer.rate)
        } else {
            // A silent loop must not stop what other apps play: the session mixes with them meanwhile.
            try? AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [.mixWithOthers])
            made.play()
        }
    }

    /// A take is about to be recorded: nothing moves meanwhile.
    func rest() {
        drop()
    }

    private func reachedEnd() {
        guard let player else { return }
        // After a listen, and at the end of every silent round: from the first frame again, without sound.
        if sound {
            if let observer { player.removeTimeObserver(observer) }
            observer = nil
            sound = false
            player.isMuted = true
            screen.show(progress: 0, paused: false)
            screen.showPill(NotePlayback.length(AttachmentStore.shared.attachment(key)), muted: true)
            shrink(animated: true)
        }
        player.seek(to: .zero)
        player.play()
    }

    /// A tap on a circle.
    func toggle(key rowKey: String, attachment: [String: Any]) {
        if rowKey == key, let player {
            if !sound {
                if let file = files[rowKey] { start(rowKey, file: file.file, withSound: true) }
            } else if player.rate == 0 {
                onWillPlay?()
                player.playImmediately(atRate: VoicePlayer.rate)
                screen.showPause(false)
            } else {
                player.pause()
                screen.showPause(true)
            }
            return
        }
        if let file = files[rowKey] {
            start(rowKey, file: file.file, withSound: true)
            return
        }
        if fetchKey == rowKey, fetch != nil {
            // VideoNote.tsx: a tap while it loads asks to play when ready; a second tap cancels the download.
            if fetchForSound {
                fetch?.cancel()
                fetch = nil
                fetchKey = ""
                fetchForSound = false
                onState?(nil)
            } else {
                fetchForSound = true
                publish(rowKey, percent: 0)
            }
            return
        }
        failed.remove(rowKey)
        bring(rowKey, attachment: attachment, forSound: true)
    }

    private func bring(_ rowKey: String, attachment: [String: Any], forSound: Bool) {
        guard let server else { return }
        fetch?.cancel()
        let made = MediaFetch()
        fetch = made
        fetchKey = rowKey
        fetchForSound = forSound
        if forSound { publish(rowKey, percent: 0) }
        made.start(server: server, attachment: attachment, progress: { [weak self] (part: Double) -> Void in
            guard let self, self.fetch === made, self.fetchForSound else { return }
            self.publish(rowKey, percent: Int(part * 100))
        }, done: { [weak self] (result: Result<MediaFetch.Brought, FileCore.Failure>) -> Void in
            guard let self, self.fetch === made else {
                if case .success(let brought) = result { try? FileManager.default.removeItem(at: brought.folder) }
                return
            }
            let wanted = self.fetchForSound
            self.fetch = nil
            self.fetchKey = ""
            self.onState?(nil)
            switch result {
            case .failure(let failure):
                self.failed.insert(rowKey)
                if wanted { self.onProblem?(failure.words) }
            case .success(let brought):
                if self.files.count >= 6, let old = self.files.keys.first(where: { $0 != rowKey && $0 != self.key }), let gone = self.files.removeValue(forKey: old) {
                    try? FileManager.default.removeItem(at: gone.folder)
                    NotePlayback.readyKeys.remove(old)
                    self.onReadyChanged?(old)
                }
                self.files[rowKey] = brought
                NotePlayback.readyKeys.insert(rowKey)
                self.onReadyChanged?(rowKey)
                if wanted { self.start(rowKey, file: brought.file, withSound: true) } else { self.refresh() }
            }
        })
    }

    private func publish(_ rowKey: String, percent: Int) {
        var state = MsgMediaState()
        state.key = rowKey
        state.loading = true
        state.progress = CGFloat(percent) / 100
        state.time = String(percent) + " %"
        onState?(state)
    }

    /// The rows on screen changed or moved: the playing circle follows its row or stops when the row is gone,
    /// and a circle that came into view starts its silent loop.
    func refresh() {
        guard server != nil else { return }
        if !key.isEmpty {
            if let host = hostOf(key) {
                if screen.superview !== host.view { host.view.addSubview(screen) }
                if screen.transform == .identity, screen.frame != host.frame { screen.frame = host.frame }
                return
            }
            drop()
        }
        if fetchForSound && fetch != nil { return }
        if holdsSilence?() == true || MusicPlayer.shared.current != nil { return }
        // Effects: «Автозапуск видео и кружков» off, or power saving — no silent loop (motionPolicy.ts).
        if !Motion.feature("video") { return }
        for rowKey in keysOnScreen() {
            guard let attachment = note(rowKey), hostOf(rowKey) != nil else { continue }
            if let file = files[rowKey] {
                start(rowKey, file: file.file, withSound: false)
                return
            }
            if fetch == nil, !failed.contains(rowKey), ((attachment["size"] as? NSNumber)?.intValue ?? Int.max) <= NotePlayback.unasked {
                bring(rowKey, attachment: attachment, forSound: false)
                return
            }
        }
    }

    /// Something else is about to sound: a circle that is listened to goes quiet.
    func quiet() {
        // playback.ts `interrupt`: a voice message, music or another circle took the sound — the circle goes back
        // to its silent loop from the first frame and shrinks.
        guard sound, let player else { return }
        if let observer { player.removeTimeObserver(observer) }
        observer = nil
        sound = false
        player.isMuted = true
        player.rate = 1
        screen.show(progress: 0, paused: false)
        screen.showPill(NotePlayback.length(AttachmentStore.shared.attachment(key)), muted: true)
        player.seek(to: .zero)
        player.play()
        shrink(animated: true)
    }

    /// The chat is left: everything stops, the decrypted copies go.
    func left() {
        fetch?.cancel()
        fetch = nil
        fetchKey = ""
        drop()
        onState?(nil)
        for (rowKey, file) in files {
            NotePlayback.readyKeys.remove(rowKey)
            try? FileManager.default.removeItem(at: file.folder)
        }
        files.removeAll()
    }
}
