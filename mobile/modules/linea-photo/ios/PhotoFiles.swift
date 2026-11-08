import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import CoreVideo

struct PhotoHeader {
  let width: Int
  let height: Int
  let source: CGImageSource
  let range: PhotoRange
  /// EXIF orientation of the stored image (auxiliary gain maps are stored unrotated).
  let orientation: Int
}

/// A gain map taken from the source (ImageIO auxiliary data) and edited with the base.
struct PhotoGainMap {
  let type: CFString
  var image: PixelImage
  let metadata: CGImageMetadata?
  let neutral: UInt32
}

final class PhotoFiles {
  private let maximumSourceBytes: UInt64 = 2048*1024*1024
  private func sourceURL(_ uri: String) throws -> URL {
    guard let url=URL(string:uri),url.isFileURL,(url.host==nil||url.host==""),url.query==nil,url.fragment==nil else { throw PhotoFailure("LOCAL_FILE_REQUIRED") }
    let attributes=try FileManager.default.attributesOfItem(atPath:url.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
      let size=attributes[.size] as? NSNumber,size.uint64Value<=maximumSourceBytes else { throw PhotoFailure("READ_FAILED") }
    return url
  }
  func header(_ uri: String) throws -> PhotoHeader {
    let url=try sourceURL(uri)
    var range=try PhotoSource.inspect(url)
    guard let source=CGImageSourceCreateWithURL(url as CFURL,[kCGImageSourceShouldCache:false] as CFDictionary),
      let properties=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
      let rawWidth=properties[kCGImagePropertyPixelWidth] as? NSNumber,
      let rawHeight=properties[kCGImagePropertyPixelHeight] as? NSNumber else { throw PhotoFailure("UNSUPPORTED_IMAGE") }
    if CGImageSourceGetCount(source) != 1 { throw PhotoFailure("ANIMATED_IMAGE") }
    let orientation=(properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    let rotated=(5...8).contains(orientation)
    let width=rotated ? rawHeight.intValue : rawWidth.intValue
    let height=rotated ? rawWidth.intValue : rawHeight.intValue
    _=try PhotoDimensions.fit(width:width,height:height,limit:16_000_000)
    if range.value != "hdr" {
      if CGImageSourceCopyAuxiliaryDataInfoAtIndex(source,0,kCGImageAuxiliaryDataTypeHDRGainMap) != nil { range = .gainmap() }
      if #available(iOS 18.0, *) {
        if CGImageSourceCopyAuxiliaryDataInfoAtIndex(source,0,kCGImageAuxiliaryDataTypeISOGainMap) != nil { range = .gainmap() }
      }
    }
    if let depth=properties[kCGImagePropertyDepth] as? NSNumber,depth.intValue>8 { range=range.merge(.deepSdr()) }
    return PhotoHeader(width:width,height:height,source:source,range:range,orientation:orientation)
  }
  func inspect(_ uri: String) throws -> [String:Any] {
    let header=try header(uri);let size=try PhotoDimensions.fit(width:header.width,height:header.height,limit:4_000_000)
    var result:[String:Any]=["width":header.width,"height":header.height,"processingWidth":size.0,"processingHeight":size.1,"downsampled":size.0 != header.width || size.1 != header.height,"dynamicRange":header.range.value]
    if let reason=header.range.reason { result["dynamicRangeReason"]=reason }
    if let kind=header.range.kind { result["hdrKind"]=kind }
    result["hdrPreservable"]=header.range.kind=="gainmap" && rawGainMap(header) != nil
    return result
  }

  /// The ISO 21496-1 gain map of the source (iOS 18+), one 8-bit channel. Apple's older gain maps keep their
  /// headroom in the maker note, which is never copied, so they are sent as SDR after consent instead.
  func rawGainMap(_ header: PhotoHeader) -> (type:CFString,image:PixelImage,metadata:CGImageMetadata?)? {
    guard #available(iOS 18.0, *),
      let info=CGImageSourceCopyAuxiliaryDataInfoAtIndex(header.source,0,kCGImageAuxiliaryDataTypeISOGainMap) as? [CFString:Any],
      let data=info[kCGImageAuxiliaryDataInfoData] as? Data,
      let description=info[kCGImageAuxiliaryDataInfoDataDescription] as? [CFString:Any],
      let width=(description[kCGImagePropertyWidth] as? NSNumber)?.intValue,
      let height=(description[kCGImagePropertyHeight] as? NSNumber)?.intValue,
      let row=(description[kCGImagePropertyBytesPerRow] as? NSNumber)?.intValue,
      let format=(description[kCGImagePropertyPixelFormat] as? NSNumber)?.uint32Value,
      format==kCVPixelFormatType_OneComponent8,width>0,height>0,width<=8192,height<=8192,row>=width,data.count>=row*height else { return nil }
    let bytes=[UInt8](data)
    var pixels=[UInt32](repeating:0,count:width*height)
    for y in 0..<height { for x in 0..<width { pixels[y*width+x]=PhotoGainmap.grey(Int(bytes[y*row+x])) } }
    // CF types cannot be checked with `as?` in Swift; compare type ids instead of force-casting.
    var metadata:CGImageMetadata?=nil
    if let any=info[kCGImageAuxiliaryDataInfoMetadata] { let raw=any as AnyObject;if CFGetTypeID(raw)==CGImageMetadataGetTypeID() { metadata=(raw as! CGImageMetadata) } }
    return (kCGImageAuxiliaryDataTypeISOGainMap,PixelImage(width:width,height:height,pixels:pixels),metadata)
  }

  /// The gain map moved by exactly the same geometry as the base: EXIF orientation, user rotation and mirror,
  /// crop (outward, in map pixels) and the final size at the source map's scale.
  func gainMap(_ header: PhotoHeader, plan: PhotoPlan, options: PhotoOptions) -> PhotoGainMap? {
    guard let raw=rawGainMap(header) else { return nil }
    let (rotation,flip)=PhotoGainmap.combine(PhotoGainmap.orientation(header.orientation),(options.rotation,options.flip))
    let turned=PhotoGainmap.transformed(raw.image,rotation:rotation,flip:flip)
    let (fullWidth,fullHeight)=PhotoDimensions.rotated(width:header.width,height:header.height,rotation:options.rotation)
    let sx=Double(turned.width)/Double(fullWidth),sy=Double(turned.height)/Double(fullHeight)
    let left=max(0,min(turned.width-1,Int(floor(Double(plan.crop.x)*sx)))),top=max(0,min(turned.height-1,Int(floor(Double(plan.crop.y)*sy))))
    let right=max(left+1,min(turned.width,Int(ceil(Double(plan.crop.x+plan.crop.width)*sx)))),bottom=max(top+1,min(turned.height,Int(ceil(Double(plan.crop.y+plan.crop.height)*sy))))
    let width=max(1,Int((Double(plan.width)*sx).rounded())),height=max(1,Int((Double(plan.height)*sy).rounded()))
    let image=PhotoGainmap.resampled(turned,x:left,y:top,width:right-left,height:bottom-top,to:width,height)
    return PhotoGainMap(type:raw.type,image:image,metadata:raw.metadata,neutral:PhotoGainmap.grey(neutral(raw.metadata)))
  }

  /// G0 from hdrgm numbers in the map's metadata; cameras commonly use GainMapMin = 0, whose neutral is 0.
  private func neutral(_ metadata: CGImageMetadata?) -> Int {
    func number(_ name:String) -> Double? {
      guard let metadata,let tag=CGImageMetadataCopyTagWithPath(metadata,nil,"hdrgm:\(name)" as CFString),let value=CGImageMetadataTagCopyValue(tag) else { return nil }
      if let text=value as? String { return Double(text) }
      if let list=value as? [Any],let first=list.first {
        if let text=first as? String { return Double(text) }
        let item=first as AnyObject
        guard CFGetTypeID(item)==CGImageMetadataTagGetTypeID() else { return nil }
        return (CGImageMetadataTagCopyValue(item as! CGImageMetadataTag) as? String).flatMap{Double($0)}
      }
      return nil
    }
    return PhotoGainmap.neutral(gainMapMinLog2:number("GainMapMin") ?? 0,gainMapMaxLog2:number("GainMapMax") ?? 1,gamma:number("Gamma") ?? 1)
  }
  /// Decodes the SDR base. HDR is never dropped silently: without `options.sdr` a gain map that cannot be kept,
  /// an HDR base or an unknown range ends in HDR_NEEDS_CONSENT; with it the base (the camera's own SDR rendition)
  /// is used, and an HDR base is tone-mapped by the system (iOS 17+).
  func decode(_ header: PhotoHeader, plan:PhotoPlan, options:PhotoOptions) throws -> CGImage {
    let range=header.range
    let toneMap=range.value=="hdr" && (range.kind=="pq" || range.kind=="hlg")
    if range.value != "sdr" && !options.sdr && (toneMap || range.value=="unknown" || rawGainMap(header)==nil) { throw PhotoFailure("HDR_NEEDS_CONSENT") }
    let (width,height)=try PhotoDimensions.decodeSize(width:header.width,height:header.height,plan:plan,rotation:options.rotation)
    var decodeOptions:[CFString:Any]=[
      kCGImageSourceCreateThumbnailFromImageAlways:true,
      kCGImageSourceCreateThumbnailWithTransform:true,
      kCGImageSourceThumbnailMaxPixelSize:max(width,height),
      kCGImageSourceShouldCacheImmediately:true,
      kCGImageSourceShouldAllowFloat:false
    ]
    if toneMap, #available(iOS 17.0, *) { decodeOptions[kCGImageSourceDecodeRequest]=kCGImageSourceDecodeToSDR }
    guard let decoded=CGImageSourceCreateThumbnailAtIndex(header.source,0,decodeOptions as CFDictionary) else { throw PhotoFailure("UNSUPPORTED_IMAGE") }
    var current=try resize(try transformed(decoded,rotation:options.rotation,flip:options.flip),width:width,height:height)
    let (fullWidth,fullHeight)=PhotoDimensions.rotated(width:header.width,height:header.height,rotation:options.rotation)
    if plan.crop != PhotoRect(x:0,y:0,width:fullWidth,height:fullHeight) {
      let frame=plan.crop
      guard let cropped=current.cropping(to:CGRect(x:frame.x,y:frame.y,width:frame.width,height:frame.height)) else { throw PhotoFailure("PROCESSING_FAILED") }
      current=cropped
    }
    if current.width != plan.width || current.height != plan.height { current=try resize(current,width:plan.width,height:plan.height) }
    return current
  }

  /// Clockwise rotation then horizontal mirror. CoreGraphics is y-up: a clockwise turn on screen is −θ there,
  /// and the last transform call applies first, so the image is rotated and then mirrored.
  func transformed(_ image: CGImage, rotation: Int, flip: Bool) throws -> CGImage {
    if rotation==0 && !flip { return image }
    let turned=rotation%180 != 0
    let width=turned ? image.height : image.width,height=turned ? image.width : image.height
    guard let space=CGColorSpace(name:CGColorSpace.sRGB),
      let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { throw PhotoFailure("OUT_OF_MEMORY") }
    context.interpolationQuality = .none
    context.translateBy(x:CGFloat(width)/2,y:CGFloat(height)/2)
    if flip { context.scaleBy(x:-1,y:1) }
    context.rotate(by:-CGFloat(rotation)*CGFloat.pi/180)
    context.draw(image,in:CGRect(x:-CGFloat(image.width)/2,y:-CGFloat(image.height)/2,width:CGFloat(image.width),height:CGFloat(image.height)))
    guard let result=context.makeImage() else { throw PhotoFailure("PROCESSING_FAILED") }
    return result
  }

  /// Pen lines after all effects, round caps and joins, like the on-screen preview.
  func drawLines(_ image: CGImage, drawings: [PhotoDrawing]) throws -> CGImage {
    if drawings.isEmpty { return image }
    guard let space=CGColorSpace(name:CGColorSpace.sRGB),
      let context=CGContext(data:nil,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { throw PhotoFailure("OUT_OF_MEMORY") }
    let width=CGFloat(image.width),height=CGFloat(image.height),unit=min(width,height)
    context.draw(image,in:CGRect(x:0,y:0,width:width,height:height))
    context.setLineCap(.round);context.setLineJoin(.round)
    for drawing in drawings {
      let c=drawing.color
      context.setStrokeColor(CGColor(colorSpace:space,components:[CGFloat((c>>16)&255)/255,CGFloat((c>>8)&255)/255,CGFloat(c&255)/255,1]) ?? CGColor(gray:0,alpha:1))
      context.setLineWidth(CGFloat(drawing.width)*unit)
      // Output coordinates are y-down; CoreGraphics is y-up.
      let points=drawing.points.map { CGPoint(x:CGFloat($0.x)*width,y:height-CGFloat($0.y)*height) }
      context.beginPath();context.move(to:points[0])
      if points.count==1 { context.addLine(to:CGPoint(x:points[0].x+0.01,y:points[0].y)) }
      for point in points.dropFirst() { context.addLine(to:point) }
      context.strokePath()
    }
    guard let result=context.makeImage() else { throw PhotoFailure("PROCESSING_FAILED") }
    return result
  }
  func resize(_ image: CGImage, width: Int, height: Int, opaque:Bool=false) throws -> CGImage {
    guard let space=CGColorSpace(name:CGColorSpace.sRGB),
      let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { throw PhotoFailure("OUT_OF_MEMORY") }
    context.interpolationQuality = .high
    if opaque { context.setFillColor(CGColor(gray:1,alpha:1));context.fill(CGRect(x:0,y:0,width:width,height:height)) }
    context.draw(image,in:CGRect(x:0,y:0,width:width,height:height))
    guard let result=context.makeImage() else { throw PhotoFailure("PROCESSING_FAILED") }
    return result
  }
  func pixels(_ image: CGImage) throws -> PixelImage {
    var bytes=[UInt8](repeating:0,count:image.width*image.height*4)
    let success=bytes.withUnsafeMutableBytes { raw -> Bool in
      guard let space=CGColorSpace(name:CGColorSpace.sRGB),let context=CGContext(data:raw.baseAddress,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
      context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height));return true
    }
    if !success { throw PhotoFailure("OUT_OF_MEMORY") }
    var pixels=[UInt32](repeating:0,count:image.width*image.height)
    for i in pixels.indices {
      let a=Int(bytes[i*4+3])
      if a>0 {
        let r=min(255,(Int(bytes[i*4])*255+a/2)/a)
        let g=min(255,(Int(bytes[i*4+1])*255+a/2)/a)
        let b=min(255,(Int(bytes[i*4+2])*255+a/2)/a)
        pixels[i]=UInt32(a)<<24 | UInt32(r)<<16 | UInt32(g)<<8 | UInt32(b)
      }
    }
    return PixelImage(width:image.width,height:image.height,pixels:pixels)
  }
  func image(_ value: PixelImage) throws -> CGImage {
    var bytes=[UInt8](repeating:0,count:value.pixels.count*4)
    for i in value.pixels.indices {
      let p=value.pixels[i];let a=Int(p>>24)
      bytes[i*4]=UInt8((Int((p>>16)&255)*a+127)/255)
      bytes[i*4+1]=UInt8((Int((p>>8)&255)*a+127)/255)
      bytes[i*4+2]=UInt8((Int(p&255)*a+127)/255)
      bytes[i*4+3]=UInt8(a)
    }
    guard let space=CGColorSpace(name:CGColorSpace.sRGB),let provider=CGDataProvider(data:Data(bytes) as CFData),
      let image=CGImage(width:value.width,height:value.height,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:value.width*4,space:space,bitmapInfo:CGBitmapInfo(rawValue:CGImageAlphaInfo.premultipliedLast.rawValue|CGBitmapInfo.byteOrder32Big.rawValue),provider:provider,decode:nil,shouldInterpolate:false,intent:.defaultIntent) else { throw PhotoFailure("PROCESSING_FAILED") }
    return image
  }
  private func directory() throws -> URL {
    let caches=try FileManager.default.url(for:.cachesDirectory,in:.userDomainMask,appropriateFor:nil,create:true)
    var url=caches.appendingPathComponent("linea-photo",isDirectory:true)
    try FileManager.default.createDirectory(at:url,withIntermediateDirectories:true)
    var values=URLResourceValues();values.isExcludedFromBackup=true;try url.setResourceValues(values)
    return url
  }
  private func encode(_ image: CGImage, format:String, gain:PhotoGainMap?=nil) throws -> URL {
    let jpeg=format=="jpeg"
    let url=try directory().appendingPathComponent("linea-native-photo-\(UUID().uuidString.lowercased()).\(jpeg ? "jpg" : "png")")
    do {
      guard let destination=CGImageDestinationCreateWithURL(url as CFURL,(jpeg ? UTType.jpeg : UTType.png).identifier as CFString,1,nil) else { throw PhotoFailure("WRITE_FAILED") }
      // A fresh bitmap is written. No source properties/EXIF/IPTC/XMP dictionaries
      // are copied; the JS boundary additionally validates/strips format metadata.
      let output=jpeg ? try resize(image,width:image.width,height:image.height,opaque:true) : image
      let properties:[CFString:Any]=[kCGImageDestinationLossyCompressionQuality:1.0,kCGImageDestinationEmbedThumbnail:false]
      CGImageDestinationAddImage(destination,output,properties as CFDictionary)
      if jpeg, let gain {
        // The edited map is written as auxiliary data of the same type (ISO 21496-1), unrotated like the base.
        var bytes=[UInt8](repeating:0,count:gain.image.width*gain.image.height)
        for i in bytes.indices { bytes[i]=UInt8((gain.image.pixels[i]>>16)&255) }
        var info:[CFString:Any]=[
          kCGImageAuxiliaryDataInfoData:Data(bytes),
          kCGImageAuxiliaryDataInfoDataDescription:[kCGImagePropertyWidth:gain.image.width,kCGImagePropertyHeight:gain.image.height,kCGImagePropertyBytesPerRow:gain.image.width,kCGImagePropertyPixelFormat:kCVPixelFormatType_OneComponent8] as [CFString:Any]
        ]
        if let metadata=gain.metadata { info[kCGImageAuxiliaryDataInfoMetadata]=metadata }
        CGImageDestinationAddAuxiliaryDataInfo(destination,gain.type,info as CFDictionary)
      }
      if !CGImageDestinationFinalize(destination) { throw PhotoFailure("WRITE_FAILED") }
      try FileManager.default.setAttributes([.protectionKey:FileProtectionType.complete],ofItemAtPath:url.path)
      return url
    }catch {
      if FileManager.default.fileExists(atPath:url.path) {
        do { try FileManager.default.removeItem(at:url) }catch { throw PhotoFailure("DELETE_FAILED") }
      }
      throw error
    }
  }
  func save(_ image: CGImage, allowDownsample: Bool, format:String="png", gain:PhotoGainMap?=nil) throws -> [String:Any] {
    if gain != nil && format != "jpeg" { throw PhotoFailure("INVALID_OPTIONS") }
    var current=image
    var map=gain
    for _ in 0..<4 {
      let url=try encode(current,format:format,gain:map)
      do {
        let attributes=try FileManager.default.attributesOfItem(atPath:url.path)
        let size=(attributes[.size] as? NSNumber)?.doubleValue ?? .infinity
        if size<=20*1024*1024 {
          var result:[String:Any]=["uri":url.absoluteString,"width":current.width,"height":current.height,"downsampled":current.width != image.width || current.height != image.height,"format":format,"mimeType":format=="jpeg" ? "image/jpeg" : "image/png"]
          if map != nil { result["hdr"]="gainmap" }
          return result
        }
        try FileManager.default.removeItem(at:url)
        if !allowDownsample { throw PhotoFailure("OUTPUT_TOO_LARGE") }
        let factor=min(0.9,sqrt((20*1024*1024)/size)*0.9)
        current=try resize(current,width:max(1,Int(floor(Double(current.width)*factor))),height:max(1,Int(floor(Double(current.height)*factor))))
        if let old=map {
          let width=max(1,Int(floor(Double(old.image.width)*factor))),height=max(1,Int(floor(Double(old.image.height)*factor)))
          map=PhotoGainMap(type:old.type,image:PhotoGainmap.resampled(old.image,x:0,y:0,width:old.image.width,height:old.image.height,to:width,height),metadata:old.metadata,neutral:old.neutral)
        }
      }catch {
        if FileManager.default.fileExists(atPath:url.path) {
          do { try FileManager.default.removeItem(at:url) }
          catch { throw PhotoFailure("DELETE_FAILED") }
        }
        throw error
      }
    }
    throw PhotoFailure("OUTPUT_TOO_LARGE")
  }
  func dispose(_ uri: String) throws {
    guard let url=URL(string:uri),url.isFileURL,(url.host==nil||url.host==""),url.query==nil,url.fragment==nil else { throw PhotoFailure("INVALID_OUTPUT") }
    let canonical=url.resolvingSymlinksInPath().standardizedFileURL
    let parent=try directory().resolvingSymlinksInPath().standardizedFileURL
    guard canonical.deletingLastPathComponent()==parent,
      canonical.lastPathComponent.range(of:"^linea-native-photo-[0-9a-fA-F-]{36}\\.(png|jpg)$",options:.regularExpression) != nil else { throw PhotoFailure("INVALID_OUTPUT") }
    if FileManager.default.fileExists(atPath:canonical.path) { try FileManager.default.removeItem(at:canonical) }
  }
  func clearCache() throws {
    let folder=try directory()
    for url in try FileManager.default.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil) {
      if url.lastPathComponent.range(of:"^linea-native-photo-[0-9a-fA-F-]{36}\\.(png|jpg)$",options:.regularExpression) != nil { try dispose(url.absoluteString) }
    }
  }
}
