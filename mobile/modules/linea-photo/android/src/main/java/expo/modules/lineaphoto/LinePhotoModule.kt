package expo.modules.lineaphoto

import android.graphics.Bitmap
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class LinePhotoModule:Module() {
  private val writer=ReentrantLock()
  private fun context()=appContext.reactContext ?: throw PhotoFailure("CONTEXT_UNAVAILABLE")
  override fun definition()=ModuleDefinition {
    Name("LineaPhoto")
    AsyncFunction("capabilities"){protect{PhotoBackground(context()).capabilities()}}
    AsyncFunction("prepareBackground"){protect{PhotoBackground(context()).prepare()}}
    AsyncFunction("inspect"){uri:String->protect{PhotoFiles(context()).inspect(uri)}}
    AsyncFunction("render"){uri:String,options:Map<String,Any?>->protect{writer.withLock{render(uri,PhotoOptions.parse(options))}}}
    AsyncFunction("dispose"){uri:String->protect{writer.withLock{PhotoFiles(context()).dispose(uri)}}}
    AsyncFunction("clearCache"){protect{writer.withLock{PhotoFiles(context()).clearCache()}}}
  }
  private fun pixels(bitmap:Bitmap):PixelImage {
    val data=IntArray(bitmap.width*bitmap.height);bitmap.getPixels(data,0,bitmap.width,0,0,bitmap.width,bitmap.height)
    return PixelImage(bitmap.width,bitmap.height,data)
  }
  private fun bitmap(image:PixelImage)=Bitmap.createBitmap(image.pixels,image.width,image.height,Bitmap.Config.ARGB_8888)

  private fun render(uri:String,options:PhotoOptions):Map<String,Any> {
    val files=PhotoFiles(context());val header=files.header(uri)
    if(header.range.value!="sdr")throw PhotoFailure("HDR_UNSUPPORTED")
    val plan=PhotoDimensions.plan(header.width,header.height,options)
    var current=files.decode(uri,header,plan)
    try {
      if(options.strokes.isNotEmpty()) {
        val input=pixels(current);current.recycle()
        current=bitmap(PhotoPixels.inpaint(input,options.strokes))
      }
      if(options.background!="keep") {
        val foreground=PhotoBackground(context()).foreground(current);current.recycle();current=foreground
      }
      if(options.background=="white"||options.document!="none"||options.scale>1) {
        var image=pixels(current);current.recycle()
        if(options.background=="white")image=PhotoPixels.whiteBackground(image)
        if(options.document!="none")image=PhotoPixels.document(image,options.document=="bw")
        if(options.scale>1)image=PhotoPixels.upscale(image,options.scale)
        current=bitmap(image)
      }
      val output=files.save(current,options.allowDownsample,options.format).toMutableMap()
      output["downsampled"]=plan.downsampled || output["downsampled"]==true
      return output
    }finally{current.recycle()}
  }
  private inline fun <T> protect(operation:()->T):T {
    try{return operation()}
    catch(error:OutOfMemoryError){throw CodedException("ERR_LINEA_PHOTO_OUT_OF_MEMORY","Для обработки фото не хватает памяти. Выберите меньшее изображение.",null)}
    catch(error:Exception){
      val reason=(error as? PhotoFailure)?.reason ?: "PROCESSING_FAILED"
      val message=when(reason) {
        "DOWNSAMPLE_REQUIRED"->"Для этого режима нужно уменьшить фото. Подтвердите уменьшение в редакторе."
        "ANIMATED_IMAGE"->"Редактор принимает статические фото. GIF, APNG и анимированный WebP не преобразуются в один кадр."
        "MODEL_NOT_READY"->"Модель удаления фона ещё не готова. Загрузите её и повторите."
        "BACKGROUND_BUSY"->"Предыдущая обработка фона ещё завершается. Подождите и повторите."
        "GOOGLE_PLAY_UNAVAILABLE"->"Для удаления фона нужны доступные сервисы Google Play."
        "NO_FOREGROUND"->"Не удалось выделить объект. Попробуйте другое фото."
        "MASK_TOO_LARGE"->"Отметьте меньшую область: удаление доступно максимум для 20% изображения."
        "MASK_TOO_COMPLEX"->"Слишком сложная маска. Сотрите часть штрихов и повторите."
        "IMAGE_TOO_LARGE"->"Фото превышает ограничение размера редактора."
        "OUTPUT_TOO_LARGE"->"Фото превышает 20 МБ. Разрешите уменьшение фото в редакторе и повторите."
        "INCOMPATIBLE_OPTIONS"->"Прозрачный фон требует PNG. Режим документа и замена фона применяются отдельно."
        "HDR_UNSUPPORTED"->"Редактор не может сохранить HDR или точность этого файла при обработке. Преобразование в SDR не выполнено."
        "CROP_SOURCE_TOO_LARGE"->"Для точной обрезки нужен исходник до 16 Мп. Сначала сохраните уменьшенную копию без обрезки."
        else->"Не удалось обработать фото. Исходное изображение не отправлено."
      }
      throw CodedException("ERR_LINEA_PHOTO_$reason",message,null)
    }
  }
}
