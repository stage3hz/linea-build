#if targetEnvironment(simulator)
import UIKit

/// Made-up stories and posts with drawn pictures, for looking at the strip, the viewer, the screen that publishes
/// and a profile's tabs in the simulator while there is no account behind them. Compiled for the simulator only:
/// a build for a phone does not contain this file's contents.
///
/// What the simulator check asks for by launch arguments (see SceneDelegate.simulatorStart):
///   -storiesdemo strip      the chats with the strip: «Моя история», two people with unseen stories, one shown for
///                           a post («запись»), one whose request is waiting (a clock, «заявка»), one all seen (grey ring)
///   -storiesdemo viewer     the first person's story open (the clock stands still at 40% of the second bar)
///   -storiesdemo viewers    the account's own story with «Просмотры» open over it
///   -storiesdemo compose    the screen before publishing: a drawn picture, a caption, «Добавить историю»
///   -storiesdemo posts      a person's profile with the ring around the avatar and the «Публикации» grid
///   -storiesdemo own        «Публикации и истории» of the account itself (with «Добавить публикацию»)
/// With an account (after -login … on the local test server):
///   -stories viewer         opens the first person of the strip as soon as the feed has one
///   -stories own            «Настройки» → «Публикации и истории»; -stories ownstories: its «Истории» tab
///   -stories compose        the screen before publishing with a drawn picture (nothing is sent by itself)
///   (a friend's profile with the tabs: the existing -profile friend)
enum StoriesDemo {
    static let me = Person(id: "demo-me", username: "maria", displayName: "Мария Орлова", bio: "", birthday: "", avatarColor: 0x34C3A0, avatarId: "")

    private static let palettes: [(UInt32, UInt32, UInt32)] = [
        (0x16316A, 0x2EE6C8, 0xFFF4C2), (0xB0401E, 0xF2A33C, 0xFFE9B0), (0x1E5D3A, 0xB8E07A, 0xFDF6D8),
        (0x0E2A47, 0x3CA7F2, 0xE8F6FF), (0x3A2A1A, 0xE8C27A, 0xFFF1D6), (0x10363A, 0x7FD6F5, 0xF2FFFB),
        (0x243B1E, 0xE0B84A, 0xFFF7E0), (0x1B2B5A, 0xF26B5E, 0xFFE3D6),
    ]

    /// A drawn picture (no photo of anyone): a sky, a sun, two hills.
    static func picture(_ number: Int, tall: Bool) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let size = tall ? CGSize(width: 720, height: 1280) : CGSize(width: 900, height: 900)
        let colors = palettes[((number % palettes.count) + palettes.count) % palettes.count]
        return UIGraphicsImageRenderer(size: size, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
            let pair = [UIColor(hex: colors.0).cgColor, UIColor(hex: colors.1).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: pair, locations: nil) {
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width * 0.3, y: size.height), options: [])
            }
            UIColor(hex: colors.2, alpha: 0.9).setFill()
            let sun = size.width * (0.2 + 0.04 * CGFloat(number % 3))
            context.cgContext.fillEllipse(in: CGRect(x: size.width * (0.55 - 0.1 * CGFloat(number % 4)), y: size.height * 0.16, width: sun, height: sun))
            UIColor(hex: colors.0, alpha: 0.55).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: -size.width * 0.3, y: size.height * 0.68, width: size.width * 1.1, height: size.height * 0.7))
            UIColor(hex: colors.0, alpha: 0.8).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: size.width * 0.35, y: size.height * 0.76, width: size.width * 1.0, height: size.height * 0.6))
        }
    }

    private static var drawn = false

    /// Puts the drawn pictures where the loaders look first.
    static func draw() {
        if drawn { return }
        drawn = true
        for number in 0..<12 { ChannelImages.shared.putSample(picture(number, tall: true), id: "demo-story-\(number)") }
        for number in 0..<9 { ChannelImages.shared.putSample(picture(number + 3, tall: false), id: "demo-post-\(number)") }
        StoryVideoFrames.shared.putSample(picture(5, tall: false), id: "demo-video-0")
    }

    private static func stamp(hoursAgo: Double) -> String {
        let maker = ISO8601DateFormatter()
        maker.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return maker.string(from: Date().addingTimeInterval(-hoursAgo * 3600))
    }

    private static func user(_ person: Person) -> [String: Any] {
        let digits = String(person.avatarColor & 0xFFFFFF, radix: 16, uppercase: true)
        let color = "#" + String(repeating: "0", count: max(0, 6 - digits.count)) + digits
        return ["id": person.id, "username": person.username, "displayName": person.displayName, "avatarColor": color]
    }

    private static func item(_ id: String, kind: String, media: String, hoursAgo: Double, caption: String = "", seen: Bool? = nil, views: Int? = nil, video: Bool = false) -> [String: Any] {
        var made: [String: Any] = ["id": id, "kind": kind, "caption": caption, "createdAt": stamp(hoursAgo: hoursAgo),
                                   "media": ["id": media, "mimeType": video ? "video/mp4" : "image/jpeg", "isImage": !video, "isVideo": video, "size": 240_000]]
        if kind == "story" { made["expiresAt"] = stamp(hoursAgo: hoursAgo - 24) } else { made["expiresAt"] = NSNull() }
        if let seen { made["seen"] = seen }
        if let views { made["views"] = views }
        return made
    }

    /// The strip's feed, as the server would send it.
    static func feed() -> [String: Any] {
        let friends = PeopleDemo.friends
        let waiting = PeopleDemo.outgoing[0]
        var items: [[String: Any]] = []
        let first: [[String: Any]] = [
            item("demo-s-a1", kind: "story", media: "demo-story-0", hoursAgo: 9, seen: true),
            item("demo-s-a2", kind: "story", media: "demo-story-1", hoursAgo: 3, caption: "Вид с перевала. Дальше — только пешком.", seen: false),
            item("demo-s-a3", kind: "story", media: "demo-story-2", hoursAgo: 1, seen: false),
        ]
        items.append(["user": user(friends[0]), "unseen": 2, "latest": stamp(hoursAgo: 1), "stories": first])
        let second: [[String: Any]] = [
            item("demo-s-d1", kind: "story", media: "demo-story-3", hoursAgo: 5, seen: false),
            item("demo-s-d2", kind: "story", media: "demo-story-4", hoursAgo: 2, seen: false),
        ]
        items.append(["user": user(friends[1]), "unseen": 2, "latest": stamp(hoursAgo: 2), "stories": second])
        // No live story, a post from four hours ago: «запись».
        let none: [[String: Any]] = []
        let recent: [[String: Any]] = [item("demo-p-l1", kind: "post", media: "demo-post-0", hoursAgo: 4, caption: "Новая запись")]
        items.append(["user": user(friends[2]), "unseen": 0, "latest": stamp(hoursAgo: 4), "stories": none, "posts": recent])
        // A request to this person is waiting, and they show their stories to everyone: a clock and «заявка».
        let fourth: [[String: Any]] = [item("demo-s-i1", kind: "story", media: "demo-story-5", hoursAgo: 6, seen: false)]
        items.append(["user": user(waiting), "unseen": 1, "pending": true, "latest": stamp(hoursAgo: 6), "stories": fourth])
        let fifth: [[String: Any]] = [
            item("demo-s-m1", kind: "story", media: "demo-story-6", hoursAgo: 14, seen: true),
            item("demo-s-m2", kind: "story", media: "demo-story-7", hoursAgo: 11, seen: true),
        ]
        items.append(["user": user(friends[3]), "unseen": 0, "latest": stamp(hoursAgo: 11), "stories": fifth])
        let mine: [[String: Any]] = [
            item("demo-s-me1", kind: "story", media: "demo-story-8", hoursAgo: 7, caption: "Утро", views: 12),
            item("demo-s-me2", kind: "story", media: "demo-story-9", hoursAgo: 2, views: 5),
        ]
        return ["items": items, "mine": mine]
    }

    static func fillStrip() {
        draw()
        StoriesStore.shared.simulatorSet(me: me)
        StoriesStore.shared.take(feed())
    }

    /// A profile's posts and stories.
    static func profile(own: Bool) -> ProfilePostsData {
        draw()
        var posts: [StoryPost] = []
        for number in 0..<8 {
            if number == 2 {
                if let video = StoryPost(item("demo-pp-video", kind: "post", media: "demo-video-0", hoursAgo: 30, video: true)) { posts.append(video) }
            } else if let post = StoryPost(item("demo-pp-\(number)", kind: "post", media: "demo-post-\(number)", hoursAgo: Double(20 + number * 26), caption: number == 0 ? "Собрали гербарий за лето" : "")) {
                posts.append(post)
            }
        }
        var stories: [StoryPost] = []
        for number in 0..<2 {
            if let story = StoryPost(item("demo-ps-\(number)", kind: "story", media: "demo-story-\(number + 10)", hoursAgo: Double(2 + number * 5), seen: own ? nil : false, views: own ? 7 - number : nil)) { stories.append(story) }
        }
        return ProfilePostsData(visible: true, posts: posts, stories: stories)
    }

    static let viewers = StoryViewersData(count: 5, rows: [
        (person: PeopleDemo.friends[0], viewedAt: stamp(hoursAgo: 0.2)),
        (person: PeopleDemo.friends[1], viewedAt: stamp(hoursAgo: 0.6)),
        (person: PeopleDemo.friends[3], viewedAt: stamp(hoursAgo: 1.1)),
        (person: PeopleDemo.friends[4], viewedAt: stamp(hoursAgo: 1.4)),
        (person: PeopleDemo.friends[2], viewedAt: stamp(hoursAgo: 1.9)),
    ])

    private static var asked: Bool {
        let args = UserDefaults.standard
        return args.string(forKey: "storiesdemo") != nil || args.string(forKey: "stories") != nil
    }

    /// A viewer opened during a simulator check stands still, so the shot does not depend on its timing.
    static func dress(_ viewer: StoryViewerController) {
        if asked { viewer.frozenAt = 0.4 }
    }
}

extension SceneDelegate {
    /// `-storiesdemo …` (no account) decides the start; `-stories …` (with an account) only opens something later.
    func simulatorStories() -> Bool {
        let args = UserDefaults.standard
        if let wanted = args.string(forKey: "stories") { simulatorStoriesOpen(wanted, tries: 60) }
        guard let demo = args.string(forKey: "storiesdemo") else { return false }
        let root = RootViewController()
        let stack = NavigationController(rootViewController: root)
        window?.rootViewController = stack
        root.loadViewIfNeeded()
        switch demo {
        case "viewer":
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { _ = StoriesStrip.simulatorCurrent?.simulatorOpenFirst() }
        case "viewers":
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                StoriesStrip.simulatorCurrent?.open(StoriesDemo.me.id)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    (stack.presentedViewController as? StoryViewerController)?.simulatorShowViewers(StoriesDemo.viewers)
                }
            }
        case "compose":
            let screen = StoryComposeViewController(messenger: nil, kind: "story")
            stack.pushViewController(screen, animated: false)
            screen.simulatorFill(StoriesDemo.picture(1, tall: true), caption: "Вид с перевала")
        case "posts":
            let friend = PeopleDemo.friends[0]
            stack.pushViewController(PersonProfileViewController(messenger: nil, userId: friend.id, name: friend.displayName, person: friend), animated: false)
        case "own":
            stack.pushViewController(OwnPostsViewController(messenger: nil), animated: false)
        default:
            break
        }
        return true
    }

    /// With an account: waits for the shell (the sign-in of the same launch may still be going), then opens.
    private func simulatorStoriesOpen(_ wanted: String, tries: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, tries > 0 else { return }
            guard let stack = self.window?.rootViewController as? NavigationController, stack.viewControllers.first is RootViewController,
                  let messenger = StoriesStore.shared.simulatorMessenger else {
                return self.simulatorStoriesOpen(wanted, tries: tries - 1)
            }
            switch wanted {
            case "viewer":
                // The feed is read from the server: tried until somebody is in it.
                if StoriesStrip.simulatorCurrent?.simulatorOpenFirst() != true { self.simulatorStoriesOpen(wanted, tries: tries - 1) }
            case "own", "ownstories":
                let page = OwnPostsViewController(messenger: messenger)
                stack.pushViewController(page, animated: false)
                if wanted == "ownstories" { page.block.simulatorShow(tab: "story") }
            case "compose":
                let screen = StoryComposeViewController(messenger: messenger, kind: "story")
                stack.pushViewController(screen, animated: false)
                screen.simulatorFill(StoriesDemo.picture(1, tall: true), caption: "Вид с перевала")
            default:
                break
            }
        }
    }
}
#endif
