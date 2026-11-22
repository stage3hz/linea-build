import UIKit

/// The head of Settings (the reference's SettingsScreen.tsx `Root`): the banner runs under the status bar (or the
/// person's light when there is none) and stretches when the list is pulled down; the profile effect plays over
/// it; «Изменить» on glass at the top right opens the editor; under it the decorated avatar (100, moving), the name in
/// Unbounded — platinum with Platina — with the emoji status (a tap opens the picker on the profile), @username with
/// the seal (a tap opens the showcase). Without Platina the offer card follows.
///
/// Settings keeps one `SettingsProfileChrome` and asks it for the head on every rebuild; the banner, the effect and
/// the button live on the page's own view (behind / above the list), attached once.
final class SettingsProfileChrome {
    private let backdrop = UIView()
    private let banner = ProfileBannerView()
    private let light = ProfileLightView()
    private let effect = ProfileEffectView()
    private let editGlass = UIVisualEffectView(effect: TabGlass.effect(clear: false, interactive: true, dark: Theme.dark))
    private let editButton = UIButton(type: .system)
    private var watch: NSKeyValueObservation?
    private weak var page: SettingsPage?
    private var messenger: Messenger?

    private var bannerHeight: CGFloat { return 200 + (page?.view.safeAreaInsets.top ?? 59) }

    /// Puts the banner, the effect and «Изменить» on the page once.
    func attach(_ page: SettingsPage, messenger: Messenger?) {
        self.messenger = messenger
        guard self.page == nil else { return }
        self.page = page
        backdrop.isUserInteractionEnabled = false
        backdrop.clipsToBounds = false
        backdrop.addSubview(light)
        backdrop.addSubview(banner)
        page.view.insertSubview(backdrop, at: 0)
        effect.isUserInteractionEnabled = false
        page.view.addSubview(effect)
        editGlass.clipsToBounds = true
        editGlass.layer.cornerRadius = 22
        editButton.setTitle("Изм.", for: .normal)
        editButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        editButton.setTitleColor(Theme.text, for: .normal)
        editButton.addTarget(self, action: #selector(editPressed), for: .touchUpInside)
        editGlass.contentView.addSubview(editButton)
        page.view.addSubview(editGlass)
        watch = page.scroll.observe(\.contentOffset, options: [.new]) { [weak self] (_: UIScrollView, _: NSKeyValueObservedChange<CGPoint>) -> Void in
            self?.follow()
        }
    }

    /// The head for the column (built anew with the page).
    func head(person raw: [String: Any]) -> UIView {
        guard var person = Person(raw) else { return UIView() }
        person.look = PersonLook(raw)
        let base = messenger?.server.endpoint ?? ""
        banner.show(person.look, base: base)
        light.isHidden = person.look.hasBanner
        light.color = LookColor.tint(avatarId: person.avatarId, address: AvatarMedia.address(base: base, id: person.avatarId), chosen: person.avatarColor)
        effect.show(person.look.profileEffect)
        follow()

        let head = UIView()
        let ring = UIControl()
        ring.accessibilityLabel = "Мой профиль"
        ring.addTarget(self, action: #selector(profilePressed), for: .touchUpInside)
        let avatar = DecoratedAvatarView(frame: CGRect(x: 5, y: 5, width: 100, height: 100))
        avatar.show(person, look: person.look, base: base, animated: true)
        ring.addSubview(avatar)
        let name = PlatinaNameLabel()
        name.font = Theme.title(Theme.TypeSize.profileName)
        name.kern = Theme.titleKern
        name.numberOfLines = 2
        name.show(person.displayName, platina: person.look.platina)
        let status = StatusEmojiView()
        status.show(person.look, size: 22, animated: true) // Avatars: animated as the reference
        status.isUserInteractionEnabled = true
        status.accessibilityHint = "Сменить статус рядом с именем"
        status.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(statusPressed)))
        let nameRow = UIStackView(arrangedSubviews: [name, status])
        nameRow.axis = .horizontal
        nameRow.alignment = .center
        nameRow.spacing = 8
        let handle = SettingsLook.words(person.username.isEmpty ? "" : "@" + person.username, size: 15, color: Theme.muted)
        let handleRow = UIStackView(arrangedSubviews: [handle])
        handleRow.axis = .horizontal
        handleRow.alignment = .center
        handleRow.spacing = 8
        if person.look.platina {
            let seal = PlatinaSealView()
            seal.onPress = { PlatinaShowcase.open() }
            handleRow.addArrangedSubview(seal)
        }
        for part in [ring, nameRow, handleRow] as [UIView] {
            part.translatesAutoresizingMaskIntoConstraints = false
            head.addSubview(part)
        }
        // Where the banner ends in the column: 200 under the status bar, the column starting 57 under it.
        let avatarTop: CGFloat = 200 - 57 - 8 - 58
        NSLayoutConstraint.activate([
            ring.topAnchor.constraint(equalTo: head.topAnchor, constant: avatarTop),
            ring.leadingAnchor.constraint(equalTo: head.leadingAnchor, constant: -1),
            ring.widthAnchor.constraint(equalToConstant: 110),
            ring.heightAnchor.constraint(equalToConstant: 110),
            nameRow.topAnchor.constraint(equalTo: ring.bottomAnchor, constant: 12),
            nameRow.leadingAnchor.constraint(equalTo: head.leadingAnchor, constant: 4),
            nameRow.trailingAnchor.constraint(lessThanOrEqualTo: head.trailingAnchor, constant: -4),
            handleRow.topAnchor.constraint(equalTo: nameRow.bottomAnchor, constant: 5),
            handleRow.leadingAnchor.constraint(equalTo: head.leadingAnchor, constant: 4),
            handleRow.bottomAnchor.constraint(equalTo: head.bottomAnchor, constant: -4),
        ])
        return head
    }

    /// «Твой профиль — заметнее любого другого» (SettingsScreen.tsx `PlatinaOffer`), for Settings without Platina.
    func offer() -> UIView {
        // D: on glass, as the reference's `GlassSurface radius={22}` (so «Ледяное стекло» frosts its rim).
        let card = GlassPill(interactive: false)
        card.shape(radius: 22)
        let brand = PlatinaNameLabel()
        brand.font = .systemFont(ofSize: 11, weight: .heavy)
        brand.kern = 2.4
        brand.show("ИНВИЗ PLATINA", platina: true)
        let title = SettingsLook.words("Твой профиль —\nзаметнее любого другого", size: 18, color: Theme.text, weight: .heavy)
        let words = SettingsLook.words("Живой баннер и аватар, платиновое имя, рамки, невидимка и всё, что выйдет дальше.", size: 13, color: Theme.muted)
        let button = PlatinaButton(title: "Попробовать Platina", size: 15)
        button.layer.cornerRadius = 15
        button.addAction(UIAction { (_: UIAction) -> Void in
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            PlatinaShowcase.open()
        }, for: .touchUpInside)
        button.heightAnchor.constraint(equalToConstant: 46).isActive = true
        let stack = UIStackView(arrangedSubviews: [brand, title, words, button])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 6
        stack.setCustomSpacing(8, after: brand)
        stack.setCustomSpacing(14, after: words)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -16),
        ])
        return card
    }

    /// The banner stays at the top of the screen and grows by the pull (scaled about its centre, shifted up by half).
    private func follow() {
        guard let page else { return }
        let width = page.view.bounds.width
        let height = bannerHeight
        let offset = page.scroll.contentOffset.y
        backdrop.transform = .identity
        backdrop.frame = CGRect(x: 0, y: -max(0, offset), width: width, height: height)
        banner.frame = backdrop.bounds
        light.frame = CGRect(x: 0, y: 0, width: width, height: height + 180)
        let pull = max(0, -offset)
        let scale = 1 + pull / max(1, height)
        backdrop.transform = CGAffineTransform(translationX: 0, y: (height * scale - height) / 2).scaledBy(x: scale, y: scale)
        effect.frame = CGRect(x: 0, y: -max(0, offset), width: width, height: height + 140)
        let top = page.view.safeAreaInsets.top
        let wide = editButton.intrinsicContentSize.width + 32
        editGlass.frame = CGRect(x: width - 16 - wide, y: top + 6, width: wide, height: 44)
        editButton.frame = editGlass.bounds
    }

    @objc private func editPressed() {
        guard let messenger else { return }
        page?.navigationController?.pushViewController(ProfileEditViewController(messenger: messenger), animated: true)
    }

    @objc private func profilePressed() {
        page?.navigationController?.pushViewController(OwnProfileViewController(messenger: messenger), animated: true)
    }

    @objc private func statusPressed() {
        let screen = OwnProfileViewController(messenger: messenger)
        screen.opensStatusPicker = true
        page?.navigationController?.pushViewController(screen, animated: true)
    }
}
