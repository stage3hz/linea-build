import AVFoundation
import MediaToolbox

/// Three-band music equalizer (НЧ low shelf ~120 Hz, СЧ peak ~1 kHz, ВЧ high shelf ~8 kHz) applied
/// to expo-audio's AVPlayer through an MTAudioProcessingTap on every item it plays.
/// Gains are read atomically by the audio thread; biquad state lives per channel.
final class EqualizerState {
  var gains: (low: Float, mid: Float, high: Float) = (0, 0, 0)
  var enabled = false
  var sampleRate: Double = 44100
  var version = 0
  private let lock = NSLock()
  func set(low: Float, mid: Float, high: Float, enabled: Bool) {
    lock.lock(); gains = (low, mid, high); self.enabled = enabled; version &+= 1; lock.unlock()
  }
  func snapshot() -> (Float, Float, Float, Bool, Int) { lock.lock(); defer { lock.unlock() }; return (gains.low, gains.mid, gains.high, enabled, version) }
}

/// RBJ audio-EQ-cookbook biquad.
struct Biquad {
  var b0: Float = 1, b1: Float = 0, b2: Float = 0, a1: Float = 0, a2: Float = 0
  var z1: Float = 0, z2: Float = 0
  static func lowShelf(_ f: Double, _ gainDb: Float, _ fs: Double) -> Biquad { shelf(f, gainDb, fs, low: true) }
  static func highShelf(_ f: Double, _ gainDb: Float, _ fs: Double) -> Biquad { shelf(f, gainDb, fs, low: false) }
  static func shelf(_ f: Double, _ gainDb: Float, _ fs: Double, low: Bool) -> Biquad {
    let a = pow(10.0, Double(gainDb) / 40), w = 2 * Double.pi * f / fs, cw = cos(w), sw = sin(w)
    let alpha = sw / 2 * sqrt(2.0) // shelf slope S = 1
    let s = 2 * sqrt(a) * alpha
    var q = Biquad()
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
  static func peak(_ f: Double, _ gainDb: Float, _ fs: Double, q: Double = 0.7) -> Biquad {
    let a = pow(10.0, Double(gainDb) / 40), w = 2 * Double.pi * f / fs, alpha = sin(w) / (2 * q), cw = cos(w)
    let a0 = 1 + alpha / a
    var r = Biquad()
    r.b0 = Float((1 + alpha * a) / a0); r.b1 = Float(-2 * cw / a0); r.b2 = Float((1 - alpha * a) / a0); r.a1 = Float(-2 * cw / a0); r.a2 = Float((1 - alpha / a) / a0)
    return r
  }
  mutating func coefficients(from other: Biquad) { b0 = other.b0; b1 = other.b1; b2 = other.b2; a1 = other.a1; a2 = other.a2 }
  @inline(__always) mutating func process(_ x: Float) -> Float {
    let y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return y
  }
}

/// Per-tap processing context (retained through the tap's clientInfo).
final class TapContext {
  let state: EqualizerState
  var filters: [[Biquad]] = [] // [channel][band]
  var version = -1
  var isFloat = false
  var nonInterleaved = true
  var channels = 2
  init(state: EqualizerState) { self.state = state }
  func refresh() {
    let (low, mid, high, _, version) = state.snapshot()
    if version == self.version && !filters.isEmpty { return }
    let fs = state.sampleRate
    let designs = [Biquad.lowShelf(120, low, fs), Biquad.peak(1000, mid, fs), Biquad.highShelf(8000, high, fs)]
    if filters.count != channels { filters = Array(repeating: designs, count: channels) }
    else { for c in 0..<channels { for b in 0..<3 { filters[c][b].coefficients(from: designs[b]) } } }
    self.version = version
  }
}

private let tapInit: MTAudioProcessingTapInitCallback = { _, clientInfo, tapStorageOut in tapStorageOut.pointee = clientInfo }
private let tapFinalize: MTAudioProcessingTapFinalizeCallback = { tap in
  Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
}
private let tapPrepare: MTAudioProcessingTapPrepareCallback = { tap, _, format in
  let context = Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
  let asbd = format.pointee
  context.isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0 && asbd.mBitsPerChannel == 32
  context.nonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
  context.channels = Int(max(1, asbd.mChannelsPerFrame))
  context.state.sampleRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : 44100
  context.filters = []; context.version = -1
}
private let tapUnprepare: MTAudioProcessingTapUnprepareCallback = { _ in }
private let tapProcess: MTAudioProcessingTapProcessCallback = { tap, frames, _, bufferList, framesOut, flagsOut in
  guard MTAudioProcessingTapGetSourceAudio(tap, frames, bufferList, flagsOut, nil, framesOut) == noErr else { return }
  let context = Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
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
    for i in 0..<count { for c in 0..<min(channels, context.filters.count) {
      var x = data[i * channels + c]
      x = context.filters[c][0].process(x); x = context.filters[c][1].process(x); x = context.filters[c][2].process(x)
      data[i * channels + c] = x
    } }
  }
}

enum MusicEqualizer {
  static let state = EqualizerState()
  private static var observation: NSKeyValueObservation?
  private static weak var attached: AVPlayer?

  /// Installs the tap on the current item now and on every item the player switches to.
  static func attach(_ player: AVPlayer) {
    if attached === player { install(on: player.currentItem); return }
    attached = player
    observation = player.observe(\.currentItem, options: [.initial, .new]) { player, _ in
      DispatchQueue.main.async { install(on: player.currentItem) }
    }
  }

  static func install(on item: AVPlayerItem?) {
    guard let item else { return }
    let tracks = item.asset.tracks(withMediaType: .audio)
    guard let track = tracks.first else {
      // Remote assets load their tracks later.
      item.asset.loadValuesAsynchronously(forKeys: ["tracks"]) { DispatchQueue.main.async { if !item.asset.tracks(withMediaType: .audio).isEmpty { install(on: item) } } }
      return
    }
    let context = TapContext(state: state)
    var callbacks = MTAudioProcessingTapCallbacks(version: kMTAudioProcessingTapCallbacksVersion_0, clientInfo: Unmanaged.passRetained(context).toOpaque(), init: tapInit, finalize: tapFinalize, prepare: tapPrepare, unprepare: tapUnprepare, process: tapProcess)
    var tap: MTAudioProcessingTap?
    guard MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap) == noErr, let created = tap else {
      Unmanaged.passUnretained(context).release(); return
    }
    let parameters = AVMutableAudioMixInputParameters(track: track)
    parameters.audioTapProcessor = created
    let mix = AVMutableAudioMix(); mix.inputParameters = [parameters]
    item.audioMix = mix
  }

  static func set(low: Double, mid: Double, high: Double, enabled: Bool) {
    func clamp(_ value: Double) -> Float { Float(max(-12, min(12, value))) }
    state.set(low: clamp(low), mid: clamp(mid), high: clamp(high), enabled: enabled)
  }

  /// "headphones" for wired / Bluetooth / AirPods outputs, otherwise "speaker".
  static func route() -> String {
    let headphones: Set<AVAudioSession.Port> = [.headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .usbAudio, .airPlay, .carAudio]
    return AVAudioSession.sharedInstance().currentRoute.outputs.contains { headphones.contains($0.portType) } ? "headphones" : "speaker"
  }
  static func routeName() -> String? {
    let output = AVAudioSession.sharedInstance().currentRoute.outputs.first
    return route() == "headphones" ? output?.portName : nil
  }
}
