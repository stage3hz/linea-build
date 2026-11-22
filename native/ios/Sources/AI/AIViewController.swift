import UIKit
import AVFoundation
import AVKit
import UniformTypeIdentifiers
import PhotosUI

/// The «AI» section: one conversation with the free model behind the person's server. Ported from
/// mobile/src/ai/AIScreen.tsx: the same steps, limits and words.
final class AIViewController: UIViewController, UITextViewDelegate, UIDocumentPickerDelegate, AVAudioPlayerDelegate {
    private let messenger: Messenger?
    private let history: AIHistory
    private var conversation: AIConversation!
    private var status: AIStatus?
    private var statusError = ""
    private var checking = false
    private var conversationId = UUID().uuidString.lowercased()
    private var incognito = false
    private var chosenModel = "auto"
    private var models: [String] = []
    private var taskError = ""
    private var details = Set<Int>()
    private var restored = false
    private var afterConsent: (() -> Void)?
    private var audio: AVAudioPlayer?
    private var audioFile: URL?
    private var clock: Timer?
    private weak var pendingView: AITurnView?
    /// AI: photos (video frames) and documents attached to the next question (ai/attach.ts). Pictures go with one
    /// question; documents stay with the whole conversation.
    private var pictures: [AIPicture] = []
    private var documents: [AIDocumentText] = []
    private var reading = 0
    /// What the document picker was opened for: «Документ» or «Аудиофайл → текст».
    private var pickingDocuments = false
    private let attachScroll = UIScrollView()
    private let attachRow = UIStackView()
    /// The quick dialog (`AIQuickDialog`): over another screen, no history, a «Закрыть» button instead of the history.
    private let quick: Bool

    private let topBar = UIStackView()
    private let historyButton = AIKit.round("line.3.horizontal", "История AI-бесед")
    private let newButton = AIKit.round("square.and.pencil", "Начать новую AI-беседу")
    private let privateButton = AIKit.round("eye.slash", "Приватная беседа: не сохранять в историю")
    private let scroll = UIScrollView()
    private let list = UIStackView()
    private let emptyBox = UIStackView()
    private let composer = UIView()
    private let input = UITextView()
    private let placeholder = AIKit.label("Спроси что угодно", size: 17, color: Theme.muted, lines: 1)
    private let toolsRow = UIStackView()
    private let plusButton = AIKit.round("plus", "Режимы AI и вложения", size: 42)
    private let modelPill = UIButton(type: .system)
    private let sendButton = AIKit.round("arrow.up", "Отправить вопрос AI", size: 42)
    // G: the reference's composer is one line while nothing is being written (AIScreen.tsx `expanded`): «+», the
    // quiet «Спроси что угодно» (a tap opens the field), the model, the send; the field and the tools row below it
    // only once the person writes, has a draft or attachments.
    private let collapsedWords = UIButton(type: .system)
    private let toolsSpacer = UIView()
    private var focused = false
    private var expanded: Bool { focused || !draft.isEmpty || !pictures.isEmpty || !documents.isEmpty || reading > 0 }
    private let pendingRow = UIStackView()
    private var barClearance: NSLayoutConstraint?
    private var inputHeight: NSLayoutConstraint?

    init(messenger: Messenger?, quick: Bool = false) {
        self.messenger = messenger
        self.quick = quick
        self.history = AIHistory(crypto: messenger?.crypto)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        clock?.invalidate()
        conversation?.close()
    }

    // MARK: State

    private var router: Bool { status?.router == true }
    /// Without Platina: fast text answers only.
    private var full: Bool { status?.platina != false }
    private var ready: Bool { status?.configured == true && status?.can("text") == true }
    private var draft: String { input.text ?? "" }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        build()
        let server = messenger?.server
        conversation = AIConversation(transport: { (messages: [[String: String]], model: String?, images: [String], documents: [AIDocumentText], done: @escaping (Result<AIReply, AIFailure>) -> Void) -> Void in
            guard let server else { return done(.failure(AIFailure("Нужно войти в аккаунт."))) }
            AIClient.chat(server, messages: messages, model: model, images: images, documents: documents, done: done)
        })
        if quick { conversationId = "quick-" + conversationId }
        conversation.discardMedia = { media in AIMediaCache.delete([media.uri]) }
        conversation.onChange = { [weak self] in self?.changed() }
        history.onChange = { [weak self] in self?.historyChanged() }
        #if targetEnvironment(simulator)
        if messenger == nil, UserDefaults.standard.string(forKey: "aidemo") != nil {
            simulatorDemo()
            return
        }
        #endif
        // The quick dialog has no history.
        if !quick { history.load() }
        refreshStatus()
    }

    private func refreshStatus() {
        guard let server = messenger?.server else {
            render()
            return
        }
        status = nil
        statusError = ""
        checking = true
        render()
        AIClient.status(server) { [weak self] result in
            guard let self else { return }
            self.checking = false
            switch result {
            case .success(let value):
                self.status = value
                if value.router && value.can("models") {
                    AIClient.models(server) { [weak self] found in
                        self?.models = found
                        self?.render()
                    }
                }
            case .failure(let failure): self.statusError = failure.words.isEmpty ? "Не удалось проверить доступность AI." : failure.words
            }
            self.render()
        }
    }

    private func historyChanged() {
        // Reopen the latest conversation once the encrypted history has loaded.
        if !restored, history.loaded {
            restored = true
            if let latest = history.items.first, conversation.turns.isEmpty {
                conversationId = latest.id
                reopen(latest.turns, consent: latest.consent)
            }
        }
    }

    private func reopen(_ turns: [AITurn], consent: Bool) {
        conversation.restore(turns, consent: consent)
        conversation.dropMedia(AIMediaCache.missing(conversation.turns))
    }

    private func changed() {
        if !quick, !incognito, !conversation.pending, !conversation.turns.isEmpty, messenger != nil {
            history.save(id: conversationId, turns: conversation.turns, consent: conversation.consent)
        }
        if !quick, history.loaded, !conversation.pending, messenger != nil {
            let open = AIMediaCache.names(conversation.turns)
            let stored = history.items.flatMap { AIMediaCache.names($0.turns) }
            DispatchQueue.global(qos: .utility).async { AIMediaCache.prune(keep: stored + open, protect: open) }
        }
        render()
        if conversation.pending || conversation.turns.last?.status == "complete" {
            DispatchQueue.main.async { [weak self] in self?.scrollToEnd() }
        }
    }

    private func scrollToEnd() {
        view.layoutIfNeeded()
        let bottom = scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom
        if bottom > 0 { scroll.setContentOffset(CGPoint(x: 0, y: bottom), animated: true) }
    }

    // MARK: Sending

    @objc private func submit() {
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !ready || conversation.pending { return }
        if !conversation.consent {
            afterConsent = { [weak self] in self?.send() }
            showConsent()
            return
        }
        send()
    }

    private func askModel() -> String? {
        guard full, router, chosenModel != "auto" else { return nil }
        return chosenModel
    }

    private func sent() {
        if conversation.pending {
            input.text = ""
            // The photos went with this question (setPhoto(null)).
            pictures = []
            textViewDidChange(input)
        }
    }

    private var vision: Bool { return status?.can("vision") == true }
    private var docs: Bool { return status?.can("documents") == true }
    /// What goes with a text question (`askOptions`): pictures and documents when the server takes them, with Platina.
    private var askImages: [String] { return full && vision ? pictures.map { $0.data } : [] }
    private var askDocuments: [AIDocumentText] { return full && docs ? documents : [] }

    private func send() {
        guard ready, let server = messenger?.server else { return }
        let question = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let photo = pictures.first?.data
        let intent = AIModel.detectIntent(question, hasPhoto: photo != nil)
        if intent == "text" {
            taskError = ""
            conversation.ask(question, model: askModel(), images: askImages, documents: askDocuments)
            sent()
            return
        }
        let label = intent == "image" ? "Картинки" : (intent == "video" ? "Видео" : "Озвучка")
        if !full { return showPlatina(label) }
        if !router || status?.can(intent) != true {
            taskError = "\(label) пока не подключены на сервере — отвечу текстом."
            conversation.ask(question, model: askModel(), images: askImages, documents: askDocuments)
            sent()
            return
        }
        let owner = conversationId
        let work: AIConversation.Work
        if intent == "image" {
            work = { stage, done in
                let draw: (String) -> Void = { (prompt: String) -> Void in
                    stage("Рисую картинку")
                    AIClient.image(server, prompt: prompt) { result in
                        switch result {
                        case .failure(let failure): done(.failure(failure))
                        case .success(let made):
                            do {
                                let name = try AIMediaCache.write(conversationId: owner, data: made.data, mimeType: made.mimeType)
                                let words = photo != nil ? "Новая картинка по мотивам твоего фото (провайдер рисует заново по описанию, само фото не меняется). Нажми на картинку, чтобы сохранить или отправить." : "Готово. Нажми на картинку, чтобы сохранить или отправить."
                                done(.success(AIConversation.TaskResult(text: words, model: made.routedVia ?? "генерация картинок", routedVia: made.routedVia, media: AIMedia(uri: name, mimeType: made.mimeType))))
                            } catch { done(.failure((error as? AIFailure) ?? AIFailure("Кэш недоступен на этом устройстве."))) }
                        }
                    }
                }
                guard let photo else { return draw(question) }
                // The provider draws from text, so the photo is first described (vision) together with the request.
                stage("Смотрю на твоё фото")
                let ask = "Опиши это изображение для генератора картинок: что на нём, цвета, композиция, стиль. Учти просьбу пользователя и выдай один итоговый промпт на английском до 900 символов, без пояснений.\n\nПросьба: " + question
                AIClient.chat(server, messages: [["role": "user", "content": ask]], model: nil, images: [photo]) { result in
                    switch result {
                    case .failure(let failure): done(.failure(failure))
                    case .success(let reply): draw(String(reply.text.prefix(3900)))
                    }
                }
            }
        } else if intent == "video" {
            work = { _, done in
                AIClient.video(server, prompt: question, duration: 5) { result in
                    switch result {
                    case .failure(let failure): done(.failure(failure))
                    case .success(let bytes):
                        do {
                            let name = try AIMediaCache.write(conversationId: owner, data: bytes, mimeType: "video/mp4")
                            done(.success(AIConversation.TaskResult(text: "Видео готово.", model: "генерация видео", routedVia: nil, media: AIMedia(uri: name, mimeType: "video/mp4"))))
                        } catch { done(.failure((error as? AIFailure) ?? AIFailure("Кэш недоступен на этом устройстве."))) }
                    }
                }
            }
        } else {
            work = { _, done in
                let spoken = AIModel.speechText(question)
                if spoken.isEmpty { return done(.failure(AIFailure("Напиши после «озвучь», что именно сказать."))) }
                AIClient.speech(server, text: spoken, voice: "nova") { result in
                    switch result {
                    case .failure(let failure): done(.failure(failure))
                    case .success(let made):
                        do {
                            let name = try AIMediaCache.write(conversationId: owner, data: made.data, mimeType: made.mimeType)
                            done(.success(AIConversation.TaskResult(text: spoken, model: "озвучка", routedVia: nil, media: AIMedia(uri: name, mimeType: made.mimeType))))
                        } catch { done(.failure((error as? AIFailure) ?? AIFailure("Кэш недоступен на этом устройстве."))) }
                    }
                }
            }
        }
        taskError = ""
        conversation.askTask(question, kind: intent, work: work)
        sent()
    }

    @objc private func stop() { conversation.cancel() }

    @objc private func newConversation() {
        AIMediaCache.delete(AIMediaCache.names(conversation.turns.filter { $0.isPrivate || quick }))
        documents = []
        pictures = []
        conversation.clear()
        conversationId = UUID().uuidString.lowercased()
        input.text = ""
        taskError = ""
        details = []
        textViewDidChange(input)
        render()
    }

    @objc private func togglePrivate() {
        incognito.toggle()
        conversation.privateTurns = incognito
        render()
    }

    // MARK: Audio file → text

    private func transcribeFile() {
        guard ready else { return }
        if !conversation.consent {
            afterConsent = { [weak self] in self?.transcribeFile() }
            showConsent()
            return
        }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.audio], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        pickingDocuments = false
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if pickingDocuments { return tookDocuments(urls) }
        guard let file = urls.first, let server = messenger?.server else { return }
        let name = file.lastPathComponent
        let limit = 10 * 1024 * 1024
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        guard size <= limit, let bytes = try? Data(contentsOf: file), bytes.count <= limit, !bytes.isEmpty else {
            try? FileManager.default.removeItem(at: file)
            taskError = size > limit ? "Аудио для расшифровки — до 10 МБ." : "Не удалось открыть аудио."
            render()
            return
        }
        try? FileManager.default.removeItem(at: file)
        taskError = ""
        conversation.askTask("Расшифруй аудио «\(name)»", kind: "transcribe") { _, done in
            AIClient.transcribe(server, audio: bytes) { result in
                switch result {
                case .failure(let failure): done(.failure(failure))
                case .success(let text): done(.success(AIConversation.TaskResult(text: text, model: "расшифровка аудио", routedVia: nil, media: nil)))
                }
            }
        }
    }

    // MARK: Sheets

    private func showConsent() {
        let sheet = AISheetController(heading: "Отправить вопрос AI?")
        let via = status?.provider == "freellmapi" ? "в сервис FreeLLMAPI и бесплатному поставщику модели, которого он выберет" : "в OpenRouter и поставщику модели"
        sheet.stack.addArrangedSubview(AIKit.label("Вопросы и история этой беседы передаются через твой сервер \(via). В AI попадает только то, что ты пишешь и прикладываешь здесь: текст, фото и кадры видео (без геометки и других данных EXIF) и текст приложенных документов. Разрешение действует только для этой беседы.", size: 12, color: Theme.muted))
        sheet.stack.addArrangedSubview(AIKit.label(quick ? "В быстром вопросе история очищается при закрытии окна." : (incognito ? "Это приватная беседа: на устройстве она не сохранится." : "История бесед хранится зашифрованной только на этом устройстве."), size: 12, color: Theme.muted))
        if status?.provider != "freellmapi" {
            let link = UIButton(type: .system)
            link.setTitle("Конфиденциальность OpenRouter", for: .normal)
            link.titleLabel?.font = .systemFont(ofSize: 12)
            link.tintColor = Theme.accent
            link.contentHorizontalAlignment = .leading
            link.addAction(UIAction { _ in
                if let url = URL(string: "https://openrouter.ai/privacy") { UIApplication.shared.open(url) }
            }, for: .touchUpInside)
            sheet.stack.addArrangedSubview(link)
        }
        let allow = AIKit.wide("Разрешить и отправить", symbol: "arrow.up")
        allow.addAction(UIAction { [weak self, weak sheet] _ in
            self?.conversation.setConsent(true)
            sheet?.dismiss(animated: true)
        }, for: .touchUpInside)
        sheet.stack.addArrangedSubview(allow)
        let cancel = AIKit.wide("Отмена", secondary: true)
        cancel.addAction(UIAction { [weak self, weak sheet] _ in
            self?.afterConsent = nil
            sheet?.dismiss(animated: true)
        }, for: .touchUpInside)
        sheet.stack.addArrangedSubview(cancel)
        sheet.onClosed = { [weak self] in
            guard let self else { return }
            let following = self.afterConsent
            self.afterConsent = nil
            // Swiped away without an answer: nothing is sent.
            if self.conversation.consent { following?() }
        }
        present(sheet, animated: true)
    }

    private func showPlatina(_ what: String) {
        let sheet = AISheetController(heading: "\(what) — с Platina")
        sheet.stack.addArrangedSubview(AIKit.label("Доступно только с подпиской Инвиз Platina", size: 15, weight: .semibold))
        sheet.stack.addArrangedSubview(AIKit.label("Без Platina AI отвечает на текстовые вопросы быстрой моделью. С Platina — выбор моделей, код, вопросы по фото, картинки, видео, озвучка и расшифровка аудио.", size: 13, color: Theme.muted))
        present(sheet, animated: true)
    }

    private static func listTime(_ date: Date) -> String {
        let calendar = Calendar.current
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        if calendar.isDateInToday(date) {
            formatter.dateFormat = "HH:mm"
            return formatter.string(from: date)
        }
        if calendar.isDateInYesterday(date) { return "вчера" }
        formatter.dateFormat = "d MMM"
        return formatter.string(from: date)
    }

    @objc private func showHistory() {
        let sheet = AISheetController(heading: "История AI")
        if history.items.isEmpty { sheet.stack.addArrangedSubview(AIKit.label("Пока нет сохранённых бесед.", size: 13, color: Theme.muted)) }
        for item in history.items {
            let row = UIStackView()
            row.axis = .horizontal
            row.spacing = 6
            row.alignment = .center
            let count = item.turns.count
            let noun = count == 1 ? "вопрос" : (count < 5 ? "вопроса" : "вопросов")
            var config = UIButton.Configuration.plain()
            config.attributedTitle = AttributedString(item.title, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 14, weight: .semibold)]))
            config.attributedSubtitle = AttributedString("\(AIViewController.listTime(AIModel.updated(item))) · \(count) \(noun)", attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 11), .foregroundColor: Theme.muted]))
            config.titleLineBreakMode = .byTruncatingTail
            config.baseForegroundColor = Theme.text
            config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 10, bottom: 12, trailing: 10)
            if item.id == conversationId {
                config.background.backgroundColor = Theme.veil(0.1)
                config.background.cornerRadius = 16
            }
            let openButton = UIButton(configuration: config)
            openButton.contentHorizontalAlignment = .leading
            openButton.addAction(UIAction { [weak self, weak sheet] _ in
                guard let self else { return }
                self.reopen(item.turns, consent: item.consent)
                self.conversationId = item.id
                self.input.text = ""
                self.taskError = ""
                self.textViewDidChange(self.input)
                self.render()
                sheet?.dismiss(animated: true)
            }, for: .touchUpInside)
            row.addArrangedSubview(openButton)
            let trash = UIButton(type: .system)
            trash.setImage(UIImage(systemName: "trash"), for: .normal)
            trash.tintColor = Theme.danger
            trash.accessibilityLabel = "Удалить беседу \(item.title)"
            trash.setContentHuggingPriority(.required, for: .horizontal)
            trash.widthAnchor.constraint(equalToConstant: 44).isActive = true
            trash.addAction(UIAction { [weak self, weak row] _ in
                guard let self else { return }
                self.history.remove(item.id)
                AIMediaCache.delete(AIMediaCache.names(item.turns))
                if item.id == self.conversationId { self.newConversation() }
                row?.removeFromSuperview()
            }, for: .touchUpInside)
            row.addArrangedSubview(trash)
            sheet.stack.addArrangedSubview(row)
        }
        present(sheet, animated: true)
    }

    // MARK: Menus

    /// Model choice: the strategies with a line about each, «Другие модели» with what the server has right now.
    /// Without the FreeLLMAPI router there is one free model; without Platina the other entries are locked.
    private func modelMenu() -> UIMenu {
        let value = router && full ? chosenModel : "auto"
        let locked = router && !full
        var entries: [(id: String, label: String, help: String?)] = [("auto", "Авто", "Бесплатная модель, которую подбирает сервер")]
        if router { entries = AIModel.strategies.map { item -> (id: String, label: String, help: String?) in (id: item.id, label: AIModel.modelLabel(item.id), help: item.help) } }
        func action(_ entry: (id: String, label: String, help: String?), lockedRow: Bool) -> UIAction {
            let made = UIAction(title: entry.label, subtitle: entry.help, image: lockedRow ? UIImage(systemName: "lock.fill") : nil, state: value == entry.id ? .on : .off) { [weak self] _ in
                guard let self else { return }
                if lockedRow { return self.showPlatina("Выбор модели") }
                self.chosenModel = entry.id
                self.render()
            }
            return made
        }
        var children: [UIMenuElement] = entries.map { entry -> UIMenuElement in action(entry, lockedRow: locked && entry.id != value) }
        let known = Set(AIModel.strategies.map { $0.id })
        let more = models.filter { !known.contains($0) }
        if router, !more.isEmpty {
            if locked {
                children.append(UIAction(title: "Другие модели", image: UIImage(systemName: "lock.fill")) { [weak self] _ in self?.showPlatina("Выбор модели") })
            } else {
                let rows: [UIMenuElement] = more.map { id -> UIMenuElement in
                    let parts = id.components(separatedBy: "/")
                    let help: String? = parts.count > 1 ? parts[0] : nil
                    return action((id: id, label: AIModel.modelLabel(id), help: help), lockedRow: false)
                }
                children.append(UIMenu(title: "Другие модели", children: rows))
            }
        }
        let note = !router ? "Выбор моделей появится, когда на сервере подключат FreeLLMAPI." : (!full ? "Выбор модели — с Инвиз Platina." : "")
        return UIMenu(title: note, children: children)
    }

    private func toolsMenu() -> UIMenu {
        let canTranscribe = router && status?.can("transcribe") == true
        let audioAction = UIAction(title: "Аудиофайл → текст", image: UIImage(systemName: full ? "mic" : "lock.fill"), attributes: canTranscribe ? [] : [.disabled]) { [weak self] _ in
            guard let self else { return }
            if !self.full { return self.showPlatina("Аудиофайл → текст") }
            self.transcribeFile()
        }
        // «Фото и видео» and «Документ» (with Platina; when the server allows them).
        let photosAction = UIAction(title: "Фото и видео", image: UIImage(systemName: full ? "photo.on.rectangle" : "lock.fill"), attributes: vision ? [] : [.disabled]) { [weak self] _ in
            guard let self else { return }
            if !self.full { return self.showPlatina("Фото и видео") }
            self.pickPictures()
        }
        let documentAction = UIAction(title: "Документ", image: UIImage(systemName: full ? "doc.text" : "lock.fill"), attributes: docs ? [] : [.disabled]) { [weak self] _ in
            guard let self else { return }
            if !self.full { return self.showPlatina("Документ") }
            self.pickDocuments()
        }
        return UIMenu(title: "Всё в одном чате: приложи фото, видео или документ и спроси о них. Попроси «нарисуй…» — AI нарисует, «сделай из этого аниме» с фото — перерисует.", children: [photosAction, documentAction, audioAction])
    }

    // MARK: Media of an answer

    private func share(_ file: URL) {
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        present(sheet, animated: true)
    }

    private func play(_ file: URL) {
        if audioFile == file, let audio {
            if audio.isPlaying { audio.pause() } else { audio.play() }
            render()
            return
        }
        audio?.stop()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        guard let player = try? AVAudioPlayer(contentsOf: file) else {
            taskError = "Не удалось воспроизвести аудио. Проверь соединение или выбери другой файл."
            render()
            return
        }
        player.delegate = self
        audio = player
        audioFile = file
        player.play()
        render()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        audio = nil
        audioFile = nil
        render()
    }

    private func watch(_ file: URL) {
        let screen = AVPlayerViewController()
        let player = AVPlayer(url: file)
        screen.player = player
        present(screen, animated: true) { player.play() }
    }

    // MARK: The page

    private func build() {
        topBar.axis = .horizontal
        topBar.spacing = 10
        topBar.translatesAutoresizingMaskIntoConstraints = false
        let gap = UIView()
        [historyButton, gap, newButton, privateButton].forEach { topBar.addArrangedSubview($0) }
        if quick {
            // `AIQuickDialog`: «Закрыть» in place of the history.
            historyButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium)), for: .normal)
            historyButton.accessibilityLabel = "Закрыть быстрый вопрос AI"
            historyButton.addTarget(self, action: #selector(closeQuick), for: .touchUpInside)
        } else {
            historyButton.addTarget(self, action: #selector(showHistory), for: .touchUpInside)
        }
        newButton.addTarget(self, action: #selector(newConversation), for: .touchUpInside)
        privateButton.addTarget(self, action: #selector(togglePrivate), for: .touchUpInside)
        view.addSubview(topBar)

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        list.axis = .vertical
        list.spacing = 13
        list.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(list)

        emptyBox.axis = .vertical
        emptyBox.spacing = 14
        emptyBox.alignment = .center
        emptyBox.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(emptyBox)

        composer.backgroundColor = Theme.raised(UIColor(red: 46 / 255, green: 46 / 255, blue: 48 / 255, alpha: 0.96))
        composer.layer.cornerRadius = 30
        composer.layer.borderWidth = 1
        composer.layer.borderColor = Theme.veil(0.1).cgColor
        composer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(composer)
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 6
        column.translatesAutoresizingMaskIntoConstraints = false
        composer.addSubview(column)

        input.backgroundColor = .clear
        input.font = .systemFont(ofSize: 17)
        input.textColor = Theme.text
        input.tintColor = Theme.accent
        input.keyboardAppearance = Theme.dark ? .dark : .light
        input.isScrollEnabled = false
        input.textContainerInset = UIEdgeInsets(top: 10, left: 6, bottom: 6, right: 6)
        input.delegate = self
        input.accessibilityLabel = "Вопрос AI"
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        input.addSubview(placeholder)
        // The attachments, above the question.
        attachScroll.showsHorizontalScrollIndicator = false
        attachScroll.isHidden = true
        attachRow.axis = .horizontal
        attachRow.spacing = 8
        attachRow.alignment = .center
        attachRow.translatesAutoresizingMaskIntoConstraints = false
        attachScroll.addSubview(attachRow)
        NSLayoutConstraint.activate([
            attachScroll.heightAnchor.constraint(equalToConstant: 62),
            attachRow.topAnchor.constraint(equalTo: attachScroll.contentLayoutGuide.topAnchor, constant: 4),
            attachRow.bottomAnchor.constraint(equalTo: attachScroll.contentLayoutGuide.bottomAnchor),
            attachRow.leadingAnchor.constraint(equalTo: attachScroll.contentLayoutGuide.leadingAnchor, constant: 4),
            attachRow.trailingAnchor.constraint(equalTo: attachScroll.contentLayoutGuide.trailingAnchor, constant: -4),
            attachRow.heightAnchor.constraint(equalToConstant: 58),
        ])
        column.addArrangedSubview(attachScroll)
        column.addArrangedSubview(input)

        toolsRow.axis = .horizontal
        toolsRow.spacing = 8
        toolsRow.alignment = .center
        plusButton.layer.borderWidth = 0
        plusButton.showsMenuAsPrimaryAction = true
        modelPill.showsMenuAsPrimaryAction = true
        modelPill.tintColor = Theme.text
        modelPill.titleLabel?.font = .systemFont(ofSize: 14, weight: .medium)
        modelPill.titleLabel?.lineBreakMode = .byTruncatingTail
        modelPill.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        sendButton.addTarget(self, action: #selector(submit), for: .touchUpInside)
        var words = UIButton.Configuration.plain()
        words.attributedTitle = AttributedString(NSAttributedString(string: "Спроси что угодно", attributes: [.font: UIFont.systemFont(ofSize: 17), .foregroundColor: Theme.muted]))
        words.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6)
        words.titleLineBreakMode = .byTruncatingTail
        collapsedWords.configuration = words
        collapsedWords.contentHorizontalAlignment = .leading
        collapsedWords.accessibilityLabel = "Написать вопрос AI"
        collapsedWords.setContentHuggingPriority(.defaultLow, for: .horizontal)
        collapsedWords.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        collapsedWords.heightAnchor.constraint(equalToConstant: 42).isActive = true
        collapsedWords.addAction(UIAction { [weak self] (_: UIAction) -> Void in
            guard let self else { return }
            self.focused = true
            self.applyExpanded()
            self.input.becomeFirstResponder()
        }, for: .touchUpInside)
        toolsSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        [plusButton, collapsedWords, modelPill, toolsSpacer, sendButton].forEach { toolsRow.addArrangedSubview($0) }
        column.addArrangedSubview(toolsRow)

        pendingRow.axis = .horizontal
        pendingRow.spacing = 10
        pendingRow.alignment = .center
        pendingRow.isLayoutMarginsRelativeArrangement = true
        pendingRow.layoutMargins = UIEdgeInsets(top: 4, left: 6, bottom: 4, right: 4)
        let spin = UIActivityIndicatorView(style: .medium)
        spin.color = Theme.accent
        spin.startAnimating()
        let stopButton = AIKit.round("stop.fill", "Отменить ожидание", active: true, size: 42)
        stopButton.backgroundColor = Theme.text
        stopButton.tintColor = Theme.onAccent
        stopButton.addTarget(self, action: #selector(stop), for: .touchUpInside)
        let thinking = AIKit.label("AI думает…", size: 13, color: Theme.muted, lines: 1)
        thinking.setContentHuggingPriority(.defaultLow, for: .horizontal)
        [spin, thinking, stopButton].forEach { pendingRow.addArrangedSubview($0) }
        column.addArrangedSubview(pendingRow)

        let height = input.heightAnchor.constraint(equalToConstant: 44)
        inputHeight = height
        let clearance = composer.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -90)
        barClearance = clearance
        let rest = composer.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        rest.priority = .defaultLow
        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 10),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            scroll.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 4),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -3),
            list.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 8),
            list.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -20),
            list.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 16),
            list.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -16),
            emptyBox.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
            emptyBox.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 36),
            emptyBox.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -36),
            composer.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            composer.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -14),
            composer.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor, constant: -8),
            clearance, rest,
            column.topAnchor.constraint(equalTo: composer.topAnchor, constant: 8),
            column.bottomAnchor.constraint(equalTo: composer.bottomAnchor, constant: -8),
            column.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 8),
            column.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -8),
            height,
            placeholder.leadingAnchor.constraint(equalTo: input.leadingAnchor, constant: 11),
            placeholder.topAnchor.constraint(equalTo: input.topAnchor, constant: 10),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The section sits under the shell's bar: the composer stays above it.
        barClearance?.constant = quick ? -12 : -(BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 10)
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
        focused = true
        applyExpanded()
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        focused = false
        applyExpanded()
    }

    /// G: one line, or the field over the tools row.
    private func applyExpanded() {
        let pending = conversation?.pending ?? false
        let open = expanded
        input.isHidden = pending || !open
        collapsedWords.isHidden = open
        toolsSpacer.isHidden = !open
    }

    func textViewDidChange(_ textView: UITextView) {
        if (textView.text as NSString).length > AILimits.message { textView.text = (textView.text as NSString).substring(to: AILimits.message) }
        placeholder.isHidden = !textView.text.isEmpty
        let fitted = textView.sizeThatFits(CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)).height
        inputHeight?.constant = min(160, max(44, fitted))
        textView.isScrollEnabled = fitted > 160
        paintSend()
        applyExpanded()
    }

    private func paintSend() {
        let can = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && ready
        sendButton.isEnabled = can
        sendButton.backgroundColor = can ? Theme.text : Theme.surface2
        sendButton.tintColor = can ? Theme.onAccent : Theme.muted
    }

    private func notice(_ text: String, error: Bool) -> UIView {
        let box = UIView()
        box.backgroundColor = Theme.veil(0.06)
        box.layer.cornerRadius = 14
        let label = AIKit.label(text, size: 13, color: error ? Theme.danger : Theme.text)
        label.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: box.topAnchor, constant: 12), label.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -12),
            label.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14), label.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14),
        ])
        return box
    }

    private func render() {
        guard isViewLoaded, conversation != nil else { return }
        let turns = conversation.turns
        newButton.isHidden = turns.isEmpty
        privateButton.setImage(UIImage(systemName: incognito ? "eye.slash.fill" : "eye.slash", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium)), for: .normal)
        privateButton.backgroundColor = incognito ? Theme.veil(0.16) : Theme.surface2
        privateButton.accessibilityLabel = incognito ? "Приватная беседа включена: не сохраняется" : "Приватная беседа: не сохранять в историю"

        // The middle of an empty page: checking, an error, «not connected», or the greeting.
        emptyBox.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let empty = turns.isEmpty
        if checking {
            let spin = UIActivityIndicatorView(style: .medium)
            spin.color = Theme.accent
            spin.startAnimating()
            emptyBox.addArrangedSubview(spin)
            emptyBox.addArrangedSubview(AIKit.label("Проверяем доступность AI…", size: 12, color: Theme.muted))
        } else if !statusError.isEmpty {
            emptyBox.addArrangedSubview(AIKit.label(statusError, size: 13, color: Theme.danger, align: .center))
            addRetry()
        } else if !ready && empty {
            let mark = UIImageView(image: UIImage(systemName: "sparkles", withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .regular)))
            mark.tintColor = Theme.muted
            emptyBox.addArrangedSubview(mark)
            emptyBox.addArrangedSubview(AIKit.label("AI пока не подключён на этом сервере", size: 18, weight: .bold, align: .center))
            emptyBox.addArrangedSubview(AIKit.label("Когда администратор подключит сервис, здесь можно будет задать вопрос.", size: 12, color: Theme.muted, align: .center))
            addRetry()
        } else if empty {
            let mark = UIImageView(image: UIImage(systemName: "sparkles", withConfiguration: UIImage.SymbolConfiguration(pointSize: 36, weight: .regular)))
            mark.tintColor = Theme.accent
            emptyBox.addArrangedSubview(mark)
            let hour = Calendar.current.component(.hour, from: Date())
            var greeting = hour < 5 ? "Доброй ночи" : (hour < 12 ? "Доброе утро" : (hour < 18 ? "Добрый день" : "Добрый вечер"))
            let name = ((messenger?.user["displayName"] as? String) ?? "").components(separatedBy: " ").first ?? ""
            if !name.isEmpty { greeting += ", " + name }
            emptyBox.addArrangedSubview(AIKit.label(greeting, size: 28, weight: .medium, align: .center))
            if incognito { emptyBox.addArrangedSubview(AIKit.label("Приватная беседа: она не сохранится в истории.", size: 12, color: Theme.muted, align: .center)) }
        }
        emptyBox.isHidden = !(empty || checking || !statusError.isEmpty)

        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        pendingView = nil
        let canRetry = ready && conversation.consent && !conversation.pending
        for turn in turns {
            var playing = false
            if let media = turn.media, let file = AIMediaCache.url(media.uri), file == audioFile { playing = audio?.isPlaying == true }
            let row = AITurnView(turn: turn, retryable: turn.id == turns.last?.id, canRetry: canRetry, router: router, details: details.contains(turn.id), playing: playing)
            let id = turn.id
            row.onRetry = { [weak self] in self?.conversation.retry() }
            row.onDetails = { [weak self] in
                guard let self else { return }
                if self.details.contains(id) { self.details.remove(id) } else { self.details.insert(id) }
                self.render()
            }
            row.onShare = { [weak self] file in self?.share(file) }
            row.onPlay = { [weak self] file in self?.play(file) }
            row.onVideo = { [weak self] file in self?.watch(file) }
            if turn.status == "pending" { pendingView = row }
            list.addArrangedSubview(row)
        }
        if !conversation.error.isEmpty, conversation.error != turns.last?.error { list.addArrangedSubview(notice(conversation.error, error: true)) }
        if !taskError.isEmpty { list.addArrangedSubview(notice(taskError, error: true)) }
        renderAttachments()
        privateButton.isHidden = quick

        let pending = conversation.pending
        toolsRow.isHidden = pending
        applyExpanded()
        pendingRow.isHidden = !pending
        modelPill.isHidden = !ready
        let value = router && full ? chosenModel : "auto"
        modelPill.setTitle(AIModel.modelLabel(value) + " ⌄", for: .normal)
        modelPill.accessibilityLabel = "Модель AI: \(AIModel.modelLabel(value)). Выбрать другую"
        modelPill.menu = modelMenu()
        plusButton.menu = toolsMenu()
        paintSend()

        clock?.invalidate()
        clock = nil
        if pending {
            clock = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.pendingView?.tick() }
        }
    }

    /// G: the reference's `Button secondary` — a wide glass button (GlassSurface «regular», radius 21, 54 tall), the
    /// icon (20) 10 before the bold words (16); it springs to 0.96 under the finger.
    private func retryButton() -> UIButton {
        var look = UIButton.Configuration.plain()
        look.attributedTitle = AttributedString(NSAttributedString(string: "Проверить снова", attributes: [.font: UIFont.systemFont(ofSize: 16, weight: .bold), .foregroundColor: Theme.text]))
        look.image = UIImage(systemName: "arrow.clockwise", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))
        look.imagePadding = 10
        look.baseForegroundColor = Theme.text
        look.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 21, bottom: 0, trailing: 21)
        let again = UIButton(configuration: look)
        again.translatesAutoresizingMaskIntoConstraints = false
        again.heightAnchor.constraint(equalToConstant: 54).isActive = true
        let glass = GlassBacking.put(under: again, side: 54, scale: 0.96, clear: false)
        glass.radius = 21
        again.addAction(UIAction { [weak self] _ in self?.refreshStatus() }, for: .touchUpInside)
        return again
    }

    /// The retry button stretches across the empty page (`alignSelf: 'stretch'`).
    private func addRetry() {
        let again = retryButton()
        emptyBox.addArrangedSubview(again)
        again.widthAnchor.constraint(equalTo: emptyBox.widthAnchor).isActive = true
    }

    #if targetEnvironment(simulator)
    /// `-aidemo 1`: a short sample conversation (with a block of code) and a sample history, no server.
    private func simulatorDemo() {
        if quick {
            // The quick dialog starts empty.
            status = AIDemo.status
            render()
            return
        }
        status = AIDemo.status
        models = AIDemo.models
        chosenModel = "auto:smart"
        history.simulatorSet(AIDemo.history)
        conversationId = AIDemo.history[0].id
        restored = true
        conversation.restore(AIDemo.turns, consent: true)
        render()
        if UserDefaults.standard.string(forKey: "aidemo") == "history" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.showHistory() }
        }
        // AI: `photo` — attachments above the question; `quick` — the quick dialog over the section.
        let wanted = UserDefaults.standard.string(forKey: "aidemo")
        if wanted == "photo" { simulatorAttachments() }
        if wanted == "quick", !quick {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self else { return }
                AIViewController.presentQuick(over: self, messenger: nil)
            }
        }
    }
    #endif
}

// MARK: AI: attachments and the quick dialog

/// A picture ready to send: a small cleaned JPEG (no EXIF / GPS) as a data URL, and its preview.
struct AIPicture {
    let id: String
    let preview: UIImage
    let data: String
    var video = false
}

/// How a photo or a video becomes pictures for the model (ai/attach.ts): a photo is re-encoded as JPEG (longest side at
/// most 1280, quality .8 — which drops the metadata), a video becomes three frames (beginning, middle, end).
enum AIAttach {
    static let maxPictures = 8
    static let maxDocument = 15 * 1024 * 1024
    static let mediaAsDocument = "Фото и видео прикрепляй кнопкой «Фото и видео»: модель получит копию без метаданных (места съёмки, даты, модели камеры)."

    static func jpeg(_ image: UIImage) throws -> (data: String, preview: UIImage) {
        let size = image.size
        let edge = max(size.width, size.height)
        var target = size
        if edge > 1280 {
            let scale = 1280 / edge
            target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: target, format: format).image { (_: UIGraphicsImageRendererContext) -> Void in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let bytes = small.jpegData(compressionQuality: 0.8) else { throw AIFailure("Не удалось подготовить фото.") }
        let text = bytes.base64EncodedString()
        if text.count > 5_000_000 { throw AIFailure("Фото слишком большое для вопроса.") }
        return ("data:image/jpeg;base64," + text, small)
    }

    /// Frames of a video at the given seconds (those past its end are skipped).
    static func frames(_ file: URL, at seconds: [Double]) -> [UIImage] {
        let asset = AVURLAsset(url: file)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
        var out: [UIImage] = []
        for second in seconds {
            if let frame = try? generator.copyCGImage(at: CMTime(seconds: second, preferredTimescale: 600), actualTime: nil) { out.append(UIImage(cgImage: frame)) }
        }
        return out
    }

    static func videoLength(_ file: URL) -> Double {
        let seconds = AVURLAsset(url: file).duration.seconds
        return seconds.isFinite ? seconds : 0
    }
}

extension AIViewController: PHPickerViewControllerDelegate {
    @objc private func closeQuick() { dismiss(animated: true) }

    /// Opens the quick dialog over a screen (`AIQuickDialog`): a page sheet with its own conversation, no history.
    static func presentQuick(over screen: UIViewController, messenger: Messenger?) {
        let dialog = AIViewController(messenger: messenger, quick: true)
        dialog.modalPresentationStyle = .pageSheet
        screen.present(dialog, animated: true)
    }

    fileprivate func pickPictures() {
        let room = AIAttach.maxPictures - pictures.count
        if room <= 0 {
            taskError = "К вопросу — до \(AIAttach.maxPictures) фото и кадров."
            return render()
        }
        var config = PHPickerConfiguration()
        config.filter = .any(of: [.images, .videos])
        config.selectionLimit = room
        config.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        let room = AIAttach.maxPictures - pictures.count
        for (index, result) in results.prefix(max(0, room)).enumerated() {
            let provider = result.itemProvider
            let id = (result.assetIdentifier ?? UUID().uuidString) + "#\(index)"
            if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { [weak self] (url: URL?, _: Error?) -> Void in
                    guard let url else { return }
                    let length = AIAttach.videoLength(url)
                    let stops: [Double] = length > 1 ? [length * 0.1, length * 0.5, length * 0.9] : [0]
                    let made = AIAttach.frames(url, at: stops)
                    DispatchQueue.main.async { self?.addPictures(made, id: id, video: true) }
                }
            } else if provider.canLoadObject(ofClass: UIImage.self) {
                _ = provider.loadObject(ofClass: UIImage.self) { [weak self] (object: NSItemProviderReading?, _: Error?) -> Void in
                    guard let image = object as? UIImage else { return }
                    DispatchQueue.main.async { self?.addPictures([image], id: id, video: false) }
                }
            }
        }
    }

    private func addPictures(_ images: [UIImage], id: String, video: Bool) {
        for (index, image) in images.enumerated() {
            if pictures.count >= AIAttach.maxPictures { break }
            do {
                let made = try AIAttach.jpeg(image)
                pictures.append(AIPicture(id: id + "-\(index)", preview: made.preview, data: made.data, video: video))
                taskError = ""
            } catch {
                taskError = (error as? AIFailure)?.words ?? "Не удалось подготовить фото."
            }
        }
        render()
    }

    fileprivate func pickDocuments() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.item], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = true
        pickingDocuments = true
        present(picker, animated: true)
    }

    /// Files chosen as «Документ»: a photo or a video in them is prepared like «Фото и видео» does (never sent as it is);
    /// everything else is read into text by the server.
    fileprivate func tookDocuments(_ urls: [URL]) {
        guard let server = messenger?.server else { return }
        for file in urls {
            let type = UTType(filenameExtension: file.pathExtension)
            let video = type?.conforms(to: .movie) == true || type?.conforms(to: .video) == true
            let photo = type?.conforms(to: .image) == true
            if video || photo {
                if pictures.count >= AIAttach.maxPictures {
                    taskError = "К вопросу — до \(AIAttach.maxPictures) фото и кадров."
                } else if photo, let image = UIImage(contentsOfFile: file.path) {
                    addPictures([image], id: file.lastPathComponent, video: false)
                } else if video {
                    // The length is not known here: a frame near the start and, when the video is long enough, two later ones.
                    let made = AIAttach.frames(file, at: [0.4, 3, 9])
                    if made.isEmpty { taskError = AIAttach.mediaAsDocument } else { addPictures(made, id: file.lastPathComponent, video: true) }
                } else {
                    taskError = AIAttach.mediaAsDocument
                }
                try? FileManager.default.removeItem(at: file)
                continue
            }
            let name = file.lastPathComponent
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            guard size <= AIAttach.maxDocument, let bytes = try? Data(contentsOf: file), bytes.count <= AIAttach.maxDocument else {
                try? FileManager.default.removeItem(at: file)
                taskError = size > AIAttach.maxDocument ? "«\(name)» больше 15 МБ." : "Не удалось открыть документ."
                continue
            }
            try? FileManager.default.removeItem(at: file)
            reading += 1
            taskError = ""
            AIClient.document(server, name: name, data: bytes) { [weak self] (result: Result<AIDocumentText, AIFailure>) -> Void in
                guard let self else { return }
                self.reading -= 1
                switch result {
                case .success(let doc):
                    var kept = self.documents.filter { (item: AIDocumentText) -> Bool in item.name != doc.name }
                    kept.append(doc)
                    self.documents = Array(kept.suffix(5))
                case .failure(let failure):
                    self.taskError = "«\(name)»: " + (failure.words.isEmpty ? "не удалось прочитать." : failure.words)
                }
                self.render()
            }
        }
        render()
    }

    /// The strip of attachments above the question.
    fileprivate func renderAttachments() {
        attachRow.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for item in pictures {
            let box = UIView()
            let face = UIImageView(image: item.preview)
            face.contentMode = .scaleAspectFill
            face.clipsToBounds = true
            face.layer.cornerRadius = 12
            face.backgroundColor = Theme.surface2
            face.frame = CGRect(x: 0, y: 4, width: 54, height: 54)
            box.addSubview(face)
            if item.video {
                let mark = UIImageView(image: UIImage(systemName: "video.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .bold)))
                mark.tintColor = .white
                mark.backgroundColor = UIColor(white: 0, alpha: 0.55)
                mark.layer.cornerRadius = 6
                mark.contentMode = .center
                mark.frame = CGRect(x: 4, y: 42, width: 20, height: 13)
                box.addSubview(mark)
            }
            let remove = UIButton(type: .system)
            remove.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .bold)), for: .normal)
            remove.tintColor = Theme.dark ? UIColor(hex: 0x111111) : .white
            remove.backgroundColor = Theme.text
            remove.layer.cornerRadius = 10
            remove.frame = CGRect(x: 54 - 15, y: -1, width: 20, height: 20)
            remove.accessibilityLabel = "Убрать"
            let id = item.id
            remove.addAction(UIAction { [weak self] _ in
                self?.pictures.removeAll { (other: AIPicture) -> Bool in other.id == id }
                self?.render()
            }, for: .touchUpInside)
            box.addSubview(remove)
            box.widthAnchor.constraint(equalToConstant: 60).isActive = true
            box.heightAnchor.constraint(equalToConstant: 58).isActive = true
            attachRow.addArrangedSubview(box)
        }
        for doc in documents {
            let chip = UIStackView()
            chip.axis = .horizontal
            chip.spacing = 7
            chip.alignment = .center
            chip.backgroundColor = Theme.surface2
            chip.layer.cornerRadius = 12
            chip.isLayoutMarginsRelativeArrangement = true
            chip.layoutMargins = UIEdgeInsets(top: 0, left: 10, bottom: 0, right: 6)
            let icon = UIImageView(image: UIImage(systemName: "doc.text", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular)))
            icon.tintColor = Theme.accent
            let title = AIKit.label(doc.name, size: 13, weight: .semibold, lines: 1)
            let state = AIKit.label((doc.pages.map { "\($0) стр. · " } ?? "") + (doc.truncated ? "прочитано начало" : "прочитан"), size: 10, color: Theme.muted, lines: 1)
            let words = UIStackView(arrangedSubviews: [title, state])
            words.axis = .vertical
            let remove = UIButton(type: .system)
            remove.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)), for: .normal)
            remove.tintColor = Theme.muted
            remove.accessibilityLabel = "Убрать документ \(doc.name)"
            let name = doc.name
            remove.addAction(UIAction { [weak self] _ in
                self?.documents.removeAll { (other: AIDocumentText) -> Bool in other.name == name }
                self?.render()
            }, for: .touchUpInside)
            [icon, words, remove].forEach { chip.addArrangedSubview($0) }
            chip.heightAnchor.constraint(equalToConstant: 54).isActive = true
            chip.widthAnchor.constraint(lessThanOrEqualToConstant: 220).isActive = true
            attachRow.addArrangedSubview(chip)
        }
        if reading > 0 {
            let chip = UIStackView()
            chip.axis = .horizontal
            chip.spacing = 7
            chip.alignment = .center
            chip.backgroundColor = Theme.surface2
            chip.layer.cornerRadius = 12
            chip.isLayoutMarginsRelativeArrangement = true
            chip.layoutMargins = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
            let spin = UIActivityIndicatorView(style: .medium)
            spin.color = Theme.accent
            spin.startAnimating()
            [spin, AIKit.label("Читаю документ…", size: 12, color: Theme.muted, lines: 1)].forEach { chip.addArrangedSubview($0) }
            chip.heightAnchor.constraint(equalToConstant: 54).isActive = true
            attachRow.addArrangedSubview(chip)
        }
        attachScroll.isHidden = attachRow.arrangedSubviews.isEmpty || conversation.pending
    }

    #if targetEnvironment(simulator)
    /// `-aidemo photo`: two attached pictures (drawn here, a video frame among them) and a document, above the question.
    fileprivate func simulatorAttachments() {
        func drawn(_ colours: [UInt32]) -> UIImage {
            return UIGraphicsImageRenderer(size: CGSize(width: 120, height: 120)).image { (context: UIGraphicsImageRendererContext) -> Void in
                let stops = colours.map { UIColor(hex: $0).cgColor } as CFArray
                if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: stops, locations: [0, 1]) {
                    context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 120, y: 120), options: [])
                }
            }
        }
        pictures = [AIPicture(id: "demo-1", preview: drawn([0x2F5BE0, 0x58B7F2]), data: ""),
                    AIPicture(id: "demo-2", preview: drawn([0x0E7C66, 0x2BD4A0]), data: "", video: true)]
        var doc = AIDocumentText(name: "Отчёт.pdf", text: "")
        doc.pages = 12
        documents = [doc]
        input.text = "Сделай из этого аниме"
        textViewDidChange(input)
        render()
    }
    #endif
}

