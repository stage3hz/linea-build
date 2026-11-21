import AVFoundation
import UIKit

/// The round face of a person: their picture, or their colour as a lit ball with their initials (as in the chat
/// list). `pixels`: how sharp the picture is asked; `animated`: a GIF avatar moves.
final class AvatarFaceView: UIView {
    private let orb = CAGradientLayer()
    private let letters = UILabel()
    private let picture = UIImageView()
    private var pictureId = ""
    private var base = ""
    private var animated = false
    private var askedPixels = 0
    /// A picture given directly (the simulator's samples, a photo just chosen): shown instead of the person's.
    var overridePicture: UIImage? {
        didSet { load() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        isUserInteractionEnabled = false
        orb.startPoint = CGPoint(x: 0.9, y: 1)
        orb.endPoint = CGPoint(x: 0.1, y: 0)
        layer.addSublayer(orb)
        letters.textColor = .white
        letters.textAlignment = .center
        letters.adjustsFontSizeToFitWidth = true
        letters.minimumScaleFactor = 0.5
        addSubview(letters)
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.isHidden = true
        addSubview(picture)
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: AvatarMedia.ready, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: ChatAvatarStore.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    func show(_ person: Person, base: String, animated: Bool) {
        let pair = orbPair(person.avatarColor)
        let light = UIColor(hex: UInt32(truncatingIfNeeded: pair.light) & 0xFFFFFF)
        let deep = UIColor(hex: UInt32(truncatingIfNeeded: pair.deep) & 0xFFFFFF)
        orb.colors = [deep.cgColor, UIColor(hex: person.avatarColor).cgColor, light.cgColor]
        letters.text = String(Messenger.initials(person.displayName).prefix(2))
        pictureId = person.avatarId
        self.base = base
        self.animated = animated
        load()
    }

    private func load() {
        if let overridePicture {
            picture.image = overridePicture
            picture.isHidden = false
            return
        }
        var image: UIImage? = nil
        if !pictureId.isEmpty && !base.isEmpty {
            let pixels = wantedPixels
            askedPixels = pixels
            if pixels <= 180 && !animated {
                // List sizes: the chat list's own store (its 180 px copy is the same picture, already decoded).
                image = ChatAvatarStore.shared.image(key: pictureId, url: AvatarMedia.address(base: base, id: pictureId))
            } else {
                // Effects: a GIF avatar moves only with «Автозапуск GIF» on and no power saving (motionPolicy.ts).
                image = AvatarMedia.shared.image(id: pictureId, base: base, pixels: max(240, pixels), animated: animated && Motion.feature("gif"))
            }
        }
        picture.image = image
        picture.isHidden = image == nil
        if image?.images != nil && animated && Motion.feature("gif") { picture.startAnimating() }
    }

    private var wantedPixels: Int { return Int(max(bounds.width, 54) * UIScreen.main.scale) }

    @objc private func arrived(_ note: Notification) {
        guard let key = note.object as? String, !pictureId.isEmpty, key == pictureId else { return }
        load()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let wasSmall = letters.font.pointSize
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        orb.frame = bounds
        CATransaction.commit()
        picture.frame = bounds
        letters.frame = bounds.insetBy(dx: bounds.width * 0.12, dy: 0)
        let size = max(8, bounds.width * 0.36)
        if abs(wasSmall - size) > 0.5 { letters.font = .systemFont(ofSize: size, weight: .bold) }
        layer.cornerRadius = min(bounds.width, bounds.height) / 2
        // Laid out at another size than the picture was asked for (a profile's avatar before its first layout).
        if overridePicture == nil && !pictureId.isEmpty && wantedPixels != askedPixels { load() }
    }
}

/// A silent looping video (the video avatar, a video banner): played from a local file without its sound track,
/// so it never takes the phone's audio from music or another app (the reference plays them «mixWithOthers»).
final class LoopVideoView: UIView {
    override class var layerClass: AnyClass { return AVPlayerLayer.self }
    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private(set) var file: URL?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        (layer as? AVPlayerLayer)?.videoGravity = .resizeAspectFill
        NotificationCenter.default.addObserver(self, selector: #selector(back), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        NotificationCenter.default.removeObserver(self)
        player?.pause()
    }

    /// Plays `file` in a loop (nil stops and clears).
    func play(_ next: URL?) {
        guard next != file else { return }
        file = next
        player?.pause()
        looper = nil
        player = nil
        (layer as? AVPlayerLayer)?.player = nil
        guard let next else { return }
        let asset = AVURLAsset(url: next)
        // Only the picture: a composition without the sound track.
        let composition = AVMutableComposition()
        guard let track = asset.tracks(withMediaType: .video).first,
              let target = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { return }
        do {
            try target.insertTimeRange(CMTimeRange(start: .zero, duration: asset.duration), of: track, at: .zero)
        } catch {
            return
        }
        target.preferredTransform = track.preferredTransform
        let item = AVPlayerItem(asset: composition)
        let made = AVQueuePlayer()
        made.isMuted = true
        made.preventsDisplaySleepDuringVideoPlayback = false
        looper = AVPlayerLooper(player: made, templateItem: item)
        player = made
        (layer as? AVPlayerLayer)?.player = made
        made.play()
    }

    @objc private func back() { player?.play() }
}

/// A gradient ring that slowly turns (Decor.tsx `Spin`): a square gradient 1.5× the box, turning once in 5.2 s,
/// seen through a round window.
final class SpinRingView: UIView {
    private let gradient = CAGradientLayer()
    private var spinning = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        layer.addSublayer(gradient)
        NotificationCenter.default.addObserver(self, selector: #selector(back), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    func set(colors: [String], spinning: Bool) {
        gradient.colors = colors.map { lookColor($0).cgColor }
        self.spinning = spinning
        restart()
    }

    private func restart() {
        gradient.removeAnimation(forKey: "spin")
        guard spinning else {
            gradient.setAffineTransform(.identity)
            return
        }
        let turn = CABasicAnimation(keyPath: "transform.rotation.z")
        turn.fromValue = 0
        turn.toValue = Double.pi * 2
        turn.duration = 5.2
        turn.repeatCount = .infinity
        turn.isRemovedOnCompletion = false
        gradient.add(turn, forKey: "spin")
    }

    @objc private func back() { if spinning { restart() } }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil && spinning && gradient.animation(forKey: "spin") == nil { restart() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = bounds.width
        let big = side * 1.5
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.bounds = CGRect(x: 0, y: 0, width: big, height: big)
        gradient.position = CGPoint(x: bounds.midX, y: bounds.midY)
        CATransaction.commit()
        layer.cornerRadius = side / 2
    }
}

/// A person's avatar with their Platina decoration (Decor.tsx `DecoratedAvatar`): the turning ring, a frame drawn
/// in code, or painted art around the photo; on their birthday a festive ring and a 🎂; the silent video avatar.
/// The view's own bounds are the avatar's size — rings of list sizes are drawn inside, everything else reaches
/// outside (so rows keep their layout). Round always (the owner's rule). See the API notes in AvatarLook.swift.
final class DecoratedAvatarView: UIView {
    private let face = AvatarFaceView()
    private let video = LoopVideoView()
    private let ring = SpinRingView()
    private let ringHole = UIView()
    private var codeFrame: CodeFrameView?
    private var art: DecorationArtView?
    private let cake = UILabel()
    private let cakeHolder = UIView()

    private(set) var person = Person(id: "", username: "", displayName: "", bio: "", birthday: "", avatarColor: 0x5E7BFF, avatarId: "")
    private(set) var look = PersonLook()
    private var base = ""
    private var animated = false
    /// The colour of the gap between a ring and the photo (the page behind; Theme.bg by default).
    var ringBackground: UIColor = Theme.bg {
        didSet { ringHole.backgroundColor = ringBackground; cakeHolder.backgroundColor = ringBackground }
    }
    /// A picture given directly (the simulator's samples, a photo just chosen).
    var overridePicture: UIImage? {
        get { return face.overridePicture }
        set { face.overridePicture = newValue }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = false
        isUserInteractionEnabled = false
        addSubview(ring)
        ringHole.isUserInteractionEnabled = false
        ringHole.backgroundColor = ringBackground
        addSubview(ringHole)
        addSubview(face)
        video.clipsToBounds = true
        video.isHidden = true
        addSubview(video)
        cakeHolder.isUserInteractionEnabled = false
        cakeHolder.backgroundColor = ringBackground
        cakeHolder.isAccessibilityElement = true
        cakeHolder.accessibilityLabel = "День рождения"
        cake.text = "🎂"
        cake.textAlignment = .center
        cakeHolder.addSubview(cake)
        addSubview(cakeHolder)
        NotificationCenter.default.addObserver(self, selector: #selector(mediaArrived(_:)), name: AvatarMedia.ready, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(motionChanged), name: Motion.changed, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// `base`: the server the pictures are asked from (`messenger.server.endpoint`; empty: none asked).
    /// `animated`: motion and the video avatar (profiles, the chat header); false in lists.
    func show(_ person: Person, look: PersonLook, base: String, animated: Bool) {
        self.person = person
        self.look = look
        self.base = base
        self.animated = animated
        accessibilityLabel = person.displayName
        rebuild()
    }

    /// Frames, art and sweeps move: `animated` and the app's animations are on.
    private var live: Bool { return animated && Motion.enabled }

    @objc private func motionChanged() { rebuild() }

    @objc private func mediaArrived(_ note: Notification) {
        guard let key = note.object as? String, !look.avatarVideoId.isEmpty, key == look.avatarVideoId else { return }
        refreshVideo()
    }

    private func rebuild() {
        let birthday = look.birthdayToday
        let coded = !birthday && AvatarCatalog.isCodeFrame(look.avatarFrame) ? look.avatarFrame : ""
        let decoration = birthday ? nil : AvatarCatalog.decoration(look.avatarFrame)
        let ringColors = coded.isEmpty && decoration == nil ? AvatarCatalog.ringColors(look) : nil

        if !coded.isEmpty {
            if codeFrame?.frameId != coded {
                codeFrame?.removeFromSuperview()
                let made = CodeFrameView(frameId: coded)
                addSubview(made)
                codeFrame = made
            }
        } else {
            codeFrame?.removeFromSuperview()
            codeFrame = nil
        }
        if let decoration {
            if art?.decoration.id != decoration.id {
                art?.removeFromSuperview()
                let made = DecorationArtView(decoration: decoration)
                addSubview(made)
                art = made
            }
        } else {
            art?.removeFromSuperview()
            art = nil
        }
        ring.isHidden = ringColors == nil
        ringHole.isHidden = ringColors == nil
        if let ringColors { ring.set(colors: ringColors, spinning: live) }
        cakeHolder.isHidden = !(birthday && ringColors != nil)
        face.show(person, base: base, animated: animated)
        codeFrame?.live = live
        art?.live = live
        refreshVideo()
        setNeedsLayout()
    }

    private func refreshVideo() {
        // On a slow link a looping video would eat what messages need; with power saving it stays the photo.
        let allowed = live && Motion.feature("video") && NetQuality.shared.tier == "fast" && !look.avatarVideoId.isEmpty
        let file = allowed ? AvatarMedia.shared.video(id: look.avatarVideoId, base: base) : nil
        video.play(file)
        video.isHidden = file == nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = min(bounds.width, bounds.height)
        guard size > 0 else { return }
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        func box(_ side: CGFloat) -> CGRect { return CGRect(x: center.x - side / 2, y: center.y - side / 2, width: side, height: side) }
        var faceSide = size
        if let art {
            // Small (list) sizes: the art reaches at most 1.3× the box; the photo shrinks inside to fill the opening.
            let scale = art.decoration.scale
            faceSide = size < 64 && scale > 1.3 ? (size * 1.3 / scale).rounded() : size
            art.frame = box(faceSide * scale)
        }
        if let codeFrame { codeFrame.frame = box(size * AvatarCatalog.codeFrameScale) }
        if !ring.isHidden {
            let ringWidth = max(2, (size * 0.045).rounded()), gap = max(1.5, (size * 0.035).rounded())
            if size < 64 {
                // Inside the same box: a framed avatar keeps the column of plain ones.
                ring.frame = box(size)
                ringHole.frame = box(size - 2 * ringWidth)
                faceSide = size - 2 * (ringWidth + gap)
                let badge = max(16, size * 0.34)
                cakeHolder.frame = CGRect(x: bounds.maxX + 2 - badge, y: bounds.maxY + 2 - badge, width: badge, height: badge)
            } else {
                let outer = size + 2 * (ringWidth + gap)
                ring.frame = box(outer)
                ringHole.frame = box(size + 2 * gap)
                let badge = max(16, size * 0.34)
                let outerBox = box(outer)
                cakeHolder.frame = CGRect(x: outerBox.maxX - badge, y: outerBox.maxY - badge, width: badge, height: badge)
            }
            ringHole.layer.cornerRadius = ringHole.bounds.width / 2
            cakeHolder.layer.cornerRadius = cakeHolder.bounds.width / 2
            cake.frame = cakeHolder.bounds
            cake.font = .systemFont(ofSize: max(10, size * 0.22))
        }
        face.frame = box(faceSide)
        video.frame = face.frame
        video.layer.cornerRadius = faceSide / 2
    }

    /// Everything the art covers, for hit tests of a button around the avatar.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        return bounds.insetBy(dx: -bounds.width * 0.15, dy: -bounds.height * 0.15).contains(point)
    }
}
