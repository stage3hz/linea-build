import Foundation

struct VideoFailure: Error { let reason:String;init(_ reason:String){self.reason=reason} }
enum VideoPolicy {
  static let maxInput=100*1024*1024
  static let maxOutput=20*1024*1024
  static let maxSample=16*1024*1024
  static let maxDuration=12.0*60*60
}

final class VideoFiles {
  private let pattern="^linea-native-(video|input|video-source)-[0-9a-fA-F-]{36}\\.(mp4|bin)$"
  private func directory() throws -> URL {
    let cache=try FileManager.default.url(for:.cachesDirectory,in:.userDomainMask,appropriateFor:nil,create:true)
    var url=cache.appendingPathComponent("linea-video",isDirectory:true)
    try FileManager.default.createDirectory(at:url,withIntermediateDirectories:true,attributes:[.protectionKey:FileProtectionType.complete])
    var values=URLResourceValues();values.isExcludedFromBackup=true;try url.setResourceValues(values)
    return url.resolvingSymlinksInPath().standardizedFileURL
  }
  func newFile(_ kind:String,_ extensionName:String) throws -> URL {
    try directory().appendingPathComponent("linea-native-\(kind)-\(UUID().uuidString).\(extensionName)")
  }
  func snapshot(_ uri:String) throws -> URL {
    guard let source=URL(string:uri),source.isFileURL,(source.host==nil||source.host==""),source.query==nil,source.fragment==nil else {throw VideoFailure("LOCAL_FILE_REQUIRED")}
    let attributes=try FileManager.default.attributesOfItem(atPath:source.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
      let count=attributes[.size] as? NSNumber,count.int64Value>0,count.int64Value<=Int64(VideoPolicy.maxInput) else {throw VideoFailure("INPUT_TOO_LARGE")}
    let target=try newFile("input","bin")
    do {
      guard let input=InputStream(url:source),let output=OutputStream(url:target,append:false) else {throw VideoFailure("READ_FAILED")}
      input.open();output.open();defer{input.close();output.close()}
      var buffer=[UInt8](repeating:0,count:65536);var total=0
      while true {
        let count=input.read(&buffer,maxLength:65536)
        if count<0 {throw VideoFailure("READ_FAILED")};if count==0 {break}
        total+=count;if total>VideoPolicy.maxInput {throw VideoFailure("INPUT_TOO_LARGE")}
        var offset=0
        while offset<count {
          let written=buffer.withUnsafeBufferPointer { output.write($0.baseAddress!.advanced(by:offset),maxLength:count-offset) }
          if written<=0 {throw VideoFailure("WRITE_FAILED")};offset+=written
        }
      }
      if total==0 {throw VideoFailure("READ_FAILED")}
      try FileManager.default.setAttributes([.protectionKey:FileProtectionType.complete],ofItemAtPath:target.path)
      return target
    }catch{try? remove(target);throw error}
  }
  func bytes(_ url:URL) throws -> Int {
    let attributes=try FileManager.default.attributesOfItem(atPath:url.path)
    guard let size=attributes[.size] as? NSNumber else {throw VideoFailure("READ_FAILED")}
    return size.intValue
  }
  func finish(_ url:URL) throws -> Int {
    let size=try bytes(url)
    if size<=0 {throw VideoFailure("WRITE_FAILED")}
    if size>VideoPolicy.maxOutput {throw VideoFailure("OUTPUT_TOO_LARGE")}
    try FileManager.default.setAttributes([.protectionKey:FileProtectionType.complete],ofItemAtPath:url.path)
    return size
  }
  func remove(_ url:URL) throws {
    let canonical=url.resolvingSymlinksInPath().standardizedFileURL
    guard canonical.deletingLastPathComponent()==(try directory()),canonical.lastPathComponent.range(of:pattern,options:.regularExpression) != nil else {throw VideoFailure("INVALID_OUTPUT")}
    if FileManager.default.fileExists(atPath:canonical.path){try FileManager.default.removeItem(at:canonical)}
  }
  func dispose(_ uri:String) throws {
    guard let url=URL(string:uri),url.isFileURL,(url.host==nil||url.host==""),url.query==nil,url.fragment==nil,
      ((url.lastPathComponent.hasPrefix("linea-native-video-source-") && url.pathExtension=="bin") || (url.lastPathComponent.hasPrefix("linea-native-video-") && url.pathExtension=="mp4")) else {throw VideoFailure("INVALID_OUTPUT")}
    try remove(url)
  }
  func clearCache() throws {
    for url in try FileManager.default.contentsOfDirectory(at:directory(),includingPropertiesForKeys:nil) {
      if url.lastPathComponent.range(of:pattern,options:.regularExpression) != nil {try remove(url)}
    }
  }
}
