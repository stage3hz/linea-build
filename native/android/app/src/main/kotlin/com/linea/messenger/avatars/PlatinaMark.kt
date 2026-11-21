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
    val eased = -(cos(Math.PI * p) - 1) / 2
    return (-width * 1.5f * eased).toFloat()
  }
}

/** The small platinum diamond (SF's diamond.fill, as a rhombus). */
fun drawGem(canvas: Canvas, cx: Float, cy: Float, size: Float, paint: Paint) {
  val path = Path()
  path.moveTo(cx, cy - size / 2); path.lineTo(cx + size * 0.42f, cy); path.lineTo(cx, cy + size / 2); path.lineTo(cx - size * 0.42f, cy); path.close()
  canvas.drawPath(path, paint)
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

  private val moving: Boolean get() = platina && animated && AvatarMotion.enabled(context)

  private fun refresh() {
    setTextColor(if (platina) 0xFFFFFFFF.toInt() else plainColor)
    paint.shader = null
    requestLayout()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    if (platina && width > 0) {
      val colors = if (onDark || Theme.dark) PlatinaMetal.name else PlatinaMetal.nameLight
      val wide = width * 2.5f
      val shader = LinearGradient(0f, height * 0.3f, wide, height * 0.7f, colors.map { lookColor(it) }.toIntArray(), null, Shader.TileMode.CLAMP)
      shift.setTranslate(if (moving) PlatinaMetal.sheen((SystemClock.uptimeMillis() - born) / 1000.0, 3.6, width.toFloat()) else 0f, 0f)
      shader.setLocalMatrix(shift)
      paint.shader = shader
    } else paint.shader = null
    super.onDraw(canvas)
    if (moving && isShown) postInvalidateOnAnimation()
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
  private val shift = Matrix()
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

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    val moving = AvatarMotion.enabled(context)
    val shader = LinearGradient(0f, h * 0.3f, w * 2.5f, h * 0.7f, PlatinaMetal.platinum.map { lookColor(it) }.toIntArray(), null, Shader.TileMode.CLAMP)
    shift.setTranslate(if (moving) PlatinaMetal.sheen((SystemClock.uptimeMillis() - born) / 1000.0, 4.2, w) else 0f, 0f)
    shader.setLocalMatrix(shift)
    metal.shader = shader
    val r = (if (small) 6f else 7f) * d
    canvas.drawRoundRect(0f, 0f, w, h, r, r, metal)
    drawGem(canvas, left + icon / 2, h / 2, icon * 0.9f, ink)
    canvas.drawText("PLATINA", left + icon + gap, h / 2 - (word.ascent() + word.descent()) / 2, word)
    if (moving && isShown) postInvalidateOnAnimation()
  }
}

/** The compact mark of list rows: a small platinum gem (PlatinaMark.tsx `PlatinaGem`). Its side is `size` + 4 dp. */
class PlatinaGemView(context: Context, val size: Float = 13f) : View(context) {
  private val d = resources.displayMetrics.density
  private val metal = Paint(Paint.ANTI_ALIAS_FLAG)
  private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1A1F2A.toInt() }

  init { contentDescription = "Platina" }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val side = Math.round((size + 4) * d)
    setMeasuredDimension(side, side)
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    metal.shader = LinearGradient(0f, 0f, w, h, PlatinaMetal.platinum.map { lookColor(it) }.toIntArray(), null, Shader.TileMode.CLAMP)
    canvas.drawCircle(w / 2, h / 2, minOf(w, h) / 2, metal)
    drawGem(canvas, w / 2, h / 2, size * 0.55f * d * 1.2f, ink)
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
    animate().scaleX(if (pressed) 0.96f else 1f).scaleY(if (pressed) 0.96f else 1f).setDuration(120).start()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    metal.shader = LinearGradient(0f, h * 0.3f, w, h * 0.7f, PlatinaMetal.button.map { lookColor(it) }.toIntArray(), null, Shader.TileMode.CLAMP)
    val r = radius * resources.displayMetrics.density
    canvas.drawRoundRect(0f, 0f, w, h, r, r, metal)
    super.onDraw(canvas)
  }
}

/** Where the seals open the showcase (set by platina/PlatinaShowcase.kt, so the marks know nothing of the screen):
 *  (the seal, whose seal — id and name — or null). */
object PlatinaOpen {
  var showcase: ((View, Pair<String, String>?) -> Unit)? = null
}
