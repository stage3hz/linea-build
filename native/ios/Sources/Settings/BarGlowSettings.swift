import UIKit

// «Свечение панели» in «Оформление»: the bottom bar's lights (look 9, Shell/TabBar.swift) on or off, and the person's
// own colour for them. Kept on this device (`BarGlow`); the bar under the page follows at once. (Android:
// settings/BarGlowSettings.kt.)
extension AppearanceViewController {
    /// The switch, and under it (while the lights are on) «Свой цвет»: «Переливается» or the chosen colour.
    func addBarGlowGroup(refresh: @escaping () -> Void) {
        let on = BarGlow.on
        let glow = SettingsSwitchRow(label: "Свечение панели", words: "Огоньки под стеклом нижней панели: переливаются и отзываются на музыку и движение телефона", value: on)
        glow.onChange = { (value: Bool) -> Void in
            BarGlow.on = value
            refresh()
        }
        var rows: [UIView] = [glow]
        if on {
            let own = BarGlow.color
            let swatch: UIColor? = own.flatMap { (hex: String) -> UIColor? in BarGlow.uiColor(hex) }
            let colour = SettingsRow(label: "Свой цвет", value: own ?? "Переливается", swatch: swatch)
            colour.onPress = { [weak self] in
                guard let self else { return }
                let picker = BarGlowPickerController(done: refresh)
                self.present(picker, animated: true)
            }
            rows.append(colour)
        }
        addGroup(rows: rows)
    }
}

/// The colour of the bar's lights: the system's colour picker (no alpha) with «Переливается» under it, which takes
/// the bar back to the drift. A colour chosen is put on at once; while the finger moves the bar shows it without
/// keeping it. `done`: called when the picker has gone (the page shows the choice).
final class BarGlowPickerController: UIViewController, UIColorPickerViewControllerDelegate {
    /// Where the picker starts without an own colour: the sketch's centre light (#ff5fb0).
    static let start: UInt32 = 0xFF5FB0

    private let picker = UIColorPickerViewController()
    private let done: () -> Void

    init(done: @escaping () -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        picker.supportsAlpha = false
        picker.title = Language.tr("Цвет свечения")
        picker.selectedColor = BarGlow.color.flatMap { (hex: String) -> UIColor? in BarGlow.uiColor(hex) } ?? UIColor(hex: BarGlowPickerController.start)
        picker.delegate = self
        addChild(picker)
        picker.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(picker.view)
        let drift = SettingsButton(label: "Переливается", kind: .secondary)
        drift.translatesAutoresizingMaskIntoConstraints = false
        drift.onPress = { [weak self] in
            BarGlow.color = nil
            self?.dismiss(animated: true)
        }
        view.addSubview(drift)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            picker.view.topAnchor.constraint(equalTo: view.topAnchor),
            picker.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            picker.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            picker.view.bottomAnchor.constraint(equalTo: drift.topAnchor, constant: -12),
            drift.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            drift.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
            drift.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -12),
        ])
        picker.didMove(toParent: self)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed || presentingViewController == nil else { return }
        // A colour still under the finger is kept, as if let go.
        if let shown = BarGlow.color { BarGlow.color = shown }
        done()
    }

    func colorPickerViewController(_ viewController: UIColorPickerViewController, didSelect color: UIColor, continuously: Bool) {
        let hex = BarGlow.hex(color)
        if continuously { BarGlow.tryColor(hex) } else { BarGlow.color = hex }
    }

    func colorPickerViewControllerDidFinish(_ viewController: UIColorPickerViewController) {
        dismiss(animated: true)
    }
}
