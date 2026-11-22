import CoreImage
import QuickLook
import UIKit

/// Attachments: photos shown whole inside their row and files brought inside their row, as in the reference
/// (mobile/src/media/MediaBubble.tsx: `MediaTile` — a photo up to 10 MB comes by itself and appears in the
/// bubble, a tap while it comes stops it; `FileBubble` — the round button: ↓, a ring with the progress and a
/// cross, then the file's icon, and the file opens once it is here).
///
/// What is brought is checked and decrypted by the core (`AttachmentLoad`); the pictures and files stay in memory
/// only (a few dozen pictures, files up to 25 MB), nothing decrypted is written here. Main queue only.
final class InlineMedia {
    static let shared = InlineMedia()
    /// Posted (object: the row's key) when a row's photo or file changed its state.
    static let changed = Notification.Name("invizent.inline-media")
    /// MediaBubble.tsx `AUTO_PHOTO_BYTES`: photos up to this size come by themselves.
    static let autoPhotoBytes = 10 * 1024 * 1024
    private static let keepFileBytes = 25 * 1024 * 1024
    private static let keepPictures = 40

    enum Status { case idle, loading, ready, failed }

    struct Entry {
        var status = Status.idle
        /// How much has arrived, 0…1.
        var progress: CGFloat = 0
        /// While coming: «1,2 МБ / 3,4 МБ» (a photo) or «1,2 МБ из 3,4 МБ» (a file).
        var words = ""
    }

    private(set) weak var server: Server?
    private var entries: [String: Entry] = [:]
    private var loads: [String: AttachmentLoad] = [:]
    private var pictures: [String: UIImage] = [:]
    private var pictureOrder: [String] = []
    private var files: [String: Data] = [:]
    private var blurredPreviews: [String: UIImage] = [:]
    /// Rows whose photo was asked for once: one that was stopped or failed is not asked for again by itself.
    private var tried = Set<String>()
    private lazy var imageContext = CIContext(options: nil)

    private init() {}

    /// The account whose server brings the files; another account forgets everything of the previous one.
    func use(_ next: Server?) {
        guard let next, next !== server else { return }
        for load in loads.values { load.cancel() }
        entries = [:]
        loads = [:]
        pictures = [:]
        pictureOrder = []
        files = [:]
        blurredPreviews = [:]
        tried = []
        server = next
    }

    func entry(_ key: String) -> Entry { entries[key] ?? Entry() }

    /// The photo of a row once it is here.
    func picture(_ key: String) -> UIImage? { pictures[key] }

    /// A photo's row is on screen: a photo up to 10 MB is brought by itself (once).
    func want(_ key: String) {
        guard entries[key] == nil, !tried.contains(key), server != nil, let attachment = AttachmentStore.shared.attachment(key) else { return }
        let size = (attachment["size"] as? NSNumber)?.intValue ?? 0
        guard size > 0, size <= InlineMedia.autoPhotoBytes else { return }
        tried.insert(key)
        // Not while the list is laying out its cells: the state change redraws them.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.entries[key] == nil else { return }
            self.start(key, attachment: attachment, then: nil)
        }
    }

    /// A touch on the row of a photo or a file (`press` of MediaTile and FileBubble). True: it was dealt with here
    /// (`openPhoto`: the photo is here — show it on the whole screen; `openFile`: the file is here — show it).
    func pressed(_ key: String, attachment: [String: Any], openPhoto: () -> Void, openFile: @escaping (Data) -> Void) -> Bool {
        guard server != nil else { return false }
        let about = FileCore.describe(attachment)
        if about.refusal != nil || about.kind == "video" { return false }
        let photo = about.kind == "photo"
        let after: ((Data) -> Void)? = photo ? nil : openFile
        switch entry(key).status {
        case .loading:
            InlineMedia.light()
            cancel(key)
        case .ready:
            if photo, pictures[key] != nil {
                openPhoto()
            } else if !photo, let data = files[key] {
                openFile(data)
            } else {
                InlineMedia.light()
                start(key, attachment: attachment, then: after)
            }
        case .idle, .failed:
            InlineMedia.light()
            // A video opens by itself once loaded; a photo simply appears in the bubble; a file opens.
            start(key, attachment: attachment, then: after)
        }
        return true
    }

    /// Stops what is being brought for a row; its button is the ↓ again.
    func cancel(_ key: String) {
        loads[key]?.cancel()
        loads[key] = nil
        set(key, Entry())
    }

    /// ChatActions (Sources/ChatActions/ForwardQueue.swift): the ring and ✕ of a forwarded attachment being copied,
    /// on its row on the way out (`progress` 0…1, the words in the pill or under the name).
    func showSending(_ key: String, progress: CGFloat, words: String) {
        tried.insert(key)
        set(key, Entry(status: .loading, progress: min(1, max(0, progress)), words: words))
    }

    /// ChatActions: the forward's row is gone or failed — its ring goes with it.
    func forgetSending(_ key: String) {
        guard entries[key] != nil else { return }
        entries[key] = nil
        NotificationCenter.default.post(name: InlineMedia.changed, object: key)
    }

    private static func light() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func set(_ key: String, _ entry: Entry) {
        entries[key] = entry
        NotificationCenter.default.post(name: InlineMedia.changed, object: key)
    }

    private static func loadingWords(_ size: Int, _ fraction: CGFloat, photo: Bool) -> String {
        let got = FileCore.sizeText(Int(CGFloat(size) * min(1, max(0, fraction))))
        return got + (photo ? " / " : " из ") + FileCore.sizeText(size)
    }

    private func start(_ key: String, attachment: [String: Any], then: ((Data) -> Void)?) {
        guard let server else { return }
        let about = FileCore.describe(attachment)
        tried.insert(key)
        guard about.refusal == nil, let cipherSize = about.cipherSize else {
            set(key, Entry(status: .failed, progress: 0, words: ""))
            return
        }
        loads[key]?.cancel()
        let load = AttachmentLoad(server: server, attachment: attachment, cipherSize: cipherSize)
        loads[key] = load
        let size = (attachment["size"] as? NSNumber)?.intValue ?? max(0, cipherSize - 16)
        let photo = about.kind == "photo"
        set(key, Entry(status: .loading, progress: 0, words: InlineMedia.loadingWords(size, 0, photo: photo)))
        load.onFraction = { [weak self, weak load] (fraction: CGFloat) -> Void in
            guard let self, let load, self.loads[key] === load else { return }
            self.set(key, Entry(status: .loading, progress: fraction, words: InlineMedia.loadingWords(size, fraction, photo: photo)))
        }
        load.start { [weak self, weak load] (result: Result<Data, FileCore.Failure>) -> Void in
            guard let self, let load, self.loads[key] === load else { return }
            self.loads[key] = nil
            switch result {
            case .failure:
                self.set(key, Entry(status: .failed, progress: 0, words: ""))
            case .success(let data):
                if photo {
                    DispatchQueue.global(qos: .userInitiated).async {
                        let made = InlineMedia.decode(data)
                        DispatchQueue.main.async {
                            guard let made else {
                                self.set(key, Entry(status: .failed, progress: 0, words: ""))
                                return
                            }
                            self.keep(made, key)
                            self.set(key, Entry(status: .ready, progress: 1, words: ""))
                        }
                    }
                } else {
                    let kept = data.count <= InlineMedia.keepFileBytes
                    if kept { self.files[key] = data }
                    self.set(key, Entry(status: kept ? .ready : .idle, progress: kept ? 1 : 0, words: ""))
                    then?(data)
                }
            }
        }
    }

    private func keep(_ image: UIImage, _ key: String) {
        pictures[key] = image
        pictureOrder.removeAll { $0 == key }
        pictureOrder.append(key)
        while pictureOrder.count > InlineMedia.keepPictures {
            let old = pictureOrder.removeFirst()
            pictures[old] = nil
            // Shown again later, it is brought again.
            entries[old] = nil
            tried.remove(old)
        }
    }

    /// The photo, decoded and made no bigger than a row needs (300 pt at 3×).
    private static func decode(_ data: Data) -> UIImage? {
        guard let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else { return nil }
        let longest = max(image.size.width, image.size.height) * image.scale
        if longest <= 1000 { return image.preparingForDisplay() ?? image }
        let factor = 1000 / longest
        let size = CGSize(width: max(1, (image.size.width * image.scale * factor).rounded()), height: max(1, (image.size.height * image.scale * factor).rounded()))
        return image.preparingThumbnail(of: size) ?? image
    }

    /// The small picture of a photo, blurred as the reference shows it until the photo is here (`blurRadius 12`
    /// at the size of the tile).
    func blurred(_ key: String, small: UIImage, width: CGFloat) -> UIImage {
        if let hit = blurredPreviews[key] { return hit }
        guard let source = CIImage(image: small), let filter = CIFilter(name: "CIGaussianBlur") else { return small }
        let radius = max(1, 12 * source.extent.width / max(1, width))
        filter.setValue(source.clampedToExtent(), forKey: kCIInputImageKey)
        filter.setValue(radius, forKey: kCIInputRadiusKey)
        guard let output = filter.outputImage?.cropped(to: source.extent), let made = imageContext.createCGImage(output, from: source.extent) else { return small }
        let image = UIImage(cgImage: made)
        if blurredPreviews.count > 80 { blurredPreviews.removeAll() }
        blurredPreviews[key] = image
        return image
    }

    /// «44 Б · PDF»: the size, then the name's ending in capitals (FileBubble).
    static func sizeLine(_ attachment: [String: Any], sizeText: String) -> String {
        let name = attachment["name"] as? String ?? ""
        var ending = ""
        if let range = name.range(of: "\\.[A-Za-z0-9]{1,5}$", options: .regularExpression) { ending = String(name[range].dropFirst()).uppercased() }
        return ending.isEmpty ? sizeText : sizeText + " · " + ending
    }

    #if targetEnvironment(simulator)
    /// `-attachdemo 1`: a photo that is here, a photo and a file on their way.
    func demo(ready key: String, picture: UIImage) {
        keep(picture, key)
        entries[key] = Entry(status: .ready, progress: 1, words: "")
        tried.insert(key)
    }

    func demo(loading key: String, progress: CGFloat, size: Int, photo: Bool) {
        entries[key] = Entry(status: .loading, progress: progress, words: InlineMedia.loadingWords(size, progress, photo: photo))
        tried.insert(key)
    }
    #endif
}

/// The drawing of a photo shown whole and of a file's card inside a row of the chat (`MsgRowCanvas` calls it).
/// Numbers from MessageRow.tsx and MediaBubble.tsx: media up to 300×380 pt and at least 170×74 pt, proportions
/// kept between 0.45 and 2.2; the button 48 pt on a dark veil (55 %), the size in a pill at the upper left, the
/// time of a photo alone in a pill (50 %) 8 pt from the lower right corner; a file's button 48 pt in the accent
/// colour, the name 14 pt semibold on up to two lines, «44 Б · PDF» 12 pt.
enum InlineMediaArt {
    private static let veil = UIColor(red: 10 / 255, green: 15 / 255, blue: 30 / 255, alpha: 0.55)
    private static let timeVeil = UIColor(red: 10 / 255, green: 15 / 255, blue: 30 / 255, alpha: 0.5)
    private static let plate = UIColor(red: 60 / 255, green: 70 / 255, blue: 95 / 255, alpha: 0.32)
    private static let pillFont = UIFont.systemFont(ofSize: 11)
    private static let nameFont = UIFont.systemFont(ofSize: 14, weight: .semibold)
    private static let lineFont = UIFont.systemFont(ofSize: 12)

    /// MessageRow.tsx `mediaBox` (a photo alone) and `captionedMediaBox` (a photo with words).
    static func photoSize(_ row: MsgRow, width: CGFloat) -> CGSize {
        let most = (min(300, width - 2 * 36)).rounded()
        let ratio = min(2.2, max(0.45, row.thumbWide))
        if !row.text.isEmpty {
            let height = max(120, min(380, most / ratio))
            return CGSize(width: most, height: height.rounded())
        }
        var w = most
        var h = w / ratio
        if h > 380 {
            h = 380
            w = h * ratio
        }
        return CGSize(width: max(170, w).rounded(), height: max(74, h).rounded())
    }

    /// The card of a file: at least 200, at most 270 pt wide (and never wider than the row allows).
    static func fileSize(_ row: MsgRow, inner: CGFloat) -> CGSize {
        let pieces = parts(row)
        let room = min(270, inner) - 48 - 11
        let name = NSAttributedString(string: pieces.name, attributes: [.font: nameFont]).boundingRect(with: CGSize(width: max(1, room), height: 40), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
        let line = ceil(NSAttributedString(string: pieces.line, attributes: [.font: lineFont]).size().width)
        let wide = 48 + 11 + max(ceil(name.width), line)
        let width = min(inner, min(270, max(200, wide)))
        let textHeight = min(ceil(name.height), ceil(nameFont.lineHeight * 2) + 1) + 3 + ceil(lineFont.lineHeight)
        return CGSize(width: width, height: max(48, textHeight) + 8)
    }

    private static func parts(_ row: MsgRow) -> (name: String, line: String) {
        let split = row.label.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        return (split.first ?? "Файл", split.count > 1 ? split[1] : "")
    }

    private static func symbol(_ name: String, _ size: CGFloat, _ weight: UIImage.SymbolWeight, _ color: UIColor) -> UIImage? {
        // "ion:<name>": the reference's own Ionicons glyph, `size` points square (MediaBubble.tsx <Icon>).
        if name.hasPrefix("ion:") { return IonIcon.image(String(name.dropFirst(4)), size: size).withTintColor(color, renderingMode: .alwaysOriginal) }
        return UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: weight))?.withTintColor(color, renderingMode: .alwaysOriginal)
    }

    private static func drawCentered(_ image: UIImage?, at center: CGPoint) {
        guard let image else { return }
        image.draw(at: CGPoint(x: center.x - image.size.width / 2, y: center.y - image.size.height / 2))
    }

    /// The ring of what has arrived: a track, and the arc from the top, clockwise.
    private static func ring(_ context: CGContext, center: CGPoint, side: CGFloat, progress: CGFloat, color: UIColor, track: UIColor) {
        let width: CGFloat = 3
        let radius = (side - width) / 2
        context.saveGState()
        context.setLineWidth(width)
        context.setStrokeColor(track.cgColor)
        context.strokeEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
        let value = max(0.03, min(1, progress))
        context.setStrokeColor(color.cgColor)
        context.setLineCap(.round)
        context.addArc(center: center, radius: radius, startAngle: -.pi / 2, endAngle: -.pi / 2 + 2 * .pi * value, clockwise: false)
        context.strokePath()
        context.restoreGState()
    }

    /// A photo in `box`: the photo once it is here; before, the blurred small picture (or a quiet plate) with the
    /// round button and the size. `alone`: the time stands in its corner.
    static func drawPhoto(_ context: CGContext, row: MsgRow, box: CGRect, palette: MsgPalette, small: UIImage?, radius: CGFloat, alone: Bool) {
        let state = InlineMedia.shared.entry(row.key)
        let full = state.status == .ready ? InlineMedia.shared.picture(row.key) : nil
        context.saveGState()
        UIBezierPath(roundedRect: box, cornerRadius: radius).addClip()
        context.setFillColor(plate.cgColor)
        context.fill(box)
        let shown: UIImage? = full ?? small.map { InlineMedia.shared.blurred(row.key, small: $0, width: box.width) }
        if let image = shown, image.size.width > 0, image.size.height > 0 {
            let scale = max(box.width / image.size.width, box.height / image.size.height)
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            image.draw(in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height))
        }
        context.restoreGState()
        if full == nil {
            let center = CGPoint(x: box.midX, y: box.midY)
            context.setFillColor(veil.cgColor)
            context.fillEllipse(in: CGRect(x: center.x - 24, y: center.y - 24, width: 48, height: 48))
            switch state.status {
            case .loading:
                ring(context, center: center, side: 48, progress: state.progress, color: .white, track: UIColor(white: 1, alpha: 0.25))
                drawCentered(symbol("ion:close", 22, .medium, .white), at: center)
            case .failed, .ready:
                drawCentered(symbol("ion:refresh", 24, .medium, .white), at: center)
            case .idle:
                drawCentered(symbol("ion:arrow-down", 24, .medium, .white), at: center)
            }
            let words = state.status == .loading ? state.words : sizeWords(row)
            if !words.isEmpty {
                let text = NSAttributedString(string: words, attributes: [.font: pillFont, .foregroundColor: UIColor.white])
                let size = text.size()
                let pill = CGRect(x: box.minX + 7, y: box.minY + 7, width: ceil(size.width) + 12, height: ceil(size.height) + 6)
                context.setFillColor(veil.cgColor)
                context.addPath(UIBezierPath(roundedRect: pill, cornerRadius: 8).cgPath)
                context.fillPath()
                text.draw(at: CGPoint(x: pill.minX + 6, y: pill.minY + 3))
            }
        }
        if alone { timePill(context, row: row, box: box, palette: palette) }
    }

    /// A photo row keeps the photo's size in `mediaTime` (set by the rows, «2 КБ»).
    private static func sizeWords(_ row: MsgRow) -> String { row.mediaTime }

    /// The time of a photo alone: white in a dark pill 8 pt from the lower right corner, with the ticks of one's own.
    /// A video's poster (the small picture that came with it, unblurred) on the quiet plate (MediaBubble.tsx `MediaTile`).
    static func drawVideo(_ context: CGContext, row: MsgRow, box: CGRect, palette: MsgPalette, small: UIImage?, radius: CGFloat) {
        context.saveGState()
        UIBezierPath(roundedRect: box, cornerRadius: radius).addClip()
        context.setFillColor(plate.cgColor)
        context.fill(box)
        if let image = small, image.size.width > 0, image.size.height > 0 {
            let scale = max(box.width / image.size.width, box.height / image.size.height)
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            image.draw(in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height))
        }
        context.restoreGState()
    }

    static func timePill(_ context: CGContext, row: MsgRow, box: CGRect, palette: MsgPalette) {
        let color: UIColor = row.ticks == 4 ? palette.danger : .white
        let time = NSAttributedString(string: row.time, attributes: [.font: pillFont, .foregroundColor: color])
        let timeSize = time.size()
        let marks: CGFloat = row.mine && row.ticks > 0 ? 19 : 0
        let bell: CGFloat = row.silent ? 15 : 0
        let pill = CGRect(x: 0, y: 0, width: ceil(timeSize.width) + 14 + marks + bell, height: ceil(timeSize.height) + 4)
        let placed = pill.offsetBy(dx: box.maxX - 8 - pill.width, dy: box.maxY - 8 - pill.height)
        context.setFillColor(timeVeil.cgColor)
        context.addPath(UIBezierPath(roundedRect: placed, cornerRadius: 10).cgPath)
        context.fillPath()
        var x = placed.minX + 7
        if row.silent, let image = symbol("bell.slash.fill", 9, .regular, .white) {
            image.draw(at: CGPoint(x: x, y: placed.midY - image.size.height / 2))
            x += 15
        }
        time.draw(at: CGPoint(x: x, y: placed.midY - timeSize.height / 2))
        guard marks > 0 else { return }
        let bx = x + ceil(timeSize.width) + 4
        let my = placed.midY
        context.saveGState()
        context.setStrokeColor(color.cgColor)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        if row.ticks == 1 || row.ticks == 2 {
            context.setLineWidth(1.5)
            context.move(to: CGPoint(x: bx, y: my))
            context.addLine(to: CGPoint(x: bx + 3.5, y: my + 3.5))
            context.addLine(to: CGPoint(x: bx + 10, y: my - 4))
            if row.ticks == 2 {
                context.move(to: CGPoint(x: bx + 5, y: my + 1.5))
                context.addLine(to: CGPoint(x: bx + 7, y: my + 3.5))
                context.addLine(to: CGPoint(x: bx + 13.5, y: my - 4))
            }
            context.strokePath()
        } else {
            context.setLineWidth(1.4)
            let center = CGPoint(x: bx + 6, y: my)
            context.strokeEllipse(in: CGRect(x: center.x - 5, y: center.y - 5, width: 10, height: 10))
            context.move(to: CGPoint(x: center.x, y: center.y - 2.5))
            context.addLine(to: CGPoint(x: center.x, y: center.y))
            if row.ticks == 3 { context.addLine(to: CGPoint(x: center.x + 2, y: center.y + 1)) }
            context.strokePath()
        }
        context.restoreGState()
    }

    private static func fileIcon(_ name: String) -> String {
        let lower = name.lowercased()
        // MediaBubble.tsx `fileIcon` (formats.ts `mediaPreviewKind` for sound files).
        if lower.range(of: "\\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|alac|amr|caf|wma)$", options: .regularExpression) != nil { return "ion:musical-notes" }
        if lower.hasSuffix("pdf") { return "ion:document-text" }
        if lower.range(of: "\\.(zip|rar|7z|tar|gz)$", options: .regularExpression) != nil { return "ion:archive" }
        return "ion:document"
    }

    /// A file's card in `box`: the round button, the name, the size line (or the progress, or the failure).
    static func drawFile(_ context: CGContext, row: MsgRow, box: CGRect, palette: MsgPalette) {
        let state = InlineMedia.shared.entry(row.key)
        let pieces = parts(row)
        let center = CGPoint(x: box.minX + 24, y: box.midY)
        context.setFillColor(palette.accent.cgColor)
        context.fillEllipse(in: CGRect(x: center.x - 24, y: center.y - 24, width: 48, height: 48))
        switch state.status {
        case .loading:
            ring(context, center: center, side: 48, progress: state.progress, color: palette.onAccent, track: UIColor(white: 1, alpha: 0.3))
            drawCentered(symbol("ion:close", 20, .medium, palette.onAccent), at: center)
        case .ready:
            drawCentered(symbol(fileIcon(pieces.name), 22, .regular, palette.onAccent), at: center)
        case .failed:
            drawCentered(symbol("ion:refresh", 22, .medium, palette.onAccent), at: center)
        case .idle:
            drawCentered(symbol("ion:arrow-down", 22, .medium, palette.onAccent), at: center)
        }
        let textX = box.minX + 48 + 11
        let room = box.maxX - textX
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        let name = NSAttributedString(string: pieces.name, attributes: [.font: nameFont, .foregroundColor: palette.text, .paragraphStyle: style])
        let nameBox = name.boundingRect(with: CGSize(width: max(1, room), height: ceil(nameFont.lineHeight * 2) + 1), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
        let nameHeight = ceil(nameBox.height)
        let line: String
        var lineColor = palette.muted
        switch state.status {
        case .loading: line = state.words
        case .failed:
            line = "Ошибка · нажми, чтобы повторить"
            lineColor = palette.danger
        default: line = pieces.line
        }
        let lineHeight = ceil(lineFont.lineHeight)
        let top = box.midY - (nameHeight + 3 + lineHeight) / 2
        name.draw(with: CGRect(x: textX, y: top, width: room, height: nameHeight), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
        NSAttributedString(string: line, attributes: [.font: lineFont, .foregroundColor: lineColor])
            .draw(with: CGRect(x: textX, y: top + nameHeight + 3, width: room, height: lineHeight), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
    }
}

/// A file that has arrived, shown by the system's preview (which has the share sheet); the decrypted copy is
/// written under the app's own protected temporary folder only while the preview is open (`DecryptedFiles`).
final class InlineFilePreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    private static var showing: InlineFilePreview?
    private let written: (folder: URL, file: URL)

    private init(written: (folder: URL, file: URL)) {
        self.written = written
        super.init()
    }

    /// False: the copy could not be written.
    @discardableResult
    static func show(_ data: Data, fileName: String, over host: UIViewController) -> Bool {
        guard let written = DecryptedFiles.write(data, name: fileName) else { return false }
        if let previous = showing { DecryptedFiles.remove(previous.written.folder) }
        let owner = InlineFilePreview(written: written)
        showing = owner
        let preview = QLPreviewController()
        preview.dataSource = owner
        preview.delegate = owner
        host.present(preview, animated: true)
        return true
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        written.file as NSURL
    }

    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        DecryptedFiles.remove(written.folder)
        if InlineFilePreview.showing === self { InlineFilePreview.showing = nil }
    }
}
