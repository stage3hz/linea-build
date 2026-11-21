import UIKit

/// The members of a room as overlapping round pictures (a row of the list, the ring's banner): three at most.
final class RoomFacesView: UIView {
    private var rims: [UIView] = []
    private var faces: [PersonAvatarView] = []
    private var side: CGFloat = 40

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) { return nil }

    /// `ring`: the colour around the first picture (somebody is inside); the others are rimmed with the page's own.
    func show(_ people: [Person], size: CGFloat, ring: UIColor?) {
        side = size
        let shown = Array(people.prefix(3))
        while rims.count < shown.count {
            let rim = UIView()
            let face = PersonAvatarView()
            rim.addSubview(face)
            addSubview(rim)
            rims.append(rim)
            faces.append(face)
        }
        for index in rims.indices {
            rims[index].isHidden = index >= shown.count
            guard index < shown.count else { continue }
            rims[index].backgroundColor = index == 0 ? (ring ?? Theme.bg) : Theme.bg
            faces[index].show(shown[index], address: Rooms.shared.pictureAddress(shown[index]))
        }
        shownCount = shown.count
        setNeedsLayout()
    }

    private var shownCount = 0

    /// How wide the pictures are together.
    var wide: CGFloat {
        guard shownCount > 0 else { return 0 }
        let step = (side + 5) - side * 0.28
        return (side + 5) + CGFloat(shownCount - 1) * step
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let box = side + 5
        let step = box - side * 0.28
        for index in rims.indices {
            rims[index].frame = CGRect(x: CGFloat(index) * step, y: (bounds.height - box) / 2, width: box, height: box)
            rims[index].layer.cornerRadius = box / 2
            faces[index].frame = CGRect(x: 2.5, y: 2.5, width: side, height: side)
        }
    }
}

/// One room in the list of «Каналы». Somebody inside (or this phone is): a lit card with the people inside, how
/// many they are and «Зайти». Nobody: a quiet row — when the room was last used, and how many people it is for.
final class RoomRowView: UIControl {
    private let card = UIView()
    private let faces = RoomFacesView()
    private let nameLabel = UILabel()
    private let lineLabel = UILabel()
    private let countLabel = UILabel()
    private let enterButton = UIButton(type: .system)
    private(set) var lit = false
    private var roomId = ""
    var onOpen: ((String) -> Void)?
    var onEnter: ((String) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.isUserInteractionEnabled = false
        addSubview(card)
        addSubview(faces)
        nameLabel.textColor = Theme.text
        nameLabel.isUserInteractionEnabled = false
        addSubview(nameLabel)
        lineLabel.isUserInteractionEnabled = false
        addSubview(lineLabel)
        countLabel.font = .systemFont(ofSize: 12)
        countLabel.textColor = Theme.subtle
        countLabel.textAlignment = .right
        addSubview(countLabel)
        enterButton.setTitle("Зайти", for: .normal)
        enterButton.setTitleColor(Theme.bg, for: .normal)
        enterButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        enterButton.backgroundColor = Theme.text
        enterButton.layer.cornerRadius = 20
        enterButton.addTarget(self, action: #selector(enterPressed), for: .touchUpInside)
        addSubview(enterButton)
        addTarget(self, action: #selector(openPressed), for: .touchUpInside)
        isAccessibilityElement = false
        nameLabel.isAccessibilityElement = true
        nameLabel.accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    /// How tall a row of this kind is.
    var tall: CGFloat { lit ? 78 + 8 : 64 }

    func show(_ room: Room, me: String, here: Bool, busy: Bool) {
        roomId = room.id
        var inside = Set<String>()
        for member in room.inside { inside.insert(member.userId) }
        if here { inside.insert(me) }
        lit = !inside.isEmpty
        nameLabel.text = room.name
        let talk = RoomRules.talk
        if lit {
            card.backgroundColor = talk.withAlphaComponent(Theme.dark ? 0.06 : 0.10)
            card.layer.borderColor = talk.withAlphaComponent(0.28).cgColor
            card.layer.borderWidth = 1
            card.layer.cornerRadius = 26
            // This account is not drawn among the faces of its own room, unless it is there alone.
            let people = room.members.filter { (member: Person) -> Bool in inside.contains(member.id) && (inside.count <= 1 || member.id != me) }
            faces.show(people, size: 44, ring: talk)
            nameLabel.font = .systemFont(ofSize: 17, weight: .semibold)
            lineLabel.font = .systemFont(ofSize: 13)
            lineLabel.textColor = talk
            let count = RoomRules.insideLine(inside.count)
            lineLabel.text = here ? (inside.count > 1 ? "ты внутри · " + count : "ты внутри, пока один") : count
            nameLabel.accessibilityLabel = "Комната \(room.name), \(count)"
            alpha = 1
        } else {
            card.backgroundColor = .clear
            card.layer.borderWidth = 0
            card.layer.cornerRadius = 16
            faces.show(room.members.filter { (member: Person) -> Bool in member.id != me }, size: 42, ring: nil)
            nameLabel.font = .systemFont(ofSize: 16, weight: .semibold)
            lineLabel.font = .systemFont(ofSize: 13.5)
            lineLabel.textColor = Theme.muted
            lineLabel.text = room.awake ? "никого · ещё не спит" : RoomRules.sleepLine(room)
            nameLabel.accessibilityLabel = "Комната \(room.name), спит"
            alpha = room.awake ? 0.85 : 0.55
        }
        countLabel.text = "\(room.members.count) чел"
        countLabel.isHidden = lit
        enterButton.isHidden = !lit || here
        enterButton.isEnabled = !busy
        enterButton.alpha = busy ? 0.7 : 1
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        if lit {
            card.frame = CGRect(x: 12, y: 0, width: width - 24, height: 78)
            let facesWide = faces.wide
            faces.frame = CGRect(x: 12 + 14, y: 14, width: facesWide, height: 50)
            var right = width - 12 - 14
            if !enterButton.isHidden {
                let wide = ceil(enterButton.sizeThatFits(CGSize(width: 200, height: 40)).width) + 32
                enterButton.frame = CGRect(x: right - wide, y: 19, width: wide, height: 40)
                right -= wide + 12
            }
            let left = 12 + 14 + facesWide + 12
            nameLabel.frame = CGRect(x: left, y: 17, width: max(0, right - left), height: 22)
            lineLabel.frame = CGRect(x: left, y: 41, width: max(0, right - left), height: 18)
        } else {
            card.frame = CGRect(x: 12, y: 0, width: width - 24, height: 64)
            let facesWide = faces.wide
            faces.frame = CGRect(x: 20, y: 8, width: facesWide, height: 48)
            countLabel.frame = CGRect(x: width - 20 - 60, y: 22, width: 60, height: 20)
            let left = 20 + facesWide + 12
            nameLabel.frame = CGRect(x: left, y: 11, width: max(0, width - 20 - 64 - left), height: 21)
            lineLabel.frame = CGRect(x: left, y: 34, width: max(0, width - 20 - 64 - left), height: 19)
        }
    }

    override var isHighlighted: Bool {
        didSet {
            if lit {
                let rest: CGFloat = Theme.dark ? 0.06 : 0.10
                card.backgroundColor = RoomRules.talk.withAlphaComponent(isHighlighted ? 0.14 : rest)
            } else {
                card.backgroundColor = isHighlighted ? Theme.veil(0.07) : UIColor.clear
            }
        }
    }

    @objc private func openPressed() { onOpen?(roomId) }
    @objc private func enterPressed() { onEnter?(roomId) }
}

/// «Комнаты» in «Каналы» — the first thing there (the reference's `RoomsSection`): the rooms somebody is in on
/// top, the sleeping ones under them; without any room — how one is made. Nothing at all until the list is read.
/// Sits above the communities as the table's header and says how tall it wants to be.
final class RoomsSectionView: UIView {
    /// The section's height changed: the table gives it the room.
    var onResize: (() -> Void)?
    private let heading = UILabel()
    private let problem = UILabel()
    private let hintBox = UIView()
    private let hintDash = CAShapeLayer()
    private let hintIcon = UIImageView()
    private let hintWords = UILabel()
    private var rows: [RoomRowView] = []
    private var busy = ""
    private var problemWords = ""
    private var known = false
    private var empty = false
    /// How tall the section wants to be for the width it has.
    private(set) var tall: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        heading.attributedText = NSAttributedString(string: "КОМНАТЫ", attributes: [.kern: 1.2, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        heading.accessibilityTraits = .header
        addSubview(heading)
        problem.font = .systemFont(ofSize: 13)
        problem.textColor = Theme.danger
        problem.numberOfLines = 0
        addSubview(problem)
        hintDash.fillColor = UIColor.clear.cgColor
        hintDash.strokeColor = Theme.veil(0.18).cgColor
        hintDash.lineWidth = 1
        hintDash.lineDashPattern = [5, 4]
        hintBox.layer.addSublayer(hintDash)
        hintIcon.image = UIImage(systemName: "mic", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular))
        hintIcon.tintColor = Theme.text
        hintIcon.contentMode = .center
        hintIcon.backgroundColor = Theme.veil(0.08)
        hintIcon.layer.cornerRadius = 22
        hintIcon.clipsToBounds = true
        hintBox.addSubview(hintIcon)
        hintWords.text = "Комнат пока нет. В чатах удержи собеседника, нажми «Выбрать», отметь людей и позвони всем сразу — получится комната."
        hintWords.font = .systemFont(ofSize: 13.5)
        hintWords.textColor = Theme.muted
        hintWords.numberOfLines = 0
        hintBox.addSubview(hintWords)
        addSubview(hintBox)
        NotificationCenter.default.addObserver(self, selector: #selector(reload), name: Rooms.changed, object: nil)
        reload()
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func reload() {
        let list = Rooms.shared.rooms
        known = list != nil
        let shown = list ?? []
        empty = shown.isEmpty
        let me = Rooms.shared.userId
        let hereId = RoomVoice.shared.state?.roomId
        while rows.count < shown.count {
            let row = RoomRowView()
            row.onOpen = { (id: String) -> Void in RoomRouter.open(id) }
            row.onEnter = { [weak self] (id: String) -> Void in self?.enter(id) }
            addSubview(row)
            rows.append(row)
        }
        for index in rows.indices {
            rows[index].isHidden = index >= shown.count
            guard index < shown.count else { continue }
            rows[index].show(shown[index], me: me, here: hereId == shown[index].id, busy: busy == shown[index].id)
        }
        heading.isHidden = !known
        hintBox.isHidden = !known || !empty
        problem.text = problemWords
        problem.isHidden = problemWords.isEmpty || !known
        place()
    }

    /// «Зайти» on a row: the room opens and this phone walks in.
    private func enter(_ id: String) {
        guard let room = Rooms.shared.room(id) else { return }
        busy = id
        problemWords = ""
        RoomRouter.open(id)
        Rooms.shared.enter(room) { [weak self] (words: String?) -> Void in
            guard let self else { return }
            self.busy = ""
            self.problemWords = words ?? ""
            self.reload()
        }
        reload()
    }

    /// Lays the section out for its width; tells the table when the height it needs changed.
    private func place() {
        let width = bounds.width
        var y: CGFloat = 0
        if known && width > 0 {
            heading.frame = CGRect(x: 20, y: 10, width: width - 40, height: 18)
            y = 34
            if !problem.isHidden {
                let high = ceil(problem.sizeThatFits(CGSize(width: width - 40, height: 200)).height)
                problem.frame = CGRect(x: 20, y: y, width: width - 40, height: high)
                y += high + 6
            }
            if empty {
                let wordsWide = width - 24 - 12 - 44 - 12 - 12
                let high = max(44, ceil(hintWords.sizeThatFits(CGSize(width: wordsWide, height: 400)).height))
                hintBox.frame = CGRect(x: 12, y: y, width: width - 24, height: high + 24)
                hintIcon.frame = CGRect(x: 12, y: (high + 24 - 44) / 2, width: 44, height: 44)
                hintWords.frame = CGRect(x: 12 + 44 + 12, y: 12, width: wordsWide, height: high)
                hintDash.frame = hintBox.bounds
                hintDash.path = UIBezierPath(roundedRect: hintBox.bounds.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 20).cgPath
                y = hintBox.frame.maxY + 8
            } else {
                for row in rows where !row.isHidden {
                    row.frame = CGRect(x: 0, y: y, width: width, height: row.tall)
                    y += row.tall
                }
                y += 4
            }
        }
        if abs(y - tall) > 0.5 {
            tall = y
            onResize?()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        place()
    }
}
