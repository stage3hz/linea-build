import UIKit

/// Old chats on a new device (docs/HISTORY-TRANSFER.md), as the running app does it. The whole logic is the
/// core's (`e2ee::history_sync`, the operations `history.*` of the encryption service): this only says when.
/// (The previous app: `mobile/src/e2ee/historyRuntime.ts`.)
/// - At the start: a device without any cached chat asks for a copy once; a copy that is ready is imported;
///   requests of newer own devices whose 10-minute wait is over are answered.
/// - Live events `history.request` / `history.ready` / `history.backup` (Net/Live.swift) bring those steps forward.
/// - The encrypted backup is kept going every 30 minutes while the app runs.
final class HistoryTransfer {
    static let shared = HistoryTransfer()
    /// Posted on the main queue when the status below changed.
    static let changed = Notification.Name("invizent.history")
    /// Live events about old chats (posted by Net/Live.swift with `userInfo["event"]`).
    static let event = Notification.Name("invizent.live.history")

    /// On a new device: when the copy from another device may start (the server's 10-minute wait).
    private(set) var waitingUntil: String?
    /// The copy is being imported.
    private(set) var receiving = false
    /// Messages imported on this device since the app started.
    private(set) var imported = 0
    private weak var messenger: Messenger?
    private var serveTimer: Timer?
    private var backupTimer: Timer?
    private var receiveTimer: Timer?

    /// Called once by the signed-in account (Messenger), after the keys were published.
    func start(_ messenger: Messenger) {
        self.messenger = messenger
        waitingUntil = nil
        receiving = false
        imported = 0
        for timer in [serveTimer, backupTimer, receiveTimer] { timer?.invalidate() }
        let centre = NotificationCenter.default
        centre.removeObserver(self)
        centre.addObserver(self, selector: #selector(heard(_:)), name: HistoryTransfer.event, object: nil)
        receive()
        serve()
        backupTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] (_: Timer) -> Void in self?.backup() }
    }

    @objc private func heard(_ note: Notification) {
        guard let data = note.userInfo?["event"] as? [String: Any], let type = data["type"] as? String else { return }
        switch type {
        case "history.request": serve()
        case "history.ready": receive()
        case "history.backup": backup()
        default: break
        }
    }

    private func tell() { NotificationCenter.default.post(name: HistoryTransfer.changed, object: nil) }

    static func date(_ text: String) -> Date? {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// Asks for a copy once (a device without cached chats), then imports one that is ready.
    func receive() {
        guard let messenger else { return }
        messenger.crypto.call("history.ask") { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self else { return }
            if case .success(let value) = result, let transfer = value as? [String: Any], transfer["state"] as? String == "waiting" {
                self.waitingUntil = transfer["notBefore"] as? String
            }
            self.receiving = true
            self.tell()
            messenger.crypto.call("history.receive") { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
                guard let self else { return }
                self.receiving = false
                if case .success(let value) = result, let count = (value as? NSNumber)?.intValue {
                    self.imported += count
                    self.waitingUntil = nil
                    NotificationCenter.default.post(name: Messenger.changed, object: nil)
                } else if self.waitingUntil != nil {
                    // Still waiting: look again now and then (the live event usually comes first).
                    self.receiveTimer?.invalidate()
                    self.receiveTimer = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] (_: Timer) -> Void in self?.receive() }
                }
                self.tell()
            }
        }
    }

    /// Answers the requests of newer own devices whose wait is over; comes back when the next one is due.
    func serve() {
        guard let messenger else { return }
        messenger.crypto.call("history.serve") { [weak self] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self, case .success(let value) = result, let next = value as? String, let at = HistoryTransfer.date(next) else { return }
            self.serveTimer?.invalidate()
            self.serveTimer = Timer.scheduledTimer(withTimeInterval: max(1, at.timeIntervalSinceNow + 2), repeats: false) { [weak self] (_: Timer) -> Void in self?.serve() }
        }
    }

    /// Keeps the encrypted backup going (when it is on and this device holds its secret).
    func backup() {
        guard let messenger else { return }
        messenger.crypto.call("history.backup") { [weak self] (_: Result<Any, CryptoFailure>) -> Void in
            guard let self else { return }
            self.backupTimer?.invalidate()
            self.backupTimer = Timer.scheduledTimer(withTimeInterval: 30 * 60, repeats: false) { [weak self] (_: Timer) -> Void in self?.backup() }
        }
    }
}
