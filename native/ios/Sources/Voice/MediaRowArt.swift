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

    /// The plate of a video or a round video whose small picture did not come with the message.
    static func plate(_ context: CGContext, round: Bool, palette: MsgPalette, box: CGRect) {
        context.setFillColor(palette.theirs.cgColor)
        context.addPath(UIBezierPath(roundedRect: box, cornerRadius: round ? min(box.width, box.height) / 2 : 12).cgPath)
        context.fillPath()
    }

    /// Over the picture of a video or a round video: the play mark in the middle and the length in a pill at the
    /// lower left; for a round video listened to in place, the ring of its progress.
    static func marks(_ context: CGContext, row: MsgRow, state: MsgMediaState?, palette: MsgPalette, box: CGRect) {
        let center = CGPoint(x: box.midX, y: box.midY)
        let live = state?.key == row.key ? state : nil
        let inPlace = live?.inPlace ?? false
        if live?.loading ?? false {
            context.setFillColor(UIColor(white: 0, alpha: 0.45).cgColor)
            context.fillEllipse(in: CGRect(x: center.x - 26, y: center.y - 26, width: 52, height: 52))
            loadingArc(context, center: center, radius: 17, color: .white)
        } else if !inPlace || !(live?.playing ?? false) {
            context.setFillColor(UIColor(white: 0, alpha: 0.45).cgColor)
            context.fillEllipse(in: CGRect(x: center.x - 26, y: center.y - 26, width: 52, height: 52))
            triangle(context, center: center, size: 22, color: .white)
        }
        if row.media == "note", inPlace, let live, live.progress > 0 {
            context.setStrokeColor(palette.accent.cgColor)
            context.setLineWidth(3)
            context.setLineCap(.round)
            let radius = min(box.width, box.height) / 2 - 1.5
            context.addArc(center: center, radius: radius, startAngle: -CGFloat.pi / 2, endAngle: -CGFloat.pi / 2 + 2 * CGFloat.pi * min(1, live.progress), clockwise: false)
            context.strokePath()
        }
        var words = row.mediaTime
        if let live, !live.time.isEmpty { words = live.time }
        if words.isEmpty { return }
        let text = NSAttributedString(string: words, attributes: [.font: pillFont, .foregroundColor: UIColor.white])
        let size = text.size()
        // A circle's lower left corner is outside the circle: its pill stands at the lower middle.
        let pillWidth = ceil(size.width) + 12
        let pillX = row.media == "note" ? box.midX - pillWidth / 2 : box.minX + 6
        let pill = CGRect(x: pillX, y: box.maxY - 6 - 18, width: pillWidth, height: 18)
        context.setFillColor(UIColor(white: 0, alpha: 0.5).cgColor)
        context.addPath(UIBezierPath(roundedRect: pill, cornerRadius: 9).cgPath)
        context.fillPath()
        text.draw(at: CGPoint(x: pill.minX + 6, y: pill.midY - size.height / 2))
    }

    /// A voice message: the round button, the waveform with its played part in full light, the time under it and
    /// the speed while it is the active one. Gives back where the parts stand.
    static func voice(_ context: CGContext, row: MsgRow, state: MsgMediaState?, palette: MsgPalette, box: CGRect) -> MsgMediaBoxes {
        var boxes = MsgMediaBoxes()
        let live = state?.key == row.key ? state : nil
        let button = CGRect(x: box.minX, y: box.minY + 3, width: 44, height: 44)
        boxes.play = button
        context.setFillColor(palette.text.cgColor)
        context.fillEllipse(in: button)
        let middle = CGPoint(x: button.midX, y: button.midY)
        if live?.loading ?? false {
            loadingArc(context, center: middle, radius: 11, color: palette.onAccent)
        } else if live?.playing ?? false {
            pauseMark(context, center: middle, size: 16, color: palette.onAccent)
        } else {
            triangle(context, center: CGPoint(x: middle.x + 1, y: middle.y), size: 17, color: palette.onAccent)
        }

        let strip = CGRect(x: button.maxX + 12, y: box.minY, width: max(20, box.width - 56), height: waveHeight)
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

        var words = row.mediaTime
        if let live, !live.time.isEmpty { words = live.time }
        NSAttributedString(string: words, attributes: [.font: timeFont, .foregroundColor: palette.muted, .kern: 0.3])
            .draw(at: CGPoint(x: strip.minX, y: strip.maxY + 3))
        if let live, !live.rate.isEmpty {
            let fast = live.rate != "1×"
            let label = NSAttributedString(string: live.rate, attributes: [.font: rateFont, .foregroundColor: fast ? palette.onAccent : palette.text])
            let size = label.size()
            let chip = CGRect(x: strip.maxX - ceil(size.width) - 14, y: strip.maxY + 1, width: ceil(size.width) + 14, height: 17)
            boxes.rate = chip
            let shape = UIBezierPath(roundedRect: chip, cornerRadius: 8)
            if fast {
                context.setFillColor(palette.text.cgColor)
                context.addPath(shape.cgPath)
                context.fillPath()
            } else {
                context.setStrokeColor(palette.muted.cgColor)
                context.setLineWidth(1)
                context.addPath(shape.cgPath)
                context.strokePath()
            }
            label.draw(at: CGPoint(x: chip.midX - size.width / 2, y: chip.midY - size.height / 2))
        }
        return boxes
    }
}
