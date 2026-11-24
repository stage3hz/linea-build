import Foundation

/// The first-launch intro, its pure side: no views, no clock, no graphics. The times of the ident (the word appears
/// behind a streak of light, stands, falls into squares; N stays and comes to the centre), the four steps the person
/// makes by swiping up (`IntroFlow`), the camera, the lights, the swell of the haptics and the rules of when the intro
/// is shown. Scene units: N is 10 high, its middle at x 0, the floor at y 0. The drawing is Intro/IntroRenderer.swift.
/// Android: intro/IntroModel.kt — the same numbers, line for line.
enum IntroModel {
    // MARK: The ident's clock, s

    /// The streak of light starts to sweep, and how long it takes to cross the word.
    static let revealStart: Double = 0.25
    static let revealLength: Double = 0.95
    /// The streak is gone and the word is whole.
    static let revealEnd: Double = 1.3
    /// The letters begin to crumble: the right front starts toward N (the word has stood for about a second).
    static let crumbleStart: Double = 2.2
    static let rightLength: Double = 1.4
    /// The left front starts a little later and is quicker (one letter only).
    static let leftStart: Double = 2.6
    static let leftLength: Double = 0.9
    /// The camera goes from the whole word to N.
    static let centreStart: Double = 3.4
    static let centreLength: Double = 1.4
    /// N is at the centre.
    static let centred: Double = centreStart + centreLength
    /// The solid N turns into N made of particles.
    static let grainStart: Double = 3.8
    static let grainLength: Double = 0.9
    /// The ident is over: from here the person leads.
    static let identEnd: Double = 4.9

    // MARK: The steps

    static let steps: Int = 4
    /// One step animates to its end in this long.
    static let stepSeconds: Double = 1.3
    /// A step of the still stages (reduced motion): a calm cross-fade.
    static let stillSeconds: Double = 0.7
    /// A step that was dragged almost to its end still takes at least this long to finish.
    static let stepShortest: Double = 0.3
    /// The hint comes back after this long without a touch.
    static let hintIdle: Double = 5.0
    /// The sign-in screen comes out of the blur in this long.
    static let handover: Double = 0.6

    // MARK: The scene

    /// The page behind everything (red, green, blue of 255).
    static let background: [Double] = [5, 6, 10]
    /// The share of the screen's width left free on each side of the word.
    static let margin: Double = 0.08
    /// The camera's vertical field of view at rest, degrees; it widens by up to `fovRush` with the speed of a step.
    static let fov: Double = 30.0
    static let fovRush: Double = 11.0
    /// How far the camera stands from N when N is at the centre (less on a wide screen, where the word itself is nearer).
    static let nFarthest: Double = 74.0
    /// Where the camera stops in front of N at the end of step 1.
    static let nNear: Double = 5.5
    /// The flat honeycomb layer in front of N.
    static let shieldZ: Double = 22.0
    /// N's middle.
    static let nY: Double = 5.0

    static func clamp(_ x: Double, _ a: Double, _ b: Double) -> Double { return Swift.min(b, Swift.max(a, x)) }
    static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { return a + (b - a) * t }
    /// Smooth start and stop.
    static func ease(_ value: Double) -> Double { let x = clamp(value, 0, 1); return x * x * (3 - 2 * x) }
    /// A smoother one, for a whole step.
    static func smoother(_ value: Double) -> Double { let x = clamp(value, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10) }

    /// A small seeded generator: the same numbers in [0, 1) for the same seed, so the scene is the same on every start.
    struct Random {
        private var a: UInt32
        init(seed: UInt32) { a = seed }
        mutating func next() -> Double {
            a = a &+ 0x6D2B79F5
            var t: UInt32 = (a ^ (a >> 15)) &* (1 | a)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
            return Double(t ^ (t >> 14)) / 4294967296.0
        }
    }

    // MARK: The ident

    /// Where the streak of light is across the word, 0 (left of it) … 1 (right of it).
    static func reveal(_ t: Double) -> Double { return ease((t - revealStart) / revealLength) }
    /// How bright the streak is.
    static func sweep(_ t: Double) -> Double {
        return t < revealEnd ? 0.55 * sin(Double.pi * clamp((t - revealStart) / revealLength, 0, 1)) : 0
    }
    /// How far the right and the left fronts have run toward N, 0…1.
    static func rightFront(_ t: Double) -> Double { return clamp((t - crumbleStart) / rightLength, 0, 1) }
    static func leftFront(_ t: Double) -> Double { return clamp((t - leftStart) / leftLength, 0, 1) }
    /// The camera's way from the word to N, 0…1.
    static func centring(_ t: Double) -> Double { return ease((t - centreStart) / centreLength) }
    /// N made of particles, 0 (the solid N) … 1.
    static func grain(_ t: Double) -> Double { return ease((t - grainStart) / grainLength) }

    // MARK: The steps' lights

    /// N's particles spread into the cipher, 0…1. It starts before the camera reaches N, so there is always something
    /// lit in front of the camera.
    static func spread(_ p: Double) -> Double { return clamp((p - 0.8) / 0.7, 0, 1) }
    /// The cipher melts into the far field, 0…1.
    static func melt(_ p: Double) -> Double { return ease((p - 3.25) / 0.75) }
    /// The whole picture goes soft and dim, 0…1.
    static func blur(_ p: Double) -> Double { return ease((p - 3.2) / 0.7) }
    /// How bright the particles are.
    static func gain(_ t: Double, _ p: Double) -> Double {
        let flight = lerp(0.62, lerp(0.5, 0.7, ease((p - 0.9) / 0.5)), ease(p / 0.15))
        let dip = 1.0 - 0.12 * ease((p - 0.2) / 0.5) * (1.0 - ease((p - 0.85) / 0.3))
        return ease(t / 0.9) * (1.0 - 0.25 * melt(p)) * dip * (p <= 0 ? 0.62 : flight)
    }
    /// How soft a particle's dot is (0 the softest).
    static func sharp(_ p: Double) -> Double { return 0.6 * (1 - ease(p / 0.4)) }
    /// The honeycomb layer's light by where the camera is: it grows as the camera comes, flares at the pass, and is gone.
    static func shield(_ p: Double, cameraZ: Double) -> Double {
        if p <= 0 || p >= 1.2 { return 0 }
        let dz = cameraZ - shieldZ
        return dz > 0 ? 0.5 * exp(-pow((dz - 10) / 20, 2)) : 0.39 * exp(-pow(dz / 3, 2))
    }
    /// The short flash of the whole picture at the pass.
    static func flash(_ p: Double, cameraZ: Double) -> Double {
        return (p > 0 && p < 1) ? 0.12 * exp(-pow((cameraZ - shieldZ) / 2.4, 2)) : 0
    }

    // MARK: The camera

    struct Camera {
        var x: Double = 0, y: Double = 0, z: Double = 0
        var lookX: Double = 0, lookY: Double = 0, lookZ: Double = 0
        /// The turn about the view axis, radians, and the vertical field of view, degrees.
        var roll: Double = 0
        var fov: Double = IntroModel.fov
    }

    private static let tanHalf: Double = tan(fov / 2 * Double.pi / 180)

    /// How far the camera stands for the whole word: the word takes the screen's width less the margins, whatever the
    /// screen's shape (`aspect` = width / height); on a very wide screen the word's height sets it.
    static func wordDistance(total: Double, aspect: Double) -> Double {
        return Swift.max(total / (2 * tanHalf * aspect * (1 - 2 * margin)), 16.0 / (2 * tanHalf))
    }

    /// How far the camera stands from N at the centre: N never wider than 0.7 of the screen, never farther than the word.
    static func nDistance(total: Double, aspect: Double) -> Double {
        return Swift.max(Swift.min(nFarthest, wordDistance(total: total, aspect: aspect) * 0.8), 10.7 / (2 * tanHalf * aspect * 0.7))
    }

    /// The camera's z on the way through the steps.
    static func cameraZ(_ p: Double, nDistance: Double) -> Double {
        if p < 1 { return nNear + (nDistance - nNear) * pow(1 - Swift.max(p, 0), 1.7) }
        if p < 2 { return nNear - 23.5 * ease(p - 1) }
        return -18 - (p - 2) * 66
    }

    /// The progress at which the camera passes the honeycomb layer.
    static func shieldPass(nDistance: Double) -> Double {
        if nDistance <= shieldZ + 1 { return 0.05 }
        return clamp(1 - pow((shieldZ - nNear) / (nDistance - nNear), 1 / 1.7), 0.05, 0.95)
    }

    /// The camera for the ident's time `t` and the progress `p`. `left` and `right` are the word's ends (N's middle is
    /// x 0), `clock` the running time (a slight sway on the way to N), `speed` the speed of the step (per second).
    static func camera(t: Double, p: Double, clock: Double, speed: Double, left: Double, right: Double, aspect: Double, out: inout Camera) {
        let total = right - left
        let far = wordDistance(total: total, aspect: aspect)
        let near = nDistance(total: total, aspect: aspect)
        if p <= 0 {
            let g = centring(t)
            let drift = 1 - 0.035 * Swift.min(t, centreStart) / centreStart
            let tx = lerp((left + right) / 2, 0, g)
            out.x = tx; out.y = nY + lerp(1.2, 0.4, g); out.z = lerp(far * drift, near, g)
            out.lookX = tx; out.lookY = nY; out.lookZ = 0
            out.roll = 0; out.fov = fov
            return
        }
        let z = cameraZ(p, nDistance: near)
        let rush = clamp(speed / 1.44, 0, 1)
        let sway = clamp(p * 4, 0, 1) * clamp(1 - p, 0, 1)
        let level = lerp(nY + 0.4, nY, ease(p / 0.8))
        out.x = sin(clock * 0.55) * 0.5 * sway
        out.y = level + sin(clock * 0.43 + 1) * 0.2 * sway
        out.z = z
        out.lookX = out.x; out.lookY = nY + (out.y - level); out.lookZ = Swift.min(0, z - 10)
        out.roll = sin(clock * 0.5) * 0.012 * sway + rush * 0.05 * sin(p * 3.1) + (p >= 2 ? sin(Double.pi * (p - 2) / 2) * 0.16 : 0)
        out.fov = fov + fovRush * rush
    }

    // MARK: The haptics: one long soft swell

    /// The swell begins exactly when the letters begin to crumble, is strongest while the last squares leave, and lets
    /// go as N comes to the centre. `swellTop` is its strength at the peak (0…1).
    static let swellStart: Double = crumbleStart
    static let swellPeak: Double = 3.7
    static let swellEnd: Double = centred
    static let swellTop: Double = 0.72

    /// The strength of the motor (0…1) at the ident's time: barely felt at first, growing slowly to the peak, then
    /// letting go slowly. No taps, no clicks.
    static func haptic(_ t: Double) -> Double {
        if t <= swellStart || t >= swellEnd { return 0 }
        if t < swellPeak { return swellTop * pow((t - swellStart) / (swellPeak - swellStart), 2.1) }
        return swellTop * pow(1 - (t - swellPeak) / (swellEnd - swellPeak), 2.0)
    }

    // MARK: When and how it is shown

    enum Mode {
        /// No intro: straight to the sign-in screen.
        case none
        /// The whole scene.
        case full
        /// Four calm still stages (reduced motion, or a phone that cannot draw the scene).
        case stills
    }

    /// Once per install, at a start with no session. With a screen reader on there is no intro at all (and it counts as
    /// seen — `seenWithoutShowing`). With motion reduced (the system's setting or the app's own), or where the phone
    /// cannot draw the scene, the still stages.
    static func mode(seen: Bool, hasSession: Bool, motionAllowed: Bool, screenReader: Bool, canDrawScene: Bool) -> Mode {
        if seen || hasSession || screenReader { return .none }
        if motionAllowed && canDrawScene { return .full }
        return .stills
    }

    /// A first start with a screen reader on: the intro is marked seen without being shown.
    static func seenWithoutShowing(seen: Bool, hasSession: Bool, screenReader: Bool) -> Bool {
        return !seen && !hasSession && screenReader
    }

    /// How many particles this phone gets, by its memory (MB): three tiers, as on Android (there by the app's memory
    /// class; here the phones of 3 GB, of 4 GB, and the rest).
    static func particleCount(memoryMB: Int) -> Int {
        if memoryMB < 3500 { return 60_000 }
        if memoryMB < 5500 { return 100_000 }
        return 150_000
    }

    /// Fewer particles shine a little more each, so the picture keeps its light.
    static func countGain(_ count: Int) -> Double {
        return Swift.min(1.7, pow(150_000.0 / Double(Swift.max(count, 1)), 0.6))
    }
}

/// The person's way through the intro: the ident's clock, then four steps. Fed with the time that passed (`tick`) and
/// the touches; it has no clock of its own, so it can be paused, kept across a new window, and tested.
///
/// A step, once started, completes by itself: a swipe up of any length (or a fling) starts the next step and it runs
/// to its end; while the finger is down the step follows it (`drag`), and letting go completes it — forward, if the
/// finger moved up at all. A completed step never goes back. There is no way to skip. Android: IntroFlow.
final class IntroFlow {
    /// What `tick` reports (bits).
    static let swell = 1    // the letters begin to crumble: the haptic swell starts now
    static let pass = 2     // the camera passes the honeycomb layer: one short tick
    static let finishedBit = 4 // the fourth step is complete: the sign-in screen comes out

    /// The still stages: no ident, no following of the finger, a calm cross-fade per step.
    private(set) var stills: Bool
    /// The ident's time, s (stops at its end).
    private(set) var t: Double
    /// The progress through the steps, 0…4.
    private(set) var p: Double = 0
    /// The steps completed.
    private(set) var done: Int = 0
    /// The speed of the progress, per second (only while a step runs by itself).
    private(set) var speed: Double = 0
    /// All the time that has passed, s: the scene's slow life.
    private(set) var clock: Double = 0
    /// The time since the ident ended, s (up to 2): the last squares finish leaving in it.
    private(set) var past: Double = 0
    /// The progress at which the camera passes the honeycomb layer (it depends on the screen's shape).
    var passAt: Double = IntroModel.shieldPass(nDistance: IntroModel.nFarthest)
    /// Frozen for a still picture (`freeze`).
    private(set) var frozen = false

    private var touching = false
    private var armed = false      // this touch may lead the step (it began after the ident, with no step running)
    private var movedUp = false    // the finger has been above where it came down
    private var running = false
    private var queued = false     // a swipe made while a step was running: the next step follows at once
    private var from: Double = 0
    private var runTime: Double = 0
    private var runLength: Double = 0
    private var idle: Double = 0
    private var passed = false
    private var pending = 0

    init(stills: Bool = false) {
        self.stills = stills
        self.t = stills ? IntroModel.identEnd : 0
    }

    var identOver: Bool { return t >= IntroModel.identEnd }
    var finished: Bool { return done >= IntroModel.steps }
    var stepRunning: Bool { return running }

    /// «Проведи вверх» is on the screen: at once when the ident ends; after a completed step only when nothing has
    /// touched the screen for five seconds; never while a finger is down or a step is running.
    var hintVisible: Bool {
        return identOver && !finished && !touching && !running && p == Double(done) && idle >= (done == 0 ? 0 : IntroModel.hintIdle)
    }

    /// The scene cannot be drawn after all: the still stages from here (the ident, if it was still running, is over).
    func toStills() {
        if stills { return }
        stills = true
        if !identOver { t = IntroModel.identEnd; idle = 0 }
        if !running { p = Double(done) }
    }

    /// Frozen at a moment, for a still picture: the time of the ident or a progress. Nothing moves it.
    func freeze(time: Double, progress: Double) {
        frozen = true
        t = IntroModel.clamp(time, 0, IntroModel.identEnd)
        p = IntroModel.clamp(progress, 0, Double(IntroModel.steps))
        if p > 0 { t = IntroModel.identEnd }
        done = Int(p)
        clock = t + p * IntroModel.stepSeconds
    }

    /// `dt` seconds have passed. Returns what happened in them (swell, pass, finishedBit).
    func tick(_ dt: Double) -> Int {
        if frozen || dt <= 0 { return take() }
        clock += dt
        if !touching { idle += dt }
        if !identOver {
            let before = t
            t = Swift.min(IntroModel.identEnd, t + dt)
            if before < IntroModel.crumbleStart && t >= IntroModel.crumbleStart { pending |= IntroFlow.swell }
            if identOver { idle = 0 }
            return take()
        }
        past = Swift.min(2.0, past + dt)
        if running {
            runTime += dt
            let u = IntroModel.clamp(runTime / runLength, 0, 1)
            let target = Double(done + 1)
            let next = from + (target - from) * IntroModel.smoother(u)
            speed = (next - p) / dt
            move(next)
            if u >= 1.0 {
                p = target; done += 1; running = false; speed = 0; idle = 0
                if finished { pending |= IntroFlow.finishedBit } else if queued { begin() }
                queued = false
            }
        }
        return take()
    }

    private func take() -> Int {
        let events = pending
        pending = 0
        return events
    }

    private func move(_ next: Double) {
        if !stills && !passed && p < passAt && next >= passAt { passed = true; pending |= IntroFlow.pass }
        p = next
    }

    private func begin() {
        from = p
        let left = Double(done + 1) - p
        let whole = stills ? IntroModel.stillSeconds : IntroModel.stepSeconds
        runLength = Swift.max(IntroModel.stepShortest, whole * left)
        runTime = 0
        running = true
    }

    /// A finger came down.
    func touchDown() {
        if frozen { return }
        touching = true; idle = 0; movedUp = false
        armed = identOver && !finished && !running
    }

    /// The finger is `up` of a step above where it came down (1 = a whole step; negative below).
    func drag(up: Double) {
        if frozen || !touching { return }
        idle = 0
        if up > 0 { movedUp = true }
        if armed && !stills { move(Double(done) + IntroModel.clamp(up, 0, 1)) }
    }

    /// The finger left the screen; `fling` — it left moving up fast.
    func touchUp(fling: Bool = false) {
        if frozen || !touching { return }
        touching = false; idle = 0
        let forward = movedUp || fling
        if armed {
            armed = false
            if forward || p > Double(done) { begin() }
        } else if forward && running && done + 1 < IntroModel.steps {
            queued = true
        }
    }

    /// The touch was taken away (the app left the screen): as a finger that left without a fling.
    func touchCancel() { touchUp(fling: false) }
}
