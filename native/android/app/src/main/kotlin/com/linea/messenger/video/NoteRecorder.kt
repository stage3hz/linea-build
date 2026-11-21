package com.linea.messenger.video

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Size
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.design.Theme
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.voice.MediaIcons
import com.linea.messenger.voice.Permits
import java.io.File

/** The recorder of a round video message: the front camera in a circle over the dimmed chat, a ring that fills
 *  in a minute (the longest take), the time, and three buttons — call off, stop and send, turn the camera.
 *  The camera and the microphone are used only while this screen is open; both permissions are asked when it
 *  first opens.
 *
 *  Reference: mobile/src/videonote/VideoNote.tsx (`VideoNoteRecorder`: front camera first, 60 s at most, the
 *  wording) and mobile/modules/linea-photo/android/VideoNoteCamera.kt (SD capture, H.264 + AAC in an MP4). The
 *  reference's module stands on the CameraX library; here the platform's own Camera2 and MediaRecorder do the
 *  same, and — as on the iPhone — the camera is not turned in the middle of a take. Before the take is sent it
 *  is written anew without metadata (`VideoPrepare.prepare`), like any other video. */
class NoteRecorder(private val activity: Activity, private val startAtOnce: Boolean) : Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar), TextureView.SurfaceTextureListener {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val main = Handler(Looper.getMainLooper())
  private val manager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
  private val preview = TextureView(context)
  private val circle = FrameLayout(context)
  private val heading = TextView(context)
  private val problem = TextView(context)
  private var progress = 0f
  private var recording = false
  private var ready = false
  private var front = true
  private var granted = false
  private var texture: SurfaceTexture? = null
  private var camera: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private var recorder: MediaRecorder? = null
  private var previewSurface: Surface? = null
  private var file: File? = null
  private var size = Size(640, 480)
  private var sensorTurn = 90
  private var startedAt = 0L
  private var closed = false
  /** Counts the openings: an answer of an earlier one (the camera was turned meanwhile) is not listened to. */
  private var generation = 0
  /** The take is finished (main thread): the recorded file, to be prepared and sent. Not called for a take that
   *  was called off. */
  var onDone: ((File) -> Unit)? = null

  // Media: both cameras at once where the phone can (the reference's VideoNoteDualCamera.kt, video/NoteDualCamera.kt):
  // a turn only changes which camera is drawn — on screen and into the file —, so it is instant and works in the
  // middle of a take. Elsewhere (or if anything of it fails before the take runs) the single camera above.
  private var dual: NoteDualCamera? = null
  private var dualFile: File? = null
  private var dualStopping = false
  private var dualTried = false
  /** The single path took over from a take that could not start on both cameras: it records once ready. */
  private var beginWhenReady = false
  private val lifecycleOwner = object : androidx.lifecycle.LifecycleOwner {
    val registry = androidx.lifecycle.LifecycleRegistry(this)
    override fun getLifecycle(): androidx.lifecycle.Lifecycle = registry
  }
  private val dualHost = object : NoteDualCamera.Host {
    override fun dualReady(facing: String) {
      if (closed) return
      ready = true
      recordButton.isEnabled = true
      recordButton.alpha = 1f
      showButtons()
      if (startAtOnce && startedAt == 0L) begin()
    }
    override fun dualFailed() { if (!closed) singleInstead(beginAfter = false) }
    override fun dualRecordingFailed(file: File, started: ((Boolean) -> Unit)?) {
      file.delete()
      if (closed) return
      recording = false
      main.removeCallbacks(clock)
      progress = 0f
      singleInstead(beginAfter = true)
    }
  }

  private inner class RoundButton(val symbol: () -> String, val plate: Boolean, val tint: () -> Int, val symbolSize: () -> Float) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    init { isClickable = true; isFocusable = true }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
    override fun onDraw(canvas: Canvas) {
      val cx = width / 2f; val cy = height / 2f; val radius = minOf(width, height) / 2f
      if (plate) {
        paint.style = Paint.Style.FILL; paint.color = if (isPressed) 0x3DFFFFFF else 0x24FFFFFF
        canvas.drawCircle(cx, cy, radius, paint)
      } else {
        paint.style = Paint.Style.STROKE; paint.strokeWidth = 4f * d; paint.color = Color.WHITE
        canvas.drawCircle(cx, cy, radius - 2f * d, paint)
      }
      MediaIcons.draw(canvas, symbol(), cx, cy, symbolSize() * d, tint(), if (plate) 1.8f else 2.6f)
    }
  }

  private val closeButton = RoundButton({ "xmark" }, true, { Color.WHITE }, { 26f })
  private val recordButton = RoundButton({ if (recording) "arrow.up" else "circle.fill" }, false, { if (recording) Color.WHITE else Theme.danger }, { if (recording) 34f else 56f })
  private val flipButton = RoundButton({ "camera.flip" }, true, { Color.WHITE }, { 28f })

  /** The dimmed page with its parts placed by hand, and the ring of the take around the circle. */
  private val root = object : ViewGroup(context) {
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    init { setWillNotDraw(false); setBackgroundColor(0xD1000000.toInt()) }

    private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
      view.measure(MeasureSpec.makeMeasureSpec(maxOf(0, width), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(maxOf(0, height), MeasureSpec.EXACTLY))
      view.layout(left, top, left + maxOf(0, width), top + maxOf(0, height))
    }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
      val width = right - left; val height = bottom - top
      val side = minOf(dp(300f), width - dp(48f), height - dp(260f)).coerceAtLeast(dp(120f))
      val circleLeft = (width - side) / 2; val circleTop = maxOf(dp(72f), (height - side) / 2 - dp(40f))
      put(circle, circleLeft, circleTop, side, side)
      put(heading, dp(24f), circleTop - dp(56f), width - dp(48f), dp(24f))
      put(problem, dp(32f), circleTop + side + dp(16f), width - dp(64f), dp(64f))
      val low = rootWindowInsets?.let { if (Build.VERSION.SDK_INT >= 30) it.getInsets(android.view.WindowInsets.Type.systemBars()).bottom else @Suppress("DEPRECATION") it.systemWindowInsetBottom } ?: 0
      val line = minOf(height - low - dp(70f), circleTop + side + dp(130f))
      put(recordButton, width / 2 - dp(39f), line - dp(39f), dp(78f), dp(78f))
      put(closeButton, width / 2 - dp(39f) - dp(40f) - dp(52f), line - dp(26f), dp(52f), dp(52f))
      put(flipButton, width / 2 + dp(39f) + dp(40f), line - dp(26f), dp(52f), dp(52f))
      fit()
    }

    override fun onDraw(canvas: Canvas) {
      if (progress <= 0f) return
      ring.color = Theme.danger
      ring.strokeWidth = 3f * d
      val cx = circle.left + circle.width / 2f; val cy = circle.top + circle.height / 2f
      val radius = circle.width / 2f + 6f * d
      canvas.drawArc(cx - radius, cy - radius, cx + radius, cy + radius, -90f, 360f * progress, false, ring)
    }
  }

  init {
    circle.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Theme.surface2 or 0xFF000000.toInt()) }
    circle.clipToOutline = true
    circle.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) = outline.setOval(0, 0, view.width, view.height)
    }
    circle.addView(preview, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    preview.surfaceTextureListener = this
    root.addView(circle)
    heading.text = "Видеосообщение"
    heading.textSize = 17f
    heading.typeface = Theme.weight(700)
    heading.fontFeatureSettings = "tnum"
    heading.setTextColor(Color.WHITE)
    heading.gravity = Gravity.CENTER
    heading.includeFontPadding = false
    root.addView(heading)
    problem.textSize = 15f
    problem.setTextColor(Color.WHITE)
    problem.gravity = Gravity.CENTER_HORIZONTAL
    problem.visibility = View.GONE
    root.addView(problem)
    closeButton.contentDescription = "Отменить видеосообщение"
    closeButton.setOnClickListener { finish(keep = false) }
    root.addView(closeButton)
    recordButton.alpha = 0.4f
    recordButton.isEnabled = false
    recordButton.setOnClickListener { if (recording) finish(keep = true) else begin() }
    root.addView(recordButton)
    flipButton.contentDescription = "Сменить камеру"
    flipButton.setOnClickListener { flip() }
    root.addView(flipButton)
    setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    // Back calls the take off, as the cross does.
    setOnCancelListener { finish(keep = false) }
    showButtons()
    setOnShowListener { askAccess() }
  }

  private fun showButtons() {
    recordButton.contentDescription = if (recording) "Остановить и отправить" else "Начать запись"
    recordButton.invalidate()
    // The single camera is not turned in the middle of a take: the file would end there. With both cameras
    // (Media) the turn is instant, also while recording.
    val turnable = ready && (!recording || dual != null)
    flipButton.isEnabled = turnable
    flipButton.alpha = if (recording && dual == null) 0.3f else 1f
  }

  private fun say(words: String) {
    problem.text = words
    problem.visibility = View.VISIBLE
  }

  // The camera

  private fun askAccess() {
    Permits.ask(activity, listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)) { allowed ->
      if (closed) return@ask
      if (!allowed) return@ask say(noAccess)
      granted = true
      tryDual()
    }
  }

  /** Media: both cameras where `NoteDualCamera.pair` finds a front and back pair that may stream together. */
  private fun tryDual() {
    if (dualTried) return open()
    dualTried = true
    val future = try { androidx.camera.lifecycle.ProcessCameraProvider.getInstance(context) } catch (_: Throwable) { return open() }
    future.addListener({
      if (closed) return@addListener
      val provider = try { future.get() } catch (_: Throwable) { null }
      val pair = provider?.let { NoteDualCamera.pair(context, it) }
      if (provider == null || pair == null) return@addListener open()
      lifecycleOwner.registry.currentState = androidx.lifecycle.Lifecycle.State.RESUMED
      val made = NoteDualCamera(context, lifecycleOwner, provider, pair, dualHost, if (front) "front" else "back", 0f)
      circle.removeView(preview)
      circle.addView(made.view, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      dual = made
      if (!made.open()) singleInstead(beginAfter = false)
    }, context.mainExecutor)
  }

  /** Media: back to the single camera (both could not run here). */
  private fun singleInstead(beginAfter: Boolean) {
    val made = dual ?: return
    dual = null
    made.release()
    circle.removeView(made.view)
    if (preview.parent == null) circle.addView(preview, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    ready = false
    recordButton.isEnabled = false
    recordButton.alpha = 0.4f
    beginWhenReady = beginAfter
    showButtons()
    open()
  }

  override fun onSurfaceTextureAvailable(made: SurfaceTexture, width: Int, height: Int) {
    texture = made
    open()
  }

  override fun onSurfaceTextureSizeChanged(made: SurfaceTexture, width: Int, height: Int) = fit()
  override fun onSurfaceTextureUpdated(made: SurfaceTexture) {}
  override fun onSurfaceTextureDestroyed(made: SurfaceTexture): Boolean {
    texture = null
    shut()
    return true
  }

  /** The camera that looks the wanted way; its id, how its sensor is turned and the size it is asked for. */
  private fun choose(wantFront: Boolean): String? {
    val manager = manager ?: return null
    val wanted = if (wantFront) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
    for (id in manager.cameraIdList) {
      val about = manager.getCameraCharacteristics(id)
      if (about.get(CameraCharacteristics.LENS_FACING) != wanted) continue
      sensorTurn = about.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
      val sizes = about.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(MediaRecorder::class.java)?.toList() ?: emptyList()
      size = captureSize(sizes.map { Pair(it.width, it.height) }).let { Size(it.first, it.second) }
      return id
    }
    return null
  }

  /** Opens the camera once both the permissions and the circle's surface are there. */
  @SuppressLint("MissingPermission")
  private fun open() {
    val texture = texture ?: return
    if (!granted || closed || camera != null || dual != null || !dualTried) return
    val mine = ++generation
    try {
      val id = choose(front) ?: return say("Камера недоступна.")
      val target = VideoPrepare.freshFile(context, "mp4")
      val made = recorder(target)
      file = target
      recorder = made
      texture.setDefaultBufferSize(size.width, size.height)
      fit()
      manager?.openCamera(id, object : CameraDevice.StateCallback() {
        override fun onOpened(device: CameraDevice) {
          if (mine != generation || closed) { device.close(); return }
          camera = device
          startSession(device, texture, made, mine)
        }
        override fun onDisconnected(device: CameraDevice) { device.close(); if (mine == generation) lost() }
        override fun onError(device: CameraDevice, error: Int) { device.close(); if (mine == generation) lost() }
      }, main)
    } catch (_: Exception) {
      shut()
      say("Камера недоступна.")
    }
  }

  /** The system's recorder, ready to take the camera's picture: H.264 and AAC in an MP4, written upright. */
  private fun recorder(target: File): MediaRecorder {
    @Suppress("DEPRECATION")
    val made = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
    try {
      made.setAudioSource(MediaRecorder.AudioSource.MIC)
      made.setVideoSource(MediaRecorder.VideoSource.SURFACE)
      made.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      made.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
      made.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      made.setVideoSize(size.width, size.height)
      made.setVideoFrameRate(30)
      made.setVideoEncodingBitRate(VIDEO_BIT_RATE)
      made.setAudioSamplingRate(48000)
      made.setAudioChannels(1)
      made.setAudioEncodingBitRate(128000)
      made.setMaxDuration(MAX_MS.toInt())
      made.setOrientationHint(writtenTurn(sensorTurn, displayTurn(), front))
      made.setOutputFile(target.absolutePath)
      made.setOnInfoListener { _, what, _ -> if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) main.post { if (recording) finish(keep = true) } }
      made.setOnErrorListener { _, _, _ -> main.post { if (recording) finish(keep = false) } }
      made.prepare()
      return made
    } catch (error: Exception) {
      try { made.release() } catch (_: Exception) {}
      target.delete()
      throw error
    }
  }

  private fun startSession(device: CameraDevice, texture: SurfaceTexture, made: MediaRecorder, mine: Int) {
    try {
      val shown = Surface(texture)
      previewSurface = shown
      val written = made.surface
      @Suppress("DEPRECATION")
      device.createCaptureSession(listOf(shown, written), object : CameraCaptureSession.StateCallback() {
        override fun onConfigured(configured: CameraCaptureSession) {
          if (mine != generation || closed) return
          session = configured
          try {
            val request = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
            request.addTarget(shown)
            request.addTarget(written)
            configured.setRepeatingRequest(request.build(), null, main)
          } catch (_: Exception) { return lost() }
          ready = true
          recordButton.isEnabled = true
          recordButton.alpha = 1f
          showButtons()
          if ((startAtOnce && startedAt == 0L) || beginWhenReady) { beginWhenReady = false; begin() }
        }
        override fun onConfigureFailed(failed: CameraCaptureSession) { if (mine == generation) lost() }
      }, main)
    } catch (_: Exception) {
      lost()
    }
  }

  /** The camera was taken away or could not be set up. */
  private fun lost() {
    if (closed) return
    if (recording) return finish(keep = true)
    shut()
    ready = false
    recordButton.isEnabled = false
    recordButton.alpha = 0.4f
    showButtons()
    say("Камера недоступна.")
  }

  private fun displayTurn(): Int {
    @Suppress("DEPRECATION")
    val rotation = (if (Build.VERSION.SDK_INT >= 30) context.display else activity.windowManager.defaultDisplay)?.rotation ?: Surface.ROTATION_0
    return when (rotation) { Surface.ROTATION_90 -> 90; Surface.ROTATION_180 -> 180; Surface.ROTATION_270 -> 270; else -> 0 }
  }

  /** The picture fills the circle and keeps its shape (the phone is held upright; turned on its side, the
   *  picture is turned back). */
  private fun fit() {
    val width = preview.width; val height = preview.height
    if (width <= 0 || height <= 0) return
    val turn = displayTurn()
    val matrix = Matrix()
    val cx = width / 2f; val cy = height / 2f
    // The system shows the camera's buffer stretched over the whole view, upright for an upright phone.
    val upright = (sensorTurn % 180 != 0) == (turn % 180 == 0)
    val pictureWidth = if (upright) size.height else size.width
    val pictureHeight = if (upright) size.width else size.height
    if (turn == 90 || turn == 270) {
      val view = RectF(0f, 0f, width.toFloat(), height.toFloat())
      val buffer = RectF(0f, 0f, size.height.toFloat(), size.width.toFloat())
      buffer.offset(cx - buffer.centerX(), cy - buffer.centerY())
      matrix.setRectToRect(view, buffer, Matrix.ScaleToFit.FILL)
      val scale = maxOf(height.toFloat() / size.height, width.toFloat() / size.width)
      matrix.postScale(scale, scale, cx, cy)
      matrix.postRotate((90 * (turn / 90 - 2)).toFloat(), cx, cy)
    } else {
      val scale = NotePlayerView.fill(pictureWidth, pictureHeight, width, height)
      matrix.setScale(scale.first, scale.second, cx, cy)
      if (turn == 180) matrix.postRotate(180f, cx, cy)
    }
    preview.setTransform(matrix)
  }

  private fun flip() {
    dual?.let { both ->
      if (!ready) return
      front = !front
      flipButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
      both.setFacing(if (front) "front" else "back")
      return
    }
    if (!ready || recording) return
    front = !front
    flipButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    ready = false
    recordButton.isEnabled = false
    recordButton.alpha = 0.4f
    shut()
    showButtons()
    open()
  }

  // The take

  private val clock = object : Runnable {
    override fun run() {
      if (!recording) return
      val ms = SystemClock.elapsedRealtime() - startedAt
      heading.text = FileCore.call("voiceTimeFine", listOf(ms)) as? String ?: ""
      progress = minOf(1f, ms.toFloat() / MAX_MS)
      root.invalidate()
      // Media: the two-camera recorder has no limit of its own: the minute ends here.
      if (dual != null && ms >= MAX_MS) { finish(keep = true); return }
      main.postDelayed(this, 50)
    }
  }

  private fun begin() {
    dual?.let { both ->
      if (!ready || recording) return
      if (MusicPlayer.shared.current != null) MusicPlayer.shared.stop()
      val target = VideoPrepare.freshFile(context, "mp4")
      dualFile = target
      recording = true
      startedAt = SystemClock.elapsedRealtime()
      main.post(clock)
      showButtons()
      both.startRecording(target) { started -> if (!started && dual === both && recording) { recording = false; main.removeCallbacks(clock); showButtons() } }
      return
    }
    val recorder = recorder ?: return
    if (!ready || recording) return
    if (MusicPlayer.shared.current != null) MusicPlayer.shared.stop()
    try { recorder.start() } catch (_: Exception) { return lost() }
    recording = true
    startedAt = SystemClock.elapsedRealtime()
    main.post(clock)
    showButtons()
  }

  /** Ends the take (or the waiting for one) and closes the screen. */
  private fun finish(keep: Boolean) {
    if (closed) return
    dual?.let { both -> return finishDual(both, keep) }
    closed = true
    main.removeCallbacks(clock)
    val taken = file
    val ms = if (recording) SystemClock.elapsedRealtime() - startedAt else 0L
    var whole = false
    if (recording) {
      recording = false
      // The camera stops feeding the recorder first; a recorder stopped before its first frame throws.
      try { session?.stopRepeating() } catch (_: Exception) {}
      whole = try { recorder?.stop(); true } catch (_: Exception) { false }
    }
    file = null
    shut()
    if (taken != null) {
      if (keeps(whole, keep, ms) && taken.length() > 0) onDone?.invoke(taken) else taken.delete()
    }
    if (isShowing) dismiss()
  }

  /** Media: the two-camera take ends; the cameras are let go once its file is written. */
  private fun finishDual(both: NoteDualCamera, keep: Boolean) {
    closed = true
    main.removeCallbacks(clock)
    val ms = if (recording) SystemClock.elapsedRealtime() - startedAt else 0L
    val wasRecording = recording
    recording = false
    dualFile = null
    if (wasRecording) {
      dualStopping = true
      both.stopRecording { file, _ ->
        dualStopping = false
        if (file != null && keeps(true, keep, ms) && file.length() > 0) onDone?.invoke(file) else file?.delete()
        both.release()
        lifecycleOwner.registry.currentState = androidx.lifecycle.Lifecycle.State.DESTROYED
      }
    }
    if (isShowing) dismiss()
  }

  /** Lets the camera, the recorder and their surfaces go. A file that was being prepared and never used goes too. */
  private fun shut() {
    generation += 1
    try { session?.close() } catch (_: Exception) {}
    session = null
    try { camera?.close() } catch (_: Exception) {}
    camera = null
    try { recorder?.release() } catch (_: Exception) {}
    recorder = null
    previewSurface?.release()
    previewSurface = null
    file?.delete()
    file = null
  }

  /** The window is gone, whichever way it was closed. */
  override fun onStop() {
    super.onStop()
    release()
  }

  private fun release() {
    // Media: both cameras (unless a finished take is still being written: it lets them go itself).
    dual?.let { both ->
      if (!dualStopping) {
        if (!closed) { closed = true; main.removeCallbacks(clock) }
        if (recording) { recording = false; both.stopRecording { file, _ -> file?.delete() } }
        both.release()
        dualFile?.delete()
        lifecycleOwner.registry.currentState = androidx.lifecycle.Lifecycle.State.DESTROYED
      }
      dual = null
      return
    }
    // Closed in a way that did not go through `finish` (the window was taken down): nothing is kept.
    if (!closed) { closed = true; main.removeCallbacks(clock); if (recording) { recording = false; try { recorder?.stop() } catch (_: Exception) {} } }
    shut()
  }

  companion object {
    const val MAX_MS = 60_000L
    const val VIDEO_BIT_RATE = 2_000_000
    const val noAccess = "Нужен доступ к камере и микрофону. Разреши их для Инвиза в настройках телефона."

    /** The size the camera is asked for: 640×480 as the reference's camera writes it; where the phone has no
     *  such size, the nearest 4:3 one (at most 960 wide), else the smallest it has at all. */
    fun captureSize(sizes: List<Pair<Int, Int>>): Pair<Int, Int> {
      if (sizes.isEmpty() || sizes.contains(Pair(640, 480))) return Pair(640, 480)
      val near = sizes.filter { it.first * 3 == it.second * 4 && it.first in 320..960 }.minByOrNull { Math.abs(it.first - 640) }
      return near ?: sizes.minByOrNull { Math.abs(it.first * it.second - 640 * 480) }!!
    }

    /** How the written picture must be turned to stand upright: the sensor's own turn and the phone's. */
    fun writtenTurn(sensorTurn: Int, displayTurn: Int, front: Boolean): Int =
      if (front) (sensorTurn + displayTurn) % 360 else (sensorTurn - displayTurn + 360) % 360

    /** Whether a finished take is sent: its file is whole, it was not called off and it lasts a second or more. */
    fun keeps(whole: Boolean, keep: Boolean, ms: Long): Boolean = whole && keep && ms >= 1000
  }
}
