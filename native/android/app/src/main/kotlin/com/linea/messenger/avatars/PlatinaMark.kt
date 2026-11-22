package com.linea.messenger.avatars

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.os.SystemClock
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import android.widget.TextView
import com.linea.messenger.design.Theme
import kotlin.math.cos

// Platina's marks (the reference's platina/PlatinaMark.tsx; iOS Avatars/PlatinaMark.swift): the platinum name —
// the letters a window onto moving metal —, the «PLATINA» seal that opens the showcase, and the small gem.

object PlatinaMetal {
  /** Platinum: cool white metal with a slow light passing over it. */
  val platinum = listOf("#D9DEE8", "#FFFFFF", "#AEB8CA", "#F4F6FA", "#C3CBD9", "#FFFFFF")
  val name = listOf("#C9D0DC", "#FFFFFF", "#9AA4B6", "#F3F5F9", "#C9D0DC", "#FFFFFF", "#9AA4B6")
  /** On a light theme white metal would vanish: dark polished platinum instead. */
  val nameLight = listOf("#3B4352", "#7D889C", "#262C37", "#5E687B", "#3B4352", "#8A95A8", "#262C37")
  /** The metal of the big platinum buttons (showcase, offer). */
  val button = listOf("#E9EDF3", "#FFFFFF", "#BCC5D3", "#F6F8FB")

  /** The metal's colours as ARGB numbers (the chat list's `metal`). */
  fun argb(colors: List<String>): List<Int> = colors.map { lookColor(it) }

  /** Where the sliding band stands (px offset, 0 … −1.5 × width, there and back eased) after `seconds`. */
  fun sheen(seconds: Double, duration: Double, width: Float): Float {
    val k = (seconds % (duration * 2)) / duration
    val p = if (k <= 1) k else 2 - k
    // Easing.inOut(Easing.quad) of the reference (easeInOutQuad).
    val eased = if (p < 0.5) 2 * p * p else 1 - Math.pow(-2 * p + 2, 2.0) / 2
    return (-width * 1.5f * eased).toFloat()
  }
}

/** The gem of the reference's seal and list mark (its icon set's «diamond», MIT): the outline in a unit square
 *  (M/L/Q/Z, y down), filling the whole square. */
private const val GEM_OUTLINE = "M 0.3393 0.0209 L 0.4697 0.0209 L 0.4718 0.0274 Q 0.4740 0.0316 0.3927 0.1407 Q 0.3307 0.2219 0.3190 0.2369 Q 0.3072 0.2519 0.3029 0.2519 L 0.2986 0.2519 L 0.2516 0.1407 Q 0.2046 0.0316 0.2046 0.0284 Q 0.2046 0.0252 0.2067 0.0231 Q 0.2088 0.0209 0.3393 0.0209 Z M 0.6076 0.1418 Q 0.5210 0.0274 0.5210 0.0241 Q 0.5210 0.0209 0.6589 0.0209 Q 0.7969 0.0209 0.7969 0.0241 Q 0.7969 0.0274 0.7477 0.1418 Q 0.6985 0.2561 0.6964 0.2561 Q 0.6942 0.2561 0.6076 0.1418 Z M 0.1361 0.0744 Q 0.1447 0.0680 0.1490 0.0787 Q 0.1532 0.0872 0.1949 0.1845 Q 0.2366 0.2818 0.2366 0.2839 Q 0.2388 0.2882 0.2356 0.2914 Q 0.2324 0.2946 0.1233 0.2946 Q 0.0143 0.2946 0.0100 0.2925 Q 0.0057 0.2904 0.0057 0.2872 Q 0.0057 0.2839 0.0688 0.1813 Q 0.1319 0.0787 0.1361 0.0744 Z M 0.8525 0.0744 Q 0.8589 0.0701 0.8632 0.0723 Q 0.8653 0.0744 0.9284 0.1760 Q 0.9914 0.2775 0.9936 0.2829 Q 0.9957 0.2882 0.9914 0.2914 Q 0.9872 0.2946 0.8770 0.2946 Q 0.7669 0.2946 0.7637 0.2914 Q 0.7605 0.2882 0.7627 0.2839 Q 0.7648 0.2733 0.8086 0.1738 Q 0.8525 0.0744 0.8525 0.0744 Z M 0.3713 0.2861 Q 0.3713 0.2818 0.4334 0.2006 Q 0.4954 0.1193 0.4996 0.1193 Q 0.5039 0.1193 0.5659 0.2006 Q 0.6279 0.2818 0.6279 0.2861 Q 0.6279 0.2904 0.6237 0.2925 Q 0.6194 0.2946 0.4996 0.2946 Q 0.3799 0.2946 0.3756 0.2925 Q 0.3713 0.2904 0.3713 0.2861 Z M 0.1361 0.3631 L 0.2687 0.3631 L 0.2708 0.3673 Q 0.2730 0.3695 0.3703 0.6464 Q 0.4676 0.9233 0.4761 0.9511 Q 0.4847 0.9746 0.4761 0.9767 Q 0.4697 0.9789 0.4665 0.9778 Q 0.4633 0.9767 0.2324 0.6763 Q 0.0014 0.3759 0.0004 0.3716 Q -0.0007 0.3673 0.0014 0.3652 Q 0.0036 0.3631 0.1361 0.3631 Z M 0.6536 0.3695 Q 0.6536 0.3716 0.5809 0.5780 Q 0.5082 0.7843 0.5061 0.7886 Q 0.5039 0.7907 0.4996 0.7907 Q 0.4954 0.7907 0.4932 0.7886 Q 0.4911 0.7843 0.4184 0.5780 Q 0.3457 0.3716 0.3457 0.3695 Q 0.3457 0.3673 0.3489 0.3652 Q 0.3521 0.3631 0.4986 0.3631 Q 0.6450 0.3631 0.6493 0.3652 Q 0.6536 0.3673 0.6536 0.3695 Z M 0.7284 0.3673 Q 0.7284 0.3673 0.7284 0.3673 L 0.7306 0.3631 L 0.8632 0.3631 Q 0.9808 0.3631 0.9936 0.3652 Q 1.0000 0.3652 1.0000 0.3716 Q 0.9979 0.3738 0.7691 0.6720 Q 0.5403 0.9703 0.5339 0.9746 Q 0.5232 0.9853 0.5168 0.9703 Q 0.5168 0.9661 0.6215 0.6688 Q 0.7263 0.3716 0.7284 0.3673 Z"

private val gemUnit: Path by lazy {
  val path = Path()
  val parts = GEM_OUTLINE.split(' ')
  var i = 0
  fun n(): Float = parts[i++].toFloat()
  while (i < parts.size) {
    when (parts[i++]) {
      "M" -> { val x = n(); val y = n(); path.moveTo(x, y) }
      "L" -> { val x = n(); val y = n(); path.lineTo(x, y) }
      "Q" -> { val cx = n(); val cy = n(); val x = n(); val y = n(); path.quadTo(cx, cy, x, y) }
      "Z" -> path.close()
    }
  }
  path
}
private val gemPath = Path()
private val gemMatrix = android.graphics.Matrix()

/** The small platinum gem, `size` tall and wide, centred on (cx, cy). Main thread only (one path, reused). */
fun drawGem(canvas: Canvas, cx: Float, cy: Float, size: Float, paint: Paint) {
  gemMatrix.setScale(size, size)
  gemMatrix.postTranslate(cx - size / 2, cy - size / 2)
  gemUnit.transform(gemMatrix, gemPath)
  canvas.drawPath(gemPath, paint)
}

/** A metal gradient kept while its box and colours stay (the views' shaders are made once, not on every frame). */
internal class MetalShader {
  var shader: Shader? = null
  var w = -1f; var h = -1f
  var colors: List<String>? = null

  inline fun get(w: Float, h: Float, colors: List<String>, make: () -> Shader): Shader {
    shader?.let { if (this.w == w && this.h == h && this.colors === colors) return it }
    val made = make()
    shader = made; this.w = w; this.h = h; this.colors = colors
    return made
  }
}

/** A name, in platinum when the person has Platina (PlatinaMark.tsx `PlatinaName`); otherwise ordinary text in
 *  `plainColor`. A TextView: size it, place it, give it a typeface like any other. `animated`: the light moves
 *  (profiles); false in long lists. `onDark`: the light metal also on a light theme (dark surfaces, a plate). */
@SuppressLint("AppCompatCustomView")
class PlatinaNameView(context: Context) : TextView(context) {
  private var platina = false
  private var animated = true
  private val born = SystemClock.uptimeMillis()
  private val shift = Matrix()
  private val metal = MetalShader()
  private val clock = DecorTicker.Link(this)
  private var lastShift = Float.NaN
  var onDark = false
    set(value) { field = value; refresh() }
  var plainColor: Int = Theme.text
    set(value) { field = value; refresh() }

  init {
    includeFontPadding = false
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
  }

  fun show(name: String, platina: Boolean, animated: Boolean = true) {
    this.platina = platina
    this.animated = animated
    text = name
    contentDescription = name
    refresh()
  }

  private val moving: Boolean get() = platina && animated && DecorTicker.allowed

  private fun refresh() {
    setTextColor(if (platina) 0xFFFFFFFF.toInt() else plainColor)
    paint.shader = null
    clock.want(platina && animated)
    requestLayout()
    invalidate()
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); clock.attached(true) }
  override fun onDetachedFromWindow() { clock.attached(false); super.onDetachedFromWindow() }
  override fun onVisibilityAggregated(isVisible: Boolean) { super.onVisibilityAggregated(isVisible); clock.shown(isVisible) }

  override fun onDraw(canvas: Canvas) {
    if (platina && width > 0) {
      val colors = if (onDark || Theme.dark) PlatinaMetal.name else PlatinaMetal.nameLight
      val w = width.toFloat(); val h = height.toFloat()
      val shader = metal.get(w, h, colors) { LinearGradient(0f, h * 0.3f, w * 2.5f, h * 0.7f, IntArray(colors.size) { lookColor(colors[it]) }, null, Shader.TileMode.CLAMP) }
      val offset = if (moving) PlatinaMetal.sheen((SystemClock.uptimeMillis() - born) / 1000.0, 3.6, w) else 0f
      // The letters are the window: the metal slides under them (its matrix changes only when the light moved).
      if (offset != lastShift || paint.shader !== shader) { shift.setTranslate(offset, 0f); shader.setLocalMatrix(shift); lastShift = offset }
      paint.shader = shader
    } else paint.shader = null
    super.onDraw(canvas)
  }
}

/** The «PLATINA» seal next to a name. A tap opens the showcase («вот так будешь выглядеть ты»). `small`: the mini
 *  profile's. Its size is fixed by its words (measure it with WRAP_CONTENT). */
class PlatinaSealView(context: Context, private val small: Boolean = false) : View(context) {
  private val d = resources.displayMetrics.density
  private val born = SystemClock.uptimeMillis()
  private val metal = Paint(Paint.ANTI_ALIAS_FLAG)
  private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1A1F2A.toInt() }
  private val word = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFF151922.toInt()
    typeface = Theme.weight(800)
    textSize = (if (small) 8.5f else 10.5f) * resources.displayMetrics.density
    letterSpacing = if (small) 0.12f else 0.13f
  }
  private val shader = MetalShader()
  private val clock = DecorTicker.Link(this)
  /** Instead of the showcase. */
  var onPress: (() -> Unit)? = null
  /** Whose seal it is (the showcase says «У … — Platina»). */
  var owner: Pair<String, String>? = null

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "Инвиз Platina"
    setOnClickListener { val press = onPress; if (press != null) press() else PlatinaOpen.showcase?.invoke(this, owner) }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  private val left get() = (if (small) 5f else 6f) * d
  private val right get() = (if (small) 6f else 8f) * d
  private val gap get() = (if (small) 3f else 5f) * d
  private val icon get() = (if (small) 9f else 11f) * d

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(Math.round(left + icon + gap + word.measureText("PLATINA") + right), Math.round((if (small) 18f else 22f) * d))
  }

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    scaleX = if (pressed) 0.96f else 1f; scaleY = scaleX
  }

  init { clock.want(true) }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); clock.attached(true) }
  override fun onDetachedFromWindow() { clock.attached(false); super.onDetachedFromWindow() }
  override fun onVisibilityAggregated(isVisible: Boolean) { super.onVisibilityAggregated(isVisible); clock.shown(isVisible) }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    val moving = DecorTicker.allowed
    metal.shader = shader.get(w, h, PlatinaMetal.platinum) { LinearGradient(0f, h * 0.3f, w * 2.5f, h * 0.7f, PlatinaMetal.argb(PlatinaMetal.platinum).toIntArray(), null, Shader.TileMode.CLAMP) }
    val offset = if (moving) PlatinaMetal.sheen((SystemClock.uptimeMillis() - born) / 1000.0, 4.2, w) else 0f
    val r = (if (small) 6f else 7f) * d
    // The metal slides under the still plate: the canvas moves by the offset and the plate is drawn back where it is.
    canvas.translate(offset, 0f)
    canvas.drawRoundRect(-offset, 0f, w - offset, h, r, r, metal)
    canvas.translate(-offset, 0f)
    drawGem(canvas, left + icon / 2, h / 2, icon * 0.913f, ink)
    canvas.drawText("PLATINA", left + icon + gap, h / 2 - (word.ascent() + word.descent()) / 2, word)
  }
}

/** The compact mark of list rows: a small platinum gem (PlatinaMark.tsx `PlatinaGem`). Its side is `size` + 4 dp. */
class PlatinaGemView(context: Context, val size: Float = 13f) : View(context) {
  private val d = resources.displayMetrics.density
  private val metal = Paint(Paint.ANTI_ALIAS_FLAG)
  private val shader = MetalShader()
  private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1A1F2A.toInt() }

  init { contentDescription = "Platina" }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val side = Math.round((size + 4) * d)
    setMeasuredDimension(side, side)
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    metal.shader = shader.get(w, h, PlatinaMetal.platinum) { LinearGradient(0f, 0f, w, h, PlatinaMetal.argb(PlatinaMetal.platinum).toIntArray(), null, Shader.TileMode.CLAMP) }
    canvas.drawCircle(w / 2, h / 2, minOf(w, h) / 2, metal)
    drawGem(canvas, w / 2, h / 2, size * 0.62f * 0.913f * d, ink)
  }
}

/** A platinum button of the showcase and the offer: the metal fill, dark heavy words, pressed it shrinks. */
@SuppressLint("AppCompatCustomView")
class PlatinaButton(context: Context, title: String, size: Float = 16f, private val radius: Float = 18f) : TextView(context) {
  private val metal = Paint(Paint.ANTI_ALIAS_FLAG)

  init {
    text = title
    textSize = size
    typeface = Theme.weight(800)
    setTextColor(0xFF12151C.toInt())
    gravity = android.view.Gravity.CENTER
    isClickable = true
    isFocusable = true
    contentDescription = title
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    // The reference's Pressable style: 0.96 while pressed, at once.
    scaleX = if (pressed) 0.96f else 1f; scaleY = scaleX
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    metal.shader = LinearGradient(0f, h * 0.3f, w, h * 0.7f, PlatinaMetal.button.map { lookColor(it) }.toIntArray(), null, Shader.TileMode.CLAMP)
    val r = radius * resources.displayMetrics.density
    canvas.drawRoundRect(0f, 0f, w, h, r, r, metal)
    super.onDraw(canvas)
  }
}

/** Where the seals open the showcase (platina/PlatinaShowcase.kt): (the seal, whose seal — id and name — or null). */
object PlatinaOpen {
  var showcase: ((View, Pair<String, String>?) -> Unit)? = { view, owner -> com.linea.messenger.platina.PlatinaShowcase.open(view, owner) }
}
