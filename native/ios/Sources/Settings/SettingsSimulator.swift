import UIKit

#if targetEnvironment(simulator)
/// For the simulator check: `-settings <page>` opens «Настройки» and one of its pages as soon as the shell is
/// on the screen (after the sign-in of the same launch, when there is one).
///
///   -settings root            the section itself (the same as -tab profile)
///   -settings profile         «Мой профиль»
///   -settings username        «Имя пользователя»
///   -settings birthday        «День рождения»
///   -settings privacy         «Конфиденциальность»
///   -settings lastseen        «Время захода»
///   -settings security        «Безопасность»
///   -settings password | confirmation | recovery    the form of one secret
///   -settings sessions        «Активные сеансы»
///   -settings session         the details of this device's session
///   -settings blocked         «Заблокированные»
///   -settings delete          «Удалить аккаунт»
///   -settings about           «О приложении» (also with -demo 1)
///   -settings appearance      «Оформление» (also with -demo 1)
///   -settings night           «Ночная тема», on top of «Оформление» (also with -demo 1)
///   -settings accent          «Цвет интерфейса», on top of «Оформление» (also with -demo 1)
///   -settings notifications   «Уведомления и звуки»
///   -settings data            «Данные и память»
///
/// With any of them, the look itself can be set for the shot (kept on the simulator until changed again):
///   -settheme light|dark|black|graphite|amethyst|coffee|olive|dusk|lagoon|indigo|neon   the theme (a palette also needs -setplatina 1)
///   -setaccent RRGGBB | none  «Цвет интерфейса»
///   -settextsize small|medium|large|xlarge
///   -setnight system|off|schedule|auto   when the night theme turns on by itself
///   -setplatina 1|0           what the phone remembers of the account's Platina (with an account the server's answer replaces it)
extension SceneDelegate {
    /// The look asked for by launch arguments; called before the first screen is made.
    static func simulatorLook() {
        let args = UserDefaults.standard
        var touched = false
        if let platina = args.string(forKey: "setplatina") { ThemeStore.platina = platina == "1"; touched = true }
        if let theme = args.string(forKey: "settheme") {
            ThemeStore.mode = theme
            if theme != "light" { ThemeStore.darkTheme = theme }
            DevicePreferences.set(["nightMode": "off", "nightForced": NSNull(), "nightForcedAt": NSNull()], quiet: true)
            touched = true
        }
        if let accent = args.string(forKey: "setaccent") {
            var value: Any = NSNull()
            if accent != "none" { value = "#" + accent.uppercased() }
            DevicePreferences.set(["accentColor": value], quiet: true)
            touched = true
        }
        if let size = args.string(forKey: "settextsize") { DevicePreferences.set(["textSize": size], quiet: true); touched = true }
        if let night = args.string(forKey: "setnight") {
            DevicePreferences.set(["nightMode": night, "nightForced": NSNull(), "nightForcedAt": NSNull()], quiet: true)
            touched = true
        }
        if touched { ThemeStore.refresh() }
    }

    func simulatorSettings(_ page: String, tries: Int = 60) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            guard let stack = self.window?.rootViewController as? NavigationController, let root = stack.viewControllers.first as? RootViewController else {
                if tries > 1 { self.simulatorSettings(page, tries: tries - 1) }
                return
            }
            root.loadViewIfNeeded()
            root.show("profile")
            guard page != "root", let settings = root.settingsPage() else { return }
            settings.loadViewIfNeeded()
            settings.openDetail(page)
        }
    }
}
#endif
