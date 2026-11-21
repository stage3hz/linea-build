import UIKit

/// The first section: the list of chats.
final class ChatsViewController: UIViewController {
    private let heading = UILabel()
    private let list = ChatListView()
    private let empty = UILabel()
    /// The account whose chats are shown; nil shows the simulator's samples (or nothing on a phone).
    private let messenger: Messenger?
    private var summaries: [Messenger.ChatSummary] = []
    private var demo: [ChatRow] = []

    init(messenger: Messenger? = nil) {
        self.messenger = messenger
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        list.setPalette(Theme.chatList)
        view.addSubview(list)
        heading.text = "Чаты"
        heading.font = .systemFont(ofSize: 34, weight: .bold)
        heading.textColor = Theme.text
        view.addSubview(heading)
        empty.text = "Пока нет чатов"
        empty.font = .systemFont(ofSize: 17)
        empty.textColor = Theme.muted
        empty.textAlignment = .center
        view.addSubview(empty)
        list.onRowPress = { [weak self] event in
            guard let self, let id = event["id"] as? String else { return }
            if let chat = self.summaries.first(where: { $0.id == id }), let messenger = self.messenger {
                let screen = ChatViewController(name: chat.title, messenger: messenger, chatId: chat.id, peerId: chat.peerId)
                screen.peerLastRead = chat.peerLastRead
                self.navigationController?.pushViewController(screen, animated: true)
            } else if let row = self.demo.first(where: { $0.id == id }) {
                self.navigationController?.pushViewController(ChatViewController(name: row.title), animated: true)
            }
        }
        if messenger != nil { NotificationCenter.default.addObserver(self, selector: #selector(changed), name: Messenger.changed, object: nil) }
        if messenger == nil {
            #if targetEnvironment(simulator)
            demo = SimulatorDemo.chats()
            #endif
            list.setRows(demo)
            empty.isHidden = !demo.isEmpty
        } else {
            empty.text = "Загрузка…"
        }
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// Something changed on the server: the list is read again (a burst of events is one reading).
    @objc private func changed() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(reloadSoon), object: nil)
        perform(#selector(reloadSoon), with: nil, afterDelay: 0.25)
    }

    @objc private func reloadSoon() { reload() }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        reload()
    }

    #if targetEnvironment(simulator)
    func openFirst() {
        guard let chat = summaries.first, let messenger else { return }
        let screen = ChatViewController(name: chat.title, messenger: messenger, chatId: chat.id, peerId: chat.peerId)
        screen.peerLastRead = chat.peerLastRead
        navigationController?.pushViewController(screen, animated: false)
    }
    #endif

    /// Asks the server for the chats again (on opening the screen and on coming back from a chat).
    func reload() {
        messenger?.chats { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let chats):
                self.summaries = chats
                self.list.setRows(ChatRow.parse(chats.map { $0.row }))
                self.empty.text = "Пока нет чатов"
                self.empty.isHidden = !chats.isEmpty
            case .failure(let error):
                if self.summaries.isEmpty { self.empty.text = error.words; self.empty.isHidden = false }
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top
        heading.frame = CGRect(x: 20, y: top + 8, width: view.bounds.width - 40, height: 41)
        list.frame = view.bounds
        let barRoom = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 12
        list.setPad(top: Double(top + 8 + 41 + 8), bottom: Double(barRoom))
        empty.frame = CGRect(x: 20, y: view.bounds.midY - 12, width: view.bounds.width - 40, height: 24)
    }
}
