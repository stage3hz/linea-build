import UIKit

/// ChatsPlus: a hold on a chat row (ChatListScreen.tsx `ChatPeek` in ContextMenu.tsx): the screen blurs and dims,
/// a card with the chat itself — the person's name and @name over its last 14 messages — comes up from the finger
/// over a glass menu with what can be done with the chat. A touch beside them (or a pull down) puts them away.
/// The messages are the ones this device has already decrypted; nothing is asked of the server for the card.
final class ChatPeekMenu: UIViewController {
    struct Line {
        let text: String
        let mine: Bool
    }

    private let anchorY: CGFloat
    private let name: String
    private let username: String
    private let face: FolderChat
    private let choices: [ChoiceSheet.Choice]
    private var lines: [Line]

    private let backdrop = PartBlurView() // ContextMenu.tsx `BLUR = 30`
    private let dim = UIButton(type: .custom)
    private let card = UIView()
    private let avatar = SmallAvatarView()
    private let nameLabel = UILabel()
    private let userLabel = UILabel()
    private let rule = UIView()
    private let messages = UIView()
    private var messageLabels: [UILabel] = []
    private let emptyLabel = UILabel()
    private let panel = UIVisualEffectView(effect: nil)
    private var rows: [PeekMenuRow] = []
    private var shown = false

    init(anchorY: CGFloat, name: String, username: String, face: FolderChat, lines: [Line], choices: [ChoiceSheet.Choice]) {
        self.anchorY = anchorY
        self.name = name
        self.username = username
        self.face = face
        self.lines = Array(lines.suffix(14))
        self.choices = choices
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    /// The messages arrived after the card was opened (they are read from the private storage in the background).
    func setLines(_ next: [Line]) {
        lines = Array(next.suffix(14))
        guard isViewLoaded else { return }
        buildLines()
        view.setNeedsLayout()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.addSubview(backdrop)
        dim.backgroundColor = Theme.dark ? UIColor(white: 0, alpha: 0.34) : UIColor(red: 20 / 255, green: 30 / 255, blue: 60 / 255, alpha: 0.14)
        dim.accessibilityLabel = "Закрыть меню"
        dim.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        view.addSubview(dim)

        card.backgroundColor = Theme.bg
        card.layer.cornerRadius = 24
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = 1 / max(1, view.traitCollection.displayScale)
        card.layer.borderColor = Theme.veil(0.12).cgColor
        card.clipsToBounds = true
        card.isUserInteractionEnabled = false
        view.addSubview(card)
        // ChatListScreen.tsx ChatPeek: the reference's `Avatar` at 36 — the photo, or the lit ball with the initials.
        avatar.show(face)
        card.addSubview(avatar)
        nameLabel.text = name
        nameLabel.font = Theme.font(15, .bold)
        nameLabel.textColor = Theme.text
        card.addSubview(nameLabel)
        userLabel.text = username.isEmpty ? "" : "@" + username
        userLabel.font = Theme.font(12)
        userLabel.textColor = Theme.muted
        card.addSubview(userLabel)
        rule.backgroundColor = Theme.veil(0.12)
        card.addSubview(rule)
        card.addSubview(messages)
        emptyLabel.text = "Сообщений пока нет"
        emptyLabel.font = Theme.font(15)
        emptyLabel.textColor = Theme.muted
        emptyLabel.textAlignment = .center
        messages.addSubview(emptyLabel)
        buildLines()

        panel.effect = chatGlass()
        panel.clipsToBounds = true
        panel.layer.cornerRadius = 26
        panel.layer.cornerCurve = .continuous
        view.addSubview(panel)
        for choice in choices {
            let row = PeekMenuRow(symbol: choice.symbol, label: choice.label, danger: choice.danger)
            row.addTarget(self, action: #selector(rowTapped(_:)), for: .touchUpInside)
            rows.append(row)
            panel.contentView.addSubview(row)
        }
        let pull = UIPanGestureRecognizer(target: self, action: #selector(pulled(_:)))
        view.addGestureRecognizer(pull)
        view.accessibilityViewIsModal = true
    }

    private func buildLines() {
        for label in messageLabels { label.removeFromSuperview() }
        messageLabels = lines.map { (line: Line) -> UILabel in
            let label = UILabel()
            label.text = line.text
            label.font = Theme.font(14)
            label.textColor = Theme.text
            label.numberOfLines = 4
            // The owner's open look: own lines at the right edge, the other side's at the left, no bubbles.
            label.textAlignment = line.mine ? .right : .left
            messages.addSubview(label)
            return label
        }
        emptyLabel.isHidden = !lines.isEmpty
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let safe = view.safeAreaInsets
        backdrop.frame = bounds
        dim.frame = bounds
        let column = min(340, bounds.width - 24)
        let peekHeight = min(440, (bounds.height * 0.5).rounded())
        let menuWidth = min(250, column)
        let menuHeight = CGFloat(rows.count) * 44
        let size = peekHeight + 8 + menuHeight
        let topLimit = safe.top + 8, bottomLimit = bounds.height - safe.bottom - 8
        let top = max(topLimit, min(anchorY - 70, bottomLimit - size))
        let left = (bounds.width - column) / 2
        let wasTransform = card.transform
        card.transform = .identity
        card.frame = CGRect(x: left, y: top, width: column, height: peekHeight)
        card.transform = wasTransform
        avatar.frame = CGRect(x: 14, y: 10, width: 36, height: 36)
        nameLabel.frame = CGRect(x: 60, y: 10, width: column - 74, height: 19)
        userLabel.frame = CGRect(x: 60, y: 30, width: column - 74, height: 15)
        rule.frame = CGRect(x: 0, y: 56, width: column, height: 1 / max(1, view.traitCollection.displayScale))
        messages.frame = CGRect(x: 10, y: 57, width: column - 20, height: peekHeight - 57 - 10)
        // From the bottom up, as in a chat: the newest at the bottom; what does not fit goes off the top.
        var y = messages.bounds.height
        let widest = (messages.bounds.width * 0.82).rounded(.down)
        for (index, label) in messageLabels.enumerated().reversed() {
            let fit = label.sizeThatFits(CGSize(width: widest, height: 200))
            let height = ceil(fit.height) + 12
            y -= height
            let mine = lines[index].mine
            label.frame = CGRect(x: mine ? messages.bounds.width - widest : 0, y: y + 6, width: widest, height: ceil(fit.height))
            label.isHidden = y < -height
            y -= 4
        }
        emptyLabel.frame = CGRect(x: 0, y: messages.bounds.height - 40, width: messages.bounds.width, height: 20)
        let menuTransform = panel.transform
        panel.transform = .identity
        panel.frame = CGRect(x: (bounds.width - menuWidth) / 2, y: top + peekHeight + 8, width: menuWidth, height: menuHeight)
        panel.transform = menuTransform
        for (index, row) in rows.enumerated() {
            row.frame = CGRect(x: 0, y: CGFloat(index) * 44, width: menuWidth, height: 44)
        }
        if !shown { prepareEntrance(top: top) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !shown else { return }
        shown = true
        let motion = !UIAccessibility.isReduceMotionEnabled
        UIView.animate(withDuration: motion ? 0.42 : 0.01, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0, options: [.allowUserInteraction], animations: {
            self.card.transform = .identity
            self.card.alpha = 1
            self.panel.transform = .identity
            self.panel.alpha = 1
        })
    }

    /// The card starts at the finger (scaled to .96), the menu at a third of its size from its top.
    private func prepareEntrance(top: CGFloat) {
        let lift = anchorY - 20 - top
        card.transform = CGAffineTransform(translationX: 0, y: lift).scaledBy(x: 0.96, y: 0.96)
        card.alpha = 0
        let size = panel.bounds.size
        let s: CGFloat = 0.35
        panel.transform = CGAffineTransform(translationX: 0, y: -size.height * (1 - s) / 2).scaledBy(x: s, y: s)
        panel.alpha = 0
    }

    @objc private func rowTapped(_ sender: PeekMenuRow) {
        guard let index = rows.firstIndex(where: { $0 === sender }), index < choices.count else { return }
        let run = choices[index].run
        dismiss(animated: true) { run() }
    }

    @objc private func closeNow() { dismiss(animated: true) }

    /// Pulled down, the card and the menu follow the finger and let go, as a touch beside them would.
    @objc private func pulled(_ pan: UIPanGestureRecognizer) {
        let down = max(0, pan.translation(in: view).y)
        switch pan.state {
        case .changed:
            card.transform = CGAffineTransform(translationX: 0, y: down)
            panel.transform = CGAffineTransform(translationX: 0, y: down)
        case .ended, .cancelled, .failed:
            if pan.state == .ended && (down > 90 || pan.velocity(in: view).y > 900) {
                dismiss(animated: true)
            } else {
                UIView.animate(withDuration: 0.2) {
                    self.card.transform = .identity
                    self.panel.transform = .identity
                }
            }
        default:
            break
        }
    }
}

/// One line of the menu (ContextMenu.tsx `MenuItem`): the icon (19) and the words (15.5), 44 pt high.
final class PeekMenuRow: UIControl {
    private let mark = UIImageView()
    private let words = UILabel()

    init(symbol: String, label: String, danger: Bool) {
        super.init(frame: .zero)
        let ink = danger ? Theme.danger : Theme.text
        mark.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
        mark.tintColor = ink
        mark.contentMode = .center
        addSubview(mark)
        words.text = label
        words.font = Theme.font(15.5)
        words.textColor = ink
        words.adjustsFontSizeToFitWidth = true
        words.minimumScaleFactor = 0.75
        addSubview(words)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = label
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? Theme.veil(0.08) : .clear }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        mark.frame = CGRect(x: 16, y: 0, width: 22, height: bounds.height)
        words.frame = CGRect(x: 16 + 22 + 13, y: 0, width: max(0, bounds.width - 51 - 16), height: bounds.height)
    }
}

extension ChatListPlus {
    /// The lines of the card: the newest messages this device keeps decrypted for the chat (the actions on messages,
    /// the hidden ones and the empty ones left out), oldest first. Main queue in, main queue out.
    static func peekLines(messenger: Messenger, chatId: String, done: @escaping ([ChatPeekMenu.Line]) -> Void) {
        let me = messenger.userId
        let hidden = Set(ChatLocal.of(messenger).hiddenKeys)
        messenger.crypto.run({ (crypto: CryptoService) -> [ChatPeekMenu.Line] in
            guard case .success(let value) = crypto.callNow("history", [chatId, 60]), let kept = value as? [[String: Any]] else { return [] }
            var lines: [ChatPeekMenu.Line] = []
            for item in kept {
                if ChatHistory.action(item) != nil || hidden.contains(ChatHistory.key(item)) { continue }
                var text = (item["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty, let attachment = item["attachment"] as? [String: Any] { text = ChatRowLooks.attachmentLine(attachment).text }
                if text.isEmpty { text = "Сообщение" }
                lines.append(ChatPeekMenu.Line(text: text, mine: item["senderId"] as? String == me))
            }
            return Array(lines.suffix(14))
        }, done: done)
    }
}
