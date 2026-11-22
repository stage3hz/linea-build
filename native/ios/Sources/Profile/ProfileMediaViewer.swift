import AVFoundation
import UIKit

/// A profile's photo and video full screen (the reference's ProfileMediaViewer.tsx): swipe sideways between them,
/// «1 из 2» at the top with bars, swipe up or down to close, pinch or double-tap a photo to zoom (paging and closing
/// pause while it is zoomed), a tap hides the top. The video avatar plays with its sound here, in a loop.
final class ProfileMediaViewer: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    struct Item { let video: Bool; let id: String }

    /// What a person has to show: the video avatar first, then the photo.
    static func items(_ person: Person) -> [Item] {
        var made: [Item] = []
        if !person.look.avatarVideoId.isEmpty { made.append(Item(video: true, id: person.look.avatarVideoId)) }
        if !person.avatarId.isEmpty { made.append(Item(video: false, id: person.avatarId)) }
        return made
    }

    private let person: Person
    private let base: String
    private let items: [Item]
    private var index: Int
    private let pager = UIScrollView()
    private var pages: [UIView] = []
    private var zooms: [UIScrollView?] = []
    private var players: [AVPlayer?] = []
    private var loopers: [AVPlayerLooper?] = []
    private let chrome = UIView()
    private let nameLabel = UILabel()
    private let countLabel = UILabel()
    private let bars = UIStackView()
    private let backdrop = UIView()
    /// A sample picture for the simulator check (no server to ask).
    var samplePicture: UIImage?

    init(person: Person, base: String, start: Int = 0) {
        self.person = person
        self.base = base
        items = ProfileMediaViewer.items(person)
        index = max(0, min(start, items.count - 1))
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        for player in players { player?.pause() }
        NotificationCenter.default.removeObserver(self)
    }

    override var prefersStatusBarHidden: Bool { return false }
    override var preferredStatusBarStyle: UIStatusBarStyle { return .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.overrideUserInterfaceStyle = .dark
        backdrop.backgroundColor = .black
        view.addSubview(backdrop)
        pager.isPagingEnabled = true
        pager.showsHorizontalScrollIndicator = false
        pager.delegate = self
        pager.contentInsetAdjustmentBehavior = .never
        view.addSubview(pager)
        for item in items {
            let page = UIView()
            if item.video {
                let layerView = PlayerLayerView()
                page.addSubview(layerView)
                if let file = AvatarMedia.shared.video(id: item.id, base: base) {
                    let player = AVQueuePlayer()
                    loopers.append(AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: file)))
                    layerView.playerLayer.player = player
                    players.append(player)
                } else {
                    players.append(nil)
                    loopers.append(nil)
                }
                zooms.append(nil)
            } else {
                let zoom = UIScrollView()
                zoom.minimumZoomScale = 1
                zoom.maximumZoomScale = 4
                zoom.delegate = self
                zoom.showsVerticalScrollIndicator = false
                zoom.showsHorizontalScrollIndicator = false
                let image = UIImageView()
                image.contentMode = .scaleAspectFit
                image.image = samplePicture ?? AvatarMedia.shared.image(id: item.id, base: base, pixels: 2048, animated: true)
                image.isAccessibilityElement = true
                image.accessibilityLabel = person.displayName
                zoom.addSubview(image)
                let double = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
                double.numberOfTapsRequired = 2
                zoom.addGestureRecognizer(double)
                page.addSubview(zoom)
                zooms.append(zoom)
                players.append(nil)
                loopers.append(nil)
            }
            pager.addSubview(page)
            pages.append(page)
        }
        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleChrome))
        view.addGestureRecognizer(tap)
        let pull = UIPanGestureRecognizer(target: self, action: #selector(pulled(_:)))
        pull.delegate = self
        view.addGestureRecognizer(pull)

        let back = UIButton(type: .system)
        back.setImage(BackChevronGlyph.image(size: 24), for: .normal) // «chevron-back» 24
        back.tintColor = .white
        back.backgroundColor = UIColor(white: 1, alpha: 0.12)
        back.layer.cornerRadius = 22
        back.accessibilityLabel = "Закрыть"
        back.addTarget(self, action: #selector(close), for: .touchUpInside)
        back.frame = CGRect(x: 12, y: 0, width: 44, height: 44)
        chrome.addSubview(back)
        nameLabel.text = person.displayName
        nameLabel.font = .systemFont(ofSize: 16, weight: .bold)
        nameLabel.textColor = .white
        nameLabel.textAlignment = .center
        chrome.addSubview(nameLabel)
        countLabel.font = .systemFont(ofSize: 13)
        countLabel.textColor = UIColor(white: 1, alpha: 0.7)
        countLabel.textAlignment = .center
        chrome.addSubview(countLabel)
        bars.axis = .horizontal
        bars.spacing = 4
        bars.distribution = .fillEqually
        if items.count > 1 {
            for _ in items {
                let bar = UIView()
                bar.layer.cornerRadius = 1.5
                bars.addArrangedSubview(bar)
            }
        }
        chrome.addSubview(bars)
        view.addSubview(chrome)
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: AvatarMedia.ready, object: nil)
        showIndex()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = view.bounds.size
        backdrop.frame = view.bounds
        pager.frame = view.bounds
        pager.contentSize = CGSize(width: size.width * CGFloat(items.count), height: size.height)
        for (position, page) in pages.enumerated() {
            page.frame = CGRect(x: CGFloat(position) * size.width, y: 0, width: size.width, height: size.height)
            if let zoom = zooms[position] {
                zoom.frame = page.bounds
                if zoom.zoomScale == 1 { zoom.subviews.first?.frame = zoom.bounds }
            } else {
                page.subviews.first?.frame = CGRect(x: 0, y: (size.height - size.width) / 2, width: size.width, height: size.width)
            }
        }
        pager.contentOffset = CGPoint(x: CGFloat(index) * size.width, y: 0)
        let top = view.safeAreaInsets.top + 8
        chrome.frame = CGRect(x: 0, y: top, width: size.width, height: 60)
        nameLabel.frame = CGRect(x: 60, y: 2, width: size.width - 120, height: 20)
        countLabel.frame = CGRect(x: 60, y: 22, width: size.width - 120, height: 18)
        bars.frame = CGRect(x: 12, y: 52, width: size.width - 24, height: 3)
    }

    private func showIndex() {
        countLabel.text = items.count > 1 ? "\(index + 1) из \(items.count)" : ""
        for (position, bar) in bars.arrangedSubviews.enumerated() { bar.backgroundColor = position == index ? .white : UIColor(white: 1, alpha: 0.35) }
        for (position, player) in players.enumerated() {
            if position == index { player?.play() } else { player?.pause() }
        }
    }

    @objc private func arrived(_ note: Notification) {
        guard let key = note.object as? String else { return }
        for (position, item) in items.enumerated() where item.id == key && !item.video {
            (zooms[position]?.subviews.first as? UIImageView)?.image = AvatarMedia.shared.image(id: key, base: base, pixels: 2048, animated: true)
        }
    }

    private var zoomed: Bool { return (zooms[index]?.zoomScale ?? 1) > 1.01 }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        guard scrollView === pager, view.bounds.width > 0 else { return }
        index = max(0, min(items.count - 1, Int((scrollView.contentOffset.x / view.bounds.width).rounded())))
        showIndex()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        return scrollView === pager ? nil : scrollView.subviews.first
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        pager.isScrollEnabled = scrollView.zoomScale <= 1.01
    }

    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        guard let zoom = gesture.view as? UIScrollView else { return }
        if zoom.zoomScale > 1.01 { zoom.setZoomScale(1, animated: true); return }
        let point = gesture.location(in: zoom.subviews.first)
        let side = zoom.bounds.width / 2.5
        zoom.zoom(to: CGRect(x: point.x - side / 2, y: point.y - side / 2, width: side, height: side), animated: true)
    }

    @objc private func toggleChrome() {
        UIView.animate(withDuration: 0.2) { self.chrome.alpha = self.chrome.alpha > 0.5 ? 0 : 1 }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer, !zoomed else { return false }
        let speed = pan.velocity(in: view)
        return abs(speed.y) > abs(speed.x) * 1.5
    }

    /// Swipe up or down: the page follows, the black fades; far or fast enough it closes.
    @objc private func pulled(_ gesture: UIPanGestureRecognizer) {
        let moved = gesture.translation(in: view).y
        let progress = min(1, abs(moved) / max(1, view.bounds.height / 2))
        switch gesture.state {
        case .changed:
            pager.transform = CGAffineTransform(translationX: 0, y: moved)
            backdrop.alpha = 1 - progress
            chrome.alpha = 1 - progress
        case .ended, .cancelled:
            let fast = abs(gesture.velocity(in: view).y) > 900
            if progress > 0.3 || fast {
                UIView.animate(withDuration: 0.2, animations: {
                    self.pager.transform = CGAffineTransform(translationX: 0, y: moved > 0 ? self.view.bounds.height : -self.view.bounds.height)
                    self.backdrop.alpha = 0
                }, completion: { (_: Bool) -> Void in self.dismiss(animated: false, completion: nil) })
            } else {
                UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0, options: [], animations: {
                    self.pager.transform = .identity
                    self.backdrop.alpha = 1
                    self.chrome.alpha = 1
                }, completion: nil)
            }
        default:
            break
        }
    }

    @objc private func close() { dismiss(animated: true, completion: nil) }
}

/// A view whose layer plays a video (fit inside, sound on).
final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { return AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { return layer as! AVPlayerLayer }
}
