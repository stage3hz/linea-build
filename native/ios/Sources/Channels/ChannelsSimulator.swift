#if targetEnvironment(simulator)
import UIKit

/// Made-up communities for looking at «Каналы» in the simulator while there is no account behind it.
/// Compiled for the simulator only: a build for a phone does not contain this file's contents.
enum ChannelsDemo {
    private static let people: [(id: String, name: String, username: String, color: UInt32)] = [
        ("demo-u0", "Алиса Воронцова", "alisa_v", 0x5E7BFF),
        ("demo-u1", "Дмитрий Орлов", "orlov", 0xF2A33C),
        ("demo-u2", "Лев", "lev_m", 0x4FB86A),
        ("demo-u3", "Марина Ким", "marina.kim", 0xF26B5E),
        ("demo-u4", "Саша", "sasha", 0x3CA7F2),
    ]
    private static let me = "demo-me"

    static func summaries() -> [CommunitySummary] {
        return [
            CommunitySummary(id: "demo-server", kind: "server", category: "", closed: false, name: "Клан «Север»", about: "Собираемся по вечерам. Новичкам — в #общий.", avatarId: "", ownerId: "demo-u0",
                             memberCount: 128, isMember: true, perms: Perm.invite | Perm.send | Perm.voice, lastText: "Лев: го в восемь, я создам лобби", muted: false, unread: 14, mentions: 1),
            CommunitySummary(id: "demo-server-2", kind: "server", category: "", closed: true, name: "Ночная смена", about: "", avatarId: "", ownerId: "demo-u1",
                             memberCount: 7, isMember: true, perms: Perm.send | Perm.voice, lastText: "", muted: true, unread: 0, mentions: 0),
            CommunitySummary(id: "demo-blog", kind: "blog", category: "blog", closed: false, name: "Заметки Стейджа", about: "Короткие заметки о сборке и дизайне.", avatarId: "", ownerId: "demo-u3",
                             memberCount: 12480, isMember: true, perms: Perm.invite, lastText: "Собрали новую версию: что внутри", muted: false, unread: 2, mentions: 0),
            CommunitySummary(id: "demo-blog-2", kind: "blog", category: "music", closed: false, name: "Винил по пятницам", about: "", avatarId: "", ownerId: "demo-u4",
                             memberCount: 342, isMember: true, perms: Perm.invite, lastText: "", muted: true, unread: 31, mentions: 0),
        ]
    }

    static func community(_ id: String) -> Community? {
        guard let summary = summaries().first(where: { $0.id == id }) else { return nil }
        let everyone = CommunityRole(id: "demo-role-all", name: summary.blog ? "Подписчики" : "Участники", colorHex: "#8A9BB8", position: 0, perms: Perm.invite | Perm.send | Perm.voice, isDefault: true)
        let moderator = CommunityRole(id: "demo-role-mod", name: "Модератор", colorHex: "#3FA9F5", position: 10, perms: Perm.manageMessages | Perm.kick | Perm.ban, isDefault: false)
        let veteran = CommunityRole(id: "demo-role-vet", name: "Ветераны", colorHex: "#F5C542", position: 5, perms: Perm.send | Perm.voice, isDefault: false)
        if summary.blog {
            let posts = CommunityChannel(id: id + "-posts", kind: "text", name: "Публикации", topic: "", category: "", position: 0, roleIds: [], voiceCount: 0, unread: summary.unread, mentions: 0)
            return Community(summary: summary, roles: [everyone], myRoleIds: [], channels: [posts])
        }
        let channels = [
            CommunityChannel(id: id + "-general", kind: "text", name: "общий", topic: "Обо всём", category: "Текстовые каналы", position: 0, roleIds: [], voiceCount: 0, unread: 12, mentions: 1),
            CommunityChannel(id: id + "-news", kind: "text", name: "новости", topic: "", category: "Текстовые каналы", position: 1, roleIds: [], voiceCount: 0, unread: 2, mentions: 0),
            CommunityChannel(id: id + "-staff", kind: "text", name: "штаб", topic: "", category: "Текстовые каналы", position: 2, roleIds: ["demo-role-mod"], voiceCount: 0, unread: 0, mentions: 0),
            CommunityChannel(id: id + "-voice", kind: "voice", name: "Общий", topic: "", category: "Голосовые каналы", position: 0, roleIds: [], voiceCount: 2, unread: 0, mentions: 0),
            CommunityChannel(id: id + "-game", kind: "voice", name: "Игра", topic: "", category: "Голосовые каналы", position: 1, roleIds: [], voiceCount: 0, unread: 0, mentions: 0),
        ]
        return Community(summary: summary, roles: [moderator, veteran, everyone], myRoleIds: [], channels: channels)
    }

    static func members() -> [CommunityMember] {
        var found: [CommunityMember] = []
        for (index, person) in people.enumerated() {
            let user = Person(id: person.id, username: person.username, displayName: person.name, bio: "", birthday: "", avatarColor: person.color, avatarId: "")
            let roles: [String] = index == 1 ? ["demo-role-mod"] : (index == 2 ? ["demo-role-vet"] : [])
            found.append(CommunityMember(user: user, roleIds: roles, owner: index == 0))
        }
        return found
    }

    /// A drawn picture (no photo of anyone).
    private static func picture() -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let size = CGSize(width: 960, height: 720)
        return UIGraphicsImageRenderer(size: size, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
            let colors = [UIColor(hex: 0x16316A).cgColor, UIColor(hex: 0x2EE6C8).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: nil) {
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
            UIColor(white: 1, alpha: 0.85).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 600, y: 110, width: 210, height: 210))
        }
    }

    /// About two hundred messages of mixed lengths: runs by one author, answers, reactions, a picture, a file,
    /// an edited one, an invitation, a mention of the reader.
    static func fill(_ engine: ChannelEngine, blog: Bool) {
        ChannelImages.shared.putSample(picture(), id: "demo-picture")
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var authors: [String: ChannelAuthor] = [:]
        for person in people { authors[person.id] = ChannelAuthor(name: person.name, username: person.username, avatarId: "", avatarColor: person.color) }
        authors[me] = ChannelAuthor(name: "Ты", username: "nativetester", avatarId: "", avatarColor: 0x8A8F98)
        let short = ["Привет!", "Ок", "😂😂😂", "Го вечером?", "Я за", "Кто создаёт лобби?", "Сейчас буду", "Минуту", "Ну ты даёшь", "+", "Давай в восемь"]
        let long = [
            "Скинул расписание на неделю: во вторник и четверг тренируемся с восьми, в субботу турнир — начало в полдень, собираемся за полчаса, чтобы проверить связь и состав.",
            "По вчерашней игре: первую половину держались отлично, потом рассыпались на ротациях. Предлагаю в следующий раз заранее договориться, кто закрывает центр, и не менять это на ходу — иначе опять будем бегать втроём в одну точку.",
            "Список на закупку:\n— гарнитура для Саши\n— коврик\n— переходник",
            "Подробности тут: https://example.com/turnir и ещё на www.example.org, пиши @alisa_v, если что-то не открывается.",
        ]
        var messages: [CommunityMessage] = []
        var moment = Date().addingTimeInterval(-3 * 24 * 3600)
        var id = 1000
        let total = blog ? 14 : 200
        for index in 0..<total {
            id += 1
            // Runs of several messages by one author, then the next author; a new day now and then.
            let author = blog ? people[3].id : (index % 23 == 9 ? me : people[(index / 4) % people.count].id)
            moment = moment.addingTimeInterval(index % 4 == 0 ? Double(600 + (index % 7) * 900) : 40)
            var text = index % 9 == 4 ? long[(index / 9) % long.count] : short[index % short.count]
            if blog { text = long[index % long.count] }
            var attachment: CommunityMessage.Attachment? = nil
            var reactions: [CommunityMessage.Reaction] = []
            var answers = 0
            if index == total - 12 {
                attachment = CommunityMessage.Attachment(id: "demo-picture", name: "photo.png", mimeType: "image/png", size: 482_113)
                text = blog ? "Собрали новую версию: что внутри" : "Вид из окна штаба"
            }
            if index == total - 30 && !blog { attachment = CommunityMessage.Attachment(id: "demo-file", name: "Регламент турнира.pdf", mimeType: "application/pdf", size: 1_843_200) }
            if index % 11 == 3 { reactions = [CommunityMessage.Reaction(emoji: "👍", count: 4, userIds: [me]), CommunityMessage.Reaction(emoji: "🔥", count: 2, userIds: [])] }
            if index % 17 == 6 { reactions.append(CommunityMessage.Reaction(emoji: "😂", count: 12, userIds: [])) }
            if !blog && index % 13 == 7 && index > 3 { answers = id - 3 }
            if !blog && index == total - 6 { text = "@nativetester глянь регламент, пожалуйста" }
            if !blog && index == total - 9 { text = "Заходите к соседям: https://api.invizent.com/i/Ab3dEf9h" }
            messages.append(CommunityMessage(id: id, channelId: "", senderId: author, text: text, attachment: attachment, replyTo: answers,
                                             createdAt: stamp.string(from: moment), edited: index % 29 == 5, reactions: reactions))
        }
        let blogSummary = summaries()[2]
        let card = ChannelInviteCard(state: 2, code: "Ab3dEf9h", communityId: blogSummary.id, blog: true, closed: false, name: blogSummary.name, avatarId: "",
                                     details: "Блог · " + blogSummary.countWords, member: false)
        engine.demo(messages: messages, authors: authors, roleColors: ["demo-u1": 0x3FA9F5, "demo-u2": 0xF5C542], invites: ["Ab3dEf9h": card], meId: me, meUsername: "nativetester")
    }
}

/// What the simulator check asks of «Каналы» by launch arguments (see SceneDelegate.simulatorStart):
///   -channelsdemo 1           no account, no server: the section's root with sample communities
///   -channelsdemo community   a sample game server: its channels in groups, counters, a locked channel
///   -channelsdemo blog        a sample blog channel: its posts as cards
///   -channelsdemo chat        a sample channel's chat: about 200 messages of mixed lengths
///   -channelsdemo menu        the same chat with the menu of its newest message (reactions and actions)
///   -channelsdemo settings    the settings of the sample server (as a member without special rights)
///   -tab channels             with an account (or -demo 1): the section's root
///   -channels community       with an account: opens the first community of the list
///   -channels chat            with an account: the first community, then its first text channel
///   -channels create | join   with an account: «Что создаём?» / «Вступить по ссылке»
extension SceneDelegate {
    /// True when `-channelsdemo` decided the start.
    func simulatorChannels() -> Bool {
        let args = UserDefaults.standard
        if let demo = args.string(forKey: "channelsdemo") {
            let root = RootViewController()
            let stack = NavigationController(rootViewController: root)
            window?.rootViewController = stack
            root.loadViewIfNeeded()
            root.show("channels")
            if demo == "community" || demo == "blog" {
                let id = demo == "blog" ? "demo-blog" : "demo-server"
                stack.pushViewController(CommunityViewController(messenger: nil, communityId: id, known: ChannelsDemo.summaries().first { $0.id == id }), animated: false)
            } else if demo == "chat" || demo == "menu", let community = ChannelsDemo.community("demo-server"), let channel = community.channels.first {
                let chat = ChannelChatViewController(messenger: nil, community: community, channel: channel, root: false)
                stack.pushViewController(chat, animated: false)
                if demo == "menu" { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { chat.simulatorMenu() } }
            } else if demo == "settings", let community = ChannelsDemo.community("demo-server") {
                stack.pushViewController(CommunitySettingsPage(messenger: nil, community: community), animated: false)
            }
            return true
        }
        if let wanted = args.string(forKey: "channels") { simulatorChannelsOpen(wanted, tries: 60) }
        return false
    }

    /// With an account: waits for the shell (the sign-in of the same launch may still be going), then opens.
    private func simulatorChannelsOpen(_ wanted: String, tries: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, tries > 0 else { return }
            guard let stack = self.window?.rootViewController as? NavigationController, let root = stack.viewControllers.first as? RootViewController else {
                return self.simulatorChannelsOpen(wanted, tries: tries - 1)
            }
            root.loadViewIfNeeded()
            root.show("channels")
            guard let page = root.channelsPage() else { return }
            if wanted == "create" || wanted == "join" { return page.simulatorForm(wanted) }
            guard wanted == "community" || wanted == "chat" else { return }
            // The list is read from the server: tried until it is there.
            if let screen = stack.topViewController as? CommunityViewController {
                if wanted == "chat" && !screen.openFirstChannel() { self.simulatorChannelsOpen(wanted, tries: tries - 1) }
                return
            }
            if stack.viewControllers.count == 1, page.openFirst() != nil, wanted == "community" { return }
            self.simulatorChannelsOpen(wanted, tries: tries - 1)
        }
    }
}
#endif
