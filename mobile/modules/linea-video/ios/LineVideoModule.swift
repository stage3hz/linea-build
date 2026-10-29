import Foundation
import ExpoModulesCore

// LocalizedError makes the Russian message (and the reason code) reach JavaScript
// instead of «The operation couldn't be completed (LineaVideoError error 1)».
private struct LineaVideoError:CodedError,LocalizedError {let code:String;let description:String
  var errorDescription:String? {"\(description) [\(code)]"}}

public final class LineVideoModule:Module {
  private let writer=DispatchQueue(label:"app.linea.video.writer",qos:.userInitiated)
  public func definition() -> ModuleDefinition {
    Name("LineaVideo")
    AsyncFunction("capabilities") { ["videoCodecs":["avc","hevc"],"outputMimeType":"video/mp4","hdr":["sdr","pq","hlg"],"dynamicHdr":false,"audio":"system-decode-to-aac","maxInputBytes":VideoPolicy.maxInput,"maxOutputBytes":VideoPolicy.maxOutput] as [String:Any] }
    AsyncFunction("inspect") { (uri:String) in try self.protect{try VideoProcessor().inspect(uri)} }.runOnQueue(writer)
    AsyncFunction("resolveLibraryAsset") { (assetId:String) in try self.protect{try VideoLibrary.resolve(assetId)} }.runOnQueue(writer)
    AsyncFunction("sanitize") { (uri:String) in try self.protect{try autoreleasepool{try VideoProcessor().sanitize(uri)}} }.runOnQueue(writer)
    AsyncFunction("dispose") { (uri:String) in try self.protect{try VideoFiles().dispose(uri)} }.runOnQueue(writer)
    AsyncFunction("clearCache") { try self.protect{try VideoFiles().clearCache()} }.runOnQueue(writer)
  }
  private func protect<T>(_ operation:() throws -> T) throws -> T {
    do{return try operation()}
    catch {
      let reason=(error as? VideoFailure)?.reason ?? "PROCESSING_FAILED"
      let message:String
      switch reason {
      case "INPUT_TOO_LARGE":message="Видео превышает 100 МиБ. Выберите файл меньшего размера."
      case "OUTPUT_TOO_LARGE":message="Очищенное видео превышает 20 МиБ. Сократите видео перед отправкой."
      case "UNKNOWN_HDR","DYNAMIC_HDR_UNSUPPORTED","DYNAMIC_HDR_OR_REGISTERED_DATA_UNSUPPORTED","HDR_CONTAINER_UNSUPPORTED":message="Этот вариант HDR или дополнительных видеоданных пока нельзя сохранить безопасно. Видео не преобразовано в SDR и не отправлено."
      case "DRM_UNSUPPORTED":message="Защищённое видео не поддерживается."
      case "CODEC_TIMEOUT":message="Обработка видео не завершилась вовремя. Исходник не отправлен."
      default:message="Этот файл или его кодек не удалось безопасно обработать. Исходное видео не отправлено."
      }
      let code=["NO_VIDEO_TRACK","UNSUPPORTED_CODEC"].contains(reason) ? reason:"ERR_LINEA_VIDEO_\(reason)"
      throw LineaVideoError(code:code,description:message)
    }
  }
}
