import UIKit

/// ChatsPlus: chat folders (the reference's ChatFolders.tsx and SettingsScreen.tsx `FoldersSection`): tabs above
/// the chat list — «Все», then the person's own folders made of chosen chats —, a sideways swipe over the list that
/// walks them, and the editor. Folders are kept on this device only: the server does not learn how chats are
/// grouped. No bar at all until a folder exists (made in Настройки → Папки с чатами, or from a tab's long press).
struct ChatFolder: Equatable {
    let id: String
    let name: String
    let chatIds: [String]
}

/// One shared copy per account: the chat list's tabs and the settings page stay in step. Main queue.
final class ChatFolderStore {
    static let changed = Notification.Name("invizent.chat-folders")
    private static var byAccount: [String: ChatFolderStore] = [:]

    static func of(_ userId: String) -> ChatFolderStore {
        if let kept = byAccount[userId] { return kept }
        let made = ChatFolderStore(userId: userId)
        byAccount[userId] = made
        return made
    }

    private let key: String
    private(set) var folders: [ChatFolder] = []

    private init(userId: String) {
        key = "linea.folders.v1:" + userId
        // The reference's AsyncStorage entry, here in the app's own defaults; a broken entry is ignored.
        if let raw = UserDefaults.standard.string(forKey: key), let list = Core.value(raw) as? [Any] {
            folders = Array(list.compactMap { (item: Any) -> ChatFolder? in
                guard let fields = item as? [String: Any], let id = fields["id"] as? String, let name = fields["name"] as? String, let ids = fields["chatIds"] as? [Any] else { return nil }
                return ChatFolder(id: id, name: name, chatIds: ids.compactMap { $0 as? String })
            }.prefix(20))
        }
    }

    private func save(_ next: [ChatFolder]) {
        folders = next
        let plain: [[String: Any]] = next.map { ["id": $0.id, "name": $0.name, "chatIds": $0.chatIds] }
        if let json = Core.text(plain) { UserDefaults.standard.set(json, forKey: key) }
        NotificationCenter.default.post(name: ChatFolderStore.changed, object: self)
    }

    func upsert(_ folder: ChatFolder) {
        if folders.contains(where: { $0.id == folder.id }) { save(folders.map { $0.id == folder.id ? folder : $0 }) }
        else { save(folders + [folder]) }
    }

    func remove(_ id: String) { save(folders.filter { $0.id != id }) }

    /// The reference lets a folder move one place up or down.
    func move(_ id: String, by delta: Int) {
        var list = folders
        guard let from = list.firstIndex(where: { $0.id == id }) else { return }
        let to = from + delta
        guard to >= 0, to < list.count else { return }
        list.swapAt(from, to)
        save(list)
    }

    /// The reference's `folderTabIds`: «Все», then the folders.
    var tabIds: [String] { ["all"] + folders.map { $0.id } }

    /// The reference's `matchesFolder` (`marked`: chats marked unread by hand count as unread).
    func matches(chatId: String, unread: Bool, filter: String) -> Bool {
        if filter == "all" { return true }
        if filter == "unread" { return unread }
        return folders.first(where: { $0.id == filter })?.chatIds.contains(chatId) ?? false
    }

    /// A new folder's id, as the reference makes it: «f» and the time in base 36.
    static func newId() -> String { "f" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) }
}

/// The bar of folder tabs: one glass bar across the screen; tabs share it equally while they fit (up to four
/// tabs with short names), else it scrolls. The chosen tab is a grey capsule that slides — with the finger while
/// the list is being swiped.
final class FolderTabsView: UIView {
    var onChange: ((String) -> Void)?
    var onEdit: ((ChatFolder) -> Void)?

    private let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let tint = UIView()
    private let scroller = UIScrollView()
    private let capsule = UIView()
    private var buttons: [UIButton] = []
    private var tabs: [(id: String, label: String, folder: ChatFolder?)] = []
    private(set) var filter = "all"
    /// The fractional index of the shown tab (the list drives it while a swipe is on).
    private var position: CGFloat = 0
    private var fits = true

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.layer.cornerRadius = 20
        glass.layer.cornerCurve = .continuous
        glass.clipsToBounds = true
        addSubview(glass)
        tint.isUserInteractionEnabled = false
        glass.contentView.addSubview(tint)
        scroller.showsHorizontalScrollIndicator = false
        scroller.alwaysBounceHorizontal = false
        glass.contentView.addSubview(scroller)
        capsule.isUserInteractionEnabled = false
        capsule.layer.cornerRadius = 16
        capsule.layer.cornerCurve = .continuous
        capsule.layer.borderWidth = 1 / max(1, UIScreen.main.scale)
        scroller.addSubview(capsule)
        accessibilityTraits = .tabBar
        paint()
    }

    required init?(coder: NSCoder) { return nil }

    func paint() {
        glass.effect = UIBlurEffect(style: Theme.dark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight)
        tint.backgroundColor = Theme.dark ? UIColor(white: 1, alpha: 0.04) : UIColor(white: 1, alpha: 0.72)
        capsule.backgroundColor = Theme.dark ? UIColor(white: 1, alpha: 0.16) : UIColor(red: 20 / 255, green: 30 / 255, blue: 60 / 255, alpha: 0.08)
        capsule.layer.borderColor = (Theme.dark ? UIColor(white: 1, alpha: 0.10) : UIColor(red: 20 / 255, green: 30 / 255, blue: 60 / 255, alpha: 0.08)).cgColor
        for button in buttons { button.setTitleColor(Theme.text, for: .normal) }
    }

    func set(folders: [ChatFolder], filter: String) {
        let next: [(id: String, label: String, folder: ChatFolder?)] = [(id: "all", label: "Все", folder: nil)] + folders.map { (id: $0.id, label: $0.name, folder: $0) }
        let same = next.map { $0.id + "|" + $0.label } == tabs.map { $0.id + "|" + $0.label }
        tabs = next
        if !same {
            buttons.forEach { $0.removeFromSuperview() }
            buttons = tabs.enumerated().map { (pair: (offset: Int, element: (id: String, label: String, folder: ChatFolder?))) -> UIButton in
                let index = pair.offset, tab = pair.element
                let button = UIButton(type: .custom)
                button.setTitle(tab.label, for: .normal)
                button.titleLabel?.font = AppFont.text(14, .semibold)
                button.titleLabel?.lineBreakMode = .byTruncatingTail
                button.setTitleColor(Theme.text, for: .normal)
                button.tag = index
                button.accessibilityTraits = .button
                button.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
                let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
                button.addGestureRecognizer(hold)
                scroller.addSubview(button)
                return button
            }
            let letters = tabs.reduce(0) { $0 + $1.label.count }
            fits = tabs.count <= 4 && letters <= 28
        }
        self.filter = filter
        position = CGFloat(max(0, tabs.firstIndex(where: { $0.id == filter }) ?? 0))
        for (index, button) in buttons.enumerated() { button.isSelected = index < tabs.count && tabs[index].id == filter }
        setNeedsLayout()
        layoutIfNeeded()
    }

    /// The highlight follows a swipe: `value` is the fractional index of the shown tab.
    func follow(_ value: CGFloat, animated: Bool) {
        position = value
        if animated {
            UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: { self.placeCapsule() })
        } else {
            placeCapsule()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        tint.frame = glass.contentView.bounds
        scroller.frame = glass.contentView.bounds
        let height: CGFloat = 32
        var x: CGFloat = 4
        if fits {
            let each = (bounds.width - 8 - CGFloat(max(0, buttons.count - 1)) * 2) / CGFloat(max(1, buttons.count))
            for button in buttons {
                button.frame = CGRect(x: x, y: (bounds.height - height) / 2, width: each, height: height)
                x += each + 2
            }
            scroller.contentSize = scroller.bounds.size
        } else {
            for button in buttons {
                let width = ceil(button.titleLabel?.sizeThatFits(CGSize(width: 400, height: height)).width ?? 40) + 24
                button.frame = CGRect(x: x, y: (bounds.height - height) / 2, width: width, height: height)
                x += width + 2
            }
            scroller.contentSize = CGSize(width: x + 2, height: bounds.height)
        }
        placeCapsule()
    }

    private func placeCapsule() {
        guard !buttons.isEmpty else { capsule.alpha = 0; return }
        let p = max(0, min(CGFloat(buttons.count - 1), position))
        let i = Int(floor(p)), f = p - CGFloat(i)
        let a = buttons[i].frame, b = buttons[min(i + 1, buttons.count - 1)].frame
        capsule.alpha = 1
        capsule.frame = CGRect(x: a.minX + (b.minX - a.minX) * f, y: a.minY, width: a.width + (b.width - a.width) * f, height: a.height)
        if !fits {
            // A long bar scrolls to the chosen tab.
            let wanted = max(0, min(scroller.contentSize.width - scroller.bounds.width, capsule.frame.minX - 40))
            if abs(scroller.contentOffset.x - wanted) > 1 { scroller.contentOffset = CGPoint(x: wanted, y: 0) }
        }
    }

    @objc private func tapped(_ sender: UIButton) {
        guard sender.tag < tabs.count else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onChange?(tabs[sender.tag].id)
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, let index = recognizer.view?.tag, index < tabs.count, let folder = tabs[index].folder else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onEdit?(folder)
    }
}

/// A chat as the folder editor lists it.
struct FolderChat {
    let id: String
    let title: String
    let avatarColor: Int
    let initials: String
    let avatarUrl: String
    let avatarKey: String

    init(summary: Messenger.ChatSummary) {
        id = summary.id
        title = summary.title
        avatarColor = (summary.row["avatarColor"] as? NSNumber)?.intValue ?? Int(0xFF5E_7BFF)
        initials = summary.row["initials"] as? String ?? Messenger.initials(summary.title)
        avatarUrl = summary.row["avatarUrl"] as? String ?? ""
        avatarKey = summary.row["avatarKey"] as? String ?? ""
    }
}

/// A small round avatar: the person's picture when it is here, else their initials on their colour.
final class SmallAvatarView: UIView {
    private var chat: FolderChat?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        NotificationCenter.default.addObserver(self, selector: #selector(ready(_:)), name: ChatAvatarStore.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    func show(_ chat: FolderChat) {
        self.chat = chat
        setNeedsDisplay()
    }

    @objc private func ready(_ note: Notification) {
        if let key = note.object as? String, key == chat?.avatarKey { setNeedsDisplay() }
    }

    override func draw(_ rect: CGRect) {
        guard let chat, let context = UIGraphicsGetCurrentContext() else { return }
        let box = bounds
        context.addEllipse(in: box)
        context.clip()
        if !chat.avatarKey.isEmpty, let face = ChatAvatarStore.shared.image(key: chat.avatarKey, url: chat.avatarUrl), face.size.width > 0, face.size.height > 0 {
            let scale = max(box.width / face.size.width, box.height / face.size.height)
            let size = CGSize(width: face.size.width * scale, height: face.size.height * scale)
            face.draw(in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height))
            return
        }
        let value = UInt32(truncatingIfNeeded: chat.avatarColor)
        context.setFillColor(UIColor(hex: value & 0xFFFFFF).cgColor)
        context.fill(box)
        let letters = NSAttributedString(string: chat.initials, attributes: [.font: AppFont.text(box.width * 0.36, .bold), .foregroundColor: UIColor.white])
        let size = letters.size()
        letters.draw(at: CGPoint(x: box.midX - size.width / 2, y: box.midY - size.height / 2))
    }
}

/// «Новая папка» / «Папка»: a name and the chats in it; «Удалить папку» for one that exists.
final class FolderEditorViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextFieldDelegate {
    var onSave: ((ChatFolder) -> Void)?
    var onDelete: ((String) -> Void)?

    private let folder: ChatFolder?
    private let chats: [FolderChat]
    private var picked: [String]
    private let heading = UILabel()
    private let close = UIButton(type: .system)
    private let field = UITextField()
    private let caption = UILabel()
    private let table = UITableView(frame: .zero, style: .plain)
    private let saveButton = UIButton(type: .system)
    private let deleteButton = UIButton(type: .system)

    init(folder: ChatFolder?, chats: [FolderChat]) {
        self.folder = folder
        self.chats = chats
        picked = folder?.chatIds ?? []
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController { sheet.detents = [.large()]; sheet.prefersGrabberVisible = true }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        heading.text = folder == nil ? "Новая папка" : "Папка"
        heading.font = AppFont.text(18, .bold)
        heading.textColor = Theme.text
        view.addSubview(heading)
        close.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        close.tintColor = Theme.muted
        close.accessibilityLabel = "Закрыть"
        close.addTarget(self, action: #selector(dismissSelf), for: .touchUpInside)
        view.addSubview(close)
        field.text = folder?.name ?? ""
        field.attributedPlaceholder = NSAttributedString(string: "Название, например «Работа»", attributes: [.foregroundColor: Theme.muted])
        field.font = AppFont.text(15)
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.backgroundColor = Theme.surface2
        field.layer.cornerRadius = 14
        field.layer.borderWidth = 1
        field.layer.borderColor = ThemeStore.look.border.cgColor
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        field.leftViewMode = .always
        field.keyboardAppearance = Theme.dark ? .dark : .light
        field.returnKeyType = .done
        field.delegate = self
        field.addTarget(self, action: #selector(changed), for: .editingChanged)
        view.addSubview(field)
        caption.attributedText = NSAttributedString(string: "ЧАТЫ В ПАПКЕ", attributes: [.kern: 1.2, .font: AppFont.text(11, .bold), .foregroundColor: Theme.muted])
        view.addSubview(caption)
        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.rowHeight = 50
        table.dataSource = self
        table.delegate = self
        table.keyboardDismissMode = .onDrag
        table.register(FolderChatCell.self, forCellReuseIdentifier: "chat")
        view.addSubview(table)
        saveButton.setTitle("  Сохранить", for: .normal)
        saveButton.setImage(UIImage(systemName: "folder", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        saveButton.titleLabel?.font = AppFont.text(16, .semibold)
        saveButton.layer.cornerRadius = 24
        saveButton.layer.cornerCurve = .continuous
        saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)
        view.addSubview(saveButton)
        deleteButton.setTitle("  Удалить папку", for: .normal)
        deleteButton.setImage(UIImage(systemName: "trash", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .regular)), for: .normal)
        deleteButton.titleLabel?.font = AppFont.text(15, .semibold)
        deleteButton.tintColor = Theme.danger
        deleteButton.setTitleColor(Theme.danger, for: .normal)
        deleteButton.accessibilityHint = "Чаты останутся во «Всех»"
        deleteButton.isHidden = folder == nil
        deleteButton.addTarget(self, action: #selector(remove), for: .touchUpInside)
        view.addSubview(deleteButton)
        refreshButton()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        heading.frame = CGRect(x: 20, y: 22, width: width - 80, height: 26)
        close.frame = CGRect(x: width - 52, y: 13, width: 44, height: 44)
        field.frame = CGRect(x: 16, y: 62, width: width - 32, height: 46)
        caption.frame = CGRect(x: 18, y: field.frame.maxY + 12, width: width - 36, height: 16)
        let bottom = view.bounds.height - view.safeAreaInsets.bottom - 12
        let deleteHeight: CGFloat = deleteButton.isHidden ? 0 : 44
        deleteButton.frame = CGRect(x: 16, y: bottom - deleteHeight, width: width - 32, height: deleteHeight)
        saveButton.frame = CGRect(x: 16, y: bottom - deleteHeight - (deleteHeight > 0 ? 6 : 0) - 48, width: width - 32, height: 48)
        let top = caption.frame.maxY + 6
        table.frame = CGRect(x: 0, y: top, width: width, height: max(0, saveButton.frame.minY - 10 - top))
    }

    private var ready: Bool { !(field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !picked.isEmpty }

    private func refreshButton() {
        saveButton.backgroundColor = Theme.accent
        saveButton.tintColor = Theme.onAccent
        saveButton.setTitleColor(Theme.onAccent, for: .normal)
        saveButton.isEnabled = ready
        saveButton.alpha = ready ? 1 : 0.45
    }

    @objc private func changed() {
        // maxLength 24, as in the reference.
        if let text = field.text, text.count > 24 { field.text = String(text.prefix(24)) }
        refreshButton()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return false
    }

    @objc private func dismissSelf() { dismiss(animated: true) }

    @objc private func save() {
        guard ready else { return }
        let name = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let made = ChatFolder(id: folder?.id ?? ChatFolderStore.newId(), name: name, chatIds: picked)
        dismiss(animated: true) { [onSave] in onSave?(made) }
    }

    @objc private func remove() {
        guard let folder else { return }
        dismiss(animated: true) { [onDelete] in onDelete?(folder.id) }
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { chats.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "chat", for: indexPath)
        if let row = cell as? FolderChatCell, indexPath.row < chats.count {
            let chat = chats[indexPath.row]
            row.show(chat, on: picked.contains(chat.id))
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        guard indexPath.row < chats.count else { return }
        let id = chats[indexPath.row].id
        if let at = picked.firstIndex(of: id) { picked.remove(at: at) } else { picked.append(id) }
        UISelectionFeedbackGenerator().selectionChanged()
        tableView.reloadRows(at: [indexPath], with: .none)
        refreshButton()
    }
}

/// A chat of the folder editor: avatar, name, a ticked or empty circle.
final class FolderChatCell: UITableViewCell {
    private let avatar = SmallAvatarView()
    private let name = UILabel()
    private let mark = UIImageView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        contentView.addSubview(avatar)
        name.font = AppFont.text(15)
        name.textColor = Theme.text
        contentView.addSubview(name)
        mark.contentMode = .center
        contentView.addSubview(mark)
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ chat: FolderChat, on: Bool) {
        avatar.show(chat)
        name.text = chat.title
        mark.image = UIImage(systemName: on ? "checkmark.circle.fill" : "circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 21, weight: .regular))
        mark.tintColor = on ? Theme.accent : Theme.subtle
        accessibilityLabel = chat.title
        accessibilityValue = on ? "в папке" : "не в папке"
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let h = contentView.bounds.height
        avatar.frame = CGRect(x: 16, y: (h - 38) / 2, width: 38, height: 38)
        mark.frame = CGRect(x: contentView.bounds.width - 16 - 28, y: (h - 28) / 2, width: 28, height: 28)
        name.frame = CGRect(x: 66, y: 0, width: mark.frame.minX - 66 - 8, height: h)
    }
}

/// Настройки → «Папки с чатами»: the folders, each one place up or down, «Создать папку», and the words that
/// folders stay on this device.
final class FoldersSettingsPage: SettingsPage {
    private let messenger: Messenger?
    private var chats: [FolderChat] = []

    init(messenger: Messenger?) {
        self.messenger = messenger
        super.init(name: "Папки с чатами")
    }

    required init?(coder: NSCoder) { return nil }

    private var store: ChatFolderStore { ChatFolderStore.of(messenger?.userId ?? "sample") }

    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(self, selector: #selector(foldersChanged), name: ChatFolderStore.changed, object: nil)
        messenger?.chats { [weak self] (result: Result<[Messenger.ChatSummary], ServerError>) -> Void in
            guard let self, case .success(let list) = result else { return }
            self.chats = list.map { FolderChat(summary: $0) }
        }
        #if targetEnvironment(simulator)
        if messenger == nil { chats = ChatListPlus.sampleFolderChats() }
        #endif
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func foldersChanged() { build() }

    override func build() {
        clear()
        let list = store.folders
        var rows: [UIView] = []
        if list.isEmpty {
            let words = UILabel()
            words.text = "Папок пока нет. Создай папку — она появится вкладкой над списком чатов."
            words.font = AppFont.text(13)
            words.textColor = Theme.muted
            words.numberOfLines = 0
            let holder = UIView()
            words.translatesAutoresizingMaskIntoConstraints = false
            holder.addSubview(words)
            NSLayoutConstraint.activate([
                words.topAnchor.constraint(equalTo: holder.topAnchor, constant: 16), words.bottomAnchor.constraint(equalTo: holder.bottomAnchor, constant: -16),
                words.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 16), words.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -16),
            ])
            rows.append(holder)
        } else {
            for (index, folder) in list.enumerated() {
                let row = FolderSettingsRow(folder: folder, first: index == 0, last: index == list.count - 1)
                row.onOpen = { [weak self] in self?.edit(folder) }
                row.onMove = { [weak self] (delta: Int) -> Void in self?.store.move(folder.id, by: delta) }
                rows.append(row)
            }
        }
        addGroup("Мои папки", rows: rows)
        let create = SettingsRow(symbol: "plus", label: "Создать папку", arrow: false)
        create.onPress = { [weak self] in self?.edit(nil) }
        addGroup(rows: [create])
        add(SettingsLook.caption("Папки хранятся только на этом устройстве; сервер не знает, как ты группируешь чаты."), gap: 8)
    }

    private func edit(_ folder: ChatFolder?) {
        let editor = FolderEditorViewController(folder: folder, chats: chats)
        editor.onSave = { [weak self] (made: ChatFolder) -> Void in self?.store.upsert(made) }
        editor.onDelete = { [weak self] (id: String) -> Void in self?.store.remove(id) }
        present(editor, animated: true)
    }
}

/// One folder on the settings page: its name and the number of chats, ▲ and ▼.
final class FolderSettingsRow: UIControl {
    var onOpen: (() -> Void)?
    var onMove: ((Int) -> Void)?
    private let icon = UIImageView()
    private let name = UILabel()
    private let count = UILabel()
    private let up = UIButton(type: .system)
    private let down = UIButton(type: .system)

    init(folder: ChatFolder, first: Bool, last: Bool) {
        super.init(frame: .zero)
        icon.image = UIImage(systemName: "folder", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular))
        icon.tintColor = Theme.accent
        icon.contentMode = .center
        addSubview(icon)
        name.text = folder.name
        name.font = AppFont.text(15, .semibold)
        name.textColor = Theme.text
        addSubview(name)
        count.text = String(folder.chatIds.count)
        count.font = AppFont.text(12)
        count.textColor = Theme.muted
        addSubview(count)
        up.setImage(UIImage(systemName: "chevron.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        up.tintColor = Theme.muted
        up.accessibilityLabel = "Выше"
        up.isEnabled = !first
        up.alpha = first ? 0.3 : 1
        up.addTarget(self, action: #selector(moveUp), for: .touchUpInside)
        addSubview(up)
        down.setImage(UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        down.tintColor = Theme.muted
        down.accessibilityLabel = "Ниже"
        down.isEnabled = !last
        down.alpha = last ? 0.3 : 1
        down.addTarget(self, action: #selector(moveDown), for: .touchUpInside)
        addSubview(down)
        addTarget(self, action: #selector(open), for: .touchUpInside)
        isAccessibilityElement = false
        heightAnchor.constraint(equalToConstant: 54).isActive = true
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = bounds.width, h = bounds.height
        icon.frame = CGRect(x: 14, y: (h - 24) / 2, width: 24, height: 24)
        down.frame = CGRect(x: w - 6 - 36, y: (h - 36) / 2, width: 36, height: 36)
        up.frame = CGRect(x: down.frame.minX - 36, y: (h - 36) / 2, width: 36, height: 36)
        name.frame = CGRect(x: 50, y: 9, width: up.frame.minX - 58, height: 20)
        count.frame = CGRect(x: 50, y: 29, width: up.frame.minX - 58, height: 16)
    }

    @objc private func open() { onOpen?() }
    @objc private func moveUp() { onMove?(-1) }
    @objc private func moveDown() { onMove?(1) }
}
