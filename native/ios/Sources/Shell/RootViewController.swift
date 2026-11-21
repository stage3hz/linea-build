import UIKit

/// The app's shell: the sections one over another, and the bar at the bottom that chooses between them.
final class RootViewController: UIViewController {
    private struct Section { let id: String; let label: String; let symbol: String; let make: () -> UIViewController }

    /// The signed-in account; nil shows the shell with the simulator's samples.
    private let messenger: Messenger?

    init(messenger: Messenger? = nil) {
        self.messenger = messenger
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    private lazy var sections: [Section] = [
        Section(id: "chats", label: "Чаты", symbol: "bubble.left.and.bubble.right") { [messenger] in ChatsViewController(messenger: messenger) },
        Section(id: "ai", label: "AI", symbol: "sparkles") { PlaceholderViewController(title: "AI") },
        Section(id: "people", label: "Люди", symbol: "person.2") { PlaceholderViewController(title: "Люди") },
        Section(id: "channels", label: "Каналы", symbol: "dot.radiowaves.left.and.right") { PlaceholderViewController(title: "Каналы") },
        Section(id: "music", label: "Музыка", symbol: "headphones") { PlaceholderViewController(title: "Музыка") },
        Section(id: "profile", label: "Настройки", symbol: "gearshape") { SettingsViewController() },
    ]
    /// The two sections that have an icon in the bar; the others are in the list under the first one.
    private let inBar = ["chats", "profile"]

    private let bar = TabBarView()
    private let stage = UIView()
    private var pages: [String: UIViewController] = [:]
    private(set) var open = ""
    /// The section that was open when a preview from the list began: a cancelled list goes back to it.
    private var beforePreview: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        stage.frame = view.bounds
        stage.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(stage)
        bar.setItems(sections.map { TabEntry(id: $0.id, label: $0.label, symbol: $0.symbol, badge: 0, dot: "") })
        bar.setBar(inBar)
        bar.setDark(true)
        bar.moreWords = "Остальные разделы"
        bar.onSelect = { [weak self] event in
            guard let self, let id = event["id"] as? String else { return }
            self.beforePreview = nil
            self.show(id)
        }
        bar.onPreview = { [weak self] event in
            guard let self, let id = event["id"] as? String else { return }
            if id.isEmpty { if let back = self.beforePreview { self.beforePreview = nil; self.show(back) } }
            else { if self.beforePreview == nil { self.beforePreview = self.open }; self.show(id, quiet: true) }
        }
        view.addSubview(bar)
        show("chats")
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let gap = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom)
        bar.frame = CGRect(x: (view.bounds.width - BarMetrics.width) / 2, y: view.bounds.height - gap - BarMetrics.height, width: BarMetrics.width, height: BarMetrics.height)
    }

    /// Opens a section. `quiet`: a look from the list — the bar's own choice stays where it is.
    func show(_ id: String, quiet: Bool = false) {
        guard id != open, let section = sections.first(where: { $0.id == id }) else { return }
        let next = pages[id] ?? section.make()
        if pages[id] == nil { pages[id] = next; addChild(next); next.didMove(toParent: self) }
        let previous = pages[open]?.view
        next.view.frame = stage.bounds
        next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        next.view.alpha = 0
        stage.addSubview(next.view)
        open = id
        if !quiet { bar.setActive(id) }
        UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: {
            next.view.alpha = 1
            previous?.alpha = 0
        }, completion: { _ in
            if let previous, self.pages[self.open]?.view !== previous { previous.removeFromSuperview() }
        })
    }

    #if targetEnvironment(simulator)
    /// For the simulator check: opens the first chat of the list.
    func openFirstChat() { (pages["chats"] as? ChatsViewController)?.openFirst() }
    #endif

    /// The list of the sections without an icon (for a check on the simulator and for accessibility).
    func showSections() { bar.openList(sticky: true) }
}

/// A section that is not built yet: its name on the page, nothing else.
final class PlaceholderViewController: UIViewController {
    private let heading = UILabel()

    init(title: String) {
        super.init(nibName: nil, bundle: nil)
        heading.text = title
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        heading.font = .systemFont(ofSize: 34, weight: .bold)
        heading.textColor = Theme.text
        heading.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(heading)
        NSLayoutConstraint.activate([
            heading.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            heading.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
        ])
    }
}
