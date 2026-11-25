import UIKit

/// The top of the profile editor (the reference's ProfileScreen.tsx editing): the banner tile and the avatar, each
/// with a camera badge, tapped to change; «Изменить фотографию» and «Фото, GIF или видео до 10 секунд».
enum ProfileEditMedia {
    static func top(banner: UIControl, art: ProfileBannerView, avatar: DecoratedAvatarView, words: UIButton) -> UIView {
        let box = UIView()
        banner.backgroundColor = Theme.surface2
        banner.layer.cornerRadius = 24
        banner.layer.cornerCurve = .continuous
        banner.clipsToBounds = true
        banner.accessibilityLabel = "Изменить баннер"
        banner.translatesAutoresizingMaskIntoConstraints = false
        let placeholderIcon = UIImageView(image: IonIcon.image("image-outline", size: 24)) // Ionicons «image-outline» 24
        placeholderIcon.tintColor = Theme.muted
        let placeholderWords = SettingsLook.words("Баннер", size: 13, color: Theme.muted)
        let placeholder = UIStackView(arrangedSubviews: [placeholderIcon, placeholderWords])
        placeholder.axis = .vertical
        placeholder.alignment = .center
        placeholder.spacing = 4
        placeholder.isUserInteractionEnabled = false
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        banner.addSubview(placeholder)
        art.isUserInteractionEnabled = false
        art.translatesAutoresizingMaskIntoConstraints = false
        banner.addSubview(art)
        let bannerBadge = badge(size: 34, fill: UIColor(white: 0, alpha: 0.45), tint: .white, border: nil)
        banner.addSubview(bannerBadge)
        box.addSubview(banner)

        let ring = UIView()
        ring.backgroundColor = Theme.bg
        ring.layer.cornerRadius = 53
        ring.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(ring)
        avatar.translatesAutoresizingMaskIntoConstraints = false
        avatar.accessibilityLabel = "Изменить фото профиля"
        avatar.ringBackground = Theme.bg
        ring.addSubview(avatar)
        let avatarBadge = badge(size: 32, fill: Theme.accent, tint: Theme.onAccent, border: Theme.bg)
        ring.addSubview(avatarBadge)

        words.setTitle("Изменить фотографию", for: .normal)
        words.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        words.tintColor = Theme.accent
        words.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(words)
        let hint = SettingsLook.words("Фото, GIF или видео до 10 секунд", size: 12, color: Theme.muted)
        hint.textAlignment = .center
        hint.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(hint)
        NSLayoutConstraint.activate([
            banner.topAnchor.constraint(equalTo: box.topAnchor, constant: 4),
            banner.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            banner.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            banner.heightAnchor.constraint(equalToConstant: 150),
            placeholder.centerXAnchor.constraint(equalTo: banner.centerXAnchor),
            placeholder.centerYAnchor.constraint(equalTo: banner.centerYAnchor),
            art.topAnchor.constraint(equalTo: banner.topAnchor),
            art.bottomAnchor.constraint(equalTo: banner.bottomAnchor),
            art.leadingAnchor.constraint(equalTo: banner.leadingAnchor),
            art.trailingAnchor.constraint(equalTo: banner.trailingAnchor),
            bannerBadge.topAnchor.constraint(equalTo: banner.topAnchor, constant: 12),
            bannerBadge.trailingAnchor.constraint(equalTo: banner.trailingAnchor, constant: -12),
            ring.topAnchor.constraint(equalTo: banner.bottomAnchor, constant: -52),
            ring.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            ring.widthAnchor.constraint(equalToConstant: 106),
            ring.heightAnchor.constraint(equalToConstant: 106),
            avatar.centerXAnchor.constraint(equalTo: ring.centerXAnchor),
            avatar.centerYAnchor.constraint(equalTo: ring.centerYAnchor),
            avatar.widthAnchor.constraint(equalToConstant: 96),
            avatar.heightAnchor.constraint(equalToConstant: 96),
            avatarBadge.trailingAnchor.constraint(equalTo: ring.trailingAnchor, constant: -2),
            avatarBadge.bottomAnchor.constraint(equalTo: ring.bottomAnchor, constant: -2),
            words.topAnchor.constraint(equalTo: ring.bottomAnchor),
            words.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            hint.topAnchor.constraint(equalTo: words.bottomAnchor, constant: 0),
            hint.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            hint.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            hint.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -4),
        ])
        return box
    }

    private static func badge(size: CGFloat, fill: UIColor, tint: UIColor, border: UIColor?) -> UIView {
        let badge = UIImageView(image: IonIcon.image("camera-outline", size: size == 34 ? 18 : 16)) // «camera-outline» 18 on the banner, 16 on the avatar
        badge.tintColor = tint
        badge.backgroundColor = fill
        badge.contentMode = .center
        badge.layer.cornerRadius = size / 2
        if let border {
            badge.layer.borderWidth = 2
            badge.layer.borderColor = border.cgColor
        }
        badge.isUserInteractionEnabled = false
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.widthAnchor.constraint(equalToConstant: size).isActive = true
        badge.heightAnchor.constraint(equalToConstant: size).isActive = true
        return badge
    }

    /// A card around a part of the editor (the reference's glass card, `GlassSurface radius={22}`, padding 16).
    static func card(_ inner: UIView) -> UIView {
        let card = UIView()
        card.layer.cornerRadius = 22
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        let glass = UIVisualEffectView(effect: TabGlass.effect(clear: false, interactive: false, dark: Theme.dark))
        glass.isUserInteractionEnabled = false
        glass.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(glass)
        NSLayoutConstraint.activate([
            glass.topAnchor.constraint(equalTo: card.topAnchor),
            glass.bottomAnchor.constraint(equalTo: card.bottomAnchor),
            glass.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: card.trailingAnchor),
        ])
        inner.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
            inner.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16),
            inner.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            inner.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
        ])
        return card
    }
}

/// «Узор фона» (ProfileScreen.tsx): the emoji the background around the photo is strewn with, or none.
final class PatternPickerViewController: UIViewController {
    private var current: String?
    private let done: (String?) -> Void
    private var cells: [UIButton] = []

    init(current: String?, done: @escaping (String?) -> Void) {
        self.current = current
        self.done = done
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 28
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = Theme.dark ? .dark : .light
        view.backgroundColor = Theme.page(UIColor(hex: 0x141516))
        let heading = UILabel()
        heading.attributedText = Theme.titleWords("Узор фона", size: Theme.TypeSize.sheetTitle, color: Theme.text)
        let words = SettingsLook.words("Значок, которым усыпан фон вокруг твоего фото в профиле.", size: 13, color: Theme.muted)
        let grid = UIView()
        let options: [String?] = [nil] + AvatarCatalog.patterns.map { Optional($0) }
        let side: CGFloat = 48, gap: CGFloat = 8
        let columns = max(1, Int((min(UIScreen.main.bounds.width, 520) - 40 + gap) / (side + gap)))
        for (index, option) in options.enumerated() {
            let cell = UIButton(type: .custom)
            cell.backgroundColor = Theme.surface2
            cell.layer.cornerRadius = 14
            cell.layer.borderWidth = 2
            if let option {
                cell.setTitle(option, for: .normal)
                cell.titleLabel?.font = .systemFont(ofSize: 24)
                cell.accessibilityLabel = option
            } else {
                cell.setImage(IonIcon.image("close", size: 20), for: .normal)
                cell.tintColor = Theme.muted
                cell.accessibilityLabel = "Без узора"
            }
            cell.tag = index
            cell.frame = CGRect(x: CGFloat(index % columns) * (side + gap), y: CGFloat(index / columns) * (side + gap), width: side, height: side)
            cell.addAction(UIAction { [weak self] (_: UIAction) -> Void in
                self?.current = option
                self?.showChosen()
            }, for: .touchUpInside)
            grid.addSubview(cell)
            cells.append(cell)
        }
        let gridWidth = CGFloat(columns) * side + CGFloat(columns - 1) * gap
        let gridHeight = cells.last?.frame.maxY ?? 0
        grid.translatesAutoresizingMaskIntoConstraints = false
        let holder = UIView()
        holder.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: holder.topAnchor),
            grid.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            grid.centerXAnchor.constraint(equalTo: holder.centerXAnchor),
            grid.widthAnchor.constraint(equalToConstant: gridWidth),
            grid.heightAnchor.constraint(equalToConstant: gridHeight),
        ])
        let ready = SettingsButton(label: "Готово")
        ready.onPress = { [weak self] in
            guard let self else { return }
            let chosen = self.current
            let done = self.done
            self.dismiss(animated: true) { done(chosen) }
        }
        let stack = UIStackView(arrangedSubviews: [heading, words, holder, ready])
        stack.axis = .vertical
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40),
        ])
        showChosen()
    }

    private func showChosen() {
        let options: [String?] = [nil] + AvatarCatalog.patterns.map { Optional($0) }
        for cell in cells {
            let on = options[cell.tag] == current
            cell.layer.borderColor = on ? Theme.accent.cgColor : UIColor.clear.cgColor
            cell.accessibilityTraits = on ? [.button, .selected] : [.button]
        }
    }
}
