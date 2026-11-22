import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        OldAppSettings.importOnce() // Storage: the previous app's choices, once, before anything reads its settings (Storage/OldAppSettings.swift)
        Typography.install() // Fonts: Montserrat and Unbounded, as the reference (Design/Typography.swift)
        Push.shared.install() // Push: the notification centre's delegate before launch ends, so a tap that started the app is kept (Shell/Push.swift)
        return true
    }

    /// Push: the APNs token of this device (Shell/Push.swift registers it for the signed-in session).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.shared.registered(deviceToken)
    }

    /// Push: no token — a build without the Push entitlement (every sideloaded build) or no way to Apple.
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Push.shared.failed(error)
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
    }
}
