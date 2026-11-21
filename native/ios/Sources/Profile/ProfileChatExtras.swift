import UIKit

// What a person's profile offers when it is opened from the chat with them (the reference's UserProfile.tsx with
// ChatScreen.tsx's props `onMute`, `onSearch`, `shared`, `onOpenAttachment`, `onWallpaper`, `rules`, `onRules`,
// `onClear`, and SharedMedia.tsx, ChatSheets.tsx, notifications/MuteSheet.tsx):
//   ProfileChatLink     the open chat as the profile sees it: its decrypted history, its encrypted rules, its sound
//   ProfileChatExtras   the «Звук» tile's words, the sheets (sound, «Автоудаление», «Очистить историю?»), the
//                       items of «Ещё» (auto-delete, no copying, wallpaper, search, clear history)
//   SharedMediaView     «Фото · Видео · Файлы · Голосовые · Ссылки» of the chat, from this device's history only

/// The chat a profile was opened from. Everything goes through the chat screen's own objects: the rules and the
/// clearing are end-to-end encrypted chat actions (`settings`, `clear`) folded by the core like any other.
final class ProfileChatLink {
    private(set) weak var chat: ChatViewController?
    let chatId: String

    init(chat: ChatViewController) {
        self.chat = chat
        chatId = chat.actions.history.chatId
    }

    #if targetEnvironment(simulator)
    /// The simulator's sample history for the shared media (no account).
    var sampleMessages: [[String: Any]]?
    #endif

    /// The chat's messages as this device decrypted them, oldest first (what SharedMedia.tsx is given).
    var messages: [[String: Any]] {
        #if targetEnvironment(simulator)
        if let sampleMessages { return sampleMessages }
        #endif
        guard let shown = chat?.actions.history.shown else { return [] }
        return shown.order.compactMap { (key: String) -> [String: Any]? in
            guard var message = shown.messages[key] else { return nil }
            message["rowKey"] = key
            return message
        }
    }

    /// The encrypted rules: «Автоудаление» (seconds, 0 = off) and «копирование запрещено».
    var ttl: Int { return Int(chat?.actions.history.shown.ttl ?? 0) }
    var noCopy: Bool { return chat?.actions.history.shown.noCopy ?? false }

    func setRules(ttl: Int, noCopy: Bool) {
        chat?.actions.history.sendAction(["type": "settings", "ttl": ttl, "noCopy": noCopy])
    }

    /// «Удалить у обоих».
    func clearForBoth() {
        chat?.actions.history.sendAction(["type": "clear"])
    }

    /// The chat's own settings as the list last read them (the sound).
    var settings: [String: Any] {
        get { return ChatLookUnread.settingsOf[chatId] ?? [:] }
        set { ChatLookUnread.settingsOf[chatId] = newValue }
    }

    /// The profile closes, then the chat does the rest (as the reference: `onClose()` and the chat's own action).
    func afterClosing(_ profile: UIViewController, delay: TimeInterval, _ run: @escaping (ChatViewController) -> Void) {
        guard let chat else { return }
        if let stack = profile.navigationController, stack.viewControllers.contains(chat) {
            stack.popToViewController(chat, animated: true)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak chat] in
            if let chat { run(chat) }
        }
    }

    func openSearch(from profile: UIViewController) {
        afterClosing(profile, delay: 0.35) { (chat: ChatViewController) -> Void in chat.actions.openSearch() }
    }

    func openWallpaper(from profile: UIViewController) {
        let chatId = self.chatId
        afterClosing(profile, delay: 0.35) { (chat: ChatViewController) -> Void in WallpaperPickerController.present(over: chat, chatId: chatId) }
    }

    /// An attachment of the shared media: the profile closes and the chat opens it as a touch on its row would.
    func openAttachment(key: String, from profile: UIViewController) {
        afterClosing(profile, delay: 0.25) { (chat: ChatViewController) -> Void in chat.actions.openAttachment(key: key) }
    }
}

enum ProfileChatExtras {
    // MARK: The sound (notifications/model.ts)

    /// The sound is off: for good, or until a moment the clock has not reached (`isMuted`).
    static func muted(_ settings: [String: Any], now: Date = Date()) -> Bool {
        guard settings["muted"] as? Bool == true else { return false }
        guard let until = settings["mutedUntil"] as? String, !until.isEmpty else { return true }
        guard let end = Messenger.date(until) else { return true }
        return end > now
    }

    private static let months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]

    /// «18:30», «завтра, 09:15», «12 марта, 09:15», «3 января 2027, 09:15» (`muteEndLabel`).
    static func endLabel(_ end: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: end)
        let time = String(format: "%02ld:%02ld", parts.hour ?? 0, parts.minute ?? 0)
        if calendar.isDate(end, inSameDayAs: now) { return time }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(end, inSameDayAs: tomorrow) { return "завтра, " + time }
        let month = months[max(0, min(11, (parts.month ?? 1) - 1))]
        let year = parts.year == calendar.component(.year, from: now) ? "" : " \(parts.year ?? 0)"
        return "\(parts.day ?? 1) \(month)\(year), \(time)"
    }

    /// «до 18:30», «до завтра, 09:15», «навсегда» (`muteUntilLabel`).
    static func untilLabel(_ until: String?) -> String {
        guard let until, !until.isEmpty, let end = Messenger.date(until) else { return "навсегда" }
        return "до " + endLabel(end)
    }

    private static let stamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// «Выключить звук» (MuteSheet.tsx): «На 1 час / На 8 часов / На 2 дня / Навсегда / Настроить…». `pick` gets the
    /// end (ISO) or nil for «Навсегда».
    static func muteSheet(title: String, over host: UIViewController, pick: @escaping (String?) -> Void) {
        let spans: [(String, TimeInterval)] = [("На 1 час", 3600), ("На 8 часов", 8 * 3600), ("На 2 дня", 2 * 86400)]
        var choices: [ChoiceSheet.Choice] = []
        for span in spans {
            let preview = Date().addingTimeInterval(span.1)
            choices.append(ChoiceSheet.Choice(symbol: "clock", label: span.0, note: "Без звука до " + endLabel(preview) + ".", run: {
                Haptic.light()
                // Counted from the moment of the choice, not from the moment the sheet was opened.
                pick(stamp.string(from: Date().addingTimeInterval(span.1)))
            }))
        }
        choices.append(ChoiceSheet.Choice(symbol: "bell.slash", label: "Навсегда", note: "Пока не включишь снова. Звонки продолжат звонить.", run: {
            Haptic.light()
            pick(nil)
        }))
        choices.append(ChoiceSheet.Choice(symbol: "slider.horizontal.3", label: "Настроить…", note: "Своё время: дни, часы и минуты.", run: { [weak host] in
            Haptic.light()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                guard let host, host.presentedViewController == nil else { return }
                let custom = MuteCustomSheet(done: { (until: String) -> Void in pick(until) })
                custom.onBack = { [weak host] in
                    guard let host else { return }
                    ProfileChatExtras.muteSheet(title: title, over: host, pick: pick)
                }
                host.present(custom, animated: true)
            }
        }))
        host.present(ChoiceSheet(heading: "Выключить звук", note: title, choices: choices), animated: true)
    }

    /// Sends a change of the chat's sound to the server (`chatSettings`) and keeps the copy the list and the profile
    /// read in step. `done` gets nil on success or the words of the failure (main queue).
    static func changeSound(_ link: ProfileChatLink, messenger: Messenger?, update: [String: Any], done: @escaping (String?) -> Void) {
        var kept = link.settings
        if let on = update["muted"] as? Bool {
            kept["muted"] = on
            kept["mutedUntil"] = NSNull()
        }
        if let until = update["mutedUntil"] as? String {
            kept["muted"] = true
            kept["mutedUntil"] = until
        }
        guard let messenger else {
            #if targetEnvironment(simulator)
            link.settings = kept
            done(nil)
            #endif
            return
        }
        messenger.server.op("chatSettings", [link.chatId, update]) { (result: Result<Any, ServerError>) -> Void in
            DispatchQueue.main.async {
                switch result {
                case .success:
                    link.settings = kept
                    done(nil)
                case .failure(let error):
                    done(error.words.isEmpty ? "Не удалось изменить уведомления." : error.words)
                }
            }
        }
    }

    // MARK: The rules (ChatSheets.tsx, messageMeta.ts)

    static let autoDelete: [Int] = [0, 86400, 604800, 2592000]

    static func autoDeleteLabel(_ ttl: Int) -> String {
        return ttl == 86400 ? "1 день" : ttl == 604800 ? "1 неделя" : ttl == 2592000 ? "1 месяц" : "Выкл."
    }

    static func autoDeleteNotice(_ ttl: Int) -> String {
        return ttl != 0 ? "Автоудаление: " + autoDeleteLabel(ttl) : "Автоудаление выключено"
    }

    static func noCopyNotice(wasNoCopy: Bool) -> String {
        return wasNoCopy ? "Копирование снова разрешено" : "Копировать и пересылать сообщения этого чата теперь нельзя обоим"
    }

    /// «Автоудаление»: `pick` gets a new value only (the sheet closes either way).
    static func autoDeleteSheet(current: Int, over host: UIViewController, pick: @escaping (Int) -> Void) {
        let choices = autoDelete.map { (ttl: Int) -> ChoiceSheet.Choice in
            ChoiceSheet.Choice(symbol: ttl == current ? "checkmark.circle.fill" : "circle", label: ttl != 0 ? autoDeleteLabel(ttl) : "Выключено", run: {
                if ttl != current {
                    Haptic.light()
                    pick(ttl)
                }
            })
        }
        host.present(ChoiceSheet(heading: "Автоудаление", note: "Новые сообщения в этом чате удалятся у вас обоих через выбранное время. Собеседник увидит, что автоудаление включено.", choices: choices), animated: true)
    }

    /// «Очистить историю?» → «Удалить у обоих».
    static func clearSheet(name: String, over host: UIViewController, confirm: @escaping () -> Void) {
        let choice = ChoiceSheet.Choice(symbol: "trash", label: "Удалить у обоих", note: "Все сообщения исчезнут у тебя и у \(name). Вернуть не получится.", danger: true, run: confirm)
        host.present(ChoiceSheet(heading: "Очистить историю?", choices: [choice]), animated: true)
    }

    /// The items of «Ещё» that belong to the chat, in the reference's order: «Автоудаление · …», «Запретить /
    /// Разрешить пересылку и копирование», «Обои», «Поиск»; and, apart, «Очистить историю».
    static func menuItems(_ link: ProfileChatLink, profile: UIViewController, name: String, notice: @escaping (String) -> Void) -> (top: [UIMenuElement], clear: UIMenuElement) {
        let ttl = link.ttl
        let noCopy = link.noCopy
        var top: [UIMenuElement] = []
        top.append(UIAction(title: "Автоудаление · " + autoDeleteLabel(ttl), image: UIImage(systemName: "timer")) { [weak profile, weak link] (_: UIAction) -> Void in
            guard let profile, let link else { return }
            ProfileChatExtras.autoDeleteSheet(current: link.ttl, over: profile) { (next: Int) -> Void in
                link.setRules(ttl: next, noCopy: link.noCopy)
                notice(ProfileChatExtras.autoDeleteNotice(next))
            }
        })
        top.append(UIAction(title: noCopy ? "Разрешить пересылку и копирование" : "Запретить пересылку и копирование",
                            image: UIImage(systemName: noCopy ? "lock.fill" : "lock.open")) { [weak link] (_: UIAction) -> Void in
            guard let link else { return }
            Haptic.light()
            link.setRules(ttl: link.ttl, noCopy: !noCopy)
            notice(ProfileChatExtras.noCopyNotice(wasNoCopy: noCopy))
        })
        top.append(UIAction(title: "Обои", image: UIImage(systemName: "photo")) { [weak profile, weak link] (_: UIAction) -> Void in
            guard let profile, let link else { return }
            link.openWallpaper(from: profile)
        })
        top.append(UIAction(title: "Поиск", image: UIImage(systemName: "magnifyingglass")) { [weak profile, weak link] (_: UIAction) -> Void in
            guard let profile, let link else { return }
            link.openSearch(from: profile)
        })
        let clear = UIAction(title: "Очистить историю", image: UIImage(systemName: "trash")) { [weak profile, weak link] (_: UIAction) -> Void in
            guard let profile, let link else { return }
            ProfileChatExtras.clearSheet(name: name, over: profile) {
                link.clearForBoth()
                notice("История очищена у обоих")
            }
        }
        return (top, clear)
    }

    #if targetEnvironment(simulator)
    // MARK: The simulator checks

    /// -profiledemo chatprofile | chatprofile-more | chatprofile-files | chatprofile-mute | chatprofile-ttl
    ///   the profile opened from the sample chat: «Звонок · Видео · Звук · Поиск · Ещё», the shared media (photos;
    ///   «-files»: the «Файлы» tab), «Ещё» with the chat's items, the sound sheet, «Автоудаление».
    static func simulator(_ what: String, stack: UINavigationController) {
        guard what.hasPrefix("chatprofile") else { return }
        let chat = ChatViewController(name: "Алиса Воронцова")
        stack.pushViewController(chat, animated: false)
        chat.loadViewIfNeeded()
        let link = ProfileChatLink(chat: chat)
        link.sampleMessages = sampleHistory()
        let friend = ProfileSamples.platinaFriend
        let profile = PersonProfileViewController(messenger: nil, userId: friend.id, name: friend.displayName, person: friend, chatId: "demo")
        profile.chatLink = link
        stack.pushViewController(profile, animated: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            switch what {
            case "chatprofile-files": profile.simulatorSharedTab("files")
            case "chatprofile-mute": ProfileChatExtras.muteSheet(title: friend.displayName, over: profile) { (_: String?) -> Void in }
            case "chatprofile-ttl": ProfileChatExtras.autoDeleteSheet(current: 604800, over: profile) { (_: Int) -> Void in }
            case "chatprofile-more": profile.simulatorOpenMore()
            default: profile.simulatorScrollToShared()
            }
        }
    }

    /// Photos, a video, files, voice and round video messages and links, as a chat leaves them.
    static func sampleHistory() -> [[String: Any]] {
        var list: [[String: Any]] = []
        let start = Date().addingTimeInterval(-86400 * 9)
        func add(_ text: String, _ attachment: [String: Any]?, _ days: Double) {
            let id = list.count + 1
            var message: [String: Any] = ["id": id, "senderId": id % 2 == 0 ? "demo-me" : "demo-peer", "clientId": "c\(id)", "text": text,
                                          "createdAt": stamp.string(from: start.addingTimeInterval(days * 86400)), "cryptoState": "decrypted", "rowKey": "k\(id)"]
            message["attachment"] = attachment ?? NSNull()
            list.append(message)
        }
        for index in 0..<7 {
            let picture = ChatAttachments.demoPicture(width: 240, height: 240).jpegData(compressionQuality: 0.6)?.base64EncodedString() ?? ""
            add("", ["id": "p\(index)", "name": "photo.jpg", "mimeType": "image/jpeg", "size": 180_000 + index * 9000, "preview": ["base64": picture]], Double(index) * 0.7)
        }
        let still = ChatAttachments.demoPicture(width: 240, height: 160).jpegData(compressionQuality: 0.6)?.base64EncodedString() ?? ""
        add("", ["id": "v1", "name": "walk.mp4", "mimeType": "video/mp4", "size": 8_400_000, "preview": ["base64": still], "media": ["durationMs": 74_000]], 5)
        add("", ["id": "f1", "name": "Отчёт за ноябрь.pdf", "mimeType": "application/pdf", "size": 1_240_000], 5.5)
        add("", ["id": "f2", "name": "Таблица.xlsx", "mimeType": "application/vnd.ms-excel", "size": 86_000], 6)
        add("", ["id": "a1", "name": "voice-1730000000.m4a", "mimeType": "audio/mp4", "size": 42_000], 6.5)
        add("", ["id": "a2", "name": "circle-1730000001.mp4", "mimeType": "video/mp4", "size": 900_000], 7)
        add("Посмотри https://example.org/articles/notes — там про это", nil, 7.5)
        add("Билеты тут: https://tickets.example.com/event/42.", nil, 8)
        return list
    }
    #endif
}

/// «Фото · Видео · Файлы · Голосовые · Ссылки» (SharedMedia.tsx): everything shared in the chat, from the history
/// decrypted on this device — nothing is asked from the server. Only tabs with something in them are shown; a
/// sideways swipe over the content moves between them (the content follows the finger at 0.35 and dims; the first
/// tab lets a swipe to the right go to the screen's own swipe back).
final class SharedMediaView: UIView, UIGestureRecognizerDelegate {
    enum Tab: String { case photos, videos, files, voice, links }

    private struct Item {
        let attachment: [String: Any]
        let message: [String: Any]
    }

    private struct LinkItem {
        let url: String
        let message: [String: Any]
    }

    /// A touch on a photo, a video, a file or a voice message: the message's row key.
    var onOpen: ((String) -> Void)?

    private let column = UIStackView()
    private let strip = UIScrollView()
    private let stripRow = UIStackView()
    private let body = UIStackView()
    private var photos: [Item] = []
    private var videos: [Item] = []
    private var files: [Item] = []
    private var voice: [Item] = []
    private var links: [LinkItem] = []
    private var tabs: [(id: Tab, label: String)] = []
    private var active: Tab?
    private var builtWidth: CGFloat = 0
    private let pan = UIPanGestureRecognizer()

    private static let urlPattern = try? NSRegularExpression(pattern: "https?://[^\\s<>\"']+", options: [.caseInsensitive])
    private static let invitePattern = try? NSRegularExpression(pattern: "(^|[\\s(«\"'])(?:(?:invizent|linea)://invite/|https://(?:(?:api\\.)?invizent\\.com|141-133-194-51\\.nip\\.io)/i/)([A-Za-z0-9]{6,16})(?![A-Za-z0-9])", options: [])
    private static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.setLocalizedDateFormatFromTemplate("dMMMy")
        return formatter
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        column.axis = .vertical
        column.spacing = 10
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        strip.showsHorizontalScrollIndicator = false
        strip.backgroundColor = Theme.surface2
        strip.layer.cornerRadius = 18
        strip.layer.cornerCurve = .continuous
        stripRow.axis = .horizontal
        stripRow.spacing = 6
        stripRow.translatesAutoresizingMaskIntoConstraints = false
        strip.addSubview(stripRow)
        column.addArrangedSubview(strip)
        body.axis = .vertical
        body.spacing = 10
        column.addArrangedSubview(body)
        pan.addTarget(self, action: #selector(panned(_:)))
        pan.delegate = self
        body.addGestureRecognizer(pan)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            stripRow.topAnchor.constraint(equalTo: strip.contentLayoutGuide.topAnchor, constant: 4),
            stripRow.bottomAnchor.constraint(equalTo: strip.contentLayoutGuide.bottomAnchor, constant: -4),
            stripRow.leadingAnchor.constraint(equalTo: strip.contentLayoutGuide.leadingAnchor, constant: 4),
            stripRow.trailingAnchor.constraint(equalTo: strip.contentLayoutGuide.trailingAnchor, constant: -4),
            strip.heightAnchor.constraint(equalTo: stripRow.heightAnchor, constant: 8),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { return nil }

    /// The chat's messages, oldest first (each with its `rowKey`).
    func show(_ messages: [[String: Any]]) {
        photos = []
        videos = []
        files = []
        voice = []
        links = []
        for message in messages.reversed() {
            if let attachment = message["attachment"] as? [String: Any] {
                let item = Item(attachment: attachment, message: message)
                if ChatRowLooks.isVoice(attachment) || ChatRowLooks.isVideoNote(attachment) { voice.append(item) }
                else if SharedMediaView.kind(attachment) == "photo" { photos.append(item) }
                else if SharedMediaView.kind(attachment) == "video" { videos.append(item) }
                else { files.append(item) }
            }
            let text = message["text"] as? String ?? ""
            if !text.isEmpty, let pattern = SharedMediaView.urlPattern {
                let whole = text as NSString
                for match in pattern.matches(in: text, options: [], range: NSRange(location: 0, length: whole.length)) {
                    let url = whole.substring(with: match.range)
                    if SharedMediaView.isInvite(url) { continue }
                    let trimmed = url.replacingOccurrences(of: "[).,!?»]+$", with: "", options: .regularExpression)
                    links.append(LinkItem(url: trimmed, message: message))
                }
            }
        }
        var made: [(id: Tab, label: String)] = []
        if !photos.isEmpty { made.append((.photos, "Фото")) }
        if !videos.isEmpty { made.append((.videos, "Видео")) }
        if !files.isEmpty { made.append((.files, "Файлы")) }
        if !voice.isEmpty { made.append((.voice, "Голосовые")) }
        if !links.isEmpty { made.append((.links, "Ссылки")) }
        tabs = made
        if let active, !tabs.contains(where: { $0.id == active }) { self.active = nil }
        if self.active == nil { self.active = tabs.first?.id }
        isHidden = tabs.isEmpty
        rebuild()
    }

    func select(_ tab: Tab) {
        guard tabs.contains(where: { $0.id == tab }) else { return }
        active = tab
        rebuild()
    }

    /// media/formats.ts `mediaPreviewKind` (photo/formats.ts `isPhotoCandidate` first).
    static func kind(_ attachment: [String: Any]) -> String {
        let type = attachment["mimeType"] as? String ?? ""
        let name = attachment["name"] as? String ?? ""
        func matches(_ pattern: String, _ text: String) -> Bool { return text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
        if matches("^image/", type) || matches("\\.(?:jpe?g|png|webp|hei[cf]|hif|bmp|tiff?|gif|avif|dng|nef|arw|cr2|cr3|raf|orf|rw2|srw|pef|dcr|raw|psd|psb|svg|jxl|jp2|j2k|jpf|jpx|exr|hdr|pic|tga|ico|cur|pcx|pnm|ppm|pgm|pbm|dds|qoi)$", name) { return "photo" }
        if matches("^video/", type) || matches("\\.(?:mp4|m4v|mov|qt|3gp|3g2|mkv|webm|avi|wmv|asf|flv|f4v|mpg|mpeg|mpe|m2v|mts|m2ts|ts|vob|ogv|mxf)$", name) { return "video" }
        if matches("^audio/", type) || matches("\\.(?:mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|alac|amr|caf|wma)$", name) { return "audio" }
        return "file"
    }

    private static func isInvite(_ url: String) -> Bool {
        guard let pattern = invitePattern else { return false }
        return pattern.firstMatch(in: url, options: [], range: NSRange(location: 0, length: (url as NSString).length)) != nil
    }

    /// theme.ts `formatSize` (Russian units).
    static func size(_ bytes: Int) -> String {
        let value = Double(bytes)
        if bytes < 1024 { return "\(bytes) Б" }
        if bytes < 1024 * 1024 { return String(format: "%.0f КБ", value / 1024) }
        if value >= 1024 * 1024 * 1024 { return String(format: "%.1f ГБ", value / 1024 / 1024 / 1024).replacingOccurrences(of: ",", with: ".") }
        return String(format: "%.1f МБ", value / 1024 / 1024).replacingOccurrences(of: ",", with: ".")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if abs(bounds.width - builtWidth) > 0.5 { rebuild() }
    }

    private func rebuild() {
        builtWidth = bounds.width
        for view in stripRow.arrangedSubviews {
            stripRow.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for view in body.arrangedSubviews {
            body.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard let active, bounds.width > 0 else { return }
        for (index, tab) in tabs.enumerated() {
            var config = UIButton.Configuration.plain()
            config.title = tab.label
            config.baseForegroundColor = tab.id == active ? Theme.accent : Theme.text
            config.background.backgroundColor = tab.id == active ? ThemeStore.look.accentSoft : .clear
            config.background.cornerRadius = 14
            config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14)
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { (incoming: AttributeContainer) -> AttributeContainer in
                var outgoing = incoming
                outgoing.font = UIFont.systemFont(ofSize: 14, weight: .semibold)
                return outgoing
            }
            let button = UIButton(configuration: config)
            button.tag = index
            button.accessibilityTraits = tab.id == active ? [.button, .selected] : .button
            button.addTarget(self, action: #selector(tabTapped(_:)), for: .touchUpInside)
            stripRow.addArrangedSubview(button)
        }
        switch active {
        case .photos: body.addArrangedSubview(grid(photos))
        case .videos: body.addArrangedSubview(grid(videos))
        case .files: body.addArrangedSubview(list(files, voiceList: false))
        case .voice: body.addArrangedSubview(list(voice, voiceList: true))
        case .links: body.addArrangedSubview(linkList())
        }
    }

    @objc private func tabTapped(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < tabs.count else { return }
        active = tabs[sender.tag].id
        rebuild()
    }

    /// Three columns with 2 pt between, rounded 14 as a whole; a video shows its length.
    private func grid(_ items: [Item]) -> UIView {
        let cell = floor((bounds.width - 4) / 3)
        let holder = UIView()
        holder.layer.cornerRadius = 14
        holder.layer.cornerCurve = .continuous
        holder.clipsToBounds = true
        let rows = Int((Double(items.count) / 3).rounded(.up))
        for (index, item) in items.enumerated() {
            let x = CGFloat(index % 3) * (cell + 2)
            let y = CGFloat(index / 3) * (cell + 2)
            let tile = UIControl(frame: CGRect(x: x, y: y, width: cell, height: cell))
            tile.backgroundColor = Theme.surface2
            tile.clipsToBounds = true
            let picture = UIImageView(frame: tile.bounds)
            picture.contentMode = .scaleAspectFill
            picture.isUserInteractionEnabled = false
            let base64 = (item.attachment["preview"] as? [String: Any])?["base64"] as? String ?? ""
            if let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), let image = UIImage(data: data) {
                picture.image = image
            } else {
                picture.image = UIImage(systemName: "photo", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .regular))
                picture.contentMode = .center
                picture.tintColor = Theme.muted
            }
            tile.addSubview(picture)
            if SharedMediaView.kind(item.attachment) == "video" {
                let ms = ((item.attachment["media"] as? [String: Any])?["durationMs"] as? NSNumber)?.intValue ?? 0
                let seconds = ms / 1000
                let length = UILabel()
                length.text = String(format: "%d:%02d", seconds / 60, seconds % 60)
                length.font = .systemFont(ofSize: 11, weight: .semibold)
                length.textColor = .white
                length.textAlignment = .center
                length.backgroundColor = UIColor(white: 0, alpha: 0.5)
                length.layer.cornerRadius = 6
                length.clipsToBounds = true
                let size = length.intrinsicContentSize
                length.frame = CGRect(x: 5, y: cell - 5 - (size.height + 4), width: size.width + 10, height: size.height + 4)
                tile.addSubview(length)
            }
            tile.accessibilityLabel = SharedMediaView.kind(item.attachment) == "video" ? "Видео" : "Фото"
            tile.isAccessibilityElement = true
            tile.accessibilityTraits = .button
            let key = item.message["rowKey"] as? String ?? ""
            tile.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.onOpen?(key) }, for: .touchUpInside)
            holder.addSubview(tile)
        }
        let height = rows == 0 ? 0 : CGFloat(rows) * cell + CGFloat(rows - 1) * 2
        holder.heightAnchor.constraint(equalToConstant: height).isActive = true
        return holder
    }

    private func plate() -> UIStackView {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.backgroundColor = Theme.surface2
        stack.layer.cornerRadius = 16
        stack.layer.cornerCurve = .continuous
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 4, left: 0, bottom: 4, right: 0)
        return stack
    }

    private func row(icon: UIView, title: String, titleColor: UIColor, titleSize: CGFloat, titleBold: Bool, subtitle: String, run: @escaping () -> Void) -> UIControl {
        let control = UIControl()
        control.isAccessibilityElement = true
        control.accessibilityTraits = .button
        control.accessibilityLabel = title + ", " + subtitle
        icon.isUserInteractionEnabled = false
        icon.translatesAutoresizingMaskIntoConstraints = false
        control.addSubview(icon)
        let top = UILabel()
        top.text = title
        top.font = .systemFont(ofSize: titleSize, weight: titleBold ? .semibold : .regular)
        top.textColor = titleColor
        top.translatesAutoresizingMaskIntoConstraints = false
        control.addSubview(top)
        let under = UILabel()
        under.text = subtitle
        under.font = .systemFont(ofSize: 12)
        under.textColor = Theme.muted
        under.translatesAutoresizingMaskIntoConstraints = false
        control.addSubview(under)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: control.leadingAnchor, constant: 12),
            icon.topAnchor.constraint(equalTo: control.topAnchor, constant: 9),
            icon.bottomAnchor.constraint(equalTo: control.bottomAnchor, constant: -9),
            icon.widthAnchor.constraint(equalToConstant: 42),
            icon.heightAnchor.constraint(equalToConstant: 42),
            top.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 12),
            top.trailingAnchor.constraint(equalTo: control.trailingAnchor, constant: -12),
            top.bottomAnchor.constraint(equalTo: icon.centerYAnchor, constant: 1),
            under.leadingAnchor.constraint(equalTo: top.leadingAnchor),
            under.trailingAnchor.constraint(equalTo: top.trailingAnchor),
            under.topAnchor.constraint(equalTo: icon.centerYAnchor, constant: 2),
        ])
        control.addAction(UIAction { (_: UIAction) -> Void in run() }, for: .touchUpInside)
        control.addAction(UIAction { [weak control] (_: UIAction) -> Void in control?.alpha = 0.6 }, for: [.touchDown, .touchDragEnter])
        control.addAction(UIAction { [weak control] (_: UIAction) -> Void in control?.alpha = 1 }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        return control
    }

    private func list(_ items: [Item], voiceList: Bool) -> UIView {
        let stack = plate()
        for item in items {
            let note = ChatRowLooks.isVideoNote(item.attachment)
            let icon = UIView()
            icon.backgroundColor = Theme.accent
            icon.layer.cornerRadius = voiceList ? 21 : 10
            let mark = UIImageView(image: UIImage(systemName: voiceList ? (note ? "video.fill" : "play.fill") : "doc.text.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular)))
            mark.tintColor = Theme.onAccent
            mark.translatesAutoresizingMaskIntoConstraints = false
            icon.addSubview(mark)
            mark.centerXAnchor.constraint(equalTo: icon.centerXAnchor).isActive = true
            mark.centerYAnchor.constraint(equalTo: icon.centerYAnchor).isActive = true
            let title = voiceList ? (note ? "Видеосообщение" : "Голосовое сообщение") : (item.attachment["name"] as? String ?? "Файл")
            let bytes = (item.attachment["size"] as? NSNumber)?.intValue ?? 0
            let when = Messenger.date(item.message["createdAt"] as? String).map { SharedMediaView.day.string(from: $0) } ?? ""
            let key = item.message["rowKey"] as? String ?? ""
            stack.addArrangedSubview(row(icon: icon, title: title, titleColor: Theme.text, titleSize: 15, titleBold: true, subtitle: SharedMediaView.size(bytes) + " · " + when) { [weak self] in
                self?.onOpen?(key)
            })
        }
        return stack
    }

    private func linkList() -> UIView {
        let stack = plate()
        for item in links {
            let icon = UILabel()
            icon.backgroundColor = ThemeStore.look.accentSoft
            icon.layer.cornerRadius = 10
            icon.clipsToBounds = true
            icon.textAlignment = .center
            icon.font = .systemFont(ofSize: 17, weight: .bold)
            icon.textColor = Theme.accent
            let bare = item.url.replacingOccurrences(of: "^https?://(www\\.)?", with: "", options: [.regularExpression, .caseInsensitive])
            icon.text = bare.first.map { String($0).uppercased() } ?? "?"
            let shown = item.url.replacingOccurrences(of: "^https?://", with: "", options: [.regularExpression, .caseInsensitive])
            let url = item.url
            stack.addArrangedSubview(row(icon: icon, title: shown, titleColor: Theme.accent, titleSize: 14, titleBold: false, subtitle: item.message["text"] as? String ?? "") {
                // As the reference (Linking.openURL): the link opens in the system's browser.
                if let address = URL(string: url) { UIApplication.shared.open(address, options: [:], completionHandler: nil) }
            })
        }
        return stack
    }

    // MARK: The sideways swipe (listSwipes.ts axisLock, pageRelease)

    private var activeIndex: Int { return max(0, tabs.firstIndex { $0.id == active } ?? 0) }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pan, tabs.count > 1 else { return false }
        let move = pan.translation(in: self)
        let speed = pan.velocity(in: self)
        let dx = abs(move.x) > 0.5 ? move.x : speed.x
        let dy = abs(move.y) > 0.5 ? move.y : speed.y
        // Mostly sideways (2:1); right on the first tab and left on the last are left to the screen.
        guard abs(dx) > abs(dy) * 2 else { return false }
        if activeIndex == 0 && dx > 0 { return false }
        if activeIndex == tabs.count - 1 && dx < 0 { return false }
        return true
    }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        let motion = Motion.enabled
        switch recognizer.state {
        case .changed:
            let shift = motion ? recognizer.translation(in: self).x * 0.35 : 0
            body.transform = CGAffineTransform(translationX: shift, y: 0)
            body.alpha = 1 - min(0.4, abs(shift) / 300)
        case .ended, .cancelled, .failed:
            let translation = recognizer.translation(in: self).x
            let velocity = recognizer.velocity(in: self).x
            let to = SharedMediaView.pageRelease(activeIndex, tabs.count, translation, velocity, bounds.width)
            UIView.animate(withDuration: motion ? 0.18 : 0) {
                self.body.transform = .identity
                self.body.alpha = 1
            }
            if recognizer.state == .ended, to != activeIndex, to >= 0, to < tabs.count {
                UISelectionFeedbackGenerator().selectionChanged()
                active = tabs[to].id
                rebuild()
            }
        default:
            break
        }
    }

    /// listSwipes.ts `pageRelease` (PAGE_FRACTION 0.25, PAGE_VELOCITY 600).
    static func pageRelease(_ index: Int, _ count: Int, _ translation: CGFloat, _ velocity: CGFloat, _ width: CGFloat) -> Int {
        if count <= 1 || !(width > 0) { return index }
        let flickBack = translation != 0 && (velocity < 0) != (translation < 0) && velocity != 0 && abs(velocity) > 300
        var step = 0
        if !flickBack && (abs(translation) > width * 0.25 || abs(velocity) > 600) { step = translation < 0 || (translation == 0 && velocity < 0) ? 1 : -1 }
        return max(0, min(count - 1, index + step))
    }
}
