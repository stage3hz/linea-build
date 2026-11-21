import CoreImage
import UIKit

/// The full player: the cover across the width, the title with «в любимое», the seek line, the controls and
/// the queue. After mobile/src/music/PlayerControls.tsx.
final class PlayerViewController: UIViewController {
    private let player = MusicPlayer.shared
    private let cover = MusicCoverView(radius: 16)
    private let kicker = AIKit.label("", size: 12, weight: .semibold, color: Theme.muted, lines: 1, align: .center)
    private let heading = AIKit.label("", size: 22, weight: .bold, lines: 2)
    private let artist = AIKit.label("", size: 15, color: Theme.muted, lines: 1)
    private let origin = AIKit.label("", size: 10, weight: .bold, color: Theme.subtle, lines: 1)
    private let heart = UIButton(type: .system)
    private let extra = UIButton(type: .system)
    private let shuffleChip = UIButton(type: .system)
    private let heartChip = UIButton(type: .system)
    /// «Эквалайзер» (Music/EqualizerViewController.swift).
    private let equalizerChip = UIButton(type: .system)
    /// The page takes the colour of the cover (blurred, under a veil); without a cover, the music «эмбиент».
    private let backdrop = UIImageView()
    private let veil = UIView()
    private let ambient = MusicAmbientView(tone: MusicAmbientView.themeTone, custom: MusicAmbientView.themeCustom)
    private var backdropTrack = ""
    private let slider = UISlider()
    private let elapsed = AIKit.label("0:00", size: 11, color: Theme.muted, lines: 1)
    private let total = AIKit.label("—:—", size: 11, color: Theme.muted, lines: 1, align: .right)
    private let repeatButton = UIButton(type: .system)
    private let backButton = UIButton(type: .system)
    private let playButton = UIButton(type: .system)
    private let forwardButton = UIButton(type: .system)
    private let waiting = UIActivityIndicatorView(style: .medium)
    private let message = AIKit.label("", size: 13, color: Theme.danger)
    private let queueButton = UIButton(type: .system)
    private let lyricsButton = UIButton(type: .system)
    private let queueList = UIStackView()
    private var showQueue = false
    private var queueMark = ""
    private var dragging = false

    init() {
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
    }

    required init?(coder: NSCoder) { return nil }

    private func symbol(_ button: UIButton, _ name: String, size: CGFloat, weight: UIImage.SymbolWeight = .semibold) {
        button.setImage(UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: weight)), for: .normal)
    }

    private func chip(_ button: UIButton, _ words: String, _ name: String, on: Bool) {
        var config = UIButton.Configuration.filled()
        config.title = words
        config.image = UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium))
        config.imagePadding = 6
        config.cornerStyle = .capsule
        config.baseBackgroundColor = on ? Theme.text : Theme.veil(0.08)
        config.baseForegroundColor = on ? Theme.onAccent : Theme.text
        config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)
        // One line, as the reference: the wider Montserrat made the words break inside the chip.
        config.titleLineBreakMode = .byTruncatingTail
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { (incoming: AttributeContainer) -> AttributeContainer in
            var out = incoming
            out.font = Theme.font(13, .semibold)
            return out
        }
        button.configuration = config
        button.titleLabel?.numberOfLines = 1
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.page(UIColor(hex: 0x101112))
        // Like the reference: the blurred cover under a veil that keeps the theme's text readable, else the ambient.
        for part in [ambient, backdrop, veil] as [UIView] {
            part.frame = view.bounds
            part.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            part.isUserInteractionEnabled = false
            view.addSubview(part)
        }
        backdrop.contentMode = .scaleAspectFill
        backdrop.clipsToBounds = true
        backdrop.transform = CGAffineTransform(scaleX: 1.3, y: 1.3)
        // COVER_VEIL: black .68 on dark themes, white .82 on light ones.
        veil.backgroundColor = Theme.dark ? UIColor(white: 0, alpha: 0.68) : UIColor(white: 1, alpha: 0.82)
        NotificationCenter.default.addObserver(self, selector: #selector(coverArrived(_:)), name: MusicCovers.ready, object: nil)
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 16
        column.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(column)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor), scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 22), column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -28),
            column.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 24), column.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -24),
        ])

        let fold = UIButton(type: .system)
        symbol(fold, "chevron.down", size: 17)
        fold.tintColor = Theme.text
        fold.accessibilityLabel = "Свернуть плеер"
        fold.addTarget(self, action: #selector(foldAway), for: .touchUpInside)
        let shut = UIButton(type: .system)
        symbol(shut, "xmark", size: 16)
        shut.tintColor = Theme.muted
        shut.accessibilityLabel = "Закрыть плеер и остановить музыку"
        shut.addTarget(self, action: #selector(stopAll), for: .touchUpInside)
        [fold, shut].forEach { $0.widthAnchor.constraint(equalToConstant: 40).isActive = true }
        let top = UIStackView(arrangedSubviews: [fold, kicker, shut])
        top.axis = .horizontal
        top.alignment = .center
        column.addArrangedSubview(top)

        let coverBox = UIView()
        cover.translatesAutoresizingMaskIntoConstraints = false
        coverBox.addSubview(cover)
        let wide = cover.widthAnchor.constraint(equalTo: coverBox.widthAnchor)
        wide.priority = .defaultHigh
        NSLayoutConstraint.activate([
            cover.topAnchor.constraint(equalTo: coverBox.topAnchor), cover.bottomAnchor.constraint(equalTo: coverBox.bottomAnchor),
            cover.centerXAnchor.constraint(equalTo: coverBox.centerXAnchor), cover.heightAnchor.constraint(equalTo: cover.widthAnchor),
            cover.widthAnchor.constraint(lessThanOrEqualToConstant: 340), wide,
        ])
        column.addArrangedSubview(coverBox)

        symbol(heart, "heart", size: 20)
        heart.addTarget(self, action: #selector(like), for: .touchUpInside)
        symbol(extra, "ellipsis", size: 18)
        extra.tintColor = Theme.text
        extra.accessibilityLabel = "Ещё"
        extra.showsMenuAsPrimaryAction = true
        [heart, extra].forEach { $0.widthAnchor.constraint(equalToConstant: 40).isActive = true }
        let words = UIStackView(arrangedSubviews: [origin, heading, artist])
        words.axis = .vertical
        words.spacing = 4
        let titleRow = UIStackView(arrangedSubviews: [words, heart, extra])
        titleRow.axis = .horizontal
        titleRow.alignment = .center
        titleRow.spacing = 4
        column.addArrangedSubview(titleRow)

        shuffleChip.addTarget(self, action: #selector(mixUp), for: .touchUpInside)
        heartChip.addTarget(self, action: #selector(like), for: .touchUpInside)
        equalizerChip.addTarget(self, action: #selector(openEqualizer), for: .touchUpInside)
        let chips = UIStackView(arrangedSubviews: [heartChip, shuffleChip, equalizerChip, UIView()])
        chips.axis = .horizontal
        chips.spacing = 8
        column.addArrangedSubview(chips)

        slider.minimumTrackTintColor = Theme.text
        slider.maximumTrackTintColor = Theme.veil(0.16)
        slider.accessibilityLabel = "Позиция воспроизведения"
        slider.addTarget(self, action: #selector(dragBegan), for: .touchDown)
        slider.addTarget(self, action: #selector(dragMoved), for: .valueChanged)
        slider.addTarget(self, action: #selector(dragEnded), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        let times = UIStackView(arrangedSubviews: [elapsed, total])
        times.axis = .horizontal
        times.distribution = .fillEqually
        let seek = UIStackView(arrangedSubviews: [slider, times])
        seek.axis = .vertical
        seek.spacing = 2
        column.addArrangedSubview(seek)

        repeatButton.addTarget(self, action: #selector(cycleRepeat), for: .touchUpInside)
        symbol(backButton, "backward.end.fill", size: 26)
        backButton.tintColor = Theme.text
        backButton.accessibilityLabel = "Предыдущий трек или начало текущего"
        backButton.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        playButton.backgroundColor = Theme.onBlack(.white, otherwise: Theme.accent)
        playButton.tintColor = Theme.onAccent
        playButton.layer.cornerRadius = 36
        playButton.widthAnchor.constraint(equalToConstant: 72).isActive = true
        playButton.heightAnchor.constraint(equalToConstant: 72).isActive = true
        playButton.addTarget(self, action: #selector(flip), for: .touchUpInside)
        symbol(forwardButton, "forward.end.fill", size: 26)
        forwardButton.tintColor = Theme.text
        forwardButton.accessibilityLabel = "Следующий трек"
        forwardButton.addTarget(self, action: #selector(goForward), for: .touchUpInside)
        waiting.color = Theme.muted
        waiting.hidesWhenStopped = false
        let controls = UIStackView(arrangedSubviews: [repeatButton, backButton, playButton, forwardButton, waiting])
        controls.axis = .horizontal
        controls.alignment = .center
        controls.distribution = .equalCentering
        column.addArrangedSubview(controls)
        column.addArrangedSubview(message)

        queueButton.addTarget(self, action: #selector(toggleQueue), for: .touchUpInside)
        lyricsButton.setTitle("Текст", for: .normal)
        lyricsButton.addTarget(self, action: #selector(lyrics), for: .touchUpInside)
        [queueButton, lyricsButton].forEach {
            $0.tintColor = Theme.text
            $0.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        }
        let panel = UIStackView(arrangedSubviews: [queueButton, lyricsButton])
        panel.axis = .horizontal
        panel.distribution = .fillEqually
        panel.backgroundColor = Theme.veil(0.06)
        panel.layer.cornerRadius = 16
        panel.heightAnchor.constraint(equalToConstant: 48).isActive = true
        column.addArrangedSubview(panel)
        queueList.axis = .vertical
        queueList.spacing = 2
        column.addArrangedSubview(queueList)

        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: MusicPlayer.changed, object: nil)
        refresh()
    }

    @objc private func refresh() {
        guard isViewLoaded else { return }
        guard let track = player.current else {
            if presentingViewController != nil, !isBeingDismissed { dismiss(animated: true) }
            return
        }
        let favorite = player.isFavorite(track)
        cover.bind(track)
        kicker.text = track.source == "local" ? "Мои файлы" : "Сейчас играет"
        heading.text = track.title
        artist.text = track.artist
        origin.text = track.source == "audius" ? "AUDIUS · ОНЛАЙН" : (track.source == "soundcloud" ? "SOUNDCLOUD" : "НА ЭТОМ УСТРОЙСТВЕ")
        symbol(heart, favorite ? "heart.fill" : "heart", size: 20)
        heart.tintColor = favorite ? Theme.text : Theme.muted
        heart.accessibilityLabel = favorite ? "Убрать из избранного" : "Добавить в избранное"
        chip(shuffleChip, player.shuffle ? "Перемешано" : "Перемешать", "shuffle", on: player.shuffle)
        shuffleChip.accessibilityLabel = player.shuffle ? "Случайный порядок включён" : "Включить случайный порядок"
        chip(heartChip, favorite ? "В любимом" : "В любимое", favorite ? "heart.fill" : "heart", on: false)
        chip(equalizerChip, "Эквалайзер", "slider.horizontal.3", on: false)
        paintBackdrop(track)
        var actions: [UIMenuElement] = []
        if let address = track.sourceUrl, let url = URL(string: address), url.scheme?.lowercased() == "https" {
            actions.append(UIAction(title: track.source == "soundcloud" ? "Открыть в SoundCloud" : "Открыть страницу трека", image: UIImage(systemName: "arrow.up.right.square")) { _ in UIApplication.shared.open(url) })
        }
        actions.append(UIAction(title: favorite ? "Убрать из любимого" : "В любимое", image: UIImage(systemName: favorite ? "heart.fill" : "heart")) { _ in MusicPlayer.shared.toggleFavorite(track) })
        extra.menu = UIMenu(title: track.title, children: actions)

        let length = player.duration
        if !dragging {
            slider.maximumValue = Float(max(1, length))
            slider.value = Float(min(player.position, max(1, length)))
            elapsed.text = MusicCatalog.time(player.position)
        }
        slider.isEnabled = length > 0
        total.text = length > 0 ? MusicCatalog.time(length) : "—:—"
        slider.accessibilityValue = MusicCatalog.time(player.position) + " из " + (length > 0 ? MusicCatalog.time(length) : "неизвестной длительности")

        symbol(repeatButton, player.repeatMode == "one" ? "repeat.1" : "repeat", size: 20)
        repeatButton.tintColor = player.repeatMode == "off" ? Theme.muted : Theme.text
        repeatButton.accessibilityLabel = player.repeatMode == "one" ? "Повтор одного трека" : (player.repeatMode == "all" ? "Повтор очереди" : "Повтор выключен")
        symbol(playButton, player.playing ? "pause.fill" : "play.fill", size: 28, weight: .bold)
        playButton.accessibilityLabel = player.loading ? "Загрузка. Повторить воспроизведение" : (player.playing ? "Приостановить" : "Воспроизвести")
        forwardButton.isEnabled = player.queue.count >= 2
        if player.loading { waiting.startAnimating() } else { waiting.stopAnimating() }
        waiting.alpha = player.loading ? 1 : 0
        message.text = player.error
        message.isHidden = player.error.isEmpty

        queueButton.setTitle("Очередь · \(player.queue.count)", for: .normal)
        queueButton.accessibilityLabel = showQueue ? "Свернуть очередь" : "Показать очередь"
        let mark = (showQueue ? "1" : "0") + track.id + player.queue.map { $0.id }.joined(separator: ",")
        if mark != queueMark {
            queueMark = mark
            queueList.arrangedSubviews.forEach { $0.removeFromSuperview() }
            if showQueue {
                for item in player.queue.prefix(100) {
                    var config = UIButton.Configuration.plain()
                    let on = item.id == track.id
                    config.attributedTitle = AttributedString(item.title, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 15, weight: on ? .bold : .regular)]))
                    config.attributedSubtitle = AttributedString(item.artist, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 12), .foregroundColor: Theme.muted]))
                    config.image = UIImage(systemName: on ? "speaker.wave.2.fill" : "music.note", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .regular))
                    config.imagePadding = 12
                    config.baseForegroundColor = Theme.text
                    config.titleLineBreakMode = .byTruncatingTail
                    config.contentInsets = NSDirectionalEdgeInsets(top: 9, leading: 6, bottom: 9, trailing: 6)
                    let row = UIButton(configuration: config)
                    row.contentHorizontalAlignment = .leading
                    row.accessibilityLabel = "Включить: \(item.title), \(item.artist)"
                    row.addAction(UIAction { _ in MusicPlayer.shared.play(item, queue: MusicPlayer.shared.queue) }, for: .touchUpInside)
                    queueList.addArrangedSubview(row)
                }
            }
        }
    }

    @objc private func openEqualizer() {
        guard presentedViewController == nil else { return }
        present(EqualizerViewController(), animated: true)
    }

    @objc private func coverArrived(_ note: Notification) {
        guard let id = note.object as? String, let track = player.current, track.id == id else { return }
        backdropTrack = ""
        paintBackdrop(track)
    }

    private static let blurContext = CIContext(options: nil)

    /// The cover, blurred as with a radius of 70 pt across the page (worked on a small copy).
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

    @objc private func foldAway() { dismiss(animated: true) }
    @objc private func stopAll() { player.stop() }
    @objc private func like() { if let track = player.current { player.toggleFavorite(track) } }
    @objc private func mixUp() { player.toggleShuffle() }
    @objc private func cycleRepeat() { player.toggleRepeat() }
    @objc private func goBack() { player.previous() }
    @objc private func goForward() { player.next() }
    @objc private func flip() { player.togglePlayback() }
    @objc private func dragBegan() { dragging = true }
    @objc private func dragMoved() { elapsed.text = MusicCatalog.time(Double(slider.value)) }
    @objc private func dragEnded() {
        dragging = false
        player.seek(Double(slider.value))
    }

    @objc private func toggleQueue() {
        showQueue.toggle()
        refresh()
    }

    @objc private func lyrics() {
        let alert = UIAlertController(title: "Текста пока нет", message: "Каталог Audius не передаёт тексты песен, поэтому показать текст этого трека нельзя.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
        present(alert, animated: true)
    }
}
