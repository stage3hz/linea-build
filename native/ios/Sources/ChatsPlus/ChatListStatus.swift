import Network
import UIKit

/// ChatsPlus: what the chat list says about the connection, the unread and the tab badge — the reference's
/// network/offline.ts (`titleState`, `TITLE_TEXT`), unreadBadge.ts (`badgeText`, the total) and the line under
/// the title in ChatListScreen.tsx.
enum ChatListStatus {
    /// The title: «Чаты» (or «Архив»), else what is going on with the connection.
    enum Title: Equatable {
        case chats
        case waiting
        case connecting
        case updating

        /// The reference's TITLE_TEXT.
        var words: String {
            switch self {
            case .chats: return ""
            case .waiting: return "Ожидание сети…"
            case .connecting: return "Соединение…"
            case .updating: return "Обновление…"
            }
        }
    }

    /// The reference's `titleState` (without Mesh, which the phones do not have yet). `line`: the live line —
    /// "connecting", "connected" or "offline" (Net/Live.swift); `online`: what the phone says about its network
    /// (nil = not known yet); `updating`: the list is being read again after a (re)connect.
    static func title(line: String, online: Bool?, updating: Bool) -> Title {
        if line == "connected" { return updating ? .updating : .chats }
        if online == false { return .waiting }
        if online == true { return .connecting }
        return line == "connecting" ? .connecting : .waiting
    }

    /// Under the title: «3 чата ждут ответа», «всё прочитано» (ChatListScreen.tsx `unreadLine`).
    static func unreadLine(_ count: Int) -> String {
        guard count > 0 else { return "всё прочитано" }
        let last = count % 10, tens = count % 100
        let words: String
        if last == 1 && tens != 11 { words = "чат ждёт" }
        else if last >= 2 && last <= 4 && (tens < 12 || tens > 14) { words = "чата ждут" }
        else { words = "чатов ждут" }
        return "\(count) \(words) ответа"
    }

    /// The reference's `badgeText`: exact up to 999, then «4,3K», «12K», «1,2M».
    static func badgeText(_ n: Int) -> String {
        guard n >= 1 else { return "" }
        if n < 1000 { return String(n) }
        func short(_ value: Double, _ unit: String) -> String {
            if value < 10 {
                let tenths = floor(value * 10) / 10
                var words = String(format: "%.1f", tenths).replacingOccurrences(of: ".", with: ",")
                if words.hasSuffix(",0") { words = String(words.dropLast(2)) }
                return words + unit
            }
            return String(Int(floor(value))) + unit
        }
        if n < 1_000_000 { return short(Double(n) / 1000, "K") }
        return short(Double(n) / 1_000_000, "M")
    }
}

/// What the phone says about its network: `online` is nil until the first answer. Main queue for readers;
/// `changed` is posted on the main queue.
final class NetworkWatch {
    static let shared = NetworkWatch()
    static let changed = Notification.Name("invizent.chats.network")
    private let monitor = NWPathMonitor()
    private(set) var online: Bool?
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] (path: NWPath) -> Void in
            let now = path.status == .satisfied
            DispatchQueue.main.async {
                guard let self, self.online != now else { return }
                self.online = now
                NotificationCenter.default.post(name: NetworkWatch.changed, object: nil)
            }
        }
        monitor.start(queue: DispatchQueue(label: "invizent.chats.network"))
    }
}

/// The number on the «Чаты» tab: the unread messages of chats that are neither archived nor muted, plus one for
/// each such chat marked unread by hand (App.tsx `unreadTotal` + markedUnread.ts `markedExtra`). Main queue.
final class UnreadTotal {
    static let shared = UnreadTotal()
    static let changed = Notification.Name("invizent.chats.unread-total")
    private(set) var total = 0

    func set(_ next: Int) {
        guard next != total else { return }
        total = next
        NotificationCenter.default.post(name: UnreadTotal.changed, object: nil)
    }
}
