#if targetEnvironment(simulator)
import UIKit

/// Made-up people dressed in every decoration, for the simulator checks of avatars, profiles and Platina (no
/// account). Compiled for the simulator only.
enum ProfileSamples {
    private static func look(_ fields: [String: Any]) -> PersonLook { return PersonLook(fields) }

    private static func person(_ index: Int, _ name: String, _ username: String, _ color: UInt32, bio: String = "", birthday: String = "", look fields: [String: Any] = [:]) -> Person {
        var made = Person(id: "sample-person-\(index)", username: username, displayName: name, bio: bio, birthday: birthday, avatarColor: color, avatarId: "")
        var all = fields
        if !birthday.isEmpty { all["birthday"] = birthday }
        made.look = look(all)
        return made
    }

    /// Today as «MM-DD» (a birthday that is today).
    static var today: String {
        let parts = Calendar.current.dateComponents([.month, .day], from: Date())
        return String(format: "%02d-%02d", parts.month ?? 1, parts.day ?? 1)
    }

    static let permanentStatus: [String: Any] = ["statusEmoji": "🔥", "statusEmojiPermanent": true, "statusEmojiExpiresAt": NSNull()]

    /// The signed-in sample account.
    static var me: Person {
        var fields: [String: Any] = ["seal": "platina", "avatarFrame": "platinum", "bannerPreset": "aurora", "profileEffect": "sparks", "nameplate": "deep", "profilePattern": "⭐"]
        for (key, value) in permanentStatus { fields[key] = value }
        return person(0, "Мария Орлова", "maria", 0x9271C3, bio: "Рисую карты и собираю гербарий.", birthday: "03-02", look: fields)
    }

    /// A sample of each kind of frame: rings, code frames, art.
    static func dressed(_ frame: String, _ index: Int) -> Person {
        return person(10 + index, "Алиса Воронцова", "alisa_v", [0x5E7BFF, 0xF2A33C, 0x4FB86A, 0xF26B5E, 0x3CA7F2, 0x9B6BF2][index % 6], look: ["avatarFrame": frame, "seal": "platina"])
    }

    static var birthdayFriend: Person {
        return person(30, "Дмитрий Орлов", "orlov", 0xF2A33C, bio: "Сегодня мой день.", birthday: today, look: ["gender": "male"])
    }

    static var platinaFriend: Person {
        var fields: [String: Any] = ["seal": "platina", "avatarFrame": "fx-aurora", "bannerPreset": "glacier", "profileEffect": "snow", "nameplate": "night", "profilePattern": "🦋"]
        for (key, value) in permanentStatus { fields[key] = value }
        fields["statusEmoji"] = "💎"
        return person(31, "Вера Соколова", "vera_s", 0x9B6BF2, bio: "Фотограф. Горы, туман и плёнка.", birthday: "07-14", look: fields)
    }

    static func gifts(own: Bool) -> [ProfileGift] {
        let senders = [person(40, "Лев", "lev_m", 0x4FB86A), person(41, "Марина Ким", "marina.kim", 0xF26B5E), person(42, "Саша", "sasha", 0x3CA7F2)]
        return [
            ProfileGift(id: "g1", gift: "rose", message: "С днём рождения!", createdAt: "", sender: senders[0]),
            ProfileGift(id: "g2", gift: "rocket", message: "", createdAt: "", sender: senders[1]),
            ProfileGift(id: "g3", gift: "crown", message: "Ты лучшая", createdAt: "", sender: senders[2]),
            ProfileGift(id: "g4", gift: "bear", message: "", createdAt: "", sender: nil),
            ProfileGift(id: "g5", gift: "diamond", message: "", createdAt: "", sender: senders[0]),
        ]
    }

    /// A drawn picture standing in for a photo (sample avatars and banners).
    static func picture(_ seed: Int, size: CGSize = CGSize(width: 600, height: 600)) -> UIImage {
        let colors: [(UInt32, UInt32)] = [(0x2B5876, 0x4E4376), (0xF2994A, 0xEB5757), (0x11998E, 0x38EF7D), (0x8E2DE2, 0x4A00E0)]
        let pair = colors[seed % colors.count]
        return UIGraphicsImageRenderer(size: size).image { (context: UIGraphicsImageRendererContext) -> Void in
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [UIColor(hex: pair.0).cgColor, UIColor(hex: pair.1).cgColor] as CFArray, locations: [0, 1])
            if let gradient { context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: []) }
            UIColor(white: 1, alpha: 0.25).setFill()
            for index in 0..<5 {
                let r = size.width * CGFloat(0.08 + Double(index) * 0.03)
                context.cgContext.fillEllipse(in: CGRect(x: size.width * CGFloat(0.15 + Double(index) * 0.17), y: size.height * CGFloat(0.6 - Double(index % 2) * 0.3), width: r, height: r))
            }
        }
    }
}
#endif
