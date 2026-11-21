import UIKit

/// ChatsPlus: «Люди › Звонки» (the reference's calls/CallHistory.tsx over callLog.ts): recent calls grouped by day,
/// built only from what this device decrypted and kept — never asked of the server. A call leaves one trace in
/// the chat, the encrypted `end` action; its words come from the core (`callServiceText`), so both phones name
/// the same call the same way. Missed calls not read yet are red with a dot, and their number stands on the tab.
struct CallRecord {
    let key: String
    let chat: Messenger.ChatSummary
    let at: Date
    /// "outgoing", "incoming", "missed", "cancelled", "declined", "busy", "failed".
    let kind: String
    let video: Bool
    /// The row's words: «Исходящий звонок · 3:12», «Пропущенный видеозвонок».
    let label: String
    var unseen: Bool
    var count: Int
}

enum CallLog {
    /// The core's labels back to the kind they name (callLog.ts `callLabel`).
    private static let kinds: [String: (kind: String, video: Bool)] = [
        "Исходящий звонок": ("outgoing", false), "Исходящий видеозвонок": ("outgoing", true),
        "Входящий звонок": ("incoming", false), "Входящий видеозвонок": ("incoming", true),
        "Пропущенный звонок": ("missed", false), "Пропущенный видеозвонок": ("missed", true),
        "Отменённый звонок": ("cancelled", false), "Отменённый видеозвонок": ("cancelled", true),
        "Отклонённый звонок": ("declined", false), "Отклонённый видеозвонок": ("declined", true),
        "Собеседник занят": ("busy", false), "Звонок не удался": ("failed", false), "Видеозвонок не удался": ("failed", true),
    ]

    /// One `end` action as this account sees it: kind, video, the row's words. The kind is read from the core's own
    /// label of the same action without its length, so the rules stay in one place (calls.rs `classify_call`).
    static func describe(_ action: [String: Any], senderId: String, userId: String) -> (kind: String, video: Bool, label: String)? {
        guard let label = Core.view("callServiceText", [action, senderId, userId]) as? String else { return nil }
        var bare = action
        bare.removeValue(forKey: "duration")
        let plain = Core.view("callServiceText", [bare, senderId, userId]) as? String ?? label
        guard let found = kinds[plain] else { return nil }
        return (found.kind, found.video || action["video"] as? Bool == true, label)
    }

    /// Every call this device knows (the history kept here, newest first). Runs on the encryption queue.
    static func build(chats: [Messenger.ChatSummary], userId: String, crypto: CryptoService) -> [CallRecord] {
        var out: [CallRecord] = []
        for chat in chats {
            var pool: [[String: Any]] = []
            if case .success(let value) = crypto.callNow("history", [chat.id, 400]), let kept = value as? [[String: Any]] { pool = kept }
            // The list's last message, for a chat whose history holds nothing yet.
            if !chat.last.isEmpty, !pool.contains(where: { $0["clientId"] as? String == chat.last["clientId"] as? String }) {
                var last = chat.last
                if last["sentAt"] == nil { last["sentAt"] = last["createdAt"] }
                pool.append(last)
            }
            let unread = (chat.chat["unreadCount"] as? NSNumber)?.intValue ?? 0
            // Theirs, newest first: the newest `unread` of them are the ones not read yet.
            let theirs = pool.filter { $0["senderId"] as? String != userId }
                .sorted { ($0["sentAt"] as? String ?? "") > ($1["sentAt"] as? String ?? "") }
                .compactMap { $0["clientId"] as? String }
            let notRead = Set(theirs.prefix(unread))
            var seen = Set<String>()
            for message in pool {
                guard let action = (message["meta"] as? [String: Any])?["action"] as? [String: Any], action["type"] as? String == "call",
                      action["step"] as? String == "end", let callId = action["call"] as? String, !seen.contains(callId) else { continue }
                // Both phones may have sent an `end`: one entry per call (messageMeta.ts `dedupeCallEnds`).
                seen.insert(callId)
                let sender = message["senderId"] as? String ?? ""
                guard let about = describe(action, senderId: sender, userId: userId),
                      let at = Messenger.date(message["sentAt"] as? String ?? message["createdAt"] as? String) else { continue }
                let unseen = about.kind == "missed" && sender != userId && notRead.contains(message["clientId"] as? String ?? "")
                out.append(CallRecord(key: chat.id + ":" + callId, chat: chat, at: at, kind: about.kind, video: about.video, label: about.label, unseen: unseen, count: 1))
            }
        }
        return out.sorted { $0.at > $1.at }
    }

    private static let dayLong: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "ru_RU"); f.dateFormat = "d MMMM"; return f }()
    private static let dayYear: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "ru_RU"); f.dateFormat = "d MMMM yyyy 'г.'"; return f }()

    /// «Сегодня», «Вчера», «3 ноября», «3 ноября 2025 г.» (callLog.ts `callDayLabel`).
    static func dayLabel(_ date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return "Сегодня" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Вчера" }
        return calendar.component(.year, from: date) == calendar.component(.year, from: now) ? dayLong.string(from: date) : dayYear.string(from: date)
    }

    /// Newest first, by day; neighbours of one kind with one person on one day become one «Имя (3)» row.
    static func group(_ records: [CallRecord], now: Date = Date()) -> [(label: String, calls: [CallRecord])] {
        var groups: [(label: String, calls: [CallRecord])] = []
        let calendar = Calendar.current
        var lastDay: Date?
        for record in records {
            let day = calendar.startOfDay(for: record.at)
            if lastDay != day { groups.append((label: dayLabel(record.at, now: now), calls: [])); lastDay = day }
            var calls = groups[groups.count - 1].calls
            if var previous = calls.last, previous.chat.id == record.chat.id, previous.kind == record.kind, previous.video == record.video {
                previous.count += 1
                previous.unseen = previous.unseen || record.unseen
                calls[calls.count - 1] = previous
            } else {
                calls.append(record)
            }
            groups[groups.count - 1].calls = calls
        }
        return groups
    }

    /// The red number on «Звонки»: missed calls not read yet.
    static func unseenCount(_ records: [CallRecord]) -> Int { records.filter { $0.unseen }.count }
}

/// «Друзья | Звонки» on the «Люди» page and the list of calls under it. The page hands over its views in
/// `install`; `place` lays the switch out under the caption and gives back where the page's own content starts.
final class CallHistoryPanel: NSObject, UITableViewDataSource, UITableViewDelegate {
    private let messenger: Messenger?
    private weak var host: UIViewController?
    private weak var caption: UILabel?
    private let switcher = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let friendsTab = UIButton(type: .custom)
    private let callsTab = UIButton(type: .custom)
    private let missedBadge = UILabel()
    private let page = UIView()
    private let table = UITableView(frame: .zero, style: .plain)
    private let empty = EmptyStateView()
    private var groups: [(label: String, calls: [CallRecord])] = []
    private var records: [CallRecord] = []
    private(set) var showingCalls = false
    private var loading = false

    init(messenger: Messenger?) {
        self.messenger = messenger
        super.init()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    func install(host: UIViewController, caption: UILabel) {
        self.host = host
        self.caption = caption
        switcher.effect = UIBlurEffect(style: Theme.dark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight)
        switcher.layer.cornerRadius = 22
        switcher.layer.cornerCurve = .continuous
        switcher.clipsToBounds = true
        host.view.addSubview(switcher)
        for (button, words) in [(friendsTab, "Друзья"), (callsTab, "Звонки")] {
            button.setTitle(words, for: .normal)
            button.titleLabel?.font = AppFont.text(13, .bold)
            button.layer.cornerRadius = 18
            button.layer.cornerCurve = .continuous
            button.accessibilityTraits = .button
            button.addTarget(self, action: #selector(tabPressed(_:)), for: .touchUpInside)
            switcher.contentView.addSubview(button)
        }
        missedBadge.font = AppFont.text(11, .bold)
        missedBadge.textAlignment = .center
        missedBadge.layer.cornerRadius = 9
        missedBadge.layer.masksToBounds = true
        missedBadge.isHidden = true
        callsTab.addSubview(missedBadge)
        page.backgroundColor = Theme.bg
        page.isHidden = true
        host.view.addSubview(page)
        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.showsVerticalScrollIndicator = false
        table.rowHeight = 80
        table.dataSource = self
        table.delegate = self
        table.register(CallRowCell.self, forCellReuseIdentifier: "call")
        table.register(CallDayCell.self, forCellReuseIdentifier: "day")
        page.addSubview(table)
        empty.isHidden = true
        page.addSubview(empty)
        paintTabs()
        if messenger != nil { NotificationCenter.default.addObserver(self, selector: #selector(changedSoon), name: Messenger.changed, object: nil) }
        reload()
        #if targetEnvironment(simulator)
        if UserDefaults.standard.string(forKey: "chatsdemo") == "calls" { DispatchQueue.main.async { [weak self] in self?.show(calls: true) } }
        #endif
    }

    /// Lays out the switch under `top`; gives back where the page's own content (the search) starts. The list of
    /// calls covers everything from there down.
    func place(in view: UIView, top: CGFloat) -> CGFloat {
        let width = view.bounds.width
        switcher.frame = CGRect(x: 17, y: top + 12, width: width - 34, height: 44)
        let half = (switcher.bounds.width - 12) / 2
        friendsTab.frame = CGRect(x: 4, y: 4, width: half, height: 36)
        callsTab.frame = CGRect(x: 8 + half, y: 4, width: half, height: 36)
        let badgeWidth = max(18, ceil(missedBadge.sizeThatFits(CGSize(width: 60, height: 18)).width) + 10)
        let wordsWidth = ceil(callsTab.titleLabel?.sizeThatFits(CGSize(width: half, height: 36)).width ?? 50)
        missedBadge.frame = CGRect(x: (half + wordsWidth) / 2 + 6, y: 9, width: badgeWidth, height: 18)
        let below = switcher.frame.maxY
        page.frame = CGRect(x: 0, y: below + 14, width: width, height: max(0, view.bounds.height - below - 14))
        table.frame = page.bounds
        let barRoom = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 12
        table.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: barRoom + 12, right: 0)
        empty.frame = CGRect(x: 0, y: 0, width: width, height: max(0, page.bounds.height - barRoom))
        view.bringSubviewToFront(page)
        view.bringSubviewToFront(switcher)
        return below
    }

    private func paintTabs() {
        for (button, on) in [(friendsTab, !showingCalls), (callsTab, showingCalls)] {
            button.backgroundColor = on ? Theme.accent : .clear
            button.setTitleColor(on ? Theme.onAccent : Theme.muted, for: .normal)
            button.accessibilityTraits = on ? [.button, .selected] : .button
        }
        let missed = CallLog.unseenCount(records)
        missedBadge.isHidden = missed == 0
        missedBadge.text = missed > 99 ? "99+" : String(missed)
        missedBadge.backgroundColor = showingCalls ? Theme.onAccent : Theme.danger
        missedBadge.textColor = showingCalls ? Theme.accent : .white
        callsTab.accessibilityLabel = missed > 0 ? "Звонки, пропущенных \(missed)" : "Звонки"
    }

    @objc private func tabPressed(_ sender: UIButton) {
        show(calls: sender === callsTab)
    }

    private func show(calls: Bool) {
        guard calls != showingCalls else { return }
        showingCalls = calls
        host?.view.endEditing(true)
        page.isHidden = !calls
        caption?.text = calls ? "Недавние звонки" : "Друзья, заявки и поиск по @имени"
        paintTabs()
        if calls { reload() }
    }

    @objc private func changedSoon() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(reloadNow), object: nil)
        perform(#selector(reloadNow), with: nil, afterDelay: 0.6)
    }

    @objc private func reloadNow() { reload() }

    private func reload() {
        guard let messenger else {
            #if targetEnvironment(simulator)
            records = CallHistoryPanel.sampleRecords()
            refresh()
            #endif
            return
        }
        guard !loading else { return }
        loading = true
        messenger.chats { [weak self] (result: Result<[Messenger.ChatSummary], ServerError>) -> Void in
            guard let self else { return }
            guard case .success(let chats) = result else { self.loading = false; return }
            let me = messenger.userId
            messenger.crypto.run({ (crypto: CryptoService) -> [CallRecord] in
                CallLog.build(chats: chats, userId: me, crypto: crypto)
            }, done: { [weak self] (found: [CallRecord]) -> Void in
                guard let self else { return }
                self.loading = false
                self.records = found
                self.refresh()
            })
        }
    }

    private func refresh() {
        groups = CallLog.group(records)
        table.reloadData()
        empty.isHidden = !records.isEmpty
        if records.isEmpty {
            empty.show(symbol: "phone", title: "Звонков пока не было", words: "Здесь появятся входящие, исходящие и пропущенные звонки. Позвонить можно из чата или из профиля человека.")
        }
        paintTabs()
    }

    // MARK: The list

    private func item(at row: Int) -> (day: String?, call: CallRecord?) {
        var index = row
        for group in groups {
            if index == 0 { return (group.label, nil) }
            index -= 1
            if index < group.calls.count { return (nil, group.calls[index]) }
            index -= group.calls.count
        }
        return (nil, nil)
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        groups.reduce(0) { $0 + 1 + $1.calls.count }
    }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        item(at: indexPath.row).day != nil ? 34 : 80
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let found = item(at: indexPath.row)
        if let day = found.day {
            let cell = tableView.dequeueReusableCell(withIdentifier: "day", for: indexPath)
            (cell as? CallDayCell)?.show(day)
            return cell
        }
        let cell = tableView.dequeueReusableCell(withIdentifier: "call", for: indexPath)
        if let row = cell as? CallRowCell, let call = found.call {
            row.show(call)
            row.onCall = { [weak self] in self?.callBack(call) }
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        guard let call = item(at: indexPath.row).call, let messenger, let host else { return }
        // A touch opens the chat with that person.
        let screen = ChatViewController(name: call.chat.title, messenger: messenger, chatId: call.chat.id, peerId: call.chat.peerId)
        screen.peerLastRead = call.chat.peerLastRead
        screen.actions.opened(call.chat)
        host.navigationController?.pushViewController(screen, animated: true)
    }

    /// «Перезвонить»: the same kind of call again (a video call for a video one).
    private func callBack(_ call: CallRecord) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        CallOverlay.call(messenger: messenger, chatId: call.chat.id, peerId: call.chat.peerId, name: call.chat.title, video: call.video)
    }

    #if targetEnvironment(simulator)
    static func sampleRecords() -> [CallRecord] {
        let rows = SimulatorDemo.chats()
        func chat(_ index: Int) -> Messenger.ChatSummary {
            let row = rows[min(index, rows.count - 1)]
            return Messenger.ChatSummary(id: row.id, peerId: "demo-person-\(index)", title: row.title, peerLastRead: 0,
                                         row: ["avatarColor": row.avatarColor, "initials": row.initials])
        }
        let now = Date()
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        return [
            CallRecord(key: "a", chat: chat(2), at: ago(12), kind: "missed", video: false, label: "Пропущенный звонок", unseen: true, count: 1),
            CallRecord(key: "b", chat: chat(0), at: ago(95), kind: "outgoing", video: true, label: "Исходящий видеозвонок · 14:05", unseen: false, count: 1),
            CallRecord(key: "c", chat: chat(3), at: ago(60 * 26), kind: "incoming", video: false, label: "Входящий звонок · 3:12", unseen: false, count: 1),
            CallRecord(key: "d", chat: chat(3), at: ago(60 * 27), kind: "incoming", video: false, label: "Входящий звонок · 0:48", unseen: false, count: 1),
            CallRecord(key: "e", chat: chat(5), at: ago(60 * 24 * 4), kind: "declined", video: false, label: "Отклонённый звонок", unseen: false, count: 1),
        ]
    }
    #endif
}

/// The quiet day above the calls of one day.
final class CallDayCell: UITableViewCell {
    private let words = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        contentView.addSubview(words)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ day: String) {
        words.attributedText = NSAttributedString(string: day.uppercased(), attributes: [.kern: 1.7, .font: AppFont.text(10, .bold), .foregroundColor: Theme.muted])
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        words.frame = CGRect(x: 26, y: 8, width: contentView.bounds.width - 52, height: 16)
    }
}

/// One call: avatar, the name (red for a missed one, «(3)» for several), the direction and the words, the time,
/// and «Перезвонить».
final class CallRowCell: UITableViewCell {
    var onCall: (() -> Void)?
    private let avatar = SmallAvatarView()
    private let name = UILabel()
    private let dot = UIView()
    private let arrow = UIImageView()
    private let words = UILabel()
    private let time = UILabel()
    private let again = UIButton(type: .system)

    private static let clock: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "ru_RU"); f.dateFormat = "HH:mm"; return f }()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        contentView.addSubview(avatar)
        name.font = AppFont.text(16, .semibold)
        contentView.addSubview(name)
        dot.backgroundColor = Theme.danger
        dot.layer.cornerRadius = 4
        contentView.addSubview(dot)
        arrow.contentMode = .center
        contentView.addSubview(arrow)
        words.font = AppFont.text(13)
        contentView.addSubview(words)
        time.font = UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        time.textColor = Theme.muted
        time.textAlignment = .right
        contentView.addSubview(time)
        again.layer.cornerRadius = 19
        again.layer.borderWidth = 1
        again.addTarget(self, action: #selector(pressed), for: .touchUpInside)
        contentView.addSubview(again)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ call: CallRecord) {
        let red = call.kind == "missed" || call.kind == "declined"
        let person = FolderChat(summary: call.chat)
        avatar.show(person)
        name.text = call.chat.title + (call.count > 1 ? " (\(call.count))" : "")
        name.textColor = call.kind == "missed" ? Theme.danger : Theme.text
        dot.isHidden = !call.unseen
        let symbol: String
        switch call.kind {
        case "outgoing", "cancelled", "busy": symbol = "arrow.up.right"
        case "incoming", "missed": symbol = "arrow.down.left"
        case "declined": symbol = "nosign"
        default: symbol = "exclamationmark.circle"
        }
        arrow.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold))
        arrow.tintColor = red ? Theme.danger : Theme.muted
        words.text = call.label
        words.textColor = red ? Theme.danger : Theme.muted
        time.text = CallRowCell.clock.string(from: call.at)
        again.setImage(UIImage(systemName: call.video ? "video" : "phone", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)), for: .normal)
        again.tintColor = Theme.accent
        again.backgroundColor = ThemeStore.look.accentSoft
        again.layer.borderColor = ThemeStore.look.border.cgColor
        again.accessibilityLabel = "Перезвонить: " + call.chat.title
        accessibilityLabel = name.text.map { $0 + ": " + call.label + ", " + (time.text ?? "") }
        accessibilityHint = "Открыть чат"
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = contentView.bounds.width, h = contentView.bounds.height
        avatar.frame = CGRect(x: 26, y: (h - 50) / 2, width: 50, height: 50)
        again.frame = CGRect(x: w - 26 - 38, y: (h - 38) / 2, width: 38, height: 38)
        time.frame = CGRect(x: again.frame.minX - 14 - 50, y: (h - 18) / 2, width: 50, height: 18)
        let left = avatar.frame.maxX + 14
        let room = time.frame.minX - 8 - left
        let nameWidth = min(room - (dot.isHidden ? 0 : 14), ceil(name.sizeThatFits(CGSize(width: room, height: 21)).width))
        name.frame = CGRect(x: left, y: h / 2 - 22, width: max(0, nameWidth), height: 21)
        dot.frame = CGRect(x: name.frame.maxX + 6, y: name.frame.midY - 4, width: 8, height: 8)
        arrow.frame = CGRect(x: left, y: h / 2 + 3, width: 14, height: 18)
        words.frame = CGRect(x: left + 19, y: h / 2 + 3, width: max(0, room - 19), height: 18)
    }

    @objc private func pressed() { onCall?() }
}
