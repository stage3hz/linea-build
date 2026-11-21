package com.linea.messenger.attachments

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Dialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.VelocityTracker
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.design.Theme
import com.linea.messenger.people.PeopleIcons
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import kotlin.math.abs

/** A photo on the whole screen. The small picture from the message is shown at once; the real one replaces it
 *  when it has been downloaded, checked and decrypted. Pinch or double tap to zoom, swipe down, the cross or
 *  Back to close. The decrypted picture lives in memory only, for as long as this screen is open. */
class PhotoViewer(
  context: Context,
  /** The picture from the message, if it has one. */
  private val small: Bitmap?,
  /** What brings the real picture (null: `small` is all there is). */
  private val loader: AttachmentLoad?,
) : Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val main = Handler(Looper.getMainLooper())
  private val backdrop = ColorDrawable(Color.BLACK)
  private val root = FrameLayout(context)
  private val picture = Picture(context)
  private val note = TextView(context)
  private val spinner = ProgressBar(context)
  private val close = object : View(context) {
    private val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x73000000 }
    init { isClickable = true; isFocusable = true; contentDescription = "Закрыть просмотр" }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun onDraw(canvas: Canvas) {
      canvas.drawCircle(width / 2f, height / 2f, width / 2f, disc)
      PeopleIcons.draw(canvas, "cross", width / 2f, height / 2f, 20f * d, Theme.text)
    }
  }
  private var full: Bitmap? = null
  private var failed = false
  private var closed = false

  init {
    root.background = backdrop
    picture.bitmap = small
    picture.contentDescription = "Фото"
    root.addView(picture, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    note.textSize = 13f
    note.setTextColor(Theme.text)
    note.gravity = Gravity.CENTER
    root.addView(note, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
      leftMargin = dp(24f); rightMargin = dp(24f); bottomMargin = dp(24f)
    })
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = ColorStateList.valueOf(Theme.text)
    spinner.visibility = View.GONE
    // In the middle while there is nothing to look at yet, above the note otherwise.
    root.addView(spinner, if (small == null) FrameLayout.LayoutParams(dp(28f), dp(28f), Gravity.CENTER)
      else FrameLayout.LayoutParams(dp(28f), dp(28f), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(64f) })
    close.setOnClickListener { closeNow() }
    root.addView(close, FrameLayout.LayoutParams(dp(40f), dp(40f), Gravity.TOP or Gravity.END).apply { topMargin = dp(8f); rightMargin = dp(16f) })
    // The cross and the note keep clear of a cut-out and of the system's bar.
    root.setOnApplyWindowInsetsListener { _, insets ->
      @Suppress("DEPRECATION") val top = insets.systemWindowInsetTop
      @Suppress("DEPRECATION") val bottom = insets.systemWindowInsetBottom
      (close.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = top + dp(8f); close.layoutParams = it }
      (note.layoutParams as FrameLayout.LayoutParams).let { it.bottomMargin = maxOf(bottom, dp(16f)) + dp(8f); note.layoutParams = it }
      insets
    }
    setContentView(root)
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      setDimAmount(0f)
    }
    picture.onTap = { if (failed) begin() }
    picture.onDrag = { part ->
      backdrop.alpha = ((1f - part * 0.7f) * 255).toInt()
      close.alpha = 1f - part
      note.alpha = 1f - part
    }
    picture.onAway = { closeNow() }
    // Back and the cross both end the download.
    setOnDismissListener { closed = true; loader?.cancel() }
    setOnShowListener { begin() }
  }

  private fun say(words: String) { note.text = words }

  /** Asks for the real picture. */
  private fun begin() {
    val load = loader ?: return
    failed = false
    say("")
    spinner.visibility = View.VISIBLE
    load.onProgress = { words -> say(words) }
    load.start { result ->
      val data = result.getOrNull()
      if (data == null) {
        spinner.visibility = View.GONE
        failed = true
        say(FileCore.words(result) + "\nОшибка · нажми, чтобы повторить")
        return@start
      }
      // A big picture takes a moment to decode: not on the main thread.
      decoding.execute {
        val image = decode(data)
        main.post {
          if (closed) return@post
          spinner.visibility = View.GONE
          if (image != null) {
            full = image
            picture.bitmap = image
            say("")
          } else {
            say("Устройство не смогло показать изображение.")
          }
        }
      }
    }
  }

  private fun closeNow() {
    loader?.cancel()
    dismiss()
  }

  /** The picture itself: fitted into the screen, zoomed by a pinch or a double tap (up to four times), moved
   *  by a finger while zoomed, and dragged down to be closed while it is not. */
  @SuppressLint("ClickableViewAccessibility")
  private class Picture(context: Context) : View(context) {
    var bitmap: Bitmap? = null
      set(value) { field = value; zoom = 1f; panX = 0f; panY = 0f; invalidate() }
    /** A single tap. */
    var onTap: () -> Unit = {}
    /** The picture is being dragged down: 0…1 of the way. */
    var onDrag: (Float) -> Unit = {}
    /** It was dragged far or fast enough: the viewer closes. */
    var onAway: () -> Unit = {}

    private val d = resources.displayMetrics.density
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val matrix = Matrix()
    private var zoom = 1f
    private var panX = 0f
    private var panY = 0f
    private var dragY = 0f
    private var dragging = false
    /** This touch began as something else than a drag down (a pinch, a sideways move). */
    private var notDrag = false
    private var settle: ValueAnimator? = null
    private var speed: VelocityTracker? = null

    private val zoomed: Boolean get() = zoom > 1.01f

    /** How far the picture can be moved from the middle at this zoom. */
    private fun clamp() {
      val image = bitmap ?: return
      val base = minOf(width.toFloat() / image.width, height.toFloat() / image.height)
      val maxX = maxOf(0f, (image.width * base * zoom - width) / 2); val maxY = maxOf(0f, (image.height * base * zoom - height) / 2)
      panX = panX.coerceIn(-maxX, maxX); panY = panY.coerceIn(-maxY, maxY)
    }

    /** Zooms to `next` keeping the point (x, y) of the screen where it is. */
    private fun zoomTo(next: Float, x: Float, y: Float) {
      val to = next.coerceIn(1f, 4f); val ratio = to / zoom
      val cx = width / 2f; val cy = height / 2f
      panX = (x - cx) - (x - cx - panX) * ratio; panY = (y - cy) - (y - cy - panY) * ratio
      zoom = to
      clamp()
      invalidate()
    }

    private fun animateZoom(to: Float, x: Float, y: Float) {
      settle?.cancel()
      settle = ValueAnimator.ofFloat(zoom, to).apply {
        duration = 220
        addUpdateListener { zoomTo(it.animatedValue as Float, x, y) }
        start()
      }
    }

    private val pinch = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
      override fun onScaleBegin(detector: ScaleGestureDetector): Boolean { notDrag = true; return true }
      override fun onScale(detector: ScaleGestureDetector): Boolean { zoomTo(zoom * detector.scaleFactor, detector.focusX, detector.focusY); return true }
    })

    private val taps = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(event: MotionEvent): Boolean = true
      override fun onSingleTapConfirmed(event: MotionEvent): Boolean { onTap(); return true }
      override fun onDoubleTap(event: MotionEvent): Boolean { animateZoom(if (zoomed) 1f else 2.5f, event.x, event.y); return true }
      override fun onScroll(first: MotionEvent?, now: MotionEvent, dx: Float, dy: Float): Boolean {
        if (zoomed) { panX -= dx; panY -= dy; clamp(); invalidate(); return true }
        if (first == null || notDrag) return false
        val moveX = now.x - first.x; val moveY = now.y - first.y
        // Only a mostly vertical, downward move over a picture that is not zoomed in.
        if (!dragging) { if (moveY > 0 && abs(moveY) > abs(moveX) * 1.5f) dragging = true else { notDrag = true; return false } }
        dragY = maxOf(0f, moveY)
        onDrag(minOf(1f, dragY / maxOf(1f, height * 0.5f)))
        invalidate()
        return true
      }
    })

    override fun onTouchEvent(event: MotionEvent): Boolean {
      if (event.actionMasked == MotionEvent.ACTION_DOWN) { notDrag = false; settle?.cancel(); speed?.recycle(); speed = VelocityTracker.obtain() }
      speed?.addMovement(event)
      pinch.onTouchEvent(event)
      taps.onTouchEvent(event)
      if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
        if (dragging) {
          dragging = false
          speed?.computeCurrentVelocity(1000)
          val away = event.actionMasked == MotionEvent.ACTION_UP && (dragY > height * 0.18f || (speed?.yVelocity ?: 0f) > 900f * d)
          if (away) leave() else back()
        }
        speed?.recycle(); speed = null
      }
      return true
    }

    private fun leave() {
      settle?.cancel()
      settle = ValueAnimator.ofFloat(dragY, height.toFloat()).apply {
        duration = 200
        addUpdateListener { dragY = it.animatedValue as Float; onDrag(minOf(1f, dragY / maxOf(1f, height * 0.5f))); invalidate() }
        addListener(object : android.animation.AnimatorListenerAdapter() { override fun onAnimationEnd(animation: android.animation.Animator) = onAway() })
        start()
      }
    }

    private fun back() {
      settle?.cancel()
      settle = ValueAnimator.ofFloat(dragY, 0f).apply {
        duration = 250
        addUpdateListener { dragY = it.animatedValue as Float; onDrag(minOf(1f, dragY / maxOf(1f, height * 0.5f))); invalidate() }
        start()
      }
    }

    override fun onDraw(canvas: Canvas) {
      val image = bitmap ?: return
      if (image.isRecycled || width == 0 || height == 0) return
      val scale = minOf(width.toFloat() / image.width, height.toFloat() / image.height) * zoom
      matrix.reset()
      matrix.setScale(scale, scale)
      matrix.postTranslate((width - image.width * scale) / 2 + panX, (height - image.height * scale) / 2 + panY + dragY)
      canvas.drawBitmap(image, matrix, paint)
    }
  }

  companion object {
    private val decoding = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.picture").apply { isDaemon = true } }
    /** The longest side a picture is shown at: what every phone's drawing can take in one piece. */
    private const val MAX_SIDE = 4096

    /** The size a picture of this size is decoded at for the screen. */
    fun shownSize(width: Int, height: Int): Pair<Int, Int> {
      val longest = maxOf(width, height)
      if (longest <= MAX_SIDE) return Pair(width, height)
      val scale = MAX_SIDE.toDouble() / longest
      return Pair(maxOf(1, (width * scale).toInt()), maxOf(1, (height * scale).toInt()))
    }

    /** The picture of decrypted bytes, upright, no bigger than the screen can draw; null when it is not one. */
    fun decode(data: ByteArray): Bitmap? = try {
      if (Build.VERSION.SDK_INT >= 28) NewDecoder.decode(data) else {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_SIDE) sample *= 2
        BitmapFactory.decodeByteArray(data, 0, data.size, BitmapFactory.Options().apply { inSampleSize = sample })
      }
    } catch (_: Throwable) { null }
  }

  @TargetApi(28)
  private object NewDecoder {
    fun decode(data: ByteArray): Bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(data))) { decoder, info, _ ->
      val size = shownSize(info.size.width, info.size.height)
      decoder.setTargetSize(size.first, size.second)
    }
  }
}
