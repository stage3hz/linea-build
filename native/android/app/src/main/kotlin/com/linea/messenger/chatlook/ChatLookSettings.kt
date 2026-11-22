package com.linea.messenger.chatlook

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.SeekBar
import com.linea.messenger.core.Core
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.settings.ColorChoiceButton
import com.linea.messenger.settings.DevicePreferences
import com.linea.messenger.settings.SettingsLook
import com.linea.messenger.settings.SettingsPage
import com.linea.messenger.settings.SettingsRow
import com.linea.messenger.settings.SettingsSwitchRow
import com.linea.messenger.settings.ThemeLook
import com.linea.messenger.settings.ThemeStore
import kotlin.math.roundToInt

/** What «Оформление» gets from ChatLook (iOS: Sources/ChatLook/ChatLookSettings.swift; the reference's
 *  SettingsScreen.tsx: «Свои цвета» › «Цвет своих сообщений», «Обои чатов», «Углы сообщений»), and «Пузыри
 *  сообщений» — the owner's default is the open look without bubbles; bubbles are a choice here (and come by
 *  themselves with a wallpaper, as in the reference). */
object ChatLookSettings {
  /** The row for the «Свои цвета» group. */
  fun colourRow(page: SettingsPage): SettingsRow {
    val own = DevicePreferences.word("bubbleColor")
    val row = SettingsRow(page.context, label = "Цвет своих сообщений", value = if (own == null) "Как в теме" else "Свой", swatch = ChatBubbleLook.palette(true).mine)
    row.onPress = { page.open(BubbleColorPage(page.context)) }
    return row
  }

  /** «Обои чатов», «Пузыри сообщений», «Углы сообщений». `refill`: the page draws itself again. */
  fun addGroups(page: SettingsPage, refill: () -> Unit) {
    val context = page.context
    val paper = SettingsRow(context, symbol = "photo", label = "Обои чатов", value = "Выбрать")
    paper.onPress = { WallpaperPicker(context, null).show() }
    page.addGroup("Обои чатов", listOf(paper))

    val bubbles = SettingsSwitchRow(context, "Пузыри сообщений", "Свои и чужие сообщения на цветных плашках. С обоями они есть всегда.", ChatBubbleLook.bubblesChosen)
    bubbles.onChange = { value -> ChatBubbleLook.bubblesChosen = value; refill() }
    val corners = CornerChoice(context, ChatBubbleLook.chosenRadius)
    corners.onPick = { radius -> DevicePreferences.set(mapOf("bubbleRadius" to radius.toDouble())); refill() }
    page.addGroup("Углы сообщений", listOf(bubbles, SettingsLook.inset(corners, top = 12f, side = 14f, bottom = 14f)))
  }
}

/** «Углы сообщений»: «Острые», «Средние», «Круглые», each with a small bubble drawn with its corners. */
@SuppressLint("ViewConstructor")
class CornerChoice(context: Context, chosen: Float) : LinearLayout(context) {
  var onPick: ((Float) -> Unit)? = null
  private val choices = listOf(8f to "Острые", 14f to "Средние", 20f to "Круглые")

  init {
    orientation = HORIZONTAL
    val bubble = ChatBubbleLook.palette(true).mine
    choices.forEachIndexed { index, choice ->
      val selected = choice.first == chosen
      val button = LinearLayout(context)
      button.orientation = VERTICAL
      button.gravity = Gravity.CENTER_HORIZONTAL
      button.background = context.plate(if (selected) ThemeStore.look.accentSoft else Theme.surface2, 15f, if (selected) Theme.accent else ThemeStore.look.border)
      button.setPadding(0, context.px(10f), 0, context.px(10f))
      button.isClickable = true; button.isFocusable = true; button.isSelected = selected
      button.contentDescription = choice.second
      button.addView(CornerSample(context, choice.first, bubble), LayoutParams(context.px(46f), context.px(22f)))
      button.addView(context.words(choice.second, 12f, if (selected) Theme.accent else Theme.text, 600), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(8f) })
      button.setOnClickListener { Haptic.tap(button); onPick?.invoke(choice.first) }
      addView(button, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = if (index == 0) 0 else context.px(7f) })
    }
  }
}

/** A small bubble with given corners (the lower right one 6 at most, as on one's own last message). */
@SuppressLint("ViewConstructor")
private class CornerSample(context: Context, private val radius: Float, color: Int) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
  private val path = Path()
  override fun onDraw(canvas: Canvas) {
    ChatBubbleLook.shape(path, RectF(0f, 0f, width.toFloat(), height.toFloat()), mine = true, tail = true, d = resources.displayMetrics.density, radiusDp = radius)
    canvas.drawPath(path, paint)
  }
}

/** «Цвет своих сообщений» (the reference's ColorSettings.tsx, part «bubble»): how it looks in a chat, the offered
 *  colours, «Как в теме», «Свой цвет» with three sliders. It is seen in chats with bubbles. */
class BubbleColorPage(context: Context) : SettingsPage(context, "Цвет своих сообщений") {
  private val hue = SeekBar(context)
  private val saturation = SeekBar(context)
  private val brightness = SeekBar(context)
  private val code = context.words("", 12f, Theme.muted)

  private class Span(val low: Double, val high: Double) {
    fun value(bar: SeekBar): Double = low + (high - low) * bar.progress / STEPS
    fun place(value: Double): Int = ((value.coerceIn(low, high) - low) / (high - low) * STEPS).roundToInt()
  }

  override fun build() { fill() }

  private val choices: List<String> get() = ThemeStore.words("bubbleChoices")
  private val base: String get() = DevicePreferences.word("bubbleColor") ?: choices.firstOrNull() ?: "#2B4A8C"

  private fun set(color: String?) {
    DevicePreferences.set(mapOf("bubbleColor" to color))
    Wallpapers.changed.post(Unit)
    fill()
  }

  private fun fill() {
    clear()
    val current = DevicePreferences.word("bubbleColor")
    val palette = ChatBubbleLook.palette(true)
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT

    // How it looks in a chat, in the colours that are on right now.
    val sample = LinearLayout(context)
    sample.orientation = LinearLayout.VERTICAL
    sample.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    sample.addView(plate("Как тебе новый цвет?", false, palette.theirs, null, 0), LinearLayout.LayoutParams(wide, wrap))
    sample.addView(plate("Нравится, оставляю", true, palette.mine, "ссылка · 12:30 ✓✓", palette.mineMark), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(6f) })

    val rowsOfColours = LinearLayout(context)
    rowsOfColours.orientation = LinearLayout.VERTICAL
    var line = LinearLayout(context)
    choices.forEachIndexed { index, color ->
      if (index % 6 == 0) {
        line = LinearLayout(context)
        line.orientation = LinearLayout.HORIZONTAL
        rowsOfColours.addView(line, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = if (index == 0) 0 else dp(10f) })
      }
      val on = current == color
      val ball = FrameLayout(context)
      ball.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(ThemeLook.color(color) ?: 0xFF808080.toInt()); if (on) setStroke(dp(3f), Theme.text) }
      if (on) ball.addView(SymbolView(context, "check", 16f, 0xFFFFFFFF.toInt()), FrameLayout.LayoutParams(dp(16f), dp(16f), Gravity.CENTER))
      ball.isClickable = true; ball.isFocusable = true; ball.isSelected = on
      ball.contentDescription = "Цвет $color"
      ball.setOnClickListener { custom = false; set(color) }
      val place = FrameLayout(context)
      place.addView(ball, FrameLayout.LayoutParams(dp(40f), dp(40f), Gravity.CENTER))
      line.addView(place, LinearLayout.LayoutParams(0, wrap, 1f))
    }

    val asTheme = ColorChoiceButton(context, "Как в теме", current == null)
    asTheme.onPress = { custom = false; set(null) }
    val ownColour = ColorChoiceButton(context, "Свой цвет", custom)
    ownColour.onPress = { toggleCustom() }
    val buttons = LinearLayout(context)
    buttons.orientation = LinearLayout.HORIZONTAL
    buttons.addView(asTheme, LinearLayout.LayoutParams(0, wrap, 1f))
    buttons.addView(ownColour, LinearLayout.LayoutParams(0, wrap, 1f).apply { leftMargin = dp(8f) })

    val box = LinearLayout(context)
    box.orientation = LinearLayout.VERTICAL
    box.addView(sample, LinearLayout.LayoutParams(wide, wrap))
    box.addView(rowsOfColours, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f) })
    box.addView(buttons, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f) })
    if (custom) {
      val position = sliders ?: hsv(base)
      val named = listOf(Triple("Оттенок", hue, hueSpan) to position[0], Triple("Насыщенность", saturation, saturationSpan) to position[1], Triple("Яркость", brightness, brightnessSpan) to position[2])
      for ((part, value) in named) {
        val (name, slider, span) = part
        slider.setOnSeekBarChangeListener(null)
        slider.max = STEPS
        slider.progress = span.place(value)
        slider.progressTintList = ColorStateList.valueOf(Theme.accent)
        slider.thumbTintList = ColorStateList.valueOf(Theme.accent)
        slider.contentDescription = name
        slider.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
          override fun onProgressChanged(bar: SeekBar?, progress: Int, fromUser: Boolean) { if (fromUser) moved() }
          override fun onStartTrackingTouch(bar: SeekBar?) {}
          override fun onStopTrackingTouch(bar: SeekBar?) { released() }
        })
        (slider.parent as? ViewGroup)?.removeView(slider)
        box.addView(context.words(name, 12f, Theme.muted), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f) })
        box.addView(slider, LinearLayout.LayoutParams(wide, dp(36f)).apply { topMargin = dp(2f) })
      }
      (code.parent as? ViewGroup)?.removeView(code)
      code.text = current ?: base
      code.typeface = Typeface.MONOSPACE
      code.gravity = Gravity.CENTER
      box.addView(code, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f) })
    }
    addGroup(rows = listOf(SettingsLook.inset(box, top = 16f, side = 16f, bottom = 16f)))
    add(SettingsLook.foot(context, "Цвет действует поверх любой темы. Если он плохо читается на её фоне, приложение слегка сдвигает его, чтобы текст оставался разборчивым."), 10f)
    if (!ChatBubbleLook.bubblesChosen) add(SettingsLook.foot(context, "Цвет виден в чатах с пузырями: включи «Пузыри сообщений» или выбери обои."), 6f)
  }

  private fun plate(text: String, mine: Boolean, fill: Int, foot: String?, footColor: Int): View {
    val row = FrameLayout(context)
    val box = LinearLayout(context)
    box.orientation = LinearLayout.VERTICAL
    box.setPadding(dp(13f), dp(8f), dp(13f), dp(8f))
    box.background = context.plate(fill, 18f)
    box.addView(context.words(text, 15f, Theme.text))
    if (foot != null) box.addView(context.words(foot, 13f, footColor), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2f) })
    row.addView(box, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, if (mine) Gravity.END else Gravity.START))
    return row
  }

  private fun hsv(color: String): List<Double> {
    val read = Core.map(Core.view("settingsColorHsv", listOf(color)) as? Map<*, *>) ?: emptyMap()
    return listOf("h", "s", "v").map { (read[it] as? Number)?.toDouble() ?: 0.0 }
  }

  private fun placeOfSliders(): List<Double> = listOf(hueSpan.value(hue), saturationSpan.value(saturation), brightnessSpan.value(brightness))
  private fun colourOfSliders(): String? = Core.view("settingsHsvColor", placeOfSliders()) as? String

  private fun toggleCustom() {
    sliders = hsv(base)
    custom = !custom
    if (custom && DevicePreferences.word("bubbleColor") == null) set(base) else fill()
  }

  /** While a slider moves only the code of the colour follows; the colour is put on when the finger lets go. */
  private fun moved() {
    sliders = placeOfSliders()
    colourOfSliders()?.let { code.text = it }
  }

  private fun released() {
    sliders = placeOfSliders()
    set(colourOfSliders() ?: return)
  }

  companion object {
    private const val STEPS = 1000
    private val hueSpan = Span(0.0, 359.9)
    private val saturationSpan = Span(0.0, 1.0)
    private val brightnessSpan = Span(0.12, 1.0)
    var custom = false
    var sliders: List<Double>? = null
  }
}
