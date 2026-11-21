import UIKit

extension Live {
    /// Posted on the main queue for what rooms need from the live line: `userInfo["event"]` is the server's event —
    /// `room.created`, `room.updated`, `room.removed`, `room.state`, `room.ring` (the list of rooms and the ring),
    /// `voice.joined`, `voice.signal`, `voice.auth`, `voice.left`, `voice.state`, `voice.kicked` (the voice of the
    /// room this phone is in), `error` (the server refused what was asked over the line) and `ready`.
    static let roomEvent = Notification.Name("invizent.room-event")
}

/// Somebody who is inside a room right now (`VoiceMember` of the reference).
struct RoomInside {
    let userId: String
    let muted: Bool
}

/// A room («комната»): a lasting voice room for a fixed set of friends, outside communities (`Room` of the
/// reference's rooms.ts). The server keeps only the name and the list of members; who is inside is live.
struct Room {
    let id: String
    let name: String
    /// The name was made from the members' names (nobody renamed the room).
    let auto: Bool
    let members: [Person]
    let inside: [RoomInside]
    /// Somebody is inside, or the last one left less than five minutes ago.
    let awake: Bool
    /// Empty when nobody has been in the room yet.
    let lastActiveAt: String
    let createdAt: String

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let id = fields["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        name = fields["name"] as? String ?? ""
        auto = fields["auto"] as? Bool ?? false
        members = Person.list(fields["members"])
        var found: [RoomInside] = []
        for item in fields["inside"] as? [[String: Any]] ?? [] {
            guard let userId = item["userId"] as? String else { continue }
            found.append(RoomInside(userId: userId, muted: item["muted"] as? Bool ?? false))
        }
        inside = found
        awake = fields["awake"] as? Bool ?? false
        lastActiveAt = fields["lastActiveAt"] as? String ?? ""
        createdAt = fields["createdAt"] as? String ?? ""
    }
}

/// «Зовёт в комнату»: the call that is ringing right now.
struct RoomRing {
    let roomId: String
    let name: String
    let from: Person
    /// When it arrived, milliseconds since 1970.
    let at: Double

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let roomId = fields["roomId"] as? String, let from = Person(fields["from"]) else { return nil }
        self.roomId = roomId
        name = fields["name"] as? String ?? ""
        self.from = from
        at = (fields["at"] as? NSNumber)?.doubleValue ?? 0
    }
}

/// The rules of rooms, asked of the shared core (native/core/src/rooms.rs — a port of the reference's rooms.ts,
/// voiceAuth.ts and the music wire of roomMusic.tsx, the same on both phones). Nothing here decides by itself.
enum RoomRules {
    private static let rules: [String: Any] = Core.view("roomRules", []) as? [String: Any] ?? [:]
    private static func number(_ key: String, _ otherwise: Double) -> Double { (rules[key] as? NSNumber)?.doubleValue ?? otherwise }

    /// Members of a room, this account included.
    static var limit: Int { Int(number("limit", 12)) }
    static var maxName: Int { Int(number("maxName", 48)) }
    /// How long «зовёт в комнату» rings before it gives up by itself.
    static var ringTime: TimeInterval { number("ringMs", 30_000) / 1000 }
    /// A connection whose end-to-end check has not come in this time is refused.
    static var authTimeout: TimeInterval { number("authTimeoutMs", 20_000) / 1000 }
    static var linkPoll: TimeInterval { number("linkPollMs", 4_000) / 1000 }
    static var speakingPoll: TimeInterval { number("speakingPollMs", 350) / 1000 }
    static var speakingLevel: Double { number("speakingLevel", 0.02) }
    static var musicDrift: Double { number("musicDrift", 2.5) }
    static var musicBeat: TimeInterval { number("musicBeatMs", 4_000) / 1000 }
    static var musicOff: String { rules["musicOff"] as? String ?? "{\"type\":\"music\",\"off\":true}" }
    static var refused: String { rules["refused"] as? String ?? "Не удалось подтвердить шифрование с участником — соединение с ним отключено." }
    /// The green of «somebody is inside» and «is talking».
    static var talk: UIColor { UIColor(hex: Messenger.color(rules["talk"] as? String ?? "#3EE08E")) }
    static var talkHex: String { rules["talk"] as? String ?? "#3EE08E" }

    static var nowMs: Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    /// «трое внутри» for 3, «5 внутри» above four.
    static func insideLine(_ count: Int) -> String { Core.view("roomInsideLine", [count]) as? String ?? "\(count) внутри" }

    /// «спит · были вчера в 18:20». The phone says what only it knows about its time zone.
    static func sleepLine(_ room: Room, now: Date = Date()) -> String {
        let nowMs = (now.timeIntervalSince1970 * 1000).rounded()
        guard !room.lastActiveAt.isEmpty, let at = Messenger.date(room.lastActiveAt) else {
            return Core.view("roomSleepLine", [NSNull(), nowMs, 0, 0, 0]) as? String ?? "спит"
        }
        let calendar = Calendar.current
        let midnightAt = (calendar.startOfDay(for: at).timeIntervalSince1970 * 1000).rounded()
        let midnightNow = (calendar.startOfDay(for: now).timeIntervalSince1970 * 1000).rounded()
        let offset = Double(TimeZone.current.secondsFromGMT(for: at)) / 60
        return Core.view("roomSleepLine", [room.lastActiveAt, nowMs, midnightAt, midnightNow, offset]) as? String ?? "спит"
    }

    /// Where everyone sits, as fractions of the stage (the centre of each picture): this account in the middle,
    /// the others around it — always in the same places for the same people.
    static func seats(_ room: Room, me: String) -> [String: CGPoint] {
        let members: [[String: Any]] = room.members.map { (member: Person) -> [String: Any] in ["id": member.id] }
        let source: [String: Any] = ["id": room.id, "members": members]
        var out: [String: CGPoint] = [:]
        for seat in Core.view("roomSeats", [source, me]) as? [[String: Any]] ?? [] {
            guard let id = seat["id"] as? String, let x = (seat["x"] as? NSNumber)?.doubleValue, let y = (seat["y"] as? NSNumber)?.doubleValue else { continue }
            out[id] = CGPoint(x: x, y: y)
        }
        return out
    }

    /// The size of a picture for a room of this many people on a stage this wide.
    static func seatSize(members: Int, stage: CGFloat) -> CGFloat {
        CGFloat((Core.view("roomSeatSize", [members, Double(stage)]) as? NSNumber)?.doubleValue ?? 58)
    }

    /// The first name of a person, as the room shows it under the picture.
    static func firstName(_ person: Person) -> String {
        let parts = person.displayName.split(whereSeparator: { (character: Character) -> Bool in character.isWhitespace })
        return parts.first.map { String($0) } ?? person.displayName
    }
}
