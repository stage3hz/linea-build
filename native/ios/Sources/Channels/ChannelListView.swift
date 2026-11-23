import UIKit

// The list of a channel's messages, on the principles of Sources/Chat/MessageList.swift: a table with reused
// cells, one drawn view per row, no Auto Layout inside rows, and the table turned upside down — index 0 is the
// newest message at the bottom, so older pages are added at the far end and nothing on screen moves.
//
// What is different: the list never measures anything. It is handed finished layouts (made off the main thread
// by ChannelEngine) in small patches — one row in, one row changed, one row out, a page of older rows — and
// only puts them into the table. A new message is one inserted row; an edit or a reaction is one redrawn row.

/// A change of the list, ready to be shown. Rows are oldest first.
struct ChannelPatch {
    /// Not nil: everything is replaced by these rows.
    var reset: [ChannelRowLayout]?
    var removed: [Int] = []
    var updated: [ChannelRowLayout] = []
    /// A page of older rows, to stand before everything shown.
    var older: [ChannelRowLayout] = []
    /// New rows, to stand after everything shown.
    var newest: [ChannelRowLayout] = []
    /// One of the new rows is the person's own: the list goes to its end.
    var own = false

    init() {}

    var isEmpty: Bool { return reset == nil && removed.isEmpty && updated.isEmpty && older.isEmpty && newest.isEmpty }
}

final class ChannelListView: UIView, UITableViewDataSource, UITableViewDelegate, UIGestureRecognizerDelegate {
    /// The oldest rows are about to be shown: time to bring a page of older ones.
    var onNearTop: () -> Void = {}
    var onPress: (ChannelRowLayout, ChannelHit) -> Void = { _, _ in }
    /// A row held: the layout, and where on the screen.
    var onLongPress: (ChannelRowLayout, CGFloat) -> Void = { _, _ in }
    /// The width rows are laid out for has changed.
    var onWidth: (CGFloat) -> Void = { _ in }

    private let table = UITableView(frame: .zero, style: .plain)
    private let toEnd = UIButton(type: .system)
    /// Newest first (index 0 is at the bottom of the screen).
    private var items: [ChannelRowLayout] = []
    /// The person is at the newest message (changed only by their own scrolling).
    private var pinned = true
    private var padInsets = UIEdgeInsets.zero
    private var askedAt = 0
    private var knownWidth: CGFloat = 0

    var isEmpty: Bool { return items.isEmpty }
    /// The newest row shown, if any.
    var newest: ChannelRowLayout? { return items.first }

    required init?(coder: NSCoder) { return nil }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.showsVerticalScrollIndicator = false
        table.contentInsetAdjustmentBehavior = .never
        table.keyboardDismissMode = .interactive
        table.estimatedRowHeight = 0
        table.estimatedSectionHeaderHeight = 0
        table.estimatedSectionFooterHeight = 0
        table.allowsSelection = false
        table.transform = CGAffineTransform(scaleX: 1, y: -1)
        table.register(ChannelRowCell.self, forCellReuseIdentifier: "row")
        table.dataSource = self
        table.delegate = self
        table.sectionHeaderTopPadding = 0
        table.bounds = CGRect(origin: .zero, size: bounds.size)
        table.center = CGPoint(x: bounds.midX, y: bounds.midY)
        addSubview(table)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.delegate = self
        table.addGestureRecognizer(tap)
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.minimumPressDuration = 0.35
        table.addGestureRecognizer(hold)

        toEnd.setImage(IonIcon.image("chevron-down", size: 20), for: .normal)
        toEnd.tintColor = Theme.text
        toEnd.backgroundColor = Theme.surface2
        toEnd.layer.cornerRadius = 19
        toEnd.layer.borderWidth = 0.5
        toEnd.layer.borderColor = Theme.veil(0.10).cgColor
        toEnd.accessibilityLabel = "К новым сообщениям"
        toEnd.alpha = 0
        toEnd.addTarget(self, action: #selector(goToEnd), for: .touchUpInside)
        addSubview(toEnd)
        NotificationCenter.default.addObserver(self, selector: #selector(pictureReady(_:)), name: ChannelImages.ready, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: Size and room

    override func layoutSubviews() {
        super.layoutSubviews()
        // `frame` of a transformed view is undefined, so size and centre are set; the scroll position is kept,
        // and a list left at its newest message is put back there (the keyboard came or went).
        let middle = CGPoint(x: bounds.midX, y: bounds.midY)
        if table.bounds.size != bounds.size || table.center != middle {
            let atEnd = pinned
            let offset = table.contentOffset
            table.bounds = CGRect(origin: offset, size: bounds.size)
            table.center = middle
            if atEnd { table.contentOffset = CGPoint(x: 0, y: -table.contentInset.top) }
        }
        if bounds.width > 0, bounds.width != knownWidth {
            knownWidth = bounds.width
            onWidth(bounds.width)
        }
        toEnd.frame = CGRect(x: bounds.width - 14 - 38, y: bounds.height - padInsets.top - 38 - 6, width: 38, height: 38)
    }

    /// `top` is the room under the header, `bottom` the room above the composer. The table is upside down, so they swap.
    func setPad(top: CGFloat, bottom: CGFloat) {
        let insets = UIEdgeInsets(top: bottom, left: 0, bottom: top, right: 0)
        if insets == padInsets { return }
        padInsets = insets
        let atEnd = pinned
        table.contentInset = insets
        if atEnd { table.contentOffset = CGPoint(x: 0, y: -insets.top) }
        setNeedsLayout()
    }

    // MARK: Changes

    private func position(_ id: Int) -> Int? {
        return items.firstIndex { $0.row.id == id }
    }

    /// The row begins before what is on the screen (lower on the screen than its bottom edge, or under it).
    private func beforeScreen(_ index: Int) -> Bool {
        return table.rectForRow(at: IndexPath(row: index, section: 0)).minY < table.contentOffset.y + table.contentInset.top
    }

    /// Keeps what the person is reading where it is, after the content before it grew or shrank.
    private func shift(_ delta: CGFloat) {
        if delta == 0 { return }
        table.layoutIfNeeded()
        table.contentOffset = CGPoint(x: 0, y: table.contentOffset.y + delta)
    }

    /// Puts a finished change into the table. Main queue.
    func apply(_ patch: ChannelPatch) {
        if let all = patch.reset {
            items = Array(all.reversed())
            askedAt = 0
            table.reloadData()
            if pinned {
                table.layoutIfNeeded()
                table.contentOffset = CGPoint(x: 0, y: -table.contentInset.top)
            }
            return
        }
        UIView.performWithoutAnimation {
            for id in patch.removed {
                guard let index = position(id) else { continue }
                let move = !pinned && beforeScreen(index)
                let tall = items[index].height
                items.remove(at: index)
                table.deleteRows(at: [IndexPath(row: index, section: 0)], with: .none)
                if move { shift(-tall) }
            }
            for layout in patch.updated {
                guard let index = position(layout.row.id) else { continue }
                let old = items[index]
                if old.height == layout.height {
                    // The same room: only the row itself is drawn again.
                    items[index] = layout
                    if let cell = table.cellForRow(at: IndexPath(row: index, section: 0)) as? ChannelRowCell { cell.show(layout) }
                } else {
                    let move = !pinned && beforeScreen(index)
                    items[index] = layout
                    table.reloadRows(at: [IndexPath(row: index, section: 0)], with: .none)
                    if move { shift(layout.height - old.height) }
                }
            }
            if !patch.older.isEmpty {
                // The far end of an upside-down table: what is on the screen does not move.
                let start = items.count
                items.append(contentsOf: patch.older.reversed())
                table.insertRows(at: (start..<items.count).map { IndexPath(row: $0, section: 0) }, with: .none)
            }
            for layout in patch.newest {
                items.insert(layout, at: 0)
                table.insertRows(at: [IndexPath(row: 0, section: 0)], with: .none)
                // Reading older messages: the new one arrives below without pushing them.
                if !pinned { shift(layout.height) }
            }
        }
        if patch.own && !patch.newest.isEmpty { goToEnd() }
    }

    /// Goes to the newest message (the person sent one, or asked to).
    func scrollToEnd() { goToEnd() }

    @objc private func goToEnd() {
        pinned = true
        table.layoutIfNeeded()
        table.setContentOffset(CGPoint(x: 0, y: -table.contentInset.top), animated: true)
        showToEnd(false)
    }

    private func showToEnd(_ shown: Bool) {
        let alpha: CGFloat = shown ? 1 : 0
        if toEnd.alpha == alpha { return }
        UIView.animate(withDuration: 0.15) { self.toEnd.alpha = alpha }
    }

    @objc private func pictureReady(_ note: Notification) {
        guard let id = note.object as? String else { return }
        for cell in table.visibleCells {
            guard let rowCell = cell as? ChannelRowCell, let layout = rowCell.canvas.layoutInfo, layout.pictures.contains(id) else { continue }
            rowCell.canvas.setNeedsDisplay()
        }
    }

    // MARK: The table

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView.isDragging || scrollView.isDecelerating else { return }
        pinned = scrollView.contentOffset.y <= -scrollView.contentInset.top + 24
        showToEnd(scrollView.contentOffset.y > -scrollView.contentInset.top + 400)
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { return items.count }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        return indexPath.row < items.count ? items[indexPath.row].height : 0
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        if let rowCell = cell as? ChannelRowCell, indexPath.row < items.count {
            rowCell.onProfile = { [weak self] (layout: ChannelRowLayout) -> Void in self?.onPress(layout, .author) }
            rowCell.show(items[indexPath.row])
        }
        return cell
    }

    func tableView(_ tableView: UITableView, willDisplay cell: UITableViewCell, forRowAt indexPath: IndexPath) {
        // Once per «oldest row»: asked again only after older rows have arrived.
        guard let oldest = items.last, indexPath.row >= items.count - 12, askedAt != oldest.row.id else { return }
        askedAt = oldest.row.id
        onNearTop()
    }

    /// The paging failed: the same oldest row may ask again.
    func forgetAsked() { askedAt = 0 }

    // MARK: Touches

    private func found(_ point: CGPoint) -> (layout: ChannelRowLayout, inside: CGPoint)? {
        guard let path = table.indexPathForRow(at: point), path.row < items.count, let cell = table.cellForRow(at: path) as? ChannelRowCell else { return nil }
        return (items[path.row], table.convert(point, to: cell.canvas))
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended, let hit = found(recognizer.location(in: table)) else { return }
        onPress(hit.layout, hit.layout.hit(hit.inside))
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, let hit = found(recognizer.location(in: table)) else { return }
        onLongPress(hit.layout, recognizer.location(in: nil).y)
    }
}
