import ExpoModulesCore
import ReplayKit
import UIKit

public class LineScreenModule: Module {
  private var picker: RPSystemBroadcastPickerView?
  private func defaults() throws -> UserDefaults {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "RTCAppGroupIdentifier") as? String,
      FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) != nil,
      let defaults = UserDefaults(suiteName: group) else {
      throw NSError(domain: "LineaScreen", code: 1, userInfo: [NSLocalizedDescriptionKey: "Профиль подписи не разрешает App Groups для демонстрации экрана."])
    }
    return defaults
  }
  public func definition() -> ModuleDefinition {
    Name("LineaScreen")
    AsyncFunction("configure") { (quality: String) in
      guard quality == "720p60" || quality == "1080p60" else { throw NSError(domain: "LineaScreen", code: 2) }
      let d = try self.defaults()
      d.set(quality, forKey: "quality"); d.set(false, forKey: "active"); d.set(false, forKey: "stop")
      d.synchronize()
    }
    AsyncFunction("showPicker") { () in
      let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
      picker.preferredExtension = Bundle.main.object(forInfoDictionaryKey: "RTCScreenSharingExtension") as? String
      picker.showsMicrophoneButton = false
      guard let root = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap({ $0.windows }).first(where: { $0.isKeyWindow })?.rootViewController?.view else { throw NSError(domain: "LineaScreen", code: 3) }
      picker.alpha = 0.01; root.addSubview(picker); self.picker = picker
      picker.subviews.compactMap({ $0 as? UIButton }).first?.sendActions(for: .touchUpInside)
    }.runOnQueue(.main)
    AsyncFunction("isActive") { () -> Bool in let d = try self.defaults(); d.synchronize(); return d.bool(forKey: "active") }
    AsyncFunction("stop") { () in
      let d = try self.defaults(); d.set(true, forKey: "stop"); d.synchronize()
      self.picker?.removeFromSuperview(); self.picker = nil
    }.runOnQueue(.main)
  }
}
