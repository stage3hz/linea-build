import UIKit
import UniformTypeIdentifiers

/// A track's cover: the picture, or a note on a quiet square while there is none.
final class MusicCoverView: UIView {
    private let picture = UIImageView()
    private let note = UIImageView(image: UIImage(systemName: "music.note"))
    private var trackId = ""

    init(radius: CGFloat) {
        super.init(frame: .zero)
        backgroundColor = Theme.veil(0.07)
        layer.cornerRadius = radius
        clipsToBounds = true
        note.tintColor = Theme.muted
        note.contentMode = .center
        picture.contentMode = .scaleAspectFill
        [note, picture].forEach {
            $0.frame = bounds
            $0.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            addSubview($0)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: MusicCovers.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ track: MusicTrack?) {
        trackId = track?.id ?? ""
        picture.image = track.flatMap { MusicCovers.image($0) }
        isAccessibilityElement = false
    }

    private var shownTrack: MusicTrack?
    func bind(_ track: MusicTrack?) {
        shownTrack = track
        show(track)
    }

    @objc private func arrived(_ note: Notification) {
        guard let id = note.object as? String, id == trackId, let shownTrack else { return }
        picture.image = MusicCovers.image(shownTrack)
    }
}

/// The strip above the bar while a track is chosen: cover, title, the controls. A touch opens the player,
/// a swipe down stops the music and takes the strip away.
final class MiniPlayerView: UIView {
    var onOpen: (() -> Void)?
    private let cover = MusicCoverView(radius: 8)
    private let heading = UILabel()
    private let line = UILabel()
    private let back = UIButton(type: .system)
    private let toggle = UIButton(type: .system)
    private let forward = UIButton(type: .system)
    private let close = UIButton(type: .system)
    private let track = UIView()
    private let done = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Theme.panel(UIColor(red: 30 / 255, green: 31 / 255, blue: 33 / 255, alpha: 0.97))
        layer.cornerRadius = 24
        layer.borderWidth = 1
        layer.borderColor = Theme.veil(0.1).cgColor
        clipsToBounds = true
        heading.font = .systemFont(ofSize: 14, weight: .bold)
        heading.textColor = Theme.text
        line.font = .systemFont(ofSize: 12)
        let words = UIStackView(arrangedSubviews: [heading, line])
        words.axis = .vertical
        words.spacing = 4
        words.isUserInteractionEnabled = false
        func set(_ button: UIButton, _ symbol: String, _ label: String, _ action: Selector, tint: UIColor = Theme.text) {
            button.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)), for: .normal)
            button.tintColor = tint
            button.accessibilityLabel = label
            button.addTarget(self, action: action, for: .touchUpInside)
            button.widthAnchor.constraint(equalToConstant: 36).isActive = true
            button.heightAnchor.constraint(equalToConstant: 44).isActive = true
        }
        set(back, "backward.end.fill", "Предыдущий трек или начало текущего", #selector(goBack))
        set(toggle, "play.fill", "Слушать", #selector(flip))
        set(forward, "forward.end.fill", "Следующий трек", #selector(goForward))
        set(close, "xmark", "Закрыть плеер и остановить музыку", #selector(shut), tint: Theme.muted)
        let row = UIStackView(arrangedSubviews: [cover, words, back, toggle, forward, close])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 6
        row.setCustomSpacing(11, after: cover)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        track.backgroundColor = Theme.veil(0.1)
        done.backgroundColor = Theme.accent
        addSubview(track)
        track.addSubview(done)
        NSLayoutConstraint.activate([
            cover.widthAnchor.constraint(equalToConstant: 46), cover.heightAnchor.constraint(equalToConstant: 46),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 8), row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        let down = UISwipeGestureRecognizer(target: self, action: #selector(shut))
        down.direction = .down
        addGestureRecognizer(down)
        accessibilityHint = "Смахни вниз, чтобы остановить музыку и убрать плеер"
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: MusicPlayer.changed, object: nil)
        refresh()
    }

    required init?(coder: NSCoder) { return nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        track.frame = CGRect(x: 15, y: bounds.height - 2, width: max(0, bounds.width - 30), height: 2)
        let player = MusicPlayer.shared
        let part = player.duration > 0 ? min(1, player.position / player.duration) : 0
        done.frame = CGRect(x: 0, y: 0, width: track.bounds.width * CGFloat(part), height: 2)
    }

    @objc private func refresh() {
        let player = MusicPlayer.shared
        isHidden = player.current == nil
        guard let current = player.current else { return }
        cover.bind(current)
        heading.text = current.title
        line.text = !player.error.isEmpty ? "Есть сообщение · открыть" : (player.loading ? "Загружаем трек…" : current.artist)
        line.textColor = player.error.isEmpty ? Theme.muted : Theme.danger
        toggle.setImage(UIImage(systemName: player.playing ? "pause.fill" : "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)), for: .normal)
        toggle.accessibilityLabel = player.playing ? "Пауза" : "Слушать"
        forward.isEnabled = player.queue.count >= 2
        setNeedsLayout()
    }

    @objc private func tapped() { onOpen?() }
    @objc private func goBack() { MusicPlayer.shared.previous() }
    @objc private func goForward() { MusicPlayer.shared.next() }
    @objc private func flip() { MusicPlayer.shared.togglePlayback() }
    @objc private func shut() { MusicPlayer.shared.stop() }
}

/// One track of a list.
final class MusicTrackCell: UITableViewCell {
    private let cover = MusicCoverView(radius: 6)
    private let heading = UILabel()
    private let line = UILabel()
    private let heart = UIButton(type: .system)
    private let more = UIButton(type: .system)
    var onHeart: (() -> Void)?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectedBackgroundView = UIView()
        selectedBackgroundView?.backgroundColor = Theme.veil(0.06)
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        line.font = .systemFont(ofSize: 12)
        line.textColor = Theme.muted
        let words = UIStackView(arrangedSubviews: [heading, line])
        words.axis = .vertical
        words.spacing = 3
        heart.addTarget(self, action: #selector(liked), for: .touchUpInside)
        more.setImage(UIImage(systemName: "ellipsis"), for: .normal)
        more.tintColor = Theme.muted
        more.showsMenuAsPrimaryAction = true
        let row = UIStackView(arrangedSubviews: [cover, words, heart, more])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 4
        row.setCustomSpacing(12, after: cover)
        row.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(row)
        NSLayoutConstraint.activate([
            cover.widthAnchor.constraint(equalToConstant: 52), cover.heightAnchor.constraint(equalToConstant: 52),
            heart.widthAnchor.constraint(equalToConstant: 40), heart.heightAnchor.constraint(equalToConstant: 44),
            more.widthAnchor.constraint(equalToConstant: 36), more.heightAnchor.constraint(equalToConstant: 44),
            row.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 18), row.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -10),
            row.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 7), row.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -7),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ track: MusicTrack, current: Bool, favorite: Bool, menu: UIMenu) {
        cover.bind(track)
        heading.text = track.title
        heading.textColor = current ? Theme.onBlack(.white, otherwise: Theme.accent) : Theme.text
        let badge = track.source == "local" ? "НА УСТРОЙСТВЕ" : (track.source == "soundcloud" ? "SOUNDCLOUD" : "AUDIUS")
        var words = track.artist
        if track.duration > 0 { words += " · " + MusicCatalog.time(track.duration) }
        line.text = words + " · " + badge
        heart.setImage(UIImage(systemName: favorite ? "heart.fill" : "heart"), for: .normal)
        heart.tintColor = favorite ? Theme.text : Theme.muted
        heart.accessibilityLabel = favorite ? "Убрать из любимого: \(track.title)" : "В любимое: \(track.title)"
        more.accessibilityLabel = "Действия: \(track.title)"
        more.menu = menu
        accessibilityLabel = "Слушать: \(track.title), \(track.artist)"
    }

    @objc private func liked() { onHeart?() }
}

/// The «Музыка» section: the catalogue (SoundCloud through the person's server, or Audius), the favourites and
/// the person's own files; the strip of the playing track above the bar. After mobile/src/music/MusicScreen.tsx.
final class MusicViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextFieldDelegate, UIDocumentPickerDelegate {
    private let messenger: Messenger?
    private let player = MusicPlayer.shared
    private static let sourceKey = "linea.music-source.v1"
    private static var catalogCache: [String: (at: Date, tracks: [MusicTrack], nextOffset: Int?)] = [:]

    /// catalog · favorites · saved
    private var section = "catalog"
    private var query = ""
    private var mood: String?
    private var chosen = "soundcloud"
    private var scReady = false
    private var sourceNotice = ""
    private var tracks: [MusicTrack] = []
    private var nextOffset: Int?
    private var loading = false
    private var loadingMore = false
    private var failure = ""
    private var generation = 0
    private var typing: Timer?
    private var fixed = false

    private let table = UITableView(frame: .zero, style: .plain)
    private let header = UIView()
    private let column = UIStackView()
    private let addButton = UIButton(type: .system)
    private let tabs = UISegmentedControl(items: ["Главная", "Любимое", "Мои файлы"])
    private let search = UITextField()
    private let sources = UISegmentedControl(items: ["SoundCloud", "Audius"])
    private let moodScroll = UIScrollView()
    private let moodRow = UIStackView()
    private let mixRow = UIStackView()
    private let mixButton = UIButton(type: .system)
    private let mixLine = AIKit.label("", size: 14, color: Theme.muted, lines: 1)
    private let caption = AIKit.label("", size: 11, weight: .bold, color: Theme.muted, lines: 1)
    private let notices = UIStackView()
    private let footer = UIStackView()
    private let mini = MiniPlayerView()
    private var miniBottom: NSLayoutConstraint?
    /// «Любимое» and «Артисты» (Music/MusicShelves.swift), on «Главная» while nothing is searched.
    private let shelves = UIStackView()
    private var shelvesMark = ""
    /// The cold «эмбиент» behind the top of the page (Effects/MusicAmbient.swift); it runs under the status bar,
    /// scrolls away with the list and fades out by transparency.
    private let ambient = MusicAmbientView(tone: MusicAmbientView.themeTone, fade: true)

    init(messenger: Messenger?) {
        self.messenger = messenger
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    private var source: String { scReady && chosen == "soundcloud" ? "soundcloud" : "audius" }

    private var rows: [MusicTrack] {
        if section == "catalog" { return tracks }
        let list = section == "favorites" ? player.favorites : player.saved
        let needle = query.lowercased()
        return needle.isEmpty ? list : list.filter { ($0.title + " " + $0.artist).lowercased().contains(needle) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        build()
        NotificationCenter.default.addObserver(self, selector: #selector(playerChanged), name: MusicPlayer.changed, object: nil)
        #if targetEnvironment(simulator)
        if messenger == nil, UserDefaults.standard.string(forKey: "musicdemo") != nil {
            fixed = true
            tracks = MusicDemo.tracks
            player.simulatorShow(MusicDemo.tracks, current: MusicDemo.tracks[1], position: 74, favorites: [MusicDemo.tracks[0], MusicDemo.tracks[3]])
            refresh()
            return
        }
        #endif
        if let stored = UserDefaults.standard.string(forKey: MusicViewController.sourceKey), stored == "soundcloud" || stored == "audius" { chosen = stored }
        player.server = messenger?.server
        refresh()
        MusicCatalog.soundCloudAvailable(messenger?.server) { [weak self] available in
            guard let self else { return }
            self.scReady = available
            self.refresh()
            self.reloadCatalog()
        }
    }

    // MARK: The catalogue

    private func page(_ offset: Int, done: @escaping (Result<MusicPage, MusicFailure>) -> Void) {
        if source == "soundcloud" { MusicCatalog.searchSoundCloud(messenger?.server, query: query, mood: mood, offset: offset, limit: 24, done: done) }
        else { MusicCatalog.searchAudius(query: query, mood: mood, offset: offset, limit: 24, done: done) }
    }

    private func reloadCatalog() {
        if fixed { return }
        generation += 1
        let request = generation
        loadingMore = false
        guard section == "catalog" else {
            loading = false
            return refresh()
        }
        let key = source + "|" + query + "|" + (mood ?? "")
        failure = ""
        if let cached = MusicViewController.catalogCache[key], Date().timeIntervalSince(cached.at) < 600 {
            tracks = cached.tracks
            nextOffset = cached.nextOffset
            loading = false
            return refresh()
        }
        loading = true
        refresh()
        let asked = source
        page(0) { [weak self] result in
            guard let self, self.generation == request else { return }
            self.loading = false
            switch result {
            case .success(let found):
                MusicViewController.catalogCache[key] = (Date(), found.tracks, found.nextOffset)
                self.tracks = found.tracks
                self.nextOffset = found.nextOffset
            case .failure(let failure):
                // SoundCloud down or over its daily cap: Audius rather than an empty page.
                if asked == "soundcloud" {
                    self.sourceNotice = "SoundCloud сейчас недоступен" + (failure.words.isEmpty ? "" : ": \(failure.words)") + ". Показываю Audius."
                    self.chosen = "audius"
                    return self.reloadCatalog()
                }
                self.failure = failure.words.isEmpty ? "Не удалось найти музыку." : failure.words
            }
            self.refresh()
        }
    }

    @objc private func more() {
        guard let offset = nextOffset, !loading, !loadingMore else { return }
        loadingMore = true
        failure = ""
        refresh()
        let request = generation
        page(offset) { [weak self] result in
            guard let self, self.generation == request else { return }
            self.loadingMore = false
            switch result {
            case .success(let found):
                let known = Set(self.tracks.map { $0.id })
                self.tracks += found.tracks.filter { !known.contains($0.id) }
                self.nextOffset = found.nextOffset
            case .failure(let failure): self.failure = failure.words.isEmpty ? "Не удалось загрузить следующие треки." : failure.words
            }
            self.refresh()
        }
    }

    // MARK: Actions

    @objc private func tabChanged() {
        section = ["catalog", "favorites", "saved"][max(0, tabs.selectedSegmentIndex)]
        reloadCatalog()
        refresh()
    }

    @objc private func sourceChanged() {
        chosen = sources.selectedSegmentIndex == 0 ? "soundcloud" : "audius"
        sourceNotice = ""
        UserDefaults.standard.set(chosen, forKey: MusicViewController.sourceKey)
        reloadCatalog()
    }

    @objc private func typed() {
        typing?.invalidate()
        typing = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self] _ in
            guard let self else { return }
            let wanted = (self.search.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if wanted == self.query { return }
            self.query = wanted
            self.reloadCatalog()
            self.refresh()
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    private func pickMood(_ value: String?) {
        // A second tap on the chosen mood takes it off again.
        mood = value == mood ? nil : value
        reloadCatalog()
        refresh()
    }

    @objc private func mix() {
        if let first = rows.first { player.play(first, queue: rows) }
    }

    @objc private func addFiles() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.audio], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = true
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        player.importFiles(urls)
    }

    private func openLink(_ address: String?) {
        guard let address, let url = URL(string: address), url.scheme?.lowercased() == "https" else { return }
        UIApplication.shared.open(url, options: [:]) { [weak self] opened in
            if opened { return }
            let alert = UIAlertController(title: "Ссылка не открылась", message: "Попробуй ещё раз.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
            self?.present(alert, animated: true)
        }
    }

    private func menu(_ track: MusicTrack) -> UIMenu {
        var items: [UIMenuElement] = []
        items.append(UIAction(title: "Слушать", image: UIImage(systemName: "play.fill")) { [weak self] _ in
            guard let self else { return }
            self.player.play(track, queue: self.rows)
        })
        let favorite = player.isFavorite(track)
        items.append(UIAction(title: favorite ? "Убрать из любимого" : "В любимое", image: UIImage(systemName: favorite ? "heart.fill" : "heart")) { [weak self] _ in self?.player.toggleFavorite(track) })
        if track.sourceUrl != nil {
            items.append(UIAction(title: track.source == "soundcloud" ? "Открыть в SoundCloud" : "Открыть источник", image: UIImage(systemName: "arrow.up.right.square")) { [weak self] _ in self?.openLink(track.sourceUrl) })
        }
        if track.source == "audius", track.downloadable {
            items.append(UIAction(title: "Скачать через Audius", subtitle: "Откроется официальная загрузка трека", image: UIImage(systemName: "arrow.down.circle")) { [weak self] _ in
                MusicCatalog.resolveDownload(track) { result in
                    switch result {
                    case .failure(let failure): MusicPlayer.shared.report(failure.words)
                    case .success(let address):
                        self?.openLink(address)
                        MusicPlayer.shared.say("Скачивание открыто через Audius. Сохранённый файл можно добавить сюда через «Добавить файлы».")
                    }
                }
            })
        }
        if track.source == "local" {
            items.append(UIAction(title: "Поделиться файлом", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in
                guard let self, let file = self.player.fileURL(track), FileManager.default.fileExists(atPath: file.path) else { return MusicPlayer.shared.report("Сохранённый файл не найден.") }
                self.present(UIActivityViewController(activityItems: [file], applicationActivities: nil), animated: true)
            })
            items.append(UIAction(title: "Убрать из приложения", subtitle: "Исходный файл на устройстве сохранится", image: UIImage(systemName: "trash"), attributes: [.destructive]) { [weak self] _ in self?.player.removeSaved(track) })
        }
        return UIMenu(title: track.title, children: items)
    }

    @objc private func showInfo() {
        let sheet = AISheetController(heading: "О музыке")
        var texts = [
            "Здесь доступны публичные треки Audius, которые авторы открыли для сторонних плееров. Инвиз не добавляет рекламу. Доступность и качество записи определяет источник; это не полный каталог Яндекс Музыки или SoundCloud.",
            "Кнопка скачивания открывает официальный адрес Audius и появляется только при разрешении автора. Потоки не сохраняются в постоянный кэш приложения. Для личного офлайн-прослушивания можно добавить свои аудиофайлы через «+».",
            "При поиске и прослушивании Audius получает запросы и сетевые данные соединения. Токен мессенджера туда не отправляется. Импортированные файлы остаются на устройстве.",
            "Музыка принадлежит указанным авторам. Учитывай лицензию конкретного трека; для материалов Audius может применяться Open Music License или отдельная лицензия автора.",
        ]
        if scReady { texts.append("SoundCloud подключён через сервер Инвиза по официальному API: в нём видны только треки, которые SoundCloud разрешает слушать в сторонних приложениях. Подписка SoundCloud Go здесь не действует, скачивания и офлайна нет. Треки SoundCloud и Audius играют отдельными очередями.") }
        texts.forEach { sheet.stack.addArrangedSubview(AIKit.label($0, size: 13, color: Theme.muted)) }
        var links: [(String, String)] = [("Условия Audius API", "https://audius.co/documents/ApiTerms.pdf"), ("Конфиденциальность Audius", "https://audius.co/documents/PrivacyPolicy.pdf"), ("Open Music License", "https://audius.org/open-music-license.pdf")]
        if scReady { links.insert(("Правила SoundCloud API", "https://developers.soundcloud.com/policies"), at: 0) }
        for link in links {
            let button = AIKit.wide(link.0, symbol: "doc.text", secondary: true)
            button.addAction(UIAction { [weak self] _ in self?.openLink(link.1) }, for: .touchUpInside)
            sheet.stack.addArrangedSubview(button)
        }
        present(sheet, animated: true)
    }

    private func openPlayer() {
        guard presentedViewController == nil else { return }
        present(PlayerViewController(), animated: true)
    }

    // MARK: The page

    private func build() {
        view.addSubview(ambient)
        table.translatesAutoresizingMaskIntoConstraints = false
        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.dataSource = self
        table.delegate = self
        table.rowHeight = 66
        table.keyboardDismissMode = .onDrag
        table.register(MusicTrackCell.self, forCellReuseIdentifier: "track")
        view.addSubview(table)
        mini.translatesAutoresizingMaskIntoConstraints = false
        mini.onOpen = { [weak self] in self?.openPlayer() }
        view.addSubview(mini)
        let bottom = mini.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -90)
        miniBottom = bottom
        NSLayoutConstraint.activate([
            table.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor), table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            mini.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12), mini.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            mini.heightAnchor.constraint(equalToConstant: 64), bottom,
        ])

        column.axis = .vertical
        column.spacing = 14
        column.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(column)
        let edge = column.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -10)
        edge.priority = UILayoutPriority(999)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: header.topAnchor, constant: 8), edge,
            column.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 18), column.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -18),
        ])

        let titleRow = UIStackView()
        titleRow.axis = .horizontal
        titleRow.alignment = .center
        titleRow.spacing = 6
        let info = UIButton(type: .system)
        info.setImage(UIImage(systemName: "info.circle"), for: .normal)
        info.tintColor = Theme.text
        info.accessibilityLabel = "О музыкальном разделе"
        info.addTarget(self, action: #selector(showInfo), for: .touchUpInside)
        addButton.setImage(UIImage(systemName: "plus"), for: .normal)
        addButton.tintColor = Theme.text
        addButton.accessibilityLabel = "Добавить аудиофайлы"
        addButton.addTarget(self, action: #selector(addFiles), for: .touchUpInside)
        [addButton, info].forEach {
            $0.widthAnchor.constraint(equalToConstant: 40).isActive = true
            $0.heightAnchor.constraint(equalToConstant: 40).isActive = true
        }
        // TITLE: Unbounded 26, line 32, as the reference's section titles.
        let heading = UILabel()
        heading.attributedText = Theme.titleWords("Музыка", size: Theme.TypeSize.sectionTitle, color: Theme.text, lineHeight: Theme.TypeSize.sectionTitleLine)
        heading.accessibilityTraits = .header
        [heading, addButton, info].forEach { titleRow.addArrangedSubview($0) }
        column.addArrangedSubview(titleRow)

        tabs.selectedSegmentIndex = 0
        tabs.addTarget(self, action: #selector(tabChanged), for: .valueChanged)
        column.addArrangedSubview(tabs)

        search.backgroundColor = Theme.veil(0.08)
        search.layer.cornerRadius = 14
        search.textColor = Theme.text
        search.tintColor = Theme.accent
        search.font = .systemFont(ofSize: 16)
        search.keyboardAppearance = Theme.dark ? .dark : .light
        search.returnKeyType = .search
        search.autocorrectionType = .no
        search.clearButtonMode = .whileEditing
        search.delegate = self
        search.accessibilityLabel = "Поиск музыки"
        let glass = UIImageView(image: UIImage(systemName: "magnifyingglass"))
        glass.tintColor = Theme.muted
        glass.contentMode = .center
        glass.frame = CGRect(x: 0, y: 0, width: 40, height: 44)
        search.leftView = glass
        search.leftViewMode = .always
        search.heightAnchor.constraint(equalToConstant: 46).isActive = true
        search.addTarget(self, action: #selector(typed), for: .editingChanged)
        column.addArrangedSubview(search)
        shelves.axis = .vertical
        shelves.spacing = 16
        column.addArrangedSubview(shelves)

        sources.accessibilityLabel = "Источник музыки"
        sources.addTarget(self, action: #selector(sourceChanged), for: .valueChanged)
        column.addArrangedSubview(sources)

        moodScroll.showsHorizontalScrollIndicator = false
        moodScroll.heightAnchor.constraint(equalToConstant: 38).isActive = true
        moodRow.axis = .horizontal
        moodRow.spacing = 8
        moodRow.translatesAutoresizingMaskIntoConstraints = false
        moodScroll.addSubview(moodRow)
        NSLayoutConstraint.activate([
            moodRow.topAnchor.constraint(equalTo: moodScroll.contentLayoutGuide.topAnchor), moodRow.bottomAnchor.constraint(equalTo: moodScroll.contentLayoutGuide.bottomAnchor),
            moodRow.leadingAnchor.constraint(equalTo: moodScroll.contentLayoutGuide.leadingAnchor), moodRow.trailingAnchor.constraint(equalTo: moodScroll.contentLayoutGuide.trailingAnchor),
            moodRow.heightAnchor.constraint(equalTo: moodScroll.frameLayoutGuide.heightAnchor),
        ])
        column.addArrangedSubview(moodScroll)

        mixRow.axis = .horizontal
        mixRow.alignment = .center
        mixRow.spacing = 16
        mixButton.setImage(UIImage(systemName: "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 24, weight: .bold)), for: .normal)
        mixButton.tintColor = Theme.onAccent
        mixButton.backgroundColor = Theme.onBlack(.white, otherwise: Theme.accent)
        mixButton.layer.cornerRadius = 33
        mixButton.accessibilityLabel = "Слушать микс"
        mixButton.widthAnchor.constraint(equalToConstant: 66).isActive = true
        mixButton.heightAnchor.constraint(equalToConstant: 66).isActive = true
        mixButton.addTarget(self, action: #selector(mix), for: .touchUpInside)
        let mixWords = UIStackView(arrangedSubviews: [AIKit.label("Слушать микс", size: 21, weight: .bold, lines: 1), mixLine])
        mixWords.axis = .vertical
        mixWords.spacing = 4
        [mixButton, mixWords].forEach { mixRow.addArrangedSubview($0) }
        column.addArrangedSubview(mixRow)

        notices.axis = .vertical
        notices.spacing = 8
        column.addArrangedSubview(notices)
        column.addArrangedSubview(caption)

        footer.axis = .vertical
        footer.spacing = 10
        footer.alignment = .center
        footer.isLayoutMarginsRelativeArrangement = true
        footer.layoutMargins = UIEdgeInsets(top: 16, left: 24, bottom: 16, right: 24)
        table.tableHeaderView = header
        table.tableFooterView = footer
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let clearance = BarMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom) + BarMetrics.height + 8
        miniBottom?.constant = -clearance
        let inset = clearance + (mini.isHidden ? 0 : 72)
        if table.contentInset.bottom != inset {
            table.contentInset.bottom = inset
            table.verticalScrollIndicatorInsets.bottom = inset
        }
        fit(header)
        fit(footer)
        placeAmbient()
    }

    /// The ambient's height: most of the top half on «Главная» without a search, a strip otherwise.
    private func placeAmbient() {
        let top = view.safeAreaInsets.top
        let tall = (section == "catalog" && query.isEmpty ? min(430, view.bounds.height * 0.5) : 132) + top
        let scrolled = table.contentOffset.y + table.adjustedContentInset.top
        ambient.frame = CGRect(x: 0, y: -scrolled, width: view.bounds.width, height: tall)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if scrollView === table { placeAmbient() }
    }

    /// The shelves, built again only when what they show changed.
    private func refreshShelves(_ list: [MusicTrack]) {
        let open = section == "catalog" && query.isEmpty
        let favorites = open ? Array(player.favorites.prefix(12)) : []
        let artists = open ? MusicShelves.artists(list) : []
        let mark = favorites.map { $0.id }.joined(separator: ",") + "|" + (artists.count > 1 ? artists.map { $0.id }.joined(separator: ",") : "")
        guard mark != shelvesMark else { return }
        shelvesMark = mark
        shelves.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if !favorites.isEmpty {
            let all = player.favorites
            let cards = favorites.map { (track: MusicTrack) -> UIView in
                MusicShelves.coverCard(track) { MusicPlayer.shared.play(track, queue: all) }
            }
            shelves.addArrangedSubview(MusicShelves.shelf("Любимое", cards: cards, edge: 18))
        }
        if artists.count > 1 {
            let cards = artists.map { (track: MusicTrack) -> UIView in
                MusicShelves.artistCircle(track) { [weak self] in self?.searchArtist(track.artist) }
            }
            shelves.addArrangedSubview(MusicShelves.shelf("Артисты", cards: cards, edge: 18))
        }
        shelves.isHidden = shelves.arrangedSubviews.isEmpty
    }

    private func searchArtist(_ name: String) {
        search.text = name
        typing?.invalidate()
        query = name
        reloadCatalog()
        refresh()
    }

    /// A table's header and footer do not size themselves: their height is measured for the table's width.
    private func fit(_ block: UIView) {
        let width = table.bounds.width
        guard width > 0 else { return }
        let height = block.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height
        if abs(block.frame.height - height) > 0.5 || abs(block.frame.width - width) > 0.5 {
            block.frame = CGRect(x: 0, y: 0, width: width, height: height)
            if block === header { table.tableHeaderView = header } else { table.tableFooterView = footer }
        }
    }

    @objc private func playerChanged() {
        // The position changes several times a second: the page is redrawn only when what it shows has changed.
        let mark = (player.current?.id ?? "") + "|" + player.error + "|" + player.notice + "|\(player.favorites.count)|\(player.saved.count)|\(player.playing)"
        if mark == lastMark { return }
        lastMark = mark
        refresh()
    }
    private var lastMark = ""

    private func noticeBox(_ text: String, error: Bool, close: (() -> Void)?) -> UIView {
        let box = UIView()
        box.backgroundColor = Theme.veil(0.06)
        box.layer.cornerRadius = 14
        let label = AIKit.label(text, size: 13, color: error ? Theme.danger : Theme.text)
        let shut = UIButton(type: .system)
        shut.setImage(UIImage(systemName: "xmark"), for: .normal)
        shut.tintColor = Theme.muted
        shut.accessibilityLabel = "Закрыть сообщение"
        shut.isHidden = close == nil
        shut.widthAnchor.constraint(equalToConstant: 30).isActive = true
        shut.addAction(UIAction { _ in close?() }, for: .touchUpInside)
        let row = UIStackView(arrangedSubviews: [label, shut])
        row.axis = .horizontal
        row.alignment = .top
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: box.topAnchor, constant: 12), row.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -12),
            row.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14), row.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -8),
        ])
        return box
    }

    private func refresh() {
        guard isViewLoaded else { return }
        let catalog = section == "catalog"
        addButton.isHidden = section != "saved"
        search.attributedPlaceholder = NSAttributedString(string: section == "saved" ? "Поиск в моих файлах" : "Трек или исполнитель", attributes: [.foregroundColor: Theme.muted])
        sources.isHidden = !(catalog && scReady)
        sources.selectedSegmentIndex = source == "soundcloud" ? 0 : 1
        moodScroll.isHidden = !catalog
        moodRow.arrangedSubviews.forEach { $0.removeFromSuperview() }
        var chips: [(String?, String, String)] = [(nil, "Любое", "sparkles")]
        chips += MusicCatalog.moods.dropFirst().map { ($0.apiMood, $0.label, $0.symbol) }
        for chip in chips {
            var config = UIButton.Configuration.filled()
            config.title = chip.1
            config.image = UIImage(systemName: chip.2, withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium))
            config.imagePadding = 6
            config.cornerStyle = .capsule
            let selected = chip.0 == mood
            config.baseBackgroundColor = selected ? Theme.text : Theme.veil(0.08)
            config.baseForegroundColor = selected ? Theme.onAccent : Theme.text
            config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12)
            let button = UIButton(configuration: config)
            let value = chip.0
            button.addAction(UIAction { [weak self] _ in self?.pickMood(value) }, for: .touchUpInside)
            moodRow.addArrangedSubview(button)
        }
        let list = rows
        refreshShelves(list)
        mixRow.isHidden = !(catalog && query.isEmpty)
        mixButton.isEnabled = !list.isEmpty
        mixButton.alpha = list.isEmpty ? 0.5 : 1
        var moodWords = "Новые имена и любимый звук"
        if let mood { moodWords = "Настроение: " + (MusicCatalog.moods.first { $0.apiMood == mood }?.label ?? "") }
        mixLine.text = moodWords
        caption.isHidden = !catalog
        caption.text = query.isEmpty ? "ОТКРОЙ ДЛЯ СЕБЯ" : "РЕЗУЛЬТАТЫ"

        notices.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if !player.error.isEmpty { notices.addArrangedSubview(noticeBox(player.error, error: true) { MusicPlayer.shared.clearError() }) }
        if !player.notice.isEmpty { notices.addArrangedSubview(noticeBox(player.notice, error: false) { MusicPlayer.shared.clearNotice() }) }
        if !sourceNotice.isEmpty, catalog { notices.addArrangedSubview(noticeBox(sourceNotice, error: false, close: nil)) }
        if !failure.isEmpty, catalog { notices.addArrangedSubview(noticeBox(failure, error: true, close: nil)) }
        notices.isHidden = notices.arrangedSubviews.isEmpty

        footer.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if catalog && loading && list.isEmpty {
            let spin = UIActivityIndicatorView(style: .medium)
            spin.color = Theme.accent
            spin.startAnimating()
            footer.addArrangedSubview(spin)
            footer.addArrangedSubview(AIKit.label("Ищем музыку…", size: 13, color: Theme.muted))
        } else if list.isEmpty && failure.isEmpty {
            let service = source == "soundcloud" ? "SoundCloud" : "Audius"
            let title = section == "saved" ? "Свой звук" : (section == "favorites" ? "Любимое будет здесь" : (nextOffset != nil ? "Посмотрим следующую страницу" : "Попробуем другой запрос"))
            let words = section == "saved" ? "Добавь аудиофайлы с устройства. Они останутся здесь и не загрузятся на сервер мессенджера."
                : (section == "favorites" ? "Нажми на сердечко рядом с понравившимся треком."
                : (nextOffset != nil ? "На этой странице нет треков с выбранным доступом. Нажми «Показать ещё» или измени фильтры." : "Измени название или настроение. Каталог \(service) отличается от других музыкальных сервисов."))
            footer.addArrangedSubview(AIKit.label(title, size: 18, weight: .bold, align: .center))
            footer.addArrangedSubview(AIKit.label(words, size: 13, color: Theme.muted, align: .center))
            if section == "saved" {
                let add = AIKit.wide("Добавить файлы", symbol: "plus")
                add.addTarget(self, action: #selector(addFiles), for: .touchUpInside)
                footer.addArrangedSubview(add)
            }
        }
        if catalog, nextOffset != nil, !loading {
            let button = AIKit.wide("Показать ещё", secondary: true)
            button.isEnabled = !loadingMore
            button.addTarget(self, action: #selector(more), for: .touchUpInside)
            footer.addArrangedSubview(button)
        }
        if catalog, !list.isEmpty || !loading {
            footer.addArrangedSubview(AIKit.label(source == "soundcloud" ? "Треки и авторы — SoundCloud. Нажми «⋯», чтобы открыть трек на soundcloud.com." : "Музыка предоставлена авторами через Audius.", size: 11, color: Theme.subtle, align: .center))
        }
        table.reloadData()
        view.setNeedsLayout()
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "track", for: indexPath)
        let list = rows
        guard let row = cell as? MusicTrackCell, indexPath.row < list.count else { return cell }
        let track = list[indexPath.row]
        row.show(track, current: player.current?.id == track.id, favorite: player.isFavorite(track), menu: menu(track))
        row.onHeart = { [weak self] in self?.player.toggleFavorite(track) }
        return row
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let list = rows
        guard indexPath.row < list.count else { return }
        player.play(list[indexPath.row], queue: list)
    }

    #if targetEnvironment(simulator)
    /// `-musicdemo player`: the full player over the sample list.
    func simulatorPlayer() { openPlayer() }

    /// `-musicdemo equalizer`: the equalizer over the full player.
    func simulatorEqualizer() {
        openPlayer()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let shown = self?.presentedViewController else { return }
            var profile = EqualizerSettings.Profile()
            profile.mode = "custom"
            profile.low = 4
            profile.mid = -2
            profile.high = 6
            EqualizerSettings.profile = profile
            shown.present(EqualizerViewController(), animated: false)
        }
    }
    #endif
}
