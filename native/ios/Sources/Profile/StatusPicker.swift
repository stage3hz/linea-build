import UIKit

/// The emoji status picker (the reference's StatusPicker.tsx, like Telegram Premium): a panel right under the name —
/// the default Platina gem first, then the emoji; a tap sets the status and closes it. Opaque from its first frame,
/// it slides 8 pt into place in 0.16 s; a tap outside closes it. Without an active Platina the emoji are locked.
final class StatusPickerViewController: UIViewController {
    private let anchorY: CGFloat
    private let choices: [String]
    private let platina: Bool
    private let canSet: Bool
    private let current: String?
    var onPick: ((String?) -> Void)?
    private let panel = UIView()

    /// `status`: the server's `UsernameStatus` (PlatinaState.shared.status).
    init(anchorY: CGFloat, status: [String: Any], current: String?) {
        self.anchorY = anchorY
        let offered = status["statusEmojiChoices"] as? [String] ?? AvatarCatalog.statusEmoji
        choices = offered.filter { AvatarCatalog.statusEmoji.contains($0) }
        platina = (status["platina"] as? [String: Any])?["active"] as? Bool ?? false
        canSet = status["canSetStatusEmoji"] as? Bool ?? platina
        self.current = current
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let outside = UIControl(frame: view.bounds)
        outside.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        outside.accessibilityLabel = "Закрыть"
        outside.addTarget(self, action: #selector(close), for: .touchUpInside)
        view.addSubview(outside)
        panel.backgroundColor = Theme.panel(UIColor(hex: 0x1C1D20))
        panel.layer.cornerRadius = 22
        panel.layer.cornerCurve = .continuous
        panel.layer.shadowColor = UIColor.black.cgColor
        panel.layer.shadowOpacity = 0.35
        panel.layer.shadowRadius = 24
        panel.layer.shadowOffset = CGSize(width: 0, height: 10)
        view.addSubview(panel)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard panel.subviews.isEmpty else { return }
        let width = min(view.bounds.width, 520) - 24
        let columns: CGFloat = 8, pad: CGFloat = 10, gap: CGFloat = 4
        let cell = ((width - pad * 2 - gap * (columns - 1)) / columns).rounded(.down)
        var y = pad
        if !canSet {
            let note = UILabel(frame: CGRect(x: pad, y: y, width: width - pad * 2, height: 16))
            note.text = "Статус меняется с активной Platina"
            note.font = .systemFont(ofSize: 12)
            note.textColor = Theme.muted
            note.textAlignment = .center
            panel.addSubview(note)
            y += 16 + 8
        }
        var index = 0
        func place(_ view: UIView) {
            let column = CGFloat(index % Int(columns)), row = CGFloat(index / Int(columns))
            view.frame = CGRect(x: pad + column * (cell + gap), y: y + row * (cell + gap), width: cell, height: cell)
            panel.addSubview(view)
            index += 1
        }
        if platina {
            let gemCell = cellButton(selected: current == nil, label: "Значок Platina по умолчанию", enabled: true)
            let gem = PlatinaGemView(size: (cell * 0.5).rounded())
            gem.center = CGPoint(x: cell / 2, y: cell / 2)
            gem.isUserInteractionEnabled = false
            gemCell.addSubview(gem)
            gemCell.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.pick(nil) }, for: .touchUpInside)
            place(gemCell)
        }
        for emoji in choices {
            let button = cellButton(selected: current == emoji, label: "Статус \(emoji)", enabled: canSet)
            button.setTitle(emoji, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: (cell * 0.62).rounded())
            button.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.pick(emoji) }, for: .touchUpInside)
            place(button)
        }
        let rows = CGFloat((index + Int(columns) - 1) / Int(columns))
        let height = min(360, view.bounds.height * 0.45, y + rows * (cell + gap) - gap + pad)
        let top = max(view.safeAreaInsets.top + 8, min(anchorY + 14, view.bounds.height - view.safeAreaInsets.bottom - height - 8))
        panel.frame = CGRect(x: (view.bounds.width - width) / 2, y: top, width: width, height: height)
        panel.transform = CGAffineTransform(translationX: 0, y: -8)
        UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut], animations: { self.panel.transform = .identity }, completion: nil)
    }

    private func cellButton(selected: Bool, label: String, enabled: Bool) -> UIButton {
        let button = UIButton(type: .custom)
        button.layer.cornerRadius = 12
        button.layer.borderWidth = selected ? 1.5 : 0
        button.layer.borderColor = Theme.accent.cgColor
        button.backgroundColor = selected ? Theme.accent.withAlphaComponent(0.16) : .clear
        button.accessibilityLabel = label
        button.isEnabled = enabled
        button.alpha = enabled ? 1 : 0.4
        return button
    }

    private func pick(_ emoji: String?) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let done = onPick
        dismiss(animated: false) { done?(emoji) }
    }

    @objc private func close() {
        UIView.animate(withDuration: 0.12, animations: { self.panel.alpha = 0 }, completion: { (_: Bool) -> Void in self.dismiss(animated: false, completion: nil) })
    }
}
