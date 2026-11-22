import UIKit

/// The rules of the forwards on their way (the same as Android's chatactions/ForwardJobs.kt, which the JVM checks
/// replay): every forwarded message that carries a file is one job; a job waits («в очереди»), runs (the file is
/// brought, opened, sealed under a new key and uploaded again, then the message is sent), and either goes (the job
/// is gone, the message is in the chat) or fails (the row says why, «Повторить» puts it back in the queue,
/// «Удалить» drops it). At most `limit` jobs run at once, and in one chat only one at a time, in their order — a
/// failed one does not hold back those after it. Values only: no queues, no server.
struct ForwardJobs {
    enum State: Equatable {
        case queued
        case running
        case failed
    }

    struct Job: Equatable {
        let id: String
        let chatId: String
        /// What it is, for the line of the chat in the list: «Видео», «📎 отчёт.pdf», a text.
        let what: String
        var state: State = .queued
        /// How much of the copy is done, 0…1 (while running).
        var progress: Double = 0
        /// Why it failed: the words for the person.
        var failure: String? = nil
    }

    /// The reference copies one forward at a time; here two may run at once (in different chats).
    static let parallel = 2
    static let sendingWord = "Отправка:"
    static let failedWord = "Не отправлено:"

    let limit: Int
    private(set) var jobs: [Job] = []

    init(limit: Int = ForwardJobs.parallel) {
        self.limit = max(1, limit)
    }

    mutating func add(id: String, chatId: String, what: String) {
        jobs.append(Job(id: id, chatId: chatId, what: what))
    }

    func job(_ id: String) -> Job? {
        jobs.first { $0.id == id }
    }

    private func index(_ id: String) -> Int? {
        jobs.firstIndex { $0.id == id }
    }

    /// The jobs that may start now, in their order: within the limit, and only the first waiting or running job of
    /// each chat (a failed one is passed over).
    func startable() -> [String] {
        var running = jobs.filter { $0.state == .running }.count
        var busy = Set<String>()
        var out: [String] = []
        for job in jobs where job.state != .failed {
            if busy.contains(job.chatId) { continue }
            busy.insert(job.chatId)
            if job.state == .queued && running < limit {
                out.append(job.id)
                running += 1
            }
        }
        return out
    }

    /// queued → running, from nothing.
    mutating func start(_ id: String) -> Bool {
        guard let at = index(id), jobs[at].state == .queued else { return false }
        jobs[at].state = .running
        jobs[at].progress = 0
        jobs[at].failure = nil
        return true
    }

    /// The copy moved on. Only while running, and only forward (a late report changes nothing). True when the
    /// whole percent changed (the row and the list are drawn again).
    mutating func progress(_ id: String, _ fraction: Double) -> Bool {
        guard let at = index(id), jobs[at].state == .running, fraction.isFinite else { return false }
        let value = min(1, max(0, fraction))
        if value <= jobs[at].progress { return false }
        let before = ForwardJobs.percent(jobs[at].progress)
        jobs[at].progress = value
        return ForwardJobs.percent(value) != before
    }

    /// running → failed, with the words for the person.
    mutating func fail(_ id: String, _ words: String) -> Bool {
        guard let at = index(id), jobs[at].state == .running else { return false }
        jobs[at].state = .failed
        jobs[at].progress = 0
        jobs[at].failure = words.isEmpty ? "Не удалось переслать." : words
        return true
    }

    /// «Повторить»: failed → queued; the copy is done again from the start.
    mutating func retry(_ id: String) -> Bool {
        guard let at = index(id), jobs[at].state == .failed else { return false }
        jobs[at].state = .queued
        jobs[at].progress = 0
        jobs[at].failure = nil
        return true
    }

    /// The message went: the job is gone (its row gives way to the message itself).
    mutating func finish(_ id: String) -> Bool {
        guard let at = index(id), jobs[at].state == .running else { return false }
        jobs.remove(at: at)
        return true
    }

    /// ✕ or «Удалить»: the job is gone whatever its state; gives the state it had (nil: there was none).
    mutating func remove(_ id: String) -> State? {
        guard let at = index(id) else { return nil }
        let state = jobs[at].state
        jobs.remove(at: at)
        return state
    }

    /// Whether something of this chat waits or runs (a text forwarded after it waits too, so the order stays).
    func waiting(_ chatId: String) -> Bool {
        jobs.contains { $0.chatId == chatId && $0.state != .failed }
    }

    func of(_ chatId: String) -> [Job] {
        jobs.filter { $0.chatId == chatId }
    }

    /// The line of the chat in the list: «Отправка: Видео · 40%» while something goes, else «Не отправлено: Видео»
    /// (the first word red: `red` UTF-16 units). Nil: nothing of this chat.
    func listLine(_ chatId: String) -> (text: String, red: Int)? {
        let mine = of(chatId)
        if let going = mine.first(where: { $0.state != .failed }) {
            let percent = ForwardJobs.percent(going.progress)
            let tail = going.state == .running && percent > 0 ? " · \(percent)%" : ""
            return (ForwardJobs.sendingWord + " " + going.what + tail, 0)
        }
        if let failed = mine.first(where: { $0.state == .failed }) {
            return (ForwardJobs.failedWord + " " + failed.what, (ForwardJobs.failedWord as NSString).length)
        }
        return nil
    }

    /// The words on the ring of a row: «В очереди», «Пересылка · 40%».
    static func ringWords(_ job: Job) -> String {
        job.state == .running ? "Пересылка · \(percent(job.progress))%" : "В очереди"
    }

    static func percent(_ value: Double) -> Int {
        Int((min(1, max(0, value)) * 100).rounded(.down))
    }
}

/// Stops the transfers of one copy from the main queue (the copy itself runs on a background queue).
final class ForwardStop {
    private let lock = NSLock()
    private var stopped = false
    private var small: FileTransfer?
    private var big: BigTransfer?

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    func cancel() {
        lock.lock()
        stopped = true
        let smallNow = small
        let bigNow = big
        lock.unlock()
        smallNow?.cancel()
        bigNow?.cancel()
    }

    /// The transfer that runs now; one started after `cancel()` is stopped at once.
    func use(_ transfer: FileTransfer) {
        lock.lock()
        small = transfer
        let cancelled = stopped
        lock.unlock()
        if cancelled { transfer.cancel() }
    }

    func use(_ transfer: BigTransfer) {
        lock.lock()
        big = transfer
        let cancelled = stopped
        lock.unlock()
        if cancelled { transfer.cancel() }
    }
}

/// The forwards on their way, for the whole app (the reference keeps its uploads in a module-level store that
/// outlives the chat screen, mobile/src/videonote/noteOutbox.ts): the moment «Отправить» is tapped each chosen chat
/// gets a row with the attachment, a ring with the progress and ✕; leaving the chat does not stop anything. When
/// the copy is done the message is sent (end-to-end encrypted for that chat like any other) and the row gives way
/// to it; a failure leaves «Не отправлено · повторить» with the reason. Like the reference's uploads, the jobs live
/// in memory only: once a message is made it is the messenger's own unsent list that keeps it across a restart.
/// Main queue only.
final class ForwardQueue {
    static let shared = ForwardQueue()
    /// Posted (object: the chat id) when a job came, went, started or failed.
    static let changed = Notification.Name("invizent.forward-queue")
    /// Posted (object: the chat id) when the percent of a running job moved.
    static let progressed = Notification.Name("invizent.forward-queue.progress")

    private final class Work {
        let messenger: Messenger?
        let chatId: String
        let peerId: String
        let text: String
        let attachment: [String: Any]?
        /// NSNull or the message's meta (whose words they are, the formatting).
        let meta: Any
        /// Whose words they are; empty for the comment of «Выбрать».
        let from: String
        let time = Messenger.clock.string(from: Date())
        var stop: ForwardStop?
        var background = UIBackgroundTaskIdentifier.invalid

        init(messenger: Messenger?, chatId: String, peerId: String, text: String, attachment: [String: Any]?, meta: Any, from: String) {
            self.messenger = messenger
            self.chatId = chatId
            self.peerId = peerId
            self.text = text
            self.attachment = attachment
            self.meta = meta
            self.from = from
        }
    }

    private var jobs = ForwardJobs()
    private var work: [String: Work] = [:]
    private let queue = DispatchQueue(label: "invizent.forward", qos: .userInitiated, attributes: .concurrent)
    #if targetEnvironment(simulator)
    private var simulatorSeeded = false
    #endif

    private init() {}

    /// The key of a job's row: it begins as the rows of outgoing attachments do, so the chat redraws it with them.
    static func rowKey(_ id: String) -> String { "attach-" + id }

    func waiting(_ chatId: String) -> Bool { jobs.waiting(chatId) }

    /// A message on its way to `chatId`: shown at once, copied and sent in its turn.
    func add(messenger: Messenger?, chatId: String, peerId: String, text: String, attachment: [String: Any]?, meta: Any, from: String) {
        let id = "fwd-" + UUID().uuidString.lowercased()
        var what = ""
        if let attachment {
            what = ChatRowLooks.attachmentLine(attachment).text
        } else {
            let line = text.split(whereSeparator: { $0 == "\n" || $0 == "\t" }).joined(separator: " ")
            what = ChatForward.clipped(line, units: 80)
        }
        work[id] = Work(messenger: messenger, chatId: chatId, peerId: peerId, text: text, attachment: attachment, meta: meta, from: from)
        jobs.add(id: id, chatId: chatId, what: what)
        shine(id)
        post(ForwardQueue.changed, chatId)
        pump()
    }

    private func post(_ name: Notification.Name, _ chatId: String) {
        NotificationCenter.default.post(name: name, object: chatId)
    }

    /// Starts what may start.
    private func pump() {
        for id in jobs.startable() { run(id) }
    }

    /// The ring of a job's row (Attachments/InlineMedia.swift draws it with ✕ in the middle); none once failed.
    private func shine(_ id: String) {
        let key = ForwardQueue.rowKey(id)
        guard let job = jobs.job(id), job.state != .failed, work[id]?.attachment != nil else {
            InlineMedia.shared.forgetSending(key)
            return
        }
        InlineMedia.shared.showSending(key, progress: CGFloat(job.progress), words: ForwardJobs.ringWords(job))
    }

    private func run(_ id: String) {
        guard let item = work[id], let messenger = item.messenger else { return }
        guard jobs.start(id) else { return }
        shine(id)
        post(ForwardQueue.changed, item.chatId)
        let stop = ForwardStop()
        item.stop = stop
        // A little more time to finish when the app goes to the background meanwhile.
        item.background = UIApplication.shared.beginBackgroundTask(withName: "invizent.forward") { [weak self] in self?.endBackground(id) }
        let original = item.attachment
        let (chatId, peerId, text, meta) = (item.chatId, item.peerId, item.text, item.meta)
        queue.async {
            var attachment: Any = NSNull()
            if let original {
                let report: (Double) -> Void = { (fraction: Double) -> Void in
                    DispatchQueue.main.async { ForwardQueue.shared.moved(id, fraction, stop: stop) }
                }
                switch ChatForward.copied(original, server: messenger.server, stop: stop, progress: report) {
                case .success(let made): attachment = made
                case .failure(let failure):
                    DispatchQueue.main.async { ForwardQueue.shared.failed(id, failure.words, stop: stop) }
                    return
                }
            }
            if stop.isCancelled { return }
            let sent = attachment
            let clientId = UUID().uuidString.lowercased()
            messenger.crypto.run({ (crypto: CryptoService) -> Result<Void, CryptoFailure> in
                messenger.deliver(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: text, attachment: sent, meta: meta)
            }, done: { (result: Result<Void, CryptoFailure>) -> Void in
                // Without an answer the message stays among the unsent ones and goes out by itself later, with
                // this very attachment: the row has done its part either way.
                if case .failure(let failure) = result, failure.name != "NetworkError" {
                    ForwardQueue.shared.failed(id, failure.message.isEmpty ? "Не удалось переслать." : failure.message, stop: stop)
                    return
                }
                ForwardQueue.shared.sent(id, stop: stop)
            })
        }
    }

    private func endBackground(_ id: String) {
        guard let item = work[id], item.background != .invalid else { return }
        UIApplication.shared.endBackgroundTask(item.background)
        item.background = .invalid
    }

    private func moved(_ id: String, _ fraction: Double, stop: ForwardStop) {
        guard let item = work[id], item.stop === stop else { return }
        if jobs.progress(id, fraction) {
            shine(id)
            post(ForwardQueue.progressed, item.chatId)
        }
    }

    private func failed(_ id: String, _ words: String, stop: ForwardStop) {
        guard let item = work[id], item.stop === stop, jobs.fail(id, words) else { return }
        item.stop = nil
        endBackground(id)
        shine(id)
        post(ForwardQueue.changed, item.chatId)
        pump()
    }

    private func sent(_ id: String, stop: ForwardStop) {
        guard let item = work[id], item.stop === stop, jobs.finish(id) else { return }
        endBackground(id)
        work[id] = nil
        InlineMedia.shared.forgetSending(ForwardQueue.rowKey(id))
        NotificationCenter.default.post(name: Messenger.changed, object: item.chatId)
        post(ForwardQueue.changed, item.chatId)
        pump()
    }

    /// ✕ on a row, or «Удалить» of a failed one: the copy stops and the row goes.
    private func cancel(_ id: String) {
        guard let item = work[id] else { return }
        _ = jobs.remove(id)
        item.stop?.cancel()
        item.stop = nil
        endBackground(id)
        work[id] = nil
        InlineMedia.shared.forgetSending(ForwardQueue.rowKey(id))
        post(ForwardQueue.changed, item.chatId)
        pump()
    }

    /// «Повторить»: the copy is done again from the start, in its turn.
    private func retry(_ id: String) {
        guard let item = work[id], jobs.retry(id) else { return }
        shine(id)
        post(ForwardQueue.changed, item.chatId)
        pump()
    }

    /// A row of a chat was touched. True: it was one of these (✕ stops it; a failed one offers «Повторить» and
    /// «Удалить»).
    func pressed(_ key: String, over host: UIViewController?) -> Bool {
        guard key.hasPrefix("attach-fwd-") else { return false }
        let id = String(key.dropFirst("attach-".count))
        guard let job = jobs.job(id) else { return false }
        if job.state != .failed {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            cancel(id)
            return true
        }
        guard let host else { return true }
        let sheet = UIAlertController(title: nil, message: job.failure, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Повторить отправку", style: .default, handler: { _ in ForwardQueue.shared.retry(id) }))
        sheet.addAction(UIAlertAction(title: "Удалить", style: .destructive, handler: { _ in ForwardQueue.shared.cancel(id) }))
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        sheet.popoverPresentationController?.sourceView = host.view
        host.present(sheet, animated: true)
        return true
    }

    /// The line of a chat in the list while something goes there (Sources/ChatActions/ChatListActions.swift).
    func listLine(_ chatId: String) -> (text: String, red: Int)? {
        jobs.listLine(chatId)
    }

    /// The rows of the forwards on their way into a chat, to stand after its own (as the outgoing attachments do):
    /// the small picture of a photo or a video under the ring with ✕, or a file's card with the ring; a failed one
    /// says «Не отправлено · повторить» and why.
    func rows(for chatId: String) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for job in jobs.of(chatId) {
            guard let item = work[job.id] else { continue }
            var row: [String: Any] = ["key": ForwardQueue.rowKey(job.id), "kind": 0, "mine": true, "text": item.text, "time": item.time,
                                      "ticks": job.state == .failed ? 4 : 3, "tail": true]
            if !item.from.isEmpty { row["forward"] = "Переслано от " + item.from }
            let picture = ForwardQueue.picture(item.attachment)
            if job.state == .failed {
                row["label"] = "Не отправлено · повторить\n" + (job.failure ?? "")
                if let picture {
                    row["thumb"] = picture.base64
                    row["thumbWide"] = picture.wide
                } else if item.attachment != nil && item.text.isEmpty {
                    row["text"] = job.what
                }
            } else if let attachment = item.attachment {
                let size = (attachment["size"] as? NSNumber)?.intValue ?? 0
                if let picture {
                    row["media"] = "photo"
                    row["thumb"] = picture.base64
                    row["thumbWide"] = picture.wide
                    row["mediaTime"] = size > 0 ? FileCore.sizeText(size) : ""
                } else {
                    let voice = ChatRowLooks.isVoice(attachment)
                    let name = voice ? job.what : (attachment["name"] as? String ?? "Файл")
                    row["media"] = "file"
                    row["label"] = name + "\n" + InlineMedia.sizeLine(attachment, sizeText: size > 0 ? FileCore.sizeText(size) : "")
                }
            }
            out.append(row)
        }
        return out
    }

    /// The small picture that came with the attachment (checked by the core when the message was opened).
    private static func picture(_ attachment: [String: Any]?) -> (base64: String, wide: Double)? {
        guard let preview = attachment?["preview"] as? [String: Any], let base64 = preview["base64"] as? String, !base64.isEmpty,
              let width = (preview["width"] as? NSNumber)?.doubleValue, let height = (preview["height"] as? NSNumber)?.doubleValue,
              width > 0, height > 0 else { return nil }
        return (base64, width / height)
    }

    #if targetEnvironment(simulator)
    /// `-chatdemo forwardpending` (with -demo 1 -chat 1): a video forwarded into the sample chat, its copy at 40 %.
    static func simulatorSeed(chatId: String) {
        let queue = ForwardQueue.shared
        guard UserDefaults.standard.string(forKey: "chatdemo") == "forwardpending", !queue.simulatorSeeded else { return }
        queue.simulatorSeeded = true
        let picture = ChatAttachments.demoPicture(width: 240, height: 135).jpegData(compressionQuality: 0.6)?.base64EncodedString() ?? ""
        let attachment: [String: Any] = ["id": "sample-forward-video", "name": "video.mp4", "mimeType": "video/mp4", "size": 48_200_000,
                                         "media": ["durationMs": 42_000, "width": 1920, "height": 1080],
                                         "preview": ["base64": picture, "width": 240, "height": 135, "mimeType": "image/jpeg"]]
        queue.add(messenger: nil, chatId: chatId, peerId: "", text: "", attachment: attachment, meta: NSNull(), from: "Дмитрий Орлов")
        guard let id = queue.jobs.jobs.last?.id else { return }
        _ = queue.jobs.start(id)
        _ = queue.jobs.progress(id, 0.4)
        queue.shine(id)
        queue.post(ForwardQueue.changed, chatId)
    }
    #endif
}
