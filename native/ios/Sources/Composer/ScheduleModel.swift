import Foundation

/// «Отправить без звука» / «Отправить позже» — the pure part (the reference's scheduled/model.ts): what a
/// scheduled item is, the presets of the picker, the words of the list, when an item can be sent again.
///
/// The server keeps a scheduled message as the same end-to-end encrypted envelopes a normal send uses (it never
/// sees the text); the text shown in the list comes from this device's vault.
enum ScheduleModel {
    /// At least a minute ahead, at most a year.
    static let minAhead: TimeInterval = 60
    static let maxAhead: TimeInterval = 365 * 86_400

    private static let months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]

    static func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        let a = n % 10, b = n % 100
        if a == 1 && b != 11 { return one }
        if a >= 2 && a <= 4 && (b < 12 || b > 14) { return few }
        return many
    }

    private static func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    /// «20:05».
    static func timeLabel(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return two(parts.hour ?? 0) + ":" + two(parts.minute ?? 0)
    }

    /// `day` at hour:minute, local time.
    static func withDayTime(_ day: Date, hour: Int, minute: Int) -> Date {
        let calendar = Calendar.current
        var parts = calendar.dateComponents([.year, .month, .day], from: day)
        parts.hour = hour
        parts.minute = minute
        parts.second = 0
        parts.nanosecond = 0
        return calendar.date(from: parts) ?? day
    }

    private static func adding(days: Int, to date: Date) -> Date {
        Calendar.current.date(byAdding: .day, value: days, to: date) ?? date.addingTimeInterval(TimeInterval(days) * 86_400)
    }

    private static func sameDay(_ a: Date, _ b: Date) -> Bool { Calendar.current.isDate(a, inSameDayAs: b) }

    /// The quick choices: in an hour, tonight (while it is still ahead), tomorrow morning.
    static func presets(now: Date = Date()) -> [(label: String, at: Date)] {
        var presets: [(label: String, at: Date)] = []
        // In an hour, rounded up to five minutes.
        let calendar = Calendar.current
        let later = now.addingTimeInterval(3600)
        let minute = calendar.component(.minute, from: later)
        let rounded = Int(ceil(Double(minute) / 5) * 5)
        var parts = calendar.dateComponents([.year, .month, .day, .hour], from: later)
        parts.minute = 0
        parts.second = 0
        parts.nanosecond = 0
        let hourStart = calendar.date(from: parts) ?? later
        presets.append((label: "Через час", at: hourStart.addingTimeInterval(TimeInterval(rounded * 60))))
        let tonight = withDayTime(now, hour: 20, minute: 0)
        if tonight.timeIntervalSince(now) >= 30 * 60 { presets.append((label: "Сегодня в 20:00", at: tonight)) }
        let tomorrow = adding(days: 1, to: now)
        presets.append((label: "Завтра в 09:00", at: withDayTime(tomorrow, hour: 9, minute: 0)))
        if presets.count < 3 { presets.append((label: "Завтра в 20:00", at: withDayTime(tomorrow, hour: 20, minute: 0))) }
        return presets
    }

    /// Nil when the time can be scheduled; otherwise the reason shown under the picker.
    static func validate(_ at: Date, now: Date = Date()) -> String? {
        let ahead = at.timeIntervalSince(now)
        if ahead < minAhead { return "Время уже прошло — выбери хотя бы минуту вперёд." }
        if ahead > maxAhead { return "Отложить можно не больше чем на год." }
        return nil
    }

    /// «Сегодня в 20:00», «Завтра в 09:00», «15 ноября в 09:00», «3 января 2027 в 10:00».
    static func formatDeliverAt(_ date: Date, now: Date = Date()) -> String {
        let time = timeLabel(date)
        if sameDay(date, now) { return "Сегодня в " + time }
        if sameDay(date, adding(days: 1, to: now)) { return "Завтра в " + time }
        return dayWords(date, now: now) + " в " + time
    }

    static func formatDeliverAt(iso: String, now: Date = Date()) -> String {
        guard let date = Messenger.date(iso) else { return "" }
        return formatDeliverAt(date, now: now)
    }

    private static func dayWords(_ date: Date, now: Date) -> String {
        let calendar = Calendar.current
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let year = parts.year == calendar.component(.year, from: now) ? "" : " \(parts.year ?? 0)"
        return "\(parts.day ?? 1) \(months[max(0, min(11, (parts.month ?? 1) - 1))])" + year
    }

    /// The day shown in the custom picker: «Сегодня», «Завтра» or the date.
    static func dayLabel(_ day: Date, now: Date = Date()) -> String {
        if sameDay(day, now) { return "Сегодня" }
        if sameDay(day, adding(days: 1, to: now)) { return "Завтра" }
        return dayWords(day, now: now)
    }

    static func countScheduled(_ n: Int) -> String {
        "\(n) " + plural(n, "отложенное сообщение", "отложенных сообщения", "отложенных сообщений")
    }

    /// What the list says under an item the server could not release.
    static func failureText(_ code: String?) -> String {
        switch code ?? "" {
        case "E2EE_DEVICES_CHANGED": return "У собеседника изменились устройства. Будет отправлено, когда вы будете в сети."
        case "BLOCKED": return "Переписка с этим пользователем недоступна."
        case "CHAT_GONE": return "Чат удалён."
        case "ATTACHMENT_GONE", "ATTACHMENT_USED": return "Вложение больше недоступно."
        case "CLIENT_ID_USED": return "Это сообщение уже отправлено."
        default: return "Не удалось отправить."
        }
    }

    /// The meta a message goes out with after the long-press menu: `silent: true` rides inside the ciphertext
    /// for the other side's screen (and makes the core ask for a quiet notification). Never on an action.
    static func withSilent(_ meta: [String: Any]?, silent: Bool) -> [String: Any]? {
        guard silent, meta?["action"] == nil else { return meta }
        var out = meta ?? [:]
        out["silent"] = true
        return out
    }

    /// An ISO time as the server and the encryption take it.
    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }
}

/// One row of the server's list (`GET /scheduled`) with its text opened from this device's vault.
struct ScheduledItem {
    let id: String
    let chatId: String
    let clientId: String
    let deliverAt: String
    /// "scheduled" or "failed".
    let status: String
    let failure: String?
    let createdAt: String
    var text = ""
    var attachment: [String: Any]?
    var meta: [String: Any]?
    /// "decrypted" when this device holds the text (another device scheduled it otherwise).
    var cryptoState = ""
    /// The ciphertext when the server sent it (not in the lean list).
    var encrypted: [String: Any]?

    var failed: Bool { status == "failed" }
    var silent: Bool { meta?["silent"] as? Bool == true }

    /// Only a device-set failure is sent again by itself: this device encrypts afresh the text it still holds.
    var canResend: Bool { status == "failed" && failure == "E2EE_DEVICES_CHANGED" && cryptoState == "decrypted" }

    init?(_ row: [String: Any]) {
        guard let id = row["id"] as? String, let chatId = row["chatId"] as? String, let clientId = row["clientId"] as? String else { return nil }
        self.id = id
        self.chatId = chatId
        self.clientId = clientId
        deliverAt = row["deliverAt"] as? String ?? ""
        status = row["status"] as? String ?? "scheduled"
        failure = row["failure"] as? String
        createdAt = row["createdAt"] as? String ?? ""
        encrypted = row["encrypted"] as? [String: Any]
    }

    /// The words of the item's body in the list.
    var body: String {
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        if let attachment { return "📎 " + (attachment["name"] as? String ?? "Файл") }
        return cryptoState == "decrypted" ? "" : "Отложено с другого устройства"
    }
}
