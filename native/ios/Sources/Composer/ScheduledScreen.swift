import UIKit

/// «Отложенные сообщения» of one chat (the reference's scheduled/ScheduledScreen.tsx): each item shows when it
/// goes out and its text as this device still holds it; «Отправить сейчас» releases it at once, the bin deletes
/// it before it is sent. A failed item (the other side's devices changed) is encrypted afresh and sent by the
/// app by itself as soon as it is online — the row says so.
final class ScheduledScreenController: UIViewController {
    private let store: ScheduledStore?
    private let chatId: String
    private let peerName: String
    private let close = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let scroll = UIScrollView()
    private let intro = UILabel()
    private var cards: [ScheduledCard] = []
    private let empty = UIView()
    private let emptyMark = UIImageView()
    private let emptyTitle = UILabel()
    private let emptyNote = UILabel()
    /// The simulator's samples (no account).
    private var samples: [ScheduledItem]?
    /// A short line about what went wrong.
    var onProblem: ((String) -> Void)?

    init(store: ScheduledStore?, chatId: String, peerName: String, samples: [ScheduledItem]? = nil) {
        self.store = store
        self.chatId = chatId
        self.peerName = peerName
        self.samples = samples
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 28
        }
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var items: [ScheduledItem] { samples ?? store?.items(chatId: chatId) ?? [] }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.page(UIColor(hex: 0x141516))
        close.setImage(chatSymbol("xmark", 17, .semibold), for: .normal)
        close.tintColor = Theme.text
        close.accessibilityLabel = "Закрыть"
        close.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        view.addSubview(close)
        titleLabel.text = "Отложенные сообщения"
        titleLabel.font = .systemFont(ofSize: 17, weight: .bold)
        titleLabel.textColor = Theme.text
        view.addSubview(titleLabel)
        subtitleLabel.font = .systemFont(ofSize: 12)
        subtitleLabel.textColor = Theme.muted
        view.addSubview(subtitleLabel)
        view.addSubview(scroll)
        scroll.alwaysBounceVertical = true
        intro.text = "Сообщение уже зашифровано на этом устройстве и уйдёт само в выбранное время, даже если телефон будет выключен. Сервер видит только зашифрованные данные."
        intro.font = .systemFont(ofSize: 12)
        intro.textColor = Theme.muted
        intro.numberOfLines = 0
        scroll.addSubview(intro)

        emptyMark.image = chatSymbol("clock", 40, .light)
        emptyMark.tintColor = Theme.muted
        emptyMark.contentMode = .center
        empty.addSubview(emptyMark)
        emptyTitle.text = "Нет отложенных сообщений"
        emptyTitle.font = .systemFont(ofSize: 17, weight: .semibold)
        emptyTitle.textColor = Theme.text
        emptyTitle.textAlignment = .center
        empty.addSubview(emptyTitle)
        emptyNote.text = "Удержи кнопку отправки и выбери «Отправить позже» — сообщение уйдёт в нужное время."
        emptyNote.font = .systemFont(ofSize: 14)
        emptyNote.textColor = Theme.muted
        emptyNote.textAlignment = .center
        emptyNote.numberOfLines = 0
        empty.addSubview(emptyNote)
        view.addSubview(empty)

        NotificationCenter.default.addObserver(self, selector: #selector(changed), name: ScheduledStore.changed, object: nil)
        show()
        store?.refresh()
    }

    @objc private func changed() { show() }

    @objc private func closeNow() { dismiss(animated: true) }

    private func show() {
        let list = items
        subtitleLabel.text = list.isEmpty ? peerName : ScheduleModel.countScheduled(list.count)
        cards.forEach { $0.removeFromSuperview() }
        cards = list.map { (item: ScheduledItem) -> ScheduledCard in
            let card = ScheduledCard(item: item, busy: store?.busy.contains(item.id) ?? false)
            card.onSendNow = { [weak self] in self?.sendNow(item) }
            card.onDelete = { [weak self] in self?.delete(item) }
            scroll.addSubview(card)
            return card
        }
        empty.isHidden = !list.isEmpty
        scroll.isHidden = list.isEmpty
        view.setNeedsLayout()
    }

    private func sendNow(_ item: ScheduledItem) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        guard let store else {
            samples?.removeAll { $0.id == item.id }
            show()
            return
        }
        store.sendNow(item) { [weak self] (problem: String?) -> Void in
            if let problem { self?.say(problem) }
        }
    }

    private func delete(_ item: ScheduledItem) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        guard let store else {
            samples?.removeAll { $0.id == item.id }
            show()
            return
        }
        store.delete(item) { [weak self] (problem: String?) -> Void in
            if let problem { self?.say(problem) }
        }
    }

    private func say(_ words: String) {
        let alert = UIAlertController(title: nil, message: words, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
        present(alert, animated: true)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        close.frame = CGRect(x: 10, y: 18, width: 44, height: 44)
        titleLabel.frame = CGRect(x: 60, y: 20, width: width - 76, height: 22)
        subtitleLabel.frame = CGRect(x: 60, y: 42, width: width - 76, height: 16)
        scroll.frame = CGRect(x: 0, y: 70, width: width, height: view.bounds.height - 70)
        let inner = width - 32
        let introHeight = ceil(intro.sizeThatFits(CGSize(width: inner - 8, height: 200)).height)
        intro.frame = CGRect(x: 20, y: 6, width: inner - 8, height: introHeight)
        var y = intro.frame.maxY + 10
        for card in cards {
            let height = card.wantedHeight(width: inner)
            card.frame = CGRect(x: 16, y: y, width: inner, height: height)
            y += height + 10
        }
        scroll.contentSize = CGSize(width: width, height: y + 40)
        empty.frame = CGRect(x: 24, y: 70, width: width - 48, height: view.bounds.height - 140)
        let noteHeight = ceil(emptyNote.sizeThatFits(CGSize(width: width - 48, height: 200)).height)
        let block: CGFloat = 52 + 12 + 24 + 8 + noteHeight
        var top = (empty.bounds.height - block) / 2
        emptyMark.frame = CGRect(x: 0, y: top, width: width - 48, height: 52)
        top += 64
        emptyTitle.frame = CGRect(x: 0, y: top, width: width - 48, height: 24)
        top += 32
        emptyNote.frame = CGRect(x: 0, y: top, width: width - 48, height: noteHeight)
    }

    #if targetEnvironment(simulator)
    /// The simulator's sample list: one message for this evening, without sound, and one that could not go out.
    static func demoItems() -> [ScheduledItem] {
        let tonight = ScheduleModel.withDayTime(Date(), hour: 20, minute: 0)
        let tomorrow = ScheduleModel.withDayTime(Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date(), hour: 9, minute: 0)
        var first = ScheduledItem(["id": "s1", "chatId": "demo", "clientId": "c1", "deliverAt": ScheduleModel.iso(tonight), "status": "scheduled", "createdAt": ScheduleModel.iso(Date())])
        first?.text = "Не забудь распечатки к встрече"
        first?.cryptoState = "decrypted"
        first?.meta = ["silent": true]
        var second = ScheduledItem(["id": "s2", "chatId": "demo", "clientId": "c2", "deliverAt": ScheduleModel.iso(tomorrow), "status": "failed", "failure": "BLOCKED", "createdAt": ScheduleModel.iso(Date())])
        second?.text = "С днём рождения! 🎉"
        second?.cryptoState = "decrypted"
        return [first, second].compactMap { $0 }
    }
    #endif
}

/// One scheduled message: when it goes out, «без звука», its text, why it failed, «Отправить сейчас» and the bin.
private final class ScheduledCard: UIView {
    private let item: ScheduledItem
    private let mark = UIImageView()
    private let whenLabel = UILabel()
    private let silentPill = UIView()
    private let silentMark = UIImageView()
    private let silentLabel = UILabel()
    private let bodyLabel = UILabel()
    private let failureLabel = UILabel()
    private let sendButton = UIButton(type: .custom)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let deleteButton = UIButton(type: .custom)
    var onSendNow: (() -> Void)?
    var onDelete: (() -> Void)?

    init(item: ScheduledItem, busy: Bool) {
        self.item = item
        super.init(frame: .zero)
        let ink = item.failed ? Theme.danger : Theme.accent
        backgroundColor = Theme.surface2
        layer.cornerRadius = 20
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        layer.borderColor = (item.failed ? Theme.danger : Theme.veil(0.08)).cgColor
        mark.image = chatSymbol(item.failed ? "exclamationmark.circle" : "clock", 16)
        mark.tintColor = ink
        mark.contentMode = .center
        addSubview(mark)
        whenLabel.text = ScheduleModel.formatDeliverAt(iso: item.deliverAt)
        whenLabel.font = .systemFont(ofSize: 13, weight: .bold)
        whenLabel.textColor = ink
        addSubview(whenLabel)
        silentPill.backgroundColor = Theme.accent.withAlphaComponent(0.16)
        silentPill.layer.cornerRadius = 10
        silentPill.isHidden = !item.silent
        silentMark.image = chatSymbol("speaker.slash", 11)
        silentMark.tintColor = Theme.accent
        silentMark.contentMode = .center
        silentPill.addSubview(silentMark)
        silentLabel.text = "без звука"
        silentLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        silentLabel.textColor = Theme.accent
        silentPill.addSubview(silentLabel)
        addSubview(silentPill)
        bodyLabel.text = item.body
        bodyLabel.font = .systemFont(ofSize: 15)
        bodyLabel.textColor = Theme.text
        bodyLabel.numberOfLines = 6
        addSubview(bodyLabel)
        failureLabel.font = .systemFont(ofSize: 12)
        failureLabel.textColor = Theme.muted
        failureLabel.numberOfLines = 0
        failureLabel.isHidden = !item.failed
        failureLabel.text = item.canResend ? ScheduleModel.failureText(item.failure) : ScheduleModel.failureText(item.failure) + " Отправить заново можно только с устройства, где сообщение написано."
        addSubview(failureLabel)
        let sendable = !busy && !(item.failed && !item.canResend)
        sendButton.backgroundColor = Theme.accent
        sendButton.layer.cornerRadius = 14
        sendButton.layer.cornerCurve = .continuous
        sendButton.setTitle(busy ? "" : "  Отправить сейчас", for: .normal)
        sendButton.setImage(busy ? nil : chatSymbol("paperplane", 15), for: .normal)
        sendButton.tintColor = Theme.onAccent
        sendButton.setTitleColor(Theme.onAccent, for: .normal)
        sendButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        sendButton.isEnabled = sendable
        sendButton.alpha = sendable ? 1 : 0.45
        sendButton.addTarget(self, action: #selector(sendNow), for: .touchUpInside)
        addSubview(sendButton)
        spinner.color = Theme.onAccent
        if busy { spinner.startAnimating() }
        sendButton.addSubview(spinner)
        deleteButton.backgroundColor = Theme.accent.withAlphaComponent(0.16)
        deleteButton.layer.cornerRadius = 14
        deleteButton.layer.cornerCurve = .continuous
        deleteButton.setImage(chatSymbol("trash", 17), for: .normal)
        deleteButton.tintColor = Theme.danger
        deleteButton.accessibilityLabel = "Удалить отложенное сообщение"
        deleteButton.isEnabled = !busy
        deleteButton.alpha = busy ? 0.45 : 1
        deleteButton.addTarget(self, action: #selector(deleteNow), for: .touchUpInside)
        addSubview(deleteButton)
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func sendNow() { onSendNow?() }
    @objc private func deleteNow() { onDelete?() }

    func wantedHeight(width: CGFloat) -> CGFloat {
        let inner = width - 28
        var height: CGFloat = 14 + 20 + 8
        height += ceil(bodyLabel.sizeThatFits(CGSize(width: inner, height: 400)).height) + 8
        if item.failed { height += ceil(failureLabel.sizeThatFits(CGSize(width: inner, height: 400)).height) + 8 }
        return height + 2 + 40 + 14
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width, inner = width - 28
        mark.frame = CGRect(x: 14, y: 14, width: 18, height: 20)
        // The reference's chip: 8 in, the glyph 13, 4, the words, 8 in — as wide as its words (a fixed 82 cut them).
        let pillWidth: CGFloat = item.silent ? 8 + 13 + 4 + ceil(silentLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 20)).width) + 8 : 0
        whenLabel.frame = CGRect(x: 40, y: 14, width: inner - 26 - pillWidth - 8, height: 20)
        silentPill.frame = CGRect(x: width - 14 - pillWidth, y: 14, width: pillWidth, height: 20)
        silentMark.frame = CGRect(x: 8, y: 0, width: 13, height: 20)
        silentLabel.frame = CGRect(x: 25, y: 0, width: max(0, pillWidth - 33), height: 20)
        var y: CGFloat = 42
        let bodyHeight = ceil(bodyLabel.sizeThatFits(CGSize(width: inner, height: 400)).height)
        bodyLabel.frame = CGRect(x: 14, y: y, width: inner, height: bodyHeight)
        y += bodyHeight + 8
        if item.failed {
            let failHeight = ceil(failureLabel.sizeThatFits(CGSize(width: inner, height: 400)).height)
            failureLabel.frame = CGRect(x: 14, y: y, width: inner, height: failHeight)
            y += failHeight + 8
        }
        y += 2
        sendButton.frame = CGRect(x: 14, y: y, width: inner - 44 - 8, height: 40)
        spinner.center = CGPoint(x: sendButton.bounds.midX, y: sendButton.bounds.midY)
        deleteButton.frame = CGRect(x: width - 14 - 44, y: y, width: 44, height: 40)
    }
}
