import AVFoundation
import ImageIO
import Photos
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// The paperclip's own panel (the reference's attachments/AttachmentPanel.tsx, GalleryPane.tsx, useGallery.ts,
/// gallery.ts and selection.ts): a sheet over half the screen that a pull on its handle raises to almost the whole
/// screen or closes; «Недавние» — the gallery as a grid of four with the camera first —, «Файл», «Опрос», «Аудио»;
/// what was chosen in a strip with its numbers, «Изменить» on a photo (the editor), «Добавить · N».
///
/// The photo library is read only once the person opens this panel (the system asks then, never earlier), with
/// the limited-library flow as the reference: «Показаны только разрешённые фото и видео.» and «Добавить доступ».
/// The grid asks the library for small pictures only; an original is read when it is edited or added. Nothing is
/// sent from here: what is added goes to `onSend`, and the chat cleans, seals and uploads it as any attachment.
final class AttachmentPanelController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout, PHPhotoLibraryChangeObserver,
                                       UIDocumentPickerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate, PHPickerViewControllerDelegate {
    /// What the chat receives. A file or video URL is a copy in the app's own temporary folder; the chat removes it.
    enum Picked {
        case photo(Data, format: String?)
        case video(URL)
        case file(URL)
    }

    /// One chosen thing (the reference's AttachmentSelection).
    final class Item {
        let id: String
        /// photo · video · audio · file
        let kind: String
        let name: String
        let asset: PHAsset?
        var data: Data?
        var url: URL?
        var thumb: UIImage?
        let duration: TimeInterval
        /// The URL belongs to someone else (a track of «Моя музыка»): copied, never removed.
        let borrowed: Bool

        init(id: String, kind: String, name: String, asset: PHAsset? = nil, data: Data? = nil, url: URL? = nil, thumb: UIImage? = nil, duration: TimeInterval = 0, borrowed: Bool = false) {
            self.id = id
            self.kind = kind
            self.name = name
            self.asset = asset
            self.data = data
            self.url = url
            self.thumb = thumb
            self.duration = duration
            self.borrowed = borrowed
        }
    }

    /// The reference's MAX_DRAFT_ATTACHMENTS.
    static let limit = 100

    var onSend: (([Picked]) -> Void)?
    var onPoll: (() -> Void)?
    private let pollAvailable: Bool

    private var tab = "gallery"
    private var selected: [Item] = []
    /// picking · opening · adding
    private var phase = ""
    private var errorWords = ""
    private var notice = ""

    // The gallery.
    private var status: PHAuthorizationStatus = .notDetermined
    private var asked = false
    private var assets: PHFetchResult<PHAsset>?
    private let images = PHCachingImageManager()
    private var observing = false
    private var sampleItems: [Item] = []
    private var samples = false

    // The sheet.
    private let backdrop = UIControl()
    private let sheet = UIView()
    private let handleArea = UIView()
    private let handle = UIView()
    private let closeButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let content = UIView()
    private let limitedRow = UIView()
    private let limitedLabel = UILabel()
    private let limitedButton = UIButton(type: .system)
    private let grid: UICollectionView
    private let emptyView = UIStackView()
    private let emptyIcon = UIImageView()
    private let emptyLabel = UILabel()
    private let deniedView = UIScrollView()
    private let audioView = UIScrollView()
    private let filesView = UIScrollView()
    private let strip = UIScrollView()
    private let errorLabel = UILabel()
    private let fallbackButton = UIButton(type: .system)
    private let phaseRow = UIView()
    private let phaseSpinner = UIActivityIndicatorView(style: .medium)
    private let phaseIcon = UIImageView()
    private let phaseLabel = UILabel()
    private let addButton = UIButton(type: .custom)
    private let addSpinner = UIActivityIndicatorView(style: .medium)
    private let tabsBar = UIView()
    private var tabButtons: [UIButton] = []
    private let footLabel = UILabel()
    private let footVideoLabel = UILabel()

    private var sheetHeight: CGFloat = 0
    private var dragStart: CGFloat = 0
    private var opened = false
    private var closing = false

    init(pollAvailable: Bool) {
        self.pollAvailable = pollAvailable
        let layout = UICollectionViewFlowLayout()
        layout.minimumInteritemSpacing = 0
        layout.minimumLineSpacing = 0
        grid = UICollectionView(frame: .zero, collectionViewLayout: layout)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    }

    private static var glassOpaque: UIColor {
        let look = ThemeStore.look
        return UIColor(hex: look.black ? 0x0F1011 : look.dark ? 0x17243A : 0xF6F8FD)
    }

    // MARK: Building

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let look = ThemeStore.look
        backdrop.backgroundColor = look.black ? UIColor(white: 0, alpha: 0.4) : look.dark ? UIColor(red: 0, green: 5 / 255, blue: 19 / 255, alpha: 0.3) : UIColor(red: 43 / 255, green: 63 / 255, blue: 103 / 255, alpha: 0.12)
        backdrop.accessibilityLabel = "Закрыть выбор вложений"
        backdrop.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        backdrop.alpha = 0
        view.addSubview(backdrop)

        sheet.backgroundColor = AttachmentPanelController.glassOpaque
        sheet.layer.cornerRadius = 28
        sheet.layer.cornerCurve = .continuous
        sheet.layer.borderWidth = 1 / max(1, traitCollection.displayScale)
        sheet.layer.borderColor = look.border.cgColor
        sheet.clipsToBounds = true
        view.addSubview(sheet)

        sheet.addSubview(handleArea)
        handle.backgroundColor = Theme.subtle.withAlphaComponent(0.45)
        handle.layer.cornerRadius = 2
        handleArea.addSubview(handle)
        closeButton.setImage(chatSymbol("xmark", 15, .semibold), for: .normal)
        closeButton.tintColor = Theme.text
        closeButton.backgroundColor = Theme.surface2
        closeButton.layer.cornerRadius = 18
        closeButton.accessibilityLabel = "Закрыть выбор вложений"
        closeButton.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        handleArea.addSubview(closeButton)
        titleLabel.font = .systemFont(ofSize: 16, weight: .bold)
        titleLabel.textColor = Theme.text
        titleLabel.textAlignment = .center
        handleArea.addSubview(titleLabel)
        handleArea.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(dragged(_:))))

        sheet.addSubview(content)
        limitedLabel.text = "Показаны только разрешённые фото и видео."
        limitedLabel.font = .systemFont(ofSize: 11)
        limitedLabel.textColor = Theme.muted
        limitedLabel.numberOfLines = 2
        limitedRow.addSubview(limitedLabel)
        limitedButton.setTitle("Добавить доступ", for: .normal)
        limitedButton.titleLabel?.font = .systemFont(ofSize: 12, weight: .semibold)
        limitedButton.setTitleColor(Theme.accent, for: .normal)
        limitedButton.addTarget(self, action: #selector(addAccess), for: .touchUpInside)
        limitedRow.addSubview(limitedButton)
        limitedRow.isHidden = true
        content.addSubview(limitedRow)

        grid.backgroundColor = .clear
        grid.showsVerticalScrollIndicator = false
        grid.alwaysBounceVertical = true
        grid.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: 72, right: 0)
        grid.register(GalleryCell.self, forCellWithReuseIdentifier: "media")
        grid.register(CameraCell.self, forCellWithReuseIdentifier: "camera")
        grid.dataSource = self
        grid.delegate = self
        content.addSubview(grid)

        emptyView.axis = .vertical
        emptyView.alignment = .center
        emptyView.spacing = 12
        emptyIcon.image = chatSymbol("photo.on.rectangle", 32)
        emptyIcon.tintColor = Theme.subtle
        emptyLabel.font = .systemFont(ofSize: 12)
        emptyLabel.textColor = Theme.muted
        emptyLabel.textAlignment = .center
        emptyLabel.numberOfLines = 0
        emptyView.addArrangedSubview(emptyIcon)
        emptyView.addArrangedSubview(emptyLabel)
        emptyView.isHidden = true
        emptyView.isUserInteractionEnabled = false
        content.addSubview(emptyView)

        buildDenied()
        buildAudio()
        buildFiles()

        strip.showsHorizontalScrollIndicator = false
        sheet.addSubview(strip)
        errorLabel.font = .systemFont(ofSize: 13)
        errorLabel.textColor = Theme.danger
        errorLabel.numberOfLines = 3
        sheet.addSubview(errorLabel)
        styleSecondary(fallbackButton, "Системный выбор фото и видео")
        fallbackButton.addTarget(self, action: #selector(systemGallery), for: .touchUpInside)
        sheet.addSubview(fallbackButton)
        phaseSpinner.color = Theme.accent
        phaseRow.addSubview(phaseSpinner)
        phaseIcon.image = chatSymbol("checkmark.circle.fill", 15)
        phaseIcon.tintColor = Theme.accent
        phaseRow.addSubview(phaseIcon)
        phaseLabel.font = .systemFont(ofSize: 11)
        phaseLabel.textColor = Theme.muted
        phaseLabel.numberOfLines = 2
        phaseRow.addSubview(phaseLabel)
        sheet.addSubview(phaseRow)
        addButton.backgroundColor = Theme.accent
        addButton.layer.cornerRadius = 24
        addButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        addButton.setTitleColor(Theme.onAccent, for: .normal)
        addButton.setImage(chatSymbol("arrow.up", 15, .semibold), for: .normal)
        addButton.tintColor = Theme.onAccent
        addButton.addTarget(self, action: #selector(addSelected), for: .touchUpInside)
        sheet.addSubview(addButton)
        addSpinner.color = Theme.onAccent
        addSpinner.hidesWhenStopped = true
        addButton.addSubview(addSpinner)

        tabsBar.backgroundColor = Theme.surface2
        tabsBar.layer.cornerRadius = 30
        tabsBar.layer.borderWidth = 1
        tabsBar.layer.borderColor = look.border.cgColor
        sheet.addSubview(tabsBar)
        var tabs: [(String, String, String)] = [("gallery", "Галерея", "photo.on.rectangle.angled"), ("files", "Файл", "doc.fill")]
        if pollAvailable { tabs.append(("poll", "Опрос", "chart.bar.fill")) }
        tabs.append(("audio", "Аудио", "music.note.list"))
        for item in tabs {
            let button = UIButton(type: .custom)
            button.accessibilityIdentifier = item.0
            var config = UIButton.Configuration.plain()
            config.image = chatSymbol(item.2, 19)
            config.imagePlacement = .top
            config.imagePadding = 3
            config.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: 8, bottom: 7, trailing: 8)
            config.attributedTitle = AttributedString(item.1, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 11, weight: .semibold)]))
            button.configuration = config
            button.layer.cornerRadius = 24
            button.accessibilityLabel = item.1
            button.addTarget(self, action: #selector(tabTapped(_:)), for: .touchUpInside)
            tabsBar.addSubview(button)
            tabButtons.append(button)
        }
        for label in [footLabel, footVideoLabel] {
            label.font = .systemFont(ofSize: 10)
            label.textColor = Theme.muted
            label.textAlignment = .center
            label.numberOfLines = 0
            sheet.addSubview(label)
        }
        footLabel.text = "Несколько фото и видео отправятся одним альбомом."
        footVideoLabel.text = "Видео из галереи — оригинал. Изменения монтажа и скорости из приложения «Фото» не переносятся; оригинал из iCloud загрузится после подтверждения."

        NotificationCenter.default.addObserver(self, selector: #selector(cameBack), name: UIApplication.willEnterForegroundNotification, object: nil)
        refreshAll()
        startGallery()
    }

    private func styleSecondary(_ button: UIButton, _ words: String, symbol: String? = nil) {
        var config = UIButton.Configuration.filled()
        config.baseBackgroundColor = Theme.surface2
        config.baseForegroundColor = Theme.text
        config.cornerStyle = .capsule
        config.attributedTitle = AttributedString(words, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 15, weight: .semibold)]))
        if let symbol {
            config.image = chatSymbol(symbol, 16)
            config.imagePadding = 8
        }
        config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
        button.configuration = config
    }

    private func primary(_ button: UIButton, _ words: String) {
        var config = UIButton.Configuration.filled()
        config.baseBackgroundColor = Theme.accent
        config.baseForegroundColor = Theme.onAccent
        config.cornerStyle = .capsule
        config.attributedTitle = AttributedString(words, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 15, weight: .semibold)]))
        config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
        button.configuration = config
    }

    private func help(_ words: String, size: CGFloat = 12) -> UILabel {
        let label = UILabel()
        label.font = .systemFont(ofSize: size)
        label.textColor = Theme.muted
        label.numberOfLines = 0
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 18
        label.attributedText = NSAttributedString(string: words, attributes: [.paragraphStyle: paragraph, .font: UIFont.systemFont(ofSize: size), .foregroundColor: Theme.muted])
        return label
    }

    /// A vertical stack inside a scroll view, padded as the reference's ScrollView content.
    private func stack(in scroll: UIScrollView, padding: CGFloat, spacing: CGFloat) -> UIStackView {
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = spacing
        column.alignment = .fill
        column.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: padding),
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -padding),
            column.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: padding),
            column.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -padding),
        ])
        return column
    }

    /// «Открой доступ к галерее».
    private func buildDenied() {
        let column = stack(in: deniedView, padding: 18, spacing: 14)
        let icon = UIImageView(image: chatSymbol("photo.on.rectangle", 30))
        icon.tintColor = Theme.accent
        icon.contentMode = .left
        column.addArrangedSubview(icon)
        let heading = UILabel()
        heading.text = "Открой доступ к галерее"
        heading.font = .systemFont(ofSize: 16, weight: .bold)
        heading.textColor = Theme.text
        column.addArrangedSubview(heading)
        column.addArrangedSubview(help("Можно разрешить только выбранные фото и видео. Остальные файлы останутся недоступны приложению."))
        let settings = UIButton(type: .system)
        primary(settings, "Открыть настройки")
        settings.addTarget(self, action: #selector(openSettings), for: .touchUpInside)
        column.addArrangedSubview(settings)
        let system = UIButton(type: .system)
        styleSecondary(system, "Выбрать через системное окно")
        system.addTarget(self, action: #selector(systemGallery), for: .touchUpInside)
        column.addArrangedSubview(system)
        deniedView.isHidden = true
        content.addSubview(deniedView)
    }

    private var audioColumn: UIStackView?

    /// «Аудио»: a file of the device, or a track imported into «Музыка».
    private func buildAudio() {
        let column = stack(in: audioView, padding: 7, spacing: 12)
        audioColumn = column
        audioView.isHidden = true
        content.addSubview(audioView)
        fillAudio()
    }

    private func fillAudio() {
        guard let column = audioColumn else { return }
        column.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let pick = UIButton(type: .system)
        styleSecondary(pick, "Выбрать аудио на устройстве", symbol: "music.note.list")
        pick.isEnabled = phase.isEmpty
        pick.addTarget(self, action: #selector(pickAudio), for: .touchUpInside)
        column.addArrangedSubview(pick)
        column.addArrangedSubview(help("Прикрепи локальный аудиофайл или трек, который ты импортировал в музыку."))
        let tracks = localTracks
        if tracks.isEmpty {
            let empty = UIStackView()
            empty.axis = .vertical
            empty.alignment = .center
            empty.spacing = 10
            empty.isLayoutMarginsRelativeArrangement = true
            empty.layoutMargins = UIEdgeInsets(top: 16, left: 0, bottom: 16, right: 0)
            let icon = UIImageView(image: chatSymbol("headphones", 34))
            icon.tintColor = Theme.subtle
            empty.addArrangedSubview(icon)
            empty.addArrangedSubview(help("Импортированных треков пока нет"))
            column.addArrangedSubview(empty)
            return
        }
        let heading = UILabel()
        heading.text = "Из моей музыки"
        heading.font = .systemFont(ofSize: 13, weight: .bold)
        heading.textColor = Theme.text
        column.addArrangedSubview(heading)
        for (index, track) in tracks.enumerated() {
            let id = "music:" + track.id
            let number = (selected.firstIndex(where: { $0.id == id }) ?? -1) + 1
            let row = TrackRow(title: track.title, detail: track.artist + (track.fileSize.map { " · " + FileCore.sizeText($0) } ?? ""), on: number > 0)
            row.tag = index
            row.isEnabled = phase.isEmpty
            row.addTarget(self, action: #selector(trackTapped(_:)), for: .touchUpInside)
            column.addArrangedSubview(row)
        }
    }

    private var localTracks: [MusicTrack] {
        MusicPlayer.shared.saved.filter { (track: MusicTrack) -> Bool in
            guard track.source == "local", let url = MusicPlayer.shared.fileURL(track) else { return false }
            return FileManager.default.fileExists(atPath: url.path)
        }
    }

    /// «Файлы с устройства».
    private func buildFiles() {
        let column = stack(in: filesView, padding: 18, spacing: 15)
        let icon = UIImageView(image: chatSymbol("folder", 34))
        icon.tintColor = Theme.accent
        icon.contentMode = .left
        column.addArrangedSubview(icon)
        let heading = UILabel()
        heading.text = "Файлы с устройства"
        heading.font = .systemFont(ofSize: 17, weight: .bold)
        heading.textColor = Theme.text
        column.addArrangedSubview(heading)
        column.addArrangedSubview(help("Можно выбрать несколько документов, фото, видео или аудиофайлов. Файлы больше 20 МБ отправляются частями; фото и видео любого размера тоже очищаются от личных метаданных."))
        let open = UIButton(type: .system)
        styleSecondary(open, "Открыть файлы", symbol: "doc")
        open.addTarget(self, action: #selector(pickFiles), for: .touchUpInside)
        column.addArrangedSubview(open)
        column.addArrangedSubview(help("Фото и видео проходят очистку личных метаданных даже без редактора. Если устройство не поддерживает формат или сохранение HDR, приложение объяснит причину и остановит отправку."))
        filesView.isHidden = true
        content.addSubview(filesView)
    }

    // MARK: Showing

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard !opened else { return }
        view.layoutIfNeeded()
        sheet.transform = CGAffineTransform(translationX: 0, y: view.bounds.height - sheet.frame.minY)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !opened else { return }
        opened = true
        // The reference: the backdrop fades in 160 ms while the sheet slides up 260 ms.
        UIView.animate(withDuration: 0.16) { () -> Void in self.backdrop.alpha = 1 }
        let slide = UIViewPropertyAnimator(duration: 0.26, controlPoint1: CGPoint(x: 0.2, y: 0.9), controlPoint2: CGPoint(x: 0.25, y: 1)) { () -> Void in
            self.sheet.transform = .identity
        }
        slide.startAnimation()
    }

    private var halfHeight: CGFloat { min(520, max(360, view.bounds.height * 0.56)) }
    private var fullHeight: CGFloat { view.bounds.height - view.safeAreaInsets.top - max(8, view.safeAreaInsets.bottom) - 12 }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if sheetHeight == 0 { sheetHeight = halfHeight }
        let bounds = view.bounds
        backdrop.frame = bounds
        let width = min(600, bounds.width - 16)
        let bottom = bounds.height - max(8, view.safeAreaInsets.bottom)
        let transform = sheet.transform
        sheet.transform = .identity
        sheet.frame = CGRect(x: (bounds.width - width) / 2, y: bottom - sheetHeight, width: width, height: sheetHeight)
        sheet.transform = transform
        layoutSheet()
    }

    private func layoutSheet() {
        let width = sheet.bounds.width, height = sheet.bounds.height
        let inner = width - 16
        handleArea.frame = CGRect(x: 8, y: 8, width: inner, height: 4 + 6 + 36 + 2)
        handle.frame = CGRect(x: (inner - 35) / 2, y: 0, width: 35, height: 4)
        closeButton.frame = CGRect(x: 0, y: 10, width: 36, height: 36)
        titleLabel.frame = CGRect(x: 46, y: 10, width: inner - 92, height: 36)

        // From the bottom up: the notes, the tabs, «Добавить», the phase, the error, the strip.
        var y = height - 8
        for label in [footVideoLabel, footLabel] where !label.isHidden {
            let h = ceil(label.sizeThatFits(CGSize(width: inner - 10, height: 80)).height)
            label.frame = CGRect(x: 13, y: y - h, width: inner - 10, height: h)
            y -= h + 6
        }
        var tabsWidth: CGFloat = 10
        var sizes: [CGFloat] = []
        for button in tabButtons {
            let w = max(72, ceil(button.sizeThatFits(CGSize(width: 140, height: 52)).width))
            sizes.append(w)
            tabsWidth += w + 2
        }
        tabsWidth -= 2
        tabsBar.frame = CGRect(x: (width - tabsWidth) / 2, y: y - 60, width: tabsWidth, height: 60)
        var x: CGFloat = 5
        for (index, button) in tabButtons.enumerated() {
            button.frame = CGRect(x: x, y: 5, width: sizes[index], height: 50)
            x += sizes[index] + 2
        }
        y -= 60 + 6
        if !addButton.isHidden {
            addButton.frame = CGRect(x: 8, y: y - 48, width: inner, height: 48)
            addSpinner.frame = addButton.bounds
            y -= 48 + 6
        }
        if !phaseRow.isHidden {
            phaseRow.frame = CGRect(x: 13, y: y - 30, width: inner - 10, height: 30)
            phaseSpinner.frame = CGRect(x: 0, y: 5, width: 20, height: 20)
            phaseIcon.frame = CGRect(x: 2, y: 7, width: 16, height: 16)
            phaseLabel.frame = CGRect(x: 26, y: 0, width: inner - 36, height: 30)
            y -= 30 + 6
        }
        if !fallbackButton.isHidden {
            fallbackButton.frame = CGRect(x: 13, y: y - 44, width: inner - 10, height: 44)
            y -= 44 + 6
        }
        if !errorLabel.isHidden {
            let h = ceil(errorLabel.sizeThatFits(CGSize(width: inner - 10, height: 80)).height)
            errorLabel.frame = CGRect(x: 13, y: y - h, width: inner - 10, height: h)
            y -= h + 6
        }
        if !strip.isHidden {
            strip.frame = CGRect(x: 8, y: y - 110, width: inner, height: 110)
            y -= 110 + 6
        }
        let top = handleArea.frame.maxY + 6
        content.frame = CGRect(x: 8, y: top, width: inner, height: max(0, y - top))
        var gridTop: CGFloat = 0
        if !limitedRow.isHidden {
            limitedRow.frame = CGRect(x: 0, y: 0, width: inner, height: 40)
            let buttonWidth = ceil(limitedButton.intrinsicContentSize.width) + 20
            limitedButton.frame = CGRect(x: inner - buttonWidth, y: 0, width: buttonWidth, height: 40)
            limitedLabel.frame = CGRect(x: 7, y: 0, width: inner - buttonWidth - 15, height: 40)
            gridTop = 48
        }
        grid.frame = CGRect(x: 0, y: gridTop, width: inner, height: max(0, content.bounds.height - gridTop))
        emptyView.frame = CGRect(x: 20, y: gridTop + max(0, (grid.frame.height - 145) / 2) + (grid.frame.width / 4), width: inner - 40, height: 100)
        deniedView.frame = content.bounds
        audioView.frame = content.bounds
        filesView.frame = content.bounds
        layoutStrip()
    }

    /// Everything that follows the state: the title, the panes, the strip, the buttons, the notes.
    private func refreshAll() {
        let locked = !phase.isEmpty
        if tab == "gallery" {
            titleLabel.text = selected.isEmpty ? "Недавние" : "Выбрано: \(selected.count)"
        } else {
            titleLabel.text = tab == "audio" ? "Аудио" : "Файлы"
        }
        let allowed = samples || status == .authorized || status == .limited
        let denied = !samples && asked && (status == .denied || status == .restricted)
        grid.isHidden = tab != "gallery" || denied
        limitedRow.isHidden = tab != "gallery" || status != .limited
        deniedView.isHidden = tab != "gallery" || !denied
        let count = galleryCount
        emptyView.isHidden = tab != "gallery" || denied || !allowed || count > 0
        emptyLabel.text = "В разрешённой галерее пока нет фото или видео"
        audioView.isHidden = tab != "audio"
        filesView.isHidden = tab != "files"
        if tab == "audio" { fillAudio() }
        for button in tabButtons {
            let on = button.accessibilityIdentifier == tab
            button.backgroundColor = on ? ThemeStore.look.accentSoft : .clear
            var config = button.configuration
            config?.baseForegroundColor = on ? Theme.accent : Theme.text
            button.configuration = config
            button.isEnabled = !locked
            button.accessibilityTraits = on ? [.button, .selected] : .button
        }
        closeButton.isEnabled = phase != "adding"
        closeButton.alpha = closeButton.isEnabled ? 1 : 0.4
        errorLabel.text = errorWords
        errorLabel.isHidden = errorWords.isEmpty
        fallbackButton.isHidden = errorWords.isEmpty || tab != "gallery" || !galleryFailed
        phaseRow.isHidden = phase.isEmpty && notice.isEmpty
        if phase.isEmpty { phaseSpinner.stopAnimating() } else { phaseSpinner.startAnimating() }
        phaseIcon.isHidden = !phase.isEmpty
        phaseLabel.text = !notice.isEmpty ? notice : phase == "opening" ? "Открываем оригинал; файл из iCloud может загружаться…" : phase == "picking" ? "Выбери файлы в системном окне…" : "Обрабатываем, шифруем и добавляем…"
        addButton.isHidden = selected.isEmpty && phase != "adding"
        addButton.setTitle(phase == "adding" ? nil : "  Добавить · \(selected.count)", for: .normal)
        addButton.setImage(phase == "adding" ? nil : chatSymbol("arrow.up", 15, .semibold), for: .normal)
        if phase == "adding" { addSpinner.startAnimating() } else { addSpinner.stopAnimating() }
        addButton.isEnabled = !locked && !selected.isEmpty
        addButton.alpha = addButton.isEnabled || phase == "adding" ? 1 : 0.5
        footLabel.isHidden = selected.count <= 1
        footVideoLabel.isHidden = !selected.contains(where: { $0.kind == "video" && $0.asset != nil })
        strip.isHidden = selected.isEmpty
        buildStrip()
        grid.isUserInteractionEnabled = true
        view.setNeedsLayout()
    }

    // MARK: The strip of what was chosen

    private var stripViews: [UIView] = []

    private func buildStrip() {
        stripViews.forEach { $0.removeFromSuperview() }
        stripViews = []
        let locked = !phase.isEmpty
        for (index, item) in selected.enumerated() {
            if item.kind == "photo", let thumb = item.thumb {
                let tile = UIButton(type: .custom)
                tile.tag = index
                let picture = UIImageView(image: thumb)
                picture.contentMode = .scaleAspectFill
                picture.clipsToBounds = true
                picture.isUserInteractionEnabled = false
                picture.frame = CGRect(x: 0, y: 0, width: 104, height: 104)
                tile.addSubview(picture)
                tile.backgroundColor = Theme.surface2
                tile.layer.cornerRadius = 14
                tile.layer.borderWidth = 1
                tile.layer.borderColor = ThemeStore.look.border.cgColor
                tile.clipsToBounds = true
                tile.accessibilityLabel = "Редактировать " + item.name
                tile.isEnabled = !locked
                tile.addTarget(self, action: #selector(stripEdit(_:)), for: .touchUpInside)
                let editBadge = UILabel()
                let words = NSMutableAttributedString()
                let pencil = NSTextAttachment()
                pencil.image = chatSymbol("square.and.pencil", 10)?.withTintColor(.white, renderingMode: .alwaysOriginal)
                words.append(NSAttributedString(attachment: pencil))
                words.append(NSAttributedString(string: " Изменить", attributes: [.font: UIFont.systemFont(ofSize: 10, weight: .bold), .foregroundColor: UIColor.white]))
                editBadge.attributedText = words
                editBadge.textAlignment = .center
                editBadge.backgroundColor = UIColor(white: 0, alpha: 0.6)
                editBadge.layer.cornerRadius = 9
                editBadge.clipsToBounds = true
                editBadge.frame = CGRect(x: 5, y: 104 - 5 - 20, width: 70, height: 20)
                tile.addSubview(editBadge)
                let number = numberBadge(index + 1)
                number.frame.origin = CGPoint(x: 5, y: 5)
                tile.addSubview(number)
                let remove = removeButton(index, size: 20, label: "Убрать " + item.name)
                remove.frame = CGRect(x: 104 - 3 - 20, y: 3, width: 20, height: 20)
                remove.isEnabled = !locked
                tile.addSubview(remove)
                tile.frame.size = CGSize(width: 104, height: 104)
                strip.addSubview(tile)
                stripViews.append(tile)
            } else {
                let chip = UIView()
                chip.backgroundColor = ThemeStore.look.accentSoft
                chip.layer.cornerRadius = 14
                chip.layer.borderWidth = 1
                chip.layer.borderColor = ThemeStore.look.border.cgColor
                let number = UILabel()
                number.text = "\(index + 1)"
                number.font = .systemFont(ofSize: 10, weight: .bold)
                number.textColor = Theme.accent
                chip.addSubview(number)
                let symbol = item.kind == "video" ? "video" : item.kind == "audio" ? "music.note" : item.kind == "photo" ? "photo" : "doc"
                let icon = UIImageView(image: chatSymbol(symbol, 13))
                icon.tintColor = Theme.accent
                chip.addSubview(icon)
                let name = UILabel()
                name.text = item.name
                name.font = .systemFont(ofSize: 11)
                name.textColor = Theme.text
                name.lineBreakMode = .byTruncatingMiddle
                chip.addSubview(name)
                let remove = removeButton(index, size: 30, label: "Убрать " + item.name)
                remove.backgroundColor = .clear
                remove.tintColor = Theme.text
                remove.isEnabled = !locked
                chip.addSubview(remove)
                let nameWidth = min(110, ceil(name.intrinsicContentSize.width))
                number.frame = CGRect(x: 9, y: 0, width: 10, height: 36)
                icon.frame = CGRect(x: 22, y: 10, width: 16, height: 16)
                name.frame = CGRect(x: 43, y: 0, width: nameWidth, height: 36)
                remove.frame = CGRect(x: 43 + nameWidth, y: 3, width: 30, height: 30)
                chip.frame.size = CGSize(width: 43 + nameWidth + 30, height: 36)
                strip.addSubview(chip)
                stripViews.append(chip)
            }
        }
        layoutStrip()
    }

    private func layoutStrip() {
        var x: CGFloat = 0
        for item in stripViews {
            let size = item.frame.size
            item.frame = CGRect(x: x, y: (110 - size.height) / 2, width: size.width, height: size.height)
            x += size.width + 6
        }
        strip.contentSize = CGSize(width: max(0, x - 6), height: 110)
    }

    private func numberBadge(_ number: Int) -> UILabel {
        let label = UILabel()
        label.text = "\(number)"
        label.font = .systemFont(ofSize: 10, weight: .heavy)
        label.textColor = Theme.onAccent
        label.textAlignment = .center
        label.backgroundColor = Theme.accent
        label.layer.cornerRadius = 9
        label.clipsToBounds = true
        label.frame.size = CGSize(width: max(18, ceil(label.intrinsicContentSize.width) + 8), height: 18)
        return label
    }

    private func removeButton(_ index: Int, size: CGFloat, label: String) -> UIButton {
        let button = UIButton(type: .system)
        button.tag = index
        button.setImage(chatSymbol("xmark", size > 24 ? 13 : 10, .bold), for: .normal)
        button.tintColor = .white
        button.backgroundColor = UIColor(white: 0, alpha: 0.55)
        button.layer.cornerRadius = size / 2
        button.accessibilityLabel = label
        button.addTarget(self, action: #selector(stripRemove(_:)), for: .touchUpInside)
        return button
    }

    @objc private func stripEdit(_ sender: UIButton) {
        guard sender.tag < selected.count else { return }
        edit(selected[sender.tag])
    }

    @objc private func stripRemove(_ sender: UIButton) {
        guard sender.tag < selected.count else { return }
        choose(selected[sender.tag])
    }

    // MARK: Choosing

    /// The reference's toggleSelection with its limit and wording.
    private func choose(_ item: Item) {
        guard phase.isEmpty else { return }
        if let index = selected.firstIndex(where: { $0.id == item.id }) {
            let gone = selected.remove(at: index)
            forget(gone)
        } else {
            let left = AttachmentPanelController.limit
            guard selected.count < left else {
                errorWords = left > 0 ? "В этом сообщении осталось мест для вложений: \(left). Убери лишнее из выбора." : "В сообщении уже максимальное число вложений. Сначала отправь или убери часть файлов."
                refreshAll()
                return
            }
            selected.append(item)
        }
        UISelectionFeedbackGenerator().selectionChanged()
        errorWords = ""
        notice = ""
        refreshAll()
        grid.reloadData()
    }

    private func add(_ items: [Item]) {
        var room = AttachmentPanelController.limit - selected.count
        for item in items where !selected.contains(where: { $0.id == item.id }) {
            guard room > 0 else {
                errorWords = "В этом сообщении осталось мест для вложений: \(AttachmentPanelController.limit). Убери лишнее из выбора."
                forget(item)
                continue
            }
            selected.append(item)
            room -= 1
        }
        refreshAll()
        grid.reloadData()
    }

    /// A copy made for a chosen thing is removed once it is no longer chosen.
    private func forget(_ item: Item) {
        if !item.borrowed, let url = item.url, url.path.hasPrefix(FileManager.default.temporaryDirectory.path) { try? FileManager.default.removeItem(at: url) }
    }

    @objc private func tabTapped(_ sender: UIButton) {
        guard phase.isEmpty, let id = sender.accessibilityIdentifier else { return }
        if id == "poll" {
            // The reference: the selection is dropped and the poll opens once the panel is gone.
            selected.forEach { forget($0) }
            selected = []
            let poll = onPoll
            close(then: { DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { poll?() } })
            return
        }
        tab = id
        errorWords = ""
        refreshAll()
    }

    @objc private func trackTapped(_ sender: UIControl) {
        let tracks = localTracks
        guard sender.tag < tracks.count, let url = MusicPlayer.shared.fileURL(tracks[sender.tag]) else { return }
        let track = tracks[sender.tag]
        choose(Item(id: "music:" + track.id, kind: "audio", name: track.fileName ?? track.title, url: url, borrowed: true))
    }

    // MARK: The gallery

    private var galleryFailed = false

    private var galleryCount: Int { samples ? sampleItems.count : (assets?.count ?? 0) }

    /// The reference's `refresh('auto')`: the library is asked about only now, when the panel opens.
    private func startGallery() {
        #if targetEnvironment(simulator)
        if let demo = UserDefaults.standard.string(forKey: "attachdemo"), demo.hasPrefix("panel") {
            simulatorSamples(demo)
            return
        }
        #endif
        status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] (answer: PHAuthorizationStatus) -> Void in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.asked = true
                    self.status = answer
                    self.loadGallery()
                }
            }
            return
        }
        asked = true
        loadGallery()
    }

    private func loadGallery() {
        guard status == .authorized || status == .limited else {
            assets = nil
            refreshAll()
            grid.reloadData()
            return
        }
        if !observing {
            PHPhotoLibrary.shared().register(self)
            observing = true
        }
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        assets = PHAsset.fetchAssets(with: options)
        galleryFailed = false
        refreshAll()
        grid.reloadData()
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let current = self.assets, let details = changeInstance.changeDetails(for: current) else { return }
            self.assets = details.fetchResultAfterChanges
            self.grid.reloadData()
            self.refreshAll()
        }
    }

    @objc private func cameBack() {
        guard !samples else { return }
        status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        loadGallery()
    }

    @objc private func addAccess() {
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: self) { [weak self] (_: [String]) -> Void in
            DispatchQueue.main.async { self?.loadGallery() }
        }
    }

    @objc private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        let allowed = samples || status == .authorized || status == .limited
        return allowed ? galleryCount + 1 : 0
    }

    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
        let side = floor(collectionView.bounds.width / 4)
        return CGSize(width: side, height: side)
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        if indexPath.item == 0 {
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "camera", for: indexPath)
            (cell as? CameraCell)?.paint(enabled: phase.isEmpty)
            return cell
        }
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "media", for: indexPath)
        guard let media = cell as? GalleryCell, let item = galleryItem(indexPath.item - 1) else { return cell }
        let number = (selected.firstIndex(where: { $0.id == item.id }) ?? -1) + 1
        media.show(item, number: number, disabled: !phase.isEmpty)
        media.onCheck = { [weak self] in self?.choose(item) }
        if let thumb = item.thumb {
            media.picture.image = thumb
        } else if let asset = item.asset {
            let scale = traitCollection.displayScale
            let side = floor(collectionView.bounds.width / 4) * scale
            let options = PHImageRequestOptions()
            options.deliveryMode = .opportunistic
            options.resizeMode = .fast
            options.isNetworkAccessAllowed = false
            media.requested = item.id
            images.requestImage(for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill, options: options) { [weak media] (image: UIImage?, _: [AnyHashable: Any]?) -> Void in
                guard let media, media.requested == item.id else { return }
                if let image { media.picture.image = image } else if media.picture.image == nil { media.showMissing() }
            }
        }
        return cell
    }

    /// The reference: a photo opens in the editor, a video is chosen; the round mark chooses either.
    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        guard phase.isEmpty else { return }
        if indexPath.item == 0 { camera(); return }
        guard let item = galleryItem(indexPath.item - 1) else { return }
        if item.kind == "photo" { edit(item) } else { choose(item) }
    }

    private func galleryItem(_ index: Int) -> Item? {
        if samples { return index < sampleItems.count ? sampleItems[index] : nil }
        guard let assets, index >= 0, index < assets.count else { return nil }
        let asset = assets.object(at: index)
        let id = "gallery:" + asset.localIdentifier
        if let chosen = selected.first(where: { $0.id == id }) { return chosen }
        let video = asset.mediaType == .video
        let resource = PHAssetResource.assetResources(for: asset).first
        let name = resource?.originalFilename ?? (video ? "video" : "photo")
        return Item(id: id, kind: video ? "video" : "photo", name: name, asset: asset, duration: asset.duration)
    }

    // MARK: Getting originals

    /// The original of a gallery photo, read only now (iCloud allowed; the person asked for it).
    private func photoData(_ item: Item, done: @escaping (Data?) -> Void) {
        if let data = item.data { done(data); return }
        guard let asset = item.asset else { done(nil); return }
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.version = .current
        options.deliveryMode = .highQualityFormat
        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { (data: Data?, _: String?, _: CGImagePropertyOrientation, _: [AnyHashable: Any]?) -> Void in
            DispatchQueue.main.async { done(data) }
        }
    }

    /// The original video file of a gallery video (the reference: the original, not the «Фото» edits), copied into
    /// the app's temporary folder.
    private func videoFile(_ item: Item, done: @escaping (URL?) -> Void) {
        if let url = item.url { done(url); return }
        guard let asset = item.asset else { done(nil); return }
        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = resources.first(where: { $0.type == .video }) ?? resources.first(where: { $0.type == .fullSizeVideo }) else { done(nil); return }
        let ext = (resource.originalFilename as NSString).pathExtension
        let target = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString.lowercased() + "." + (ext.isEmpty ? "mov" : ext))
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        PHAssetResourceManager.default().writeData(for: resource, toFile: target, options: options) { (error: Error?) -> Void in
            DispatchQueue.main.async { done(error == nil ? target : nil) }
        }
    }

    /// The reference's `resolveSelection` for every chosen thing, in order.
    private func resolve(_ item: Item, done: @escaping (Picked?) -> Void) {
        switch item.kind {
        case "photo":
            photoData(item) { (data: Data?) -> Void in done(data.map { Picked.photo($0, format: nil) }) }
        case "video":
            videoFile(item) { (url: URL?) -> Void in done(url.map { Picked.video($0) }) }
        default:
            guard let url = item.url else { done(nil); return }
            if item.borrowed {
                // A track of «Моя музыка» stays where it is: the chat gets its own copy.
                let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString.lowercased()).appendingPathComponent(item.name)
                do {
                    try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: url, to: copy)
                    done(.file(copy))
                } catch {
                    done(nil)
                }
            } else {
                done(.file(url))
            }
        }
    }

    // MARK: Adding

    @objc private func addSelected() {
        guard phase.isEmpty, !selected.isEmpty else { return }
        let batch = selected
        phase = "adding"
        errorWords = ""
        notice = ""
        refreshAll()
        var made: [Picked] = []
        func step(_ index: Int) {
            guard index < batch.count else {
                // Everything was read: the chat takes the lot, so the photos keep their album and order.
                self.selected = []
                self.phase = ""
                self.notice = ""
                let send = self.onSend
                self.close(then: { send?(made) })
                return
            }
            resolve(batch[index]) { [weak self] (picked: Picked?) -> Void in
                guard let self else { return }
                guard let picked else {
                    self.phase = ""
                    self.errorWords = "Не удалось получить оригинал. Открой его на устройстве или выбери через «Файлы»."
                    // What was read so far is handed over; the rest stays chosen to try again.
                    if !made.isEmpty {
                        let done = Set(batch.prefix(index).map { $0.id })
                        self.selected.removeAll { done.contains($0.id) }
                        self.onSend?(made)
                    }
                    self.refreshAll()
                    self.grid.reloadData()
                    return
                }
                made.append(picked)
                self.notice = "Добавлено в сообщение: \(index + 1) из \(batch.count)"
                self.refreshAll()
                step(index + 1)
            }
        }
        step(0)
    }

    // MARK: The editor

    /// «Изменить» / a photo of the grid: the original is read and opened in the editor; what it gives is added to
    /// the message at once (the reference's `addEdited`).
    private func edit(_ item: Item) {
        guard item.kind == "photo", phase.isEmpty else { return }
        phase = "opening"
        errorWords = ""
        notice = ""
        refreshAll()
        photoData(item) { [weak self] (data: Data?) -> Void in
            guard let self else { return }
            self.phase = ""
            guard let data, let picture = AttachmentPanelController.picture(data, edge: 4096) else {
                self.errorWords = "Не удалось получить оригинал. Открой его на устройстве или выбери через «Файлы»."
                self.refreshAll()
                return
            }
            self.refreshAll()
            let editor = PhotoEditorController(image: picture)
            editor.onDone = { [weak self] (output: PhotoEditorController.Output?) -> Void in
                guard let self else { return }
                var picked = Picked.photo(data, format: nil)
                if let output {
                    guard let png = AttachmentPanelController.png(output.image) else {
                        self.errorWords = "Не удалось обработать фото. Попробуй ещё раз."
                        self.refreshAll()
                        return
                    }
                    picked = .photo(png, format: output.format)
                }
                self.selected.removeAll { $0.id == item.id }
                self.onSend?([picked])
                self.notice = "Фото добавлено в сообщение."
                self.refreshAll()
                self.grid.reloadData()
                if self.selected.isEmpty { self.close(then: nil) }
            }
            self.present(editor, animated: true)
        }
    }

    /// The picture decoded upright, at most `edge` pixels a side.
    static func picture(_ data: Data, edge: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: edge, kCGImageSourceShouldCacheImmediately: true]
        guard let made = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: made)
    }

    /// The edited bitmap as lossless PNG; the chat writes it in the chosen format when it cleans it.
    static func png(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    // MARK: The camera, files, the system's picker

    private func camera() {
        guard phase.isEmpty, UIImagePickerController.isSourceTypeAvailable(.camera) else {
            if !UIImagePickerController.isSourceTypeAvailable(.camera) {
                errorWords = "Не удалось добавить вложение."
                refreshAll()
            }
            return
        }
        phase = "picking"
        refreshAll()
        AVCaptureDevice.requestAccess(for: .video) { [weak self] (granted: Bool) -> Void in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else {
                    self.phase = ""
                    self.errorWords = "Разреши доступ к камере в настройках, чтобы снимать прямо из чата."
                    self.refreshAll()
                    return
                }
                let picker = UIImagePickerController()
                picker.sourceType = .camera
                picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
                picker.videoMaximumDuration = 600
                picker.videoQuality = .typeHigh
                picker.allowsEditing = false
                picker.delegate = self
                self.present(picker, animated: true)
            }
        }
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        phase = ""
        if let movie = info[.mediaURL] as? URL {
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString.lowercased() + "." + (movie.pathExtension.isEmpty ? "mov" : movie.pathExtension))
            if (try? FileManager.default.copyItem(at: movie, to: copy)) != nil {
                add([Item(id: "file:" + copy.path, kind: "video", name: "video." + copy.pathExtension, url: copy, thumb: AttachmentPanelController.frame(of: copy))])
                return
            }
        } else if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 1) {
            add([Item(id: "camera:" + UUID().uuidString, kind: "photo", name: "photo.jpg", data: data, thumb: AttachmentPanelController.picture(data, edge: 320))])
            return
        }
        errorWords = "Не удалось добавить вложение."
        refreshAll()
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        phase = ""
        refreshAll()
    }

    static func frame(of url: URL) -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 320, height: 320)
        guard let image = try? generator.copyCGImage(at: .zero, actualTime: nil) else { return nil }
        return UIImage(cgImage: image)
    }

    private var pickingAudio = false

    @objc private func pickAudio() { documents(audio: true) }
    @objc private func pickFiles() { documents(audio: false) }

    private func documents(audio: Bool) {
        guard phase.isEmpty else { return }
        pickingAudio = audio
        phase = "picking"
        refreshAll()
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [audio ? UTType.audio : UTType.item], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = true
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        phase = ""
        let audio = pickingAudio
        let items = urls.map { (url: URL) -> Item in
            let type = UTType(filenameExtension: url.pathExtension)
            var kind = "file"
            if audio || (type?.conforms(to: .audio) ?? false) {
                kind = "audio"
            } else if type?.conforms(to: .movie) ?? false {
                kind = "video"
            }
            // A picture picked as a file stays a file in the strip; the chat still cleans it as a photo.
            return Item(id: "file:" + url.path, kind: kind, name: url.lastPathComponent, url: url)
        }
        add(items)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        phase = ""
        refreshAll()
    }

    /// «Системный выбор фото и видео» / «Выбрать через системное окно»: the system's picker, which needs no access.
    @objc private func systemGallery() {
        guard phase.isEmpty else { return }
        var config = PHPickerConfiguration()
        config.filter = .any(of: [.images, .videos])
        config.selectionLimit = max(1, AttachmentPanelController.limit - selected.count)
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        phase = "picking"
        refreshAll()
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !results.isEmpty else {
            phase = ""
            refreshAll()
            return
        }
        var made: [Item?] = Array(repeating: nil, count: results.count)
        let guarding = NSLock()
        let group = DispatchGroup()
        for (index, result) in results.enumerated() {
            let provider = result.itemProvider
            let video = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
            let type = video ? UTType.movie.identifier : UTType.image.identifier
            group.enter()
            _ = provider.loadFileRepresentation(forTypeIdentifier: type) { (url: URL?, _: Error?) -> Void in
                // The system's copy lives only during this call.
                defer { group.leave() }
                guard let url else { return }
                if video {
                    let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString.lowercased() + "." + (url.pathExtension.isEmpty ? "mov" : url.pathExtension))
                    guard (try? FileManager.default.copyItem(at: url, to: copy)) != nil else { return }
                    let item = Item(id: "file:" + copy.path, kind: "video", name: url.lastPathComponent, url: copy, thumb: AttachmentPanelController.frame(of: copy))
                    guarding.lock()
                    made[index] = item
                    guarding.unlock()
                } else if let data = try? Data(contentsOf: url) {
                    let item = Item(id: "picked:" + UUID().uuidString, kind: "photo", name: url.lastPathComponent, data: data, thumb: AttachmentPanelController.picture(data, edge: 320))
                    guarding.lock()
                    made[index] = item
                    guarding.unlock()
                }
            }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.phase = ""
            let items = made.compactMap { $0 }
            if items.count < results.count { self.errorWords = "Не удалось добавить вложение." }
            self.add(items)
        }
    }

    // MARK: Pulling and closing

    @objc private func dragged(_ pan: UIPanGestureRecognizer) {
        let half = halfHeight, full = fullHeight
        switch pan.state {
        case .began:
            dragStart = sheetHeight
        case .changed:
            sheetHeight = max(half * 0.5, min(full, dragStart - pan.translation(in: view).y))
            view.setNeedsLayout()
            view.layoutIfNeeded()
        case .ended, .cancelled:
            let velocity = pan.velocity(in: view).y
            let goingUp = velocity < -500, goingDown = velocity > 500
            if (goingDown || sheetHeight < half * 0.8) && dragStart <= half + 1 {
                closeNow()
                return
            }
            let target = goingUp ? full : goingDown ? half : sheetHeight > (half + full) / 2 ? full : half
            settle(target)
        default:
            break
        }
    }

    /// The reference: the same pull from the grid once it is scrolled to its top — down only.
    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        guard scrollView === grid else { return }
        let pulled = -(scrollView.contentOffset.y + scrollView.adjustedContentInset.top)
        guard pulled > 40 || (pulled > 0 && velocity.y < -0.5) else { return }
        if sheetHeight <= halfHeight + 1 { closeNow() } else { settle(halfHeight) }
    }

    private func settle(_ target: CGFloat) {
        sheetHeight = target
        let animator = UIViewPropertyAnimator(duration: 0.24, controlPoint1: CGPoint(x: 0.2, y: 0.9), controlPoint2: CGPoint(x: 0.25, y: 1)) { () -> Void in
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
        animator.startAnimation()
    }

    @objc private func closeNow() {
        guard phase != "adding" else { return }
        selected.forEach { forget($0) }
        selected = []
        close(then: nil)
    }

    private func close(then: (() -> Void)?) {
        guard !closing else { return }
        closing = true
        let shift = view.bounds.height - sheet.frame.minY
        UIView.animate(withDuration: 0.22, animations: { () -> Void in
            self.backdrop.alpha = 0
            self.sheet.transform = CGAffineTransform(translationX: 0, y: shift)
        }, completion: { (_: Bool) -> Void in
            self.dismiss(animated: false) { then?() }
        })
    }

    // MARK: The simulator check

    #if targetEnvironment(simulator)
    /// `-attachdemo panel|panellimited|paneldenied|panelselected` (with `-demo 1 -chat 1`): drawn sample tiles
    /// instead of the library (no photo of anyone), as the panel shows them.
    private func simulatorSamples(_ demo: String) {
        if demo == "paneldenied" {
            status = .denied
            asked = true
            refreshAll()
            return
        }
        samples = demo != "panellimited"
        status = demo == "panellimited" ? .limited : .authorized
        asked = true
        let colors: [(UInt32, UInt32)] = [(0x1F3B73, 0xE0803B), (0x2E4A3B, 0xC8B27A), (0x3A3F58, 0x9FB4C7), (0x5A3825, 0xE3C08D), (0x203040, 0x6FA3B8),
                                          (0x3B2F2F, 0xB48A6A), (0x1E2A38, 0xD9D2C5), (0x34402A, 0xA9B88A), (0x2B2440, 0x8C9CC9), (0x40302A, 0xD6A77A), (0x223B3B, 0x9CC5B9)]
        sampleItems = colors.enumerated().map { (index: Int, pair: (UInt32, UInt32)) -> Item in
            let picture = AttachmentPanelController.sample(pair.0, pair.1)
            let video = index % 4 == 2
            return Item(id: "sample:\(index)", kind: video ? "video" : "photo", name: video ? "IMG_\(1200 + index).MOV" : "IMG_\(1200 + index).HEIC",
                        data: picture.jpegData(compressionQuality: 0.8), thumb: picture, duration: video ? Double(14 + index * 7) : 0)
        }
        if demo == "panellimited" {
            // The limited look with the sample tiles.
            samples = true
        }
        if demo == "panelselected" {
            selected = [sampleItems[0], sampleItems[2], sampleItems[3]]
        }
        refreshAll()
        grid.reloadData()
    }

    private static func sample(_ from: UInt32, _ to: UInt32) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let size = CGSize(width: 240, height: 240)
        return UIGraphicsImageRenderer(size: size, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
            let colors = [UIColor(hex: from).cgColor, UIColor(hex: to).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1] as [CGFloat]) {
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 240, y: 240), options: [])
            }
            UIColor(white: 1, alpha: 0.8).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 150, y: 40, width: 50, height: 50))
        }
    }
    #endif
}

/// The duration under a video of the grid (the reference's `durationLabel`, from seconds here).
private func durationText(_ seconds: TimeInterval) -> String {
    guard seconds.isFinite, seconds > 0 else { return "Видео" }
    let whole = Int(seconds), minutes = whole / 60
    let tail = String(format: "%02d", whole % 60)
    return minutes >= 60 ? "\(minutes / 60):" + String(format: "%02d", minutes % 60) + ":" + tail : "\(minutes):" + tail
}

/// One tile of the gallery: the small picture, the round mark with its number, a video's length.
private final class GalleryCell: UICollectionViewCell {
    let picture = UIImageView()
    private let frameView = UIView()
    private let missing = UILabel()
    private let videoBadge = UIView()
    private let videoIcon = UIImageView()
    private let videoLabel = UILabel()
    private let check = UIButton(type: .custom)
    private let ring = UILabel()
    var onCheck: (() -> Void)?
    var requested = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        frameView.backgroundColor = Theme.surface2
        frameView.layer.cornerRadius = 9
        frameView.clipsToBounds = true
        frameView.layer.borderColor = Theme.accent.cgColor
        contentView.addSubview(frameView)
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        frameView.addSubview(picture)
        missing.font = .systemFont(ofSize: 9)
        missing.textColor = Theme.muted
        missing.textAlignment = .center
        missing.text = "Нет миниатюры"
        missing.isHidden = true
        frameView.addSubview(missing)
        videoBadge.backgroundColor = UIColor(white: 0, alpha: 0.55)
        videoBadge.layer.cornerRadius = 7
        frameView.addSubview(videoBadge)
        videoIcon.image = chatSymbol("video.fill", 9)
        videoIcon.tintColor = .white
        videoBadge.addSubview(videoIcon)
        videoLabel.font = .systemFont(ofSize: 10, weight: .semibold)
        videoLabel.textColor = .white
        videoBadge.addSubview(videoLabel)
        check.addTarget(self, action: #selector(checked), for: .touchUpInside)
        frameView.addSubview(check)
        ring.font = .systemFont(ofSize: 12, weight: .heavy)
        ring.textColor = Theme.onAccent
        ring.textAlignment = .center
        ring.layer.cornerRadius = 11
        ring.layer.borderWidth = 1.5
        ring.layer.borderColor = UIColor.white.cgColor
        ring.clipsToBounds = true
        ring.isUserInteractionEnabled = false
        check.addSubview(ring)
    }

    required init?(coder: NSCoder) { return nil }

    override func prepareForReuse() {
        super.prepareForReuse()
        picture.image = nil
        missing.isHidden = true
        requested = ""
        onCheck = nil
    }

    func show(_ item: AttachmentPanelController.Item, number: Int, disabled: Bool) {
        frameView.layer.borderWidth = number > 0 ? 2 : 0
        frameView.alpha = disabled ? 0.65 : 1
        videoBadge.isHidden = item.kind != "video"
        videoLabel.text = durationText(item.duration)
        ring.text = number > 0 ? "\(number)" : nil
        ring.backgroundColor = number > 0 ? Theme.accent : UIColor(white: 0, alpha: 0.28)
        check.isEnabled = !disabled
        check.accessibilityLabel = (number > 0 ? "Убрать из выбора " : "Выбрать ") + item.name + (number > 0 ? ", номер \(number)" : "")
        check.accessibilityTraits = number > 0 ? [.button, .selected] : .button
        accessibilityLabel = item.kind == "photo" ? "Редактировать " + item.name : "Выбрать видео " + item.name
        isAccessibilityElement = false
        setNeedsLayout()
    }

    func showMissing() {
        missing.isHidden = false
    }

    @objc private func checked() { onCheck?() }

    override func layoutSubviews() {
        super.layoutSubviews()
        frameView.frame = contentView.bounds.insetBy(dx: 1.5, dy: 1.5)
        picture.frame = frameView.bounds
        missing.frame = CGRect(x: 0, y: frameView.bounds.midY - 8, width: frameView.bounds.width, height: 16)
        let labelWidth = ceil(videoLabel.intrinsicContentSize.width)
        videoBadge.frame = CGRect(x: 6, y: frameView.bounds.height - 6 - 18, width: 6 + 11 + 4 + labelWidth + 6, height: 18)
        videoIcon.frame = CGRect(x: 6, y: 3, width: 11, height: 12)
        videoLabel.frame = CGRect(x: 21, y: 0, width: labelWidth, height: 18)
        check.frame = CGRect(x: frameView.bounds.width - 38, y: 0, width: 38, height: 38)
        ring.frame = CGRect(x: 8, y: 8, width: 22, height: 22)
    }
}

/// The camera, first in the grid.
private final class CameraCell: UICollectionViewCell {
    private let tile = UIView()
    private let icon = UIImageView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        tile.layer.cornerRadius = 9
        contentView.addSubview(tile)
        icon.image = chatSymbol("camera", 24)
        icon.contentMode = .center
        tile.addSubview(icon)
        isAccessibilityElement = true
        accessibilityLabel = "Снять фото или видео"
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { return nil }

    func paint(enabled: Bool) {
        tile.backgroundColor = Theme.dark ? Theme.bg : Theme.text
        icon.tintColor = Theme.dark ? Theme.text : Theme.bg
        tile.alpha = enabled ? 1 : 0.65
    }

    override var isHighlighted: Bool {
        didSet { tile.alpha = isHighlighted ? 0.7 : 1 }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        tile.frame = contentView.bounds.insetBy(dx: 1.5, dy: 1.5)
        icon.frame = tile.bounds
    }
}

/// A track of «Моя музыка» in «Аудио».
private final class TrackRow: UIControl {
    init(title: String, detail: String, on: Bool) {
        super.init(frame: .zero)
        backgroundColor = on ? ThemeStore.look.accentSoft : Theme.surface2
        layer.cornerRadius = 18
        layer.borderWidth = 1
        layer.borderColor = (on ? Theme.accent : ThemeStore.look.border).cgColor
        let note = UIImageView(image: chatSymbol("music.note", 20))
        note.tintColor = Theme.accent
        let titleLabel = UILabel()
        titleLabel.text = title
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = Theme.text
        let detailLabel = UILabel()
        detailLabel.text = detail
        detailLabel.font = .systemFont(ofSize: 11)
        detailLabel.textColor = Theme.muted
        let mark = UIImageView(image: chatSymbol(on ? "checkmark.circle.fill" : "circle", 22))
        mark.tintColor = on ? Theme.accent : Theme.subtle
        let words = UIStackView(arrangedSubviews: [titleLabel, detailLabel])
        words.axis = .vertical
        words.spacing = 4
        let row = UIStackView(arrangedSubviews: [note, words, mark])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        row.isUserInteractionEnabled = false
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
        ])
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityTraits = on ? [.button, .selected] : .button
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }
}
