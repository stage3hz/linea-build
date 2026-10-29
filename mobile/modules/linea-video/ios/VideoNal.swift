import Foundation

enum VideoNal {
  private static func invalid() -> VideoFailure {VideoFailure("MALFORMED_VIDEO")}
  static func type(_ nal:[UInt8],hevc:Bool) throws -> Int {
    guard !nal.isEmpty,nal[0]&128==0 else {throw invalid()}
    if !hevc {return Int(nal[0]&31)}
    guard nal.count>=2,nal[1]&7 != 0 else {throw invalid()}
    guard nal[0]&1==0,nal[1]&248==0 else {throw VideoFailure("MULTILAYER_UNSUPPORTED")}
    return Int((nal[0]>>1)&63)
  }
  static func clean(_ data:Data,hevc:Bool,hdr:String,lengthBytes:Int) throws -> Data {
    guard !data.isEmpty,data.count<=VideoPolicy.maxSample,[1,2,4].contains(lengthBytes) else {throw invalid()}
    let bytes=[UInt8](data);var output=Data();var offset=0;var count=0
    while offset<bytes.count {
      count+=1;guard count<=4096,offset+lengthBytes<=bytes.count else {throw invalid()}
      var length=0
      for _ in 0..<lengthBytes {length=(length<<8)|Int(bytes[offset]);offset+=1}
      guard length>0,length<=bytes.count-offset else {throw invalid()}
      let nal=Array(bytes[offset..<offset+length]);offset+=length
      if let clean=try cleanNal(nal,hevc:hevc,hdr:hdr) {
        for i in (0..<lengthBytes).reversed(){output.append(UInt8((clean.count>>(i*8))&255))}
        output.append(contentsOf:clean)
      }
    }
    return output
  }
  private static func cleanNal(_ nal:[UInt8],hevc:Bool,hdr:String) throws -> [UInt8]? {
    let kind=try type(nal,hevc:hevc)
    if hevc {
      if kind==62||kind==63 {throw VideoFailure("DYNAMIC_HDR_UNSUPPORTED")}
      if kind==38 {return nil}
      if kind==39||kind==40 {return try cleanSei(nal,header:2,hdr:hdr)}
      guard (0...9).contains(kind)||(16...21).contains(kind)||(32...37).contains(kind) else {throw VideoFailure("UNSUPPORTED_VIDEO_NAL")}
    }else {
      if kind==12 {return nil}
      if kind==6 {return try cleanSei(nal,header:1,hdr:hdr)}
      guard (1...5).contains(kind)||(7...11).contains(kind)||kind==13 else {throw VideoFailure("UNSUPPORTED_VIDEO_NAL")}
    }
    return nal
  }
  private static func cleanSei(_ nal:[UInt8],header:Int,hdr:String) throws -> [UInt8]? {
    let rbsp=try unescape(Array(nal.dropFirst(header)));var output=[UInt8]();var offset=0;var count=0;var ended=false
    while offset<rbsp.count {
      if rbsp[offset]==128 && offset==rbsp.count-1 {ended=true;break}
      count+=1;if count>256 {throw invalid()}
      let type=try extended(rbsp,&offset);let length=try extended(rbsp,&offset)
      guard length<=rbsp.count-offset-1 else {throw invalid()}
      let payload=Array(rbsp[offset..<offset+length]);offset+=length
      if try keepSei(type,payload:payload,hdr:hdr) {output+=encodeExtended(type)+encodeExtended(payload.count)+payload}
    }
    if !ended {throw invalid()};if output.isEmpty {return nil}
    output.append(128);return Array(nal.prefix(header))+escape(output)
  }
  private static func keepSei(_ type:Int,payload:[UInt8],hdr:String) throws -> Bool {
    if type==4 {throw VideoFailure("DYNAMIC_HDR_OR_REGISTERED_DATA_UNSUPPORTED")}
    if type==5 {guard payload.count>=16 else {throw invalid()};return false}
    if type==3 {return false}
    if [0,1,6].contains(type) {guard !payload.isEmpty,payload.count<=256 else {throw invalid()};return true}
    if ![137,144,147].contains(type) {throw VideoFailure("UNSUPPORTED_VIDEO_METADATA")}
    guard ["pq","hlg"].contains(hdr) else {throw VideoFailure("UNKNOWN_HDR")}
    try validateHdr(type,data:payload,hdr:hdr);return true
  }
  static func validateHdr(_ type:Int,data:[UInt8],hdr:String) throws {
    switch type {
    case 137:
      guard data.count==24 else {throw invalid()}
      for i in 0..<8 {if u16(data,i*2)>50000 {throw invalid()}}
      let maximum=u32(data,16),minimum=u32(data,20)
      guard maximum>0,maximum<=100000000,minimum<maximum else {throw invalid()}
    case 144:
      guard data.count==4 else {throw invalid()}
      if u16(data,0) != 0 && u16(data,2)>u16(data,0) {throw invalid()}
    case 147:
      guard data.count==1,Int(data[0])==(hdr=="pq" ? 16:18) else {throw invalid()}
    default:throw invalid()
    }
  }
  private static func u16(_ bytes:[UInt8],_ index:Int) -> Int {(Int(bytes[index])<<8)|Int(bytes[index+1])}
  private static func u32(_ bytes:[UInt8],_ index:Int) -> UInt64 {(UInt64(u16(bytes,index))<<16)|UInt64(u16(bytes,index+2))}
  private static func extended(_ bytes:[UInt8],_ offset:inout Int) throws -> Int {
    var value=0
    while true {
      guard offset<bytes.count else {throw invalid()};let part=Int(bytes[offset]);offset+=1;value+=part
      if value>VideoPolicy.maxSample {throw invalid()};if part != 255 {return value}
    }
  }
  private static func encodeExtended(_ input:Int) -> [UInt8] {
    var value=input;var bytes=[UInt8]();while value>=255 {bytes.append(255);value-=255};bytes.append(UInt8(value));return bytes
  }
  static func unescape(_ bytes:[UInt8]) throws -> [UInt8] {
    var output=[UInt8]();var zeros=0;var index=0
    while index<bytes.count {
      let value=bytes[index];index+=1
      if zeros==2 && value==3 {guard index<bytes.count,bytes[index]<=3 else {throw invalid()};zeros=0;continue}
      output.append(value);zeros=value==0 ? zeros+1:0
    }
    return output
  }
  private static func escape(_ bytes:[UInt8]) -> [UInt8] {
    var output=[UInt8]();var zeros=0
    for value in bytes {
      if zeros==2 && value<=3 {output.append(3);zeros=0}
      output.append(value);zeros=value==0 ? zeros+1:0
    }
    return output
  }
}
