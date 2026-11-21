import UIKit

/// The first screen of the project's life: shows that Swift and the shared core talk to each other.
/// It is replaced by the real first screen once there is one.
final class CoreCheckViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let own = Core.Device(userId: "0f8fad5b-d9cb-469f-a165-70867728950e", deviceId: "00000000-0000-4000-8000-000000000001", identityKey: String(repeating: "A", count: 44), registrationId: 77)
        let other = Core.Device(userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", deviceId: "d0000001-0000-4000-8000-000000000001", identityKey: String(repeating: "B", count: 44), registrationId: 16000)
        let code = Core.safetyCode(own: own, other: other) ?? "нет ответа от ядра"

        let title = UILabel()
        title.text = "INVIZENT"
        title.font = .systemFont(ofSize: 34, weight: .bold)
        title.textColor = .white
        let version = UILabel()
        version.text = "ядро \(Core.version)"
        version.font = .systemFont(ofSize: 17)
        version.textColor = UIColor(white: 0.6, alpha: 1)
        version.accessibilityIdentifier = "core-version"
        let codeLabel = UILabel()
        codeLabel.text = code
        codeLabel.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        codeLabel.textColor = .white
        codeLabel.numberOfLines = 0
        codeLabel.textAlignment = .center
        codeLabel.accessibilityIdentifier = "safety-code"

        let stack = UIStackView(arrangedSubviews: [title, version, codeLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.setCustomSpacing(28, after: version)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }
}
