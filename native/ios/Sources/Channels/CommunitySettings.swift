import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// The settings of a community: its name and picture, its channels and who sees them, its roles and their
// rights, its members, the people it does not let back in. Every part is shown only to those who have the
// right; the server checks the rights and the order of roles again.
// Reference: mobile/src/communities/CommunitySettings.tsx and MemberMenu.tsx.

final class CommunitySettingsPage: SettingsPage, PHPickerViewControllerDelegate {
    var onChanged: ((Community) -> Void)?
    var onInvite: (() -> Void)?
    private let messenger: Messenger?
    private var community: Community
    private var members: [CommunityMember]?
    private let nameField = SettingsField(caption: "Название", placeholder: "")
    private let aboutArea = SettingsTextArea(placeholder: "Описание")
    /// The button with states (Effects/ActionButton.swift): «Сохранить» → spinner → «Сохранено» for 1.6 s, or «Ошибка».
    private let saveButton = ActionButton(label: "Сохранить")
    private var saving = false
    private var savedTimer: Timer?
    private var busy = false

    init(messenger: Messenger?, community: Community) {
        self.messenger = messenger
        self.community = community
        super.init(name: "Настройки")
    }

    required init?(coder: NSCoder) { return nil }

    private var blog: Bool { return community.blog }
    private var owner: Bool { return messenger != nil && community.summary.ownerId == messenger?.userId }

    override func build() {
        nameField.limit = 60
        nameField.input.autocapitalizationType = .sentences
        nameField.value = community.summary.name
        nameField.onEdit = { [weak self] in self?.showSave() }
        aboutArea.limit = 500
        aboutArea.value = community.summary.about
        aboutArea.onEdit = { [weak self] in self?.showSave() }
        saveButton.successLabel = "Сохранено"
        saveButton.addAction(UIAction { [weak self] _ in self?.save() }, for: .touchUpInside)
        render()
        loadMembers()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Back from a page that changed a role, a channel or a member: read again.
        if isViewLoaded, members != nil { refresh() }
    }

    // MARK: The page

    private func render() {
        clear()
        let avatar = CommunityAvatarView()
        avatar.show(community.summary)
        avatar.translatesAutoresizingMaskIntoConstraints = false
        let face = UIControl()
        face.addSubview(avatar)
        avatar.widthAnchor.constraint(equalToConstant: 86).isActive = true
        avatar.heightAnchor.constraint(equalToConstant: 86).isActive = true
        avatar.topAnchor.constraint(equalTo: face.topAnchor).isActive = true
        avatar.bottomAnchor.constraint(equalTo: face.bottomAnchor).isActive = true
        avatar.centerXAnchor.constraint(equalTo: face.centerXAnchor).isActive = true
        if community.can(Perm.manageCommunity) {
            face.addTarget(self, action: #selector(pickAvatar), for: .touchUpInside)
            face.accessibilityLabel = "Сменить фото"
            face.isAccessibilityElement = true
            face.accessibilityTraits = .button
        }
        add(face, gap: 8)
        let kind = SettingsLook.words(blog ? ChannelCategory.label(community.summary.category) : "Игровой", size: 11, color: Theme.muted, weight: .bold)
        kind.textAlignment = .center
        add(kind, gap: 10)

        if community.can(Perm.manageCommunity) {
            add(nameField, gap: 16)
            add(SettingsLook.caption("Описание"), gap: 12)
            add(aboutArea, gap: 7)
            if blog {
                var rows: [UIView] = []
                for item in ChannelCategory.all {
                    let row = SettingsRow(symbol: item.symbol, label: item.label, checked: item.id == community.summary.category)
                    let id = item.id
                    row.onPress = { [weak self] in self?.update(["category": id], done: "") }
                    rows.append(row)
                }
                addGroup("О чём канал", rows: rows)
            }
            let closed = SettingsSwitchRow(label: blog ? "Закрытый канал" : "Закрытый сервер",
                                           words: "Ссылки-приглашения создаёшь только ты и те, у кого есть право «Менять название и фото»; ссылки остальных участников не действуют, а баннер приглашения нельзя переслать внутри Инвиза.",
                                           value: community.summary.closed)
            closed.onChange = { [weak self] on in self?.update(["closed": on], done: "") }
            addGroup(rows: [closed])
            add(SettingsLook.inset(saveButton, top: 0, side: 4, bottom: 0), gap: 14)
            showSave()
        }
        if community.can(Perm.invite) {
            let row = SettingsRow(symbol: "link", label: "Ссылка-приглашение")
            row.onPress = { [weak self] in self?.onInvite?() }
            addGroup("Приглашения", rows: [row])
        }
        if !blog && community.can(Perm.manageChannels) {
            var rows: [UIView] = []
            for channel in community.channels {
                let row = SettingsRow(symbol: channel.isText ? "ellipsis.bubble" : "speaker.wave.2", label: channel.isText ? "# " + channel.name : channel.name, value: channel.roleIds.isEmpty ? "" : "по ролям")
                row.onPress = { [weak self] in self?.openChannel(channel, kind: channel.kind) }
                rows.append(row)
            }
            let text = SettingsRow(symbol: "plus", label: "Текстовый канал")
            text.onPress = { [weak self] in self?.openChannel(nil, kind: "text") }
            let voice = SettingsRow(symbol: "plus", label: "Голосовой канал")
            voice.onPress = { [weak self] in self?.openChannel(nil, kind: "voice") }
            addGroup("Каналы", rows: rows + [text, voice])
        }
        if community.can(Perm.manageRoles) {
            var rows: [UIView] = []
            for role in community.roles {
                let row = SettingsRow(symbol: role.isDefault ? "person.2" : "shield", label: role.name, value: role.isDefault ? "все" : "", swatch: role.isDefault ? nil : role.color)
                row.onPress = { [weak self] in self?.openRole(role) }
                rows.append(row)
            }
            let fresh = SettingsRow(symbol: "plus", label: "Новая роль")
            fresh.onPress = { [weak self] in self?.openRole(nil) }
            addGroup("Роли", rows: rows + [fresh])
        }
        if let members {
            let pressable = community.can(Perm.manageRoles) || community.can(Perm.kick) || community.can(Perm.ban)
            var rows: [UIView] = []
            for member in members {
                let row = MemberRow(member, community: community, base: messenger?.server.endpoint ?? "")
                row.isEnabled = pressable
                row.onPress = { [weak self] in self?.openMember(member) }
                rows.append(row)
            }
            if !rows.isEmpty { addGroup(blog ? "Подписчики" : "Участники", rows: rows) }
        } else {
            add(SettingsLook.caption(blog ? "Подписчики" : "Участники"), gap: 14)
            add(SettingsLook.foot("Загрузка…"), gap: 7)
        }
        if community.can(Perm.ban) {
            let row = SettingsRow(symbol: "nosign", label: "Заблокированные")
            row.onPress = { [weak self] in
                guard let self, let messenger = self.messenger else { return }
                self.open(CommunityBansPage(messenger: messenger, communityId: self.community.id))
            }
            addGroup("Блокировки", rows: [row])
        }
        let leaveRow = SettingsRow(symbol: owner ? "trash" : "rectangle.portrait.and.arrow.right", label: owner ? "Удалить сообщество" : (blog ? "Отписаться" : "Покинуть сервер"), danger: true)
        leaveRow.onPress = { [weak self] in self?.askExit() }
        addGroup("Сообщество", rows: [leaveRow])
        let note = SettingsLook.words("Каналы и серверы не шифруются сквозным шифрованием: сообщения хранятся на сервере Инвиза. Личные чаты по-прежнему зашифрованы.", size: 12, color: Theme.subtle)
        note.textAlignment = .center
        add(SettingsLook.inset(note, top: 0, side: 10, bottom: 0), gap: 16)
    }

    private func showSave() {
        let name = nameField.value.trimmingCharacters(in: .whitespacesAndNewlines)
        let changed = nameField.value != community.summary.name || aboutArea.value != community.summary.about
        saveButton.isEnabled = saveButton.success || saving || (!busy && !name.isEmpty && changed)
    }

    // MARK: Reading and changing

    private func loadMembers() {
        guard let messenger else {
            #if targetEnvironment(simulator)
            members = ChannelsDemo.members()
            render()
            #endif
            return
        }
        messenger.server.ask("communityMembers", [community.id]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let body):
                self.members = CommunityMember.list(body["members"])
                self.render()
            case .failure(let error):
                if self.members == nil { self.tell(error.words) }
            }
        }
    }

    /// Reads the community and its members again and shows them.
    private func refresh() {
        guard let messenger else { return }
        messenger.server.ask("community", [community.id]) { [weak self] result in
            guard let self, case .success(let body) = result, let found = Community(body["community"]) else { return }
            self.took(found)
        }
        loadMembers()
    }

    private func took(_ found: Community) {
        community = found
        ChannelsStore.shared.put(found.summary)
        onChanged?(found)
        render()
    }

    private func update(_ fields: [String: Any], done words: String) {
        guard let messenger else { return }
        if busy {
            // Nothing was sent while another save is running: the switch goes back to what is saved.
            DispatchQueue.main.async { [weak self] in
                self?.render()
            }
            return
        }
        busy = true
        showSave()
        messenger.server.ask("updateCommunity", [community.id, fields]) { [weak self] result in
            guard let self else { return }
            self.busy = false
            let wasSaving = self.saving
            self.saving = false
            self.saveButton.loading = false
            switch result {
            case .success(let body):
                if let found = Community(body["community"]) { self.took(found) }
                if wasSaving {
                    // «Сохранено» on the button for 1.6 s (useSuccessFlash).
                    self.saveButton.success = true
                    self.savedTimer?.invalidate()
                    self.savedTimer = Timer.scheduledTimer(withTimeInterval: 1.6, repeats: false) { [weak self] (_: Timer) -> Void in
                        self?.saveButton.success = false
                        self?.showSave()
                    }
                }
                if !words.isEmpty { self.tell(words) }
            case .failure(let error):
                if wasSaving { self.saveButton.signalError() }
                self.render()
                self.tell(error.words)
            }
            self.showSave()
        }
    }

    private func save() {
        if busy || saveButton.success { return }
        saving = true
        saveButton.loading = true
        update(["name": nameField.value.trimmingCharacters(in: .whitespacesAndNewlines), "description": aboutArea.value.trimmingCharacters(in: .whitespacesAndNewlines)], done: "Сохранено.")
    }

    private func askExit() {
        guard let messenger else { return }
        let deleting = owner
        confirm(heading: deleting ? "Удалить сообщество?" : (blog ? "Отписаться?" : "Покинуть сервер?"),
                words: deleting ? "Каналы, сообщения и приглашения удалятся у всех. Это нельзя отменить." : "Вернуться можно по ссылке-приглашению.",
                action: deleting ? "Удалить" : "Выйти") { [weak self] in
            guard let self else { return }
            let id = self.community.id
            messenger.server.ask(deleting ? "deleteCommunity" : "leaveCommunity", [id]) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success:
                    ChannelsStore.shared.remove(id)
                    ChannelsRoute.closeCommunity(from: self)
                case .failure(let error):
                    self.tell(error.words)
                }
            }
        }
    }

    private func openChannel(_ channel: CommunityChannel?, kind: String) {
        guard let messenger else { return }
        open(ChannelEditPage(messenger: messenger, community: community, channel: channel, kind: kind))
    }

    private func openRole(_ role: CommunityRole?) {
        guard let messenger else { return }
        open(RoleEditPage(messenger: messenger, community: community, role: role, owner: owner))
    }

    private func openMember(_ member: CommunityMember) {
        guard let messenger else { return }
        let page = MemberPage(messenger: messenger, community: community, member: member)
        page.onParted = { [weak self] (words: String) -> Void in
            self?.tell(words)
        }
        open(page)
    }

    // MARK: The picture

    @objc private func pickAvatar() {
        guard messenger != nil, !busy else { return }
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
        guard let messenger, let provider = results.first?.itemProvider, provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), !busy else { return }
        busy = true
        let server = messenger.server
        let id = community.id
        _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] (url: URL?, _: Error?) -> Void in
            // The picture is drawn anew as a 512-point square: nothing of the original file goes up.
            var outcome: Result<Any, ServerError> = .failure(.network("Не удалось обработать фото. Файл не отправлен."))
            if let url, let jpeg = CommunitySettingsPage.square(url) {
                switch server.uploadPlainFile(jpeg, name: "community.jpg", mimeType: "image/jpeg", purpose: nil) {
                case .failure(let error):
                    outcome = .failure(error)
                case .success(let uploaded):
                    outcome = server.opAndWait("updateCommunity", [id, ["avatarId": uploaded["id"] as? String ?? ""]])
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                switch outcome {
                case .success(let body):
                    if let found = Community((body as? [String: Any])?["community"]) { self.took(found) }
                    self.tell("Фото обновлено.")
                case .failure(let error):
                    self.tell(error.words)
                }
            }
        }
    }

    /// The middle square of a picture file at 512 pixels, as a clean JPEG.
    private static func square(_ url: URL) -> Data? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: 1024, kCGImageSourceShouldCacheImmediately: true]
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary), decoded.width > 0, decoded.height > 0 else { return nil }
        let side: CGFloat = 512
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        let scale = max(side / CGFloat(decoded.width), side / CGFloat(decoded.height))
        let size = CGSize(width: CGFloat(decoded.width) * scale, height: CGFloat(decoded.height) * scale)
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
            UIImage(cgImage: decoded).draw(in: CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2, width: size.width, height: size.height))
        }
        guard let jpeg = drawn.jpegData(compressionQuality: 0.86), case .success(let clean) = FileCore.cleanJpeg(jpeg) else { return nil }
        return clean
    }
}

/// A member in the settings: the picture, the name in the colour of the highest role, the roles.
final class MemberRow: UIControl {
    var onPress: (() -> Void)?
    private let avatar = PersonAvatarView()
    private let nameLabel = UILabel()
    private let rolesLabel = UILabel()

    init(_ member: CommunityMember, community: Community, base: String) {
        super.init(frame: .zero)
        avatar.show(member.user, address: member.user.avatarId.isEmpty || base.isEmpty ? "" : base + Server.filePath(member.user.avatarId))
        addSubview(avatar)
        nameLabel.text = member.user.displayName + (member.owner ? " 👑" : "")
        nameLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        nameLabel.textColor = community.nameColor(roleIds: member.roleIds).map { UIColor(hex: $0) } ?? Theme.text
        nameLabel.isUserInteractionEnabled = false
        addSubview(nameLabel)
        let roles = community.roles.filter { member.roleIds.contains($0.id) }.map { $0.name }.joined(separator: ", ")
        rolesLabel.text = roles.isEmpty ? "@" + member.user.username : roles
        rolesLabel.font = .systemFont(ofSize: 12)
        rolesLabel.textColor = Theme.muted
        rolesLabel.isUserInteractionEnabled = false
        addSubview(rolesLabel)
        heightAnchor.constraint(equalToConstant: 52).isActive = true
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = member.user.displayName
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        avatar.frame = CGRect(x: 14, y: 8, width: 36, height: 36)
        nameLabel.frame = CGRect(x: 62, y: 8, width: bounds.width - 62 - 14, height: 19)
        rolesLabel.frame = CGRect(x: 62, y: 28, width: bounds.width - 62 - 14, height: 16)
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? SettingsLook.pressed : .clear }
    }

    @objc private func pressed() { onPress?() }
}

/// A member: their roles, and the two ways to part with them.
final class MemberPage: SettingsPage {
    private let messenger: Messenger
    private let community: Community
    private let member: CommunityMember
    private var roleIds: [String]
    private var busy = false
    /// The member was excluded or blocked: the words about it, for the page this one returns to.
    var onParted: ((String) -> Void)?

    init(messenger: Messenger, community: Community, member: CommunityMember) {
        self.messenger = messenger
        self.community = community
        self.member = member
        roleIds = member.roleIds
        super.init(name: member.user.displayName)
    }

    required init?(coder: NSCoder) { return nil }

    override func build() { render() }

    private func render() {
        clear()
        let profile = SettingsRow(symbol: "person.crop.circle", label: "Профиль")
        profile.onPress = { [weak self] in
            guard let self else { return }
            self.open(PersonProfileViewController(messenger: self.messenger, userId: self.member.user.id, name: self.member.user.displayName, person: self.member.user))
        }
        addGroup(rows: [profile])
        if community.can(Perm.manageRoles) {
            var rows: [UIView] = []
            for role in community.roles where !role.isDefault {
                let row = SettingsSwitchRow(label: role.name, words: "", value: roleIds.contains(role.id), enabled: !busy)
                let id = role.id
                row.onChange = { [weak self] on in self?.setRole(id, on) }
                rows.append(row)
            }
            if !rows.isEmpty { addGroup("Роли", rows: rows) }
        }
        let other = !member.owner && member.user.id != messenger.userId
        var rows: [UIView] = []
        if other && community.can(Perm.kick) {
            let kick = SettingsRow(symbol: "person.badge.minus", label: "Исключить", danger: true)
            kick.onPress = { [weak self] in self?.part("kickMember", done: "Участник исключён.") }
            rows.append(kick)
        }
        if other && community.can(Perm.ban) {
            let ban = SettingsRow(symbol: "nosign", label: "Заблокировать", danger: true)
            ban.onPress = { [weak self] in self?.part("banMember", done: "Участник заблокирован.") }
            rows.append(ban)
        }
        if !rows.isEmpty {
            addGroup(rows: rows)
            if other && community.can(Perm.ban) { add(SettingsLook.foot("Заблокировать: исключить и не пускать обратно по приглашениям")) }
        }
    }

    private func setRole(_ id: String, _ on: Bool) {
        if busy {
            // Another change is on its way: nothing is sent, and the switch shows what is saved again.
            DispatchQueue.main.async { [weak self] in
                self?.render()
            }
            return
        }
        busy = true
        var wanted = roleIds.filter { $0 != id }
        if on { wanted.append(id) }
        messenger.server.ask("setMemberRoles", [community.id, member.user.id, wanted]) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let body):
                self.roleIds = body["roleIds"] as? [String] ?? wanted
            case .failure(let error):
                self.tell(error.words)
            }
            self.render()
        }
    }

    private func part(_ operation: String, done words: String) {
        guard !busy else { return }
        busy = true
        messenger.server.ask(operation, [community.id, member.user.id]) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success:
                let told = self.onParted
                let stack = self.navigationController
                stack?.popViewController(animated: true)
                if let coordinator = stack?.transitionCoordinator {
                    coordinator.animate(alongsideTransition: nil, completion: { (_: UIViewControllerTransitionCoordinatorContext) -> Void in
                        told?(words)
                    })
                } else {
                    told?(words)
                }
            case .failure(let error):
                self.tell(error.words)
            }
        }
    }
}

/// The people a community does not let back in; a touch lets one back.
final class CommunityBansPage: SettingsPage {
    private let messenger: Messenger
    private let communityId: String

    init(messenger: Messenger, communityId: String) {
        self.messenger = messenger
        self.communityId = communityId
        super.init(name: "Заблокированные")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        add(SettingsLook.foot("Загрузка…"))
        read()
    }

    private func read() {
        messenger.server.ask("communityBans", [communityId]) { [weak self] result in
            guard let self else { return }
            self.clear()
            switch result {
            case .failure(let error):
                self.add(SettingsNotice(error.words, error: true, onRetry: { [weak self] in self?.read() }))
            case .success(let body):
                let bans = body["bans"] as? [[String: Any]] ?? []
                if bans.isEmpty { return self.add(SettingsLook.foot("Никого нет.")) }
                for ban in bans {
                    guard let person = Person(ban["user"]) else { continue }
                    let reason = ban["reason"] as? String ?? ""
                    let row = SettingsRow(symbol: "person", label: person.displayName, arrow: false)
                    row.onPress = { [weak self] in self?.letBack(person.id) }
                    self.addGroup(rows: [row])
                    self.add(SettingsLook.foot(reason.isEmpty ? "Нажми, чтобы разблокировать" : "Причина: " + reason + " · нажми, чтобы разблокировать"))
                }
            }
        }
    }

    private func letBack(_ userId: String) {
        messenger.server.ask("unbanMember", [communityId, userId]) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result { return self.tell(error.words) }
            self.read()
        }
    }
}

/// The colours a role can have, as round swatches; the chosen one is ringed.
final class RoleColorStrip: UIView {
    var onPick: (String) -> Void = { _ in }
    private var buttons: [UIButton] = []
    private var chosen: String

    init(chosen: String) {
        self.chosen = chosen
        super.init(frame: .zero)
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 9
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
        ])
        for (index, color) in ChannelWords.roleColors.enumerated() {
            let button = UIButton(type: .custom)
            button.backgroundColor = UIColor(hex: Messenger.color(color.hex))
            button.layer.cornerRadius = 16
            button.layer.borderColor = Theme.text.cgColor
            button.tag = index
            button.accessibilityLabel = "Цвет роли: " + color.spoken
            button.widthAnchor.constraint(equalToConstant: 32).isActive = true
            button.heightAnchor.constraint(equalToConstant: 32).isActive = true
            button.addTarget(self, action: #selector(picked(_:)), for: .touchUpInside)
            row.addArrangedSubview(button)
            buttons.append(button)
        }
        paint()
    }

    required init?(coder: NSCoder) { return nil }

    private func paint() {
        for (index, button) in buttons.enumerated() {
            let on = ChannelWords.roleColors[index].hex.lowercased() == chosen.lowercased()
            button.layer.borderWidth = on ? 3 : 0
            if on { button.accessibilityTraits.insert(.selected) } else { button.accessibilityTraits.remove(.selected) }
        }
    }

    @objc private func picked(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < ChannelWords.roleColors.count else { return }
        chosen = ChannelWords.roleColors[sender.tag].hex
        paint()
        onPick(chosen)
    }
}

/// A role: its name, its colour and what it lets its people do. `role` nil: a new one.
final class RoleEditPage: SettingsPage {
    private let messenger: Messenger
    private let community: Community
    private let role: CommunityRole?
    private let owner: Bool
    private let nameField = SettingsField(caption: "Название", placeholder: "Например, Ветераны")
    private let saveButton = SettingsButton(label: "Сохранить")
    private var color: String
    private var perms: Int

    init(messenger: Messenger, community: Community, role: CommunityRole?, owner: Bool) {
        self.messenger = messenger
        self.community = community
        self.role = role
        self.owner = owner
        color = role?.colorHex ?? ChannelWords.roleColors[0].hex
        perms = role?.perms ?? (Perm.send | Perm.voice)
        super.init(name: role == nil ? "Новая роль" : (role?.isDefault == true ? "Права: " + (role?.name ?? "") : "Роль"))
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        let everyone = role?.isDefault == true
        if everyone {
            add(SettingsLook.foot("Эти права есть у всех участников."))
        } else {
            nameField.limit = 32
            nameField.input.autocapitalizationType = .sentences
            nameField.value = role?.name ?? ""
            add(nameField)
            let strip = RoleColorStrip(chosen: color)
            strip.onPick = { [weak self] hex in self?.color = hex }
            add(strip, gap: 12)
        }
        var rows: [UIView] = []
        for item in Perm.labels {
            if community.blog ? item.server : item.blog { continue }
            if !owner && item.bit == Perm.admin { continue }
            let row = SettingsSwitchRow(label: item.label, words: "", value: perms & item.bit != 0)
            let bit = item.bit
            row.onChange = { [weak self] on in
                guard let self else { return }
                self.perms = on ? self.perms | bit : self.perms & ~bit
            }
            rows.append(row)
        }
        addGroup(rows: rows)
        saveButton.onPress = { [weak self] in self?.save() }
        add(saveButton, gap: 16)
        if let role, !role.isDefault {
            let remove = SettingsButton(label: "Удалить роль", kind: .danger)
            remove.onPress = { [weak self] in self?.finish("deleteRole", [self?.community.id ?? "", role.id]) }
            add(remove, gap: 10)
        }
    }

    private func save() {
        let name = nameField.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let role {
            var fields: [String: Any] = ["perms": perms]
            if !role.isDefault {
                fields["name"] = name
                fields["color"] = color
            }
            finish("updateRole", [community.id, role.id, fields])
        } else {
            finish("createRole", [community.id, ["name": name.isEmpty ? "Новая роль" : name, "color": color, "perms": perms] as [String: Any]])
        }
    }

    private func finish(_ operation: String, _ args: [Any]) {
        saveButton.setBusy(true)
        messenger.server.ask(operation, args) { [weak self] result in
            guard let self else { return }
            self.saveButton.setBusy(false)
            switch result {
            case .success:
                self.navigationController?.popViewController(animated: true)
            case .failure(let error):
                self.tell(error.words)
            }
        }
    }
}

/// A channel: its name, its topic and who sees it. `channel` nil: a new one of `kind`.
final class ChannelEditPage: SettingsPage {
    private let messenger: Messenger
    private let community: Community
    private let channel: CommunityChannel?
    private let kind: String
    private let nameField: SettingsField
    private let topicField = SettingsField(caption: "Тема", placeholder: "О чём этот канал")
    private let saveButton: SettingsButton
    private var roleIds: [String]

    init(messenger: Messenger, community: Community, channel: CommunityChannel?, kind: String) {
        self.messenger = messenger
        self.community = community
        self.channel = channel
        self.kind = kind
        nameField = SettingsField(caption: "Название", placeholder: kind == "voice" ? "Например, Катка" : "например, мемы")
        saveButton = SettingsButton(label: channel == nil ? "Создать" : "Сохранить")
        roleIds = channel?.roleIds ?? []
        super.init(name: channel != nil ? "Канал" : (kind == "voice" ? "Новый голосовой канал" : "Новый текстовый канал"))
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        nameField.limit = 40
        nameField.value = channel?.name ?? ""
        nameField.onEdit = { [weak self] in self?.showReady() }
        add(nameField)
        if kind == "text" {
            topicField.limit = 200
            topicField.input.autocapitalizationType = .sentences
            topicField.value = channel?.topic ?? ""
            add(topicField, gap: 12)
        }
        add(SettingsLook.caption("Кто видит"), gap: 14)
        add(SettingsLook.foot("Ничего не выбрано — канал видят все участники. Выбери роли, чтобы сделать канал закрытым."), gap: 6)
        var rows: [UIView] = []
        for role in community.roles where !role.isDefault {
            let row = SettingsSwitchRow(label: role.name, words: "", value: roleIds.contains(role.id))
            let id = role.id
            row.onChange = { [weak self] on in
                guard let self else { return }
                self.roleIds = self.roleIds.filter { $0 != id }
                if on { self.roleIds.append(id) }
            }
            rows.append(row)
        }
        if !rows.isEmpty { addGroup(rows: rows) }
        saveButton.onPress = { [weak self] in self?.save() }
        add(saveButton, gap: 16)
        if let channel {
            let remove = SettingsButton(label: "Удалить канал", kind: .danger)
            remove.onPress = { [weak self] in self?.finish("deleteChannel", [self?.community.id ?? "", channel.id]) }
            add(remove, gap: 10)
        }
        showReady()
    }

    private func showReady() {
        saveButton.isEnabled = !nameField.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func save() {
        let name = nameField.value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let topic = topicField.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let channel {
            finish("updateChannel", [community.id, channel.id, ["name": name, "topic": topic, "roleIds": roleIds] as [String: Any]])
        } else {
            finish("createChannel", [community.id, ["kind": kind, "name": name, "topic": topic, "roleIds": roleIds] as [String: Any]])
        }
    }

    private func finish(_ operation: String, _ args: [Any]) {
        saveButton.setBusy(true)
        messenger.server.ask(operation, args) { [weak self] result in
            guard let self else { return }
            self.saveButton.setBusy(false)
            self.showReady()
            switch result {
            case .success:
                self.navigationController?.popViewController(animated: true)
            case .failure(let error):
                self.tell(error.words)
            }
        }
    }
}
