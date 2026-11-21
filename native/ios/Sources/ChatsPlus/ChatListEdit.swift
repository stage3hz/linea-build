import UIKit

/// ChatsPlus: «Выбрать» in the list's header and the choosing of chats (ChatListScreen.tsx `editing`). While
/// choosing, every chat row has a round mark and a touch marks it; the title's line says «Отметь чаты» /
/// «Выбрано: N»; the search, «Новый чат», the stories and the bar of sections give way, and a glass bar at the bottom
/// holds what can be done with the chosen chats: «Прочитать все» (nothing chosen) / «Прочитать», «Звонок» /
/// «Звонок · N» (one person rings the ordinary way, several become a room), «В архив» / «Из архива», «Удалить».
/// «Готово» ends it. Main queue only.
final class ChatListEdit: NSObject {
    static let barHeight: CGFloat = 52

    private(set) var chosen: Set<String>?
    var selecting: Bool { chosen != nil }
    var count: Int { chosen?.count ?? 0 }

    let button = UIButton(type: .custom)
    private let buttonGlass = UIVisualEffectView(effect: nil)
    private let buttonWords = UILabel()
    private let bar = UIVisualEffectView(effect: nil)
    private let readButton = UIButton(type: .system)
    private let callButton = UIButton(type: .system)
    private let archiveButton = UIButton(type: .system)
    private let removeButton = UIButton(type: .system)

    private weak var host: UIViewController?
    private weak var actions: ChatListActions?
    private let messenger: Messenger?
    /// The mode began or ended, or a mark changed: the rows and the title are drawn again.
    var onChange: (() -> Void)?

    init(messenger: Messenger?) {
        self.messenger = messenger
        super.init()
    }

    func install(host: UIViewController, actions: ChatListActions) {
        self.host = host
        self.actions = actions
        buttonGlass.effect = TabGlass.effect(clear: false, interactive: true, dark: Theme.dark)
        buttonGlass.isUserInteractionEnabled = false
        buttonGlass.clipsToBounds = true
        buttonGlass.layer.cornerRadius = 20
        buttonGlass.layer.cornerCurve = .continuous
        button.addSubview(buttonGlass)
        buttonWords.font = Theme.font(16, .semibold)
        buttonWords.textColor = Theme.text
        buttonWords.textAlignment = .center
        buttonWords.isUserInteractionEnabled = false
        button.addSubview(buttonWords)
        button.addTarget(self, action: #selector(flip), for: .touchUpInside)
        host.view.addSubview(button)

        bar.effect = TabGlass.effect(clear: false, interactive: false, dark: Theme.dark)
        bar.clipsToBounds = true
        bar.layer.cornerRadius = 26
        bar.layer.cornerCurve = .continuous
        bar.isHidden = true
        host.view.addSubview(bar)
        for (item, action) in [(readButton, #selector(readChosen)), (callButton, #selector(callChosen)), (archiveButton, #selector(archiveChosen)), (removeButton, #selector(removeChosen))] {
            item.titleLabel?.font = Theme.font(14, .semibold)
            item.tintColor = item === removeButton ? Theme.danger : Theme.accent
            item.setTitleColor(item === removeButton ? Theme.danger : Theme.accent, for: .normal)
            item.addTarget(self, action: action, for: .touchUpInside)
            bar.contentView.addSubview(item)
        }
        callButton.accessibilityLabel = "Позвонить выбранным"
        refresh()
    }

    /// The button left of the search (or, while choosing, where «Новый чат» stands), and the bar at the bottom.
    func place(in view: UIView, safeTop: CGFloat, searchLeft: CGFloat) {
        let width = view.bounds.width
        let wordsWidth = ceil(buttonWords.sizeThatFits(CGSize(width: 200, height: 40)).width)
        let side = wordsWidth + 32
        let x = selecting ? width - 20 - side : searchLeft - 8 - side
        button.frame = CGRect(x: x, y: safeTop + 8, width: side, height: 40)
        buttonGlass.frame = button.bounds
        buttonWords.frame = button.bounds
        let bottom = view.safeAreaInsets.bottom
        bar.frame = CGRect(x: 16, y: view.bounds.height - max(bottom, 12) - 6 - ChatListEdit.barHeight, width: width - 32, height: ChatListEdit.barHeight)
        let items = [readButton, callButton, archiveButton, removeButton]
        let each = bar.bounds.width / CGFloat(items.count)
        for (index, item) in items.enumerated() {
            item.frame = CGRect(x: CGFloat(index) * each, y: 0, width: each, height: ChatListEdit.barHeight)
        }
        view.bringSubviewToFront(bar)
    }

    /// The room the list keeps at its bottom while choosing (the bar and its margins).
    func listBottom(safeBottom: CGFloat) -> CGFloat {
        return max(safeBottom, 12) + 6 + ChatListEdit.barHeight + 12
    }

    func isChosen(_ id: String) -> Bool { chosen?.contains(id) ?? false }

    /// A touch on a row while choosing: its mark goes on or off.
    func toggle(_ id: String) {
        guard var set = chosen else { return }
        Haptic.light()
        if set.contains(id) { set.remove(id) } else { set.insert(id) }
        chosen = set
        refresh()
        onChange?()
    }

    @objc private func flip() {
        Haptic.light()
        set(selecting ? nil : Set<String>())
    }

    /// Begins (an empty set), ends (nil) or replaces what is chosen.
    func set(_ next: Set<String>?) {
        let was = selecting
        chosen = next
        refresh()
        if was != selecting {
            host?.view.endEditing(true)
            (host?.parent as? RootViewController)?.setBarAway(selecting)
            bar.alpha = selecting ? 0 : 1
            bar.isHidden = false
            let show = selecting
            UIView.animate(withDuration: 0.18, animations: { self.bar.alpha = show ? 1 : 0 }, completion: { (_: Bool) -> Void in
                if !self.selecting { self.bar.isHidden = true }
            })
            host?.view.setNeedsLayout()
        }
        onChange?()
    }

    private func refresh() {
        buttonWords.text = selecting ? "Готово" : "Выбрать"
        button.accessibilityLabel = buttonWords.text
        let marked = count
        let archive = actions?.showingArchive ?? false
        readButton.setTitle(marked > 0 ? "Прочитать" : "Прочитать все", for: .normal)
        callButton.setTitle(marked > 1 ? "Звонок · \(marked)" : "Звонок", for: .normal)
        archiveButton.setTitle(archive ? "Из архива" : "В архив", for: .normal)
        removeButton.setTitle("Удалить", for: .normal)
        for item in [callButton, archiveButton, removeButton] {
            item.isEnabled = marked > 0
            item.alpha = marked > 0 ? 1 : 0.4
        }
        host?.view.setNeedsLayout()
    }

    // MARK: What is done with the chosen chats

    private var picked: [String] { Array(chosen ?? []) }

    @objc private func readChosen() {
        actions?.groupRead(picked)
        Haptic.light()
        set(nil)
    }

    @objc private func archiveChosen() {
        guard count > 0 else { return }
        actions?.groupArchive(picked, archived: !(actions?.showingArchive ?? false))
        Haptic.light()
        set(nil)
    }

    @objc private func removeChosen() {
        guard count > 0 else { return }
        actions?.groupRemove(picked) { [weak self] in self?.set(nil) }
    }

    /// One chosen person is an ordinary call; several become a room and everyone is called at once.
    @objc private func callChosen() {
        guard count > 0, let actions else { return }
        let chats = actions.summaries(picked)
        set(nil)
        Haptic.light()
        guard let first = chats.first else { return }
        if chats.count == 1 {
            CallEntry.call(messenger: messenger, chatId: first.id, peerId: first.peerId, name: first.title, video: false)
            return
        }
        guard messenger != nil else { return }
        let host = self.host
        Rooms.shared.startCall(memberIds: chats.map { $0.peerId }) { (words: String?) -> Void in
            guard let words else { return }
            let alert = UIAlertController(title: nil, message: words.isEmpty ? "Не удалось позвонить." : words, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
            host?.present(alert, animated: true)
        }
    }
}
