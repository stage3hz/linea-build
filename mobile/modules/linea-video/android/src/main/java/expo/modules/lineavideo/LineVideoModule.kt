package expo.modules.lineavideo

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class LineVideoModule:Module() {
  private val writer=ReentrantLock()
  private fun files()=VideoFiles(appContext.reactContext ?: throw VideoFailure("CONTEXT_UNAVAILABLE"))
  override fun definition()=ModuleDefinition {
    Name("LineaVideo")
    AsyncFunction("capabilities") { mapOf("videoCodecs" to listOf("avc","hevc"),"outputMimeType" to "video/mp4","hdr" to listOf("sdr","pq","hlg"),"dynamicHdr" to false,"audio" to "system-decode-to-aac","maxInputBytes" to VideoPolicy.MAX_INPUT,"maxOutputBytes" to VideoPolicy.MAX_OUTPUT) }
    AsyncFunction("inspect") { uri:String->protect{writer.withLock{VideoProcessor(files()).inspect(uri)}} }
    AsyncFunction("resolveLibraryAsset") { _:String->protect<Map<String,Any>>{throw VideoFailure("IOS_LIBRARY_ONLY")} }
    AsyncFunction("sanitize") { uri:String->protect{writer.withLock{VideoProcessor(files()).sanitize(uri)}} }
    AsyncFunction("dispose") { uri:String->protect{writer.withLock{files().dispose(uri)}} }
    AsyncFunction("clearCache") { protect{writer.withLock{files().clearCache()}} }
  }
  private inline fun <T> protect(operation:()->T):T {
    try{return operation()}
    catch(error:OutOfMemoryError){throw CodedException("ERR_LINEA_VIDEO_OUT_OF_MEMORY","Недостаточно памяти для обработки видео. Исходник не отправлен.",null)}
    catch(error:Exception) {
      val reason=(error as? VideoFailure)?.reason ?: "PROCESSING_FAILED"
      val message=when(reason) {
        "INPUT_TOO_LARGE"->"Видео превышает 100 МиБ. Выберите файл меньшего размера."
        "OUTPUT_TOO_LARGE"->"Очищенное видео превышает 20 МиБ. Сократите видео перед отправкой."
        "UNKNOWN_HDR","DYNAMIC_HDR_UNSUPPORTED","DYNAMIC_HDR_OR_REGISTERED_DATA_UNSUPPORTED","HDR_CONTAINER_UNSUPPORTED"->"Этот вариант HDR или дополнительных видеоданных пока нельзя сохранить безопасно. Видео не преобразовано в SDR и не отправлено."
        "DRM_UNSUPPORTED"->"Защищённое видео не поддерживается."
        "CODEC_TIMEOUT"->"Обработка видео не завершилась вовремя. Исходник не отправлен."
        else->"Этот файл или его кодек не удалось безопасно обработать. Исходное видео не отправлено."
      }
      val code=if(reason in setOf("NO_VIDEO_TRACK","UNSUPPORTED_CODEC"))reason else "ERR_LINEA_VIDEO_$reason"
      throw CodedException(code,message,null)
    }
  }
}
