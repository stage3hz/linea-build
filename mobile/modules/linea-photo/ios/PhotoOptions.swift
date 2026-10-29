import Foundation
import CoreFoundation

struct PhotoCrop { let x:Double;let y:Double;let width:Double;let height:Double }
struct PhotoRect: Equatable { let x:Int;let y:Int;let width:Int;let height:Int }
struct PhotoPlan { let crop:PhotoRect;let width:Int;let height:Int;let downsampled:Bool }

struct PhotoOptions {
  let background: String
  let document: String
  let scale: Int
  let strokes: [PhotoStroke]
  let allowDownsample: Bool
  let format: String
  let resolution: Double
  let crop: PhotoCrop?
  var plain: Bool { background == "keep" && document == "none" && scale == 1 && strokes.isEmpty }
  var pixelLimit: Int { plain ? 16_000_000 : min(4_000_000,8_000_000/(scale*scale)) }
  init(_ value: [String:Any]) throws {
    guard Set(value.keys).isSubset(of:["background","document","scale","strokes","allowDownsample","format","resolution","crop"]),
      let background=value["background"] as? String,
      let document=value["document"] as? String,
      ["keep","transparent","white"].contains(background),
      ["none","bw","color"].contains(document) else { throw PhotoFailure("INVALID_OPTIONS") }
    let scale=try Self.number(value["scale"])
    if scale != 1 && scale != 2 && scale != 4 { throw PhotoFailure("INVALID_OPTIONS") }
    let format: String
    if let raw=value["format"] {
      guard let string=raw as? String,["png","jpeg"].contains(string) else { throw PhotoFailure("INVALID_OPTIONS") }
      format=string
    } else { format="png" }
    let resolution=value["resolution"] == nil ? 1 : try Self.number(value["resolution"])
    if resolution != 1 && resolution != 0.5 { throw PhotoFailure("INVALID_OPTIONS") }
    if document != "none" && background != "keep" { throw PhotoFailure("INCOMPATIBLE_OPTIONS") }
    if format=="jpeg" && background=="transparent" { throw PhotoFailure("INCOMPATIBLE_OPTIONS") }
    var allow=false
    if let raw=value["allowDownsample"] {
      guard let boolean=raw as? NSNumber, CFGetTypeID(boolean)==CFBooleanGetTypeID() else { throw PhotoFailure("INVALID_OPTIONS") }
      allow=boolean.boolValue
    }
    self.background=background; self.document=document; self.scale=Int(scale)
    self.allowDownsample=allow; self.strokes=try Self.parseStrokes(value["strokes"])
    self.format=format;self.resolution=resolution
    self.crop=try value["crop"].map { try Self.parseCrop($0) }
  }
  private static func number(_ value: Any?) throws -> Double {
    guard let number=value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { throw PhotoFailure("INVALID_OPTIONS") }
    return number.doubleValue
  }
  private static func parseCrop(_ value:Any) throws -> PhotoCrop {
    guard let raw=value as? [String:Any],Set(raw.keys)==["x","y","width","height"] else { throw PhotoFailure("INVALID_OPTIONS") }
    let x=try number(raw["x"]);let y=try number(raw["y"])
    let width=try number(raw["width"]);let height=try number(raw["height"])
    if x<0 || y<0 || x>=1 || y>=1 || width<=0 || height<=0 || x+width>1+1e-9 || y+height>1+1e-9 { throw PhotoFailure("INVALID_OPTIONS") }
    return PhotoCrop(x:x,y:y,width:width,height:height)
  }
  private static func parseStrokes(_ value: Any?) throws -> [PhotoStroke] {
    guard let raw=value as? [Any] else { throw PhotoFailure("INVALID_OPTIONS") }
    if raw.count>64 { throw PhotoFailure("MASK_TOO_COMPLEX") }
    var count=0
    return try raw.map { item in
      guard let object=item as? [String:Any],Set(object.keys)==["radius","points"],let points=object["points"] as? [Any] else { throw PhotoFailure("INVALID_OPTIONS") }
      let radius=try number(object["radius"])
      if radius<0.001 || radius>0.15 { throw PhotoFailure("INVALID_OPTIONS") }
      if points.isEmpty { throw PhotoFailure("EMPTY_MASK") }
      count += points.count
      if count>4096 { throw PhotoFailure("MASK_TOO_COMPLEX") }
      return PhotoStroke(radius:radius,points:try points.map { point in
        guard let p=point as? [String:Any], Set(p.keys)==["x","y"] else { throw PhotoFailure("INVALID_OPTIONS") }
        let x=try number(p["x"]); let y=try number(p["y"])
        if x<0 || x>1 || y<0 || y>1 { throw PhotoFailure("INVALID_OPTIONS") }
        return PhotoPoint(x:x,y:y)
      })
    }
  }
}
enum PhotoDimensions {
  static func plan(width:Int,height:Int,options:PhotoOptions) throws -> PhotoPlan {
    _=try fit(width:width,height:height,limit:16_000_000)
    let crop:PhotoRect
    if let selected=options.crop {
      let left=max(0,min(width-1,Int(floor(selected.x*Double(width)))))
      let top=max(0,min(height-1,Int(floor(selected.y*Double(height)))))
      let right=max(left+1,min(width,Int(ceil((selected.x+selected.width)*Double(width)))))
      let bottom=max(top+1,min(height,Int(ceil((selected.y+selected.height)*Double(height)))))
      crop=PhotoRect(x:left,y:top,width:right-left,height:bottom-top)
    }else { crop=PhotoRect(x:0,y:0,width:width,height:height) }
    let requestedWidth=max(1,Int(floor(Double(crop.width)*options.resolution)))
    let requestedHeight=max(1,Int(floor(Double(crop.height)*options.resolution)))
    let size=try fit(width:requestedWidth,height:requestedHeight,limit:options.pixelLimit)
    let downsampled=size.0 != requestedWidth || size.1 != requestedHeight
    if downsampled && !options.allowDownsample { throw PhotoFailure("DOWNSAMPLE_REQUIRED") }
    return PhotoPlan(crop:crop,width:size.0,height:size.1,downsampled:downsampled)
  }
  static func decodeSize(width:Int,height:Int,plan:PhotoPlan) throws -> (Int,Int) {
    if plan.crop==PhotoRect(x:0,y:0,width:width,height:height) { return (plan.width,plan.height) }
    if width*height>16_000_000 { throw PhotoFailure("CROP_SOURCE_TOO_LARGE") }
    return (width,height)
  }
  static func fit(width: Int, height: Int, limit: Int) throws -> (Int,Int) {
    guard width>0,height>0,width<=20000,height<=20000,width*height<=100_000_000 else { throw PhotoFailure("IMAGE_TOO_LARGE") }
    let pixels=width*height
    if pixels<=limit { return (width,height) }
    let scale=sqrt(Double(limit)/Double(pixels))
    return (max(1,Int(floor(Double(width)*scale))),max(1,Int(floor(Double(height)*scale))))
  }
}
