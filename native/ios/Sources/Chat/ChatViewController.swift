import UIKit

/// One chat: the messages, the header with the person's name, the field to write in.
final class ChatViewController: UIViewController, UITextFieldDelegate {
    private let name: String
    private let list = MsgListView()
    private let header = UIView()
    private let back = UIButton(type: .system)
    private let heading = UILabel()
    private let composer = UIVisualEffectView(effect: nil)
    private let field = UITextField()
    private let send = UIButton(type: .system)
    private var rows: [[String: Any]] = []
    /// What sends a message; nil while there is nothing to send with.
    var onSend: ((String) -> Void)?

    private let messenger: Messenger?
    private let chatId: String
    private let peerId: String

    /// With a `messenger`: the real chat. Without: the simulator's sample chat.
    init(name: String, messenger: Messenger? = nil, chatId: String = "", peerId: String = "") {
        self.name = name
        self.messenger = messenger
        self.chatId = chatId
        self.peerId = peerId
        super.init(nibName: nil, bundle: nil)
    }

    /// Reads the chat's newest page and shows it.
    private func load() {
        messenger?.messages(chatId: chatId, peerLastRead: 0) { [weak self] result in
            guard let self, case .success(let rows) = result else { return }
            self.rows = rows
            self.list.setRows(MsgRow.parse(rows))
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        list.setPalette(Theme.messages)
        view.addSubview(list)

        header.backgroundColor = Theme.bg.withAlphaComponent(0.92)
        view.addSubview(header)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        back.tintColor = Theme.text
        back.accessibilityLabel = "Назад"
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        header.addSubview(back)
        heading.text = name
        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        heading.textColor = Theme.text
        heading.textAlignment = .center
        header.addSubview(heading)

        composer.clipsToBounds = true
        view.addSubview(composer)
        field.attributedPlaceholder = NSAttributedString(string: "Сообщение", attributes: [.foregroundColor: Theme.muted])
        field.font = .systemFont(ofSize: 17)
        field.textColor = Theme.text
        field.tintColor = Theme.text
        field.keyboardAppearance = .dark
        field.returnKeyType = .send
        field.delegate = self
        composer.contentView.addSubview(field)
        send.setImage(UIImage(systemName: "arrow.up.circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 28, weight: .regular)), for: .normal)
        send.tintColor = Theme.text
        send.accessibilityLabel = "Отправить"
        send.addTarget(self, action: #selector(sendNow), for: .touchUpInside)
        composer.contentView.addSubview(send)

        if let messenger {
            onSend = { [weak self] text in
                guard let self else { return }
                // Shown at once as being sent; the list is read again when the server has taken it.
                self.rows.append(["key": "sending-\(self.rows.count)", "kind": 0, "mine": true, "text": text, "time": Messenger.clock.string(from: Date()), "ticks": 3, "tail": true])
                self.list.setRows(MsgRow.parse(self.rows))
                messenger.send(chatId: self.chatId, peerId: self.peerId, text: text) { [weak self] _ in self?.load() }
            }
            load()
        } else {
            #if targetEnvironment(simulator)
            rows = SimulatorDemo.messages()
            onSend = { [weak self] text in
                guard let self else { return }
                self.rows.append(["key": "local-\(self.rows.count)", "kind": 0, "mine": true, "text": text, "time": "09:41", "ticks": 1, "tail": true])
                self.list.setRows(MsgRow.parse(self.rows))
            }
            #endif
        }
        list.setRows(MsgRow.parse(rows))
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var keyboardTop: CGFloat?

    @objc private func keyboardMoved(_ note: Notification) {
        guard let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let top = view.convert(frame, from: nil).minY
        keyboardTop = top < view.bounds.height ? top : nil
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        UIView.animate(withDuration: duration, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) { self.place() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        place()
    }

    private func place() {
        let width = view.bounds.width, top = view.safeAreaInsets.top
        header.frame = CGRect(x: 0, y: 0, width: width, height: top + 48)
        back.frame = CGRect(x: 6, y: top + 2, width: 44, height: 44)
        heading.frame = CGRect(x: 56, y: top + 2, width: width - 112, height: 44)
        let composerHeight: CGFloat = 48
        let floor = keyboardTop.map { $0 - 8 } ?? (view.bounds.height - max(view.safeAreaInsets.bottom, 12))
        composer.frame = CGRect(x: 12, y: floor - composerHeight, width: width - 24, height: composerHeight)
        composer.layer.cornerRadius = composerHeight / 2
        composer.layer.cornerCurve = .continuous
        if composer.effect == nil { composer.effect = TabGlass.effect(clear: false, interactive: false, dark: true) }
        field.frame = CGRect(x: 18, y: 0, width: composer.bounds.width - 18 - 50, height: composerHeight)
        send.frame = CGRect(x: composer.bounds.width - 46, y: 2, width: 44, height: 44)
        list.frame = view.bounds
        list.setPad(top: Double(header.frame.maxY + 8), bottom: Double(view.bounds.height - composer.frame.minY + 8))
    }

    @objc private func goBack() { navigationController?.popViewController(animated: true) }

    @objc private func sendNow() {
        let text = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let onSend else { return }
        field.text = ""
        onSend(text)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        sendNow()
        return false
    }
}
