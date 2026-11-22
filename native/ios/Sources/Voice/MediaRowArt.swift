import UIKit

/// What is playing in one row of the chat right now. The list keeps one of these and draws only that row again
/// when it changes (`MsgListView.setMediaState`), so a playing voice message does not redraw the whole chat.
struct MsgMediaState: Equatable {
    /// The key of the row.
    var key = ""
    var playing = false
    /// The file is still being brought.
    var loading = false
    /// How much has been played, 0…1.
    var progress: CGFloat = 0
    /// «0:07 / 0:23», or how much has arrived while loading; empty: the row's own length is shown.
    var time = ""
    /// «1,5×» while a voice message is the active one; empty: no speed chip.
    var rate = ""
    /// A round video playing in place: its picture is the player's, so no play mark is drawn over it.
    var inPlace = false
}

/// Where the parts of a media row were drawn last, for taps.
struct MsgMediaBoxes {
    var thumb = CGRect.zero
    var play = CGRect.zero
    var wave = CGRect.zero
    var rate = CGRect.zero

    /// The part under a point: "rate", "wave" (with the place on it), "play" or "thumb".
    func part(at point: CGPoint) -> (part: String, fraction: CGFloat)? {
        if rate != .zero && rate.insetBy(dx: -10, dy: -10).contains(point) { return ("rate", 0) }
        if wave != .zero && wave.insetBy(dx: 0, dy: -8).contains(point) {
            return ("wave", min(1, max(0, (point.x - wave.minX) / max(1, wave.width))))
        }
        if play != .zero && play.insetBy(dx: -6, dy: -6).contains(point) { return ("play", 0) }
        if thumb != .zero && thumb.contains(point) { return ("thumb", 0) }
        return nil
    }
}

/// The drawing of voice messages, videos and round videos inside a row of the chat (`MsgRowCanvas` calls it).
/// Reference: mobile/src/voice/VoiceMessage.tsx (`VoiceBubbleView`: a 44 pt button, bars 2.5 pt wide every
/// 4.5 pt in a strip 30 pt tall, the played part in full light, the time under it, the speed while it plays),
/// mobile/src/media/MediaBubble.tsx and mobile/src/videonote/VideoNote.tsx (the play mark, the length in a pill).
enum MediaRowArt {
    private static let barWidth: CGFloat = 2.5
    private static let barStep: CGFloat = 4.5
    private static let waveHeight: CGFloat = 30
    private static let timeFont = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    private static let rateFont = UIFont.systemFont(ofSize: 11, weight: .heavy)
    private static let pillFont = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
    private static var barCache: [String: [CGFloat]] = [:]

    /// The bars of a waveform fitted into `count` bars (the core decodes and fits them, as the reference does).
    private static func bars(_ wave: String, count: Int) -> [CGFloat] {
        let cacheKey = wave + "/" + String(count)
        if let held = barCache[cacheKey] { return held }
        let letters: Any = wave.isEmpty ? NSNull() : wave
        let numbers = FileCore.call("waveformBars", [letters, count]) as? [NSNumber] ?? []
        var made: [CGFloat] = []
        for number in numbers { made.append(CGFloat(number.doubleValue)) }
        if made.isEmpty { made = Array(repeating: 0.12, count: max(12, min(48, count))) }
        if barCache.count > 300 { barCache.removeAll() }
        barCache[cacheKey] = made
        return made
    }

    /// What VoiceOver says about a media row.
    static func spoken(_ row: MsgRow) -> String {
        switch row.media {
        case "voice": return row.mediaTime.isEmpty ? "Голосовое сообщение" : "Голосовое сообщение, " + row.mediaTime
        case "note": return "Видеосообщение"
        case "video": return "Видео"
        default: return ""
        }
    }

    private static func triangle(_ context: CGContext, center: CGPoint, size: CGFloat, color: UIColor) {
        context.setFillColor(color.cgColor)
        context.move(to: CGPoint(x: center.x - size * 0.38, y: center.y - size * 0.5))
        context.addLine(to: CGPoint(x: center.x + size * 0.55, y: center.y))
        context.addLine(to: CGPoint(x: center.x - size * 0.38, y: center.y + size * 0.5))
        context.closePath()
        context.fillPath()
    }

    private static func pauseMark(_ context: CGContext, center: CGPoint, size: CGFloat, color: UIColor) {
        context.setFillColor(color.cgColor)
        let wide = size * 0.3
        context.addPath(UIBezierPath(roundedRect: CGRect(x: center.x - size * 0.42, y: center.y - size * 0.5, width: wide, height: size), cornerRadius: 1.5).cgPath)
        context.addPath(UIBezierPath(roundedRect: CGRect(x: center.x + size * 0.12, y: center.y - size * 0.5, width: wide, height: size), cornerRadius: 1.5).cgPath)
        context.fillPath()
    }

    /// A turning arc while a file is being brought.
    private static func loadingArc(_ context: CGContext, center: CGPoint, radius: CGFloat, color: UIColor) {
        context.setStrokeColor(color.cgColor)
        context.setLineWidth(2.2)
        context.setLineCap(.round)
        context.addArc(center: center, radius: radius, startAngle: -CGFloat.pi / 2, endAngle: CGFloat.pi * 0.9, clockwise: false)
        context.strokePath()
    }

    /// The plate of a video or a round video whose small picture did not come with the message. A circle: the
    /// reference's placeholder — surface2 with the muted «videocam» glyph, 14 % of the circle (VideoNote.tsx).
    static func plate(_ context: CGContext, round: Bool, palette: MsgPalette, box: CGRect) {
        context.setFillColor((round ? Theme.surface2 : palette.theirs).cgColor)
        context.addPath(UIBezierPath(roundedRect: box, cornerRadius: round ? min(box.width, box.height) / 2 : 12).cgPath)
        context.fillPath()
        if round {
            let size = (min(box.width, box.height) * 0.14).rounded()
            IonIcon.image("videocam", size: size).withTintColor(Theme.muted, renderingMode: .alwaysOriginal)
                .draw(in: CGRect(x: box.midX - size / 2, y: box.midY - size / 2, width: size, height: size))
        }
    }

    /// An Ionicons glyph drawn white (or in `color`), `size` points square, centred on `center`.
    private static func glyph(_ name: String, size: CGFloat, center: CGPoint, color: UIColor = .white) {
        IonIcon.image(name, size: size).withTintColor(color, renderingMode: .alwaysOriginal)
            .draw(in: CGRect(x: center.x - size / 2, y: center.y - size / 2, width: size, height: size))
    }

    /// MediaBubble.tsx `ProgressRing`: a 3 pt ring on a 25 % white track, from 12 o'clock, at least 3 %.
    private static func progressRing(_ context: CGContext, center: CGPoint, size: CGFloat, progress: CGFloat) {
        let radius = (size - 3) / 2
        context.setLineWidth(3)
        context.setStrokeColor(UIColor(white: 1, alpha: 0.25).cgColor)
        context.strokeEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
        let value = max(0.03, min(1, progress))
        context.setStrokeColor(UIColor.white.cgColor)
        context.setLineCap(.round)
        context.addArc(center: center, radius: radius, startAngle: -CGFloat.pi / 2, endAngle: -CGFloat.pi / 2 + 2 * CGFloat.pi * value, clockwise: false)
        context.strokePath()
    }

    /// A round video at rest (VideoNote.tsx `VideoNoteBubble`): no play mark over a circle that is there; one not
    /// brought yet carries the 44 pt download mark (while it comes: its progress ring and a cross); at the lower
    /// left of its square the length in a pill, with the speaker-off mark once the circle is brought.
    static func noteMarks(_ context: CGContext, key: String, length: String, state: MsgMediaState?, box: CGRect) {
        let center = CGPoint(x: box.midX, y: box.midY)
        let live = state?.key == key ? state : nil
        let ready = NotePlayback.readyKeys.contains(key)
        if live?.loading ?? false {
            context.setFillColor(UIColor(red: 10 / 255, green: 20 / 255, blue: 35 / 255, alpha: 0.55).cgColor)
            context.fillEllipse(in: CGRect(x: center.x - 22, y: center.y - 22, width: 44, height: 44))
            progressRing(context, center: center, size: 44, progress: live?.progress ?? 0)
            glyph("close", size: 20, center: center)
        } else if !ready {
            context.setFillColor(UIColor(red: 10 / 255, green: 20 / 255, blue: 35 / 255, alpha: 0.55).cgColor)
            context.fillEllipse(in: CGRect(x: center.x - 22, y: center.y - 22, width: 44, height: 44))
            glyph("arrow-down", size: 22, center: center)
        }
        let words = NSAttributedString(string: length.isEmpty ? "0:00" : length, attributes: [.font: UIFont.systemFont(ofSize: 11), .foregroundColor: UIColor.white])
        let size = words.size()
        let tall = ceil(UIFont.systemFont(ofSize: 11).lineHeight) + 4
        let pill = CGRect(x: box.minX + 6, y: box.maxY - 6 - tall, width: 7 + ceil(size.width) + (ready ? 4 + 11 : 0) + 7, height: tall)
        context.setFillColor(UIColor(white: 0, alpha: 0.42).cgColor)
        context.addPath(UIBezierPath(roundedRect: pill, cornerRadius: 9).cgPath)
        context.fillPath()
        words.draw(at: CGPoint(x: pill.minX + 7, y: pill.midY - size.height / 2))
        if ready { glyph("volume-mute", size: 11, center: CGPoint(x: pill.minX + 7 + ceil(size.width) + 4 + 5.5, y: pill.midY)) }
    }

    /// Over the picture of a video or a round video: the play mark in the middle and the length in a pill at the
    /// lower left; for a round video listened to in place, the ring of its progress.
    static func marks(_ context: CGContext, row: MsgRow, state: MsgMediaState?, palette: MsgPalette, box: CGRect, hosted: Bool = false) {
        // A round video: the reference's resting look; while its player stands over it, the player draws it all.
        if row.media == "note" {
            if !hosted { noteMarks(context, key: row.key, length: row.mediaTime, state: state, box: box) }
            return
        }
        // MediaBubble.tsx `MediaTile` (a video): the 48 pt round of rgba(10,15,30,.55) with «play» 24 (while it is
        // brought: its ring and «close» 22), and «0:42 · 12 МБ» at the upper left (7 in, 6 × 3 inside, radius 8).
        let center = CGPoint(x: box.midX, y: box.midY)
        let live = state?.key == row.key ? state : nil
        let veil = UIColor(red: 10 / 255, green: 15 / 255, blue: 30 / 255, alpha: 0.55)
        context.setFillColor(veil.cgColor)
        context.fillEllipse(in: CGRect(x: center.x - 24, y: center.y - 24, width: 48, height: 48))
        if live?.loading ?? false {
            progressRing(context, center: center, size: 48, progress: live?.progress ?? 0)
            glyph("close", size: 22, center: center)
        } else {
            glyph("play", size: 24, center: center)
        }
        var words = row.mediaTime
        if let live, live.loading, !live.time.isEmpty { words = live.time }
        if words.isEmpty { return }
        let font = UIFont.systemFont(ofSize: 11)
        let text = NSAttributedString(string: words, attributes: [.font: font, .foregroundColor: UIColor.white])
        let size = text.size()
        let pill = CGRect(x: box.minX + 7, y: box.minY + 7, width: ceil(size.width) + 12, height: ceil(font.lineHeight) + 6)
        context.setFillColor(veil.cgColor)
        context.addPath(UIBezierPath(roundedRect: pill, cornerRadius: 8).cgPath)
        context.fillPath()
        text.draw(at: CGPoint(x: pill.minX + 6, y: pill.midY - size.height / 2))
    }

    /// VoiceMessage.tsx `VoiceBubbleView`: 262 pt wide, 4 pt above and below; the right column is the 30 pt wave,
    /// 3 pt, then a 16 pt line with the time (and the speed while it is the active one): 49 pt.
    static let voiceWidth: CGFloat = 262
    static let voiceHeight: CGFloat = 57
    private static let monoFont = UIFont(name: "Menlo", size: 11) ?? UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)

    /// A voice message: the round button (the text colour, the page colour's play/pause glyph), the waveform with
    /// its played part in full light, the time under it and the speed while it is the active one. Gives back where
    /// the parts stand.
    static func voice(_ context: CGContext, row: MsgRow, state: MsgMediaState?, palette: MsgPalette, box: CGRect) -> MsgMediaBoxes {
        var boxes = MsgMediaBoxes()
        let live = state?.key == row.key ? state : nil
        let column = CGRect(x: box.minX + 44 + 12, y: box.minY + 4, width: max(20, box.width - 56), height: 49)
        let button = CGRect(x: box.minX, y: column.midY - 22, width: 44, height: 44)
        boxes.play = button
        context.setFillColor(palette.text.cgColor)
        context.fillEllipse(in: button)
        let middle = CGPoint(x: button.midX, y: button.midY)
        if live?.loading ?? false {
            loadingArc(context, center: middle, radius: 8, color: Theme.bg)
        } else if live?.playing ?? false {
            glyph("pause", size: 20, center: middle, color: Theme.bg)
        } else {
            glyph("play", size: 20, center: CGPoint(x: middle.x + 1, y: middle.y), color: Theme.bg)
        }

        let strip = CGRect(x: column.minX, y: column.minY, width: column.width, height: waveHeight)
        boxes.wave = strip
        let count = max(12, Int(strip.width / barStep))
        let values = bars(row.wave, count: count)
        let step = values.count > 1 ? (strip.width - barWidth) / CGFloat(values.count - 1) : 0
        let path = UIBezierPath()
        for (index, value) in values.enumerated() {
            let tall = max(barWidth, min(1, max(0, value)) * (waveHeight - 2))
            let bar = CGRect(x: strip.minX + CGFloat(index) * step, y: strip.midY - tall / 2, width: barWidth, height: tall)
            path.append(UIBezierPath(roundedRect: bar, cornerRadius: barWidth / 2))
        }
        context.setFillColor(palette.text.withAlphaComponent(0.3).cgColor)
        context.addPath(path.cgPath)
        context.fillPath()
        let played = min(1, max(0, live?.progress ?? 0))
        if played > 0 {
            context.saveGState()
            context.clip(to: CGRect(x: strip.minX, y: strip.minY, width: strip.width * played, height: strip.height))
            context.setFillColor(palette.text.cgColor)
            context.addPath(path.cgPath)
            context.fillPath()
            context.restoreGState()
        }

        let line = CGRect(x: column.minX, y: strip.maxY + 3, width: column.width, height: 16)
        var words = row.mediaTime
        if let live, !live.time.isEmpty { words = live.time }
        let time = NSAttributedString(string: words, attributes: [.font: monoFont, .foregroundColor: palette.muted, .kern: 0.3])
        time.draw(at: CGPoint(x: line.minX, y: line.midY - time.size().height / 2))
        if let live, !live.rate.isEmpty {
            let fast = live.rate != "1×"
            let label = NSAttributedString(string: live.rate, attributes: [.font: rateFont, .foregroundColor: fast ? Theme.bg : palette.text])
            let size = label.size()
            // paddingHorizontal 7, paddingVertical 1, a 1 pt border, radius 8.
            let chipSize = CGSize(width: ceil(size.width) + 16, height: ceil(rateFont.lineHeight) + 4)
            let chip = CGRect(x: line.maxX - chipSize.width, y: line.midY - chipSize.height / 2, width: chipSize.width, height: chipSize.height)
            boxes.rate = chip
            let shape = UIBezierPath(roundedRect: chip.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 7.5)
            context.setLineWidth(1)
            context.setStrokeColor((fast ? palette.text : ThemeStore.look.border).cgColor)
            if fast {
                context.setFillColor(palette.text.cgColor)
                context.addPath(shape.cgPath)
                context.fillPath()
            }
            context.addPath(shape.cgPath)
            context.strokePath()
            label.draw(at: CGPoint(x: chip.midX - size.width / 2, y: chip.midY - size.height / 2))
        }
        return boxes
    }
}
