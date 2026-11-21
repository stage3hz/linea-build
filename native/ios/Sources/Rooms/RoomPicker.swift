import UIKit

/// «Выбрать» in the list of chats (the reference's «Изм.» with its «Звонок»): the people of the chats with a mark
/// by each; «Звонок» rings one person the ordinary way, and several at once — «Звонок · 3» — becomes a room:
/// the room of exactly these people is found or made, entered, and everyone is called.
final class RoomPickerController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    struct Choice {
        let chatId: String
        let person: Person
    }

    private let messenger: Messenger?
    private var everyone: [Choice] = []
    private var chosen: [String] = []
    private let headingLabel = UILabel()
    private let countLabel = UILabel()
    private let cancelButton = UIButton(type: .system)
    private let table = UITableView(frame: .zero, style: .plain)
    private let emptyLabel = UILabel()
    private let callButton = UIButton(type: .system)
    private let notice = UILabel()
    private var busy = false

    /// `first`: the chat the person held (its mark is already set).
    init(messenger: Messenger?, first: String) {
        self.messenger = messenger
        super.init(nibName: nil, bundle: nil)
        if !first.isEmpty { chosen = [first] }
        modalPresentationStyle = .pageSheet
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        headingLabel.text = "Чаты"
        headingLabel.font = .systemFont(ofSize: 17, weight: .bold)
        headingLabel.textColor = Theme.text
        headingLabel.textAlignment = .center
        view.addSubview(headingLabel)
        countLabel.font = .systemFont(ofSize: 12.5)
        countLabel.textColor = Theme.muted
        countLabel.textAlignment = .center
        view.addSubview(countLabel)
        cancelButton.setTitle("Отмена", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        cancelButton.tintColor = Theme.accent
        cancelButton.contentHorizontalAlignment = .left
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        view.addSubview(cancelButton)

        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.rowHeight = 64
        table.register(RoomPickerCell.self, forCellReuseIdentifier: "person")
        table.dataSource = self
        table.delegate = self
        view.addSubview(table)
        emptyLabel.text = "Загрузка…"
        emptyLabel.font = .systemFont(ofSize: 15)
        emptyLabel.textColor = Theme.muted
        emptyLabel.textAlignment = .center
        emptyLabel.numberOfLines = 0
        view.addSubview(emptyLabel)

        notice.font = .systemFont(ofSize: 13)
        notice.textColor = Theme.danger
        notice.textAlignment = .center
        notice.numberOfLines = 0
        view.addSubview(notice)
        callButton.setTitleColor(Theme.onAccent, for: .normal)
        callButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        callButton.backgroundColor = Theme.accent
        callButton.layer.cornerRadius = 25
        callButton.accessibilityLabel = "Позвонить выбранным"
        callButton.addTarget(self, action: #selector(call), for: .touchUpInside)
        view.addSubview(callButton)
        showCount()
        load()
    }

    private func load() {
        guard let messenger else {
            #if targetEnvironment(simulator)
            show(RoomsDemo.pickerChoices())
            #else
            show([])
            #endif
            return
        }
        messenger.chats { [weak self] (result: Result<[Messenger.ChatSummary], ServerError>) -> Void in
            guard let self else { return }
            switch result {
            case .success(let chats):
                var found: [Choice] = []
                for chat in chats {
                    guard let person = Person(chat.chat["peer"]) else { continue }
                    found.append(Choice(chatId: chat.id, person: person))
                }
                self.show(found)
            case .failure(let error):
                self.emptyLabel.text = error.words
                self.emptyLabel.isHidden = false
            }
        }
    }

    private func show(_ list: [Choice]) {
        everyone = list
        let known = Set(list.map { (choice: Choice) -> String in choice.chatId })
        chosen = chosen.filter { (id: String) -> Bool in known.contains(id) }
        emptyLabel.text = "Пока нет чатов"
        emptyLabel.isHidden = !list.isEmpty
        table.reloadData()
        showCount()
    }

    private func showCount() {
        countLabel.text = chosen.isEmpty ? "Отметь чаты" : "Выбрано: \(chosen.count)"
        callButton.setTitle(chosen.count > 1 ? "Звонок · \(chosen.count)" : "Звонок", for: .normal)
        let ready = !chosen.isEmpty && !busy
        callButton.isEnabled = ready
        callButton.alpha = ready ? 1 : 0.4
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, top = view.safeAreaInsets.top
        headingLabel.frame = CGRect(x: 100, y: top + 14, width: width - 200, height: 22)
        countLabel.frame = CGRect(x: 100, y: top + 36, width: width - 200, height: 16)
        cancelButton.frame = CGRect(x: 16, y: top + 12, width: 84, height: 40)
        let bottom = view.bounds.height - max(view.safeAreaInsets.bottom, 12) - 8
        callButton.frame = CGRect(x: 18, y: bottom - 50, width: width - 36, height: 50)
        var listBottom = callButton.frame.minY - 10
        if let words = notice.text, !words.isEmpty {
            let high = ceil(notice.sizeThatFits(CGSize(width: width - 36, height: 120)).height)
            notice.frame = CGRect(x: 18, y: listBottom - high, width: width - 36, height: high)
            listBottom -= high + 8
        }
        table.frame = CGRect(x: 0, y: top + 62, width: width, height: max(0, listBottom - top - 62))
        emptyLabel.frame = CGRect(x: 24, y: table.frame.midY - 30, width: width - 48, height: 60)
    }

    @objc private func cancel() { dismiss(animated: true) }

    /// One chosen person is an ordinary call; several become a room and everyone is called at once.
    @objc private func call() {
        guard !busy else { return }
        let picked = everyone.filter { (choice: Choice) -> Bool in chosen.contains(choice.chatId) }
        guard let first = picked.first else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if picked.count == 1 {
            let messenger = self.messenger
            dismiss(animated: true) {
                CallEntry.call(messenger: messenger, chatId: first.chatId, peerId: first.person.id, name: first.person.displayName, person: first.person, video: false)
            }
            return
        }
        guard messenger != nil else { return dismiss(animated: true) }
        busy = true
        notice.text = ""
        showCount()
        // The picker closes first: the room opens over «Каналы» underneath it.
        let ids = picked.map { (choice: Choice) -> String in choice.person.id }
        weak var presenter = presentingViewController
        dismiss(animated: true) {
            Rooms.shared.startCall(memberIds: ids) { (words: String?) -> Void in
                guard let words else { return }
                let alert = UIAlertController(title: nil, message: words, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
                var host: UIViewController? = RoomRouter.navigation()
                if host == nil { host = presenter }
                host?.present(alert, animated: true)
            }
        }
    }

    // MARK: The table

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { return everyone.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "person", for: indexPath)
        if let row = cell as? RoomPickerCell, indexPath.row < everyone.count {
            let choice = everyone[indexPath.row]
            row.show(choice.person, address: messenger?.personAvatarAddress(choice.person.avatarId) ?? "", checked: chosen.contains(choice.chatId))
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        guard indexPath.row < everyone.count else { return }
        let id = everyone[indexPath.row].chatId
        if let at = chosen.firstIndex(of: id) {
            chosen.remove(at: at)
        } else {
            // A room holds twelve, this account included.
            guard chosen.count < RoomRules.limit - 1 else {
                notice.text = "В комнате максимум \(RoomRules.limit) человек."
                return view.setNeedsLayout()
            }
            chosen.append(id)
        }
        notice.text = ""
        UISelectionFeedbackGenerator().selectionChanged()
        tableView.reloadRows(at: [indexPath], with: .none)
        showCount()
        view.setNeedsLayout()
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: marks the first few people.
    func simulatorChoose(_ count: Int) {
        chosen = everyone.prefix(count).map { (choice: Choice) -> String in choice.chatId }
        table.reloadData()
        showCount()
    }
    #endif
}

/// A person in «Выбрать»: the mark, the round picture, the name.
final class RoomPickerCell: UITableViewCell {
    private let mark = UIImageView()
    private let avatar = PersonAvatarView()
    private let nameLabel = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        let pressed = UIView()
        pressed.backgroundColor = Theme.veil(0.07)
        selectedBackgroundView = pressed
        mark.contentMode = .center
        nameLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        nameLabel.textColor = Theme.text
        for part in [mark, avatar, nameLabel] as [UIView] { contentView.addSubview(part) }
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ person: Person, address: String, checked: Bool) {
        mark.image = UIImage(systemName: checked ? "checkmark.circle.fill" : "circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .regular))
        mark.tintColor = checked ? Theme.accent : Theme.subtle
        avatar.show(person, address: address)
        nameLabel.text = person.displayName
        accessibilityLabel = person.displayName
        accessibilityTraits = checked ? [.button, .selected] : .button
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width
        mark.frame = CGRect(x: 16, y: 18, width: 28, height: 28)
        avatar.frame = CGRect(x: 54, y: 8, width: 48, height: 48)
        nameLabel.frame = CGRect(x: 114, y: 21, width: max(0, width - 114 - 20), height: 22)
    }
}
