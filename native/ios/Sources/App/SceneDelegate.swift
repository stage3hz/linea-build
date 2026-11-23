import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var messenger: Messenger?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.backgroundColor = .black
        window.overrideUserInterfaceStyle = .dark
        self.window = window
        #if targetEnvironment(simulator)
        SceneDelegate.simulatorLook() // Settings: -settheme and the like (Settings/SettingsSimulator.swift)
        #endif
        ThemeStore.attach(window) // Settings: the theme the person chose (Settings/ThemeStore.swift)
        SceneDelegate.parityEarly() // Language: the interface language before any text (Links/DeepLinks.swift)
        start()
        window.makeKeyAndVisible()
        // Effects / Security / Links: snow, trail, rime; the code lock; a link the app was opened with (Links/DeepLinks.swift).
        parityStart(window, links: connectionOptions.urlContexts, activities: connectionOptions.userActivities)
    }

    /// Decides what the app opens with: the chats of the signed-in account, or signing in.
    private func start() {
        #if targetEnvironment(simulator)
        if simulatorStart() { return }
        #endif
        guard let token = Account.token else {
            showAuth()
            IntroOverlay.shared.firstStart(over: window) // Intro: once per install, over the sign-in screen (Intro/IntroOverlay.swift)
            return
        }
        if let user = Account.cachedUser { return open(token: token, user: user) }
        // Signed in by the previous app: the token is there, the profile is asked from the server once.
        showWaiting("Загрузка…")
        Server(base: Account.server, token: token).op("me", []) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success(let body):
                    guard let user = (body as? [String: Any])?["user"] as? [String: Any] else { self?.showAuth(); return }
                    self?.open(token: token, user: user)
                case .failure(.refused(_, let status, _, _)) where status == 401:
                    Account.token = nil
                    self?.showAuth()
                case .failure(let error):
                    self?.showWaiting(error.words + "\nКоснись, чтобы повторить.")
                }
            }
        }
    }

    private func open(token: String, user: [String: Any]) {
        do {
            let messenger = try Messenger(token: token, user: user)
            self.messenger = messenger
            Account.token = token
            Account.cachedUser = user
            window?.rootViewController = NavigationController(rootViewController: RootViewController(messenger: messenger))
            Push.shared.start(messenger) // Push: permission once, this device's token for the session (Shell/Push.swift)
        } catch {
            // Which step failed, for the device's log: the error's kind and Vault's own non-secret note (keychain
            // status, SQLite result code, the file's size) — never a key or anything stored.
            let step = Vault.lastFailure.isEmpty ? "not the storage" : Vault.lastFailure
            NSLog("Linea: the account did not open: %@ (%@)", String(describing: type(of: error)), step)
            // The kept profile is forgotten (only that — never a key or the storage): «Коснись, чтобы повторить» then
            // asks the server for it afresh instead of meeting the same record again.
            Account.cachedUser = nil
            // The storage did not open: nothing is replaced, nothing is deleted — the person is told.
            showWaiting("Не удалось открыть зашифрованное хранилище. Ключи и сообщения сохранены без изменений.\nКоснись, чтобы повторить.")
        }
    }

    private func showAuth() {
        let auth = AuthViewController(server: Server(base: Account.server))
        auth.onSignedIn = { [weak self] token, user in self?.open(token: token, user: user) }
        window?.rootViewController = auth
    }

    /// Settings: the account was left (signed out, a secret changed, the session ended, the account deleted).
    /// The session is already forgotten (Settings/AccountActions.swift); signing in is shown, with a few words why.
    func closeAccount(notice: String) {
        // Nothing of the closed account goes on by itself: its live line and the music stop here.
        // Calls: a call that is on ends with the account (the other side is told while the session still lives).
        Calls.shared.stop()
        // Rooms: the room this phone is in is left with the account, and its list is forgotten.
        Rooms.shared.stop()
        LinkFetcher.shared.forget()
        AppBadge.shared.clear() // Links: no number on the icon without an account (Links/AppBadge.swift)
        Push.shared.forget() // Push: a tap that waits for this account is dropped (Shell/Push.swift)
        messenger?.live.stop()
        MusicPlayer.shared.stop()
        messenger = nil
        showAuth()
        guard !notice.isEmpty else { return }
        let alert = UIAlertController(title: nil, message: notice, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
        DispatchQueue.main.async { [weak self] in self?.window?.rootViewController?.present(alert, animated: true) }
    }

    private func showWaiting(_ words: String) {
        let screen = WaitingViewController(words: words)
        screen.onRetry = { [weak self] in self?.start() }
        window?.rootViewController = screen
    }

    #if targetEnvironment(simulator)
    /// What the simulator check asks for by launch arguments. True when one of them decided the start.
    ///   -corecheck 1                    the Swift↔core and storage check screen
    ///   -takeovercheck 1 -takeoveruser <id> [-takeoverexpect "a|b"]    what the previous app left: session, keys, storage, history (Storage/TakeoverCheck.swift)
    ///   -auth 1                         the sign-in screen
    ///   -authmode register / recover / waiting / reset    with -auth: that step of the sign-in screen (read in AuthViewController)
    ///   -demo 1                         the shell with sample chats (no account)
    ///   -tab profile / -sections 1 / -chat 1    with -demo: a section, the list of sections, the sample chat
    ///   -login … -password … -word …    signs in to the test server given by -server (https://localhost:…) only
    ///   -openchat 1                     with an account: opens the first chat of the list
    ///   -tab people / -peoplesearch <query> / -profile friend|chat    «Люди» and a profile, with an account or -demo (People/PeopleSimulator.swift)
    ///   -settings <page>                «Настройки» and one of its pages, with an account (about, appearance, night, accent: also with -demo) (Settings/SettingsSimulator.swift)
    ///   -settheme / -setaccent / -settextsize / -setnight / -setplatina    the look for the shot (Settings/SettingsSimulator.swift)
    ///   -attachdemo 1|viewer / -openattachment photo|file    attachments: sample rows in the -demo chat; with an account, opens the chat's newest photo or file (Attachments/ChatAttachments.swift)
    ///   -channelsdemo 1|community|blog|chat|menu|settings / -channels community|chat|create|join    «Каналы»: samples without an account; with an account, a community, a channel, a form (Channels/ChannelsSimulator.swift)
    ///   -aidemo 1|history / -musicdemo 1|player    «AI» and «Музыка» with samples, no account (Music/MusicSimulator.swift); with an account: -tab ai, -tab music
    ///   -chatdemo menu|delete|reply|edit|pinned|select|forward|quotes|typing|draft    actions on messages in the -demo chat; -chataction menu|delete|reply|edit|pin|select|forward|react with -openchat 1 (ChatActions/ChatScreenActions.swift)
    ///   -chatlist menu|mute|delete|archive|archived|draft|unread / -chatsearch <query>    actions on the chats of the list, with an account or -demo (ChatActions/ChatListActions.swift)
    ///   -calldemo outgoing|incoming|active|video|ended|retry|bar / -call 1    calls: a sample call in each state, no account; with an account, a call to the person of the first chat (Calls/CallOverlay.swift)
    ///   -screendemo panel|viewer|starting|sharing|error|room|bar    screen sharing in a voice channel and a room: samples with drawn frames, no account (ScreenShare/ScreenShareSimulator.swift)
    ///   -roomsdemo list|empty|room|video|outside|ring|bar|music|menu|rename|gone|picker / -rooms list|room|enter|picker    rooms: samples without an account; with an account, the list in «Каналы», the first room, «Выбрать» (Rooms/RoomsSimulator.swift)
    ///   -storiesdemo strip|viewer|viewers|compose|posts|own / -stories viewer|own|ownstories|compose    stories and posts: samples with drawn pictures, no account; with an account, the strip's first person, the account's own page (Stories/StoriesSimulator.swift)
    ///   -linkdemo 1|composer / -linksend 1    cards of links: sample rows in the -demo chat (composer: also the card above the field); with -openchat 1 on the local test server, sends one message with a prepared card (LinkPreview/LinkDemo.swift)
    ///   -profiledemo rings|code|art|list|marks|fonts|person|birthday|own|gifts|showcase|studio|confetti|offer|mini|mini-chat|media|cropper|banner|pattern|status|giftsheet    avatars, profiles, Platina, gifts, fonts with samples, no account (Profile/ProfileSimulator.swift)
    ///   -intro hold <seconds>          the sign-in screen with the first-launch intro frozen at that time (Intro/IntroOverlay.swift)
    ///   -motionblur 1|0|hold           motion blur of slides forced on / off / on with the strongest smear held for a still shot (Effects/MotionBlur.swift) // MotionBlur:
    private func simulatorStart() -> Bool {
        let args = UserDefaults.standard
        if args.bool(forKey: "corecheck") { window?.rootViewController = CoreCheckViewController(); return true }
        // Update check: what the previous app left on the phone, read only (Storage/TakeoverCheck.swift).
        if args.bool(forKey: "takeovercheck") { window?.rootViewController = TakeoverCheckViewController(); return true }
        // Intro: -intro hold <seconds> — the sign-in screen with the first-launch intro frozen at that time, no haptics,
        // the seen flag untouched (Intro/IntroOverlay.swift).
        let arguments = ProcessInfo.processInfo.arguments
        if let at = arguments.firstIndex(of: "-intro"), at + 1 < arguments.count, arguments[at + 1] == "hold" {
            let seconds = at + 2 < arguments.count ? (Double(arguments[at + 2]) ?? 0) : 0
            showAuth()
            IntroOverlay.shared.hold(over: window, at: seconds)
            return true
        }
        if args.bool(forKey: "auth") { showAuth(); return true }
        if simulatorScreenShare() { return true } // ScreenShare: -screendemo panel|viewer|starting|sharing|error|room|bar (ScreenShare/ScreenShareSimulator.swift)
        if simulatorChannels() { return true }
        if simulatorCalls() { return true }
        if simulatorRooms() { return true }
        if simulatorAIMusic() { return true }
        if simulatorStories() { return true }
        if simulatorProfiles() { return true } // Profile: avatars, profiles, Platina, gifts, fonts (Profile/ProfileSimulator.swift)
        if let page = args.string(forKey: "settings") { simulatorSettings(page) }
        if args.bool(forKey: "demo") {
            let root = RootViewController()
            let stack = NavigationController(rootViewController: root)
            window?.rootViewController = stack
            if args.bool(forKey: "chat") { stack.pushViewController(ChatViewController(name: "Алиса Воронцова"), animated: false) }
            if let tab = args.string(forKey: "tab") { root.loadViewIfNeeded(); root.show(tab) }
            if args.bool(forKey: "sections") { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { root.showSections() } }
            if args.string(forKey: "peoplesearch") != nil || args.string(forKey: "profile") != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { PeopleSimulator.run(stack: stack, root: root) } }
            return true
        }
        if let login = args.string(forKey: "login"), let password = args.string(forKey: "password"), Account.server.hasPrefix("https://localhost:") {
            showWaiting("Вход…")
            Server(base: Account.server).op("login", [login, password, args.string(forKey: "word") ?? ""]) { [weak self] result in
                DispatchQueue.main.async {
                    guard case .success(let body) = result, let session = body as? [String: Any], let token = session["token"] as? String, let user = session["user"] as? [String: Any] else {
                        if case .failure(let error) = result { self?.showWaiting("Вход не удался: " + error.words) }
                        return
                    }
                    self?.open(token: token, user: user)
                }
            }
            return true
        }
        if args.bool(forKey: "openchat") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let stack = self?.window?.rootViewController as? NavigationController, let root = stack.viewControllers.first as? RootViewController else { return }
                // ChatActions: the list of chats comes from the server; the first chat is opened once it is there.
                PeopleSimulator.openFirstChat(stack: stack, root: root, tries: 20) { (_: ChatViewController) -> Void in }
            }
        }
        // People: with an account — a section, the search, a profile (People/PeopleSimulator.swift).
        if args.string(forKey: "tab") != nil || args.string(forKey: "peoplesearch") != nil || args.string(forKey: "profile") != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let stack = self?.window?.rootViewController as? NavigationController, let root = stack.viewControllers.first as? RootViewController else { return }
                PeopleSimulator.run(stack: stack, root: root)
            }
        }
        // Calls: -call 1 presses «Позвонить» in the first chat (Calls/CallOverlay.swift).
        simulatorCallWithAccount()
        return false
    }
    #endif
}

/// A screen with a few words: waiting, or something that did not work and can be tried again by a touch.
final class WaitingViewController: UIViewController {
    private let words: String
    var onRetry: (() -> Void)?

    init(words: String) {
        self.words = words
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        let label = UILabel()
        label.text = words
        label.font = .systemFont(ofSize: 17)
        label.textColor = Theme.muted
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
        ])
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(retry)))
    }

    @objc private func retry() { onRetry?() }
}
