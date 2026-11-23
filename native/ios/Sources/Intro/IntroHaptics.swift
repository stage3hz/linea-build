import UIKit
import CoreHaptics

/// The intro's taps on the phone's haptic engine (IntroModel.taps): purely tactile — Core Haptics transient events
/// only (soft taps, sharpness 0.3; the one round thud, sharpness 0.1), never a continuous event. Where Core Haptics is
/// not available only the thud is given, by the system's soft impact. Silent in power saving (Effects/Motion.swift).
/// Every failure is silent. Android: intro/IntroHaptics.kt.
final class IntroHaptics {
    private var engine: CHHapticEngine?
    private var player: CHHapticPatternPlayer?
    private var fallback: DispatchWorkItem?

    /// The pattern of the whole intro: one transient event per tap, at its time.
    static func events() -> [CHHapticEvent] {
        return IntroModel.taps.map { (tap: IntroModel.Tap) -> CHHapticEvent in
            let sharpness: Float = tap.kind == .thud ? 0.1 : 0.3
            return CHHapticEvent(eventType: .hapticTransient, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(tap.strength)),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
            ], relativeTime: tap.time)
        }
    }

    /// Plays every tap against the intro's clock, t = 0 now.
    func start() {
        stop()
        if Motion.saving { return }
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return startFallback() }
        do {
            let made = try CHHapticEngine()
            made.playsHapticsOnly = true
            made.isAutoShutdownEnabled = true
            made.stoppedHandler = { (_: CHHapticEngine.StoppedReason) -> Void in }
            made.resetHandler = { () -> Void in }
            try made.start()
            let pattern = try CHHapticPattern(events: IntroHaptics.events(), parameters: [])
            let made2 = try made.makePlayer(with: pattern)
            try made2.start(atTime: CHHapticTimeImmediate)
            engine = made
            player = made2
        } catch {
            engine?.stop(completionHandler: nil)
            engine = nil
            player = nil
        }
    }

    /// No Core Haptics: the thud alone, as the system's soft impact.
    private func startFallback() {
        guard let thud = IntroModel.taps.first(where: { (tap: IntroModel.Tap) -> Bool in tap.kind == .thud }) else { return }
        let generator = UIImpactFeedbackGenerator(style: .soft)
        generator.prepare()
        let work = DispatchWorkItem { generator.impactOccurred(intensity: CGFloat(thud.strength)) }
        fallback = work
        DispatchQueue.main.asyncAfter(deadline: .now() + thud.time, execute: work)
    }

    /// Nothing more: the taps not yet played are dropped.
    func stop() {
        fallback?.cancel()
        fallback = nil
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
        engine?.stop(completionHandler: nil)
        engine = nil
    }
}
