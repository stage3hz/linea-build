import UIKit

/// What the composer of a chat has beyond the field and the send button (the reference's ChatScreen.tsx): the
/// long touch on «Отправить» («Отправить без звука», «Отправить позже»), the pill of the chat's scheduled
/// messages, the emoji button with its panel, and the formatting bar over a selection with the styles shown in
/// the field. ChatScreenActions owns it and hands it the views in `install`. Main queue only.
final class ComposerExtras: NSObject {
    /// The room the emoji button takes inside the composer, right of the field.
    static let emojiRoom: CGFloat = 38

    private weak var host: UIViewController?
    private weak var field: ComposerField?
    private weak var sendButton: UIButton?
    private weak var composer: UIView?
    private var messenger: Messenger?
    private var chatId = ""
    private var peerName = ""

    /// A message is to go out with these options (the long touch on the send button).
    var onSend: ((_ silent: Bool, _ deliverAt: Date?) -> Void)?
    /// Whether the send button may offer its options now (not while editing or forwarding).
    var canOffer: (() -> Bool)?
    /// The layout changed (the panel, the bar, the pill).
    var onLayout: (() -> Void)?
    /// A short line to show under the header.
    var onSay: ((String) -> Void)?

    private let emojiButton = UIButton(type: .system)
    private var panel: EmojiPanel?
    private var keyboardHeight: CGFloat = 0
    private var keyboardShown = false
    private let formatBar = FormatBar(frame: .zero)
    private let pill = ScheduledPill(frame: .zero)
    /// The simulator's sample list (no account).
    private var sampleScheduled: [ScheduledItem] = []

    /// The styles of the text in the field, as entities over its whole (untrimmed) text.
    private(set) var entities: [[String: Any]] = []
    private var lastText = ""
    /// The field shows styles now (so plain text is set back once they are gone).
    private var styled = false

    // MARK: Setting up

    func install(host: UIViewController, field: ComposerField, send: UIButton, composer: UIView, messenger: Messenger?, chatId: String, peerId: String, peerName: String) {
        self.host = host
        self.field = field
        sendButton = send
        self.composer = composer
        self.messenger = messenger
        self.chatId = chatId
        self.peerName = peerName

        let hold = UILongPressGestureRecognizer(target: self, action: #selector(sendHeld(_:)))
        hold.minimumPressDuration = 0.35
        send.addGestureRecognizer(hold)
        send.accessibilityHint = "Удержи: без звука или отправить позже"

        emojiButton.setImage(chatSymbol("ion:happy-outline", 22), for: .normal)
        emojiButton.tintColor = Theme.muted
        emojiButton.accessibilityLabel = "Стикеры и эмодзи"
        emojiButton.addTarget(self, action: #selector(toggleEmoji), for: .touchUpInside)
        // Inside the glass: subviews of an effect view go into its content view.
        let holder: UIView = (composer as? UIVisualEffectView)?.contentView ?? composer
        holder.addSubview(emojiButton)

        formatBar.isHidden = true
        formatBar.onAction = { [weak self] (type: String) -> Void in self?.apply(type, url: nil) }
        formatBar.onLink = { [weak self] in self?.askLink() }
        host.view.addSubview(formatBar)

        pill.isHidden = true
        pill.addTarget(self, action: #selector(openScheduled), for: .touchUpInside)
        host.view.addSubview(pill)

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardWillShow(_:)), name: UIResponder.keyboardWillShowNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardWillHide), name: UIResponder.keyboardWillHideNotification, object: nil)
        center.addObserver(self, selector: #selector(scheduledChanged), name: ScheduledStore.changed, object: nil)
        if let messenger {
            ScheduledStore.of(messenger).remember(chatId: chatId, peerId: peerId)
            ScheduledStore.of(messenger).refresh()
        }
        lastText = field.text ?? ""
        #if targetEnvironment(simulator)
        simulatorSeed()
        #endif
        showPill()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: Layout

    /// Puts the emoji button into the composer and gives the field the room left of it; places the formatting
    /// bar above `above` and the scheduled pill under the header. Gives the new top of what stands above the field.
    func place(in view: UIView, composerFrame: CGRect, above: CGFloat, top: CGFloat, hidden: Bool) -> CGFloat {
        if let field, let composer {
            let height = composer.bounds.height
            if let sendButton {
                // Composer: inside the field's pill at its right end, 38 × 40 (ChatScreen.tsx «Стикеры и эмодзи»).
                emojiButton.frame = CGRect(x: sendButton.frame.minX - ComposerPills.gap - ComposerExtras.emojiRoom, y: height - ComposerPills.side, width: ComposerExtras.emojiRoom, height: ComposerPills.side)
            }
            var frame = field.frame
            frame.size.width = max(0, emojiButton.frame.minX - 14 - frame.minX)
            field.frame = frame
        }
        emojiButton.isHidden = hidden
        // <Icon name={stickers ? 'keypad-outline' : 'happy-outline'} size={22}>, the accent while the panel is open.
        emojiButton.setImage(chatSymbol(panel == nil ? "ion:happy-outline" : "ion:keypad-outline", 22), for: .normal)
        emojiButton.tintColor = panel == nil ? Theme.muted : Theme.accent
        var next = above
        if !formatBar.isHidden && !hidden {
            formatBar.frame = CGRect(x: composerFrame.minX, y: above - 6 - FormatBar.height, width: composerFrame.width, height: FormatBar.height)
            next = formatBar.frame.minY
        }
        if !pill.isHidden {
            let size = pill.fitting()
            pill.frame = CGRect(x: view.bounds.width - 12 - size.width, y: top, width: size.width, height: size.height)
        }
        if let panel {
            let height = panelHeight(in: view)
            panel.frame = CGRect(x: 12, y: view.bounds.height - height - 10, width: view.bounds.width - 24, height: height)
        }
        return next
    }

    /// The emoji panel's height: the keyboard's last height (at least 250), or 300 before any keyboard.
    private func panelHeight(in view: UIView) -> CGFloat {
        let safe = view.safeAreaInsets.bottom
        return keyboardHeight > 0 ? max(250, keyboardHeight - safe) : 300
    }

    /// Where the composer must stand above while the emoji panel is open (nil: no panel).
    func panelTop(in view: UIView) -> CGFloat? {
        guard panel != nil else { return nil }
        return view.bounds.height - panelHeight(in: view) - 10
    }

    // MARK: The keyboard and the emoji panel

    @objc private func keyboardWillShow(_ note: Notification) {
        if let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue, frame.height > 0 { keyboardHeight = frame.height }
        keyboardShown = true
        // The keyboard came back: the panel gives way to it.
        if panel != nil { closeEmoji(animated: false) }
    }

    @objc private func keyboardWillHide() { keyboardShown = false }

    @objc private func toggleEmoji() {
        if panel != nil {
            // The keyboard replaces the panel.
            field?.becomeFirstResponder()
            return
        }
        guard let host else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        let made = EmojiPanel(frame: .zero)
        made.onPick = { [weak self] (emoji: String) -> Void in self?.insert(emoji) }
        made.onErase = { [weak self] in self?.eraseBack() }
        made.onClose = { [weak self] in self?.closeEmoji(animated: true) }
        panel = made
        host.view.addSubview(made)
        host.view.endEditing(true)
        onLayout?()
        host.view.layoutIfNeeded()
        made.appear()
    }

    func closeEmoji(animated: Bool) {
        guard let made = panel else { return }
        panel = nil
        if animated && !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.2, animations: { made.alpha = 0 }, completion: { _ in made.removeFromSuperview() })
        } else {
            made.removeFromSuperview()
        }
        onLayout?()
        if animated, let host { UIView.animate(withDuration: 0.25) { host.view.layoutIfNeeded() } }
    }

    /// The emoji goes in at the cursor, as if typed.
    private func insert(_ emoji: String) {
        // Like a key of the keyboard: it replaces the selection, and the field's delegate hears of it.
        field?.insertText(emoji)
    }

    /// «Стереть символ»: one character (a whole emoji) before the cursor.
    private func eraseBack() {
        guard let field else { return }
        let range = field.selectedRange
        if range.length > 0 || range.location > 0 { field.deleteBackward() }
    }

    // MARK: Sending with options

    @objc private func sendHeld(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, let host, canOffer?() ?? true else { return }
        let empty = (field?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard !empty else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        host.view.endEditing(true)
        closeEmoji(animated: false)
        let choices = [
            ChoiceSheet.Choice(symbol: "speaker.slash", label: "Отправить без звука", note: "Собеседник получит сообщение без звука и вибрации", run: { [weak self] in
                UISelectionFeedbackGenerator().selectionChanged()
                self?.onSend?(true, nil)
            }),
            ChoiceSheet.Choice(symbol: "clock", label: "Отправить позже", note: "Выбери день и время — сообщение уйдёт само", run: { [weak self] in
                self?.pickTime()
            }),
        ]
        host.present(ChoiceSheet(heading: "Отправить", choices: choices), animated: true)
    }

    /// «Отправить позже»: the picker opens once the first sheet is gone.
    private func pickTime() {
        guard let host else { return }
        let picker = SchedulePickerController()
        picker.onPick = { [weak self] (at: Date) -> Void in
            UISelectionFeedbackGenerator().selectionChanged()
            self?.onSend?(false, at)
        }
        host.present(picker, animated: true)
    }

    /// A message of this chat was handed to the server for later (the sample chat keeps it here).
    func scheduled(deliverAt: String, text: String, silent: Bool) {
        if messenger == nil {
            var item = ScheduledItem(["id": UUID().uuidString, "chatId": chatId, "clientId": UUID().uuidString, "deliverAt": deliverAt, "status": "scheduled", "createdAt": ScheduleModel.iso(Date())])
            item?.text = text
            item?.cryptoState = "decrypted"
            if silent { item?.meta = ["silent": true] }
            if let item { sampleScheduled.append(item) }
        }
        onSay?("Запланировано: " + ScheduleModel.formatDeliverAt(iso: deliverAt))
        showPill()
    }

    // MARK: The scheduled messages of the chat

    private var scheduledHere: [ScheduledItem] {
        guard let messenger else { return sampleScheduled }
        return ScheduledStore.of(messenger).items(chatId: chatId)
    }

    @objc private func scheduledChanged() { showPill() }

    private func showPill() {
        let list = scheduledHere
        let hidden = list.isEmpty
        pill.show(count: list.count, failed: list.contains { $0.failed })
        if pill.isHidden != hidden {
            pill.isHidden = hidden
            onLayout?()
        }
    }

    @objc private func openScheduled() {
        guard let host else { return }
        host.view.endEditing(true)
        let screen = ScheduledScreenController(store: messenger.map { ScheduledStore.of($0) }, chatId: chatId, peerName: peerName, samples: messenger == nil ? sampleScheduled : nil)
        host.present(screen, animated: true)
    }

    // MARK: Formatting

    /// The field's text changed: the styles move with it, and the field shows them.
    func textChanged(_ text: String) {
        if !entities.isEmpty { entities = ComposeRules.shift(entities, old: lastText, new: text) }
        lastText = text
        restyle()
        selectionChanged()
    }

    /// The selection changed: the bar shows over a selection, with the styles it already has.
    func selectionChanged() {
        guard let field else { return }
        let range = field.selectedRange
        let wanted = range.length > 0 && field.isFirstResponder
        if wanted { formatBar.show(active: ComposeRules.active(entities, start: range.location, end: range.location + range.length)) }
        if formatBar.isHidden == wanted {
            formatBar.isHidden = !wanted
            onLayout?()
        }
    }

    private func apply(_ type: String, url: String?) {
        guard let field else { return }
        let range = field.selectedRange
        guard range.length > 0 else { return }
        let text = field.text ?? ""
        if type == "clear" {
            entities = ComposeRules.clear(entities, text: text, start: range.location, end: range.location + range.length)
        } else {
            entities = ComposeRules.toggle(entities, text: text, start: range.location, end: range.location + range.length, type: type, url: url)
        }
        UISelectionFeedbackGenerator().selectionChanged()
        restyle()
        formatBar.show(active: ComposeRules.active(entities, start: range.location, end: range.location + range.length))
    }

    /// «Ссылка»: the address for the selected text.
    private func askLink() {
        guard let host, let field else { return }
        let range = field.selectedRange
        let alert = UIAlertController(title: "Ссылка", message: nil, preferredStyle: .alert)
        alert.addTextField { (input: UITextField) -> Void in
            input.placeholder = "https://"
            input.keyboardType = .URL
            input.autocapitalizationType = .none
            input.autocorrectionType = .no
            input.accessibilityLabel = "Адрес ссылки"
        }
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        alert.addAction(UIAlertAction(title: "Готово", style: .default, handler: { [weak self, weak alert] _ in
            guard let self, let typed = alert?.textFields?.first?.text else { return }
            guard let url = ComposeRules.linkAddress(typed) else {
                self.onSay?("Нужен адрес вида https://…")
                return
            }
            field.selectedRange = range
            self.apply("text_link", url: url)
        }))
        host.present(alert, animated: true)
    }

    /// Shows the styles in the field itself, without touching its text or the cursor.
    private func restyle() {
        guard let field, field.markedTextRange == nil else { return }
        // Plain text stays untouched until there is a style to show (and once more after the last one goes).
        if entities.isEmpty && !styled { return }
        styled = !entities.isEmpty
        let storage = field.textStorage
        let total = storage.length
        guard total > 0 else { return }
        let base = UIFont.systemFont(ofSize: 17)
        storage.beginEditing()
        storage.setAttributes([.font: base, .foregroundColor: Theme.text], range: NSRange(location: 0, length: total))
        for entity in entities {
            guard let type = entity["type"] as? String, let offset = (entity["offset"] as? NSNumber)?.intValue, let length = (entity["length"] as? NSNumber)?.intValue,
                  offset >= 0, length > 0, offset + length <= total else { continue }
            let range = NSRange(location: offset, length: length)
            switch type {
            case "bold": storage.addAttribute(.font, value: UIFont.systemFont(ofSize: 17, weight: .bold), range: range)
            case "italic": storage.addAttribute(.font, value: UIFont.italicSystemFont(ofSize: 17), range: range)
            case "underline": storage.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
            case "strikethrough": storage.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
            case "code", "pre": storage.addAttribute(.font, value: UIFont.monospacedSystemFont(ofSize: 16, weight: .regular), range: range)
            case "spoiler": storage.addAttribute(.backgroundColor, value: Theme.text.withAlphaComponent(0.18), range: range)
            case "quote": storage.addAttribute(.foregroundColor, value: Theme.muted, range: range)
            case "text_link":
                storage.addAttribute(.foregroundColor, value: Theme.accent, range: range)
                storage.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
            default: break
            }
        }
        storage.endEditing()
        field.typingAttributes = [.font: base, .foregroundColor: Theme.text]
    }

    /// What goes out of the field: the text trimmed, with its entities (nil: none).
    func compose(full: String) -> (text: String, entities: [[String: Any]]?) {
        ComposeRules.compose(full, entities: entities)
    }

    /// The field was emptied or given another text (an edit): its styles start again from `with`.
    func reset(text: String, with: [[String: Any]] = []) {
        entities = with
        lastText = text
        restyle()
        selectionChanged()
    }

    // MARK: The simulator check

    #if targetEnvironment(simulator)
    /// `-composerdemo silent|later|scheduled|emoji|format` with `-demo 1 -chat 1`: what the composer shows.
    private func simulatorSeed() {
        guard messenger == nil, let ask = UserDefaults.standard.string(forKey: "composerdemo") else { return }
        if ask == "scheduled" || ask == "list" { sampleScheduled = ScheduledScreenController.demoItems() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self, let host = self.host, let field = self.field else { return }
            switch ask {
            case "silent":
                field.text = "Буду через десять минут"
                field.delegate?.textViewDidChange?(field)
                self.onLayout?()
                let choices = [
                    ChoiceSheet.Choice(symbol: "speaker.slash", label: "Отправить без звука", note: "Собеседник получит сообщение без звука и вибрации", run: {}),
                    ChoiceSheet.Choice(symbol: "clock", label: "Отправить позже", note: "Выбери день и время — сообщение уйдёт само", run: {}),
                ]
                host.present(ChoiceSheet(heading: "Отправить", choices: choices), animated: false)
            case "later":
                host.present(SchedulePickerController(), animated: false)
            case "list":
                self.openScheduled()
            case "emoji":
                self.toggleEmoji()
            case "format":
                field.text = "Встреча завтра в десять, не опаздывай"
                field.delegate?.textViewDidChange?(field)
                field.becomeFirstResponder()
                field.selectedRange = NSRange(location: 0, length: 14)
                self.apply("bold", url: nil)
                field.selectedRange = NSRange(location: 15, length: 7)
                self.selectionChanged()
            default:
                break
            }
        }
    }
    #endif
}

/// The pill of a chat's scheduled messages: a clock and how many (red when one could not go out).
final class ScheduledPill: UIControl {
    private let glass = UIVisualEffectView(effect: nil)
    private let mark = UIImageView()
    private let countLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.isUserInteractionEnabled = false
        glass.clipsToBounds = true
        addSubview(glass)
        mark.contentMode = .center
        mark.isUserInteractionEnabled = false
        addSubview(mark)
        countLabel.font = .systemFont(ofSize: 13, weight: .bold)
        countLabel.isUserInteractionEnabled = false
        addSubview(countLabel)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    func show(count: Int, failed: Bool) {
        if glass.effect == nil { glass.effect = chatGlass() }
        let ink = failed ? Theme.danger : Theme.accent
        mark.image = chatSymbol("clock", 17)
        mark.tintColor = ink
        countLabel.text = "\(count)"
        countLabel.textColor = ink
        accessibilityLabel = "Отложенные сообщения: \(count)"
        setNeedsLayout()
    }

    func fitting() -> CGSize {
        let font: UIFont = countLabel.font ?? UIFont.systemFont(ofSize: 13)
        let words = ceil(((countLabel.text ?? "") as NSString).size(withAttributes: [.font: font]).width)
        return CGSize(width: 12 + 20 + 4 + words + 14, height: 36)
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        glass.layer.cornerRadius = bounds.height / 2
        mark.frame = CGRect(x: 12, y: 0, width: 20, height: bounds.height)
        countLabel.frame = CGRect(x: 36, y: 0, width: bounds.width - 36 - 10, height: bounds.height)
    }
}
