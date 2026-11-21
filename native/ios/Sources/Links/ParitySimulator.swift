import UIKit

#if targetEnvironment(simulator)
/// For the simulator check of the effects, the lock, the notices, the key check, the language and links:
///   -effects 1                 «Снег», «Ледяное стекло», «Пиксельный след» run (they are off in the simulator otherwise)
///   -snowheat 0…1              with -effects: the heat that melts the snow and the rime (0.9: almost gone)
///   -setlanguage en|ru         the interface language (kept until changed again)
///   -lockdemo digits|password|wrong    the lock screen with a sample code (nothing is kept)
///   -noticedemo login|recovery|both|loginsheet|recoverysheet    with -demo 1: «Новый вход» / «Запрос восстановления»
///   -trustdemo 1               «Защита чата» with two sample devices
///   -deeplink <url>            the app is handed a link (with an account: linea://invite/CODE opens «Приглашение»)
/// Pages of the settings (with -demo 1 or an account): -settings power | language | passcode | appearance;
/// with an account also lastseenallow | lastseendeny | callrules.
extension SceneDelegate {
    static func simulatorLanguage() {
        if let language = UserDefaults.standard.string(forKey: "setlanguage") { Language.set(language) }
    }

    func simulatorParity() {
        let args = UserDefaults.standard
        if let kind = args.string(forKey: "lockdemo") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let scene = self?.window?.windowScene else { return }
                let shown = UIWindow(windowScene: scene)
                shown.windowLevel = UIWindow.Level.alert + 1
                let screen = LockViewController()
                screen.sampleKind = kind == "password" ? "password" : "digits"
                shown.rootViewController = screen
                shown.makeKeyAndVisible()
                SceneDelegate.sampleWindow = shown
                if kind == "wrong" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { screen.simulatorWrong() }
                }
            }
        }
        if let notices = args.string(forKey: "noticedemo") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                AccountNotices.shared.showSamples(login: notices != "recovery" && notices != "recoverysheet", recovery: notices != "login" && notices != "loginsheet")
                guard notices.hasSuffix("sheet"), let screen = self?.window?.rootViewController else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    AccountNotices.shared.openSheet(notices == "loginsheet" ? "login" : "recovery", from: screen)
                }
            }
        }
        if args.bool(forKey: "trustdemo") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let screen = self?.window?.rootViewController else { return }
                TrustSheet.present(from: screen, messenger: nil, peerId: "sample-peer")
            }
        }
        if let link = args.string(forKey: "deeplink"), let url = URL(string: link) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { DeepLinks.shared.open(url) }
        }
    }

    private static var sampleWindow: UIWindow?
}

#endif
