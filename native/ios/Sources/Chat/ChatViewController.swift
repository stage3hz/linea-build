import UIKit

/// One chat: the messages, the header with the person's name, the field to write in.
final class ChatViewController: UIViewController {
    private let name: String
    private let list = MsgListView()
    private let header = UIView()
    private let back = UIButton(type: .system)
    private let heading = UILabel()
    private let composer = UIVisualEffectView(effect: nil)
    /// ChatActions: several lines, growing with the text (Sources/ChatActions/ChatParts.swift).
    private let field = ComposerField()
    private let send = UIButton(type: .system)
    /// Composer: the round glass paperclip, the field's glass pill, the round glass microphone (Sources/Composer/ComposerPills.swift).
    private let pills = ComposerPills()
    private var rows: [[String: Any]] = []

    private let messenger: Messenger?
    private let chatId: String
    private let peerId: String
    /// Attachments: the paperclip, sending and opening photos and files (Sources/Attachments/ChatAttachments.swift).
    private lazy var attachments = ChatAttachments(messenger: messenger, chatId: chatId, peerId: peerId)
    /// ChatActions: the menu of a message with its reactions, answers, edits, forwards, pins, deletions, the
    /// multi-select, the draft, «печатает…», the way down and older pages (Sources/ChatActions/ChatScreenActions.swift).
    private(set) lazy var actions = ChatScreenActions(messenger: messenger, chatId: chatId, peerId: peerId, name: name)
    /// Voice/Video: the record button, voice messages, videos and round videos (Sources/Voice/ChatMedia.swift).
    private lazy var media = ChatMedia(messenger: messenger, chatId: chatId, peerId: peerId)
    /// Calls: «Позвонить» in the header; a long touch offers «Видеозвонок» too (Sources/Calls/CallOverlay.swift).
    private(set) lazy var callButton = CallEntry.headerButton(messenger: messenger, chatId: chatId, peerId: peerId, name: name)
    /// ChatLook: the glass header with the avatar, the person's light or the wallpaper, bubbles, the swipe to answer
    /// (Sources/ChatLook/ChatLookScreen.swift).
    private(set) lazy var look = ChatLookScreen(messenger: messenger, chatId: chatId, peerId: peerId, name: name)
    /// Attachments: the simulator's sample rows (-attachdemo), kept after the chat's own.
    private var sampleRows: [[String: Any]] = []
    /// Music: the playing track's strip under the header (Sources/Shell/PlayerStrips.swift).
    private lazy var playerStrip = ChatPlayerStrip(host: self)

    /// With a `messenger`: the real chat. Without: the simulator's sample chat.
    init(name: String, messenger: Messenger? = nil, chatId: String = "", peerId: String = "") {
        self.name = name
        self.messenger = messenger
        self.chatId = chatId
        self.peerId = peerId
        super.init(nibName: nil, bundle: nil)
    }

    /// Up to which message the other side has read (for the two ticks).
    var peerLastRead = 0 {
        didSet { actions.peerLastRead = peerLastRead }
    }
    /// Up to which message this screen has told the server «read».
    private var reportedRead = 0

    /// Reads the chat's newest page and shows it.
    /// ChatActions: the pages are read, folded and turned into rows there; they come back through `actions.onRows`.
    private func load() {
        actions.load()
    }

    /// The chat's rows as they are now, with what the attachments add after them.
    private func showRows(_ made: [[String: Any]]) {
        rows = made
        // Attachments: what is still on its way out stands after the chat's own rows.
        rows += attachments.loaded(made)
        // Voice/Video: voice messages and videos on their way out (and the simulator's sample rows).
        rows += media.loaded(made)
        rows += sampleRows
        list.setRows(MsgRow.parse(rows))
    }

    /// The newest page was read: what came from the other side is reported as read.
    private func loaded(newestTheirs: Int) {
        // Reported once per new message: the server answers a read mark with an event, which reads the page again.
        if viewIfLoaded?.window != nil, newestTheirs > reportedRead {
            reportedRead = newestTheirs
            messenger?.markRead(chatId: chatId, messageId: newestTheirs)
        }
    }

    @objc private func changed(_ note: Notification) {
        if let id = note.object as? String, id != chatId { return }
        load()
    }

    @objc private func peerRead(_ note: Notification) {
        guard note.userInfo?["chatId"] as? String == chatId, let id = note.userInfo?["messageId"] as? Int, id > peerLastRead else { return }
        peerLastRead = id
        load()
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        list.setPalette(Theme.messages)
        list.setFontSize(ThemeStore.textSize) // Settings: «Размер текста в чатах» (Settings/ThemeStore.swift)
        view.addSubview(list)
        look.installBackdrop(in: view, below: list) // ChatLook: the wallpaper or the person's light under the messages

        header.backgroundColor = Theme.bg
        view.addSubview(header)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        back.tintColor = Theme.text
        back.accessibilityLabel = "Назад"
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        header.addSubview(back)
        heading.text = name
        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        heading.textColor = Theme.text
        heading.textAlignment = .center
        header.addSubview(heading)
        // People: a tap on the name opens the person's profile.
        heading.isUserInteractionEnabled = true
        heading.accessibilityTraits = .button
        heading.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openProfile)))

        // Composer: no glass of its own — three separate glass shapes under its buttons and field, as in the reference.
        composer.clipsToBounds = false
        view.addSubview(composer)
        pills.install(in: composer.contentView)
        composer.contentView.addSubview(field)
        // Composer: an accent circle of 40 pt with the arrow (ChatScreen.tsx «Отправить сообщение»).
        send.setImage(IonIcon.image("arrow-up", size: 25), for: .normal) // <Icon name="arrow-up" size={25}>
        send.tintColor = Theme.onAccent
        send.backgroundColor = Theme.accent
        send.layer.cornerRadius = ComposerPills.side / 2
        send.accessibilityLabel = "Отправить"
        send.addTarget(self, action: #selector(sendNow), for: .touchUpInside)
        composer.contentView.addSubview(send)
        // Attachments: the paperclip in the composer; a touch on a row opens its photo or file.
        attachments.install(host: self, composer: composer.contentView)
        attachments.onPendingChanged = { [weak self] in self?.showPendingAttachments() }
        // ChatActions: a touch on a message (the menu, a reaction, an attachment), the field, the bars, the header's
        // status line — and the rows themselves, with or without an account (the simulator's sample chat).
        // Calls: the button stands under what ChatActions lays over the header (the selection's own header).
        header.addSubview(callButton)
        actions.install(host: self, list: list, header: header, heading: heading, back: back, composer: composer, field: field, send: send, attachments: attachments)
        actions.onRows = { [weak self] (made: [[String: Any]]) -> Void in self?.showRows(made) }
        // Voice/Video: the microphone in the send button's place, recording, playing in the rows.
        media.install(host: self, list: list, composer: composer.contentView, field: field, send: send, attachments: attachments, actions: actions)
        media.onPendingChanged = { [weak self] in self?.showPendingMedia() }
        actions.onLoaded = { [weak self] (newestTheirs: Int) -> Void in self?.loaded(newestTheirs: newestTheirs) }
        // ChatLook: the header's views go into glass pills; the avatar on the right; the swipe to answer.
        look.installHeader(host: self, header: header, heading: heading, back: back, call: callButton, status: actions.statusView, list: list, actions: actions)
        look.onSearch = { [weak self] in self?.actions.openSearch() } // Profile: «Поиск» of the avatar's hold menu
        look.onGift = { [weak self] in self?.actions.sendGift() } // Composer: «Отправить подарок»
        #if targetEnvironment(simulator)
        if messenger == nil { ChatLookDemo.run(self) } // ChatLook: -chatlook … (Sources/ChatLook/ChatLookDemo.swift)
        #endif

        if messenger != nil {
            NotificationCenter.default.addObserver(self, selector: #selector(changed(_:)), name: Messenger.changed, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(peerRead(_:)), name: Messenger.peerRead, object: nil)
        } else {
            #if targetEnvironment(simulator)
            // Attachments: -attachdemo 1 adds sample rows with a photo and files, -attachdemo viewer also opens the photo viewer.
            if let sample = UserDefaults.standard.string(forKey: "attachdemo") {
                sampleRows = ChatAttachments.demoRows()
                if sample == "viewer" { ChatAttachments.demoViewer(over: self) }
            }
            // LinkPreview: -linkdemo 1|composer adds two rows with the cards of links (Sources/LinkPreview/LinkDemo.swift).
            if UserDefaults.standard.string(forKey: "linkdemo") != nil { sampleRows += LinkDemo.rows() }
            #endif
        }
        load()
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var keyboardTop: CGFloat?

    @objc private func keyboardMoved(_ note: Notification) {
        guard let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let top = view.convert(frame, from: nil).minY
        keyboardTop = top < view.bounds.height ? top : nil
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        UIView.animate(withDuration: duration, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) { self.place() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        place()
    }

    private func place() {
        let width = view.bounds.width, top = view.safeAreaInsets.top
        header.frame = CGRect(x: 0, y: 0, width: width, height: top + 52) // ChatLook: 8 above the 44-point pills
        back.frame = CGRect(x: 6, y: top + 2, width: 44, height: 44)
        heading.frame = CGRect(x: 56, y: top + 2, width: width - 112, height: 44)
        callButton.frame = CGRect(x: width - 50, y: top + 2, width: 44, height: 44)
        // ChatActions: the composer is as tall as the field's text asks (one line at first); the send button and
        // the paperclip stay at its lower edge.
        // Composer: the row is 8 pt from the screen's sides; the field's pill leaves 40 + 8 pt on each side for the
        // paperclip and the microphone, and its text stands 14 pt in from the pill's edges (ChatScreen.tsx).
        let pill = ComposerPills.fieldPill(width: width - 16, height: 0)
        let composerHeight = actions.composerHeight(fieldWidth: pill.width - 28)
        var floor = keyboardTop.map { $0 - 8 } ?? (view.bounds.height - max(view.safeAreaInsets.bottom, 12))
        // Composer: the emoji panel stands where the keyboard was (Sources/Composer/EmojiPanel.swift).
        if keyboardTop == nil, let panelTop = actions.extras.panelTop(in: view) { floor = panelTop - 8 }
        composer.frame = CGRect(x: 8, y: floor - composerHeight, width: width - 16, height: composerHeight)
        field.frame = CGRect(x: pill.minX + 14, y: 0, width: max(0, pill.width - 28), height: composerHeight)
        send.frame = CGRect(x: composer.bounds.width - ComposerPills.side, y: composerHeight - ComposerPills.side, width: ComposerPills.side, height: ComposerPills.side)
        attachments.place(field: field, height: composerHeight)
        // Voice/Video: the record button and the strip of a take.
        media.place(composerFrame: composer.frame, in: view)
        // Composer: the microphone's round glass only while the record button stands there.
        pills.place(width: composer.bounds.width, height: composerHeight, microphone: send.isHidden && !media.recordingPreview, hidden: false, recording: media.recordingTake)
        list.frame = view.bounds
        // ChatActions: the status under the name, the pinned message, the bar above the field, the way down.
        // Music: the player strip under the header; what ChatActions places there moves down by its room.
        let stripRoom = playerStrip.place(in: view, headerBottom: header.frame.maxY, hidden: actions.history.selection != nil)
        let room = actions.place(in: view, headerBottom: header.frame.maxY + stripRoom, safeTop: top, composerFrame: composer.frame)
        look.place(in: view, safeTop: top) // ChatLook: the pills of the header, after ChatActions placed the name and the status
        look.placeFloor(in: view, composerTop: composer.frame.minY) // EdgeFade: the progressive edge above the composer
        list.setPad(top: Double(room.top), bottom: Double(room.bottom))
    }

    /// Attachments: shows the rows of what is being sent (they change while a file is prepared and uploaded).
    private func showPendingAttachments() {
        rows.removeAll { ($0["key"] as? String ?? "").hasPrefix("attach-") }
        rows += attachments.pendingRows
        list.setRows(MsgRow.parse(rows))
    }

    /// Voice/Video: shows the rows of voice messages and videos being sent.
    private func showPendingMedia() {
        rows.removeAll { ($0["key"] as? String ?? "").hasPrefix("media-") }
        rows += media.pendingRows
        list.setRows(MsgRow.parse(rows))
    }

    /// ChatLook: back from the profile or the settings, the wallpaper and the bubbles may have changed.
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        look.apply()
    }

    /// Voice/Video: round videos move while the chat is on screen; leaving it stops every sound and a take.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        media.appeared()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        media.left()
    }

    @objc private func goBack() { navigationController?.popViewController(animated: true) }

    /// People: the profile of the person of this chat (Sources/People/PersonProfileViewController.swift).
    @objc func openProfile() {
        view.endEditing(true)
        let profile = PersonProfileViewController(messenger: messenger, userId: peerId, name: name, chatId: messenger == nil ? "demo" : chatId)
        profile.chatLink = ProfileChatLink(chat: self) // Profile: sound, search, shared media, «Ещё» of this chat
        navigationController?.pushViewController(profile, animated: true)
    }

    /// ChatActions: the message, an answer, an edit or a forward — whatever the field is for at the moment.
    @objc private func sendNow() {
        actions.submit()
    }
}
