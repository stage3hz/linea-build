import UIKit

// The pieces the AI screen is made of: the answer's text, one turn of the conversation, round buttons, and the
// sheet used for the consent, the history and the Platina note. Layout after mobile/src/ai/AIScreen.tsx.

enum AIText {
    /// The reference shows an answer as plain selectable text. Here the fenced blocks (``` … ```) of an answer are
    /// additionally set in a monospaced face on a darker ground; everything else stays plain text.
    static func attributed(_ text: String, size: CGFloat, color: UIColor) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 4
        let plain: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: size), .foregroundColor: color, .paragraphStyle: style]
        let code: [NSAttributedString.Key: Any] = [.font: UIFont.monospacedSystemFont(ofSize: size - 2, weight: .regular), .foregroundColor: Theme.text, .backgroundColor: Theme.veil(0.07)]
        let parts = text.components(separatedBy: "```")
        // An unclosed fence is not a block: the text is shown as it is.
        guard parts.count >= 3, parts.count % 2 == 1 else { return NSAttributedString(string: text, attributes: plain) }
        for (index, part) in parts.enumerated() {
            if index % 2 == 0 {
                out.append(NSAttributedString(string: part, attributes: plain))
                continue
            }
            var body = part
            // The first line of a block names its language.
            if let end = body.firstIndex(of: "\n") {
                let first = body[body.startIndex..<end]
                if !first.contains(" ") { body = String(body[body.index(after: end)...]) }
            }
            while body.hasSuffix("\n") { body.removeLast() }
            out.append(NSAttributedString(string: body, attributes: code))
        }
        return out
    }
}

enum AIKit {
    static func label(_ text: String, size: CGFloat, weight: UIFont.Weight = .regular, color: UIColor = Theme.text, lines: Int = 0, align: NSTextAlignment = .natural) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.numberOfLines = lines
        label.textAlignment = align
        return label
    }

    /// A 48-point round button with a symbol.
    static func round(_ symbol: String, _ words: String, active: Bool = false, size: CGFloat = 48) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium)), for: .normal)
        button.tintColor = Theme.text
        button.backgroundColor = active ? Theme.veil(0.16) : Theme.surface2
        button.layer.cornerRadius = size / 2
        button.layer.borderWidth = 1
        button.layer.borderColor = Theme.veil(active ? 0.5 : 0.1).cgColor
        button.accessibilityLabel = words
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([button.widthAnchor.constraint(equalToConstant: size), button.heightAnchor.constraint(equalToConstant: size)])
        return button
    }

    /// A wide button: filled (the main action) or quiet.
    static func wide(_ words: String, symbol: String? = nil, secondary: Bool = false) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = words
        if let symbol { config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)) }
        config.imagePadding = 8
        config.baseBackgroundColor = secondary ? Theme.surface2 : Theme.accent
        config.baseForegroundColor = secondary ? Theme.text : Theme.onAccent
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 13, leading: 18, bottom: 13, trailing: 18)
        let button = UIButton(configuration: config)
        return button
    }
}

/// A sheet from below with a heading and whatever rows it is given.
final class AISheetController: UIViewController {
    private let heading: String
    let stack = UIStackView()
    var onClosed: (() -> Void)?

    init(heading: String) {
        self.heading = heading
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.page(UIColor(hex: 0x141516))
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        stack.insertArrangedSubview(AIKit.label(heading, size: 20, weight: .bold), at: 0)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -20),
        ])
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil {
            let closed = onClosed
            onClosed = nil
            closed?()
        }
    }
}

/// One question with what came of it: the answer, the progress, or why there is none.
final class AITurnView: UIView {
    var onRetry: (() -> Void)?
    var onDetails: (() -> Void)?
    var onShare: ((URL) -> Void)?
    var onPlay: ((URL) -> Void)?
    var onVideo: ((URL) -> Void)?
    private var progress: UILabel?
    private var firstMark: UIImageView?
    private var firstSpin: UIActivityIndicatorView?
    private var slow: UILabel?
    private let turn: AITurn
    private let router: Bool
    private var mediaURL: URL?

    init(turn: AITurn, retryable: Bool, canRetry: Bool, router: Bool, details: Bool, playing: Bool) {
        self.turn = turn
        self.router = router
        super.init(frame: .zero)
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 10
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor), column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            column.leadingAnchor.constraint(equalTo: leadingAnchor), column.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        column.addArrangedSubview(questionRow())
        if let answer = turn.answer { column.addArrangedSubview(answerCard(answer, details: details, playing: playing)) }
        else if turn.status == "pending" { column.addArrangedSubview(progressRows()) }
        else { column.addArrangedSubview(failedRows(retryable: retryable, canRetry: canRetry)) }
    }

    required init?(coder: NSCoder) { return nil }

    private func questionRow() -> UIView {
        let code = turn.question.hasPrefix(AIModel.codeTaskPrefix)
        let row = UIView()
        let bubble = UIView()
        bubble.backgroundColor = ThemeStore.look.bubble
        bubble.layer.cornerRadius = 22
        bubble.layer.borderWidth = 1
        bubble.layer.borderColor = Theme.veil(0.08).cgColor
        bubble.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(bubble)
        let inner = UIStackView()
        inner.axis = .vertical
        inner.spacing = 6
        inner.translatesAutoresizingMaskIntoConstraints = false
        bubble.addSubview(inner)
        if code { inner.addArrangedSubview(AIKit.label("Задача по коду", size: 10, weight: .bold)) }
        inner.addArrangedSubview(AIKit.label(code ? String(turn.question.dropFirst(AIModel.codeTaskPrefix.count)) : turn.question, size: 15))
        NSLayoutConstraint.activate([
            bubble.topAnchor.constraint(equalTo: row.topAnchor), bubble.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            bubble.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            bubble.leadingAnchor.constraint(greaterThanOrEqualTo: row.leadingAnchor, constant: 28),
            inner.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 14), inner.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -14),
            inner.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 14), inner.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -14),
        ])
        return row
    }

    private func answerCard(_ answer: AIReply, details: Bool, playing: Bool) -> UIView {
        let card = UIView()
        card.backgroundColor = Theme.surface2
        card.layer.cornerRadius = 23
        card.layer.borderWidth = 1
        card.layer.borderColor = Theme.veil(0.08).cgColor
        let inner = UIStackView()
        inner.axis = .vertical
        inner.spacing = 11
        inner.alignment = .fill
        inner.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.topAnchor.constraint(equalTo: card.topAnchor, constant: 16), inner.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -10),
            inner.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16), inner.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
        ])
        var config = UIButton.Configuration.plain()
        var seconds = "AI"
        if let ms = turn.ms { seconds = "Ответ за \(max(1, Int((ms / 1000).rounded()))) с" }
        config.attributedTitle = AttributedString(seconds, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 12, weight: .bold)]))
        config.image = UIImage(systemName: details ? "chevron.up" : "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .semibold))
        config.imagePlacement = .trailing
        config.imagePadding = 6
        config.contentInsets = .zero
        config.baseForegroundColor = Theme.accent
        let head = UIButton(configuration: config)
        head.accessibilityLabel = "Как получен ответ"
        head.addAction(UIAction { [weak self] _ in self?.onDetails?() }, for: .touchUpInside)
        head.contentHorizontalAlignment = .leading
        inner.addArrangedSubview(head)
        if details {
            inner.addArrangedSubview(AIKit.label("Выбор: " + AIModel.modelLabel(turn.model ?? "auto"), size: 12, color: Theme.muted))
            inner.addArrangedSubview(AIKit.label("Ответила модель: " + answer.model, size: 12, color: Theme.muted))
            if let via = answer.routedVia { inner.addArrangedSubview(AIKit.label("Через: " + via, size: 12, color: Theme.muted)) }
        }
        var hasMedia = false
        if let media = turn.media, let file = AIMediaCache.url(media.uri) {
            hasMedia = true
            mediaURL = file
            if media.mimeType.hasPrefix("image/") {
                let picture = UIImageView(image: UIImage(contentsOfFile: file.path))
                picture.contentMode = .scaleAspectFill
                picture.clipsToBounds = true
                picture.layer.cornerRadius = 16
                picture.backgroundColor = Theme.veil(0.05)
                picture.isUserInteractionEnabled = true
                picture.isAccessibilityElement = true
                picture.accessibilityTraits = .button
                picture.accessibilityLabel = "Сохранить или отправить картинку"
                picture.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(shareMedia)))
                picture.heightAnchor.constraint(equalTo: picture.widthAnchor).isActive = true
                inner.addArrangedSubview(picture)
            } else {
                let video = media.mimeType == "video/mp4"
                let row = UIStackView()
                row.axis = .horizontal
                row.spacing = 10
                row.alignment = .center
                let play = AIKit.round(video ? "play.rectangle.fill" : (playing ? "pause.fill" : "play.fill"), video ? "Смотреть" : (playing ? "Пауза" : "Слушать"), active: true, size: 50)
                play.addAction(UIAction { [weak self] _ in
                    guard let self, let file = self.mediaURL else { return }
                    if video { self.onVideo?(file) } else { self.onPlay?(file) }
                }, for: .touchUpInside)
                row.addArrangedSubview(play)
                row.addArrangedSubview(AIKit.label("Готово", size: 12, color: Theme.muted))
                let spacer = UIView()
                row.addArrangedSubview(spacer)
                let send = UIButton(type: .system)
                send.setImage(UIImage(systemName: "square.and.arrow.up"), for: .normal)
                send.tintColor = Theme.accent
                send.accessibilityLabel = "Сохранить или отправить"
                send.addTarget(self, action: #selector(shareMedia), for: .touchUpInside)
                row.addArrangedSubview(send)
                inner.addArrangedSubview(row)
            }
        }
        let gone = !hasMedia && (turn.kind == "image" || turn.kind == "video" || turn.kind == "speech")
        if gone { inner.addArrangedSubview(AIKit.label("Файл удалён из кэша", size: 12, color: Theme.muted)) }
        if !(gone && turn.kind != "speech") {
            let small = hasMedia || gone
            let body = UITextView()
            body.isEditable = false
            body.isScrollEnabled = false
            body.backgroundColor = .clear
            body.textContainerInset = .zero
            body.textContainer.lineFragmentPadding = 0
            body.dataDetectorTypes = []
            body.attributedText = AIText.attributed(answer.text, size: small ? 13 : 15, color: small ? Theme.muted : Theme.text)
            inner.addArrangedSubview(body)
        }
        let copyButton = UIButton(type: .system)
        copyButton.setImage(UIImage(systemName: "doc.on.doc", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .regular)), for: .normal)
        copyButton.tintColor = Theme.accent
        copyButton.accessibilityLabel = "Скопировать ответ AI"
        copyButton.contentHorizontalAlignment = .trailing
        copyButton.addAction(UIAction { [weak copyButton] _ in
            UIPasteboard.general.string = answer.text
            copyButton?.setImage(UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .regular)), for: .normal)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                copyButton?.setImage(UIImage(systemName: "doc.on.doc", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .regular)), for: .normal)
            }
        }, for: .touchUpInside)
        copyButton.heightAnchor.constraint(equalToConstant: 34).isActive = true
        inner.addArrangedSubview(copyButton)
        return card
    }

    @objc private func shareMedia() {
        if let mediaURL { onShare?(mediaURL) }
    }

    private func stepRow(_ lead: UIView, _ text: UILabel) -> UIStackView {
        let row = UIStackView(arrangedSubviews: [lead, text])
        row.axis = .horizontal
        row.spacing = 9
        row.alignment = .center
        lead.setContentHuggingPriority(.required, for: .horizontal)
        return row
    }

    private func progressRows() -> UIView {
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 8
        column.isLayoutMarginsRelativeArrangement = true
        column.layoutMargins = UIEdgeInsets(top: 4, left: 6, bottom: 4, right: 6)
        let mark = UIImageView(image: UIImage(systemName: "checkmark.circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .regular)))
        mark.tintColor = Theme.accent
        mark.isHidden = true
        let spin = UIActivityIndicatorView(style: .medium)
        spin.color = Theme.accent
        spin.startAnimating()
        let lead = UIStackView(arrangedSubviews: [mark, spin])
        column.addArrangedSubview(stepRow(lead, AIKit.label(turn.images.isEmpty ? "Запрос отправлен на сервер" : "Запрос и фото отправлены на сервер", size: 13, color: Theme.muted)))
        let second = UIActivityIndicatorView(style: .medium)
        second.color = Theme.accent
        second.startAnimating()
        let working = AIKit.label("", size: 13)
        column.addArrangedSubview(stepRow(second, working))
        let waiting = AIKit.label(router ? "Бесплатные модели бывают заняты — сервер может переключиться на другую. Ждём до 2 минут." : "Бесплатные модели иногда отвечают медленно. Ждём до 2 минут.", size: 11, color: Theme.muted)
        waiting.isHidden = true
        column.addArrangedSubview(waiting)
        progress = working
        firstMark = mark
        firstSpin = spin
        slow = waiting
        tick()
        return column
    }

    /// The honest elapsed time of a pending turn; called twice a second by the screen.
    func tick() {
        guard let progress else { return }
        let seconds = max(0, Int(Date().timeIntervalSince(turn.startedAt ?? Date())))
        var working = "Бесплатная модель пишет ответ"
        if let stage = turn.stage, !stage.isEmpty { working = stage }
        else if turn.kind == "image" { working = "Рисую картинку" }
        else if turn.kind == "video" { working = "Создаю видео — это может занять до 5 минут" }
        else if turn.kind == "speech" { working = "Озвучиваю текст" }
        else if turn.kind == "transcribe" { working = "Расшифровываю аудио" }
        else if router { working = turn.model != nil ? "Модель «\(AIModel.modelLabel(turn.model ?? "auto"))» пишет ответ" : "Подбираю свободную модель и пишу ответ" }
        progress.text = working + " · \(seconds) с"
        firstMark?.isHidden = seconds < 1
        firstSpin?.isHidden = seconds >= 1
        slow?.isHidden = !(seconds >= 12 && turn.kind != "video")
    }

    private func failedRows(retryable: Bool, canRetry: Bool) -> UIView {
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 8
        column.isLayoutMarginsRelativeArrangement = true
        column.layoutMargins = UIEdgeInsets(top: 0, left: 8, bottom: 0, right: 8)
        var words = "Ожидание ответа отменено."
        if turn.status != "cancelled" { words = (turn.error ?? "").isEmpty ? "Ответ не получен." : (turn.error ?? "") }
        column.addArrangedSubview(AIKit.label(words, size: 12, color: turn.status == "failed" ? Theme.danger : Theme.muted))
        if retryable {
            let again = AIKit.wide(turn.question.hasPrefix(AIModel.codeTaskPrefix) ? "Повторить эту задачу" : "Повторить этот вопрос", symbol: "arrow.clockwise", secondary: true)
            again.isEnabled = canRetry
            again.addAction(UIAction { [weak self] _ in self?.onRetry?() }, for: .touchUpInside)
            column.addArrangedSubview(again)
        }
        return column
    }
}
