import UIKit

// Gifts (the reference's ProfilePosts.tsx: the «Подарки» tab and `GiftSheet`): sixteen kinds a friend sends with a
// short note; they stand on the profile three in a row; the owner removes one by holding it. Seen by friends (the
// server decides, as for posts).

/// The «Подарки» tab's content: the send button on someone else's profile, the grid, or the empty words. It loads
/// the gifts itself and tells its owner how tall it is (`onHeight`) and how many there are (`onCount`).
final class GiftsPanel: UIView {
    private weak var host: UIViewController?
    private var messenger: Messenger?
    private var userId = ""
    private var own = false
    private(set) var gifts: [ProfileGift] = []
    private var loaded = false
    private var problem = ""
    var onHeight: (() -> Void)?
    var onCount: ((Int) -> Void)?

    private let sendButton = UIButton(type: .system)
    private let hint = UILabel()
    private let problemLabel = UILabel()
    private var tiles: [UIView] = []
    private let emptyEmoji = UILabel()
    private let emptyHeading = UILabel()
    private let emptyHint = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        var look = UIButton.Configuration.filled()
        look.baseBackgroundColor = Theme.surface2
        look.baseForegroundColor = Theme.accent
        look.cornerStyle = .capsule
        look.attributedTitle = AttributedString(NSAttributedString(string: "🎁  Отправить подарок", attributes: [.font: UIFont.systemFont(ofSize: 15, weight: .semibold)]))
        look.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
        sendButton.configuration = look
        sendButton.addTarget(self, action: #selector(sendPressed), for: .touchUpInside)
        addSubview(sendButton)
        hint.text = "Удержи подарок, чтобы удалить его."
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = Theme.muted
        hint.textAlignment = .center
        addSubview(hint)
        problemLabel.font = .systemFont(ofSize: 14)
        problemLabel.textColor = Theme.danger
        problemLabel.textAlignment = .center
        problemLabel.numberOfLines = 0
        addSubview(problemLabel)
        emptyEmoji.text = "🎁"
        emptyEmoji.font = .systemFont(ofSize: 54)
        emptyEmoji.textAlignment = .center
        addSubview(emptyEmoji)
        emptyHeading.text = "Подарков пока нет…"
        emptyHeading.font = Theme.title(Theme.TypeSize.emptyTitle) // Fonts
        emptyHeading.textColor = Theme.text
        emptyHeading.textAlignment = .center
        addSubview(emptyHeading)
        emptyHint.font = .systemFont(ofSize: 14)
        emptyHint.textColor = Theme.muted
        emptyHint.textAlignment = .center
        emptyHint.numberOfLines = 0
        addSubview(emptyHint)
        spinner.color = Theme.muted
        spinner.hidesWhenStopped = true
        addSubview(spinner)
    }

    required init?(coder: NSCoder) { return nil }

    func attach(host: UIViewController, messenger: Messenger?, userId: String, own: Bool) {
        self.host = host
        self.messenger = messenger
        self.userId = userId
        self.own = own
        emptyHint.text = own ? "Здесь появятся подарки от друзей." : "Подари первым — подарок появится в профиле."
        reload()
    }

    func reload() {
        guard let messenger else {
            #if targetEnvironment(simulator)
            gifts = ProfileSamples.gifts(own: own)
            loaded = true
            rebuild()
            #endif
            return
        }
        let asked = userId
        messenger.profileGifts(asked) { [weak self] (result: Result<(visible: Bool, gifts: [ProfileGift]), ServerError>) -> Void in
            guard let self, self.userId == asked else { return }
            self.loaded = true
            if case .success(let found) = result { self.gifts = found.gifts }
            self.rebuild()
        }
    }

    private func rebuild() {
        for tile in tiles { tile.removeFromSuperview() }
        tiles = []
        for (index, item) in gifts.enumerated() {
            let tile = GiftTileView(gift: GiftCatalog.gift(item.gift), title: item.sender?.displayName ?? GiftCatalog.gift(item.gift).label, note: item.message, emojiSize: 42)
            tile.tag = index
            tile.accessibilityLabel = GiftCatalog.gift(item.gift).label + (item.sender.map { " от " + $0.displayName } ?? "")
            if own {
                let hold = UILongPressGestureRecognizer(target: self, action: #selector(tileHeld(_:)))
                hold.minimumPressDuration = 0.35
                tile.addGestureRecognizer(hold)
            }
            addSubview(tile)
            tiles.append(tile)
        }
        problemLabel.text = problem
        onCount?(gifts.count)
        setNeedsLayout()
        layoutIfNeeded()
        onHeight?()
    }

    /// How tall the panel is at `width`.
    private(set) var contentHeight: CGFloat = 120

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        guard width > 0 else { return }
        var y: CGFloat = 0
        sendButton.isHidden = own || userId.isEmpty
        hint.isHidden = !(own && !gifts.isEmpty)
        problemLabel.isHidden = problem.isEmpty
        let empty = loaded && gifts.isEmpty
        emptyEmoji.isHidden = !empty
        emptyHeading.isHidden = !empty
        emptyHint.isHidden = !empty
        if loaded { spinner.stopAnimating() } else { spinner.startAnimating() }
        if !sendButton.isHidden {
            let wanted = min(width, sendButton.sizeThatFits(CGSize(width: width, height: 38)).width + 8)
            sendButton.frame = CGRect(x: (width - wanted) / 2, y: y, width: wanted, height: 38)
            y += 38 + 12
        }
        if !hint.isHidden {
            hint.frame = CGRect(x: 0, y: y, width: width, height: 16)
            y += 16 + 12
        }
        if !problem.isEmpty {
            let size = problemLabel.sizeThatFits(CGSize(width: width - 24, height: 200))
            problemLabel.frame = CGRect(x: 12, y: y, width: width - 24, height: size.height)
            y += size.height + 12
        }
        if !loaded {
            spinner.center = CGPoint(x: width / 2, y: y + 30)
            y += 60
        } else if empty {
            y += 18
            emptyEmoji.frame = CGRect(x: 0, y: y, width: width, height: 64)
            y += 64 + 8
            emptyHeading.frame = CGRect(x: 0, y: y, width: width, height: 26)
            y += 26 + 8
            let size = emptyHint.sizeThatFits(CGSize(width: width - 24, height: 200))
            emptyHint.frame = CGRect(x: 12, y: y, width: width - 24, height: size.height)
            y += size.height + 18
        } else {
            let tileWidth = ((width - 16) / 3).rounded(.down)
            var rowHeight: CGFloat = 0
            var rowTop = y
            for (index, tile) in tiles.enumerated() {
                let column = index % 3
                if column == 0 && index > 0 {
                    rowTop += rowHeight + 8
                    rowHeight = 0
                }
                let height = tile.sizeThatFits(CGSize(width: tileWidth, height: 400)).height
                tile.frame = CGRect(x: CGFloat(column) * (tileWidth + 8), y: rowTop, width: tileWidth, height: height)
                rowHeight = max(rowHeight, height)
            }
            y = rowTop + rowHeight
        }
        contentHeight = y
    }

    @objc private func sendPressed() {
        guard let host else { return }
        let sheet = GiftSheetViewController(messenger: messenger, userId: userId)
        sheet.onSent = { [weak self] in self?.reload() }
        host.present(sheet, animated: true, completion: nil)
    }

    @objc private func tileHeld(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, own, let tile = recognizer.view, tile.tag >= 0, tile.tag < gifts.count, let host else { return }
        let item = gifts[tile.tag]
        let sheet = UIAlertController(title: "Подарок", message: "Подарок удалится из профиля навсегда, вернуть его будет нельзя.", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Удалить подарок", style: .destructive, handler: { [weak self] (_: UIAlertAction) -> Void in self?.remove(item) }))
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        sheet.popoverPresentationController?.sourceView = tile
        host.present(sheet, animated: true, completion: nil)
    }

    private func remove(_ item: ProfileGift) {
        guard let messenger else {
            gifts.removeAll { $0.id == item.id }
            rebuild()
            return
        }
        problem = ""
        messenger.removeGift(item.id) { [weak self] (error: ServerError?) -> Void in
            guard let self else { return }
            if let error {
                self.problem = error.words.isEmpty ? "Не удалось убрать подарок." : error.words
                self.rebuild()
            } else {
                self.reload()
            }
        }
    }
}

/// One gift: its two colours, the emoji, who sent it (or its name) and the note.
final class GiftTileView: UIView {
    private let gradient = CAGradientLayer()
    private let emoji = UILabel()
    private let title = UILabel()
    private let note = UILabel()
    private let emojiSize: CGFloat

    init(gift: GiftCatalog.Gift, title words: String, note message: String, emojiSize: CGFloat) {
        self.emojiSize = emojiSize
        super.init(frame: .zero)
        clipsToBounds = true
        layer.cornerRadius = 16
        layer.cornerCurve = .continuous
        gradient.colors = [lookColor(gift.colors.0).cgColor, lookColor(gift.colors.1).cgColor]
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        layer.addSublayer(gradient)
        emoji.text = gift.emoji
        emoji.font = .systemFont(ofSize: emojiSize)
        emoji.textAlignment = .center
        addSubview(emoji)
        title.text = words
        title.font = .systemFont(ofSize: emojiSize > 34 ? 12 : 10, weight: .bold)
        title.textColor = .white
        title.textAlignment = .center
        title.adjustsFontSizeToFitWidth = true
        title.minimumScaleFactor = 0.75
        addSubview(title)
        note.text = message
        note.font = .systemFont(ofSize: 11)
        note.textColor = UIColor(white: 1, alpha: 0.85)
        note.textAlignment = .center
        note.numberOfLines = 2
        note.isHidden = message.isEmpty
        addSubview(note)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    private var big: Bool { return emojiSize > 34 }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let pad: CGFloat = big ? 14 : 8, gap: CGFloat = big ? 6 : 2
        var height = pad + emojiSize * 1.2 + gap + 15
        if !note.isHidden { height += gap + note.sizeThatFits(CGSize(width: size.width - 12, height: 40)).height }
        return CGSize(width: size.width, height: ceil(height + pad))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        gradient.frame = bounds
        let pad: CGFloat = big ? 14 : 8, gap: CGFloat = big ? 6 : 2
        emoji.frame = CGRect(x: 0, y: pad, width: bounds.width, height: emojiSize * 1.2)
        title.frame = CGRect(x: 6, y: emoji.frame.maxY + gap, width: bounds.width - 12, height: 15)
        let noteHeight = note.sizeThatFits(CGSize(width: bounds.width - 12, height: 40)).height
        note.frame = CGRect(x: 6, y: title.frame.maxY + gap, width: bounds.width - 12, height: noteHeight)
    }
}

/// Choose a gift for a friend, add a short note, send (the reference's `GiftSheet`).
final class GiftSheetViewController: UIViewController, UITextFieldDelegate {
    private let messenger: Messenger?
    private let userId: String
    var onSent: (() -> Void)?
    private var picked = "bear"
    private var busy = false
    private var tiles: [UIControl] = []
    private let noteField = UITextField()
    private let problem = UILabel()
    private let sendButton = UIButton(type: .system)

    init(messenger: Messenger?, userId: String) {
        self.messenger = messenger
        self.userId = userId
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 28
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = Theme.dark ? .dark : .light
        view.backgroundColor = Theme.page(UIColor(hex: 0x141516))
        let heading = UILabel()
        heading.attributedText = Theme.titleWords("Подарок", size: Theme.TypeSize.sheetTitle, color: Theme.text)
        let grid = UIView()
        let columns = 4
        let side: CGFloat = 70, gap: CGFloat = 8
        for (index, gift) in GiftCatalog.all.enumerated() {
            let holder = UIControl()
            holder.tag = index
            holder.layer.cornerRadius = 16
            holder.layer.cornerCurve = .continuous
            holder.layer.borderWidth = 2
            holder.accessibilityLabel = gift.label
            holder.isAccessibilityElement = true
            let tile = GiftTileView(gift: gift, title: gift.label, note: "", emojiSize: 30)
            tile.isUserInteractionEnabled = false
            tile.isAccessibilityElement = false
            let tall = tile.sizeThatFits(CGSize(width: side - 4, height: 200)).height
            tile.frame = CGRect(x: 2, y: 2, width: side - 4, height: tall)
            holder.frame = CGRect(x: CGFloat(index % columns) * (side + gap), y: CGFloat(index / columns) * (tall + 4 + gap), width: side, height: tall + 4)
            holder.addSubview(tile)
            holder.addTarget(self, action: #selector(pick(_:)), for: .touchUpInside)
            grid.addSubview(holder)
            tiles.append(holder)
        }
        let gridWidth = CGFloat(columns) * side + CGFloat(columns - 1) * gap
        let gridHeight = tiles.last?.frame.maxY ?? 0
        grid.translatesAutoresizingMaskIntoConstraints = false
        let gridHolder = UIView()
        gridHolder.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: gridHolder.topAnchor),
            grid.bottomAnchor.constraint(equalTo: gridHolder.bottomAnchor),
            grid.centerXAnchor.constraint(equalTo: gridHolder.centerXAnchor),
            grid.widthAnchor.constraint(equalToConstant: gridWidth),
            grid.heightAnchor.constraint(equalToConstant: gridHeight),
        ])
        let caption = UILabel()
        caption.text = "Подпись"
        caption.font = .systemFont(ofSize: 13, weight: .medium)
        caption.textColor = Theme.muted
        noteField.placeholder = "Необязательно"
        noteField.font = .systemFont(ofSize: 16)
        noteField.textColor = Theme.text
        noteField.backgroundColor = Theme.surface2
        noteField.layer.cornerRadius = 14
        noteField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        noteField.leftViewMode = .always
        noteField.delegate = self
        noteField.returnKeyType = .done
        noteField.heightAnchor.constraint(equalToConstant: 48).isActive = true
        problem.font = .systemFont(ofSize: 13)
        problem.textColor = Theme.danger
        problem.numberOfLines = 0
        var look = UIButton.Configuration.filled()
        look.title = "Отправить подарок"
        look.baseBackgroundColor = Theme.accent
        look.baseForegroundColor = Theme.onAccent
        look.cornerStyle = .capsule
        look.contentInsets = NSDirectionalEdgeInsets(top: 15, leading: 16, bottom: 15, trailing: 16)
        sendButton.configuration = look
        sendButton.addTarget(self, action: #selector(send), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [heading, gridHolder, caption, noteField, problem, sendButton])
        stack.axis = .vertical
        stack.spacing = 14
        stack.setCustomSpacing(6, after: caption)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.keyboardDismissMode = .interactive
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40),
        ])
        showPicked()
    }

    private func showPicked() {
        for tile in tiles {
            let on = GiftCatalog.all[tile.tag].id == picked
            tile.layer.borderColor = on ? Theme.accent.cgColor : UIColor.clear.cgColor
            tile.accessibilityTraits = on ? [.button, .selected] : [.button]
        }
    }

    @objc private func pick(_ sender: UIControl) {
        picked = GiftCatalog.all[sender.tag].id
        showPicked()
    }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        let now = (textField.text ?? "") as NSString
        return now.length - range.length + (string as NSString).length <= 120
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return false
    }

    @objc private func send() {
        guard !busy else { return }
        let note = (noteField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let messenger else {
            dismiss(animated: true) { [onSent] in onSent?() }
            return
        }
        busy = true
        problem.text = ""
        sendButton.configuration?.showsActivityIndicator = true
        messenger.sendGift(userId, gift: picked, message: note) { [weak self] (error: ServerError?) -> Void in
            guard let self else { return }
            self.busy = false
            self.sendButton.configuration?.showsActivityIndicator = false
            if let error {
                self.problem.text = error.words.isEmpty ? "Не удалось отправить подарок." : error.words
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            let sent = self.onSent
            self.dismiss(animated: true) { sent?() }
        }
    }
}
