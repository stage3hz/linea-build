import UIKit

/// The live line to the server: what happens while the app is open comes over it at once — a new message, a
/// read mark, the other side typing. It carries no message text the app trusts: an event only says «look again»,
/// and what is shown is read and decrypted the usual way.
///
/// Closed in the background (the other side then sees «был(а) только что»), opened again in front; a lost line
/// is retried with growing pauses. The line alone never signs anyone out.
final class Live: NSObject, URLSessionWebSocketDelegate {
    enum Event {
        /// Connected and signed in: everything should be read afresh.
        case ready
        /// Something changed in a chat (a message, an edit, a read mark of ours).
        case chat(String?)
        /// The other side read up to a message.
        case read(chatId: String, userId: String, messageId: Int)
        case typing(chatId: String, userId: String, on: Bool)
    }

    private let server: Server
    private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
    private var socket: URLSessionWebSocketTask?
    private var attempts = 0
    private var stopped = true
    private var lastReceive = Date()
    private var beat: Timer?
    /// Called on the main queue.
    var onEvent: ((Event) -> Void)?

    // People (Sources/People): who is in the line now and who was when — the server's `presence` items by the
    // person's id, as they come (PresenceWords words them). Main queue only.
    private(set) var presence: [String: [String: Any]] = [:]
    /// Posted on the main queue when `presence` changed: `object` is the person's id, or nil for everyone.
    static let presenceChanged = Notification.Name("invizent.presence")
    /// Posted on the main queue when friends or requests to be friends changed on the server.
    static let friendsChanged = Notification.Name("invizent.friends")

    init(server: Server) {
        self.server = server
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(sleep), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(wake), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        beat?.invalidate()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    func start() {
        stopped = false
        connect()
        beat?.invalidate()
        beat = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.tick() }
    }

    /// Closes the line for good (the account was signed out): it does not come back with the app.
    func stop() {
        closed = true
        sleep()
    }
    private var closed = false

    // Calls (Sources/Calls): whether the line is up — "connecting", "connected" or "offline" — told as
    // `Live.callEvent` when it changes; and the hold a live call puts on the line.
    private(set) var line = "offline" {
        didSet { if line != oldValue { NotificationCenter.default.post(name: Live.callEvent, object: nil, userInfo: ["event": ["type": "line"]]) } }
    }
    var heldByCall = false {
        didSet { if oldValue && !heldByCall && UIApplication.shared.applicationState == .background { sleep() } }
    }

    @objc private func wake() { if stopped && !closed { start() } }

    @objc private func sleep() {
        // Calls: a live call keeps the line open in the background (its signalling goes through it).
        if heldByCall && !closed { return }
        stopped = true
        line = "offline"
        beat?.invalidate()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func connect() {
        guard !stopped, socket == nil, server.base.hasPrefix("https://"), let url = URL(string: "wss://" + String(server.base.dropFirst("https://".count)) + "/ws") else { return }
        let task = session.webSocketTask(with: url)
        socket = task
        line = "connecting"
        lastReceive = Date()
        task.resume()
        listen(task)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === socket, let token = server.token else { return }
        // A session bound to this device sends its proof with the token; without one the server closes the line.
        var auth: [String: Any] = ["type": "auth", "token": token, "lean": true]
        if let proof = server.currentProof { auth["proof"] = proof }
        guard let frame = Core.text(auth) else { return }
        webSocketTask.send(.string(frame)) { _ in }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === socket else { return }
        socket = nil
        retry()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === socket else { return }
        socket = nil
        retry()
    }

    private func retry() {
        line = "offline"
        guard !stopped else { return }
        let pause = min(pow(2, Double(attempts)), 15)
        attempts += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + pause) { [weak self] in self?.connect() }
    }

    private func tick() {
        guard let socket else { return connect() }
        // A line that has been silent for too long is taken down and opened again.
        if Date().timeIntervalSince(lastReceive) > 45 {
            socket.cancel(with: .goingAway, reason: nil)
            self.socket = nil
            return connect()
        }
        socket.send(.string("{\"type\":\"ping\"}")) { _ in }
    }

    private func listen(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, task === self.socket else { return }
                guard case .success(let message) = result else { return }
                self.lastReceive = Date()
                if case .string(let text) = message, let data = Core.value(text) as? [String: Any], let type = data["type"] as? String { self.handle(type, data) }
                self.listen(task)
            }
        }
    }

    private func handle(_ type: String, _ data: [String: Any]) {
        // Channels (Sources/Channels): events about communities go to that section as they come.
        if type == "ready" || type.hasPrefix("community") { NotificationCenter.default.post(name: Live.communityEvent, object: nil, userInfo: ["event": data]) }
        // Calls (Sources/Calls): a message may be a call's step; `call.reach` says how far an outgoing call got.
        if type == "ready" || type == "message" || type == "call.reach" { NotificationCenter.default.post(name: Live.callEvent, object: nil, userInfo: ["event": data]) }
        // Rooms (Sources/Rooms): the list of rooms (`room.*`), the voice of the room this phone is in (`voice.*`),
        // and the server's refusal of what was asked of it over the line (`error`).
        if type == "ready" || type == "error" || type.hasPrefix("room.") || type.hasPrefix("voice.") { NotificationCenter.default.post(name: Live.roomEvent, object: nil, userInfo: ["event": data]) }
        // Stories (Sources/Stories): somebody's stories or posts changed, or a story of this account was watched.
        if type == "ready" || type.hasPrefix("story") { NotificationCenter.default.post(name: Live.storyEvent, object: nil, userInfo: ["event": data]) }
        switch type {
        case "ready":
            attempts = 0
            line = "connected"
            onEvent?(.ready)
        case "message":
            onEvent?(.chat((data["message"] as? [String: Any])?["chatId"] as? String))
        case "chat":
            onEvent?(.chat((data["chat"] as? [String: Any])?["id"] as? String))
        case "chat.deleted", "e2ee.devices", "profile":
            onEvent?(.chat(nil))
        case "read":
            if let chatId = data["chatId"] as? String, let userId = data["userId"] as? String, let id = (data["messageId"] as? NSNumber)?.intValue { onEvent?(.read(chatId: chatId, userId: userId, messageId: id)) }
        case "typing":
            if let chatId = data["chatId"] as? String, let userId = data["userId"] as? String { onEvent?(.typing(chatId: chatId, userId: userId, on: data["isTyping"] as? Bool ?? false)) }
        // People (Sources/People): presence and friends.
        case "presence.snapshot":
            var all: [String: [String: Any]] = [:]
            for item in data["items"] as? [[String: Any]] ?? [] {
                if let id = item["userId"] as? String { all[id] = item }
            }
            presence = all
            NotificationCenter.default.post(name: Live.presenceChanged, object: nil)
        case "presence":
            if let item = data["presence"] as? [String: Any], let id = item["userId"] as? String {
                presence[id] = item
                NotificationCenter.default.post(name: Live.presenceChanged, object: id)
            }
        case "friends":
            NotificationCenter.default.post(name: Live.friendsChanged, object: nil)
        default:
            break
        }
    }

    /// Rooms (Sources/Rooms): sends one frame of the room's voice signalling (`voice.join`, `voice.signal`, …).
    /// False when the line is down: nothing was sent.
    func send(_ frame: [String: Any]) -> Bool {
        guard line == "connected", let socket, let text = Core.text(frame) else { return false }
        socket.send(.string(text)) { _ in }
        return true
    }

    /// Tells the other side that the person is typing in a chat (or stopped).
    func typing(chatId: String, on: Bool) {
        guard let frame = Core.text(["type": "typing", "chatId": chatId, "isTyping": on]) else { return }
        socket?.send(.string(frame)) { _ in }
    }
}
