import UIKit

/// The settings section: who is signed in, then the groups of what can be set up — each row opens its own page.
/// (The previous app: `mobile/src/SettingsScreen.tsx`, `Root`.)
final class SettingsViewController: SettingsPage {
    /// The signed-in account; nil shows the page with the simulator's sample person (rows then open nothing
    /// but «О приложении»).
    private let messenger: Messenger?
    private var leaving = false
    // Profile: the banner, the effect, «Изменить» and the decorated head (Sources/Profile/SettingsProfileHead.swift).
    private let profileChrome = SettingsProfileChrome()

    init(messenger: Messenger? = nil) {
        self.messenger = messenger
        super.init(name: "Настройки", large: true)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(self, selector: #selector(profileChanged), name: Messenger.ownProfileChanged, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(profileChanged), name: PlatinaState.changed, object: nil) // Profile: the offer
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        messenger?.prepareSettingsAvatars()
        messenger?.refreshOwnProfile()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let barRoom = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 12
        if scroll.contentInset.bottom != barRoom { scroll.contentInset.bottom = barRoom }
    }

    @objc private func profileChanged() {
        build()
    }

    private var person: [String: Any] {
        if let messenger { return messenger.ownProfile }
        #if targetEnvironment(simulator)
        // Profile: the sample person wears Platina when a shot asks for it (`-profilelook 1`, Profile/ProfileSamples.swift).
        if UserDefaults.standard.bool(forKey: "profilelook") { return ProfileSamples.meRaw }
        return ["id": "sample-me", "displayName": "Мария Орлова", "username": "maria", "avatarColor": "#9271C3"]
        #else
        return [:]
        #endif
    }

    override func build() {
        clear()
        let who = person
        if !who.isEmpty {
            // Profile: the reference's head (banner under the status bar, decorated avatar, platinum name, seal).
            profileChrome.attach(self, messenger: messenger)
            add(profileChrome.head(person: who), gap: 0)
            if !PlatinaState.shared.active && !PersonLook(who).platina { add(profileChrome.offer(), gap: 18) }
        }

        let profile = SettingsRow(symbol: "person", label: "Мой профиль")
        profile.onPress = { [weak self] in self?.openProfile() }
        // Stories: the account's own posts and stories (Sources/Stories/ProfilePosts.swift).
        let posts = SettingsRow(symbol: "square.grid.2x2", label: "Публикации и истории")
        posts.onPress = { [weak self] in
            guard let self, let messenger = self.messenger else { return }
            self.open(OwnPostsViewController(messenger: messenger))
        }
        addGroup(rows: [profile, posts])

        // How it sounds and looks. (The reference also has «Папки с чатами» here: not built in this app yet.)
        let notifications = SettingsRow(symbol: "bell", label: "Уведомления и звуки")
        notifications.onPress = { [weak self] in self?.openPage("notifications") }
        let shownTheme = ThemeStore.nightState()["shown"] as? String ?? "black"
        let appearance = SettingsRow(symbol: "paintpalette", label: "Оформление", value: ThemeStore.themeName(shownTheme))
        appearance.onPress = { [weak self] in self?.openPage("appearance") }
        // Effects: «Энергосбережение и анимации» and «Язык» (Settings/PowerSettings.swift, Settings/LanguageSettings.swift).
        let power = SettingsRow(symbol: "battery.50", label: "Энергосбережение и анимации")
        power.onPress = { [weak self] in self?.openPage("power") }
        let language = SettingsRow(symbol: "globe", label: "Язык", value: Language.chosenName)
        language.onPress = { [weak self] in self?.openPage("language") }
        // ChatsPlus: «Папки с чатами» — the folders above the chat list, kept on this device (Sources/ChatsPlus/ChatFolders.swift).
        let folders = SettingsRow(symbol: "folder", label: "Папки с чатами")
        folders.onPress = { [weak self] in self?.open(FoldersSettingsPage(messenger: self?.messenger)) }
        addGroup(rows: [notifications, appearance, folders, power, language])

        let privacy = SettingsRow(symbol: "lock", label: "Конфиденциальность")
        privacy.onPress = { [weak self] in
            guard let self, let messenger = self.messenger else { return }
            self.open(PrivacyViewController(messenger: messenger))
        }
        let security = SettingsRow(symbol: "checkmark.shield", label: "Безопасность")
        security.onPress = { [weak self] in
            guard let self, let messenger = self.messenger else { return }
            self.open(SecurityViewController(messenger: messenger))
        }
        let sessions = SettingsRow(symbol: "iphone", label: "Активные сеансы")
        sessions.onPress = { [weak self] in
            guard let self, let messenger = self.messenger else { return }
            self.open(SessionsViewController(messenger: messenger))
        }
        let blocked = SettingsRow(symbol: "hand.raised", label: "Заблокированные")
        blocked.onPress = { [weak self] in
            guard let self, let messenger = self.messenger else { return }
            self.open(BlockedViewController(messenger: messenger))
        }
        let data = SettingsRow(symbol: "externaldrive", label: "Данные и память")
        data.onPress = { [weak self] in self?.openPage("data") }
        addGroup(rows: [privacy, security, sessions, blocked, data])

        let help = SettingsRow(symbol: "lifepreserver", label: "Помощь и поддержка")
        help.onPress = { [weak self] in
            guard self?.messenger != nil, let address = URL(string: Account.server + "/support") else { return }
            UIApplication.shared.open(address, options: [:], completionHandler: nil)
        }
        let about = SettingsRow(symbol: "info.circle", label: "О приложении", value: SettingsViewController.appVersion)
        about.onPress = { [weak self] in self?.open(AboutViewController()) }
        addGroup(rows: [help, about])

        let leave = SettingsRow(symbol: "rectangle.portrait.and.arrow.right", label: "Выйти из аккаунта", danger: true)
        leave.onPress = { [weak self] in self?.askToLeave() }
        addGroup(rows: [leave])

        // What the app is made of, in one quiet line (the simulator check reads it by its identifier).
        let made = UILabel()
        made.text = "INVIZENT \(SettingsViewController.appVersion) · ядро \(Core.version)"
        made.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        made.textColor = Theme.subtle
        made.textAlignment = .center
        made.numberOfLines = 0
        made.accessibilityIdentifier = "core-version"
        add(made, gap: 18)
    }

    static var appVersion: String {
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }

    private func openProfile() {
        // Profile: «Мой профиль» is the read-only profile; «Изменить» there opens the editor.
        open(OwnProfileViewController(messenger: messenger))
    }

    private func openPage(_ name: String) {
        if let page = page(named: name) { open(page) }
    }

    /// The pages of how the app looks and sounds, by name (also what a change of the theme opens again on top
    /// of the rebuilt shell, see ThemeStore.swift). «Оформление» needs no account: it is kept on the device.
    func page(named name: String) -> UIViewController? {
        switch name {
        case "appearance": return AppearanceViewController(messenger: messenger)
        case "night": return NightThemeViewController()
        case "accent": return AccentColorViewController()
        case "notifications":
            guard let messenger else { return nil }
            return NotificationsViewController(messenger: messenger)
        case "data":
            guard let messenger else { return nil }
            return DataViewController(messenger: messenger)
        // Effects / Security: «Энергосбережение и анимации», «Язык», «Код-пароль» (Settings/ParityPages.swift).
        default: return parityPage(named: name, messenger: messenger)
        }
    }

    /// «Выйти из аккаунта» asks first: coming back needs the login, the long password and the confirmation word.
    private func askToLeave() {
        guard messenger != nil, !leaving else { return }
        confirm(heading: "Выйти из Инвиза?",
                words: "Сеанс на этом устройстве завершится. Для следующего входа понадобятся логин, пароль и слово подтверждения. Публичное имя может отличаться от логина.",
                action: "Выйти") { [weak self] in self?.leave() }
    }

    private func leave() {
        guard let messenger, !leaving else { return }
        leaving = true
        messenger.signOut { [weak self] result in
            guard let self else { return }
            self.leaving = false
            switch result {
            case .success(let notice): self.closeAccount(notice: notice)
            case .failure(let error): self.tell(error.words)
            }
        }
    }

    #if targetEnvironment(simulator)
    /// For the simulator check (`-settings <name>`): opens one page of the settings at once.
    func openDetail(_ name: String) {
        // «Оформление» and its pages: «night» and «accent» stand on top of «Оформление», as they are reached.
        if name == "night" || name == "accent" {
            if let under = page(named: "appearance") { navigationController?.pushViewController(under, animated: false) }
        }
        if let own = page(named: name) {
            navigationController?.pushViewController(own, animated: false)
            return
        }
        guard let messenger else {
            if name == "about" { navigationController?.pushViewController(AboutViewController(), animated: false) }
            return
        }
        var page: UIViewController? = nil
        switch name {
        case "profile": page = ProfileEditViewController(messenger: messenger)
        case "username": page = UsernameViewController(messenger: messenger)
        case "birthday": page = BirthdayViewController(value: messenger.ownProfile["birthday"] as? String, done: { _ in })
        case "privacy": page = PrivacyViewController(messenger: messenger)
        case "lastseen":
            let model = SettingsPrivacyModel(messenger: messenger)
            model.load()
            page = LastSeenViewController(model: model)
        case "security": page = SecurityViewController(messenger: messenger)
        case "password": page = SecretChangeViewController(messenger: messenger, form: .password, confirmationConfigured: true)
        case "confirmation": page = SecretChangeViewController(messenger: messenger, form: .confirmation, confirmationConfigured: true)
        case "recovery": page = SecretChangeViewController(messenger: messenger, form: .recovery, confirmationConfigured: true)
        case "sessions": page = SessionsViewController(messenger: messenger)
        case "session":
            let list = SessionsViewController(messenger: messenger)
            list.opensFirstWhenLoaded = true
            page = list
        case "blocked": page = BlockedViewController(messenger: messenger)
        case "delete": page = DeleteAccountViewController(messenger: messenger)
        case "about": page = AboutViewController()
        default: page = nil
        }
        if let page { navigationController?.pushViewController(page, animated: false) }
    }
    #endif
}

/// The top of the settings: the person's ball, their name and @username. Pressing it opens the profile.
final class SettingsHead: UIControl {
    var onPress: (() -> Void)?

    init(person: [String: Any], base: String) {
        super.init(frame: .zero)
        let ball = SettingsAvatar(frame: CGRect(x: 0, y: 0, width: 84, height: 84))
        ball.show(person, base: base)
        ball.isUserInteractionEnabled = false
        ball.translatesAutoresizingMaskIntoConstraints = false
        let name = person["displayName"] as? String ?? ""
        let handle = person["username"] as? String ?? ""
        let nameLabel = SettingsLook.words(name, size: 27, color: Theme.text, weight: .heavy)
        nameLabel.numberOfLines = 2
        let handleLabel = SettingsLook.words(handle.isEmpty ? "" : "@" + handle, size: 15, color: Theme.muted)
        handleLabel.numberOfLines = 1
        let texts = UIStackView(arrangedSubviews: [nameLabel, handleLabel])
        texts.axis = .vertical
        texts.spacing = 5
        texts.isUserInteractionEnabled = false
        texts.translatesAutoresizingMaskIntoConstraints = false
        addSubview(ball)
        addSubview(texts)
        NSLayoutConstraint.activate([
            ball.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            ball.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            ball.widthAnchor.constraint(equalToConstant: 84),
            ball.heightAnchor.constraint(equalToConstant: 84),
            texts.topAnchor.constraint(equalTo: ball.bottomAnchor, constant: 12),
            texts.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            texts.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            texts.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
        isAccessibilityElement = true
        accessibilityTraits.insert(.button)
        accessibilityLabel = "Мой профиль: " + name + (handle.isEmpty ? "" : ", @" + handle)
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }

    @objc private func pressed() {
        onPress?()
    }
}

/// «О приложении»: what the app is made of.
final class AboutViewController: SettingsPage {
    init() {
        super.init(name: "О приложении")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        let buildNumber = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        let app = SettingsRow(label: "Приложение", value: "INVIZENT " + SettingsViewController.appVersion, arrow: false)
        app.isUserInteractionEnabled = false
        let number = SettingsRow(label: "Сборка", value: buildNumber, arrow: false)
        number.isUserInteractionEnabled = false
        let core = SettingsRow(label: "Ядро", value: Core.version, arrow: false)
        core.isUserInteractionEnabled = false
        addGroup(rows: [app, number, core])
        add(SettingsLook.foot("Инвиз \(SettingsViewController.appVersion) · переписка защищена сквозным шифрованием"), gap: 10)
    }
}
