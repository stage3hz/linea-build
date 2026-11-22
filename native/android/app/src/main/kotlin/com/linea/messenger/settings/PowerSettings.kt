package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.effects.Motion
import kotlin.math.abs
import kotlin.math.roundToInt

/** «Энергосбережение и анимации»: the power-saving slider (Выкл. … «При заряде менее N%» … Вкл.), then the heavy
 *  processes and «Анимации интерфейса». (The previous app: `MotionSettings` and `PowerRow` of
 *  `mobile/src/SettingsScreen.tsx`; iOS Settings/PowerSettings.swift; the rules: effects/Motion.kt.) Kept on this
 *  device only. */
class PowerSettingsScreen(context: Context) : SettingsPage(context, "Энергосбережение") {
  companion object {
    /** 0, 0.05 … 0.95, 1 (POWER_STEPS). */
    val steps: List<Double> = listOf(0.0) + (1..19).map { it / 20.0 } + listOf(1.0)

    fun index(level: Double): Int = steps.indexOfFirst { abs(it - level) < 0.026 }.coerceAtLeast(0)
  }

  private var slider: PowerSlider? = null
  private var stateLabel: TextView? = null
  private var valueLabel: TextView? = null
  private var footLabel: TextView? = null
  private var reasonLabel: TextView? = null
  private val motionChanged: (Unit) -> Unit = { refreshWords() }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); Motion.changed.watch(motionChanged) }
  override fun onDetachedFromWindow() { Motion.changed.unwatch(motionChanged); super.onDetachedFromWindow() }

  override fun build() {
    Motion.start(context)
    val state = context.words("", 12f, Theme.muted).also { stateLabel = it }
    val ends = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    ends.addView(context.words("Выкл.", 13f, Theme.muted))
    val value = context.words("", 15f, Theme.text, 600).also { it.gravity = Gravity.CENTER; valueLabel = it }
    ends.addView(value, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    ends.addView(context.words("Вкл.", 13f, Theme.muted))
    val track = PowerSlider(context, steps.size, index(Motion.threshold))
    track.onPick = { at ->
      val level = steps[at]
      if (abs(level - Motion.threshold) > 0.001) DevicePreferences.set(mapOf("lowBattery" to level))
      refreshWords()
    }
    slider = track
    val foot = context.words("", 12f, Theme.muted).also { footLabel = it }
    val top = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    for ((index, part) in listOf<View>(state, ends, track, foot).withIndex()) top.addView(part, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, if (part === track) context.px(34f) else LinearLayout.LayoutParams.WRAP_CONTENT).apply { if (index > 0) topMargin = context.px(10f) })

    val card = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; background = context.plate(SettingsLook.card, 12f, SettingsLook.line) }
    card.addView(SettingsLook.inset(top, top = 14f, side = 14f, bottom = 6f))
    val caption = context.words("РЕСУРСОЁМКИЕ ПРОЦЕССЫ", 11f, Theme.muted, 700).apply { letterSpacing = 0.1f }
    card.addView(SettingsLook.inset(caption, top = 14f, side = 14f))
    val items = listOf(
      listOf("autoplayVideo", "video", "Автозапуск видео", "Кружки и видео в чатах сами играют без звука, видео-аватары двигаются."),
      listOf("autoplayGif", "photo", "Автозапуск GIF", "GIF в чатах, на аватарах и баннерах проигрываются сами."),
      listOf("animatedStickers", "smile", "Анимированные стикеры", "Большие эмодзи в сообщениях двигаются."),
      listOf("animatedEmoji", "sparkles", "Анимированные эмодзи", "Эмодзи-статусы рядом с именем двигаются."),
    )
    for (item in items) {
      val key = item[0]
      val row = PowerRow(context, item[1], item[2], item[3], DevicePreferences.flag(key) ?: true)
      row.onChange = { on -> DevicePreferences.set(mapOf(key to on)) }
      card.addView(row)
    }
    val animations = PowerRow(context, "wand", "Анимации интерфейса", "Плавные переходы, рамки и эффекты профиля.", Motion.mode != "off")
    animations.onChange = { on -> DevicePreferences.set(mapOf("animations" to if (on) "auto" else "off")) }
    card.addView(animations)
    val reason = context.words("", 12f, Theme.muted).also { reasonLabel = it }
    card.addView(SettingsLook.inset(reason, top = 6f, side = 14f, bottom = 10f))
    add(card, 16f)
    refreshWords()
  }

  private fun refreshWords() {
    val level = steps[index(Motion.threshold)]
    val percent = Motion.percent(level)
    stateLabel?.text = "Режим энергосбережения (" + (if (Motion.saving) "вкл." else "выкл.") + ")"
    val label = if (level <= 0) "Выключен" else if (level >= 1) "Включён всегда" else "При заряде менее $percent%"
    valueLabel?.text = label
    slider?.let { if (android.os.Build.VERSION.SDK_INT >= 30) it.stateDescription = label else it.contentDescription = "Режим энергосбережения, $label" }
    footLabel?.text = when {
      level <= 0 -> "Не включается сам по заряду (только в системном режиме энергосбережения)."
      level >= 1 -> "Все ресурсоёмкие процессы выключены."
      else -> "Автоматически отключать все ресурсоёмкие процессы при заряде менее $percent%" + (Motion.power.level?.let { " (сейчас ${Motion.percent(it)}%)" } ?: "") + "."
    }
    reasonLabel?.text = Motion.reason
  }
}

/** The slider of steps: a thin track filled up to the chosen step and a white round knob; dragging and tapping choose
 *  the nearest step, TalkBack steps by one. */
@SuppressLint("ViewConstructor")
class PowerSlider(context: Context, count: Int, chosen: Int) : View(context) {
  var onPick: ((Int) -> Unit)? = null
  private val count = maxOf(2, count)
  var chosen = chosen
    private set
  private val d = resources.displayMetrics.density
  private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ThemeStore.look.border }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Theme.accent }
  private val knob = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); setShadowLayer(4 * resources.displayMetrics.density, 0f, resources.displayMetrics.density, 0x33000000) }

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "Режим энергосбережения"
    setLayerType(LAYER_TYPE_SOFTWARE, null)
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val mid = height / 2f
    canvas.drawRoundRect(0f, mid - 2 * d, w, mid + 2 * d, 2 * d, 2 * d, track)
    val share = chosen.toFloat() / (count - 1)
    canvas.drawRoundRect(0f, mid - 2 * d, share * w, mid + 2 * d, 2 * d, 2 * d, fill)
    val x = (share * w).coerceIn(14 * d, w - 14 * d)
    canvas.drawCircle(x, mid, 14 * d, knob)
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { parent?.requestDisallowInterceptTouchEvent(true); pick(event.x) }
      MotionEvent.ACTION_MOVE -> pick(event.x)
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> parent?.requestDisallowInterceptTouchEvent(false)
    }
    return true
  }

  private fun pick(x: Float) {
    val share = (x / maxOf(1, width)).coerceIn(0f, 1f)
    set((share * (count - 1)).roundToInt())
  }

  private fun set(index: Int) {
    val next = index.coerceIn(0, count - 1)
    if (next == chosen) return
    chosen = next
    invalidate()
    performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    onPick?.invoke(next)
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.SeekBar"

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)
    info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD)
  }

  override fun performAccessibilityAction(action: Int, arguments: android.os.Bundle?): Boolean {
    when (action) {
      AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> { set(chosen + 1); return true }
      AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> { set(chosen - 1); return true }
    }
    return super.performAccessibilityAction(action, arguments)
  }
}

/** A heavy process: its icon in a quiet circle, its name and what it does, a switch. */
@SuppressLint("ViewConstructor")
class PowerRow(context: Context, symbol: String, title: String, text: String, value: Boolean) : LinearLayout(context) {
  var onChange: ((Boolean) -> Unit)? = null
  private val toggle = Switch(context)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(14f), context.px(10f), context.px(14f), context.px(10f))
    val chip = FrameLayout(context).apply { background = context.plate(SettingsLook.chip, 17f) }
    chip.addView(SymbolView(context, symbol, 16f, Theme.text), FrameLayout.LayoutParams(context.px(20f), context.px(20f), Gravity.CENTER))
    addView(chip, LayoutParams(context.px(34f), context.px(34f)))
    val texts = LinearLayout(context).apply { orientation = VERTICAL }
    texts.addView(context.words(title, 15f, Theme.text))
    texts.addView(context.words(text, 12f, Theme.muted), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(2f) })
    addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(12f); rightMargin = context.px(12f) })
    SettingsLook.paint(toggle) // E: the reference's switch colours
    toggle.isChecked = value
    toggle.contentDescription = title
    toggle.setOnCheckedChangeListener { _, on -> onChange?.invoke(on) }
    addView(toggle)
  }
}

