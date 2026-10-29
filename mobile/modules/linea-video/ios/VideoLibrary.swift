import Foundation
import Photos

/// Copies the original resource, never AVAssetExportSession's rendered edit.
/// The UI must call this only after Add: network access may download from iCloud.
enum VideoLibrary {
  static func resolve(_ assetId:String) throws -> [String:Any] {
    guard !assetId.isEmpty,assetId.count<=1024 else {throw VideoFailure("INVALID_LIBRARY_ASSET")}
    let assets=PHAsset.fetchAssets(withLocalIdentifiers:[assetId],options:nil)
    guard let asset=assets.firstObject,asset.mediaType == .video else {throw VideoFailure("LIBRARY_ASSET_UNAVAILABLE")}
    let resources=PHAssetResource.assetResources(for:asset).filter{$0.type == .video}
    guard resources.count==1 else {throw VideoFailure("UNSUPPORTED_LIBRARY_RESOURCE")}
    let files=VideoFiles(),url=try VideoFiles().newFile("video-source","bin")
    do {
      guard FileManager.default.createFile(atPath:url.path,contents:nil,attributes:[.protectionKey:FileProtectionType.complete]) else {throw VideoFailure("WRITE_FAILED")}
      let transfer=try ResourceCopy(url)
      let options=PHAssetResourceRequestOptions();options.isNetworkAccessAllowed=true
      let manager=PHAssetResourceManager.default()
      let request=manager.requestData(for:resources[0],options:options,dataReceivedHandler:{transfer.receive($0)},completionHandler:{transfer.complete($0)})
      transfer.attach(request)
      try transfer.wait()
      let size=try files.bytes(url)
      guard size>0,size<=VideoPolicy.maxInput else {throw VideoFailure("INPUT_TOO_LARGE")}
      return ["uri":url.absoluteString,"owned":true]
    }catch{try? files.remove(url);throw error}
  }
  private final class ResourceCopy {
    private let handle:FileHandle
    private let lock=NSLock()
    private let done=DispatchSemaphore(value:0)
    private var request:PHAssetResourceDataRequestID?
    private var failure:Error?
    private var closed=false
    private var cancelled=false
    private var count=0
    init(_ url:URL) throws {handle=try FileHandle(forWritingTo:url)}
    func attach(_ request:PHAssetResourceDataRequestID) {
      lock.lock();self.request=request;let cancel=cancelled;lock.unlock()
      if cancel {PHAssetResourceManager.default().cancelDataRequest(request)}
    }
    func receive(_ data:Data) {
      lock.lock()
      if closed {lock.unlock();return}
      do {
        guard data.count<=VideoPolicy.maxInput-count else {throw VideoFailure("INPUT_TOO_LARGE")}
        try handle.write(contentsOf:data);count+=data.count
      }catch{failure=error;cancelled=true;closed=true;try? handle.close()}
      let shouldSignal=cancelled;let cancel=cancelled ? request:nil;lock.unlock()
      if let cancel=cancel {PHAssetResourceManager.default().cancelDataRequest(cancel)}
      if shouldSignal {done.signal()}
    }
    func complete(_ error:Error?) {
      lock.lock()
      if failure==nil {failure=error}
      if !closed {do{try handle.close()}catch{if failure==nil {failure=error}};closed=true}
      lock.unlock();done.signal()
    }
    func wait() throws {
      if done.wait(timeout:.now()+600) != .success {
        lock.lock();cancelled=true;closed=true;let request=request;try? handle.close();lock.unlock()
        if let request=request {PHAssetResourceManager.default().cancelDataRequest(request)}
        throw VideoFailure("LIBRARY_TIMEOUT")
      }
      lock.lock();let error=failure;let bytes=count;lock.unlock()
      if let error=error {throw error};if bytes==0 {throw VideoFailure("READ_FAILED")}
    }
  }
}
