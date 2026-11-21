import UIKit

/// «Защита чата»: the safety codes of the devices of a conversation (the person's and one's own other devices), to
/// compare in person or over a channel already trusted; the new keys are confirmed once compared. The codes and the
/// confirmation are the core's (`snapshot` / `approve` of the encryption service, the reference's
/// `trustSnapshot` / `approveDevices`); private keys are never shown. (The previous app: `mobile/src/e2ee/TrustSheet.tsx`.)
final class TrustSheet: SettingsPage {
    private let messenger: Messenger?
    private let peerId: String
    private var snapshot: [String: Any]?
    private var loading = false
    private var failure = ""
    private var busy = false
    private var checked = false
    private var revision = 0

    init(messenger: Messenger?, peerId: String) {
        self.messenger = messenger
        self.peerId = peerId
        super.init(name: "Защита чата", large: true)
    }

    required init?(coder: NSCoder) { return nil }

    /// Opens the sheet over whatever is on the screen.
    static func present(from screen: UIViewController, messenger: Messenger?, peerId: String) {
        let page = TrustSheet(messenger: messenger, peerId: peerId)
        let holder = UINavigationController(rootViewController: page)
        holder.setNavigationBarHidden(true, animated: false)
        if let sheet = holder.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        screen.present(holder, animated: true)
    }

    /// The line «Переписка защищена сквозным шифрованием» of a profile: « · проверить устройства», an arrow, and a
    /// tap that opens the sheet (the reference's `onSecurity` of `UserProfile.tsx`).
    static func attach(to line: UIStackView, words: UILabel, from screen: UIViewController, messenger: Messenger?, peerId: String) {
        guard let messenger, !peerId.isEmpty, peerId != messenger.userId else { return }
        words.text = (words.text ?? "") + " · проверить устройства"
        let arrow = UIImageView(image: UIImage(systemName: "chevron.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)))
        arrow.tintColor = Theme.muted
        arrow.setContentHuggingPriority(.required, for: .horizontal)
        line.addArrangedSubview(arrow)
        line.isUserInteractionEnabled = true
        line.accessibilityTraits = .button
        let tap = TrustTap(target: nil, action: nil)
        tap.open = { [weak screen] in
            guard let screen else { return }
            TrustSheet.present(from: screen, messenger: messenger, peerId: peerId)
        }
        tap.addTarget(tap, action: #selector(TrustTap.fired))
        line.addGestureRecognizer(tap)
    }

    override func build() {
        refresh()
    }

    private func refresh() {
        revision += 1
        let asked = revision
        loading = true
        failure = ""
        checked = false
        fill()
        guard let messenger else {
            #if targetEnvironment(simulator)
            // The simulator check: two sample devices, one new.
            loading = false
            snapshot = ["peerId": peerId, "devices": [
                ["deviceName": "iPhone 15", "code": "3F2A 91C0 7B44 E1D9 0A6F 22B8 C513 9E07", "trusted": false, "self": false],
                ["deviceName": "MacBook", "code": "A07C 5D1E 88F3 41B2 6C9A 0E5D 73F8 B214", "trusted": true, "self": true],
            ]]
            fill()
            #endif
            return
        }
        messenger.crypto.call("snapshot", [peerId]) { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self, asked == self.revision else { return }
            self.loading = false
            switch result {
            case .success(let value): self.snapshot = value as? [String: Any]
            case .failure(let problem): self.failure = problem.message.isEmpty ? "Не удалось получить ключи." : problem.message
            }
            self.fill()
        }
    }

    private func approve() {
        guard let snapshot, let messenger, checked, !busy else { return }
        let asked = revision
        busy = true
        failure = ""
        fill()
        messenger.crypto.call("approve", [snapshot]) { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self, asked == self.revision else { return }
            self.busy = false
            switch result {
            case .success:
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                self.dismiss(animated: true)
            case .failure(let problem):
                self.failure = problem.message.isEmpty ? "Не удалось сохранить проверку ключей." : problem.message
                self.fill()
            }
        }
    }

    private func fill() {
        clear()
        add(SettingsLook.words("Сверь коды при личной встрече или по уже доверенному каналу связи. Для одной пары устройств код на обоих экранах должен совпадать. Приватные ключи здесь не показываются.", size: 14, color: Theme.muted), gap: 4)
        if loading {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.color = Theme.accent
            spinner.startAnimating()
            add(spinner, gap: 16)
        }
        if !failure.isEmpty { add(SettingsNotice(failure, error: true, onRetry: { [weak self] in self?.refresh() }), gap: 16) }
        let devices = snapshot?["devices"] as? [[String: Any]] ?? []
        for device in devices {
            let trusted = device["trusted"] as? Bool ?? false
            let own = device["self"] as? Bool ?? false
            let icon = UIImageView(image: SettingsLook.symbol(trusted ? "checkmark.shield" : "shield", size: 19, weight: .medium))
            icon.tintColor = trusted ? Theme.accent : Theme.danger
            icon.setContentHuggingPriority(.required, for: .horizontal)
            let name = SettingsLook.words(own ? "Твоё другое устройство" : "Устройство собеседника", size: 15, color: Theme.text, weight: .bold)
            let deviceName = device["deviceName"] as? String ?? ""
            let state = SettingsLook.words(deviceName + " · " + (trusted ? "ты подтвердил этот ключ" : "новый ключ"), size: 12, color: Theme.muted)
            let texts = UIStackView(arrangedSubviews: [name, state])
            texts.axis = .vertical
            texts.spacing = 3
            let head = UIStackView(arrangedSubviews: [icon, texts])
            head.axis = .horizontal
            head.alignment = .center
            head.spacing = 9
            let code = UILabel()
            code.attributedText = NSAttributedString(string: device["code"] as? String ?? "", attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 15, weight: .regular), .foregroundColor: Theme.text, .kern: 0.8])
            code.numberOfLines = 0
            let card = UIStackView(arrangedSubviews: [head, code])
            card.axis = .vertical
            card.spacing = 10
            let box = SettingsLook.inset(card, top: 15, side: 15, bottom: 15)
            box.layer.cornerRadius = 18
            box.layer.borderWidth = 1
            box.layer.borderColor = (trusted ? ThemeStore.look.border : Theme.accent).cgColor
            add(box, gap: 16)
        }
        let pending = devices.contains { (device: [String: Any]) -> Bool in !(device["trusted"] as? Bool ?? false) }
        if pending {
            let mark = UIImageView(image: SettingsLook.symbol(checked ? "checkmark.square.fill" : "square", size: 20, weight: .regular))
            mark.tintColor = Theme.accent
            mark.setContentHuggingPriority(.required, for: .horizontal)
            let words = SettingsLook.words("Я сверил все новые коды с собеседником и своими устройствами.", size: 13, color: Theme.text)
            let line = UIStackView(arrangedSubviews: [mark, words])
            line.axis = .horizontal
            line.alignment = .center
            line.spacing = 10
            line.isUserInteractionEnabled = false
            line.translatesAutoresizingMaskIntoConstraints = false
            let row = UIControl()
            row.addSubview(line)
            NSLayoutConstraint.activate([
                line.topAnchor.constraint(equalTo: row.topAnchor, constant: 8),
                line.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -8),
                line.leadingAnchor.constraint(equalTo: row.leadingAnchor),
                line.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            ])
            row.isAccessibilityElement = true
            row.accessibilityTraits = checked ? [.button, .selected] : .button
            row.accessibilityLabel = words.text
            row.addAction(UIAction { [weak self] (_: UIAction) -> Void in
                guard let self else { return }
                self.checked.toggle()
                self.fill()
            }, for: .touchUpInside)
            add(row, gap: 12)
            let confirm = SettingsButton(label: "Подтвердить проверенные ключи")
            confirm.isEnabled = checked && !loading
            confirm.alpha = confirm.isEnabled ? 1 : 0.5
            if busy { confirm.setBusy(true) }
            confirm.onPress = { [weak self] in self?.approve() }
            add(confirm, gap: 8)
        } else if snapshot != nil {
            add(SettingsNotice("Ключи этих устройств подтверждены. При появлении нового устройства приложение снова запросит проверку."), gap: 16)
        }
        add(SettingsLook.words("Смена пароля не восстанавливает утраченные ключи истории. На новом телефоне сообщения, отправленные до добавления его ключа, могут быть недоступны.", size: 12, color: Theme.muted), gap: 16)
    }
}

/// A tap that carries what it opens.
final class TrustTap: UITapGestureRecognizer {
    var open: (() -> Void)?
    @objc func fired() { open?() }
}
