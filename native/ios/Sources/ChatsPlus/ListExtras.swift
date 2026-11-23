import UIKit

/// ChatsPlus: «Архив» as the reference keeps it — above the first chat, out of sight until the list is pulled down
/// (ChatListScreen.tsx `archiveRow`): the box icon on a rounded square, «Архив» and how many chats are in it.
/// The list (Chats/ChatList.swift `setPull`) shows it while pulled and lets it settle open or shut.
final class ArchivePullView: UIControl {
    static let height: CGFloat = 78
    private let box = UIView()
    private let icon = UIImageView()
    private let heading = UILabel()
    private let count = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        box.backgroundColor = Theme.surface2
        box.layer.cornerRadius = 19
        box.layer.cornerCurve = .continuous
        box.isUserInteractionEnabled = false
        addSubview(box)
        icon.image = UIImage(systemName: "archivebox.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 21, weight: .regular))
        icon.tintColor = Theme.muted
        icon.contentMode = .center
        box.addSubview(icon)
        heading.text = "Архив"
        heading.font = Theme.font(15, .bold)
        heading.textColor = Theme.text
        addSubview(heading)
        count.font = Theme.font(12)
        count.textColor = Theme.muted
        addSubview(count)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    func set(count chats: Int) {
        count.text = "\(chats) " + ArchivePullView.plural(chats, "чат", "чата", "чатов")
        accessibilityLabel = "Архив, чатов: \(chats)"
    }

    static func plural(_ count: Int, _ one: String, _ few: String, _ many: String) -> String {
        let last = abs(count) % 10, tens = abs(count) % 100
        if last == 1 && tens != 11 { return one }
        if last >= 2 && last <= 4 && (tens < 12 || tens > 14) { return few }
        return many
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? Theme.veil(0.07) : .clear }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        box.frame = CGRect(x: 16, y: 12, width: 54, height: 54)
        icon.frame = box.bounds
        heading.frame = CGRect(x: 16 + 54 + 13, y: 20, width: bounds.width - 83 - 16, height: 19)
        count.frame = CGRect(x: 16 + 54 + 13, y: 41, width: bounds.width - 83 - 16, height: 16)
    }
}

/// ChatsPlus: people by @name inside the list's search (ChatSearch.tsx «Люди»): from two letters, the server's
/// people search (300 ms after the last letter); the people who already have a chat here are found among the chats,
/// the others come under «Люди». A touch opens the chat with the person (made when there is none yet).
final class ListPeopleSearch {
    private let messenger: Messenger?
    private var asked = ""
    private var answeredFor = ""
    private var found: [Person] = []
    private var soon: DispatchWorkItem?
    /// New people arrived: the rows are made again.
    var onChange: (() -> Void)?

    init(messenger: Messenger?) {
        self.messenger = messenger
    }

    private static func needle(_ query: String) -> String {
        return query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// The rows of «Люди» for the words in the field. `known`: the people the list's chats are with.
    func rows(query: String, known: Set<String>, me: String) -> [[String: Any]] {
        let wanted = ListPeopleSearch.needle(query)
        guard wanted.count >= 2 else {
            asked = ""
            soon?.cancel()
            return []
        }
        if wanted != asked {
            asked = wanted
            ask(wanted)
        }
        guard answeredFor == wanted else { return [] }
        var rows: [[String: Any]] = []
        for person in found where person.id != me && !known.contains(person.id) {
            let pair = orbPair(person.avatarColor)
            rows.append(["id": "user|" + person.id, "title": person.displayName.isEmpty ? "@" + person.username : person.displayName,
                         "preview": "@" + person.username, "time": "", "unread": 0, "initials": ListPeopleSearch.initials(person.displayName),
                         "avatarColor": Int(0xFF00_0000) | Int(person.avatarColor & 0xFF_FFFF), "orbA": pair.light, "orbB": pair.deep,
                         "section": rows.isEmpty ? "Люди" : "", "previewIcon": ""])
            // Avatars: as ChatSearch.tsx — the decorated avatar (still frame, art, ring, plate, Platina name) and the
            // emoji status after the name.
            if !person.displayName.isEmpty {
                rows[rows.count - 1].merge(ChatListDecor.fields(person.look, name: person.displayName)) { (_: Any, new: Any) -> Any in new }
                if let status = person.look.visibleStatus() { rows[rows.count - 1]["title"] = person.displayName + " " + status }
            }
        }
        return rows
    }

    func person(_ id: String) -> Person? { found.first { $0.id == id } }

    /// The reference's rule (components.tsx:149): one for every avatar, `Messenger.initials`.
    static func initials(_ name: String) -> String {
        return Messenger.initials(name)
    }

    private func ask(_ wanted: String) {
        soon?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.asked == wanted else { return }
            guard let messenger = self.messenger else {
                #if targetEnvironment(simulator)
                self.found = ListPeopleSearch.samples.filter { ($0.displayName + " " + $0.username).lowercased().contains(wanted.replacingOccurrences(of: "@", with: "")) }
                self.answeredFor = wanted
                self.onChange?()
                #endif
                return
            }
            messenger.findPeople(wanted) { [weak self] (result: Result<[Person], ServerError>) -> Void in
                guard let self, self.asked == wanted else { return }
                switch result {
                case .success(let people): self.found = people
                case .failure: self.found = []
                }
                self.answeredFor = wanted
                self.onChange?()
            }
        }
        soon = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    #if targetEnvironment(simulator)
    static let samples: [Person] = [
        Person(id: "sample-p1", username: "mira_k", displayName: "Мира Ковалёва", bio: "", birthday: "", avatarColor: 0x5B8DEF, avatarId: ""),
        Person(id: "sample-p2", username: "mark.s", displayName: "Марк Соловьёв", bio: "", birthday: "", avatarColor: 0x3FAE8C, avatarId: ""),
        Person(id: "sample-p3", username: "marina", displayName: "Марина Летова", bio: "", birthday: "", avatarColor: 0xD08A3E, avatarId: ""),
    ]
    #endif
}
