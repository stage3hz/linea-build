import UIKit

/// A forward that waits above the field of the chat it goes to (the reference's forward/forwardDraft.ts): the
/// chat opens with «Переслать сообщение» over the field, a comment can be written, and sending sends both.
/// Kept in memory only, for one chat at a time. Main queue only.
enum ForwardDraft {
    struct Item {
        /// The message as it is shown (decrypted, edits applied).
        let message: [String: Any]
        /// Whose words they are: the first author, kept through further forwards.
        let author: String
    }

    private(set) static var chatId = ""
    private(set) static var items: [Item] = []

    static func put(chatId: String, items: [Item]) {
        ForwardDraft.chatId = chatId
        ForwardDraft.items = items
    }

    static func waiting(for chatId: String) -> [Item] {
        ForwardDraft.chatId == chatId ? items : []
    }

    static func clear() {
        chatId = ""
        items = []
    }
}

/// Sending a message on to another chat. It is encrypted anew for that chat; a file is downloaded, opened here,
/// sealed with a new key and uploaded again as a new encrypted file (the key of the first one is never reused).
enum ChatForward {
    /// At most `units` UTF-16 units of a text, never cutting a character in two.
    static func clipped(_ text: String, units: Int) -> String {
        if text.utf16.count <= units { return text }
        var out = ""
        var used = 0
        for character in text {
            let size = String(character).utf16.count
            if used + size > units { break }
            out.append(character)
            used += size
        }
        return out
    }

    /// Sends one message on. The answer comes on the main queue: nil when it went (or will go by itself when the
    /// connection is back), else the words for the person.
    static func send(messenger: Messenger, chatId: String, peerId: String, message: [String: Any], author: String, done: @escaping (String?) -> Void) {
        let text = message["text"] as? String ?? ""
        let original = message["attachment"] as? [String: Any]
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && original == nil {
            done("Пустое сообщение нельзя переслать.")
            return
        }
        let from = clipped(author.trimmingCharacters(in: .whitespacesAndNewlines), units: 80)
        // The formatting travels with the forwarded text; an answer's quote, reactions and albums do not.
        var meta: [String: Any] = ["forward": ["from": from.isEmpty ? "собеседник" : from]]
        if let entities = (message["meta"] as? [String: Any])?["entities"] as? [Any], !entities.isEmpty, !text.isEmpty { meta["entities"] = entities }
        let sentMeta = meta
        DispatchQueue.global(qos: .userInitiated).async {
            var attachment: Any = NSNull()
            if let original {
                switch copied(original, server: messenger.server) {
                case .success(let made): attachment = made
                case .failure(let failure):
                    DispatchQueue.main.async { done(failure.words) }
                    return
                }
            }
            let sentAttachment = attachment
            let clientId = UUID().uuidString.lowercased()
            messenger.crypto.run({ (crypto: CryptoService) -> Result<Void, CryptoFailure> in
                messenger.deliver(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: text, attachment: sentAttachment, meta: sentMeta)
            }, done: { (result: Result<Void, CryptoFailure>) -> Void in
                if case .failure(let failure) = result, failure.name != "NetworkError" {
                    done(failure.message.isEmpty ? "Не удалось переслать." : failure.message)
                    return
                }
                NotificationCenter.default.post(name: Messenger.changed, object: chatId)
                done(nil)
            })
        }
    }

    /// The comment of «Выбрать» → send: a plain message to another chat, end-to-end encrypted like any other
    /// (the reference's `store.send(target.id, comment, null)`). The answer comes on the main queue.
    static func sendText(messenger: Messenger, chatId: String, peerId: String, text: String, done: @escaping (String?) -> Void) {
        let clientId = UUID().uuidString.lowercased()
        messenger.crypto.run({ (crypto: CryptoService) -> Result<Void, CryptoFailure> in
            messenger.deliver(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: text, attachment: NSNull(), meta: NSNull())
        }, done: { (result: Result<Void, CryptoFailure>) -> Void in
            if case .failure(let failure) = result, failure.name != "NetworkError" {
                done(failure.message.isEmpty ? "Не удалось переслать." : failure.message)
                return
            }
            NotificationCenter.default.post(name: Messenger.changed, object: chatId)
            done(nil)
        })
    }

    /// «Выбрать» → send: to every chosen chat in turn, the comment first, then the messages in their order (the
    /// reference's `onSendMany`). «Избранное» among the targets is the caller's (`saved`). `done` gets the first
    /// problem, if any, on the main queue.
    static func sendMany(messenger: Messenger, targets: [ForwardPickerController.Target], comment: String, items: [ForwardDraft.Item], done: @escaping (String?) -> Void) {
        var steps: [(ForwardPickerController.Target, ForwardDraft.Item?)] = []
        for target in targets where !target.isSaved {
            if !comment.isEmpty { steps.append((target, nil)) }
            for item in items { steps.append((target, item)) }
        }
        func step(_ index: Int) {
            guard index < steps.count else { done(nil); return }
            let (target, item) = steps[index]
            let next: (String?) -> Void = { (problem: String?) -> Void in
                if let problem { done(problem); return }
                step(index + 1)
            }
            if let item {
                send(messenger: messenger, chatId: target.chatId, peerId: target.peerId, message: item.message, author: item.author, done: next)
            } else {
                sendText(messenger: messenger, chatId: target.chatId, peerId: target.peerId, text: comment, done: next)
            }
        }
        step(0)
    }

    /// «Переслано: Имя» or «Переслано в 3 чата» (the reference's notice; «Избранное» counts as a chat there).
    static func notice(_ targets: [ForwardPickerController.Target]) -> String {
        if targets.count == 1, let only = targets.first, !only.isSaved { return "Переслано: " + only.name }
        return "Переслано в \(targets.count) " + ScheduleModel.plural(targets.count, "чат", "чата", "чатов")
    }

    /// The file of a message as a new encrypted file on the server. Runs on a background queue.
    private static func copied(_ attachment: [String: Any], server: Server) -> Result<[String: Any], FileCore.Failure> {
        // A big file (a long video, a round video, a file over 20 MB) goes in encrypted chunks: it is taken down
        // chunk by chunk into a private file and goes up again the same way, under a new key.
        if ChunkCore.isChunked(attachment) { return copiedBig(attachment, server: server) }
        let unable = FileCore.Failure(words: "Не удалось переслать.")
        let about = FileCore.describe(attachment)
        if let refusal = about.refusal { return .failure(FileCore.Failure(words: refusal)) }
        guard let id = attachment["id"] as? String, let cipherSize = about.cipherSize else { return .failure(unable) }
        let sealed: Data
        switch server.downloadSealedFile(id: id, cipherSize: cipherSize, transfer: FileTransfer()) {
        case .success(let data): sealed = data
        case .failure(.words(let words)): return .failure(FileCore.Failure(words: words))
        case .failure: return .failure(FileCore.Failure(words: "Не удалось загрузить зашифрованный файл."))
        }
        let plain: Data
        switch FileCore.open(sealed, attachment: attachment) {
        case .success(let data): plain = data
        case .failure(let failure): return .failure(failure)
        }
        // A new key, nonce and key id: the same key never seals two uploads.
        guard let encryption = FileCore.call("newEncryption") as? [String: Any] else { return .failure(FileCore.Failure(words: "Шифрование ещё не готово. Попробуй ещё раз.")) }
        let again: Data
        switch FileCore.seal(plain, encryption: encryption) {
        case .success(let data): again = data
        case .failure(let failure): return .failure(failure)
        }
        let newId: String
        switch server.uploadSealedFile(again, transfer: FileTransfer()) {
        case .success(let made): newId = made
        case .failure(.words(let words)): return .failure(FileCore.Failure(words: words))
        case .failure: return .failure(unable)
        }
        let name = attachment["name"] as? String ?? "file"
        let type = attachment["mimeType"] as? String ?? "application/octet-stream"
        let media: Any = attachment["media"] ?? NSNull()
        let preview: Any = attachment["preview"] ?? NSNull()
        let parts: [Any] = [newId, name, type, plain.count, encryption, media, preview]
        guard let made = FileCore.call("attachment", parts) as? [String: Any] else { return .failure(unable) }
        return .success(made)
    }

    /// A file of the chunked scheme as a new chunked file on the server (the reference's forward: the file is
    /// opened here and sent again as a new encrypted file; the key of the first one is never reused). One 4 MiB
    /// chunk is in memory at a time; the opened copy lives in a private folder that goes as soon as this ends.
    /// Runs on a background queue.
    private static func copiedBig(_ attachment: [String: Any], server: Server) -> Result<[String: Any], FileCore.Failure> {
        let unable = FileCore.Failure(words: "Не удалось переслать.")
        let manager = FileManager.default
        let folder = manager.temporaryDirectory.appendingPathComponent("invizent-forward-" + UUID().uuidString, isDirectory: true)
        do {
            try manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        } catch {
            return .failure(FileCore.Failure(words: "Не удалось открыть файл."))
        }
        defer { try? manager.removeItem(at: folder) }
        let file = folder.appendingPathComponent("forward.bin")
        let quiet: (Int, Int) -> Void = { (_: Int, _: Int) -> Void in }
        switch BigFiles.download(server, attachment: attachment, to: file, transfer: BigTransfer(), progress: quiet) {
        case .failure(let failure): return .failure(failure)
        case .success: break
        }
        let name = attachment["name"] as? String ?? "file"
        let type = attachment["mimeType"] as? String ?? "application/octet-stream"
        // A video goes up under the video limit (the same for everyone), anything else under the file limit.
        let video = type.lowercased().hasPrefix("video/")
        switch BigFiles.upload(server, file: file, video: video, transfer: BigTransfer(), progress: quiet) {
        case .failure(let failure):
            return .failure(failure)
        case .success(let done):
            let media: Any = attachment["media"] ?? NSNull()
            let preview: Any = attachment["preview"] ?? NSNull()
            let parts: [Any] = [done.id, name, type, done.size, done.encryption, media, preview]
            guard let made = FileCore.call("attachment", parts) as? [String: Any] else { return .failure(unable) }
            return .success(made)
        }
    }
}

/// «Переслать» as the reference's forward/ForwardPicker.tsx: ✕, the title, «Выбрать»; a search; the folder tabs
/// («Все чаты» and the person's folders, Sources/ChatsPlus/ChatFolders.swift); «Избранное» and the chats. A tap
/// sends the messages to that one chat (`onPick`); «Выбрать» marks several chats and sends to all of them at once,
/// with an optional comment (`onSendMany`).
final class ForwardPickerController: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextViewDelegate {
    struct Target {
        let chatId: String
        let peerId: String
        let name: String
        let person: Person?
        /// The chat as the list knows it (nil in the simulator's samples).
        let summary: Messenger.ChatSummary?
        /// ChatsPlus: «Избранное» — the saved messages of this device, not a chat.
        var isSaved: Bool { chatId == ForwardPickerController.savedId }
    }
    /// ChatsPlus: the id of «Избранное» among the targets (never the id of a chat).
    static let savedId = "invizent-saved"
    /// ChatsPlus: «Избранное» as the first target (Sources/ChatsPlus/SavedMessages.swift).
    private var savedTarget: [Target] {
        if hideSaved { return [] }
        guard SavedMessages.shared(messenger) != nil else { return [] }
        return [Target(chatId: ForwardPickerController.savedId, peerId: "", name: "Избранное", person: nil, summary: nil)]
    }

    private let messenger: Messenger?
    private let count: Int
    /// The reference's `hideSaved`: forwarding from «Избранное» itself leaves it out of the list.
    private let hideSaved: Bool
    /// A chat was chosen (the picker is already closed).
    var onPick: ((Target) -> Void)?
    /// «Выбрать» → send: the chosen chats in the order of the list, and the comment (trimmed, maybe empty). The
    /// picker is already closed.
    var onSendMany: (([Target], String) -> Void)?

    private var everyone: [Target] = []
    private var shown: [Target] = []
    private var filterId = "all"
    private var selecting = false
    private var picked: Set<String> = []
    private var folders: [ChatFolder] = []

    private let closeButton = UIButton(type: .system)
    private let headingLabel = UILabel()
    private let selectButton = UIButton(type: .system)
    private let searchBox = UIView()
    private let searchIcon = UIImageView()
    private let searchField = UITextField()
    private let tabsScroll = UIScrollView()
    private var tabButtons: [UIButton] = []
    private let table = UITableView(frame: .zero, style: .plain)
    private let emptyLabel = UILabel()
    private let bottomBar = UIView()
    private let bottomLine = UIView()
    private let commentBox = UIView()
    private let commentView = UITextView()
    private let commentPlaceholder = UILabel()
    private let sendButton = UIButton(type: .custom)
    private let sendIcon = UIImageView()
    private let sendCount = UILabel()
    private var keyboardHeight: CGFloat = 0

    /// `count`: how many messages are being sent on.
    init(messenger: Messenger?, count: Int, hideSaved: Bool = false) {
        self.messenger = messenger
        self.count = count
        self.hideSaved = hideSaved
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
    }

    required init?(coder: NSCoder) { return nil }

    private var folderStore: ChatFolderStore { ChatFolderStore.of(messenger?.userId ?? "sample") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg

        closeButton.setImage(chatSymbol("xmark", 18, .semibold), for: .normal)
        closeButton.tintColor = Theme.text
        closeButton.backgroundColor = Theme.surface2
        closeButton.layer.cornerRadius = 22
        closeButton.accessibilityLabel = "Закрыть"
        closeButton.addTarget(self, action: #selector(cancelNow), for: .touchUpInside)
        view.addSubview(closeButton)

        headingLabel.text = count > 1 ? "Переслать (\(count))" : "Переслать"
        headingLabel.font = .systemFont(ofSize: 17, weight: .bold)
        headingLabel.textColor = Theme.text
        headingLabel.textAlignment = .center
        view.addSubview(headingLabel)

        selectButton.setTitle("Выбрать", for: .normal)
        selectButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        selectButton.setTitleColor(Theme.text, for: .normal)
        selectButton.backgroundColor = Theme.surface2
        selectButton.layer.cornerRadius = 22
        selectButton.addTarget(self, action: #selector(toggleSelecting), for: .touchUpInside)
        view.addSubview(selectButton)

        searchBox.backgroundColor = Theme.surface2
        searchBox.layer.cornerRadius = 20
        view.addSubview(searchBox)
        searchIcon.image = chatSymbol("magnifyingglass", 15)
        searchIcon.tintColor = Theme.muted
        searchIcon.contentMode = .center
        searchBox.addSubview(searchIcon)
        searchField.attributedPlaceholder = NSAttributedString(string: "Поиск", attributes: [.foregroundColor: Theme.muted])
        searchField.font = .systemFont(ofSize: 16)
        searchField.textColor = Theme.text
        searchField.tintColor = Theme.text
        searchField.keyboardAppearance = Theme.dark ? .dark : .light
        searchField.autocorrectionType = .no
        searchField.autocapitalizationType = .none
        searchField.returnKeyType = .search
        searchField.clearButtonMode = .whileEditing
        searchField.addTarget(self, action: #selector(queryChanged), for: .editingChanged)
        searchBox.addSubview(searchField)

        tabsScroll.showsHorizontalScrollIndicator = false
        tabsScroll.alwaysBounceHorizontal = true
        view.addSubview(tabsScroll)

        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.rowHeight = 62
        table.keyboardDismissMode = .onDrag
        table.register(ForwardCell.self, forCellReuseIdentifier: "target")
        table.dataSource = self
        table.delegate = self
        view.addSubview(table)
        emptyLabel.font = .systemFont(ofSize: 15)
        emptyLabel.textColor = Theme.muted
        emptyLabel.textAlignment = .center
        emptyLabel.text = "Загрузка…"
        view.addSubview(emptyLabel)

        // «Выбрать»: the comment and the send button at the bottom.
        bottomBar.backgroundColor = Theme.bg
        bottomBar.isHidden = true
        view.addSubview(bottomBar)
        bottomLine.backgroundColor = Theme.veil(0.1)
        bottomBar.addSubview(bottomLine)
        commentBox.backgroundColor = Theme.surface2
        commentBox.layer.cornerRadius = 20
        bottomBar.addSubview(commentBox)
        commentView.backgroundColor = .clear
        commentView.font = .systemFont(ofSize: 16)
        commentView.textColor = Theme.text
        commentView.tintColor = Theme.text
        commentView.keyboardAppearance = Theme.dark ? .dark : .light
        commentView.textContainerInset = UIEdgeInsets(top: 9, left: 0, bottom: 9, right: 0)
        commentView.textContainer.lineFragmentPadding = 0
        commentView.delegate = self
        commentBox.addSubview(commentView)
        commentPlaceholder.text = "Комментарий"
        commentPlaceholder.font = .systemFont(ofSize: 16)
        commentPlaceholder.textColor = Theme.muted
        commentBox.addSubview(commentPlaceholder)
        sendButton.backgroundColor = Theme.accent
        sendButton.layer.cornerRadius = 20
        sendButton.addTarget(self, action: #selector(sendNow), for: .touchUpInside)
        bottomBar.addSubview(sendButton)
        sendIcon.image = chatSymbol("arrow.up", 19, .semibold)
        sendIcon.tintColor = Theme.onAccent
        sendIcon.contentMode = .center
        sendIcon.isUserInteractionEnabled = false
        sendButton.addSubview(sendIcon)
        sendCount.font = .systemFont(ofSize: 15, weight: .bold)
        sendCount.textColor = Theme.onAccent
        sendCount.isUserInteractionEnabled = false
        sendButton.addSubview(sendCount)

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(foldersChanged), name: ChatFolderStore.changed, object: nil)
        buildTabs()
        refreshSend()
        load()
    }

    private func load() {
        guard let messenger else {
            #if targetEnvironment(simulator)
            everyone = savedTarget + PeopleDemo.friends.map { (person: Person) -> Target in
                Target(chatId: "demo-chat-" + person.id, peerId: person.id, name: person.displayName, person: person, summary: nil)
            }
            #endif
            filter()
            return
        }
        let local = ChatLocal.of(messenger)
        messenger.chats { [weak self] (result: Result<[Messenger.ChatSummary], ServerError>) -> Void in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.emptyLabel.text = error.words
                self.emptyLabel.isHidden = false
            case .success(let chats):
                self.everyone = self.savedTarget + chats.compactMap { (chat: Messenger.ChatSummary) -> Target? in
                    let last = ChatHistory.number((chat.chat["lastMessage"] as? [String: Any])?["id"])
                    if local.isRemoved(chat.id, lastMessageId: last) { return nil }
                    return Target(chatId: chat.id, peerId: chat.peerId, name: chat.title, person: Person(chat.chat["peer"]), summary: chat)
                }
                self.filter()
            }
        }
    }

    /// The reference's rows: the chats of the chosen tab matching the search; «Избранное» first, only under «Все
    /// чаты» and while «избранное» contains what is typed.
    private func filter() {
        let wanted = (searchField.text ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let store = folderStore
        let tab = filterId
        shown = everyone.filter { (target: Target) -> Bool in
            if target.isSaved { return tab == "all" && (wanted.isEmpty || "избранное".contains(wanted)) }
            if !store.matches(chatId: target.chatId, unread: false, filter: tab) { return false }
            if wanted.isEmpty { return true }
            return target.name.lowercased().contains(wanted) || (target.person?.username.lowercased().contains(wanted) ?? false)
        }
        emptyLabel.text = "Ничего не найдено"
        emptyLabel.isHidden = !shown.isEmpty
        table.reloadData()
    }

    // MARK: Folder tabs

    @objc private func foldersChanged() {
        buildTabs()
        filter()
    }

    /// «Все чаты» and the folders; no row at all while there are no folders (the reference: `tabs.length > 1`).
    private func buildTabs() {
        folders = folderStore.folders
        if filterId != "all" && !folders.contains(where: { $0.id == filterId }) { filterId = "all" }
        tabButtons.forEach { $0.removeFromSuperview() }
        tabButtons = []
        let tabs: [(String, String)] = [("all", "Все чаты")] + folders.map { ($0.id, $0.name) }
        for (index, tab) in tabs.enumerated() {
            let button = UIButton(type: .custom)
            button.tag = index
            button.setTitle(tab.1, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
            button.layer.cornerRadius = 17
            button.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
            button.accessibilityTraits = .button
            button.addTarget(self, action: #selector(tabTapped(_:)), for: .touchUpInside)
            tabsScroll.addSubview(button)
            tabButtons.append(button)
        }
        paintTabs()
        tabsScroll.isHidden = folders.isEmpty
        view.setNeedsLayout()
    }

    private func paintTabs() {
        let ids = ["all"] + folders.map { $0.id }
        for (index, button) in tabButtons.enumerated() {
            let on = index < ids.count && ids[index] == filterId
            button.backgroundColor = on ? Theme.surface2 : .clear
            button.layer.borderWidth = on ? 0 : 1
            button.layer.borderColor = Theme.veil(0.14).cgColor
            button.setTitleColor(on ? Theme.text : Theme.muted, for: .normal)
            button.isSelected = on
        }
    }

    @objc private func tabTapped(_ sender: UIButton) {
        let ids = ["all"] + folders.map { $0.id }
        guard sender.tag < ids.count else { return }
        filterId = ids[sender.tag]
        paintTabs()
        filter()
    }

    // MARK: Choosing several

    @objc private func toggleSelecting() {
        selecting.toggle()
        picked = []
        selectButton.setTitle(selecting ? "Отмена" : "Выбрать", for: .normal)
        bottomBar.isHidden = !selecting
        if !selecting { commentView.resignFirstResponder() }
        refreshSend()
        table.reloadData()
        view.setNeedsLayout()
    }

    private func refreshSend() {
        let size = picked.count
        sendButton.isEnabled = size > 0
        sendButton.alpha = size > 0 ? 1 : 0.4
        sendCount.text = size > 1 ? "\(size)" : nil
        sendCount.isHidden = size <= 1
        sendButton.accessibilityLabel = "Отправить в \(size)"
        view.setNeedsLayout()
    }

    @objc private func sendNow() {
        guard !picked.isEmpty else { return }
        // In the order of the list, as the reference keeps them in its set.
        let targets = everyone.filter { picked.contains($0.chatId) }
        let text = commentView.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let send = onSendMany
        dismiss(animated: true) { send?(targets, text) }
    }

    func textViewDidChange(_ textView: UITextView) {
        commentPlaceholder.isHidden = !textView.text.isEmpty
        view.setNeedsLayout()
    }

    /// The reference's `maxLength={4000}`.
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        let now = textView.text as NSString
        return now.replacingCharacters(in: range, with: text).utf16.count <= 4000
    }

    @objc private func keyboardMoved(_ note: Notification) {
        guard let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let local = view.convert(frame, from: nil)
        keyboardHeight = max(0, view.bounds.maxY - local.minY)
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        UIView.animate(withDuration: duration) { () -> Void in
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    @objc private func queryChanged() { filter() }
    @objc private func cancelNow() { dismiss(animated: true) }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        let top = view.safeAreaInsets.top + 12
        closeButton.frame = CGRect(x: 16, y: top + 4, width: 44, height: 44)
        let selectWidth = ceil(selectButton.intrinsicContentSize.width) + 32
        selectButton.frame = CGRect(x: width - 16 - selectWidth, y: top + 4, width: selectWidth, height: 44)
        let side = max(closeButton.frame.maxX, width - selectButton.frame.minX) + 8
        headingLabel.frame = CGRect(x: side, y: top + 4, width: max(0, width - side * 2), height: 44)
        searchBox.frame = CGRect(x: 16, y: top + 60, width: width - 32, height: 40)
        searchIcon.frame = CGRect(x: 10, y: 0, width: 22, height: 40)
        searchField.frame = CGRect(x: 36, y: 0, width: searchBox.bounds.width - 46, height: 40)
        var y = searchBox.frame.maxY + 10
        if !tabsScroll.isHidden {
            tabsScroll.frame = CGRect(x: 0, y: y, width: width, height: 34)
            var x: CGFloat = 16
            for button in tabButtons {
                let w = ceil(button.intrinsicContentSize.width)
                button.frame = CGRect(x: x, y: 0, width: w, height: 34)
                x += w + 6
            }
            tabsScroll.contentSize = CGSize(width: x + 10, height: 34)
            y += 34
        }
        y += 6
        table.frame = CGRect(x: 0, y: y, width: width, height: max(0, view.bounds.height - y))
        emptyLabel.frame = CGRect(x: 20, y: y + 40, width: width - 40, height: 22)

        // The bottom bar grows with the comment, 40 to 120 pt.
        let bottomInset = max(view.safeAreaInsets.bottom, keyboardHeight)
        let sendWidth: CGFloat = picked.count > 1 ? max(40, 24 + 22 + 4 + ceil(sendCount.intrinsicContentSize.width)) : 40
        let commentWidth = width - 24 - 8 - sendWidth
        let fitted = commentView.sizeThatFits(CGSize(width: max(1, commentWidth - 28), height: .greatestFiniteMagnitude)).height
        let commentHeight = min(120, max(40, ceil(fitted)))
        let barHeight = 10 + commentHeight + 10 + bottomInset
        bottomBar.frame = CGRect(x: 0, y: view.bounds.height - barHeight, width: width, height: barHeight)
        bottomLine.frame = CGRect(x: 0, y: 0, width: width, height: 1)
        commentBox.frame = CGRect(x: 12, y: 10, width: commentWidth, height: commentHeight)
        commentView.frame = CGRect(x: 14, y: 0, width: commentWidth - 28, height: commentHeight)
        commentView.isScrollEnabled = ceil(fitted) > 120
        commentPlaceholder.frame = CGRect(x: 14, y: 0, width: commentWidth - 28, height: 40)
        sendButton.frame = CGRect(x: commentBox.frame.maxX + 8, y: 10 + commentHeight - 40, width: sendWidth, height: 40)
        if picked.count > 1 {
            let countWidth = ceil(sendCount.intrinsicContentSize.width)
            let total = 22 + 4 + countWidth
            let start = (sendWidth - total) / 2
            sendIcon.frame = CGRect(x: start, y: 0, width: 22, height: 40)
            sendCount.frame = CGRect(x: start + 26, y: 0, width: countWidth, height: 40)
        } else {
            sendIcon.frame = CGRect(x: 0, y: 0, width: 40, height: 40)
        }
        let under = selecting ? barHeight + 10 : view.safeAreaInsets.bottom + 20
        table.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: max(0, under - view.safeAreaInsets.bottom), right: 0)
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { shown.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "target", for: indexPath)
        if let targetCell = cell as? ForwardCell, indexPath.row < shown.count {
            let target = shown[indexPath.row]
            targetCell.show(name: target.name, person: target.person, address: target.person.flatMap { messenger?.personAvatarAddress($0.avatarId) } ?? "")
            targetCell.mark(selecting ? picked.contains(target.chatId) : nil)
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        guard indexPath.row < shown.count else { return }
        let target = shown[indexPath.row]
        if selecting {
            if picked.contains(target.chatId) { picked.remove(target.chatId) } else { picked.insert(target.chatId) }
            tableView.reloadRows(at: [indexPath], with: .none)
            refreshSend()
            return
        }
        let pick = onPick
        dismiss(animated: true) { pick?(target) }
    }

    #if targetEnvironment(simulator)
    /// `-chatdemo forwardmany`: «Выбрать» on, the first two chats marked and a comment written.
    func simulatorChooseSeveral() {
        loadViewIfNeeded()
        if !selecting { toggleSelecting() }
        for target in shown.prefix(3) where !target.isSaved { picked.insert(target.chatId) }
        commentView.text = "Глянь, это про субботу"
        textViewDidChange(commentView)
        refreshSend()
        table.reloadData()
    }
    #endif
}

/// One chat of the picker: the person's round picture and name, a line under the name, and a round mark while
/// several are chosen.
private final class ForwardCell: UITableViewCell {
    private let avatar = PersonAvatarView(frame: .zero)
    private let nameLabel = UILabel()
    private let line = UIView()
    private let check = UIImageView()
    private let savedMark = UIImageView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        let pressed = UIView()
        pressed.backgroundColor = Theme.surface2
        selectedBackgroundView = pressed
        contentView.addSubview(avatar)
        nameLabel.font = .systemFont(ofSize: 17)
        nameLabel.textColor = Theme.text
        contentView.addSubview(nameLabel)
        line.backgroundColor = Theme.veil(0.1)
        contentView.addSubview(line)
        check.contentMode = .center
        check.layer.cornerRadius = 12
        check.clipsToBounds = true
        check.isHidden = true
        contentView.addSubview(check)
    }

    required init?(coder: NSCoder) { return nil }

    func show(name: String, person: Person?, address: String) {
        nameLabel.text = name
        accessibilityLabel = name
        if let person { avatar.show(person, address: address) }
        // ChatsPlus: «Избранное» has a round bookmark instead of a person's picture.
        avatar.isHidden = person == nil
        if person == nil && savedMark.superview == nil {
            savedMark.image = chatSymbol("bookmark.fill", 20)
            savedMark.tintColor = Theme.onAccent
            savedMark.backgroundColor = Theme.accent
            savedMark.contentMode = .center
            savedMark.layer.cornerRadius = 23
            savedMark.clipsToBounds = true
            contentView.addSubview(savedMark)
        }
        savedMark.isHidden = person != nil
    }

    /// nil: not choosing; else whether this chat is chosen.
    func mark(_ on: Bool?) {
        guard let on else {
            check.isHidden = true
            accessibilityTraits = .button
            setNeedsLayout()
            return
        }
        check.isHidden = false
        check.image = on ? chatSymbol("checkmark", 12, .bold) : nil
        check.tintColor = Theme.onAccent
        check.backgroundColor = on ? Theme.accent : .clear
        check.layer.borderWidth = on ? 0 : 1.5
        check.layer.borderColor = Theme.muted.cgColor
        accessibilityTraits = on ? [.button, .selected] : .button
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let height = contentView.bounds.height
        avatar.frame = CGRect(x: 16, y: (height - 46) / 2, width: 46, height: 46)
        savedMark.frame = avatar.frame
        let right: CGFloat = check.isHidden ? 16 : 16 + 24 + 14
        let left: CGFloat = 16 + 46 + 14
        nameLabel.frame = CGRect(x: left, y: 0, width: max(0, contentView.bounds.width - left - right), height: height)
        line.frame = CGRect(x: left, y: height - 1, width: max(0, contentView.bounds.width - left - (check.isHidden ? 0 : 54)), height: 1)
        check.frame = CGRect(x: contentView.bounds.width - 16 - 24, y: (height - 24) / 2, width: 24, height: 24)
    }
}
