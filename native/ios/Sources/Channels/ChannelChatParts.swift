import QuickLook
import UIKit

// What a channel's chat is made of besides its list: the messages waiting for a connection, the menu of a
// message, the photo on the whole screen, a file opened by the system.

/// Messages written while the server could not be reached: they wait and go out by themselves when the live
/// line is back, whichever screen is open (reference: communities/channelOutbox.ts). Each carries a key the
/// server knows a repeated send by, so nothing is posted twice. Kept on this device per account, as the reference
/// does, so they survive a restart (`ChannelOutboxDisk`, Channels/ChannelOutboxDisk.swift). Main queue only.
final class ChannelOutbox: NSObject {
    static let shared = ChannelOutbox()
    /// Posted when the waiting or refused messages changed; `userInfo["channelId"]`, and `userInfo["message"]`
    /// (the server's message) when one has just been sent.
    static let changed = Notification.Name("invizent.channel-outbox")
    static let limit = 200
    static let full = "Слишком много сообщений ждут отправки (200). Дождись соединения или отмени часть из них."

    struct Item {
        let key: String
        let communityId: String
        let channelId: String
        let text: String
        /// 0: answers nothing.
        let replyTo: Int
    }

    private(set) var waiting: [Item] = []
    /// What the server refused for good, with its words.
    private(set) var refused: [(item: Item, words: String)] = []
    private weak var messenger: Messenger?
    private var sending = false
    private var observing = false

    private override init() { super.init() }

    func start(_ messenger: Messenger?) {
        self.messenger = messenger
        waiting = []
        refused = []
        sending = false
        // Channels: what waited when the app was closed (Channels/ChannelOutboxDisk.swift).
        if let messenger {
            let kept = ChannelOutboxDisk.load(userId: messenger.userId)
            waiting = kept.waiting
            refused = kept.refused
        }
        if !observing {
            observing = true
            NotificationCenter.default.addObserver(self, selector: #selector(event(_:)), name: Live.communityEvent, object: nil)
        }
    }

    @objc private func event(_ note: Notification) {
        if (note.userInfo?["event"] as? [String: Any])?["type"] as? String == "ready" { flush() }
    }

    private func post(_ channelId: String, message: Any? = nil) {
        if let messenger { ChannelOutboxDisk.save(userId: messenger.userId, waiting: waiting, refused: refused) } // Channels: kept on disk
        var info: [String: Any] = ["channelId": channelId]
        if let message { info["message"] = message }
        NotificationCenter.default.post(name: ChannelOutbox.changed, object: nil, userInfo: info)
    }

    /// False when too many are waiting already.
    func add(_ item: Item) -> Bool {
        if waiting.count >= ChannelOutbox.limit { return false }
        waiting.append(item)
        post(item.channelId)
        return true
    }

    func cancel(_ key: String) {
        guard let index = waiting.firstIndex(where: { $0.key == key }) else { return }
        let item = waiting.remove(at: index)
        post(item.channelId)
    }

    func dismiss(_ key: String) {
        guard let index = refused.firstIndex(where: { $0.item.key == key }) else { return }
        let gone = refused.remove(at: index)
        post(gone.item.channelId)
    }

    /// A refused message is tried again as a new one.
    func retry(_ key: String) {
        guard let index = refused.firstIndex(where: { $0.item.key == key }) else { return }
        let gone = refused.remove(at: index).item
        _ = add(Item(key: UUID().uuidString.lowercased(), communityId: gone.communityId, channelId: gone.channelId, text: gone.text, replyTo: gone.replyTo))
        flush()
    }

    /// Sends what is waiting, oldest first, one at a time; stops at the first one that gets no answer.
    func flush() {
        guard let messenger, !sending, let item = waiting.first else { return }
        sending = true
        var fields: [String: Any] = ["text": item.text, "clientKey": item.key]
        if item.replyTo != 0 { fields["replyTo"] = item.replyTo }
        messenger.server.ask("sendChannelMessage", [item.communityId, item.channelId, fields]) { [weak self] result in
            guard let self else { return }
            self.sending = false
            // Cancelled meanwhile: the answer changes nothing here.
            guard let index = self.waiting.firstIndex(where: { $0.key == item.key }) else { return self.flush() }
            switch result {
            case .success(let body):
                self.waiting.remove(at: index)
                self.post(item.channelId, message: body["message"])
                self.flush()
            case .failure(.refused(let message, let status, _, _)) where (400..<500).contains(status) && status != 401 && status != 408 && status != 429:
                self.waiting.remove(at: index)
                self.refused.append((item: item, words: message))
                if self.refused.count > 20 { self.refused.removeFirst() }
                self.post(item.channelId)
                self.flush()
            case .failure:
                // No answer, or «try later»: it stays and goes out with the next «ready».
                break
            }
        }
    }
}

/// The menu of a message: a row of reactions and what can be done with the message.
final class ChannelMenuView: UIView {
    struct Action {
        let symbol: String
        let label: String
        let danger: Bool
        let run: () -> Void
    }

    private let reactionBar = UIView()
    private let panel = UIView()
    private let menuActions: [Action]
    private let reactions: [(emoji: String, chosen: Bool)]
    private let onReact: (String) -> Void
    private let anchor: CGFloat

    init(reactions: [(emoji: String, chosen: Bool)], actions: [Action], at anchor: CGFloat, onReact: @escaping (String) -> Void) {
        self.reactions = reactions
        menuActions = actions
        self.anchor = anchor
        self.onReact = onReact
        super.init(frame: .zero)
        backgroundColor = UIColor(white: 0, alpha: 0.45)
        accessibilityViewIsModal = true
        let shade = UIButton(type: .custom)
        shade.frame = bounds
        shade.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        shade.accessibilityLabel = "Закрыть"
        shade.addTarget(self, action: #selector(close), for: .touchUpInside)
        addSubview(shade)
        for box in [reactionBar, panel] {
            box.backgroundColor = Theme.panel(UIColor(hex: 0x1B1C1E))
            box.layer.cornerRadius = 16
            box.layer.cornerCurve = .continuous
            box.layer.borderWidth = 0.5
            box.layer.borderColor = Theme.veil(0.10).cgColor
            box.clipsToBounds = true
            addSubview(box)
        }
        reactionBar.layer.cornerRadius = 24
        for (index, reaction) in reactions.enumerated() {
            let button = UIButton(type: .custom)
            button.setTitle(reaction.emoji, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 24)
            button.tag = index
            button.layer.cornerRadius = 19
            button.backgroundColor = reaction.chosen ? Theme.veil(0.16) : .clear
            button.accessibilityLabel = "Реакция " + reaction.emoji
            button.addTarget(self, action: #selector(reacted(_:)), for: .touchUpInside)
            reactionBar.addSubview(button)
        }
        for (index, action) in menuActions.enumerated() {
            let button = UIButton(type: .system)
            var look = UIButton.Configuration.plain()
            look.title = action.label
            // MenuItem's glyph (19): a name of the icon set, else a system symbol.
            look.image = IonIcon.has(action.symbol) ? IonIcon.image(action.symbol, size: 19) : UIImage(systemName: action.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium))
            look.imagePadding = 12
            look.baseForegroundColor = action.danger ? Theme.danger : Theme.text
            look.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
            button.configuration = look
            button.contentHorizontalAlignment = .leading
            button.tag = index
            button.addTarget(self, action: #selector(chosen(_:)), for: .touchUpInside)
            panel.addSubview(button)
        }
    }

    required init?(coder: NSCoder) { return nil }

    func show(in host: UIView) {
        frame = host.bounds
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        alpha = 0
        host.addSubview(self)
        UIView.animate(withDuration: 0.14) { self.alpha = 1 }
        UIAccessibility.post(notification: .screenChanged, argument: panel)
    }

    @objc private func close() {
        UIView.animate(withDuration: 0.12, animations: { self.alpha = 0 }, completion: { _ in self.removeFromSuperview() })
    }

    @objc private func reacted(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < reactions.count else { return }
        close()
        onReact(reactions[sender.tag].emoji)
    }

    @objc private func chosen(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < menuActions.count else { return }
        close()
        menuActions[sender.tag].run()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let barWidth = CGFloat(reactions.count) * 42 + 10
        let panelWidth: CGFloat = 240
        let panelHeight = CGFloat(menuActions.count) * 46
        let total = 48 + 8 + panelHeight
        let low = safeAreaInsets.top + 8, high = bounds.height - safeAreaInsets.bottom - 8 - total
        let top = max(low, min(high, anchor - 60))
        let left = max(12, (bounds.width - barWidth) / 2)
        reactionBar.frame = CGRect(x: left, y: top, width: min(barWidth, bounds.width - 24), height: 48)
        for (index, button) in reactionBar.subviews.enumerated() { button.frame = CGRect(x: 5 + CGFloat(index) * 42 + 2, y: 5, width: 38, height: 38) }
        panel.frame = CGRect(x: left, y: top + 56, width: panelWidth, height: panelHeight)
        panel.isHidden = menuActions.isEmpty
        for (index, button) in panel.subviews.enumerated() { button.frame = CGRect(x: 0, y: CGFloat(index) * 46, width: panelWidth, height: 46) }
    }
}

/// A channel's picture on the whole screen: pinch or double tap to zoom, the cross or a tap to close.
final class ChannelPhotoViewer: UIViewController, UIScrollViewDelegate {
    private let scroll = UIScrollView()
    private let picture = UIImageView()
    private let closeButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let fileId: String
    private let pixels: Int

    init(fileId: String) {
        self.fileId = fileId
        let screen = UIScreen.main
        pixels = Int(max(screen.bounds.width, screen.bounds.height) * screen.scale)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override var prefersStatusBarHidden: Bool { return true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        scroll.delegate = self
        scroll.maximumZoomScale = 4
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        view.addSubview(scroll)
        picture.contentMode = .scaleAspectFit
        scroll.addSubview(picture)
        spinner.color = .white
        view.addSubview(spinner)
        closeButton.setImage(IonIcon.image("close", size: 22), for: .normal)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor(white: 0, alpha: 0.4)
        closeButton.layer.cornerRadius = 20
        closeButton.accessibilityLabel = "Закрыть"
        closeButton.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        view.addSubview(closeButton)
        let once = UITapGestureRecognizer(target: self, action: #selector(closeNow))
        let twice = UITapGestureRecognizer(target: self, action: #selector(zoomed(_:)))
        twice.numberOfTapsRequired = 2
        once.require(toFail: twice)
        scroll.addGestureRecognizer(once)
        scroll.addGestureRecognizer(twice)
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: ChannelImages.ready, object: nil)
        showPicture()
    }

    private func showPicture() {
        if let image = ChannelImages.shared.image(id: fileId, pixels: pixels) {
            picture.image = image
            spinner.stopAnimating()
        } else if picture.image == nil {
            spinner.startAnimating()
        }
    }

    @objc private func arrived(_ note: Notification) {
        guard note.object as? String == fileId else { return }
        showPicture()
        if picture.image == nil { spinner.stopAnimating() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scroll.frame = view.bounds
        if scroll.zoomScale == 1 { picture.frame = scroll.bounds }
        spinner.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        closeButton.frame = CGRect(x: view.bounds.width - 56, y: view.safeAreaInsets.top + 8, width: 40, height: 40)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { return picture }

    @objc private func closeNow() { dismiss(animated: true) }

    @objc private func zoomed(_ tap: UITapGestureRecognizer) {
        if scroll.zoomScale > 1 {
            scroll.setZoomScale(1, animated: true)
        } else {
            let point = tap.location(in: picture)
            scroll.zoom(to: CGRect(x: point.x - 60, y: point.y - 60, width: 120, height: 120), animated: true)
        }
    }
}

/// Opens a channel's file with the system's viewer: brought into the cache folder once, then shown from there.
final class ChannelFileOpener: NSObject, QLPreviewControllerDataSource {
    private var shown: URL?
    private weak var host: UIViewController?
    private var busy = false

    func open(_ server: Server, id: String, name: String, over host: UIViewController) {
        guard !busy else { return }
        busy = true
        self.host = host
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let file = ChannelFiles.bring(server, id: id, name: name.isEmpty ? "file" : name)
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                guard let file, let host = self.host, host.viewIfLoaded?.window != nil else { return }
                self.shown = file
                let preview = QLPreviewController()
                preview.dataSource = self
                host.present(preview, animated: true)
            }
        }
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { return shown == nil ? 0 : 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        return (shown ?? ChannelFiles.folder) as NSURL
    }
}
