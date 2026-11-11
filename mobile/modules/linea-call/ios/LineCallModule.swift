import AVFoundation
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

  public func definition() -> ModuleDefinition {
    Name("LineaCall")
    Events("end", "mute", "audio", "open")

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
