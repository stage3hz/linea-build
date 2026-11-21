import UIKit

/// The photo editor before sending (the reference's photo/editor/PhotoEditorScreen.tsx with EditorPanels.tsx and
/// editorHistory.ts): «Обрезка» (free or 1:1, 4:3, 3:4, 16:9 by dragging a frame; «Повернуть на 90°», «Отразить»),
/// «Рисование» (eight colours, three widths) and «Размер и формат» (full size or half), with undo, redo and
/// «Сбросить». The edited picture is drawn anew here and then cleaned like any photo (`PhotoPrepare`): nothing of
/// the original's metadata survives. Removing an object, the background and the document modes of the reference
/// need its image models and are not here.
final class PhotoEditorController: UIViewController {
    /// One state of the edit (the reference's EditState, the parts this editor has).
    struct Edit: Equatable {
        var rotation = 0
        var flip = false
        /// Normalized to the turned picture; nil: the whole picture.
        var crop: CGRect?
        var strokes: [Stroke] = []
        /// 1 or 0.5.
        var resolution: CGFloat = 1
    }

    struct Stroke: Equatable {
        let color: UInt32
        let width: CGFloat
        var points: [CGPoint]
    }

    static let penColors: [UInt32] = [0xFFFFFF, 0x111111, 0xFF3B30, 0xFF9500, 0xFFCC00, 0x34C759, 0x0A84FF, 0xAF52DE]
    static let colorNames = ["Белый", "Чёрный", "Красный", "Оранжевый", "Жёлтый", "Зелёный", "Синий", "Фиолетовый"]
    static let penWidths: [(label: String, value: CGFloat)] = [("Тонкая", 0.006), ("Средняя", 0.012), ("Широкая", 0.024)]
    static let aspects: [(label: String, spoken: String, value: CGFloat?)] = [("Свободно", "Свободная обрезка", nil), ("1:1", "Квадрат", 1), ("4:3", "Четыре к трём", 4.0 / 3.0),
                                                                             ("3:4", "Три к четырём", 3.0 / 4.0), ("16:9", "Шестнадцать к девяти", 16.0 / 9.0)]
    private static let accent = UIColor(hex: 0x4DA3FF)

    private let original: UIImage
    /// The finished picture (`nil` when nothing was changed: the original goes as it is).
    var onDone: ((UIImage?) -> Void)?
    var onCancel: (() -> Void)?

    private var history: [Edit] = [Edit()]
    private var at = 0
    private var present: Edit { history[at] }
    private var editorTab = "crop"
    private var aspect: CGFloat?
    private var penColor: UInt32 = 0xFF3B30
    private var penWidth: CGFloat = 0.012

    private let closeButton = UIButton(type: .system)
    private let undoButton = UIButton(type: .system)
    private let redoButton = UIButton(type: .system)
    private let resetButton = UIButton(type: .system)
    private let canvas = PhotoEditorCanvas()
    private let tools = UIScrollView()
    private let tools2 = UIScrollView()
    private let hint = UILabel()
    private var tabButtons: [UIButton] = []
    private let sendButton = UIButton(type: .custom)

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
            var next = self.present
            next.strokes.append(stroke)
            self.commit(next)
        }
        view.addSubview(canvas)
        tools.showsHorizontalScrollIndicator = false
        tools2.showsHorizontalScrollIndicator = false
        view.addSubview(tools)
        view.addSubview(tools2)
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = UIColor(hex: 0x9AA3B2)
        hint.numberOfLines = 2
        view.addSubview(hint)
        for (index, item) in [("crop", "crop", "Обрезка"), ("draw", "paintbrush.pointed", "Рисование"), ("size", "arrow.up.left.and.arrow.down.right", "Размер и формат")].enumerated() {
            let button = UIButton(type: .custom)
            button.tag = index
            button.accessibilityIdentifier = item.0
            var config = UIButton.Configuration.plain()
            config.image = chatSymbol(item.1, 21)
            config.imagePlacement = .top
            config.imagePadding = 3
            config.attributedTitle = AttributedString(item.2, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 10.5)]))
            button.configuration = config
            button.layer.cornerRadius = 12
            button.accessibilityLabel = item.2
            button.addTarget(self, action: #selector(tabChosen(_:)), for: .touchUpInside)
            view.addSubview(button)
            tabButtons.append(button)
        }
        sendButton.backgroundColor = UIColor(hex: 0x0A84FF)
        sendButton.layer.cornerRadius = 27
        sendButton.setImage(chatSymbol("checkmark", 24, .semibold), for: .normal)
        sendButton.tintColor = .white
        sendButton.accessibilityLabel = "Отправить фото"
        sendButton.addTarget(self, action: #selector(sendNow), for: .touchUpInside)
        view.addSubview(sendButton)
        show()
    }

    // MARK: The history

    private func commit(_ next: Edit) {
        guard next != present else { return }
        history = Array(history.prefix(at + 1)) + [next]
        // The reference keeps a long but bounded history.
        if history.count > 60 { history.removeFirst(history.count - 60) }
        at = history.count - 1
        show()
    }

    @objc private func undo() {
        guard at > 0 else { return }
        at -= 1
        UISelectionFeedbackGenerator().selectionChanged()
        show()
    }

    @objc private func redo() {
        guard at + 1 < history.count else { return }
        at += 1
        UISelectionFeedbackGenerator().selectionChanged()
        show()
    }

    @objc private func reset() {
        aspect = nil
        commit(Edit())
    }

    // MARK: The tools

    @objc private func tabChosen(_ sender: UIButton) {
        editorTab = sender.accessibilityIdentifier ?? "crop"
        show()
    }

    private func chip(_ label: String, spoken: String? = nil, selected: Bool, action: Selector, tag: Int) -> UIButton {
        let button = UIButton(type: .custom)
        button.setTitle(label, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
        button.setTitleColor(selected ? PhotoEditorController.accent : UIColor(hex: 0xF2F4F8), for: .normal)
        button.backgroundColor = selected ? UIColor(red: 10 / 255, green: 132 / 255, blue: 1, alpha: 0.28) : UIColor(white: 1, alpha: 0.09)
        button.layer.cornerRadius = 16
        button.contentEdgeInsets = UIEdgeInsets(top: 9, left: 13, bottom: 9, right: 13)
        button.accessibilityLabel = spoken ?? label
        button.accessibilityTraits = selected ? [.button, .selected] : .button
        button.tag = tag
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    private func fill(_ row: UIScrollView, _ items: [UIView]) {
        row.subviews.forEach { $0.removeFromSuperview() }
        var x: CGFloat = 14
        for item in items {
            let size = item.intrinsicContentSize
            let width = item is UIButton && (item as? UIButton)?.title(for: .normal) == nil ? 30 : size.width
            item.frame = CGRect(x: x, y: 2, width: width, height: max(30, size.height))
            row.addSubview(item)
            x += width + 8
        }
        row.contentSize = CGSize(width: x + 6, height: 40)
    }

    private func show() {
        undoButton.isEnabled = at > 0
        undoButton.alpha = at > 0 ? 1 : 0.4
        redoButton.isEnabled = at + 1 < history.count
        redoButton.alpha = redoButton.isEnabled ? 1 : 0.4
        let edited = present != Edit()
        resetButton.isEnabled = edited
        resetButton.alpha = edited ? 1 : 0.4
        canvas.edit = present
        canvas.tool = editorTab
        canvas.aspect = aspect
        canvas.penColor = penColor
        canvas.penWidth = penWidth
        canvas.setNeedsDisplay()
        for button in tabButtons {
            let on = button.accessibilityIdentifier == editorTab
            button.backgroundColor = on ? UIColor(red: 10 / 255, green: 132 / 255, blue: 1, alpha: 0.2) : .clear
            button.tintColor = on ? PhotoEditorController.accent : .white
            var config = button.configuration
            config?.baseForegroundColor = on ? PhotoEditorController.accent : UIColor(hex: 0xD8DCE4)
            button.configuration = config
        }
        hint.text = ""
        switch editorTab {
        case "crop":
            var aspectChips: [UIView] = []
            for (index, item) in PhotoEditorController.aspects.enumerated() {
                aspectChips.append(chip(item.label, spoken: item.spoken, selected: aspect == item.value, action: #selector(aspectChosen(_:)), tag: index))
            }
            fill(tools, aspectChips)
            fill(tools2, [chip("↻  Повернуть на 90°", spoken: "Повернуть на 90°", selected: false, action: #selector(rotate), tag: 0),
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
        default:
            fill(tools, [chip("Полное", spoken: "Полный размер", selected: present.resolution == 1, action: #selector(sizeChosen(_:)), tag: 0),
                         chip("50 %", spoken: "Половина размера", selected: present.resolution == 0.5, action: #selector(sizeChosen(_:)), tag: 1)])
            fill(tools2, [])
            let size = resultSize()
            hint.text = "Результат: \(Int(size.width)) × \(Int(size.height)). EXIF, GPS и личные метаданные удаляются."
        }
        view.setNeedsLayout()
    }

    @objc private func aspectChosen(_ sender: UIButton) {
        guard sender.tag < PhotoEditorController.aspects.count else { return }
        aspect = PhotoEditorController.aspects[sender.tag].value
        // A fixed shape starts as the largest frame of that shape in the middle (the reference's `centeredCrop`).
        var next = present
        if let aspect {
            let turned = canvas.turnedSize
            let sourceAspect = turned.width / max(1, turned.height)
            let width = min(1, aspect / sourceAspect), height = min(1, sourceAspect / aspect)
            next.crop = CGRect(x: (1 - width) / 2, y: (1 - height) / 2, width: width, height: height)
        } else {
            next.crop = nil
        }
        commit(next)
        show()
    }

    @objc private func rotate() {
        var next = present
        next.rotation = (next.rotation + 90) % 360
        next.crop = nil
        next.strokes = []
        commit(next)
    }

    @objc private func flip() {
        var next = present
        next.flip.toggle()
        next.crop = nil
        next.strokes = []
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

    @objc private func sizeChosen(_ sender: UIButton) {
        var next = present
        next.resolution = sender.tag == 0 ? 1 : 0.5
        commit(next)
    }

    private func cropDragged(_ crop: CGRect?) {
        guard let crop else { return }
        var next = present
        next.crop = crop
        commit(next)
    }

    // MARK: The result

    private func resultSize() -> CGSize {
        let turned = canvas.turnedSize
        let crop = present.crop ?? CGRect(x: 0, y: 0, width: 1, height: 1)
        return CGSize(width: max(1, floor(turned.width * crop.width * present.resolution)), height: max(1, floor(turned.height * crop.height * present.resolution)))
    }

    @objc private func cancelNow() {
        let cancel = onCancel
        dismiss(animated: true) { cancel?() }
    }

    @objc private func sendNow() {
        let done = onDone
        let edit = present
        guard edit != Edit() else {
            dismiss(animated: true) { done?(nil) }
            return
        }
        let made = PhotoEditorController.render(original, edit: edit)
        dismiss(animated: true) { done?(made) }
    }

    /// The picture as edited: turned and mirrored, drawn on, cut out and sized.
    static func render(_ image: UIImage, edit: Edit) -> UIImage {
        let turned = PhotoEditorCanvas.turned(image, rotation: edit.rotation, flip: edit.flip)
        let size = turned.size
        let crop = edit.crop ?? CGRect(x: 0, y: 0, width: 1, height: 1)
        let pixels = CGRect(x: floor(crop.minX * size.width), y: floor(crop.minY * size.height), width: ceil(crop.width * size.width), height: ceil(crop.height * size.height))
        let outSize = CGSize(width: max(1, floor(pixels.width * edit.resolution)), height: max(1, floor(pixels.height * edit.resolution)))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: outSize, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
            let scale = edit.resolution
            context.cgContext.translateBy(x: -pixels.minX * scale, y: -pixels.minY * scale)
            context.cgContext.scaleBy(x: scale, y: scale)
            turned.draw(in: CGRect(origin: .zero, size: size))
            PhotoEditorCanvas.drawStrokes(edit.strokes, in: context.cgContext, size: size)
        }
    }

    #if targetEnvironment(simulator)
    /// `-photoeditor crop|draw|size`: the editor on a tab, with a square frame or a line drawn.
    func simulatorShow(_ tool: String) {
        loadViewIfNeeded()
        editorTab = tool == "draw" || tool == "size" ? tool : "crop"
        if editorTab == "crop" {
            aspect = 1
            var next = present
            let turned = canvas.turnedSize
            let sourceAspect = turned.width / max(1, turned.height)
            next.crop = CGRect(x: (1 - 1 / sourceAspect) / 2, y: 0, width: 1 / sourceAspect, height: 1)
            commit(next)
        } else if editorTab == "draw" {
            var next = present
            next.strokes.append(Stroke(color: 0xFF3B30, width: 0.012, points: [CGPoint(x: 0.2, y: 0.6), CGPoint(x: 0.35, y: 0.45), CGPoint(x: 0.5, y: 0.62), CGPoint(x: 0.7, y: 0.4)]))
            commit(next)
        }
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
        let tabY = bottom - 62
        var x: CGFloat = 8
        for button in tabButtons {
            button.frame = CGRect(x: x, y: tabY, width: 84, height: 56)
            x += 86
        }
        sendButton.frame = CGRect(x: width - 12 - 54, y: tabY + 1, width: 54, height: 54)
        var y = tabY - 10
        if !(hint.text ?? "").isEmpty {
            hint.frame = CGRect(x: 16, y: y - 34, width: width - 32, height: 34)
            y -= 40
        } else {
            hint.frame = .zero
        }
        if tools2.subviews.isEmpty {
            tools2.frame = .zero
        } else {
            tools2.frame = CGRect(x: 0, y: y - 40, width: width, height: 40)
            y -= 49
        }
        tools.frame = CGRect(x: 0, y: y - 40, width: width, height: 40)
        y -= 50
        canvas.frame = CGRect(x: 0, y: top + 52, width: width, height: max(0, y - top - 52))
    }
}

/// The picture being edited, with the frame of the crop and the drawing on it. A drag makes the frame
/// («Обрезка») or draws («Рисование»).
final class PhotoEditorCanvas: UIView {
    var image: UIImage? { didSet { cachedTurn = nil } }
    var edit = PhotoEditorController.Edit()
    var tool = "crop"
    var aspect: CGFloat?
    var penColor: UInt32 = 0xFF3B30
    var penWidth: CGFloat = 0.012
    /// A frame was dragged (normalized to the turned picture).
    var onCrop: ((CGRect?) -> Void)?
    /// A line was drawn (normalized to the turned picture).
    var onStroke: ((PhotoEditorController.Stroke) -> Void)?

    private var dragStart: CGPoint?
    private var dragging: CGRect?
    private var drawing: PhotoEditorController.Stroke?
    private var cachedTurn: (rotation: Int, flip: Bool, image: UIImage)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityLabel = "Фото"
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

    static func turned(_ image: UIImage, rotation: Int, flip: Bool) -> UIImage {
        let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let quarter = rotation % 180 != 0
        let out = quarter ? CGSize(width: size.height, height: size.width) : size
        if rotation == 0 && !flip && image.scale == 1 && image.imageOrientation == .up { return image }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: out, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
            let cg = context.cgContext
            cg.translateBy(x: out.width / 2, y: out.height / 2)
            cg.rotate(by: CGFloat(rotation) * .pi / 180)
            if flip { cg.scaleBy(x: -1, y: 1) }
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
            } else if tool == "crop" {
                dragStart = point
            }
        case .changed:
            if tool == "draw", var stroke = drawing {
                // A new point only once the finger moved a third of the line's width (the reference's appendBrushPoint).
                if let last = stroke.points.last, hypot(point.x - last.x, point.y - last.y) >= penWidth / 3, stroke.points.count < 2000 { stroke.points.append(point) }
                drawing = stroke
            } else if tool == "crop", let start = dragStart {
                dragging = frame(from: start, to: point)
            }
            setNeedsDisplay()
        case .ended, .cancelled:
            if tool == "draw", let stroke = drawing { onStroke?(stroke) }
            if tool == "crop", let made = dragging { onCrop?(made) }
            drawing = nil
            dragging = nil
            dragStart = nil
            setNeedsDisplay()
        default:
            break
        }
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext(), let picture = turnedImage else { return }
        let box = pictureRect
        picture.draw(in: box)
        context.saveGState()
        context.translateBy(x: box.minX, y: box.minY)
        var strokes = edit.strokes
        if let drawing { strokes.append(drawing) }
        PhotoEditorCanvas.drawStrokes(strokes, in: context, size: box.size)
        context.restoreGState()
        // The crop: outside the frame dimmed, the frame itself with its thirds.
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
        context.setStrokeColor(UIColor(white: 1, alpha: 0.35).cgColor)
        context.setLineWidth(0.5)
        for third in [1.0 / 3.0, 2.0 / 3.0] {
            context.move(to: CGPoint(x: frame.minX + frame.width * CGFloat(third), y: frame.minY))
            context.addLine(to: CGPoint(x: frame.minX + frame.width * CGFloat(third), y: frame.maxY))
            context.move(to: CGPoint(x: frame.minX, y: frame.minY + frame.height * CGFloat(third)))
            context.addLine(to: CGPoint(x: frame.maxX, y: frame.minY + frame.height * CGFloat(third)))
        }
        context.strokePath()
    }
}
