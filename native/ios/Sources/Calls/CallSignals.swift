import Foundation
import Network

extension Live {
    /// Posted on the main queue for what a call needs from the live line: `userInfo["event"]` is the server's
    /// event — a `message` (it may be a call's signal: only its decrypted copy says), `call.reach` (how far an
    /// outgoing call got), `ready` — or `{"type": "line"}` when the line went up or down (see `Live.line`).
    static let callEvent = Notification.Name("invizent.call-event")
}

/// How a call's signalling travels: every step (offer, answer, end, an ICE restart and its answer) is an ordinary
/// end-to-end encrypted message of the chat with `meta.action` of the kind `call` — the server relays ciphertext
/// and cannot tell a call from a text. Exactly as the reference does (useMessenger.ts `sendAction`, `onCallSignal`).
extension Messenger {
    /// Sends one step of a call. The server is told only what to do about the notification (`push`: an offer
    /// rings, the caller's «not answered» leaves a missed-call notice, everything else is silent).
    ///
    /// A step that carries an SDP is worth nothing later: when it cannot be sent now it is forgotten, so it never
    /// goes out with the unsent messages (a late offer would ring for a call that is long over). The `end` is
    /// kept and goes out later like any message: it is the row the call leaves in both chats.
    func sendCallSignal(chatId: String, peerId: String, action: [String: Any]) {
        let clientId = UUID().uuidString.lowercased()
        let meta: [String: Any] = ["action": action]
        let fallback = Core.view("actionFallback", [action, ""]) as? String ?? ""
        let push = Core.view("callPushKind", [meta]) as? String
        let isEnd = action["step"] as? String == "end"
        crypto.run({ (crypto: CryptoService) -> Bool in
            let result = self.deliver(crypto, chatId: chatId, peerId: peerId, clientId: clientId, text: fallback, attachment: NSNull(), meta: meta, push: push)
            if case .success = result { return true }
            if !isEnd { _ = crypto.callNow("forget", [chatId, clientId]) }
            return false
        }, done: { (sent: Bool) -> Void in
            // The chat on screen shows the call's row at once.
            if sent && isEnd { NotificationCenter.default.post(name: Messenger.changed, object: chatId) }
        })
    }

    /// The STUN and TURN servers of a call with this account's short-lived relay password, as the server gives
    /// them (`GET /calls/ice`); nil when they could not be asked for. Main queue.
    func callIceServers(done: @escaping ([[String: Any]]?) -> Void) {
        server.op("callIce", []) { result in
            var servers: [[String: Any]]? = nil
            if case .success(let body) = result { servers = (body as? [String: Any])?["iceServers"] as? [[String: Any]] }
            DispatchQueue.main.async { done(servers) }
        }
    }

    /// Whether this account may ring that person (`incoming`: whether that person may ring this account) — the
    /// callee decides in Настройки › Конфиденциальность › Звонки. nil: the server could not be asked. Main queue.
    func callAllowed(_ userId: String, incoming: Bool, done: @escaping (Bool?) -> Void) {
        let args: [Any] = incoming ? [userId, "incoming"] : [userId]
        server.op("callPermission", args) { result in
            var allowed: Bool? = nil
            if case .success(let body) = result { allowed = (body as? [String: Any])?["allowed"] as? Bool }
            DispatchQueue.main.async { done(allowed) }
        }
    }

    /// The person of a chat, from the server's list of chats; nil when the chat is not in it. Main queue.
    func callPeer(chatId: String, done: @escaping (Person?) -> Void) {
        server.op("chats", []) { result in
            var found: Person? = nil
            if case .success(let body) = result {
                let list = (body as? [String: Any])?["chats"] as? [[String: Any]] ?? []
                for chat in list where chat["id"] as? String == chatId { found = Person(chat["peer"]) }
            }
            DispatchQueue.main.async { done(found) }
        }
    }
}

/// Hears the signals of calls. A call's step arrives like any message: the live line says «a message came», the
/// chat's inbox is read and decrypted the usual way, and only then is the message seen to be a call's step —
/// the reference's `acceptMessage`. After every (re)connection the chats that just heard from the other side are
/// looked into as well, so a call that began while the app was closed or the line was down still rings (the
/// reference's `loadMessages` on «ready»). Main queue.
final class CallSignals {
    private weak var messenger: Messenger?
    private let userId: String
    /// A decrypted message of the other side whose `meta.action` is a call's step.
    var onSignal: (([String: Any]) -> Void)?
    /// The server says how far an outgoing call got: the chat and "online", "push" or "none".
    var onReach: ((String, String) -> Void)?
    /// The live line went up or down.
    var onLine: (() -> Void)?

    init(messenger: Messenger) {
        self.messenger = messenger
        userId = messenger.userId
        NotificationCenter.default.addObserver(self, selector: #selector(event(_:)), name: Live.callEvent, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func event(_ note: Notification) {
        guard let data = note.userInfo?["event"] as? [String: Any], let type = data["type"] as? String else { return }
        switch type {
        case "message":
            if let message = data["message"] as? [String: Any] { accept(message) }
        case "call.reach":
            if let chatId = data["chatId"] as? String, let reach = data["reach"] as? String { onReach?(chatId, reach) }
        case "ready":
            onLine?()
            catchUp()
        case "line":
            onLine?()
        default:
            break
        }
    }

    private static func isSignal(_ message: [String: Any], me: String) -> Bool {
        guard message["senderId"] as? String != me, message["cryptoState"] as? String == "decrypted" else { return false }
        let action = (message["meta"] as? [String: Any])?["action"] as? [String: Any]
        return action?["type"] as? String == "call"
    }

    /// A message the live line announced: opened here, and handed over when it is a call's step.
    private func accept(_ raw: [String: Any]) {
        guard let messenger, raw["senderId"] as? String != userId, let chatId = raw["chatId"] as? String else { return }
        let me = userId
        messenger.crypto.run({ (crypto: CryptoService) -> [String: Any]? in
            _ = crypto.callNow("sync", [chatId])
            guard case .success(let value) = crypto.callNow("preview", [raw]), let opened = value as? [String: Any] else { return nil }
            return CallSignals.isSignal(opened, me: me) ? opened : nil
        }, done: { [weak self] (opened: [String: Any]?) -> Void in
            if let opened { self?.onSignal?(opened) }
        })
    }

    /// After a (re)connection: a chat whose last message came from the other side within the last 70 seconds may
    /// hold a call that is still ringing.
    private func catchUp() {
        guard let messenger else { return }
        let me = userId
        messenger.server.op("chats", []) { [weak self] result in
            guard case .success(let body) = result else { return }
            let list = (body as? [String: Any])?["chats"] as? [[String: Any]] ?? []
            let recent = Date().addingTimeInterval(-70)
            for chat in list {
                guard let chatId = chat["id"] as? String, let last = chat["lastMessage"] as? [String: Any], last["senderId"] as? String != me,
                      let at = Messenger.date(last["createdAt"] as? String), at >= recent else { continue }
                DispatchQueue.main.async { self?.look(chatId) }
            }
        }
    }

    /// The call steps of a chat's newest page from the last two minutes, in the order they were sent (the offer,
    /// then a hang-up if there was one); the engine itself drops what is stale or already seen.
    private func look(_ chatId: String) {
        guard let messenger else { return }
        let me = userId
        messenger.crypto.run({ (crypto: CryptoService) -> [[String: Any]] in
            _ = crypto.callNow("sync", [chatId])
            guard case .success(let body) = messenger.server.opAndWait("messages", [chatId]) else { return [] }
            let list = (body as? [String: Any])?["messages"] as? [[String: Any]] ?? []
            let fresh = Date().addingTimeInterval(-120)
            var found: [(id: Int, message: [String: Any])] = []
            for message in list {
                guard message["senderId"] as? String != me, let at = Messenger.date(message["createdAt"] as? String), at >= fresh else { continue }
                guard case .success(let value) = crypto.callNow("preview", [message]), let opened = value as? [String: Any], CallSignals.isSignal(opened, me: me) else { continue }
                found.append(((message["id"] as? NSNumber)?.intValue ?? 0, opened))
            }
            found.sort { (a: (id: Int, message: [String: Any]), b: (id: Int, message: [String: Any])) -> Bool in a.id < b.id }
            return found.map { (item: (id: Int, message: [String: Any])) -> [String: Any] in item.message }
        }, done: { [weak self] (signals: [[String: Any]]) -> Void in
            for signal in signals { self?.onSignal?(signal) }
        })
    }
}

/// What the phone says about its network, for calls: whether there is one at all («Ожидание сети…»), and when it
/// became another one (Wi-Fi ↔ mobile) — a live call then restarts ICE at once instead of waiting for the old
/// path to time out. The system's own path monitor: nothing is contacted. Main queue.
final class CallNetwork {
    private let monitor = NWPathMonitor()
    private var key: String?
    /// nil until the system has said.
    private(set) var online: Bool?
    /// The phone lost its network, or has one again.
    var onOnline: (() -> Void)?
    /// The phone switched networks (not when it merely lost one).
    var onChange: (() -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] (path: NWPath) -> Void in
            var words = "offline"
            if path.status == .satisfied {
                let kind = path.usesInterfaceType(.wifi) ? "wifi" : path.usesInterfaceType(.cellular) ? "cellular" : path.usesInterfaceType(.wiredEthernet) ? "wired" : "other"
                words = kind + "|" + (path.availableInterfaces.first?.name ?? "")
            }
            DispatchQueue.main.async { self?.heard(words) }
        }
        monitor.start(queue: DispatchQueue(label: "invizent.call-network"))
    }

    func stop() { monitor.cancel() }

    private func heard(_ words: String) {
        let previous = key
        key = words
        let now = words != "offline"
        if online != now {
            online = now
            onOnline?()
        }
        // Going offline is not a change to act on; coming back on another network is.
        if previous == nil || previous == words || words == "offline" { return }
        onChange?()
    }
}
