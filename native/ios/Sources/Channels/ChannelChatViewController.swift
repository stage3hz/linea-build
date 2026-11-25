import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// A text channel: a conversation (avatar, name in the colour of the role, time, text) for a game server; a
/// feed of posts for a blog channel. Reference: mobile/src/communities/ChannelChat.tsx.
///
/// The screen itself does almost nothing: ChannelEngine reads, merges and lays out off the main thread, the
/// list (ChannelListView) puts finished rows into a table. Communities are not end-to-end encrypted, by the
/// reference's design: messages are sent and read as they are.
final class ChannelChatViewController: UIViewController, UITextViewDelegate, PHPickerViewControllerDelegate, KeepsTabBar {
    private let messenger: Messenger?
    private var community: Community
    private let channel: CommunityChannel
    /// The channel is the whole of a blog: the header shows the community itself.
    private let root: Bool
    private let engine: ChannelEngine
    private let list = ChannelListView()
    private let header = ChannelHeaderView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let notice = UIButton(type: .system)
    private let emptyIcon = UIImageView()
    private let emptyHeading = UILabel()
    private let emptyWords = UILabel()

    private let composer = UIVisualEffectView(effect: nil)
    /// The field's own plate (ChannelChat.tsx: surface2, radius 20, a 1 pt border).
    private let fieldBox = UIView()
    private let attachButton = UIButton(type: .system)
    private let field = UITextView()
    private let hint = UILabel()
    private let sendButton = UIButton(type: .system)
    private let busy = UIActivityIndicatorView(style: .medium)
    private let closedWords = UILabel()
    private let contextBar = UIView()
    private let contextIcon = UIImageView()
    private let contextWords = UILabel()
    private let contextClose = UIButton(type: .system)
    private let waitingStrip = UIStackView()

    private var reply: CommunityMessage?
    /// The message being changed (its text is in the field).
    private var editingMessage: CommunityMessage?
    private var replyAuthor = ""
    private var sending = false
    private var loadedOnce = false
    private var reportedRead = 0
    private var keyboardTop: CGFloat?
    private let opener = ChannelFileOpener()
    private var tools: [(symbol: String, label: String, action: () -> Void)] = []

    init(messenger: Messenger?, community: Community, channel: CommunityChannel, root: Bool) {
        self.messenger = messenger
        self.community = community
        self.channel = channel
        self.root = root
        engine = ChannelEngine(server: messenger?.server, communityId: community.id, channelId: channel.id, blog: community.blog,
                               meId: messenger?.userId ?? "", meUsername: messenger?.user["username"] as? String ?? "", ownerId: community.summary.ownerId)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var blog: Bool { return community.blog }
    private var canWrite: Bool { return community.can(blog ? Perm.post : Perm.send) }
    private var canModerate: Bool { return community.can(Perm.manageMessages) }

    // MARK: Building

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        view.addSubview(list)

        emptyIcon.image = IonIcon.image(blog ? "megaphone-outline" : "chatbubbles-outline", size: 40)
        emptyIcon.tintColor = Theme.subtle
        emptyIcon.contentMode = .center
        emptyHeading.font = Theme.title(Theme.TypeSize.emptyTitle) // Fonts
        emptyHeading.textColor = Theme.text
        emptyHeading.textAlignment = .center
        emptyWords.font = .systemFont(ofSize: 14)
        emptyWords.textColor = Theme.muted
        emptyWords.textAlignment = .center
        emptyWords.numberOfLines = 0
        for part in [emptyIcon, emptyHeading, emptyWords] as [UIView] {
            part.isHidden = true
            view.addSubview(part)
        }
        spinner.color = Theme.muted
        spinner.startAnimating()
        view.addSubview(spinner)

        header.onBack = { [weak self] in self?.navigationController?.popViewController(animated: true) }
        // CommunityScreen.tsx:146: a channel's header has the community's picture too, before «# name».
        header.showsAvatar = true
        view.addSubview(header)
        notice.titleLabel?.font = .systemFont(ofSize: 13)
        notice.titleLabel?.numberOfLines = 2
        notice.titleLabel?.textAlignment = .center
        notice.setTitleColor(Theme.danger, for: .normal)
        notice.backgroundColor = Theme.panel(UIColor(hex: 0x1B1C1E))
        notice.layer.cornerRadius = 12
        notice.isHidden = true
        notice.addTarget(self, action: #selector(noticePressed), for: .touchUpInside)
        view.addSubview(notice)

        buildComposer()
        showWords()

        list.onWidth = { [weak self] wide in self?.engine.setWidth(wide) }
        list.onNearTop = { [weak self] in self?.engine.loadOlder() }
        list.onPress = { [weak self] layout, hit in self?.pressed(layout, hit) }
        list.onLongPress = { [weak self] layout, y in self?.openMenu(layout, at: y) }
        engine.onPatch = { [weak self] patch in
            guard let self else { return }
            self.list.apply(patch)
            self.showEmpty()
        }
        engine.onLoaded = { [weak self] error, newest in self?.loaded(error, newest) }
        engine.onIncoming = { [weak self] id in self?.markRead(id) }
        engine.onOlderFailed = { [weak self] in self?.list.forgetAsked() }

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        if let messenger {
            NotificationCenter.default.addObserver(self, selector: #selector(event(_:)), name: Live.communityEvent, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(outboxChanged(_:)), name: ChannelOutbox.changed, object: nil)
            engine.load()
            if !blog { loadMembers(messenger) }
            showWaiting()
        } else {
            #if targetEnvironment(simulator)
            ChannelsDemo.fill(engine, blog: blog)
            #endif
        }
    }

    private func buildComposer() {
        // ChannelChat.tsx: a plain row on the page — «add-circle» (IconButton), the field (radius 20, surface2, a 1 pt
        // border, 14 × 9 inside), «arrow-up-circle» 34 (IconButton); 10 from the sides, 6 above, 8 under, 6 apart.
        composer.clipsToBounds = true
        composer.contentView.backgroundColor = Theme.bg
        view.addSubview(composer)
        fieldBox.backgroundColor = Theme.surface2
        fieldBox.layer.cornerRadius = 20
        fieldBox.layer.cornerCurve = .continuous
        fieldBox.layer.borderWidth = 1
        fieldBox.layer.borderColor = ThemeStore.look.border.cgColor
        fieldBox.isUserInteractionEnabled = false
        composer.contentView.addSubview(fieldBox)
        attachButton.setImage(IonIcon.image("add-circle", size: 23), for: .normal)
        attachButton.tintColor = Theme.muted
        attachButton.accessibilityLabel = "Прикрепить"
        attachButton.addTarget(self, action: #selector(attach), for: .touchUpInside)
        attachButton.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        GlassBacking.put(under: attachButton)
        composer.contentView.addSubview(attachButton)
        field.backgroundColor = .clear
        field.font = .systemFont(ofSize: 16)
        field.textColor = Theme.text
        field.tintColor = Theme.text
        field.keyboardAppearance = Theme.dark ? .dark : .light
        field.textContainerInset = UIEdgeInsets(top: 9, left: 0, bottom: 9, right: 0)
        field.textContainer.lineFragmentPadding = 0
        field.showsVerticalScrollIndicator = false
        field.delegate = self
        composer.contentView.addSubview(field)
        hint.font = .systemFont(ofSize: 16)
        hint.textColor = Theme.subtle
        hint.isAccessibilityElement = false
        composer.contentView.addSubview(hint)
        sendButton.setImage(IonIcon.image("arrow-up-circle", size: 34), for: .normal)
        sendButton.accessibilityLabel = "Отправить"
        sendButton.addTarget(self, action: #selector(sendNow), for: .touchUpInside)
        sendButton.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        GlassBacking.put(under: sendButton)
        composer.contentView.addSubview(sendButton)
        busy.color = Theme.accent
        composer.contentView.addSubview(busy)

        closedWords.font = .systemFont(ofSize: 13)
        closedWords.textColor = Theme.muted
        closedWords.textAlignment = .center
        view.addSubview(closedWords)

        contextBar.isHidden = true
        view.addSubview(contextBar)
        contextIcon.tintColor = Theme.accent
        contextIcon.contentMode = .center
        contextBar.addSubview(contextIcon)
        contextWords.font = .systemFont(ofSize: 13)
        contextWords.textColor = Theme.muted
        contextBar.addSubview(contextWords)
        contextClose.setImage(IonIcon.image("close", size: 18), for: .normal)
        contextClose.tintColor = Theme.text
        contextClose.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        GlassBacking.put(under: contextClose)
        contextClose.accessibilityLabel = "Отменить"
        contextClose.addTarget(self, action: #selector(dropContext), for: .touchUpInside)
        contextBar.addSubview(contextClose)

        waitingStrip.axis = .vertical
        waitingStrip.alignment = .trailing
        waitingStrip.spacing = 4
        view.addSubview(waitingStrip)
    }

    /// The words that depend on the community and on what the person may do in it.
    private func showWords() {
        header.avatar.show(community.summary)
        if root {
            header.setWords(community.summary.name, community.summary.countWords)
        } else {
            header.setWords("# " + channel.name, channel.topic.isEmpty ? community.summary.name : channel.topic)
        }
        hint.text = blog ? "Новая публикация" : "Написать в #" + channel.name
        field.accessibilityLabel = hint.text
        closedWords.text = blog ? "Публикуют только авторы канала." : "В этом канале нельзя писать."
        emptyHeading.text = blog ? "Пока нет публикаций" : "Это начало #" + channel.name
        emptyWords.text = blog ? (canWrite ? "Напиши первый пост — его увидят все подписчики." : "Новые посты появятся здесь.") : "Напиши что-нибудь, чтобы начать разговор."
        composer.isHidden = !canWrite
        closedWords.isHidden = canWrite
        showSend()
        viewIfLoaded?.setNeedsLayout()
    }

    /// The community was read again (its name, the person's rights in it).
    func update(_ changed: Community) {
        community = changed
        if isViewLoaded { showWords() }
    }

    /// The icons on the right of the header (a blog's channel carries the community's own).
    func setTools(_ items: [(symbol: String, label: String, action: () -> Void)]) {
        tools = items
        header.setTools(items)
    }

    private func showSend() {
        let ready = !(field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        sendButton.tintColor = ready ? Theme.accent : Theme.subtle // ChannelChat.tsx: accent with words, subtle without
        sendButton.isEnabled = ready && !sending
        sendButton.isHidden = sending
        if sending { busy.startAnimating() } else { busy.stopAnimating() }
        hint.isHidden = !(field.text ?? "").isEmpty
        attachButton.isHidden = editingMessage != nil
    }

    private func showEmpty() {
        let empty = loadedOnce && list.isEmpty
        for part in [emptyIcon, emptyHeading, emptyWords] as [UIView] { part.isHidden = !empty }
    }

    // MARK: Place

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if messenger != nil { ChannelsStore.shared.setViewing(channel.id) }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if messenger != nil { ChannelsStore.shared.setViewing("") }
    }

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
        header.safeTop = top
        header.frame = CGRect(x: 0, y: 0, width: width, height: top + ChannelHeaderView.height)
        notice.frame = CGRect(x: 12, y: header.frame.maxY + 6, width: width - 24, height: 40)
        var floor = keyboardTop.map { $0 - 8 } ?? (view.bounds.height - max(view.safeAreaInsets.bottom, 12))
        // The bar of the sections stays over a channel, as in the previous app: without the keyboard the field
        // stands above it.
        if keyboardTop == nil, let stack = navigationController as? NavigationController {
            let room = stack.barRoom(over: self)
            if room > 0 { floor = view.bounds.height - room }
        }
        if canWrite {
            // The row: 10 from the sides, 8 under; the attach button only while not editing (then the field starts at 10).
            let bottomPad: CGFloat = 8
            let rowBottom = floor - bottomPad + 8
            let fieldLeft: CGFloat = editingMessage == nil ? 10 + 44 + 6 : 10
            let fieldRight = width - 10 - 44 - 6
            let textWidth = max(10, fieldRight - fieldLeft - 28)
            let wanted = ceil(field.sizeThatFits(CGSize(width: textWidth, height: 1000)).height)
            let boxTall = min(140, max(40, wanted))
            field.isScrollEnabled = wanted > 140
            var rowTop = rowBottom - bottomPad - max(44, boxTall)
            if !contextBar.isHidden { rowTop -= 44 + 6 }
            composer.frame = CGRect(x: 0, y: rowTop - 6, width: width, height: view.bounds.height - (rowTop - 6))
            composer.layer.cornerRadius = 0
            let base = rowBottom - bottomPad - composer.frame.minY
            attachButton.isHidden = editingMessage != nil
            attachButton.frame = CGRect(x: 10, y: base - 44, width: 44, height: 44)
            fieldBox.frame = CGRect(x: fieldLeft, y: base - boxTall, width: fieldRight - fieldLeft, height: boxTall)
            field.frame = fieldBox.frame.insetBy(dx: 14, dy: 0)
            hint.frame = CGRect(x: fieldLeft + 14, y: base - boxTall + 9, width: textWidth, height: boxTall - 18)
            sendButton.frame = CGRect(x: width - 10 - 44, y: base - 44, width: 44, height: 44)
            busy.center = sendButton.center
            floor = composer.frame.minY
            if !contextBar.isHidden {
                // The reply / edit line: 8 more in (18 from the edge), the glyph 16, 8 apart, the close IconButton.
                contextBar.frame = CGRect(x: 10, y: composer.frame.minY + 6, width: width - 20, height: 44)
                contextIcon.frame = CGRect(x: 8, y: 0, width: 16, height: 44)
                contextWords.frame = CGRect(x: 32, y: 0, width: contextBar.bounds.width - 32 - 8 - 44 - 8, height: 44)
                contextClose.frame = CGRect(x: contextBar.bounds.width - 8 - 44, y: 0, width: 44, height: 44)
            }
            if !waitingStrip.arrangedSubviews.isEmpty {
                let count = CGFloat(waitingStrip.arrangedSubviews.count)
                let tallStrip = count * 34 + (count - 1) * 4
                waitingStrip.frame = CGRect(x: 12, y: floor - tallStrip - 6, width: width - 24, height: tallStrip)
                floor = waitingStrip.frame.minY
            }
        } else {
            closedWords.frame = CGRect(x: 16, y: floor - 44, width: width - 32, height: 44)
            floor = closedWords.frame.minY
        }
        list.frame = view.bounds
        list.setPad(top: header.frame.maxY + 6, bottom: view.bounds.height - floor + 8)
        spinner.center = CGPoint(x: width / 2, y: header.frame.maxY + 60)
        let middle = (header.frame.maxY + floor) / 2
        emptyIcon.frame = CGRect(x: 0, y: middle - 70, width: width, height: 48)
        emptyHeading.frame = CGRect(x: 24, y: middle - 14, width: width - 48, height: 24)
        emptyWords.frame = CGRect(x: 30, y: middle + 14, width: width - 60, height: 40)
    }

    // MARK: Reading

    private func loaded(_ error: String, _ newest: Int) {
        spinner.stopAnimating()
        if error.isEmpty {
            loadedOnce = true
            if notice.tag == 1 { hideNotice() }
            showEmpty()
            if newest > 0 { markRead(newest) }
        } else {
            say(error, retry: true)
        }
    }

    /// Tells the server the channel was read up to a message; an older server gets the community-wide mark.
    private func markRead(_ id: Int) {
        guard let messenger, id > reportedRead, viewIfLoaded?.window != nil else { return }
        reportedRead = id
        let communityId = community.id, channelId = channel.id
        messenger.server.ask("readChannel", [communityId, channelId, id]) { result in
            switch result {
            case .success(let body):
                ChannelsStore.shared.read(communityId: communityId, channelId: channelId, unread: (body["unread"] as? NSNumber)?.intValue ?? 0,
                                          mentions: (body["mentions"] as? NSNumber)?.intValue ?? 0, community: CommunitySummary(body["community"]))
            case .failure(.refused(_, let status, _, _)) where status == 404:
                messenger.server.ask("communityMe", [communityId, ["lastReadId": id]]) { _ in }
            case .failure:
                break
            }
        }
    }

    /// The members: their names and pictures, and the colour of each one's highest role (for the names).
    private func loadMembers(_ messenger: Messenger) {
        let snapshot = community
        messenger.server.op("communityMembers", [community.id]) { [weak self] result in
            guard case .success(let body) = result else { return }
            var authors: [String: ChannelAuthor] = [:]
            var colors: [String: UInt32] = [:]
            var people: [String: Person] = [:]
            for raw in (body as? [String: Any])?["members"] as? [[String: Any]] ?? [] {
                guard let user = raw["user"] as? [String: Any], let id = user["id"] as? String, let author = ChannelAuthor(user) else { continue }
                authors[id] = author
                if let person = Person(user) { people[id] = person }
                if let color = snapshot.nameColor(roleIds: raw["roleIds"] as? [String] ?? []) { colors[id] = color }
            }
            self?.engine.setMembers(authors: authors, roleColors: colors, people: people)
        }
    }

    @objc private func event(_ note: Notification) {
        guard let data = note.userInfo?["event"] as? [String: Any], let type = data["type"] as? String else { return }
        if type == "ready" {
            // The line is back: what arrived meanwhile is fetched and merged.
            if loadedOnce { engine.load() }
            return
        }
        guard data["communityId"] as? String == community.id else { return }
        if type == "community.message" || type == "community.message.deleted" { engine.socket(data) }
    }

    // MARK: Notices

    private func say(_ words: String, retry: Bool = false) {
        notice.setTitle(words, for: .normal)
        notice.tag = retry ? 1 : 0
        notice.isHidden = false
        if !retry {
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(hideNotice), object: nil)
            perform(#selector(hideNotice), with: nil, afterDelay: 5)
        }
        UIAccessibility.post(notification: .announcement, argument: words)
    }

    @objc private func hideNotice() { notice.isHidden = true }

    @objc private func noticePressed() {
        let again = notice.tag == 1
        hideNotice()
        if again {
            spinner.startAnimating()
            engine.load()
        }
    }

    // MARK: Writing

    func textViewDidChange(_ textView: UITextView) {
        showSend()
        view.setNeedsLayout()
    }

    private func clearField() {
        field.text = ""
        showSend()
        view.setNeedsLayout()
    }

    private func showContext() {
        if editingMessage != nil {
            contextIcon.image = IonIcon.image("create-outline", size: 16)
            contextWords.text = "Редактирование"
            contextBar.isHidden = false
        } else if let reply {
            contextIcon.image = IonIcon.image("return-down-forward", size: 16)
            contextWords.text = "Ответ " + replyAuthor + ": " + (reply.text.isEmpty ? "вложение" : reply.text.replacingOccurrences(of: "\n", with: " "))
            contextBar.isHidden = false
        } else {
            contextBar.isHidden = true
        }
        showSend()
        view.setNeedsLayout()
    }

    @objc private func dropContext() {
        reply = nil
        if editingMessage != nil {
            editingMessage = nil
            field.text = ""
        }
        showContext()
    }

    @objc private func sendNow() {
        guard let messenger, !sending else { return }
        let value = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        let communityId = community.id, channelId = channel.id
        sending = true
        showSend()
        if let changing = editingMessage {
            messenger.server.ask("editChannelMessage", [communityId, channelId, changing.id, value]) { [weak self] result in
                guard let self else { return }
                self.sending = false
                switch result {
                case .success(let body):
                    self.engine.put(body["message"], own: false)
                    self.editingMessage = nil
                    self.field.text = ""
                    self.showContext()
                case .failure(let error):
                    self.showSend()
                    self.say(error.words)
                }
            }
            return
        }
        // The key goes along: should no answer come and the message wait for a connection, the retry is the
        // same message for the server (no duplicate).
        let key = UUID().uuidString.lowercased()
        let answered = reply?.id ?? 0
        var fields: [String: Any] = ["text": value, "clientKey": key]
        if answered != 0 { fields["replyTo"] = answered }
        messenger.server.ask("sendChannelMessage", [communityId, channelId, fields]) { [weak self] result in
            guard let self else { return }
            self.sending = false
            switch result {
            case .success(let body):
                self.engine.put(body["message"], own: true)
                self.sent()
            case .failure(.refused(let message, _, _, _)):
                self.showSend()
                self.say(message)
            case .failure:
                // No answer: it waits for the connection and goes out by itself.
                let item = ChannelOutbox.Item(key: key, communityId: communityId, channelId: channelId, text: value, replyTo: answered)
                if ChannelOutbox.shared.add(item) {
                    self.sent()
                } else {
                    self.showSend()
                    self.say(ChannelOutbox.full)
                }
            }
        }
    }

    /// After a message has gone (or has been put to wait): the field is empty again and the list is at its end.
    private func sent() {
        reply = nil
        field.text = ""
        showContext()
        list.scrollToEnd()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    // MARK: Waiting for a connection

    @objc private func outboxChanged(_ note: Notification) {
        guard note.userInfo?["channelId"] as? String == channel.id else { return }
        if let message = note.userInfo?["message"] { engine.put(message, own: true) }
        showWaiting()
    }

    private func showWaiting() {
        for part in waitingStrip.arrangedSubviews {
            waitingStrip.removeArrangedSubview(part)
            part.removeFromSuperview()
        }
        let outbox = ChannelOutbox.shared
        for failure in outbox.refused where failure.item.channelId == channel.id {
            let key = failure.item.key
            waitingStrip.addArrangedSubview(WaitingChip(text: failure.item.text, state: "не отправлено", failed: true, spoken: "Не отправлено: " + failure.words,
                                                        onRetry: { ChannelOutbox.shared.retry(key) }, onClose: { ChannelOutbox.shared.dismiss(key) }))
        }
        for item in outbox.waiting where item.channelId == channel.id {
            let key = item.key
            waitingStrip.addArrangedSubview(WaitingChip(text: item.text, state: "ожидает отправки", failed: false, spoken: "", onRetry: nil, onClose: { ChannelOutbox.shared.cancel(key) }))
        }
        viewIfLoaded?.setNeedsLayout()
    }

    // MARK: Attaching

    @objc private func attach() {
        view.endEditing(true)
        let sheet = UIAlertController(title: "Прикрепить", message: "Каналы не шифруются сквозным шифрованием: файл увидят все, у кого есть доступ к каналу.", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Фото", style: .default, handler: { [weak self] _ in self?.pickPhoto() }))
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        sheet.popoverPresentationController?.sourceView = attachButton
        present(sheet, animated: true)
    }

    private func pickPhoto() {
        // Without a photo library given, the picker returns only a copy of the chosen picture: no permission.
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let messenger, let provider = results.first?.itemProvider, !sending else { return }
        guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else { return say("Не удалось обработать фото. Файл не отправлен.") }
        sending = true
        showSend()
        let caption = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let communityId = community.id, channelId = channel.id
        let server = messenger.server
        _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] (url: URL?, _: Error?) -> Void in
            // The file is the system's own temporary copy and exists only during this call. The picture is drawn
            // anew and written without anything of the original file (no EXIF, no place, no camera), as before
            // every upload in the reference; then it goes up in one request and the message points at it.
            var outcome: Result<Any, ServerError> = .failure(.network("Не удалось обработать фото. Файл не отправлен."))
            if let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                switch PhotoPrepare.prepare(source, fileSize: size) {
                case .failure(let failure):
                    outcome = .failure(.network(failure.words))
                case .success(let photo):
                    switch server.uploadPlainFile(photo.bytes, name: photo.name, mimeType: photo.mimeType, purpose: "channel") {
                    case .failure(let error):
                        outcome = .failure(error)
                    case .success(let uploaded):
                        var fields: [String: Any] = ["attachmentId": uploaded["id"] as? String ?? ""]
                        if !caption.isEmpty { fields["text"] = caption }
                        outcome = server.opAndWait("sendChannelMessage", [communityId, channelId, fields])
                    }
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.sending = false
                switch outcome {
                case .success(let body):
                    self.engine.put((body as? [String: Any])?["message"], own: true)
                    if !caption.isEmpty { self.field.text = "" }
                    self.showContext()
                    self.list.scrollToEnd()
                case .failure(let error):
                    self.showSend()
                    self.say(error.words)
                }
            }
        }
    }

    // MARK: Touches on rows

    private func pressed(_ layout: ChannelRowLayout, _ hit: ChannelHit) {
        let message = layout.message
        switch hit {
        case .row:
            view.endEditing(true)
        case .chip(let emoji):
            react(message, emoji)
        case .link(let address):
            openLink(address)
        case .author:
            // The reference (ChannelChat.tsx: the avatar and the name line of a run's first message) opens the mini
            // profile of a known author — the person's own one too — with «Написать» (MiniProfile.tsx `navigate`).
            guard !layout.row.blog, layout.row.header, !message.senderId.isEmpty else { return }
            view.endEditing(true)
            engine.person(message.senderId) { [weak self] (found: Person?) -> Void in
                guard let self, let person = found, self.viewIfLoaded?.window != nil, self.presentedViewController == nil else { return }
                self.showMiniProfile(person)
            }
        case .attachment:
            guard let file = message.attachment else { return }
            view.endEditing(true)
            if file.mimeType.hasPrefix("image/") {
                present(ChannelPhotoViewer(fileId: file.id), animated: true)
            } else if let messenger {
                opener.open(messenger.server, id: file.id, name: file.name, over: self)
            }
        case .invite:
            guard let messenger, let invite = layout.row.invite, invite.state == 2 else { return }
            view.endEditing(true)
            if invite.member {
                ChannelsRoute.openCommunity(from: self, messenger: messenger, id: invite.communityId)
            } else {
                ChannelsRoute.openInvite(from: self, messenger: messenger, code: invite.code)
            }
        }
    }

    /// The mini profile of a message's author; «Написать» opens the private chat with them.
    func showMiniProfile(_ person: Person) {
        MiniProfileViewController.present(person, messenger: messenger, from: self, onWrite: { [weak self] () -> Void in
            self?.writeTo(person)
        })
    }

    private func writeTo(_ person: Person) {
        guard let messenger else {
            #if targetEnvironment(simulator)
            navigationController?.pushViewController(ChatViewController(name: person.displayName), animated: true)
            #endif
            return
        }
        messenger.openChat(with: person, from: self) { [weak self] (error: ServerError?) -> Void in
            if let error { self?.say(error.words) }
        }
    }

    private func openLink(_ address: String) {
        if address.hasPrefix("mention:") {
            // «@name» leads to that person.
            guard let messenger else { return }
            let username = String(address.dropFirst("mention:".count))
            messenger.server.ask("users", ["@" + username]) { [weak self] result in
                guard let self, case .success(let body) = result else { return }
                let people = Person.list(body["users"])
                guard let person = people.first(where: { $0.username.lowercased() == username.lowercased() }), self.viewIfLoaded?.window != nil else { return }
                self.navigationController?.pushViewController(PersonProfileViewController(messenger: messenger, userId: person.id, name: person.displayName, person: person), animated: true)
            }
            return
        }
        // Only http and https are ever opened.
        guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: the menu of the newest message.
    func simulatorMenu() {
        if let layout = list.newest { openMenu(layout, at: view.bounds.midY) }
    }

    /// For the simulator check: the mini profile of the newest message's author, as a tap on the name opens it.
    func simulatorMini() {
        guard let layout = list.newest else { return }
        engine.person(layout.message.senderId) { [weak self] (found: Person?) -> Void in
            guard let self, let person = found else { return }
            self.showMiniProfile(person)
        }
    }
    #endif

    private func openMenu(_ layout: ChannelRowLayout, at y: CGFloat) {
        let message = layout.message
        let author = layout.row.author
        view.endEditing(true)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let me = messenger?.userId ?? ""
        let mine = message.senderId == me
        var actions: [ChannelMenuView.Action] = []
        if canWrite {
            actions.append(ChannelMenuView.Action(symbol: "arrow-undo-outline", label: "Ответить", danger: false, run: { [weak self] in self?.startReply(message, author: author) }))
        }
        if !message.text.isEmpty {
            actions.append(ChannelMenuView.Action(symbol: "copy-outline", label: "Скопировать", danger: false, run: { UIPasteboard.general.string = message.text }))
        }
        if mine && !message.text.isEmpty {
            actions.append(ChannelMenuView.Action(symbol: "create-outline", label: "Изменить", danger: false, run: { [weak self] in self?.startEdit(message) }))
        }
        if mine || canModerate {
            actions.append(ChannelMenuView.Action(symbol: "trash-outline", label: "Удалить", danger: true, run: { [weak self] in self?.remove(message) }))
        }
        let reactions = ChannelWords.quickReactions.map { (emoji: String) -> (emoji: String, chosen: Bool) in
            (emoji: emoji, chosen: message.reactions.contains { $0.emoji == emoji && $0.userIds.contains(me) })
        }
        let menu = ChannelMenuView(reactions: reactions, actions: actions, at: y, onReact: { [weak self] emoji in self?.react(message, emoji) })
        menu.show(in: navigationController?.view ?? view)
    }

    private func startReply(_ message: CommunityMessage, author: String) {
        editingMessage = nil
        reply = message
        replyAuthor = author
        showContext()
        field.becomeFirstResponder()
    }

    private func startEdit(_ message: CommunityMessage) {
        reply = nil
        editingMessage = message
        field.text = message.text
        showContext()
        field.becomeFirstResponder()
    }

    private func react(_ message: CommunityMessage, _ emoji: String) {
        guard let messenger else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        messenger.server.ask("reactChannelMessage", [community.id, channel.id, message.id, emoji]) { [weak self] result in
            switch result {
            case .success(let body): self?.engine.put(body["message"], own: false)
            case .failure(let error): self?.say(error.words)
            }
        }
    }

    private func remove(_ message: CommunityMessage) {
        guard let messenger else { return }
        messenger.server.ask("deleteChannelMessage", [community.id, channel.id, message.id]) { [weak self] result in
            switch result {
            case .success: self?.engine.removed(message.id)
            case .failure(let error): self?.say(error.words)
            }
        }
    }
}

/// A message that waits for a connection (or was refused), above the field.
final class WaitingChip: UIView {
    private let onRetry: (() -> Void)?
    private let onClose: () -> Void

    init(text: String, state: String, failed: Bool, spoken: String, onRetry: (() -> Void)?, onClose: @escaping () -> Void) {
        self.onRetry = onRetry
        self.onClose = onClose
        super.init(frame: .zero)
        backgroundColor = Theme.surface2
        layer.cornerRadius = 16
        let icon = UIImageView(image: IonIcon.image(failed ? "alert-circle-outline" : "time-outline", size: 14))
        icon.tintColor = failed ? Theme.danger : Theme.muted
        icon.setContentHuggingPriority(.required, for: .horizontal)
        let words = UILabel()
        words.text = text.replacingOccurrences(of: "\n", with: " ")
        words.font = .systemFont(ofSize: 14)
        words.textColor = Theme.text
        words.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let note = UILabel()
        note.text = state
        note.font = .systemFont(ofSize: 11)
        note.textColor = failed ? Theme.danger : Theme.muted
        note.setContentHuggingPriority(.required, for: .horizontal)
        note.setContentCompressionResistancePriority(.required, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [icon, words, note])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 8
        if onRetry != nil {
            let again = UIButton(type: .system)
            again.setImage(IonIcon.image("refresh-outline", size: 16), for: .normal)
            again.tintColor = Theme.muted
            again.accessibilityLabel = "Отправить ещё раз"
            again.addTarget(self, action: #selector(retryPressed), for: .touchUpInside)
            again.widthAnchor.constraint(equalToConstant: 28).isActive = true
            row.addArrangedSubview(again)
        }
        let close = UIButton(type: .system)
        close.setImage(IonIcon.image("close", size: 16), for: .normal)
        close.tintColor = Theme.muted
        close.accessibilityLabel = failed ? "Убрать" : "Отменить отправку"
        close.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
        close.widthAnchor.constraint(equalToConstant: 28).isActive = true
        row.addArrangedSubview(close)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 28),
        ])
        if !spoken.isEmpty { accessibilityLabel = spoken }
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func retryPressed() { onRetry?() }
    @objc private func closePressed() { onClose() }
}
