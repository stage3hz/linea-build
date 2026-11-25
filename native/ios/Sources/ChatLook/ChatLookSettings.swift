import UIKit

/// What «Оформление» gets from ChatLook (the reference's SettingsScreen.tsx: «Свои цвета» › «Цвет своих
/// сообщений», «Обои чатов», «Углы сообщений»), and «Пузыри сообщений» — the owner's default is the open look
/// without bubbles; bubbles are a choice here (and come by themselves with a wallpaper, as in the reference).
enum ChatLookSettings {
    /// The row for the «Свои цвета» group.
    static func colourRow(page: SettingsPage) -> SettingsRow {
        let own = DevicePreferences.word("bubbleColor")
        let mine = ChatBubbleLook.palette(bubbles: true).mine
        let row = SettingsRow(label: "Цвет своих сообщений", value: own == nil ? "Как в теме" : "Свой", swatch: mine)
        // ColorSettings.tsx: a sheet over the page (Settings/ColorSheets.swift).
        row.onPress = { [weak page] in
            guard let page else { return }
            ColourSheets.present(.bubble, over: page)
        }
        return row
    }

    /// «Обои чатов», «Пузыри сообщений», «Углы сообщений». `refill`: the page draws itself again.
    static func addGroups(to page: SettingsPage, refill: @escaping () -> Void) {
        let paper = SettingsRow(symbol: "photo", label: "Обои чатов", value: "Выбрать")
        paper.onPress = { [weak page] in
            guard let page else { return }
            WallpaperPickerController.present(over: page, chatId: nil)
        }
        page.addGroup("Обои чатов", rows: [paper])

        let bubbles = SettingsSwitchRow(label: "Пузыри сообщений", words: "Свои и чужие сообщения на цветных плашках. С обоями они есть всегда.", value: ChatBubbleLook.bubblesChosen)
        bubbles.onChange = { (value: Bool) -> Void in
            ChatBubbleLook.bubblesChosen = value
            refill()
        }
        let corners = CornerChoice(chosen: ChatBubbleLook.chosenRadius)
        corners.onPick = { (radius: CGFloat) -> Void in
            DevicePreferences.set(["bubbleRadius": Double(radius)])
            refill()
        }
        page.addGroup("Углы сообщений", rows: [bubbles, SettingsLook.inset(corners, top: 12, side: 14, bottom: 14)])
    }
}

/// «Углы сообщений»: «Острые», «Средние», «Круглые», each with a small bubble drawn with its corners.
final class CornerChoice: UIView {
    var onPick: ((CGFloat) -> Void)?
    private let choices: [(CGFloat, String)] = [(8, "Острые"), (14, "Средние"), (20, "Круглые")]

    init(chosen: CGFloat) {
        super.init(frame: .zero)
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 7
        row.distribution = .fillEqually
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        let bubble = ChatBubbleLook.palette(bubbles: true).mine
        for (index, choice) in choices.enumerated() {
            let selected = choice.0 == chosen
            let button = UIControl()
            button.tag = index
            button.backgroundColor = selected ? ThemeStore.look.accentSoft : Theme.surface2
            button.layer.cornerRadius = 15
            button.layer.cornerCurve = .continuous
            button.layer.borderWidth = 1
            button.layer.borderColor = (selected ? Theme.accent : ThemeStore.look.border).cgColor
            button.accessibilityLabel = choice.1
            button.accessibilityTraits = selected ? [.button, .selected] : [.button]
            let sample = CornerSample(radius: choice.0, color: bubble)
            sample.isUserInteractionEnabled = false
            sample.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(sample)
            let label = UILabel()
            label.text = choice.1
            label.font = .systemFont(ofSize: 12, weight: .semibold)
            label.textColor = selected ? Theme.accent : Theme.text
            label.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(label)
            NSLayoutConstraint.activate([
                sample.topAnchor.constraint(equalTo: button.topAnchor, constant: 10),
                sample.centerXAnchor.constraint(equalTo: button.centerXAnchor),
                sample.widthAnchor.constraint(equalToConstant: 46),
                sample.heightAnchor.constraint(equalToConstant: 22),
                label.topAnchor.constraint(equalTo: sample.bottomAnchor, constant: 8),
                label.centerXAnchor.constraint(equalTo: button.centerXAnchor),
                label.bottomAnchor.constraint(equalTo: button.bottomAnchor, constant: -10),
            ])
            button.addTarget(self, action: #selector(picked(_:)), for: .touchUpInside)
            row.addArrangedSubview(button)
        }
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func picked(_ sender: UIControl) {
        guard sender.tag >= 0, sender.tag < choices.count else { return }
        Haptic.tap()
        onPick?(choices[sender.tag].0)
    }
}

/// A small bubble with given corners (the lower right one 6 at most, as on one's own last message).
private final class CornerSample: UIView {
    private let radius: CGFloat
    private let color: UIColor

    init(radius: CGFloat, color: UIColor) {
        self.radius = radius
        self.color = color
        super.init(frame: .zero)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { return nil }

    override func draw(_ rect: CGRect) {
        let kept = ChatBubbleLook.radius
        ChatBubbleLook.radius = radius
        let path = ChatBubbleLook.shape(bounds, mine: true, tail: true)
        ChatBubbleLook.radius = kept
        color.setFill()
        path.fill()
    }
}
