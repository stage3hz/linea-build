import UIKit

/// How a chat shows its messages. The owner's default is the open look: no bubbles, own words at the right edge,
/// the other side's at the left with a thin line in their colour. Bubbles (the reference's look with a wallpaper)
/// come with a wallpaper or when the person turns them on in «Оформление» — then «Углы сообщений» and «Цвет своих
/// сообщений» apply (the reference's MessageRow.tsx `radius`, ColorSettings.tsx).
enum ChatBubbleLook {
    private static let bubblesKey = "invizent.chat-bubbles.v1"

    /// What the list draws now (main thread; set by the open chat before its rows are laid out).
    static var open = true
    /// «Углы сообщений»: 8, 14 or 20.
    static var radius: CGFloat = 20
    /// The line by the other side's words in the open look (their colour); nil: the accent.
    static var peerLine: UIColor?

    #if targetEnvironment(simulator)
    /// The simulator check: bubbles shown without the choice being kept.
    static var demoBubbles: Bool?
    #endif

    /// «Пузыри сообщений» in «Оформление» (off by default: the open look).
    static var bubblesChosen: Bool {
        get {
            #if targetEnvironment(simulator)
            if let demoBubbles { return demoBubbles }
            #endif
            return UserDefaults.standard.bool(forKey: bubblesKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: bubblesKey)
            NotificationCenter.default.post(name: Wallpapers.changed, object: nil)
        }
    }

    /// The radius chosen in «Углы сообщений» (the core keeps it among the device preferences: 8, 14 or 20).
    static var chosenRadius: CGFloat {
        let value = DevicePreferences.number("bubbleRadius") ?? 20
        return [8.0, 14.0, 20.0].contains(value) ? CGFloat(value) : 20
    }

    /// Bubbles for this chat: chosen, or a wallpaper is on (words over a picture need their plate).
    static func bubbles(chatId: String) -> Bool {
        return bubblesChosen || Wallpapers.choice(chatId: chatId).shown
    }

    /// A key of everything that changes the layout or the drawing of rows: a list redraws when it changes.
    static var key: String {
        return (open ? "open" : "bubbles") + "|\(radius)|" + (peerLine?.description ?? "-")
    }

    private static var themed: (source: String, fields: [String: Any])?

    /// The colours of the messages: the theme's (Theme.messages) in the open look; with bubbles, the bubble of
    /// one's own messages in the colour chosen in «Цвет своих сообщений», and the time and marks on it in colours
    /// that read on it (the core's `ink`, the reference's `ownBubbleInk`).
    static func palette(bubbles: Bool) -> MsgPalette {
        var palette = Theme.messages
        guard bubbles else { return palette }
        let own = DevicePreferences.item("bubbleColor")
        let source = ThemeStore.look.id + "|" + (DevicePreferences.word("accentColor") ?? "") + "|" + (DevicePreferences.word("bubbleColor") ?? "")
        var fields: [String: Any]
        if let themed, themed.source == source {
            fields = themed.fields
        } else {
            let args: [Any] = [ThemeStore.look.id, DevicePreferences.item("accentColor"), own]
            fields = Core.view("settingsTheme", args) as? [String: Any] ?? [:]
            themed = (source, fields)
        }
        if let mine = ThemeLook.color(fields["bubble"] as? String) { palette.mine = mine }
        if let theirs = ThemeLook.color(fields["incoming"] as? String) { palette.theirs = theirs }
        let ink = fields["ink"] as? [String: Any] ?? [:]
        if let meta = ThemeLook.color(ink["meta"] as? String) { palette.mineMeta = meta }
        if let accent = ThemeLook.color(ink["accent"] as? String) { palette.mineMark = accent }
        return palette
    }

    /// The plate of a message: every corner `radius`, the corner by the sender's edge small (6 at most) on the
    /// last message of a run (the reference's `borderBottomRightRadius: Math.min(6, radius)`).
    static func shape(_ box: CGRect, mine: Bool, tail: Bool) -> UIBezierPath {
        let r = min(radius, box.height / 2, box.width / 2)
        let small = tail ? min(6, r) : r
        let topLeft = r, topRight = r
        let bottomRight = mine ? small : r
        let bottomLeft = mine ? r : small
        let path = UIBezierPath()
        path.move(to: CGPoint(x: box.minX + topLeft, y: box.minY))
        path.addLine(to: CGPoint(x: box.maxX - topRight, y: box.minY))
        path.addArc(withCenter: CGPoint(x: box.maxX - topRight, y: box.minY + topRight), radius: topRight, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        path.addLine(to: CGPoint(x: box.maxX, y: box.maxY - bottomRight))
        path.addArc(withCenter: CGPoint(x: box.maxX - bottomRight, y: box.maxY - bottomRight), radius: bottomRight, startAngle: 0, endAngle: .pi / 2, clockwise: true)
        path.addLine(to: CGPoint(x: box.minX + bottomLeft, y: box.maxY))
        path.addArc(withCenter: CGPoint(x: box.minX + bottomLeft, y: box.maxY - bottomLeft), radius: bottomLeft, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        path.addLine(to: CGPoint(x: box.minX, y: box.minY + topLeft))
        path.addArc(withCenter: CGPoint(x: box.minX + topLeft, y: box.minY + topLeft), radius: topLeft, startAngle: .pi, endAngle: .pi * 1.5, clockwise: true)
        path.close()
        return path
    }

    /// The open look: the other side's words carry a thin line in their colour on the left (the reference's
    /// `borderLeftWidth: 2, borderLeftColor: tint`).
    static func drawPeerLine(_ context: CGContext, box: CGRect, fallback: UIColor) {
        context.setFillColor((peerLine ?? fallback).cgColor)
        context.fill(CGRect(x: box.minX, y: box.minY + 2, width: 2, height: max(0, box.height - 4)))
    }
}
