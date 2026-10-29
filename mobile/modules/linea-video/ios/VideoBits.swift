import Foundation

enum VideoBits {
  static func depth(_ nal:[UInt8],hevc:Bool) throws -> Int {
    let header=hevc ? 2:1
    guard nal.count>header else {throw VideoFailure("MALFORMED_VIDEO")}
    var bits=Bits(data:try VideoNal.unescape(Array(nal.dropFirst(header))))
    if hevc {return try hevcDepth(&bits)}
    return try avcDepth(&bits)
  }
  private static func hevcDepth(_ bits:inout Bits) throws -> Int {
    try bits.skip(4);let layers=try bits.read(3);try bits.skip(1)
    if layers>6 {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")};try bits.skip(96)
    var profile=[Bool](),level=[Bool]()
    for _ in 0..<layers {profile.append(try bits.read(1)==1);level.append(try bits.read(1)==1)}
    if layers>0 {try bits.skip((8-layers)*2)}
    for index in 0..<layers {if profile[index] {try bits.skip(88)};if level[index] {try bits.skip(8)}}
    _=try bits.ue();let chroma=try bits.ue();if !(0...3).contains(chroma) {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
    if chroma==3 {try bits.skip(1)}
    let width=try bits.ue(),height=try bits.ue()
    if width<=0||height<=0||width>16384||height>16384 {throw VideoFailure("VIDEO_DIMENSIONS")}
    if try bits.read(1)==1 {for _ in 0..<4 {_=try bits.ue()}}
    return try checkedDepth(&bits)
  }
  private static func avcDepth(_ bits:inout Bits) throws -> Int {
    let profile=try bits.read(8);try bits.skip(16);_=try bits.ue()
    if [66,77,88].contains(profile) {return 8}
    guard [100,110,122,244,44,83,86,118,128,138,139,134,135,144].contains(profile) else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
    let chroma=try bits.ue();guard (0...3).contains(chroma) else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
    if chroma==3 {try bits.skip(1)}
    return try checkedDepth(&bits)
  }
  private static func checkedDepth(_ bits:inout Bits) throws -> Int {
    let luma=try bits.ue()+8,chroma=try bits.ue()+8
    guard (8...16).contains(luma),luma==chroma else {throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")}
    return luma
  }
  private struct Bits {
    let data:[UInt8];var offset=0
    mutating func skip(_ count:Int) throws {guard count>=0,count<=data.count*8-offset else {throw VideoFailure("MALFORMED_VIDEO")};offset+=count}
    mutating func read(_ count:Int) throws -> Int {
      guard (0...30).contains(count),count<=data.count*8-offset else {throw VideoFailure("MALFORMED_VIDEO")}
      var result=0
      for _ in 0..<count {result=(result<<1)|Int((data[offset/8]>>(7-offset%8))&1);offset+=1}
      return result
    }
    mutating func ue() throws -> Int {
      var zeros=0;while try read(1)==0 {zeros+=1;if zeros>29 {throw VideoFailure("MALFORMED_VIDEO")}}
      return (1<<zeros)-1+(try read(zeros))
    }
  }
}
