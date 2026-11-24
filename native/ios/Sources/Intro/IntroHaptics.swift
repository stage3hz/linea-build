import UIKit
import CoreHaptics

/// The intro's touch on the phone's haptic engine: ONE long soft swell (IntroModel.haptic) that begins exactly when
/// the letters begin to crumble and lets go as N comes to the centre — a single Core Haptics continuous event
/// (intensity 1.0, sharpness 0.5) whose strength follows the curve through parameter curves on the intensity control,
/// never a train of taps — and one short soft tick when the honeycomb layer is passed. Nothing else. Where Core Haptics
/// is not available the swell is nothing at all. Silent in power saving (Effects/Motion.swift). Every failure is
/// silent. Android: intro/IntroHaptics.kt.
final class IntroHaptics {
    private var engine: CHHapticEngine?
    private var player: CHHapticPatternPlayer?
    private var tap: UIImpactFeedbackGenerator?

    /// The swell's character: mid sharpness, soft and smooth.
    static let sharpness: Float = 0.5
    /// How often the curve is sampled into control points, s.
    static let step: Double = 0.1
    /// How strong the tick is (0…1).
    static let tickStrength: CGFloat = 0.6

    /// How long the event lasts, s (from the first crumbling square to N at the centre).
    static var length: Double { return IntroModel.swellEnd - IntroModel.swellStart }

    /// The one continuous event, at the pattern's start (the pattern starts when the letters begin to crumble).
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

    /// The engine is made and started ahead of the swell, so the swell begins on its moment.
    func prepare() {
        if engine != nil || Motion.saving { return }
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        do {
            let created = try CHHapticEngine()
            created.playsHapticsOnly = true
            created.isAutoShutdownEnabled = false
            created.stoppedHandler = { (_: CHHapticEngine.StoppedReason) -> Void in }
            created.resetHandler = { () -> Void in }
            try created.start()
            engine = created
        } catch {
            engine = nil
        }
    }

    /// The letters begin to crumble now: the swell plays from its start.
    func swell() {
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
        if Motion.saving { return }
        prepare()
        guard let running = engine else { return }
        do {
            // The system may have stopped the engine meanwhile; starting one that runs does nothing.
            try running.start()
            let pattern = try CHHapticPattern(events: IntroHaptics.events(), parameterCurves: IntroHaptics.curves())
            let made = try running.makePlayer(with: pattern)
            try made.start(atTime: CHHapticTimeImmediate)
            player = made
            // The engine rests once the swell has played.
            running.notifyWhenPlayersFinished { (_: Error?) -> CHHapticEngine.FinishedAction in
                return .stopEngine
            }
        } catch {
            stop()
        }
    }

    /// The honeycomb layer is passed: one short soft tick (the system's own soft touch).
    func tick() {
        if Motion.saving { return }
        let made = UIImpactFeedbackGenerator(style: .soft)
        made.impactOccurred(intensity: IntroHaptics.tickStrength)
        tap = made
    }

    /// Nothing more: whatever plays stops at once.
    func stop() {
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
        engine?.stop(completionHandler: nil)
        engine = nil
        tap = nil
    }
}
