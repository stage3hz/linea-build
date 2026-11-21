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
        start()
        window.makeKeyAndVisible()
    }

    /// Decides what the app opens with: the chats of the signed-in account, or signing in.
    private func start() {
        #if targetEnvironment(simulator)
        if simulatorStart() { return }
        #endif
        guard let token = Account.token else { return showAuth() }
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
        } catch {
            // The storage did not open: nothing is replaced, nothing is deleted — the person is told.
            showWaiting("Не удалось открыть зашифрованное хранилище. Ключи и сообщения сохранены без изменений.\nКоснись, чтобы повторить.")
        }
    }

    private func showAuth() {
        let auth = AuthViewController(server: Server(base: Account.server))
        auth.onSignedIn = { [weak self] token, user in self?.open(token: token, user: user) }
        window?.rootViewController = auth
    }

    private func showWaiting(_ words: String) {
        let screen = WaitingViewController(words: words)
        screen.onRetry = { [weak self] in self?.start() }
        window?.rootViewController = screen
    }

    #if targetEnvironment(simulator)
    /// What the simulator check asks for by launch arguments. True when one of them decided the start.
    ///   -corecheck 1                    the Swift↔core and storage check screen
    ///   -auth 1                         the sign-in screen
    ///   -authmode register / recover / waiting / reset    with -auth: that step of the sign-in screen (read in AuthViewController)
    ///   -demo 1                         the shell with sample chats (no account)
    ///   -tab profile / -sections 1 / -chat 1    with -demo: a section, the list of sections, the sample chat
    ///   -login … -password … -word …    signs in to the test server given by -server (https://localhost:…) only
    ///   -openchat 1                     with an account: opens the first chat of the list
    ///   -tab people / -peoplesearch <query> / -profile friend|chat    «Люди» and a profile, with an account or -demo (People/PeopleSimulator.swift)
    private func simulatorStart() -> Bool {
        let args = UserDefaults.standard
        if args.bool(forKey: "corecheck") { window?.rootViewController = CoreCheckViewController(); return true }
        if args.bool(forKey: "auth") { showAuth(); return true }
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
                root.openFirstChat()
            }
        }
        // People: with an account — a section, the search, a profile (People/PeopleSimulator.swift).
        if args.string(forKey: "tab") != nil || args.string(forKey: "peoplesearch") != nil || args.string(forKey: "profile") != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let stack = self?.window?.rootViewController as? NavigationController, let root = stack.viewControllers.first as? RootViewController else { return }
                PeopleSimulator.run(stack: stack, root: root)
            }
        }
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
