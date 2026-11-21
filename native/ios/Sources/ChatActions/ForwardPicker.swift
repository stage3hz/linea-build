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

    /// The file of a message as a new encrypted file on the server. Runs on a background queue.
    private static func copied(_ attachment: [String: Any], server: Server) -> Result<[String: Any], FileCore.Failure> {
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
}

/// «Переслать»: the chats to choose from, with a search by name.
final class ForwardPickerController: UIViewController, UITableViewDataSource, UITableViewDelegate {
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
        guard SavedMessages.shared(messenger) != nil else { return [] }
        return [Target(chatId: ForwardPickerController.savedId, peerId: "", name: "Избранное", person: nil, summary: nil)]
    }

    private let messenger: Messenger?
    private let count: Int
    /// A chat was chosen (the picker is already closed).
    var onPick: ((Target) -> Void)?

    private var everyone: [Target] = []
    private var shown: [Target] = []
    private let headingLabel = UILabel()
    private let cancelButton = UIButton(type: .system)
    private let searchBox = UIView()
    private let searchField = UITextField()
    private let table = UITableView(frame: .zero, style: .plain)
    private let emptyLabel = UILabel()

    /// `count`: how many messages are being sent on.
    init(messenger: Messenger?, count: Int) {
        self.messenger = messenger
        self.count = count
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        headingLabel.text = count > 1 ? "Переслать (\(count))" : "Переслать"
        headingLabel.font = .systemFont(ofSize: 17, weight: .bold)
        headingLabel.textColor = Theme.text
        headingLabel.textAlignment = .center
        view.addSubview(headingLabel)
        cancelButton.setTitle("Отмена", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        cancelButton.tintColor = Theme.accent
        cancelButton.contentHorizontalAlignment = .left
        cancelButton.addTarget(self, action: #selector(cancelNow), for: .touchUpInside)
        view.addSubview(cancelButton)
        searchBox.backgroundColor = Theme.surface2
        searchBox.layer.cornerRadius = 20
        view.addSubview(searchBox)
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
        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.rowHeight = 60
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

    private func filter() {
        let wanted = (searchField.text ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        shown = wanted.isEmpty ? everyone : everyone.filter { (target: Target) -> Bool in
            target.name.lowercased().contains(wanted) || (target.person?.username.lowercased().contains(wanted) ?? false)
        }
        emptyLabel.text = "Ничего не найдено"
        emptyLabel.isHidden = !shown.isEmpty
        table.reloadData()
    }

    @objc private func queryChanged() { filter() }
    @objc private func cancelNow() { dismiss(animated: true) }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        let top = view.safeAreaInsets.top + 14
        headingLabel.frame = CGRect(x: 100, y: top, width: width - 200, height: 44)
        cancelButton.frame = CGRect(x: 16, y: top, width: 84, height: 44)
        searchBox.frame = CGRect(x: 14, y: top + 50, width: width - 28, height: 40)
        searchField.frame = searchBox.bounds.insetBy(dx: 14, dy: 0)
        table.frame = CGRect(x: 0, y: top + 98, width: width, height: max(0, view.bounds.height - top - 98))
        table.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: view.safeAreaInsets.bottom + 12, right: 0)
        emptyLabel.frame = CGRect(x: 20, y: top + 140, width: width - 40, height: 22)
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { shown.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "target", for: indexPath)
        if let targetCell = cell as? ForwardCell, indexPath.row < shown.count {
            let target = shown[indexPath.row]
            targetCell.show(name: target.name, person: target.person, address: target.person.flatMap { messenger?.personAvatarAddress($0.avatarId) } ?? "")
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        guard indexPath.row < shown.count else { return }
        let target = shown[indexPath.row]
        let pick = onPick
        dismiss(animated: true) { pick?(target) }
    }
}

/// One chat of the picker: the person's round picture and name.
private final class ForwardCell: UITableViewCell {
    private let avatar = PersonAvatarView(frame: .zero)
    private let nameLabel = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        let pressed = UIView()
        pressed.backgroundColor = Theme.veil(0.07)
        selectedBackgroundView = pressed
        contentView.addSubview(avatar)
        nameLabel.font = .systemFont(ofSize: 17)
        nameLabel.textColor = Theme.text
        contentView.addSubview(nameLabel)
    }

    required init?(coder: NSCoder) { return nil }

    func show(name: String, person: Person?, address: String) {
        nameLabel.text = name
        accessibilityLabel = name
        if let person { avatar.show(person, address: address) }
        // ChatsPlus: «Избранное» has a round bookmark instead of a person's picture.
        avatar.isHidden = person == nil
        if person == nil && savedMark.superview == nil {
            savedMark.image = chatSymbol("bookmark.fill", 19)
            savedMark.tintColor = Theme.onAccent
            savedMark.backgroundColor = Theme.accent
            savedMark.contentMode = .center
            savedMark.layer.cornerRadius = 22
            savedMark.clipsToBounds = true
            contentView.addSubview(savedMark)
        }
        savedMark.isHidden = person != nil
    }
    private let savedMark = UIImageView()

    override func layoutSubviews() {
        super.layoutSubviews()
        avatar.frame = CGRect(x: 16, y: (contentView.bounds.height - 44) / 2, width: 44, height: 44)
        savedMark.frame = avatar.frame
        nameLabel.frame = CGRect(x: 72, y: 0, width: max(0, contentView.bounds.width - 88), height: contentView.bounds.height)
    }
}
