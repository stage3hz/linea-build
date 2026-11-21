package com.linea.messenger.attachments

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

/** Media: «Фон» of the photo editor — the reference's own Android code (mobile/modules/linea-photo/android/
 *  PhotoBackground.kt), ported as it is. It stands on ML Kit subject segmentation, the very artifact the reference
 *  links (com.google.android.gms:play-services-mlkit-subject-segmentation:16.0.0-beta1). That is a Google Play
 *  services module: its model is not inside this app; Play services downloads it onto the phone when the person
 *  taps «Подготовить удаление фона» (`prepare`). The photo itself is processed on the phone and never sent.
 *  Without Play services the editor says so and offers only «Исходный». Every call blocks: never on the main
 *  thread. Nothing here is touched unless the person opens «Фон». */
class PhotoBackground(private val context: Context) {
  /** What «Фон» can do on this phone (the reference's `capabilities`, the background part of it). */
  class Abilities(val removal: Boolean, val ready: Boolean, val reason: String?)

  companion object { private val inferencePending = AtomicBoolean(false) }

  private fun client() = SubjectSegmentation.getClient(SubjectSegmenterOptions.Builder().enableForegroundBitmap().build())
  private fun googleAvailable() = try { GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS } catch (_: Throwable) { false }

  fun capabilities(): Abilities {
    if (!googleAvailable()) return Abilities(false, false, "Для удаления фона нужны доступные сервисы Google Play.")
    val client = client()
    return try {
      val ready = Tasks.await(ModuleInstall.getClient(context).areModulesAvailable(client), 10, TimeUnit.SECONDS).areModulesAvailable()
      Abilities(true, ready, if (!ready) "Сначала загрузите модель удаления фона. Само фото обрабатывается на устройстве." else null)
    } catch (_: Exception) {
      Abilities(true, false, "Не удалось проверить модель Google Play. Проверьте подключение и повторите.")
    } finally { client.close() }
  }

  /** «Подготовить удаление фона»: Play services downloads the model (only on this tap). */
  fun prepare(): Abilities {
    if (!googleAvailable()) throw PhotoFailure("GOOGLE_PLAY_UNAVAILABLE")
    val client = client()
    try {
      val request = ModuleInstallRequest.newBuilder().addApi(client).build()
      Tasks.await(ModuleInstall.getClient(context).installModules(request), 20, TimeUnit.SECONDS)
    } finally { client.close() }
    return capabilities()
  }

  /** The subject on a transparent background, the size of `source`. */
  fun foreground(source: Bitmap): Bitmap {
    val available = capabilities()
    if (!available.removal) throw PhotoFailure("GOOGLE_PLAY_UNAVAILABLE")
    if (!available.ready) throw PhotoFailure("MODEL_NOT_READY")
    val client = client()
    if (!inferencePending.compareAndSet(false, true)) { client.close(); throw PhotoFailure("BACKGROUND_BUSY") }
    val input = try { source.copy(Bitmap.Config.ARGB_8888, false) ?: throw PhotoFailure("OUT_OF_MEMORY") }
      catch (error: Throwable) { client.close(); inferencePending.set(false); throw error }
    val task = try { client.process(InputImage.fromBitmap(input, 0)) }
      catch (error: Throwable) { input.recycle(); client.close(); inferencePending.set(false); throw error }
    try {
      val result = Tasks.await(task, 60, TimeUnit.SECONDS).foregroundBitmap ?: throw PhotoFailure("NO_FOREGROUND")
      if (result.width != source.width || result.height != source.height) throw PhotoFailure("NO_FOREGROUND")
      if (!hasForeground(result)) throw PhotoFailure("NO_FOREGROUND")
      return result.copy(Bitmap.Config.ARGB_8888, false) ?: throw PhotoFailure("OUT_OF_MEMORY")
    } finally {
      val release = { try { if (task.isSuccessful) task.result.foregroundBitmap?.recycle(); input.recycle(); client.close() } finally { inferencePending.set(false) } }
      if (task.isComplete) release() else task.addOnCompleteListener(Executor { command -> command.run() }) { release() }
    }
  }

  private fun hasForeground(bitmap: Bitmap): Boolean {
    val row = IntArray(bitmap.width)
    for (y in 0 until bitmap.height) { bitmap.getPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1); if (row.any { it ushr 24 > 2 }) return true }
    return false
  }
}
