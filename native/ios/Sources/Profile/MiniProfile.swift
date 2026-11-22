import UIKit

/// The mini profile (the reference's MiniProfile.tsx): tap a name or an avatar (a channel's message, a member list,
/// the chat header) and a compact card rises from the bottom — the banner or a quiet strip of the person's colour, the
/// decorated avatar, the platinum name with the status, @username with the seal, the presence, «о себе», and the
/// obvious actions. Pulled down or tapped outside, it closes.
///
///   MiniProfileViewController.present(person, messenger: messenger, from: self,
///       status: "в сети", onWrite: { … }, onOpenProfile: { … }, quick: nil)
/// `quick` (a personal chat): «Звонок», «Видео», «Вложения» tiles and the chat's own rows — friends, no copying, block.
final class MiniProfileViewController: UIViewController {
    struct Quick {
        var onCall: ((Bool) -> Void)?
        var onAttachments: () -> Void
        /// The chat's «запрет копирования» now, and how to change it (nil: the row is not shown).
        var noCopy: Bool
        var onNoCopy: ((Bool) -> Void)?
    }

    private let person: Person
    private let messenger: Messenger?
    private let statusWords: String?
    private let onWrite: (() -> Void)?
    private let onOpenProfile: (() -> Void)?
    private let quick: Quick?
    private let dimView = UIView()
    private let card = UIView()
    private let note = UILabel()
    private var isFriend: Bool?
    private var request: String?
    private var blocked = false
    private var confirmBlock = false
    private var busy = false
    private var rows = UIStackView()

    static func present(_ person: Person, messenger: Messenger?, from host: UIViewController, status: String? = nil, onWrite: (() -> Void)? = nil, onOpenProfile: (() -> Void)? = nil, quick: Quick? = nil) {
        let screen = MiniProfileViewController(person: person, messenger: messenger, status: status, onWrite: onWrite, onOpenProfile: onOpenProfile, quick: quick)
        host.present(screen, animated: false, completion: nil)
    }

    init(person: Person, messenger: Messenger?, status: String?, onWrite: (() -> Void)?, onOpenProfile: (() -> Void)?, quick: Quick?) {
        self.person = person
        self.messenger = messenger
        statusWords = status
        self.onWrite = onWrite
        self.onOpenProfile = onOpenProfile
        self.quick = quick
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
    }

    required init?(coder: NSCoder) { return nil }

    private var base: String { return messenger?.server.endpoint ?? "" }
    private var surface: UIColor { return Theme.panel(UIColor(hex: 0x1C1D20)) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        dimView.backgroundColor = UIColor(white: 0, alpha: 0.45)
        dimView.alpha = 0
        dimView.frame = view.bounds
        dimView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        dimView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(close)))
        dimView.accessibilityLabel = "Закрыть"
        view.addSubview(dimView)
        card.backgroundColor = surface
        card.layer.cornerRadius = 22
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = 1 / UIScreen.main.scale
        card.layer.borderColor = Theme.veil(0.1).cgColor
        card.clipsToBounds = true
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)
        card.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pulled(_:))))
        let width = min(view.bounds.width - 24, 520)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.widthAnchor.constraint(equalToConstant: width),
            card.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
        ])
        build(width: width)
        if quick != nil, let messenger {
            messenger.personProfile(person.id) { [weak self] (result: Result<PersonProfile, ServerError>) -> Void in
                guard let self else { return }
                switch result {
                case .success(let profile):
                    self.isFriend = profile.isFriend
                    self.request = profile.request
                    self.blocked = profile.blocked
                case .failure:
                    self.isFriend = false
                }
                self.buildRows()
            }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        card.transform = CGAffineTransform(translationX: 0, y: card.bounds.height + 40)
        UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [], animations: {
            self.card.transform = .identity
            self.dimView.alpha = 1
        }, completion: nil)
    }

    private func build(width: CGFloat) {
        let look = person.look
        let top = UIView()
        top.clipsToBounds = true
        top.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(top)
        let bannerHeight: CGFloat = look.hasBanner ? 84 : 56
        if look.hasBanner {
            let banner = ProfileBannerView(frame: CGRect(x: 0, y: 0, width: width, height: 84))
            banner.show(look, base: base)
            top.addSubview(banner)
        } else {
            // No banner: a quiet strip tinted by the person's colour (a full-strength block looked crude).
            let strip = UIView(frame: CGRect(x: 0, y: 0, width: width, height: 56))
            strip.backgroundColor = UIColor(hex: person.avatarColor).withAlphaComponent(0.18)
            top.addSubview(strip)
        }
        let column = UIStackView()
        column.axis = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(column)
        let ring = UIControl()
        ring.backgroundColor = surface
        ring.layer.cornerRadius = 40
        ring.accessibilityLabel = "Открыть полный профиль"
        ring.addTarget(self, action: #selector(openProfilePressed), for: .touchUpInside)
        let avatar = DecoratedAvatarView(frame: CGRect(x: 4, y: 4, width: 72, height: 72))
        avatar.ringBackground = surface
        avatar.show(person, look: look, base: base, animated: true)
        ring.addSubview(avatar)
        ring.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([ring.widthAnchor.constraint(equalToConstant: 80), ring.heightAnchor.constraint(equalToConstant: 80)])
        column.addArrangedSubview(ring)
        column.setCustomSpacing(6, after: ring)
        let name = PlatinaNameLabel()
        name.font = .systemFont(ofSize: 20, weight: .heavy)
        name.show(person.displayName, platina: look.platina)
        let status = StatusEmojiView()
        status.show(look, size: 18, animated: true) // Avatars: animated as the reference
        let nameRow = UIStackView(arrangedSubviews: [name, status])
        nameRow.axis = .horizontal
        nameRow.alignment = .center
        nameRow.spacing = 6
        column.addArrangedSubview(nameRow)
        let handle = SettingsLook.words(person.username.isEmpty ? "" : "@" + person.username, size: 14, color: Theme.muted)
        let handleRow = UIStackView(arrangedSubviews: [handle])
        handleRow.axis = .horizontal
        handleRow.alignment = .center
        handleRow.spacing = 8
        if look.platina {
            let seal = PlatinaSealView(small: true)
            seal.owner = (id: person.id, name: person.displayName)
            handleRow.addArrangedSubview(seal)
        }
        column.addArrangedSubview(handleRow)
        if let statusWords { column.addArrangedSubview(SettingsLook.words(statusWords, size: 13, color: Theme.muted)) }
        if !person.bio.isEmpty {
            let bio = SettingsLook.words(person.bio, size: 14, color: Theme.text)
            bio.numberOfLines = 4
            column.addArrangedSubview(bio)
            column.setCustomSpacing(8, after: column.arrangedSubviews[column.arrangedSubviews.count - 2])
        }
        rows.axis = .vertical
        rows.spacing = 10
        column.addArrangedSubview(rows)
        column.setCustomSpacing(14, after: column.arrangedSubviews[column.arrangedSubviews.count - 2])
        rows.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: card.topAnchor),
            top.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            top.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            top.heightAnchor.constraint(equalToConstant: bannerHeight),
            column.topAnchor.constraint(equalTo: top.bottomAnchor, constant: -36),
            column.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            column.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
            column.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16),
        ])
        buildRows()
    }

    private func actionButton(_ symbol: String, _ label: String, primary: Bool, action: @escaping () -> Void) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
        config.imagePadding = 7
        config.attributedTitle = AttributedString(NSAttributedString(string: label, attributes: [.font: UIFont.systemFont(ofSize: 14, weight: .bold)]))
        config.baseBackgroundColor = primary ? Theme.accent : Theme.surface2
        config.baseForegroundColor = primary ? Theme.onAccent : Theme.text
        config.background.cornerRadius = 14
        let button = UIButton(configuration: config)
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.addAction(UIAction { [weak self] (_: UIAction) -> Void in
            self?.dismissThen(action)
        }, for: .touchUpInside)
        return button
    }

    private func tile(_ symbol: String, _ label: String, action: @escaping () -> Void) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium))
        config.imagePlacement = .top
        config.imagePadding = 5
        config.attributedTitle = AttributedString(NSAttributedString(string: label, attributes: [.font: UIFont.systemFont(ofSize: 12, weight: .semibold)]))
        config.baseBackgroundColor = Theme.surface2
        config.baseForegroundColor = Theme.text
        config.background.cornerRadius = 14
        config.contentInsets = NSDirectionalEdgeInsets(top: 11, leading: 4, bottom: 11, trailing: 4)
        let button = UIButton(configuration: config)
        button.tintColor = Theme.accent
        button.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.dismissThen(action) }, for: .touchUpInside)
        return button
    }

    private func row(_ symbol: String, _ label: String, danger: Bool = false, on: Bool? = nil, hint: String = "", action: @escaping () -> Void) -> UIView {
        let control = UIControl()
        control.isAccessibilityElement = true
        control.accessibilityLabel = label
        control.accessibilityTraits = .button
        let icon = UIImageView(image: UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular)))
        icon.tintColor = danger ? Theme.danger : Theme.text
        icon.contentMode = .center
        let title = SettingsLook.words(label, size: 15, color: danger ? Theme.danger : Theme.text, weight: .semibold)
        let words = UIStackView(arrangedSubviews: [title])
        words.axis = .vertical
        if !hint.isEmpty { words.addArrangedSubview(SettingsLook.words(hint, size: 12, color: Theme.muted)) }
        let line = UIStackView(arrangedSubviews: [icon, words])
        line.axis = .horizontal
        line.spacing = 12
        line.alignment = .center
        line.isUserInteractionEnabled = false
        if let on {
            let toggle = UISwitch()
            toggle.isOn = on
            SettingsLook.paint(toggle)
            toggle.isUserInteractionEnabled = false
            line.addArrangedSubview(toggle)
        }
        line.translatesAutoresizingMaskIntoConstraints = false
        control.addSubview(line)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 22),
            line.topAnchor.constraint(equalTo: control.topAnchor, constant: 8),
            line.bottomAnchor.constraint(equalTo: control.bottomAnchor, constant: -8),
            line.leadingAnchor.constraint(equalTo: control.leadingAnchor, constant: 14),
            line.trailingAnchor.constraint(equalTo: control.trailingAnchor, constant: -14),
            control.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])
        control.addAction(UIAction { (_: UIAction) -> Void in action() }, for: .touchUpInside)
        return control
    }

    private func buildRows() {
        for old in rows.arrangedSubviews {
            rows.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        let me = messenger?.userId == person.id
        if let quick {
            let tiles = UIStackView()
            tiles.axis = .horizontal
            tiles.spacing = 8
            tiles.distribution = .fillEqually
            if let call = quick.onCall {
                tiles.addArrangedSubview(tile("phone.fill", "Звонок") { call(false) })
                tiles.addArrangedSubview(tile("video.fill", "Видео") { call(true) })
            }
            tiles.addArrangedSubview(tile("photo.on.rectangle", "Вложения", action: quick.onAttachments))
            rows.addArrangedSubview(tiles)
            let group = UIStackView()
            group.axis = .vertical
            group.backgroundColor = Theme.surface2
            group.layer.cornerRadius = 14
            group.clipsToBounds = true
            if let friend = isFriend {
                let words = friend ? "Удалить из друзей" : request == "outgoing" ? "Отменить заявку" : request == "incoming" ? "Принять в друзья" : "Добавить в друзья"
                group.addArrangedSubview(row(friend ? "person.badge.minus" : request == "outgoing" ? "clock" : "person.badge.plus", words) { [weak self] in self?.toggleFriend() })
            } else {
                let spinner = UIActivityIndicatorView(style: .medium)
                spinner.color = Theme.accent
                spinner.startAnimating()
                spinner.heightAnchor.constraint(equalToConstant: 48).isActive = true
                group.addArrangedSubview(spinner)
            }
            if let onNoCopy = quick.onNoCopy {
                group.addArrangedSubview(row(quick.noCopy ? "lock" : "lock.open", "Запретить пересылку и копирование", on: quick.noCopy, hint: "Для обоих в этом чате") { [weak self] in
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    let next = !(self?.quick?.noCopy ?? false)
                    onNoCopy(next)
                    self?.note.text = next ? "Теперь копировать и пересылать сообщения этого чата нельзя обоим" : "Копирование и пересылка снова разрешены"
                })
            }
            let blockWords = blocked ? "Разблокировать" : confirmBlock ? "Нажми ещё раз, чтобы заблокировать" : "Заблокировать"
            group.addArrangedSubview(row(blocked ? "hand.raised" : "minus.circle", blockWords, danger: !blocked) { [weak self] in self?.blockPressed() })
            rows.addArrangedSubview(group)
            note.font = .systemFont(ofSize: 13)
            note.textColor = Theme.muted
            note.textAlignment = .center
            note.numberOfLines = 0
            rows.addArrangedSubview(note)
            if let onOpenProfile { rows.addArrangedSubview(actionButton("person.crop.circle", "Открыть профиль", primary: false, action: onOpenProfile)) }
            return
        }
        let line = UIStackView()
        line.axis = .horizontal
        line.spacing = 8
        line.distribution = .fillEqually
        if !me, let onWrite { line.addArrangedSubview(actionButton("bubble.left", "Написать", primary: true, action: onWrite)) }
        if let onOpenProfile { line.addArrangedSubview(actionButton("person.crop.circle", "Профиль", primary: me || onWrite == nil, action: onOpenProfile)) }
        if !line.arrangedSubviews.isEmpty { rows.addArrangedSubview(line) }
    }

    private func toggleFriend() {
        guard let messenger, let friend = isFriend, !busy else { return }
        busy = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let finish: (ServerError?, String, () -> Void) -> Void = { [weak self] (error: ServerError?, words: String, apply: () -> Void) -> Void in
            guard let self else { return }
            self.busy = false
            if let error { self.note.text = error.words } else { apply(); self.note.text = words; FriendRequests.shared.refresh() }
            self.buildRows()
        }
        if friend {
            messenger.removeFriend(person.id) { [weak self] (error: ServerError?) -> Void in finish(error, "Удалён из друзей") { self?.isFriend = false } }
        } else if request == "outgoing" {
            messenger.dropFriendRequest(person.id) { [weak self] (error: ServerError?) -> Void in finish(error, "Заявка отменена") { self?.request = nil } }
        } else if request == "incoming" {
            messenger.acceptFriend(person.id) { [weak self] (error: ServerError?) -> Void in finish(error, "Теперь вы друзья") { self?.request = nil; self?.isFriend = true } }
        } else {
            messenger.addFriend(person.id) { [weak self] (result: Result<Bool, ServerError>) -> Void in
                switch result {
                case .failure(let error): finish(error, "") { }
                case .success(let friends): finish(nil, friends ? "Теперь вы друзья" : "Заявка отправлена") { if friends { self?.isFriend = true } else { self?.request = "outgoing" } }
                }
            }
        }
    }

    private func blockPressed() {
        guard let messenger, !busy else { return }
        if !blocked && !confirmBlock {
            confirmBlock = true
            buildRows()
            return
        }
        confirmBlock = false
        busy = true
        let block = !blocked
        messenger.setPersonBlocked(person.id, block) { [weak self] (error: ServerError?) -> Void in
            guard let self else { return }
            self.busy = false
            if let error {
                self.note.text = error.words
            } else {
                self.blocked = block
                if block { self.isFriend = false; self.request = nil; FriendRequests.shared.refresh() }
                self.note.text = block ? "Заблокирован: он не сможет писать и звонить" : "Разблокирован"
            }
            self.buildRows()
        }
    }

    @objc private func openProfilePressed() {
        guard let onOpenProfile else { return }
        dismissThen(onOpenProfile)
    }

    private func dismissThen(_ action: @escaping () -> Void) {
        UIView.animate(withDuration: 0.2, animations: {
            self.card.transform = CGAffineTransform(translationX: 0, y: self.card.bounds.height + 40)
            self.dimView.alpha = 0
        }, completion: { (_: Bool) -> Void in self.dismiss(animated: false) { action() } })
    }

    @objc private func close() { dismissThen { } }

    @objc private func pulled(_ gesture: UIPanGestureRecognizer) {
        let moved = max(0, gesture.translation(in: view).y)
        switch gesture.state {
        case .changed:
            card.transform = CGAffineTransform(translationX: 0, y: moved)
            dimView.alpha = 1 - min(1, moved / max(1, card.bounds.height))
        case .ended, .cancelled:
            if moved > card.bounds.height * 0.3 || gesture.velocity(in: view).y > 900 { close() } else {
                UIView.animate(withDuration: 0.25) {
                    self.card.transform = .identity
                    self.dimView.alpha = 1
                }
            }
        default:
            break
        }
    }
}
