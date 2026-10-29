import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct PhotoHeader {
  let width: Int
  let height: Int
  let source: CGImageSource
  let range: PhotoRange
}

final class PhotoFiles {
  private let maximumSourceBytes: UInt64 = 100*1024*1024
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
      if CGImageSourceCopyAuxiliaryDataInfoAtIndex(source,0,kCGImageAuxiliaryDataTypeHDRGainMap) != nil { range = .hdr() }
      if #available(iOS 18.0, *) {
        if CGImageSourceCopyAuxiliaryDataInfoAtIndex(source,0,kCGImageAuxiliaryDataTypeISOGainMap) != nil { range = .hdr() }
      }
    }
    if let depth=properties[kCGImagePropertyDepth] as? NSNumber,depth.intValue>8 { range=range.merge(.unknown()) }
    return PhotoHeader(width:width,height:height,source:source,range:range)
  }
  func inspect(_ uri: String) throws -> [String:Any] {
    let header=try header(uri);let size=try PhotoDimensions.fit(width:header.width,height:header.height,limit:4_000_000)
    var result:[String:Any]=["width":header.width,"height":header.height,"processingWidth":size.0,"processingHeight":size.1,"downsampled":size.0 != header.width || size.1 != header.height,"dynamicRange":header.range.value]
    if let reason=header.range.reason { result["dynamicRangeReason"]=reason }
    return result
  }
  func decode(_ header: PhotoHeader, plan:PhotoPlan) throws -> CGImage {
    if header.range.value != "sdr" { throw PhotoFailure("HDR_UNSUPPORTED") }
    let (width,height)=try PhotoDimensions.decodeSize(width:header.width,height:header.height,plan:plan)
    let options:[CFString:Any]=[
      kCGImageSourceCreateThumbnailFromImageAlways:true,
      kCGImageSourceCreateThumbnailWithTransform:true,
      kCGImageSourceThumbnailMaxPixelSize:max(width,height),
      kCGImageSourceShouldCacheImmediately:true,
      kCGImageSourceShouldAllowFloat:false
    ]
    guard let decoded=CGImageSourceCreateThumbnailAtIndex(header.source,0,options as CFDictionary) else { throw PhotoFailure("UNSUPPORTED_IMAGE") }
    var current=try resize(decoded,width:width,height:height)
    if plan.crop != PhotoRect(x:0,y:0,width:header.width,height:header.height) {
      let frame=plan.crop
      guard let cropped=current.cropping(to:CGRect(x:frame.x,y:frame.y,width:frame.width,height:frame.height)) else { throw PhotoFailure("PROCESSING_FAILED") }
      current=cropped
    }
    if current.width != plan.width || current.height != plan.height { current=try resize(current,width:plan.width,height:plan.height) }
    return current
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
  private func encode(_ image: CGImage, format:String) throws -> URL {
    let jpeg=format=="jpeg"
    let url=try directory().appendingPathComponent("linea-native-photo-\(UUID().uuidString.lowercased()).\(jpeg ? "jpg" : "png")")
    do {
      guard let destination=CGImageDestinationCreateWithURL(url as CFURL,(jpeg ? UTType.jpeg : UTType.png).identifier as CFString,1,nil) else { throw PhotoFailure("WRITE_FAILED") }
      // A fresh bitmap is written. No source properties/EXIF/IPTC/XMP dictionaries
      // are copied; the JS boundary additionally validates/strips format metadata.
      let output=jpeg ? try resize(image,width:image.width,height:image.height,opaque:true) : image
      let properties:[CFString:Any]=[kCGImageDestinationLossyCompressionQuality:1.0,kCGImageDestinationEmbedThumbnail:false]
      CGImageDestinationAddImage(destination,output,properties as CFDictionary)
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
  func save(_ image: CGImage, allowDownsample: Bool, format:String="png") throws -> [String:Any] {
    var current=image
    for _ in 0..<4 {
      let url=try encode(current,format:format)
      do {
        let attributes=try FileManager.default.attributesOfItem(atPath:url.path)
        let size=(attributes[.size] as? NSNumber)?.doubleValue ?? .infinity
        if size<=20*1024*1024 { return ["uri":url.absoluteString,"width":current.width,"height":current.height,"downsampled":current.width != image.width || current.height != image.height,"format":format,"mimeType":format=="jpeg" ? "image/jpeg" : "image/png"] }
        try FileManager.default.removeItem(at:url)
        if !allowDownsample { throw PhotoFailure("OUTPUT_TOO_LARGE") }
        let factor=min(0.9,sqrt((20*1024*1024)/size)*0.9)
        current=try resize(current,width:max(1,Int(floor(Double(current.width)*factor))),height:max(1,Int(floor(Double(current.height)*factor))))
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
