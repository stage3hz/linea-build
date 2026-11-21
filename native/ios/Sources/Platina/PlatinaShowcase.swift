import UIKit

/// «Вот так будешь выглядеть ты» (the reference's platina/PlatinaShowcase.tsx): the viewer's own profile already
/// dressed in Platina, then what it includes. Opens from any seal or platinum name, from the offer in Settings. Pulled
/// down from the top of the page it closes. Always dark, as the reference.
enum PlatinaShowcase {
    /// Opens the showcase over whatever is on screen. `owner`: whose seal was tapped (someone else's: «У … — Platina»).
    static func open(owner: (id: String, name: String)? = nil) {
        guard let top = platinaTopScreen(), !(top is PlatinaShowcaseViewController) else { return }
        top.present(PlatinaShowcaseViewController(owner: owner), animated: true, completion: nil)
    }
}

final class PlatinaShowcaseViewController: UIViewController, UIScrollViewDelegate {
    private static let perks: [(symbol: String, title: String, text: String)] = [
        ("video.fill", "Живой аватар", "Видео до 10 секунд вместо фото"),
        ("circle", "Рамки", "Платиновая и ещё шесть анимированных"),
        ("photo.fill", "Живой баннер", "Фото, видео или анимация над профилем"),
        ("sparkles", "Эффект профиля", "Снег, искры, лепестки — когда открывают твой профиль"),
        ("rectangle.stack.fill", "Табличка", "Фон за именем в чатах и списках участников"),
        ("diamond.fill", "Платиновое имя и печать", "Видно в чатах, каналах и на серверах"),
        ("face.smiling.fill", "Анимированные эмодзи", "Статус у имени и большие эмодзи в чатах"),
        ("paintpalette.fill", "Цветовые темы", "Семь палитр: Аметист, Кофе, Олива, Сумерки, Лагуна, Индиго, Неон"),
        ("eye.slash.fill", "Невидимка", "Скрыть время захода и прочтения"),
        ("at", "Смена @имени", "Дополнительные смены публичного имени"),
    ]
    private let owner: (id: String, name: String)?
    private let text = UIColor(hex: 0xEEF1F6), muted = UIColor(hex: 0x8B93A3), card = UIColor(hex: 0x101217)
    private let scroll = UIScrollView()
    private let column = UIStackView()
    private let button = PlatinaButton(title: "Попробовать Platina")
    private let note = UILabel()
    private let close = UIButton(type: .system)

    init(owner: (id: String, name: String)?) {
        self.owner = owner
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = false
            sheet.preferredCornerRadius = 30
        }
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// The account's own profile and its server (the simulator's sample person without an account).
    private var me: (person: Person, look: PersonLook, base: String) {
        if let messenger = PlatinaState.shared.messenger, let person = Person(messenger.ownProfile) {
            return (person, person.look, messenger.server.endpoint)
        }
        #if targetEnvironment(simulator)
        let sample = ProfileSamples.me
        return (sample, sample.look, "")
        #else
        return (Person(id: "", username: "", displayName: "", bio: "", birthday: "", avatarColor: 0x5E7BFF, avatarId: ""), PersonLook(), "")
        #endif
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.overrideUserInterfaceStyle = .dark
        view.backgroundColor = UIColor(hex: 0x06070A)
        scroll.delegate = self
        scroll.alwaysBounceVertical = true
        scroll.showsVerticalScrollIndicator = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        column.axis = .vertical
        column.alignment = .center
        column.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(column)
        let width = min(UIScreen.main.bounds.width - 32, 520)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 60),
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -40),
            column.centerXAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerXAnchor),
            column.widthAnchor.constraint(equalToConstant: width),
        ])

        let mine = me
        let lead = UILabel()
        if let owner, owner.id != mine.person.id {
            lead.text = "У \(owner.name) — Platina. А вот так будешь выглядеть ты:"
        } else {
            lead.text = "Так твой профиль увидят другие"
        }
        lead.font = .systemFont(ofSize: 13)
        lead.textColor = muted
        lead.numberOfLines = 0
        lead.textAlignment = .center
        column.addArrangedSubview(lead)
        column.setCustomSpacing(12, after: lead)

        let preview = makePreview(width: width, person: mine.person, look: mine.look, base: mine.base)
        column.addArrangedSubview(preview)
        column.setCustomSpacing(28, after: preview)

        let brand = PlatinaNameLabel()
        brand.onDark = true
        brand.font = .systemFont(ofSize: 30, weight: .heavy)
        brand.kern = -0.6
        brand.show("Инвиз Platina", platina: true)
        column.addArrangedSubview(brand)
        column.setCustomSpacing(8, after: brand)
        let pitch = UILabel()
        pitch.text = "Профиль, который заметят. Всё, что ниже, и всё, что появится дальше."
        pitch.font = .systemFont(ofSize: 14)
        pitch.textColor = muted
        pitch.numberOfLines = 0
        pitch.textAlignment = .center
        column.addArrangedSubview(pitch)
        pitch.widthAnchor.constraint(equalToConstant: width - 24).isActive = true
        column.setCustomSpacing(22, after: pitch)

        let list = UIStackView()
        list.axis = .vertical
        list.backgroundColor = card
        list.layer.cornerRadius = 20
        list.layer.cornerCurve = .continuous
        list.isLayoutMarginsRelativeArrangement = true
        list.layoutMargins = UIEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
        for (index, perk) in PlatinaShowcaseViewController.perks.enumerated() {
            list.addArrangedSubview(perkRow(perk, first: index == 0))
        }
        column.addArrangedSubview(list)
        list.widthAnchor.constraint(equalToConstant: width).isActive = true
        column.setCustomSpacing(24, after: list)

        button.layer.cornerRadius = 18
        button.addTarget(self, action: #selector(tryPressed), for: .touchUpInside)
        column.addArrangedSubview(button)
        NSLayoutConstraint.activate([button.widthAnchor.constraint(equalToConstant: width), button.heightAnchor.constraint(equalToConstant: 54)])
        column.setCustomSpacing(10, after: button)
        note.font = .systemFont(ofSize: 12)
        note.textColor = muted
        note.numberOfLines = 0
        note.textAlignment = .center
        column.addArrangedSubview(note)
        note.widthAnchor.constraint(equalToConstant: width).isActive = true

        let glass = UIVisualEffectView(effect: TabGlass.effect(clear: false, interactive: true, dark: true))
        glass.clipsToBounds = true
        glass.layer.cornerRadius = 22
        glass.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(glass)
        close.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
        close.tintColor = .white
        close.accessibilityLabel = "Закрыть"
        close.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        glass.contentView.addSubview(close)
        NSLayoutConstraint.activate([
            glass.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            glass.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            glass.widthAnchor.constraint(equalToConstant: 44),
            glass.heightAnchor.constraint(equalToConstant: 44),
            close.topAnchor.constraint(equalTo: glass.contentView.topAnchor),
            close.bottomAnchor.constraint(equalTo: glass.contentView.bottomAnchor),
            close.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor),
            close.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: PlatinaState.changed, object: nil)
        PlatinaState.shared.refresh()
        refresh()
    }

    private func makePreview(width: CGFloat, person: Person, look: PersonLook, base: String) -> UIView {
        let dressed = look.dressed()
        let box = UIView()
        box.backgroundColor = card
        box.layer.cornerRadius = 26
        box.layer.cornerCurve = .continuous
        box.clipsToBounds = true
        box.translatesAutoresizingMaskIntoConstraints = false
        box.widthAnchor.constraint(equalToConstant: width).isActive = true
        box.heightAnchor.constraint(equalToConstant: 248).isActive = true
        let top = UIView(frame: CGRect(x: 0, y: 0, width: width, height: 120))
        top.clipsToBounds = true
        if look.hasBanner {
            let banner = ProfileBannerView(frame: top.bounds)
            banner.show(look, base: base)
            top.addSubview(banner)
        } else {
            let ambient = MusicAmbientView(tone: "deep") // Avatars: the one ambient view of the app
            ambient.frame = top.bounds
            top.addSubview(ambient)
        }
        let shade = CAGradientLayer()
        shade.frame = top.bounds
        shade.colors = [card.withAlphaComponent(0).cgColor, card.cgColor]
        shade.locations = [0.4, 1]
        top.layer.addSublayer(shade)
        box.addSubview(top)
        let effect = ProfileEffectView(frame: CGRect(x: 0, y: 0, width: width, height: 200))
        effect.show(dressed.profileEffect)
        box.addSubview(effect)

        let ring = UIView(frame: CGRect(x: 18, y: 120 - 46, width: 88, height: 88))
        ring.backgroundColor = card
        ring.layer.cornerRadius = 44
        box.addSubview(ring)
        let avatar = DecoratedAvatarView(frame: CGRect(x: 5, y: 5, width: 78, height: 78))
        avatar.ringBackground = card
        avatar.show(person, look: dressed, base: base, animated: true)
        ring.addSubview(avatar)

        let name = PlatinaNameLabel()
        name.onDark = true
        name.font = .systemFont(ofSize: 24, weight: .heavy)
        name.kern = -0.4
        name.show(person.displayName, platina: true)
        name.frame = CGRect(x: 18, y: ring.frame.maxY + 10, width: width - 36, height: 30)
        box.addSubview(name)
        let handle = UILabel()
        handle.text = person.username.isEmpty ? "" : "@" + person.username
        handle.font = .systemFont(ofSize: 14)
        handle.textColor = muted
        handle.sizeToFit()
        handle.frame.origin = CGPoint(x: 18, y: name.frame.maxY + 6 + (22 - handle.frame.height) / 2)
        box.addSubview(handle)
        let seal = PlatinaSealView()
        seal.onPress = { }
        let sealSize = seal.intrinsicContentSize
        seal.frame = CGRect(x: handle.frame.maxX + 8, y: name.frame.maxY + 6, width: sealSize.width, height: sealSize.height)
        box.addSubview(seal)
        return box
    }

    private func perkRow(_ perk: (symbol: String, title: String, text: String), first: Bool) -> UIView {
        let row = UIView()
        if !first {
            let line = UIView()
            line.backgroundColor = UIColor(white: 1, alpha: 0.08)
            line.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(line)
            NSLayoutConstraint.activate([
                line.topAnchor.constraint(equalTo: row.topAnchor),
                line.leadingAnchor.constraint(equalTo: row.leadingAnchor),
                line.trailingAnchor.constraint(equalTo: row.trailingAnchor),
                line.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
            ])
        }
        let icon = UIView()
        icon.clipsToBounds = true
        icon.layer.cornerRadius = 11
        icon.layer.cornerCurve = .continuous
        let metal = CAGradientLayer()
        metal.colors = PlatinaMetal.platinum.map { lookColor($0).cgColor }
        metal.startPoint = CGPoint(x: 0, y: 0)
        metal.endPoint = CGPoint(x: 1, y: 1)
        metal.frame = CGRect(x: 0, y: 0, width: 34, height: 34)
        icon.layer.addSublayer(metal)
        let symbol = UIImageView(image: UIImage(systemName: perk.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)))
        symbol.tintColor = UIColor(hex: 0x1A1F2A)
        symbol.contentMode = .center
        symbol.frame = CGRect(x: 0, y: 0, width: 34, height: 34)
        icon.addSubview(symbol)
        icon.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(icon)
        let title = UILabel()
        title.text = perk.title
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = text
        let words = UILabel()
        words.text = perk.text
        words.font = .systemFont(ofSize: 12.5)
        words.textColor = muted
        words.numberOfLines = 0
        let texts = UIStackView(arrangedSubviews: [title, words])
        texts.axis = .vertical
        texts.spacing = 2
        texts.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(texts)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
            icon.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 34),
            icon.heightAnchor.constraint(equalToConstant: 34),
            texts.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 14),
            texts.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -16),
            texts.topAnchor.constraint(equalTo: row.topAnchor, constant: 11),
            texts.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -11),
        ])
        return row
    }

    private var noteShown = false

    @objc private func refresh() {
        let active = PlatinaState.shared.active
        button.setTitle(active ? "Настроить оформление" : "Попробовать Platina")
        if noteShown {
            note.text = "Покупка в приложении скоро появится. Сейчас Platina выдаёт администратор сервера."
            note.font = .systemFont(ofSize: 13)
        } else {
            note.text = active ? "Platina уже активна" : "Отменить можно в любой момент"
            note.font = .systemFont(ofSize: 12)
        }
    }

    @objc private func tryPressed() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if PlatinaState.shared.active, let messenger = PlatinaState.shared.messenger {
            let presenter = presentingViewController
            dismiss(animated: true) {
                let stack = presenter as? UINavigationController ?? presenter?.navigationController
                stack?.pushViewController(PlatinaStudioViewController(messenger: messenger), animated: true)
            }
            return
        }
        noteShown = true
        refresh()
    }

    @objc private func closePressed() { dismiss(animated: true, completion: nil) }

    /// Pulled down from the top of the page it closes (the sheet itself also closes by its own pull).
    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        if scrollView.contentOffset.y < -110 { dismiss(animated: true, completion: nil) }
    }
}
