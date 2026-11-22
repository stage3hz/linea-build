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
    // SavedScreen.tsx IconButtons: rounds of clear glass with the reference's Ionicons glyphs (Design/GlassKit.swift).
    private let back = GlassRoundButton(symbol: "ion:chevron-back", label: "Назад к чатам", iconSize: 23)
    private let tile = UIView()
    private let tileIcon = UIImageView()
    private let titleLabel = UILabel()
    private let countLabel = UILabel()
    private let searchButton = GlassRoundButton(symbol: "ion:search-outline", label: "Поиск в Избранном", iconSize: 23)
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
    private let editClose = GlassRoundButton(symbol: "ion:close", label: "Отменить редактирование", iconSize: 18, side: 36)
    private let selectCancel = UIButton(type: .system)
    private let selectCount = UILabel()
    private let selectDelete = UIButton(type: .system)
    /// ChatsPlus: photos, files, voice notes and round videos in «Избранное» (SavedAttach.swift).
    private lazy var attach = SavedAttach(messenger: messenger, saved: saved)
    private let clip = GlassRoundButton(symbol: "ion:add", label: "Сохранить фото, видео или файл", iconSize: 23)

    private var lines: [Line] = []
    private var searching = false
    private var editingRow: [String: Any]?
    private var selection: Set<String>?
    private var noticeRun = 0
    private var keyboardHeight: CGFloat = 0
    /// Voice messages and round videos play here as in a chat (Voice/VoicePlayer.swift, Video/NotePlayback.swift).
    private lazy var voice = VoicePlayer(server: messenger?.server)
    private var notes: NotePlayback?
    private var mediaState: MsgMediaState?
    private var watch: Timer?
    private let hold = UILongPressGestureRecognizer()

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
        // SavedScreen.tsx: the list's content stands 14 pt in from the top and the bottom.
        table.contentInset = UIEdgeInsets(top: 14, left: 0, bottom: 14, right: 0)
        table.rowHeight = UITableView.automaticDimension
        table.register(SavedNoteCell.self, forCellReuseIdentifier: "note")
        table.register(SavedDayCell.self, forCellReuseIdentifier: "day")
        hold.addTarget(self, action: #selector(held(_:)))
        hold.minimumPressDuration = 0.4
        table.addGestureRecognizer(hold)
        view.addSubview(table)
        empty.isHidden = true
        view.addSubview(empty)

        SavedViewController.glass(bar, radius: 27)
        view.addSubview(bar)
        back.onPress = { [weak self] in self?.goBack() }
        bar.contentView.addSubview(back)
        tile.backgroundColor = Theme.accent
        tile.layer.cornerRadius = 16
        tile.layer.cornerCurve = .continuous
        bar.contentView.addSubview(tile)
        tileIcon.image = IonIcon.image("bookmark", size: 21).withRenderingMode(.alwaysTemplate)
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
        searchButton.setTint(Theme.muted)
        searchButton.onPress = { [weak self] in self?.toggleSearch() }
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
        let lens = UIImageView(image: IonIcon.image("search-outline", size: 18).withRenderingMode(.alwaysTemplate))
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
        send.setImage(IonIcon.image("arrow-up", size: 23).withRenderingMode(.alwaysTemplate), for: .normal)
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
        editClose.setTint(Theme.muted)
        editClose.isHidden = true
        editClose.onPress = { [weak self] in self?.stopEditing() }
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
        selectDelete.setImage(IonIcon.image("trash-outline", size: 19).withRenderingMode(.alwaysTemplate), for: .normal)
        selectDelete.titleLabel?.font = AppFont.text(16)
        selectDelete.tintColor = Theme.danger
        selectDelete.accessibilityLabel = "Удалить выбранное"
        selectDelete.addTarget(self, action: #selector(deleteSelected), for: .touchUpInside)
        composer.contentView.addSubview(selectDelete)
        // SavedScreen.tsx: «add» in the accent at the left of the field, the record button where «Сохранить» stands.
        clip.setTint(Theme.accent)
        clip.onPress = { [weak self] in self?.attachTapped() }
        composer.contentView.addSubview(clip)
        attach.install(host: self, composer: composer.contentView)
        // Record: the «add» button and the field give way to a take and its preview.
        attach.control.clipView = clip
        attach.control.fieldViews = [field, placeholder]
        attach.say = { [weak self] (words: String) -> Void in self?.flash(words) }
        attach.onBusy = { [weak self] (busy: Bool) -> Void in
            self?.clip.isEnabled = !busy
            self?.refreshComposer()
        }

        installPlayers()
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

    // MARK: Voice messages and round videos

    private func installPlayers() {
        let made = NotePlayback(server: messenger?.server, host: { [weak self] (key: String) -> (view: UIView, frame: CGRect)? in
            self?.noteHost(key)
        }, keys: { [weak self] () -> [String] in
            self?.visibleKeys() ?? []
        })
        notes = made
        voice.onState = { [weak self] (state: MsgMediaState?) -> Void in self?.setMediaState(state) }
        voice.onProblem = { [weak self] (words: String) -> Void in self?.flash(words) }
        voice.onWillPlay = { [weak self] in self?.notes?.quiet() }
        made.onState = { [weak self] (state: MsgMediaState?) -> Void in self?.setMediaState(state) }
        made.onProblem = { [weak self] (words: String) -> Void in self?.flash(words) }
        made.onWillPlay = { [weak self] in self?.voice.pause() }
        made.holdsSilence = { [weak self] () -> Bool in
            guard let self else { return true }
            return self.attach.isRecording || self.voice.isPlaying || self.presentedViewController != nil
        }
        made.onReadyChanged = { [weak self] (key: String) -> Void in self?.redraw(key) }
    }

    /// The cell of a note on screen, by its key.
    private func noteCell(_ key: String) -> SavedNoteCell? {
        for case let cell as SavedNoteCell in table.visibleCells where cell.canvas.key == key { return cell }
        return nil
    }

    private func noteHost(_ key: String) -> (view: UIView, frame: CGRect)? {
        guard let cell = noteCell(key), cell.canvas.noteBox != .zero else { return nil }
        return (cell.canvas, cell.canvas.noteBox)
    }

    private func visibleKeys() -> [String] {
        table.visibleCells.compactMap { ($0 as? SavedNoteCell)?.canvas.key }
    }

    private func redraw(_ key: String) {
        noteCell(key)?.redraw(state: mediaState?.key == key ? mediaState : nil)
    }

    private func setMediaState(_ next: MsgMediaState?) {
        if next == mediaState { return }
        let keys = [mediaState?.key, next?.key]
        mediaState = next
        for case let cell as SavedNoteCell in table.visibleCells where keys.contains(cell.canvas.key) {
            cell.redraw(state: next?.key == cell.canvas.key ? next : nil)
        }
    }

    /// The width a round video may take: 85 % of the list without its 15 pt sides (SavedScreen.tsx `maxSide`).
    private var noteRoom: CGFloat { floor((table.bounds.width - 30) * 0.85) }

    /// A part of a note was touched: the voice message's button or waveform (start / pause — never a seek, the
    /// owner's rule), its speed, a round video (with sound / pause), a file's card (open).
    private func partPressed(_ item: [String: Any], part: String) {
        guard let attachment = item["attachment"] as? [String: Any] else { return }
        let key = SavedNoteCell.key(item)
        switch part {
        case "rate": flash(voice.cycleRate())
        case "play", "wave": voice.toggle(key: key, attachment: attachment)
        case "thumb": notes?.toggle(key: key, attachment: attachment)
        case "card": open(attachment)
        default: break
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        watch?.invalidate()
        // Round videos on screen loop silently, as in a chat (ChatMedia.appeared).
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.notes?.refresh() }
        RunLoop.main.add(timer, forMode: .common)
        watch = timer
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        watch?.invalidate()
        watch = nil
        if isMovingFromParent || navigationController == nil {
            attach.left() // Record: a take is called off, a preview thrown away
            voice.left()
            notes?.left()
        } else {
            voice.pause()
            notes?.rest()
        }
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
        // ChatsPlus: the paperclip takes room at the left; the record button stands where «Сохранить» is.
        // SavedScreen.tsx: 8 inside the glass, the 44 pt «add», 6 to the field.
        clip.frame = CGRect(x: 8, y: composer.bounds.height - 8 - 44, width: 44, height: 44)
        if !clip.isHidden {
            field.frame = CGRect(x: field.frame.minX + 50, y: field.frame.minY, width: field.frame.width - 50, height: field.frame.height)
            placeholder.frame = CGRect(x: placeholder.frame.minX + 50, y: placeholder.frame.minY, width: placeholder.frame.width - 50, height: placeholder.frame.height)
        }
        // Record: the take's dot, time and «slide to cancel» fill the glass up to the button; the preview starts
        // after the trash, which stands in the «add» button's place.
        let row = CGRect(x: 0, y: 0, width: composer.bounds.width - 8 - 44 - 6, height: composer.bounds.height - 10)
        let previewRow = CGRect(x: clip.frame.maxX + 6, y: row.minY, width: max(0, row.width - clip.frame.maxX - 6), height: row.height)
        attach.control.place(button: send.frame, field: attach.control.phase == .preview ? previewRow : row, trash: clip.frame)
        attach.layoutRecording()
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
        searchButton.setSymbol(searching ? "ion:close" : "ion:search-outline", size: 23)
        searchButton.setTint(searching ? Theme.accent : Theme.muted)
        searchButton.accessibilityLabel = searching ? "Закрыть поиск" : "Поиск в Избранном"
        table.reloadData()
        let nothing = shown.isEmpty && saved.loaded
        empty.isHidden = !nothing
        if nothing {
            if searching { empty.show(symbol: "ion:search-outline", title: "Ничего не найдено", words: "Попробуй другое слово.") }
            else { empty.show(symbol: "ion:bookmark-outline", title: "Здесь пока пусто", words: "Пиши заметки, сохраняй файлы и голосовые. Любое сообщение из чата можно отправить сюда через долгое нажатие → «В Избранное».") }
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
            if let note = cell as? SavedNoteCell {
                let key = SavedNoteCell.key(item)
                note.show(item, own: ownName, checked: selection.map { $0.contains(id) }, state: mediaState?.key == key ? mediaState : nil, maxSide: noteRoom)
                note.tapWaits(for: hold)
                note.onPart = { [weak self] (part: String) -> Void in self?.partPressed(item, part: part) }
            }
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
        // SavedScreen.tsx: outside «Выбрать» a note itself takes no tap; its attachment has its own controls.
    }

    private var ownName: String { messenger?.user["displayName"] as? String ?? "" }

    // MARK: Menu

    /// SavedScreen.tsx: the same menu as in chats (ContextMenu over the note, `mine`), with the note's words or
    /// its attachment as the preview: «Скопировать текст», «Изменить», «Выбрать», «Переслать в чат»,
    /// «Сохранить видео» / «Сохранить файл» (the share sheet, `shareEncryptedAttachment`), «Удалить из Избранного».
    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, selection == nil, let path = table.indexPathForRow(at: recognizer.location(in: table)),
              path.row < lines.count, case .note(let item) = lines[path.row], presentedViewController == nil else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let text = item["text"] as? String ?? ""
        var items: [MessageMenuController.Item] = []
        if !text.isEmpty {
            items.append(MessageMenuController.Item(symbol: "doc.on.doc", label: "Скопировать текст", run: { [weak self] in
                UIPasteboard.general.string = text
                self?.flash("Скопировано")
            }))
        }
        if item["origin"] == nil, !text.isEmpty {
            items.append(MessageMenuController.Item(symbol: "square.and.pencil", label: "Изменить", run: { [weak self] in self?.startEditing(item) }))
        }
        items.append(MessageMenuController.Item(symbol: "checkmark.circle", label: "Выбрать", run: { [weak self] in
            guard let self, let id = item["id"] as? String else { return }
            self.selection = [id]
            self.table.reloadData()
            self.refreshComposer()
        }))
        items.append(MessageMenuController.Item(symbol: "arrowshape.turn.up.right", label: "Переслать в чат", run: { [weak self] in self?.forward(item) }))
        if let attachment = item["attachment"] as? [String: Any] {
            items.append(MessageMenuController.Item(symbol: "square.and.arrow.down", label: ChatRowLooks.isVideoNote(attachment) ? "Сохранить видео" : "Сохранить файл", run: { [weak self] in
                guard let self, let messenger = self.messenger else { return }
                MediaSave.share(attachment, messenger: messenger, from: self, say: { [weak self] (words: String, _: Bool) -> Void in self?.flash(words) })
            }))
        }
        items.append(MessageMenuController.Item(symbol: "trash", label: "Удалить из Избранного", danger: true, separated: true, run: { [weak self] in
            guard let self, let id = item["id"] as? String else { return }
            self.saved.remove(id) { [weak self] (failure: SavedMessages.Failure?) -> Void in if let failure { self?.flash(failure.words) } }
        }))
        let preview = text.isEmpty ? SavedMessages.line(item).text : text
        view.endEditing(true)
        present(MessageMenuController(anchorY: recognizer.location(in: nil).y, mine: true, preview: preview, reactions: [], items: items), animated: true)
    }

    /// «Переслать в чат»: the same picker as in chats; the chat opens with the forward waiting above its field.
    private func forward(_ item: [String: Any]) {
        // Composer: as the reference's SavedScreen — «Избранное» is left out of the list, a tap sends at once,
        // «Выбрать» sends to several chats with the comment first.
        let picker = ForwardPickerController(messenger: messenger, count: 1, hideSaved: true)
        let author = (item["origin"] as? [String: Any])?["author"] as? String ?? ownName
        var message: [String: Any] = ["text": item["text"] as? String ?? "", "senderId": messenger?.userId ?? ""]
        if let attachment = item["attachment"] as? [String: Any] { message["attachment"] = attachment }
        let items = [ForwardDraft.Item(message: message, author: author.isEmpty ? "Я" : author)]
        let send: ([ForwardPickerController.Target], String) -> Void = { [weak self] (targets: [ForwardPickerController.Target], comment: String) -> Void in
            guard let self else { return }
            guard let messenger = self.messenger else { self.flash(ChatForward.notice(targets)); return }
            ChatForward.sendMany(messenger: messenger, targets: targets, comment: comment, items: items) { [weak self] (problem: String?) -> Void in
                self?.flash(problem ?? ChatForward.notice(targets))
            }
        }
        picker.onPick = { (target: ForwardPickerController.Target) -> Void in send([target], "") }
        picker.onSendMany = send
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
        send.setImage(IonIcon.image(editingRow != nil ? "checkmark" : "arrow-up", size: 23).withRenderingMode(.alwaysTemplate), for: .normal)
        // ChatsPlus: with an empty field the microphone stands there instead (not while changing a note or choosing).
        let canRecord = field.text.isEmpty && editingRow == nil && !choosing && (messenger != nil || isSample) && !attach.busy
        attach.control.setVisible(canRecord)
        if canRecord || attach.control.isBusy { send.isHidden = true }
        clip.isHidden = choosing || editingRow != nil
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

    /// ChatsPlus: the paperclip — «Фото» or «Файл».
    @objc private func attachTapped() {
        view.endEditing(true)
        attach.openMenu()
    }
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
        // SavedScreen.tsx: t.glass on a dark theme, white at 0.52 on a light one.
        pill.backgroundColor = Theme.dark ? ThemeStore.look.glass : UIColor(white: 1, alpha: 0.52)
        pill.layer.cornerRadius = 14
        pill.layer.masksToBounds = true
        contentView.addSubview(pill)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ words: String) {
        pill.text = words
        setNeedsLayout()
    }

    /// 15 above, 6 × 14 inside, 14 below (SavedScreen.tsx).
    private var pillHeight: CGFloat { ceil(pill.font.lineHeight) + 12 }

    override func sizeThatFits(_ size: CGSize) -> CGSize { CGSize(width: size.width, height: 15 + pillHeight + 14) }

    override func systemLayoutSizeFitting(_ targetSize: CGSize, withHorizontalFittingPriority horizontalFittingPriority: UILayoutPriority, verticalFittingPriority: UILayoutPriority) -> CGSize {
        CGSize(width: targetSize.width, height: 15 + pillHeight + 14)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = ceil(pill.sizeThatFits(CGSize(width: 300, height: 28)).width) + 28
        pill.frame = CGRect(x: (contentView.bounds.width - width) / 2, y: 15, width: width, height: pillHeight)
    }
}

/// One note at the right edge, drawn as the reference's SavedScreen.tsx row: where it came from, its attachment
/// exactly as a chat draws it (VoiceBubble, VideoNoteBubble, AttachmentCard), its words and the time. A round video
/// with no words and no origin stands alone with the time in a pill under it (`circleOnly`). The owner's open look:
/// no plate unless bubbles are chosen in «Оформление» (then the reference's plate: radius 23, 8 at the lower right).
final class SavedNoteCell: UITableViewCell {
    /// The key a note's attachment is known by (AttachmentStore, the players).
    static func key(_ item: [String: Any]) -> String { "saved:" + (item["id"] as? String ?? "") }

    private let check = UIImageView()
    let canvas = SavedNoteCanvas()
    private var checked: Bool?
    /// A part of the note was touched: "play", "wave", "rate", "thumb" (a round video) or "card".
    var onPart: ((String) -> Void)?
    private let tap = UITapGestureRecognizer()
    private weak var waitsFor: UIGestureRecognizer?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        check.contentMode = .center
        contentView.addSubview(check)
        contentView.addSubview(canvas)
        tap.addTarget(self, action: #selector(tapped(_:)))
        canvas.addGestureRecognizer(tap)
    }

    required init?(coder: NSCoder) { return nil }

    /// A tap waits until the list's long press has failed, so a hold never also plays.
    func tapWaits(for hold: UIGestureRecognizer) {
        guard waitsFor !== hold else { return }
        waitsFor = hold
        tap.require(toFail: hold)
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        guard checked == nil, let part = canvas.part(at: recognizer.location(in: canvas)) else { return }
        onPart?(part)
    }

    func show(_ item: [String: Any], own: String, checked: Bool?, state: MsgMediaState?, maxSide: CGFloat) {
        // A circle playing in place belongs to one note; a cell given to another note lets it go.
        if canvas.key != SavedNoteCell.key(item) { canvas.subviews.forEach { $0.removeFromSuperview() } }
        self.checked = checked
        check.isHidden = checked == nil
        // SavedScreen.tsx: checkmark-circle / ellipse-outline, 24 pt, accent / subtle.
        check.image = IonIcon.image(checked == true ? "checkmark-circle" : "ellipse-outline", size: 24).withRenderingMode(.alwaysTemplate)
        check.tintColor = checked == true ? Theme.accent : Theme.subtle
        canvas.isUserInteractionEnabled = checked == nil
        canvas.show(item, own: own, state: state, maxSide: maxSide)
        accessibilityLabel = canvas.spoken
        setNeedsLayout()
    }

    func redraw(state: MsgMediaState?) {
        canvas.state = state
        canvas.setNeedsDisplay()
    }

    private var left: CGFloat { checked == nil ? 15 : 45 }

    override func systemLayoutSizeFitting(_ targetSize: CGSize, withHorizontalFittingPriority horizontalFittingPriority: UILayoutPriority, verticalFittingPriority: UILayoutPriority) -> CGSize {
        let laid = canvas.measure(room: (targetSize.width - left - 15) * 0.85)
        return CGSize(width: targetSize.width, height: laid.box.height + 8)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let room = (contentView.bounds.width - left - 15) * 0.85
        let laid = canvas.measure(room: room)
        canvas.frame = CGRect(x: contentView.bounds.width - 15 - laid.box.width, y: 0, width: laid.box.width, height: laid.box.height)
        check.frame = CGRect(x: 15, y: (contentView.bounds.height - 30) / 2, width: 30, height: 30)
    }
}

/// The drawing of one note of «Избранное» (see SavedNoteCell).
final class SavedNoteCanvas: UIView {
    struct Laid {
        var box = CGSize.zero
        var inset: CGFloat = 0
        var origin = CGRect.zero
        var media = CGRect.zero
        var text = CGRect.zero
        var time = CGRect.zero
        var timeInline = false
    }

    private(set) var key = ""
    private var item: [String: Any] = [:]
    private var originWords = ""
    private var words = ""
    private var timeWords = ""
    private var edited = false
    /// "voice", "note", "card" or "" (no attachment).
    private(set) var kind = ""
    private var fileKind = "file"
    private var attachment: [String: Any] = [:]
    private var poster: UIImage?
    private var posterOf = ""
    private var maxSide: CGFloat = 212
    var state: MsgMediaState?
    private var laid = Laid()
    private var laidFor: CGFloat = -1
    private var lastRoom: CGFloat = 0
    private var boxes = MsgMediaBoxes()
    private(set) var spoken = ""

    private static let originFont = UIFont.systemFont(ofSize: 11, weight: .semibold)
    private static let timeFont = UIFont.systemFont(ofSize: 9)
    private static let pillFont = UIFont.systemFont(ofSize: 11)
    private static let clock: DateFormatter = {
        let format = DateFormatter()
        format.locale = Locale(identifier: "ru_RU")
        format.dateFormat = "HH:mm"
        return format
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { return nil }

    /// chatPreferences.ts TEXT_SIZES: the size of message text and its line.
    private static var textMetrics: (size: CGFloat, line: CGFloat) {
        let size = ThemeStore.textSize
        switch size {
        case ..<16: return (15, 20)
        case ..<18: return (17, 22)
        case ..<20: return (19, 25)
        default: return (22, 28)
        }
    }

    private var textAttributes: [NSAttributedString.Key: Any] {
        let metrics = SavedNoteCanvas.textMetrics
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = metrics.line
        style.maximumLineHeight = metrics.line
        style.lineBreakMode = .byWordWrapping
        let font = UIFont.systemFont(ofSize: metrics.size)
        return [.font: font, .foregroundColor: Theme.text, .paragraphStyle: style, .baselineOffset: (metrics.line - font.lineHeight) / 4]
    }

    /// `circleOnly` (SavedScreen.tsx): a round video with no words and no origin, shown alone.
    private var circleOnly: Bool { kind == "note" && words.isEmpty && item["origin"] == nil }

    /// A plate only when bubbles are chosen; the open look has none (the owner's rule).
    private var plated: Bool { !msgOpenLook && !circleOnly }

    func show(_ next: [String: Any], own: String, state: MsgMediaState?, maxSide: CGFloat) {
        item = next
        key = SavedNoteCell.key(next)
        self.state = state
        self.maxSide = maxSide
        if let from = next["origin"] as? [String: Any] {
            let author = from["author"] as? String ?? ""
            let day = Messenger.date(from["sentAt"] as? String).map { Messenger.dayWords($0) } ?? ""
            originWords = (author == own ? "Твоё сообщение" : "От " + author) + " · " + day
        } else {
            originWords = ""
        }
        words = next["text"] as? String ?? ""
        edited = next["editedAt"] != nil
        timeWords = Messenger.date(next["savedAt"] as? String).map { SavedNoteCanvas.clock.string(from: $0) } ?? ""
        attachment = next["attachment"] as? [String: Any] ?? [:]
        if attachment.isEmpty {
            kind = ""
        } else {
            AttachmentStore.shared.remember(key, attachment)
            let media = MediaRows.kind(attachment)
            kind = media == "voice" ? "voice" : media == "note" ? "note" : "card"
            fileKind = FileCore.describe(attachment).kind
        }
        let picture = (attachment["preview"] as? [String: Any])?["base64"] as? String ?? ""
        if picture != posterOf {
            posterOf = picture
            poster = picture.isEmpty ? nil : Data(base64Encoded: picture, options: .ignoreUnknownCharacters).flatMap { UIImage(data: $0) }
        }
        laidFor = -1
        let line = attachment.isEmpty ? "" : SavedMessages.line(next).text
        spoken = [originWords, words.isEmpty ? (line.isEmpty ? "Запись" : line) : words, (edited ? "изм. " : "") + timeWords].filter { !$0.isEmpty }.joined(separator: ", ")
        setNeedsDisplay()
    }

    // MARK: Sizes

    private var noteSide: CGFloat { maxSide > 0 ? min(212, floor(maxSide)) : 212 }

    private var duration: String {
        let ms = ((attachment["media"] as? [String: Any])?["durationMs"] as? NSNumber)?.doubleValue ?? 0
        let seconds = Int(ms / 1000)
        return seconds > 0 ? String(seconds / 60) + ":" + String(format: "%02d", seconds % 60) : ""
    }

    private var visual: Bool { fileKind == "photo" || fileKind == "video" }

    /// AttachmentCard: a 230 × 190 picture card, or the file line (180…270 wide, 7 above and below the 46 pt icon).
    private func cardSize(_ room: CGFloat) -> CGSize {
        if visual { return CGSize(width: 230, height: 190) }
        let width = min(270, max(180, room))
        let name = (attachment["name"] as? String ?? "") as NSString
        let nameRoom = width - 42 - 10 - 10 - 17
        let nameHeight = ceil(name.boundingRect(with: CGSize(width: nameRoom, height: 2 * UIFont.systemFont(ofSize: 14, weight: .semibold).lineHeight + 1), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                                                attributes: [.font: UIFont.systemFont(ofSize: 14, weight: .semibold)], context: nil).height)
        let column = nameHeight + 4 + ceil(UIFont.systemFont(ofSize: 12).lineHeight)
        return CGSize(width: width, height: max(46, column) + 14)
    }

    func measure(room: CGFloat) -> Laid {
        lastRoom = room
        if laidFor == room { return laid }
        var next = Laid()
        let pad: CGFloat = plated ? 12 : 0
        next.inset = pad
        let inner = max(40, room - 2 * pad)
        var y: CGFloat = circleOnly ? 0 : (kind.isEmpty ? 11 : 7)
        var width: CGFloat = 0
        if !originWords.isEmpty {
            let size = (originWords as NSString).boundingRect(with: CGSize(width: inner, height: 200), options: .usesLineFragmentOrigin, attributes: [.font: SavedNoteCanvas.originFont], context: nil)
            next.origin = CGRect(x: 0, y: y, width: ceil(size.width), height: ceil(size.height))
            y += ceil(size.height) + 4
            width = max(width, ceil(size.width))
        }
        if !kind.isEmpty {
            var size = CGSize.zero
            switch kind {
            case "voice": size = CGSize(width: min(inner, MediaRowArt.voiceWidth), height: MediaRowArt.voiceHeight)
            case "note": size = CGSize(width: noteSide, height: noteSide)
            default: size = cardSize(inner)
            }
            next.media = CGRect(x: 0, y: y, width: size.width, height: size.height)
            y += size.height + (words.isEmpty ? 1 : 7)
            width = max(width, size.width)
        }
        let timeText = NSAttributedString(string: (edited ? "изм. " : "") + timeWords, attributes: [.font: SavedNoteCanvas.timeFont])
        let timeSize = CGSize(width: ceil(timeText.size().width), height: ceil(SavedNoteCanvas.timeFont.lineHeight))
        if !words.isEmpty {
            let text = MsgText(NSAttributedString(string: words, attributes: textAttributes), width: inner)
            let size = text.size
            next.text = CGRect(x: 0, y: y, width: size.width, height: size.height)
            width = max(width, size.width)
            // The open look: the time follows the last word when it fits on that line.
            let last = text.lastLine
            if !plated, last != .zero, ceil(last.maxX) + 8 + timeSize.width <= inner {
                next.timeInline = true
                next.time = CGRect(x: ceil(last.maxX) + 8, y: y + last.maxY - timeSize.height - 3, width: timeSize.width, height: timeSize.height)
                width = max(width, next.time.maxX)
            }
            y += size.height
        }
        if circleOnly {
            // The time in a pill under the circle: 4 above, 8 × 3 inside, radius 10.
            let pill = NSAttributedString(string: timeWords, attributes: [.font: SavedNoteCanvas.pillFont]).size()
            let pillSize = CGSize(width: ceil(pill.width) + 16, height: ceil(SavedNoteCanvas.pillFont.lineHeight) + 6)
            next.time = CGRect(x: 0, y: y + 3, width: pillSize.width, height: pillSize.height)
            y += 3 + pillSize.height
            width = max(width, pillSize.width)
        } else if !next.timeInline {
            next.time = CGRect(x: 0, y: y + 4, width: timeSize.width, height: timeSize.height)
            y += 4 + timeSize.height
            width = max(width, timeSize.width)
        }
        if !circleOnly { y += 7 }
        let boxWidth = max(circleOnly ? 0 : 74, width + 2 * pad)
        // Everything stands at the right edge of the note (alignSelf flex-end in the reference).
        let shift = { (frame: CGRect) -> CGRect in frame == .zero ? .zero : CGRect(x: boxWidth - pad - frame.width, y: frame.minY, width: frame.width, height: frame.height) }
        next.origin = shift(next.origin)
        next.media = shift(next.media)
        if next.timeInline {
            let textRight = boxWidth - pad
            let textLeft = textRight - max(next.text.width, next.time.maxX)
            next.time = CGRect(x: textLeft + next.time.minX, y: next.time.minY, width: next.time.width, height: next.time.height)
            next.text = CGRect(x: textLeft, y: next.text.minY, width: next.text.width, height: next.text.height)
        } else {
            next.text = shift(next.text)
            next.time = shift(next.time)
        }
        next.box = CGSize(width: boxWidth, height: y)
        laid = next
        laidFor = room
        return next
    }

    /// Where a round video stands in this view (zero: none).
    var noteBox: CGRect { kind == "note" ? laid.media : .zero }

    func part(at point: CGPoint) -> String? {
        if kind == "voice" { return boxes.part(at: point)?.part }
        if kind == "note", laid.media.contains(point) { return "thumb" }
        if kind == "card", laid.media.contains(point) { return "card" }
        return nil
    }

    // MARK: Drawing

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let laid = measure(room: lastRoom > 0 ? lastRoom : bounds.width)
        if plated {
            // SavedScreen.tsx: t.bubble, radius 23 (8 at the lower right), a 1 pt border.
            let box = CGRect(origin: .zero, size: laid.box).insetBy(dx: 0.5, dy: 0.5)
            let shape = SavedNoteCanvas.plate(box)
            context.setFillColor(ThemeStore.look.bubble.cgColor)
            context.addPath(shape.cgPath)
            context.fillPath()
            context.setStrokeColor((Theme.dark ? UIColor(red: 157 / 255, green: 182 / 255, blue: 1, alpha: 0.25) : UIColor(white: 1, alpha: 0.83)).cgColor)
            context.setLineWidth(1)
            context.addPath(shape.cgPath)
            context.strokePath()
        }
        if !originWords.isEmpty {
            (originWords as NSString).draw(with: laid.origin, options: .usesLineFragmentOrigin, attributes: [.font: SavedNoteCanvas.originFont, .foregroundColor: Theme.accent], context: nil)
        }
        boxes = MsgMediaBoxes()
        switch kind {
        case "voice":
            let row = MsgRow.parse([["key": key, "kind": 0, "mine": true, "media": "voice", "wave": (attachment["media"] as? [String: Any])?["waveform"] as? String ?? "",
                                     "mediaTime": FileCore.call("voiceTime", [((attachment["media"] as? [String: Any])?["durationMs"] as? NSNumber)?.doubleValue ?? 0]) as? String ?? ""]]).first
            if let row { boxes = MediaRowArt.voice(context, row: row, state: state, palette: Theme.messages, box: laid.media) }
        case "note":
            drawNote(context, box: laid.media)
        case "card":
            drawCard(context, box: laid.media)
        default:
            break
        }
        if !words.isEmpty {
            NSAttributedString(string: words, attributes: textAttributes).draw(with: laid.text, options: .usesLineFragmentOrigin, context: nil)
        }
        if circleOnly {
            context.setFillColor(UIColor(white: 0, alpha: Theme.dark ? 0.45 : 0.32).cgColor)
            context.addPath(UIBezierPath(roundedRect: laid.time, cornerRadius: 10).cgPath)
            context.fillPath()
            let pill = NSAttributedString(string: timeWords, attributes: [.font: SavedNoteCanvas.pillFont, .foregroundColor: UIColor.white])
            let size = pill.size()
            pill.draw(at: CGPoint(x: laid.time.midX - size.width / 2, y: laid.time.midY - size.height / 2))
        } else {
            NSAttributedString(string: (edited ? "изм. " : "") + timeWords, attributes: [.font: SavedNoteCanvas.timeFont, .foregroundColor: Theme.muted]).draw(at: laid.time.origin)
        }
    }

    private static func plate(_ box: CGRect) -> UIBezierPath {
        let big: CGFloat = 23, small: CGFloat = 8
        let path = UIBezierPath()
        path.move(to: CGPoint(x: box.minX + big, y: box.minY))
        path.addLine(to: CGPoint(x: box.maxX - big, y: box.minY))
        path.addArc(withCenter: CGPoint(x: box.maxX - big, y: box.minY + big), radius: big, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        path.addLine(to: CGPoint(x: box.maxX, y: box.maxY - small))
        path.addArc(withCenter: CGPoint(x: box.maxX - small, y: box.maxY - small), radius: small, startAngle: 0, endAngle: .pi / 2, clockwise: true)
        path.addLine(to: CGPoint(x: box.minX + big, y: box.maxY))
        path.addArc(withCenter: CGPoint(x: box.minX + big, y: box.maxY - big), radius: big, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        path.addLine(to: CGPoint(x: box.minX, y: box.minY + big))
        path.addArc(withCenter: CGPoint(x: box.minX + big, y: box.minY + big), radius: big, startAngle: .pi, endAngle: .pi * 1.5, clockwise: true)
        path.close()
        return path
    }

    /// VideoNoteBubble at rest: the poster in its circle (or the placeholder), and the marks of a chat's circle.
    private func drawNote(_ context: CGContext, box: CGRect) {
        if let poster, poster.size.width > 0, poster.size.height > 0 {
            context.saveGState()
            UIBezierPath(ovalIn: box).addClip()
            context.setFillColor(Theme.surface2.cgColor)
            context.fill(box)
            let scale = max(box.width / poster.size.width, box.height / poster.size.height)
            let size = CGSize(width: poster.size.width * scale, height: poster.size.height * scale)
            poster.draw(in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height))
            context.restoreGState()
        } else {
            MediaRowArt.plate(context, round: true, palette: Theme.messages, box: box)
        }
        if !subviews.contains(where: { $0 is NotePlayerView }) {
            MediaRowArt.noteMarks(context, key: key, length: duration, state: state, box: box)
        }
    }

    private func glyph(_ name: String, size: CGFloat, color: UIColor, center: CGPoint) {
        IonIcon.image(name, size: size).withTintColor(color, renderingMode: .alwaysOriginal)
            .draw(in: CGRect(x: center.x - size / 2, y: center.y - size / 2, width: size, height: size))
    }

    /// components.tsx AttachmentCard.
    private func drawCard(_ context: CGContext, box: CGRect) {
        let size = FileCore.sizeText((attachment["size"] as? NSNumber)?.intValue ?? 0)
        let icon = fileKind == "photo" ? "image-outline" : fileKind == "video" ? "videocam-outline" : fileKind == "audio" ? "musical-notes-outline" : "document-outline"
        if visual {
            let shape = UIBezierPath(roundedRect: box, cornerRadius: 16)
            context.saveGState()
            shape.addClip()
            context.setFillColor(Theme.surface2.cgColor)
            context.fill(box)
            if let poster, poster.size.width > 0, poster.size.height > 0 {
                let scale = max(box.width / poster.size.width, box.height / poster.size.height)
                let drawn = CGSize(width: poster.size.width * scale, height: poster.size.height * scale)
                poster.draw(in: CGRect(x: box.midX - drawn.width / 2, y: box.midY - drawn.height / 2, width: drawn.width, height: drawn.height))
            } else {
                glyph(icon, size: 46, color: Theme.muted, center: CGPoint(x: box.midX, y: box.midY))
            }
            let center = CGPoint(x: box.midX, y: box.midY)
            context.setFillColor(UIColor(red: 10 / 255, green: 20 / 255, blue: 35 / 255, alpha: 0.62).cgColor)
            context.fillEllipse(in: CGRect(x: center.x - 23, y: center.y - 23, width: 46, height: 46))
            glyph(fileKind == "video" ? "play" : "arrow-down", size: 24, color: .white, center: center)
            // Two labels at the foot: «12 МБ · загрузить» at the left, the length at the right (7 × 4 inside, radius 8).
            let label = { (text: String, alignRight: Bool) -> Void in
                let words = NSAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: 11), .foregroundColor: UIColor.white])
                let measured = words.size()
                let plate = CGSize(width: ceil(measured.width) + 14, height: ceil(UIFont.systemFont(ofSize: 11).lineHeight) + 8)
                let frame = CGRect(x: alignRight ? box.maxX - 10 - plate.width : box.minX + 10, y: box.maxY - 9 - plate.height, width: plate.width, height: plate.height)
                context.setFillColor(UIColor(red: 10 / 255, green: 20 / 255, blue: 35 / 255, alpha: 0.68).cgColor)
                context.addPath(UIBezierPath(roundedRect: frame, cornerRadius: 8).cgPath)
                context.fillPath()
                words.draw(at: CGPoint(x: frame.minX + 7, y: frame.midY - measured.height / 2))
            }
            label(size + " · загрузить", false)
            if !duration.isEmpty { label(duration, true) }
            context.restoreGState()
            return
        }
        // The file line: a 42 × 46 plate (radius 15, accentSoft, a 1 pt glassBorder) with the accent glyph, the
        // name (14 semibold, two lines) over «size · открыть» (12 muted), and the arrow at the end.
        let plate = CGRect(x: box.minX, y: box.midY - 23, width: 42, height: 46)
        let plateShape = UIBezierPath(roundedRect: plate.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 14.5)
        context.setFillColor(ThemeStore.look.accentSoft.cgColor)
        context.addPath(plateShape.cgPath)
        context.fillPath()
        context.setStrokeColor(ThemeStore.look.glassBorder.cgColor)
        context.setLineWidth(1)
        context.addPath(plateShape.cgPath)
        context.strokePath()
        glyph(icon, size: 22, color: Theme.accent, center: CGPoint(x: plate.midX, y: plate.midY))
        let textX = plate.maxX + 10
        let textWidth = box.maxX - 10 - 17 - textX
        let nameFont = UIFont.systemFont(ofSize: 14, weight: .semibold)
        let name = attachment["name"] as? String ?? ""
        let nameBox = (name as NSString).boundingRect(with: CGSize(width: textWidth, height: 2 * nameFont.lineHeight + 1), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: [.font: nameFont], context: nil)
        let subFont = UIFont.systemFont(ofSize: 12)
        let column = ceil(nameBox.height) + 4 + ceil(subFont.lineHeight)
        let top = box.midY - column / 2
        (name as NSString).draw(with: CGRect(x: textX, y: top, width: textWidth, height: ceil(nameBox.height)), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: [.font: nameFont, .foregroundColor: Theme.text], context: nil)
        let sub = size + (duration.isEmpty ? "" : " · " + duration) + " · открыть"
        (sub as NSString).draw(with: CGRect(x: textX, y: top + ceil(nameBox.height) + 4, width: textWidth, height: ceil(subFont.lineHeight)), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: [.font: subFont, .foregroundColor: Theme.muted], context: nil)
        glyph(fileKind == "audio" ? "play" : "arrow-down-outline", size: 17, color: Theme.muted, center: CGPoint(x: box.maxX - 8.5, y: box.midY))
    }
}
