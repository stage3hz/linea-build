package expo.modules.lineaphoto

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.view.ViewGroup
import androidx.camera.core.CameraSelector
import androidx.camera.core.MirrorMode
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.ExperimentalPersistentRecording
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File

/**
 * Round video messages on Android, recorded with CameraX «persistent recording»: the camera can be
 * switched while recording and the file keeps going (expo-camera rebinds and stops the file).
 * The Recorder (encoder) stays the same; only the camera bound to it changes.
 */
class VideoNoteModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LineaVideoNote")
    View(VideoNoteView::class) {
      Events("onReady", "onCameraError")
      Prop("facing") { view: VideoNoteView, facing: String -> view.setFacing(facing) }
      AsyncFunction("startRecording") { view: VideoNoteView, path: String, promise: Promise -> view.start(path, promise) }
      AsyncFunction("stopRecording") { view: VideoNoteView, promise: Promise -> view.stop(promise) }
    }
  }
}

@SuppressLint("ViewConstructor")
class VideoNoteView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onReady by EventDispatcher()
  private val onCameraError by EventDispatcher()
  private val preview = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE // TextureView: clips to the circle
    scaleType = PreviewView.ScaleType.FILL_CENTER
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }
  private var provider: ProcessCameraProvider? = null
  private var facing = "front"
  private val recorder = Recorder.Builder()
    .setQualitySelector(QualitySelector.from(Quality.SD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
    .build()
  private val videoCapture = VideoCapture.Builder(recorder).setMirrorMode(MirrorMode.MIRROR_MODE_ON_FRONT_ONLY).build()
  private var recording: Recording? = null
  private var file: File? = null
  private var started: Promise? = null
  private var stopped: Promise? = null

  init { addView(preview) }

  // React Native does not lay out native children by itself.
  override fun requestLayout() { super.requestLayout(); post { measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)); layout(left, top, right, bottom) } }
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) { preview.layout(0, 0, r - l, b - t) }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      try { provider = future.get(); bind() } catch (error: Exception) { onCameraError(mapOf("message" to (error.message ?: "Камера недоступна."))) }
    }, ContextCompat.getMainExecutor(context))
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    try { recording?.stop() } catch (_: Exception) {}
    recording = null
    provider?.unbindAll()
  }

  fun setFacing(value: String) {
    if (value == facing) return
    facing = value
    bind() // a persistent recording continues on the new camera
  }

  private fun bind() {
    val camera = provider ?: return
    val owner = appContext.currentActivity as? LifecycleOwner ?: run { onCameraError(mapOf("message" to "Камера недоступна.")); return }
    val selector = if (facing == "back") CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
    val previewCase = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
    try {
      camera.unbindAll()
      camera.bindToLifecycle(owner, selector, previewCase, videoCapture)
      onReady(mapOf("facing" to facing))
    } catch (error: Exception) {
      onCameraError(mapOf("message" to (error.message ?: "Не удалось открыть камеру.")))
    }
  }

  @SuppressLint("MissingPermission") // the JS side requests camera and microphone first
  @OptIn(ExperimentalPersistentRecording::class)
  fun start(path: String, promise: Promise) {
    if (recording != null) { promise.reject("BUSY", "Запись уже идёт.", null); return }
    val target = File(Uri.parse(path).path ?: path)
    target.parentFile?.mkdirs()
    file = target; started = promise
    recording = videoCapture.output
      .prepareRecording(context, FileOutputOptions.Builder(target).build())
      .withAudioEnabled()
      .asPersistentRecording()
      .start(ContextCompat.getMainExecutor(context)) { event ->
        when (event) {
          is VideoRecordEvent.Start -> { started?.resolve(null); started = null }
          is VideoRecordEvent.Finalize -> {
            recording = null
            val error = event.error
            if (error != VideoRecordEvent.Finalize.ERROR_NONE && error != VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED) {
              started?.reject("RECORDING", "Не удалось записать видео.", null); started = null
              stopped?.reject("RECORDING", "Не удалось записать видео (код $error).", null); stopped = null
            } else {
              stopped?.resolve(Uri.fromFile(file).toString()); stopped = null
            }
          }
          else -> {}
        }
      }
  }

  fun stop(promise: Promise) {
    val current = recording ?: run { promise.reject("IDLE", "Запись не идёт.", null); return }
    stopped = promise
    current.stop()
  }
}
