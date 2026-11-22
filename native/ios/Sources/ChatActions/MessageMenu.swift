import UIKit

/// The reactions a message can get — the reference's set, in its order (messageMeta.ts `REACTIONS`; the core
/// refuses any other). The first seven are the quick row of the menu.
enum MessageReactions {
    static let all: [String] = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👎", "🎉", "🙏", "👏", "🤔", "💯", "😍", "🥰", "😁", "🤣", "😎", "🤯", "😱", "🤬", "🥺", "😭", "🤡", "💩", "👀", "💀", "🫡", "🤝", "✍️", "🙈", "😴", "🤗", "🍾", "💔", "⚡", "🏆", "🥶", "😈", "🫶", "✅", "❌", "👌"]
    static let quick = 7
}

/// The menu of one message: the quick reactions, the message's own words, and what can be done with it.
/// It stands over the chat, next to the message it was opened for; a touch beside it puts it away.
final class MessageMenuController: UIViewController {
    struct Item {
        let symbol: String
        let label: String
        var danger = false
        /// A little room above the item (the reference's «separated»).
        var separated = false
        /// The item changes the menu itself instead of closing it («Удалить» → for whom).
        var stays = false
        let run: () -> Void
    }

    private let anchorY: CGFloat
    private let mine: Bool
    private let previewWords: String
    private let reactions: [(emoji: String, chosen: Bool)]
    private var items: [Item]
    /// A reaction was chosen (the menu is already closed).
    var onReact: ((String) -> Void)?
    /// ChatScreen.tsx `peek`: the message's own row as it stands in the chat (the real bubble, photo included), shown
    /// full width above the menu instead of the words alone. Set before presenting.
    var peekView: UIView?
    /// ContextMenu.tsx ReadDateRow: asks when the peer read the message; the answer is «Прочитано …» or nil (no row).
    /// Set before presenting, for an own read message younger than seven days.
    var readDate: ((@escaping (String?) -> Void) -> Void)?
    private let readRow = UIView()
    private let readIcon = UIImageView()
    private let readLabel = UILabel()
    private let readSkeleton = UIView()
    private let readBand = UIView()
    private var readShown = false
    /// ContextMenu.tsx `shadow`: black 0.28, radius 18, 8 down — drawn by plain views under the glass (the glass clips
    /// to its corners, so it cannot carry a shadow itself).
    private let pillShadow = MessageMenuController.shadowView()
    private let bubbleShadow = MessageMenuController.shadowView()
    private let panelShadow = MessageMenuController.shadowView()
    private static func shadowView() -> UIView {
        let shade = UIView()
        shade.isUserInteractionEnabled = false
        shade.backgroundColor = .clear
        shade.layer.shadowColor = UIColor.black.cgColor
        shade.layer.shadowOpacity = 0.28
        shade.layer.shadowRadius = 18
        shade.layer.shadowOffset = CGSize(width: 0, height: 8)
        return shade
    }
    private func shade(_ shadow: UIView, like glass: UIView, radius: CGFloat) {
        shadow.isHidden = glass.isHidden
        shadow.frame = glass.frame
        shadow.layer.shadowPath = UIBezierPath(roundedRect: shadow.bounds, cornerRadius: radius).cgPath
    }

    private let backdrop = UIVisualEffectView(effect: Theme.thinBlur)
    private let dim = UIButton(type: .custom)
    private let pill = UIVisualEffectView(effect: nil)
    private let moreButton = UIButton(type: .system)
    private var reactionButtons: [UIButton] = []
    private let bubble = UIView()
    private let bubbleLabel = UILabel()
    private let panel = UIVisualEffectView(effect: nil)
    private var rowViews: [MessageMenuRow] = []
    private var allShown = false

    /// `anchorY`: where on the screen the message was touched. `mine`: the menu stands at the sender's edge.
    init(anchorY: CGFloat, mine: Bool, preview: String, reactions: [(emoji: String, chosen: Bool)], items: [Item]) {
        self.anchorY = anchorY
        self.mine = mine
        previewWords = preview
        self.reactions = reactions
        self.items = items
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.addSubview(backdrop)
        // ContextMenu.tsx: black 0.34 on a dark theme, rgba(20,30,60,0.14) on a light one.
        dim.backgroundColor = Theme.dark ? UIColor(white: 0, alpha: 0.34) : UIColor(red: 20 / 255, green: 30 / 255, blue: 60 / 255, alpha: 0.14)
        dim.accessibilityLabel = "Закрыть меню"
        dim.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        view.addSubview(dim)

        pill.effect = chatGlass()
        pill.clipsToBounds = true
        pill.layer.cornerRadius = 24
        pill.layer.cornerCurve = .continuous
        pill.isHidden = reactions.isEmpty
        MessageMenuController.tint(pill)
        view.addSubview(pillShadow)
        view.addSubview(pill)
        for (index, reaction) in reactions.enumerated() {
            let button = UIButton(type: .custom)
            button.setTitle(reaction.emoji, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 25)
            button.backgroundColor = reaction.chosen ? Theme.veil(0.16) : .clear
            button.layer.cornerRadius = 20
            button.tag = index
            button.accessibilityLabel = "Реакция " + reaction.emoji
            if reaction.chosen { button.accessibilityTraits.insert(.selected) }
            button.addTarget(self, action: #selector(reacted(_:)), for: .touchUpInside)
            pill.contentView.addSubview(button)
            reactionButtons.append(button)
        }
        moreButton.setImage(chatSymbol("ion:chevron-down", 18), for: .normal) // ContextMenu.tsx «Все реакции»
        moreButton.tintColor = Theme.muted
        moreButton.accessibilityLabel = "Все реакции"
        moreButton.addTarget(self, action: #selector(showAll), for: .touchUpInside)
        pill.contentView.addSubview(moreButton)

        // ContextMenu.tsx: the words on the message's own colour, the chat's corner radius, padding 12 / 6.
        bubble.backgroundColor = mine ? ThemeStore.look.bubble : ThemeStore.look.incoming
        bubble.layer.cornerRadius = ChatBubbleLook.radius
        bubble.layer.cornerCurve = .continuous
        bubble.isHidden = previewWords.isEmpty
        bubble.isUserInteractionEnabled = false
        view.addSubview(bubbleShadow)
        view.addSubview(bubble)
        bubbleLabel.text = previewWords
        bubbleLabel.font = .systemFont(ofSize: ThemeStore.textSize)
        bubbleLabel.textColor = Theme.text
        bubbleLabel.numberOfLines = 6
        bubble.addSubview(bubbleLabel)

        panel.effect = chatGlass()
        panel.clipsToBounds = true
        panel.layer.cornerRadius = 26 // ContextMenu.tsx: the menu's radius
        panel.layer.cornerCurve = .continuous
        MessageMenuController.tint(panel)
        view.addSubview(panelShadow)
        view.addSubview(panel)
        if let peek = peekView {
            bubble.isHidden = true
            peek.isUserInteractionEnabled = true // ContextMenu.tsx `peekTouch`: a hold on the copy selects its words
            view.addSubview(peek)
        }
        if let ask = readDate {
            // ContextMenu.tsx ReadDateRow: <Icon name="checkmark-done" size={19} color={t.muted}>, 12 to the words (14,
            // muted), 40 tall, padding 14; a grey bar while it loads; a 7-point band under it.
            readShown = true
            readIcon.image = IonIcon.image("checkmark-done", size: 19)
            readIcon.tintColor = Theme.muted
            readIcon.contentMode = .center
            readRow.addSubview(readIcon)
            readLabel.font = .systemFont(ofSize: 14)
            readLabel.textColor = Theme.muted
            readLabel.isHidden = true
            readRow.addSubview(readLabel)
            readSkeleton.backgroundColor = Theme.dark ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.07)
            readSkeleton.layer.cornerRadius = 6
            readRow.addSubview(readSkeleton)
            readRow.isAccessibilityElement = true
            readRow.accessibilityTraits = .staticText
            readBand.backgroundColor = UIColor(white: 0, alpha: Theme.dark ? 0.28 : 0.06)
            panel.contentView.addSubview(readRow)
            panel.contentView.addSubview(readBand)
            ask { [weak self] (words: String?) -> Void in
                guard let self else { return }
                if let words {
                    self.readLabel.text = words
                    self.readLabel.isHidden = false
                    self.readSkeleton.isHidden = true
                    self.readRow.accessibilityLabel = words
                } else {
                    self.readShown = false
                    self.readRow.isHidden = true
                    self.readBand.isHidden = true
                }
                self.view.setNeedsLayout()
            }
        }
        buildRows()
    }

    /// ContextMenu.tsx glass: over the blur rgba(40,42,50,0.55) on dark / white 0.55 on light, a hairline border of
    /// white 0.14 / black 0.08.
    private static func tint(_ glass: UIVisualEffectView) {
        let veil = UIView()
        veil.backgroundColor = Theme.dark ? UIColor(red: 40 / 255, green: 42 / 255, blue: 50 / 255, alpha: 0.55) : UIColor(white: 1, alpha: 0.55)
        veil.isUserInteractionEnabled = false
        veil.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        veil.frame = glass.contentView.bounds
        glass.contentView.insertSubview(veil, at: 0)
        glass.layer.borderWidth = 1 / UIScreen.main.scale
        glass.layer.borderColor = (Theme.dark ? UIColor(white: 1, alpha: 0.14) : UIColor(white: 0, alpha: 0.08)).cgColor
    }

    /// The bands above «separated» items, by the item's index.
    private var separatorBands: [Int: UIView] = [:]

    private func buildRows() {
        for row in rowViews { row.removeFromSuperview() }
        rowViews = []
        for band in separatorBands.values { band.removeFromSuperview() }
        separatorBands = [:]
        for (index, item) in items.enumerated() where item.separated && index > 0 {
            let band = UIView()
            band.backgroundColor = UIColor(white: 0, alpha: Theme.dark ? 0.22 : 0.05)
            band.isUserInteractionEnabled = false
            panel.contentView.addSubview(band)
            separatorBands[index] = band
        }
        for (index, item) in items.enumerated() {
            let row = MessageMenuRow(symbol: item.symbol, label: item.label, danger: item.danger)
            row.tag = index
            row.addTarget(self, action: #selector(rowChosen(_:)), for: .touchUpInside)
            panel.contentView.addSubview(row)
            rowViews.append(row)
        }
        view.setNeedsLayout()
    }

    /// Puts other items into the open menu («Удалить» asks for whom); the reactions go away.
    func replace(items next: [Item]) {
        items = next
        pill.isHidden = true
        // ChatScreen.tsx: the read row is not part of «Удалить» → for whom.
        readShown = false
        readRow.isHidden = true
        readBand.isHidden = true
        buildRows()
    }

    @objc private func closeNow() { dismiss(animated: true) }

    @objc private func showAll() {
        allShown = true
        moreButton.isHidden = true
        view.setNeedsLayout()
    }

    @objc private func reacted(_ sender: UIButton) {
        guard sender.tag < reactions.count else { return }
        let emoji = reactions[sender.tag].emoji
        let react = onReact
        dismiss(animated: true) { react?(emoji) }
    }

    @objc private func rowChosen(_ sender: UIControl) {
        guard sender.tag < items.count else { return }
        let item = items[sender.tag]
        if item.stays { item.run(); return }
        dismiss(animated: true) { item.run() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let safe = view.safeAreaInsets
        backdrop.frame = bounds
        dim.frame = bounds
        let column = min(340, bounds.width - 24)
        let panelWidth = min(250, column)

        var pillSize = CGSize.zero
        if !pill.isHidden {
            if allShown {
                let cell: CGFloat = (column - 16) / 7
                let line: CGFloat = min(cell, 44)
                let lines: CGFloat = ceil(CGFloat(reactions.count) / 7)
                pillSize = CGSize(width: column, height: lines * line + 16)
                for (index, button) in reactionButtons.enumerated() {
                    let across = CGFloat(index % 7), down = CGFloat(index / 7)
                    let x: CGFloat = 8 + across * cell + (cell - 40) / 2
                    let top: CGFloat = 8 + down * line + (line - 40) / 2
                    button.isHidden = false
                    button.frame = CGRect(x: x, y: top, width: 40, height: 40)
                }
            } else {
                let quick = min(MessageReactions.quick, reactions.count)
                let more: CGFloat = reactions.count > quick ? 30 : 0
                pillSize = CGSize(width: CGFloat(quick) * 40 + more + 8, height: 48)
                for (index, button) in reactionButtons.enumerated() {
                    button.isHidden = index >= quick
                    button.frame = CGRect(x: 4 + CGFloat(index) * 40, y: 4, width: 40, height: 40)
                }
                moreButton.isHidden = more == 0
                moreButton.frame = CGRect(x: 4 + CGFloat(quick) * 40, y: 4, width: 30, height: 40)
            }
        }
        var bubbleSize = CGSize.zero
        if !bubble.isHidden {
            let widest = min(column, (bounds.width - 18) * 0.85) - 24
            let fit = bubbleLabel.sizeThatFits(CGSize(width: max(1, widest), height: CGFloat.greatestFiniteMagnitude))
            bubbleSize = CGSize(width: min(widest, ceil(fit.width)) + 24, height: ceil(fit.height) + 12)
        }
        var panelHeight: CGFloat = 0
        if readShown {
            readRow.frame = CGRect(x: 0, y: 0, width: panelWidth, height: 40)
            readIcon.frame = CGRect(x: 14, y: 0, width: 19, height: 40)
            readLabel.frame = CGRect(x: 14 + 19 + 12, y: 0, width: max(0, panelWidth - 45 - 14), height: 40)
            readSkeleton.frame = CGRect(x: 14 + 19 + 12, y: 14, width: 150, height: 12)
            readBand.frame = CGRect(x: 0, y: 40, width: panelWidth, height: 7)
            panelHeight = 47
        }
        // ContextMenu.tsx `peekRow`: the copy of the message spans the screen.
        var peekSize = CGSize.zero
        if let peek = peekView { peekSize = CGSize(width: bounds.width, height: peek.bounds.height) }
        for (index, row) in rowViews.enumerated() {
            // ContextMenu.tsx MenuItem: 44 tall; «separated» is a 6-point band (black 0.22 on dark, 0.05 on light).
            if index < items.count, items[index].separated, index > 0 {
                let band = separatorBands.count > index ? separatorBands[index] : nil
                band?.frame = CGRect(x: 0, y: panelHeight, width: panelWidth, height: 6)
                panelHeight += 6
            }
            row.frame = CGRect(x: 0, y: panelHeight, width: panelWidth, height: 44)
            panelHeight += 44
        }

        var total = panelHeight
        if pillSize != .zero { total += pillSize.height + 8 }
        if bubbleSize != .zero { total += bubbleSize.height + 8 }
        if peekSize != .zero { total += peekSize.height + 8 }
        let highest = safe.top + 8
        let lowest = bounds.height - safe.bottom - 8 - total
        var y = max(highest, min(anchorY - 70, lowest))
        func placed(_ size: CGSize) -> CGRect {
            let x = mine ? bounds.width - 9 - size.width : 9
            return CGRect(x: x, y: y, width: size.width, height: size.height)
        }
        if pillSize != .zero {
            pill.frame = placed(pillSize)
            pill.layer.cornerRadius = allShown ? 26 : 24
            y += pillSize.height + 8
        }
        if let peek = peekView, peekSize != .zero {
            peek.frame = CGRect(x: 0, y: y, width: peekSize.width, height: peekSize.height)
            y += peekSize.height + 8
        }
        if bubbleSize != .zero {
            bubble.frame = placed(bubbleSize)
            bubbleLabel.frame = bubble.bounds.insetBy(dx: 12, dy: 6)
            y += bubbleSize.height + 8
        }
        panel.frame = placed(CGSize(width: panelWidth, height: panelHeight))
        shade(pillShadow, like: pill, radius: pill.layer.cornerRadius)
        shade(bubbleShadow, like: bubble, radius: bubble.layer.cornerRadius)
        shade(panelShadow, like: panel, radius: 26)
    }
}

/// One line of the message menu.
private final class MessageMenuRow: UIControl {
    /// The reference's Ionicons for the menu's items (ChatScreen.tsx MenuItem icons), by the names the items carry.
    static let ion: [String: String] = [
        "arrowshape.turn.up.left": "arrow-undo-outline", "doc.on.doc": "copy-outline", "square.and.arrow.down": "download-outline",
        "pin": "pin-outline", "pin.slash": "pin", "arrowshape.turn.up.right": "arrow-redo-outline", "square.and.pencil": "create-outline",
        "arrow.clockwise": "refresh-outline", "trash": "trash-outline", "checkmark.circle": "checkmark-circle-outline",
        "eye.slash": "eye-off-outline", "bookmark": "bookmark-outline",
    ]

    private let mark = UIImageView()
    private let nameLabel = UILabel()

    init(symbol: String, label: String, danger: Bool) {
        super.init(frame: .zero)
        let ink = danger ? Theme.danger : Theme.text
        mark.image = chatSymbol(MessageMenuRow.ion[symbol].map { "ion:" + $0 } ?? symbol, 19) // <Icon size={19}>
        mark.tintColor = ink
        mark.contentMode = .center
        addSubview(mark)
        nameLabel.text = label
        nameLabel.font = .systemFont(ofSize: 15.5)
        nameLabel.textColor = ink
        nameLabel.adjustsFontSizeToFitWidth = true
        nameLabel.minimumScaleFactor = 0.75
        addSubview(nameLabel)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = label
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? (Theme.dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.05)) : .clear }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // ContextMenu.tsx: padding 16, the 19-point icon, 13 to the words.
        mark.frame = CGRect(x: 16, y: 0, width: 19, height: bounds.height)
        nameLabel.frame = CGRect(x: 48, y: 0, width: max(0, bounds.width - 48 - 16), height: bounds.height)
    }
}
