import UIKit

#if targetEnvironment(simulator)
/// Sample people and rooms for the simulator check (no account, no server, no media).
enum RoomsDemo {
    static let me = Person(id: "demo-me", username: "nativetester", displayName: "Стейдж", bio: "", birthday: "", avatarColor: 0x4F8FD9, avatarId: "")

    private static let people: [(id: String, name: String, color: String)] = [
        ("demo-r1", "Лариса Орлова", "#E0A23B"), ("demo-r2", "Тимур Ахметов", "#3FA9A0"), ("demo-r3", "Анна Белова", "#5B8DEF"),
        ("demo-r4", "Глеб Соколов", "#58B368"), ("demo-r5", "Мира Левина", "#E07A5F"), ("demo-r6", "Ян Котов", "#7C8A99"), ("demo-r7", "Зоя Никитина", "#C9A227"),
    ]

    private static func member(_ index: Int) -> [String: Any] {
        let person = people[index]
        return ["id": person.id, "username": "user\(index + 1)", "displayName": person.name, "avatarColor": person.color, "avatarId": NSNull()]
    }

    private static let mine: [String: Any] = ["id": me.id, "username": me.username, "displayName": me.displayName, "avatarColor": "#4F8FD9", "avatarId": NSNull()]

    private static func inside(_ userId: String, _ muted: Bool) -> [String: Any] { ["userId": userId, "muted": muted] }

    private static func stamp(_ ago: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(-ago))
    }

    /// Five rooms: two with people inside, one that has just emptied, one asleep since yesterday, one never used.
    static func rooms() -> [[String: Any]] {
        let yesterday = Calendar.current.date(bySettingHour: 18, minute: 20, second: 0, of: Date().addingTimeInterval(-86_400)) ?? Date().addingTimeInterval(-86_400)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return [
            ["id": "demo-room-1", "name": "Походники", "auto": false, "members": [mine, member(0), member(1), member(2), member(3), member(4)],
             "inside": [inside("demo-r1", false), inside("demo-r2", true), inside("demo-r3", false)], "awake": true, "lastActiveAt": stamp(40), "createdAt": stamp(30 * 86_400)],
            ["id": "demo-room-2", "name": "Лариса, Тимур", "auto": true, "members": [mine, member(0), member(1)],
             "inside": [inside("demo-r1", false)], "awake": true, "lastActiveAt": stamp(600), "createdAt": stamp(12 * 86_400)],
            ["id": "demo-room-3", "name": "Семья", "auto": false, "members": [mine, member(5), member(6)],
             "inside": [[String: Any]](), "awake": true, "lastActiveAt": stamp(120), "createdAt": stamp(60 * 86_400)],
            ["id": "demo-room-4", "name": "Глеб, Мира и ещё 2", "auto": true, "members": [mine, member(3), member(4), member(5), member(6)],
             "inside": [[String: Any]](), "awake": false, "lastActiveAt": formatter.string(from: yesterday), "createdAt": stamp(20 * 86_400)],
            ["id": "demo-room-5", "name": "Работа", "auto": false, "members": [mine, member(2), member(5)],
             "inside": [[String: Any]](), "awake": false, "lastActiveAt": NSNull(), "createdAt": stamp(3 * 86_400)],
        ]
    }

    static func ring() -> [String: Any] {
        ["roomId": "demo-room-2", "name": "Лариса, Тимур", "from": member(0), "at": RoomRules.nowMs]
    }

    /// This phone «inside» the first room: three others around it, one of them talking, one with the microphone off.
    static func walkIn() {
        let peers = [RoomVoicePeer(peer: "peer-1", userId: "demo-r1", muted: false, connected: true),
                     RoomVoicePeer(peer: "peer-2", userId: "demo-r2", muted: true, connected: true),
                     RoomVoicePeer(peer: "peer-3", userId: "demo-r3", muted: false, connected: true)]
        RoomVoice.shared.showDemo(roomId: "demo-room-1", name: "Походники", peers: peers, muted: false, speaking: ["demo-r1"])
    }

    static func pickerChoices() -> [RoomPickerController.Choice] {
        var out: [RoomPickerController.Choice] = []
        for index in people.indices {
            if let person = Person(member(index)) { out.append(RoomPickerController.Choice(chatId: "demo-chat-\(index)", person: person)) }
        }
        return out
    }
}

/// What the simulator check asks of rooms by launch arguments (see SceneDelegate.simulatorStart):
///   -roomsdemo list      no account, no server: «Каналы» with «КОМНАТЫ» on top — two lit cards (people inside,
///                        «трое внутри», «Зайти»), a room that has just emptied («никого · ещё не спит»), one asleep
///                        («спит · были вчера в 18:20») and one never used; the green dot of «Каналы» in the bar's list
///   -roomsdemo empty     the same section without rooms: the dashed card that says how a room is made
///   -roomsdemo room      this phone inside «Походники»: the glass bar («комната · четверо внутри»), this account in
///                        the middle, three people around it with their lights (one with the green ring of talking,
///                        one with the crossed microphone), two members dim (not inside), «Позвать всех», the
///                        loudspeaker, the microphone and the red way out
///   -roomsdemo video     the same as `room`: a room of the reference carries voice only — there is no camera in it
///   -roomsdemo outside   the screen of a room this phone is not inside: one person lit, «Позвать всех» and «Зайти»
///   -roomsdemo ring      «зовёт в комнату · один внутри» over the chats, with «Не сейчас» and «Зайти» (silent here)
///   -roomsdemo bar       inside the room, its screen closed: the glass strip «Голосовая связь» under the status bar
///                        over the chats, with the microphone and the red button
///   -roomsdemo music     as `room`, with «включил Лариса · играет у всех» above «Позвать всех»
///   -roomsdemo menu | rename   the room's actions («Переименовать», «Уйти из комнаты насовсем»), the form of its name
///   -roomsdemo gone      «Этой комнаты больше нет.» with «Назад»
///   -roomsdemo picker    «Выбрать»: the people of the chats, three marked, «Звонок · 3»
///   -rooms list          with an account: «Каналы», the rooms on top
///   -rooms room          with an account: opens the first room of the list (not inside: «Зайти»)
///   -rooms enter         with an account: the same, and presses «Зайти» (the microphone has to be allowed beforehand)
///   -rooms picker        with an account: «Выбрать» over the chats with the first two people marked
extension SceneDelegate {
    /// True when `-roomsdemo` decided the start.
    func simulatorRooms() -> Bool {
        let args = UserDefaults.standard
        guard let demo = args.string(forKey: "roomsdemo") else {
            if let wanted = args.string(forKey: "rooms") { simulatorRoomsOpen(wanted, tries: 60) }
            return false
        }
        let root = RootViewController()
        let stack = NavigationController(rootViewController: root)
        window?.rootViewController = stack
        root.loadViewIfNeeded()
        Rooms.shared.showDemo(me: RoomsDemo.me, rooms: demo == "empty" ? [] : RoomsDemo.rooms(), ring: demo == "ring" ? RoomsDemo.ring() : nil)
        switch demo {
        case "ring":
            break
        case "bar":
            RoomsDemo.walkIn()
        case "picker":
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                let picker = RoomPickerController(messenger: nil, first: "")
                stack.present(picker, animated: false) { picker.simulatorChoose(3) }
            }
        case "room", "video", "music", "menu", "rename":
            root.show("channels")
            RoomsDemo.walkIn()
            let screen = RoomViewController(roomId: "demo-room-1")
            stack.pushViewController(screen, animated: false)
            if demo == "music" {
                RoomMusic.shared.showDemo(host: "peer-1", track: ["id": "audius:demo", "source": "audius", "title": "Night Drive", "artist": "Северный ветер", "duration": 214])
            }
            if demo == "menu" || demo == "rename" { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { screen.simulatorShow(demo) } }
        case "outside":
            root.show("channels")
            stack.pushViewController(RoomViewController(roomId: "demo-room-2"), animated: false)
        case "gone":
            root.show("channels")
            stack.pushViewController(RoomViewController(roomId: "demo-room-none"), animated: false)
        default:
            root.show("channels")
        }
        RoomOverlay.shared.refresh()
        return true
    }

    /// With an account: waits for the shell (the sign-in of the same launch may still be going) and for the list
    /// of rooms, then opens what was asked.
    private func simulatorRoomsOpen(_ wanted: String, tries: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, tries > 0 else { return }
            guard let stack = self.window?.rootViewController as? NavigationController, let root = stack.viewControllers.first as? RootViewController else {
                return self.simulatorRoomsOpen(wanted, tries: tries - 1)
            }
            root.loadViewIfNeeded()
            if wanted == "picker" {
                guard let messenger = Rooms.shared.account, stack.presentedViewController == nil else { return }
                let picker = RoomPickerController(messenger: messenger, first: "")
                stack.present(picker, animated: false) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { picker.simulatorChoose(2) }
                }
                return
            }
            root.show("channels")
            guard wanted == "room" || wanted == "enter" else { return }
            guard let first = Rooms.shared.rooms?.first else { return self.simulatorRoomsOpen(wanted, tries: tries - 1) }
            RoomRouter.open(first.id)
            if wanted == "enter" { Rooms.shared.enter(first) { (_: String?) -> Void in } }
        }
    }
}
#endif
