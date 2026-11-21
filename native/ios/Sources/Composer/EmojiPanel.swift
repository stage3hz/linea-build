import UIKit

/// The emoji panel under the composer (the reference's StickerPanel.tsx): a tap puts the emoji into the text at
/// the cursor (like the system keyboard); a message of only 1–3 emoji is then shown large. It stands where the
/// keyboard was, as tall as the keyboard last was; a swipe down — from the header at any time, from the grid when
/// it is at its top — puts it away. Nothing is downloaded from anywhere.
final class EmojiPanel: UIView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout, UIGestureRecognizerDelegate {
    static let sets: [(id: String, icon: String, items: [String])] = [
        (id: "faces", icon: "😀", items: ["😀", "😃", "😄", "😁", "😆", "🥹", "😅", "😂", "🤣", "🥲", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚", "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🥸", "🤩", "🥳", "😏", "😒", "😞", "😔", "😟", "😕", "🙁", "😣", "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "😥", "😓", "🤗", "🤔", "🫣", "🤭", "🫢", "🫡", "🤫", "🫠", "🤥", "😶", "🫥", "😐", "🫤", "😑", "😬", "🙄", "😯", "😦", "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵", "🤐", "🥴", "🤢", "🤮", "🤧", "😷", "🤒", "🤕", "🤑", "🤠", "😈", "👿", "👻", "💀", "☠️", "👽", "🤖", "🎃", "😺", "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾"]),
        (id: "hands", icon: "👍", items: ["👍", "👎", "👌", "🤌", "🤏", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "✋", "🤚", "🖐️", "🖖", "👋", "🫶", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "✍️", "💪", "🦾", "🫵", "👀", "🧠", "🫀", "👄", "💋"]),
        (id: "hearts", icon: "❤️", items: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❤️‍🔥", "❤️‍🩹", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "✨", "🔥", "💯", "💥", "💫", "⭐", "🌟", "⚡", "🎉", "🎊", "🎁", "🏆", "🥇", "👑", "💎", "🎈"]),
        (id: "animals", icon: "🐶", items: ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐻‍❄️", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐔", "🐧", "🐦", "🐤", "🦆", "🦅", "🦉", "🦇", "🐺", "🐗", "🐴", "🦄", "🐝", "🦋", "🐌", "🐞", "🐢", "🐍", "🦖", "🐙", "🦑", "🦀", "🐡", "🐠", "🐬", "🐳", "🦈", "🐊", "🐘", "🦒", "🦔", "🐾"]),
        (id: "food", icon: "🍕", items: ["🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🥑", "🍆", "🥦", "🌶️", "🌽", "🥕", "🥐", "🍞", "🧀", "🍳", "🥞", "🥓", "🍔", "🍟", "🍕", "🌭", "🥪", "🌮", "🌯", "🍝", "🍜", "🍣", "🍱", "🍩", "🍪", "🎂", "🍰", "🧁", "🍫", "🍬", "🍭", "🍿", "☕", "🍵", "🧃", "🥤", "🧋", "🍺", "🍷", "🥂", "🍾"]),
        (id: "activity", icon: "⚽", items: ["⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏉", "🎱", "🏓", "🏸", "🥊", "🥋", "⛳", "⛸️", "🎿", "🛹", "🏂", "🏋️", "🚴", "🏊", "🎮", "🕹️", "🎲", "🧩", "🎯", "🎳", "🎸", "🎹", "🥁", "🎤", "🎧", "🎬", "🎨", "📸", "🚗", "🏎️", "✈️", "🚀", "🛸", "🏖️", "🏝️", "🌋", "🌈", "☀️", "🌙", "❄️", "☔", "🌊"]),
    ]
    private static let recentKey = "invizent.emoji.recent.v1"

    /// An emoji was chosen.
    var onPick: ((String) -> Void)?
    /// «Стереть символ» (a long touch: eight at once).
    var onErase: (() -> Void)?
    /// The panel wants to go (the chevron, a swipe down).
    var onClose: (() -> Void)?

    private let surface = UIVisualEffectView(effect: nil)
    private let grabber = UIView()
    private var tabButtons: [UIButton] = []
    private let erase = UIButton(type: .system)
    private let hide = UIButton(type: .system)
    private let grid: UICollectionView
    private let emptyLabel = UILabel()
    private var chosen = "recent"
    /// The swipe down that closes the panel.
    private let closePan = UIPanGestureRecognizer()
    private var recent: [String] = []

    override init(frame: CGRect) {
        let layout = UICollectionViewFlowLayout()
        layout.minimumInteritemSpacing = 0
        layout.minimumLineSpacing = 0
        grid = UICollectionView(frame: .zero, collectionViewLayout: layout)
        super.init(frame: frame)
        backgroundColor = .clear
        surface.layer.cornerRadius = 26
        surface.layer.cornerCurve = .continuous
        surface.clipsToBounds = true
        surface.layer.borderWidth = 1
        surface.layer.borderColor = Theme.veil(0.08).cgColor
        addSubview(surface)
        grabber.backgroundColor = Theme.subtle.withAlphaComponent(0.45)
        grabber.layer.cornerRadius = 2
        surface.contentView.addSubview(grabber)
        let ids = ["recent"] + EmojiPanel.sets.map { $0.id }
        for (index, id) in ids.enumerated() {
            let button = UIButton(type: .custom)
            button.tag = index
            button.layer.cornerRadius = 12
            if id == "recent" {
                button.setImage(chatSymbol("clock", 17), for: .normal)
                button.accessibilityLabel = "Недавние"
            } else {
                button.setTitle(EmojiPanel.sets[index - 1].icon, for: .normal)
                button.titleLabel?.font = .systemFont(ofSize: 20)
            }
            button.accessibilityTraits = .button
            button.addTarget(self, action: #selector(tabChosen(_:)), for: .touchUpInside)
            surface.contentView.addSubview(button)
            tabButtons.append(button)
        }
        erase.setImage(chatSymbol("delete.left", 19), for: .normal)
        erase.tintColor = Theme.muted
        erase.accessibilityLabel = "Стереть символ"
        erase.addTarget(self, action: #selector(eraseOne), for: .touchUpInside)
        let eraseHold = UILongPressGestureRecognizer(target: self, action: #selector(eraseMany(_:)))
        erase.addGestureRecognizer(eraseHold)
        surface.contentView.addSubview(erase)
        hide.setImage(chatSymbol("chevron.down", 18), for: .normal)
        hide.tintColor = Theme.muted
        hide.accessibilityLabel = "Скрыть эмодзи"
        hide.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        surface.contentView.addSubview(hide)
        grid.backgroundColor = .clear
        grid.dataSource = self
        grid.delegate = self
        grid.alwaysBounceVertical = true
        grid.showsVerticalScrollIndicator = false
        grid.contentInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        grid.register(EmojiCell.self, forCellWithReuseIdentifier: "emoji")
        surface.contentView.addSubview(grid)
        emptyLabel.text = "Здесь появятся недавние"
        emptyLabel.font = .systemFont(ofSize: 13)
        emptyLabel.textColor = Theme.muted
        emptyLabel.textAlignment = .center
        surface.contentView.addSubview(emptyLabel)
        // A swipe down closes the panel: from the header at any time, from the grid when it is at its top.
        closePan.addTarget(self, action: #selector(dragged(_:)))
        closePan.delegate = self
        addGestureRecognizer(closePan)

        recent = (UserDefaults.standard.array(forKey: EmojiPanel.recentKey) as? [String] ?? []).prefix(32).map { $0 }
        if recent.isEmpty { chosen = "faces" }
        showTabs()
    }

    required init?(coder: NSCoder) { return nil }

    /// Appears with a short lift (or at once when motion is reduced).
    func appear() {
        surface.effect = TabGlass.effect(clear: false, interactive: false, dark: Theme.dark)
        if UIAccessibility.isReduceMotionEnabled { return }
        alpha = 0
        transform = CGAffineTransform(translationX: 0, y: 40)
        UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0, options: [.allowUserInteraction], animations: {
            self.alpha = 1
            self.transform = .identity
        }, completion: nil)
    }

    private var items: [String] {
        if chosen == "recent" { return recent }
        return EmojiPanel.sets.first { $0.id == chosen }?.items ?? []
    }

    private func showTabs() {
        let ids = ["recent"] + EmojiPanel.sets.map { $0.id }
        for (index, button) in tabButtons.enumerated() {
            let on = ids[index] == chosen
            button.backgroundColor = on ? Theme.accent.withAlphaComponent(0.16) : .clear
            button.tintColor = on ? Theme.accent : Theme.muted
            button.isSelected = on
        }
        emptyLabel.isHidden = !items.isEmpty
        grid.reloadData()
        grid.setContentOffset(CGPoint(x: -grid.contentInset.left, y: -grid.contentInset.top), animated: false)
    }

    @objc private func tabChosen(_ sender: UIButton) {
        let ids = ["recent"] + EmojiPanel.sets.map { $0.id }
        guard sender.tag < ids.count else { return }
        chosen = ids[sender.tag]
        UISelectionFeedbackGenerator().selectionChanged()
        showTabs()
    }

    @objc private func eraseOne() { onErase?() }

    @objc private func eraseMany(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began else { return }
        for _ in 0..<8 { onErase?() }
    }

    @objc private func closeNow() { onClose?() }

    private func pick(_ emoji: String) {
        onPick?(emoji)
        recent = [emoji] + recent.filter { $0 != emoji }
        if recent.count > 32 { recent = Array(recent.prefix(32)) }
        UserDefaults.standard.set(recent, forKey: EmojiPanel.recentKey)
    }

    // MARK: The swipe down

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === closePan, let pan = gestureRecognizer as? UIPanGestureRecognizer else { return super.gestureRecognizerShouldBegin(gestureRecognizer) }
        let move = pan.translation(in: self), speed = pan.velocity(in: self)
        let down = (speed.y > 0 && abs(speed.y) > abs(speed.x) * 1.4) || (move.y > 8 && abs(move.y) > abs(move.x) * 1.4)
        let inHeader = pan.location(in: self).y < 52
        let gridAtTop = grid.contentOffset.y <= -grid.contentInset.top + 2
        return down && (inHeader || gridAtTop)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        false
    }

    @objc private func dragged(_ pan: UIPanGestureRecognizer) {
        let move = max(0, pan.translation(in: self).y)
        switch pan.state {
        case .changed:
            transform = CGAffineTransform(translationX: 0, y: move)
        case .ended, .cancelled:
            if move > 70 || pan.velocity(in: self).y > 800 {
                UIView.animate(withDuration: 0.16, animations: { self.transform = CGAffineTransform(translationX: 0, y: 320) }, completion: { _ in self.onClose?() })
            } else {
                UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0, options: [], animations: { self.transform = .identity }, completion: nil)
            }
        default:
            break
        }
    }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        // Pulling the grid down past its top (the bounce) and letting go closes the panel too.
        if scrollView.contentOffset.y < -scrollView.contentInset.top - 36 {
            UIView.animate(withDuration: 0.16, animations: { self.transform = CGAffineTransform(translationX: 0, y: 320) }, completion: { _ in self.onClose?() })
        }
    }

    // MARK: The grid

    private var columns: Int { max(6, Int((bounds.width - 16) / 54)) }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { items.count }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "emoji", for: indexPath)
        if let emojiCell = cell as? EmojiCell, indexPath.item < items.count { emojiCell.show(items[indexPath.item]) }
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
        let side = floor((collectionView.bounds.width - 16) / CGFloat(columns))
        return CGSize(width: side, height: side)
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        guard indexPath.item < items.count else { return }
        pick(items[indexPath.item])
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        surface.frame = bounds
        let width = bounds.width
        grabber.frame = CGRect(x: (width - 36) / 2, y: 7, width: 36, height: 4)
        var x: CGFloat = 8
        for button in tabButtons {
            button.frame = CGRect(x: x, y: 14, width: 40, height: 36)
            x += 42
        }
        hide.frame = CGRect(x: width - 8 - 36, y: 14, width: 36, height: 36)
        erase.frame = CGRect(x: width - 8 - 36 - 40, y: 14, width: 40, height: 36)
        let gridFrame = CGRect(x: 0, y: 52, width: width, height: max(0, bounds.height - 52))
        if grid.frame != gridFrame {
            grid.frame = gridFrame
            grid.collectionViewLayout.invalidateLayout()
        }
        emptyLabel.frame = gridFrame
    }
}

/// One emoji of the grid; it grows a little while pressed.
private final class EmojiCell: UICollectionViewCell {
    private let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.font = .systemFont(ofSize: 34)
        label.textAlignment = .center
        contentView.addSubview(label)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ emoji: String) {
        label.text = emoji
        accessibilityLabel = "Вставить " + emoji
    }

    override var isHighlighted: Bool {
        didSet {
            UIView.animate(withDuration: 0.12) { self.label.transform = self.isHighlighted ? CGAffineTransform(scaleX: 1.25, y: 1.25) : .identity }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = contentView.bounds
    }
}
