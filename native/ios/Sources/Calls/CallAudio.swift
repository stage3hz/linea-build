import AVFoundation
import AudioToolbox
import UIKit

/// The sound of a call on the phone: where it plays (the earpiece, the loudspeaker, headphones), the sensor that
/// darkens the screen at the ear, and giving the sound back when the call is over. What the reference asks of
/// react-native-incall-manager (CallProvider.tsx `inCall.start`, `setForceSpeakerphoneOn`, `stop`), with the
/// Bluetooth options the reference patches into it. Main queue.
enum CallAudio {
    private static var running = false
    private static var isVideo = false

    /// The call's audio begins: before the microphone is opened.
    /// A call starts on the system's own route: Bluetooth or wired headphones when they are connected, else the
    /// earpiece (a video call: the loudspeaker).
    static func start(video: Bool) {
        CallSounds.releaseRing()
        running = true
        isVideo = video
        let session = AVAudioSession.sharedInstance()
        // Without the Bluetooth options iOS never offers Bluetooth headphones as a route of a call.
        try? session.setCategory(.playAndRecord, mode: video ? .videoChat : .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
        try? session.setActive(true)
        route(nil, video: video)
    }

    /// true: the loudspeaker; false: the phone's earpiece; nil: the system's own route.
    static func route(_ forced: Bool?, video: Bool) {
        guard running else { return }
        isVideo = video
        let session = AVAudioSession.sharedInstance()
        let loud = forced ?? video
        // The mode carries the default route: a voice chat sounds in the earpiece, a video chat in the loudspeaker;
        // headphones win over both. Only «Динамик» overrides them.
        try? session.setMode(loud ? .videoChat : .voiceChat)
        try? session.overrideOutputAudioPort(forced == true ? .speaker : .none)
        // At the ear the screen goes dark and takes no touches — only while the sound is in the earpiece.
        UIDevice.current.isProximityMonitoringEnabled = !loud
    }

    /// The call is over: the sensor is released and other sound may come back.
    static func stop() {
        guard running else { return }
        running = false
        UIDevice.current.isProximityMonitoringEnabled = false
        let session = AVAudioSession.sharedInstance()
        try? session.overrideOutputAudioPort(.none)
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// Asks for the microphone (and the camera, for a video call) the first time a call needs them; the system's
    /// question appears only then. `done` gets nil, or the words that say what is not allowed. Main queue.
    static func allow(video: Bool, done: @escaping (String?) -> Void) {
        ask(.audio) { (granted: Bool) -> Void in
            guard granted else { return done("Нет доступа к микрофону. Разреши его для Инвиза в настройках телефона, чтобы звонить.") }
            guard video else { return done(nil) }
            allowCamera(done: done)
        }
    }

    static func allowCamera(done: @escaping (String?) -> Void) {
        ask(.video) { (granted: Bool) -> Void in
            done(granted ? nil : "Нет доступа к камере. Разреши её для Инвиза в настройках телефона, чтобы включить видео.")
        }
    }

    private static func ask(_ kind: AVMediaType, done: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: kind) {
        case .authorized:
            done(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: kind) { (granted: Bool) -> Void in
                DispatchQueue.main.async { done(granted) }
            }
        default:
            done(false)
        }
    }
}

/// The call's own sounds (made for the app, the reference's assets): the two ringbacks the caller hears — a lower,
/// slower one while the call is on its way and the usual one once the other phone has it — and the melody of an
/// incoming call. Seamless loops; only one plays at a time. Main queue.
enum CallSounds {
    private static var player: AVAudioPlayer?
    private static var buzz: Timer?
    /// What the phone's sound was set to before an incoming call rang (put back when the ringing ends unanswered).
    private static var before: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?

    /// `kind`: "connecting", "outgoing" or "incoming".
    static func play(_ kind: String) {
        stop()
        guard let address = Bundle.main.url(forResource: "call_" + kind, withExtension: "wav") else { return }
        if kind == "incoming" {
            // The melody of an incoming call follows the phone's silent switch (the vibration still rings); the
            // ringback always plays — it sounds inside the call's own audio.
            let session = AVAudioSession.sharedInstance()
            if before == nil { before = (session.category, session.mode, session.categoryOptions) }
            try? session.setCategory(.ambient, mode: .default, options: [])
            try? session.setActive(true)
        }
        guard let made = try? AVAudioPlayer(contentsOf: address) else { return }
        made.numberOfLoops = -1
        made.volume = kind == "incoming" ? 1 : 0.7
        made.play()
        player = made
    }

    static func stop() {
        player?.stop()
        player = nil
    }

    /// The phone hums while an incoming call rings: 0.6 s, a pause, again.
    static func vibrate() {
        buzz?.invalidate()
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        buzz = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { (_: Timer) -> Void in
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }
    }

    static func still() {
        buzz?.invalidate()
        buzz = nil
    }

    /// The ringing is over and the call was not answered here: the phone's sound is as it was before.
    static func restore() {
        guard let saved = before else { return }
        before = nil
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(saved.category, mode: saved.mode, options: saved.options)
    }

    /// The call was answered: its own audio takes over, there is nothing to put back.
    static func releaseRing() { before = nil }
}
