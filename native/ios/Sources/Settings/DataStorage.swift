import UIKit

/// «Данные и память»: how much of the account's storage on the server is used, and the temporary files this
/// phone keeps. (The previous app: `DataSection` and `ServerStorage` of `mobile/src/SettingsScreen.tsx`.)
///
/// The temporary files counted and cleared here are the attachments decrypted for viewing (`DecryptedFiles`):
/// the only cache this app keeps that can be thrown away at any moment. Messages, keys and music are not touched.
final class DataViewController: SettingsPage {
    private let messenger: Messenger
    private var limits: [String: Any]?
    private var limitsFailed = false
    private var cacheBytes: Int?
    private var clearing = false
    private var doneWords = ""

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Данные и память")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        fill()
        loadLimits()
        measure()
    }

    private func loadLimits() {
        messenger.server.send("GET", "/e2ee/limits") { [weak self] (result: Result<Any, ServerError>) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let body) = result, let fresh = body as? [String: Any] {
                    self.limits = fresh
                } else {
                    self.limitsFailed = true
                }
                self.fill()
            }
        }
    }

    /// The size of what `DecryptedFiles` has written to the temporary area and not removed yet.
    private func measure() {
        cacheBytes = nil
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let total = DataViewController.temporaryBytes()
            DispatchQueue.main.async {
                guard let self else { return }
                self.cacheBytes = total
                self.fill()
            }
        }
    }

    private static func temporaryBytes() -> Int {
        let manager = FileManager.default
        let area = manager.temporaryDirectory
        let names = (try? manager.contentsOfDirectory(atPath: area.path)) ?? []
        var total = 0
        for name in names where name.hasPrefix("invizent-view-") {
            let folder = area.appendingPathComponent(name, isDirectory: true)
            guard let walker = manager.enumerator(at: folder, includingPropertiesForKeys: [.fileSizeKey]) else { continue }
            for case let file as URL in walker {
                total += (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            }
        }
        return total
    }

    /// «1.3 МБ» / «20 ГБ», as the reference writes sizes (the core's `settingsSize`).
    private static func words(_ bytes: Double, storage: Bool) -> String {
        let read = Core.view("settingsSize", [max(0, bytes)]) as? [String: Any]
        return read?[storage ? "storage" : "size"] as? String ?? ""
    }

    private func line(symbol: String, label: String, value: String) -> UIView {
        let icon = UIImageView(image: SettingsLook.symbol(symbol, size: 18, weight: .regular))
        icon.tintColor = Theme.accent
        icon.setContentHuggingPriority(.required, for: .horizontal)
        let name = SettingsLook.words(label, size: 15, color: Theme.text)
        let amount = SettingsLook.words(value, size: 15, color: Theme.text, weight: .bold)
        amount.textAlignment = .right
        amount.setContentHuggingPriority(.required, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [icon, name, amount])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        return row
    }

    private func fill() {
        clear()
        // «Файлы на сервере».
        var usedWords = "…"
        var share: CGFloat = 0
        if let limits {
            let used = (limits["usedBytes"] as? NSNumber)?.doubleValue ?? 0
            let whole = (limits["storageBytes"] as? NSNumber)?.doubleValue ?? 0
            usedWords = DataViewController.words(used, storage: true) + " / " + DataViewController.words(whole, storage: true)
            share = CGFloat(min(1, used / max(1, whole)))
        } else if limitsFailed {
            usedWords = "Недоступно"
        }
        let track = UIView()
        track.backgroundColor = Theme.veil(0.10)
        track.layer.cornerRadius = 3
        track.layer.masksToBounds = true
        let filled = UIView()
        filled.backgroundColor = share > 0.9 ? Theme.danger : Theme.accent
        filled.translatesAutoresizingMaskIntoConstraints = false
        track.addSubview(filled)
        NSLayoutConstraint.activate([
            track.heightAnchor.constraint(equalToConstant: 6),
            filled.leadingAnchor.constraint(equalTo: track.leadingAnchor),
            filled.topAnchor.constraint(equalTo: track.topAnchor),
            filled.bottomAnchor.constraint(equalTo: track.bottomAnchor),
            filled.widthAnchor.constraint(equalTo: track.widthAnchor, multiplier: max(0.001, share)),
        ])
        let server = UIStackView(arrangedSubviews: [line(symbol: "cloud", label: "Использовано", value: usedWords), track])
        server.axis = .vertical
        server.spacing = 10
        if let limits {
            let platina = limits["platina"] as? Bool ?? false
            server.addArrangedSubview(SettingsLook.words(platina ? "Видео до 10 ГБ, файлы до 4 ГБ (Platina), всего 40 ГБ." : "Видео до 10 ГБ, файлы до 2 ГБ, всего 20 ГБ. С Platina — файлы до 4 ГБ и 40 ГБ всего.", size: 12, color: Theme.muted))
        }
        server.addArrangedSubview(SettingsLook.words("Зашифрованные вложения из личных чатов. Сервер не может их прочитать.", size: 12, color: Theme.muted))
        addGroup("Файлы на сервере", rows: [SettingsLook.inset(server, top: 16, side: 16, bottom: 16)])

        // «Кэш на этом устройстве».
        var cacheWords = "…"
        if let cacheBytes { cacheWords = DataViewController.words(Double(cacheBytes), storage: false) }
        let clean = SettingsButton(label: "Очистить кэш", kind: .secondary)
        clean.setBusy(clearing)
        clean.onPress = { [weak self] in self?.clearCache() }
        let device = UIStackView(arrangedSubviews: [
            line(symbol: "externaldrive", label: "Временные файлы", value: cacheWords),
            SettingsLook.words("Расшифрованные для просмотра вложения. Всё это можно скачать и расшифровать заново.", size: 12, color: Theme.muted),
            clean,
        ])
        device.axis = .vertical
        device.spacing = 12
        if !doneWords.isEmpty { device.addArrangedSubview(SettingsLook.words(doneWords, size: 12, color: Theme.muted)) }
        addGroup("Кэш на этом устройстве", rows: [SettingsLook.inset(device, top: 16, side: 16, bottom: 16)])
    }

    private func clearCache() {
        guard !clearing else { return }
        clearing = true
        doneWords = ""
        fill()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            DecryptedFiles.sweep()
            DispatchQueue.main.async {
                guard let self else { return }
                self.clearing = false
                self.doneWords = "Кэш очищен. Переписка, ключи шифрования и твои музыкальные файлы не затронуты."
                self.measure()
            }
        }
    }
}
