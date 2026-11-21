import UIKit

/// ChatsPlus: the «Избранное» screen (the reference's saved/SavedScreen.tsx): notes and saved messages, newest at
/// the bottom with a quiet day above each day, the search, a field for a new note, and by a long press: copy,
/// change (own notes), choose several, send on to a chat, open the file, delete. Notes are the person's own words,
/// so they stand at the right edge without a bubble (the owner's «open» look), the time after the last word.
final class SavedViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextViewDelegate {
    private enum Line {
        case day(String)
        case note([String: Any])
    }

    private let messenger: Messenger?
    private let saved: SavedMessages
    private let bar = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let back = UIButton(type: .system)
    private let tile = UIView()
    private let tileIcon = UIImageView()
    private let titleLabel = UILabel()
    private let countLabel = UILabel()
    private let searchButton = UIButton(type: .system)
    private let searchBox = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let searchField = UITextField()
    private let table = UITableView(frame: .zero, style: .plain)
    private let empty = EmptyStateView()
    private let notice = UILabel()
    private let composer = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let field = UITextView()
    private let placeholder = UILabel()
    private let send = UIButton(type: .system)
    private let editBanner = UILabel()
    private let editClose = UIButton(type: .system)
    private let selectCancel = UIButton(type: .system)
    private let selectCount = UILabel()
    private let selectDelete = UIButton(type: .system)

    private var lines: [Line] = []
    private var searching = false
    private var editingRow: [String: Any]?
    private var selection: Set<String>?
    private var noticeRun = 0
    private var keyboardHeight: CGFloat = 0

    init(messenger: Messenger?, saved: SavedMessages) {
        self.messenger = messenger
        self.saved = saved
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    private static func glass(_ view: UIVisualEffectView, radius: CGFloat) {
        view.effect = UIBlurEffect(style: Theme.dark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight)
        view.layer.cornerRadius = radius
        view.layer.cornerCurve = .continuous
        view.clipsToBounds = true
        view.layer.borderWidth = 1 / max(1, UIScreen.main.scale)
        view.layer.borderColor = Theme.veil(0.12).cgColor
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg

        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.showsVerticalScrollIndicator = false
        table.keyboardDismissMode = .interactive
        table.dataSource = self
        table.delegate = self
        table.estimatedRowHeight = 60
        table.rowHeight = UITableView.automaticDimension
        table.register(SavedNoteCell.self, forCellReuseIdentifier: "note")
        table.register(SavedDayCell.self, forCellReuseIdentifier: "day")
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.minimumPressDuration = 0.4
        table.addGestureRecognizer(hold)
        view.addSubview(table)
        empty.isHidden = true
        view.addSubview(empty)

        SavedViewController.glass(bar, radius: 27)
        view.addSubview(bar)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .semibold)), for: .normal)
        back.tintColor = Theme.text
        back.accessibilityLabel = "Назад к чатам"
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        bar.contentView.addSubview(back)
        tile.backgroundColor = Theme.accent
        tile.layer.cornerRadius = 16
        tile.layer.cornerCurve = .continuous
        bar.contentView.addSubview(tile)
        tileIcon.image = UIImage(systemName: "bookmark.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
        tileIcon.tintColor = Theme.onAccent
        tileIcon.contentMode = .center
        tile.addSubview(tileIcon)
        titleLabel.text = "Избранное"
        titleLabel.font = AppFont.text(16, .bold)
        titleLabel.textColor = Theme.text
        bar.contentView.addSubview(titleLabel)
        countLabel.font = AppFont.text(11)
        countLabel.textColor = Theme.muted
        bar.contentView.addSubview(countLabel)
        searchButton.tintColor = Theme.muted
        searchButton.addTarget(self, action: #selector(toggleSearch), for: .touchUpInside)
        bar.contentView.addSubview(searchButton)

        SavedViewController.glass(searchBox, radius: 22)
        searchBox.isHidden = true
        view.addSubview(searchBox)
        searchField.attributedPlaceholder = NSAttributedString(string: "Поиск в Избранном", attributes: [.foregroundColor: Theme.muted])
        searchField.font = AppFont.text(15)
        searchField.textColor = Theme.text
        searchField.tintColor = Theme.accent
        searchField.keyboardAppearance = Theme.dark ? .dark : .light
        searchField.clearButtonMode = .whileEditing
        let lens = UIImageView(image: UIImage(systemName: "magnifyingglass", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)))
        lens.tintColor = Theme.muted
        lens.contentMode = .center
        lens.frame = CGRect(x: 0, y: 0, width: 36, height: 46)
        searchField.leftView = lens
        searchField.leftViewMode = .always
        searchField.addTarget(self, action: #selector(queryChanged), for: .editingChanged)
        searchBox.contentView.addSubview(searchField)

        notice.font = AppFont.text(12)
        notice.textColor = Theme.accent
        notice.textAlignment = .center
        notice.backgroundColor = ThemeStore.look.accentSoft
        notice.layer.cornerRadius = 16
        notice.layer.masksToBounds = true
        notice.alpha = 0
        view.addSubview(notice)

        SavedViewController.glass(composer, radius: 28)
        view.addSubview(composer)
        field.backgroundColor = .clear
        field.font = AppFont.text(15)
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.keyboardAppearance = Theme.dark ? .dark : .light
        field.textContainerInset = UIEdgeInsets(top: 11, left: 2, bottom: 11, right: 2)
        field.delegate = self
        field.accessibilityLabel = "Заметка"
        composer.contentView.addSubview(field)
        placeholder.text = messenger == nil && !isSample ? "Заметки доступны в приложении" : "Заметка…"
        placeholder.font = AppFont.text(15)
        placeholder.textColor = Theme.muted
        composer.contentView.addSubview(placeholder)
        send.setImage(UIImage(systemName: "arrow.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .bold)), for: .normal)
        send.tintColor = Theme.onAccent
        send.backgroundColor = Theme.accent
        send.layer.cornerRadius = 22
        send.accessibilityLabel = "Сохранить заметку"
        send.addTarget(self, action: #selector(submit), for: .touchUpInside)
        composer.contentView.addSubview(send)
        editBanner.font = AppFont.text(12, .bold)
        editBanner.textColor = Theme.accent
        editBanner.text = "Редактирование заметки"
        editBanner.isHidden = true
        composer.contentView.addSubview(editBanner)
        editClose.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)), for: .normal)
        editClose.tintColor = Theme.muted
        editClose.accessibilityLabel = "Отменить редактирование"
        editClose.isHidden = true
        editClose.addTarget(self, action: #selector(stopEditing), for: .touchUpInside)
        composer.contentView.addSubview(editClose)
        selectCancel.setTitle("Отмена", for: .normal)
        selectCancel.titleLabel?.font = AppFont.text(16)
        selectCancel.tintColor = Theme.accent
        selectCancel.addTarget(self, action: #selector(stopSelecting), for: .touchUpInside)
        composer.contentView.addSubview(selectCancel)
        selectCount.font = AppFont.text(15, .semibold)
        selectCount.textColor = Theme.text
        selectCount.textAlignment = .center
        composer.contentView.addSubview(selectCount)
        selectDelete.setTitle(" Удалить", for: .normal)
        selectDelete.setImage(UIImage(systemName: "trash", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)), for: .normal)
        selectDelete.titleLabel?.font = AppFont.text(16)
        selectDelete.tintColor = Theme.danger
        selectDelete.accessibilityLabel = "Удалить выбранное"
        selectDelete.addTarget(self, action: #selector(deleteSelected), for: .touchUpInside)
        composer.contentView.addSubview(selectDelete)

        NotificationCenter.default.addObserver(self, selector: #selector(changed), name: SavedMessages.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        rebuild(scrollToNewest: true)
        refreshComposer()
        #if targetEnvironment(simulator)
        if UserDefaults.standard.string(forKey: "chatsdemo") == "savedsearch" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                guard let self else { return }
                self.toggleSearch()
                self.searchField.text = "адрес"
                self.searchField.resignFirstResponder()
                self.queryChanged()
            }
        }
        #endif
    }

    private var isSample: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, top = view.safeAreaInsets.top
        bar.frame = CGRect(x: 12, y: top + 12, width: width - 24, height: 70)
        back.frame = CGRect(x: 8, y: 13, width: 38, height: 43)
        tile.frame = CGRect(x: 50, y: 13, width: 43, height: 43)
        tileIcon.frame = tile.bounds
        searchButton.frame = CGRect(x: bar.bounds.width - 8 - 39, y: 13, width: 39, height: 43)
        titleLabel.frame = CGRect(x: 103, y: 15, width: searchButton.frame.minX - 111, height: 20)
        countLabel.frame = CGRect(x: 103, y: 37, width: searchButton.frame.minX - 111, height: 15)
        var y = bar.frame.maxY + 8
        searchBox.isHidden = !searching
        if searching {
            searchBox.frame = CGRect(x: 12, y: y, width: width - 24, height: 46)
            searchField.frame = CGRect(x: 4, y: 0, width: searchBox.bounds.width - 12, height: 46)
            y += 52
        }
        // The field grows with the text up to 136 pt, as the reference's composer.
        let bottomGap = max(view.safeAreaInsets.bottom, keyboardHeight) + 10
        let fieldWidth = width - 24 - 16 - 44 - 6
        let wanted = min(136, max(44, ceil(field.sizeThatFits(CGSize(width: fieldWidth, height: .greatestFiniteMagnitude)).height)))
        let banner: CGFloat = editingRow != nil && selection == nil ? 36 : 0
        let inner = selection != nil ? 44 : wanted
        let composerHeight = 16 + banner + inner
        composer.frame = CGRect(x: 12, y: view.bounds.height - bottomGap - composerHeight, width: width - 24, height: composerHeight)
        editBanner.frame = CGRect(x: 16, y: 8, width: composer.bounds.width - 70, height: 28)
        editClose.frame = CGRect(x: composer.bounds.width - 44, y: 4, width: 36, height: 36)
        field.frame = CGRect(x: 8, y: 8 + banner, width: fieldWidth, height: inner)
        placeholder.frame = CGRect(x: 15, y: 8 + banner, width: fieldWidth - 14, height: 44)
        send.frame = CGRect(x: composer.bounds.width - 8 - 44, y: composer.bounds.height - 8 - 44, width: 44, height: 44)
        selectCancel.frame = CGRect(x: 8, y: 8, width: 80, height: 44)
        selectDelete.frame = CGRect(x: composer.bounds.width - 8 - 110, y: 8, width: 110, height: 44)
        selectCount.frame = CGRect(x: 90, y: 8, width: composer.bounds.width - 200, height: 44)
        table.frame = CGRect(x: 0, y: y, width: width, height: max(0, composer.frame.minY - 5 - y))
        empty.frame = table.frame
        notice.frame = CGRect(x: (width - 200) / 2, y: y + 4, width: 200, height: 30)
    }

    @objc private func keyboardMoved(_ note: Notification) {
        guard isViewLoaded, let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let top = view.convert(frame, from: nil).minY
        keyboardHeight = max(0, view.bounds.height - top)
        view.setNeedsLayout()
        UIView.animate(withDuration: 0.25) { self.view.layoutIfNeeded() }
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        view.setNeedsLayout()
    }

    // MARK: The list

    private func rebuild(scrollToNewest: Bool) {
        let shown = searching ? SavedMessages.search(saved.items, searchField.text ?? "") : saved.items
        var next: [Line] = []
        var day = ""
        for item in shown {
            let words = Messenger.date(item["savedAt"] as? String).map { Messenger.dayWords($0) } ?? ""
            if words != day { day = words; next.append(.day(words)) }
            next.append(.note(item))
        }
        lines = next
        let count = saved.items.count
        countLabel.text = count > 0 ? "\(count) · только на этом устройстве" : "Хранится только на этом устройстве"
        searchButton.setImage(UIImage(systemName: searching ? "xmark" : "magnifyingglass", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular)), for: .normal)
        searchButton.tintColor = searching ? Theme.accent : Theme.muted
        searchButton.accessibilityLabel = searching ? "Закрыть поиск" : "Поиск в Избранном"
        table.reloadData()
        let nothing = shown.isEmpty && saved.loaded
        empty.isHidden = !nothing
        if nothing {
            if searching { empty.show(symbol: "magnifyingglass", title: "Ничего не найдено", words: "Попробуй другое слово.") }
            else { empty.show(symbol: "bookmark", title: "Здесь пока пусто", words: "Пиши заметки, сохраняй файлы и голосовые. Любое сообщение из чата можно отправить сюда через долгое нажатие → «В Избранное».") }
        }
        if !saved.error.isEmpty { flash(saved.error) }
        if scrollToNewest, !lines.isEmpty {
            table.layoutIfNeeded()
            table.scrollToRow(at: IndexPath(row: lines.count - 1, section: 0), at: .bottom, animated: false)
        }
    }

    @objc private func changed() { rebuild(scrollToNewest: false) }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { lines.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        guard indexPath.row < lines.count else { return UITableViewCell() }
        switch lines[indexPath.row] {
        case .day(let words):
            let cell = tableView.dequeueReusableCell(withIdentifier: "day", for: indexPath)
            (cell as? SavedDayCell)?.show(words)
            return cell
        case .note(let item):
            let cell = tableView.dequeueReusableCell(withIdentifier: "note", for: indexPath)
            let id = item["id"] as? String ?? ""
            (cell as? SavedNoteCell)?.show(item, own: ownName, checked: selection.map { $0.contains(id) })
            return cell
        }
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        guard indexPath.row < lines.count, case .note(let item) = lines[indexPath.row], let id = item["id"] as? String else { return }
        if var chosen = selection {
            if chosen.contains(id) { chosen.remove(id) } else { chosen.insert(id) }
            selection = chosen
            UISelectionFeedbackGenerator().selectionChanged()
            tableView.reloadRows(at: [indexPath], with: .none)
            refreshComposer()
            return
        }
        if let attachment = item["attachment"] as? [String: Any] { open(attachment) }
    }

    private var ownName: String { messenger?.user["displayName"] as? String ?? "" }

    // MARK: Menu

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, selection == nil, let path = table.indexPathForRow(at: recognizer.location(in: table)),
              path.row < lines.count, case .note(let item) = lines[path.row], presentedViewController == nil else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let text = item["text"] as? String ?? ""
        var choices: [ChoiceSheet.Choice] = []
        if !text.isEmpty {
            choices.append(ChoiceSheet.Choice(symbol: "doc.on.doc", label: "Скопировать текст", run: { [weak self] in
                UIPasteboard.general.string = text
                self?.flash("Скопировано")
            }))
        }
        if item["origin"] == nil, !text.isEmpty {
            choices.append(ChoiceSheet.Choice(symbol: "square.and.pencil", label: "Изменить", run: { [weak self] in self?.startEditing(item) }))
        }
        choices.append(ChoiceSheet.Choice(symbol: "checkmark.circle", label: "Выбрать", run: { [weak self] in
            guard let self, let id = item["id"] as? String else { return }
            self.selection = [id]
            self.table.reloadData()
            self.refreshComposer()
        }))
        choices.append(ChoiceSheet.Choice(symbol: "arrowshape.turn.up.right", label: "Переслать в чат", run: { [weak self] in self?.forward(item) }))
        if let attachment = item["attachment"] as? [String: Any] {
            choices.append(ChoiceSheet.Choice(symbol: "arrow.down.circle", label: ChatRowLooks.isVideoNote(attachment) ? "Сохранить видео" : "Сохранить файл", run: { [weak self] in self?.open(attachment) }))
        }
        choices.append(ChoiceSheet.Choice(symbol: "trash", label: "Удалить из Избранного", danger: true, run: { [weak self] in
            guard let self, let id = item["id"] as? String else { return }
            self.saved.remove(id) { [weak self] (failure: SavedMessages.Failure?) -> Void in if let failure { self?.flash(failure.words) } }
        }))
        let preview = text.isEmpty ? SavedMessages.line(item).text : String(text.prefix(120))
        present(ChoiceSheet(heading: "Избранное", note: preview, choices: choices), animated: true)
    }

    /// «Переслать в чат»: the same picker as in chats; the chat opens with the forward waiting above its field.
    private func forward(_ item: [String: Any]) {
        let picker = ForwardPickerController(messenger: messenger, count: 1)
        let author = (item["origin"] as? [String: Any])?["author"] as? String ?? ownName
        var message: [String: Any] = ["text": item["text"] as? String ?? "", "senderId": messenger?.userId ?? ""]
        if let attachment = item["attachment"] as? [String: Any] { message["attachment"] = attachment }
        picker.onPick = { [weak self] (target: ForwardPickerController.Target) -> Void in
            guard let self else { return }
            guard let messenger = self.messenger else { self.flash("Переслано: " + target.name); return }
            ForwardDraft.put(chatId: target.chatId, items: [ForwardDraft.Item(message: message, author: author.isEmpty ? "Я" : author)])
            guard let stack = self.navigationController, let first = stack.viewControllers.first else { return }
            let screen = ChatViewController(name: target.name, messenger: messenger, chatId: target.chatId, peerId: target.peerId)
            if let summary = target.summary {
                screen.peerLastRead = summary.peerLastRead
                screen.actions.opened(summary)
            }
            stack.setViewControllers([first, screen], animated: true)
        }
        present(picker, animated: true)
    }

    /// A photo opens in the viewer, any other file in the system's preview (Attachments/ChatAttachments.swift does
    /// the same for a chat).
    private func open(_ attachment: [String: Any]) {
        let about = FileCore.describe(attachment)
        if let refusal = about.refusal { flash(refusal); return }
        guard let messenger, let cipherSize = about.cipherSize else { return }
        let load = AttachmentLoad(server: messenger.server, attachment: attachment, cipherSize: cipherSize)
        view.endEditing(true)
        if about.kind == "photo" {
            let small = ((attachment["preview"] as? [String: Any])?["base64"] as? String).flatMap { Data(base64Encoded: $0) }.flatMap { UIImage(data: $0) }
            present(PhotoViewer(small: small, load: load), animated: true)
        } else {
            present(FileOpenController(title: attachment["name"] as? String ?? "Файл", fileName: about.fileName, load: load, presenter: self), animated: true)
        }
    }

    // MARK: Writing

    func textViewDidChange(_ textView: UITextView) {
        if textView.text.count > SavedMessages.textLimit { textView.text = String(textView.text.prefix(SavedMessages.textLimit)) }
        refreshComposer()
        view.setNeedsLayout()
    }

    private func refreshComposer() {
        let choosing = selection != nil
        field.isHidden = choosing
        placeholder.isHidden = choosing || !field.text.isEmpty
        send.isHidden = choosing
        let ready = !field.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (messenger != nil || isSample)
        send.isEnabled = ready
        send.alpha = ready ? 1 : 0.4
        send.setImage(UIImage(systemName: editingRow != nil ? "checkmark" : "arrow.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .bold)), for: .normal)
        send.accessibilityLabel = editingRow != nil ? "Сохранить изменения" : "Сохранить заметку"
        editBanner.isHidden = editingRow == nil || choosing
        editClose.isHidden = editingRow == nil || choosing
        selectCancel.isHidden = !choosing
        selectCount.isHidden = !choosing
        selectDelete.isHidden = !choosing
        selectCount.text = "Выбрано: \(selection?.count ?? 0)"
        selectDelete.isEnabled = (selection?.count ?? 0) > 0
        selectDelete.alpha = selectDelete.isEnabled ? 1 : 0.4
        view.setNeedsLayout()
    }

    @objc private func submit() {
        let value = field.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        if let editingRow, let id = editingRow["id"] as? String {
            saved.edit(id, text: value) { [weak self] (failure: SavedMessages.Failure?) -> Void in
                guard let self else { return }
                if let failure { self.flash(failure.words); return }
                self.editingRow = nil
                self.field.text = ""
                self.refreshComposer()
            }
            return
        }
        saved.save(text: value, attachment: nil) { [weak self] (result: Result<Bool, SavedMessages.Failure>) -> Void in
            guard let self else { return }
            switch result {
            case .failure(let failure): self.flash(failure.words)
            case .success:
                self.field.text = ""
                self.refreshComposer()
                self.rebuild(scrollToNewest: true)
            }
        }
    }

    private func startEditing(_ item: [String: Any]) {
        editingRow = item
        field.text = item["text"] as? String ?? ""
        refreshComposer()
        field.becomeFirstResponder()
    }

    @objc private func stopEditing() {
        editingRow = nil
        field.text = ""
        refreshComposer()
    }

    @objc private func stopSelecting() {
        selection = nil
        table.reloadData()
        refreshComposer()
    }

    @objc private func deleteSelected() {
        guard let ids = selection, !ids.isEmpty else { return }
        selection = nil
        saved.remove(ids) { [weak self] (failure: SavedMessages.Failure?) -> Void in if let failure { self?.flash(failure.words) } }
        refreshComposer()
    }

    // MARK: Search, notices, back

    @objc private func toggleSearch() {
        searching.toggle()
        searchField.text = ""
        if searching { searchField.becomeFirstResponder() } else { searchField.resignFirstResponder() }
        rebuild(scrollToNewest: true)
        view.setNeedsLayout()
    }

    @objc private func queryChanged() { rebuild(scrollToNewest: true) }

    private func flash(_ words: String) {
        noticeRun += 1
        let run = noticeRun
        notice.text = words
        notice.frame.size.width = min(view.bounds.width - 40, ceil(notice.sizeThatFits(CGSize(width: 400, height: 30)).width) + 28)
        notice.center.x = view.bounds.midX
        UIView.animate(withDuration: 0.18) { self.notice.alpha = 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { [weak self] in
            guard let self, run == self.noticeRun else { return }
            UIView.animate(withDuration: 0.25) { self.notice.alpha = 0 }
        }
    }

    @objc private func goBack() { navigationController?.popViewController(animated: true) }
}

/// The quiet day above the notes of one day.
final class SavedDayCell: UITableViewCell {
    private let pill = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        pill.font = AppFont.text(10, .semibold)
        pill.textColor = Theme.muted
        pill.textAlignment = .center
        pill.backgroundColor = Theme.veil(0.07)
        pill.layer.cornerRadius = 14
        pill.layer.masksToBounds = true
        contentView.addSubview(pill)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ words: String) {
        pill.text = words
        setNeedsLayout()
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { CGSize(width: size.width, height: 57) }

    override func systemLayoutSizeFitting(_ targetSize: CGSize, withHorizontalFittingPriority horizontalFittingPriority: UILayoutPriority, verticalFittingPriority: UILayoutPriority) -> CGSize {
        CGSize(width: targetSize.width, height: 57)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = ceil(pill.sizeThatFits(CGSize(width: 300, height: 28)).width) + 28
        pill.frame = CGRect(x: (contentView.bounds.width - width) / 2, y: 15, width: width, height: 28)
    }
}

/// One note at the right edge: where it came from, its file, its words, and the time after the last word.
final class SavedNoteCell: UITableViewCell {
    private let check = UIImageView()
    private let origin = UILabel()
    private let file = UILabel()
    private let body = UILabel()
    private var checked: Bool?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        check.contentMode = .center
        contentView.addSubview(check)
        origin.font = AppFont.text(11, .semibold)
        origin.textColor = Theme.accent
        origin.textAlignment = .right
        contentView.addSubview(origin)
        file.font = AppFont.text(14, .medium)
        file.textColor = Theme.accent
        file.textAlignment = .right
        file.numberOfLines = 1
        file.lineBreakMode = .byTruncatingMiddle
        contentView.addSubview(file)
        body.numberOfLines = 0
        body.textAlignment = .right
        contentView.addSubview(body)
    }

    required init?(coder: NSCoder) { return nil }

    private static let clock: DateFormatter = {
        let format = DateFormatter()
        format.locale = Locale(identifier: "ru_RU")
        format.dateFormat = "HH:mm"
        return format
    }()

    func show(_ item: [String: Any], own: String, checked: Bool?) {
        self.checked = checked
        check.isHidden = checked == nil
        check.image = UIImage(systemName: checked == true ? "checkmark.circle.fill" : "circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 21, weight: .regular))
        check.tintColor = checked == true ? Theme.accent : Theme.subtle
        if let from = item["origin"] as? [String: Any] {
            let author = from["author"] as? String ?? ""
            let day = Messenger.date(from["sentAt"] as? String).map { Messenger.dayWords($0) } ?? ""
            origin.text = (author == own && !own.isEmpty ? "Твоё сообщение" : "От " + author) + (day.isEmpty ? "" : " · " + day)
        } else {
            origin.text = nil
        }
        if let attachment = item["attachment"] as? [String: Any] {
            let line = ChatRowLooks.attachmentLine(attachment)
            file.text = (line.icon == "mic" ? "🎤 " : "") + line.text
        } else {
            file.text = nil
        }
        let time = (item["editedAt"] != nil ? "изм. " : "") + (Messenger.date(item["savedAt"] as? String).map { SavedNoteCell.clock.string(from: $0) } ?? "")
        let text = item["text"] as? String ?? ""
        let words = NSMutableAttributedString(string: text, attributes: [.font: AppFont.text(16), .foregroundColor: Theme.text])
        // The open look: the time stands after the last word, small and quiet.
        words.append(NSAttributedString(string: (text.isEmpty ? "" : "  ") + time, attributes: [.font: AppFont.text(10), .foregroundColor: Theme.muted]))
        body.attributedText = words
        accessibilityLabel = (text.isEmpty ? (file.text ?? "Запись") : text) + ", " + time
        setNeedsLayout()
    }

    private func frames(width: CGFloat) -> (origin: CGRect, file: CGRect, body: CGRect, height: CGFloat) {
        let left: CGFloat = checked == nil ? 15 : 45
        let room = (width - left - 15) * 0.85
        let right = width - 15
        var y: CGFloat = 4
        var originBox = CGRect.zero, fileBox = CGRect.zero
        if origin.text != nil {
            originBox = CGRect(x: right - room, y: y, width: room, height: 16)
            y += 20
        }
        if file.text != nil {
            fileBox = CGRect(x: right - room, y: y, width: room, height: 20)
            y += 24
        }
        let size = body.sizeThatFits(CGSize(width: room, height: .greatestFiniteMagnitude))
        let bodyBox = CGRect(x: right - room, y: y, width: room, height: ceil(size.height))
        return (originBox, fileBox, bodyBox, bodyBox.maxY + 10)
    }

    override func systemLayoutSizeFitting(_ targetSize: CGSize, withHorizontalFittingPriority horizontalFittingPriority: UILayoutPriority, verticalFittingPriority: UILayoutPriority) -> CGSize {
        CGSize(width: targetSize.width, height: frames(width: targetSize.width).height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let laid = frames(width: contentView.bounds.width)
        origin.frame = laid.origin
        file.frame = laid.file
        body.frame = laid.body
        check.frame = CGRect(x: 10, y: (contentView.bounds.height - 30) / 2, width: 30, height: 30)
    }
}
