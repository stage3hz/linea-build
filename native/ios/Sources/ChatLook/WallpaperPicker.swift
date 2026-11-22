import PhotosUI
import UIKit

/// «Обои чатов» (the reference's WallpaperPicker.tsx): «Выбрать из галереи» and the presets, then a full-screen
/// preview with sample messages — «Размытие», «Движение» and the dimming for dark themes for a picture, which is
/// fitted with the fingers — and «Установить» for this chat or for all chats. The system's photo picker is used: it
/// needs no access to the whole library.
final class WallpaperPickerController: UIViewController, PHPickerViewControllerDelegate {
    private let chatId: String?
    private let stack = UIStackView()
    private let problem = UILabel()

    /// `chatId`: opened from a chat (then «Для этого чата» is offered); nil: from the settings, for all chats.
    init(chatId: String?) {
        self.chatId = chatId
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.medium()]
            sheet.prefersGrabberVisible = true
        }
    }

    required init?(coder: NSCoder) { return nil }

    static func present(over host: UIViewController, chatId: String?) {
        host.present(WallpaperPickerController(chatId: chatId), animated: true)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.dark ? UIColor(hex: 0x16171A) : UIColor(hex: 0xF4F5F7)
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 22),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
        ])
        fill()
    }

    private var current: WallpaperChoice { Wallpapers.choice(chatId: chatId ?? "") }

    private func fill() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let title = UILabel()
        title.text = "Обои чатов"
        title.font = Theme.title(Theme.TypeSize.sheetTitle) // Fonts
        title.textColor = Theme.text
        stack.addArrangedSubview(title)

        let gallery = SettingsRow(symbol: "photo.on.rectangle", label: "Выбрать из галереи")
        gallery.onPress = { [weak self] in self?.pick() }
        gallery.backgroundColor = SettingsLook.card
        gallery.layer.cornerRadius = 14
        gallery.layer.cornerCurve = .continuous
        gallery.layer.masksToBounds = true
        stack.addArrangedSubview(gallery)

        problem.font = .systemFont(ofSize: 13)
        problem.textColor = Theme.danger
        problem.numberOfLines = 0
        problem.isHidden = (problem.text ?? "").isEmpty
        stack.addArrangedSubview(problem)

        let tiles = UIStackView()
        tiles.axis = .horizontal
        tiles.spacing = 10
        let now = current
        if now.isImage {
            tiles.addArrangedSubview(tile(label: "Своё фото", colors: nil, image: Wallpapers.image(now.file), chosen: true) { [weak self] in
                self?.preview(now)
            })
        }
        for preset in Wallpapers.presets {
            let chosen = !now.isImage && now.preset == preset.id
            tiles.addArrangedSubview(tile(label: preset.label, colors: preset.colors, image: nil, chosen: chosen) { [weak self] in
                self?.preview(.preset(preset.id))
            })
        }
        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        tiles.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(tiles)
        NSLayoutConstraint.activate([
            tiles.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            tiles.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            tiles.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            tiles.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            tiles.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 160),
        ])
        stack.addArrangedSubview(scroll)

        let foot = UILabel()
        foot.text = "Обои хранятся только на этом телефоне и никуда не отправляются; собеседник их не видит."
        foot.font = .systemFont(ofSize: 12)
        foot.textColor = Theme.muted
        foot.numberOfLines = 0
        stack.addArrangedSubview(foot)
    }

    private func tile(label: String, colors: [UInt32]?, image: UIImage?, chosen: Bool, action: @escaping () -> Void) -> UIView {
        let button = UIButton(type: .custom)
        button.accessibilityLabel = label
        button.backgroundColor = Theme.bg
        button.layer.cornerRadius = 14
        button.layer.cornerCurve = .continuous
        button.layer.masksToBounds = true
        button.layer.borderWidth = 3
        button.layer.borderColor = (chosen ? Theme.accent : UIColor.clear).cgColor
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 96).isActive = true
        button.heightAnchor.constraint(equalToConstant: 160).isActive = true
        if let colors {
            let gradient = CAGradientLayer()
            gradient.colors = colors.map { LookColor.color($0).cgColor }
            gradient.startPoint = CGPoint(x: 0, y: 0)
            gradient.endPoint = CGPoint(x: 1, y: 1)
            gradient.frame = CGRect(x: 0, y: 0, width: 96, height: 160)
            button.layer.insertSublayer(gradient, at: 0)
            gradient.zPosition = -1
        } else if let image {
            let picture = UIImageView(image: image)
            picture.contentMode = .scaleAspectFill
            picture.frame = CGRect(x: 0, y: 0, width: 96, height: 160)
            picture.isUserInteractionEnabled = false
            button.addSubview(picture)
        } else {
            let words = UILabel(frame: CGRect(x: 0, y: 0, width: 96, height: 160))
            words.text = "Как фон"
            words.font = .systemFont(ofSize: 12)
            words.textColor = Theme.muted
            words.textAlignment = .center
            button.addSubview(words)
        }
        button.addAction(UIAction { (_: UIAction) -> Void in action() }, for: .touchUpInside)
        return button
    }

    // MARK: The gallery

    private func pick() {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let item = results.first?.itemProvider, item.canLoadObject(ofClass: UIImage.self) else { return }
        item.loadObject(ofClass: UIImage.self) { [weak self] (object: NSItemProviderReading?, _: Error?) -> Void in
            let image = object as? UIImage
            let kept = image.flatMap { Wallpapers.keep($0) }
            DispatchQueue.main.async {
                guard let self else { return }
                guard let kept, let image else {
                    self.problem.text = "Не удалось открыть фото."
                    self.problem.isHidden = false
                    return
                }
                let aspect = image.size.height > 0 ? Double(image.size.width / image.size.height) : 0
                self.preview(WallpaperChoice(kind: "image", file: kept, blur: false, motion: false, dim: 0.2, aspect: aspect, zoom: 1, fx: 0, fy: 0), fresh: true)
            }
        }
    }

    // MARK: The preview

    private func preview(_ draft: WallpaperChoice, fresh: Bool = false) {
        let screen = WallpaperPreviewController(draft: draft, forChat: chatId != nil)
        screen.onCancel = {
            if fresh { Wallpapers.discard(draft.file) }
        }
        screen.onSet = { [weak self] (choice: WallpaperChoice, forChat: Bool) -> Void in
            guard let self else { return }
            Wallpapers.set(choice, chatId: forChat ? self.chatId : nil)
            if fresh && choice.file != draft.file { Wallpapers.discard(draft.file) }
            self.dismiss(animated: true)
        }
        present(screen, animated: true)
    }
}

/// The full-screen preview of a wallpaper with sample messages (the reference's `WallpaperPreview`).
final class WallpaperPreviewController: UIViewController {
    var onCancel: (() -> Void)?
    var onSet: ((WallpaperChoice, Bool) -> Void)?

    private var draft: WallpaperChoice
    private let forChat: Bool
    private let paper = WallpaperView()
    private let samples = UIStackView()
    private let controls = UIStackView()
    private let hint = UILabel()
    private var start: (zoom: Double, fx: Double, fy: Double) = (1, 0, 0)

    init(draft: WallpaperChoice, forChat: Bool) {
        self.draft = draft
        self.forChat = forChat
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .coverVertical
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        paper.frame = view.bounds
        paper.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(paper)

        // Your own picture is fitted with the fingers: drag it to choose the part that shows, pinch to zoom.
        // A preset: pull the preview down to cancel.
        if draft.isImage {
            let drag = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
            drag.maximumNumberOfTouches = 2
            let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
            view.addGestureRecognizer(drag)
            view.addGestureRecognizer(pinch)
        } else {
            view.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pulled(_:))))
        }

        let title = capsule("Предпросмотр", size: 15, weight: .semibold)
        title.tag = 10
        view.addSubview(title)

        samples.axis = .vertical
        samples.spacing = 8
        samples.isUserInteractionEnabled = false
        view.addSubview(samples)
        let palette = ChatBubbleLook.palette(bubbles: true)
        samples.addArrangedSubview(bubble("Как тебе новые обои?", mine: false, palette: palette))
        samples.addArrangedSubview(bubble("Огонь, ставлю 🔥", mine: true, palette: palette))
        samples.addArrangedSubview(bubble("Так будет выглядеть чат.", mine: false, palette: palette))

        hint.text = "Двигай фото пальцем, масштаб — двумя"
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = .white
        hint.textAlignment = .center
        hint.backgroundColor = UIColor(white: 0, alpha: 0.35)
        hint.layer.cornerRadius = 14
        hint.layer.masksToBounds = true
        hint.isHidden = !draft.isImage
        view.addSubview(hint)

        controls.axis = .vertical
        controls.spacing = 12
        view.addSubview(controls)
        fillControls()
        paper.show(draft)
    }

    private func capsule(_ text: String, size: CGFloat, weight: UIFont.Weight) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = .white
        label.textAlignment = .center
        label.backgroundColor = UIColor(white: 0, alpha: 0.35)
        label.layer.cornerRadius = 16
        label.layer.masksToBounds = true
        return label
    }

    private func bubble(_ text: String, mine: Bool, palette: MsgPalette) -> UIView {
        let row = UIView()
        let plate = UILabel()
        plate.text = text
        plate.font = .systemFont(ofSize: 16)
        plate.textColor = palette.text
        plate.numberOfLines = 0
        let box = UIView()
        box.backgroundColor = mine ? palette.mine : palette.theirs
        box.layer.cornerRadius = 18
        box.layer.cornerCurve = .continuous
        box.addSubview(plate)
        row.addSubview(box)
        plate.translatesAutoresizingMaskIntoConstraints = false
        box.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            plate.topAnchor.constraint(equalTo: box.topAnchor, constant: 8),
            plate.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -8),
            plate.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 13),
            plate.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -13),
            box.topAnchor.constraint(equalTo: row.topAnchor),
            box.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            box.widthAnchor.constraint(lessThanOrEqualTo: row.widthAnchor, multiplier: 0.72),
            mine ? box.trailingAnchor.constraint(equalTo: row.trailingAnchor) : box.leadingAnchor.constraint(equalTo: row.leadingAnchor),
        ])
        return row
    }

    private func toggle(_ label: String, symbol: String, on: Bool, flip: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        var config = UIButton.Configuration.plain()
        config.title = label
        config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .regular))
        config.imagePadding = 7
        config.baseForegroundColor = .white
        button.configuration = config
        button.backgroundColor = on ? UIColor(white: 1, alpha: 0.28) : UIColor(white: 0, alpha: 0.35)
        button.layer.cornerRadius = 21
        button.accessibilityTraits.insert(on ? .selected : .button)
        button.heightAnchor.constraint(equalToConstant: 42).isActive = true
        button.addAction(UIAction { (_: UIAction) -> Void in flip() }, for: .touchUpInside)
        return button
    }

    private func wide(_ label: String, filled: Bool, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(label, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 16, weight: filled ? .bold : .semibold)
        button.setTitleColor(filled ? Theme.onAccent : .white, for: .normal)
        button.backgroundColor = filled ? Theme.accent : UIColor(white: 0, alpha: 0.45)
        button.layer.cornerRadius = 14
        button.heightAnchor.constraint(equalToConstant: 48).isActive = true
        button.addAction(UIAction { (_: UIAction) -> Void in action() }, for: .touchUpInside)
        return button
    }

    private func fillControls() {
        controls.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if draft.isImage {
            let pair = UIStackView(arrangedSubviews: [
                toggle("Размытие", symbol: "drop", on: draft.blur) { [weak self] in self?.change { $0.blur.toggle() } },
                toggle("Движение", symbol: "iphone", on: draft.motion) { [weak self] in self?.change { $0.motion.toggle() } },
            ])
            pair.axis = .horizontal
            pair.spacing = 8
            pair.distribution = .fillEqually
            controls.addArrangedSubview(pair)
            if Theme.dark {
                let caption = UILabel()
                caption.text = "Затемнение в тёмной теме"
                caption.font = .systemFont(ofSize: 12)
                caption.textColor = .white
                let steps = UIStackView()
                steps.axis = .horizontal
                steps.spacing = 6
                steps.distribution = .fillEqually
                for value in [0.0, 0.2, 0.4, 0.6] {
                    let step = UIButton(type: .system)
                    step.setTitle(value == 0 ? "Нет" : "\(Int(value * 100))%", for: .normal)
                    step.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
                    step.setTitleColor(.white, for: .normal)
                    step.backgroundColor = draft.dim == value ? UIColor(white: 1, alpha: 0.3) : UIColor(white: 0, alpha: 0.35)
                    step.layer.cornerRadius = 10
                    step.heightAnchor.constraint(equalToConstant: 34).isActive = true
                    step.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.change { $0.dim = value } }, for: .touchUpInside)
                    steps.addArrangedSubview(step)
                }
                let dim = UIStackView(arrangedSubviews: [caption, steps])
                dim.axis = .vertical
                dim.spacing = 6
                controls.addArrangedSubview(dim)
            }
        }
        let cancel = wide("Отмена", filled: false) { [weak self] in self?.cancel() }
        let set = wide("Установить", filled: true) { [weak self] in self?.choose() }
        let buttons = UIStackView(arrangedSubviews: [cancel, set])
        buttons.axis = .horizontal
        buttons.spacing = 8
        set.widthAnchor.constraint(equalTo: cancel.widthAnchor, multiplier: 1.4).isActive = true
        controls.addArrangedSubview(buttons)
        view.setNeedsLayout()
    }

    private func change(_ edit: (inout WallpaperChoice) -> Void) {
        edit(&draft)
        paper.show(draft)
        fillControls()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        let insets = view.safeAreaInsets
        if let title = view.viewWithTag(10) {
            let size = title.intrinsicContentSize
            title.frame = CGRect(x: (width - size.width - 32) / 2, y: insets.top + 8, width: size.width + 32, height: 32)
        }
        let sampleSize = samples.systemLayoutSizeFitting(CGSize(width: width - 28, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        samples.frame = CGRect(x: 14, y: insets.top + 8 + 32 + 24 + 14, width: width - 28, height: sampleSize.height)
        let controlSize = controls.systemLayoutSizeFitting(CGSize(width: width - 28, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        controls.frame = CGRect(x: 14, y: view.bounds.height - insets.bottom - 14 - controlSize.height, width: width - 28, height: controlSize.height)
        let hintSize = hint.intrinsicContentSize
        hint.frame = CGRect(x: (width - hintSize.width - 24) / 2, y: controls.frame.minY - 10 - 26, width: hintSize.width + 24, height: 26)
    }

    // MARK: Fitting the picture

    @objc private func dragged(_ recognizer: UIPanGestureRecognizer) {
        let size = view.bounds.size
        switch recognizer.state {
        case .began:
            start = (draft.zoom, draft.fx, draft.fy)
        case .changed:
            let move = recognizer.translation(in: view)
            let fitted = WallpaperFit.clamp(zoom: draft.zoom, fx: start.fx + Double(move.x / size.width), fy: start.fy + Double(move.y / size.height),
                                            aspect: draft.aspect, width: Double(size.width), height: Double(size.height))
            draft.fx = fitted.fx
            draft.fy = fitted.fy
            paper.fit(zoom: draft.zoom, fx: draft.fx, fy: draft.fy)
        default:
            break
        }
    }

    @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) {
        let size = view.bounds.size
        switch recognizer.state {
        case .began:
            start = (draft.zoom, draft.fx, draft.fy)
        case .changed:
            let fitted = WallpaperFit.clamp(zoom: start.zoom * Double(recognizer.scale), fx: draft.fx, fy: draft.fy,
                                            aspect: draft.aspect, width: Double(size.width), height: Double(size.height))
            draft.zoom = fitted.zoom
            draft.fx = fitted.fx
            draft.fy = fitted.fy
            paper.fit(zoom: draft.zoom, fx: draft.fx, fy: draft.fy)
        default:
            break
        }
    }

    /// A preset: pulled down far enough (or flung), the preview closes as «Отмена».
    @objc private func pulled(_ recognizer: UIPanGestureRecognizer) {
        let down = max(0, recognizer.translation(in: view).y)
        switch recognizer.state {
        case .changed:
            view.transform = CGAffineTransform(translationX: 0, y: down)
        case .ended, .cancelled:
            if down > 120 || recognizer.velocity(in: view).y > 900 {
                cancel()
            } else {
                UIView.animate(withDuration: 0.25) { self.view.transform = .identity }
            }
        default:
            break
        }
    }

    // MARK: Done

    private func cancel() {
        onCancel?()
        dismiss(animated: true)
    }

    private func choose() {
        guard forChat else {
            finish(forChat: false)
            return
        }
        let ask = UIAlertController(title: "Установить обои", message: nil, preferredStyle: .actionSheet)
        ask.addAction(UIAlertAction(title: "Для этого чата", style: .default) { [weak self] (_: UIAlertAction) -> Void in self?.finish(forChat: true) })
        ask.addAction(UIAlertAction(title: "Для всех чатов", style: .default) { [weak self] (_: UIAlertAction) -> Void in self?.finish(forChat: false) })
        ask.addAction(UIAlertAction(title: "Отмена", style: .cancel))
        present(ask, animated: true)
    }

    private func finish(forChat: Bool) {
        let choice = draft
        let done = onSet
        dismiss(animated: true) { done?(choice, forChat) }
    }
}
