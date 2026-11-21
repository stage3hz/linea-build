import UIKit

/// «Эквалайзер» in the layout of the AirPods settings (mobile/src/music/EqualizerScreen.tsx): «Рекомендованный /
/// Пользовательский», the playing track with ▶ to listen while adjusting, a curve with three points (НЧ, СЧ, ВЧ)
/// dragged up and down, «Сбросить». One setting for the speaker, wired and Bluetooth headphones. It slides up over
/// the player on the same living background as the music home screen and closes by pulling it down.
final class EqualizerViewController: UIViewController {
    private let ambient = MusicAmbientView(tone: MusicAmbientView.themeTone)
    private let scroll = UIScrollView()
    private let column = UIStackView()
    private var modeRows: [(mode: String, check: UIImageView)] = []
    private let trackCard = UIView()
    private let cover = MusicCoverView(radius: 14)
    private let trackTitle = AIKit.label("", size: 15, weight: .semibold, lines: 1)
    private let trackArtist = AIKit.label("", size: 13, color: Theme.muted, lines: 1)
    private let playButton = UIButton(type: .system)
    private let curve = EqualizerCurveView()

    private var card: UIColor { return Theme.dark ? UIColor(red: 20 / 255, green: 24 / 255, blue: 36 / 255, alpha: 0.72) : UIColor(white: 1, alpha: 0.78) }

    init() {
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = false
        }
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        ambient.frame = view.bounds
        ambient.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(ambient)

        let back = UIButton(type: .system)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        back.tintColor = Theme.text
        back.accessibilityLabel = "Назад"
        back.addTarget(self, action: #selector(close), for: .touchUpInside)
        let heading = AIKit.label("Эквалайзер", size: 17, weight: .semibold, lines: 1, align: .center)
        heading.accessibilityTraits = .header
        let top = UIView()
        top.translatesAutoresizingMaskIntoConstraints = false
        back.translatesAutoresizingMaskIntoConstraints = false
        heading.translatesAutoresizingMaskIntoConstraints = false
        top.addSubview(back)
        top.addSubview(heading)
        view.addSubview(top)

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        column.axis = .vertical
        column.spacing = 14
        column.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(column)
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 6), top.heightAnchor.constraint(equalToConstant: 54),
            top.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12), top.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            back.leadingAnchor.constraint(equalTo: top.leadingAnchor), back.centerYAnchor.constraint(equalTo: top.centerYAnchor),
            back.widthAnchor.constraint(equalToConstant: 44), back.heightAnchor.constraint(equalToConstant: 44),
            heading.centerXAnchor.constraint(equalTo: top.centerXAnchor), heading.centerYAnchor.constraint(equalTo: top.centerYAnchor),
            scroll.topAnchor.constraint(equalTo: top.bottomAnchor), scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            column.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 16),
            column.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -16),
        ])

        // «Рекомендованный» / «Пользовательский».
        let modes = UIStackView()
        modes.axis = .vertical
        modes.backgroundColor = card
        modes.layer.cornerRadius = 22
        modes.clipsToBounds = true
        for (index, mode) in ["recommended", "custom"].enumerated() {
            let row = UIControl()
            row.accessibilityTraits = .button
            row.isAccessibilityElement = true
            let words = mode == "recommended" ? "Рекомендованный" : "Пользовательский"
            row.accessibilityLabel = words
            let label = AIKit.label(words, size: 17, lines: 1)
            let check = UIImageView(image: UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)))
            check.tintColor = Theme.accent
            check.setContentHuggingPriority(.required, for: .horizontal)
            let line = UIStackView(arrangedSubviews: [label, check])
            line.axis = .horizontal
            line.alignment = .center
            line.isUserInteractionEnabled = false
            line.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(line)
            NSLayoutConstraint.activate([
                row.heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
                line.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 18), line.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -18),
                line.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            ])
            if index > 0 {
                let rule = UIView()
                rule.backgroundColor = ThemeStore.look.border
                rule.translatesAutoresizingMaskIntoConstraints = false
                row.addSubview(rule)
                NSLayoutConstraint.activate([
                    rule.topAnchor.constraint(equalTo: row.topAnchor), rule.heightAnchor.constraint(equalToConstant: 0.5),
                    rule.leadingAnchor.constraint(equalTo: row.leadingAnchor), rule.trailingAnchor.constraint(equalTo: row.trailingAnchor),
                ])
            }
            row.addAction(UIAction { [weak self] _ in self?.choose(mode) }, for: .touchUpInside)
            modes.addArrangedSubview(row)
            modeRows.append((mode, check))
        }
        column.addArrangedSubview(modes)
        let help = AIKit.label("«Рекомендованный» — звук трека без изменений. В «Пользовательском» потяни точки НЧ, СЧ и ВЧ вверх или вниз. Настройка одна для динамика, проводных и Bluetooth-наушников.", size: 13, color: Theme.muted)
        let helpBox = UIView()
        help.translatesAutoresizingMaskIntoConstraints = false
        helpBox.addSubview(help)
        NSLayoutConstraint.activate([
            help.topAnchor.constraint(equalTo: helpBox.topAnchor), help.bottomAnchor.constraint(equalTo: helpBox.bottomAnchor),
            help.leadingAnchor.constraint(equalTo: helpBox.leadingAnchor, constant: 4), help.trailingAnchor.constraint(equalTo: helpBox.trailingAnchor, constant: -4),
        ])
        column.addArrangedSubview(helpBox)

        // The track and the curve.
        trackCard.backgroundColor = card
        trackCard.layer.cornerRadius = 22
        let inner = UIStackView()
        inner.axis = .vertical
        inner.spacing = 16
        inner.translatesAutoresizingMaskIntoConstraints = false
        trackCard.addSubview(inner)
        playButton.backgroundColor = Theme.dark ? UIColor(white: 1, alpha: 0.12) : UIColor(white: 0, alpha: 0.07)
        playButton.layer.cornerRadius = 26
        playButton.tintColor = Theme.text
        playButton.addTarget(self, action: #selector(flip), for: .touchUpInside)
        let words = UIStackView(arrangedSubviews: [trackTitle, trackArtist])
        words.axis = .vertical
        words.spacing = 2
        let trackRow = UIStackView(arrangedSubviews: [cover, words, playButton])
        trackRow.axis = .horizontal
        trackRow.alignment = .center
        trackRow.spacing = 12
        let rule = UIView()
        rule.backgroundColor = Theme.veil(0.12)
        rule.heightAnchor.constraint(equalToConstant: 0.5).isActive = true
        curve.onChange = { [weak self] (key: String, value: Double) -> Void in self?.setBand(key, value) }
        [trackRow, rule, curve].forEach { inner.addArrangedSubview($0) }
        NSLayoutConstraint.activate([
            cover.widthAnchor.constraint(equalToConstant: 64), cover.heightAnchor.constraint(equalToConstant: 64),
            playButton.widthAnchor.constraint(equalToConstant: 52), playButton.heightAnchor.constraint(equalToConstant: 52),
            curve.heightAnchor.constraint(equalToConstant: EqualizerCurveView.plot + EqualizerCurveView.labels),
            inner.topAnchor.constraint(equalTo: trackCard.topAnchor, constant: 18), inner.bottomAnchor.constraint(equalTo: trackCard.bottomAnchor, constant: -18),
            inner.leadingAnchor.constraint(equalTo: trackCard.leadingAnchor, constant: 18), inner.trailingAnchor.constraint(equalTo: trackCard.trailingAnchor, constant: -18),
        ])
        column.addArrangedSubview(trackCard)

        let reset = UIButton(type: .system)
        reset.setTitle("Сбросить", for: .normal)
        reset.titleLabel?.font = .systemFont(ofSize: 17)
        reset.setTitleColor(Theme.accent, for: .normal)
        reset.backgroundColor = card
        reset.layer.cornerRadius = 27
        reset.heightAnchor.constraint(equalToConstant: 54).isActive = true
        reset.addTarget(self, action: #selector(resetAll), for: .touchUpInside)
        column.addArrangedSubview(reset)

        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: EqualizerSettings.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(playerChanged), name: MusicPlayer.changed, object: nil)
        refresh()
        playerChanged()
    }

    private var playerMark = ""

    @objc private func playerChanged() {
        let player = MusicPlayer.shared
        let mark = (player.current?.id ?? "") + "|\(player.playing)"
        if mark == playerMark { return }
        playerMark = mark
        cover.bind(player.current)
        trackTitle.text = player.current?.title ?? "Включи трек"
        trackArtist.text = player.current?.artist ?? "чтобы слышать изменения"
        playButton.setImage(UIImage(systemName: player.playing ? "pause.fill" : "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .semibold)), for: .normal)
        playButton.accessibilityLabel = player.playing ? "Пауза" : "Слушать"
        playButton.isEnabled = player.current != nil
        playButton.alpha = player.current != nil ? 1 : 0.5
    }

    @objc private func refresh() {
        let profile = EqualizerSettings.profile
        for row in modeRows { row.check.isHidden = row.mode != profile.mode }
        trackCard.alpha = profile.mode == "custom" ? 1 : 0.5
        curve.profile = profile
        curve.disabled = profile.mode != "custom"
    }

    private func choose(_ mode: String) {
        var profile = EqualizerSettings.profile
        profile.mode = mode
        EqualizerSettings.profile = profile
    }

    private func setBand(_ key: String, _ value: Double) {
        var profile = EqualizerSettings.profile
        profile.set(key, value)
        EqualizerSettings.profile = profile
    }

    @objc private func resetAll() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        var profile = EqualizerSettings.profile
        profile.low = 0
        profile.mid = 0
        profile.high = 0
        EqualizerSettings.profile = profile
    }

    @objc private func flip() { MusicPlayer.shared.togglePlayback() }
    @objc private func close() { dismiss(animated: true) }
}

/// The curve: flat ends, smooth S-shapes through three draggable points, a dotted zero line. A drag that starts on a
/// point moves the point (never the sheet).
final class EqualizerCurveView: UIView {
    static let plot: CGFloat = 250
    static let labels: CGFloat = 34
    private static let pad: CGFloat = 28

    var profile = EqualizerSettings.Profile() { didSet { if profile != oldValue { changed() } } }
    var disabled = true { didSet { handles.forEach { $0.isUserInteractionEnabled = !disabled } } }
    var onChange: ((String, Double) -> Void)?

    private var active: Int?
    private var startY: CGFloat = 0
    private var handles: [EqualizerHandle] = []
    private var captions: [UILabel] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        contentMode = .redraw
        for (index, band) in EqualizerSettings.bands.enumerated() {
            let handle = EqualizerHandle()
            handle.index = index
            handle.accessibilityLabel = band.label
            handle.onStep = { [weak self] (index: Int, up: Bool) -> Void in self?.stepBand(index, up: up) }
            let pan = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
            handle.addGestureRecognizer(pan)
            addSubview(handle)
            handles.append(handle)
            let caption = UILabel()
            caption.font = .systemFont(ofSize: 19, weight: .bold)
            caption.textAlignment = .center
            addSubview(caption)
            captions.append(caption)
        }
        changed()
    }

    required init?(coder: NSCoder) { return nil }

    private var xs: [CGFloat] { return [bounds.width * 0.17, bounds.width * 0.5, bounds.width * 0.83] }
    private func yOf(_ db: Double) -> CGFloat {
        let h = EqualizerCurveView.plot, pad = EqualizerCurveView.pad
        return pad + CGFloat((EqualizerSettings.limit - db) / (2 * EqualizerSettings.limit)) * (h - 2 * pad)
    }
    private func dbOf(_ y: CGFloat) -> Double {
        let h = EqualizerCurveView.plot, pad = EqualizerCurveView.pad, limit = EqualizerSettings.limit
        let raw = limit - Double((y - pad) / (h - 2 * pad)) * 2 * limit
        return (max(-limit, min(limit, raw)) * 2).rounded() / 2
    }
    private func values() -> [Double] { return EqualizerSettings.bands.map { profile.value($0.key) } }
    private static func colour(_ db: Double) -> UIColor { return db > 0.5 ? UIColor(hex: 0xFFE15A) : (db < -0.5 ? UIColor(hex: 0x5AD8FF) : UIColor(hex: 0x9BE87A)) }

    private func changed() {
        let list = values()
        for (index, caption) in captions.enumerated() {
            let value = list[index]
            let on = active == index
            caption.textColor = on ? Theme.text : Theme.muted
            caption.text = on ? "\(value > 0 ? "+" : "")\(EqualizerCurveView.number(value)) дБ" : EqualizerSettings.bands[index].label
            handles[index].accessibilityValue = "\(EqualizerCurveView.number(value)) дБ"
        }
        setNeedsDisplay()
        setNeedsLayout()
    }

    /// 3 → «3», 2.5 → «2.5», as the reference prints a number.
    static func number(_ value: Double) -> String {
        return value == value.rounded() ? String(Int(value)) : String(value)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let points = xs
        for (index, handle) in handles.enumerated() {
            handle.frame = CGRect(x: points[index] - 30, y: 0, width: 60, height: EqualizerCurveView.plot)
        }
        for (index, caption) in captions.enumerated() {
            caption.frame = CGRect(x: points[index] - 40, y: EqualizerCurveView.plot + 6, width: 80, height: 24)
        }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        // Wider than the drawn point: 30 pt more on each side, 40 above and below.
        return bounds.insetBy(dx: -30, dy: -40).contains(point)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !disabled, self.point(inside: point, with: event) else { return super.hitTest(point, with: event) }
        let points = xs
        var best: EqualizerHandle?
        var distance = CGFloat.greatestFiniteMagnitude
        for (index, handle) in handles.enumerated() {
            let gap = abs(point.x - points[index])
            if gap <= 60 && gap < distance {
                distance = gap
                best = handle
            }
        }
        return best ?? super.hitTest(point, with: event)
    }

    @objc private func dragged(_ pan: UIPanGestureRecognizer) {
        guard let handle = pan.view as? EqualizerHandle, !disabled else { return }
        let index = handle.index
        switch pan.state {
        case .began:
            active = index
            startY = yOf(values()[index])
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            changed()
        case .changed:
            let value = dbOf(startY + pan.translation(in: self).y)
            if value != values()[index] { onChange?(EqualizerSettings.bands[index].key, value) }
        default:
            active = nil
            changed()
        }
    }

    private func stepBand(_ index: Int, up: Bool) {
        guard !disabled else { return }
        let value = max(-EqualizerSettings.limit, min(EqualizerSettings.limit, values()[index] + (up ? 1 : -1)))
        onChange?(EqualizerSettings.bands[index].key, value)
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let width = bounds.width, height = EqualizerCurveView.plot
        let points = xs
        let list = values()
        let ys = list.map { yOf($0) }
        let space = CGColorSpaceCreateDeviceRGB()
        if let active {
            // A soft band of focus behind the point being dragged.
            let ink = Theme.dark ? UIColor.white : UIColor.black
            let colours = [ink.withAlphaComponent(0).cgColor, ink.withAlphaComponent(0.08).cgColor, ink.withAlphaComponent(0).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: space, colors: colours, locations: [0, 0.5, 1]) {
                context.saveGState()
                context.clip(to: CGRect(x: points[active] - width * 0.165, y: 0, width: width * 0.33, height: height))
                context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: height), options: [])
                context.restoreGState()
            }
        }
        context.saveGState()
        context.setStrokeColor(Theme.muted.withAlphaComponent(0.5).cgColor)
        context.setLineWidth(1)
        context.setLineDash(phase: 0, lengths: [4, 5])
        for x in points {
            context.move(to: CGPoint(x: x, y: 8))
            context.addLine(to: CGPoint(x: x, y: height - 8))
        }
        context.strokePath()
        context.restoreGState()
        context.saveGState()
        context.setStrokeColor(Theme.accent.cgColor)
        context.setLineWidth(3)
        context.setLineCap(.round)
        context.setLineDash(phase: 0, lengths: [0.1, 7])
        context.move(to: CGPoint(x: 0, y: yOf(0)))
        context.addLine(to: CGPoint(x: width, y: yOf(0)))
        context.strokePath()
        context.restoreGState()
        // The curve, coloured from yellow (up) through green to blue (down).
        let path = CGMutablePath()
        func mid(_ a: CGFloat, _ b: CGFloat) -> CGFloat { return (a + b) / 2 }
        path.move(to: CGPoint(x: 0, y: ys[0]))
        path.addLine(to: CGPoint(x: points[0], y: ys[0]))
        path.addCurve(to: CGPoint(x: points[1], y: ys[1]), control1: CGPoint(x: mid(points[0], points[1]), y: ys[0]), control2: CGPoint(x: mid(points[0], points[1]), y: ys[1]))
        path.addCurve(to: CGPoint(x: points[2], y: ys[2]), control1: CGPoint(x: mid(points[1], points[2]), y: ys[1]), control2: CGPoint(x: mid(points[1], points[2]), y: ys[2]))
        path.addLine(to: CGPoint(x: width, y: ys[2]))
        context.saveGState()
        context.addPath(path)
        context.setLineWidth(5)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        context.replacePathWithStrokedPath()
        context.clip()
        let line = [UIColor(hex: 0xFFE15A).cgColor, UIColor(hex: 0x9BE87A).cgColor, UIColor(hex: 0x5AD8FF).cgColor] as CFArray
        if let gradient = CGGradient(colorsSpace: space, colors: line, locations: [0, 0.5, 1]) {
            context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: height), options: [])
        }
        context.restoreGState()
        for (index, x) in points.enumerated() {
            let radius: CGFloat = active == index ? 15 : 13
            context.setFillColor(EqualizerCurveView.colour(list[index]).cgColor)
            context.fillEllipse(in: CGRect(x: x - radius, y: ys[index] - radius, width: radius * 2, height: radius * 2))
        }
    }
}

/// The touch area of one point; for VoiceOver an adjustable value (up and down by 1 dB).
final class EqualizerHandle: UIView {
    var index = 0
    var onStep: ((Int, Bool) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isAccessibilityElement = true
        accessibilityTraits = .adjustable
    }

    required init?(coder: NSCoder) { return nil }

    override func accessibilityIncrement() { onStep?(index, true) }
    override func accessibilityDecrement() { onStep?(index, false) }
}
