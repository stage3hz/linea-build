import Foundation

extension Live {
    /// Composer: the server's list of scheduled messages changed (`scheduled`), or the line opened (`ready`).
    static let scheduledEvent = Notification.Name("invizent.live-scheduled")
}

extension Messenger {
    /// «Отправить позже» (the reference's useMessenger.ts `performSend` with `deliverAt`): the message is encrypted
    /// now, for the devices of now, dated at the chosen time inside the ciphertext, and the server keeps the
    /// envelopes (never decrypted) until then. Runs on the encryption queue.
    ///
    /// `.success(true)`: the server keeps it for later. `.success(false)`: the time passed meanwhile and it went
    /// out at once (not an error). The kept ciphertext is forgotten when the server refuses for good.
    func deliverLater(_ crypto: CryptoService, chatId: String, peerId: String, clientId: String, text: Any, attachment: Any, meta: Any, deliverAt: String, again: Bool = true) -> Result<Bool, CryptoFailure> {
        switch crypto.callNow("encrypt", [chatId, peerId, clientId, text, attachment, meta, deliverAt, NSNull()]) {
        case .failure(let failure): return .failure(failure)
        case .success(let encrypted):
            let kind = Core.view("callPushKind", [meta]) as? String
            var args: [Any] = [chatId, clientId, encrypted, deliverAt]
            if kind == "silent" { args.append("silent") }
            switch server.opAndWait("scheduleEncrypted", args) {
            case .success:
                _ = crypto.callNow("delivered", [chatId, clientId])
                return .success(true)
            case .failure(.refused(let message, let status, let code, _)):
                if code == "SCHEDULE_IN_PAST" {
                    // A time that passed while the phone was offline: the very same envelopes go out now.
                    var now: [Any] = [chatId, clientId, encrypted]
                    if let kind { now.append(kind) }
                    switch server.opAndWait("sendEncrypted", now) {
                    case .success:
                        _ = crypto.callNow("delivered", [chatId, clientId])
                        return .success(false)
                    case .failure(let error):
                        return .failure(CryptoFailure(name: "NetworkError", message: error.words))
                    }
                }
                if code == "E2EE_DEVICES_CHANGED" {
                    _ = crypto.callNow("forget", [chatId, clientId])
                    if again { return deliverLater(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: text, attachment: attachment, meta: meta, deliverAt: deliverAt, again: false) }
                    return .failure(CryptoFailure(name: "Error", message: message))
                }
                if status == 400 && message.contains("неизвестные поля") {
                    _ = crypto.callNow("forget", [chatId, clientId])
                    return .failure(CryptoFailure(name: "Error", message: "Сервер не поддерживает отложенные сообщения."))
                }
                if (400..<500).contains(status), status != 401, status != 408, status != 429 {
                    _ = crypto.callNow("forget", [chatId, clientId])
                }
                return .failure(CryptoFailure(name: "Error", message: message))
            case .failure(let error):
                return .failure(CryptoFailure(name: "NetworkError", message: error.words))
            }
        }
    }
}

/// The scheduled messages of the account (the reference's useMessenger.ts `scheduled`): the server's list
/// (ciphertext and time) opened with this device's vault — a message encrypted here is kept under its clientId,
/// so its text shows; one scheduled from another device stays closed. Main queue only.
final class ScheduledStore {
    /// Posted on the main queue when the list or what is being done with it changed.
    static let changed = Notification.Name("invizent.scheduled-changed")

    private static var made: [String: ScheduledStore] = [:]

    /// The store of an account (one per signed-in person).
    static func of(_ messenger: Messenger) -> ScheduledStore {
        if let kept = made[messenger.userId], kept.messenger === messenger { return kept }
        let fresh = ScheduledStore(messenger: messenger)
        made[messenger.userId] = fresh
        return fresh
    }

    private weak var messenger: Messenger?
    private(set) var items: [ScheduledItem] = []
    /// Items being sent now or deleted (their buttons wait).
    private(set) var busy = Set<String>()
    private var revision = 0
    private var resending = Set<String>()
    /// A server without scheduled messages answers 404 on the list: asked no more in this session.
    private var supported = true

    private init(messenger: Messenger) {
        self.messenger = messenger
        NotificationCenter.default.addObserver(self, selector: #selector(heard(_:)), name: Live.scheduledEvent, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func heard(_ note: Notification) {
        let type = (note.userInfo?["event"] as? [String: Any])?["type"] as? String
        if type == "ready" { online() } else { refresh() }
    }

    /// The live line opened: what was scheduled but never confirmed (the app was closed meanwhile) goes to the
    /// server again with its very ciphertext, and the list is read.
    func online() {
        guard let messenger else { return }
        messenger.crypto.run({ (crypto: CryptoService) -> Int in
            guard case .success(let value) = crypto.callNow("pendingOutbox"), let pending = value as? [[String: Any]] else { return 0 }
            var done = 0
            for item in pending {
                guard let deliverAt = item["deliverAt"] as? String, let chatId = item["chatId"] as? String, let clientId = item["clientId"] as? String, let peerId = item["peerId"] as? String else { continue }
                let result = messenger.deliverLater(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: item["text"] ?? "", attachment: item["attachment"] ?? NSNull(), meta: item["meta"] ?? NSNull(), deliverAt: deliverAt)
                switch result {
                case .success: done += 1
                case .failure(let failure): if failure.name == "NetworkError" { return done }
                }
            }
            return done
        }, done: { [weak self] (done: Int) -> Void in
            if done > 0 { NotificationCenter.default.post(name: Messenger.changed, object: nil) }
            self?.refresh()
        })
    }

    /// Reads the server's list again (lean: no ciphertext over the wire; the text is in the vault).
    func refresh() {
        guard let messenger, supported else { return }
        revision += 1
        let asked = revision
        let me = messenger.userId
        messenger.crypto.run({ (crypto: CryptoService) -> Result<[ScheduledItem], ServerError> in
            switch messenger.server.opAndWait("scheduled", [["lean": true]]) {
            case .failure(let error): return .failure(error)
            case .success(let body):
                let rows = (body as? [String: Any])?["items"] as? [[String: Any]] ?? []
                var opened: [ScheduledItem] = []
                for row in rows {
                    guard var item = ScheduledItem(row) else { continue }
                    var probe: [String: Any] = ["id": 0, "chatId": item.chatId, "senderId": me, "clientId": item.clientId, "text": "", "attachment": NSNull(), "createdAt": item.createdAt]
                    if let encrypted = item.encrypted { probe["encrypted"] = encrypted } else { probe["lean"] = true }
                    if case .success(let value) = crypto.callNow("preview", [probe]), let shown = value as? [String: Any] {
                        item.cryptoState = shown["cryptoState"] as? String ?? ""
                        if item.cryptoState == "decrypted" {
                            item.text = shown["text"] as? String ?? ""
                            item.attachment = shown["attachment"] as? [String: Any]
                            item.meta = shown["meta"] as? [String: Any]
                        }
                    } else {
                        item.cryptoState = "no-key"
                    }
                    opened.append(item)
                }
                return .success(opened)
            }
        }, done: { [weak self] (result: Result<[ScheduledItem], ServerError>) -> Void in
            guard let self, asked == self.revision else { return }
            switch result {
            case .success(let list):
                self.items = list.sorted { $0.deliverAt < $1.deliverAt }
                NotificationCenter.default.post(name: ScheduledStore.changed, object: nil)
                for item in self.items where item.canResend { self.resend(item, done: { (_: String?) -> Void in }) }
            case .failure(.refused(_, let status, let code, _)):
                if status == 404 && code == nil { self.supported = false }
            case .failure:
                break
            }
        })
    }

    /// The scheduled messages of one chat, the soonest first.
    func items(chatId: String) -> [ScheduledItem] { items.filter { $0.chatId == chatId } }

    private func setBusy(_ id: String, _ on: Bool) {
        if on { busy.insert(id) } else { busy.remove(id) }
        NotificationCenter.default.post(name: ScheduledStore.changed, object: nil)
    }

    private func drop(_ id: String) {
        items.removeAll { $0.id == id }
        NotificationCenter.default.post(name: ScheduledStore.changed, object: nil)
    }

    /// A message the server could not release (the other side's devices changed) is encrypted afresh here —
    /// only this device holds the text — and sent the ordinary way; the stale row goes. `done`: nil or the words
    /// of the problem.
    func resend(_ item: ScheduledItem, done: @escaping (String?) -> Void) {
        guard let messenger, item.cryptoState == "decrypted", !resending.contains(item.id) else { return done(nil) }
        resending.insert(item.id)
        let peerId = peerOf(item.chatId)
        messenger.crypto.run({ (crypto: CryptoService) -> String? in
            guard let peerId else { return "Сначала открой разговор." }
            _ = crypto.callNow("forget", [item.chatId, item.clientId])
            if case .failure(.refused(let message, let status, _, _)) = messenger.server.opAndWait("deleteScheduled", [item.id]), status != 404 { return message }
            var attachment: Any = NSNull()
            if let file = item.attachment { attachment = file }
            var meta: Any = NSNull()
            if let fields = item.meta { meta = fields }
            switch messenger.deliver(crypto, chatId: item.chatId, peerId: peerId, clientId: item.clientId, text: item.text, attachment: attachment, meta: meta) {
            case .success: return nil
            case .failure(let failure): return failure.message
            }
        }, done: { [weak self] (problem: String?) -> Void in
            guard let self else { return }
            self.resending.remove(item.id)
            if problem == nil {
                self.drop(item.id)
                NotificationCenter.default.post(name: Messenger.changed, object: item.chatId)
            }
            done(problem)
        })
    }

    /// «Отправить сейчас»: the server releases the stored envelopes; when they no longer fit the other side's
    /// devices (409), this device encrypts the text afresh. `done`: nil or the words of the problem.
    func sendNow(_ item: ScheduledItem, done: @escaping (String?) -> Void) {
        guard let messenger else { return done(nil) }
        setBusy(item.id, true)
        let finish: (String?) -> Void = { [weak self] (problem: String?) -> Void in
            self?.setBusy(item.id, false)
            done(problem)
        }
        guard !item.failed else {
            guard item.canResend else { return finish("Отправить заново можно только с устройства, где сообщение написано.") }
            return resend(item, done: finish)
        }
        messenger.server.op("sendScheduledNow", [item.id]) { [weak self] (result: Result<Any, ServerError>) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success:
                    self.drop(item.id)
                    NotificationCenter.default.post(name: Messenger.changed, object: item.chatId)
                    finish(nil)
                case .failure(.refused(_, 409, _, _)):
                    guard item.cryptoState == "decrypted" else { return finish("Отправить заново можно только с устройства, где сообщение написано.") }
                    self.resend(item, done: finish)
                case .failure(let error):
                    finish(error.words)
                }
            }
        }
    }

    /// The bin: the message is deleted before it is sent, and its copy in this device's vault goes too.
    func delete(_ item: ScheduledItem, done: @escaping (String?) -> Void) {
        guard let messenger else { return done(nil) }
        setBusy(item.id, true)
        messenger.server.op("deleteScheduled", [item.id]) { [weak self] (result: Result<Any, ServerError>) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                self.setBusy(item.id, false)
                if case .failure(let error) = result {
                    if case .refused(_, 404, _, _) = error {} else { return done(error.words) }
                }
                self.drop(item.id)
                messenger.crypto.run({ (crypto: CryptoService) -> Void in _ = crypto.callNow("forget", [item.chatId, item.clientId]) }, done: { (_: Void) -> Void in })
                done(nil)
            }
        }
    }

    /// The other person of a chat, as the open chats know it.
    private var peers: [String: String] = [:]
    func remember(chatId: String, peerId: String) { if !peerId.isEmpty { peers[chatId] = peerId } }
    private func peerOf(_ chatId: String) -> String? { peers[chatId] }
}
