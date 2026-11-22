package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.view.MotionEvent
import android.view.View
import android.widget.LinearLayout
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.shell.BarGlow
import kotlin.math.max
import kotlin.math.min

// «Свечение панели» in «Оформление»: the bottom bar's lights (look 9, shell/TabBar.kt) on or off, and the person's own
// colour for them. Kept on this device (`BarGlow`); the bar under the page follows at once. (iOS: Settings/Appearance.swift.)

/** The switch, and under it (while the lights are on) «Свой цвет»: «Переливается» or the chosen colour. */
fun SettingsPage.addBarGlowGroup(refresh: () -> Unit) {
  val on = BarGlow.on
  val glow = SettingsSwitchRow(context, "Свечение панели", "Огоньки под стеклом нижней панели: переливаются и отзываются на музыку и движение телефона", on)
  glow.onChange = { value ->
    BarGlow.on = value
    refresh()
  }
  val rows = arrayListOf<View>(glow)
  if (on) {
    val own = BarGlow.color
    val colour = SettingsRow(context, label = "Свой цвет", value = own ?: "Переливается", swatch = own?.let { ThemeLook.color(it) })
    colour.onPress = { BarGlowSheet.show(context, refresh) }
    rows.add(colour)
  }
  addGroup(rows = rows)
}

/** The colour of the bar's lights: a square of saturation and brightness, a strip of hues, the code «#RRGGBB», and
 *  «Переливается» to go back to the drift. Every colour let go of is put on (the bar shows it at once); while the finger
 *  moves the bar shows it without keeping it. In the app's sheet (ChoiceSheet). */
object BarGlowSheet {
  /** Where the picker starts without an own colour: the sketch's centre light (#ff5fb0). */
  const val START = "#FF5FB0"

  fun show(context: Context, done: () -> Unit): ChoiceSheet {
    val start = BarGlow.color ?: START
    val picker = GlowColourPicker(context, ThemeLook.color(start) ?: 0xFFFF5FB0.toInt())
    val code = SettingsField(context, "", "#RRGGBB")
    code.limit = 7
    code.allowed = { it == '#' || Character.digit(it, 16) >= 0 }
    code.value = start
    code.input.contentDescription = "Код цвета"
    picker.onMove = { color ->
      val hex = BarGlow.hex(color)
      code.value = hex
      BarGlow.tryColor(hex)
    }
    picker.onLetGo = { color -> BarGlow.color = BarGlow.hex(color) }
    code.onEdit = {
      val hex = BarGlow.normal(code.value)
      if (hex != null) {
        ThemeLook.color(hex)?.let { picker.set(it) }
        BarGlow.color = hex
      }
    }
    val drift = SettingsButton(context, "Переливается", SettingsButton.Kind.SECONDARY)
    val ready = SettingsButton(context, "Готово")
    val buttons = LinearLayout(context)
    buttons.orientation = LinearLayout.HORIZONTAL
    buttons.addView(drift, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    buttons.addView(ready, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Math.round(8f * context.resources.displayMetrics.density) })
    val sheet = ChoiceSheet(context, "Цвет свечения", "", emptyList(), listOf(picker, code, buttons), 14f)
    drift.onPress = {
      BarGlow.color = null
      sheet.dismiss()
    }
    ready.onPress = { sheet.dismiss() }
    sheet.setOnDismissListener {
      // A colour still under the finger is kept, as if let go.
      val shown = BarGlow.color
      if (shown != null) BarGlow.color = shown
      done()
    }
    sheet.show()
    return sheet
  }
}

/** A colour picked by the finger: the square (saturation across, brightness down) over the strip of hues. */
@SuppressLint("ViewConstructor")
class GlowColourPicker(context: Context, color: Int) : View(context) {
  /** The colour while the finger moves. */
  var onMove: ((Int) -> Unit)? = null
  /** The finger let go on this colour. */
  var onLetGo: ((Int) -> Unit)? = null

  private val d = resources.displayMetrics.density
  private val hsv = FloatArray(3).also { Color.colorToHSV(color, it) }
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val square = RectF()
  private val strip = RectF()
  private var whiteAcross: Shader? = null
  private var blackDown: Shader? = null
  private var rainbow: Shader? = null
  /** What the finger holds: 1 the square, 2 the strip, 0 nothing. */
  private var holding = 0

  init {
    contentDescription = "Оттенок, насыщенность и яркость"
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  /** The colour shown now. */
  val color: Int get() = Color.HSVToColor(hsv)

  /** Shows `color` (typed as a code). */
  fun set(color: Int) {
    Color.colorToHSV(color, hsv)
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), Math.round((SQUARE + GAP + STRIP) * d))
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    square.set(0f, 0f, w.toFloat(), SQUARE * d)
    strip.set(0f, (SQUARE + GAP) * d, w.toFloat(), (SQUARE + GAP + STRIP) * d)
    whiteAcross = LinearGradient(square.left, 0f, square.right, 0f, Color.WHITE, 0x00FFFFFF, Shader.TileMode.CLAMP)
    blackDown = LinearGradient(0f, square.top, 0f, square.bottom, 0x00000000, Color.BLACK, Shader.TileMode.CLAMP)
    val hues = IntArray(7) { Color.HSVToColor(floatArrayOf(it * 60f % 360f, 1f, 1f)) }
    rainbow = LinearGradient(strip.left, 0f, strip.right, 0f, hues, null, Shader.TileMode.CLAMP)
  }

  override fun onDraw(canvas: Canvas) {
    if (width <= 0) return
    val round = 14f * d
    paint.shader = null
    paint.color = Color.HSVToColor(floatArrayOf(hsv[0], 1f, 1f))
    canvas.drawRoundRect(square, round, round, paint)
    paint.shader = whiteAcross
    canvas.drawRoundRect(square, round, round, paint)
    paint.shader = blackDown
    canvas.drawRoundRect(square, round, round, paint)
    paint.shader = rainbow
    canvas.drawRoundRect(strip, strip.height() / 2, strip.height() / 2, paint)
    paint.shader = null
    thumb(canvas, square.left + hsv[1] * square.width(), square.top + (1 - hsv[2]) * square.height(), color)
    val inset = strip.height() / 2
    thumb(canvas, strip.left + inset + hsv[0] / 360f * (strip.width() - 2 * inset), strip.centerY(), Color.HSVToColor(floatArrayOf(hsv[0], 1f, 1f)))
  }

  /** A round handle in the colour it stands on, ringed in white with a faint dark edge. */
  private fun thumb(canvas: Canvas, x: Float, y: Float, fill: Int) {
    val radius = 11f * d
    paint.color = fill
    canvas.drawCircle(x, y, radius, paint)
    ring.strokeWidth = 3f * d
    ring.color = Color.WHITE
    canvas.drawCircle(x, y, radius, ring)
    ring.strokeWidth = d
    ring.color = 0x40000000
    canvas.drawCircle(x, y, radius + 1.5f * d, ring)
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        // The sheet's scroll and its pull-down leave the finger to the picker.
        parent?.requestDisallowInterceptTouchEvent(true)
        holding = if (event.y < (square.bottom + strip.top) / 2) 1 else 2
        follow(event.x, event.y)
        onMove?.invoke(color)
      }
      MotionEvent.ACTION_MOVE -> { follow(event.x, event.y); onMove?.invoke(color) }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (holding != 0) onLetGo?.invoke(color)
        holding = 0
      }
    }
    return true
  }

  private fun follow(x: Float, y: Float) {
    if (holding == 1) {
      hsv[1] = clamp((x - square.left) / max(1f, square.width()))
      hsv[2] = 1 - clamp((y - square.top) / max(1f, square.height()))
    } else if (holding == 2) {
      val inset = strip.height() / 2
      hsv[0] = min(359.9f, clamp((x - strip.left - inset) / max(1f, strip.width() - 2 * inset)) * 360f)
    }
    invalidate()
  }

  private fun clamp(value: Float): Float = min(1f, max(0f, value))

  private companion object {
    const val SQUARE = 180f
    const val GAP = 16f
    const val STRIP = 28f
  }
}
