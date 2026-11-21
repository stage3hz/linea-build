import UIKit

// The viewer of stories and posts on the whole screen (the reference's `PostViewer` in ProfilePosts.tsx).
// Stories play in turn — five seconds a photo, a video to its end — with bars on top. A tap on the right is the
// next one, on the left third the previous; a swipe left / right does the same and, past the edge, moves to the
// next / previous person; a swipe down closes; a swipe up is the answer (the owner: who watched); holding pauses
// and hides everything but the picture. What a finished drag means, where the page is while it is dragged and
// the words are the core's (`stories…` by name).

/// Lets touches through where it has nothing of its own.
final class StoryPassView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}

/// The thin bars on top: one a story, the current one filling up.
final class StoryBarsView: UIView {
    private var tracks: [UIView] = []
    private var fills: [UIView] = []
    private var current = 0
    private var filled: Double = 0

    func setCount(_ count: Int) {
        if count == tracks.count { return }
        for track in tracks { track.removeFromSuperview() }
        tracks = []
        fills = []
        for _ in 0..<max(0, count) {
            let track = UIView()
            track.backgroundColor = UIColor(white: 1, alpha: 0.3)
            track.layer.cornerRadius = 1.5
            track.clipsToBounds = true
            let fill = UIView()
            fill.backgroundColor = .white
            track.addSubview(fill)
            addSubview(track)
            tracks.append(track)
            fills.append(fill)
        }
        setNeedsLayout()
    }

    /// The bars before `index` are full, the one at `index` is filled to `progress` (0 … 1).
    func set(index: Int, progress: Double) {
        current = index
        filled = min(1, max(0, progress))
        place()
    }

    private func place() {
        for (position, fill) in fills.enumerated() {
            let whole = tracks[position].bounds
            let part: CGFloat = position < current ? 1 : (position == current ? CGFloat(filled) : 0)
            fill.frame = CGRect(x: 0, y: 0, width: whole.width * part, height: whole.height)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let count = CGFloat(tracks.count)
        guard count > 0 else { return }
        // Many stories: the gaps give way before the bars vanish.
        let gap: CGFloat = count > 30 ? 2 : 4
        let width = max(1, (bounds.width - gap * (count - 1)) / count)
        for (position, track) in tracks.enumerated() {
            track.frame = CGRect(x: CGFloat(position) * (width + gap), y: 0, width: width, height: bounds.height)
        }
        place()
    }
}

final class StoryViewerController: UIViewController, UIGestureRecognizerDelegate, UITextFieldDelegate {
    /// Whose stories come before (-1) or after (1) those of the person with this key; nil: nobody.
    var neighbour: ((String, Int) -> StoryViewerGroup?)?
    /// A story of somebody else came on the screen: the person's key and the story.
    var onWatched: ((String, StoryPost) -> Void)?
    /// Anything came on the screen, a story or a post.
    var onOpened: ((StoryPost) -> Void)?
    /// An answer to a story: the author's id, the story, the text; the callback gets nil or the words of the failure.
    var onReply: ((String, StoryPost, String, @escaping (String?) -> Void) -> Void)?
    /// Who watched a story of this account.
    var loadViewers: ((StoryPost, @escaping (StoryViewersData?) -> Void) -> Void)?
    /// The address of a person's picture.
    var avatarAddress: ((Person) -> String)?

    private var group: StoryViewerGroup
    private var index: Int

    private let backdrop = UIView()
    private let page = UIView()
    private let picture = StoryPictureView(frame: .zero)
    private let video = StoryVideoView(frame: .zero)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let goneIcon = UIImageView()
    private let goneLabel = UILabel()
    private let chrome = StoryPassView()
    private let bars = StoryBarsView()
    private let avatar = PersonAvatarView()
    private let nameLabel = UILabel()
    private let lineLabel = UILabel()
    private let closeGlass = UIVisualEffectView(effect: nil)
    private let closeButton = UIButton(type: .system)
    private let captionLabel = UILabel()
    private let problemLabel = UILabel()
    private let viewsGlass = UIVisualEffectView(effect: nil)
    private let viewsButton = UIButton(type: .system)
    private let replyGlass = UIVisualEffectView(effect: nil)
    private let replyField = UITextField()
    private let sendGlass = UIVisualEffectView(effect: nil)
    private let sendButton = UIButton(type: .system)
    private let sendSpinner = UIActivityIndicatorView(style: .medium)
    private let sentLabel = UILabel()

    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    private lazy var hold = UILongPressGestureRecognizer(target: self, action: #selector(heldDown(_:)))

    private var clock: CADisplayLink?
    private var lastTick: CFTimeInterval = 0
    private var progress: Double = 0
    private var brokenFor: Double = 0
    private var started = false
    private var closing = false
    private var held = false
    private var dragging = false
    private var typing = false
    private var sending = false
    private var viewersOpen = false
    private var dragAxis = "y"
    private var dragHasPrevious = false
    private var keyboard: CGFloat = 0
    private var problem = ""
    private var viewCount: Int?
    private var viewers: StoryViewersData?
    private var sentTurn = 0
    private let photoMs = StoryRules.number("photoMs", 5000)
    private let brokenMs = StoryRules.number("videoFailedMs", 1500)
    private let replyMax = Int(StoryRules.number("replyMax", 4000))
    #if targetEnvironment(simulator)
    /// For a shot in the simulator: the clock stands at this part of the first story.
    var frozenAt: Double?
    #endif

    init(group: StoryViewerGroup) {
        self.group = group
        index = min(max(0, group.start), max(0, group.items.count - 1))
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        clock?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    override var prefersStatusBarHidden: Bool { return true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .portrait }

    private var post: StoryPost? { return index >= 0 && index < group.items.count ? group.items[index] : nil }

    // MARK: Building

    private func glass(_ holder: UIVisualEffectView, radius: CGFloat) {
        holder.effect = chatGlass()
        holder.clipsToBounds = true
        holder.layer.cornerRadius = radius
        holder.layer.cornerCurve = .continuous
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        backdrop.backgroundColor = .black
        view.addSubview(backdrop)
        page.backgroundColor = .black
        page.clipsToBounds = true
        view.addSubview(page)

        picture.contentMode = .scaleAspectFit
        picture.isAccessibilityElement = true
        picture.onSettled = { [weak self] in self?.settle() }
        page.addSubview(picture)
        video.isAccessibilityElement = true
        video.accessibilityLabel = StoryRules.word("video")
        video.onSettled = { [weak self] in self?.settle() }
        video.onEnded = { [weak self] in
            guard let self, self.group.story else { return }
            self.step(1, slide: false)
        }
        page.addSubview(video)
        spinner.color = .white
        spinner.hidesWhenStopped = true
        page.addSubview(spinner)
        goneIcon.image = chatSymbol("video.slash", 30)
        goneIcon.tintColor = .white
        goneIcon.contentMode = .center
        goneIcon.isHidden = true
        page.addSubview(goneIcon)
        goneLabel.text = StoryRules.word("videoGone")
        goneLabel.font = .systemFont(ofSize: 15)
        goneLabel.textColor = .white
        goneLabel.textAlignment = .center
        goneLabel.isHidden = true
        page.addSubview(goneLabel)

        page.addSubview(chrome)
        bars.isUserInteractionEnabled = false
        chrome.addSubview(bars)
        chrome.addSubview(avatar)
        nameLabel.font = .systemFont(ofSize: 15, weight: .bold)
        nameLabel.textColor = .white
        chrome.addSubview(nameLabel)
        lineLabel.font = .systemFont(ofSize: 13)
        lineLabel.textColor = UIColor(white: 1, alpha: 0.85)
        chrome.addSubview(lineLabel)
        glass(closeGlass, radius: 20)
        chrome.addSubview(closeGlass)
        closeButton.setImage(chatSymbol("xmark", 16, .semibold), for: .normal)
        closeButton.tintColor = .white
        closeButton.accessibilityLabel = StoryRules.word("close")
        closeButton.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        closeGlass.contentView.addSubview(closeButton)

        captionLabel.font = .systemFont(ofSize: 16)
        captionLabel.textColor = .white
        captionLabel.textAlignment = .center
        captionLabel.numberOfLines = 0
        captionLabel.layer.shadowColor = UIColor.black.cgColor
        captionLabel.layer.shadowOpacity = 0.6
        captionLabel.layer.shadowRadius = 3
        captionLabel.layer.shadowOffset = .zero
        chrome.addSubview(captionLabel)
        problemLabel.font = .systemFont(ofSize: 14)
        problemLabel.textColor = Theme.danger
        problemLabel.textAlignment = .center
        problemLabel.numberOfLines = 0
        chrome.addSubview(problemLabel)

        glass(viewsGlass, radius: 17)
        chrome.addSubview(viewsGlass)
        viewsButton.setImage(chatSymbol("eye", 15, .medium), for: .normal)
        viewsButton.tintColor = .white
        viewsButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        viewsButton.setTitleColor(.white, for: .normal)
        viewsButton.addTarget(self, action: #selector(showViewers), for: .touchUpInside)
        viewsGlass.contentView.addSubview(viewsButton)

        glass(replyGlass, radius: 22)
        chrome.addSubview(replyGlass)
        replyField.attributedPlaceholder = NSAttributedString(string: StoryRules.word("reply"), attributes: [.foregroundColor: UIColor(white: 1, alpha: 0.6)])
        replyField.font = .systemFont(ofSize: 16)
        replyField.textColor = .white
        replyField.tintColor = .white
        replyField.keyboardAppearance = .dark
        replyField.returnKeyType = .send
        replyField.accessibilityLabel = StoryRules.word("replyLabel")
        replyField.delegate = self
        replyField.addTarget(self, action: #selector(replyEdited), for: .editingChanged)
        replyGlass.contentView.addSubview(replyField)
        glass(sendGlass, radius: 22)
        chrome.addSubview(sendGlass)
        sendButton.setImage(chatSymbol("arrow.up", 17, .semibold), for: .normal)
        sendButton.tintColor = .white
        sendButton.accessibilityLabel = StoryRules.word("sendReply")
        sendButton.addTarget(self, action: #selector(sendReply), for: .touchUpInside)
        sendGlass.contentView.addSubview(sendButton)
        sendSpinner.color = .white
        sendSpinner.hidesWhenStopped = true
        sendSpinner.isUserInteractionEnabled = false
        sendGlass.contentView.addSubview(sendSpinner)
        sentLabel.text = StoryRules.word("replySent")
        sentLabel.font = .systemFont(ofSize: 13)
        sentLabel.textColor = UIColor(white: 1, alpha: 0.85)
        sentLabel.textAlignment = .center
        sentLabel.isHidden = true
        chrome.addSubview(sentLabel)

        pan.maximumNumberOfTouches = 1
        pan.delegate = self
        view.addGestureRecognizer(pan)
        hold.minimumPressDuration = StoryRules.number("holdMs", 220) / 1000
        hold.delegate = self
        view.addGestureRecognizer(hold)
        tap.delegate = self
        tap.require(toFail: hold)
        view.addGestureRecognizer(tap)

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        bars.setCount(group.items.count)

        // Without sight: «Следующее» and «Предыдущее» as actions of the picture, and the system's «back» closes.
        let forward = UIAccessibilityCustomAction(name: StoryRules.word("next")) { [weak self] (_: UIAccessibilityCustomAction) -> Bool in
            self?.step(1, slide: false)
            return true
        }
        let backward = UIAccessibilityCustomAction(name: StoryRules.word("previous")) { [weak self] (_: UIAccessibilityCustomAction) -> Bool in
            self?.step(-1, slide: false)
            return true
        }
        picture.accessibilityCustomActions = [forward, backward]
        video.accessibilityCustomActions = [forward, backward]
    }

    override func accessibilityPerformEscape() -> Bool {
        closeNow()
        return true
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if clock == nil {
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            clock = link
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        clock?.invalidate()
        clock = nil
        video.setPlaying(false)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        backdrop.frame = view.bounds
        if !dragging && page.transform == .identity {
            page.bounds = CGRect(origin: .zero, size: view.bounds.size)
            page.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        }
        placeParts()
        if !started, view.bounds.width > 0 {
            started = true
            showCurrent(from: 0)
        }
    }

    private func placeParts() {
        let width = page.bounds.width, height = page.bounds.height
        let mediaHeight = (height * 0.82).rounded()
        let mediaFrame = CGRect(x: 0, y: ((height - mediaHeight) / 2).rounded(), width: width, height: mediaHeight)
        picture.frame = mediaFrame
        video.frame = mediaFrame
        spinner.center = CGPoint(x: width / 2, y: height / 2)
        goneIcon.frame = CGRect(x: 0, y: height / 2 - 40, width: width, height: 40)
        goneLabel.frame = CGRect(x: 16, y: height / 2 + 8, width: width - 32, height: 20)
        chrome.frame = page.bounds

        var top = view.safeAreaInsets.top + 8
        bars.frame = CGRect(x: 10, y: top, width: width - 20, height: 3)
        if !bars.isHidden { top += 13 }
        let hasOwner = group.owner != nil
        avatar.frame = CGRect(x: 10, y: top + 3, width: 34, height: 34)
        let textLeft: CGFloat = hasOwner ? 54 : 12
        let textWidth = max(0, width - textLeft - 60)
        if hasOwner {
            nameLabel.frame = CGRect(x: textLeft, y: top + 2, width: textWidth, height: 19)
            lineLabel.frame = CGRect(x: textLeft, y: top + 21, width: textWidth, height: 17)
        } else {
            lineLabel.frame = CGRect(x: textLeft, y: top + 11, width: textWidth, height: 17)
        }
        closeGlass.frame = CGRect(x: width - 10 - 40, y: top, width: 40, height: 40)
        closeButton.frame = closeGlass.bounds

        var bottom = height - max(view.safeAreaInsets.bottom + 12, keyboard + 12)
        let side: CGFloat = 16
        let inner = width - side * 2
        if !sentLabel.isHidden {
            bottom -= 18
            sentLabel.frame = CGRect(x: side, y: bottom, width: inner, height: 18)
            bottom -= 12
        }
        if !replyGlass.isHidden {
            bottom -= 44
            replyGlass.frame = CGRect(x: side, y: bottom, width: inner - 52, height: 44)
            replyField.frame = CGRect(x: 16, y: 0, width: max(0, replyGlass.bounds.width - 32), height: 44)
            sendGlass.frame = CGRect(x: width - side - 44, y: bottom, width: 44, height: 44)
            sendButton.frame = sendGlass.bounds
            sendSpinner.center = CGPoint(x: 22, y: 22)
            bottom -= 12
        }
        if !viewsGlass.isHidden {
            bottom -= 34
            let wanted = viewsButton.sizeThatFits(CGSize(width: 200, height: 34)).width + 28
            viewsGlass.frame = CGRect(x: side, y: bottom, width: max(60, wanted), height: 34)
            viewsButton.frame = viewsGlass.bounds
            bottom -= 12
        }
        if !problemLabel.isHidden {
            let size = problemLabel.sizeThatFits(CGSize(width: inner, height: 200))
            bottom -= size.height
            problemLabel.frame = CGRect(x: side, y: bottom, width: inner, height: size.height)
            bottom -= 12
        }
        if !captionLabel.isHidden {
            let size = captionLabel.sizeThatFits(CGSize(width: inner, height: height * 0.4))
            let tall = min(size.height, height * 0.4)
            bottom -= tall
            captionLabel.frame = CGRect(x: side, y: bottom, width: inner, height: tall)
        }
    }

    // MARK: What is on the screen

    private var pixels: Int {
        let longer = max(view.bounds.width, view.bounds.height) * max(1, traitCollection.displayScale)
        return min(2048, max(640, Int(longer)))
    }

    /// Shows the item at `index`. `from`: 1 — it comes in from the right, -1 — from the left, 0 — in place.
    private func showCurrent(from: Int) {
        guard let post else { return }
        progress = 0
        brokenFor = 0
        problem = ""
        viewers = nil
        viewCount = post.views
        sentTurn += 1
        sentLabel.isHidden = true
        replyField.text = ""
        if post.isVideo {
            picture.show(nil, pixels: 0)
            picture.isHidden = true
            video.isHidden = false
            video.show(id: post.mediaId, loop: !group.story)
        } else {
            video.show(id: "", loop: false)
            video.isHidden = true
            picture.isHidden = false
            picture.accessibilityLabel = StoryRules.word("photo")
            picture.show(post, pixels: pixels)
        }
        // The next photo is asked for now, so it is there when its turn comes.
        if index + 1 < group.items.count, !group.items[index + 1].isVideo { _ = ChannelImages.shared.image(id: group.items[index + 1].mediaId, pixels: pixels) }

        bars.isHidden = !(group.story || group.items.count > 1)
        bars.setCount(group.items.count)
        bars.set(index: index, progress: group.story ? 0 : 1)
        if let owner = group.owner {
            avatar.isHidden = false
            nameLabel.isHidden = false
            avatar.show(owner, address: avatarAddress?(owner) ?? "")
            nameLabel.text = owner.displayName
        } else {
            avatar.isHidden = true
            nameLabel.isHidden = true
        }
        lineLabel.text = Core.view("storiesHeadline", [post.createdAt, Date().timeIntervalSince1970 * 1000, group.story, index, group.items.count]) as? String ?? ""
        captionLabel.text = post.caption
        captionLabel.isHidden = post.caption.isEmpty
        viewsGlass.isHidden = !(group.own && group.story)
        let replies = group.canReply && group.story && !group.own && onReply != nil
        replyGlass.isHidden = !replies
        sendGlass.isHidden = !replies
        refreshViews()
        refreshProblem()
        refreshSend()

        onOpened?(post)
        if group.story && !group.own { onWatched?(group.key, post) }
        if group.own && group.story, let loadViewers {
            let asked = post.id
            loadViewers(post) { [weak self] (found: StoryViewersData?) -> Void in
                guard let self, self.post?.id == asked, let found else { return }
                self.viewers = found
                self.viewCount = found.count
                self.refreshViews()
            }
        }

        page.bounds = CGRect(origin: .zero, size: view.bounds.size)
        page.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        backdrop.alpha = 1
        if from != 0 && !UIAccessibility.isReduceMotionEnabled {
            page.transform = CGAffineTransform(translationX: CGFloat(from) * view.bounds.width, y: 0)
            UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseOut, .allowUserInteraction], animations: { self.page.transform = .identity }, completion: nil)
        } else {
            page.transform = .identity
        }
        placeParts()
        settle()
    }

    private func refreshViews() {
        var count: Any = NSNull()
        if let viewCount { count = viewCount }
        let words = Core.view("storiesViews", [count]) as? [String: Any] ?? [:]
        viewsButton.setTitle(" " + String(viewCount ?? 0), for: .normal)
        viewsButton.accessibilityLabel = words["spoken"] as? String ?? StoryRules.word("views")
        if isViewLoaded { view.setNeedsLayout() }
    }

    private func refreshProblem() {
        problemLabel.text = problem
        problemLabel.isHidden = problem.isEmpty
        if isViewLoaded { view.setNeedsLayout() }
    }

    private func refreshSend() {
        let has = !(replyField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        sendButton.isEnabled = has && !sending
        sendButton.isHidden = sending
        sendGlass.contentView.backgroundColor = has ? Theme.accent : .clear
        sendButton.tintColor = has ? Theme.onAccent : .white
        if sending { sendSpinner.startAnimating() } else { sendSpinner.stopAnimating() }
    }

    /// The picture or the video has come (or given up): the spinner, «Видео недоступно», the clock.
    private func settle() {
        guard let post else { return }
        let waiting = post.isVideo ? !(video.ready || video.gaveUp) : !picture.settled
        if waiting { spinner.startAnimating() } else { spinner.stopAnimating() }
        let gone = post.isVideo && video.gaveUp
        goneIcon.isHidden = !gone
        goneLabel.isHidden = !gone
        applyPause()
    }

    private var paused: Bool {
        #if targetEnvironment(simulator)
        if frozenAt != nil { return true }
        #endif
        return held || dragging || typing || sending || viewersOpen || closing || presentedViewController != nil
    }

    private func applyPause() {
        guard let post else { return }
        video.setPlaying(post.isVideo && !paused && isViewLoaded && view.window != nil)
    }

    @objc private func tick(_ link: CADisplayLink) {
        let passed = lastTick == 0 ? 0 : min(0.1, link.timestamp - lastTick)
        lastTick = link.timestamp
        guard started, let post, group.story else { return }
        #if targetEnvironment(simulator)
        if let frozenAt { bars.set(index: index, progress: frozenAt); return }
        #endif
        if paused { return }
        if post.isVideo {
            if video.gaveUp {
                // «Видео недоступно» stays a moment, then the story moves on instead of hanging.
                brokenFor += passed * 1000
                if brokenFor >= brokenMs { step(1, slide: false) }
                return
            }
            bars.set(index: index, progress: video.played)
            return
        }
        // A photo's five seconds run once it is on the screen.
        guard picture.settled else { return }
        progress += passed * 1000 / max(1, photoMs)
        bars.set(index: index, progress: progress)
        if progress >= 1 { step(1, slide: false) }
    }

    // MARK: Moving

    private var hasNext: Bool { return index + 1 < group.items.count || group.runsOn }

    private func step(_ direction: Int, slide: Bool) {
        if closing { return }
        if direction > 0 {
            if index + 1 < group.items.count {
                index += 1
                showCurrent(from: slide ? 1 : 0)
            } else if group.runsOn {
                if let after = neighbour?(group.key, 1) { change(to: after, from: 1) } else { closeNow() }
            } else {
                springBack()
            }
            return
        }
        if index > 0 {
            index -= 1
            showCurrent(from: slide ? -1 : 0)
        } else if let before = neighbour?(group.key, -1) {
            change(to: before, from: -1)
        } else {
            springBack()
        }
    }

    /// Another person's stories, in place: the page comes in from the side it was pushed towards.
    private func change(to next: StoryViewerGroup, from: Int) {
        group = next
        index = min(max(0, next.start), max(0, next.items.count - 1))
        showCurrent(from: from)
    }

    private func springBack() {
        UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0, options: [.allowUserInteraction], animations: {
            self.page.transform = .identity
            self.backdrop.alpha = 1
        }, completion: nil)
    }

    @objc private func closeNow() {
        if closing { return }
        closing = true
        view.endEditing(true)
        video.setPlaying(false)
        dismiss(animated: true, completion: nil)
    }

    // MARK: Touches

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let touched = touch.view else { return true }
        if touched is UIControl { return false }
        return !touched.isDescendant(of: replyGlass)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        return (gestureRecognizer === pan && otherGestureRecognizer === hold) || (gestureRecognizer === hold && otherGestureRecognizer === pan)
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        if typing { view.endEditing(true); return }
        let x = recognizer.location(in: view).x
        // The left third goes back, the rest forward.
        step(x < view.bounds.width / 3 ? -1 : 1, slide: false)
    }

    @objc private func heldDown(_ recognizer: UILongPressGestureRecognizer) {
        switch recognizer.state {
        case .began:
            held = true
            UIView.animate(withDuration: 0.12) { self.chrome.alpha = 0 }
        case .ended, .cancelled, .failed:
            held = false
            UIView.animate(withDuration: 0.12) { self.chrome.alpha = 1 }
        default:
            break
        }
        applyPause()
    }

    @objc private func dragged(_ recognizer: UIPanGestureRecognizer) {
        let move = recognizer.translation(in: view), speed = recognizer.velocity(in: view)
        let width = Double(view.bounds.width), height = Double(view.bounds.height)
        switch recognizer.state {
        case .began:
            dragAxis = Core.view("storiesAxis", [Double(move.x), Double(move.y)]) as? String ?? "y"
            dragHasPrevious = index > 0 || neighbour?(group.key, -1) != nil
            dragging = true
            applyPause()
        case .changed:
            guard dragging else { return }
            let at = Core.view("storiesDrag", [dragAxis, Double(move.x), Double(move.y), hasNext, dragHasPrevious, height]) as? [String: Any] ?? [:]
            let x = (at["x"] as? NSNumber)?.doubleValue ?? 0, y = (at["y"] as? NSNumber)?.doubleValue ?? 0
            let pulled = (at["progress"] as? NSNumber)?.doubleValue ?? 0
            // Pulled down, the page shrinks to 0.86 and the black behind it fades to 0.15 (the reference's numbers).
            let scale = CGFloat(1 - 0.14 * pulled)
            page.transform = CGAffineTransform(translationX: CGFloat(x), y: CGFloat(y)).scaledBy(x: scale, y: scale)
            backdrop.alpha = CGFloat(1 - 0.85 * pulled)
        case .ended, .cancelled, .failed:
            guard dragging else { return }
            dragging = false
            var action = "cancel"
            if recognizer.state == .ended {
                action = Core.view("storiesSwipe", [dragAxis, Double(move.x), Double(move.y), Double(speed.x), Double(speed.y), width]) as? String ?? "cancel"
            }
            finishDrag(action)
            applyPause()
        default:
            break
        }
    }

    private func finishDrag(_ action: String) {
        let calm = UIAccessibility.isReduceMotionEnabled
        let width = view.bounds.width, height = view.bounds.height
        if action == "next" && hasNext {
            if calm { step(1, slide: false); return }
            UIView.animate(withDuration: 0.17, delay: 0, options: [.curveEaseOut], animations: { self.page.transform = CGAffineTransform(translationX: -width, y: 0) }, completion: { (_: Bool) -> Void in self.step(1, slide: true) })
        } else if action == "previous" && dragHasPrevious {
            if calm { step(-1, slide: false); return }
            UIView.animate(withDuration: 0.17, delay: 0, options: [.curveEaseOut], animations: { self.page.transform = CGAffineTransform(translationX: width, y: 0) }, completion: { (_: Bool) -> Void in self.step(-1, slide: true) })
        } else if action == "close" && typing {
            // The first pull down only puts the keyboard away.
            view.endEditing(true)
            springBack()
        } else if action == "close" {
            if closing { return }
            closing = true
            video.setPlaying(false)
            UIView.animate(withDuration: calm ? 0 : 0.18, animations: {
                self.page.transform = CGAffineTransform(translationX: 0, y: height)
                self.backdrop.alpha = 0
            }, completion: { (_: Bool) -> Void in self.dismiss(animated: false, completion: nil) })
        } else {
            if action == "up" { swipedUp() }
            springBack()
        }
    }

    private func swipedUp() {
        guard group.story else { return }
        if group.own { showViewers() } else if !replyGlass.isHidden { replyField.becomeFirstResponder() }
    }

    // MARK: The answer

    func textFieldDidBeginEditing(_ textField: UITextField) {
        typing = true
        applyPause()
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        typing = false
        applyPause()
    }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        let now = (textField.text ?? "") as NSString
        return now.length - range.length + (string as NSString).length <= replyMax
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        sendReply()
        return false
    }

    @objc private func replyEdited() { refreshSend() }

    @objc private func sendReply() {
        let text = (replyField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending, let post, let onReply, group.story, !group.own else { return }
        sending = true
        problem = ""
        refreshProblem()
        refreshSend()
        applyPause()
        let asked = post.id
        onReply(group.key, post, text) { [weak self] (failure: String?) -> Void in
            guard let self else { return }
            self.sending = false
            if self.post?.id == asked {
                if let failure {
                    self.problem = failure
                    self.refreshProblem()
                } else {
                    self.replyField.text = ""
                    self.sentLabel.isHidden = false
                    self.sentTurn += 1
                    let turn = self.sentTurn
                    self.view.setNeedsLayout()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
                        guard let self, self.sentTurn == turn else { return }
                        self.sentLabel.isHidden = true
                        self.view.setNeedsLayout()
                    }
                }
            }
            self.refreshSend()
            self.applyPause()
        }
    }

    @objc private func keyboardMoved(_ note: Notification) {
        guard isViewLoaded, let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let inView = view.convert(end, from: nil)
        keyboard = max(0, view.bounds.height - inView.minY)
        let time = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        UIView.animate(withDuration: time) { self.placeParts() }
    }

    // MARK: Who watched

    @objc private func showViewers() {
        guard group.own, group.story, let post, presentedViewController == nil else { return }
        let sheet = StoryViewersSheet(found: viewers)
        sheet.avatarAddress = avatarAddress
        sheet.onClosed = { [weak self] in
            self?.viewersOpen = false
            self?.applyPause()
        }
        viewersOpen = true
        applyPause()
        if viewers == nil, let loadViewers {
            let asked = post.id
            loadViewers(post) { [weak self, weak sheet] (found: StoryViewersData?) -> Void in
                guard let self, self.post?.id == asked else { return }
                if let found {
                    self.viewers = found
                    self.viewCount = found.count
                    self.refreshViews()
                }
                sheet?.take(found ?? StoryViewersData(count: 0, rows: []))
            }
        }
        present(sheet, animated: true, completion: nil)
    }

    #if targetEnvironment(simulator)
    /// For a shot in the simulator: the list of who watched, over the story.
    func simulatorShowViewers(_ found: StoryViewersData) {
        viewers = found
        viewCount = found.count
        refreshViews()
        showViewers()
    }
    #endif
}

/// «Просмотры»: who watched a story of this account, newest first.
final class StoryViewersSheet: UIViewController, UITableViewDataSource {
    var onClosed: (() -> Void)?
    var avatarAddress: ((Person) -> String)?
    private var found: StoryViewersData?
    private let heading = UILabel()
    private let countLabel = UILabel()
    private let table = UITableView(frame: .zero, style: .plain)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let emptyIcon = UIImageView()
    private let emptyLabel = UILabel()

    init(found: StoryViewersData?) {
        self.found = found
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        heading.text = StoryRules.word("views")
        heading.font = .systemFont(ofSize: 20, weight: .semibold)
        heading.textColor = Theme.text
        heading.accessibilityTraits = .header
        view.addSubview(heading)
        countLabel.font = .systemFont(ofSize: 13)
        countLabel.textColor = Theme.muted
        view.addSubview(countLabel)
        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.rowHeight = 54
        table.allowsSelection = false
        table.dataSource = self
        table.register(StoryViewerRowCell.self, forCellReuseIdentifier: "row")
        view.addSubview(table)
        spinner.color = Theme.muted
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)
        emptyIcon.image = chatSymbol("eye", 24)
        emptyIcon.tintColor = Theme.muted
        emptyIcon.contentMode = .center
        view.addSubview(emptyIcon)
        emptyLabel.text = StoryRules.word("nobodyWatched")
        emptyLabel.font = .systemFont(ofSize: 14)
        emptyLabel.textColor = Theme.muted
        emptyLabel.textAlignment = .center
        view.addSubview(emptyLabel)
        refresh()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil { onClosed?() }
    }

    func take(_ next: StoryViewersData) {
        found = next
        if isViewLoaded { refresh() }
    }

    private func refresh() {
        let rows = found?.rows ?? []
        if found == nil { spinner.startAnimating() } else { spinner.stopAnimating() }
        emptyIcon.isHidden = found == nil || !rows.isEmpty
        emptyLabel.isHidden = emptyIcon.isHidden
        countLabel.isHidden = rows.isEmpty
        if let found {
            let words = Core.view("storiesViews", [found.count]) as? [String: Any] ?? [:]
            countLabel.text = words["heading"] as? String ?? ""
        }
        table.reloadData()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        let top = view.safeAreaInsets.top + 22
        heading.frame = CGRect(x: 20, y: top, width: width - 40, height: 26)
        countLabel.frame = CGRect(x: 20, y: top + 30, width: width - 40, height: 18)
        table.frame = CGRect(x: 0, y: top + 54, width: width, height: max(0, view.bounds.height - top - 54))
        spinner.center = CGPoint(x: width / 2, y: top + 90)
        emptyIcon.frame = CGRect(x: 0, y: top + 60, width: width, height: 30)
        emptyLabel.frame = CGRect(x: 20, y: top + 96, width: width - 40, height: 20)
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return found?.rows.count ?? 0
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        if let rowCell = cell as? StoryViewerRowCell, let rows = found?.rows, indexPath.row < rows.count {
            let row = rows[indexPath.row]
            rowCell.show(row.person, address: avatarAddress?(row.person) ?? "", viewedAt: row.viewedAt)
        }
        return cell
    }
}

final class StoryViewerRowCell: UITableViewCell {
    private let avatar = PersonAvatarView()
    private let nameLabel = UILabel()
    private let handleLabel = UILabel()
    private let timeLabel = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        contentView.addSubview(avatar)
        nameLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        nameLabel.textColor = Theme.text
        contentView.addSubview(nameLabel)
        handleLabel.font = .systemFont(ofSize: 12)
        handleLabel.textColor = Theme.muted
        contentView.addSubview(handleLabel)
        timeLabel.font = .systemFont(ofSize: 13)
        timeLabel.textColor = Theme.muted
        timeLabel.textAlignment = .right
        contentView.addSubview(timeLabel)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ person: Person, address: String, viewedAt: String) {
        avatar.show(person, address: address)
        nameLabel.text = person.displayName
        handleLabel.text = person.username.isEmpty ? "" : "@" + person.username
        // The clock today, «вчера», else the day: the core's words, by this phone's clock.
        let now = Date()
        let offsetNow = TimeZone.current.secondsFromGMT(for: now) / 60
        let offsetAt = TimeZone.current.secondsFromGMT(for: Messenger.date(viewedAt) ?? now) / 60
        timeLabel.text = Core.view("storiesViewedAt", [viewedAt, now.timeIntervalSince1970 * 1000, offsetAt, offsetNow]) as? String ?? ""
        accessibilityLabel = person.displayName
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width
        avatar.frame = CGRect(x: 20, y: 6, width: 42, height: 42)
        timeLabel.frame = CGRect(x: width - 20 - 70, y: 17, width: 70, height: 20)
        let textWidth = max(0, width - 74 - 100)
        nameLabel.frame = CGRect(x: 74, y: 8, width: textWidth, height: 20)
        handleLabel.frame = CGRect(x: 74, y: 29, width: textWidth, height: 16)
    }
}
