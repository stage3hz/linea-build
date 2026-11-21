import UIKit

// The voice channels of a game server (mobile/src/communities/CommunityScreen.tsx, MemberMenu.tsx, voice.ts): under a
// voice channel — who is in it, with the microphone and sound marks; a touch on a person opens the moderator's actions
// («Отключить микрофон», «Отключить звук», «Исключить», «Заблокировать» — each only with the right); while this phone
// is in one of the community's channels, a panel with «Микрофон», «Звук», «Динамик», «Выйти». The voice itself is the
// rooms' engine (Rooms/RoomVoice.swift), as in the reference: a full mesh of checked WebRTC connections, up to 12.

/// One person in a voice channel, as the server says (`VoiceMember` of the reference's types.ts).
struct CommunityVoiceMember: Equatable {
    let userId: String
    var muted: Bool
    var serverMuted: Bool
    var serverDeafened: Bool

    init(userId: String, muted: Bool, serverMuted: Bool, serverDeafened: Bool) {
        self.userId = userId
        self.muted = muted
        self.serverMuted = serverMuted
        self.serverDeafened = serverDeafened
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let userId = fields["userId"] as? String, !userId.isEmpty else { return nil }
        self.userId = userId
        muted = fields["muted"] as? Bool ?? false
        serverMuted = fields["serverMuted"] as? Bool ?? false
        serverDeafened = fields["serverDeafened"] as? Bool ?? false
    }

    static func list(_ raw: Any?) -> [CommunityVoiceMember] {
        return (raw as? [Any] ?? []).compactMap { CommunityVoiceMember($0) }
    }
}

/// What a row of a community's list is: a channel, or a person inside the voice channel above it.
enum CommunityRow {
    case channel(CommunityChannel)
    case member(channel: CommunityChannel, member: CommunityVoiceMember)
}

enum CommunityVoice {
    static let green = UIColor(hex: 0x2FD27A)

    /// Whether a touch on this person shows any action (`hasMemberActions`).
    static func hasActions(_ community: Community, me: String, userId: String) -> Bool {
        guard userId != community.summary.ownerId else { return false }
        return community.can(Perm.muteMembers) || community.can(Perm.deafenMembers) || (userId != me && (community.can(Perm.kick) || community.can(Perm.ban)))
    }

    /// The moderator's actions on a person (`MemberMenuItems`). The server checks the rights and the role order again.
    static func actions(_ community: Community, me: String, member: CommunityVoiceMember, name: String, messenger: Messenger?, failed: @escaping (String) -> Void) -> UIAlertController {
        let sheet = UIAlertController(title: name, message: nil, preferredStyle: .actionSheet)
        let isSelf = member.userId == me, owner = member.userId == community.summary.ownerId
        func run(_ operation: String, _ args: [Any]) {
            guard let messenger else { return }
            messenger.server.ask(operation, args) { (result: Result<[String: Any], ServerError>) -> Void in
                if case .failure(let error) = result { failed(error.words.isEmpty ? "Не получилось." : error.words) }
            }
        }
        if !owner && community.can(Perm.muteMembers) {
            sheet.addAction(UIAlertAction(title: member.serverMuted ? "Включить микрофон" : "Отключить микрофон", style: .default) { (_: UIAlertAction) -> Void in
                run("setMemberVoice", [community.id, member.userId, ["muted": !member.serverMuted]])
            })
        }
        if !owner && community.can(Perm.deafenMembers) {
            sheet.addAction(UIAlertAction(title: member.serverDeafened ? "Включить звук" : "Отключить звук", style: .default) { (_: UIAlertAction) -> Void in
                run("setMemberVoice", [community.id, member.userId, ["deafened": !member.serverDeafened]])
            })
        }
        if !isSelf && !owner && community.can(Perm.kick) {
            sheet.addAction(UIAlertAction(title: "Исключить", style: .destructive) { (_: UIAlertAction) -> Void in
                run("kickMember", [community.id, member.userId])
            })
        }
        if !isSelf && !owner && community.can(Perm.ban) {
            sheet.addAction(UIAlertAction(title: "Заблокировать", style: .destructive) { (_: UIAlertAction) -> Void in
                run("banMember", [community.id, member.userId, NSNull()])
            })
        }
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        return sheet
    }
}

/// A person inside a voice channel: a small round picture, the name (« (ты)» for oneself), the moderator's marks in
/// red, one's own muted microphone in grey.
final class VoiceMemberCell: UITableViewCell {
    private let avatar = PersonAvatarView()
    private let name = UILabel()
    private let deafMark = UIImageView(image: UIImage(systemName: "speaker.slash.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)))
    private let micMark = UIImageView(image: UIImage(systemName: "mic.slash.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)))

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        let pressed = UIView()
        pressed.backgroundColor = Theme.accent.withAlphaComponent(0.12)
        pressed.layer.cornerRadius = 8
        selectedBackgroundView = pressed
        avatar.layer.cornerRadius = 12
        avatar.clipsToBounds = true
        name.font = .systemFont(ofSize: 14)
        name.textColor = Theme.muted
        deafMark.tintColor = Theme.danger
        micMark.contentMode = .center
        deafMark.contentMode = .center
        for part in [avatar, name, deafMark, micMark] as [UIView] { contentView.addSubview(part) }
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ member: CommunityVoiceMember, person: Person?, me: String, address: String, actions: Bool) {
        let known = person ?? Person(id: member.userId, username: "", displayName: "Участник", bio: "", birthday: "", avatarColor: 0x3A4256, avatarId: "")
        avatar.show(known, address: address)
        var words = person?.displayName ?? "Участник"
        if words.isEmpty { words = "Участник" }
        let shown = words + (member.userId == me ? " (ты)" : "")
        name.text = shown
        deafMark.isHidden = !member.serverDeafened
        micMark.isHidden = !(member.serverMuted || member.muted)
        micMark.tintColor = member.serverMuted ? Theme.danger : Theme.subtle
        selectionStyle = actions ? .default : .none
        isAccessibilityElement = true
        accessibilityLabel = actions ? "Действия: \(words)" : shown
        accessibilityTraits = actions ? .button : .staticText
        var marks: [String] = []
        if member.serverDeafened { marks.append("звук отключён модератором") }
        if member.serverMuted { marks.append("микрофон отключён модератором") } else if member.muted { marks.append("микрофон выключен") }
        accessibilityValue = marks.isEmpty ? nil : marks.joined(separator: ", ")
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width, height = contentView.bounds.height
        // Indented under the channel's name (40 pt), as the reference's list.
        selectedBackgroundView?.frame = CGRect(x: 56, y: 1, width: max(0, width - 56 - 16), height: height - 2)
        avatar.frame = CGRect(x: 60, y: (height - 24) / 2, width: 24, height: 24)
        var right = width - 20
        if !micMark.isHidden {
            micMark.frame = CGRect(x: right - 16, y: 0, width: 16, height: height)
            right -= 20
        }
        if !deafMark.isHidden {
            deafMark.frame = CGRect(x: right - 16, y: 0, width: 16, height: height)
            right -= 20
        }
        name.frame = CGRect(x: 92, y: 0, width: max(0, right - 92 - 4), height: height)
    }
}

/// The panel while this phone is in one of the community's voice channels.
final class CommunityVoicePanel: UIView {
    private let glass = GlassPill(interactive: false)
    private let heading = UILabel()
    private let alone = UILabel()
    private let problem = UILabel()
    private let row = UIStackView()
    private let micButton = CommunityVoiceButton()
    private let soundButton = CommunityVoiceButton()
    private let speakerButton = CommunityVoiceButton()
    private let leaveButton = CommunityVoiceButton()
    private let column = UIStackView()
    // ScreenShare: «Демонстрация экрана» (Sources/ScreenShare), as the reference's ScreenSharePanel under the heading.
    let screenPanel = ScreenSharePanel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.shape(radius: 20)
        glass.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glass)
        heading.font = .systemFont(ofSize: 14, weight: .bold)
        heading.textColor = CommunityVoice.green
        heading.numberOfLines = 0
        alone.text = "Пока никого — позови друзей."
        alone.font = .systemFont(ofSize: 13)
        alone.textColor = Theme.muted
        problem.font = .systemFont(ofSize: 13)
        problem.textColor = Theme.danger
        problem.numberOfLines = 0
        row.axis = .horizontal
        row.spacing = 10
        row.distribution = .fillEqually
        for button in [micButton, soundButton, speakerButton, leaveButton] { row.addArrangedSubview(button) }
        micButton.addAction(UIAction { _ in RoomVoice.shared.toggleMute() }, for: .touchUpInside)
        soundButton.addAction(UIAction { _ in RoomVoice.shared.toggleDeafen() }, for: .touchUpInside)
        speakerButton.addAction(UIAction { _ in RoomVoice.shared.toggleSpeaker() }, for: .touchUpInside)
        leaveButton.addAction(UIAction { _ in RoomVoice.shared.leave() }, for: .touchUpInside)
        problem.isUserInteractionEnabled = true
        problem.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(clearProblem)))
        column.axis = .vertical
        column.spacing = 12
        column.translatesAutoresizingMaskIntoConstraints = false
        for part in [heading, screenPanel, alone, problem, row] as [UIView] { column.addArrangedSubview(part) } // ScreenShare: screenPanel
        glass.contentView.addSubview(column)
        NSLayoutConstraint.activate([
            glass.topAnchor.constraint(equalTo: topAnchor), glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            glass.leadingAnchor.constraint(equalTo: leadingAnchor), glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.topAnchor.constraint(equalTo: glass.contentView.topAnchor, constant: 14), column.bottomAnchor.constraint(equalTo: glass.contentView.bottomAnchor, constant: -14),
            column.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor, constant: 14), column.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor, constant: -14),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ voice: RoomVoiceState) {
        let connected = voice.status == "connected"
        heading.text = connected ? "Ты в канале «\(voice.name)»" : "Подключение…"
        alone.isHidden = !(connected && voice.peers.isEmpty)
        screenPanel.show(voice) // ScreenShare
        problem.text = voice.error
        problem.isHidden = voice.error.isEmpty
        micButton.show(symbol: voice.muted ? "mic.slash.fill" : "mic.fill", words: voice.muted ? "Микрофон выкл." : "Микрофон", active: !voice.muted, danger: false)
        soundButton.show(symbol: voice.deafened ? "speaker.slash.fill" : "headphones", words: voice.deafened ? "Звук выкл." : "Звук", active: !voice.deafened, danger: false)
        speakerButton.show(symbol: voice.speaker ? "speaker.wave.3.fill" : "ear", words: voice.speaker ? "Динамик" : "Телефон", active: voice.speaker, danger: false)
        leaveButton.show(symbol: "phone.down.fill", words: "Выйти", active: false, danger: true)
    }

    @objc private func clearProblem() { RoomVoice.shared.clearError() }
}

/// One of the panel's buttons: an icon over a short word, the accent's tint while on, red for «Выйти».
final class CommunityVoiceButton: UIControl {
    private let icon = UIImageView()
    private let words = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 14
        icon.contentMode = .center
        icon.isUserInteractionEnabled = false
        words.font = .systemFont(ofSize: 12, weight: .semibold)
        words.textAlignment = .center
        words.adjustsFontSizeToFitWidth = true
        words.minimumScaleFactor = 0.8
        words.isUserInteractionEnabled = false
        let stack = UIStackView(arrangedSubviews: [icon, words])
        stack.axis = .vertical
        stack.spacing = 6
        stack.alignment = .center
        stack.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10), stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4), stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            icon.heightAnchor.constraint(equalToConstant: 22),
        ])
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    func show(symbol: String, words text: String, active: Bool, danger: Bool) {
        icon.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium))
        icon.tintColor = danger ? .white : (active ? Theme.accent : Theme.text)
        words.text = text
        words.textColor = danger ? .white : Theme.text
        backgroundColor = danger ? Theme.danger : (active ? ThemeStore.look.accentSoft : Theme.surface2)
        accessibilityLabel = text
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }
}
