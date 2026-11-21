import UIKit

// The forms of «Каналы»: creating a community, joining by an invite link, an invitation before it is accepted,
// and sharing an invitation. Reference: CommunitiesScreen.tsx (CreateSheet, JoinSheet), InviteSheet.tsx,
// InviteCard.tsx, and the «Пригласить» sheet of CommunityScreen.tsx.

/// «Что создаём?»: a game server or a standard channel.
final class CommunityKindPage: SettingsPage {
    private let messenger: Messenger

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Что создаём?")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        let server = SettingsRow(symbol: "gamecontroller", label: "Игровой")
        server.onPress = { [weak self] in self?.pick("server") }
        addGroup(rows: [server])
        add(SettingsLook.foot("Текстовые и голосовые каналы, роли, закрытые каналы для своих."))
        let blog = SettingsRow(symbol: "megaphone", label: "Стандартный")
        blog.onPress = { [weak self] in self?.pick("blog") }
        addGroup(rows: [blog])
        add(SettingsLook.foot("Обычный канал: блог, новости, музыка и не только. Публикуешь ты и авторы, подписчики читают."))
    }

    private func pick(_ kind: String) {
        open(CommunityCreatePage(messenger: messenger, kind: kind))
    }
}

/// The name, the description and (for a standard channel) what it is about; then it is created.
final class CommunityCreatePage: SettingsPage {
    private let messenger: Messenger
    private let kind: String
    private let nameField: SettingsField
    private let aboutArea = SettingsTextArea(placeholder: "Необязательно")
    private let createButton = SettingsButton(label: "Создать")
    private var category = "blog"
    private var busy = false

    init(messenger: Messenger, kind: String) {
        self.messenger = messenger
        self.kind = kind
        nameField = SettingsField(caption: "Название", placeholder: kind == "server" ? "Например, Клан «Север»" : "Например, Заметки Стейджа")
        super.init(name: kind == "server" ? "Игровой сервер" : "Стандартный канал")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        nameField.limit = 60
        nameField.input.autocapitalizationType = .sentences
        nameField.onEdit = { [weak self] in self?.showReady() }
        aboutArea.limit = 500
        createButton.onPress = { [weak self] in self?.submit() }
        render()
    }

    private func render() {
        clear()
        add(nameField, gap: 8)
        add(SettingsLook.caption("Описание"), gap: 12)
        add(aboutArea, gap: 7)
        if kind == "blog" {
            var rows: [UIView] = []
            for item in ChannelCategory.all {
                let row = SettingsRow(symbol: item.symbol, label: item.label, checked: item.id == category)
                let id = item.id
                row.onPress = { [weak self] in
                    self?.category = id
                    self?.render()
                }
                rows.append(row)
            }
            addGroup("О чём канал", rows: rows)
        }
        let first = kind == "server" ? "Сразу появятся каналы #общий и #новости, голосовые «Общий» и «Игра» и роль «Модератор». Всё можно поменять."
            : "Ссылкой-приглашением можно делиться в чатах и вне мессенджера."
        add(SettingsLook.foot(first + " Сообщения в каналах не шифруются сквозным шифрованием."), gap: 14)
        add(createButton, gap: 16)
        showReady()
    }

    private func showReady() {
        createButton.isEnabled = !busy && !nameField.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        let name = nameField.value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !busy else { return }
        busy = true
        createButton.setBusy(true)
        var fields: [String: Any] = ["kind": kind, "name": name, "description": aboutArea.value.trimmingCharacters(in: .whitespacesAndNewlines)]
        if kind == "blog" { fields["category"] = category }
        messenger.server.ask("createCommunity", [fields]) { [weak self] result in
            guard let self else { return }
            self.busy = false
            self.createButton.setBusy(false)
            self.showReady()
            switch result {
            case .success(let body):
                guard let made = Community(body["community"]) else { return self.tell("Не удалось создать.") }
                ChannelsStore.shared.put(made.summary)
                ChannelsRoute.openCommunity(from: self, messenger: self.messenger, id: made.id)
            case .failure(let error):
                self.tell(error.words)
            }
        }
    }
}

/// An invitation as a card: the picture, the name, how many people, and the button that leads there
/// (reference: InviteCard.tsx).
final class InviteCardView: UIView {
    var onOpen: () -> Void = {}

    init(_ preview: InvitePreview) {
        super.init(frame: .zero)
        backgroundColor = UIColor(white: 1, alpha: 0.06)
        layer.cornerRadius = 16
        layer.cornerCurve = .continuous
        layer.borderWidth = 0.5
        layer.borderColor = UIColor(white: 1, alpha: 0.08).cgColor
        let community = preview.community
        let kind = UILabel()
        kind.attributedText = NSAttributedString(string: (community.blog ? "КАНАЛ" : "СЕРВЕР") + (community.closed ? " · ЗАКРЫТЫЙ" : ""),
                                                 attributes: [.kern: 0.6, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        let avatar = CommunityAvatarView()
        avatar.show(community)
        avatar.translatesAutoresizingMaskIntoConstraints = false
        avatar.widthAnchor.constraint(equalToConstant: 48).isActive = true
        avatar.heightAnchor.constraint(equalToConstant: 48).isActive = true
        let name = SettingsLook.words(community.name, size: 16, color: Theme.text, weight: .bold)
        name.numberOfLines = 1
        let details = SettingsLook.words((community.blog ? ChannelCategory.label(community.category) : "Игровой") + " · " + community.countWords, size: 12, color: Theme.muted)
        details.numberOfLines = 1
        let words = UIStackView(arrangedSubviews: [name, details])
        words.axis = .vertical
        words.spacing = 3
        let middle = UIStackView(arrangedSubviews: [avatar, words])
        middle.axis = .horizontal
        middle.alignment = .center
        middle.spacing = 11
        let button = UIButton(type: .system)
        button.setTitle(preview.isMember ? "Открыть" : (community.blog ? "Перейти в канал" : "Перейти на сервер"), for: .normal)
        button.setTitleColor(preview.isMember ? Theme.text : UIColor.white, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        button.backgroundColor = preview.isMember ? Theme.surface2 : UIColor(hex: 0x2FA36B)
        button.layer.cornerRadius = 10
        button.accessibilityLabel = (preview.isMember ? "Открыть " : "Перейти: ") + community.name
        button.addTarget(self, action: #selector(pressed), for: .touchUpInside)
        button.heightAnchor.constraint(equalToConstant: 38).isActive = true
        let column = UIStackView(arrangedSubviews: [kind, middle, button])
        column.axis = .vertical
        column.spacing = 10
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func pressed() { onOpen() }
}

/// «Вступить по ссылке»: a link or a code, and what it leads to.
final class CommunityJoinPage: SettingsPage {
    private let messenger: Messenger
    private let linkField = SettingsField(caption: "Ссылка или код", placeholder: "https://…/i/Ab3dEf9h")
    private let slot = UIStackView()
    private var shownCode = ""

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Вступить по ссылке")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        linkField.onEdit = { [weak self] in self?.typed() }
        add(linkField)
        slot.axis = .vertical
        add(slot, gap: 14)
        fill(SettingsLook.foot("Вставь приглашение, которое тебе прислали."))
    }

    private func fill(_ part: UIView) {
        for old in slot.arrangedSubviews {
            slot.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        slot.addArrangedSubview(part)
    }

    private func typed() {
        guard let code = ChannelWords.typedInviteCode(linkField.value) else {
            shownCode = ""
            return fill(SettingsLook.foot("Вставь приглашение, которое тебе прислали."))
        }
        if code == shownCode { return }
        shownCode = code
        fill(SettingsLook.foot("Загрузка…"))
        messenger.server.ask("invite", [code]) { [weak self] result in
            guard let self, self.shownCode == code else { return }
            guard case .success(let body) = result, let preview = InvitePreview(body) else {
                return self.fill(SettingsNotice("Приглашение недействительно"))
            }
            let card = InviteCardView(preview)
            card.onOpen = { [weak self] in
                guard let self else { return }
                if preview.isMember {
                    ChannelsRoute.openCommunity(from: self, messenger: self.messenger, id: preview.community.id)
                } else {
                    ChannelsRoute.openInvite(from: self, messenger: self.messenger, code: code)
                }
            }
            self.fill(card)
        }
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: the field filled in.
    func simulatorType(_ words: String) {
        loadViewIfNeeded()
        linkField.value = words
        typed()
    }
    #endif
}

/// «Приглашение»: what the invitation leads to, and the button that accepts it.
final class InvitePage: SettingsPage {
    private let messenger: Messenger
    private let code: String
    private let acceptButton = SettingsButton(label: "Принять приглашение")

    init(messenger: Messenger, code: String) {
        self.messenger = messenger
        self.code = code
        super.init(name: "Приглашение")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        add(SettingsLook.foot("Загрузка…"))
        acceptButton.onPress = { [weak self] in self?.accept() }
        messenger.server.ask("invite", [code]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let body):
                guard let preview = InvitePreview(body) else { return self.fail("Приглашение недействительно.") }
                // Already there: straight to it.
                if preview.isMember { return ChannelsRoute.openCommunity(from: self, messenger: self.messenger, id: preview.community.id) }
                self.show(preview.community)
            case .failure(let error):
                self.fail(error.words)
            }
        }
    }

    private func fail(_ words: String) {
        clear()
        add(SettingsNotice(words, error: true))
    }

    private func centred(_ inner: UIView) -> UIView {
        let box = UIView()
        inner.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.topAnchor.constraint(equalTo: box.topAnchor),
            inner.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            inner.centerXAnchor.constraint(equalTo: box.centerXAnchor),
        ])
        return box
    }

    private func show(_ community: CommunitySummary) {
        clear()
        let avatar = CommunityAvatarView()
        avatar.show(community)
        avatar.widthAnchor.constraint(equalToConstant: 84).isActive = true
        avatar.heightAnchor.constraint(equalToConstant: 84).isActive = true
        add(centred(avatar), gap: 16)
        let name = SettingsLook.words(community.name, size: 22, color: Theme.text, weight: .bold)
        name.textAlignment = .center
        add(name, gap: 12)
        let details = SettingsLook.words((community.blog ? ChannelCategory.label(community.category) : "Игровой") + " · " + community.countWords, size: 13, color: Theme.muted)
        details.textAlignment = .center
        add(details, gap: 6)
        if !community.about.isEmpty {
            let about = SettingsLook.words(community.about, size: 14, color: Theme.muted)
            about.textAlignment = .center
            add(about, gap: 12)
        }
        if community.blog {
            var look = acceptButton.configuration
            look?.title = "Подписаться"
            acceptButton.configuration = look
        }
        add(acceptButton, gap: 20)
    }

    private func accept() {
        acceptButton.setBusy(true)
        messenger.server.ask("acceptInvite", [code]) { [weak self] result in
            guard let self else { return }
            self.acceptButton.setBusy(false)
            switch result {
            case .success(let body):
                guard let joined = Community(body["community"]) else { return self.tell("Не удалось вступить.") }
                ChannelsStore.shared.put(joined.summary)
                ChannelsRoute.openCommunity(from: self, messenger: self.messenger, id: joined.id)
            case .failure(let error):
                self.tell(error.words)
            }
        }
    }
}

/// «Пригласить»: the link is not shown — it is copied, shared, or sent to a chat.
final class InviteSharePage: SettingsPage {
    private let messenger: Messenger
    private let link: String
    private let copyRow = SettingsRow(symbol: "doc.on.doc", label: "Скопировать ссылку", arrow: false)
    private var sendingTo = ""

    init(messenger: Messenger, link: String) {
        self.messenger = messenger
        self.link = link
        super.init(name: "Пригласить")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        copyRow.onPress = { [weak self] in
            guard let self else { return }
            UIPasteboard.general.string = self.link
            self.copyRow.setValue("Скопировано")
        }
        let share = SettingsRow(symbol: "square.and.arrow.up", label: "Поделиться…", arrow: false)
        share.onPress = { [weak self] in
            guard let self else { return }
            let sheet = UIActivityViewController(activityItems: [self.link], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = self.view
            self.present(sheet, animated: true)
        }
        addGroup(rows: [copyRow, share])
        messenger.chats { [weak self] result in
            guard let self, case .success(let chats) = result, !chats.isEmpty else { return }
            var rows: [UIView] = []
            for chat in chats.prefix(20) {
                let row = SettingsRow(symbol: "paperplane", label: chat.title, arrow: false)
                row.accessibilityLabel = "Отправить приглашение: " + chat.title
                let chatId = chat.id, peerId = chat.peerId
                row.onPress = { [weak self] in self?.send(chatId: chatId, peerId: peerId) }
                rows.append(row)
            }
            self.addGroup("Отправить в чат", rows: rows)
        }
    }

    /// The link goes to a chat as an ordinary (end-to-end encrypted) message.
    private func send(chatId: String, peerId: String) {
        guard sendingTo.isEmpty else { return }
        sendingTo = chatId
        messenger.send(chatId: chatId, peerId: peerId, text: link) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.sendingTo = ""
                switch result {
                case .success:
                    self.navigationController?.popViewController(animated: true)
                case .failure(let failure):
                    self.tell(failure.message)
                }
            }
        }
    }
}
