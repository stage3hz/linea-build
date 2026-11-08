import Foundation
import CoreFoundation

struct PhotoCrop { let x:Double;let y:Double;let width:Double;let height:Double }
struct PhotoRect: Equatable { let x:Int;let y:Int;let width:Int;let height:Int }
struct PhotoPlan { let crop:PhotoRect;let width:Int;let height:Int;let downsampled:Bool }

/// Geometry order (shared with geometry.ts and the golden table): EXIF orientation, user rotation (clockwise),
/// mirror, crop in that rotated frame, resolution, pixel limit, scale. Strokes/drawings are in the output frame.
struct PhotoOptions {
  let background: String
  let document: String
  let scale: Int
  let strokes: [PhotoStroke]
  let allowDownsample: Bool
  let format: String
  let resolution: Double
  let crop: PhotoCrop?
  let rotation: Int
  let flip: Bool
  let drawings: [PhotoDrawing]
  let dynamicRange: String
  let previewPixels: Int?
  var plain: Bool { background == "keep" && document == "none" && scale == 1 && strokes.isEmpty }
  var pixelLimit: Int { min(plain ? 16_000_000 : min(4_000_000,8_000_000/(scale*scale)),previewPixels ?? Int.max) }
  /// A fast preview is reduced without consent; it is shown on screen only and never uploaded.
  var downsampleAllowed: Bool { allowDownsample || previewPixels != nil }
  /// Explicit consent to SDR, or a preview (always SDR).
  var sdr: Bool { dynamicRange == "sdr" || previewPixels != nil }
  /// Modes that cannot carry a gain map.
  var sdrOnly: Bool { background == "transparent" || document != "none" || format == "png" }
  init(_ value: [String:Any]) throws {
    guard Set(value.keys).isSubset(of:["background","document","scale","strokes","allowDownsample","format","resolution","crop","rotation","flip","drawings","dynamicRange","preview"]),
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
    let rotation=value["rotation"] == nil ? 0 : try Self.number(value["rotation"])
    if ![0,90,180,270].contains(rotation) { throw PhotoFailure("INVALID_OPTIONS") }
    self.rotation=Int(rotation)
    var flip=false
    if let raw=value["flip"] {
      guard let boolean=raw as? NSNumber, CFGetTypeID(boolean)==CFBooleanGetTypeID() else { throw PhotoFailure("INVALID_OPTIONS") }
      flip=boolean.boolValue
    }
    self.flip=flip
    self.drawings=try value["drawings"].map { try Self.parseDrawings($0) } ?? []
    if let raw=value["dynamicRange"] {
      guard let string=raw as? String,["keep","sdr"].contains(string) else { throw PhotoFailure("INVALID_OPTIONS") }
      self.dynamicRange=string
    } else { self.dynamicRange="keep" }
    if let raw=value["preview"] {
      guard let object=raw as? [String:Any],Set(object.keys)==["maxPixels"] else { throw PhotoFailure("INVALID_OPTIONS") }
      let pixels=try Self.number(object["maxPixels"])
      if pixels<65_536 || pixels>4_000_000 || pixels != pixels.rounded() { throw PhotoFailure("INVALID_OPTIONS") }
      self.previewPixels=Int(pixels)
    } else { self.previewPixels=nil }
  }
  private static func parsePoints(_ value:Any?) throws -> [PhotoPoint] {
    guard let points=value as? [Any] else { throw PhotoFailure("INVALID_OPTIONS") }
    if points.isEmpty { throw PhotoFailure("EMPTY_MASK") }
    return try points.map { point in
      guard let p=point as? [String:Any], Set(p.keys)==["x","y"] else { throw PhotoFailure("INVALID_OPTIONS") }
      let x=try number(p["x"]); let y=try number(p["y"])
      // Strokes crossing the crop edge may reach slightly outside the output frame.
      if x < -16 || x > 17 || y < -16 || y > 17 { throw PhotoFailure("INVALID_OPTIONS") }
      return PhotoPoint(x:x,y:y)
    }
  }
  private static func parseDrawings(_ value:Any) throws -> [PhotoDrawing] {
    guard let raw=value as? [Any] else { throw PhotoFailure("INVALID_OPTIONS") }
    if raw.count>256 { throw PhotoFailure("MASK_TOO_COMPLEX") }
    var count=0
    return try raw.map { item in
      guard let object=item as? [String:Any],Set(object.keys)==["color","width","points"],let color=object["color"] as? String,
        color.count==7,color.hasPrefix("#"),let rgb=UInt32(color.dropFirst(),radix:16) else { throw PhotoFailure("INVALID_OPTIONS") }
      if color.dropFirst().contains(where:{!$0.isHexDigit}) { throw PhotoFailure("INVALID_OPTIONS") }
      let width=try number(object["width"])
      if width<0.0005 || width>2 { throw PhotoFailure("INVALID_OPTIONS") }
      let points=try parsePoints(object["points"])
      count += points.count
      if count>8192 { throw PhotoFailure("MASK_TOO_COMPLEX") }
      return PhotoDrawing(color:rgb,width:width,points:points)
    }
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
    if raw.count>256 { throw PhotoFailure("MASK_TOO_COMPLEX") }
    var count=0
    return try raw.map { item in
      guard let object=item as? [String:Any],Set(object.keys)==["radius","points"] else { throw PhotoFailure("INVALID_OPTIONS") }
      let radius=try number(object["radius"])
      // A crop rescales the brush: a source-relative radius grows relative to a small crop.
      if radius<0.0005 || radius>2 { throw PhotoFailure("INVALID_OPTIONS") }
      let points=try parsePoints(object["points"])
      count += points.count
      if count>4096 { throw PhotoFailure("MASK_TOO_COMPLEX") }
      return PhotoStroke(radius:radius,points:points)
    }
  }
}
enum PhotoDimensions {
  static func rotated(width:Int,height:Int,rotation:Int) -> (Int,Int) { rotation%180==0 ? (width,height) : (height,width) }
  static func plan(width sourceWidth:Int,height sourceHeight:Int,options:PhotoOptions) throws -> PhotoPlan {
    _=try fit(width:sourceWidth,height:sourceHeight,limit:16_000_000)
    let (width,height)=rotated(width:sourceWidth,height:sourceHeight,rotation:options.rotation)
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
    if downsampled && !options.downsampleAllowed { throw PhotoFailure("DOWNSAMPLE_REQUIRED") }
    return PhotoPlan(crop:crop,width:size.0,height:size.1,downsampled:downsampled)
  }
  /// Size requested from the decoder in the rotated frame, before the crop.
  static func decodeSize(width sourceWidth:Int,height sourceHeight:Int,plan:PhotoPlan,rotation:Int=0) throws -> (Int,Int) {
    let (width,height)=rotated(width:sourceWidth,height:sourceHeight,rotation:rotation)
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
