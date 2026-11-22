import UIKit

/// The photo editor before sending (the reference's photo/editor/PhotoEditorScreen.tsx with EditorPanels.tsx,
/// EditorCanvas.tsx, useEffectPreview.ts and editorHistory.ts): «Обрезка» (free or 1:1, 4:3, 3:4, 16:9 by dragging a
/// frame; «Повернуть на 90°», «Отразить»), «Рисование» (eight colours, three widths), «Убрать объект» (paint over it:
/// the area is filled from its neighbours), «Фон» («Исходный», «Без фона», «Белый»), «Улучшить» (photo or a black-
/// and-white / colour document, ×1 ×2 ×4) and «Размер и формат» (full or half, JPEG or PNG), with undo, redo and
/// «Сбросить». The effects are the reference's own on-device code (Sources/Attachments/PhotoPixels.swift); the
/// edited picture is then cleaned like any photo (`PhotoPrepare`): nothing of the original's metadata survives.
final class PhotoEditorController: UIViewController {
    /// One state of the edit (the reference's EditState; no HDR here: the iPhone app sends photos in SDR).
    /// Everything is normalized to the picture as it stands on screen (turned and mirrored).
    struct Edit: Equatable {
        var rotation = 0
        var flip = false
        /// nil: the whole picture.
        var crop: CGRect?
        /// The pen («Рисование»).
        var strokes: [Stroke] = []
        /// «Убрать объект»: the painted areas.
        var masks: [Mask] = []
        /// keep · transparent · white
        var background = "keep"
        /// none · bw · color
        var document = "none"
        /// 1, 2 or 4.
        var scale = 1
        /// png · jpeg
        var format = "png"
        /// 1 or 0.5.
        var resolution: CGFloat = 1
    }

    struct Stroke: Equatable {
        let color: UInt32
        let width: CGFloat
        var points: [CGPoint]
    }

    /// The brush of «Убрать объект»: radius as a share of the picture's shorter side.
    struct Mask: Equatable {
        let radius: CGFloat
        var points: [CGPoint]
    }

    /// What «Готово» gives: the edited bitmap and the chosen format.
    struct Output {
        let image: CGImage
        let format: String
    }

    static let penColors: [UInt32] = [0xFFFFFF, 0x111111, 0xFF3B30, 0xFF9500, 0xFFCC00, 0x34C759, 0x0A84FF, 0xAF52DE]
    static let colorNames = ["Белый", "Чёрный", "Красный", "Оранжевый", "Жёлтый", "Зелёный", "Синий", "Фиолетовый"]
    static let penWidths: [(label: String, value: CGFloat)] = [("Тонкая", 0.006), ("Средняя", 0.012), ("Широкая", 0.024)]
    static let brushRadii: [(label: String, value: CGFloat)] = [("Тонкая", 0.008), ("Средняя", 0.02), ("Широкая", 0.05)]
    static let aspects: [(label: String, spoken: String, value: CGFloat?)] = [("Свободно", "Свободная обрезка", nil), ("1:1", "Квадрат", 1), ("4:3", "Четыре к трём", 4.0 / 3.0),
                                                                             ("3:4", "Три к четырём", 3.0 / 4.0), ("16:9", "Шестнадцать к девяти", 16.0 / 9.0)]
    /// The reference's TABS.
    static let tabs: [(id: String, symbol: String, label: String)] = [("crop", "crop", "Обрезка"), ("draw", "paintbrush.pointed", "Рисование"),
                                                                    ("remove", "bandage", "Убрать объект"), ("background", "photo", "Фон"),
                                                                    ("enhance", "sparkles", "Улучшить"), ("size", "arrow.up.left.and.arrow.down.right", "Размер и формат")]
    /// The reference's MAX_STROKES / MAX_STROKE_POINTS.
    static let maxMasks = 64, maxMaskPoints = 1024
    private static let accent = UIColor(hex: 0x4DA3FF)
    private static let muted = UIColor(hex: 0x9AA3B2)

    private let original: UIImage
    /// The finished picture (`nil` when nothing was changed: the original goes as it is).
    var onDone: ((Output?) -> Void)?
    var onCancel: (() -> Void)?

    private var history: [Edit] = [Edit()]
    private var at = 0
    private var shown: Edit { history[at] }
    private var editorTab = "crop"
    private var aspect: CGFloat?
    private var penColor: UInt32 = 0xFF3B30
    private var penWidth: CGFloat = 0.012
    private var brushRadius: CGFloat = 0.02
    private var busy = false
    private var errorWords = ""

    // The deferred preview of the effects (the reference's useEffectPreview: 400 ms, four kept).
    private var previews: [(key: String, image: UIImage)] = []
    private var previewRevision = 0
    private var previewBusy = false

    private let closeButton = UIButton(type: .system)
    private let undoButton = UIButton(type: .system)
    private let redoButton = UIButton(type: .system)
    private let resetButton = UIButton(type: .system)
    private let canvas = PhotoEditorCanvas()
    private let busyPill = UIView()
    private let busySpinner = UIActivityIndicatorView(style: .medium)
    private let busyLabel = UILabel()
    private let errorLabel = UILabel()
    private let tools = UIScrollView()
    private let tools2 = UIScrollView()
    private let hint = UILabel()
    private let hint2 = UILabel()
    private let tabsRow = UIScrollView()
    private var tabButtons: [UIButton] = []
    /// The tab last scrolled into view in the row.
    private var shownTab = ""
    private let sendButton = UIButton(type: .custom)
    private let sendSpinner = UIActivityIndicatorView(style: .medium)

    init(image: UIImage) {
        original = image
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { return nil }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        for (button, symbol, label) in [(closeButton, "xmark", "Отменить редактирование фото"), (undoButton, "arrow.uturn.backward", "Отменить действие"), (redoButton, "arrow.uturn.forward", "Повторить действие")] {
            button.setImage(chatSymbol(symbol, 19, .semibold), for: .normal)
            button.tintColor = .white
            button.accessibilityLabel = label
            view.addSubview(button)
        }
        closeButton.addTarget(self, action: #selector(cancelNow), for: .touchUpInside)
        undoButton.addTarget(self, action: #selector(undo), for: .touchUpInside)
        redoButton.addTarget(self, action: #selector(redo), for: .touchUpInside)
        resetButton.setTitle("Сбросить", for: .normal)
        resetButton.titleLabel?.font = .systemFont(ofSize: 15)
        resetButton.tintColor = .white
        resetButton.accessibilityLabel = "Сбросить все изменения"
        resetButton.addTarget(self, action: #selector(reset), for: .touchUpInside)
        view.addSubview(resetButton)
        canvas.image = original
        canvas.onCrop = { [weak self] (crop: CGRect?) -> Void in self?.cropDragged(crop) }
        canvas.onStroke = { [weak self] (stroke: Stroke) -> Void in
            guard let self else { return }
            var next = self.shown
            next.strokes.append(stroke)
            self.commit(next)
        }
        canvas.onMask = { [weak self] (mask: Mask) -> Void in
            guard let self else { return }
            // The reference's withStroke: at most 64 areas and 1024 points in all.
            let used = self.shown.masks.reduce(0) { (sum: Int, item: Mask) -> Int in sum + item.points.count }
            guard !mask.points.isEmpty, self.shown.masks.count < PhotoEditorController.maxMasks, used + mask.points.count <= PhotoEditorController.maxMaskPoints else {
                self.showError(PhotoBitmap.words(PhotoFailure("MASK_TOO_COMPLEX")))
                return
            }
            var next = self.shown
            next.masks.append(mask)
            self.commit(next)
        }
        view.addSubview(canvas)
        busyPill.backgroundColor = UIColor(white: 0, alpha: 0.6)
        busyPill.layer.cornerRadius = 16
        busyPill.isUserInteractionEnabled = false
        busyPill.isHidden = true
        busySpinner.color = .white
        busyPill.addSubview(busySpinner)
        busyLabel.font = .systemFont(ofSize: 13)
        busyLabel.textColor = .white
        busyLabel.text = "Обрабатываем…"
        busyPill.addSubview(busyLabel)
        view.addSubview(busyPill)
        errorLabel.font = .systemFont(ofSize: 12.5)
        errorLabel.textColor = UIColor(hex: 0xFF8A80)
        errorLabel.textAlignment = .center
        errorLabel.numberOfLines = 2
        view.addSubview(errorLabel)
        tools.showsHorizontalScrollIndicator = false
        tools2.showsHorizontalScrollIndicator = false
        view.addSubview(tools)
        view.addSubview(tools2)
        for label in [hint, hint2] {
            label.font = .systemFont(ofSize: 12)
            label.textColor = PhotoEditorController.muted
            label.numberOfLines = 3
            view.addSubview(label)
        }
        tabsRow.showsHorizontalScrollIndicator = false
        view.addSubview(tabsRow)
        for (index, item) in PhotoEditorController.tabs.enumerated() {
            let button = UIButton(type: .custom)
            button.tag = index
            button.accessibilityIdentifier = item.id
            var config = UIButton.Configuration.plain()
            config.image = chatSymbol(item.symbol, 21)
            config.imagePlacement = .top
            config.imagePadding = 3
            config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10)
            config.attributedTitle = AttributedString(item.label, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 10.5)]))
            config.titleLineBreakMode = .byTruncatingTail
            button.configuration = config
            button.layer.cornerRadius = 12
            button.accessibilityLabel = item.label
            button.addTarget(self, action: #selector(tabChosen(_:)), for: .touchUpInside)
            tabsRow.addSubview(button)
            tabButtons.append(button)
        }
        sendButton.backgroundColor = UIColor(hex: 0x0A84FF)
        sendButton.layer.cornerRadius = 27
        sendButton.setImage(chatSymbol("checkmark", 24, .semibold), for: .normal)
        sendButton.tintColor = .white
        sendButton.accessibilityLabel = "Отправить фото"
        sendButton.addTarget(self, action: #selector(sendNow), for: .touchUpInside)
        view.addSubview(sendButton)
        sendSpinner.color = .white
        sendSpinner.hidesWhenStopped = true
        sendButton.addSubview(sendSpinner)
        show()
    }

    // MARK: The history

    private func commit(_ next: Edit) {
        guard next != shown else { return }
        history = Array(history.prefix(at + 1)) + [next]
        // The reference's HISTORY_LIMIT.
        if history.count > 51 { history.removeFirst(history.count - 51) }
        at = history.count - 1
        errorWords = ""
        show()
    }

    @objc private func undo() {
        guard at > 0, !busy else { return }
        at -= 1
        UISelectionFeedbackGenerator().selectionChanged()
        show()
    }

    @objc private func redo() {
        guard at + 1 < history.count, !busy else { return }
        at += 1
        UISelectionFeedbackGenerator().selectionChanged()
        show()
    }

    @objc private func reset() {
        guard !busy else { return }
        aspect = nil
        commit(Edit())
    }

    private func showError(_ words: String) {
        errorWords = words
        errorLabel.text = words
        view.setNeedsLayout()
    }

    // MARK: The tools

    @objc private func tabChosen(_ sender: UIButton) {
        guard !busy else { return }
        editorTab = sender.accessibilityIdentifier ?? "crop"
        show()
        view.setNeedsLayout()
    }

    private func chip(_ label: String, spoken: String? = nil, badge: String? = nil, selected: Bool, enabled: Bool = true, action: Selector, tag: Int) -> UIButton {
        let button = UIButton(type: .custom)
        let words = NSMutableAttributedString(string: label, attributes: [.font: UIFont.systemFont(ofSize: 13, weight: .semibold),
                                                                          .foregroundColor: selected ? PhotoEditorController.accent : UIColor(hex: 0xF2F4F8)])
        if let badge {
            words.append(NSAttributedString(string: "  " + badge, attributes: [.font: UIFont.systemFont(ofSize: 10, weight: .heavy), .foregroundColor: UIColor(hex: 0xFFB340)]))
        }
        button.setAttributedTitle(words, for: .normal)
        button.backgroundColor = selected ? UIColor(red: 10 / 255, green: 132 / 255, blue: 1, alpha: 0.28) : UIColor(white: 1, alpha: 0.09)
        button.layer.cornerRadius = 16
        button.contentEdgeInsets = UIEdgeInsets(top: 9, left: 13, bottom: 9, right: 13)
        let base = spoken ?? label
        button.accessibilityLabel = badge.map { base + ", " + $0 } ?? base
        button.accessibilityTraits = selected ? [.button, .selected] : .button
        button.isEnabled = enabled && !busy
        button.alpha = enabled && !busy ? 1 : 0.35
        button.tag = tag
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    private func fill(_ row: UIScrollView, _ items: [UIView]) {
        row.subviews.forEach { $0.removeFromSuperview() }
        var x: CGFloat = 14
        for item in items {
            let size = item.intrinsicContentSize
            let isDot = (item as? UIButton).map { $0.title(for: .normal) == nil && $0.attributedTitle(for: .normal) == nil } ?? false
            let width = isDot ? 30 : size.width
            item.frame = CGRect(x: x, y: 2, width: width, height: max(30, size.height))
            row.addSubview(item)
            x += width + 8
        }
        row.contentSize = CGSize(width: x + 6, height: 40)
    }

    private func show() {
        let canEdit = !busy
        undoButton.isEnabled = at > 0 && canEdit
        undoButton.alpha = undoButton.isEnabled ? 1 : 0.4
        redoButton.isEnabled = at + 1 < history.count && canEdit
        redoButton.alpha = redoButton.isEnabled ? 1 : 0.4
        let edited = shown != Edit()
        resetButton.isEnabled = edited && canEdit
        resetButton.alpha = resetButton.isEnabled ? 1 : 0.4
        closeButton.isEnabled = canEdit
        canvas.edit = shown
        canvas.tool = ["crop", "draw", "remove"].contains(editorTab) && canEdit ? editorTab : "view"
        canvas.aspect = aspect
        canvas.penColor = penColor
        canvas.penWidth = penWidth
        canvas.brushRadius = brushRadius
        canvas.showMask = editorTab == "remove"
        canvas.transparent = shown.background == "transparent"
        refreshPreview()
        canvas.setNeedsDisplay()
        for button in tabButtons {
            let on = button.accessibilityIdentifier == editorTab
            button.backgroundColor = on ? UIColor(red: 10 / 255, green: 132 / 255, blue: 1, alpha: 0.2) : .clear
            var config = button.configuration
            config?.baseForegroundColor = on ? PhotoEditorController.accent : UIColor(hex: 0xD8DCE4)
            button.configuration = config
            button.accessibilityTraits = on ? [.button, .selected] : .button
            button.alpha = canEdit ? 1 : 0.4
        }
        hint.text = ""
        hint2.text = ""
        hint.textColor = PhotoEditorController.muted
        let edit = shown
        switch editorTab {
        case "crop":
            var aspectChips: [UIView] = []
            for (index, item) in PhotoEditorController.aspects.enumerated() {
                aspectChips.append(chip(item.label, spoken: item.spoken, selected: aspect == item.value, action: #selector(aspectChosen(_:)), tag: index))
            }
            fill(tools, aspectChips)
            fill(tools2, [chip("↺  Повернуть на 90°", spoken: "Повернуть на 90°", selected: false, action: #selector(rotate), tag: 0),
                          chip("⇋  Отразить", spoken: "Отразить", selected: false, action: #selector(flip), tag: 0)])
        case "draw":
            var dots: [UIView] = []
            for (index, color) in PhotoEditorController.penColors.enumerated() {
                let dot = UIButton(type: .custom)
                dot.backgroundColor = UIColor(hex: color)
                dot.layer.cornerRadius = 15
                dot.layer.borderWidth = penColor == color ? 3 : 1
                dot.layer.borderColor = (penColor == color ? PhotoEditorController.accent : UIColor(white: 1, alpha: 0.45)).cgColor
                dot.accessibilityLabel = "Цвет: " + PhotoEditorController.colorNames[index]
                dot.accessibilityTraits = penColor == color ? [.button, .selected] : .button
                dot.tag = index
                dot.addTarget(self, action: #selector(colorChosen(_:)), for: .touchUpInside)
                dots.append(dot)
            }
            fill(tools, dots)
            var widths: [UIView] = []
            for (index, item) in PhotoEditorController.penWidths.enumerated() {
                widths.append(chip(item.label, spoken: "Толщина: " + item.label.lowercased(), selected: penWidth == item.value, action: #selector(widthChosen(_:)), tag: index))
            }
            fill(tools2, widths)
        case "remove":
            var brushes: [UIView] = []
            for (index, item) in PhotoEditorController.brushRadii.enumerated() {
                brushes.append(chip(item.label, spoken: "Кисть: " + item.label.lowercased(), selected: brushRadius == item.value, action: #selector(brushChosen(_:)), tag: index))
            }
            fill(tools, brushes)
            fill(tools2, [])
            hint.text = "Закрась объект — область заполнится соседними цветами. Маска — до 20% кадра."
            if edit.crop != nil {
                hint2.text = "Предпросмотр считается по всему фото, а при отправке — по обрезанному кадру: у края кадра заполнение может немного отличаться."
            }
        case "background":
            // iOS 17 is the least this app runs on: the system's foreground mask is always there.
            fill(tools, [chip("Исходный", selected: edit.background == "keep", action: #selector(backgroundChosen(_:)), tag: 0),
                         chip("Без фона", spoken: "Без фона", badge: "PNG", selected: edit.background == "transparent", action: #selector(backgroundChosen(_:)), tag: 1),
                         chip("Белый", selected: edit.background == "white", action: #selector(backgroundChosen(_:)), tag: 2)])
            fill(tools2, [])
        case "enhance":
            fill(tools, [chip("Фото", selected: edit.document == "none", action: #selector(documentChosen(_:)), tag: 0),
                         chip("Ч/б документ", selected: edit.document == "bw", action: #selector(documentChosen(_:)), tag: 1),
                         chip("Цветной документ", selected: edit.document == "color", action: #selector(documentChosen(_:)), tag: 2)])
            var scales: [UIView] = []
            for (index, scale) in [1, 2, 4].enumerated() {
                scales.append(chip("×\(scale)", spoken: scale == 1 ? "Без увеличения" : "Увеличить в \(scale) раза", selected: edit.scale == scale, action: #selector(scaleChosen(_:)), tag: index))
            }
            fill(tools2, scales)
        default:
            fill(tools, [chip("Полное", spoken: "Полный размер", selected: edit.resolution == 1, action: #selector(sizeChosen(_:)), tag: 0),
                         chip("50 %", spoken: "Половина размера", selected: edit.resolution == 0.5, action: #selector(sizeChosen(_:)), tag: 1),
                         chip("JPEG", selected: edit.format == "jpeg", enabled: edit.background != "transparent", action: #selector(formatChosen(_:)), tag: 0),
                         chip("PNG", selected: edit.format == "png", action: #selector(formatChosen(_:)), tag: 1)])
            fill(tools2, [])
            let plan = PhotoEditorController.plan(turned: canvas.turnedSize, edit: edit)
            hint.text = "Результат: \(plan.width) × \(plan.height) · \(edit.format == "jpeg" ? "JPEG" : "PNG")\(plan.downsampled ? " · фото будет уменьшено" : ""). EXIF, GPS и личные метаданные удаляются."
        }
        if busy { hint2.text = "Готовим фото…" }
        errorLabel.text = errorWords
        view.setNeedsLayout()
    }

    @objc private func aspectChosen(_ sender: UIButton) {
        guard sender.tag < PhotoEditorController.aspects.count else { return }
        aspect = PhotoEditorController.aspects[sender.tag].value
        // A fixed shape starts as the largest frame of that shape in the middle (the reference's `centeredCrop`).
        var next = shown
        if let aspect {
            let turned = canvas.turnedSize
            let sourceAspect = turned.width / max(1, turned.height)
            let width = min(1, aspect / sourceAspect), height = min(1, sourceAspect / aspect)
            next.crop = CGRect(x: (1 - width) / 2, y: (1 - height) / 2, width: width, height: height)
            commit(next)
        }
        show()
    }

    /// The reference's `rotated`: a quarter turn to the left on screen; the frame, the lines and the painted areas
    /// turn with the picture.
    @objc private func rotate() {
        var next = shown
        next.rotation = ((next.rotation + (next.flip ? 90 : -90)) % 360 + 360) % 360
        let turn = { (point: CGPoint) -> CGPoint in CGPoint(x: point.y, y: 1 - point.x) }
        if let crop = next.crop { next.crop = CGRect(x: crop.minY, y: 1 - crop.minX - crop.width, width: crop.height, height: crop.width) }
        next.strokes = next.strokes.map { (stroke: Stroke) -> Stroke in Stroke(color: stroke.color, width: stroke.width, points: stroke.points.map(turn)) }
        next.masks = next.masks.map { (mask: Mask) -> Mask in Mask(radius: mask.radius, points: mask.points.map(turn)) }
        if let shape = aspect { aspect = 1 / shape }
        commit(next)
    }

    /// The reference's `flipped`: a mirror across the screen's vertical axis.
    @objc private func flip() {
        var next = shown
        next.flip.toggle()
        let mirror = { (point: CGPoint) -> CGPoint in CGPoint(x: 1 - point.x, y: point.y) }
        if let crop = next.crop { next.crop = CGRect(x: 1 - crop.minX - crop.width, y: crop.minY, width: crop.width, height: crop.height) }
        next.strokes = next.strokes.map { (stroke: Stroke) -> Stroke in Stroke(color: stroke.color, width: stroke.width, points: stroke.points.map(mirror)) }
        next.masks = next.masks.map { (mask: Mask) -> Mask in Mask(radius: mask.radius, points: mask.points.map(mirror)) }
        commit(next)
    }

    @objc private func colorChosen(_ sender: UIButton) {
        guard sender.tag < PhotoEditorController.penColors.count else { return }
        penColor = PhotoEditorController.penColors[sender.tag]
        show()
    }

    @objc private func widthChosen(_ sender: UIButton) {
        guard sender.tag < PhotoEditorController.penWidths.count else { return }
        penWidth = PhotoEditorController.penWidths[sender.tag].value
        show()
    }

    @objc private func brushChosen(_ sender: UIButton) {
        guard sender.tag < PhotoEditorController.brushRadii.count else { return }
        brushRadius = PhotoEditorController.brushRadii[sender.tag].value
        show()
    }

    @objc private func backgroundChosen(_ sender: UIButton) {
        var next = shown
        switch sender.tag {
        case 1:
            next.background = "transparent"
            next.document = "none"
            next.format = "png"
        case 2:
            next.background = "white"
            next.document = "none"
        default:
            next.background = "keep"
        }
        commit(next)
    }

    @objc private func documentChosen(_ sender: UIButton) {
        var next = shown
        next.document = sender.tag == 1 ? "bw" : sender.tag == 2 ? "color" : "none"
        if next.document != "none" { next.background = "keep" }
        commit(next)
    }

    @objc private func scaleChosen(_ sender: UIButton) {
        var next = shown
        next.scale = [1, 2, 4][max(0, min(2, sender.tag))]
        commit(next)
    }

    @objc private func sizeChosen(_ sender: UIButton) {
        var next = shown
        next.resolution = sender.tag == 0 ? 1 : 0.5
        commit(next)
    }

    @objc private func formatChosen(_ sender: UIButton) {
        var next = shown
        next.format = sender.tag == 0 ? "jpeg" : "png"
        if next.format == "jpeg" && next.background == "transparent" { return }
        commit(next)
    }

    private func cropDragged(_ crop: CGRect?) {
        guard let crop else { return }
        var next = shown
        next.crop = crop
        commit(next)
    }

    // MARK: The preview of the effects

    /// The effects that need the pixels (the reference's `effectKey`); nil: none.
    private static func effectKey(_ edit: Edit) -> String? {
        guard edit.background != "keep" || edit.document != "none" || !edit.masks.isEmpty else { return nil }
        let masks = edit.masks.map { (mask: Mask) -> String in "\(mask.radius):" + mask.points.map { "\($0.x),\($0.y)" }.joined(separator: ";") }.joined(separator: "|")
        return "\(edit.rotation)/\(edit.flip)/\(edit.background)/\(edit.document)/\(masks)"
    }

    /// Shows the cached preview of the shown effects, or renders it after 400 ms on a background queue.
    private func refreshPreview() {
        previewRevision += 1
        guard let key = PhotoEditorController.effectKey(shown) else {
            canvas.effectImage = nil
            setPreviewBusy(false)
            return
        }
        if let index = previews.firstIndex(where: { $0.key == key }) {
            let kept = previews.remove(at: index)
            previews.append(kept)
            canvas.effectImage = kept.image
            setPreviewBusy(false)
            return
        }
        setPreviewBusy(true)
        let revision = previewRevision
        let edit = shown
        let picture = original
        let scale = traitCollection.displayScale
        let screen = view.bounds.width * view.bounds.height * scale * scale
        let maxPixels = max(65_536, min(2_000_000, Int(screen)))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, revision == self.previewRevision else { return }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let made: Result<UIImage, Error>
                do {
                    let image = try PhotoEditorController.effectPreview(picture, edit: edit, maxPixels: maxPixels)
                    made = .success(image)
                } catch {
                    made = .failure(error)
                }
                DispatchQueue.main.async {
                    guard let self, revision == self.previewRevision else { return }
                    self.setPreviewBusy(false)
                    switch made {
                    case .success(let image):
                        self.previews.append((key: key, image: image))
                        if self.previews.count > 4 { self.previews.removeFirst(self.previews.count - 4) }
                        self.canvas.effectImage = image
                        self.canvas.setNeedsDisplay()
                    case .failure(let error):
                        self.showError(PhotoBitmap.words(error))
                    }
                }
            }
        }
    }

    private func setPreviewBusy(_ on: Bool) {
        previewBusy = on
        busyPill.isHidden = !on
        if on { busySpinner.startAnimating() } else { busySpinner.stopAnimating() }
    }

    /// The effects on the whole turned picture at screen size (no crop, no lines, no enlargement).
    private static func effectPreview(_ image: UIImage, edit: Edit, maxPixels: Int) throws -> UIImage {
        let turned = PhotoEditorCanvas.turned(image, rotation: edit.rotation, flip: edit.flip)
        guard let whole = turned.cgImage else { throw PhotoFailure("PROCESSING_FAILED") }
        let size = try PhotoEditorController.fit(width: whole.width, height: whole.height, limit: maxPixels)
        guard let small = PhotoEditorController.redraw(whole, source: CGRect(x: 0, y: 0, width: whole.width, height: whole.height), width: size.0, height: size.1) else { throw PhotoFailure("OUT_OF_MEMORY") }
        let masks = edit.masks.map { (mask: Mask) -> PhotoStroke in
            PhotoStroke(radius: Double(mask.radius), points: mask.points.map { PhotoPoint(x: Double($0.x), y: Double($0.y)) })
        }
        let done = try effects(small, masks: masks, background: edit.background, document: edit.document, scale: 1)
        return UIImage(cgImage: done)
    }

    // MARK: The result

    /// The reference's PhotoDimensions.plan for this picture (pixel limits of PhotoOptions).
    static func plan(turned: CGSize, edit: Edit) -> (crop: CGRect, width: Int, height: Int, baseWidth: Int, baseHeight: Int, downsampled: Bool) {
        let width = max(1, Int(turned.width)), height = max(1, Int(turned.height))
        var cropRect = CGRect(x: 0, y: 0, width: width, height: height)
        if let selected = edit.crop {
            let left = max(0, min(width - 1, Int(floor(selected.minX * CGFloat(width)))))
            let top = max(0, min(height - 1, Int(floor(selected.minY * CGFloat(height)))))
            let right = max(left + 1, min(width, Int(ceil(selected.maxX * CGFloat(width)))))
            let bottom = max(top + 1, min(height, Int(ceil(selected.maxY * CGFloat(height)))))
            cropRect = CGRect(x: left, y: top, width: right - left, height: bottom - top)
        }
        let requestedWidth = max(1, Int(floor(cropRect.width * edit.resolution)))
        let requestedHeight = max(1, Int(floor(cropRect.height * edit.resolution)))
        let plain = edit.background == "keep" && edit.document == "none" && edit.scale == 1 && edit.masks.isEmpty
        let limit = plain ? 16_000_000 : min(4_000_000, 8_000_000 / (edit.scale * edit.scale))
        let fitted = (try? fit(width: requestedWidth, height: requestedHeight, limit: limit)) ?? (requestedWidth, requestedHeight)
        let downsampled = fitted.0 != requestedWidth || fitted.1 != requestedHeight
        return (cropRect, fitted.0 * edit.scale, fitted.1 * edit.scale, fitted.0, fitted.1, downsampled)
    }

    /// The reference's PhotoDimensions.fit.
    static func fit(width: Int, height: Int, limit: Int) throws -> (Int, Int) {
        guard width > 0, height > 0, width <= 20000, height <= 20000, width * height <= 100_000_000 else { throw PhotoFailure("IMAGE_TOO_LARGE") }
        let pixels = width * height
        if pixels <= limit { return (width, height) }
        let scale = (Double(limit) / Double(pixels)).squareRoot()
        return (max(1, Int(floor(Double(width) * scale))), max(1, Int(floor(Double(height) * scale))))
    }

    /// A part of a bitmap drawn into a fresh sRGB bitmap of the given size (keeps transparency).
    static func redraw(_ image: CGImage, source: CGRect, width: Int, height: Int) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return nil }
        context.interpolationQuality = .high
        let sx = CGFloat(width) / source.width, sy = CGFloat(height) / source.height
        // CoreGraphics counts from the bottom: the wanted part is placed so that its top-left lands at the corner.
        let full = CGRect(x: -source.minX * sx, y: -(CGFloat(image.height) - source.maxY) * sy, width: CGFloat(image.width) * sx, height: CGFloat(image.height) * sy)
        context.draw(image, in: full)
        return context.makeImage()
    }

    /// The reference's render order (LinePhotoModule.render): removal, background, white/document, enlargement.
    private static func effects(_ start: CGImage, masks: [PhotoStroke], background: String, document: String, scale: Int) throws -> CGImage {
        var current = start
        if !masks.isEmpty {
            do {
                current = try PhotoBitmap.image(PhotoPixels.inpaint(PhotoBitmap.pixels(current), strokes: masks))
            } catch let failure as PhotoFailure where failure.reason == "EMPTY_MASK" {
                // Every painted area lies outside the frame: nothing to remove.
            }
        }
        if background != "keep" { current = try PhotoBackground.foreground(current) }
        if background == "white" || document != "none" || scale > 1 {
            var pixels = try PhotoBitmap.pixels(current)
            if background == "white" { pixels = PhotoPixels.whiteBackground(pixels) }
            if document != "none" { pixels = PhotoPixels.document(pixels, monochrome: document == "bw") }
            if scale > 1 { pixels = try PhotoPixels.upscale(pixels, scale: scale) }
            current = try PhotoBitmap.image(pixels)
        }
        return current
    }

    /// The picture as edited: turned and mirrored, cut out and sized, the effects applied, the lines drawn on.
    static func render(_ image: UIImage, edit: Edit) throws -> CGImage {
        let turned = PhotoEditorCanvas.turned(image, rotation: edit.rotation, flip: edit.flip)
        guard let whole = turned.cgImage else { throw PhotoFailure("PROCESSING_FAILED") }
        let size = CGSize(width: whole.width, height: whole.height)
        let plan = PhotoEditorController.plan(turned: size, edit: edit)
        guard var current = redraw(whole, source: plan.crop, width: plan.baseWidth, height: plan.baseHeight) else { throw PhotoFailure("OUT_OF_MEMORY") }
        // The painted areas and the lines are normalized to the whole turned picture: into the frame's own units.
        let crop = CGRect(x: plan.crop.minX / size.width, y: plan.crop.minY / size.height, width: plan.crop.width / size.width, height: plan.crop.height / size.height)
        let unit = min(size.width, size.height) / max(1, min(plan.crop.width, plan.crop.height))
        let inFrame = { (point: CGPoint) -> PhotoPoint in PhotoPoint(x: Double((point.x - crop.minX) / crop.width), y: Double((point.y - crop.minY) / crop.height)) }
        let masks = edit.masks.map { (mask: Mask) -> PhotoStroke in PhotoStroke(radius: Double(max(0.0005, min(2, mask.radius * unit))), points: mask.points.map(inFrame)) }
        current = try effects(current, masks: masks, background: edit.background, document: edit.document, scale: edit.scale)
        if !edit.strokes.isEmpty {
            let lines = edit.strokes.map { (stroke: Stroke) -> Stroke in
                Stroke(color: stroke.color, width: min(2, stroke.width * unit), points: stroke.points.map { (point: CGPoint) -> CGPoint in
                    let mapped = inFrame(point)
                    return CGPoint(x: mapped.x, y: mapped.y)
                })
            }
            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(data: nil, width: current.width, height: current.height, bitsPerComponent: 8, bytesPerRow: current.width * 4, space: space,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { throw PhotoFailure("OUT_OF_MEMORY") }
            let outSize = CGSize(width: current.width, height: current.height)
            context.draw(current, in: CGRect(origin: .zero, size: outSize))
            // The lines are given top-down.
            context.translateBy(x: 0, y: outSize.height)
            context.scaleBy(x: 1, y: -1)
            PhotoEditorCanvas.drawStrokes(lines, in: context, size: outSize)
            guard let drawn = context.makeImage() else { throw PhotoFailure("PROCESSING_FAILED") }
            current = drawn
        }
        return current
    }

    @objc private func cancelNow() {
        guard !busy else { return }
        let cancel = onCancel
        dismiss(animated: true) { cancel?() }
    }

    @objc private func sendNow() {
        guard !busy else { return }
        let done = onDone
        let edit = shown
        // Nothing changed: the same path as sending without the editor.
        guard edit != Edit() else {
            dismiss(animated: true) { done?(nil) }
            return
        }
        let plan = PhotoEditorController.plan(turned: canvas.turnedSize, edit: edit)
        if plan.downsampled {
            let alert = UIAlertController(title: "Фото будет уменьшено", message: "Фото будет уменьшено до \(plan.width) × \(plan.height), чтобы обработка поместилась в память устройства.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
            alert.addAction(UIAlertAction(title: "Отправить", style: .default, handler: { [weak self] (_: UIAlertAction) -> Void in self?.renderAndSend(edit) }))
            present(alert, animated: true)
            return
        }
        renderAndSend(edit)
    }

    private func renderAndSend(_ edit: Edit) {
        busy = true
        errorWords = ""
        sendButton.setImage(nil, for: .normal)
        sendSpinner.startAnimating()
        sendButton.accessibilityLabel = "Готовим фото"
        hint2.text = "Готовим фото…"
        show()
        let picture = original
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let made: Result<CGImage, Error>
            do { made = .success(try PhotoEditorController.render(picture, edit: edit)) } catch { made = .failure(error) }
            DispatchQueue.main.async {
                guard let self else { return }
                switch made {
                case .success(let image):
                    let done = self.onDone
                    self.dismiss(animated: true) { done?(Output(image: image, format: edit.format)) }
                case .failure(let error):
                    self.busy = false
                    self.sendSpinner.stopAnimating()
                    self.sendButton.setImage(chatSymbol("checkmark", 24, .semibold), for: .normal)
                    self.sendButton.accessibilityLabel = "Отправить фото"
                    self.errorWords = PhotoBitmap.words(error)
                    self.show()
                }
            }
        }
    }

    #if targetEnvironment(simulator)
    /// `-photoeditor crop|draw|size|remove|background|enhance`: the editor on a tab, with a square frame, a line,
    /// a painted area, «Белый» or «Ч/б документ».
    func simulatorShow(_ tool: String) {
        loadViewIfNeeded()
        editorTab = PhotoEditorController.tabs.contains(where: { $0.id == tool }) ? tool : "crop"
        var next = shown
        switch editorTab {
        case "crop":
            aspect = 1
            let turned = canvas.turnedSize
            let sourceAspect = turned.width / max(1, turned.height)
            next.crop = CGRect(x: (1 - 1 / sourceAspect) / 2, y: 0, width: 1 / sourceAspect, height: 1)
        case "draw":
            next.strokes.append(Stroke(color: 0xFF3B30, width: 0.012, points: [CGPoint(x: 0.2, y: 0.6), CGPoint(x: 0.35, y: 0.45), CGPoint(x: 0.5, y: 0.62), CGPoint(x: 0.7, y: 0.4)]))
        case "remove":
            // Over the drawn sun of the sample picture.
            next.masks.append(Mask(radius: 0.05, points: [CGPoint(x: 0.68, y: 0.25), CGPoint(x: 0.72, y: 0.3), CGPoint(x: 0.76, y: 0.25)]))
        case "background":
            next.background = "white"
        case "enhance":
            next.document = "bw"
        default:
            next.format = "jpeg"
        }
        commit(next)
        show()
    }
    #endif

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, safe = view.safeAreaInsets
        let top = safe.top
        closeButton.frame = CGRect(x: 8, y: top + 4, width: 44, height: 44)
        undoButton.frame = CGRect(x: 56, y: top + 4, width: 44, height: 44)
        redoButton.frame = CGRect(x: 100, y: top + 4, width: 44, height: 44)
        resetButton.frame = CGRect(x: width - 104, y: top + 4, width: 96, height: 44)
        let bottom = view.bounds.height - safe.bottom
        var y = bottom
        if !(hint2.text ?? "").isEmpty && busy {
            hint2.frame = CGRect(x: 16, y: y - 18, width: width - 32, height: 16)
            hint2.textAlignment = .center
            y -= 22
        }
        let tabY = y - 62
        sendButton.frame = CGRect(x: width - 12 - 54, y: tabY + 1, width: 54, height: 54)
        sendSpinner.frame = sendButton.bounds
        tabsRow.frame = CGRect(x: 0, y: tabY, width: max(0, width - 12 - 54 - 6), height: 58)
        var x: CGFloat = 8
        for button in tabButtons {
            let fitted = button.sizeThatFits(CGSize(width: 120, height: 56))
            let w = min(110, max(62, ceil(fitted.width)))
            button.frame = CGRect(x: x, y: 1, width: w, height: 56)
            x += w + 2
        }
        tabsRow.contentSize = CGSize(width: x + 8, height: 58)
        tabsRow.clipsToBounds = true // the row ends before the confirm disc (EditorPanels.tsx)
        // The active tab is scrolled into view (a tab chosen elsewhere, the editor opened on «Размер и формат»).
        if shownTab != editorTab, tabsRow.bounds.width > 0, let active = tabButtons.first(where: { (button: UIButton) -> Bool in button.accessibilityIdentifier == editorTab }) {
            shownTab = editorTab
            tabsRow.scrollRectToVisible(active.frame.insetBy(dx: -8, dy: 0), animated: false)
        }
        y = tabY - 10
        for label in [hint2, hint] where !(label.text ?? "").isEmpty && !(label === hint2 && busy) {
            label.textAlignment = .left
            let height = ceil(label.sizeThatFits(CGSize(width: width - 32, height: 60)).height)
            label.frame = CGRect(x: 16, y: y - height, width: width - 32, height: height)
            y -= height + 8
        }
        if (hint.text ?? "").isEmpty { hint.frame = .zero }
        if (hint2.text ?? "").isEmpty { hint2.frame = .zero }
        if tools2.subviews.isEmpty {
            tools2.frame = .zero
        } else {
            tools2.frame = CGRect(x: 0, y: y - 40, width: width, height: 40)
            y -= 49
        }
        tools.frame = CGRect(x: 0, y: y - 40, width: width, height: 40)
        y -= 46
        if errorWords.isEmpty {
            errorLabel.frame = .zero
        } else {
            let height = ceil(errorLabel.sizeThatFits(CGSize(width: width - 32, height: 40)).height)
            errorLabel.frame = CGRect(x: 16, y: y - height, width: width - 32, height: height)
            y -= height + 6
        }
        canvas.frame = CGRect(x: 0, y: top + 52, width: width, height: max(0, y - top - 52))
        let labelWidth = ceil(busyLabel.intrinsicContentSize.width)
        let pillWidth = 14 + 20 + 8 + labelWidth + 14
        busyPill.frame = CGRect(x: (width - pillWidth) / 2, y: canvas.frame.minY + 12, width: pillWidth, height: 34)
        busySpinner.frame = CGRect(x: 14, y: 7, width: 20, height: 20)
        busyLabel.frame = CGRect(x: 42, y: 0, width: labelWidth, height: 34)
    }
}

/// The picture being edited, with the frame of the crop, the painted areas and the drawing on it. A drag makes
/// the frame («Обрезка»), draws («Рисование») or paints what to remove («Убрать объект»).
final class PhotoEditorCanvas: UIView {
    var image: UIImage? { didSet { cachedTurn = nil } }
    var edit = PhotoEditorController.Edit()
    /// crop · draw · remove · view
    var tool = "crop"
    var aspect: CGFloat?
    var penColor: UInt32 = 0xFF3B30
    var penWidth: CGFloat = 0.012
    var brushRadius: CGFloat = 0.02
    /// «Убрать объект» shows the painted areas.
    var showMask = false
    /// «Без фона»: a checkerboard behind the picture.
    var transparent = false
    /// The effects as rendered for the screen (already turned); nil: the plain picture.
    var effectImage: UIImage?
    /// A frame was dragged (normalized to the turned picture).
    var onCrop: ((CGRect?) -> Void)?
    /// A line was drawn (normalized to the turned picture).
    var onStroke: ((PhotoEditorController.Stroke) -> Void)?
    /// An area to remove was painted.
    var onMask: ((PhotoEditorController.Mask) -> Void)?

    private var dragStart: CGPoint?
    private var dragging: CGRect?
    private var drawing: PhotoEditorController.Stroke?
    private var painting: PhotoEditorController.Mask?
    private var cachedTurn: (rotation: Int, flip: Bool, image: UIImage)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityLabel = "Редактируемое фото"
        addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(panned(_:))))
    }

    required init?(coder: NSCoder) { return nil }

    /// The picture turned and mirrored as the edit says (kept while the turn stays the same).
    private var turnedImage: UIImage? {
        guard let image else { return nil }
        if let cached = cachedTurn, cached.rotation == edit.rotation, cached.flip == edit.flip { return cached.image }
        let made = PhotoEditorCanvas.turned(image, rotation: edit.rotation, flip: edit.flip)
        cachedTurn = (edit.rotation, edit.flip, made)
        return made
    }

    var turnedSize: CGSize {
        guard let image else { return CGSize(width: 1, height: 1) }
        let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        return edit.rotation % 180 == 0 ? size : CGSize(width: size.height, height: size.width)
    }

    /// The reference's transform: the picture turned clockwise by `rotation`, then mirrored on screen.
    static func turned(_ image: UIImage, rotation: Int, flip: Bool) -> UIImage {
        let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let quarter = rotation % 180 != 0
        let out = quarter ? CGSize(width: size.height, height: size.width) : size
        if rotation == 0 && !flip && image.scale == 1 && image.imageOrientation == .up && image.cgImage != nil { return image }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        return UIGraphicsImageRenderer(size: out, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
            let cg = context.cgContext
            cg.translateBy(x: out.width / 2, y: out.height / 2)
            if flip { cg.scaleBy(x: -1, y: 1) }
            cg.rotate(by: CGFloat(rotation) * .pi / 180)
            image.draw(in: CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height))
        }
    }

    static func drawStrokes(_ strokes: [PhotoEditorController.Stroke], in context: CGContext, size: CGSize) {
        let side = min(size.width, size.height)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        for stroke in strokes where !stroke.points.isEmpty {
            context.setStrokeColor(UIColor(hex: stroke.color).cgColor)
            context.setLineWidth(max(1, stroke.width * side))
            let first = stroke.points[0]
            context.move(to: CGPoint(x: first.x * size.width, y: first.y * size.height))
            if stroke.points.count == 1 { context.addLine(to: CGPoint(x: first.x * size.width + 0.1, y: first.y * size.height)) }
            for point in stroke.points.dropFirst() { context.addLine(to: CGPoint(x: point.x * size.width, y: point.y * size.height)) }
            context.strokePath()
        }
    }

    /// The painted areas as the reference shows them: a translucent band twice the brush radius wide.
    static func drawMasks(_ masks: [PhotoEditorController.Mask], in context: CGContext, size: CGSize) {
        let side = min(size.width, size.height)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        context.setStrokeColor(UIColor(red: 234 / 255, green: 55 / 255, blue: 122 / 255, alpha: 0.5).cgColor)
        for mask in masks where !mask.points.isEmpty {
            context.setLineWidth(max(1, 2 * mask.radius * side))
            let first = mask.points[0]
            context.move(to: CGPoint(x: first.x * size.width, y: first.y * size.height))
            if mask.points.count == 1 { context.addLine(to: CGPoint(x: first.x * size.width + 0.1, y: first.y * size.height)) }
            for point in mask.points.dropFirst() { context.addLine(to: CGPoint(x: point.x * size.width, y: point.y * size.height)) }
            context.strokePath()
        }
    }

    /// Where the turned picture stands in the view (the reference's `containRect`).
    private var pictureRect: CGRect {
        let size = turnedSize
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        let width = size.width * scale, height = size.height * scale
        return CGRect(x: (bounds.width - width) / 2, y: (bounds.height - height) / 2, width: width, height: height)
    }

    private func normalized(_ point: CGPoint) -> CGPoint {
        let rect = pictureRect
        return CGPoint(x: max(0, min(1, (point.x - rect.minX) / rect.width)), y: max(0, min(1, (point.y - rect.minY) / rect.height)))
    }

    /// The reference's `cropFromDrag` (and a fixed shape kept inside the drag).
    private func frame(from start: CGPoint, to end: CGPoint) -> CGRect? {
        var x = min(start.x, end.x), y = min(start.y, end.y)
        var width = min(1, max(start.x, end.x)) - x
        var height = min(1, max(start.y, end.y)) - y
        if let aspect, width > 0, height > 0 {
            let size = turnedSize
            let wanted = aspect * size.height / size.width
            if width / height > wanted { width = height * wanted } else { height = width / wanted }
            if end.x < start.x { x = start.x - width }
            if end.y < start.y { y = start.y - height }
        }
        guard width >= 0.01, height >= 0.01 else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        let point = normalized(pan.location(in: self))
        switch pan.state {
        case .began:
            if tool == "draw" {
                drawing = PhotoEditorController.Stroke(color: penColor, width: penWidth, points: [point])
            } else if tool == "remove" {
                painting = PhotoEditorController.Mask(radius: brushRadius, points: [point])
            } else if tool == "crop" {
                dragStart = point
            }
        case .changed:
            if tool == "draw", var stroke = drawing {
                // A new point only once the finger moved a third of the line's width (the reference's appendBrushPoint).
                if let last = stroke.points.last, hypot(point.x - last.x, point.y - last.y) >= penWidth / 3, stroke.points.count < 2000 { stroke.points.append(point) }
                drawing = stroke
            } else if tool == "remove", var mask = painting {
                if let last = mask.points.last, hypot(point.x - last.x, point.y - last.y) >= brushRadius / 3, mask.points.count < PhotoEditorController.maxMaskPoints { mask.points.append(point) }
                painting = mask
            } else if tool == "crop", let start = dragStart {
                dragging = frame(from: start, to: point)
            }
            setNeedsDisplay()
        case .ended, .cancelled:
            if tool == "draw", let stroke = drawing { onStroke?(stroke) }
            if tool == "remove", let mask = painting { onMask?(mask) }
            if tool == "crop", let made = dragging { onCrop?(made) }
            drawing = nil
            painting = nil
            dragging = nil
            dragStart = nil
            setNeedsDisplay()
        default:
            break
        }
    }

    /// The reference's Checkerboard: 20 pt squares of two light greys.
    private func drawChecker(_ box: CGRect, in context: CGContext) {
        context.saveGState()
        context.clip(to: box)
        context.setFillColor(UIColor(hex: 0xE3E6EB).cgColor)
        context.fill(box)
        context.setFillColor(UIColor(hex: 0xF8F9FC).cgColor)
        var y = box.minY
        while y < box.maxY {
            var x = box.minX
            while x < box.maxX {
                context.fill(CGRect(x: x, y: y, width: 10, height: 10))
                context.fill(CGRect(x: x + 10, y: y + 10, width: 10, height: 10))
                x += 20
            }
            y += 20
        }
        context.restoreGState()
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext(), let plain = turnedImage else { return }
        let box = pictureRect
        if transparent { drawChecker(box, in: context) }
        (effectImage ?? plain).draw(in: box)
        context.saveGState()
        context.translateBy(x: box.minX, y: box.minY)
        var masks = showMask ? edit.masks : []
        if let painting { masks.append(painting) }
        PhotoEditorCanvas.drawMasks(masks, in: context, size: box.size)
        var strokes = edit.strokes
        if let drawing { strokes.append(drawing) }
        PhotoEditorCanvas.drawStrokes(strokes, in: context, size: box.size)
        context.restoreGState()
        // The crop: outside the frame dimmed, the frame itself with its thirds and corners.
        guard let crop = dragging ?? edit.crop else { return }
        let frame = CGRect(x: box.minX + crop.minX * box.width, y: box.minY + crop.minY * box.height, width: crop.width * box.width, height: crop.height * box.height)
        context.setFillColor(UIColor(white: 0, alpha: 0.55).cgColor)
        let outside = UIBezierPath(rect: box)
        outside.append(UIBezierPath(rect: frame).reversing())
        context.addPath(outside.cgPath)
        context.fillPath()
        context.setStrokeColor(UIColor.white.cgColor)
        context.setLineWidth(1.5)
        context.stroke(frame)
        context.setStrokeColor(UIColor(white: 1, alpha: 0.55).cgColor)
        context.setLineWidth(0.5)
        for third in [1.0 / 3.0, 2.0 / 3.0] {
            context.move(to: CGPoint(x: frame.minX + frame.width * CGFloat(third), y: frame.minY))
            context.addLine(to: CGPoint(x: frame.minX + frame.width * CGFloat(third), y: frame.maxY))
            context.move(to: CGPoint(x: frame.minX, y: frame.minY + frame.height * CGFloat(third)))
            context.addLine(to: CGPoint(x: frame.maxX, y: frame.minY + frame.height * CGFloat(third)))
        }
        context.strokePath()
        // The reference's corner marks: 22 pt, 4 pt thick, 3 pt outside the frame.
        context.setStrokeColor(UIColor.white.cgColor)
        context.setLineWidth(4)
        let o: CGFloat = 1, l: CGFloat = 22
        let corners: [(CGPoint, CGFloat, CGFloat)] = [(CGPoint(x: frame.minX - o, y: frame.minY - o), 1, 1), (CGPoint(x: frame.maxX + o, y: frame.minY - o), -1, 1),
                                                      (CGPoint(x: frame.minX - o, y: frame.maxY + o), 1, -1), (CGPoint(x: frame.maxX + o, y: frame.maxY + o), -1, -1)]
        for (corner, dx, dy) in corners {
            context.move(to: CGPoint(x: corner.x + dx * l, y: corner.y))
            context.addLine(to: corner)
            context.addLine(to: CGPoint(x: corner.x, y: corner.y + dy * l))
        }
        context.strokePath()
    }
}
