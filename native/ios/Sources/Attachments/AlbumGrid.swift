import UIKit

/// Several photos (or videos) sent together, shown as one message (the reference's media/albumLayout.ts and
/// MediaBubble.tsx `AlbumGrid`). Every part is a message of its own with `meta.album` `{id, index, count}`;
/// consecutive parts of one album from one sender join one row.
struct MsgAlbum: Equatable {
    struct Part: Equatable {
        /// The row key of the part's own message (what opens it).
        let key: String
        let thumb: String
        let wide: CGFloat
        let video: Bool
        let time: String
    }
    let parts: [Part]

    static func parse(_ value: Any?) -> MsgAlbum? {
        guard let list = value as? [[String: Any]], list.count >= 2 else { return nil }
        let parts = list.compactMap { (item: [String: Any]) -> Part? in
            guard let key = item["key"] as? String else { return nil }
            return Part(key: key, thumb: item["thumb"] as? String ?? "", wide: CGFloat((item["wide"] as? NSNumber)?.doubleValue ?? 1),
                        video: item["video"] as? Bool ?? false, time: item["mediaTime"] as? String ?? "")
        }
        return parts.count >= 2 ? MsgAlbum(parts: parts) : nil
    }
}

/// One tile of the mosaic, from the album's corner.
struct MsgAlbumTile: Equatable {
    let index: Int
    let frame: CGRect
}

/// The mosaic: items keep their order and are split into rows of 1–4; every row fills the width exactly and its
/// height follows the aspect ratios in it. The split is chosen by dynamic programming so row heights stay close
/// to a target and the whole album stays within `maxHeight` (a port of `albumLayout`, number for number).
func msgAlbumLayout(_ aspects: [CGFloat], width: CGFloat, maxHeight: CGFloat, gap: CGFloat = 2) -> (tiles: [MsgAlbumTile], height: CGFloat) {
    let n = aspects.count
    if n == 0 { return ([], 0) }
    let ratio = aspects.map { (value: CGFloat) -> CGFloat in max(0.4, min(2.5, value.isFinite && value > 0 ? value : 1)) }
    let target = n <= 2 ? width / 1.25 : n <= 4 ? width / 1.6 : width / 2.4
    func rowHeight(_ from: Int, _ count: Int) -> CGFloat {
        let sum = ratio[from..<(from + count)].reduce(0, +)
        return (width - gap * CGFloat(count - 1)) / sum
    }
    var best = [(cost: Double, rows: [Int])?](repeating: nil, count: n + 1)
    best[n] = (cost: 0, rows: [])
    var i = n - 1
    while i >= 0 {
        var choice: (cost: Double, rows: [Int])? = nil
        for count in 1...min(4, n - i) {
            // A lone item in a row only for wide pictures (or when it is the only one).
            if count == 1 && n > 1 && (ratio[i] < 1.2 || (n > 3 && ratio[i] < 1.8)) { continue }
            guard let rest = best[i + count] else { continue }
            let h = rowHeight(i, count)
            let logged = log(Double(h / target))
            let cost = logged * logged + rest.cost
            if choice == nil || cost < choice!.cost { choice = (cost: cost, rows: [count] + rest.rows) }
        }
        if let choice {
            best[i] = choice
        } else {
            let step = min(2, n - i)
            best[i] = (cost: Double.infinity, rows: [step] + (best[i + step]?.rows ?? []))
        }
        i -= 1
    }
    let rows = best[0]?.rows ?? [n]
    var heights: [CGFloat] = []
    var index = 0
    for count in rows {
        heights.append(rowHeight(index, count))
        index += count
    }
    let gaps = gap * CGFloat(heights.count - 1)
    let total = heights.reduce(0, +) + gaps
    if total > maxHeight {
        let scale = (maxHeight - gaps) / (total - gaps)
        heights = heights.map { $0 * scale }
    }
    var tiles: [MsgAlbumTile] = []
    var y: CGFloat = 0
    index = 0
    for (row, count) in rows.enumerated() {
        let h = heights[row]
        let sum = ratio[index..<(index + count)].reduce(0, +)
        var x: CGFloat = 0
        for k in 0..<count {
            let last = k == count - 1
            let w = last ? width - x : ((width - gap * CGFloat(count - 1)) * ratio[index + k] / sum).rounded()
            tiles.append(MsgAlbumTile(index: index + k, frame: CGRect(x: x, y: y, width: w, height: h.rounded())))
            x += w + gap
        }
        y += h.rounded() + gap
        index += count
    }
    return (tiles, y - gap)
}

/// Where an album goes in a row, and how it is drawn.
struct MsgAlbumLayout: Equatable {
    var size = CGSize.zero
    var tiles: [MsgAlbumTile] = []

    static func make(_ album: MsgAlbum, screenWidth: CGFloat, inner: CGFloat) -> MsgAlbumLayout {
        // As wide as a single photo may be: at most 300, and 36 from each edge of the screen.
        let width = min(inner, (min(300, screenWidth - 2 * 36)).rounded())
        let made = msgAlbumLayout(album.parts.map { $0.wide }, width: width, maxHeight: width * 1.45)
        return MsgAlbumLayout(size: CGSize(width: width, height: made.height), tiles: made.tiles)
    }

    /// The part under a point (from the album's corner).
    func part(at point: CGPoint, album: MsgAlbum) -> String? {
        for tile in tiles where tile.frame.contains(point) && tile.index < album.parts.count { return album.parts[tile.index].key }
        return nil
    }

    func draw(_ album: MsgAlbum, pictures: [String: UIImage], in context: CGContext, at origin: CGPoint, palette: MsgPalette) {
        let whole = CGRect(origin: origin, size: size)
        context.saveGState()
        UIBezierPath(roundedRect: whole, cornerRadius: 16).addClip()
        for tile in tiles where tile.index < album.parts.count {
            let part = album.parts[tile.index]
            let box = tile.frame.offsetBy(dx: origin.x, dy: origin.y)
            if let image = pictures[part.key], image.size.width > 0, image.size.height > 0 {
                context.saveGState()
                context.clip(to: box)
                let scale = max(box.width / image.size.width, box.height / image.size.height)
                let drawn = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                image.draw(in: CGRect(x: box.midX - drawn.width / 2, y: box.midY - drawn.height / 2, width: drawn.width, height: drawn.height))
                context.restoreGState()
            } else {
                context.setFillColor(palette.theirs.cgColor)
                context.fill(box)
            }
            if part.video {
                let center = CGPoint(x: box.midX, y: box.midY)
                context.setFillColor(UIColor(white: 0, alpha: 0.45).cgColor)
                context.fillEllipse(in: CGRect(x: center.x - 20, y: center.y - 20, width: 40, height: 40))
                context.setFillColor(UIColor.white.cgColor)
                context.move(to: CGPoint(x: center.x - 6, y: center.y - 9))
                context.addLine(to: CGPoint(x: center.x + 10, y: center.y))
                context.addLine(to: CGPoint(x: center.x - 6, y: center.y + 9))
                context.closePath()
                context.fillPath()
                if !part.time.isEmpty {
                    let words = NSAttributedString(string: part.time, attributes: [.font: UIFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: UIColor.white])
                    let size = words.size()
                    let pill = CGRect(x: box.minX + 6, y: box.minY + 6, width: size.width + 12, height: size.height + 4)
                    context.setFillColor(UIColor(white: 0, alpha: 0.45).cgColor)
                    context.addPath(UIBezierPath(roundedRect: pill, cornerRadius: pill.height / 2).cgPath)
                    context.fillPath()
                    words.draw(at: CGPoint(x: pill.minX + 6, y: pill.minY + 2))
                }
            }
        }
        context.restoreGState()
    }

    /// The decoded small pictures of an album, by part key.
    static func pictures(_ album: MsgAlbum) -> [String: UIImage] {
        var out: [String: UIImage] = [:]
        for part in album.parts where !part.thumb.isEmpty {
            if let data = Data(base64Encoded: part.thumb, options: .ignoreUnknownCharacters), let image = UIImage(data: data) { out[part.key] = image }
        }
        return out
    }
}

/// The album fields of a chat's rows (made off the main queue by ChatHistory).
enum AlbumRows {
    /// One part: its row key, its small picture, its shape, whether it is a video.
    static func part(_ message: [String: Any], key: String) -> [String: Any] {
        let fields = AttachmentRows.fields(message, key: key)
        var part: [String: Any] = ["key": key, "thumb": fields["thumb"] as? String ?? "", "wide": (fields["thumbWide"] as? NSNumber)?.doubleValue ?? 1, "video": fields["media"] as? String == "video"]
        if let time = fields["mediaTime"] as? String { part["mediaTime"] = time }
        return part
    }

    /// Whether a message is a part of an album that may join the album row before it: a photo or a video, the same
    /// album id and sender, and not more parts than the album says it has.
    static func joins(_ message: [String: Any], sender: String, row: [String: Any]) -> Bool {
        guard let album = (message["meta"] as? [String: Any])?["album"] as? [String: Any], let id = album["id"] as? String,
              message["attachment"] is [String: Any], row["albumId"] as? String == id, row["albumSender"] as? String == sender else { return false }
        let count = (album["count"] as? NSNumber)?.intValue ?? 0
        let have = (row["album"] as? [[String: Any]])?.count ?? 1
        return have < count
    }

    /// Up to ten photos make an album; more are split into albums of ten (the last one at least two).
    static func groups(_ total: Int) -> [(id: String, index: Int, count: Int)?] {
        guard total >= 2 else { return Array(repeating: nil, count: total) }
        var out: [(id: String, index: Int, count: Int)?] = []
        var ids: [String] = []
        for _ in 0..<((total + 9) / 10) { ids.append(UUID().uuidString.lowercased()) }
        for index in 0..<total {
            let group = index / 10, start = group * 10, count = min(10, total - start)
            out.append(count >= 2 ? (id: ids[group], index: index - start, count: count) : nil)
        }
        return out
    }
}
