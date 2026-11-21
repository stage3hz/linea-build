package com.linea.messenger.chatlook

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import com.linea.messenger.design.Glass
import com.linea.messenger.design.GlassSource
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// ChatLook: small shared pieces of the chat's look (iOS: Sources/ChatLook/LookKit.swift) — the reference's
// haptics.ts, the colour helpers of design/peerLight.tsx and design/avatarTint.ts, the glass pill of glass.tsx and
// the springy press of components.tsx (Bouncy).

/** Light vibration feedback, the reference's haptics.ts word for word: never fails, does nothing where the phone
 *  has no engine for it (the system's own «Виброотклик» setting is respected). */
object Haptic {
  /** `tapFeedback`: a selection tick. */
  fun tap(view: View?) { view?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) }
  /** `impactFeedback`: a medium knock (a hold that opened something, a recording that starts). */
  fun impact(view: View?) { view?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) }
  /** `lightFeedback`: a light knock (a swipe that armed, a small action done). */
  fun light(view: View?) { view?.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }
  /** `errorFeedback`: the error pattern. */
  fun error(view: View?) {
    view?.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)
  }
}

/** Colours as the reference works them out (design/peerLight.tsx, design/avatarTint.ts). Colours are 0xRRGGBB. */
object LookColor {
  /** 0xRRGGBB with full opacity, for painting. */
  fun argb(rgb: Int, alpha: Float = 1f): Int = ((alpha.coerceIn(0f, 1f) * 255).roundToInt() shl 24) or (rgb and 0xFFFFFF)

  /** `brightTint`: lifts a dark colour until its brightest channel reaches `floor`, keeping the hue. */
  fun bright(rgb: Int, floor: Int = 190): Int {
    val r = (rgb shr 16) and 255; val g = (rgb shr 8) and 255; val b = rgb and 255
    val top = max(r, max(g, b))
    if (top >= floor) return rgb and 0xFFFFFF
    val spread = (255 - top).toDouble()
    val lift = (floor - top) / (if (spread == 0.0) 1.0 else spread)
    fun up(value: Int): Int = (value + (255 - value) * lift).roundToInt().coerceIn(0, 255)
    return (up(r) shl 16) or (up(g) shl 8) or up(b)
  }

  /** `vividTint`: a picture's average colour made into a light; null for a picture without a colour of its own. */
  fun vivid(r: Int, g: Int, b: Int): Int? {
    val rr = r / 255.0; val gg = g / 255.0; val bb = b / 255.0
    val top = max(rr, max(gg, bb)); val low = min(rr, min(gg, bb)); val l = (top + low) / 2; val d = top - low
    if (d < 0.06) return null
    val denominator = 1 - abs(2 * l - 1)
    val sat = d / (if (denominator == 0.0) 1.0 else denominator)
    val hue = when (top) {
      rr -> ((gg - bb) / d + 6) % 6 * 60
      gg -> ((bb - rr) / d + 2) * 60
      else -> ((rr - gg) / d + 4) * 60
    }
    val s = min(0.85, max(0.5, sat * 1.5)); val light = min(0.62, max(0.46, l))
    val a = s * min(light, 1 - light)
    fun part(n: Double): Int {
      val k = (n + hue / 30) % 12
      val value = 255 * (light - a * max(-1.0, min(min(k - 3, 9 - k), 1.0)))
      return value.roundToInt().coerceIn(0, 255)
    }
    return (part(0.0) shl 16) or (part(8.0) shl 8) or part(4.0)
  }

  private val known = HashMap<String, Int>()
  private val grey = HashSet<String>()

  /** `tintOf`: the colour of a person's light — the average colour of their photo when it is on this phone
   *  already (`picture`), else the colour they chose. Main thread. */
  fun tint(avatarId: String, picture: Bitmap?, chosen: Int): Int {
    if (avatarId.isEmpty()) return chosen
    known[avatarId]?.let { return it }
    if (grey.contains(avatarId)) return chosen
    val average = picture?.let { average(it) } ?: return chosen
    val color = vivid(average[0], average[1], average[2])
    if (color != null) { known[avatarId] = color; return color }
    grey.add(avatarId)
    return chosen
  }

  /** The average colour of a picture (drawn into 8 × 8 points, as the reference does on the web). */
  fun average(image: Bitmap): IntArray? = try {
    val small = Bitmap.createScaledBitmap(image, 8, 8, true)
    var r = 0; var g = 0; var b = 0
    for (y in 0 until 8) for (x in 0 until 8) { val p = small.getPixel(x, y); r += (p shr 16) and 255; g += (p shr 8) and 255; b += p and 255 }
    if (small !== image) small.recycle()
    intArrayOf(r / 64, g / 64, b / 64)
  } catch (_: Throwable) { null }

  /** `#RRGGBB` → 0xRRGGBB. */
  fun hex(text: String?): Int? {
    if (text == null || text.length != 7 || !text.startsWith("#")) return null
    return text.drop(1).toIntOrNull(16)
  }
}

/** A pill of glass (the reference's GlassSurface, material «regular»): the page behind it blurred under the
 *  theme's tint. Its children go inside; `radius` in px (a negative one: half the height). */
@SuppressLint("ViewConstructor")
open class GlassPill(context: Context, source: GlassSource?) : FrameLayout(context) {
  private val glass = Glass(this).apply { this.source = source }
  var radius = -1f
    set(value) { if (field != value) { field = value; invalidate() } }

  init { setWillNotDraw(false); clipChildren = true }

  /** The owner places the children itself (the pill only draws the glass under them). */
  var placesChildren = false

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    if (placesChildren) super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    else setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (placesChildren) super.onLayout(changed, left, top, right, bottom)
  }

  override fun onDraw(canvas: Canvas) {
    val r = if (radius < 0) height / 2f else radius
    glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), r)
  }
}

/** The springy press of the reference's `Bouncy`: down to `scale` with one spring, back with a softer one
 *  (withSpring(scaleTo, {damping: 15, stiffness: 420, mass: .6}) and back {damping: 11, stiffness: 300}). The touch
 *  is only watched: the view's own click still happens. */
object Bouncy {
  @SuppressLint("ClickableViewAccessibility")
  fun attach(control: View, scale: Float = 0.9f, target: View = control) {
    control.setOnTouchListener { _, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> press(target, scale)
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> release(target)
      }
      false
    }
  }

  fun press(target: View, scale: Float) {
    target.animate().cancel()
    target.animate().scaleX(scale).scaleY(scale).setDuration(110).setInterpolator(OvershootInterpolator(0.6f)).start()
  }

  fun release(target: View) {
    target.animate().cancel()
    target.animate().scaleX(1f).scaleY(1f).setDuration(260).setInterpolator(OvershootInterpolator(2.2f)).start()
  }
}
