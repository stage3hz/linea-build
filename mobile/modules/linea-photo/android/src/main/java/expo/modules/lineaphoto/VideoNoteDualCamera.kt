package expo.modules.lineaphoto

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.SurfaceTexture
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.net.Uri
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.util.Size
import android.view.Surface
import android.view.TextureView
import android.view.ViewGroup
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.ConcurrentCamera
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceRequest
import androidx.camera.core.UseCaseGroup
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.Promise
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

/**
 * Round video messages on phones that can stream the front and the back camera at the same time (CameraX
 * concurrent camera: Android 11+, FEATURE_CAMERA_CONCURRENT, a front+back pair listed by
 * ProcessCameraProvider.availableConcurrentCameraInfos). Both cameras run while the recorder is open and a
 * flip only changes which camera's frames are drawn — on screen and into the file — so it is instant, as on
 * iPhone (VideoNoteMultiCam.swift). VideoCapture cannot follow such a switch without a rebind, so this mode
 * records itself: each camera's Preview → its own SurfaceTexture → GL (only the shown camera is drawn) →
 * the screen (TextureView) and an H.264 MediaCodec input surface; microphone → AudioRecord → AAC MediaCodec;
 * MediaMuxer MP4 (the writer CameraX's Recorder uses too). The file is 480×640 upright (no rotation matrix),
 * the front camera mirrored as on screen (as the CameraX path records it), H.264 + AAC-LC mono 44.1 kHz.
 *
 * VideoNoteView (VideoNoteCamera.kt) uses this only where `pair()` finds such a pair; anything that fails
 * before the take really runs (binding, GL, first frames of both cameras, encoder setup, first encoded
 * frame) hands back to its single-camera CameraX path, unchanged. All public methods run on the main thread.
 */
class VideoNoteDualCamera(
  private val context: Context,
  private val owner: LifecycleOwner,
  private val provider: ProcessCameraProvider,
  pair: Pair<CameraInfo, CameraInfo>,
  private val host: Host,
  initialFacing: String,
  private var zoom: Float,
) {
  /** Main thread callbacks into VideoNoteView. */
  interface Host {
    /** Both cameras give frames and the shown one is on screen. */
    fun dualReady(facing: String)
    /** Nothing is recorded by this mode: the view goes back to its single-camera path. */
    fun dualFailed()
    /** The take could not start here: the view goes back to its single path and records there instead. */
    fun dualRecordingFailed(path: String, promise: Promise?)
  }

  companion object {
    private const val WIDTH = 480
    private const val HEIGHT = 640
    private const val EGL_RECORDABLE_ANDROID = 0x3142
    private const val SAMPLE_RATE = 44_100

    /** The front and back camera that may stream together, or null (the caller then uses its single path). */
    @OptIn(ExperimentalCamera2Interop::class)
    fun pair(context: Context, provider: ProcessCameraProvider): Pair<CameraInfo, CameraInfo>? {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
      if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_CONCURRENT)) return null
      if (hot(context)) return null
      return try {
        // Only the cameras the single path uses (the default front and back), never e.g. an ultra-wide.
        val frontId = Camera2CameraInfo.from(provider.getCameraInfo(CameraSelector.DEFAULT_FRONT_CAMERA)).cameraId
        val backId = Camera2CameraInfo.from(provider.getCameraInfo(CameraSelector.DEFAULT_BACK_CAMERA)).cameraId
        for (set in provider.availableConcurrentCameraInfos) {
          val front = set.firstOrNull { Camera2CameraInfo.from(it).cameraId == frontId } ?: continue
          val back = set.firstOrNull { Camera2CameraInfo.from(it).cameraId == backId } ?: continue
          if (front.lensFacing == CameraSelector.LENS_FACING_FRONT && back.lensFacing == CameraSelector.LENS_FACING_BACK) return front to back
        }
        null
      } catch (_: Throwable) { null }
    }

    /** Severe heat or worse (API 29+): one camera only. */
    fun hot(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
      val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
      return power.currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE
    }
  }

  // MARK: cameras

  private inner class Side(val facing: String, info: CameraInfo) {
    val selector: CameraSelector = info.cameraSelector
    /** The camera's upright turn in the phone's natural (portrait) orientation; the camera applies it. */
    val sensorRotation = info.getSensorRotationDegrees(Surface.ROTATION_0)
    // 4:3 like the single path; about 640×480 (the file is 480×640), concurrent mode allows up to 720p.
    val preview: Preview = Preview.Builder()
      .setResolutionSelector(ResolutionSelector.Builder()
        .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
        .setResolutionStrategy(ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
        .build())
      .build()
    var camera: Camera? = null // main thread
    // GL thread
    var texture = 0
    var surfaceTexture: SurfaceTexture? = null
    var size = Size(0, 0)
    var frames = 0
    val matrix = FloatArray(16)
  }

  private val front = Side("front", pair.first)
  private val back = Side("back", pair.second)
  private fun side(facing: String) = if (facing == "back") back else front

  private val main = Handler(Looper.getMainLooper())
  private val glThread = HandlerThread("VideoNoteGL").apply { start() }
  private val gl = Handler(glThread.looper)
  private val glExecutor = Executor { gl.post(it) }

  /** The on-screen picture: GL draws the shown camera into it (only one Preview per camera is bound). */
  val view = TextureView(context).apply {
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    isOpaque = false
  }

  // Main thread state.
  private var facing = if (initialFacing == "back") "back" else "front"
  private var ready = false
  private var released = false
  private var degraded = false // heat while recording: only the shown camera runs
  private var take: Take? = null
  private var finishing = 0
  private var waiter: Promise? = null
  private var orphan: Pair<String?, String?>? = null // (uri, error) of a take that ended without stop()
  private var thermalListener: Any? = null
  private val lifecycleObserver = LifecycleEventObserver { _, event ->
    // The cameras are taken away in the background: the take so far is kept (as CameraX's SOURCE_INACTIVE).
    if (event == Lifecycle.Event.ON_STOP && take != null) finishTake(null)
  }

  /** Binds both cameras and sets up GL; false (everything released) sends the caller to its single path. */
  fun open(): Boolean {
    val latch = CountDownLatch(1)
    var glOk = false
    gl.post { glOk = try { setupGl(); true } catch (_: Throwable) { false }; latch.countDown() }
    if (!latch.await(1500, TimeUnit.MILLISECONDS) || !glOk) { release(); return false }
    for (side in listOf(front, back)) side.preview.setSurfaceProvider(glExecutor) { request -> provide(side, request) }
    view.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) { gl.post { attachDisplay(texture, width, height) } }
      override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) { gl.post { displayWidth = width; displayHeight = height } }
      override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean { gl.post { detachDisplay(); texture.release() }; return false }
      override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {}
    }
    try {
      provider.unbindAll()
      val concurrent: ConcurrentCamera = provider.bindToLifecycle(listOf(
        ConcurrentCamera.SingleCameraConfig(front.selector, UseCaseGroup.Builder().addUseCase(front.preview).build(), owner),
        ConcurrentCamera.SingleCameraConfig(back.selector, UseCaseGroup.Builder().addUseCase(back.preview).build(), owner),
      ))
      val cameras = concurrent.cameras
      if (cameras.size != 2) throw IllegalStateException("concurrent cameras")
      // ConcurrentCamera keeps the order of the configs.
      front.camera = cameras[0]; back.camera = cameras[1]
    } catch (_: Throwable) {
      release(); return false
    }
    gl.post { glActive = side(facing) }
    applyZoom()
    owner.lifecycle.addObserver(lifecycleObserver)
    watchHeat()
    // Both cameras must give frames soon; otherwise the single path takes over before anything is recorded.
    main.postDelayed({ if (!ready && !released) fail() }, 3000)
    return true
  }

  /** A flip: the other camera's frames are drawn from now on — no rebind (except when degraded by heat). */
  fun setFacing(value: String) {
    val next = if (value == "back") "back" else "front"
    if (next == facing || released) return
    facing = next
    val shown = side(next)
    if (degraded && !bindSingle(shown)) return
    gl.post {
      glActive = shown
      // The new camera's latest picture at once (its texture is kept current while hidden).
      if (shown.frames > 0) try { drawDisplay(shown) } catch (_: Throwable) {}
    }
    applyZoom()
  }

  fun setZoom(value: Float) { zoom = value.coerceIn(0f, 1f); applyZoom() }
  private fun applyZoom() { try { side(facing).camera?.cameraControl?.setLinearZoom(zoom) } catch (_: Throwable) {} }

  val recording: Boolean get() = take != null

  fun startRecording(path: String, promise: Promise) {
    if (take != null || finishing > 0) { promise.reject("BUSY", "Запись уже идёт.", null); return }
    val file = File(Uri.parse(path).path ?: path)
    gl.post {
      val opened = try { openTake(file) } catch (_: Throwable) { null }
      main.post {
        if (opened == null || released) {
          opened?.let { abandon(it) }
          if (!released) host.dualRecordingFailed(path, promise)
          return@post
        }
        take = opened
        promise.resolve(null)
        // The first encoded frame must come soon; otherwise the single path records instead.
        main.postDelayed({
          if (take === opened && opened.muxer.videoSamples == 0) {
            take = null
            abandon(opened)
            host.dualRecordingFailed(path, null)
          }
        }, 2500)
      }
    }
  }

  fun setPaused(paused: Boolean) { take?.clock?.setPaused(paused) }

  fun stopRecording(promise: Promise) {
    if (take != null) { finishTake(promise); return }
    if (finishing > 0) { waiter = promise; return }
    val result = orphan ?: run { promise.reject("IDLE", "Запись не идёт.", null); return }
    orphan = null
    deliver(result, promise)
  }

  /** Everything off: both cameras, GL, encoders. A running take is finished (the file is kept). */
  fun release() {
    if (released) return
    released = true
    main.removeCallbacksAndMessages(null)
    owner.lifecycle.removeObserver(lifecycleObserver)
    unwatchHeat()
    take?.let { current ->
      take = null
      gl.post { if (glTake === current) glTake = null; closeVideo(current); Thread { current.audio?.finish(); current.muxer.finish() }.start() }
    }
    try { provider.unbindAll() } catch (_: Throwable) {}
    view.surfaceTextureListener = null
    gl.post {
      try { releaseGl() } catch (_: Throwable) {}
      glThread.quitSafely()
    }
  }

  private fun fail() {
    if (released) return
    if (take != null) { finishTake(null) }
    release()
    host.dualFailed()
  }

  /** Heat while idle: the single path (one camera); while recording: only the shown camera keeps running. */
  private fun watchHeat() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
    val listener = PowerManager.OnThermalStatusChangedListener { status ->
      if (status >= PowerManager.THERMAL_STATUS_SEVERE) main.post { degrade() }
    }
    try { power.addThermalStatusListener(ContextCompatExecutor(main), listener); thermalListener = listener } catch (_: Throwable) {}
  }

  private fun unwatchHeat() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val listener = thermalListener as? PowerManager.OnThermalStatusChangedListener ?: return
    thermalListener = null
    try { (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.removeThermalStatusListener(listener) } catch (_: Throwable) {}
  }

  private fun degrade() {
    if (released || degraded) return
    if (take == null) { fail(); return }
    degraded = true
    bindSingle(side(facing))
  }

  /** Degraded: only `shown` is bound (concurrent mode off). The encoder keeps running across the rebind. */
  private fun bindSingle(shown: Side): Boolean {
    return try {
      provider.unbindAll()
      front.camera = null; back.camera = null
      shown.camera = provider.bindToLifecycle(owner, shown.selector, shown.preview)
      true
    } catch (_: Throwable) {
      fail(); false
    }
  }

  // MARK: GL (all on the GL thread)

  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
  private var eglConfig: EGLConfig? = null
  private var idleSurface: EGLSurface = EGL14.EGL_NO_SURFACE
  private var displaySurface: EGLSurface = EGL14.EGL_NO_SURFACE
  private var displayWidth = 0
  private var displayHeight = 0
  private var displayed = false
  private var readyPosted = false
  private var program = 0
  private var aPos = 0
  private var aTex = 0
  private var uTexMatrix = 0
  private var uScale = 0
  @Volatile private var glActive: Side? = null
  private var glTake: Take? = null
  private val quad: FloatBuffer = ByteBuffer.allocateDirect(16 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
    put(floatArrayOf(-1f, -1f, 0f, 0f, 1f, -1f, 1f, 0f, -1f, 1f, 0f, 1f, 1f, 1f, 1f, 1f)); position(0)
  }

  private fun setupGl() {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    if (display == EGL14.EGL_NO_DISPLAY) throw IllegalStateException("egl display")
    val version = IntArray(2)
    if (!EGL14.eglInitialize(display, version, 0, version, 1)) throw IllegalStateException("egl init")
    // Recordable (encoder input surfaces), window (screen) and pbuffer (current while nothing is shown).
    val attributes = intArrayOf(
      EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
      EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
      EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
      EGL_RECORDABLE_ANDROID, 1, EGL14.EGL_NONE,
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val count = IntArray(1)
    if (!EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) || count[0] < 1) throw IllegalStateException("egl config")
    eglConfig = configs[0]
    eglContext = EGL14.eglCreateContext(display, eglConfig, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
    if (eglContext == EGL14.EGL_NO_CONTEXT) throw IllegalStateException("egl context")
    idleSurface = EGL14.eglCreatePbufferSurface(display, eglConfig, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
    if (idleSurface == EGL14.EGL_NO_SURFACE || !EGL14.eglMakeCurrent(display, idleSurface, idleSurface, eglContext)) throw IllegalStateException("egl current")
    program = linkProgram(
      """
      attribute vec4 aPos; attribute vec2 aTex; uniform mat4 uTexMatrix; uniform vec2 uScale; varying vec2 vTex;
      void main() { gl_Position = aPos; vec2 t = (aTex - 0.5) * uScale + 0.5; vTex = (uTexMatrix * vec4(t, 0.0, 1.0)).xy; }
      """.trimIndent(),
      """
      #extension GL_OES_EGL_image_external : require
      precision mediump float; varying vec2 vTex; uniform samplerExternalOES uTex;
      void main() { gl_FragColor = texture2D(uTex, vTex); }
      """.trimIndent(),
    )
    aPos = GLES20.glGetAttribLocation(program, "aPos")
    aTex = GLES20.glGetAttribLocation(program, "aTex")
    uTexMatrix = GLES20.glGetUniformLocation(program, "uTexMatrix")
    uScale = GLES20.glGetUniformLocation(program, "uScale")
  }

  private fun linkProgram(vertex: String, fragment: String): Int {
    fun shader(type: Int, source: String): Int {
      val id = GLES20.glCreateShader(type)
      GLES20.glShaderSource(id, source); GLES20.glCompileShader(id)
      val ok = IntArray(1); GLES20.glGetShaderiv(id, GLES20.GL_COMPILE_STATUS, ok, 0)
      if (ok[0] == 0) { GLES20.glDeleteShader(id); throw IllegalStateException("shader") }
      return id
    }
    val id = GLES20.glCreateProgram()
    GLES20.glAttachShader(id, shader(GLES20.GL_VERTEX_SHADER, vertex))
    GLES20.glAttachShader(id, shader(GLES20.GL_FRAGMENT_SHADER, fragment))
    GLES20.glLinkProgram(id)
    val ok = IntArray(1); GLES20.glGetProgramiv(id, GLES20.GL_LINK_STATUS, ok, 0)
    if (ok[0] == 0) throw IllegalStateException("program")
    return id
  }

  private fun releaseGl() {
    detachDisplay()
    for (side in listOf(front, back)) {
      side.surfaceTexture?.release(); side.surfaceTexture = null
      if (side.texture != 0) GLES20.glDeleteTextures(1, intArrayOf(side.texture), 0)
      side.texture = 0
    }
    if (display != EGL14.EGL_NO_DISPLAY) {
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      if (idleSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, idleSurface)
      if (eglContext != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, eglContext)
      EGL14.eglReleaseThread()
      EGL14.eglTerminate(display)
    }
    display = EGL14.EGL_NO_DISPLAY; eglContext = EGL14.EGL_NO_CONTEXT; idleSurface = EGL14.EGL_NO_SURFACE
  }

  private fun attachDisplay(texture: SurfaceTexture, width: Int, height: Int) {
    if (display == EGL14.EGL_NO_DISPLAY) return
    detachDisplay()
    displaySurface = EGL14.eglCreateWindowSurface(display, eglConfig, texture, intArrayOf(EGL14.EGL_NONE), 0)
    displayWidth = width; displayHeight = height
    glActive?.let { if (it.frames > 0) try { drawDisplay(it) } catch (_: Throwable) {} }
  }

  private fun detachDisplay() {
    if (displaySurface == EGL14.EGL_NO_SURFACE) return
    EGL14.eglMakeCurrent(display, idleSurface, idleSurface, eglContext)
    EGL14.eglDestroySurface(display, displaySurface)
    displaySurface = EGL14.EGL_NO_SURFACE
  }

  /** A camera's (new) output: a fresh external texture + SurfaceTexture; the previous one goes when CameraX lets go. */
  private fun provide(side: Side, request: SurfaceRequest) {
    if (display == EGL14.EGL_NO_DISPLAY) { request.willNotProvideSurface(); return }
    val ids = IntArray(1)
    GLES20.glGenTextures(1, ids, 0)
    val texture = ids[0]
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    val surfaceTexture = SurfaceTexture(texture)
    surfaceTexture.setDefaultBufferSize(request.resolution.width, request.resolution.height)
    val surface = Surface(surfaceTexture)
    // A replaced output (a degraded rebind) is released by its own request's result callback below.
    side.texture = texture; side.surfaceTexture = surfaceTexture; side.size = request.resolution; side.frames = 0
    // Upright drawing relies on the camera's own transform in the SurfaceTexture matrix (sensor turn for the
    // portrait orientation, front camera mirrored, as a TextureView shows it). Without it: the single path.
    request.setTransformationInfoListener(glExecutor) { info -> if (!info.hasCameraTransform()) main.post { if (!ready) fail() } }
    surfaceTexture.setOnFrameAvailableListener({ frame(side, surfaceTexture) }, gl)
    request.provideSurface(surface, glExecutor) {
      surface.release()
      surfaceTexture.release()
      if (display != EGL14.EGL_NO_DISPLAY) GLES20.glDeleteTextures(1, intArrayOf(texture), 0)
      if (side.surfaceTexture === surfaceTexture) { side.surfaceTexture = null; side.texture = 0 }
    }
  }

  private fun frame(side: Side, surfaceTexture: SurfaceTexture) {
    if (side.surfaceTexture !== surfaceTexture || display == EGL14.EGL_NO_DISPLAY) return
    try {
      // Every camera's frames are taken (a hidden camera would otherwise stall); only the shown one is drawn.
      surfaceTexture.updateTexImage()
      surfaceTexture.getTransformMatrix(side.matrix)
      side.frames++
      if (side === glActive) {
        drawDisplay(side)
        glTake?.let { encode(it, side) }
      }
      if (!readyPosted && displayed && front.frames > 0 && back.frames > 0) {
        readyPosted = true
        main.post { if (!released && !ready) { ready = true; host.dualReady(facing) } }
      }
    } catch (_: Throwable) {
      val broken = glTake
      glTake = null
      main.post { if (broken != null && take === broken) finishTake(null) else if (!ready) fail() }
    }
  }

  private fun draw(side: Side, width: Int, height: Int) {
    GLES20.glViewport(0, 0, width, height)
    GLES20.glUseProgram(program)
    // Aspect fill: the upright picture's centre, cropped to the target's shape.
    val turned = side.sensorRotation % 180 != 0
    val contentWidth = (if (turned) side.size.height else side.size.width).toFloat()
    val contentHeight = (if (turned) side.size.width else side.size.height).toFloat()
    val content = contentWidth / contentHeight
    val target = width.toFloat() / height
    if (content > target) GLES20.glUniform2f(uScale, target / content, 1f) else GLES20.glUniform2f(uScale, 1f, content / target)
    GLES20.glUniformMatrix4fv(uTexMatrix, 1, false, side.matrix, 0)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, side.texture)
    quad.position(0)
    GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 16, quad)
    GLES20.glEnableVertexAttribArray(aPos)
    quad.position(2)
    GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 16, quad)
    GLES20.glEnableVertexAttribArray(aTex)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
  }

  private fun drawDisplay(side: Side) {
    if (displaySurface == EGL14.EGL_NO_SURFACE || displayWidth <= 0 || displayHeight <= 0 || side.texture == 0) return
    if (!EGL14.eglMakeCurrent(display, displaySurface, displaySurface, eglContext)) return
    draw(side, displayWidth, displayHeight)
    EGL14.eglSwapBuffers(display, displaySurface)
    displayed = true
  }

  // MARK: recording

  /** Pause without a gap: paused time is taken off every later timestamp (both tracks share this clock). */
  private class NoteClock {
    @Volatile var startNs = -1L
      private set
    @Volatile var paused = false
      private set
    @Volatile private var pausedTotal = 0L
    private var pausedAt = 0L

    @Synchronized fun setPaused(value: Boolean) {
      if (value == paused) return
      val now = System.nanoTime()
      if (value) pausedAt = now else pausedTotal += now - pausedAt
      paused = value
    }
    /** The file starts with the first written video frame (audio before it is dropped). */
    @Synchronized fun begin(now: Long) { if (startNs < 0) startNs = now - pausedTotal }
    /** Nanoseconds on the file's timeline (System.nanoTime base), or -1 before the start / while paused. */
    fun position(ns: Long): Long {
      val start = startNs
      if (start < 0 || paused) return -1
      return ns - start - pausedTotal
    }
  }

  /** One MediaMuxer fed from the GL thread (video) and the audio thread; starts once both formats are known. */
  private class NoteMuxer(val file: File) {
    private val muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    private var video = -1
    private var audio = -1
    private var expectAudio = true
    private var started = false
    private var stopped = false
    private val held = ArrayList<Triple<Boolean, ByteArray, MediaCodec.BufferInfo>>()
    private var heldBytes = 0
    private var lastAudioUs = -1L
    @Volatile var videoSamples = 0
      private set

    @Synchronized fun addVideo(format: MediaFormat) {
      if (video >= 0 || started || stopped) return
      if (!format.containsKey("csd-0")) throw IllegalStateException("video config")
      video = muxer.addTrack(format)
      begin()
    }
    /** As linea-video's VideoTracks.audioFormat: only our fresh AAC config (2…64 bytes) goes in. */
    @Synchronized fun addAudio(source: MediaFormat) {
      if (audio >= 0 || started || stopped) return
      val config = if (source.containsKey("csd-0")) source.getByteBuffer("csd-0")?.duplicate() else null
      if (config == null || config.remaining() !in 2..64) { expectAudio = false; begin(); return }
      val format = MediaFormat.createAudioFormat("audio/mp4a-latm", source.getInteger(MediaFormat.KEY_SAMPLE_RATE), source.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
      format.setByteBuffer("csd-0", ByteBuffer.wrap(ByteArray(config.remaining()).also { config.get(it) }))
      for (key in listOf(MediaFormat.KEY_BIT_RATE, MediaFormat.KEY_AAC_PROFILE)) if (source.containsKey(key)) format.setInteger(key, source.getInteger(key))
      audio = muxer.addTrack(format)
      begin()
    }
    @Synchronized fun noAudio() { expectAudio = false; begin() }

    private fun begin() {
      if (started || stopped || video < 0 || (expectAudio && audio < 0)) return
      muxer.start()
      started = true
      for ((isVideo, data, info) in held) put(isVideo, ByteBuffer.wrap(data), info)
      held.clear(); heldBytes = 0
    }

    @Synchronized fun write(isVideo: Boolean, buffer: ByteBuffer, info: MediaCodec.BufferInfo) {
      if (stopped || info.size <= 0) return
      if (!started) {
        if (heldBytes + info.size > 4 * 1024 * 1024) return
        buffer.position(info.offset); buffer.limit(info.offset + info.size)
        val data = ByteArray(info.size).also { buffer.get(it) }
        held.add(Triple(isVideo, data, MediaCodec.BufferInfo().apply { set(0, data.size, info.presentationTimeUs, info.flags) }))
        heldBytes += data.size
        return
      }
      put(isVideo, buffer, info)
    }

    private fun put(isVideo: Boolean, buffer: ByteBuffer, info: MediaCodec.BufferInfo) {
      val track = if (isVideo) video else audio
      if (track < 0 || info.presentationTimeUs < 0) return
      // Audio must keep rising (video may carry reordered frames, its input times always rise).
      if (!isVideo && info.presentationTimeUs <= lastAudioUs) return
      buffer.position(info.offset); buffer.limit(info.offset + info.size)
      muxer.writeSampleData(track, buffer, info)
      if (isVideo) videoSamples++ else lastAudioUs = info.presentationTimeUs
    }

    /** True when the file holds a playable take. */
    @Synchronized fun finish(): Boolean {
      if (stopped) return false
      if (!started && video >= 0) { expectAudio = false; try { begin() } catch (_: Throwable) {} }
      stopped = true
      var ok = started && videoSamples > 0
      try { if (started) muxer.stop() } catch (_: Throwable) { ok = false }
      try { muxer.release() } catch (_: Throwable) {}
      return ok
    }
  }

  /** Microphone → AAC-LC (settings as linea-video's VideoAudio: LC profile, 16-bit PCM, bounded input size). */
  private class NoteAudio(private val clock: NoteClock, private val muxer: NoteMuxer) {
    @Volatile private var stopping = false
    private var record: AudioRecord? = null
    private var encoder: MediaCodec? = null
    private var thread: Thread? = null
    private val info = MediaCodec.BufferInfo()
    private val stamp = AudioTimestamp()
    private var nextUs = 0L

    @SuppressLint("MissingPermission") // the JS side requests the microphone first
    fun start() {
      try {
        val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) throw IllegalStateException("audio buffer")
        val recorder = AudioRecord(MediaRecorder.AudioSource.CAMCORDER, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum * 2, 16384))
        record = recorder
        if (recorder.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("audio record")
        val format = MediaFormat.createAudioFormat("audio/mp4a-latm", SAMPLE_RATE, 1).apply {
          setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
          setInteger(MediaFormat.KEY_BIT_RATE, 64_000)
          setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
        }
        val codec = MediaCodec.createEncoderByType("audio/mp4a-latm")
        encoder = codec
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
        recorder.startRecording()
        thread = Thread({ loop() }, "VideoNoteAudio").apply { start() }
      } catch (_: Throwable) {
        // Without a microphone the take is silent (as on iPhone).
        close(); muxer.noAudio()
      }
    }

    fun finish() {
      stopping = true
      try { thread?.join(3000) } catch (_: InterruptedException) {}
    }

    private fun loop() {
      val codec = encoder ?: return
      val recorder = record ?: return
      val chunk = ByteArray(4096)
      var position = 0L
      var fallbackBase = -1L
      try {
        while (!stopping) {
          val count = recorder.read(chunk, 0, chunk.size)
          if (count < 0) throw IllegalStateException("audio read")
          if (count == 0) continue
          // Capture time of the chunk's first sample on the System.nanoTime clock the video uses.
          val time = if (recorder.getTimestamp(stamp, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS) {
            stamp.nanoTime + (position - stamp.framePosition) * 1_000_000_000L / SAMPLE_RATE
          } else {
            if (fallbackBase < 0) fallbackBase = System.nanoTime() - count / 2 * 1_000_000_000L / SAMPLE_RATE
            fallbackBase + position * 1_000_000_000L / SAMPLE_RATE
          }
          position += count / 2
          drain(false)
          val at = clock.position(time)
          if (at < 0) continue
          // Rising, gap-free timestamps: never before the end of the previous chunk.
          val us = maxOf(at / 1000, nextUs)
          val index = codec.dequeueInputBuffer(20_000)
          if (index < 0) continue
          val buffer = codec.getInputBuffer(index) ?: continue
          buffer.clear()
          val size = minOf(count, buffer.remaining() / 2 * 2)
          buffer.put(chunk, 0, size)
          codec.queueInputBuffer(index, 0, size, us, 0)
          nextUs = us + (size / 2) * 1_000_000L / SAMPLE_RATE
          drain(false)
        }
        val index = codec.dequeueInputBuffer(50_000)
        if (index >= 0) codec.queueInputBuffer(index, 0, 0, nextUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        drain(true)
      } catch (_: Throwable) {
        muxer.noAudio()
      } finally {
        close()
      }
    }

    private fun drain(end: Boolean) {
      val codec = encoder ?: return
      val deadline = System.nanoTime() + 1_000_000_000L
      while (true) {
        val index = codec.dequeueOutputBuffer(info, if (end) 10_000 else 0)
        if (index == MediaCodec.INFO_TRY_AGAIN_LATER) { if (!end || System.nanoTime() > deadline) return; continue }
        if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { muxer.addAudio(codec.outputFormat); continue }
        if (index < 0) continue
        try {
          if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
            codec.getOutputBuffer(index)?.let { muxer.write(false, it, info) }
          }
        } finally { codec.releaseOutputBuffer(index, false) }
        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
      }
    }

    private fun close() {
      try { record?.stop() } catch (_: Throwable) {}
      try { record?.release() } catch (_: Throwable) {}
      record = null
      try { encoder?.stop() } catch (_: Throwable) {}
      try { encoder?.release() } catch (_: Throwable) {}
      encoder = null
    }
  }

  private class Take(val file: File, val codec: MediaCodec, val input: Surface, val surface: EGLSurface, val muxer: NoteMuxer) {
    val clock = NoteClock()
    var audio: NoteAudio? = null
    var lastVideoNs = -1L
    var closed = false
  }

  /** GL thread: H.264 encoder (480×640, 30 fps, 1.2 Mbit/s like the iPhone writer) + muxer + microphone. */
  private fun openTake(file: File): Take {
    if (display == EGL14.EGL_NO_DISPLAY) throw IllegalStateException("gl")
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, WIDTH, HEIGHT).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      setInteger(MediaFormat.KEY_BIT_RATE, 1_200_000)
      setInteger(MediaFormat.KEY_FRAME_RATE, 30)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    val name = MediaCodecList(MediaCodecList.REGULAR_CODECS).findEncoderForFormat(format) ?: throw IllegalStateException("no encoder")
    val codec = MediaCodec.createByCodecName(name)
    var input: Surface? = null
    var surface: EGLSurface = EGL14.EGL_NO_SURFACE
    try {
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      input = codec.createInputSurface()
      codec.start()
      surface = EGL14.eglCreateWindowSurface(display, eglConfig, input, intArrayOf(EGL14.EGL_NONE), 0)
      if (surface == EGL14.EGL_NO_SURFACE) throw IllegalStateException("encoder surface")
      file.parentFile?.mkdirs()
      val take = Take(file, codec, input, surface, NoteMuxer(file))
      take.audio = NoteAudio(take.clock, take.muxer).also { it.start() }
      glTake = take
      return take
    } catch (error: Throwable) {
      if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
      try { codec.stop() } catch (_: Throwable) {}
      try { codec.release() } catch (_: Throwable) {}
      input?.release()
      file.delete()
      throw error
    }
  }

  /** GL thread: the shown camera's frame into the file, timed on the shared clock (no frames while paused). */
  private fun encode(take: Take, side: Side) {
    val now = System.nanoTime()
    if (take.clock.paused) return
    take.clock.begin(now)
    val at = take.clock.position(now)
    if (at < 0 || at <= take.lastVideoNs) return
    if (!EGL14.eglMakeCurrent(display, take.surface, take.surface, eglContext)) throw IllegalStateException("encoder current")
    draw(side, WIDTH, HEIGHT)
    EGLExt.eglPresentationTimeANDROID(display, take.surface, at)
    EGL14.eglSwapBuffers(display, take.surface)
    take.lastVideoNs = at
    drainVideo(take, false)
  }

  private val videoInfo = MediaCodec.BufferInfo()

  private fun drainVideo(take: Take, end: Boolean) {
    val codec = take.codec
    val deadline = System.nanoTime() + 1_500_000_000L
    while (true) {
      val index = codec.dequeueOutputBuffer(videoInfo, if (end) 10_000 else 0)
      if (index == MediaCodec.INFO_TRY_AGAIN_LATER) { if (!end || System.nanoTime() > deadline) return; continue }
      if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { take.muxer.addVideo(codec.outputFormat); continue }
      if (index < 0) continue
      try {
        if (videoInfo.size > 0 && videoInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
          codec.getOutputBuffer(index)?.let { take.muxer.write(true, it, videoInfo) }
        }
      } finally { codec.releaseOutputBuffer(index, false) }
      if (videoInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
    }
  }

  /** GL thread: the video encoder ends its stream (drained into the muxer) and lets go of its surface. */
  private fun closeVideo(take: Take) {
    if (take.closed) return
    take.closed = true
    try { take.codec.signalEndOfInputStream(); drainVideo(take, true) } catch (_: Throwable) {}
    if (display != EGL14.EGL_NO_DISPLAY) {
      EGL14.eglMakeCurrent(display, idleSurface, idleSurface, eglContext)
      EGL14.eglDestroySurface(display, take.surface)
    }
    try { take.codec.stop() } catch (_: Throwable) {}
    try { take.codec.release() } catch (_: Throwable) {}
    take.input.release()
  }

  /** Main thread: finishes the running take; `promise` null keeps the result for the next stop(). */
  private fun finishTake(promise: Promise?) {
    val current = take ?: return
    take = null
    finishing++
    gl.post {
      if (glTake === current) glTake = null
      closeVideo(current)
      Thread {
        current.audio?.finish()
        val ok = current.muxer.finish()
        main.post {
          finishing--
          if (!ok) current.file.delete()
          val result: Pair<String?, String?> = if (ok) Uri.fromFile(current.file).toString() to null else null to "Не удалось записать видео."
          val target = promise ?: waiter.also { waiter = null }
          if (target != null) deliver(result, target) else orphan = result
        }
      }.start()
    }
  }

  private fun deliver(result: Pair<String?, String?>, promise: Promise) {
    val uri = result.first
    if (uri != null) promise.resolve(uri) else promise.reject("RECORDING", result.second ?: "Не удалось записать видео.", null)
  }

  /** Main thread: a take that never really ran is dropped with its file. */
  private fun abandon(current: Take) {
    gl.post {
      if (glTake === current) glTake = null
      closeVideo(current)
      Thread { current.audio?.finish(); current.muxer.finish(); current.file.delete() }.start()
    }
  }

  private class ContextCompatExecutor(private val handler: Handler) : Executor {
    override fun execute(command: Runnable) { handler.post(command) }
  }
}
