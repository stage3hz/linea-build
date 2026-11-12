import AVFoundation
import AVKit
import CallKit
import ExpoModulesCore
import UIKit

/// CXProviderDelegate must be an NSObject; Expo modules are not, so a small helper forwards to the module.
private final class ProviderDelegate: NSObject, CXProviderDelegate {
  weak var owner: LineCallModule?
  func providerDidReset(_ provider: CXProvider) { owner?.didReset() }
  func provider(_ provider: CXProvider, perform action: CXStartCallAction) { owner?.perform(start: action, provider: provider) }
  func provider(_ provider: CXProvider, perform action: CXEndCallAction) { owner?.perform(end: action) }
  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) { owner?.perform(mute: action) }
  // Calls are never answered or held through CallKit here (an incoming call is answered in the app first).
  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) { action.fail() }
  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) { action.fail() }
  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) { owner?.audio(active: true) }
  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) { owner?.audio(active: false) }
}

/// The call that runs in the app, reported to CallKit (src/calls/systemCall.ts): iOS then shows the green call
/// pill / Dynamic Island indicator with the duration while the app is in the background, and the call can be ended
/// or muted from there. Only calls already running in the app are reported (an outgoing call when it is placed,
/// an incoming one once answered in the app), so neither PushKit nor the 'voip' background mode is involved.
/// Recents are off: the call never reaches the system call log or iCloud.
public final class LineCallModule: Module {
  private var provider: CXProvider?
  private let controller = CXCallController()
  private let delegate = ProviderDelegate()
  /// App call id → CallKit UUID (the app's ids come from the network and are not trusted to be UUIDs).
  private var calls: [String: UUID] = [:]
  private var names: [UUID: String] = [:]
  private var video: [UUID: Bool] = [:]
  private var connected: Set<UUID> = []

  private func id(for uuid: UUID) -> String? { calls.first(where: { $0.value == uuid })?.key }

  private func makeProvider() -> CXProvider {
    if let provider { return provider }
    let config = CXProviderConfiguration()
    config.supportsVideo = true
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    config.includesCallsInRecents = false
    let made = CXProvider(configuration: config)
    delegate.owner = self
    made.setDelegate(delegate, queue: nil)
    provider = made
    return made
  }

  /// CallKit is not allowed for apps on the China storefront; there the call stays in the app as before.
  private static var allowed: Bool { Locale.current.region?.identifier != "CN" }

  func didReset() {
    let ids = Array(calls.keys)
    calls.removeAll(); names.removeAll(); video.removeAll(); connected.removeAll()
    for id in ids { sendEvent("end", ["id": id]) }
  }

  func perform(start action: CXStartCallAction, provider: CXProvider) {
    let uuid = action.callUUID
    provider.reportOutgoingCall(with: uuid, startedConnectingAt: nil)
    let update = CXCallUpdate()
    update.remoteHandle = action.handle
    update.localizedCallerName = names[uuid]
    update.hasVideo = video[uuid] ?? false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    provider.reportCall(with: uuid, updated: update)
    action.fulfill()
  }

  func perform(end action: CXEndCallAction) {
    // Ended from the system UI (the call pill, the lock screen, another call): the app hangs up. When the app ended
    // it, the id is already gone and nothing is sent back.
    if let id = id(for: action.callUUID) {
      forget(action.callUUID)
      sendEvent("end", ["id": id])
    }
    action.fulfill()
  }

  func perform(mute action: CXSetMutedCallAction) {
    if let id = id(for: action.callUUID) { sendEvent("mute", ["id": id, "muted": action.isMuted]) }
    action.fulfill()
  }

  func audio(active: Bool) { sendEvent("audio", ["active": active]) }

  private func forget(_ uuid: UUID) {
    if let id = id(for: uuid) { calls.removeValue(forKey: id) }
    names.removeValue(forKey: uuid); video.removeValue(forKey: uuid); connected.remove(uuid)
  }

  private var routeObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("LineaCall")
    Events("end", "mute", "audio", "open", "route")

    // ---- The call's microphone and output (CallAudio below) ----
    OnStartObserving {
      self.routeObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
        CallAudio.keepChosenInput()
        self?.sendEvent("route", [:])
      }
    }
    OnStopObserving {
      if let observer = self.routeObserver { NotificationCenter.default.removeObserver(observer) }
      self.routeObserver = nil
    }
    Function("audioRoute") { () -> [String: Any] in CallAudio.route() }
    AsyncFunction("setAudioInput") { (uid: String?) -> Bool in CallAudio.setInput(uid) }.runOnQueue(.main)
    AsyncFunction("showOutputPicker") { () -> Bool in CallAudio.showOutputPicker() }.runOnQueue(.main)

    Function("supported") { () -> Bool in LineCallModule.allowed }

    AsyncFunction("start") { (id: String, name: String, isVideo: Bool, text: String, endLabel: String, channelName: String, promise: Promise) in
      // text / endLabel / channelName are for the Android notification; CallKit draws its own UI.
      _ = (text, endLabel, channelName)
      guard LineCallModule.allowed, self.calls[id] == nil else { promise.resolve(false); return }
      _ = self.makeProvider()
      let uuid = UUID()
      let title = name.isEmpty ? "INVIZENT" : String(name.prefix(64))
      self.calls[id] = uuid; self.names[uuid] = title; self.video[uuid] = isVideo
      let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: title))
      action.isVideo = isVideo
      self.controller.request(CXTransaction(action: action)) { error in
        DispatchQueue.main.async {
          if error != nil { self.forget(uuid); promise.resolve(false) } else { promise.resolve(true) }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("update") { (id: String, text: String, connectedAt: Double) in
      _ = text
      guard let uuid = self.calls[id], connectedAt > 0, !self.connected.contains(uuid) else { return }
      self.connected.insert(uuid)
      self.provider?.reportOutgoingCall(with: uuid, connectedAt: Date(timeIntervalSince1970: connectedAt / 1000))
    }.runOnQueue(.main)

    AsyncFunction("setMuted") { (id: String, muted: Bool) in
      guard let uuid = self.calls[id] else { return }
      self.controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { _ in }
    }.runOnQueue(.main)

    AsyncFunction("end") { (id: String) in
      guard let uuid = self.calls[id] else { return }
      self.forget(uuid)
      self.controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { error in
        guard error != nil else { return }
        DispatchQueue.main.async { self.provider?.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded) }
      }
    }.runOnQueue(.main)

    OnDestroy {
      let open = Array(self.calls.values)
      for uuid in open { self.provider?.reportCall(with: uuid, endedAt: nil, reason: .failed) }
      self.calls.removeAll()
      self.provider?.invalidate()
    }
  }
}

/// The microphone and the output of a call, chosen by the user (звонок › «Звук»).
/// By default iOS routes the call itself: connected headphones take both the sound and the microphone. Here the user
/// may pick another microphone (the phone's own while the sound stays in Bluetooth headphones — iOS then plays to
/// them over A2DP), and open the system's list of outputs.
enum CallAudio {
  /// The microphone the user chose (a port uid), or nil for the system's choice. Kept for the life of the app run.
  static var chosen: String?

  private static func describe(_ port: AVAudioSessionPortDescription) -> [String: String] {
    return ["id": port.uid, "name": port.portName, "kind": port.portType.rawValue]
  }

  static func route() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    var result: [String: Any] = ["inputs": (session.availableInputs ?? []).map(describe)]
    if let input = session.currentRoute.inputs.first { result["input"] = describe(input) }
    if let output = session.currentRoute.outputs.first { result["output"] = describe(output) }
    if let uid = chosen { result["chosen"] = uid }
    return result
  }

  /// nil: back to the system's choice. False when the microphone is not available (any more).
  static func setInput(_ uid: String?) -> Bool {
    let session = AVAudioSession.sharedInstance()
    guard let uid = uid else {
      chosen = nil
      return (try? session.setPreferredInput(nil)) != nil
    }
    guard let port = (session.availableInputs ?? []).first(where: { $0.uid == uid }) else { return false }
    chosen = uid
    return (try? session.setPreferredInput(port)) != nil
  }

  /// The route changed (headphones connected, the call's audio was set up again): the chosen microphone is asked
  /// for again if the system moved away from it and it is still there.
  static func keepChosenInput() {
    guard let uid = chosen else { return }
    let session = AVAudioSession.sharedInstance()
    guard session.currentRoute.inputs.first?.uid != uid else { return }
    guard let port = (session.availableInputs ?? []).first(where: { $0.uid == uid }) else { return }
    try? session.setPreferredInput(port)
  }

  /// The system's own list of outputs (the phone, the speaker, AirPods, a car…): the only way iOS lets an app offer
  /// them all. The picker view is put in the window out of sight and its button is pressed for the user.
  static func showOutputPicker() -> Bool {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return false }
    guard let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return false }
    let picker = AVRoutePickerView(frame: CGRect(x: -10, y: -10, width: 1, height: 1))
    picker.alpha = 0.01
    window.addSubview(picker)
    var pressed = false
    for view in picker.subviews {
      if let button = view as? UIButton { button.sendActions(for: .touchUpInside); pressed = true }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { picker.removeFromSuperview() }
    return pressed
  }
}
