import AVFoundation
import UIKit

/// The picture of a round video playing inside its row: the player's layer cut to a circle, the ring of a listen
/// around it and a play mark while it is paused. It takes no touches — a tap goes to the row under it.
final class NotePlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    private let ring = CAShapeLayer()
    private let mark = UIImageView(image: UIImage(systemName: "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 26, weight: .regular)))

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        (layer as? AVPlayerLayer)?.videoGravity = .resizeAspectFill
        ring.fillColor = UIColor.clear.cgColor
        ring.strokeColor = Theme.accent.cgColor
        ring.lineWidth = 3
        ring.lineCap = .round
        ring.strokeEnd = 0
        layer.addSublayer(ring)
        mark.tintColor = .white
        mark.contentMode = .center
        mark.backgroundColor = UIColor(white: 0, alpha: 0.45)
        mark.layer.cornerRadius = 26
        mark.clipsToBounds = true
        mark.isHidden = true
        addSubview(mark)
    }

    required init?(coder: NSCoder) { return nil }

    var player: AVPlayer? {
        get { (layer as? AVPlayerLayer)?.player }
        set { (layer as? AVPlayerLayer)?.player = newValue }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = min(bounds.width, bounds.height)
        layer.cornerRadius = side / 2
        ring.frame = bounds
        ring.path = UIBezierPath(arcCenter: CGPoint(x: bounds.midX, y: bounds.midY), radius: max(1, side / 2 - 1.5), startAngle: -CGFloat.pi / 2, endAngle: CGFloat.pi * 1.5, clockwise: true).cgPath
        mark.frame = CGRect(x: bounds.midX - 26, y: bounds.midY - 26, width: 52, height: 52)
    }

    /// Shows or hides the play mark without touching the ring.
    func showPause(_ paused: Bool) {
        mark.isHidden = !paused
    }

    func show(progress: CGFloat, paused: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.strokeEnd = min(1, max(0, progress))
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
    private weak var list: MsgListView?
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
        self.list = list
    }

    deinit {
        drop()
        for file in files.values { try? FileManager.default.removeItem(at: file.folder) }
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
        guard let host = list?.mediaHost(rowKey) else { return }
        let made = AVPlayer(url: file)
        made.isMuted = !withSound
        player = made
        key = rowKey
        sound = withSound
        screen.frame = host.frame
        screen.player = made
        screen.show(progress: 0, paused: false)
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
            fetchForSound = true
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
                }
                self.files[rowKey] = brought
                if wanted { self.start(rowKey, file: brought.file, withSound: true) } else { self.refresh() }
            }
        })
    }

    private func publish(_ rowKey: String, percent: Int) {
        var state = MsgMediaState()
        state.key = rowKey
        state.loading = true
        state.time = String(percent) + " %"
        onState?(state)
    }

    /// The rows on screen changed or moved: the playing circle follows its row or stops when the row is gone,
    /// and a circle that came into view starts its silent loop.
    func refresh() {
        guard let list, server != nil else { return }
        if !key.isEmpty {
            if let host = list.mediaHost(key) {
                if screen.superview !== host.view { host.view.addSubview(screen) }
                if screen.frame != host.frame { screen.frame = host.frame }
                return
            }
            drop()
        }
        if fetchForSound && fetch != nil { return }
        if holdsSilence?() == true || MusicPlayer.shared.current != nil { return }
        // Effects: «Автозапуск видео и кружков» off, or power saving — no silent loop (motionPolicy.ts).
        if !Motion.feature("video") { return }
        for rowKey in list.visibleKeys() {
            guard let attachment = note(rowKey), list.mediaHost(rowKey) != nil else { continue }
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
        guard sound, let player, player.rate != 0 else { return }
        player.pause()
        screen.showPause(true)
    }

    /// The chat is left: everything stops, the decrypted copies go.
    func left() {
        fetch?.cancel()
        fetch = nil
        fetchKey = ""
        drop()
        onState?(nil)
        for file in files.values { try? FileManager.default.removeItem(at: file.folder) }
        files.removeAll()
    }
}
