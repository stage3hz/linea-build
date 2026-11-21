import AVFoundation
import UIKit

// The pictures and videos of stories and posts. They are plain files of the server (not end-to-end encrypted, as
// in the reference), so they come through the app's loader of plain files (Channels/ChannelsNet.swift:
// `ChannelImages` and `ChannelFiles`): downloaded as this session into the cache folder and decoded OFF the main
// queue straight at the size they are shown at. Nothing here decodes a picture on the main queue.

/// The ring around an avatar: lit while there is something to watch, grey once everything was watched.
/// The light comes from the person's own colour (the same pair their avatar is lit with).
final class StoryRingView: UIView {
    private let gradient = CAGradientLayer()
    private let shape = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        gradient.startPoint = CGPoint(x: 0, y: 1)
        gradient.endPoint = CGPoint(x: 1, y: 0)
        shape.fillColor = UIColor.clear.cgColor
        shape.strokeColor = UIColor.black.cgColor
        shape.lineWidth = 3
        gradient.mask = shape
        layer.addSublayer(gradient)
    }

    required init?(coder: NSCoder) { return nil }

    /// `color`: the person's colour, 0xRRGGBB. `fresh`: something new to look at.
    func show(color: UInt32, fresh: Bool) {
        if fresh {
            let pair = orbPair(color)
            let light = UIColor(hex: UInt32(truncatingIfNeeded: pair.light) & 0xFFFFFF)
            let deep = UIColor(hex: UInt32(truncatingIfNeeded: pair.deep) & 0xFFFFFF)
            gradient.colors = [light.cgColor, UIColor(hex: color).cgColor, deep.cgColor]
        } else {
            let grey = Theme.dark ? UIColor(red: 171 / 255, green: 188 / 255, blue: 214 / 255, alpha: 0.45) : UIColor(red: 92 / 255, green: 110 / 255, blue: 136 / 255, alpha: 0.4)
            gradient.colors = [grey.cgColor, grey.cgColor]
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.frame = bounds
        shape.frame = bounds
        shape.path = UIBezierPath(ovalIn: bounds.insetBy(dx: 1.5, dy: 1.5)).cgPath
        CATransaction.commit()
    }
}

/// The first frames of videos, for the tiles of a profile. A frame is cut off the main queue from the video's
/// file in the cache folder (downloaded when it is not there yet) and kept in memory under a limit.
final class StoryVideoFrames {
    static let shared = StoryVideoFrames()
    /// Posted on the main queue when a frame has arrived (or failed): `object` is the file's id.
    static let ready = Notification.Name("invizent.story-frame")

    private let memory = NSCache<NSString, UIImage>()
    private var loading = Set<String>()
    private var failedAt: [String: Date] = [:]
    private let work: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 2
        queue.qualityOfService = .utility
        return queue
    }()

    private init() {
        memory.totalCostLimit = 24 * 1024 * 1024
    }

    /// Where a video's file is kept.
    static func bring(_ server: Server, id: String) -> URL? {
        return ChannelFiles.bring(server, id: id, name: "video.mp4")
    }

    /// Main queue only. Nil while the frame is not here — `ready` is posted when it is.
    func image(id: String) -> UIImage? {
        guard !id.isEmpty else { return nil }
        if let hit = memory.object(forKey: id as NSString) { return hit }
        if loading.contains(id) { return nil }
        if let at = failedAt[id], Date().timeIntervalSince(at) < 60 { return nil }
        guard let server = ChannelImages.shared.server else { return nil }
        loading.insert(id)
        work.addOperation { [weak self] in
            var made: UIImage? = nil
            if let file = StoryVideoFrames.bring(server, id: id) {
                let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
                generator.appliesPreferredTrackTransform = true
                generator.maximumSize = CGSize(width: 640, height: 640)
                if let frame = try? generator.copyCGImage(at: .zero, actualTime: nil) { made = UIImage(cgImage: frame) }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.loading.remove(id)
                if let made {
                    let cost = (made.cgImage?.bytesPerRow ?? 0) * (made.cgImage?.height ?? 0)
                    self.memory.setObject(made, forKey: id as NSString, cost: max(1, cost))
                    self.failedAt[id] = nil
                } else {
                    self.failedAt[id] = Date()
                }
                NotificationCenter.default.post(name: StoryVideoFrames.ready, object: id)
            }
        }
        return nil
    }

    #if targetEnvironment(simulator)
    /// For the simulator's samples: a frame that is simply there.
    func putSample(_ image: UIImage, id: String) {
        memory.setObject(image, forKey: id as NSString, cost: 1)
    }
    #endif
}

/// Shows the picture of a post (or the first frame of its video). Asks the loaders and waits for their word;
/// the picture is decoded before it gets here.
final class StoryPictureView: UIImageView {
    private var wantedId = ""
    private var wantedPixels = 0
    private var wantsFrame = false
    /// The picture did not come (no connection, not a picture).
    private(set) var gaveUp = false
    /// Called on the main queue when the picture is shown or has given up.
    var onSettled: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: ChannelImages.ready, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: StoryVideoFrames.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    var settled: Bool { image != nil || gaveUp || wantedId.isEmpty }

    /// `pixels`: the longer side it is shown at, in pixels of the screen.
    func show(_ post: StoryPost?, pixels: Int) {
        let id = post?.mediaId ?? ""
        let ofVideo = post?.isVideo ?? false
        if id == wantedId && pixels == wantedPixels && ofVideo == wantsFrame && image != nil { return }
        wantedId = id
        wantedPixels = pixels
        wantsFrame = ofVideo
        gaveUp = false
        image = nil
        _ = load()
    }

    private func load() -> Bool {
        guard !wantedId.isEmpty else { return false }
        let found = wantsFrame ? StoryVideoFrames.shared.image(id: wantedId) : ChannelImages.shared.image(id: wantedId, pixels: wantedPixels)
        guard let found else { return false }
        image = found
        return true
    }

    @objc private func arrived(_ note: Notification) {
        guard let id = note.object as? String, id == wantedId, !id.isEmpty, image == nil else { return }
        if !load() {
            // The same file finished at another size: this size is still on its way, and its own word will come.
            if !wantsFrame && ChannelImages.shared.waiting(id: id, pixels: wantedPixels) { return }
            gaveUp = true
        }
        onSettled?()
    }
}

/// A video of a story or a post on the screen. The file is brought into the cache folder off the main queue and
/// played from there.
final class StoryVideoView: UIView {
    private var player: AVPlayer?
    private var wantedId = ""
    private var wantsPlay = false
    private var ended: NSObjectProtocol?
    private var broke: NSObjectProtocol?
    private var statusWatch: NSKeyValueObservation?
    /// The video could not be brought or played.
    private(set) var gaveUp = false
    var onEnded: (() -> Void)?
    /// Ready to play, or given up.
    var onSettled: (() -> Void)?

    override class var layerClass: AnyClass { return AVPlayerLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        (layer as? AVPlayerLayer)?.videoGravity = .resizeAspect
    }

    required init?(coder: NSCoder) { return nil }

    deinit { forget() }

    var ready: Bool { player != nil }

    /// 0 … 1: how much of the video has played.
    var played: Double {
        guard let player, let item = player.currentItem else { return 0 }
        let total = CMTimeGetSeconds(item.duration)
        guard total.isFinite, total > 0 else { return 0 }
        return min(1, max(0, CMTimeGetSeconds(player.currentTime()) / total))
    }

    private func forget() {
        if let ended { NotificationCenter.default.removeObserver(ended) }
        if let broke { NotificationCenter.default.removeObserver(broke) }
        ended = nil
        broke = nil
        statusWatch?.invalidate()
        statusWatch = nil
        player?.pause()
        player = nil
        (layer as? AVPlayerLayer)?.player = nil
    }

    /// Shows the video with this file id (empty: nothing). `loop`: a post's video starts over at its end.
    func show(id: String, loop: Bool) {
        if id == wantedId { return }
        forget()
        wantedId = id
        gaveUp = false
        guard !id.isEmpty else { return }
        guard let server = ChannelImages.shared.server else {
            gaveUp = true
            onSettled?()
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let file = StoryVideoFrames.bring(server, id: id)
            DispatchQueue.main.async {
                guard let self, self.wantedId == id else { return }
                guard let file else {
                    self.gaveUp = true
                    self.onSettled?()
                    return
                }
                self.begin(file, loop: loop)
            }
        }
    }

    private func begin(_ file: URL, loop: Bool) {
        let item = AVPlayerItem(url: file)
        let made = AVPlayer(playerItem: item)
        made.actionAtItemEnd = .pause
        player = made
        (layer as? AVPlayerLayer)?.player = made
        ended = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] (_: Notification) -> Void in
            guard let self else { return }
            if loop {
                self.player?.seek(to: .zero)
                if self.wantsPlay { self.player?.play() }
            } else {
                self.onEnded?()
            }
        }
        broke = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] (_: Notification) -> Void in
            guard let self else { return }
            self.gaveUp = true
            self.onSettled?()
        }
        // A file that is not a video the system can play never starts: it says so here.
        statusWatch = item.observe(\.status, options: [.new]) { [weak self] (watched: AVPlayerItem, _: NSKeyValueObservedChange<AVPlayerItem.Status>) -> Void in
            guard watched.status == .failed else { return }
            DispatchQueue.main.async {
                guard let self, !self.gaveUp else { return }
                self.gaveUp = true
                self.onSettled?()
            }
        }
        if wantsPlay { made.play() }
        onSettled?()
    }

    /// Plays or pauses (a pause keeps the place).
    func setPlaying(_ on: Bool) {
        wantsPlay = on
        if on { player?.play() } else { player?.pause() }
    }
}
