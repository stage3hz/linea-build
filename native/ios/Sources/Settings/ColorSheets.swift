import UIKit

/// «Свои цвета» of «Оформление» (the previous app: `mobile/src/ColorSettings.tsx`): «Цвет интерфейса» and «Цвет
/// своих сообщений» are sheets over the page, not pages of their own — how the colour looks in a chat, the offered
/// colours, «Как в теме», «Свой цвет» with three sliders, and a few words. The choice is put on at once.
enum ColourSheets {
    enum Part {
        case accent
        case bubble
    }

    static func title(_ part: Part) -> String {
        return part == .accent ? "Цвет интерфейса" : "Цвет своих сообщений"
    }

    /// Opens the sheet over a page of the settings.
    static func present(_ part: Part, over host: UIViewController, animated: Bool = true) {
        guard host.presentedViewController == nil else { return }
        let body = ColourSheetBody(part: part)
        let sheet = ChoiceSheet(heading: title(part), parts: [body], gap: 16)
        body.sheet = sheet
        body.host = host
        host.present(sheet, animated: animated)
    }
}

/// What a colour's sheet holds. It draws itself again after every choice; a new colour of the interface draws the
/// whole app again, and the sheet is then put back over the new «Оформление».
final class ColourSheetBody: UIView {
    /// «Свой цвет» is open, and where its sliders stand (a grey has no hue of its own: the slider must not jump).
    private static var custom: [ColourSheets.Part: Bool] = [:]
    private static var sliders: [ColourSheets.Part: (h: Double, s: Double, v: Double)] = [:]

    private let part: ColourSheets.Part
    private let box = UIStackView()
    private let hue = UISlider()
    private let saturation = UISlider()
    private let brightness = UISlider()
    private let code = UILabel()
    weak var sheet: ChoiceSheet?
    weak var host: UIViewController?

    init(part: ColourSheets.Part) {
        self.part = part
        super.init(frame: .zero)
        box.axis = .vertical
        box.spacing = 16
        box.translatesAutoresizingMaskIntoConstraints = false
        addSubview(box)
        NSLayoutConstraint.activate([
            box.topAnchor.constraint(equalTo: topAnchor),
            // ColorSettings.tsx: 6 under the last words.
            box.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            box.leadingAnchor.constraint(equalTo: leadingAnchor),
            box.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        fill()
    }

    required init?(coder: NSCoder) { return nil }

    private var key: String { return part == .accent ? "accentColor" : "bubbleColor" }
    private var choices: [String] { return ThemeStore.words(part == .accent ? "accentChoices" : "bubbleChoices") }
    private var base: String { return DevicePreferences.word(key) ?? choices.first ?? (part == .accent ? "#3568E7" : "#2B4A8C") }
    private var customOpen: Bool { return ColourSheetBody.custom[part] ?? false }

    private func set(_ color: String?) {
        var value: Any = NSNull()
        if let color { value = color }
        DevicePreferences.set([key: value])
        guard part == .accent else {
            fill()
            sheet?.view.setNeedsLayout()
            (host as? AppearanceViewController)?.refill()
            return
        }
        // A new colour of the interface draws the whole app again: the sheet is taken down first and put back over
        // «Оформление» as it stands afterwards (the same page when nothing had to be redrawn).
        let window = self.window ?? host?.view.window
        let page = host
        sheet?.dismiss(animated: false, completion: nil)
        let redrawn = ThemeStore.refresh(reopen: ["appearance"])
        DispatchQueue.main.async {
            if redrawn {
                guard let stack = window?.rootViewController as? NavigationController, let top = stack.topViewController else { return }
                ColourSheets.present(.accent, over: top, animated: false)
            } else if let page {
                (page as? AppearanceViewController)?.refill()
                ColourSheets.present(.accent, over: page, animated: false)
            }
        }
    }

    private func fill() {
        for old in box.arrangedSubviews {
            box.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        let current = DevicePreferences.word(key)
        let palette = ChatBubbleLook.palette(bubbles: true)

        // How it looks in a chat, in the colours that are on right now: the other side's words, one's own with a link
        // and the marks, and a button — on the chat's ground, 12 inside, radius 18.
        let sampleButton = UILabel()
        sampleButton.text = "Кнопка"
        sampleButton.font = .systemFont(ofSize: 14, weight: .bold)
        sampleButton.textColor = Theme.onAccent
        sampleButton.textAlignment = .center
        let buttonPlate = SettingsLook.inset(sampleButton, top: 0, side: 18, bottom: 0)
        buttonPlate.backgroundColor = Theme.accent
        buttonPlate.layer.cornerRadius = 18
        buttonPlate.translatesAutoresizingMaskIntoConstraints = false
        buttonPlate.heightAnchor.constraint(equalToConstant: 36).isActive = true
        let buttonRow = UIView()
        buttonRow.addSubview(buttonPlate)
        NSLayoutConstraint.activate([
            buttonPlate.topAnchor.constraint(equalTo: buttonRow.topAnchor, constant: 4),
            buttonPlate.bottomAnchor.constraint(equalTo: buttonRow.bottomAnchor),
            buttonPlate.centerXAnchor.constraint(equalTo: buttonRow.centerXAnchor),
        ])
        let sample = UIStackView(arrangedSubviews: [
            plate("Как тебе новый цвет?", mine: false, palette: palette, foot: nil),
            plate("Нравится, оставляю", mine: true, palette: palette, foot: "ссылка · 12:30 ✓✓"),
            buttonRow,
        ])
        sample.axis = .vertical
        sample.spacing = 6
        sample.isAccessibilityElement = false
        let ground = SettingsLook.inset(sample, top: 12, side: 12, bottom: 12)
        ground.backgroundColor = Theme.bg
        ground.layer.cornerRadius = 18
        ground.layer.cornerCurve = .continuous
        ground.layer.borderWidth = 1
        ground.layer.borderColor = ThemeStore.look.border.cgColor
        box.addArrangedSubview(ground)

        // The colours offered before «Свой цвет»: round ones of 44, 10 apart, six to a row, in the middle.
        let rowsOfColours = UIStackView()
        rowsOfColours.axis = .vertical
        rowsOfColours.alignment = .center
        rowsOfColours.spacing = 10
        var line = UIStackView()
        for (index, color) in choices.enumerated() {
            if index % 6 == 0 {
                line = UIStackView()
                line.axis = .horizontal
                line.spacing = 10
                rowsOfColours.addArrangedSubview(line)
            }
            let on = current == color
            let ball = UIButton(type: .custom)
            ball.backgroundColor = ThemeLook.color(color) ?? UIColor.gray
            ball.layer.cornerRadius = 22
            ball.layer.borderWidth = on ? 3 : 0
            ball.layer.borderColor = Theme.text.cgColor
            if on {
                ball.setImage(SettingsLook.symbol("ion:checkmark", size: 20), for: .normal)
                ball.tintColor = UIColor.white
                ball.accessibilityTraits.insert(.selected)
            }
            ball.tag = index
            ball.accessibilityLabel = "Цвет " + color
            ball.translatesAutoresizingMaskIntoConstraints = false
            ball.widthAnchor.constraint(equalToConstant: 44).isActive = true
            ball.heightAnchor.constraint(equalToConstant: 44).isActive = true
            ball.addTarget(self, action: #selector(picked(_:)), for: .touchUpInside)
            line.addArrangedSubview(ball)
        }
        box.addArrangedSubview(rowsOfColours)

        let asTheme = ColorChoiceButton(label: "Как в теме", on: current == nil)
        asTheme.onPress = { [weak self] in
            guard let self else { return }
            ColourSheetBody.custom[self.part] = false
            self.set(nil)
        }
        let ownColour = ColorChoiceButton(label: "Свой цвет", on: customOpen)
        ownColour.onPress = { [weak self] in self?.toggleCustom() }
        let buttons = UIStackView(arrangedSubviews: [asTheme, ownColour])
        buttons.axis = .horizontal
        buttons.distribution = .fillEqually
        buttons.spacing = 8
        box.addArrangedSubview(buttons)

        if customOpen {
            let position = ColourSheetBody.sliders[part] ?? hsv(of: base)
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
                let group = UIStackView(arrangedSubviews: [SettingsLook.words(name, size: 12, color: Theme.muted), slider])
                group.axis = .vertical
                group.spacing = 2
                box.addArrangedSubview(group)
            }
            code.text = current ?? base
            code.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            code.textColor = Theme.muted
            code.textAlignment = .center
            box.addArrangedSubview(code)
        }

        box.addArrangedSubview(SettingsLook.para("Цвет действует поверх любой темы. Если он плохо читается на её фоне, приложение слегка сдвигает его, чтобы текст оставался разборчивым.", size: 12, color: Theme.muted, line: 17))
        if part == .bubble && !ChatBubbleLook.bubblesChosen {
            box.addArrangedSubview(SettingsLook.para("Цвет виден в чатах с пузырями: включи «Пузыри сообщений» или выбери обои.", size: 12, color: Theme.muted, line: 17))
        }
    }

    /// A sample message: 13 at the sides and 8 above and below the words, radius 18, at most 78 % of the row.
    private func plate(_ text: String, mine: Bool, palette: MsgPalette, foot: String?) -> UIView {
        let row = UIView()
        let words = UIStackView()
        words.axis = .vertical
        words.spacing = 2
        words.isLayoutMarginsRelativeArrangement = true
        words.layoutMargins = UIEdgeInsets(top: 8, left: 13, bottom: 8, right: 13)
        words.backgroundColor = mine ? palette.mine : palette.theirs
        words.layer.cornerRadius = 18
        words.layer.cornerCurve = .continuous
        words.addArrangedSubview(SettingsLook.words(text, size: 15, color: Theme.text))
        if let foot { words.addArrangedSubview(SettingsLook.words(foot, size: 13, color: Theme.accent)) }
        words.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(words)
        NSLayoutConstraint.activate([
            words.topAnchor.constraint(equalTo: row.topAnchor),
            words.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            words.widthAnchor.constraint(lessThanOrEqualTo: row.widthAnchor, multiplier: 0.78),
            mine ? words.trailingAnchor.constraint(equalTo: row.trailingAnchor) : words.leadingAnchor.constraint(equalTo: row.leadingAnchor),
        ])
        return row
    }

    private func hsv(of color: String) -> (h: Double, s: Double, v: Double) {
        let read = Core.view("settingsColorHsv", [color]) as? [String: Any] ?? [:]
        let value = { (name: String) -> Double in return (read[name] as? NSNumber)?.doubleValue ?? 0 }
        return (value("h"), value("s"), value("v"))
    }

    private func colourOfSliders() -> String? {
        let args: [Any] = [Double(hue.value), Double(saturation.value), Double(brightness.value)]
        return Core.view("settingsHsvColor", args) as? String
    }

    @objc private func picked(_ sender: UIButton) {
        let list = choices
        guard sender.tag >= 0, sender.tag < list.count else { return }
        ColourSheetBody.custom[part] = false
        set(list[sender.tag])
    }

    private func toggleCustom() {
        ColourSheetBody.sliders[part] = hsv(of: base)
        ColourSheetBody.custom[part] = !customOpen
        if customOpen && DevicePreferences.word(key) == nil {
            set(base)
        } else {
            fill()
            sheet?.view.setNeedsLayout()
        }
    }

    /// While a slider moves only the code of the colour follows; the colour is put on when the finger lets go.
    @objc private func moved() {
        ColourSheetBody.sliders[part] = (Double(hue.value), Double(saturation.value), Double(brightness.value))
        if let color = colourOfSliders() { code.text = color }
    }

    @objc private func released() {
        ColourSheetBody.sliders[part] = (Double(hue.value), Double(saturation.value), Double(brightness.value))
        guard let color = colourOfSliders() else { return }
        set(color)
    }
}
