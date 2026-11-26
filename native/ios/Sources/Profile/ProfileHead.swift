import UIKit

/// The layers of a full profile's top that do not scroll with it (UserProfile.tsx / ProfileScreen.tsx): the banner
/// (fixed at the top), or the person's light falling from above; on their birthday — without a banner — the festive
/// gradient that follows the scroll and stretches when pulled; the profile effect over everything; and on the
/// birthday a burst of confetti once. Put `back` under the page's scroll view and `front` over it.
final class ProfileTopLayers {
    let back = UIView()
    let front = UIView()
    private let banner = ProfileBannerView()
    private let light = ProfileLightView()
    private let festive = CAGradientLayer()
    private let festiveView = UIView()
    private let effect = ProfileEffectView()
    private var look = PersonLook()
    private var celebrated = false
    /// False when the page already has its own light (ChatLook's on someone's profile).
    var showsLight = true
    /// The header turned festive (no banner, birthday): texts over it are white.
    private(set) var tinted = false

    init() {
        back.isUserInteractionEnabled = false
        front.isUserInteractionEnabled = false
        back.addSubview(light)
        festiveView.layer.addSublayer(festive)
        festiveView.clipsToBounds = true
        back.addSubview(festiveView)
        back.addSubview(banner)
        front.addSubview(effect)
    }

    func show(_ person: Person, base: String) {
        look = person.look
        banner.show(look, base: base)
        let birthday = look.birthdayToday
        tinted = !look.hasBanner && birthday
        light.isHidden = look.hasBanner || tinted || !showsLight
        light.color = LookColor.tint(avatarId: person.avatarId, address: AvatarMedia.address(base: base, id: person.avatarId), chosen: person.avatarColor)
        festiveView.isHidden = !tinted
        let colors = AvatarCatalog.birthdayColors(look.gender)
        festive.colors = [lookColor(colors[0]).cgColor, lookColor(colors[1]).cgColor]
        effect.show(look.profileEffect)
    }

    /// Lays the layers out for the page's width, the scroll (`pull` < 0 when pulled down) and where the hero ends.
    func layout(width: CGFloat, topInset: CGFloat, scrolled: CGFloat, heroBottom: CGFloat) {
        back.frame = CGRect(x: 0, y: 0, width: width, height: max(heroBottom, 440) + 200)
        front.frame = CGRect(x: 0, y: 0, width: width, height: 420)
        banner.frame = CGRect(x: 0, y: 0, width: width, height: 260)
        light.frame = CGRect(x: 0, y: 0, width: width, height: 440)
        effect.frame = front.bounds
        let height = topInset + 56 + heroBottom + 34 + max(0, -scrolled)
        festiveView.frame = CGRect(x: 0, y: min(0, -scrolled), width: width, height: height)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        festive.frame = festiveView.bounds
        CATransaction.commit()
    }

    /// On the birthday: the confetti once, over the page.
    func celebrate(in view: UIView) {
        guard look.birthdayToday, !celebrated, Motion.enabled, view.bounds.width > 0 else { return }
        celebrated = true
        let confetti = ConfettiView(frame: view.bounds)
        confetti.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(confetti)
        confetti.onDone = { [weak confetti] in confetti?.removeFromSuperview() }
        confetti.burst(origin: "bottom", count: 110, colors: AvatarCatalog.birthdayColors(look.gender) + ["#FFFFFF", "#FFD86B"], duration: 2.8)
    }
}

/// The centre of a profile's top (UserProfile.tsx): the pattern around the photo, the decorated avatar (116, moving),
/// the name in Unbounded (platinum with Platina) with the emoji status, the presence and «🎉 Сегодня день рождения».
/// Scrolled up, the photo shrinks towards the top and darkens away; pulled down, it grows.
final class ProfileHeroView: UIView {
    let pattern = ProfilePatternView()
    let avatarHolder = UIView()
    let avatar = DecoratedAvatarView()
    private let dim = UIView()
    let name = PlatinaNameLabel()
    let status = StatusEmojiView()
    let presence = UILabel()
    private let party = ProfilePillLabel()
    private let nameRow = UIStackView()
    private let column = UIStackView()
    /// The emoji status was tapped (the own profile opens the picker).
    var onStatus: ((CGFloat) -> Void)?
    private var tinted = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = false
        addSubview(pattern)
        column.axis = .vertical
        column.alignment = .center
        column.spacing = 6
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        avatar.translatesAutoresizingMaskIntoConstraints = false
        avatarHolder.addSubview(avatar)
        dim.backgroundColor = .black
        dim.alpha = 0
        dim.layer.cornerRadius = 58
        dim.isUserInteractionEnabled = false
        dim.translatesAutoresizingMaskIntoConstraints = false
        avatarHolder.addSubview(dim)
        column.addArrangedSubview(avatarHolder)
        column.setCustomSpacing(16, after: avatarHolder)
        name.font = Theme.title(Theme.TypeSize.profileName)
        name.kern = Theme.titleKern
        name.numberOfLines = 2
        name.textAlignment = .center
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        nameRow.axis = .horizontal
        nameRow.alignment = .center
        nameRow.spacing = 7
        nameRow.addArrangedSubview(name)
        nameRow.addArrangedSubview(status)
        status.isUserInteractionEnabled = true
        status.touchSlop = 10 // ProfileScreen.tsx:305: `hitSlop={10}`
        status.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(statusTapped(_:))))
        column.addArrangedSubview(nameRow)
        presence.font = .systemFont(ofSize: 15)
        presence.textAlignment = .center
        column.addArrangedSubview(presence)
        party.text = "🎉 Сегодня день рождения"
        party.font = .systemFont(ofSize: 13, weight: .bold)
        party.insets = UIEdgeInsets(top: 5, left: 12, bottom: 5, right: 12)
        party.layer.cornerRadius = 14
        party.clipsToBounds = true
        column.addArrangedSubview(party)
        NSLayoutConstraint.activate([
            avatar.widthAnchor.constraint(equalToConstant: 116),
            avatar.heightAnchor.constraint(equalToConstant: 116),
            avatar.topAnchor.constraint(equalTo: avatarHolder.topAnchor, constant: 6),
            avatar.bottomAnchor.constraint(equalTo: avatarHolder.bottomAnchor, constant: -6),
            avatar.leadingAnchor.constraint(equalTo: avatarHolder.leadingAnchor, constant: 6),
            avatar.trailingAnchor.constraint(equalTo: avatarHolder.trailingAnchor, constant: -6),
            dim.topAnchor.constraint(equalTo: avatar.topAnchor),
            dim.bottomAnchor.constraint(equalTo: avatar.bottomAnchor),
            dim.leadingAnchor.constraint(equalTo: avatar.leadingAnchor),
            dim.trailingAnchor.constraint(equalTo: avatar.trailingAnchor),
            column.topAnchor.constraint(equalTo: topAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            nameRow.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -32),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ person: Person, base: String, presenceWords: String?, tinted: Bool) {
        self.tinted = tinted
        avatar.ringBackground = Theme.bg
        avatar.show(person, look: person.look, base: base, animated: true)
        name.onDark = tinted
        name.plainColor = tinted ? .white : Theme.text
        name.show(person.displayName, platina: person.look.platina)
        status.show(person.look, size: 22, animated: true) // Avatars: animated as the reference
        pattern.show(person.look.profilePattern)
        setPresence(presenceWords)
        party.isHidden = !person.look.birthdayToday
        party.textColor = tinted ? .white : Theme.text
        party.backgroundColor = tinted ? UIColor(white: 1, alpha: 0.22) : ThemeStore.look.accentSoft
    }

    func setPresence(_ words: String?) {
        presence.text = words
        presence.isHidden = words == nil
        presence.textColor = tinted ? UIColor(white: 1, alpha: 0.78) : words == "в сети" ? Theme.accent : Theme.muted
    }

    @objc private func statusTapped(_ gesture: UITapGestureRecognizer) {
        onStatus?(gesture.location(in: nil).y)
    }

    /// Scroll `y` from the rest position: up shrinks and darkens the photo, a pull grows it (the reference's interpolate).
    func applyScroll(_ y: CGFloat) {
        func range(_ value: CGFloat, _ a: CGFloat, _ b: CGFloat, _ c: CGFloat, _ outA: CGFloat, _ outB: CGFloat, _ outC: CGFloat) -> CGFloat {
            if value <= a { return outA }
            if value >= c { return outC }
            if value < b { return outA + (outB - outA) * (value - a) / (b - a) }
            return outB + (outC - outB) * (value - b) / (c - b)
        }
        let shift = range(y, -160, 0, 150, -40, 0, -70)
        let scale = range(y, -160, 0, 150, 1.6, 1, 0.22)
        avatarHolder.transform = CGAffineTransform(translationX: 0, y: shift).scaledBy(x: scale, y: scale)
        avatarHolder.alpha = 1 - max(0, min(1, (y - 60) / 90))
        dim.alpha = max(0, min(0.85, (y - 20) / 110 * 0.85))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        pattern.frame = CGRect(x: -18, y: -90, width: bounds.width + 36, height: 90 + max(220, bounds.height))
        let center = avatarHolder.convert(CGPoint(x: avatarHolder.bounds.midX, y: avatarHolder.bounds.midY), to: pattern)
        if pattern.avatarCenter != center { pattern.avatarCenter = center }
    }
}

/// The «имя пользователя / день рождения / о себе» card of profiles (ProfileInfo.tsx): the same on one's own and on
/// other people's. The username row copies on tap and reads «Скопировано» for a moment.
final class ProfileInfoCard: UIView {
    private let stack = UIStackView()
    var onCopy: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Theme.dark ? Theme.surface2 : .white
        layer.cornerRadius = 22
        layer.cornerCurve = .continuous
        clipsToBounds = true
        stack.axis = .vertical
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    func show(username: String, birthday: String, bio: String, copied: Bool, extra: UIView? = nil) {
        for old in stack.arrangedSubviews {
            stack.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        let first = row("имя пользователя", copied ? "Скопировано" : "@" + username, accent: true)
        first.accessibilityTraits = .button
        first.accessibilityHint = "Нажми, чтобы скопировать"
        first.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(copyTapped)))
        stack.addArrangedSubview(first)
        let day = BirthdayWords.format(birthday)
        if !day.isEmpty { stack.addArrangedSubview(line()); stack.addArrangedSubview(row("день рождения", day, accent: false)) }
        if !bio.isEmpty { stack.addArrangedSubview(line()); stack.addArrangedSubview(row("о себе", bio, accent: false)) }
        if let extra {
            stack.addArrangedSubview(line())
            stack.addArrangedSubview(SettingsLook.inset(extra, top: 11, side: 16, bottom: 11))
        }
    }

    @objc private func copyTapped() { onCopy?() }

    private func line() -> UIView {
        let holder = UIView()
        let rule = UIView()
        rule.backgroundColor = Theme.veil(0.1)
        rule.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(rule)
        NSLayoutConstraint.activate([
            rule.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 16),
            rule.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -16),
            rule.topAnchor.constraint(equalTo: holder.topAnchor),
            rule.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
        ])
        return holder
    }

    private func row(_ label: String, _ value: String, accent: Bool) -> UIView {
        let small = SettingsLook.words(label, size: 14, color: Theme.muted)
        let big = SettingsLook.words(value, size: 17, color: accent ? Theme.accent : Theme.text)
        let column = UIStackView(arrangedSubviews: [small, big])
        column.axis = .vertical
        column.spacing = 2
        column.isLayoutMarginsRelativeArrangement = true
        column.layoutMargins = UIEdgeInsets(top: 11, left: 16, bottom: 11, right: 16)
        column.isAccessibilityElement = true
        column.accessibilityLabel = "\(label): \(value)"
        return column
    }
}

/// A label with room around its words (a pill).
final class ProfilePillLabel: UILabel {
    var insets = UIEdgeInsets.zero

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + insets.left + insets.right, height: size.height + insets.top + insets.bottom)
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: insets))
    }
}
