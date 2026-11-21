#if targetEnvironment(simulator)
import UIKit

/// The simulator checks of avatars, profiles, Platina, gifts and fonts — sample data, no account:
///   -profiledemo rings | code | art | list | marks | fonts      galleries: turning rings + the birthday ring, frames
///                                                               drawn in code, painted art (all moving), the still
///                                                               list sizes, Platina's name / seal / gem / status /
///                                                               nameplates, the type scale
///   -profiledemo person | birthday | own | gifts                someone's profile in full Platina dress, a friend's
///                                                               birthday (festive top, ring, 🎂, confetti), one's own
///                                                               profile, the «Подарки» tab
///   -profiledemo showcase | studio | confetti | offer           Platina: the showcase, the studio, «Платина активирована»,
///                                                               Settings with the head and the offer
///   -profiledemo mini | mini-chat | media | cropper | banner | pattern | status | giftsheet
///                                                               the mini profile (plain, in a chat), the photo viewer,
///                                                               the round cropper, the banner preview, «Узор фона»,
///                                                               the status picker, sending a gift
extension SceneDelegate {
    func simulatorProfiles() -> Bool {
        guard let what = UserDefaults.standard.string(forKey: "profiledemo") else { return false }
        let root = RootViewController()
        let stack = NavigationController(rootViewController: root)
        window?.rootViewController = stack
        root.loadViewIfNeeded()
        let later: (@escaping () -> Void) -> Void = { (job: @escaping () -> Void) -> Void in DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: job) }
        switch what {
        case "rings", "code", "art", "list", "marks", "fonts":
            stack.pushViewController(AvatarGalleryViewController(mode: what), animated: false)
        case "person":
            let friend = ProfileSamples.platinaFriend
            stack.pushViewController(PersonProfileViewController(messenger: nil, userId: friend.id, name: friend.displayName, person: friend), animated: false)
        case "birthday":
            let friend = ProfileSamples.birthdayFriend
            stack.pushViewController(PersonProfileViewController(messenger: nil, userId: friend.id, name: friend.displayName, person: friend), animated: false)
        case "own":
            stack.pushViewController(OwnProfileViewController(messenger: nil), animated: false)
        case "gifts":
            let page = OwnPostsViewController(messenger: nil)
            stack.pushViewController(page, animated: false)
            later { page.block.simulatorShow(tab: "gift") }
        case "showcase":
            later { PlatinaShowcase.open(owner: (id: ProfileSamples.platinaFriend.id, name: ProfileSamples.platinaFriend.displayName)) }
        case "studio":
            stack.pushViewController(PlatinaStudioViewController(messenger: nil), animated: false)
        case "confetti":
            // Late, so the shot taken 12 s after the launch catches the confetti in the air.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10.5) { PlatinaConfettiHost.show(over: root) }
        case "offer":
            root.show("profile")
        case "mini", "mini-chat":
            let friend = ProfileSamples.platinaFriend
            later {
                var quick: MiniProfileViewController.Quick? = nil
                if what == "mini-chat" { quick = MiniProfileViewController.Quick(onCall: { (_: Bool) -> Void in }, onAttachments: {}, noCopy: false, onNoCopy: { (_: Bool) -> Void in }) }
                MiniProfileViewController.present(friend, messenger: nil, from: stack, status: "в сети", onWrite: {}, onOpenProfile: {}, quick: quick)
            }
        case "media":
            var friend = ProfileSamples.platinaFriend
            friend = Person(id: friend.id, username: friend.username, displayName: friend.displayName, bio: friend.bio, birthday: friend.birthday, avatarColor: friend.avatarColor, avatarId: "sample-photo")
            later {
                let viewer = ProfileMediaViewer(person: friend, base: "")
                viewer.samplePicture = ProfileSamples.picture(2, size: CGSize(width: 900, height: 900))
                stack.present(viewer, animated: false, completion: nil)
            }
        case "cropper":
            later { stack.present(AvatarCropperViewController(picture: ProfileSamples.picture(1, size: CGSize(width: 1200, height: 900))), animated: false, completion: nil) }
        case "banner":
            later { stack.present(BannerPreviewViewController(messenger: nil, picture: ProfileSamples.picture(3, size: CGSize(width: 1200, height: 800))), animated: false, completion: nil) }
        case "pattern":
            later { stack.present(PatternPickerViewController(current: "🦋", done: { (_: String?) -> Void in }), animated: false, completion: nil) }
        case "status":
            let own = OwnProfileViewController(messenger: nil)
            stack.pushViewController(own, animated: false)
            later {
                let status: [String: Any] = ["platina": ["active": true], "canSetStatusEmoji": true, "statusEmojiChoices": AvatarCatalog.statusEmoji]
                stack.present(StatusPickerViewController(anchorY: 300, status: status, current: "🔥"), animated: false, completion: nil)
            }
        case "giftsheet":
            later { stack.present(GiftSheetViewController(messenger: nil, userId: "sample"), animated: false, completion: nil) }
        default:
            break
        }
        return true
    }
}

/// Galleries of the decorations and the type for the simulator checks.
final class AvatarGalleryViewController: UIViewController {
    private let mode: String

    init(mode: String) {
        self.mode = mode
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        let scroll = UIScrollView()
        scroll.frame = view.bounds
        scroll.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(scroll)
        let width = view.bounds.width
        var y: CGFloat = 70
        func caption(_ text: String) {
            let label = UILabel(frame: CGRect(x: 16, y: y, width: width - 32, height: 20))
            label.text = text
            label.font = .systemFont(ofSize: 13, weight: .semibold)
            label.textColor = Theme.muted
            scroll.addSubview(label)
            y += 28
        }
        func grid(_ items: [(id: String, label: String)], size: CGFloat, animated: Bool, birthday: Bool = false) {
            let columns = size > 64 ? 3 : 5
            let cell = (width - 32) / CGFloat(columns)
            for (index, item) in items.enumerated() {
                let x = 16 + CGFloat(index % columns) * cell
                let top = y + CGFloat(index / columns) * (size * 1.5 + 34)
                var person = ProfileSamples.dressed(item.id, index)
                if birthday { person = ProfileSamples.birthdayFriend }
                let avatar = DecoratedAvatarView(frame: CGRect(x: x + (cell - size) / 2, y: top + size * 0.25, width: size, height: size))
                if index % 2 == 0 { avatar.overridePicture = ProfileSamples.picture(index, size: CGSize(width: 300, height: 300)) }
                avatar.show(person, look: person.look, base: "", animated: animated)
                scroll.addSubview(avatar)
                let label = UILabel(frame: CGRect(x: x, y: top + size * 1.5 + 6, width: cell, height: 16))
                label.text = item.label
                label.font = .systemFont(ofSize: 11)
                label.textColor = Theme.muted
                label.textAlignment = .center
                scroll.addSubview(label)
            }
            y += CGFloat((items.count + columns - 1) / columns) * (size * 1.5 + 34) + 12
        }
        let rings = AvatarCatalog.frames.map { (id: $0.id, label: $0.label) }
        let codes = AvatarCatalog.codeFrames.map { (id: $0.id, label: $0.label) }
        let arts = AvatarCatalog.decorations.map { (id: $0.id, label: $0.label) }
        switch mode {
        case "rings":
            caption("Кольца (вращаются)")
            grid(rings, size: 80, animated: true)
            caption("День рождения")
            grid([(id: "", label: "🎂")], size: 80, animated: true, birthday: true)
        case "code":
            caption("Рамки, нарисованные кодом")
            grid(codes, size: 80, animated: true)
        case "art":
            caption("Украшения")
            grid(arts, size: 70, animated: true)
        case "list":
            caption("В списке (неподвижно)")
            grid(rings + codes + arts, size: 54, animated: false)
        case "marks":
            caption("Платиновое имя, печать, значок, статус")
            let name = PlatinaNameLabel(frame: CGRect(x: 16, y: y, width: width - 32, height: 36))
            name.font = Theme.title(27)
            name.kern = Theme.titleKern
            name.show("Вера Соколова", platina: true)
            scroll.addSubview(name)
            y += 46
            let seal = PlatinaSealView()
            seal.frame = CGRect(origin: CGPoint(x: 16, y: y), size: seal.intrinsicContentSize)
            scroll.addSubview(seal)
            let small = PlatinaSealView(small: true)
            small.frame = CGRect(origin: CGPoint(x: seal.frame.maxX + 12, y: y + 2), size: small.intrinsicContentSize)
            scroll.addSubview(small)
            let gem = PlatinaGemView(size: 13)
            gem.frame.origin = CGPoint(x: small.frame.maxX + 12, y: y + 2)
            scroll.addSubview(gem)
            let status = StatusEmojiView()
            status.show(ProfileSamples.platinaFriend.look, size: 22)
            status.frame = CGRect(origin: CGPoint(x: gem.frame.maxX + 12, y: y - 4), size: status.intrinsicContentSize)
            scroll.addSubview(status)
            y += 40
            caption("Таблички")
            for plate in AvatarCatalog.plates {
                let row = NameplateView(frame: CGRect(x: 16, y: y, width: width - 32, height: 64))
                row.show(plate.id, radius: 20)
                scroll.addSubview(row)
                let label = UILabel(frame: CGRect(x: 32, y: y, width: width - 64, height: 64))
                label.text = plate.label
                label.font = .systemFont(ofSize: 16, weight: .semibold)
                label.textColor = .white
                scroll.addSubview(label)
                y += 72
            }
        default:
            let samples: [(String, UIFont)] = [
                ("Чаты — Unbounded 30", Theme.title(Theme.TypeSize.chatsTitle)),
                ("Каналы — Unbounded 26", Theme.title(Theme.TypeSize.sectionTitle)),
                ("Имя профиля — Unbounded 27", Theme.title(Theme.TypeSize.profileName)),
                ("Настройки — Unbounded 22", Theme.title(Theme.TypeSize.pageTitle)),
                ("Montserrat ExtraBold 18", Theme.font(18, .heavy)),
                ("Montserrat Bold 17", Theme.font(17, .bold)),
                ("Montserrat SemiBold 16", Theme.font(16, .semibold)),
                ("Montserrat Medium 15", Theme.font(15, .medium)),
                ("Montserrat Regular 15 — системный шрифт", UIFont.systemFont(ofSize: 15)),
                ("Montserrat Regular 12", Theme.font(12)),
            ]
            for (words, font) in samples {
                let label = UILabel(frame: CGRect(x: 16, y: y, width: width - 32, height: font.lineHeight + 8))
                label.attributedText = NSAttributedString(string: words, attributes: [.font: font, .foregroundColor: Theme.text, .kern: font.fontName.hasPrefix("Unbounded") ? Theme.titleKern : 0])
                scroll.addSubview(label)
                y += font.lineHeight + 14
            }
        }
        scroll.contentSize = CGSize(width: width, height: y + 40)
    }
}
#endif
