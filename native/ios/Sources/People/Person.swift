import UIKit

/// A person as the server describes them to this account (`User` of the reference's types.ts — the part the
/// native screens show so far).
struct Person {
    let id: String
    let username: String
    let displayName: String
    let bio: String
    /// «MM-DD» or «YYYY-MM-DD»; empty when not set.
    let birthday: String
    /// 0xRRGGBB.
    let avatarColor: UInt32
    /// Empty when there is no picture (or the person does not show it to this account).
    let avatarId: String

    init(id: String, username: String, displayName: String, bio: String, birthday: String, avatarColor: UInt32, avatarId: String) {
        self.id = id
        self.username = username
        self.displayName = displayName
        self.bio = bio
        self.birthday = birthday
        self.avatarColor = avatarColor
        self.avatarId = avatarId
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let id = fields["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        username = fields["username"] as? String ?? ""
        displayName = fields["displayName"] as? String ?? ""
        bio = fields["bio"] as? String ?? ""
        birthday = fields["birthday"] as? String ?? ""
        avatarColor = Messenger.color(fields["avatarColor"] as? String)
        avatarId = fields["avatarId"] as? String ?? ""
    }

    static func list(_ raw: Any?) -> [Person] {
        let rows = raw as? [Any] ?? []
        return rows.compactMap { Person($0) }
    }

    /// The people of a list of friend requests (`FriendRequest` of the reference: `{user, createdAt}`).
    static func requests(_ raw: Any?) -> [Person] {
        let rows = raw as? [[String: Any]] ?? []
        return rows.compactMap { Person($0["user"]) }
    }

    /// The birthday as the reference shows it (birthday.ts `formatBirthday`): «2 мар» or «2 мар 1999».
    var birthdayWords: String {
        let months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
        let parts = birthday.split(separator: "-").map { String($0) }
        guard parts.count == 2 || parts.count == 3 else { return "" }
        guard parts.allSatisfy({ part -> Bool in !part.isEmpty && part.allSatisfy { $0.isASCII && $0.isNumber } }) else { return "" }
        let monthText = parts[parts.count - 2], dayText = parts[parts.count - 1]
        guard monthText.count == 2, dayText.count == 2, let month = Int(monthText), let day = Int(dayText), month >= 1, month <= 12 else { return "" }
        if parts.count == 3 {
            guard parts[0].count == 4, let year = Int(parts[0]) else { return "" }
            return year == 0 ? "\(day) \(months[month - 1])" : "\(day) \(months[month - 1]) \(year)"
        }
        return "\(day) \(months[month - 1])"
    }
}

/// «в сети», «был(а) 5 минут назад», «был(а) вчера в 21:04», «был(а) недавно» — the reference's presence.ts
/// `presenceText`, word for word. The item is the server's `presence` as the live line delivers it.
enum PresenceWords {
    private static let approx: [String: String] = [
        "recently": "был(а) недавно",
        "week": "был(а) на этой неделе",
        "month": "был(а) в этом месяце",
        "long": "был(а) давно",
    ]

    private static func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        if n % 10 == 1 && n % 100 != 11 { return one }
        if n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) { return few }
        return many
    }

    private static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    static func text(_ presence: [String: Any]?, now: Date = Date()) -> String? {
        guard let presence else { return nil }
        if presence["hidden"] as? Bool == true { return approx[presence["approx"] as? String ?? ""] ?? "был(а) недавно" }
        if presence["online"] as? Bool == true { return "в сети" }
        guard let stamp = presence["lastSeenAt"] as? String, !stamp.isEmpty, let seen = Messenger.date(stamp) else { return "был(а) недавно" }
        let diff = now.timeIntervalSince(seen) * 1000
        if diff < 60_000 { return "был(а) только что" }
        if diff < 3_600_000 {
            let minutes = Int(diff / 60_000)
            return "был(а) \(minutes) \(plural(minutes, "минуту", "минуты", "минут")) назад"
        }
        let calendar = Calendar.current
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: seen)
        let time = "\(pad(parts.hour ?? 0)):\(pad(parts.minute ?? 0))"
        let today = calendar.startOfDay(for: now)
        if seen >= today {
            let hours = Int(diff / 3_600_000)
            return hours < 3 ? "был(а) \(hours) \(plural(hours, "час", "часа", "часов")) назад" : "был(а) сегодня в \(time)"
        }
        if seen >= today.addingTimeInterval(-86_400) { return "был(а) вчера в \(time)" }
        let year = (parts.year ?? 0) % 100
        return "был(а) \(pad(parts.day ?? 0)).\(pad(parts.month ?? 0)).\(pad(year))"
    }
}
