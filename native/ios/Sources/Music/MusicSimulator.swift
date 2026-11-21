#if targetEnvironment(simulator)
import UIKit

/// Made-up tracks for looking at «Музыка» in the simulator without a network (`-musicdemo 1` / `player`).
/// No audio is bundled: the sample state only looks like playing. The covers are drawn here, in code.
/// Compiled for the simulator only.
enum MusicDemo {
    private static let samples: [(String, String, Double, [UInt32])] = [
        ("Северное сияние", "Лера Туман", 214, [0x0E7C66, 0x2BD4A0, 0x0B3B5C]),
        ("Полночь над рекой", "Квартал 9", 187, [0xE0562F, 0xF2B544, 0x7A1E48]),
        ("Тихий час", "Миша Ветров", 243, [0x2F5BE0, 0x58B7F2, 0x241E7A]),
        ("Бумажный самолёт", "Ореховый сад", 156, [0xC9C9C9, 0x6E6E6E, 0x2A2A2A]),
        ("Письма без адреса", "Нина Левада", 201, [0x8B2FE0, 0xF25FA8, 0x2E1E7A]),
        ("Трамвай до моря", "Дом у маяка", 229, [0xE0A52F, 0xF2E26B, 0xD9542B]),
    ]

    /// A cover in three vertical bands running into one another, with a soft circle — enough for the bar's light.
    private static func cover(_ colors: [UInt32]) -> UIImage {
        let size = CGSize(width: 300, height: 300)
        return UIGraphicsImageRenderer(size: size).image { context in
            let cg = context.cgContext
            let stops = colors.map { UIColor(hex: $0).cgColor } as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: stops, locations: [0, 0.5, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: 0), options: [])
            }
            cg.setFillColor(UIColor(white: 1, alpha: 0.14).cgColor)
            cg.fillEllipse(in: CGRect(x: 90, y: 90, width: 120, height: 120))
        }
    }

    static let tracks: [MusicTrack] = samples.enumerated().map { index, sample -> MusicTrack in
        let id = "demo:\(index)"
        MusicCovers.drawn[id] = cover(sample.3)
        return MusicTrack(id: id, source: "audius", sourceId: nil, title: sample.0, artist: sample.1, artworkUrl: nil, duration: sample.2, genre: nil, mood: nil, sourceUrl: nil, downloadable: false)
    }
}

/// What the simulator check asks of «AI» and «Музыка» by launch arguments (see SceneDelegate.simulatorStart):
///   -aidemo 1 | history     «AI» with a sample conversation (a block of code in it); `history`: the history sheet over it
///   -musicdemo 1 | player | equalizer | chats   «Музыка» with sample tracks and the strip of the playing one; `player`: the full player over it; `equalizer`: «Эквалайзер» over the player
/// With an account (or with -demo 1) the sections themselves open by `-tab ai` and `-tab music`.
extension SceneDelegate {
    func simulatorAIMusic() -> Bool {
        let args = UserDefaults.standard
        let music = args.string(forKey: "musicdemo")
        guard args.string(forKey: "aidemo") != nil || music != nil else { return false }
        let root = RootViewController()
        window?.rootViewController = NavigationController(rootViewController: root)
        root.loadViewIfNeeded()
        root.show(music != nil ? "music" : "ai")
        if music == "chats" {
            // The sample track plays, then the chats: how the bar looks with a track's colours.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { root.show("chats") }
        }
        if music == "player" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { root.musicPage()?.simulatorPlayer() }
        }
        if music == "equalizer" {
            // «Эквалайзер» over the full player, the custom curve (+4 / −2 / +6 dB).
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { root.musicPage()?.simulatorEqualizer() }
        }
        return true
    }
}
#endif
