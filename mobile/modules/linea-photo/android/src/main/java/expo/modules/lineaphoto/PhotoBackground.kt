package expo.modules.lineaphoto

import android.content.Context
import android.graphics.Bitmap
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class PhotoBackground(private val context:Context) {
  companion object { private val inferencePending=AtomicBoolean(false) }
  private fun client()=SubjectSegmentation.getClient(SubjectSegmenterOptions.Builder().enableForegroundBitmap().build())
  private fun googleAvailable()=GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)==ConnectionResult.SUCCESS
  fun capabilities():Map<String,Any> {
    val result=mutableMapOf<String,Any>("backgroundRemoval" to googleAvailable(),"backgroundReady" to false,"objectRemoval" to "diffusion","upscale" to "bicubic","maxPlainPixels" to 16_000_000,"maxProcessingPixels" to 4_000_000,"maxOutputPixels" to 8_000_000)
    result["hdrPreservation"]=false
    result["hdrReason"]="Эффекты редактора работают с SDR в 8 бит. HDR и неподтверждённый диапазон блокируются до преобразования пикселей."
    if(!googleAvailable()){result["backgroundReason"]="Для удаления фона нужны доступные сервисы Google Play.";return result}
    val client=client()
    try {
      val ready=Tasks.await(ModuleInstall.getClient(context).areModulesAvailable(client),10,TimeUnit.SECONDS).areModulesAvailable()
      result["backgroundReady"]=ready
      if(!ready)result["backgroundReason"]="Сначала загрузите модель удаления фона. Само фото обрабатывается на устройстве."
    }catch(_:Exception){result["backgroundReason"]="Не удалось проверить модель Google Play. Проверьте подключение и повторите."}
    finally{client.close()}
    return result
  }
  fun prepare():Map<String,Any> {
    if(!googleAvailable())throw PhotoFailure("GOOGLE_PLAY_UNAVAILABLE")
    val client=client()
    try {
      val request=ModuleInstallRequest.newBuilder().addApi(client).build()
      Tasks.await(ModuleInstall.getClient(context).installModules(request),20,TimeUnit.SECONDS)
    }finally{client.close()}
    return capabilities()
  }
  fun foreground(source:Bitmap):Bitmap {
    val available=capabilities()
    if(available["backgroundRemoval"]!=true)throw PhotoFailure("GOOGLE_PLAY_UNAVAILABLE")
    if(available["backgroundReady"]!=true)throw PhotoFailure("MODEL_NOT_READY")
    val client=client()
    if(!inferencePending.compareAndSet(false,true)){client.close();throw PhotoFailure("BACKGROUND_BUSY")}
    val input=try{source.copy(Bitmap.Config.ARGB_8888,false) ?: throw PhotoFailure("OUT_OF_MEMORY")}
      catch(error:Throwable){client.close();inferencePending.set(false);throw error}
    val task=try{client.process(InputImage.fromBitmap(input,0))}
      catch(error:Throwable){input.recycle();client.close();inferencePending.set(false);throw error}
    try {
      val result=Tasks.await(task,60,TimeUnit.SECONDS).foregroundBitmap ?: throw PhotoFailure("NO_FOREGROUND")
      if(result.width!=source.width||result.height!=source.height)throw PhotoFailure("NO_FOREGROUND")
      if(!hasForeground(result))throw PhotoFailure("NO_FOREGROUND")
      return result.copy(Bitmap.Config.ARGB_8888,false) ?: throw PhotoFailure("OUT_OF_MEMORY")
    }finally {
      val release={try{if(task.isSuccessful)task.result.foregroundBitmap?.recycle();input.recycle();client.close()}finally{inferencePending.set(false)}}
      if(task.isComplete)release() else task.addOnCompleteListener(Executor { command->command.run() }){release()}
    }
  }
  private fun hasForeground(bitmap:Bitmap):Boolean {
    val row=IntArray(bitmap.width)
    for(y in 0 until bitmap.height){bitmap.getPixels(row,0,bitmap.width,0,y,bitmap.width,1);if(row.any{it ushr 24>2})return true}
    return false
  }
}
