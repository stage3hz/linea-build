import UIKit

/// The pages of the settings added for parity with the previous app, by the names `SettingsViewController.page(named:)`
/// opens them with (also the names of `-settings <page>` on the simulator).
extension SettingsViewController {
    func parityPage(named name: String, messenger: Messenger?) -> UIViewController? {
        switch name {
        case "power": return PowerSettingsViewController()
        case "language": return LanguageSettingsViewController()
        case "passcode": return PasscodeViewController()
        case "lastseenallow", "lastseendeny":
            guard let messenger else { return nil }
            let model = SettingsPrivacyModel(messenger: messenger)
            model.load()
            return LastSeenExceptionsViewController(messenger: messenger, model: model, rule: name == "lastseenallow" ? "allow" : "deny")
        case "callrules":
            guard let messenger else { return nil }
            return CallRulesViewController(messenger: messenger)
        default: return nil
        }
    }
}
