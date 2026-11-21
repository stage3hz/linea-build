import UIKit

/// What a person's profile says about them and this account (`UserProfile` of the reference's types.ts).
struct PersonProfile {
    let person: Person
    let isFriend: Bool
    /// "incoming", "outgoing" or nil.
    let request: String?
    let chatId: String?
    let blocked: Bool
}

/// A chat opened with a person: what `ChatViewController` needs.
struct PersonChat {
    let chatId: String
    let peerId: String
    let name: String
    let peerLastRead: Int
}

/// The server calls of «Люди» and of a person's profile. Every answer comes back on the main queue.
extension Messenger {
    private func peopleCall(_ name: String, _ args: [Any], done: @escaping (Result<[String: Any], ServerError>) -> Void) {
        server.op(name, args) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let body): done(.success(body as? [String: Any] ?? [:]))
                case .failure(let error): done(.failure(error))
                }
            }
        }
    }

    private func peopleDone(_ name: String, _ args: [Any], done: @escaping (ServerError?) -> Void) {
        peopleCall(name, args) { result in
            switch result {
            case .success: done(nil)
            case .failure(let error): done(error)
            }
        }
    }

    /// The address of a person's picture and the headers it is asked with (pictures are fetched as this session).
    func personAvatarAddress(_ avatarId: String) -> String {
        guard !avatarId.isEmpty else { return "" }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
        return server.base + "/files/" + (avatarId.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }

    /// Main thread only.
    func preparePersonAvatars() {
        guard let made = Core.prepare(method: "GET", path: "/files/x", jsonBody: false, token: server.token, proof: server.currentProof) else { return }
        ChatAvatarStore.shared.headers = Dictionary(made.headers, uniquingKeysWith: { first, _ in first })
    }

    /// The friends of this account, by name.
    func friends(done: @escaping (Result<[Person], ServerError>) -> Void) {
        peopleCall("contacts", []) { result in done(result.map { Person.list($0["users"]) }) }
    }

    /// Requests to be friends: those that came and those this account sent.
    func friendRequests(done: @escaping (Result<(incoming: [Person], outgoing: [Person]), ServerError>) -> Void) {
        peopleCall("friendRequests", []) { result in
            done(result.map { body -> (incoming: [Person], outgoing: [Person]) in
                (incoming: Person.requests(body["incoming"]), outgoing: Person.requests(body["outgoing"]))
            })
        }
    }

    /// People by @username or name.
    func findPeople(_ query: String, done: @escaping (Result<[Person], ServerError>) -> Void) {
        peopleCall("users", [query]) { result in done(result.map { Person.list($0["users"]) }) }
    }

    func personProfile(_ userId: String, done: @escaping (Result<PersonProfile, ServerError>) -> Void) {
        peopleCall("userProfile", [userId]) { result in
            switch result {
            case .failure(let error): done(.failure(error))
            case .success(let body):
                guard let person = Person(body["user"]) else { return done(.failure(.network("Не удалось загрузить профиль."))) }
                let request = body["friendRequest"] as? String
                done(.success(PersonProfile(person: person, isFriend: body["isContact"] as? Bool ?? false,
                                            request: request == "incoming" || request == "outgoing" ? request : nil,
                                            chatId: body["chatId"] as? String, blocked: body["blocked"] as? Bool ?? false)))
            }
        }
    }

    /// «В друзья»: sends a request, or accepts the one the other person already sent. True when they are friends now.
    func addFriend(_ userId: String, done: @escaping (Result<Bool, ServerError>) -> Void) {
        peopleCall("addContact", [userId]) { result in done(result.map { $0["status"] as? String != "requested" }) }
    }

    func acceptFriend(_ userId: String, done: @escaping (ServerError?) -> Void) { peopleDone("acceptFriend", [userId], done: done) }

    /// Declines a request that came, or takes back one this account sent.
    func dropFriendRequest(_ userId: String, done: @escaping (ServerError?) -> Void) { peopleDone("dropFriendRequest", [userId], done: done) }

    func removeFriend(_ userId: String, done: @escaping (ServerError?) -> Void) { peopleDone("removeContact", [userId], done: done) }

    func setPersonBlocked(_ userId: String, _ blocked: Bool, done: @escaping (ServerError?) -> Void) {
        peopleDone(blocked ? "block" : "unblock", [userId], done: done)
    }

    /// A complaint about a person; `reason` is one of the reference's `ReportReason`.
    func reportPerson(_ userId: String, reason: String, done: @escaping (ServerError?) -> Void) {
        peopleDone("report", [["userId": userId], reason], done: done)
    }

    /// The chat with a person: the one there is, or a new one.
    func chatWith(_ userId: String, done: @escaping (Result<PersonChat, ServerError>) -> Void) {
        peopleCall("createChat", [userId]) { result in
            switch result {
            case .failure(let error): done(.failure(error))
            case .success(let body):
                guard let chat = body["chat"] as? [String: Any], let chatId = chat["id"] as? String else { return done(.failure(.network("Не удалось создать чат."))) }
                let peer = chat["peer"] as? [String: Any]
                done(.success(PersonChat(chatId: chatId, peerId: peer?["id"] as? String ?? userId, name: peer?["displayName"] as? String ?? "",
                                         peerLastRead: (chat["peerLastReadMessageId"] as? NSNumber)?.intValue ?? 0)))
            }
        }
    }

    /// Opens the chat with a person on top of `from`.
    func openChat(with person: Person, from: UIViewController, done: @escaping (ServerError?) -> Void) {
        chatWith(person.id) { [weak self, weak from] result in
            switch result {
            case .failure(let error): done(error)
            case .success(let chat):
                done(nil)
                guard let self, let from else { return }
                let screen = ChatViewController(name: chat.name.isEmpty ? person.displayName : chat.name, messenger: self, chatId: chat.chatId, peerId: chat.peerId)
                screen.peerLastRead = chat.peerLastRead
                from.navigationController?.pushViewController(screen, animated: true)
            }
        }
    }
}

/// The requests to be friends, shared by the «Люди» section, its badge in the list of sections and profiles
/// (the reference's friendRequests.ts). Read at the start, on every «friends» event of the live line and after
/// the account's own actions. Main thread only.
final class FriendRequests {
    static let shared = FriendRequests()
    /// Posted on the main queue when the lists were read again.
    static let changed = Notification.Name("invizent.friend-requests")

    private(set) var incoming: [Person] = []
    private(set) var outgoing: [Person] = []
    private weak var messenger: Messenger?
    private var running = false
    private var again = false

    private init() {
        NotificationCenter.default.addObserver(self, selector: #selector(liveChanged), name: Live.friendsChanged, object: nil)
    }

    /// The account whose requests these are; another account starts from nothing.
    func start(_ messenger: Messenger?) {
        if self.messenger !== messenger {
            self.messenger = messenger
            incoming = []
            outgoing = []
            running = false
            again = false
            NotificationCenter.default.post(name: FriendRequests.changed, object: nil)
        }
        refresh()
    }

    @objc private func liveChanged() { refresh() }

    /// Reads the lists again; several calls at once are one request and one more after it.
    func refresh() {
        guard let messenger else { return }
        if running { again = true; return }
        running = true
        messenger.friendRequests { [weak self, weak messenger] result in
            guard let self, self.messenger === messenger else { return }
            self.running = false
            if case .success(let lists) = result {
                self.incoming = lists.incoming
                self.outgoing = lists.outgoing
                NotificationCenter.default.post(name: FriendRequests.changed, object: nil)
            }
            if self.again { self.again = false; self.refresh() }
        }
    }
}
