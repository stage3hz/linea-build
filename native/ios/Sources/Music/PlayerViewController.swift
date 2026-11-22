import CoreImage
import CoreText
import UIKit

/// The full player, laid out as the reference's `FullPlayer` (mobile/src/music/PlayerControls.tsx): a full-screen
/// modal over the blurred cover (or the music ambient); the top bar (collapse, «Сейчас играет», the track's page);
/// the cover, swiped left / right between tracks and down to collapse; the title with the 46 pt «в любимое» and «ещё»;
/// a row of chips; the seek line; the controls; and «Очередь · N | Текст» on a raised bar at the bottom, which opens
/// the panel of the queue and of the words.
final class PlayerViewController: UIViewController, UIGestureRecognizerDelegate {
    private let player = MusicPlayer.shared

    // What lies behind.
    private let backdrop = UIImageView()
    private let veil = UIView()
    private let ambient = MusicAmbientView(tone: MusicAmbientView.themeTone, custom: MusicAmbientView.themeCustom)
    private var backdropTrack = ""

    // The top bar.
    private let topBar = UIView()
    private let fold = UIButton(type: .custom)
    private let kicker = UILabel()
    private let source = UIButton(type: .custom)

    // The cover.
    private let coverBox = UIView()
    private let cover = MusicCoverView(radius: 36, look: .artwork)

    // The title row.
    private let heading = UILabel()
    private let artist = UILabel()
    private let like = UIButton(type: .custom)
    private let more = UIButton(type: .custom)

    // The chips.
    private let chips = UIScrollView()
    private let chipRow = UIStackView()

    // The seek line.
    private let seek = PlayerSeekView()

    // The controls.
    private let shuffleButton = UIButton(type: .custom)
    private let backButton = UIButton(type: .custom)
    private let playButton = UIButton(type: .custom)
    private let forwardButton = UIButton(type: .custom)
    private let repeatButton = UIButton(type: .custom)
    private let waiting = UIActivityIndicatorView(style: .medium)
    private var noticeView: UIView?
    private var noticeMark = ""

    // «Очередь · N | Текст».
    private let bottomBar = UIView()
    private let queueTab = UIControl()
    private let queueWords = UILabel()
    private let queueCount = UILabel()
    private let lyricsTab = UIControl()
    private let lyricsWords = UILabel()

    // The panel.
    private let panelDim = UIControl()
    private let panel = UIView()
    private let grabber = UIView()
    private let panelTabs = [UIControl(), UIControl()]
    private let panelTabWords = [UILabel(), UILabel()]
    private let panelTabLines = [UIView(), UIView()]
    private let panelScroll = UIScrollView()
    private let panelList = UIStackView()
    private var panelShown: String?
    private var panelMark = ""

    private var soft: UIColor { Theme.dark ? UIColor(white: 1, alpha: 0.12) : UIColor(white: 0, alpha: 0.07) }

    init() {
        super.init(nibName: nil, bundle: nil)
        // <Modal transparent animationType="slide">: over everything, sliding up from the bottom.
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .coverVertical
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: Building

    private func iconButton(_ button: UIButton, _ glyph: String, size: CGFloat, color: UIColor, words: String, action: Selector) {
        button.setImage(IonIcon.image(glyph, size: size), for: .normal)
        button.tintColor = color
        button.accessibilityLabel = words
        button.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        button.addTarget(self, action: action, for: .touchUpInside)
        GlassBacking.put(under: button) // IconButton: a round of clear glass, Bouncy 0.86
    }

    private func label(_ label: UILabel, size: CGFloat, weight: UIFont.Weight, color: UIColor) {
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = color
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        for part in [ambient, backdrop, veil] as [UIView] {
            part.isUserInteractionEnabled = false
            view.addSubview(part)
        }
        backdrop.contentMode = .scaleAspectFill
        backdrop.clipsToBounds = true
        // COVER_VEIL: black .68 on dark themes, white .82 on light ones.
        veil.backgroundColor = Theme.dark ? UIColor(white: 0, alpha: 0.68) : UIColor(white: 1, alpha: 0.82)

        // The top bar: 52 tall.
        view.addSubview(topBar)
        iconButton(fold, "chevron-down", size: 26, color: Theme.text, words: "Свернуть плеер", action: #selector(foldAway))
        topBar.addSubview(fold)
        label(kicker, size: 16, weight: .medium, color: Theme.text)
        kicker.textAlignment = .center
        topBar.addSubview(kicker)
        iconButton(source, "arrow-redo-outline", size: 23, color: Theme.text, words: "Открыть страницу трека", action: #selector(openSource))
        topBar.addSubview(source)

        view.addSubview(coverBox)
        coverBox.addSubview(cover)
        // The cover's shadow (borderRadius 34, #000 at .35, radius 22, 0 × 12) — the full player keeps the cover plain.

        label(heading, size: 22, weight: .bold, color: Theme.text)
        label(artist, size: 15, weight: .regular, color: Theme.muted)
        view.addSubview(heading)
        view.addSubview(artist)
        for button in [like, more] {
            button.layer.cornerRadius = 23
            button.addAction(UIAction { [weak button] _ in button?.alpha = 0.7 }, for: [.touchDown, .touchDragEnter])
            button.addAction(UIAction { [weak button] _ in button?.alpha = 1 }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
            view.addSubview(button)
        }
        like.addTarget(self, action: #selector(toggleLike), for: .touchUpInside)
        more.setImage(IonIcon.image("ellipsis-horizontal", size: 22), for: .normal)
        more.tintColor = Theme.text
        more.backgroundColor = soft
        more.accessibilityLabel = "Ещё"
        more.addTarget(self, action: #selector(openQueue), for: .touchUpInside)

        chips.showsHorizontalScrollIndicator = false
        chips.alwaysBounceHorizontal = true
        view.addSubview(chips)
        chipRow.axis = .horizontal
        chipRow.spacing = 8
        chipRow.alignment = .center
        chips.addSubview(chipRow)

        seek.onSeek = { [weak self] (seconds: Double) -> Void in self?.player.seek(seconds) }
        view.addSubview(seek)

        iconButton(shuffleButton, "shuffle", size: 26, color: Theme.muted, words: "Включить случайный порядок", action: #selector(mixUp))
        iconButton(backButton, "play-skip-back", size: 36, color: Theme.text, words: "Предыдущий трек или начало текущего", action: #selector(goBack))
        iconButton(forwardButton, "play-skip-forward", size: 36, color: Theme.text, words: "Следующий трек", action: #selector(goForward))
        iconButton(repeatButton, "repeat", size: 26, color: Theme.muted, words: "Повтор выключен", action: #selector(cycleRepeat))
        // PlaybackButton large: the bare glyph (52) in 72 × 72, `scale: pressed ? .96 : 1`.
        playButton.tintColor = Theme.text
        playButton.addTarget(self, action: #selector(flip), for: .touchUpInside)
        playButton.addAction(UIAction { [weak self] _ in self?.playButton.transform = CGAffineTransform(scaleX: 0.96, y: 0.96) }, for: [.touchDown, .touchDragEnter])
        playButton.addAction(UIAction { [weak self] _ in self?.playButton.transform = .identity }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        waiting.color = Theme.text
        waiting.hidesWhenStopped = true
        for part in [shuffleButton, backButton, playButton, forwardButton, repeatButton, waiting] as [UIView] { view.addSubview(part) }

        // The raised bar: 56 tall, radius 20.
        bottomBar.layer.cornerRadius = 20
        bottomBar.layer.cornerCurve = .continuous
        bottomBar.backgroundColor = Theme.dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.05)
        view.addSubview(bottomBar)
        label(queueWords, size: 16, weight: .semibold, color: Theme.text)
        queueWords.text = "Очередь"
        label(queueCount, size: 12, weight: .regular, color: Theme.muted)
        queueCount.textAlignment = .center
        queueCount.backgroundColor = soft
        queueCount.layer.cornerRadius = 10
        queueCount.layer.masksToBounds = true
        queueTab.addSubview(queueWords)
        queueTab.addSubview(queueCount)
        queueTab.accessibilityTraits = .button
        queueTab.isAccessibilityElement = true
        queueTab.addTarget(self, action: #selector(openQueue), for: .touchUpInside)
        label(lyricsWords, size: 16, weight: .semibold, color: Theme.text)
        lyricsWords.text = "Текст"
        lyricsWords.textAlignment = .center
        lyricsTab.addSubview(lyricsWords)
        lyricsTab.accessibilityTraits = .button
        lyricsTab.isAccessibilityElement = true
        lyricsTab.accessibilityLabel = "Текст"
        lyricsTab.addTarget(self, action: #selector(openLyrics), for: .touchUpInside)
        bottomBar.addSubview(queueTab)
        bottomBar.addSubview(lyricsTab)

        // The panel over a 0.4 dim.
        panelDim.backgroundColor = UIColor(white: 0, alpha: 0.4)
        panelDim.accessibilityLabel = "Закрыть"
        panelDim.addTarget(self, action: #selector(closePanel), for: .touchUpInside)
        panelDim.isHidden = true
        view.addSubview(panelDim)
        panel.backgroundColor = Theme.dark ? UIColor(hex: 0x141A26) : UIColor(hex: 0xF4F7FC)
        panel.layer.cornerRadius = 24
        panel.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        panel.isHidden = true
        view.addSubview(panel)
        grabber.backgroundColor = Theme.subtle
        grabber.layer.cornerRadius = 2
        panel.addSubview(grabber)
        for (index, tab) in panelTabs.enumerated() {
            tab.tag = index
            tab.addTarget(self, action: #selector(panelTab(_:)), for: .touchUpInside)
            label(panelTabWords[index], size: 15, weight: .semibold, color: Theme.muted)
            panelTabWords[index].textAlignment = .center
            tab.addSubview(panelTabWords[index])
            tab.addSubview(panelTabLines[index])
            panel.addSubview(tab)
        }
        panelList.axis = .vertical
        panelScroll.addSubview(panelList)
        panel.addSubview(panelScroll)

        // A clear, mostly vertical drag down on the top bar or the cover collapses the player.
        for host in [topBar, coverBox] {
            let pull = UIPanGestureRecognizer(target: self, action: #selector(pulled(_:)))
            pull.delegate = self
            host.addGestureRecognizer(pull)
        }

        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: MusicPlayer.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(coverArrived(_:)), name: MusicCovers.ready, object: nil)
        refresh()
    }

    // MARK: Showing

    private func chip(_ glyph: String, _ words: String?, disabled: Bool = false, action: @escaping () -> Void) -> UIView {
        let button = UIButton(type: .custom)
        button.backgroundColor = soft
        button.layer.cornerRadius = 12
        button.layer.cornerCurve = .continuous
        button.setImage(IonIcon.image(glyph, size: 19), for: .normal)
        button.tintColor = Theme.text
        if let words {
            button.setAttributedTitle(NSAttributedString(string: words, attributes: [.font: UIFont.systemFont(ofSize: 15, weight: .medium), .foregroundColor: Theme.text]), for: .normal)
            button.titleEdgeInsets = UIEdgeInsets(top: 0, left: 7, bottom: 0, right: -7)
            button.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14 + 7)
        }
        button.accessibilityLabel = words ?? glyph
        button.isEnabled = !disabled
        button.alpha = disabled ? 0.4 : 1
        button.addAction(UIAction { [weak button] _ in button?.alpha = 0.6 }, for: [.touchDown, .touchDragEnter])
        button.addAction(UIAction { [weak button] _ in button?.alpha = 1 }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.heightAnchor.constraint(equalToConstant: 40).isActive = true
        if words == nil { button.widthAnchor.constraint(equalToConstant: 48).isActive = true }
        return button
    }

    private var chipMark = ""

    @objc private func refresh() {
        guard isViewLoaded else { return }
        guard let track = player.current else { dismiss(animated: true); return }
        let favorite = player.isFavorite(track)
        cover.bind(track)
        paintBackdrop(track)
        kicker.text = track.source == "local" ? "Мои файлы" : "Сейчас играет"
        source.isHidden = track.sourceUrl == nil
        heading.attributedText = NSAttributedString(string: track.title, attributes: [.font: UIFont.systemFont(ofSize: 22, weight: .bold), .kern: -0.3, .foregroundColor: Theme.text])
        heading.lineBreakMode = .byTruncatingTail
        artist.text = track.artist
        // «в любимое»: 46 round — the text colour with a tick in the page colour, else the soft plate with «add».
        like.backgroundColor = favorite ? Theme.text : soft
        like.setImage(IonIcon.image(favorite ? "checkmark" : "add", size: 24), for: .normal)
        like.tintColor = favorite ? Theme.bg : Theme.text
        like.accessibilityLabel = favorite ? "Убрать из любимого" : "В любимое"

        let mark = "\(track.id)|\(favorite)|\(player.shuffle)|\(track.downloadable)"
        if mark != chipMark {
            chipMark = mark
            chipRow.arrangedSubviews.forEach { $0.removeFromSuperview() }
            if track.source != "soundcloud" {
                chipRow.addArrangedSubview(chip(track.source == "local" ? "share-outline" : "download-outline", nil, disabled: track.source == "audius" && !track.downloadable) { [weak self] in self?.download(track) })
            }
            chipRow.addArrangedSubview(chip(favorite ? "heart" : "heart-outline", favorite ? "В любимом" : "В любимое") { [weak self] in self?.player.toggleFavorite(track) })
            chipRow.addArrangedSubview(chip("shuffle", player.shuffle ? "Перемешано" : "Перемешать") { [weak self] in self?.player.toggleShuffle() })
            chipRow.addArrangedSubview(chip("options-outline", "Эквалайзер") { [weak self] in self?.openEqualizer() })
        }

        seek.show(position: player.position, duration: player.duration)
        shuffleButton.tintColor = player.shuffle ? Theme.accent : Theme.muted
        shuffleButton.accessibilityLabel = player.shuffle ? "Случайный порядок включён" : "Включить случайный порядок"
        repeatButton.tintColor = player.repeatMode != "off" ? Theme.accent : Theme.muted
        let repeatWords = player.repeatMode == "one" ? "Повтор одного трека" : (player.repeatMode == "all" ? "Повтор очереди" : "Повтор выключен")
        repeatButton.accessibilityLabel = repeatWords + ". Изменить"
        forwardButton.isEnabled = player.queue.count >= 2
        forwardButton.alpha = forwardButton.isEnabled ? 1 : 0.45
        playButton.setImage(player.loading ? nil : IonIcon.image(player.playing ? "pause" : "play", size: 52), for: .normal)
        playButton.accessibilityLabel = player.loading ? "Загрузка. Повторить воспроизведение" : (player.playing ? "Приостановить" : "Воспроизвести")
        if player.loading { waiting.startAnimating() } else { waiting.stopAnimating() }

        // What went wrong (a touch clears it), else what the player says.
        let words = !player.error.isEmpty ? "e" + player.error : (!player.notice.isEmpty ? "n" + player.notice : "")
        if words != noticeMark {
            noticeMark = words
            noticeView?.removeFromSuperview()
            noticeView = nil
            if !words.isEmpty {
                let error = words.hasPrefix("e")
                let made = NoticeView(text: String(words.dropFirst()), error: error)
                made.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(clearNotice)))
                view.addSubview(made)
                noticeView = made
            }
        }
        queueCount.text = String(player.queue.count)
        queueTab.accessibilityLabel = "Очередь, \(player.queue.count)"
        if panelShown != nil { fillPanel() }
        view.setNeedsLayout()
    }

    // MARK: Places

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, height = view.bounds.height
        let insets = view.safeAreaInsets
        ambient.frame = view.bounds
        veil.frame = view.bounds
        // The blurred cover: `scale 1.3` over a cover fit.
        backdrop.bounds = CGRect(x: 0, y: 0, width: width * 1.3, height: height * 1.3)
        backdrop.center = CGPoint(x: width / 2, y: height / 2)

        let coverSide = (min(width - 56, height * 0.44, 460)).rounded()
        let side = max(16, ((width - coverSide) / 2).rounded())

        topBar.frame = CGRect(x: 0, y: insets.top, width: width, height: 52)
        fold.frame = CGRect(x: side, y: 4, width: 44, height: 44)
        source.frame = CGRect(x: width - side - 44, y: 4, width: 44, height: 44)
        kicker.frame = CGRect(x: side + 44, y: 0, width: width - 2 * (side + 44), height: 52)

        // From the bottom up: the bar, the block (paddingBottom 14, gap 18).
        let barBottom = height - max(12, insets.bottom)
        bottomBar.frame = CGRect(x: side, y: barBottom - 56, width: width - 2 * side, height: 56)
        let half = bottomBar.bounds.width / 2
        queueTab.frame = CGRect(x: 0, y: 0, width: half, height: 56)
        lyricsTab.frame = CGRect(x: half, y: 0, width: half, height: 56)
        lyricsWords.frame = lyricsTab.bounds
        let wordsWidth = ceil(queueWords.sizeThatFits(CGSize(width: 200, height: 30)).width)
        let countWidth = max(22, ceil(queueCount.sizeThatFits(CGSize(width: 80, height: 20)).width) + 12)
        let pair = wordsWidth + 8 + countWidth
        queueWords.frame = CGRect(x: (half - pair) / 2, y: 0, width: wordsWidth, height: 56)
        queueCount.frame = CGRect(x: queueWords.frame.maxX + 8, y: 18, width: countWidth, height: 20)

        let inner = width - 2 * side
        var y = bottomBar.frame.minY - 14
        if let noticeView {
            let tall = noticeView.sizeThatFits(CGSize(width: inner, height: 0)).height
            y -= tall
            noticeView.frame = CGRect(x: side, y: y, width: inner, height: tall)
            y -= 18
        }
        // The controls: space-between, the play 72.
        y -= 72
        playButton.frame = CGRect(x: (width - 72) / 2, y: y, width: 72, height: 72)
        waiting.center = playButton.center
        let gaps = (inner - 44 * 4 - 72) / 4
        shuffleButton.frame = CGRect(x: side, y: y + 14, width: 44, height: 44)
        backButton.frame = CGRect(x: side + 44 + gaps, y: y + 14, width: 44, height: 44)
        forwardButton.frame = CGRect(x: playButton.frame.maxX + gaps, y: y + 14, width: 44, height: 44)
        repeatButton.frame = CGRect(x: width - side - 44, y: y + 14, width: 44, height: 44)
        y -= 18
        // The seek line: 44 for the line, the times 4 over its lower part.
        let seekTall = seek.height
        y -= seekTall
        seek.frame = CGRect(x: side, y: y, width: inner, height: seekTall)
        y -= 18
        // The chips: 40, running to the screen's edges with `side` inside.
        y -= 40
        chips.frame = CGRect(x: 0, y: y, width: width, height: 40)
        let rowSize = chipRow.systemLayoutSizeFitting(CGSize(width: UIView.layoutFittingCompressedSize.width, height: 40))
        chipRow.frame = CGRect(x: side, y: 0, width: rowSize.width, height: 40)
        chips.contentSize = CGSize(width: rowSize.width + 2 * side, height: 40)
        y -= 18
        // The title row: the words (22 bold, then 15, 4 apart), 12, the two 46 rounds.
        let headLine = ceil(UIFont.systemFont(ofSize: 22, weight: .bold).lineHeight)
        let artistLine = ceil(UIFont.systemFont(ofSize: 15).lineHeight)
        let rowTall = max(46, headLine + 4 + artistLine)
        y -= rowTall
        more.frame = CGRect(x: width - side - 46, y: y + (rowTall - 46) / 2, width: 46, height: 46)
        like.frame = CGRect(x: more.frame.minX - 12 - 46, y: more.frame.minY, width: 46, height: 46)
        let wordsTop = y + (rowTall - headLine - 4 - artistLine) / 2
        heading.frame = CGRect(x: side, y: wordsTop, width: like.frame.minX - 12 - side, height: headLine)
        artist.frame = CGRect(x: side, y: wordsTop + headLine + 4, width: heading.frame.width, height: artistLine)

        // The cover: centred in what is left between the top bar and the title row.
        coverBox.frame = CGRect(x: 0, y: topBar.frame.maxY, width: width, height: max(0, y - topBar.frame.maxY))
        cover.frame = CGRect(x: (width - coverSide) / 2, y: (coverBox.bounds.height - coverSide) / 2, width: coverSide, height: coverSide)

        // The panel.
        panelDim.frame = view.bounds
        layoutPanel()
    }

    // MARK: The panel

    private func layoutPanel() {
        guard panelShown != nil else { return }
        let width = view.bounds.width, height = view.bounds.height
        let listHeight = panelList.systemLayoutSizeFitting(CGSize(width: width - 20, height: UIView.layoutFittingCompressedSize.height), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height
        let head: CGFloat = 10 + 4 + 8 + (8 + ceil(UIFont.systemFont(ofSize: 15, weight: .semibold).lineHeight) + 8 + 2) + 6
        let tall = min(height * 0.66, head + listHeight + view.safeAreaInsets.bottom + 8)
        panel.frame = CGRect(x: 0, y: height - tall, width: width, height: tall)
        grabber.frame = CGRect(x: (width - 36) / 2, y: 10, width: 36, height: 4)
        let tabWidth = (width - 24) / 2
        let tabTall = 8 + ceil(UIFont.systemFont(ofSize: 15, weight: .semibold).lineHeight) + 8 + 2
        for index in 0..<2 {
            panelTabs[index].frame = CGRect(x: 12 + CGFloat(index) * tabWidth, y: 22, width: tabWidth, height: tabTall)
            panelTabWords[index].frame = CGRect(x: 0, y: 0, width: tabWidth, height: tabTall - 2)
            panelTabLines[index].frame = CGRect(x: 0, y: tabTall - 2, width: tabWidth, height: 2)
        }
        let listTop = 22 + tabTall + 6
        panelScroll.frame = CGRect(x: 0, y: listTop, width: width, height: max(0, tall - listTop - view.safeAreaInsets.bottom - 8))
        panelList.frame = CGRect(x: 10, y: 0, width: width - 20, height: listHeight)
        panelScroll.contentSize = CGSize(width: width, height: listHeight)
    }

    private func showPanel(_ which: String) {
        panelShown = which
        panelMark = ""
        panelDim.isHidden = false
        panel.isHidden = false
        fillPanel()
        view.setNeedsLayout()
    }

    private func fillPanel() {
        guard let which = panelShown, let track = player.current else { return }
        for index in 0..<2 {
            let on = (index == 0) == (which == "queue")
            panelTabWords[index].text = index == 0 ? "Очередь · \(player.queue.count)" : "Текст"
            panelTabWords[index].textColor = on ? Theme.text : Theme.muted
            panelTabLines[index].backgroundColor = on ? Theme.text : .clear
        }
        let mark = which + "|" + track.id + "|\(player.playing)|" + player.queue.map { $0.id }.joined(separator: ",")
        if mark == panelMark { return }
        panelMark = mark
        panelList.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if which == "queue" {
            for item in player.queue {
                let row = PlayerQueueRow(item: item, current: item.id == track.id, playing: player.playing)
                row.addAction(UIAction { [weak self] _ in self?.player.play(item, queue: self?.player.queue) }, for: .touchUpInside)
                panelList.addArrangedSubview(row)
            }
        } else {
            let box = UIStackView()
            box.axis = .vertical
            box.alignment = .center
            box.spacing = 8
            box.isLayoutMarginsRelativeArrangement = true
            box.layoutMargins = UIEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
            let glyph = UIImageView(image: IonIcon.image("document-text-outline", size: 34))
            glyph.tintColor = Theme.subtle
            let title = UILabel()
            label(title, size: 16, weight: .semibold, color: Theme.text)
            title.text = "Текста пока нет"
            let words = UILabel()
            let style = NSMutableParagraphStyle()
            style.minimumLineHeight = 19
            style.maximumLineHeight = 19
            style.alignment = .center
            words.attributedText = NSAttributedString(string: "Каталог Audius не передаёт тексты песен, поэтому показать текст этого трека нельзя.", attributes: [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: Theme.muted, .paragraphStyle: style])
            words.numberOfLines = 0
            for part in [glyph, title, words] as [UIView] { box.addArrangedSubview(part) }
            panelList.addArrangedSubview(box)
        }
        view.setNeedsLayout()
    }

    @objc private func closePanel() {
        panelShown = nil
        panelDim.isHidden = true
        panel.isHidden = true
    }

    @objc private func panelTab(_ sender: UIControl) { showPanel(sender.tag == 0 ? "queue" : "lyrics") }
    @objc private func openQueue() { showPanel("queue") }
    @objc private func openLyrics() { showPanel("lyrics") }

    // MARK: What the touches do

    private func download(_ track: MusicTrack) {
        if track.source == "local" {
            guard let file = player.fileURL(track), FileManager.default.fileExists(atPath: file.path) else { return player.report("Сохранённый файл не найден.") }
            present(UIActivityViewController(activityItems: [file], applicationActivities: nil), animated: true)
            return
        }
        MusicCatalog.resolveDownload(track) { result in
            switch result {
            case .failure(let failure): MusicPlayer.shared.report(failure.words)
            case .success(let address):
                if let url = URL(string: address) { UIApplication.shared.open(url) }
                MusicPlayer.shared.say("Скачивание открыто через Audius. Сохранённый файл можно добавить сюда через «Добавить файлы».")
            }
        }
    }

    private func openEqualizer() {
        guard presentedViewController == nil else { return }
        present(EqualizerViewController(), animated: true)
    }

    @objc private func openSource() {
        guard let address = player.current?.sourceUrl, let url = URL(string: address), url.scheme?.lowercased() == "https" else { return }
        UIApplication.shared.open(url)
    }

    @objc private func clearNotice() {
        if !player.error.isEmpty { player.clearError() } else { player.clearNotice() }
    }

    @objc private func foldAway() { dismiss(animated: true) }
    @objc private func toggleLike() { if let track = player.current { player.toggleFavorite(track) } }
    @objc private func mixUp() { player.toggleShuffle() }
    @objc private func cycleRepeat() { player.toggleRepeat() }
    @objc private func goBack() { player.previous() }
    @objc private func goForward() { player.next() }
    @objc private func flip() { player.togglePlayback() }

    // MARK: Gestures

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let speed = pan.velocity(in: view)
        // The cover: left / right changes the track; down collapses.
        return abs(speed.y) > abs(speed.x) || pan.view === coverBox
    }

    private var swipeAxis = 0

    /// Down on the top bar or the cover: collapse past 90 pt or at 900 pt/s (no live movement of the page).
    /// Across the cover: it follows the finger and fades; past 0.28 of its size or at 800 pt/s it leaves (180 ms
    /// out-quad), the next track comes in from the other side on a spring (damping 18, stiffness 220).
    @objc private func pulled(_ pan: UIPanGestureRecognizer) {
        let move = pan.translation(in: view), speed = pan.velocity(in: view)
        let size = cover.bounds.width
        switch pan.state {
        case .began:
            swipeAxis = pan.view === coverBox && abs(speed.x) > abs(speed.y) ? 1 : 2
        case .changed:
            if swipeAxis == 1 {
                cover.transform = CGAffineTransform(translationX: move.x, y: 0)
                cover.alpha = 1 - min(0.5, abs(move.x) / max(1, size) * 0.6)
            }
        case .ended, .cancelled:
            if swipeAxis == 1 {
                let go = pan.state == .ended && (abs(move.x) > size * 0.28 || abs(speed.x) > 800) && player.queue.count > 1
                if go {
                    let direction: CGFloat = move.x < 0 ? -1 : 1
                    var steps: [NSValue] = []
                    for step in 0...30 {
                        let t = CGFloat(step) / 30, v = 1 - (1 - t) * (1 - t)
                        steps.append(NSValue(caTransform3D: CATransform3DMakeTranslation(move.x + (direction * size * 1.2 - move.x) * v, 0, 0)))
                    }
                    let out = CAKeyframeAnimation(keyPath: "transform")
                    out.values = steps
                    out.duration = 0.18
                    CATransaction.begin()
                    CATransaction.setCompletionBlock { [weak self] in
                        guard let self else { return }
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        if direction < 0 { self.player.next() } else { self.player.previous() }
                        self.cover.transform = CGAffineTransform(translationX: -direction * size * 0.4, y: 0)
                        let back = UIViewPropertyAnimator(duration: 0, timingParameters: UISpringTimingParameters(mass: 1, stiffness: 220, damping: 18, initialVelocity: .zero))
                        back.addAnimations { self.cover.transform = .identity; self.cover.alpha = 1 }
                        back.startAnimation()
                    }
                    cover.transform = CGAffineTransform(translationX: direction * size * 1.2, y: 0)
                    cover.layer.add(out, forKey: "out")
                    CATransaction.commit()
                } else {
                    let back = UIViewPropertyAnimator(duration: 0, timingParameters: UISpringTimingParameters(mass: 1, stiffness: 260, damping: 18, initialVelocity: .zero))
                    back.addAnimations { self.cover.transform = .identity; self.cover.alpha = 1 }
                    back.startAnimation()
                }
            } else if pan.state == .ended && (move.y > 90 || speed.y > 900) {
                dismiss(animated: true)
            }
            swipeAxis = 0
        default:
            break
        }
    }

    // MARK: The cover behind

    @objc private func coverArrived(_ note: Notification) {
        guard let id = note.object as? String, let track = player.current, track.id == id else { return }
        backdropTrack = ""
        paintBackdrop(track)
    }

    private static let blurContext = CIContext(options: nil)

    /// The cover, blurred as with `blurRadius={70}` across the page (worked on a small copy).
    private func paintBackdrop(_ track: MusicTrack) {
        let picture = MusicCovers.image(track)
        let mark = track.id + (picture == nil ? "" : "+")
        if mark == backdropTrack { return }
        backdropTrack = mark
        guard let picture else {
            backdrop.image = nil
            backdrop.isHidden = true
            veil.isHidden = true
            ambient.isHidden = false
            return
        }
        ambient.isHidden = true
        backdrop.isHidden = false
        veil.isHidden = false
        backdrop.image = PlayerViewController.blurred(picture, pageWidth: max(view.bounds.width, 320)) ?? picture
    }

    private static func blurred(_ picture: UIImage, pageWidth: CGFloat) -> UIImage? {
        let side: CGFloat = 160
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { (_: UIGraphicsImageRendererContext) -> Void in
            picture.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        guard let input = CIImage(image: small), let filter = CIFilter(name: "CIGaussianBlur") else { return nil }
        filter.setValue(input.clampedToExtent(), forKey: kCIInputImageKey)
        filter.setValue(Double(70 * side / pageWidth), forKey: kCIInputRadiusKey)
        guard let output = filter.outputImage?.cropped(to: input.extent), let made = blurContext.createCGImage(output, from: input.extent) else { return nil }
        return UIImage(cgImage: made)
    }
}

/// The seek line (PlayerControls.tsx `SeekBar`): a 5 pt line (7 while dragged), radius 5, in the border colour with
/// the accent part; a 12 pt knob in the accent with a 2 pt edge of `glassOpaque`; the times (12, even digits) 4 pt
/// over the lower part of its 44 pt row.
final class PlayerSeekView: UIView {
    var onSeek: ((Double) -> Void)?
    private let line = UIView()
    private let done = UIView()
    private let knob = UIView()
    private let elapsed = UILabel()
    private let total = UILabel()
    private var position = 0.0
    private var duration = 0.0
    private var drag: Double?

    var height: CGFloat { return 44 - 4 + ceil(PlayerSeekView.timeFont.lineHeight) }

    private static var timeFont: UIFont {
        let even = UIFont.systemFont(ofSize: 12).fontDescriptor.addingAttributes([.featureSettings: [[UIFontDescriptor.FeatureKey.type: kNumberSpacingType, UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector]]])
        return UIFont(descriptor: even, size: 12)
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        line.backgroundColor = ThemeStore.look.border
        line.clipsToBounds = true
        addSubview(line)
        done.backgroundColor = Theme.accent
        line.addSubview(done)
        knob.backgroundColor = Theme.accent
        knob.layer.cornerRadius = 6
        knob.layer.borderWidth = 2
        knob.layer.borderColor = ThemeStore.look.glassOpaque.cgColor
        knob.isUserInteractionEnabled = false
        addSubview(knob)
        for label in [elapsed, total] {
            label.font = PlayerSeekView.timeFont
            label.textColor = Theme.muted
            addSubview(label)
        }
        total.textAlignment = .right
        isAccessibilityElement = true
        accessibilityTraits = .adjustable
        accessibilityLabel = "Позиция воспроизведения"
        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0
        addGestureRecognizer(press)
    }

    required init?(coder: NSCoder) { return nil }

    func show(position: Double, duration: Double) {
        self.position = position
        self.duration = duration
        paint()
    }

    private func paint() {
        let shown = drag ?? position
        elapsed.text = MusicCatalog.time(shown)
        total.text = duration > 0 ? MusicCatalog.time(duration) : "—:—"
        knob.alpha = duration > 0 ? 1 : 0.35
        accessibilityValue = MusicCatalog.time(shown) + " из " + (duration > 0 ? MusicCatalog.time(duration) : "неизвестной длительности")
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        let shown = drag ?? position
        let ratio = duration > 0 ? CGFloat(min(1, max(0, shown / duration))) : 0
        let thick: CGFloat = drag != nil ? 7 : 5
        line.frame = CGRect(x: 0, y: (44 - thick) / 2, width: width, height: thick)
        line.layer.cornerRadius = 5
        done.frame = CGRect(x: 0, y: 0, width: width * ratio, height: thick)
        done.layer.cornerRadius = 5
        knob.frame = CGRect(x: max(0, min(max(0, width - 12), ratio * width - 6)), y: 16, width: 12, height: 12)
        let lineHeight = ceil(PlayerSeekView.timeFont.lineHeight)
        elapsed.frame = CGRect(x: 0, y: 40, width: width / 2, height: lineHeight)
        total.frame = CGRect(x: width / 2, y: 40, width: width / 2, height: lineHeight)
    }

    @objc private func pressed(_ press: UILongPressGestureRecognizer) {
        guard duration > 0, bounds.width > 0 else { return }
        let x = max(0, min(bounds.width, press.location(in: self).x))
        switch press.state {
        case .began, .changed:
            drag = Double(x / bounds.width) * duration
            paint()
        case .ended:
            if let value = drag { onSeek?(value) }
            drag = nil
            paint()
        default:
            drag = nil
            paint()
        }
    }

    override func accessibilityIncrement() { onSeek?(position + 10) }
    override func accessibilityDecrement() { onSeek?(max(0, position - 10)) }
}

/// One track of the queue panel: minHeight 56, 8 inside, 11 apart, radius 12, the soft accent when it is the one
/// playing (or pressed); the cover 44, the title 15 semibold, the artist 13, `volume-medium-outline` / `pause-outline` 17.
final class PlayerQueueRow: UIControl {
    private let current: Bool

    init(item: MusicTrack, current: Bool, playing: Bool) {
        self.current = current
        super.init(frame: .zero)
        layer.cornerRadius = 12
        layer.cornerCurve = .continuous
        backgroundColor = current ? ThemeStore.look.accentSoft : .clear
        let art = MusicCoverView(radius: 12, look: .artwork)
        art.bind(item)
        let title = UILabel()
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = Theme.text
        title.text = item.title
        let artist = UILabel()
        artist.font = .systemFont(ofSize: 13)
        artist.textColor = Theme.muted
        artist.text = item.artist
        let words = UIStackView(arrangedSubviews: [title, artist])
        words.axis = .vertical
        words.spacing = 2
        let row = UIStackView(arrangedSubviews: [art, words])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 11
        row.isUserInteractionEnabled = false
        if current {
            let mark = UIImageView(image: IonIcon.image(playing ? "volume-medium-outline" : "pause-outline", size: 17))
            mark.tintColor = Theme.accent
            row.addArrangedSubview(mark)
        }
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            art.widthAnchor.constraint(equalToConstant: 44), art.heightAnchor.constraint(equalToConstant: 44),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8), row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
            row.topAnchor.constraint(greaterThanOrEqualTo: topAnchor), row.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
        ])
        isAccessibilityElement = true
        accessibilityTraits = current ? [.button, .selected] : .button
        accessibilityLabel = "Включить: \(item.title), \(item.artist)"
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted || current ? ThemeStore.look.accentSoft : .clear }
    }
}
