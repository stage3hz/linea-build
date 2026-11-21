import UIKit

/// The settings section. For now: what the app is made of.
final class SettingsViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        let heading = UILabel()
        heading.text = "Настройки"
        heading.font = .systemFont(ofSize: 34, weight: .bold)
        heading.textColor = Theme.text
        let version = UILabel()
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        version.text = "INVIZENT \(app) · ядро \(Core.version)"
        version.font = .systemFont(ofSize: 15)
        version.textColor = Theme.muted
        version.accessibilityIdentifier = "core-version"
        let stack = UIStackView(arrangedSubviews: [heading, version])
        stack.axis = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -20),
        ])
    }
}
