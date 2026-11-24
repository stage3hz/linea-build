package com.linea.messenger.intro

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Message
import android.view.TextureView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** The intro's scene on the screen: a texture the scene is drawn into with OpenGL ES 3.0 on a thread of its own
 *  (intro/IntroRenderer.kt). It draws only when told (`frame`, once per frame of the screen), so nothing is drawn
 *  while the app is away. The scene's numbers are built on that thread before the first frame; `onReady` then says
 *  the picture is there. If the phone cannot do it, `onFailed` — the caller shows the still stages instead. Being a
 *  texture in the window, it fades and is covered like any other view. */
@SuppressLint("ViewConstructor")
internal class IntroGlView(
  context: Context,
  private val count: Int,
  private val glow: Boolean,
  private val finest: Int,
) : TextureView(context), TextureView.SurfaceTextureListener, Handler.Callback {
  /** On the main thread: the first frame can be drawn; the word's ends in scene units. */
  var onReady: ((left: Double, right: Double) -> Unit)? = null
  var onFailed: (() -> Unit)? = null

  private companion object {
    const val START = 1; const val SIZE = 2; const val DRAW = 3; const val STOP = 4
  }

  private val app = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val thread = HandlerThread("intro-gl").apply { start() }
  private val handler = Handler(thread.looper, this)
  private val waiting = AtomicBoolean(false)
  @Volatile private var released = false

  // What to draw: written on the main thread, read on the drawing thread.
  @Volatile private var time = 0.0
  @Volatile private var progress = 0.0
  @Volatile private var clock = 0.0
  @Volatile private var speed = 0.0
  @Volatile private var squares = 0.0

  // The drawing thread's own.
  private var art: IntroArt? = null
  private var geometry: IntroGeometry? = null
  private var renderer: IntroRenderer? = null
  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var context3: EGLContext = EGL14.EGL_NO_CONTEXT
  private var surface: EGLSurface = EGL14.EGL_NO_SURFACE
  private var broken = false

  init {
    isOpaque = true
    surfaceTextureListener = this
  }

  /** Draw this moment (called once per frame of the screen). A frame still being drawn is not queued twice. */
  fun frame(t: Double, p: Double, clock: Double, speed: Double, squares: Double) {
    if (released) return
    time = t; progress = p; this.clock = clock; this.speed = speed; this.squares = squares
    if (waiting.compareAndSet(false, true)) handler.sendEmptyMessage(DRAW)
  }

  /** The overlay is gone: everything of the graphics chip is given back and the thread ends. */
  fun release() {
    if (released) return
    released = true
    onReady = null; onFailed = null
    handler.removeMessages(DRAW)
    handler.sendEmptyMessage(STOP)
    thread.quitSafely()
  }

  override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
    if (released) return
    handler.sendMessage(handler.obtainMessage(START, width, height, texture))
  }

  override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) {
    if (released) return
    handler.sendMessage(handler.obtainMessage(SIZE, width, height))
  }

  override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
    // The texture is going: the drawing thread lets go of it first.
    if (thread.isAlive && !released) {
      val done = CountDownLatch(1)
      if (handler.sendMessage(handler.obtainMessage(STOP, done))) {
        try { done.await(800, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) {}
      }
    }
    return true
  }

  override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {}

  // ---- The drawing thread ----

  override fun handleMessage(message: Message): Boolean {
    when (message.what) {
      START -> start(message.obj as SurfaceTexture, message.arg1, message.arg2)
      SIZE -> if (renderer != null && current()) { renderer?.resize(message.arg1, message.arg2); draw() }
      DRAW -> { waiting.set(false); draw() }
      STOP -> { stop(); (message.obj as? CountDownLatch)?.countDown() }
    }
    return true
  }

  private fun start(texture: SurfaceTexture, width: Int, height: Int) {
    stop()
    if (broken) return
    try {
      val pictures = art ?: IntroArt.make(app).also { art = it }
      val numbers = geometry ?: IntroGeometry.build(pictures, count).also { geometry = it }
      if (!egl(texture)) return fail()
      val made = IntroRenderer(pictures, numbers, glow, finest)
      if (!made.create()) { made.release(); return fail() }
      made.resize(width, height)
      renderer = made
      draw()
      val left = numbers.left.toDouble(); val right = numbers.right.toDouble()
      main.post { if (!released) onReady?.invoke(left, right) }
    } catch (_: Throwable) {
      fail()
    }
  }

  private fun fail() {
    broken = true
    stop()
    main.post { if (!released) onFailed?.invoke() }
  }

  private fun egl(texture: SurfaceTexture): Boolean {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    if (display == EGL14.EGL_NO_DISPLAY) return false
    val version = IntArray(2)
    if (!EGL14.eglInitialize(display, version, 0, version, 1)) return false
    val wanted = intArrayOf(
      EGL14.EGL_RENDERABLE_TYPE, EGLExt.EGL_OPENGL_ES3_BIT_KHR,
      EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT,
      EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
      EGL14.EGL_DEPTH_SIZE, 0, EGL14.EGL_STENCIL_SIZE, 0, EGL14.EGL_NONE,
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val found = IntArray(1)
    if (!EGL14.eglChooseConfig(display, wanted, 0, configs, 0, 1, found, 0) || found[0] < 1) return false
    val config = configs[0] ?: return false
    context3 = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE), 0)
    if (context3 == EGL14.EGL_NO_CONTEXT) return false
    surface = EGL14.eglCreateWindowSurface(display, config, texture, intArrayOf(EGL14.EGL_NONE), 0)
    if (surface == EGL14.EGL_NO_SURFACE) return false
    return current()
  }

  private fun current(): Boolean =
    surface != EGL14.EGL_NO_SURFACE && context3 != EGL14.EGL_NO_CONTEXT && EGL14.eglMakeCurrent(display, surface, surface, context3)

  private fun draw() {
    val made = renderer ?: return
    if (!current()) return
    try {
      made.draw(time, progress, clock, speed, squares)
      EGL14.eglSwapBuffers(display, surface)
    } catch (_: Throwable) {
      fail()
    }
  }

  /** Lets go of the chip's things and of the texture (the display itself is the process's and stays). */
  private fun stop() {
    try {
      if (renderer != null && current()) renderer?.release()
      renderer = null
      if (display != EGL14.EGL_NO_DISPLAY) {
        EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
        if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
        if (context3 != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context3)
        EGL14.eglReleaseThread()
      }
    } catch (_: Throwable) { /* gone anyway */ }
    surface = EGL14.EGL_NO_SURFACE; context3 = EGL14.EGL_NO_CONTEXT
  }
}
