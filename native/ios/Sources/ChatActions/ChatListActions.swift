import UIKit

/// What a person does with the chats in their list (the reference's ChatListScreen.tsx and listSwipes.ts): the
/// buttons behind a row — read / not read and pin on one side, archive, delete and sound on the other — the same
/// choices by a long press, «Архив» above the first chat, the draft and «Печатает…» in a row's line, and the
/// search by name and, in the history kept on this device, by the text of messages.
///
/// The list's screen hands its views over in `install` and the chats in `show`; the rows come back through
/// `onRows`. Main queue only.
final class ChatListActions: NSObject, UITextFieldDelegate {
    static let archiveRow = "__archive"
    static let backRow = "__back"
    private static let draftWord = "Черновик:"
    private static let swipeWords: [String: String] = ["read": "Прочитано", "unread": "Не прочитано", "pin": "Закрепить", "unpin": "Открепить", "mute": "Без звука",
                                                       "unmute": "Со звуком", "delete": "Удалить", "archive": "В архив", "unarchive": "Вернуть"]

    /// A message found by its text in the history kept on this device.
    private struct Hit {
        let chatId: String
        let clientId: String
        let text: String
        let sentAt: String
    }

    private let messenger: Messenger?
    private let local: ChatLocal?
    private weak var host: UIViewController?
    private weak var list: ChatListView?
    private var chats: [Messenger.ChatSummary] = []
    private var archiveOpen = false
    private var query = ""
    private var hits: [Hit] = []
    private var searchRun = 0
    private var searchSoon: DispatchWorkItem?
    /// The line shown for a chat whose last message is not one to show (a reaction, an edit, something hidden
    /// here), with the id of that last message.
    private var fills: [String: (lastId: Int, line: String)] = [:]
    private var asked = Set<String>()
    /// The sample list's own marks and drafts (no account, nothing is kept).
    private var sampleMarked = Set<String>()
    private var sampleDrafts: [String: String] = [:]

    private let searchButton = UIButton(type: .system)
    private let searchBox = UIView()
    private let searchIcon = UIImageView()
    private let searchField = UITextField()
    private let searchClose = UIButton(type: .system)
    private var searching = false

    /// The rows to show, and the words for an empty list.
    var onRows: (([ChatRow], String) -> Void)?
    /// The screen's heading: «Чаты» or «Архив».
    var onHeading: ((String) -> Void)?
    /// The chats should be read from the server again.
    var onReload: (() -> Void)?

    init(messenger: Messenger?) {
        self.messenger = messenger
        local = messenger.map { ChatLocal.of($0) }
        super.init()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: Setting up

    func install(host: UIViewController, list: ChatListView) {
        self.host = host
        self.list = list
        list.onRowAction = { [weak self] (event: [String: Any]) -> Void in
            self?.act(event["id"] as? String ?? "", event["action"] as? String ?? "")
        }
        list.onRowLongPress = { [weak self] (event: [String: Any]) -> Void in
            self?.openMenu(event["id"] as? String ?? "")
        }
        searchButton.setImage(chatSymbol("magnifyingglass", 16, .semibold), for: .normal)
        searchButton.tintColor = Theme.text
        searchButton.backgroundColor = Theme.surface2
        searchButton.layer.cornerRadius = 20
        searchButton.accessibilityLabel = "Поиск"
        searchButton.addTarget(self, action: #selector(toggleSearch), for: .touchUpInside)
        host.view.addSubview(searchButton)
        searchBox.backgroundColor = Theme.surface2
        searchBox.layer.cornerRadius = 20
        searchBox.isHidden = true
        host.view.addSubview(searchBox)
        searchIcon.image = chatSymbol("magnifyingglass", 15)
        searchIcon.tintColor = Theme.muted
        searchIcon.contentMode = .center
        searchBox.addSubview(searchIcon)
        searchField.attributedPlaceholder = NSAttributedString(string: "Поиск", attributes: [.foregroundColor: Theme.muted])
        searchField.font = .systemFont(ofSize: 16)
        searchField.textColor = Theme.text
        searchField.tintColor = Theme.text
        searchField.keyboardAppearance = .dark
        searchField.autocorrectionType = .no
        searchField.autocapitalizationType = .none
        searchField.returnKeyType = .search
        searchField.accessibilityLabel = "Поиск"
        searchField.delegate = self
        searchField.addTarget(self, action: #selector(queryChanged), for: .editingChanged)
        searchBox.addSubview(searchField)
        searchClose.setImage(chatSymbol("xmark", 13, .semibold), for: .normal)
        searchClose.tintColor = Theme.muted
        searchClose.accessibilityLabel = "Закрыть поиск"
        searchClose.addTarget(self, action: #selector(toggleSearch), for: .touchUpInside)
        searchBox.addSubview(searchClose)

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(localChanged), name: ChatLocal.changed, object: nil)
        center.addObserver(self, selector: #selector(localChanged), name: ChatTyping.changed, object: nil)
    }

    /// Places the search button beside «Новый чат» and the search field under the heading. Gives the room the
    /// list must leave at the top.
    func place(in view: UIView, safeTop: CGFloat) -> CGFloat {
        let width = view.bounds.width
        searchButton.frame = CGRect(x: width - 20 - 40 - 8 - 40, y: safeTop + 8, width: 40, height: 40)
        var top = safeTop + 8 + 41 + 8
        if searching {
            searchBox.frame = CGRect(x: 16, y: top, width: width - 32, height: 40)
            searchIcon.frame = CGRect(x: 6, y: 0, width: 32, height: 40)
            searchField.frame = CGRect(x: 40, y: 0, width: max(0, searchBox.bounds.width - 40 - 40), height: 40)
            searchClose.frame = CGRect(x: searchBox.bounds.width - 40, y: 0, width: 40, height: 40)
            top += 48
        }
        return top
    }

    @objc private func localChanged() { refresh() }

    // MARK: The chats

    /// The chats as the server lists them now.
    func show(_ list: [Messenger.ChatSummary]) {
        chats = list
        refresh()
        fillQuiet()
        #if targetEnvironment(simulator)
        simulatorAct()
        #endif
    }

    private static func number(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    private func settings(_ chat: Messenger.ChatSummary) -> [String: Any] { chat.chat["settings"] as? [String: Any] ?? [:] }
    private func lastId(_ chat: Messenger.ChatSummary) -> Int { ChatListActions.number((chat.chat["lastMessage"] as? [String: Any])?["id"]) }
    private func archived(_ chat: Messenger.ChatSummary) -> Bool { settings(chat)["archived"] as? Bool ?? false }
    private func pinned(_ chat: Messenger.ChatSummary) -> Bool { settings(chat)["pinnedAt"] is String }
    private func unread(_ chat: Messenger.ChatSummary) -> Int { ChatListActions.number(chat.chat["unreadCount"]) }
    private func marked(_ chat: Messenger.ChatSummary) -> Bool { local?.isMarked(chat.id) ?? sampleMarked.contains(chat.id) }
    private func removed(_ chat: Messenger.ChatSummary) -> Bool { local?.isRemoved(chat.id, lastMessageId: lastId(chat)) ?? false }

    /// The sound is off: for good, or until a moment the clock has not reached (the reference's `isMuted`).
    private func muted(_ chat: Messenger.ChatSummary) -> Bool {
        let fields = settings(chat)
        guard fields["muted"] as? Bool == true else { return false }
        guard let until = fields["mutedUntil"] as? String, !until.isEmpty else { return true }
        guard let end = Messenger.date(until) else { return true }
        return end > Date()
    }

    /// The part of the list a chat stands in: pinned ones first, then by the day of the last message.
    private func section(_ chat: Messenger.ChatSummary) -> String {
        if pinned(chat) { return "Закреплённые" }
        if let fixed = chat.chat["sampleSection"] as? String { return fixed }
        guard let at = Messenger.date((chat.chat["lastMessage"] as? [String: Any])?["createdAt"] as? String) else { return "Раньше" }
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: at), to: calendar.startOfDay(for: Date())).day ?? 2
        return days <= 0 ? "Сегодня" : days == 1 ? "Вчера" : "Раньше"
    }

    private static func plural(_ count: Int, _ one: String, _ few: String, _ many: String) -> String {
        let last = abs(count) % 10, tens = abs(count) % 100
        if last == 1 && tens != 11 { return one }
        if last >= 2 && last <= 4 && (tens < 10 || tens >= 20) { return few }
        return many
    }

    /// «Черновик: …» for a chat with unsent text.
    private func draftLine(_ chatId: String) -> String {
        let text = local?.draft(chatId) ?? sampleDrafts[chatId] ?? ""
        let typed = text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).joined(separator: " ")
        return typed.isEmpty ? "" : ChatListActions.draftWord + " " + String(typed.prefix(160))
    }

    /// «Вы закрепили «…»» / «Имя закрепил(а) «…»» for a pin (the reference's `pinPreview`).
    private static func pinLine(_ text: String, mine: Bool, name: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var quote = ""
        if trimmed.hasSuffix("»"), let open = trimmed.firstIndex(of: "«") { quote = String(trimmed[open...]) }
        return (mine ? "Вы закрепили" : name + " закрепил(а)") + (quote.isEmpty ? " сообщение" : " " + quote)
    }

    private static func isPin(_ message: [String: Any]) -> Bool {
        guard let action = ChatHistory.action(message) else { return false }
        return action["type"] as? String == "pin" && action["target"] is String
    }

    /// A message the list looks past for the line to show (the reference's `skippedInList`): an action on
    /// another message, or a call's signalling.
    private static func skipped(_ message: [String: Any]) -> Bool {
        guard let action = ChatHistory.action(message), let type = action["type"] as? String else { return false }
        if type == "react" || type == "vote" || type == "edit" || type == "delete" { return true }
        if type == "pin" { return !(action["target"] is String) }
        if type == "call" { return action["step"] as? String != "end" }
        return false
    }

    private func special(_ id: String, title: String, preview: String, initials: String) -> [String: Any] {
        ["id": id, "title": title, "preview": preview, "time": "", "unread": 0, "initials": initials, "avatarColor": Int(0xFF16_1718), "orbA": 0, "orbB": 0, "section": ""]
    }

    private func refresh() {
        let visible = chats.filter { !removed($0) }
        let archivedCount = visible.filter { archived($0) }.count
        if archiveOpen && archivedCount == 0 { archiveOpen = false }
        let inArchive = archiveOpen
        let wanted = query.trimmingCharacters(in: .whitespaces).lowercased()
        var shown = visible.filter { archived($0) == inArchive }
        if !wanted.isEmpty {
            shown = shown.filter { (chat: Messenger.ChatSummary) -> Bool in
                let username = (chat.chat["peer"] as? [String: Any])?["username"] as? String ?? ""
                return (chat.title + " " + username).lowercased().contains(wanted)
            }
        }
        var rows: [[String: Any]] = []
        if inArchive {
            rows.append(special(ChatListActions.backRow, title: "‹ Архив", preview: "Вернуться к чатам", initials: "‹"))
        } else if archivedCount > 0 && wanted.isEmpty {
            let count = "\(archivedCount) " + ChatListActions.plural(archivedCount, "чат", "чата", "чатов")
            rows.append(special(ChatListActions.archiveRow, title: "Архив", preview: count, initials: "▤"))
        }
        let hidden = Set(local?.hiddenKeys ?? [])
        var part = ""
        for chat in shown {
            var row = chat.row
            let quiet = muted(chat)
            let isPinned = pinned(chat)
            let count = unread(chat)
            let isMarked = marked(chat)
            row["muted"] = quiet
            row["pinned"] = isPinned
            row["title"] = chat.title + (quiet ? " 🔕" : "")
            row["unread"] = count > 0 ? count : (isMarked ? 1 : 0)
            let draft = draftLine(chat.id)
            if ChatTyping.shared.isTyping(chat.id) {
                row["preview"] = "Печатает…"
                row["accentPreview"] = true
                row["previewIcon"] = ""
            } else if !draft.isEmpty {
                row["preview"] = draft
                row["previewRed"] = (ChatListActions.draftWord as NSString).length
                row["previewIcon"] = ""
            } else if !chat.last.isEmpty {
                let mine = chat.last["senderId"] as? String == messenger?.userId
                if let fill = fills[chat.id], fill.lastId == lastId(chat) {
                    row["preview"] = fill.line
                } else if ChatListActions.skipped(chat.last) || hidden.contains(ChatHistory.key(chat.last)) {
                    // Until the line to show is found: nothing, never the hidden text.
                    row["preview"] = ""
                } else if ChatListActions.isPin(chat.last) {
                    row["preview"] = ChatListActions.pinLine(chat.last["text"] as? String ?? "", mine: mine, name: chat.title)
                }
            }
            // The buttons behind the row (the reference's `rowActions`): the outermost first.
            let lead: [String] = [count > 0 || isMarked ? "read" : "unread", isPinned ? "unpin" : "pin"]
            let trail: [String] = [inArchive ? "unarchive" : "archive", "delete", quiet ? "unmute" : "mute"]
            row["lead"] = lead.map { $0 + ":" + (ChatListActions.swipeWords[$0] ?? $0) }
            row["trail"] = trail.map { $0 + ":" + (ChatListActions.swipeWords[$0] ?? $0) }
            let own = inArchive || !wanted.isEmpty ? "" : section(chat)
            row["section"] = own != part ? own : ""
            part = own
            rows.append(row)
        }
        // «Сообщения»: what the history kept on this device holds, newest first; a touch opens the chat at that message.
        for (index, hit) in hits.enumerated() {
            guard let chat = chats.first(where: { $0.id == hit.chatId }) else { continue }
            var row = chat.row
            row["id"] = "msg|" + hit.chatId + "|" + hit.clientId
            row["preview"] = ChatListActions.snippet(hit.text, around: wanted)
            row["time"] = Messenger.listTime(hit.sentAt)
            row["section"] = index == 0 ? "Сообщения" : ""
            row["unread"] = 0
            row["ticks"] = 0
            row["pinned"] = false
            row["muted"] = false
            row["previewIcon"] = ""
            row["thumb"] = ""
            rows.append(row)
        }
        var words = "Пока нет чатов"
        if !wanted.isEmpty { words = searchingHistory ? "Поиск…" : "Ничего не нашли." }
        onHeading?(inArchive ? "Архив" : "Чаты")
        onRows?(ChatRow.parse(rows), words)
    }

    private var searchingHistory = false

    /// The line of a found message: the words around the place where the query stands.
    private static func snippet(_ text: String, around wanted: String) -> String {
        let flat = text.split(whereSeparator: { $0 == "\n" || $0 == "\t" }).joined(separator: " ")
        guard !wanted.isEmpty, let found = flat.lowercased().range(of: wanted) else { return String(flat.prefix(160)) }
        let before = flat.lowercased().distance(from: flat.lowercased().startIndex, to: found.lowerBound)
        if before <= 24 || before >= flat.count { return String(flat.prefix(160)) }
        return "…" + String(flat.dropFirst(before - 16).prefix(160))
    }

    /// For chats whose last message is a reaction, an edit, a deletion (or is hidden on this device), the line
    /// to show is looked up in the history kept here — the newest message that is one to show (the core's
    /// `listPreviewMessage`). The server cannot do it: to the server they are all the same ciphertext.
    private func fillQuiet() {
        guard let messenger, let local else { return }
        let hidden = Set(local.hiddenKeys)
        var wantedChats: [(id: String, lastId: Int, title: String)] = []
        for chat in chats where !chat.last.isEmpty {
            let last = lastId(chat)
            guard ChatListActions.skipped(chat.last) || hidden.contains(ChatHistory.key(chat.last)) else { continue }
            let mark = chat.id + ":" + String(last)
            if asked.contains(mark) { continue }
            asked.insert(mark)
            wantedChats.append((id: chat.id, lastId: last, title: chat.title))
        }
        guard !wantedChats.isEmpty else { return }
        let me = messenger.userId
        let asks = wantedChats
        messenger.crypto.run({ (crypto: CryptoService) -> [String: String] in
            var lines: [String: String] = [:]
            for chat in asks {
                guard case .success(let value) = crypto.callNow("history", [chat.id, 120]), let kept = value as? [[String: Any]] else { continue }
                // Newest first, as the history gives them; numbered so that the core reads the same order.
                var numbered: [[String: Any]] = []
                for (index, item) in kept.enumerated() where !hidden.contains(ChatHistory.key(item)) {
                    var message = item
                    message["id"] = kept.count - index
                    if message["createdAt"] == nil, let sent = item["sentAt"] as? String { message["createdAt"] = sent }
                    numbered.append(message)
                }
                guard let line = Core.view("listPreviewMessage", [numbered]) as? [String: Any] else { continue }
                var words = Core.view("chatListText", [line]) as? String ?? ""
                if words.isEmpty { words = Messenger.previewText(line) }
                if ChatListActions.isPin(line) { words = ChatListActions.pinLine(words, mine: line["senderId"] as? String == me, name: chat.title) }
                lines[chat.id] = words
            }
            return lines
        }, done: { [weak self] (lines: [String: String]) -> Void in
            guard let self else { return }
            for chat in asks {
                if let line = lines[chat.id] { self.fills[chat.id] = (lastId: chat.lastId, line: line) }
            }
            self.refresh()
        })
    }

    // MARK: A touch on a row

    /// A row was touched. True when it was dealt with here; false leaves it to the screen (the sample chats).
    func pressed(_ id: String) -> Bool {
        if id == ChatListActions.archiveRow {
            archiveOpen = true
            refresh()
            return true
        }
        if id == ChatListActions.backRow {
            archiveOpen = false
            refresh()
            return true
        }
        if id.hasPrefix("msg|") {
            let parts = id.split(separator: "|").map(String.init)
            if parts.count == 3 { open(parts[1], focus: parts[2]) }
            return true
        }
        guard messenger != nil else { return false }
        open(id, focus: "")
        return true
    }

    /// Opens a chat; with `focus`, at that message.
    func open(_ chatId: String, focus: String, animated: Bool = true) {
        guard let messenger, let chat = chats.first(where: { $0.id == chatId }) else { return }
        let screen = ChatViewController(name: chat.title, messenger: messenger, chatId: chat.id, peerId: chat.peerId)
        screen.peerLastRead = chat.peerLastRead
        screen.actions.opened(chat)
        if !focus.isEmpty { screen.actions.focus(clientId: focus) }
        // Opening the chat reads it: the hand-made mark goes too.
        if local?.isMarked(chat.id) == true { local?.setMarked(chat.id, false) }
        host?.view.endEditing(true)
        host?.navigationController?.pushViewController(screen, animated: animated)
    }

    // MARK: What can be done with a chat

    /// A swipe button of a row.
    private func act(_ id: String, _ action: String) {
        guard let chat = chats.first(where: { $0.id == id }) else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        switch action {
        case "read": read(chat)
        case "unread": mark(chat, true)
        case "pin", "unpin": change(chat, ["pinned": action == "pin"])
        case "mute", "unmute": askMute(chat)
        case "delete": askRemove(chat)
        case "archive", "unarchive": change(chat, ["archived": action == "archive"])
        default: break
        }
    }

    /// A long press: the same choices as a list.
    private func openMenu(_ id: String) {
        guard let host, host.presentedViewController == nil, let chat = chats.first(where: { $0.id == id }) else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let isUnread = unread(chat) > 0 || marked(chat)
        let isPinned = pinned(chat), quiet = muted(chat), isArchived = archived(chat)
        var choices: [ChoiceSheet.Choice] = []
        if isUnread {
            choices.append(ChoiceSheet.Choice(symbol: "bubble.left", label: "Пометить как прочитанное", run: { [weak self] in self?.read(chat) }))
        } else {
            choices.append(ChoiceSheet.Choice(symbol: "bubble.left.fill", label: "Пометить как непрочитанное", run: { [weak self] in self?.mark(chat, true) }))
        }
        choices.append(ChoiceSheet.Choice(symbol: isPinned ? "pin.slash" : "pin", label: isPinned ? "Открепить" : "Закрепить", run: { [weak self] in self?.change(chat, ["pinned": !isPinned]) }))
        choices.append(ChoiceSheet.Choice(symbol: quiet ? "bell" : "bell.slash", label: quiet ? "Включить звук" : "Выключить звук", run: { [weak self] in self?.askMute(chat) }))
        choices.append(ChoiceSheet.Choice(symbol: "archivebox", label: isArchived ? "Вернуть из архива" : "В архив", run: { [weak self] in self?.change(chat, ["archived": !isArchived]) }))
        choices.append(ChoiceSheet.Choice(symbol: "trash", label: "Удалить чат", danger: true, run: { [weak self] in self?.askRemove(chat) }))
        host.present(ChoiceSheet(heading: chat.title, choices: choices), animated: true)
    }

    private func say(_ words: String) {
        let alert = UIAlertController(title: nil, message: words, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
        host?.present(alert, animated: true)
    }

    private func mark(_ chat: Messenger.ChatSummary, _ on: Bool) {
        if let local {
            local.setMarked(chat.id, on)
        } else {
            if on { sampleMarked.insert(chat.id) } else { sampleMarked.remove(chat.id) }
            refresh()
        }
    }

    /// «Прочитано»: read up to the newest message the server has (reactions and edits are messages too), and the
    /// hand-made mark goes.
    private func read(_ chat: Messenger.ChatSummary) {
        if marked(chat) { mark(chat, false) }
        if unread(chat) > 0 {
            messenger?.markRead(chatId: chat.id, messageId: lastId(chat))
            patch(chat.id) { (fields: inout [String: Any]) -> Void in fields["unreadCount"] = 0 }
        }
    }

    /// Changes the copy of a chat held here, so the row answers at once; the server's word follows.
    private func patch(_ chatId: String, _ change: (inout [String: Any]) -> Void) {
        guard let index = chats.firstIndex(where: { $0.id == chatId }) else { return }
        var fields = chats[index].chat
        change(&fields)
        chats[index].chat = fields
        refresh()
    }

    /// Pin, archive, sound: the chat's own settings on the server (they follow the account to its other devices).
    private func change(_ chat: Messenger.ChatSummary, _ update: [String: Any]) {
        patch(chat.id) { (fields: inout [String: Any]) -> Void in
            var kept = fields["settings"] as? [String: Any] ?? [:]
            if let on = update["pinned"] as? Bool {
                if on { kept["pinnedAt"] = ISO8601DateFormatter().string(from: Date()) } else { kept["pinnedAt"] = NSNull() }
            }
            if let on = update["archived"] as? Bool { kept["archived"] = on }
            if let on = update["muted"] as? Bool {
                kept["muted"] = on
                kept["mutedUntil"] = NSNull()
            }
            if let until = update["mutedUntil"] as? String {
                kept["muted"] = true
                kept["mutedUntil"] = until
            }
            fields["settings"] = kept
        }
        guard let messenger else { return }
        messenger.server.op("chatSettings", [chat.id, update]) { [weak self] (result: Result<Any, ServerError>) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .failure(let error) = result { self.say(error.words.isEmpty ? "Не удалось изменить чат." : error.words) }
                self.onReload?()
            }
        }
    }

    private static let months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]

    /// «до 18:30», «до завтра, 09:15», «до 12 марта, 09:15» — when the sound comes back (the reference's `muteUntilLabel`).
    private static func untilWords(_ end: Date) -> String {
        let calendar = Calendar.current
        let now = Date()
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: end)
        let time = String(format: "%02ld:%02ld", parts.hour ?? 0, parts.minute ?? 0)
        if calendar.isDate(end, inSameDayAs: now) { return "до " + time }
        if calendar.isDateInTomorrow(end) { return "до завтра, " + time }
        let month = months[max(0, min(11, (parts.month ?? 1) - 1))]
        let year = parts.year == calendar.component(.year, from: now) ? "" : " \(parts.year ?? 0)"
        return "до \(parts.day ?? 1) \(month)\(year), \(time)"
    }

    /// «Выключить звук»: a chat without sound gets it back in one touch; otherwise the sheet asks for how long.
    private func askMute(_ chat: Messenger.ChatSummary) {
        if muted(chat) {
            change(chat, ["muted": false])
            return
        }
        let spans: [(String, TimeInterval)] = [("На 1 час", 3600), ("На 8 часов", 8 * 3600), ("На 2 дня", 2 * 86400)]
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var choices: [ChoiceSheet.Choice] = []
        for span in spans {
            let preview = Date().addingTimeInterval(span.1)
            choices.append(ChoiceSheet.Choice(symbol: "clock", label: span.0, note: "Без звука " + ChatListActions.untilWords(preview) + ".", run: { [weak self] in
                // Counted from the moment of the choice, not from the moment the sheet was opened.
                self?.change(chat, ["mutedUntil": stamp.string(from: Date().addingTimeInterval(span.1))])
            }))
        }
        choices.append(ChoiceSheet.Choice(symbol: "bell.slash", label: "Навсегда", note: "Пока не включишь снова. Звонки продолжат звонить.", run: { [weak self] in
            self?.change(chat, ["muted": true])
        }))
        host?.present(ChoiceSheet(heading: "Выключить звук", note: chat.title, choices: choices), animated: true)
    }

    /// «Удалить чат?»: for me (this device) or for both (the server).
    private func askRemove(_ chat: Messenger.ChatSummary) {
        let choices: [ChoiceSheet.Choice] = [
            ChoiceSheet.Choice(symbol: "trash", label: "Удалить у меня", note: "Чат и загруженные сообщения исчезнут на этом устройстве. Если собеседник напишет снова, чат вернётся.", danger: true, run: { [weak self] in
                self?.removeForMe(chat)
            }),
            ChoiceSheet.Choice(symbol: "person.2", label: "Удалить у меня и у собеседника", note: "Чат, все сообщения и файлы будут удалены на сервере и у обоих. Отменить нельзя.", danger: true, run: { [weak self] in
                self?.removeForEveryone(chat)
            }),
        ]
        host?.present(ChoiceSheet(heading: "Удалить чат?", choices: choices), animated: true)
    }

    /// The chat leaves the list until a newer message comes; the messages kept here are hidden for good, and
    /// what the chat left in the private storage (its history names, its unsent messages) goes.
    private func removeForMe(_ chat: Messenger.ChatSummary) {
        guard let messenger, let local else {
            chats.removeAll { $0.id == chat.id }
            refresh()
            return
        }
        local.removeChat(chat.id, lastMessageId: lastId(chat))
        refresh()
        let chatId = chat.id
        messenger.crypto.run({ (crypto: CryptoService) -> [String] in
            var keys: [String] = []
            if case .success(let value) = crypto.callNow("history", [chatId, 2000]), let kept = value as? [[String: Any]] {
                keys = kept.map { ChatHistory.key($0) }
            }
            _ = crypto.callNow("forgetChat", [chatId])
            return keys
        }, done: { (keys: [String]) -> Void in
            local.hide(keys)
        })
    }

    private func removeForEveryone(_ chat: Messenger.ChatSummary) {
        guard let messenger else {
            chats.removeAll { $0.id == chat.id }
            refresh()
            return
        }
        let chatId = chat.id
        messenger.server.op("deleteChatForEveryone", [chatId]) { [weak self] (result: Result<Any, ServerError>) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.say(error.words.isEmpty ? "Не удалось удалить чат. Попробуй ещё раз." : error.words)
                case .success:
                    messenger.crypto.call("forgetChat", [chatId]) { (_: Result<Any, CryptoFailure>) -> Void in }
                    self.chats.removeAll { $0.id == chatId }
                    self.refresh()
                    self.onReload?()
                }
            }
        }
    }

    // MARK: The search

    @objc private func toggleSearch() {
        searching.toggle()
        searchBox.isHidden = !searching
        if searching {
            searchField.becomeFirstResponder()
        } else {
            searchField.text = ""
            searchField.resignFirstResponder()
            setQuery("")
        }
        host?.view.setNeedsLayout()
    }

    @objc private func queryChanged() {
        setQuery(searchField.text ?? "")
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return false
    }

    private func setQuery(_ text: String) {
        query = text
        hits = []
        searchRun += 1
        searchSoon?.cancel()
        let wanted = text.trimmingCharacters(in: .whitespaces).lowercased()
        searchingHistory = wanted.count >= 2 && messenger != nil
        refresh()
        guard searchingHistory else { return }
        let run = searchRun
        let work = DispatchWorkItem { [weak self] in self?.searchHistory(wanted, run: run) }
        searchSoon = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    /// Looks for the words in the decrypted history kept on this device (nothing is asked of the server: it has
    /// only ciphertext). Messages hidden here and the actions on messages are not results.
    private func searchHistory(_ wanted: String, run: Int) {
        guard let messenger, let local, run == searchRun else { return }
        let known = Set(chats.filter { !removed($0) }.map { $0.id })
        let hidden = Set(local.hiddenKeys)
        messenger.crypto.run({ (crypto: CryptoService) -> [Hit] in
            var found: [Hit] = []
            guard case .success(let value) = crypto.callNow("historyChats"), let ids = value as? [String] else { return found }
            for chatId in ids where known.contains(chatId) {
                guard case .success(let page) = crypto.callNow("history", [chatId, 600]), let kept = page as? [[String: Any]] else { continue }
                for item in kept {
                    guard let text = item["text"] as? String, !text.isEmpty, ChatHistory.action(item) == nil, text.lowercased().contains(wanted),
                          let clientId = item["clientId"] as? String, !hidden.contains(ChatHistory.key(item)) else { continue }
                    found.append(Hit(chatId: chatId, clientId: clientId, text: text, sentAt: item["sentAt"] as? String ?? ""))
                }
            }
            found.sort { $0.sentAt > $1.sentAt }
            return Array(found.prefix(60))
        }, done: { [weak self] (found: [Hit]) -> Void in
            guard let self, run == self.searchRun else { return }
            self.searchingHistory = false
            self.hits = found
            self.refresh()
        })
    }

    // MARK: The simulator check

    #if targetEnvironment(simulator)
    private var simulatorDone = false

    /// The sample list (no account): the same rows as before, as chats the actions can work on.
    func showSamples(_ rows: [ChatRow]) {
        var part = ""
        var made: [Messenger.ChatSummary] = []
        for (index, row) in rows.enumerated() {
            if !row.section.isEmpty { part = row.section }
            var settings: [String: Any] = ["muted": row.muted, "archived": false]
            if row.pinned { settings["pinnedAt"] = "2026-11-20T09:00:00.000Z" }
            let fields: [String: Any] = ["id": row.id, "title": row.title, "preview": row.preview, "time": row.time, "unread": row.unread, "muted": row.muted, "pinned": row.pinned,
                                         "ticks": row.ticks, "avatarColor": row.avatarColor, "initials": row.initials, "orbA": row.orbA, "orbB": row.orbB, "section": row.section,
                                         "previewIcon": row.previewIcon]
            let chat: [String: Any] = ["settings": settings, "unreadCount": row.unread, "sampleSection": part == "Закреплённые" ? "Сегодня" : part]
            made.append(Messenger.ChatSummary(id: row.id, peerId: "demo-person-\(index)", title: row.title, peerLastRead: 0, row: fields, chat: chat, last: [:]))
        }
        show(made)
    }

    /// What the simulator check asks of the list, once it has chats (with an account or with -demo 1):
    ///   -chatlist menu|mute|delete|archive|archived|draft|unread     on the first chat (archive: on the last one)
    ///   -chatsearch <query>                                          the search field with these words
    private func simulatorAct() {
        guard !simulatorDone, let first = chats.first, let last = chats.last else { return }
        simulatorDone = true
        let args = UserDefaults.standard
        if let wanted = args.string(forKey: "chatsearch"), !wanted.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self else { return }
                if !self.searching { self.toggleSearch() }
                self.searchField.text = wanted
                self.searchField.resignFirstResponder()
                self.setQuery(wanted)
            }
            return
        }
        guard let ask = args.string(forKey: "chatlist"), !ask.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            switch ask {
            case "menu": self.openMenu(first.id)
            case "mute": self.askMute(self.chats.first(where: { !self.muted($0) }) ?? first)
            case "delete": self.askRemove(first)
            case "unread": self.mark(last, true)
            case "archive", "archived":
                if !self.archived(last) { self.change(last, ["archived": true]) }
                if ask == "archived" {
                    self.archiveOpen = true
                    self.refresh()
                }
            case "draft":
                if let local = self.local { local.setDraft(first.id, "Не забыть спросить про проектор") } else {
                    self.sampleDrafts[first.id] = "Не забыть спросить про проектор"
                    self.refresh()
                }
            default: break
            }
        }
    }
    #endif
}
