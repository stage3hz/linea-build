import Foundation
import zlib

struct PhotoRange {
  let value:String
  var reason:String?=nil
  func merge(_ other:PhotoRange) -> PhotoRange {
    if value=="hdr" { return self };if other.value=="hdr" { return other }
    return value=="unknown" ? self : other
  }
  static func hdr() -> PhotoRange { PhotoRange(value:"hdr",reason:"В файле найдены HDR-данные или карта яркости. Этот редактор пока не сохраняет их при обработке.") }
  static func unknown() -> PhotoRange { PhotoRange(value:"unknown",reason:"Динамический диапазон или точность этого файла нельзя безопасно сохранить в 8-битном редакторе.") }
}

/// Inspect the container before ImageIO can select its backward-compatible SDR look.
enum PhotoSource {
  private static let maximumMetadata=4*1024*1024
  static func inspect(_ url:URL) throws -> PhotoRange {
    let input=try PhotoCursor(url);defer{try? input.close()}
    let first=try input.take(12)
    if Array(first.prefix(8))==[137,80,78,71,13,10,26,10] { return try png(input,length:photoU32(first,8)) }
    if first[0]==255 && first[1]==216 { try input.seek(2);return try jpeg(input) }
    if ["GIF87a","GIF89a"].contains(photoText(first,0,6)) { throw PhotoFailure("ANIMATED_IMAGE") }
    if photoText(first,0,4)=="RIFF" && photoText(first,8,4)=="WEBP" { return try webp(input) }
    if photoText(first,4,4)=="ftyp" {
      try input.seek(0);let state=BoxState();try boxes(input,end:input.size,depth:0,state:state)
      let associated=state.associations[state.primary] ?? []
      let known=state.images.contains(state.primary) && associated.contains(where:{state.colors.contains($0)}) && associated.contains(where:{state.depths.contains($0)}) && state.codec
      return known ? state.range : state.range.merge(.unknown())
    }
    if photoText(first,0,2)=="BM" { let data=try input.take(42);let dib=Int(data[2])|Int(data[3])<<8|Int(data[4])<<16|Int(data[5])<<24;return dib==40 ? PhotoRange(value:"sdr") : .unknown() }
    return .unknown()
  }
  private static func png(_ input:PhotoCursor,length:Int) throws -> PhotoRange {
    var length=length;var result=PhotoRange(value:"sdr");var chunks=0
    while true {
      chunks += 1
      if chunks>100_000 || length>100*1024*1024 { throw PhotoFailure("UNSUPPORTED_IMAGE") }
      let type=photoText(try input.take(4))
      switch type {
      case "acTL":throw PhotoFailure("ANIMATED_IMAGE")
      case "IHDR":
        let data=try input.metadata(length);if data.count != 13 { throw PhotoFailure("UNSUPPORTED_IMAGE") };if data[8]>8 { result=result.merge(.unknown()) }
      case "cICP":
        let data=try input.metadata(length);if data.count != 4 { throw PhotoFailure("UNSUPPORTED_IMAGE") };result=result.merge(transfer(Int(data[1])))
      case "mDCV","cLLI":try input.skip(length);result=result.merge(.unknown())
      case "iCCP":result=result.merge(iccPng(try input.metadata(length)))
      case "iTXt","tEXt","zTXt":let data=try input.metadata(length);if hasHdr(data) { result=result.merge(.hdr()) }
      default:try input.skip(length)
      }
      try input.skip(4)
      if type=="IEND" { return result }
      length=photoU32(try input.take(4),0)
    }
  }
  private static func iccPng(_ data:[UInt8]) -> PhotoRange {
    guard let end=data.firstIndex(of:0),(1...79).contains(end),end+2<data.count,data[end+1]==0 else { return .unknown() }
    let compressed=Array(data[(end+2)...]);var output=[UInt8](repeating:0,count:maximumMetadata+1);var length=uLongf(output.count)
    let status=output.withUnsafeMutableBufferPointer { destination in
      compressed.withUnsafeBufferPointer { source in uncompress(destination.baseAddress!,&length,source.baseAddress!,uLong(source.count)) }
    }
    if status != Z_OK || length>uLongf(maximumMetadata) { return .unknown() }
    return PhotoIcc.inspect(Array(output.prefix(Int(length))))
  }
  private static func jpeg(_ input:PhotoCursor) throws -> PhotoRange {
    var result=PhotoRange(value:"sdr");var profiles=[Int:[UInt8]]();var total=0
    for _ in 0..<100_000 {
      if try input.byte() != 255 { throw PhotoFailure("UNSUPPORTED_IMAGE") }
      var marker=try input.byte();while marker==255 { marker=try input.byte() }
      if marker==0xda || marker==0xd9 {
        if !profiles.isEmpty {
          if total != profiles.count || total==0 || (1...max(1,total)).contains(where:{profiles[$0]==nil}) { result=result.merge(.unknown()) }
          else { result=result.merge(PhotoIcc.inspect((1...total).flatMap{profiles[$0] ?? []})) }
        }
        return result
      }
      if marker==0 || marker==0xd8 || marker==1 || (0xd0...0xd7).contains(marker) { throw PhotoFailure("UNSUPPORTED_IMAGE") }
      let length=try input.short()-2
      if length<0 { throw PhotoFailure("UNSUPPORTED_IMAGE") }
      let data=try input.metadata(length)
      if (0xc0...0xcf).contains(marker) && ![0xc4,0xc8,0xcc].contains(marker) && (data.isEmpty || data[0] != 8) { result=result.merge(.unknown()) }
      if marker==0xe1 && !photoStarts(data,"Exif\0\0") { result=result.merge(hasHdr(data) ? .hdr() : .unknown()) }
      if marker==0xe2 {
        if photoStarts(data,"urn:iso:std:iso:ts:21496:") { result=result.merge(.hdr()) }
        else if photoStarts(data,"MPF\0") { result=result.merge(.unknown()) }
        else if photoStarts(data,"ICC_PROFILE\0") {
          if data.count<14 { throw PhotoFailure("UNSUPPORTED_IMAGE") }
          let order=Int(data[12]);let count=Int(data[13])
          if order==0 || count==0 || order>count || profiles[order] != nil || (total != 0 && count != total) { result=result.merge(.unknown()) }
          total=count;profiles[order]=Array(data.dropFirst(14))
        }
      }
    }
    throw PhotoFailure("UNSUPPORTED_IMAGE")
  }
  private static func webp(_ input:PhotoCursor) throws -> PhotoRange {
    var result=PhotoRange(value:"sdr")
    while input.position<input.size {
      let type=photoText(try input.take(4));let data=try input.take(4)
      let length=Int(data[0])|Int(data[1])<<8|Int(data[2])<<16|Int(data[3])<<24
      switch type {
      case "ANIM","ANMF":throw PhotoFailure("ANIMATED_IMAGE")
      case "VP8X":let header=try input.metadata(length);if header.isEmpty { throw PhotoFailure("UNSUPPORTED_IMAGE") };if header[0]&2 != 0 { throw PhotoFailure("ANIMATED_IMAGE") }
      case "ICCP":result=result.merge(PhotoIcc.inspect(try input.metadata(length)))
      case "XMP ":let data=try input.metadata(length);result=result.merge(hasHdr(data) ? .hdr() : .unknown())
      default:try input.skip(length)
      }
      if length&1 != 0 { try input.skip(1) }
    }
    return result
  }
  private final class BoxState {
    var range=PhotoRange(value:"sdr");var count=0;var propertyCount=0;var containers=0;var primary = -1;var codec=false
    var colors=Set<Int>();var depths=Set<Int>();var images=Set<Int>();var associations=[Int:[Int]]()
  }
  private static func boxes(_ input:PhotoCursor,end:Int,depth:Int,state:BoxState,properties:Bool=false) throws {
    if depth>12 { throw PhotoFailure("UNSUPPORTED_IMAGE") }
    while input.position<end {
      let start=input.position;var size=photoU32(try input.take(4),0);let name=photoText(try input.take(4));var header=8
      if size==1 { let high=photoU32(try input.take(4),0);let low=photoU32(try input.take(4),0);if high != 0 { throw PhotoFailure("UNSUPPORTED_IMAGE") };size=low;header=16 }
      state.count += 1
      if size<header || size>100*1024*1024 || start+size>end || state.count>100_000 { throw PhotoFailure("UNSUPPORTED_IMAGE") }
      let next=start+size;let length=size-header
      if properties { state.propertyCount += 1 };let property=properties ? state.propertyCount : 0
      switch name {
      case "meta":if photoU32(try input.take(4),0) != 0 { state.range=state.range.merge(.unknown()) };try boxes(input,end:next,depth:depth+1,state:state)
      case "iprp":try boxes(input,end:next,depth:depth+1,state:state)
      case "ipco":state.containers += 1;if state.containers>1 { state.range=state.range.merge(.unknown()) };try boxes(input,end:next,depth:depth+1,state:state,properties:true)
      case "iinf":let version=try input.byte();try input.skip(3);try input.skip(version==0 ? 2 : 4);try boxes(input,end:next,depth:depth+1,state:state)
      case "infe":
        let data=try input.metadata(length);let version=data.first.map{Int($0)} ?? -1;let at=version==2 ? 8 : (version==3 ? 10 : -1)
        if at<0 || data.count<at+4 { state.range=state.range.merge(.unknown()) }
        else {
          switch photoText(data,at,4) {
          case "tmap":state.range=state.range.merge(.hdr())
          case "hvc1","av01","grid":state.images.insert(version==2 ? Int(data[4])*256+Int(data[5]) : photoU32(data,4))
          case "Exif":break
          default:state.range=state.range.merge(.unknown())
          }
        }
      case "colr":
        let data=try input.metadata(length);let range:PhotoRange
        if photoStarts(data,"nclx") && data.count>=11 { range=transfer(Int(data[6])*256+Int(data[7])) }
        else if photoStarts(data,"prof") || photoStarts(data,"rICC") { range=PhotoIcc.inspect(Array(data.dropFirst(4))) }
        else { range = .unknown() }
        if property>0 && range.value=="sdr" { state.colors.insert(property) };state.range=state.range.merge(range)
      case "pixi":
        let data=try input.metadata(length);let count=data.count>=5 ? Int(data[4]) : 0
        if count==0 || data.count != 5+count || data.dropFirst(5).contains(where:{$0==0 || $0>8}) { state.range=state.range.merge(.unknown()) } else if property>0 { state.depths.insert(property) }
      case "hvcC","av1C":
        let data=try input.metadata(length)
        let eight=name=="hvcC" ? (data.count>=23 && data[0]==1 && data[17]&7==0 && data[18]&7==0) : (data.count>=4 && data[0]==129 && data[2]&0x60==0)
        if !eight { state.range=state.range.merge(.unknown()) } else { state.codec=true }
      case "pitm":
        let data=try input.metadata(length);let version=data.first.map{Int($0)} ?? -1;let id:Int
        if version==0 && data.count==6 { id=Int(data[4])*256+Int(data[5]) }
        else if version==1 && data.count==8 { id=photoU32(data,4) } else { id = -1 }
        if id<0 || state.primary>=0 { state.range=state.range.merge(.unknown()) } else { state.primary=id }
      case "ipma":try associations(input.metadata(length),state:state)
      case "auxC":
        let data=try input.metadata(length);let text=photoText(data)
        if hasHdr(data) { state.range=state.range.merge(.hdr()) }
        else if !text.contains("auxiliary:alpha") && !text.contains("auxiliary:depth") && !text.contains("aux:disparity") { state.range=state.range.merge(.unknown()) }
      case "mdcv","clli","amve","cclv","grpl":try input.skip(length);state.range=state.range.merge(.unknown())
      case "ftyp":let data=try input.metadata(length);let text=photoText(data);if text.contains("avis") || text.contains("msf1") { throw PhotoFailure("ANIMATED_IMAGE") }
      case "moov":throw PhotoFailure("ANIMATED_IMAGE")
      case "ispe","irot","imir","clap","pasp","iloc","iref","hdlr","dinf","mdat","idat","free","skip":try input.skip(length)
      default:try input.skip(length);state.range=state.range.merge(.unknown())
      }
      if input.position != next { throw PhotoFailure("UNSUPPORTED_IMAGE") }
    }
  }
  private static func associations(_ data:[UInt8],state:BoxState) throws {
    if data.count<8 || data[0]>1 || photoU32(data,0)&0x00fffffe != 0 { throw PhotoFailure("UNSUPPORTED_IMAGE") }
    let wide=data[3]&1 != 0;let version=data[0];let count=photoU32(data,4)
    if count>100_000 { throw PhotoFailure("UNSUPPORTED_IMAGE") }
    var at=8
    for _ in 0..<count {
      let bytes=version==0 ? 2 : 4
      if at+bytes+1>data.count { throw PhotoFailure("UNSUPPORTED_IMAGE") }
      let id=version==0 ? Int(data[at])*256+Int(data[at+1]) : photoU32(data,at);at += bytes
      let number=Int(data[at]);at += 1;var indices=[Int]()
      for _ in 0..<number {
        if at+(wide ? 2 : 1)>data.count { throw PhotoFailure("UNSUPPORTED_IMAGE") }
        let index:Int
        if wide { index=(Int(data[at])*256+Int(data[at+1]))&0x7fff;at += 2 } else { index=Int(data[at])&0x7f;at += 1 }
        if index>0 { indices.append(index) }
      }
      if state.associations[id] != nil { state.range=state.range.merge(.unknown()) };state.associations[id]=indices
    }
    if at != data.count { throw PhotoFailure("UNSUPPORTED_IMAGE") }
  }
  static func transfer(_ value:Int) -> PhotoRange {
    if [16,18].contains(value) { return .hdr() }
    return [1,4,5,6,7,13,14,15].contains(value) ? PhotoRange(value:"sdr") : .unknown()
  }
  private static func hasHdr(_ data:[UInt8]) -> Bool {
    let value=photoText(data).lowercased();return ["hdr-gain-map","hdrgainmap","hdrgm:","gainmap","21496:","hdrheadroom"].contains{value.contains($0)}
  }
}

private final class PhotoCursor {
  private let handle:FileHandle
  let size:Int
  private(set) var position=0
  private var metadataBytes=0
  init(_ url:URL) throws {
    let opened=try FileHandle(forReadingFrom:url)
    do {let length=try opened.seekToEnd();if length>100*1024*1024 { throw PhotoFailure("IMAGE_TOO_LARGE") };size=Int(length);try opened.seek(toOffset:0);handle=opened}
    catch {try? opened.close();throw error}
  }
  func close() throws {try handle.close()}
  func seek(_ to:Int) throws {if to<0 || to>size { throw PhotoFailure("UNSUPPORTED_IMAGE") };try handle.seek(toOffset:UInt64(to));position=to}
  func byte() throws -> Int {Int(try take(1)[0])}
  func short() throws -> Int {let bytes=try take(2);return Int(bytes[0])*256+Int(bytes[1])}
  func take(_ count:Int) throws -> [UInt8] {
    if count<0 || count>4*1024*1024 || position+count>size { throw PhotoFailure("UNSUPPORTED_IMAGE") }
    var result=Data();result.reserveCapacity(count)
    while result.count<count {let data=try handle.read(upToCount:count-result.count) ?? Data();if data.isEmpty { throw PhotoFailure("UNSUPPORTED_IMAGE") };result.append(data)}
    position += count;return Array(result)
  }
  func metadata(_ count:Int) throws -> [UInt8] {metadataBytes += count;if count<0 || metadataBytes>4*1024*1024 { throw PhotoFailure("UNSUPPORTED_IMAGE") };return try take(count)}
  func skip(_ count:Int) throws {if count<0 { throw PhotoFailure("UNSUPPORTED_IMAGE") };try seek(position+count)}
}

private enum PhotoIcc {
  private static let ignored:Set<String>=["desc","cprt","dmnd","dmdd","tech","view","meas","targ","chad","chrm","bkpt"]
  static func inspect(_ data:[UInt8]) -> PhotoRange {
    if data.count<132 || photoU32(data,0) != data.count || photoText(data,36,4) != "acsp" || photoText(data,16,4) != "RGB " || photoText(data,20,4) != "XYZ " || !(2...4).contains(data[8]) { return .unknown() }
    let count=photoU32(data,128);if count>256 || 132+count*12>data.count { return .unknown() }
    var tags=[String:[UInt8]]()
    for i in 0..<count {
      let at=132+i*12;let name=photoText(data,at,4);let start=photoU32(data,at+4);let size=photoU32(data,at+8)
      if start<132+count*12 || size<8 || start+size>data.count || tags[name] != nil { return .unknown() }
      tags[name]=Array(data[start..<(start+size)])
    }
    if let tag=tags["cicp"] {if tag.count<12 { return .unknown() };let range=PhotoSource.transfer(Int(tag[9]));if range.value != "sdr" { return range }}
    let transforms:Set<String>=["rXYZ","gXYZ","bXYZ","wtpt","rTRC","gTRC","bTRC","cicp","lumi"]
    if tags.keys.contains(where:{!ignored.contains($0) && !transforms.contains($0)}) { return .unknown() }
    if let tag=tags["lumi"],tag.count<20 || photoText(tag,0,4) != "XYZ " || fixed(tag,12)>203 { return .unknown() }
    var y=0.0
    for name in ["rXYZ","gXYZ","bXYZ"] {guard let tag=tags[name],tag.count==20,photoText(tag,0,4)=="XYZ " else { return .unknown() };y += fixed(tag,12)}
    if abs(y-1)>0.03 { return .unknown() }
    for name in ["rTRC","gTRC","bTRC"] {guard let curve=tags[name],standardCurve(curve) else { return .unknown() }}
    return PhotoRange(value:"sdr")
  }
  private static func standardCurve(_ data:[UInt8]) -> Bool {
    if data.count<12 { return false }
    if photoText(data,0,4)=="para" {
      let type=Int(data[8])*256+Int(data[9])
      if type==0 && data.count>=16 { return [1.0,1.8,2.2,2.4].contains{abs(fixed(data,12)-$0)<0.001} }
      if ![3,4].contains(type) || data.count<(type==3 ? 32 : 40) { return false }
      let expected=[2.4,1/1.055,0.055/1.055,1/12.92,0.04045]
      if expected.indices.contains(where:{abs(fixed(data,12+$0*4)-expected[$0])>0.0001}) { return false }
      return type==3 || (abs(fixed(data,32))<0.0001 && abs(fixed(data,36))<0.0001)
    }
    if photoText(data,0,4) != "curv" { return false }
    let count=photoU32(data,8);if count>65536 || 12+count*2>data.count { return false }
    if count==0 { return true }
    if count==1 {let gamma=Double(Int(data[12])*256+Int(data[13]))/256;return [1.0,1.8,2.2,2.4].contains{abs(gamma-$0)<0.01}}
    var candidates:Set<Int>=[0,1,2,3,4]
    for i in 0..<count {
      let x=Double(i)/Double(count-1);let value=Double(Int(data[12+2*i])*256+Int(data[13+2*i]))/65535
      candidates=Set(candidates.filter {kind in
        let expected:Double
        switch kind {case 0:expected=x<=0.04045 ? x/12.92 : pow((x+0.055)/1.055,2.4);case 1:expected=x;case 2:expected=pow(x,1.8);case 3:expected=pow(x,2.2);default:expected=pow(x,2.4)}
        return abs(value-expected)<=3.0/65535
      })
      if candidates.isEmpty { return false }
    }
    return true
  }
  private static func fixed(_ data:[UInt8],_ at:Int) -> Double {Double(Int32(bitPattern:UInt32(photoU32(data,at))))/65536}
}

private func photoU32(_ data:[UInt8],_ at:Int) -> Int {Int(data[at])<<24|Int(data[at+1])<<16|Int(data[at+2])<<8|Int(data[at+3])}
private func photoText(_ data:[UInt8],_ at:Int=0,_ count:Int?=nil) -> String {String(bytes:data[at..<(at+(count ?? (data.count-at)))],encoding:.isoLatin1) ?? ""}
private func photoStarts(_ data:[UInt8],_ text:String) -> Bool {data.starts(with:Array(text.utf8))}
