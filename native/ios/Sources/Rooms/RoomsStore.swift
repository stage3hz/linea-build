import UIKit

/// The rooms of the signed-in account: the list (read once, then kept current by the live line's events) and the
/// «зовёт в комнату» call that is ringing right now. The reference's rooms.ts and the `RoomsHost` of
/// RoomsSection.tsx. What an event does to the list is the shared core's (`roomEvent`); the voice is RoomVoice.
/// Main queue only.
final class Rooms {
    static let shared = Rooms()
    /// Posted on the main queue when the list, a room in it or the ring changed.
    static let changed = Notification.Name("invizent.rooms")

    /// nil until the list has been read once.
    private(set) var rooms: [Room]?
    private(set) var ring: RoomRing?
    /// Why the list could not be read; empty when it could.
    private(set) var failure = ""

    /// The list and the ring as the server words them: what the core's rules read and write.
    private var rawRooms: [[String: Any]]?
    private var rawRing: [String: Any]?
    private weak var messenger: Messenger?
    private var observing = false
    private var ringTimer: Timer?
    private var ringSounds = false
    private var ringAt = 0.0
    #if targetEnvironment(simulator)
    private var demoMe: Person?
    #endif

    private init() {}

    // MARK: The account

    /// Begins to follow the account (a new sign-in forgets what the previous account had). nil: the simulator's
    /// shell without an account.
    func start(_ messenger: Messenger?) {
        if !observing {
            observing = true
            NotificationCenter.default.addObserver(self, selector: #selector(event(_:)), name: Live.roomEvent, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(voiceMoved), name: RoomVoice.changed, object: nil)
        }
        if let messenger, let current = self.messenger, current === messenger { return }
        #if targetEnvironment(simulator)
        // The samples stay when the shell is built again (a theme put on) without an account.
        if messenger == nil, demoMe != nil { return }
        demoMe = nil
        #endif
        if self.messenger != nil { RoomVoice.shared.stop() }
        self.messenger = messenger
        show(rooms: nil, ring: nil)
        failure = ""
        if messenger != nil { load() }
    }

    /// The account was left: nothing of it may be shown to the next one, and the room it was in is left.
    func stop() {
        RoomVoice.shared.stop()
        messenger = nil
        failure = ""
        show(rooms: nil, ring: nil)
    }

    var account: Messenger? { messenger }

    /// This account's id.
    var userId: String {
        #if targetEnvironment(simulator)
        if let demoMe { return demoMe.id }
        #endif
        return messenger?.userId ?? ""
    }

    /// This account as a person (its own picture in the middle of a room).
    var me: Person? {
        #if targetEnvironment(simulator)
        if let demoMe { return demoMe }
        #endif
        return Person(messenger?.user)
    }

    /// Where a person's picture is asked for (empty: they have none).
    func pictureAddress(_ person: Person) -> String { messenger?.personAvatarAddress(person.avatarId) ?? "" }

    /// True while somebody is inside any of the rooms (the quiet dot on «Каналы»).
    var awake: Bool {
        guard let rooms else { return false }
        return rooms.contains { (room: Room) -> Bool in !room.inside.isEmpty }
    }

    func room(_ id: String) -> Room? {
        rooms?.first(where: { (room: Room) -> Bool in room.id == id })
    }

    // MARK: The list

    func load() {
        guard let messenger else { return }
        messenger.server.op("rooms", []) { [weak self, weak messenger] result in
            DispatchQueue.main.async {
                guard let self, let messenger, self.messenger === messenger else { return }
                switch result {
                case .success(let body):
                    let list = (body as? [String: Any])?["rooms"] as? [[String: Any]] ?? []
                    self.failure = ""
                    self.show(rooms: Core.view("roomSort", [list]) as? [[String: Any]] ?? list, ring: self.rawRing)
                case .failure(let error):
                    self.failure = error.words.isEmpty ? "Не удалось загрузить комнаты." : error.words
                    NotificationCenter.default.post(name: Rooms.changed, object: nil)
                }
            }
        }
    }

    @objc private func event(_ note: Notification) {
        guard messenger != nil, let data = note.userInfo?["event"] as? [String: Any], let type = data["type"] as? String else { return }
        // The line is up again: whatever happened meanwhile is read afresh.
        if type == "ready" { return load() }
        guard type.hasPrefix("room.") else { return }
        apply(data)
    }

    /// One event about rooms, by the core's rules.
    private func apply(_ data: [String: Any]) {
        var held: [String: Any] = ["openId": NSNull()]
        if let rawRooms { held["rooms"] = rawRooms } else { held["rooms"] = NSNull() }
        if let rawRing { held["ring"] = rawRing } else { held["ring"] = NSNull() }
        guard let next = Core.view("roomEvent", [held, data, userId, RoomRules.nowMs]) as? [String: Any] else { return }
        show(rooms: next["rooms"] as? [[String: Any]], ring: next["ring"] as? [String: Any])
    }

    private func show(rooms: [[String: Any]]?, ring: [String: Any]?) {
        rawRooms = rooms
        rawRing = ring
        self.rooms = rooms.map { (list: [[String: Any]]) -> [Room] in list.compactMap { Room($0) } }
        let rang = RoomRing(ring)
        self.ring = rang
        ringMoved(rang)
        NotificationCenter.default.post(name: Rooms.changed, object: nil)
    }

    /// Drops a room from the list at once (this account left it); the server's own event confirms it later.
    func forget(_ id: String) {
        guard let rawRooms else { return }
        let kept = rawRooms.filter { (room: [String: Any]) -> Bool in room["id"] as? String != id }
        show(rooms: kept, ring: rawRing?["roomId"] as? String == id ? nil : rawRing)
    }

    /// The room this phone is inside changed: the rows of the list say «ты внутри».
    @objc private func voiceMoved() {
        // Walking in answers the ring.
        if let ring, RoomVoice.shared.state?.roomId == ring.roomId { return dismissRing() }
        NotificationCenter.default.post(name: Rooms.changed, object: nil)
    }

    // MARK: The ring

    /// A ring began, or ended: the melody and the half-minute it lasts. An ordinary call that is ringing or going
    /// on, and a room this phone is inside, keep the phone's sound: the room's call is then shown silently.
    private func ringMoved(_ ring: RoomRing?) {
        let at = ring?.at ?? 0
        if at == ringAt { return }
        ringAt = at
        ringTimer?.invalidate()
        ringTimer = nil
        if ringSounds {
            ringSounds = false
            if Calls.shared.call == nil {
                CallSounds.stop()
                CallSounds.restore()
            }
        }
        guard ring != nil else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        var quiet = Calls.shared.call != nil || RoomVoice.shared.state != nil
        #if targetEnvironment(simulator)
        if demoMe != nil { quiet = true }
        #endif
        if !quiet {
            ringSounds = true
            CallSounds.play("incoming")
        }
        ringTimer = Timer.scheduledTimer(withTimeInterval: RoomRules.ringTime, repeats: false) { [weak self] (_: Timer) -> Void in self?.dismissRing() }
    }

    /// «Не сейчас», or the ring's time ran out.
    func dismissRing() {
        guard rawRing != nil else { return }
        show(rooms: rawRooms, ring: nil)
    }

    /// «Зайти» on the ring: the room opens and this phone walks in.
    func answerRing() {
        guard let ring else { return }
        let known = room(ring.roomId)
        dismissRing()
        RoomRouter.open(ring.roomId)
        // A failure is shown by the room's own screen, next to «Зайти».
        if let known { enter(known) { (_: String?) -> Void in } }
    }

    // MARK: What the person does

    /// Walks into the room: the microphone opens and the others hear this phone.
    func enter(_ room: Room, done: @escaping (String?) -> Void) {
        #if targetEnvironment(simulator)
        if demoMe != nil { return done(nil) }
        #endif
        guard let messenger else { return done("Нет соединения с сервером.") }
        if ring?.roomId == room.id { dismissRing() }
        RoomVoice.shared.join(messenger, roomId: room.id, name: room.name, done: done)
    }

    func exit() { RoomVoice.shared.leave() }

    /// «Позвать всех»: everyone who is not inside gets the ring. `done`: how many were called, or the words that
    /// say why not.
    func ringAll(_ id: String, done: @escaping (Int, String?) -> Void) {
        guard let messenger else { return done(0, nil) }
        messenger.server.op("ringRoom", [id]) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let body): done(((body as? [String: Any])?["rang"] as? NSNumber)?.intValue ?? 0, nil)
                case .failure(let error): done(0, error.words.isEmpty ? "Не удалось позвать." : error.words)
                }
            }
        }
    }

    /// A new name; an empty one brings back the name made of the members' names.
    func rename(_ id: String, name: String, done: @escaping (String?) -> Void) {
        guard let messenger else { return done(nil) }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        messenger.server.op("renameRoom", [id, trimmed]) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success(let body):
                    // The server tells every member (`room.updated`); this phone need not wait for it.
                    if let room = (body as? [String: Any])?["room"] as? [String: Any] { self?.apply(["type": "room.updated", "room": room]) }
                    done(nil)
                case .failure(let error): done(error.words.isEmpty ? "Не удалось переименовать." : error.words)
                }
            }
        }
    }

    /// «Уйти из комнаты насовсем»: out of its voice, then out of its members.
    func leaveForGood(_ id: String, done: @escaping (String?) -> Void) {
        guard let messenger else { return done(nil) }
        if RoomVoice.shared.state?.roomId == id { exit() }
        messenger.server.op("leaveRoom", [id]) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success:
                    self?.forget(id)
                    done(nil)
                case .failure(let error): done(error.words.isEmpty ? "Не удалось выйти." : error.words)
                }
            }
        }
    }

    /// A group call from the chat list: the room of exactly these people is found or made, opened on screen,
    /// entered, and everyone else is called. One person is an ordinary call and never reaches this.
    /// `done` gets nil, or the words that say why not.
    func startCall(memberIds: [String], done: @escaping (String?) -> Void) {
        guard let messenger else { return done("Нет соединения с сервером.") }
        let check = Core.view("roomCallCheck", [memberIds, userId]) as? [String: Any] ?? [:]
        if let words = check["error"] as? String { return done(words) }
        guard let ids = check["ids"] as? [String] else { return done("Не удалось позвонить.") }
        messenger.server.op("createRoom", [ids]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .failure(let error): done(error.words.isEmpty ? "Не удалось позвонить." : error.words)
                case .success(let body):
                    guard let raw = (body as? [String: Any])?["room"] as? [String: Any], let room = Room(raw) else { return done("Не удалось позвонить.") }
                    self.apply(["type": "room.updated", "room": raw])
                    RoomRouter.open(room.id)
                    self.enter(room) { [weak self] (words: String?) -> Void in
                        if let words { return done(words) }
                        // Not called: the others still see the room awake and can walk in.
                        self?.ringAll(room.id) { (_: Int, _: String?) -> Void in }
                        done(nil)
                    }
                }
            }
        }
    }

    // MARK: The simulator's samples

    #if targetEnvironment(simulator)
    /// The list and the ring without an account or a server (-roomsdemo).
    func showDemo(me: Person, rooms: [[String: Any]], ring: [String: Any]?) {
        demoMe = me
        failure = ""
        show(rooms: rooms, ring: ring)
    }

    var isDemo: Bool { demoMe != nil }
    #endif
}

/// Opens a room's screen from anywhere in the app: «Каналы» is where rooms live, so that section comes forward
/// and the room is pushed over it (a swipe from the left edge goes back to the list).
enum RoomRouter {
    static func open(_ roomId: String) {
        guard let stack = navigation(), let root = stack.viewControllers.first as? RootViewController else { return }
        if let shown = stack.topViewController as? RoomViewController, shown.roomId == roomId { return }
        stack.presentedViewController?.dismiss(animated: false)
        root.loadViewIfNeeded()
        root.show("channels")
        stack.setViewControllers([root, RoomViewController(roomId: roomId)], animated: stack.viewControllers.count == 1)
    }

    /// Channels: the community whose voice channel this phone is in, over the «Каналы» section.
    static func openCommunity(_ communityId: String) {
        guard let stack = navigation(), let root = stack.viewControllers.first as? RootViewController, let messenger = RoomVoice.shared.messenger else { return }
        if let shown = stack.topViewController as? CommunityViewController, shown.shownCommunityId == communityId { return }
        stack.presentedViewController?.dismiss(animated: false)
        root.loadViewIfNeeded()
        root.show("channels")
        stack.setViewControllers([root, CommunityViewController(messenger: messenger, communityId: communityId, known: nil)], animated: stack.viewControllers.count == 1)
    }

    static func navigation() -> NavigationController? {
        for scene in UIApplication.shared.connectedScenes {
            guard let scene = scene as? UIWindowScene else { continue }
            for window in scene.windows {
                if let stack = window.rootViewController as? NavigationController { return stack }
            }
        }
        return nil
    }
}
