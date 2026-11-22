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
        dim.backgroundColor = UIColor(white: 0, alpha: 0.34)
        dim.accessibilityLabel = "Закрыть меню"
        dim.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        view.addSubview(dim)

        pill.effect = chatGlass()
        pill.clipsToBounds = true
        pill.layer.cornerRadius = 24
        pill.layer.cornerCurve = .continuous
        pill.isHidden = reactions.isEmpty
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

        bubble.backgroundColor = Theme.panel(UIColor(hex: 0x1F2023))
        bubble.layer.cornerRadius = 18
        bubble.layer.cornerCurve = .continuous
        bubble.isHidden = previewWords.isEmpty
        bubble.isUserInteractionEnabled = false
        view.addSubview(bubble)
        bubbleLabel.text = previewWords
        bubbleLabel.font = .systemFont(ofSize: 17)
        bubbleLabel.textColor = Theme.text
        bubbleLabel.numberOfLines = 6
        bubble.addSubview(bubbleLabel)

        panel.effect = chatGlass()
        panel.clipsToBounds = true
        panel.layer.cornerRadius = 26 // ContextMenu.tsx: the menu's radius
        panel.layer.cornerCurve = .continuous
        view.addSubview(panel)
        buildRows()
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
            bubbleSize = CGSize(width: min(widest, ceil(fit.width)) + 24, height: ceil(fit.height) + 14)
        }
        var panelHeight: CGFloat = 0
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
        if bubbleSize != .zero {
            bubble.frame = placed(bubbleSize)
            bubbleLabel.frame = bubble.bounds.insetBy(dx: 12, dy: 7)
            y += bubbleSize.height + 8
        }
        panel.frame = placed(CGSize(width: panelWidth, height: panelHeight))
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
