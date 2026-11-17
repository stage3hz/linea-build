import ExpoModulesCore
import UIKit

// A container whose React children can be photographed: the app draws a decoration with its own components
// (vector frames, nameplates) once, off screen, and the native lists show the picture. Never takes a touch.
public final class LineBakeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LineaBake")
    View(BakeView.self) {
      AsyncFunction("snapshot") { (view: BakeView, promise: Promise) in
        promise.resolve(view.snapshot())
      }
    }
  }
}

final class BakeView: ExpoView {
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    backgroundColor = .clear
  }

  /// The children as a PNG (base64); empty when there is nothing to draw yet.
  func snapshot() -> String {
    let size = bounds.size
    if size.width <= 0 || size.height <= 0 { return "" }
    let format = UIGraphicsImageRendererFormat()
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      self.layer.render(in: context.cgContext)
    }
    return image.pngData()?.base64EncodedString() ?? ""
  }
}
