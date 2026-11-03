import CoreBluetooth
import ExpoModulesCore
import Network
import UIKit

/// Radio, permission and internet state for messages without internet.
/// iOS never lets an app switch Bluetooth on; it can only show the system alert
/// (CBCentralManagerOptionShowPowerAlertKey) that leads the person to Bluetooth settings.
/// Core Bluetooth delegates must be NSObjects; Expo modules are not, so a small helper listens.
private final class RadioListener: NSObject, CBCentralManagerDelegate {
  var changed: () -> Void = {}
  func centralManagerDidUpdateState(_ central: CBCentralManager) { changed() }
}

public final class NearbyModule: Module {
  private var central: CBCentralManager?
  private let listener = RadioListener()
  private var waiting: [Promise] = []
  private let monitor = NWPathMonitor()
  private var internet = false
  private var observing = false

  public func definition() -> ModuleDefinition {
    Name("LineaNearby")
    Events("change")

    OnCreate {
      self.listener.changed = { [weak self] in self?.flush(); self?.emit() }
      self.monitor.pathUpdateHandler = { [weak self] path in
        guard let self else { return }
        // .satisfied: the system has a usable route to the internet over Wi-Fi or mobile data.
        let now = path.status == .satisfied
        DispatchQueue.main.async { if now != self.internet { self.internet = now; self.emit() } }
      }
      self.internet = self.monitor.currentPath.status == .satisfied
      self.monitor.start(queue: DispatchQueue(label: "invizent.nearby.path"))
      // Only open Bluetooth when permission was already given: creating the manager earlier
      // would show the system permission question on its own, without our explanation first.
      if CBManager.authorization == .allowedAlways { DispatchQueue.main.async { self.open(alert: false) } }
    }
    OnDestroy { self.monitor.cancel() }
    OnStartObserving { self.observing = true }
    OnStopObserving { self.observing = false }

    AsyncFunction("state") { (promise: Promise) in promise.resolve(self.snapshot()) }.runOnQueue(.main)

    AsyncFunction("requestPermission") { (promise: Promise) in
      if CBManager.authorization != .notDetermined { return promise.resolve(self.snapshot()) }
      self.waiting.append(promise)
      self.open(alert: false) // the system asks «Allow Invizent to use Bluetooth?»
    }.runOnQueue(.main)

    AsyncFunction("requestEnable") { (promise: Promise) in
      guard CBManager.authorization == .allowedAlways else { return promise.resolve(self.snapshot()) }
      if self.central?.state == .poweredOn { return promise.resolve(self.snapshot()) }
      // A new manager with the alert key: when Bluetooth is off, iOS shows its own alert.
      self.waiting.append(promise)
      self.open(alert: true)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.flush() }
    }.runOnQueue(.main)

    AsyncFunction("openSettings") {
      if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }.runOnQueue(.main)
  }

  private func open(alert: Bool) {
    central = CBCentralManager(delegate: listener, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: alert])
  }

  private func permission() -> String {
    switch CBManager.authorization {
    case .allowedAlways: return "granted"
    case .notDetermined: return "undetermined"
    default: return "blocked" // iOS never asks twice: only Settings can change it
    }
  }

  private func snapshot() -> [String: Any] {
    let granted = CBManager.authorization == .allowedAlways
    let radio: String
    switch central?.state {
    case .poweredOn?: radio = "on"
    case .poweredOff?: radio = "off"
    default: radio = "unknown"
    }
    return ["supported": true, "permission": permission(), "bluetooth": granted ? radio : "unknown", "internet": internet]
  }

  private func flush() {
    let list = waiting; waiting = []
    for promise in list { promise.resolve(snapshot()) }
  }
  private func emit() { if observing { sendEvent("change", snapshot()) } }
}
