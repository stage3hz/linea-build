package expo.modules.lineaphoto

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.RenderEffect
import android.graphics.Shader
import android.net.Uri
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
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
import androidx.lifecycle.Observer
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
 * Phones that can stream the front and back camera at once (CameraX concurrent camera) run both while the
 * recorder is open, so a flip is instant (VideoNoteDualCamera.kt); every other phone, and any failure there,
 * uses the single-camera path here, whose flip is covered by the last frame, blurred, until the new camera
 * streams (as on iPhone).
 */
class VideoNoteModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LineaVideoNote")
    // Called when a chat opens: CameraX's first initialisation (camera list, characteristics) is done
    // ahead of time, so the first press of the video-note button only has to open the camera.
    Function("prewarm") { appContext.reactContext?.let { ProcessCameraProvider.getInstance(it) }; Unit }
    View(VideoNoteView::class) {
      Events("onReady", "onCameraError")
      Prop("facing") { view: VideoNoteView, facing: String -> view.setFacing(facing) }
      Prop("zoom") { view: VideoNoteView, zoom: Float -> view.setZoom(zoom) }
      AsyncFunction("startRecording") { view: VideoNoteView, path: String, promise: Promise -> view.start(path, promise) }
      AsyncFunction("stopRecording") { view: VideoNoteView, promise: Promise -> view.stop(promise) }
      AsyncFunction("pauseRecording") { view: VideoNoteView, paused: Boolean -> view.setPaused(paused) }
    }
  }
}

@SuppressLint("ViewConstructor")
class VideoNoteView(context: Context, appContext: AppContext) : ExpoView(context, appContext), VideoNoteDualCamera.Host {
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

  // Single path flip: the last good frame, lightly blurred, covers the circle at once (no fade-in) until the
  // new camera streams; then it crossfades out. JS draws no flip blur over this view.
  private val flipCover = ImageView(context).apply {
    scaleType = ImageView.ScaleType.FIT_XY
    visibility = View.GONE
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }
  // Both cameras at once where the phone allows it (VideoNoteDualCamera.kt); null = the single path here.
  private var dual: VideoNoteDualCamera? = null
  private var dualBroken = false // this recorder already fell back once: no second try

  init { addView(preview); addView(flipCover) }

  // React Native does not lay out native children by itself.
  override fun requestLayout() { super.requestLayout(); post { measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)); layout(left, top, right, bottom) } }
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    preview.layout(0, 0, r - l, b - t)
    dual?.view?.layout(0, 0, r - l, b - t)
    flipCover.layout(0, 0, r - l, b - t)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      try { provider = future.get(); if (!openDual()) bind() } catch (error: Exception) { onCameraError(mapOf("message" to (error.message ?: "Камера недоступна."))) }
    }, ContextCompat.getMainExecutor(context))
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    closeDual()
    hideCover()
    try { recording?.stop() } catch (_: Exception) {}
    recording = null
    bindCount++ // cancels a pending ready fallback
    streamObserver?.let { preview.previewStreamState.removeObserver(it) }
    streamObserver = null
    provider?.unbindAll()
  }

  // onReady is sent when the preview really shows frames (PreviewView STREAMING), not when bindToLifecycle
  // returns (the camera is still opening then): JS uncovers the circle and starts the take at once.
  private var streamObserver: Observer<PreviewView.StreamState>? = null
  private var readySent = false
  private var bindCount = 0

  private fun sendReady() {
    if (readySent) return
    readySent = true
    onReady(mapOf("facing" to facing))
  }

  private fun watchStream(owner: LifecycleOwner) {
    if (streamObserver != null) return
    val observer = Observer<PreviewView.StreamState> { state ->
      if (state == PreviewView.StreamState.IDLE) coverAwaitIdle = false
      if (state == PreviewView.StreamState.STREAMING) {
        sendReady()
        if (flipCover.visibility == View.VISIBLE && !coverAwaitIdle) settleCover()
      }
    }
    streamObserver = observer
    preview.previewStreamState.observe(owner, observer)
  }

  private var bound: androidx.camera.core.Camera? = null
  private var zoom = 0f
  /** Pinch zoom (Telegram): 0 = widest, 1 = the camera's maximum. */
  fun setZoom(value: Float) {
    zoom = value.coerceIn(0f, 1f)
    dual?.let { it.setZoom(zoom); return }
    bound?.cameraControl?.setLinearZoom(zoom)
  }

  fun setFacing(value: String) {
    if (value == facing) return
    facing = value
    dual?.let { it.setFacing(value); return } // both cameras run: only the drawn one changes
    if (provider == null) return
    coverFlip()
    bind() // a persistent recording continues on the new camera
  }

  // MARK: both cameras (VideoNoteDualCamera.kt)

  /** Both cameras where the phone can stream them together; false = the single path (bind()). */
  private fun openDual(): Boolean {
    if (dualBroken || dual != null) return dual != null
    val camera = provider ?: return false
    val owner = appContext.currentActivity as? LifecycleOwner ?: return false
    val pair = VideoNoteDualCamera.pair(context, camera) ?: return false
    val rig = try { VideoNoteDualCamera(context, owner, camera, pair, this, facing, zoom) } catch (_: Throwable) { return false }
    addView(rig.view, 1) // above the (unused) PreviewView, below the flip cover
    rig.view.layout(0, 0, width, height)
    dual = rig
    if (!rig.open()) { dualBroken = true; closeDual(); return false }
    preview.visibility = View.INVISIBLE
    return true
  }

  private fun closeDual() {
    val rig = dual ?: return
    dual = null
    rig.release()
    removeView(rig.view)
    preview.visibility = View.VISIBLE
  }

  /** The single path from here on (the dual one failed or got too hot); an idle recorder rebinds. */
  private fun leaveDual() {
    dualBroken = true
    closeDual()
    readySent = false
    bind()
  }

  override fun dualReady(facing: String) { if (dual != null) sendReady() }
  override fun dualFailed() { if (dual != null) leaveDual() }
  override fun dualRecordingFailed(path: String, promise: Promise?) {
    leaveDual()
    startSingle(path, promise)
  }

  // MARK: flip cover (single path)

  private var coverToken = 0
  private var coverAwaitIdle = false

  private fun coverFlip() {
    if (!readySent) return // nothing shown yet: the JS start cover is still up
    val showing = flipCover.visibility == View.VISIBLE
    flipCover.animate().cancel()
    if (!showing) {
      // PreviewView's picture as shown (upright, mirrored like the screen); null when nothing is drawn.
      val frame = try { preview.bitmap } catch (_: Exception) { null } ?: return
      flipCover.setImageBitmap(blurred(frame))
    }
    flipCover.alpha = 1f
    flipCover.visibility = View.VISIBLE
    coverAwaitIdle = true // the old camera's STREAMING must not release the cover
    val token = ++coverToken
    postDelayed({ if (token == coverToken) fadeCover() }, 1500) // never stuck over a camera that streams
  }

  /** A light blur: a small copy scaled up with filtering (+ RenderEffect on Android 12+). */
  private fun blurred(frame: Bitmap): Bitmap {
    val factor = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) 4 else 10
    val small = Bitmap.createScaledBitmap(frame, maxOf(1, frame.width / factor), maxOf(1, frame.height / factor), true)
    if (small !== frame) frame.recycle()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flipCover.setRenderEffect(RenderEffect.createBlurEffect(12f, 12f, Shader.TileMode.CLAMP))
    return small
  }

  /** The new camera streams: a few frames for its upright transform to settle, then a 150 ms crossfade. */
  private fun settleCover() {
    val token = ++coverToken
    postDelayed({ if (token == coverToken) fadeCover() }, 60)
  }

  private fun fadeCover() {
    val token = ++coverToken
    flipCover.animate().alpha(0f).setDuration(150).withEndAction { if (token == coverToken) hideCover() }.start()
  }

  private fun hideCover() {
    coverToken++
    flipCover.animate().cancel()
    flipCover.visibility = View.GONE
    flipCover.setImageDrawable(null)
  }

  private fun bind() {
    if (dual != null) return
    val camera = provider ?: return
    val owner = appContext.currentActivity as? LifecycleOwner ?: run { onCameraError(mapOf("message" to "Камера недоступна.")); return }
    val selector = if (facing == "back") CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
    val previewCase = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
    try {
      camera.unbindAll()
      readySent = false
      watchStream(owner)
      bound = camera.bindToLifecycle(owner, selector, previewCase, videoCapture)
      bound?.cameraControl?.setLinearZoom(zoom)
      // Fallback if a device never reports STREAMING: ready a little later anyway (as before, only late).
      val generation = ++bindCount
      postDelayed({ if (generation == bindCount) sendReady() }, 1500)
    } catch (error: Exception) {
      onCameraError(mapOf("message" to (error.message ?: "Не удалось открыть камеру.")))
    }
  }

  fun start(path: String, promise: Promise) {
    dual?.let { it.startRecording(path, promise); return }
    startSingle(path, promise)
  }

  @SuppressLint("MissingPermission") // the JS side requests camera and microphone first
  @OptIn(ExperimentalPersistentRecording::class)
  private fun startSingle(path: String, promise: Promise?) {
    if (recording != null) { promise?.reject("BUSY", "Запись уже идёт.", null); return }
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
            // CameraX documents these endings as leaving a valid, playable file (the camera was taken away
            // mid-take, e.g. a call or the app went to the background; a size limit): the take is kept.
            val usable = error == VideoRecordEvent.Finalize.ERROR_NONE || error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED ||
              error == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED || error == VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE
            if (!usable || (file?.length() ?: 0L) <= 0L) {
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

  /** Pause / continue the same file (Telegram's pause while recording a video message hands-free). */
  fun setPaused(paused: Boolean) {
    dual?.let { it.setPaused(paused); return }
    val current = recording ?: return
    if (paused) current.pause() else current.resume()
  }
  fun stop(promise: Promise) {
    dual?.let { it.stopRecording(promise); return }
    val current = recording ?: run { promise.reject("IDLE", "Запись не идёт.", null); return }
    stopped = promise
    current.stop()
  }
}
