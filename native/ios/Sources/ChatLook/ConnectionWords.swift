import Network
import UIKit

/// The state of the connection in the chat header's status line (the reference's ChatScreen.tsx `headerStatus`):
/// «соединение…» while the live line is being opened, «ожидание сети…» while the phone has no network at all.
/// (The reference's «Mesh · без интернета» needs the nearby mesh, which this app does not have.)
final class ChatLookConnection {
    static let shared = ChatLookConnection()
    /// Posted (object nil) when the words may have changed.
    static let changed = Notification.Name("invizent.chat-connection")

    private let monitor = NWPathMonitor()
    private(set) var networkUp = true
    private var started = false
    private var lineWatch: NSObjectProtocol?

    private init() {}

    /// Starts watching the phone's network and the live line (once). Main thread.
    func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] (path: NWPath) -> Void in
            let up = path.status == .satisfied
            DispatchQueue.main.async {
                guard let self, self.networkUp != up else { return }
                self.networkUp = up
                NotificationCenter.default.post(name: ChatLookConnection.changed, object: nil)
            }
        }
        monitor.start(queue: DispatchQueue(label: "invizent.chat-connection", qos: .utility))
        // The live line tells its changes as a call event of type «line» (Net/Live.swift).
        lineWatch = NotificationCenter.default.addObserver(forName: Live.callEvent, object: nil, queue: .main) { (note: Notification) -> Void in
            guard ((note.userInfo?["event"] as? [String: Any])?["type"] as? String) == "line" else { return }
            NotificationCenter.default.post(name: ChatLookConnection.changed, object: nil)
        }
    }

    /// The words for the status line while the connection is not up; nil when it is (then the usual line shows).
    /// In the background the line is closed on purpose: nothing is said then.
    func words(_ messenger: Messenger?) -> String? {
        #if targetEnvironment(simulator)
        if let demo = UserDefaults.standard.string(forKey: "chatlookline") {
            return demo == "offline" ? "ожидание сети…" : demo == "connecting" ? "соединение…" : nil
        }
        #endif
        guard let messenger, UIApplication.shared.applicationState != .background else { return nil }
        start()
        let line = messenger.live.line
        if line == "connected" { return nil }
        if !networkUp { return "ожидание сети…" }
        return "соединение…"
    }
}
