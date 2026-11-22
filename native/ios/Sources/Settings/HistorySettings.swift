import AVFoundation
import UIKit

/// Безопасность › «Переписки на новом устройстве» (docs/HISTORY-TRANSFER.md): how a copy from another own device goes,
/// the encrypted backup («Ключ резервной копии», shown behind the app lock) and «Восстановить переписки».
/// (The previous app: `mobile/src/HistorySection.tsx`.) Everything that touches keys is the core's (`history.*`).
final class HistoryViewController: SettingsPage {
    private let messenger: Messenger
    private var status: [String: Any]?
    private var failure = ""
    private var notice = ""
    private var busy = false

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Переписки на новом устройстве")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        NotificationCenter.default.addObserver(self, selector: #selector(transferChanged), name: HistoryTransfer.changed, object: nil)
        load()
    }

    @objc private func transferChanged() { fill() }

    private func load() {
        messenger.crypto.call("history.status") { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self else { return }
            switch result {
            case .success(let value): self.status = value as? [String: Any]; self.failure = ""
            case .failure(let error): self.failure = error.message.isEmpty ? "Не удалось узнать состояние резервной копии." : error.message
            }
            self.fill()
        }
    }

    private static func time(_ text: String?) -> String {
        guard let text, let date = HistoryTransfer.date(text) else { return "" }
        let format = DateFormatter()
        format.locale = Locale(identifier: "ru_RU")
        format.dateFormat = "HH:mm"
        return format.string(from: date)
    }

    private func card(_ parts: [UIView]) -> UIView {
        let box = UIStackView(arrangedSubviews: parts)
        box.axis = .vertical
        box.spacing = 13
        return SettingsLook.inset(box, top: 16, side: 16, bottom: 16)
    }

    private func fill() {
        clear()
        let transfer = HistoryTransfer.shared
        addGroup(rows: [card([
            SettingsLook.words("Сообщения зашифрованы только для устройств, которые были в аккаунте, когда их отправили. Новое устройство получает старые переписки двумя способами — оба со сквозным шифрованием, сервер их не читает.", size: 13, color: Theme.muted),
        ])])
        if transfer.receiving { add(SettingsNotice("Переносим переписки с другого устройства…"), gap: 14) }
        else if let until = transfer.waitingUntil {
            add(SettingsNotice("Переписки придут с другого твоего устройства после \(HistoryViewController.time(until)) (через 10 минут после входа). Оно должно быть в сети с открытым приложением."), gap: 14)
        }
        if transfer.imported > 0 { add(SettingsNotice("Перенесено сообщений: \(transfer.imported)."), gap: 14) }
        addGroup("С другого своего устройства", rows: [card([
            SettingsLook.words("При новом входе твои устройства покажут «Новый вход». Если в течение 10 минут его не завершить, любое из них в сети передаст переписки новому — зашифрованными только для него.", size: 13, color: Theme.muted),
        ])])
        if !failure.isEmpty { add(SettingsNotice(failure, error: true, onRetry: { [weak self] in self?.load() }), gap: 14) }
        if !notice.isEmpty { add(SettingsNotice(notice), gap: 14) }

        let warningBox = UIStackView(arrangedSubviews: [
            SettingsLook.words("Ключ = доступ к копии", size: 12, color: Theme.text, weight: .bold),
            SettingsLook.words("Кто знает ключ резервной копии и может войти в твой аккаунт, тот может прочитать её. Храни ключ так же бережно, как пароль: не отправляй его в чатах и не фотографируй на чужие устройства.", size: 12, color: Theme.muted),
        ])
        warningBox.axis = .vertical
        warningBox.spacing = 5
        let warning = SettingsLook.inset(warningBox, top: 13, side: 13, bottom: 13)
        warning.backgroundColor = SettingsLook.chip
        warning.layer.cornerRadius = 14
        warning.layer.cornerCurve = .continuous
        var parts: [UIView] = [
            SettingsLook.words("Зашифрованная копия переписок на сервере. Ключ создаётся на устройстве и на сервер не уходит; твои устройства передают его друг другу в зашифрованном виде.", size: 13, color: Theme.muted),
            warning,
        ]
        let enabled = status?["enabled"] as? Bool ?? false
        let held = status?["held"] as? Bool ?? false
        if status == nil {
            parts.append(SettingsLook.words("Загружаем…", size: 13, color: Theme.muted))
        } else if !enabled {
            let turnOn = SettingsButton(label: "Включить резервную копию", kind: .secondary, icon: "cloud-upload-outline")
            turnOn.onPress = { [weak self] in self?.enable() }
            parts.append(turnOn)
        } else if held {
            let key = SettingsButton(label: "Ключ резервной копии", kind: .secondary, icon: "key-outline")
            key.onPress = { [weak self] in self?.showKey() }
            parts.append(key)
            let off = SettingsButton(label: "Выключить резервную копию", kind: .danger, icon: "trash-outline")
            off.onPress = { [weak self] in self?.confirmOff() }
            parts.append(off)
        } else if status?["canRestore"] as? Bool ?? false {
            let restore = SettingsButton(label: "Восстановить переписки", icon: "cloud-download-outline")
            restore.onPress = { [weak self] in
                guard let self else { return }
                self.open(RestoreHistoryViewController(messenger: self.messenger))
            }
            parts.append(restore)
            parts.append(SettingsLook.words("Понадобится ключ резервной копии: его можно открыть на другом твоём устройстве в Безопасность → «Переписки на новом устройстве» → «Ключ резервной копии».", size: 12, color: Theme.muted))
        } else {
            parts.append(SettingsLook.words("Восстановить переписки можно после \(HistoryViewController.time(status?["restoreAt"] as? String)) — через 10 минут после входа.", size: 13, color: Theme.muted))
        }
        addGroup("Резервная копия", rows: [card(parts)])
    }

    private func enable() {
        guard !busy else { return }
        busy = true
        messenger.crypto.call("history.enable") { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let value):
                if let secret = value as? String { self.open(BackupKeyViewController(secret: secret)) }
                HistoryTransfer.shared.backup()
            case .failure(let error): self.failure = error.message
            }
            self.load()
        }
    }

    private func confirmOff() {
        let sheet = UIAlertController(title: "Выключить резервную копию?", message: "Копия и её ключ будут удалены с сервера. Переписки на твоих устройствах останутся. Если включить копию снова, будет создан новый ключ.", preferredStyle: .alert)
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel))
        sheet.addAction(UIAlertAction(title: "Выключить", style: .destructive) { [weak self] (_: UIAlertAction) -> Void in
            guard let self else { return }
            self.messenger.crypto.call("history.disable") { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
                guard let self else { return }
                if case .failure(let error) = result { self.failure = error.message } else { self.notice = "Резервная копия удалена с сервера." }
                self.load()
            }
        })
        present(sheet, animated: true)
    }

    /// The key is shown only after the app lock (Face ID / Touch ID or the code) when the lock is on.
    private func showKey() {
        let reveal = { [weak self] in
            guard let self else { return }
            self.messenger.crypto.call("history.secret") { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
                guard let self else { return }
                if case .success(let value) = result, let secret = value as? String { self.open(BackupKeyViewController(secret: secret)) }
                else { self.failure = "Ключ резервной копии недоступен на этом устройстве."; self.fill() }
            }
        }
        let settings = LockStore.shared.current
        guard settings.record != nil else { reveal(); return }
        let askCode = { [weak self] in
            guard let self else { return }
            let ask = UIAlertController(title: "Код-пароль", message: "Чтобы показать ключ резервной копии", preferredStyle: .alert)
            ask.addTextField { (field: UITextField) -> Void in field.isSecureTextEntry = true; field.keyboardType = .numberPad }
            ask.addAction(UIAlertAction(title: "Отмена", style: .cancel))
            ask.addAction(UIAlertAction(title: "Показать", style: .default) { [weak self, weak ask] (_: UIAlertAction) -> Void in
                let code = ask?.textFields?.first?.text ?? ""
                LockStore.shared.check(code) { (right: Bool) -> Void in
                    if right { reveal() } else { self?.failure = "Неверный код."; self?.fill() }
                }
            })
            self.present(ask, animated: true)
        }
        if settings.biometrics {
            LockBiometrics.authenticate("Показать ключ резервной копии") { (success: Bool) -> Void in if success { reveal() } else { askCode() } }
        } else { askCode() }
    }
}

/// The backup key as text in groups of 4 and as a QR code (both made by the core: `historyFormatSecret`, `historyQr`).
final class BackupKeyViewController: SettingsPage {
    private let secret: String

    init(secret: String) {
        self.secret = secret
        super.init(name: "Ключ резервной копии")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        let words = Core.view("historyFormatSecret", [secret]) as? String ?? secret
        let label = UILabel()
        label.text = words
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .monospacedSystemFont(ofSize: 21, weight: .bold)
        label.textColor = Theme.text
        label.accessibilityLabel = "Ключ резервной копии: \(words)"
        add(label, gap: 8)
        let qrText = (Core.view("historySecretQr", [secret]) as? String ?? "").uppercased()
        if let rows = Core.view("historyQr", [qrText]) as? [String], let image = BackupKeyViewController.image(rows, side: 240) {
            let view = UIImageView(image: image)
            view.contentMode = .center
            view.accessibilityLabel = "QR-код ключа резервной копии"
            add(view, gap: 18)
        }
        add(SettingsLook.foot("На новом устройстве открой Безопасность → «Переписки на новом устройстве» → «Восстановить переписки» и введи ключ или наведи камеру на этот код. Кто знает ключ и может войти в аккаунт, тот может прочитать копию."), gap: 18)
    }

    /// Black squares on white with a quiet border of 4 modules, sharp at any scale.
    static func image(_ rows: [String], side: CGFloat) -> UIImage? {
        let count = rows.count + 8
        guard count > 8 else { return nil }
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        return renderer.image { (context: UIGraphicsImageRendererContext) -> Void in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
            UIColor.black.setFill()
            let cell = side / CGFloat(count)
            for (r, row) in rows.enumerated() {
                for (c, dark) in row.enumerated() where dark == "1" {
                    context.fill(CGRect(x: CGFloat(c + 4) * cell, y: CGFloat(r + 4) * cell, width: cell, height: cell))
                }
            }
        }
    }
}

/// «Восстановить переписки»: the key typed or read from the other phone's QR code (the camera only after a tap).
final class RestoreHistoryViewController: SettingsPage {
    private let messenger: Messenger
    private let field = SettingsField(caption: "Ключ", placeholder: "XXXX XXXX XXXX …")
    private let noticeBox = UIStackView()
    private let restoreButton = SettingsButton(label: "Восстановить")
    private var busy = false

    init(messenger: Messenger) {
        self.messenger = messenger
        super.init(name: "Восстановить переписки")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        add(SettingsLook.foot("Введи ключ резервной копии с другого твоего устройства (9 групп по 4 символа) или отсканируй его QR-код. Попыток — 5 в час."), gap: 4)
        field.input.autocapitalizationType = .allCharacters
        field.onReturn = { [weak self] in self?.restore() }
        add(field, gap: 16)
        noticeBox.axis = .vertical
        add(noticeBox, gap: 14)
        restoreButton.onPress = { [weak self] in self?.restore() }
        add(restoreButton, gap: 14)
        let scan = SettingsButton(label: "Сканировать QR-код", kind: .secondary, icon: "qr-code-outline")
        scan.onPress = { [weak self] in self?.scan() }
        add(scan, gap: 10)
    }

    private func show(_ words: String, error: Bool) {
        for view in noticeBox.arrangedSubviews { view.removeFromSuperview() }
        noticeBox.addArrangedSubview(SettingsNotice(words, error: error))
    }

    private func scan() {
        let go = { [weak self] in
            guard let self else { return }
            let scanner = QRScanViewController { [weak self] (text: String) -> Void in
                self?.field.input.text = text
                self?.restore()
            }
            self.present(scanner, animated: true)
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: go()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { (granted: Bool) -> Void in
                DispatchQueue.main.async { [weak self] in if granted { go() } else { self?.show("Нет доступа к камере. Введи ключ вручную или разреши камеру в настройках.", error: true) } }
            }
        default: show("Нет доступа к камере. Введи ключ вручную или разреши камеру в настройках.", error: true)
        }
    }

    private func restore() {
        let typed = field.input.text ?? ""
        guard !busy, !typed.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        busy = true
        restoreButton.setBusy(true)
        show("Восстанавливаем переписки…", error: false)
        messenger.crypto.call("history.restore", [typed]) { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self else { return }
            self.busy = false
            self.restoreButton.setBusy(false)
            switch result {
            case .success(let value):
                let count = (value as? NSNumber)?.intValue ?? 0
                self.field.input.text = ""
                self.show("Переписки восстановлены. Сообщений: \(count).", error: false)
                NotificationCenter.default.post(name: Messenger.changed, object: nil)
            case .failure(let error):
                self.show(error.message.isEmpty ? "Не удалось восстановить переписки." : error.message, error: true)
            }
        }
    }
}

/// The back camera reading one QR code; closes itself with the text.
final class QRScanViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let found: (String) -> Void
    private var done = false

    init(found: @escaping (String) -> Void) {
        self.found = found
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        let close = UIButton(type: .system)
        close.setTitle("Отмена", for: .normal)
        close.tintColor = .white
        close.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        close.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close)
        NSLayoutConstraint.activate([
            close.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            close.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
            close.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.compactMap { $0 as? AVCaptureVideoPreviewLayer }.forEach { $0.frame = view.bounds }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.stopRunning() }
    }

    @objc private func closePressed() { dismiss(animated: true) }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !done, let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject, let text = code.stringValue else { return }
        done = true
        dismiss(animated: true) { [found] in found(text) }
    }
}
