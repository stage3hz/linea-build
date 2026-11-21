import UIKit

/// Everything a person does with the messages of one chat beyond reading and sending plain text (the reference's
/// ChatScreen.tsx): the menu of a message with its reactions, answering, editing, copying, forwarding, pinning,
/// deleting, choosing several; the bar above the field; the pinned message; «печатает…» and the status under the
/// name; the unsent text kept as a draft; the way down; older pages while scrolling up.
///
/// The chat's screen owns its views and hands them over in `install`; this object owns what it adds to them.
/// Main queue only.
final class ChatScreenActions: NSObject, UITextViewDelegate {
    static let editWindowClosed = "Изменить сообщение можно в течение 48 часов после отправки."

    private let messenger: Messenger?
    private let chatId: String
    private let peerId: String
    private let peerName: String
    private var peerUsername = ""
    private let local: ChatLocal?
    let history: ChatHistory

    private weak var host: UIViewController?
    private weak var list: MsgListView?
    private weak var header: UIView?
    private weak var heading: UILabel?
    private weak var backButton: UIButton?
    private weak var composer: UIView?
    private weak var field: ComposerField?
    private weak var sendButton: UIButton?
    private weak var attachments: ChatAttachments?

    private let statusLabel = UILabel()
    private let pinnedBar = PinnedBar()
    private let composerBar = ComposerBar()
    private let downButton = DownButton(frame: .zero)
    private let notice = ChatNotice(frame: .zero)
    private let failedNotice = ChatNotice(frame: .zero)
    private let selectionHeader = SelectionHeader(frame: .zero)
    private let selectionBar = SelectionBar()
    private weak var openedMenu: MessageMenuController?

    /// The rows of the chat changed (oldest first, for `MsgRow.parse`).
    var onRows: (([[String: Any]]) -> Void)?
    /// The newest page was read: the newest message of the other side in it.
    var onLoaded: ((Int) -> Void)?

    private var replyTo: [String: Any]?
    private var editing: [String: Any]?
    private var forwardItems: [ForwardDraft.Item] = []
    private var tapWork: DispatchWorkItem?
    private var tapKey = ""
    private var typingAt = Date.distantPast
    private var typingStop: DispatchWorkItem?
    private var jump: (clientId: String, pages: Int)?
    private var focusClient = ""
    private var fromNewest: CGFloat = 0
    private var unseen = 0
    private var newestKnown = 0
    private var shownOnce = false
    private var keyboardUp = false
    private var failedShown = false
    private var clock: Timer?
    /// The sample chat's own draft (no account, nothing is kept).
    private var sampleDraft = ""

    init(messenger: Messenger?, chatId: String, peerId: String, name: String) {
        self.messenger = messenger
        self.chatId = chatId
        self.peerId = peerId
        peerName = name
        local = messenger.map { ChatLocal.of($0) }
        history = ChatHistory(messenger: messenger, chatId: chatId, peerId: peerId, peerName: name)
        super.init()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        clock?.invalidate()
        typingStop?.cancel()
        tapWork?.cancel()
        messenger?.live.typing(chatId: chatId, on: false)
    }

    /// Up to which message the other side has read (the two ticks).
    var peerLastRead: Int {
        get { history.peerLastRead }
        set { history.peerLastRead = newValue }
    }

    private var selecting: Bool { history.selection != nil }

    // MARK: Setting up

    /// What the list of chats knows about this chat when it opens it: the person's @name for the header, and
    /// where the unread messages begin.
    func opened(_ chat: Messenger.ChatSummary) {
        peerUsername = (chat.chat["peer"] as? [String: Any])?["username"] as? String ?? ""
        if ChatHistory.number(chat.chat["unreadCount"]) > 0 { history.unreadAfter = ChatHistory.number(chat.chat["lastReadMessageId"]) }
        showStatus()
    }

    /// Once the chat is read, go to this message (a result of the search in the list of chats).
    func focus(clientId: String) {
        focusClient = clientId
    }

    /// Takes the screen's views and adds its own to them.
    func install(host: UIViewController, list: MsgListView, header: UIView, heading: UILabel, back: UIButton, composer: UIView, field: ComposerField, send: UIButton, attachments: ChatAttachments) {
        self.host = host
        self.list = list
        self.header = header
        self.heading = heading
        backButton = back
        self.composer = composer
        self.field = field
        sendButton = send
        self.attachments = attachments

        statusLabel.font = .systemFont(ofSize: 12)
        statusLabel.textColor = Theme.muted
        statusLabel.textAlignment = .center
        header.addSubview(statusLabel)
        selectionHeader.isHidden = true
        selectionHeader.onCancel = { [weak self] in self?.history.selection = nil }
        selectionHeader.onCopy = { [weak self] in self?.copySelected() }
        header.addSubview(selectionHeader)

        pinnedBar.isHidden = true
        pinnedBar.onOpen = { [weak self] in
            guard let self, let client = self.history.shown.pinned?["clientId"] as? String else { return }
            self.jumpTo(client)
        }
        pinnedBar.onUnpin = { [weak self] in self?.history.sendAction(["type": "pin", "target": NSNull()]) }
        host.view.addSubview(pinnedBar)
        host.view.addSubview(notice)
        failedNotice.onPress = { [weak self] in self?.history.retryFailed() }
        host.view.addSubview(failedNotice)
        composerBar.isHidden = true
        composerBar.onClose = { [weak self] in self?.closeBar() }
        host.view.addSubview(composerBar)
        downButton.isHidden = true
        downButton.onPress = { [weak self] in
            guard let self else { return }
            self.unseen = 0
            self.list?.scrollToNewest(animated: true)
        }
        host.view.addSubview(downButton)
        selectionBar.isHidden = true
        selectionBar.onForward = { [weak self] in self?.forwardSelected() }
        selectionBar.onShare = { [weak self] in self?.shareSelected() }
        selectionBar.onDelete = { [weak self] in self?.deleteSelected() }
        host.view.addSubview(selectionBar)

        field.hintWords = "Сообщение"
        field.delegate = self
        field.accessibilityLabel = "Сообщение"

        list.onMsgPress = { [weak self] (event: [String: Any]) -> Void in
            self?.pressed(event["key"] as? String ?? "", y: CGFloat((event["y"] as? NSNumber)?.doubleValue ?? 0))
        }
        list.onMsgLongPress = { [weak self] (event: [String: Any]) -> Void in
            self?.held(event["key"] as? String ?? "", y: CGFloat((event["y"] as? NSNumber)?.doubleValue ?? 0))
        }
        list.onReactPress = { [weak self] (event: [String: Any]) -> Void in
            self?.chipPressed(event["key"] as? String ?? "", emoji: event["emoji"] as? String ?? "")
        }
        list.onQuotePress = { [weak self] (event: [String: Any]) -> Void in
            self?.quotePressed(event["key"] as? String ?? "")
        }
        list.onNearTop = { [weak self] (_: [String: Any]) -> Void in
            guard let self, self.history.hasMore else { return }
            self.history.load(older: true)
        }
        list.onScrolled = { [weak self] (event: [String: Any]) -> Void in
            self?.scrolled(CGFloat((event["fromNewest"] as? NSNumber)?.doubleValue ?? 0))
        }

        history.onShown = { [weak self] (shown: ChatHistory.Shown) -> Void in self?.show(shown) }
        history.onLoaded = { [weak self] (newest: Int) -> Void in self?.onLoaded?(newest) }
        history.onProblem = { [weak self] (words: String) -> Void in self?.say(words, danger: true) }

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(statusChanged(_:)), name: ChatTyping.changed, object: nil)
        center.addObserver(self, selector: #selector(statusChanged(_:)), name: Live.presenceChanged, object: nil)
        center.addObserver(self, selector: #selector(keyboardShown), name: UIResponder.keyboardWillShowNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardHidden), name: UIResponder.keyboardWillHideNotification, object: nil)
        // «был(а) 5 минут назад» grows old by itself.
        clock = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.showStatus() }

        // The unsent text of this chat, and a forward that waits for it.
        field.text = local?.draft(chatId) ?? ""
        forwardItems = ForwardDraft.waiting(for: chatId)
        #if targetEnvironment(simulator)
        if messenger == nil { simulatorSeed() }
        #endif
        showBar()
        showStatus()
    }

    /// Reads the chat's newest page (the rows come through `onRows`).
    func load() {
        history.load()
    }

    @objc private func statusChanged(_ note: Notification) {
        if let id = note.object as? String, id != chatId, id != peerId { return }
        showStatus()
    }

    @objc private func keyboardShown() { keyboardUp = true }
    @objc private func keyboardHidden() { keyboardUp = false }

    // MARK: The header

    /// The line under the name: «печатает…», else «в сети» / «был(а) …», else the person's @name.
    private func showStatus() {
        var words = ""
        var lit = false
        if ChatTyping.shared.isTyping(chatId) {
            words = "печатает…"
            lit = true
        } else if let messenger, let seen = PresenceWords.text(messenger.live.presence[peerId]) {
            words = seen
            lit = seen == "в сети"
        } else if !peerUsername.isEmpty {
            words = "@" + peerUsername
        }
        #if targetEnvironment(simulator)
        if messenger == nil {
            words = UserDefaults.standard.string(forKey: "chatdemo") == "typing" ? "печатает…" : "в сети"
            lit = true
        }
        #endif
        if statusLabel.text == words { return }
        statusLabel.text = words
        statusLabel.textColor = lit ? Theme.accent : Theme.muted
        host?.view.setNeedsLayout()
    }

    // MARK: Layout

    /// The height the composer needs for the field's text at this width of the field.
    func composerHeight(fieldWidth: CGFloat) -> CGFloat {
        guard let field else { return ComposerField.lowest }
        let scrolls = field.overflows(width: fieldWidth)
        if field.isScrollEnabled != scrolls { field.isScrollEnabled = scrolls }
        return field.wantedHeight(width: fieldWidth)
    }

    /// Places what this object added, after the screen has placed its own views. Gives the room the list must
    /// leave under the header and above the composer.
    func place(in view: UIView, headerBottom: CGFloat, safeTop: CGFloat, composerFrame: CGRect) -> (top: CGFloat, bottom: CGFloat) {
        let width = view.bounds.width
        let chosen = selecting
        let hasStatus = !(statusLabel.text ?? "").isEmpty
        if let heading {
            heading.frame = CGRect(x: 56, y: safeTop + (hasStatus ? 5 : 2), width: width - 112, height: hasStatus ? 22 : 44)
            heading.isHidden = chosen
        }
        statusLabel.frame = CGRect(x: 56, y: safeTop + 27, width: width - 112, height: 16)
        statusLabel.isHidden = chosen || !hasStatus
        backButton?.isHidden = chosen
        selectionHeader.frame = CGRect(x: 0, y: safeTop + 2, width: width, height: 44)

        var top = headerBottom + 8
        if !pinnedBar.isHidden {
            pinnedBar.frame = CGRect(x: 12, y: headerBottom + 4, width: width - 24, height: PinnedBar.height)
            top = pinnedBar.frame.maxY + 8
        }
        var noticeY = top
        for item in [failedNotice, notice] where !item.isHidden {
            let size = item.fitting(width: width - 32)
            item.frame = CGRect(x: (width - size.width) / 2, y: noticeY, width: size.width, height: size.height)
            noticeY += size.height + 6
        }

        var above = composerFrame.minY
        composer?.isHidden = chosen
        selectionBar.frame = CGRect(x: 12, y: composerFrame.maxY - SelectionBar.height, width: width - 24, height: SelectionBar.height)
        if chosen {
            above = selectionBar.frame.minY
        } else if !composerBar.isHidden {
            composerBar.frame = CGRect(x: composerFrame.minX, y: above - 6 - ComposerBar.height, width: composerFrame.width, height: ComposerBar.height)
            above = composerBar.frame.minY
        }
        downButton.frame = CGRect(x: width - 14 - DownButton.side, y: above - 12 - DownButton.side, width: DownButton.side, height: DownButton.side)
        return (top, view.bounds.height - above + 8)
    }

    private func relayout() {
        host?.view.setNeedsLayout()
    }

    // MARK: What is shown

    private func show(_ shown: ChatHistory.Shown) {
        // Messages of the other side that came while the list was scrolled away are counted on the way down.
        var newest = newestKnown
        var fresh = 0
        for key in shown.order {
            guard let message = shown.messages[key], message["localState"] == nil else { continue }
            let id = ChatHistory.number(message["id"])
            if id > newestKnown, shownOnce, message["senderId"] as? String != history.userId { fresh += 1 }
            newest = max(newest, id)
        }
        newestKnown = newest
        if fromNewest > 350 { unseen += fresh } else { unseen = 0 }
        onRows?(shown.rows)

        if let pinned = shown.pinned {
            let line = Core.view("replyPreview", [pinned]) as? String ?? ""
            pinnedBar.show(words: line.isEmpty ? "Вложение" : line)
        }
        let pinnedHidden = shown.pinned == nil
        if pinnedBar.isHidden != pinnedHidden {
            pinnedBar.isHidden = pinnedHidden
            relayout()
        }
        let failed = shown.failedActions > 0
        if failed != failedShown {
            failedShown = failed
            if failed { failedNotice.show("Действие не отправлено · повторить", danger: true, stay: true) } else { failedNotice.hide() }
            relayout()
        }
        // What was being answered or edited may be gone by now.
        if let replyTo, shown.messages[ChatHistory.key(replyTo)] == nil {
            self.replyTo = nil
            showBar()
        }
        if let editing, shown.messages[ChatHistory.key(editing)] == nil { endEdit() }
        showSelection()
        showDown()
        if jump != nil { stepJump() }
        guard history.loadedOnce, !shownOnce else { return }
        shownOnce = true
        if !focusClient.isEmpty {
            let wanted = focusClient
            focusClient = ""
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.jumpTo(wanted) }
        }
        #if targetEnvironment(simulator)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.simulatorAct() }
        #endif
    }

    private func scrolled(_ distance: CGFloat) {
        fromNewest = distance
        if distance < 24, unseen != 0 { unseen = 0 }
        showDown()
    }

    private func showDown() {
        let wanted = fromNewest > 350 && !selecting
        if downButton.isHidden == wanted { downButton.isHidden = !wanted }
        if wanted { downButton.show(count: unseen) }
    }

    /// A short line under the header.
    private func say(_ words: String, danger: Bool = false) {
        guard !words.isEmpty else { return }
        notice.show(words, danger: danger)
        relayout()
    }

    // MARK: Touches on a message

    private static func readable(_ message: [String: Any]) -> Bool { message["cryptoState"] as? String == "decrypted" }
    private static func outgoing(_ message: [String: Any]) -> Bool { message["localState"] != nil }

    /// A tap, as in the reference: it opens the menu, a second tap right after it puts ❤️ instead. With the
    /// keyboard up a tap only puts the keyboard away; a tap on a photo or a file opens it.
    private func pressed(_ key: String, y: CGFloat) {
        guard let message = history.shown.messages[key] else {
            // A row that is not a message of the chat yet: an attachment on its way out.
            attachments?.pressed(key)
            return
        }
        if selecting { toggle(key); return }
        if message["localState"] as? String == "failed" { history.retryFailed(); return }
        if keyboardUp, tapWork == nil {
            host?.view.endEditing(true)
            return
        }
        if message["attachment"] is [String: Any] {
            attachments?.pressed(key)
            return
        }
        if let waiting = tapWork, tapKey == key {
            waiting.cancel()
            tapWork = nil
            if ChatScreenActions.readable(message), !ChatScreenActions.outgoing(message) {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                react(message, "❤️")
            }
            return
        }
        tapWork?.cancel()
        tapKey = key
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.tapWork = nil
            self.openMenu(key, y: y)
        }
        tapWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.23, execute: work)
    }

    private func held(_ key: String, y: CGFloat) {
        guard history.shown.messages[key] != nil else { return }
        if selecting { toggle(key); return }
        tapWork?.cancel()
        tapWork = nil
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        openMenu(key, y: y)
    }

    private func chipPressed(_ key: String, emoji: String) {
        guard let message = history.shown.messages[key] else { return }
        if selecting { toggle(key); return }
        if ChatScreenActions.readable(message), MessageReactions.all.contains(emoji) { react(message, emoji) }
    }

    private func quotePressed(_ key: String) {
        guard let message = history.shown.messages[key] else { return }
        if selecting { toggle(key); return }
        guard let reply = (message["meta"] as? [String: Any])?["reply"] as? [String: Any], let client = reply["clientId"] as? String else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        jumpTo(client)
    }

    /// One reaction per person on a message: the same one again takes it off.
    private func react(_ message: [String: Any], _ emoji: String) {
        guard let target = message["clientId"] as? String else { return }
        var current = ""
        for reaction in message["reactions"] as? [[String: Any]] ?? [] where reaction["mine"] as? Bool == true {
            current = reaction["emoji"] as? String ?? ""
        }
        var action: [String: Any] = ["type": "react", "target": target]
        if current == emoji { action["emoji"] = NSNull() } else { action["emoji"] = emoji }
        history.sendAction(action, targetText: message["text"] as? String ?? "")
    }

    // MARK: The menu

    private static func isVoice(_ attachment: [String: Any]) -> Bool {
        let name = attachment["name"] as? String ?? ""
        return attachment["mimeType"] as? String == "audio/mp4" && name.hasPrefix("voice-") && name.hasSuffix(".m4a")
    }

    private static func isVideoNote(_ attachment: [String: Any]) -> Bool {
        let name = attachment["name"] as? String ?? ""
        return attachment["mimeType"] as? String == "video/mp4" && name.hasPrefix("circle-") && name.hasSuffix(".mp4")
    }

    private func editWindowOpen(_ message: [String: Any]) -> Bool {
        let args: [Any] = [message["createdAt"] as? String ?? "", Date().timeIntervalSince1970 * 1000]
        return Core.view("editWindowOpen", args) as? Bool ?? false
    }

    /// The author edits their own message — its text or the caption of a photo or a file — for 48 hours after
    /// sending. A poll, a voice or a video message has nothing to edit.
    private func editable(_ message: [String: Any]) -> Bool {
        guard message["senderId"] as? String == history.userId, ChatScreenActions.readable(message), !ChatScreenActions.outgoing(message) else { return false }
        let meta = message["meta"] as? [String: Any]
        if meta?["action"] != nil || meta?["poll"] != nil { return false }
        let attachment = message["attachment"] as? [String: Any]
        if (message["text"] as? String ?? "").isEmpty && attachment == nil { return false }
        if let attachment, ChatScreenActions.isVoice(attachment) || ChatScreenActions.isVideoNote(attachment) { return false }
        return editWindowOpen(message)
    }

    private func openMenu(_ key: String, y: CGFloat) {
        guard let host, host.presentedViewController == nil, let message = history.shown.messages[key] else { return }
        let shown = history.shown
        let mine = message["senderId"] as? String == history.userId
        let readable = ChatScreenActions.readable(message)
        let outgoing = ChatScreenActions.outgoing(message)
        let text = message["text"] as? String ?? ""
        let client = message["clientId"] as? String ?? ""
        let locked = shown.noCopy
        let pinnedNow = !client.isEmpty && shown.pinned?["clientId"] as? String == client

        var items: [MessageMenuController.Item] = []
        if readable && !outgoing {
            items.append(MessageMenuController.Item(symbol: "arrowshape.turn.up.left", label: "Ответить", run: { [weak self] in self?.startReply(message, focus: true) }))
        }
        if !locked && !text.isEmpty {
            items.append(MessageMenuController.Item(symbol: "doc.on.doc", label: "Скопировать", run: { [weak self] in self?.copyWords(text) }))
        }
        if readable && !outgoing {
            items.append(MessageMenuController.Item(symbol: pinnedNow ? "pin.slash" : "pin", label: pinnedNow ? "Открепить" : "Закрепить", run: { [weak self] in
                var action: [String: Any] = ["type": "pin"]
                if pinnedNow { action["target"] = NSNull() } else { action["target"] = client }
                self?.history.sendAction(action, targetText: text)
            }))
        }
        if !locked && readable && !outgoing {
            items.append(MessageMenuController.Item(symbol: "arrowshape.turn.up.right", label: "Переслать", run: { [weak self] in self?.startForward([message]) }))
        }
        if editable(message) {
            items.append(MessageMenuController.Item(symbol: "square.and.pencil", label: "Изменить", run: { [weak self] in self?.startEdit(message, focus: true) }))
        }
        if message["localState"] as? String == "failed" {
            items.append(MessageMenuController.Item(symbol: "arrow.clockwise", label: "Повторить отправку", run: { [weak self] in self?.history.retryFailed() }))
        }
        if !outgoing {
            items.append(MessageMenuController.Item(symbol: "trash", label: "Удалить", danger: true, stays: true, run: { [weak self] in
                guard let self else { return }
                self.openedMenu?.replace(items: self.deleteItems([key], done: {}))
            }))
            items.append(MessageMenuController.Item(symbol: "checkmark.circle", label: "Выбрать", separated: true, run: { [weak self] in
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                self?.history.selection = [key]
            }))
        }
        guard !items.isEmpty else { return }

        var reactions: [(emoji: String, chosen: Bool)] = []
        if readable && !outgoing {
            var current = ""
            for reaction in message["reactions"] as? [[String: Any]] ?? [] where reaction["mine"] as? Bool == true {
                current = reaction["emoji"] as? String ?? ""
            }
            reactions = MessageReactions.all.map { (emoji: String) -> (emoji: String, chosen: Bool) in
                return (emoji: emoji, chosen: emoji == current)
            }
        }
        host.view.endEditing(true)
        let menu = MessageMenuController(anchorY: y, mine: mine, preview: Messenger.previewText(message), reactions: reactions, items: items)
        menu.onReact = { [weak self] (emoji: String) -> Void in self?.react(message, emoji) }
        openedMenu = menu
        host.present(menu, animated: true)
    }

    /// «Удалить у меня и у <имя>» — either side's messages, for both — and «Удалить у меня».
    private func deleteItems(_ keys: [String], done: @escaping () -> Void) -> [MessageMenuController.Item] {
        let shown = history.shown
        let messages = keys.compactMap { shown.messages[$0] }
        let everyone = !messages.isEmpty && messages.allSatisfy { ChatScreenActions.readable($0) }
        var items: [MessageMenuController.Item] = []
        if everyone {
            items.append(MessageMenuController.Item(symbol: "trash", label: "Удалить у меня и у " + peerName, danger: true, run: { [weak self] in
                for message in messages {
                    if let client = message["clientId"] as? String { self?.history.sendAction(["type": "delete", "target": client]) }
                }
                done()
            }))
        }
        items.append(MessageMenuController.Item(symbol: "eye.slash", label: "Удалить у меня", danger: true, run: { [weak self] in
            self?.history.hideForMe(messages.map { ChatHistory.key($0) })
            done()
        }))
        return items
    }

    private func copyWords(_ words: String) {
        UIPasteboard.general.string = words
        say("Скопировано")
    }

    // MARK: Answering, editing, the bar above the field

    private func startReply(_ message: [String: Any], focus: Bool) {
        if editing != nil { endEdit() }
        replyTo = message
        showBar()
        if focus { field?.becomeFirstResponder() }
    }

    /// «Изменить»: the message's text is edited in the field; the chat's draft is not touched and comes back after.
    private func startEdit(_ message: [String: Any], focus: Bool) {
        replyTo = nil
        editing = message
        field?.text = message["text"] as? String ?? ""
        showBar()
        if focus { field?.becomeFirstResponder() }
    }

    private func endEdit() {
        editing = nil
        field?.text = local?.draft(chatId) ?? sampleDraft
        showBar()
    }

    private func closeBar() {
        if editing != nil {
            endEdit()
        } else if replyTo != nil {
            replyTo = nil
            showBar()
        } else {
            forwardItems = []
            ForwardDraft.clear()
            showBar()
        }
    }

    private func showBar() {
        var hidden = false
        if let editing {
            composerBar.show(symbol: "square.and.pencil", heading: "Редактирование", words: Core.view("replyPreview", [editing]) as? String ?? "", closeWords: "Отменить редактирование")
        } else if let replyTo {
            let own = replyTo["senderId"] as? String == history.userId
            composerBar.show(symbol: "arrowshape.turn.up.left", heading: "Ответ " + (own ? "себе" : peerName), words: ChatHistory.quoteText(original: replyTo, stored: ""), closeWords: "Отменить ответ")
        } else if let first = forwardItems.first {
            let count = forwardItems.count
            let heading = count > 1 ? "Переслать \(count) \(count < 5 ? "сообщения" : "сообщений")" : "Переслать сообщение"
            composerBar.show(symbol: "arrowshape.turn.up.right", heading: heading, words: first.author + ": " + Messenger.previewText(first.message), closeWords: "Не пересылать")
        } else {
            hidden = true
        }
        composerBar.isHidden = hidden
        showSend()
        relayout()
    }

    /// The send button: a tick while editing (greyed over an empty field), the arrow otherwise.
    private func showSend() {
        guard let sendButton else { return }
        let symbol = editing != nil ? "checkmark.circle.fill" : "arrow.up.circle.fill"
        sendButton.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 28, weight: .regular)), for: .normal)
        let empty = (field?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let off = editing != nil && empty
        sendButton.isEnabled = !off
        sendButton.alpha = off ? 0.4 : 1
    }

    // MARK: Sending

    /// The send button: the edit, the forward with its comment, or the message (an answer when one is being written).
    func submit() {
        guard let field else { return }
        let text = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let editing {
            guard !text.isEmpty else { return }
            let changed = text != (editing["text"] as? String ?? "")
            if changed && !editWindowOpen(editing) {
                say(ChatScreenActions.editWindowClosed)
            } else if changed, let client = editing["clientId"] as? String {
                // The new text replaces the old one with its formatting (this field does not format yet).
                history.sendAction(["type": "edit", "target": client, "text": text])
            }
            endEdit()
            stopTyping()
            return
        }
        if !forwardItems.isEmpty {
            sendForward(comment: text)
            return
        }
        guard !text.isEmpty else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        var meta: [String: Any]? = nil
        if let replyTo, let client = replyTo["clientId"] as? String, let sender = replyTo["senderId"] as? String {
            let line = Core.view("replyPreview", [replyTo]) as? String ?? ""
            meta = ["reply": ["clientId": client, "senderId": sender, "preview": ChatForward.clipped(line, units: 200)]]
        }
        replyTo = nil
        history.send(text: text, meta: meta)
        clearField()
        showBar()
        list?.scrollToNewest(animated: true)
    }

    private func clearField() {
        field?.text = ""
        if let local { local.setDraft(chatId, "") } else { sampleDraft = "" }
        stopTyping()
        relayout()
    }

    // MARK: Forwarding

    /// Whose words a message carries: the first author, kept through further forwards.
    private func author(of message: [String: Any]) -> String {
        if let from = ((message["meta"] as? [String: Any])?["forward"] as? [String: Any])?["from"] as? String, !from.isEmpty { return from }
        if message["senderId"] as? String == history.userId { return messenger?.user["displayName"] as? String ?? "Ты" }
        return peerName
    }

    private func startForward(_ messages: [[String: Any]]) {
        guard let host, !messages.isEmpty else { return }
        let picker = ForwardPickerController(messenger: messenger, count: messages.count)
        let items = messages.map { ForwardDraft.Item(message: $0, author: author(of: $0)) }
        picker.onPick = { [weak self] (target: ForwardPickerController.Target) -> Void in
            guard let self else { return }
            self.history.selection = nil
            guard let messenger = self.messenger, target.summary != nil || target.chatId == self.chatId else {
                // The simulator's samples: nothing is sent anywhere.
                self.say("Переслано: " + target.name)
                return
            }
            // The chat opens with the forward waiting above the field: a comment can be added.
            ForwardDraft.put(chatId: target.chatId, items: items)
            if target.chatId == self.chatId {
                self.forwardItems = items
                self.showBar()
                return
            }
            guard let stack = self.host?.navigationController, let first = stack.viewControllers.first else { return }
            let screen = ChatViewController(name: target.name, messenger: messenger, chatId: target.chatId, peerId: target.peerId)
            if let summary = target.summary {
                screen.peerLastRead = summary.peerLastRead
                screen.actions.opened(summary)
            }
            stack.setViewControllers([first, screen], animated: true)
        }
        host.present(picker, animated: true)
    }

    private func sendForward(comment: String) {
        let items = forwardItems
        forwardItems = []
        ForwardDraft.clear()
        if !comment.isEmpty { history.send(text: comment, meta: nil) }
        clearField()
        showBar()
        list?.scrollToNewest(animated: true)
        guard messenger != nil else {
            for item in items {
                history.send(text: item.message["text"] as? String ?? "", meta: ["forward": ["from": item.author]])
            }
            return
        }
        forwardNext(items, 0)
    }

    /// One after another, in their order.
    private func forwardNext(_ items: [ForwardDraft.Item], _ index: Int) {
        guard let messenger, index < items.count else {
            history.load()
            return
        }
        ChatForward.send(messenger: messenger, chatId: chatId, peerId: peerId, message: items[index].message, author: items[index].author) { [weak self] (problem: String?) -> Void in
            guard let self else { return }
            if let problem {
                self.say(problem, danger: true)
                self.history.load()
                return
            }
            self.forwardNext(items, index + 1)
        }
    }

    // MARK: Choosing several

    private func toggle(_ key: String) {
        guard history.shown.messages[key] != nil, var chosen = history.selection else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        if chosen.contains(key) { chosen.remove(key) } else { chosen.insert(key) }
        history.selection = chosen.isEmpty ? nil : chosen
    }

    /// The chosen messages, oldest first.
    private func chosenMessages() -> [[String: Any]] {
        guard let chosen = history.selection else { return [] }
        let shown = history.shown
        return shown.order.filter { chosen.contains($0) }.compactMap { shown.messages[$0] }
    }

    private func showSelection() {
        let chosen = selecting
        if selectionHeader.isHidden == chosen {
            selectionHeader.isHidden = !chosen
            selectionBar.isHidden = !chosen
            if chosen { host?.view.endEditing(true) }
            relayout()
        }
        guard chosen else { return }
        let messages = chosenMessages()
        // «Копирование запрещено» binds the multi-select too: nothing leaves the chat; deleting stays.
        let locked = history.shown.noCopy
        let texts = messages.filter { !(($0["text"] as? String) ?? "").isEmpty }
        selectionHeader.show(count: messages.count, canCopy: !locked && !texts.isEmpty)
        selectionBar.show(export: !locked && !messages.isEmpty, chosen: !messages.isEmpty)
    }

    private func copySelected() {
        let words = chosenMessages().compactMap { $0["text"] as? String }.filter { !$0.isEmpty }.joined(separator: "\n\n")
        guard !words.isEmpty else { return }
        history.selection = nil
        copyWords(words)
    }

    private func forwardSelected() {
        let messages = chosenMessages().filter { ChatScreenActions.readable($0) && !ChatScreenActions.outgoing($0) }
        startForward(messages)
    }

    private func shareSelected() {
        let words = chosenMessages().compactMap { $0["text"] as? String }.filter { !$0.isEmpty }.joined(separator: "\n\n")
        guard let host, !words.isEmpty else { return }
        history.selection = nil
        let share = UIActivityViewController(activityItems: [words], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = selectionBar
        host.present(share, animated: true)
    }

    private func deleteSelected() {
        guard let host else { return }
        let keys = chosenMessages().map { ChatHistory.key($0) }
        guard !keys.isEmpty else { return }
        let choices = deleteItems(keys, done: { [weak self] in self?.history.selection = nil }).map { (item: MessageMenuController.Item) -> ChoiceSheet.Choice in
            ChoiceSheet.Choice(symbol: item.symbol, label: item.label, danger: true, run: item.run)
        }
        host.present(ChoiceSheet(heading: "Выбрано: \(keys.count)", choices: choices), animated: true)
    }

    // MARK: Going to a message

    /// A tap on a quote or on the pinned bar (the reference's replyJump.ts): when the original is not loaded yet,
    /// earlier pages are read one after another until it is there; then the list scrolls to it and it lights up.
    func jumpTo(_ clientId: String) {
        jump = (clientId: clientId, pages: 0)
        stepJump()
    }

    private func stepJump() {
        guard let wanted = jump else { return }
        let shown = history.shown
        if let key = shown.keyOfClient[wanted.clientId] {
            jump = nil
            if list?.jump(to: key) != true { say("Сообщение удалено") }
            return
        }
        if shown.noKey.contains(wanted.clientId) {
            jump = nil
            say("Сообщение недоступно на этом устройстве")
            return
        }
        if history.knownDeleted(wanted.clientId) {
            jump = nil
            say("Сообщение удалено")
            return
        }
        if history.loadingOlder { return }
        // The whole history is here and the message is not: it no longer exists.
        if !history.hasMore {
            jump = nil
            say("Сообщение удалено")
            return
        }
        if wanted.pages >= 30 {
            jump = nil
            say("Сообщение слишком далеко в истории")
            return
        }
        jump = (clientId: wanted.clientId, pages: wanted.pages + 1)
        history.load(older: true) { [weak self] (read: Bool) -> Void in
            if !read { self?.jump = nil }
        }
    }

    // MARK: The field

    func textViewDidChange(_ textView: UITextView) {
        let value = textView.text ?? ""
        // While a message is being edited the draft is not written: nothing of the edit can later go out as a new message.
        if editing == nil {
            if let local { local.setDraft(chatId, value) } else { sampleDraft = value }
        }
        if Date().timeIntervalSince(typingAt) > 1.5 {
            messenger?.live.typing(chatId: chatId, on: !value.isEmpty)
            typingAt = Date()
        }
        typingStop?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.messenger?.live.typing(chatId: self.chatId, on: false)
        }
        typingStop = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8, execute: work)
        showSend()
        relayout()
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        // A message holds at most 8000 UTF-16 units, as the server and the other phone expect.
        let now = ((textView.text ?? "") as NSString).length
        return now - range.length + (text as NSString).length <= 8000
    }

    private func stopTyping() {
        typingStop?.cancel()
        typingStop = nil
        typingAt = Date.distantPast
        messenger?.live.typing(chatId: chatId, on: false)
    }

    // MARK: The simulator check

    #if targetEnvironment(simulator)
    /// `-demo 1 -chat 1 -chatdemo <state>`: the sample chat as messages the core folds; with a state, what the
    /// actions leave in a chat (an answer with its quote, a forwarded message, reactions).
    private func simulatorSeed() {
        let state = UserDefaults.standard.string(forKey: "chatdemo") ?? ""
        history.seedDemo(extra: state)
        if state == "draft" {
            sampleDraft = "Не забыть спросить про проектор"
            field?.text = sampleDraft
        }
    }

    private var simulatorDone = false

    /// What the simulator check asks of an open chat, once its messages are on screen:
    ///   -chatdemo menu|delete|reply|edit|pinned|select|forward|quotes|typing|draft   the sample chat (with -demo 1 -chat 1)
    ///   -chataction menu|delete|reply|edit|pin|select|forward|react                  the first chat of an account (with -openchat 1)
    private func simulatorAct() {
        guard !simulatorDone else { return }
        simulatorDone = true
        let args = UserDefaults.standard
        let shown = history.shown
        let ask = messenger == nil ? args.string(forKey: "chatdemo") : args.string(forKey: "chataction")
        guard let ask, !ask.isEmpty, let host else { return }
        let all = shown.order.compactMap { shown.messages[$0] }.filter { ChatScreenActions.readable($0) && !ChatScreenActions.outgoing($0) }
        let theirs = all.filter { $0["senderId"] as? String != history.userId }
        let own = all.filter { $0["senderId"] as? String == history.userId }
        // The sample chat: always the same two messages, so the pictures can be compared.
        var incoming = theirs.last
        var outgoing = own.last(where: { editable($0) })
        if messenger == nil {
            incoming = shown.messages[ChatHistory.demoPeer + ":" + ChatHistory.demoClient(6)] ?? incoming
            outgoing = shown.messages[history.userId + ":" + ChatHistory.demoClient(5)] ?? outgoing
        }
        let middle = host.view.bounds.height * 0.45
        switch ask {
        case "menu":
            if let message = incoming ?? all.last { openMenu(ChatHistory.key(message), y: middle) }
        case "delete":
            if let message = incoming ?? all.last {
                let key = ChatHistory.key(message)
                openMenu(key, y: middle)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                    guard let self else { return }
                    self.openedMenu?.replace(items: self.deleteItems([key], done: {}))
                }
            }
        case "reply":
            if let message = incoming ?? all.last { startReply(message, focus: false) }
        case "edit":
            if let message = outgoing { startEdit(message, focus: false) }
        case "select":
            history.selection = Set(all.suffix(2).map { ChatHistory.key($0) })
        case "forward":
            if let message = incoming ?? all.last { startForward([message]) }
        case "pin":
            if shown.pinned == nil, let message = incoming ?? all.last, let client = message["clientId"] as? String {
                history.sendAction(["type": "pin", "target": client], targetText: message["text"] as? String ?? "")
            }
        case "react":
            if let message = incoming {
                let mine = (message["reactions"] as? [[String: Any]] ?? []).contains { $0["mine"] as? Bool == true }
                if !mine { react(message, "❤️") }
            }
        default:
            break
        }
    }
    #endif
}
