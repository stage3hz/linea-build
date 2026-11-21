import UIKit

/// «Энергосбережение и анимации»: the power-saving slider (Выкл. … «При заряде менее N%» … Вкл.), then the heavy
/// processes and «Анимации интерфейса». (The previous app: `MotionSettings` and `PowerRow` of
/// `mobile/src/SettingsScreen.tsx`; the rules: Effects/Motion.swift.) Kept on this device only.
final class PowerSettingsViewController: SettingsPage {
    /// 0, 0.05 … 0.95, 1 (POWER_STEPS).
    static let steps: [Double] = [0] + (1...19).map { (i: Int) -> Double in Double(i) / 20 } + [1]

    private var slider: PowerSlider?
    private var stateLabel: UILabel?
    private var valueLabel: UILabel?
    private var footLabel: UILabel?
    private var reasonLabel: UILabel?

    init() {
        super.init(name: "Энергосбережение")
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(self, selector: #selector(refreshWords), name: Motion.changed, object: nil)
    }

    private static func index(of level: Double) -> Int {
        return steps.firstIndex(where: { (step: Double) -> Bool in abs(step - level) < 0.026 }) ?? 0
    }

    override func build() {
        Motion.start()
        let state = SettingsLook.words("", size: 12, color: Theme.muted)
        stateLabel = state
        let off = SettingsLook.words("Выкл.", size: 13, color: Theme.muted)
        let on = SettingsLook.words("Вкл.", size: 13, color: Theme.muted)
        let value = SettingsLook.words("", size: 15, color: Theme.text, weight: .semibold)
        value.textAlignment = .center
        valueLabel = value
        off.setContentHuggingPriority(.required, for: .horizontal)
        on.setContentHuggingPriority(.required, for: .horizontal)
        let ends = UIStackView(arrangedSubviews: [off, value, on])
        ends.axis = .horizontal
        ends.alignment = .center
        let track = PowerSlider(count: PowerSettingsViewController.steps.count, chosen: PowerSettingsViewController.index(of: Motion.threshold))
        track.onPick = { [weak self] (index: Int) -> Void in
            let level = PowerSettingsViewController.steps[index]
            if abs(level - Motion.threshold) > 0.001 { DevicePreferences.set(["lowBattery": level]) }
            self?.refreshWords()
        }
        slider = track
        let foot = SettingsLook.words("", size: 12, color: Theme.muted)
        footLabel = foot
        let top = UIStackView(arrangedSubviews: [state, ends, track, foot])
        top.axis = .vertical
        top.spacing = 10

        var rows: [UIView] = [SettingsLook.inset(top, top: 14, side: 14, bottom: 6)]
        let caption = UILabel()
        caption.attributedText = NSAttributedString(string: "РЕСУРСОЁМКИЕ ПРОЦЕССЫ", attributes: [.kern: 1.2, .font: UIFont.systemFont(ofSize: 11, weight: .bold), .foregroundColor: Theme.muted])
        rows.append(SettingsLook.inset(caption, top: 14, side: 14, bottom: 0))
        let items: [(String, String, String, String)] = [
            ("autoplayVideo", "video", "Автозапуск видео", "Кружки и видео в чатах сами играют без звука, видео-аватары двигаются."),
            ("autoplayGif", "photo.on.rectangle", "Автозапуск GIF", "GIF в чатах, на аватарах и баннерах проигрываются сами."),
            ("animatedStickers", "face.smiling", "Анимированные стикеры", "Большие эмодзи в сообщениях двигаются."),
            ("animatedEmoji", "sparkles", "Анимированные эмодзи", "Эмодзи-статусы рядом с именем двигаются."),
        ]
        for item in items {
            let key = item.0
            let row = PowerRow(symbol: item.1, title: item.2, text: item.3, value: DevicePreferences.flag(key) ?? true)
            row.onChange = { (on: Bool) -> Void in DevicePreferences.set([key: on]) }
            rows.append(row)
        }
        let animations = PowerRow(symbol: "wand.and.stars", title: "Анимации интерфейса", text: "Плавные переходы, рамки и эффекты профиля.", value: Motion.mode != "off")
        animations.onChange = { (on: Bool) -> Void in DevicePreferences.set(["animations": on ? "auto" : "off"]) }
        rows.append(animations)
        let reason = SettingsLook.words("", size: 12, color: Theme.muted)
        reasonLabel = reason
        rows.append(SettingsLook.inset(reason, top: 6, side: 14, bottom: 10))
        let card = UIStackView(arrangedSubviews: rows)
        card.axis = .vertical
        let holder = UIView()
        holder.backgroundColor = SettingsLook.card
        holder.layer.cornerRadius = 12
        holder.layer.cornerCurve = .continuous
        holder.layer.borderWidth = 0.5
        holder.layer.borderColor = SettingsLook.line.cgColor
        card.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(card)
        NSLayoutConstraint.activate([
            card.topAnchor.constraint(equalTo: holder.topAnchor),
            card.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            card.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
            card.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
        ])
        add(holder, gap: 16)
        refreshWords()
    }

    @objc private func refreshWords() {
        let level = PowerSettingsViewController.steps[PowerSettingsViewController.index(of: Motion.threshold)]
        let percent = Motion.percent(level)
        stateLabel?.text = "Режим энергосбережения (" + (Motion.saving ? "вкл." : "выкл.") + ")"
        let label = level <= 0 ? "Выключен" : (level >= 1 ? "Включён всегда" : "При заряде менее \(percent)%")
        valueLabel?.text = label
        slider?.accessibilityValue = label
        var foot = ""
        if level <= 0 {
            foot = "Не включается сам по заряду (только в системном режиме энергосбережения)."
        } else if level >= 1 {
            foot = "Все ресурсоёмкие процессы выключены."
        } else {
            var now = ""
            if let battery = Motion.power.level { now = " (сейчас \(Motion.percent(battery))%)" }
            foot = "Автоматически отключать все ресурсоёмкие процессы при заряде менее \(percent)%" + now + "."
        }
        footLabel?.text = foot
        reasonLabel?.text = Motion.reason
    }
}

/// The slider of steps: a thin track filled up to the chosen step and a white round knob; dragging and tapping
/// choose the nearest step, VoiceOver steps by one.
final class PowerSlider: UIControl {
    var onPick: ((Int) -> Void)?
    private let count: Int
    private(set) var chosen: Int
    private let track = UIView()
    private let fill = UIView()
    private let knob = UIView()

    init(count: Int, chosen: Int) {
        self.count = max(2, count)
        self.chosen = chosen
        super.init(frame: .zero)
        track.backgroundColor = ThemeStore.look.border
        track.layer.cornerRadius = 2
        track.isUserInteractionEnabled = false
        fill.backgroundColor = Theme.accent
        fill.layer.cornerRadius = 2
        fill.isUserInteractionEnabled = false
        knob.backgroundColor = .white
        knob.layer.cornerRadius = 14
        knob.layer.shadowColor = UIColor.black.cgColor
        knob.layer.shadowOpacity = 0.2
        knob.layer.shadowRadius = 4
        knob.layer.shadowOffset = CGSize(width: 0, height: 1)
        knob.isUserInteractionEnabled = false
        addSubview(track)
        track.addSubview(fill)
        addSubview(knob)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 34).isActive = true
        isAccessibilityElement = true
        accessibilityTraits = .adjustable
        accessibilityLabel = "Режим энергосбережения"
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        track.frame = CGRect(x: 0, y: bounds.midY - 2, width: width, height: 4)
        let share = CGFloat(chosen) / CGFloat(count - 1)
        fill.frame = CGRect(x: 0, y: 0, width: share * width, height: 4)
        knob.frame = CGRect(x: max(0, min(width - 28, share * width - 14)), y: bounds.midY - 14, width: 28, height: 28)
    }

    private func pick(at x: CGFloat) {
        let share = max(0, min(1, x / max(1, bounds.width)))
        let index = Int((share * CGFloat(count - 1)).rounded())
        set(index)
    }

    private func set(_ index: Int) {
        let next = max(0, min(count - 1, index))
        guard next != chosen else { return }
        chosen = next
        setNeedsLayout()
        UISelectionFeedbackGenerator().selectionChanged()
        onPick?(next)
    }

    override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        pick(at: touch.location(in: self).x)
        return true
    }

    override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        pick(at: touch.location(in: self).x)
        return true
    }

    override func accessibilityIncrement() { set(chosen + 1) }
    override func accessibilityDecrement() { set(chosen - 1) }
}

/// A heavy process: its icon in a quiet circle, its name and what it does, a switch.
final class PowerRow: UIView {
    var onChange: ((Bool) -> Void)?
    private let toggle = UISwitch()

    init(symbol: String, title: String, text: String, value: Bool) {
        super.init(frame: .zero)
        let chip = UIView()
        chip.backgroundColor = SettingsLook.chip
        chip.layer.cornerRadius = 17
        chip.translatesAutoresizingMaskIntoConstraints = false
        let icon = UIImageView(image: SettingsLook.symbol(symbol, size: 16, weight: .medium))
        icon.tintColor = Theme.text
        icon.contentMode = .center
        icon.translatesAutoresizingMaskIntoConstraints = false
        chip.addSubview(icon)
        let name = SettingsLook.words(title, size: 15, color: Theme.text)
        let words = SettingsLook.words(text, size: 12, color: Theme.muted)
        let texts = UIStackView(arrangedSubviews: [name, words])
        texts.axis = .vertical
        texts.spacing = 2
        toggle.isOn = value
        toggle.onTintColor = SettingsLook.switchOn
        toggle.accessibilityLabel = title
        toggle.setContentHuggingPriority(.required, for: .horizontal)
        toggle.setContentCompressionResistancePriority(.required, for: .horizontal)
        toggle.addTarget(self, action: #selector(flipped), for: .valueChanged)
        let content = UIStackView(arrangedSubviews: [chip, texts, toggle])
        content.axis = .horizontal
        content.alignment = .center
        content.spacing = 12
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            chip.widthAnchor.constraint(equalToConstant: 34),
            chip.heightAnchor.constraint(equalToConstant: 34),
            icon.centerXAnchor.constraint(equalTo: chip.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
            content.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func flipped() {
        onChange?(toggle.isOn)
    }
}
