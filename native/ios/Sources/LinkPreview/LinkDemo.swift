import UIKit

#if targetEnvironment(simulator)
/// Samples for the simulator's screenshot check. Nothing here exists outside the simulator.
///   -demo 1 -chat 1 -linkdemo 1          the sample chat with two more rows: an own message with a long link and its
///                                        card with a picture, and one from the other side with a card without a picture
///   -demo 1 -chat 1 -linkdemo composer   the same, and the card above the field with its cross
///   -openchat 1 -linksend 1              with an account (the local test server only): the first chat of the list
///                                        gets a message with a prepared card, sent through the real encryption; the
///                                        chat then shows it as the server gave it back
enum LinkDemo {
    private static let longLink = "https://journal.example.org/2026/11/kak-my-pereezzhali-v-novyj-ofis-i-nichego-ne-poteryali?utm_source=chat&page=2"

    /// A drawn picture (no file, no network): a soft sky over hills, at the proportions sites use.
    private static func picture() -> Data? {
        let size = CGSize(width: 480, height: 252)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: size, format: format).image { (renderer: UIGraphicsImageRendererContext) -> Void in
            let context = renderer.cgContext
            let colors = [UIColor(hex: 0x24345E).cgColor, UIColor(hex: 0x8C6FB5).cgColor, UIColor(hex: 0xF2A97E).cgColor] as CFArray
            if let sky = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 0.6, 1]) {
                context.drawLinearGradient(sky, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
            }
            UIColor(hex: 0xFFE3B0).setFill()
            context.fillEllipse(in: CGRect(x: 330, y: 96, width: 64, height: 64))
            for (index, tone) in [UInt32(0x3A2F5B), UInt32(0x241D3E), UInt32(0x130F24)].enumerated() {
                let base = 150 + CGFloat(index) * 30
                let hill = UIBezierPath()
                hill.move(to: CGPoint(x: 0, y: size.height))
                hill.addLine(to: CGPoint(x: 0, y: base + 20))
                hill.addCurve(to: CGPoint(x: size.width, y: base), controlPoint1: CGPoint(x: 150, y: base - 50 + CGFloat(index) * 24), controlPoint2: CGPoint(x: 310, y: base + 60 - CGFloat(index) * 30))
                hill.addLine(to: CGPoint(x: size.width, y: size.height))
                hill.close()
                UIColor(hex: tone).setFill()
                hill.fill()
            }
        }
        return image.jpegData(compressionQuality: 0.7)
    }

    /// The card of the long link, made by the core exactly as for a real page.
    static func card() -> [String: Any] {
        let made = LinkCore.wire(url: longLink, site: "Журнал «Пример»", title: "Как мы переезжали в новый офис и ничего не потеряли",
                                 description: "Сорок коробок, три этажа и один лифт. Рассказываем, как спланировать переезд команды за выходные, что подписать на каждой коробке и почему проектор лучше нести в руках.",
                                 jpeg: picture())
        return made ?? ["url": longLink, "site": "Журнал «Пример»", "title": "Как мы переезжали в новый офис и ничего не потеряли", "description": ""]
    }

    static func composerCard() -> [String: Any] {
        return card()
    }

    /// Rows for the sample chat (`MsgRow.parse`), after its own.
    static func rows() -> [[String: Any]] {
        let short = "https://docs.example.org/plan"
        let plain = LinkCore.wire(url: short, site: "docs.example.org", title: "План встречи: три пункта на полчаса",
                                  description: "Повестка, кто что готовит и таблица с цифрами за квартал.", jpeg: nil)
            ?? ["url": short, "site": "docs.example.org", "title": "План встречи: три пункта на полчаса", "description": ""]
        func row(_ key: String, mine: Bool, text: String, link: String, time: String, card: [String: Any]) -> [String: Any] {
            let whole = text as NSString
            let range = whole.range(of: link)
            return ["key": key, "kind": 0, "mine": mine, "text": text, "time": time, "ticks": mine ? 2 : 0, "tail": true,
                    "fmt": range.location == NSNotFound ? [Int]() : [64, range.location, range.length], "urls": [link], "card": card]
        }
        return [
            row("link-demo-1", mine: true, text: "Смотри, как у них получилось: " + longLink, link: longLink, time: "09:44", card: card()),
            row("link-demo-2", mine: false, text: "Класс! А вот наш план " + short, link: short, time: "09:46", card: plain),
        ]
    }

    /// `-linksend 1` with an account on the local test server: sends one message with the prepared card to the
    /// chat that is open, through the real path (the core checks the card, encrypts it inside the message, the
    /// server takes the ciphertext). No page is fetched: the card is the sample above.
    static func sendSample(history: ChatHistory) {
        guard UserDefaults.standard.bool(forKey: "linksend"), Account.server.hasPrefix("https://localhost:") else { return }
        history.send(text: "Смотри, как у них получилось: " + longLink, meta: nil, linkPreview: card())
    }
}
#endif
