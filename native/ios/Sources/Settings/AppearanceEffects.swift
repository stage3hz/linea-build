import UIKit

/// Effects: the parts of «Оформление» that belong to the effects — «Иконка приложения» and the switches of
/// «Пиксельный след», «Снег» and «Ледяное стекло». (The previous app: `AppIconPicker.tsx` and `Appearance` of
/// `mobile/src/SettingsScreen.tsx`, word for word.) Kept on this device only.
extension AppearanceViewController {
    /// «Иконка приложения» (before «Свои цвета», as in the reference).
    func addIconGroup() {
        addGroup("Иконка приложения", rows: [AppIconPicker()])
    }

    /// The three switches (after «Свои цвета»).
    func addEffectGroups() {
        let trail = SettingsSwitchRow(label: "Пиксельный след", words: "Сетка пикселей подсвечивается под пальцем и курсором: белая в тёмной теме, чёрная в светлой", value: DevicePreferences.flag("pixelTrail") ?? true)
        trail.onChange = { (on: Bool) -> Void in DevicePreferences.set(["pixelTrail": on]) }
        addGroup(rows: [trail])
        let snow = SettingsSwitchRow(label: "Снег", words: "Снег падает на фоне экрана, за кнопками и панелями", value: DevicePreferences.flag("snow") ?? true)
        snow.onChange = { (on: Bool) -> Void in DevicePreferences.set(["snow": on]) }
        addGroup(rows: [snow])
        let ice = SettingsSwitchRow(label: "Ледяное стекло", words: "Иней по кромке стеклянных кнопок, панелей и карточек; тает, когда телефон нагревается", value: DevicePreferences.flag("ice") ?? true)
        ice.onChange = { (on: Bool) -> Void in DevicePreferences.set(["ice": on]) }
        addGroup(rows: [ice])
    }
}

/// The app's icon: four pictures side by side, the chosen one in a ring of the accent colour. «Синяя» is this app's
/// own icon; the others are alternate icons of the asset catalog (`AppIcon-Outline`, `AppIcon-Light`,
/// `AppIcon-Aurora`, see project.yml). The pictures are the reference's `mobile/assets/icons/*.png`.
final class AppIconPicker: UIView {
    struct Icon { let id: String?; let label: String; let preview: String }
    static let icons: [Icon] = [
        Icon(id: "AppIcon-Outline", label: "Контур", preview: "IconPreviewOutline"),
        Icon(id: nil, label: "Синяя", preview: "IconPreviewBlue"),
        Icon(id: "AppIcon-Light", label: "Светлая", preview: "IconPreviewLight"),
        Icon(id: "AppIcon-Aurora", label: "Сияние", preview: "IconPreviewAurora"),
    ]

    private let row = UIStackView()
    private let errorLabel = SettingsLook.words("", size: 12, color: Theme.danger)
    private var busy = false

    init() {
        super.init(frame: .zero)
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 10
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
        ])
        guard UIApplication.shared.supportsAlternateIcons else {
            column.addArrangedSubview(SettingsLook.words("Смена иконки недоступна на этом устройстве.", size: 12, color: Theme.muted))
            return
        }
        row.axis = .horizontal
        row.spacing = 12
        row.alignment = .top
        let holder = UIStackView(arrangedSubviews: [row, UIView()])
        holder.axis = .horizontal
        column.addArrangedSubview(holder)
        column.addArrangedSubview(SettingsLook.words("iOS покажет короткое уведомление о смене иконки.", size: 11, color: Theme.muted))
        errorLabel.isHidden = true
        column.addArrangedSubview(errorLabel)
        fill()
    }

    required init?(coder: NSCoder) { return nil }

    private func fill() {
        for old in row.arrangedSubviews {
            row.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        let current = UIApplication.shared.alternateIconName
        for icon in AppIconPicker.icons {
            let chosen = icon.id == current
            let tile = AppIconTile(icon: icon, chosen: chosen)
            tile.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.choose(icon) }, for: .touchUpInside)
            row.addArrangedSubview(tile)
        }
    }

    private func choose(_ icon: Icon) {
        guard !busy, icon.id != UIApplication.shared.alternateIconName else { return }
        busy = true
        errorLabel.isHidden = true
        UIApplication.shared.setAlternateIconName(icon.id) { [weak self] (error: Error?) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                if error != nil {
                    self.errorLabel.text = "Не удалось сменить иконку."
                    self.errorLabel.isHidden = false
                }
                self.fill()
            }
        }
    }
}

/// One icon: its picture (58 pt, rounded), a ring when chosen, its name under it.
final class AppIconTile: UIControl {
    init(icon: AppIconPicker.Icon, chosen: Bool) {
        super.init(frame: .zero)
        let ring = UIView()
        ring.layer.cornerRadius = 19
        ring.layer.cornerCurve = .continuous
        ring.layer.borderWidth = 2
        ring.layer.borderColor = (chosen ? Theme.accent : UIColor.clear).cgColor
        ring.isUserInteractionEnabled = false
        ring.translatesAutoresizingMaskIntoConstraints = false
        let picture = UIImageView(image: UIImage(named: icon.preview))
        picture.layer.cornerRadius = 15
        picture.layer.cornerCurve = .continuous
        picture.layer.masksToBounds = true
        picture.contentMode = .scaleAspectFill
        picture.translatesAutoresizingMaskIntoConstraints = false
        ring.addSubview(picture)
        let name = UILabel()
        name.text = icon.label
        name.font = .systemFont(ofSize: 11, weight: chosen ? .bold : .medium)
        name.textColor = chosen ? Theme.accent : Theme.muted
        name.textAlignment = .center
        name.translatesAutoresizingMaskIntoConstraints = false
        addSubview(ring)
        addSubview(name)
        NSLayoutConstraint.activate([
            ring.topAnchor.constraint(equalTo: topAnchor),
            ring.leadingAnchor.constraint(equalTo: leadingAnchor),
            ring.trailingAnchor.constraint(equalTo: trailingAnchor),
            ring.widthAnchor.constraint(equalToConstant: 68),
            ring.heightAnchor.constraint(equalToConstant: 68),
            picture.centerXAnchor.constraint(equalTo: ring.centerXAnchor),
            picture.centerYAnchor.constraint(equalTo: ring.centerYAnchor),
            picture.widthAnchor.constraint(equalToConstant: 58),
            picture.heightAnchor.constraint(equalToConstant: 58),
            name.topAnchor.constraint(equalTo: ring.bottomAnchor, constant: 6),
            name.leadingAnchor.constraint(equalTo: leadingAnchor, constant: -4),
            name.trailingAnchor.constraint(equalTo: trailingAnchor, constant: 4),
            name.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        isAccessibilityElement = true
        accessibilityTraits.insert(.button)
        if chosen { accessibilityTraits.insert(.selected) }
        accessibilityLabel = "Иконка «" + icon.label + "»"
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }
}
