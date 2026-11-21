import UIKit

/// The Platina decoration editor (the reference's platina/PlatinaStudio.tsx): frames and art in an even grid with
/// tabs, the banner presets, the profile effects and the nameplates, each with its live look. Without Platina
/// everything is shown but locked (the server enforces the same). A choice shows as chosen at once; requests go one
/// after another and the last choice wins. `compact`: inside the profile editor (the photo / video of the avatar and
/// the banner are changed at its top), only the decorations.
final class PlatinaStudioView: UIView {
    private let messenger: Messenger?
    private let compact: Bool
    private var saved: [String: Any]
    private var optimistic: [String: Any] = [:]
    private var applySeq = 0
    private var queue: [(seq: Int, change: [String: Any], ok: String)] = []
    private var running = false
    private var tab = "Анимация"
    private var noticeWords = ""
    private var problemWords = ""
    /// The avatar-video and banner buttons of the full studio: "avatarVideo", "avatarVideoOff", "banner".
    var onMedia: ((String) -> Void)?
    /// The studio grew or shrank (the page lays it out again).
    var onHeight: (() -> Void)?
    private let stack = UIStackView()

    init(messenger: Messenger?, compact: Bool) {
        self.messenger = messenger
        self.compact = compact
        #if targetEnvironment(simulator)
        let sample: [String: Any] = ["id": "sample", "displayName": ProfileSamples.me.displayName, "username": "maria", "avatarColor": "#9271C3", "seal": "platina", "avatarFrame": "platinum", "bannerPreset": "aurora", "profileEffect": "sparks", "nameplate": "deep"]
        saved = messenger?.ownProfile ?? sample
        #else
        saved = messenger?.ownProfile ?? [:]
        #endif
        super.init(frame: .zero)
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        let initial = PersonLook(saved).avatarFrame
        tab = AvatarCatalog.isCodeFrame(initial) ? "Анимация" : AvatarCatalog.decoration(initial)?.collection ?? (initial.isEmpty ? "Анимация" : "Кольца")
        NotificationCenter.default.addObserver(self, selector: #selector(outside), name: Messenger.ownProfileChanged, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(outside), name: PlatinaState.changed, object: nil)
        rebuild()
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var active: Bool {
        #if targetEnvironment(simulator)
        if messenger == nil { return UserDefaults.standard.string(forKey: "setplatina") != "0" }
        #endif
        return PlatinaState.shared.active
    }

    private var user: [String: Any] {
        var made = saved
        for (key, value) in optimistic { made[key] = value }
        return made
    }

    private var person: Person {
        var made = Person(user) ?? Person(id: "", username: "", displayName: "", bio: "", birthday: "", avatarColor: 0x5E7BFF, avatarId: "")
        made.look = PersonLook(user)
        return made
    }

    private var base: String { return messenger?.server.endpoint ?? "" }

    @objc private func outside() {
        if let messenger, optimistic.isEmpty { saved = messenger.ownProfile }
        rebuild()
    }

    // MARK: Saving

    private func apply(_ change: [String: Any], ok: String) {
        guard active else { return }
        applySeq += 1
        noticeWords = ""
        problemWords = ""
        for (key, value) in change { optimistic[key] = value }
        rebuild()
        guard messenger != nil else {
            #if targetEnvironment(simulator)
            for (key, value) in change { saved[key] = value }
            optimistic = [:]
            noticeWords = ok
            rebuild()
            #endif
            return
        }
        queue.append((seq: applySeq, change: change, ok: ok))
        runQueue()
    }

    /// One request after another, so the server ends on the same choice as the screen.
    private func runQueue() {
        guard !running, !queue.isEmpty, let messenger else { return }
        running = true
        let next = queue.removeFirst()
        messenger.patchOwnProfile(next.change) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            self.running = false
            if next.seq == self.applySeq {
                switch result {
                case .success(let fresh):
                    if !fresh.isEmpty { self.saved = fresh }
                    self.noticeWords = next.ok
                case .failure(let error):
                    // An older server does not know the newest frames yet.
                    let words = error.words.isEmpty ? "Не удалось сохранить оформление." : error.words
                    self.problemWords = words == "Неизвестная рамка." ? "Эта рамка пока недоступна: сервер ещё не обновлён." : words
                }
                self.optimistic = [:]
                self.rebuild()
            }
            self.runQueue()
        }
    }

    // MARK: Building

    private func clear() {
        for part in stack.arrangedSubviews {
            stack.removeArrangedSubview(part)
            part.removeFromSuperview()
        }
    }

    private func rebuild() {
        clear()
        let look = PersonLook(user)
        if !compact {
            let hero = ProfileHeroCard(frame: .zero)
            hero.show(person, look: look, base: base)
            stack.addArrangedSubview(hero)
        }
        if !active {
            let lock = UIStackView()
            lock.axis = .horizontal
            lock.spacing = 8
            lock.alignment = .center
            lock.backgroundColor = Theme.accent.withAlphaComponent(0.16)
            lock.layer.cornerRadius = 14
            lock.isLayoutMarginsRelativeArrangement = true
            lock.layoutMargins = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
            let icon = UIImageView(image: UIImage(systemName: "lock.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)))
            icon.tintColor = Theme.accent
            icon.setContentHuggingPriority(.required, for: .horizontal)
            let words = SettingsLook.words("Оформление доступно с Platina.", size: 13, color: Theme.text)
            lock.addArrangedSubview(icon)
            lock.addArrangedSubview(words)
            stack.addArrangedSubview(lock)
        }
        if !problemWords.isEmpty { stack.addArrangedSubview(SettingsNotice(problemWords, error: true)) }
        if !noticeWords.isEmpty { stack.addArrangedSubview(SettingsNotice(noticeWords)) }

        if !compact {
            let row = UIStackView()
            row.axis = .horizontal
            row.spacing = 10
            row.distribution = .fillEqually
            let pick = SettingsButton(label: look.avatarVideoId.isEmpty ? "Выбрать видео" : "Заменить видео", kind: .secondary)
            pick.isEnabled = active
            pick.onPress = { [weak self] in self?.onMedia?("avatarVideo") }
            row.addArrangedSubview(pick)
            if !look.avatarVideoId.isEmpty {
                let off = SettingsButton(label: "Убрать", kind: .secondary)
                off.isEnabled = active
                off.onPress = { [weak self] in self?.apply(["avatarVideoId": NSNull()], ok: "Видео убрано.") }
                row.addArrangedSubview(off)
            }
            stack.addArrangedSubview(section("Анимированный аватар", "Короткое видео до 10 секунд. Играет без звука в профиле и в шапке чата.", row))
        }

        stack.addArrangedSubview(section("Рамки и украшения", "Видны всем рядом с твоим фото; анимация играет в профиле и у выбранной.", frameGrid(look)))

        let banners = strip()
        banners.addArrangedSubview(choice("Нет", selected: look.bannerId.isEmpty && look.bannerPreset.isEmpty, swatch: dashed(CGSize(width: 84, height: 46), radius: 12)) { [weak self] in
            self?.apply(["bannerId": NSNull(), "bannerPreset": NSNull()], ok: "Баннер убран.")
        })
        for banner in AvatarCatalog.banners {
            let swatch = MusicAmbientView(tone: banner.id, still: true) // Avatars: the one ambient view of the app
            swatch.frame = CGRect(x: 0, y: 0, width: 84, height: 46)
            swatch.layer.cornerRadius = 12
            banners.addArrangedSubview(choice(banner.label, selected: look.bannerId.isEmpty && look.bannerPreset == banner.id, swatch: sized(swatch, CGSize(width: 84, height: 46))) { [weak self] in
                self?.apply(["bannerId": NSNull(), "bannerPreset": banner.id], ok: "Баннер «\(banner.label)».")
            })
        }
        let bannerBox = UIStackView(arrangedSubviews: [scroller(banners)])
        bannerBox.axis = .vertical
        bannerBox.spacing = 10
        if !compact {
            let own = SettingsButton(label: look.bannerId.isEmpty ? "Своё фото или видео" : "Заменить своё фото или видео", kind: .secondary)
            own.isEnabled = active
            own.onPress = { [weak self] in self?.onMedia?("banner") }
            bannerBox.addArrangedSubview(own)
        }
        stack.addArrangedSubview(section("Баннер профиля", "Живой фон над аватаром — или своё фото или видео.", bannerBox))

        let effects = strip()
        effects.addArrangedSubview(choice("Нет", selected: look.profileEffect.isEmpty, swatch: dashed(CGSize(width: 56, height: 56), radius: 16)) { [weak self] in
            self?.apply(["profileEffect": NSNull()], ok: "Эффект убран.")
        })
        for effect in AvatarCatalog.effects {
            let swatch = ProfileEffectView(frame: CGRect(x: 0, y: 0, width: 56, height: 56))
            swatch.backgroundColor = UIColor(hex: 0x11141C)
            swatch.layer.cornerRadius = 16
            swatch.show(effect.id, preview: true)
            effects.addArrangedSubview(choice(effect.label, selected: look.profileEffect == effect.id, swatch: sized(swatch, CGSize(width: 56, height: 56))) { [weak self] in
                self?.apply(["profileEffect": effect.id], ok: "Эффект «\(effect.label)».")
            })
        }
        stack.addArrangedSubview(section("Эффект профиля", "Играет поверх твоего профиля, когда его открывают.", scroller(effects)))

        let plates = strip()
        plates.addArrangedSubview(choice("Нет", selected: look.nameplate.isEmpty, swatch: dashed(CGSize(width: 120, height: 40), radius: 12)) { [weak self] in
            self?.apply(["nameplate": NSNull()], ok: "Табличка убрана.")
        })
        for plate in AvatarCatalog.plates {
            let swatch = UIView(frame: CGRect(x: 0, y: 0, width: 120, height: 40))
            swatch.backgroundColor = Theme.surface2
            swatch.layer.cornerRadius = 12
            swatch.clipsToBounds = true
            let art = NameplateView(frame: swatch.bounds)
            art.show(plate.id, radius: 12)
            swatch.addSubview(art)
            let name = UILabel(frame: CGRect(x: 10, y: 0, width: 104, height: 40))
            name.text = person.displayName
            name.font = .systemFont(ofSize: 13, weight: .semibold)
            name.textColor = .white
            swatch.addSubview(name)
            plates.addArrangedSubview(choice(plate.label, selected: look.nameplate == plate.id, swatch: sized(swatch, CGSize(width: 120, height: 40))) { [weak self] in
                self?.apply(["nameplate": plate.id], ok: "Табличка «\(plate.label)».")
            })
        }
        stack.addArrangedSubview(section("Табличка", "Фон за твоим именем в списке чатов и участников серверов.", scroller(plates)))
        onHeight?()
    }

    private func section(_ title: String, _ hint: String, _ body: UIView) -> UIView {
        let heading = SettingsLook.words(title, size: 15, color: Theme.text, weight: .semibold)
        let words = SettingsLook.words(hint, size: 12, color: Theme.muted)
        let column = UIStackView(arrangedSubviews: [heading, words, body])
        column.axis = .vertical
        column.spacing = 3
        column.setCustomSpacing(9, after: words)
        return column
    }

    private func strip() -> UIStackView {
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 10
        row.alignment = .top
        return row
    }

    private func scroller(_ row: UIStackView) -> UIView {
        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.clipsToBounds = false
        row.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 4),
            row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -4),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 2),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -2),
            scroll.heightAnchor.constraint(equalTo: row.heightAnchor, constant: 8),
        ])
        return scroll
    }

    private func sized(_ view: UIView, _ size: CGSize) -> UIView {
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: size.width).isActive = true
        view.heightAnchor.constraint(equalToConstant: size.height).isActive = true
        return view
    }

    private func dashed(_ size: CGSize, radius: CGFloat) -> UIView {
        let box = UIView(frame: CGRect(origin: .zero, size: size))
        let line = CAShapeLayer()
        line.path = UIBezierPath(roundedRect: box.bounds.insetBy(dx: 0.5, dy: 0.5), cornerRadius: radius).cgPath
        line.fillColor = nil
        line.strokeColor = Theme.subtle.cgColor
        line.lineWidth = 1
        line.lineDashPattern = [4, 3]
        box.layer.addSublayer(line)
        return sized(box, size)
    }

    /// A choice of a strip: its swatch in a frame that lights up when chosen, its name under it.
    private func choice(_ label: String, selected: Bool, swatch: UIView, action: @escaping () -> Void) -> UIView {
        let holder = UIControl()
        holder.isEnabled = active
        holder.isAccessibilityElement = true
        holder.accessibilityLabel = label
        holder.accessibilityTraits = selected ? [.button, .selected] : [.button]
        let frame = UIView()
        frame.isUserInteractionEnabled = false
        frame.layer.cornerRadius = 18
        frame.layer.borderWidth = 2
        frame.layer.borderColor = selected ? Theme.accent.cgColor : UIColor.clear.cgColor
        frame.translatesAutoresizingMaskIntoConstraints = false
        swatch.isUserInteractionEnabled = false
        frame.addSubview(swatch)
        let name = UILabel()
        name.text = label
        name.font = .systemFont(ofSize: 11, weight: selected ? .bold : .medium)
        name.textColor = selected ? Theme.accent : Theme.muted
        name.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(frame)
        holder.addSubview(name)
        NSLayoutConstraint.activate([
            swatch.topAnchor.constraint(equalTo: frame.topAnchor, constant: 5),
            swatch.bottomAnchor.constraint(equalTo: frame.bottomAnchor, constant: -5),
            swatch.leadingAnchor.constraint(equalTo: frame.leadingAnchor, constant: 5),
            swatch.trailingAnchor.constraint(equalTo: frame.trailingAnchor, constant: -5),
            frame.topAnchor.constraint(equalTo: holder.topAnchor),
            frame.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
            frame.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
            name.topAnchor.constraint(equalTo: frame.bottomAnchor, constant: 6),
            name.centerXAnchor.constraint(equalTo: holder.centerXAnchor),
            name.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
        holder.addAction(UIAction { (_: UIAction) -> Void in action() }, for: .touchUpInside)
        return holder
    }

    // MARK: Frames

    private static let gridTabs = ["Анимация"] + AvatarCatalog.decorationCollections + ["Кольца"]

    /// Tabs and an even three-column grid; the chosen tile wears a check mark and plays its motion.
    private func frameGrid(_ look: PersonLook) -> UIView {
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 12
        let tabs = strip()
        tabs.spacing = 6
        for name in PlatinaStudioView.gridTabs {
            var config = UIButton.Configuration.filled()
            let on = tab == name
            config.attributedTitle = AttributedString(NSAttributedString(string: name, attributes: [.font: UIFont.systemFont(ofSize: 13, weight: on ? .bold : .medium)]))
            config.baseBackgroundColor = on ? Theme.accent : Theme.surface2
            config.baseForegroundColor = on ? Theme.onAccent : Theme.text
            config.cornerStyle = .capsule
            config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
            let button = UIButton(configuration: config)
            button.heightAnchor.constraint(equalToConstant: 34).isActive = true
            button.accessibilityTraits = on ? [.button, .selected] : [.button]
            button.addAction(UIAction { [weak self] (_: UIAction) -> Void in
                self?.tab = name
                self?.rebuild()
            }, for: .touchUpInside)
            tabs.addArrangedSubview(button)
        }
        column.addArrangedSubview(scroller(tabs))
        var options: [(id: String, label: String)] = []
        if tab == "Анимация" {
            options = AvatarCatalog.codeFrames.map { (id: $0.id, label: $0.label) }
        } else if tab == "Кольца" {
            options = AvatarCatalog.frames.map { (id: $0.id, label: $0.label) }
        } else {
            options = AvatarCatalog.decorations.filter { $0.collection == tab }.map { (id: $0.id, label: $0.label) }
        }
        let all: [(id: String, label: String)] = [(id: "", label: "Без рамки")] + options
        var row: UIStackView? = nil
        for (index, option) in all.enumerated() {
            if index % 3 == 0 {
                let made = UIStackView()
                made.axis = .horizontal
                made.spacing = 10
                made.distribution = .fillEqually
                column.addArrangedSubview(made)
                row = made
            }
            row?.addArrangedSubview(frameTile(option.id, option.label, selected: look.avatarFrame == option.id))
        }
        if let row, row.arrangedSubviews.count < 3 {
            for _ in row.arrangedSubviews.count..<3 { row.addArrangedSubview(UIView()) }
        }
        return column
    }

    private func frameTile(_ id: String, _ label: String, selected: Bool) -> UIView {
        let tile = UIControl()
        tile.isEnabled = active
        tile.alpha = !active && !selected ? 0.55 : 1
        tile.layer.cornerRadius = 18
        tile.layer.borderWidth = 1.5
        tile.layer.borderColor = selected ? Theme.accent.cgColor : UIColor.clear.cgColor
        tile.backgroundColor = selected ? Theme.accent.withAlphaComponent(0.16) : .clear
        tile.isAccessibilityElement = true
        tile.accessibilityLabel = label
        tile.accessibilityTraits = selected ? [.button, .selected] : [.button]
        tile.heightAnchor.constraint(equalToConstant: 76 + 20 + 26).isActive = true
        let box = UIView()
        box.isUserInteractionEnabled = false
        box.translatesAutoresizingMaskIntoConstraints = false
        tile.addSubview(box)
        if id.isEmpty {
            let none = dashed(CGSize(width: 52, height: 52), radius: 26)
            none.translatesAutoresizingMaskIntoConstraints = false
            box.addSubview(none)
            none.centerXAnchor.constraint(equalTo: box.centerXAnchor).isActive = true
            none.centerYAnchor.constraint(equalTo: box.centerYAnchor).isActive = true
        } else {
            let avatar = DecoratedAvatarView(frame: CGRect(x: 13, y: 13, width: 50, height: 50))
            var look = PersonLook(user)
            look.avatarFrame = id
            look.avatarVideoId = ""
            look.birthday = ""
            avatar.show(person, look: look, base: base, animated: selected)
            box.addSubview(avatar)
        }
        let name = UILabel()
        name.text = label
        name.font = .systemFont(ofSize: 12, weight: selected ? .bold : .medium)
        name.textColor = selected ? Theme.accent : Theme.muted
        name.textAlignment = .center
        name.translatesAutoresizingMaskIntoConstraints = false
        tile.addSubview(name)
        NSLayoutConstraint.activate([
            box.topAnchor.constraint(equalTo: tile.topAnchor, constant: 10),
            box.centerXAnchor.constraint(equalTo: tile.centerXAnchor),
            box.widthAnchor.constraint(equalToConstant: 76),
            box.heightAnchor.constraint(equalToConstant: 76),
            name.topAnchor.constraint(equalTo: box.bottomAnchor, constant: 6),
            name.leadingAnchor.constraint(equalTo: tile.leadingAnchor, constant: 4),
            name.trailingAnchor.constraint(equalTo: tile.trailingAnchor, constant: -4),
        ])
        if selected {
            let check = UIImageView(image: UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .bold)))
            check.tintColor = Theme.onAccent
            check.backgroundColor = Theme.accent
            check.contentMode = .center
            check.layer.cornerRadius = 10
            check.clipsToBounds = true
            check.translatesAutoresizingMaskIntoConstraints = false
            tile.addSubview(check)
            NSLayoutConstraint.activate([
                check.topAnchor.constraint(equalTo: tile.topAnchor, constant: 6),
                check.trailingAnchor.constraint(equalTo: tile.trailingAnchor, constant: -8),
                check.widthAnchor.constraint(equalToConstant: 20),
                check.heightAnchor.constraint(equalToConstant: 20),
            ])
        }
        tile.addAction(UIAction { [weak self] (_: UIAction) -> Void in
            let value: Any = id.isEmpty ? NSNull() : id
            self?.apply(["avatarFrame": value], ok: id.isEmpty ? "Рамка убрана." : "Выбрано: «\(label)».")
        }, for: .touchUpInside)
        return tile
    }
}

/// The top of a profile as others see it (PlatinaStudio.tsx `ProfileHero`, same proportions as the settings head):
/// banner with soft edges, the avatar, the name, the status, @username and the seal. `localPicture` / `localVideo`:
/// a banner picked here and not uploaded yet.
final class ProfileHeroCard: UIView {
    private let banner = ProfileBannerView()
    private let empty = UILabel()
    private let ring = UIView()
    private let avatar = DecoratedAvatarView()
    private let name = PlatinaNameLabel()
    private let status = StatusEmojiView()
    private let handle = UILabel()
    private let seal = PlatinaSealView(small: true)
    private var heightRule: NSLayoutConstraint?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Theme.bg
        layer.cornerRadius = 24
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        layer.borderColor = Theme.veil(0.1).cgColor
        clipsToBounds = true
        addSubview(banner)
        empty.text = "Без баннера"
        empty.font = .systemFont(ofSize: 12)
        empty.textColor = Theme.muted
        empty.textAlignment = .center
        addSubview(empty)
        ring.backgroundColor = Theme.bg
        addSubview(ring)
        avatar.ringBackground = Theme.bg
        addSubview(avatar)
        addSubview(name)
        addSubview(status)
        handle.textColor = Theme.muted
        addSubview(handle)
        addSubview(seal)
        let rule = heightAnchor.constraint(equalToConstant: 330)
        rule.priority = UILayoutPriority(999)
        rule.isActive = true
        heightRule = rule
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ person: Person, look: PersonLook, base: String, localPicture: UIImage? = nil, localVideo: URL? = nil) {
        banner.show(look, base: base, localPicture: localPicture, localVideo: localVideo)
        empty.isHidden = banner.hasContent
        avatar.show(person, look: look, base: base, animated: true)
        name.show(person.displayName, platina: look.platina)
        status.show(look, size: 22, animated: true) // Avatars: animated as the reference
        handle.text = person.username.isEmpty ? "" : "@" + person.username
        seal.isHidden = !look.platina
        seal.owner = (id: person.id, name: person.displayName)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        guard width > 0 else { return }
        let scale = width / 393, height = (width * profileHeroRatio).rounded()
        banner.frame = CGRect(x: 0, y: 0, width: width, height: height)
        empty.frame = banner.frame
        let side = (100 * scale).rounded(), pad = 5 * scale
        ring.frame = CGRect(x: 20 * scale, y: height - 58 * scale, width: side + pad * 2, height: side + pad * 2)
        ring.layer.cornerRadius = ring.bounds.width / 2
        avatar.frame = CGRect(x: ring.frame.minX + pad, y: ring.frame.minY + pad, width: side, height: side)
        name.font = .systemFont(ofSize: 26 * scale, weight: .heavy)
        name.kern = -0.5
        let statusSize = status.isHidden ? CGSize.zero : status.intrinsicContentSize
        let nameWidth = min(name.sizeThatFits(CGSize(width: width, height: 60)).width, width - 40 * scale - statusSize.width - 8)
        name.frame = CGRect(x: 20 * scale, y: ring.frame.maxY + 10 * scale, width: nameWidth, height: 34 * scale)
        status.frame = CGRect(x: name.frame.maxX + 8 * scale, y: name.frame.midY - statusSize.height / 2, width: statusSize.width, height: statusSize.height)
        handle.font = .systemFont(ofSize: 15 * scale)
        handle.sizeToFit()
        handle.frame.origin = CGPoint(x: 20 * scale, y: name.frame.maxY + 4 * scale)
        let sealSize = seal.intrinsicContentSize
        seal.frame = CGRect(x: handle.frame.maxX + 8, y: handle.frame.midY - sealSize.height / 2, width: sealSize.width, height: sealSize.height)
        let total = (handle.frame.maxY + 16 * scale).rounded(.up)
        if heightRule?.constant != total { heightRule?.constant = total }
    }
}

/// The full studio as its own page («Настроить оформление» of the showcase).
final class PlatinaStudioViewController: SettingsPage {
    private let messenger: Messenger?
    private lazy var studio = PlatinaStudioView(messenger: messenger, compact: false)
    private var media: ProfilePhotoChange?

    init(messenger: Messenger?) {
        self.messenger = messenger
        super.init(name: "Оформление профиля")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        add(studio, gap: 8)
        PlatinaState.shared.refresh()
        studio.onMedia = { [weak self] (what: String) -> Void in
            guard let self, let messenger = self.messenger else { return }
            let change = self.media ?? ProfilePhotoChange(messenger: messenger, host: self)
            self.media = change
            switch what {
            case "avatarVideo": change.pickVideoAvatar()
            case "banner": change.ask(kind: "banner")
            default: break
            }
        }
    }
}
