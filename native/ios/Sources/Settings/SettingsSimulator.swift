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
extension SceneDelegate {
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
