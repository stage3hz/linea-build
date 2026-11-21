import UIKit

// Stories and profile posts (the reference's stories/StoriesStrip.tsx, stories/seenPosts.ts and ProfilePosts.tsx).
//
// What is stored where, exactly as the reference has it:
//  - The photo or video of a story or a post is NOT end-to-end encrypted. It is an ordinary profile upload
//    (`POST /uploads?purpose=post`), kept by the server as it is and read back by `GET /files/<id>` by whoever may
//    see the owner's posts — published on purpose, like the avatar. Its metadata is removed on this phone first.
//  - An answer to a story IS end-to-end encrypted: an ordinary message to the author with the story's reference
//    inside the ciphertext (`meta.story`).
//  - Which stories were watched is kept by the server; which posts were opened — on this phone only.
//
// The shared rules (the order of the strip, whose stories the viewer plays, the words, the swipes, the limits) are
// the core's (`native/core/src/stories.rs`), asked by name through `Core.view`.

/// One story or post (`ProfilePost` of the reference's api.ts).
struct StoryPost {
    let id: String
    /// "post" or "story".
    let kind: String
    let caption: String
    let createdAt: String
    /// The id of the uploaded file.
    let mediaId: String
    let isVideo: Bool
    /// How many people watched it: the person's own stories only.
    let views: Int?
    let seen: Bool

    init(id: String, kind: String, caption: String, createdAt: String, mediaId: String, isVideo: Bool, views: Int?, seen: Bool) {
        self.id = id
        self.kind = kind
        self.caption = caption
        self.createdAt = createdAt
        self.mediaId = mediaId
        self.isVideo = isVideo
        self.views = views
        self.seen = seen
    }

    init?(_ raw: Any?) {
        guard let fields = raw as? [String: Any], let id = fields["id"] as? String, !id.isEmpty else { return nil }
        let media = fields["media"] as? [String: Any] ?? [:]
        self.id = id
        kind = fields["kind"] as? String ?? "post"
        caption = fields["caption"] as? String ?? ""
        createdAt = fields["createdAt"] as? String ?? ""
        mediaId = media["id"] as? String ?? ""
        isVideo = media["isVideo"] as? Bool ?? false
        views = (fields["views"] as? NSNumber)?.intValue
        seen = fields["seen"] as? Bool ?? false
    }

    static func list(_ raw: Any?) -> [StoryPost] {
        let rows = raw as? [Any] ?? []
        return rows.compactMap { (row: Any) -> StoryPost? in StoryPost(row) }
    }
}

/// A person's posts and stories as their profile shows them (`ProfilePosts` of the reference).
struct ProfilePostsData {
    /// False: this account may not see them (not a friend, and the person shows them to friends only).
    let visible: Bool
    let posts: [StoryPost]
    let stories: [StoryPost]
}

/// Who watched a story and when (`StoryViewers` of the reference).
struct StoryViewersData {
    let count: Int
    let rows: [(person: Person, viewedAt: String)]
}

/// The core's constants and words of stories, read once.
enum StoryRules {
    private static let all: [String: Any] = Core.view("storiesRules", []) as? [String: Any] ?? [:]
    private static let wordList: [String: Any] = all["words"] as? [String: Any] ?? [:]

    static func word(_ key: String) -> String {
        return wordList[key] as? String ?? ""
    }

    static func number(_ key: String, _ otherwise: Double) -> Double {
        return (all[key] as? NSNumber)?.doubleValue ?? otherwise
    }

    static func text(_ key: String, _ otherwise: String) -> String {
        return all[key] as? String ?? otherwise
    }
}

extension Live {
    /// Posted on the main queue when somebody's stories or posts changed, a story of this account was watched,
    /// or the line came up again: the strip reads the feed anew.
    static let storyEvent = Notification.Name("invizent.story-event")
}

/// The server calls of stories and posts. Every answer comes back on the main queue.
extension Messenger {
    private func storiesCall(_ name: String, _ args: [Any], done: @escaping (Result<[String: Any], ServerError>) -> Void) {
        server.op(name, args) { (result: Result<Any, ServerError>) -> Void in
            DispatchQueue.main.async {
                switch result {
                case .success(let body): done(.success(body as? [String: Any] ?? [:]))
                case .failure(let error): done(.failure(error))
                }
            }
        }
    }

    /// The strip's feed as the server sends it: `{items, mine}`.
    func storiesFeed(done: @escaping (Result<[String: Any], ServerError>) -> Void) {
        storiesCall("storiesFeed", [], done: done)
    }

    func profilePosts(_ userId: String, done: @escaping (Result<ProfilePostsData, ServerError>) -> Void) {
        storiesCall("profilePosts", [userId]) { (result: Result<[String: Any], ServerError>) -> Void in
            switch result {
            case .failure(let error):
                done(.failure(error))
            case .success(let body):
                done(.success(ProfilePostsData(visible: body["visible"] as? Bool ?? false, posts: StoryPost.list(body["posts"]), stories: StoryPost.list(body["stories"]))))
            }
        }
    }

    func deletePost(_ id: String, done: @escaping (ServerError?) -> Void) {
        storiesCall("deletePost", [id]) { (result: Result<[String: Any], ServerError>) -> Void in
            switch result {
            case .success: done(nil)
            case .failure(let error): done(error)
            }
        }
    }

    /// Marks a story watched (the server keeps the first view and ignores the owner's own).
    func viewStory(_ id: String) {
        server.op("viewStory", [id]) { (_: Result<Any, ServerError>) -> Void in }
    }

    /// Who watched a story of this account.
    func storyViewers(_ id: String, done: @escaping (Result<StoryViewersData, ServerError>) -> Void) {
        storiesCall("storyViewers", [id]) { (result: Result<[String: Any], ServerError>) -> Void in
            switch result {
            case .failure(let error):
                done(.failure(error))
            case .success(let body):
                var rows: [(person: Person, viewedAt: String)] = []
                for row in body["viewers"] as? [[String: Any]] ?? [] {
                    if let person = Person(row["user"]) { rows.append((person: person, viewedAt: row["viewedAt"] as? String ?? "")) }
                }
                done(.success(StoryViewersData(count: (body["count"] as? NSNumber)?.intValue ?? rows.count, rows: rows)))
            }
        }
    }

    /// Answers a story: an end-to-end encrypted message to its author with the story's reference inside the
    /// ciphertext. The chat with the author is the one there is, or a new one. `done` gets nil when the message
    /// went out, else the words for the person.
    func replyToStory(authorId: String, storyId: String, text: String, done: @escaping (String?) -> Void) {
        chatWith(authorId) { [weak self] (result: Result<PersonChat, ServerError>) -> Void in
            guard let self else { return }
            switch result {
            case .failure:
                done(StoryRules.word("noChat"))
            case .success(let chat):
                let clientId = UUID().uuidString.lowercased()
                let meta: [String: Any] = ["story": ["id": storyId, "ownerId": authorId]]
                self.crypto.run({ (crypto: CryptoService) -> Result<Void, CryptoFailure> in
                    return self.deliver(crypto, chatId: chat.chatId, peerId: chat.peerId, clientId: clientId, text: text, attachment: NSNull(), meta: meta)
                }, done: { (sent: Result<Void, CryptoFailure>) -> Void in
                    switch sent {
                    case .success:
                        NotificationCenter.default.post(name: Messenger.changed, object: chat.chatId)
                        done(nil)
                    case .failure(let failure):
                        done(failure.message.isEmpty ? StoryRules.word("replyFailed") : failure.message)
                    }
                })
            }
        }
    }
}

/// Which posts from the strip this account has opened on this phone (the reference's seenPosts.ts): the server
/// keeps «watched» for stories only. Kept under the reference's own key, as its own JSON text. Main queue only.
final class SeenPosts {
    private let key: String
    private(set) var ids: [String]

    init(userId: String) {
        key = StoryRules.text("seenKey", "linea.seen-posts.v1:") + userId
        var stored: Any = NSNull()
        if let raw = UserDefaults.standard.string(forKey: key) { stored = raw }
        ids = Core.view("storiesSeenParse", [stored]) as? [String] ?? []
    }

    /// Remembers that these posts were opened. True when the list changed.
    func add(_ added: [String]) -> Bool {
        guard let next = Core.view("storiesSeenAdd", [ids, added]) as? [String], next != ids else { return false }
        ids = next
        if let text = Core.text(next) { UserDefaults.standard.set(text, forKey: key) }
        return true
    }
}

/// One person of the strip, as the core says they are shown.
struct StripEntry {
    let person: Person
    /// The first word of the name.
    let name: String
    let spoken: String
    /// Shown for a recent post, not a story.
    let post: Bool
    /// Not a friend yet: this account's request to them is waiting.
    let pending: Bool
    /// Something new to look at: the ring is lit.
    let fresh: Bool
    /// «запись», «заявка» or nothing.
    let sub: String
}

/// What the viewer plays, and how.
struct StoryViewerGroup {
    /// Whose these are (a person's id); the viewer asks for the neighbours by it.
    let key: String
    let owner: Person?
    let items: [StoryPost]
    let start: Int
    /// Stories play by the clock with bars on top; posts wait for a tap.
    let story: Bool
    /// The account's own: the count of views instead of the answer field.
    let own: Bool
    let canReply: Bool
    /// Past the last one the viewer moves on (to the next person, or closes) instead of staying.
    let runsOn: Bool
}

/// The strip's feed and everything computed from it. One for the app; main queue only.
final class StoriesStore {
    static let shared = StoriesStore()
    /// Posted on the main queue when the strip changed.
    static let changed = Notification.Name("invizent.stories")

    private(set) var show = false
    private(set) var mineHas = false
    private(set) var mineSpoken = ""
    private(set) var people: [StripEntry] = []
    /// The account's own person (for «Моя история»).
    private(set) var me: Person?

    private weak var messenger: Messenger?
    private var seen: SeenPosts?
    private var feed: [String: Any] = ["items": [Any](), "mine": [Any]()]
    private var persons: [String: Person] = [:]
    private var posts: [String: StoryPost] = [:]
    private var running = false
    private var again = false
    private var timer: Timer?
    private var turn = 0
    private let work = DispatchQueue(label: "invizent.stories", qos: .userInitiated)

    private init() {
        NotificationCenter.default.addObserver(self, selector: #selector(liveChanged), name: Live.storyEvent, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(profileChanged), name: Messenger.ownProfileChanged, object: nil)
    }

    var myId: String { messenger?.userId ?? "demo-me" }

    /// The account whose strip this is; another account starts from nothing.
    func start(_ messenger: Messenger?) {
        if self.messenger !== messenger || seen == nil {
            self.messenger = messenger
            seen = messenger.map { (account: Messenger) -> SeenPosts in SeenPosts(userId: account.userId) }
            me = messenger.flatMap { (account: Messenger) -> Person? in Person(account.ownProfile) }
            running = false
            again = false
            take(["items": [Any](), "mine": [Any]()])
        }
        timer?.invalidate()
        timer = nil
        guard let messenger else { return }
        // The pictures of posts are plain files of the server, read as this session (Channels/ChannelsNet.swift).
        ChannelImages.shared.server = messenger.server
        let every = StoryRules.number("refreshMs", 300_000) / 1000
        timer = Timer.scheduledTimer(withTimeInterval: every, repeats: true) { [weak self] (_: Timer) -> Void in self?.refresh() }
        refresh()
    }

    @objc private func liveChanged() { refresh() }

    @objc private func profileChanged() {
        guard let messenger else { return }
        me = Person(messenger.ownProfile)
        NotificationCenter.default.post(name: StoriesStore.changed, object: nil)
    }

    /// Reads the feed again; several calls at once are one request and one more after it.
    func refresh() {
        guard let messenger else { return }
        if running { again = true; return }
        running = true
        messenger.storiesFeed { [weak self, weak messenger] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self, self.messenger === messenger else { return }
            self.running = false
            if case .success(let body) = result { self.take(body) }
            if self.again { self.again = false; self.refresh() }
        }
    }

    /// Takes a feed (`{items, mine}`) and works the strip out of it, off the main queue.
    func take(_ next: [String: Any]) {
        var kept = next
        if !(kept["items"] is [Any]) { kept["items"] = [Any]() }
        if !(kept["mine"] is [Any]) { kept["mine"] = [Any]() }
        feed = kept
        var foundPersons: [String: Person] = [:]
        var foundPosts: [String: StoryPost] = [:]
        for item in kept["items"] as? [[String: Any]] ?? [] {
            if let person = Person(item["user"]) { foundPersons[person.id] = person }
            for post in StoryPost.list(item["stories"]) + StoryPost.list(item["posts"]) { foundPosts[post.id] = post }
        }
        for post in StoryPost.list(kept["mine"]) { foundPosts[post.id] = post }
        persons = foundPersons
        posts = foundPosts
        recompute()
    }

    private func recompute() {
        turn += 1
        let wanted = turn
        let given = feed
        let seenIds = seen?.ids ?? []
        let mine = myId
        let known = persons
        work.async { [weak self] in
            let made = Core.view("storiesStrip", [given, seenIds, mine]) as? [String: Any] ?? [:]
            var entries: [StripEntry] = []
            for row in made["people"] as? [[String: Any]] ?? [] {
                guard let id = row["id"] as? String, let person = known[id] else { continue }
                entries.append(StripEntry(person: person, name: row["name"] as? String ?? person.displayName, spoken: row["spoken"] as? String ?? person.displayName,
                                          post: row["post"] as? Bool ?? false, pending: row["pending"] as? Bool ?? false, fresh: row["fresh"] as? Bool ?? false, sub: row["sub"] as? String ?? ""))
            }
            let own = made["mine"] as? [String: Any] ?? [:]
            let shown = made["show"] as? Bool ?? false
            let has = own["has"] as? Bool ?? false
            let spoken = own["spoken"] as? String ?? ""
            DispatchQueue.main.async {
                guard let self, self.turn == wanted else { return }
                self.show = shown
                self.mineHas = has
                self.mineSpoken = spoken
                self.people = entries
                NotificationCenter.default.post(name: StoriesStore.changed, object: nil)
            }
        }
    }

    private func plan(_ viewing: String, entered: Int) -> [String: Any]? {
        return Core.view("storiesViewer", [feed, seen?.ids ?? [], myId, viewing, entered]) as? [String: Any]
    }

    /// What the viewer plays for a person of the strip (the account's own id: its own stories); nil when there
    /// is nothing to show. `entered`: 1 — moving forward, -1 — coming back from the next person.
    func group(_ viewing: String, entered: Int) -> StoryViewerGroup? {
        guard let made = plan(viewing, entered: entered), made["open"] as? Bool == true else { return nil }
        let ids = made["items"] as? [String] ?? []
        let items = ids.compactMap { (id: String) -> StoryPost? in posts[id] }
        guard !items.isEmpty else { return nil }
        let own = made["own"] as? Bool ?? false
        let postsShown = made["posts"] as? Bool ?? false
        let start = (made["start"] as? NSNumber)?.intValue ?? 0
        return StoryViewerGroup(key: viewing, owner: own ? me : persons[viewing], items: items, start: min(max(0, start), items.count - 1),
                                story: !postsShown, own: own, canReply: !own && !postsShown && messenger != nil, runsOn: true)
    }

    /// Whose stories come after (`step` 1) or before (-1) a person's, as the strip stands now.
    func neighbour(of viewing: String, step: Int) -> StoryViewerGroup? {
        guard let made = plan(viewing, entered: 1), let id = made[step > 0 ? "after" : "before"] as? String else { return nil }
        return group(id, entered: step > 0 ? 1 : -1)
    }

    /// A friend's story came on the screen: told to the server once, and the strip knows at once.
    func watched(userId: String, post: StoryPost) {
        guard post.kind == "story", !post.seen, userId != myId else { return }
        guard let next = Core.view("storiesViewed", [feed, userId, post.id]) as? [String: Any] else { return }
        messenger?.viewStory(post.id)
        take(next)
    }

    /// A post from the strip was opened: from now on it is seen on this phone.
    func opened(post: StoryPost) {
        guard post.kind == "post", let seen else { return }
        if seen.add([post.id]) { recompute() }
    }
}
