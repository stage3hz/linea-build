import UIKit

/// The server calls of the profile screens, Platina and gifts (the reference's api.ts `profile`, `upload`,
/// `changeStatusEmoji`, `profileGifts`, `sendGift`, `removeGift`). Every answer comes back on the main queue.
extension Messenger {
    /// `PATCH /me` with some fields (NSNull clears one); the fresh profile is kept and the screens are told.
    func patchOwnProfile(_ fields: [String: Any], done: @escaping (Result<[String: Any], ServerError>) -> Void) {
        accountCall("profile", [fields]) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            switch result {
            case .failure(let error): done(.failure(error))
            case .success(let body):
                let fresh = body["user"] as? [String: Any] ?? [:]
                if !fresh.isEmpty { self?.keepOwnProfile(fresh) }
                done(.success(fresh))
            }
        }
    }

    /// Uploads a profile file (the avatar, a GIF, a video avatar, a banner: `POST /uploads`, no purpose — the small
    /// profile limits) and gives the server's `attachment`. The bytes are already cleaned by the caller.
    func uploadProfileFile(_ bytes: Data, name: String, mimeType: String, done: @escaping (Result<[String: Any], ServerError>) -> Void) {
        let server = self.server
        DispatchQueue.global(qos: .userInitiated).async {
            let result = server.uploadPlainFile(bytes, name: name, mimeType: mimeType, purpose: nil)
            DispatchQueue.main.async { done(result) }
        }
    }

    /// The emoji status next to the name; nil puts back the Platina gem (or removes the status).
    func changeStatusEmoji(_ emoji: String?, done: @escaping (Result<[String: Any], ServerError>) -> Void) {
        let value: Any = emoji ?? NSNull()
        accountCall("changeStatusEmoji", [value]) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            switch result {
            case .failure(let error): done(.failure(error))
            case .success(let body):
                let fresh = body["user"] as? [String: Any] ?? [:]
                let status = body["status"] as? [String: Any] ?? [:]
                guard fresh["id"] as? String == self.userId, status["accountId"] as? String == self.userId else {
                    return done(.failure(.network("Сервер вернул настройки другого аккаунта.")))
                }
                self.keepOwnProfile(fresh)
                PlatinaState.shared.take(status)
                done(.success(body))
            }
        }
    }

    func profileGifts(_ userId: String, done: @escaping (Result<(visible: Bool, gifts: [ProfileGift]), ServerError>) -> Void) {
        accountCall("profileGifts", [userId]) { (result: Result<[String: Any], ServerError>) -> Void in
            done(result.map { (body: [String: Any]) -> (visible: Bool, gifts: [ProfileGift]) in
                (visible: body["visible"] as? Bool ?? false, gifts: ProfileGift.list(body["gifts"]))
            })
        }
    }

    func sendGift(_ userId: String, gift: String, message: String, done: @escaping (ServerError?) -> Void) {
        accountCall("sendGift", [userId, gift, message]) { (result: Result<[String: Any], ServerError>) -> Void in
            if case .failure(let error) = result { done(error) } else { done(nil) }
        }
    }

    func removeGift(_ id: String, done: @escaping (ServerError?) -> Void) {
        accountCall("removeGift", [id]) { (result: Result<[String: Any], ServerError>) -> Void in
            if case .failure(let error) = result { done(error) } else { done(nil) }
        }
    }
}

/// A gift on a profile (`ProfileGift` of the reference's api.ts).
struct ProfileGift {
    let id: String
    let gift: String
    let message: String
    let createdAt: String
    /// Nil when the sender is hidden.
    let sender: Person?

    init(id: String, gift: String, message: String, createdAt: String, sender: Person?) {
        self.id = id
        self.gift = gift
        self.message = message
        self.createdAt = createdAt
        self.sender = sender
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let id = fields["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        gift = fields["gift"] as? String ?? ""
        message = fields["message"] as? String ?? ""
        createdAt = fields["createdAt"] as? String ?? ""
        sender = Person(fields["sender"])
    }

    static func list(_ raw: Any?) -> [ProfileGift] {
        return (raw as? [Any] ?? []).compactMap { (row: Any) -> ProfileGift? in ProfileGift(row) }
    }
}

/// The gifts the server knows (server/src/cosmetics.js GIFTS, the reference's ProfilePosts.tsx GIFTS).
enum GiftCatalog {
    struct Gift { let id: String; let emoji: String; let label: String; let colors: (String, String) }
    static let all: [Gift] = [
        Gift(id: "bear", emoji: "🧸", label: "Мишка", colors: ("#C98B5A", "#7A4B2A")), Gift(id: "rose", emoji: "🌹", label: "Роза", colors: ("#E0465E", "#7C1730")),
        Gift(id: "cake", emoji: "🎂", label: "Торт", colors: ("#F59BC0", "#A64D79")), Gift(id: "bouquet", emoji: "💐", label: "Букет", colors: ("#F7A8C4", "#8C3D6B")),
        Gift(id: "rocket", emoji: "🚀", label: "Ракета", colors: ("#5B7CFA", "#20307A")), Gift(id: "trophy", emoji: "🏆", label: "Кубок", colors: ("#F2C14E", "#8A5A12")),
        Gift(id: "diamond", emoji: "💎", label: "Бриллиант", colors: ("#7FD6F5", "#2A6E9E")), Gift(id: "champagne", emoji: "🍾", label: "Шампанское", colors: ("#B9D67A", "#4E6B22")),
        Gift(id: "present", emoji: "🎁", label: "Подарок", colors: ("#F26D6D", "#8E2433")), Gift(id: "ring", emoji: "💍", label: "Кольцо", colors: ("#D9D3F5", "#6B5FA8")),
        Gift(id: "unicorn", emoji: "🦄", label: "Единорог", colors: ("#D59BF6", "#6A3C9E")), Gift(id: "star", emoji: "⭐", label: "Звезда", colors: ("#FFD86B", "#B5761B")),
        Gift(id: "heart", emoji: "❤️", label: "Сердце", colors: ("#FF6B81", "#9E1B3A")), Gift(id: "crown", emoji: "👑", label: "Корона", colors: ("#F5CE5A", "#7E5A10")),
        Gift(id: "fire", emoji: "🔥", label: "Огонь", colors: ("#FF9A3D", "#A1300F")), Gift(id: "balloon", emoji: "🎈", label: "Шарик", colors: ("#FF7A7A", "#A32F4C")),
    ]

    static func gift(_ id: String) -> Gift {
        return all.first { $0.id == id } ?? Gift(id: id, emoji: "🎁", label: "Подарок", colors: ("#8E8E93", "#3A3A3C"))
    }
}
