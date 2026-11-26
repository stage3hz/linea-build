import UIKit

/// Links that open the app: `linea://invite/CODE` (the URL schemes in project.yml: the previous app's),
/// and `https://invizent.com/i/CODE` when the system hands such a link over. Only our own addresses are recognised
/// (`ChannelWords.inviteCode`, the reference's `inviteCodeFrom`); the invitation itself is always asked from our
/// server by its code and shown as «Приглашение» over «Каналы» (Channels/CommunityForms.swift, `InvitePage`).
/// A link that comes before the account is open waits for it. (The previous app: `App.tsx`, `Linking`.)
final class DeepLinks {
    static let shared = DeepLinks()
    private var waiting: String?

    /// A link given to the app (at start, or while it runs). True when it was ours.
    @discardableResult
    func open(_ url: URL) -> Bool {
        guard let code = ChannelWords.inviteCode(in: url.absoluteString) else { return false }
        waiting = code
        DispatchQueue.main.async { self.deliver() }
        return true
    }

    /// The account is open now (Security/AccountNotices.swift): a waiting link is shown.
    func accountReady() {
        guard waiting != nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.deliver() }
    }

    private func deliver(tries: Int = 10) {
        guard let code = waiting else { return }
        guard let messenger = AccountNotices.shared.messenger, !LockGate.shared.locked else {
            // Not signed in yet, or locked: tried again shortly (and again when the account opens).
            if tries > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.deliver(tries: tries - 1) } }
            return
        }
        guard let window = DeepLinks.mainWindow(), let stack = window.rootViewController as? NavigationController,
              let root = stack.viewControllers.first as? RootViewController else {
            if tries > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.deliver(tries: tries - 1) } }
            return
        }
        waiting = nil
        stack.presentedViewController?.dismiss(animated: false)
        stack.popToRootViewController(animated: false)
        root.loadViewIfNeeded()
        root.show("channels")
        ChannelsRoute.openInvite(from: root, messenger: messenger, code: code)
    }

    static func mainWindow() -> UIWindow? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows where window.rootViewController is NavigationController { return window }
        }
        return nil
    }
}

extension SceneDelegate {
    /// Links: a link opened while the app runs (or wakes it).
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { DeepLinks.shared.open(context.url) }
    }

    /// Links: an https link to our address handed over by the system.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL else { return }
        DeepLinks.shared.open(url)
    }

    /// Effects, Security, Links and Language: everything they need at start, in one place.
    /// `early`: before the first screen is made (the language must be in place before any text is shown).
    static func parityEarly() {
        #if targetEnvironment(simulator)
        simulatorLanguage()
        #endif
        Language.install()
    }

    /// After the window is on the screen: the effects, the lock, and a link the app was opened with.
    func parityStart(_ window: UIWindow, links: Set<UIOpenURLContext>, activities: Set<NSUserActivity>) {
        EffectsHost.shared.attach(window)
        LockGate.shared.attach(window)
        for context in links { DeepLinks.shared.open(context.url) }
        for activity in activities where activity.activityType == NSUserActivityTypeBrowsingWeb {
            if let url = activity.webpageURL { DeepLinks.shared.open(url) }
        }
        #if targetEnvironment(simulator)
        simulatorParity()
        SimulatorWatch.start(window) // the main thread's stalls and every touch, written to the log (App/SimulatorWatch.swift)
        #endif
    }
}
