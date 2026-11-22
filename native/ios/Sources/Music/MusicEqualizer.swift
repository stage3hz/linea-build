import AVFoundation
import MediaToolbox
import QuartzCore

// The music equalizer: one setting for the speaker, wired and Bluetooth headphones — «Рекомендованный» (the track as
// it is) or «Пользовательский» with НЧ / СЧ / ВЧ in dB. The settings are the reference's mobile/src/music/equalizer.ts
// and equalizerModel.ts (the same key and JSON on this device); the sound is the reference's native filter,
// mobile/modules/linea-photo/ios/MusicEqualizer.swift, carried over: three biquads (low shelf 120 Hz, peak 1 kHz,
// high shelf 8 kHz) in an audio tap on every item the music player plays.

/// The settings, kept on this device.
enum EqualizerSettings {
    static let changed = Notification.Name("invizent.music.equalizer")
    static let limit: Double = 12
    /// НЧ, СЧ, ВЧ.
    static let bands: [(key: String, label: String, hz: Double)] = [("low", "НЧ", 120), ("mid", "СЧ", 1000), ("high", "ВЧ", 8000)]
    private static let key = "linea.equalizer.v1"

    struct Profile: Equatable {
        /// "recommended" or "custom".
        var mode = "recommended"
        var low: Double = 0
        var mid: Double = 0
        var high: Double = 0

        func value(_ key: String) -> Double { return key == "low" ? low : (key == "mid" ? mid : high) }
        mutating func set(_ key: String, _ value: Double) {
            if key == "low" { low = value } else if key == "mid" { mid = value } else { high = value }
        }
    }

    private static var kept: Profile?

    /// A gain as the reference keeps it: a number, within ±12, to half a decibel; anything else is 0.
    static func gain(_ value: Any?) -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return 0 }
        let raw = number.doubleValue
        guard raw.isFinite else { return 0 }
        return (max(-limit, min(limit, raw)) * 2).rounded() / 2
    }

    /// `parseEq`: earlier builds kept separate headphone / speaker profiles — the headphone one is kept.
    static func parse(_ raw: String?) -> Profile {
        guard let raw, let data = raw.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return Profile() }
        var item = value as? [String: Any]
        if let nested = item?["headphones"] { item = nested as? [String: Any] }
        var profile = Profile()
        profile.mode = item?["mode"] as? String == "custom" ? "custom" : "recommended"
        profile.low = gain(item?["low"])
        profile.mid = gain(item?["mid"])
        profile.high = gain(item?["high"])
        return profile
    }

    static var profile: Profile {
        get {
            if let kept { return kept }
            let read = parse(UserDefaults.standard.string(forKey: key))
            kept = read
            return read
        }
        set {
            kept = newValue
            let json: [String: Any] = ["mode": newValue.mode, "low": newValue.low, "mid": newValue.mid, "high": newValue.high]
            if let data = try? JSONSerialization.data(withJSONObject: json, options: []), let text = String(data: data, encoding: .utf8) {
                UserDefaults.standard.set(text, forKey: key)
            }
            apply()
            NotificationCenter.default.post(name: changed, object: nil)
        }
    }

    /// `effectiveGains`: the custom gains, or flat (bypass) for «Рекомендованный».
    static func effective(_ profile: Profile) -> (low: Double, mid: Double, high: Double, enabled: Bool) {
        if profile.mode != "custom" { return (0, 0, 0, false) }
        return (profile.low, profile.mid, profile.high, profile.low != 0 || profile.mid != 0 || profile.high != 0)
    }

    /// Hands the gains to the filter.
    static func apply() {
        let gains = effective(profile)
        MusicEqualizer.set(low: gains.low, mid: gains.mid, high: gains.high, enabled: gains.enabled)
    }
}

/// The gains, read atomically by the audio thread.
final class EqualizerState {
    var gains: (low: Float, mid: Float, high: Float) = (0, 0, 0)
    var enabled = false
    var sampleRate: Double = 44100
    var version = 0
    private let lock = NSLock()

    func set(low: Float, mid: Float, high: Float, enabled: Bool) {
        lock.lock(); gains = (low, mid, high); self.enabled = enabled; version &+= 1; lock.unlock()
    }

    func snapshot() -> (Float, Float, Float, Bool, Int) {
        lock.lock(); defer { lock.unlock() }
        return (gains.low, gains.mid, gains.high, enabled, version)
    }

    // The music's loudness in three bands for the tab bar's wave (Shell/TabBar.swift): the RMS of the bass (below
    // 150 Hz), the mids (150 Hz…2.5 kHz) and the highs (above 2.5 kHz) of the last buffer the tap saw, and when
    // (CACurrentMediaTime). Written by the audio thread, read on the main thread once a frame.
    private var meterBands: (low: Float, mid: Float, high: Float) = (0, 0, 0)
    private var meterAt: CFTimeInterval = 0

    func meter(low: Float, mid: Float, high: Float) {
        let now = CACurrentMediaTime()
        lock.lock(); meterBands = (low, mid, high); meterAt = now; lock.unlock()
    }

    func meterReading() -> (low: Float, mid: Float, high: Float, at: CFTimeInterval) {
        lock.lock(); defer { lock.unlock() }
        return (meterBands.low, meterBands.mid, meterBands.high, meterAt)
    }
}

/// RBJ audio-EQ-cookbook biquad.
struct EqualizerBiquad {
    var b0: Float = 1, b1: Float = 0, b2: Float = 0, a1: Float = 0, a2: Float = 0
    var z1: Float = 0, z2: Float = 0

    static func lowShelf(_ f: Double, _ gainDb: Float, _ fs: Double) -> EqualizerBiquad { return shelf(f, gainDb, fs, low: true) }
    static func highShelf(_ f: Double, _ gainDb: Float, _ fs: Double) -> EqualizerBiquad { return shelf(f, gainDb, fs, low: false) }

    static func shelf(_ f: Double, _ gainDb: Float, _ fs: Double, low: Bool) -> EqualizerBiquad {
        let a = pow(10.0, Double(gainDb) / 40), w = 2 * Double.pi * f / fs, cw = cos(w), sw = sin(w)
        let alpha = sw / 2 * sqrt(2.0) // shelf slope S = 1
        let s = 2 * sqrt(a) * alpha
        var q = EqualizerBiquad()
        let b0, b1, b2, a0, a1, a2: Double
        if low {
            b0 = a * ((a + 1) - (a - 1) * cw + s); b1 = 2 * a * ((a - 1) - (a + 1) * cw); b2 = a * ((a + 1) - (a - 1) * cw - s)
            a0 = (a + 1) + (a - 1) * cw + s; a1 = -2 * ((a - 1) + (a + 1) * cw); a2 = (a + 1) + (a - 1) * cw - s
        } else {
            b0 = a * ((a + 1) + (a - 1) * cw + s); b1 = -2 * a * ((a - 1) + (a + 1) * cw); b2 = a * ((a + 1) + (a - 1) * cw - s)
            a0 = (a + 1) - (a - 1) * cw + s; a1 = 2 * ((a - 1) - (a + 1) * cw); a2 = (a + 1) - (a - 1) * cw - s
        }
        q.b0 = Float(b0 / a0); q.b1 = Float(b1 / a0); q.b2 = Float(b2 / a0); q.a1 = Float(a1 / a0); q.a2 = Float(a2 / a0)
        return q
    }

    static func peak(_ f: Double, _ gainDb: Float, _ fs: Double, q: Double = 0.7) -> EqualizerBiquad {
        let a = pow(10.0, Double(gainDb) / 40), w = 2 * Double.pi * f / fs, alpha = sin(w) / (2 * q), cw = cos(w)
        let a0 = 1 + alpha / a
        var r = EqualizerBiquad()
        r.b0 = Float((1 + alpha * a) / a0); r.b1 = Float(-2 * cw / a0); r.b2 = Float((1 - alpha * a) / a0); r.a1 = Float(-2 * cw / a0); r.a2 = Float((1 - alpha / a) / a0)
        return r
    }

    mutating func coefficients(from other: EqualizerBiquad) { b0 = other.b0; b1 = other.b1; b2 = other.b2; a1 = other.a1; a2 = other.a2 }

    @inline(__always) mutating func process(_ x: Float) -> Float {
        let y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return y
    }
}

/// Per-tap processing context (retained through the tap's clientInfo).
final class EqualizerTapContext {
    let state: EqualizerState
    var filters: [[EqualizerBiquad]] = [] // [channel][band]
    var version = -1
    var isFloat = false
    var nonInterleaved = true
    var channels = 2
    // The meter's two one-pole low-passes (150 Hz and 2.5 kHz): their coefficients and memories.
    var meterLowK: Float = 0.02
    var meterHighK: Float = 0.3
    var meterLow: Float = 0
    var meterHigh: Float = 0

    init(state: EqualizerState) { self.state = state }

    func refresh() {
        let (low, mid, high, _, version) = state.snapshot()
        if version == self.version && !filters.isEmpty { return }
        let fs = state.sampleRate
        let designs = [EqualizerBiquad.lowShelf(120, low, fs), EqualizerBiquad.peak(1000, mid, fs), EqualizerBiquad.highShelf(8000, high, fs)]
        if filters.count != channels { filters = Array(repeating: designs, count: channels) }
        else { for c in 0..<channels { for b in 0..<3 { filters[c][b].coefficients(from: designs[b]) } } }
        self.version = version
    }
}

private let equalizerTapInit: MTAudioProcessingTapInitCallback = { _, clientInfo, tapStorageOut in tapStorageOut.pointee = clientInfo }
private let equalizerTapFinalize: MTAudioProcessingTapFinalizeCallback = { tap in
    Unmanaged<EqualizerTapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
}
private let equalizerTapPrepare: MTAudioProcessingTapPrepareCallback = { tap, _, format in
    let context = Unmanaged<EqualizerTapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
    let asbd = format.pointee
    context.isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0 && asbd.mBitsPerChannel == 32
    context.nonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    context.channels = Int(max(1, asbd.mChannelsPerFrame))
    context.state.sampleRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : 44100
    let rate = context.state.sampleRate
    context.meterLowK = Float(1 - exp(-2 * Double.pi * 150 / rate))
    context.meterHighK = Float(1 - exp(-2 * Double.pi * 2500 / rate))
    context.meterLow = 0
    context.meterHigh = 0
    context.filters = []
    context.version = -1
}
private let equalizerTapUnprepare: MTAudioProcessingTapUnprepareCallback = { _ in }
private let equalizerTapProcess: MTAudioProcessingTapProcessCallback = { tap, frames, _, bufferList, framesOut, flagsOut in
    guard MTAudioProcessingTapGetSourceAudio(tap, frames, bufferList, flagsOut, nil, framesOut) == noErr else { return }
    let context = Unmanaged<EqualizerTapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
    // The level meter for the tab bar's wave, in three bands: the first channel (the left one when the channels are
    // interleaved) through two one-pole low-passes — bass below 150 Hz, highs above 2.5 kHz, mids between — whether
    // the filter is on or not. A few multiplications a sample.
    if context.isFloat {
        let meterBuffers = UnsafeMutableAudioBufferListPointer(bufferList)
        if let first = meterBuffers.first, let samplesData = first.mData?.assumingMemoryBound(to: Float.self) {
            let frames = Int(framesOut.pointee)
            let step = context.nonInterleaved ? 1 : context.channels
            let frameCount = min(frames, Int(first.mDataByteSize) / MemoryLayout<Float>.size / max(1, step))
            if frameCount > 1 {
                var low = context.meterLow, high = context.meterHigh
                let lowK = context.meterLowK, highK = context.meterHighK
                var lowSum: Float = 0, midSum: Float = 0, highSum: Float = 0
                for frame in 0..<frameCount {
                    let x = samplesData[frame * step]
                    low += (x - low) * lowK
                    high += (x - high) * highK
                    let mid = high - low, top = x - high
                    lowSum += low * low; midSum += mid * mid; highSum += top * top
                }
                context.meterLow = low; context.meterHigh = high
                let sampleCount = Float(frameCount)
                context.state.meter(low: (lowSum / sampleCount).squareRoot(), mid: (midSum / sampleCount).squareRoot(), high: (highSum / sampleCount).squareRoot())
            }
        }
    }
    let (_, _, _, enabled, _) = context.state.snapshot()
    guard enabled, context.isFloat else { return }
    context.refresh()
    let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
    let count = Int(framesOut.pointee)
    if context.nonInterleaved {
        for (index, buffer) in buffers.enumerated() where index < context.filters.count {
            guard let data = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
            for i in 0..<count {
                var x = data[i]
                x = context.filters[index][0].process(x); x = context.filters[index][1].process(x); x = context.filters[index][2].process(x)
                data[i] = x
            }
        }
    } else if let buffer = buffers.first, let data = buffer.mData?.assumingMemoryBound(to: Float.self) {
        let channels = context.channels
        for i in 0..<count {
            for c in 0..<min(channels, context.filters.count) {
                var x = data[i * channels + c]
                x = context.filters[c][0].process(x); x = context.filters[c][1].process(x); x = context.filters[c][2].process(x)
                data[i * channels + c] = x
            }
        }
    }
}

/// The filter on the music player's AVPlayer: installed on every item it plays.
enum MusicEqualizer {
    static let state = EqualizerState()
    private static var observation: NSKeyValueObservation?
    private static weak var attached: AVPlayer?

    /// Installs the tap on the current item now and on every item the player switches to.
    static func attach(_ player: AVPlayer) {
        EqualizerSettings.apply()
        if attached === player { install(on: player.currentItem); return }
        attached = player
        observation = player.observe(\.currentItem, options: [.initial, .new]) { (player: AVPlayer, _: NSKeyValueObservedChange<AVPlayerItem?>) -> Void in
            DispatchQueue.main.async { install(on: player.currentItem) }
        }
    }

    static func install(on item: AVPlayerItem?) {
        guard let item, item.audioMix == nil else { return }
        let tracks = item.asset.tracks(withMediaType: .audio)
        guard let track = tracks.first else {
            // Remote assets load their tracks later.
            item.asset.loadValuesAsynchronously(forKeys: ["tracks"]) {
                DispatchQueue.main.async {
                    if !item.asset.tracks(withMediaType: .audio).isEmpty { install(on: item) }
                }
            }
            return
        }
        let context = EqualizerTapContext(state: state)
        var callbacks = MTAudioProcessingTapCallbacks(version: kMTAudioProcessingTapCallbacksVersion_0, clientInfo: Unmanaged.passRetained(context).toOpaque(), init: equalizerTapInit, finalize: equalizerTapFinalize, prepare: equalizerTapPrepare, unprepare: equalizerTapUnprepare, process: equalizerTapProcess)
        var tap: MTAudioProcessingTap?
        guard MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap) == noErr, let created = tap else {
            Unmanaged.passUnretained(context).release()
            return
        }
        let parameters = AVMutableAudioMixInputParameters(track: track)
        parameters.audioTapProcessor = created
        let mix = AVMutableAudioMix()
        mix.inputParameters = [parameters]
        item.audioMix = mix
    }

    static func set(low: Double, mid: Double, high: Double, enabled: Bool) {
        func clamp(_ value: Double) -> Float { return Float(max(-12, min(12, value))) }
        state.set(low: clamp(low), mid: clamp(mid), high: clamp(high), enabled: enabled)
    }
}
