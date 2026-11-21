package com.linea.messenger.profile

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.ColorDrawable
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** The avatar crop maths (the reference's photo/avatarCrop.ts): the photo covers a round viewport of side `viewport`;
 *  the person pans (tx, ty: the photo centre's offset from the viewport centre) and zooms (≥ 1 on top of the «cover»
 *  scale). The result is the square of the source image under the circle, in source pixels. */
object AvatarCrop {
  const val MAX_ZOOM = 5f

  /** The scale at which the photo exactly covers the viewport (its shorter side fills it). */
  fun coverScale(width: Float, height: Float, viewport: Float): Float = viewport / min(width, height)

  /** The largest offset that still keeps the viewport covered, for the zoom. */
  fun maxOffset(width: Float, height: Float, viewport: Float, zoom: Float): Pair<Float, Float> {
    val s = coverScale(width, height, viewport) * zoom
    return max(0f, (width * s - viewport) / 2) to max(0f, (height * s - viewport) / 2)
  }

  fun clamp(width: Float, height: Float, viewport: Float, zoom: Float, tx: Float, ty: Float): Pair<Float, Float> {
    val (mx, my) = maxOffset(width, height, viewport, zoom)
    return tx.coerceIn(-mx, mx) to ty.coerceIn(-my, my)
  }

  fun rect(width: Float, height: Float, viewport: Float, zoom: Float, tx: Float, ty: Float): Rect {
    val z = zoom.coerceIn(1f, MAX_ZOOM)
    val (ox, oy) = clamp(width, height, viewport, z, tx, ty)
    val s = coverScale(width, height, viewport) * z
    val side = min(min(width, height), viewport / s)
    // The viewport centre is at (−tx, −ty) from the photo centre, in screen units.
    val x = (width / 2 - ox / s - side / 2).coerceIn(0f, width - side)
    val y = (height / 2 - oy / s - side / 2).coerceIn(0f, height - side)
    val left = Math.round(x); val top = Math.round(y); val edge = floor(side).toInt()
    return Rect(left, top, left + edge, top + edge)
  }
}

/** The avatar picker (photo/AvatarCropper.tsx; iOS Profile/AvatarCropper.swift): the chosen photo fills the screen, a
 *  round window shows exactly what the avatar will be (the rest dimmed), one finger moves the photo, two fingers zoom
 *  (up to 5×), a double tap zooms to 2.5× or back. «Готово» gives the square under the circle in the picture's pixels. */
class AvatarCropper(context: Context, private val picture: Bitmap) : Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
  var onDone: ((Rect) -> Unit)? = null
  private var zoom = 1f
  private var tx = 0f
  private var ty = 0f
  private val w = picture.width.toFloat()
  private val h = picture.height.toFloat()

  private val canvasView = object : View(context) {
    private val image = Paint(Paint.FILTER_BITMAP_FLAG)
    private val dim = Paint().apply { color = 0x9E000000.toInt() }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = 0xBFFFFFFF.toInt(); strokeWidth = 1.5f * resources.displayMetrics.density }
    override fun onDraw(canvas: Canvas) {
      val viewport = viewport
      val s = AvatarCrop.coverScale(w, h, viewport) * zoom
      val cx = width / 2f + tx; val cy = height / 2f + ty
      canvas.drawBitmap(picture, null, RectF(cx - w * s / 2, cy - h * s / 2, cx + w * s / 2, cy + h * s / 2), image)
      val hole = Path().apply { fillType = Path.FillType.EVEN_ODD; addRect(0f, 0f, width.toFloat(), height.toFloat(), Path.Direction.CW); addCircle(width / 2f, height / 2f, viewport / 2, Path.Direction.CW) }
      canvas.drawPath(hole, dim)
      canvas.drawCircle(width / 2f, height / 2f, viewport / 2, edge)
    }
  }

  private val viewport: Float get() = min(canvasView.width - 32 * context.resources.displayMetrics.density, 380 * context.resources.displayMetrics.density)

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val root = FrameLayout(context)
    root.setBackgroundColor(Color.BLACK)
    root.addView(canvasView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    val top = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
    top.addView(context.words("Фото профиля", 17f, Color.WHITE, 700))
    top.addView(context.words("Двигай и приближай фото пальцами", 13f, 0xB3FFFFFF.toInt()), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(4f) })
    root.addView(top, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = context.px(52f) })
    val cancel = context.words("Отмена", 17f, Color.WHITE).apply { isClickable = true; setPadding(context.px(8f), context.px(10f), context.px(8f), context.px(10f)); setOnClickListener { dismiss() } }
    val done = context.words("Готово", 17f, Color.WHITE, 700).apply { isClickable = true; setPadding(context.px(8f), context.px(10f), context.px(8f), context.px(10f)); setOnClickListener { finish() } }
    root.addView(cancel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply { leftMargin = context.px(24f); bottomMargin = context.px(40f) })
    root.addView(done, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply { rightMargin = context.px(24f); bottomMargin = context.px(40f) })
    setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.apply { setBackgroundDrawable(ColorDrawable(Color.BLACK)); setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT) }
    canvasView.post { canvasView.setOnTouchListener(touch) }
  }

  private fun keepCovered() {
    val (x, y) = AvatarCrop.clamp(w, h, viewport, zoom, tx, ty)
    tx = x; ty = y
    canvasView.invalidate()
  }

  private val scale = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
    override fun onScale(detector: ScaleGestureDetector): Boolean { zoom = (zoom * detector.scaleFactor).coerceIn(1f, AvatarCrop.MAX_ZOOM); keepCovered(); return true }
  })
  private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDoubleTap(e: MotionEvent): Boolean { zoom = if (zoom > 1.5f) 1f else 2.5f; keepCovered(); return true }
    override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean { tx -= distanceX; ty -= distanceY; keepCovered(); return true }
  })

  private val touch: View.OnTouchListener by lazy { View.OnTouchListener { _, event -> scale.onTouchEvent(event); gestures.onTouchEvent(event); true } }

  private fun finish() {
    val crop = AvatarCrop.rect(w, h, viewport, zoom, tx, ty)
    val done = onDone
    dismiss()
    done?.invoke(crop)
  }
}
