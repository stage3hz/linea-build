import UIKit
import CoreHaptics

/// The intro's touch on the phone's haptic engine (IntroModel.haptic): ONE long soft swell, never a train of taps —
/// a single Core Haptics continuous event (from 1.1 s, 3.0 s long, intensity 1.0, sharpness 0.5) whose strength follows
/// the curve through parameter curves on the intensity control. Where Core Haptics is not available: nothing at all.
/// Silent in power saving (Effects/Motion.swift). Every failure is silent. Android: intro/IntroHaptics.kt.
final class IntroHaptics {
    private var engine: CHHapticEngine?
    private var player: CHHapticPatternPlayer?

    /// The swell's character: mid sharpness, soft and smooth.
    static let sharpness: Float = 0.5
    /// How often the curve is sampled into control points, s.
    static let step: Double = 0.1

    /// How long the event lasts, s (1.1 → 4.1).
    static var length: Double { return IntroModel.swellEnd - IntroModel.swellStart }

    /// The one continuous event, at the pattern's start (the pattern starts at 1.1 s on the intro's clock).
    static func events() -> [CHHapticEvent] {
        return [CHHapticEvent(eventType: .hapticContinuous, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
        ], relativeTime: 0, duration: length)]
    }

    /// The curve's control points, every 0.1 s from the event's start (relative times), the first and the last 0.
    static func controlPoints() -> [CHHapticParameterCurve.ControlPoint] {
        let count = Int((length / step).rounded())
        var points: [CHHapticParameterCurve.ControlPoint] = []
        for i in 0...count {
            let at = i == count ? length : Double(i) * step
            let value: Double = (i == 0 || i == count) ? 0 : IntroModel.haptic(IntroModel.swellStart + at)
            points.append(CHHapticParameterCurve.ControlPoint(relativeTime: at, value: Float(Swift.min(1, Swift.max(0, value)))))
        }
        return points
    }

    /// Core Haptics takes at most 16 control points per parameter curve.
    static let pointsPerCurve = 16

    /// The parameter curves that shape the event's intensity: the control points in runs of at most 16, each run
    /// starting at the last point of the one before (its times relative to its own start).
    static func curves() -> [CHHapticParameterCurve] {
        let points = controlPoints()
        var out: [CHHapticParameterCurve] = []
        var first = 0
        while first < points.count - 1 {
            let last = Swift.min(points.count - 1, first + pointsPerCurve - 1)
            let origin = points[first].relativeTime
            let run = points[first...last].map { (point: CHHapticParameterCurve.ControlPoint) -> CHHapticParameterCurve.ControlPoint in
                CHHapticParameterCurve.ControlPoint(relativeTime: point.relativeTime - origin, value: point.value)
            }
            out.append(CHHapticParameterCurve(parameterID: .hapticIntensityControl, controlPoints: run, relativeTime: origin))
            first = last
        }
        return out
    }

    /// Plays the swell against the intro's clock: t = 0 at `begin` (CACurrentMediaTime of the intro's start). If the
    /// swell's start has already passed (the intro started late), nothing is played.
    func start(begin: CFTimeInterval) {
        stop()
        if Motion.saving { return }
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        var made: CHHapticEngine?
        do {
            let created = try CHHapticEngine()
            made = created
            created.playsHapticsOnly = true
            created.isAutoShutdownEnabled = false
            created.stoppedHandler = { (_: CHHapticEngine.StoppedReason) -> Void in }
            created.resetHandler = { () -> Void in }
            try created.start()
            let pattern = try CHHapticPattern(events: IntroHaptics.events(), parameterCurves: IntroHaptics.curves())
            let swell = try created.makePlayer(with: pattern)
            let wait = IntroModel.swellStart - (CACurrentMediaTime() - begin)
            guard wait > 0 else {
                created.stop(completionHandler: nil)
                return
            }
            try swell.start(atTime: created.currentTime + wait)
            engine = created
            player = swell
        } catch {
            made?.stop(completionHandler: nil)
            engine = nil
            player = nil
        }
    }

    /// Nothing more: the swell stops at once.
    func stop() {
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
        engine?.stop(completionHandler: nil)
        engine = nil
    }
}
