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
        row.onPress = { [weak page] in page?.open(BubbleColorViewController()) }
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

/// «Цвет своих сообщений» (the reference's ColorSettings.tsx, part «bubble»): how it looks in a chat, the offered
/// colours, «Как в теме», «Свой цвет» with three sliders. It is seen in chats with bubbles.
final class BubbleColorViewController: SettingsPage {
    private static var custom = false
    private static var sliders: (h: Double, s: Double, v: Double)?
    private let hue = UISlider()
    private let saturation = UISlider()
    private let brightness = UISlider()
    private let code = UILabel()

    init() {
        super.init(name: "Цвет своих сообщений")
    }

    required init?(coder: NSCoder) { return nil }

    override func build() {
        fill()
    }

    private var choices: [String] { ThemeStore.words("bubbleChoices") }
    private var base: String { DevicePreferences.word("bubbleColor") ?? choices.first ?? "#2B4A8C" }

    private func set(_ color: String?) {
        var value: Any = NSNull()
        if let color { value = color }
        DevicePreferences.set(["bubbleColor": value])
        fill()
    }

    private func fill() {
        clear()
        let current = DevicePreferences.word("bubbleColor")
        let palette = ChatBubbleLook.palette(bubbles: true)

        // How it looks in a chat, in the colours that are on right now.
        let sample = UIStackView(arrangedSubviews: [
            plate("Как тебе новый цвет?", mine: false, palette: palette, foot: nil),
            plate("Нравится, оставляю", mine: true, palette: palette, foot: "ссылка · 12:30 ✓✓"),
        ])
        sample.axis = .vertical
        sample.spacing = 6
        sample.isAccessibilityElement = false

        let rowsOfColours = UIStackView()
        rowsOfColours.axis = .vertical
        rowsOfColours.spacing = 10
        var line = UIStackView()
        for (index, color) in choices.enumerated() {
            if index % 6 == 0 {
                line = UIStackView()
                line.axis = .horizontal
                line.distribution = .equalSpacing
                rowsOfColours.addArrangedSubview(line)
            }
            let on = current == color
            let ball = UIButton(type: .custom)
            ball.backgroundColor = ThemeLook.color(color) ?? UIColor.gray
            ball.layer.cornerRadius = 20
            ball.layer.borderWidth = on ? 3 : 0
            ball.layer.borderColor = Theme.text.cgColor
            if on {
                ball.setImage(SettingsLook.symbol("checkmark", size: 15, weight: .bold), for: .normal)
                ball.tintColor = UIColor.white
                ball.accessibilityTraits.insert(.selected)
            }
            ball.tag = index
            ball.accessibilityLabel = "Цвет " + color
            ball.translatesAutoresizingMaskIntoConstraints = false
            ball.widthAnchor.constraint(equalToConstant: 40).isActive = true
            ball.heightAnchor.constraint(equalToConstant: 40).isActive = true
            ball.addTarget(self, action: #selector(picked(_:)), for: .touchUpInside)
            line.addArrangedSubview(ball)
        }

        let asTheme = SettingsButton(label: "Как в теме", kind: current == nil ? .primary : .secondary)
        asTheme.onPress = { [weak self] in
            BubbleColorViewController.custom = false
            self?.set(nil)
        }
        let ownColour = SettingsButton(label: "Свой цвет", kind: BubbleColorViewController.custom ? .primary : .secondary)
        ownColour.onPress = { [weak self] in self?.toggleCustom() }
        let buttons = UIStackView(arrangedSubviews: [asTheme, ownColour])
        buttons.axis = .horizontal
        buttons.distribution = .fillEqually
        buttons.spacing = 8

        let box = UIStackView(arrangedSubviews: [sample, rowsOfColours, buttons])
        box.axis = .vertical
        box.spacing = 16
        if BubbleColorViewController.custom {
            let position = BubbleColorViewController.sliders ?? hsv(of: base)
            hue.minimumValue = 0
            hue.maximumValue = 359.9
            hue.value = Float(position.h)
            saturation.minimumValue = 0
            saturation.maximumValue = 1
            saturation.value = Float(position.s)
            brightness.minimumValue = 0.12
            brightness.maximumValue = 1
            brightness.value = Float(position.v)
            let named: [(String, UISlider)] = [("Оттенок", hue), ("Насыщенность", saturation), ("Яркость", brightness)]
            for (name, slider) in named {
                slider.minimumTrackTintColor = Theme.accent
                slider.accessibilityLabel = name
                slider.removeTarget(self, action: nil, for: .allEvents)
                slider.addTarget(self, action: #selector(moved), for: .valueChanged)
                slider.addTarget(self, action: #selector(released), for: [.touchUpInside, .touchUpOutside, .touchCancel])
                let part = UIStackView(arrangedSubviews: [SettingsLook.words(name, size: 12, color: Theme.muted), slider])
                part.axis = .vertical
                part.spacing = 2
                box.addArrangedSubview(part)
            }
            code.text = current ?? base
            code.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            code.textColor = Theme.muted
            code.textAlignment = .center
            box.addArrangedSubview(code)
        }
        addGroup(rows: [SettingsLook.inset(box, top: 16, side: 16, bottom: 16)])
        add(SettingsLook.foot("Цвет действует поверх любой темы. Если он плохо читается на её фоне, приложение слегка сдвигает его, чтобы текст оставался разборчивым."), gap: 10)
        if !ChatBubbleLook.bubblesChosen {
            add(SettingsLook.foot("Цвет виден в чатах с пузырями: включи «Пузыри сообщений» или выбери обои."), gap: 6)
        }
    }

    private func plate(_ text: String, mine: Bool, palette: MsgPalette, foot: String?) -> UIView {
        let row = UIView()
        let box = UIStackView()
        box.axis = .vertical
        box.spacing = 2
        box.isLayoutMarginsRelativeArrangement = true
        box.layoutMargins = UIEdgeInsets(top: 8, left: 13, bottom: 8, right: 13)
        box.backgroundColor = mine ? palette.mine : palette.theirs
        box.layer.cornerRadius = 18
        box.layer.cornerCurve = .continuous
        box.addArrangedSubview(SettingsLook.words(text, size: 15, color: Theme.text))
        if let foot { box.addArrangedSubview(SettingsLook.words(foot, size: 13, color: palette.mineMark)) }
        box.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(box)
        NSLayoutConstraint.activate([
            box.topAnchor.constraint(equalTo: row.topAnchor),
            box.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            box.widthAnchor.constraint(lessThanOrEqualTo: row.widthAnchor, multiplier: 0.78),
            mine ? box.trailingAnchor.constraint(equalTo: row.trailingAnchor) : box.leadingAnchor.constraint(equalTo: row.leadingAnchor),
        ])
        return row
    }

    private func hsv(of color: String) -> (h: Double, s: Double, v: Double) {
        let read = Core.view("settingsColorHsv", [color]) as? [String: Any] ?? [:]
        let part = { (name: String) -> Double in return (read[name] as? NSNumber)?.doubleValue ?? 0 }
        return (part("h"), part("s"), part("v"))
    }

    private func colourOfSliders() -> String? {
        let args: [Any] = [Double(hue.value), Double(saturation.value), Double(brightness.value)]
        return Core.view("settingsHsvColor", args) as? String
    }

    @objc private func picked(_ sender: UIButton) {
        let list = choices
        guard sender.tag >= 0, sender.tag < list.count else { return }
        BubbleColorViewController.custom = false
        set(list[sender.tag])
    }

    private func toggleCustom() {
        BubbleColorViewController.sliders = hsv(of: base)
        BubbleColorViewController.custom.toggle()
        if BubbleColorViewController.custom && DevicePreferences.word("bubbleColor") == nil {
            set(base)
        } else {
            fill()
        }
    }

    /// While a slider moves only the code of the colour follows; the colour is put on when the finger lets go.
    @objc private func moved() {
        BubbleColorViewController.sliders = (Double(hue.value), Double(saturation.value), Double(brightness.value))
        if let color = colourOfSliders() { code.text = color }
    }

    @objc private func released() {
        BubbleColorViewController.sliders = (Double(hue.value), Double(saturation.value), Double(brightness.value))
        guard let color = colourOfSliders() else { return }
        set(color)
    }
}
