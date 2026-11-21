import AVFoundation
import UIKit

/// Short chimes in voice rooms (the reference's communities/voiceSounds.ts and its own synthesized sounds,
/// assets/sounds/voice_*.wav): rising when someone (or you) walks in, falling when someone leaves — nobody walks in
/// silently. Several people at once give one chime, not a burst (250 ms apart at least). Volume 0.6.
enum VoiceSounds {
    enum Kind: String {
        case join = "voice_join"
        case leave = "voice_leave"
    }

    private static var lastAt = Date.distantPast
    private static var playing: [AVAudioPlayer] = []

    /// Main thread. A missing sound never breaks the room.
    static func play(_ kind: Kind) {
        let now = Date()
        if now.timeIntervalSince(lastAt) < 0.25 { return }
        lastAt = now
        guard let address = Bundle.main.url(forResource: kind.rawValue, withExtension: "wav"),
              let player = try? AVAudioPlayer(contentsOf: address) else { return }
        player.volume = 0.6
        player.play()
        playing.append(player)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            VoiceSounds.playing.removeAll { (item: AVAudioPlayer) -> Bool in item === player }
        }
    }
}
