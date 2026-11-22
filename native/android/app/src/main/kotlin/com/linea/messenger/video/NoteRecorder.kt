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
import com.linea.messenger.design.IonIcon
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
class NoteRecorder(
  private val activity: Activity, private val startAtOnce: Boolean,
  /** Record (owner's spec): when ≥ 0, the screen is the round camera of the composer's take — it covers the page
   *  above this line (px from the window's top; the composer below stays usable and shows the time, «slide to
   *  cancel», the lock and the blob). The circle is min(369, width − 24) dp, centred, its centre at 40% of the
   *  screen's height (never above the status bar); a 4 dp ring, white at 60%, fills inside its edge in the minute
   *  a take may last; a 40 dp glass button 8 dp above the composer turns the camera. The page is blurred (0.4 s in,
   *  0.25 s out); the circle comes up from below (0.5 s spring, damping 0.8). */
  private val panelTop: Int = -1,
) : Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar), TextureView.SurfaceTextureListener {
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
  /** Record: the minute is over (the composer ends the take). */
  var onLimit: (() -> Unit)? = null
  // Record: the flash (the screen for the front camera, the torch for the back one) and pinch to zoom.
  private var builder: android.hardware.camera2.CaptureRequest.Builder? = null
  private var maxZoom = 1f
  private var hasTorch = false
  private var flash = false
  private var zoom = 0f
  private var zoomBase = 0f
  private var brightnessBefore: Float? = null
  private val screenFlash = View(context).apply { setBackgroundColor(0xFFFFF6E8.toInt()); visibility = View.GONE; isClickable = false }
  private val zoomPill = TextView(context)
  private val flashButton = RoundButton({ if (flash) "flash" else "flash.off" }, true, { if (controlled) Theme.muted else Color.WHITE }, { 24f })
  private var baseMs = 0L
  private var stoppedPartMs = 0L
  private var trimStart = 0.0
  private var trimEnd = 1.0
  private var resultView: TextureView? = null
  private val controlled: Boolean get() = panelTop >= 0
  /** Record: where the take is to go when it stops (null: `onDone`). */
  private var stopped: ((File?, Long) -> Unit)? = null
  private var stoppedMs = 0L
  private val glassPaint = Paint(Paint.ANTI_ALIAS_FLAG)

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
      if (plate && controlled) {
        // Record: a 40 dp glass circle.
        paint.style = Paint.Style.FILL; paint.color = if (Theme.dark) 0x8C141518.toInt() else 0xA6F7F7F9.toInt()
        canvas.drawCircle(cx, cy, radius, paint)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = maxOf(1f, d); paint.color = if (Theme.dark) 0x1FFFFFFF else 0x14000000
        canvas.drawCircle(cx, cy, radius - paint.strokeWidth / 2, paint)
      } else if (plate) {
        paint.style = Paint.Style.FILL; paint.color = if (isPressed) 0x3DFFFFFF else 0x24FFFFFF
        canvas.drawCircle(cx, cy, radius, paint)
      } else {
        paint.style = Paint.Style.STROKE; paint.strokeWidth = 4f * d; paint.color = Color.WHITE
        canvas.drawCircle(cx, cy, radius - 2f * d, paint)
      }
      if (symbol() == "camera.flip") IonIcon.draw(canvas, "camera-reverse-outline", cx, cy, 24f * d, tint())
      else if (symbol() == "flash") IonIcon.draw(canvas, "flash-outline", cx, cy, 24f * d, tint())
      else if (symbol() == "flash.off") IonIcon.draw(canvas, "flash-off-outline", cx, cy, 24f * d, tint())
      else MediaIcons.draw(canvas, symbol(), cx, cy, symbolSize() * d, tint(), if (plate) 1.8f else 2.6f)
    }
  }

  private val closeButton = RoundButton({ "xmark" }, true, { Color.WHITE }, { 26f })
  private val recordButton = RoundButton({ if (recording) "arrow.up" else "circle.fill" }, false, { if (recording) Color.WHITE else Theme.danger }, { if (recording) 34f else 56f })
  private val flipButton = RoundButton({ "camera.flip" }, true, { if (controlled) Theme.muted else Color.WHITE }, { 28f })

  /** The dimmed page with its parts placed by hand, and the ring of the take around the circle. */
  private val root = object : ViewGroup(context) {
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    init { setWillNotDraw(false); setBackgroundColor(if (controlled) ((Theme.bg and 0xFFFFFF) or (0xB8 shl 24)) else 0xD1000000.toInt()) }

    private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
      view.measure(MeasureSpec.makeMeasureSpec(maxOf(0, width), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(maxOf(0, height), MeasureSpec.EXACTLY))
      view.layout(left, top, left + maxOf(0, width), top + maxOf(0, height))
    }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
      val width = right - left; val height = bottom - top
      if (controlled) {
        val screen = activity.window?.decorView?.height?.takeIf { it > 0 } ?: resources.displayMetrics.heightPixels
        val statusBar = rootWindowInsets?.let { if (Build.VERSION.SDK_INT >= 30) it.getInsets(android.view.WindowInsets.Type.statusBars()).top else @Suppress("DEPRECATION") it.systemWindowInsetTop } ?: 0
        val side = minOf(dp(369f), width - dp(24f))
        val circleTop = maxOf(statusBar, (screen * 0.4f - side / 2f).toInt())
        put(circle, (width - side) / 2, circleTop, side, side)
        put(problem, (width - minOf(dp(320f), width - dp(64f))) / 2, circleTop + side + dp(18f), minOf(dp(320f), width - dp(64f)), dp(64f))
        put(flipButton, dp(8f), height - dp(8f) - dp(40f), dp(40f), dp(40f))
        put(flashButton, dp(8f + 40f + 11f), height - dp(8f) - dp(40f), dp(40f), dp(40f))
        put(screenFlash, 0, 0, width, height)
        put(zoomPill, (side - dp(46f)) / 2, side - dp(24f + 9f), dp(46f), dp(18f))
        fit()
        return
      }
      val side = minOf(dp(300f), width - dp(48f), height - dp(260f)).coerceAtLeast(dp(120f))
      val circleLeft = (width - side) / 2; val circleTop = maxOf(dp(72f), (height - side) / 2 - dp(40f))
      put(circle, circleLeft, circleTop, side, side)
      put(heading, dp(24f), circleTop - dp(56f), width - dp(48f), dp(24f))
      put(problem, (width - minOf(dp(320f), width - dp(64f))) / 2, circleTop + side + dp(18f), minOf(dp(320f), width - dp(64f)), dp(64f))
      val low = rootWindowInsets?.let { if (Build.VERSION.SDK_INT >= 30) it.getInsets(android.view.WindowInsets.Type.systemBars()).bottom else @Suppress("DEPRECATION") it.systemWindowInsetBottom } ?: 0
      val line = minOf(height - low - dp(70f), circleTop + side + dp(130f))
      put(recordButton, width / 2 - dp(39f), line - dp(39f), dp(78f), dp(78f))
      put(closeButton, width / 2 - dp(39f) - dp(40f) - dp(52f), line - dp(26f), dp(52f), dp(52f))
      put(flipButton, width / 2 + dp(39f) + dp(40f), line - dp(26f), dp(52f), dp(52f))
      fit()
    }

    override fun onDraw(canvas: Canvas) {
      if (progress <= 0f) return
      if (controlled) {
        // Record: inside the circle's edge, 4 dp, white at 60%, from the top.
        ring.color = 0x99FFFFFF.toInt()
        ring.strokeWidth = 4f * d
        val inset = 4f * d
        canvas.drawArc(circle.left + inset, circle.top + inset, circle.right - inset, circle.bottom - inset, -90f, 360f * progress, false, ring)
        return
      }
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
    // The reference's error line (VideoNote.tsx): #FFB4B4, 13, centred, at most 320 wide, under the circle.
    problem.textSize = 13f
    problem.setTextColor(0xFFFFB4B4.toInt())
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
      if (controlled) {
        // Record: only the page above the composer; touches below go to the composer, which runs the take.
        setLayout(WindowManager.LayoutParams.MATCH_PARENT, maxOf(1, panelTop))
        setGravity(Gravity.TOP)
        addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN)
        clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        if (Build.VERSION.SDK_INT >= 31) { addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND); attributes = attributes.apply { blurBehindRadius = dp(24f) } }
        setWindowAnimations(0)
      }
    }
    if (controlled) {
      root.addView(screenFlash, 0)
      root.addView(flashButton)
      flashButton.contentDescription = "Вспышка"
      flashButton.setOnClickListener { flash = !flash; showFlash() }
      zoomPill.textSize = 12f
      zoomPill.typeface = Theme.weight(700)
      zoomPill.setTextColor(Color.WHITE)
      zoomPill.gravity = Gravity.CENTER
      zoomPill.background = GradientDrawable().apply { setColor(0x4D000000); cornerRadius = 10f * d }
      zoomPill.visibility = View.GONE
      circle.addView(zoomPill, FrameLayout.LayoutParams(dp(46f), dp(18f), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(24f) })
      val pinch = android.view.ScaleGestureDetector(context, object : android.view.ScaleGestureDetector.SimpleOnScaleGestureListener() {
        private var total = 1f
        override fun onScaleBegin(detector: android.view.ScaleGestureDetector): Boolean { zoomBase = zoom; total = 1f; return true }
        override fun onScale(detector: android.view.ScaleGestureDetector): Boolean {
          total *= detector.scaleFactor
          // The scale moves the zoom by 0.6 of its change, between 0 and 1.
          zoom = (zoomBase + (total - 1f) * 0.6f).coerceIn(0f, 1f)
          showZoom()
          return true
        }
      })
      circle.setOnTouchListener { _, event -> pinch.onTouchEvent(event); event.pointerCount > 1 || pinch.isInProgress }
      heading.visibility = View.GONE
      closeButton.visibility = View.GONE
      recordButton.visibility = View.GONE
      root.alpha = 0f
      root.animate().alpha(1f).setDuration(400).start()
      circle.post {
        circle.translationY = (context.resources.displayMetrics.heightPixels - circle.top).toFloat()
        circle.animate().translationY(0f).setDuration(500).setInterpolator(com.linea.messenger.voice.SpringCurve(0.8f, 500)).start()
      }
    }
    // Back calls the take off, as the cross does.
    setOnCancelListener { finish(keep = false) }
    showButtons()
    setOnShowListener { askAccess() }
  }

  private fun showButtons() {
    if (controlled) showFlash()
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
      maxZoom = if (Build.VERSION.SDK_INT >= 30) (about.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)?.upper ?: 1f) else 1f
      hasTorch = about.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
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
            builder = request
            applyRequest()
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
      val ms = SystemClock.elapsedRealtime() - startedAt + baseMs
      heading.text = FileCore.call("voiceTimeFine", listOf(ms)) as? String ?: ""
      progress = minOf(1f, ms.toFloat() / MAX_MS)
      root.invalidate()
      // Media: the two-camera recorder has no limit of its own: the minute ends here.
      if (controlled && ms >= MAX_MS) { onLimit?.invoke(); return }
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
    val target = stopped
    stopped = null
    if (taken != null) {
      if (keeps(whole, keep, ms) && taken.length() > 0) { if (target != null) target(taken, ms) else onDone?.invoke(taken) }
      else { taken.delete(); target?.invoke(null, ms) }
    } else target?.invoke(null, ms)
    if (isShowing && target == null && !controlled) dismiss()
  }

  /** Media: the two-camera take ends; the cameras are let go once its file is written. */
  private fun finishDual(both: NoteDualCamera, keep: Boolean) {
    closed = true
    main.removeCallbacks(clock)
    val ms = if (recording) SystemClock.elapsedRealtime() - startedAt else 0L
    val wasRecording = recording
    recording = false
    dualFile = null
    val target = stopped
    stopped = null
    if (!wasRecording) target?.invoke(null, ms)
    if (wasRecording) {
      dualStopping = true
      both.stopRecording { file, _ ->
        dualStopping = false
        if (file != null && keeps(true, keep, ms) && file.length() > 0) { if (target != null) main.post { target(file, ms) } else onDone?.invoke(file) }
        else { file?.delete(); if (target != null) main.post { target(null, ms) } }
        both.release()
        lifecycleOwner.registry.currentState = androidx.lifecycle.Lifecycle.State.DESTROYED
      }
    }
    if (isShowing && target == null && !controlled) dismiss()
  }

  // Record: the composer drives the take

  /** How long the take is by now. */
  val elapsedMs: Long get() = baseMs + (if (recording) SystemClock.elapsedRealtime() - startedAt else stoppedPartMs)

  /** The microphone's peak right now, 0…1 (for the blob): the single recorder's amplitude ÷ 16000. */
  fun level(): Float = try { ((recorder?.maxAmplitude ?: 0) / 16000f).coerceIn(0f, 1f) } catch (_: Exception) { 0f }

  /** Stops the take; `done` gets the file (null when called off, too short or failed) and its length. The screen
   *  stays for the preview or `close()`. */
  fun stopTake(keep: Boolean, done: (File?, Long) -> Unit) {
    if (closed) { done(null, 0); return }
    stoppedPartMs = if (recording) SystemClock.elapsedRealtime() - startedAt else 0L
    stoppedMs = elapsedMs
    flash = false
    showFlash()
    stopped = done
    finish(keep)
  }

  private var resultPlayer: android.media.MediaPlayer? = null

  /** The stopped take plays round and round in the circle; a tap pauses it. */
  fun showResult(file: File) {
    val shown = TextureView(context)
    resultView = shown
    trimStart = 0.0; trimEnd = 1.0
    circle.addView(shown, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    flipButton.animate().alpha(0f).scaleX(0.01f).scaleY(0.01f).setDuration(200).start()
    flashButton.animate().alpha(0f).scaleX(0.01f).scaleY(0.01f).setDuration(200).start()
    main.removeCallbacks(loopWatch)
    main.post(loopWatch)
    progress = 0f
    root.invalidate()
    shown.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(made: SurfaceTexture, width: Int, height: Int) {
        try {
          resultPlayer = android.media.MediaPlayer().apply {
            setDataSource(file.absolutePath)
            setSurface(Surface(made))
            isLooping = true
            setOnVideoSizeChangedListener { _, w, h -> if (w > 0 && h > 0) {
              val side = shown.width.toFloat()
              val scale = maxOf(side / w, side / h)
              val matrix = Matrix()
              matrix.setScale(w * scale / side, h * scale / side, side / 2, side / 2)
              shown.setTransform(matrix)
            } }
            prepare()
            start()
          }
        } catch (_: Exception) {}
      }
      override fun onSurfaceTextureSizeChanged(made: SurfaceTexture, width: Int, height: Int) {}
      override fun onSurfaceTextureUpdated(made: SurfaceTexture) {}
      override fun onSurfaceTextureDestroyed(made: SurfaceTexture): Boolean { try { resultPlayer?.release() } catch (_: Exception) {}; resultPlayer = null; return true }
    }
    shown.setOnClickListener { togglePlayback() }
  }

  /** The kept part plays round and round. */
  private val loopWatch = object : Runnable {
    override fun run() {
      val made = resultPlayer
      if (made != null) try {
        val total = made.duration.toDouble()
        if (total > 0 && made.isPlaying && made.currentPosition >= total * trimEnd) made.seekTo((total * trimStart).toLong(), android.media.MediaPlayer.SEEK_CLOSEST)
      } catch (_: Exception) {}
      if (resultView != null) main.postDelayed(this, 33)
    }
  }

  /** Record: the kept part changed (fractions): playing stops while a handle moves, then goes on from its start. */
  fun setTrim(start: Double, end: Double, done: Boolean) {
    trimStart = start; trimEnd = end
    val made = resultPlayer ?: return
    try {
      val total = made.duration.toDouble()
      made.pause()
      made.seekTo((total * (if (done) start else end)).toLong(), android.media.MediaPlayer.SEEK_CLOSEST)
      if (done) made.start()
    } catch (_: Exception) {}
  }

  /** Record: «record more» — the stopped take's playing ends and the camera records the next part after `afterMs`. */
  fun resume(afterMs: Long) {
    baseMs = afterMs
    stoppedPartMs = 0L
    main.removeCallbacks(loopWatch)
    try { resultPlayer?.release() } catch (_: Exception) {}
    resultPlayer = null
    resultView?.let { circle.removeView(it) }
    resultView = null
    flipButton.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(200).start()
    flashButton.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(200).start()
    // The two-camera rig was let go with the last part: the next part takes the single camera.
    dual?.let { circle.removeView(it.view) }
    dual = null
    dualTried = true
    closed = false
    ready = false
    recording = false
    startedAt = 0L
    progress = (baseMs.toFloat() / MAX_MS).coerceIn(0f, 1f)
    beginWhenReady = true
    if (preview.parent == null) circle.addView(preview, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    else if (texture != null) open()
  }

  /** The front camera's flash is the screen itself (warm white at full brightness) while recording; the back
   *  camera's is its torch. */
  private fun showFlash() {
    flashButton.contentDescription = if (flash) "Вспышка включена" else "Вспышка выключена"
    flashButton.invalidate()
    val lit = flash && front && recording
    screenFlash.visibility = if (lit) View.VISIBLE else View.GONE
    val window = activity.window
    if (lit && brightnessBefore == null) {
      brightnessBefore = window.attributes.screenBrightness
      window.attributes = window.attributes.apply { screenBrightness = 1f }
    } else if (!lit) brightnessBefore?.let { before ->
      window.attributes = window.attributes.apply { screenBrightness = before }
      brightnessBefore = null
    }
    val torch = flash && !front
    dual?.setTorch(torch)
    applyRequest()
  }

  private fun showZoom() {
    zoomPill.text = String.format(java.util.Locale.US, "%.1f", 1 + zoom * 5).replace('.', ',') + "×"
    zoomPill.visibility = if (zoom <= 0.02f) View.GONE else View.VISIBLE
    dual?.setZoom(zoom)
    applyRequest()
  }

  /** The single camera's repeating request with the torch and the zoom of now. */
  private fun applyRequest() {
    val request = builder ?: return
    val configured = session ?: return
    try {
      request.set(android.hardware.camera2.CaptureRequest.FLASH_MODE, if (flash && !front && hasTorch) android.hardware.camera2.CaptureRequest.FLASH_MODE_TORCH else android.hardware.camera2.CaptureRequest.FLASH_MODE_OFF)
      if (Build.VERSION.SDK_INT >= 30 && maxZoom > 1f) request.set(android.hardware.camera2.CaptureRequest.CONTROL_ZOOM_RATIO, 1f + zoom * (minOf(6f, maxZoom) - 1f))
      configured.setRepeatingRequest(request.build(), null, main)
    } catch (_: Exception) {}
  }

  /** Play / pause of the stopped take; true when it plays. */
  fun togglePlayback(): Boolean {
    val made = resultPlayer ?: return false
    return try { if (made.isPlaying) made.pause() else made.start(); made.isPlaying } catch (_: Exception) { false }
  }

  /** Everything goes: the page clears in 0.25 s and the screen closes. */
  fun close() {
    main.removeCallbacks(loopWatch)
    resultView = null
    if (flash) { flash = false; showFlash() }
    try { resultPlayer?.release() } catch (_: Exception) {}
    resultPlayer = null
    if (!closed) finish(keep = false)
    root.animate().alpha(0f).setDuration(250).withEndAction { if (isShowing) try { dismiss() } catch (_: Exception) {} }.start()
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
    /** Record: the parts of a round video («record more») one after another, cut to the kept part (`from`…`to`,
     *  fractions of the whole), their samples copied as they are into a new .mp4 (the cut starts at the key frame at
     *  or before `from`). A single part kept whole is handed back as it is. Off the main thread. */
    fun join(context: Context, parts: List<File>, from: Double, to: Double): File? {
      val whole = from <= 0.0005 && to >= 0.9995
      if (parts.size == 1 && whole) return parts[0]
      val durations = parts.map { part ->
        try { android.media.MediaMetadataRetriever().run { setDataSource(part.absolutePath); val ms = extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong() ?: 0L; release(); ms } } catch (_: Exception) { 0L }
      }
      val totalUs = durations.sum() * 1000
      val fromUs = (totalUs * from).toLong(); val toUs = (totalUs * to).toLong()
      val target = VideoPrepare.freshFile(context, "mp4")
      var muxer: android.media.MediaMuxer? = null
      return try {
        var videoTrack = -1; var audioTrack = -1
        var offset = 0L
        var started = false
        var startUs = -1L
        val buffer = java.nio.ByteBuffer.allocate(4 shl 20)
        val info = android.media.MediaCodec.BufferInfo()
        for ((index, part) in parts.withIndex()) {
          val extractor = android.media.MediaExtractor()
          try {
            extractor.setDataSource(part.absolutePath)
            val map = HashMap<Int, Boolean>()
            for (i in 0 until extractor.trackCount) {
              val format = extractor.getTrackFormat(i)
              val mime = format.getString(android.media.MediaFormat.KEY_MIME) ?: ""
              val video = mime.startsWith("video/")
              if (!video && !mime.startsWith("audio/")) continue
              if (muxer == null) muxer = android.media.MediaMuxer(target.absolutePath, android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
              if (!started) {
                if (video && videoTrack < 0) {
                  videoTrack = muxer!!.addTrack(format)
                  if (format.containsKey(android.media.MediaFormat.KEY_ROTATION)) muxer!!.setOrientationHint(format.getInteger(android.media.MediaFormat.KEY_ROTATION))
                }
                if (!video && audioTrack < 0) audioTrack = muxer!!.addTrack(format)
              }
              extractor.selectTrack(i)
              map[i] = video
            }
            if (!started && muxer != null) { muxer!!.start(); started = true }
            while (true) {
              val size = extractor.readSampleData(buffer, 0)
              if (size < 0) break
              val track = extractor.sampleTrackIndex
              val video = map[track]
              if (video == null) { extractor.advance(); continue }
              val whole2 = offset + extractor.sampleTime
              val key = extractor.sampleFlags and android.media.MediaExtractor.SAMPLE_FLAG_SYNC != 0
              if (startUs < 0 && video && key && whole2 <= fromUs + 1) startUs = whole2
              if (startUs >= 0 && whole2 >= startUs && whole2 <= toUs) {
                info.offset = 0; info.size = size
                info.presentationTimeUs = whole2 - startUs
                info.flags = if (key) android.media.MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
                val out = if (video) videoTrack else audioTrack
                if (out >= 0) muxer!!.writeSampleData(out, buffer, info)
              }
              extractor.advance()
            }
          } finally { extractor.release() }
          offset += durations[index] * 1000
        }
        muxer?.stop()
        if (started) target else { target.delete(); null }
      } catch (_: Exception) {
        target.delete(); null
      } finally {
        try { muxer?.release() } catch (_: Exception) {}
      }
    }

    /** Record: `count` square frames spread over the video, for the preview's strip. Off the main thread. */
    fun frames(file: File, count: Int, sidePx: Int): List<android.graphics.Bitmap> {
      val out = ArrayList<android.graphics.Bitmap>()
      val retriever = android.media.MediaMetadataRetriever()
      try {
        retriever.setDataSource(file.absolutePath)
        val ms = retriever.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong() ?: 0L
        for (i in 0 until maxOf(1, count)) {
          val at = (ms * 1000 * (i + 0.5) / maxOf(1, count)).toLong()
          val frame = (if (Build.VERSION.SDK_INT >= 27) retriever.getScaledFrameAtTime(at, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC, sidePx * 2, sidePx * 2) else retriever.getFrameAtTime(at)) ?: continue
          out.add(frame)
        }
      } catch (_: Exception) {
      } finally { try { retriever.release() } catch (_: Exception) {} }
      return out
    }

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
