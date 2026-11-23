package com.linea.messenger.effects

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.os.SystemClock
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.View
import com.linea.messenger.design.Theme
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.pow

/** Text whose words rise in one after another (the reference's `AppearingText`, effects.tsx → expokit `AnimatedText
 *  variant="reveal"`, kit/ui/text-animation.tsx; iOS Effects/AppearingText.swift): word after word every 70 ms, each fades
 *  in over 400 ms (ease-out cubic) while it rises from 0.6 of a line on a soft, critically damped settle over 720 ms. It
 *  plays again when the text changes; with the app's animations off (effects/Motion.kt) the text is simply there. */
class AppearingTextView(context: Context, size: Float, color: Int, weight: Int = 600,
                        /** How the lines stand: at the start (the default) or in the middle. */
                        private val alignment: Layout.Alignment = Layout.Alignment.ALIGN_NORMAL,
                        /** The reference's `letterSpacing` in dp (0 — none). */
                        spacing: Float = 0f,
                        /** The reference's `lineHeight` in dp (0 — the font's own). */
                        private val lineHeight: Float = 0f) : View(context) {
  private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = size * resources.displayMetrics.density; this.color = color; typeface = Theme.weight(weight)
    if (spacing != 0f) letterSpacing = spacing / size
  }
  var text: String = ""
    private set
  private var layout: StaticLayout? = null
  private var startedAt = -1L
  /** Milliseconds before the first word moves. */
  var delay = 0L

  companion object {
    const val STAGGER = 70.0
    fun easeOut(t: Double): Double = 1 - (1 - t).pow(3)
    /** A soft, critically damped settle (no overshoot). */
    fun soft(t: Double): Double = if (t >= 1) 1.0 else 1 - exp(-7 * t) * (1 + 7 * t)
  }

  /** Shows `words` (plays them in when they differ from what is shown). */
  fun show(words: String) {
    if (words == text) return
    text = words
    contentDescription = words
    layout = null
    startedAt = if (Motion.enabled && words.isNotEmpty()) -2L else -1L
    requestLayout()
    invalidate()
  }

  private fun make(width: Int): StaticLayout {
    val extra = if (lineHeight > 0f) maxOf(0f, lineHeight * resources.displayMetrics.density - paint.getFontMetrics(null)) else 0f
    return StaticLayout.Builder.obtain(text, 0, text.length, paint, maxOf(1, width)).setAlignment(alignment).setIncludePad(false)
      .setLineSpacing(extra, 1f).build()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val made = make(width - paddingLeft - paddingRight)
    layout = made
    setMeasuredDimension(width, resolveSize(made.height + paddingTop + paddingBottom, heightMeasureSpec))
  }

  override fun onDraw(canvas: Canvas) {
    val made = layout ?: make(width - paddingLeft - paddingRight).also { layout = it }
    canvas.save()
    canvas.translate(paddingLeft.toFloat(), paddingTop.toFloat())
    if (startedAt == -2L) startedAt = SystemClock.uptimeMillis() + delay
    if (startedAt < 0) { made.draw(canvas); canvas.restore(); return }
    val ms = (SystemClock.uptimeMillis() - startedAt).toDouble().coerceAtLeast(0.0)
    var index = 0
    var at = 0
    val color = paint.color
    while (at < text.length) {
      if (text[at].isWhitespace()) { at++; continue }
      var end = at
      while (end < text.length && !text[end].isWhitespace()) end++
      val line = made.getLineForOffset(at)
      val rise = (made.getLineBottom(line) - made.getLineTop(line)) * 0.6f
      val start = index * STAGGER
      val fade = easeOut(((ms - start) / 400).coerceIn(0.0, 1.0))
      val move = ((ms - start) / 720).coerceIn(0.0, 1.0)
      paint.alpha = (fade * 255).toInt()
      canvas.drawText(text, at, end, made.getPrimaryHorizontal(at), made.getLineBaseline(line) + rise * (1 - soft(move)).toFloat(), paint)
      index++
      at = end
    }
    paint.color = color
    canvas.restore()
    val total = maxOf(0, index - 1) * STAGGER + 720
    if (ms < total) postInvalidateOnAnimation() else startedAt = -1L
  }
}

/** «Инвиз» in platinum on the sign-in screen (the reference's `Wordmark`, mobile/src/auth/AuthBackdrop.tsx; iOS
 *  Auth/AuthBackdrop.swift): the letters are a window onto slowly moving metal, with a glint that passes now and then (a
 *  sweep across in 2.4 s, then 2.6 s of rest); under them a soft, deep shadow and a faint cool glow. It springs in once;
 *  with the app's animations off it is a still image. */
class WordmarkView(context: Context, size: Float = 60f) : View(context) {
  private val d = resources.displayMetrics.density
  private val dark = Theme.dark
  // Platinum: cool white metal on dark themes, dark polished metal on light ones.
  private val metal = (if (dark) intArrayOf(0xB9C1CF, 0xFFFFFF, 0x8E99AD, 0xEEF1F6, 0xB9C1CF, 0xFFFFFF, 0x8E99AD) else intArrayOf(0x2E3542, 0x7B879B, 0x1E232D, 0x5A6477, 0x2E3542, 0x8893A7, 0x1E232D)).map { it or 0xFF000000.toInt() }.toIntArray()
  /** The letters' size: 60 on the sign-in and register steps, 46 on the others (AuthScreen.tsx:318). */
  var size: Float = size
    set(value) {
      if (field == value) return
      field = value
      paint()
      requestLayout()
      invalidate()
    }
  private fun letters() = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = size * d; typeface = Theme.weight(900); letterSpacing = -0.035f; textAlign = Paint.Align.CENTER }
  private var glow = letters()
  private var shadow = letters()
  private var face = letters()

  private fun paint() {
    glow = letters().apply { color = metal[2]; setShadowLayer(size * d * 0.55f / 2, 0f, 0f, if (dark) 0x61CDDCFF else 0x40788CBE) }
    shadow = letters().apply { color = metal[2]; setShadowLayer(size * d * 0.16f / 2, 0f, size * d * 0.07f, if (dark) 0xD9000000.toInt() else 0x47141C2D) }
    face = letters()
  }
  private var entered = false
  private var born = 0L

  init {
    paint()
    setLayerType(LAYER_TYPE_SOFTWARE, null) // the soft shadows of text
    contentDescription = "Инвиз"
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), resolveSize(ceil(size * d * 1.5f).toInt(), heightMeasureSpec))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (entered) return
    entered = true
    born = SystemClock.uptimeMillis()
    // Springs in: opacity 0 → 1, scale .92 → 1.
    if (!Motion.enabled) return
    alpha = 0f; scaleX = 0.92f; scaleY = 0.92f
    animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(700).setInterpolator(android.view.animation.OvershootInterpolator(0.8f)).start()
  }

  override fun onDraw(canvas: Canvas) {
    val word = "Инвиз"
    val cx = width / 2f
    val baseline = height / 2f - (face.descent() + face.ascent()) / 2
    canvas.drawText(word, cx, baseline, glow)
    canvas.drawText(word, cx, baseline, shadow)
    // The metal sweeps across the letters (2.4 s, ease in-out cubic), rests 2.6 s, again; still at 0.35 when off.
    val wordWidth = face.measureText(word) + 2
    val travel = wordWidth * 2
    val moving = Motion.enabled
    val phase = if (!moving) 0.35f else {
      val t = ((SystemClock.uptimeMillis() - born) % 5000) / 5000f
      if (t < 0.48f) { val k = t / 0.48f; (if (k < 0.5f) 4 * k * k * k else 1 - (-2 * k + 2).pow(3) / 2) } else 1f
    }
    val left = cx - wordWidth / 2 - travel * phase
    face.shader = LinearGradient(left, baseline - size * d * 0.8f, left + wordWidth * 3, baseline + size * d * 0.2f, metal, null, Shader.TileMode.CLAMP)
    canvas.drawText(word, cx, baseline, face)
    if (moving && isShown) postInvalidateOnAnimation()
  }
}
