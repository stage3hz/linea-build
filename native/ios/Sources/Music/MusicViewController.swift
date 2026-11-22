import UIKit
import UniformTypeIdentifiers

/// A track's cover: the picture, or — while there is none — the reference's fallback.
/// `.list` (MusicScreen.tsx `TrackArtwork`): the accent gradient with `musical-note` (25) in the on-accent colour.
/// `.artwork` (PlayerControls.tsx `TrackArtwork`): radius max(12, min(36, size × 0.23)), the soft accent under a
/// hairline, a three-colour gradient, a light ring and `musical-note(s)` (max(22, size × 0.31)).
final class MusicCoverView: UIView {
    enum Look { case list, artwork }
    private let picture = UIImageView()
    private let gradient = CAGradientLayer()
    private let ring = CALayer()
    private let note = UIImageView()
    private var trackId = ""
    private let look: Look
    private let fixedRadius: CGFloat
    private var source = ""

    init(radius: CGFloat, look: Look = .list) {
        self.look = look
        fixedRadius = radius
        super.init(frame: .zero)
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        layer.addSublayer(gradient)
        ring.borderWidth = 1
        layer.addSublayer(ring)
        note.contentMode = .center
        addSubview(note)
        picture.contentMode = .scaleAspectFill
        addSubview(picture)
        paint()
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: MusicCovers.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    private func paint() {
        switch look {
        case .list:
            backgroundColor = Theme.surface2
            let colors = ThemeStore.look.accentGradient
            gradient.colors = (colors.isEmpty ? [Theme.accent, Theme.accent] : colors).map { $0.cgColor }
            gradient.startPoint = CGPoint(x: 0.5, y: 0)
            gradient.endPoint = CGPoint(x: 0.5, y: 1)
            ring.isHidden = true
            note.tintColor = Theme.onAccent
            layer.borderWidth = 0
        case .artwork:
            backgroundColor = ThemeStore.look.accentSoft
            gradient.colors = (Theme.dark ? [0x253E70, 0x38334F, 0x172844] : [0xCDDEFF, 0xE1DCF6, 0xAECBF3]).map { UIColor(hex: UInt32($0)).cgColor }
            gradient.startPoint = CGPoint(x: 0, y: 0)
            gradient.endPoint = CGPoint(x: 1, y: 1)
            ring.isHidden = false
            ring.borderColor = ThemeStore.look.glassHighlight.cgColor
            note.tintColor = Theme.dark ? UIColor(hex: 0xC5D9FF) : UIColor(hex: 0x4569A5)
            layer.borderWidth = 1
            layer.borderColor = ThemeStore.look.glassBorder.cgColor
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = bounds.width
        if look == .artwork { layer.cornerRadius = max(12, min(36, size * 0.23)) } else { layer.cornerRadius = fixedRadius }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.frame = bounds
        // The ring: 0.95 of the size, moved 0.24 right and 0.22 down.
        ring.frame = CGRect(x: (size - size * 0.95) / 2 + size * 0.24, y: (bounds.height - size * 0.95) / 2 + size * 0.22, width: size * 0.95, height: size * 0.95)
        ring.cornerRadius = size * 0.95 / 2
        CATransaction.commit()
        note.frame = bounds
        picture.frame = bounds
        let glyph = look == .list ? "musical-note" : (source == "local" ? "musical-note" : "musical-notes")
        note.image = IonIcon.image(glyph, size: look == .list ? 25 : max(22, size * 0.31))
    }

    func show(_ track: MusicTrack?) {
        trackId = track?.id ?? ""
        source = track?.source ?? ""
        picture.image = track.flatMap { MusicCovers.image($0) }
        let bare = picture.image == nil
        gradient.isHidden = !bare
        ring.isHidden = !bare || look == .list
        note.isHidden = !bare
        isAccessibilityElement = false
        setNeedsLayout()
    }

    private var shownTrack: MusicTrack?
    func bind(_ track: MusicTrack?) {
        shownTrack = track
        show(track)
    }

    @objc private func arrived(_ note: Notification) {
        guard let id = note.object as? String, id == trackId, let shownTrack else { return }
        show(shownTrack)
    }
}

/// The strip above the bar while a track is chosen: cover, title, the controls. A touch opens the player,
/// a swipe down stops the music and takes the strip away.
final class MiniPlayerView: UIView {
    var onOpen: (() -> Void)?
    private let cover = MusicCoverView(radius: 12, look: .artwork)
    private let heading = UILabel()
    private let line = UILabel()
    private let back = UIButton(type: .custom)
    private let toggle = UIButton(type: .custom)
    /// `PlaybackButton`: a 46 round of the accent gradient under the play / pause (23, on-accent).
    private let toggleFill = CAGradientLayer()
    private let forward = UIButton(type: .custom)
    private let close = UIButton(type: .custom)
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
        // MiniPlayer (PlayerControls.tsx): the skips (20) on clear glass 36 × 44, the play disc 46, the close (20) 34 × 44.
        func set(_ button: UIButton, _ symbol: String, _ label: String, _ action: Selector, tint: UIColor = Theme.text, wide: CGFloat = 36, high: CGFloat = 44, size: CGFloat = 20, glass: Bool = true) {
            button.setImage(IonIcon.image(symbol, size: size), for: .normal)
            button.tintColor = tint
            button.accessibilityLabel = label
            button.addTarget(self, action: action, for: .touchUpInside)
            button.frame = CGRect(x: 0, y: 0, width: wide, height: high)
            if glass { GlassBacking.put(under: button) }
            button.widthAnchor.constraint(equalToConstant: wide).isActive = true
            button.heightAnchor.constraint(equalToConstant: high).isActive = true
        }
        set(back, "play-skip-back", "Предыдущий трек или начало текущего", #selector(goBack))
        set(toggle, "play", "Слушать", #selector(flip), tint: Theme.onAccent, wide: 46, high: 46, size: 23, glass: false)
        set(forward, "play-skip-forward", "Следующий трек", #selector(goForward))
        set(close, "close", "Закрыть плеер и остановить музыку", #selector(shut), tint: Theme.muted, wide: 34)
        let fill = ThemeStore.look.accentGradient
        toggleFill.colors = (fill.isEmpty ? [Theme.accent, Theme.accent] : fill).map { $0.cgColor }
        toggleFill.startPoint = CGPoint(x: 0, y: 0)
        toggleFill.endPoint = CGPoint(x: 1, y: 1)
        toggleFill.frame = CGRect(x: 0, y: 0, width: 46, height: 46)
        toggleFill.cornerRadius = 23
        toggle.layer.insertSublayer(toggleFill, at: 0)
        Bouncy.attach(toggle, scale: 0.95)
        let row = UIStackView(arrangedSubviews: [cover, words, back, toggle, forward, close])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 9
        row.setCustomSpacing(11, after: cover)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        track.backgroundColor = ThemeStore.look.border
        done.backgroundColor = Theme.accent
        addSubview(track)
        track.addSubview(done)
        NSLayoutConstraint.activate([
            cover.widthAnchor.constraint(equalToConstant: 46), cover.heightAnchor.constraint(equalToConstant: 46),
            // padding 9, 12 under (the progress line lies there).
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9), row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 9), row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
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
        toggle.setImage(IonIcon.image(player.playing ? "pause" : "play", size: 23), for: .normal)
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

/// One track of a list (MusicScreen.tsx `TrackRow`): the cover (52, radius 6), the title (15, semibold; the playing
/// one in the accent after `stats-chart` / `pause` 12), the artist (12), the source and length (9, semibold, +0.2),
/// then «в любимое» and «действия» (`IconButton`, 19). Rows 9 above and below, 4 apart.
final class MusicTrackCell: UITableViewCell {
    private let cover = MusicCoverView(radius: 6)
    private let mark = UIImageView()
    private let heading = UILabel()
    private let line = UILabel()
    private let badge = UILabel()
    private let heart = UIButton(type: .custom)
    private let more = UIButton(type: .custom)
    var onHeart: (() -> Void)?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        line.font = .systemFont(ofSize: 12)
        line.textColor = Theme.muted
        mark.contentMode = .center
        mark.tintColor = Theme.accent
        mark.widthAnchor.constraint(equalToConstant: 12).isActive = true
        let top = UIStackView(arrangedSubviews: [mark, heading])
        top.axis = .horizontal
        top.alignment = .center
        top.spacing = 5
        let words = UIStackView(arrangedSubviews: [top, line, badge])
        words.axis = .vertical
        words.spacing = 5
        heart.addTarget(self, action: #selector(liked), for: .touchUpInside)
        for button in [heart, more] {
            button.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
            GlassBacking.put(under: button)
        }
        more.setImage(IonIcon.image("ellipsis-horizontal", size: 19), for: .normal)
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
            heart.widthAnchor.constraint(equalToConstant: 44), heart.heightAnchor.constraint(equalToConstant: 44),
            more.widthAnchor.constraint(equalToConstant: 44), more.heightAnchor.constraint(equalToConstant: 44),
            // marginHorizontal −7 with paddingHorizontal 7: the cover and the buttons on the page's 18 pt edge.
            row.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 18), row.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -18),
            row.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 9), row.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -13),
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 55),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    func show(_ track: MusicTrack, current: Bool, favorite: Bool, menu: UIMenu, playing: Bool = true) {
        cover.bind(track)
        heading.text = track.title
        heading.textColor = current ? Theme.accent : Theme.text
        mark.isHidden = !current
        mark.image = IonIcon.image(playing ? "stats-chart" : "pause", size: 12)
        line.text = track.artist
        var source = track.source == "local" ? "НА УСТРОЙСТВЕ" : (track.source == "soundcloud" ? "SOUNDCLOUD" : "AUDIUS")
        if track.duration > 0 { source += " · " + MusicCatalog.time(track.duration) }
        badge.attributedText = NSAttributedString(string: source, attributes: [.font: UIFont.systemFont(ofSize: 9, weight: .semibold), .kern: 0.2, .foregroundColor: Theme.subtle])
        heart.setImage(IonIcon.image(favorite ? "heart" : "heart-outline", size: 19), for: .normal)
        heart.tintColor = favorite ? Theme.accent : Theme.muted
        heart.accessibilityLabel = favorite ? "Убрать из любимого: \(track.title)" : "В любимое: \(track.title)"
        more.accessibilityLabel = "Действия: \(track.title)"
        more.menu = menu
        accessibilityLabel = "\(current && playing ? "Пауза" : "Слушать"): \(track.title), \(track.artist)"
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
    // F: the reference's top (MusicScreen.tsx): on the cold ambient, «Музыка» with round glass «+» and «i», the tabs as
    // a plain row with an `ink` pill on the chosen one, the source switch, and the large centred «Слушать микс»; it
    // is `headHeight` tall from the screen's top (most of the top half on «Главная» without a search, 132 otherwise).
    // Then the search on glass, the shelves, the moods (tall chips), «ОТКРОЙ ДЛЯ СЕБЯ».
    private let headBox = UIView()
    private let headStack = UIStackView()
    private var headHeight: NSLayoutConstraint?
    private let addButton = GlassRoundButton(symbol: "ion:add", label: "Добавить аудиофайлы", iconSize: 23)
    private let tabRow = UIStackView()
    private var tabButtons: [UIButton] = []
    private let sourceBox = UIView()
    private var sourceButtons: [UIButton] = []
    private let searchPill = GlassPill(interactive: false)
    private let search = UITextField()
    private let moodScroll = UIScrollView()
    private let moodRow = UIStackView()
    private let mixRow = UIStackView()
    private let mixButton = UIButton(type: .custom)
    private let mixLine = AIKit.label("", size: 14, color: Theme.muted, lines: 1)
    private let sectionWords = AIKit.label("", size: 12, color: Theme.muted)
    /// The reference's `ink` (titles and the chosen tab on the ambient), `inkInverse` (the chosen tab's words) and `soft`.
    private var ink: UIColor { Theme.dark ? .white : UIColor(hex: 0x14243D) }
    private var inkInverse: UIColor { Theme.dark ? UIColor(hex: 0x0A1529) : .white }
    private var soft: UIColor { Theme.dark ? UIColor(hex: 0xD2DEF2) : UIColor(hex: 0x4A5D7D) }
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

    @objc private func tabChanged(_ sender: UIButton) {
        let picked = ["catalog", "favorites", "saved"][max(0, min(2, sender.tag))]
        if picked == section { return }
        section = picked
        reloadCatalog()
        refresh()
    }

    @objc private func sourceChanged(_ sender: UIButton) {
        let picked = sender.tag == 0 ? "soundcloud" : "audius"
        if picked == source { return }
        chosen = picked
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
        items.append(UIAction(title: "Слушать", image: IonIcon.image("play", size: 20)) { [weak self] _ in
            guard let self else { return }
            self.player.play(track, queue: self.rows)
        })
        let favorite = player.isFavorite(track)
        items.append(UIAction(title: favorite ? "Убрать из любимого" : "В любимое", image: IonIcon.image(favorite ? "heart" : "heart-outline", size: 20)) { [weak self] _ in self?.player.toggleFavorite(track) })
        if track.sourceUrl != nil {
            items.append(UIAction(title: track.source == "soundcloud" ? "Открыть в SoundCloud" : "Открыть источник", image: IonIcon.image("open-outline", size: 20)) { [weak self] _ in self?.openLink(track.sourceUrl) })
        }
        if track.source == "audius", track.downloadable {
            items.append(UIAction(title: "Скачать через Audius", subtitle: "Откроется официальная загрузка трека", image: IonIcon.image("download-outline", size: 20)) { [weak self] _ in
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
            items.append(UIAction(title: "Поделиться файлом", image: IonIcon.image("share-outline", size: 20)) { [weak self] _ in
                guard let self, let file = self.player.fileURL(track), FileManager.default.fileExists(atPath: file.path) else { return MusicPlayer.shared.report("Сохранённый файл не найден.") }
                self.present(UIActivityViewController(activityItems: [file], applicationActivities: nil), animated: true)
            })
            items.append(UIAction(title: "Убрать из приложения", subtitle: "Исходный файл на устройстве сохранится", image: IonIcon.image("trash-outline", size: 20), attributes: [.destructive]) { [weak self] _ in self?.player.removeSaved(track) })
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
        table.rowHeight = 77 // 9 + max(55, the three lines) + 9, and 4 under (TrackRow)
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

        column.spacing = 16 // F: `gap: 16`
        headBox.clipsToBounds = false
        headStack.axis = .vertical
        headStack.alignment = .fill
        headStack.spacing = 0
        headStack.translatesAutoresizingMaskIntoConstraints = false
        headBox.addSubview(headStack)

        let titleRow = UIStackView()
        titleRow.axis = .horizontal
        titleRow.alignment = .center
        titleRow.spacing = 10
        let info = GlassRoundButton(symbol: "ion:information-outline", label: "О музыкальном разделе", iconSize: 23)
        info.setTint(ink)
        info.onPress = { [weak self] () -> Void in self?.showInfo() }
        addButton.setTint(ink)
        addButton.onPress = { [weak self] () -> Void in self?.addFiles() }
        [addButton, info].forEach {
            $0.widthAnchor.constraint(equalToConstant: 44).isActive = true
            $0.heightAnchor.constraint(equalToConstant: 44).isActive = true
        }
        // TITLE: Unbounded 26, line 32, as the reference's section titles.
        let heading = UILabel()
        heading.attributedText = Theme.titleWords("Музыка", size: Theme.TypeSize.sectionTitle, color: ink, lineHeight: Theme.TypeSize.sectionTitleLine)
        heading.accessibilityTraits = .header
        heading.setContentHuggingPriority(.defaultLow, for: .horizontal)
        [heading, addButton, info].forEach { titleRow.addArrangedSubview($0) }
        headStack.addArrangedSubview(titleRow)

        // The tabs: a plain row (gap 6), the chosen one on an `ink` pill (radius 12, 14 × 7 inside), 16 pt words.
        tabRow.axis = .horizontal
        tabRow.alignment = .center
        tabRow.spacing = 6
        tabRow.accessibilityTraits = .tabBar
        for (index, words) in ["Главная", "Любимое", "Мои файлы"].enumerated() {
            let button = UIButton(type: .custom)
            button.tag = index
            button.layer.cornerRadius = 12
            button.layer.cornerCurve = .continuous
            button.contentEdgeInsets = UIEdgeInsets(top: 7, left: 14, bottom: 7, right: 14)
            button.setTitle(words, for: .normal)
            button.addTarget(self, action: #selector(tabChanged(_:)), for: .touchUpInside)
            tabButtons.append(button)
            tabRow.addArrangedSubview(button)
        }
        tabRow.addArrangedSubview(UIView())
        headStack.addArrangedSubview(tabRow)
        headStack.setCustomSpacing(10, after: titleRow)

        // The source: SoundCloud | Audius on a quiet well (radius 16, 3 inside), the chosen one lighter (radius 13).
        sourceBox.backgroundColor = Theme.dark ? UIColor(white: 1, alpha: 0.08) : UIColor(red: 20 / 255, green: 36 / 255, blue: 61 / 255, alpha: 0.06)
        sourceBox.layer.cornerRadius = 16
        sourceBox.layer.cornerCurve = .continuous
        sourceBox.accessibilityLabel = "Источник музыки"
        let sourceRow = UIStackView()
        sourceRow.axis = .horizontal
        sourceRow.distribution = .fillEqually
        sourceRow.translatesAutoresizingMaskIntoConstraints = false
        sourceBox.addSubview(sourceRow)
        NSLayoutConstraint.activate([
            sourceRow.topAnchor.constraint(equalTo: sourceBox.topAnchor, constant: 3), sourceRow.bottomAnchor.constraint(equalTo: sourceBox.bottomAnchor, constant: -3),
            sourceRow.leadingAnchor.constraint(equalTo: sourceBox.leadingAnchor, constant: 3), sourceRow.trailingAnchor.constraint(equalTo: sourceBox.trailingAnchor, constant: -3),
            sourceRow.heightAnchor.constraint(equalToConstant: 40),
        ])
        for (index, words) in ["SoundCloud", "Audius"].enumerated() {
            let button = UIButton(type: .custom)
            button.tag = index
            button.layer.cornerRadius = 13
            button.layer.cornerCurve = .continuous
            button.setTitle(words, for: .normal)
            button.addTarget(self, action: #selector(sourceChanged(_:)), for: .touchUpInside)
            sourceButtons.append(button)
            sourceRow.addArrangedSubview(button)
        }
        headStack.addArrangedSubview(sourceBox)
        headStack.setCustomSpacing(12, after: tabRow)

        // «Слушать микс»: centred in what is left of the top (gap 9, 10 above its lower edge): a plain round play (66,
        // white on dark themes, #14243D on light ones, with a soft shadow), the name (21 bold) and its quiet line (14).
        mixRow.axis = .vertical
        mixRow.alignment = .center
        mixRow.spacing = 9
        mixRow.translatesAutoresizingMaskIntoConstraints = false
        mixButton.backgroundColor = Theme.dark ? .white : UIColor(hex: 0x14243D)
        mixButton.tintColor = Theme.dark ? .black : .white
        mixButton.setImage(IonIcon.image("play", size: 30), for: .normal)
        mixButton.imageEdgeInsets = UIEdgeInsets(top: 0, left: 4, bottom: 0, right: 0)
        mixButton.layer.cornerRadius = 33
        mixButton.layer.shadowColor = UIColor.black.cgColor
        mixButton.layer.shadowOpacity = 0.3
        mixButton.layer.shadowRadius = 12
        mixButton.layer.shadowOffset = CGSize(width: 0, height: 6)
        mixButton.accessibilityLabel = "Слушать микс"
        mixButton.widthAnchor.constraint(equalToConstant: 66).isActive = true
        mixButton.heightAnchor.constraint(equalToConstant: 66).isActive = true
        mixButton.addTarget(self, action: #selector(mix), for: .touchUpInside)
        Bouncy.attach(mixButton, scale: 0.94)
        let mixName = AIKit.label("Слушать микс", size: 21, weight: .bold, color: ink, lines: 1, align: .center)
        mixLine.textColor = soft
        mixLine.textAlignment = .center
        [mixButton, mixName, mixLine].forEach { mixRow.addArrangedSubview($0) }
        headBox.addSubview(mixRow)
        let heroSpace = UILayoutGuide()
        headBox.addLayoutGuide(heroSpace)
        let tall = headBox.heightAnchor.constraint(equalToConstant: 300)
        tall.priority = UILayoutPriority(999)
        headHeight = tall
        NSLayoutConstraint.activate([
            headStack.topAnchor.constraint(equalTo: headBox.topAnchor),
            headStack.leadingAnchor.constraint(equalTo: headBox.leadingAnchor),
            headStack.trailingAnchor.constraint(equalTo: headBox.trailingAnchor),
            headBox.bottomAnchor.constraint(greaterThanOrEqualTo: headStack.bottomAnchor),
            tall,
            heroSpace.topAnchor.constraint(equalTo: headStack.bottomAnchor),
            heroSpace.bottomAnchor.constraint(equalTo: headBox.bottomAnchor, constant: -10),
            mixRow.centerYAnchor.constraint(equalTo: heroSpace.centerYAnchor),
            mixRow.centerXAnchor.constraint(equalTo: headBox.centerXAnchor),
            mixRow.leadingAnchor.constraint(greaterThanOrEqualTo: headBox.leadingAnchor),
        ])
        column.addArrangedSubview(headBox)

        // The search: a full pill on glass (radius 26, at least 48 tall, 16 inside), #1F1F1F on dark themes; the
        // magnifier (20) in the quiet colour, 10 before the words (15).
        searchPill.shape(radius: 26)
        if Theme.dark { searchPill.contentView.backgroundColor = UIColor(hex: 0x1F1F1F) }
        search.backgroundColor = .clear
        search.textColor = Theme.text
        search.tintColor = Theme.accent
        search.font = .systemFont(ofSize: 15)
        search.keyboardAppearance = Theme.dark ? .dark : .light
        search.returnKeyType = .search
        search.autocorrectionType = .no
        search.clearButtonMode = .whileEditing
        search.delegate = self
        search.accessibilityLabel = "Поиск музыки"
        let lens = UIView(frame: CGRect(x: 0, y: 0, width: 46, height: 48))
        let glass = UIImageView(image: IonIcon.image("search-outline", size: 20))
        glass.tintColor = Theme.muted
        glass.contentMode = .center
        glass.frame = CGRect(x: 16, y: 0, width: 20, height: 48)
        lens.addSubview(glass)
        search.leftView = lens
        search.leftViewMode = .always
        search.addTarget(self, action: #selector(typed), for: .editingChanged)
        search.translatesAutoresizingMaskIntoConstraints = false
        searchPill.contentView.addSubview(search)
        NSLayoutConstraint.activate([
            search.topAnchor.constraint(equalTo: searchPill.contentView.topAnchor),
            search.bottomAnchor.constraint(equalTo: searchPill.contentView.bottomAnchor),
            search.leadingAnchor.constraint(equalTo: searchPill.contentView.leadingAnchor),
            search.trailingAnchor.constraint(equalTo: searchPill.contentView.trailingAnchor, constant: -8),
            searchPill.heightAnchor.constraint(equalToConstant: 48),
        ])
        column.addArrangedSubview(searchPill)
        shelves.axis = .vertical
        shelves.spacing = 16
        column.addArrangedSubview(shelves)

        // The moods: tall chips (at least 62 × 100, radius 21, 16 × 11 inside), the icon (18) over the name (11).
        moodScroll.showsHorizontalScrollIndicator = false
        moodScroll.clipsToBounds = false
        moodScroll.heightAnchor.constraint(equalToConstant: 64).isActive = true
        moodRow.axis = .horizontal
        moodRow.alignment = .top
        moodRow.spacing = 8
        moodRow.translatesAutoresizingMaskIntoConstraints = false
        moodScroll.addSubview(moodRow)
        NSLayoutConstraint.activate([
            moodRow.topAnchor.constraint(equalTo: moodScroll.contentLayoutGuide.topAnchor), moodRow.bottomAnchor.constraint(equalTo: moodScroll.contentLayoutGuide.bottomAnchor),
            moodRow.leadingAnchor.constraint(equalTo: moodScroll.contentLayoutGuide.leadingAnchor), moodRow.trailingAnchor.constraint(equalTo: moodScroll.contentLayoutGuide.trailingAnchor),
            moodRow.heightAnchor.constraint(equalTo: moodScroll.frameLayoutGuide.heightAnchor),
        ])
        column.addArrangedSubview(moodScroll)
        column.addArrangedSubview(caption)
        // «Любимое» and «Мои файлы»: a few words about the section in place of the moods.
        column.addArrangedSubview(sectionWords)

        notices.axis = .vertical
        notices.spacing = 8
        column.addArrangedSubview(notices)

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
        // F: the top is `headHeight` tall from the screen's top; the column starts 8 under the safe area.
        let tall = (section == "catalog" && query.isEmpty ? min(430, view.bounds.height * 0.5) : 132) + view.safeAreaInsets.top
        let wanted = max(0, tall - view.safeAreaInsets.top - 8)
        if let headHeight, abs(headHeight.constant - wanted) > 0.5 { headHeight.constant = wanted }
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

    /// The reference's `Notice` (no close button: the words go when the cause does).
    private func noticeBox(_ text: String, error: Bool, retry: (() -> Void)? = nil) -> UIView {
        return NoticeView(text: text, error: error, retry: retry)
    }

    private func refresh() {
        guard isViewLoaded else { return }
        let catalog = section == "catalog"
        for button in tabButtons {
            let on = ["catalog", "favorites", "saved"][button.tag] == section
            button.backgroundColor = on ? ink : .clear
            button.setTitleColor(on ? inkInverse : soft, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 16, weight: on ? .bold : .semibold)
            button.accessibilityTraits = on ? [.button, .selected] : .button
        }
        search.attributedPlaceholder = NSAttributedString(string: section == "saved" ? "Поиск в моих файлах" : "Трек или исполнитель", attributes: [.foregroundColor: Theme.muted])
        sourceBox.isHidden = !(catalog && scReady)
        for button in sourceButtons {
            let on = (button.tag == 0 ? "soundcloud" : "audius") == source
            button.backgroundColor = on ? (Theme.dark ? UIColor(white: 1, alpha: 0.16) : .white) : .clear
            button.setTitleColor(on ? ink : soft, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 15, weight: on ? .bold : .semibold)
            button.accessibilityTraits = on ? [.button, .selected] : .button
        }
        moodScroll.isHidden = !catalog
        moodRow.arrangedSubviews.forEach { $0.removeFromSuperview() }
        var chips: [(String?, String, String)] = [(nil, "Любое", "sparkles-outline")]
        chips += MusicCatalog.moods.dropFirst().map { ($0.apiMood, $0.label, $0.symbol) }
        for chip in chips {
            let selected = chip.0 == mood
            let button = UIControl()
            button.layer.cornerRadius = 21
            button.layer.cornerCurve = .continuous
            button.layer.borderWidth = 1
            button.layer.borderColor = (selected ? Theme.accent : ThemeStore.look.border).cgColor
            button.backgroundColor = selected ? ThemeStore.look.accentSoft : Theme.veil(0.04)
            button.isAccessibilityElement = true
            button.accessibilityLabel = chip.1
            button.accessibilityTraits = selected ? [.button, .selected] : .button
            let icon = UIImageView(image: IonIcon.image(chip.2, size: 18))
            icon.tintColor = selected ? Theme.accent : Theme.muted
            icon.contentMode = .left
            let name = AIKit.label(chip.1, size: 11, weight: .semibold, color: selected ? Theme.accent : Theme.text, lines: 1)
            let inner = UIStackView(arrangedSubviews: [icon, name])
            inner.axis = .vertical
            inner.alignment = .leading
            inner.spacing = 5
            inner.isUserInteractionEnabled = false
            inner.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(inner)
            NSLayoutConstraint.activate([
                inner.leadingAnchor.constraint(equalTo: button.leadingAnchor, constant: 16),
                inner.trailingAnchor.constraint(lessThanOrEqualTo: button.trailingAnchor, constant: -16),
                inner.centerYAnchor.constraint(equalTo: button.centerYAnchor),
                icon.heightAnchor.constraint(equalToConstant: 18),
                button.heightAnchor.constraint(equalToConstant: 62),
                button.widthAnchor.constraint(greaterThanOrEqualToConstant: 100),
            ])
            let value = chip.0
            button.addAction(UIAction { [weak self] (_: UIAction) -> Void in self?.pickMood(value) }, for: .touchUpInside)
            moodRow.addArrangedSubview(button)
        }
        sectionWords.isHidden = catalog
        sectionWords.text = section == "saved" ? "Твои файлы на этом устройстве. Добавляй аудио через «+» и слушай без интернета." : "Треки, которые ты отметил сердцем. Для воспроизведения Audius нужен интернет."
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
        if !player.error.isEmpty { notices.addArrangedSubview(noticeBox(player.error, error: true)) }
        if !player.notice.isEmpty { notices.addArrangedSubview(noticeBox(player.notice, error: false)) }
        if !sourceNotice.isEmpty, catalog { notices.addArrangedSubview(noticeBox(sourceNotice, error: false)) }
        if !failure.isEmpty, catalog { notices.addArrangedSubview(noticeBox(failure, error: true) { [weak self] in self?.reloadCatalog() }) }
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
        row.show(track, current: player.current?.id == track.id, favorite: player.isFavorite(track), menu: menu(track), playing: player.playing)
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
