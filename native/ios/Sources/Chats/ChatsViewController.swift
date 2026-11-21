import UIKit

/// The first section: the list of chats.
final class ChatsViewController: UIViewController {
    private let heading = UILabel()
    private let list = ChatListView()
    private let empty = UILabel()

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
        var rows: [ChatRow] = []
        #if targetEnvironment(simulator)
        rows = SimulatorDemo.chats()
        #endif
        list.setRows(rows)
        empty.isHidden = !rows.isEmpty
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
