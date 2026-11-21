#if targetEnvironment(simulator)
import UIKit

/// Made-up people for looking at «Люди» and a profile in the simulator while there is no account behind it.
/// Compiled for the simulator only: a build for a phone does not contain this file's contents.
enum PeopleDemo {
    private static func person(_ index: Int, _ name: String, _ username: String, _ color: UInt32, _ bio: String = "", _ birthday: String = "") -> Person {
        var made = Person(id: "demo-person-\(index)", username: username, displayName: name, bio: bio, birthday: birthday, avatarColor: color, avatarId: "")
        // Avatars: two of them show what follows a name in the lists — an emoji status and the Platina gem.
        if index == 1 { made.look = PersonLook(["statusEmoji": "🔥", "statusEmojiPermanent": true, "statusEmojiExpiresAt": NSNull()] as [String: Any]) }
        if index == 3 { made.look = PersonLook(["seal": "platina"] as [String: Any]) }
        return made
    }

    static let friends: [Person] = [
        person(0, "Алиса Воронцова", "alisa_v", 0x5E7BFF, "Рисую карты и собираю гербарий. Пишите в любое время.", "03-02"),
        person(1, "Дмитрий Орлов", "orlov", 0xF2A33C),
        person(2, "Лев", "lev_m", 0x4FB86A),
        person(3, "Марина Ким", "marina.kim", 0xF26B5E),
        person(4, "Саша", "sasha", 0x3CA7F2),
    ]
    static let incoming: [Person] = [person(5, "Вера Соколова", "vera_s", 0x9B6BF2)]
    static let outgoing: [Person] = [person(6, "Игорь Белов", "belov", 0x34C3A0)]
    static var everyone: [Person] { friends + incoming + outgoing }

    static func find(_ query: String) -> [Person] {
        let wanted = query.lowercased().replacingOccurrences(of: "@", with: "")
        return everyone.filter { $0.displayName.lowercased().contains(wanted) || $0.username.lowercased().contains(wanted) }
    }

    static func named(_ name: String) -> Person {
        everyone.first { $0.displayName == name } ?? person(9, name, "demo", 0x5E7BFF)
    }
}

/// What the simulator check asks of «Люди» by launch arguments (see SceneDelegate.simulatorStart):
///   -tab people              the section (with an account: friends, requests; with -demo 1: samples)
///   -peoplesearch <query>    the section with the search field filled in and its results
///   -profile friend          the profile of the first friend (no friends: of the first request, else of the
///                            person of the first chat) — opened from «Люди», with «Написать»
///   -profile chat            the first chat, then the profile opened by a tap on its header
enum PeopleSimulator {
    static func run(stack: NavigationController, root: RootViewController) {
        let args = UserDefaults.standard
        let query = args.string(forKey: "peoplesearch")
        let profile = args.string(forKey: "profile")
        root.loadViewIfNeeded()
        if let tab = args.string(forKey: "tab") { root.show(tab) }
        if query != nil || profile == "friend" { root.show("people") }
        if let query, let page = root.peoplePage() { page.simulatorSearch(query) }
        if profile == "friend" { root.peoplePage()?.simulatorOpenFirstProfile() }
        if profile == "chat" {
            if args.bool(forKey: "demo") {
                // Without an account there is no list to open the first chat of: the sample chat.
                if !(stack.topViewController is ChatViewController) { stack.pushViewController(ChatViewController(name: "Алиса Воронцова"), animated: false) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    (stack.topViewController as? ChatViewController)?.openProfile()
                }
            } else {
                // With an account the list of chats comes from the server: the first chat is opened once it is there.
                openFirstChat(stack: stack, root: root, tries: 20) { (chat: ChatViewController) -> Void in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { chat.openProfile() }
                }
            }
        }
    }

    /// Opens the first chat of the list as soon as the list has one (asked once a second, `tries` times), then
    /// hands the chat's screen over.
    static func openFirstChat(stack: NavigationController, root: RootViewController, tries: Int, then: @escaping (ChatViewController) -> Void) {
        if let chat = stack.topViewController as? ChatViewController { return then(chat) }
        root.loadViewIfNeeded()
        root.show("chats")
        root.openFirstChat()
        if let chat = stack.topViewController as? ChatViewController { return then(chat) }
        guard tries > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            openFirstChat(stack: stack, root: root, tries: tries - 1, then: then)
        }
    }
}
#endif
