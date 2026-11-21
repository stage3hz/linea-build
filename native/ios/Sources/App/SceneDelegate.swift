import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.backgroundColor = .black
        window.overrideUserInterfaceStyle = .dark
        let root = RootViewController()
        window.rootViewController = UserDefaults.standard.bool(forKey: "corecheck") ? CoreCheckViewController() : root
        window.makeKeyAndVisible()
        self.window = window
        #if targetEnvironment(simulator)
        // For the simulator check: `-tab profile` opens a section at once, `-sections 1` opens the list of sections.
        if let tab = UserDefaults.standard.string(forKey: "tab") { root.loadViewIfNeeded(); root.show(tab) }
        if UserDefaults.standard.bool(forKey: "sections") { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { root.showSections() } }
        #endif
    }
}
