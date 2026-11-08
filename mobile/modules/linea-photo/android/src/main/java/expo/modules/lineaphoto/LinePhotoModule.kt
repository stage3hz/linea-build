package expo.modules.lineaphoto

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.os.Build
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
    // Android 10+: with 3-button navigation the system lays a translucent white scrim under the buttons
    // «for contrast», so the app's own background never reaches the bottom edge (a white strip below the
    // input field, reported). The app draws edge to edge and keeps its controls clear of the bar itself.
    // Expo may call this right when the module is created — on the JS thread (mqt_v_js) — and touching
    // the window off the UI thread crashed the app at start («Only the original thread that created a
    // view hierarchy can touch its views»). The window is changed on the UI thread only.
    OnActivityEntersForeground {
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
        activity.runOnUiThread {
          runCatching {
            activity.window.isNavigationBarContrastEnforced = false
            activity.window.isStatusBarContrastEnforced = false
          }
        }
      }
    }
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
  /** A mutable bitmap, so a gain map can be attached to it. */
  private fun bitmap(image:PixelImage)=Bitmap.createBitmap(image.width,image.height,Bitmap.Config.ARGB_8888).apply{setPixels(image.pixels,0,image.width,0,0,image.width,image.height)}

  private fun render(uri:String,options:PhotoOptions):Map<String,Any> {
    val files=PhotoFiles(context());val header=files.header(uri)
    // A mode that cannot carry HDR (transparent PNG, document, PNG) needs the explicit, labelled SDR choice.
    if(header.range.value!="sdr" && options.sdrOnly && !options.sdr)throw PhotoFailure("HDR_NEEDS_CONSENT")
    val plan=PhotoDimensions.plan(header.width,header.height,options)
    var current=files.decode(uri,header,plan,options)
    // Geometry already moved the gain map with the base; pixel effects edit it explicitly.
    val gain=if(options.sdr)null else PhotoHdr.capture(current)
    var map=gain?.pixels()
    val neutral=gain?.neutral ?: 0
    val sourceMap=map
    try {
      if(options.strokes.isNotEmpty()) {
        val input=pixels(current);current.recycle()
        current=bitmap(PhotoPixels.inpaint(input,options.strokes))
        map=map?.let{PhotoGainmap.inpaintMap(it,options.strokes,neutral)}
      }
      if(options.background!="keep") {
        val foreground=PhotoBackground(context()).foreground(current);current.recycle();current=foreground
        if(options.background=="transparent")map=null
      }
      if(options.background=="white"||options.document!="none"||options.scale>1) {
        var image=pixels(current);current.recycle()
        if(options.background=="white") {
          map=map?.let{PhotoGainmap.compositeOnWhite(it,PhotoGainmap.sampleAlpha(image,it.width,it.height),neutral)}
          image=PhotoPixels.whiteBackground(image)
        }
        if(options.document!="none"){image=PhotoPixels.document(image,options.document=="bw");map=null}
        if(options.scale>1){image=PhotoPixels.upscale(image,options.scale);map=map?.let{PhotoGainmap.upscale(it,options.scale)}}
        current=bitmap(image)
      }
      if(options.drawings.isNotEmpty()) {
        if(!current.isMutable){val copy=current.copy(Bitmap.Config.ARGB_8888,true);current.recycle();current=copy}
        drawLines(current,options.drawings)
        map=map?.let{PhotoGainmap.neutralUnderDrawings(it,options.drawings,neutral)}
      }
      if(gain!=null && Build.VERSION.SDK_INT>=34) {
        // Unchanged map pixels keep the decoder's own Gainmap; edited ones get a copy with the same parameters.
        PhotoHdr.attach(current,map?.let{if(it===sourceMap)gain.gainmap else gain.with(it)})
      }
      val output=files.save(current,options.downsampleAllowed,options.format).toMutableMap()
      output["downsampled"]=plan.downsampled || output["downsampled"]==true
      return output
    }finally{current.recycle()}
  }

  /** Pen lines drawn on the base after all effects, with round caps (as in the preview). */
  private fun drawLines(bitmap:Bitmap,drawings:List<PhotoDrawing>) {
    val canvas=Canvas(bitmap);val unit=minOf(bitmap.width,bitmap.height).toFloat()
    for(drawing in drawings) {
      val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=drawing.color;style=Paint.Style.STROKE;strokeWidth=(drawing.width*unit).toFloat();strokeCap=Paint.Cap.ROUND;strokeJoin=Paint.Join.ROUND}
      val first=drawing.points.first();val path=Path();path.moveTo((first.x*bitmap.width).toFloat(),(first.y*bitmap.height).toFloat())
      if(drawing.points.size==1)path.lineTo((first.x*bitmap.width).toFloat()+.01f,(first.y*bitmap.height).toFloat())
      for(point in drawing.points.drop(1))path.lineTo((point.x*bitmap.width).toFloat(),(point.y*bitmap.height).toFloat())
      canvas.drawPath(path,paint)
    }
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
        "HDR_NEEDS_CONSENT"->"Это HDR-фото. На этом устройстве HDR при такой обработке не сохраняется. Отправьте его без HDR — с обычной яркостью."
        "CROP_SOURCE_TOO_LARGE"->"Для точной обрезки нужен исходник до 16 Мп. Сначала сохраните уменьшенную копию без обрезки."
        else->"Не удалось обработать фото. Исходное изображение не отправлено."
      }
      throw CodedException("ERR_LINEA_PHOTO_$reason",message,null)
    }
  }
}
