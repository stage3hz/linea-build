import UIKit

/// ChatsPlus: «Настроить…» of «Выключить звук» (notifications/MuteSheet.tsx `DurationPicker`): chips for days,
/// hours and minutes, the chosen span in words, a live «Без звука до …» line, and «Выключить звук». The span and
/// its end come from the core (`settingsCustomMute`, the reference's `customMuteUntil` / `durationLabel`), the end's
/// words from `settingsMuteState` — the same as on the other phone.
final class MuteCustomSheet: UIViewController {
    private static let days = [0, 1, 2, 3, 5, 7, 14, 30]
    private static let hours = [0, 1, 2, 3, 4, 6, 8, 12, 18]
    private static let minutes = [0, 15, 30, 45]

    private var duration = (days: 0, hours: 1, minutes: 0)
    private let done: (String) -> Void
    /// «Назад»: the list of spans again.
    var onBack: (() -> Void)?

    private let heading = UILabel()
    private let back = UIButton(type: .system)
    private let span = UILabel()
    private var groups: [(caption: UILabel, chips: [UIButton], values: [Int], part: Int)] = []
    private let endLine = UILabel()
    private let confirm = UIButton(type: .system)
    private var until: String?

    init(done: @escaping (String) -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [UISheetPresentationController.Detent.custom(resolver: { context in
                return min(560, context.maximumDetentValue)
            })]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 28
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.panel(Theme.surface2)
        heading.attributedText = Theme.titleWords("На какое время?", size: Theme.TypeSize.sheetTitle, color: Theme.text)
        view.addSubview(heading)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)), for: .normal)
        back.setTitle(" Назад", for: .normal)
        back.titleLabel?.font = Theme.font(14, .semibold)
        back.tintColor = Theme.accent
        back.contentHorizontalAlignment = .left
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        view.addSubview(back)
        span.font = Theme.font(22, .bold)
        span.textColor = Theme.text
        span.textAlignment = .center
        view.addSubview(span)
        let parts: [(String, [Int])] = [("Дни", MuteCustomSheet.days), ("Часы", MuteCustomSheet.hours), ("Минуты", MuteCustomSheet.minutes)]
        for (index, part) in parts.enumerated() {
            let caption = UILabel()
            caption.text = part.0
            caption.font = Theme.font(12)
            caption.textColor = Theme.muted
            view.addSubview(caption)
            var chips: [UIButton] = []
            for value in part.1 {
                let chip = UIButton(type: .custom)
                chip.setTitle(String(value), for: .normal)
                chip.layer.cornerRadius = 12
                chip.tag = index * 1000 + value
                chip.accessibilityTraits = .button
                chip.addTarget(self, action: #selector(chipTapped(_:)), for: .touchUpInside)
                view.addSubview(chip)
                chips.append(chip)
            }
            groups.append((caption: caption, chips: chips, values: part.1, part: index))
        }
        endLine.font = Theme.font(12)
        endLine.textColor = Theme.muted
        endLine.numberOfLines = 2
        view.addSubview(endLine)
        confirm.setTitle("Выключить звук", for: .normal)
        confirm.titleLabel?.font = Theme.font(16, .semibold)
        confirm.setTitleColor(Theme.onAccent, for: .normal)
        confirm.backgroundColor = Theme.accent
        confirm.layer.cornerRadius = 16
        confirm.addTarget(self, action: #selector(confirmTapped), for: .touchUpInside)
        view.addSubview(confirm)
        refresh()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        let side: CGFloat = 20
        heading.frame = CGRect(x: side, y: 24, width: width - side * 2, height: 25)
        back.frame = CGRect(x: side, y: 58, width: 100, height: 24)
        span.frame = CGRect(x: side, y: 92, width: width - side * 2, height: 28)
        var y: CGFloat = 134
        for group in groups {
            group.caption.frame = CGRect(x: side, y: y, width: width - side * 2, height: 16)
            y += 22
            var x = side
            for chip in group.chips {
                let label = chip.title(for: .normal) ?? ""
                let textWidth = ceil((label as NSString).size(withAttributes: [.font: Theme.font(15, .bold)]).width)
                let chipWidth = max(52, textWidth + 24)
                if x + chipWidth > width - side { x = side; y += 46 }
                chip.frame = CGRect(x: x, y: y, width: chipWidth, height: 40)
                x += chipWidth + 6
            }
            y += 40 + 14
        }
        endLine.frame = CGRect(x: side, y: y, width: width - side * 2, height: 34)
        y += 44
        confirm.frame = CGRect(x: side, y: y, width: width - side * 2, height: 50)
    }

    @objc private func chipTapped(_ chip: UIButton) {
        Haptic.light()
        let part = chip.tag / 1000, value = chip.tag % 1000
        switch part {
        case 0: duration.days = value
        case 1: duration.hours = value
        default: duration.minutes = value
        }
        refresh()
    }

    private func refresh() {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let asked: [String: Any] = ["days": duration.days, "hours": duration.hours, "minutes": duration.minutes]
        let answer = Core.view("settingsCustomMute", [asked, now]) as? [String: Any] ?? [:]
        until = answer["until"] as? String
        let label = answer["label"] as? String ?? ""
        span.text = label.isEmpty ? "—" : label
        if let until {
            let end = NotificationsViewController.muteState(["muted": true, "mutedUntil": until])["until"] as? String ?? ""
            endLine.text = "Без звука " + end + "."
        } else {
            endLine.text = "Выбери хотя бы несколько минут."
        }
        confirm.isEnabled = until != nil
        confirm.alpha = until != nil ? 1 : 0.45
        for group in groups {
            let current = group.part == 0 ? duration.days : (group.part == 1 ? duration.hours : duration.minutes)
            for (index, chip) in group.chips.enumerated() {
                let on = group.values[index] == current
                chip.backgroundColor = on ? Theme.accent : Theme.veil(0.08)
                chip.setTitleColor(on ? Theme.onAccent : Theme.text, for: .normal)
                chip.titleLabel?.font = Theme.font(15, on ? .bold : .medium)
                if on { chip.accessibilityTraits.insert(.selected) } else { chip.accessibilityTraits.remove(.selected) }
            }
        }
    }

    @objc private func goBack() {
        let back = onBack
        dismiss(animated: true) { back?() }
    }

    /// The end is counted again from the moment of the touch, not from when the sheet was opened.
    @objc private func confirmTapped() {
        refresh()
        guard let until else { return }
        Haptic.light()
        let done = self.done
        dismiss(animated: true) { done(until) }
    }
}
