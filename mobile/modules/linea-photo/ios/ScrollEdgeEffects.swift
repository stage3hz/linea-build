import ObjectiveC
import UIKit

// iOS 26 adds a UIScrollEdgeEffect to every UIScrollView edge: a dimming / blur band where content
// scrolls under system bars (react-native#54181, react-native-screens#5078). INVIZENT has no system
// bars — its header and tab bar are its own glass — so the band only darkened the top and bottom of
// every list. Hidden for all scroll views (top and bottom), as the workarounds in those issues do.
enum ScrollEdgeEffects {
  private static var installed = false

  static func disable() {
    #if compiler(>=6.2) // Xcode 26 SDK: the edge-effect API exists
    guard #available(iOS 26.0, *), !installed else { return }
    installed = true
    let cls: AnyClass = UIScrollView.self
    let original = #selector(UIView.didMoveToWindow)
    let replacement = #selector(UIScrollView.linea_didMoveToWindow)
    guard let replacementMethod = class_getInstanceMethod(cls, replacement) else { return }
    // Add the override on UIScrollView itself first, so UIView's own didMoveToWindow (used by every
    // other view) is never exchanged.
    if class_addMethod(cls, original, method_getImplementation(replacementMethod), method_getTypeEncoding(replacementMethod)),
       let inherited = class_getInstanceMethod(UIView.self, original) {
      class_replaceMethod(cls, replacement, method_getImplementation(inherited), method_getTypeEncoding(inherited))
    } else if let originalMethod = class_getInstanceMethod(cls, original) {
      method_exchangeImplementations(originalMethod, replacementMethod)
    }
    #endif
  }
}

extension UIScrollView {
  @objc func linea_didMoveToWindow() {
    linea_didMoveToWindow() // the original implementation after the swap
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      topEdgeEffect.isHidden = true
      bottomEdgeEffect.isHidden = true
    }
    #endif
  }
}
