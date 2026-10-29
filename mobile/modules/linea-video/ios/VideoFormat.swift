import Foundation
import AVFoundation
import CoreMedia
import CoreGraphics
import AudioToolbox

struct VideoTrackInfo {
  let asset:AVURLAsset
  let video:AVAssetTrack
  let audio:AVAssetTrack?
  let original:CMFormatDescription
  let format:CMFormatDescription
  let lengthBytes:Int
  let hevc:Bool
  let hdr:String
  let width:Int
  let height:Int
  let duration:Double
  let rotation:Int
  let transform:CGAffineTransform
  let removed:Int

  init(_ url:URL) throws {
    asset=AVURLAsset(url:url,options:[AVURLAssetPreferPreciseDurationAndTimingKey:true])
    if asset.hasProtectedContent {throw VideoFailure("DRM_UNSUPPORTED")}
    let all=asset.tracks,videoTracks=all.filter{$0.mediaType == .video},audioTracks=all.filter{$0.mediaType == .audio}
    guard !all.isEmpty,all.count<=32 else {throw VideoFailure("UNSUPPORTED_TRACKS")}
    if videoTracks.isEmpty && !audioTracks.isEmpty && audioTracks.count==all.count && audioTracks.allSatisfy(VideoFormat.knownAudio) {throw VideoFailure("NO_VIDEO_TRACK")}
    guard all.count<=32,videoTracks.count==1,audioTracks.count<=1 else {throw VideoFailure("UNSUPPORTED_TRACKS")}
    video=videoTracks[0];audio=audioTracks.first;removed=all.count-videoTracks.count-audioTracks.count
    guard let descriptions=video.formatDescriptions as? [CMFormatDescription],descriptions.count==1 else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
    original=descriptions[0]
    let codec=CMFormatDescriptionGetMediaSubType(original)
    guard codec==kCMVideoCodecType_H264||codec==kCMVideoCodecType_HEVC else {throw VideoFailure("UNSUPPORTED_CODEC")}
    hevc=codec==kCMVideoCodecType_HEVC
    let dimensions=CMVideoFormatDescriptionGetDimensions(original)
    width=Int(dimensions.width);height=Int(dimensions.height)
    guard width>0,height>0,width<=16384,height<=16384 else {throw VideoFailure("VIDEO_DIMENSIONS")}
    duration=CMTimeGetSeconds(asset.duration)
    guard duration.isFinite,duration>0,duration<=VideoPolicy.maxDuration else {throw VideoFailure("UNSUPPORTED_DURATION")}
    let orientation=try VideoFormat.orientation(video.preferredTransform,width:width,height:height)
    rotation=orientation.0;transform=orientation.1
    hdr=try VideoFormat.hdr(original)
    let configuration=try VideoFormat.clean(original,hevc:hevc,hdr:hdr)
    format=configuration.0;lengthBytes=configuration.1
  }
  func info(inputBytes:Int) -> [String:Any] {
    ["width":width,"height":height,"durationMs":duration*1000,"rotation":rotation,
     "videoCodec":hevc ? "hevc":"avc","hasAudio":audio != nil,"hdr":hdr,
     "inputBytes":inputBytes,"removedTrackCount":removed]
  }
}

enum VideoFormat {
  static func knownAudio(_ track:AVAssetTrack) -> Bool {
    guard let formats=track.formatDescriptions as? [CMFormatDescription],!formats.isEmpty else {return false}
    let codecs:Set<AudioFormatID>=[kAudioFormatMPEG4AAC,kAudioFormatMPEG4AAC_HE,kAudioFormatMPEG4AAC_HE_V2,kAudioFormatMPEGLayer3,kAudioFormatAppleLossless,kAudioFormatLinearPCM]
    return formats.allSatisfy {format in
      guard let asbd=CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else {return false}
      return codecs.contains(asbd.mFormatID) && asbd.mChannelsPerFrame>0 && asbd.mSampleRate.isFinite && asbd.mSampleRate>0
    }
  }
  static func orientation(_ source:CGAffineTransform,width:Int,height:Int) throws -> (Int,CGAffineTransform) {
    // Front-camera recordings are often mirrored: a rotation combined with a
    // horizontal flip (determinant -1). Those four exact matrices are accepted too.
    if abs(source.a*source.d-source.b*source.c+1)<0.001 {
      let mirrored:[(Int,CGAffineTransform)]=[
        (0,CGAffineTransform(a:-1,b:0,c:0,d:1,tx:CGFloat(width),ty:0)),
        (90,CGAffineTransform(a:0,b:1,c:1,d:0,tx:0,ty:0)),
        (180,CGAffineTransform(a:1,b:0,c:0,d:-1,tx:0,ty:CGFloat(height))),
        (270,CGAffineTransform(a:0,b:-1,c:-1,d:0,tx:CGFloat(height),ty:CGFloat(width))),
      ]
      for (degrees,candidate) in mirrored {
        let first=[source.a,source.b,source.c,source.d,source.tx,source.ty],second=[candidate.a,candidate.b,candidate.c,candidate.d,candidate.tx,candidate.ty]
        if zip(first,second).allSatisfy({pair in pair.0.isFinite && abs(pair.0-pair.1)<0.001}) {return (degrees,candidate)}
      }
      throw VideoFailure("UNSUPPORTED_TRANSFORM")
    }
    let angle=Int((atan2(source.b,source.a)*180 / .pi).rounded())
    let degrees=(angle%360+360)%360
    let output:CGAffineTransform
    switch degrees {
    case 0:output = .identity
    case 90:output=CGAffineTransform(a:0,b:1,c:-1,d:0,tx:CGFloat(height),ty:0)
    case 180:output=CGAffineTransform(a:-1,b:0,c:0,d:-1,tx:CGFloat(width),ty:CGFloat(height))
    case 270:output=CGAffineTransform(a:0,b:-1,c:1,d:0,tx:0,ty:CGFloat(width))
    default:throw VideoFailure("UNSUPPORTED_TRANSFORM")
    }
    let first=[source.a,source.b,source.c,source.d,source.tx,source.ty],second=[output.a,output.b,output.c,output.d,output.tx,output.ty]
    guard zip(first,second).allSatisfy({pair in pair.0.isFinite && abs(pair.0-pair.1)<0.001}) else {throw VideoFailure("UNSUPPORTED_TRANSFORM")}
    return (degrees,output)
  }
  static func hdr(_ description:CMFormatDescription) throws -> String {
    let atoms=CMFormatDescriptionGetExtension(description,extensionKey:kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String:Any] ?? [:]
    if atoms.keys.contains(where:{["dvcC","dvvC","dvwC"].contains($0)}) {throw VideoFailure("DYNAMIC_HDR_UNSUPPORTED")}
    let transfer=CMFormatDescriptionGetExtension(description,extensionKey:kCMFormatDescriptionExtension_TransferFunction) as? String
    let primaries=CMFormatDescriptionGetExtension(description,extensionKey:kCMFormatDescriptionExtension_ColorPrimaries) as? String
    if transfer==kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String || transfer==kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String {
      guard primaries==kCMFormatDescriptionColorPrimaries_ITU_R_2020 as String else {throw VideoFailure("UNKNOWN_HDR")}
      return transfer==kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String ? "pq":"hlg"
    }
    if let transfer=transfer,!["ITU_R_709_2","ITU_R_2020","sRGB","SMPTE_240M_1995","Linear"].contains(transfer) {throw VideoFailure("UNKNOWN_HDR")}
    if transfer=="Linear" && primaries==kCMFormatDescriptionColorPrimaries_ITU_R_2020 as String {throw VideoFailure("UNKNOWN_HDR")}
    for key in [kCMFormatDescriptionExtension_MasteringDisplayColorVolume,kCMFormatDescriptionExtension_ContentLightLevelInfo] {
      if CMFormatDescriptionGetExtension(description,extensionKey:key) != nil {throw VideoFailure("UNKNOWN_HDR")}
    }
    return "sdr"
  }
  private static func parameters(_ source:CMFormatDescription,hevc:Bool) throws -> ([NSData],Int) {
    var count=0;var length:Int32=0
    let status=hevc ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(source,parameterSetIndex:0,parameterSetPointerOut:nil,parameterSetSizeOut:nil,parameterSetCountOut:&count,nalUnitHeaderLengthOut:&length) : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(source,parameterSetIndex:0,parameterSetPointerOut:nil,parameterSetSizeOut:nil,parameterSetCountOut:&count,nalUnitHeaderLengthOut:&length)
    guard status==noErr,count>=2,count<=256,[1,2,4].contains(Int(length)) else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
    var result=[NSData]()
    for index in 0..<count {
      var pointer:UnsafePointer<UInt8>?;var size=0
      let status=hevc ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(source,parameterSetIndex:index,parameterSetPointerOut:&pointer,parameterSetSizeOut:&size,parameterSetCountOut:nil,nalUnitHeaderLengthOut:nil) : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(source,parameterSetIndex:index,parameterSetPointerOut:&pointer,parameterSetSizeOut:&size,parameterSetCountOut:nil,nalUnitHeaderLengthOut:nil)
      guard status==noErr,let pointer=pointer,size>0,size<=262144 else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
      let data=Data(bytes:pointer,count:size),kind=try VideoNal.type([UInt8](data),hevc:hevc)
      guard (hevc ? [32,33,34]:[7,8,13]).contains(kind) else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
      result.append(data as NSData)
    }
    return (result,Int(length))
  }
  static func clean(_ source:CMFormatDescription,hevc:Bool,hdr:String) throws -> (CMFormatDescription,Int) {
    let (parameters,length)=try parameters(source,hevc:hevc)
    let sps=try parameters.filter{try VideoNal.type([UInt8]($0 as Data),hevc:hevc)==(hevc ? 33:7)}
    guard !sps.isEmpty else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
    let transferKnown=CMFormatDescriptionGetExtension(source,extensionKey:kCMFormatDescriptionExtension_TransferFunction) != nil
    for parameter in sps {
      let depth=try VideoBits.depth([UInt8](parameter as Data),hevc:hevc)
      if (depth>8 && !transferKnown)||(depth<10 && hdr != "sdr") {throw VideoFailure("UNKNOWN_HDR")}
    }
    let pointers=parameters.map{$0.bytes.assumingMemoryBound(to:UInt8.self)},sizes=parameters.map{$0.length}
    var base:CMFormatDescription?
    let status=withExtendedLifetime(parameters) {
      pointers.withUnsafeBufferPointer { pointer in sizes.withUnsafeBufferPointer { size in
        if hevc {return CMVideoFormatDescriptionCreateFromHEVCParameterSets(allocator:kCFAllocatorDefault,parameterSetCount:parameters.count,parameterSetPointers:pointer.baseAddress!,parameterSetSizes:size.baseAddress!,nalUnitHeaderLength:Int32(length),extensions:nil,formatDescriptionOut:&base)}
        return CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator:kCFAllocatorDefault,parameterSetCount:parameters.count,parameterSetPointers:pointer.baseAddress!,parameterSetSizes:size.baseAddress!,nalUnitHeaderLength:Int32(length),formatDescriptionOut:&base)
      } }
    }
    guard status==noErr,let base=base,let atoms=CMFormatDescriptionGetExtension(base,extensionKey:kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
    let dimensions=CMVideoFormatDescriptionGetDimensions(base)
    var extensions:[String:Any]=[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms as String:atoms]
    try copyColor(source,to:&extensions)
    try copyHdr(source,to:&extensions,hdr:hdr)
    var output:CMFormatDescription?
    let created=CMVideoFormatDescriptionCreate(allocator:kCFAllocatorDefault,codecType:hevc ? kCMVideoCodecType_HEVC:kCMVideoCodecType_H264,width:dimensions.width,height:dimensions.height,extensions:extensions as CFDictionary,formatDescriptionOut:&output)
    guard created==noErr,let output=output else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
    return (output,length)
  }
  private static func copyColor(_ source:CMFormatDescription,to output:inout [String:Any]) throws {
    let known:[String:Set<String>]=[
      kCMFormatDescriptionExtension_ColorPrimaries as String:["ITU_R_709_2","ITU_R_2020","P3_D65","P3_DCI","EBU_3213","SMPTE_C"],
      kCMFormatDescriptionExtension_TransferFunction as String:["ITU_R_709_2","ITU_R_2020","sRGB","SMPTE_240M_1995","Linear","SMPTE_ST_2084_PQ","ITU_R_2100_HLG"],
      kCMFormatDescriptionExtension_YCbCrMatrix as String:["ITU_R_709_2","ITU_R_601_4","SMPTE_240M_1995","ITU_R_2020"]
    ]
    for (key,values) in known {
      if let value=CMFormatDescriptionGetExtension(source,extensionKey:key as CFString) {
        guard let value=value as? String,values.contains(value) else {throw VideoFailure("UNKNOWN_COLOR")};output[key]=value
      }
    }
    if let value=CMFormatDescriptionGetExtension(source,extensionKey:kCMFormatDescriptionExtension_FullRangeVideo) as? Bool {output[kCMFormatDescriptionExtension_FullRangeVideo as String]=value}
    try copyGeometry(source,key:kCMFormatDescriptionExtension_PixelAspectRatio,names:["HorizontalSpacing","VerticalSpacing"],allowZero:false,to:&output)
    try copyGeometry(source,key:kCMFormatDescriptionExtension_CleanAperture,names:["Width","Height","HorizontalOffset","VerticalOffset"],allowZero:true,to:&output)
  }
  private static func copyGeometry(_ source:CMFormatDescription,key:CFString,names:[String],allowZero:Bool,to output:inout [String:Any]) throws {
    guard let raw=CMFormatDescriptionGetExtension(source,extensionKey:key) else {return}
    guard let dictionary=raw as? [String:Any] else {throw VideoFailure("UNSUPPORTED_APERTURE")}
    var clean=[String:Double]()
    for name in names {
      guard let value=dictionary[name] as? NSNumber,value.doubleValue.isFinite,abs(value.doubleValue)<=65535 else {throw VideoFailure("UNSUPPORTED_APERTURE")}
      if !allowZero && value.doubleValue<=0 {throw VideoFailure("UNSUPPORTED_APERTURE")}
      if ["Width","Height"].contains(name) && value.doubleValue<=0 {throw VideoFailure("UNSUPPORTED_APERTURE")}
      clean[name]=value.doubleValue
    }
    output[key as String]=clean
  }
  private static func copyHdr(_ source:CMFormatDescription,to output:inout [String:Any],hdr:String) throws {
    for (key,type) in [(kCMFormatDescriptionExtension_MasteringDisplayColorVolume,137),(kCMFormatDescriptionExtension_ContentLightLevelInfo,144)] {
      if let raw=CMFormatDescriptionGetExtension(source,extensionKey:key) {
        guard hdr != "sdr",let data=raw as? Data else {throw VideoFailure("UNKNOWN_HDR")}
        try VideoNal.validateHdr(type,data:[UInt8](data),hdr:hdr);output[key as String]=data
      }
    }
  }
}
